'use strict';

/*
 * v6.6.3 Wave 1 (Car V663-W1-C, #3264 / V6-015 & #3268 / V6-019).
 *
 * #3264 (V6-015): configurable fleet-level enforcement of maximum safe
 * concurrency — this file covers the MECHANICAL half (a
 * `maximizeSafeParallelization` flag gating `validateParallelWavePlan`'s
 * drift enforcement, plus a new reviewer/integrator-capacity dimension).
 * The issue's persisted, UI-facing checkbox is NOT covered — that lives
 * in a route/settings surface outside this car's envelope
 * (`lib/v6/c3-wave-scheduler.js`, `lib/roadmap-admission.js`), flagged in
 * the PR body rather than silently dropped.
 *
 * #3268 (V6-019): codifies Safe Sprint Look-Ahead eligibility
 * (`validateLookAheadEligibility`) — the three criteria the issue states,
 * each with its own refusal code so a caller knows exactly which failed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  WaveSchedulerError, DEFAULT_FLEET_BUILDER_LANES, DEFAULT_MAXIMIZE_SAFE_PARALLELIZATION,
  validateParallelWavePlan, validateLookAheadEligibility
} = require('../lib/v6/c3-wave-scheduler');

/**
 * Assert `fn` throws a WaveSchedulerError with `code`.
 * @param {Function} fn
 * @param {string} code
 */
function throwsCode(fn, code) {
  assert.throws(fn, (err) => err instanceof WaveSchedulerError && err.code === code, code);
}

/** Two independent (disjoint-scope) cars with no dependency edge — a plan that COULD run Wave 1 in parallel. */
const TWO_INDEPENDENT_CARS = [
  { id: 'W1-A', fileScope: ['lib/a.js'] },
  { id: 'W1-B', fileScope: ['lib/b.js'] }
];

describe('DEFAULT_MAXIMIZE_SAFE_PARALLELIZATION (#3264, V6-015)', () => {
  it('defaults ON for TangleClaw development', () => {
    assert.equal(DEFAULT_MAXIMIZE_SAFE_PARALLELIZATION, true);
  });
});

describe('validateParallelWavePlan: maximizeSafeParallelization gates the single-stream drift check (#3264)', () => {
  it('still refuses single-stream drift by default, unchanged from before this car', () => {
    throwsCode(() => validateParallelWavePlan({
      cars: [{ id: 'W1-A', fileScope: ['lib/a.js'] }, { id: 'W2-A', fileScope: ['lib/b.js'], dependsOn: ['W1-A'] }],
      issueCount: 2, builderLanes: DEFAULT_FLEET_BUILDER_LANES
    }), 'SINGLE_STREAM_MULTI_ISSUE_DRIFT');
  });

  it('skips the drift check entirely when maximizeSafeParallelization is false', () => {
    const res = validateParallelWavePlan({
      cars: [{ id: 'W1-A', fileScope: ['lib/a.js'] }, { id: 'W2-A', fileScope: ['lib/b.js'], dependsOn: ['W1-A'] }],
      issueCount: 2, builderLanes: DEFAULT_FLEET_BUILDER_LANES, maximizeSafeParallelization: false
    });
    assert.equal(res.ok, true);
    assert.equal(res.maximizeSafeParallelization, false);
  });

  it('reports the policy flag back in its result when left at the default', () => {
    const res = validateParallelWavePlan({ cars: TWO_INDEPENDENT_CARS, issueCount: 2, builderLanes: DEFAULT_FLEET_BUILDER_LANES });
    assert.equal(res.maximizeSafeParallelization, true);
  });
});

describe('validateParallelWavePlan: reviewer/integrator capacity (#3264 acceptance criterion 2)', () => {
  it('refuses a wave whose parallel car count exceeds reviewCapacity, with no attested reason', () => {
    throwsCode(() => validateParallelWavePlan({
      cars: TWO_INDEPENDENT_CARS, issueCount: 2, builderLanes: DEFAULT_FLEET_BUILDER_LANES, reviewCapacity: 1
    }), 'REVIEW_CAPACITY_EXCEEDED');
  });

  it('allows it through with an attested serialReason, same escape hatch as the drift check', () => {
    const res = validateParallelWavePlan({
      cars: TWO_INDEPENDENT_CARS, issueCount: 2, builderLanes: DEFAULT_FLEET_BUILDER_LANES,
      reviewCapacity: 1, serialReason: 'only one reviewer on call tonight'
    });
    assert.equal(res.ok, true);
  });

  it('is a no-op when the caller never passes reviewCapacity — every pre-#3264 caller keeps today\'s behavior exactly', () => {
    const res = validateParallelWavePlan({ cars: TWO_INDEPENDENT_CARS, issueCount: 2, builderLanes: DEFAULT_FLEET_BUILDER_LANES });
    assert.equal(res.ok, true);
  });

  it('is skipped entirely when maximizeSafeParallelization is false, even with reviewCapacity set', () => {
    const res = validateParallelWavePlan({
      cars: TWO_INDEPENDENT_CARS, issueCount: 2, builderLanes: DEFAULT_FLEET_BUILDER_LANES,
      reviewCapacity: 1, maximizeSafeParallelization: false
    });
    assert.equal(res.ok, true);
  });

  it('never enforces on a wave that genuinely fits within capacity', () => {
    const res = validateParallelWavePlan({ cars: TWO_INDEPENDENT_CARS, issueCount: 2, builderLanes: DEFAULT_FLEET_BUILDER_LANES, reviewCapacity: 2 });
    assert.equal(res.ok, true);
  });
});

describe('validateLookAheadEligibility (#3268, V6-019)', () => {
  const car = { id: 'V662-W1-D', dependsOn: [], fileScope: ['public/api-helper.js'] };

  it('eligible when all three criteria hold, and reports whether the release cut already merged', () => {
    const eligibleNotYetCut = validateLookAheadEligibility({
      car, activeOrInReviewCars: [{ id: 'V661-W1-C', fileScope: ['public/ui.js'] }],
      carBaseSha: 'abc123', mainSha: 'abc123', releaseCutMerged: false
    });
    assert.deepEqual(eligibleNotYetCut, { eligible: true, mayMergeNow: false });

    const eligibleAfterCut = validateLookAheadEligibility({
      car, activeOrInReviewCars: [], carBaseSha: 'abc123', mainSha: 'abc123', releaseCutMerged: true
    });
    assert.deepEqual(eligibleAfterCut, { eligible: true, mayMergeNow: true });
  });

  it('criterion 1: refuses with LOOKAHEAD_DEPENDS_ON_UNMET when a dependsOn prerequisite is not yet satisfied', () => {
    const res = validateLookAheadEligibility({
      car: { ...car, dependsOn: ['V661-W1-A', 'V661-W1-B'] }, satisfiedCarIds: ['V661-W1-A'],
      carBaseSha: 'abc123', mainSha: 'abc123'
    });
    assert.equal(res.eligible, false);
    assert.equal(res.code, 'LOOKAHEAD_DEPENDS_ON_UNMET');
    assert.match(res.reason, /V661-W1-B/);
  });

  it('is eligible once every dependsOn prerequisite IS satisfied', () => {
    const res = validateLookAheadEligibility({
      car: { ...car, dependsOn: ['V661-W1-A'] }, satisfiedCarIds: ['V661-W1-A'],
      carBaseSha: 'abc123', mainSha: 'abc123'
    });
    assert.equal(res.eligible, true);
  });

  it('criterion 2: refuses with LOOKAHEAD_SCOPE_CONFLICT when its file envelope intersects an active/in-review car, checked after dependsOn', () => {
    const res = validateLookAheadEligibility({
      car, activeOrInReviewCars: [{ id: 'V661-W1-X', fileScope: ['public/api-helper.js'] }],
      carBaseSha: 'abc123', mainSha: 'abc123'
    });
    assert.equal(res.eligible, false);
    assert.equal(res.code, 'LOOKAHEAD_SCOPE_CONFLICT');
    assert.match(res.reason, /V661-W1-X/);
  });

  it('a /** directory-scoped active car still conflicts, via the same scopesConflict semantics the rest of this module uses', () => {
    const res = validateLookAheadEligibility({
      car: { ...car, fileScope: ['lib/v6/c3-wave-scheduler.js'] },
      activeOrInReviewCars: [{ id: 'V661-W1-X', fileScope: ['lib/v6/**'] }],
      carBaseSha: 'abc123', mainSha: 'abc123'
    });
    assert.equal(res.eligible, false);
    assert.equal(res.code, 'LOOKAHEAD_SCOPE_CONFLICT');
  });

  it('criterion 3: refuses with LOOKAHEAD_STALE_BASE when the car did not branch from current main', () => {
    const res = validateLookAheadEligibility({ car, activeOrInReviewCars: [], carBaseSha: 'old-sha', mainSha: 'current-sha' });
    assert.equal(res.eligible, false);
    assert.equal(res.code, 'LOOKAHEAD_STALE_BASE');
    assert.match(res.reason, /current-sha/);
  });

  it('requires mainSha and carBaseSha — a caller that omits either gets a loud refusal, not a silently skipped check', () => {
    throwsCode(() => validateLookAheadEligibility({ car, activeOrInReviewCars: [], carBaseSha: 'abc123' }), 'LOOKAHEAD_MAIN_SHA_REQUIRED');
    throwsCode(() => validateLookAheadEligibility({ car, activeOrInReviewCars: [], mainSha: 'abc123' }), 'LOOKAHEAD_BASE_SHA_REQUIRED');
  });

  it('requires a valid car id', () => {
    throwsCode(() => validateLookAheadEligibility({ car: { fileScope: ['x'] }, carBaseSha: 'a', mainSha: 'a' }), 'CAR_ID_INVALID');
  });

  it('checks criteria in the documented order: an unmet dependency is reported even when the scope ALSO conflicts', () => {
    const res = validateLookAheadEligibility({
      car: { ...car, dependsOn: ['V661-W1-A'] }, satisfiedCarIds: [],
      activeOrInReviewCars: [{ id: 'V661-W1-X', fileScope: car.fileScope }],
      carBaseSha: 'abc123', mainSha: 'abc123'
    });
    assert.equal(res.code, 'LOOKAHEAD_DEPENDS_ON_UNMET', 'dependsOn is criterion 1 and must be checked first');
  });
});
