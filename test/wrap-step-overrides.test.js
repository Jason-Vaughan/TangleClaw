'use strict';

/**
 * Per-project wrap step overrides.
 *
 * `wrap_pipeline.steps` is framework-owned and shared by every project on a
 * methodology, so before this a project could not turn one step off without
 * forking the whole template — and a template hand-edit is destroyed at the
 * next boot after a framework revision bump. These tests pin both halves: the
 * overrides do what they say, and they survive the sync that ate the old
 * workaround.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const wrapPipeline = require('../lib/wrap-pipeline');
const defaultPipeline = require('../lib/wrap-default-pipeline');
const overrides = require('../lib/wrap-step-overrides');
const projects = require('../lib/projects');

/**
 * Run `fn` with the code-owned pipeline swapped for a two-step fixture.
 * Driving the runner tests through the real pipeline would halt on an
 * earlier step long before reaching the step under test — the temp project
 * is not a git repo — and the assertion would never run.
 * @param {object[]} steps - Fixture step specs
 * @param {() => Promise<void>} fn
 */
async function withFixturePipeline(steps, fn) {
  const pristine = defaultPipeline._internal.pipeline;
  defaultPipeline._internal.pipeline = { schemaVersion: '1.0', steps };
  try {
    await fn();
  } finally {
    defaultPipeline._internal.pipeline = pristine;
  }
}

describe('per-project wrap step overrides', () => {
  let tmpDir;
  let projectPath;
  let fixturePath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-step-overrides-'));
    store._setBasePath(tmpDir);
    store.init();
    projectPath = path.join(tmpDir, 'override-test');
    fs.mkdirSync(projectPath, { recursive: true });
    store.projects.create({ name: 'override-test', path: projectPath, methodology: 'prawduct' });

    fixturePath = path.join(tmpDir, 'fixture-test');
    fs.mkdirSync(fixturePath, { recursive: true });
    store.projects.create({ name: 'fixture-test', path: fixturePath, methodology: 'prawduct' });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Persist a `wrapStepOverrides` map for the test project.
   * @param {object} map - Overrides keyed by step id
   */
  function setOverrides(map) {
    const cfg = store.projectConfig.load(projectPath);
    cfg.wrapStepOverrides = map;
    store.projectConfig.save(projectPath, cfg);
  }

  describe('resolveStep', () => {
    it('returns the template step untouched when the project has no overrides', () => {
      const step = { id: 'commit', kind: 'commit', blocker: true };
      for (const empty of [null, undefined, {}]) {
        const r = overrides.resolveStep(step, empty);
        assert.equal(r.enabled, true);
        assert.deepEqual(r.step, step);
        assert.deepEqual(r.rejected, []);
      }
    });

    it('never mutates the template step it was handed', () => {
      // The same step object is reused across every project on the
      // methodology, so a mutation here would leak one project's config into
      // the next project's wrap.
      const step = { id: 'commit', kind: 'commit', blocker: true };
      const before = JSON.stringify(step);
      const r = overrides.resolveStep(step, { commit: { blocker: false } });
      assert.equal(JSON.stringify(step), before, 'template step must be untouched');
      assert.equal(r.step.blocker, false);
    });

    it('disables a step on enabled:false', () => {
      const r = overrides.resolveStep({ id: 'project-map', kind: 'project-map' },
        { 'project-map': { enabled: false } });
      assert.equal(r.enabled, false);
    });

    it('keeps `enabled` off the resolved step so no handler reads it as a second switch', () => {
      const r = overrides.resolveStep({ id: 'project-map', kind: 'project-map' },
        { 'project-map': { enabled: false } });
      assert.ok(!('enabled' in r.step), 'enabled is a runner decision, not part of the step spec');
    });

    it('applies allow-listed fields', () => {
      const r = overrides.resolveStep(
        { id: 'changelog-update', kind: 'ai-content', blocker: true, prompt: 'original' },
        { 'changelog-update': { blocker: 'errors-only', prompt: 'project wording' } }
      );
      assert.equal(r.step.blocker, 'errors-only');
      assert.equal(r.step.prompt, 'project wording');
      assert.deepEqual(r.rejected, []);
    });

    it('REFUSES to override verifyChanged — emptying it would make the gate report success while checking nothing', () => {
      const step = {
        id: 'changelog-update',
        kind: 'ai-content',
        verifyChanged: ['CHANGELOG.md']
      };
      const r = overrides.resolveStep(step, { 'changelog-update': { verifyChanged: [] } });
      assert.deepEqual(r.step.verifyChanged, ['CHANGELOG.md'],
        'the verification target must survive a project trying to blank it');
      assert.deepEqual(r.rejected, ['verifyChanged']);
    });

    it('refuses to override step identity (id, kind) — that is add/remove in disguise', () => {
      const step = { id: 'commit', kind: 'commit' };
      const r = overrides.resolveStep(step, { commit: { id: 'other', kind: 'ai-content' } });
      assert.equal(r.step.id, 'commit');
      assert.equal(r.step.kind, 'commit');
      assert.deepEqual(r.rejected.sort(), ['id', 'kind']);
    });

    it('refuses to override the capture contract other subsystems read by name', () => {
      const step = { id: 'memory-update', kind: 'ai-content', captureFields: ['summary'] };
      const r = overrides.resolveStep(step, {
        'memory-update': { captureFields: ['other'], captureFile: '/tmp/x.md' }
      });
      assert.deepEqual(r.step.captureFields, ['summary']);
      assert.equal(r.step.captureFile, undefined);
      assert.deepEqual(r.rejected.sort(), ['captureFields', 'captureFile']);
    });

    it('rejects an allow-listed field carrying an invalid value rather than applying it', () => {
      const r = overrides.resolveStep({ id: 'commit', kind: 'commit', blocker: true },
        { commit: { blocker: 'sometimes' } });
      assert.equal(r.step.blocker, true, 'an unusable value must not reach the runner');
      assert.deepEqual(r.rejected, ['blocker']);
    });

    it('treats an override for a step this methodology lacks as inert, not an error', () => {
      const step = { id: 'commit', kind: 'commit' };
      const r = overrides.resolveStep(step, { 'step-that-does-not-exist': { enabled: false } });
      assert.equal(r.enabled, true);
      assert.deepEqual(r.step, step);
    });
  });

  describe('validateOverrides (the settings API gate)', () => {
    it('accepts an empty or absent map', () => {
      for (const v of [undefined, null, {}]) assert.equal(overrides.validateOverrides(v).ok, true);
    });

    it('accepts a well-formed map', () => {
      const v = overrides.validateOverrides({
        'version-bump': { enabled: false },
        'changelog-update': { blocker: 'errors-only' }
      });
      assert.equal(v.ok, true);
    });

    it('rejects a non-object map, including an array', () => {
      for (const bad of [[], 'nope', 7]) {
        assert.equal(overrides.validateOverrides(bad).ok, false);
      }
    });

    it('rejects a non-overridable field and names it', () => {
      const v = overrides.validateOverrides({ 'changelog-update': { verifyChanged: [] } });
      assert.equal(v.ok, false);
      assert.match(v.error, /verifyChanged/);
      assert.match(v.error, /not overridable/);
    });

    it('rejects an invalid value for an allowed field', () => {
      const v = overrides.validateOverrides({ commit: { enabled: 'yes' } });
      assert.equal(v.ok, false);
      assert.match(v.error, /commit\.enabled/);
    });

    it('rejects disabling the commit step when handed the pipeline', () => {
      const steps = [{ id: 'commit', kind: 'commit' }];
      const v = overrides.validateOverrides({ commit: { enabled: false } }, steps);
      assert.equal(v.ok, false);
      assert.match(v.error, /cannot be disabled/);
    });

    it('still allows reconfiguring — not disabling — the commit step', () => {
      const steps = [{ id: 'commit', kind: 'commit' }];
      assert.equal(overrides.validateOverrides({ commit: { blocker: false } }, steps).ok, true);
      assert.equal(overrides.validateOverrides({ commit: { enabled: true } }, steps).ok, true);
    });
  });

  describe('the flush step cannot be disabled', () => {
    it('refuses enabled:false on a commit-kind step, so staged work cannot be silently dropped', () => {
      // Every other step stages its writes in memory; the commit step is the
      // only thing that flushes them. Disabling it would leave version-bump and
      // changelog-update reporting done with nothing on disk.
      const r = overrides.resolveStep({ id: 'commit', kind: 'commit' }, { commit: { enabled: false } });
      assert.equal(r.enabled, true, 'the flush must survive a project trying to switch it off');
      assert.deepEqual(r.rejected, ['enabled']);
    });

    it('keys the refusal on kind, so renaming the step in a methodology does not evade it', () => {
      const r = overrides.resolveStep({ id: 'land-it', kind: 'commit' }, { 'land-it': { enabled: false } });
      assert.equal(r.enabled, true);
    });

    it('still permits other overrides on that step', () => {
      const r = overrides.resolveStep({ id: 'commit', kind: 'commit', blocker: true },
        { commit: { blocker: false } });
      assert.equal(r.enabled, true);
      assert.equal(r.step.blocker, false);
      assert.deepEqual(r.rejected, []);
    });
  });

  describe('the runner honors overrides', () => {
    /**
     * Persist a `wrapStepOverrides` map for the fixture project.
     * @param {object} map - Overrides keyed by step id
     */
    function setFixtureOverrides(map) {
      const cfg = store.projectConfig.load(fixturePath);
      cfg.wrapStepOverrides = map;
      store.projectConfig.save(fixturePath, cfg);
    }

    it('records an honest skip for a disabled step instead of dropping it from the run', async () => {
      // A step absent from the results reads as a pipeline that never had it,
      // which is how a wrap ends up implying work it did not do.
      const original = wrapPipeline.STEP_DISPATCH['project-map'];
      let ran = false;
      wrapPipeline.STEP_DISPATCH['project-map'] = {
        run: async () => { ran = true; return { ok: true, status: 'done', output: null, blockers: [] }; }
      };
      setFixtureOverrides({ 'project-map': { enabled: false } });
      try {
        await withFixturePipeline([
          { id: 'project-map', kind: 'project-map' },
          { id: 'index-describe', kind: 'index-describe' }
        ], async () => {
          const result = await wrapPipeline.runWrapPipeline('fixture-test');
          const entry = result.results.find((r) => r.stepId === 'project-map');
          assert.ok(entry, 'a disabled step must still appear in the results');
          assert.equal(entry.status, 'skipped');
          assert.match(entry.output.reason, /disabled for this project/);
          assert.equal(ran, false, 'the handler must not run');
        });
      } finally {
        wrapPipeline.STEP_DISPATCH['project-map'] = original;
        setFixtureOverrides({});
      }
    });

    it('honors a blocker override, so a project can stop a gate halting its wrap — visibly', async () => {
      // The escape valve is legitimate precisely because it stays visible: the
      // step still runs, still fails, and still says so.
      const original = wrapPipeline.STEP_DISPATCH['project-map'];
      wrapPipeline.STEP_DISPATCH['project-map'] = {
        run: async () => ({ ok: false, status: 'blocked', output: null, blockers: ['simulated failure'] })
      };
      try {
        await withFixturePipeline([
          { id: 'project-map', kind: 'project-map', blocker: true },
          { id: 'index-describe', kind: 'index-describe' }
        ], async () => {
          setFixtureOverrides({});
          const halted = await wrapPipeline.runWrapPipeline('fixture-test');
          assert.equal(halted.blockedAt, 'project-map', 'precondition: it halts without the override');

          setFixtureOverrides({ 'project-map': { blocker: false } });
          const result = await wrapPipeline.runWrapPipeline('fixture-test');
          assert.equal(result.blockedAt, null, 'the override must stop the halt');
          const entry = result.results.find((r) => r.stepId === 'project-map');
          assert.equal(entry.status, 'blocked', 'the failure must still be reported, not hidden');
          assert.deepEqual(entry.blockers, ['simulated failure']);
        });
      } finally {
        wrapPipeline.STEP_DISPATCH['project-map'] = original;
        setFixtureOverrides({});
      }
    });

    it('runs the default pipeline unmodified when the project config is unreadable', async () => {
      const cfgPath = path.join(fixturePath, '.tangleclaw', 'project.json');
      const saved = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null;
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, '{ not json');
      try {
        const result = await wrapPipeline.runWrapPipeline('fixture-test');
        assert.equal(result.results.length, defaultPipeline.steps().length,
          'an unreadable config must not silently drop steps');
      } finally {
        if (saved === null) fs.rmSync(cfgPath, { force: true });
        else fs.writeFileSync(cfgPath, saved);
      }
    });
  });

  describe('overrides survive the template sync that destroys template edits', () => {
    it('a framework revision bump replaces the steps but leaves project overrides intact and applied', () => {
      // This is the whole reason overrides live in project.json. The same bump
      // that wipes a hand-edited template must leave this untouched — proven
      // against the real reconciler, not by assertion about where the file is.
      setOverrides({ 'project-map': { enabled: false } });

      const live = JSON.parse(JSON.stringify(store.templates.get('prawduct')));
      live.schemaRevision = 1;
      // The edit a project used to have to make, which the sync exists to undo.
      live.wrap_pipeline.steps = live.wrap_pipeline.steps.filter((s) => s.id !== 'project-map');
      store.templates.save(live);

      const bundled = JSON.parse(JSON.stringify(store.templates.get('prawduct')));
      bundled.schemaRevision = 99;
      bundled.wrap_pipeline.steps = JSON.parse(JSON.stringify(
        store.templates.get('prawduct').wrap_pipeline.steps
      ));
      bundled.wrap_pipeline.steps.push({ id: 'project-map', kind: 'project-map' });

      const changed = store._reconcileFrameworkSubtrees(bundled, live);
      assert.equal(changed, true, 'precondition: the sync must have fired');
      assert.ok(live.wrap_pipeline.steps.some((s) => s.id === 'project-map'),
        'precondition: the sync restores the step a template edit removed');

      const cfg = store.projectConfig.load(projectPath);
      assert.deepEqual(cfg.wrapStepOverrides, { 'project-map': { enabled: false } },
        'the project override must survive the sync that undid the template edit');
      assert.equal(
        overrides.resolveStep({ id: 'project-map', kind: 'project-map' }, cfg.wrapStepOverrides).enabled,
        false,
        'and must still take effect afterwards'
      );

      setOverrides({});
    });

    it('wrapStepOverrides is not a framework-owned path', () => {
      for (const owned of store.FRAMEWORK_OWNED_PATHS) {
        assert.ok(!owned.startsWith('wrapStepOverrides'),
          `${owned} would put project overrides back under framework ownership`);
      }
    });
  });

  describe('the settings API round-trip', () => {
    it('persists a valid map and reports it back on the project', () => {
      const map = { 'project-map': { enabled: false } };
      const res = projects.updateProject('fixture-test', { wrapStepOverrides: map });
      assert.deepEqual(res.errors || [], []);
      assert.deepEqual(store.projectConfig.load(fixturePath).wrapStepOverrides, map);
      assert.deepEqual(projects.getProject('fixture-test').wrapStepOverrides, map);
    });

    it('clears every override when handed an empty map', () => {
      projects.updateProject('fixture-test', { wrapStepOverrides: {} });
      assert.deepEqual(store.projectConfig.load(fixturePath).wrapStepOverrides, {});
      assert.deepEqual(projects.getProject('fixture-test').wrapStepOverrides, {});
    });

    it('rejects a non-overridable field without writing anything', () => {
      projects.updateProject('fixture-test', { wrapStepOverrides: { 'project-map': { enabled: false } } });
      const res = projects.updateProject('fixture-test', {
        wrapStepOverrides: { 'changelog-update': { verifyChanged: [] } }
      });
      assert.ok(res.errors && res.errors.length > 0);
      assert.match(res.errors[0], /verifyChanged/);
      assert.deepEqual(store.projectConfig.load(fixturePath).wrapStepOverrides,
        { 'project-map': { enabled: false } }, 'a rejected save must not mutate state');
      projects.updateProject('fixture-test', { wrapStepOverrides: {} });
    });

    it('reports an empty map for a project that has never configured one', () => {
      // A project a sibling test has already cleared to `{}` would pass this
      // for the wrong reason — and only while the tests keep their order. This
      // one is created here and never written to.
      const virginPath = path.join(tmpDir, 'never-configured');
      fs.mkdirSync(virginPath, { recursive: true });
      store.projects.create({ name: 'never-configured', path: virginPath, methodology: 'prawduct' });
      assert.ok(!fs.existsSync(path.join(virginPath, '.tangleclaw', 'project.json')),
        'precondition: nothing may have written this project a config');
      assert.deepEqual(projects.getProject('never-configured').wrapStepOverrides, {});
    });
  });

  describe('config defaults', () => {
    it('defaults to an empty map, so an untouched project runs its methodology unmodified', () => {
      const fresh = path.join(tmpDir, 'fresh-project');
      fs.mkdirSync(fresh, { recursive: true });
      assert.deepEqual(store.projectConfig.load(fresh).wrapStepOverrides, {});
    });

    it('takes an on-disk map verbatim — the default must not fold in keys a project cannot delete', () => {
      // `projectConfig.load` replaces non-`rules` keys wholesale. That is the
      // correct behavior for a map the project alone owns, and this pins it:
      // if the default ever gains entries, they would merge in here.
      setOverrides({ commit: { blocker: false } });
      try {
        assert.deepEqual(store.projectConfig.load(projectPath).wrapStepOverrides,
          { commit: { blocker: false } });
      } finally {
        setOverrides({});
      }
    });
  });
});
