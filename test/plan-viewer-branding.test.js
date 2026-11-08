'use strict';

/*
 * #2928 — Plan Viewer branding: every page `lib/plan-docs.js` renders (a plan
 * page and its refusal/message pages alike) carries the subtle background
 * watermark, the brand kicker pill, and the branded footer link, because all
 * three are emitted once by the shared `_document()` wrapper rather than by
 * each page kind separately.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const planDocs = require('../lib/plan-docs');

const PLAN_PAGE = planDocs.renderPlanPage({
  project: { id: 1, name: 'demo-project' },
  file: 'train.md',
  relative: '.tangleclaw/plans/train.md',
  modifiedAt: '2026-01-15T08:05:09.000Z',
  markdown: '# Train 12\n\nBody text.\n'
});

const MESSAGE_PAGE = planDocs.renderMessagePage({
  title: 'Plan not found',
  message: 'No plan named that exists.'
});

describe('plan viewer branding (#2928)', () => {
  for (const [label, html] of [['a rendered plan page', PLAN_PAGE], ['a message/refusal page', MESSAGE_PAGE]]) {
    describe(label, () => {
      it('carries a non-interactive background watermark', () => {
        assert.match(html, /<div class="tc-bg-watermark" aria-hidden="true"><img src="data:image\/png;base64,[^"]+" alt=""><\/div>/);
        assert.match(html, /\.tc-bg-watermark\{[^}]*pointer-events:none/);
      });

      it('is print-safe: the watermark dims further under @media print', () => {
        assert.match(html, /@media print\{\.tc-bg-watermark img\{opacity:\.05\}\}/);
      });

      it('carries the brand kicker pill above the page content', () => {
        assert.match(html, /<p class="brand-kicker"><img[^>]*alt="">Orchestrated by TangleClaw · Autonomous Multi-Agent Engineering Fleet<\/p>/);
      });

      it('carries the branded footer link', () => {
        assert.match(html, /<footer class="tc-footer"><a href="https:\/\/tangleclaw\.com" target="_blank" rel="noopener">TangleClaw\.com<\/a> — Many Agents\. One Claw\.<\/footer>/);
      });

      it('never lets the watermark intercept clicks (page content stays interactive)', () => {
        assert.match(html, /main\.plan\{position:relative;z-index:1/);
        assert.match(html, /\.tc-bg-watermark\{position:fixed;[^}]*z-index:0;pointer-events:none/);
      });

      it('introduces no script and keeps the existing escape-first contract', () => {
        assert.doesNotMatch(html, /<script/);
      });
    });
  }

  it('does not change the plan page body or title content around the new branding', () => {
    assert.match(PLAN_PAGE, /<h1 id="train-12">Train 12<\/h1>/);
    assert.match(PLAN_PAGE, /<title>Train 12 · demo-project · TangleClaw<\/title>/);
  });
});
