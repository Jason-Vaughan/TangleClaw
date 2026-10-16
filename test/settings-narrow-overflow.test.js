'use strict';

/*
 * #2361 — Project Settings scrolled sideways on a phone. The toggles grid's
 * track minimum was a bare `290px`, and a grid track never shrinks below its
 * minimum, so where the modal body was narrower than that the one column stuck
 * out of it (the Silent prime cell, at a 320 px viewport).
 *
 * Source-level CSS assertions, in the house pattern of
 * test/settings-hint-wrapping.test.js. Each is SCOPED to its own rule block:
 * an unanchored search would pass with the fix on a different selector.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** The three grids inside the settings modal, with the floor each keeps. */
const GRIDS = [
  { selector: '.settings-toggles-grid', floor: 290 },
  { selector: '.wrap-section-grid', floor: 165 },
  { selector: '.project-rules-grid', floor: 230 }
];

/**
 * The bare rule block for `selector` (not a descendant rule such as
 * `.settings-toggles-grid .form-group`).
 * @param {string} css - The stylesheet
 * @param {string} selector - A class selector
 * @returns {string|null}
 */
function ruleBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`^${escaped}\\s*\\{[^}]*\\}`, 'm'));
  return m ? m[0] : null;
}

describe('settings modal grids fit a narrow screen (#2361)', () => {
  let css;

  before(() => {
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  });

  for (const { selector, floor } of GRIDS) {
    it(`${selector} caps its track minimum at the container's width`, () => {
      const block = ruleBlock(css, selector);
      assert.ok(block, `the ${selector} rule must exist`);
      const pattern = new RegExp(`grid-template-columns:\\s*repeat\\(auto-fit,\\s*minmax\\(min\\(${floor}px,\\s*100%\\),\\s*1fr\\)\\)`);
      assert.match(block, pattern);
    });

    it(`${selector} has no bare pixel track minimum left`, () => {
      const block = ruleBlock(css, selector);
      assert.ok(block, `the ${selector} rule must exist`);
      assert.doesNotMatch(block, /minmax\(\s*\d+(\.\d+)?px\s*,/);
    });
  }
});
