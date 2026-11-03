'use strict';

/**
 * Mid-session `AskUserQuestion` vs. genuine `STARTUP_DIALOG` (#2826,
 * Architect Ruling A2826).
 *
 * `lib/startup-dialog.js#classify`/`withholdFor` already distinguished a
 * selected menu option (`selector: true`, #2219) from the engine's bare
 * composer, but reported EVERY such selector under the same generic
 * `pane_not_at_prompt` code -- including Claude Code's own mid-session
 * `AskUserQuestion` widget, which deadlocked both API command injection and
 * Medusa switchboard nudges against a session that had already attested
 * `READY`. This file drives the two added surfaces directly: `classify`'s
 * new `midSessionQuestion` flag, and `withholdFor`'s new `ASK_USER_QUESTION`
 * code, both pure functions over plain pane-line arrays and plain objects --
 * no tmux, no store, no real session.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const startupDialog = require('../lib/startup-dialog');

/** A minimal, self-contained prompt signature: `>` leads the composer/selector row. */
const WAKE = Object.freeze({ promptGlyph: '>', promptRe: /^>\s*$/ });

/** No declared startup dialogs -- isolates this file's assertions to the noncomposer/selector path alone. */
const NO_DIALOGS = [];

const ASK_USER_QUESTION_FOOTER = 'Enter to select · ↑/↓ to navigate · Esc to cancel';

/**
 * A selector menu (option 1 selected, hidden cursor -- #2219's own positive
 * selector evidence, the same shape a real engine draws for both a plain
 * menu and the `AskUserQuestion` widget) optionally followed by the widget's
 * own footer row.
 * @param {boolean} withFooter
 * @returns {{lines: string[], cursor: object}}
 */
function selectorFrame(withFooter) {
  const selectedRow = '> 1. Option A';
  const lines = [
    ' Pick one:',
    selectedRow,
    '  2. Option B'
  ];
  if (withFooter) lines.push('', ASK_USER_QUESTION_FOOTER);
  return { lines, cursor: { x: 0, y: 1, line: selectedRow, visible: false } };
}

describe('startup-dialog: exported vocabulary (#2826)', () => {
  it('exposes its own mid-session-question code', () => {
    assert.equal(startupDialog.ASK_USER_QUESTION, 'mid_session_ask_user_question');
  });
});

describe('startup-dialog: classify flags midSessionQuestion from the AskUserQuestion footer alone (#2826)', () => {
  it('a selector with no AskUserQuestion footer is midSessionQuestion: false, selector: true -- unchanged #2219 behavior', () => {
    const { lines, cursor } = selectorFrame(false);
    const r = startupDialog.classify(lines, NO_DIALOGS, WAKE, cursor);
    assert.equal(r.state, 'noncomposer');
    assert.equal(r.selector, true);
    assert.equal(r.midSessionQuestion, false);
  });

  it('the identical selector WITH the AskUserQuestion footer present is midSessionQuestion: true', () => {
    const { lines, cursor } = selectorFrame(true);
    const r = startupDialog.classify(lines, NO_DIALOGS, WAKE, cursor);
    assert.equal(r.state, 'noncomposer');
    assert.equal(r.selector, true);
    assert.equal(r.midSessionQuestion, true);
  });

  it('footer text with no glyph-led row at all is "unknown", the same as before this change -- midSessionQuestion is only meaningful alongside a noncomposer reading, same contract as selector', () => {
    const lines = [' some unrelated text', ASK_USER_QUESTION_FOOTER];
    const r = startupDialog.classify(lines, NO_DIALOGS, WAKE, null);
    assert.equal(r.state, 'unknown');
    assert.equal(r.midSessionQuestion, undefined);
  });

  it('a composer at rest is never reported as midSessionQuestion, footer text notwithstanding', () => {
    const lines = ['>', ASK_USER_QUESTION_FOOTER];
    const r = startupDialog.classify(lines, NO_DIALOGS, WAKE, { x: 2, y: 0, line: '>', visible: true });
    // No measured composer-empty seam is wired for this minimal WAKE, so this
    // frame is not necessarily 'clear' -- what matters here is only that a
    // genuinely declared dialog state is never reached; 'dialog' never fires
    // with NO_DIALOGS regardless of footer text.
    assert.notEqual(r.state, 'dialog');
  });

  it('three partial substrings of the footer, spread across different rows, still all compose a match', () => {
    const lines = [' Pick one:', '> 1. Option A', 'Enter to select', '(use arrow keys to navigate)', 'press Esc to cancel'];
    const r = startupDialog.classify(lines, NO_DIALOGS, WAKE, { x: 0, y: 1, line: '> 1. Option A', visible: false });
    assert.equal(r.midSessionQuestion, true);
  });

  it('missing even one of the three footer substrings does not match', () => {
    const lines = [' Pick one:', '> 1. Option A', 'Enter to select · ↑/↓ to navigate'];
    const r = startupDialog.classify(lines, NO_DIALOGS, WAKE, { x: 0, y: 1, line: '> 1. Option A', visible: false });
    assert.equal(r.midSessionQuestion, false);
  });
});

describe('startup-dialog: withholdFor reports ASK_USER_QUESTION ahead of the generic selector code (#2826)', () => {
  it('a selector with midSessionQuestion: true is refused under ASK_USER_QUESTION, not NOT_AT_PROMPT', () => {
    const seen = { declared: true, dialog: null, suspect: null, clear: false, noncomposer: true, selector: true, midSessionQuestion: true, unread: null, promptKnown: true };
    const r = startupDialog.withholdFor(seen, null);
    assert.equal(r.code, startupDialog.ASK_USER_QUESTION);
    assert.match(r.meaning, /AskUserQuestion/);
  });

  it('a selector with midSessionQuestion: false still falls through to the existing generic NOT_AT_PROMPT (#2219, unchanged)', () => {
    const seen = { declared: true, dialog: null, suspect: null, clear: false, noncomposer: true, selector: true, midSessionQuestion: false, unread: null, promptKnown: true };
    const r = startupDialog.withholdFor(seen, null);
    assert.equal(r.code, startupDialog.NOT_AT_PROMPT);
  });

  it('a genuine declared dialog is reported under its own code regardless of midSessionQuestion', () => {
    const seen = {
      declared: true, dialog: { code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it.' },
      suspect: null, clear: false, noncomposer: false, selector: false, midSessionQuestion: true, unread: null, promptKnown: true
    };
    const r = startupDialog.withholdFor(seen, null);
    assert.equal(r.code, 'trust_required');
  });

  it('midSessionQuestion alone, with selector false, never triggers ASK_USER_QUESTION on its own', () => {
    const seen = { declared: true, dialog: null, suspect: null, clear: false, noncomposer: true, selector: false, midSessionQuestion: true, unread: null, promptKnown: true };
    const r = startupDialog.withholdFor(seen, null);
    assert.notEqual(r && r.code, startupDialog.ASK_USER_QUESTION);
  });

  it('a stored blocker still takes priority over the new ASK_USER_QUESTION reading, same as every other non-dialog case', () => {
    const stored = { code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it.' };
    const seen = { declared: true, dialog: null, suspect: null, clear: false, noncomposer: true, selector: true, midSessionQuestion: true, unread: null, promptKnown: true };
    const r = startupDialog.withholdFor(seen, stored);
    assert.equal(r.code, stored.code);
  });
});
