'use strict';

/*
 * #1271 — hint text in the settings modal was clipped at the right edge rather
 * than wrapping. Source-level CSS assertions, matching the house pattern for
 * frontend regressions (see test/project-rules-modal.test.js).
 *
 * These are deliberately SCOPED to the `.form-hint` block. An unanchored search
 * for the property anywhere in a 3000-line stylesheet passes with the rule on a
 * completely different selector, which is a test that cannot tell the fixed case
 * from the broken one.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('settings hint wrapping (#1271)', () => {
  let css;

  before(() => {
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  });

  it('declares overflow-wrap INSIDE the .form-hint block, not merely somewhere in the file', () => {
    // `^` pins the bare `.form-hint` rule rather than a descendant selector —
    // `.master-access-option .form-hint` and `.history-scope .form-hint` also
    // exist, and neither is where the hint text is styled. `[^}]*` cannot cross
    // the closing brace, so the property has to be in THIS block.
    assert.match(css, /^\.form-hint\s*\{[^}]*overflow-wrap:\s*anywhere\s*;/m);
  });

  it('uses `anywhere` rather than `break-word`, which would not fix the reported state', () => {
    // Not style preference. Only `anywhere` reduces the min-content width, so
    // the `minmax(290px, 1fr)` track can narrow to fit an unbreakable token.
    // `break-word` leaves the track resolving against the unbroken token, so the
    // tight two-column state the bug is reported in would still overflow.
    const block = css.match(/^\.form-hint\s*\{[^}]*\}/m);
    assert.ok(block, 'the .form-hint rule must exist');
    assert.doesNotMatch(block[0], /overflow-wrap:\s*break-word/);
  });

  it('the geometry that makes the wrap necessary is still what #1271 measured', () => {
    // If the grid or the modal ceiling changes, the reasoning in the CSS comment
    // stops describing the code. This fails loudly instead of leaving a stale
    // rationale next to a rule nobody can re-derive.
    // All three participate: track floor, inter-column gap, and the modal
    // ceiling they have to fit inside. Pinning only two lets a change to the
    // third silently invalidate the rationale beside the rule.
    const grid = css.match(/\.settings-toggles-grid\s*\{[^}]*\}/);
    assert.ok(grid, 'the toggles grid rule must exist');
    assert.match(grid[0], /minmax\(290px,\s*1fr\)/);
    assert.match(grid[0], /gap:\s*0\s+22px/);
    assert.match(css, /\.modal-content\.settings-modal\s*\{[^}]*max-width:\s*680px/);
  });
});
