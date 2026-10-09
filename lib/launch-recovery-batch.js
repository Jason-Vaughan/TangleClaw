'use strict';

/**
 * Clearing several launches' required recovery in one operator request.
 *
 * A batch is a list of launches the operator was shown and chose, each named
 * by its exact binding. There is no "all" and no wildcard: a launch the
 * operator was never shown cannot be cleared by a request that did not name
 * it. Every item is decided by `launch-recovery-clear.js#clearOneLaunch`, the
 * same function the single clear uses, so an item is cleared here only where
 * the single clear would have cleared it.
 *
 * It proves nothing about the caller. The route establishes a signed-in
 * operator (`server.js`, `POST /api/launch/recovery-clear-batch`) and hands the
 * name in. A batch is never taken from an install that proved nobody, which is
 * why every clear in one is recorded as `operator-verified`.
 *
 * Partial success is the normal case. Each item gets its own outcome, one of
 * {@link ITEM_OUTCOMES}, and each outcome is recorded durably beside the batch
 * header (`store.recoveryClearBatches`), so a refusal is on record as well as
 * a clear.
 */

const crypto = require('node:crypto');

const store = require('./store');
const { clearOneLaunch, OUTCOMES } = require('./launch-recovery-clear');
const { createLogger } = require('./logger');

const log = createLogger('launch-recovery-batch');

/** The most launches one request may name. */
const MAX_ITEMS = 100;

const ITEM_KEYS = Object.freeze(['projectId', 'sessionId', 'sequenceId', 'recoveryRevision']);

/**
 * What happened to one item. `CLEARED` is the only outcome that changed a
 * launch.
 * @enum {string}
 */
const ITEM_OUTCOMES = Object.freeze({
  CLEARED: 'cleared',
  // The launch named, at the revision named, was already cleared.
  ALREADY_CLEAR: 'already-clear',
  // The launch is not what the request describes: its recovery revision has
  // moved, or its recovery is not one a clear applies to.
  STALE: 'stale',
  // The launch clears by the session's own reconciliation, never by an operator.
  ADVISORY: 'advisory',
  // The launch's session is no longer active.
  SESSION_ENDED: 'session-ended',
  // No such project, or no such launch of that session in that project.
  NOT_FOUND: 'not-found',
  // The project is archived, and an archived project's launches are not cleared in a batch.
  ARCHIVED: 'archived',
  // Deciding or recording the item threw. The error is in the server log.
  FAILED: 'failed'
});

/**
 * Read a batch request's body into its items, or say why it is refused.
 *
 * The whole request is refused when any part of it is wrong, so a request is
 * either applied as the operator sent it or not at all: a batch with one
 * malformed item must not clear the items around it.
 * @param {*} body - The parsed JSON body
 * @returns {{ok: true, items: object[]}|{ok: false, code: string, message: string}}
 */
function parseRequest(body) {
  const refuse = (code, message) => ({ ok: false, code, message });
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return refuse('BAD_REQUEST', 'The body must be an object with an "items" list naming the launches to clear.');
  }
  const extra = Object.keys(body).filter((key) => key !== 'items');
  if (extra.length) {
    return refuse('BAD_REQUEST',
      `The body may carry only "items". A batch names each launch it clears, and "${extra[0]}" is not understood.`);
  }
  const { items } = body;
  if (!Array.isArray(items) || items.length === 0) {
    return refuse('BAD_REQUEST', '"items" must be a list of at least one launch to clear.');
  }
  if (items.length > MAX_ITEMS) {
    return refuse('TOO_MANY_ITEMS',
      `A batch clears at most ${MAX_ITEMS} launches and this one names ${items.length}. Send them in smaller batches.`);
  }
  const parsed = [];
  const seenSequences = new Set();
  const seenSessions = new Set();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return refuse('BAD_REQUEST', `Item ${index} must be an object naming one launch.`);
    }
    const unknown = Object.keys(item).filter((key) => !ITEM_KEYS.includes(key));
    if (unknown.length) {
      return refuse('BAD_REQUEST', `Item ${index} carries "${unknown[0]}", which is not understood.`);
    }
    for (const key of ITEM_KEYS) {
      if (!Number.isSafeInteger(item[key]) || item[key] < 1) {
        return refuse('BAD_REQUEST',
          `Item ${index} needs ${ITEM_KEYS.join(', ')} as whole numbers, naming the launch as it was read.`);
      }
    }
    // A session has one launch, so two items naming one session or one launch
    // are two decisions about the same thing, whatever else they say.
    if (seenSequences.has(item.sequenceId) || seenSessions.has(item.sessionId)) {
      return refuse('DUPLICATE_ITEM', `Item ${index} names a launch that an earlier item already names.`);
    }
    seenSequences.add(item.sequenceId);
    seenSessions.add(item.sessionId);
    parsed.push({
      projectId: item.projectId,
      sessionId: item.sessionId,
      sequenceId: item.sequenceId,
      recoveryRevision: item.recoveryRevision
    });
  }
  return { ok: true, items: parsed };
}

/**
 * Decide one item and, where it may be, clear it.
 * @param {object} item - `{projectId, sessionId, sequenceId, recoveryRevision}`
 * @param {object} batch - `{batchId, itemIndex, clearedBy}`
 * @returns {string} One of {@link ITEM_OUTCOMES} other than `FAILED`
 * @throws {Error} When a record cannot be written, or the clear answers an outcome unknown here.
 */
function _decide(item, { batchId, itemIndex, clearedBy }) {
  const project = store.projects.get(item.projectId);
  if (!project) return ITEM_OUTCOMES.NOT_FOUND;
  if (project.archived) return ITEM_OUTCOMES.ARCHIVED;

  const { outcome, sequence } = clearOneLaunch({
    project,
    sessionId: item.sessionId,
    sequenceId: item.sequenceId,
    recoveryRevision: item.recoveryRevision,
    clearance: 'operator-verified',
    clearedBy,
    batchId,
    batchItemIndex: itemIndex
  });
  switch (outcome) {
    case OUTCOMES.CLEARED: return ITEM_OUTCOMES.CLEARED;
    case OUTCOMES.NOT_FOUND: return ITEM_OUTCOMES.NOT_FOUND;
    case OUTCOMES.ADVISORY: return ITEM_OUTCOMES.ADVISORY;
    case OUTCOMES.BINDING_MOVED: return ITEM_OUTCOMES.STALE;
    case OUTCOMES.SESSION_ENDED: return ITEM_OUTCOMES.SESSION_ENDED;
    case OUTCOMES.NOT_REQUIRED:
      // Stale is decided first. "Already clear" is said only of the launch the
      // request describes: cleared, at the revision the operator read. A
      // launch cleared at another revision is a different decision from the
      // one being asked for, and the operator is told to look again.
      if (sequence.recoveryRevision !== item.recoveryRevision) return ITEM_OUTCOMES.STALE;
      return sequence.recovery === 'cleared' ? ITEM_OUTCOMES.ALREADY_CLEAR : ITEM_OUTCOMES.STALE;
    default:
      // An outcome with no answer here must never be reported as a clear.
      throw new Error(`clearOneLaunch returned an outcome the batch does not handle: ${outcome}`);
  }
}

/**
 * What the launch an item names says now, read after the item was decided.
 *
 * An observation at that moment and nothing more: `stillBlocked` says the
 * launch's recovery is still `required`, not that anything is waiting on it,
 * and a launch that is no longer blocked has not thereby started work. All
 * three are null when the launch cannot be read as the item names it, because
 * "unknown" must not arrive as "not blocked".
 * @param {object} item - `{projectId, sessionId, sequenceId}`
 * @returns {{recoveryNow: (string|null), recoveryRevisionNow: (number|null), stillBlocked: (boolean|null)}}
 */
function _observe(item) {
  const unknown = { recoveryNow: null, recoveryRevisionNow: null, stillBlocked: null };
  try {
    const sequence = store.launchSequences.getBySession(item.sessionId);
    if (!sequence || sequence.id !== item.sequenceId || sequence.projectId !== item.projectId) return unknown;
    return {
      recoveryNow: sequence.recovery,
      recoveryRevisionNow: sequence.recoveryRevision,
      stillBlocked: sequence.recovery === 'required'
    };
  } catch (err) { // prawduct:allow prawduct/broad-except -- a failed re-read must not undo the outcome already decided and recorded; it is reported as unknown and logged
    log.error('A batch recovery clear could not re-read a launch', {
      session: item.sessionId, sequence: item.sequenceId, error: err.message
    });
    return unknown;
  }
}

/**
 * Decide and record one item.
 * @param {object} item - `{projectId, sessionId, sequenceId, recoveryRevision}`
 * @param {object} batch - `{batchId, itemIndex, clearedBy}`
 * @returns {{outcome: string, recorded: boolean}} `recorded` is whether the outcome is in the batch's durable record
 */
function _clearItem(item, batch) {
  const { batchId, itemIndex } = batch;
  const context = { batchId, itemIndex, project: item.projectId, session: item.sessionId, sequence: item.sequenceId };
  let outcome;
  try {
    outcome = _decide(item, batch);
  } catch (err) { // prawduct:allow prawduct/broad-except -- one item that throws must not abandon the items after it; it is reported as failed and logged
    log.error('A batch recovery clear item failed', { ...context, error: err.message });
    outcome = ITEM_OUTCOMES.FAILED;
  }
  // A cleared item's outcome was written with the clear, in one transaction.
  if (outcome === ITEM_OUTCOMES.CLEARED) return { outcome, recorded: true };
  try {
    store.recoveryClearBatches.recordItem({ batchId, itemIndex, ...item, outcome });
    return { outcome, recorded: true };
  } catch (err) { // prawduct:allow prawduct/broad-except -- an outcome that cannot be recorded is still the operator's answer; the gap is reported on the item and logged
    log.error('A batch recovery clear outcome could not be recorded', { ...context, outcome, error: err.message });
    return { outcome, recorded: false };
  }
}

/**
 * Clear a batch of launches as one operator's request.
 *
 * The batch header is written first. If it cannot be, this throws and no item
 * is looked at. After that every item is decided in request order and none
 * stops the rest.
 * @param {object} args
 * @param {object[]} args.items - From {@link parseRequest}
 * @param {string} args.clearedBy - The signed-in operator
 * @returns {{batchId: string, requestedBy: string, requestedAt: string, items: object[]}} Each
 *   item carries its `index`, the four ids as sent, its `outcome`, whether that
 *   outcome was `recorded`, and what the launch said when re-read
 *   (`recoveryNow`, `recoveryRevisionNow`, `stillBlocked`)
 * @throws {Error} When the batch header cannot be written; nothing is cleared.
 */
function clearBatch({ items, clearedBy }) {
  const batchId = crypto.randomUUID();
  const header = store.recoveryClearBatches.create({ batchId, requestedBy: clearedBy, itemCount: items.length });
  const results = items.map((item, itemIndex) => {
    const { outcome, recorded } = _clearItem(item, { batchId, itemIndex, clearedBy });
    return { index: itemIndex, ...item, outcome, recorded, ..._observe(item) };
  });
  return { batchId, requestedBy: header.requestedBy, requestedAt: header.requestedAt, items: results };
}

module.exports = { MAX_ITEMS, ITEM_OUTCOMES, parseRequest, clearBatch };
