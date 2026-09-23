'use strict';

/*
 * #1738 — a wrap from a session whose engine cannot run the project's Prawduct
 * methodology is a state-only checkpoint: it never probes Prawduct, never cuts a
 * release, never merges, and says so from the first frame to the last.
 *
 * These cases run the real runner across several steps, because the property is
 * "every step reads ONE answer": a capability resolved per step could let one
 * step withhold what another granted.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanLaunchScope } = require('./_wrap-scope-fixture');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const wrapPipeline = require('../lib/wrap-pipeline');
const preflight = require('../lib/wrap-steps/preflight');
const drawer = (() => {
  const vm = require('node:vm');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'wrap-drawer.js'), 'utf8'), sandbox);
  return sandbox.window.tcWrapDrawerHelpers;
})();

describe('wrap methodology authority (#1738)', () => {
  let tmpDir;
  let projectPath;
  let projectName;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-methodology-'));
    store._setBasePath(tmpDir);
    store.init();
    projectPath = path.join(tmpDir, 'onboarded');
    fs.mkdirSync(path.join(projectPath, '.prawduct'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.prawduct', 'change-log.md'), '<!-- prawduct: id=A status=merged -->\n');
    fs.writeFileSync(path.join(projectPath, 'version.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(path.join(projectPath, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n');
    projectName = 'onboarded';
    store.projects.create({ name: projectName, path: projectPath, engine: 'claude' });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run the real pipeline with every step but the three under test replaced by
   * a spy that records the capability it was handed.
   * @param {object} session - The session being wrapped
   * @returns {Promise<{result: object, seen: Map<string, object>, events: object[], hookCalls: number}>}
   */
  async function runWith(session) {
    const seen = new Map();
    const originals = {};
    const real = new Set(['preflight', 'version-bump', 'pr-merge']);
    for (const kind of Object.keys(wrapPipeline.STEP_DISPATCH)) {
      if (real.has(kind)) continue;
      originals[kind] = wrapPipeline.STEP_DISPATCH[kind];
      wrapPipeline.STEP_DISPATCH[kind] = {
        run: async (ctx) => {
          seen.set(ctx.step.id, ctx.methodology);
          return { ok: true, status: 'done', output: null, blockers: [] };
        }
      };
    }
    const savedScope = wrapPipeline._internal.resolveScope;
    wrapPipeline._internal.resolveScope = async () => cleanLaunchScope(projectPath);
    const savedExec = preflight._internal.execFileArgs;
    const savedLocate = preflight._internal.locateHook;
    let hookCalls = 0;
    preflight._internal.locateHook = () => ({ path: '/hook', via: 'PATH' });
    preflight._internal.execFileArgs = async () => { hookCalls += 1; return { exitCode: 0, stdout: '', stderr: '', error: null, timedOut: false }; };
    const events = [];
    try {
      const result = await wrapPipeline.runWrapPipeline(projectName, {
        session,
        onStepEvent: (e) => events.push(e)
      });
      return { result, seen, events, hookCalls };
    } finally {
      for (const [kind, handler] of Object.entries(originals)) wrapPipeline.STEP_DISPATCH[kind] = handler;
      wrapPipeline._internal.resolveScope = savedScope;
      preflight._internal.execFileArgs = savedExec;
      preflight._internal.locateHook = savedLocate;
    }
  }

  it('a Gemini session checkpoints: no probe, no release, one capability for every step, withheld from the first frame', async () => {
    const ledgerBefore = fs.readFileSync(path.join(projectPath, '.prawduct', 'change-log.md'), 'utf8');
    const { result, seen, events, hookCalls } = await runWith({ id: 1, engineId: 'gemini' });

    assert.equal(result.ok, true, 'the checkpoint completes');
    assert.equal(hookCalls, 0, 'prawduct-hook must never run for a dormant project');
    const byId = Object.fromEntries(result.results.map((r) => [r.stepId, r]));
    assert.equal(byId.preflight.status, 'capability-unavailable');
    assert.equal(byId['version-bump'].status, 'capability-unavailable');

    assert.equal(result.methodology.disposition, 'capability-unavailable');
    assert.equal(result.methodology.engineId, 'gemini', 'the session engine, not the project row\'s claude');
    assert.equal(result.methodologyAuthority.state, 'withheld');

    // One answer, handed to every step.
    assert.ok(seen.size > 5);
    for (const [stepId, m] of seen) assert.equal(m, result.methodology, `${stepId} saw a different capability`);

    const start = events.find((e) => e.type === 'run-start');
    assert.equal(start.methodologyAuthority.state, 'withheld', 'stated before any step moves');
    const live = drawer.applyWrapStreamEvent(null, start);
    assert.match(drawer.plannedSessionLine(live), /will not merge or release: the gemini engine/);

    const banner = drawer.summarizePipelineStatus(result, {});
    assert.equal(banner.label, 'Wrap checkpointed — merge and release withheld');
    assert.equal(banner.tone, 'warning');

    assert.equal(fs.readFileSync(path.join(projectPath, '.prawduct', 'change-log.md'), 'utf8'), ledgerBefore);
    assert.equal(JSON.parse(fs.readFileSync(path.join(projectPath, 'version.json'), 'utf8')).version, '1.0.0');
  });

  it('a Claude session runs the probe and keeps its authority', async () => {
    const { result, hookCalls, events } = await runWith({ id: 2, engineId: 'claude' });
    assert.equal(hookCalls, 1);
    assert.equal(result.methodology.disposition, 'available');
    assert.equal(result.methodologyAuthority.state, 'granted');
    const byId = Object.fromEntries(result.results.map((r) => [r.stepId, r]));
    assert.equal(byId.preflight.status, 'done');
    assert.notEqual(byId['version-bump'].status, 'capability-unavailable');
    const start = events.find((e) => e.type === 'run-start');
    assert.equal(drawer.plannedSessionLine(drawer.applyWrapStreamEvent(null, start)), null);
    assert.notEqual(drawer.summarizePipelineStatus(result, {}).label, 'Wrap checkpointed — merge and release withheld');
  });

  it('the commit row says a withheld auto-merge was deliberate, and names held-back Prawduct files', () => {
    const row = drawer.buildStepRow({
      stepId: 'commit', kind: 'commit', status: 'done', blockers: [],
      output: {
        commitSha: 'abcdef1234567890',
        methodologyWithheld: ['.prawduct/change-log.md'],
        autoPr: { prUrl: 'https://github.com/o/r/pull/1', autoMergeArmed: false, autoMergeWithheld: 'r', pushed: true }
      }
    }, {});
    assert.match(row.detail, /auto-merge withheld: this engine cannot run the methodology/);
    assert.match(row.detail, /1 Prawduct file not committed/);
    assert.doesNotMatch(row.detail, /NOT armed/, 'a deliberate withhold must not read as a failed arm');
  });

  it('new statuses render their reason, and roll up as skips rather than green', () => {
    const r = { stepId: 'preflight', kind: 'preflight', status: 'capability-unavailable', blockers: [], output: { reason: 'the codex engine cannot run the Prawduct plugin — prawduct gates not measured' } };
    assert.match(drawer.buildStepRow(r, {}).detail, /codex engine cannot run/);
    assert.equal(drawer.buildStepRow(r, {}).statusLabel, 'Unavailable');
    const roll = drawer.summarizeSkips({ results: [r, { stepId: 'x', kind: 'x', status: 'not-applicable', output: { reason: 'n/a' } }] });
    assert.equal(roll.skipped, 2);
    assert.equal(roll.done, 0);
  });

  it('a non-Claude launch writes its own config and leaves Prawduct\'s onboarding untouched', () => {
    const engines = require('../lib/engines');
    const dir = fs.mkdtempSync(path.join(tmpDir, 'dormant-'));
    fs.mkdirSync(path.join(dir, '.prawduct'));
    fs.writeFileSync(path.join(dir, '.prawduct', 'project-state.yaml'), 'active_build_plan: null\n');
    fs.mkdirSync(path.join(dir, '.claude'));
    const settings = JSON.stringify({ enabledPlugins: { 'prawduct@prawduct': true } });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), settings);
    const snapshot = () => ({
      prawduct: fs.readdirSync(path.join(dir, '.prawduct')).map((n) => [n, fs.readFileSync(path.join(dir, '.prawduct', n), 'utf8')]),
      settings: fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')
    });
    const before = snapshot();
    engines.writeEngineConfig('codex', dir, store.projectConfig.load(dir), store.engines.get('codex'));
    assert.deepEqual(snapshot(), before, 'an engine that cannot run Prawduct must not rewrite or remove its onboarding');
    assert.equal(before.settings, settings);
  });

  it('a failed or stranded wrap PR keeps its own banner, carrying the withheld authority', () => {
    const authority = { state: 'withheld', engineId: 'codex', reason: 'the codex engine cannot run the Prawduct plugin. This wrap does not cut a release' };
    const commitRow = (autoPr) => ({ stepId: 'commit', kind: 'commit', status: 'done', blockers: [], output: { commitSha: 'abc123abc123abc', autoPr } });
    const failed = drawer.summarizePipelineStatus({ ok: true, commitSha: 'abc123abc123abc', methodologyAuthority: authority,
      results: [commitRow({ pushed: true, prUrl: null, autoMergeArmed: false, error: 'gh pr create failed' })] }, {});
    assert.equal(failed.label, 'Wrap committed — release NOT armed');
    assert.match(failed.detail, /gh pr create failed/);
    assert.match(failed.detail, /codex engine cannot run/);

    const stranded = drawer.summarizePipelineStatus({ ok: true, commitSha: 'abc123abc123abc', methodologyAuthority: authority,
      results: [commitRow({ pushed: true, prUrl: null, autoMergeArmed: false, error: null, skippedReason: null })] }, {});
    assert.equal(stranded.label, 'Wrap committed — branch left on origin, no PR');
    assert.match(stranded.detail, /codex engine cannot run/);

    const quiet = drawer.summarizePipelineStatus({ ok: true, commitSha: null, methodologyAuthority: authority, results: [] }, {});
    assert.equal(quiet.label, 'Wrap checkpointed — merge and release withheld');
    assert.doesNotMatch(quiet.detail, /opens its PR/, 'a run that committed nothing opened no PR');
  });
});
