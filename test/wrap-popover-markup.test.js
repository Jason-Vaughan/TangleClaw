'use strict';

/*
 * #1312 — the wrap drawer became a non-modal popover: no backdrop, so the
 * terminal behind it stays usable; anchored under the Wrap button on a wide
 * screen and a 60vh bottom sheet on a phone; its steps scroll inside it; and
 * closed, it cannot take a click meant for the terminal. Behaviour is covered
 * in `wrap-run-session-wiring.test.js`; these pin the markup and the CSS rules
 * the layout rests on, read the way a parser reads them (comments stripped,
 * braces balanced), because a stray comment edit silently drops the next rule.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');
const CSS = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');

/**
 * Parse a stylesheet into top-level entries: plain rules and `@media` blocks
 * holding their own rules. Comments are removed first; unbalanced braces throw.
 * @param {string} css
 * @returns {{selector: string, body: string, media: string|null}[]} Every rule, with its enclosing media query
 */
function parseRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let i = 0;
  const readBlock = (start) => {
    let depth = 0;
    for (let j = start; j < text.length; j += 1) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') {
        depth -= 1;
        if (depth === 0) return j;
      }
    }
    throw new Error(`unbalanced braces from offset ${start}`);
  };
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const prelude = text.slice(i, open).trim();
    const close = readBlock(open);
    const inner = text.slice(open + 1, close);
    if (prelude.startsWith('@media')) {
      for (const r of parseRules(inner)) rules.push({ ...r, media: prelude });
    } else {
      rules.push({ selector: prelude, body: inner, media: null });
    }
    i = close + 1;
  }
  return rules;
}

/**
 * Declarations of a rule as a map.
 * @param {string} body
 * @returns {Record<string, string>}
 */
function decls(body) {
  const out = {};
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return out;
}

const RULES = parseRules(CSS);

/**
 * The declarations of the rule for `selector` under `media` (null = top level).
 * @param {string} selector
 * @param {string|null} media
 * @returns {Record<string, string>}
 */
function rule(selector, media) {
  const hit = RULES.find((r) => r.media === media && r.selector.split(',').map((x) => x.trim()).includes(selector));
  assert.ok(hit, `no rule for ${selector}${media ? ` in ${media}` : ''}`);
  return decls(hit.body);
}

describe('wrap popover markup (#1312)', () => {
  const asideTag = HTML.match(/<aside[^>]*id="wrapDrawer"[^>]*>/);

  it('has no backdrop and is not modal', () => {
    assert.ok(asideTag, 'the popover element exists');
    assert.doesNotMatch(HTML, /id="wrapDrawerBackdrop"/);
    assert.doesNotMatch(asideTag[0], /aria-modal/);
    assert.match(asideTag[0], /role="dialog"/);
  });

  it('the Wrap button names the popover it controls', () => {
    assert.match(HTML, /<button[^>]*id="wrapBtn"[^>]*aria-controls="wrapDrawer"/);
  });
});

describe('wrap popover stylesheet (#1312)', () => {
  it('parses: every brace in session.css balances', () => {
    assert.ok(RULES.length > 0);
  });

  it('wide screens: anchored at the top right, capped, and never a full-width bottom sheet', () => {
    const d = rule('.wrap-drawer', null);
    assert.equal(d.position, 'fixed');
    assert.match(d.top, /var\(--wrap-popover-top/);
    assert.match(d.right, /var\(--wrap-popover-right/);
    assert.equal(d.bottom, 'auto');
    assert.match(d.width, /^min\(420px/);
    assert.match(d['max-height'], /^min\(70vh/);
  });

  it('closed, it cannot take a click; open, it shows', () => {
    assert.equal(rule('.wrap-drawer', null).visibility, 'hidden');
    assert.equal(rule('.wrap-drawer.open', null).visibility, 'visible');
  });

  it('phones: a 60vh bottom sheet', () => {
    const phone = '@media (max-width: 600px)';
    const d = rule('.wrap-drawer', phone);
    assert.equal(d.bottom, '0');
    assert.equal(d.top, 'auto');
    assert.equal(d.height, '60vh');
    assert.equal(d['max-height'], '60vh');
    assert.equal(rule('.wrap-drawer.open', phone).transform, 'translateY(0)');
  });

  it('the steps scroll inside the popover', () => {
    const list = rule('.wrap-step-list', null);
    assert.equal(list['overflow-y'], 'auto');
    assert.equal(list['min-height'], '0', 'a flex child only scrolls inside a capped parent when it may shrink');
  });

  it('honours reduced motion', () => {
    const d = rule('.wrap-drawer', '@media (prefers-reduced-motion: reduce)');
    assert.equal(d.transition, 'none');
  });

  it('every handback tone the view-model produces has a style', () => {
    for (const tone of ['working', 'ready', 'problem']) rule(`.wrap-step-handback-status--${tone}`, null);
  });
});
