'use strict';

/*
 * #1312 — the wrap drawer became a non-modal popover: no backdrop, so the
 * terminal behind it stays usable; anchored under the Wrap button on a wide
 * screen and a 60vh bottom sheet on a phone; everything between its header and
 * its buttons scrolls as one region (#1491); and
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

  it('status, skip list, steps and decision sit inside the scroll body; the header and actions do not (#1491)', () => {
    const asideAt = HTML.indexOf('id="wrapDrawer"');
    const aside = HTML.slice(asideAt, HTML.indexOf('</aside>', asideAt));
    const bodyOpen = aside.indexOf('id="wrapDrawerBody"');
    assert.ok(bodyOpen !== -1, 'the scroll body exists');
    // The body holds only its four sections and no nested <div> of its own, so
    // its end is the first </div> after the last section closes.
    const decisionAt = aside.indexOf('id="wrapDrawerDecision"');
    const bodyClose = aside.indexOf('</div>', aside.indexOf('</div>', decisionAt) + 1);
    for (const id of ['wrapDrawerStatus', 'wrapDrawerSkipRoll', 'wrapStepList', 'wrapDrawerDecision']) {
      const at = aside.indexOf(`id="${id}"`);
      assert.ok(at > bodyOpen && at < bodyClose, `${id} is inside the scroll body`);
    }
    for (const id of ['wrapDrawerCloseBtn', 'wrapDrawerCancelBtn', 'wrapDrawerDoneBtn', 'wrapDrawerRetryBtn']) {
      const at = aside.indexOf(`id="${id}"`);
      assert.ok(at !== -1 && (at < bodyOpen || at > bodyClose), `${id} stays outside the scroll body`);
    }
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

  it('closed, it cannot take a click — at once, not after a transition; open, it shows', () => {
    const closed = rule('.wrap-drawer', null);
    assert.equal(closed.visibility, 'hidden');
    assert.equal(closed['pointer-events'], 'none');
    // Seen live: in a backgrounded tab no transition runs, so a `visibility`
    // transition delay left an invisible popover taking the terminal's clicks.
    for (const media of [null, '@media (max-width: 600px)']) {
      for (const sel of ['.wrap-drawer', '.wrap-drawer.open']) {
        const hit = RULES.find((r) => r.media === media && r.selector === sel);
        if (hit && decls(hit.body).transition) {
          assert.doesNotMatch(decls(hit.body).transition, /visibility|pointer-events/, `${sel} ${media || ''} animates hiding`);
        }
      }
    }
    const open = rule('.wrap-drawer.open', null);
    assert.equal(open.visibility, 'visible');
    assert.equal(open['pointer-events'], 'auto');
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

  // #1491 replaces #1312's "the step list scrolls" with one scroll region. With the
  // step list, skip list and decision sharing a capped flex column, the two that
  // refused to shrink pushed a rule proposal's Approve/Reject and the Close/Done row
  // below the popover's clipped edge, where no scrollbar could reach them.
  it('the steps, skip list and decision scroll together in one body, between a fixed header and fixed actions', () => {
    const body = rule('.wrap-drawer-body', null);
    assert.equal(body['overflow-y'], 'auto');
    assert.equal(body['min-height'], '0', 'a flex child only scrolls inside a capped parent when it may shrink');
    assert.match(body.flex, /^1\b/);
    assert.notEqual(body.display, 'flex', 'a flex body would let its sections be squeezed again');
    assert.equal(rule('.wrap-drawer-header', null)['flex-shrink'], '0');
    assert.equal(rule('.wrap-drawer-actions', null)['flex-shrink'], '0');
  });

  it('no section inside the body caps itself or scrolls on its own', () => {
    for (const sel of ['.wrap-drawer-status', '.wrap-drawer-skiproll', '.wrap-step-list', '.wrap-drawer-decision']) {
      for (const r of RULES.filter((x) => x.selector.split(',').map((s) => s.trim()).includes(sel))) {
        const d = decls(r.body);
        assert.equal(d['max-height'], undefined, `${sel} ${r.media || ''} caps its own height`);
        assert.equal(d['overflow-y'], undefined, `${sel} ${r.media || ''} scrolls inside the scroll region`);
        assert.equal(d['flex-shrink'], undefined, `${sel} ${r.media || ''} takes part in flex sizing`);
      }
    }
  });

  it('honours reduced motion', () => {
    const d = rule('.wrap-drawer', '@media (prefers-reduced-motion: reduce)');
    assert.equal(d.transition, 'none');
  });

  it('every handback tone the view-model produces has a style', () => {
    for (const tone of ['working', 'ready', 'problem']) rule(`.wrap-step-handback-status--${tone}`, null);
  });
});
