'use strict';

/**
 * The launch recovery route family — the single recovery clear, the fleet read
 * of held launches, the batch clear and its readback, and the reconciliation
 * readback — moved out of `server.js` unchanged (#2248).
 *
 * `register()` registers the routes through the shared kernel, in the order
 * they held in `server.js`; the entry point calls it at the position the
 * routes held, so the route table reads as before. The operator proofs the
 * handlers call (`_requireOperatorWrite`, `_requireOperatorRead`) are shared
 * with other families and live in `./_callers`; nothing the handlers use still
 * lives in `server.js`, so `register` takes nothing.
 *
 * @module lib/routes/launch-recovery
 */

const { createLogger } = require('../logger');
const store = require('../store');
const launchSequence = require('../launch-sequence');
const launchRecoveryClear = require('../launch-recovery-clear');
const launchRecoveryBatch = require('../launch-recovery-batch');
const launchRecoveryHeld = require('../launch-recovery-held');
const { route, jsonResponse, errorResponse } = require('./_kernel');
const { _requireOperatorWrite, _requireOperatorRead } = require('./_callers');

// The logger keeps the entry point's name so every log line this family writes
// reads exactly as it did before the move.
const log = createLogger('server');

/**
 * Register the launch recovery routes on the shared route table.
 * @returns {void}
 */
function register() {
  // POST /api/sessions/:project/launch/recovery-clear — an operator clears a launch's
  // required recovery (Train 21, #1587).
  // Body: {sessionId, sequenceId, recoveryRevision}
  //
  // The operator proof is `_requireOperatorWrite`, whose branch order (gate state
  // first, never "is there a session") is what keeps an armed install's failed
  // authentication from being honoured as an anonymous open-install browser.
  route('POST', '/api/sessions/:project/launch/recovery-clear', (req, res, params, body) => {
    const proof = _requireOperatorWrite(req, res, {
      logEvent: 'Refused a recovery clear',
      logContext: { project: params.project },
      fallbackAction: 'clear a launch recovery',
      sameOriginWhat: 'A recovery clear',
      unauthenticated: 'Sign in to clear a launch recovery: this install requires a login, and a recovery clear is an '
        + "operator's decision.",
      machineClient: 'A recovery clear is an operator\'s decision, and a local process is not one. Clear it from the '
        + 'dashboard, or put this launch\'s project in advisory recovery mode so the session can reconcile '
        + 'its own.',
      openToken: 'This install has no login, so a recovery clear must carry the anti-forgery token its dashboard was '
        + 'issued. Reload the dashboard and try again.',
      gateUnsupported: (gateState) =>
        `A launch recovery cannot be cleared while the login gate is "${gateState}". Resolve the gate first.`
    });
    if (!proof) return;
    const clearance = proof.clearance;
    const clearedBy = proof.actor;

    const sessionId = Number(body && body.sessionId);
    const sequenceId = Number(body && body.sequenceId);
    const recoveryRevision = Number(body && body.recoveryRevision);
    if (![sessionId, sequenceId, recoveryRevision].every(Number.isInteger)) {
      log.warn('Refused a recovery clear', { code: 'BAD_REQUEST', project: params.project });
      return errorResponse(res, 400,
        'sessionId, sequenceId and recoveryRevision are required, and name the launch you are clearing.',
        'BAD_REQUEST');
    }

    const project = store.projects.getByName(params.project);
    if (!project) {
      log.warn('Refused a recovery clear', { code: 'NOT_FOUND', project: params.project, reason: 'no such project' });
      return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    }
    // The checks and the write are `clearOneLaunch`'s, shared with every other
    // route that offers this decision. Project-scoped on purpose: the path names
    // a project, and a sequence id from another one must not be clearable
    // through it.
    const result = launchRecoveryClear.clearOneLaunch({
      project, sessionId, sequenceId, recoveryRevision, clearance, clearedBy
    });
    const { outcome, sequence } = result;
    if (outcome === launchRecoveryClear.OUTCOMES.NOT_FOUND) {
      // Logged like the rest, and for a sharper reason than tidiness: on an open
      // install a page-token holder can walk `sequenceId` values against another
      // project's launches, and every probe answers 404. Silent, that sweep leaves
      // no trace at all; logged, it is a run of refusals somebody can find.
      log.warn('Refused a recovery clear', {
        code: 'NOT_FOUND', project: params.project, askedSession: sessionId, askedSequence: sequenceId
      });
      return errorResponse(res, 404,
        'That launch sequence does not belong to this project, or no longer exists.', 'NOT_FOUND');
    }
    if (outcome === launchRecoveryClear.OUTCOMES.ADVISORY) {
      log.warn('Refused a recovery clear', {
        code: 'RECOVERY_MODE_ADVISORY', project: params.project, sequence: sequence.id
      });
      return errorResponse(res, 409,
        'This launch clears recovery by reconciliation: the session writes one into its READY attestation. The '
        + 'two paths never cross, so there is nothing here for an operator to clear.', 'RECOVERY_MODE_ADVISORY');
    }
    if (outcome === launchRecoveryClear.OUTCOMES.NOT_REQUIRED) {
      log.warn('Refused a recovery clear', {
        code: 'STALE_RECOVERY', project: params.project, sequence: sequence.id, recovery: sequence.recovery
      });
      return errorResponse(res, 409,
        `This launch's recovery is "${sequence.recovery}", not "required"; nothing was changed.`,
        'STALE_RECOVERY');
    }
    if (outcome === launchRecoveryClear.OUTCOMES.BINDING_MOVED) {
      log.warn('Refused a recovery clear', {
        code: 'STALE_RECOVERY', project: params.project, sequence: sequence.id,
        asked: recoveryRevision, current: sequence.recoveryRevision
      });
      // The binding did not match: the launch moved under the click. Told as
      // `STALE_RECOVERY` with the CURRENT revision, so the dashboard can re-read
      // and offer the decision again against what is true now.
      return errorResponse(res, 409,
        `That clear names recovery revision ${recoveryRevision}, and this launch is at `
        + `${sequence.recoveryRevision}. Re-read the launch and clear it again if it still needs one.`,
        'STALE_RECOVERY');
    }
    if (outcome === launchRecoveryClear.OUTCOMES.SESSION_ENDED) {
      log.warn('Refused a recovery clear', {
        code: 'SESSION_ENDED', project: params.project, sequence: sequence.id,
        session: sequence.sessionId, sessionStatus: result.sessionStatus
      });
      return errorResponse(res, 409,
        'That launch\'s session has ended, so there is no session left for a clear to let through; nothing was '
        + 'changed. Re-read the project\'s launches: a new session has a launch of its own.',
        'SESSION_ENDED');
    }
    if (outcome !== launchRecoveryClear.OUTCOMES.CLEARED) {
      // An outcome this route has no answer for must never be reported as a clear.
      throw new Error(`clearOneLaunch returned an outcome this route does not handle: ${outcome}`);
    }
    const cleared = sequence;
    log.info('Launch recovery cleared', {
      project: project.name, sequence: cleared.id, clearance, clearedBy
    });
    jsonResponse(res, 200, {
      ok: true,
      sequenceId: cleared.id,
      sessionId: cleared.sessionId,
      recovery: cleared.recovery,
      recoveryClearance: cleared.recoveryClearance,
      recoveryClearedAt: cleared.recoveryClearedAt,
      recoveryClearedBy: cleared.recoveryClearedBy
    });
  });

  // GET /api/launch/recovery-held — the signed-in operator reads every launch on
  // this install that is waiting on their clear (#2049).
  //
  // It is the list an operator reviews before clearing several launches, so it
  // must never be served to a caller nobody proved (`_requireOperatorRead`). On
  // an install with no login the single clear still works and records itself as
  // unverified.
  route('GET', '/api/launch/recovery-held', (req, res) => {
    const reader = _requireOperatorRead(req, res, {
      logEvent: 'Refused a fleet recovery read',
      fallbackAction: 'list the launches waiting on an operator',
      noLogin: 'This install has no login, so the launches waiting on an operator cannot be listed here: nothing would '
        + 'establish that the reader is the operator. Turn the login on and sign in. Each project\'s Launch '
        + 'readiness panel still shows its own launches.',
      unauthenticated: 'Sign in to list the launches waiting on an operator: this install requires a login.',
      gateUnsupported: (gateState) =>
        `The launches waiting on an operator cannot be listed while the login gate is "${gateState}". Resolve the `
        + 'gate first.'
    });
    if (!reader) return;
    jsonResponse(res, 200, {
      gateState: reader.gateState,
      generatedAt: new Date().toISOString(),
      launches: launchRecoveryHeld.listHeld()
    });
  });

  // GET /api/launch/recovery-clear-batch/:batchId — the signed-in operator reads
  // one batch recovery clear back: what was asked, what each item was told, and
  // what each named launch says now (#2049).
  //
  // The same reader as the fleet read, for the same reason: a batch names
  // launches across projects. Any signed-in operator may read any batch; the
  // answer says who sent it.
  //
  // The header, items and clearances are the durable record. Each item's
  // `observation` is read at `observedAt` and claims nothing about task
  // acknowledgement, a prompt or resumed work.
  route('GET', '/api/launch/recovery-clear-batch/:batchId', (req, res, params) => {
    const reader = _requireOperatorRead(req, res, {
      logEvent: 'Refused a batch recovery read',
      fallbackAction: 'read a batch recovery clear',
      noLogin: 'This install has no login, so a batch recovery clear cannot be read here: nothing would establish '
        + 'that the reader is the operator. Turn the login on and sign in.',
      unauthenticated: 'Sign in to read a batch recovery clear: this install requires a login.',
      gateUnsupported: (gateState) =>
        `A batch recovery clear cannot be read while the login gate is "${gateState}". Resolve the gate first.`
    });
    if (!reader) return;
    let batch;
    try {
      batch = launchRecoveryBatch.readBatch(params.batchId);
    } catch (err) { // prawduct:allow prawduct/broad-except -- the store's message can name SQL, so it is logged and a stable answer is sent
      log.error('A batch recovery clear could not be read', { username: reader.actor, error: err.message });
      return errorResponse(res, 500, 'The batch could not be read. Try again.', 'BATCH_NOT_READ');
    }
    if (!batch) return errorResponse(res, 404, 'No batch recovery clear has this id.', 'BATCH_NOT_FOUND');
    jsonResponse(res, 200, batch);
  });

  // POST /api/launch/recovery-clear-batch — the signed-in operator clears several
  // launches' required recovery in one request (#2049).
  // Body: {items: [{projectId, sessionId, sequenceId, recoveryRevision}, ...]}
  //
  // A batch is a larger grant than one clear, so it is taken only from a proven
  // operator: the armed login, an operator's session and its CSRF token. The
  // proof is the single clear's, branch for branch, and the open-install result
  // it can return is refused here. The single clear still works on an install
  // with no login and records itself as unverified; nothing there could show
  // that the sender of a fleet-wide clear is the operator.
  //
  // Each item names one launch by the exact binding the operator read. There is
  // no wildcard. A malformed request is refused whole, with nothing applied.
  // Once accepted, every item gets its own outcome and the answer is 200 even
  // when no item was cleared: partial success is the normal case, and the
  // outcomes are the answer.
  route('POST', '/api/launch/recovery-clear-batch', (req, res, _params, body) => {
    const refusal = 'Refused a batch recovery clear';
    const noLoginBatch = 'This install has no login, so launches cannot be cleared in a batch here: nothing would '
      + 'establish that the sender is the operator. Turn the login on and sign in. Each project\'s Launch readiness '
      + 'panel still clears its own launch.';
    const proof = _requireOperatorWrite(req, res, {
      logEvent: refusal,
      logContext: {},
      fallbackAction: 'clear launch recoveries in a batch',
      sameOriginWhat: 'A batch recovery clear',
      unauthenticated: 'Sign in to clear launch recoveries in a batch: this install requires a login, and a recovery '
        + "clear is an operator's decision.",
      machineClient: 'A batch recovery clear is an operator\'s decision, and a local process is not one. '
        + noLoginBatch,
      openToken: noLoginBatch,
      gateUnsupported: (gateState) =>
        `Launch recoveries cannot be cleared in a batch while the login gate is "${gateState}". Resolve the gate first.`
    });
    if (!proof) return;
    // Keyed on what the proof established, not on the gate state that led to it:
    // any clearance other than a verified operator is refused, so a clearance
    // added to the proof later is refused here until someone decides otherwise.
    if (proof.clearance !== 'operator-verified') {
      log.warn(refusal, { code: 'LOGIN_GATE_REQUIRED', senderProof: proof.clearance });
      return errorResponse(res, 403, noLoginBatch, 'LOGIN_GATE_REQUIRED');
    }

    const request = launchRecoveryBatch.parseRequest(body);
    if (!request.ok) {
      log.warn(refusal, { code: request.code, username: proof.actor });
      return errorResponse(res, 400, request.message, request.code);
    }

    let batch;
    try {
      batch = launchRecoveryBatch.clearBatch({ items: request.items, clearedBy: proof.actor });
    } catch (err) { // prawduct:allow prawduct/broad-except -- only the batch header's write throws out of clearBatch, before any item is decided; the store's message can name SQL, so it is logged and a stable answer is sent
      log.error('A batch recovery clear could not be recorded and was not started', {
        username: proof.actor, items: request.items.length, error: err.message
      });
      return errorResponse(res, 500,
        'The batch could not be recorded, so no launch in it was cleared. Try again.', 'BATCH_NOT_RECORDED');
    }
    log.info('Batch recovery clear', {
      batchId: batch.batchId,
      clearedBy: proof.actor,
      items: batch.items.length,
      cleared: batch.items.filter((item) => item.outcome === launchRecoveryBatch.ITEM_OUTCOMES.CLEARED).length
    });
    jsonResponse(res, 200, batch);
  });

  // POST /api/sessions/:project/launch/reconciliation — the operator reads the
  // reconciliation a session wrote into its READY attestation (#1937).
  // Body: {sessionId, sequenceId}
  //
  // The text is the session's own account of why it may proceed, and in advisory
  // mode it is what cleared the launch's recovery. It is an agent's assertion,
  // so it is served to the operator and to nobody else: one session reading
  // another's would be a channel between agents that no operator sees. That is
  // why it has a route of its own and is absent from `GET /api/launch-sequences`,
  // which every caller class may read.
  //
  // It is refused outright on an install with no enabled login (ADR 0017 R3b).
  // There the proof below is of a request's SHAPE — same-origin, browser-shaped,
  // carrying a page token — and a session on this machine can produce that
  // shape, so it cannot establish that the reader is the operator. Only a
  // reader the proof names `operator-verified` is served.
  //
  // A POST although it changes nothing. The operator proof is the recovery
  // clear's, branch for branch, and on an armed install that proof asserts the
  // CSRF token, which the dashboard sends only with a state-changing method. A
  // GET would have needed a second proof, and a second proof is one that can
  // drift from the first.
  route('POST', '/api/sessions/:project/launch/reconciliation', (req, res, params, body) => {
    const refusal = 'Refused a launch reconciliation read';
    const noLoginReadback = 'This install has no login, so a session\'s reconciliation cannot be read here: '
      + 'nothing would establish that the reader is the operator. Turn the login on, sign in, and read it '
      + 'from the Launch readiness panel.';
    const proof = _requireOperatorWrite(req, res, {
      logEvent: refusal,
      logContext: { project: params.project },
      fallbackAction: 'read a launch reconciliation',
      sameOriginWhat: 'A launch reconciliation read',
      unauthenticated: 'Sign in to read a launch reconciliation: this install requires a login, and a session\'s '
        + 'reconciliation is served to the operator only.',
      machineClient: 'A session\'s reconciliation is served to the operator only, and a local process is not one. '
        + noLoginReadback,
      openToken: noLoginReadback,
      gateUnsupported: (gateState) =>
        `A launch reconciliation cannot be read while the login gate is "${gateState}". Resolve the gate first.`
    });
    if (!proof) return;
    // Keyed on what the proof established, not on the gate state that led to it:
    // any clearance other than a verified operator is refused, so a clearance
    // added to the proof later is refused here until someone decides otherwise.
    if (proof.clearance !== 'operator-verified') {
      log.warn(refusal, { code: 'LOGIN_GATE_REQUIRED', project: params.project, readerProof: proof.clearance });
      return errorResponse(res, 403, noLoginReadback, 'LOGIN_GATE_REQUIRED');
    }

    const sessionId = Number(body && body.sessionId);
    const sequenceId = Number(body && body.sequenceId);
    if (![sessionId, sequenceId].every(Number.isInteger)) {
      log.warn(refusal, { code: 'BAD_REQUEST', project: params.project });
      return errorResponse(res, 400,
        'sessionId and sequenceId are required, and name the launch whose reconciliation you are reading.',
        'BAD_REQUEST');
    }

    const project = store.projects.getByName(params.project);
    if (!project) {
      log.warn(refusal, { code: 'NOT_FOUND', project: params.project, reason: 'no such project' });
      return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    }
    const sequence = store.launchSequences.getBySession(sessionId);
    // Project-scoped, and logged: the caller here is a signed-in operator, and
    // one naming another project's launch gets no answer about it and leaves a
    // trace of having asked.
    if (!sequence || sequence.id !== sequenceId || sequence.projectId !== project.id) {
      log.warn(refusal, {
        code: 'NOT_FOUND', project: params.project, askedSession: sessionId, askedSequence: sequenceId
      });
      return errorResponse(res, 404,
        'That launch sequence does not belong to this project, or no longer exists.', 'NOT_FOUND');
    }
    const readback = launchSequence.reconciliationReadback(sequence);
    if (!readback) {
      log.warn(refusal, { code: 'NOT_ATTESTED', project: params.project, sequence: sequence.id });
      return errorResponse(res, 409,
        'This launch has not attested READY, so no reconciliation has been accepted for it.', 'NOT_ATTESTED');
    }
    // Logged without the text: the log is read by more than the operator.
    log.info('Launch reconciliation read', {
      project: project.name, sequence: sequence.id, readerProof: proof.clearance, reader: proof.actor,
      carriedText: readback.reconciliation !== null
    });
    jsonResponse(res, 200, readback);
  });
}

module.exports = { register };
