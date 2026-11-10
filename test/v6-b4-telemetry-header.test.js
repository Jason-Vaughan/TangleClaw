'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const b4 = require('../lib/v6/b4-telemetry-header');

// v6 (#2983, V6-10 / B4, Car V60-T2-W1-B): the telemetry header's data
// model and the structural HIDE-means-HIDE-never-DISABLE invariant.

describe('assembleTelemetryBar (#2983 deliverable 1)', () => {
  it('assembles every declared metric with the given confidence', () => {
    const bar = b4.assembleTelemetryBar('global', {
      tokens: { value: 1234, confidence: 'observed' },
      quotaWindow: { value: '5h', confidence: 'estimated' }
    }, { now: () => 0 });
    assert.equal(bar.scope, 'global');
    assert.equal(bar.generatedAt, new Date(0).toISOString());
    assert.deepEqual(bar.metrics.tokens, { value: 1234, confidence: 'observed' });
    assert.deepEqual(bar.metrics.quotaWindow, { value: '5h', confidence: 'estimated' });
  });

  it('degrades a missing metric to unavailable rather than omitting it', () => {
    const bar = b4.assembleTelemetryBar('fleet', {});
    for (const key of b4.METRIC_KEYS) {
      assert.deepEqual(bar.metrics[key], { value: null, confidence: 'unavailable' });
    }
  });

  it('degrades a malformed confidence value to unavailable rather than trusting it', () => {
    const bar = b4.assembleTelemetryBar('global', { tokens: { value: 99, confidence: 'definitely-real' } });
    assert.deepEqual(bar.metrics.tokens, { value: null, confidence: 'unavailable' });
  });

  it('includes every metric #2983 names, in its own listed order', () => {
    assert.deepEqual(b4.METRIC_KEYS, [
      'tokens', 'quotaWindow', 'contextUtilization', 'activeSessions', 'health', 'pendingMedusaMessages', 'versionDrift'
    ]);
  });

  it('refuses an unknown scope', () => {
    assert.throws(() => b4.assembleTelemetryBar('not-a-real-scope', {}), RangeError);
  });

  it('supports both global and fleet scopes', () => {
    for (const scope of b4.SCOPES) {
      assert.equal(b4.assembleTelemetryBar(scope, {}).scope, scope);
    }
  });

  it('every metric confidence this module assigns is one of the declared CONFIDENCE_LEVELS', () => {
    const bar = b4.assembleTelemetryBar('global', { tokens: { value: 1, confidence: 'observed' } });
    for (const key of b4.METRIC_KEYS) {
      assert.ok(b4.CONFIDENCE_LEVELS.includes(bar.metrics[key].confidence), key);
    }
  });
});

describe('createTelemetryVisibility (#2983 deliverable 2 — HIDE means HIDE, never DISABLE)', () => {
  it('isCollecting is always true, before and after hiding a bar', () => {
    const vis = b4.createTelemetryVisibility();
    assert.equal(vis.isCollecting(), true);
    vis.setBarHidden('global', true);
    assert.equal(vis.isCollecting(), true);
  });

  it('isCollecting is always true regardless of per-metric configuration', () => {
    const vis = b4.createTelemetryVisibility();
    vis.setMetricVisible('fleet', 'tokens', false);
    assert.equal(vis.isCollecting(), true);
  });

  it('exposes no setter that could ever disable collection', () => {
    const vis = b4.createTelemetryVisibility();
    assert.equal(typeof vis.setCollecting, 'undefined');
    assert.equal(typeof vis.disable, 'undefined');
    assert.equal(typeof vis.stopCollecting, 'undefined');
    // isCollecting takes no arguments that could flip it false, and its
    // own return is a bare literal -- asserted again here as a structural
    // sanity check, not merely a behavioral one.
    assert.equal(vis.isCollecting.length, 0);
  });

  it('a hidden bar defaults to visible (not hidden) until explicitly hidden', () => {
    const vis = b4.createTelemetryVisibility();
    assert.equal(vis.isBarHidden('global'), false);
    vis.setBarHidden('global', true);
    assert.equal(vis.isBarHidden('global'), true);
    vis.setBarHidden('global', false);
    assert.equal(vis.isBarHidden('global'), false);
  });

  it('bar visibility is independent per scope', () => {
    const vis = b4.createTelemetryVisibility();
    vis.setBarHidden('global', true);
    assert.equal(vis.isBarHidden('global'), true);
    assert.equal(vis.isBarHidden('fleet'), false);
  });

  it('every metric is visible by default, and setMetricVisible toggles one off/on', () => {
    const vis = b4.createTelemetryVisibility();
    for (const key of b4.METRIC_KEYS) assert.equal(vis.isMetricVisible('global', key), true);
    vis.setMetricVisible('global', 'tokens', false);
    assert.equal(vis.isMetricVisible('global', 'tokens'), false);
    assert.equal(vis.isMetricVisible('global', 'quotaWindow'), true, 'toggling one metric does not affect others');
    vis.setMetricVisible('global', 'tokens', true);
    assert.equal(vis.isMetricVisible('global', 'tokens'), true);
  });

  it('respects a custom defaultVisibleMetrics list', () => {
    const vis = b4.createTelemetryVisibility({ defaultVisibleMetrics: ['tokens'] });
    assert.equal(vis.isMetricVisible('global', 'tokens'), true);
    assert.equal(vis.isMetricVisible('global', 'quotaWindow'), false);
  });

  it('refuses setMetricVisible for an unknown metric key', () => {
    const vis = b4.createTelemetryVisibility();
    assert.throws(() => vis.setMetricVisible('global', 'not-a-real-metric', true), RangeError);
  });

  it('per-metric visibility is independent per scope', () => {
    const vis = b4.createTelemetryVisibility();
    vis.setMetricVisible('global', 'tokens', false);
    assert.equal(vis.isMetricVisible('global', 'tokens'), false);
    assert.equal(vis.isMetricVisible('fleet', 'tokens'), true);
  });

  it('the returned controller is frozen (no new methods can be bolted on, including a disabling one)', () => {
    const vis = b4.createTelemetryVisibility();
    assert.ok(Object.isFrozen(vis));
  });
});
