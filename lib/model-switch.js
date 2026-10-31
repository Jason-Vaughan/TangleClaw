'use strict';

/**
 * Governed model/engine switch for a live TangleClaw session (#2598).
 *
 * Two modes:
 *  - **`boundary`** (default): the safe path. A target session is switched
 *    only once it is provably at a clean chunk boundary — the same facts
 *    `tc workload show` already composes (clearance, an empty inbox, a clean
 *    git tree with nothing unpushed) — so a prompt KV cache is never
 *    reprocessed mid-thread and no in-flight work is lost. Not at boundary:
 *    refused with the specific blockers, nothing touched.
 *  - **`outage-takeover`**: the unsafe-but-necessary path, for a session that
 *    has stopped answering. Nothing is asked of the session itself —
 *    whatever uncommitted work its worktree holds is first snapshotted onto a
 *    deterministic recovery branch, then the session is terminated and the
 *    project's engine is switched, so a human (or the next launch) can find
 *    the work again under a name that does not depend on remembering to look.
 *
 * Validation ({@link validateSwitchTarget}) always runs first, through
 * {@link module:lib/engine-models} when the target engine's profile declares
 * a `models` block, and is refused outright for an unknown engine or a
 * malformed model id regardless of mode.
 *
 * **Scope note**: this module persists the engine half of a switch through
 * the real, existing mechanism (`store.projects.update(..., {engine_id})`).
 * There is, as of this writing, no persisted per-project `model`/`effort`
 * field on `main` — that lands with #2188's Session Profile Reconciler
 * (`lib/project-config.js`, out of this module's authorized scope) — so the
 * model/effort half is persisted additively, as plain extra keys on
 * `.tangleclaw/project.json` (`load`/`save` round-trip any key verbatim; see
 * `lib/project-config.js#load`). Reconciling this with #2188's own field once
 * it merges is a follow-up, not silently invented here.
 *
 * Every side effect — reading/writing the target's config, clearing or
 * relaunching its pane, committing its worktree, killing its session — goes
 * through an injectable `deps` entry with a real default, so a test exercises
 * the exact same decision logic production does without touching a real git
 * worktree, tmux pane, or database.
 *
 * @module lib/model-switch
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('./store');
const sessions = require('./sessions');
const engineModels = require('./engine-models');
const workloadFleet = require('./workload-fleet');
const medusa = require('./medusa');

/** The two switch modes this module knows. */
const MODES = Object.freeze(['boundary', 'outage-takeover']);

/** A model id is the same shape `lib/engine-models.js` accepts. */
const { isWellFormedModelId } = engineModels;

/** An engine id is a path segment elsewhere in this codebase; same shape here. */
const ENGINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Refuse unless `cond` holds.
 * @param {boolean} cond
 * @param {string} msg
 * @returns {void}
 */
function _need(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Validate a switch target `{engine, model}` against what is actually
 * installed — through {@link module:lib/engine-models} when the target
 * engine's profile declares a `models` block, or refusing outright for an
 * unknown engine or a malformed id either field could never be.
 * @param {{engine: *, model: *}} target
 * @param {object} [deps] - Seam: `getEngineProfile` (defaults to `store.engines.get`).
 * @returns {{ok: true}|{ok: false, code: string, reason: string}}
 */
function validateSwitchTarget({ engine, model }, deps = {}) {
  const getEngineProfile = deps.getEngineProfile || ((id) => store.engines.get(id));
  if (typeof engine !== 'string' || !ENGINE_ID_RE.test(engine)) {
    return { ok: false, code: 'ENGINE_MALFORMED', reason: 'engine must be a short id of letters, digits, dots, hyphens or underscores' };
  }
  if (!isWellFormedModelId(model)) {
    return { ok: false, code: 'MODEL_MALFORMED', reason: 'model must be a model id (letters, digits, dots, hyphens, underscores, starting with a letter or digit)' };
  }
  let profile;
  try {
    profile = getEngineProfile(engine);
  } catch {
    profile = null;
  }
  if (!profile) {
    return { ok: false, code: 'ENGINE_UNKNOWN', reason: `"${engine}" is not an installed engine` };
  }
  // Forwarded as-is: `checkSelection`'s roster reader only looks at
  // `readFile`/`now`/`env`/`homedir`/`display`, none of which collide with
  // this function's own `getEngineProfile` seam, so one `deps` object serves
  // both without a test needing to pass two.
  return engineModels.checkSelection(profile, model, deps);
}

/**
 * The live session for a named project, or null.
 * @param {string} sessionName - A project name (TangleClaw sessions are per-project).
 * @returns {{project: object, session: (object|null)}|null} null when the project itself does not exist.
 */
function _resolve(sessionName) {
  const project = store.projects.getByName(sessionName);
  if (!project) return null;
  return { project, session: store.sessions.getActive(project.id) };
}

/**
 * The real default boundary check: clearance from the same fleet composition
 * `tc workload show`/`tc sessions` read, an empty switchboard inbox, and a
 * clean git tree with nothing unpushed.
 * @param {{project: object, session: object}} target
 * @param {object} deps - Seams: `observer` (required — the live activity
 *   observer instance; see `lib/routes/sessions.js`'s own `register(deps)`),
 *   `execGit` (defaults to a real `execFileSync('git', …)`).
 * @returns {{atBoundary: boolean, blockers: string[], details: object}}
 */
function _defaultCheckBoundary({ project, session }, deps) {
  const blockers = [];
  const lane = workloadFleet.laneFor(session, { observer: deps.observer, projectName: project.name });
  const clearance = lane.composed.clearance;
  if (clearance !== 'safe-to-clear') blockers.push(`clearance is "${clearance}", not "safe-to-clear"`);

  const inbox = medusa.getMessages(session.id);
  const inboxDrained = inbox.length === 0;
  if (!inboxDrained) blockers.push(`${inbox.length} message(s) still in the switchboard inbox`);

  const execGit = deps.execGit || ((args) => execFileSync('git', args, { cwd: project.path, encoding: 'utf8' }));
  let gitClean = false;
  let noUnpushedCommits = false;
  let gitReason = null;
  try {
    const status = execGit(['status', '--porcelain']);
    gitClean = status.trim().length === 0;
    if (!gitClean) blockers.push('git worktree is not clean');
  } catch (err) {
    gitReason = `git status failed: ${err.message}`;
    blockers.push(gitReason);
  }
  try {
    const ahead = execGit(['rev-list', '@{u}..', '--count']).trim();
    noUnpushedCommits = ahead === '0';
    if (!noUnpushedCommits) blockers.push(`${ahead} unpushed commit(s)`);
  } catch (err) {
    blockers.push(`could not check for unpushed commits: ${err.message}`);
  }

  return {
    atBoundary: blockers.length === 0,
    blockers,
    details: { clearance, inboxDrained, gitClean, noUnpushedCommits }
  };
}

/**
 * Apply `{engine, model, effort}` to a project's persisted config. See this
 * module's own doc comment for the scope note on `model`/`effort`.
 * @param {object} project - A project row (`id`, `path`).
 * @param {{engine: string, model: string, effort: (string|undefined)}} target
 * @param {object} deps - Seams: `updateProjectEngine`, `loadProjectConfig`, `saveProjectConfig`.
 * @returns {void}
 */
function _applyToProjectConfig(project, { engine, model, effort }, deps) {
  const updateProjectEngine = deps.updateProjectEngine || ((id, engineId) => store.projects.update(id, { engine_id: engineId }));
  const loadProjectConfig = deps.loadProjectConfig || ((p) => store.projectConfig.load(p));
  const saveProjectConfig = deps.saveProjectConfig || ((p, cfg) => store.projectConfig.save(p, cfg));
  updateProjectEngine(project.id, engine);
  const config = loadProjectConfig(project.path);
  saveProjectConfig(project.path, { ...config, model, ...(effort !== undefined ? { effort } : {}) });
}

/**
 * Switch a live session's `{engine, model, effort}`.
 * @param {string} sessionName - The project name whose session is switched.
 * @param {object} opts
 * @param {string} opts.engine - Target engine id.
 * @param {string} opts.model - Target model id.
 * @param {string} [opts.effort] - Target effort level, when the engine takes one.
 * @param {'boundary'|'outage-takeover'} [opts.mode] - Defaults to `'boundary'`.
 * @param {string} [opts.reason] - Why, for the audit trail / kill reason.
 * @param {object} [deps] - Injected seams. `checkBoundary(target, deps)` overrides
 *   {@link _defaultCheckBoundary} (boundary mode only); `observer` is required
 *   in boundary mode unless `checkBoundary` is overridden; `refreshSession`,
 *   `killSession`, `execGit`, `updateProjectEngine`, `loadProjectConfig`,
 *   `saveProjectConfig`, `now` round out the rest.
 * @returns {{ok: true, mode: string, [wipBranch]: string, [handoff]: object}
 *   |{ok: false, status: number, code: string, error: string, [blockers]: string[]}}
 */
function switchSessionModel(sessionName, opts, deps = {}) {
  const mode = opts.mode || 'boundary';
  if (!MODES.includes(mode)) {
    return { ok: false, status: 400, code: 'MODE_INVALID', error: `mode must be one of ${MODES.join(', ')}` };
  }
  const validation = validateSwitchTarget({ engine: opts.engine, model: opts.model }, deps);
  if (!validation.ok) {
    return { ok: false, status: 400, code: validation.code, error: validation.reason };
  }
  const resolved = _resolve(sessionName);
  if (!resolved) {
    return { ok: false, status: 404, code: 'PROJECT_NOT_FOUND', error: `Project "${sessionName}" not found` };
  }
  const { project, session } = resolved;

  if (mode === 'outage-takeover') {
    if (!session) {
      return { ok: false, status: 409, code: 'NO_ACTIVE_SESSION', error: `"${sessionName}" has no active session to take over` };
    }
    // A distinct seam name from any `deps.now` a caller might also be using
    // to stub `lib/engine-models.js`'s roster-freshness clock (reached via
    // `validateSwitchTarget` above, through the SAME `deps` object) — sharing
    // one key would make a test's branch-timestamp stub silently answer the
    // roster's freshness check too.
    const branchTimestamp = deps.branchTimestamp || Date.now;
    const wipBranch = `wip/${project.name}-outage-${branchTimestamp()}`;
    const execGit = deps.execGit || ((args) => execFileSync('git', args, { cwd: project.path, encoding: 'utf8' }));
    let snapshot = { committed: false, branch: wipBranch };
    try {
      const status = execGit(['status', '--porcelain']);
      if (status.trim().length > 0) {
        execGit(['checkout', '-b', wipBranch]);
        execGit(['add', '-A']);
        execGit(['commit', '-m', `Outage takeover snapshot (#2598): ${opts.reason || 'unresponsive session'}`]);
        snapshot.committed = true;
      }
    } catch (err) {
      return { ok: false, status: 500, code: 'SNAPSHOT_FAILED', error: `could not snapshot the worktree: ${err.message}` };
    }
    const killSession = deps.killSession || ((name, reason) => sessions.killSession(name, reason));
    const killResult = killSession(project.name, opts.reason || 'outage takeover (#2598)');
    _applyToProjectConfig(project, opts, deps);
    return {
      ok: true,
      mode: 'outage-takeover',
      // null, not the attempted name, when there was nothing to commit: a
      // caller must be able to tell "no snapshot was needed" from "a branch
      // exists" without re-deriving it from `handoff.snapshot.committed`.
      wipBranch: snapshot.committed ? wipBranch : null,
      handoff: {
        project: project.name,
        snapshot,
        sessionTerminated: !killResult || !killResult.error,
        appliedEngine: opts.engine,
        appliedModel: opts.model,
        appliedEffort: opts.effort || null
      }
    };
  }

  // mode === 'boundary'
  if (!session) {
    return { ok: false, status: 409, code: 'NO_ACTIVE_SESSION', error: `"${sessionName}" has no active session to switch` };
  }
  const checkBoundary = deps.checkBoundary || ((target, d) => _defaultCheckBoundary(target, d));
  const boundary = checkBoundary({ project, session }, deps);
  if (!boundary.atBoundary) {
    return {
      ok: false, status: 409, code: 'SESSION_NOT_AT_BOUNDARY',
      error: `"${sessionName}" is not at a clean chunk boundary: ${boundary.blockers.join('; ')}`,
      blockers: boundary.blockers
    };
  }

  const sameProvider = project.engineId === opts.engine;
  const refreshSession = deps.refreshSession || ((p, s, same) => (same
    ? sessions.injectCommand(p.name, '/clear', { enter: true })
    : (sessions.killSession(p.name, 'governed model switch (#2598)'), sessions.launchSession(p.name, { engineOverride: opts.engine }))));
  refreshSession(project, session, sameProvider);
  _applyToProjectConfig(project, opts, deps);

  return {
    ok: true,
    mode: 'boundary',
    sameProvider,
    appliedEngine: opts.engine,
    appliedModel: opts.model,
    appliedEffort: opts.effort || null
  };
}

/**
 * Whether a coordinator/decider's silence warrants a 1-click Operator
 * escalation: it has gone unresponsive past its own timeout AND is already
 * reporting degraded, not merely slow.
 * @param {object} status
 * @param {string} status.deciderName - e.g. `'TC-Lane-PM'`.
 * @param {string} status.deciderRole - `'PM'` or `'Architect'`.
 * @param {number} status.lastDeliveryAt - Epoch ms of the last delivery that reached it.
 * @param {number} status.timeoutMs - How long a silence may run before it counts.
 * @param {('degraded'|'healthy'|'unknown')} status.health - Its own last reported health.
 * @param {object} [deps] - Seam: `now`.
 * @returns {{shouldEscalate: boolean, payload: ({kind: string, text: string, receipts: Array}|null)}}
 */
function checkDeciderOutageEscalation(status, deps = {}) {
  const now = (deps.now || Date.now)();
  const silentMs = now - status.lastDeliveryAt;
  const timedOut = silentMs > status.timeoutMs;
  const degraded = status.health === 'degraded';
  if (!timedOut || !degraded) return { shouldEscalate: false, payload: null };
  return {
    shouldEscalate: true,
    payload: {
      kind: 'operator-action-required',
      text: `${status.deciderRole} ${status.deciderName} has been silent for ${Math.round(silentMs / 60000)}m past its ${Math.round(status.timeoutMs / 60000)}m timeout and is reporting degraded health. Confirm an outage takeover (governed model/engine switch, #2598) or failover to a standing backup decider.`,
      receipts: []
    }
  };
}

module.exports = {
  validateSwitchTarget,
  switchSessionModel,
  checkDeciderOutageEscalation
};
