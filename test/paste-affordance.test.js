'use strict';

/*
 * Tests for #402 (UI-2P7T) — the iPhone paste affordance.
 *
 * iOS Safari offers no path to paste into xterm.js: no Cmd-V, and the native
 * long-press Paste callout cannot target xterm's hidden textarea. The fix is
 * a touch-gated Paste button in the session banner with two paths:
 *
 *   clipboard — secure context + Clipboard API: readText() inside the button
 *               gesture, then term.paste(text).
 *   catcher   — plain-HTTP (no Clipboard API), a rejected read, or an empty
 *               read: a modal with a REAL textarea (the one element iOS's
 *               native Paste callout can service), whose Insert funnels
 *               through the same term.paste().
 *
 * Everything funnels through term.paste() so bracketed-paste framing matches
 * desktop paste exactly — #192 (multi-line corruption in the ttyd pipe) is
 * inherited, not worsened; a raw term.write() of clipboard text would bypass
 * bracketed paste and make it worse. That invariant is pinned below.
 *
 * The path decision is the pure tcPastePath (TST-6L2P lift pattern); the
 * DOM wiring is pinned by source probes — the documented scope limit of the
 * zero-dep/no-browser-harness choice.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../public/api-helper.js');
const { tcPastePath } = globalThis;

/**
 * Extract a function's body from source by walking brace depth.
 * @param {string} src - File source
 * @param {string} marker - Text locating the function (e.g. 'function foo(')
 * @returns {string} the body including braces; '' when not found
 */
function functionBody(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return '';
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  return '';
}

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('Paste path decision (#402 — tcPastePath)', () => {
  it('secure context with the Clipboard API present reads the clipboard directly', () => {
    assert.equal(tcPastePath({ hasClipboardRead: true, secure: true }), 'clipboard');
  });

  it('plain HTTP (no secure context) takes the catcher even when the API object exists', () => {
    // http://host:8080 over Tailscale — navigator.clipboard is normally
    // undefined there, but belt-and-braces: secure:false alone must force
    // the catcher. The catcher is the DESIGNED path here, not an error.
    assert.equal(tcPastePath({ hasClipboardRead: true, secure: false }), 'catcher');
  });

  it('a missing Clipboard API takes the catcher regardless of context', () => {
    assert.equal(tcPastePath({ hasClipboardRead: false, secure: true }), 'catcher');
    assert.equal(tcPastePath({ hasClipboardRead: false, secure: false }), 'catcher');
  });
});

describe('Paste affordance wiring (#402 — source probes)', () => {
  let sessionJs, sessionHtml, swJs;

  before(() => {
    sessionJs = read('public/session.js');
    sessionHtml = read('public/session.html');
    swJs = read('public/sw.js');
  });

  it('the banner has a Paste button that ships hidden (touch reveals it)', () => {
    assert.match(sessionHtml, /id="pasteBtn"[^>]*\bhidden\b/s,
      'pasteBtn must ship hidden — desktop keeps Cmd-V and a clean banner');
    assert.ok(sessionJs.includes("'ontouchstart' in window") &&
      sessionJs.includes("pasteBtn').hidden = false"),
      'the reveal must be touch-gated');
  });

  it('paste funnels through term.paste(), never a raw write of the text (#192)', () => {
    const body = functionBody(sessionJs, 'function insertPasteText(');
    assert.ok(body, 'insertPasteText must exist');
    assert.ok(body.includes('term.paste('),
      "paste must use xterm's paste() so bracketed-paste framing matches desktop (#192)");
    assert.ok(!body.includes('term.write('),
      'a raw write of pasted text bypasses bracketed paste and worsens #192');
  });

  it('the clipboard read is gated through the tested tcPastePath decision', () => {
    const body = functionBody(sessionJs, 'async function pasteToTerminal(');
    assert.ok(body, 'pasteToTerminal must exist');
    assert.ok(body.includes('tcPastePath('),
      'the path decision must go through the tested pure helper');
    assert.ok(body.includes('isSecureContext'),
      'readText() only exists in secure contexts — the decision must see that');
  });

  it('every paste path is state-driven — no timers (#98/#268)', () => {
    for (const fn of ['async function pasteToTerminal(', 'function insertPasteText(',
      'function openPasteCatcher(', 'function closePasteCatcher(',
      'function insertFromPasteCatcher(']) {
      const body = functionBody(sessionJs, fn);
      assert.ok(body, `${fn}...} must exist`);
      assert.ok(!body.includes('setTimeout'),
        `${fn}...} must not use timers — timer-driven UI lifecycle is banned (#98/#268)`);
    }
  });

  it('the catcher modal exists with a real textarea (the iOS Paste callout target)', () => {
    assert.match(sessionHtml, /id="pasteCatcher"/,
      'the fallback modal must exist — plain-HTTP has no Clipboard API');
    assert.match(sessionHtml, /<textarea[^>]*id="pasteCatcherText"/s,
      'the catcher must be a REAL textarea; only that receives the native Paste callout');
  });

  it('the service worker cache name is at or past the #402 shell version', () => {
    // A floor, not an exact pin: later shell changes legitimately bump past
    // v3-49 (v3-50 landed with UI-8W3D the same day); regressing BELOW the
    // #402 version would resurrect the stale-shell invisibility.
    const m = swJs.match(/CACHE_NAME = 'tangleclaw-v3-(\d+)'/);
    assert.ok(m, 'CACHE_NAME must keep the tangleclaw-v3-N form');
    assert.ok(Number(m[1]) >= 49,
      'public/* shell changes are invisible to installed SWs without a CACHE_NAME bump');
  });
});
