'use strict';

/**
 * v6 (#1886, V6-22 / C3, Car V61-W1-B): the Autonomous Wave Scheduler and
 * DAG engine.
 *
 * A run is a set of Cars with `dependsOn` edges. The scheduler orders them
 * into deterministic waves (Kahn's algorithm, ids sorted inside a wave),
 * refusing an unknown dependency or a cycle. A Car dispatches only once
 * every Car it depends on is `complete`, and only after it atomically
 * reserves its whole repository-relative file scope: exact paths and
 * terminal `dir/**` subtrees conflict across EVERY active run, so two Cars
 * that could touch the same file never run at once. A Car with a review
 * gate (`R-Gate`/`A-Gate`) stops at `awaiting-gate` on completion and its
 * dependents stay blocked until a reviewer other than the Car's author
 * records `PASS`. A stalled Car (no heartbeat for `maxStallMs`) is handed to
 * injected remediation hooks, which may redispatch it, narrow its scope, or
 * escalate.
 *
 * Adapted from the Builders-A-D C3 drop-in prototype
 * (`v6-c1-fleet-registry-and-c3-wave-scheduler-dropin-suite.md`), with these
 * deliberate departures, each covered by a test:
 * - `dispatchReady` reserves inside the store transaction but calls the
 *   caller's `dispatch` side effect AFTER commit, releasing the reservation
 *   in a second transaction if it throws — the prototype ran the side
 *   effect inside the transaction, so a commit failure could leave a Car
 *   dispatched with no record of it.
 * - A `narrow` remediation may only shrink a Car's scope (every new scope
 *   inside an old one); a widening decision is escalated instead.
 * - Terminal Cars (`complete`, `cancelled`) cannot be cancelled or
 *   re-completed, and a run holding a cancelled Car reads `blocked`, not
 *   `active` forever.
 * - A gate verdict needs a named reviewer, and the Car's own author
 *   (`payload.author`) cannot record it.
 *
 * Wave 1 scope (Charter A624): no `server.js` route and no
 * `lib/store/_schema.js` migration. {@link SqliteSchedulerStore} creates its
 * own two tables idempotently through {@link ensureSchema}; Wave 2 mounts
 * the routes. Merge, release, deploy and secrets are outside this module —
 * `dispatch` is whatever the caller passes, and this module performs no
 * action of its own.
 *
 * @module lib/v6/c3-wave-scheduler
 */

const crypto = require('node:crypto');

/** Every status a Car can hold. */
const CAR_STATUSES = Object.freeze(['pending', 'running', 'awaiting-gate', 'gate-held', 'complete', 'stalled', 'cancelled']);

/** The review gates a Car may carry. */
const GATE_TYPES = Object.freeze(['R-Gate', 'A-Gate']);

/** Default stall threshold: 15 minutes without a heartbeat. */
const DEFAULT_MAX_STALL_MS = 15 * 60 * 1000;

/** A typed scheduler refusal: `code` is stable, `status` is the HTTP status a route should answer with. */
class WaveSchedulerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {object} [detail]
   */
  constructor(code, message, status = 400, detail) {
    super(message);
    this.name = 'WaveSchedulerError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Throw a {@link WaveSchedulerError} unless `condition` holds.
 * @param {*} condition
 * @param {string} code
 * @param {string} message
 * @param {number} [status]
 * @param {object} [detail]
 * @returns {void}
 */
function need(condition, code, message, status = 400, detail) {
  if (!condition) throw new WaveSchedulerError(code, message, status, detail);
}

/**
 * Normalize one repository-relative file scope: an exact path or a
 * terminal `dir/**` subtree. Refuses absolute paths, backslashes, `..`,
 * and any wildcard other than a terminal `/**`.
 * @param {string} scope
 * @returns {string}
 * @throws {WaveSchedulerError} `FILE_SCOPE_INVALID`.
 */
function normalizeScope(scope) {
  need(typeof scope === 'string' && scope.length > 0, 'FILE_SCOPE_INVALID', 'file scope must be a non-empty string');
  need(!scope.startsWith('/') && !scope.includes('\\') && !scope.split('/').includes('..'),
    'FILE_SCOPE_INVALID', `file scope must be repository-relative: ${scope}`);
  const wildcards = scope.replace(/\/\*\*$/, '');
  need(!wildcards.includes('*') && !wildcards.includes('?'), 'FILE_SCOPE_INVALID', 'only a terminal /** wildcard is supported');
  const normalized = scope.replace(/^(\.\/)+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
  need(normalized.length > 0 && normalized !== '**' && normalized !== '.', 'FILE_SCOPE_INVALID', 'file scope must name a path');
  return normalized;
}

/**
 * The path a scope covers, without its terminal `/**`.
 * @param {string} scope - Already normalized.
 * @returns {string}
 */
function scopeBase(scope) {
  return scope.endsWith('/**') ? scope.slice(0, -3) : scope;
}

/**
 * Whether two scopes could touch the same file.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function scopesConflict(a, b) {
  const na = normalizeScope(a);
  const nb = normalizeScope(b);
  if (na === nb) return true;
  const ab = scopeBase(na);
  const bb = scopeBase(nb);
  if (na.endsWith('/**') && (bb === ab || bb.startsWith(`${ab}/`))) return true;
  if (nb.endsWith('/**') && (ab === bb || ab.startsWith(`${bb}/`))) return true;
  return false;
}

/**
 * Whether `inner` covers nothing `outer` does not — the test a `narrow`
 * remediation's new scope must pass against the Car's old scope.
 * @param {string} inner - Normalized.
 * @param {string} outer - Normalized.
 * @returns {boolean}
 */
function scopeWithin(inner, outer) {
  if (inner === outer) return true;
  if (!outer.endsWith('/**')) return false;
  const base = scopeBase(outer);
  const innerBase = scopeBase(inner);
  return innerBase === base || innerBase.startsWith(`${base}/`);
}

/**
 * Order Cars into dependency waves. Each wave holds every remaining Car
 * whose dependencies all sit in earlier waves, sorted by id, so the same
 * graph always yields the same waves.
 * @param {Array<{id: string, dependsOn?: string[]}>} cars
 * @returns {string[][]}
 * @throws {WaveSchedulerError} `CARS_REQUIRED`, `CAR_ID_INVALID`,
 *   `CAR_DUPLICATE`, `DEPENDENCY_INVALID`, `DEPENDENCY_UNKNOWN`, `DEPENDENCY_CYCLE`.
 */
function topologicalWaves(cars) {
  need(Array.isArray(cars) && cars.length > 0, 'CARS_REQUIRED', 'cars must be a non-empty list');
  const byId = new Map();
  for (const car of cars) {
    need(car && typeof car.id === 'string' && car.id, 'CAR_ID_INVALID', 'every car needs a string id');
    need(!byId.has(car.id), 'CAR_DUPLICATE', `duplicate car ${car.id}`, 409);
    need(car.dependsOn === undefined || (Array.isArray(car.dependsOn) && car.dependsOn.every((d) => typeof d === 'string')),
      'DEPENDENCY_INVALID', `${car.id}.dependsOn must be a list of car ids`);
    byId.set(car.id, car);
  }
  for (const car of cars) {
    for (const dep of car.dependsOn || []) {
      need(byId.has(dep), 'DEPENDENCY_UNKNOWN', `${car.id} depends on unknown car ${dep}`, 409);
    }
  }
  const remaining = new Set(byId.keys());
  const done = new Set();
  const waves = [];
  while (remaining.size) {
    const wave = [...remaining].filter((id) => (byId.get(id).dependsOn || []).every((dep) => done.has(dep))).sort();
    need(wave.length > 0, 'DEPENDENCY_CYCLE', 'car dependency graph contains a cycle', 409, { cars: [...remaining].sort() });
    waves.push(wave);
    for (const id of wave) { remaining.delete(id); done.add(id); }
  }
  return waves;
}

/** An in-process store: each transaction works on a deep copy and commits it only if `fn` returns. */
class MemorySchedulerStore {
  /** @param {{runs: object, locks: object}} [seed] */
  constructor(seed = { runs: {}, locks: {} }) { this.state = structuredClone(seed); }

  /** @returns {{runs: object, locks: object}} A copy of the committed state. */
  read() { return structuredClone(this.state); }

  /**
   * @param {(draft: {runs: object, locks: object}) => *} fn
   * @returns {*} A copy of `fn`'s result.
   */
  transaction(fn) {
    const draft = this.read();
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

/**
 * Create this module's two tables if they do not exist. Idempotent; Wave 1
 * owns no `lib/store/_schema.js` migration (Charter A624 guardrail 1).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v6_wave_runs (
      id         TEXT    PRIMARY KEY,
      state_json TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v6_wave_file_locks (
      lock_key  TEXT PRIMARY KEY,
      lock_json TEXT NOT NULL
    );
  `);
}

/**
 * A SQLite-backed store. Each transaction is one `BEGIN IMMEDIATE`, so the
 * read-check-write of a lock reservation is serialized against every other
 * writer on the database, not just this process.
 */
class SqliteSchedulerStore {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
    ensureSchema(db);
  }

  /** @returns {{runs: object, locks: object}} */
  read() {
    const runs = {};
    const locks = {};
    for (const row of this.db.prepare('SELECT id, state_json FROM v6_wave_runs ORDER BY id').all()) {
      runs[row.id] = JSON.parse(row.state_json);
    }
    for (const row of this.db.prepare('SELECT lock_key, lock_json FROM v6_wave_file_locks ORDER BY lock_key').all()) {
      locks[row.lock_key] = JSON.parse(row.lock_json);
    }
    return { runs, locks };
  }

  /**
   * Run `fn` on a draft and write back only what it changed, in one
   * immediate transaction; roll back if `fn` or a write throws.
   * @param {(draft: {runs: object, locks: object}) => *} fn
   * @returns {*} A copy of `fn`'s result.
   */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.read();
      const draft = structuredClone(before);
      const result = fn(draft);
      const putRun = this.db.prepare('INSERT OR REPLACE INTO v6_wave_runs (id, state_json, created_at) VALUES (?, ?, ?)');
      for (const run of Object.values(draft.runs)) {
        const json = JSON.stringify(run);
        if (!before.runs[run.id] || JSON.stringify(before.runs[run.id]) !== json) putRun.run(run.id, json, run.createdAt);
      }
      const delLock = this.db.prepare('DELETE FROM v6_wave_file_locks WHERE lock_key = ?');
      for (const key of Object.keys(before.locks)) if (!draft.locks[key]) delLock.run(key);
      const putLock = this.db.prepare('INSERT OR REPLACE INTO v6_wave_file_locks (lock_key, lock_json) VALUES (?, ?)');
      for (const [key, lock] of Object.entries(draft.locks)) {
        const json = JSON.stringify(lock);
        if (!before.locks[key] || JSON.stringify(before.locks[key]) !== json) putLock.run(key, json);
      }
      this.db.exec('COMMIT');
      return structuredClone(result);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* the failed statement already ended the transaction */ }
      throw error;
    }
  }
}

/**
 * The lock key a Car's file-scope reservation is held under.
 * @param {string} runId
 * @param {string} carId
 * @returns {string}
 */
function lockKey(runId, carId) {
  return `${runId}:${carId}`;
}

/** The scheduler: create runs, dispatch ready Cars, record progress, gates and stalls. */
class WaveScheduler {
  /**
   * @param {{store?: MemorySchedulerStore|SqliteSchedulerStore, now?: () => number,
   *   idFactory?: () => string, eventSink?: (event: object) => void,
   *   remediationHooks?: Array<(context: object) => object|null>}} [opts]
   */
  constructor({ store = new MemorySchedulerStore(), now = () => Date.now(),
    idFactory = () => `run-${crypto.randomUUID()}`, eventSink = () => {}, remediationHooks = [] } = {}) {
    this.store = store;
    this.now = now;
    this.idFactory = idFactory;
    this.eventSink = eventSink;
    this.remediationHooks = remediationHooks;
  }

  /**
   * Create a run from a Car graph.
   * @param {{id?: string, fleetId: string, cars: Array<{id: string, dependsOn?: string[],
   *   fileScope: string[], gate?: {type: string, reviewerRole?: string}, payload?: object,
   *   maxStallMs?: number}>, metadata?: object}} spec
   * @returns {object} The stored run.
   * @throws {WaveSchedulerError} Any {@link topologicalWaves} refusal, plus `FLEET_ID_REQUIRED`,
   *   `FILE_SCOPE_REQUIRED`, `FILE_SCOPE_INVALID`, `GATE_INVALID`, `STALL_INVALID`, `RUN_EXISTS`.
   */
  createRun({ id, fleetId, cars, metadata = {} }) {
    need(typeof fleetId === 'string' && fleetId, 'FLEET_ID_REQUIRED', 'fleetId is required');
    const runId = id || this.idFactory();
    const waves = topologicalWaves(cars);
    const carState = {};
    for (const car of cars) {
      need(Array.isArray(car.fileScope), 'FILE_SCOPE_REQUIRED', `${car.id} needs a file scope`);
      const fileScope = [...new Set(car.fileScope.map(normalizeScope))].sort();
      need(fileScope.length > 0, 'FILE_SCOPE_REQUIRED', `${car.id} needs a file scope`);
      if (car.gate) need(GATE_TYPES.includes(car.gate.type), 'GATE_INVALID', 'gate must be R-Gate or A-Gate');
      need(car.maxStallMs === undefined || (Number.isSafeInteger(car.maxStallMs) && car.maxStallMs > 0),
        'STALL_INVALID', `${car.id}.maxStallMs must be a positive integer`);
      carState[car.id] = {
        id: car.id, dependsOn: [...(car.dependsOn || [])], fileScope,
        gate: car.gate ? structuredClone(car.gate) : null,
        payload: structuredClone(car.payload || {}), status: 'pending', attempts: 0,
        maxStallMs: car.maxStallMs || DEFAULT_MAX_STALL_MS, startedAt: null, lastProgressAt: null,
        completedAt: null, gateReceipt: null, remediationCount: 0
      };
    }
    return this.store.transaction((state) => {
      need(!state.runs[runId], 'RUN_EXISTS', `run ${runId} already exists`, 409);
      const run = { id: runId, fleetId, status: 'active', waves, cars: carState, metadata: structuredClone(metadata), createdAt: this.now() };
      state.runs[runId] = run;
      return run;
    });
  }

  /**
   * @param {string} id
   * @returns {object} The stored run.
   * @throws {WaveSchedulerError} `RUN_NOT_FOUND`.
   */
  getRun(id) {
    const run = this.store.read().runs[id];
    need(run, 'RUN_NOT_FOUND', `run ${id} not found`, 404);
    return run;
  }

  /**
   * Reserve and dispatch every Car whose dependencies are complete and
   * whose file scope conflicts with no held lock. Reservation commits
   * first; `dispatch` runs after, once per reserved Car, and a Car whose
   * `dispatch` throws has its reservation released and returns to `pending`.
   * @param {string} runId
   * @param {(car: object, run: object) => void} [dispatch]
   * @returns {{dispatched: string[], failed: Array<{carId: string, error: string}>,
   *   conflicts: Array<{carId: string, heldBy: string, scopes: string[]}>}}
   * @throws {WaveSchedulerError} `RUN_NOT_FOUND`.
   */
  dispatchReady(runId, dispatch = () => {}) {
    const events = [];
    const reserved = this.store.transaction((state) => {
      const run = state.runs[runId];
      need(run, 'RUN_NOT_FOUND', `run ${runId} not found`, 404);
      const taken = [];
      const conflicts = [];
      for (const wave of run.waves) {
        for (const carId of wave) {
          const car = run.cars[carId];
          if (car.status !== 'pending' || !car.dependsOn.every((d) => run.cars[d].status === 'complete')) continue;
          const collision = Object.entries(state.locks).find(([, lock]) => (
            car.fileScope.some((scope) => lock.scopes.some((held) => scopesConflict(scope, held)))
          ));
          if (collision) {
            const conflict = { carId, heldBy: collision[0], scopes: car.fileScope };
            conflicts.push(conflict);
            events.push({ type: 'file-scope-conflict', runId, ...conflict });
            continue;
          }
          state.locks[lockKey(runId, carId)] = { runId, carId, scopes: car.fileScope };
          car.status = 'running';
          car.attempts += 1;
          car.startedAt = this.now();
          car.lastProgressAt = car.startedAt;
          taken.push({ car: structuredClone(car), run: null });
        }
      }
      for (const entry of taken) entry.run = structuredClone(run);
      return { taken, conflicts };
    });
    const dispatched = [];
    const failed = [];
    for (const { car, run } of reserved.taken) {
      try {
        dispatch(car, run);
        dispatched.push(car.id);
        events.push({ type: 'car-dispatched', runId, carId: car.id, attempt: car.attempts });
      } catch (error) {
        this.store.transaction((state) => {
          const stored = state.runs[runId] && state.runs[runId].cars[car.id];
          delete state.locks[lockKey(runId, car.id)];
          if (stored && stored.status === 'running') {
            stored.status = 'pending';
            stored.startedAt = null;
            stored.lastProgressAt = null;
          }
        });
        failed.push({ carId: car.id, error: error.message });
        events.push({ type: 'dispatch-failed', runId, carId: car.id, error: error.message });
      }
    }
    events.forEach((event) => this.eventSink(event));
    return { dispatched, failed, conflicts: reserved.conflicts };
  }

  /**
   * Record that a running Car is still making progress.
   * @param {string} runId
   * @param {string} carId
   * @param {object} [detail]
   * @returns {object} The Car.
   * @throws {WaveSchedulerError} `CAR_NOT_FOUND`, `CAR_NOT_RUNNING`.
   */
  heartbeat(runId, carId, detail = {}) {
    return this.store.transaction((state) => {
      const car = state.runs[runId] && state.runs[runId].cars[carId];
      need(car, 'CAR_NOT_FOUND', `car ${carId} not found`, 404);
      need(car.status === 'running', 'CAR_NOT_RUNNING', `car ${carId} is not running`, 409);
      car.lastProgressAt = this.now();
      car.progress = structuredClone(detail);
      return car;
    });
  }

  /**
   * Finish a running Car: release its lock, then either complete it or,
   * when it carries a gate, hand it to review.
   * @param {string} runId
   * @param {string} carId
   * @param {object} [receipt]
   * @returns {object} The Car.
   * @throws {WaveSchedulerError} `CAR_NOT_FOUND`, `CAR_NOT_RUNNING`.
   */
  completeCar(runId, carId, receipt = {}) {
    let event = null;
    const result = this.store.transaction((state) => {
      const car = state.runs[runId] && state.runs[runId].cars[carId];
      need(car, 'CAR_NOT_FOUND', `car ${carId} not found`, 404);
      need(car.status === 'running', 'CAR_NOT_RUNNING', `car ${carId} is not running`, 409);
      delete state.locks[lockKey(runId, carId)];
      car.resultReceipt = structuredClone(receipt);
      if (car.gate) {
        car.status = 'awaiting-gate';
        event = { type: 'gate-handoff', runId, carId, gate: car.gate.type, reviewerRole: car.gate.reviewerRole || null, receipt: car.resultReceipt };
      } else {
        car.status = 'complete';
        car.completedAt = this.now();
      }
      return car;
    });
    if (event) this.eventSink(event);
    return result;
  }

  /**
   * Record a gate verdict on a Car awaiting review. `PASS` completes it
   * (unblocking dependents); `HOLD` parks it at `gate-held`.
   * @param {string} runId
   * @param {string} carId
   * @param {{verdict: 'PASS'|'HOLD', reviewer: string, reference?: string}} decision
   * @returns {object} The Car.
   * @throws {WaveSchedulerError} `CAR_NOT_FOUND`, `GATE_NOT_PENDING`,
   *   `GATE_VERDICT_INVALID`, `REVIEWER_REQUIRED`, `SELF_REVIEW`.
   */
  recordGate(runId, carId, { verdict, reviewer, reference } = {}) {
    let event = null;
    const result = this.store.transaction((state) => {
      const car = state.runs[runId] && state.runs[runId].cars[carId];
      need(car, 'CAR_NOT_FOUND', `car ${carId} not found`, 404);
      need(car.status === 'awaiting-gate', 'GATE_NOT_PENDING', `car ${carId} is not awaiting a gate`, 409);
      need(verdict === 'PASS' || verdict === 'HOLD', 'GATE_VERDICT_INVALID', 'verdict must be PASS or HOLD');
      need(typeof reviewer === 'string' && reviewer, 'REVIEWER_REQUIRED', 'a gate verdict names its reviewer');
      need(!car.payload.author || car.payload.author !== reviewer, 'SELF_REVIEW', 'a car\'s author cannot record its own gate', 403);
      car.gateReceipt = { verdict, reviewer, reference: reference || null, at: this.now() };
      car.status = verdict === 'PASS' ? 'complete' : 'gate-held';
      if (verdict === 'PASS') car.completedAt = this.now();
      event = { type: verdict === 'PASS' ? 'gate-passed' : 'gate-held', runId, carId, gate: car.gate.type, reviewer, reference: reference || null };
      return car;
    });
    this.eventSink(event);
    return result;
  }

  /**
   * Cancel a Car that has not finished, releasing any lock it holds.
   * @param {string} runId
   * @param {string} carId
   * @param {string} [reason]
   * @returns {object} The Car.
   * @throws {WaveSchedulerError} `CAR_NOT_FOUND`, `CAR_TERMINAL`.
   */
  cancelCar(runId, carId, reason) {
    return this.store.transaction((state) => {
      const car = state.runs[runId] && state.runs[runId].cars[carId];
      need(car, 'CAR_NOT_FOUND', `car ${carId} not found`, 404);
      need(car.status !== 'complete' && car.status !== 'cancelled', 'CAR_TERMINAL', `car ${carId} is already ${car.status}`, 409);
      delete state.locks[lockKey(runId, carId)];
      car.status = 'cancelled';
      car.cancelReason = reason || null;
      return car;
    });
  }

  /**
   * Find every running Car past its stall threshold and apply the first
   * remediation hook's decision: `redispatch` (back to pending, lock
   * released), `narrow` (shrink its scope; a decision that would widen it
   * is escalated instead), or anything else / no decision (mark `stalled`,
   * lock released). Hooks are pure deciders called inside the transaction.
   * @returns {Array<{type: string, runId: string, carId: string, decision: object}>}
   */
  scanStalls() {
    const now = this.now();
    const events = [];
    this.store.transaction((state) => {
      for (const run of Object.values(state.runs)) {
        for (const car of Object.values(run.cars)) {
          if (car.status !== 'running' || now - car.lastProgressAt <= car.maxStallMs) continue;
          const context = { run: structuredClone(run), car: structuredClone(car), stalledForMs: now - car.lastProgressAt };
          let decision = null;
          for (const hook of this.remediationHooks) {
            decision = hook(context);
            if (decision) break;
          }
          if (!decision) decision = { action: 'escalate', reason: 'no remediation hook accepted the stall' };
          if (decision.action === 'narrow') {
            let narrowed = null;
            try {
              narrowed = [...new Set((decision.fileScope || []).map(normalizeScope))].sort();
            } catch {
              narrowed = null;
            }
            const valid = narrowed && narrowed.length > 0
              && narrowed.every((s) => car.fileScope.some((old) => scopeWithin(s, old)));
            if (!valid) decision = { action: 'escalate', reason: 'narrow decision did not shrink the scope', rejected: structuredClone(decision) };
            else decision = { ...decision, fileScope: narrowed };
          }
          car.remediationCount += 1;
          car.lastRemediation = { ...structuredClone(decision), at: now };
          const key = lockKey(run.id, car.id);
          if (decision.action === 'redispatch') {
            delete state.locks[key];
            car.status = 'pending';
            car.startedAt = null;
            car.lastProgressAt = null;
          } else if (decision.action === 'narrow') {
            car.fileScope = decision.fileScope;
            if (state.locks[key]) state.locks[key].scopes = car.fileScope;
            car.lastProgressAt = now;
          } else {
            car.status = 'stalled';
            delete state.locks[key];
          }
          events.push({ type: 'stall-remediated', runId: run.id, carId: car.id, decision: structuredClone(decision) });
        }
      }
    });
    events.forEach((event) => this.eventSink(event));
    return events;
  }

  /**
   * Recompute a run's status from its Cars: `complete` when every Car is,
   * `blocked` when any is held, stalled or cancelled (its dependents can
   * never run), else `active`.
   * @param {string} runId
   * @returns {object} The run.
   * @throws {WaveSchedulerError} `RUN_NOT_FOUND`.
   */
  reconcileRun(runId) {
    return this.store.transaction((state) => {
      const run = state.runs[runId];
      need(run, 'RUN_NOT_FOUND', `run ${runId} not found`, 404);
      const statuses = Object.values(run.cars).map((car) => car.status);
      if (statuses.every((s) => s === 'complete')) run.status = 'complete';
      else if (statuses.some((s) => s === 'gate-held' || s === 'stalled' || s === 'cancelled')) run.status = 'blocked';
      else run.status = 'active';
      return run;
    });
  }
}

module.exports = {
  CAR_STATUSES,
  GATE_TYPES,
  DEFAULT_MAX_STALL_MS,
  WaveSchedulerError,
  MemorySchedulerStore,
  SqliteSchedulerStore,
  WaveScheduler,
  ensureSchema,
  normalizeScope,
  scopesConflict,
  scopeWithin,
  topologicalWaves
};
