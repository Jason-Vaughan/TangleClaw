'use strict';

/*
 * #823 — every `.btn` is a 44px target, the floor `.form-input` already holds.
 *
 * The project is mobile-first and the operator is almost never at the machine.
 * `.btn` sat at 32px while the inputs beside it were 44px, so a modal's fields
 * were tappable and its Save button was not; the #710 CHANGELOG had to retract
 * "every control is a 44px target" because of it. This guard pins the floor in
 * both stylesheets (they do not `@import` each other), pins input/button
 * parity, and pins the exception list: a dense control may stay small only as
 * a NAMED class with a comment, never as a contextual `.x .btn` override —
 * those are the silent ones that let the gap survive.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const RAW = { 'style.css': pub('style.css'), 'session.css': pub('session.css'), 'shared-controls.css': pub('shared-controls.css') };
// Comments stripped for rule parsing: a value merely NAMED in prose must not
// read as declared. The raw text is kept for the "exception has a comment" check.
const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, stripCss(v)]));

const FLOOR = 44;

/**
 * Named classes allowed below the floor. The first sheet listed owns the base
 * rule (and must carry the explaining comment); any further sheet may only
 * hold page-specific `@media` overrides of that same class.
 */
const EXCEPTIONS = {
  // Card action rows: 32px on a fine pointer, lifted to 44px by the
  // `(pointer: coarse)` block — asserted below, not assumed.
  '.btn-compact': ['style.css'],
  // Session/Master control bar: a fixed bar above the terminal; height there
  // is terminal rows on a phone. Stays 30px on purpose; session.css keeps its
  // desktop (min-width: 900px) single-row sizing of the same class.
  '.banner-btn': ['shared-controls.css', 'session.css'],
  // Dashboard header pills: 24px on a fine pointer because seven of them share
  // the header bar, lifted to 44px by the `(pointer: coarse)` block —
  // asserted below, not assumed (#1215).
  '.dash-action': ['style.css']
};

/**
 * Every `{ selector, minHeight }` pair in a stylesheet whose selector names a
 * tappable control (`.btn`, `.btn-*`, `.banner-btn`, `.dash-action`) and
 * declares a `min-height`. The list is not "buttons": `.dash-action` is not a
 * `.btn` at all, which is precisely how the header pills kept a 24px target
 * through #823 (#1215). Media blocks are scanned too — a rule's block is reported so
 * the coarse-pointer override can be told apart from a base rule.
 *
 * @param {string} css - Comment-stripped stylesheet.
 * @returns {Array<{selector: string, minHeight: number, inMedia: string|null}>} Matches in source order.
 */
function buttonMinHeights(css) {
  const out = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  // Track the enclosing @media prelude by walking the text with a small stack.
  let m;
  while ((m = ruleRe.exec(css)) !== null) {
    const prelude = m[1].trim();
    const decls = m[2];
    if (prelude.startsWith('@')) continue; // the media prelude itself, handled via offset below
    const selector = prelude.split('\n').pop().trim();
    if (!/(^|[\s,>])\.(btn|banner-btn|dash-action)(\b|-)/.test(selector)) continue;
    const mh = /min-height:\s*(\d+)px/.exec(decls);
    if (!mh) continue;
    const before = css.slice(0, m.index);
    const opens = before.match(/@media[^{]*\{/g) || [];
    const lastOpen = opens.length ? before.lastIndexOf(opens[opens.length - 1]) : -1;
    let inMedia = null;
    if (lastOpen !== -1) {
      // Inside that media block iff its braces have not closed before us.
      let depth = 0;
      let closed = false;
      for (let i = before.indexOf('{', lastOpen); i < before.length; i++) {
        if (before[i] === '{') depth++;
        else if (before[i] === '}' && --depth === 0) { closed = true; break; }
      }
      if (!closed) inMedia = /@media[^{]*/.exec(before.slice(lastOpen))[0].trim();
    }
    out.push({ selector, minHeight: parseInt(mh[1], 10), inMedia });
  }
  return out;
}

/**
 * The `min-height` of a column-0 base rule for `selector` in `css`.
 *
 * @param {string} css - Comment-stripped stylesheet.
 * @param {string} selector - Exact selector text (or comma list) as written.
 * @param {string} sheet - Sheet name, for the failure message.
 * @returns {number} Pixel value.
 */
function baseMinHeight(css, selector, sheet) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(m, `${sheet}: ${selector} must have a base rule`);
  const mh = /min-height:\s*(\d+)px/.exec(m[1]);
  assert.ok(mh, `${sheet}: ${selector} must declare min-height`);
  return parseInt(mh[1], 10);
}

describe('button touch targets (#823)', () => {
  it('.btn holds the 44px floor in both stylesheets, matching the form inputs', () => {
    assert.equal(baseMinHeight(CSS['style.css'], '.btn', 'style.css'), FLOOR);
    assert.equal(baseMinHeight(CSS['session.css'], '.btn', 'session.css'), FLOOR);
    assert.equal(baseMinHeight(CSS['style.css'], '.form-input, .form-select', 'style.css'), FLOOR,
      'style.css inputs are the floor .btn is measured against');
    const sessionInput = /^\.form-input,\s*\n?[^{]*\{([^}]*)\}/m.exec(CSS['session.css']);
    assert.ok(sessionInput, 'session.css must have a .form-input rule');
    assert.match(sessionInput[1], new RegExp(`min-height:\\s*${FLOOR}px`), 'session.css inputs hold the same floor');
  });

  it('"small" is typographic: .btn-small keeps the floor in both stylesheets', () => {
    assert.equal(baseMinHeight(CSS['style.css'], '.btn-small', 'style.css'), FLOOR);
    assert.equal(baseMinHeight(CSS['session.css'], '.btn-small', 'session.css'), FLOOR);
  });

  it('no contextual override lowers a .btn below the floor — exceptions are named classes only', () => {
    for (const [sheet, css] of Object.entries(CSS)) {
      for (const { selector, minHeight, inMedia } of buttonMinHeights(css)) {
        if (minHeight >= FLOOR) continue;
        const named = Object.keys(EXCEPTIONS).find((cls) => selector === cls || selector.startsWith(`${cls}.`) || selector.startsWith(`${cls}:`));
        assert.ok(named, `${sheet}: "${selector}" sets min-height ${minHeight}px${inMedia ? ` inside ${inMedia}` : ''} below the ${FLOOR}px floor and is not a named exception — the Master rules section used to do exactly this with ".master-rules-section .btn { min-height: 32px }"`);
        assert.ok(EXCEPTIONS[named].includes(sheet), `${named} is only excepted in ${EXCEPTIONS[named].join(', ')}, found in ${sheet}`);
      }
    }
  });

  it('every named exception says why, in a comment immediately above its base rule', () => {
    for (const [cls, [sheet]] of Object.entries(EXCEPTIONS)) {
      const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`\\*/\\s*\\n${esc}\\s*\\{`).exec(RAW[sheet]);
      assert.ok(m, `${sheet}: ${cls} must be preceded directly by a comment explaining the exception`);
      const commentStart = RAW[sheet].lastIndexOf('/*', m.index);
      const comment = RAW[sheet].slice(commentStart, m.index);
      assert.match(comment, /EXCEPTION/, `${sheet}: the comment above ${cls} must call itself an exception`);
      assert.match(comment, /#(823|1215)/, `${sheet}: the comment above ${cls} must cite the issue that granted it`);
    }
  });

  it('.btn-compact is lifted to the floor wherever the pointer is coarse', () => {
    const coarse = /@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/.exec(CSS['style.css']);
    assert.ok(coarse, 'style.css must have a (pointer: coarse) block');
    assert.match(coarse[1], new RegExp(`\\.btn-compact\\s*\\{[^}]*min-height:\\s*${FLOOR}px`));
    assert.match(coarse[1], new RegExp(`\\.btn-icon-tiny\\s*\\{[^}]*min-height:\\s*${FLOOR}px`));
  });

  it('.dash-action is lifted to the floor wherever the pointer is coarse (#1215)', () => {
    // The header pills are the controls #823's floor never reached: they are
    // not `.btn`, so neither the base rule nor the coarse block saw them, and
    // the operator taps them on a phone more than anything else on the page.
    const coarse = /@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/.exec(CSS['style.css']);
    assert.ok(coarse, 'style.css must have a (pointer: coarse) block');
    assert.match(coarse[1], new RegExp(`\\.dash-action\\s*\\{[^}]*min-height:\\s*${FLOOR}px`),
      'the seven header pills must be a 44px target on a finger');
  });

  it('the header pill row wraps at phone width, so 44px pills reflow instead of clipping (#1215)', () => {
    // The lift only helps if the taller row has somewhere to go. #1192 gave
    // `.dash-actions` its own full-width line below 600px; without that rule
    // seven 44px pills would run off the edge of a 390px screen.
    const portrait = /@media \(max-width: 600px\)\s*\{([\s\S]*?)\n\}/.exec(CSS['style.css']);
    assert.ok(portrait, 'style.css must have a max-width: 600px block');
    assert.match(portrait[1], /\.dash-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('.btn-icon is square at the floor, not 32px wide on a 44px button', () => {
    const m = /^\.btn-icon\s*\{([^}]*)\}/m.exec(CSS['style.css']);
    assert.ok(m, 'style.css must have .btn-icon');
    assert.match(m[1], new RegExp(`min-width:\\s*${FLOOR}px`));
  });
});
