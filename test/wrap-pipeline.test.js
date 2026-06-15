'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const wrapPipeline = require('../lib/wrap-pipeline');

describe('wrap-pipeline (#139 Chunk 3)', () => {
  let tmpDir;
  let projectPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-pipeline-'));
    store._setBasePath(tmpDir);
    store.init();

    projectPath = path.join(tmpDir, 'pipeline-test');
    fs.mkdirSync(projectPath, { recursive: true });
    store.projects.create({
      name: 'pipeline-test',
      path: projectPath,
      methodology: 'prawduct'
    });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('STEP_DISPATCH', () => {
    it('covers every step kind referenced by the contract (ADR 0002 dispatch table)', () => {
      const expected = [
        'pr-check', 'lint', 'test', 'critic-check',
        'ai-content', 'priming-roll', 'version-bump', 'features-toc', 'commit'
      ];
      for (const kind of expected) {
        assert.ok(wrapPipeline.STEP_DISPATCH[kind],
          `dispatch table must have a handler for kind="${kind}" (ADR 0002 step-kind table)`);
        assert.equal(typeof wrapPipeline.STEP_DISPATCH[kind].run, 'function',
          `handler for "${kind}" must expose async run(context)`);
      }
    });

    it('covers every kind referenced by bundled prawduct + minimal templates', () => {
      // Cross-pin: anything a bundled template references must dispatch.
      // If a future bundled change adds a new kind, this test fails until
      // the dispatch table catches up.
      const prawduct = store.templates.get('prawduct');
      const minimal = store.templates.get('minimal');
      const kinds = new Set();
      for (const step of (prawduct.wrap_pipeline.steps || [])) kinds.add(step.kind);
      for (const step of (minimal.wrap_pipeline.steps || [])) kinds.add(step.kind);
      for (const kind of kinds) {
        assert.ok(wrapPipeline.STEP_DISPATCH[kind],
          `bundled template references kind="${kind}" but no handler exists`);
      }
    });
  });

  describe('runWrapPipeline — no-op stubs', () => {
    it('runs all stubs end-to-end and returns ok:true', async () => {
      // Chunks 4+ replaced no-op stubs with real handlers (lint, test,
      // ai-content, priming-roll, critic-check, pr-check, commit) that
      // require live OS state (a configured command, a tmux session, a
      // git repo, etc). To keep this regression test focused on the
      // *runner skeleton* — "the pipeline can iterate every step end-to-
      // end and aggregate results" — we monkey-patch every real-handler
      // dispatch entry to the canonical no-op result for this test only.
      // The real-handler behavior is covered by per-handler describes
      // below.
      const realKinds = ['lint', 'test', 'ai-content', 'priming-roll', 'critic-check', 'pr-check', 'commit', 'version-bump', 'features-toc', 'continuity-write'];
      const originals = {};
      const noopRun = async () => ({ ok: true, status: 'done', output: null, blockers: [] });
      for (const kind of realKinds) {
        originals[kind] = wrapPipeline.STEP_DISPATCH[kind];
        wrapPipeline.STEP_DISPATCH[kind] = { run: noopRun };
      }

      try {
        const result = await wrapPipeline.runWrapPipeline('pipeline-test');
        assert.equal(result.ok, true);
        assert.equal(result.blockedAt, null);
        assert.equal(result.commitSha, null);
        assert.equal(result.summary, null);
        assert.equal(result.error, null);
        // #207 Chunk 3 added `features-toc` between `next-session-prime`
        // and `memory-update`; CC-1 appended `continuity-write` after
        // `commit` — prawduct now ships 10 pipeline steps.
        assert.equal(result.results.length, 10, 'prawduct has ten pipeline steps');
        for (const stepResult of result.results) {
          assert.equal(stepResult.status, 'done');
          assert.deepStrictEqual(stepResult.blockers, []);
        }
      } finally {
        for (const kind of realKinds) {
          wrapPipeline.STEP_DISPATCH[kind] = originals[kind];
        }
      }
    });

    it('preserves step ID order from the methodology template', async () => {
      const result = await wrapPipeline.runWrapPipeline('pipeline-test');
      assert.deepStrictEqual(
        result.results.map((r) => r.stepId),
        ['open-pr-check', 'critic-check', 'version-bump', 'changelog-update', 'learnings-capture', 'next-session-prime', 'features-toc', 'memory-update', 'commit', 'continuity-write']
      );
    });

    it('attaches `kind` to each result for the multi-step UI (Chunk 10)', async () => {
      const result = await wrapPipeline.runWrapPipeline('pipeline-test');
      const kinds = result.results.map((r) => r.kind);
      assert.deepStrictEqual(kinds,
        ['pr-check', 'critic-check', 'version-bump', 'ai-content', 'ai-content', 'priming-roll', 'features-toc', 'ai-content', 'commit', 'continuity-write']);
    });

    it('runner is transactionally inert — every stub receives an empty staged scratch and no step writes to it', async () => {
      // Inertness pin (Chunk 3 Critic nit #1). Real handlers in
      // Chunks 4–9 will write to `context.staged`; the `commit` step
      // in Chunk 9 will flush. Until then `staged` must stay {} after
      // every step. We capture the live reference each stub sees and
      // assert the post-run state.
      const capturedStaged = [];
      const wrapKinds = ['pr-check', 'lint', 'test', 'critic-check', 'ai-content', 'priming-roll', 'version-bump', 'features-toc', 'commit'];
      const originals = {};
      for (const kind of wrapKinds) {
        originals[kind] = wrapPipeline.STEP_DISPATCH[kind];
        wrapPipeline.STEP_DISPATCH[kind] = {
          run: async (ctx) => {
            capturedStaged.push(ctx.staged);
            return { ok: true, status: 'done', output: null, blockers: [] };
          }
        };
      }

      try {
        await wrapPipeline.runWrapPipeline('pipeline-test');
        assert.equal(capturedStaged.length, 9, 'every prawduct step receives a context');
        // All captured references must be the SAME object (single-transaction
        // shared scratch) AND must remain {} (no step wrote to it).
        for (let i = 0; i < capturedStaged.length; i++) {
          assert.deepStrictEqual(capturedStaged[i], {},
            `step ${i} must observe an empty staged scratch`);
          assert.strictEqual(capturedStaged[i], capturedStaged[0],
            `step ${i} must share the same staged reference as step 0 (single-transaction)`);
        }
      } finally {
        for (const kind of wrapKinds) {
          wrapPipeline.STEP_DISPATCH[kind] = originals[kind];
        }
      }
    });
  });

  describe('runWrapPipeline — preflight errors', () => {
    it('returns ok:false when project does not exist', async () => {
      const result = await wrapPipeline.runWrapPipeline('does-not-exist');
      assert.equal(result.ok, false);
      assert.equal(result.results.length, 0);
      assert.match(result.error, /not found/i);
    });

    it('returns ok:false when methodology has no wrap_pipeline block', async () => {
      // Synthesize a project pointing at a methodology that lacks the
      // new schema entirely — represents a methodology authored before
      // #139 lands or a malformed live template.
      const noPipelinePath = path.join(tmpDir, 'no-pipeline-test');
      fs.mkdirSync(noPipelinePath, { recursive: true });
      store.projects.create({
        name: 'no-pipeline-test',
        path: noPipelinePath,
        methodology: 'minimal'
      });
      // Snapshot the original minimal so we can restore it byte-equal —
      // any subsequent test that reads minimal must see the bundled state.
      const minimalBackup = JSON.parse(JSON.stringify(store.templates.get('minimal')));
      const minimalBroken = JSON.parse(JSON.stringify(minimalBackup));
      delete minimalBroken.wrap_pipeline;
      store.templates.save(minimalBroken);

      try {
        const result = await wrapPipeline.runWrapPipeline('no-pipeline-test');
        assert.equal(result.ok, false);
        assert.match(result.error, /wrap_pipeline\.steps/);
      } finally {
        store.templates.save(minimalBackup);
      }
    });
  });

  describe('runWrapPipeline — block semantics', () => {
    it('halts the pipeline when a blocker:true step returns ok:false', async () => {
      // Inject a failing handler for one kind, restore afterwards.
      const original = wrapPipeline.STEP_DISPATCH['ai-content'];
      wrapPipeline.STEP_DISPATCH['ai-content'] = {
        run: async () => ({ ok: false, status: 'blocked', output: null, blockers: ['simulated lint failure'] })
      };

      // Synthesize a project on a methodology whose ai-content step
      // declares blocker:true. We monkey-patch the live template in place
      // so the runner sees the elevated blocker setting on the wire.
      // (#328: content ai-content steps already ship blocker:true; setting it
      // here is now redundant but harmless, and we restore from the pristine
      // snapshot so the bundled blocker:true survives for sibling tests.)
      const pristine = JSON.stringify(store.templates.get('prawduct'));
      const prawduct = JSON.parse(pristine);
      const aiStep = prawduct.wrap_pipeline.steps.find((s) => s.kind === 'ai-content');
      aiStep.blocker = true;
      const blockingPath = path.join(tmpDir, 'block-test');
      fs.mkdirSync(blockingPath, { recursive: true });
      store.projects.create({
        name: 'block-test',
        path: blockingPath,
        methodology: 'prawduct'
      });
      // Need to write the modified template so the runner reads it.
      store.templates.save(prawduct);

      try {
        const result = await wrapPipeline.runWrapPipeline('block-test');
        assert.equal(result.ok, false);
        assert.equal(result.blockedAt, aiStep.id);

        const blockingResult = result.results.find((r) => r.stepId === aiStep.id);
        assert.equal(blockingResult.status, 'blocked');
        assert.deepStrictEqual(blockingResult.blockers, ['simulated lint failure']);

        // Steps after the blocked step must be marked 'pending'.
        const blockedIdx = result.results.findIndex((r) => r.stepId === aiStep.id);
        for (let i = blockedIdx + 1; i < result.results.length; i++) {
          assert.equal(result.results[i].status, 'pending',
            `step ${result.results[i].stepId} after block must be pending`);
        }
      } finally {
        wrapPipeline.STEP_DISPATCH['ai-content'] = original;
        // Restore the pristine bundled prawduct template (a `delete` would
        // strip the now-bundled blocker:true off the first content step).
        store.templates.save(JSON.parse(pristine));
      }
    });

    it('bundled prawduct ships blocker:true + allowOverride:true on all 3 content steps (#328)', () => {
      const prawduct = store.templates.get('prawduct');
      const contentIds = ['changelog-update', 'learnings-capture', 'memory-update'];
      for (const id of contentIds) {
        const step = prawduct.wrap_pipeline.steps.find((s) => s.id === id);
        assert.ok(step, `bundled prawduct must declare the ${id} step`);
        assert.equal(step.kind, 'ai-content');
        assert.equal(step.blocker, true, `${id} must be a blocker so a failure halts before commit`);
        assert.equal(step.allowOverride, true, `${id} must allow the Skip & note override`);
      }
      // commit stays after them so a halt prevents the commit.
      const ids = prawduct.wrap_pipeline.steps.map((s) => s.id);
      assert.ok(ids.indexOf('memory-update') < ids.indexOf('commit'),
        'commit must come after the content steps for the halt to gate it');
    });

    it('does NOT halt when blocker:false step returns ok:false', async () => {
      // The runner only acts on boolean blocker:true. Enum-style
      // blockers (e.g. "errors-only") are handled inside the handler;
      // a !ok with blocker:false is informational, pipeline continues.
      const original = wrapPipeline.STEP_DISPATCH['ai-content'];
      const origCommit = wrapPipeline.STEP_DISPATCH['commit'];
      wrapPipeline.STEP_DISPATCH['ai-content'] = {
        run: async () => ({ ok: false, status: 'done', output: null, blockers: ['informational only'] })
      };
      // Stub the real commit handler — this test's project is not a git repo.
      wrapPipeline.STEP_DISPATCH['commit'] = {
        run: async () => ({ ok: true, status: 'done', output: null, blockers: [] })
      };
      // #328: the bundled prawduct ai-content content steps are now
      // blocker:true. Force them blocker:false on a local copy so this test
      // exercises the runner's blocker:false branch (not the new default).
      const pristine = JSON.stringify(store.templates.get('prawduct'));
      const prawduct = JSON.parse(pristine);
      prawduct.wrap_pipeline.steps
        .filter((s) => s.kind === 'ai-content')
        .forEach((s) => { s.blocker = false; });
      store.templates.save(prawduct);

      try {
        const result = await wrapPipeline.runWrapPipeline('pipeline-test');
        assert.equal(result.ok, true,
          'pipeline should complete despite a non-blocking failing step');
        assert.equal(result.blockedAt, null);
      } finally {
        store.templates.save(JSON.parse(pristine));
        wrapPipeline.STEP_DISPATCH['ai-content'] = original;
        wrapPipeline.STEP_DISPATCH['commit'] = origCommit;
      }
    });

    it('catches a handler that throws and treats it as a blocker (with explanatory blocker entry)', async () => {
      const original = wrapPipeline.STEP_DISPATCH['version-bump'];
      wrapPipeline.STEP_DISPATCH['version-bump'] = {
        run: async () => { throw new Error('boom from version-bump'); }
      };
      // Mark version-bump as blocker:true on a local prawduct copy.
      const prawduct = JSON.parse(JSON.stringify(store.templates.get('prawduct')));
      const step = prawduct.wrap_pipeline.steps.find((s) => s.kind === 'version-bump');
      step.blocker = true;
      store.templates.save(prawduct);

      try {
        const result = await wrapPipeline.runWrapPipeline('pipeline-test');
        assert.equal(result.ok, false);
        assert.equal(result.blockedAt, step.id);
        const blockingResult = result.results.find((r) => r.stepId === step.id);
        assert.equal(blockingResult.status, 'blocked');
        assert.ok(blockingResult.blockers[0].includes('boom from version-bump'),
          'thrown error message must surface in blockers[]');
      } finally {
        wrapPipeline.STEP_DISPATCH['version-bump'] = original;
        delete step.blocker;
        store.templates.save(prawduct);
      }
    });
  });

  describe('runWrapPipeline — unknown kinds', () => {
    it('skips unknown kinds without dispatching (forward-compat with future bundled changes)', async () => {
      // Add an unknown-kind step to a local prawduct copy.
      const prawduct = JSON.parse(JSON.stringify(store.templates.get('prawduct')));
      prawduct.wrap_pipeline.steps.unshift(
        { id: 'future-step', kind: 'not-yet-implemented' }
      );
      store.templates.save(prawduct);

      // Stub the real commit handler — this test's project is not a git repo.
      const origCommit = wrapPipeline.STEP_DISPATCH['commit'];
      wrapPipeline.STEP_DISPATCH['commit'] = {
        run: async () => ({ ok: true, status: 'done', output: null, blockers: [] })
      };
      // #328: ai-content content steps are blocker:true and would halt on the
      // real no-tmux handler's ok:false — stub them to isolate the
      // unknown-kind behavior this test actually asserts.
      const origAi = wrapPipeline.STEP_DISPATCH['ai-content'];
      wrapPipeline.STEP_DISPATCH['ai-content'] = {
        run: async () => ({ ok: true, status: 'done', output: null, blockers: [] })
      };

      try {
        const result = await wrapPipeline.runWrapPipeline('pipeline-test');
        assert.equal(result.ok, true,
          'unknown-kind skip must not block the pipeline');
        const skipped = result.results.find((r) => r.stepId === 'future-step');
        assert.equal(skipped.status, 'skipped');
        assert.deepStrictEqual(skipped.blockers, []);
      } finally {
        prawduct.wrap_pipeline.steps.shift();
        store.templates.save(prawduct);
        wrapPipeline.STEP_DISPATCH['commit'] = origCommit;
        wrapPipeline.STEP_DISPATCH['ai-content'] = origAi;
      }
    });
  });
});

describe('wrap-pipeline step stubs (#139 Chunk 3) — all kinds now real', () => {
  // Stubs that returned the canonical no-op result existed only during
  // the #139 build-out: `lint` + `test` left in Chunk 4; `ai-content`
  // in Chunk 5; `priming-roll` in Chunk 6; `critic-check` in Chunk 7;
  // `pr-check` in Chunk 8; `commit` in Chunk 9; `version-bump` was
  // the last stub and shipped its real handler in open-queue #3
  // (post-#139). Per-handler real-behavior tests live in their own
  // describe blocks above and below.
  const kinds = []; // empty after open-queue #3 closed

  for (const kind of kinds) {
    it(`${kind} returns the canonical {ok:true,status:'done',output:null,blockers:[]}`, async () => {
      const handler = require(`../lib/wrap-steps/${kind}`);
      const result = await handler.run({});
      assert.deepStrictEqual(result, { ok: true, status: 'done', output: null, blockers: [] });
    });
  }

  // Milestone pin: if a future chunk introduces a new stub, add its
  // kind to the array above so the canonical no-op shape stays
  // enforced AND the reminder to replace it is visible in this block.
  it('every wrap-step kind has a real (non-stub) handler as of open-queue #3', () => {
    assert.equal(kinds.length, 0,
      'open-queue #3 replaced the last stub; future stubs must be added to this list');
  });
});

// ── #139 Chunk 4: real `test` and `lint` step handlers ──

describe('wrap-step test (#139 Chunk 4)', () => {
  const testStep = require('../lib/wrap-steps/test');
  let tmpDir;
  let projectPath;
  let originalExec;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-step-test-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    projectPath = path.join(tmpDir, 'sandbox');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(path.join(projectPath, '.tangleclaw'), { recursive: true });
    store.projects.create({
      name: 'test-step-sandbox',
      path: projectPath,
      methodology: 'prawduct'
    });
    originalExec = testStep._internal.execShell;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Reset projConfig and exec stub between tests so each case starts clean.
    testStep._internal.execShell = originalExec;
    const cfgPath = path.join(projectPath, '.tangleclaw', 'project.json');
    if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
  });

  /**
   * Build a minimal context object that satisfies the handler's contract.
   * @param {object} step - Step spec (`blocker`, `allowOverride`, ...)
   * @param {object} [options] - Caller options (`skipTests`, ...)
   */
  function buildContext(step, options) {
    return {
      project: store.projects.getByName('test-step-sandbox'),
      session: null,
      step,
      previousResults: [],
      staged: {},
      options: options || {}
    };
  }

  /**
   * Write a projConfig with the given fields merged onto defaults.
   * @param {object} overrides
   */
  function writeConfig(overrides) {
    const cfgPath = path.join(projectPath, '.tangleclaw', 'project.json');
    fs.writeFileSync(cfgPath, JSON.stringify(overrides));
  }

  it('skips when projConfig.testCommand is null (default)', async () => {
    const result = await testStep.run(buildContext({ id: 'test', blocker: true }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /no testCommand/);
    assert.deepStrictEqual(result.blockers, []);
  });

  it('marks status done with exitCode 0 when the command passes', async () => {
    writeConfig({ testCommand: 'npm test' });
    testStep._internal.execShell = async (cmd, opts) => {
      assert.equal(cmd, 'npm test');
      assert.equal(opts.cwd, projectPath);
      return { exitCode: 0, stdout: 'all green\n', stderr: '', error: null };
    };
    const result = await testStep.run(buildContext({ id: 'test', blocker: true }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.deepStrictEqual(result.output, { exitCode: 0 });
    assert.deepStrictEqual(result.blockers, []);
  });

  it('returns ok:false blocked with stderr tail on non-zero exit', async () => {
    writeConfig({ testCommand: 'pytest' });
    testStep._internal.execShell = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'FAILED test_foo.py::test_bar\nAssertionError: 1 != 2\n',
      error: null
    });
    const result = await testStep.run(buildContext({ id: 'test', blocker: true }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.output.exitCode, 1);
    assert.ok(result.blockers[0].includes('Tests failed (exit 1)'));
    assert.ok(result.blockers.some((b) => b.includes('AssertionError')),
      'stderr tail must appear in blockers[]');
    // #223 — blocked output carries operator remediation for the drawer.
    assert.equal(typeof result.output.remediation, 'string');
    assert.ok(result.output.remediation.includes('skip tests'),
      'test remediation must mention the skip-tests override');
  });

  it('honors allowOverride+skipTests by reporting skipped with override flag', async () => {
    writeConfig({ testCommand: 'npm test' });
    let execCalled = false;
    testStep._internal.execShell = async () => {
      execCalled = true;
      return { exitCode: 0, stdout: '', stderr: '', error: null };
    };
    const result = await testStep.run(buildContext(
      { id: 'test', blocker: true, allowOverride: true },
      { skipTests: true }
    ));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.equal(result.output.override, true);
    assert.equal(execCalled, false, 'must not exec when override applies');
  });

  it('ignores skipTests when step does not declare allowOverride', async () => {
    writeConfig({ testCommand: 'npm test' });
    let execCalled = false;
    testStep._internal.execShell = async () => {
      execCalled = true;
      return { exitCode: 0, stdout: '', stderr: '', error: null };
    };
    const result = await testStep.run(buildContext(
      { id: 'test', blocker: true }, // no allowOverride
      { skipTests: true }
    ));
    assert.equal(execCalled, true, 'must still exec — override not allowed by step spec');
    assert.equal(result.status, 'done');
  });
});

describe('wrap-step lint (#139 Chunk 4)', () => {
  const lintStep = require('../lib/wrap-steps/lint');
  let tmpDir;
  let projectPath;
  let originalExec;
  let originalDetect;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-step-lint-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    projectPath = path.join(tmpDir, 'sandbox');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(path.join(projectPath, '.tangleclaw'), { recursive: true });
    store.projects.create({
      name: 'lint-step-sandbox',
      path: projectPath,
      methodology: 'prawduct'
    });
    originalExec = lintStep._internal.execShell;
    originalDetect = lintStep._internal.detectChangedFiles;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    lintStep._internal.execShell = originalExec;
    lintStep._internal.detectChangedFiles = originalDetect;
    const cfgPath = path.join(projectPath, '.tangleclaw', 'project.json');
    if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
  });

  /**
   * Build a minimal context for the lint handler.
   * @param {object} step
   */
  function buildContext(step) {
    return {
      project: store.projects.getByName('lint-step-sandbox'),
      session: null,
      step,
      previousResults: [],
      staged: {},
      options: {}
    };
  }

  /**
   * Write a projConfig with the given fields merged onto defaults.
   * @param {object} overrides
   */
  function writeConfig(overrides) {
    const cfgPath = path.join(projectPath, '.tangleclaw', 'project.json');
    fs.writeFileSync(cfgPath, JSON.stringify(overrides));
  }

  it('skips when projConfig.lintCommand is null', async () => {
    const result = await lintStep.run(buildContext({ id: 'lint', blocker: 'errors-only' }));
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /no lintCommand/);
  });

  it('skips when no files changed in session', async () => {
    writeConfig({ lintCommand: 'eslint' });
    lintStep._internal.detectChangedFiles = async () => [];
    const result = await lintStep.run(buildContext({ id: 'lint', blocker: 'errors-only' }));
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /no in-session changes/);
  });

  it('returns ok:false blocked on exit ≠ 0 with blocker:"errors-only"', async () => {
    writeConfig({ lintCommand: 'eslint' });
    lintStep._internal.detectChangedFiles = async () => ['src/foo.js', 'src/bar.js'];
    let observedCmd;
    lintStep._internal.execShell = async (cmd) => {
      observedCmd = cmd;
      return { exitCode: 1, stdout: 'src/foo.js:3 error\n', stderr: '', error: null };
    };
    const result = await lintStep.run(buildContext({ id: 'lint', blocker: 'errors-only' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.output.filesLinted, 2);
    assert.ok(observedCmd.includes("'src/foo.js'") && observedCmd.includes("'src/bar.js'"),
      'file paths must be single-quoted when appended to the command');
    assert.ok(observedCmd.includes(' -- '),
      '`--` end-of-options separator must precede file args (defense against filenames like "-rf.js")');
    assert.ok(result.blockers[0].includes('Lint failed (exit 1)'));
    // #223 — blocked output carries operator remediation for the drawer.
    assert.equal(typeof result.output.remediation, 'string');
    assert.ok(result.output.remediation.toLowerCase().includes('lint'),
      'lint remediation must reference fixing lint errors');
  });

  it('returns ok:true done on exit 0 (warnings or clean) with blocker:"errors-only"', async () => {
    writeConfig({ lintCommand: 'eslint' });
    lintStep._internal.detectChangedFiles = async () => ['src/foo.js'];
    lintStep._internal.execShell = async () => ({
      exitCode: 0,
      stdout: 'src/foo.js:5 warning\n',
      stderr: '',
      error: null
    });
    const result = await lintStep.run(buildContext({ id: 'lint', blocker: 'errors-only' }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.equal(result.output.filesLinted, 1);
    assert.match(result.output.warnings, /warning/);
  });

  it('with blocker:false, exit ≠ 0 stays informational (ok:true done)', async () => {
    writeConfig({ lintCommand: 'eslint' });
    lintStep._internal.detectChangedFiles = async () => ['src/foo.js'];
    lintStep._internal.execShell = async () => ({
      exitCode: 1,
      stdout: 'src/foo.js:3 error\n',
      stderr: '',
      error: null
    });
    const result = await lintStep.run(buildContext({ id: 'lint', blocker: false }));
    assert.equal(result.ok, true, 'blocker:false must keep ok:true even on lint errors');
    assert.equal(result.status, 'done');
    assert.match(result.output.warnings, /error/);
  });

  it('shell-quotes file paths containing spaces and single quotes', async () => {
    // Direct unit test of the quoting helper — visible from public API
    // so the test pins the contract.
    assert.equal(lintStep._shellQuote('simple.js'), "'simple.js'");
    assert.equal(lintStep._shellQuote('with space.js'), "'with space.js'");
    assert.equal(lintStep._shellQuote("it's.js"), "'it'\\''s.js'");
  });

  it('detectChangedFiles returns the working-tree change set against a real git repo', async () => {
    // Integration test — exercises the real `git status --porcelain` path
    // against a throwaway repo to guard against parsing regressions.
    const realRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-step-lint-realgit-'));
    try {
      const { execSync } = require('node:child_process');
      execSync('git init --quiet', { cwd: realRepo });
      execSync('git config user.email t@example.com && git config user.name Test',
        { cwd: realRepo, shell: '/bin/sh' });
      fs.writeFileSync(path.join(realRepo, 'tracked.js'), 'console.log(1)\n');
      execSync('git add tracked.js && git commit --quiet -m init',
        { cwd: realRepo, shell: '/bin/sh' });
      // Modify the tracked file and add an untracked one.
      fs.writeFileSync(path.join(realRepo, 'tracked.js'), 'console.log(2)\n');
      fs.writeFileSync(path.join(realRepo, 'new.js'), 'console.log(3)\n');

      const files = await originalDetect(realRepo);
      assert.ok(files.includes('tracked.js'), 'modified tracked file must appear');
      assert.ok(files.includes('new.js'), 'untracked file must appear');
    } finally {
      fs.rmSync(realRepo, { recursive: true, force: true });
    }
  });
});

describe('runWrapPipeline — "errors-only" blocker (#139 Chunk 4)', () => {
  let tmpDir;
  let projectPath;
  const wrapPipelineMod = require('../lib/wrap-pipeline');

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pipeline-errors-only-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });
    store.projects.create({
      name: 'errors-only-test',
      path: projectPath,
      methodology: 'prawduct'
    });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('halts the pipeline when a `blocker: "errors-only"` step returns ok:false', async () => {
    const original = wrapPipelineMod.STEP_DISPATCH['ai-content'];
    wrapPipelineMod.STEP_DISPATCH['ai-content'] = {
      run: async () => ({ ok: false, status: 'blocked', output: null, blockers: ['simulated error'] })
    };
    const pristine = JSON.stringify(store.templates.get('prawduct'));
    const prawduct = JSON.parse(pristine);
    const aiStep = prawduct.wrap_pipeline.steps.find((s) => s.kind === 'ai-content');
    aiStep.blocker = 'errors-only';
    store.templates.save(prawduct);

    try {
      const result = await wrapPipelineMod.runWrapPipeline('errors-only-test');
      assert.equal(result.ok, false);
      assert.equal(result.blockedAt, aiStep.id,
        '"errors-only" must halt the pipeline on !ok (Chunk 4 contract)');
    } finally {
      wrapPipelineMod.STEP_DISPATCH['ai-content'] = original;
      // Restore pristine — a `delete` would strip the bundled blocker:true
      // off the first content step (#328).
      store.templates.save(JSON.parse(pristine));
    }
  });

  it('does NOT halt for a non-blocker enum value', async () => {
    const original = wrapPipelineMod.STEP_DISPATCH['ai-content'];
    const origCommit = wrapPipelineMod.STEP_DISPATCH['commit'];
    wrapPipelineMod.STEP_DISPATCH['ai-content'] = {
      run: async () => ({ ok: false, status: 'done', output: null, blockers: [] })
    };
    // Stub the real commit handler — this test's project is not a git repo.
    wrapPipelineMod.STEP_DISPATCH['commit'] = {
      run: async () => ({ ok: true, status: 'done', output: null, blockers: [] })
    };
    // #328: ALL ai-content content steps are blocker:true by default, and the
    // stub above returns ok:false for every ai-content step — so a later
    // still-blocker:true step would halt even if the first is set to a
    // non-enum value. Set every ai-content step to the unrecognized enum.
    const pristine = JSON.stringify(store.templates.get('prawduct'));
    const prawduct = JSON.parse(pristine);
    prawduct.wrap_pipeline.steps
      .filter((s) => s.kind === 'ai-content')
      .forEach((s) => { s.blocker = 'not-a-recognized-enum'; });
    store.templates.save(prawduct);

    try {
      const result = await wrapPipelineMod.runWrapPipeline('errors-only-test');
      assert.equal(result.ok, true,
        'unrecognized blocker enums must NOT halt — only "true" and "errors-only" do');
      assert.equal(result.blockedAt, null);
    } finally {
      wrapPipelineMod.STEP_DISPATCH['ai-content'] = original;
      wrapPipelineMod.STEP_DISPATCH['commit'] = origCommit;
      store.templates.save(JSON.parse(pristine));
    }
  });
});

describe('runWrapPipeline — options threading (#139 Chunk 4)', () => {
  let tmpDir;
  let projectPath;
  const wrapPipelineMod = require('../lib/wrap-pipeline');

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pipeline-options-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });
    store.projects.create({
      name: 'options-test',
      path: projectPath,
      methodology: 'prawduct'
    });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('forwards `options` to each step handler via context.options', async () => {
    const seen = [];
    const original = wrapPipelineMod.STEP_DISPATCH['ai-content'];
    wrapPipelineMod.STEP_DISPATCH['ai-content'] = {
      run: async (ctx) => {
        seen.push(ctx.options);
        return { ok: true, status: 'done', output: null, blockers: [] };
      }
    };

    try {
      const opts = { skipTests: true, customMarker: 'flag-A' };
      await wrapPipelineMod.runWrapPipeline('options-test', opts);
      assert.ok(seen.length >= 1, 'at least one ai-content step must run');
      for (const seenOpts of seen) {
        assert.equal(seenOpts.skipTests, true);
        assert.equal(seenOpts.customMarker, 'flag-A');
      }
    } finally {
      wrapPipelineMod.STEP_DISPATCH['ai-content'] = original;
    }
  });

  it('passes an empty object when no options are provided (handlers can read .skipTests etc safely)', async () => {
    const seen = [];
    const original = wrapPipelineMod.STEP_DISPATCH['ai-content'];
    wrapPipelineMod.STEP_DISPATCH['ai-content'] = {
      run: async (ctx) => {
        seen.push(ctx.options);
        return { ok: true, status: 'done', output: null, blockers: [] };
      }
    };

    try {
      await wrapPipelineMod.runWrapPipeline('options-test');
      for (const seenOpts of seen) {
        assert.equal(typeof seenOpts, 'object',
          'context.options must always be an object — handlers must not need to defend against undefined');
      }
    } finally {
      wrapPipelineMod.STEP_DISPATCH['ai-content'] = original;
    }
  });
});

// ── #139 Chunk 5: real `ai-content` step handler ──

describe('wrap-step ai-content — pure helpers (#139 Chunk 5)', () => {
  const aiContent = require('../lib/wrap-steps/ai-content');

  describe('_interpolatePrompt', () => {
    it('substitutes {previousMemoryBlock} with the prior memory-update step output', () => {
      const previousResults = [
        { stepId: 'memory-update', kind: 'ai-content', status: 'done',
          output: { capturedText: 'PRIOR MEMORY' } }
      ];
      const out = aiContent._interpolatePrompt(
        'Read this:\n{previousMemoryBlock}\nNow derive summary.',
        previousResults
      );
      assert.match(out, /PRIOR MEMORY/);
      assert.ok(!out.includes('{previousMemoryBlock}'),
        'token must be replaced, not duplicated');
    });

    it('substitutes with empty string when no prior memory-update result exists', () => {
      const out = aiContent._interpolatePrompt(
        'Read:\n{previousMemoryBlock}',
        []
      );
      assert.equal(out, 'Read:\n');
    });

    it('passes through unrecognized brace tokens verbatim', () => {
      const out = aiContent._interpolatePrompt('Hello {whoever}', []);
      assert.equal(out, 'Hello {whoever}');
    });

    it('returns empty string for null/empty prompt', () => {
      assert.equal(aiContent._interpolatePrompt('', []), '');
      assert.equal(aiContent._interpolatePrompt(null, []), '');
    });

    it('skips prior steps whose status is not "done"', () => {
      const previousResults = [
        { stepId: 'memory-update', kind: 'ai-content', status: 'blocked',
          output: { capturedText: 'SHOULD NOT APPEAR' } }
      ];
      const out = aiContent._interpolatePrompt('{previousMemoryBlock}', previousResults);
      assert.equal(out, '');
    });
  });

  describe('_parseFields', () => {
    it('parses ## Heading blocks against captureFields', () => {
      const raw = '## Summary\nWrap text here\n## NextSteps\nDo X then Y\n';
      const parsed = aiContent._parseFields(raw, ['summary', 'nextSteps']);
      assert.equal(parsed.summary, 'Wrap text here');
      assert.equal(parsed.nextSteps, 'Do X then Y');
    });

    it('matches headings case-insensitively', () => {
      const raw = '## SUMMARY\ncontent\n';
      const parsed = aiContent._parseFields(raw, ['summary']);
      assert.equal(parsed.summary, 'content');
    });

    it('returns empty object when captureFields are absent', () => {
      assert.deepStrictEqual(aiContent._parseFields('## anything\n', []), {});
      assert.deepStrictEqual(aiContent._parseFields('## anything\n', null), {});
    });

    it('returns empty object for empty rawOutput', () => {
      assert.deepStrictEqual(aiContent._parseFields('', ['x']), {});
    });

    it('skips ## headings whose name is not in captureFields', () => {
      const raw = '## Other\nignored\n## summary\nkept\n';
      const parsed = aiContent._parseFields(raw, ['summary']);
      assert.equal(parsed.summary, 'kept');
      assert.equal(parsed.Other, undefined);
    });

    describe('heading normalization (#201 — natural-English variants)', () => {
      it('matches "## Next Steps" (space-separated) against captureField "nextSteps"', () => {
        const raw = '## Next Steps\n- do x\n- do y\n';
        const parsed = aiContent._parseFields(raw, ['nextSteps']);
        assert.equal(parsed.nextSteps, '- do x\n- do y',
          '## Next Steps must match nextSteps — the canonical fragility from PR #200 Critic n1');
      });

      it('matches "## next-steps" (kebab) against "nextSteps"', () => {
        const raw = '## next-steps\nbody\n';
        const parsed = aiContent._parseFields(raw, ['nextSteps']);
        assert.equal(parsed.nextSteps, 'body');
      });

      it('matches "## NEXT_STEPS" (screaming snake) against "nextSteps"', () => {
        const raw = '## NEXT_STEPS\nbody\n';
        const parsed = aiContent._parseFields(raw, ['nextSteps']);
        assert.equal(parsed.nextSteps, 'body');
      });

      it('matches "## Next.Steps" (dotted) against "nextSteps"', () => {
        const raw = '## Next.Steps\nbody\n';
        const parsed = aiContent._parseFields(raw, ['nextSteps']);
        assert.equal(parsed.nextSteps, 'body');
      });

      it('still matches the exact canonical form "## nextSteps"', () => {
        const raw = '## nextSteps\nbody\n';
        const parsed = aiContent._parseFields(raw, ['nextSteps']);
        assert.equal(parsed.nextSteps, 'body', 'normalization must be a superset of equality — never narrower');
      });

      it('handles multiple captureFields with mixed-style headings simultaneously', () => {
        const raw =
          '## Summary\nshipped X\n' +
          '## Next Steps\n- a\n- b\n' +
          '## Learnings\nnone\n';
        const parsed = aiContent._parseFields(raw, ['summary', 'nextSteps', 'learnings']);
        assert.equal(parsed.summary, 'shipped X');
        assert.equal(parsed.nextSteps, '- a\n- b');
        assert.equal(parsed.learnings, 'none');
      });

      it('returns the captureField under its DECLARED key, not the heading\'s normalized form', () => {
        const raw = '## Next Steps\nbody\n';
        const parsed = aiContent._parseFields(raw, ['nextSteps']);
        // Map key must be the literal field name the caller passed in
        // ('nextSteps'), NOT the normalized form ('nextsteps') — otherwise
        // _parseFields-consuming code (the handler's missing-field check,
        // captureFields lockstep tests in test/prawduct-aicontent-prompts.test.js)
        // would have to also normalize.
        assert.equal(parsed.nextSteps, 'body');
        assert.equal(parsed.nextsteps, undefined,
          'output key must be the declared field name, not the normalized matcher key');
      });
    });

    describe('_normalizeFieldKey (#201 — helper exposed for cross-module checks)', () => {
      it('strips every non-alphanumeric character', () => {
        assert.equal(aiContent._normalizeFieldKey('Next Steps'), 'nextsteps');
        assert.equal(aiContent._normalizeFieldKey('next-steps'), 'nextsteps');
        assert.equal(aiContent._normalizeFieldKey('next_steps'), 'nextsteps');
        assert.equal(aiContent._normalizeFieldKey('next.steps'), 'nextsteps');
        assert.equal(aiContent._normalizeFieldKey('next/steps'), 'nextsteps');
        assert.equal(aiContent._normalizeFieldKey('next   steps'), 'nextsteps');
      });

      it('lowercases', () => {
        assert.equal(aiContent._normalizeFieldKey('NEXTSTEPS'), 'nextsteps');
        assert.equal(aiContent._normalizeFieldKey('NextSteps'), 'nextsteps');
      });

      it('preserves digits', () => {
        assert.equal(aiContent._normalizeFieldKey('field42'), 'field42');
        assert.equal(aiContent._normalizeFieldKey('v1.2 stuff'), 'v12stuff');
      });

      it('handles defensive inputs', () => {
        assert.equal(aiContent._normalizeFieldKey(''), '');
        assert.equal(aiContent._normalizeFieldKey(null), '');
        assert.equal(aiContent._normalizeFieldKey(undefined), '');
        assert.equal(aiContent._normalizeFieldKey(42), '42', 'numbers coerce to strings before normalization');
      });
    });
  });
});

describe('wrap-step ai-content — handler (#139 Chunk 5)', () => {
  const aiContent = require('../lib/wrap-steps/ai-content');
  let originals;

  before(() => {
    originals = { ...aiContent._internal };
  });

  beforeEach(() => {
    // Restore every internal between tests so a stub doesn't leak.
    Object.assign(aiContent._internal, originals);
    // Default fast-sleep so the polling loop doesn't block the test runner.
    aiContent._internal.sleep = async () => {};
  });

  /**
   * Build a minimal context for the ai-content handler.
   * @param {object} step - Step spec
   * @param {object} [overrides] - Override context fields (e.g. session, previousResults)
   */
  function buildContext(step, overrides = {}) {
    return {
      project: { name: 'sandbox', path: '/tmp/sandbox', id: 1 },
      session: overrides.session !== undefined
        ? overrides.session
        : { id: 1, tmuxSession: 'tc-sandbox' },
      step,
      previousResults: overrides.previousResults || [],
      staged: overrides.staged !== undefined ? overrides.staged : {},
      options: {}
    };
  }

  it('blocks when context.session is missing', async () => {
    const result = await aiContent.run(buildContext(
      { id: 'memory-update', prompt: 'do the thing' },
      { session: null }
    ));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /active tmux session/);
  });

  it('skips cleanly when step.prompt is empty (#139 Chunk 11c — placeholder semantics)', async () => {
    const result = await aiContent.run(buildContext({ id: 'memory-update' }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.blockers, []);
    assert.equal(result.output, null);
  });

  it('skips cleanly when step.prompt is whitespace-only (#139 Chunk 11c)', async () => {
    const result = await aiContent.run(buildContext({ id: 'memory-update', prompt: '   \n  ' }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
  });

  it('skips cleanly when step.prompt is missing entirely (#139 Chunk 11c)', async () => {
    const ctx = buildContext({ id: 'memory-update' });
    delete ctx.step.prompt;
    const result = await aiContent.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
  });

  it('sends the prompt and reports done on idle with adequate response (no captureFields)', async () => {
    let sentText;
    aiContent._internal.sendKeys = (sess, text) => { sentText = text; };
    aiContent._internal.detectIdle = () => ({ idle: true, lastOutputAge: 12 });
    aiContent._internal.capturePane = () => ({
      lines: ['the AI produced a meaningful response here'],
      alternateScreen: false
    });

    const staged = {};
    const result = await aiContent.run(buildContext(
      { id: 'memory-update', prompt: 'Update MEMORY.md' },
      { staged }
    ));

    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.equal(sentText, 'Update MEMORY.md');
    assert.equal(result.output.parsedFields, null);
    assert.ok(staged['memory-update'], 'must stage captured output for the commit step');
    assert.match(staged['memory-update'].capturedText, /meaningful response/);
  });

  it('blocks when AI response is too short (no captureFields validation path)', async () => {
    aiContent._internal.sendKeys = () => {};
    aiContent._internal.detectIdle = () => ({ idle: true, lastOutputAge: 12 });
    aiContent._internal.capturePane = () => ({ lines: ['ok'], alternateScreen: false });

    const result = await aiContent.run(buildContext(
      { id: 'memory-update', prompt: 'do thing' }
    ));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /too short/);
  });

  it('passes the MIN_RESPONSE_CHARS=20 boundary (exactly 20 chars trimmed → ok:true)', async () => {
    // 20 chars exactly — pin the boundary so a future "let me lower the
    // threshold by 1" change is caught.
    const exactlyTwenty = 'a'.repeat(20);
    aiContent._internal.sendKeys = () => {};
    aiContent._internal.detectIdle = () => ({ idle: true, lastOutputAge: 12 });
    aiContent._internal.capturePane = () => ({ lines: [exactlyTwenty], alternateScreen: false });

    const result = await aiContent.run(buildContext(
      { id: 'memory-update', prompt: 'do thing' }
    ));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
  });

  it('blocks at MIN_RESPONSE_CHARS-1 (exactly 19 chars trimmed → ok:false)', async () => {
    const nineteen = 'a'.repeat(19);
    aiContent._internal.sendKeys = () => {};
    aiContent._internal.detectIdle = () => ({ idle: true, lastOutputAge: 12 });
    aiContent._internal.capturePane = () => ({ lines: [nineteen], alternateScreen: false });

    const result = await aiContent.run(buildContext(
      { id: 'memory-update', prompt: 'do thing' }
    ));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /too short \(19 chars/);
  });

  it('validates captureFields and reports done when all are present', async () => {
    aiContent._internal.sendKeys = () => {};
    aiContent._internal.detectIdle = () => ({ idle: true, lastOutputAge: 12 });
    aiContent._internal.capturePane = () => ({
      lines: [
        'AI scratchpad ramble...',
        '## Summary',
        'This session shipped Chunk 5.',
        '## NextSteps',
        'Run the Critic next.',
        '## Learnings',
        'tmux idle detection works.'
      ],
      alternateScreen: false
    });

    const staged = {};
    const result = await aiContent.run(buildContext(
      {
        id: 'summary-derive',
        prompt: 'Derive structured output.',
        captureFields: ['summary', 'nextSteps', 'learnings']
      },
      { staged }
    ));

    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.equal(result.output.parsedFields.summary, 'This session shipped Chunk 5.');
    assert.equal(result.output.parsedFields.nextSteps, 'Run the Critic next.');
    assert.equal(result.output.parsedFields.learnings, 'tmux idle detection works.');
    assert.ok(staged['summary-derive'], 'staged under stepId');
  });

  it('blocks when a required captureField is missing or empty', async () => {
    aiContent._internal.sendKeys = () => {};
    aiContent._internal.detectIdle = () => ({ idle: true, lastOutputAge: 12 });
    aiContent._internal.capturePane = () => ({
      lines: ['## Summary', 'present', '## Learnings', ''],
      alternateScreen: false
    });

    const result = await aiContent.run(buildContext({
      id: 'summary-derive',
      prompt: 'go',
      captureFields: ['summary', 'nextSteps', 'learnings']
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    // Both `nextSteps` (heading absent) and `learnings` (heading present but empty)
    // must surface as separate blockers.
    const blockerText = result.blockers.join('\n');
    assert.match(blockerText, /nextSteps/);
    assert.match(blockerText, /learnings/);
  });

  it('interpolates {previousMemoryBlock} into the prompt before sending', async () => {
    let sentText;
    aiContent._internal.sendKeys = (sess, text) => { sentText = text; };
    aiContent._internal.detectIdle = () => ({ idle: true, lastOutputAge: 12 });
    aiContent._internal.capturePane = () => ({
      lines: ['## Summary', 'fine', '## NextSteps', 'ok', '## Learnings', 'good'],
      alternateScreen: false
    });

    await aiContent.run(buildContext(
      {
        id: 'summary-derive',
        prompt: 'Read:\n{previousMemoryBlock}\nDerive.',
        captureFields: ['summary', 'nextSteps', 'learnings']
      },
      {
        previousResults: [
          { stepId: 'memory-update', kind: 'ai-content', status: 'done',
            output: { capturedText: 'MEM BLOCK CONTENT' } }
        ]
      }
    ));
    assert.match(sentText, /MEM BLOCK CONTENT/);
    assert.ok(!sentText.includes('{previousMemoryBlock}'));
  });

  it('blocks on idle timeout when detectIdle never returns idle', async () => {
    aiContent._internal.sendKeys = () => {};
    // Idle always false → polling loop runs until MAX_WAIT_MS elapses.
    aiContent._internal.detectIdle = () => ({ idle: false, lastOutputAge: 0 });
    aiContent._internal.capturePane = () => ({ lines: [], alternateScreen: false });

    // Skip wall-clock waiting: stub sleep to advance "time" by pretending
    // it slept for the requested interval. We monkey-patch Date.now so
    // the elapsed-time check exits the loop after one iteration.
    const realDateNow = Date.now;
    let virtualNow = realDateNow();
    Date.now = () => virtualNow;
    aiContent._internal.sleep = async (ms) => { virtualNow += ms; };
    // Also bump past INITIAL_SETTLE_MS — first sleep before the loop:
    // the stub above already advances past it.

    try {
      const result = await aiContent.run(buildContext(
        { id: 'memory-update', prompt: 'try' }
      ));
      assert.equal(result.ok, false);
      assert.equal(result.status, 'blocked');
      assert.match(result.blockers[0], /AI did not return within/);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('blocks when sendKeys throws (tmux session died before send)', async () => {
    aiContent._internal.sendKeys = () => { throw new Error('no such session'); };

    const result = await aiContent.run(buildContext(
      { id: 'memory-update', prompt: 'go' }
    ));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Failed to send prompt to tmux: no such session/);
  });

  it('blocks when detectIdle throws (tmux session died mid-poll)', async () => {
    aiContent._internal.sendKeys = () => {};
    aiContent._internal.detectIdle = () => { throw new Error('tmux session gone'); };

    const result = await aiContent.run(buildContext(
      { id: 'memory-update', prompt: 'go' }
    ));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Idle detection failed/);
  });

  it('blocks when capturePane throws after idle detected', async () => {
    aiContent._internal.sendKeys = () => {};
    aiContent._internal.detectIdle = () => ({ idle: true, lastOutputAge: 12 });
    aiContent._internal.capturePane = () => { throw new Error('capture failed'); };

    const result = await aiContent.run(buildContext(
      { id: 'memory-update', prompt: 'go' }
    ));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Failed to capture pane/);
  });
});

// ── #139 Chunk 6: real `priming-roll` step handler ──

describe('wrap-step priming-roll — pure helpers (#139 Chunk 6)', () => {
  const primingRoll = require('../lib/wrap-steps/priming-roll');

  describe('_parseChunks', () => {
    it('extracts id + title from `### Chunk N: Title` headings', () => {
      const md = [
        '# Plan',
        '',
        '### Chunk 1: Discovery',
        'Body line.',
        '',
        '### Chunk 2: Implementation',
        'More body.'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].id, '1');
      assert.equal(chunks[0].title, 'Discovery');
      assert.equal(chunks[0].done, false);
      assert.equal(chunks[1].id, '2');
      assert.equal(chunks[1].title, 'Implementation');
    });

    it('marks chunks done when ✅ appears anywhere on the heading line', () => {
      const md = [
        '### Chunk 1: Discovery ✅',
        '### Chunk 2: ✅ Schema migration',
        '### Chunk 3: Build skeleton'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].done, true);
      assert.equal(chunks[0].title, 'Discovery',
        '✅ in title must be stripped from the rendered title');
      assert.equal(chunks[1].done, true);
      assert.equal(chunks[1].title, 'Schema migration');
      assert.equal(chunks[2].done, false);
    });

    it('does NOT mark a chunk done just because ✅ appears in its body', () => {
      const md = [
        '### Chunk 1: Discovery',
        '✅ this is in body but should not promote the chunk',
        '### Chunk 2: Build'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].done, false, 'body-level ✅ must not mark heading done');
      assert.equal(chunks[1].done, false);
    });

    it('parses dotted / lettered sub-chunk ids (e.g. 10c.2)', () => {
      const md = [
        '### Chunk 10: Frontend',
        '### Chunk 10c.2: Sub-step',
        '### Chunk 12.3a.4: Deep nesting'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.deepStrictEqual(chunks.map((c) => c.id), ['10', '10c.2', '12.3a.4']);
    });

    it('captures **Blocked on:** annotations from chunk body', () => {
      const md = [
        '### Chunk 5: Async work',
        'Some prose.',
        '',
        '**Blocked on:** chunk-4 still in review',
        '',
        'More prose.',
        '### Chunk 6: Cleanup'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].blockedOn, 'chunk-4 still in review');
      assert.equal(chunks[1].blockedOn, null);
    });

    it('captures only the first **Blocked on:** per chunk (additional are ignored)', () => {
      const md = [
        '### Chunk 5: Multi-block',
        '**Blocked on:** first reason',
        '**Blocked on:** second reason (must be ignored)'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].blockedOn, 'first reason');
    });

    it('matches **Blocked on:** case-insensitively', () => {
      const md = [
        '### Chunk 5: Lowercase author',
        '**blocked on:** lowercased reason'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].blockedOn, 'lowercased reason');
    });

    it('returns [] on empty / null input', () => {
      assert.deepStrictEqual(primingRoll._parseChunks(''), []);
      assert.deepStrictEqual(primingRoll._parseChunks(null), []);
    });

    it('tolerates `### Chunk N (suffix): Title` headings', () => {
      const md = '### Chunk 12 (optional): Cross-engine parity';
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].id, '12');
      // Title strips the leading separators / colon; the `(optional)`
      // qualifier is part of the title the user can read.
      assert.match(chunks[0].title, /\(optional\): Cross-engine parity/);
    });

    it('parses CRLF-encoded plans byte-equivalent to LF', () => {
      const md = ['### Chunk 1: A ✅', '### Chunk 2: B'].join('\r\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks.length, 2, 'CRLF split must yield both chunks');
      assert.equal(chunks[0].done, true);
      assert.equal(chunks[0].title, 'A',
        'title must not retain a trailing \\r byte');
      assert.equal(chunks[1].id, '2');
    });

    it('skips a `### Chunk` line whose id slot is non-conforming (and only that line)', () => {
      // A typo like `### Chunk Foo: oops` does not match the strict id
      // regex and is silently dropped from the chunk list — but real
      // ids in the same plan must still parse normally.
      const md = [
        '### Chunk Foo: typo with non-numeric id',
        '### Chunk 1: real chunk'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks.length, 1, 'only the well-formed chunk parses');
      assert.equal(chunks[0].id, '1');
    });
  });

  describe('_selectPointer', () => {
    it('returns the first un-done as current and the next as on-deck', () => {
      const chunks = [
        { id: '1', title: 'A', done: true, blockedOn: null, lineNo: 1 },
        { id: '2', title: 'B', done: true, blockedOn: null, lineNo: 2 },
        { id: '3', title: 'C', done: false, blockedOn: null, lineNo: 3 },
        { id: '4', title: 'D', done: false, blockedOn: null, lineNo: 4 }
      ];
      const p = primingRoll._selectPointer(chunks);
      assert.equal(p.current.id, '3');
      assert.equal(p.next.id, '4');
      assert.equal(p.allDone, false);
    });

    it('sets next=null when the current chunk is the tail', () => {
      const chunks = [
        { id: '1', done: true, title: '', blockedOn: null, lineNo: 1 },
        { id: '2', done: false, title: '', blockedOn: null, lineNo: 2 }
      ];
      const p = primingRoll._selectPointer(chunks);
      assert.equal(p.current.id, '2');
      assert.equal(p.next, null);
    });

    it('reports allDone when every chunk is marked done', () => {
      const chunks = [
        { id: '1', done: true, title: '', blockedOn: null, lineNo: 1 },
        { id: '2', done: true, title: '', blockedOn: null, lineNo: 2 }
      ];
      const p = primingRoll._selectPointer(chunks);
      assert.equal(p.allDone, true);
      assert.equal(p.current, null);
      assert.equal(p.next, null);
    });

    it('returns null current/next on empty input', () => {
      const p = primingRoll._selectPointer([]);
      assert.equal(p.current, null);
      assert.equal(p.next, null);
      assert.equal(p.allDone, false);
    });
  });

  describe('_replaceManagedBlock', () => {
    const begin = primingRoll.BEGIN_MARKER;
    const end = primingRoll.END_MARKER;

    it('replaces an existing managed block in place, preserving surrounding text', () => {
      const prior = `Header content\n${begin}\nold body\n${end}\nFooter content`;
      const out = primingRoll._replaceManagedBlock(prior, '\nnew body\n');
      assert.match(out, /^Header content\n/);
      assert.match(out, /Footer content$/);
      assert.match(out, /new body/);
      assert.ok(!out.includes('old body'), 'old managed body must be wiped');
    });

    it('appends a fresh managed block when none exists, with a blank line separator', () => {
      const prior = 'Some user prose.\n';
      const out = primingRoll._replaceManagedBlock(prior, '\nfresh body\n');
      assert.match(out, /^Some user prose\.\n/);
      assert.ok(out.includes(begin) && out.includes(end));
      assert.match(out, /fresh body/);
    });

    it('appends without leading separator when prior is empty', () => {
      const out = primingRoll._replaceManagedBlock('', '\nbody\n');
      assert.ok(out.startsWith(begin), 'empty prior → block at top with no leading whitespace');
    });

    it('treats out-of-order markers as "no managed block" and appends', () => {
      // If END appears before BEGIN, slice math would corrupt the file —
      // the implementation defensively treats it as a fresh-append case.
      // Any user prose between the misordered markers MUST survive.
      const prior = `${end}\nuser-prose-between\n${begin}\n`;
      const out = primingRoll._replaceManagedBlock(prior, '\nbody\n');
      // Original BEGIN/END count: 1 each. After append: 2 each.
      const beginCount = out.split(begin).length - 1;
      const endCount = out.split(end).length - 1;
      assert.equal(beginCount, 2);
      assert.equal(endCount, 2);
      assert.match(out, /user-prose-between/,
        'defensive append must not destroy user content sitting between misordered markers');
    });

    it('with multiple BEGIN/END pairs, edits only the first pair (leaves orphans untouched)', () => {
      // Documented behavior: indexOf finds the first marker of each
      // kind. A duplicated managed block (e.g. user copy-pasted) leaves
      // the orphan second pair as inert content rather than corrupting
      // anything. Worth pinning so a future "find all markers" refactor
      // is intentional, not accidental.
      const prior =
        `${begin}\nfirst\n${end}\n` +
        `middle\n` +
        `${begin}\nsecond\n${end}\n`;
      const out = primingRoll._replaceManagedBlock(prior, '\nrolled\n');
      assert.match(out, /rolled/);
      assert.ok(!out.includes('first'),
        'first managed-block body must be replaced');
      assert.match(out, /second/,
        'orphan second block remains as inert content (pin for intentionality)');
      assert.match(out, /middle/, 'prose between pairs survives');
    });
  });

  describe('_renderPointerBody', () => {
    it('renders Active + On-deck when both exist', () => {
      const body = primingRoll._renderPointerBody({
        current: { id: '5', title: 'Build it', blockedOn: null },
        next: { id: '6', title: 'Ship it', blockedOn: null },
        allDone: false
      }, '.claude/plans/plan.md');
      assert.match(body, /\*\*Active:\*\* Chunk 5 — Build it/);
      assert.match(body, /\*\*On deck:\*\* Chunk 6 — Ship it/);
      assert.match(body, /Plan: `\.claude\/plans\/plan\.md`/);
    });

    it('surfaces blockedOn on the active chunk', () => {
      const body = primingRoll._renderPointerBody({
        current: { id: '5', title: 'X', blockedOn: 'thing Y' },
        next: null,
        allDone: false
      }, 'plan.md');
      assert.match(body, /\*\*Blocked on:\*\* thing Y/);
      assert.match(body, /Last chunk in this plan/);
    });

    it('renders allDone explicitly', () => {
      const body = primingRoll._renderPointerBody({
        current: null, next: null, allDone: true
      }, 'plan.md');
      assert.match(body, /All chunks in .* are marked done/);
    });

    it('falls through with a "no headings" message when chunks empty', () => {
      const body = primingRoll._renderPointerBody({
        current: null, next: null, allDone: false
      }, 'plan.md');
      assert.match(body, /No `### Chunk N: Title` headings/);
    });
  });
});

describe('wrap-step priming-roll — handler (#139 Chunk 6)', () => {
  const primingRoll = require('../lib/wrap-steps/priming-roll');
  let tmpDir;
  let projectPath;
  let originals;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-step-priming-'));
    originals = { ...primingRoll._internal };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Fresh sandbox per test so plans/priming don't leak.
    Object.assign(primingRoll._internal, originals);
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'sandbox-'));
  });

  /** Build a minimal context for the priming-roll handler. */
  function buildContext(step, projectOverride) {
    return {
      project: projectOverride || { name: 'sandbox', path: projectPath, id: 1 },
      session: null,
      step,
      previousResults: [],
      staged: {},
      options: {}
    };
  }

  /** Write a plan markdown file into <project>/.claude/plans/<name>. */
  function writePlan(name, body) {
    const dir = path.join(projectPath, '.claude', 'plans');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  }

  it('blocks when context.project.path is missing', async () => {
    const result = await primingRoll.run(buildContext(
      { id: 'next-session-prime' },
      { name: 'no-path', id: 1 }
    ));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /requires context\.project\.path/);
  });

  it('blocks when no .claude/plans directory exists and no step.planPath', async () => {
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /No plans directory/);
  });

  it('skips (not blocks) when .claude/plans is empty (#302)', async () => {
    // An empty active plans dir means "no plan to roll" — same as the
    // all-complete case below. Must skip cleanly, not block the wrap.
    fs.mkdirSync(path.join(projectPath, '.claude', 'plans'), { recursive: true });
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true, 'an empty active plans dir must not block the wrap');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /No \.md plans found/i);
    assert.deepEqual(result.blockers, []);
  });

  it('skips when all plans are archived under .claude/plans/archive/ (#302 repro)', async () => {
    // The exact reported scenario: every shipped plan has been moved to
    // the archive subdir (per CLAUDE.md's archive rule), leaving the
    // active dir holding only `archive/`. The non-recursive `.md` filter
    // must ignore the subdir's plans, so the step skips rather than
    // mistaking 20 archived plans for active ones.
    const archiveDir = path.join(projectPath, '.claude', 'plans', 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'shipped-a.md'), '### Chunk 1: A ✅\n');
    fs.writeFileSync(path.join(archiveDir, 'shipped-b.md'), '### Chunk 1: B\n'); // undone, but archived
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true, 'archived plans must not count as active');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /nothing to roll/i);
  });

  it('blocks when multiple plans are in progress and none can be auto-picked (#226)', async () => {
    // Both plans have an undone chunk → both in-progress → can't disambiguate.
    writePlan('one.md', '### Chunk 1: A\n');
    writePlan('two.md', '### Chunk 1: A\n');
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Multiple in-progress plans/);
    assert.match(result.blockers[0], /one\.md/);
    assert.match(result.blockers[0], /two\.md/);
    // Blocked output carries operator remediation for the drawer (#223/#226).
    assert.equal(typeof result.output.remediation, 'string');
    assert.match(result.output.remediation, /planPath/);
    assert.match(result.output.remediation, /activePlan/);
  });

  it('auto-picks the single in-progress plan when others are complete (#226)', async () => {
    writePlan('shipped.md', '### Chunk 1: A ✅\n### Chunk 2: B ✅\n');
    writePlan('active.md', '### Chunk 1: A ✅\n### Chunk 2: B\n');
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.match(result.output.planPath, /active\.md$/, 'must resolve to the in-progress plan');
  });

  it('skips (not blocks) when every plan is complete (#226)', async () => {
    writePlan('done-a.md', '### Chunk 1: A ✅\n');
    writePlan('done-b.md', '### Chunk 1: B ✅\n### Chunk 2: C ✅\n');
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true, 'a finished project must not block its own wrap');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /No in-progress plan/i);
  });

  it('honors activePlan in .tangleclaw/project.json as the escape hatch (#226)', async () => {
    // Two in-progress plans would otherwise block — activePlan disambiguates.
    writePlan('pick-me.md', '### Chunk 1: A\n');
    writePlan('not-me.md', '### Chunk 1: A\n');
    const tcDir = path.join(projectPath, '.tangleclaw');
    fs.mkdirSync(tcDir, { recursive: true });
    fs.writeFileSync(path.join(tcDir, 'project.json'), JSON.stringify({ activePlan: 'pick-me.md' }));
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.match(result.output.planPath, /pick-me\.md$/);
  });

  it('blocks with remediation when activePlan points at a missing file (#226)', async () => {
    writePlan('one.md', '### Chunk 1: A\n');
    writePlan('two.md', '### Chunk 1: A\n');
    const tcDir = path.join(projectPath, '.tangleclaw');
    fs.mkdirSync(tcDir, { recursive: true });
    fs.writeFileSync(path.join(tcDir, 'project.json'), JSON.stringify({ activePlan: 'ghost.md' }));
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /activePlan "ghost\.md".*does not exist/);
    assert.match(result.output.remediation, /activePlan/);
  });

  it('honors step.planPath when set (project-relative)', async () => {
    fs.mkdirSync(path.join(projectPath, 'custom'), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, 'custom', 'roadmap.md'),
      '### Chunk 1: Discovery ✅\n### Chunk 2: Build\n'
    );
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: 'custom/roadmap.md'
    }));
    assert.equal(result.ok, true);
    assert.equal(result.output.pointer.current.id, '2');
  });

  it('blocks when step.planPath points to a non-existent file', async () => {
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: 'does/not/exist.md'
    }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /Configured planPath does not exist/);
  });

  it('blocks when project-relative step.planPath escapes the project root', async () => {
    // Defense-in-depth (Critic MINOR): template JSON is server-trusted
    // today, but Chunk 11's default-flip + any future user-editable
    // methodology authoring would expose this. Refuse `../`-style
    // traversal in project-relative paths.
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: '../escaped.md'
    }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /resolves outside the project root/);
  });

  it('accepts an absolute step.planPath even outside the project root', async () => {
    // Absolute paths are accepted as-is — the assumption is an author
    // writing an absolute path knows what they're pointing at (e.g. a
    // shared corporate plan archive). The containment check applies
    // only to project-relative paths.
    const sharedPlan = path.join(tmpDir, 'shared-plan.md');
    fs.writeFileSync(sharedPlan, '### Chunk 7: external\n');
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: sharedPlan
    }));
    assert.equal(result.ok, true);
    assert.equal(result.output.pointer.current.id, '7');
  });

  it('blocks when the plan has no ### Chunk headings at all', async () => {
    writePlan('plan.md', '# Just a header, no chunks here.\n');
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /No "### Chunk N: Title" headings/);
    // #223 — blocked output carries operator remediation for the drawer.
    assert.equal(typeof result.output.remediation, 'string');
    assert.match(result.output.remediation, /Chunk/);
  });

  it('rolls a fresh priming file (creates managed block) when none exists', async () => {
    writePlan('plan.md', [
      '### Chunk 1: Discovery ✅',
      '### Chunk 2: Implement',
      '### Chunk 3: Ship'
    ].join('\n'));

    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.equal(result.output.changed, true,
      'priming file did not exist → changed=true');
    assert.equal(result.output.pointer.current.id, '2');
    assert.equal(result.output.pointer.next.id, '3');

    // Single-transaction: real fs must NOT have a priming file yet.
    assert.equal(
      fs.existsSync(path.join(projectPath, '.claude/priming/build-session.md')),
      false,
      'handler must NOT write to disk — that is the Chunk 9 commit step'
    );

    // Staged shape pinned for commit-step consumption.
    const stagedEntry = ctx.staged['next-session-prime'];
    assert.ok(stagedEntry, 'must stage under step.id');
    assert.equal(
      stagedEntry.primingPath,
      path.join(projectPath, '.claude/priming/build-session.md')
    );
    assert.match(stagedEntry.newContent, /TANGLECLAW:PRIMING-ROLL:BEGIN/);
    assert.match(stagedEntry.newContent, /TANGLECLAW:PRIMING-ROLL:END/);
    assert.match(stagedEntry.newContent, /Chunk 2 — Implement/);
  });

  it('replaces an existing managed block while preserving user-authored surround', async () => {
    writePlan('plan.md', [
      '### Chunk 1: A ✅',
      '### Chunk 2: B ✅',
      '### Chunk 3: C'
    ].join('\n'));

    // Pre-seed a priming file with user content + an outdated managed block.
    const primingDir = path.join(projectPath, '.claude/priming');
    fs.mkdirSync(primingDir, { recursive: true });
    const primingPath = path.join(primingDir, 'build-session.md');
    const userTop = '# Build-session priming\n\nUser-authored intro the handler must not touch.\n\n';
    const userBottom = '\n\n## Update history\n- 2026-05-01: initial\n';
    const stalePrior = `${userTop}${primingRoll.BEGIN_MARKER}\nold pointer\n${primingRoll.END_MARKER}${userBottom}`;
    fs.writeFileSync(primingPath, stalePrior);

    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.changed, true);

    const newContent = ctx.staged['next-session-prime'].newContent;
    assert.match(newContent, /User-authored intro the handler must not touch/,
      'user prose above the managed block must survive byte-for-byte');
    assert.match(newContent, /Update history/,
      'user prose below the managed block must survive byte-for-byte');
    assert.match(newContent, /Chunk 3 — C/, 'new pointer must reflect current chunk');
    assert.ok(!newContent.includes('old pointer'),
      'stale managed-block content must be replaced');
  });

  it('reports changed=false when the rolled content matches existing file exactly', async () => {
    writePlan('plan.md', '### Chunk 1: Solo\n');
    const ctx1 = buildContext({ id: 'next-session-prime' });
    const first = await primingRoll.run(ctx1);
    assert.equal(first.output.changed, true);

    // Simulate the commit step having flushed the staged content to disk.
    const primingPath = ctx1.staged['next-session-prime'].primingPath;
    fs.mkdirSync(path.dirname(primingPath), { recursive: true });
    fs.writeFileSync(primingPath, ctx1.staged['next-session-prime'].newContent);

    // Re-run — same plan, same staged output ⇒ changed=false.
    const ctx2 = buildContext({ id: 'next-session-prime' });
    const second = await primingRoll.run(ctx2);
    assert.equal(second.ok, true);
    assert.equal(second.output.changed, false,
      'idempotent re-roll on unchanged plan must report changed=false');
  });

  it('reports allDone when every chunk is marked done', async () => {
    writePlan('plan.md', [
      '### Chunk 1: A ✅',
      '### Chunk 2: B ✅'
    ].join('\n'));
    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.pointer.allDone, true);
    assert.equal(result.output.pointer.current, null);
    assert.match(ctx.staged['next-session-prime'].newContent, /marked done/);
  });

  it('carries **Blocked on:** annotations from the active chunk into the rolled pointer', async () => {
    writePlan('plan.md', [
      '### Chunk 1: A ✅',
      '### Chunk 2: B',
      '',
      '**Blocked on:** waiting on dep-X PR review',
      '',
      '### Chunk 3: C'
    ].join('\n'));
    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.pointer.current.blockedOn, 'waiting on dep-X PR review');
    assert.match(
      ctx.staged['next-session-prime'].newContent,
      /\*\*Blocked on:\*\* waiting on dep-X PR review/
    );
  });

  it('honors step.primingPath when set (project-relative)', async () => {
    writePlan('plan.md', '### Chunk 1: A\n');
    const ctx = buildContext({
      id: 'next-session-prime',
      primingPath: 'docs/custom-priming.md'
    });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(
      result.output.primingPath,
      path.join(projectPath, 'docs/custom-priming.md')
    );
  });

  it('blocks when the plan file read throws', async () => {
    writePlan('plan.md', '### Chunk 1: A\n');
    primingRoll._internal.readFileSync = () => { throw new Error('EACCES'); };
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Failed to read plan/);
  });

  it('blocks when the priming file read throws (but plan read succeeded)', async () => {
    writePlan('plan.md', '### Chunk 1: A\n');
    const primingDir = path.join(projectPath, '.claude/priming');
    fs.mkdirSync(primingDir, { recursive: true });
    fs.writeFileSync(path.join(primingDir, 'build-session.md'), 'existing\n');

    // First read (plan) succeeds; second read (priming) throws.
    let calls = 0;
    const realRead = originals.readFileSync;
    primingRoll._internal.readFileSync = (p, enc) => {
      calls++;
      if (calls === 1) return realRead(p, enc);
      throw new Error('disk gone');
    };
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /Failed to read priming file/);
  });
});

// ── #139 Chunk 7: real `critic-check` step handler ──

describe('wrap-step critic-check — pure helpers (#139 Chunk 7)', () => {
  const criticCheck = require('../lib/wrap-steps/critic-check');

  describe('_detectChunkTag', () => {
    it('returns null when neither branch nor commits mention chunk', () => {
      assert.equal(
        criticCheck._detectChunkTag('main', ['fix typo', 'tweak readme']),
        null
      );
    });

    it('matches `chunk-N` in branch name', () => {
      const r = criticCheck._detectChunkTag('feat/issue-139-chunk-7-critic', []);
      assert.equal(r.tag, '7');
      assert.equal(r.source, 'branch');
      assert.equal(r.match.toLowerCase(), 'chunk-7');
    });

    it('matches `Chunk N` in commit subject when branch has no tag', () => {
      const r = criticCheck._detectChunkTag('main', ['Real foo (#139, Chunk 5)']);
      assert.equal(r.tag, '5');
      assert.equal(r.source, 'commit');
    });

    it('branch wins over commit subject when both match', () => {
      const r = criticCheck._detectChunkTag(
        'feat/x-chunk-3',
        ['(Chunk 5)']
      );
      assert.equal(r.tag, '3');
      assert.equal(r.source, 'branch');
    });

    it('matches dotted sub-chunk ids (10c.2)', () => {
      const r = criticCheck._detectChunkTag('feat/x-chunk-10c.2', []);
      assert.equal(r.tag, '10c.2');
    });

    it('matches across separator variants (space / dash / underscore / none)', () => {
      assert.equal(criticCheck._detectChunkTag('main', ['Chunk 7 done']).tag, '7');
      assert.equal(criticCheck._detectChunkTag('main', ['chunk-7 done']).tag, '7');
      assert.equal(criticCheck._detectChunkTag('main', ['chunk_7 done']).tag, '7');
      assert.equal(criticCheck._detectChunkTag('main', ['chunk7 done']).tag, '7');
    });

    it('matches case-insensitively', () => {
      assert.equal(criticCheck._detectChunkTag('main', ['CHUNK 5']).tag, '5');
      assert.equal(criticCheck._detectChunkTag('main', ['Chunk 5']).tag, '5');
    });

    it('handles null/empty branch and empty subject list', () => {
      assert.equal(criticCheck._detectChunkTag(null, []), null);
      assert.equal(criticCheck._detectChunkTag('', []), null);
    });
  });

  describe('_isMediumPlus', () => {
    const baseThresholds = { commitThreshold: 10, lineChangeThreshold: 500 };

    it('trips when commits ≥ commitThreshold (10/10 boundary)', () => {
      assert.equal(criticCheck._isMediumPlus({
        commits: 10, lineChanges: 0, chunkTag: null, ...baseThresholds
      }), true);
    });

    it('does NOT trip at commits = commitThreshold - 1 (9/10 boundary)', () => {
      assert.equal(criticCheck._isMediumPlus({
        commits: 9, lineChanges: 0, chunkTag: null, ...baseThresholds
      }), false);
    });

    it('trips when lineChanges ≥ lineChangeThreshold (500/500 boundary)', () => {
      assert.equal(criticCheck._isMediumPlus({
        commits: 0, lineChanges: 500, chunkTag: null, ...baseThresholds
      }), true);
    });

    it('does NOT trip at lineChanges = lineChangeThreshold - 1 (499/500 boundary)', () => {
      assert.equal(criticCheck._isMediumPlus({
        commits: 0, lineChanges: 499, chunkTag: null, ...baseThresholds
      }), false);
    });

    it('trips when chunkTag is truthy regardless of counts', () => {
      assert.equal(criticCheck._isMediumPlus({
        commits: 0, lineChanges: 0, chunkTag: { tag: '7', source: 'branch' }, ...baseThresholds
      }), true);
    });

    it('honors custom thresholds', () => {
      assert.equal(criticCheck._isMediumPlus({
        commits: 5, lineChanges: 0, chunkTag: null,
        commitThreshold: 5, lineChangeThreshold: 500
      }), true);
    });
  });

  describe('_pickRange', () => {
    it('uses <main>..HEAD when branch != main and main known', () => {
      const r = criticCheck._pickRange('feat/x', 'main');
      assert.equal(r.rangeSpec, 'main..HEAD');
      assert.equal(r.degraded, false);
      assert.equal(r.reason, null);
    });

    it('degrades to HEAD~N..HEAD when branch === main', () => {
      const r = criticCheck._pickRange('main', 'main');
      assert.match(r.rangeSpec, /^HEAD~\d+\.\.HEAD$/);
      assert.equal(r.degraded, true);
      assert.match(r.reason, /directly on main/);
    });

    it('degrades when branch is null (detached HEAD)', () => {
      const r = criticCheck._pickRange(null, 'main');
      assert.equal(r.degraded, true);
      assert.match(r.reason, /detached/);
    });

    it('degrades when mainBranch is null (no origin symref)', () => {
      const r = criticCheck._pickRange('feat/x', null);
      assert.equal(r.degraded, true);
      assert.match(r.reason, /origin\/HEAD symref/);
    });
  });
});

describe('wrap-step critic-check — handler (#139 Chunk 7)', () => {
  const criticCheck = require('../lib/wrap-steps/critic-check');
  let tmpDir;
  let projectPath;
  let originals;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-step-critic-'));
    originals = { ...criticCheck._internal };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    Object.assign(criticCheck._internal, originals);
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'sandbox-'));
    fs.mkdirSync(path.join(projectPath, '.tangleclaw'), { recursive: true });
  });

  /**
   * Build a minimal context that the handler can consume.
   * Defaults stub every `_internal` git call to a benign "no activity"
   * answer so each test only has to override what it cares about.
   */
  function buildContext(step, options) {
    criticCheck._internal.getCurrentBranch = async () => 'feat/x';
    criticCheck._internal.getMainBranch = async () => 'main';
    criticCheck._internal.getCommitCount = async () => 0;
    criticCheck._internal.getDiffStats = async () => ({ insertions: 0, deletions: 0 });
    criticCheck._internal.getCommitSubjects = async () => [];
    return {
      project: { name: 'sandbox', path: projectPath, id: 1 },
      session: null,
      step,
      previousResults: [],
      staged: {},
      options: options || {}
    };
  }

  /** Write critic-runs.json into the sandbox. */
  function writeCriticRuns(entries) {
    fs.writeFileSync(
      path.join(projectPath, '.tangleclaw', 'critic-runs.json'),
      JSON.stringify(entries)
    );
  }

  it('misconfigured project (missing path) returns ok:true status skipped, never blocks', async () => {
    // Defensive: a misconfigured project should NEVER halt the wrap
    // pipeline even after the #264 amendment. The pre-#264 contract
    // ("always returns ok:true") was narrowed to "returns ok:true
    // unless explicit blocking findings exist and no override is
    // set" — but misconfiguration / probe-failure cases are still
    // ok:true status:skipped to preserve the original ADR 0002
    // resilience guarantee for non-finding-related failures.
    const result = await criticCheck.run({
      project: { name: 'no-path', id: 1 },
      step: { id: 'critic-check' },
      previousResults: [],
      staged: {},
      options: {}
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /requires context\.project\.path/);
    assert.deepStrictEqual(result.blockers, []);
  });

  it('returns warning=false when nothing in session trips medium+', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.equal(result.output.warning, false);
    assert.equal(result.output.isMediumPlus, false);
    assert.equal(result.output.criticRan, false);
    assert.deepStrictEqual(ctx.staged, {}, 'no warning → nothing staged');
  });

  it('trips medium+ on commit count threshold and warns when no critic ran', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getCommitCount = async () => 12;
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.isMediumPlus, true);
    assert.equal(result.output.warning, true);
    assert.equal(result.output.heuristic.commits, 12);
    assert.ok(ctx.staged['critic-check'], 'warning must stage scratch');
    assert.equal(ctx.staged['critic-check'].warning, true);
  });

  it('trips medium+ on line-change threshold', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getDiffStats = async () => ({ insertions: 400, deletions: 200 });
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.isMediumPlus, true);
    assert.equal(result.output.heuristic.lineChanges, 600);
    assert.equal(result.output.warning, true);
  });

  it('trips medium+ on chunk-tag in branch name', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getCurrentBranch = async () => 'feat/issue-139-chunk-7-critic';
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.isMediumPlus, true);
    assert.equal(result.output.heuristic.chunkTag, '7');
    assert.equal(result.output.heuristic.chunkTagSource, 'branch');
    assert.equal(result.output.warning, true);
  });

  it('trips medium+ on chunk-tag in commit subject when branch has none', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getCurrentBranch = async () => 'topic/cleanup';
    criticCheck._internal.getCommitSubjects = async () => ['Real foo (#139, Chunk 5)'];
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.heuristic.chunkTagSource, 'commit');
    assert.equal(result.output.heuristic.chunkTag, '5');
    assert.equal(result.output.warning, true);
  });

  it('warning=false when medium+ AND a critic-run exists for the current branch', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getCommitCount = async () => 15;
    writeCriticRuns([
      { branchName: 'feat/x', timestamp: '2026-05-16T10:00:00Z' }
    ]);
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.isMediumPlus, true);
    assert.equal(result.output.criticRan, true);
    assert.equal(result.output.warning, false,
      'critic-run on current branch must suppress the warning');
    assert.deepStrictEqual(ctx.staged, {},
      'no warning → nothing staged even if heuristic tripped');
  });

  it('warning=true when critic-runs exist only on OTHER branches', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getCommitCount = async () => 15;
    writeCriticRuns([
      { branchName: 'feat/other', timestamp: '2026-05-16T09:00:00Z' },
      { branchName: 'main', timestamp: '2026-05-16T08:00:00Z' }
    ]);
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.criticRan, false,
      'entries for other branches must NOT count for this branch');
    assert.equal(result.output.warning, true);
  });

  it('stages owedRationale when warning + options.criticSkipRationale is non-empty', async () => {
    const ctx = buildContext(
      { id: 'critic-check' },
      { criticSkipRationale: 'deferred per #999 follow-up' }
    );
    criticCheck._internal.getCommitCount = async () => 20;
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.warning, true);
    assert.equal(result.output.owedRationale, 'deferred per #999 follow-up');
    assert.equal(
      ctx.staged['critic-check'].owedRationale,
      'deferred per #999 follow-up'
    );
  });

  it('treats whitespace-only criticSkipRationale as no rationale', async () => {
    const ctx = buildContext(
      { id: 'critic-check' },
      { criticSkipRationale: '   \n  \t  ' }
    );
    criticCheck._internal.getCommitCount = async () => 20;
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.warning, true);
    assert.equal(result.output.owedRationale, null,
      'whitespace-only rationale must be treated as absent');
    assert.equal(ctx.staged['critic-check'].owedRationale, null);
  });

  it('honors custom step.commitThreshold and step.lineChangeThreshold', async () => {
    const ctx = buildContext({
      id: 'critic-check',
      commitThreshold: 3,
      lineChangeThreshold: 100
    });
    criticCheck._internal.getCommitCount = async () => 4;
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.isMediumPlus, true,
      'custom commitThreshold=3 must trip on commits=4');
    assert.equal(result.output.heuristic.commitThreshold, 3);
    assert.equal(result.output.heuristic.lineChangeThreshold, 100);
  });

  it('surfaces range degradation in output when on main branch directly', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getCurrentBranch = async () => 'main';
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.rangeDegraded, true);
    assert.match(result.output.rangeDegradedReason, /directly on main/);
    assert.match(result.output.rangeSpec, /^HEAD~\d+\.\.HEAD$/);
  });

  it('surfaces range degradation when origin/HEAD symref is missing', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getMainBranch = async () => null;
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.rangeDegraded, true);
    assert.match(result.output.rangeDegradedReason, /origin\/HEAD symref/);
  });

  it('output.criticRunsRecent picks top 3 by timestamp (descending — most recent first)', async () => {
    // Write entries OUT OF ORDER on purpose — the handler must sort by
    // timestamp, not by file insertion order, so producers that trim
    // or re-sort the file don't change the UI's "recent" list.
    const ctx = buildContext({ id: 'critic-check' });
    writeCriticRuns([
      { branchName: 'c', timestamp: '2026-05-16T03:00:00Z' },
      { branchName: 'a', timestamp: '2026-05-16T01:00:00Z' },
      { branchName: 'e', timestamp: '2026-05-16T05:00:00Z' },
      { branchName: 'b', timestamp: '2026-05-16T02:00:00Z' },
      { branchName: 'd', timestamp: '2026-05-16T04:00:00Z' }
    ]);
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.criticRunsRecent.length, 3);
    assert.deepStrictEqual(
      result.output.criticRunsRecent.map((e) => e.branchName),
      ['e', 'd', 'c'],
      'most-recent-first ordering must survive any file-write ordering'
    );
  });

  it('returns structured skipped result when an _internal git probe throws (Critic MAJOR-1)', async () => {
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getCommitCount = async () => {
      throw new Error('git binary not found');
    };
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, true,
      'always-ok contract MUST hold even on thrown git probes');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /git probe failed/);
    assert.match(result.output.error, /git binary not found/);
    assert.deepStrictEqual(result.blockers, []);
    assert.deepStrictEqual(ctx.staged, {},
      'failure must not leave half-written staging behind');
  });

  it('treats commitThreshold:0 as the default (Critic MAJOR-2 — footgun protection)', async () => {
    // Without the clamp, 0 ≥ 0 would trip medium+ on every wrap.
    const ctx = buildContext({ id: 'critic-check', commitThreshold: 0 });
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.heuristic.commitThreshold, 10,
      'commitThreshold:0 must fall back to the default 10, not be honored as-is');
    assert.equal(result.output.isMediumPlus, false,
      'zero-commit session must not be medium+ even with commitThreshold:0');
  });

  it('treats negative thresholds as the default (footgun protection)', async () => {
    const ctx = buildContext({
      id: 'critic-check',
      commitThreshold: -5,
      lineChangeThreshold: -100
    });
    const result = await criticCheck.run(ctx);
    assert.equal(result.output.heuristic.commitThreshold, 10);
    assert.equal(result.output.heuristic.lineChangeThreshold, 500);
  });

  it('treats non-integer thresholds (3.7, NaN, "5", null) as the default', async () => {
    for (const bad of [3.7, NaN, '5', null, undefined, {}]) {
      const ctx = buildContext({ id: 'critic-check', commitThreshold: bad });
      const result = await criticCheck.run(ctx);
      assert.equal(
        result.output.heuristic.commitThreshold, 10,
        `commitThreshold=${JSON.stringify(bad)} must fall back to default`
      );
    }
  });

  it('treats non-string criticSkipRationale (number, array, object, true) as no rationale', async () => {
    // typeof guard pin — a future refactor must not silently accept
    // non-string rationale shapes.
    for (const bad of [42, ['list'], { reason: 'obj' }, true, null]) {
      const ctx = buildContext(
        { id: 'critic-check' },
        { criticSkipRationale: bad }
      );
      criticCheck._internal.getCommitCount = async () => 20;
      const result = await criticCheck.run(ctx);
      assert.equal(result.output.warning, true);
      assert.equal(result.output.owedRationale, null,
        `non-string rationale ${JSON.stringify(bad)} must not be staged`);
    }
  });

  // ============================================================
  // #264 (halt on Critic blocking): critic-check halts the pipeline
  // when .tangleclaw/critic-runs.json contains an entry on the
  // current branch with `ranAt:"actual"` and at least one finding
  // of `severity:"blocking"`. Operator-override via
  // `options.criticBlockingOverride === true` proceeds anyway but
  // stages the override for the commit-message footer.
  // ============================================================

  it('#264 — halts (ok:false status:blocked) when a blocking finding exists on current branch', async () => {
    writeCriticRuns([
      {
        branchName: 'feat/x',
        timestamp: '2026-05-30T18:00:00.000Z',
        ranAt: 'actual',
        findings: [
          { severity: 'blocking', summary: 'load-bearing bug not fixed' }
        ]
      }
    ]);
    const ctx = buildContext({ id: 'critic-check' });
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.output.blockingFindingCount, 1);
    assert.equal(result.output.blockingFindings.length, 1);
    assert.match(result.blockers[0], /1 BLOCKING finding\(s\)/);
    assert.match(result.blockers[1], /load-bearing bug/);
    assert.match(result.blockers[result.blockers.length - 1], /criticBlockingOverride/);
    // #223 — blocked output carries operator remediation for the drawer
    // (merged into the existing output object, not clobbering it).
    assert.equal(typeof result.output.remediation, 'string');
    assert.match(result.output.remediation, /verify-resolutions/);
    assert.equal(result.output.blockingFindingCount, 1, 'existing output fields preserved alongside remediation');
  });

  it('#264 — case-insensitive severity match — "BLOCKING" also halts', async () => {
    writeCriticRuns([
      {
        branchName: 'feat/x',
        timestamp: '2026-05-30T18:00:00.000Z',
        ranAt: 'actual',
        findings: [{ severity: 'BLOCKING', summary: 'uppercase shape' }]
      }
    ]);
    const ctx = buildContext({ id: 'critic-check' });
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, false);
    assert.equal(result.output.blockingFindingCount, 1);
  });

  it('#264 — ranAt:"ack" entries (pre-#267 schema) are NEVER treated as blocking', async () => {
    // The ack-only / legacy ack predicate path stays warning-only —
    // only #267-era real-invocation entries can carry findings that
    // halt. This pins backward compat for projects whose Critic was
    // run externally / via the legacy button.
    writeCriticRuns([
      {
        branchName: 'feat/x',
        timestamp: '2026-05-30T18:00:00.000Z',
        ranAt: 'ack',
        findings: [{ severity: 'blocking', summary: 'should not halt' }]
      },
      // pre-#267 entry (no ranAt at all) — also must not halt
      { branchName: 'feat/x', timestamp: '2026-05-29T18:00:00.000Z' }
    ]);
    const ctx = buildContext({ id: 'critic-check' });
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, true, 'ranAt:"ack" / no-ranAt entries do NOT halt the pipeline');
    assert.equal(result.output.blockingFindingCount, 0);
    assert.equal(result.output.criticRan, true,
      'criticRan predicate still true — these entries satisfy the warning-suppression role');
  });

  it('#264 — non-blocking findings (warning / note) do NOT halt', async () => {
    writeCriticRuns([
      {
        branchName: 'feat/x',
        timestamp: '2026-05-30T18:00:00.000Z',
        ranAt: 'actual',
        findings: [
          { severity: 'warning', summary: 'noise' },
          { severity: 'note', summary: 'fyi' }
        ]
      }
    ]);
    const ctx = buildContext({ id: 'critic-check' });
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.blockingFindingCount, 0);
  });

  it('#264 — blocking findings on a DIFFERENT branch do NOT halt the current-branch wrap', async () => {
    writeCriticRuns([
      {
        branchName: 'feat/other',
        timestamp: '2026-05-30T18:00:00.000Z',
        ranAt: 'actual',
        findings: [{ severity: 'blocking', summary: 'on other branch' }]
      }
    ]);
    const ctx = buildContext({ id: 'critic-check' });
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, true,
      'sibling branch blockers must not bleed into current-branch wrap');
    assert.equal(result.output.blockingFindingCount, 0);
  });

  it('#264 — operator override (criticBlockingOverride:true) bypasses halt and stages audit trail', async () => {
    writeCriticRuns([
      {
        branchName: 'feat/x',
        timestamp: '2026-05-30T18:00:00.000Z',
        ranAt: 'actual',
        findings: [
          { severity: 'blocking', summary: 'fix-A' },
          { severity: 'blocking', summary: 'fix-B' }
        ]
      }
    ]);
    const ctx = buildContext(
      { id: 'critic-check' },
      {
        criticBlockingOverride: true,
        criticBlockingOverrideReason: 'hotfix incident #911 — ship now, fix forward'
      }
    );
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, true, 'override flips back to ok:true');
    assert.equal(result.status, 'done');
    assert.equal(result.output.blockingFindingCount, 2);
    assert.equal(result.output.blockingOverrideApplied, true);
    assert.equal(result.output.blockingOverrideReason, 'hotfix incident #911 — ship now, fix forward');
    const stagedEntry = ctx.staged['critic-check-blocking-override'];
    assert.ok(stagedEntry, 'override entry must be staged for the commit step');
    assert.equal(stagedEntry.overrideBlockingFindings, true);
    assert.equal(stagedEntry.findingCount, 2);
    assert.equal(stagedEntry.reason, 'hotfix incident #911 — ship now, fix forward');
  });

  it('#264 — override without rationale still bypasses halt (stages null reason)', async () => {
    writeCriticRuns([
      {
        branchName: 'feat/x',
        timestamp: '2026-05-30T18:00:00.000Z',
        ranAt: 'actual',
        findings: [{ severity: 'blocking', summary: 'x' }]
      }
    ]);
    const ctx = buildContext(
      { id: 'critic-check' },
      { criticBlockingOverride: true }
    );
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.blockingOverrideReason, null,
      'rationale is optional — but its absence is recorded so the commit body shows "(no rationale provided)"');
    assert.equal(ctx.staged['critic-check-blocking-override'].reason, null);
  });

  it('#264 — heuristic warning + blocking finding coexist: warning is suppressed by criticRan, halt still fires', async () => {
    // Mid-session medium+ scenario: tripping the heuristic AND having
    // a blocking finding. The warning path checks criticRan (true →
    // suppressed) while the halt path checks blocking findings (present
    // → halt). Pin that the two predicates are independent.
    writeCriticRuns([
      {
        branchName: 'feat/x',
        timestamp: '2026-05-30T18:00:00.000Z',
        ranAt: 'actual',
        findings: [{ severity: 'blocking', summary: 'real issue' }]
      }
    ]);
    const ctx = buildContext({ id: 'critic-check' });
    criticCheck._internal.getCommitCount = async () => 20; // trip medium+
    const result = await criticCheck.run(ctx);
    assert.equal(result.ok, false, 'blocking finding wins — pipeline halts');
    assert.equal(result.output.warning, false,
      'criticRan suppresses the heuristic warning even though medium+ tripped');
    assert.equal(result.output.isMediumPlus, true);
    assert.equal(result.output.blockingFindingCount, 1);
  });
});

describe('wrap-step critic-check — _selectRecentRuns (#139 Chunk 7)', () => {
  const criticCheck = require('../lib/wrap-steps/critic-check');

  it('returns [] for empty / non-array input', () => {
    assert.deepStrictEqual(criticCheck._selectRecentRuns([], 3), []);
    assert.deepStrictEqual(criticCheck._selectRecentRuns(null, 3), []);
    assert.deepStrictEqual(criticCheck._selectRecentRuns(undefined, 3), []);
  });

  it('returns at most N entries (descending by timestamp)', () => {
    const out = criticCheck._selectRecentRuns([
      { branchName: 'old', timestamp: '2020-01-01T00:00:00Z' },
      { branchName: 'mid', timestamp: '2022-01-01T00:00:00Z' },
      { branchName: 'new', timestamp: '2024-01-01T00:00:00Z' }
    ], 2);
    assert.deepStrictEqual(out.map((e) => e.branchName), ['new', 'mid']);
  });

  it('sorts entries with missing/non-string timestamps to the bottom', () => {
    const out = criticCheck._selectRecentRuns([
      { branchName: 'has-ts', timestamp: '2024-01-01T00:00:00Z' },
      { branchName: 'no-ts' },
      { branchName: 'bad-ts', timestamp: 42 }
    ], 3);
    assert.equal(out[0].branchName, 'has-ts',
      'timestamped entry must sort first');
  });
});

describe('wrap-step critic-check — defaultLoadCriticRuns (#139 Chunk 7)', () => {
  const criticCheck = require('../lib/wrap-steps/critic-check');
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-load-critic-runs-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function freshProject() {
    const p = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    fs.mkdirSync(path.join(p, '.tangleclaw'), { recursive: true });
    return p;
  }

  it('returns [] when the file does not exist', () => {
    const p = freshProject();
    assert.deepStrictEqual(criticCheck._internal.loadCriticRuns(p), []);
  });

  it('returns [] when the file is malformed JSON (does not throw)', () => {
    const p = freshProject();
    fs.writeFileSync(path.join(p, '.tangleclaw', 'critic-runs.json'), '{not json');
    assert.deepStrictEqual(criticCheck._internal.loadCriticRuns(p), []);
  });

  it('returns [] when the file is JSON but not an array', () => {
    const p = freshProject();
    fs.writeFileSync(
      path.join(p, '.tangleclaw', 'critic-runs.json'),
      JSON.stringify({ branchName: 'x', timestamp: 't' })
    );
    assert.deepStrictEqual(criticCheck._internal.loadCriticRuns(p), []);
  });

  it('filters out entries missing branchName (defensive against partial writes)', () => {
    const p = freshProject();
    fs.writeFileSync(
      path.join(p, '.tangleclaw', 'critic-runs.json'),
      JSON.stringify([
        { branchName: 'good', timestamp: '2026-05-16T00:00:00Z' },
        { timestamp: '2026-05-16T00:00:00Z' },        // missing branchName
        { branchName: 42 },                            // non-string branchName
        null
      ])
    );
    const out = criticCheck._internal.loadCriticRuns(p);
    assert.equal(out.length, 1);
    assert.equal(out[0].branchName, 'good');
  });
});

// ── #139 Chunk 8: real `pr-check` step handler ──

describe('wrap-step pr-check — pure helpers (#139 Chunk 8)', () => {
  const prCheck = require('../lib/wrap-steps/pr-check');

  describe('_filterPrs', () => {
    it('drops drafts by default', () => {
      const prs = [
        { number: 1, isDraft: false },
        { number: 2, isDraft: true },
        { number: 3, isDraft: false }
      ];
      const out = prCheck._filterPrs(prs, {});
      assert.deepStrictEqual(out.map((p) => p.number), [1, 3]);
    });

    it('keeps drafts when step.includeDrafts === true', () => {
      const prs = [
        { number: 1, isDraft: false },
        { number: 2, isDraft: true }
      ];
      const out = prCheck._filterPrs(prs, { includeDrafts: true });
      assert.equal(out.length, 2);
    });

    it('treats missing isDraft as not-a-draft (keeps the PR)', () => {
      const prs = [{ number: 1 }]; // isDraft absent
      assert.equal(prCheck._filterPrs(prs, {}).length, 1);
    });
  });

  describe('_partitionPrs', () => {
    it('puts PRs whose headRefName matches currentBranch in sessionScoped', () => {
      const prs = [
        { number: 1, headRefName: 'feat/x' },
        { number: 2, headRefName: 'feat/y' },
        { number: 3, headRefName: 'feat/x' }
      ];
      const out = prCheck._partitionPrs(prs, 'feat/x');
      assert.deepStrictEqual(out.sessionScoped.map((p) => p.number), [1, 3]);
      assert.deepStrictEqual(out.otherOpen.map((p) => p.number), [2]);
    });

    it('returns everything in otherOpen when currentBranch is null', () => {
      const prs = [
        { number: 1, headRefName: 'feat/x' },
        { number: 2, headRefName: 'main' }
      ];
      const out = prCheck._partitionPrs(prs, null);
      assert.deepStrictEqual(out.sessionScoped, []);
      assert.equal(out.otherOpen.length, 2);
    });

    it('handles empty input cleanly', () => {
      const out = prCheck._partitionPrs([], 'feat/x');
      assert.deepStrictEqual(out, { sessionScoped: [], otherOpen: [] });
    });

    it('puts PRs with null/empty headRefName in otherOpen (defensive pin)', () => {
      // gh can return null/empty headRefName for orphaned PRs whose
      // source branch was deleted. `null === currentBranch` is false,
      // so they correctly fall into otherOpen. Pin so a future
      // `pr.headRefName.startsWith(...)` refactor doesn't NPE.
      const out = prCheck._partitionPrs(
        [{ number: 1, headRefName: null }, { number: 2, headRefName: '' }],
        'feat/x'
      );
      assert.deepStrictEqual(out.sessionScoped, []);
      assert.equal(out.otherOpen.length, 2);
    });
  });

  describe('GH_PR_JSON_FIELDS shape pin', () => {
    it('exports the documented JSON field list (downstream-consumer contract)', () => {
      // Snapshot pin: the gh JSON fields are an exported surface and
      // downstream consumers (Chunk 9 commit step body builder; Chunk 10
      // UI renderers) rely on the shape. A rename / reorder here MUST
      // be paired with a CHANGELOG callout — this test forces the
      // conversation.
      assert.equal(
        prCheck.GH_PR_JSON_FIELDS,
        'number,title,headRefName,baseRefName,url,createdAt,isDraft,author'
      );
    });
  });

  describe('_normalizeHandling', () => {
    const sessionScoped = [
      { number: 100, headRefName: 'feat/x' },
      { number: 200, headRefName: 'feat/x' }
    ];

    it('returns empty resolutions/invalid for undefined/null prHandling', () => {
      assert.deepStrictEqual(prCheck._normalizeHandling(undefined, sessionScoped),
        { resolutions: {}, invalid: [] });
      assert.deepStrictEqual(prCheck._normalizeHandling(null, sessionScoped),
        { resolutions: {}, invalid: [] });
    });

    it('applies a string shortcut to every session-scoped PR', () => {
      const out = prCheck._normalizeHandling('merge', sessionScoped);
      assert.deepStrictEqual(out.resolutions, { 100: 'merge', 200: 'merge' });
      assert.deepStrictEqual(out.invalid, []);
    });

    it('rejects unknown string shortcuts with a clear invalid entry', () => {
      const out = prCheck._normalizeHandling('squash-bomb', sessionScoped);
      assert.deepStrictEqual(out.resolutions, {});
      assert.equal(out.invalid.length, 1);
      assert.match(out.invalid[0], /Unknown prHandling shortcut/);
    });

    it('accepts a per-PR object map', () => {
      const out = prCheck._normalizeHandling({ 100: 'merge', 200: 'defer' }, sessionScoped);
      assert.deepStrictEqual(out.resolutions, { 100: 'merge', 200: 'defer' });
      assert.deepStrictEqual(out.invalid, []);
    });

    it('flags unknown PR numbers in the object map', () => {
      const out = prCheck._normalizeHandling({ 999: 'merge' }, sessionScoped);
      assert.deepStrictEqual(out.resolutions, {});
      assert.match(out.invalid[0], /999 does not match any session-scoped open PR/);
    });

    it('flags bad handling values in the object map', () => {
      const out = prCheck._normalizeHandling({ 100: 'rebase-and-pray' }, sessionScoped);
      assert.deepStrictEqual(out.resolutions, {});
      assert.match(out.invalid[0], /prHandling\[100\].*not one of merge\|defer\|ignore/);
    });

    it('rejects array prHandling shape (must be string or object map)', () => {
      const out = prCheck._normalizeHandling(['merge'], sessionScoped);
      assert.match(out.invalid[0], /must be a string shortcut or an object map/);
    });

    it('coerces numeric keys consistently with PR number string lookup', () => {
      // Both the map key and the PR number can be number-or-string; pin
      // that the lookup normalizes both sides to string.
      const out = prCheck._normalizeHandling({ '100': 'merge' }, sessionScoped);
      assert.deepStrictEqual(out.resolutions, { 100: 'merge' });
    });
  });
});

describe('wrap-step pr-check — handler (#139 Chunk 8)', () => {
  const prCheck = require('../lib/wrap-steps/pr-check');
  let originals;
  let projectPath;

  before(() => {
    originals = { ...prCheck._internal };
  });

  // Restore `_internal` after the suite so a sibling describe block
  // (e.g. defaultListOpenPrs JSON handling below) captures the truly-
  // original `_internal` rather than this suite's last-test stubs.
  // Without this `after` hook, the JSON handling suite's `originals`
  // snapshot would be polluted by whatever the final handler test
  // stubbed (`listOpenPrs = async () => {...}`).
  after(() => {
    Object.assign(prCheck._internal, originals);
  });

  beforeEach(() => {
    Object.assign(prCheck._internal, originals);
    projectPath = '/tmp/sandbox-pr-check';
  });

  /** Build a minimal context; stubs default to "gh present, no PRs." */
  function buildContext(step, options) {
    prCheck._internal.isGhAvailable = async () => true;
    prCheck._internal.getCurrentBranch = async () => 'feat/x';
    prCheck._internal.listOpenPrs = async () => ({ ok: true, prs: [], reason: null });
    return {
      project: { name: 'sandbox', path: projectPath, id: 1 },
      session: null,
      step,
      previousResults: [],
      staged: {},
      options: options || {}
    };
  }

  it('always returns ok:true — never blocks', async () => {
    const result = await prCheck.run({
      project: { name: 'no-path', id: 1 },
      step: { id: 'pr-check' },
      previousResults: [],
      staged: {},
      options: {}
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /requires context\.project\.path/);
  });

  it('skips with reason when gh is not available', async () => {
    const ctx = buildContext({ id: 'pr-check' });
    prCheck._internal.isGhAvailable = async () => false;
    const result = await prCheck.run(ctx);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /gh CLI not available/);
    assert.deepStrictEqual(ctx.staged, {}, 'gh-missing must not stage anything');
  });

  it('skips with detail when gh pr list returns non-zero (no auth / not a repo)', async () => {
    const ctx = buildContext({ id: 'pr-check' });
    prCheck._internal.listOpenPrs = async () => ({
      ok: false, prs: [], reason: 'no logged-in github account', exitCode: 4
    });
    const result = await prCheck.run(ctx);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /could not enumerate/);
    assert.match(result.output.detail, /no logged-in github account/);
    assert.equal(result.output.ghExitCode, 4);
  });

  it('done with empty buckets when there are no open PRs', async () => {
    const ctx = buildContext({ id: 'pr-check' });
    const result = await prCheck.run(ctx);
    assert.equal(result.status, 'done');
    assert.equal(result.output.counts.openTotal, 0);
    assert.equal(result.output.counts.sessionScoped, 0);
    assert.equal(result.output.counts.otherOpen, 0);
    assert.deepStrictEqual(ctx.staged, {}, 'no PRs → nothing staged');
  });

  it('surfaces a session-scoped PR and stages it for Chunk 9 commit', async () => {
    const ctx = buildContext({ id: 'pr-check' });
    prCheck._internal.listOpenPrs = async () => ({
      ok: true,
      prs: [
        { number: 42, title: 'WIP', headRefName: 'feat/x', isDraft: false, url: 'https://example.com/pr/42' },
        { number: 7,  title: 'other', headRefName: 'feat/y', isDraft: false, url: 'https://example.com/pr/7' }
      ],
      reason: null
    });
    const result = await prCheck.run(ctx);
    assert.equal(result.status, 'done');
    assert.equal(result.output.counts.sessionScoped, 1);
    assert.equal(result.output.counts.otherOpen, 1);
    assert.equal(result.output.sessionScoped[0].number, 42);
    assert.equal(result.output.otherOpen[0].number, 7);
    assert.ok(ctx.staged['pr-check'], 'session-scoped PR must stage');
    assert.equal(ctx.staged['pr-check'].sessionScoped[0].number, 42);
  });

  it('hides drafts by default; includeDrafts=true keeps them', async () => {
    const listing = async () => ({
      ok: true,
      prs: [
        { number: 1, headRefName: 'feat/x', isDraft: false },
        { number: 2, headRefName: 'feat/x', isDraft: true }
      ],
      reason: null
    });
    // Default: drafts hidden
    const ctxDefault = buildContext({ id: 'pr-check' });
    prCheck._internal.listOpenPrs = listing;
    const def = await prCheck.run(ctxDefault);
    assert.equal(def.output.counts.openTotal, 1);
    assert.equal(def.output.counts.rawTotal, 2,
      'rawTotal must surface the unfiltered count for UI "hidden drafts" hint');

    // Opt-in: drafts kept
    const ctxOptIn = buildContext({ id: 'pr-check', includeDrafts: true });
    prCheck._internal.listOpenPrs = listing;
    const opt = await prCheck.run(ctxOptIn);
    assert.equal(opt.output.counts.openTotal, 2);
  });

  it('threads options.prHandling resolutions through to staged scratch', async () => {
    const ctx = buildContext(
      { id: 'pr-check' },
      { prHandling: { 42: 'merge' } }
    );
    prCheck._internal.listOpenPrs = async () => ({
      ok: true,
      prs: [{ number: 42, headRefName: 'feat/x', isDraft: false }],
      reason: null
    });
    const result = await prCheck.run(ctx);
    assert.equal(result.output.resolutions[42], 'merge');
    assert.equal(ctx.staged['pr-check'].resolutions[42], 'merge');
  });

  it('stages even when sessionScoped is empty but caller resolved something invalid (so UI can show the error)', async () => {
    const ctx = buildContext(
      { id: 'pr-check' },
      { prHandling: { 999: 'merge' } }
    );
    const result = await prCheck.run(ctx);
    // No session-scoped PRs, so the resolution targets nothing real.
    assert.equal(result.output.invalidHandling.length, 1);
    // No staging since both sessionScoped and resolutions are empty.
    assert.deepStrictEqual(ctx.staged, {},
      'invalid-only handling should NOT stage — nothing for commit step to do');
  });

  it('skips when isGhAvailable throws (always-ok contract via outer try/catch)', async () => {
    const ctx = buildContext({ id: 'pr-check' });
    prCheck._internal.isGhAvailable = async () => { throw new Error('exec spawn fail'); };
    const result = await prCheck.run(ctx);
    assert.equal(result.ok, true, 'always-ok contract MUST hold');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /pr-check probe failed/);
    assert.match(result.output.error, /exec spawn fail/);
  });

  it('puts all PRs in otherOpen when current branch is unresolvable (null)', async () => {
    const ctx = buildContext({ id: 'pr-check' });
    prCheck._internal.getCurrentBranch = async () => null;
    prCheck._internal.listOpenPrs = async () => ({
      ok: true,
      prs: [{ number: 1, headRefName: 'feat/x', isDraft: false }],
      reason: null
    });
    const result = await prCheck.run(ctx);
    assert.equal(result.output.counts.sessionScoped, 0);
    assert.equal(result.output.counts.otherOpen, 1);
    assert.deepStrictEqual(ctx.staged, {},
      'no current branch + no session-scoped match + no resolutions → nothing staged');
  });
});

describe('wrap-step pr-check — defaultListOpenPrs JSON handling (#139 Chunk 8)', () => {
  const prCheck = require('../lib/wrap-steps/pr-check');
  let originals;

  before(() => {
    originals = { ...prCheck._internal };
  });

  beforeEach(() => {
    Object.assign(prCheck._internal, originals);
  });

  it('reports ok:false reason when gh exits non-zero', async () => {
    prCheck._internal.exec = async () => ({
      exitCode: 4, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login\n', error: null
    });
    const r = await originals.listOpenPrs('/tmp/x');
    assert.equal(r.ok, false);
    assert.match(r.reason, /gh auth login/);
    assert.equal(r.exitCode, 4);
  });

  it('reports ok:false reason on malformed JSON stdout', async () => {
    prCheck._internal.exec = async () => ({
      exitCode: 0, stdout: 'not-json-at-all', stderr: '', error: null
    });
    const r = await originals.listOpenPrs('/tmp/x');
    assert.equal(r.ok, false);
    assert.match(r.reason, /malformed JSON/);
  });

  it('reports ok:false reason when stdout is a JSON non-array (object/null)', async () => {
    prCheck._internal.exec = async () => ({
      exitCode: 0, stdout: '{"error":"oops"}', stderr: '', error: null
    });
    const r = await originals.listOpenPrs('/tmp/x');
    assert.equal(r.ok, false);
    assert.match(r.reason, /non-array JSON/);
  });

  it('returns ok:true with parsed PR array on happy path', async () => {
    prCheck._internal.exec = async () => ({
      exitCode: 0,
      stdout: JSON.stringify([{ number: 1, title: 'x' }]),
      stderr: '', error: null
    });
    const r = await originals.listOpenPrs('/tmp/x');
    assert.equal(r.ok, true);
    assert.equal(r.prs[0].number, 1);
  });
});

// ── #139 Chunk 9 — commit step (single-transaction flush + lastWrapSha) ──

describe('wrap-step commit — pure helpers (#139 Chunk 9)', () => {
  const commitStep = require('../lib/wrap-steps/commit');

  describe('_buildSubject', () => {
    it('extracts chunk tag from a feat/chunk-N-... branch', () => {
      const s = commitStep._buildSubject('feat/chunk-9-commit-orchestration');
      assert.equal(s, 'Session wrap (chunk 9)');
    });

    it('extracts dotted/lettered chunk ids', () => {
      assert.equal(
        commitStep._buildSubject('feat/chunk-10c.2-foo'),
        'Session wrap (chunk 10c.2)'
      );
    });

    it('falls back to branch name when no chunk tag', () => {
      assert.equal(
        commitStep._buildSubject('feat/some-feature'),
        'Session wrap on feat/some-feature'
      );
    });

    it('falls back to generic when branch is null', () => {
      assert.equal(commitStep._buildSubject(null), 'Session wrap');
    });

    it('truncates oversized subjects to MAX_SUBJECT_LEN with ellipsis', () => {
      const longBranch = 'feat/' + 'x'.repeat(200);
      const s = commitStep._buildSubject(longBranch);
      assert.ok(s.length <= commitStep.MAX_SUBJECT_LEN,
        `subject ${s.length} chars must be ≤ MAX_SUBJECT_LEN (${commitStep.MAX_SUBJECT_LEN})`);
      assert.ok(s.endsWith('…'), 'truncated subject must end with ellipsis');
    });
  });

  describe('_buildBodyLines', () => {
    it('renders the priming-roll pointer when staged', () => {
      const lines = commitStep._buildBodyLines({
        'next-session-prime': {
          primingPath: '/x/priming.md',
          newContent: 'irrelevant',
          changed: true,
          pointer: {
            current: { id: '9', title: 'Commit step', blockedOn: null },
            next: null,
            allDone: false
          }
        }
      });
      assert.deepStrictEqual(lines, ['- Priming rolled to Chunk 9 — Commit step']);
    });

    it('renders blockedOn under the priming pointer', () => {
      const lines = commitStep._buildBodyLines({
        'next-session-prime': {
          primingPath: '/x', newContent: 'x', changed: true,
          pointer: { current: { id: '5', title: 'T', blockedOn: 'dep-X' }, next: null, allDone: false }
        }
      });
      assert.deepStrictEqual(lines, [
        '- Priming rolled to Chunk 5 — T',
        '  (blocked on: dep-X)'
      ]);
    });

    it('renders allDone when the plan has no more chunks', () => {
      const lines = commitStep._buildBodyLines({
        'next-session-prime': {
          primingPath: '/x', newContent: 'x', changed: true,
          pointer: { current: null, next: null, allDone: true }
        }
      });
      assert.deepStrictEqual(lines, ['- Priming: all chunks in plan marked done (next-session-prime)']);
    });

    it('renders a body line when priming-roll has no parseable chunks (current:null, allDone:false)', () => {
      // Critic MINOR pin (#139 Chunk 9): priming-roll's _selectPointer
      // returns `{current:null, next:null, allDone:false}` when the
      // plan has no `### Chunk N:` headings at all. The handler still
      // stages a priming write — the commit message must mention it
      // rather than silently swallowing the file change.
      const lines = commitStep._buildBodyLines({
        'next-session-prime': {
          primingPath: '/x', newContent: 'x', changed: true,
          pointer: { current: null, next: null, allDone: false }
        }
      });
      assert.deepStrictEqual(lines, [
        '- Priming refreshed (next-session-prime): plan has no parseable chunks'
      ]);
    });

    it('renders ai-content captures with parsed fields', () => {
      const lines = commitStep._buildBodyLines({
        'memory-update': {
          capturedText: 'long-text',
          parsedFields: { summary: 'a', nextSteps: 'b', learnings: 'c' }
        }
      });
      assert.equal(lines.length, 1);
      assert.match(lines[0], /AI content \(memory-update\): captured fields \[summary, nextSteps, learnings\]/);
    });

    it('renders ai-content captures without parsed fields as the minimal form', () => {
      const lines = commitStep._buildBodyLines({
        'learnings-capture': { capturedText: 'long-text', parsedFields: null }
      });
      assert.deepStrictEqual(lines, ['- AI content (learnings-capture): captured']);
    });

    it('renders an ai-content user-override skip as an audit line (#328)', () => {
      const lines = commitStep._buildBodyLines({
        'memory-update': { aiContentSkipped: true, stepId: 'memory-update' }
      });
      assert.deepStrictEqual(lines, ['- AI content (memory-update): skipped via user override']);
    });

    it('renders critic-check skip rationale', () => {
      const lines = commitStep._buildBodyLines({
        'critic-check': {
          warning: true,
          owedRationale: 'small refactor, no Critic needed',
          isMediumPlus: true,
          criticRan: false
        }
      });
      assert.deepStrictEqual(lines, [
        '- Critic skip rationale: small refactor, no Critic needed'
      ]);
    });

    it('renders critic-check warning without rationale (user did not provide one)', () => {
      const lines = commitStep._buildBodyLines({
        'critic-check': { warning: true, owedRationale: null }
      });
      assert.deepStrictEqual(lines, [
        '- Critic warning: medium+ work without Critic dispatch (no rationale provided)'
      ]);
    });

    it('renders pr-check session-scoped count + per-PR resolutions', () => {
      const lines = commitStep._buildBodyLines({
        'pr-check': {
          branch: 'feat/x',
          sessionScoped: [
            { number: 42, title: 'foo' },
            { number: 43, title: 'bar' }
          ],
          resolutions: { '42': 'merge', '43': 'defer' },
          invalidHandling: []
        }
      });
      assert.deepStrictEqual(lines, [
        '- Open session-scoped PRs: 2',
        '  - PR #42: merge',
        '  - PR #43: defer'
      ]);
    });

    it('ignores staged entries that do not match any known shape', () => {
      const lines = commitStep._buildBodyLines({
        'something-future': { totallyUnrelated: 'shape' }
      });
      assert.deepStrictEqual(lines, []);
    });

    it('renders a version-bump line from staged metadata (open-queue #3)', () => {
      const lines = commitStep._buildBodyLines({
        'version-bump:version-json': {
          primingPath: '/proj/version.json',
          newContent: '{"version":"3.17.0"}\n',
          changed: true,
          oldVersion: '3.16.2',
          newVersion: '3.17.0',
          bumpLevel: 'minor'
        }
      });
      assert.deepStrictEqual(lines, ['- Bumped 3.16.2 → 3.17.0 (minor)']);
    });

    it('dedupes version-bump body line across two staged write entries (version-json + changelog)', () => {
      // version-bump stages two entries — both carry the bump metadata
      // so the body-line builder must emit exactly ONE "Bumped …" line,
      // not one per file. Pin both insertion orders to make sure the
      // dedupe holds regardless of which entry the iterator sees first.
      const stagedA = {
        'version-bump:version-json': {
          primingPath: '/proj/version.json', newContent: 'x', changed: true,
          oldVersion: '3.16.2', newVersion: '3.17.0', bumpLevel: 'minor'
        },
        'version-bump:changelog': {
          primingPath: '/proj/CHANGELOG.md', newContent: 'y', changed: true,
          oldVersion: '3.16.2', newVersion: '3.17.0', bumpLevel: 'minor'
        }
      };
      const stagedB = {
        'version-bump:changelog': stagedA['version-bump:changelog'],
        'version-bump:version-json': stagedA['version-bump:version-json']
      };
      assert.deepStrictEqual(commitStep._buildBodyLines(stagedA), ['- Bumped 3.16.2 → 3.17.0 (minor)']);
      assert.deepStrictEqual(commitStep._buildBodyLines(stagedB), ['- Bumped 3.16.2 → 3.17.0 (minor)']);
    });

    it('returns [] for null/undefined staged maps', () => {
      assert.deepStrictEqual(commitStep._buildBodyLines(null), []);
      assert.deepStrictEqual(commitStep._buildBodyLines(undefined), []);
      assert.deepStrictEqual(commitStep._buildBodyLines({}), []);
    });
  });

  describe('_buildMessage', () => {
    it('returns subject only when staged body is empty', () => {
      assert.equal(commitStep._buildMessage({}, null), 'Session wrap');
    });

    it('assembles subject + blank line + body', () => {
      const msg = commitStep._buildMessage(
        {
          'critic-check': { warning: true, owedRationale: 'tiny change' }
        },
        'feat/chunk-9-x'
      );
      assert.equal(
        msg,
        'Session wrap (chunk 9)\n\n- Critic skip rationale: tiny change'
      );
    });
  });

  describe('_flushStagedWrites', () => {
    it('skips entries without primingPath/newContent', () => {
      const commitStepLocal = require('../lib/wrap-steps/commit');
      const writes = [];
      const orig = { ...commitStepLocal._internal };
      commitStepLocal._internal.writeFileSync = (p, c) => writes.push({ p, c });
      commitStepLocal._internal.mkdirSync = () => {};
      try {
        const flushed = commitStepLocal._flushStagedWrites({
          'pr-check': { sessionScoped: [], resolutions: {} },
          'memory-update': { capturedText: 'x', parsedFields: null }
        });
        assert.deepStrictEqual(flushed, []);
        assert.deepStrictEqual(writes, []);
      } finally {
        Object.assign(commitStepLocal._internal, orig);
      }
    });

    it('skips entries with changed:false (idempotent re-wrap)', () => {
      const commitStepLocal = require('../lib/wrap-steps/commit');
      const writes = [];
      const orig = { ...commitStepLocal._internal };
      commitStepLocal._internal.writeFileSync = (p, c) => writes.push({ p, c });
      commitStepLocal._internal.mkdirSync = () => {};
      try {
        const flushed = commitStepLocal._flushStagedWrites({
          'next-session-prime': { primingPath: '/x.md', newContent: 'unchanged', changed: false }
        });
        assert.deepStrictEqual(flushed, []);
        assert.deepStrictEqual(writes, []);
      } finally {
        Object.assign(commitStepLocal._internal, orig);
      }
    });

    it('writes when changed is true', () => {
      const commitStepLocal = require('../lib/wrap-steps/commit');
      const writes = [];
      const mkdirs = [];
      const orig = { ...commitStepLocal._internal };
      commitStepLocal._internal.writeFileSync = (p, c) => writes.push({ p, c });
      commitStepLocal._internal.mkdirSync = (p, opts) => mkdirs.push({ p, opts });
      try {
        const flushed = commitStepLocal._flushStagedWrites({
          'next-session-prime': { primingPath: '/proj/.claude/priming/build-session.md', newContent: 'new body', changed: true }
        });
        assert.deepStrictEqual(flushed, [
          { stepId: 'next-session-prime', path: '/proj/.claude/priming/build-session.md' }
        ]);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].p, '/proj/.claude/priming/build-session.md');
        assert.equal(writes[0].c, 'new body');
        assert.equal(mkdirs[0].opts.recursive, true,
          'parent directory must be created with recursive:true');
      } finally {
        Object.assign(commitStepLocal._internal, orig);
      }
    });

    it('writes when changed is missing (treated as needs-write — defensive default)', () => {
      const commitStepLocal = require('../lib/wrap-steps/commit');
      const writes = [];
      const orig = { ...commitStepLocal._internal };
      commitStepLocal._internal.writeFileSync = (p, c) => writes.push({ p, c });
      commitStepLocal._internal.mkdirSync = () => {};
      try {
        commitStepLocal._flushStagedWrites({
          x: { primingPath: '/a.md', newContent: 'b' }
        });
        assert.equal(writes.length, 1, 'missing `changed` must default to write');
      } finally {
        Object.assign(commitStepLocal._internal, orig);
      }
    });

    it('returns [] for null/undefined staged maps', () => {
      const commitStepLocal = require('../lib/wrap-steps/commit');
      assert.deepStrictEqual(commitStepLocal._flushStagedWrites(null), []);
      assert.deepStrictEqual(commitStepLocal._flushStagedWrites(undefined), []);
    });
  });
});

describe('wrap-step commit — handler against real git repo (#139 Chunk 9)', () => {
  const commitStep = require('../lib/wrap-steps/commit');
  const { execSync } = require('node:child_process');
  let tmpDir;
  let projectPath;
  let originals;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-step-commit-'));
    originals = { ...commitStep._internal };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Fresh sandbox repo per test — git state must not leak between cases.
    Object.assign(commitStep._internal, originals);
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    execSync('git init --quiet', { cwd: projectPath });
    execSync('git config user.email t@example.com && git config user.name Test',
      { cwd: projectPath, shell: '/bin/sh' });
    fs.writeFileSync(path.join(projectPath, 'README.md'), 'init\n');
    execSync('git add README.md && git commit --quiet -m init',
      { cwd: projectPath, shell: '/bin/sh' });
  });

  /** Build a minimal context for the commit handler. */
  function buildContext(staged, projectOverride) {
    return {
      project: projectOverride || { name: 'sandbox', path: projectPath, id: 1 },
      session: null,
      step: { id: 'commit', kind: 'commit', blocker: true },
      previousResults: [],
      staged: staged || {},
      options: {}
    };
  }

  it('blocks when context.project.path is missing', async () => {
    const result = await commitStep.run({
      project: { name: 'no-path', id: 1 },
      step: { id: 'commit', kind: 'commit' },
      staged: {}
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /requires context\.project\.path/);
  });

  it('skips with no commit when working tree is clean and no staged writes', async () => {
    const ctx = buildContext({});
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.equal(result.output.commitSha, null);
    assert.match(result.output.reason, /no changes to commit/);

    // Verify no new commit was added.
    const log = execSync('git log --oneline', { cwd: projectPath }).toString();
    assert.equal(log.trim().split('\n').length, 1, 'commit step must not have added a commit');
  });

  it('skips when staged priming entry has changed:false and tree is clean', async () => {
    const ctx = buildContext({
      'next-session-prime': {
        primingPath: path.join(projectPath, '.claude/priming/build-session.md'),
        newContent: 'would-not-write',
        changed: false,
        pointer: { current: { id: '1', title: 'x', blockedOn: null }, next: null, allDone: false }
      }
    });
    const result = await commitStep.run(ctx);
    assert.equal(result.status, 'skipped',
      'changed:false must not produce a write, and a clean tree must not produce a commit');
    assert.equal(fs.existsSync(path.join(projectPath, '.claude/priming/build-session.md')), false,
      'changed:false must not flush to disk');
  });

  it('flushes a priming-roll staged write and produces one commit', async () => {
    const primingPath = path.join(projectPath, '.claude/priming/build-session.md');
    const ctx = buildContext({
      'next-session-prime': {
        primingPath,
        newContent: '<!-- TANGLECLAW:PRIMING-ROLL:BEGIN -->\nActive: Chunk 9 — Commit\n<!-- TANGLECLAW:PRIMING-ROLL:END -->\n',
        changed: true,
        pointer: { current: { id: '9', title: 'Commit', blockedOn: null }, next: null, allDone: false }
      }
    });
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.ok(result.output.commitSha, 'must capture commit SHA');
    assert.match(result.output.commitSha, /^[0-9a-f]{7,40}$/, 'SHA must be hex');
    assert.equal(fs.existsSync(primingPath), true, 'staged write must be flushed');
    assert.match(fs.readFileSync(primingPath, 'utf8'), /Chunk 9 — Commit/);
    assert.equal(result.output.flushed.length, 1);
    assert.equal(result.output.flushed[0].stepId, 'next-session-prime');

    // Exactly one new commit landed.
    const log = execSync('git log --oneline', { cwd: projectPath }).toString();
    assert.equal(log.trim().split('\n').length, 2, 'init + one wrap commit');
  });

  it('picks up a working-tree change (AI-style MEMORY.md edit) the AI made before commit step ran', async () => {
    // Simulate the ai-content step having the AI write to MEMORY.md
    // in the working tree (the AI does its own writes; capturedText is
    // just metadata staged for the commit message).
    const memoryDir = path.join(projectPath, '.tangleclaw/memories');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory\n\n## Last Session\n…\n');

    const ctx = buildContext({
      'memory-update': {
        capturedText: 'whatever',
        parsedFields: { summary: 's' }
      }
    });
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.ok(result.output.commitSha);
    const files = execSync('git show --name-only --format= HEAD', { cwd: projectPath }).toString();
    assert.match(files, /\.tangleclaw\/memories\/MEMORY\.md/,
      'AI-written MEMORY.md must be included in the wrap commit');
  });

  it('stamps lastWrapSha on projConfig after a successful commit', async () => {
    // projectConfig.load/save are file-based on the project's own
    // `.tangleclaw/project.json` — no store DB init needed.
    const storeMod = require('../lib/store');
    fs.writeFileSync(path.join(projectPath, 'changed.txt'), 'hi\n');
    const ctx = buildContext({});
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    assert.ok(result.output.commitSha);
    assert.equal(result.output.stamped, true);

    const cfg = storeMod.projectConfig.load(projectPath);
    assert.equal(cfg.lastWrapSha, result.output.commitSha,
      'projConfig.lastWrapSha must equal the commit SHA');
  });

  it('returns blocked when git commit exits non-zero (pre-commit hook rejection)', async () => {
    // Install a pre-commit hook that rejects everything.
    const hookDir = path.join(projectPath, '.git/hooks');
    const hookPath = path.join(hookDir, 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "rejected by hook" >&2\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);

    fs.writeFileSync(path.join(projectPath, 'change.txt'), 'hi\n');
    const ctx = buildContext({});
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /git commit failed/);
    assert.match(result.blockers[0], /rejected by hook/);
    // #223 — blocked output carries operator remediation for the drawer.
    assert.equal(typeof result.output.remediation, 'string');
    assert.match(result.output.remediation, /pre-commit hook/);

    // No commit landed.
    const log = execSync('git log --oneline', { cwd: projectPath }).toString();
    assert.equal(log.trim().split('\n').length, 1, 'hook rejection must leave commit unmade');
  });

  it('blocks with explanatory message when git status fails (non-repo)', async () => {
    // Replace the exec internal to simulate a non-repo or git-missing
    // environment — easier to mock than to delete .git from under a
    // running test.
    commitStep._internal.exec = async () => ({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository\n'
    });
    const ctx = buildContext({});
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /git status failed/);
    assert.match(result.blockers[0], /not a git repository/);
  });

  it('surfaces flush errors as blockers, never as runner exceptions', async () => {
    commitStep._internal.writeFileSync = () => { throw new Error('EROFS'); };
    const ctx = buildContext({
      'next-session-prime': {
        primingPath: path.join(projectPath, '.claude/priming/build-session.md'),
        newContent: 'x',
        changed: true,
        pointer: { current: { id: '1', title: 'x', blockedOn: null }, next: null, allDone: false }
      }
    });
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Failed to flush staged write/);
    assert.match(result.blockers[0], /EROFS/);
  });

  it('builds a session-content commit message from staged content', async () => {
    const primingPath = path.join(projectPath, '.claude/priming/build-session.md');
    // Simulate the AI edit AND priming staging both happening before commit.
    fs.mkdirSync(path.join(projectPath, '.tangleclaw/memories'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.tangleclaw/memories/MEMORY.md'), '# Memory\n');
    execSync('git checkout -b feat/chunk-9-msg-test --quiet', { cwd: projectPath });

    const ctx = buildContext({
      'next-session-prime': {
        primingPath, newContent: 'pri\n', changed: true,
        pointer: { current: { id: '9', title: 'Commit step', blockedOn: null }, next: null, allDone: false }
      },
      'memory-update': { capturedText: 'mem', parsedFields: { summary: 's' } },
      'critic-check': { warning: true, owedRationale: 'trivial change' }
    });
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    const subjAndBody = execSync('git log -1 --pretty=%B', { cwd: projectPath }).toString();
    assert.match(subjAndBody, /^Session wrap \(chunk 9\)/);
    assert.match(subjAndBody, /Priming rolled to Chunk 9 — Commit step/);
    assert.match(subjAndBody, /AI content \(memory-update\): captured fields \[summary\]/);
    assert.match(subjAndBody, /Critic skip rationale: trivial change/);
  });

  it('uses generic subject when HEAD is detached (no branch)', async () => {
    fs.writeFileSync(path.join(projectPath, 'change.txt'), 'a\n');
    // Detach HEAD.
    const sha = execSync('git rev-parse HEAD', { cwd: projectPath }).toString().trim();
    execSync(`git checkout --quiet ${sha}`, { cwd: projectPath });

    const ctx = buildContext({});
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    const subj = execSync('git log -1 --pretty=%s', { cwd: projectPath }).toString().trim();
    assert.equal(subj, 'Session wrap',
      'detached HEAD has no branch → subject falls back to generic');
  });

  // ── Critic MINOR pins (#139 Chunk 9): failure-path test coverage ──

  it('returns ok:true with stamped:false when projConfig.save throws but commit succeeded', async () => {
    // Critic MINOR: the _stampLastWrapSha path is non-fatal — the commit
    // already landed, the stamp is a hint for Chunks 4/7 range detection.
    // Mock the store.projectConfig.save to throw and assert the run
    // result stays ok:true with output.stamped:false.
    const storeMod = require('../lib/store');
    const origSave = storeMod.projectConfig.save;
    storeMod.projectConfig.save = () => { throw new Error('EACCES from save mock'); };
    try {
      fs.writeFileSync(path.join(projectPath, 'something.txt'), 'x\n');
      const ctx = buildContext({});
      const result = await commitStep.run(ctx);
      assert.equal(result.ok, true, 'commit landed; stamp failure is non-fatal');
      assert.equal(result.status, 'done');
      assert.ok(result.output.commitSha, 'commit SHA still captured');
      assert.equal(result.output.stamped, false,
        'output.stamped must reflect the failure so Chunk 10 UI can surface "stamp failed"');
    } finally {
      storeMod.projectConfig.save = origSave;
    }
  });

  it('returns ok:true with commitSha:null when git rev-parse HEAD fails after commit succeeded', async () => {
    // Critic MINOR: the rev-parse-after-commit failure path is
    // documented as non-blocking in commit.js — the commit already
    // landed, we just can't capture the SHA. Verify the run result
    // surfaces commitSha:null + stamped:false on this path.
    fs.writeFileSync(path.join(projectPath, 'rev-parse-test.txt'), 'x\n');

    // Replace exec so the LAST call (rev-parse HEAD) returns non-zero
    // while the prior three (status, add, commit) hit the real git.
    const realExec = commitStep._internal.exec;
    let callIdx = 0;
    commitStep._internal.exec = async (file, args, opts) => {
      callIdx++;
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { exitCode: 1, stdout: '', stderr: 'fake rev-parse failure' };
      }
      return realExec(file, args, opts);
    };
    try {
      const ctx = buildContext({});
      const result = await commitStep.run(ctx);
      assert.equal(result.ok, true,
        'commit landed; rev-parse failure must not block the pipeline');
      assert.equal(result.output.commitSha, null,
        'rev-parse failure → commitSha:null');
      assert.equal(result.output.stamped, false,
        'no SHA → no stamp');
      // The commit DID land — verify via git log directly.
      const log = execSync('git log --oneline', { cwd: projectPath }).toString();
      assert.equal(log.trim().split('\n').length, 2,
        'init + the wrap commit must both be present');
    } finally {
      commitStep._internal.exec = realExec;
    }
  });

  it('blocks when git add -A exits non-zero', async () => {
    // Critic MINOR: only `git status` and `git commit` failure paths
    // were tested. Cover `git add` failure too — completes the three-
    // path matrix.
    fs.writeFileSync(path.join(projectPath, 'add-test.txt'), 'x\n');

    const realExec = commitStep._internal.exec;
    commitStep._internal.exec = async (file, args, opts) => {
      if (file === 'git' && args[0] === 'add') {
        return { exitCode: 128, stdout: '', stderr: 'fatal: git add mock failure\n' };
      }
      return realExec(file, args, opts);
    };
    try {
      const ctx = buildContext({});
      const result = await commitStep.run(ctx);
      assert.equal(result.ok, false);
      assert.equal(result.status, 'blocked');
      assert.match(result.blockers[0], /git add -A failed/);
      assert.match(result.blockers[0], /git add mock failure/);
      // No new commit landed.
      const log = execSync('git log --oneline', { cwd: projectPath }).toString();
      assert.equal(log.trim().split('\n').length, 1,
        'git add failure must leave commit unmade');
    } finally {
      commitStep._internal.exec = realExec;
    }
  });

  // ============================================================
  // #264 (auto-branch on main): commit step redirects wrap commits
  // away from `main`/`master` to `wrap/<ts>-<slug>` branches unless
  // operator explicitly opts out via `options.allowDirectToMain`.
  // ============================================================

  it('#264 — auto-branches off main into wrap/<ts>-<slug> when context.options.allowDirectToMain is not set', async () => {
    // Default test repo is on the init branch named "main" or "master"
    // depending on git config. Normalize to "main" so the auto-branch
    // path fires deterministically.
    execSync('git branch -M main', { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'TODO.md'), 'work\n');
    const ctx = buildContext({});
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.autoBranched, true);
    assert.equal(result.output.originalBranch, 'main');
    assert.match(result.output.branch, /^wrap\/\d{14}-sandbox$/,
      'auto-branch name should be wrap/<YYYYMMDDHHmmss>-<project-slug>');
    // Verify the commit landed on the new branch, NOT on main
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath }).toString().trim();
    assert.equal(currentBranch, result.output.branch,
      'working tree HEAD must be on the new wrap branch after auto-branch');
    const mainLog = execSync('git log main --oneline', { cwd: projectPath }).toString();
    assert.equal(mainLog.trim().split('\n').length, 1,
      'main must NOT have the wrap commit (still just the init commit)');
  });

  it('#264 — auto-branches off master too (treats master as protected like main)', async () => {
    execSync('git branch -M master', { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'TODO.md'), 'work\n');
    const ctx = buildContext({});
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.autoBranched, true);
    assert.equal(result.output.originalBranch, 'master');
  });

  it('#264 — allowDirectToMain:true commits directly to main (operator escape hatch)', async () => {
    execSync('git branch -M main', { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'TODO.md'), 'work\n');
    const ctx = buildContext({});
    ctx.options = { allowDirectToMain: true };
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.autoBranched, false);
    assert.equal(result.output.originalBranch, 'main');
    assert.equal(result.output.branch, 'main');
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath }).toString().trim();
    assert.equal(currentBranch, 'main', 'escape hatch keeps HEAD on main');
  });

  it('#264 — feature branches are NEVER auto-branched (no behavioral change)', async () => {
    execSync('git checkout -b feat/some-feature', { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'TODO.md'), 'work\n');
    const ctx = buildContext({});
    const result = await commitStep.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.autoBranched, false);
    assert.equal(result.output.originalBranch, 'feat/some-feature');
    assert.equal(result.output.branch, 'feat/some-feature',
      'feature-branch wraps are unchanged');
  });

  it('#264 — auto-branch git checkout failure blocks the wrap cleanly', async () => {
    execSync('git branch -M main', { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'TODO.md'), 'work\n');
    // Pre-create the wrap branch name so `git checkout -b` fails with
    // "branch already exists." Mock the timestamp seam isn't exposed,
    // but pre-creating any branch whose name our generator could pick
    // works because the failing checkout returns exit ≠ 0 regardless.
    const realExec = commitStep._internal.exec;
    commitStep._internal.exec = async (file, args, opts) => {
      if (file === 'git' && args[0] === 'checkout' && args[1] === '-b') {
        return { exitCode: 128, stdout: '', stderr: 'fatal: A branch named already exists.\n' };
      }
      return realExec(file, args, opts);
    };
    try {
      const ctx = buildContext({});
      const result = await commitStep.run(ctx);
      assert.equal(result.ok, false);
      assert.equal(result.status, 'blocked');
      assert.match(result.blockers[0], /Auto-branch failed/);
      assert.match(result.blockers[1], /allowDirectToMain/,
        'block message must surface the escape-hatch option');
      // main is unchanged
      const log = execSync('git log --oneline', { cwd: projectPath }).toString();
      assert.equal(log.trim().split('\n').length, 1,
        'auto-branch failure must leave main untouched');
    } finally {
      commitStep._internal.exec = realExec;
    }
  });

  it('#264 — commit body line "Critic-override: …" renders when override entry is staged', () => {
    // _buildBodyLines is pure — test directly without git involvement.
    const lines = commitStep._buildBodyLines({
      'critic-check-blocking-override': {
        overrideBlockingFindings: true,
        findingCount: 3,
        reason: 'shipping the regression intentionally',
        branchName: 'main'
      }
    });
    assert.ok(lines.some((l) => /^- Critic-override: shipping the regression intentionally \(3 blocking finding\(s\) ignored\)$/.test(l)),
      'Override line must render the rationale + finding count for audit trail');
  });

  it('#264 — commit body line "Critic-override (no rationale provided)" when reason absent', () => {
    const lines = commitStep._buildBodyLines({
      'critic-check-blocking-override': {
        overrideBlockingFindings: true,
        findingCount: 1,
        reason: null,
        branchName: 'main'
      }
    });
    assert.ok(lines.some((l) => /\(no rationale provided\)/.test(l)),
      'Missing rationale must still produce an audit-trail line');
  });
});

describe('runWrapPipeline — commitSha threading (#139 Chunk 9)', () => {
  const wrapPipelineMod = require('../lib/wrap-pipeline');
  let tmpDir;
  let projectPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pipeline-commitsha-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });
    store.projects.create({
      name: 'commitsha-test',
      path: projectPath,
      methodology: 'prawduct'
    });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('surfaces the commit step output.commitSha on the runner return shape', async () => {
    // Stub every other step to no-op so the runner reaches the commit step.
    const realKinds = ['lint', 'test', 'ai-content', 'priming-roll', 'critic-check', 'pr-check', 'version-bump'];
    const originals = {};
    const noopRun = async () => ({ ok: true, status: 'done', output: null, blockers: [] });
    for (const kind of realKinds) {
      originals[kind] = wrapPipelineMod.STEP_DISPATCH[kind];
      wrapPipelineMod.STEP_DISPATCH[kind] = { run: noopRun };
    }
    const origCommit = wrapPipelineMod.STEP_DISPATCH['commit'];
    wrapPipelineMod.STEP_DISPATCH['commit'] = {
      run: async () => ({
        ok: true,
        status: 'done',
        output: { commitSha: 'deadbeefcafe1234567890abcdef01234567890a', message: 'x', flushed: [], stamped: true },
        blockers: []
      })
    };

    try {
      const result = await wrapPipelineMod.runWrapPipeline('commitsha-test');
      assert.equal(result.ok, true);
      assert.equal(result.commitSha, 'deadbeefcafe1234567890abcdef01234567890a',
        'runner must surface commit step output.commitSha at the top level');
    } finally {
      for (const kind of realKinds) {
        wrapPipelineMod.STEP_DISPATCH[kind] = originals[kind];
      }
      wrapPipelineMod.STEP_DISPATCH['commit'] = origCommit;
    }
  });

  it('keeps commitSha null when commit step skips (clean session)', async () => {
    const realKinds = ['lint', 'test', 'ai-content', 'priming-roll', 'critic-check', 'pr-check', 'version-bump'];
    const originals = {};
    const noopRun = async () => ({ ok: true, status: 'done', output: null, blockers: [] });
    for (const kind of realKinds) {
      originals[kind] = wrapPipelineMod.STEP_DISPATCH[kind];
      wrapPipelineMod.STEP_DISPATCH[kind] = { run: noopRun };
    }
    const origCommit = wrapPipelineMod.STEP_DISPATCH['commit'];
    wrapPipelineMod.STEP_DISPATCH['commit'] = {
      run: async () => ({
        ok: true,
        status: 'skipped',
        output: { reason: 'no changes to commit', flushed: [], commitSha: null },
        blockers: []
      })
    };

    try {
      const result = await wrapPipelineMod.runWrapPipeline('commitsha-test');
      assert.equal(result.ok, true);
      assert.equal(result.commitSha, null,
        'a skipped (clean) commit step must leave runner commitSha null');
    } finally {
      for (const kind of realKinds) {
        wrapPipelineMod.STEP_DISPATCH[kind] = originals[kind];
      }
      wrapPipelineMod.STEP_DISPATCH['commit'] = origCommit;
    }
  });

  it('keeps commitSha null when the pipeline halts before reaching commit', async () => {
    const origAiContent = wrapPipelineMod.STEP_DISPATCH['ai-content'];
    const origCommit = wrapPipelineMod.STEP_DISPATCH['commit'];
    // Make the FIRST ai-content step block, with the prawduct template's
    // version-bump → ai-content chain. We need to swap the template's
    // first ai-content step to blocker:true so the runner halts.
    const pristine = JSON.stringify(store.templates.get('prawduct'));
    const prawduct = JSON.parse(pristine);
    const firstAiStep = prawduct.wrap_pipeline.steps.find((s) => s.kind === 'ai-content');
    firstAiStep.blocker = true;
    store.templates.save(prawduct);

    wrapPipelineMod.STEP_DISPATCH['ai-content'] = {
      run: async () => ({ ok: false, status: 'blocked', output: null, blockers: ['x'] })
    };
    wrapPipelineMod.STEP_DISPATCH['commit'] = {
      run: async () => {
        throw new Error('commit step must not have run after pipeline halt');
      }
    };

    try {
      const result = await wrapPipelineMod.runWrapPipeline('commitsha-test');
      assert.equal(result.ok, false);
      assert.equal(result.commitSha, null,
        'halted pipeline must leave commitSha null');
    } finally {
      wrapPipelineMod.STEP_DISPATCH['ai-content'] = origAiContent;
      wrapPipelineMod.STEP_DISPATCH['commit'] = origCommit;
      // Restore pristine — `delete` would strip the bundled blocker:true (#328).
      store.templates.save(JSON.parse(pristine));
    }
  });
});

describe('bundled wrap_pipeline templates — commit step contract (#139 Chunk 9)', () => {
  // The bundled prawduct / minimal / tilt templates must declare
  // `blocker: true` on the commit step so a git failure halts the
  // pipeline. The back-compat shim ignores the `blocker` field, so
  // adding it here doesn't change the legacy NL prompt byte-equal pin.
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pipeline-commit-bundled-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prawduct commit step has blocker:true', () => {
    const t = store.templates.get('prawduct');
    const commitStep = t.wrap_pipeline.steps.find((s) => s.kind === 'commit');
    assert.ok(commitStep, 'prawduct must have a commit step');
    assert.equal(commitStep.blocker, true,
      'commit step must declare blocker:true so failures halt the pipeline');
  });

  it('minimal commit step has blocker:true', () => {
    const t = store.templates.get('minimal');
    const commitStep = t.wrap_pipeline.steps.find((s) => s.kind === 'commit');
    assert.ok(commitStep);
    assert.equal(commitStep.blocker, true);
  });

  // The `tilt` bundled template is gitignored (`.gitignore:24` — "Unreleased
  // methodology templates"), so a CI clone may not have it on disk. When
  // present locally we still want to verify it carries the same blocker:true
  // contract so a future un-gitignore lands cleanly.
  it('tilt commit step has blocker:true (skipped when tilt not present)', () => {
    const t = store.templates.get('tilt');
    if (!t) return; // skip — tilt not in this checkout
    const commitStep = t.wrap_pipeline.steps.find((s) => s.kind === 'commit');
    assert.ok(commitStep);
    assert.equal(commitStep.blocker, true);
  });

  // #264 / ADR 0002 amendment: critic-check step's blocker was
  // intentionally flipped from `false` to `"errors-only"` in the
  // prawduct bundled template so the runner's halt-on-!ok check fires
  // when blocking findings are present (since the handler now returns
  // ok:false in that case). Pin the contract here so a future
  // template-author can't silently revert it without a CI failure.
  it('#264 — prawduct critic-check step has blocker:"errors-only"', () => {
    const t = store.templates.get('prawduct');
    const criticStep = t.wrap_pipeline.steps.find((s) => s.kind === 'critic-check');
    assert.ok(criticStep, 'prawduct must declare a critic-check step');
    assert.equal(criticStep.blocker, 'errors-only',
      'critic-check must declare blocker:"errors-only" so the runner halts on ok:false ' +
      '(handler returns ok:false only when blocking findings exist + no override) per ADR 0002 amendment');
  });
});

describe('projConfig — lastWrapSha default (#139 Chunk 9)', () => {
  let tmpDir;
  let projectPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-projconfig-lastwrapsha-'));
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('DEFAULT_PROJECT_CONFIG includes lastWrapSha:null', () => {
    assert.equal(store.DEFAULT_PROJECT_CONFIG.lastWrapSha, null,
      'lastWrapSha must default to null so Chunks 4/7 fallbacks remain authoritative for un-wrapped projects');
  });

  it('round-trips lastWrapSha through load/save', () => {
    const cfg = store.projectConfig.load(projectPath);
    assert.equal(cfg.lastWrapSha, null);
    cfg.lastWrapSha = 'abc123def456';
    store.projectConfig.save(projectPath, cfg);
    const reloaded = store.projectConfig.load(projectPath);
    assert.equal(reloaded.lastWrapSha, 'abc123def456');
  });
});

describe('wrap-step version-bump — pure helpers (open-queue #3, post-#139)', () => {
  const versionBump = require('../lib/wrap-steps/version-bump');

  describe('_todayIsoLocal (#205 — local-zoned date)', () => {
    it('returns YYYY-MM-DD shape (10 chars, separators in correct positions)', () => {
      const out = versionBump._todayIsoLocal();
      assert.equal(typeof out, 'string');
      assert.equal(out.length, 10, 'should be exactly 10 characters');
      assert.equal(out[4], '-', 'separator at index 4');
      assert.equal(out[7], '-', 'separator at index 7');
      assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns LOCAL date (not UTC) when the host is in a non-UTC zone (#205 bug-distinguishing pin)', (t) => {
      // The bug was UTC emission; the fix uses local-zone date components.
      // To EXERCISE the bug-vs-fix distinction we need a wall-clock moment
      // where LOCAL date differs from UTC date — i.e. a host TZ with a
      // non-zero offset. On a UTC-host CI (Linux containers default to
      // UTC), local == UTC and the bug never surfaces, so the
      // distinguishing assertion is vacuous. Skip in that case; the wiring
      // pin test below still catches regressions on any host.
      if (new Date().getTimezoneOffset() === 0) {
        t.skip('host is in UTC; local-vs-UTC distinction is unobservable here');
        return;
      }

      const origDate = global.Date;
      try {
        // Pick a UTC moment that lives on a DIFFERENT calendar day than
        // the LOCAL projection of that same moment. `Date.UTC(2026, 4, 23,
        // 6, 30, 0)` = 2026-05-23 06:30 UTC. On every host with a negative
        // offset (Americas), the local projection is 2026-05-22. On every
        // host with a positive offset less than +24h (most of the world),
        // the local projection is also 2026-05-23 but at a different hour
        // — still distinguishable from UTC by `.getDate()` only on the
        // negative-offset half. To stay portable across positive-offset
        // hosts, also try a complementary moment: `Date.UTC(2026, 4, 22,
        // 18, 0, 0)` = 2026-05-22 18:00 UTC. On a Tokyo host (+09:00) this
        // is 2026-05-23 03:00 LOCAL — local IS the date-after.
        //
        // We pick whichever moment puts UTC and LOCAL on different days
        // for the host, then assert the LOCAL date matches what the
        // formatter returns AND differs from `toISOString().slice(0,10)`.
        const candidates = [
          new origDate(origDate.UTC(2026, 4, 23, 6, 30, 0)),   // negative-offset hosts split here
          new origDate(origDate.UTC(2026, 4, 22, 18, 0, 0))    // positive-offset hosts split here
        ];
        const pinned = candidates.find((m) => {
          const utcDay = m.toISOString().slice(0, 10);
          const pad = (n) => String(n).padStart(2, '0');
          const localDay = `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
          return utcDay !== localDay;
        });
        if (!pinned) {
          // Should not occur in practice — host offset would have to be
          // exactly 0 or a multiple of 24h. Defensive skip rather than a
          // false-positive failure.
          t.skip('could not construct a UTC/LOCAL date-mismatch moment for this host TZ');
          return;
        }

        global.Date = class extends origDate {
          constructor(...args) {
            super(...(args.length === 0 ? [pinned.getTime()] : args));
          }
        };

        const out = versionBump._todayIsoLocal();
        const pad = (n) => String(n).padStart(2, '0');
        const expectedLocal = `${pinned.getFullYear()}-${pad(pinned.getMonth() + 1)}-${pad(pinned.getDate())}`;
        assert.equal(out, expectedLocal,
          `must reflect local date ${expectedLocal} for the pinned UTC moment; got ${out}`);
        assert.notEqual(out, pinned.toISOString().slice(0, 10),
          'must NOT equal the UTC slice — that would mean the old bug still ships');
      } finally {
        global.Date = origDate;
      }
    });

    it('default _internal.todayIso is wired to the local-zoned helper (regression pin for #205)', () => {
      // The bug was the default factory shipping `() => new Date().toISOString().slice(0, 10)`
      // (UTC). The fix wires `_internal.todayIso` to `_todayIsoLocal`. Pin
      // the wiring so a future refactor cannot quietly revert.
      assert.equal(versionBump._internal.todayIso, versionBump._todayIsoLocal,
        '_internal.todayIso must point to _todayIsoLocal (the local-zoned formatter)');
    });
  });

  describe('_parseSemver', () => {
    it('parses canonical x.y.z', () => {
      assert.deepStrictEqual(versionBump._parseSemver('3.16.2'), { major: 3, minor: 16, patch: 2 });
      assert.deepStrictEqual(versionBump._parseSemver('0.0.1'), { major: 0, minor: 0, patch: 1 });
      assert.deepStrictEqual(versionBump._parseSemver('10.20.30'), { major: 10, minor: 20, patch: 30 });
    });

    it('returns null for invalid forms', () => {
      assert.equal(versionBump._parseSemver(''), null);
      assert.equal(versionBump._parseSemver('v3.16.2'), null, 'no `v` prefix accepted');
      assert.equal(versionBump._parseSemver('3.16'), null);
      assert.equal(versionBump._parseSemver('3.16.2-beta'), null, 'pre-release not supported');
      assert.equal(versionBump._parseSemver('not a version'), null);
      assert.equal(versionBump._parseSemver(null), null);
      assert.equal(versionBump._parseSemver(undefined), null);
    });
  });

  describe('_bumpSemver', () => {
    it('patch increments only the patch component', () => {
      assert.equal(versionBump._bumpSemver('3.16.2', 'patch'), '3.16.3');
      assert.equal(versionBump._bumpSemver('0.0.1', 'patch'), '0.0.2');
    });

    it('minor increments minor and resets patch', () => {
      assert.equal(versionBump._bumpSemver('3.16.2', 'minor'), '3.17.0');
      assert.equal(versionBump._bumpSemver('0.0.5', 'minor'), '0.1.0');
    });

    it('major increments major and resets minor + patch', () => {
      assert.equal(versionBump._bumpSemver('3.16.2', 'major'), '4.0.0');
      assert.equal(versionBump._bumpSemver('0.9.9', 'major'), '1.0.0');
    });

    it('returns null for invalid semver input', () => {
      assert.equal(versionBump._bumpSemver('not-a-version', 'patch'), null);
      assert.equal(versionBump._bumpSemver(null, 'minor'), null);
    });

    it('returns null for invalid bump level', () => {
      assert.equal(versionBump._bumpSemver('3.16.2', 'huge'), null);
      assert.equal(versionBump._bumpSemver('3.16.2', null), null);
    });
  });

  describe('_compareSemver / _topReleasedVersion (#203)', () => {
    it('_compareSemver orders by major, then minor, then patch', () => {
      const sv = (s) => versionBump._parseSemver(s);
      assert.equal(versionBump._compareSemver(sv('3.16.1'), sv('3.16.2')), -1);
      assert.equal(versionBump._compareSemver(sv('3.16.2'), sv('3.16.2')), 0);
      assert.equal(versionBump._compareSemver(sv('3.17.0'), sv('3.16.9')), 1);
      assert.equal(versionBump._compareSemver(sv('4.0.0'), sv('3.99.99')), 1);
      assert.equal(versionBump._compareSemver(sv('2.9.9'), sv('3.0.0')), -1);
    });

    it('_topReleasedVersion returns the first dated release heading', () => {
      const text = [
        '# Changelog', '',
        '## [Unreleased]', '', '### Added', '- x', '',
        '## [3.16.2] - 2026-05-13', '', '### Fixed', '- y', '',
        '## [3.16.1] - 2026-05-13'
      ].join('\n');
      assert.deepStrictEqual(versionBump._topReleasedVersion(text), { major: 3, minor: 16, patch: 2 });
    });

    it('_topReleasedVersion is null when no dated release heading exists', () => {
      assert.equal(versionBump._topReleasedVersion('## [Unreleased]\n### Added\n- only unreleased\n'), null);
      assert.equal(versionBump._topReleasedVersion(''), null);
      assert.equal(versionBump._topReleasedVersion(null), null);
      assert.equal(versionBump._topReleasedVersion(undefined), null);
    });
  });

  describe('_parseUnreleased', () => {
    it('finds the [Unreleased] block and categorizes subsections', () => {
      const text = [
        '# Changelog', '',
        '## [Unreleased]', '',
        '### Added', '- New thing', '',
        '### Fixed', '- Old bug', '',
        '## [3.16.2] - 2026-05-13', '',
        '### Fixed', '- Earlier release fix'
      ].join('\n');
      const r = versionBump._parseUnreleased(text);
      assert.equal(r.ok, true);
      assert.deepStrictEqual(r.subsections, ['Added', 'Fixed']);
      assert.equal(r.hasEntries, true);
    });

    it('endIdx stops at the next ## [ heading (does not bleed past)', () => {
      const text = [
        '## [Unreleased]', '',
        '### Added', '- One', '',
        '## [1.0.0] - 2026-01-01', '',
        '### Fixed', '- Earlier fix'
      ].join('\n');
      const r = versionBump._parseUnreleased(text);
      // Subsections should only contain "Added" (from [Unreleased]), not "Fixed" from [1.0.0].
      assert.deepStrictEqual(r.subsections, ['Added']);
    });

    it('reports hasEntries:false when [Unreleased] body has only blank lines or comments', () => {
      const text = ['## [Unreleased]', '', '', '## [1.0.0] - 2026-01-01'].join('\n');
      const r = versionBump._parseUnreleased(text);
      assert.equal(r.ok, true);
      assert.equal(r.hasEntries, false);
      assert.deepStrictEqual(r.subsections, []);
    });

    it('reports ok:false when [Unreleased] heading is missing', () => {
      const text = ['# Changelog', '', '## [3.16.0] - 2026-05-12', '### Added', '- thing'].join('\n');
      const r = versionBump._parseUnreleased(text);
      assert.equal(r.ok, false);
    });

    it('handles empty / nullish input safely', () => {
      assert.equal(versionBump._parseUnreleased('').ok, false);
      assert.equal(versionBump._parseUnreleased(null).ok, false);
      assert.equal(versionBump._parseUnreleased(undefined).ok, false);
    });

    it('dedupes subsections that appear twice (legal but unusual)', () => {
      const text = [
        '## [Unreleased]', '',
        '### Added', '- One', '',
        '### Added', '- Two', '',
        '## [1.0.0] - 2026-01-01'
      ].join('\n');
      const r = versionBump._parseUnreleased(text);
      assert.deepStrictEqual(r.subsections, ['Added']);
    });

    it('recognizes the `### Internal` subsection (#231) and surfaces it alongside the Keep-a-Changelog set', () => {
      // Pin: SUBSECTION_RE must include `Internal` so the parser
      // surfaces it for the bump-level decider. The bump-level
      // exclusion happens in `_decideBumpLevel`, not here.
      const text = [
        '## [Unreleased]', '',
        '### Internal', '- Refactor: extract helper', '',
        '### Added', '- New user-visible feature', '',
        '## [1.0.0] - 2026-01-01'
      ].join('\n');
      const r = versionBump._parseUnreleased(text);
      assert.equal(r.ok, true);
      assert.equal(r.hasEntries, true);
      assert.deepStrictEqual(r.subsections, ['Internal', 'Added'],
        'both subsections must be surfaced in source order');
    });
  });

  describe('_decideBumpLevel', () => {
    function parsed(subsections, body = '') {
      return { subsections, bodyLines: body.split('\n') };
    }

    it('options.bumpLevel override wins over heuristic', () => {
      assert.equal(versionBump._decideBumpLevel(parsed(['Added']), { bumpLevel: 'patch' }), 'patch');
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed']), { bumpLevel: 'major' }), 'major');
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed'], 'BREAKING: change'), { bumpLevel: 'patch' }),
        'patch', 'override beats BREAKING marker');
    });

    it('rejects unknown override values and falls through to heuristic', () => {
      assert.equal(versionBump._decideBumpLevel(parsed(['Added']), { bumpLevel: 'huge' }), 'minor');
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed']), { bumpLevel: '' }), 'patch');
    });

    it('BREAKING marker in body forces major (sans override)', () => {
      // Marker must look intentional — `BREAKING:` or `BREAKING(scope)`
      // — per the tightened regex (PR #202 Critic n1).
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed'], 'A line with BREAKING: api change'), {}), 'major');
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed'], '- BREAKING(api): renamed thing'), {}), 'major');
      assert.equal(versionBump._decideBumpLevel(parsed(['Added'], 'normal entry'), {}), 'minor',
        'no BREAKING → falls through to subsection vote');
    });

    it('casual uppercase BREAKING without a marker does NOT force major (PR #202 Critic n1)', () => {
      // Pre-tightening, `\bBREAKING\b` would have falsely matched
      // these. New regex requires `:` or `(` immediately following
      // the BREAKING word.
      assert.equal(versionBump._decideBumpLevel(parsed(['Added'], '## NOT BREAKING — just renamed'), {}), 'minor');
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed'], '- discussed BREAKING changes but none shipped'), {}), 'patch');
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed'], '- BREAKING discussion was wrong'), {}), 'patch',
        'BREAKING followed by space-and-letter must NOT match');
    });

    it('minor-trigger subsections: Added, Changed, Removed, Deprecated', () => {
      assert.equal(versionBump._decideBumpLevel(parsed(['Added']), {}), 'minor');
      assert.equal(versionBump._decideBumpLevel(parsed(['Changed']), {}), 'minor');
      assert.equal(versionBump._decideBumpLevel(parsed(['Removed']), {}), 'minor');
      assert.equal(versionBump._decideBumpLevel(parsed(['Deprecated']), {}), 'minor');
    });

    it('patch-only when only Fixed or Security entries present', () => {
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed']), {}), 'patch');
      assert.equal(versionBump._decideBumpLevel(parsed(['Security']), {}), 'patch');
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed', 'Security']), {}), 'patch');
    });

    it('mixed Added + Fixed → minor (Added trumps)', () => {
      assert.equal(versionBump._decideBumpLevel(parsed(['Added', 'Fixed']), {}), 'minor');
      assert.equal(versionBump._decideBumpLevel(parsed(['Fixed', 'Added']), {}), 'minor',
        'order within subsections must not matter');
    });

    it('defaults to patch when no subsections (defensive)', () => {
      assert.equal(versionBump._decideBumpLevel(parsed([]), {}), 'patch');
    });

    describe('`### Internal` subsection (#231)', () => {
      it('Internal-only [Unreleased] → patch (refactor-only releases stay at patch)', () => {
        assert.equal(versionBump._decideBumpLevel(parsed(['Internal']), {}), 'patch');
      });

      it('Internal + Fixed → patch (both are patch-tier; no minor escalation)', () => {
        assert.equal(versionBump._decideBumpLevel(parsed(['Internal', 'Fixed']), {}), 'patch');
        assert.equal(versionBump._decideBumpLevel(parsed(['Fixed', 'Internal']), {}), 'patch',
          'order must not matter');
      });

      it('Internal + Added → minor (user-visible Added wins; Internal does not veto)', () => {
        assert.equal(versionBump._decideBumpLevel(parsed(['Internal', 'Added']), {}), 'minor');
        assert.equal(versionBump._decideBumpLevel(parsed(['Added', 'Internal']), {}), 'minor',
          'order must not matter');
      });

      it('Internal + Changed → minor (Changed is user-visible per Keep-a-Changelog)', () => {
        assert.equal(versionBump._decideBumpLevel(parsed(['Internal', 'Changed']), {}), 'minor');
      });

      it('Internal + Removed → minor and Internal + Deprecated → minor (table↔test parity)', () => {
        // Pins the remaining two minor-trigger subsections against
        // Internal so the bump-level table in CLAUDE.md is fully
        // covered. Critic-recommended (#231 PR review).
        assert.equal(versionBump._decideBumpLevel(parsed(['Internal', 'Removed']), {}), 'minor');
        assert.equal(versionBump._decideBumpLevel(parsed(['Internal', 'Deprecated']), {}), 'minor');
      });

      it('`options.bumpLevel: \'minor\'` override on Internal-only [Unreleased] still bumps minor', () => {
        // The override path short-circuits the subsection vote (see
        // `_decideBumpLevel` precedence). Pinning this guarantees an
        // operator can still force minor on a refactor-only release
        // — #231's "stays patch by *default*" half is asserted, but
        // the override escape hatch is preserved.
        assert.equal(versionBump._decideBumpLevel(parsed(['Internal']), { bumpLevel: 'minor' }), 'minor');
        assert.equal(versionBump._decideBumpLevel(parsed(['Internal']), { bumpLevel: 'major' }), 'major',
          'major override also wins over Internal-only patch-default');
      });

      it('BREAKING marker still wins over Internal-only body', () => {
        assert.equal(
          versionBump._decideBumpLevel(parsed(['Internal'], '- BREAKING: API renamed'), {}),
          'major',
          'BREAKING precedence is unchanged by the #231 work'
        );
      });
    });
  });

  describe('_promoteUnreleased', () => {
    it('promotes the [Unreleased] body to a dated release section', () => {
      const before = [
        '# Changelog', '',
        '## [Unreleased]', '',
        '### Added', '- New feature', '',
        '## [3.16.2] - 2026-05-13', '',
        '### Fixed', '- Old bug'
      ].join('\n');
      const after = versionBump._promoteUnreleased(before, '3.17.0', '2026-05-22');

      // [Unreleased] still present + empty
      const lines = after.split('\n');
      const unreleasedIdx = lines.findIndex((l) => /^## \[Unreleased\]/.test(l));
      const newReleaseIdx = lines.findIndex((l) => /^## \[3\.17\.0\] - 2026-05-22/.test(l));
      const oldReleaseIdx = lines.findIndex((l) => /^## \[3\.16\.2\]/.test(l));
      assert.ok(unreleasedIdx !== -1, '[Unreleased] should still exist');
      assert.ok(newReleaseIdx > unreleasedIdx, 'new release section appears after [Unreleased]');
      assert.ok(oldReleaseIdx > newReleaseIdx, 'new release section appears before the prior release');

      // [Unreleased] body is now empty (no entries between [Unreleased] and new release)
      const unreleasedBody = lines.slice(unreleasedIdx + 1, newReleaseIdx).join('\n').trim();
      assert.equal(unreleasedBody, '', 'old [Unreleased] body must be moved, not duplicated');

      // New release section carries the original Added entry
      const newReleaseBody = lines.slice(newReleaseIdx + 1, oldReleaseIdx).join('\n');
      assert.match(newReleaseBody, /### Added/);
      assert.match(newReleaseBody, /- New feature/);

      // Prior release section preserved byte-for-byte
      const priorBody = lines.slice(oldReleaseIdx).join('\n');
      assert.match(priorBody, /### Fixed/);
      assert.match(priorBody, /- Old bug/);
    });

    it('does NOT auto-insert a `> 🛟` or `> 🚀` banner (curated decision per repo convention)', () => {
      const before = [
        '## [Unreleased]', '',
        '### Fixed', '- Patch bug', '',
        '## [1.0.0] - 2026-01-01'
      ].join('\n');
      const after = versionBump._promoteUnreleased(before, '1.0.1', '2026-05-22');
      assert.ok(!/^> 🛟/m.test(after), 'must not auto-insert 🛟 bug-fix banner');
      assert.ok(!/^> 🚀/m.test(after), 'must not auto-insert 🚀 feature banner');
    });

    it('returns the input unchanged when [Unreleased] is missing', () => {
      const before = '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n- thing\n';
      assert.equal(versionBump._promoteUnreleased(before, '1.0.1', '2026-05-22'), before);
    });

    it('preserves multi-paragraph entries with nested bullets', () => {
      const before = [
        '## [Unreleased]', '',
        '### Added', '',
        '- Feature with a long description',
        '  - Nested sub-point one',
        '  - Nested sub-point two',
        '',
        '- Another feature', '',
        '## [1.0.0] - 2026-01-01'
      ].join('\n');
      const after = versionBump._promoteUnreleased(before, '1.1.0', '2026-05-22');
      assert.match(after, /## \[1\.1\.0\] - 2026-05-22[\s\S]*Feature with a long description[\s\S]*Nested sub-point one[\s\S]*Nested sub-point two[\s\S]*Another feature/);
    });

    it('emits exactly one blank line between [Unreleased] heading and the new dated release heading (PR #202 Critic coverage gap)', () => {
      // Byte-exact whitespace pin — a stray double-blank-line between the
      // [Unreleased] heading and the new release heading would render
      // weirdly in `gh pr view` and look messy in editor diffs.
      const before = [
        '## [Unreleased]', '',
        '### Added', '- thing', '',
        '## [1.0.0] - 2026-01-01'
      ].join('\n');
      const after = versionBump._promoteUnreleased(before, '1.1.0', '2026-05-22');
      const lines = after.split('\n');
      const unreleasedIdx = lines.findIndex((l) => /^## \[Unreleased\]/.test(l));
      const newReleaseIdx = lines.findIndex((l) => /^## \[1\.1\.0\] - 2026-05-22/.test(l));
      assert.equal(newReleaseIdx - unreleasedIdx, 2,
        `expected exactly one blank line between [Unreleased] (line ${unreleasedIdx}) and new release (line ${newReleaseIdx}), got ${newReleaseIdx - unreleasedIdx - 1} blank line(s)`);
      assert.equal(lines[unreleasedIdx + 1].trim(), '', 'the line between must be blank');
    });

    it('promoted CHANGELOG output satisfies the structural invariants from test/changelog-structure.test.js (PR #202 Critic coverage gap)', () => {
      // Cross-file integrity pin: run the bump output through the same
      // detectors `test/changelog-structure.test.js` uses to gate the
      // real CHANGELOG.md. Regexes duplicated here (source of truth:
      // test/changelog-structure.test.js:12-13). Drift would surface as
      // a test failure in BOTH places, which is the desired symmetry.
      const RELEASE_HEADING_RE = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}\s*$/;
      const UNRELEASED_HEADING_RE = /^## \[Unreleased\]\s*$/;

      const before = [
        '# Changelog', '',
        '## [Unreleased]', '',
        '### Added', '- thing', '',
        '## [3.16.2] - 2026-05-13', '', '### Fixed', '- earlier', '',
        '## [3.16.1] - 2026-05-13', '', '### Fixed', '- earlier-earlier'
      ].join('\n');
      const after = versionBump._promoteUnreleased(before, '3.17.0', '2026-05-22');
      const lines = after.split('\n');

      // 1. Heading sequence: parseable + descending semver order + no dups
      const headings = [];
      lines.forEach((line) => {
        const m = line.match(RELEASE_HEADING_RE);
        if (m) headings.push({ v: [Number(m[1]), Number(m[2]), Number(m[3])], s: `${m[1]}.${m[2]}.${m[3]}` });
      });
      assert.equal(headings.length, 3, 'three released headings expected (3.17.0 + 3.16.2 + 3.16.1)');
      // Descending order
      for (let i = 1; i < headings.length; i++) {
        const a = headings[i - 1].v;
        const b = headings[i].v;
        const aGt = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
        assert.ok(aGt || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]),
          `headings out of order: ${headings[i - 1].s} should be >= ${headings[i].s}`);
      }
      // No duplicates
      const seen = new Set();
      for (const h of headings) {
        assert.ok(!seen.has(h.s), `duplicate heading detected: ${h.s}`);
        seen.add(h.s);
      }
      // [Unreleased] still present
      assert.ok(lines.some((l) => UNRELEASED_HEADING_RE.test(l)), '[Unreleased] heading must survive promotion');
    });
  });
});

describe('wrap-step version-bump — integration with commit._flushStagedWrites (PR #202 Critic coverage gap)', () => {
  const versionBump = require('../lib/wrap-steps/version-bump');
  const commitStep = require('../lib/wrap-steps/commit');
  let tmpRoot;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vb-flush-'));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('two composite-keyed staged entries flush correctly through commit._flushStagedWrites', async () => {
    // Bridge test between handler + commit step: version-bump's
    // staging is duck-typed at `commit.js:_flushStagedWrites`. This
    // pin proves the two composite-keyed entries both make it to
    // disk in a single flush call.
    const projDir = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.writeFileSync(path.join(projDir, 'version.json'), JSON.stringify({ version: '3.16.2', name: 'sample' }));
    fs.writeFileSync(path.join(projDir, 'CHANGELOG.md'),
      '## [Unreleased]\n\n### Added\n- A new feature\n\n## [3.16.0] - 2026-05-12\n');

    const origToday = versionBump._internal.todayIso;
    versionBump._internal.todayIso = () => '2026-05-22';
    try {
      const ctx = {
        project: { name: 'flush-bridge', path: projDir },
        step: { id: 'version-bump', kind: 'version-bump' },
        staged: {},
        options: {}
      };
      const result = await versionBump.run(ctx);
      assert.equal(result.status, 'done');

      const flushed = commitStep._flushStagedWrites(ctx.staged);
      // Both staged entries must flush (paths differ by file).
      assert.equal(flushed.length, 2, 'both staged entries must flush');
      const flushedPaths = flushed.map((f) => f.path).sort();
      assert.deepStrictEqual(flushedPaths, [
        path.join(projDir, 'CHANGELOG.md'),
        path.join(projDir, 'version.json')
      ]);

      // Confirm bytes on disk match the staged content.
      const writtenVj = JSON.parse(fs.readFileSync(path.join(projDir, 'version.json'), 'utf8'));
      assert.equal(writtenVj.version, '3.17.0', 'version.json on disk reflects the bump');
      assert.equal(writtenVj.name, 'sample', 'sibling fields preserved on disk');

      const writtenCl = fs.readFileSync(path.join(projDir, 'CHANGELOG.md'), 'utf8');
      assert.match(writtenCl, /## \[3\.17\.0\] - 2026-05-22/);
      assert.match(writtenCl, /## \[Unreleased\]/);
    } finally {
      versionBump._internal.todayIso = origToday;
    }
  });
});

describe('wrap-step version-bump — handler (open-queue #3, post-#139)', () => {
  const versionBump = require('../lib/wrap-steps/version-bump');
  let tmpDir;
  let origInternal;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vb-'));
    origInternal = { ...versionBump._internal };
  });

  after(() => {
    Object.assign(versionBump._internal, origInternal);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProject(name) {
    const dir = fs.mkdtempSync(path.join(tmpDir, `${name}-`));
    return { name, path: dir };
  }

  function freshContext(project, options) {
    return {
      project,
      step: { id: 'version-bump', kind: 'version-bump' },
      staged: {},
      options: options || {}
    };
  }

  beforeEach(() => {
    versionBump._internal.todayIso = () => '2026-05-22';
  });

  it('skips when project.path is missing', async () => {
    const result = await versionBump.run({ step: {}, staged: {}, options: {} });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.equal(result.output.skipped, undefined, '#204: output.skipped no longer set — status is the canonical skip signal');
    assert.match(result.output.reason, /no project path/i);
  });

  it('skips when neither version.json nor package.json is present (#298)', async () => {
    const project = makeProject('no-version-json');
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'), '## [Unreleased]\n### Added\n- x\n');
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /not version-tracked/i);
  });

  it('skips when version.json is malformed JSON', async () => {
    const project = makeProject('bad-json');
    fs.writeFileSync(path.join(project.path, 'version.json'), '{not valid');
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'), '## [Unreleased]\n### Added\n- x\n');
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /unreadable|invalid/i);
  });

  it('skips with a neutral reason when version.json "version" is non-semver (#318)', async () => {
    const project = makeProject('non-semver');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '2.85.0.1' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'), '## [Unreleased]\n### Added\n- x\n');
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.status, 'skipped');
    // Neutral wording — no alarming "missing or non-semver"; explains it's expected.
    assert.match(result.output.reason, /isn't MAJOR\.MINOR\.PATCH semver/);
    assert.match(result.output.reason, /manages its own versioning/);
    assert.doesNotMatch(result.output.reason, /missing or non-semver/);
  });

  it('skips with a "no version field" reason when version.json lacks a version (#318)', async () => {
    const project = makeProject('no-version');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ name: 'x' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'), '## [Unreleased]\n### Added\n- x\n');
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /no "version" field/);
  });

  it('skips when versionBumpEnabled is false, before reading version.json (#318 opt-out)', async () => {
    const project = makeProject('optout');
    // A perfectly bumpable setup — only the opt-out should stop it.
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'), '## [Unreleased]\n### Added\n- x\n');
    store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), versionBumpEnabled: false });
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /disabled for this project/);
  });

  it('skips when CHANGELOG.md is missing', async () => {
    const project = makeProject('no-changelog');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '3.16.2' }));
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /CHANGELOG\.md not found/i);
  });

  it('skips when [Unreleased] section is missing', async () => {
    const project = makeProject('no-unreleased');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '3.16.2' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      '# Changelog\n\n## [3.16.0] - 2026-05-12\n### Added\n- thing\n');
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /\[Unreleased\] section not found/i);
  });

  it('skips when [Unreleased] has no entries (already released)', async () => {
    const project = makeProject('empty-unreleased');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '3.16.2' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      '## [Unreleased]\n\n## [3.16.0] - 2026-05-12\n### Added\n- thing\n');
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /no entries/i);
  });

  it('done path stages both writes and returns output with from/to/bumpLevel/detail', async () => {
    const project = makeProject('happy');
    fs.writeFileSync(path.join(project.path, 'version.json'),
      JSON.stringify({ version: '3.16.2', name: 'sample' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      '## [Unreleased]\n\n### Added\n- A new feature\n\n## [3.16.0] - 2026-05-12\n### Added\n- thing\n');
    const ctx = freshContext(project);
    const result = await versionBump.run(ctx);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.equal(result.output.from, '3.16.2');
    assert.equal(result.output.to, '3.17.0', 'Added subsection → minor bump');
    assert.equal(result.output.bumpLevel, 'minor');
    assert.equal(result.output.versionFile, 'version.json', '#298: source file surfaced');
    assert.equal(result.output.detail, '3.16.2 → 3.17.0 (minor, version.json)');

    // Two staged writes under composite keys
    assert.ok(ctx.staged['version-bump:version-json'], 'version-json staging missing');
    assert.ok(ctx.staged['version-bump:changelog'], 'changelog staging missing');
    const vjEntry = ctx.staged['version-bump:version-json'];
    const clEntry = ctx.staged['version-bump:changelog'];
    assert.equal(vjEntry.primingPath, path.join(project.path, 'version.json'));
    assert.equal(clEntry.primingPath, path.join(project.path, 'CHANGELOG.md'));
    assert.equal(vjEntry.changed, true);
    assert.equal(clEntry.changed, true);
    assert.equal(vjEntry.bumpLevel, 'minor');
    assert.equal(vjEntry.oldVersion, '3.16.2');
    assert.equal(vjEntry.newVersion, '3.17.0');

    // version.json content preserves sibling fields and bumps version
    const newVj = JSON.parse(vjEntry.newContent);
    assert.equal(newVj.version, '3.17.0');
    assert.equal(newVj.name, 'sample', 'sibling fields must be preserved');

    // CHANGELOG content promoted with today's date
    assert.match(clEntry.newContent, /## \[3\.17\.0\] - 2026-05-22/);
    assert.match(clEntry.newContent, /## \[Unreleased\]/);
  });

  it('skips (drift guard #203) when newVersion is not strictly greater than CHANGELOG top released', async () => {
    // version.json trails the changelog: version.json says 3.16.0, but the
    // changelog already publishes 3.16.2 at top. A patch bump → 3.16.1 ≤
    // 3.16.2, so promoting would insert an out-of-order heading. Refuse.
    const project = makeProject('drift');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '3.16.0' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      '## [Unreleased]\n\n### Fixed\n- a bug\n\n## [3.16.2] - 2026-05-13\n### Fixed\n- earlier\n');
    const ctx = freshContext(project);
    const result = await versionBump.run(ctx);

    assert.equal(result.ok, true, 'must skip, never block (ADR 0002)');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /refusing to bump/i);
    assert.match(result.output.reason, /3\.16\.1/, 'reason names the rejected newVersion');
    assert.match(result.output.reason, /3\.16\.2/, 'reason names the top released version');
    assert.match(result.output.reason, /drift/i);
    // No writes staged — nothing should be promoted on the drift path.
    assert.equal(ctx.staged['version-bump:version-json'], undefined);
    assert.equal(ctx.staged['version-bump:changelog'], undefined);
  });

  it('proceeds when newVersion equals top-released +1 patch (boundary — not a drift)', async () => {
    // version.json 3.16.2, top released 3.16.2, patch bump → 3.16.3 > 3.16.2: OK.
    const project = makeProject('boundary-ok');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '3.16.2' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      '## [Unreleased]\n\n### Fixed\n- a bug\n\n## [3.16.2] - 2026-05-13\n### Fixed\n- earlier\n');
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.status, 'done');
    assert.equal(result.output.to, '3.16.3');
  });

  it('options.bumpLevel override wins over the Added → minor heuristic', async () => {
    const project = makeProject('override');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '3.16.2' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      '## [Unreleased]\n### Added\n- thing\n\n## [3.16.0] - 2026-05-12\n');
    const ctx = freshContext(project, { bumpLevel: 'major' });
    const result = await versionBump.run(ctx);
    assert.equal(result.status, 'done');
    assert.equal(result.output.to, '4.0.0', 'override must win');
    assert.equal(result.output.bumpLevel, 'major');
  });

  it('BREAKING marker forces major bump without override', async () => {
    const project = makeProject('breaking');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '3.16.2' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      '## [Unreleased]\n### Fixed\n- BREAKING: a transformative fix\n\n## [3.16.0] - 2026-05-12\n');
    const ctx = freshContext(project);
    const result = await versionBump.run(ctx);
    assert.equal(result.output.to, '4.0.0');
    assert.equal(result.output.bumpLevel, 'major');
  });

  it('idempotent on re-wrap: after a bump, a second run skips ("no entries")', async () => {
    const project = makeProject('idempotent');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '3.16.2' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      '## [Unreleased]\n### Added\n- One feature\n\n## [3.16.0] - 2026-05-12\n');

    // First run: real wrap pipeline would have the commit step flush
    // the staged writes; here we simulate that by writing the new
    // CHANGELOG content to disk ourselves.
    const ctx1 = freshContext(project);
    const result1 = await versionBump.run(ctx1);
    assert.equal(result1.status, 'done');
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      ctx1.staged['version-bump:changelog'].newContent);
    fs.writeFileSync(path.join(project.path, 'version.json'),
      ctx1.staged['version-bump:version-json'].newContent);

    // Second run should observe empty [Unreleased] and skip
    const ctx2 = freshContext(project);
    const result2 = await versionBump.run(ctx2);
    assert.equal(result2.status, 'skipped', 'idempotent re-wrap must skip');
    assert.equal(Object.keys(ctx2.staged).length, 0, 'no staging on skip');
  });

  it('only Fixed in [Unreleased] → patch bump', async () => {
    const project = makeProject('patch-only');
    fs.writeFileSync(path.join(project.path, 'version.json'), JSON.stringify({ version: '3.16.2' }));
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'),
      '## [Unreleased]\n### Fixed\n- Bug fix\n\n## [3.16.0] - 2026-05-12\n');
    const result = await versionBump.run(freshContext(project));
    assert.equal(result.output.to, '3.16.3');
    assert.equal(result.output.bumpLevel, 'patch');
  });

  it('never blocks — runner contract is "ok:true always"', async () => {
    // Sweep every skip path verified above + the happy path; assert ok===true
    // and no blockers across the lot. This is the contract pin.
    const scenarios = [
      { setup: () => ({ step: {}, staged: {}, options: {} }) },
      { setup: () => freshContext(makeProject('no-vj')) },
      { setup: () => {
          const p = makeProject('happy-sweep');
          fs.writeFileSync(path.join(p.path, 'version.json'), JSON.stringify({ version: '3.16.2' }));
          fs.writeFileSync(path.join(p.path, 'CHANGELOG.md'),
            '## [Unreleased]\n### Added\n- x\n\n## [3.16.0] - 2026-05-12\n');
          return freshContext(p);
        }
      }
    ];
    for (const { setup } of scenarios) {
      const ctx = setup();
      const result = await versionBump.run(ctx);
      assert.equal(result.ok, true, `scenario must return ok:true; got ${JSON.stringify(result)}`);
      assert.deepStrictEqual(result.blockers, [], `scenario must have empty blockers`);
    }
  });
});
