'use strict';

/*
 * UI-7H4K — the wrap-drawer decision selects (pr-check, plan-picker) must have
 * their labels programmatically associated with their controls, so a screen
 * reader announces an accessible name for each <select>.
 *
 * session.js render functions are browser DOM code (not require()-able), so —
 * per the test/session-wrapper.test.js convention — this pins the association
 * at the source level: a revert to a standalone label with no for/id (or a
 * select with no accessible name) fails here.
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
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  assert.fail(`${decl} body must close`);
}

describe('UI-7H4K wrap-drawer decision selects are labelled for a11y', () => {
  let session;

  before(() => {
    const root = path.resolve(__dirname, '..');
    session = fs.readFileSync(path.join(root, 'public/session.js'), 'utf8');
  });

  it('plan-picker ties its single label to its select via for/id', () => {
    const body = functionBody(session, 'function renderPlanPickerWidget(');
    // The label's `for` and the select's `id` must reference the same token.
    assert.ok(/label\.htmlFor\s*=\s*selId/.test(body),
      'plan-picker label must set htmlFor to the select id');
    assert.ok(/sel\.id\s*=\s*selId/.test(body),
      'plan-picker select must carry the matching id');
  });

  it('pr-check marks the resolution list a labelled group', () => {
    const body = functionBody(session, 'function renderPrResolutionWidget(');
    assert.ok(/list\.setAttribute\('role',\s*'group'\)/.test(body),
      'pr-check select list must be a role="group"');
    assert.ok(/list\.setAttribute\('aria-labelledby',\s*groupLabelId\)/.test(body),
      'pr-check group must be labelled by the caption id');
    assert.ok(/label\.id\s*=\s*groupLabelId/.test(body),
      'pr-check caption must carry the group-label id');
  });

  it('pr-check names each resolution select by its PR title', () => {
    const body = functionBody(session, 'function renderPrResolutionWidget(');
    assert.ok(/titleEl\.id\s*=\s*`wrapPrTitle-\$\{pr\.number\}`/.test(body),
      'each PR title must carry a stable id');
    assert.ok(/sel\.setAttribute\('aria-labelledby',\s*titleEl\.id\)/.test(body),
      'each pr-check select must be aria-labelledby its PR title');
  });
});
