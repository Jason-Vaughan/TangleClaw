'use strict';

// #1677 Slice 1 (v5.61.0 Car 61-C, Architect Ruling A1677): the PM Medusa
// toggle state reconciliation, via `lib/medusa-toggle-sync.js`. Pure
// functions throughout -- no real project.json or listener involved, since
// the module itself never reads either (the caller observes both and hands
// the values in).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mts = require('../lib/medusa-toggle-sync');

describe('resolveMedusaToggleState', () => {
  it('never reports effectiveValue: true for a persisted-false project, whatever is running right now', () => {
    const r = mts.resolveMedusaToggleState({ persistedEnabled: false, persistedWake: false, runtimeListening: true });
    assert.equal(r.enabled.persistedValue, false);
    assert.equal(r.enabled.effectiveValue, false, 'effectiveValue must never be optimistic');
    assert.equal(r.enabled.drifted, true, 'a live listener against a false persisted value IS drift');
  });

  it('never reports effectiveValue: false for a persisted-true project just because nothing is listening yet', () => {
    const r = mts.resolveMedusaToggleState({ persistedEnabled: true, persistedWake: true, runtimeListening: false });
    assert.equal(r.enabled.effectiveValue, true);
    assert.equal(r.enabled.drifted, true, 'persisted true with nothing listening is still drift, reported honestly');
  });

  it('reports no drift when persisted and runtime agree, in either direction', () => {
    assert.equal(mts.resolveMedusaToggleState({ persistedEnabled: true, runtimeListening: true }).enabled.drifted, false);
    assert.equal(mts.resolveMedusaToggleState({ persistedEnabled: false, runtimeListening: false }).enabled.drifted, false);
  });

  it('reports drifted: false, not guessed, when runtimeListening was never observed', () => {
    const r = mts.resolveMedusaToggleState({ persistedEnabled: true });
    assert.equal(r.enabled.drifted, false);
  });

  it('defaults every field to false/false/false for empty or missing input, never throwing', () => {
    assert.deepEqual(mts.resolveMedusaToggleState(), {
      enabled: { persistedValue: false, effectiveValue: false, drifted: false },
      wake: { persistedValue: false, effectiveValue: false, drifted: false }
    });
    assert.deepEqual(mts.resolveMedusaToggleState({}), mts.resolveMedusaToggleState());
  });

  it('treats any non-true persisted value the same as false (never throws on a stray string/number)', () => {
    for (const bad of ['true', 1, null, undefined]) {
      assert.equal(mts.resolveMedusaToggleState({ persistedEnabled: bad }).enabled.persistedValue, false);
    }
  });

  it('wake has no runtime-drift signal in this slice -- it is always persisted-vs-persisted', () => {
    const r = mts.resolveMedusaToggleState({ persistedWake: true, runtimeListening: false });
    assert.equal(r.wake.persistedValue, true);
    assert.equal(r.wake.effectiveValue, true);
    assert.equal(r.wake.drifted, false);
  });
});

describe('syncMedusaToggleSettings', () => {
  it('applies a provided key and leaves an omitted one at its current value', () => {
    const next = mts.syncMedusaToggleSettings({ medusaEnabled: false, medusaWake: true }, { medusaEnabled: true });
    assert.deepEqual(next, { medusaEnabled: true, medusaWake: true });
  });

  it('applies both keys when both are provided', () => {
    const next = mts.syncMedusaToggleSettings({ medusaEnabled: false, medusaWake: false }, { medusaEnabled: true, medusaWake: true });
    assert.deepEqual(next, { medusaEnabled: true, medusaWake: true });
  });

  it('never mutates the caller\'s current object', () => {
    const current = { medusaEnabled: false, medusaWake: false };
    mts.syncMedusaToggleSettings(current, { medusaEnabled: true });
    assert.deepEqual(current, { medusaEnabled: false, medusaWake: false }, 'current must be read-only to this function');
  });

  it('refuses a non-boolean value for a provided key, naming which one', () => {
    assert.throws(() => mts.syncMedusaToggleSettings({}, { medusaEnabled: 'yes' }), /medusaEnabled must be a boolean/);
    assert.throws(() => mts.syncMedusaToggleSettings({}, { medusaWake: 1 }), /medusaWake must be a boolean/);
  });

  it('defaults current\'s own missing/non-true fields to false, same as resolveMedusaToggleState', () => {
    assert.deepEqual(mts.syncMedusaToggleSettings({}, {}), { medusaEnabled: false, medusaWake: false });
    assert.deepEqual(mts.syncMedusaToggleSettings(undefined, undefined), { medusaEnabled: false, medusaWake: false });
  });

  it('a no-op update (no keys provided) returns current unchanged', () => {
    const current = { medusaEnabled: true, medusaWake: false };
    assert.deepEqual(mts.syncMedusaToggleSettings(current, {}), current);
  });
});
