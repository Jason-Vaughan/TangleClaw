'use strict';

/*
 * #696 — the blocked-step "Skip & note" affordance's action button.
 *
 * When a wrap step blocks and offers a "skip this step" checkbox, ticking it and
 * clicking the action button skips-and-continues (retryWrap threads the skip
 * through and re-runs the pipeline past the step). The button, however, is a
 * static "Retry", so the operator has no signal the action will proceed rather
 * than re-attempt. This pins the honest relabel.
 *
 * session.js render functions are browser DOM code (not require()-able), so —
 * per the test/wrap-rule-proposal-widget.test.js convention — these are
 * source-level pins over the function bodies.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 * @param {string} src full source text
 * @param {string} decl the function declaration to find
 * @returns {string} the function body including its braces
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${decl}`);
}

describe('wrap drawer — Skip & continue relabel (#696)', () => {
  let src;
  before(() => {
    src = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
  });

  it('defines syncRetryLabel that flips the action button on the skip-box state', () => {
    const body = functionBody(src, 'function syncRetryLabel(');
    // Reads the action button and the decision area.
    assert.match(body, /wrapDrawerRetryBtn/);
    assert.match(body, /wrapDrawerDecision/);
    // Keys on the two "skip this step" checkboxes.
    assert.match(body, /data-options-key="skipAiContent"\]:checked/);
    assert.match(body, /data-options-key="skipTests"\]:checked/);
    // The honest label swap: "Skip & continue" when a skip box is ticked, else "Retry".
    assert.match(body, /'Skip & continue'/);
    assert.match(body, /'Retry'/);
    // Defensive: bails when the button isn't present.
    assert.match(body, /if \(!retryBtn\) return/);
  });

  it('wires the skip checkbox to relabel on change', () => {
    const body = functionBody(src, 'function renderDecisionWidget(');
    assert.match(body, /addEventListener\('change', syncRetryLabel\)/,
      'toggling the skip box must relabel the action button live');
  });

  it('re-syncs the label on every drawer render (so a fresh drawer resets to Retry)', () => {
    const body = functionBody(src, 'function renderWrapDrawer(');
    assert.match(body, /syncRetryLabel\(\)/,
      'renderWrapDrawer must call syncRetryLabel so a re-render with unticked boxes reads "Retry"');
  });

  it('leaves the static HTML default as "Retry" (the unticked state)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');
    assert.match(html, /id="wrapDrawerRetryBtn"[^>]*>Retry</,
      'the button ships reading "Retry"; syncRetryLabel promotes it to "Skip & continue" when a skip box is ticked');
  });
});
