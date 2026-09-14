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
    const actions = SESSION_HTML.slice(SESSION_HTML.indexOf('<div class="banner-actions">'));
    const afterWrapper = actions.slice(actions.indexOf('</span>', actions.indexOf('banner-end-actions')) + 7, actions.indexOf('</div>'));
    assert.doesNotMatch(afterWrapper, /<button/, 'nothing follows the pair inside the banner actions');
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
