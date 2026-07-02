'use strict';

/*
 * Regression tests for #443 — terminal touch-scroll was dead on iOS on BOTH
 * surfaces (session page + Master pane). Two defects in the old per-page
 * shims, verified on-device 2026-07-02:
 *
 *   1. Wrong target: listeners attached to `.xterm-viewport`, but xterm's
 *      screen layer (`.xterm-screen`, later in DOM order, positioned) paints
 *      above it — touches never reached the listeners.
 *   2. Passive listeners: `{ passive: true }` means even a firing listener
 *      cannot stop iOS's native pan from claiming the gesture, so the OUTER
 *      page scrolled instead of the terminal.
 *
 * The fix is one shared helper (`tcWireTerminalTouchScroll` in the
 * both-pages base `public/api-helper.js`, home of the #430 copy helper):
 * listen on `.xterm-screen`, non-passive touchmove + preventDefault,
 * `touch-action: none` injection, drag → synthetic WheelEvents in line
 * batches (the desktop wheel pipeline through tmux copy-mode).
 * Source-level structural assertions — same pattern as
 * test/master-pane-frontend.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Terminal touch-scroll shim (#443)', () => {
  let helper;
  let sessionJs;
  let uiJs;
  let sw;
  /** The api-helper.js shim function body, isolated for targeted asserts. */
  let shim;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    helper = fs.readFileSync(path.join(pub, 'api-helper.js'), 'utf8');
    sessionJs = fs.readFileSync(path.join(pub, 'session.js'), 'utf8');
    uiJs = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');

    const start = helper.indexOf('function tcWireTerminalTouchScroll');
    assert.ok(start > -1, 'api-helper.js defines tcWireTerminalTouchScroll');
    const end = helper.indexOf('global.tcCreateApi =');
    assert.ok(end > start, 'shim body precedes the global exports');
    shim = helper.slice(start, end);
  });

  describe('the shared helper (api-helper.js)', () => {
    it('is exposed on window alongside the other shared helpers', () => {
      assert.match(helper, /global\.tcWireTerminalTouchScroll = tcWireTerminalTouchScroll;/);
    });

    it('targets the element touches actually hit — .xterm-screen, NOT the viewport (#443 root cause 1)', () => {
      assert.match(shim, /querySelector\('\.xterm-screen'\)/);
      // Pin the target chain explicitly — the viewport must never be a
      // listener target (touches don't land there; that was root cause 1).
      assert.match(shim, /const target = doc\.querySelector\('\.xterm-screen'\)\s*\|\|\s*doc\.querySelector\('\.xterm'\)\s*\|\|\s*doc\.body;/);
      assert.match(shim, /target\.addEventListener\('touchstart'/);
      assert.match(shim, /target\.addEventListener\('touchmove'/);
      assert.ok(!/viewport\.addEventListener/.test(shim),
        'listeners must not attach to .xterm-viewport (touches never land there)');
    });

    it('touchmove is NON-passive and prevents the native pan (#443 root cause 2)', () => {
      assert.match(shim, /e\.preventDefault\(\);/);
      assert.match(shim, /\{ passive: false \}/);
      // touchstart stays passive — it only samples the start position.
      assert.match(shim, /touchstart'[\s\S]{0,200}?\{ passive: true \}/);
    });

    it('injects touch-action: none so iOS never contests the gesture', () => {
      assert.match(shim, /touch-action: none/);
      assert.match(shim, /doc\.head\.appendChild\(style\)/);
    });

    it('scrolls by synthesizing WHEEL events — the proven desktop pipeline, not xterm buffer pokes', () => {
      // Iteration 2 (on-device): term.scrollLines moved nothing — with tmux
      // `mouse on`, real scrolling routes through xterm's wheel handler to
      // tmux copy-mode. The synthetic wheel inherits that mode handling.
      assert.match(shim, /new iframeWin\.WheelEvent\('wheel',/);
      assert.match(shim, /deltaY: linesToScroll \* LINE_HEIGHT,/);
      assert.match(shim, /deltaMode: 0,/);
      assert.match(shim, /bubbles: true,/);
      assert.match(shim, /\.dispatchEvent\(wheel\)/);
      assert.match(shim, /const LINE_HEIGHT = 18;/);
      assert.ok(!/term\.scrollLines\(/.test(shim),
        'the dead scrollLines primitive (#443 iteration 1) must not return');
    });

    it('single-touch guard runs BEFORE preventDefault so pinch-zoom is unaffected', () => {
      const move = shim.slice(shim.indexOf("addEventListener('touchmove'"));
      const guard = move.indexOf('e.touches.length !== 1');
      const prevent = move.indexOf('e.preventDefault()');
      assert.ok(guard > -1 && prevent > guard,
        'multi-touch must return before preventDefault');
    });

    it('is idempotent per iframe document and feature-gated to touch devices', () => {
      assert.match(shim, /doc\.tcTouchScrollWired/);
      assert.match(shim, /'ontouchstart' in win/);
    });
  });

  describe('call sites (both surfaces delegate — no per-page duplicates)', () => {
    it('session.js wires from the terminal readiness retry, not iframe load', () => {
      assert.match(sessionJs, /window\.tcWireTerminalTouchScroll\(window, term, frame\.contentDocument\)/);
      assert.ok(!/function setupTerminalTouchScroll\(/.test(sessionJs),
        'the dead load-time viewport shim (#443) must not return');
      assert.ok(!/setupTerminalTouchScroll\(\);/.test(sessionJs),
        'no orphaned call to the removed shim');
    });

    it('ui.js Master pane delegates to the same shared helper', () => {
      assert.match(uiJs, /window\.tcWireTerminalTouchScroll\(window, term, doc\)/);
      assert.ok(!/function wireMasterTouchScroll\(/.test(uiJs),
        'the per-pane duplicate must not return');
    });
  });

  describe('propagation', () => {
    it('CACHE_NAME is bumped so active service workers pick up the fixed shell', () => {
      assert.match(sw, /const CACHE_NAME = 'tangleclaw-v3-33';/);
    });

    it('api-helper.js stays network-first (a stale copy would resurrect the dead shim)', () => {
      assert.match(sw, /'\/api-helper\.js',/);
    });
  });
});
