'use strict';

/**
 * What a check watch can say, and nothing that reads or writes: the kinds of
 * fact a watch's history holds, the state a watch is in, and the request id
 * each of its two messages is sent under.
 *
 * A watch is a session's request to be told when one named check finishes on
 * one exact commit. Its state is derived on every read and never stored, so a
 * read can only ever repeat what the records hold:
 *
 * - `waiting`: no result yet, the last read of GitHub worked (or none has been
 *   made), and the due time has not passed.
 * - `ready`: the recorded result is `success`.
 * - `failed`: the recorded result is any other conclusion.
 * - `unknown`: the server cannot say. `reasons` says why.
 *
 * A watch is open while it has no result, is not cancelled and has not
 * expired. Only an open watch is read, counts toward its project's limit, or
 * stops a second watch on the same check.
 *
 * `unknown` is never `failed` and never done: a session that reads it must not
 * treat the check as concluded either way.
 *
 * `lib/store.js` builds the stored CHECKs from the lists here, so a kind added
 * to a list needs a schema number and a rebuilt table.
 *
 * @module lib/check-watch-state
 */

/** Every kind of fact a watch's history can hold. */
const FACT_KINDS = Object.freeze([
  'registered', 'read-failed', 'read-recovered', 'resolved',
  'woke', 'wake-undeliverable', 'alarmed', 'alarm-undeliverable', 'cancelled', 'expired'
]);

/** The kinds a watch can hold once only; the database enforces it. */
const ONCE_ONLY_KINDS = Object.freeze([
  'registered', 'resolved', 'woke', 'wake-undeliverable', 'alarmed', 'alarm-undeliverable', 'cancelled', 'expired'
]);

/** The kinds that record a message the switchboard accepted, and so name its exchange. */
const SENT_KINDS = Object.freeze(['woke', 'alarmed']);

/** How the last read of GitHub for a watch ended. */
const READ_OUTCOMES = Object.freeze(['ok', 'failed']);

/** The four states a read of a watch derives. */
const STATES = Object.freeze(['waiting', 'ready', 'failed', 'unknown']);

/** Why a watch reads `unknown`. More than one can hold at once. */
const UNKNOWN_REASONS = Object.freeze({
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PAST_DUE: 'past-due',
  READ_FAILED: 'read-failed',
  UNREADABLE: 'unreadable'
});

/** The messages a watch sends: one when its result is recorded, one when its due time passes without one. */
const MESSAGE_KINDS = Object.freeze(['wake', 'alarm']);

/** What every request id a watch's messages are sent under begins with. */
const REQUEST_ID_PREFIX = 'check-watch:';

/** Most open watches one project may hold. */
const MAX_OPEN_PER_PROJECT = 20;

/** The furthest ahead a watch's due time may be set. */
const MAX_DUE_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * How long after its due time an unresolved watch is still read. Past it the
 * watch is expired: no check is worth asking GitHub about for ever, and an
 * expired watch frees its place among its project's open watches.
 */
const EXPIRE_AFTER_DUE_MS = 24 * 60 * 60 * 1000;

/** The longest check name a watch may name. */
const MAX_CHECK_NAME = 100;

/** The code every refusal from the watch records carries. */
const REFUSALS = Object.freeze({
  MALFORMED: 'CHECK_WATCH_MALFORMED',
  NOT_FOUND: 'CHECK_WATCH_NOT_FOUND',
  DUPLICATE: 'CHECK_WATCH_DUPLICATE',
  LIMIT: 'CHECK_WATCH_LIMIT',
  DUE_OUT_OF_RANGE: 'CHECK_WATCH_DUE_OUT_OF_RANGE',
  NOT_OWNER: 'CHECK_WATCH_NOT_OWNER',
  CANCELLED: 'CHECK_WATCH_CANCELLED',
  EXPIRED: 'CHECK_WATCH_EXPIRED',
  ALREADY_RESOLVED: 'CHECK_WATCH_ALREADY_RESOLVED',
  NOT_RESOLVED: 'CHECK_WATCH_NOT_RESOLVED',
  NOT_DUE: 'CHECK_WATCH_NOT_DUE',
  ALREADY_RECORDED: 'CHECK_WATCH_ALREADY_RECORDED'
});

const WATCH_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The request id one of a watch's two messages is sent under. It is made from
 * the watch's id and the message's kind alone, so a retry after a restart
 * builds the same id from the row and the switchboard refuses the second send
 * instead of delivering it twice. A watch id is never reused, so neither is a
 * request id.
 * @param {string} watchId - The watch's id
 * @param {'wake'|'alarm'} messageKind - Which of the watch's messages
 * @returns {string} At most 128 characters of letters, digits and `. _ : -`
 * @throws {Error} When the id or the kind is not one a watch has
 */
function requestIdFor(watchId, messageKind) {
  if (typeof watchId !== 'string' || !WATCH_ID_SHAPE.test(watchId)) throw new Error('requestIdFor needs a watch id');
  if (!MESSAGE_KINDS.includes(messageKind)) throw new Error('requestIdFor needs the message kind wake or alarm');
  return `${REQUEST_ID_PREFIX}${messageKind}:${watchId}`;
}

/**
 * A time as milliseconds, or null when it is not one.
 * @param {*} value - An ISO string, a Date or a number of milliseconds
 * @returns {number|null}
 */
function _ms(value) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string' && value) value = Date.parse(value);
  return Number.isFinite(value) ? value : null;
}

/**
 * The state of a watch, from its record and the time now. Pure: it reads
 * nothing and stores nothing.
 *
 * `ready` and `failed` come only from a recorded result. Without one the
 * answer is `waiting` or `unknown`, and `unknown` when anything at all stops
 * the server vouching for `waiting`: a cancelled or expired watch (it will
 * never be read again), a due time that has passed, a last read that failed,
 * or a record this function cannot make sense of.
 * @param {object} watch - A watch as `lib/check-watch-store.js` returns it
 * @param {string|number|Date} now - The time to judge the due time against
 * @returns {{state: 'waiting'|'ready'|'failed'|'unknown', reasons: string[]}}
 */
function derive(watch, now) {
  const result = watch && watch.result;
  if (result && typeof result.conclusion === 'string' && result.conclusion) {
    return { state: result.conclusion === 'success' ? 'ready' : 'failed', reasons: [] };
  }
  const reasons = [];
  const at = _ms(now);
  const due = watch ? _ms(watch.dueAt) : null;
  if (watch && watch.cancelled) reasons.push(UNKNOWN_REASONS.CANCELLED);
  if (watch && watch.expired) reasons.push(UNKNOWN_REASONS.EXPIRED);
  // A time that cannot be read is said to be that, never passed off as a due time that came. A due
  // time that did pass is said whatever else in the record cannot be read: it rests on the two times alone.
  const unreadable = !watch || at === null || due === null
    || Boolean(watch.lastRead && !READ_OUTCOMES.includes(watch.lastRead.outcome));
  if (at !== null && due !== null && at >= due) reasons.push(UNKNOWN_REASONS.PAST_DUE);
  if (watch && watch.lastRead && watch.lastRead.outcome === 'failed') reasons.push(UNKNOWN_REASONS.READ_FAILED);
  if (unreadable) reasons.push(UNKNOWN_REASONS.UNREADABLE);
  return reasons.length ? { state: 'unknown', reasons } : { state: 'waiting', reasons: [] };
}

module.exports = {
  FACT_KINDS,
  ONCE_ONLY_KINDS,
  SENT_KINDS,
  READ_OUTCOMES,
  STATES,
  UNKNOWN_REASONS,
  MESSAGE_KINDS,
  REQUEST_ID_PREFIX,
  MAX_OPEN_PER_PROJECT,
  MAX_DUE_AHEAD_MS,
  EXPIRE_AFTER_DUE_MS,
  MAX_CHECK_NAME,
  REFUSALS,
  requestIdFor,
  derive
};
