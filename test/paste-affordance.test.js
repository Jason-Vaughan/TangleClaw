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
const { liftBody } = require('./helpers/lift');
const fs = require('node:fs');
const path = require('node:path');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

require('../public/api-helper.js');
const { tcPastePath, tcWireWindowsTerminalPaste, tcCreateMasterControlBar, tcMasterControlBarMarkup } = globalThis;

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
  let sessionJs, sessionHtml;

  before(() => {
    sessionJs = read('public/session.js');
    sessionHtml = read('public/session.html');
  });

  it('the banner has a Paste button that ships hidden (touch reveals it)', () => {
    assert.match(sessionHtml, /id="pasteBtn"[^>]*\bhidden\b/s,
      'pasteBtn must ship hidden — desktop keeps Cmd-V and a clean banner');
    assert.ok(sessionJs.includes("'ontouchstart' in window") &&
      sessionJs.includes("pasteBtn').hidden = false"),
      'the reveal must be touch-gated');
  });

  it('paste funnels through term.paste(), never a raw write of the text (#192)', () => {
    const body = liftBody(sessionJs, 'function insertPasteText(');
    assert.ok(body, 'insertPasteText must exist');
    assert.ok(body.includes('term.paste('),
      "paste must use xterm's paste() so bracketed-paste framing matches desktop (#192)");
    assert.ok(!body.includes('term.write('),
      'a raw write of pasted text bypasses bracketed paste and worsens #192');
  });

  it('the clipboard read is gated through the tested tcPastePath decision', () => {
    const body = liftBody(sessionJs, 'async function pasteToTerminal(');
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
      const body = liftBody(sessionJs, fn);
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
});

/**
 * Build a minimal fake terminal iframe document for `tcWireWindowsTerminalPaste`
 * (#2458): just enough `addEventListener`/keydown dispatch to drive the
 * capture-phase listener under test, without pulling in a browser.
 * @returns {{doc: object, term: object, fire: Function}}
 */
function fakeTerminalDoc() {
  const listeners = [];
  const textarea = { focused: false, focus() { this.focused = true; } };
  const element = { contains: (t) => t === textarea };
  const term = { textarea, element };
  const doc = {
    _tcWindowsPasteWired: false,
    activeElement: null,
    body: {},
    documentElement: {},
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture });
    }
  };
  const fire = (overrides) => {
    const event = Object.assign({
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
      isComposing: false, key: 'v', target: textarea,
      stopped: false,
      stopImmediatePropagation() { this.stopped = true; }
    }, overrides);
    listeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn(event));
    return event;
  };
  return { doc, term, fire };
}

describe('Windows Ctrl+V / dictation paste (#2458 — tcWireWindowsTerminalPaste)', () => {
  it('does nothing on a non-Windows client', () => {
    const { doc, term } = fakeTerminalDoc();
    const win = { navigator: { platform: 'MacIntel', userAgent: 'Macintosh' } };
    assert.equal(tcWireWindowsTerminalPaste(win, term, doc), false,
      'must not wire on Mac/Linux — xterm already owns Ctrl+V there');
  });

  it('a plain Ctrl+V on Windows stops xterm from ever seeing it, without canceling the browser paste', () => {
    const { doc, term, fire } = fakeTerminalDoc();
    const win = { navigator: { platform: 'Win32', userAgent: 'Windows NT 10.0' } };
    assert.equal(tcWireWindowsTerminalPaste(win, term, doc), true);
    const event = fire({ ctrlKey: true, key: 'v' });
    assert.equal(event.stopped, true,
      'stopImmediatePropagation must run so xterm never sends ^V');
    assert.equal(typeof event.preventDefault, 'undefined',
      'must never call preventDefault — that would cancel the native paste too');
  });

  it('focuses the textarea first when something else has focus', () => {
    const { doc, term, fire } = fakeTerminalDoc();
    const win = { navigator: { platform: 'Win32' } };
    doc.activeElement = {};
    tcWireWindowsTerminalPaste(win, term, doc);
    fire({ ctrlKey: true, key: 'v' });
    assert.equal(term.textarea.focused, true);
  });

  it('every other shortcut passes through untouched', () => {
    const { doc, term, fire } = fakeTerminalDoc();
    const win = { navigator: { platform: 'Win32' } };
    tcWireWindowsTerminalPaste(win, term, doc);
    for (const overrides of [
      { ctrlKey: true, key: 'c' }, // Ctrl+C
      { altKey: true, key: 'v' }, // Alt+V
      { metaKey: true, key: 'v' }, // Meta+V
      { ctrlKey: true, shiftKey: true, key: 'v' }, // Ctrl+Shift+V
      { ctrlKey: true, key: 'v', isComposing: true } // IME composing
    ]) {
      const event = fire(overrides);
      assert.equal(event.stopped, false, `${JSON.stringify(overrides)} must not be intercepted`);
    }
  });

  it('is detected via userAgentData when navigator.platform is frozen/empty (Win11 Chromium)', () => {
    const { doc, term, fire } = fakeTerminalDoc();
    const win = { navigator: { platform: '', userAgent: '', userAgentData: { platform: 'Windows' } } };
    assert.equal(tcWireWindowsTerminalPaste(win, term, doc), true);
    const event = fire({ ctrlKey: true, key: 'v' });
    assert.equal(event.stopped, true);
  });

  it('is idempotent per document — a second call does not register a second listener', () => {
    const { doc, term } = fakeTerminalDoc();
    const win = { navigator: { platform: 'Win32' } };
    let registrations = 0;
    const realAdd = doc.addEventListener.bind(doc);
    doc.addEventListener = (...args) => { registrations += 1; return realAdd(...args); };
    tcWireWindowsTerminalPaste(win, term, doc);
    tcWireWindowsTerminalPaste(win, term, doc);
    assert.equal(registrations, 1, 'the second call must see _tcWindowsPasteWired and skip registering again');
  });
});

describe('Master terminal Paste button (#2458)', () => {
  it('renders on both Master surfaces', () => {
    const panel = tcMasterControlBarMarkup('masterPanel');
    const drawer = tcMasterControlBarMarkup('masterDrawer');
    assert.match(panel, /id="masterPanelPasteBtn"[^>]*>Paste<\/button>/,
      'the dashboard Master panel must carry a Paste button');
    assert.match(drawer, /id="masterDrawerPasteBtn"[^>]*>Paste<\/button>/,
      'the in-session Master drawer must carry a Paste button');
  });

  /**
   * Mount a bar with a given frame registered at `frameId`, directly on the
   * `ids` map `makeDocument` hands back — the same seam the `mounted()`
   * helper above uses, just also pre-registering the Master terminal frame.
   * @returns {{doc: object, bar: object}}
   */
  function mountedWithFrame(prefix, frameId, frame, extraDeps) {
    const { doc, ids } = makeDocument([prefix + 'Bar']);
    withIdParsingInnerHTML(ids[prefix + 'Bar'], doc);
    ids[frameId] = frame;
    const bar = tcCreateMasterControlBar(Object.assign(
      { doc, rootId: prefix + 'Bar', prefix, title: 'M' }, extraDeps));
    bar.mount();
    return { doc, bar };
  }

  it('reads the clipboard and pastes into the surface\'s own terminal', async () => {
    const pasted = [];
    const term = { paste: (t) => pasted.push(t), focus: () => {} };
    const { doc, bar } = mountedWithFrame('masterPanel', 'masterFrame', { contentWindow: { term } });
    doc.defaultView = { navigator: { clipboard: { readText: async () => 'hello from clipboard' } } };
    await bar.paste();
    assert.deepEqual(pasted, ['hello from clipboard']);
  });

  it('falls back to a prompt when clipboard read is unavailable', async () => {
    const pasted = [];
    const term = { paste: (t) => pasted.push(t), focus: () => {} };
    const { doc, bar } = mountedWithFrame('masterDrawer', 'masterDrawerFrame', { contentWindow: { term } },
      { prompt: () => 'typed by hand' });
    doc.defaultView = { navigator: {} }; // no Clipboard API at all
    await bar.paste();
    assert.deepEqual(pasted, ['typed by hand']);
  });

  it('reports an error rather than throwing when the terminal is not ready', async () => {
    const { doc, bar } = mountedWithFrame('masterPanel', 'masterFrame', null);
    await bar.paste();
    const box = doc.getElementById('masterPanelError');
    assert.equal(box.hidden, false);
    assert.match(box.textContent, /not ready/);
  });

  it('clicking the button actually reaches pasteToMaster', async () => {
    const pasted = [];
    const term = { paste: (t) => pasted.push(t), focus: () => {} };
    const { doc } = mountedWithFrame('masterPanel', 'masterFrame', { contentWindow: { term } });
    doc.defaultView = { navigator: { clipboard: { readText: async () => 'from the button' } } };
    doc.getElementById('masterPanelPasteBtn').dispatch('click');
    // The click handler is async and `dispatch` does not await it (neither
    // does a real browser) — flush the microtask queue the single `await`
    // inside `pasteToMaster` schedules, same as #768's other behavioural
    // click tests settle on a real handler rather than a regex.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(pasted, ['from the button']);
  });
});
