'use strict';

/**
 * Governed headless session finalization (#2027).
 *
 * A session whose work is done and reconciled can be retired without the wrap
 * drawer, by itself or by a coordinator its assignment names. This module
 * decides whether that request may proceed; `sessions.finalizeSession` performs
 * it. Everything that belongs to the full wrap pipeline is refused, not
 * handled: work changed since launch, commits no remote has, a live wrap. So
 * this path never commits, stages, resets, checks out or discards anything,
 * and a file that was dirty when the session launched stays exactly as it is.
 *
 * Checks run in this order, and the first refusal wins with nothing changed:
 *
 * 1. **Body.** A `sessionId` and a one-line `reason`.
 * 2. **Caller.** A verified project launch (`shared-docs-access#resolveAccess`).
 *    The operator, the Master, an unbound request and a Medusa name are never
 *    callers here: the operator already has the drawer and kill, and with the
 *    auth gate open an operator-shaped request is forgeable by any local process.
 * 3. **Authority.**
 *    - **self**: the caller's own project, and only the caller's own session.
 *    - **delegated**: a principal in the target's open control assignment's
 *      `authority.lifecycle`, and only the session that assignment is bound to.
 *    A peer outside the matrix is refused the same way as a stranger.
 * 4. **Session binding.** A live session outside the caller's authority is
 *    refused; an ended one is `SESSION_CHANGED`. A repeat for a session this
 *    path ended finishes and answers the same outcome (idempotent).
 * 5. **Supported session.** A webui session is refused.
 * 6. **HOLD/STOP gate**, as for every governed mutation.
 * 7. **No live wrap run.**
 * 8. **Clear to retire.** The lane composes AVAILABLE: a current `complete` +
 *    `safe-to-clear` receipt, no control verdict, no operator narrowing, and an
 *    engine at rest. A self caller's own pane is busy running this very request,
 *    so the observer cannot read it at rest. For self, the receipt stands in
 *    for that one fact, and every other rule of the composition still applies.
 * 9. **Drained.** No unresolved Medusa obligation (see {@link _obligations}).
 * 10. **Where it works.** A pane in a linked worktree, or a pane whose
 *    directory cannot be read, refuses.
 * 11. **No owned work.** The strict `session-leftovers` probe: files changed
 *    since launch, launch-dirty files whose identity changed, linked worktrees
 *    new with work or changed since launch, commits no freshly fetched remote
 *    has (HEAD, or any branch since start), and stashes since start. Anything
 *    that cannot be established refuses (fail closed).
 * 12. **Commit point.** A synchronous re-check of 6–9, staging, and the
 *    `active -> wrapped` write with the handoff bound.
 *
 * @module lib/session-finalize
 */

const store = require('./store');
const sharedDocsAccess = require('./shared-docs-access');
const workloadFleet = require('./workload-fleet');
const controlGate = require('./control-gate');
const controlState = require('./control-state');
const sessionLeftovers = require('./session-leftovers');
const medusaRegistry = require('./medusa-registry');
const { AVAILABILITY } = require('./workload-compose');
const { createLogger } = require('./logger');

const log = createLogger('session-finalize');

/** The longest reason accepted; it is stored in the audit and the wrap summary. */
const REASON_MAX = 500;

/** Who is finalizing: the session itself, or a coordinator on its behalf. */
const MODES = Object.freeze({ SELF: 'self', DELEGATED: 'delegated' });

/** How every wrap summary this path writes begins. */
const SUMMARY_PREFIX = 'Finalized headlessly by ';

/** The control-gate surface name, for its log lines. */
const GATE_SURFACE = 'session-finalize';

/**
 * The observer answer a self caller's lane is composed with. The request is
 * running in the session's own pane, so a real observation reads busy; the
 * caller's current complete + safe-to-clear receipt is its at-rest attestation.
 */
const SELF_ATTESTED_ENGINE = Object.freeze({
  activity: 'at-rest',
  reason: 'self-attested: the finalizing session is running this request in its own pane',
  observedAt: null,
  ageSeconds: null
});

const _internal = {
  resolveAccess: (req) => sharedDocsAccess.resolveAccess(req),
  getLaunch: (launchId) => store.launchSequences.getByLaunchId(launchId),
  laneFor: (session, opts) => workloadFleet.laneFor(session, opts),
  wrapRun: (projectName) => require('./wrap-run-registry').get(projectName),
  checkMutation: (args) => controlGate.checkMutation(args),
  probe: (project, session, opts) => sessionLeftovers.probe(project, session, null, opts),
  workspaceId: (project, sessionId) => medusaRegistry.getWorkspaceId(project.path, sessionId),
  resolveScope: (project, session) => require('./wrap-scope').resolve(project, session),
  stageFinal: (args) => _stageFinal(args),
  // Required lazily: `lib/sessions.js` loads the engine and tmux stacks.
  finalizeSession: (projectName, sessionId, opts) => require('./sessions').finalizeSession(projectName, sessionId, opts),
  finishFinalization: (project, session) => require('./sessions').finishFinalization(project, session),
  isFinalizedHere: (session) => require('./sessions').isFinalizedByGovernedPath(session)
};

/**
 * A refusal: nothing was changed.
 * @param {number} status - HTTP status
 * @param {string} code - Stable machine code
 * @param {string} message - What happened and what to do instead
 * @param {object} [details] - Facts the caller can act on
 * @returns {{ok: false, status: number, code: string, message: string, details: object}}
 */
function _refuse(status, code, message, details = {}) {
  return { ok: false, status, code, message, details };
}

/**
 * The fields of a session this route answers with. The full row carries the
 * prime prompt, which is not the caller's to read back here.
 * @param {object} session - A session from the store
 * @returns {{id: number, projectId: number, status: string, endedAt: (string|null), wrapSummary: (string|null)}}
 */
function _sessionView(session) {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    endedAt: session.endedAt || null,
    wrapSummary: session.wrapSummary || null
  };
}

/**
 * Validate the request body.
 * @param {*} body - Parsed JSON body
 * @returns {{sessionId: number, reason: string}|{error: object}}
 */
function _parseBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rawId = b.sessionId;
  const sessionId = typeof rawId === 'number' ? rawId
    : (typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : NaN);
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    return { error: _refuse(400, 'BAD_REQUEST', 'sessionId is required: the id of the session to finalize, as you observed it') };
  }
  // One line: the reason is written into the next session's handoff and the
  // wrap summary, where a line break could pose as a structure of its own.
  const reason = typeof b.reason === 'string' ? b.reason.replace(/\s+/g, ' ').trim() : '';
  if (!reason || reason.length > REASON_MAX) {
    return { error: _refuse(400, 'BAD_REQUEST', `reason is required: 1 to ${REASON_MAX} characters saying why this session is being retired`) };
  }
  return { sessionId, reason };
}

/**
 * Resolve the caller. A launch whose session has ended can still be verified
 * (the launch exists and its project matches the claim), and is returned with
 * `live: false`; such a caller may only learn that its own session is already
 * finalized, which is what makes a repeated self request idempotent after the
 * first one tore its pane down.
 * @param {object} req - The request
 * @returns {{projectId: number, sessionId: number, live: boolean}|null} Null when unverifiable
 */
function _caller(req) {
  const access = _internal.resolveAccess(req);
  if (access.kind === sharedDocsAccess.KINDS.PROJECT) {
    return { projectId: access.projectId, sessionId: access.sessionId, live: true };
  }
  // resolveAccess answers `session-not-active` only after it has matched the
  // launch to the claimed project, so the launch below is a verified one.
  if (access.kind === sharedDocsAccess.KINDS.INVALID
      && access.reason === sharedDocsAccess.INVALID_REASONS.SESSION_NOT_ACTIVE) {
    const launch = _internal.getLaunch((req.headers || {})[sharedDocsAccess.LAUNCH_HEADER]);
    if (launch) return { projectId: launch.projectId, sessionId: launch.sessionId, live: false };
  }
  return null;
}

/**
 * The caller's authority over the target project's lane, and the one session
 * that authority covers: the caller's own for self, the assignment's bound
 * session for a coordinator.
 * @param {{projectId: number, sessionId: number, live: boolean}} caller
 * @param {object} project - Target project
 * @returns {{mode: string, assignment: (object|null), ownSessionId: (number|null)}|null} Null when the caller has none
 */
function _authority(caller, project) {
  if (caller.projectId === project.id) return { mode: MODES.SELF, assignment: null, ownSessionId: caller.sessionId };
  if (!caller.live) return null;
  const row = store.control.getOpenForProject(project.id);
  if (!row) return null;
  // Throws CONTROL_STATE_UNAVAILABLE (503) on an unreadable matrix, the same
  // answer an assignment close gives, rather than a refusal that blames the caller.
  if (!controlState.hasLifecycleAuthority(row, `project:${caller.projectId}`)) return null;
  const bound = Number(row.bound_session_id);
  return { mode: MODES.DELEGATED, assignment: row, ownSessionId: Number.isSafeInteger(bound) && bound > 0 ? bound : null };
}

/**
 * A live wrap run for the project, as a refusal.
 * @param {object} project - Target project
 * @returns {object|null}
 */
function _wrapBusy(project) {
  const run = _internal.wrapRun(project.name);
  if (run && run.running) {
    return _refuse(409, 'WRAP_IN_PROGRESS', `A wrap is already running for "${project.name}"; it owns this session's end.`,
      { runId: run.runId || null, sessionId: run.sessionId == null ? null : run.sessionId });
  }
  return null;
}

/**
 * The control gate's refusal, if the lane is held or stopped.
 * @param {object} project - Target project
 * @returns {object|null}
 */
function _gateRefusal(project) {
  const refusal = _internal.checkMutation({
    surface: GATE_SURFACE,
    subject: { kind: 'job', projectId: project.id, assignmentId: null }
  });
  return refusal ? _refuse(refusal.status, refusal.code, refusal.message, refusal.details || {}) : null;
}

/**
 * The decision itself; {@link finalize} wraps it with the audit log line.
 * @param {object} args - As {@link finalize}
 * @returns {Promise<object>}
 */
async function _decide({ req, projectName, body, observer }) {
  const parsed = _parseBody(body);
  if (parsed.error) return parsed.error;
  const { sessionId, reason } = parsed;

  const caller = _caller(req);
  if (!caller) {
    return _refuse(403, 'FINALIZE_UNAUTHORIZED',
      'Only a verified TangleClaw launch may finalize a session: send x-tangleclaw-project-id and x-tangleclaw-launch-id from your launch (tc finalize does).');
  }

  const project = store.projects.getByName(projectName);
  if (!project) return _refuse(404, 'NOT_FOUND', `Project "${projectName}" not found`);

  let authority;
  try {
    authority = _authority(caller, project);
  } catch (err) {
    if (err instanceof controlState.ControlError) return _refuse(err.status, err.code, err.message, err.details || {});
    throw err;
  }
  if (!authority) {
    return _refuse(403, 'FINALIZE_UNAUTHORIZED',
      `Project ${caller.projectId} may not finalize a session of "${project.name}": only the session itself, or a principal in its assignment's lifecycle authority, may.`);
  }
  const { mode, assignment, ownSessionId } = authority;

  // An ended launch may only ask about its own session.
  if (!caller.live && caller.sessionId !== sessionId) {
    return _refuse(403, 'FINALIZE_UNAUTHORIZED', `Your launch's session has ended; it may not act on session ${sessionId}.`);
  }

  const named = store.sessions.get(sessionId);
  if (!named || named.projectId !== project.id) {
    return _refuse(404, 'SESSION_NOT_FOUND', `Session ${sessionId} is not a session of "${project.name}".`);
  }
  // Authority covers exactly one session. Naming a live session outside it is
  // an attempt on someone else's lane; naming an ended one is a stale view.
  // For a live self caller the first branch holds by the store's one-active-
  // session invariant; it is checked so a broken invariant refuses.
  if (named.id !== ownSessionId) {
    if (named.status === store.SESSION_STATUS.ACTIVE) {
      return _refuse(403, 'FINALIZE_UNAUTHORIZED',
        mode === MODES.SELF
          ? `A launch may finalize only its own session; yours is ${caller.sessionId}.`
          : `Your lifecycle authority covers the session assignment ${assignment.assignment_id} is bound to, not session ${named.id}.`,
        assignment ? { assignmentId: assignment.assignment_id } : {});
    }
    return _refuse(409, 'SESSION_CHANGED', `Session ${sessionId} already ended as ${named.status}; nothing was changed.`,
      { sessionStatus: named.status });
  }
  if (named.status === store.SESSION_STATUS.WRAPPED) {
    // Idempotent only for a session THIS path ended: one the wrap pipeline or
    // the drawer ended is a different outcome, and saying "already finalized"
    // about it would be false. A repeat also finishes what the first request
    // could not (publication, teardown), and never answers success while any of
    // it is still incomplete.
    if (!_internal.isFinalizedHere(named)) {
      return _refuse(409, 'SESSION_CHANGED', `Session ${sessionId} was already wrapped by the wrap, not finalized here; nothing was changed.`,
        { sessionStatus: named.status });
    }
    return _answer(mode, named, _internal.finishFinalization(project, named), true);
  }
  if (named.status !== store.SESSION_STATUS.ACTIVE) {
    return _refuse(409, 'SESSION_CHANGED', `Session ${sessionId} already ended as ${named.status}; nothing was changed.`,
      { sessionStatus: named.status });
  }

  // A webui (gateway) session holds an SSH tunnel that the shared teardown does
  // not release, so it could not be shown to hold nothing afterwards.
  if (named.sessionMode === 'webui') {
    return _refuse(409, 'FINALIZE_UNSUPPORTED', 'A webui session is not finalized headlessly; use the full wrap.', { sessionMode: 'webui' });
  }

  const gate = _gateRefusal(project);
  if (gate) return gate;
  const busy = _wrapBusy(project);
  if (busy) return busy;

  const laneObserver = mode === MODES.SELF
    ? { get: () => SELF_ATTESTED_ENGINE }
    : (observer || { get: () => ({ activity: 'unknown', reason: 'no observer', observedAt: null, ageSeconds: null }) });
  const composeLane = () => _internal.laneFor(named, { observer: laneObserver, projectName: project.name });
  const lane = composeLane();
  const notClear = _notClear(lane, mode);
  if (notClear) return notClear;

  const obligations = _obligations(project, named);
  const undrained = _obligationRefusal(obligations);
  if (undrained) return undrained;

  // Where the session works, before asking what it left there. A session whose
  // pane is in a linked worktree has its work in that tree, which the launch
  // baseline never recorded, and a pane whose directory cannot be read may be
  // anywhere. Neither can be shown clean, so both refuse.
  const scope = await _internal.resolveScope(project, named);
  const tree = _workTreeRefusal(named, scope);
  if (tree) return tree;

  const work = await _internal.probe(project, named, { strict: true });
  if (work.state === 'left-work') {
    return _refuse(409, 'OWNED_WORK_PRESENT',
      'This session has work of its own since launch (changed files, a file that was dirty at launch and changed since, work in a linked worktree, stashed work, or commits no remote has); use the full wrap, which decides what to commit.',
      {
        paths: work.newPaths,
        pathCount: work.newPathCount,
        changedSinceLaunch: work.changedAtLaunchPaths || [],
        changedSinceLaunchCount: work.changedAtLaunchCount || 0,
        unpushed: work.unpushed,
        changedWorktrees: work.changedWorktrees || [],
        unpushedOnBranches: work.unpushedOnBranches || 0,
        stashes: work.stashes || 0
      });
  }
  if (work.state !== 'clean') {
    return _refuse(409, 'WORK_STATE_UNKNOWN',
      'Could not establish that this session left no work of its own, so it is not finalized; use the full wrap.',
      { reason: work.reason || null });
  }

  const receipt = lane.workload.receipt;
  const baseline = store.sessions.getLaunchBaseline(named.id);
  const principal = `project:${caller.projectId}`;
  const audit = {
    mode,
    actor: { principal, sessionId: caller.sessionId },
    reason,
    assignmentId: assignment ? assignment.assignment_id : null,
    receiptSeq: receipt ? receipt.seq : null,
    engine: mode === MODES.SELF ? 'self-attested' : lane.engine.activity,
    dirtyAtLaunchPreserved: baseline && baseline.dirty ? baseline.dirty.paths.length : null,
    sentInFlight: obligations.sentInFlight
  };
  const summary = `${SUMMARY_PREFIX}${principal} (${mode}): ${reason}`;

  // The last look runs synchronously with the staging and the write, so a
  // wrap, a hold or a receipt change that arrived while the checkout was being
  // read cannot slip in between. The refusal is kept whole so its own status
  // and details reach the caller.
  let late = null;
  const done = _internal.finalizeSession(project.name, named.id, {
    summary,
    audit,
    recheck: () => {
      late = _gateRefusal(project) || _wrapBusy(project) || _notClear(composeLane(), mode)
        || _obligationRefusal(_obligations(project, named));
      return late ? { code: late.code, error: late.message } : null;
    },
    stage: (session, wrapRunId) => _internal.stageFinal({ project, session, scope, wrapRunId, principal, mode, reason, receipt })
  });
  if (done.error) {
    if (late) return late;
    if (done.code === 'SESSION_CHANGED') {
      // A concurrent request for the same session may have finalized it while
      // this one read the checkout. That is the same outcome, not a conflict.
      const now = store.sessions.get(named.id);
      if (now && now.status === store.SESSION_STATUS.WRAPPED && _internal.isFinalizedHere(now)) {
        return _answer(mode, now, _internal.finishFinalization(project, now), true);
      }
      return _refuse(409, 'SESSION_CHANGED', done.error);
    }
    if (done.code === 'FINALIZE_STAGE_FAILED') return _refuse(503, done.code, done.error);
    return _refuse(500, 'INTERNAL_ERROR', done.error);
  }
  return _answer(mode, done.session, done, false);
}

/**
 * Decide and, when every check passes, finalize.
 * @param {object} args
 * @param {object} args.req - The request (headers carry the launch binding)
 * @param {string} args.projectName - Target project name from the route
 * @param {*} args.body - Parsed body: `{sessionId, reason}`
 * @param {{get: function(number, number=): object}} [args.observer] - The activity observer; a delegated
 *   request without one cannot show the engine at rest and is refused
 * @returns {Promise<{ok: true, status: 200, body: object}|{ok: false, status: number, code: string, message: string, details: object}>}
 */
async function finalize(args) {
  const result = await _decide(args);
  // Every outcome leaves a server-side line: a refusal says who was turned
  // away and why, which a coordinator retrying blind otherwise never learns.
  // Identity is the project claim only; the launch id is a bearer credential.
  const claim = ((args.req && args.req.headers) || {})[sharedDocsAccess.PROJECT_HEADER] || null;
  const named = args.body && typeof args.body === 'object' ? args.body.sessionId : undefined;
  const fields = {
    project: args.projectName,
    sessionId: named === undefined ? null : named,
    callerProject: claim,
    status: result.status,
    mode: result.ok ? result.body.mode : ((result.details && result.details.mode) || null)
  };
  if (result.ok) log.info('finalize answered', { ...fields, alreadyFinalized: result.body.alreadyFinalized });
  else if (result.status >= 500) log.warn('finalize failed', { ...fields, code: result.code, error: result.message });
  else log.info('finalize refused', { ...fields, code: result.code });
  return result;
}

/**
 * The answer for a finalized session: success only when its handoff is
 * published and nothing it held survives; otherwise `FINALIZE_INCOMPLETE`,
 * carrying what is left, which a repeat of the same request finishes.
 * @param {string} mode - self | delegated
 * @param {object} session - The wrapped session
 * @param {{publication: object, teardown: object, complete: boolean}} finished - From `sessions.finishFinalization`
 * @param {boolean} repeat - Whether this request found the session already finalized
 * @returns {object}
 */
function _answer(mode, session, finished, repeat) {
  const facts = { mode, session: _sessionView(session), publication: finished.publication, teardown: finished.teardown };
  if (!finished.complete) {
    return _refuse(409, 'FINALIZE_INCOMPLETE',
      'The session is recorded finalized, but its handoff is not published or some of its resources are still held; repeat the same request to finish.',
      facts);
  }
  return { ok: true, status: 200, body: { ok: true, alreadyFinalized: repeat, ...facts } };
}

/**
 * The composed lane's refusal, when it is not AVAILABLE.
 * @param {{composed: object, workload: object}} lane - From `workload-fleet#laneFor`
 * @param {string} mode - self | delegated
 * @returns {object|null}
 */
function _notClear(lane, mode) {
  if (lane.composed.availability === AVAILABILITY.AVAILABLE) return null;
  return _refuse(409, 'NOT_CLEAR',
    'This session is not clear to retire. It needs a current `tc workload set complete --clearance safe-to-clear` receipt'
    + (mode === MODES.DELEGATED ? ' and an engine at rest' : '') + ', and no hold, stop or operator narrowing.',
    {
      availability: lane.composed.availability,
      clearance: lane.composed.clearance,
      reasons: lane.composed.reasons,
      receiptStaleReason: lane.workload.staleReason
    });
}

/**
 * The refusal for unresolved obligations, or null when there are none.
 * @param {ReturnType<typeof _obligations>} obligations
 * @returns {object|null}
 */
function _obligationRefusal(obligations) {
  if (!obligations.unresolved) return null;
  return _refuse(409, 'EXCHANGES_OPEN',
    'This session is not drained. Acknowledge what was sent to it and reply where a reply is required, and wait for the replies it is owed, then retry.',
    { unacknowledged: obligations.unacknowledged, unanswered: obligations.unanswered, awaitingReply: obligations.awaitingReply });
}

/**
 * The refusal when the session's work tree cannot be shown to be the checkout
 * its launch baseline describes, or null when it is.
 * @param {object} session - The named session
 * @param {object} scope - Its `wrap-scope` scope
 * @returns {object|null}
 */
function _workTreeRefusal(session, scope) {
  if (scope.worktreeTarget) {
    return _refuse(409, 'WORK_STATE_UNKNOWN',
      'This session works in a linked worktree, which its launch baseline does not describe, so it cannot be shown to have left no work; use the full wrap.',
      { reason: `the session's pane is in a linked worktree (${scope.workTree})`, workTree: scope.workTree });
  }
  if (session.tmuxSession && !scope.paneCwd) {
    return _refuse(409, 'WORK_STATE_UNKNOWN',
      'Could not read where this session works, so it cannot be shown to have left no work; use the full wrap.',
      { reason: scope.workTreeReason || 'the pane directory could not be read' });
  }
  return null;
}

/**
 * The session's unresolved Medusa obligations, read from each exchange's
 * durable facts rather than from the inbox:
 * - mail sent to it must be acknowledged by the lane itself, through its own
 *   verified launch (not the dashboard, the operator or an unbound reader), and replied to when a
 *   reply is required. An exchange acknowledged and replied to is resolved,
 *   even while its initiator has not closed it;
 * - mail it sent that requires a reply must have been answered.
 * Sent mail that needs no reply is no obligation and is only counted.
 * @param {object} project - Target project
 * @param {object} session - Target session
 * @returns {{unresolved: boolean, unacknowledged: string[], unanswered: string[], awaitingReply: string[], sentInFlight: number}}
 */
function _obligations(project, session) {
  const facts = (row) => store.medusaExchanges.facts(row.exchange_id);
  // Only the lane's own verified launch records `recipient` with `launch` proof;
  // the dashboard, the operator and an unbound reader are recorded as themselves.
  const laneAck = (fs) => fs.some((f) => f.fact === 'acknowledged' && f.actor === 'recipient' && f.proof === 'launch');
  const replied = (fs) => fs.some((f) => f.fact === 'replied');

  const workspaceId = _internal.workspaceId(project, session.id);
  const unacknowledged = [];
  const unanswered = [];
  for (const row of workspaceId ? store.medusaExchanges.listOpenForRecipient(workspaceId) : []) {
    const fs = facts(row);
    if (!laneAck(fs)) unacknowledged.push(row.exchange_id);
    else if (row.reply_required === 1 && !replied(fs)) unanswered.push(row.exchange_id);
  }
  const awaitingReply = [];
  let sentInFlight = 0;
  for (const row of store.medusaExchanges.listOpenForSenderSession(session.id)) {
    if (row.reply_required !== 1) { sentInFlight += 1; continue; }
    if (!replied(facts(row))) awaitingReply.push(row.exchange_id);
  }
  return {
    unresolved: unacknowledged.length + unanswered.length + awaitingReply.length > 0,
    unacknowledged, unanswered, awaitingReply, sentInFlight
  };
}

/**
 * Stage the session's final handoff: the canonical `tc.handoff/1` staging the
 * wrap uses, with a minimal truthful body. It records who retired the session
 * and why, the exact branch, head and receipt, and no next action, because
 * none was captured and inventing one would put a fabricated instruction in
 * front of the next session. Synchronous; throws when it cannot stage.
 * @param {object} args
 * @param {object} args.project - Target project
 * @param {object} args.session - The session being finalized
 * @param {object|null} args.scope - Its `wrap-scope` scope
 * @param {string} args.wrapRunId - This attempt's run id
 * @param {string} args.principal - Who finalizes
 * @param {string} args.mode - self | delegated
 * @param {string} args.reason - Why
 * @param {object|null} args.receipt - The receipt the lane was cleared on
 * @returns {{publicationId: string}}
 */
function _stageFinal({ project, session, scope, wrapRunId, principal, mode, reason, receipt }) {
  const info = scope && scope.workTree ? require('./git').getInfo(scope.workTree, { fresh: true }) : null;
  const staged = require('./wrap-steps/handoff-stage').stageAttempt({
    project,
    session,
    scope,
    wrapRunId,
    kind: 'final',
    missingEvidence: [],
    methodology: null,
    nextAction: null,
    resume: {
      currentState: `Retired headlessly by ${principal} (${mode}): ${reason}. `
        + `The session reported complete and safe to clear${receipt ? ` (workload receipt #${receipt.seq})` : ''}, was drained, `
        + 'and left no work of its own, so no wrap pipeline ran and nothing was committed.',
      nextAction: null,
      freshness: {
        sha: info && info.headSha ? info.headSha : null,
        branch: info && info.branch ? info.branch : null,
        writtenAt: new Date().toISOString(),
        tier: null
      }
    }
  });
  return { publicationId: staged.publication.publicationId };
}

module.exports = {
  finalize,
  MODES,
  REASON_MAX,
  GATE_SURFACE,
  SUMMARY_PREFIX,
  SELF_ATTESTED_ENGINE,
  _internal
};
