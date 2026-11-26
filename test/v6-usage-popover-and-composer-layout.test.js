'use strict';

/*
 * v6.6.1 Wave 1 (Car V661-W1-D, #3270 / V6-026, #3276 / V6-040).
 *
 * This repo ships zero npm dependencies (no jsdom, no Playwright/Puppeteer —
 * see test/v6-b1-ui-shell.test.js's own header), so there is no real
 * CSS-layout-capable browser in `node:test` to compute flex/grid geometry
 * (`getBoundingClientRect`) against. #3276's acceptance criterion 3 literally
 * asks for "a layout geometry regression test in Stage 2 browser E2E
 * asserting the gap ... is <= 12px" — but this repo's own Stage 2 file
 * (test/v6-browser-shell-and-conversation-e2e.test.js) is a mini-DOM mock
 * (test/_mini-dom.js) that never computes real layout, so that literal ask
 * cannot be implemented here. Flagged in the PR body rather than silently
 * dropped or faked with numbers a mock DOM cannot actually produce.
 *
 * The real geometry was instead verified empirically during development
 * against a real, isolated, disposable TangleClaw instance (Claude in
 * Chrome driving scripts/with-scratch-server.js's pattern): before the fix,
 * the gap between `.v6-chat-composer`'s bottom and the footer measured
 * 61.1875px (29.2px from `.v6-chat-send-status`'s reserved-but-empty line
 * plus `.v6-chat`'s own 10px flex gap, plus 32px from `.v6-shell-root`'s row
 * gap and `.v6-shell-watermark`'s margin-top); after it, 4px. What follows
 * pins the CSS rules that produce that result — the same
 * source-level-regression pattern test/v6-b1-ui-shell.test.js's own
 * "public/style.css grid rows (#3046)" describe block already uses for
 * assertions a mock DOM can't make either.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

/**
 * The body of the FIRST `{selector} { ... }` rule found in style.css.
 * @param {string} selector
 * @returns {string|null}
 */
function ruleBodyFor(selector) {
  const re = new RegExp(`${selector.replace(/[.#:]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = CSS.match(re);
  return match ? match[1] : null;
}

describe('#3270 (V6-026): .v6-usage-popover never overflows the viewport to the right', () => {
  const body = ruleBodyFor('.v6-usage-popover');

  it('anchors from the right instead of the left, so it never extends past a right-aligned trigger', () => {
    assert.match(body, /right:\s*0;/);
    assert.match(body, /left:\s*auto;/);
    assert.doesNotMatch(body, /left:\s*0;/, 'the old left: 0 anchor must be gone, not merely shadowed');
  });

  it('keeps a viewport-relative width and height clamp, so the popover itself can never exceed the screen', () => {
    assert.match(body, /max-width:\s*calc\(100vw\s*-\s*\d+px\);/);
    assert.match(body, /max-height:\s*min\([^)]*vh[^)]*\);/);
    assert.match(body, /overflow-y:\s*auto;/);
  });
});

describe('#3276 (V6-040): no unreclaimable dead space below the chat composer', () => {
  it('collapses the send-status line to zero height when there is nothing to show', () => {
    const body = ruleBodyFor('.v6-chat-send-status:empty');
    assert.ok(body, '.v6-chat-send-status:empty must exist, the same reserve-space-only-when-'
      + 'there-is-content pattern .v6-chat-attachments:empty already uses');
    assert.match(body, /display:\s*none;/);
  });

  it('removes chat mode\'s own row gap, so the empty telemetry-header row in chat view costs nothing', () => {
    const body = ruleBodyFor('.v6-shell-root--chat');
    assert.ok(body, '.v6-shell-root--chat must have its own rule, not just compound selectors naming it');
    assert.match(body, /row-gap:\s*0;/);
  });

  it('tightens the footer\'s own margin in chat mode instead of the page-wide default', () => {
    const scoped = ruleBodyFor('.v6-shell-root--chat .v6-shell-watermark');
    assert.ok(scoped, '.v6-shell-root--chat .v6-shell-watermark must have its own scoped rule');
    const marginMatch = scoped.match(/margin-top:\s*(\d+)px;/);
    assert.ok(marginMatch, 'the scoped rule must set an explicit margin-top');
    assert.ok(Number(marginMatch[1]) <= 12, 'with the send-status line and row-gap both at 0, '
      + 'this margin is the only remaining contributor and must alone stay under the 12px bar');

    // The page-wide default (every OTHER view) is untouched: #3046's own
    // pin (test/v6-b1-ui-shell.test.js) already covers grid-row: 3 for the
    // base .v6-shell-watermark rule; this only confirms the base rule still
    // carries its own (larger) margin-top, unaffected by the chat override.
    const base = ruleBodyFor('.v6-shell-watermark');
    assert.match(base, /margin-top:\s*16px;/);
  });
});
