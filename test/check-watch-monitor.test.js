'use strict';

// #2323: the check watch monitor. Each test drives the real monitor over the
// real store on a temporary database, with a fake reader in place of GitHub and
// one fake clock for the monitor and the store. Nothing here calls GitHub, and
// the monitor sends nothing to any session, which the last tests pin.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const watches = require('../lib/check-watch-store');
const state = require('../lib/check-watch-state');
const monitor = require('../lib/check-watch');

const REPO = 'Jason-Vaughan/TangleClaw';
const START = Date.parse('2026-10-12T05:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const RUNNING = { status: 'running', runId: '1', app: 'github-actions' };
const UNAVAILABLE = { status: 'unavailable', reason: 'gh api timed out after 10000ms' };

const real = { ...monitor._internal };
const realStoreNow = watches._internal.now;

let tmpDir = null;
let clock = START;
/** Every read the monitor asked for, in order: the commit read. */
let reads = [];
/** What the fake reader answers for a commit; anything not named here is still running. */
let answers = new Map();

/**
 * A 40-character commit id that is different for every number.
 * @param {number} n - Any whole number
 * @returns {string}
 */
function sha(n) {
  return n.toString(16).padStart(40, '0');
}

/**
 * The test clock as an ISO string, `ms` from the start.
 * @param {number} [ms] - Milliseconds after the start
 * @returns {string}
 */
function at(ms = 0) {
  return new Date(START + ms).toISOString();
}

/**
 * A concluded reading.
 * @param {string} [conclusion] - The conclusion
 * @returns {object}
 */
function concluded(conclusion = 'success') {
  return { status: 'concluded', conclusion, runId: '114669381605', completedAt: '2026-10-12T05:13:25.000Z', app: 'github-actions' };
}

/**
 * Register a watch on commit number `n`, due an hour from the test clock.
 * @param {number} n - Which commit
 * @param {object} [overrides] - Fields to change
 * @returns {string} The watch id
 */
function watch(n, overrides = {}) {
  const out = watches.registerWatch({
    projectId: 7, sessionId: 1409, launchId: 'launch-owner', repo: REPO, prNumber: 2328,
    headSha: sha(n), checkName: 'test', dueAt: new Date(clock + HOUR).toISOString(), ...overrides
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.watch.watchId;
}

/**
 * Register `count` watches on commits 0 up, spread over three projects so none is over its own limit.
 * @param {number} count - How many
 * @returns {string[]} The watch ids, in order
 */
function many(count) {
  return Array.from({ length: count }, (_, n) => watch(n, { projectId: 7 + (n % 3) }));
}

/**
 * The kinds of a watch's facts, in order.
 * @param {string} watchId - Watch id
 * @returns {string[]}
 */
function history(watchId) {
  return watches.listFacts(watchId).map((f) => f.kind);
}

/**
 * How many times a commit was read.
 * @param {number} n - Which commit
 * @returns {number}
 */
function readsOf(n) {
  return reads.filter((s) => s === sha(n)).length;
}

/**
 * Move the clock on and run one pass.
 * @param {number} [ms] - How far to move the clock first
 * @returns {Promise<object>} The pass's summary
 */
function pass(ms = 0) {
  clock += ms;
  return monitor.tick();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-check-watch-monitor-'));
  store._setBasePath(tmpDir);
  store.init();
  clock = START;
  reads = [];
  answers = new Map();
  watches._internal.now = () => new Date(clock).toISOString();
  monitor._internal.now = () => clock;
  monitor._internal.readCheck = async (repo, commit, name) => {
    assert.equal(repo, REPO);
    assert.equal(name, 'test');
    reads.push(commit);
    const answer = answers.get(commit);
    return typeof answer === 'function' ? answer() : (answer || RUNNING);
  };
});

afterEach(async () => {
  monitor.stop();
  await monitor.settled();
  Object.assign(monitor._internal, real);
  watches._internal.now = realStoreNow;
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('check-watch monitor: reading and recording (#2323)', () => {
  it('a running check that becomes success has its result written once, however many passes follow', async () => {
    const id = watch(1);
    assert.deepEqual(await pass(), { open: 1, read: 1, resolved: 0, readFailed: 0, expired: 0, deferred: 0, errors: 0 });
    assert.equal(state.derive(watches.getWatch(id), clock).state, 'waiting');
    assert.deepEqual(watches.getWatch(id).lastRead, { at: at(), outcome: 'ok', detail: null });

    answers.set(sha(1), concluded());
    const resolving = await pass(MINUTE);
    assert.equal(resolving.resolved, 1);
    const w = watches.getWatch(id);
    assert.deepEqual(w.result, { conclusion: 'success', runId: '114669381605', completedAt: '2026-10-12T05:13:25.000Z', readAt: at(MINUTE) });
    assert.deepEqual(state.derive(w, clock), { state: 'ready', reasons: [] });

    for (let i = 0; i < 5; i++) assert.deepEqual(await pass(MINUTE), { open: 0, read: 0, resolved: 0, readFailed: 0, expired: 0, deferred: 0, errors: 0 });
    assert.equal(readsOf(1), 2);
    assert.deepEqual(history(id), ['registered', 'resolved']);
    assert.deepEqual(watches.getWatch(id), w);
  });

  it('a failing conclusion is written once and reads failed', async () => {
    const id = watch(1);
    answers.set(sha(1), concluded('failure'));
    await pass();
    await pass(MINUTE);
    assert.equal(watches.getWatch(id).result.conclusion, 'failure');
    assert.deepEqual(state.derive(watches.getWatch(id), clock), { state: 'failed', reasons: [] });
    assert.deepEqual(history(id), ['registered', 'resolved']);
    assert.equal(readsOf(1), 1);
  });

  it('a check GitHub has no run of yet is read again each minute and stays waiting', async () => {
    const id = watch(1);
    answers.set(sha(1), { status: 'not-found' });
    await pass();
    await pass(MINUTE);
    assert.equal(readsOf(1), 2);
    assert.equal(watches.getWatch(id).result, null);
    assert.equal(state.derive(watches.getWatch(id), clock).state, 'waiting');
  });

  it('an unreadable GitHub writes no result and one read-failed for the whole run of failures, then one recovery', async () => {
    const id = watch(1);
    answers.set(sha(1), UNAVAILABLE);
    assert.equal((await pass()).readFailed, 1);
    await pass(MINUTE);
    await pass(MINUTE);
    const failing = watches.getWatch(id);
    assert.equal(failing.result, null);
    assert.deepEqual(failing.lastRead, { at: at(2 * MINUTE), outcome: 'failed', detail: UNAVAILABLE.reason });
    assert.deepEqual(state.derive(failing, clock), { state: 'unknown', reasons: ['read-failed'] });
    assert.deepEqual(history(id), ['registered', 'read-failed']);

    answers.delete(sha(1));
    assert.equal((await pass(MINUTE)).readFailed, 0);
    assert.deepEqual(history(id), ['registered', 'read-failed', 'read-recovered']);
    assert.equal(state.derive(watches.getWatch(id), clock).state, 'waiting');

    answers.set(sha(1), concluded());
    await pass(MINUTE);
    assert.deepEqual(history(id), ['registered', 'read-failed', 'read-recovered', 'resolved']);
  });

  it('a watch past its due time still reads unknown, is still read, and a late result is still its result', async () => {
    const id = watch(1);
    await pass(HOUR);
    assert.deepEqual(state.derive(watches.getWatch(id), clock), { state: 'unknown', reasons: ['past-due'] });
    answers.set(sha(1), concluded());
    await pass(MINUTE);
    assert.deepEqual(state.derive(watches.getWatch(id), clock), { state: 'ready', reasons: [] });
  });

  it('a cancelled watch is never read', async () => {
    const id = watch(1);
    assert.equal(watches.cancelWatch(id, { projectId: 7, launchId: 'launch-owner' }).ok, true);
    assert.equal((await pass()).open, 0);
    await pass(MINUTE);
    assert.equal(reads.length, 0);
    assert.equal(watches.getWatch(id).lastRead, null);
  });

  it('a watch cancelled while GitHub is being read is left as the cancellation left it', async () => {
    const id = watch(1);
    answers.set(sha(1), () => {
      assert.equal(watches.cancelWatch(id, { projectId: 7, launchId: 'launch-owner' }).ok, true);
      return concluded();
    });
    assert.deepEqual(await pass(), { open: 1, read: 1, resolved: 0, readFailed: 0, expired: 0, deferred: 0, errors: 0 });
    assert.equal(watches.getWatch(id).result, null);
    assert.deepEqual(history(id), ['registered', 'cancelled']);
  });

  it('the store closed and reopened between a read and the next pass loses nothing', async () => {
    const id = watch(1);
    await pass();
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    assert.deepEqual(watches.getWatch(id).lastRead, { at: at(), outcome: 'ok', detail: null });
    answers.set(sha(1), concluded());
    assert.equal((await pass(MINUTE)).resolved, 1);
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    assert.equal(watches.getWatch(id).result.conclusion, 'success');
    assert.equal((await pass(MINUTE)).open, 0);
    assert.deepEqual(history(id), ['registered', 'resolved']);
  });
});

describe('check-watch monitor: how much it reads (#2323)', () => {
  it('reads each watch once a minute on the timer\'s cadence, and never twice inside the guard', async () => {
    watch(1);
    await pass();
    assert.equal((await pass(monitor.MIN_READ_GAP_MS - 1)).read, 0);
    assert.equal(readsOf(1), 1);
    assert.equal((await pass(1)).read, 1);
    // On the timer: a read stamped a few seconds into its pass is still due at the next one.
    clock = START + 10 * MINUTE;
    await pass();
    clock += 5 * SECOND;
    watch(2);
    await pass();
    const before = reads.length;
    clock = START + 11 * MINUTE;
    assert.equal((await pass()).read, 2);
    assert.equal(reads.length, before + 2);
    assert.equal(monitor.DEFAULT_INTERVAL_MS, MINUTE);
    assert.ok(monitor.MIN_READ_GAP_MS < monitor.DEFAULT_INTERVAL_MS);
  });

  it('has no more than four reads in flight at once', async () => {
    for (let n = 1; n <= 10; n++) watch(n);
    let inFlight = 0;
    let most = 0;
    monitor._internal.readCheck = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return RUNNING;
    };
    assert.equal((await pass()).read, 10);
    assert.equal(monitor.MAX_IN_FLIGHT, 4);
    assert.equal(most, 4);
  });

  it('reads at most thirty watches in a pass across every project, the least recently read first, and starves none', async () => {
    assert.equal(monitor.MAX_READS_PER_PASS, 30);
    // Three projects, fifteen watches each: more than one pass reads, and no project over its own limit.
    const ids = many(45);
    // Each write lands a millisecond after the last, as real ones do, so "least recently read" has an order inside a pass.
    let writes = 0;
    watches._internal.now = () => new Date(clock + writes++).toISOString();

    const first = await pass();
    assert.equal(first.open, 45);
    assert.equal(first.read, 30);
    assert.equal(first.deferred, 15);
    const unread = ids.filter((id) => watches.getWatch(id).lastRead === null);
    assert.equal(unread.length, 15);

    // The next pass starts with the fifteen never read, then the ones read longest ago.
    const second = await pass(MINUTE);
    assert.equal(second.read, 30);
    assert.equal(second.deferred, 15);
    for (const id of unread) assert.ok(Date.parse(watches.getWatch(id).lastRead.at) >= START + MINUTE, id);

    await pass(MINUTE);
    // Ninety reads over forty-five watches: every one was read exactly twice, so none waits behind another for ever.
    assert.equal(reads.length, 90);
    for (let n = 0; n < 45; n++) assert.equal(readsOf(n), 2, `commit ${n}`);
    // The cadence stretched: three passes gave each watch two reads, not three.
  });

  it('a watch whose reads fail keeps its turn and does not hold the front of the queue', async () => {
    many(31);
    answers.set(sha(0), UNAVAILABLE);
    await pass();
    assert.equal(readsOf(0), 1);
    assert.equal(readsOf(30), 0);
    await pass(MINUTE);
    assert.equal(readsOf(30), 1);
  });

  it('a pass asked for while one is running does nothing and says so', async () => {
    watch(1);
    let release;
    monitor._internal.readCheck = () => new Promise((resolve) => { release = () => resolve(RUNNING); });
    const running = monitor.tick();
    await new Promise((resolve) => setImmediate(resolve));
    try {
      assert.deepEqual(await monitor.tick(), { open: 0, read: 0, resolved: 0, readFailed: 0, expired: 0, deferred: 0, errors: 0, skipped: 'pass-running' });
    } finally {
      release();
    }
    assert.equal((await running).read, 1);
    await monitor.settled();
    monitor._internal.readCheck = async () => RUNNING;
    assert.equal((await pass(MINUTE)).read, 1);
  });
});

describe('check-watch monitor: expiry (#2323)', () => {
  it('expires a watch 24 hours past its due time and not before, once, reads it no more and frees its place', async () => {
    const id = watch(1);
    await pass(HOUR + DAY - 1);
    assert.equal(watches.getWatch(id).expired, null);
    assert.equal(watches.countOpen(7), 1);

    const expiring = await pass(MINUTE);
    assert.equal(expiring.read, 1);
    assert.equal(expiring.expired, 1);
    const w = watches.getWatch(id);
    assert.deepEqual(w.expired, { at: at(HOUR + DAY - 1 + MINUTE) });
    assert.deepEqual(state.derive(w, clock), { state: 'unknown', reasons: ['expired', 'past-due'] });
    assert.deepEqual(history(id), ['registered', 'expired']);
    assert.equal(watches.countOpen(7), 0);

    const readsThen = reads.length;
    assert.deepEqual(await pass(MINUTE), { open: 0, read: 0, resolved: 0, readFailed: 0, expired: 0, deferred: 0, errors: 0 });
    assert.equal(reads.length, readsThen);
    assert.deepEqual(history(id), ['registered', 'expired']);
    // The same check on the same commit can be watched afresh.
    watch(1);
  });

  it('a result that is there at the last read wins over the expiry', async () => {
    const id = watch(1);
    answers.set(sha(1), concluded('failure'));
    const out = await pass(HOUR + DAY + MINUTE);
    assert.equal(out.resolved, 1);
    assert.equal(out.expired, 0);
    const w = watches.getWatch(id);
    assert.equal(w.expired, null);
    assert.equal(w.result.conclusion, 'failure');
    assert.deepEqual(history(id), ['registered', 'resolved']);
  });

  it('a last read that could not reach GitHub does not hold the expiry back', async () => {
    const id = watch(1);
    answers.set(sha(1), UNAVAILABLE);
    const out = await pass(HOUR + DAY);
    assert.equal(out.readFailed, 1);
    assert.equal(out.expired, 1);
    assert.deepEqual(history(id), ['registered', 'read-failed', 'expired']);
    assert.deepEqual(state.derive(watches.getWatch(id), clock), { state: 'unknown', reasons: ['expired', 'past-due', 'read-failed'] });
  });

  it('a watch past the ceiling is not expired before it has had its last read', async () => {
    many(31);
    answers.set(sha(30), concluded());
    const first = await pass(HOUR + DAY);
    assert.equal(first.expired, 30);
    assert.equal(first.deferred, 1);
    const second = await pass(MINUTE);
    assert.equal(second.resolved, 1);
    assert.equal(second.expired, 0);
  });
});

describe('check-watch monitor: it never throws (#2323)', () => {
  it('a reader that throws or answers nonsense is a recorded failed read, and the other watches are still read', async () => {
    const thrown = watch(1);
    const nonsense = watch(2);
    const fine = watch(3);
    answers.set(sha(1), () => { throw new Error('spawn gh ENOENT'); });
    answers.set(sha(2), { status: 'concluded', conclusion: 'green' });
    answers.set(sha(3), concluded());
    const out = await pass();
    assert.deepEqual(out, { open: 3, read: 3, resolved: 1, readFailed: 2, expired: 0, deferred: 0, errors: 0 });
    assert.match(watches.getWatch(thrown).lastRead.detail, /spawn gh ENOENT/);
    assert.match(watches.getWatch(nonsense).lastRead.detail, /not a reading of a check/);
    assert.equal(watches.getWatch(nonsense).result, null);
    assert.deepEqual(history(nonsense), ['registered', 'read-failed']);
    assert.equal(watches.getWatch(fine).result.conclusion, 'success');
  });

  it('a store that cannot be listed, written or expired ends in a counted error, never a throw', async () => {
    watch(1);
    watch(2);
    monitor._internal.listUnresolved = () => { throw new Error('database is locked'); };
    assert.deepEqual(await pass(), { open: 0, read: 0, resolved: 0, readFailed: 0, expired: 0, deferred: 0, errors: 1 });

    monitor._internal.listUnresolved = real.listUnresolved;
    monitor._internal.recordRead = (id, reading) => {
      if (watches.getWatch(id).headSha === sha(1)) throw new Error('database is locked');
      return real.recordRead(id, reading);
    };
    const written = await pass();
    assert.equal(written.errors, 1);
    assert.equal(written.read, 2);
    assert.equal(readsOf(2), 1);

    monitor._internal.recordRead = real.recordRead;
    monitor._internal.recordExpired = () => { throw new Error('database is locked'); };
    const expiring = await pass(HOUR + DAY);
    assert.equal(expiring.errors, 2);
    assert.equal(expiring.expired, 0);

    monitor._internal.recordExpired = real.recordExpired;
    assert.equal((await pass(MINUTE)).expired, 2);
  });

  it('started, it runs passes on its timer until stopped; a second start is a no-op', async () => {
    let listed = 0;
    monitor._internal.listUnresolved = () => { listed += 1; return []; };
    monitor.start({ intervalMs: 5 });
    monitor.start({ intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    monitor.stop();
    await monitor.settled();
    assert.ok(listed >= 2, `listed ${listed} time(s)`);
    const then = listed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(listed, then);
    monitor.stop();
  });
});

describe('check-watch monitor: it tells nobody (#2323)', () => {
  const lib = path.join(__dirname, '..', 'lib');

  it('loads nothing of the switchboard and nothing that types into a pane', () => {
    const source = fs.readFileSync(path.join(lib, 'check-watch.js'), 'utf8');
    const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(required, ['./check-watch-state', './check-watch-store', './check-watch-store', './check-watch-store', './github-checks', './logger']);
  });

  it('a resolved and an expired watch leave no message fact, and still owe what they owed', async () => {
    const resolved = watch(1);
    const expired = watch(2);
    answers.set(sha(1), concluded());
    await pass(HOUR + DAY);
    const sent = ['woke', 'wake-undeliverable', 'alarmed', 'alarm-undeliverable'];
    for (const id of [resolved, expired]) assert.equal(history(id).some((kind) => sent.includes(kind)), false, id);
    assert.deepEqual(watches.listOwed('wake').map((w) => w.watchId), [resolved]);
  });

  it('no answer says a watch is monitored for waking', () => {
    const api = fs.readFileSync(path.join(lib, 'check-watch-api.js'), 'utf8');
    assert.match(api, /^const MONITORED = false;$/m);
  });
});
