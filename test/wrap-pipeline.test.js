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
        'ai-content', 'priming-roll', 'version-bump', 'commit'
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
      // ai-content) that require live OS state (a configured command, a
      // tmux session, etc). To keep this regression test focused on the
      // *runner skeleton* — "the pipeline can iterate every step end-to-
      // end and aggregate results" — we monkey-patch every dispatch
      // entry to the canonical no-op result for this test only. The
      // real-handler behavior is covered by per-handler describes below.
      const realKinds = ['lint', 'test', 'ai-content', 'priming-roll', 'critic-check'];
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
        assert.equal(result.results.length, 6, 'prawduct has six pipeline steps');
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
        ['version-bump', 'changelog-update', 'learnings-capture', 'next-session-prime', 'memory-update', 'commit']
      );
    });

    it('attaches `kind` to each result for the multi-step UI (Chunk 10)', async () => {
      const result = await wrapPipeline.runWrapPipeline('pipeline-test');
      const kinds = result.results.map((r) => r.kind);
      assert.deepStrictEqual(kinds,
        ['version-bump', 'ai-content', 'ai-content', 'priming-roll', 'ai-content', 'commit']);
    });

    it('runner is transactionally inert — every stub receives an empty staged scratch and no step writes to it', async () => {
      // Inertness pin (Chunk 3 Critic nit #1). Real handlers in
      // Chunks 4–9 will write to `context.staged`; the `commit` step
      // in Chunk 9 will flush. Until then `staged` must stay {} after
      // every step. We capture the live reference each stub sees and
      // assert the post-run state.
      const capturedStaged = [];
      const wrapKinds = ['pr-check', 'lint', 'test', 'critic-check', 'ai-content', 'priming-roll', 'version-bump', 'commit'];
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
        assert.equal(capturedStaged.length, 6, 'every prawduct step receives a context');
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
      const prawduct = JSON.parse(JSON.stringify(store.templates.get('prawduct')));
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
        // Restore bundled prawduct template
        delete aiStep.blocker;
        store.templates.save(prawduct);
      }
    });

    it('does NOT halt when blocker:false step returns ok:false', async () => {
      // The runner only acts on boolean blocker:true. Enum-style
      // blockers (e.g. "errors-only") are handled inside the handler;
      // a !ok with blocker:false is informational, pipeline continues.
      const original = wrapPipeline.STEP_DISPATCH['ai-content'];
      wrapPipeline.STEP_DISPATCH['ai-content'] = {
        run: async () => ({ ok: false, status: 'done', output: null, blockers: ['informational only'] })
      };

      try {
        const result = await wrapPipeline.runWrapPipeline('pipeline-test');
        assert.equal(result.ok, true,
          'pipeline should complete despite a non-blocking failing step');
        assert.equal(result.blockedAt, null);
      } finally {
        wrapPipeline.STEP_DISPATCH['ai-content'] = original;
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
      }
    });
  });
});

describe('wrap-pipeline step stubs (#139 Chunk 3)', () => {
  // Each remaining stub must return the canonical no-op result. Pinning
  // every stub individually so a future "let me just inline the
  // implementation halfway" change to one file fails this test instead
  // of silently changing pipeline semantics. `lint` and `test` left this
  // list in #139 Chunk 4; `ai-content` left in #139 Chunk 5 — their
  // real-handler tests live in their own describe blocks below.
  const kinds = ['pr-check', 'version-bump', 'commit'];

  for (const kind of kinds) {
    it(`${kind} returns the canonical {ok:true,status:'done',output:null,blockers:[]}`, async () => {
      const handler = require(`../lib/wrap-steps/${kind}`);
      const result = await handler.run({});
      assert.deepStrictEqual(result, { ok: true, status: 'done', output: null, blockers: [] });
    });
  }
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
    const prawduct = JSON.parse(JSON.stringify(store.templates.get('prawduct')));
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
      delete aiStep.blocker;
      store.templates.save(prawduct);
    }
  });

  it('does NOT halt for a non-blocker enum value', async () => {
    const original = wrapPipelineMod.STEP_DISPATCH['ai-content'];
    wrapPipelineMod.STEP_DISPATCH['ai-content'] = {
      run: async () => ({ ok: false, status: 'done', output: null, blockers: [] })
    };
    const prawduct = JSON.parse(JSON.stringify(store.templates.get('prawduct')));
    const aiStep = prawduct.wrap_pipeline.steps.find((s) => s.kind === 'ai-content');
    aiStep.blocker = 'not-a-recognized-enum';
    store.templates.save(prawduct);

    try {
      const result = await wrapPipelineMod.runWrapPipeline('errors-only-test');
      assert.equal(result.ok, true,
        'unrecognized blocker enums must NOT halt — only "true" and "errors-only" do');
      assert.equal(result.blockedAt, null);
    } finally {
      wrapPipelineMod.STEP_DISPATCH['ai-content'] = original;
      delete aiStep.blocker;
      store.templates.save(prawduct);
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

  it('blocks when step.prompt is empty', async () => {
    const result = await aiContent.run(buildContext({ id: 'memory-update' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /no prompt configured/);
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

  it('blocks when .claude/plans is empty', async () => {
    fs.mkdirSync(path.join(projectPath, '.claude', 'plans'), { recursive: true });
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /No \.md plans found/);
  });

  it('blocks with disambiguation message when multiple plans exist', async () => {
    writePlan('one.md', '### Chunk 1: A\n');
    writePlan('two.md', '### Chunk 1: A\n');
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /Multiple .md plans/);
    assert.match(result.blockers[0], /step\.planPath to disambiguate/);
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

  it('always returns ok:true status done — never blocks', async () => {
    // The blocker contract is `false` per ADR 0002; even on a
    // misconfigured project (missing path) the handler returns
    // ok:true with status skipped, so the pipeline never halts here.
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
