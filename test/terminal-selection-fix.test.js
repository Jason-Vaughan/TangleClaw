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
 * Fix: flip `macOptionClickForcesSelection` on the xterm instance inside the
 * terminal iframe, so ⌥+drag produces a native xterm selection, which ttyd's
 * copy-on-select writes to the BROWSER's clipboard (verified live: full text
 * with spaces, over plain HTTP, while the app holds mouse capture).
 *
 * Home: the override started life in public/session.js; UI-4C7R moved it to
 * the shared public/api-helper.js (tcEnableLocalSelectionOverride), where the
 * tcWireTerminalFrame readiness pipeline applies it to EVERY terminal surface
 * (session terminal, landing Master pane, in-session Master drawer). These
 * assertions are re-pinned at that new home — same contract, one copy.
 *
 * The pages drive real iframes/DOM at runtime with no headless harness in
 * this repo, so these are source-level structural assertions — the same
 * contract-lock-in pattern used by test/upload-modal-frontend.test.js and
 * test/openclaw-setup-readme.test.js. They fail loudly if the option flip or
 * its wiring into the frame pipeline is removed or weakened.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('terminal Option+drag local-selection override (#431)', () => {
  let helper;
  let sessionJs;
  let fnBody;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    helper = fs.readFileSync(path.join(pub, 'api-helper.js'), 'utf8');
    sessionJs = fs.readFileSync(path.join(pub, 'session.js'), 'utf8');
    // Isolate the tcEnableLocalSelectionOverride function body for tight assertions.
    const start = helper.indexOf('function tcEnableLocalSelectionOverride');
    assert.notEqual(start, -1, 'tcEnableLocalSelectionOverride must be defined in api-helper.js');
    // Body ends at the next function declaration.
    const after = helper.indexOf('function ', start + 1);
    fnBody = helper.slice(start, after === -1 ? helper.length : after);
  });

  it('defines tcEnableLocalSelectionOverride(term, doc) in the shared helper and exports it', () => {
    assert.match(helper, /function tcEnableLocalSelectionOverride\(term, doc\)/);
    assert.match(helper, /global\.tcEnableLocalSelectionOverride = tcEnableLocalSelectionOverride;/);
  });

  it('flips macOptionClickForcesSelection so ⌥+drag can bypass app mouse capture', () => {
    assert.match(fnBody, /macOptionClickForcesSelection\s*=\s*true/,
      'must set macOptionClickForcesSelection = true on the term options');
  });

  it('re-runs the copy inside a real mouseup gesture (Chrome refuses execCommand from async selection-change)', () => {
    assert.match(fnBody, /addEventListener\(['"]mouseup['"]/,
      'must hook mouseup for guaranteed transient user activation');
    assert.match(fnBody, /term\.getSelection\(\)/,
      'must no-op when there is no xterm selection (plain TUI-consumed drags)');
    assert.match(fnBody, /execCommand\(['"]copy['"]\)/,
      'must run execCommand copy inside the gesture');
    assert.match(fnBody, /tcCopyOnMouseUp/,
      'must guard against double-registering the listener');
  });

  it('is null-safe — a missing/not-ready term instance is a no-op, not a throw', () => {
    assert.match(fnBody, /term\s*&&\s*term\.options/,
      'must guard on term && term.options before writing');
    assert.match(fnBody, /try\s*\{/,
      'the gesture copy must swallow clipboard refusal (Cmd+C remains)');
  });

  it('is wired into every terminal frame by the shared readiness pipeline', () => {
    const pipeline = helper.slice(helper.indexOf('function tcWireTerminalFrame'));
    assert.match(pipeline, /tcEnableLocalSelectionOverride\(term, doc\);/,
      'tcWireTerminalFrame must apply the override once the term instance exists');
  });

  it('the per-page copy stays removed (UI-4C7R — one home, no drift)', () => {
    assert.ok(!/function enableLocalSelectionOverride\(/.test(sessionJs),
      'session.js must not re-grow its own copy of the override');
    assert.match(sessionJs, /window\.tcWireTerminalFrame\(window, frame,/,
      'session.js must delegate frame wiring to the shared pipeline');
  });

  it('does not reintroduce the disproven accessibility-overlay injection', () => {
    // The prior fix injected user-select:none onto .xterm-accessibility-tree —
    // an element that only exists when screenReaderMode is on (it never is in
    // TC's setup), so the injection was inert. Keep it out.
    assert.doesNotMatch(sessionJs, /injectTerminalSelectionFix/,
      'the inert accessibility-overlay injection must stay removed');
    assert.doesNotMatch(helper, /injectTerminalSelectionFix/,
      'the inert accessibility-overlay injection must not migrate to the helper');
  });
});
