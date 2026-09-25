'use strict';

/**
 * Durable HOLD/STOP control state (#1861): the rules.
 *
 * A HOLD or STOP is only useful if it is true before anyone reads about it.
 * Every command here commits to SQLite first, inside one `BEGIN IMMEDIATE`
 * transaction, and a `notify_pending` receipt is written in that same
 * transaction, so "accepted" always means "stored". Notification is attempted
 * afterwards by the caller and recorded as another receipt; a failed delivery
 * never rolls control back.
 *
 * Model:
 * - One open assignment per project. A stopped assignment stays open: it keeps
 *   governing the project until an operator creates a successor, which
 *   supersedes it in the same transaction. Nothing turns a STOP into an
 *   ungoverned project.
 * - `state_generation` is server-assigned and moves only on create, hold,
 *   release and stop. Close, rebind and every receipt leave it alone, so
 *   delivery facts can never make a state look newer than it is.
 * - HOLDs are cumulative. Each accepted HOLD is its own named hold. A RELEASE
 *   names the holds it clears and the generation it saw; it cannot clear a
 *   hold it did not name, and a RELEASE built on an older generation is
 *   refused, so a delayed go-ahead cannot undo a newer HOLD.
 * - Authority comes from the assignment's matrix and a verified principal,
 *   never from a role name, a workspace prefix or a Medusa sender.
 *
 * Principals are `'operator'` or `'project:<id>'`. `'system'` issues rebinds
 * only. Resolving a request to a principal is the HTTP layer's job
 * (`lib/control-auth.js`); this module trusts the actor it is given.
 *
 * @module lib/control-state
 */

const crypto = require('node:crypto');
const store = require('./store');

const OPERATOR = 'operator';
const SYSTEM = 'system';

/** @type {Readonly<{ACTIVE: string, HELD: string, STOPPED: string, CLOSED: string}>} */
const STATES = Object.freeze({ ACTIVE: 'active', HELD: 'held', STOPPED: 'stopped', CLOSED: 'closed' });

/**
 * The bounded reason codes each command accepts. Free prose never reaches the
 * store: a reason is a code a reader can act on, not a message.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const REASON_CODES = Object.freeze({
  create: Object.freeze(['assigned']),
  hold: Object.freeze(['boundary', 'awaiting-ruling', 'review-pending', 'incident', 'scope-question', 'operator-directive', 'self-hold']),
  release: Object.freeze(['ruling-issued', 'resolved', 'operator-directive']),
  stop: Object.freeze(['boundary-crossed', 'scope-cancelled', 'incident', 'operator-directive']),
  close: Object.freeze(['completed', 'operator-directive'])
});

/** Outcome codes a notify attempt may record; they mirror the wake ledger's vocabulary. */
const NOTIFY_OUTCOMES = Object.freeze(['sent', 'no-recipient', 'failed', 'skipped']);

/** How an assignment's target was observed to have seen its state: a gate
 * refused it, it read its own status, or it marked the control notice handled. */
const OBSERVE_HOW = Object.freeze(['gate-refusal', 'status-read', 'notice-handled']);

const MAX_HOLD_IDS = 32;
const MAX_AUTHORITY_ENTRIES = 16;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PRINCIPAL_RE = /^(operator|project:[1-9]\d{0,9})$/;
const ISSUE_REF_RE = /^[A-Za-z0-9#._/-]{1,64}$/;

/**
 * A refusal with the HTTP status and stable code the API returns. `details`
 * carries only bounded facts: ids, generations and codes.
 */
class ControlError extends Error {
  /**
   * @param {number} status - HTTP status
   * @param {string} code - Stable code
   * @param {string} message - Human-readable reason (no paths, commands or secrets)
   * @param {object} [details] - Bounded facts
   */
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ControlError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Throw a 400 for malformed input.
 * @param {string} message - What was wrong
 * @returns {never}
 */
function _malformed(message) {
  throw new ControlError(400, 'CONTROL_MALFORMED', message);
}

/**
 * Throw a 403 for a principal that may not do this.
 * @param {string} message - Why
 * @returns {never}
 */
function _unauthorized(message) {
  throw new ControlError(403, 'CONTROL_UNAUTHORIZED', message);
}

/**
 * Whether an assignment row blocks governed work, and with which code. The one
 * definition the mutation gate, the hook check endpoint and the launch path
 * share, so they can never disagree about whether work may proceed. A stopped
 * assignment that an operator successor has since superseded reads `closed`,
 * and work admitted under it stays blocked.
 * @param {object|null} row - Assignment row
 * @returns {{blocked: boolean, code: (string|null), stopped: boolean}}
 */
function blockingOf(row) {
  if (!row) return { blocked: false, code: null, stopped: false };
  if (row.state === STATES.HELD) return { blocked: true, code: 'CONTROL_HELD', stopped: false };
  if (row.state === STATES.STOPPED || (row.state === STATES.CLOSED && row.stopped_at)) {
    return { blocked: true, code: 'CONTROL_STOPPED', stopped: true };
  }
  return { blocked: false, code: null, stopped: false };
}

/**
 * A new opaque id.
 * @param {string} prefix - `asg` or `evt`
 * @returns {string}
 */
function _newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

/**
 * The principal naming a project.
 * @param {number} projectId - Project id
 * @returns {string}
 */
function projectPrincipal(projectId) {
  return `project:${projectId}`;
}

/**
 * Validate a request id.
 * @param {*} requestId - Candidate
 * @returns {string}
 */
function _requestId(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    _malformed('requestId must be 1-128 characters of [A-Za-z0-9._:-]');
  }
  return requestId;
}

/**
 * Validate a generation.
 * @param {*} value - Candidate
 * @param {string} name - Field name, for the message
 * @returns {number}
 */
function _generation(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) _malformed(`${name} must be a positive integer`);
  return value;
}

/**
 * Validate a reason code for a command.
 * @param {string} kind - Command
 * @param {*} code - Candidate
 * @returns {string}
 */
function _reason(kind, code) {
  if (typeof code !== 'string' || !REASON_CODES[kind].includes(code)) {
    _malformed(`reasonCode for ${kind} must be one of: ${REASON_CODES[kind].join(', ')}`);
  }
  return code;
}

/**
 * Validate a principal list.
 * @param {*} list - Candidate
 * @param {string} name - Field name
 * @returns {string[]}
 */
function _principalList(list, name) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > MAX_AUTHORITY_ENTRIES) {
    _malformed(`authority.${name} must be an array of at most ${MAX_AUTHORITY_ENTRIES} principals`);
  }
  for (const p of list) {
    if (typeof p !== 'string' || !PRINCIPAL_RE.test(p)) _malformed(`authority.${name} holds an invalid principal`);
  }
  return [...new Set(list)];
}

/**
 * Validate and normalize an authority matrix. The target never holds stop,
 * lifecycle or release authority over its own assignment; it may always
 * self-hold, so listing it under `hold` is redundant but harmless.
 * @param {*} raw - Candidate matrix
 * @param {number} projectId - The assignment's target project
 * @returns {{hold: string[], stop: string[], lifecycle: string[], releaseDelegations: Record<string, string[]>}}
 */
function normalizeAuthority(raw, projectId) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) _malformed('authority must be an object');
  const allowed = new Set(['hold', 'stop', 'lifecycle', 'releaseDelegations']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) _malformed(`authority has an unknown key: ${key}`);
  }
  const target = projectPrincipal(projectId);
  const out = {
    hold: _principalList(raw.hold, 'hold'),
    stop: _principalList(raw.stop, 'stop'),
    lifecycle: _principalList(raw.lifecycle, 'lifecycle'),
    releaseDelegations: {}
  };
  if (out.stop.includes(target) || out.lifecycle.includes(target)) {
    _malformed('the target project cannot hold stop or lifecycle authority over its own assignment');
  }
  const delegations = raw.releaseDelegations === undefined ? {} : raw.releaseDelegations;
  if (typeof delegations !== 'object' || delegations === null || Array.isArray(delegations)) {
    _malformed('authority.releaseDelegations must be an object');
  }
  const keys = Object.keys(delegations);
  if (keys.length > MAX_AUTHORITY_ENTRIES) _malformed('authority.releaseDelegations has too many entries');
  for (const releaser of keys) {
    if (!PRINCIPAL_RE.test(releaser)) _malformed('authority.releaseDelegations has an invalid releaser');
    if (releaser === target) _malformed('the target project cannot release holds on its own assignment');
    out.releaseDelegations[releaser] = _principalList(delegations[releaser], `releaseDelegations.${releaser}`);
  }
  return out;
}

/**
 * Parse a row's authority matrix. A row the store accepted was validated on
 * the way in, so a parse failure means the store is not what we wrote.
 * @param {object} row - Assignment row
 * @returns {ReturnType<typeof normalizeAuthority>}
 */
function _authorityOf(row) {
  try {
    return JSON.parse(row.authority_json);
  } catch (err) {
    throw new ControlError(503, 'CONTROL_STATE_UNAVAILABLE', 'assignment authority is unreadable', { assignmentId: row.assignment_id });
  }
}

/**
 * The public view of an assignment row. Never carries the bound launch id:
 * a launch id is a bearer credential.
 * @param {object} row - Assignment row
 * @returns {object}
 */
function _summary(row) {
  const active = store.control.listHolds(row.assignment_id, { activeOnly: true });
  return {
    assignmentId: row.assignment_id,
    projectId: row.project_id,
    issueRef: row.issue_ref,
    state: row.state,
    stateGeneration: row.state_generation,
    activeHoldIds: active.map((h) => h.hold_id),
    boundSessionId: row.bound_session_id,
    createdAt: row.created_at,
    stoppedAt: row.stopped_at,
    closedAt: row.closed_at,
    supersededBy: row.superseded_by
  };
}

/**
 * The public view of an event row.
 * @param {object} row - Event row
 * @returns {object}
 */
function _eventView(row) {
  return {
    eventId: row.event_id,
    seq: row.seq,
    kind: row.kind,
    stateGeneration: row.state_generation,
    issuer: row.issuer_principal,
    operatorAuthority: row.operator_proof,
    reasonCode: row.reason_code,
    expectedGeneration: row.expected_generation,
    targetHoldIds: row.target_hold_ids_json ? JSON.parse(row.target_hold_ids_json) : null,
    createdAt: row.created_at
  };
}

/**
 * Load an assignment or throw 404.
 * @param {string} assignmentId - Assignment id
 * @returns {object} Row
 */
function _load(assignmentId) {
  if (typeof assignmentId !== 'string' || assignmentId.length > 64) _malformed('assignmentId is invalid');
  const row = store.control.getAssignment(assignmentId);
  if (!row) throw new ControlError(404, 'ASSIGNMENT_NOT_FOUND', 'no such assignment');
  return row;
}

/**
 * Refuse commands on a closed or (unless allowed) stopped assignment.
 * @param {object} row - Assignment row
 * @returns {void}
 */
function _assertOpenAndNotStopped(row) {
  if (row.state === STATES.CLOSED) {
    throw new ControlError(409, 'ASSIGNMENT_CLOSED', 'the assignment is closed', { assignmentId: row.assignment_id });
  }
  if (row.state === STATES.STOPPED) {
    throw new ControlError(409, 'ASSIGNMENT_STOPPED', 'the assignment is stopped; only a new operator assignment continues the work', {
      assignmentId: row.assignment_id, stateGeneration: row.state_generation
    });
  }
}

/**
 * The result of a request id already used on this assignment: the original
 * outcome for the same command, or a refusal for a different one.
 * @param {object|null} prior - Earlier event with this request id
 * @param {string} kind - The command now asked for
 * @returns {object|null} A replay result, or null when the id is fresh
 */
function _replay(prior, kind) {
  if (!prior) return null;
  if (prior.kind !== kind) _malformed(`requestId was already used for a ${prior.kind}`);
  const row = store.control.getAssignment(prior.assignment_id);
  return { replayed: true, assignment: _summary(row), event: _eventView(prior), holdId: kind === 'hold' ? prior.event_id : undefined };
}

/**
 * Append a state event plus its `notify_pending` receipt.
 * @param {object} fields - Event row values
 * @returns {object} The stored event row
 */
function _appendEvent(fields) {
  const eventId = _newId('evt');
  store.control.insertEvent({ ...fields, event_id: eventId });
  store.control.insertReceipt({ event_id: eventId, fact: 'notify_pending', actor_principal: SYSTEM });
  return store.control.getEvent(eventId);
}

/**
 * Validate an actor object.
 * @param {*} actor - `{principal, operatorProof?, launchId?}`
 * @returns {{principal: string, operatorProof: (string|null), launchId: (string|null)}}
 */
function _actor(actor) {
  if (!actor || typeof actor.principal !== 'string' || !PRINCIPAL_RE.test(actor.principal)) {
    _unauthorized('the caller is not a control principal');
  }
  const proof = actor.principal === OPERATOR ? actor.operatorProof : null;
  if (actor.principal === OPERATOR && proof !== 'verified-session' && proof !== 'ambient-open') {
    throw new ControlError(503, 'CONTROL_OPERATOR_UNVERIFIABLE', 'operator identity could not be verified');
  }
  return { principal: actor.principal, operatorProof: proof || null, launchId: actor.launchId || null };
}

/**
 * Create an assignment. Operator only. When the project's open assignment is
 * stopped, the new one supersedes it in the same transaction, which is the
 * only way work resumes after a STOP.
 * @param {object} input
 * @param {number} input.projectId - Target project
 * @param {string} input.requestId - Idempotency key
 * @param {string} [input.issueRef] - Bounded issue reference, e.g. `#1861`
 * @param {object} [input.authority] - Authority matrix
 * @param {{sessionId: number, launchId: string}|null} [input.binding] - The target's current launch, if one is live
 * @param {object} actor - The resolved caller
 * @returns {{replayed: boolean, assignment: object, event: object, supersededAssignmentId: (string|null)}}
 */
function create(input, actor) {
  const who = _actor(actor);
  if (who.principal !== OPERATOR) _unauthorized('only the operator creates assignments');
  const projectId = input.projectId;
  if (!Number.isSafeInteger(projectId) || projectId < 1) _malformed('projectId must be a positive integer');
  const requestId = _requestId(input.requestId);
  const issueRef = input.issueRef === undefined || input.issueRef === null ? null : input.issueRef;
  if (issueRef !== null && (typeof issueRef !== 'string' || !ISSUE_REF_RE.test(issueRef))) _malformed('issueRef is invalid');
  const authority = normalizeAuthority(input.authority, projectId);
  const binding = input.binding || null;

  return store.control.transaction(() => {
    const prior = store.control.getCreateByRequest(requestId);
    if (prior) {
      return { ...(_replay(prior, 'create')), supersededAssignmentId: null };
    }
    const open = store.control.getOpenForProject(projectId);
    if (open && open.state !== STATES.STOPPED) {
      throw new ControlError(409, 'ASSIGNMENT_OPEN', 'the project already has an open assignment', {
        assignmentId: open.assignment_id, stateGeneration: open.state_generation
      });
    }
    const assignmentId = _newId('asg');
    let supersededAssignmentId = null;
    if (open) {
      supersededAssignmentId = open.assignment_id;
      const closeEvent = _appendEvent({
        assignment_id: open.assignment_id, kind: 'close', state_generation: open.state_generation,
        issuer_principal: OPERATOR, operator_proof: who.operatorProof, reason_code: 'superseded',
        request_id: `supersede:${assignmentId}`
      });
      // No separate notice goes out for the superseded assignment: the
      // successor's create notice is the one the target receives. Said here,
      // so the old assignment's status never shows a notice forever pending.
      store.control.insertReceipt({ event_id: closeEvent.event_id, fact: 'notify_attempted', outcome_code: 'skipped', actor_principal: SYSTEM });
      store.control.setAssignmentState(open.assignment_id, {
        state: STATES.CLOSED, state_generation: open.state_generation, superseded_by: assignmentId
      });
    }
    store.control.insertAssignment({
      assignment_id: assignmentId, project_id: projectId, issue_ref: issueRef,
      authority_json: JSON.stringify(authority),
      bound_session_id: binding ? binding.sessionId : null, bound_launch_id: binding ? binding.launchId : null,
      state: STATES.ACTIVE, state_generation: 1, created_by_kind: OPERATOR
    });
    const event = _appendEvent({
      assignment_id: assignmentId, kind: 'create', state_generation: 1, issuer_principal: OPERATOR,
      operator_proof: who.operatorProof, reason_code: _reason('create', input.reasonCode || 'assigned'), request_id: requestId
    });
    return {
      replayed: false,
      assignment: _summary(store.control.getAssignment(assignmentId)),
      event: _eventView(event),
      supersededAssignmentId
    };
  });
}

/**
 * Place a HOLD. Each accepted HOLD is its own named hold and bumps the
 * generation; HOLDs are never stale, so `expectedGeneration` is informational.
 * The target may hold itself; anyone else needs the operator or a place in
 * `authority.hold`.
 * @param {{assignmentId: string, requestId: string, reasonCode: string, expectedGeneration?: number}} input
 * @param {object} actor - The resolved caller
 * @returns {{replayed: boolean, assignment: object, event: object, holdId: string}}
 */
function hold(input, actor) {
  const who = _actor(actor);
  const requestId = _requestId(input.requestId);
  const reasonCode = _reason('hold', input.reasonCode);
  const expected = input.expectedGeneration === undefined ? null : _generation(input.expectedGeneration, 'expectedGeneration');

  return store.control.transaction(() => {
    const row = _load(input.assignmentId);
    const replayed = _replay(store.control.getEventByRequest(row.assignment_id, requestId), 'hold');
    if (replayed) return replayed;
    _assertOpenAndNotStopped(row);
    const authority = _authorityOf(row);
    const isTarget = who.principal === projectPrincipal(row.project_id);
    if (who.principal !== OPERATOR && !isTarget && !authority.hold.includes(who.principal)) {
      _unauthorized('this principal may not place a HOLD on this assignment');
    }
    const generation = row.state_generation + 1;
    const event = _appendEvent({
      assignment_id: row.assignment_id, kind: 'hold', state_generation: generation, issuer_principal: who.principal,
      operator_proof: who.operatorProof, reason_code: reasonCode, request_id: requestId, expected_generation: expected
    });
    store.control.insertHold({
      hold_id: event.event_id, assignment_id: row.assignment_id, issuer_principal: who.principal, opened_generation: generation
    });
    store.control.setAssignmentState(row.assignment_id, { state: STATES.HELD, state_generation: generation });
    return {
      replayed: false,
      assignment: _summary(store.control.getAssignment(row.assignment_id)),
      event: _eventView(event),
      holdId: event.event_id
    };
  });
}

/**
 * Whether `principal` may release a hold issued by `issuer`.
 * @param {string} principal - Releaser
 * @param {string} issuer - The hold's issuer
 * @param {object} authority - Assignment authority matrix
 * @returns {boolean}
 */
function _mayRelease(principal, issuer, authority) {
  if (principal === OPERATOR) return true;
  if (principal === issuer) return true;
  const delegated = authority.releaseDelegations[principal] || [];
  return delegated.includes(issuer);
}

/**
 * Release named holds. Needs the generation the releaser saw: a RELEASE built
 * on an older state is refused, so a delayed go-ahead cannot clear a newer
 * HOLD. The assignment stays held while any hold remains. The target never
 * releases anything on its own assignment.
 * @param {{assignmentId: string, holdIds: string[], expectedGeneration: number, requestId: string, reasonCode: string}} input
 * @param {object} actor - The resolved caller
 * @returns {{replayed: boolean, assignment: object, event: object}}
 */
function release(input, actor) {
  const who = _actor(actor);
  const requestId = _requestId(input.requestId);
  const reasonCode = _reason('release', input.reasonCode);
  const expected = _generation(input.expectedGeneration, 'expectedGeneration');
  const holdIds = input.holdIds;
  if (!Array.isArray(holdIds) || holdIds.length === 0 || holdIds.length > MAX_HOLD_IDS
      || holdIds.some((id) => typeof id !== 'string' || id.length > 64) || new Set(holdIds).size !== holdIds.length) {
    _malformed(`holdIds must name 1-${MAX_HOLD_IDS} distinct holds`);
  }

  return store.control.transaction(() => {
    const row = _load(input.assignmentId);
    const replayed = _replay(store.control.getEventByRequest(row.assignment_id, requestId), 'release');
    if (replayed) return replayed;
    _assertOpenAndNotStopped(row);
    if (who.principal === projectPrincipal(row.project_id)) {
      _unauthorized('the target never releases holds on its own assignment');
    }
    const authority = _authorityOf(row);
    const allHolds = store.control.listHolds(row.assignment_id);
    const mayReleaseSomething = who.principal === OPERATOR
      || Object.prototype.hasOwnProperty.call(authority.releaseDelegations, who.principal)
      || allHolds.some((h) => h.issuer_principal === who.principal);
    if (!mayReleaseSomething) _unauthorized('this principal may not release holds on this assignment');

    const active = store.control.listHolds(row.assignment_id, { activeOnly: true });
    if (expected !== row.state_generation) {
      throw new ControlError(409, 'STALE_GENERATION', 'the release was built on an older state', {
        assignmentId: row.assignment_id, stateGeneration: row.state_generation, activeHoldIds: active.map((h) => h.hold_id)
      });
    }
    const byId = new Map(active.map((h) => [h.hold_id, h]));
    const missing = holdIds.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new ControlError(409, 'HOLD_NOT_ACTIVE', 'a named hold is not active on this assignment', {
        assignmentId: row.assignment_id, stateGeneration: row.state_generation, activeHoldIds: active.map((h) => h.hold_id)
      });
    }
    for (const id of holdIds) {
      if (!_mayRelease(who.principal, byId.get(id).issuer_principal, authority)) {
        _unauthorized('this principal may not release a named hold');
      }
    }
    const generation = row.state_generation + 1;
    const event = _appendEvent({
      assignment_id: row.assignment_id, kind: 'release', state_generation: generation, issuer_principal: who.principal,
      operator_proof: who.operatorProof, reason_code: reasonCode, request_id: requestId, expected_generation: expected,
      target_hold_ids_json: JSON.stringify(holdIds)
    });
    store.control.releaseHolds(holdIds, generation, event.event_id);
    const remaining = store.control.listHolds(row.assignment_id, { activeOnly: true });
    store.control.setAssignmentState(row.assignment_id, {
      state: remaining.length ? STATES.HELD : STATES.ACTIVE, state_generation: generation
    });
    return { replayed: false, assignment: _summary(store.control.getAssignment(row.assignment_id)), event: _eventView(event) };
  });
}

/**
 * STOP an assignment. Terminal: nothing releases it, and it keeps governing
 * the project until an operator successor supersedes it.
 * @param {{assignmentId: string, requestId: string, reasonCode: string}} input
 * @param {object} actor - The resolved caller
 * @returns {{replayed: boolean, assignment: object, event: object}}
 */
function stop(input, actor) {
  const who = _actor(actor);
  const requestId = _requestId(input.requestId);
  const reasonCode = _reason('stop', input.reasonCode);

  return store.control.transaction(() => {
    const row = _load(input.assignmentId);
    const replayed = _replay(store.control.getEventByRequest(row.assignment_id, requestId), 'stop');
    if (replayed) return replayed;
    _assertOpenAndNotStopped(row);
    const authority = _authorityOf(row);
    if (who.principal !== OPERATOR && !authority.stop.includes(who.principal)) {
      _unauthorized('this principal may not STOP this assignment');
    }
    const generation = row.state_generation + 1;
    const event = _appendEvent({
      assignment_id: row.assignment_id, kind: 'stop', state_generation: generation, issuer_principal: who.principal,
      operator_proof: who.operatorProof, reason_code: reasonCode, request_id: requestId
    });
    store.control.setAssignmentState(row.assignment_id, { state: STATES.STOPPED, state_generation: generation });
    return { replayed: false, assignment: _summary(store.control.getAssignment(row.assignment_id)), event: _eventView(event) };
  });
}

/**
 * Close an assignment that finished normally. Only an ACTIVE assignment with
 * no active holds closes: a held one would lose its holds, and a stopped one
 * would become an ungoverned project.
 * @param {{assignmentId: string, requestId: string, reasonCode: string}} input
 * @param {object} actor - The resolved caller
 * @returns {{replayed: boolean, assignment: object, event: object}}
 */
function close(input, actor) {
  const who = _actor(actor);
  const requestId = _requestId(input.requestId);
  const reasonCode = _reason('close', input.reasonCode);

  return store.control.transaction(() => {
    const row = _load(input.assignmentId);
    const replayed = _replay(store.control.getEventByRequest(row.assignment_id, requestId), 'close');
    if (replayed) return replayed;
    const authority = _authorityOf(row);
    if (who.principal !== OPERATOR && !authority.lifecycle.includes(who.principal)) {
      _unauthorized('this principal may not close this assignment');
    }
    if (row.state === STATES.CLOSED) {
      throw new ControlError(409, 'ASSIGNMENT_CLOSED', 'the assignment is already closed', { assignmentId: row.assignment_id });
    }
    if (row.state === STATES.STOPPED) {
      throw new ControlError(409, 'STOP_TERMINAL', 'a stopped assignment is never closed; an operator successor supersedes it', {
        assignmentId: row.assignment_id, stateGeneration: row.state_generation
      });
    }
    const active = store.control.listHolds(row.assignment_id, { activeOnly: true });
    if (row.state === STATES.HELD || active.length) {
      throw new ControlError(409, 'ACTIVE_HOLDS', 'the assignment has active holds', {
        assignmentId: row.assignment_id, stateGeneration: row.state_generation, activeHoldIds: active.map((h) => h.hold_id)
      });
    }
    const event = _appendEvent({
      assignment_id: row.assignment_id, kind: 'close', state_generation: row.state_generation, issuer_principal: who.principal,
      operator_proof: who.operatorProof, reason_code: reasonCode, request_id: requestId
    });
    store.control.setAssignmentState(row.assignment_id, { state: STATES.CLOSED, state_generation: row.state_generation });
    return { replayed: false, assignment: _summary(store.control.getAssignment(row.assignment_id)), event: _eventView(event) };
  });
}

/**
 * Record that the target acknowledged the state at `stateGeneration`. Only the
 * target's currently bound launch may acknowledge, and only the current state.
 * @param {{assignmentId: string, stateGeneration: number}} input
 * @param {object} actor - The resolved caller (must carry its launch id)
 * @returns {object} The assignment summary
 */
function ack(input, actor) {
  const who = _actor(actor);
  const generation = _generation(input.stateGeneration, 'stateGeneration');
  return store.control.transaction(() => {
    const row = _load(input.assignmentId);
    if (who.principal !== projectPrincipal(row.project_id) || !who.launchId || who.launchId !== row.bound_launch_id) {
      _unauthorized('only the target\'s bound launch acknowledges its assignment');
    }
    if (generation !== row.state_generation) {
      throw new ControlError(409, 'STALE_GENERATION', 'the acknowledgement names an older state', {
        assignmentId: row.assignment_id, stateGeneration: row.state_generation
      });
    }
    const event = store.control.latestStateEvent(row.assignment_id);
    if (!store.control.hasReceipt(event.event_id, 'observed')) {
      store.control.insertReceipt({ event_id: event.event_id, fact: 'observed', outcome_code: 'status-read', actor_principal: who.principal });
    }
    if (!store.control.hasReceipt(event.event_id, 'acknowledged')) {
      store.control.insertReceipt({ event_id: event.event_id, fact: 'acknowledged', actor_principal: who.principal });
    }
    return _summary(row);
  });
}

/**
 * Record, once per state, that the target was shown it.
 * @param {string} assignmentId - Assignment id
 * @param {string} how - One of {@link OBSERVE_HOW}
 * @param {string} principal - Who observed
 * @returns {boolean} True when a receipt was written
 */
function observe(assignmentId, how, principal) {
  if (!OBSERVE_HOW.includes(how)) _malformed('unknown observation');
  const event = store.control.latestStateEvent(assignmentId);
  if (!event || store.control.hasReceipt(event.event_id, 'observed')) return false;
  store.control.insertReceipt({ event_id: event.event_id, fact: 'observed', outcome_code: how, actor_principal: principal });
  return true;
}

/**
 * Record the outcome of a notification attempt for an event.
 * @param {string} eventId - Event id
 * @param {string} outcome - One of {@link NOTIFY_OUTCOMES}
 * @param {string|null} [noticeRef] - The Medusa message id of the notice sent, when one was
 * @returns {void}
 */
function recordNotify(eventId, outcome, noticeRef = null) {
  const ref = typeof noticeRef === 'string' && noticeRef.length > 0 && noticeRef.length <= 128 ? noticeRef : null;
  store.control.insertReceipt({
    event_id: eventId, fact: 'notify_attempted', outcome_code: NOTIFY_OUTCOMES.includes(outcome) ? outcome : 'failed',
    actor_principal: SYSTEM, notice_ref: ref
  });
}

/**
 * Record that the target marked a control notice handled, as the target having
 * observed the state that notice announced. Only the target project's own
 * reading counts; an id that names no control notice is ignored.
 * @param {string} noticeRef - Medusa message id the target marked handled
 * @param {number} projectId - The project whose inbox marked it
 * @returns {boolean} True when an observation was recorded
 */
function observeNotice(noticeRef, projectId) {
  if (typeof noticeRef !== 'string' || noticeRef.length === 0 || noticeRef.length > 128) return false;
  const sent = store.control.getReceiptByNotice(noticeRef);
  if (!sent) return false;
  const event = store.control.getEvent(sent.event_id);
  const row = event ? store.control.getAssignment(event.assignment_id) : null;
  if (!row || row.project_id !== projectId) return false;
  if (store.control.hasReceipt(event.event_id, 'observed')) return false;
  store.control.insertReceipt({ event_id: event.event_id, fact: 'observed', outcome_code: 'notice-handled', actor_principal: projectPrincipal(projectId) });
  return true;
}

/**
 * The issuer (or the operator) closes the exchange an event opened.
 * @param {{assignmentId: string, eventId: string}} input
 * @param {object} actor - The resolved caller
 * @returns {object} The assignment summary
 */
function closeExchange(input, actor) {
  const who = _actor(actor);
  return store.control.transaction(() => {
    const row = _load(input.assignmentId);
    const event = typeof input.eventId === 'string' ? store.control.getEvent(input.eventId) : null;
    if (!event || event.assignment_id !== row.assignment_id) {
      throw new ControlError(404, 'EVENT_NOT_FOUND', 'no such event on this assignment');
    }
    if (who.principal !== OPERATOR && who.principal !== event.issuer_principal) {
      _unauthorized('only the issuer or the operator closes an exchange');
    }
    if (!store.control.hasReceipt(event.event_id, 'exchange_closed')) {
      store.control.insertReceipt({ event_id: event.event_id, fact: 'exchange_closed', actor_principal: who.principal });
    }
    return _summary(row);
  });
}

/**
 * Bind the project's open assignment to a new launch, through the supported
 * launch path. The old launch fails authorization from then on because every
 * target check compares against `bound_launch_id`. The launch path refuses a
 * STOPPED project before calling this; a stopped assignment is never rebound.
 * @param {{projectId: number, sessionId: number, launchId: string}} input
 * @returns {object|null} The assignment summary, or null when the project is ungoverned
 */
function rebind(input) {
  return store.control.transaction(() => {
    const row = store.control.getOpenForProject(input.projectId);
    if (!row) return null;
    if (row.state === STATES.STOPPED) {
      throw new ControlError(423, 'CONTROL_STOPPED', 'the project\'s assignment is stopped', {
        assignmentId: row.assignment_id, stateGeneration: row.state_generation
      });
    }
    if (row.bound_launch_id === input.launchId && row.bound_session_id === input.sessionId) return _summary(row);
    store.control.setBinding(row.assignment_id, input.sessionId, input.launchId);
    store.control.insertEvent({
      event_id: _newId('evt'), assignment_id: row.assignment_id, kind: 'rebind', state_generation: row.state_generation,
      issuer_principal: SYSTEM, reason_code: 'successor-launch', request_id: `rebind:${_newId('req')}`
    });
    return _summary(store.control.getAssignment(row.assignment_id));
  });
}

/**
 * The full status of an assignment: summary, holds, and events with their
 * receipts in order. Bounded codes and timestamps only.
 * @param {string} assignmentId - Assignment id
 * @returns {object}
 */
function status(assignmentId) {
  const row = _load(assignmentId);
  const events = store.control.listEvents(row.assignment_id);
  const receipts = store.control.listReceipts(events.map((e) => e.event_id));
  const byEvent = new Map();
  for (const r of receipts) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
    byEvent.get(r.event_id).push({ receiptSeq: r.receipt_seq, fact: r.fact, outcomeCode: r.outcome_code, actor: r.actor_principal, at: r.at });
  }
  return {
    assignment: _summary(row),
    holds: store.control.listHolds(row.assignment_id).map((h) => ({
      holdId: h.hold_id, issuer: h.issuer_principal, openedGeneration: h.opened_generation,
      releasedGeneration: h.released_generation, releasedByEventId: h.released_by_event_id
    })),
    events: events.map((e) => ({ ..._eventView(e), receipts: byEvent.get(e.event_id) || [] }))
  };
}

/**
 * Rebuild both caches from the event log alone, for audit and tests: the
 * events are the truth, and the caches must agree with them.
 * @param {string} assignmentId - Assignment id
 * @returns {{state: string, stateGeneration: number, activeHoldIds: string[]}}
 */
function replayState(assignmentId) {
  const events = store.control.listEvents(assignmentId);
  let state = null;
  let generation = 0;
  const active = new Set();
  for (const e of events) {
    switch (e.kind) {
      case 'create': state = STATES.ACTIVE; generation = e.state_generation; break;
      case 'hold': active.add(e.event_id); state = STATES.HELD; generation = e.state_generation; break;
      case 'release':
        for (const id of JSON.parse(e.target_hold_ids_json)) active.delete(id);
        state = active.size ? STATES.HELD : STATES.ACTIVE; generation = e.state_generation; break;
      case 'stop': state = STATES.STOPPED; generation = e.state_generation; break;
      case 'close': state = STATES.CLOSED; break;
      default: break;
    }
  }
  return { state, stateGeneration: generation, activeHoldIds: [...active] };
}

module.exports = {
  STATES,
  REASON_CODES,
  NOTIFY_OUTCOMES,
  OBSERVE_HOW,
  OPERATOR,
  ControlError,
  projectPrincipal,
  normalizeAuthority,
  blockingOf,
  observeNotice,
  create,
  hold,
  release,
  stop,
  close,
  ack,
  observe,
  recordNotify,
  closeExchange,
  rebind,
  status,
  replayState
};
