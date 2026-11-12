'use strict';

/**
 * v6.2 (#3001, V6-31 / E3b, Car V62-W1-A): the interactive multi-train
 * what-if capacity and bottleneck simulator.
 *
 * Extends the canonical prototype's `simulateWhatIf` (P25,
 * `v6-phase6-e2-sprint-mount-e4b-retro-g2-provider-g4-advisor-suite.md`),
 * which packed file-disjoint cars into capacity-bounded waves, into a
 * deterministic discrete-time schedule across several trains at once:
 *
 * - a car runs only after every car it `dependsOn` has finished (within or
 *   across trains), never alongside a running car that touches one of its
 *   files, and only on a free lane of its `role`;
 * - `rolePools` says how many lanes each role has; an optional per-role
 *   `quotaUnits` budget per lane models a quota window — a lane whose
 *   remaining budget is smaller than a car's effort cannot take it;
 * - ready cars start in a fixed order (longest remaining critical path
 *   first, then id), so the same scenario always yields the same schedule.
 *
 * Every result says what bounded it: per-role `bottlenecks` (time ready
 * cars spent waiting for a lane, file lock or quota), the `criticalPath`
 * (the longest effort-weighted dependency chain), and `unschedulable` cars
 * with a named reason (`CYCLE`, `UNKNOWN_DEPENDENCY`, `NO_LANE_FOR_ROLE`,
 * `QUOTA_EXHAUSTED`) rather than a silent omission. {@link compareScenarios}
 * runs variants against a baseline and reports makespan and critical-path
 * shifts. Simulations persist idempotently by scenario digest in a
 * module-owned table ({@link ensureSchema}; no `_schema.js` edit).
 *
 * The numbers are the scenario's own (efforts are whatever units the
 * caller chose): this module never claims a calendar estimate.
 *
 * @module lib/v6/e3b-whatif-simulator
 */

const crypto = require('node:crypto');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
/** Hard limits, so a scenario cannot make the simulator unbounded. */
const LIMITS = Object.freeze({ trains: 50, carsPerScenario: 500, effort: 10_000, lanesPerRole: 100, filesPerCar: 200 });
const DEFAULT_ROLE = 'Builder';

/**
 * Create this module's table. Idempotent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v6_e3b_simulations (
      id              TEXT PRIMARY KEY,
      scenario_digest TEXT NOT NULL UNIQUE,
      label           TEXT,
      scenario_json   TEXT NOT NULL CHECK (json_valid(scenario_json)),
      result_json     TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at      TEXT NOT NULL
    );
  `);
}

/**
 * Validate and normalize a scenario. Throws `TypeError` naming the first
 * fault; never guesses a missing value except the documented defaults
 * (`role` → Builder, `dependsOn`/`files` → []).
 * @param {*} scenario
 * @returns {{trains: Array<object>, cars: Array<object>, rolePools: Object<string, number>, quotaUnits: Object<string, number>}}
 */
function normalizeScenario(scenario) {
  if (!scenario || typeof scenario !== 'object') throw new TypeError('scenario must be an object');
  const { trains, rolePools, quotaUnits = {} } = scenario;
  if (!Array.isArray(trains) || !trains.length || trains.length > LIMITS.trains) throw new TypeError(`trains must be 1..${LIMITS.trains}`);
  if (!rolePools || typeof rolePools !== 'object' || Array.isArray(rolePools)) throw new TypeError('rolePools must be an object of role -> lane count');
  // Null-prototype maps (PRR-A R1, PR #3034): an inherited name such as
  // `constructor` must never read as a configured role or quota.
  const pools = Object.create(null);
  for (const [role, n] of Object.entries(rolePools)) {
    if (!ID.test(role) || !Number.isInteger(n) || n < 0 || n > LIMITS.lanesPerRole) throw new TypeError(`rolePools.${role} must be 0..${LIMITS.lanesPerRole}`);
    pools[role] = n;
  }
  if (!quotaUnits || typeof quotaUnits !== 'object' || Array.isArray(quotaUnits)) throw new TypeError('quotaUnits must be an object');
  const quota = Object.create(null);
  for (const [role, n] of Object.entries(quotaUnits)) {
    if (!Object.hasOwn(pools, role) || !Number.isInteger(n) || n < 1) throw new TypeError(`quotaUnits.${role} must be a positive integer for a pooled role`);
    quota[role] = n;
  }
  const trainIds = new Set();
  const cars = [];
  const carIds = new Set();
  for (const t of trains) {
    if (!t || !ID.test(t.id || '') || trainIds.has(t.id)) throw new TypeError('every train needs a unique id');
    trainIds.add(t.id);
    if (!Array.isArray(t.cars)) throw new TypeError(`train ${t.id} needs a cars array`);
    for (const c of t.cars) {
      if (!c || !ID.test(c.id || '') || carIds.has(c.id)) throw new TypeError('every car needs a unique id');
      if (!Number.isInteger(c.effort) || c.effort < 1 || c.effort > LIMITS.effort) throw new TypeError(`car ${c.id} effort must be 1..${LIMITS.effort}`);
      const files = c.files === undefined ? [] : c.files;
      const dependsOn = c.dependsOn === undefined ? [] : c.dependsOn;
      if (!Array.isArray(files) || files.length > LIMITS.filesPerCar || files.some((f) => typeof f !== 'string' || !f)) throw new TypeError(`car ${c.id} files must be non-empty strings`);
      if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) throw new TypeError(`car ${c.id} dependsOn must be ids`);
      const role = c.role === undefined ? DEFAULT_ROLE : c.role;
      if (!ID.test(role)) throw new TypeError(`car ${c.id} role is invalid`);
      carIds.add(c.id);
      cars.push({ id: c.id, trainId: t.id, effort: c.effort, files: [...new Set(files)].sort(), dependsOn: [...new Set(dependsOn)].sort(), role });
    }
  }
  if (cars.length > LIMITS.carsPerScenario) throw new TypeError(`at most ${LIMITS.carsPerScenario} cars`);
  return { trains: [...trainIds].sort(), cars, rolePools: pools, quotaUnits: quota };
}

/**
 * Effort-weighted longest path from each car to the end of its dependents
 * (its own effort included), plus the cars caught in a dependency cycle or
 * naming an unknown dependency.
 * @param {Array<object>} cars
 * @returns {{tail: Map<string, number>, blocked: Map<string, string>}}
 */
function _analyzeGraph(cars) {
  const byId = new Map(cars.map((c) => [c.id, c]));
  const blocked = new Map();
  for (const c of cars) if (c.dependsOn.some((d) => !byId.has(d))) blocked.set(c.id, 'UNKNOWN_DEPENDENCY');
  // Kahn's algorithm over the known edges; whatever never drains is a cycle.
  const indegree = new Map(cars.map((c) => [c.id, 0]));
  const dependents = new Map(cars.map((c) => [c.id, []]));
  for (const c of cars) for (const d of c.dependsOn) if (byId.has(d)) { indegree.set(c.id, indegree.get(c.id) + 1); dependents.get(d).push(c.id); }
  const queue = cars.filter((c) => indegree.get(c.id) === 0).map((c) => c.id).sort();
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of dependents.get(id).sort()) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const ordered = new Set(order);
  for (const c of cars) if (!ordered.has(c.id) && !blocked.has(c.id)) blocked.set(c.id, 'CYCLE');
  // Anything downstream of a blocked car can never start either.
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cars) {
      if (blocked.has(c.id)) continue;
      const bad = c.dependsOn.find((d) => blocked.has(d));
      if (bad) { blocked.set(c.id, blocked.get(bad) === 'CYCLE' ? 'CYCLE' : 'UNKNOWN_DEPENDENCY'); grew = true; }
    }
  }
  const tail = new Map();
  for (const id of [...order].reverse()) {
    const c = byId.get(id);
    const after = Math.max(0, ...dependents.get(id).filter((n) => !blocked.has(n)).map((n) => tail.get(n) || 0));
    tail.set(id, c.effort + after);
  }
  return { tail, blocked };
}

/**
 * The longest effort-weighted dependency chain among schedulable cars.
 * @param {Array<object>} cars
 * @param {Map<string, number>} tail
 * @param {Map<string, string>} blocked
 * @returns {{carIds: string[], effort: number}}
 */
function _criticalPath(cars, tail, blocked) {
  const live = cars.filter((c) => !blocked.has(c.id));
  if (!live.length) return { carIds: [], effort: 0 };
  const byId = new Map(live.map((c) => [c.id, c]));
  const roots = live.filter((c) => c.dependsOn.every((d) => !byId.has(d)));
  const pick = (list) => list.sort((a, b) => tail.get(b.id) - tail.get(a.id) || a.id.localeCompare(b.id))[0];
  let current = pick(roots);
  const path = [];
  while (current) {
    path.push(current.id);
    const next = live.filter((c) => c.dependsOn.includes(current.id) && tail.get(c.id) === tail.get(current.id) - current.effort);
    current = next.length ? pick(next) : null;
  }
  return { carIds: path, effort: tail.get(path[0]) };
}

/**
 * Simulate one scenario.
 * @param {object} scenario - `{trains: [{id, cars: [{id, effort, files?, dependsOn?, role?}]}], rolePools: {role: lanes}, quotaUnits?: {role: unitsPerLane}}`.
 * @returns {{makespan: number, complete: boolean, schedule: Array<object>, trainFinish: Object<string, number|null>,
 *   criticalPath: {carIds: string[], effort: number}, bottlenecks: Object<string, object>,
 *   unschedulable: Array<{carId: string, reason: string}>, utilization: Object<string, number>}}
 * @throws {TypeError} On a malformed scenario.
 */
function simulate(scenario) {
  const s = normalizeScenario(scenario);
  const { tail, blocked } = _analyzeGraph(s.cars);
  const unschedulable = [];
  for (const c of s.cars) {
    if (blocked.has(c.id)) unschedulable.push({ carId: c.id, reason: blocked.get(c.id) });
    else if (!Object.hasOwn(s.rolePools, c.role) || !s.rolePools[c.role]) { unschedulable.push({ carId: c.id, reason: 'NO_LANE_FOR_ROLE' }); blocked.set(c.id, 'NO_LANE_FOR_ROLE'); }
  }
  // A car downstream of a role-less car is unschedulable too.
  for (let grew = true; grew;) {
    grew = false;
    for (const c of s.cars) {
      if (blocked.has(c.id)) continue;
      if (c.dependsOn.some((d) => blocked.get(d) === 'NO_LANE_FOR_ROLE')) { blocked.set(c.id, 'NO_LANE_FOR_ROLE'); unschedulable.push({ carId: c.id, reason: 'NO_LANE_FOR_ROLE' }); grew = true; }
    }
  }

  const lanes = [];
  for (const role of Object.keys(s.rolePools).sort()) {
    for (let i = 1; i <= s.rolePools[role]; i++) {
      lanes.push({ id: `${role}-${i}`, role, freeAt: 0, budget: Object.hasOwn(s.quotaUnits, role) ? s.quotaUnits[role] : Infinity, busy: 0 });
    }
  }
  const pending = new Map(s.cars.filter((c) => !blocked.has(c.id)).map((c) => [c.id, c]));
  const finishedAt = new Map();
  const running = [];
  const schedule = [];
  const waits = Object.create(null);
  let blockedNow = [];
  // A ready car that could not start waits until the next event; that span
  // of time is charged to its role and the reason, so a bottleneck is
  // measured in the scenario's own effort units, not in scheduling steps.
  const bump = (role, kind) => { blockedNow.push({ role, kind }); };
  let t = 0;
  let guard = 0;
  while (pending.size) {
    if (++guard > 1_000_000) throw new Error('simulation did not converge');
    for (let i = running.length - 1; i >= 0; i--) if (running[i].end <= t) running.splice(i, 1);
    const ready = [...pending.values()]
      .filter((c) => c.dependsOn.every((d) => finishedAt.has(d) && finishedAt.get(d) <= t))
      .sort((a, b) => tail.get(b.id) - tail.get(a.id) || a.id.localeCompare(b.id));
    let progressed = false;
    blockedNow = [];
    for (const car of ready) {
      const locked = running.some((r) => r.files.some((f) => car.files.includes(f)));
      if (locked) { bump(car.role, 'fileWait'); continue; }
      const roleLanes = lanes.filter((l) => l.role === car.role);
      const free = roleLanes.filter((l) => l.freeAt <= t);
      const funded = free.filter((l) => l.budget >= car.effort);
      if (!free.length) { bump(car.role, 'laneWait'); continue; }
      if (!funded.length) {
        // No lane of this role can EVER fund it again: budgets only shrink.
        if (roleLanes.every((l) => l.budget < car.effort)) { pending.delete(car.id); unschedulable.push({ carId: car.id, reason: 'QUOTA_EXHAUSTED' }); progressed = true; continue; }
        bump(car.role, 'quotaWait');
        continue;
      }
      const lane = funded.sort((a, b) => b.budget - a.budget || a.id.localeCompare(b.id))[0];
      const end = t + car.effort;
      lane.freeAt = end;
      lane.budget -= car.effort;
      lane.busy += car.effort;
      running.push({ carId: car.id, files: car.files, end });
      finishedAt.set(car.id, end);
      pending.delete(car.id);
      schedule.push({ carId: car.id, trainId: car.trainId, role: car.role, lane: lane.id, start: t, end });
      progressed = true;
    }
    // Anything left that depends on a car that will now never run is unschedulable.
    for (const c of [...pending.values()]) {
      const dead = c.dependsOn.find((d) => !finishedAt.has(d) && !pending.has(d));
      if (dead) { pending.delete(c.id); unschedulable.push({ carId: c.id, reason: 'QUOTA_EXHAUSTED' }); progressed = true; }
    }
    if (!pending.size) break;
    const nextEvent = Math.min(...running.map((r) => r.end).filter((e) => e > t), ...lanes.map((l) => l.freeAt).filter((f) => f > t));
    const nextT = Number.isFinite(nextEvent) ? nextEvent : (progressed ? t : t + 1);
    for (const b of blockedNow) {
      waits[b.role] = waits[b.role] || { laneWait: 0, fileWait: 0, quotaWait: 0 };
      waits[b.role][b.kind] += nextT - t;
    }
    t = nextT;
  }

  const makespan = schedule.reduce((m, x) => Math.max(m, x.end), 0);
  const trainFinish = {};
  for (const id of s.trains) {
    const own = s.cars.filter((c) => c.trainId === id);
    const done = own.every((c) => finishedAt.has(c.id));
    trainFinish[id] = done ? Math.max(0, ...own.map((c) => finishedAt.get(c.id))) : null;
  }
  const utilization = {};
  for (const role of Object.keys(s.rolePools).sort()) {
    const roleLanes = lanes.filter((l) => l.role === role);
    utilization[role] = makespan && roleLanes.length ? roleLanes.reduce((a, l) => a + l.busy, 0) / (roleLanes.length * makespan) : 0;
  }
  // The critical path is over what actually ran (PRR-A R1, PR #3034): a
  // car the quota or the pools never let start is reported in
  // `unschedulable`, never as part of the path the makespan came from.
  const ran = new Set(schedule.map((x) => x.carId));
  const scheduledCars = s.cars.filter((c) => ran.has(c.id)).map((c) => ({ ...c, dependsOn: c.dependsOn.filter((d) => ran.has(d)) }));
  const scheduledGraph = _analyzeGraph(scheduledCars);
  return {
    makespan,
    complete: unschedulable.length === 0,
    schedule: schedule.sort((a, b) => a.start - b.start || a.carId.localeCompare(b.carId)),
    trainFinish,
    criticalPath: _criticalPath(scheduledCars, scheduledGraph.tail, scheduledGraph.blocked),
    bottlenecks: waits,
    unschedulable: unschedulable.sort((a, b) => a.carId.localeCompare(b.carId)),
    utilization
  };
}

/**
 * Run a baseline and named variants, reporting each variant's makespan
 * delta, per-train finish deltas, and whether its critical path shifted.
 * A partial run (some car unschedulable) is flagged `complete: false`,
 * always ranks below every complete run — a short makespan bought by
 * dropping work is not a better plan — and has `criticalPathShifted: null`,
 * since its path is not comparable to a complete run's.
 * @param {object} baseline - A scenario.
 * @param {Array<{name: string, scenario: object}>} variants
 * @returns {{baseline: object, variants: Array<object>}} Variants ranked by makespan, then name.
 * @throws {TypeError} On a malformed scenario or variant list.
 */
function compareScenarios(baseline, variants) {
  if (!Array.isArray(variants) || variants.length > 20) throw new TypeError('variants must be an array of at most 20');
  const base = simulate(baseline);
  const names = new Set();
  const results = variants.map((v) => {
    if (!v || !ID.test(v.name || '') || names.has(v.name)) throw new TypeError('every variant needs a unique name');
    names.add(v.name);
    const r = simulate(v.scenario);
    const trainDelta = {};
    for (const [id, finish] of Object.entries(r.trainFinish)) {
      const was = Object.hasOwn(base.trainFinish, id) ? base.trainFinish[id] : null;
      trainDelta[id] = finish === null || was === null ? null : finish - was;
    }
    const comparable = r.complete && base.complete;
    return {
      name: v.name, complete: r.complete, makespan: r.makespan, makespanDelta: r.makespan - base.makespan, trainDelta,
      criticalPath: r.criticalPath,
      criticalPathShifted: comparable ? JSON.stringify(r.criticalPath.carIds) !== JSON.stringify(base.criticalPath.carIds) : null,
      unschedulable: r.unschedulable, bottlenecks: r.bottlenecks
    };
  });
  results.sort((a, b) => Number(b.complete) - Number(a.complete) || a.makespan - b.makespan || a.name.localeCompare(b.name));
  return { baseline: base, variants: results };
}

/**
 * A stable digest of a scenario's normalized form, so the same scenario
 * (written in any key order) persists once.
 * @param {object} scenario
 * @returns {string}
 */
function scenarioDigest(scenario) {
  const s = normalizeScenario(scenario);
  const canonical = {
    trains: s.trains,
    cars: [...s.cars].sort((a, b) => a.id.localeCompare(b.id)),
    rolePools: Object.fromEntries(Object.entries(s.rolePools).sort()),
    quotaUnits: Object.fromEntries(Object.entries(s.quotaUnits).sort())
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Simulate and persist, idempotently: a scenario already stored (by
 * digest) returns the stored row instead of a second one.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{scenario: object, label?: string, now?: Function, newId?: Function}} args
 * @returns {{ok: true, code: 'CREATED'|'EXISTING', id: string, digest: string, result: object}|{ok: false, code: string, reason?: string}}
 */
function saveSimulation(db, { scenario, label = null, now = () => new Date().toISOString(), newId = () => crypto.randomUUID() }) {
  ensureSchema(db);
  let digest;
  let result;
  try {
    digest = scenarioDigest(scenario);
    result = simulate(scenario);
  } catch (err) {
    return { ok: false, code: 'SCENARIO_INVALID', reason: err.message };
  }
  if (label !== null && (typeof label !== 'string' || label.length > 160)) return { ok: false, code: 'LABEL_INVALID' };
  const existing = db.prepare('SELECT id, result_json FROM v6_e3b_simulations WHERE scenario_digest = ?').get(digest);
  if (existing) return { ok: true, code: 'EXISTING', id: existing.id, digest, result: JSON.parse(existing.result_json) };
  const id = newId();
  db.prepare('INSERT OR IGNORE INTO v6_e3b_simulations (id, scenario_digest, label, scenario_json, result_json, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, digest, label, JSON.stringify(scenario), JSON.stringify(result), now());
  const row = db.prepare('SELECT id, result_json FROM v6_e3b_simulations WHERE scenario_digest = ?').get(digest);
  return { ok: true, code: row.id === id ? 'CREATED' : 'EXISTING', id: row.id, digest, result: JSON.parse(row.result_json) };
}

/**
 * One stored simulation, or null.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {{id: string, digest: string, label: string|null, scenario: object, result: object, createdAt: string}|null}
 */
function getSimulation(db, id) {
  ensureSchema(db);
  const row = db.prepare('SELECT * FROM v6_e3b_simulations WHERE id = ?').get(id);
  return row ? { id: row.id, digest: row.scenario_digest, label: row.label, scenario: JSON.parse(row.scenario_json), result: JSON.parse(row.result_json), createdAt: row.created_at } : null;
}

module.exports = {
  ensureSchema,
  simulate,
  compareScenarios,
  scenarioDigest,
  saveSimulation,
  getSimulation
};
