'use strict';

// #2323: the check watch monitor. Each test drives the real monitor over the
// real store on a temporary database, with a fake reader in place of GitHub and
// one fake clock for the monitor, the watch store and the exchange store.
//
// Only the switchboard's wire is faked (`lib/medusa.js`'s listener and send
// calls): the tracked send, the exchange rows it writes and the bind are the
// real ones, and an arrival is handled the way `server.js`'s arrival observer
// handles it. Nothing here calls GitHub or opens a socket.

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
const medusa = require('../lib/medusa');
const exchanges = require('../lib/medusa-exchanges');
const { bindProject } = require('./_shared-docs-callers');

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
const realExchangeNow = exchanges._internal.now;

/** The wire calls the stand-in Hub replaces. */
const WIRE = ['sendMessage', 'getStatus', 'getMessages', 'markHandled', 'startSession', 'stopSession'];
const realWire = Object.fromEntries(WIRE.map((name) => [name, medusa[name]]));
const MONITOR_WS = 'check-watch-ws';
const OFF = { state: 'off', listeningSince: null, workspaceId: null, unread: 0, lastError: null, lastErrorCode: null };

/** The stand-in Hub: what it took, what it still holds, and every listener there is. */
let hub = null;
/**
 * Holds the event loop open while a test waits on a Hub that never answers:
 * the monitor's own wait is on a timer that does not, by design.
 * @type {NodeJS.Timeout|null}
 */
let keepAlive = null;

let tmpDir = null;
let clock = START;
/** Every read the monitor asked for, in order: the commit read. */
let reads = [];
/** What the fake reader answers for a commit; anything not named here is still running. */
let answers = new Map();

/**
 * What one pass did, all zero but for what is named.
 * @param {object} [over] - The counts that are not zero
 * @returns {object}
 */
function counts(over = {}) {
  return { open: 0, read: 0, resolved: 0, readFailed: 0, expired: 0, deferred: 0, sent: 0, secondAttempts: 0, undeliverable: 0, closed: 0, errors: 0, ...over };
}

/**
 * Hand a message to its recipient the way `server.js`'s arrival observer does:
 * record the arrival, then let the monitor look at it.
 * @param {{id: string, from: string, to: string, message: string}} copy - The Hub's copy
 * @returns {{bound: boolean, reason: string}} What the monitor did with it
 */
function arrive(copy) {
  const entry = [...hub.listeners].find(([, listener]) => listener.workspaceId === copy.to);
  const sessionKey = entry ? entry[0] : 'nobody';
  const session = /^\d+$/.test(sessionKey) ? store.sessions.get(Number(sessionKey)) : null;
  exchanges.recordArrival({
    hubId: copy.id, recipientWorkspaceId: copy.to, recipientProjectId: session ? session.projectId : null,
    recipientSessionId: session ? sessionKey : null, senderWorkspaceId: copy.from
  });
  return monitor.noteArrival({ sessionKey, workspaceId: copy.to, message: { id: copy.id, from: copy.from, message: copy.message } });
}

/**
 * Put the stand-in Hub in place of the wire. `hub.behave` says what the Hub
 * does with each send:
 * - `deliver`: takes it, and it reaches the recipient before the Hub answers (the ordinary case);
 * - `answer-only`: takes it and answers; the test delivers it, or never does;
 * - `held`: takes it and keeps it for the recipient, and its answer is lost;
 * - `lost`: never takes it, and no answer comes;
 * - `refuse`: declines it;
 * - `hang-held` / `hang`: as `held` / `lost`, but no answer ever comes at all.
 * @returns {void}
 */
function installHub() {
  hub = { sent: [], held: [], listeners: new Map(), inbox: [], handled: [], starts: 0, stops: 0, issued: 0, ownState: 'listening', behave: () => 'deliver' };
  const failure = (hubOutcome) => Object.assign(new Error(`hub ${hubOutcome}`), {
    httpStatus: 502, code: hubOutcome === 'refused' ? 'SEND_REJECTED' : 'BRIDGE_UNREACHABLE', hubOutcome
  });
  Object.assign(medusa, {
    getStatus: (key) => {
      const listener = hub.listeners.get(String(key));
      if (!listener) return { ...OFF };
      return { ...OFF, state: listener.state, workspaceId: listener.workspaceId, listeningSince: listener.state === 'listening' ? listener.since : null };
    },
    startSession: ({ sessionId }) => {
      const key = String(sessionId);
      if (!hub.listeners.has(key)) {
        hub.starts += 1;
        hub.listeners.set(key, { workspaceId: MONITOR_WS, state: hub.ownState, since: new Date(clock).toISOString() });
      }
      return medusa.getStatus(key);
    },
    stopSession: (sessionId) => {
      if (hub.listeners.delete(String(sessionId))) hub.stops += 1;
    },
    getMessages: (key) => (String(key) === monitor.LISTENER_KEY ? hub.inbox.slice() : []),
    markHandled: (_key, ids) => {
      hub.handled.push(...ids);
      hub.inbox = hub.inbox.filter((m) => !ids.includes(m.id));
    },
    sendMessage: async ({ sessionId, to, message, beforeHub }) => {
      const listener = hub.listeners.get(String(sessionId));
      if (!listener) throw Object.assign(new Error('not listening'), { httpStatus: 409, code: 'NOT_LISTENING' });
      const from = listener.workspaceId;
      if (typeof beforeHub === 'function') beforeHub({ from });
      const how = hub.behave({ to, message });
      if (how === 'refuse') throw failure('refused');
      if (how === 'lost') throw failure('unknown');
      if (how === 'hang') return new Promise(() => {});
      const copy = { id: `hub-${++hub.issued}`, from, to, message: message.trim() };
      hub.sent.push(copy);
      if (how === 'held' || how === 'hang-held') {
        hub.held.push(copy);
        if (how === 'held') throw failure('unknown');
        return new Promise(() => {});
      }
      if (how === 'deliver') arrive(copy);
      return { status: 'received', id: copy.id, to };
    }
  });
}

/**
 * A project with one live, launch-bound session whose listener is connected.
 * @param {string} name - Project name
 * @returns {{project: object, sessionId: number, workspaceId: string, launchId: string}}
 */
function live(name) {
  const project = store.projects.create({ name, path: path.join(tmpDir, name) });
  return another(project);
}

/**
 * A further live session of a project, with its own connected listener.
 * @param {object} project - Project record
 * @returns {{project: object, sessionId: number, workspaceId: string, launchId: string}}
 */
function another(project) {
  const bound = bindProject(project);
  const workspaceId = `${project.name}-ws-${bound.sessionId}`;
  hub.listeners.set(String(bound.sessionId), { workspaceId, state: 'listening', since: new Date(clock).toISOString() });
  return { project, sessionId: bound.sessionId, workspaceId, launchId: bound.launchId };
}

/**
 * Register a watch for a live project's session on commit number `n`.
 * @param {object} target - What `live` returned
 * @param {number} n - Which commit
 * @param {object} [overrides] - Fields to change
 * @returns {string} The watch id
 */
function watchFor(target, n, overrides = {}) {
  return watch(n, { projectId: target.project.id, sessionId: target.sessionId, launchId: target.launchId, ...overrides });
}

/**
 * Drop a session's connection, or bring it back. Coming back is when the Hub
 * hands over what it holds for that workspace.
 * @param {object} target - What `live` returned
 * @param {'listening'|'connecting'} next - The listener's state from now
 * @returns {void}
 */
function connection(target, next) {
  const listener = hub.listeners.get(String(target.sessionId));
  listener.state = next;
  if (next !== 'listening') return;
  listener.since = new Date(clock).toISOString();
  const mine = hub.held.filter((copy) => copy.to === listener.workspaceId);
  hub.held = hub.held.filter((copy) => copy.to !== listener.workspaceId);
  for (const copy of mine) arrive(copy);
}

/**
 * The exchange made under one of a watch's request ids, as the store holds it.
 * @param {string} watchId - Watch id
 * @param {'wake'|'alarm'} kind - Which message
 * @param {1|2} [attempt] - Which attempt
 * @returns {object|null}
 */
function exchangeOf(watchId, kind, attempt = 1) {
  return store.medusaExchanges.getByRequestId(`${state.requestIdFor(watchId, kind)}${attempt === 2 ? ':2' : ''}`);
}

/**
 * The kinds of an exchange's facts, in order.
 * @param {object} exchange - Exchange row
 * @returns {string[]}
 */
function receipts(exchange) {
  return store.medusaExchanges.facts(exchange.exchange_id).map((f) => f.fact);
}

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
  exchanges._internal.now = () => new Date(clock);
  monitor._internal.now = () => clock;
  installHub();
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
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
  Object.assign(monitor._internal, real);
  Object.assign(medusa, realWire);
  watches._internal.now = realStoreNow;
  exchanges._internal.now = realExchangeNow;
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

// The watches in the next four groups belong to a project with no session, so
// each message they come to owe is recorded as having nobody to go to, once.
describe('check-watch monitor: reading and recording (#2323)', () => {
  it('a running check that becomes success has its result written once, however many passes follow', async () => {
    const id = watch(1);
    assert.deepEqual(await pass(), counts({ open: 1, read: 1 }));
    assert.equal(state.derive(watches.getWatch(id), clock).state, 'waiting');
    assert.deepEqual(watches.getWatch(id).lastRead, { at: at(), outcome: 'ok', detail: null });

    answers.set(sha(1), concluded());
    const resolving = await pass(MINUTE);
    assert.equal(resolving.resolved, 1);
    const w = watches.getWatch(id);
    assert.deepEqual(w.result, { conclusion: 'success', runId: '114669381605', completedAt: '2026-10-12T05:13:25.000Z', readAt: at(MINUTE) });
    assert.deepEqual(state.derive(w, clock), { state: 'ready', reasons: [] });

    for (let i = 0; i < 5; i++) assert.deepEqual(await pass(MINUTE), counts());
    assert.equal(readsOf(1), 2);
    assert.deepEqual(history(id), ['registered', 'resolved', 'wake-undeliverable']);
    assert.deepEqual(watches.getWatch(id), w);
  });

  it('a failing conclusion is written once and reads failed', async () => {
    const id = watch(1);
    answers.set(sha(1), concluded('failure'));
    await pass();
    await pass(MINUTE);
    assert.equal(watches.getWatch(id).result.conclusion, 'failure');
    assert.deepEqual(state.derive(watches.getWatch(id), clock), { state: 'failed', reasons: [] });
    assert.deepEqual(history(id), ['registered', 'resolved', 'wake-undeliverable']);
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
    assert.deepEqual(history(id), ['registered', 'read-failed', 'read-recovered', 'resolved', 'wake-undeliverable']);
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
    assert.deepEqual(await pass(), counts({ open: 1, read: 1 }));
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
    assert.deepEqual(history(id), ['registered', 'resolved', 'wake-undeliverable']);
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
      assert.deepEqual(await monitor.tick(), { ...counts(), skipped: 'pass-running' });
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
    assert.deepEqual(history(id), ['registered', 'alarm-undeliverable', 'expired']);
    assert.equal(watches.countOpen(7), 0);

    const readsThen = reads.length;
    assert.deepEqual(await pass(MINUTE), counts());
    assert.equal(reads.length, readsThen);
    assert.deepEqual(history(id), ['registered', 'alarm-undeliverable', 'expired']);
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
    assert.deepEqual(history(id), ['registered', 'resolved', 'wake-undeliverable']);
  });

  it('a last read that could not reach GitHub does not hold the expiry back', async () => {
    const id = watch(1);
    answers.set(sha(1), UNAVAILABLE);
    const out = await pass(HOUR + DAY);
    assert.equal(out.readFailed, 1);
    assert.equal(out.expired, 1);
    assert.deepEqual(history(id), ['registered', 'read-failed', 'expired', 'alarm-undeliverable']);
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
    assert.deepEqual(out, counts({ open: 3, read: 3, resolved: 1, readFailed: 2, undeliverable: 1 }));
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
    assert.deepEqual(await pass(), counts({ errors: 1 }));

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

describe('check-watch monitor: the wake (#2323)', () => {
  it('sends exactly one wake for one result, however many passes follow, and its receipt is the exchange\'s own', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    assert.deepEqual(await pass(), counts({ open: 1, read: 1, resolved: 1, sent: 1 }));
    for (let i = 0; i < 5; i++) assert.deepEqual(await pass(MINUTE), counts());

    assert.equal(hub.sent.length, 1);
    const [copy] = hub.sent;
    assert.equal(copy.from, MONITOR_WS);
    assert.equal(copy.to, a.workspaceId);
    const lines = copy.message.split('\n');
    assert.equal(lines.at(-1), `ref: check-watch:wake:${id}`, 'the marker is the last line');
    assert.match(lines[0], new RegExp(`\`test\` on PR #2328 of ${REPO}, commit ${sha(1)} finished: success\\.$`));
    assert.match(copy.message, new RegExp(`tc check show ${id}`));
    assert.match(copy.message, /a reply is not read/);
    assert.ok(!/second attempt/.test(copy.message));

    const sent = exchangeOf(id, 'wake');
    assert.equal(exchanges.systemOwnerOf(sent), monitor.LISTENER_KEY);
    assert.equal(sent.hub_id, copy.id);
    assert.equal(sent.reply_required, 0);
    assert.equal(sent.recipient_project_id, a.project.id);
    assert.equal(exchangeOf(id, 'wake', 2), null);
    const woke = watches.listFacts(id).filter((f) => f.kind === 'woke');
    assert.equal(woke.length, 1);
    assert.deepEqual(
      { code: woke[0].code, requestId: woke[0].requestId, exchangeId: woke[0].exchangeId, workspaceId: woke[0].workspaceId },
      { code: 'accepted', requestId: `check-watch:wake:${id}`, exchangeId: sent.exchange_id, workspaceId: a.workspaceId }
    );
    assert.deepEqual(history(id), ['registered', 'resolved', 'woke']);
  });

  it('the arrival binds the Hub id before the Hub has answered, and the answer then changes nothing', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    let atArrival = null;
    const realNote = monitor.noteArrival;
    hub.behave = () => 'answer-only';
    const sendMessage = medusa.sendMessage;
    medusa.sendMessage = async (input) => {
      const pending = sendMessage(input);
      // The message is with the recipient while the Hub's answer is still on its way back.
      const copy = hub.sent.at(-1);
      const before = exchangeOf(id, 'wake');
      atArrival = { hubIdBefore: before.hub_id, stateBefore: before.state, verdict: arrive(copy), hubIdAfter: exchangeOf(id, 'wake').hub_id };
      return pending;
    };
    await pass();
    assert.equal(monitor.noteArrival, realNote);
    assert.deepEqual(atArrival, { hubIdBefore: null, stateBefore: 'send_pending', verdict: { bound: true, reason: 'marker' }, hubIdAfter: 'hub-1' });
    const sent = exchangeOf(id, 'wake');
    assert.equal(sent.hub_id, 'hub-1');
    assert.equal(receipts(sent).filter((f) => f === 'hub_accepted').length, 1);
    assert.equal(receipts(sent).filter((f) => f === 'arrived').length, 1);
    assert.equal(watches.listFacts(id).filter((f) => f.kind === 'woke').length, 1);
    // Nothing was left for a second attempt, now or after any wait.
    assert.deepEqual(await pass(10 * MINUTE), counts());
    assert.equal(hub.sent.length, 1);
    assert.equal(exchangeOf(id, 'wake', 2), null);
    // The untracked arrival row the observer made first was adopted, not left beside the send.
    assert.equal(store.medusaExchanges.getByHubId('hub-1', 'arrival').terminal_code, 'adopted-by-send');
  });

  it('a failure wakes once and says it did not pass', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded('failure'));
    await pass();
    await pass(MINUTE);
    assert.equal(hub.sent.length, 1);
    assert.match(hub.sent[0].message, /finished: failure\. It did not pass\./);
    assert.deepEqual(history(id), ['registered', 'resolved', 'woke']);
  });

  it('two passes asked for at once, and a second send under the same id, make one intent and one send', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    const both = await Promise.all([monitor.tick(), monitor.tick()]);
    assert.deepEqual(both.map((out) => out.skipped || 'ran').sort(), ['pass-running', 'ran']);
    assert.equal(hub.sent.length, 1);
    // Whatever else tried the same request id, the switchboard itself refuses to send it twice.
    const again = await require('../lib/medusa-send').sendTracked({
      sessionId: monitor.LISTENER_KEY, senderProjectId: null, caller: { kind: 'system' },
      body: { to: a.workspaceId, message: 'again', replyRequired: false, requestId: `check-watch:wake:${id}` }
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'SEND_ALREADY_ATTEMPTED');
    assert.equal(hub.sent.length, 1);
  });

  it('a send the Hub refuses is final: recorded as refused and never sent again', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    hub.behave = () => 'refuse';
    assert.equal((await pass()).sent, 1);
    hub.behave = () => 'deliver';
    for (let i = 0; i < 5; i++) await pass(MINUTE);
    assert.equal(hub.sent.length, 0, 'the Hub never took anything');
    const sent = exchangeOf(id, 'wake');
    assert.equal(sent.state, 'undeliverable');
    assert.equal(sent.terminal_code, 'hub-refused');
    assert.equal(exchangeOf(id, 'wake', 2), null);
    assert.equal(watches.listFacts(id).find((f) => f.kind === 'woke').code, 'refused');
  });

  it('with no session to tell it records that once, spends no request id, and sends when a session is next live', async () => {
    const project = store.projects.create({ name: 'quiet', path: path.join(tmpDir, 'quiet') });
    const id = watch(1, { projectId: project.id });
    answers.set(sha(1), concluded());
    assert.deepEqual(await pass(), counts({ open: 1, read: 1, resolved: 1, undeliverable: 1 }));
    for (let i = 0; i < 3; i++) assert.deepEqual(await pass(MINUTE), counts());
    assert.deepEqual(history(id), ['registered', 'resolved', 'wake-undeliverable']);
    assert.equal(watches.listFacts(id).at(-1).code, 'no-live-session');
    assert.equal(exchangeOf(id, 'wake'), null, 'no request id was spent');
    assert.equal(hub.starts, 0, 'and the monitor never listened for it');

    const a = another(project);
    assert.deepEqual(await pass(MINUTE), counts({ sent: 1 }));
    assert.equal(hub.sent.length, 1);
    assert.equal(hub.sent[0].to, a.workspaceId);
    assert.deepEqual(history(id), ['registered', 'resolved', 'wake-undeliverable', 'woke']);
  });

  it('two live sessions is nobody: which of them a message is for is never guessed', async () => {
    const a = live('alpha');
    another(a.project);
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    await pass();
    await pass(MINUTE);
    assert.equal(hub.sent.length, 0);
    assert.equal(watches.listFacts(id).at(-1).kind, 'wake-undeliverable');
    assert.equal(watches.listFacts(id).at(-1).code, 'several-live-sessions');
  });

  it('a session whose listener is not connected is not sent to: the Hub would refuse it for good', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    connection(a, 'connecting');
    await pass();
    assert.equal(hub.sent.length, 0);
    assert.equal(exchangeOf(id, 'wake'), null);
    assert.equal(watches.listFacts(id).at(-1).code, 'recipient-not-connected');
    connection(a, 'listening');
    await pass(MINUTE);
    await pass(MINUTE);
    assert.equal(hub.sent.length, 1);
  });

  it('a held project is still sent to', async () => {
    const a = live('alpha');
    const control = require('../lib/control-state');
    const operator = { principal: 'operator', operatorProof: 'verified-session' };
    const made = control.create({ projectId: a.project.id, requestId: 'cw-hold-1' }, operator).assignment;
    control.hold({ assignmentId: made.assignmentId, requestId: 'cw-hold-2', reasonCode: 'boundary' }, operator);
    assert.equal(control.blockingOf(store.control.getAssignment(made.assignmentId)).code, 'CONTROL_HELD');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    // A hold stops a lane's own changes, not what it is told.
    assert.equal((await pass()).sent, 1);
    assert.equal(exchangeOf(id, 'wake').hub_id, 'hub-1');
  });

  it('a cancelled watch is sent nothing', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), () => {
      assert.equal(watches.cancelWatch(id, { projectId: a.project.id, launchId: a.launchId }).ok, true);
      return concluded();
    });
    await pass();
    await pass(HOUR + MINUTE);
    assert.equal(hub.sent.length, 0);
    assert.deepEqual(history(id), ['registered', 'cancelled']);
  });

  it('a send that is refused before the Hub is called spends nothing and is tried again', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    const sendMessage = medusa.sendMessage;
    medusa.sendMessage = async () => { throw Object.assign(new Error('not listening'), { httpStatus: 409, code: 'NOT_LISTENING' }); };
    assert.equal((await pass()).sent, 0);
    assert.equal(exchangeOf(id, 'wake'), null);
    assert.deepEqual(history(id), ['registered', 'resolved']);
    medusa.sendMessage = sendMessage;
    assert.equal((await pass(MINUTE)).sent, 1);
    assert.deepEqual(history(id), ['registered', 'resolved', 'woke']);
  });

  it('an exchange somebody else made under the watch\'s request id is refused, never adopted', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    // Made before the monitor owned the prefix, as a row from an older build would be.
    store.medusaExchanges.insert({
      exchange_id: 'mx_foreign', request_id: `check-watch:wake:${id}`, origin: 'send', tracking: 'tracked',
      sender_project_id: a.project.id, sender_session_id: String(a.sessionId), sender_workspace_id: a.workspaceId,
      sender_verified: true, sender_proof: 'launch', recipient_workspace_id: a.workspaceId, recipient_project_id: a.project.id,
      recipient_session_id: String(a.sessionId), priority: 'normal', reply_required: false, created_at: at(), state: 'send_pending'
    });
    answers.set(sha(1), concluded());
    await pass();
    await pass(10 * MINUTE);
    assert.equal(hub.sent.length, 0);
    assert.deepEqual(history(id), ['registered', 'resolved'], 'no woke fact rests on somebody else\'s exchange');
    assert.deepEqual(monitor.exchangesOf(id, 'wake'), { first: null, second: null });
    // Nor does a message carrying that id bind to it, though it comes from that exchange's own sender.
    const forged = { id: 'hub-forged', from: a.workspaceId, to: a.workspaceId, message: `ref: check-watch:wake:${id}` };
    assert.deepEqual(arrive(forged), { bound: false, reason: 'no-such-send' });
    assert.equal(exchangeOf(id, 'wake').hub_id, null);
  });
});

describe('check-watch monitor: binding an arrival by its marker (#2323)', () => {
  /**
   * A watch whose wake the Hub took and never answered for, so its exchange is uncertain and unbound.
   * @param {object} target - What `live` returned
   * @param {number} n - Which commit
   * @returns {Promise<string>} The watch id
   */
  async function uncertain(target, n) {
    const id = watchFor(target, n);
    answers.set(sha(n), concluded());
    hub.behave = () => 'held';
    await pass();
    hub.behave = () => 'deliver';
    assert.equal(exchangeOf(id, 'wake').state, 'send_unknown');
    assert.equal(exchangeOf(id, 'wake').hub_id, null);
    return id;
  }

  it('two watches to one recipient with overlapping uncertain sends each bind their own exchange, in either order', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const a = live(`alpha${order[0]}`);
      const ids = [await uncertain(a, 10 + order[0]), await uncertain(a, 20 + order[0])];
      const copies = hub.held.splice(0);
      assert.equal(copies.length, 2);
      for (const i of order) assert.deepEqual(arrive(copies[i]), { bound: true, reason: 'marker' });
      for (const i of [0, 1]) {
        assert.equal(exchangeOf(ids[i], 'wake').hub_id, copies[i].id, `watch ${i}, order ${order}`);
        assert.match(copies[i].message, new RegExp(`ref: check-watch:wake:${ids[i]}$`));
      }
    }
  });

  it('binds nothing for a message with no marker, a malformed one, one naming no send, or one for another recipient', async () => {
    const a = live('alpha');
    const b = live('beta');
    const id = await uncertain(a, 1);
    const [copy] = hub.held.splice(0);
    const sent = exchangeOf(id, 'wake');
    const tries = [
      ['no-marker', { ...copy, id: 'x-1', message: 'the check finished' }],
      ['no-marker', { ...copy, id: 'x-2', message: `${copy.message}\nthanks` }],
      ['no-marker', { ...copy, id: 'x-3', message: `ref: check-watch:wake:${id}:3` }],
      ['no-marker', { ...copy, id: 'x-4', message: `ref: check-watch:nudge:${id}` }],
      ['no-marker', { ...copy, id: 'x-5', message: `ref:check-watch:wake:${id}` }],
      ['no-such-send', { ...copy, id: 'x-6', message: 'ref: check-watch:wake:cw_nobody' }],
      ['no-such-send', { ...copy, id: 'x-7', message: `ref: check-watch:wake:${id}:2` }],
      ['other-recipient', { ...copy, id: 'x-8', to: b.workspaceId }]
    ];
    for (const [reason, message] of tries) {
      assert.deepEqual(arrive(message), { bound: false, reason }, message.id);
      assert.equal(exchangeOf(id, 'wake').hub_id, null, message.id);
    }
    assert.deepEqual(receipts(exchangeOf(id, 'wake')), receipts(sent));
    // The real one still binds afterwards.
    assert.deepEqual(arrive(copy), { bound: true, reason: 'marker' });
  });

  it('a marker copied by another sender binds nothing', async () => {
    const a = live('alpha');
    const b = live('beta');
    const id = await uncertain(a, 1);
    const [copy] = hub.held.splice(0);
    assert.deepEqual(arrive({ ...copy, id: 'forged-1', from: b.workspaceId }), { bound: false, reason: 'other-sender' });
    assert.deepEqual(arrive({ ...copy, id: 'forged-2', from: undefined }), { bound: false, reason: 'other-sender' });
    assert.equal(exchangeOf(id, 'wake').hub_id, null);
  });

  it('a second message carrying a marker already bound, and one for a send that was refused, bind nothing', async () => {
    const a = live('alpha');
    const id = await uncertain(a, 1);
    const [copy] = hub.held.splice(0);
    assert.equal(arrive(copy).bound, true);
    assert.deepEqual(arrive(copy), { bound: false, reason: 'already-bound' });
    assert.deepEqual(arrive({ ...copy, id: 'hub-other' }), { bound: false, reason: 'bound-to-another-message' });
    assert.equal(exchangeOf(id, 'wake').hub_id, copy.id);

    const refused = watchFor(a, 2);
    answers.set(sha(2), concluded());
    hub.behave = () => 'refuse';
    await pass(MINUTE);
    const stray = { id: 'hub-stray', from: MONITOR_WS, to: a.workspaceId, message: `ref: check-watch:wake:${refused}` };
    assert.deepEqual(arrive(stray), { bound: false, reason: 'send-ended' });
    assert.equal(exchangeOf(refused, 'wake').hub_id, null);
  });

  it('never throws, whatever it is handed, and leaves the monitor\'s own mail alone', () => {
    for (const input of [undefined, {}, { message: null }, { sessionKey: '1', workspaceId: 'w', message: { id: 7 } }, { message: { id: 'a', message: 42 } }]) {
      assert.equal(monitor.noteArrival(input).bound, false);
    }
    assert.deepEqual(
      monitor.noteArrival({ sessionKey: monitor.LISTENER_KEY, workspaceId: MONITOR_WS, message: { id: 'r-1', from: 'x', message: 'ref: check-watch:wake:cw_1' } }),
      { bound: false, reason: 'own-inbox' }
    );
    monitor._internal.exchangeRows = () => { throw new Error('database is locked'); };
    assert.deepEqual(
      monitor.noteArrival({ sessionKey: '1', workspaceId: 'w', message: { id: 'a', from: 'b', message: 'ref: check-watch:wake:cw_1' } }),
      { bound: false, reason: 'error' }
    );
  });
});

describe('check-watch monitor: the one second attempt (#2323)', () => {
  /**
   * Resolve a watch for a live project while the Hub behaves a given way.
   * @param {string} how - What the Hub does with the first send
   * @returns {Promise<{a: object, id: string}>}
   */
  async function firstSend(how) {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    hub.behave = () => how;
    if (how.startsWith('hang')) {
      monitor._internal.sendWaitMs = 5;
      keepAlive = setInterval(() => {}, 1000);
    }
    await pass();
    hub.behave = () => 'deliver';
    return { a, id };
  }

  it('an unknown outcome the Hub did take: the marked arrival binds it and nothing is sent again', async () => {
    const { a, id } = await firstSend('held');
    assert.equal(watches.listFacts(id).find((f) => f.kind === 'woke').code, 'uncertain');
    await pass(MINUTE);
    connection(a, 'connecting');
    connection(a, 'listening');
    assert.equal(exchangeOf(id, 'wake').hub_id, 'hub-1');
    for (let i = 0; i < 5; i++) assert.deepEqual(await pass(MINUTE), counts());
    assert.equal(hub.sent.length, 1);
    assert.equal(exchangeOf(id, 'wake', 2), null);
  });

  it('an unknown outcome the Hub did not take: one second attempt after two unbroken connected minutes, and never a third', async () => {
    const { a, id } = await firstSend('lost');
    assert.equal(hub.sent.length, 0);
    assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS - 1)).secondAttempts, 0);
    assert.equal(exchangeOf(id, 'wake', 2), null);
    assert.deepEqual(await pass(1), counts({ secondAttempts: 1 }));

    assert.equal(hub.sent.length, 1);
    const [copy] = hub.sent;
    assert.equal(copy.to, a.workspaceId);
    assert.equal(copy.message.split('\n').at(-1), `ref: check-watch:wake:${id}:2`);
    assert.match(copy.message, /second attempt for the same watch and result/);
    assert.match(copy.message, new RegExp(`commit ${sha(1)} finished: success`), 'the same result');
    const second = exchangeOf(id, 'wake', 2);
    assert.equal(second.hub_id, copy.id);
    assert.equal(exchanges.systemOwnerOf(second), monitor.LISTENER_KEY);
    assert.equal(exchangeOf(id, 'wake').hub_id, null, 'the first stays unproven');

    for (let i = 0; i < 10; i++) assert.deepEqual(await pass(MINUTE), counts());
    assert.equal(hub.sent.length, 1);
    assert.equal(watches.listFacts(id).filter((f) => f.kind === 'woke').length, 1);
  });

  it('a listener connected long before the send still waits two minutes from when the outcome was lost', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    await pass(10 * MINUTE);
    answers.set(sha(1), concluded());
    hub.behave = () => 'lost';
    await pass(MINUTE);
    hub.behave = () => 'deliver';
    assert.equal(exchangeOf(id, 'wake').state, 'send_unknown');
    assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS - 1)).secondAttempts, 0);
    assert.equal((await pass(1)).secondAttempts, 1);
  });

  it('a listener that drops at ninety seconds starts the two minutes again', async () => {
    const { a, id } = await firstSend('lost');
    await pass(90 * SECOND);
    connection(a, 'connecting');
    await pass(SECOND);
    connection(a, 'listening');
    // Two minutes after the send's outcome was lost, but only seconds since the listener came back.
    assert.equal((await pass(40 * SECOND)).secondAttempts, 0);
    assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS - 41 * SECOND)).secondAttempts, 0);
    assert.equal((await pass(SECOND)).secondAttempts, 1);
    assert.equal(exchangeOf(id, 'wake', 2).hub_id, 'hub-1');
  });

  it('a recipient that is not connected for the two minutes is not sent to again, however long it takes', async () => {
    const { a, id } = await firstSend('lost');
    connection(a, 'connecting');
    for (let i = 0; i < 6; i++) assert.equal((await pass(MINUTE)).secondAttempts, 0);
    assert.equal(exchangeOf(id, 'wake', 2), null);
    connection(a, 'listening');
    assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS - 1)).secondAttempts, 0);
    assert.equal((await pass(1)).secondAttempts, 1);
  });

  it('a recipient whose session is gone gets no second attempt, and the monitor stops listening for it', async () => {
    const { a, id } = await firstSend('lost');
    hub.listeners.delete(String(a.sessionId));
    await pass(10 * MINUTE);
    assert.equal(exchangeOf(id, 'wake', 2), null);
    assert.equal(hub.listeners.has(monitor.LISTENER_KEY), false);
  });

  it('the crash window with the Hub holding the message: it arrives after the restart, is bound, and nothing is sent again', async () => {
    const { a, id } = await firstSend('hang-held');
    // The server stopped with the intent written and no answer: nothing but the store carries over.
    assert.equal(exchangeOf(id, 'wake').state, 'send_pending');
    monitor.stop();
    connection(a, 'connecting');
    clock += 5 * MINUTE;
    connection(a, 'listening');
    assert.equal(exchangeOf(id, 'wake').hub_id, 'hub-1', 'bound by its marker before the monitor has made a pass or has a listener');
    for (let i = 0; i < 5; i++) assert.equal((await pass(MINUTE)).secondAttempts, 0);
    assert.equal(hub.sent.length, 1);
    assert.equal(exchangeOf(id, 'wake', 2), null);
    assert.deepEqual(history(id), ['registered', 'resolved', 'woke']);
  });

  it('the crash window with nothing on the Hub: exactly one second attempt after the restart', async () => {
    const { a, id } = await firstSend('hang');
    monitor.stop();
    connection(a, 'connecting');
    clock += 5 * MINUTE;
    connection(a, 'listening');
    assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS - 1)).secondAttempts, 0);
    assert.equal((await pass(MINUTE)).secondAttempts, 1);
    for (let i = 0; i < 5; i++) assert.equal((await pass(MINUTE)).secondAttempts, 0);
    assert.equal(hub.sent.length, 1);
    assert.equal(hub.sent[0].message.split('\n').at(-1), `ref: check-watch:wake:${id}:2`);
  });

  it('the message arrived and the server stopped before the bind, and the Hub does not deliver it again: one second attempt, a duplicate', async () => {
    const { a, id } = await firstSend('hang-held');
    const [copy] = hub.held.splice(0);
    // What the stopped server had got as far as: the arrival recorded, the bind not made.
    exchanges.recordArrival({
      hubId: copy.id, recipientWorkspaceId: a.workspaceId, recipientProjectId: a.project.id,
      recipientSessionId: String(a.sessionId), senderWorkspaceId: MONITOR_WS
    });
    exchanges.recordRead([copy.id], a.workspaceId, { kind: 'project', projectId: a.project.id });
    monitor.stop();
    assert.equal(exchangeOf(id, 'wake').hub_id, null);
    assert.deepEqual(receipts(store.medusaExchanges.getByHubId(copy.id, 'arrival')), ['arrived', 'read']);

    assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS - 1)).secondAttempts, 0);
    assert.equal((await pass(1)).secondAttempts, 1);
    for (let i = 0; i < 5; i++) assert.equal((await pass(MINUTE)).secondAttempts, 0);
    assert.equal(hub.sent.length, 2, 'the project has the message twice');
    assert.equal(exchangeOf(id, 'wake').hub_id, null, 'and the first is never falsely receipted');
    assert.equal(exchangeOf(id, 'wake', 2).hub_id, 'hub-2');
  });

  it('both attempts unproven: nothing more is ever sent', async () => {
    const { id } = await firstSend('lost');
    hub.behave = () => 'lost';
    assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS)).secondAttempts, 1);
    hub.behave = () => 'deliver';
    for (let i = 0; i < 10; i++) assert.deepEqual(await pass(MINUTE), counts());
    assert.equal(hub.sent.length, 0);
    assert.equal(exchangeOf(id, 'wake').state, 'send_unknown');
    assert.equal(exchangeOf(id, 'wake', 2).state, 'send_unknown');
  });

  it('a pass does not wait for ever on a Hub that never answers, and the reads go on', async () => {
    const { id } = await firstSend('hang');
    assert.equal(exchangeOf(id, 'wake').state, 'send_pending');
    watch(2);
    assert.equal((await pass(MINUTE)).read, 1);
  });

  it('a cancelled watch gets no second attempt', async () => {
    const { a, id } = await firstSend('lost');
    assert.equal(watches.cancelWatch(id, { projectId: a.project.id, launchId: a.launchId }).ok, true);
    assert.equal((await pass(10 * MINUTE)).secondAttempts, 0);
    assert.equal(exchangeOf(id, 'wake', 2), null);
  });
});

describe('check-watch monitor: the alarm (#2323)', () => {
  it('past due with no result alarms once and reads unknown, and a later result still wakes', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    assert.equal((await pass(HOUR - 1)).sent, 0);
    // The due time comes inside the read guard, so this pass sends the alarm without reading again.
    assert.deepEqual(await pass(1), counts({ open: 1, sent: 1 }));
    for (let i = 0; i < 3; i++) assert.equal((await pass(MINUTE)).sent, 0);
    assert.equal(hub.sent.length, 1);
    const alarm = hub.sent[0].message;
    assert.equal(alarm.split('\n').at(-1), `ref: check-watch:alarm:${id}`);
    assert.match(alarm, new RegExp(`had no result at its due time, ${at(HOUR).replace(/\./g, '\\.')}\\.`));
    assert.match(alarm, /reads unknown: the check is not known to have passed or failed/);
    assert.match(alarm, new RegExp(`still read until ${at(HOUR + DAY).replace(/\./g, '\\.')}`));
    assert.ok(!/This alarm is late/.test(alarm), 'sent on the pass after its due time, it is not called late');
    assert.deepEqual(state.derive(watches.getWatch(id), clock), { state: 'unknown', reasons: ['past-due'] });
    assert.deepEqual(history(id), ['registered', 'alarmed']);

    answers.set(sha(1), concluded());
    assert.equal((await pass(MINUTE)).sent, 1);
    assert.equal(hub.sent[1].message.split('\n').at(-1), `ref: check-watch:wake:${id}`);
    assert.deepEqual(history(id), ['registered', 'alarmed', 'resolved', 'woke']);
  });

  it('a result recorded before anybody could be told of the due time is woken for, and not alarmed', async () => {
    const project = store.projects.create({ name: 'quiet', path: path.join(tmpDir, 'quiet') });
    const id = watch(1, { projectId: project.id });
    await pass(HOUR);
    answers.set(sha(1), concluded());
    await pass(MINUTE);
    another(project);
    await pass(MINUTE);
    await pass(MINUTE);
    assert.deepEqual(hub.sent.map((copy) => copy.message.split('\n').at(-1)), [`ref: check-watch:wake:${id}`]);
    assert.deepEqual(history(id), ['registered', 'alarm-undeliverable', 'resolved', 'wake-undeliverable', 'woke']);
  });

  it('an expired watch never alarmed gets its one alarm when a session is next live, naming the due time and the expiry and saying it is late', async () => {
    const project = store.projects.create({ name: 'quiet', path: path.join(tmpDir, 'quiet') });
    const id = watch(1, { projectId: project.id });
    await pass(HOUR + DAY);
    assert.deepEqual(history(id), ['registered', 'expired', 'alarm-undeliverable']);
    const expiredAt = watches.getWatch(id).expired.at;

    clock += 3 * DAY;
    another(project);
    assert.equal((await pass()).sent, 1);
    const alarm = hub.sent[0].message;
    assert.match(alarm, new RegExp(`had no result at its due time, ${at(HOUR).replace(/\./g, '\\.')}\\.`));
    assert.match(alarm, new RegExp(`This alarm is late\\. It was due at ${at(HOUR).replace(/\./g, '\\.')} and is sent at ${new Date(clock).toISOString().replace(/\./g, '\\.')}`));
    assert.match(alarm, new RegExp(`expired at ${expiredAt.replace(/\./g, '\\.')} with no result and is not read again`));
    assert.ok(!/still read until/.test(alarm));
    for (let i = 0; i < 3; i++) assert.equal((await pass(MINUTE)).sent, 0);
    assert.equal(hub.sent.length, 1);
    assert.deepEqual(history(id), ['registered', 'expired', 'alarm-undeliverable', 'alarmed']);
  });

  it('an alarm whose outcome was never learned gets the same one second attempt', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    hub.behave = () => 'lost';
    await pass(HOUR);
    hub.behave = () => 'deliver';
    assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS)).secondAttempts, 1);
    assert.equal(hub.sent[0].message.split('\n').at(-1), `ref: check-watch:alarm:${id}:2`);
    assert.match(hub.sent[0].message, /second attempt for the same watch and result/);
    for (let i = 0; i < 5; i++) assert.equal((await pass(MINUTE)).secondAttempts, 0);
  });

  it('a second attempt of an alarm that was on time is not called late, and one that was late says when it was first sent', async () => {
    const a = live('alpha');
    watchFor(a, 1);
    hub.behave = () => 'lost';
    await pass(HOUR);
    hub.behave = () => 'deliver';
    assert.equal((await pass(10 * MINUTE)).secondAttempts, 1);
    assert.match(hub.sent[0].message, /second attempt for the same watch and result/);
    assert.ok(!/This alarm is late/.test(hub.sent[0].message), 'ten minutes after a first send that was on time');

    const project = store.projects.create({ name: 'quiet', path: path.join(tmpDir, 'quiet') });
    const late = watch(2, { projectId: project.id });
    await pass(2 * HOUR);
    another(project);
    hub.behave = () => 'lost';
    await pass(MINUTE);
    const firstSent = exchangeOf(late, 'alarm').created_at;
    hub.behave = () => 'deliver';
    assert.equal((await pass(10 * MINUTE)).secondAttempts, 1);
    const again = hub.sent.at(-1).message;
    assert.equal(again.split('\n').at(-1), `ref: check-watch:alarm:${late}:2`);
    assert.ok(again.includes(`was first sent at ${firstSent}: until then it could not be sent`), again);
    assert.ok(!/is sent at/.test(again));
  });

  it('an alarm whose watch has its result by then gets no second attempt: the wake says what the check did', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    hub.behave = () => 'lost';
    await pass(HOUR);
    hub.behave = () => 'deliver';
    answers.set(sha(1), concluded());
    assert.deepEqual(await pass(MINUTE), counts({ open: 1, read: 1, resolved: 1, sent: 1 }));
    for (let i = 0; i < 5; i++) assert.equal((await pass(MINUTE)).secondAttempts, 0);
    assert.deepEqual(hub.sent.map((copy) => copy.message.split('\n').at(-1)), [`ref: check-watch:wake:${id}`]);
    assert.equal(exchangeOf(id, 'alarm', 2), null);
  });
});

describe('check-watch monitor: its own listener, only while it has somebody to tell (#2323)', () => {
  it('with no watch it never listens', async () => {
    live('alpha');
    for (let i = 0; i < 3; i++) await pass(MINUTE);
    assert.equal(hub.starts, 0);
    assert.equal(hub.listeners.has(monitor.LISTENER_KEY), false);
  });

  it('a watch opened while it is stopped starts it, and it stops when nothing is left to send', async () => {
    const a = live('alpha');
    await pass();
    assert.equal(hub.listeners.has(monitor.LISTENER_KEY), false);
    watchFor(a, 1);
    await pass(MINUTE);
    assert.equal(hub.starts, 1);
    assert.equal(medusa.getStatus(monitor.LISTENER_KEY).workspaceId, MONITOR_WS);
    answers.set(sha(1), concluded());
    assert.equal((await pass(MINUTE)).sent, 1);
    await pass(MINUTE);
    assert.equal(hub.listeners.has(monitor.LISTENER_KEY), false, 'the wake is sent and no watch is open');
    assert.equal(hub.stops, 1);
  });

  it('a watch of a project with no session to tell does not start it', async () => {
    const project = store.projects.create({ name: 'quiet', path: path.join(tmpDir, 'quiet') });
    watch(1, { projectId: project.id });
    answers.set(sha(1), concluded());
    for (let i = 0; i < 3; i++) await pass(MINUTE);
    assert.equal(hub.starts, 0);
  });

  it('on the real listener map: none without a watch, one with, none again after', async () => {
    Object.assign(medusa, realWire);
    const sockets = [];
    /** A socket that opens nothing. */
    class QuietSocket {
      /** Remember the socket so the test can close it. */
      constructor() { this.readyState = 0; sockets.push(this); }
      /** @returns {void} */
      addEventListener() {}
      /** @returns {void} */
      send() {}
      /** @returns {void} */
      close() { this.readyState = 3; }
    }
    const wired = (options) => realWire.startSession({ ...options, wsFactory: () => new QuietSocket() });
    monitor._internal.medusa = () => ({ ...medusa, startSession: wired });
    const before = medusa.activeListenerCount();
    const project = store.projects.create({ name: 'alpha', path: path.join(tmpDir, 'alpha') });
    fs.mkdirSync(project.path, { recursive: true });
    const bound = bindProject(project);
    try {
      await pass();
      assert.equal(medusa.activeListenerCount(), before, 'no watch, no listener');
      wired({ projectPath: project.path, sessionId: bound.sessionId, name: project.name });
      const withSession = medusa.activeListenerCount();
      assert.equal(withSession, before + 1);
      const id = watch(1, { projectId: project.id });
      await pass(MINUTE);
      // The session's own listener is still connecting here, so there is nobody to tell yet.
      assert.equal(medusa.activeListenerCount(), withSession);
      assert.equal(watches.cancelWatch(id, { projectId: project.id, launchId: 'launch-owner' }).ok, true);
      await pass(MINUTE);
      assert.equal(medusa.activeListenerCount(), withSession);
      monitor.stop();
      assert.equal(medusa.getStatus(monitor.LISTENER_KEY).state, 'off');
    } finally {
      medusa.stopSession(bound.sessionId);
      medusa.stopSession(monitor.LISTENER_KEY);
    }
    assert.equal(medusa.activeListenerCount(), before);
    assert.ok(sockets.every((socket) => socket.readyState === 3), 'every socket it opened is closed');
  });

  it('its own listener not connected: nothing is sent and no request id is spent until it is', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    hub.ownState = 'connecting';
    answers.set(sha(1), concluded());
    await pass();
    await pass(MINUTE);
    assert.equal(hub.sent.length, 0);
    assert.equal(exchangeOf(id, 'wake'), null);
    hub.listeners.get(monitor.LISTENER_KEY).state = 'listening';
    assert.equal((await pass(MINUTE)).sent, 1);
  });

  it('drops whatever arrives for it: nothing it sends asks for a reply', async () => {
    const a = live('alpha');
    watchFor(a, 1);
    await pass();
    hub.inbox.push({ id: 'reply-1', from: a.workspaceId, message: 'thanks' }, { id: 'reply-2', from: a.workspaceId, message: 'ref: check-watch:wake:cw_x' });
    await pass(MINUTE);
    assert.deepEqual(hub.handled, ['reply-1', 'reply-2']);
    assert.equal(hub.sent.length, 0);
  });

  it('stop() stops the listener, and a stop that throws is not let out', async () => {
    const a = live('alpha');
    watchFor(a, 1);
    await pass();
    assert.equal(hub.listeners.has(monitor.LISTENER_KEY), true);
    monitor.stop();
    assert.equal(hub.listeners.has(monitor.LISTENER_KEY), false);
    monitor._internal.medusa = () => ({ stopSession: () => { throw new Error('gone'); } });
    monitor.stop();
  });
});

describe('check-watch monitor: closing what nobody acknowledged (#2323)', () => {
  it('closes a delivered, unacknowledged message 24 hours after it was sent, and a read and an acknowledgement made later still show', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    await pass();
    assert.equal((await pass(monitor.CLOSE_AFTER_MS - 1)).closed, 0);
    assert.equal(exchangeOf(id, 'wake').terminal_at, null);
    assert.deepEqual(await pass(1), counts({ closed: 1 }));
    const closed = exchangeOf(id, 'wake');
    assert.equal(closed.terminal_code, 'system-owner-closed');
    assert.deepEqual(receipts(closed), ['send_pending', 'hub_accepted', 'arrived', 'closed']);

    const reader = { kind: 'project', projectId: a.project.id };
    clock += HOUR;
    assert.equal(exchanges.recordRead([closed.hub_id], a.workspaceId, reader), 1);
    assert.equal(exchanges.recordAcknowledged([closed.hub_id], a.workspaceId, reader), 1);
    assert.deepEqual(receipts(exchangeOf(id, 'wake')), ['send_pending', 'hub_accepted', 'arrived', 'closed', 'read', 'acknowledged']);
    assert.equal((await pass(MINUTE)).closed, 0);
  });

  it('an acknowledged message closes itself and is not touched; a send that never got a Hub id is left open', async () => {
    const a = live('alpha');
    const acked = watchFor(a, 1);
    answers.set(sha(1), concluded());
    await pass();
    exchanges.recordAcknowledged([exchangeOf(acked, 'wake').hub_id], a.workspaceId, { kind: 'project', projectId: a.project.id });
    assert.equal(exchangeOf(acked, 'wake').terminal_code, 'acknowledged');

    const unproven = watchFor(a, 2);
    answers.set(sha(2), concluded());
    hub.behave = () => 'lost';
    await pass(MINUTE);
    await pass(monitor.SECOND_ATTEMPT_AFTER_MS);
    assert.equal((await pass(2 * DAY)).closed, 0);
    assert.equal(exchangeOf(unproven, 'wake').terminal_at, null);
    assert.equal(exchangeOf(unproven, 'wake', 2).terminal_at, null);
  });
});

describe('check-watch monitor: it never throws, and what it does not do (#2323)', () => {
  const lib = path.join(__dirname, '..', 'lib');

  it('a switchboard or a store that throws while sending is a counted error; the reads were still recorded and the next pass sends', async () => {
    const a = live('alpha');
    const id = watchFor(a, 1);
    answers.set(sha(1), concluded());
    monitor._internal.exchanges = () => { throw new Error('database is locked'); };
    assert.deepEqual(await pass(), counts({ open: 1, read: 1, resolved: 1, errors: 1 }));
    assert.equal(watches.getWatch(id).result.conclusion, 'success');
    monitor._internal.exchanges = real.exchanges;
    monitor._internal.sendTracked = async () => { throw new Error('socket hang up'); };
    assert.deepEqual(await pass(MINUTE), counts());
    monitor._internal.sendTracked = () => { throw new Error('thrown before any promise'); };
    assert.deepEqual(await pass(MINUTE), counts());
    monitor._internal.sendTracked = real.sendTracked;
    assert.deepEqual(await pass(MINUTE), counts({ sent: 1 }));
  });

  it('a clock that throws ends the pass in a counted error, not a throw', async () => {
    watch(1);
    monitor._internal.now = () => { throw new Error('no clock'); };
    assert.deepEqual(await monitor.tick(), counts({ errors: 1 }));
  });

  it('loads nothing that types into a pane, ends a session or changes GitHub', () => {
    const source = fs.readFileSync(path.join(lib, 'check-watch.js'), 'utf8');
    const required = [...new Set([...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(required, [
      './check-watch-state', './check-watch-store', './github-checks', './logger',
      './medusa', './medusa-exchanges', './medusa-send', './store', 'node:path'
    ]);
    // Of GitHub it uses the reader of a commit's check and nothing else.
    assert.deepEqual([...source.matchAll(/require\('\.\/github-checks'\)\.(\w+)/g)].map((m) => m[1]), ['readCheck']);
    // Of the store's sessions it lists the active ones; it starts, ends and writes none.
    assert.deepEqual([...source.matchAll(/\.sessions\.(\w+)/g)].map((m) => m[1]), ['list']);
    assert.ok(!/tmux|sendKeys|inject|execFile|spawn/.test(source));
  });

  it('every answer says a watch is monitored for waking', () => {
    assert.equal(require('../lib/check-watch-api').MONITORED, true);
  });
});
