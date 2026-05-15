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
      const realKinds = ['lint', 'test', 'ai-content'];
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
  const kinds = ['pr-check', 'critic-check', 'priming-roll', 'version-bump', 'commit'];

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
