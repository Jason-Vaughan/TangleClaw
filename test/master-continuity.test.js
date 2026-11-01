'use strict';

// #2120: pure evaluation module, no store/engine access of its own. Every
// test here passes a reading + optional overrides and checks the returned
// shape — nothing persists, nothing is mocked beyond the module under test.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mc = require('../lib/master-continuity');

describe('master-continuity', () => {
  describe('DEFAULTS / STATUSES', () => {
    it('exposes frozen defaults and the three status names', () => {
      assert.equal(Object.isFrozen(mc.DEFAULTS), true);
      assert.equal(mc.DEFAULTS.enabled, true);
      assert.equal(mc.DEFAULTS.criticalRemainingPercent <= mc.DEFAULTS.warningRemainingPercent, true);
      assert.deepEqual(mc.STATUSES, ['ok', 'warning', 'critical']);
    });
  });

  describe('resolveSettings', () => {
    it('returns the defaults untouched with no override', () => {
      const { settings, warning } = mc.resolveSettings();
      assert.deepEqual(settings, mc.DEFAULTS);
      assert.equal(warning, null);
    });

    it('merges a valid partial override over the defaults', () => {
      const { settings, warning } = mc.resolveSettings({ warningRemainingPercent: 40 });
      assert.equal(settings.warningRemainingPercent, 40);
      assert.equal(settings.criticalRemainingPercent, mc.DEFAULTS.criticalRemainingPercent);
      assert.equal(warning, null);
    });

    for (const bad of [
      null, 'nope', 42, [],
      { warningRemainingPercent: -1 },
      { warningRemainingPercent: 101 },
      { criticalRemainingPercent: 'x' },
      { enabled: 'yes' }
    ]) {
      it(`falls back to defaults with a warning on invalid override ${JSON.stringify(bad)}`, () => {
        const { settings, warning } = mc.resolveSettings(bad);
        assert.deepEqual(settings, mc.DEFAULTS);
        assert.ok(warning && warning.length > 0);
      });
    }

    it('refuses critical > warning even when each bound individually passes', () => {
      const { settings, warning } = mc.resolveSettings({ warningRemainingPercent: 20, criticalRemainingPercent: 50 });
      assert.deepEqual(settings, mc.DEFAULTS);
      assert.match(warning, /must not exceed/);
    });
  });

  describe('evaluateContinuityHealth', () => {
    it('reports disabled and does not evaluate a reading when enabled: false', () => {
      const out = mc.evaluateContinuityHealth({ remainingPercent: 1 }, { enabled: false });
      assert.equal(out.status, 'disabled');
      assert.equal(out.trigger, false);
      assert.equal(out.remainingPercent, null);
      assert.equal(out.protocol, null);
    });

    it('reports unmeasured when the reading has neither usable shape', () => {
      for (const reading of [undefined, null, {}, { paneBuffer: { usedBytes: 1 } }, { remainingPercent: 'x' }]) {
        const out = mc.evaluateContinuityHealth(reading);
        assert.equal(out.status, 'unmeasured');
        assert.equal(out.trigger, false);
        assert.equal(out.remainingPercent, null);
        assert.ok(out.reason);
      }
    });

    it('is ok above the warning threshold', () => {
      const out = mc.evaluateContinuityHealth({ remainingPercent: 31 });
      assert.equal(out.status, 'ok');
      assert.equal(out.trigger, false);
      assert.equal(out.remainingPercent, 31);
      assert.equal(out.source, 'reported');
      assert.equal(out.protocol, null);
    });

    it('is warning at and below the warning threshold, above critical', () => {
      for (const pct of [30, 16]) {
        const out = mc.evaluateContinuityHealth({ remainingPercent: pct });
        assert.equal(out.status, 'warning', `expected warning at ${pct}%`);
        assert.equal(out.trigger, true);
        assert.equal(out.protocol.transition, 'clear');
        assert.equal(out.protocol.schema, 'tangleclaw-continuity/v1');
      }
    });

    it('is critical at and below the critical threshold', () => {
      for (const pct of [15, 0]) {
        const out = mc.evaluateContinuityHealth({ remainingPercent: pct });
        assert.equal(out.status, 'critical', `expected critical at ${pct}%`);
        assert.equal(out.trigger, true);
        assert.equal(out.protocol.transition, 'wrap');
        assert.match(out.protocol.next_safe_action, /Prepare a continuity capsule now/);
      }
    });

    it('clamps an out-of-range reported percent into 0..100', () => {
      assert.equal(mc.evaluateContinuityHealth({ remainingPercent: -5 }).remainingPercent, 0);
      assert.equal(mc.evaluateContinuityHealth({ remainingPercent: 500 }).remainingPercent, 100);
    });

    it('estimates remainingPercent from a paneBuffer reading when no direct percent is given', () => {
      const out = mc.evaluateContinuityHealth({ paneBuffer: { usedBytes: 90, capacityBytes: 100 } });
      assert.equal(out.source, 'estimated');
      assert.equal(out.remainingPercent, 10);
      assert.equal(out.status, 'critical');
    });

    it('prefers a direct remainingPercent over a paneBuffer when both are given', () => {
      const out = mc.evaluateContinuityHealth({
        remainingPercent: 90,
        paneBuffer: { usedBytes: 99, capacityBytes: 100 }
      });
      assert.equal(out.source, 'reported');
      assert.equal(out.remainingPercent, 90);
      assert.equal(out.status, 'ok');
    });

    it('rejects a paneBuffer with zero or negative capacity as unmeasured, not a divide-by-zero', () => {
      const out = mc.evaluateContinuityHealth({ paneBuffer: { usedBytes: 10, capacityBytes: 0 } });
      assert.equal(out.status, 'unmeasured');
    });

    it('honors a caller override end to end (custom thresholds change the verdict)', () => {
      const out = mc.evaluateContinuityHealth({ remainingPercent: 50 }, { warningRemainingPercent: 60, criticalRemainingPercent: 10 });
      assert.equal(out.status, 'warning');
      assert.deepEqual(out.thresholds, { warningRemainingPercent: 60, criticalRemainingPercent: 10 });
    });

    it('carries a settings warning through even when the reading itself is fine', () => {
      const out = mc.evaluateContinuityHealth({ remainingPercent: 90 }, { warningRemainingPercent: -1 });
      assert.equal(out.status, 'ok');
      assert.ok(out.settingsWarning);
    });
  });
});
