'use strict';

/*
 * #1192 — the dashboard's three single-row bars (header, toolbar, card action
 * row) must wrap at phone widths instead of overlapping or clipping.
 *
 * Mobile was not ignored before this fix; it was mis-targeted. A 480px block
 * stacked the card name and a `pointer: coarse` block enforced 44px targets,
 * but the 600px block did exactly one thing (hide `.dash-stats`), so a phone
 * in portrait — inside the 480–600 gap — got the desktop toolbar: three
 * non-shrinking columns drawn over each other. Landscape (844px) got the
 * desktop header, whose trailing pills clip for the same reason. This guard
 * pins the rules the phone blocks must carry.
 *
 * It also pins CASCADE position, per rule, because the first version of the
 * fix was green in the file and lost in the browser: the 600px block sat near
 * the header rules, BEFORE the `.toolbar-center` / `.card-row-actions` base
 * rules it overrides at equal specificity, so source order silently handed
 * the win back to the base rule. The same shape bit the engine select's
 * `width: auto` once it moved out of an inline style. A rule that exists but
 * cannot win is exactly what a text-only contract test would otherwise bless
 * — and a rule moved into a SECOND, earlier phone block would lose the same
 * way, so the position check follows each rule to whichever block holds it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
// Comments stripped: a declaration merely NAMED in prose must not read as present.
const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
const STYLE = stripCss(pub('style.css'));
const INDEX_HTML = pub('index.html');

const PORTRAIT_QUERY = '@media (max-width: 600px)';
const LANDSCAPE_QUERY = '@media (max-width: 900px)';

/**
 * Escape a selector for use inside a RegExp.
 *
 * @param {string} selector - Selector text.
 * @returns {string} Escaped text.
 */
function esc(selector) {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every `@media <query>` block in the stylesheet, as `{ start, body }` —
 * `start` is the block's offset in the file (for cascade assertions), `body`
 * the brace-balanced text inside it.
 *
 * @param {string} css - Comment-stripped stylesheet.
 * @param {string} query - The exact `@media (...)` prelude to find.
 * @returns {Array<{start: number, body: string}>} Blocks in source order.
 */
function mediaBlocks(css, query) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(query, from);
    if (start === -1) return blocks;
    const open = css.indexOf('{', start);
    let depth = 0;
    let closed = false;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        blocks.push({ start, body: css.slice(open + 1, i) });
        from = i;
        closed = true;
        break;
      }
    }
    if (!closed) assert.fail(`${query} block at ${start} never closes`);
  }
}

/**
 * The rule for `selector` inside one of `blocks`: its declarations as a
 * `prop: value` map plus the offset of the block that holds it. Fails the
 * test when no block carries the selector — an absent rule is the defect this
 * file guards, not a lookup miss to paper over.
 *
 * @param {Array<{start: number, body: string}>} blocks - Media blocks of one query.
 * @param {string} query - The query, for the failure message.
 * @param {string} selector - Exact selector text, e.g. `.toolbar-center`.
 * @returns {{decls: Record<string, string>, blockStart: number}} Rule + position.
 */
function ruleIn(blocks, query, selector) {
  const re = new RegExp(`(?:^|[\\s}])${esc(selector)}\\s*\\{([^}]*)\\}`);
  for (const b of blocks) {
    const m = re.exec(b.body);
    if (!m) continue;
    const decls = {};
    for (const d of m[1].split(';')) {
      const idx = d.indexOf(':');
      if (idx === -1) continue;
      decls[d.slice(0, idx).trim()] = d.slice(idx + 1).trim();
    }
    return { decls, blockStart: b.start };
  }
  assert.fail(`${selector} must have a rule inside ${query}`);
}

/**
 * Offset of the top-level (non-media) base rule for `selector`, so a cascade
 * assertion can check the phone block follows it.
 *
 * @param {string} selector - Exact selector text.
 * @returns {number} Offset of `selector {` at column 0.
 */
function baseRuleOffset(selector) {
  const m = new RegExp(`^${esc(selector)}\\s*\\{`, 'm').exec(STYLE);
  assert.ok(m, `${selector} must have a base rule at column 0`);
  return m.index;
}

/**
 * Assert the phone rule for `selector` both carries `expected` and sits after
 * the base rule it overrides — every override here is at equal specificity,
 * so a rule placed before its base rule is present in the file and absent in
 * the browser.
 *
 * @param {Array<{start: number, body: string}>} blocks - Media blocks of one query.
 * @param {string} query - The query, for messages.
 * @param {string} selector - Exact selector text.
 * @param {Record<string, string>} expected - Declarations that must be present.
 * @returns {Record<string, string>} The rule's declarations, for further checks.
 */
function expectOverride(blocks, query, selector, expected) {
  const { decls, blockStart } = ruleIn(blocks, query, selector);
  for (const [prop, value] of Object.entries(expected)) {
    assert.equal(decls[prop], value, `${selector} in ${query}: ${prop}`);
  }
  assert.ok(baseRuleOffset(selector) < blockStart,
    `${selector}: the ${query} rule must follow the base rule it overrides (source order decides at equal specificity)`);
  return decls;
}

describe('phone dashboard layout (#1192)', () => {
  const portrait = mediaBlocks(STYLE, PORTRAIT_QUERY);
  const landscape = mediaBlocks(STYLE, LANDSCAPE_QUERY);
  const P = (selector, expected) => expectOverride(portrait, PORTRAIT_QUERY, selector, expected);
  const L = (selector, expected) => expectOverride(landscape, LANDSCAPE_QUERY, selector, expected);

  it('the portrait block still hides the stats cluster', () => {
    assert.equal(ruleIn(portrait, PORTRAIT_QUERY, '.dash-stats').decls.display, 'none');
  });

  it('landscape: the header wraps its action pills under the brand line instead of clipping the gear', () => {
    L('.dash-bar', { 'flex-wrap': 'wrap' });
    L('.dash-actions', { 'flex-wrap': 'wrap' });
  });

  it('portrait: the header wraps its action pills instead of clipping the Master pill', () => {
    P('.dash-bar', { 'flex-wrap': 'wrap' });
    P('.dash-actions', { 'flex-wrap': 'wrap', flex: '1 1 100%' });
  });

  it('portrait: a visible auth/bind/ttyd notice wraps inside a shrinkable brand cluster instead of running off the edge', () => {
    P('.dash-brand', { flex: '1 1 100%', 'flex-wrap': 'wrap', 'min-width': '0' });
    P('.dash-auth-warning', { 'white-space': 'normal', 'max-width': '100%' });
  });

  it('portrait: the toolbar wraps — count and + New on one line, the filter column on its own', () => {
    P('.toolbar', { 'flex-wrap': 'wrap' });
    P('.toolbar-left', { flex: '1 1 auto' });
    P('.toolbar-center', { flex: '1 1 100%', order: '1', 'justify-content': 'flex-start' });
  });

  it('portrait: the card stacks its name above badges and buttons, not only below 480px', () => {
    P('.card-row', { 'flex-wrap': 'wrap' });
    P('.card-name', { order: '-1' });
    P('.status-dot', { order: '-2' });
    assert.ok(!/@media \(max-width: 480px\)/.test(STYLE), 'the 480px block is folded into the 600px one');
  });

  it('portrait: the card action row may wrap and keeps the destructive × off the card edge', () => {
    const row = P('.card-row-actions', { 'flex-wrap': 'wrap', 'flex-shrink': '1', 'min-width': '0' });
    const margin = parseInt(row['margin-right'], 10);
    assert.ok(margin >= 8, `margin-right must be at least 8px to keep × off the edge, got ${row['margin-right']}`);
  });

  it('the engine select carries no inline width; the stylesheet owns it and its rule outranks .filter-input by position', () => {
    const select = /<select[^>]*id="engineFilter"[^>]*>/.exec(INDEX_HTML);
    assert.ok(select, 'index.html must still have the engine filter select');
    assert.ok(!/\sstyle=/.test(select[0]), `the select must not carry an inline style: ${select[0]}`);
    assert.ok(/filter-input--engine/.test(select[0]), 'the select opts into the engine width via a class');
    const rule = /^\.filter-input--engine\s*\{([^}]*)\}/m.exec(STYLE);
    assert.ok(rule, '.filter-input--engine must be a base rule in style.css');
    assert.match(rule[1], /width:\s*auto/);
    assert.ok(rule.index > baseRuleOffset('.filter-input'), '.filter-input--engine must follow .filter-input so width: auto beats width: 100%');
  });
});
