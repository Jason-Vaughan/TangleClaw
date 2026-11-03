'use strict';

// #1677 Slice 1 (v5.61.0 Car 61-C, Architect Ruling A1677): the PM Medusa
// toggle state reconciliation, via `lib/medusa-toggle-sync.js`. Pure
// functions throughout -- no real project.json or listener involved, since
// the module itself never reads either (the caller observes both and hands
// the values in).
//
// Also #2823 Slice 1 (Architect Ruling A2823 Completion Addendum): the
// lifecycleGeneration reconciliation for a `master.accessLevel` config
// patch, via `lib/master-authority.js#reconcileMasterAccessConfigPatch`.
// Shares this file per the Car 61-C envelope naming it for both issues.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mts = require('../lib/medusa-toggle-sync');
const masterAuthority = require('../lib/master-authority');

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

describe('reconcileMasterAccessConfigPatch (#2823)', () => {
  it('stamps lifecycleGeneration/updatedAt/updatedBy for an ordinary read-only -> write patch (Done-When 1)', () => {
    const next = masterAuthority.reconcileMasterAccessConfigPatch(
      { accessLevel: 'read-only' }, { accessLevel: 'write' }, { actor: 'operator' });
    assert.equal(next.accessLevel, 'write');
    assert.equal(next.lifecycleGeneration, 1);
    assert.equal(next.lifecycleUpdatedBy, 'operator');
    assert.match(next.lifecycleUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(masterAuthority.getAuthorityState({ master: next }).toggleState, 'read-write');
  });

  it('toggling back to read-only advances the generation again and returns toggleState: read-only (Done-When 2)', () => {
    const write = masterAuthority.reconcileMasterAccessConfigPatch(
      { accessLevel: 'read-only' }, { accessLevel: 'write' }, { actor: 'operator' });
    const back = masterAuthority.reconcileMasterAccessConfigPatch(write, { accessLevel: 'read-only' }, { actor: 'operator' });
    assert.equal(back.accessLevel, 'read-only');
    assert.equal(back.lifecycleGeneration, 2, 'the generation keeps advancing, never resets');
    assert.equal(masterAuthority.getAuthorityState({ master: back }).toggleState, 'read-only');
  });

  it('repairs a legacy config already at accessLevel: write with no lifecycleGeneration ever stamped', () => {
    // The gap #2823 actually reports, distinct from #2132's own fix (which
    // only ever fires on a VALUE CHANGE): a config that is ALREADY 'write'
    // with nothing ever stamped stays stuck forever, since nothing
    // re-triggers the fix for a value that never changes again.
    const legacy = { accessLevel: 'write' };
    assert.equal(masterAuthority.getAuthorityState({ master: legacy }).toggleState, 'read-only', 'precondition: stuck');
    const repaired = masterAuthority.reconcileMasterAccessConfigPatch(legacy, {}, { actor: 'operator' });
    assert.equal(repaired.accessLevel, 'write');
    assert.equal(repaired.lifecycleGeneration, 1);
    assert.equal(masterAuthority.getAuthorityState({ master: repaired }).toggleState, 'read-write');
  });

  it('is a no-op for a sound, unchanged config -- never re-stamps or advances the generation needlessly', () => {
    const sound = { accessLevel: 'write', lifecycleGeneration: 3, lifecycleUpdatedAt: '2026-01-01T00:00:00.000Z', lifecycleUpdatedBy: 'operator' };
    const result = masterAuthority.reconcileMasterAccessConfigPatch(sound, { engine: 'claude' });
    assert.equal(result.lifecycleGeneration, 3, 'unchanged -- no actor was even required');
    assert.equal(result.lifecycleUpdatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(result.engine, 'claude', 'the unrelated patch field still applies');
  });

  it('requires an actor only when a stamp is actually needed', () => {
    assert.throws(
      () => masterAuthority.reconcileMasterAccessConfigPatch({ accessLevel: 'read-only' }, { accessLevel: 'write' }, {}),
      /actor is required/
    );
    // No throw: nothing needed reconciling, so no actor was required.
    assert.doesNotThrow(() => masterAuthority.reconcileMasterAccessConfigPatch(
      { accessLevel: 'write', lifecycleGeneration: 1, lifecycleUpdatedAt: '2026-01-01T00:00:00.000Z', lifecycleUpdatedBy: 'operator' }, {}));
  });

  it('refuses an invalid accessLevel before attempting anything', () => {
    assert.throws(
      () => masterAuthority.reconcileMasterAccessConfigPatch({}, { accessLevel: 'bogus' }, { actor: 'operator' }),
      /accessLevel must be one of/
    );
  });

  it('refuses a corrupted lifecycleGeneration rather than silently repairing it', () => {
    assert.throws(
      () => masterAuthority.reconcileMasterAccessConfigPatch(
        { accessLevel: 'write', lifecycleGeneration: 'not-a-number' }, {}, { actor: 'operator' }),
      /lifecycleGeneration is corrupted/
    );
  });

  it('never mutates the caller\'s current or patch objects', () => {
    const current = { accessLevel: 'read-only' };
    const patch = { accessLevel: 'write' };
    masterAuthority.reconcileMasterAccessConfigPatch(current, patch, { actor: 'operator' });
    assert.deepEqual(current, { accessLevel: 'read-only' });
    assert.deepEqual(patch, { accessLevel: 'write' });
  });
});
