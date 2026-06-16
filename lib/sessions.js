'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const tmux = require('./tmux');
const tunnel = require('./tunnel');
const git = require('./git');
const engines = require('./engines');
const gitHooks = require('./git-hooks');
const clawbridge = require('./clawbridge');
const methodologies = require('./methodologies');
const skills = require('./skills');
const wrapPipeline = require('./wrap-pipeline');
const projectVersion = require('./project-version');
const continuity = require('./continuity');
const sessionOwnership = require('./session-ownership');
const { unsafeReason } = require('./ssh-target-safety');
const { createLogger } = require('./logger');

const log = createLogger('sessions');

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

  // Check engine availability (for openclaw, SSH must be available)
  const det = engines.detectEngine(engineProfile);
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
  const methodologyPhase = projConfig.methodologyPhase || null;
  const silentPrime = projConfig.silentPrime === true
    && engineProfile.capabilities
    && engineProfile.capabilities.supportsSilentPrime === true;

  // Generate prime prompt
  let primeText = null;
  if (options.primePrompt !== false) {
    primeText = generatePrimePrompt(project, engineProfile);
  }

  // Silent prime delivery (#103): write the prime to .tangleclaw/session-prime.md
  // so the Claude Code SessionStart hook can cat it as hidden context. The
  // tmux send-keys path is skipped in _deferEngineInit when silentPrime is on.
  // When silentPrime is OFF, remove any leftover prime file so the hook (still
  // installed alongside other hooks via syncEngineHooks) doesn't read stale
  // context from a previous silent session — chunk 3 cleanup.
  if (silentPrime && primeText) {
    _writePrimeFile(project.path, primeText);
  } else {
    _removePrimeFile(project.path);
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

  // Regenerate engine config BEFORE launching (ensures engine reads
  // current methodology). #240 drift-aware write — the helper warns
  // when the on-disk file differs from regenerated content, surfacing
  // silent-clobber bugs. The helper itself handles "engine has no
  // config file" (openclaw, genesis) via `skipped: true`, so no
  // outer guard is needed; we only surface real `error` strings.
  const methodologyTemplate = store.templates.get(project.methodology);
  const writeResult = engines.writeEngineConfig(engineId, project.path, projConfig, engineProfile, methodologyTemplate);
  if (writeResult.error && !writeResult.written && !writeResult.skipped) {
    log.warn('Failed to write engine config', { error: writeResult.error });
  }

  // Sync engine hooks to match methodology (before launch so hooks are current)
  try {
    engines.syncEngineHooks(project.path, methodologyTemplate);
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
  const launchCmd = _buildLaunchCommand(engineProfile, project, options.launchMode);

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
      env: engineProfile.launch ? engineProfile.launch.env : {}
    });

    if (!created) {
      return { session: null, primePrompt: null, ttydUrl: null, error: `Failed to create tmux session "${tmuxName}"` };
    }
  } catch (err) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `tmux error: ${err.message}` };
  }

  // Record session in store immediately so the API can return fast
  const session = store.sessions.start({
    projectId: project.id,
    engineId,
    tmuxSession: tmuxName,
    primePrompt: primeText,
    methodologyPhase,
    launchMode: options.launchMode || engineProfile.defaultLaunchMode || null
  });

  log.info('Session launched', { project: projectName, engine: engineId, session: session.id, launchMode: options.launchMode || null });

  // Defer preKeys and prime prompt injection to a background timer so the API
  // returns instantly and the frontend can navigate to the session page while
  // the engine boots. The user sees the terminal immediately instead of staring
  // at a frozen launch button for ~6s.
  _deferEngineInit(tmuxName, projectName, engineId, engineProfile, primeText, options.launchMode || null, silentPrime);

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
  if (options.launchMode && conn.bridgePort && engineProfile.launchModes) {
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

  // Record session in store (no tmux session, mode = webui)
  const session = store.sessions.start({
    projectId: project.id,
    engineId,
    tmuxSession: null,
    primePrompt: null,
    methodologyPhase: null,
    sessionMode: 'webui',
    launchMode: options.launchMode || null
  });

  log.info('Web UI session launched', {
    project: projectName, engine: engineId, session: session.id, localPort: conn.localPort,
    launchMode: options.launchMode || null,
    bridgePreCreate: bridgePreCreate ? { ok: bridgePreCreate.ok, attached: bridgePreCreate.attached } : null
  });

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
 * Generate a prime prompt from methodology + project state + learnings + last session.
 * @param {object} project - Project record from store
 * @param {object} engineProfile - Engine profile
 * @returns {string}
 */
function generatePrimePrompt(project, engineProfile) {
  // Note (#102): the prime now carries only **session-dynamic state** —
  // things the AI cannot derive from CLAUDE.md or the engine's own banner.
  // Methodology name + description, current phase, archive paths,
  // extension-rule definitions, and shared-doc pointers are intentionally
  // omitted — all are already injected into the engine's config file
  // (CLAUDE.md / GEMINI.md / .codex.yaml / .aider.conf.yml) by
  // `lib/engines.js`, so duplicating them here was pure scrollback noise.
  // Project-version recording is also owned by TangleClaw (#101).
  const template = store.templates.get(project.methodology);
  const projConfig = store.projectConfig.load(project.path);
  const sections = [];

  // Header — kept for branding + project anchor
  sections.push(`# Session Start — ${project.name}`);
  sections.push("*TangleClaw'd into existence.*");
  sections.push('');

  // Session ownership identity (#347 Slice 3). Inject the owned-project
  // identity early so a consumer (#340 scope guard) reads a reliable "what do
  // I own" fact from hidden prime context. Identity only — the wrong-tab
  // flagging behavior is #340's, not this primitive's.
  sections.push(...sessionOwnership.primeSection(project));

  // Active learnings — project state, not in CLAUDE.md
  try {
    const learnings = store.learnings.getActive(project.id);
    if (learnings.length > 0) {
      sections.push('## Active Learnings');
      for (const learning of learnings) {
        sections.push(`- ${learning.content}`);
      }
      sections.push('');
    }
  } catch {
    // Learnings might not be available — skip
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
  // when no index exists yet (older sessions / non-continuity methodologies).
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
    sections.push('');
    sections.push('Your first turn:');
    sections.push(
      '1. Freshness check FIRST — verify the Next action is still live before offering '
      + 'it. Cheap checks: is any referenced issue still open (`gh issue view <N>`)? Has '
      + 'the branch merged? Does the named artifact still exist? Compare HEAD to the '
      + 'written-at sha above.'
    );
    sections.push(
      "2. Emit one visible message, leading with the banner `*TangleClaw'd into "
      + "existence.*`, then \"We left off at <X>. Next: <Y>.\" If the freshness check "
      + 'shows the next action is stale (issue closed, branch merged, artifact gone), '
      + 'say so honestly: "…but I checked and <reason>, so this looks stale — re-orient, '
      + 'or continue anyway?"'
    );
    sections.push('3. Wait for the operator\'s go. Do not auto-execute the next action.');
    sections.push('');
  } else {
    const lastSession = store.sessions.getLatest(project.id);
    if (lastSession && lastSession.wrapSummary) {
      sections.push('## Last Session Summary');
      sections.push(lastSession.wrapSummary);
      sections.push('');
    }
  }

  // Feature Index injection (#207, chunk 2). Symmetric gate (ADR 0001):
  // all three of {project toggle, project silentPrime, engine capability}
  // must be true. Asymmetric gates leak orphan state — feedback_symmetric_capability_gates.
  // FEATURES.md lives at the project root and is git-tracked; the
  // template-stub is seeded by `_seedFeatureIndexFile` on toggle-on (chunk 1).
  if (projConfig.featureIndexEnabled === true
      && projConfig.silentPrime === true
      && engineProfile
      && engineProfile.capabilities
      && engineProfile.capabilities.supportsSilentPrime === true) {
    try {
      const featuresPath = path.join(project.path, 'FEATURES.md');
      const contents = fs.readFileSync(featuresPath, 'utf8');
      const trimmed = contents.trim();
      if (trimmed.length > 0) {
        sections.push('## Feature Index');
        sections.push(trimmed);
        sections.push('');
      }
    } catch {
      // Missing or unreadable FEATURES.md — skip silently. Index is opt-in
      // scaffolding; absence should never block session start.
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
      sections.push('## Eval Audit Mode: Active');
      sections.push('Exchanges are being scored for governance compliance.');
      const lines = [
        `- Judge model: ${ac.judgeModel || 'claude-haiku-4-5'}`,
        '- Tiers: Structural (Tier 1), Semantic (Tier 2), Thinking Analysis (Tier 2.5), Behavioral (Tier 3)',
        `- Sampling: ${ac.sampling && ac.sampling.enabled !== false ? `enabled (routine interval: ${ac.sampling.routineInterval || 3})` : 'disabled'}`,
        `- Cost cap: $${(ac.costCapPerSession || 1.00).toFixed(2)}/session`
      ];
      if (openIncidents > 0) {
        lines.push(`- Open incidents: ${openIncidents}`);
      }
      sections.push(lines.join('\n'));
      sections.push('');
    }
  } catch {
    // Eval audit info might not be available — skip
  }

  let prompt = sections.join('\n');

  // Respect maxTokens from template prime config (rough character estimate)
  if (template && template.prime && template.prime.maxTokens) {
    const maxChars = template.prime.maxTokens * 4; // rough token-to-char ratio
    if (prompt.length > maxChars) {
      prompt = prompt.slice(0, maxChars) + '\n\n[Prime prompt truncated]';
    }
  }

  return prompt;
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
 * @param {string} projectName - Project name
 * @param {string} command - Text to inject
 * @param {object} [options]
 * @param {boolean} [options.enter] - Send Enter after text (default true)
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

  const active = store.sessions.getActive(project.id);
  if (!active) {
    return { ok: false, error: `No active session for "${projectName}"` };
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
 * V2 wrap path — invoke the server-side pipeline runner instead of the
 * legacy NL-prompt-via-tmux flow. Gated by `projConfig.wrapV2`, which
 * defaults to `true` since #139 Chunk 11c; projects with an explicit
 * `wrapV2: false` on disk continue on the legacy path. On a successful
 * pipeline run that produced a commit, the session record is
 * transitioned to `wrapped` + tmux is killed + doc locks are released
 * (#139 Chunk 11a). Halted / thrown / clean-session (ok + null SHA)
 * paths leave the session active so the user can retry or continue.
 * @param {object} project - Project record
 * @param {object} active - Active Session record (already verified non-null)
 * @param {object} [options] - Per-wrap user choices forwarded to the runner
 *   (e.g. `{skipTests, criticSkipRationale, prHandling}`). Chunk 10 collects
 *   these from the multi-step drawer on retry after a blocked step.
 * @returns {Promise<object>} Same outer shape as the legacy path plus a
 *   `pipelineResult` field carrying the runner's structured output.
 */
async function _triggerWrapV2(project, active, options) {
  // Re-record project version (#101) — same pre-wrap snapshot the
  // legacy path takes. Keeps version cache freshness symmetric across
  // the V1/V2 split.
  projectVersion.recordVersion(project.path);

  let pipelineResult;
  try {
    pipelineResult = await wrapPipeline.runWrapPipeline(project.name, options);
  } catch (err) {
    log.error('Wrap pipeline threw', { project: project.name, error: err.message });
    return {
      ok: false,
      sessionId: active.id,
      wrapCommand: null,
      wrapSteps: [],
      captureFields: [],
      pipelineResult: null,
      error: `wrap pipeline threw: ${err.message}`
    };
  }

  // Synthesize legacy shape for back-compat with the existing frontend
  // poller — surfaces the pipeline's step IDs so the wrapping UI still
  // shows something coherent until the multi-step drawer lands.
  const wrapSteps = pipelineResult.results.map((r) => r.stepId);
  const wrapShape = skills.getWrapSkill(project.methodology);
  const captureFields = wrapShape ? wrapShape.captureFields : [];

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

  return {
    ok: pipelineResult.ok,
    sessionId: active.id,
    // No tmux command sent in V2 — the runner is server-side.
    wrapCommand: null,
    wrapSteps,
    captureFields,
    pipelineResult,
    error: pipelineResult.error
  };
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

  // Defense-in-depth: `triggerWrap`'s entry-point pre-check rejects
  // sessions without `tmuxSession`, so this branch is unreachable via
  // the normal V2 flow. Kept so the helper stays safe to call from
  // future callers (tests, future server-side invocations) without
  // tying correctness to an external precondition.
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
 * Trigger the session wrap skill. Sends the wrap command and returns immediately.
 * The frontend polls status to detect completion.
 *
 * Async since #139 Chunk 3 so the V2 opt-in path (which awaits the
 * server-side pipeline runner) returns a uniform shape. Callers must
 * `await` regardless of which path runs; the legacy NL-prompt path
 * still completes synchronously inside the awaited Promise.
 *
 * @param {string} projectName - Project name
 * @param {object} [options] - V2-only. Per-wrap user choices forwarded to
 *   the pipeline runner (`{skipTests, criticSkipRationale, prHandling}`).
 *   Ignored on the legacy V1 NL-prompt path. Chunk 10 collects these from
 *   the multi-step drawer on retry after a blocked step.
 * @returns {Promise<{ ok: boolean, sessionId: number|null, wrapCommand: string|null, wrapSteps: string[], captureFields: string[], pipelineResult?: object, error: string|null }>}
 */
async function triggerWrap(projectName, options) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { ok: false, sessionId: null, wrapCommand: null, wrapSteps: [], captureFields: [], error: `Project "${projectName}" not found` };
  }

  // #334 — gate on session existence only, NOT on `tmuxSession`. WebUI/OpenClaw
  // sessions are recorded with `tmuxSession: null` by design; the server-side
  // V2 wrap pipeline below is tmux-free, so they must reach it instead of being
  // rejected here. The legacy NL-prompt path (further down) DOES need a tmux
  // pane and is guarded separately.
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return { ok: false, sessionId: null, wrapCommand: null, wrapSteps: [], captureFields: [], error: `No active session for "${projectName}"` };
  }

  // #139 Chunk 11c — `wrapV2` defaults `true`; the V2 server-side
  // pipeline is the default wrap path. Projects with an explicit
  // `wrapV2: false` on disk fall through to the legacy NL-prompt
  // branch below. The strict-equality check (`=== true`) keeps the
  // gate conservative — only the literal boolean `true` routes to V2,
  // so a wrong-type config (e.g. `"true"` string, numeric `1`) safely
  // falls through to legacy until the operator notices.
  const projConfig = store.projectConfig.load(project.path);
  if (projConfig && projConfig.wrapV2 === true) {
    // V2 is server-side + tmux-free, so a webui session (null tmux) wraps here (#334).
    return _triggerWrapV2(project, active, options);
  }

  // #334 — the legacy NL-prompt wrap drives the AI via `tmux.sendKeys` below,
  // so it genuinely requires a tmux pane. A webui/OpenClaw session has none —
  // return a clear, actionable error instead of crashing on `sendKeys(null, …)`.
  // (The V2 branch above already handles the webui case.)
  if (!active.tmuxSession) {
    return { ok: false, sessionId: active.id, wrapCommand: null, wrapSteps: [], captureFields: [], error: `WebUI/non-tmux session for "${projectName}" requires the V2 wrap pipeline (set wrapV2:true); the legacy wrap needs a tmux pane.` };
  }

  // Get methodology wrap config
  const wrapSkill = skills.getWrapSkill(project.methodology);
  let wrapSteps = [];
  let captureFields = [];
  let customCommand = null;

  if (wrapSkill) {
    customCommand = wrapSkill.command || null;
    wrapSteps = wrapSkill.steps;
    captureFields = wrapSkill.captureFields;
  }

  // Build wrap instruction — use custom command if set, otherwise natural language prompt
  let fullCommand;
  if (customCommand) {
    fullCommand = customCommand;
    if (wrapSteps.length > 0) {
      fullCommand += `\nWrap steps: ${wrapSteps.join(', ')}`;
    }
    if (captureFields.length > 0) {
      fullCommand += `\nOutput these fields as ## headings: ${captureFields.join(', ')}`;
    }
  } else {
    fullCommand = 'Perform a session wrap. Commit all uncommitted work, then output a wrap summary.';
    if (wrapSteps.length > 0) {
      fullCommand += `\nWrap steps: ${wrapSteps.join(', ')}`;
    }
    if (captureFields.length > 0) {
      fullCommand += `\nOutput these fields as ## markdown headings: ${captureFields.join(', ')}`;
    }
  }

  // Re-record project version (#101) — captures the pre-wrap state. The next
  // session launch will record again, capturing any version bump the wrap
  // itself produced (e.g., CHANGELOG promotion or git tag). Non-blocking.
  projectVersion.recordVersion(project.path);

  const wrapCommand = customCommand || 'session-wrap';

  // Send wrap command to the session
  try {
    tmux.sendKeys(active.tmuxSession, fullCommand, { enter: true });
  } catch (err) {
    return { ok: false, sessionId: active.id, wrapCommand, wrapSteps, captureFields, error: `Failed to send wrap command: ${err.message}` };
  }

  // Transition to wrapping status
  store.sessions.setWrapping(active.id);

  log.info('Wrap triggered', { project: projectName, session: active.id, command: wrapCommand });

  return {
    ok: true,
    sessionId: active.id,
    wrapCommand,
    wrapSteps,
    captureFields,
    error: null
  };
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

  // Get capture fields from methodology
  const wrapSkill = skills.getWrapSkill(project.methodology);
  const captureFields = wrapSkill ? wrapSkill.captureFields : [];

  const summary = parseWrapSummary(rawOutput, captureFields);
  const wrapped = store.sessions.wrap(session.id, summary);

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
      wrapSummary: s.wrapSummary,
      methodologyPhase: s.methodologyPhase
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

  // Append launch mode args if a valid mode is specified
  if (launchMode && engineProfile.launchModes && engineProfile.launchModes[launchMode]) {
    const modeArgs = engineProfile.launchModes[launchMode].args;
    if (modeArgs && modeArgs.length > 0) {
      cmd += ' ' + modeArgs.join(' ');
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
  const modeConfig = (launchMode && engineProfile.launchModes && engineProfile.launchModes[launchMode]) || null;

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
 */
function _deferEngineInit(tmuxName, projectName, engineId, engineProfile, primeText, launchMode, silentPrime) {
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
      if (!tmux.hasSession(tmuxName)) return; // session died — bail
      try {
        log.debug('Injecting prime prompt', { project: projectName, engine: engineId, length: primeText.length });
        tmux.sendKeys(tmuxName, primeText, { enter: true });
        log.debug('Prime prompt injected', { project: projectName });
      } catch (err) {
        log.warn('Failed to inject prime prompt', { project: projectName, error: err.message });
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

module.exports = {
  launchSession,
  launchWebuiSession,
  generatePrimePrompt,
  _writePrimeFile,
  _removePrimeFile,
  getSessionStatus,
  detectIdle,
  clearIdleCache,
  injectCommand,
  peek,
  triggerWrap,
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
