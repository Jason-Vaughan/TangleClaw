'use strict';

// The `release-recommendation` content step (#1492 L2) and the precondition seam
// that keeps it from prompting when nothing is left to decide. The handler and the
// runner's `step N of M` roster ask one predicate, so both are pinned here, on the
// tmux and gateway transports alike.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const aic = require('../lib/wrap-steps/ai-content');
const defaultPipeline = require('../lib/wrap-default-pipeline');
const wrapPipeline = require('../lib/wrap-pipeline');
const wrapStepOverrides = require('../lib/wrap-step-overrides');

const ENTRIES = '# Changelog\n\n## [Unreleased]\n\n### Added\n- a feature\n\n## [1.2.3] - 2026-09-01\n';
const EMPTY = '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-09-01\n';

describe('release-recommendation step', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-rec-step-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * @param {object} opts
   * @param {object} [opts.config] - `.tangleclaw/project.json`
   * @param {string} [opts.changelog] - CHANGELOG.md text
   * @returns {{name: string, path: string}}
   */
  function makeProject({ config, changelog = ENTRIES } = {}) {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'p-'));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    if (config) {
      fs.mkdirSync(path.join(dir, '.tangleclaw'));
      fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), JSON.stringify(config));
    }
    return { name: path.basename(dir), path: dir };
  }

  const shippedStep = () => defaultPipeline.steps().find((s) => s.id === 'release-recommendation');

  describe('the shipped step', () => {
    it('sits between changelog-update and version-bump as a non-blocking content step', () => {
      const ids = defaultPipeline.steps().map((s) => s.id);
      assert.equal(ids.indexOf('release-recommendation'), ids.indexOf('changelog-update') + 1);
      assert.equal(ids.indexOf('version-bump'), ids.indexOf('release-recommendation') + 1);
      const step = shippedStep();
      assert.equal(step.kind, 'ai-content');
      assert.equal(step.blocker, false, 'a recommendation that never arrives must not halt the wrap');
      assert.equal(step.allowOverride, true);
      assert.equal(step.precondition, 'release-decision-open');
      assert.equal(step.captureFile, '.tangleclaw/.release-recommendation.md');
      assert.deepEqual(step.captureFields, ['releaseRecommendation']);
      assert.deepEqual(step.optionalCaptureFields, ['operatorIntent', 'reason']);
    });

    it('asks for the operator\'s own words first, and every heading the capture parses', () => {
      const { prompt } = shippedStep();
      assert.match(prompt, /this conversation/);
      assert.match(prompt, /none stated/);
      assert.match(prompt, /\{sessionScope\}/);
      for (const heading of ['## ReleaseRecommendation', '## OperatorIntent', '## Reason']) {
        assert.ok(prompt.includes(heading), `prompt names ${heading}`);
      }
      assert.ok(prompt.includes('.tangleclaw/.release-recommendation.md'));
    });

    it('does not show the AI the readiness verdict it is compared against', () => {
      const { prompt } = shippedStep();
      assert.doesNotMatch(prompt, /not-ready|verdict|\{readiness/i,
        'an AI shown the verdict echoes it, and the disagreement check could never fire');
    });

    it('every precondition in the shipped pipeline names a registered predicate', () => {
      for (const step of defaultPipeline.steps()) {
        if (step.precondition === undefined) continue;
        assert.ok(Object.prototype.hasOwnProperty.call(aic.PRECONDITIONS, step.precondition),
          `${step.id} names ${step.precondition}`);
      }
    });

    it('a project cannot override the precondition away', () => {
      assert.ok(!Object.prototype.hasOwnProperty.call(wrapStepOverrides.OVERRIDABLE_FIELDS, 'precondition'));
      const resolved = wrapStepOverrides.resolveStep(shippedStep(), { 'release-recommendation': { precondition: null } });
      assert.equal(resolved.step.precondition, 'release-decision-open');
      assert.deepEqual(resolved.rejected, ['precondition']);
    });
  });

  describe('preconditionVerdict', () => {
    it('runs a step with no precondition', () => {
      assert.deepEqual(aic.preconditionVerdict({ id: 'x' }, null, {}), { open: true });
    });

    it('skips a step naming an unregistered precondition, and says it is a bug', () => {
      const out = aic.preconditionVerdict({ id: 'x', precondition: 'nope' }, makeProject(), {});
      assert.equal(out.open, false);
      assert.match(out.reason, /unknown precondition "nope" on x — a bug/);
      assert.equal(aic.preconditionVerdict({ id: 'x', precondition: 'toString' }, makeProject(), {}).open, false,
        'an inherited property is not a registered predicate');
    });
  });

  describe('the handler', () => {
    let saved;
    let sent;
    let bridgeSent;

    beforeEach(() => {
      saved = { ...aic._internal };
      sent = [];
      bridgeSent = [];
      aic._internal.sendKeys = (_s, text) => { sent.push(text); };
      aic._internal.bridgeSend = async () => { bridgeSent.push(true); return {}; };
      aic._internal.sleep = async () => {};
      aic._internal.newNonce = () => 'n0nce';
      aic._internal.readPaneTail = () => 'TCWRAP-DONE n0nce';
      aic._internal.capturePane = () => ({ lines: [] });
      aic._internal.rangeExec = () => { throw new Error('not a repo'); };
      aic._internal.listWrapRules = () => [];
    });

    afterEach(() => { Object.assign(aic._internal, saved); });

    const ctx = (project, session, options = {}) => ({
      project, session, step: shippedStep(), previousResults: [], staged: {}, options
    });

    for (const [label, session] of [['tmux', { tmuxSession: 'sess' }], ['gateway', { sessionMode: 'webui' }], ['no session', null]]) {
      it(`sends nothing when releaseMode is off (${label})`, async () => {
        const result = await aic.run(ctx(makeProject({ config: { releaseMode: 'off' } }), session));
        assert.equal(result.ok, true);
        assert.equal(result.status, 'skipped');
        assert.equal(result.output.precondition, 'release-decision-open');
        assert.match(result.output.reason, /releaseMode is off/);
        assert.deepEqual(sent, []);
        assert.deepEqual(bridgeSent, []);
      });
    }

    it('sends nothing once the operator chose, or when there is nothing to release', async () => {
      for (const [project, options, reason] of [
        [makeProject(), { release: 'hold' }, /you chose Hold/],
        [makeProject(), { bumpLevel: 'minor' }, /picked a minor release/],
        [makeProject({ changelog: EMPTY }), {}, /\[Unreleased\] has no entries/]
      ]) {
        const result = await aic.run(ctx(project, { tmuxSession: 'sess' }, options));
        assert.equal(result.status, 'skipped');
        assert.match(result.output.reason, reason);
      }
      assert.deepEqual(sent, []);
    });

    it('prompts when the decision is open, and reads the capture back', async () => {
      const project = makeProject({ config: { releaseMode: 'auto' } });
      aic._internal.readCaptureFile = () => '## ReleaseRecommendation\nhold\n\n## OperatorIntent\n"just saving state"\n\n## Reason\nmid-feature\n';
      aic._internal.removeCaptureFile = () => {};
      aic._internal.captureFileExists = () => false;
      const context = ctx(project, { tmuxSession: 'sess' });
      const result = await aic.run(context);
      assert.equal(sent.length, 1);
      assert.match(sent[0], /Recommend whether THIS wrap should cut a release/);
      assert.equal(result.status, 'done');
      assert.deepEqual(result.output.parsedFields, {
        releaseRecommendation: 'hold', operatorIntent: '"just saving state"', reason: 'mid-feature'
      });
    });
  });

  describe('the prompt roster', () => {
    const plan = (project, options = {}, session = { tmuxSession: 'sess' }) =>
      wrapPipeline._planAiContentPrompts(defaultPipeline.steps(), null, options, session, project);

    it('counts the step when the decision can still be open', () => {
      assert.deepEqual(plan(makeProject({ config: { releaseMode: 'ask' } })),
        ['changelog-update', 'release-recommendation', 'learnings-capture', 'memory-update']);
    });

    it('counts it while [Unreleased] is still empty, because changelog-update runs first', () => {
      assert.ok(plan(makeProject({ changelog: EMPTY })).includes('release-recommendation'));
    });

    it('leaves it out when releaseMode is off or the operator already chose', () => {
      assert.ok(!plan(makeProject({ config: { releaseMode: 'off' } })).includes('release-recommendation'));
      assert.ok(!plan(makeProject(), { release: 'cut' }).includes('release-recommendation'));
      assert.ok(!plan(makeProject(), { bumpLevel: 'patch' }).includes('release-recommendation'));
    });

    it('counts it on a gateway session, which can carry its capture file', () => {
      assert.deepEqual(plan(makeProject(), {}, { sessionMode: 'webui' }), ['release-recommendation', 'memory-update']);
    });
  });

  describe('through the runner, with the real content handler and version-bump', () => {
    let saved;
    let savedScope;
    let restoreHandlers;

    beforeEach(() => {
      saved = { ...aic._internal };
      savedScope = wrapPipeline._internal.resolveScope;
      wrapPipeline._internal.resolveScope = async (project) => ({ workTree: project.path, configRoot: project.path, baseline: null, lastWrapSha: null });
      const noop = { run: async () => ({ ok: true, status: 'done', output: null, blockers: [] }) };
      const originals = {};
      for (const kind of Object.keys(wrapPipeline.STEP_DISPATCH)) {
        if (kind === 'ai-content' || kind === 'version-bump') continue;
        originals[kind] = wrapPipeline.STEP_DISPATCH[kind];
        wrapPipeline.STEP_DISPATCH[kind] = noop;
      }
      restoreHandlers = () => Object.assign(wrapPipeline.STEP_DISPATCH, originals);
      aic._internal.sleep = async () => {};
      aic._internal.newNonce = () => 'n0nce';
      aic._internal.readPaneTail = () => 'TCWRAP-DONE n0nce';
      aic._internal.capturePane = () => ({ lines: [] });
      aic._internal.rangeExec = () => { throw new Error('not a repo'); };
      aic._internal.listWrapRules = () => [];
      aic._internal.captureFileExists = () => false;
      aic._internal.removeCaptureFile = () => {};
    });

    afterEach(() => {
      Object.assign(aic._internal, saved);
      wrapPipeline._internal.resolveScope = savedScope;
      restoreHandlers();
    });

    /**
     * Register an `auto` project that would cut 1.0.0 → 1.1.0 on ready checks.
     *
     * @param {string} name
     * @returns {void}
     */
    function registerProject(name) {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(path.join(dir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), JSON.stringify({ releaseMode: 'auto' }));
      fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.0.0' }));
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n- a feature\n\n## [1.0.0] - 2026-09-01\n\n- first\n');
      store.projects.create({ name, path: dir });
    }

    const skipOthers = { 'changelog-update': true, 'learnings-capture': true, 'memory-update': true };

    it('a written hold halts ready checks at version-bump, carrying what the AI wrote', async () => {
      registerProject('rec-e2e-hold');
      const sentTo = [];
      aic._internal.sendKeys = (_s, text) => { sentTo.push(text.split('\n')[0]); };
      aic._internal.readCaptureFile = (_p, file) => {
        assert.equal(file, '.tangleclaw/.release-recommendation.md');
        return '## ReleaseRecommendation\n**hold**\n\n## OperatorIntent\n"wrapping to save state before I leave"\n\n## Reason\nThe feature is half-built.\n';
      };
      const result = await wrapPipeline.runWrapPipeline('rec-e2e-hold', {
        session: { id: 1, tmuxSession: 'sess' },
        skipAiContent: skipOthers
      });
      assert.deepEqual(sentTo, ['[TangleClaw wrap — step 1 of 1: release-recommendation]']);
      assert.equal(result.blockedAt, 'version-bump');
      const bump = result.results.find((r) => r.stepId === 'version-bump');
      assert.equal(bump.status, 'needs-operator');
      assert.equal(bump.output.disagreement, true);
      assert.deepEqual(bump.output.recommendation, {
        state: 'given', value: 'hold', operatorIntent: '"wrapping to save state before I leave"', reason: 'The feature is half-built.'
      });
      assert.equal(result.results.find((r) => r.stepId === 'commit').status, 'pending');
    });

    it('an unreadable answer lets ready checks cut, and says why there was no recommendation', async () => {
      registerProject('rec-e2e-garbled');
      aic._internal.sendKeys = () => {};
      aic._internal.readCaptureFile = () => '## ReleaseRecommendation\nmaybe later\n';
      const result = await wrapPipeline.runWrapPipeline('rec-e2e-garbled', {
        session: { id: 1, tmuxSession: 'sess' },
        skipAiContent: skipOthers
      });
      assert.equal(result.blockedAt, null);
      const bump = result.results.find((r) => r.stepId === 'version-bump');
      assert.equal(bump.status, 'done');
      assert.equal(bump.output.to, '1.1.0');
      assert.equal(bump.output.recommendation.state, 'absent');
      assert.match(bump.output.recommendation.reason, /"maybe later"/);
    });
  });
});
