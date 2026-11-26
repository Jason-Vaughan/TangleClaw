'use strict';

/**
 * Interactive numbered choices, confirmation prompts, and "Chat about
 * this" / custom-response options (#3259, V6-003/V6-004, Car V662-W1-A) —
 * `public/v6-interactive-choices.js`, the canonical reference
 * implementation (not yet wired into the live page; see that file's own
 * header for why).
 *
 * Every real-CLI fixture below is lifted verbatim from a REAL captured
 * Claude Code TUI dialog already used elsewhere in this repo's own test
 * suite (cited per fixture), not invented for this file — same discipline
 * as `public/v6-interactive-choices.js`'s own header: audited against
 * real evidence, not guessed. Small tier: pure logic, no subprocess, no
 * database, no socket.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const choices = require('../public/v6-interactive-choices');

/** `public/v6-shell.js`'s own real `asksQuestion` shape, for multi-choice tests that need it. */
const asksQuestion = (q) => /\?\s*$/.test(String(q || '').trim());

describe('extractCliGates — real Claude Code dialog captures', () => {
  it('a plain yes/no "proceed?" confirmation, marker on option 1 (test/medusa-wake.test.js CLAUDE_DIALOG)', () => {
    const lines = ['', '  Do you want to proceed?', '❯ 1. Yes', '  2. No, and tell Claude what to do differently'];
    const gate = choices.extractCliGates(lines);
    assert.equal(gate.kind, 'permission');
    assert.equal(gate.text, 'Do you want to proceed?');
    assert.deepEqual(gate.options, [{ key: '1', label: 'Yes' }, { key: '2', label: 'No, and tell Claude what to do differently' }]);
    assert.equal(gate.inputMode, 'numbered');
  });

  it('a plain yes/no "proceed?" confirmation, marker on option 2 (test/medusa-wake.test.js MENU_2 shape)', () => {
    const lines = [' Do you want to proceed?', '   1. Yes', ' ❯ 2. No', '', ' Esc to cancel'];
    const gate = choices.extractCliGates(lines);
    assert.equal(gate.kind, 'permission');
    assert.deepEqual(gate.options, [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]);
  });

  it('the Bypass Permissions warning dialog — real labels, option 1 is "No, exit" not "Yes" (test/startup-dialog.test.js)', () => {
    const lines = [' WARNING: Claude Code running in Bypass Permissions mode', ' ❯ 1. No, exit', '   2. Yes, I accept', ' Enter to confirm · Esc to cancel'];
    const gate = choices.extractCliGates(lines);
    // The predecessor this module replaces hardcoded 'Allow'/'Always Allow'/'No'
    // for every such gate; the real labels here are neither of those.
    assert.deepEqual(gate.options, [{ key: '1', label: 'No, exit' }, { key: '2', label: 'Yes, I accept' }]);
    assert.equal(gate.text, 'WARNING: Claude Code running in Bypass Permissions mode');
  });

  it('a 3-option login-method picker — real option count and labels, not a hardcoded 3 (test/startup-dialog.test.js LOGIN_METHOD)', () => {
    const lines = [
      'Welcome to Claude Code v2.1.283', '', ' Claude Code can be used with your Claude subscription or billed based on API usage.', '',
      ' Select login method:', '',
      ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
      '   2. Anthropic Console account · API usage billing',
      '   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI'
    ];
    const gate = choices.extractCliGates(lines);
    assert.equal(gate.text, 'Select login method:');
    assert.equal(gate.options.length, 3);
    assert.equal(gate.options[0].label, 'Claude account with subscription · Pro, Max, Team, or Enterprise');
    assert.equal(gate.options[2].label, '3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI');
  });

  it('the folder-trust dialog — no numbers at all, inputMode "arrow" (test/api-sessions.test.js / test/startup-dialog.test.js)', () => {
    const lines = [' Accessing workspace:', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'];
    const gate = choices.extractCliGates(lines);
    assert.equal(gate.kind, 'trust');
    assert.equal(gate.inputMode, 'arrow');
    assert.deepEqual(gate.options, [{ key: 'exit', label: 'No, exit' }, { key: 'trust', label: 'Yes, I trust this folder' }]);
  });

  it('the folder-trust dialog with the marker on the OTHER option — order follows the real rows, not a fixed assumption', () => {
    const lines = [' Accessing workspace:', ' ❯ Yes, I trust this folder', '   No, exit', ' Enter to confirm · Esc to cancel'];
    const gate = choices.extractCliGates(lines);
    assert.deepEqual(gate.options, [{ key: 'trust', label: 'Yes, I trust this folder' }, { key: 'exit', label: 'No, exit' }]);
  });

  it('trust wording with no option rows visible yet (a narrow capture window) is honest about unknown options, never a guessed y/n', () => {
    const gate = choices.extractCliGates(['some earlier output', 'Do you trust the files in this folder?']);
    assert.equal(gate.kind, 'trust');
    assert.equal(gate.inputMode, 'arrow');
    assert.deepEqual(gate.options, []);
  });

  it('permission wording with no option rows visible yet is honest about unknown options too', () => {
    const gate = choices.extractCliGates(['Do you want to proceed?']);
    assert.equal(gate.kind, 'permission');
    assert.deepEqual(gate.options, []);
  });

  it('a question line directly above the menu with no blank line between them is never swallowed as an option row', () => {
    // #3259's own motivating bug class: a naive "collect any option-shaped
    // row" heuristic absorbed the question/warning line itself as a bogus
    // numbered entry when nothing separated it from the real menu.
    const gate = choices.extractCliGates(['  Do you want to proceed?', '❯ 1. Yes', '  2. No']);
    assert.equal(gate.options.length, 2);
    assert.ok(!gate.options.some((o) => /proceed/i.test(o.label)));
  });

  it('returns null when nothing in the lines looks like any kind of gate', () => {
    assert.equal(choices.extractCliGates(['hello', 'how are you', '']), null);
  });

  it('returns null for an empty or non-array input, never throws', () => {
    assert.equal(choices.extractCliGates(null), null);
    assert.equal(choices.extractCliGates([]), null);
    assert.equal(choices.extractCliGates(undefined), null);
  });
});

describe('extractMultiChoice', () => {
  it('extracts 1-4 numbered choices, same as the predecessor', () => {
    const result = choices.extractMultiChoice('Which approach?\n1. Fast\n2. Careful\n3. Hybrid\n4. Ask again later', asksQuestion);
    assert.deepEqual(result, { question: 'Which approach?', choices: ['Fast', 'Careful', 'Hybrid', 'Ask again later'], freeform: null });
  });

  it('extracts a 5th numbered choice (#3259: widened from the predecessor\'s 1-4 cap)', () => {
    const result = choices.extractMultiChoice('Which approach?\n1. A\n2. B\n3. C\n4. D\n5. E', asksQuestion);
    assert.equal(result.choices.length, 5);
    assert.equal(result.choices[4], 'E');
  });

  it('detects an explicit free-form/"chat about this" invitation stated right after the numbered list', () => {
    const result = choices.extractMultiChoice('Which approach?\n1. Fast\n2. Careful\nor type something else', asksQuestion);
    assert.deepEqual(result.freeform, { label: 'or type something else' });
  });

  it('freeform is null when no such invitation is stated, even though a UI always offers an implicit write-in', () => {
    const result = choices.extractMultiChoice('Which approach?\n1. Fast\n2. Careful', asksQuestion);
    assert.equal(result.freeform, null);
  });

  it('requires at least 2 sequential choices, same as the predecessor', () => {
    assert.equal(choices.extractMultiChoice('Only one option:\n1. Solo', asksQuestion), null);
  });

  it('never fires on a numbered ToDo list (#3105 regression, same guard as the predecessor)', () => {
    const result = choices.extractMultiChoice('YOUR TURN:\n1. Merge #171\n2. Read the testament plan', asksQuestion);
    assert.equal(result, null);
  });

  it('returns null for empty/non-string input', () => {
    assert.equal(choices.extractMultiChoice(null, asksQuestion), null);
    assert.equal(choices.extractMultiChoice('', asksQuestion), null);
  });
});

describe('cliGateMarkup', () => {
  it('renders one chip per REAL option, a "Chat about this" free-form escape hatch, and the Under the Hood link', () => {
    const gate = choices.extractCliGates([' WARNING: Claude Code running in Bypass Permissions mode', ' ❯ 1. No, exit', '   2. Yes, I accept', ' Enter to confirm · Esc to cancel']);
    const html = choices.cliGateMarkup(gate);
    assert.match(html, /data-gate-key="1"[^>]*>No, exit</);
    assert.match(html, /data-gate-key="2"[^>]*>Yes, I accept</);
    assert.match(html, /Chat about this/);
    assert.match(html, /Under the Hood/);
  });

  it('still renders the free-form and Under the Hood affordances when options is empty (no bare, action-less chips)', () => {
    const html = choices.cliGateMarkup({ kind: 'trust', text: 'Do you trust the files in this folder?', options: [], inputMode: 'arrow' });
    assert.doesNotMatch(html, /data-gate-key/);
    assert.match(html, /Chat about this/);
    assert.match(html, /trust the files/);
  });

  it('renders empty string for no gate, never throws', () => {
    assert.equal(choices.cliGateMarkup(null), '');
    assert.equal(choices.cliGateMarkup(undefined), '');
  });

  it('escapes HTML in a gate\'s own text and option labels', () => {
    const html = choices.cliGateMarkup({ kind: 'selector', text: '<script>x</script>', options: [{ key: '1', label: '<b>bold</b>' }], inputMode: 'numbered' });
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b>bold</b>'));
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('multiChoiceMarkup', () => {
  it('renders one numbered chip per real choice, plus a trailing Other button sized to the real count', () => {
    const choice = { question: 'Which?', choices: ['A', 'B', 'C'], freeform: null };
    const html = choices.multiChoiceMarkup(choice);
    assert.match(html, /data-choice-key="1"[^>]*>1</);
    assert.match(html, /data-choice-key="3"[^>]*>3</);
    assert.match(html, /4 \/ Other/);
  });

  it('labels the trailing button "Chat about this" instead of "N / Other" when the prompt explicitly invited a free-form answer', () => {
    const choice = { question: 'Which?', choices: ['A', 'B'], freeform: { label: 'or type something else' } };
    const html = choices.multiChoiceMarkup(choice);
    assert.match(html, /Chat about this/);
    assert.doesNotMatch(html, /3 \/ Other/);
  });

  it('renders empty string for no choice, never throws', () => {
    assert.equal(choices.multiChoiceMarkup(null), '');
    assert.equal(choices.multiChoiceMarkup(undefined), '');
  });

  it('escapes HTML in the question and choice text', () => {
    const html = choices.multiChoiceMarkup({ question: '<i>q</i>', choices: ['<b>x</b>'], freeform: null });
    assert.ok(!html.includes('<i>q</i>'));
    assert.ok(!html.includes('<b>x</b>'));
  });
});
