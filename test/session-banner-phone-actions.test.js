'use strict';

/*
 * #1478 — on a phone the session banner's actions wrapped with Kill stranded
 * on a line of its own. Wrap and Kill are now one flex item, and the phone
 * rule tightens padding and gaps without shrinking the 30px touch target.
 * Layout itself was measured in headless Chrome at 390/375/360px; these tests
 * pin the markup and the CSS rules that layout rests on.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');
const SESSION_CSS = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');
const SHARED_CSS = fs.readFileSync(path.join(PUBLIC, 'shared-controls.css'), 'utf8');

/**
 * The declarations of the first rule for `selector` inside `css`.
 * @param {string} css
 * @param {string} selector - Exact selector text as written
 * @returns {string|null}
 */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return m ? m[1] : null;
}

/**
 * Every `@media (max-width: 600px)` block's body in `css`.
 * @param {string} css
 * @returns {string[]}
 */
function phoneBlocks(css) {
  return [...css.matchAll(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
}

describe('#1478 Wrap and Kill wrap together on a phone', () => {
  it('markup: Wrap and Kill are the only buttons in one wrapper, at the end of the banner actions', () => {
    const m = SESSION_HTML.match(/<span class="banner-end-actions">([\s\S]*?)<\/span>/);
    assert.ok(m, 'the wrapper exists');
    const ids = [...m[1].matchAll(/id="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(ids, ['wrapBtn', 'killBtn']);
    // From the pair's closing tag to the end of the banner actions. Both
    // searches start at the wrapper, so an earlier `</div>` (the Medusa panel)
    // cannot end the slice before it starts.
    const wrapperAt = SESSION_HTML.indexOf('<span class="banner-end-actions">');
    const pairEnd = SESSION_HTML.indexOf('</span>', wrapperAt) + '</span>'.length;
    const actionsEnd = SESSION_HTML.indexOf('</div>', pairEnd);
    const headerEnd = SESSION_HTML.indexOf('</header>', wrapperAt);
    assert.ok(wrapperAt > SESSION_HTML.indexOf('<div class="banner-actions">'), 'the pair is inside the banner actions');
    assert.ok(pairEnd < actionsEnd && actionsEnd < headerEnd, 'the slice is non-empty and ends at the banner actions');
    assert.doesNotMatch(SESSION_HTML.slice(pairEnd, actionsEnd), /<button/, 'nothing follows the pair inside the banner actions');
  });

  it('css: the pair is one flex item that does not shrink or split', () => {
    const body = ruleBody(SESSION_CSS, '.banner-end-actions');
    assert.ok(body, 'a .banner-end-actions rule exists');
    assert.match(body, /display: inline-flex/);
    assert.match(body, /flex-shrink: 0/);
    assert.doesNotMatch(body, /flex-wrap: wrap/);
  });

  it('css: the phone rule tightens padding and gaps but never the touch target', () => {
    const block = phoneBlocks(SESSION_CSS).find((b) => /\.banner-btn \{/.test(b));
    assert.ok(block, 'a phone rule for .banner-btn exists');
    const btn = block.match(/\.banner-btn \{([^}]*)\}/)[1];
    assert.match(btn, /padding: 2px 4px/);
    assert.doesNotMatch(btn, /min-(width|height)/, 'the phone rule must not lower the 30px minimum');
    assert.match(block, /\.banner-actions,\s*\.banner-end-actions \{ gap: 3px; \}/);

    const shared = ruleBody(SHARED_CSS, '.banner-btn');
    assert.match(shared, /min-height: 30px/);
    assert.match(shared, /min-width: 30px/);
  });
});

/*
 * #1571 — the banner cut the project name at a fixed width (160px; 100px on a
 * phone; 200px on a desktop) whatever the row had free, so a 24-character
 * name read as "JasonVaughanCo…" beside empty space. Measured on a scratch
 * server before the fix: 100px of a 187px name at every width from 375 to
 * 600, with 36px free at 412 and 224px free at 600. The name is now a flex
 * item that grows into the row's free space and ellipsizes only when the row
 * is genuinely short. A cap in ANY rule would bring the bug back, so every
 * `.banner-name` rule in the file is checked, comments stripped first (a
 * declaration named in prose must not read as present, and a stray comment
 * closer would delete the rule after it while a substring test stayed green).
 */
describe('#1571 the banner name takes the row\'s free space before it truncates', () => {
  const stripped = SESSION_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

  /**
   * Every rule body for `selector` in `css`, in source order.
   * @param {string} css
   * @param {string} selector - Exact selector text as written
   * @returns {string[]}
   */
  function ruleBodies(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...css.matchAll(new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`, 'gm'))].map((m) => m[1]);
  }

  it('css: the base rule grows into free space, may shrink to zero, and still ellipsizes', () => {
    const body = ruleBody(stripped, '.banner-name');
    assert.ok(body, 'a .banner-name rule exists');
    assert.match(body, /flex: 1 1 auto/);
    assert.match(body, /min-width: 0/);
    assert.match(body, /text-overflow: ellipsis/);
    assert.match(body, /white-space: nowrap/);
  });

  it('css: no rule anywhere in the file caps the name\'s width', () => {
    const bodies = ruleBodies(stripped, '.banner-name');
    assert.ok(bodies.length >= 1, 'at least the base rule exists');
    for (const body of bodies) {
      assert.doesNotMatch(body, /max-width/, `a .banner-name rule caps the width: {${body.trim()}}`);
      assert.doesNotMatch(body, /(^|[^-])width\s*:/, `a .banner-name rule fixes the width: {${body.trim()}}`);
    }
  });

  it('css: the stylesheet still parses as a stylesheet (no orphan comment closer, balanced braces)', () => {
    assert.doesNotMatch(stripped, /\*\//, 'an orphan */ would swallow the rule after it');
    assert.doesNotMatch(stripped, /\/\*/, 'an unterminated /* would swallow the rest of the file');
    const opens = (stripped.match(/\{/g) || []).length;
    const closes = (stripped.match(/\}/g) || []).length;
    assert.equal(opens, closes, 'braces balance');
  });
});
