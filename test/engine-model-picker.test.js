'use strict';

/*
 * #2188 — the Model + Effort picker.
 *
 * `test/engine-models.test.js` already pins the model axis in full. This
 * file covers what car 5740-W2-C-PR added on top of it: the reasoning-effort
 * axis in `lib/engine-models.js` and `lib/engines.js`'s `ENGINE_EFFORT`, its
 * launch-time application in `lib/sessions.js#_buildLaunchCommand` (and the
 * dedup-replace guard), and the `lib/projects.js` persistence wiring for
 * `effort` — the same three properties the model axis leans on, one axis
 * over: nothing malformed reaches a roster or a command, an effort level is
 * selectable only when the engine (and, for a `perModel` engine, the model)
 * actually offers it, and an unconfirmed answer is a refusal with a code.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const models = require('../lib/engine-models');
const engines = require('../lib/engines');
const sessions = require('../lib/sessions');
const store = require('../lib/store');
const profileReconciler = require('../lib/profile-reconciler');
const { setLevel } = require('../lib/logger');
const { loadEsc } = require('./helpers/lift');

setLevel('error');

const NOW = Date.parse('2026-11-09T21:00:00Z');

/**
 * Reader seams over a Codex models-cache holding the given models, mirroring
 * `test/engine-models.test.js`'s own `cache()` fixture.
 * @param {Array<object>} cached - `models` entries
 * @returns {object}
 */
function cache(cached) {
  return {
    now: () => NOW,
    env: {},
    homedir: () => '/home/op',
    readFile: () => JSON.stringify({ fetched_at: '2026-11-09T20:00:00Z', models: cached })
  };
}

/** One Codex model-cache entry with the reasoning levels this file exercises. */
const SOL = {
  slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol',
  default_reasoning_level: 'low',
  supported_reasoning_levels: [
    { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }
  ]
};
const LUNA = {
  slug: 'gpt-6-luna', display_name: 'GPT-6-Luna',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }]
};

/** A Codex-shaped profile carrying both model and effort blocks, like `engines.resolveProfile('codex')` returns. */
function codexProfile(overrides = {}) {
  return {
    id: 'codex', name: 'Codex',
    models: { flag: '--model', offered: ['gpt-5.6-sol', 'gpt-6-luna'], roster: { source: 'codex-models-cache' } },
    effort: { mode: 'config', configKey: 'model_reasoning_effort', perModel: true },
    ...overrides
  };
}

/** A Claude-shaped profile with a static, engine-wide effort block. */
function claudeProfile(overrides = {}) {
  return {
    id: 'claude', name: 'Claude Code',
    effort: { mode: 'flag', flag: '--effort', offered: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ...overrides
  };
}

describe('#2188 engine-model-picker — effort axis', () => {
  describe('isWellFormedEffortId', () => {
    it('accepts the lowercase levels every CLI actually uses', () => {
      for (const id of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
        assert.equal(models.isWellFormedEffortId(id), true, id);
      }
    });

    it('refuses anything a shell or a CLI config value could read as something else', () => {
      const bad = ['', 'High', 'LOW', ' low', 'low;id', '$(id)', '`id`', "low'", 'low"', 'a=b', 'a b', '-c', '--effort', 'x'.repeat(22)];
      for (const id of bad) assert.equal(models.isWellFormedEffortId(id), false, JSON.stringify(id));
      for (const id of [null, undefined, 7, {}, ['low'], true]) assert.equal(models.isWellFormedEffortId(id), false);
    });
  });

  describe('validateEffortBlock', () => {
    it('accepts an absent block — that engine simply offers no effort selection', () => {
      assert.deepEqual(models.validateEffortBlock(undefined), []);
      assert.deepEqual(models.validateEffortBlock(null), []);
    });

    it('accepts a well-formed flag block and a well-formed config block', () => {
      assert.deepEqual(models.validateEffortBlock({ mode: 'flag', flag: '--effort', offered: ['low', 'high'] }), []);
      assert.deepEqual(models.validateEffortBlock({ mode: 'config', configKey: 'model_reasoning_effort', perModel: true }), []);
    });

    it('rejects an unknown mode', () => {
      assert.deepEqual(models.validateEffortBlock({ mode: 'bogus', offered: ['low'] }), ['effort.mode must be "flag" or "config"']);
    });

    it('rejects a flag block with a malformed flag', () => {
      const errs = models.validateEffortBlock({ mode: 'flag', flag: 'effort', offered: ['low'] });
      assert.ok(errs[0].includes('effort.flag must be a CLI flag'));
    });

    it('rejects a config block with a malformed configKey', () => {
      const errs = models.validateEffortBlock({ mode: 'config', configKey: 'Model Reasoning!', perModel: true });
      assert.ok(errs[0].includes('effort.configKey must be a config key'));
    });

    it('requires a non-empty offered list unless perModel is true', () => {
      assert.ok(models.validateEffortBlock({ mode: 'flag', flag: '--effort', offered: [] })[0].includes('offered must list'));
      assert.deepEqual(models.validateEffortBlock({ mode: 'config', configKey: 'x', perModel: true }), []);
    });

    it('rejects a malformed or duplicated offered id', () => {
      assert.ok(models.validateEffortBlock({ mode: 'flag', flag: '--effort', offered: ['LOW'] })[0].includes('not a valid effort level'));
      assert.ok(models.validateEffortBlock({ mode: 'flag', flag: '--effort', offered: ['low', 'low'] })[0].includes('lists an effort level twice'));
    });
  });

  describe('effortSelectionState', () => {
    it('reads none for a profile with no effort block', () => {
      assert.deepEqual(models.effortSelectionState({ id: 'antigravity' }), { state: 'none' });
    });

    it('reads ok for a usable block', () => {
      assert.deepEqual(models.effortSelectionState(claudeProfile()), { state: 'ok' });
    });

    it('reads invalid, with reasons, for a broken block — never silently "none"', () => {
      const state = models.effortSelectionState({ id: 'x', effort: { mode: 'flag', flag: '--effort', offered: [] } });
      assert.equal(state.state, 'invalid');
      assert.ok(state.errors[0].includes('offered must list'));
    });
  });

  describe('offeredEffortsWithAvailability — static (Claude-shaped)', () => {
    it('every offered level comes back available, with no roster to check', () => {
      const r = models.offeredEffortsWithAvailability(claudeProfile(), null);
      assert.equal(r.state, 'ok');
      assert.equal(r.perModel, false);
      assert.deepEqual(r.levels.map((l) => l.id), ['low', 'medium', 'high', 'xhigh', 'max']);
      assert.ok(r.levels.every((l) => l.available === true));
    });

    it('a model id is accepted but ignored — static effort does not vary by model', () => {
      const r = models.offeredEffortsWithAvailability(claudeProfile(), 'claude-opus-5-5');
      assert.equal(r.levels.length, 5);
    });
  });

  describe('offeredEffortsWithAvailability — perModel (Codex-shaped)', () => {
    it('with no model given, answers an empty list rather than guessing one', () => {
      const r = models.offeredEffortsWithAvailability(codexProfile(), null, cache([SOL, LUNA]));
      assert.equal(r.state, 'ok');
      assert.equal(r.perModel, true);
      assert.deepEqual(r.levels, []);
    });

    it('reads the SELECTED model\'s own levels, which differ model to model', () => {
      const sol = models.offeredEffortsWithAvailability(codexProfile(), 'gpt-5.6-sol', cache([SOL, LUNA]));
      assert.deepEqual(sol.levels.map((l) => l.id), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
      assert.equal(sol.defaultLevel, 'low');

      const luna = models.offeredEffortsWithAvailability(codexProfile(), 'gpt-6-luna', cache([SOL, LUNA]));
      assert.deepEqual(luna.levels.map((l) => l.id), ['low', 'medium', 'high', 'xhigh', 'max']);
      assert.equal(luna.defaultLevel, 'medium');
    });

    it('answers an empty list when the roster cannot be read, rather than throwing', () => {
      const unreadable = { now: () => NOW, env: {}, homedir: () => '/home/op', readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } };
      const r = models.offeredEffortsWithAvailability(codexProfile(), 'gpt-5.6-sol', unreadable);
      assert.deepEqual(r.levels, []);
    });

    it('answers an empty list for a model the roster does not list', () => {
      const r = models.offeredEffortsWithAvailability(codexProfile(), 'gpt-unknown', cache([SOL]));
      assert.deepEqual(r.levels, []);
    });
  });

  describe('checkEffortSelection', () => {
    it('refuses a malformed effort id before anything else', () => {
      const r = models.checkEffortSelection(claudeProfile(), null, 'HIGH');
      assert.equal(r.ok, false);
      assert.equal(r.code, 'EFFORT_MALFORMED');
    });

    it('refuses an engine with no effort block', () => {
      const r = models.checkEffortSelection({ id: 'antigravity', name: 'Antigravity' }, null, 'low');
      assert.equal(r.code, 'ENGINE_HAS_NO_EFFORT');
    });

    it('refuses an engine whose effort block is invalid', () => {
      const r = models.checkEffortSelection({ id: 'x', name: 'X', effort: { mode: 'flag', flag: '--effort', offered: [] } }, null, 'low');
      assert.equal(r.code, 'EFFORT_BLOCK_INVALID');
    });

    it('static (Claude-shaped): accepts an offered level, refuses one that is not offered', () => {
      assert.equal(models.checkEffortSelection(claudeProfile(), null, 'xhigh').ok, true);
      assert.equal(models.checkEffortSelection(claudeProfile(), null, 'ultra').code, 'EFFORT_NOT_OFFERED');
    });

    it('perModel (Codex-shaped): refuses with no model to anchor the level to', () => {
      const r = models.checkEffortSelection(codexProfile(), null, 'high', cache([SOL]));
      assert.equal(r.code, 'EFFORT_NEEDS_MODEL');
    });

    it('perModel: refuses when the roster cannot be read', () => {
      const unreadable = { now: () => NOW, env: {}, homedir: () => '/home/op', readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } };
      const r = models.checkEffortSelection(codexProfile(), 'gpt-5.6-sol', 'high', unreadable);
      assert.equal(r.code, 'ROSTER_UNAVAILABLE');
    });

    it('perModel: refuses a model the roster does not list', () => {
      const r = models.checkEffortSelection(codexProfile(), 'gpt-unknown', 'high', cache([SOL]));
      assert.equal(r.code, 'MODEL_NOT_FOUND');
    });

    it('perModel: accepts a level the model offers, refuses "ultra" for a model that caps at "max"', () => {
      assert.equal(models.checkEffortSelection(codexProfile(), 'gpt-5.6-sol', 'ultra', cache([SOL, LUNA])).ok, true);
      const r = models.checkEffortSelection(codexProfile(), 'gpt-6-luna', 'ultra', cache([SOL, LUNA]));
      assert.equal(r.code, 'EFFORT_NOT_OFFERED');
      assert.ok(r.reason.includes('gpt-6-luna'));
    });
  });

  describe('effortArgv', () => {
    it('flag mode: two bare, unquoted elements', () => {
      assert.deepEqual(models.effortArgv(claudeProfile(), 'high'), ['--effort', 'high']);
    });

    it('config mode: a `-c key=value` pair, unquoted — the Codex launch path has no dedicated flag', () => {
      assert.deepEqual(models.effortArgv(codexProfile(), 'xhigh'), ['-c', 'model_reasoning_effort=xhigh']);
    });

    it('throws rather than launch silently without the effort level asked for', () => {
      assert.throws(() => models.effortArgv({ id: 'x' }, 'low'), /no effort settings/);
      assert.throws(() => models.effortArgv(claudeProfile(), 'HIGH'), /not a valid effort id/);
    });
  });
});

describe('#2188 engine-model-picker — lib/engines.js ENGINE_EFFORT attachment', () => {
  // `engines.resolveProfile` reads `store.engines`, which is populated from a
  // PER-BASEPATH copy of the bundled profiles (`lib/store.js`'s
  // `_syncBundledEngines`), not read directly from `data/engines/*.json` —
  // own `before`/`after` here, the same pattern `test/engines.test.js`'s own
  // top-level describe uses, rather than trusting whatever ambient state an
  // EARLIER file in the same `node --test` process happened to leave behind.
  // Running this file alone (or via the testament pool's own "small" tier
  // selection) never exercised that dependency; CI's full-suite run, where
  // some other file's own basePath/init churn runs first, did (#2974 Round
  // 2, CI run 42708349085: `effortSelectionState` read `none` instead of
  // `ok` because `store.engines.get('codex'/'claude')` answered nothing).
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-effort-attach-'));
    store._setBasePath(tmpDir);
    store.init();
  });
  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('attaches a usable effort block to claude and codex', () => {
    const claude = engines.resolveProfile('claude');
    assert.equal(models.effortSelectionState(claude).state, 'ok');
    const codex = engines.resolveProfile('codex');
    assert.equal(models.effortSelectionState(codex).state, 'ok');
    assert.equal(codex.effort.perModel, true);
  });

  it('attaches nothing to antigravity — its live catalog bakes effort into some model ids, a product question not resolved here', () => {
    const agy = engines.resolveProfile('antigravity');
    if (agy) assert.equal(models.effortSelectionState(agy).state, 'none');
  });

  it('never mutates the underlying cached profile object', () => {
    const before1 = engines.resolveProfile('claude');
    const before2 = engines.resolveProfile('claude');
    assert.notEqual(before1, before2, 'resolveProfile must return a fresh object when it merges in effort, never a shared mutated one');
    assert.deepEqual(before1.effort, before2.effort);
  });
});

describe('#2188 engine-model-picker — _buildLaunchCommand effort application', () => {
  it('appends the flag form for a Claude-shaped profile', () => {
    const cmd = sessions._buildLaunchCommand(claudeProfile({ launch: { shellCommand: 'claude', args: [], env: {} } }), null, null, null, 'high');
    assert.equal(cmd, 'claude --effort high');
  });

  it('appends the config-override form for a Codex-shaped profile', () => {
    const cmd = sessions._buildLaunchCommand(codexProfile({ launch: { shellCommand: 'codex', args: [], env: {} } }), null, null, null, 'xhigh');
    assert.equal(cmd, 'codex -c model_reasoning_effort=xhigh');
  });

  it('model and effort compose in one command', () => {
    const profile = codexProfile({
      launch: { shellCommand: 'codex', args: [], env: {} },
      models: { flag: '--model', offered: ['gpt-5.6-sol'], roster: { source: 'codex-models-cache' } }
    });
    const cmd = sessions._buildLaunchCommand(profile, null, null, 'gpt-5.6-sol', 'high');
    assert.equal(cmd, 'codex --model gpt-5.6-sol -c model_reasoning_effort=high');
  });

  it('REPLACES a pre-existing effort argument in the base launch args rather than duplicating it', () => {
    const flagProfile = claudeProfile({ launch: { shellCommand: 'claude', args: ['--effort', 'high', '--verbose'], env: {} } });
    assert.equal(sessions._buildLaunchCommand(flagProfile, null, null, null, 'medium'), 'claude --verbose --effort medium');

    const configProfile = codexProfile({ launch: { shellCommand: 'codex', args: ['-c', 'model_reasoning_effort=medium', '--yolo'], env: {} } });
    assert.equal(sessions._buildLaunchCommand(configProfile, null, null, null, 'low'), 'codex --yolo -c model_reasoning_effort=low');
  });

  it('no effort argument at all when none was requested', () => {
    const cmd = sessions._buildLaunchCommand(claudeProfile({ launch: { shellCommand: 'claude', args: [], env: {} } }), null, null, null, null);
    assert.equal(cmd, 'claude');
  });
});

describe('#2188 engine-model-picker — effort preserved through post-launch verification (PRR-A R1 catch on PR #2974)', () => {
  beforeEach(() => { profileReconciler._resetForTests(); });

  /** A fake `readTrustedActiveProfile` seam answering a fixed `{engine, model}` observation, never carrying `effort`/`mode` — exactly what the real Claude/Codex readers do today. */
  function fakeObserved(profile) {
    return async () => profile;
  }

  it('setDesiredProfile at launch, then at verification, both carry effort — the second call must not wipe the first', async () => {
    const resourceId = 'session:9500';
    profileReconciler.setDesiredProfile(resourceId, { engine: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
    await sessions._verifyModelAfterLaunch('tmux-c4-1', 9500, 1, 'codex', 'gpt-5.6-sol', {
      stillValid: () => true, readTrustedActiveProfile: fakeObserved({ engine: 'codex', model: 'gpt-5.6-sol' })
    }, 'high');
    assert.equal(profileReconciler.getDesiredProfile(resourceId).effort, 'high',
      'the verification call replaced the whole record (setDesiredProfile does not merge) — effort must be re-stated, not omitted');
  });

  it('reaches verified (never held) when the model matches but effort cannot be observed at all', async () => {
    const result = await sessions._verifyModelAfterLaunch('tmux-c4-2', 9501, 1, 'codex', 'gpt-5.6-sol', {
      stillValid: () => true, readTrustedActiveProfile: fakeObserved({ engine: 'codex', model: 'gpt-5.6-sol' })
    }, 'high');
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
  });

  it('a genuine MODEL mismatch still holds, even with an effort selection in play — the fix narrows the match, it does not disable it', async () => {
    const result = await sessions._verifyModelAfterLaunch('tmux-c4-3', 9502, 1, 'codex', 'gpt-5.6-sol', {
      stillValid: () => true, readTrustedActiveProfile: fakeObserved({ engine: 'codex', model: 'gpt-6-luna' })
    }, 'high');
    assert.equal(result.ok, false);
  });

  it('_matches itself: an unobserved effort/mode field is not a mismatch; an observed-and-wrong one still is', () => {
    assert.equal(profileReconciler._matches(
      { engine: 'codex', model: 'gpt-5.6-sol' }, { engine: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
    ), true);
    assert.equal(profileReconciler._matches(
      { engine: 'codex', model: 'gpt-5.6-sol', effort: 'low' }, { engine: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
    ), false);
  });

  it('_matches stays STRICT on model (PRR-A R2 C4): an unobserved model is still a mismatch, never skipped like effort/mode', () => {
    assert.equal(profileReconciler._matches(
      { engine: 'codex' }, { engine: 'codex', model: 'gpt-5.6-sol' }
    ), false, 'a model the engine has not reported at all must not read as confirmed');
    assert.equal(profileReconciler._matches(
      { engine: 'codex', model: 'gpt-6-luna' }, { engine: 'codex', model: 'gpt-5.6-sol' }
    ), false, 'the wrong observed model is still a mismatch');
  });
});

describe('#2188 engine-model-picker — effort-only launch does not permanently block model admission (Architect A509-PR2974-R2-HOLD B4)', () => {
  const store = require('../lib/store');
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-effort-only-admission-'));
    store._setBasePath(tmpDir);
    store.init();
  });
  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  beforeEach(() => { profileReconciler._resetForTests(); });

  it('an effort-only launch (model null) never blocks model admission — the fix itself, exercised through _modelAdmissionBlock directly', () => {
    // `_modelAdmissionBlock` needs only a session id to key its in-memory
    // and durable activity-log reads by — no real project/session row is
    // read through it, so none is created here.
    const sessionId = 90001;
    // Mirrors launchSession's own gate exactly: `if (requestedModel || requestedEffort)` sets
    // the desired profile, but the activity-log write (and the reconciliation schedule) are
    // gated on `requestedModel` ALONE — this is the fix itself, exercised directly rather than
    // through a full `launchSession` (which needs a real tmux pane).
    profileReconciler.setDesiredProfile(`session:${sessionId}`, { engine: 'claude', model: null, effort: 'high' });
    // No `session.model-launch-requested` row written — the fix. Before it,
    // this test would have needed one written unconditionally, and
    // `_modelAdmissionBlock` would have returned 'model-verification-pending' forever.
    assert.equal(sessions._modelAdmissionBlock(sessionId), null,
      'an effort-only launch must never read as a pending (and therefore eternally-unverifiable) model admission');
  });
});

describe('#2188 engine-model-picker — lib/projects.js wiring (effort persistence)', () => {
  const projects = require('../lib/projects');
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-effort-selection-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let realCheckEffortSelection;
  let realCheckSelection;
  beforeEach(() => {
    realCheckEffortSelection = models.checkEffortSelection;
    realCheckSelection = models.checkSelection;
  });
  afterEach(() => {
    models.checkEffortSelection = realCheckEffortSelection;
    models.checkSelection = realCheckSelection;
  });

  /** Stub `checkEffortSelection` to accept or refuse every call, deterministically. */
  function stubCheckEffortSelection(ok, reason = 'stubbed refusal') {
    models.checkEffortSelection = () => (ok ? { ok: true } : { ok: false, code: 'STUBBED', reason });
  }

  /** Stub `checkSelection` (the model axis) the same way, for a test that also sets/clears model. */
  function stubCheckSelection(ok, reason = 'stubbed refusal') {
    models.checkSelection = () => (ok ? { ok: true } : { ok: false, code: 'STUBBED', reason });
  }

  it('updateProject persists a valid effort and enrichment reports it available', async () => {
    stubCheckEffortSelection(true);
    projects.createProject({ name: 'effort-update-ok', engine: 'codex' });
    const result = await projects.updateProject('effort-update-ok', { effort: 'high' });
    assert.deepEqual(result.errors, []);
    const enriched = await projects.getProject('effort-update-ok');
    assert.equal(enriched.effort, 'high');
    assert.deepEqual(enriched.effortSelection, { id: 'high', available: true, reason: null });
  });

  it('updateProject refuses an invalid effort — project.json is left untouched', async () => {
    stubCheckEffortSelection(true);
    projects.createProject({ name: 'effort-update-bad', engine: 'codex' });
    await projects.updateProject('effort-update-bad', { effort: 'high' });
    stubCheckEffortSelection(false, 'is not an effort level offered for this model');
    const result = await projects.updateProject('effort-update-bad', { effort: 'ultra' });
    assert.equal(result.project, null);
    assert.ok(result.errors[0].includes('not an effort level offered'));
    const cfg = store.projectConfig.load(store.projects.getByName('effort-update-bad').path);
    assert.equal(cfg.effort, 'high', 'the refused update must not have changed the stored effort');
  });

  it('null clears a stored effort unconditionally', async () => {
    stubCheckEffortSelection(true);
    projects.createProject({ name: 'effort-clear', engine: 'codex' });
    await projects.updateProject('effort-clear', { effort: 'high' });
    const result = await projects.updateProject('effort-clear', { effort: null });
    assert.deepEqual(result.errors, []);
    assert.equal(result.project.effort, null);
  });

  it('an engine change resets the effort, same as it resets the model', async () => {
    stubCheckEffortSelection(true);
    projects.createProject({ name: 'effort-engine-reset', engine: 'codex' });
    await projects.updateProject('effort-engine-reset', { effort: 'high' });
    const result = await projects.updateProject('effort-engine-reset', { engine: 'claude' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.project.effort, null);
  });

  describe('B2 (Architect A509-PR2974-R1-HOLD): clearing or changing model on a perModel engine does not strand effort', () => {
    it('clearing the model on Codex clears the stored effort too, with a warning, and persists both', async () => {
      stubCheckEffortSelection(true);
      stubCheckSelection(true);
      projects.createProject({ name: 'effort-model-clear', engine: 'codex', model: 'gpt-5.6-sol' });
      await projects.updateProject('effort-model-clear', { effort: 'ultra' });
      const result = await projects.updateProject('effort-model-clear', { model: null });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.model, null);
      assert.equal(result.project.effort, null, 'the stale effort must not survive the model it was chosen for being cleared');
      assert.ok(result.warnings.some((w) => w.includes('does not apply without a model')));
      const cfg = store.projectConfig.load(store.projects.getByName('effort-model-clear').path);
      assert.equal(cfg.effort, null, 'the clear must be WRITTEN, not just reflected in the response');
    });

    it('changing the model to one that still supports the stored effort keeps it, unvalidated-but-safe path exercised', async () => {
      stubCheckEffortSelection(true);
      stubCheckSelection(true);
      projects.createProject({ name: 'effort-model-change-ok', engine: 'codex', model: 'gpt-5.6-sol' });
      await projects.updateProject('effort-model-change-ok', { effort: 'high' });
      const result = await projects.updateProject('effort-model-change-ok', { model: 'gpt-6-luna' });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.model, 'gpt-6-luna');
      assert.equal(result.project.effort, 'high', 'nothing about THIS case asked for a clear — checkEffortSelection is stubbed to accept, so the stale value is validated and kept');
    });

    it('changing the model to one checkEffortSelection refuses the stored effort for refuses the whole update', async () => {
      stubCheckSelection(true);
      stubCheckEffortSelection(true);
      projects.createProject({ name: 'effort-model-change-bad', engine: 'codex', model: 'gpt-5.6-sol' });
      await projects.updateProject('effort-model-change-bad', { effort: 'ultra' });
      stubCheckEffortSelection(false, 'is not an effort level offered for gpt-6-luna');
      const result = await projects.updateProject('effort-model-change-bad', { model: 'gpt-6-luna' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not an effort level offered'));
      const cfg = store.projectConfig.load(store.projects.getByName('effort-model-change-bad').path);
      assert.equal(cfg.model, 'gpt-5.6-sol', 'the refused update must not have changed the stored model either');
    });

    it('a static (non-perModel) engine like Claude is unaffected — clearing its model never touches effort', async () => {
      stubCheckEffortSelection(true);
      stubCheckSelection(true);
      projects.createProject({ name: 'effort-claude-unaffected', engine: 'claude' });
      await projects.updateProject('effort-claude-unaffected', { effort: 'high' });
      const result = await projects.updateProject('effort-claude-unaffected', { model: null });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.effort, 'high');
    });

    // #3214: Claude's model axis (static-list roster, lib/engine-models.js)
    // and effort axis (lib/engines.js's ENGINE_EFFORT) are two independent
    // blocks (#2188's own design), attached from two different places —
    // these 3 tests prove they actually compose for a real project, both
    // axes at once, through the bundled profile rather than a hand-built
    // fixture — unstubbed (`stubCheckSelection`/`stubCheckEffortSelection`
    // not called), so the real `checkSelection`/`checkEffortSelection` run
    // against Claude's real roster and effort block.
    it('the bundled Claude profile offers both a model and an effort selection', () => {
      const claude = engines.resolveProfile('claude');
      assert.equal(models.selectionState(claude).state, 'ok');
      assert.equal(models.effortSelectionState(claude).state, 'ok');
      assert.equal(models.checkSelection(claude, 'claude-opus-5-5').ok, true);
      assert.equal(models.checkEffortSelection(claude, null, 'high').ok, true, 'Claude\'s effort is engine-wide, not perModel — no model id required');
    });

    it('a project can store both a Claude model and an effort level together', async () => {
      projects.createProject({ name: 'claude-model-and-effort', engine: 'claude' });
      const result = await projects.updateProject('claude-model-and-effort', { model: 'claude-fable-5-1', effort: 'max' });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.model, 'claude-fable-5-1');
      assert.equal(result.project.effort, 'max');
    });

    it('refuses a model Claude does not offer, independent of effort', async () => {
      projects.createProject({ name: 'claude-bad-model', engine: 'claude' });
      const result = await projects.updateProject('claude-bad-model', { model: 'gpt-6-luna', effort: 'high' });
      assert.equal(result.project, null);
      assert.ok(result.errors.some((e) => e.includes('not a model offered')));
    });
  });
});

// #3214 R-Gate R1 BLOCKING 3 — `settingsCard`'s title is escaped once, by
// `settingsCard` itself; a call site must pass plain text, never a
// pre-encoded entity, or the real `esc()` double-escapes it into visible
// `&amp;amp;` / `&amp;mdash;`. These run the SAME `esc()` the page ships
// (lifted from its source, not re-implemented) against the exact title
// strings `public/ui.js` passes to `settingsCard`, so a future call site
// that creeps back to a pre-encoded title fails here.
describe('#3214 Project Settings — settingsCard title escaping (R-Gate R1 BLOCKING 3)', () => {
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  const esc = loadEsc();

  /** Every title string literal passed as settingsCard's first argument. */
  function settingsCardTitles() {
    const titles = [];
    const re = /settingsCard\('((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(uiSrc))) titles.push(m[1]);
    return titles;
  }

  it('public/ui.js calls settingsCard exactly 3 times, one per card', () => {
    assert.equal(settingsCardTitles().length, 3);
  });

  it('no title call site carries a pre-encoded HTML entity', () => {
    for (const title of settingsCardTitles()) {
      assert.doesNotMatch(title, /&(amp|lt|gt|quot|#39|mdash|middot);/,
        `"${title}" must be plain text — settingsCard already escapes it`);
    }
  });

  it('escaping each real title once produces no double-escaped entity', () => {
    for (const title of settingsCardTitles()) {
      const rendered = esc(title);
      assert.doesNotMatch(rendered, /&amp;(amp|lt|gt|quot|#39|mdash|middot);/,
        `rendering "${title}" must not double-escape`);
    }
  });

  it('the AI Engine card title renders its & and em dash correctly, once', () => {
    const title = settingsCardTitles().find((t) => t.includes('AI Engine'));
    assert.equal(esc(title), 'AI Engine, Model &amp; Effort — Launch Mode');
  });
});

// #3214 R-Gate R1 BLOCKING 1 — the Identity & Workspace Paths card must
// surface project.path, fleetCoordinator and decisionAuthorityPolicy
// alongside name/tags/version-file-path, not just the fields that existed
// before this car. Source-level: `openSettings` has too many top-level
// dependencies (state, esc, apiMutate, DOM) to invoke directly, the same
// constraint documented in test/settings-modal-silentprime.test.js.
describe('#3214 Project Settings — Identity & Workspace card fields (R-Gate R1 BLOCKING 1)', () => {
  const { liftBody } = require('./helpers/lift');
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  const openSettingsBody = liftBody(uiSrc, 'function openSettings(');

  it('renders the project workspace path', () => {
    assert.match(openSettingsBody, /project\.path/);
  });

  it('renders the Fleet Coordinator / decision authority role', () => {
    assert.match(openSettingsBody, /project\.fleetCoordinator/);
    assert.match(openSettingsBody, /project\.decisionAuthorityPolicy/);
  });

  it('the settings modal backdrop is a true full-viewport page, not a floating box', () => {
    const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const modalIdx = htmlSrc.indexOf('id="settingsModal"');
    assert.notEqual(modalIdx, -1, '#settingsModal must exist');
    const contentIdx = htmlSrc.indexOf('modal-content settings-modal', modalIdx);
    const styleEnd = htmlSrc.indexOf('>', contentIdx);
    const styleAttr = htmlSrc.slice(contentIdx, styleEnd);
    assert.match(styleAttr, /position:\s*fixed/);
    assert.match(styleAttr, /inset:\s*0/);
    assert.match(styleAttr, /width:\s*100vw/);
    assert.match(styleAttr, /height:\s*100vh/);
  });
});

// #3214 R-Gate R5 BLOCKING 1 — the Identity & Workspace card renders a path
// existence/readability badge and a git-repository badge alongside
// `#settingsPathBadge`, using fields `enrichProject` (lib/projects.js)
// already returns (`exists`, `unreadable`, `unreadableHint`, `git`) but that
// comment's own header says nothing renders yet (#885) — this is that.
describe('#3214 Project Settings — path-health badge (R-Gate R5 BLOCKING 1)', () => {
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  const { liftDeclaration } = require('./helpers/lift');
  const esc = loadEsc();
  const pathHealthBadgeHtml = new Function('esc', `
    ${liftDeclaration(uiSrc, 'function pathHealthBadgeHtml(')}
    return pathHealthBadgeHtml;
  `)(esc);

  it('a valid, readable, git-backed path renders both badges as healthy', () => {
    const html = pathHealthBadgeHtml({ path: '/x', exists: true, unreadable: null, git: { branch: 'main' } });
    assert.match(html, /Path OK/);
    assert.doesNotMatch(html, /missing|Unreadable/i);
    assert.match(html, /Git repository/);
    assert.match(html, /main/);
  });

  it('a missing path is called out distinctly from an unreadable one', () => {
    const missing = pathHealthBadgeHtml({ path: '/gone', exists: false, unreadable: null, git: null });
    assert.match(missing, /Path missing/);
    const unreadable = pathHealthBadgeHtml({ path: '/locked', exists: true, unreadable: 'EACCES', unreadableHint: 'Grant Full Disk Access', git: null });
    assert.match(unreadable, /Unreadable: EACCES/);
    assert.match(unreadable, /Grant Full Disk Access/);
  });

  it('a non-git-repo path renders a distinct, non-error badge', () => {
    const html = pathHealthBadgeHtml({ path: '/plain', exists: true, unreadable: null, git: null });
    assert.match(html, /Not a git repository/);
    assert.doesNotMatch(html, /color:var\(--danger\)">\s*Not a git repository/);
  });

  it('escapes an unreadable reason/hint and a git branch name', () => {
    const html = pathHealthBadgeHtml({
      path: '/x', exists: true, unreadable: '<script>', unreadableHint: '<b>hint</b>', git: null
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('is wired into openSettings\' Identity & Workspace card, next to #settingsPathBadge', () => {
    const { liftBody } = require('./helpers/lift');
    const openSettingsBody = liftBody(uiSrc, 'function openSettings(');
    assert.match(openSettingsBody, /id="settingsPathHealthBadge"[^<]*>\$\{pathHealthBadgeHtml\(project\)\}/);
  });
});

// #3214 R-Gate R2, Architect Ruling A921 — `claude-sonnet-reviewer` and
// `claude-fable-sprint` are real, live operator profiles (`~/.tangleclaw/
// engines/*.json`, 10 live projects on the host this ruling was issued
// against), not a hypothetical. They keep running real sessions under their
// own id (session launch, wake, quota bucketing are all unaffected — only
// the Settings UI's picker is in scope here); they just don't get their own
// row in the Engine dropdown, and the 3-phase picker shows/saves them as
// plain `claude` with a sensible model/effort default.
describe('#3214 Ruling A921 — Claude Code variant normalization in public/ui.js', () => {
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  require('../public/api-helper.js');
  const esc = (str) => {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  const { normalizeLegacyEngineSelection, buildEngineOptions } = (() => {
    const { liftDeclaration } = require('./helpers/lift');
    const fn = new Function('tcBuildEngineOptions', 'esc', `
      ${liftDeclaration(uiSrc, 'const LEGACY_CLAUDE_VARIANT_DEFAULTS')}
      ${liftDeclaration(uiSrc, 'function normalizeLegacyEngineSelection(')}
      ${liftDeclaration(uiSrc, 'function buildEngineOptions(')}
      return { normalizeLegacyEngineSelection, buildEngineOptions };
    `);
    return fn(globalThis.tcBuildEngineOptions, esc);
  })();

  const ENGINE_LIST = [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'antigravity', name: 'Antigravity', available: true },
    { id: 'codex', name: 'Codex', available: true },
    { id: 'aider', name: 'Aider', available: true },
    { id: 'claude-sonnet-reviewer', name: 'Claude (Reviewer)', available: true },
    { id: 'claude-fable-sprint', name: 'Claude (Sprint)', available: true }
  ];

  describe('normalizeLegacyEngineSelection', () => {
    it('maps claude-sonnet-reviewer to claude with its default model/effort when neither is already set', () => {
      assert.deepEqual(normalizeLegacyEngineSelection('claude-sonnet-reviewer', null, null),
        { engine: 'claude', model: 'claude-sonnet-5', effort: 'high' });
    });

    it('maps claude-fable-sprint to claude with its own default', () => {
      assert.deepEqual(normalizeLegacyEngineSelection('claude-fable-sprint', null, null),
        { engine: 'claude', model: 'claude-fable-5-1', effort: 'high' });
    });

    it('a project that already has its own model/effort keeps them, not the variant default', () => {
      assert.deepEqual(normalizeLegacyEngineSelection('claude-sonnet-reviewer', 'claude-opus-5-5', 'max'),
        { engine: 'claude', model: 'claude-opus-5-5', effort: 'max' });
    });

    it('passes through every non-variant engine id unchanged', () => {
      for (const id of ['claude', 'antigravity', 'codex', 'aider', '', null]) {
        assert.deepEqual(normalizeLegacyEngineSelection(id, 'm', 'e'), { engine: id, model: 'm', effort: 'e' });
      }
    });
  });

  describe('buildEngineOptions', () => {
    it('never renders the two legacy variant ids as their own selectable option', () => {
      const html = buildEngineOptions(ENGINE_LIST, 'claude');
      assert.doesNotMatch(html, /value="claude-sonnet-reviewer"/);
      assert.doesNotMatch(html, /value="claude-fable-sprint"/);
      assert.equal((html.match(/<option/g) || []).length, 4, 'exactly the 4 canonical engines');
    });

    it('normalizes a project currently stored under a variant id to a selected claude option', () => {
      const html = buildEngineOptions(ENGINE_LIST, 'claude-sonnet-reviewer');
      const claudeOpt = html.match(/<option value="claude"[^>]*>/)[0];
      assert.match(claudeOpt, /selected/);
    });
  });

  describe('renderModelEffortPicker renders disabled placeholders for an engine with no model/effort axis', () => {
    // Whole-file text search, not `liftBody` — `renderModelEffortPicker`'s
    // own signature has an object-literal default parameter (`ids = {}`),
    // whose `{}` is the FIRST brace after the declaration text, so the
    // balanced-brace matcher closes on it immediately and returns `'{}'`
    // instead of the real function body (a real gotcha, not a file-specific
    // one — any default param shaped `= {}` trips the same matcher this way).
    // The markup string is unique in the file either way.
    it('both halves render as a visible, disabled "Engine default" select rather than a blank area', () => {
      assert.match(uiSrc, /<select class="form-select" id="\$\{esc\(modelSelectId\)\}" disabled><option value="">Engine default \(CLI-managed\)<\/option><\/select>/);
      assert.match(uiSrc, /<select class="form-select" id="\$\{esc\(effortSelectId\)\}" disabled><option value="">Engine default \(CLI-managed\)<\/option><\/select>/);
    });
  });

  describe('openSettings\' #settingsEngine change listener compares against the normalized stored engine', () => {
    const openSettingsBody = require('./helpers/lift').liftBody(uiSrc, 'function openSettings(');

    it('leavesStoredEngine/backToStoredEngine read initialSelection.engine, never the raw project.engine.id', () => {
      // A project stored under a variant id (`claude-sonnet-reviewer`) renders
      // the dropdown normalized to `claude` on open — if these comparisons
      // still read the raw, un-normalized `project.engine.id`, switching the
      // dropdown away and back to (normalized) `claude` would misread as
      // "leaving the stored engine" and wrongly blank the model/effort
      // selection `initialSelection` already carries.
      assert.match(openSettingsBody, /leavesStoredEngine = e\.target\.value !== initialSelection\.engine/);
      assert.match(openSettingsBody, /backToStoredEngine = e\.target\.value === initialSelection\.engine/);
      assert.doesNotMatch(openSettingsBody, /leavesStoredEngine = e\.target\.value !== \(project\.engine/);
      assert.doesNotMatch(openSettingsBody, /backToStoredEngine = e\.target\.value === \(project\.engine/);
    });

    it('backToStoredEngine restores initialSelection\'s (normalized) model/effort, not the raw project fields', () => {
      assert.match(openSettingsBody, /backToStoredEngine \? initialSelection\.model : null/);
      assert.match(openSettingsBody, /backToStoredEngine \? initialSelection\.effort : null/);
    });
  });
});
