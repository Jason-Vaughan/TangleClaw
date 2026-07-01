'use strict';

/*
 * Regression tests for #435 — `tcCopyToClipboard` must copy on iOS Safari over
 * plain HTTP. The async Clipboard API is undefined outside a secure context
 * (e.g. `http://host:8080` over Tailscale), so the code falls back to
 * execCommand('copy'). The original fallback used a `readonly` textarea +
 * `.select()`, which copies NOTHING on iOS. The fix selects via a Range +
 * `setSelectionRange` on a non-readonly element.
 *
 * The helper is an IIFE that binds `tcCopyToClipboard` onto its global (the
 * sandbox `window`). We evaluate it into a vm sandbox with a fake DOM and
 * exercise both the secure-context and the plain-HTTP fallback branches.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HELPER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'api-helper.js'),
  'utf8'
);

/**
 * Build a fake `document` that records how the fallback selects text, plus the
 * textarea it creates. `execOk` controls what execCommand('copy') returns.
 * @param {boolean} execOk - Return value of document.execCommand('copy').
 * @returns {{ document: object, ta: object, appended: object[], removed: object[], execCalls: string[] }}
 */
function fakeDom(execOk) {
  const appended = [];
  const removed = [];
  const execCalls = [];
  const ta = {
    value: '',
    contentEditable: undefined,
    readOnly: undefined,
    style: {},
    _selectCalled: false,
    _selectionRange: null,
    select() { this._selectCalled = true; },
    setSelectionRange(start, end) { this._selectionRange = [start, end]; }
  };
  const document = {
    createElement() { return ta; },
    createRange() { return { selectNodeContents() {} }; },
    body: {
      appendChild(el) { appended.push(el); },
      removeChild(el) { removed.push(el); }
    },
    execCommand(cmd) { execCalls.push(cmd); return execOk; }
  };
  return { document, ta, appended, removed, execCalls };
}

/**
 * Evaluate api-helper.js into a sandbox whose `window` carries the given DOM
 * globals, and return the bound `tcCopyToClipboard`.
 * @param {object} windowProps - Properties placed on the sandbox `window`.
 * @returns {Function} tcCopyToClipboard
 */
function loadHelper(windowProps) {
  const sandbox = { window: Object.assign({}, windowProps) };
  // The fallback reads `global.getSelection`; expose it at window scope.
  if (windowProps.getSelection) sandbox.window.getSelection = windowProps.getSelection;
  vm.createContext(sandbox);
  vm.runInContext(HELPER_SRC, sandbox);
  return sandbox.window.tcCopyToClipboard;
}

describe('tcCopyToClipboard — iOS-safe plain-HTTP fallback (#435)', () => {
  it('uses the native Clipboard API in a secure context and skips execCommand', async () => {
    let written = null;
    const dom = fakeDom(true);
    const copy = loadHelper({
      isSecureContext: true,
      navigator: { clipboard: { writeText: async (t) => { written = t; } } },
      document: dom.document
    });

    const ok = await copy('hello');
    assert.equal(ok, true);
    assert.equal(written, 'hello');
    assert.deepEqual(dom.execCalls, [], 'must not fall back to execCommand when the secure API succeeds');
  });

  it('falls back on plain HTTP and selects via a Range + setSelectionRange, not readonly+select()', async () => {
    const dom = fakeDom(true);
    const copy = loadHelper({
      isSecureContext: false,       // plain HTTP over Tailscale
      navigator: {},                // no Clipboard API
      document: dom.document,
      getSelection: () => ({ removeAllRanges() {}, addRange() {} })
    });

    const ok = await copy('service-token-xyz');
    assert.equal(ok, true);
    assert.deepEqual(dom.execCalls, ['copy']);
    // iOS-critical assertions:
    assert.equal(dom.ta.readOnly, false, 'textarea must NOT be readonly (iOS)');
    assert.equal(dom.ta.contentEditable, 'true', 'textarea must be editable (iOS)');
    assert.deepEqual(dom.ta._selectionRange, [0, 'service-token-xyz'.length],
      'must select the full text via setSelectionRange (iOS)');
    assert.equal(dom.ta._selectCalled, false, 'must not rely on bare .select() (iOS no-op)');
    // Cleanup: the temp element is added and removed.
    assert.equal(dom.appended.length, 1);
    assert.equal(dom.removed.length, 1);
  });

  it('returns false when execCommand("copy") reports failure', async () => {
    const dom = fakeDom(false);
    const copy = loadHelper({
      isSecureContext: false,
      navigator: {},
      document: dom.document,
      getSelection: () => ({ removeAllRanges() {}, addRange() {} })
    });

    const ok = await copy('x');
    assert.equal(ok, false);
    assert.equal(dom.removed.length, 1, 'temp element still cleaned up on failure');
  });

  it('falls through to the execCommand path when the secure API rejects', async () => {
    const dom = fakeDom(true);
    const copy = loadHelper({
      isSecureContext: true,
      navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
      document: dom.document,
      getSelection: () => ({ removeAllRanges() {}, addRange() {} })
    });

    const ok = await copy('y');
    assert.equal(ok, true);
    assert.deepEqual(dom.execCalls, ['copy'], 'must recover via execCommand when writeText throws');
  });
});
