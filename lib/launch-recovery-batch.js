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
 *
 * A batch can be read back by its id ({@link readBatch}). That read adds what
 * each named launch says now, and it is an observation and nothing more: a
 * launch that is no longer blocked has not thereby acknowledged its task or
 * started work, and nothing here looks at a pane.
 */

const crypto = require('node:crypto');

const store = require('./store');
const { clearOneLaunch, OUTCOMES } = require('./launch-recovery-clear');
// The fleet read's words for what a source said, so a client reads "holds
// nothing" and "could not be read" the same way in both operator reads.
const { PART_STATES, REASON_CODES } = require('./launch-recovery-held');
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
 * The launch an item names, as stored now.
 * @param {object} item - `{projectId, sessionId, sequenceId}`
 * @returns {object|null} Null when the session has no launch, or its launch is not the one the item names
 * @throws {Error} When the store cannot be read.
 */
function _launchAsNamed(item) {
  const sequence = store.launchSequences.getBySession(item.sessionId);
  if (!sequence || sequence.id !== item.sequenceId || sequence.projectId !== item.projectId) return null;
  return sequence;
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
    const sequence = _launchAsNamed(item);
    if (!sequence) return unknown;
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

const _internal = {
  /** Swappable so a test can make one read fail. */
  launchAsNamed: _launchAsNamed,
  session: (sessionId) => store.sessions.get(sessionId)
};

/**
 * The stored status of a launch's session, read on its own so that a session
 * row that cannot be read does not hide what the launch row says.
 * @param {object} item - `{projectId, sessionId, sequenceId}`
 * @returns {object} `{state: 'recorded', value, endedAt, basis}`,
 *   `{state: 'none-recorded'}` when no session row exists, or `{state: 'unavailable', reasonCode}`
 */
function _observeSessionStatus(item) {
  try {
    const session = _internal.session(item.sessionId);
    if (!session) return { state: PART_STATES.NONE_RECORDED };
    return {
      state: PART_STATES.RECORDED,
      value: session.status,
      endedAt: session.endedAt || null,
      // The session row's own word. Nothing here checked that a pane is alive.
      basis: 'stored-session-status'
    };
  } catch (err) { // prawduct:allow prawduct/broad-except -- an unreadable session row must not hide the launch's own facts; it is reported as unavailable and logged
    log.warn('A batch read could not read a session', { session: item.sessionId, error: err.message });
    return { state: PART_STATES.UNAVAILABLE, reasonCode: REASON_CODES.SOURCE_READ_FAILED };
  }
}

/**
 * What one item's launch says at the moment of this read.
 *
 * Stored facts only. `attestedReady` says the launch row carries a READY
 * attestation, and a row without one says only that none is recorded: neither
 * says the session acknowledged a task, is working, or is waiting at a prompt.
 * Three answers stay apart, because "could not be read" and "no such launch"
 * must never arrive as "not blocked".
 * @param {object} item - `{projectId, sessionId, sequenceId}`
 * @returns {object} `{state: 'recorded', source, recovery, recoveryRevision, stillBlocked, cursor,
 *   readyAt, attestedReady, sessionStatus}`, `{state: 'none-recorded', source}` when the launch
 *   cannot be found as the item names it, or `{state: 'unavailable', source, reasonCode}`
 */
function _observeNow(item) {
  const source = 'launch_sequences and sessions, as stored';
  let sequence;
  try {
    sequence = _internal.launchAsNamed(item);
  } catch (err) { // prawduct:allow prawduct/broad-except -- one unreadable launch must not hide the rest of the batch; it is reported as unavailable and logged
    log.warn('A batch read could not read a launch', {
      session: item.sessionId, sequence: item.sequenceId, error: err.message
    });
    return { state: PART_STATES.UNAVAILABLE, source, reasonCode: REASON_CODES.SOURCE_READ_FAILED };
  }
  if (!sequence) return { state: PART_STATES.NONE_RECORDED, source };
  return {
    state: PART_STATES.RECORDED,
    source,
    recovery: sequence.recovery,
    recoveryRevision: sequence.recoveryRevision,
    stillBlocked: sequence.recovery === 'required',
    // The index of the first launch step not yet acknowledged.
    cursor: sequence.cursor,
    readyAt: sequence.readyAt || null,
    attestedReady: Boolean(sequence.readyAt),
    sessionStatus: _observeSessionStatus(item)
  };
}

/**
 * One batch as recorded, with what each of its launches says now.
 *
 * The header, the items and the clearances are the durable record and do not
 * change between two reads. `observation` on each item is read at `observedAt`
 * and can differ on the next read.
 *
 * A batch that stopped part-way has a header naming more items than have
 * rows. The launches those items named are recorded nowhere, so they are
 * reported by position only (`unrecordedIndexes`) and never guessed at.
 * @param {string} batchId - The batch's id
 * @returns {object|null} Null when no batch has this id. Otherwise `{batchId, requestedBy,
 *   requestedAt, itemCount, recordedItemCount, unrecordedIndexes, observedAt, items}`; each item
 *   carries its `index`, the four ids as the request named them, its `outcome`, `recordedAt`, the
 *   `clearance` recorded for it (`{clearance, clearedBy, clearedAt}`, null unless it was cleared)
 *   and its `observation`
 * @throws {Error} When the batch's own record cannot be read.
 */
function readBatch(batchId) {
  const header = store.recoveryClearBatches.get(batchId);
  if (!header) return null;
  const clearances = new Map(
    store.recoveryClearances.listForBatch(batchId).map((clearance) => [clearance.sequenceId, clearance])
  );
  const recorded = store.recoveryClearBatches.listItems(batchId);
  const recordedIndexes = new Set(recorded.map((item) => item.itemIndex));
  const unrecordedIndexes = [];
  for (let index = 0; index < header.itemCount; index++) {
    if (!recordedIndexes.has(index)) unrecordedIndexes.push(index);
  }
  const observedAt = new Date().toISOString();
  const items = recorded.map((item) => {
    // Only this batch's clearances are in the map, so an item it did not clear finds none.
    const clearance = clearances.get(item.sequenceId);
    return {
      index: item.itemIndex,
      projectId: item.projectId,
      sessionId: item.sessionId,
      sequenceId: item.sequenceId,
      recoveryRevision: item.recoveryRevision,
      outcome: item.outcome,
      recordedAt: item.recordedAt,
      clearance: clearance
        ? { clearance: clearance.clearance, clearedBy: clearance.clearedBy, clearedAt: clearance.clearedAt }
        : null,
      observation: _observeNow(item)
    };
  });
  return {
    batchId: header.batchId,
    requestedBy: header.requestedBy,
    requestedAt: header.requestedAt,
    itemCount: header.itemCount,
    recordedItemCount: recorded.length,
    unrecordedIndexes,
    observedAt,
    items
  };
}

module.exports = { MAX_ITEMS, ITEM_OUTCOMES, parseRequest, clearBatch, readBatch, _internal };
