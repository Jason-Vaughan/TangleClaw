'use strict';

/**
 * Member-level engine fallback chains (#3271, V6-027, Car V664-W1-A) —
 * `lib/engine-fallback-chain.js`. `applyFallback`/`checkReturnToPrimary`'s
 * own tests stub `deps.switchSessionModel` for most cases (this file's job
 * is proving THIS module calls it correctly and updates chain state right,
 * not re-verifying `switchSessionModel`'s own internals — that module has
 * its own extensive test/model-switch.test.js); one real end-to-end test
 * at the bottom drives the actual `switchSessionModel` boundary-mode path,
 * the same deps shape test/model-switch.test.js's own suite uses.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const fallback = require('../lib/engine-fallback-chain');
const modelSwitch = require('../lib/model-switch');

let tmpDir;
let projectPath;
let project;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fallback-chain-'));
  store._setBasePath(tmpDir);
  store.init();
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fallback-chain-project-'));
  project = store.projects.create({ name: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`, path: projectPath });
});

const CHAIN = {
  primary: { engine: 'claude', model: 'claude-sonnet-5' },
  secondary: { engine: 'codex', model: 'gpt-6-luna' },
  tertiary: { engine: 'antigravity', model: 'ag-model-1' }
};

describe('setFallbackChain / getFallbackChain', () => {
  it('round-trips a stored chain', () => {
    assert.deepEqual(fallback.setFallbackChain(project.name, CHAIN), { ok: true, code: 'UPDATED' });
    const result = fallback.getFallbackChain(project.name);
    assert.equal(result.ok, true);
    assert.deepEqual(result.chain, CHAIN);
  });

  it('refuses INVALID_REQUEST when primary is missing', () => {
    assert.deepEqual(
      fallback.setFallbackChain(project.name, { secondary: CHAIN.secondary }),
      { ok: false, code: 'INVALID_REQUEST' }
    );
  });

  it('accepts a chain with only primary configured — secondary/tertiary are optional', () => {
    const result = fallback.setFallbackChain(project.name, { primary: CHAIN.primary });
    assert.equal(result.ok, true);
    assert.deepEqual(fallback.getFallbackChain(project.name).chain, { primary: CHAIN.primary, secondary: null, tertiary: null });
  });

  it('refuses PROJECT_NOT_FOUND for an unknown project', () => {
    assert.deepEqual(fallback.setFallbackChain('no-such-project', CHAIN), { ok: false, code: 'PROJECT_NOT_FOUND' });
    assert.deepEqual(fallback.getFallbackChain('no-such-project'), { ok: false, code: 'PROJECT_NOT_FOUND' });
  });

  it('a configured tier wins over the fleet default; an unconfigured tier falls back to it', () => {
    fallback.setFallbackChain(project.name, { primary: CHAIN.primary, secondary: CHAIN.secondary });
    const fleetDefault = { primary: { engine: 'fleet-primary', model: 'x' }, secondary: { engine: 'fleet-secondary', model: 'x' }, tertiary: { engine: 'fleet-tertiary', model: 'x' } };
    const result = fallback.getFallbackChain(project.name, {}, fleetDefault);
    assert.deepEqual(result.chain, { primary: CHAIN.primary, secondary: CHAIN.secondary, tertiary: fleetDefault.tertiary });
  });

  it('a project with no chain configured at all reads entirely from the fleet default', () => {
    const fleetDefault = { primary: { engine: 'fleet-primary', model: 'x' }, secondary: null, tertiary: null };
    assert.deepEqual(fallback.getFallbackChain(project.name, {}, fleetDefault).chain, fleetDefault);
  });
});

describe('evaluateFallbackTrigger', () => {
  it('triggers on a crash, taking priority over everything else', () => {
    assert.deepEqual(fallback.evaluateFallbackTrigger({ crashed: true, quotaExhausted: true }), { trigger: true, reason: fallback.TRIGGER_REASONS.ENGINE_CRASH });
  });

  it('triggers on quota exhaustion', () => {
    assert.deepEqual(fallback.evaluateFallbackTrigger({ quotaExhausted: true }), { trigger: true, reason: fallback.TRIGGER_REASONS.QUOTA_EXHAUSTED });
  });

  it('never triggers on a single launch timeout — "repeated" means at least the threshold', () => {
    assert.deepEqual(fallback.evaluateFallbackTrigger({ consecutiveLaunchTimeouts: 1 }), { trigger: false, reason: null });
  });

  it('triggers once consecutiveLaunchTimeouts reaches the default threshold (2)', () => {
    assert.deepEqual(fallback.evaluateFallbackTrigger({ consecutiveLaunchTimeouts: 2 }), { trigger: true, reason: fallback.TRIGGER_REASONS.LAUNCH_TIMEOUT });
  });

  it('triggers once consecutiveTurnTimeouts reaches the default threshold (2)', () => {
    assert.deepEqual(fallback.evaluateFallbackTrigger({ consecutiveTurnTimeouts: 2 }), { trigger: true, reason: fallback.TRIGGER_REASONS.TURN_TIMEOUT });
  });

  it('a custom threshold is honored', () => {
    assert.deepEqual(fallback.evaluateFallbackTrigger({ consecutiveLaunchTimeouts: 1 }, { launchTimeouts: 1 }), { trigger: true, reason: fallback.TRIGGER_REASONS.LAUNCH_TIMEOUT });
  });

  it('no trigger at all for a clean status', () => {
    assert.deepEqual(fallback.evaluateFallbackTrigger({}), { trigger: false, reason: null });
  });
});

describe('applyFallback', () => {
  it('falls over from primary to secondary, calling switchSessionModel with outage-takeover mode', async () => {
    fallback.setFallbackChain(project.name, CHAIN);
    let calledWith = null;
    const stub = async (name, opts) => { calledWith = { name, opts }; return { ok: true, mode: 'outage-takeover' }; };
    const result = await fallback.applyFallback(project.name, { reason: fallback.TRIGGER_REASONS.QUOTA_EXHAUSTED }, { switchSessionModel: stub });
    assert.equal(result.ok, true);
    assert.equal(result.tier, 'secondary');
    assert.equal(calledWith.name, project.name);
    assert.equal(calledWith.opts.engine, 'codex');
    assert.equal(calledWith.opts.model, 'gpt-6-luna');
    assert.equal(calledWith.opts.mode, 'outage-takeover');
    assert.match(calledWith.opts.reason, /quota-exhausted/);
    assert.deepEqual(fallback.getFallbackState(project.name).state.activeTier, 'secondary');
  });

  it('falls over from secondary to tertiary on a second failure', async () => {
    fallback.setFallbackChain(project.name, CHAIN);
    const stub = async () => ({ ok: true });
    await fallback.applyFallback(project.name, {}, { switchSessionModel: stub });
    const second = await fallback.applyFallback(project.name, {}, { switchSessionModel: stub });
    assert.equal(second.tier, 'tertiary');
  });

  it('reports CHAIN_EXHAUSTED once past tertiary', async () => {
    fallback.setFallbackChain(project.name, CHAIN);
    const stub = async () => ({ ok: true });
    await fallback.applyFallback(project.name, {}, { switchSessionModel: stub });
    await fallback.applyFallback(project.name, {}, { switchSessionModel: stub });
    const third = await fallback.applyFallback(project.name, {}, { switchSessionModel: stub });
    assert.deepEqual(third, { ok: false, code: 'CHAIN_EXHAUSTED' });
  });

  it('reports CHAIN_EXHAUSTED immediately when only primary is configured', async () => {
    fallback.setFallbackChain(project.name, { primary: CHAIN.primary });
    const result = await fallback.applyFallback(project.name, {}, { switchSessionModel: async () => ({ ok: true }) });
    assert.deepEqual(result, { ok: false, code: 'CHAIN_EXHAUSTED' });
  });

  it('skips a tier that has already exhausted its own retry budget', async () => {
    fallback.setFallbackChain(project.name, CHAIN);
    const flaky = async () => ({ ok: true });
    // `maxRetries` is `applyFallback`'s own 2nd (`args`) parameter, not a
    // `deps` key — exhaust secondary's retry budget with a ceiling of 1.
    await fallback.applyFallback(project.name, { maxRetries: 1 }, { switchSessionModel: flaky });
    // secondary's retryCounts is now 1, at the maxRetries:1 ceiling — a
    // caller re-evaluating from primary (e.g. after a manual reset) would
    // skip straight to tertiary. Simulate that by resetting activeTier to
    // primary without clearing retryCounts.
    const current = fallback.getFallbackState(project.name).state;
    store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), engineFallbackState: { ...current, activeTier: 'primary' } });
    const result = await fallback.applyFallback(project.name, { maxRetries: 1 }, { switchSessionModel: flaky });
    assert.equal(result.tier, 'tertiary', 'secondary was skipped — its retry budget was already spent');
  });

  it('propagates SWITCH_FAILED without updating state when switchSessionModel itself refuses', async () => {
    fallback.setFallbackChain(project.name, CHAIN);
    const failing = async () => ({ ok: false, code: 'SOME_REFUSAL' });
    const result = await fallback.applyFallback(project.name, {}, { switchSessionModel: failing });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SWITCH_FAILED');
    assert.equal(fallback.getFallbackState(project.name).state.activeTier, 'primary', 'state is untouched on a failed switch');
  });

  it('refuses PROJECT_NOT_FOUND for an unknown project', async () => {
    const result = await fallback.applyFallback('no-such-project', {}, { switchSessionModel: async () => ({ ok: true }) });
    assert.deepEqual(result, { ok: false, code: 'PROJECT_NOT_FOUND' });
  });
});

describe('checkReturnToPrimary', () => {
  it('is a no-op (ALREADY_PRIMARY) when the project never failed over', async () => {
    const result = await fallback.checkReturnToPrimary(project.name, { isPrimaryHealthy: () => true });
    assert.deepEqual(result, { ok: true, code: 'ALREADY_PRIMARY' });
  });

  it('reports PRIMARY_STILL_UNHEALTHY and touches nothing while primary has not recovered', async () => {
    fallback.setFallbackChain(project.name, CHAIN);
    await fallback.applyFallback(project.name, {}, { switchSessionModel: async () => ({ ok: true }) });
    let switchCalled = false;
    const result = await fallback.checkReturnToPrimary(project.name, {
      isPrimaryHealthy: () => false, switchSessionModel: async () => { switchCalled = true; return { ok: true }; }
    });
    assert.deepEqual(result, { ok: true, code: 'PRIMARY_STILL_UNHEALTHY' });
    assert.equal(switchCalled, false);
  });

  it('switches back to primary, in boundary mode, once isPrimaryHealthy reports true', async () => {
    fallback.setFallbackChain(project.name, CHAIN);
    await fallback.applyFallback(project.name, {}, { switchSessionModel: async () => ({ ok: true }) });
    let calledWith = null;
    const result = await fallback.checkReturnToPrimary(project.name, {
      isPrimaryHealthy: () => true,
      switchSessionModel: async (name, opts) => { calledWith = { name, opts }; return { ok: true }; }
    });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'RETURNED');
    assert.equal(calledWith.opts.engine, 'claude');
    assert.equal(calledWith.opts.mode, 'boundary');
    assert.match(calledWith.opts.reason, /return-to-primary/);
    assert.deepEqual(fallback.getFallbackState(project.name).state, { activeTier: 'primary', retryCounts: { secondary: 0, tertiary: 0 }, lastFailoverAt: null, lastFailoverReason: null });
  });

  it('defaults isPrimaryHealthy to false when omitted — never auto-returns on an unverified default', async () => {
    fallback.setFallbackChain(project.name, CHAIN);
    await fallback.applyFallback(project.name, {}, { switchSessionModel: async () => ({ ok: true }) });
    const result = await fallback.checkReturnToPrimary(project.name, {});
    assert.deepEqual(result, { ok: true, code: 'PRIMARY_STILL_UNHEALTHY' });
  });

  it('propagates SWITCH_FAILED without clearing failover state when the switch itself refuses', async () => {
    fallback.setFallbackChain(project.name, CHAIN);
    await fallback.applyFallback(project.name, {}, { switchSessionModel: async () => ({ ok: true }) });
    const result = await fallback.checkReturnToPrimary(project.name, {
      isPrimaryHealthy: () => true, switchSessionModel: async () => ({ ok: false, code: 'REFUSED' })
    });
    assert.equal(result.ok, false);
    assert.equal(fallback.getFallbackState(project.name).state.activeTier, 'secondary');
  });
});

describe('end-to-end: checkReturnToPrimary drives the REAL switchSessionModel (boundary mode)', () => {
  const target = () => ({
    getEngineProfile: () => ({
      id: 'fake', name: 'Fake',
      models: { flag: '--model', offered: ['claude-sonnet-5'], roster: { source: 'codex-models-cache' } }
    }),
    readFile: () => JSON.stringify({ fetched_at: new Date().toISOString(), models: [{ slug: 'claude-sonnet-5', display_name: 'Sonnet' }] })
  });

  it('a real boundary-mode switch via switchSessionModel actually updates projects.engine_id', async () => {
    fallback.setFallbackChain(project.name, { primary: { engine: 'fake', model: 'claude-sonnet-5' }, secondary: CHAIN.secondary });
    // Fast-forward the recorded state to "on secondary" without going
    // through applyFallback's own outage-takeover switch (out of scope for
    // this test — proven separately above).
    store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), engineFallbackState: { activeTier: 'secondary', retryCounts: { secondary: 1, tertiary: 0 }, lastFailoverAt: new Date().toISOString(), lastFailoverReason: 'test-setup' } });
    store.sessions.start({ projectId: project.id, engineId: 'codex', tmuxSession: 'x', primePrompt: null });

    const result = await fallback.checkReturnToPrimary(project.name, {
      ...target(),
      isPrimaryHealthy: () => true,
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      triggerWrap: (name, wopts) => ({ ok: true, lifecycleCompleted: true, sessionId: store.sessions.getActive(project.id).id }),
      killSession: () => ({ error: null }),
      launchSession: () => ({ error: null }),
      switchSessionModel: modelSwitch.switchSessionModel
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.code, 'RETURNED');
    assert.equal(store.projects.get(project.id).engineId, 'fake');
  });
});
