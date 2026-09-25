'use strict';

/**
 * HTTP handlers for `/api/control/*` (#1861).
 *
 * Each handler resolves its caller through `lib/control-auth.js`, applies the
 * rules in `lib/control-state.js`, and returns `{status, body, notify?}`. The
 * route in `server.js` writes the response first and only then hands `notify`
 * to {@link notify}: "accepted" means stored, and the notice is best-effort
 * after the fact. A failed notice is recorded as a receipt and never undoes
 * the command.
 *
 * @module lib/control-api
 */

const store = require('./store');
const control = require('./control-state');
const { resolveControlCaller } = require('./control-auth');
const medusa = require('./medusa');
const medusaRegistry = require('./medusa-registry');
const controlHooks = require('./control-hooks');
const controlGate = require('./control-gate');
const { createLogger } = require('./logger');

const log = createLogger('control-api');

/** Seams for tests: the notice sender and the workspace lookup. */
const _internal = {
  sendSystemMessage: (args) => medusa.sendSystemMessage(args),
  workspaceIdFor: (projectPath, sessionId) => medusaRegistry.getWorkspaceId(projectPath, sessionId)
};

/**
 * Resolve the caller or throw the refusal a non-principal gets.
 * @param {object} req - The request
 * @returns {{kind: string, actor: object, projectId?: number, launchId?: string}}
 */
function _principal(req) {
  const caller = resolveControlCaller(req);
  if (caller.kind === 'operator' || caller.kind === 'project') return caller;
  if (caller.kind === 'operator-unverifiable') {
    throw new control.ControlError(503, 'CONTROL_OPERATOR_UNVERIFIABLE',
      'operator identity cannot be verified on this install: sign in to the dashboard');
  }
  throw new control.ControlError(403, 'CONTROL_UNAUTHORIZED',
    'control commands need a verified launch (x-tangleclaw-project-id and x-tangleclaw-launch-id of an active session) or the operator');
}

/**
 * The live launch binding of a project's active session, if any.
 * @param {number} projectId - Project id
 * @returns {{sessionId: number, launchId: string}|null}
 */
function _liveBinding(projectId) {
  const active = store.sessions.getActive(projectId);
  if (!active) return null;
  const seq = store.launchSequences.getBySession(active.id);
  return seq && seq.launchId ? { sessionId: active.id, launchId: seq.launchId } : null;
}

/**
 * Tell the gate what a project's governance is after a command committed.
 * Best-effort: the gate re-reads the store on every check, and this only
 * keeps its store-failure memory current.
 * @param {number} projectId - Project id
 * @returns {void}
 */
function _rememberGovernance(projectId) {
  try {
    controlGate.remember(projectId, store.control.getOpenForProject(projectId));
  } catch (err) {
    log.warn('Could not refresh the gate\'s governance memory', { projectId, error: err.message });
  }
}

/**
 * A command result as a response, with its notice queued unless it replayed.
 * @param {number} status - HTTP status for a fresh command
 * @param {object} result - From a control-state command
 * @returns {{status: number, body: object, notify: (object|null)}}
 */
function _commandResponse(status, result) {
  _rememberGovernance(result.assignment.projectId);
  return {
    status: result.replayed ? 200 : status,
    body: result,
    notify: result.replayed ? null : { assignment: result.assignment, event: result.event }
  };
}

/**
 * POST /api/control/assignments — create an assignment (operator only).
 * @param {object} req - The request
 * @param {object} body - `{projectId, requestId, issueRef?, authority?}`
 * @returns {object} Response
 */
function createAssignment(req, body) {
  const caller = _principal(req);
  const b = body || {};
  const project = Number.isSafeInteger(b.projectId) ? store.projects.get(b.projectId) : null;
  if (caller.kind === 'operator' && !project) {
    throw new control.ControlError(404, 'PROJECT_NOT_FOUND', 'no such project');
  }
  const result = control.create({
    projectId: b.projectId,
    requestId: b.requestId,
    issueRef: b.issueRef,
    authority: b.authority,
    binding: project ? _liveBinding(project.id) : null
  }, caller.actor);
  if (!result.replayed) _syncHooks(b.projectId);
  return _commandResponse(201, result);
}

/**
 * POST /api/control/assignments/:id/hold
 * @param {object} req - The request
 * @param {object} params - `{id}`
 * @param {object} body - `{requestId, reasonCode, expectedGeneration?}`
 * @returns {object} Response
 */
function holdAssignment(req, params, body) {
  const caller = _principal(req);
  const b = body || {};
  return _commandResponse(201, control.hold({
    assignmentId: params.id, requestId: b.requestId, reasonCode: b.reasonCode, expectedGeneration: b.expectedGeneration
  }, caller.actor));
}

/**
 * POST /api/control/assignments/:id/release
 * @param {object} req - The request
 * @param {object} params - `{id}`
 * @param {object} body - `{holdIds, expectedGeneration, requestId, reasonCode}`
 * @returns {object} Response
 */
function releaseAssignment(req, params, body) {
  const caller = _principal(req);
  const b = body || {};
  return _commandResponse(200, control.release({
    assignmentId: params.id, holdIds: b.holdIds, expectedGeneration: b.expectedGeneration,
    requestId: b.requestId, reasonCode: b.reasonCode
  }, caller.actor));
}

/**
 * POST /api/control/assignments/:id/stop
 * @param {object} req - The request
 * @param {object} params - `{id}`
 * @param {object} body - `{requestId, reasonCode}`
 * @returns {object} Response
 */
function stopAssignment(req, params, body) {
  const caller = _principal(req);
  const b = body || {};
  return _commandResponse(200, control.stop({ assignmentId: params.id, requestId: b.requestId, reasonCode: b.reasonCode }, caller.actor));
}

/**
 * POST /api/control/assignments/:id/close
 * @param {object} req - The request
 * @param {object} params - `{id}`
 * @param {object} body - `{requestId, reasonCode}`
 * @returns {object} Response
 */
function closeAssignment(req, params, body) {
  const caller = _principal(req);
  const b = body || {};
  const result = control.close({ assignmentId: params.id, requestId: b.requestId, reasonCode: b.reasonCode }, caller.actor);
  if (!result.replayed) _syncHooks(result.assignment.projectId);
  return _commandResponse(200, result);
}

/**
 * POST /api/control/assignments/:id/ack — the target's bound launch
 * acknowledges the current state.
 * @param {object} req - The request
 * @param {object} params - `{id}`
 * @param {object} body - `{stateGeneration}`
 * @returns {object} Response
 */
function ackAssignment(req, params, body) {
  const caller = _principal(req);
  const b = body || {};
  return { status: 200, body: { assignment: control.ack({ assignmentId: params.id, stateGeneration: b.stateGeneration }, caller.actor) }, notify: null };
}

/**
 * POST /api/control/assignments/:id/exchange-closed — the issuer closes the
 * exchange an event opened.
 * @param {object} req - The request
 * @param {object} params - `{id}`
 * @param {object} body - `{eventId}`
 * @returns {object} Response
 */
function closeExchange(req, params, body) {
  const caller = _principal(req);
  const b = body || {};
  return { status: 200, body: { assignment: control.closeExchange({ assignmentId: params.id, eventId: b.eventId }, caller.actor) }, notify: null };
}

/**
 * Whether the caller is the assignment's target, reading through its bound launch.
 * @param {object} caller - Resolved caller
 * @param {object} row - Assignment row
 * @returns {boolean}
 */
function _isBoundTarget(caller, row) {
  return caller.kind === 'project' && caller.projectId === row.project_id && !!caller.launchId && caller.launchId === row.bound_launch_id;
}

/**
 * GET /api/control/assignments/:id — full status. Readable by the operator and
 * by any verified launch; a read by the target's bound launch is recorded as
 * the target having observed the current state.
 * @param {object} req - The request
 * @param {object} params - `{id}`
 * @returns {object} Response
 */
function getStatus(req, params) {
  const caller = _principal(req);
  const row = store.control.getAssignment(params.id);
  if (row && _isBoundTarget(caller, row) && row.state !== control.STATES.ACTIVE) {
    control.observe(row.assignment_id, 'status-read', caller.actor.principal);
  }
  return { status: 200, body: control.status(params.id), notify: null };
}

/**
 * GET /api/control/mine — the calling launch's own open assignment.
 * @param {object} req - The request
 * @returns {object} Response
 */
function mine(req) {
  const caller = _principal(req);
  if (caller.kind !== 'project') {
    return { status: 200, body: { assignment: null, reason: 'the operator has no assignment of its own' }, notify: null };
  }
  const row = store.control.getOpenForProject(caller.projectId);
  if (!row) return { status: 200, body: { assignment: null }, notify: null };
  if (_isBoundTarget(caller, row) && row.state !== control.STATES.ACTIVE) {
    control.observe(row.assignment_id, 'status-read', caller.actor.principal);
  }
  const st = control.status(row.assignment_id);
  return { status: 200, body: { ...st, boundToThisLaunch: _isBoundTarget(caller, row), controlHook: _hookStatus(row.project_id) }, notify: null };
}

/**
 * The managed-hook status of a project's checkout, for display. Never throws:
 * an unreadable checkout says so.
 * @param {number} projectId - Project id
 * @returns {object}
 */
function _hookStatus(projectId) {
  try {
    const project = store.projects.get(projectId);
    return project ? controlHooks.status(project.path) : { protected: false, reason: 'project not found' };
  } catch (err) {
    return { protected: false, reason: 'UNPROTECTED (hook status unreadable)' };
  }
}

/**
 * Re-sync a project's managed hooks after its governance changed. Best-effort:
 * the command already committed, and the hooks are defense in depth.
 * @param {number} projectId - Project id
 * @returns {void}
 */
function _syncHooks(projectId) {
  try {
    const project = store.projects.get(projectId);
    if (project) require('./sessions').syncControlHooks(project);
  } catch (err) {
    log.warn('Could not re-sync managed control hooks', { projectId, error: err.message });
  }
}

/**
 * GET /api/control/check?assignmentId= — the minimal answer the managed git
 * hooks ask for. It names only state and generation, so it needs no caller
 * binding: an assignment id is opaque, and knowing a lane is held grants
 * nothing.
 * @param {object} query - Parsed query
 * @returns {object} Response
 */
function check(query) {
  const id = query && query.assignmentId;
  const row = typeof id === 'string' && id.length <= 64 ? store.control.getAssignment(id) : null;
  if (!row) throw new control.ControlError(404, 'ASSIGNMENT_NOT_FOUND', 'no such assignment');
  // `blocked` is the gate's own rule (`control-state#blockingOf`), so a hook
  // never re-derives it.
  const { blocked, code } = control.blockingOf(row);
  return {
    status: 200,
    body: { assignmentId: row.assignment_id, state: row.state, stateGeneration: row.state_generation, blocked, code },
    notify: null
  };
}

/**
 * GET /api/control/assignments — every open assignment (operator only).
 * @param {object} req - The request
 * @returns {object} Response
 */
function listOpen(req) {
  const caller = _principal(req);
  if (caller.kind !== 'operator') {
    throw new control.ControlError(403, 'CONTROL_UNAUTHORIZED', 'only the operator lists every assignment; use /api/control/mine');
  }
  return { status: 200, body: { assignments: store.control.listOpen().map((r) => control.status(r.assignment_id).assignment) }, notify: null };
}

/**
 * Send the Medusa system notice for a committed control event, then record
 * what happened to it. Never throws: the command is already stored.
 * @param {{assignment: object, event: object}} change - From a command response
 * @returns {Promise<string>} The recorded outcome
 */
async function notify(change) {
  let outcome = 'failed';
  let noticeRef = null;
  try {
    const project = store.projects.get(change.assignment.projectId);
    const active = project ? store.sessions.getActive(project.id) : null;
    const to = active ? _internal.workspaceIdFor(project.path, active.id) : null;
    if (!to) {
      outcome = 'no-recipient';
    } else {
      const sent = await _internal.sendSystemMessage({
        to,
        message: JSON.stringify({
          event: 'control_changed',
          assignmentId: change.assignment.assignmentId,
          kind: change.event.kind,
          state: change.assignment.state,
          stateGeneration: change.assignment.stateGeneration,
          next: 'run `tc control status` and acknowledge with `tc control ack`'
        })
      });
      outcome = 'sent';
      noticeRef = sent && typeof sent.id === 'string' ? sent.id : null;
    }
  } catch (err) {
    log.warn('Control notice was not delivered; the command stands', { assignmentId: change.assignment.assignmentId, code: err.code || null });
    outcome = 'failed';
  }
  try {
    control.recordNotify(change.event.eventId, outcome, noticeRef);
  } catch (err) {
    log.warn('Could not record the control notice outcome', { eventId: change.event.eventId, error: err.message });
  }
  return outcome;
}

/**
 * The target marked some of its Medusa mail handled: any of those ids that was
 * a control notice for its own assignment is recorded as the target having
 * observed that state. Never throws; marking mail handled must not fail on it.
 * @param {string[]} ids - Message ids marked handled
 * @param {number} projectId - The project whose inbox marked them
 * @returns {number} How many observations were recorded
 */
function noticesHandled(ids, projectId) {
  let recorded = 0;
  for (const id of ids) {
    try {
      if (control.observeNotice(id, projectId)) recorded += 1;
    } catch (err) {
      log.warn('Could not record a handled control notice', { projectId, error: err.message });
    }
  }
  return recorded;
}

module.exports = {
  createAssignment,
  noticesHandled,
  holdAssignment,
  releaseAssignment,
  stopAssignment,
  closeAssignment,
  ackAssignment,
  closeExchange,
  getStatus,
  mine,
  check,
  listOpen,
  notify,
  _internal
};
