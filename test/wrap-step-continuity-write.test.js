'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const step = require('../lib/wrap-steps/continuity-write');
const continuity = require('../lib/continuity');

describe('continuity-write wrap step (CC-1)', () => {
  let tmpDir;
  let project;
  let origExec;
  let origToday;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cwstep-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const projPath = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    project = { id: 1, name: 'demo', path: projPath };
    origExec = step._internal.exec;
    origToday = step._internal.today;
    step._internal.today = () => '2026-06-15';
    // Default git stub: HEAD sha + branch.
    step._internal.exec = async (file, args) => {
      if (args.includes('--short')) return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
      if (args.includes('--abbrev-ref')) return { exitCode: 0, stdout: 'feat/cc-1\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    };
  });

  afterEach(() => {
    step._internal.exec = origExec;
    step._internal.today = origToday;
  });

  function ctx(previousResults) {
    return { project, previousResults: previousResults || [], step: {}, staged: {}, options: {} };
  }

  it('writes the index from a prior memory-update capture + git facts', async () => {
    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: {
        summary: 'Shipped the spine.',
        nextSteps: '- build CC-2\n- wire grep',
        learnings: 'none'
      } } }
    ]));

    assert.equal(res.ok, true);
    assert.equal(res.status, 'done');
    assert.equal(res.output.written, true);
    assert.equal(res.output.hadCapture, true);

    const idx = continuity.readIndex(project.path);
    assert.equal(idx.currentState, 'Shipped the spine.');
    assert.equal(idx.nextAction, '- build CC-2\n- wire grep');
    assert.equal(idx.freshness.sha, 'abc1234');
    assert.equal(idx.freshness.branch, 'feat/cc-1');
    assert.equal(idx.freshness.writtenAt, '2026-06-15');
  });

  it('picks the most recent capture when several steps carry parsedFields', async () => {
    const res = await step.run(ctx([
      { stepId: 'changelog-update', status: 'done', output: { parsedFields: { summary: 'old' } } },
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 'new', nextSteps: 'go' } } }
    ]));
    assert.equal(res.output.hadCapture, true);
    assert.equal(continuity.readIndex(project.path).currentState, 'new');
  });

  it('degrades honestly when no AI capture is present (mechanical floor)', async () => {
    const res = await step.run(ctx([
      { stepId: 'commit', status: 'done', output: { commitSha: 'abc1234' } }
    ]));
    assert.equal(res.ok, true, 'never blocks the wrap');
    assert.equal(res.output.written, true);
    assert.equal(res.output.hadCapture, false);
    // No judgment content → readIndex treats it as nothing to resume from,
    // but the file still exists on disk with the freshness stamp.
    assert.equal(continuity.readIndex(project.path), null);
    const raw = fs.readFileSync(continuity.indexPath(project.path), 'utf8');
    assert.match(raw, /## Next action\n_⚠ not captured/);
    assert.match(raw, /- sha: abc1234/);
  });

  it('still writes a stamp-less index when git facts are unavailable', async () => {
    step._internal.exec = async () => { throw new Error('not a git repo'); };
    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    assert.equal(res.ok, true);
    const idx = continuity.readIndex(project.path);
    assert.equal(idx.nextAction, 'n');
    assert.equal(idx.freshness.sha, '');
  });

  it('never halts the wrap when the index write itself fails', async () => {
    // Point the project at a path whose store dir cannot be created
    // (a file sits where the .tangleclaw dir would go).
    const badProj = fs.mkdtempSync(path.join(tmpDir, 'bad-'));
    fs.writeFileSync(path.join(badProj, '.tangleclaw'), 'i am a file, not a dir');
    project = { id: 2, name: 'bad', path: badProj };

    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    assert.equal(res.ok, true, 'continuity failure must not block a wrap');
    assert.equal(res.output.written, false);
    assert.ok(res.output.error);
  });

  it('_resolveCapturedFields ignores results without parsedFields', () => {
    const out = step._resolveCapturedFields([
      { stepId: 'lint', status: 'done', output: null },
      { stepId: 'test', status: 'done', output: { capturedText: 'x' } }
    ]);
    assert.equal(out.currentState, '');
    assert.equal(out.nextAction, '');
  });

  // ── CC-2 warm tier: changelog + wrap summary written alongside the index ──

  function ctxWithSession(session, previousResults) {
    return { project, session, previousResults: previousResults || [], step: {}, staged: {}, options: {} };
  }

  it('appends a changelog entry + writes the wrap summary when a session is present', async () => {
    const res = await step.run(ctxWithSession(
      { id: 42, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: {
        summary: 'Built CC-2 warm tier.',
        nextSteps: '- run critic',
        learnings: 'branch hygiene matters'
      } } }]
    ));
    assert.equal(res.ok, true);
    assert.equal(res.output.changelogAppended, true);
    assert.equal(res.output.wrapSummaryWritten, true);

    const changelog = fs.readFileSync(continuity.changelogPath(project.path), 'utf8');
    assert.match(changelog, /\(session:42\) Built CC-2 warm tier\./);

    const summary = continuity.readWrapSummary(project.path, 42);
    assert.equal(summary.meta.session, '42');
    assert.equal(summary.meta.harness, 'claude');
    assert.equal(summary.sections['Where we are'], 'Built CC-2 warm tier.');
    assert.equal(summary.sections['Next action'], '- run critic');
    assert.equal(summary.sections['Landmines'], 'branch hygiene matters');
    assert.equal(summary.sections['Delta'], '', 'uncaptured section honest-flagged → empty on read');

    const rawSummary = fs.readFileSync(continuity.wrapSummaryPath(project.path, 42), 'utf8');
    assert.match(rawSummary, /- sha: abc1234/);
    assert.match(rawSummary, /## Delta\n_⚠ not captured_/);
  });

  it('search finds the just-written entry by its session pointer', async () => {
    await step.run(ctxWithSession(
      { id: 7, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 'Fixed PTY exhaustion', nextSteps: 'n' } } }]
    ));
    const hits = continuity.search(project.path, 'PTY exhaustion');
    assert.ok(hits.length > 0);
    assert.ok(hits.some((h) => h.sid === '7'));
  });

  it('skips the warm tier (no sid) but still writes the index when session is absent', async () => {
    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    assert.equal(res.output.written, true, 'index still written');
    assert.equal(res.output.changelogAppended, false);
    assert.equal(res.output.wrapSummaryWritten, false);
    assert.ok(!fs.existsSync(continuity.changelogPath(project.path)), 'no changelog without a session');
  });

  it('warm-tier failure never halts the wrap (non-blocking note)', async () => {
    // Plant a file where the wraps/ dir would go so writeWrapSummary fails,
    // AFTER the index write has already succeeded.
    const projPath = fs.mkdtempSync(path.join(tmpDir, 'warmfail-'));
    project = { id: 3, name: 'wf', path: projPath };
    fs.mkdirSync(continuity.storeDir(projPath), { recursive: true });
    fs.writeFileSync(continuity.wrapsDir(projPath), 'i am a file, not a dir');

    const res = await step.run(ctxWithSession(
      { id: 9, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }]
    ));
    assert.equal(res.ok, true, 'warm-tier failure must not block a wrap');
    assert.equal(res.output.written, true, 'index still written');
    assert.equal(res.output.wrapSummaryWritten, false);
  });

  // ── CC-3: the Map is self-maintained at wrap (stub touched, prune deleted) ──

  // A git stub that resolves `main` as base and returns a --name-status diff.
  function gitStubWithDiff(nameStatus) {
    return async (file, args) => {
      if (args.includes('--short')) return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
      if (args.includes('--abbrev-ref')) return { exitCode: 0, stdout: 'feat/cc-3\n', stderr: '' };
      // base resolution: `git rev-parse --verify --quiet main`
      if (args.includes('rev-parse') && args.includes('main')) return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args.includes('rev-parse')) return { exitCode: 1, stdout: '', stderr: '' };
      if (args.includes('--name-status')) return { exitCode: 0, stdout: nameStatus, stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    };
  }

  it('stubs a touched source file into the index Map', async () => {
    step._internal.exec = gitStubWithDiff('M\tlib/widget.js\nA\tlib/new.js\n');
    await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    const parsed = continuity.parseIndex(fs.readFileSync(continuity.indexPath(project.path), 'utf8'));
    assert.match(parsed.map, /- \*\*TBD\*\* — `lib\/widget\.js`/);
    assert.match(parsed.map, /- \*\*TBD\*\* — `lib\/new\.js`/);
  });

  it('prunes a deleted file and preserves a prior curated entry across the rewrite', async () => {
    // First wrap with a curated Map already on disk, plus a file that will be deleted.
    continuity.writeIndex(project.path, {
      currentState: 'prior', nextAction: 'prior',
      map: '- **Widget** — the widget. `lib/widget.js`\n- **TBD** — `lib/doomed.js` <!-- describe -->',
      freshness: { sha: 'old', branch: 'main', writtenAt: '2026-06-16' }
    });
    step._internal.exec = gitStubWithDiff('D\tlib/doomed.js\n');
    await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's2', nextSteps: 'n2' } } }
    ]));
    const parsed = continuity.parseIndex(fs.readFileSync(continuity.indexPath(project.path), 'utf8'));
    assert.match(parsed.map, /Widget/, 'curated entry survives the index rewrite');
    assert.doesNotMatch(parsed.map, /doomed\.js/, 'deleted file pruned from the Map');
    // The rest of the index was regenerated from this wrap's capture.
    assert.equal(parsed.currentState, 's2');
  });

  it('leaves the Map empty when no base branch resolves (best-effort, non-blocking)', async () => {
    // Default beforeEach stub: rev-parse main/master fall through to exitCode 1.
    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    assert.equal(res.ok, true);
    const parsed = continuity.parseIndex(fs.readFileSync(continuity.indexPath(project.path), 'utf8'));
    assert.equal(parsed.map, '', 'no base → no delta → empty Map, wrap unaffected');
  });

  it('ignores non-indexable touched paths (allowlist reuse)', async () => {
    step._internal.exec = gitStubWithDiff('A\tnode_modules/pkg/index.js\nM\tdist/bundle.js\nM\tlib/real.js\n');
    await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    const parsed = continuity.parseIndex(fs.readFileSync(continuity.indexPath(project.path), 'utf8'));
    assert.match(parsed.map, /lib\/real\.js/);
    assert.doesNotMatch(parsed.map, /node_modules|dist/);
  });

  it('_mapDelta classifies A/M/D/R via --name-status', async () => {
    step._internal.exec = gitStubWithDiff('A\tlib/added.js\nM\tlib/mod.js\nD\tlib/del.js\nR100\tlib/old.js\tlib/renamed.js\n');
    const delta = await step._mapDelta(project.path);
    assert.deepEqual(delta.touched.sort(), ['lib/added.js', 'lib/mod.js', 'lib/renamed.js'].sort());
    assert.deepEqual(delta.deleted.sort(), ['lib/del.js', 'lib/old.js'].sort());
  });
});
