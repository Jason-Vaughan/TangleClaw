'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tcProjectFiles = require('./tangleclaw-project-files');
const store = require('./store');
const tmux = require('./tmux');
const tunnel = require('./tunnel');
const engines = require('./engines');
const gitHooks = require('./git-hooks');
const clawbridge = require('./clawbridge');
const wrapSentinel = require('./wrap-sentinel');
const wrapPipeline = require('./wrap-pipeline');
const wrapDefaultPipeline = require('./wrap-default-pipeline');
const wrapRunRegistry = require('./wrap-run-registry');
const handoffPublish = require('./handoff-publish');
const wrapPrStatus = require('./wrap-pr-status');
const projectVersion = require('./project-version');
const launchBaseline = require('./launch-baseline');
const projectHeal = require('./project-heal');
const continuity = require('./continuity');
const orchestration = require('./orchestration');
const medusa = require('./medusa');
const sessionOwnership = require('./session-ownership');
const ecosystemPrimer = require('./ecosystem-primer');
const { unsafeReason } = require('./ssh-target-safety');
const { countCuratedEntries, countTodoEntries } = require('./feature-index-prime');
const rulesChannel = require('./session-rules-channel');
const medusaWake = require('./medusa-wake');
const engineErrors = require('./engine-errors');
const { createLogger } = require('./logger');
const ciStatus = require('./ci-status');
const projectConfig = require('./project-config');
const strandedWraps = require('./stranded-wraps');
const strandedCheck = require('./stranded-check');
const { METHODOLOGY_OWNED_TOPICS } = require('./methodology-topics');
const { createConditionLog } = require('./condition-log');
const planDocs = require('./plan-docs');
const launchSequence = require('./launch-sequence');
const launchPreflight = require('./launch-preflight-context');
const preflightEngine = require('./launch-preflight');

const log = createLogger('sessions');

// The session page polls `getSessionStatus` continuously, so a pane nobody can
// reach produces its "could not establish" line at the poll's cadence rather
// than the condition's. Keyed PER SESSION, not globally: one unreachable pane
// must not silence the first report about a different one.
const conditionLog = createConditionLog(log);

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

/**
 * How many plan files the task step names before pointing at the plans route
 * for the rest. The route lists them all; the step only has to show where they are.
 * @type {number}
 */
const PLAN_POINTER_LIMIT = 10;

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
 * @param {string|null} [options.operatorHost] - Host the operator reached this server on, from
 *   their own launch request (see sessionOwnership.resolveOperatorHost). Omitted on launches with
 *   no request behind them (CLI, scheduler), which fall back to probing this machine.
 * @param {string|null} [options.owner] - Signed-in user launching; also recorded on any
 *   stranded-wrap acknowledgement this launch makes
 * @param {Array<{remote: string|null, branch: string, headSha: string|null}>} [options.acknowledgeStranded] -
 *   Stranded wraps to acknowledge before the gate is checked (#1539)
 * @returns {{ session: object|null, primePrompt: string|null, ttydUrl: string, error: string|null,
 *   code?: string, items?: object[] }} `code: 'STRANDED_WRAPS'` with the blocking `items` when
 *   unacknowledged stranded wraps hold the launch; an acknowledgement failure carries its own code.
 *   `strandedUnchecked` is the reason the stranded-wrap check was skipped (the records could not be
 *   read), or null when it ran. When tmux started but the session row could not be written, `code`
 *   is `LAUNCH_BIND_FAILED` (the pane was stopped) or `ORPHANED_LAUNCH` (it could not be stopped).
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
    // Same rule as the status read: this branch RECORDS a death, so it may only
    // run on an observed one. A tmux too wedged to answer would otherwise have
    // the operator's running session written off as crashed and a second one
    // launched over it — and the launch itself would then fail anyway, because
    // creating a session needs the same server that just would not reply. An
    // honest refusal beats a mangled record plus an obscure failure.
    const probe = existing.tmuxSession ? tmux.probeSession(existing.tmuxSession) : null;
    if (probe && !probe.answered) {
      // Logged, because this is the one refusal an operator can hit repeatedly
      // with nothing else recording it: the status read's equivalent branch logs,
      // and every other launch failure here is either an ordinary state or ends
      // up in the activity log. A refusal that appears only in one HTTP response
      // leaves no trace of how often the wedge is happening.
      log.warn('Refused to launch — could not establish whether a session is already running',
        { project: projectName, session: existing.id, cause: probe.cause });
      return {
        session: null,
        primePrompt: null,
        ttydUrl: null,
        // The condition travels as a VALUE. The launch route classifies failures
        // by matching substrings of this sentence, so a refusal with prose alone
        // falls through to 500 INTERNAL_ERROR — which is doubly wrong here:
        // nothing internal failed, and nothing changed. Rewording a message must
        // not be able to change a status code (`scanDirectoryForProjects` learned
        // the same lesson when a reworded sentence removed a button).
        code: 'LIVENESS_UNKNOWN',
        error: `Could not determine whether "${projectName}" already has a session running — `
          + 'tmux did not answer. Nothing was changed. Check the tmux server '
          + '(`tmux ls`) and try again.'
      };
    }
    // If tmux is dead, clean up the stale session instead of blocking
    if (probe && !probe.live) {
      store.sessions.markCrashed(existing.id, 'tmux session died');
      // A crashed session's Medusa listener is owned by the TC SERVER process,
      // not by the agent, so nothing about the session dying closes it (#836).
      // It keeps heartbeating and the roster keeps reporting the workspace
      // `connected: true` — one observed leak stayed live 45 hours past its
      // session's death, and peers addressing it queued messages into nothing.
      _teardownMedusa(project, existing);
      clearIdleCache(existing.tmuxSession);
      log.warn('Cleaned up stale active session before launch', { project: projectName, session: existing.id });
    } else {
      return { session: null, primePrompt: null, ttydUrl: null, error: `Session already active for "${projectName}"` };
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

  // Stranded wraps (#1539): a wrap branch pushed with no pull request, that
  // nobody has acknowledged, holds the launch. Checked after every refusal that
  // changes nothing and before the first write below, so a refused launch
  // leaves the project exactly as it was, and before the web-UI branch so both
  // launch paths are gated. The request may acknowledge the items in the same
  // call; those acknowledgements are recorded as the launching user's.
  const strandedGate = strandedWraps.launchGate(project, {
    acknowledge: options.acknowledgeStranded,
    by: options.owner || null
  });
  if (!strandedGate.ok) {
    return {
      session: null,
      primePrompt: null,
      ttydUrl: null,
      code: strandedGate.code,
      items: strandedGate.items,
      error: strandedGate.error
    };
  }

  // The handoff preflight (#1586), beside the stranded gate and before the first
  // write below, for the same reason that gate sits here: everything above this
  // point either refuses without changing anything or changes nothing, so a
  // refused launch leaves the project exactly as it was.
  //
  // It is the one thing here that MAY write — a repair publishes a handoff whose
  // wrap staged it and then died before the rename. That write is deliberately
  // ahead of `launchBaseline.capture` below, so the file it moves is not counted
  // as this session's own change and put in front of the operator at wrap.
  //
  // `workspaceId` is null, and that is a statement rather than an omission.
  // `medusa.mintWorkspaceId` draws fresh random bytes on every launch, so the id
  // this launch would carry is not the id the previous session recorded and
  // never can be — comparing them would report `identity-mismatch` on every
  // launch of every Medusa project. The identity check's `projectId` half is
  // exact and does the real work; the workspace half has nothing stable to
  // compare against on the launching side. Tracked as #1611.
  const preflightResult = launchPreflight.evaluate(project, { workspaceId: null });

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
      return { session: null, primePrompt: null, ttydUrl: null, error: null, webui: true, _conn: conn, _engineId: engineId, _engineProfile: engineProfile, _project: project, strandedUnchecked: strandedGate.unchecked || null };
    }
  }

  // The launch baseline (#1309, #1406): HEAD and the already-dirty files, taken
  // BEFORE anything below writes to the project. A file TangleClaw regenerates for
  // this launch (the engine config guide, the version record) is then this
  // session's change, not "dirty before the session started" — which is what would
  // otherwise put it in front of the operator for approval at every wrap.
  const baseline = launchBaseline.capture(project.path);

  // Heal TangleClaw's own footprint (#1511): move a leftover wrap boundary out of
  // project.json and list the state files in the clone's local git exclude. After
  // the baseline, like every other launch write, so what it changes is judged as
  // TangleClaw's. It never commits and never throws.
  const heal = projectHeal.healOnLaunch(project.path);

  // Record project version (#101) — TangleClaw is now the writer of
  // `.tangleclaw/project-version.txt`; this used to be delegated to the AI
  // via prime-prompt instructions. Failure is non-blocking.
  projectVersion.recordVersion(project.path);

  // Load project config early — needed to decide silent-prime delivery (#103)
  // before we generate the prime, so we can write the prime to disk for the
  // SessionStart hook to read instead of pasting into the terminal.
  const projConfig = store.projectConfig.load(project.path);
  const silentPrimeDisposition = engines.silentPrimeDisposition(projConfig, engineProfile);
  const silentPrime = silentPrimeDisposition === 'on';
  // Say so when the setting does not apply here (#741). Before this the
  // capability gate fell through in silence, and "Codex sessions behave
  // differently" was the only way the operator could learn that the setting
  // means nothing on this engine. The settings modal is where the operator is
  // told in words; this is the record behind it, and its LEVEL is the
  // disposition's to decide — a stored value indistinguishable from the shipped
  // default was set by nobody and records at info, while a value the operator
  // actually chose is real intent being dropped and warns.
  if (silentPrimeDisposition === 'not-applicable') {
    const drop = engines.settingDisposition('silentPrime', projConfig, engineProfile);
    log[drop.level]('silentPrime does not apply on this engine — neither honored nor offered', {
      project: projectName,
      engine: baseEngineId,
      setting: 'silentPrime',
      reason: drop.reason,
      evidence: drop.evidence
    });
  }

  // Launch-mode posture: an explicit caller choice always wins; otherwise the
  // project's configured default applies. Resolving here (server-side) makes
  // the setting real for every tmux-path caller — the landing page's
  // hidden-picker direct launch, ClawBridge, and raw API POSTs alike. (OpenClaw
  // web-UI launches return through the `webui: true` branch above and keep
  // their existing explicit-mode-only bridge contract — openclaw is
  // picker-hidden anyway, #459.) 'default' adds no CLI args downstream, so
  // leaving launchMode unset for it preserves the pre-setting launch command
  // byte-for-byte. The usability guard keeps a stale key (e.g. after an engine
  // switch) or a disabled mode from reaching _buildLaunchCommand — degraded but
  // functional, so it records rather than failing the launch, at the level the
  // disposition derives: a mode the operator chose and lost warns; a value that
  // is only the shipped default records at info.
  if (!options.launchMode) {
    const drop = engines.settingDisposition('defaultLaunchMode', projConfig, engineProfile);
    if (drop.applies && drop.chosen) {
      options = { ...options, launchMode: projConfig.defaultLaunchMode };
    } else if (!drop.applies) {
      log[drop.level]('Configured defaultLaunchMode is not usable for this engine — launching with the engine default', {
        project: projectName,
        engine: baseEngineId,
        mode: drop.value,
        reason: drop.reason,
        evidence: drop.evidence
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
  // Train 21: does this launch get a `tc start` sequence? Decided before the
  // prime is rendered, because the prime names the sequence only when there is
  // one. A launch with its prime disabled asked for no startup context at all,
  // so it gets none by pull either.
  const sequenceApplicability = launchSequence.resolveApplicability(
    engineProfile,
    options.primePrompt === false ? 'the prime prompt is disabled for this launch' : null
  );
  const primeOptions = { medusaWorkspaceId, startupRules, continuityMode: options.continuityMode, operatorHost: options.operatorHost, healReport: heal.report };
  if (options.primePrompt !== false) {
    primeText = generatePrimePrompt(project, engineProfile, { ...primeOptions, launchSequence: sequenceApplicability.applicable });
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
  // silent-clobber bugs. A `skipped: true` for an engine with no config file
  // is not an error and needs nothing here: the helper reports that case
  // itself, so no caller has to remember to.
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

  // Train 21: render and freeze the launch steps now, after every file the
  // manifest hashes has been regenerated. The snapshot is bound to the session
  // row further down, in the same transaction that creates it.
  const launchId = launchSequence.mintLaunchId();
  const snapshot = _buildLaunchSnapshot(launchId, project, engineProfile, sequenceApplicability, startupRules, primeOptions, preflightResult);

  // The prime was rendered before the snapshot existed, so it committed to a
  // rules carrier on the ASSUMPTION that this launch would get a sequence. If
  // building the snapshot degraded it to not-applicable, that assumption is now
  // false — and a prime that points at the sequence would send the session to a
  // channel it does not have, with its rules on no channel at all. Rendered
  // again, with the rules where they can actually be read.
  if (primeText && sequenceApplicability.applicable && snapshot.applicability !== 'applicable') {
    log.warn('Re-rendering the prime: this launch got no sequence after all, so the rules are pasted', {
      project: projectName, reason: snapshot.notApplicableReason
    });
    primeText = generatePrimePrompt(project, engineProfile, { ...primeOptions, launchSequence: false });
    if (silentPrime && primeText) primeFilePath = _writePrimeFile(project.path, primeText);
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

  // Ambient-awareness floor (Chunk 02): every launched pane gets `tc` on PATH
  // plus the identity env the CLI needs — the one substrate every engine
  // shares is a shell, so a new engine works on day one with no adapter and no
  // context filename to guess. Engine-profile env wins on a key collision:
  // a profile that deliberately sets one of these is making a decision, and
  // the floor must not silently override it. The env prepend alone is NOT the
  // whole floor: rc processing (macOS path_helper + user rc) rebuilds PATH
  // before the launch command runs and drops it — the risk Chunk 02 accepted,
  // which then fired fleet-wide (#1140). `_withPathFloor` re-asserts the
  // prepend inside the command body, after rc files; this env entry stays as
  // the floor for shells that don't clobber and for bare interactive panes.
  const ambientEnv = {
    PATH: `${path.join(__dirname, '..', 'bin')}:${process.env.PATH || ''}`,
    TANGLECLAW_PROJECT_ID: String(project.id)
  };
  // Omitted, never faked: an unresolvable origin must not become a
  // sentence-shaped URL in the pane — `tc` reports a missing TANGLECLAW_API
  // loudly, which is the honest failure.
  const apiOrigin = _apiOrigin();
  if (apiOrigin) ambientEnv.TANGLECLAW_API = apiOrigin;
  if (medusaWorkspaceId) ambientEnv.TANGLECLAW_WORKSPACE_ID = medusaWorkspaceId;
  // The session id does not exist yet (the row is written after tmux starts),
  // and a running process never sees a later tmux env change. The launch id is
  // what `tc start` presents instead; the server resolves it once the row is bound.
  ambientEnv.TANGLECLAW_LAUNCH_ID = launchId;

  try {
    const created = tmux.createSession(tmuxName, {
      cwd: project.path,
      command: _withPathFloor(launchCmd),
      env: { ...ambientEnv, ...(launchProfile.launch ? launchProfile.launch.env : {}) }
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

  let session;
  try {
    session = store.sessions.start({
      projectId: project.id,
      engineId,
      tmuxSession: tmuxName,
      primePrompt: primeText,
      launchMode: effectiveMode,
      owner: options.owner || null,  // the signed-in TangleClaw user; null when no login is required
      launchBaseline: baseline,
      launchSequence: snapshot
    });
  } catch (err) {
    // The pane is running and no session row exists for it. Left alone it
    // would be an engine nobody can see, wrap or kill from the dashboard.
    return _abandonUnboundLaunch(project, tmuxName, err);
  }

  // Which channel this launch's rule TEXT rode, derived ONCE and read by
  // everything that reports it: the log entry below, and the ledger row further
  // down. It is the same function `_collectPrimeSections` rendered from, so the
  // block that shipped and the row that records it cannot disagree.
  const rulesCarrier = resolveRulesCarrier({
    projConfig, engineProfile, pull: false, hasSequence: snapshot.applicability === 'applicable'
  });

  log.info('Session launched', {
    project: projectName, engine: engineId, session: session.id, launchMode: effectiveMode,
    // Whether this session can pull its context, and why not when it cannot: a
    // launch that got no sequence is otherwise indistinguishable from one that
    // did until somebody runs `tc start`.
    launchSequence: snapshot.applicability,
    launchSequenceReason: snapshot.notApplicableReason || undefined,
    // Which channel this launch's rule TEXT actually rode. Recorded on the one
    // entry that fires per launch rather than as a line of its own, so nothing
    // has to re-derive the decision to report it: a project that asked for
    // `pull` and got `prime` reads that here, and it is otherwise
    // indistinguishable from a project that never set the setting.
    rulesCarrier
  });

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
  // #1063 — clear any receipt token a PREVIOUS launch left, before deciding
  // this launch's outcome. Only the rules-hook success branch below writes one,
  // and it does so after this; every other path therefore leaves no token,
  // exhaustively, without a `clear` call of its own. Placed here rather than in
  // each branch because a token that outlives its launch points at another
  // session's row, and one branch forgetting its own clear is how that happens.
  rulesChannel.clearReceiptToken(project.path);

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
      // #1063 — `written`, not `delivered`. The shards are on disk; nothing has
      // yet shown that any engine read them. Recording `delivered` here is a
      // claim about the filesystem wearing the name of a claim about the
      // engine, and #759 is what that costs: every Claude SessionStart hook
      // failed across multiple sessions and two projects, every session booted
      // with no rules, and the ledger stayed clean throughout. The hook posts a
      // receipt when it actually runs (`POST /api/tc/rule-receipt`) and THAT
      // upgrades the row.
      const written = _recordRuleDelivery({ ...deliveryBase, channel: 'rules-hook', outcome: 'written' });
      // The token is what lets the hook name the row it is vouching for. No
      // token (record failed, or no API origin to post to) means the row simply
      // stays `written` — an honest unknown, which is the whole point; it must
      // never fall back to claiming delivery.
      const receiptApi = _apiOrigin();
      if (written && written.id && receiptApi) {
        rulesChannel.writeReceiptToken(project.path, { deliveryId: written.id, api: receiptApi });
      } else {
        log.warn('No rules-hook receipt token written — this delivery cannot be confirmed and will stay `written`', {
          project: project.name,
          reason: written && written.id ? 'no resolvable API origin for the hook to post to' : 'the delivery row was not recorded'
        });
      }
    } else {
      _recordRuleDelivery({
        ...deliveryBase, channel: 'rules-hook', outcome: 'skipped',
        skipReason: 'no rule shards were written for a project that has active rules'
      });
    }
  } else if (!supportsPaste) {
    _recordRuleDelivery({ ...deliveryBase, channel: 'none', outcome: 'skipped', skipReason: `engine ${engineId} declares no prime channel (supportsPrimePrompt is false)` });
  } else if (rulesCarrier === 'pull-pointer') {
    // The prime carried a POINTER, not the rules (#1584). Recording the paste
    // as a rule delivery would put the rule digest on a row saying `delivered`
    // for text that was never sent — the claim Direction §4 forbids, and the
    // one thing this ledger exists to catch. The skip is the honest row; the
    // sequence's own record answers whether the rules were read.
    _recordRuleDelivery({
      ...deliveryBase, channel: 'none', outcome: 'skipped',
      skipReason: store.RULES_SERVED_BY_LAUNCH_SEQUENCE
    });
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
  // `null` for a pointer paste: the paste still happens (it carries the rest of
  // the prime), and it has nothing to say about rule delivery, so it must not
  // write a rules row at all — the launch recorded the honest one above.
  _deferEngineInit(tmuxName, projectName, engineId, engineProfile, primeText, effectiveMode, silentPrime,
    rulesCarrier === 'pull-pointer' ? null : deliveryBase);

  return {
    session,
    primePrompt: primeText,
    ttydUrl: '/terminal/',
    error: null,
    strandedUnchecked: strandedGate.unchecked || null
  };
}

/**
 * Build the launch snapshot, degrading to a not-applicable sequence when the
 * steps cannot be rendered. A launch never fails on this: the prime still goes
 * out, and `tc start next` answers with the reason instead of a sequence.
 * @param {string} launchId - The minted launch id
 * @param {object} project - Project record
 * @param {object} engineProfile - Engine profile
 * @param {{applicable: boolean, reason: string|null}} applicability - Whether this launch has a sequence
 * @param {{rules: object[]}} startupRules - The rules the prime was built from
 * @param {object} primeOptions - The options the prime was rendered with
 * @param {object} [preflightResult] - From `launchPreflight.evaluate`; the verdict step 3 states
 * @returns {object} The `launchSequence` argument of `store.sessions.start`
 */
function _buildLaunchSnapshot(launchId, project, engineProfile, applicability, startupRules, primeOptions, preflightResult) {
  const rules = startupRules.rules || [];
  // Only the three fields a reader of the sequence needs are stored. The
  // evidence and repair outcomes are launch-time diagnosis and already logged;
  // freezing them into every launch record would grow it without answering a
  // question anything asks of it later.
  const preflight = _storedPreflight(preflightResult);
  try {
    const rendered = applicability.applicable
      ? renderLaunchSteps(project, engineProfile, { ...primeOptions, preflight })
      : null;
    // The launch-time-only inputs, recorded with the snapshot so a rule change
    // mid-launch re-renders the same steps rather than a version missing the
    // facts only the launch had. `startupRules` is deliberately NOT among them:
    // a revision exists precisely because the rules changed, so it reads them
    // afresh (Train 21 §2.2).
    const renderContext = {
      medusaWorkspaceId: primeOptions.medusaWorkspaceId || null,
      continuityMode: primeOptions.continuityMode || null,
      operatorHost: primeOptions.operatorHost || null,
      healReport: primeOptions.healReport || null
    };
    return launchSequence.buildSnapshot({ launchId, project, engineProfile, applicability, rendered, rules, preflight, renderContext });
  // prawduct:allow prawduct/broad-except -- a launch must survive a failure to render its launch steps
  } catch (err) {
    log.warn('Launch steps could not be built — the session launches without a sequence', {
      project: project.name, error: err.message
    });
    return {
      launchId,
      pageBudget: launchSequence.MIN_PAGE_BUDGET,
      applicability: 'not-applicable',
      notApplicableReason: `the launch steps could not be built (${err.message})`,
      // The verdict stands even though the steps could not be rendered: it was
      // decided before this, and downgrading it to `not-evaluated` here would
      // discard a real answer and report that nothing was checked.
      preflight,
      sourceManifest: { error: err.message },
      steps: []
    };
  }
}

/**
 * The preflight fields a launch record keeps.
 *
 * `requiresReconciliation` is stored rather than recomputed because the
 * reconciliation demand must describe the verdict this launch's step 3 actually
 * stated. Recomputing it later from a rebuilt result would let a changed
 * classification rewrite what a session was already told.
 *
 * @param {object} [result] - From `launchPreflight.evaluate`
 * @returns {{verdict: string, reason: string, requiresReconciliation: boolean}}
 */
function _storedPreflight(result) {
  if (!result || typeof result.verdict !== 'string') return launchSequence.PREFLIGHT_NOT_EVALUATED;
  return {
    verdict: result.verdict,
    reason: result.reason,
    requiresReconciliation: preflightEngine.needsReconciliation(result)
  };
}

/**
 * Stop a pane whose session row could not be written, and say which of the two
 * outcomes happened. When the pane cannot be stopped, the error names it, so
 * the orphan is findable rather than silent.
 * @param {object} project - Project record
 * @param {string} tmuxName - The pane's tmux session
 * @param {Error} err - Why the session row was not written
 * @returns {{session: null, primePrompt: null, ttydUrl: null, code: string, error: string}}
 */
function _abandonUnboundLaunch(project, tmuxName, err) {
  let killError = null;
  try {
    tmux.killSession(tmuxName);
  // prawduct:allow prawduct/broad-except -- any kill failure is reported as an orphan below, never thrown over the bind error
  } catch (killErr) {
    killError = killErr.message;
  }
  let orphaned;
  try {
    orphaned = tmux.hasSession(tmuxName);
  // prawduct:allow prawduct/broad-except -- an unanswerable probe is treated as a surviving pane, the conservative reading
  } catch {
    orphaned = true;
  }
  log.error('Session record could not be written after tmux started', {
    project: project.name, tmuxSession: tmuxName, error: err.message, orphaned, killError
  });
  store.activity.log({
    projectId: project.id,
    eventType: 'launch.bind_failed',
    detail: { tmuxSession: tmuxName, error: err.message, orphaned, killError }
  });
  if (orphaned) {
    return {
      session: null, primePrompt: null, ttydUrl: null,
      code: 'ORPHANED_LAUNCH',
      error: `ORPHANED_LAUNCH: tmux session "${tmuxName}" is running with no session record (${err.message})`
    };
  }
  return {
    session: null, primePrompt: null, ttydUrl: null,
    code: 'LAUNCH_BIND_FAILED',
    error: `The session could not be recorded (${err.message}), so its tmux session was stopped. Nothing is running.`
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
  // Before anything else, for the same reason as the tmux path: the wrap measures
  // this session from here (#1309, #1406).
  const baseline = launchBaseline.capture(project.path);
  // Same heal as the tmux path (#1511). This path has no prime to carry the report,
  // so anything it changed or could not finish is logged where an operator looks.
  const heal = projectHeal.healOnLaunch(project.path);
  if (heal.report) log.warn('Launch heal needs attention (web UI launch has no prime to report it)', { project: projectName, report: heal.report });

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
    owner: options.owner || null,  // the signed-in TangleClaw user; null when no login is required
    launchBaseline: baseline
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

  // The third carrier (#1584): the rules are neither in this prime nor on a
  // hook, because this session pulls them in full as part of its launch
  // sequence. Headed like the manifest rather than like the block it points at,
  // for the manifest's own reason — a pointer that carried the heading
  // "Project Rules" would satisfy the absence check it asks the session to run.
  const pullPointerLines = ['## Rules delivery', ''];
  pullPointerLines.push(
    `${usable.length} operator-authored rule${usable.length === 1 ? '' : 's'} `
    + `govern${usable.length === 1 ? 's' : ''} this session. They are binding, and they are NOT in this `
    + 'prime: they arrive in the **governance** step of your launch sequence, in a block headed exactly '
    + '**"Project Rules"**. Run `tc start next` and read every step. '
    + '**If you reach the end of the sequence without having seen that block, say so before you act on '
    + 'anything else**: it means delivery failed and you are working without rules the operator believes '
    + 'are in force.'
  );
  pullPointerLines.push('');

  return {
    lines: manifestLines,
    manifestLines,
    inlineLines,
    pullPointerLines,
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
 * @returns {object|null} The recorded row, or `null` if the write failed. The
 *   rules-hook path needs the row's id to write the receipt token (#1063); a
 *   `null` there means the delivery simply cannot be confirmed later, which is
 *   recorded as such rather than assumed away.
 */
function _recordRuleDelivery(entry) {
  try {
    return store.sessionRuleDeliveries.record(entry);
  } catch (err) {
    log.warn('Failed to record session-rule delivery', {
      sessionId: entry.sessionId, channel: entry.channel, error: err.message
    });
    return null;
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
 * Which channel carries this session's project-rule TEXT.
 *
 * One owner, because two things must agree about it: the block the prime ships,
 * and the ledger row that records what was delivered. They disagreed for one
 * release of the `pull` default — the prime carried a pointer while the ledger
 * recorded the rule digest as `delivered` on the paste channel, which is the
 * claim prime-delivery §4 forbids and the failure that ledger exists to catch.
 *
 * `pull-pointer` requires BOTH the project's setting and a launch sequence that
 * will actually serve the rules. On an engine that declares no sequence, or a
 * launch whose prime is disabled, the paste stands: a pointer to a channel this
 * session does not have delivers nothing at all (#749, one engine over).
 *
 * @param {object} args
 * @param {object} args.projConfig - The project's loaded config
 * @param {object} args.engineProfile - Engine profile
 * @param {boolean} args.pull - Rendering the pulled steps rather than the pushed prime
 * @param {boolean} args.hasSequence - This launch has a sequence that will serve the rules
 * @returns {'hook'|'prime'|'launch-step'|'pull-pointer'}
 */
function resolveRulesCarrier({ projConfig, engineProfile, pull, hasSequence }) {
  if (pull) return 'launch-step';
  if (engines.silentPrimeDisposition(projConfig, engineProfile) === 'on') return 'hook';
  const pasteRules = projectConfig.resolvePasteRules(projConfig);
  if (pasteRules.warning) {
    log.warn('Project config falls back for the rules carrier', { warning: pasteRules.warning });
  }
  return pasteRules.mode === 'pull' && hasSequence === true ? 'pull-pointer' : 'prime';
}

/**
 * How each rules channel is named to the session, keyed by the channel.
 *
 * Declared as a map so a new channel is an entry here rather than another
 * branch inside a sentence: a session that is told the wrong channel looks for
 * its rules somewhere they are not, which is the #749 failure in words.
 * @type {Record<'hook'|'prime'|'launch-step'|'pull-pointer', string>}
 */
const RULES_DELIVERY_PHRASES = Object.freeze({
  hook: 'through the rules hook',
  prime: 'in this prime',
  'launch-step': 'in this launch step',
  'pull-pointer': 'in the governance step of this session\'s launch sequence (`tc start next`)'
});

/**
 * The binding rule sources that reach this session, named (#796).
 *
 * Engine-neutral: the config filename is the engine profile's own, never a
 * hard-coded `CLAUDE.md`. The plugin methodology is listed only where
 * `governanceState` finds it; on a non-Claude engine or an ungoverned Claude
 * project there is no such source and the list is shorter — nothing is said
 * about an absent channel, because absence of a source is not a fact the
 * session must act on.
 *
 * On a plugin-governed project the managed block is the #1021 operational
 * block, which by design carries none of the rules tiers — so the global
 * rules do NOT reach that session by file, and the section says so instead
 * of claiming delivery.
 *
 * @param {object} project - Project row.
 * @param {object} engineProfile - Engine profile.
 * @param {{ruleIds: number[]}} startupRules - The startup rules bundle.
 * @param {'hook'|'prime'|'launch-step'|'pull-pointer'} delivery - Which channel carries the rule
 *   TEXT to this session. A named channel rather than a pair of booleans: there are four of them
 *   now, and a session told the wrong one goes looking for its rules where they are not.
 * @returns {string[]} Prime lines.
 */
function _ruleSourcesSection(project, engineProfile, startupRules, delivery) {
  const declared = engines.configFilenameOf(engineProfile);
  const configFile = declared ? `\`${declared}\`` : "the engine's config file";
  const ruleCount = startupRules && Array.isArray(startupRules.ruleIds) ? startupRules.ruleIds.length : 0;
  const governance = engines.governanceState(project.path, { engineId: engineProfile && engineProfile.id });
  const topics = METHODOLOGY_OWNED_TOPICS.map((t) => t.topic).join(' and ');
  const sources = [];
  const notes = [];
  if (governance === 'governed-plugin') {
    notes.push(`TangleClaw global rules (\`data/global-rules.md\`) do NOT reach this project by file: ${configFile} is the plugin's, and TangleClaw writes only an operational block there. Any copy of them in that file is hand-kept and may be stale.`);
  } else {
    sources.push(`TangleClaw global rules — \`data/global-rules.md\`, carried in the managed block of ${configFile}.`);
  }
  sources.push(ruleCount > 0
    ? `TangleClaw project rules — ${ruleCount} startup rule${ruleCount === 1 ? '' : 's'} for this project, delivered ${RULES_DELIVERY_PHRASES[delivery]}.`
    : 'TangleClaw project rules — none active for this project.');
  if (governance === 'governed-plugin') {
    sources.push(`Plugin methodology (prawduct) — its own session-start channel; owns ${topics}.`);
  } else if (governance === 'governed-vendored') {
    sources.push(`Vendored methodology hook (\`tools/product-hook\`) — its own session-start channel; owns ${topics}.`);
  }
  return [
    '## Rule sources in force',
    `${sources.length} binding rule source${sources.length === 1 ? '' : 's'} reach this session. A directive can come from any of them; when two disagree, say so rather than pick one silently.`,
    ...sources.map((line, i) => `${i + 1}. ${line}`),
    ...notes.map((line) => `_${line}_`),
    ''
  ];
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
 * Record that an index file is being maintained here while no session is told
 * it exists — the launch-time half of the caveat the settings modal renders.
 *
 * ADR 0013 names the log as the record BEHIND the modal, and the two settings
 * that predate the caveat both emit one at launch (`silentPrime`,
 * `defaultLaunchMode`). Without this the operator who enabled Feature Index on
 * an engine that delivers no hidden prime gets a file nothing reads and a
 * maintainer debugging it finds nothing — silence in the log, of exactly the
 * kind the modal just stopped having.
 *
 * Says nothing when the toggle is off: the caveat describes what the setting
 * DOES on this engine, which is the right sentence for an operator reading the
 * control and the wrong one for a log about a launch where the setting was
 * never asked to do anything.
 *
 * @param {string} setting - `featureIndexEnabled` or `projectMapEnabled`.
 * @param {object} projConfig - The project's config (defaults merged).
 * @param {object|null} engineProfile - The engine this launch runs on.
 * @param {object} project - The project, for the log's identifying fields.
 * @returns {void}
 */
function _recordIndexPointerSkipped(setting, projConfig, engineProfile, project) {
  if (!projConfig || projConfig[setting] !== true) return;
  const drop = engines.settingDisposition(setting, projConfig, engineProfile);
  if (!drop.caveat) return;
  log[drop.level]('An index file is maintained for this project, but no session here is told it exists', {
    project: project && project.name,
    engine: engineProfile && engineProfile.id,
    setting,
    caveat: drop.caveat
  });
}

/**
 * The launch steps a session's context is split into, in serving order.
 *
 * The pushed prime and the `tc start` pull sequence render from the same
 * sections, each tagged with one of these steps. The push path renders every
 * section in its historical order; the pull path serves one step at a time.
 * The store owns the list because its CHECK constraint does.
 * @type {string[]}
 */
const LAUNCH_STEP_IDS = store.LAUNCH_STEP_IDS;

/**
 * The one line that tells an agent the launch sequence exists. It is the push
 * prime's only addition for a launch that has a sequence, and the engine-neutral
 * form matters: `tc` is on PATH in every pane TangleClaw launches, whatever the
 * engine.
 * @type {string[]}
 */
const LAUNCH_BOOTSTRAP_LINES = [
  '## Launch sequence',
  'Run `tc start next` now, before any other work, and follow what it prints. It serves this '
    + "session's governance, state and task in order, and each step tells you how to acknowledge it.",
  ''
];

/**
 * Collect the prime's sections, each tagged with the launch step it belongs to.
 *
 * One collector serves both delivery paths so that a section's text has one
 * source. The pushed prime renders every entry in order; the pull path
 * (`renderLaunchSteps`) keeps the entries of one step. Entries tagged `null`
 * are bulk reference pointers that stay outside the sequence.
 *
 * Pull mode differs where the channel does:
 * - project rules are always served in full, because a pull has no second
 *   channel for them to ride;
 * - it adds what only a pull carries (global rules, the engine's config file
 *   and shared documents, the preflight verdict, the plan pointer);
 * - nothing yields, so no budget logic applies and no yield is logged.
 *
 * @param {object} project - Project record from store
 * @param {object} engineProfile - Engine profile
 * @param {object} [options] - As for `generatePrimePrompt`, plus:
 * @param {'push'|'pull'} [options.mode='push'] - Which delivery path is rendering
 * @param {boolean} [options.launchSequence] - Push only: this launch has a
 *   sequence to pull, so the bootstrap line is included
 * @param {object} [options.preflight] - Pull only: the verdict stored on the sequence
 * @returns {{sections: Array<{step: (string|null), value: (string|object)}>, viaStartupHook: boolean, medusaActive: boolean}}
 */
function _collectPrimeSections(project, engineProfile, options = {}) {
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
  // OUT of the config file and into this prime, because config generation was
  // then skipped wholesale on plugin-governed projects and so delivered them
  // nowhere. #1021 narrowed that skip to an operational block, but rules stay
  // on this channel — static-vs-dynamic is the wrong axis for that tier;
  // reachability is, and one delivery path per tier stays the rule.
  const projConfig = store.projectConfig.load(project.path);
  const pull = options.mode === 'pull';
  const sections = [];
  const add = (step, ...values) => {
    for (const value of values) sections.push({ step, value });
  };

  // Header — kept for branding + project anchor
  add('identity', `# Session Start — ${project.name}`);
  add('identity', "*TangleClaw'd into existence.*");
  add('identity', '');

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
  add('identity',
    "Before anything else, begin your FIRST visible reply to the operator with "
    + "the banner line `*TangleClaw'd into existence.*` on its own line. This is "
    + 'unconditional: do it every session, whatever the model is driving this '
    + 'project, even when the operator opens with a direct task. It is a '
    + 'visible-output requirement only and does NOT authorize starting work — '
    + 'honor any wait-for-confirmation directive below before acting.'
  );
  add('identity', '');

  // Session ownership identity (#347 Slice 3). Inject the owned-project
  // identity early so a consumer (#340 scope guard) reads a reliable "what do
  // I own" fact from hidden prime context. Identity only — the wrong-tab
  // flagging behavior is #340's, not this primitive's.
  add('identity', ...sessionOwnership.primeSection(project));

  // Scope guard (#340). The behavior on top of the identity block: flag a
  // request that clearly belongs to a different project before acting —
  // surface, never refuse. Lists other projects with a live session (launch-
  // time snapshot, from listLive) so the flag can name the likely tab.
  add('identity', ...sessionOwnership.scopeGuardSection(project));

  // The push prime names the sequence only when this launch has one, so a
  // caller that renders a prime for any other reason gets the prime unchanged.
  if (pull || options.launchSequence === true) add('identity', ...LAUNCH_BOOTSTRAP_LINES);

  // Global rules ride the engine's config file on a push; a pull serves them
  // itself, because on a plugin-governed project that file does not carry them.
  if (pull) add('identity', ..._globalRulesLines());

  if (pull) add('state', ..._preflightLines(options.preflight));

  // Base-branch CI (#991): a red `main` invalidates the base for every PR and
  // is the precondition a release cut must not miss. Rendered only when it is
  // failing, in progress, or could not be read — and "could not be read" is
  // said as unknown, never omitted as if green. Generated text, so every
  // engine gets it. A cached read, never a spawn: the launch route refreshes
  // the cache asynchronously before calling in here, so this synchronous
  // generator holds nothing up; a cold cache reads as unknown.
  add('state', ...ciStatus.primeLines(ciStatus.readCached(project.path)));

  // Stranded wraps (#868): wrap branches that reached the remote with no pull
  // request, read from this install's own records. Always one line or more, so
  // "none" is said rather than implied, and a failed read says so. Local only —
  // nothing on this path waits on the network.
  add('state', ...strandedWraps.primeSection(project, () => strandedCheck.status(project)));

  // What the launch heal changed or could not finish (#1511), in one line. Absent
  // when it did nothing, so a healthy project's prime is unchanged.
  if (options.healReport) {
    add('state', options.healReport);
    add('state', '');
  }

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
  const viaStartupHook = engines.silentPrimeDisposition(projConfig, engineProfile) === 'on';

  const startupRules = options.startupRules || buildStartupRulesSection(project.id);
  // Which of the four carriers this session's rule TEXT rides — asked of the one
  // function that decides it, so the block that ships, the sentence that names
  // its channel, and the ledger row all read the same answer.
  const delivery = resolveRulesCarrier({
    projConfig, engineProfile, pull, hasSequence: options.launchSequence === true
  });
  // Fall back to `lines` for a caller-supplied section that predates the
  // manifest/inline split — the block a caller hands in must ship verbatim, or
  // the ledger records a rule set the session never saw. A legacy bundle has no
  // pointer variant, and falls back to the rule text rather than to the
  // manifest: pasting rules a session did not need is harmless, and pointing it
  // at a channel that bundle never described is not.
  const rulesLines = {
    hook: () => startupRules.manifestLines || startupRules.lines || [],
    prime: () => startupRules.inlineLines || startupRules.lines || [],
    'launch-step': () => startupRules.inlineLines || startupRules.lines || [],
    'pull-pointer': () => startupRules.pullPointerLines || startupRules.inlineLines || startupRules.lines || []
  }[delivery]();
  add('governance', ...rulesLines);

  // Rule sources in force (#796). A session reads merged prose with no seams
  // and cannot tell there are several authorities, let alone that two of them
  // disagree. Naming the sources is the tractable half of "detect
  // contradictions"; the other half is the boundary guard on
  // `data/global-rules.md` (test/global-rules-boundary.test.js), and both
  // read the one topic list in lib/methodology-topics.js. Part of the
  // non-yielding floor: "how many authorities, and what to do when they
  // disagree" is a directive, not lookup bulk.
  add('governance', ..._ruleSourcesSection(project, engineProfile, startupRules, delivery));

  if (pull) add('governance', ..._configAndSharedDocsLines(project, engineProfile));

  // Ecosystem birth-awareness (#1122). Standing operating facts any session
  // needs to work inside the TangleClaw ecosystem — API origin, the numeric
  // project id (the #1121 name-vs-id trap), the operator-link convention, the
  // Project Rules store and its approval gate, the learnings loop, PortHub.
  // Rendered from a declared roster (lib/ecosystem-primer.js) so the next
  // fact is a roster entry, not prompt surgery. Yields FIRST (priority 0)
  // under budget pressure: of all the prime's bulk, this is the section whose
  // pointer preserves the most — the two identifiers a session cannot cheaply
  // rediscover (API origin + numeric id) survive in one line, while learnings
  // and the operator's own rules have no such compression.
  const primerCtx = {
    projectId: project.id,
    projectName: project.name,
    apiOrigin: _apiOrigin() || API_ORIGIN_PROSE_FALLBACK,
    // Measured from the operator's OWN launch request where there was one: a
    // reverse proxy means this machine's name is not the name they typed. With
    // no request behind the launch this probes instead, and yields null rather
    // than a loopback name — the primer renders that unknown instead of
    // sending the operator to a URL that cannot answer.
    operatorHost: options.operatorHost !== undefined
      ? options.operatorHost
      : sessionOwnership.resolveOperatorHost().host
  };
  add(null, _yieldable(0,
    ecosystemPrimer.buildEcosystemPrimerSection(primerCtx),
    ecosystemPrimer.ecosystemPrimerPointer(primerCtx)));

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
    add('identity', ..._medusaPrimeSection(project, options.medusaWorkspaceId));
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
      add('governance', _yieldable(2, lines,
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
  // (delivered via the engine's `sessionstart-prime-<engine>.sh` → silent
  // SessionStart hook), so
  // the operator never sees it. The AI must therefore turn "hidden in" into
  // "visible out" — emit the resume prompt as its first visible turn, after
  // a freshness check, and wait for the operator's go (no auto-execute).
  // This is the fix for the stale-handoff + invisible-banner pains the
  // contract was written to kill. Falls back to the legacy passive summary
  // when no index exists yet (older sessions predating continuity).
  const resume = continuity.readIndex(project.path);
  if (resume && options.continuityMode !== 'fresh') {
    add('task', '## Resume — emit this as your FIRST visible message');
    add('task',
      'This prime is hidden context; the operator does not see it. Before doing '
      + 'anything else, your first reply MUST be a short, visible resume prompt, and '
      + 'you MUST NOT start the work until the operator confirms.'
    );
    add('task', '');
    add('task', 'Last session recorded:');
    if (resume.currentState) add('task', `- Where we are: ${resume.currentState}`);
    if (resume.nextAction) add('task', `- Next action: ${resume.nextAction}`);
    const f = resume.freshness || {};
    const stamp = [f.branch && `branch ${f.branch}`, f.sha && `@${f.sha}`, f.writtenAt]
      .filter(Boolean).join(' ');
    if (stamp) add('task', `- Written at: ${stamp}`);
    // CC-7: surface the degraded-wrap tier so "verify before trusting" is
    // grounded — a `no-plugin` wrap skipped the reflection fold, so its
    // judgment is thinner than a `full` wrap's. (A `mechanical-only` wrap
    // captured no judgment at all, so `readIndex` returns null and this block
    // is skipped entirely — that case surfaces via the legacy summary path.)
    if (f.tier && f.tier !== 'full') add('task', `- Wrap tier: ${f.tier} (judgment may be thin — verify)`);
    add('task', '');
    add('task', 'Your first turn:');
    add('task',
      '1. Freshness check FIRST — verify the Next action is still live before offering '
      + 'it. Cheap checks: is any referenced issue still open (`gh issue view <N>`)? Has '
      + 'the branch merged? Does the named artifact still exist? Compare HEAD to the '
      + 'written-at sha above.'
    );
    add('task',
      "2. Intent Reconciliation (Continuity Check) — Restate what you plan to do as your first "
      + "action, and explicitly diff it against the literal 'Next action' stated above. If your "
      + "interpretation has drifted from the handoff, highlight the gap clearly."
    );
    add('task',
      "3. In that same first visible message — the one that already leads with the "
      + "required `*TangleClaw'd into existence.*` banner (see the top of this prime) "
      + "— follow the banner with \"We left off at <X>. Next: <Y>.\" (incorporating your diff). "
      + 'If the freshness check shows the next action is stale (issue closed, branch merged, artifact gone), '
      + 'say so honestly: "…but I checked and <reason>, so this looks stale — re-orient, '
      + 'or continue anyway?"'
    );
    add('task', '4. Wait for the operator\'s go. Do not auto-execute the next action.');
    add('task', '');
  } else {
    if (pull) add('task', ..._noResumeLines(resume, options.continuityMode));
    const lastSession = store.sessions.getLatest(project.id);
    if (lastSession && lastSession.wrapSummary) {
      // Yieldable, and the first to go: a passive narrative summary is the
      // least load-bearing block in the prime.
      add('state', _yieldable(1,
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
  if (!pull) _recordIndexPointerSkipped('featureIndexEnabled', projConfig, engineProfile, project);
  if (projConfig.featureIndexEnabled === true
      && engines.silentPrimeDisposition(projConfig, engineProfile) === 'on') {
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
        add(null, '## Feature Index');
        add(null,
          'A feature→file map is maintained at `FEATURES.md` (project root): '
          + `${curatedEntries} curated entr${curatedEntries === 1 ? 'y' : 'ies'}`
          + (backlogEntries > 0
            ? `, plus ${backlogEntries} auto-stubbed awaiting graduation`
            : '')
          + '. Read it FIRST when locating where a feature lives — before grep '
          + 'or filesystem search.'
        );
        add(null, '');
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

  if (!pull) _recordIndexPointerSkipped('projectMapEnabled', projConfig, engineProfile, project);
  // Project Map pointer (PIDX #360, #356). Same symmetric gate as the Feature
  // Index. Unlike FEATURES.md, the map is REFERENCED, not inlined (#360 point 3):
  // the map grows with the project, so we point the agent at the file rather than
  // spend prime budget echoing it every session. Only emit the pointer when the
  // file actually exists + is non-empty (toggle-on seeds it; absence = skip).
  if (projConfig.projectMapEnabled === true
      && engines.silentPrimeDisposition(projConfig, engineProfile) === 'on') {
    try {
      const mapPath = path.join(project.path, 'PROJECT-MAP.md');
      const trimmed = fs.readFileSync(mapPath, 'utf8').trim();
      if (trimmed.length > 0) {
        add(null, '## Project Map');
        add(null,
          'A structural "where things live" map is maintained at `PROJECT-MAP.md` '
          + '(project root). Consult it FIRST when locating where code, features, or '
          + 'shared docs live — before grep or filesystem search.'
        );
        add(null, '');
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
    // Through the disposition, not the bare flag: a project can hold
    // `enabled: true` from a hand-edit made on an engine no exchange can reach,
    // and telling that agent "you are being scored" is a false statement about
    // its own session — the prime is the one surface the agent believes.
    if (engines.settingDisposition('evalAuditMode', projConfig, engineProfile).applies
        && projConfig.evalAuditMode && projConfig.evalAuditMode.enabled) {
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
      add('governance', _yieldable(3,
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
  add('identity', '## Wrapping this session');
  add('identity',
    'When the user signals they want to wrap up (e.g. types "wrap", "let\'s wrap up", '
    + '"end the session"), confirm first if it is ambiguous, then emit the marker '
    + `\`${wrapSentinel.SENTINEL_TOKEN}\` on a line by itself. TangleClaw watches for that `
    + 'bare token and opens the wrap drawer — it does NOT auto-commit or kill the session, '
    + 'so nothing is lost; the operator still reviews and confirms the wrap.'
  );
  add('identity', '');

  if (pull) add('task', ..._planPointerLines(project));

  return { sections, viaStartupHook, medusaActive };
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
 * @param {string|null} [options.healReport] - The launch heal's one-line report
 *   (`lib/project-heal.js`), or null when it changed nothing.
 * @param {boolean} [options.launchSequence] - This launch has a `tc start`
 *   sequence, so the prime carries the line that tells the agent to pull it.
 * @returns {string}
 */
function generatePrimePrompt(project, engineProfile, options = {}) {
  const collected = _collectPrimeSections(project, engineProfile, { ...options, mode: 'push' });
  const { viaStartupHook, medusaActive } = collected;
  const sections = collected.sections.map((entry) => entry.value);

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
      ? ` The complete text is on disk at ${tcProjectFiles.resolveIn(project.path, tcProjectFiles.SESSION_PRIME_RELPATH)}.`
      : '';
    prompt += '\n\n_(This prime exceeds the ' + maxChars + '-character budget of the channel '
      + 'carrying it. Nothing was cut, but the consumer may truncate it — if this text ends '
      + 'mid-sentence, that is why.' + complete + ')_\n';
  }

  return prompt;
}

/**
 * Render the four launch steps a `tc start` sequence serves.
 *
 * Same sections as the pushed prime, grouped by step and never yielded: a pull
 * is paginated rather than budgeted, so required content is served whole.
 * @param {object} project - Project record from store
 * @param {object} engineProfile - Engine profile
 * @param {object} [options] - As for `generatePrimePrompt`, plus `preflight`
 * @returns {{identity: string, governance: string, state: string, task: string}}
 */
function renderLaunchSteps(project, engineProfile, options = {}) {
  const { sections } = _collectPrimeSections(project, engineProfile, { ...options, mode: 'pull' });
  const out = {};
  for (const id of LAUNCH_STEP_IDS) {
    out[id] = _renderPrimeSections(sections.filter((s) => s.step === id).map((s) => s.value), new Set());
  }
  return out;
}

/**
 * The global rules, as a pull serves them.
 * @returns {string[]}
 */
function _globalRulesLines() {
  const text = String(store.globalRules.load() || '').trim();
  return [
    '## Global rules',
    'These TangleClaw rules apply to every project on this install.',
    '',
    text || '_No global rules are configured on this install._',
    ''
  ];
}

/**
 * The preflight verdict stored on the sequence, and what it means.
 * @param {{verdict: string, reason?: string}|undefined} preflight
 * @returns {string[]}
 */
function _preflightLines(preflight) {
  const verdict = preflight && typeof preflight.verdict === 'string' ? preflight.verdict : 'not-evaluated';
  const reason = preflight && preflight.reason ? preflight.reason : 'no reason was recorded';
  const meaning = verdict === 'not-evaluated'
    ? 'Nothing is known about the previous session\'s handoff either way. Do not read this as a clean handoff.'
    : 'Act on this verdict before proposing any work.';
  return ['## Launch preflight', `Verdict: \`${verdict}\` — ${reason}.`, meaning, ''];
}

/**
 * The engine's config file and the shared documents this project can reach.
 * A read failure is said in the section rather than dropping it.
 * @param {object} project - Project record
 * @param {object} engineProfile - Engine profile
 * @returns {string[]}
 */
function _configAndSharedDocsLines(project, engineProfile) {
  const file = engines.configFilenameOf(engineProfile);
  const lines = ['## Engine config and shared documents'];
  lines.push(file
    ? `This engine reads project configuration from \`${file}\` at the project root. TangleClaw regenerates its managed block at every launch.`
    : 'This engine declares no project configuration file, so nothing reaches this session that way.');
  try {
    const docs = store.sharedDocs.listForProject(project.id);
    if (docs.length === 0) {
      lines.push('No shared documents are registered for this project\'s groups.');
    } else {
      lines.push('Shared documents registered for this project\'s groups:');
      for (const doc of docs) lines.push(`- ${doc.name} — ${doc.filePath}`);
    }
  // prawduct:allow prawduct/broad-except -- a launch step must render even when the shared-docs read fails
  } catch (err) {
    log.warn('Shared documents unavailable for the launch step', { project: project.name, error: err.message });
    lines.push(`Shared documents could not be read (${err.message}); run \`tc docs\` to list them.`);
  }
  lines.push('');
  return lines;
}

/**
 * The task step when there is no resume directive to serve.
 * @param {object|null} resume - The continuity index, if one exists
 * @param {string|undefined} continuityMode - The launch's continuity mode
 * @returns {string[]}
 */
function _noResumeLines(resume, continuityMode) {
  const why = resume && continuityMode === 'fresh'
    ? 'This launch was started fresh, so the previous session\'s next action is deliberately not offered.'
    : 'No previous session recorded a next action.';
  return ['## Task', `${why} Ask the operator what to work on before starting anything.`, ''];
}

/**
 * Where the project's plans are, with the route that gives each one's
 * shareable link.
 * @param {object} project - Project record
 * @returns {string[]}
 */
function _planPointerLines(project) {
  const lines = ['## Plans'];
  let plans;
  try {
    plans = planDocs.listPlans(project.path);
  // prawduct:allow prawduct/broad-except -- a launch step must render even when the plans directory cannot be read
  } catch (err) {
    // A failed read is not an absence. Saying both — "could not be read" and
    // "no plan files are present" — would have the step contradict itself and
    // let a reader take the second sentence as the answer.
    lines.push(`The plans directory could not be read (${err.message}); ask the operator where this project's plans are.`);
    lines.push('');
    return lines;
  }
  if (plans.length === 0) {
    lines.push('No plan files are present in this project.');
  } else {
    lines.push(`Plan files in this project (\`GET ${_apiOrigin() || API_ORIGIN_PROSE_FALLBACK}/api/projects/${project.id}/plans\` gives each one's shareable link; hand the operator that link, never a path):`);
    for (const plan of plans.slice(0, PLAN_POINTER_LIMIT)) lines.push(`- ${plan.path}`);
    if (plans.length > PLAN_POINTER_LIMIT) lines.push(`- …and ${plans.length - PLAN_POINTER_LIMIT} more, listed by the route above.`);
  }
  lines.push('');
  return lines;
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
    + `at ${_apiOrigin() || API_ORIGIN_PROSE_FALLBACK}: inbox `
    + `\`GET /api/sessions/${proj}/medusa/messages\`, mark read `
    + `\`POST /api/sessions/${proj}/medusa/read\`, send `
    + `\`POST /api/sessions/${proj}/medusa/send\` (\`{"to","message"}\`), peers `
    + `\`GET /api/sessions/${proj}/medusa/roster\`. The full consumer contract `
    + 'is appended at the end of this prime.'
  );
  lines.push('');
  return lines;
}

/**
 * Resolve this instance's API origin, or null when it cannot be resolved.
 * Uses the same helper pair the generated engine configs use, for the same
 * reason: read what the server ACTUALLY serves rather than config intent.
 *
 * Returns null on failure rather than a prose fallback: this value feeds BOTH
 * prime prose and the pane's `TANGLECLAW_API` env, and an English sentence in
 * an env var sends `tc` fetching a sentence-shaped URL — a misdirected
 * diagnosis instead of an honest absence. Prose callers substitute their own
 * human fallback; the env caller omits the var, which `tc` reports loudly as
 * "not launched under TangleClaw".
 *
 * @returns {string|null} e.g. `http://localhost:3102`, or null
 */
function _apiOrigin() {
  try {
    const https = require('./https-setup');
    return `${https.effectiveServerProtocol(store.config.load())}://localhost:${https.effectiveServerPort(store.config.load())}`;
  } catch (err) {
    log.warn('Could not resolve the API origin', { error: err.message });
    return null;
  }
}

/** Human fallback for prose call sites when the origin cannot be resolved. */
const API_ORIGIN_PROSE_FALLBACK = 'the TangleClaw API base URL in your project guide';

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
 *
 * THREE OF THESE FIELDS ARE TRI-STATE. `active`, `idle` and `lastOutputAge`
 * come back `null` when the read could not establish them — a wedged tmux
 * (#94/#144/#380) answers nothing, and reporting the plausible default would
 * state a fact nobody has. `incomplete` names whichever fields those are and is
 * present on EVERY answer (`[]` when nothing went short, never absent, so a
 * consumer reads its value instead of probing for the field); `cause` says why.
 *
 * Every null is falsy, so a consumer written before these states behaves as it
 * did — with ONE exception that consumers must know about: acting on a falsy
 * `active` means declaring the session over, which is a definite, irreversible
 * action on an unestablished read. Branch on `active === false`, not on
 * `!active`. `public/session.js` does.
 *
 * This route reports NO wrap state. A session holds `active` for the whole of
 * its wrap, and where a wrap is actually running is `lib/wrap-run-registry.js`
 * (#1034). Finalizing remains an action a client asks for — `POST
 * /wrap/complete` — never something a read performs (#910).
 *
 * @param {string} projectName - Project directory name
 * @returns {{ active: boolean|null,
 *             sessionId?: number, project: string, engine?: string,
 *             tmuxSession?: string, startedAt?: string, durationSeconds?: number,
 *             incomplete: string[], cause: string|null,
 *             idle?: boolean|null, lastOutputAge?: number|null,
 *             lastEngineError?: object, lastSession?: object }|null}
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
        // Present, and empty, because nothing here went short: a webui session
        // has no pane, so terminal-idle is not a reading this branch failed to
        // take — it is a question that does not apply, and `false` is this
        // subsystem's own answer rather than a wedged tmux's. `incomplete` is
        // for reads that could not establish a fact, and there was no such read.
        incomplete: [],
        cause: null,
        idle: false,
        lastOutputAge: 0,
        iframeUrl
      };
    }

    // Is the tmux session actually alive — and did tmux say so, or say nothing?
    //
    // THIS IS A READ THAT WRITES, which is why it cannot use the plain boolean.
    // `hasSession` answers false both for a pane that is gone and for a tmux
    // server too wedged to reply, and this branch PERSISTS that answer: one
    // poll from an open session page during a wedge marks a running session
    // crashed, and the row does not come back when tmux recovers. A status read
    // may not record a death it did not observe (#900).
    //
    // One probe, not two: the old shape asked `hasSession` again inside the
    // else-branch, spawning a second tmux for a question already answered.
    const probe = active.tmuxSession ? tmux.probeSession(active.tmuxSession) : null;
    // Re-arm on ANY answer, before branching on what the answer was. A probe
    // that replied is evidence the pane is reachable again however it replied,
    // so the next silence is a new incident and must be loud. Placed here
    // rather than in the reachable branch because the crashed branch answered
    // too — and because a key left behind for a session that has ended would
    // accumulate for the life of the process.
    if (probe && probe.answered) conditionLog.resolved(`session-unreachable:${active.id}`);
    if (probe && probe.answered && !probe.live) {
      // tmux died unexpectedly — mark as crashed so frontend detects session end
      store.sessions.markCrashed(active.id, 'tmux session died');
      clearIdleCache(active.tmuxSession);
      // Release the Medusa presence too (#1000). The other two end paths — an
      // explicit kill and a wrap teardown — already do this; a session that
      // simply died did not, so its listener kept its WebSocket open and its
      // workspace stayed in the roster reporting `connected: true`.
      //
      // That is worse than a stale record: the leaked listener is a LIVE
      // consumer. A peer addressing the dead workspace gets `{"status":
      // "received"}` back from the hub and the message is filed into an inbox
      // no agent will ever read — a delivery that genuinely succeeded, to a
      // ghost. Nothing anywhere reports a problem, and the peer that restarted
      // has lost its context and cannot tell you it never heard from you.
      //
      // Sits beside `markCrashed` deliberately: the same branch that persists
      // "this session has ended" is the one that must release what it held.
      _teardownMedusa(project, active);
      log.warn('Active session tmux died', { project: projectName, session: active.id });
      // Fall through to the lastSession check below
    } else {
      if (probe && !probe.answered) {
        conditionLog.report(`session-unreachable:${active.id}`, 'warn',
          'Could not establish whether this session is still live — leaving the '
          + 'record alone rather than marking it crashed',
          { project: projectName, session: active.id, cause: probe.cause });
      }
      // Reaching the pane is what produces idle and lastOutputAge, so a pane we
      // could not reach leaves both unestablished — NULL, never `false`/`0`.
      //
      // Those two together are the reading for a pane that just produced output,
      // which is the opposite of the truth here and points the wrong way: it
      // says the session is busy when what is actually true is that we cannot
      // see it. The session page reads `idle` as its wrap-completion signal, so
      // a definite "not idle" is a wrong answer to the question it is asking.
      // `null` is falsy, so every consumer that has not learned about this state
      // behaves exactly as it did before it existed.
      //
      // A null probe means no `tmuxSession` on the row, so nothing was asked —
      // which is not the same as an answer. Folded in here so the invariant
      // holds by CONSTRUCTION rather than by an argument about who creates rows:
      // reporting `false`/`0` with `incomplete: []` would affirmatively claim
      // both were established on a branch that asked nothing at all.
      const unreachable = !probe || !probe.answered;
      let idle = unreachable ? null : false;
      let lastOutputAge = unreachable ? null : 0;
      let idleReason = null;

      if (probe && probe.live) {
        // The CHIME reads this. A staleness timer dings through any quiet
        // stretch, so this site asks the stronger question — does the pane
        // look like it is at its prompt, and has it held still — through the
        // gate the wake monitor already uses. `detectAtPrompt` degrades to
        // `detectIdle` rather than to an unknown, so an unprofiled engine keeps
        // the output-staleness behaviour instead of losing its chime.
        const idleInfo = detectAtPrompt(active.tmuxSession, active.engineId);
        idle = idleInfo.idle;
        lastOutputAge = idleInfo.lastOutputAge;
        idleReason = idleInfo.reason;
        // An operator on an engine with no wake profile gets the OLD behaviour.
        // Unsaid, they cannot tell that from the stated residual and would
        // reasonably re-report the same bug against code that never ran for
        // them. Reported once per condition, not once per poll.
        if (typeof idleReason === 'string' && idleReason.startsWith('staleness:')) {
          conditionLog.report(`idle-gate-degraded:${active.id}`, 'info',
            'Chime idle detection fell back to output staleness', {
              session: active.id, engine: active.engineId, reason: idleReason
            });
        } else {
          conditionLog.resolved(`idle-gate-degraded:${active.id}`);
        }
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
        // Empty on the healthy path, not absent — a field that appears only on
        // failure makes every consumer probe for its existence instead of
        // reading its value.
        incomplete: unreachable ? ['idle', 'lastOutputAge'] : [],
        cause: (probe && probe.cause) || null,
        idle,
        lastOutputAge,
        // Which gate answered. `staleness:*` means the strong at-rest gate did
        // not apply (unprofiled engine, uncapturable pane) and this session is
        // on the pre-#1180 behaviour — a fact the operator otherwise has no
        // way to learn, and would re-report the same bug over.
        idleReason,
        // The engine's own last API error (#261), recorded by the wrap
        // sentinel's pane scan and cleared once the pane moves past it. Null
        // on the healthy path, not absent.
        lastEngineError: engineErrors.get(active.id)
      };
    }
  }

  // No DB session but tmux session exists (launched outside v3 or DB out of sync)
  //
  // A READ-ONLY question about a pane, so it asks with the probe rather than
  // the boolean. `hasSession` answers false both for a pane that is gone and
  // for a tmux server too wedged to reply, and the fall-through below states an
  // absence — so a wedge made an untracked-but-running session disappear from
  // this route entirely. No issue named this site; it is the same defect as
  // #905/#907 one branch further down, found while fixing them.
  const tmuxName = tmux.toSessionName(projectName);
  const untrackedProbe = tmux.probeSession(tmuxName);
  if (untrackedProbe.live) {
    return {
      active: true,
      project: projectName,
      engine: null,
      tmuxSession: tmuxName,
      startedAt: null,
      durationSeconds: null,
      // NOT `false`/`0`. This branch never measured either — it has no DB row to
      // date from and does not call `detectIdle` — so it was stating the reading
      // for a pane that just produced output on the strength of nothing at all.
      incomplete: ['idle', 'lastOutputAge'],
      cause: null,
      idle: null,
      lastOutputAge: null,
      untracked: true
    };
  }
  if (!untrackedProbe.answered) {
    // Neither "a session is running" nor "there is none" — say so, rather than
    // picking the one that happens to be the current default. `active: null`
    // with the field named is the shape #900 settled for exactly this.
    //
    // `lastSession` is still reported. It comes from the database, which a
    // wedged tmux cannot affect, so withholding it would have this branch
    // discard something that WAS established — the opposite error to the one it
    // exists to prevent, and the previous fall-through did return it.
    const priorSession = store.sessions.getLatest(project.id);
    return {
      active: null,
      project: projectName,
      incomplete: ['active'],
      cause: untrackedProbe.cause,
      lastSession: priorSession ? {
        sessionId: priorSession.id,
        status: priorSession.status,
        endedAt: priorSession.endedAt,
        durationSeconds: priorSession.durationSeconds,
        wrapSummary: priorSession.wrapSummary
      } : null
    };
  }

  // No active session — return last session info. tmux ANSWERED that nothing is
  // there, so this absence is established rather than assumed, and `incomplete`
  // is empty on that basis rather than by omission.
  const lastSession = store.sessions.getLatest(project.id);
  const result = {
    active: false,
    project: projectName,
    incomplete: [],
    cause: null,
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

/** Per-session digest + streak for `detectAtPrompt`. Mirrors medusa-wake's own state. */
const _atPromptState = new Map();

/**
 * Wall-clock stillness the chime requires, on top of the tick streak.
 *
 * The streak alone counts polls, and the poll interval is an operator setting,
 * so the same two ticks mean four seconds on one install and a minute on
 * another. Ten seconds matches what `detectIdle` meant before this gate
 * existed, so the chime's timing does not silently change under anyone.
 * @type {number}
 */
const IDLE_SECONDS_REQUIRED = 10;

/**
 * Whether a session looks like it is genuinely waiting at its prompt.
 *
 * Composes the same gate the Medusa wake monitor uses — engine marker checks,
 * transcript-movement, and a tick streak — through the one shared
 * `medusaWake.assessSessionIdle`, so the chime and the wake monitor cannot
 * drift into two different notions of "at rest".
 *
 * Stricter than `detectIdle` where it applies: it additionally requires the
 * pane to LOOK at rest (no busy marker, no running agent fleet) and to hold
 * still, both across consecutive polls and for a wall-clock minimum.
 *
 * It deliberately does NOT require the pane be safe to type into. That is the
 * injector's question, and it excludes a permission dialog and a composer
 * holding half-typed text — both of which are a session waiting for the
 * operator, which is what this one is for.
 *
 * **Stated cost:** a tool call that prints nothing is indistinguishable from a
 * session waiting, to this or any other pane reader. This narrows the window
 * the chime fires wrongly in; it does not close it.
 *
 * **Degrades to `detectIdle`, never to an unknown.** When the engine has no
 * wake profile, or the pane cannot be captured, this returns the staleness
 * verdict rather than `null`. That is deliberate: #907 fixed a contract that a
 * REACHED pane yields a real reading, and answering "unknown" for every
 * unprofiled engine would quietly delete the chime for them rather than
 * improve it. The strong gate is an upgrade where it applies; where it does
 * not, behaviour is exactly what it was. `reason` always names which answered.
 *
 * @param {string} tmuxSession - tmux session name.
 * @param {string} engineId - Engine id, for the wake profile.
 * @returns {{idle: boolean, reason: string, lastOutputAge: number}}
 */
function detectAtPrompt(tmuxSession, engineId) {
  const profile = engineId && medusaWake.ENGINE_WAKE_PROFILES[engineId];
  if (!profile) {
    // No live-probed idle signature for this engine. Guessing one is the
    // false-idle hazard; deleting the chime is not an improvement either.
    const legacy = detectIdle(tmuxSession);
    return { ...legacy, reason: `staleness:no-wake-profile:${engineId || 'unknown'}` };
  }
  let capture;
  try {
    capture = tmux.capturePane(tmuxSession, { lines: medusaWake.TMUX_TAIL_LINES });
  } catch (err) {
    _atPromptState.delete(tmuxSession);
    const legacy = detectIdle(tmuxSession);
    log.debug('at-prompt gate degraded to staleness', { tmuxSession, cause: err.message });
    return { ...legacy, reason: 'staleness:pane-capture-failed' };
  }
  // `capturePane` swallows most real failures into an empty result rather than
  // throwing, and an empty pane has no busy marker — so judged, it would read
  // as at rest. Nothing captured is nothing measured.
  if (!capture || !Array.isArray(capture.lines) || capture.lines.length === 0) {
    _atPromptState.delete(tmuxSession);
    const legacy = detectIdle(tmuxSession);
    log.debug('at-prompt gate degraded to staleness', { tmuxSession, cause: 'empty-capture' });
    return { ...legacy, reason: 'staleness:empty-capture' };
  }
  // Best-effort, exactly as the wake monitor treats it: a pane that cannot
  // report a cursor is still judged, just by the weaker text check.
  let cursor = null;
  try {
    cursor = tmux.cursorInfo(tmuxSession);
  } catch {
    cursor = null;
  }

  const prev = _atPromptState.get(tmuxSession);
  const assessed = medusaWake.assessSessionIdle({
    lines: capture.lines,
    profile,
    cursor,
    // The chime NOTIFIES, it does not type. Requiring the pane be paste-safe
    // would silence it on a permission dialog and on a composer holding the
    // operator's half-typed text — the first of which is the single case the
    // chime exists for.
    mustBeTypeable: false,
    prevDigest: prev && prev.digest,
    idleTicks: (prev && prev.idleTicks) || 0
  });
  const now = Date.now();
  const since = prev && assessed.digest === prev.digest ? prev.since : now;
  _atPromptState.set(tmuxSession, {
    digest: assessed.digest, idleTicks: assessed.idleTicks, since
  });
  const stillFor = Math.floor((now - since) / 1000);
  // A streak counts POLLS, and the poll rate is an operator preference (2s to
  // 30s, and 2s during a wrap) — so ticks alone would mean ~4s of stillness on
  // one install and ~60s on another. The old heuristic was time-based and that
  // property is worth keeping, so the wall-clock floor is required too.
  const idle = assessed.idle && stillFor >= IDLE_SECONDS_REQUIRED;
  return {
    idle,
    reason: assessed.idle && !idle ? 'settling' : assessed.reason,
    lastOutputAge: stillFor
  };
}

/**
 * Whether a pane's last few lines have stopped changing for ~10s.
 *
 * This is an OUTPUT-STALENESS heuristic, not an at-rest judgement: it says
 * nothing about whether the engine looks like it is at its prompt, so a tool
 * call that prints nothing reads as idle. Deliberately kept for
 * `lib/actions/invoke-critic.js`, which was built against exactly that meaning.
 * Migrating it is a separate behaviour change with its own risk, not a side
 * effect of fixing the chime. The wrap's content steps stopped using it (#1450):
 * a TUI's last lines hold still while the model thinks, so the wrap sent its
 * next prompt into an unfinished turn. They now wait for a completion line the
 * AI prints (`lib/wrap-steps/ai-content.js`).
 *
 * For "is the session actually waiting for me", use `detectAtPrompt`.
 *
 * @param {string} tmuxSession - tmux session name.
 * @returns {{idle: boolean, lastOutputAge: number}}
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
  // Every per-pane cache resets here, or the next session of a project
  // inherits the dead one's streak and its `since` — tmux names key on the
  // PROJECT, so the collision is the normal case, not an edge one.
  _atPromptState.delete(tmuxSession);
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
    // address another project's pane, and require the live status so it can
    // never reach a wrapped/killed session's stale tmux name — `get()` is
    // any-project/any-status, unlike the `getActive` path below.
    if (!active || active.projectId !== project.id) {
      return { ok: false, error: `Session ${options.sessionId} is not a session of "${projectName}"` };
    }
    if (active.status !== store.SESSION_STATUS.ACTIVE) {
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

// ── Clipboard ──

/**
 * The newest tmux buffer for a project's active session — what the operator
 * last copied in the terminal (#438). Resolves the project and session the way
 * `peek` does, then reads the buffer through `tmux.readNewestBuffer`.
 *
 * No `hasSession` probe, unlike `peek`: buffers belong to the tmux SERVER, not
 * to the pane, so the pane's liveness says nothing about whether there is
 * text to hand over — and a probe run through the shell cannot tell "no tmux
 * binary" from "no such session", which would turn a missing tmux into the
 * wrong 404. `readNewestBuffer` names each of those states itself.
 *
 * Every failure carries a `code` so the route can answer honestly rather than
 * with one generic 404: `NOT_FOUND` (no project / no active tmux session),
 * `NO_BUFFER` (nothing copied yet, or no tmux server to hold a buffer),
 * `TMUX_UNAVAILABLE` (no tmux binary, or tmux did not answer).
 *
 * @param {string} projectName - Project name
 * @returns {{ text: string|null, tmuxSession: string|null, error: string|null, code: string|null }}
 */
function clipboard(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { text: null, tmuxSession: null, error: `Project "${projectName}" not found`, code: 'NOT_FOUND' };
  }

  const active = store.sessions.getActive(project.id);
  if (!active || !active.tmuxSession) {
    if (active && active.sessionMode === 'webui') {
      return { text: null, tmuxSession: null, error: 'Copy not supported for Web UI sessions', code: 'NOT_FOUND' };
    }
    return { text: null, tmuxSession: null, error: `No active session for "${projectName}"`, code: 'NOT_FOUND' };
  }

  const buffer = tmux.readNewestBuffer();
  if (buffer.ok) {
    return { text: buffer.text, tmuxSession: active.tmuxSession, error: null, code: null };
  }
  const code = (buffer.cause === 'no-buffer' || buffer.cause === 'no-server') ? 'NO_BUFFER' : 'TMUX_UNAVAILABLE';
  return { text: null, tmuxSession: active.tmuxSession, error: buffer.error, code };
}

// ── Wrap ──

/**
 * The outcome recorded for a claimed run that never produced a pipeline result:
 * the pipeline threw, the work around it threw, or reporting on it threw. Same
 * outer shape as a pipeline outcome, so the stream's `run-done`, `GET
 * /wrap/status` and `triggerWrap` all hand a caller one shape.
 *
 * @param {string} runId - The claimed run
 * @param {number} sessionId - The session the run targets
 * @param {string} error - What went wrong, worded for the operator
 * @returns {object} A `triggerWrap`-shaped failure
 */
function _unfinishedWrapResult(runId, sessionId, error) {
  return {
    ok: false,
    runId,
    sessionId,
    wrapCommand: null,
    wrapSteps: [],
    captureFields: [],
    pipelineResult: null,
    error
  };
}

/**
 * Is `active` still the project's active session? A kept wrap is reported as
 * kept only when it is (#1558).
 *
 * @param {object} project - Project record
 * @param {object} active - The session the wrap started against
 * @returns {boolean} False when it ended during the wrap, or the read failed
 */
function _sessionStillActive(project, active) {
  try {
    const current = store.sessions.getActive(project.id);
    return Boolean(current) && current.id === active.id;
  } catch (err) {
    // A failed read claims nothing: the result then says nothing about the session.
    log.warn('Could not re-read the session after a kept wrap', { project: project.name, session: active.id, error: err.message });
    return false;
  }
}

/**
 * Claim the project's single wrap slot and start the pipeline WITHOUT waiting
 * for it. The wrap POST answers 202 from this, so the operator's browser learns
 * the run's `runId` at once instead of holding a request open for the whole
 * pipeline — and a Retry can attach to the new run the moment it exists.
 *
 * #583 — server-side single-flight. Client-side guards (#519) can't span
 * tabs/devices/reloads: the 2026-07-16 incident re-fired every AI content step
 * because a second POST started a second full pipeline while the first was
 * mid-flight/zombied. Exactly one wrap pipeline may run per project; a
 * concurrent caller gets the running run's info so the route can answer 409.
 *
 * The returned `done` never rejects: `_runClaimedWrap` settles the run on every
 * path, and anything escaping it is logged and recorded here. Nothing awaits
 * `done` on the HTTP path, so a rejection would be an unhandled one — and a run
 * whose slot was never released.
 *
 * @param {object} project - Project record
 * @param {object} active - Active Session record (already verified non-null)
 * @param {object} [options] - Per-wrap user choices forwarded to the runner
 * @returns {{ok: true, runId: string, sessionId: number, done: Promise<object>} | {ok: false, code: 'WRAP_IN_PROGRESS', sessionId: number, wrapRun: object, error: string, wrapCommand: null, wrapSteps: string[], captureFields: string[], pipelineResult: null}}
 */
function _startWrapPipeline(project, active, options) {
  // Read BEFORE `begin`, which replaces this project's last-run record: a Retry
  // reuses content steps its blocked predecessor already captured (#1404).
  const previousRun = wrapRunRegistry.get(project.name);
  const claim = wrapRunRegistry.begin(project.name, active.id, options);
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

  const done = _runClaimedWrap(project, active, options, claim.runId, previousRun)
    .catch((err) => { // prawduct:allow prawduct/broad-except -- a detached run has no caller to reject to; the failure is logged and recorded as the run's outcome
      log.error('Wrap run failed outside its pipeline', { project: project.name, runId: claim.runId, error: err.message });
      const failed = _unfinishedWrapResult(claim.runId, active.id, `wrap failed: ${err.message}`);
      if (wrapRunRegistry.finish(project.name, claim.runId, failed)) return failed;
      // `_runClaimedWrap`'s finally already recorded an outcome for this run.
      // Hand back THAT one, so an in-process caller and a browser reading the
      // stream are never told two different things about the same wrap.
      const recorded = wrapRunRegistry.get(project.name);
      return recorded.runId === claim.runId && recorded.result ? recorded.result : failed;
    });
  return { ok: true, runId: claim.runId, sessionId: active.id, done };
}

/**
 * Run a wrap whose slot is already claimed, to a settled registry entry. When
 * the pipeline run finishes (`ok`), with or without a commit, the session
 * record is transitioned to `wrapped` + tmux is killed + doc locks are
 * released, unless the operator passed `keepSessionRunning: true` (#1558).
 * Stopped and thrown runs leave the session active so the user can retry or
 * continue.
 *
 * `wrapRunRegistry.finish` is the run's ONLY terminal transition: it clears
 * `running`, appends `run-done`, and ends every open stream subscriber (#185).
 * So the whole body — including the version record and resume decision that
 * run before the pipeline — sits inside one try/finally. A throw anywhere
 * between the claim and `finish` would otherwise hold the project's slot until
 * the 30-minute stale takeover and leave every stream open with no terminal
 * frame.
 *
 * @param {object} project - Project record
 * @param {object} active - Active Session record
 * @param {object} [options] - Per-wrap user choices forwarded to the runner
 *   (e.g. `{skipTests, prHandling, keepSessionRunning}`), collected by the wrap
 *   modal and drawer.
 * @param {string} runId - The claimed run
 * @param {object} previousRun - `wrapRunRegistry.get` read before the claim
 * @returns {Promise<object>} `triggerWrap`'s outer result shape plus a
 *   `pipelineResult` field carrying the runner's structured output. The
 *   `wrapCommand`/`wrapSteps`/`captureFields` fields survive from the
 *   retired legacy NL-prompt wrap's response contract for HTTP-contract
 *   stability (the pipeline reports `wrapCommand: null`).
 */
async function _runClaimedWrap(project, active, options, runId, previousRun) {
  let settled = false;
  let pipelineReturned = false;
  try {
    // Re-record project version (#101) — captures the pre-wrap state.
    // The next session launch records again, capturing any version bump
    // the wrap itself produced (e.g. CHANGELOG promotion). Non-blocking.
    projectVersion.recordVersion(project.path);

    // Logged whichever way it goes: a Retry that re-prompts is indistinguishable
    // from one that correctly declined to reuse, unless the reason is recorded.
    const resume = wrapPipeline.resumableContentResults(previousRun, { sessionId: active.id, now: Date.now() });
    log.info('Wrap resume decision', { project: project.name, session: active.id, reason: resume.reason });

    let pipelineResult;
    try {
      pipelineResult = await wrapPipeline.runWrapPipeline(project.name, {
        ...options,
        // Progress feed for GET /wrap/status and the live stream (#185): every
        // runner event lands in the registry's log, which also moves the
        // status pointer on `step-start`. Spread order makes this hook
        // unoverridable by caller options (which arrive from an HTTP JSON
        // body and can never legitimately carry a function).
        onStepEvent: (event) => wrapRunRegistry.emit(project.name, runId, event),
        // Same spread-order guarantee, for a stronger reason: reused content
        // lands in the wrap commit and the continuity record, so it may only
        // ever come from this server's own record of a previous run, never from
        // a request body. Always set, so a body-supplied value is replaced.
        resumeFrom: resume.results,
        // Train 21, #1585 — the run staging the handoff. Same spread-order
        // guarantee as the two above, and for the same reason: this id is what
        // binds a handoff publication to the attempt that produced it, so a
        // request body must never be able to name someone else's run.
        wrapRunId: runId
      });
    } catch (err) {
      log.error('Wrap pipeline threw', { project: project.name, error: err.message });
      const failed = _unfinishedWrapResult(runId, active.id, `wrap pipeline threw: ${err.message}`);
      settled = wrapRunRegistry.finish(project.name, runId, failed);
      return failed;
    }
    pipelineReturned = true;

    // Surface the pipeline's step IDs under the retired legacy response
    // field names — HTTP-contract stability for the run's result payload
    // (server.js#_wrapResultPayload forwards them, and GET /wrap/status
    // replays the identical shape).
    const wrapSteps = pipelineResult.results.map((r) => r.stepId);
    const captureFields = wrapDefaultPipeline.wrapShape().captureFields;

    // Session-lifecycle transition. A run that finished is a completed wrap,
    // whether or not it committed: work that shipped by PR before the wrap,
    // and wrap writes that land in ignored paths, both leave nothing to commit
    // (#1558). It records the session, tears down tmux and releases doc locks,
    // symmetrically with the legacy `completeWrap` path. The operator can ask
    // to keep the session (`keepSessionRunning`) to save state mid-session.
    // Stopped and thrown runs leave the session active so the operator can
    // answer or retry in its terminal.
    //
    // `lifecycleCompleted` is DERIVED from the write, not asserted alongside it:
    // the session can end between the pipeline starting and finishing (an
    // operator pressing Kill mid-wrap), and the transition map then refuses the
    // wrap. Setting the flag unconditionally would put "the lifecycle
    // completed" in the log beside a row that says `killed` with no summary.
    let lifecycleCompleted = false;
    const keepRequested = pipelineResult.ok === true && Boolean(options) && options.keepSessionRunning === true;
    // Train 21, #1585 — what the `handoff-stage` step staged for THIS run, if
    // anything. Read from the run's own results rather than from the store, so
    // a concurrent wrap's attempt can never be mistaken for this one's.
    const handoff = _stagedHandoff(pipelineResult, runId);
    let publicationBound = null;
    if (pipelineResult.ok && !keepRequested) {
      const completion = _completePipelineWrap(active, pipelineResult, handoff);
      if (handoff) {
        lifecycleCompleted = completion.wrapped;
        publicationBound = completion.publicationBound;
      } else {
        lifecycleCompleted = completion;
      }
    }
    if (handoff) {
      _finalizeHandoff(project, handoff, {
        lifecycleCompleted, publicationBound, keepRequested, pipelineOk: pipelineResult.ok
      });
    }
    // Kept means the session is still running, read from the store rather than
    // from the request: an operator can tick the box and then press Kill while
    // the wrap runs, and that session must not be reported as running.
    const sessionKept = keepRequested && _sessionStillActive(project, active);

    log.info('Wrap pipeline ran', {
      project: project.name,
      session: active.id,
      ok: pipelineResult.ok,
      blockedAt: pipelineResult.blockedAt,
      stepCount: pipelineResult.results.length,
      commitSha: pipelineResult.commitSha,
      lifecycleCompleted,
      sessionKept
    });

    const result = {
      ok: pipelineResult.ok,
      // #185 — the run's handle for GET /wrap/stream/:runId.
      runId,
      sessionId: active.id,
      // No tmux command is sent — the runner is server-side.
      wrapCommand: null,
      wrapSteps,
      captureFields,
      // Whether the session record was actually written. `ok` is the PIPELINE's
      // verdict; this is the lifecycle's, and they can disagree — a pipeline
      // that succeeds against a session someone killed mid-wrap writes nothing.
      // Returned rather than only logged so the disagreement is observable to a
      // caller and to a test. `server.js#_wrapResultPayload` doesn't forward
      // the flag itself; it turns this and `sessionKept` into `sessionOutcome`.
      lifecycleCompleted,
      // True when the run finished, the operator's `keepSessionRunning` left
      // the session open on purpose, and it is still the active session.
      sessionKept,
      pipelineResult,
      error: pipelineResult.error
    };
    // #583 — retain the outcome so any client (a reloaded page, another
    // device) can fetch it via GET /wrap/status or the stream's `run-done`.
    settled = wrapRunRegistry.finish(project.name, runId, result);
    return result;
  } finally {
    // The run must reach a terminal state whatever threw — otherwise the slot
    // and every subscriber outlive it. The recorded outcome says which side of
    // the pipeline the failure was on: after it returned, the commit (if there
    // was one) landed and the wrap itself must not be reported as failed.
    if (!settled) {
      wrapRunRegistry.finish(project.name, runId, _unfinishedWrapResult(runId, active.id, pipelineReturned
        ? 'wrap pipeline finished but reporting threw — check the server log; any commit it made still landed'
        : 'wrap failed before its pipeline ran — check the server log; nothing was committed'));
    }
  }
}

/**
 * Read the wrap-run registry state for a project (#583) — powers
 * `GET /api/sessions/:project/wrap/status` so a client can follow a
 * running wrap or fetch a finished run's result — after a reload, from
 * another device, or when its stream dropped.
 *
 * @param {string} projectName - Project name (registry key)
 * @returns {{runId: string|null, running: boolean, stale: boolean, sessionId: number|null, startedAt: number|null, currentStepId: string|null, finishedAt: number|null, result: object|null}}
 *   `running` is false for a run claimed and never settled, with `stale` true
 *   beside it (#1314), so a consumer that only asks whether a wrap is in
 *   progress gets the safe answer without knowing staleness exists.
 *   `runId` (#185) is the handle `GET /wrap/stream/:runId` takes. The wrap
 *   POST's 202 hands it to the page that started the run; this route is where
 *   any other client learns it.
 */
function getWrapRunStatus(projectName) {
  return wrapRunRegistry.get(projectName);
}

/**
 * Attach a listener to a wrap run's event log (#185) — powers
 * `GET /api/sessions/:project/wrap/stream/:runId`. Thin pass-through so the
 * route depends on the sessions module, like every other wrap route, rather
 * than reaching into the registry directly.
 *
 * @param {string} projectName - Project name (registry key)
 * @param {string} runId - The run to watch
 * @param {{onEvent: (event: object) => void, onEnd: () => void, afterSeq?: number}} listener
 * @returns {{ok: false} | {ok: true, replay: object[], finished: boolean, unsubscribe: () => void}}
 */
function subscribeWrapRun(projectName, runId, listener) {
  return wrapRunRegistry.subscribe(projectName, runId, listener);
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
 * Synthesize a wrap-summary string from a pipeline result so the
 * `wrap_summary` column captures something meaningful when the session
 * is transitioned to `wrapped`. Reads the pipeline's own structured output
 * rather than re-parsing tmux pane text, which is why it survived the pane
 * parser it replaced.
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
function _derivePipelineWrapSummary(pipelineResult) {
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
 * What the `handoff-stage` step staged for THIS run, if anything (Train 21, #1585).
 *
 * Read out of the run's own results rather than looked up in the store: a
 * concurrent wrap of another session may have staged its own attempt, and
 * finalizing someone else's is the exact failure the per-attempt design exists
 * to prevent.
 * @param {object} pipelineResult - The finished pipeline result
 * @param {string} runId - This wrap run
 * @returns {{publicationId: string, wrapRunId: string, kind: string}|null}
 */
function _stagedHandoff(pipelineResult, runId) {
  for (const result of (pipelineResult && pipelineResult.results) || []) {
    if (result.kind !== 'handoff-stage') continue;
    const out = result.output;
    if (!out || typeof out.publicationId !== 'string') return null;
    return { publicationId: out.publicationId, wrapRunId: runId, kind: out.kind };
  }
  return null;
}

/**
 * Publish this run's staged attempt, or abandon it — never leave it staged.
 *
 * A staged attempt that is neither published nor abandoned is indistinguishable
 * from one whose process died mid-wrap, which would send reconciliation looking
 * for a crash that never happened.
 *
 * @param {object} project - Project record
 * @param {{publicationId: string, wrapRunId: string, kind: string}} handoff - This run's attempt
 * @param {object} verdicts - What the wrap decided
 * @param {boolean} verdicts.lifecycleCompleted - Whether the session transitioned
 * @param {boolean|null} verdicts.publicationBound - Whether the attempt was bound
 * @param {boolean} verdicts.keepRequested - Whether the session was kept running
 * @param {boolean} verdicts.pipelineOk - Whether the pipeline succeeded
 * @returns {void}
 */
function _finalizeHandoff(project, handoff, verdicts) {
  const { lifecycleCompleted, publicationBound, keepRequested, pipelineOk } = verdicts;

  // A kept session has no lifecycle transition, so the checkpoint binds itself.
  if (keepRequested) {
    if (!pipelineOk) {
      handoffPublish.abandonHandoff(handoff.publicationId, 'pipeline-failed');
      return;
    }
    const bound = store.handoffs.markCheckpointComplete(
      handoff.publicationId, handoff.wrapRunId, new Date().toISOString()
    );
    if (!bound) {
      handoffPublish.abandonHandoff(handoff.publicationId, 'checkpoint-not-bound');
      return;
    }
    handoffPublish.publishHandoff(project, handoff.publicationId);
    return;
  }

  if (!pipelineOk) {
    handoffPublish.abandonHandoff(handoff.publicationId, 'pipeline-failed');
    return;
  }
  if (!lifecycleCompleted) {
    // Kill won the race: the attempt never completed, so it is abandoned
    // rather than published.
    handoffPublish.abandonHandoff(handoff.publicationId, 'lifecycle-incomplete');
    return;
  }
  if (publicationBound !== true) {
    handoffPublish.abandonHandoff(handoff.publicationId, 'eligibility-not-bound');
    return;
  }

  const result = handoffPublish.publishHandoff(project, handoff.publicationId);
  if (!result.published) {
    // An eligible attempt that could not be published is deliberately NOT
    // abandoned: it completed, and `abandon` only moves rows whose
    // `eligible_at` is NULL precisely so a completed attempt keeps saying so.
    // It therefore stays `staged` with its eligibility intact, which is the
    // input car 21.8 reads as `handoff-unconfirmed`. Logged rather than left
    // silent, because from the outside that row is indistinguishable from a
    // process that died mid-publish — and only this log says which it was.
    log.warn('A completed wrap could not publish its handoff; the attempt stays eligible for reconciliation', {
      project: project.name, publication: handoff.publicationId, reason: result.reason
    });
  }
}

/**
 * Run the pipeline wrap teardown — symmetric with `completeWrap` (neither
 * commits; the pipeline's `commit` step already flushed staged writes and
 * committed). Wraps the session record, kills tmux,
 * releases doc locks, clears caches. Each teardown step is independent
 * so a failure in one (e.g. tmux already dead, lock-release threw)
 * does not prevent the others from running.
 *
 * Every log line here carries `path: 'pipeline'`, and `completeWrap`'s carry
 * `path: 'finalize'`: the two teardowns emit the same messages, and both can
 * touch one session in a single wrap (the race `/wrap/complete` answers 409
 * `SESSION_CHANGED` for), so the field is the only thing that says which
 * finalizer ran.
 *
 * @param {object} active - Active Session record being wrapped
 * @param {object} pipelineResult - Output of `runWrapPipeline`
 * @param {{publicationId: string, wrapRunId: string, kind: string}|null} [handoff] - This run's
 *   staged handoff attempt, when the `handoff-stage` step produced one. Its eligibility binds
 *   inside the same transaction as the lifecycle transition.
 * @returns {boolean|{wrapped: boolean, publicationBound: boolean|null}} Whether THIS call
 *   recorded the wrap. False when the session had already ended — the teardown still ran, but no
 *   wrap was written. With a `handoff`, an object that also says whether the attempt bound.
 */
function _completePipelineWrap(active, pipelineResult, handoff) {
  const summary = _derivePipelineWrapSummary(pipelineResult);

  // Transition the session record. `store.sessions.wrap` refuses a session that
  // has already ended (the lifecycle's transition map) and answers null, which
  // is reachable here in a way it is not from `completeWrap`: this runs after an
  // awaited pipeline, so an operator pressing Kill mid-wrap ends the row first.
  // The teardown below still runs — the pane and the listener must go either
  // way — but the caller is told the lifecycle did NOT complete, so nothing
  // records a wrap that was never written.
  let wrapped = false;
  let publicationBound = null;
  try {
    // Train 21, #1585 — when this wrap staged a handoff, the attempt's
    // eligibility is bound inside the SAME transaction as the transition, so a
    // refused transition (Kill won) binds nothing.
    const result = handoff
      ? store.sessions.wrap(active.id, summary, { publicationId: handoff.publicationId, wrapRunId: handoff.wrapRunId })
      : store.sessions.wrap(active.id, summary);
    wrapped = result !== null;
    if (wrapped && handoff) publicationBound = result.publicationBound === true;
    if (!wrapped) {
      log.warn('The wrap pipeline finished, but the session had already ended — '
        + 'no wrap was recorded', { path: 'pipeline', session: active.id });
    }
  } catch (err) {
    log.warn('store.sessions.wrap failed in the wrap lifecycle', { path: 'pipeline', session: active.id, error: err.message });
  }

  // WebUI/OpenClaw sessions record `tmuxSession: null` (#334) — the
  // pipeline is tmux-free, so there is simply no pane to kill for them.
  if (active.tmuxSession) {
    try {
      if (tmux.hasSession(active.tmuxSession)) {
        tmux.killSession(active.tmuxSession);
      }
    } catch (err) {
      log.warn('Failed to kill tmux session during wrap teardown', { path: 'pipeline', session: active.id, error: err.message });
    }
    clearIdleCache(active.tmuxSession);
  }

  // Forget this session's Medusa listener + workspace id (MED-2K9P Chunk 04).
  // Independent teardown step — resolves the owning project from the session row.
  try {
    _teardownMedusa(store.projects.get(active.projectId), active);
  } catch (err) {
    log.warn('Failed to tear down Medusa on wrap', { path: 'pipeline', session: active.id, error: err.message });
  }

  try {
    const released = store.documentLocks.releaseBySession(active.id);
    if (released > 0) {
      log.info('Released document locks on wrap', { path: 'pipeline', session: active.id, count: released });
    }
  } catch (err) {
    log.warn('Failed to release document locks on wrap', { path: 'pipeline', session: active.id, error: err.message });
  }

  return handoff ? { wrapped, publicationBound } : wrapped;
}

/**
 * Resolve the project and its active session for a wrap. Shared by
 * `startWrap` and `triggerWrap` so both refuse identically.
 *
 * @param {string} projectName - Project name
 * @returns {{project: object, active: object, refusal: null} | {project: null, active: null, refusal: object}}
 */
function _wrapTarget(projectName) {
  const refuse = (error) => ({
    project: null,
    active: null,
    refusal: { ok: false, sessionId: null, wrapCommand: null, wrapSteps: [], captureFields: [], error }
  });
  const project = store.projects.getByName(projectName);
  if (!project) return refuse(`Project "${projectName}" not found`);

  // #334 — gate on session existence only, NOT on `tmuxSession`. WebUI/OpenClaw
  // sessions are recorded with `tmuxSession: null` by design; the server-side
  // wrap pipeline is tmux-free, so they must reach it instead of being
  // rejected here.
  const active = store.sessions.getActive(project.id);
  if (!active) return refuse(`No active session for "${projectName}"`);
  return { project, active, refusal: null };
}

/**
 * Start the session wrap and return as soon as the run is claimed — the call
 * behind `POST /api/sessions/:project/wrap`'s 202. The pipeline runs on; its
 * progress and outcome are read from the registry (`getWrapRunStatus`,
 * `subscribeWrapRun`).
 *
 * The pipeline is the only wrap path. There is no tmux-prompt fallback and
 * no per-project opt-out gate: every wrap runs server-side through
 * `lib/wrap-pipeline.js:runWrapPipeline`.
 *
 * @param {string} projectName - Project name
 * @param {object} [options] - Per-wrap user choices forwarded to the pipeline
 *   runner (`{skipTests, prHandling, skipAiContent, bumpLevel, proceedPastStranded, keepSessionRunning, …}`).
 *   `proceedPastStranded` lists the stranded wraps (`{remote, branch, headSha}`)
 *   the operator chose to wrap past (#1540). `keepSessionRunning: true` leaves
 *   the session open after a finished run (#1558); a non-boolean is refused.
 * @returns {{ok: true, runId: string, sessionId: number, done: Promise<object>, strandedUnchecked: string|null} | {ok: false, code?: string, items?: object[], sessionId: number|null, error: string}}
 *   `strandedUnchecked` is the reason the stranded-wrap check was skipped, or null.
 *   `done` resolves to the run's `triggerWrap`-shaped outcome and never rejects.
 *   A refusal (no project, no active session, a malformed `keepSessionRunning`,
 *   a run already in progress, or
 *   `STRANDED_WRAPS` with the blocking `items`) claims nothing and carries no `done`.
 */
function startWrap(projectName, options) {
  const target = _wrapTarget(projectName);
  if (target.refusal) return target.refusal;
  // #1558: a malformed keep-running choice is refused before anything is
  // claimed. Read as "not kept", a string "true" would end the session the
  // operator asked to keep.
  if (options && options.keepSessionRunning !== undefined && typeof options.keepSessionRunning !== 'boolean') {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      sessionId: target.active.id,
      wrapCommand: null,
      wrapSteps: [],
      captureFields: [],
      error: 'options.keepSessionRunning, when given, must be true or false'
    };
  }
  // A running wrap is followed, not re-gated: `_startWrapPipeline` refuses it
  // with the run's id, and a stranded-wrap prompt in its place would leave the
  // drawer unable to attach to the run it is already showing.
  let strandedUnchecked = null;
  if (!wrapRunRegistry.get(target.project.name).running) {
    // Stranded wraps (#1540): a soft block. The operator may wrap past the
    // listed items; that acknowledges nothing, so they still hold the next
    // launch.
    const gate = strandedWraps.wrapGate(target.project, options ? options.proceedPastStranded : undefined);
    if (!gate.ok) {
      return {
        ok: false,
        code: gate.code,
        items: gate.items,
        sessionId: target.active.id,
        wrapCommand: null,
        wrapSteps: [],
        captureFields: [],
        error: gate.error
      };
    }
    strandedUnchecked = gate.unchecked || null;
  }
  const started = _startWrapPipeline(target.project, target.active, options);
  return started.ok ? { ...started, strandedUnchecked } : started;
}

/**
 * Run the session wrap to its outcome — `startWrap` plus the wait. The
 * in-process API for a caller that wants the result rather than a handle.
 *
 * @param {string} projectName - Project name
 * @param {object} [options] - Per-wrap user choices forwarded to
 *   the pipeline runner (`{skipTests, prHandling}`).
 * @returns {Promise<{ ok: boolean, runId?: string, sessionId: number|null, wrapCommand: string|null, wrapSteps: string[], captureFields: string[], lifecycleCompleted?: boolean, sessionKept?: boolean, pipelineResult?: object, error: string|null }>}
 *   `runId` (#185) rides every outcome of a claimed run — success and thrown
 *   pipeline alike. Absent only on the refusals that never claimed one.
 */
async function triggerWrap(projectName, options) {
  const started = startWrap(projectName, options);
  if (!started.ok) return started;
  return started.done;
}

/**
 * Complete a wrap — capture summary, update session record, kill tmux.
 * Called after wrap skill has finished (detected by polling or manually).
 *
 * A session stays `active` for the whole of its wrap, so the active row IS the
 * wrapping one; there is no separate status to look under first (#1034).
 * @param {string} projectName - Project name
 * @param {string} [summary] - Wrap summary text
 * @param {number} [expectedSessionId] - The session the caller observed
 * @returns {{ session: object|null, code?: string, error: string|null }}
 *   `code: 'SESSION_CHANGED'` on both stale-view refusals — the caller named a
 *   session that had moved on, or the right one ended before the write landed.
 */
function completeWrap(projectName, summary, expectedSessionId) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, error: `Project "${projectName}" not found` };
  }

  const target = store.sessions.getActive(project.id);
  if (!target) {
    return { session: null, error: `No active session for "${projectName}"` };
  }

  // The caller may name the session it observed. This route kills tmux and
  // commits the project repository, and it resolves its target by PROJECT — so
  // between the poll that saw a finished wrap and the POST that finalizes it, a
  // relaunch can put a different session under the same name and receive both.
  // The window is small and nobody has hit it; naming the session closes it for
  // the caller that can, while an unnamed request behaves exactly as before.
  if (expectedSessionId !== undefined && expectedSessionId !== null
      && String(target.id) !== String(expectedSessionId)) {
    return {
      session: null,
      // The condition travels as a VALUE, not as prose the route greps. Both of
      // this function's stale-view refusals carry it, so improving either
      // sentence cannot change a status code.
      code: 'SESSION_CHANGED',
      error: `Session ${expectedSessionId} is no longer the current session for "${projectName}" `
        + `(it is now ${target.id}) — nothing was changed.`
    };
  }

  // A finalize with no summary in the body records `null`, and that is
  // deliberate: the alternative is guessing one from raw pane text, which lands
  // in the wrap commit subject and the next session's prime. A wrong summary is
  // worse than an absent one (#910).
  const session = store.sessions.wrap(target.id, summary);
  if (!session) {
    // The row ended between the lookup above and this write — a kill, or a
    // pipeline that finished first. Nothing was written, so nothing after this
    // point may run: tearing down the listener and committing the repository on
    // behalf of a wrap that did not happen is the failure this whole ruling is
    // about, and answering 200 would tell the page its finalize landed.
    return {
      session: null,
      // The same stale-client-view condition as the identity check above, one
      // race later: there the caller named a session that had moved on, here it
      // named the right one and it ended underneath. A 500 would reach the page
      // as a server fault and latch its finalizer permanently on that.
      code: 'SESSION_CHANGED',
      error: `Session ${target.id} for "${projectName}" ended before this finalize could record it `
        + '— nothing was changed.'
    };
  }

  // Forget this session's Medusa listener + workspace id (MED-2K9P Chunk 04).
  _teardownMedusa(project, target);

  // Kill tmux session
  if (target.tmuxSession && tmux.hasSession(target.tmuxSession)) {
    try {
      tmux.killSession(target.tmuxSession);
    } catch (err) {
      log.warn('Failed to kill tmux session during wrap', { path: 'finalize', session: target.id, error: err.message });
    }
  }

  // No commit here. This route used to run `git add -A` and commit whatever the
  // working tree held, a leftover from the retired prompt-driven wrap. That swept
  // the operator's and co-resident sessions' uncommitted work into a "Session
  // wrap" commit (#1406); the pipeline's commit step is the only wrap commit, and
  // it commits only the session's own files.

  // Release any document locks held by this session
  try {
    const released = store.documentLocks.releaseBySession(target.id);
    if (released > 0) {
      log.info('Released document locks on wrap', { path: 'finalize', session: target.id, count: released });
    }
  } catch (err) {
    log.warn('Failed to release document locks on wrap', { path: 'finalize', session: target.id, error: err.message });
  }

  clearIdleCache(target.tmuxSession);
  log.info('Session wrapped', { path: 'finalize', project: projectName, session: session.id });

  return { session, error: null };
}

// ── Kill Session ──

/**
 * Kill a session — force-stop affordance. Targets the project's active session,
 * which includes one stuck mid-wrap (that is exactly when kill is most needed,
 * #105). When there is none, reconciles orphaned tmux state if any is found
 * under the project's expected tmux name.
 * @param {string} projectName - Project name
 * @param {string} [reason] - Kill reason
 * @returns {{ session: object|null, error: string|null, reconciled?: boolean }}
 */
function killSession(projectName, reason) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, error: `Project "${projectName}" not found` };
  }

  // A session mid-wrap is still `active`, so this one lookup covers the case
  // the kill button most exists for — an engine that never finished the wrap
  // protocol, or a restart that orphaned the pane (#105).
  const target = store.sessions.getActive(project.id);

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

  // Update session record. A null means the row ended between the lookup and
  // here — the tmux teardown below is still the right thing to do (an orphaned
  // pane is an orphaned pane), but the caller must not be told this call killed
  // a session it did not.
  const session = store.sessions.kill(target.id, reason);
  const killedByThisCall = session !== null;

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

  clearIdleCache(target.tmuxSession);
  if (!killedByThisCall) {
    // The row was ended by something else between the lookup and the write — a
    // wrap that finished first, most likely. The operator's ask is satisfied
    // either way (the pane and the listener are gone), so this returns the row
    // rather than an error, and the caller gets the TRUE status: `wrapped`, not
    // `killed`. Only the log says this call was not the one that ended it —
    // claiming a second ending for one death is what the transition map exists
    // to stop.
    //
    // Deliberately NOT `reconciled`. That flag means "there was no DB row at
    // all", and its route branch answers without a `sessionId`; there IS a row
    // here, and the caller should have it.
    log.warn('Kill tore down a session that had already ended', {
      project: projectName, session: target.id, reason
    });
    return { session: store.sessions.get(target.id), error: null };
  }

  log.info('Session killed', { project: projectName, session: session.id, reason });

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
 * Prefix a launch command with an inline PATH export so `tc` survives the
 * pane shell's rc processing (#1140).
 *
 * The `-e PATH=...` prepend on `tmux new-session` is not enough on its own:
 * tmux runs the command through the user's shell, and rc processing (macOS
 * `/usr/libexec/path_helper` in `/etc/zprofile`, plus any rc that reassigns
 * PATH) rebuilds PATH before the command body executes — probe-verified on the
 * live host, where the launched engine process carried no trace of the
 * prepend and `which tc` failed in every pane. An export embedded in the
 * command body runs AFTER the rc files, so it survives; child processes then
 * inherit it (rc re-processing in children demotes but does not lose it).
 * The env prepend stays as well — it is correct on shells that don't clobber.
 *
 * Bounded degradations, recorded rather than silent:
 * - No command (a bare interactive pane): nothing to ride — the env prepend
 *   is the only floor, i.e. today's behavior.
 * - A bin dir with shell-unsafe characters would break out of the double
 *   quotes; refuse the wrapper and log, never build a broken command.
 *
 * The Master pane is wrapped too (#1141): it carries TANGLECLAW_ROLE=master
 * instead of a project id, so a PATH-reachable `tc` there answers the master
 * identity honestly rather than "not launched under TangleClaw".
 *
 * @param {string|undefined} launchCmd - The engine launch command, or undefined
 * @param {string} [binDirOverride] - Test seam: the bin dir to assert safe and
 *   prepend (production callers omit it — the repo's own `bin/` is the floor)
 * @returns {string|undefined} The wrapped command, or the input unchanged
 */
function _withPathFloor(launchCmd, binDirOverride) {
  if (!launchCmd) return launchCmd;
  const binDir = binDirOverride || path.join(__dirname, '..', 'bin');
  if (/["`$\\\n\r]/.test(binDir)) {
    log.warn('PATH floor wrapper skipped — bin dir contains shell-unsafe characters; tc will not resolve by name in this pane', { binDir });
    return launchCmd;
  }
  return `export PATH="${binDir}:$PATH"; ${launchCmd}`;
}

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

/** Poll cadence while waiting for an engine pane to reach its at-rest state. */
const PANE_READY_POLL_MS = 750;
/**
 * How long the readiness gate waits before giving up. The 2026-08-18
 * antigravity regression showed boots north of 41 seconds ("Verifying your
 * account…"), so this horizon is minutes-shaped — a short cap would rebuild
 * the fixed-delay race this gate replaces.
 */
const PANE_READY_TIMEOUT_MS = 90_000;
/** Pane tail depth for readiness captures — input box + status rows. */
const PANE_READY_CAPTURE_LINES = 15;

/**
 * Wait until a launched engine pane is ready to receive the prime paste (#999).
 *
 * Readiness needs TWO independent signals (#1106): the engine's positive
 * at-rest marker rendered in the pane AND the transcript digest holding still
 * across two consecutive polls. The digest alone detects only MOTION — a boot
 * stalled on "Verifying your account…" is a static pane that reads exactly
 * like a ready prompt — and the marker alone can race a still-printing boot.
 * Engines without a positive marker cannot be gated (Claude's is null for a
 * measured reason — nothing renders at rest that is absent mid-turn); their
 * caller falls back to the declared fixed delay and must record the paste as
 * `unverified`, never `delivered`.
 *
 * @param {string} tmuxName - tmux session name
 * @param {string} engineId - Engine identifier (keys ENGINE_WAKE_PROFILES)
 * @param {object} [opts] - Test seams and overrides
 * @param {object} [opts.profiles] - Wake-profile table (default: medusa-wake's)
 * @param {Function} [opts.capture] - Pane capture fn `(name, {lines})`
 * @param {number} [opts.pollMs] - Poll cadence (default PANE_READY_POLL_MS)
 * @param {number} [opts.timeoutMs] - Give-up horizon (default PANE_READY_TIMEOUT_MS)
 * @param {Function} [opts.now] - Clock returning epoch ms
 * @param {Function} [opts.sleep] - Async sleep `(ms) => Promise`
 * @returns {Promise<{gated: boolean, ready?: boolean, waitedMs?: number, reason?: string}>}
 *   `gated:false` — no positive marker exists for this engine, nothing was
 *   observed; `ready:true` — marker present with a settled transcript, the
 *   paste may claim delivery; `ready:false` — timed out, `reason` names what
 *   never appeared (a persistent capture failure carries its error here — the
 *   wait stays falsifiable rather than spinning silently on a dead pane).
 */
async function _awaitPaneReady(tmuxName, engineId, opts = {}) {
  const profiles = opts.profiles || medusaWake.ENGINE_WAKE_PROFILES;
  const profile = profiles[engineId];
  if (!profile || !profile.idleMarker) {
    return {
      gated: false,
      reason: profile
        ? `engine ${engineId} declares no positive at-rest marker`
        : `engine ${engineId} has no wake profile`
    };
  }
  const capture = opts.capture || ((name, o) => tmux.capturePane(name, o));
  const pollMs = opts.pollMs ?? PANE_READY_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? PANE_READY_TIMEOUT_MS;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const started = now();
  let prevDigest;
  let lastError = null;
  while ((now() - started) < timeoutMs) {
    let cap = null;
    try {
      cap = capture(tmuxName, { lines: PANE_READY_CAPTURE_LINES });
      lastError = null;
    } catch (err) {
      // A capture failure is "not ready yet", not "broken": the pane may not
      // exist for the first instants of a launch. A persistent failure still
      // terminates at the timeout with the error in the reason.
      lastError = err.message;
    }
    if (cap) {
      const lines = cap.lines || [];
      const text = lines.map((l) => medusaWake._strip(l)).join('\n');
      const digest = medusaWake._paneDigest(lines, profile);
      const settled = prevDigest !== undefined && digest === prevDigest;
      prevDigest = digest;
      if (settled && text.includes(profile.idleMarker)) {
        return { gated: true, ready: true, waitedMs: now() - started };
      }
    }
    await sleep(pollMs);
  }
  return {
    gated: true,
    ready: false,
    waitedMs: now() - started,
    reason: lastError
      ? `pane capture kept failing while waiting for '${profile.idleMarker}': ${lastError}`
      : `at-rest marker '${profile.idleMarker}' never rendered with a settled transcript within ${timeoutMs}ms`
  };
}

/**
 * How long to watch for the engine to reject a pasted prime (#1134).
 *
 * Derived, not picked: the reported rejection renders within one render tick of
 * the submit — the #1134 capture had the banner already on screen when the
 * paste went out. This only has to outlast the TUI's own redraw, so it is one
 * order above `PASTE_REJECT_POLL_MS` rather than a guess at engine latency, and
 * a value too SHORT costs a missed downgrade (the pre-existing verdict stands),
 * never a false one.
 */
const PASTE_REJECT_WINDOW_MS = 6000;
/** Poll interval for that watch. */
const PASTE_REJECT_POLL_MS = 600;
/** Pane tail read while watching — the composer plus the lines just above it. */
const PASTE_REJECT_TAIL_LINES = 20;
/**
 * Extra paste attempts after the first, when the engine is SEEN rejecting one.
 *
 * Bounded and small. Only a positively observed rejection arms a retry, so this
 * can never fire on a healthy launch; re-pasting a prime is cheap (it is
 * context, not an action) while a session booted with no prime is the failure
 * this exists to catch.
 */
const PASTE_MAX_RETRIES = 1;
/** Backoff before a re-paste, multiplied by the attempt number. */
const PASTE_RETRY_BACKOFF_MS = 3000;

/**
 * Whether this engine declares a paste-rejection marker (#1134).
 *
 * One owner for the predicate, read by the watch and by the paste path that
 * decides whether to await it — two places asking the same question by hand is
 * how one of them ends up asking a different one.
 *
 * @param {string} engineId - Engine id.
 * @returns {string|null} The marker, or null when the engine declares none.
 */
function _pasteRejectedMarker(engineId) {
  const profile = medusaWake.ENGINE_WAKE_PROFILES[engineId];
  const marker = profile && profile.pasteRejectedMarker;
  return (typeof marker === 'string' && marker.trim()) ? marker : null;
}

/**
 * Send the prime, watch for the engine announcing it discarded it, and retry
 * once if it did (#1134).
 *
 * Extracted from `_deferEngineInit` so the retry loop is reachable by a test.
 * It was not, and that is the whole reason this exists as a function: the loop
 * is the only path here that writes to a live pane twice, which makes it the
 * one least safe to ship unexecuted.
 *
 * Engines declaring no rejection marker take the synchronous path in the
 * caller and never reach this.
 *
 * @param {object} ctx - `tmuxName`, `engineId`, `projectName`, `primeText`,
 *   `readiness`, `onRecord(fields)`, and optional `sleep` / `watch` seams.
 * @returns {Promise<void>}
 */
async function _pastePrime(ctx) {
  const { tmuxName, engineId, projectName, primeText, readiness, onRecord } = ctx;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const watchOpts = ctx.watch || {};

  tmux.sendKeys(tmuxName, primeText, { enter: true });
  let watched = await _observePasteRejected(tmuxName, engineId, watchOpts);

  for (let attempt = 1; attempt <= PASTE_MAX_RETRIES && watched.observed === 'rejected'; attempt++) {
    if (!tmux.probeSession(tmuxName).live) break;
    // Do not paste over a turn in flight. The profile declares a busy marker
    // precisely so nothing injects mid-turn, and `_paneIsBusy` answers `null`
    // rather than `false` when it cannot tell — so an unknown holds the retry.
    const busy = _paneIsBusy(tmuxName, engineId);
    if (busy !== false) {
      watched = {
        observed: 'rejected',
        reason: `${watched.reason}; a retry was due but the pane was ${busy === true ? 'busy' : 'not readable as idle'}`
      };
      break;
    }
    log.info('Re-pasting the prime — the engine reported discarding the previous attempt', {
      project: projectName, engine: engineId, attempt: attempt + 1, reason: watched.reason
    });
    // Known and bounded: the first rejection's banner may still be in the tail
    // when the re-watch runs, which would record a successful retry as
    // `unverified`. That is the downgrade-only direction this whole design
    // biases toward, and PASTE_MAX_RETRIES caps it at one extra send, so it
    // cannot loop. Worth measuring against a live 1.1.22 verify window if one
    // can ever be reproduced.
    await sleep(PASTE_RETRY_BACKOFF_MS * attempt);
    tmux.sendKeys(tmuxName, primeText, { enter: true });
    watched = await _observePasteRejected(tmuxName, engineId, watchOpts);
  }

  if (watched.observed !== 'rejected') {
    // A declared watch that could not answer must not vanish: the row still
    // takes the gate's verdict (unchanged behaviour), but the fact that nothing
    // observed the send is said out loud rather than left in a debug line.
    log.info('Prime paste was not observed being rejected', {
      project: projectName, engine: engineId, observed: watched.observed, reason: watched.reason
    });
  }
  log.debug('Prime prompt injected', { project: projectName, observed: watched.observed });
  onRecord(_primePasteOutcome(readiness, watched));
}

/**
 * Whether a turn is in flight on this pane (#1134 re-paste guard).
 *
 * Three states, not two: an engine with no declared busy marker, or a pane that
 * could not be read, answers `null` — not `false`. The caller re-pastes only on
 * a definite `false`, so an unknown holds the retry rather than injecting over
 * a turn nobody could confirm was finished.
 *
 * @param {string} tmuxName - tmux session.
 * @param {string} engineId - Engine id.
 * @returns {boolean|null} true busy, false idle, null unknown.
 */
function _paneIsBusy(tmuxName, engineId) {
  const profile = medusaWake.ENGINE_WAKE_PROFILES[engineId];
  if (!profile || !profile.busyMarker) return null;
  try {
    const lines = (tmux.capturePane(tmuxName, { lines: PASTE_REJECT_TAIL_LINES }) || {}).lines;
    if (!lines) return null;
    return medusaWake._strip(lines.join('\n')).includes(profile.busyMarker);
  } catch {
    return null;
  }
}

/**
 * Watch a pane after a prime paste for the engine SAYING it discarded it
 * (#1134).
 *
 * **Why the readiness gate is not enough.** #1133's gate observes the pane
 * BEFORE the send: a positive at-rest marker over a settled transcript. On
 * antigravity 1.1.22 a freshly booted CLI renders that complete at-rest UI —
 * bare `>` and `? for shortcuts` — while still verifying the account, and
 * discards anything submitted. Both declared signals passed, the paste went
 * out, the ledger said `delivered`, and no agent brain was ever born from it.
 *
 * **Why this looks for the rejection and not the landing.** Watching the prime
 * arrive was tried first and is not implementable from a pane tail: a real
 * prime is 37–225 lines on this machine, so once it echoes and the engine
 * begins answering, no part of it is still in view, and the check would report
 * "not landed" on every healthy launch — then re-paste the whole prime into a
 * session that already had it. The engine's own rejection text is one line, is
 * on screen at the moment it matters, and is positive evidence rather than the
 * absence of evidence.
 *
 * **The bias this creates, stated.** A swallow the engine does not announce is
 * NOT caught: the outcome falls back to the gate's own verdict, exactly as
 * before this change. That is the honest half of the fix — it closes the
 * reported case without inventing a signal for the unreported one, and it can
 * never manufacture a retry on a healthy launch.
 *
 * @param {string} tmuxName - tmux session.
 * @param {string} engineId - Engine id, for its wake profile.
 * Matched through `medusaWake._strip`, which that module names a production
 * dependency of this path: a TUI writes SGR runs between words, so a raw match
 * stops matching for a reason nothing reports. `_assessPane` strips first for
 * the same reason.
 *
 * @param {object} [opts] - Test seams (`capture`, `now`, `sleep`, `windowMs`).
 * @returns {Promise<{observed: 'rejected'|'no-rejection'|'unmeasured', reason: string}>}
 */
async function _observePasteRejected(tmuxName, engineId, opts = {}) {
  const marker = _pasteRejectedMarker(engineId);
  if (!marker) {
    return {
      observed: 'unmeasured',
      reason: `engine ${engineId} declares no paste-rejection marker (its discarding behaviour has never been measured), so the send was not watched`
    };
  }
  const capture = opts.capture || ((name) => tmux.capturePane(name, { lines: PASTE_REJECT_TAIL_LINES }));
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const windowMs = opts.windowMs || PASTE_REJECT_WINDOW_MS;

  const started = now();
  let lastError = null;
  let sawPane = false;
  while (now() - started < windowMs) {
    try {
      const lines = (capture(tmuxName) || {}).lines || null;
      if (lines) {
        sawPane = true;
        if (medusaWake._strip(lines.join('\n')).includes(marker)) {
          return { observed: 'rejected', reason: `the engine answered the paste with "${marker}"` };
        }
      }
    } catch (err) {
      lastError = err.message;
    }
    await sleep(PASTE_REJECT_POLL_MS);
  }
  if (!sawPane) {
    // Never read the pane at all: that is an unknown, not an absence. Typing it
    // as "no rejection" would let an unreadable pane vouch for a send.
    return {
      observed: 'unmeasured',
      reason: `the pane could not be read while watching for a rejection${lastError ? ` (${lastError})` : ''}, so the send was not observed`
    };
  }
  return { observed: 'no-rejection', reason: `the engine did not report discarding the paste within ${windowMs}ms` };
}

/**
 * Map a readiness-gate result to the ledger row the prime paste writes (#1063).
 *
 * `delivered` is reserved for a paste whose pane was OBSERVED at rest first —
 * `tmux send-keys` not throwing is a fact about the local tmux server, not
 * about what any engine received, and recording it as delivery is how a 100%
 * broken channel produced a clean ledger for 12 days. Anything short of an
 * observed-ready pane records `unverified` with the reason carried through.
 *
 * **An announced rejection outranks the gate (#1134).** A pane observed at rest
 * before the send is not evidence the send was taken: antigravity 1.1.22
 * renders the full at-rest UI while still verifying an account and discards
 * whatever is submitted. So when the engine SAYS it discarded the paste the row
 * is `unverified` even though the gate was satisfied — the reported case, and
 * the one this ordering exists for.
 *
 * It only ever downgrades. A watch that saw no rejection, or could not look,
 * leaves the gate's verdict exactly as it was before this change — so a swallow
 * the engine does not announce is still missed, and nothing here can invent a
 * delivery or a retry the evidence does not support.
 *
 * @param {{gated: boolean, ready?: boolean, reason?: string}} readiness -
 *   Result of `_awaitPaneReady` (or the blind-path literal for markerless engines)
 * @param {{observed: string, reason: string}} [watched] - Result of
 *   `_observePasteRejected`; absent on paths that do not watch.
 * @returns {{outcome: string, skipReason?: string}} Ledger fields for the row
 */
function _primePasteOutcome(readiness, watched) {
  // A rejection the engine ANNOUNCED outranks any pre-send verdict, including a
  // satisfied gate — that combination is #1134 exactly.
  if (watched && watched.observed === 'rejected') {
    return { outcome: 'unverified', skipReason: watched.reason };
  }
  if (readiness && readiness.ready === true) {
    return { outcome: 'delivered' };
  }
  // The gate's own reason is what goes on the durable row; the watch's reason
  // rides along when there is one, so a row for an unobserved send says both
  // why the gate was unsatisfied and why nothing watched the far side.
  const gateReason = (readiness && readiness.reason) || 'paste was not readiness-gated and nothing observed the pane';
  return {
    outcome: 'unverified',
    skipReason: watched && watched.reason ? `${gateReason}; ${watched.reason}` : gateReason
  };
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
  //
  // Engines with a positive at-rest marker are readiness-gated (#999): the
  // paste waits for the marker to render over a settled transcript instead of
  // for a guessed number of milliseconds. A fixed 1500ms was adequate until
  // 2026-08-18 and silently inadequate after — a fixed delay racing someone
  // else's boot always ends this way, which is `ea2bfad`'s bug generalized
  // instead of re-fixed per engine. Markerless engines keep their declared
  // fixed delay, and that blind paste records `unverified`, never `delivered`.
  if (primeText && !silentPrime && engineProfile.capabilities && engineProfile.capabilities.supportsPrimePrompt) {
    const wakeProfile = medusaWake.ENGINE_WAKE_PROFILES[engineId];
    const gated = !!(wakeProfile && wakeProfile.idleMarker);
    const startupDelay = (engineProfile.launch && engineProfile.launch.startupDelay) || 1500;
    const pasteAt = delay + (gated ? 0 : startupDelay);

    const paste = async (readiness) => {
      // The ledger row this writes is DURABLE, so the reason it records has to
      // be one that was actually established. `hasSession` answers false both
      // for a pane that ended and for a tmux server that would not reply, and
      // recording "the session ended" for the second is a fact nobody observed
      // — the third site on #908's census, and the one whose write outlives the
      // condition that caused it.
      const primeProbe = tmux.probeSession(tmuxName);
      if (!primeProbe.live) {
        // The paste is skipped either way — it needs the server that just failed
        // to answer — but WHY it was skipped is not the same in both cases, and
        // the ledger is read later by someone asking whether the rules arrived.
        if (deliveryBase) {
          _recordRuleDelivery({
            ...deliveryBase,
            channel: 'prime-paste',
            outcome: 'skipped',
            skipReason: primeProbe.answered
              ? 'tmux session ended before the prime was pasted'
              : 'could not establish whether the tmux session was still running when the '
                + 'prime was due to be pasted — tmux did not answer'
          });
        }
        return;
      }
      try {
        log.debug('Injecting prime prompt', {
          project: projectName, engine: engineId, length: primeText.length,
          readinessGated: readiness.gated, paneReady: readiness.ready === true,
          waitedMs: readiness.waitedMs
        });
        const record = (fields) => {
          if (deliveryBase) _recordRuleDelivery({ ...deliveryBase, channel: 'prime-paste', ...fields });
        };

        // An engine that declares no rejection marker keeps this path exactly as
        // it was — synchronous, one send, the gate's own verdict. The await
        // below is not free: it moves the ledger write into a microtask, so
        // making every engine take it would change WHEN the row appears for
        // engines this change has no evidence about.
        if (!_pasteRejectedMarker(engineId)) {
          tmux.sendKeys(tmuxName, primeText, { enter: true });
          log.debug('Prime prompt injected', { project: projectName, observed: 'not-watched' });
          record(_primePasteOutcome(readiness));
          return;
        }

        // #1134 — send, then WATCH. The readiness gate answers a question about
        // the pane before the send; on antigravity 1.1.22 a booting CLI renders
        // the complete at-rest UI and still discards what is submitted, so the
        // gate passed, the paste went out, the ledger said `delivered`, and no
        // agent was ever born from it.
        await _pastePrime({
          tmuxName, engineId, projectName, primeText, readiness,
          onRecord: record
        });
      } catch (err) {
        log.warn('Failed to inject prime prompt', { project: projectName, error: err.message });
        if (deliveryBase) {
          _recordRuleDelivery({ ...deliveryBase, channel: 'prime-paste', outcome: 'skipped', skipReason: `tmux send-keys failed: ${err.message}` });
        }
      }
    };

    setTimeout(() => {
      if (gated) {
        _awaitPaneReady(tmuxName, engineId)
          .then(paste)
          .catch((err) => {
            // The gate must never lose the paste: an unexpected throw degrades
            // to the blind path with the failure carried into the ledger row.
            paste({ gated: true, ready: false, reason: `readiness gate failed: ${err.message}` });
          });
      } else {
        paste({
          gated: false,
          reason: `engine ${engineId} declares no at-rest marker — pasted blind after a fixed ${startupDelay}ms delay`
        });
      }
    }, pasteAt);
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
    const filePath = tcProjectFiles.resolveIn(projectPath, tcProjectFiles.SESSION_PRIME_RELPATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
    const filePath = tcProjectFiles.resolveIn(projectPath, tcProjectFiles.SESSION_PRIME_RELPATH);
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

        // Liveness before resurrection (#836). A DB row saying `active` is not
        // evidence a session exists: the row survives a crash, and re-registering
        // from it put phantom workspaces back on the roster reporting
        // `connected: true` — so peers addressed sessions that were gone and
        // their messages queued into nothing. Three-valued, like every other
        // tmux read in this codebase.
        const probe = tmux.probeSession(active.tmuxSession);
        if (probe.answered && !probe.live) {
          store.sessions.markCrashed(active.id, 'tmux session died');
          _teardownMedusa(project, active);
          log.warn('Reaped a dead session instead of re-syncing its Medusa listener', { project: project.name, session: active.id });
          continue;
        }
        if (!probe.answered) {
          // Deliberately does NOT resurrect. A listener claiming `connected` for
          // a session nobody could verify is the exact lie this issue is about,
          // and an honest absence is recoverable with one toggle while a phantom
          // is not recoverable by the peer that trusted it. The cost is real —
          // a briefly unresponsive tmux at boot leaves listeners off — so it is
          // logged rather than silent, and the delivery ledger (#792) shows it.
          log.warn('Skipped a Medusa re-sync: tmux did not answer, so session liveness is unknown', { project: project.name, session: active.id, cause: probe.cause });
          continue;
        }

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
  detectAtPrompt,
  // Exported so the wrap-level publish/abandon decision is reachable from a
  // test. It is the seam between the pipeline's result rows and the handoff
  // store, and it decides across six branches — the isolated unit tests on
  // either side of it cannot see a mis-wiring here.
  _stagedHandoff,
  _finalizeHandoff,
  _atPromptState,
  launchSession,
  launchWebuiSession,
  generatePrimePrompt,
  renderLaunchSteps,
  LAUNCH_STEP_IDS,
  LAUNCH_BOOTSTRAP_LINES,
  buildStartupRulesSection,
  resolveRulesCarrier,
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
  clipboard,
  startWrap,
  triggerWrap,
  getWrapRunStatus,
  subscribeWrapRun,
  getWrapPrStatus,
  completeWrap,
  killSession,
  getSessionHistory,
  _apiOrigin,
  _buildLaunchCommand,
  _withPathFloor,
  _resolvePreKeys,
  _awaitPaneReady,
  _observePasteRejected,
  _pasteRejectedMarker,
  _paneIsBusy,
  _pastePrime,
  _primePasteOutcome,
  PANE_READY_POLL_MS,
  PANE_READY_TIMEOUT_MS,
  _parseSqliteUtcMs,
  // Test seam — see the same export on `lib/tmux.js`.
  _conditionLog: conditionLog
};
