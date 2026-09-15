'use strict';

// version-bump's release gate (#1492 L1 + L4): `releaseMode` decides whether a
// wrap may cut, and in `auto` the readiness verdict decides whether it does.
// Every case uses a fully bumpable project, so the only thing that can stop the
// cut is the gate under test.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const versionBump = require('../lib/wrap-steps/version-bump');

describe('version-bump release gate', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-gate-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    versionBump._internal.todayIso = () => '2026-09-14';
  });

  /**
   * A project that would bump 1.2.3 → 1.3.0 if nothing held it.
   *
   * @param {object} opts
   * @param {object} [opts.config] - `.tangleclaw/project.json` contents; omitted = no file
   * @param {string} [opts.plan] - `## Status` boxes for `.prawduct/artifacts/p.md`; omitted = no plan
   * @param {string} [opts.pointer] - `active_build_plan:` value; defaults to the plan when one is given
   * @returns {{name:string, path:string}}
   */
  function makeProject({ config, plan, pointer } = {}) {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'p-'));
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n### Added\n- a feature\n\n## [1.2.3] - 2026-09-01\n\n### Fixed\n- a fix\n');
    if (config) {
      fs.mkdirSync(path.join(dir, '.tangleclaw'));
      fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), JSON.stringify(config));
    }
    if (plan !== undefined || pointer !== undefined) {
      fs.mkdirSync(path.join(dir, '.prawduct', 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.prawduct', 'project-state.yaml'),
        `active_build_plan: ${pointer !== undefined ? pointer : 'artifacts/p.md'}\n`);
      if (plan !== undefined) {
        fs.writeFileSync(path.join(dir, '.prawduct', 'artifacts', 'p.md'), `# Plan\n\n## Status\n\n${plan}\n`);
      }
    }
    return { name: path.basename(dir), path: dir };
  }

  const run = (project, options = {}) => {
    const context = { project, step: { id: 'version-bump', kind: 'version-bump' }, staged: {}, options };
    return versionBump.run(context).then((result) => ({ result, staged: context.staged }));
  };

  describe('auto', () => {
    it('cuts on a ready verdict, and records why', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'auto' }, plan: '- [x] done' }));
      assert.equal(result.status, 'done');
      assert.equal(result.output.to, '1.3.0');
      assert.equal(result.output.releaseMode, 'auto');
      assert.equal(result.output.decidedBy, 'readiness');
      assert.equal(result.output.readiness.verdict, 'ready');
      assert.ok(staged['version-bump:changelog']);
    });

    it('holds mid-plan, stages nothing, and names the unticked plan', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'auto' }, plan: '- [x] one\n- [ ] two' }));
      assert.equal(result.status, 'skipped');
      assert.equal(result.ok, true, 'a hold never blocks the wrap');
      assert.deepEqual(result.blockers, []);
      assert.equal(result.output.held, true);
      assert.equal(result.output.needsOperator, false, 'a plain not-ready is a hold, not a question');
      assert.equal(result.output.readiness.verdict, 'not-ready');
      assert.match(result.output.reason, /release held: readiness is not-ready/);
      assert.match(result.output.reason, /1 of 2 Status boxes unticked/);
      assert.deepEqual(result.output.wouldBump, { from: '1.2.3', to: '1.3.0', bumpLevel: 'minor' });
      assert.deepEqual(staged, {});
    });

    it('holds on an unknown verdict and asks the operator', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'auto' }, pointer: 'artifacts/missing.md' }));
      assert.equal(result.status, 'skipped');
      assert.equal(result.output.readiness.verdict, 'unknown');
      assert.equal(result.output.needsOperator, true);
      assert.deepEqual(staged, {});
    });

    it('cuts mid-plan when the operator picked a level, and says so', async () => {
      const { result } = await run(makeProject({ config: { releaseMode: 'auto' }, plan: '- [ ] open' }), { bumpLevel: 'patch' });
      assert.equal(result.status, 'done');
      assert.equal(result.output.to, '1.2.4');
      assert.equal(result.output.decidedBy, 'operator');
      assert.match(result.output.detail, /cut on the operator's patch pick \(readiness: not-ready\)/);
    });

    it('is the default, and a project with no plan cuts as it always did', async () => {
      const { result } = await run(makeProject());
      assert.equal(result.status, 'done');
      assert.equal(result.output.releaseMode, 'auto');
      assert.equal(result.output.decidedBy, 'readiness');
    });
  });

  describe('ask', () => {
    it('holds even when ready, and asks the operator', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'ask' }, plan: '- [x] done' }));
      assert.equal(result.status, 'skipped');
      assert.equal(result.output.held, true);
      assert.equal(result.output.needsOperator, true);
      assert.equal(result.output.readiness.verdict, 'ready');
      assert.match(result.output.reason, /releaseMode is ask/);
      assert.deepEqual(staged, {});
    });

    it('cuts on the operator\'s pick', async () => {
      const { result } = await run(makeProject({ config: { releaseMode: 'ask' } }), { bumpLevel: 'major' });
      assert.equal(result.status, 'done');
      assert.equal(result.output.to, '2.0.0');
      assert.equal(result.output.decidedBy, 'operator');
    });

    it('is what an unrecognized releaseMode means, with the warning carried', async () => {
      const { result } = await run(makeProject({ config: { releaseMode: 'Auto' } }));
      assert.equal(result.status, 'skipped');
      assert.equal(result.output.releaseMode, 'ask');
      assert.match(result.output.releaseModeWarning, /"Auto" is not one of off, auto, ask/);
    });
  });

  describe('off', () => {
    it('skips before any gate, and ignores a picked level', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'off' } }), { bumpLevel: 'minor' });
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /releaseMode is off/);
      assert.equal(result.output.held, undefined, 'off is not a hold');
      assert.deepEqual(staged, {});
    });

    it('is what a legacy versionBumpEnabled:false still means', async () => {
      const { result } = await run(makeProject({ config: { versionBumpEnabled: false } }));
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /releaseMode is off/);
    });

    it('loses to an explicit releaseMode beside the legacy flag', async () => {
      const { result } = await run(makeProject({ config: { versionBumpEnabled: false, releaseMode: 'auto' } }));
      assert.equal(result.status, 'done');
    });
  });

  it('in a worktree with no Prawduct state, holds on the registered checkout\'s unfinished plan', async () => {
    const registered = makeProject({ config: { releaseMode: 'auto' }, plan: '- [ ] open' });
    const worktree = makeProject();
    const { result, staged } = await run({ name: registered.name, path: worktree.path, configPath: registered.path });
    assert.equal(result.status, 'skipped');
    assert.equal(result.output.readiness.verdict, 'not-ready');
    assert.deepEqual(staged, {});
  });

  it('keeps fail-closed guards ahead of the gate, so a hold never hides them', async () => {
    const project = makeProject({ config: { releaseMode: 'auto' }, plan: '- [ ] open' });
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '1.2.3.4' }));
    const { result } = await run(project);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /isn't MAJOR\.MINOR\.PATCH/);
    assert.equal(result.output.held, undefined);
  });
});
