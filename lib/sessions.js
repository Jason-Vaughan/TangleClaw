'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const tmux = require('./tmux');
const tunnel = require('./tunnel');
const git = require('./git');
const engines = require('./engines');
const gitHooks = require('./git-hooks');
const clawbridge = require('./clawbridge');
const wrapSentinel = require('./wrap-sentinel');
const wrapPipeline = require('./wrap-pipeline');
const wrapDefaultPipeline = require('./wrap-default-pipeline');
const wrapRunRegistry = require('./wrap-run-registry');
const wrapPrStatus = require('./wrap-pr-status');
const projectVersion = require('./project-version');
const continuity = require('./continuity');
const orchestration = require('./orchestration');
const medusa = require('./medusa');
const sessionOwnership = require('./session-ownership');
const { unsafeReason } = require('./ssh-target-safety');
const { countCuratedEntries, countTodoEntries } = require('./feature-index-prime');
const rulesChannel = require('./session-rules-channel');
const { createLogger } = require('./logger');

const log = createLogger('sessions');

/**
 * FALLBACK size ceiling for a generated prime prompt, in tokens (converted to a
 * rough character budget at use). Used only when the channel carrying the prime
 * declares no limit of its own.
 *
 * The runtime fallback now lives in `session-rules-channel.js` as
 * `FALLBACK_CHANNEL_CHARS`, because both the prime and the rules channel resolve
 * budgets through one implementation. This constant is the same number in token
 * form, kept because it is the historical unit and callers still reason in it —
 * two copies of one value, so a test pins their agreement rather than trusting
 * that nobody edits one alone.
 *
 * This was per-workflow config (2000 or 4000 depending on the project's
 * template); code-owning it takes the LARGER of the two deliberately, because
 * an under-sized budget costs a safety directive while an over-sized one costs
 * only some hidden context. Overflow no longer truncates — bulk sections yield
 * and anything still over is announced in the prime — so this number now bounds
 * how much context is carried, not what survives.
 */
const PRIME_MAX_TOKENS = 4000;

/**
 * Fraction of the channel budget the non-yielding sections may occupy before
 * TangleClaw warns. Set below 1 deliberately: a warning that fires only once
 * content is already being dropped arrives too late to act on. At this ratio
 * there is still room to absorb an added rule, and the operator learns that
 * their next edit is spending headroom rather than gaining it.
 */
const PRIME_CORE_ADVISORY_RATIO = 0.8;

// A wrapping row this old is treated as a stale orphan during launch (#105).
// The user has already invoked wrap, the AI never finished it, and tmux is alive
// but un-driven; rather than refuse the new launch, we kill the stale tmux and
// mark the row killed so the project becomes relaunchable from the UI alone.
const STALE_WRAPPING_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Parse a SQLite `datetime('now')` string as UTC. SQLite emits the format
 * `'YYYY-MM-DD HH:MM:SS'` without a timezone suffix; `new Date(...)` would
 * parse that as the runtime's local time, producing a TZ-offset error on any
 * non-UTC machine. Explicit ISO-8601 + `Z` keeps the comparison correct.
 * @param {string|null|undefined} s
 * @returns {number} - Epoch ms (NaN if input is empty/invalid)
 */
function _parseSqliteUtcMs(s) {
  if (!s) return NaN;
  if (s.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) {
    return Date.parse(s);
  }
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

// ── Session Launch ──

/**
 * Launch a new session for a project.
 * Generates prime prompt, starts tmux session, injects prime, records in SQLite.
 * @param {string} projectName - Project directory name
 * @param {object} [options]
 * @param {boolean} [options.primePrompt] - Generate and inject prime prompt (default true)
 * @param {string} [options.engineOverride] - Use different engine for this session only
 * @returns {{ session: object|null, primePrompt: string|null, ttydUrl: string, error: string|null }}
 */
function launchSession(projectName, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Project "${projectName}" not found` };
  }

  if (project.archived) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Project "${projectName}" is archived — unarchive it first` };
  }

  // Check for existing active session
  const existing = store.sessions.getActive(project.id);
  if (existing) {
    // If tmux is dead, clean up the stale session instead of blocking
    if (existing.tmuxSession && !tmux.hasSession(existing.tmuxSession)) {
      store.sessions.markCrashed(existing.id, 'tmux session died');
      clearIdleCache(existing.tmuxSession);
      log.warn('Cleaned up stale active session before launch', { project: projectName, session: existing.id });
    } else {
      return { session: null, primePrompt: null, ttydUrl: null, error: `Session already active for "${projectName}"` };
    }
  }

  // Check for stale wrapping session
  const wrapping = store.sessions.getWrapping(project.id);
  if (wrapping) {
    const tmuxAlive = wrapping.tmuxSession && tmux.hasSession(wrapping.tmuxSession);
    if (tmuxAlive) {
      // Wrapping rows older than the threshold are orphans — wrap was invoked
      // but never completed (e.g. server restart, tmux orphaned). Auto-recover
      // instead of bricking the project (#105). Falls back to startedAt for
      // legacy rows that pre-date the wrap_started_at column.
      const ageRef = wrapping.wrapStartedAt || wrapping.startedAt;
      const ageRefMs = _parseSqliteUtcMs(ageRef);
      // Fail-safe direction: an unparseable timestamp is treated as stale and
      // recovered rather than fresh-and-blocked, since blocking is the exact
      // bug class #105 was filed for.
      const ageMs = Number.isFinite(ageRefMs)
        ? Date.now() - ageRefMs
        : STALE_WRAPPING_THRESHOLD_MS + 1;
      if (ageMs > STALE_WRAPPING_THRESHOLD_MS) {
        log.warn('Recovering stale wrapping session before launch', {
          project: projectName,
          session: wrapping.id,
          ageSeconds: Math.floor(ageMs / 1000),
          basedOn: wrapping.wrapStartedAt ? 'wrap_started_at' : 'started_at'
        });
        try {
          tmux.killSession(wrapping.tmuxSession);
        } catch (err) {
          log.warn('Failed to kill stale tmux during recovery', { error: err.message });
        }
        store.sessions.kill(wrapping.id, 'auto-recovered stale wrapping row');
        // Forget the recovered session's Medusa listener + id (MED-2K9P Chunk 04).
        _teardownMedusa(project, wrapping);
        clearIdleCache(wrapping.tmuxSession);
        // Fall through to fresh launch
      } else {
        return { session: null, primePrompt: null, ttydUrl: null, error: `Session is currently wrapping for "${projectName}"` };
      }
    } else {
      // Dead wrapping session — auto-complete it
      autoCompleteWrap(project, wrapping);
      log.info('Cleaned up stale wrapping session before launch', { project: projectName, session: wrapping.id });
    }
  }

  // Resolve engine — openclaw:<connId> IDs resolve to the base "openclaw" profile
  const engineId = options.engineOverride || project.engineId;
  const baseEngineId = engineId.startsWith('openclaw:') ? 'openclaw' : engineId;
  const engineProfile = store.engines.get(baseEngineId);
  if (!engineProfile) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Engine "${engineId}" not found` };
  }

  // Check engine availability (for openclaw, SSH must be available).
  // `fresh`: this is a gate, not a display. Refusing a launch on a minute-old
  // probe would tell an operator who has just installed the engine that it is
  // not installed — and one probe on a button press costs nothing, unlike the
  // per-project poll the cache exists for.
  const det = engines.detectEngine(engineProfile, { fresh: true });
  if (!det.available) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Engine "${engineId}" not available (binary not found)` };
  }

  // Verify OpenClaw connection exists and check for webui mode
  if (engineId.startsWith('openclaw:')) {
    const connId = engineId.slice('openclaw:'.length);
    const conn = store.openclawConnections.get(connId);
    if (!conn) {
      return { session: null, primePrompt: null, ttydUrl: null, error: `OpenClaw connection "${connId}" not found` };
    }

    // Web UI mode — delegate to async launch path
    const mode = (options.mode === 'webui' || options.mode === 'ssh') ? options.mode : conn.defaultMode;
    if (mode === 'webui') {
      return { session: null, primePrompt: null, ttydUrl: null, error: null, webui: true, _conn: conn, _engineId: engineId, _engineProfile: engineProfile, _project: project };
    }
  }

  // Record project version (#101) — TangleClaw is now the writer of
  // `.tangleclaw/project-version.txt`; this used to be delegated to the AI
  // via prime-prompt instructions. Failure is non-blocking.
  projectVersion.recordVersion(project.path);

  // Load project config early — needed to decide silent-prime delivery (#103)
  // before we generate the prime, so we can write the prime to disk for the
  // SessionStart hook to read instead of pasting into the terminal.
  const projConfig = store.projectConfig.load(project.path);
  const silentPrime = projConfig.silentPrime === true
    && engineProfile.capabilities
    && engineProfile.capabilities.supportsSilentPrime === true;

  // Launch-mode posture: an explicit caller choice always wins; otherwise the
  // project's configured default applies. Resolving here (server-side) makes
  // the setting real for every tmux-path caller — the landing page's
  // hidden-picker direct launch, ClawBridge, and raw API POSTs alike. (OpenClaw
  // web-UI launches return through the `webui: true` branch above and keep
  // their existing explicit-mode-only bridge contract — openclaw is
  // picker-hidden anyway, #459.) 'default' adds no CLI args downstream, so
  // leaving launchMode unset for it preserves the pre-setting launch command
  // byte-for-byte. The usability guard keeps a stale key (e.g. after an engine
  // switch) or a disabled mode from reaching _buildLaunchCommand — degraded
  // but functional, so it WARNs rather than failing the launch.
  if (!options.launchMode
      && typeof projConfig.defaultLaunchMode === 'string'
      && projConfig.defaultLaunchMode !== 'default') {
    if (engines.honorsLaunchMode(engineProfile, projConfig.defaultLaunchMode)) {
      options = { ...options, launchMode: projConfig.defaultLaunchMode };
    } else {
      log.warn('Configured defaultLaunchMode is not usable for this engine — launching with the engine default', {
        project: projectName,
        engine: baseEngineId,
        mode: projConfig.defaultLaunchMode,
        reason: (engineProfile.launchModes
          && Object.prototype.hasOwnProperty.call(engineProfile.launchModes, projConfig.defaultLaunchMode))
          ? 'mode is disabled'
          : 'engine does not define this mode'
      });
    }
  }

  // MED-2K9P v2 T1 — pre-mint the Medusa workspace id for opted-in projects.
  // The prime prompt is generated BEFORE the session record exists, but the
  // listener registers per-session; minting here (unpersisted) lets the prime
  // carry the exact identity `_maybeAutoStartMedusa` later registers under.
  const medusaWorkspaceId = projConfig.medusaEnabled === true
    ? medusa.mintWorkspaceId(projectName)
    : null;

  // TB-1 (#357) — resolve the project's orchestration profile and overlay the
  // resolved (base_url, key, model) onto the engine profile FOR THIS LAUNCH
  // ONLY. `launchProfile` is a clone when bound; otherwise it's the unmodified
  // engine profile (zero injection = byte-identical to pre-TB-1). Only the two
  // launch consumers below read `launchProfile`; everything else (config write,
  // hooks, deferred prime) keeps using the base `engineProfile`.
  // TB-2 (#189) — surface the master-key footgun. Scan the STATIC engine config
  // (pre-overlay) for a hardcoded LiteLLM-shaped key literal; the sanctioned path
  // is a profile keyRef resolved into the overlay below, which is never flagged.
  // Warn-only (redacted, non-blocking) — the operator owns their engine configs.
  for (const f of orchestration.detectHardcodedKeys(engineProfile)) {
    log.warn('Hardcoded key in engine config launch.env — use an orchestration-profile keyRef instead (TB-2 #189)', {
      engine: baseEngineId, project: projectName, envVar: f.envVar, value: f.redacted, reason: f.reason
    });
  }

  let launchProfile = engineProfile;
  const resolvedProfile = orchestration.resolveLaunchProfile(
    project, projConfig, store.orchestrationProfiles.load()
  );
  if (resolvedProfile && resolvedProfile.refused) {
    log.warn('Orchestration profile bound but not injectable — launching without injection', {
      project: projectName, profile: resolvedProfile.profileName, reason: resolvedProfile.reason
    });
  } else if (resolvedProfile) {
    launchProfile = orchestration.applyLaunchOverlay(engineProfile, resolvedProfile);
    log.info('Orchestration profile injected at launch (TB-1)', {
      project: projectName, profile: resolvedProfile.profileName, baseUrl: resolvedProfile.baseUrl, model: resolvedProfile.model
    });
  }

  // Generate prime prompt. The startup rules block is built once, here, so the
  // exact block that ships is the one recorded in the delivery ledger below
  // (#595) — regenerating it for the ledger would risk describing a different
  // rule set than the session actually received.
  let primeText = null;
  const startupRules = buildStartupRulesSection(project.id);
  if (options.primePrompt !== false) {
    primeText = generatePrimePrompt(project, engineProfile, { medusaWorkspaceId, startupRules });
  }

  // Silent prime delivery (#103): write the prime to .tangleclaw/session-prime.md
  // so the Claude Code SessionStart hook can cat it as hidden context. The
  // tmux send-keys path is skipped in _deferEngineInit when silentPrime is on.
  // When silentPrime is OFF, remove any leftover prime file so the hook (still
  // installed alongside other hooks via syncEngineHooks) doesn't read stale
  // context from a previous silent session — chunk 3 cleanup.
  let primeFilePath = null;
  if (silentPrime && primeText) {
    primeFilePath = _writePrimeFile(project.path, primeText);
  } else {
    _removePrimeFile(project.path);
  }

  // Startup rules ride their own channel (#749): one shard payload per hook
  // entry, written here and read at session start. Pruned rather than left
  // behind when silent prime is off or the rule set shrank — a stale shard is a
  // live hook delivering rules the operator has since changed, with nothing in
  // the session to indicate the text is old.
  let ruleShards = [];
  let ruleShardError = null;
  try {
    // Gated on `primeText` as well as silentPrime. `primePrompt: false` means
    // "this launch gets no startup injection" — it predates the rules channel,
    // when disabling the prime disabled the rules with it. Honouring only half
    // of it now would deliver rules to a caller who asked for a bare session,
    // and the ledger (which reports the whole launch) would call it skipped.
    // [DECISION: primePrompt:false suppresses rules too | preserves the
    // semantics every existing caller was written against; the alternative —
    // rules survive because they are a separate concern — is defensible but
    // silently changes what an API flag does | operator can override]
    if (primeText && silentPrime && startupRules.rules && startupRules.rules.length > 0) {
      ruleShards = rulesChannel.buildShards(
        startupRules.rules,
        rulesChannel.resolveChannelBudget(engineProfile)
      );
      const written = rulesChannel.writeShards(project.path, ruleShards, startupRules.rules.length);
      log.info('Startup rules written to their own channel', {
        project: projectName,
        rules: startupRules.rules.length,
        shards: written.written,
        prunedStale: written.pruned
      });
    } else {
      rulesChannel.pruneShards(project.path, 0);
    }
  } catch (err) {
    // Never block a launch on rule delivery; the ledger records the miss below.
    // prawduct:allow prawduct/broad-except -- session launch must survive any failure to write rule payloads
    log.warn('Failed to write startup rule shards', { project: projectName, error: err.message });
    ruleShards = [];
    ruleShardError = err.message;
  }

  // Sync shared docs from group shared directories before config generation
  try {
    const groups = store.projectGroups.getByProject(project.id);
    for (const group of groups) {
      if (group.sharedDir) {
        store.sharedDocs.syncFromDirectory(group.id, group.sharedDir);
      }
    }
  } catch (err) {
    log.warn('Failed to sync shared docs from group directories', { error: err.message });
  }

  // Regenerate engine config BEFORE launching (ensures the engine reads
  // current project rules). #240 drift-aware write — the helper warns
  // when the on-disk file differs from regenerated content, surfacing
  // silent-clobber bugs. The helper itself handles "engine has no
  // config file" (openclaw) via `skipped: true`, so no
  // outer guard is needed; we only surface real `error` strings.
  const writeResult = engines.writeEngineConfig(engineId, project.path, projConfig, engineProfile);
  if (writeResult.error && !writeResult.written && !writeResult.skipped) {
    log.warn('Failed to write engine config', { error: writeResult.error });
  }

  // Sync engine hooks before launch so they are current
  try {
    engines.syncEngineHooks(project.path);
  } catch (err) {
    log.warn('Failed to sync engine hooks during session launch', { error: err.message });
  }

  // #247 — re-sync git hooks at session launch too. Session launch is the
  // operator's most frequent "I'm about to use TC" gate, and is therefore
  // the right drift-repair point if the operator manually deleted or
  // edited the commit-msg hook between sessions. Symmetric with the
  // engine-hooks sync above (`feedback_symmetric_capability_gates`).
  try {
    gitHooks.syncGitHooks(project.path, store.config.load());
  } catch (err) {
    log.warn('Failed to sync git hooks during session launch', { error: err.message });
  }

  // Start tmux session (sanitize name for tmux — spaces not allowed)
  const tmuxName = tmux.toSessionName(projectName);
  const launchCmd = _buildLaunchCommand(launchProfile, project, options.launchMode);

  // If an orphaned tmux session exists (no DB record but tmux session present),
  // kill it and create a fresh one with the correct cwd and launch command.
  // Adopting in-place would skip cwd, prime prompt, config generation, and hooks.
  if (tmux.hasSession(tmuxName)) {
    log.info('Killing orphaned tmux session before fresh launch', { name: tmuxName });
    tmux.killSession(tmuxName);
  }

  try {
    const created = tmux.createSession(tmuxName, {
      cwd: project.path,
      command: launchCmd,
      env: launchProfile.launch ? launchProfile.launch.env : {}
    });

    if (!created) {
      return { session: null, primePrompt: null, ttydUrl: null, error: `Failed to create tmux session "${tmuxName}"` };
    }
  } catch (err) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `tmux error: ${err.message}` };
  }

  // Record the mode the engine will ACTUALLY run, not the one that was asked
  // for. `_buildLaunchCommand` drops a mode the engine cannot honor and falls
  // back to engine defaults; persisting the requested key here made the session
  // row — and every API and UI consumer reading it — assert a posture the
  // process was never launched with. An operator who picked Bypass on an engine
  // without one saw "Bypass" in the UI over an interactive agent, with only a
  // server log saying otherwise.
  // Judged against `launchProfile` — the same object `_buildLaunchCommand` read
  // to produce the argv above. They are the same object unless an orchestration
  // overlay is bound, and reading the mode from one while the args came from the
  // other is how "the recorded mode" and "the launched mode" drift apart again.
  const requestedMode = options.launchMode || launchProfile.defaultLaunchMode || null;
  const effectiveMode = requestedMode && !engines.honorsLaunchMode(launchProfile, requestedMode)
    ? (engines.honorsLaunchMode(launchProfile, 'default') ? 'default' : null)
    : requestedMode;

  const session = store.sessions.start({
    projectId: project.id,
    engineId,
    tmuxSession: tmuxName,
    primePrompt: primeText,
    launchMode: effectiveMode,
    owner: options.owner || null  // AUTH-3: proxy-authenticated user (null in direct mode)
  });

  log.info('Session launched', { project: projectName, engine: engineId, session: session.id, launchMode: effectiveMode });

  // Startup-rule delivery ledger (#595). The silent-prime and no-channel cases
  // are settled by now and recorded here; the tmux-paste case is recorded later
  // by _deferEngineInit, when the paste actually happens.
  const supportsPaste = Boolean(engineProfile.capabilities && engineProfile.capabilities.supportsPrimePrompt);
  const deliveryBase = {
    sessionId: session.id,
    projectId: project.id,
    engineId,
    kind: 'startup',
    ruleIds: startupRules.ruleIds,
    digest: startupRules.digest
  };
  const hasRules = startupRules.ruleIds.length > 0;
  if (!hasRules) {
    // Recorded rather than omitted: the row proves the launch path ran and had
    // nothing to send, which is what distinguishes an empty project from one
    // whose delivery never happened at all.
    _recordRuleDelivery({ ...deliveryBase, channel: 'none', outcome: 'no-rules' });
  } else if (!primeText) {
    _recordRuleDelivery({ ...deliveryBase, channel: 'none', outcome: 'skipped', skipReason: 'prime prompt disabled for this launch' });
  } else if (silentPrime) {
    // Rules ride their own hook now (#749), so the ledger must answer for THAT
    // channel. Keying the row on `primeFilePath` would report delivery of a
    // file that carries only a manifest — a row saying `delivered` while the
    // rules went nowhere, which is the exact failure this ledger exists to
    // detect and the one Direction 4 forbids.
    if (ruleShardError) {
      _recordRuleDelivery({
        ...deliveryBase, channel: 'rules-hook', outcome: 'skipped',
        skipReason: `failed to write rule shards: ${ruleShardError}`
      });
    } else if (ruleShards.length > 0) {
      _recordRuleDelivery({ ...deliveryBase, channel: 'rules-hook', outcome: 'delivered' });
    } else {
      _recordRuleDelivery({
        ...deliveryBase, channel: 'rules-hook', outcome: 'skipped',
        skipReason: 'no rule shards were written for a project that has active rules'
      });
    }
  } else if (!supportsPaste) {
    _recordRuleDelivery({ ...deliveryBase, channel: 'none', outcome: 'skipped', skipReason: `engine ${engineId} declares no prime channel (supportsPrimePrompt is false)` });
  }

  // MED-2K9P Chunk 02 — auto-start the Medusa listener when the project opted
  // in (T1: under the pre-minted id the prime already carries).
  _maybeAutoStartMedusa(project, session, medusaWorkspaceId);

  // Defer preKeys and prime prompt injection to a background timer so the API
  // returns instantly and the frontend can navigate to the session page while
  // the engine boots. The user sees the terminal immediately instead of staring
  // at a frozen launch button for ~6s.
  // The effective mode, not the requested one — preKeys are resolved from it,
  // and an unhonored mode must not select a mode-level preKey set.
  _deferEngineInit(tmuxName, projectName, engineId, engineProfile, primeText, effectiveMode, silentPrime, deliveryBase);

  return {
    session,
    primePrompt: primeText,
    ttydUrl: '/terminal/',
    error: null
  };
}

/**
 * Launch a Web UI session for an OpenClaw connection.
 * Skips tmux — ensures SSH tunnel, health checks, and returns an iframe URL.
 * @param {string} projectName - Project directory name
 * @param {object} conn - OpenClaw connection record
 * @param {string} engineId - Full engine ID (openclaw:<connId>)
 * @param {object} engineProfile - Base openclaw engine profile
 * @param {object} project - Project record from store
 * @returns {Promise<{ session: object|null, primePrompt: string|null, iframeUrl: string|null, ttydUrl: string|null, error: string|null }>}
 */
async function launchWebuiSession(projectName, conn, engineId, engineProfile, project, options = {}) {
  // Detect stale tunnel on the port and auto-kill if force is set
  const existing = await tunnel.detectTunnel(conn.localPort, conn.host);
  const forceCleanup = options.force || false;

  // Ensure SSH tunnel is up (force kills stale tunnel first if needed)
  const extraForwards = conn.bridgePort ? [{ localPort: conn.bridgePort, remotePort: conn.bridgePort }] : [];
  const tunnelResult = await tunnel.ensureTunnel(projectName, {
    host: conn.host,
    port: conn.port,
    localPort: conn.localPort,
    sshUser: conn.sshUser,
    sshKeyPath: conn.sshKeyPath,
    force: forceCleanup && existing.active,
    extraForwards
  });

  if (!tunnelResult.ok) {
    // If tunnel failed and there's a stale process, provide actionable error
    if (existing.active && !forceCleanup) {
      const pidInfo = existing.pid ? ` (PID ${existing.pid})` : '';
      return { session: null, primePrompt: null, iframeUrl: null, ttydUrl: null,
        error: `Port ${conn.localPort} blocked by existing SSH tunnel${pidInfo}. Kill it from the OpenClaw connection panel or retry with force.`,
        staleTunnel: { pid: existing.pid, port: conn.localPort }
      };
    }
    return { session: null, primePrompt: null, iframeUrl: null, ttydUrl: null, error: `Tunnel failed: ${tunnelResult.error}` };
  }

  // Health check
  const health = await tunnel.checkHealth({ localPort: conn.localPort });
  if (!health.healthy) {
    log.warn('OpenClaw health check failed after tunnel', { project: projectName, error: health.error });
    // Non-fatal — instance may still be starting up. Session is created regardless.
  }

  // #210 Phase 2 — when the operator picked a launch mode AND this
  // connection has a ClawBridge sidecar (bridgePort set), pre-create the
  // bridge session with the chosen permissionMode BEFORE the iframe
  // loads. The chat UI inside the iframe will then attach to the existing
  // session via `attachIfExists: true` (ClawBridge v1.7.0) — either by
  // the bridge's idempotent attach or by the chat UI's own GET /v2/session/peek,
  // depending on the chat UI's attach-on-load behaviour. Failure is
  // non-fatal: a failed pre-create just means the chat UI falls back to
  // its own session/start with no permissionMode set, restoring the
  // pre-#210 behaviour.
  let bridgePreCreate = null;
  if (options.launchMode && conn.bridgePort && engines.honorsLaunchMode(engineProfile, options.launchMode)) {
    const modeConfig = engineProfile.launchModes[options.launchMode];
    const bridgeMode = modeConfig && modeConfig.bridgePermissionMode;
    if (bridgeMode) {
      const result = await clawbridge.startSession({
        localPort: conn.bridgePort,
        token: conn.bridgeToken,
        project: projectName,
        permissionMode: bridgeMode
      });
      if (!result.ok) {
        log.warn('ClawBridge pre-create failed; falling back to chat-UI-driven session/start (mode will not propagate)', {
          project: projectName, permissionMode: bridgeMode, status: result.status, error: result.error
        });
      } else {
        log.info('ClawBridge pre-create OK', {
          project: projectName, permissionMode: bridgeMode,
          sessionId: result.sessionId, attached: result.attached
        });
      }
      bridgePreCreate = result;
    }
  }

  // Build iframe URL: /openclaw/<project>/chat?session=main
  const tokenParam = conn.gatewayToken ? `#token=${encodeURIComponent(conn.gatewayToken)}` : '';
  const iframeUrl = `/openclaw/${encodeURIComponent(projectName)}/chat?session=main${tokenParam}`;

  // Record the mode that actually took, not the one that was asked for.
  //
  // On this path the mode is carried entirely by ClawBridge's permissionMode:
  // it reaches the agent only via a successful pre-create. Without a bridge
  // port, without a `bridgePermissionMode` mapping, or on a failed pre-create,
  // the chat UI starts its own session with no mode set — the code immediately
  // above says so ("mode will not propagate") and the row used to record the
  // requested mode regardless, leaving the API and UI asserting a posture
  // nothing was launched with.
  const webuiEffectiveMode = (bridgePreCreate && bridgePreCreate.ok)
    ? options.launchMode
    : null;

  const session = store.sessions.start({
    projectId: project.id,
    engineId,
    tmuxSession: null,
    primePrompt: null,
    sessionMode: 'webui',
    launchMode: webuiEffectiveMode,
    owner: options.owner || null  // AUTH-3: proxy-authenticated user (null in direct mode)
  });

  log.info('Web UI session launched', {
    project: projectName, engine: engineId, session: session.id, localPort: conn.localPort,
    launchMode: webuiEffectiveMode,
    requestedLaunchMode: options.launchMode || null,
    bridgePreCreate: bridgePreCreate ? { ok: bridgePreCreate.ok, attached: bridgePreCreate.attached } : null
  });

  // Startup-rule delivery ledger (#595). The web UI has no prime channel at
  // all — no tmux to paste into and no SessionStart hook to read a prime file —
  // so rules genuinely do not reach it. That is recorded rather than left
  // silent: an unrecorded gap here would reproduce, in a second launch path,
  // exactly the invisible severance the ledger exists to expose.
  {
    const webuiRules = buildStartupRulesSection(project.id);
    _recordRuleDelivery({
      sessionId: session.id,
      projectId: project.id,
      engineId,
      kind: 'startup',
      channel: 'none',
      ruleIds: webuiRules.ruleIds,
      digest: webuiRules.digest,
      ...(webuiRules.ruleIds.length === 0
        ? { outcome: 'no-rules' }
        : { outcome: 'skipped', skipReason: 'web UI session has no prime channel (no tmux paste target, no SessionStart hook)' })
    });
  }

  // MED-2K9P Chunk 02 — auto-start the Medusa listener when the project opted in.
  _maybeAutoStartMedusa(project, session);

  return {
    session,
    primePrompt: null,
    iframeUrl,
    ttydUrl: null,
    error: null
  };
}

// ── Prime Prompt Generation ──

/**
 * Build the startup session-rules section of the prime, together with the
 * metadata the delivery ledger records (#595).
 *
 * Startup rules are assembled here, at prompt time, rather than during engine
 * config-file generation. Config generation cannot deliver them at all on a
 * project governed by the Prawduct plugin: the plugin owns CLAUDE.md, so
 * `engines.writeEngineConfig` returns before reaching the injection point, which
 * left this rule tier with zero working instances across every governed project.
 * Prompt-time assembly sidesteps file ownership entirely and runs for every
 * engine, making delivery engine-agnostic by construction. It also matches how
 * the sibling `wrap` tier already works — plain string concatenation into the
 * prompt at send time, with no file, hook, or engine capability in the path.
 *
 * The digest is a sha256 over the rule CONTENT, giving a rule *set* a stable
 * version identity that per-rule version numbers cannot express — and one that
 * survives a change to the wording that surrounds the rules.
 *
 * @param {number|null} projectId - Project whose startup rules to render
 * @returns {{lines: string[], ruleIds: number[], digest: string}} Empty lines and
 *   an empty digest when the project has no active startup rules
 */
function buildStartupRulesSection(projectId) {
  const empty = { lines: [], manifestLines: [], inlineLines: [], rules: [], ruleIds: [], digest: '' };
  let rules;
  try {
    rules = store.sessionRules.listActiveForProject(projectId ?? null);
  } catch (err) {
    // Never let a rules-query failure block a session launch — the operator
    // loses their rules, but the ledger records the miss (see recordDelivery).
    log.warn('Failed to load startup session rules for prime', { projectId, error: err.message });
    return empty;
  }
  const usable = rules.filter((r) => r.content && r.content.trim());
  if (usable.length === 0) return empty;

  // The prime carries a MANIFEST, not the rules. The bodies ride their own
  // startup channel (`lib/session-rules-channel.js`) so the two cannot displace
  // each other: they shared one hook's output until #749, and because the
  // engine enforces its cap by replacing the payload rather than shortening it,
  // a large prime took the rules down with it — silently, and with the delivery
  // ledger correctly reporting success.
  //
  // The manifest is fixed-size on purpose. It states that rules exist and where
  // they arrive from, so their absence is detectable from inside the session;
  // it does not grow with the corpus, so the 52nd rule costs the prime nothing.
  // Headed differently from the block it describes. Naming this section
  // "## Project Rules" while telling the agent to report a missing
  // "## Project Rules" block would let the manifest satisfy its own absence
  // check — the reader would find the heading, conclude the rules arrived, and
  // the undetectable-loss failure would survive the fix meant to end it.
  const manifestLines = ['## Rules delivery', ''];
  manifestLines.push(
    `${usable.length} operator-authored rule${usable.length === 1 ? '' : 's'} `
    + `govern${usable.length === 1 ? 's' : ''} this session. They are binding, and they arrive on a `
    + 'separate channel — look for a heading reading exactly **"Project Rules"** in your context. '
    + '**If no such block is present, say so before you act on anything else**: it means delivery '
    + 'failed and you are working without rules the operator believes are in force.'
  );
  manifestLines.push('');

  // The floor (Direction layer 3): an engine with no second startup channel
  // gets the rules INLINE, exactly as before. A manifest pointing at a channel
  // that engine does not have would deliver nothing at all — which is the
  // failure this work exists to end, reintroduced one engine over.
  const inlineLines = ['## Project Rules', ''];
  inlineLines.push('Operator-authored rules for this project. They apply for the whole session:');
  for (const rule of usable) inlineLines.push(`- ${rule.content.trim()}`);
  inlineLines.push('');

  return {
    lines: manifestLines,
    manifestLines,
    inlineLines,
    rules: usable,
    ruleIds: usable.map((r) => r.id),
    // Digest over the rule CONTENT, not the rendered block: it identifies the
    // rule set itself, so it stays stable when the manifest wording changes and
    // changes when any rule does — which is what a set version has to mean.
    digest: crypto.createHash('sha256')
      .update(usable.map((r) => `${r.id}:${r.content.trim()}`).join('\n'))
      .digest('hex')
  };
}

/**
 * Record one startup-rule delivery attempt in the ledger (#595).
 *
 * Called from the code path that actually performs the delivery, never from the
 * point that merely intends it: the tmux-paste channel fires on a background
 * timer well after launch returns, so recording success at launch time would
 * assert something not yet true — precisely the "assumed, not verified" failure
 * that made this tier stay broken across 13 projects unnoticed.
 *
 * Non-throwing by design. An audit write must never be the reason a session
 * fails to launch; a failure here is logged and the session proceeds.
 *
 * @param {object} entry - Passed through to `store.sessionRuleDeliveries.record`
 * @returns {void}
 */
function _recordRuleDelivery(entry) {
  try {
    store.sessionRuleDeliveries.record(entry);
  } catch (err) {
    log.warn('Failed to record session-rule delivery', {
      sessionId: entry.sessionId, channel: entry.channel, error: err.message
    });
  }
}

/**
 * Resolve the character budget for a session's startup injection channel.
 *
 * The limit belongs to the CONSUMER, not to TangleClaw: each engine declares
 * what its startup channel can carry via
 * `capabilities.startupInjection.maxChars`. Hard-coding one engine's number
 * here would silently impose it on every other engine, which the
 * engine-agnostic rule forbids.
 *
 * The declared value is an UPSTREAM fact about that engine's harness, not a
 * TangleClaw preference, so it drifts when the harness changes. Claude Code's
 * 10,000-character hook-output cap was verified against its hooks reference on
 * 2026-07-28. If directives start disappearing from delivered primes again,
 * re-verify that number at the source before tuning anything here — a test
 * comparing this repo against this repo cannot detect that kind of drift.
 *
 * The declaration describes the STARTUP-HOOK channel specifically. A prime
 * delivered by terminal paste never passes through that hook, so it must not
 * inherit the hook's limit — applying it there would make bulk context yield to
 * a ceiling its channel does not have. Callers that deliver by paste pass
 * `viaStartupHook: false` and get the historical budget instead.
 *
 * @param {object|null} engineProfile - Engine profile; may be null or partial.
 * @param {object} [options]
 * @param {boolean} [options.viaStartupHook=true] - Whether this prime will be
 *   carried by the engine's startup hook (the channel the declaration is about).
 * @returns {number} Positive character budget. Falls back to the historical
 *   `PRIME_MAX_TOKENS * 4` when the engine declares nothing, so adding the
 *   declaration to one engine never changes another engine's behavior.
 */
function _resolvePrimeBudget(engineProfile, options = {}) {
  return rulesChannel.resolveChannelBudget(engineProfile, options);
}

/**
 * Mark a prime section as able to yield its body to the size budget.
 *
 * Yieldable sections are bulk context — useful, but not directives. When the
 * prime exceeds its channel's budget they are replaced by `pointer`, lowest
 * `priority` first, so the directives that govern the session's behavior never
 * compete with material the agent can look up.
 *
 * @param {number} priority - Lower yields earlier.
 * @param {string[]} lines - The full section, rendered when it fits.
 * @param {string} pointer - Replacement naming what was dropped. Never empty:
 *   a section that vanishes without a trace is the failure this whole
 *   mechanism exists to prevent.
 * @returns {object} Section marker consumed by `_renderPrimeSections`.
 */
function _yieldable(priority, lines, pointer) {
  return { __primeYieldable: true, priority, lines, pointer };
}

/**
 * Render prime sections to text, replacing yielded sections with their pointer.
 * @param {Array<string|object>} sections - Plain strings, or `_yieldable` markers.
 * @param {Set<object>} yielded - Markers whose body must be replaced.
 * @returns {string}
 */
function _renderPrimeSections(sections, yielded) {
  return sections
    .map((s) => {
      if (s && s.__primeYieldable === true) {
        return yielded.has(s) ? s.pointer : s.lines.join('\n');
      }
      return s;
    })
    .join('\n');
}

/**
 * Generate a prime prompt from project state + learnings + last session.
 * @param {object} project - Project record from store
 * @param {object} engineProfile - Engine profile
 * @param {object} [options]
 * @param {string|null} [options.medusaWorkspaceId] - Pre-minted Medusa workspace
 *   id from the launch path (MED-2K9P v2 T1). When present (and the project has
 *   `medusaEnabled`), the prime carries the switchboard participation section —
 *   consumer contract + this identity + the participant role.
 * @param {object} [options.startupRules] - Pre-built section from
 *   `buildStartupRulesSection`. The launch path builds it once so the block it
 *   ships and the block it records in the delivery ledger are the same object,
 *   rather than two queries that could straddle a concurrent rule edit. Omitted
 *   by other callers, which build it here.
 * @returns {string}
 */
function generatePrimePrompt(project, engineProfile, options = {}) {
  // Note (#102): the prime carries **session-dynamic state** — things the AI
  // cannot derive from CLAUDE.md or the engine's own banner. Extension-rule
  // definitions and shared-doc pointers are intentionally omitted — both are
  // already injected
  // into the engine's config file (CLAUDE.md / GEMINI.md / .codex.yaml /
  // .aider.conf.yml) by `lib/engines.js`, so duplicating them here was pure
  // scrollback noise. Project-version recording is also owned by TangleClaw
  // (#101).
  //
  // Per-project session rules are the deliberate exception (#595): they moved
  // OUT of the config file and into this prime, because config generation is
  // skipped wholesale on plugin-governed projects and so delivered them
  // nowhere. Static-vs-dynamic is the wrong axis for that tier; reachability is.
  const projConfig = store.projectConfig.load(project.path);
  const sections = [];

  // Header — kept for branding + project anchor
  sections.push(`# Session Start — ${project.name}`);
  sections.push("*TangleClaw'd into existence.*");
  sections.push('');

  // Banner-visibility contract (CC-1, #342). This prime is HIDDEN model context
  // (SessionStart hook stdout → context, never shown to the operator). Confirmed
  // against Claude Code's hooks docs: no hook can render into the startup header
  // or emit guaranteed-visible terminal output, so the ONLY way the branding
  // line reaches the screen is the model re-printing it on its first turn.
  // Make that unconditional and engine-agnostic: the instruction lives here, in
  // the header block every prime carries, so it fires for EVERY session and
  // EVERY model — not only when a continuity index steers us into the Resume
  // branch below. Before this hoist the re-emit instruction lived solely inside
  // that Resume branch, so any session after a mechanical-only wrap (the
  // legacy-summary `else` path) silently dropped the banner 100% of the time.
  // Deliberately split from any wait-for-confirmation directive: this is a
  // visible-OUTPUT requirement only — it does not authorize starting work.
  sections.push(
    "Before anything else, begin your FIRST visible reply to the operator with "
    + "the banner line `*TangleClaw'd into existence.*` on its own line. This is "
    + 'unconditional: do it every session, whatever the model is driving this '
    + 'project, even when the operator opens with a direct task. It is a '
    + 'visible-output requirement only and does NOT authorize starting work — '
    + 'honor any wait-for-confirmation directive below before acting.'
  );
  sections.push('');

  // Session ownership identity (#347 Slice 3). Inject the owned-project
  // identity early so a consumer (#340 scope guard) reads a reliable "what do
  // I own" fact from hidden prime context. Identity only — the wrong-tab
  // flagging behavior is #340's, not this primitive's.
  sections.push(...sessionOwnership.primeSection(project));

  // Scope guard (#340). The behavior on top of the identity block: flag a
  // request that clearly belongs to a different project before acting —
  // surface, never refuse. Lists other projects with a live session (launch-
  // time snapshot, from listLive) so the flag can name the likely tab.
  sections.push(...sessionOwnership.scopeGuardSection(project));

  // Operator-authored startup rules (#595). Placed high — ahead of the optional
  // switchboard/learnings/resume blocks — because these are standing directives
  // that govern how the whole session behaves, not state to react to. They used
  // to be written into the engine's config file, a path that silently delivered
  // nothing on any plugin-governed project; see buildStartupRulesSection.
  // Which channel will carry this session's payloads? Silent prime rides the
  // engine's startup hook, so rules get their own hook beside it and the prime
  // carries only a manifest. Everything else is pasted into the terminal, where
  // there is no second hook to ride — so the rules go inline, as they always
  // did. Deciding this once, here, is what keeps a manifest from ever pointing
  // at a channel the engine does not have.
  const viaStartupHook = projConfig.silentPrime === true
    && Boolean(engineProfile
      && engineProfile.capabilities
      && engineProfile.capabilities.supportsSilentPrime === true);

  const startupRules = options.startupRules || buildStartupRulesSection(project.id);
  // Fall back to `lines` for a caller-supplied section that predates the
  // manifest/inline split — the block a caller hands in must ship verbatim, or
  // the ledger records a rule set the session never saw.
  const rulesLines = viaStartupHook
    ? (startupRules.manifestLines || startupRules.lines || [])
    : (startupRules.inlineLines || startupRules.lines || []);
  sections.push(...rulesLines);

  // Medusa switchboard participation (MED-2K9P v2 T1). Session-dynamic by
  // nature (the workspace id is minted per launch and forgotten at teardown),
  // so it belongs in the prime, not the engine config — and the config route
  // couldn't reach TC's own plugin-governed CLAUDE.md anyway, which would
  // silently exclude the primary dogfood session. Only the launch path passes
  // `medusaWorkspaceId`, so re-generation from other callers never fabricates
  // an identity no listener registered. Identity + role only — the bulk
  // consumer contract is appended after the budget math at the bottom (#557).
  const medusaActive = projConfig.medusaEnabled === true && Boolean(options.medusaWorkspaceId);
  if (medusaActive) {
    sections.push(..._medusaPrimeSection(project, options.medusaWorkspaceId));
  }

  // Active learnings — project state, not in CLAUDE.md. Yieldable: the set
  // grows with the project, and a learning the agent can look up is worth less
  // than a directive it cannot.
  try {
    const learnings = store.learnings.getActive(project.id);
    if (learnings.length > 0) {
      const lines = ['## Active Learnings'];
      for (const learning of learnings) {
        lines.push(`- ${learning.content}`);
      }
      lines.push('');
      sections.push(_yieldable(2, lines,
        '## Active Learnings\n'
        + `_(${learnings.length} active learning${learnings.length === 1 ? '' : 's'} omitted here to fit `
        + "the prime size budget — they remain available through the project's learnings surface.)_\n"));
    }
  // prawduct:allow prawduct/broad-except -- session launch must survive any failure to read optional project state
  } catch (err) {
    log.warn('Active learnings unavailable for the prime — section omitted', {
      project: project.name, error: err.message
    });
  }

  // Session continuity — the READ half of the Continuity Contract (CC-1).
  // When the previous wrap wrote a continuity index (`lib/continuity.js`),
  // upgrade the prime from a *passive* "here's the summary" blob into an
  // *actionable* resume directive: this prime is HIDDEN model context
  // (delivered via `sessionstart-prime.sh` → silent SessionStart hook), so
  // the operator never sees it. The AI must therefore turn "hidden in" into
  // "visible out" — emit the resume prompt as its first visible turn, after
  // a freshness check, and wait for the operator's go (no auto-execute).
  // This is the fix for the stale-handoff + invisible-banner pains the
  // contract was written to kill. Falls back to the legacy passive summary
  // when no index exists yet (older sessions predating continuity).
  const resume = continuity.readIndex(project.path);
  if (resume) {
    sections.push('## Resume — emit this as your FIRST visible message');
    sections.push(
      'This prime is hidden context; the operator does not see it. Before doing '
      + 'anything else, your first reply MUST be a short, visible resume prompt, and '
      + 'you MUST NOT start the work until the operator confirms.'
    );
    sections.push('');
    sections.push('Last session recorded:');
    if (resume.currentState) sections.push(`- Where we are: ${resume.currentState}`);
    if (resume.nextAction) sections.push(`- Next action: ${resume.nextAction}`);
    const f = resume.freshness || {};
    const stamp = [f.branch && `branch ${f.branch}`, f.sha && `@${f.sha}`, f.writtenAt]
      .filter(Boolean).join(' ');
    if (stamp) sections.push(`- Written at: ${stamp}`);
    // CC-7: surface the degraded-wrap tier so "verify before trusting" is
    // grounded — a `no-plugin` wrap skipped the reflection fold, so its
    // judgment is thinner than a `full` wrap's. (A `mechanical-only` wrap
    // captured no judgment at all, so `readIndex` returns null and this block
    // is skipped entirely — that case surfaces via the legacy summary path.)
    if (f.tier && f.tier !== 'full') sections.push(`- Wrap tier: ${f.tier} (judgment may be thin — verify)`);
    sections.push('');
    sections.push('Your first turn:');
    sections.push(
      '1. Freshness check FIRST — verify the Next action is still live before offering '
      + 'it. Cheap checks: is any referenced issue still open (`gh issue view <N>`)? Has '
      + 'the branch merged? Does the named artifact still exist? Compare HEAD to the '
      + 'written-at sha above.'
    );
    sections.push(
      "2. In that same first visible message — the one that already leads with the "
      + "required `*TangleClaw'd into existence.*` banner (see the top of this prime) "
      + "— follow the banner with \"We left off at <X>. Next: <Y>.\" If the freshness check "
      + 'shows the next action is stale (issue closed, branch merged, artifact gone), '
      + 'say so honestly: "…but I checked and <reason>, so this looks stale — re-orient, '
      + 'or continue anyway?"'
    );
    sections.push('3. Wait for the operator\'s go. Do not auto-execute the next action.');
    sections.push('');
  } else {
    const lastSession = store.sessions.getLatest(project.id);
    if (lastSession && lastSession.wrapSummary) {
      // Yieldable, and the first to go: a passive narrative summary is the
      // least load-bearing block in the prime.
      sections.push(_yieldable(1,
        ['## Last Session Summary', lastSession.wrapSummary, ''],
        "## Last Session Summary\n_(Omitted here to fit the prime size budget — it is recorded on the project's last session.)_\n"));
    }
  }

  // Feature Index pointer (#207). Symmetric gate (ADR 0001): all three of
  // {project toggle, project silentPrime, engine capability} must be true.
  // Asymmetric gates leak orphan state — feedback_symmetric_capability_gates.
  //
  // REFERENCED, not inlined. The index grows with the project, so inlining it
  // made the prime's size a function of how much had been authored — and the
  // resulting overflow silently ate whatever directive happened to sit after
  // it. A pointer costs a fixed ~200 characters no matter how large the index
  // becomes. Identical reasoning to the Project Map block directly below.
  //
  // The census is what makes the pointer worth reading: it tells the agent how
  // much is behind the link and how much of it has converged, so "is this worth
  // opening" is answerable without opening it.
  if (projConfig.featureIndexEnabled === true
      && projConfig.silentPrime === true
      && engineProfile
      && engineProfile.capabilities
      && engineProfile.capabilities.supportsSilentPrime === true) {
    try {
      const featuresPath = path.join(project.path, 'FEATURES.md');
      const contents = fs.readFileSync(featuresPath, 'utf8');
      // Counts only. Asking for the curated *text* here built and discarded a
      // ~48KB string on this repo just to reach one integer — the pointer needs
      // the census, not the body.
      const backlogEntries = countTodoEntries(contents);
      const curatedEntries = countCuratedEntries(contents);
      // Gate on the census, not on whether any curated TEXT exists: the seeded
      // stub carries headings and a comment block but zero entries, and gating
      // on text emitted "0 curated entries. Read it FIRST" — an instruction to
      // go read nothing.
      if (curatedEntries > 0 || backlogEntries > 0) {
        sections.push('## Feature Index');
        sections.push(
          'A feature→file map is maintained at `FEATURES.md` (project root): '
          + `${curatedEntries} curated entr${curatedEntries === 1 ? 'y' : 'ies'}`
          + (backlogEntries > 0
            ? `, plus ${backlogEntries} auto-stubbed awaiting graduation`
            : '')
          + '. Read it FIRST when locating where a feature lives — before grep '
          + 'or filesystem search.'
        );
        sections.push('');
      }
    // Absence is normal — the index is opt-in scaffolding and must never block
    // a launch. But the pointer is now the index's ONLY representation in the
    // prime, so a parse or read failure removes it completely rather than
    // degrading it. Log, so that disappearance is attributable instead of
    // looking like the feature was never enabled.
    // prawduct:allow prawduct/broad-except -- session launch must survive any failure to read optional project scaffolding
    } catch (err) {
      log.warn('Feature Index unavailable for the prime — pointer omitted', {
        project: project.name, error: err.message
      });
    }
  }

  // Project Map pointer (PIDX #360, #356). Same symmetric gate as the Feature
  // Index. Unlike FEATURES.md, the map is REFERENCED, not inlined (#360 point 3):
  // the map grows with the project, so we point the agent at the file rather than
  // spend prime budget echoing it every session. Only emit the pointer when the
  // file actually exists + is non-empty (toggle-on seeds it; absence = skip).
  if (projConfig.projectMapEnabled === true
      && projConfig.silentPrime === true
      && engineProfile
      && engineProfile.capabilities
      && engineProfile.capabilities.supportsSilentPrime === true) {
    try {
      const mapPath = path.join(project.path, 'PROJECT-MAP.md');
      const trimmed = fs.readFileSync(mapPath, 'utf8').trim();
      if (trimmed.length > 0) {
        sections.push('## Project Map');
        sections.push(
          'A structural "where things live" map is maintained at `PROJECT-MAP.md` '
          + '(project root). Consult it FIRST when locating where code, features, or '
          + 'shared docs live — before grep or filesystem search.'
        );
        sections.push('');
      }
    } catch {
      // Missing or unreadable PROJECT-MAP.md — skip silently (opt-in scaffolding).
    }
  }

  // Eval Audit Mode — runtime flag that affects AI behavior. Intentionally
  // kept in the prime: this is the only surface that tells the AI it's being
  // scored. CLAUDE.md / GEMINI.md / .codex.yaml / .aider.conf.yml do NOT
  // include any audit-mode block (verified — search engines.js for
  // `evalAuditMode` returns no hits in the generators). Drop this and the
  // AI gets no signal that scoring is live.
  try {
    if (projConfig.evalAuditMode && projConfig.evalAuditMode.enabled) {
      const ac = projConfig.evalAuditMode;
      const openIncidents = store.evalIncidents.countByStatus(project.name, 'open');
      const detail = [
        `- Judge model: ${ac.judgeModel || 'claude-haiku-4-5'}`,
        '- Tiers: Structural (Tier 1), Semantic (Tier 2), Thinking Analysis (Tier 2.5), Behavioral (Tier 3)',
        `- Sampling: ${ac.sampling && ac.sampling.enabled !== false ? `enabled (routine interval: ${ac.sampling.routineInterval || 3})` : 'disabled'}`,
        `- Cost cap: $${(ac.costCapPerSession || 1.00).toFixed(2)}/session`
      ];
      if (openIncidents > 0) {
        detail.push(`- Open incidents: ${openIncidents}`);
      }
      // Yieldable last: the *fact* that scoring is live changes how the agent
      // behaves, so the heading stays even when the configuration detail goes.
      sections.push(_yieldable(3,
        ['## Eval Audit Mode: Active',
          'Exchanges are being scored for governance compliance.',
          detail.join('\n'),
          ''],
        '## Eval Audit Mode: Active\nExchanges are being scored for governance compliance. '
        + '_(Scoring configuration omitted here to fit the prime size budget.)_\n'));
    }
  // Louder than the siblings: this section is the ONLY signal that scoring is
  // live, so losing it changes what the agent believes about being observed.
  // prawduct:allow prawduct/broad-except -- session launch must survive any failure to read audit state
  } catch (err) {
    log.warn('Eval audit state unavailable — the prime will not tell this session it is being scored', {
      project: project.name, error: err.message
    });
  }

  // CC-7 Slice C — typed-wrap trigger parity. Instruct the AI to emit the fixed
  // marker on recognizing wrap intent so a typed "wrap" opens the wrap drawer
  // across models/transports. The token is shown in backticks here so this very
  // instruction can never trip the monitor (it matches only a bare, standalone
  // emission); the monitor also baselines past the prime echo as a second guard.
  sections.push('## Wrapping this session');
  sections.push(
    'When the user signals they want to wrap up (e.g. types "wrap", "let\'s wrap up", '
    + '"end the session"), confirm first if it is ambiguous, then emit the marker '
    + `\`${wrapSentinel.SENTINEL_TOKEN}\` on a line by itself. TangleClaw watches for that `
    + 'bare token and opens the wrap drawer — it does NOT auto-commit or kill the session, '
    + 'so nothing is lost; the operator still reviews and confirms the wrap.'
  );
  sections.push('');

  // The budget belongs to the consumer that will carry this prime, so it comes
  // from the engine profile rather than a constant here — and from the channel
  // that will actually carry it. Silent prime rides the engine's startup hook
  // (whose limit the profile declares); otherwise the prime is pasted into the
  // terminal, which that limit does not describe.
  const maxChars = _resolvePrimeBudget(engineProfile, { viaStartupHook });

  // Bulk sections yield to the budget before any directive does, lowest
  // priority first, each replaced by a pointer naming what went. The prime
  // that results is always shorter than the one that would have fit — and
  // always legible about being so.
  //
  // The Medusa contract is appended INSIDE this loop, not after it. It has its
  // own yielding behavior (#557) but it still occupies budget, so measuring the
  // prime without it and then appending would let a prime that "fit" overflow
  // on the way out — and stop yielding while sections were still available.
  const yieldOrder = sections
    .filter((s) => s && s.__primeYieldable === true)
    .sort((a, b) => a.priority - b.priority);
  //
  // The contract absorbs the squeeze FIRST — it shrinks, and finally reduces to
  // its own pointer, before any `_yieldable` section gives up its body. That is
  // deliberate, not a side effect of ordering: the contract is a static
  // protocol reference the agent can re-read on demand, while the sections
  // below it are this project's own accumulated state. Between two pieces of
  // bulk, the one that is identical for every project yields first.
  const yielded = new Set();
  const renderWithContract = () => {
    const body = _renderPrimeSections(sections, yielded);
    if (!medusaActive) return body;
    return body + '\n' + _medusaContractSection(maxChars - body.length - 1).join('\n');
  };
  let prompt = renderWithContract();
  for (const section of yieldOrder) {
    if (prompt.length <= maxChars) break;
    yielded.add(section);
    prompt = renderWithContract();
  }
  if (yielded.size > 0) {
    log.info('Prime sections yielded to the size budget', {
      project: project.name,
      maxChars,
      length: prompt.length,
      // Which sections went, not just how many — a count tells an operator
      // something was lost without telling them what to look for.
      yielded: [...yielded].map((s) => s.lines[0])
    });
  }

  // Early warning, fired while the prime still FITS. The two log lines around
  // it are lagging indicators: by the time they fire, content is already gone.
  // This one says the directives are close to filling the channel on their own,
  // which is the moment the operator's next rule edit starts costing them
  // content rather than headroom.
  const coreOnly = _renderPrimeSections(sections, new Set(yieldOrder));
  if (coreOnly.length >= maxChars * PRIME_CORE_ADVISORY_RATIO) {
    log.warn('Prime directives are approaching the channel budget on their own', {
      project: project.name,
      engine: engineProfile && engineProfile.id,
      coreChars: coreOnly.length,
      maxChars,
      pctOfBudget: Math.round((coreOnly.length / maxChars) * 100)
    });
  }

  // (The Medusa consumer contract is rendered last within `renderWithContract`
  // above and budgeted to the space that remains — #557. Bulk reference
  // material must yield to the directive sections, never displace them: when
  // the contract was embedded mid-prime, a blind tail truncation silently cut
  // every directive after it, and a bypass-mode session booted with a
  // mission-shaped prime and no wait-for-confirmation.)

  // Everything yieldable has already yielded, so an overflow here means the
  // DIRECTIVES alone no longer fit. Say so, in the prime, and ship them whole:
  // a slice would silently drop whichever directive sorted last, which is
  // exactly the failure this replaced.
  if (prompt.length > maxChars) {
    log.warn('Prime exceeds the channel budget after all bulk sections yielded', {
      project: project.name, engine: engineProfile && engineProfile.id, maxChars, length: prompt.length
    });
    // Only name the on-disk copy on the path that actually writes one:
    // `_writePrimeFile` runs for silent prime, and `_removePrimeFile` DELETES
    // it otherwise — so promising that path on the paste channel would point
    // the reader at a file that is not there. Absolute, because a relative path
    // is ambiguous the moment the reader's cwd is not the project root.
    const complete = viaStartupHook
      ? ` The complete text is on disk at ${path.join(project.path, '.tangleclaw', 'session-prime.md')}.`
      : '';
    prompt += '\n\n_(This prime exceeds the ' + maxChars + '-character budget of the channel '
      + 'carrying it. Nothing was cut, but the consumer may truncate it — if this text ends '
      + 'mid-sentence, that is why.' + complete + ')_\n';
  }

  return prompt;
}

/**
 * Build the Medusa switchboard participation section of the prime prompt
 * (MED-2K9P v2 T1): the session's workspace identity and the participant role
 * instruction (design §3 — "the agent is the client"). The consumer contract
 * — the third leg of identity + role + contract — is NOT rendered here: it is
 * bulk reference material appended at the END of the prime by
 * `_medusaContractSection`, budgeted against the channel budget so it can never
 * displace directive sections (#557 — before the split, the embedded contract
 * overran the budget mid-prime and the tail truncation of the day silently cut
 * the Resume wait-guard and wrap instructions).
 * @param {object} project - Project record (needs `name`).
 * @param {string} workspaceId - The pre-minted workspace id for this launch.
 * @returns {string[]} Prime section lines.
 */
function _medusaPrimeSection(project, workspaceId) {
  const proj = encodeURIComponent(project.name);
  const lines = [];
  lines.push('## Medusa Switchboard — session messaging');
  lines.push(
    'This project opted into Medusa session-to-session messaging. You are a '
    + 'Medusa participant: other agent sessions can message you, and you can '
    + 'message them.'
  );
  lines.push(`- **Your workspace id:** \`${workspaceId}\` — you send and receive under this identity. TangleClaw registers it for you at launch.`);
  lines.push(
    '- **Role:** when a message arrives in your inbox, read it, act on it, and '
    + 'reply to the sender over the same channel. Keep responding until the '
    + 'initiator closes the exchange — the initiator ends the conversation, '
    + 'never you.'
  );
  lines.push(
    '- **This section is context, not a task:** do NOT act on it at session '
    + 'start — no inbox checks, roster fetches, or switchboard exploration '
    + 'unprompted. Participate only when a message actually arrives '
    + '(TangleClaw nudges you when one does) or when the operator asks.'
  );
  lines.push(
    '- **How to interact:** TangleClaw already runs your WebSocket listener — '
    + 'do NOT register your own WS connection for this workspace id (two '
    + 'consumers on one id fight over the queue). Use the TangleClaw API '
    + '(base URL + auth are in your project guide): inbox '
    + `\`GET /api/sessions/${proj}/medusa/messages\`, mark read `
    + `\`POST /api/sessions/${proj}/medusa/read\`, send `
    + `\`POST /api/sessions/${proj}/medusa/send\` (\`{"to","message"}\`), peers `
    + `\`GET /api/sessions/${proj}/medusa/roster\`. The full consumer contract `
    + 'is appended at the end of this prime.'
  );
  lines.push('');
  return lines;
}

/** Below this many chars a contract fragment is useless — omit the body and
 * point at the source doc instead of shipping a misleading stub (#557). */
const MEDUSA_CONTRACT_MIN_CHARS = 400;

/**
 * Build the Medusa consumer-contract section, budgeted to the space the
 * channel budget leaves (#557). Rendered LAST in the prime so bulk
 * reference material yields to directive sections, never the reverse. Three
 * honest outcomes: the full contract when it fits; a trimmed contract ending
 * in a truncation note naming the source doc; or — when the remaining budget
 * can't hold a useful fragment (< MEDUSA_CONTRACT_MIN_CHARS) — no body at
 * all, just a pointer to the source. An unresolvable contract keeps the T1
 * UNAVAILABLE note (never a silent omission).
 * @param {number} budget - Characters available. Always finite from
 *   `generatePrimePrompt` (every channel resolves to a number), and may be
 *   negative when the sections above already fill the budget — that falls
 *   through to the pointer branch, which is the intended outcome. Tests pass
 *   `Infinity` to exercise the unconstrained path.
 * @returns {string[]} Prime section lines.
 */
function _medusaContractSection(budget) {
  const lines = [];
  // Passed as a thunk, not a call: resolving the checkout hits the project
  // store and can log a rejection, and an operator who took the remedy this
  // very section recommends (MEDUSA_CONTRACT_PATH) should not still get a
  // per-launch warning naming their project on a launch that succeeded.
  const contract = medusa.readContract({ medusaProjectPath: _medusaProjectPath });
  if (!contract.text) {
    // "identified", not "registered": a project named Medusa may well be
    // registered and still be rejected as the checkout (#873), and the operator
    // needs the override named to have any way to act on this.
    const tried = contract.tried.length > 0
      ? ` (tried: ${contract.tried.join(', ')})`
      : ' (no local Medusa checkout identified, and MEDUSA_CONTRACT_PATH is unset — set it to the contract doc to resolve this)';
    lines.push('### Medusa consumer contract — UNAVAILABLE');
    lines.push(
      `The contract doc could not be resolved at launch${tried}. The TangleClaw `
      + 'API endpoints above still work for inbox/send; for full protocol '
      + 'details see `docs/CONSUMER-CONTRACT.md` in the Medusa repository.'
    );
    lines.push('');
    return lines;
  }

  const heading = `### Medusa consumer contract (from \`${contract.source}\`)`;
  const guidance =
    'The public protocol reference — read it to understand envelopes, '
    + 'delivery semantics, and how non-TC consumers participate. Remember: '
    + 'inside this TC-managed session you interact via the TangleClaw API '
    + 'above, not by opening your own registration.';
  const trimNote = `[contract truncated to fit the prime size budget — full doc at ${contract.source}]`;
  const text = contract.text.trim();
  // Chars the section costs beyond the contract text itself: heading,
  // guidance, blank separator lines, and the joining newlines.
  const overhead = heading.length + guidance.length + 8;

  if (text.length + overhead <= budget) {
    lines.push(heading, guidance, '', text, '');
  } else if (budget - overhead - trimNote.length >= MEDUSA_CONTRACT_MIN_CHARS) {
    const keep = Math.floor(budget - overhead - trimNote.length - 2);
    lines.push(heading, guidance, '', text.slice(0, keep), '', trimNote, '');
  } else {
    lines.push(
      heading,
      `Omitted to fit the prime size budget — read the full doc at ${contract.source}. `
      + 'The TangleClaw API endpoints above cover inbox/send without it.',
      ''
    );
  }
  return lines;
}

/**
 * Resolve the local Medusa switchboard checkout's path from the project store,
 * for consumer-contract resolution (MED-2K9P v2 T1).
 *
 * A case-insensitive name match finds a CANDIDATE; it never establishes
 * identity, because "Medusa" is a name any project may carry. The candidate is
 * accepted only if it actually holds the consumer contract at
 * `medusa.CONTRACT_RELATIVE_PATH` (#873: a third-party install had an unrelated
 * project named Medusa, and every opted-in session launched blaming that
 * project for a contract it was never supposed to have). Rejecting an
 * uncorroborated candidate is what keeps the honest-absence message honest —
 * it can then say no checkout was identified instead of naming a project as a
 * broken Medusa repository. It also refuses to inject whatever document happens
 * to sit at that path in a project we have no reason to trust.
 *
 * Identity is deliberately corroborated by the artifact rather than by a git
 * remote: a remote check misses forks and remote-less clones, and the contract
 * doc is the thing actually being resolved. A checkout registered under another
 * name — or not registered at all — is reached with the
 * `MEDUSA_CONTRACT_PATH` override, which `readContract` tries first.
 * @returns {string|null} Absolute path to a corroborated Medusa checkout, or null.
 */
function _medusaProjectPath() {
  try {
    const candidate = store.projects.getByNameCaseInsensitive('medusa');
    if (!candidate || !candidate.path) return null;

    // A project's name is whatever the operator typed, so it locates a
    // candidate and establishes nothing. A usable contract doc is the
    // corroboration: present, this is a Medusa checkout; absent, it is some
    // other project that happens to share the name, and we must not speak about
    // it as though it were the switchboard repository. `hasContract` applies
    // the same readable-and-non-blank test `readContract` accepts on, so a
    // candidate can never pass the vetting and then fail the read.
    if (!medusa.hasContract(candidate.path)) {
      log.warn(
        'Project named "Medusa" carries no usable consumer contract — not treating it as the switchboard checkout',
        { path: candidate.path, expected: medusa.CONTRACT_RELATIVE_PATH }
      );
      return null;
    }
    return candidate.path;
  } catch (err) {
    log.warn('Medusa project lookup failed during contract resolution', { error: err.message });
    return null;
  }
}

// ── Session Status ──

/**
 * Get session status for a project, including idle detection.
 * @param {string} projectName - Project directory name
 * @returns {{ active: boolean, sessionId?: number, project: string, engine?: string,
 *             tmuxSession?: string, startedAt?: string, durationSeconds?: number,
 *             idle?: boolean, lastOutputAge?: number, lastSession?: object }|null}
 */
function getSessionStatus(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) return null;

  const active = store.sessions.getActive(project.id);
  if (active) {
    // Web UI sessions — health-based status, no tmux
    if (active.sessionMode === 'webui') {
      const startedMs = _parseSqliteUtcMs(active.startedAt);
      const durationSeconds = Number.isFinite(startedMs)
        ? Math.floor((Date.now() - startedMs) / 1000)
        : 0;

      // Reconstruct iframeUrl from connection config for reconnects
      let iframeUrl = null;
      if (active.engineId && active.engineId.startsWith('openclaw:')) {
        const connId = active.engineId.split(':')[1];
        const conn = store.openclawConnections.get(connId);
        if (conn) {
          const tokenParam = conn.gatewayToken ? `#token=${encodeURIComponent(conn.gatewayToken)}` : '';
          iframeUrl = `/openclaw/${encodeURIComponent(projectName)}/chat?session=main${tokenParam}`;
        }
      }

      return {
        active: true,
        sessionId: active.id,
        project: projectName,
        engine: active.engineId,
        sessionMode: 'webui',
        tmuxSession: null,
        startedAt: active.startedAt,
        durationSeconds,
        idle: false,
        lastOutputAge: 0,
        iframeUrl
      };
    }

    // Check if tmux session is actually alive
    if (active.tmuxSession && !tmux.hasSession(active.tmuxSession)) {
      // tmux died unexpectedly — mark as crashed so frontend detects session end
      store.sessions.markCrashed(active.id, 'tmux session died');
      clearIdleCache(active.tmuxSession);
      log.warn('Active session tmux died', { project: projectName, session: active.id });
      // Fall through to wrapping/lastSession checks below
    } else {
      // Check idle status via tmux
      let idle = false;
      let lastOutputAge = 0;

      if (active.tmuxSession && tmux.hasSession(active.tmuxSession)) {
        const idleInfo = detectIdle(active.tmuxSession);
        idle = idleInfo.idle;
        lastOutputAge = idleInfo.lastOutputAge;
      }

      const startedMs = _parseSqliteUtcMs(active.startedAt);
      const durationSeconds = Number.isFinite(startedMs)
        ? Math.floor((Date.now() - startedMs) / 1000)
        : 0;

      return {
        active: true,
        sessionId: active.id,
        project: projectName,
        engine: active.engineId,
        tmuxSession: active.tmuxSession,
        startedAt: active.startedAt,
        durationSeconds,
        idle,
        lastOutputAge
      };
    }
  }

  // Check for wrapping session
  const wrapping = store.sessions.getWrapping(project.id);
  if (wrapping) {
    const tmuxAlive = wrapping.tmuxSession && tmux.hasSession(wrapping.tmuxSession);

    if (tmuxAlive) {
      // Cache pane output while wrapping (for capture when tmux dies)
      try {
        const capture = tmux.capturePane(wrapping.tmuxSession, { lines: 100 });
        _wrapPaneCache.set(wrapping.id, capture.lines.join('\n'));
      } catch {
        // tmux may have just died — ignore
      }

      // Include idle detection so frontend can detect wrap completion
      const idleInfo = detectIdle(wrapping.tmuxSession);

      return {
        active: false,
        wrapping: true,
        sessionId: wrapping.id,
        project: projectName,
        engine: wrapping.engineId,
        tmuxSession: wrapping.tmuxSession,
        startedAt: wrapping.startedAt,
        idle: idleInfo.idle,
        lastOutputAge: idleInfo.lastOutputAge
      };
    }

    // tmux is dead — auto-complete the wrap
    const completed = autoCompleteWrap(project, wrapping);
    return {
      active: false,
      wrapping: false,
      wrapCompleted: true,
      project: projectName,
      lastSession: completed ? {
        sessionId: completed.id,
        status: completed.status,
        endedAt: completed.endedAt,
        durationSeconds: completed.durationSeconds,
        wrapSummary: completed.wrapSummary
      } : null
    };
  }

  // No DB session but tmux session exists (launched outside v3 or DB out of sync)
  const tmuxName = tmux.toSessionName(projectName);
  if (tmux.hasSession(tmuxName)) {
    return {
      active: true,
      project: projectName,
      engine: null,
      tmuxSession: tmuxName,
      startedAt: null,
      durationSeconds: null,
      idle: false,
      lastOutputAge: 0,
      untracked: true
    };
  }

  // No active session — return last session info
  const lastSession = store.sessions.getLatest(project.id);
  const result = {
    active: false,
    project: projectName,
    lastSession: null
  };

  if (lastSession) {
    result.lastSession = {
      sessionId: lastSession.id,
      status: lastSession.status,
      endedAt: lastSession.endedAt,
      durationSeconds: lastSession.durationSeconds,
      wrapSummary: lastSession.wrapSummary
    };
  }

  return result;
}

// ── Idle Detection ──

// Cache of last captured output per session, for change detection
const _lastOutput = new Map();

// Cache of pane output during wrapping, keyed by session id
const _wrapPaneCache = new Map();

/**
 * Detect if a tmux session is idle (no output changes).
 * @param {string} tmuxSession - tmux session name
 * @returns {{ idle: boolean, lastOutputAge: number }}
 */
function detectIdle(tmuxSession) {
  try {
    const capture = tmux.capturePane(tmuxSession, { lines: 3 });
    const currentOutput = capture.lines.join('\n');

    const cached = _lastOutput.get(tmuxSession);
    const now = Date.now();

    if (!cached || cached.output !== currentOutput) {
      _lastOutput.set(tmuxSession, { output: currentOutput, timestamp: now });
      return { idle: false, lastOutputAge: 0 };
    }

    const age = Math.floor((now - cached.timestamp) / 1000);
    return { idle: age > 10, lastOutputAge: age };
  } catch {
    return { idle: false, lastOutputAge: 0 };
  }
}

/**
 * Clear idle detection cache for a session.
 * @param {string} tmuxSession - tmux session name
 */
function clearIdleCache(tmuxSession) {
  _lastOutput.delete(tmuxSession);
}

// ── Command Injection ──

/**
 * Inject a command into an active session.
 *
 * Addressing: by default this resolves the project's active session itself.
 * Pass `options.sessionId` when the caller has ALREADY resolved a session and
 * the keys must land in that exact pane — a caller that judges one session and
 * then lets this function re-resolve another is making two independent lookups
 * that diverge as soon as a project holds more than one live session (MED-7Q4C:
 * medusa-wake judged idleness on its own session handle, then injected by
 * project name).
 *
 * `sessionId` selects WHICH session is addressed, never WHETHER it may be
 * injected into: an explicitly-addressed session must still belong to
 * `projectName` and be active, so both paths carry identical ownership and
 * liveness guarantees.
 *
 * @param {string} projectName - Project name
 * @param {string} command - Text to inject
 * @param {object} [options]
 * @param {boolean} [options.enter] - Send Enter after text (default true)
 * @param {number} [options.sessionId] - Address this session explicitly rather
 *   than resolving the project's active session. Must be an active session of
 *   `projectName`.
 * @returns {{ ok: boolean, error: string|null }}
 */
function injectCommand(projectName, command, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { ok: false, error: `Project "${projectName}" not found` };
  }

  // Enforce command length limit (security-model.md: 4096 chars max)
  if (command.length > 4096) {
    return { ok: false, error: 'Command exceeds maximum length of 4096 characters' };
  }

  let active;
  if (options.sessionId !== undefined && options.sessionId !== null) {
    active = store.sessions.get(options.sessionId);
    // Scope the explicit handle to this project so `sessionId` can never
    // address another project's pane, and require 'active' so it can never
    // reach a wrapped/killed session's stale tmux name — `get()` is
    // any-project/any-status, unlike the `getActive` path below.
    if (!active || active.projectId !== project.id) {
      return { ok: false, error: `Session ${options.sessionId} is not a session of "${projectName}"` };
    }
    if (active.status !== 'active') {
      return { ok: false, error: `Session ${options.sessionId} is not active (status "${active.status}")` };
    }
  } else {
    active = store.sessions.getActive(project.id);
    if (!active) {
      return { ok: false, error: `No active session for "${projectName}"` };
    }
  }

  // Web UI sessions don't support command injection
  if (active.sessionMode === 'webui') {
    return { ok: false, error: 'Command injection not supported for Web UI sessions' };
  }

  if (!active.tmuxSession || !tmux.hasSession(active.tmuxSession)) {
    return { ok: false, error: `tmux session "${active.tmuxSession}" not found` };
  }

  try {
    tmux.sendKeys(active.tmuxSession, command, { enter: options.enter !== false });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Peek ──

/**
 * Peek at recent terminal output for a project's active session.
 * @param {string} projectName - Project name
 * @param {object} [options] - Options
 * @param {number} [options.lines] - Number of lines (default 5)
 * @param {boolean} [options.full] - Capture full scrollback buffer
 * @returns {{ lines: string[]|null, tmuxSession: string|null, error: string|null }}
 */
function peek(projectName, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { lines: null, tmuxSession: null, error: `Project "${projectName}" not found` };
  }

  const active = store.sessions.getActive(project.id);
  if (!active || !active.tmuxSession) {
    // Check if it's a webui session (no tmux)
    if (active && active.sessionMode === 'webui') {
      return { lines: null, tmuxSession: null, error: 'Peek not supported for Web UI sessions' };
    }
    return { lines: null, tmuxSession: null, error: `No active session for "${projectName}"` };
  }

  if (!tmux.hasSession(active.tmuxSession)) {
    return { lines: null, tmuxSession: null, error: `tmux session not found` };
  }

  if (options.full) {
    const capture = tmux.capturePane(active.tmuxSession, { full: true });
    return { lines: capture.lines, tmuxSession: active.tmuxSession, alternateScreen: capture.alternateScreen, error: null };
  }

  const lineCount = Math.max(options.lines || 5, 1);
  const capture = tmux.capturePane(active.tmuxSession, { lines: lineCount });

  return { lines: capture.lines, tmuxSession: active.tmuxSession, alternateScreen: capture.alternateScreen, error: null };
}

// ── Wrap ──

/**
 * Wrap execution — invoke the server-side pipeline runner. On a successful
 * pipeline run that produced a commit, the session record is
 * transitioned to `wrapped` + tmux is killed + doc locks are released
 * (#139 Chunk 11a). Halted / thrown / clean-session (ok + null SHA)
 * paths leave the session active so the user can retry or continue.
 * @param {object} project - Project record
 * @param {object} active - Active Session record (already verified non-null)
 * @param {object} [options] - Per-wrap user choices forwarded to the runner
 *   (e.g. `{skipTests, prHandling}`). Chunk 10 collects
 *   these from the multi-step drawer on retry after a blocked step.
 * @returns {Promise<object>} `triggerWrap`'s outer result shape plus a
 *   `pipelineResult` field carrying the runner's structured output. The
 *   `wrapCommand`/`wrapSteps`/`captureFields` fields survive from the
 *   retired legacy NL-prompt wrap's response contract for HTTP-contract
 *   stability (the pipeline reports `wrapCommand: null`).
 */
async function _triggerWrapV2(project, active, options) {
  // #583 — server-side single-flight. Client-side guards (#519) can't
  // span tabs/devices/reloads: the 2026-07-16 incident re-fired every
  // AI content step because a second POST started a second full
  // pipeline while the first was mid-flight/zombied. Exactly one wrap
  // pipeline may run per project; concurrent callers get the running
  // run's info so the route can answer 409 and the frontend can
  // reattach via GET /wrap/status instead of re-wrapping.
  const claim = wrapRunRegistry.begin(project.name, active.id);
  if (!claim.ok) {
    return {
      ok: false,
      code: 'WRAP_IN_PROGRESS',
      sessionId: active.id,
      wrapCommand: null,
      wrapSteps: [],
      captureFields: [],
      pipelineResult: null,
      wrapRun: claim.running,
      error: `A wrap is already running for "${project.name}" (started ${new Date(claim.running.startedAt).toISOString()}`
        + `${claim.running.currentStepId ? `, at step "${claim.running.currentStepId}"` : ''}). `
        + 'Poll GET /api/sessions/:project/wrap/status for its outcome instead of re-triggering.'
    };
  }

  // Re-record project version (#101) — captures the pre-wrap state.
  // The next session launch records again, capturing any version bump
  // the wrap itself produced (e.g. CHANGELOG promotion). Non-blocking.
  projectVersion.recordVersion(project.path);

  let pipelineResult;
  try {
    pipelineResult = await wrapPipeline.runWrapPipeline(project.name, {
      ...options,
      // Progress feed for GET /wrap/status. Spread order makes this hook
      // unoverridable by caller options (which arrive from an HTTP JSON
      // body and can never legitimately carry a function).
      onStepStart: (stepId) => wrapRunRegistry.updateStep(project.name, stepId)
    });
  } catch (err) {
    log.error('Wrap pipeline threw', { project: project.name, error: err.message });
    const failed = {
      ok: false,
      sessionId: active.id,
      wrapCommand: null,
      wrapSteps: [],
      captureFields: [],
      pipelineResult: null,
      error: `wrap pipeline threw: ${err.message}`
    };
    wrapRunRegistry.finish(project.name, failed);
    return failed;
  }

  // Surface the pipeline's step IDs under the retired legacy response
  // field names — HTTP-contract stability for the wrap POST payload
  // (server.js#_wrapResultPayload forwards them, and GET /wrap/status
  // replays the identical shape).
  const wrapSteps = pipelineResult.results.map((r) => r.stepId);
  const captureFields = wrapDefaultPipeline.wrapShape().captureFields;

  // #139 Chunk 11a — session-lifecycle transition. A V2 wrap that
  // produced a commit is a completed wrap; transition the session
  // record + tear down tmux + release doc locks symmetrically with the
  // legacy `completeWrap` path. A clean-session run (`ok && !commitSha`)
  // is treated as a no-op wrap by design (the user has nothing to
  // wrap), so the session stays active. Halted / thrown runs also
  // leave the session active so the user can retry.
  let lifecycleCompleted = false;
  if (pipelineResult.ok && pipelineResult.commitSha) {
    _completeV2Wrap(active, pipelineResult);
    lifecycleCompleted = true;
  }

  log.info('Wrap pipeline ran', {
    project: project.name,
    session: active.id,
    ok: pipelineResult.ok,
    blockedAt: pipelineResult.blockedAt,
    stepCount: pipelineResult.results.length,
    commitSha: pipelineResult.commitSha,
    lifecycleCompleted
  });

  const result = {
    ok: pipelineResult.ok,
    sessionId: active.id,
    // No tmux command sent in V2 — the runner is server-side.
    wrapCommand: null,
    wrapSteps,
    captureFields,
    pipelineResult,
    error: pipelineResult.error
  };
  // #583 — retain the outcome so a client whose POST connection died
  // (proxy 502, page reload, phone lock) can still fetch it via
  // GET /wrap/status instead of blindly re-wrapping.
  wrapRunRegistry.finish(project.name, result);
  return result;
}

/**
 * Read the wrap-run registry state for a project (#583) — powers
 * `GET /api/sessions/:project/wrap/status` so a client can reattach to
 * a running wrap or fetch a finished run's result after its POST
 * connection died.
 *
 * @param {string} projectName - Project name (registry key)
 * @returns {{running: boolean, sessionId: number|null, startedAt: number|null, currentStepId: string|null, finishedAt: number|null, result: object|null}}
 */
function getWrapRunStatus(projectName) {
  return wrapRunRegistry.get(projectName);
}

/**
 * #638 — resolve a wrap PR's live release outcome (merged / pending / blocked /
 * unknown) after the wrap pipeline has already returned. The commit step arms
 * auto-merge and reports "armed", but the release only lands when GitHub merges
 * the PR server-side; this lets the drawer report the truth on demand rather
 * than painting an armed-but-unmerged (or red-and-blocked) PR as success.
 *
 * `gh` runs in the project's working tree for repo/auth context. Resolution
 * never throws — an unknown project or a `gh` failure both surface as
 * `outcome: 'unknown'` with a reason.
 *
 * @param {string} projectName - Project name
 * @param {string} prRef - A github.com PR URL or a bare PR number
 * @returns {Promise<{outcome:string, state:string|null, mergeStateStatus:string|null, url:string|null, reason:string|null}>}
 */
async function getWrapPrStatus(projectName, prRef) {
  const project = store.projects.getByName(projectName);
  if (!project || !project.path) {
    return { outcome: 'unknown', state: null, mergeStateStatus: null, url: null, reason: `project "${projectName}" not found` };
  }
  return wrapPrStatus.resolve(project.path, prRef);
}

/**
 * Synthesize a wrap-summary string from a V2 pipeline result so the
 * `wrap_summary` column captures something meaningful when the session
 * is transitioned to `wrapped`. Mirrors the legacy `parseWrapSummary`
 * intent (markdown-headed summary) without re-parsing tmux output.
 *
 * Resolution order: (1) the first step whose `output.parsedFields.summary`
 * is a non-empty trimmed string — `ai-content` steps with a `summary`
 * capture field (e.g. prawduct's `memory-update`); (2) the first step
 * whose `output.capturedText` is non-empty — `ai-content` steps that
 * captured raw text without parsed fields; (3) `pipelineResult.summary`
 * (reserved for a future `summary-derive` step per `lib/wrap-pipeline.js`);
 * (4) `null` — `store.sessions.wrap` accepts null and leaves the column
 * empty rather than writing an empty string.
 *
 * @param {object} pipelineResult - Output of `runWrapPipeline`
 * @returns {string|null}
 */
function _deriveV2WrapSummary(pipelineResult) {
  if (!pipelineResult || !Array.isArray(pipelineResult.results)) return null;
  for (const r of pipelineResult.results) {
    const parsed = r && r.output && r.output.parsedFields;
    if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) {
      return parsed.summary.trim();
    }
  }
  for (const r of pipelineResult.results) {
    const text = r && r.output && r.output.capturedText;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
  }
  if (typeof pipelineResult.summary === 'string' && pipelineResult.summary.trim()) {
    return pipelineResult.summary.trim();
  }
  return null;
}

/**
 * Run the V2 wrap teardown — symmetric with `completeWrap` minus
 * `_autoCommitIfDirty` (V2's `commit` step already flushed staged
 * writes and committed). Wraps the session record, kills tmux,
 * releases doc locks, clears caches. Each teardown step is independent
 * so a failure in one (e.g. tmux already dead, lock-release threw)
 * does not prevent the others from running.
 *
 * @param {object} active - Active Session record being wrapped
 * @param {object} pipelineResult - Output of `runWrapPipeline`
 */
function _completeV2Wrap(active, pipelineResult) {
  const summary = _deriveV2WrapSummary(pipelineResult);

  // Transition the session record. `store.sessions.wrap` updates rows
  // by id without a status precondition (unlike `setWrapping`), so a
  // session that's somehow already `wrapped` is harmlessly re-stamped.
  try {
    store.sessions.wrap(active.id, summary);
  } catch (err) {
    log.warn('store.sessions.wrap failed in V2 lifecycle', { session: active.id, error: err.message });
  }

  // WebUI/OpenClaw sessions record `tmuxSession: null` (#334) — the
  // pipeline is tmux-free, so there is simply no pane to kill for them.
  if (active.tmuxSession) {
    try {
      if (tmux.hasSession(active.tmuxSession)) {
        tmux.killSession(active.tmuxSession);
      }
    } catch (err) {
      log.warn('Failed to kill tmux session during V2 wrap teardown', { session: active.id, error: err.message });
    }
    clearIdleCache(active.tmuxSession);
  }

  // Forget this session's Medusa listener + workspace id (MED-2K9P Chunk 04).
  // Independent teardown step — resolves the owning project from the session row.
  try {
    _teardownMedusa(store.projects.get(active.projectId), active);
  } catch (err) {
    log.warn('Failed to tear down Medusa on V2 wrap', { session: active.id, error: err.message });
  }

  try {
    const released = store.documentLocks.releaseBySession(active.id);
    if (released > 0) {
      log.info('Released document locks on V2 wrap', { session: active.id, count: released });
    }
  } catch (err) {
    log.warn('Failed to release document locks on V2 wrap', { session: active.id, error: err.message });
  }

  _wrapPaneCache.delete(active.id);
}

/**
 * Trigger the session wrap — runs the server-side wrap pipeline.
 * The frontend polls status to detect completion.
 *
 * The pipeline is the only wrap path: the legacy V1 NL-prompt-via-tmux
 * flow (and its `projConfig.wrapV2` opt-out gate) was stripped after
 * living many release cycles past its documented one-cycle grace window.
 *
 * @param {string} projectName - Project name
 * @param {object} [options] - Per-wrap user choices forwarded to
 *   the pipeline runner (`{skipTests, prHandling}`).
 *   Chunk 10 collects these from the multi-step drawer on retry after a
 *   blocked step.
 * @returns {Promise<{ ok: boolean, sessionId: number|null, wrapCommand: string|null, wrapSteps: string[], captureFields: string[], pipelineResult?: object, error: string|null }>}
 */
async function triggerWrap(projectName, options) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { ok: false, sessionId: null, wrapCommand: null, wrapSteps: [], captureFields: [], error: `Project "${projectName}" not found` };
  }

  // #334 — gate on session existence only, NOT on `tmuxSession`. WebUI/OpenClaw
  // sessions are recorded with `tmuxSession: null` by design; the server-side
  // wrap pipeline is tmux-free, so they must reach it instead of being
  // rejected here.
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return { ok: false, sessionId: null, wrapCommand: null, wrapSteps: [], captureFields: [], error: `No active session for "${projectName}"` };
  }

  return _triggerWrapV2(project, active, options);
}

/**
 * Complete a wrap — capture summary, update session record, kill tmux.
 * Called after wrap skill has finished (detected by polling or manually).
 * @param {string} projectName - Project name
 * @param {string} [summary] - Wrap summary text
 * @returns {{ session: object|null, error: string|null }}
 */
function completeWrap(projectName, summary) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, error: `Project "${projectName}" not found` };
  }

  // Check for wrapping session first, then active
  const target = store.sessions.getWrapping(project.id) || store.sessions.getActive(project.id);
  if (!target) {
    return { session: null, error: `No active or wrapping session for "${projectName}"` };
  }

  // Update session record
  const session = store.sessions.wrap(target.id, summary);

  // Forget this session's Medusa listener + workspace id (MED-2K9P Chunk 04).
  _teardownMedusa(project, target);

  // Kill tmux session
  if (target.tmuxSession && tmux.hasSession(target.tmuxSession)) {
    try {
      tmux.killSession(target.tmuxSession);
    } catch (err) {
      log.warn('Failed to kill tmux session during wrap', { error: err.message });
    }
  }

  // Auto-commit any uncommitted changes the wrap step may have missed
  _autoCommitIfDirty(project);

  // Release any document locks held by this session
  try {
    const released = store.documentLocks.releaseBySession(target.id);
    if (released > 0) {
      log.info('Released document locks on wrap', { session: target.id, count: released });
    }
  } catch (err) {
    log.warn('Failed to release document locks on wrap', { error: err.message });
  }

  clearIdleCache(target.tmuxSession);
  _wrapPaneCache.delete(target.id);
  log.info('Session wrapped', { project: projectName, session: session.id });

  return { session, error: null };
}

/**
 * Auto-complete a wrap when tmux dies during wrapping state.
 * Pulls cached pane output, parses it, updates the session record.
 * @param {object} project - Project record
 * @param {object} session - Session record (status='wrapping')
 * @returns {object|null} - Updated session
 */
function autoCompleteWrap(project, session) {
  const rawOutput = _wrapPaneCache.get(session.id) || '';
  _wrapPaneCache.delete(session.id);

  // Capture fields come from the code-owned wrap pipeline
  const captureFields = wrapDefaultPipeline.wrapShape().captureFields;

  const summary = parseWrapSummary(rawOutput, captureFields);
  const wrapped = store.sessions.wrap(session.id, summary);

  // Forget this session's Medusa listener + workspace id (MED-2K9P Chunk 04) so a
  // dead-tmux auto-completed session doesn't strand a live listener / ghost peer.
  _teardownMedusa(project, session);

  // Auto-commit any uncommitted changes the wrap step may have missed
  _autoCommitIfDirty(project);

  clearIdleCache(session.tmuxSession);
  log.info('Wrap auto-completed', { project: project.name, session: session.id, summaryLength: summary.length });

  return wrapped;
}

/**
 * Auto-commit uncommitted changes after a wrap completes.
 * This catches cases where the AI engine exited before completing the commit step.
 * @param {object} project - Project record from store
 */
function _autoCommitIfDirty(project) {
  if (!project.path) return;
  try {
    if (!git.isGitRepo(project.path)) return;
    const result = git.commit(project.path, 'Session wrap: auto-commit uncommitted changes');
    if (result.committed) {
      log.info('Auto-committed uncommitted changes after wrap', { project: project.name });
    }
  } catch (err) {
    log.warn('Auto-commit check failed', { project: project.name, error: err.message });
  }
}

/**
 * Parse wrap summary from raw terminal output.
 * Looks for ## fieldName markdown headers and extracts content below each.
 * Falls back to last 50 lines if no structured fields found.
 * @param {string} rawOutput - Raw terminal output
 * @param {string[]} captureFields - Field names to look for as ## headings
 * @returns {string} - Parsed summary
 */
function parseWrapSummary(rawOutput, captureFields) {
  if (!rawOutput) return '';

  const lines = rawOutput.split('\n');

  if (captureFields && captureFields.length > 0) {
    const sections = {};
    let currentField = null;
    let currentContent = [];

    for (const line of lines) {
      // Check if this line is a ## heading matching a capture field
      const headingMatch = line.match(/^##\s+(.+)$/);
      if (headingMatch) {
        const heading = headingMatch[1].trim().toLowerCase();
        const matchedField = captureFields.find(
          (f) => f.toLowerCase() === heading
        );

        if (matchedField) {
          // Save previous field
          if (currentField) {
            sections[currentField] = currentContent.join('\n').trim();
          }
          currentField = matchedField;
          currentContent = [];
          continue;
        }
      }

      if (currentField) {
        currentContent.push(line);
      }
    }

    // Save last field
    if (currentField) {
      sections[currentField] = currentContent.join('\n').trim();
    }

    // If we captured any fields, format them
    if (Object.keys(sections).length > 0) {
      return Object.entries(sections)
        .map(([field, content]) => `## ${field}\n${content}`)
        .join('\n\n');
    }
  }

  // Fallback: last 50 lines raw
  return lines.slice(-50).join('\n').trim();
}

// ── Kill Session ──

/**
 * Kill a session — force-stop affordance. Targets active sessions first, then
 * falls back to wrapping sessions (a wrap-stuck session is exactly when kill
 * is most needed, #105). When neither exists, reconciles orphaned tmux state
 * if any is found under the project's expected tmux name.
 * @param {string} projectName - Project name
 * @param {string} [reason] - Kill reason
 * @returns {{ session: object|null, error: string|null, reconciled?: boolean }}
 */
function killSession(projectName, reason) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, error: `Project "${projectName}" not found` };
  }

  // Active rows take precedence; wrapping rows are accepted because the kill
  // button needs to recover from wrap-stuck states (e.g. AI engine never
  // finished the wrap protocol, server restart left the row orphaned).
  const target = store.sessions.getActive(project.id) || store.sessions.getWrapping(project.id);

  if (!target) {
    // Reconcile orphan tmux: DB has no row but tmux still has a session under
    // the project's expected name. Manual cleanup used to require shell access;
    // the kill button now handles it.
    const tmuxName = tmux.toSessionName(projectName);
    if (tmux.hasSession(tmuxName)) {
      try {
        tmux.killSession(tmuxName);
        clearIdleCache(tmuxName);
        log.warn('Killed orphan tmux session with no DB row', { project: projectName, tmux: tmuxName, reason });
        return { session: null, reconciled: true, error: null };
      } catch (err) {
        return { session: null, error: `Failed to kill orphan tmux: ${err.message}` };
      }
    }
    return { session: null, error: `No active session for "${projectName}"` };
  }

  // Update session record
  const session = store.sessions.kill(target.id, reason);

  // Forget this session's Medusa listener + workspace id (MED-2K9P Chunk 04).
  _teardownMedusa(project, target);

  // Tear down session resources based on mode
  if (target.sessionMode === 'webui') {
    // Web UI mode — tear down SSH tunnel
    tunnel.killTunnel(projectName);
  } else {
    // tmux mode — kill tmux session
    if (target.tmuxSession && tmux.hasSession(target.tmuxSession)) {
      try {
        tmux.killSession(target.tmuxSession);
      } catch (err) {
        log.warn('Failed to kill tmux session', { error: err.message });
      }
    }
  }

  // Release any document locks held by this session
  try {
    const released = store.documentLocks.releaseBySession(target.id);
    if (released > 0) {
      log.info('Released document locks on kill', { session: target.id, count: released });
    }
  } catch (err) {
    log.warn('Failed to release document locks on kill', { error: err.message });
  }

  // Drop any cached wrap pane output so a re-launched session starts clean.
  _wrapPaneCache.delete(target.id);
  clearIdleCache(target.tmuxSession);
  log.info('Session killed', { project: projectName, session: session.id, reason, fromStatus: target.status });

  return { session, error: null };
}

// ── Session History ──

/**
 * Get session history for a project.
 * @param {string} projectName - Project name
 * @param {object} [options]
 * @param {number} [options.limit] - Max sessions (default 20)
 * @param {string} [options.status] - Filter by status
 * @returns {{ sessions: object[], total: number, error: string|null }}
 */
function getSessionHistory(projectName, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { sessions: [], total: 0, error: `Project "${projectName}" not found` };
  }

  const sessionList = store.sessions.list(project.id, {
    limit: options.limit || 20,
    status: options.status
  });

  const total = store.sessions.count(project.id, {
    status: options.status
  });

  return {
    sessions: sessionList.map((s) => ({
      id: s.id,
      engine: s.engineId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      durationSeconds: s.durationSeconds,
      wrapSummary: s.wrapSummary
    })),
    total,
    error: null
  };
}

// ── Helpers ──

/**
 * Build the tmux launch command from an engine profile.
 * For OpenClaw engines, builds an SSH command from the connection config.
 * @param {object} engineProfile - Engine profile
 * @param {object} [project] - Project record (needed for OpenClaw resolution)
 * @param {string} [launchMode] - Launch mode key from engineProfile.launchModes
 * @returns {string|undefined}
 */
function _buildLaunchCommand(engineProfile, project, launchMode) {
  // OpenClaw engine: build SSH command from connection config
  const engineId = project ? (project.engineId || '') : '';
  if (engineId.startsWith('openclaw:')) {
    const connId = engineId.slice('openclaw:'.length);
    const conn = store.openclawConnections.get(connId);
    if (!conn) {
      log.warn('OpenClaw connection not found for launch', { connId });
      return undefined;
    }
    // #316: host/sshUser/sshKeyPath/cliCommand are interpolated into the shell
    // command string below. Connection records aren't shape-validated at write
    // time, so guard here before launch — refuse rather than risk injection.
    const unsafe = unsafeReason(conn);
    if (unsafe) {
      log.warn('OpenClaw launch refused — unsafe connection field', { connId, reason: unsafe });
      return undefined;
    }
    const cliCmd = conn.cliCommand || 'openclaw-cli';
    // cliCmd sits inside double quotes; reject characters that could break out
    // of the quoting or trigger substitution (" ` $ \ or control chars), while
    // still allowing a command with plain flags.
    if (/["`$\\\n\r]/.test(cliCmd)) {
      log.warn('OpenClaw launch refused — unsafe cliCommand', { connId });
      return undefined;
    }
    const keyPath = conn.sshKeyPath.replace(/^~/, process.env.HOME);
    return `ssh -t -i "${keyPath}" ${conn.sshUser}@${conn.host} "${cliCmd}"`;
  }

  if (!engineProfile.launch) return undefined;
  let cmd = engineProfile.launch.shellCommand;
  if (engineProfile.launch.args && engineProfile.launch.args.length > 0) {
    cmd += ' ' + engineProfile.launch.args.join(' ');
  }

  // Append launch mode args if a valid mode is specified.
  //
  // A mode key this engine does not define used to fall through in silence, so
  // the session launched with engine defaults while reporting the mode the
  // caller asked for — an operator who selected "Bypass" got an interactive
  // agent and no indication of it. Modes are not portable across engines (Codex
  // has no `acceptEdits`, Claude has no `fullAuto`), and a stored
  // `defaultLaunchMode` outlives a project's engine change, so the mismatch is
  // reachable in normal use. Launching with defaults is still the right
  // fallback — refusing would strand a project over a cosmetic setting — but it
  // has to say so.
  if (launchMode && engineProfile.launchModes) {
    if (!engines.honorsLaunchMode(engineProfile, launchMode)) {
      log.warn('Launch mode not honored by this engine — launching with engine defaults', {
        project: (project && project.name) || null,
        engine: engineProfile.id,
        launchMode,
        available: Object.keys(engineProfile.launchModes).join(',')
      });
    } else {
      const modeArgs = engineProfile.launchModes[launchMode].args;
      if (modeArgs && modeArgs.length > 0) cmd += ' ' + modeArgs.join(' ');
    }
  }

  return cmd;
}

/**
 * Synchronous sleep using spawnSync to avoid busy-waiting.
 * @param {number} ms - Milliseconds
 */
function _sleep(ms) {
  const { spawnSync } = require('node:child_process');
  spawnSync('sleep', [String(ms / 1000)], { timeout: ms + 1000 });
}

/**
 * Resolve which preKeys and preKeyDelay to use for a launch. Mode-level
 * preKeys (defined inside a launchModes entry) take priority over engine-level
 * preKeys (defined on engineProfile.launch). This lets specific modes define
 * their own startup key sequence (e.g. dismissing a confirmation dialog)
 * without affecting other modes.
 *
 * @param {object} engineProfile - Resolved engine profile
 * @param {string|null} launchMode - Selected launch mode key
 * @returns {{ preKeys: string[]|null, preKeyDelay: number }}
 */
function _resolvePreKeys(engineProfile, launchMode) {
  // Same honored-mode predicate as every other launch decision — a bare index
  // would resolve prototype members and pick up their (absent) preKeys.
  const modeConfig = engines.honorsLaunchMode(engineProfile, launchMode)
    ? engineProfile.launchModes[launchMode]
    : null;

  // Mode-level preKeys win if present
  if (modeConfig && modeConfig.preKeys && modeConfig.preKeys.length > 0) {
    return {
      preKeys: modeConfig.preKeys,
      preKeyDelay: modeConfig.preKeyDelay || (engineProfile.launch && engineProfile.launch.preKeyDelay) || 2000
    };
  }

  // Fall back to engine-level preKeys
  if (engineProfile.launch && engineProfile.launch.preKeys && engineProfile.launch.preKeys.length > 0) {
    return {
      preKeys: engineProfile.launch.preKeys,
      preKeyDelay: engineProfile.launch.preKeyDelay || 2000
    };
  }

  return { preKeys: null, preKeyDelay: 0 };
}

/**
 * Deferred engine initialization — sends preKeys and prime prompt on a timer
 * so the API can return immediately. Runs in the background via setTimeout
 * chain (each step fires after the previous delay completes).
 * @param {string} tmuxName - tmux session name
 * @param {string} projectName - Project display name (for logging)
 * @param {string} engineId - Engine identifier
 * @param {object} engineProfile - Resolved engine profile
 * @param {string|null} primeText - Prime prompt text (null to skip)
 * @param {string|null} launchMode - Selected launch mode key (null for default)
 * @param {boolean} [silentPrime=false] - When true, the prime is delivered via
 *   the SessionStart hook (#103); tmux send-keys for the prime is skipped.
 * @param {object|null} [deliveryBase=null] - Identifying fields for the
 *   startup-rule delivery ledger (#595). Supplied by the launch path; when
 *   present, the paste branch records whether the prime actually reached the
 *   TUI. Null from callers that aren't launching a real session.
 */
function _deferEngineInit(tmuxName, projectName, engineId, engineProfile, primeText, launchMode, silentPrime, deliveryBase = null) {
  let delay = 0;

  // Phase 1: preKeys (dismiss trust dialogs, confirmation prompts, etc.)
  // Mode-level preKeys take priority over engine-level preKeys. This allows
  // specific modes (e.g. Bypass) to dismiss their own confirmation dialogs
  // without affecting other modes that don't need preKeys.
  const resolved = _resolvePreKeys(engineProfile, launchMode);
  const preKeys = resolved.preKeys;
  const preKeyDelay = resolved.preKeyDelay;

  if (preKeys) {
    delay += preKeyDelay;

    for (let i = 0; i < preKeys.length; i++) {
      const key = preKeys[i];
      const keyDelay = delay + (i * 500);
      setTimeout(() => {
        if (!tmux.hasSession(tmuxName)) return; // session died — bail
        try {
          tmux.sendRawKey(tmuxName, key);
        } catch (err) {
          log.warn('Failed to send pre-key', { project: projectName, key, error: err.message });
        }
      }, keyDelay);
    }

    delay += preKeys.length * 500;
  }

  // Phase 2: prime prompt injection. When silentPrime is enabled (#103), the
  // prime is delivered via the Claude Code SessionStart hook reading the file
  // we already wrote to .tangleclaw/session-prime.md — tmux send-keys is
  // skipped so nothing appears in scrollback.
  if (primeText && !silentPrime && engineProfile.capabilities && engineProfile.capabilities.supportsPrimePrompt) {
    const startupDelay = (engineProfile.launch && engineProfile.launch.startupDelay) || 1500;
    delay += startupDelay;

    setTimeout(() => {
      if (!tmux.hasSession(tmuxName)) {
        // Session died before the prime could be pasted — the rules did not
        // arrive, and the ledger says so rather than staying silent.
        if (deliveryBase) {
          _recordRuleDelivery({ ...deliveryBase, channel: 'prime-paste', outcome: 'skipped', skipReason: 'tmux session ended before the prime was pasted' });
        }
        return;
      }
      try {
        log.debug('Injecting prime prompt', { project: projectName, engine: engineId, length: primeText.length });
        tmux.sendKeys(tmuxName, primeText, { enter: true });
        log.debug('Prime prompt injected', { project: projectName });
        if (deliveryBase) {
          _recordRuleDelivery({ ...deliveryBase, channel: 'prime-paste', outcome: 'delivered' });
        }
      } catch (err) {
        log.warn('Failed to inject prime prompt', { project: projectName, error: err.message });
        if (deliveryBase) {
          _recordRuleDelivery({ ...deliveryBase, channel: 'prime-paste', outcome: 'skipped', skipReason: `tmux send-keys failed: ${err.message}` });
        }
      }
    }, delay);
  }
}

/**
 * Write the session prime to .tangleclaw/session-prime.md so the Claude Code
 * SessionStart hook can read it as hidden model context (#103). Non-throwing —
 * a failure here just falls back to a session that boots without prime context.
 * @param {string} projectPath - Absolute path to the project directory
 * @param {string} primeText - Full prime prompt text to write
 * @returns {string|null} - Absolute path to the written file, or null on failure
 */
function _writePrimeFile(projectPath, primeText) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(projectPath, '.tangleclaw');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'session-prime.md');
    fs.writeFileSync(filePath, primeText);
    log.debug('Wrote session prime file', { projectPath, length: primeText.length });
    return filePath;
  } catch (err) {
    log.warn('Failed to write session prime file', { projectPath, error: err.message });
    return null;
  }
}

/**
 * Remove the session-prime.md file written by `_writePrimeFile` (#103, chunk 3).
 * Called from `launchSession` whenever silentPrime is OFF, so a project that
 * had silent prime on, then turned it off, doesn't keep replaying stale prime
 * context through the SessionStart hook on subsequent launches.
 *
 * Non-throwing: a failure here is fine. The hook treats a missing file as a
 * no-op (silent exit 0), and a stale file at worst feeds an old prime — the
 * AI will reconcile against current state when the user types their first
 * message. Returns true on successful removal, false on missing/error.
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {boolean}
 */
function _removePrimeFile(projectPath) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const filePath = path.join(projectPath, '.tangleclaw', 'session-prime.md');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log.debug('Removed session prime file (silentPrime is off)', { projectPath });
      return true;
    }
  } catch (err) {
    log.warn('Failed to remove session prime file', { projectPath, error: err.message });
  }
  return false;
}

/**
 * Auto-start a session's Medusa listener when the project has opted into
 * session comms (MED-2K9P Chunk 02). Reads the per-project `medusaEnabled`
 * preference; when ON, starts the listener so inbound messages badge without a
 * manual banner toggle. The banner control remains the per-session override.
 *
 * Non-throwing: a listener failure (Bridge down, bad config) must never brick a
 * session launch — the failure surfaces later through the listener's own honest
 * status. Shared by the tmux and Web UI launch paths so neither leaks the pref.
 * @param {object} project - Project record (needs `path`, `name`).
 * @param {object} session - Started session record (needs `id`).
 * @param {string|null} [workspaceId] - Pre-minted workspace id (MED-2K9P v2 T1)
 *   from the tmux launch path, so the listener registers under the identity the
 *   prime already injected. The Web UI path passes none (no prime → mint fresh).
 * @returns {void}
 */
function _maybeAutoStartMedusa(project, session, workspaceId) {
  try {
    const projConfig = store.projectConfig.load(project.path);
    if (projConfig.medusaEnabled !== true) return;
    medusa.startSession({
      projectPath: project.path,
      sessionId: session.id,
      name: project.name,
      workspaceId: workspaceId || undefined
    });
    log.info('Auto-started Medusa listener (project opt-in)', { project: project.name, session: session.id });
  } catch (err) {
    log.warn('Failed to auto-start Medusa listener at launch', { project: project.name, error: err.message });
  }
}

/**
 * Re-sync Medusa listeners for every live session after a TC server restart
 * (TC#550, MED-2K9P v2 T4). Listeners are in-memory, so a restart silently
 * deregistered every running session from the Bridge — the whole switchboard
 * went dark until each session was relaunched or its pref re-toggled (the
 * TC#549 PATCH-sync was the manual heal). Same predicate as launch
 * (`medusaEnabled === true` + an active session); the registry reuses each
 * session's persisted workspace id, so identity is stable across the restart,
 * and ACK-on-read (TC#547) means the re-register redelivers only genuinely
 * unread mail.
 *
 * Non-throwing per project AND overall — a broken project record must never
 * block server startup or the other projects' re-sync.
 * @returns {{resynced: number}} How many listeners were started.
 */
function resyncMedusaListeners() {
  let resynced = 0;
  try {
    for (const project of store.projects.list()) {
      try {
        const active = store.sessions.getActive(project.id);
        if (!active) continue;
        const projConfig = store.projectConfig.load(project.path);
        if (projConfig.medusaEnabled !== true) continue;
        medusa.startSession({ projectPath: project.path, sessionId: active.id, name: project.name });
        resynced += 1;
        log.info('Re-synced Medusa listener after server restart', { project: project.name, session: active.id });
      } catch (err) {
        log.warn('Failed to re-sync Medusa listener for project', { project: project.name, error: err.message });
      }
    }
  } catch (err) {
    log.warn('Medusa listener boot re-sync aborted', { error: err.message });
  }
  return { resynced };
}

/**
 * Tear down a session's Medusa presence on session end (MED-2K9P Chunk 04):
 * stops its listener (closing the WS) and forgets its persisted workspace id so
 * the session is no longer addressable and a future session mints a fresh id.
 * Best-effort (medusa.forgetSession never throws); a no-op when project/session
 * is missing. Called from both end paths — explicit kill and wrap teardown.
 * @param {object|null} project - Owning project record (needs `path`), or null.
 * @param {object|null} session - The ending session record (needs `id`), or null.
 * @returns {void}
 */
function _teardownMedusa(project, session) {
  if (!project || !session) return;
  medusa.forgetSession({ projectPath: project.path, sessionId: session.id });
}

module.exports = {
  launchSession,
  launchWebuiSession,
  generatePrimePrompt,
  buildStartupRulesSection,
  _medusaContractSection,
  _writePrimeFile,
  _removePrimeFile,
  _maybeAutoStartMedusa,
  _teardownMedusa,
  resyncMedusaListeners,
  getSessionStatus,
  PRIME_MAX_TOKENS,
  _resolvePrimeBudget,
  detectIdle,
  clearIdleCache,
  injectCommand,
  peek,
  triggerWrap,
  getWrapRunStatus,
  getWrapPrStatus,
  completeWrap,
  autoCompleteWrap,
  parseWrapSummary,
  killSession,
  getSessionHistory,
  STALE_WRAPPING_THRESHOLD_MS,
  _buildLaunchCommand,
  _resolvePreKeys,
  _parseSqliteUtcMs,
  _wrapPaneCache
};
