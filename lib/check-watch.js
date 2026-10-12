'use strict';

/**
 * The check watch monitor (#2323): the server reads each open watch's check
 * from GitHub itself, on a timer, and records what it reads.
 *
 * A watch is a session's request to be told when one named check finishes on
 * one exact commit. Until this monitor existed a watch's record only changed
 * when something asked; now a terminal result is recorded without anyone
 * asking, and a watch that stays unresolved long past its due time is expired.
 *
 * Each pass, for every open watch that is due a read, least recently read
 * first: read the check (`lib/github-checks.js#readCheck`), record the reading
 * (`lib/check-watch-store.js#recordRead`), and then, if the watch still has no
 * result and is `EXPIRE_AFTER_DUE_MS` past its due time, expire it. The read
 * comes before the expiry so a result that is there at the last read is the
 * watch's result, not lost to the expiry.
 *
 * What it deliberately is not:
 * - **It tells nobody.** It records. No session is messaged or typed into, and
 *   this module loads nothing of the switchboard. A session finds the result by
 *   reading its watch.
 * - **It is not a retry loop on one watch.** A read that fails is recorded as
 *   failed and the watch waits its turn like any other.
 * - **It decides nothing about state.** What a watch reads as is
 *   `lib/check-watch-state.js#derive` over the record this writes.
 *
 * Three bounds on what it spends, because every read is a `gh` call under this
 * server's own GitHub identity, made with nobody asking:
 * - one pass at a time: a pass still reading when the timer fires again is not
 *   joined by a second;
 * - at most `MAX_IN_FLIGHT` reads at once;
 * - at most `MAX_READS_PER_PASS` reads in a pass, across every project. Past
 *   it the watches read longest ago go first and the rest wait for a later
 *   pass, so the cadence stretches and no watch is starved.
 *
 * An expiry is not held back by a last read that could not reach GitHub: a
 * watch on a repository that can no longer be read would otherwise be read for
 * ever and never free its place.
 *
 * Lifecycle mirrors `lib/workload-nudge.js`: `start()` arms a `setInterval`
 * wired in `server.js`, `stop()` clears it.
 *
 * @module lib/check-watch
 */

const { createLogger } = require('./logger');
const state = require('./check-watch-state');

const log = createLogger('check-watch');

/**
 * Pass cadence, which is what sets how often a watch is read: once a minute.
 * A check takes minutes, so a result recorded up to a minute late costs
 * nothing, and each read is a call to GitHub.
 * @type {number}
 */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * The least time between two reads of one watch. Shorter than the cadence on
 * purpose: a read is stamped when it completes, so a gap equal to the cadence
 * would find every watch a moment short of due and read it every other pass.
 * It is what stops a burst when passes come faster than the timer (a restart,
 * or a caller driving the monitor by hand).
 * @type {number}
 */
const MIN_READ_GAP_MS = 45_000;

/**
 * The most reads one pass makes, across every project. A project may hold
 * `MAX_OPEN_PER_PROJECT` open watches and nothing bounds the number of
 * projects, so without this the reads made with nobody asking grow with the
 * install and are spent from the one GitHub identity everything else here
 * reads with.
 * @type {number}
 */
const MAX_READS_PER_PASS = 30;

/** The most reads in flight at once: `lib/github-facts.js`'s number for the same `gh`. */
const MAX_IN_FLIGHT = 4;

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/**
 * The pass now running, if one is.
 * @type {Promise<object>|null}
 */
let _pass = null;

/** Whether the last pass left watches unread because of the ceiling, so the log says it on a change and not every minute. */
let _deferring = false;

/**
 * What one pass did, all zero.
 * @returns {{open: number, read: number, resolved: number, readFailed: number, expired: number, deferred: number, errors: number}}
 */
function _summary() {
  return { open: 0, read: 0, resolved: 0, readFailed: 0, expired: 0, deferred: 0, errors: 0 };
}

/**
 * Whether a watch is due a read: never read, or last read at least
 * `MIN_READ_GAP_MS` ago. A last read that cannot be placed in time, or that
 * lies ahead of the clock, does not hold a watch back.
 * @param {object} watch - An open watch
 * @param {number} now - The pass's clock reading, in ms
 * @returns {boolean}
 */
function _dueForRead(watch, now) {
  const last = watch.lastRead ? Date.parse(watch.lastRead.at) : NaN;
  if (!Number.isFinite(last)) return true;
  const gap = now - last;
  return !(gap >= 0 && gap < MIN_READ_GAP_MS);
}

/**
 * Read a watch's check. Never throws and always answers with a reading: a
 * reader that throws is a read that failed, said as one.
 * @param {object} watch - An open watch
 * @returns {Promise<object>} A reading in `readCheck`'s shape
 */
async function _read(watch) {
  try {
    return await _internal.readCheck(watch.repo, watch.headSha, watch.checkName);
  // prawduct:allow prawduct/broad-except -- whatever the reader throws, the watch is owed a recorded failed read; an unrecorded one would keep it at the head of every pass
  } catch (err) {
    return { status: 'unavailable', reason: `the check could not be read (${err && err.message ? err.message : 'unknown error'})` };
  }
}

/**
 * Record a reading, and record it as a failed read when the store does not
 * take it as a reading at all.
 * @param {object} watch - The watch read
 * @param {object} reading - What the reader answered
 * @returns {object} The store's answer
 */
function _record(watch, reading) {
  const out = _internal.recordRead(watch.watchId, reading);
  if (out.ok || out.code !== state.REFUSALS.MALFORMED) return out;
  return _internal.recordRead(watch.watchId, { status: 'unavailable', reason: 'the reader answered with something that is not a reading of a check' });
}

/**
 * Say in the log what a recorded read changed, when it changed something.
 * @param {object} names - The watch's identifying fields
 * @param {object} out - The store's answer to the read
 * @returns {void}
 */
function _logRead(names, out) {
  if (out.recorded === 'resolved') {
    log.info('Recorded a watched check\'s result', { ...names, conclusion: out.watch.result.conclusion, runId: out.watch.result.runId });
  } else if (out.recorded === 'read-failed') {
    log.warn('A watched check could not be read from GitHub; its watch reads unknown until a read works', {
      ...names, reason: out.watch.lastRead ? out.watch.lastRead.detail : null
    });
  } else if (out.recorded === 'read-recovered') {
    log.info('A watched check can be read from GitHub again', names);
  }
}

/**
 * Read one watch, record the reading, and expire the watch if it is still
 * unresolved long past its due time. Never throws.
 * @param {object} watch - An open watch
 * @param {number} now - The pass's clock reading, in ms
 * @param {object} summary - The pass's counts, added to here
 * @returns {Promise<void>}
 */
async function _readOne(watch, now, summary) {
  const names = { watch: watch.watchId, project: watch.projectId, repo: watch.repo, sha: watch.headSha, check: watch.checkName };
  try {
    const reading = await _read(watch);
    summary.read += 1;
    const out = _record(watch, reading);
    // Refused: the watch was cancelled, resolved or expired while GitHub was
    // being read. It is no longer this monitor's to write.
    if (!out.ok) return;
    _logRead(names, out);
    if (out.watch.lastRead && out.watch.lastRead.outcome === 'failed') summary.readFailed += 1;
    if (out.watch.result) {
      summary.resolved += 1;
      return;
    }
    if (!(now >= Date.parse(watch.dueAt) + state.EXPIRE_AFTER_DUE_MS)) return;
    const expired = _internal.recordExpired(watch.watchId);
    if (!expired.ok) return;
    summary.expired += 1;
    log.info('Expired a check watch that stayed unresolved; it is not read again and a new watch is needed', { ...names, dueAt: watch.dueAt });
  // prawduct:allow prawduct/broad-except -- one watch must not stop the pass; the next pass reads it again
  } catch (err) {
    summary.errors += 1;
    log.warn('Check watch read failed for one watch', { ...names, error: err && err.message });
  }
}

/**
 * Run `work` over `items`, at most `width` at a time.
 * @param {object[]} items - What to work through, in order
 * @param {number} width - The most in flight at once
 * @param {(item: object) => Promise<void>} work - Must not reject
 * @returns {Promise<void>}
 */
async function _pool(items, width, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

/**
 * One pass over the open watches.
 * @param {number} now - The pass's clock reading, in ms
 * @returns {Promise<object>} What the pass did
 */
async function _run(now) {
  const summary = _summary();
  let open;
  try {
    open = _internal.listUnresolved();
  // prawduct:allow prawduct/broad-except -- a store that cannot be read ends this pass, not the server; the next pass asks again
  } catch (err) {
    summary.errors += 1;
    log.warn('Check watch pass could not list the open watches', { error: err && err.message });
    return summary;
  }
  summary.open = open.length;
  // The store lists the watch read longest ago first, so the ceiling takes
  // those and the rest are at the front of the next pass.
  const due = open.filter((watch) => _dueForRead(watch, now));
  const batch = due.slice(0, MAX_READS_PER_PASS);
  summary.deferred = due.length - batch.length;
  if ((summary.deferred > 0) !== _deferring) {
    _deferring = summary.deferred > 0;
    if (_deferring) {
      log.warn('More check watches are due a read than one pass reads; the rest wait for a later pass, so each is read less often', {
        due: due.length, ceiling: MAX_READS_PER_PASS, deferred: summary.deferred
      });
    } else {
      log.info('Every check watch due a read was read in one pass again', { due: due.length });
    }
  }
  await _pool(batch, MAX_IN_FLIGHT, (watch) => _readOne(watch, now, summary));
  return summary;
}

/**
 * One pass over the open watches: read each that is due, record what was
 * read, and expire what stayed unresolved too long. Never throws and never
 * rejects. A pass asked for while one is running does nothing and says so.
 * @param {number} [now] - The clock reading to judge against
 * @returns {Promise<{open: number, read: number, resolved: number, readFailed: number, expired: number, deferred: number, errors: number, skipped?: string}>}
 *   What the pass did, for the tests and for a caller driving the monitor by hand
 */
function tick(now = _internal.now()) {
  if (_pass) return Promise.resolve({ ..._summary(), skipped: 'pass-running' });
  const pass = _run(now)
    // prawduct:allow prawduct/broad-except -- a monitor pass must never take the server down or leave an unhandled rejection
    .catch((err) => {
      log.warn('check-watch: pass error', { error: err && err.message });
      return { ..._summary(), errors: 1 };
    })
    .finally(() => {
      if (_pass === pass) _pass = null;
    });
  _pass = pass;
  return pass;
}

/**
 * Start the monitor. Idempotent: a second call while running is a no-op.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=60000] - Pass cadence
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  _timer = setInterval(() => { tick(); }, intervalMs);
  if (_timer.unref) _timer.unref(); // never hold the event loop open
  log.info('check-watch monitor started', { intervalMs, readsPerPass: MAX_READS_PER_PASS });
}

/**
 * Wait for the pass now running, if one is, to finish. For a caller driving
 * the monitor by hand; the timer never waits.
 * @returns {Promise<void>}
 */
async function settled() {
  while (_pass) await _pass;
}

/**
 * Stop the monitor. A pass already reading finishes and records what it read.
 * @returns {void}
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _deferring = false;
}

/**
 * Injectable seams, lazily required the way the other monitors do it: this
 * module is required by `server.js` at load, before the store is initialized.
 */
const _internal = {
  now: () => Date.now(),
  readCheck: (repo, sha, name) => require('./github-checks').readCheck(repo, sha, name),
  listUnresolved: () => require('./check-watch-store').listUnresolved(),
  recordRead: (watchId, reading) => require('./check-watch-store').recordRead(watchId, reading),
  recordExpired: (watchId) => require('./check-watch-store').recordExpired(watchId)
};

module.exports = {
  start,
  stop,
  tick,
  settled,
  DEFAULT_INTERVAL_MS,
  MIN_READ_GAP_MS,
  MAX_READS_PER_PASS,
  MAX_IN_FLIGHT,
  _internal
};
