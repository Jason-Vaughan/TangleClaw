'use strict';

// version-bump's release gate (#1492 L1 + L3 + L4): `releaseMode` decides whether a
// wrap may cut, the readiness verdict decides whether `auto` does, and the
// operator's Cut or Hold overrides both. A question only the operator can answer
// halts the wrap with `needs-operator`.
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

  const run = (project, options = {}, previousResults = []) => {
    const context = { project, step: { id: 'version-bump', kind: 'version-bump' }, staged: {}, options, previousResults };
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

    it('halts on an unknown verdict and asks the operator', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'auto' }, pointer: 'artifacts/missing.md' }));
      assert.equal(result.status, 'needs-operator');
      assert.equal(result.ok, false, 'an unanswered operator question stops the wrap');
      assert.equal(result.output.readiness.verdict, 'unknown');
      assert.equal(result.output.needsOperator, true);
      assert.match(result.output.reason, /release decision needed: readiness is unknown/);
      assert.deepEqual(result.blockers, [result.output.reason]);
      assert.deepEqual(staged, {});
    });

    it('holds on a Hold even when ready, and records it as the operator\'s call', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'auto' }, plan: '- [x] done' }), { release: 'hold' });
      assert.equal(result.status, 'skipped');
      assert.equal(result.ok, true);
      assert.equal(result.output.held, true);
      assert.equal(result.output.needsOperator, false);
      assert.equal(result.output.decidedBy, 'operator');
      assert.equal(result.output.readiness.verdict, 'ready');
      assert.match(result.output.reason, /held on the operator's decision/);
      assert.deepEqual(staged, {});
    });

    it('answers an unknown verdict with Cut, at the CHANGELOG level', async () => {
      const { result } = await run(makeProject({ config: { releaseMode: 'auto' }, pointer: 'artifacts/missing.md' }), { release: 'cut' });
      assert.equal(result.status, 'done');
      assert.equal(result.output.to, '1.3.0');
      assert.equal(result.output.decidedBy, 'operator');
      assert.match(result.output.detail, /cut on the operator's decision \(readiness: unknown\)/);
      assert.doesNotMatch(result.output.detail, /pick/, 'a Cut with no level is not a level pick');
    });

    it('answers an unknown verdict with Hold, and the wrap continues', async () => {
      const { result } = await run(makeProject({ config: { releaseMode: 'auto' }, pointer: 'artifacts/missing.md' }), { release: 'hold' });
      assert.equal(result.status, 'skipped');
      assert.equal(result.ok, true);
      assert.equal(result.output.decidedBy, 'operator');
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
    it('halts even when ready, and asks the operator with what would be cut', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'ask' }, plan: '- [x] done' }));
      assert.equal(result.status, 'needs-operator');
      assert.equal(result.ok, false);
      assert.equal(result.output.held, true);
      assert.equal(result.output.needsOperator, true);
      assert.equal(result.output.decidedBy, undefined, 'nobody has decided yet');
      assert.equal(result.output.readiness.verdict, 'ready');
      assert.match(result.output.reason, /releaseMode is ask/);
      assert.equal(result.output.remediation, 'Choose Cut or Hold below, then Retry.');
      assert.deepEqual(result.output.wouldBump, { from: '1.2.3', to: '1.3.0', bumpLevel: 'minor' });
      assert.deepEqual(staged, {});
    });

    it('cuts on Cut, at the CHANGELOG level', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'ask' }, plan: '- [x] done' }), { release: 'cut' });
      assert.equal(result.status, 'done');
      assert.equal(result.output.to, '1.3.0');
      assert.equal(result.output.decidedBy, 'operator');
      assert.ok(staged['version-bump:changelog']);
    });

    it('cuts on Cut with a picked level', async () => {
      const { result } = await run(makeProject({ config: { releaseMode: 'ask' } }), { release: 'cut', bumpLevel: 'patch' });
      assert.equal(result.status, 'done');
      assert.equal(result.output.to, '1.2.4');
    });

    it('holds on Hold without halting', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'ask' } }), { release: 'hold' });
      assert.equal(result.status, 'skipped');
      assert.equal(result.ok, true);
      assert.equal(result.output.decidedBy, 'operator');
      assert.equal(result.output.needsOperator, false);
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
      assert.equal(result.status, 'needs-operator');
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

    it('skips before reading a release decision, even an invalid one', async () => {
      const { result } = await run(makeProject({ config: { releaseMode: 'off' } }), { release: 'bogus' });
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /releaseMode is off/);
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

  describe('the release decision fails closed', () => {
    it('skips on a value outside cut/hold, naming it, before any file is read', async () => {
      const project = makeProject({ config: { releaseMode: 'ask' } });
      fs.rmSync(path.join(project.path, 'CHANGELOG.md'));
      const { result, staged } = await run(project, { release: 'Cut' });
      assert.equal(result.status, 'skipped');
      assert.equal(result.ok, true);
      assert.match(result.output.reason, /invalid release decision "Cut" — expected one of cut, hold/);
      assert.deepEqual(staged, {});
    });

    it('skips on Hold with a level, rather than choosing a half', async () => {
      const { result, staged } = await run(makeProject({ config: { releaseMode: 'auto' }, plan: '- [x] done' }), { release: 'hold', bumpLevel: 'minor' });
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /contradictory release decision: hold with bumpLevel "minor"/);
      assert.deepEqual(staged, {});
    });

    it('treats a null release as no decision', async () => {
      const { result } = await run(makeProject({ config: { releaseMode: 'ask' } }), { release: null });
      assert.equal(result.status, 'needs-operator');
    });
  });

  it('asks nothing of a project that can never be cut: a foreign scheme still skips', async () => {
    const project = makeProject({ config: { releaseMode: 'ask' } });
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '1.2.3.4' }));
    const { result } = await run(project);
    assert.equal(result.status, 'skipped');
    assert.equal(result.ok, true, 'a project that can never be cut is not asked whether to cut');
  });

  it('keeps fail-closed guards ahead of the gate, so a hold never hides them', async () => {
    const project = makeProject({ config: { releaseMode: 'auto' }, plan: '- [ ] open' });
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '1.2.3.4' }));
    const { result } = await run(project);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /isn't MAJOR\.MINOR\.PATCH/);
    assert.equal(result.output.held, undefined);
  });

  describe('the AI recommendation (#1492 L2)', () => {
    /**
     * The prior results a wrap leaves when the recommendation step captured.
     *
     * @param {string} value - What the AI wrote under `## ReleaseRecommendation`
     * @param {object} [extra] - `operatorIntent` / `reason`
     * @returns {object[]}
     */
    const advised = (value, extra = {}) => [
      { stepId: 'changelog-update', status: 'done', output: {} },
      { stepId: 'release-recommendation', status: 'done', output: { parsedFields: { releaseRecommendation: value, ...extra } } }
    ];
    const ready = () => makeProject({ config: { releaseMode: 'auto' }, plan: '- [x] done' });
    const notReady = () => makeProject({ config: { releaseMode: 'auto' }, plan: '- [x] one\n- [ ] two' });

    it('halts when the checks say ready and the AI recommends holding, quoting the operator', async () => {
      const { result, staged } = await run(ready(), {},
        advised('hold', { operatorIntent: '"wrapping to save state"', reason: 'mid-feature save' }));
      assert.equal(result.status, 'needs-operator');
      assert.equal(result.ok, false);
      assert.equal(result.output.disagreement, true);
      assert.equal(result.output.needsOperator, true);
      assert.match(result.output.reason, /checks say ready, but the AI recommends holding: you said "wrapping to save state"; mid-feature save/);
      assert.deepEqual(result.output.recommendation, {
        state: 'given', value: 'hold', operatorIntent: '"wrapping to save state"', reason: 'mid-feature save'
      });
      assert.deepEqual(result.output.wouldBump, { from: '1.2.3', to: '1.3.0', bumpLevel: 'minor' });
      assert.deepEqual(staged, {});
    });

    it('halts when the checks say not-ready and the AI recommends cutting', async () => {
      const { result, staged } = await run(notReady(), {}, advised('cut', { operatorIntent: '"cut a release"' }));
      assert.equal(result.status, 'needs-operator');
      assert.equal(result.output.disagreement, true);
      assert.match(result.output.reason, /checks say not-ready \(build-plan-status: 1 of 2 Status boxes unticked[^)]*\), but the AI recommends cutting: you said "cut a release"/);
      assert.deepEqual(staged, {});
    });

    it('cuts when both say release, and records the agreement', async () => {
      const { result, staged } = await run(ready(), {}, advised('cut'));
      assert.equal(result.status, 'done');
      assert.equal(result.output.decidedBy, 'readiness');
      assert.equal(result.output.recommendation.value, 'cut');
      assert.equal(result.output.disagreement, undefined);
      assert.ok(staged['version-bump:changelog']);
    });

    it('holds without halting when both say hold', async () => {
      const { result } = await run(notReady(), {}, advised('hold'));
      assert.equal(result.status, 'skipped');
      assert.equal(result.ok, true);
      assert.equal(result.output.needsOperator, false);
      assert.equal(result.output.recommendation.value, 'hold');
      assert.equal(result.output.disagreement, undefined);
    });

    it('leaves the verdict to decide alone when the AI is unsure, unreadable or absent', async () => {
      for (const prior of [advised('unsure'), advised('probably fine'), [], [{ stepId: 'release-recommendation', status: 'blocked', output: null, blockers: ['timed out'] }]]) {
        const cut = await run(ready(), {}, prior);
        assert.equal(cut.result.status, 'done', `ready cuts with ${JSON.stringify(prior)}`);
        const held = await run(notReady(), {}, prior);
        assert.equal(held.result.status, 'skipped');
        assert.equal(held.result.output.needsOperator, false);
      }
      const { result } = await run(ready(), {}, [{ stepId: 'release-recommendation', status: 'blocked', output: null, blockers: ['timed out'] }]);
      assert.deepEqual(result.output.recommendation, {
        state: 'absent', reason: 'the release-recommendation step did not finish (blocked): timed out'
      });
    });

    it('still halts on an unknown verdict, naming the AI\'s view as a hint', async () => {
      const project = makeProject({ config: { releaseMode: 'auto' }, pointer: 'artifacts/missing.md' });
      const { result } = await run(project, {}, advised('cut', { reason: 'feature complete' }));
      assert.equal(result.status, 'needs-operator');
      assert.equal(result.output.disagreement, undefined, 'no verdict to disagree with');
      assert.match(result.output.reason, /readiness is unknown .*; the AI recommends cut: feature complete$/);
    });

    it('in ask, carries the recommendation as a hint and never cuts on it', async () => {
      const project = makeProject({ config: { releaseMode: 'ask' }, plan: '- [x] done' });
      const { result, staged } = await run(project, {}, advised('cut'));
      assert.equal(result.status, 'needs-operator');
      assert.equal(result.output.disagreement, undefined);
      assert.match(result.output.reason, /releaseMode is ask.*; the AI recommends cut\)$/);
      assert.deepEqual(staged, {});
    });

    it('lets the operator\'s decision win over a disagreement', async () => {
      const hold = await run(ready(), { release: 'hold' }, advised('cut'));
      assert.equal(hold.result.status, 'skipped');
      assert.equal(hold.result.output.decidedBy, 'operator');
      const cut = await run(notReady(), { release: 'cut' }, advised('hold'));
      assert.equal(cut.result.status, 'done');
      assert.equal(cut.result.output.decidedBy, 'operator');
      assert.equal(cut.result.output.recommendation.value, 'hold', 'the overruled recommendation stays on the record');
    });
  });

  // #1738 — a release is the methodology's to authorize, so a session whose
  // engine cannot run it holds the cut outright, even over an operator Cut, and
  // leaves Prawduct's own ledger untouched.
  describe('methodology unavailable on this engine', () => {
    const dormant = { onboarded: true, available: false, disposition: 'capability-unavailable', engineId: 'gemini', capability: 'prawduct-methodology', reason: 'the gemini engine cannot run the Prawduct plugin' };
    const runOn = (project, options, methodology) => {
      const context = { project, step: { id: 'version-bump', kind: 'version-bump' }, staged: {}, options, previousResults: [], methodology };
      return versionBump.run(context).then((result) => ({ result, staged: context.staged }));
    };

    it('holds a ready auto cut, stages nothing, and leaves .prawduct/change-log.md byte-identical', async () => {
      const project = makeProject({ config: { releaseMode: 'auto' }, plan: '- [x] done' });
      const ledger = path.join(project.path, '.prawduct', 'change-log.md');
      const ledgerText = '<!-- prawduct: id=X status=merged -->\n';
      fs.writeFileSync(ledger, ledgerText);
      const { result, staged } = await runOn(project, {}, dormant);
      assert.equal(result.status, 'capability-unavailable');
      assert.equal(result.ok, true, 'a held release never blocks the checkpoint');
      assert.equal(result.output.engineId, 'gemini');
      assert.match(result.output.reason, /release held/);
      assert.deepEqual(staged, {});
      assert.equal(fs.readFileSync(ledger, 'utf8'), ledgerText);
      assert.match(fs.readFileSync(path.join(project.path, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\]\n\n### Added\n- a feature/);
    });

    it('holds even when the operator asked for a Cut', async () => {
      const { result, staged } = await runOn(makeProject({ config: { releaseMode: 'ask' } }), { release: 'cut' }, dormant);
      assert.equal(result.status, 'capability-unavailable');
      assert.deepEqual(staged, {});
    });

    it('still reports releaseMode off as the project\'s own choice', async () => {
      const { result } = await runOn(makeProject({ config: { releaseMode: 'off' } }), {}, dormant);
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /releaseMode is off/);
    });

    it('cuts as before when the engine can run the methodology', async () => {
      const available = { ...dormant, available: true, disposition: 'available', engineId: 'claude' };
      const { result } = await runOn(makeProject({ config: { releaseMode: 'auto' }, plan: '- [x] done' }), {}, available);
      assert.equal(result.status, 'done');
      assert.equal(result.output.to, '1.3.0');
    });
  });
});
