'use strict';

// #843 / #1405 — `learnings-capture` blocked a wrap whose learnings entry had
// already landed: written while the session prepared to wrap, or finished by the
// AI after a blocked attempt and then Retried. The gate only asked "did the file
// change during this step?", so the one way through was writing more, which the
// step's own prompt forbids. The `learnings-entry` predicate asks whether the
// file already carries this session's entry.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const coverage = require('../lib/wrap-steps/learnings-coverage');
const aic = require('../lib/wrap-steps/ai-content');
const defaultPipeline = require('../lib/wrap-default-pipeline');
const { isoLocalDate } = require('../lib/wrap-steps/_date');

const REL = '.tangleclaw/memories/learnings.md';
const HOUR = 60 * 60 * 1000;

/**
 * Write the learnings file under a temp project and set its modification time.
 * @param {string} root - Temp project root
 * @param {string} content - File content
 * @param {number} mtimeMs - Modification time to stamp
 * @returns {void}
 */
function writeLearnings(root, content, mtimeMs) {
  const abs = path.join(root, REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  fs.utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000);
}

describe('learnings-coverage.evaluate', () => {
  let root;
  const now = Date.now();
  const today = isoLocalDate(now);
  // An hour ago, unless that crosses local midnight; then a minute ago.
  const startedAtMs = isoLocalDate(now - HOUR) === today ? now - HOUR : now - 60 * 1000;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-learnings-cov-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('covered: a dated entry written during the session (before the wrap started)', () => {
    writeLearnings(root, `# Learnings\n\n## ${today} — the gate asked the wrong question\nBody.\n`, startedAtMs + 1000);
    const r = coverage.evaluate(root, [REL], { startedAtMs });
    assert.equal(r.verdict, 'covered');
    assert.equal(r.entryDate, today);
  });

  it('covered: the honest no-op line', () => {
    writeLearnings(root, `# Learnings\n\n- ${today}: no novel learnings (routine work).\n`, startedAtMs + 1000);
    assert.equal(coverage.evaluate(root, [REL], { startedAtMs }).verdict, 'covered');
  });

  it('uncovered: a file nobody wrote since the session started, even with a same-day entry', () => {
    // A previous session earlier today wrote this entry; this session never touched the file.
    writeLearnings(root, `## ${today} — a previous session's entry\nBody.\n`, startedAtMs - 1000);
    const r = coverage.evaluate(root, [REL], { startedAtMs });
    assert.equal(r.verdict, 'uncovered');
    assert.match(r.reason, /has not been written since this session started/);
  });

  it('uncovered: written this session but carrying no entry dated within it', () => {
    writeLearnings(root, '## 2020-01-01 — an old entry\nBody.\n', startedAtMs + 1000);
    const r = coverage.evaluate(root, [REL], { startedAtMs });
    assert.equal(r.verdict, 'uncovered');
    assert.match(r.reason, /carries no entry dated/);
  });

  it('uncovered: the file does not exist', () => {
    const r = coverage.evaluate(root, [REL], { startedAtMs });
    assert.equal(r.verdict, 'uncovered');
    assert.match(r.reason, /could not be read/);
  });

  it('credits a session that started yesterday and wraps today', () => {
    const t = new Date(2026, 8, 14, 0, 30).getTime();
    const started = new Date(2026, 8, 13, 23, 0).getTime();
    const deps = {
      now: () => t,
      stat: () => ({ mtimeMs: t }),
      read: () => '## 2026-09-13 — written before midnight\nBody.\n'
    };
    assert.equal(coverage.evaluate('/p', [REL], { startedAtMs: started }, deps).verdict, 'covered');
    deps.read = () => '## 2026-09-12 — the day before the session\nBody.\n';
    assert.equal(coverage.evaluate('/p', [REL], { startedAtMs: started }, deps).verdict, 'uncovered');
  });

  it('unavailable: the session start time is unknown (a row from before launch baselines)', () => {
    writeLearnings(root, `## ${today} — entry\n`, now);
    assert.equal(coverage.evaluate(root, [REL], { startedAtMs: null }).verdict, 'unavailable');
    assert.equal(coverage.evaluate(root, [REL], null).verdict, 'unavailable');
  });

  it('entryDates reads headings and the no-op line, and nothing else', () => {
    assert.deepEqual(coverage.entryDates([
      '# Cross-Session Learnings',
      '## 2026-09-01 — a',
      'text mentioning 2026-09-02 inline',
      '- 2026-09-03: no novel learnings (routine work).',
      '- 2026-09-04: something else',
      '### 2026-09-05 — a sub-heading'
    ].join('\n')), ['2026-09-01', '2026-09-03']);
  });
});

describe('learnings-capture gate — an entry already on disk', () => {
  let root;
  let saved;
  const now = Date.now();
  const today = isoLocalDate(now);
  const startedAtMs = isoLocalDate(now - HOUR) === today ? now - HOUR : now - 60 * 1000;
  const spec = () => defaultPipeline.steps().find((s) => s.id === 'learnings-capture');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-learnings-gate-'));
    saved = { ...aic._internal };
    aic._internal.listWrapRules = () => [];
    aic._internal.sendKeys = () => {};
    aic._internal.sleep = async () => {};
    aic._internal.newNonce = () => 'n0nce';
    aic._internal.readPaneTail = () => 'TCWRAP-DONE n0nce';
    aic._internal.capturePane = () => ({ lines: ['## Result', 'The entry for this session is already captured.'] });
  });
  afterEach(() => {
    Object.assign(aic._internal, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (step, scope) => aic.run({
    project: { name: 'proj', path: root },
    session: { tmuxSession: 'sess' },
    step, previousResults: [], staged: {}, options: {}, scope
  });

  it('passes on the first attempt when the session wrote its entry while preparing the wrap', async () => {
    // GURULifeline's scenario on #843: the entry landed before the wrap started,
    // and the AI correctly declined to duplicate it.
    writeLearnings(root, `# Learnings\n\n## ${today} — captured during preparation\nBody.\n`, startedAtMs + 1000);
    const res = await run(spec(), { startedAtMs });
    assert.equal(res.status, 'done', JSON.stringify(res.blockers));
  });

  it('a Retry passes on an entry written after the blocked attempt', async () => {
    writeLearnings(root, '# Learnings\n', startedAtMs - HOUR);
    const first = await run(spec(), { startedAtMs });
    assert.equal(first.status, 'blocked');
    assert.match(first.blockers[0], /carries no entry from this session/);
    assert.match(first.output.remediation, /Retry clears once it is on disk/);

    // The AI finishes the entry after the step gave up; the operator presses Retry.
    writeLearnings(root, `# Learnings\n\n## ${today} — finished after the block\nBody.\n`, Date.now());
    const retry = await run(spec(), { startedAtMs });
    assert.equal(retry.status, 'done', JSON.stringify(retry.blockers));
  });

  it('still blocks a file untouched since the session started', async () => {
    writeLearnings(root, `## ${today} — a previous session's entry\nBody.\n`, startedAtMs - 1000);
    const res = await run(spec(), { startedAtMs });
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /has not been written since this session started/);
  });

  it('falls back to the mutation gate when the session start is unknown', async () => {
    writeLearnings(root, `## ${today} — entry\nBody.\n`, now);
    const res = await run(spec(), { startedAtMs: null });
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /byte-identical to before the AI ran/);
  });

  it('guard: without the predicate declaration, the landed entry blocks again', async () => {
    // Proves the pass above comes from `verifySatisfiedBy`, so removing it from
    // the pipeline spec turns that test red rather than leaving it vacuous.
    writeLearnings(root, `# Learnings\n\n## ${today} — captured during preparation\nBody.\n`, startedAtMs + 1000);
    const bare = { ...spec() };
    delete bare.verifySatisfiedBy;
    const res = await run(bare, { startedAtMs });
    assert.equal(res.status, 'blocked');
    assert.equal(spec().verifySatisfiedBy, 'learnings-entry');
  });
});
