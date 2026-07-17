'use strict';

/*
 * Regression tests for #445 — plain-drag terminal copy to the CLIENT
 * clipboard + long-press selection on touch.
 *
 * Design: everything funnels into the ALREADY-VERIFIED #432 force-selection
 * pipeline (local xterm selection → ttyd copy-on-select ✂ → #431 mouseup
 * re-copy). A capture-phase rewriter re-dispatches plain button-0 drags with
 * the platform's force-selection modifier (xterm's shouldForceSelection:
 * altKey on Mac — gated by macOptionClickForcesSelection — shiftKey
 * everywhere else); on touch, a long-press converts the finger drag into the
 * same synthetic modified mouse events.
 *
 * Source-level structural assertions — same pattern as
 * test/terminal-touch-scroll.test.js (#443).
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Plain-drag terminal copy + long-press select (#445)', () => {
  let helper;
  let sessionJs;
  let uiJs;
  let sw;
  /** The api-helper.js drag-copy function body, isolated. */
  let shim;
  /** The touch-scroll shim body (must yield to select mode). */
  let scrollShim;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    helper = fs.readFileSync(path.join(pub, 'api-helper.js'), 'utf8');
    sessionJs = fs.readFileSync(path.join(pub, 'session.js'), 'utf8');
    uiJs = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');

    const start = helper.indexOf('function tcWireTerminalDragCopy');
    assert.ok(start > -1, 'api-helper.js defines tcWireTerminalDragCopy');
    const end = helper.indexOf('function tcWireTerminalFrame');
    assert.ok(end > start, 'shim body precedes the shared frame pipeline (UI-4C7R)');
    shim = helper.slice(start, end);

    const sStart = helper.indexOf('function tcWireTerminalTouchScroll');
    scrollShim = helper.slice(sStart, start);
    assert.ok(sStart > -1 && sStart < start, 'touch-scroll shim precedes drag-copy');
  });

  describe('the shared helper (api-helper.js)', () => {
    it('is exposed on window alongside the other shared helpers', () => {
      assert.match(helper, /global\.tcWireTerminalDragCopy = tcWireTerminalDragCopy;/);
    });

    it('sets BOTH force-selection modifiers — xterm\'s own platform check picks (iOS is NOT-Mac there)', () => {
      // On-device lesson: alt-only synthetics did nothing on iPhone because
      // xterm inside the iframe classifies iOS as non-Mac and honors shiftKey.
      assert.match(shim, /altKey: true,/);
      assert.match(shim, /shiftKey: true,/);
      assert.ok(!/isMac \?/.test(shim), 'no client-side platform fork — defer to xterm\'s check');
    });

    it('forces altClickMovesCursor off so rewritten clicks cannot become arrow-key spam', () => {
      assert.match(shim, /term\.options\.altClickMovesCursor = false;/);
    });

    it('synthetic events are tagged and skipped first — no rewrite loop', () => {
      assert.match(shim, /evt\.tcSynthetic = true;/);
      // The guard must be the FIRST statement of the rewriter.
      assert.match(shim, /function rewrite\(e\) \{\n\s*if \(e\.tcSynthetic\) return;/);
    });

    it('rewrites only plain button-0 gestures while the app owns the mouse', () => {
      assert.match(shim, /if \(e\.button !== 0 \|\| e\.altKey \|\| e\.shiftKey\) return false;/);
      assert.match(shim, /term\.modes && term\.modes\.mouseTrackingMode/);
      assert.match(shim, /mode !== undefined && mode !== 'none'/);
    });

    it('swallows ghost mouse events after touch activity — they must not re-select and clobber the copy', () => {
      // iOS synthesizes mouse events at the lift point after a touch
      // sequence; rewritten, they force-selected ONE cell and copy-on-select
      // overwrote the dragged text with it (iteration-5 on-device failure).
      assert.match(shim, /const GHOST_MOUSE_MS = 1000;/);
      assert.match(shim, /Date\.now\(\) - lastTouchTs < GHOST_MOUSE_MS/);
      const ghost = shim.slice(shim.indexOf('lastTouchTs && Date.now()'));
      assert.ok(ghost.indexOf('stopImmediatePropagation') > -1 &&
                ghost.indexOf('stopImmediatePropagation') < ghost.indexOf("e.type === 'mousedown'"),
        'ghost window swallows (no re-dispatch) before any rewrite logic');
    });

    it('disarms on a button-less hover move — no phantom selection after an off-iframe release', () => {
      // Critic-caught: a mouseup outside the iframe never reaches this doc,
      // so the rewriter must reset when a real move reports buttons===0.
      assert.match(shim, /e\.type === 'mousemove' && e\.buttons === 0/);
    });

    it('intercepts at capture phase and swallows the real event', () => {
      assert.match(shim, /doc\.addEventListener\('mousedown', rewrite, \{ capture: true \}\);/);
      assert.match(shim, /doc\.addEventListener\('mousemove', rewrite, \{ capture: true \}\);/);
      assert.match(shim, /doc\.addEventListener\('mouseup', rewrite, \{ capture: true \}\);/);
      assert.match(shim, /e\.stopImmediatePropagation\(\);/);
    });

    it('long-press enters touch select mode driving xterm\'s selection API directly — NO synthetic mouse on touch', () => {
      // On-device lessons (2 iterations): iOS's touch→mouse translation is
      // unreliable — the touch path maps finger → buffer cell → term.select.
      assert.match(shim, /const LONG_PRESS_MS = 450;/);
      assert.match(shim, /const SLOP_PX = 12;/);
      assert.match(shim, /doc\.tcTouchSelectActive = true;/);
      assert.match(shim, /term\.select\(span\.col, span\.row, span\.length\);/);
      assert.match(shim, /term\.buffer\.active\.viewportY/);
      const touch = shim.slice(shim.indexOf('── Touch:'));
      assert.ok(!/forcedMouseEvent\(/.test(touch),
        'touch path must not dispatch synthetic mouse events (iterations 1-2 failed on-device)');
    });

    it('touchend stages the text and shows the Copy pill — NO direct clipboard write in touchend', () => {
      // Safari refused every touchend-time write on-device (iterations 4-6);
      // the pill's tap is a real click in the same document — the #435 flow.
      // #574 wrapped the touchend handler to add tap-to-focus: it must still
      // run endSelect FIRST, stay passive, and touchcancel stays bare endSelect.
      assert.match(shim, /doc\.addEventListener\('touchend', \(\) => \{\s*\n\s*endSelect\(\);/);
      assert.match(shim, /\}, \{ passive: true \}\);\s*\n\s*doc\.addEventListener\('touchcancel', endSelect, \{ passive: true \}\);/);
      assert.match(shim, /pendingCopyText = term\.getSelection\(\) \|\| '';/);
      assert.match(shim, /showPill\(lastPoint\);/);
      assert.match(shim, /doc\.tcTouchSelectActive = false;/);
      const endBlock = shim.slice(shim.indexOf('const endSelect'));
      assert.ok(!/tcCopyToClipboard\(/.test(endBlock.slice(0, endBlock.indexOf('doc.addEventListener'))),
        'no clipboard write inside endSelect (iterations 4-6 on-device failures)');
    });

    it('the Copy pill copies on CLICK in the iframe document and is state-driven (no timers)', () => {
      assert.match(shim, /pill\.addEventListener\('click', \(\) => \{/);
      assert.match(shim, /if \(text\) tcCopyToClipboard\(text, doc\);/);
      assert.match(helper, /async function tcCopyToClipboard\(text, targetDoc\)/);
      // 44px minimum touch target (mobile-first preference).
      assert.match(shim, /min-height:44px/);
      // Dismissal is state-driven: pill tap or the next terminal touch.
      assert.match(shim, /if \(e\.target === pill\) return;/);
      assert.match(shim, /hidePill\(\); \/\/ any new terminal touch dismisses a pending pill/);
      assert.ok(!/setTimeout\([^)]*hidePill/.test(shim), 'no timer-driven pill dismissal (#98/#268)');
    });

    it('the pill anchor resets per gesture and exists even for a no-drag long-press', () => {
      // Critic NOTE: stale lastPoint positioned the pill at the PREVIOUS
      // gesture's endpoint; a no-drag long-press had no anchor at all.
      assert.match(shim, /lastPoint = null;/);
      assert.match(shim, /lastPoint = pressPoint; \/\/ pill anchor even if the finger never moves/);
    });

    it('selection works in both drag directions (anchor swap before length math)', () => {
      // The math moved to the pure tcSelectionSpan (UI-9J3F) — pin the swap
      // + length formula at its new home and the shim's delegation to it.
      // Behavioral coverage lives in test/terminal-math.test.js.
      assert.match(helper, /if \(b\.row < a\.row \|\| \(b\.row === a\.row && b\.col < a\.col\)\)/);
      assert.match(helper, /\(b\.row - a\.row\) \* cols \+ \(b\.col - a\.col\) \+ 1/);
      assert.match(shim, /tcSelectionSpan\(from, to, term\.cols\)/);
      assert.match(shim, /term\.select\(span\.col, span\.row, span\.length\)/);
    });

    it('finger→cell mapping delegates to the pure tcCellFromPoint (clamp + viewportY)', () => {
      assert.match(shim, /tcCellFromPoint\(t, rect, term\.cols, term\.rows, viewportY\)/);
      assert.match(helper, /global\.tcCellFromPoint = tcCellFromPoint;/);
      assert.match(helper, /global\.tcSelectionSpan = tcSelectionSpan;/);
    });

    it('select-mode touchmove is non-passive and suppresses the pan', () => {
      const move = shim.slice(shim.indexOf("doc.addEventListener('touchmove'"));
      assert.match(move, /e\.preventDefault\(\);/);
      assert.match(move, /\{ passive: false \}/);
    });

    it('movement beyond the slop cancels the pending long-press (scroll intent wins)', () => {
      assert.match(shim, /> SLOP_PX/);
      assert.match(shim, /cancelPress\(\);/);
    });

    it('suppresses the iOS long-press callout on the terminal layers', () => {
      assert.match(shim, /-webkit-touch-callout: none/);
    });

    it('the touch-scroll shim (#443) yields while select mode is active', () => {
      assert.match(scrollShim, /if \(doc\.tcTouchSelectActive\) return;/);
    });
  });

  describe('call sites (all surfaces)', () => {
    it('the shared frame pipeline wires drag-copy from the terminal readiness retry', () => {
      // Since UI-4C7R the per-page retry loops are gone: tcWireTerminalFrame
      // owns the readiness retry and wires drag-copy once term.options exists.
      const pipeline = helper.slice(helper.indexOf('function tcWireTerminalFrame'));
      assert.match(pipeline, /tcWireTerminalDragCopy\(win, term, doc\);/);
    });

    it('both pages delegate their terminal frames to the shared pipeline', () => {
      assert.match(sessionJs, /window\.tcWireTerminalFrame\(window, frame,/);
      assert.match(uiJs, /window\.tcWireTerminalFrame\(window, frame,/);
    });

    it('the pipeline still arms the Mac force-selection option the synthetic altKey relies on', () => {
      // The option flip lives in tcEnableLocalSelectionOverride (#431), which
      // the pipeline runs on every frame before wiring drag-copy.
      const pipeline = helper.slice(helper.indexOf('function tcWireTerminalFrame'));
      assert.match(pipeline, /tcEnableLocalSelectionOverride\(term, doc\);/);
      assert.match(helper, /macOptionClickForcesSelection = true/);
    });
  });

  describe('propagation', () => {
    it('CACHE_NAME is bumped so active service workers pick up the new shell', () => {
      // Past the pre-#445 generation; the exact current pin lives in
      // test/master-drawer-frontend.test.js, which owns the latest bump (#331 slice 3).
      assert.match(sw, /const CACHE_NAME = 'tangleclaw-v3-\d+';/);
      assert.ok(!/const CACHE_NAME = 'tangleclaw-v3-3[123]';/.test(sw),
        'cache generation must be past v3-33 (the pre-#445 shell)');
    });
  });
});
