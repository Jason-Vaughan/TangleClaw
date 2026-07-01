'use strict';

/*
 * Regression tests for the terminal remote-copy selection fix (#431).
 *
 * Bug: modern TUIs (Claude Code) enable xterm mouse tracking, so a mouse drag
 * in the web terminal is consumed by the app — it renders its own highlight
 * and copies the text on the HOST machine (pbcopy on the TC server + a tmux
 * buffer). The clipboard of the device the browser runs on never gets the
 * text, and ttyd's bundled xterm has no OSC 52 handler that could carry it.
 * On macOS there was NO working gesture: xterm's force-local-selection
 * modifier is Option(⌥)+drag, but it is gated behind
 * `macOptionClickForcesSelection`, which defaults to false (Shift+drag, the
 * non-mac equivalent, is ignored on Mac by design in xterm).
 *
 * Fix: `public/session.js` flips `macOptionClickForcesSelection` on the xterm
 * instance inside the terminal iframe, so ⌥+drag produces a native xterm
 * selection, which ttyd's copy-on-select writes to the BROWSER's clipboard
 * (verified live: full text with spaces, over plain HTTP, while the app holds
 * mouse capture).
 *
 * session.js drives a real iframe/DOM at runtime with no headless harness in
 * this repo, so these are source-level structural assertions — the same
 * contract-lock-in pattern used by test/upload-modal-frontend.test.js and
 * test/openclaw-setup-readme.test.js. They fail loudly if the option flip or
 * its wiring into the iframe load flow is removed or weakened.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('terminal Option+drag local-selection override (#431)', () => {
  let js;
  let fnBody;

  before(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    // Isolate the enableLocalSelectionOverride function body for tight assertions.
    const start = js.indexOf('function enableLocalSelectionOverride');
    assert.notEqual(start, -1, 'enableLocalSelectionOverride must be defined');
    // Body ends at the next top-level function declaration.
    const after = js.indexOf('\nfunction ', start + 1);
    fnBody = js.slice(start, after === -1 ? js.length : after);
  });

  it('defines enableLocalSelectionOverride(term)', () => {
    assert.match(js, /function enableLocalSelectionOverride\(term\)/);
  });

  it('flips macOptionClickForcesSelection so ⌥+drag can bypass app mouse capture', () => {
    assert.match(fnBody, /macOptionClickForcesSelection\s*=\s*true/,
      'must set macOptionClickForcesSelection = true on the term options');
  });

  it('is null-safe — a missing/not-ready term instance is a no-op, not a throw', () => {
    assert.match(fnBody, /term\s*&&\s*term\.options/,
      'must guard on term && term.options before writing');
  });

  it('is wired into the terminal iframe load flow (setupTerminal retry loop)', () => {
    const setup = js.slice(js.indexOf('function setupTerminal'), js.indexOf('function setupTerminal') + 900);
    assert.match(setup, /enableLocalSelectionOverride\(term\)/,
      'setupTerminal must call enableLocalSelectionOverride once the term instance exists');
  });

  it('does not reintroduce the disproven accessibility-overlay injection', () => {
    // The prior fix injected user-select:none onto .xterm-accessibility-tree —
    // an element that only exists when screenReaderMode is on (it never is in
    // TC's setup), so the injection was inert. Keep it out.
    assert.doesNotMatch(js, /injectTerminalSelectionFix/,
      'the inert accessibility-overlay injection must stay removed');
  });
});
