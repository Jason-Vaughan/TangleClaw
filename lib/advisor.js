'use strict';

/**
 * The persistent Morpheus 🕶️ `Advisor` role (#2819, #2817-C) — a second
 * global singleton beside Project Master (`lib/master.js`), deliberately
 * much simpler: Master has a tiered, operator-set access level with a
 * structural PreToolUse write-guard; the Advisor has exactly one tier,
 * always zero-privilege. There is no guard to regenerate and no `write`
 * carve-out, because there is nothing it is ever permitted to write outside
 * its own sandbox: isolation is enforced once, at launch, by starting the
 * engine with its destructive/shell tools disabled (`_toolStrippedLaunchCommand`),
 * never by a running process re-checking itself.
 *
 * Harness-session-backed like the Master (a persistent engine session in a
 * reserved tmux session, not a TC-owned chat loop), in its own home
 * directory (`~/.tangleclaw/advisor-sandbox/`) — never a project clone, and
 * never the Master's own home. The sandbox is seeded with curated,
 * publicly-shareable TangleClaw knowledge (`knowledge/`) and nothing else:
 * no project workspace, no `tangleclaw.db`, no credentials.
 *
 * Out of this module's scope (Car 59-A, `#2817`/`#2818`, a concurrent
 * sibling car this same wave): the bridge-side wiring that actually feeds an
 * untrusted `advisory-channel` message to this role (`_summonMaster`/
 * `_tellMaster` in `lib/bridge-gateway.js`), the `surface_kind` schema, and
 * the AI-to-AI loop guards. This module only builds the role itself —
 * launch/kill/status/settings, the sandbox, and the mechanical boundary
 * that refuses it everything else — so that sibling work has something to
 * wake once it ships.
 *
 * @module lib/advisor
 */

const fs = require('node:fs');
const path = require('node:path');
const tmux = require('./tmux');
const store = require('./store');
const engines = require('./engines');
const sessions = require('./sessions');
const engineModels = require('./engine-models');
const launchSequence = require('./launch-sequence');
const tangleclawHome = require('./tangleclaw-home');
const sharedDocsAccess = require('./shared-docs-access');
const { createLogger } = require('./logger');

const log = createLogger('advisor');

/** Reserved tmux session name for the Advisor. Never collides with a
 *  project's own tmux name (those come from project records) or with the
 *  Master's (`tangleclaw-master`). */
const ADVISOR_TMUX_SESSION = 'tangleclaw-advisor';

/** Env var the Advisor's pane carries, the same ambient-awareness floor
 *  the Master gets (`TANGLECLAW_ROLE`), read back by `tc whoami` and by
 *  {@link isAdvisorRequest}'s launch-id verification. */
const ADVISOR_ROLE_VALUE = 'advisor';

/**
 * Engines this module has a VERIFIED read-only launch flag for. Tool
 * stripping is the Advisor's whole isolation story (#2817-C item 2), so a
 * launch under an engine not on this list is refused rather than started
 * unverified — the honest failure, not a silent gap. Claude Code's
 * `--disallowedTools` is documented and stable; Codex/Antigravity/Aider
 * equivalents are not yet confirmed against a real pane (the same
 * discipline `docs/engine-guide.md`'s "built and not yet active" entries
 * already follow for unverified engine behavior).
 * @type {Readonly<Record<string, string[]>>}
 */
const READ_ONLY_TOOL_FLAGS = Object.freeze({
  claude: ['--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch']
});

/**
 * Resolve the Advisor's home directory (its session cwd and sandbox root).
 * Distinct from the Master's home and from every project's: this directory
 * is the ENTIRE filesystem surface the Advisor's engine process can reach
 * through its own cwd, by design.
 * @returns {string} Absolute path to the Advisor home
 */
function advisorHome() {
  return path.join(tangleclawHome.baseDir(), 'advisor-sandbox');
}

/**
 * The curated, publicly-shareable knowledge this module seeds into a fresh
 * sandbox. Deliberately small and static for v1 (#2819's own "knowledge
 * sync" acceptance is "auto-populated", not "kept current with every ADR
 * ever written") — each file is overwritten on every {@link ensureAdvisorSandbox}
 * call so a later edit to this module's own curated text reaches an
 * existing install, the same reasoning `lib/master.js`'s CLAUDE.md
 * regeneration already uses for its identity file.
 * @type {Readonly<Record<string, string>>}
 */
const CURATED_KNOWLEDGE = Object.freeze({
  'README.md':
    '# Advisor sandbox\n\n'
    + 'This directory is the entire filesystem the Advisor role can reach. It holds curated, '
    + 'publicly-shareable TangleClaw knowledge only — never a project workspace, never '
    + '`tangleclaw.db`, never credentials. The Advisor launches with its write/shell tools '
    + 'disabled; this directory existing read-only to it is a second, independent layer, not '
    + 'the only one.\n',
  'knowledge/architecture-overview.md':
    '# TangleClaw architecture overview\n\n'
    + 'TangleClaw is a local-first orchestration server for fleets of AI coding sessions. '
    + 'A single Node.js process (`server.js`) owns one SQLite store and talks to each managed '
    + 'project through a reserved tmux pane running an AI engine CLI (Claude Code, Codex, '
    + 'Antigravity, Aider). Two singleton roles sit above every project: Project Master, a '
    + 'persistent cross-project assistant with an operator-set access level, and the Advisor '
    + '(this sandbox), a zero-privilege role for external advisory conversations.\n',
  'knowledge/engineering-principles.md':
    '# How TangleClaw is engineered\n\n'
    + 'Small, focused commits; tests alongside implementation; an independent review pass '
    + '(the "Critic") after medium-or-larger changes; a durable change-log per release. '
    + 'Governed mutations (session control, control holds) commit to the store before any '
    + 'notification is attempted, so "accepted" always means "stored". This sandbox and the '
    + 'role that reads it are themselves an example: isolation is enforced mechanically '
    + '(tool-stripping, a dedicated filesystem root), never only by instruction.\n'
});

/**
 * Create the Advisor home (and its `knowledge/` subdirectory) if absent,
 * and (re)write every curated file — idempotent, and safe to call on every
 * `ensureAdvisorSession` the same way the Master regenerates its identity
 * on every ensure.
 * @param {string} home - Advisor home directory
 * @returns {void}
 */
function ensureAdvisorSandbox(home) {
  fs.mkdirSync(path.join(home, 'knowledge'), { recursive: true, mode: 0o700 });
  for (const [rel, text] of Object.entries(CURATED_KNOWLEDGE)) {
    fs.writeFileSync(path.join(home, rel), text, { mode: 0o600 });
  }
}

/**
 * Normalize the Advisor settings block out of global config, applying
 * shipped defaults for anything missing. `lib/store.js`'s `DEFAULT_CONFIG`
 * is outside this car's file envelope (Car 59-A/59-B are file-disjoint this
 * wave), so — unlike `lib/master.js#masterSettings`, which reads a
 * `DEFAULT_CONFIG.master` that genuinely exists — an absent `config.advisor`
 * here is simply `undefined`, never a shared default object, so no
 * defensive copy is needed before this module writes a new one back.
 * @param {object} config - Global config (`store.config.load()`)
 * @returns {{engine: (string|null), model: (string|null), autoStart: boolean}}
 */
function advisorSettings(config) {
  const raw = (config && typeof config.advisor === 'object' && config.advisor) || {};
  return {
    engine: typeof raw.engine === 'string' && raw.engine ? raw.engine : null,
    model: typeof raw.model === 'string' && raw.model ? raw.model : null,
    autoStart: raw.autoStart === true
  };
}

/**
 * Persist a partial Advisor settings change, merged over what is stored.
 * @param {{engine?: (string|null), model?: (string|null), autoStart?: boolean}} patch
 * @returns {{engine: (string|null), model: (string|null), autoStart: boolean}} The saved settings
 */
function saveAdvisorSettings(patch) {
  const config = store.config.load();
  const current = advisorSettings(config);
  const next = {
    engine: patch.engine !== undefined ? patch.engine : current.engine,
    model: patch.model !== undefined ? patch.model : current.model,
    autoStart: patch.autoStart !== undefined ? patch.autoStart === true : current.autoStart
  };
  config.advisor = { ...next };
  store.config.save(config);
  return next;
}

/**
 * The engine id to launch the Advisor with: the configured one if it is
 * actually installed, else the first installed engine this module has a
 * verified read-only flag for ({@link READ_ONLY_TOOL_FLAGS}) — never an
 * engine this module cannot isolate, configured or not.
 * @param {{engine: (string|null)}} settings - From {@link advisorSettings}
 * @returns {string|null}
 */
function _resolveAdvisorEngineId(settings, enginesLib = engines) {
  const installed = new Set(
    enginesLib.detect({ fresh: true }).filter((r) => r.available).map((r) => r.id)
  );
  if (settings.engine && Object.prototype.hasOwnProperty.call(READ_ONLY_TOOL_FLAGS, settings.engine)
    && installed.has(settings.engine)) {
    return settings.engine;
  }
  for (const candidate of Object.keys(READ_ONLY_TOOL_FLAGS)) {
    if (installed.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Append this engine's verified read-only flag to a built launch command.
 * Refuses (returns `null`) for any engine not in {@link READ_ONLY_TOOL_FLAGS}
 * — the Advisor's tool stripping is its whole isolation story, so an
 * unverified engine must never launch it unstripped.
 * @param {string} baseLaunchCmd - From `sessions._buildLaunchCommand`
 * @param {string} engineId
 * @returns {string|null}
 */
function _toolStrippedLaunchCommand(baseLaunchCmd, engineId) {
  const flag = READ_ONLY_TOOL_FLAGS[engineId];
  if (!flag) return null;
  return `${baseLaunchCmd} ${flag.map((a) => (/^[A-Za-z0-9_.,:@%+/-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ')}`;
}

/**
 * Ensure the Advisor session exists — idempotent. Always creates/refreshes
 * the sandbox; when the reserved tmux session is absent, resolves and
 * admits an engine, strips its tools, and starts it. Never touches an
 * already-running Advisor (no kill/adopt semantics, same as the Master).
 * @param {object} [options]
 * @param {string} [options.home] - Advisor home override (tests)
 * @param {object} [options.tmuxLib] - tmux module override (tests)
 * @param {object} [options.enginesLib] - engines module override (tests)
 * @returns {{created: boolean, tmuxSession: string, home: string, engine?: (string|null), model?: (string|null), error?: string, code?: string}}
 */
function ensureAdvisorSession(options = {}) {
  const t = options.tmuxLib || tmux;
  const eng = options.enginesLib || engines;
  const home = options.home || advisorHome();

  ensureAdvisorSandbox(home);

  const config = store.config.load();
  const settings = advisorSettings(config);
  const engineId = _resolveAdvisorEngineId(settings, eng);
  const base = { tmuxSession: ADVISOR_TMUX_SESSION, home, engine: engineId, model: settings.model };

  const probe = t.probeSession(ADVISOR_TMUX_SESSION);
  if (probe.live) return { created: false, ...base };
  if (!probe.answered) {
    return {
      created: false, ...base, incomplete: ['exists'], cause: probe.cause,
      error: 'Could not determine whether the Advisor is already running — tmux did not answer. Refusing to start a second one over it.'
    };
  }

  if (!engineId) {
    return { created: false, ...base, error: 'No engine with a verified read-only launch flag is installed for the Advisor.' };
  }
  const fetchedProfile = store.engines.get(engineId);
  if (!fetchedProfile) {
    return { created: false, ...base, error: `Engine "${engineId}" not found` };
  }
  const identity = require('./startup-dialog').identify(fetchedProfile, engineId);
  if (!identity.profile) {
    log.warn('Advisor launch refused: the engine profile is not the profile that was asked for', { engineId, detail: identity.detail });
    return {
      created: false, ...base, code: 'ENGINE_PROFILE_INVALID',
      error: `Engine "${engineId}" was not started for the Advisor: its profile is not usable (${identity.detail}).`
    };
  }
  const engineProfile = identity.profile;
  const det = eng.detectEngine(engineProfile, { fresh: true });
  if (!det.available) {
    return { created: false, ...base, error: `Engine "${engineId}" not available (binary not found)` };
  }

  if (settings.model) {
    const check = engineModels.checkSelection(engineProfile, settings.model);
    if (!check.ok) {
      return { created: false, ...base, error: `Advisor model "${settings.model}" could not be selected: ${check.reason}`, code: check.code };
    }
  }

  const baseLaunchCmd = sessions._buildLaunchCommand(engineProfile, null, null, settings.model || null);
  if (!baseLaunchCmd) {
    return { created: false, ...base, error: `Engine "${engineId}" has no launch command` };
  }
  const strippedLaunchCmd = _toolStrippedLaunchCommand(baseLaunchCmd, engineId);
  if (!strippedLaunchCmd) {
    // Unreachable while engineId only ever comes from _resolveAdvisorEngineId,
    // which already filters to READ_ONLY_TOOL_FLAGS -- kept as the honest
    // refusal rather than an assertion, so a future change to that resolver
    // fails closed here instead of launching an unstripped Advisor.
    return { created: false, ...base, error: `No verified read-only launch flag for engine "${engineId}"` };
  }

  const admission = sessions._admitEngineExecutable(engineId, { command: strippedLaunchCmd, enginePath: det.path || null, engineProfile });
  if (!admission.allowed) {
    log.warn('Advisor launch refused before anything was run: the engine executable is not admitted', { engine: engineId, reasonCode: admission.reasonCode, reason: admission.reason });
    return {
      created: false, ...base, code: 'LAUNCH_ISOLATION_UNVERIFIED',
      error: sessions._isolationRefusalMessage('the Advisor', admission),
      isolation: { reasonCode: admission.reasonCode, recovery: admission.recovery }
    };
  }
  const legacy = sessions._isolatedLegacyLaunch(engineId, strippedLaunchCmd, engineProfile, det.path || null);
  let launchCmd = (legacy && legacy.command) || strippedLaunchCmd;
  const isolation = sessions._judgeLaunchIsolation(engineId, {
    command: launchCmd, enginePath: det.path || null, probe: legacy ? legacy.probe : null,
    native: null, engineProfile, builderFault: Boolean(legacy && legacy.fault)
  });
  let overridden = null;
  if (!isolation.allowed) {
    const attempt = sessions._overrideRefusedLaunch(engineId, isolation, {
      launchCmd: strippedLaunchCmd, engineProfile, enginePath: det.path || null, probe: legacy ? legacy.probe : null
    }, null);
    if (!attempt.allowed) {
      log.warn('Advisor launch refused: the engine command is not positively isolated', { engine: engineId, reasonCode: attempt.refusal.reasonCode });
      return {
        created: false, ...base, code: 'LAUNCH_ISOLATION_UNVERIFIED',
        error: sessions._isolationRefusalMessage('the Advisor', attempt.refusal),
        isolation: { reasonCode: attempt.refusal.reasonCode, recovery: attempt.refusal.recovery }
      };
    }
    overridden = attempt.record;
    launchCmd = attempt.command;
    sessions._warnOverriddenLaunch('the Advisor', overridden);
  }

  const ambientEnv = { TANGLECLAW_ROLE: ADVISOR_ROLE_VALUE };
  const advisorApiOrigin = sessions._apiOrigin();
  if (advisorApiOrigin) ambientEnv.TANGLECLAW_API = advisorApiOrigin;
  // The Advisor's own binding, read back by liveAdvisorLaunchId the same way
  // liveMasterLaunchId reads the Master's -- minted here and kept only in
  // the tmux session environment (#2819, mirroring #1626 for the Master).
  ambientEnv.TANGLECLAW_LAUNCH_ID = launchSequence.mintLaunchId();
  const tempRoot = sessions._privateTempRoot(engineId, engineProfile, 'advisor');
  const paneCommand = sessions._withPathFloor(launchCmd);

  try {
    const created = t.createSession(ADVISOR_TMUX_SESSION, {
      cwd: home,
      command: paneCommand,
      env: { ...ambientEnv, ...tempRoot.env, ...(engineProfile.launch ? engineProfile.launch.env : {}) }
    });
    if (!created) return { created: false, ...base, error: `Failed to create tmux session "${ADVISOR_TMUX_SESSION}"` };
  } catch (err) {
    return { created: false, ...base, error: `tmux error: ${err.message}` };
  }

  log.info('Advisor session launched', { tmuxSession: ADVISOR_TMUX_SESSION, home, engine: engineId, model: settings.model, isolation: overridden ? 'none (operator\'s override)' : isolation.isolation });
  if (overridden) sessions._logOverriddenLaunch(overridden, { launchRef: sessions._overrideLaunchRef(ambientEnv.TANGLECLAW_LAUNCH_ID) });
  return { created: true, ...base, ...(overridden ? { isolationOverride: sessions._overrideAnswer(overridden) } : {}) };
}

/**
 * Stop the Advisor's tmux session. Idempotent: an absent Advisor is
 * success, same three-state-probe discipline as `lib/master.js#killMasterSession`.
 * @param {object} [options]
 * @param {object} [options.tmuxLib] - tmux module override (tests)
 * @returns {{killed: boolean, wasRunning: boolean, tmuxSession: string, incomplete: string[], cause: (string|null), error?: string}}
 */
function killAdvisorSession(options = {}) {
  const t = options.tmuxLib || tmux;
  const base = { tmuxSession: ADVISOR_TMUX_SESSION, incomplete: [], cause: null };
  const probe = t.probeSession(ADVISOR_TMUX_SESSION);

  if (!probe.answered) {
    log.warn('Advisor kill refused — tmux liveness could not be established', { cause: probe.cause });
    return {
      ...base, killed: false, wasRunning: false, incomplete: ['exists'], cause: probe.cause,
      error: 'tmux did not answer, so whether the Advisor is running could not be established — nothing was killed.'
    };
  }
  if (!probe.live) {
    log.info('Advisor kill requested, session already absent');
    return { ...base, killed: false, wasRunning: false };
  }
  const killed = t.killSession(ADVISOR_TMUX_SESSION);
  if (!killed) {
    log.warn('Advisor kill could not be confirmed', { cause: 'kill-unconfirmed' });
    return {
      ...base, killed: false, wasRunning: true, incomplete: ['exists'], cause: 'kill-unconfirmed',
      error: 'The Advisor was running, but tmux did not confirm the kill — it may still be running.'
    };
  }
  log.info('Advisor session killed');
  return { ...base, killed: true, wasRunning: true };
}

/**
 * Report whether the Advisor session is alive, plus its effective settings.
 * Liveness truth comes from tmux, same as the Master's status.
 * @param {object} [options]
 * @param {object} [options.tmuxLib] - tmux module override (tests)
 * @param {string} [options.home] - Advisor home override (tests)
 * @returns {{exists: (boolean|null), incomplete: string[], cause: (string|null), tmuxSession: string, home: string, settings: object}}
 */
function getAdvisorStatus(options = {}) {
  const t = options.tmuxLib || tmux;
  const home = options.home || advisorHome();
  const settings = advisorSettings(store.config.load());
  const probe = t.probeSession(ADVISOR_TMUX_SESSION);
  const incomplete = probe.answered ? [] : ['exists'];
  return {
    exists: probe.answered ? probe.live : null,
    incomplete,
    cause: probe.answered ? null : probe.cause,
    tmuxSession: ADVISOR_TMUX_SESSION,
    home,
    settings
  };
}

/**
 * The launch id of the live Advisor, read from its tmux session
 * environment — the only record of it, minted in `ensureAdvisorSession`.
 * `answered: false` means tmux did not reply, and a caller deciding access
 * on this must refuse. `launchId: null` with `answered: true` means there
 * is no live Advisor.
 * @param {object} [options]
 * @param {object} [options.tmuxLib] - tmux module override (tests)
 * @param {number} [options.timeout] - tmux read timeout, ms
 * @returns {{launchId: (string|null), answered: boolean, cause: (string|null)}}
 */
function liveAdvisorLaunchId(options = {}) {
  const t = options.tmuxLib || tmux;
  const readOptions = options.timeout ? { timeout: options.timeout } : {};
  const read = t.readSessionEnv(ADVISOR_TMUX_SESSION, 'TANGLECLAW_LAUNCH_ID', readOptions);
  return { launchId: read.value, answered: read.answered, cause: read.cause };
}

/**
 * Whether a request genuinely comes from the live Advisor: it claims the
 * role (#2819's own `x-tangleclaw-role: advisor` header, the same header
 * `lib/shared-docs-access.js#ROLE_HEADER` already defines for `master`) AND
 * carries the Advisor's own current launch id — never the role claim alone,
 * which is exactly what `sharedDocsAccess.resolveAccess`'s own `master`
 * branch already refuses to trust by itself (a forged header with no
 * matching live launch is `master-unverifiable`, not `master`).
 *
 * Deliberately local to this module rather than a new `KINDS.ADVISOR` in
 * `lib/shared-docs-access.js` (that file is outside this car's file
 * envelope, and `#2817-A`/`#2817-B` build concurrently this same wave) — PM
 * decision, Charter A496 §3: every `#2819` enforcement point stays inside
 * `lib/advisor.js`/`server.js`/`lib/routes/_callers.js`.
 * @param {object} req - The request
 * @param {object} [options] - Forwarded to {@link liveAdvisorLaunchId} (tests)
 * @returns {boolean}
 */
function isAdvisorRequest(req, options = {}) {
  const headers = (req && req.headers) || {};
  if (headers[sharedDocsAccess.ROLE_HEADER] !== ADVISOR_ROLE_VALUE) return false;
  const launchHeader = headers[sharedDocsAccess.LAUNCH_HEADER];
  if (typeof launchHeader !== 'string' || !launchHeader) return false;
  const live = liveAdvisorLaunchId(options);
  return live.answered && live.launchId === launchHeader;
}

module.exports = {
  ADVISOR_TMUX_SESSION,
  ADVISOR_ROLE_VALUE,
  READ_ONLY_TOOL_FLAGS,
  advisorHome,
  ensureAdvisorSandbox,
  advisorSettings,
  saveAdvisorSettings,
  ensureAdvisorSession,
  killAdvisorSession,
  getAdvisorStatus,
  liveAdvisorLaunchId,
  isAdvisorRequest,
  // Test-only internals, named the way lib/master.js names none of its own
  // (it inlines everything) -- kept narrow and explicit here instead.
  _resolveAdvisorEngineId,
  _toolStrippedLaunchCommand
};
