'use strict';

/*
 * #1192 — the dashboard's three single-row bars (header, toolbar, card action
 * row) must wrap at phone widths instead of overlapping or clipping.
 *
 * Mobile was not ignored before this fix; it was mis-targeted. A 480px block
 * stacked the card name and a `pointer: coarse` block enforced 44px targets,
 * but the 600px block did exactly one thing (hide `.dash-stats`), so a phone
 * in portrait — inside the 480–600 gap — got the desktop toolbar: three
 * non-shrinking columns drawn over each other. This guard pins the rules the
 * 600px block must carry.
 *
 * It also pins two CASCADE positions, because the first version of the fix
 * was green in the file and lost in the browser: the 600px block sat near the
 * header rules, BEFORE the `.toolbar-center` / `.card-row-actions` base rules
 * it overrides at equal specificity, so source order silently handed the win
 * back to the base rule. The same shape bit the engine select's `width: auto`
 * once it moved out of an inline style. A rule that exists but cannot win is
 * exactly what a text-only contract test would otherwise bless.
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

const PHONE_QUERY = '@media (max-width: 600px)';

/**
 * Every `@media (max-width: 600px)` block in the stylesheet, as
 * `{ start, body }` — `start` is the block's offset in the file (for cascade
 * assertions), `body` the brace-balanced text inside it.
 *
 * @param {string} css - Comment-stripped stylesheet.
 * @returns {Array<{start: number, body: string}>} Blocks in source order.
 */
function phoneBlocks(css) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(PHONE_QUERY, from);
    if (start === -1) return blocks;
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        blocks.push({ start, body: css.slice(open + 1, i) });
        from = i;
        break;
      }
    }
    if (depth !== 0) assert.fail(`${PHONE_QUERY} block at ${start} never closes`);
  }
}

/**
 * The declarations of `selector`'s rule inside `body`, as a `prop: value`
 * map. Fails the test when the selector has no rule there — an absent rule
 * is the defect this file guards, not a lookup miss to paper over.
 *
 * @param {string} body - Text inside a media block.
 * @param {string} selector - Exact selector text, e.g. `.toolbar-center`.
 * @returns {Record<string, string>} Declarations of that rule.
 */
function declsOf(body, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[\\s}])${esc}\\s*\\{([^}]*)\\}`).exec(body);
  assert.ok(m, `${selector} must have a rule inside ${PHONE_QUERY}`);
  const out = {};
  for (const d of m[1].split(';')) {
    const idx = d.indexOf(':');
    if (idx === -1) continue;
    out[d.slice(0, idx).trim()] = d.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Offset of the top-level (non-media) base rule for `selector`, so a cascade
 * assertion can check the phone block follows it.
 *
 * @param {string} selector - Exact selector text.
 * @returns {number} Offset of `selector {` at column 0.
 */
function baseRuleOffset(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}\\s*\\{`, 'm').exec(STYLE);
  assert.ok(m, `${selector} must have a base rule at column 0`);
  return m.index;
}

describe('phone-portrait dashboard layout (#1192)', () => {
  const blocks = phoneBlocks(STYLE);
  const body = blocks.map((b) => b.body).join('\n');

  it('the 600px block still hides the stats cluster', () => {
    assert.equal(declsOf(body, '.dash-stats').display, 'none');
  });

  it('the header wraps its action pills instead of clipping the Master pill', () => {
    assert.equal(declsOf(body, '.dash-bar')['flex-wrap'], 'wrap');
    const actions = declsOf(body, '.dash-actions');
    assert.equal(actions['flex-wrap'], 'wrap');
    assert.equal(actions.flex, '1 1 100%', 'the pill row takes its own full line');
  });

  it('the toolbar wraps: count and + New on one line, the filter column on its own', () => {
    assert.equal(declsOf(body, '.toolbar')['flex-wrap'], 'wrap');
    assert.equal(declsOf(body, '.toolbar-left').flex, '1 1 auto', 'the count pushes + New to the right edge');
    const center = declsOf(body, '.toolbar-center');
    assert.equal(center.flex, '1 1 100%', 'the filter column cannot shrink below its filter box, so it takes a full line');
    assert.equal(center.order, '1', 'only the center column is reordered; DOM/tab order stays');
    assert.equal(center['justify-content'], 'flex-start');
  });

  it('the card stacks its name above badges and buttons at phone widths, not only below 480px', () => {
    assert.equal(declsOf(body, '.card-row')['flex-wrap'], 'wrap');
    assert.equal(declsOf(body, '.card-name').order, '-1');
    assert.equal(declsOf(body, '.status-dot').order, '-2');
    assert.ok(!/@media \(max-width: 480px\)/.test(STYLE), 'the 480px block is folded into the 600px one');
  });

  it('the card action row may wrap and keeps the destructive × off the card edge', () => {
    const row = declsOf(body, '.card-row-actions');
    assert.equal(row['flex-wrap'], 'wrap');
    assert.equal(row['flex-shrink'], '1', 'the base rule pins flex-shrink: 0; the row must be allowed to give');
    assert.equal(row['min-width'], '0');
    const margin = parseInt(row['margin-right'], 10);
    assert.ok(margin >= 8, `margin-right must be at least 8px to keep × off the edge, got ${row['margin-right']}`);
  });

  it('the phone block follows every base rule it overrides — equal specificity, so only source order lets it win', () => {
    const overriding = blocks.find((b) => /\.toolbar-center\s*\{/.test(b.body));
    assert.ok(overriding, 'a 600px block must carry .toolbar-center');
    for (const sel of ['.toolbar', '.toolbar-left', '.toolbar-center', '.card-row', '.card-name', '.card-row-actions', '.dash-bar', '.dash-actions']) {
      assert.ok(baseRuleOffset(sel) < overriding.start, `${sel} base rule must precede the phone block that overrides it`);
    }
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
