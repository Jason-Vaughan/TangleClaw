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
 * Built on #2188's now-merged infrastructure rather than reinventing it:
 * - The engine half persists through `store.projects.update(..., {engine_id})`;
 *   the model half persists through the SAME `project.json#model` field
 *   #2188's launch path (`lib/sessions.js#launchSession`) already reads,
 *   validates and refuses on at launch time (`MODEL_UNCONFIRMED`) — a
 *   cross-provider switch here (kill, then relaunch) needs no separate
 *   "pass the model through" plumbing because that reader already exists.
 * - A same-provider LIVE switch (no relaunch) goes through
 *   {@link module:lib/profile-reconciler} — `setDesiredProfile` +
 *   `recordCheckpoint` + `reconcile` — the same engine-agnostic, fail-closed
 *   control/verify loop #2188 built for exactly this ("is the profile
 *   actually running the one that was asked for"), under the SAME
 *   `session:<id>` resource-id convention the launch path's own post-launch
 *   verification uses, so one session's admission state is coherent however
 *   it got there. `effort` has no persisted field (none exists in #2188's
 *   schema either) — it reaches the live reconciler only; it is not written
 *   to `project.json`, and a future launch will not see it until #2188 (or a
 *   successor) adds one.
 *
 * Every side effect — reading/writing the target's config, clearing,
 * reconciling or relaunching its pane, committing its worktree, killing its
 * session — goes through an injectable `deps` entry with a real default, so
 * a test exercises the exact same decision logic production does without
 * touching a real git worktree, tmux pane, or database.
 *
 * @module lib/model-switch
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('./store');
const sessions = require('./sessions');
const engineModels = require('./engine-models');
const workloadFleet = require('./workload-fleet');
const medusa = require('./medusa');
const profileReconciler = require('./profile-reconciler');
const continuity = require('./continuity');
const SELF_BOUNDARY_ACTIVITY_REASONS = new Set(['turn-in-flight', 'pane-writing']);

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
  const requester = deps.requester || {};
  const selfRequest = requester.kind === 'project'
    && requester.projectId === project.id
    && requester.sessionId === session.id;
  const receipt = lane.workload.receipt;
  const selfReceiptSafe = lane.workload.provenance === 'explicit-receipt'
    && receipt && receipt.state === 'complete' && receipt.clearance === 'safe-to-clear';
  const selfActivityDiscounted = selfRequest && lane.engine.activity === 'busy'
    && SELF_BOUNDARY_ACTIVITY_REASONS.has(lane.engine.reason);
  const governanceBlocked = ['HELD', 'STOPPED'].includes(lane.composed.availability)
    || Boolean(lane.workload.narrowing);

  let clearance = lane.composed.clearance;
  if (selfRequest) {
    if (governanceBlocked) blockers.push('self switch is blocked by HOLD, STOP, or operator narrowing');
    if (!selfReceiptSafe) blockers.push('self switch requires a current explicit complete/safe receipt');
    if (lane.engine.activity === 'busy' && !selfActivityDiscounted) {
      blockers.push(`self switch may not discount engine activity "${lane.engine.reason}"`);
    }
    if (selfActivityDiscounted && selfReceiptSafe && !governanceBlocked) clearance = receipt.clearance;
  }
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
 * Apply `{engine, model}` to a project's persisted config — `engine_id` on
 * the project row, and both `engine` and `model` in `project.json`, the
 * exact fields `lib/sessions.js#launchSession` reads at next launch
 * (#2188). No persisted field for `effort` exists in that schema; see this
 * module's own doc comment for where `effort` reaches instead (the live
 * reconciler only).
 *
 * #3216 (Pillar 3 — engine SSOT convergence): `engine` is now written into
 * `project.json` alongside `model`, unconditionally — previously only
 * `projects.engine_id` (SQLite) was updated here, leaving a `project.json`
 * file that already names an `engine` field permanently stale the moment
 * it drifted from SQLite. No existing test constrains `project.json`'s
 * exact persisted shape (checked before choosing this), so there is no
 * narrower condition to thread.
 *
 * #3216 (Pillar 3 — PRR-A R1 finding 2): if loading or saving
 * `project.json` throws, SQLite's `engine_id` (already written above) is
 * rolled back to the project's PREVIOUS value before re-throwing — so a
 * failure here never leaves SQLite naming the new engine while
 * `project.json` still names the old one.
 * @param {object} project - A project row (`id`, `path`, `engineId`).
 * @param {{engine: string, model: string}} target
 * @param {object} deps - Seams: `updateProjectEngine`, `loadProjectConfig`, `saveProjectConfig`.
 * @returns {void}
 * @throws {Error} Whatever `loadProjectConfig`/`saveProjectConfig` throws, after rolling SQLite back.
 */
function _applyToProjectConfig(project, { engine, model }, deps) {
  const updateProjectEngine = deps.updateProjectEngine || ((id, engineId) => store.projects.update(id, { engine_id: engineId }));
  const loadProjectConfig = deps.loadProjectConfig || ((p) => store.projectConfig.load(p));
  const saveProjectConfig = deps.saveProjectConfig || ((p, cfg) => store.projectConfig.save(p, cfg));
  const previousEngineId = project.engineId;
  updateProjectEngine(project.id, engine);
  try {
    const config = loadProjectConfig(project.path);
    saveProjectConfig(project.path, { ...config, engine, model });
  } catch (err) {
    // #3216 (Pillar 3 — PRR-A R1 finding 2): SQLite's `engine_id` was just
    // updated above; if `project.json` can't be read or written, roll
    // SQLite back to what it held before this call rather than leave the
    // two split — a caller that sees this throw must never find the NEW
    // engine live in SQLite while `project.json` still names the OLD one
    // (or a partially-written file). Re-thrown so the caller's existing
    // behavior (an uncaught failure here fails the whole switch) is
    // unchanged; only the persisted state's consistency is new.
    updateProjectEngine(project.id, previousEngineId);
    throw err;
  }
}

/**
 * The most recently modified `.md` plan under `<projectPath>/.tangleclaw/plans`,
 * or null when there is no such directory or no plan in it. A continuity
 * handoff names this so whoever finds a relaunched or successor session can
 * locate the plan that was in progress — the same thing a `/clear` leaves
 * discoverable for free, which a kill (same- or cross-provider) does not.
 * @param {string} projectPath
 * @param {object} [deps] - Seam: `fs`.
 * @returns {string|null}
 */
function _findActivePlanPath(projectPath, deps = {}) {
  const fsImpl = deps.fs || fs;
  const plansDir = path.join(projectPath, '.tangleclaw', 'plans');
  let entries;
  try {
    entries = fsImpl.readdirSync(plansDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile || !entry.isFile() || !entry.name.endsWith('.md')) continue;
    const full = path.join(plansDir, entry.name);
    let mtimeMs;
    try {
      mtimeMs = fsImpl.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
  }
  return newest ? newest.path : null;
}

/**
 * Write a deterministic continuity handoff record under
 * `<project.path>/.tangleclaw/<filename>` before a kill (same- or
 * cross-provider boundary switch, or outage-takeover) that a relaunch or
 * successor session's operator can read to pick the work back up. Best
 * effort: a write failure is logged, never thrown — a continuity NOTE must
 * not block the switch/recovery it exists to assist.
 * @param {object} project - A project row (`path`, `name`).
 * @param {string} filename - Bare filename under `.tangleclaw/`.
 * @param {object} body - Serialized as-is, plus `writtenAt`.
 * @param {object} [deps] - Seams: `fs`, `now`, `log`.
 * @returns {{written: boolean, path: string}}
 */
function _writeContinuityHandoff(project, filename, body, deps = {}) {
  const fsImpl = deps.fs || fs;
  const dir = path.join(project.path, '.tangleclaw');
  const file = path.join(dir, filename);
  const now = deps.now || Date.now;
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(file, JSON.stringify({ ...body, writtenAt: new Date(now()).toISOString() }, null, 2) + '\n');
    return { written: true, path: file };
  } catch (err) {
    (deps.log || console).warn(`model-switch: could not write continuity handoff ${file}: ${err.message}`);
    return { written: false, path: file };
  }
}

/**
 * Write BOTH continuity artifacts a kill (same- or cross-provider boundary
 * switch, or outage-takeover) must leave behind before it proceeds: this
 * module's own detailed JSON handoff ({@link _writeContinuityHandoff}), and
 * the REAL continuity index (`lib/continuity.js#writeIndex`) that
 * `lib/sessions.js#_resumeSource` actually reads back at the next launch —
 * confirmed by reading that function directly, not assumed. Fails CLOSED:
 * a caller that cannot record where the work went must refuse rather than
 * kill the session anyway and lose the only trail back to it.
 * @param {object} project - A project row (`path`, `name`).
 * @param {string} filename - Bare filename for the JSON handoff under `.tangleclaw/`.
 * @param {object} jsonBody - Passed to {@link _writeContinuityHandoff}.
 * @param {{currentState: string, nextAction: string, freshness: object}} indexFields - Passed to `continuity.writeIndex`.
 * @param {object} [deps] - Seams: `writeContinuityHandoff`, `writeContinuityIndex`.
 * @returns {{ok: boolean, handoffPath: (string|null), error: (string|null)}}
 */
function _writeContinuity(project, filename, jsonBody, indexFields, deps = {}) {
  const writeContinuityHandoff = deps.writeContinuityHandoff || ((proj, fname, body) => _writeContinuityHandoff(proj, fname, body, deps));
  const writeContinuityIndex = deps.writeContinuityIndex || ((proj, fields) => continuity.writeIndex(proj.path, fields));
  // PRR-A WARNING (Round 4, #2598): `continuity.writeIndex` fully REGENERATES
  // the index file from the fields it is given — an `indexFields` with no
  // `map` key renders the Map section as empty (`renderIndex`'s own
  // behavior), silently wiping any curated Map a prior wrap had accreted.
  // `readIndexRaw` (distinct from `readIndex`) already returns the FULLY
  // PARSED existing index, or `null` if there is none — it does its own
  // `parseIndex` internally, so calling `parseIndex` on its result again
  // would throw (it expects raw text, not an already-parsed object).
  const readExistingMap = deps.readExistingMap || ((proj) => {
    const existingParsed = continuity.readIndexRaw(proj.path);
    return existingParsed && existingParsed.map ? existingParsed.map : undefined;
  });
  const handoffWrite = writeContinuityHandoff(project, filename, jsonBody);
  if (!handoffWrite.written) {
    return { ok: false, handoffPath: null, error: `could not write ${filename}` };
  }
  try {
    const mapOverride = indexFields.map !== undefined ? indexFields.map : readExistingMap(project);
    writeContinuityIndex(project, { ...indexFields, map: mapOverride });
  } catch (err) {
    return { ok: false, handoffPath: handoffWrite.path, error: `could not write the continuity index: ${err.message}` };
  }
  return { ok: true, handoffPath: handoffWrite.path, error: null };
}

/**
 * The refusal for an `effort` override that names a RELAUNCH path
 * (cross-provider boundary, or outage-takeover): neither can verify it
 * reached the new process the way the live reconciler verifies `model`,
 * and #2188's launch path has no persisted `effort` field to even carry
 * it forward to. Refusing explicitly, rather than silently dropping it or
 * reporting it applied, is the whole point — #2598's target is
 * `{engine, model, effort}`, and a field this module cannot honor must say
 * so.
 * @returns {{ok: false, status: 400, code: 'EFFORT_UNSUPPORTED_ON_RELAUNCH', error: string}}
 */
function _effortUnsupportedOnRelaunch() {
  return {
    ok: false, status: 400, code: 'EFFORT_UNSUPPORTED_ON_RELAUNCH',
    error: 'Effort override cannot be verified across a full session relaunch; switch engine/model first, then apply effort via a same-provider boundary switch.'
  };
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
 * @returns {Promise<{ok: true, mode: string, [wipBranch]: string, [handoff]: object}
 *   |{ok: false, status: number, code: string, error: string, [blockers]: string[]}>}
 */
async function switchSessionModel(sessionName, opts, deps = {}) {
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
    if (opts.effort) {
      return _effortUnsupportedOnRelaunch();
    }
    // A distinct seam name from any `deps.now` a caller might also be using
    // to stub `lib/engine-models.js`'s roster-freshness clock (reached via
    // `validateSwitchTarget` above, through the SAME `deps` object) — sharing
    // one key would make a test's branch-timestamp stub silently answer the
    // roster's freshness check too.
    const branchTimestamp = deps.branchTimestamp || Date.now;
    const execGit = deps.execGit || ((args) => execFileSync('git', args, { cwd: project.path, encoding: 'utf8' }));
    const _branchExists = (name) => {
      try {
        execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
        return true;
      } catch {
        return false;
      }
    };
    // Collision-safe: two outages the same millisecond (or a prior run's
    // branch never cleaned up) must never silently reuse or overwrite a
    // name already in use.
    let wipBranch = `wip/${project.name}-outage-${branchTimestamp()}`;
    for (let i = 1; _branchExists(wipBranch); i++) wipBranch = `wip/${project.name}-outage-${branchTimestamp()}-${i}`;
    let originalBranch = null;
    try {
      originalBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    } catch {
      // No branch to restore to (detached HEAD, or git itself unreadable) —
      // the restore-on-failure step below is skipped, not refused on.
    }
    let snapshot = { committed: false, branch: wipBranch };
    try {
      const status = execGit(['status', '--porcelain']);
      if (status.trim().length > 0) {
        execGit(['checkout', '-b', wipBranch]);
        try {
          execGit(['add', '-A']);
          execGit(['commit', '-m', `Outage takeover snapshot (#2598): ${opts.reason || 'unresponsive session'}`]);
          snapshot.committed = true;
        } catch (commitErr) {
          // A half-made recovery branch is worse than none: leave the
          // worktree back where it started rather than parked on a branch
          // that never got its snapshot commit.
          if (originalBranch) {
            try { execGit(['checkout', originalBranch]); } catch { /* best effort restore */ }
          }
          throw commitErr;
        }
      }
    } catch (err) {
      return { ok: false, status: 500, code: 'SNAPSHOT_FAILED', error: `could not snapshot the worktree: ${err.message}` };
    }
    // A continuity handoff, written BEFORE the kill: the plan a human or
    // the successor session should pick back up, named once here rather
    // than left to be rediscovered after the fact. Two artifacts, both
    // required (fails CLOSED, before the kill, if either cannot be
    // written): this module's own detailed JSON, and the REAL continuity
    // index `lib/sessions.js#_resumeSource` reads back at the successor's
    // launch (`continuity.readIndex`) — confirmed by reading that function
    // directly.
    const findActivePlanPath = deps.findActivePlanPath || ((p) => _findActivePlanPath(p, deps));
    const planPath = findActivePlanPath(project.path);
    const takeoverWipBranch = snapshot.committed ? wipBranch : null;
    const continuityResult = _writeContinuity(
      project,
      'outage-handoff.json',
      {
        project: project.name, mode: 'outage-takeover', reason: opts.reason || null,
        sessionId: session.id, wipBranch: takeoverWipBranch, planPath,
        appliedEngine: opts.engine, appliedModel: opts.model, appliedEffort: opts.effort || null
      },
      {
        project: project.name,
        currentState: `Outage takeover from session ${session.id}; worktree snapshot ${takeoverWipBranch ? `committed on branch ${takeoverWipBranch}` : 'was not needed (clean tree)'}${planPath ? ` (active plan: ${planPath})` : ''}.`,
        nextAction: takeoverWipBranch
          ? `Check out or inspect branch ${takeoverWipBranch}${planPath ? ` and resume the active plan ${planPath}` : ''} (see .tangleclaw/outage-handoff.json).`
          : `Nothing was uncommitted to recover — the switch to ${opts.engine}/${opts.model} applies cleanly.`,
        freshness: { sha: null, branch: takeoverWipBranch || '', writtenAt: new Date().toISOString(), tier: 'outage-takeover' }
      },
      deps
    );
    if (!continuityResult.ok) {
      return {
        ok: false, status: 500, code: 'HANDOFF_WRITE_FAILED',
        error: `could not record the outage-takeover handoff before terminating the session: ${continuityResult.error}`,
        wipBranch: takeoverWipBranch
      };
    }

    const killSession = deps.killSession || ((name, reason, source) => sessions.killSession(name, reason, source));
    const killResult = killSession(project.name, opts.reason || 'outage takeover (#2598)', store.SESSION_STOP_SOURCES.MODEL_SWITCH);
    // Terminating the wedged session is the one step this mode cannot skip:
    // switching the project's configured engine/model while that session may
    // still be alive and using the OLD config is exactly the overlap this
    // mode exists to prevent. Refuse rather than report a success that
    // silently left it running.
    if (killResult && killResult.error) {
      return {
        ok: false, status: 500, code: 'TERMINATE_FAILED',
        error: `worktree snapshot ${snapshot.committed ? `landed on ${wipBranch}` : 'was not needed (clean tree)'}, but terminating the unresponsive session failed: ${killResult.error}`,
        wipBranch: snapshot.committed ? wipBranch : null
      };
    }
    _applyToProjectConfig(project, opts, deps);
    // Launching the successor is recovery convenience, not a safety step —
    // the two things this mode exists to guarantee (the work is
    // snapshotted, the wedged session is gone) already happened above. A
    // failure here is reported, not escalated into an overall refusal: there
    // is nothing left to undo, and the operator can launch it by hand with
    // the engine/model already persisted correctly.
    //
    // Deliberately NOT passed a `continuityHandoff` launch option:
    // `sessions.launchSession` has no such parameter. The successor finds
    // the handoff through the REAL mechanism instead — the continuity
    // index written above, which `_resumeSource` reads via
    // `continuity.readIndex` and folds into the next launch's own Resume
    // block, no new plumbing required.
    //
    // `continuityMode: 'continue'` IS a real, existing launchSession option
    // (unlike `continuityHandoff`) — made explicit here rather than left to
    // the same effect omitting it already has (`launchSession` only skips
    // resuming when this is exactly `'fresh'`; checked in lib/sessions.js).
    const launchSuccessor = deps.launchSuccessor || ((name, engineOverride) => sessions.launchSession(name, { engineOverride, continuityMode: 'continue' }));
    let successorLaunched = false;
    let successorError = null;
    try {
      const launchResult = launchSuccessor(project.name, opts.engine);
      successorLaunched = !launchResult || !launchResult.error;
      successorError = launchResult && launchResult.error ? launchResult.error : null;
    } catch (err) {
      successorError = err.message;
    }
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
        sessionTerminated: true,
        successorLaunched,
        successorError,
        planPath,
        continuityHandoffFile: continuityResult.handoffPath,
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

  // #3216 (Pillar 3 — engine SSOT convergence): `sameProvider` must reflect
  // what the LIVE session is actually running, not SQLite's own
  // `projects.engine_id` — the two can drift (a prior switch's relaunch
  // succeeded but a later write to `projects.engine_id` failed or raced,
  // or a session was started with an `engineOverride` never persisted
  // back). Trusting `project.engineId` alone let a genuine cross-provider
  // switch (the live session on `antigravity`, targeting `codex`)
  // misclassify as a same-provider `/clear` reconcile against the WRONG
  // engine's own adapter. `session.engineId` is the session row's own
  // field (`lib/store/sessions.js`'s `_rowToSession`, `engineId:
  // row.engine_id`) — the live source of truth — and falls back to
  // `project.engineId` only when absent (never probed here: a session
  // object this function already received either way).
  const activeEngineId = (session && typeof session.engineId === 'string' && session.engineId.trim())
    ? session.engineId.trim()
    : project.engineId;
  const sameProvider = activeEngineId === opts.engine;
  // Checked BEFORE anything is touched: a cross-provider switch relaunches
  // rather than live-switching, and nothing on the relaunch path can VERIFY
  // an effort override reached the new process the way the live reconciler
  // verifies model (#2188's launch path has no persisted effort field at
  // all) — refuse explicitly rather than silently drop it or report it
  // applied when it was not.
  if (!sameProvider && opts.effort) {
    return _effortUnsupportedOnRelaunch();
  }
  // Checked BEFORE anything is touched, same reasoning as the relaunch
  // check above but for the live-switch path (PRR-A Round 5 BLOCKING 3,
  // #2598): `CLAUDE_ADAPTER.supports('effortMode')` is `false` (effort/mode
  // is not a single explicit slash-command argument the way `/model <id>`
  // is — see that adapter's own `supports()` doc comment), and
  // `_matches()` requires `observed.effort === desired.effort` whenever
  // `desired.effort` is set. Since `observeActiveProfile` never reports an
  // `effort` field at all, that comparison can NEVER pass — without this
  // check, requesting `effort` on a same-provider switch would mutate
  // `project.json`, send `/clear` + `/model` for nothing, and
  // deterministically fail `RECONCILE_FAILED` every time.
  if (sameProvider && opts.effort) {
    const getAdapter = deps.getAdapter || ((engineId) => profileReconciler.getAdapter(engineId));
    const adapter = getAdapter(opts.engine);
    if (!adapter || typeof adapter.supports !== 'function' || !adapter.supports('effortMode')) {
      return {
        ok: false, status: 400, code: 'EFFORT_UNSUPPORTED_BY_ENGINE',
        error: `Engine "${opts.engine}" does not support verified live effort switching.`
      };
    }
  }
  // Persist BEFORE refreshing: a `/clear`, a live reconcile, or a relaunch
  // that crashes or is interrupted midway must still leave the intended
  // {engine, model} on disk — a reader (the next launch, an operator
  // checking project.json) must never see the OLD config outlive a refresh
  // that already started.
  _applyToProjectConfig(project, opts, deps);

  // #3216 (Pillar 3 — PRR-A R1 finding 1): converge the live session row's
  // own `engine_id` whenever it differs from `opts.engine` — used by BOTH
  // branches below (the same-provider live switch, and the cross-provider
  // relaunch's successor session). No `store.sessions.update`/`updateEngine`
  // method exists, so the fallback resolves to a raw SQLite UPDATE through
  // `store.getDb()` (the same `DatabaseSync` handle `lib/store/_db.js#getDb`
  // exposes for exactly this kind of health-check/escape-hatch write) rather
  // than this file reaching into `lib/store/sessions.js` to add a new public
  // method (outside this car's file scope).
  const updateSessionEngine = deps.updateSessionEngine || ((sessionId, engineId) => {
    if (store.sessions && typeof store.sessions.updateEngine === 'function') {
      return store.sessions.updateEngine(sessionId, engineId);
    }
    if (store.sessions && typeof store.sessions.update === 'function') {
      return store.sessions.update(sessionId, { engine_id: engineId });
    }
    const db = typeof store.getDb === 'function' ? store.getDb() : null;
    if (db && typeof db.prepare === 'function') {
      return db.prepare('UPDATE sessions SET engine_id = ? WHERE id = ?').run(engineId, sessionId);
    }
    return null;
  });

  if (!sameProvider) {
    // Cross-provider: a relaunch, not a live switch — `launchSession`
    // (#2188) reads the `model` just persisted above and refuses outright
    // if it cannot be confirmed, so no separate "pass the model through"
    // plumbing belongs here.
    //
    // A continuity handoff, written BEFORE the kill, same as outage-takeover
    // writes one — the plan in progress, named once, so a relaunch that
    // lands on a fresh context (no `/clear` ran; this IS the discontinuity)
    // does not strand it. Fails CLOSED, same reason outage-takeover's does.
    const findActivePlanPath = deps.findActivePlanPath || ((p) => _findActivePlanPath(p, deps));
    const planPath = findActivePlanPath(project.path);
    const continuityResult = _writeContinuity(
      project,
      'model-switch-handoff.json',
      {
        project: project.name, mode: 'boundary', reason: opts.reason || null,
        sessionId: session.id, planPath, appliedEngine: opts.engine, appliedModel: opts.model, appliedEffort: opts.effort || null
      },
      {
        project: project.name,
        currentState: `Governed model switch to ${opts.engine}/${opts.model} (cross-provider relaunch from session ${session.id})${planPath ? ` (active plan: ${planPath})` : ''}.`,
        nextAction: planPath ? `Resume the active plan ${planPath}.` : `Confirm the new session is running ${opts.engine}/${opts.model} as intended.`,
        freshness: { sha: null, branch: '', writtenAt: new Date().toISOString(), tier: 'model-switch' }
      },
      deps
    );
    if (!continuityResult.ok) {
      return {
        ok: false, status: 500, code: 'HANDOFF_WRITE_FAILED',
        error: `"${sessionName}"'s config was updated, but the continuity handoff could not be recorded before relaunching: ${continuityResult.error}`
      };
    }

    // Governed wrap before relaunch (PRR-A Round 4 BLOCKING 2, #2598): #2598
    // explicitly requires this be a GOVERNED wrap + relaunch, not a bare
    // kill/launch — `sessions.triggerWrap` is the full `startWrap` + wait,
    // running the real pipeline's `continuity-write` + `handoff-stage`
    // steps (on top of the model-switch-specific handoff `_writeContinuity`
    // already wrote above). Options chosen to neutralize every side effect
    // that does not belong to a model switch:
    //   - `keepSessionRunning: false` — this session is about to be killed
    //     and relaunched on the new engine regardless.
    //   - `skipTests: true` — `lib/wrap-steps/test.js` honors this directly.
    //   - `prHandling: 'defer'` — NOT `'skip'` (not a recognized value;
    //     `lib/wrap-steps/pr-check.js`'s `VALID_HANDLINGS` is only
    //     `{merge, defer, ignore}`, and an unrecognized string BLOCKS the
    //     whole wrap instead of skipping it). `'defer'` records a decision
    //     for any session-scoped open PR without merging or blocking.
    //   - `bumpLevel: 'none'` — not a real bump level either
    //     (`lib/wrap-steps/version-bump.js`'s `BUMP_LEVELS` is only
    //     `{patch, minor, major}`), but an out-of-set override makes that
    //     step report `skipped` rather than falling back to its own
    //     heuristic — exactly what a mid-switch wrap wants.
    const triggerWrap = deps.triggerWrap || ((name, wopts) => sessions.triggerWrap(name, wopts));
    const wrapRes = await triggerWrap(project.name, {
      keepSessionRunning: false, skipTests: true, prHandling: 'defer', bumpLevel: 'none'
    });
    if (!wrapRes || wrapRes.ok !== true) {
      return {
        ok: false, status: 500, code: 'WRAP_FAILED',
        error: (wrapRes && wrapRes.error) || 'governed wrap failed'
      };
    }
    // `wrapRes.ok` is the PIPELINE's verdict; `lifecycleCompleted` is the
    // SESSION's (PRR-A Round 5 BLOCKING 2, #2598 — `lib/sessions.js`'s own
    // `triggerWrap` doc comment says the two can disagree: "a pipeline that
    // succeeds against a session someone killed mid-wrap writes nothing").
    // `wrapRes.sessionId` is captured at the wrap's CLAIM time, never
    // re-checked against who is active now — binding it back to the
    // session THIS switch started with is what rules out a kill/relaunch
    // landing on some other session that took over mid-wrap.
    if (wrapRes.lifecycleCompleted !== true || String(wrapRes.sessionId) !== String(session.id)) {
      return {
        ok: false, status: 409, code: 'SESSION_SUPERSEDED',
        error: `"${sessionName}"'s session was superseded during the governed wrap (lifecycleCompleted: ${wrapRes.lifecycleCompleted}, wrap sessionId: ${wrapRes.sessionId}, expected: ${session.id}) — refusing to kill or relaunch a session this switch did not start.`
      };
    }

    const killSession = deps.killSession || ((name, reason, source) => sessions.killSession(name, reason, source));
    const launchSession = deps.launchSession || ((name, launchOpts) => sessions.launchSession(name, launchOpts));
    // `keepSessionRunning: false` above should already have ended the
    // session as part of the wrap — checked rather than assumed, because a
    // lightweight test double stubbing `triggerWrap` without ending the
    // session must not leave two sessions running after `launchSession`.
    // Checked ONCE, here, rather than inside `refreshSession`'s own
    // closure: if a DIFFERENT session is now active (one that replaced
    // this one after the wrap bound itself to the right id above, but
    // before this read), that is still a supersession this must refuse,
    // never kill the replacement or launch a third.
    const getActiveSession = deps.getActiveSession || (() => store.sessions.getActive(project.id));
    const activeAfterWrap = getActiveSession();
    if (activeAfterWrap && String(activeAfterWrap.id) !== String(session.id)) {
      return {
        ok: false, status: 409, code: 'SESSION_SUPERSEDED',
        error: `"${sessionName}" now has a different active session (${activeAfterWrap.id}) than the one this switch started with (${session.id}) — refusing to kill it or launch a third.`
      };
    }
    const refreshSession = deps.refreshSession || ((p) => {
      if (activeAfterWrap) {
        const killRes = killSession(p.name, 'governed model switch (#2598)', store.SESSION_STOP_SOURCES.MODEL_SWITCH);
        if (killRes && killRes.error) return { ok: false, code: 'KILL_FAILED', error: killRes.error };
      }
      const launchRes = launchSession(p.name, { engineOverride: opts.engine, continuityMode: 'continue' });
      if (launchRes && launchRes.error) return { ok: false, code: 'LAUNCH_FAILED', error: launchRes.error };
      return { ok: true };
    });
    const refreshResult = refreshSession(project, session);
    if (refreshResult && refreshResult.ok === false) {
      return {
        ok: false, status: 500, code: refreshResult.code,
        error: `"${sessionName}"'s config was updated, but the relaunch failed: ${refreshResult.error}`
      };
    }
    // #3216 (Pillar 3 — PRR-A R1 finding 1): verify the SUCCESSOR session
    // row `launchSession` just created actually carries `opts.engine` as
    // its own `engine_id`, and converge it if not. `launchSession` sets
    // this correctly in the ordinary case (it was launched with
    // `engineOverride: opts.engine` above), so this is normally a no-op —
    // the check exists for the same reason the same-provider branch's own
    // convergence does: a later write to the row can still race or fail
    // independently of the launch that created it.
    const successor = getActiveSession();
    if (successor && successor.engineId !== opts.engine) {
      updateSessionEngine(successor.id, opts.engine);
    }
    return {
      ok: true,
      mode: 'boundary',
      sameProvider,
      appliedEngine: opts.engine,
      appliedModel: opts.model,
      appliedEffort: opts.effort || null
    };
  }

  // #3216 (Pillar 3): converge the live session row's own `engine_id` too,
  // on the rare chance it ever differs from `opts.engine` here — in the
  // ordinary case this is a no-op, since `sameProvider` above was computed
  // FROM `session.engineId`, so `session.engineId === opts.engine` already
  // holds whenever this branch is reached by a real drift scenario.
  // `updateSessionEngine` is defined once, above, and shared with the
  // cross-provider branch's own successor-session convergence.
  if (session.engineId !== opts.engine) {
    updateSessionEngine(session.id, opts.engine);
  }

  // Same-provider: a LIVE switch, through the same engine-agnostic
  // control/verify loop #2188 built for exactly this question — "is the
  // profile actually running the one that was asked for" — under the SAME
  // `session:<id>` resource-id convention the launch path's own post-launch
  // verification uses.
  const resourceId = `session:${session.id}`;
  const setDesiredProfile = deps.setDesiredProfile || ((id, profile) => profileReconciler.setDesiredProfile(id, profile));
  const recordCheckpoint = deps.recordCheckpoint || ((id, receipt) => profileReconciler.recordCheckpoint(id, receipt));
  const reconcile = deps.reconcile || ((id, tmuxSession, rdeps) => profileReconciler.reconcile(id, tmuxSession, rdeps));
  setDesiredProfile(resourceId, { engine: opts.engine, model: opts.model, effort: opts.effort || null });
  recordCheckpoint(resourceId, { safeToClear: true, generation: session.id });
  // `projectPath` + `startedAtMs` are required, not optional: the Claude
  // adapter's `observeActiveProfile` reads the engine's own out-of-band
  // transcript (never pane text) and fails CLOSED — returns null, which can
  // never match a desired profile — unless both are given (PRR-A finding,
  // `lib/profile-reconciler.js#_readClaudeActiveModel`'s own doc comment).
  // Omitting them, as an earlier version of this call did, meant this path
  // could never reach `verified` in production.
  //
  // `startedAtMs` is `session.startedAt` (the session's launch time), NOT
  // this switch's own start instant — tried the latter (PRR-A Round 3
  // BLOCKING 1's suggested fix) and it breaks every real same-provider
  // switch: `_readClaudeActiveModel` requires the transcript file's OWN
  // FIRST line, not merely some line, to be `>= startedAtMs` — a check
  // whose whole point (distinguishing a leftover file from THIS launch's
  // own) only works against a brand-new file born at launch. An already-
  // running session's file always has history from before any later
  // switch, so that check would permanently disqualify the file and
  // `observeActiveProfile` would return null forever, failing every
  // in-place switch with STILL_MISMATCHED (confirmed by running the fix
  // against the real, non-stubbed reconciler — see
  // test/model-switch.test.js's "actually sends /clear + /model" test).
  //
  // `requireClear: true` (PRR-A Round 4, #2598) is the actual fix for the
  // staleness race Round 3 named (two rapid switches with no conversation
  // turn between them can let a pre-switch model match by coincidence): it
  // tells `reconcile` to never trust the pre-control observation, so
  // `/clear` always runs, and the post-clear re-observation is scoped to
  // evidence written at or after the instant `/clear` actually applied
  // (`lib/profile-reconciler.js`'s own `minRecordTimestampMs` support,
  // added for exactly this call site — now in this car's file scope per
  // Charter A488 v1.8).
  const reconciled = await reconcile(resourceId, session.tmuxSession, {
    // `claudeHome`/`tmux`/`now`/the post-control poll seams forwarded
    // as-is from this module's own `deps`: a test that wants the REAL
    // (non-stubbed) `reconcile` to read a fake transcript directory, send
    // keys through a fake tmux, control the clock `clearAppliedAtMs` is
    // captured from, or drive the bounded post-control poll without real
    // wall-clock delay, overrides them the same way it overrides every
    // other seam here — nothing about this call invents a second deps
    // surface for them.
    claudeHome: deps.claudeHome,
    tmux: deps.tmux,
    now: deps.now,
    sleep: deps.sleep,
    // This call site's own real default (`reconcile`'s own default is `1`
    // — no retry — since most of ITS callers never had this race): a live
    // switch needs the retry budget because `/clear` + `/model` return
    // before the CLI flushes, and a clean boundary runs no new work turn
    // at all to naturally produce fresh evidence.
    postControlPollAttempts: deps.postControlPollAttempts !== undefined ? deps.postControlPollAttempts : 20,
    postControlPollMs: deps.postControlPollMs !== undefined ? deps.postControlPollMs : 50,
    currentGeneration: session.id,
    projectPath: project.path,
    startedAtMs: profileReconciler.parseLaunchTimestampMs(session.startedAt),
    requireClear: true
  });
  if (!reconciled.ok) {
    return {
      ok: false, status: 500, code: 'RECONCILE_FAILED',
      error: `"${sessionName}"'s config was updated, but the live session could not be confirmed on the new profile: ${reconciled.reason}`
    };
  }

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
