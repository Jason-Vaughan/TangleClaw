'use strict';

// #801 (Architect Ruling A801): the delivery-guarantee-gated opt-in
// auto-inject evaluator and deterministic swarm stats aggregation. Also
// covers #1784 (Ruling A1784, lib/test-duration-stats.js) per that
// ruling's own "tests... co-located in the authorized Car 60-C test
// files" -- this file and test/fleet-workload-view.test.js are the two
// files Car 60-C's envelope authorizes for #1784's tests.
//
// Every module under test is a pure library: no store, no route, no live
// session binding. Every assertion here drives the real exported function.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const stats = require('../lib/switchboard-swarm-stats');
const duration = require('../lib/test-duration-stats');

describe('switchboard-swarm-stats: evaluateAutoInjectEligibility (#801)', () => {
  const base = { sessionId: 's1', optedIn: true, liveSessionBindingVerified: true, wedged: false, ackTrackingActive: true };

  it('refuses a missing sessionId', () => {
    const r = stats.evaluateAutoInjectEligibility({ optedIn: true, liveSessionBindingVerified: true, wedged: false, ackTrackingActive: true });
    assert.equal(r.code, 'SWITCHBOARD_SWARM_STATS_INVALID');
  });

  it('refuses a non-boolean guarantee field', () => {
    const r = stats.evaluateAutoInjectEligibility({ ...base, wedged: 'no' });
    assert.equal(r.code, 'SWITCHBOARD_SWARM_STATS_INVALID');
  });

  it('refuses with SWITCHBOARD_AUTO_INJECT_DISABLED when the session never opted in', () => {
    const r = stats.evaluateAutoInjectEligibility({ ...base, optedIn: false });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SWITCHBOARD_AUTO_INJECT_DISABLED');
  });

  it('refuses with SWITCHBOARD_DELIVERY_GUARANTEE_UNMET when opted in but the binding is unverified', () => {
    const r = stats.evaluateAutoInjectEligibility({ ...base, liveSessionBindingVerified: false });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SWITCHBOARD_DELIVERY_GUARANTEE_UNMET');
  });

  it('refuses with SWITCHBOARD_DELIVERY_GUARANTEE_UNMET when opted in but wedged', () => {
    const r = stats.evaluateAutoInjectEligibility({ ...base, wedged: true });
    assert.equal(r.code, 'SWITCHBOARD_DELIVERY_GUARANTEE_UNMET');
  });

  it('refuses with SWITCHBOARD_DELIVERY_GUARANTEE_UNMET when opted in but ack-tracking is inactive', () => {
    const r = stats.evaluateAutoInjectEligibility({ ...base, ackTrackingActive: false });
    assert.equal(r.code, 'SWITCHBOARD_DELIVERY_GUARANTEE_UNMET');
  });

  it('allows auto-inject when opted in and every delivery-guarantee precondition holds', () => {
    const r = stats.evaluateAutoInjectEligibility(base);
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { sessionId: 's1', eligible: true });
  });

  it('the not-opted-in refusal takes priority over an also-unmet guarantee', () => {
    const r = stats.evaluateAutoInjectEligibility({ ...base, optedIn: false, wedged: true });
    assert.equal(r.code, 'SWITCHBOARD_AUTO_INJECT_DISABLED');
  });
});

describe('switchboard-swarm-stats: computeSwarmStats (#801)', () => {
  it('refuses a non-array exchanges', () => {
    assert.equal(stats.computeSwarmStats('nope').code, 'SWITCHBOARD_SWARM_STATS_INVALID');
  });

  it('refuses an exchange with no lane or an invalid state', () => {
    assert.equal(stats.computeSwarmStats([{ state: 'open' }]).code, 'SWITCHBOARD_SWARM_STATS_INVALID');
    assert.equal(stats.computeSwarmStats([{ lane: 's1', state: 'pending' }]).code, 'SWITCHBOARD_SWARM_STATS_INVALID');
  });

  it('returns zeroed, null-percentile stats for an empty exchange list', () => {
    const r = stats.computeSwarmStats([]);
    assert.equal(r.ok, true);
    assert.equal(r.stats.totalExchanges, 0);
    assert.equal(r.stats.ackLatencyMsP50, null);
    assert.equal(r.stats.ackLatencyMsP95, null);
    assert.deepEqual(r.stats.byLane, {});
  });

  it('computes fleet-wide totals, open count and owed count over a mixed batch', () => {
    const r = stats.computeSwarmStats([
      { lane: 's1', state: 'open', owed: true, ackLatencyMs: 100 },
      { lane: 's1', state: 'closed', owed: false, ackLatencyMs: 200 },
      { lane: 's2', state: 'open', owed: false, ackLatencyMs: null }
    ]);
    assert.equal(r.stats.totalExchanges, 3);
    assert.equal(r.stats.openExchanges, 2);
    assert.equal(r.stats.owedReplies, 1);
  });

  it('percentiles are computed only over exchanges with a non-null ackLatencyMs', () => {
    const r = stats.computeSwarmStats([
      { lane: 's1', state: 'closed', owed: false, ackLatencyMs: 10 },
      { lane: 's1', state: 'closed', owed: false, ackLatencyMs: 20 },
      { lane: 's1', state: 'closed', owed: false, ackLatencyMs: null }
    ]);
    assert.equal(r.stats.ackLatencyMsP50, 10);
    assert.equal(r.stats.ackLatencyMsP95, 20);
  });

  it('autoInjectEligibleCount / deliveryGuaranteeVerifiedCount count distinct lanes, not exchanges', () => {
    const r = stats.computeSwarmStats([
      { lane: 's1', state: 'open', owed: false, ackLatencyMs: null, autoInjectEligible: true, deliveryGuaranteeVerified: true },
      { lane: 's1', state: 'closed', owed: false, ackLatencyMs: null, autoInjectEligible: true, deliveryGuaranteeVerified: true },
      { lane: 's2', state: 'open', owed: false, ackLatencyMs: null }
    ]);
    assert.equal(r.stats.autoInjectEligibleCount, 1);
    assert.equal(r.stats.deliveryGuaranteeVerifiedCount, 1);
  });

  it('byLane carries each lane\'s own slice of the same stats shape', () => {
    const r = stats.computeSwarmStats([
      { lane: 's1', state: 'open', owed: true, ackLatencyMs: 50 },
      { lane: 's2', state: 'closed', owed: false, ackLatencyMs: 150 }
    ]);
    assert.deepEqual(Object.keys(r.stats.byLane).sort(), ['s1', 's2']);
    assert.equal(r.stats.byLane.s1.totalExchanges, 1);
    assert.equal(r.stats.byLane.s1.owedReplies, 1);
    assert.equal(r.stats.byLane.s2.owedReplies, 0);
  });
});

describe('test-duration-stats: exported vocabulary (#1784)', () => {
  it('exposes its own duration-source vocabulary and default staleness window', () => {
    assert.deepEqual(duration.DURATION_SOURCES, ['testament', 'ci', 'stage']);
    assert.equal(duration.DEFAULT_STALE_MS, 7 * 24 * 60 * 60 * 1000);
  });
});

describe('test-duration-stats: extractTestDuration (#1784)', () => {
  it('refuses an unrecognized source', () => {
    const r = duration.extractTestDuration({ source: 'jenkins', durationMs: 1000, recordedAt: '2026-11-03T12:00:00.000Z' });
    assert.equal(r.code, 'TEST_DURATION_INVALID');
  });

  it('refuses a non-finite or negative durationMs', () => {
    assert.equal(duration.extractTestDuration({ source: 'ci', durationMs: -1, recordedAt: '2026-11-03T12:00:00.000Z' }).code, 'TEST_DURATION_INVALID');
    assert.equal(duration.extractTestDuration({ source: 'ci', durationMs: NaN, recordedAt: '2026-11-03T12:00:00.000Z' }).code, 'TEST_DURATION_INVALID');
  });

  it('refuses an unparseable recordedAt', () => {
    const r = duration.extractTestDuration({ source: 'ci', durationMs: 1000, recordedAt: 'not-a-date' });
    assert.equal(r.code, 'TEST_DURATION_INVALID');
  });

  it('refuses a non-string commitSha when present', () => {
    const r = duration.extractTestDuration({ source: 'ci', durationMs: 1000, recordedAt: '2026-11-03T12:00:00.000Z', commitSha: 123 });
    assert.equal(r.code, 'TEST_DURATION_INVALID');
  });

  it('normalizes a valid record for each of the three named sources', () => {
    for (const source of duration.DURATION_SOURCES) {
      const r = duration.extractTestDuration({ source, durationMs: 5000, recordedAt: '2026-11-03T12:00:00.000Z' });
      assert.equal(r.ok, true, `source "${source}"`);
      assert.equal(r.duration.source, source);
      assert.equal(r.duration.commitSha, null);
    }
  });

  it('formats seconds, minutes+seconds, and hours+minutes correctly', () => {
    const seconds = duration.extractTestDuration({ source: 'ci', durationMs: 45000, recordedAt: '2026-11-03T12:00:00.000Z' });
    assert.equal(seconds.duration.formattedDuration, '45s');
    const minutes = duration.extractTestDuration({ source: 'ci', durationMs: 137000, recordedAt: '2026-11-03T12:00:00.000Z' });
    assert.equal(minutes.duration.formattedDuration, '2m 17s');
    const hours = duration.extractTestDuration({ source: 'ci', durationMs: 3723000, recordedAt: '2026-11-03T12:00:00.000Z' });
    assert.equal(hours.duration.formattedDuration, '1h 2m');
  });
});

describe('test-duration-stats: buildTestDurationStats (#1784)', () => {
  const extracted = duration.extractTestDuration({
    source: 'testament', durationMs: 122000, recordedAt: '2026-11-03T12:00:00.000Z', commitSha: 'abc123'
  }).duration;

  it('a null duration reports hasDuration false with a fallback label', () => {
    const r = duration.buildTestDurationStats(null);
    assert.deepEqual(r, { hasDuration: false, durationMs: null, displayLabel: 'No recorded duration', stale: false });
  });

  it('a matching currentCommitSha is not stale, regardless of age', () => {
    const r = duration.buildTestDurationStats(extracted, { currentCommitSha: 'abc123', now: '2027-01-01T00:00:00.000Z' });
    assert.equal(r.stale, false);
  });

  it('a mismatched currentCommitSha is stale, even if recorded moments ago', () => {
    const r = duration.buildTestDurationStats(extracted, { currentCommitSha: 'def456', now: '2026-11-03T12:00:01.000Z' });
    assert.equal(r.stale, true);
  });

  it('falls back to age-based staleness when no currentCommitSha is given', () => {
    const fresh = duration.buildTestDurationStats(extracted, { now: '2026-11-04T12:00:00.000Z' });
    assert.equal(fresh.stale, false);
    const stale = duration.buildTestDurationStats(extracted, { now: '2026-12-01T12:00:00.000Z' });
    assert.equal(stale.stale, true);
  });

  it('a custom staleMs overrides the default age threshold', () => {
    const r = duration.buildTestDurationStats(extracted, { now: '2026-11-03T13:00:01.000Z', staleMs: 60 * 60 * 1000 });
    assert.equal(r.stale, true);
  });

  it('carries durationMs and the formatted label through unchanged', () => {
    const r = duration.buildTestDurationStats(extracted, { currentCommitSha: 'abc123' });
    assert.equal(r.hasDuration, true);
    assert.equal(r.durationMs, 122000);
    assert.equal(r.displayLabel, '2m 2s');
  });
});
