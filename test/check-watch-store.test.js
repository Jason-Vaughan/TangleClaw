'use strict';

// #2323: the check watch's records. Every write is driven through the real
// store on a temporary database, and each test reads back both the row and the
// history, because a change with no fact (or a fact with no change) is the
// defect these records exist to prevent. Nothing here calls GitHub or the
// switchboard: readings are given in the shape `readCheck` returns.

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
const { CONCLUSIONS } = require('../lib/github-checks');

const { REFUSALS } = state;
const REPO = 'Jason-Vaughan/TangleClaw';
const OWNER = { projectId: 7, launchId: 'launch-owner' };
const OTHER = { projectId: 8, launchId: 'launch-other' };
const START = Date.parse('2026-10-12T05:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const realNow = watches._internal.now;
const realId = watches._internal.id;

let tmpDir = null;
let clock = START;

/**
 * A 40-character commit id made of one hex digit.
 * @param {string} digit - One hex digit
 * @returns {string}
 */
function sha(digit) {
  return digit.repeat(40);
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
 * Register a watch for the owner project, due in an hour.
 * @param {object} [overrides] - Fields to change
 * @returns {object} The store's answer
 */
function register(overrides = {}) {
  return watches.registerWatch({
    projectId: OWNER.projectId, sessionId: 1409, launchId: OWNER.launchId, repo: REPO, prNumber: 2328,
    headSha: sha('a'), checkName: 'test', dueAt: at(HOUR), ...overrides
  });
}

/**
 * Register a watch and return its id, failing the test if it was refused.
 * @param {object} [overrides] - Fields to change
 * @returns {string}
 */
function registered(overrides = {}) {
  const out = register(overrides);
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.watch.watchId;
}

/**
 * A concluded reading.
 * @param {string} [conclusion] - The conclusion
 * @returns {object}
 */
function concluded(conclusion = 'success') {
  return { status: 'concluded', conclusion, runId: '114669381605', completedAt: '2026-10-12T05:13:25.000Z' };
}

const RUNNING = { status: 'running', runId: '1' };
const NOT_FOUND = { status: 'not-found' };
const UNAVAILABLE = { status: 'unavailable', reason: 'gh api timed out after 10000ms' };

/**
 * The kinds of a watch's facts, in order.
 * @param {string} watchId - Watch id
 * @returns {string[]}
 */
function history(watchId) {
  return watches.listFacts(watchId).map((f) => f.kind);
}

/**
 * The number of rows in the two tables, to prove a refused write changed nothing.
 * @returns {{watches: number, facts: number}}
 */
function counts() {
  const n = (table) => store.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { watches: n('check_watches'), facts: n('check_watch_facts') };
}

/**
 * Mark a watch expired directly. Nothing in the product writes this yet; the
 * column is there so the records can say it.
 * @param {string} watchId - Watch id
 * @returns {void}
 */
function expire(watchId) {
  store.getDb().prepare('UPDATE check_watches SET expired_at = ? WHERE watch_id = ?').run(new Date(clock).toISOString(), watchId);
}

/**
 * Assert an answer is a refusal with this code and that nothing was written.
 * @param {Function} write - Makes the write and returns the store's answer
 * @param {string} code - The expected refusal code
 * @returns {object} The refusal
 */
function refused(write, code) {
  const before = counts();
  const rows = JSON.stringify(store.getDb().prepare('SELECT * FROM check_watches ORDER BY watch_id').all());
  const out = write();
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.code, code, JSON.stringify(out));
  assert.ok(out.message && typeof out.message === 'string');
  assert.deepEqual(counts(), before);
  assert.equal(JSON.stringify(store.getDb().prepare('SELECT * FROM check_watches ORDER BY watch_id').all()), rows);
  return out;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-check-watch-'));
  store._setBasePath(tmpDir);
  store.init();
  clock = START;
  watches._internal.now = () => new Date(clock).toISOString();
});

afterEach(() => {
  watches._internal.now = realNow;
  watches._internal.id = realId;
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('check-watch-store: registering a watch (#2323)', () => {
  it('records who asked, what is watched and when it is due, with one registered fact', () => {
    const out = register();
    assert.equal(out.ok, true);
    const w = out.watch;
    assert.match(w.watchId, /^cw_[0-9a-f]{24}$/);
    assert.deepEqual(w, {
      watchId: w.watchId, projectId: 7, registeredBy: { sessionId: 1409, launchId: 'launch-owner' }, repo: REPO, prNumber: 2328,
      headSha: sha('a'), checkName: 'test', dueAt: at(HOUR), registeredAt: at(), result: null, lastRead: null, cancelled: null, expired: null
    });
    assert.deepEqual(watches.getWatch(w.watchId), w);
    const facts = watches.listFacts(w.watchId);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, 'registered');
    assert.equal(facts[0].at, at());
    assert.deepEqual(facts[0].detail, { sessionId: 1409, launchId: 'launch-owner', dueAt: at(HOUR) });
    assert.equal(state.derive(w, at()).state, 'waiting');
  });

  it('a watch may be registered without a session number, and its due time may be a Date or milliseconds', () => {
    assert.equal(watches.getWatch(registered({ sessionId: null })).registeredBy.sessionId, null);
    assert.equal(watches.getWatch(registered({ sessionId: undefined, headSha: sha('b') })).registeredBy.sessionId, null);
    assert.equal(watches.getWatch(registered({ headSha: sha('c'), dueAt: new Date(START + HOUR) })).dueAt, at(HOUR));
    assert.equal(watches.getWatch(registered({ headSha: sha('d'), dueAt: START + HOUR })).dueAt, at(HOUR));
  });

  it('every watch gets an id that was never used before', () => {
    const ids = new Set();
    for (const digit of '0123456789abcdef') ids.add(registered({ headSha: sha(digit) }));
    assert.equal(ids.size, 16);
  });

  it('refuses a watch that could never be read, or that names nobody, and writes nothing', () => {
    const malformed = [
      { projectId: 0 }, { projectId: '7' }, { projectId: undefined },
      { launchId: '' }, { launchId: undefined }, { launchId: 'x'.repeat(129) },
      { sessionId: 0 }, { sessionId: '1409' }, { sessionId: 1.5 },
      { repo: 'TangleClaw' }, { repo: 'a/b/c' }, { repo: undefined },
      { prNumber: 0 }, { prNumber: '2328' }, { prNumber: 1.5 }, { prNumber: undefined },
      { headSha: 'abc1234' }, { headSha: sha('A') }, { headSha: 'main' },
      { checkName: '' }, { checkName: ' test' }, { checkName: 'x'.repeat(state.MAX_CHECK_NAME + 1) }, { checkName: 'te\nst' },
      { dueAt: undefined }, { dueAt: null }, { dueAt: '' }, { dueAt: 'soon' }, { dueAt: {} },
      // Finite, and further than a Date reaches: refused, not thrown on.
      { dueAt: 8.64e15 + 1 }, { dueAt: -8.64e15 - 1 }, { dueAt: Number.MAX_VALUE }, { dueAt: Infinity }, { dueAt: new Date(NaN) }
    ];
    for (const fields of malformed) refused(() => register(fields), REFUSALS.MALFORMED);
    refused(() => watches.registerWatch(), REFUSALS.MALFORMED);
    assert.deepEqual(counts(), { watches: 0, facts: 0 });
  });

  it('a due time must be after now and at most 24 hours ahead', () => {
    for (const dueAt of [at(0), at(-1), at(-HOUR), at(state.MAX_DUE_AHEAD_MS + 1), at(48 * HOUR)]) {
      refused(() => register({ dueAt }), REFUSALS.DUE_OUT_OF_RANGE);
    }
    registered({ dueAt: at(1) });
    registered({ headSha: sha('b'), dueAt: at(state.MAX_DUE_AHEAD_MS) });
  });

  it('refuses a second open watch for the same project, repository, commit and check name, and names the first', () => {
    const first = registered();
    const out = refused(() => register({ dueAt: at(2 * HOUR), sessionId: 1500, launchId: 'launch-later' }), REFUSALS.DUPLICATE);
    assert.equal(out.watchId, first);
    // A repository name compares without case, as GitHub compares it.
    assert.equal(refused(() => register({ repo: REPO.toLowerCase() }), REFUSALS.DUPLICATE).watchId, first);
  });

  it('another commit, another check, another repository or another project is another watch', () => {
    registered();
    registered({ headSha: sha('b') });
    registered({ checkName: 'Test' });
    registered({ repo: 'Jason-Vaughan/Other' });
    registered({ projectId: OTHER.projectId, launchId: OTHER.launchId });
    assert.equal(counts().watches, 5);
  });

  it('a check can be watched again once its first watch has its result', () => {
    const first = registered();
    assert.equal(watches.recordRead(first, concluded('failure')).ok, true);
    const second = registered();
    assert.notEqual(second, first);
    assert.equal(state.derive(watches.getWatch(first), at()).state, 'failed');
    assert.equal(state.derive(watches.getWatch(second), at()).state, 'waiting');
    // And only once: the second is now the open one.
    assert.equal(refused(() => register(), REFUSALS.DUPLICATE).watchId, second);
  });

  it('a cancelled watch does not block a new watch on the same check', () => {
    const first = registered();
    assert.equal(watches.cancelWatch(first, OWNER).ok, true);
    assert.notEqual(registered(), first);
  });

  it('an expired watch does not block a new watch on the same repository, commit and check name', () => {
    const first = registered();
    expire(first);
    const second = registered();
    assert.notEqual(second, first);
    assert.deepEqual(watches.getWatch(first).expired, { at: at() });
    assert.equal(refused(() => register(), REFUSALS.DUPLICATE).watchId, second);
  });

  it('a project may hold 20 open watches and no more; another project has its own 20', () => {
    const ids = [];
    for (let n = 0; n < state.MAX_OPEN_PER_PROJECT; n++) ids.push(registered({ checkName: `check ${n}` }));
    assert.equal(watches.countOpen(OWNER.projectId), 20);
    refused(() => register({ checkName: 'one too many' }), REFUSALS.LIMIT);
    registered({ projectId: OTHER.projectId, launchId: OTHER.launchId, checkName: 'one too many' });
    assert.equal(watches.countOpen(OTHER.projectId), 1);
    assert.equal(ids.length, 20);
  });

  it('a resolved, a cancelled and an expired watch each free a place under the limit', () => {
    const ids = [];
    for (let n = 0; n < state.MAX_OPEN_PER_PROJECT; n++) ids.push(registered({ checkName: `check ${n}` }));
    refused(() => register({ checkName: 'extra 1' }), REFUSALS.LIMIT);

    assert.equal(watches.recordRead(ids[0], concluded()).ok, true);
    assert.equal(watches.countOpen(OWNER.projectId), 19);
    registered({ checkName: 'extra 1' });
    refused(() => register({ checkName: 'extra 2' }), REFUSALS.LIMIT);

    assert.equal(watches.cancelWatch(ids[1], OWNER).ok, true);
    registered({ checkName: 'extra 2' });
    refused(() => register({ checkName: 'extra 3' }), REFUSALS.LIMIT);

    expire(ids[2]);
    assert.equal(watches.countOpen(OWNER.projectId), 19);
    registered({ checkName: 'extra 3' });
    refused(() => register({ checkName: 'extra 4' }), REFUSALS.LIMIT);
    assert.equal(watches.countOpen(OWNER.projectId), 20);
  });
});

describe('check-watch-store: recording a read (#2323)', () => {
  it('a terminal conclusion writes the result once, with a resolved fact, and the watch reads ready', () => {
    const id = registered();
    clock += 2 * MINUTE;
    const out = watches.recordRead(id, concluded());
    assert.equal(out.ok, true);
    assert.equal(out.recorded, 'resolved');
    assert.deepEqual(out.watch.result, { conclusion: 'success', runId: '114669381605', completedAt: '2026-10-12T05:13:25.000Z', readAt: at(2 * MINUTE) });
    assert.deepEqual(out.watch.lastRead, { at: at(2 * MINUTE), outcome: 'ok', detail: null });
    assert.deepEqual(history(id), ['registered', 'resolved']);
    const fact = watches.listFacts(id)[1];
    assert.equal(fact.code, 'success');
    assert.deepEqual(fact.detail, { runId: '114669381605', completedAt: '2026-10-12T05:13:25.000Z' });
    assert.deepEqual(state.derive(out.watch, at(3 * MINUTE)), { state: 'ready', reasons: [] });
  });

  it('every other conclusion is recorded as itself and reads failed', () => {
    for (const [n, conclusion] of CONCLUSIONS.filter((c) => c !== 'success').entries()) {
      const id = registered({ checkName: `check ${n}` });
      const out = watches.recordRead(id, concluded(conclusion));
      assert.equal(out.watch.result.conclusion, conclusion);
      assert.equal(state.derive(out.watch, at()).state, 'failed', conclusion);
    }
  });

  it('the result can be written once and only once: a second conclusion is refused and the first stands', () => {
    const id = registered();
    assert.equal(watches.recordRead(id, concluded('failure')).ok, true);
    for (const reading of [concluded('success'), concluded('failure'), RUNNING, NOT_FOUND, UNAVAILABLE]) {
      refused(() => watches.recordRead(id, reading), REFUSALS.ALREADY_RESOLVED);
    }
    assert.equal(watches.getWatch(id).result.conclusion, 'failure');
    assert.deepEqual(history(id), ['registered', 'resolved']);
  });

  it('a result is recorded only from a terminal conclusion the reader returned', () => {
    const id = registered();
    const notReadings = [
      undefined, null, 'success', {}, { status: 'success' }, { status: 'completed', conclusion: 'success' },
      { status: 'concluded' },
      { status: 'concluded', conclusion: 'passed', runId: '1', completedAt: at() },
      { status: 'concluded', conclusion: 'success', completedAt: at() },
      { status: 'concluded', conclusion: 'success', runId: '', completedAt: at() },
      { status: 'concluded', conclusion: 'success', runId: 1, completedAt: at() },
      { status: 'concluded', conclusion: 'success', runId: '1' },
      { status: 'concluded', conclusion: 'success', runId: '1', completedAt: 'yesterday' },
      { status: 'concluded', conclusion: 'success', runId: '1', completedAt: 9e15 },
      { status: 'concluded', conclusion: null, runId: '1', completedAt: at() }
    ];
    for (const reading of notReadings) refused(() => watches.recordRead(id, reading), REFUSALS.MALFORMED);

    for (const reading of [RUNNING, NOT_FOUND, UNAVAILABLE, { status: 'running', conclusion: 'success' }, { status: 'unavailable', conclusion: 'success', reason: 'x' }]) {
      const out = watches.recordRead(id, reading);
      assert.equal(out.ok, true);
      assert.equal(out.watch.result, null, JSON.stringify(reading));
    }
    assert.ok(!history(id).includes('resolved'));
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM check_watches WHERE result_read_at IS NOT NULL').get().n, 0);
  });

  it('a running or not-found reading records that GitHub was read, and the watch keeps waiting', () => {
    const id = registered();
    for (const [n, reading] of [RUNNING, NOT_FOUND, RUNNING].entries()) {
      clock = START + (n + 1) * MINUTE;
      const out = watches.recordRead(id, reading);
      assert.equal(out.ok, true);
      assert.equal(out.recorded, null);
      assert.deepEqual(out.watch.lastRead, { at: at((n + 1) * MINUTE), outcome: 'ok', detail: null });
      assert.deepEqual(state.derive(out.watch, at((n + 1) * MINUTE)), { state: 'waiting', reasons: [] });
    }
    assert.deepEqual(history(id), ['registered']);
  });

  it('an unreadable GitHub writes no result, reads unknown, and is not mistaken for failed', () => {
    const id = registered();
    const out = watches.recordRead(id, UNAVAILABLE);
    assert.equal(out.recorded, 'read-failed');
    assert.equal(out.watch.result, null);
    assert.deepEqual(out.watch.lastRead, { at: at(), outcome: 'failed', detail: 'gh api timed out after 10000ms' });
    assert.deepEqual(state.derive(out.watch, at()), { state: 'unknown', reasons: ['read-failed'] });
    assert.deepEqual(watches.listFacts(id)[1].detail, { reason: 'gh api timed out after 10000ms' });
  });

  it('the history gains one fact when reads start failing and one when they recover, not one per read', () => {
    const id = registered();
    const steps = [
      [RUNNING, null], [UNAVAILABLE, 'read-failed'], [UNAVAILABLE, null], [{ status: 'unavailable', reason: 'another reason' }, null],
      [NOT_FOUND, 'read-recovered'], [RUNNING, null], [UNAVAILABLE, 'read-failed'], [concluded(), 'resolved']
    ];
    for (const [n, [reading, recorded]] of steps.entries()) {
      clock = START + (n + 1) * MINUTE;
      assert.equal(watches.recordRead(id, reading).recorded, recorded, `step ${n}`);
    }
    assert.deepEqual(history(id), ['registered', 'read-failed', 'read-recovered', 'read-failed', 'resolved']);
    // The row holds the newest read only; a recovered read clears the failure's detail.
    assert.deepEqual(watches.getWatch(id).lastRead, { at: at(8 * MINUTE), outcome: 'ok', detail: null });
  });

  it('a failing read updates the row each time, so the newest reason is the one kept', () => {
    const id = registered();
    watches.recordRead(id, UNAVAILABLE);
    clock += MINUTE;
    const out = watches.recordRead(id, { status: 'unavailable', reason: '  gh is not installed  ' });
    assert.deepEqual(out.watch.lastRead, { at: at(MINUTE), outcome: 'failed', detail: 'gh is not installed' });
  });

  it('a reason too long for the column is cut, and a missing one is said to be missing', () => {
    const id = registered();
    assert.equal(watches.recordRead(id, { status: 'unavailable', reason: 'x'.repeat(5000) }).watch.lastRead.detail.length, 500);
    const other = registered({ headSha: sha('b') });
    assert.equal(watches.recordRead(other, { status: 'unavailable' }).watch.lastRead.detail, 'no reason given');
  });

  it('a cancelled watch and an expired watch are never read again', () => {
    const cancelled = registered();
    assert.equal(watches.cancelWatch(cancelled, OWNER).ok, true);
    for (const reading of [concluded(), RUNNING, UNAVAILABLE]) refused(() => watches.recordRead(cancelled, reading), REFUSALS.CANCELLED);

    const expired = registered({ headSha: sha('b') });
    expire(expired);
    for (const reading of [concluded(), RUNNING, UNAVAILABLE]) refused(() => watches.recordRead(expired, reading), REFUSALS.EXPIRED);
    assert.equal(watches.getWatch(expired).result, null);
    assert.deepEqual(state.derive(watches.getWatch(expired), at(2 * HOUR)), { state: 'unknown', reasons: ['expired', 'past-due'] });
  });

  it('a read for a watch that does not exist is refused', () => {
    refused(() => watches.recordRead('cw_missing', concluded()), REFUSALS.NOT_FOUND);
    refused(() => watches.recordRead(undefined, concluded()), REFUSALS.NOT_FOUND);
  });
});

describe('check-watch-store: recording the wake and the alarm (#2323)', () => {
  const SENT = { exchangeId: 'mx_n-hFW5DL0u9IwcyE', workspaceId: 'tc-lane-a-830caf13' };

  it('a wake is recorded once, under the watch\'s own request id, with its exchange and workspace', () => {
    const id = registered();
    watches.recordRead(id, concluded());
    clock += MINUTE;
    const out = watches.recordSent(id, 'wake', SENT);
    assert.equal(out.ok, true);
    assert.deepEqual(out.fact, {
      factId: out.fact.factId, watchId: id, kind: 'woke', code: null, requestId: `check-watch:wake:${id}`,
      exchangeId: SENT.exchangeId, workspaceId: SENT.workspaceId, detail: null, at: at(MINUTE)
    });
    assert.equal(out.fact.requestId, state.requestIdFor(id, 'wake'));
    assert.deepEqual(history(id), ['registered', 'resolved', 'woke']);
  });

  it('a second record of the same wake is refused and hands back the first, so a retry finds what was sent', () => {
    const id = registered();
    watches.recordRead(id, concluded());
    const first = watches.recordSent(id, 'wake', SENT).fact;
    const again = refused(() => watches.recordSent(id, 'wake', { exchangeId: 'mx_another', workspaceId: 'elsewhere' }), REFUSALS.ALREADY_RECORDED);
    assert.deepEqual(again.fact, first);
    assert.equal(watches.listFacts(id).filter((f) => f.kind === 'woke').length, 1);
  });

  it('a wake is recorded after the store is closed and reopened between the result and the wake, and only once', () => {
    const id = registered();
    watches.recordRead(id, concluded());
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    assert.deepEqual(watches.listOwed('wake').map((w) => w.watchId), [id]);
    assert.equal(state.requestIdFor(watches.listOwed('wake')[0].watchId, 'wake'), `check-watch:wake:${id}`);
    assert.equal(watches.recordSent(id, 'wake', SENT).ok, true);
    assert.deepEqual(watches.listOwed('wake'), []);

    store.close();
    store._setBasePath(tmpDir);
    store.init();
    refused(() => watches.recordSent(id, 'wake', SENT), REFUSALS.ALREADY_RECORDED);
    assert.deepEqual(watches.listOwed('wake'), []);
  });

  it('there is no wake to record before there is a result', () => {
    const id = registered();
    refused(() => watches.recordSent(id, 'wake', SENT), REFUSALS.NOT_RESOLVED);
    refused(() => watches.recordUndeliverable(id, 'wake', { code: 'NO_LIVE_SESSION' }), REFUSALS.NOT_RESOLVED);
    watches.recordRead(id, UNAVAILABLE);
    refused(() => watches.recordSent(id, 'wake', SENT), REFUSALS.NOT_RESOLVED);
  });

  it('an alarm is recorded once, from the due time on, under its own request id', () => {
    const id = registered();
    clock = START + HOUR - 1;
    refused(() => watches.recordSent(id, 'alarm', SENT), REFUSALS.NOT_DUE);
    refused(() => watches.recordUndeliverable(id, 'alarm', { code: 'NO_LIVE_SESSION' }), REFUSALS.NOT_DUE);
    clock = START + HOUR;
    const out = watches.recordSent(id, 'alarm', { ...SENT, code: 'due' });
    assert.equal(out.ok, true);
    assert.equal(out.fact.kind, 'alarmed');
    assert.equal(out.fact.code, 'due');
    assert.equal(out.fact.requestId, `check-watch:alarm:${id}`);
    refused(() => watches.recordSent(id, 'alarm', SENT), REFUSALS.ALREADY_RECORDED);
    assert.deepEqual(history(id), ['registered', 'alarmed']);
  });

  it('a late result after the alarm is still recorded and still owes its wake', () => {
    const id = registered();
    clock = START + HOUR + MINUTE;
    assert.equal(watches.recordSent(id, 'alarm', SENT).ok, true);
    assert.deepEqual(state.derive(watches.getWatch(id), at(HOUR + MINUTE)), { state: 'unknown', reasons: ['past-due'] });
    clock += MINUTE;
    assert.equal(watches.recordRead(id, concluded()).recorded, 'resolved');
    assert.deepEqual(watches.listOwed('wake').map((w) => w.watchId), [id]);
    assert.equal(watches.recordSent(id, 'wake', { exchangeId: 'mx_wake', workspaceId: SENT.workspaceId }).ok, true);
    assert.deepEqual(history(id), ['registered', 'alarmed', 'resolved', 'woke']);
    assert.notEqual(watches.listFacts(id)[1].requestId, watches.listFacts(id)[3].requestId);
    assert.equal(state.derive(watches.getWatch(id), at(3 * HOUR)).state, 'ready');
  });

  it('a message sent just before a cancellation is still recorded as sent', () => {
    const id = registered();
    watches.recordRead(id, concluded());
    assert.equal(watches.cancelWatch(id, OWNER).ok, true);
    assert.equal(watches.recordSent(id, 'wake', SENT).ok, true);
    assert.deepEqual(history(id), ['registered', 'resolved', 'cancelled', 'woke']);
  });

  it('a sent message is recorded only with an exchange, a workspace and a message kind a watch has', () => {
    const id = registered();
    watches.recordRead(id, concluded());
    const malformed = [
      ['wake', undefined], ['wake', {}], ['wake', { exchangeId: SENT.exchangeId }], ['wake', { workspaceId: SENT.workspaceId }],
      ['wake', { ...SENT, exchangeId: '' }], ['wake', { ...SENT, exchangeId: 'mx 1' }], ['wake', { ...SENT, exchangeId: 'x'.repeat(65) }],
      ['wake', { ...SENT, workspaceId: 'has space' }], ['wake', { ...SENT, workspaceId: 7 }],
      ['wake', { ...SENT, code: 'has space' }], ['wake', { ...SENT, code: '' }], ['wake', { ...SENT, code: 7 }],
      ['woke', SENT], ['alarmed', SENT], [undefined, SENT], ['resolved', SENT]
    ];
    for (const [kind, sent] of malformed) refused(() => watches.recordSent(id, kind, sent), REFUSALS.MALFORMED);
    refused(() => watches.recordSent('cw_missing', 'wake', SENT), REFUSALS.NOT_FOUND);
  });

  it('a wake that cannot be delivered is recorded once, stays owed, and is recorded as sent later', () => {
    const id = registered();
    watches.recordRead(id, concluded());
    const out = watches.recordUndeliverable(id, 'wake', { code: 'NO_LIVE_SESSION', workspaceId: SENT.workspaceId, detail: 'project 7 has no live session' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.fact, {
      factId: out.fact.factId, watchId: id, kind: 'wake-undeliverable', code: 'NO_LIVE_SESSION', requestId: null, exchangeId: null,
      workspaceId: SENT.workspaceId, detail: { detail: 'project 7 has no live session' }, at: at()
    });
    refused(() => watches.recordUndeliverable(id, 'wake', { code: 'NO_LIVE_SESSION' }), REFUSALS.ALREADY_RECORDED);
    assert.deepEqual(watches.listOwed('wake').map((w) => w.watchId), [id]);

    clock += HOUR;
    assert.equal(watches.recordSent(id, 'wake', SENT).ok, true);
    assert.deepEqual(history(id), ['registered', 'resolved', 'wake-undeliverable', 'woke']);
    assert.deepEqual(watches.listOwed('wake'), []);
    // Once sent, it cannot be said to be undeliverable.
    refused(() => watches.recordUndeliverable(id, 'wake', { code: 'NO_LIVE_SESSION' }), REFUSALS.ALREADY_RECORDED);
  });

  it('an alarm that cannot be delivered is its own fact, apart from the wake\'s', () => {
    const id = registered();
    clock = START + HOUR;
    const out = watches.recordUndeliverable(id, 'alarm', { code: 'NO_LIVE_SESSION' });
    assert.equal(out.fact.kind, 'alarm-undeliverable');
    assert.equal(out.fact.workspaceId, null);
    assert.equal(out.fact.detail, null);
    refused(() => watches.recordUndeliverable(id, 'alarm', { code: 'NO_LIVE_SESSION' }), REFUSALS.ALREADY_RECORDED);
    assert.deepEqual(watches.listOwed('alarm', at(HOUR)).map((w) => w.watchId), [id]);
    watches.recordRead(id, concluded());
    assert.equal(watches.recordUndeliverable(id, 'wake', { code: 'NO_LIVE_SESSION' }).fact.kind, 'wake-undeliverable');
    assert.deepEqual(history(id), ['registered', 'alarm-undeliverable', 'resolved', 'wake-undeliverable']);
  });

  it('an undeliverable message needs a code, and a cancelled watch owes none', () => {
    const id = registered();
    watches.recordRead(id, concluded());
    for (const why of [undefined, {}, { code: '' }, { code: 'has space' }, { code: 7 }, { code: 'X', workspaceId: 'has space' }, { code: 'X', detail: '' }, { code: 'X', detail: 'x'.repeat(1001) }, { code: 'X', detail: 7 }]) {
      refused(() => watches.recordUndeliverable(id, 'wake', why), REFUSALS.MALFORMED);
    }
    refused(() => watches.recordUndeliverable(id, 'page', { code: 'X' }), REFUSALS.MALFORMED);
    refused(() => watches.recordUndeliverable('cw_missing', 'wake', { code: 'X' }), REFUSALS.NOT_FOUND);
    assert.equal(watches.cancelWatch(id, OWNER).ok, true);
    refused(() => watches.recordUndeliverable(id, 'wake', { code: 'X' }), REFUSALS.CANCELLED);
  });
});

describe('check-watch-store: cancelling (#2323)', () => {
  it('the project a watch belongs to cancels it, once, and the record says who and when', () => {
    const id = registered();
    clock += MINUTE;
    const out = watches.cancelWatch(id, { projectId: OWNER.projectId, launchId: 'launch-after-a-clear' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.watch.cancelled, { at: at(MINUTE), projectId: 7, launchId: 'launch-after-a-clear' });
    assert.deepEqual(history(id), ['registered', 'cancelled']);
    assert.deepEqual(watches.listFacts(id)[1].detail, { projectId: 7, launchId: 'launch-after-a-clear' });
    assert.deepEqual(state.derive(out.watch, at(MINUTE)), { state: 'unknown', reasons: ['cancelled'] });
    refused(() => watches.cancelWatch(id, OWNER), REFUSALS.CANCELLED);
  });

  it('another project cannot cancel it, and nobody cancels without a project and a launch', () => {
    const id = registered();
    refused(() => watches.cancelWatch(id, OTHER), REFUSALS.NOT_OWNER);
    for (const actor of [undefined, {}, { projectId: 7 }, { launchId: 'l' }, { projectId: '7', launchId: 'l' }, { projectId: 7, launchId: '' }]) {
      refused(() => watches.cancelWatch(id, actor), REFUSALS.MALFORMED);
    }
    refused(() => watches.cancelWatch('cw_missing', OWNER), REFUSALS.NOT_FOUND);
    assert.equal(watches.getWatch(id).cancelled, null);
  });

  it('a result recorded before the cancellation stays, and the watch still reads from it', () => {
    const id = registered();
    watches.recordRead(id, concluded('failure'));
    const out = watches.cancelWatch(id, OWNER);
    assert.equal(out.watch.result.conclusion, 'failure');
    assert.equal(state.derive(out.watch, at()).state, 'failed');
  });
});

describe('check-watch-store: the reads the monitor and the API will ask (#2323)', () => {
  it('lists a project\'s watches newest first, all of them or only the open ones', () => {
    const a = registered({ checkName: 'a' });
    clock += MINUTE;
    const b = registered({ checkName: 'b' });
    clock += MINUTE;
    const c = registered({ checkName: 'c' });
    clock += MINUTE;
    const d = registered({ checkName: 'd' });
    registered({ projectId: OTHER.projectId, launchId: OTHER.launchId });
    watches.recordRead(a, concluded());
    watches.cancelWatch(b, OWNER);
    expire(c);
    assert.deepEqual(watches.listWatches(OWNER.projectId).map((w) => w.watchId), [d, c, b, a]);
    assert.deepEqual(watches.listWatches(OWNER.projectId, { openOnly: true }).map((w) => w.watchId), [d]);
    assert.deepEqual(watches.listWatches(99), []);
    assert.equal(watches.getWatch('cw_missing'), null);
  });

  it('the watches still to be read are the open ones, the one read longest ago first and one never read before any', () => {
    const a = registered({ checkName: 'a' });
    const b = registered({ checkName: 'b' });
    const c = registered({ checkName: 'c' });
    const done = registered({ checkName: 'done' });
    const cancelled = registered({ checkName: 'cancelled' });
    const expired = registered({ checkName: 'expired' });
    watches.recordRead(done, concluded());
    watches.cancelWatch(cancelled, OWNER);
    expire(expired);
    assert.deepEqual(watches.listUnresolved().map((w) => w.watchId), [a, b, c]);

    clock += MINUTE;
    watches.recordRead(b, RUNNING);
    clock += MINUTE;
    watches.recordRead(a, UNAVAILABLE);
    assert.deepEqual(watches.listUnresolved().map((w) => w.watchId), [c, b, a]);
    assert.deepEqual(watches.listUnresolved()[1].lastRead, { at: at(MINUTE), outcome: 'ok', detail: null });
  });

  it('a wake is owed by a watch with a result and no woke fact, oldest first; a cancelled watch owes none', () => {
    const a = registered({ checkName: 'a' });
    clock += MINUTE;
    const b = registered({ checkName: 'b' });
    clock += MINUTE;
    const c = registered({ checkName: 'c' });
    const waiting = registered({ checkName: 'waiting' });
    assert.deepEqual(watches.listOwed('wake'), []);
    for (const id of [c, a, b]) watches.recordRead(id, concluded());
    assert.deepEqual(watches.listOwed('wake').map((w) => w.watchId), [a, b, c]);
    watches.recordSent(a, 'wake', { exchangeId: 'mx_a', workspaceId: 'ws' });
    watches.cancelWatch(b, OWNER);
    assert.deepEqual(watches.listOwed('wake').map((w) => w.watchId), [c]);
    assert.equal(watches.getWatch(waiting).result, null);
  });

  it('an alarm is owed from the due time by a watch with no result and no alarmed fact', () => {
    const early = registered({ checkName: 'early', dueAt: at(10 * MINUTE) });
    const late = registered({ checkName: 'late', dueAt: at(HOUR) });
    const resolved = registered({ checkName: 'resolved', dueAt: at(10 * MINUTE) });
    const cancelled = registered({ checkName: 'cancelled', dueAt: at(10 * MINUTE) });
    watches.recordRead(resolved, concluded());
    watches.cancelWatch(cancelled, OWNER);

    assert.deepEqual(watches.listOwed('alarm', at(10 * MINUTE - 1)), []);
    assert.deepEqual(watches.listOwed('alarm', at(10 * MINUTE)).map((w) => w.watchId), [early]);
    assert.deepEqual(watches.listOwed('alarm', new Date(START + 2 * HOUR)).map((w) => w.watchId), [early, late]);

    clock = START + 2 * HOUR;
    assert.deepEqual(watches.listOwed('alarm').map((w) => w.watchId), [early, late]);
    watches.recordSent(early, 'alarm', { exchangeId: 'mx_alarm', workspaceId: 'ws' });
    assert.deepEqual(watches.listOwed('alarm').map((w) => w.watchId), [late]);
    // The alarmed watch is still open and still read: a late result still wakes.
    assert.ok(watches.listUnresolved().map((w) => w.watchId).includes(early));
  });

  it('an expired watch that was never alarmed still shows as owed, marked expired for the caller to judge', () => {
    const id = registered({ dueAt: at(10 * MINUTE) });
    clock = START + HOUR;
    expire(id);
    const owed = watches.listOwed('alarm');
    assert.deepEqual(owed.map((w) => w.watchId), [id]);
    assert.deepEqual(owed[0].expired, { at: at(HOUR) });
    assert.deepEqual(watches.listUnresolved(), []);
  });

  it('refuses to list what is owed for a message a watch does not send, or without a time it can read', () => {
    assert.throws(() => watches.listOwed('page'), /wake or alarm/);
    assert.throws(() => watches.listOwed(), /wake or alarm/);
    assert.throws(() => watches.listOwed('alarm', 'soon'), /needs a time/);
    assert.throws(() => watches.listOwed('alarm', 9e15), /needs a time/);
  });

  it('a watch\'s history comes back oldest first with each fact\'s detail, and an unknown watch has none', () => {
    const id = registered();
    watches.recordRead(id, UNAVAILABLE);
    watches.recordRead(id, concluded());
    const facts = watches.listFacts(id);
    assert.deepEqual(facts.map((f) => f.kind), ['registered', 'read-failed', 'resolved']);
    assert.ok(facts[0].factId < facts[1].factId && facts[1].factId < facts[2].factId);
    for (const f of facts) assert.equal(f.watchId, id);
    assert.deepEqual(watches.listFacts('cw_missing'), []);
  });
});

describe('check-watch-store: what a refused or failed write leaves (#2323)', () => {
  it('a write whose fact the database refuses changes nothing: the row and the history land or fail as one', () => {
    const id = registered();
    watches.recordRead(id, concluded());
    // Put a cancelled fact in behind the store's back, so the store's own insert collides after its row update.
    const db = store.getDb();
    db.prepare(
      "INSERT INTO check_watch_facts (watch_id, kind, request_id, exchange_id, recipient_workspace_id, created_at) VALUES (?, 'cancelled', NULL, NULL, NULL, ?)"
    ).run(id, at());
    const before = JSON.stringify(db.prepare('SELECT * FROM check_watches').all());
    assert.throws(() => watches.cancelWatch(id, OWNER), /UNIQUE/);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM check_watches').all()), before);
    assert.equal(watches.getWatch(id).cancelled, null);
    // The transaction was closed: the next write works.
    assert.equal(registered({ headSha: sha('b') }).startsWith('cw_'), true);
  });

  it('an id the store has already used is refused by the database, not silently reused', () => {
    watches._internal.id = () => 'cw_fixed';
    registered();
    assert.throws(() => register({ headSha: sha('b') }), /UNIQUE|PRIMARY/);
    assert.deepEqual(counts(), { watches: 1, facts: 1 });
  });

  it('every write says the store is not open when it is not', () => {
    store.close();
    assert.throws(() => register(), /not initialized/);
    assert.throws(() => watches.getWatch('cw_1'), /not initialized/);
    store._setBasePath(tmpDir);
    store.init();
  });
});
