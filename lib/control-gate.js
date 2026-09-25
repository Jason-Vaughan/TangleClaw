'use strict';

/**
 * The mutation gate for durable HOLD/STOP (#1861).
 *
 * Every TangleClaw-owned mutation calls {@link checkMutation} immediately
 * before its side effect. The gate reads the control tables directly: it never
 * consults the Medusa inbox, the wake ledger or a listener, so a HOLD that is
 * stored but not yet read by anyone still refuses the next governed mutation.
 * An allow is never cached across a side effect; each boundary asks again.
 *
 * It gates the mutation's SUBJECT, not merely whoever made the request:
 * - `job`: a wrap run or other background work, with the assignment captured
 *   when it was admitted. The captured assignment is checked, and so is the
 *   project's current one, which can only tighten: a newer assignment never
 *   authorizes older work, and a stopped-then-superseded assignment keeps
 *   refusing the jobs admitted under it.
 * - `target`: something done TO a project's session, such as command
 *   injection. The project's current assignment is checked.
 * - `caller`: a caller-owned global request (restart, update apply). The
 *   operator is never held by a lane; a verified launch is held only by its
 *   own assignment; a caller who cannot be attributed is refused while any
 *   assignment is held or stopped, because otherwise omitting two headers
 *   would be a bypass.
 *
 * A project with no assignment is ungoverned and passes. When the control
 * store cannot be read, a subject known to be governed is refused with 503;
 * the gate remembers which projects it has seen governed so that a failing
 * store does not quietly ungovern them.
 *
 * What this cannot do: a `git`/`gh` command run from a shell never reaches it.
 * See docs/control-state.md.
 *
 * @module lib/control-gate
 */

const store = require('./store');
const controlState = require('./control-state');
const { createLogger } = require('./logger');

const log = createLogger('control-gate');

/** Projects last seen with an open assignment → that assignment id. */
const _knownGoverned = new Map();

/**
 * Remember a project's governance as last read.
 * @param {number} projectId - Project id
 * @param {object|null} row - Its open assignment row, or null
 * @returns {void}
 */
function _remember(projectId, row) {
  if (row) _knownGoverned.set(projectId, row.assignment_id);
  else _knownGoverned.delete(projectId);
}

/**
 * The refusal an assignment row calls for, or null.
 * @param {object|null} row - Assignment row
 * @returns {object|null}
 */
function _refusalFor(row) {
  if (!row) return null;
  if (row.state === controlState.STATES.HELD) {
    const holds = store.control.listHolds(row.assignment_id, { activeOnly: true });
    return {
      status: 423,
      code: 'CONTROL_HELD',
      message: 'this lane is on HOLD: TangleClaw-governed mutations are refused until the holds are released',
      details: { assignmentId: row.assignment_id, stateGeneration: row.state_generation, activeHoldIds: holds.map((h) => h.hold_id) }
    };
  }
  // A stopped assignment that an operator successor has since superseded is
  // closed, but it was stopped: work admitted under it stays refused.
  if (row.state === controlState.STATES.STOPPED || (row.state === controlState.STATES.CLOSED && row.stopped_at)) {
    return {
      status: 423,
      code: 'CONTROL_STOPPED',
      message: 'this lane is STOPPED: only a new operator assignment continues the work',
      details: { assignmentId: row.assignment_id, stateGeneration: row.state_generation }
    };
  }
  return null;
}

/**
 * The fail-closed answer when the control store cannot be read.
 * @returns {object}
 */
function _unavailable() {
  return {
    status: 503,
    code: 'CONTROL_STATE_UNAVAILABLE',
    message: 'control state could not be read, so this governed mutation is refused; nothing was changed',
    details: {}
  };
}

/**
 * Record that the target was shown its state by a refusal. Best-effort: the
 * refusal stands whether or not the receipt lands.
 * @param {object} refusal - The refusal
 * @param {number} projectId - The subject project
 * @returns {void}
 */
function _observe(refusal, projectId) {
  try {
    controlState.observe(refusal.details.assignmentId, 'gate-refusal', controlState.projectPrincipal(projectId));
  } catch (err) {
    log.warn('Could not record a gate refusal as observed', { assignmentId: refusal.details.assignmentId, error: err.message });
  }
}

/**
 * Check a job subject.
 * @param {{projectId: number, assignmentId: (string|null)}} subject
 * @returns {object|null}
 */
function _checkJob(subject) {
  const captured = subject.assignmentId ? store.control.getAssignment(subject.assignmentId) : null;
  if (subject.assignmentId && !captured) {
    // The job was admitted under an assignment the store no longer has: the
    // state cannot be established, so the governed job stops.
    return _unavailable();
  }
  const current = store.control.getOpenForProject(subject.projectId);
  _remember(subject.projectId, current);
  const refusal = _refusalFor(captured) || (current && (!captured || current.assignment_id !== captured.assignment_id) ? _refusalFor(current) : null);
  if (refusal) _observe(refusal, subject.projectId);
  return refusal;
}

/**
 * Check a target subject.
 * @param {{projectId: number}} subject
 * @returns {object|null}
 */
function _checkTarget(subject) {
  const current = store.control.getOpenForProject(subject.projectId);
  _remember(subject.projectId, current);
  const refusal = _refusalFor(current);
  if (refusal) _observe(refusal, subject.projectId);
  return refusal;
}

/**
 * Check a caller subject.
 * @param {{caller: object}} subject - `caller` from `control-auth#resolveControlCaller`
 * @returns {object|null}
 */
function _checkCaller(subject) {
  const caller = subject.caller || { kind: 'unbound' };
  if (caller.kind === 'operator') return null;
  if (caller.kind === 'project') {
    const current = store.control.getOpenForProject(caller.projectId);
    _remember(caller.projectId, current);
    const refusal = _refusalFor(current);
    if (refusal) _observe(refusal, caller.projectId);
    return refusal;
  }
  // The live Project Master is a verified launch with no assignment of its own.
  if (caller.kind === 'master') return null;
  if (store.control.anyRestricted()) {
    return {
      status: 423,
      code: 'CONTROL_CALLER_UNATTRIBUTABLE',
      message: 'a lane is held or stopped, and this caller could not be attributed: send the verified launch headers '
        + '(x-tangleclaw-project-id and x-tangleclaw-launch-id) or act as the signed-in operator',
      details: {}
    };
  }
  return null;
}

/**
 * Whether a subject was last seen governed, for the store-failure path.
 * @param {object} subject - The subject
 * @returns {boolean}
 */
function _knownToBeGoverned(subject) {
  if (subject.kind === 'job' && subject.assignmentId) return true;
  if (subject.kind === 'job' || subject.kind === 'target') return _knownGoverned.has(subject.projectId);
  const caller = subject.caller || {};
  if (caller.kind === 'operator' || caller.kind === 'master') return false;
  if (caller.kind === 'project') return _knownGoverned.has(caller.projectId);
  return _knownGoverned.size > 0;
}

/**
 * Decide whether a governed mutation may proceed, immediately before it runs.
 * @param {object} args
 * @param {string} args.surface - What is about to happen (for the log), e.g. `wrap-commit`
 * @param {{kind: 'job', projectId: number, assignmentId: (string|null)}|{kind: 'target', projectId: number}|{kind: 'caller', caller: object}} args.subject
 * @returns {{status: number, code: string, message: string, details: object}|null} A refusal, or null to proceed
 */
function checkMutation({ surface, subject }) {
  let refusal;
  try {
    if (subject.kind === 'job') refusal = _checkJob(subject);
    else if (subject.kind === 'target') refusal = _checkTarget(subject);
    else if (subject.kind === 'caller') refusal = _checkCaller(subject);
    else throw new Error(`unknown control subject kind: ${subject.kind}`);
  } catch (err) { // prawduct:allow prawduct/broad-except -- a gate that cannot read control state must fail closed for governed subjects rather than let the mutation through or crash its caller
    if (_knownToBeGoverned(subject)) {
      log.error('Control state unreadable; refusing a governed mutation', { surface, error: err.message });
      return _unavailable();
    }
    log.warn('Control state unreadable for a subject never seen governed; allowing', { surface, error: err.message });
    return null;
  }
  if (refusal) log.info('Governed mutation refused by control state', { surface, code: refusal.code, assignmentId: refusal.details.assignmentId || null });
  return refusal;
}

/**
 * The open assignment a project has right now, to capture when a job is
 * admitted. Null for an ungoverned project.
 * @param {number} projectId - Project id
 * @returns {string|null}
 */
function captureAssignment(projectId) {
  try {
    const row = store.control.getOpenForProject(projectId);
    _remember(projectId, row);
    return row ? row.assignment_id : null;
  } catch (err) { // prawduct:allow prawduct/broad-except -- admission must not crash on an unreadable store: the run's first boundary check fails closed for a project known to be governed
    log.warn('Could not capture the control assignment at admission', { projectId, error: err.message });
    return null;
  }
}

/**
 * Prime the governed-project memory from the store, so a store failure after
 * a restart still knows which projects are governed.
 * @returns {void}
 */
function prime() {
  try {
    for (const row of store.control.listOpen()) _remember(row.project_id, row);
  } catch (err) {
    log.warn('Could not prime control-gate memory', { error: err.message });
  }
}

/** Test seam: forget what the gate has seen. */
function _resetForTests() {
  _knownGoverned.clear();
}

module.exports = { checkMutation, captureAssignment, prime, _resetForTests };
