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
