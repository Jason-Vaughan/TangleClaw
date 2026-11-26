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

  it('R-Gate (PR #3288): ties min-width to the same viewport budget as max-width, so neither can '
    + 'win below a narrow viewport', () => {
    // A bare `min-width: 320px` wins over `max-width: calc(100vw - 32px)` below a 352px
    // viewport -- CSS gives min-width precedence over max-width whenever they conflict.
    // Below that width this clamp must shrink too, not stay fixed.
    assert.doesNotMatch(body, /min-width:\s*\d+px;/, 'a plain min-width in px would reintroduce the conflict');
    const minWidthMatch = body.match(/min-width:\s*min\(\s*(\d+)px\s*,\s*calc\(100vw\s*-\s*(\d+)px\)\s*\);/);
    assert.ok(minWidthMatch, 'min-width must be min(<Npx>, calc(100vw - <Mpx>)), tied to the same formula');
    const maxWidthMatch = body.match(/max-width:\s*calc\(100vw\s*-\s*(\d+)px\);/);
    assert.equal(minWidthMatch[2], maxWidthMatch[1], 'the two must share the same viewport-margin subtrahend');
  });

  it('R-Gate R3: computed bounding-box geometry stays inside the viewport at every required width', () => {
    // Parsed from the real rule, not hardcoded, so this tracks style.css rather than a
    // snapshot of it: min-width's fixed literal (320), min-width's calc() subtrahend (32,
    // must equal max-width's own), and max-width's subtrahend (32).
    const minWidthMatch = body.match(/min-width:\s*min\(\s*(\d+)px\s*,\s*calc\(100vw\s*-\s*(\d+)px\)\s*\);/);
    const maxWidthMatch = body.match(/max-width:\s*calc\(100vw\s*-\s*(\d+)px\);/);
    assert.ok(minWidthMatch && maxWidthMatch, 'both min-width and max-width must parse before computing geometry');
    const minFixedPx = Number(minWidthMatch[1]);
    const minSubtrahendPx = Number(minWidthMatch[2]);
    const maxSubtrahendPx = Number(maxWidthMatch[1]);

    /**
     * The actual CSS cascade for a box with both `min-width` and `max-width` (CSS 2.2 10.4):
     * clamp to max-width first, THEN clamp the result up to min-width if that violates it —
     * so when min-width's computed value exceeds max-width's, min-width wins outright and the
     * box renders WIDER than max-width, which is exactly the bug this guards against. This is
     * what distinguishes a real geometry test from a text-pattern match: it fails against the
     * pre-fix CSS (a bare `min-width: 320px`) and passes against the post-fix one.
     * @param {number} vw
     * @returns {number}
     */
    function effectiveWidth(vw) {
      const minWidth = Math.min(minFixedPx, vw - minSubtrahendPx);
      const maxWidth = vw - maxSubtrahendPx;
      return minWidth > maxWidth ? minWidth : maxWidth;
    }

    // #v6EngineUsageSlot sits near the footer's right edge (#3270's own root cause); modeled
    // here, per R-Gate's own spec, as 16px from the viewport's right edge — the worst case the
    // anchor (`right: 0` within that slot) actually has to survive.
    const SLOT_RIGHT_MARGIN_PX = 16;

    for (const vw of [1440, 1280, 1024, 768, 352, 320]) {
      const width = effectiveWidth(vw);
      const right = vw - SLOT_RIGHT_MARGIN_PX;
      const left = right - width;
      assert.ok(left >= 0, `left (${left}) must be >= 0 at viewport ${vw}px`);
      assert.ok(right <= vw, `right (${right}) must be <= viewport (${vw})`);
      assert.ok(width <= vw - maxSubtrahendPx, `width (${width}) must be <= max-width's own bound at viewport ${vw}px`);
    }
  });

  it('R-Gate R3: the pre-fix CSS (a bare min-width, no shared formula) fails this same geometry '
    + 'check -- proving the test is a real regression guard, not a tautology', () => {
    const PRE_FIX_MIN_WIDTH_PX = 320;
    const PRE_FIX_MAX_SUBTRAHEND_PX = 32;
    function preFixEffectiveWidth(vw) {
      const maxWidth = vw - PRE_FIX_MAX_SUBTRAHEND_PX;
      return PRE_FIX_MIN_WIDTH_PX > maxWidth ? PRE_FIX_MIN_WIDTH_PX : maxWidth;
    }
    const vw = 320;
    const width = preFixEffectiveWidth(vw);
    const left = (vw - 16) - width;
    assert.ok(left < 0, `sanity check: the pre-fix formula must overflow left at ${vw}px (got left=${left})`);
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
