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
 * - File scopes canonicalize `.` and empty segments, so `lib/./a.js`
 *   cannot evade a conflict with `lib/a.js`; run and Car ids are
 *   validated ({@link isValidId}) and locks are keyed by an unambiguous
 *   JSON pair, so run `a:b` + Car `c` can never share — and erase — the
 *   lock of run `a` + Car `b:c`, and a Car named `__proto__` cannot
 *   vanish from its run (PRR-B R1 HOLD on PR #3025).
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

/** What a run or Car id must look like: no `:` or `/`, nothing a key encoding could confuse. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * Whether `id` is a safe run or Car id: it matches {@link ID_PATTERN} and
 * is not a property every plain object already has (`__proto__`,
 * `constructor`, `toString`…), which would vanish from — or be invented
 * by — the plain-object maps runs and Cars are stored in.
 * @param {*} id
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) && !(id in Object.prototype);
}

/**
 * `obj[key]` only when `key` is the object's own property.
 * @param {object} obj
 * @param {string} key
 * @returns {*}
 */
function own(obj, key) {
  return obj && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined;
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
  // Drop empty and `.` segments, so `lib/./a.js`, `./lib//a.js` and
  // `lib/a.js/` all canonicalize to `lib/a.js` — an alias spelling must
  // never let two scopes for the same file slip past scopesConflict.
  const normalized = scope.split('/').filter((seg) => seg !== '' && seg !== '.').join('/');
  need(normalized.length > 0 && normalized !== '**', 'FILE_SCOPE_INVALID', 'file scope must name a path');
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
 * @throws {WaveSchedulerError} `CARS_REQUIRED`, `CAR_ID_INVALID` (see {@link isValidId}),
 *   `CAR_DUPLICATE`, `DEPENDENCY_INVALID`, `DEPENDENCY_UNKNOWN`, `DEPENDENCY_CYCLE`.
 */
function topologicalWaves(cars) {
  need(Array.isArray(cars) && cars.length > 0, 'CARS_REQUIRED', 'cars must be a non-empty list');
  const byId = new Map();
  for (const car of cars) {
    need(car && isValidId(car.id), 'CAR_ID_INVALID', `car id must match ${ID_PATTERN} and not be a built-in property name`);
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

/**
 * The Builder lanes a mechanical sharding plan spreads issues across when
 * the caller names none of its own (#3213, #3216 Pillar 1).
 * @type {ReadonlyArray<string>}
 */
const DEFAULT_FLEET_BUILDER_LANES = Object.freeze(['TC-Lane-A', 'TC-Lane-B', 'TC-Lane-C', 'TC-Lane-D']);

/**
 * The fleet's "Maximize safe parallelization" policy default (#3264,
 * V6-015) — ON for TangleClaw development, so {@link
 * validateParallelWavePlan}'s drift/capacity enforcement runs unless a
 * caller explicitly opts out. This constant is the MECHANICAL half of
 * the issue's policy setting; the persisted, UI-facing checkbox it also
 * asks for lives in a route/settings surface outside this module's file
 * envelope and is not implemented here (flagged, not silently dropped).
 * @type {boolean}
 */
const DEFAULT_MAXIMIZE_SAFE_PARALLELIZATION = true;

/**
 * Whether two file scopes (already belonging to Cars already run through
 * {@link normalizeScope} in {@link planParallelWaveShards}) could touch the
 * same file. Thin wrapper so a caller passing an already-normalized scope
 * does not pay {@link scopesConflict}'s own re-normalization twice; kept
 * private because nothing outside this module needs the distinction.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function _anyScopeConflicts(a, b) {
  return a.some((sa) => b.some((sb) => scopesConflict(sa, sb)));
}

/**
 * The one shape check for a `builderLanes` array, shared by {@link
 * planParallelWaveShards} and {@link validateParallelWavePlan} (#3213
 * R-Gate R1 BLOCKING 2, R3 BLOCKING 1) — a non-empty array of distinct,
 * non-empty-string lane names. Before the R1 fix, `validateParallelWavePlan`'s
 * own `builderLanes.length >= 2` guard let `builderLanes: []`, duplicate
 * entries, or anything malformed slip straight through as a plain "fewer
 * than 2 lanes, nothing to enforce" `ok: true`. Before THIS fix, a
 * single malformed entry (`['']`, `[null]`, `[{}]`) still slipped through
 * both the array-shape and uniqueness checks above: a one-element array
 * is trivially non-empty AND trivially has no duplicates, whatever that
 * one element actually is — the uniqueness check (`new Set(...).size`)
 * can only ever catch TWO OR MORE entries colliding, never a single
 * entry that was never a real lane name to begin with. The per-entry
 * check below runs before that uniqueness check specifically because a
 * malformed single entry would otherwise pass it by construction.
 * @param {*} builderLanes
 * @returns {void}
 * @throws {WaveSchedulerError} `BUILDER_LANES_REQUIRED`, `BUILDER_LANES_INVALID`, `BUILDER_LANES_DUPLICATE`.
 */
function _validateBuilderLanes(builderLanes) {
  need(Array.isArray(builderLanes) && builderLanes.length > 0, 'BUILDER_LANES_REQUIRED', 'builderLanes must be a non-empty array');
  for (const lane of builderLanes) {
    // #3213 R-Gate R3 BLOCKING 1 (R4): never serialize a caller-supplied
    // value for the error message — JSON.stringify throws its own native
    // TypeError on a BigInt or a circular object, which would crash
    // BEFORE need() ever got a chance to raise BUILDER_LANES_INVALID.
    // The type name alone is enough to diagnose "what's wrong here".
    need(typeof lane === 'string' && lane.trim().length > 0, 'BUILDER_LANES_INVALID',
      `builderLanes entries must be non-empty strings, got ${lane === null ? 'null' : typeof lane}`);
  }
  need(new Set(builderLanes).size === builderLanes.length, 'BUILDER_LANES_DUPLICATE', 'builderLanes must list distinct lane names');
}

/**
 * Mechanically shard a flat list of issues into file-disjoint, capacity-
 * bounded parallel waves (#3213 Mechanical Maximum Fleet Parallelization
 * Guard, #3216 Pillar 1) — the planning half `validateParallelWavePlan`
 * checks the result of, and `WaveScheduler#createRun` can enforce inline.
 *
 * Greedily walks each issue through the waves built so far, earliest
 * first, placing it in the first one with both a free lane
 * (`wave.length < builderLanes.length`) and no {@link scopesConflict}
 * against any Car already there. An issue that fits nowhere starts a new
 * wave. Only when an issue lands in anything OTHER than Wave 1 does it
 * gain a `dependsOn`: the Cars in the wave immediately before the one it
 * landed in that it actually conflicts with, or — when that wave had no
 * conflict but was simply full — every Car in it, since lane capacity is
 * itself a real constraint {@link topologicalWaves} has no notion of
 * except a dependency edge.
 *
 * @param {{issues: Array<{id: (string|number), fileScope: string[], title?: string,
 *   payload?: object, gate?: object}>, builderLanes?: string[], carPrefix?: string}} args
 * @returns {{waves: string[][], cars: object[], maxParallelLanes: number, waveParallelLanes: number[]}}
 * @throws {WaveSchedulerError} `ISSUES_REQUIRED`, `ISSUE_ID_REQUIRED`, `ISSUE_FILE_SCOPE_REQUIRED`,
 *   `BUILDER_LANES_REQUIRED`, `BUILDER_LANES_INVALID`, `BUILDER_LANES_DUPLICATE`, plus any {@link normalizeScope} refusal.
 */
function planParallelWaveShards({ issues, builderLanes = DEFAULT_FLEET_BUILDER_LANES, carPrefix = 'W' } = {}) {
  need(Array.isArray(issues) && issues.length > 0, 'ISSUES_REQUIRED', 'issues must be a non-empty array');
  _validateBuilderLanes(builderLanes);

  const waves = [];
  const cars = [];

  for (const issue of issues) {
    need(issue && (typeof issue.id === 'string' || typeof issue.id === 'number'), 'ISSUE_ID_REQUIRED', 'each issue needs an id');
    const fileScope = [...new Set((issue.fileScope || []).map(normalizeScope))].sort();
    need(fileScope.length > 0, 'ISSUE_FILE_SCOPE_REQUIRED', `issue ${issue.id} needs a non-empty fileScope`);

    let placedWave = waves.length;
    for (let w = 0; w < waves.length; w++) {
      const wave = waves[w];
      const hasConflict = wave.some((car) => _anyScopeConflicts(car.fileScope, fileScope));
      if (!hasConflict && wave.length < builderLanes.length) { placedWave = w; break; }
    }
    if (placedWave === waves.length) waves.push([]);

    let dependsOn = [];
    if (placedWave > 0) {
      const prevWave = waves[placedWave - 1];
      const conflicting = prevWave.filter((car) => _anyScopeConflicts(car.fileScope, fileScope));
      dependsOn = (conflicting.length > 0 ? conflicting : prevWave).map((car) => car.id);
    }

    const laneIndex = waves[placedWave].length;
    const carId = `${carPrefix}${placedWave + 1}-${String.fromCharCode(65 + laneIndex)}`;
    const car = {
      id: carId,
      fileScope,
      lane: builderLanes[laneIndex],
      dependsOn,
      payload: { ...(issue.payload || {}), issueId: issue.id, lane: builderLanes[laneIndex] }
    };
    if (issue.gate) car.gate = issue.gate;
    if (issue.title) car.title = issue.title;
    waves[placedWave].push(car);
    cars.push(car);
  }

  return {
    waves: waves.map((wave) => wave.map((car) => car.id)),
    cars,
    maxParallelLanes: builderLanes.length,
    waveParallelLanes: waves.map((wave) => wave.length)
  };
}

/**
 * How many issues `car` itself bundles, for {@link
 * validateParallelWavePlan}'s drift count when the caller didn't pass an
 * explicit `issueCount` (#3213 R-Gate R1 BLOCKING 1). A Car's bundled
 * issues live at `car.payload.issues` — the shape `payload: {
 * ...(issue.payload || {}) }` {@link planParallelWaveShards} actually
 * produces — checked first, falling back to a top-level `car.issues` for
 * a caller that builds its own Car objects directly. Either one PRESENT
 * but not an array is a malformed Car, not "no bundled issues": silently
 * defaulting to 1 there would risk UNDER-counting and letting real
 * single-stream drift pass the Guard unnoticed.
 * @param {object} car
 * @returns {number}
 */
function _bundledIssueCount(car) {
  const bundled = car.payload && 'issues' in car.payload ? car.payload.issues
    : 'issues' in car ? car.issues
    : undefined;
  if (bundled === undefined) return 1;
  need(Array.isArray(bundled), 'CAR_ISSUES_INVALID', `${car.id || 'a car'}'s bundled issues must be an array`, 400, { carId: car.id });
  return bundled.length || 1;
}

/**
 * Enforce the #3213 Mechanical Maximum Fleet Parallelization Guard against
 * an already-built Car graph: Wave 1 collapsing to a single Car while 2+
 * issues and 2+ Builder lanes were available is single-stream drift,
 * unless either an Operator/PM has explicitly attested a `serialReason`
 * for it, or every Car outside Wave 1 genuinely, pairwise {@link
 * scopesConflict}s with Wave 1's one Car — in which case Wave 1 could not
 * have held more than one Car regardless of lane capacity, and there is no
 * drift to excuse.
 *
 * `issueCount` lets a caller whose Cars don't carry `payload.issues`
 * state the real issue count directly; without it, a Car bundling
 * several issues into one `payload.issues` array is counted for all of
 * them, so a single Car covering 3 issues is not mistaken for 1.
 *
 * @param {{cars: object[], issueCount?: number, builderLanes?: string[], serialReason?: (string|null)}} args
 * @returns {{ok: true, waves: string[][], wave1ParallelCars: number, maxParallelLanes: number, serialReason: (string|null)}}
 * @throws {WaveSchedulerError} Any {@link topologicalWaves} refusal, plus `BUILDER_LANES_REQUIRED`,
 *   `BUILDER_LANES_DUPLICATE`, `BUILDER_LANES_INVALID`, `CAR_ISSUES_INVALID`, `SINGLE_STREAM_MULTI_ISSUE_DRIFT`.
 */
function validateParallelWavePlan({
  cars, issueCount, builderLanes = DEFAULT_FLEET_BUILDER_LANES, serialReason = null,
  maximizeSafeParallelization = DEFAULT_MAXIMIZE_SAFE_PARALLELIZATION, reviewCapacity = null
} = {}) {
  _validateBuilderLanes(builderLanes);
  const waves = topologicalWaves(cars);
  const effectiveIssueCount = Number.isInteger(issueCount)
    ? issueCount
    : cars.reduce((n, car) => n + _bundledIssueCount(car), 0);
  const hasAttestedReason = typeof serialReason === 'string' && serialReason.trim().length > 0;

  if (maximizeSafeParallelization && effectiveIssueCount >= 2 && builderLanes.length >= 2 && waves[0].length === 1) {
    if (!hasAttestedReason) {
      const wave1Car = cars.find((car) => car.id === waves[0][0]);
      const laterCars = waves.slice(1).flat().map((id) => cars.find((car) => car.id === id));
      const justifiedByConflict = laterCars.length > 0
        && laterCars.every((car) => _anyScopeConflicts(wave1Car.fileScope, car.fileScope));
      need(justifiedByConflict, 'SINGLE_STREAM_MULTI_ISSUE_DRIFT',
        `Wave 1 holds only ${waves[0].length} car for ${effectiveIssueCount} issues across ${builderLanes.length} available Builder lanes, ` +
        'with no attested serialReason and no genuine file-scope conflict justifying the serialization',
        400, { wave1ParallelCars: waves[0].length, effectiveIssueCount, maxParallelLanes: builderLanes.length });
    }
  }

  // #3264 (V6-015) acceptance criterion 2's "reviewer/integrator capacity"
  // dimension: a wave that dispatches more cars in parallel than there are
  // reviewers to clear them is drift of a different shape than the
  // single-stream check above (too MUCH parallelism, not too little) —
  // additive and opt-in via `reviewCapacity`, so every existing caller
  // that never passes it keeps today's behavior exactly.
  if (maximizeSafeParallelization && Number.isInteger(reviewCapacity) && reviewCapacity >= 0 && !hasAttestedReason) {
    const maxWaveParallelCars = Math.max(...waves.map((wave) => wave.length));
    need(maxWaveParallelCars <= reviewCapacity, 'REVIEW_CAPACITY_EXCEEDED',
      `A wave dispatches ${maxWaveParallelCars} parallel car(s), more than the available reviewer/integrator capacity (${reviewCapacity}), ` +
      'with no attested serialReason',
      400, { reviewCapacity, maxWaveParallelCars });
  }

  return {
    ok: true,
    waves,
    wave1ParallelCars: waves[0].length,
    maxParallelLanes: builderLanes.length,
    serialReason: hasAttestedReason ? serialReason.trim() : null,
    maximizeSafeParallelization: Boolean(maximizeSafeParallelization)
  };
}

/**
 * Whether an idle Builder lane may START `car` as a Zero-Clobber
 * Look-Ahead onto the next wave or next chartered train version while the
 * current wave's cars are still in review/CI (#3268, V6-019) — the three
 * criteria the issue states, checked in order, each named in the refusal
 * so a caller knows exactly which one failed.
 *
 * Covers only eligibility to START coding/branching; whether the result
 * may actually MERGE is a separate question (`mayMergeNow`) this function
 * answers but never enforces — the release-cut boundary is an ordering
 * fact a caller checks before running the merge itself, not something
 * that should block branching early, which is the whole point of
 * Look-Ahead (build now, merge after the gate).
 *
 * @param {{
 *   car: {id: string, dependsOn?: string[], fileScope: string[]},
 *   satisfiedCarIds?: string[],
 *   activeOrInReviewCars?: Array<{id: string, fileScope: string[]}>,
 *   carBaseSha: string,
 *   mainSha: string,
 *   releaseCutMerged?: boolean
 * }} args
 * @returns {{eligible: true, mayMergeNow: boolean}|{eligible: false, code: string, reason: string}}
 * @throws {WaveSchedulerError} `CAR_ID_INVALID` if `car.id` is missing/malformed,
 *   `LOOKAHEAD_MAIN_SHA_REQUIRED`/`LOOKAHEAD_BASE_SHA_REQUIRED` if either sha is
 *   omitted, or any {@link normalizeScope} refusal from a malformed `fileScope` entry.
 */
function validateLookAheadEligibility({
  car, satisfiedCarIds = [], activeOrInReviewCars = [], carBaseSha, mainSha, releaseCutMerged = false
} = {}) {
  need(car && isValidId(car.id), 'CAR_ID_INVALID', 'validateLookAheadEligibility needs a car with a valid id');
  need(typeof mainSha === 'string' && mainSha.length > 0, 'LOOKAHEAD_MAIN_SHA_REQUIRED',
    'mainSha is required to check the look-ahead car branches from current main');
  need(typeof carBaseSha === 'string' && carBaseSha.length > 0, 'LOOKAHEAD_BASE_SHA_REQUIRED',
    'carBaseSha is required to check the look-ahead car branches from current main');

  const dependsOn = Array.isArray(car.dependsOn) ? car.dependsOn : [];
  const unmet = dependsOn.filter((id) => !satisfiedCarIds.includes(id));
  if (unmet.length > 0) {
    return { eligible: false, code: 'LOOKAHEAD_DEPENDS_ON_UNMET', reason: `${car.id} depends on ${unmet.join(', ')}, not yet satisfied` };
  }

  const colliding = activeOrInReviewCars.find((other) => other.id !== car.id && _anyScopeConflicts(car.fileScope, other.fileScope));
  if (colliding) {
    return { eligible: false, code: 'LOOKAHEAD_SCOPE_CONFLICT', reason: `${car.id}'s file envelope intersects active/in-review car ${colliding.id}` };
  }

  if (carBaseSha !== mainSha) {
    return { eligible: false, code: 'LOOKAHEAD_STALE_BASE', reason: `${car.id} must branch from current main (${mainSha}), not ${carBaseSha}` };
  }

  return { eligible: true, mayMergeNow: releaseCutMerged === true };
}

/**
 * Whether an Operator-authorized exception record is well-formed: a
 * non-empty `grantedBy` and `reason`, and an `at` that parses as a real
 * date. Anything else is treated as NO exception (fail closed) rather
 * than thrown — a malformed exception object must never silently grant
 * one. Same shape and the same reasoning as
 * `lib/sprint-report-gate.js`'s own `_isValidException`, duplicated here
 * rather than imported: this module stays dependency-free of the Kaizen
 * ledger and the report gate (Wave 1 scope, Charter A624 — "this module
 * performs no action of its own").
 * @param {*} exception
 * @returns {boolean}
 */
function _isValidOperatorOverride(exception) {
  if (!exception || typeof exception !== 'object') return false;
  const { grantedBy, reason, at } = exception;
  return typeof grantedBy === 'string' && grantedBy.trim().length > 0
    && typeof reason === 'string' && reason.trim().length > 0
    && typeof at === 'string' && !Number.isNaN(Date.parse(at));
}

/**
 * Fail-closed Sprint-boundary Gate 0 check (#3324, Charter guardrail 05):
 * before Sprint N+1's Wave 1 Cars may be admitted, every prior Sprint's
 * open/due Kaizen item must carry a non-`'unreviewed'` Gate 0 disposition
 * — and a `'scheduled'` disposition additionally needs a linked issue,
 * rule, or charter-guardrail reference, since an unlinked "scheduled" is
 * indistinguishable from "noted and forgotten" — AND the prior Sprint's
 * own Gate 4 report must have settled. Both inputs are supplied already
 * resolved by the caller (`e5.gate0Feed(db, …)`'s rows;
 * `evaluateReportGate`/`evaluateTrainGate`'s `passed`) — this module reads
 * neither the Kaizen ledger nor a report itself, the same "caller resolves
 * the data" boundary {@link validateLookAheadEligibility} already draws.
 *
 * @param {{
 *   kaizenItems: Array<{finding_id?: string, id?: string, gate0_disposition: string,
 *     linked_issue_id?: (number|null), linked_rule_id?: (string|null), gate0_rationale?: (string|null)}>,
 *   priorSprintReportSettled: boolean,
 *   operatorOverride?: ({grantedBy: string, reason: string, at: string}|null)
 * }} args
 * @returns {{ok: true, operatorOverrideApplied: boolean}}
 * @throws {WaveSchedulerError} `KAIZEN_ITEMS_INVALID`, `KAIZEN_UNDISPOSITIONED`, `PRIOR_SPRINT_REPORT_UNSETTLED`.
 */
function evaluateGate0SprintBoundary({ kaizenItems, priorSprintReportSettled, operatorOverride = null } = {}) {
  if (_isValidOperatorOverride(operatorOverride)) return { ok: true, operatorOverrideApplied: true };

  need(Array.isArray(kaizenItems), 'KAIZEN_ITEMS_INVALID', 'kaizenItems must be an array');
  const undispositioned = kaizenItems.filter((item) => {
    if (!item || typeof item.gate0_disposition !== 'string') return true;
    if (item.gate0_disposition === 'unreviewed') return true;
    if (item.gate0_disposition === 'scheduled') {
      return !(item.linked_issue_id || item.linked_rule_id
        || (typeof item.gate0_rationale === 'string' && item.gate0_rationale.trim().length > 0));
    }
    return false;
  });
  need(undispositioned.length === 0, 'KAIZEN_UNDISPOSITIONED',
    `${undispositioned.length} prior-sprint Kaizen item(s) have no valid Gate 0 disposition`, 409,
    { items: undispositioned.map((item) => (item && (item.finding_id || item.id)) || null) });

  need(priorSprintReportSettled === true, 'PRIOR_SPRINT_REPORT_UNSETTLED',
    'the prior Sprint\'s Gate 4 report has not settled', 409);

  return { ok: true, operatorOverrideApplied: false };
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
    for (const row of this.db.prepare('SELECT id, state_json, created_at FROM v6_wave_runs ORDER BY id').all()) {
      const run = JSON.parse(row.state_json);
      // #3163 — a run whose `state_json` predates this column being read
      // (or was ever written without `createdAt`) left `GET /api/sprint-waves`
      // returning `createdAt: null` ("Invalid Date" in the UI) despite the
      // SQLite `created_at` column — `NOT NULL` since `ensureSchema` — always
      // having it. Only backfills when `state_json` itself is missing it;
      // a run that DOES carry its own `createdAt` keeps it unchanged.
      if (!run.createdAt) run.createdAt = row.created_at ?? run.updatedAt ?? null;
      runs[row.id] = run;
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
 * The lock key a Car's file-scope reservation is held under — unambiguous
 * for any pair of ids.
 * @param {string} runId
 * @param {string} carId
 * @returns {string}
 */
function lockKey(runId, carId) {
  // JSON, not `${runId}:${carId}`: a delimiter join lets run "a:b" + car
  // "c" and run "a" + car "b:c" share a key, so one could erase the
  // other's live lock. ID_PATTERN already forbids `:`; this encoding stays
  // unambiguous even if that pattern is ever widened.
  return JSON.stringify([runId, carId]);
}

/**
 * A Car in the store state, by own-property lookup only.
 * @param {{runs: object}} state
 * @param {string} runId
 * @param {string} carId
 * @returns {object|undefined}
 */
function carOf(state, runId, carId) {
  const run = own(state.runs, runId);
  return run ? own(run.cars, carId) : undefined;
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
   * @throws {WaveSchedulerError} Any {@link topologicalWaves} refusal, plus `RUN_ID_INVALID`, `FLEET_ID_REQUIRED`,
   *   `FILE_SCOPE_REQUIRED`, `FILE_SCOPE_INVALID`, `GATE_INVALID`, `STALL_INVALID`, `RUN_EXISTS`, and, when
   *   `metadata.enforceParallelSharding === true`, any {@link validateParallelWavePlan} refusal
   *   (`BUILDER_LANES_REQUIRED`, `BUILDER_LANES_INVALID`, `BUILDER_LANES_DUPLICATE`, `CAR_ISSUES_INVALID`, `SINGLE_STREAM_MULTI_ISSUE_DRIFT`),
   *   and, when `metadata.enforceGate0KaizenBoundary === true`, `GATE0_CHECK_REQUIRED` plus any
   *   {@link evaluateGate0SprintBoundary} refusal (`KAIZEN_ITEMS_INVALID`, `KAIZEN_UNDISPOSITIONED`, `PRIOR_SPRINT_REPORT_UNSETTLED`).
   */
  createRun({ id, fleetId, cars, metadata = {} }) {
    need(typeof fleetId === 'string' && fleetId, 'FLEET_ID_REQUIRED', 'fleetId is required');
    const runId = id || this.idFactory();
    need(isValidId(runId), 'RUN_ID_INVALID', `run id must match ${ID_PATTERN} and not be a built-in property name`);
    // #3213 Mechanical Maximum Fleet Parallelization Guard: opt-in, so every
    // existing caller that never set this metadata keeps today's behavior
    // exactly. `validateParallelWavePlan` throws its own WaveSchedulerError
    // on drift — this call makes that happen before anything is persisted.
    if (metadata && metadata.enforceParallelSharding === true) {
      validateParallelWavePlan({
        cars, issueCount: metadata.issueCount, builderLanes: metadata.builderLanes, serialReason: metadata.serialReason
      });
    }
    // #3324 Sprint-boundary Gate 0 check: opt-in (every existing caller that
    // never sets this metadata keeps today's behavior exactly), and the
    // caller supplies the already-resolved Kaizen/report-settlement facts —
    // this run never reads the ledger or a report itself (see
    // evaluateGate0SprintBoundary's own JSDoc).
    if (metadata && metadata.enforceGate0KaizenBoundary === true) {
      need(metadata.gate0Check && typeof metadata.gate0Check === 'object', 'GATE0_CHECK_REQUIRED',
        'metadata.gate0Check is required when enforceGate0KaizenBoundary is true');
      evaluateGate0SprintBoundary(metadata.gate0Check);
    }
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
      need(!own(state.runs, runId), 'RUN_EXISTS', `run ${runId} already exists`, 409);
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
    const run = own(this.store.read().runs, id);
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
   *   conflicts: Array<{carId: string, heldBy: {runId: string, carId: string}, scopes: string[]}>}}
   * @throws {WaveSchedulerError} `RUN_NOT_FOUND`.
   */
  dispatchReady(runId, dispatch = () => {}) {
    const events = [];
    const reserved = this.store.transaction((state) => {
      const run = own(state.runs, runId);
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
            const conflict = { carId, heldBy: { runId: collision[1].runId, carId: collision[1].carId }, scopes: car.fileScope };
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
          const stored = own(own(state.runs, runId) && own(state.runs, runId).cars, car.id);
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
      const car = carOf(state, runId, carId);
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
      const car = carOf(state, runId, carId);
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
      const car = carOf(state, runId, carId);
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
      const car = carOf(state, runId, carId);
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
      const run = own(state.runs, runId);
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
  DEFAULT_FLEET_BUILDER_LANES,
  DEFAULT_MAXIMIZE_SAFE_PARALLELIZATION,
  WaveSchedulerError,
  MemorySchedulerStore,
  SqliteSchedulerStore,
  WaveScheduler,
  ensureSchema,
  isValidId,
  lockKey,
  normalizeScope,
  scopesConflict,
  scopeWithin,
  topologicalWaves,
  planParallelWaveShards,
  validateParallelWavePlan,
  validateLookAheadEligibility,
  evaluateGate0SprintBoundary
};
