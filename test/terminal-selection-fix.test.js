'use strict';

/*
 * Regression tests for the terminal copy-on-select fix.
 *
 * Bug: when the browser's accessibility mode is active (an assistive-tech app
 * such as a dictation tool flips it on system-wide), xterm builds a
 * `.xterm-accessibility-tree` overlay — the only `user-select: text` element in
 * the terminal — and the browser natively selects IT instead of xterm's canvas
 * selection. That native selection copies the transparent, debounce-rerendered
 * overlay and drops inter-word spaces, so copy-on-select pastes as a
 * run-together string with no spaces.
 *
 * Fix: `public/session.js` injects a persistent `<style>` rule into the terminal
 * iframe setting `user-select: none` on the accessibility overlay, so a mouse
 * drag falls through to xterm's own selection (themed highlight, full spaces).
 *
 * session.js drives a real iframe/DOM at runtime with no headless harness in
 * this repo, so these are source-level structural assertions — the same
 * contract-lock-in pattern used by test/upload-modal-frontend.test.js and
 * test/openclaw-setup-readme.test.js. They fail loudly if the injection, its
 * target selector, the `!important` override, or the wiring into the iframe
 * load flow is removed or weakened.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('terminal copy-on-select accessibility-overlay fix', () => {
  let js;
  let fnBody;

  before(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    // Isolate the injectTerminalSelectionFix function body for tight assertions.
    const start = js.indexOf('function injectTerminalSelectionFix');
    assert.notEqual(start, -1, 'injectTerminalSelectionFix must be defined');
    // Body ends at the next top-level function declaration.
    const after = js.indexOf('\nfunction ', start + 1);
    fnBody = js.slice(start, after === -1 ? js.length : after);
  });

  it('defines injectTerminalSelectionFix(frame)', () => {
    assert.match(js, /function injectTerminalSelectionFix\(frame\)/);
  });

  it('injects a style rule that disables selection on the accessibility overlay', () => {
    // Must target the accessibility tree (the sole user-select:text element)…
    assert.match(fnBody, /\.xterm-accessibility-tree/,
      'must target the .xterm-accessibility-tree overlay');
    // …and set user-select:none with !important to override xterm’s user-select:text.
    assert.match(fnBody, /user-select:\s*none\s*!important/i,
      'must set user-select:none !important to beat the bundle rule');
    assert.match(fnBody, /-webkit-user-select:\s*none\s*!important/i,
      'must include the -webkit- prefix for Safari/WebKit');
  });

  it('is idempotent — guards on a marker id so it never double-injects', () => {
    assert.match(fnBody, /tc-terminal-selection-fix/,
      'must use a stable marker id');
    assert.match(fnBody, /getElementById\(['"]tc-terminal-selection-fix['"]\)/,
      'must short-circuit when the marker style already exists');
  });

  it('is same-origin-safe — wrapped so a cross-origin webui iframe is skipped, not thrown', () => {
    assert.match(fnBody, /try\s*\{/, 'contentDocument access must be guarded');
    assert.match(fnBody, /contentDocument/, 'reads the iframe document to inject the style');
  });

  it('is wired into the terminal iframe load flow (setupTerminal)', () => {
    const setup = js.slice(js.indexOf('function setupTerminal'), js.indexOf('function setupTerminal') + 900);
    assert.match(setup, /injectTerminalSelectionFix\(frame\)/,
      'setupTerminal must call injectTerminalSelectionFix on the iframe');
  });
});
