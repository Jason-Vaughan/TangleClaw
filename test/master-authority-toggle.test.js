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

// I-Gate Round 1 (#5757326704) + A1677 Completion Addendum (#6611205452):
// the richer object-input contract, alongside the original flat one above.
describe('resolveMedusaToggleState -- addendum contract (object input)', () => {
  it('reproduces the review\'s exact repro: persisted false/false, a live session override, and an unsaved draft', () => {
    const r = mts.resolveMedusaToggleState({
      persistedConfig: { medusaEnabled: false, medusaWake: false },
      runtimeListener: { enabled: true },
      draftForm: { medusaEnabled: true }
    });
    assert.equal(r.persistedEnabled, false, 'never masks persisted false as saved true');
    assert.equal(r.sessionOverrideActive, true);
    assert.equal(r.drifted, true);
    assert.ok(r.driftReasons.includes('session-override-enabled'));
    assert.ok(r.driftReasons.includes('draft-unsaved-enabled'));
  });

  it('effectiveEnabled/effectiveWake stay pinned to persisted, never to the live listener or an unsaved draft', () => {
    const r = mts.resolveMedusaToggleState({
      persistedConfig: { medusaEnabled: false, medusaWake: false },
      runtimeListener: { enabled: true },
      draftForm: { medusaEnabled: true, medusaWake: true }
    });
    assert.equal(r.effectiveEnabled, false);
    assert.equal(r.effectiveWake, false);
  });

  it('a live listener running BECAUSE persisted is already true is not reported as a session override', () => {
    const r = mts.resolveMedusaToggleState({
      persistedConfig: { medusaEnabled: true },
      runtimeListener: { enabled: true }
    });
    assert.equal(r.sessionOverrideActive, false, 'ordinary operation, not an override of anything');
    assert.equal(r.drifted, false);
  });

  it('intentional opt-out (false/false) with no listener and no draft is reported with zero drift', () => {
    const r = mts.resolveMedusaToggleState({ persistedConfig: { medusaEnabled: false, medusaWake: false } });
    assert.equal(r.drifted, false);
    assert.deepEqual(r.driftReasons, []);
  });

  it('a draft matching the persisted value is not reported as unsaved drift', () => {
    const r = mts.resolveMedusaToggleState({
      persistedConfig: { medusaEnabled: true, medusaWake: false },
      draftForm: { medusaEnabled: true, medusaWake: false }
    });
    assert.equal(r.drifted, false);
  });

  it('an empty/missing input dispatches to the object contract, not the flat one, and never throws', () => {
    assert.deepEqual(mts.resolveMedusaToggleState({ persistedConfig: {} }), {
      persistedEnabled: false, persistedWake: false, effectiveEnabled: false, effectiveWake: false,
      sessionOverrideActive: false, drifted: false, driftReasons: []
    });
  });

  // I-Gate Round 2 (#5757487201): the opposite mismatch direction -- an
  // explicitly observed listener OFF while persisted says on -- was
  // silently reported as drifted: false.
  it('reports drift when persisted enabled=true but the listener is explicitly observed off', () => {
    const r = mts.resolveMedusaToggleState({ persistedConfig: { medusaEnabled: true }, runtimeListener: { enabled: false } });
    assert.equal(r.persistedEnabled, true);
    assert.equal(r.effectiveEnabled, true, 'still pinned to persisted -- see the module\'s own invariant');
    assert.equal(r.sessionOverrideActive, false, 'nothing is incorrectly running -- this is not an override');
    assert.equal(r.drifted, true);
    assert.ok(r.driftReasons.includes('listener-off-while-persisted-enabled'));
  });

  it('still reports no drift for persisted=true with the listener explicitly observed on (ordinary operation)', () => {
    const r = mts.resolveMedusaToggleState({ persistedConfig: { medusaEnabled: true }, runtimeListener: { enabled: true } });
    assert.equal(r.drifted, false);
  });

  it('still reports no runtime-based drift when runtimeListener is omitted entirely (never observed, not "off")', () => {
    const r = mts.resolveMedusaToggleState({ persistedConfig: { medusaEnabled: true } });
    assert.equal(r.drifted, false, 'unobserved must not read the same as an explicit enabled: false');
  });
});

describe('syncMedusaToggleSettings -- addendum contract (object input)', () => {
  it('applies a patch over a persisted config via {persistedConfig, patch}', () => {
    const next = mts.syncMedusaToggleSettings({ persistedConfig: { medusaEnabled: false, medusaWake: true }, patch: { medusaEnabled: true } });
    assert.deepEqual(next, { medusaEnabled: true, medusaWake: true });
  });

  it('gives the identical result as the original two-argument contract for the same inputs', () => {
    const viaOriginal = mts.syncMedusaToggleSettings({ medusaEnabled: false }, { medusaWake: true });
    const viaAddendum = mts.syncMedusaToggleSettings({ persistedConfig: { medusaEnabled: false }, patch: { medusaWake: true } });
    assert.deepEqual(viaOriginal, viaAddendum);
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

  // I-Gate Round 1 (#5757326704) blocker: a patch-supplied lifecycleGeneration
  // let the monotonic generation regress instead of always advancing from
  // the trusted current record.
  it('never lets a patch-supplied lifecycleGeneration regress the trusted current one', () => {
    const current = { accessLevel: 'write', lifecycleGeneration: 5, lifecycleUpdatedAt: '2026-01-01T00:00:00.000Z', lifecycleUpdatedBy: 'operator' };
    const result = masterAuthority.reconcileMasterAccessConfigPatch(current, { lifecycleGeneration: 0 }, { actor: 'operator' });
    assert.equal(result.lifecycleGeneration, 5, 'nothing needed reconciling -- the bogus patch field is ignored outright');
  });

  it('advances from the trusted current generation, not a patch-supplied one, when a real change IS being reconciled', () => {
    const current = { accessLevel: 'write', lifecycleGeneration: 5, lifecycleUpdatedAt: '2026-01-01T00:00:00.000Z', lifecycleUpdatedBy: 'operator' };
    const result = masterAuthority.reconcileMasterAccessConfigPatch(
      current, { accessLevel: 'read-only', lifecycleGeneration: 0 }, { actor: 'operator' });
    assert.equal(result.lifecycleGeneration, 6, 'advanced from the real prior generation (5), never from the patch\'s 0');
  });

  it('never lets a patch smuggle in a forged lifecycleUpdatedBy/lifecycleUpdatedAt either', () => {
    const current = { accessLevel: 'write', lifecycleGeneration: 5, lifecycleUpdatedAt: '2026-01-01T00:00:00.000Z', lifecycleUpdatedBy: 'operator' };
    const result = masterAuthority.reconcileMasterAccessConfigPatch(
      current, { accessLevel: 'read-only', lifecycleUpdatedBy: 'forged-actor', lifecycleUpdatedAt: '2020-01-01T00:00:00.000Z' },
      { actor: 'the-real-operator' });
    assert.equal(result.lifecycleUpdatedBy, 'the-real-operator', 'only options.actor may ever name who authorized this');
    assert.notEqual(result.lifecycleUpdatedAt, '2020-01-01T00:00:00.000Z');
  });
});
