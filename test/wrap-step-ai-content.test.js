'use strict';

// Regression tests for #287 — the `memory-update` wrap step blocked every
// wrap because `_parseFields` looked for literal `## Heading` lines in the
// tmux pane capture, but `capture-pane -p` returns TUI-RENDERED text with
// the `##` stripped, so headings never matched. The fix: a step may declare
// `captureFile`; the AI writes the structured block to that project-relative
// file (raw markdown, `##` preserved) and the handler parses the file instead
// of the pane. Steps without `captureFile` keep the original pane behavior.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const aic = require('../lib/wrap-steps/ai-content');

// What the AI writes to its captureFile — raw markdown, hashes intact.
const RAW_BLOCK = [
  '## Summary',
  'Tidy wrap cycle; no code changes.',
  '',
  '## NextSteps',
  '- Issue #85 highest priority',
  '',
  '## Learnings',
  '- none'
].join('\n');

// What `capture-pane -p` returns for the SAME response — the TUI rendered
// the `##` headings as styled text, so the literal hashes are gone. This is
// the exact condition that made #287 block every wrap.
const RENDERED_PANE = [
  'Summary',
  'Tidy wrap cycle; no code changes.',
  '',
  'NextSteps',
  '- Issue #85 highest priority',
  '',
  'Learnings',
  '- none'
].join('\n');

describe('wrap-step ai-content — #287 captureFile parsing', () => {
  describe('_parseFields', () => {
    it('parses raw markdown `## ` headings into fields', () => {
      const out = aic._parseFields(RAW_BLOCK, ['summary', 'nextSteps', 'learnings']);
      assert.equal(out.summary, 'Tidy wrap cycle; no code changes.');
      assert.ok(out.nextSteps.includes('Issue #85'));
      assert.equal(out.learnings, '- none');
    });

    it('CANNOT parse TUI-rendered headings (no literal `##`) — documents the #287 failure mode', () => {
      const out = aic._parseFields(RENDERED_PANE, ['summary', 'nextSteps', 'learnings']);
      assert.equal(out.summary, undefined);
      assert.equal(out.nextSteps, undefined);
      assert.equal(out.learnings, undefined);
    });
  });

  describe('run() with captureFile', () => {
    let saved;

    beforeEach(() => {
      saved = { ...aic._internal };
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true, lastOutputAge: 20000 });
      // Pane returns RENDERED text (no `##`) — i.e. the bug condition is live.
      aic._internal.capturePane = () => ({ lines: RENDERED_PANE.split('\n') });
    });

    afterEach(() => { Object.assign(aic._internal, saved); });

    const baseCtx = () => ({
      project: { name: 'proj', path: '/tmp/proj' },
      session: { tmuxSession: 'sess' },
      step: {
        id: 'memory-update',
        kind: 'ai-content',
        prompt: 'write the block',
        captureFields: ['summary', 'nextSteps', 'learnings'],
        captureFile: '.tangleclaw/.wrap-summary.md'
      },
      previousResults: [],
      staged: {}
    });

    it('parses fields from the captureFile even though the pane has no `##` (the fix)', async () => {
      let removed = null;
      aic._internal.readCaptureFile = (projectPath, rel) => {
        assert.equal(projectPath, '/tmp/proj');
        assert.equal(rel, '.tangleclaw/.wrap-summary.md');
        return RAW_BLOCK;
      };
      aic._internal.removeCaptureFile = (_projectPath, rel) => { removed = rel; };

      const ctx = baseCtx();
      const res = await aic.run(ctx);

      assert.equal(res.ok, true);
      assert.equal(res.status, 'done');
      assert.equal(res.output.parsedFields.summary, 'Tidy wrap cycle; no code changes.');
      assert.equal(res.output.parsedFields.learnings, '- none');
      assert.equal(ctx.staged['memory-update'].parsedFields.summary, 'Tidy wrap cycle; no code changes.');
      assert.equal(removed, '.tangleclaw/.wrap-summary.md', 'consume-once: file removed after a successful read');
    });

    it('blocks with a clear message when the captureFile is missing', async () => {
      aic._internal.readCaptureFile = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
      let removeCalled = false;
      aic._internal.removeCaptureFile = () => { removeCalled = true; };

      const res = await aic.run(baseCtx());

      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.match(res.blockers[0], /captureFile ".tangleclaw\/\.wrap-summary\.md" missing or unreadable/);
      assert.equal(removeCalled, false, 'do not attempt removal when the read itself failed');
    });

    it('backward-compat: captureFields WITHOUT captureFile still parses the pane', async () => {
      // An engine that emits raw markdown into the pane (hashes intact).
      aic._internal.capturePane = () => ({ lines: RAW_BLOCK.split('\n') });
      let readCalled = false;
      aic._internal.readCaptureFile = () => { readCalled = true; return ''; };

      const ctx = baseCtx();
      delete ctx.step.captureFile;
      const res = await aic.run(ctx);

      assert.equal(res.ok, true);
      assert.equal(res.output.parsedFields.summary, 'Tidy wrap cycle; no code changes.');
      assert.equal(readCalled, false, 'no captureFile → never reads a file, parses the pane as before');
    });
  });
});

// #328 — content ai-content steps (changelog-update / learnings-capture /
// memory-update) became blockers; the handler gained a per-step Skip & note
// override, and the timeout message stopped hardcoding "wrap pipeline blocked".
describe('wrap-step ai-content — #328 blocker override + timeout message', () => {
  let saved;
  beforeEach(() => { saved = { ...aic._internal }; });
  afterEach(() => { Object.assign(aic._internal, saved); });

  const ctxWith = (overrides = {}) => ({
    project: { name: 'proj', path: '/tmp/proj' },
    session: { tmuxSession: 'sess' },
    step: { id: 'memory-update', kind: 'ai-content', prompt: 'write the block', allowOverride: true },
    previousResults: [],
    staged: {},
    options: {},
    ...overrides
  });

  describe('Skip & note override', () => {
    it('skips (ok:true) and stages an audit marker when allowOverride + skipAiContent[id]', async () => {
      // No tmux interaction should happen on the override path.
      let sent = false;
      aic._internal.sendKeys = () => { sent = true; };

      const ctx = ctxWith({ options: { skipAiContent: { 'memory-update': true } } });
      const res = await aic.run(ctx);

      assert.equal(res.ok, true);
      assert.equal(res.status, 'skipped');
      assert.equal(res.output.override, true);
      assert.equal(sent, false, 'override short-circuits before any tmux send');
      assert.deepEqual(ctx.staged['memory-update'], { aiContentSkipped: true, stepId: 'memory-update' });
    });

    it('does NOT skip when allowOverride is absent (override is opt-in per step)', async () => {
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true });
      aic._internal.capturePane = () => ({ lines: ['plenty of words here to clear the min-chars gate'] });

      const ctx = ctxWith({
        step: { id: 'memory-update', kind: 'ai-content', prompt: 'go' }, // no allowOverride
        options: { skipAiContent: { 'memory-update': true } }
      });
      const res = await aic.run(ctx);

      assert.equal(res.status, 'done', 'without allowOverride the skip option is ignored');
      assert.equal(ctx.staged['memory-update'] && ctx.staged['memory-update'].aiContentSkipped, undefined);
    });

    it('does NOT skip a different step than the one named in skipAiContent', async () => {
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true });
      aic._internal.capturePane = () => ({ lines: ['plenty of words here to clear the min-chars gate'] });

      const ctx = ctxWith({ options: { skipAiContent: { 'changelog-update': true } } });
      const res = await aic.run(ctx); // step is memory-update
      assert.equal(res.status, 'done', 'skip is scoped to the named step id');
    });
  });

  describe('timeout message', () => {
    it('names the step + "no idle", carries remediation, and never claims "wrap pipeline blocked"', async () => {
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: false }); // never idles
      // Fast-forward the clock: startedAt=0, first while-check=0 (enter),
      // second while-check past the cap (exit as timed-out).
      const ticks = [0, 0, 6 * 60 * 1000];
      let i = 0;
      aic._internal.now = () => ticks[Math.min(i++, ticks.length - 1)];

      const res = await aic.run(ctxWith());

      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.equal(res.blockers.length, 1);
      assert.doesNotMatch(res.blockers[0], /wrap pipeline blocked/, 'must not assert the pipeline blocked');
      assert.match(res.blockers[0], /memory-update/, 'names the step id');
      assert.match(res.blockers[0], /no idle detected/);
      assert.match(res.output.remediation, /Skip & note/);
    });
  });
});
