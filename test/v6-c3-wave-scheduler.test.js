'use strict';

/*
 * v6 (#1886, V6-22 / C3, Car V61-W1-B): the Autonomous Wave Scheduler and
 * DAG engine (`lib/v6/c3-wave-scheduler.js`). Medium tier: the SQLite store
 * cases open an in-memory `node:sqlite` database.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  CAR_STATUSES, GATE_TYPES, DEFAULT_MAX_STALL_MS, DEFAULT_FLEET_BUILDER_LANES, WaveSchedulerError,
  MemorySchedulerStore, SqliteSchedulerStore, WaveScheduler, ensureSchema,
  isValidId, lockKey, normalizeScope, scopesConflict, scopeWithin, topologicalWaves,
  planParallelWaveShards, validateParallelWavePlan
} = require('../lib/v6/c3-wave-scheduler');

/**
 * A scheduler on a fresh store with a controllable clock and a captured event log.
 * @param {object} [opts]
 * @returns {{scheduler: WaveScheduler, events: object[], tick: (ms: number) => void, store: object}}
 */
function setup(opts = {}) {
  let time = 1000;
  const events = [];
  const store = opts.store || new MemorySchedulerStore();
  const scheduler = new WaveScheduler({
    store,
    now: () => time,
    idFactory: () => 'run-fixed',
    eventSink: (e) => events.push(e),
    remediationHooks: opts.hooks || []
  });
  return { scheduler, events, store, tick: (ms) => { time += ms; } };
}

/**
 * Assert `fn` throws a WaveSchedulerError with `code`.
 * @param {Function} fn
 * @param {string} code
 */
function throwsCode(fn, code) {
  assert.throws(fn, (err) => err instanceof WaveSchedulerError && err.code === code, code);
}

const DIAMOND = [
  { id: 'a', fileScope: ['lib/a.js'] },
  { id: 'b', dependsOn: ['a'], fileScope: ['lib/b.js'] },
  { id: 'c', dependsOn: ['a'], fileScope: ['lib/c.js'] },
  { id: 'd', dependsOn: ['b', 'c'], fileScope: ['lib/d.js'] }
];

describe('module constants', () => {
  it('names every car status, both gates, and a 15-minute stall default', () => {
    assert.deepEqual([...CAR_STATUSES], ['pending', 'running', 'awaiting-gate', 'gate-held', 'complete', 'stalled', 'cancelled']);
    assert.deepEqual([...GATE_TYPES], ['R-Gate', 'A-Gate']);
    assert.equal(DEFAULT_MAX_STALL_MS, 15 * 60 * 1000);
  });
});

describe('topologicalWaves', () => {
  it('orders a diamond into three deterministic waves', () => {
    assert.deepEqual(topologicalWaves(DIAMOND), [['a'], ['b', 'c'], ['d']]);
    assert.deepEqual(topologicalWaves(DIAMOND.slice().reverse()), [['a'], ['b', 'c'], ['d']]);
  });

  it('refuses an empty list, a missing id, a duplicate, a bad dependsOn, an unknown dependency, and a cycle', () => {
    throwsCode(() => topologicalWaves([]), 'CARS_REQUIRED');
    throwsCode(() => topologicalWaves([{}]), 'CAR_ID_INVALID');
    throwsCode(() => topologicalWaves([{ id: 'a' }, { id: 'a' }]), 'CAR_DUPLICATE');
    throwsCode(() => topologicalWaves([{ id: 'a', dependsOn: 'b' }]), 'DEPENDENCY_INVALID');
    throwsCode(() => topologicalWaves([{ id: 'a', dependsOn: ['ghost'] }]), 'DEPENDENCY_UNKNOWN');
    throwsCode(() => topologicalWaves([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), 'DEPENDENCY_CYCLE');
    throwsCode(() => topologicalWaves([{ id: 'a', dependsOn: ['a'] }]), 'DEPENDENCY_CYCLE');
  });

  it('names the cars left in a cycle', () => {
    try {
      topologicalWaves([{ id: 'x' }, { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]);
      assert.fail('expected a cycle');
    } catch (err) {
      assert.deepEqual(err.detail, { cars: ['a', 'b'] });
      assert.equal(err.status, 409);
    }
  });
});

describe('file scopes', () => {
  it('normalizes ./ prefixes, repeated and trailing slashes', () => {
    assert.equal(normalizeScope('./lib//a.js'), 'lib/a.js');
    assert.equal(normalizeScope('lib/v6/'), 'lib/v6');
    assert.equal(normalizeScope('lib/v6/**'), 'lib/v6/**');
  });

  it('refuses absolute, backslash, traversal, inner wildcards and scope-less wildcards', () => {
    for (const bad of ['', '/etc/passwd', 'lib\\a.js', 'lib/../secret', 'lib/*.js', 'lib/**/a.js', 'lib/a?.js', '**', './', 42]) {
      throwsCode(() => normalizeScope(bad), 'FILE_SCOPE_INVALID');
    }
  });

  it('conflicts on exact paths and subtrees, never on a sibling sharing a name prefix', () => {
    assert.equal(scopesConflict('lib/a.js', 'lib/a.js'), true);
    assert.equal(scopesConflict('lib/**', 'lib/v6/a.js'), true);
    assert.equal(scopesConflict('lib/v6/a.js', 'lib/**'), true);
    assert.equal(scopesConflict('lib/v6/**', 'lib/v6'), true);
    assert.equal(scopesConflict('lib/v6/**', 'lib/v6x/a.js'), false);
    assert.equal(scopesConflict('lib/a.js', 'lib/b.js'), false);
  });

  it('scopeWithin accepts only a scope the outer one already covers', () => {
    assert.equal(scopeWithin('lib/v6/a.js', 'lib/v6/**'), true);
    assert.equal(scopeWithin('lib/v6/x/**', 'lib/v6/**'), true);
    assert.equal(scopeWithin('lib/a.js', 'lib/a.js'), true);
    assert.equal(scopeWithin('lib/**', 'lib/v6/**'), false);
    assert.equal(scopeWithin('lib/b.js', 'lib/a.js'), false);
  });
});

describe('createRun', () => {
  it('stores a pending run with sorted, deduplicated scopes', () => {
    const { scheduler } = setup();
    const run = scheduler.createRun({ fleetId: 'tc-lane', cars: [{ id: 'a', fileScope: ['lib/z.js', 'lib/a.js', './lib/a.js'] }] });
    assert.equal(run.id, 'run-fixed');
    assert.equal(run.status, 'active');
    assert.deepEqual(run.cars.a.fileScope, ['lib/a.js', 'lib/z.js']);
    assert.equal(run.cars.a.status, 'pending');
    assert.equal(run.cars.a.maxStallMs, DEFAULT_MAX_STALL_MS);
    assert.deepEqual(scheduler.getRun('run-fixed').waves, [['a']]);
  });

  it('refuses a missing fleet, a missing or empty scope, a bad gate, a bad stall, and a duplicate run', () => {
    const { scheduler } = setup();
    throwsCode(() => scheduler.createRun({ cars: DIAMOND }), 'FLEET_ID_REQUIRED');
    throwsCode(() => scheduler.createRun({ fleetId: 'f', cars: [{ id: 'a' }] }), 'FILE_SCOPE_REQUIRED');
    throwsCode(() => scheduler.createRun({ fleetId: 'f', cars: [{ id: 'a', fileScope: [] }] }), 'FILE_SCOPE_REQUIRED');
    throwsCode(() => scheduler.createRun({ fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'], gate: { type: 'Z-Gate' } }] }), 'GATE_INVALID');
    throwsCode(() => scheduler.createRun({ fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'], maxStallMs: -1 }] }), 'STALL_INVALID');
    scheduler.createRun({ id: 'r1', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'] }] });
    throwsCode(() => scheduler.createRun({ id: 'r1', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'] }] }), 'RUN_EXISTS');
    throwsCode(() => scheduler.getRun('ghost'), 'RUN_NOT_FOUND');
  });
});

describe('dispatchReady — dependencies and file locks', () => {
  it('dispatches wave by wave as dependencies complete', () => {
    const { scheduler } = setup();
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: DIAMOND });
    const seen = [];
    assert.deepEqual(scheduler.dispatchReady('r', (car) => seen.push(car.id)).dispatched, ['a']);
    assert.deepEqual(scheduler.dispatchReady('r').dispatched, [], 'nothing new while a is running');
    scheduler.completeCar('r', 'a');
    assert.deepEqual(scheduler.dispatchReady('r', (car) => seen.push(car.id)).dispatched, ['b', 'c']);
    scheduler.completeCar('r', 'b');
    assert.deepEqual(scheduler.dispatchReady('r').dispatched, [], 'd waits for c too');
    scheduler.completeCar('r', 'c');
    assert.deepEqual(scheduler.dispatchReady('r', (car) => seen.push(car.id)).dispatched, ['d']);
    scheduler.completeCar('r', 'd');
    assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
    assert.equal(scheduler.reconcileRun('r').status, 'complete');
  });

  it('holds back a car whose scope overlaps a running car, in the same run or another', () => {
    const { scheduler, events } = setup();
    scheduler.createRun({ id: 'r1', fleetId: 'f', cars: [{ id: 'a', fileScope: ['lib/**'] }, { id: 'b', fileScope: ['lib/v6/x.js'] }] });
    const first = scheduler.dispatchReady('r1');
    assert.deepEqual(first.dispatched, ['a']);
    assert.deepEqual(first.conflicts.map((c) => [c.carId, c.heldBy]), [['b', { runId: 'r1', carId: 'a' }]]);
    scheduler.createRun({ id: 'r2', fleetId: 'g', cars: [{ id: 'z', fileScope: ['lib/v6/y.js'] }] });
    assert.deepEqual(scheduler.dispatchReady('r2').conflicts.map((c) => c.heldBy), [{ runId: 'r1', carId: 'a' }]);
    scheduler.completeCar('r1', 'a');
    assert.deepEqual(scheduler.dispatchReady('r1').dispatched, ['b']);
    assert.ok(events.some((e) => e.type === 'file-scope-conflict' && e.carId === 'z'));
  });

  it('runs dispatch only after the reservation commits, and a throwing dispatch releases it', () => {
    const { scheduler, store, events } = setup();
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['lib/a.js'] }] });
    let lockedDuringDispatch = null;
    const result = scheduler.dispatchReady('r', () => {
      lockedDuringDispatch = Boolean(store.read().locks[lockKey('r', 'a')]);
      throw new Error('pane refused');
    });
    assert.equal(lockedDuringDispatch, true, 'the lock is committed before the side effect runs');
    assert.deepEqual(result.dispatched, []);
    assert.deepEqual(result.failed, [{ carId: 'a', error: 'pane refused' }]);
    assert.equal(store.read().locks[lockKey('r', 'a')], undefined);
    assert.equal(scheduler.getRun('r').cars.a.status, 'pending');
    assert.ok(events.some((e) => e.type === 'dispatch-failed'));
    assert.deepEqual(scheduler.dispatchReady('r').dispatched, ['a'], 'it can be retried');
  });

  it('refuses an unknown run', () => {
    const { scheduler } = setup();
    throwsCode(() => scheduler.dispatchReady('ghost'), 'RUN_NOT_FOUND');
  });
});

describe('gates', () => {
  /** A run with one gated car, already dispatched and completed. */
  function gated() {
    const ctx = setup();
    ctx.scheduler.createRun({ id: 'r', fleetId: 'f', cars: [
      { id: 'a', fileScope: ['lib/a.js'], gate: { type: 'R-Gate', reviewerRole: 'prr' }, payload: { author: 'tc-lane-b' } },
      { id: 'b', dependsOn: ['a'], fileScope: ['lib/b.js'] }
    ] });
    ctx.scheduler.dispatchReady('r');
    ctx.scheduler.completeCar('r', 'a', { pr: 1 });
    return ctx;
  }

  it('hands a gated car to review and blocks its dependents until PASS', () => {
    const { scheduler, events } = gated();
    assert.equal(scheduler.getRun('r').cars.a.status, 'awaiting-gate');
    assert.ok(events.some((e) => e.type === 'gate-handoff' && e.reviewerRole === 'prr' && e.receipt.pr === 1));
    assert.deepEqual(scheduler.dispatchReady('r').dispatched, []);
    scheduler.recordGate('r', 'a', { verdict: 'PASS', reviewer: 'tc-lane-prr-b', reference: 'A1' });
    assert.equal(scheduler.getRun('r').cars.a.status, 'complete');
    assert.deepEqual(scheduler.dispatchReady('r').dispatched, ['b']);
  });

  it('HOLD parks the car and blocks the run', () => {
    const { scheduler } = gated();
    scheduler.recordGate('r', 'a', { verdict: 'HOLD', reviewer: 'tc-lane-prr-b' });
    assert.equal(scheduler.getRun('r').cars.a.status, 'gate-held');
    assert.equal(scheduler.reconcileRun('r').status, 'blocked');
  });

  it('refuses a bad verdict, a missing reviewer, the author reviewing itself, and a car not awaiting review', () => {
    const { scheduler } = gated();
    throwsCode(() => scheduler.recordGate('r', 'a', { verdict: 'MAYBE', reviewer: 'x' }), 'GATE_VERDICT_INVALID');
    throwsCode(() => scheduler.recordGate('r', 'a', { verdict: 'PASS' }), 'REVIEWER_REQUIRED');
    throwsCode(() => scheduler.recordGate('r', 'a', { verdict: 'PASS', reviewer: 'tc-lane-b' }), 'SELF_REVIEW');
    throwsCode(() => scheduler.recordGate('r', 'b', { verdict: 'PASS', reviewer: 'x' }), 'GATE_NOT_PENDING');
    throwsCode(() => scheduler.recordGate('r', 'ghost', { verdict: 'PASS', reviewer: 'x' }), 'CAR_NOT_FOUND');
  });
});

describe('heartbeat, completion and cancellation', () => {
  it('heartbeat and completion require a running car', () => {
    const { scheduler } = setup();
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'] }] });
    throwsCode(() => scheduler.heartbeat('r', 'a'), 'CAR_NOT_RUNNING');
    throwsCode(() => scheduler.completeCar('r', 'a'), 'CAR_NOT_RUNNING');
    throwsCode(() => scheduler.heartbeat('r', 'ghost'), 'CAR_NOT_FOUND');
    scheduler.dispatchReady('r');
    assert.deepEqual(scheduler.heartbeat('r', 'a', { pct: 50 }).progress, { pct: 50 });
  });

  it('cancelling releases the lock, blocks the run, and refuses a terminal car', () => {
    const { scheduler, store } = setup();
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'] }, { id: 'b', dependsOn: ['a'], fileScope: ['y'] }] });
    scheduler.dispatchReady('r');
    assert.equal(scheduler.cancelCar('r', 'a', 'operator stop').cancelReason, 'operator stop');
    assert.equal(store.read().locks[lockKey('r', 'a')], undefined);
    assert.equal(scheduler.reconcileRun('r').status, 'blocked', 'b can never run');
    throwsCode(() => scheduler.cancelCar('r', 'a'), 'CAR_TERMINAL');
    throwsCode(() => scheduler.cancelCar('r', 'ghost'), 'CAR_NOT_FOUND');
  });

  it('a completed car cannot be cancelled', () => {
    const { scheduler } = setup();
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'] }] });
    scheduler.dispatchReady('r');
    scheduler.completeCar('r', 'a');
    throwsCode(() => scheduler.cancelCar('r', 'a'), 'CAR_TERMINAL');
  });
});

describe('scanStalls', () => {
  /** A run with one dispatched car whose stall threshold is 1000 ms. */
  function running(hooks) {
    const ctx = setup({ hooks });
    ctx.scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['lib/v6/**'], maxStallMs: 1000 }] });
    ctx.scheduler.dispatchReady('r');
    return ctx;
  }

  it('ignores a car within its threshold', () => {
    const { scheduler, tick } = running();
    tick(1000);
    assert.deepEqual(scheduler.scanStalls(), []);
  });

  it('escalates to stalled and releases the lock when no hook decides', () => {
    const { scheduler, store, tick, events } = running();
    tick(1001);
    const out = scheduler.scanStalls();
    assert.equal(out[0].decision.action, 'escalate');
    assert.equal(scheduler.getRun('r').cars.a.status, 'stalled');
    assert.equal(store.read().locks[lockKey('r', 'a')], undefined);
    assert.equal(scheduler.reconcileRun('r').status, 'blocked');
    assert.ok(events.some((e) => e.type === 'stall-remediated'));
  });

  it('redispatch returns the car to pending with its lock released', () => {
    const { scheduler, store, tick } = running([() => ({ action: 'redispatch' })]);
    tick(5000);
    scheduler.scanStalls();
    assert.equal(scheduler.getRun('r').cars.a.status, 'pending');
    assert.equal(store.read().locks[lockKey('r', 'a')], undefined);
    assert.deepEqual(scheduler.dispatchReady('r').dispatched, ['a']);
    assert.equal(scheduler.getRun('r').cars.a.attempts, 2);
  });

  it('narrow shrinks the scope and the held lock together', () => {
    const { scheduler, store, tick } = running([() => ({ action: 'narrow', fileScope: ['lib/v6/c3-wave-scheduler.js'] })]);
    tick(5000);
    scheduler.scanStalls();
    const car = scheduler.getRun('r').cars.a;
    assert.equal(car.status, 'running');
    assert.deepEqual(car.fileScope, ['lib/v6/c3-wave-scheduler.js']);
    assert.deepEqual(store.read().locks[lockKey('r', 'a')].scopes, ['lib/v6/c3-wave-scheduler.js']);
  });

  it('a narrow decision that would widen, empty, or corrupt the scope is escalated instead', () => {
    for (const fileScope of [['lib/**'], [], ['../etc'], undefined]) {
      const { scheduler, tick } = running([() => ({ action: 'narrow', fileScope })]);
      tick(5000);
      const [event] = scheduler.scanStalls();
      assert.equal(event.decision.action, 'escalate', JSON.stringify(fileScope));
      assert.equal(scheduler.getRun('r').cars.a.status, 'stalled');
      assert.deepEqual(scheduler.getRun('r').cars.a.fileScope, ['lib/v6/**']);
    }
  });

  it('uses the first hook that returns a decision', () => {
    const calls = [];
    const { scheduler, tick } = running([
      (ctx) => { calls.push(['first', ctx.stalledForMs]); return null; },
      () => { calls.push(['second']); return { action: 'redispatch' }; },
      () => { calls.push(['third']); return { action: 'escalate' }; }
    ]);
    tick(2000);
    scheduler.scanStalls();
    assert.deepEqual(calls, [['first', 2000], ['second']]);
  });
});

describe('SqliteSchedulerStore', () => {
  it('ensureSchema is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);
    ensureSchema(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(tables, ['v6_wave_file_locks', 'v6_wave_runs']);
  });

  it('drives a full diamond run and persists it across store instances', () => {
    const db = new DatabaseSync(':memory:');
    const { scheduler } = setup({ store: new SqliteSchedulerStore(db) });
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: DIAMOND });
    scheduler.dispatchReady('r');
    const reopened = new SqliteSchedulerStore(db).read();
    assert.equal(reopened.runs.r.cars.a.status, 'running');
    assert.deepEqual(reopened.locks[lockKey('r', 'a')].scopes, ['lib/a.js']);
    scheduler.completeCar('r', 'a');
    assert.equal(new SqliteSchedulerStore(db).read().locks[lockKey('r', 'a')], undefined);
    scheduler.dispatchReady('r');
    scheduler.completeCar('r', 'b');
    scheduler.completeCar('r', 'c');
    scheduler.dispatchReady('r');
    scheduler.completeCar('r', 'd');
    assert.equal(scheduler.reconcileRun('r').status, 'complete');
  });

  it('#3163: read() backfills createdAt from the created_at column when state_json omits it', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteSchedulerStore(db);
    const { scheduler } = setup({ store });
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'] }] });
    // Simulate a run whose state_json never carried createdAt (the v6.5.2
    // bug) -- the created_at SQLite column itself is NOT NULL and always
    // has a real value, independent of what state_json says.
    const row = db.prepare('SELECT state_json, created_at FROM v6_wave_runs WHERE id = ?').get('r');
    const stripped = JSON.parse(row.state_json);
    delete stripped.createdAt;
    db.prepare('UPDATE v6_wave_runs SET state_json = ? WHERE id = ?').run(JSON.stringify(stripped), 'r');
    const reopened = new SqliteSchedulerStore(db).read();
    assert.equal(reopened.runs.r.createdAt, row.created_at);
  });

  it('#3163: read() never overwrites a createdAt state_json already carries', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteSchedulerStore(db);
    const { scheduler } = setup({ store });
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'] }] });
    const before = store.read().runs.r.createdAt;
    assert.equal(typeof before, 'number');
    assert.equal(new SqliteSchedulerStore(db).read().runs.r.createdAt, before);
  });

  it('rolls back every write when the transaction throws', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteSchedulerStore(db);
    const { scheduler } = setup({ store });
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'] }] });
    assert.throws(() => store.transaction((state) => {
      state.locks[lockKey('r', 'a')] = { runId: 'r', carId: 'a', scopes: ['x'] };
      state.runs.r.cars.a.status = 'running';
      throw new Error('boom');
    }), /boom/);
    assert.equal(store.read().locks[lockKey('r', 'a')], undefined);
    assert.equal(store.read().runs.r.cars.a.status, 'pending');
    assert.equal(db.isTransaction, false);
  });

  it('a second run sees the first run\'s locks through the database', () => {
    const db = new DatabaseSync(':memory:');
    const a = setup({ store: new SqliteSchedulerStore(db) }).scheduler;
    const b = new WaveScheduler({ store: new SqliteSchedulerStore(db), idFactory: () => 'r2' });
    a.createRun({ id: 'r1', fleetId: 'f', cars: [{ id: 'x', fileScope: ['lib/**'] }] });
    a.dispatchReady('r1');
    b.createRun({ fleetId: 'g', cars: [{ id: 'y', fileScope: ['lib/z.js'] }] });
    assert.deepEqual(b.dispatchReady('r2').conflicts.map((c) => c.heldBy), [{ runId: 'r1', carId: 'x' }]);
  });
});

describe('PRR-B R1 HOLD regressions (PR #3025)', () => {
  it('an internal "." segment canonicalizes away, so lib/./same.js conflicts with lib/same.js', () => {
    assert.equal(normalizeScope('lib/./same.js'), 'lib/same.js');
    assert.equal(normalizeScope('lib/./v6/./**'), 'lib/v6/**');
    assert.equal(normalizeScope('./lib/././a.js/.'), 'lib/a.js');
    assert.equal(scopesConflict('lib/./same.js', 'lib/same.js'), true);
    throwsCode(() => normalizeScope('./.'), 'FILE_SCOPE_INVALID');
    const { scheduler } = setup();
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['lib/same.js'] }, { id: 'b', fileScope: ['lib/./same.js'] }] });
    const out = scheduler.dispatchReady('r');
    assert.deepEqual(out.dispatched, ['a']);
    assert.deepEqual(out.conflicts.map((c) => c.carId), ['b'], 'the alias spelling is held back');
  });

  it('run "a:b" + car "c" and run "a" + car "b:c" can never share a lock key', () => {
    assert.notEqual(lockKey('a:b', 'c'), lockKey('a', 'b:c'));
    const { scheduler } = setup();
    throwsCode(() => scheduler.createRun({ id: 'a:b', fleetId: 'f', cars: [{ id: 'c', fileScope: ['x.js'] }] }), 'RUN_ID_INVALID');
    throwsCode(() => scheduler.createRun({ id: 'a', fleetId: 'f', cars: [{ id: 'b:c', fileScope: ['y.js'] }] }), 'CAR_ID_INVALID');
  });

  it('two live locks in different runs stay two locks, and releasing one keeps the other', () => {
    const { scheduler, store } = setup();
    scheduler.createRun({ id: 'a.b', fleetId: 'f', cars: [{ id: 'c', fileScope: ['x.js'] }] });
    scheduler.createRun({ id: 'a', fleetId: 'f', cars: [{ id: 'b.c', fileScope: ['y.js'] }] });
    scheduler.dispatchReady('a.b');
    scheduler.dispatchReady('a');
    assert.equal(Object.keys(store.read().locks).length, 2);
    scheduler.completeCar('a', 'b.c');
    assert.deepEqual(Object.values(store.read().locks).map((l) => [l.runId, l.carId]), [['a.b', 'c']]);
  });

  it('a car or run named after a built-in property is refused instead of vanishing', () => {
    const { scheduler } = setup();
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      throwsCode(() => scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id, fileScope: ['x.js'] }] }), 'CAR_ID_INVALID');
      throwsCode(() => scheduler.createRun({ id, fleetId: 'f', cars: [{ id: 'a', fileScope: ['x.js'] }] }), 'RUN_ID_INVALID');
    }
  });

  it('lookups by a built-in property name find nothing rather than an inherited function', () => {
    const { scheduler } = setup();
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x.js'] }] });
    throwsCode(() => scheduler.getRun('constructor'), 'RUN_NOT_FOUND');
    throwsCode(() => scheduler.heartbeat('r', 'constructor'), 'CAR_NOT_FOUND');
    throwsCode(() => scheduler.cancelCar('toString', 'a'), 'CAR_NOT_FOUND');
    throwsCode(() => scheduler.dispatchReady('hasOwnProperty'), 'RUN_NOT_FOUND');
  });

  it('isValidId accepts ordinary ids and refuses delimiters, paths, empties and built-ins', () => {
    for (const ok of ['a', 'run-fixed', 'Car_1.2', 'x'.repeat(128)]) assert.equal(isValidId(ok), true, ok);
    for (const bad of ['', 'a:b', 'a/b', '-lead', ' a', 'x'.repeat(129), '__proto__', 'constructor', 42, null]) {
      assert.equal(isValidId(bad), false, String(bad));
    }
  });
});

// #3213, #3216 Pillar 1 — the Mechanical Maximum Fleet Parallelization
// Guard: a mechanical sharding planner, and the drift check that holds any
// hand-built Car graph to the same standard.
describe('DEFAULT_FLEET_BUILDER_LANES', () => {
  it('names the 4 Builder lanes', () => {
    assert.deepEqual([...DEFAULT_FLEET_BUILDER_LANES], ['TC-Lane-A', 'TC-Lane-B', 'TC-Lane-C', 'TC-Lane-D']);
  });
});

describe('planParallelWaveShards', () => {
  it('validates its inputs', () => {
    throwsCode(() => planParallelWaveShards({ issues: [] }), 'ISSUES_REQUIRED');
    throwsCode(() => planParallelWaveShards({}), 'ISSUES_REQUIRED');
    throwsCode(() => planParallelWaveShards({ issues: [{ id: 'a', fileScope: ['x.js'] }], builderLanes: [] }), 'BUILDER_LANES_REQUIRED');
    throwsCode(() => planParallelWaveShards({ issues: [{ id: 'a', fileScope: ['x.js'] }], builderLanes: ['TC-Lane-A', 'TC-Lane-A'] }), 'BUILDER_LANES_DUPLICATE');
    // #3213 R-Gate R3 BLOCKING 1 — a single malformed entry.
    for (const malformed of [[''], [null], [{}]]) {
      throwsCode(() => planParallelWaveShards({ issues: [{ id: 'a', fileScope: ['x.js'] }], builderLanes: malformed }), 'BUILDER_LANES_INVALID');
    }
    throwsCode(() => planParallelWaveShards({ issues: [{ fileScope: ['x.js'] }] }), 'ISSUE_ID_REQUIRED');
    throwsCode(() => planParallelWaveShards({ issues: [{ id: 'a', fileScope: [] }] }), 'ISSUE_FILE_SCOPE_REQUIRED');
    throwsCode(() => planParallelWaveShards({ issues: [{ id: 'a' }] }), 'ISSUE_FILE_SCOPE_REQUIRED');
  });

  it('shards 4 file-disjoint issues into one 4-car parallel Wave 1, one lane each, no dependsOn', () => {
    const plan = planParallelWaveShards({
      issues: [
        { id: 1, fileScope: ['lib/a.js'] },
        { id: 2, fileScope: ['lib/b.js'] },
        { id: 3, fileScope: ['lib/c.js'] },
        { id: 4, fileScope: ['lib/d.js'] }
      ]
    });
    assert.equal(plan.waves.length, 1);
    assert.equal(plan.waves[0].length, 4);
    assert.equal(plan.maxParallelLanes, 4);
    assert.deepEqual(plan.waveParallelLanes, [4]);
    assert.deepEqual(plan.cars.map((c) => c.lane), ['TC-Lane-A', 'TC-Lane-B', 'TC-Lane-C', 'TC-Lane-D']);
    assert.ok(plan.cars.every((c) => c.dependsOn.length === 0), 'nothing in Wave 1 depends on anything');
    assert.deepEqual(plan.cars.map((c) => c.payload.issueId), [1, 2, 3, 4]);
  });

  it('a file-overlapping issue is placed into Wave 2, dependsOn the exact Wave 1 car it conflicts with', () => {
    const plan = planParallelWaveShards({
      issues: [
        { id: 1, fileScope: ['lib/shared.js'] },
        { id: 2, fileScope: ['lib/other.js'] },
        { id: 3, fileScope: ['lib/shared.js'] } // conflicts with issue 1 only
      ]
    });
    assert.equal(plan.waves.length, 2);
    assert.deepEqual(plan.waveParallelLanes, [2, 1]);
    const car1 = plan.cars.find((c) => c.payload.issueId === 1);
    const car3 = plan.cars.find((c) => c.payload.issueId === 3);
    assert.deepEqual(car3.dependsOn, [car1.id]);
    assert.ok(plan.cars.find((c) => c.payload.issueId === 2).dependsOn.length === 0);
  });

  it('capacity overflow: 6 file-disjoint issues over 4 lanes -> 4 in Wave 1, 2 in Wave 2, dependsOn ALL of Wave 1 (no conflict, just capacity)', () => {
    const plan = planParallelWaveShards({
      issues: [1, 2, 3, 4, 5, 6].map((n) => ({ id: n, fileScope: [`lib/f${n}.js`] }))
    });
    assert.deepEqual(plan.waveParallelLanes, [4, 2]);
    const wave1Ids = plan.cars.filter((c) => [1, 2, 3, 4].includes(c.payload.issueId)).map((c) => c.id);
    for (const issueId of [5, 6]) {
      const car = plan.cars.find((c) => c.payload.issueId === issueId);
      assert.deepEqual([...car.dependsOn].sort(), [...wave1Ids].sort(),
        `issue ${issueId} has no real conflict with Wave 1 — it depends on ALL of it only because every lane was taken`);
    }
  });

  it('honors a custom carPrefix and builderLanes list', () => {
    const plan = planParallelWaveShards({
      issues: [{ id: 'x', fileScope: ['a.js'] }, { id: 'y', fileScope: ['b.js'] }],
      builderLanes: ['Solo-A', 'Solo-B'],
      carPrefix: 'Car'
    });
    assert.deepEqual(plan.cars.map((c) => c.id), ['Car1-A', 'Car1-B']);
    assert.deepEqual(plan.cars.map((c) => c.lane), ['Solo-A', 'Solo-B']);
  });

  it('a plan it returns passes straight into WaveScheduler#createRun', () => {
    const plan = planParallelWaveShards({
      issues: [
        { id: 1, fileScope: ['lib/a.js'] },
        { id: 2, fileScope: ['lib/b.js'] }
      ]
    });
    const { scheduler } = setup();
    const run = scheduler.createRun({ id: 'r', fleetId: 'f', cars: plan.cars });
    assert.deepEqual(run.waves, plan.waves);
  });
});

describe('validateParallelWavePlan', () => {
  it('rejects a single Wave-1 car for 2+ issues across 2+ lanes, with no serialReason and no justifying conflict', () => {
    const cars = [
      { id: 'a', fileScope: ['lib/a.js'], issues: [1, 2] }
    ];
    throwsCode(() => validateParallelWavePlan({ cars }), 'SINGLE_STREAM_MULTI_ISSUE_DRIFT');
  });

  it('accepts it when an explicit serialReason is attested', () => {
    const cars = [{ id: 'a', fileScope: ['lib/a.js'], issues: [1, 2] }];
    const result = validateParallelWavePlan({ cars, serialReason: 'Operator requested one lane for this release' });
    assert.equal(result.ok, true);
    assert.equal(result.serialReason, 'Operator requested one lane for this release');
    assert.equal(result.wave1ParallelCars, 1);
  });

  it('refuses a blank or whitespace-only serialReason as not actually attested', () => {
    const cars = [{ id: 'a', fileScope: ['lib/a.js'], issues: [1, 2] }];
    throwsCode(() => validateParallelWavePlan({ cars, serialReason: '   ' }), 'SINGLE_STREAM_MULTI_ISSUE_DRIFT');
  });

  it('accepts a single Wave-1 car when every later car genuinely conflicts with it', () => {
    const cars = [
      { id: 'a', fileScope: ['lib/shared.js'] },
      { id: 'b', dependsOn: ['a'], fileScope: ['lib/shared.js'] },
      { id: 'c', dependsOn: ['a'], fileScope: ['lib/shared.js', 'lib/extra.js'] }
    ];
    const result = validateParallelWavePlan({ cars, issueCount: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.wave1ParallelCars, 1);
  });

  it('accepts the normal 4-car Wave 1 case unconditionally — nothing to excuse', () => {
    const plan = planParallelWaveShards({
      issues: [1, 2, 3, 4].map((n) => ({ id: n, fileScope: [`lib/f${n}.js`] }))
    });
    const result = validateParallelWavePlan({ cars: plan.cars, issueCount: 4 });
    assert.equal(result.ok, true);
    assert.equal(result.wave1ParallelCars, 4);
  });

  it('is a no-op for a single issue, or a single Builder lane — nothing to parallelize', () => {
    const oneIssue = [{ id: 'a', fileScope: ['lib/a.js'] }];
    assert.equal(validateParallelWavePlan({ cars: oneIssue, issueCount: 1 }).ok, true);
    const twoIssuesOneLane = [{ id: 'a', fileScope: ['lib/a.js'], issues: [1, 2] }];
    assert.equal(validateParallelWavePlan({ cars: twoIssuesOneLane, issueCount: 2, builderLanes: ['TC-Lane-A'] }).ok, true);
  });

  // #3213 R-Gate R1 BLOCKING 1 — a Car's bundled issues live at
  // `car.payload.issues` ({@link planParallelWaveShards}'s own shape),
  // not just a top-level `car.issues`; omitting `issueCount` must still
  // infer the real count from either, in that order.
  it('infers issueCount from car.payload.issues when issueCount is omitted', () => {
    const cars = [{ id: 'a', fileScope: ['lib/a.js'], payload: { issues: [3213, 3216] } }];
    throwsCode(() => validateParallelWavePlan({ cars }), 'SINGLE_STREAM_MULTI_ISSUE_DRIFT');
  });

  it('prefers car.payload.issues over a top-level car.issues when both are present', () => {
    const cars = [{ id: 'a', fileScope: ['lib/a.js'], issues: [1], payload: { issues: [3213, 3216] } }];
    const result = validateParallelWavePlan({ cars, serialReason: 'attested' });
    assert.equal(result.wave1ParallelCars, 1);
    throwsCode(() => validateParallelWavePlan({ cars }), 'SINGLE_STREAM_MULTI_ISSUE_DRIFT',
      'payload.issues (length 2) must win, not the top-level issues (length 1)');
  });

  it('rejects a non-array car.payload.issues or car.issues as malformed, rather than silently counting 1', () => {
    throwsCode(() => validateParallelWavePlan({ cars: [{ id: 'a', fileScope: ['x'], payload: { issues: 'oops' } }] }),
      'CAR_ISSUES_INVALID');
    throwsCode(() => validateParallelWavePlan({ cars: [{ id: 'a', fileScope: ['x'], issues: 'oops' }] }),
      'CAR_ISSUES_INVALID');
  });

  // #3213 R-Gate R1 BLOCKING 2 — builderLanes must get the same non-empty,
  // distinct-entries validation planParallelWaveShards already enforces,
  // not a bare ok:true the moment builderLanes.length < 2 short-circuits
  // the drift check.
  it('rejects an empty builderLanes array, rather than treating it as "nothing to parallelize"', () => {
    const cars = [{ id: 'a', fileScope: ['lib/a.js'], issues: [1, 2] }];
    throwsCode(() => validateParallelWavePlan({ cars, builderLanes: [] }), 'BUILDER_LANES_REQUIRED');
  });

  it('rejects duplicate builderLanes entries', () => {
    const cars = [{ id: 'a', fileScope: ['lib/a.js'], issues: [1, 2] }];
    throwsCode(() => validateParallelWavePlan({ cars, builderLanes: ['TC-Lane-A', 'TC-Lane-A'] }), 'BUILDER_LANES_DUPLICATE');
  });

  // #3213 R-Gate R3 BLOCKING 1 — a single malformed entry passes both
  // BUILDER_LANES_REQUIRED (a 1-element array is non-empty) and
  // BUILDER_LANES_DUPLICATE (a 1-element array has no duplicates by
  // construction) — only a per-entry type/shape check can catch it.
  for (const malformed of [[''], [null], [{}]]) {
    it(`rejects builderLanes: ${JSON.stringify(malformed)} as malformed, not a valid single lane`, () => {
      const cars = [{ id: 'a', fileScope: ['lib/a.js'], issues: [1, 2] }];
      throwsCode(() => validateParallelWavePlan({ cars, builderLanes: malformed }), 'BUILDER_LANES_INVALID');
    });
  }
});

describe('WaveScheduler#createRun — optional parallel-sharding enforcement (metadata.enforceParallelSharding)', () => {
  it('is off by default: an unsharded multi-issue single car is accepted exactly as before this car', () => {
    const { scheduler } = setup();
    const run = scheduler.createRun({
      id: 'r', fleetId: 'f',
      cars: [{ id: 'a', fileScope: ['lib/a.js'] }]
    });
    assert.equal(run.status, 'active');
  });

  it('enforces the guard when metadata.enforceParallelSharding is true, before persisting anything', () => {
    const { scheduler, store } = setup();
    throwsCode(() => scheduler.createRun({
      id: 'r', fleetId: 'f',
      cars: [{ id: 'a', fileScope: ['lib/a.js'] }],
      metadata: { enforceParallelSharding: true, issueCount: 4 }
    }), 'SINGLE_STREAM_MULTI_ISSUE_DRIFT');
    assert.deepEqual(store.read().runs, {}, 'a run that fails the guard must never be persisted');
  });

  it('passes with metadata.enforceParallelSharding when the plan is genuinely sharded', () => {
    const { scheduler } = setup();
    const plan = planParallelWaveShards({
      issues: [1, 2, 3, 4].map((n) => ({ id: n, fileScope: [`lib/f${n}.js`] }))
    });
    const run = scheduler.createRun({
      id: 'r', fleetId: 'f', cars: plan.cars,
      metadata: { enforceParallelSharding: true, issueCount: 4 }
    });
    assert.equal(run.status, 'active');
    assert.equal(run.waves[0].length, 4);
  });

  it('passes a serialReason through metadata to the guard', () => {
    const { scheduler } = setup();
    const run = scheduler.createRun({
      id: 'r', fleetId: 'f',
      cars: [{ id: 'a', fileScope: ['lib/a.js'] }],
      metadata: { enforceParallelSharding: true, issueCount: 2, serialReason: 'deliberate single-car release' }
    });
    assert.equal(run.status, 'active');
  });

  // #3213 R-Gate R1 BLOCKING 1 — the exact regression named in the
  // dispatch: metadata.enforceParallelSharding: true with
  // payload.issues: [3213, 3216], omitting metadata.issueCount entirely.
  it('enforces the guard from payload.issues alone, with metadata.issueCount omitted, before persisting anything', () => {
    const { scheduler, store } = setup();
    throwsCode(() => scheduler.createRun({
      id: 'r', fleetId: 'f',
      cars: [{ id: 'a', fileScope: ['lib/a.js'], payload: { issues: [3213, 3216] } }],
      metadata: { enforceParallelSharding: true }
    }), 'SINGLE_STREAM_MULTI_ISSUE_DRIFT');
    assert.deepEqual(store.read().runs, {}, 'a run that fails the guard must never be persisted');
  });

  // #3213 R-Gate R1 BLOCKING 2 — a malformed metadata.builderLanes must
  // refuse through createRun's own enforcement, not just the standalone
  // validateParallelWavePlan call already covered above.
  it('rejects metadata.builderLanes: [] through createRun, rather than silently skipping enforcement', () => {
    const { scheduler, store } = setup();
    throwsCode(() => scheduler.createRun({
      id: 'r', fleetId: 'f',
      cars: [{ id: 'a', fileScope: ['lib/a.js'], issues: [1, 2] }],
      metadata: { enforceParallelSharding: true, builderLanes: [] }
    }), 'BUILDER_LANES_REQUIRED');
    assert.deepEqual(store.read().runs, {}, 'a run with malformed builderLanes must never be persisted');
  });

  // #3213 R-Gate R3 BLOCKING 1 — a single malformed metadata.builderLanes
  // entry, through createRun's own enforcement path.
  for (const malformed of [[''], [null], [{}]]) {
    it(`rejects metadata.builderLanes: ${JSON.stringify(malformed)} through createRun, not just a bare-array shape check`, () => {
      const { scheduler, store } = setup();
      throwsCode(() => scheduler.createRun({
        id: 'r', fleetId: 'f',
        cars: [{ id: 'a', fileScope: ['lib/a.js'], issues: [1, 2] }],
        metadata: { enforceParallelSharding: true, builderLanes: malformed }
      }), 'BUILDER_LANES_INVALID');
      assert.deepEqual(store.read().runs, {}, 'a run with a malformed builderLanes entry must never be persisted');
    });
  }
});
