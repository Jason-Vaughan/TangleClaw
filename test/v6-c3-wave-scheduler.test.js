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
  CAR_STATUSES, GATE_TYPES, DEFAULT_MAX_STALL_MS, WaveSchedulerError,
  MemorySchedulerStore, SqliteSchedulerStore, WaveScheduler, ensureSchema,
  normalizeScope, scopesConflict, scopeWithin, topologicalWaves
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
    assert.deepEqual(first.conflicts.map((c) => [c.carId, c.heldBy]), [['b', 'r1:a']]);
    scheduler.createRun({ id: 'r2', fleetId: 'g', cars: [{ id: 'z', fileScope: ['lib/v6/y.js'] }] });
    assert.deepEqual(scheduler.dispatchReady('r2').conflicts.map((c) => c.heldBy), ['r1:a']);
    scheduler.completeCar('r1', 'a');
    assert.deepEqual(scheduler.dispatchReady('r1').dispatched, ['b']);
    assert.ok(events.some((e) => e.type === 'file-scope-conflict' && e.carId === 'z'));
  });

  it('runs dispatch only after the reservation commits, and a throwing dispatch releases it', () => {
    const { scheduler, store, events } = setup();
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['lib/a.js'] }] });
    let lockedDuringDispatch = null;
    const result = scheduler.dispatchReady('r', () => {
      lockedDuringDispatch = Boolean(store.read().locks['r:a']);
      throw new Error('pane refused');
    });
    assert.equal(lockedDuringDispatch, true, 'the lock is committed before the side effect runs');
    assert.deepEqual(result.dispatched, []);
    assert.deepEqual(result.failed, [{ carId: 'a', error: 'pane refused' }]);
    assert.equal(store.read().locks['r:a'], undefined);
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
    assert.equal(store.read().locks['r:a'], undefined);
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
    assert.equal(store.read().locks['r:a'], undefined);
    assert.equal(scheduler.reconcileRun('r').status, 'blocked');
    assert.ok(events.some((e) => e.type === 'stall-remediated'));
  });

  it('redispatch returns the car to pending with its lock released', () => {
    const { scheduler, store, tick } = running([() => ({ action: 'redispatch' })]);
    tick(5000);
    scheduler.scanStalls();
    assert.equal(scheduler.getRun('r').cars.a.status, 'pending');
    assert.equal(store.read().locks['r:a'], undefined);
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
    assert.deepEqual(store.read().locks['r:a'].scopes, ['lib/v6/c3-wave-scheduler.js']);
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
    assert.deepEqual(reopened.locks['r:a'].scopes, ['lib/a.js']);
    scheduler.completeCar('r', 'a');
    assert.equal(new SqliteSchedulerStore(db).read().locks['r:a'], undefined);
    scheduler.dispatchReady('r');
    scheduler.completeCar('r', 'b');
    scheduler.completeCar('r', 'c');
    scheduler.dispatchReady('r');
    scheduler.completeCar('r', 'd');
    assert.equal(scheduler.reconcileRun('r').status, 'complete');
  });

  it('rolls back every write when the transaction throws', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteSchedulerStore(db);
    const { scheduler } = setup({ store });
    scheduler.createRun({ id: 'r', fleetId: 'f', cars: [{ id: 'a', fileScope: ['x'] }] });
    assert.throws(() => store.transaction((state) => {
      state.locks['r:a'] = { runId: 'r', carId: 'a', scopes: ['x'] };
      state.runs.r.cars.a.status = 'running';
      throw new Error('boom');
    }), /boom/);
    assert.equal(store.read().locks['r:a'], undefined);
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
    assert.deepEqual(b.dispatchReady('r2').conflicts.map((c) => c.heldBy), ['r1:x']);
  });
});
