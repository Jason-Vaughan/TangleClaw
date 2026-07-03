'use strict';

/*
 * Behavioral tests for the shared terminal-frame helpers (UI-4C7R):
 * TC_XTERM_THEMES / tcApplyTerminalTheme / tcEnableLocalSelectionOverride /
 * tcWireTerminalFrame in public/api-helper.js.
 *
 * api-helper.js is a plain browser script, but its IIFE binds to globalThis
 * when `window` is absent — so require()ing it in Node exposes the real
 * helpers for direct exercise with fake frame/term/doc objects. This covers
 * the behavior the structural greps can't prove: theme fallback, the
 * readiness retry, and the copy-on-mouseup gesture path.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

require('../public/api-helper.js');

const {
  TC_XTERM_THEMES,
  tcApplyTerminalTheme,
  tcEnableLocalSelectionOverride,
  tcWireTerminalFrame
} = globalThis;

/**
 * Build a minimal fake xterm Terminal instance.
 * @param {string} [selection] - What getSelection() should return
 * @returns {object} fake term with an options bag
 */
function makeTerm(selection) {
  return {
    options: {},
    getSelection: () => selection || ''
  };
}

/**
 * Build a minimal fake iframe document good enough for the wire-time paths
 * of the shared helpers (style injection + listener registration).
 * @returns {object} fake Document with listener capture + execCommand recorder
 */
function makeDoc() {
  const doc = {
    listeners: {},
    execCommands: [],
    addEventListener(type, cb) {
      (doc.listeners[type] = doc.listeners[type] || []).push(cb);
    },
    createElement: () => ({
      style: {},
      textContent: '',
      setAttribute() {},
      addEventListener() {}
    }),
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    querySelector: () => null,
    execCommand(cmd) { doc.execCommands.push(cmd); return true; },
    defaultView: null
  };
  return doc;
}

/**
 * Build a minimal fake parent window (no touch support, capturable timers).
 * @returns {object} fake Window with a timeouts recorder
 */
function makeWin() {
  const win = {
    timeouts: [],
    setTimeout(cb, ms) { win.timeouts.push({ cb, ms }); return win.timeouts.length; }
  };
  return win;
}

/**
 * Build a minimal fake iframe element wrapping a term/doc pair.
 * @param {object|null} term - The fake term contentWindow should expose
 * @param {object} doc - The fake contentDocument
 * @returns {object} fake HTMLIFrameElement with listener capture
 */
function makeFrame(term, doc) {
  const frame = {
    listeners: {},
    dataset: {},
    addEventListener(type, cb) {
      (frame.listeners[type] = frame.listeners[type] || []).push(cb);
    },
    contentWindow: { term },
    contentDocument: doc
  };
  return frame;
}

describe('TC_XTERM_THEMES (shared palette)', () => {
  it('exposes all three operator themes with full color specs', () => {
    for (const key of ['dark', 'light', 'high-contrast']) {
      assert.ok(TC_XTERM_THEMES[key], `palette has ${key}`);
      assert.ok(TC_XTERM_THEMES[key].background, `${key} has background`);
      assert.ok(TC_XTERM_THEMES[key].foreground, `${key} has foreground`);
      assert.ok(TC_XTERM_THEMES[key].selectionBackground, `${key} has selectionBackground`);
    }
  });
});

describe('tcApplyTerminalTheme', () => {
  it('applies the named palette to term.options.theme', () => {
    const term = makeTerm();
    assert.equal(tcApplyTerminalTheme(term, 'light'), true);
    assert.equal(term.options.theme, TC_XTERM_THEMES.light);
  });

  it('falls back to dark for unknown theme names', () => {
    const term = makeTerm();
    tcApplyTerminalTheme(term, 'solarized-nope');
    assert.equal(term.options.theme, TC_XTERM_THEMES.dark);
  });

  it('is null-safe: missing or not-ready term is a no-op', () => {
    assert.equal(tcApplyTerminalTheme(null, 'dark'), false);
    assert.equal(tcApplyTerminalTheme({}, 'dark'), false);
  });
});

describe('tcEnableLocalSelectionOverride (#431)', () => {
  it('flips macOptionClickForcesSelection and registers the mouseup re-copy once', () => {
    const term = makeTerm('selected text');
    const doc = makeDoc();
    tcEnableLocalSelectionOverride(term, doc);
    tcEnableLocalSelectionOverride(term, doc);
    assert.equal(term.options.macOptionClickForcesSelection, true);
    assert.equal(doc.listeners.mouseup.length, 1, 'listener registered exactly once');
  });

  it('mouseup copies when xterm holds a selection, no-ops when it does not', () => {
    const doc = makeDoc();
    tcEnableLocalSelectionOverride(makeTerm('grabbed'), doc);
    doc.listeners.mouseup[0]();
    assert.deepEqual(doc.execCommands, ['copy']);

    const doc2 = makeDoc();
    tcEnableLocalSelectionOverride(makeTerm(''), doc2);
    doc2.listeners.mouseup[0]();
    assert.deepEqual(doc2.execCommands, [], 'plain TUI-consumed drags must not copy');
  });
});

describe('tcWireTerminalFrame (shared readiness pipeline)', () => {
  let win;

  beforeEach(() => {
    win = makeWin();
  });

  it('returns false without a window or frame', () => {
    assert.equal(tcWireTerminalFrame(null, makeFrame(makeTerm(), makeDoc()), () => 'dark'), false);
    assert.equal(tcWireTerminalFrame(win, null, () => 'dark'), false);
  });

  it('wires theme + selection override + drag-copy once the term is ready at load', () => {
    const term = makeTerm();
    const doc = makeDoc();
    const frame = makeFrame(term, doc);
    assert.equal(tcWireTerminalFrame(win, frame, () => 'light'), true);
    frame.listeners.load[0]();

    assert.equal(term.options.theme, TC_XTERM_THEMES.light, 'getTheme() result applied');
    assert.equal(term.options.macOptionClickForcesSelection, true, '#431 override applied');
    assert.equal(doc.tcCopyOnMouseUp, true, 'mouseup re-copy registered');
    assert.equal(doc.tcDragCopyWired, true, '#445 drag-copy wired');
    assert.equal(term.options.altClickMovesCursor, false, 'rewritten clicks cannot become arrow spam');
    assert.equal(win.timeouts.length, 0, 'no retry needed when term is ready');
  });

  it('retries on the parent window timer until ttyd initializes the term', () => {
    const doc = makeDoc();
    const frame = makeFrame(null, doc); // xterm not initialized yet
    tcWireTerminalFrame(win, frame, () => 'dark');
    frame.listeners.load[0]();
    assert.equal(win.timeouts.length, 1, 'a retry is scheduled');
    assert.equal(win.timeouts[0].ms, 250, 'retry cadence matches ttyd init latency');

    // ttyd finishes initializing between retries.
    const term = makeTerm();
    frame.contentWindow.term = term;
    win.timeouts[0].cb();
    assert.equal(term.options.theme, TC_XTERM_THEMES.dark, 'wired on a later attempt');
    assert.equal(win.timeouts.length, 1, 'no further retries after success');
  });

  it('survives cross-origin frames (webui sessions): access throws, never escapes', () => {
    const frame = {
      listeners: {},
      addEventListener(type, cb) {
        (frame.listeners[type] = frame.listeners[type] || []).push(cb);
      },
      get contentWindow() { throw new Error('SecurityError: cross-origin'); },
      get contentDocument() { throw new Error('SecurityError: cross-origin'); }
    };
    tcWireTerminalFrame(win, frame, () => 'dark');
    assert.doesNotThrow(() => frame.listeners.load[0]());
    assert.equal(win.timeouts.length, 1, 'falls into the retry path instead of throwing');
  });

  it('gives up after the retry budget instead of spinning forever', () => {
    const frame = makeFrame(null, makeDoc());
    tcWireTerminalFrame(win, frame, () => 'dark');
    frame.listeners.load[0]();
    // Drain every scheduled retry; the term never appears.
    let guard = 0;
    while (win.timeouts.length > 0 && guard < 100) {
      win.timeouts.shift().cb();
      guard += 1;
    }
    assert.ok(guard < 25, `retry budget is bounded (drained ${guard} retries)`);
  });
});
