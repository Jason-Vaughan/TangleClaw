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
});
