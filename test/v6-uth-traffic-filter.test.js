'use strict';

/**
 * Peek Under the Hood's traffic filter (#3261, V6-006, Car V662-W1-B) —
 * `public/v6-uth-filter.js`, the canonical reference implementation (not
 * yet wired into the live page; see that file's own header for why).
 * Small tier: pure logic, no subprocess, no database, no socket.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uth = require('../public/v6-uth-filter');

/**
 * `public/v6-shell.js`'s own, separately-maintained copy of this logic
 * (`global.tcV6FilterPeekTrafficLines`), loaded the same way
 * `test/v6-b1-ui-shell.test.js` does (`vm.runInContext`, no jsdom). This
 * module's own header explains why the two copies exist instead of one
 * wired dependency; the parity tests below are what keeps them from
 * silently drifting apart.
 * @returns {Function}
 */
function loadShellFilter() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-shell.js'), 'utf8');
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.tcV6FilterPeekTrafficLines;
}

/**
 * `tcV6ExtractLiveTurns` from the real shipped `public/v6-shell.js`, the
 * same `vm.runInContext` pattern {@link loadShellFilter} uses. This
 * module's test file is where the #3291 wrapped-URL-stitching fix landed
 * (same car, same PR) — its own natural home, `test/v6-b1-ui-shell.test.js`
 * (`describe('tcV6ExtractLiveTurns unwraps soft-wrapped terminal lines
 * into flowing prose (#3167)')`), is a sibling car's file, out of this
 * car's scope to add to.
 * @returns {Function}
 */
function loadExtractLiveTurns() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-shell.js'), 'utf8');
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.tcV6ExtractLiveTurns;
}

/** A real switchboard wake notice, hard-wrapped at ~76 columns with NO
 * indentation on its continuation lines — the common case a plain
 * terminal actually produces. */
const WRAPPED_NOTICE = [
  '[TangleClaw Switchboard] You have 3 unread Medusa message(s): tc message',
  'read. Reply where an answer is needed, BEFORE marking it handled: tc',
  'message send --in-reply-to <message-id> <sender-workspace-id> "<reply>";',
  'then tc message ack <message-id>. The initiator closes the exchange, so no',
  'answer leaves them blocked; tc message owed lists what you owe. Never use',
  '/clear as an acknowledgement. Without tc: API at',
  'http://localhost:3102/api/sessions/TC-Lane-B/medusa: GET /messages; POST',
  '/send (inReplyTo) and /read need launch headers.'
];

describe('filterPeekTrafficLines: the #3261 audit fix (unindented wrapped continuations)', () => {
  it('drops every wrapped continuation line of a notice, indented or not', () => {
    const lines = ['before', ...WRAPPED_NOTICE, 'after'];
    assert.deepEqual(uth.filterPeekTrafficLines(lines, true), ['before', 'after']);
  });

  it('drops the wake-ref suffix variant the same way', () => {
    const withRef = [...WRAPPED_NOTICE];
    withRef[withRef.length - 1] += ' (wake ref a1b2c3d4e5f6)';
    const lines = ['before', ...withRef, 'after'];
    assert.deepEqual(uth.filterPeekTrafficLines(lines, true), ['before', 'after']);
  });

  it('does not clip the legitimate line immediately after a notice ends', () => {
    const lines = [...WRAPPED_NOTICE, 'Legitimate assistant prose line right after.'];
    assert.deepEqual(uth.filterPeekTrafficLines(lines, true), ['Legitimate assistant prose line right after.']);
  });

  it('a line that stops matching partway through falls back to normal processing of THAT line, not loss', () => {
    const lines = [
      '[TangleClaw Switchboard] You have 3 unread Medusa message(s): tc message',
      'this does not continue the notice at all'
    ];
    assert.deepEqual(uth.filterPeekTrafficLines(lines, true), ['this does not continue the notice at all']);
  });

  it('filters more than one distinct wake notice in the same pane buffer', () => {
    const lines = [...WRAPPED_NOTICE, 'middle line', ...WRAPPED_NOTICE, 'tail line'];
    assert.deepEqual(uth.filterPeekTrafficLines(lines, true), ['middle line', 'tail line']);
  });

  it('hideTraffic=false returns every line unchanged, notice included', () => {
    const lines = [...WRAPPED_NOTICE, 'after'];
    assert.deepEqual(uth.filterPeekTrafficLines(lines, false), lines);
  });

  it('a null/non-array lines list is treated as empty', () => {
    assert.deepEqual(uth.filterPeekTrafficLines(null, true), []);
    assert.deepEqual(uth.filterPeekTrafficLines(undefined, true), []);
  });
});

describe('TC_MESSAGE_COMMAND_RE and MEDUSA_RECEIPT_RE', () => {
  for (const cmd of ['tc message read', 'tc message send', 'tc message ack', 'tc message owed']) {
    it(`matches "${cmd}", with or without a leading "$ ", case-insensitively`, () => {
      assert.match(cmd, uth.TC_MESSAGE_COMMAND_RE);
      assert.match(`$ ${cmd}`, uth.TC_MESSAGE_COMMAND_RE);
      assert.match(cmd.toUpperCase(), uth.TC_MESSAGE_COMMAND_RE);
    });
  }

  it('does not match an unrelated line that merely starts with "tc"', () => {
    assert.doesNotMatch('tc workload set working', uth.TC_MESSAGE_COMMAND_RE);
  });

  for (const line of [
    'Message to tc-lane-pm-3cc41bf8: received. Exchange mx_abc123 (normal, delivered).',
    'Reported 3 message id(s) handled — they leave your inbox.',
    'Your switchboard inbox is empty.',
    '3 message(s) in your inbox:',
    'Reading does NOT mark these handled. Reply first where an answer is needed.'
  ]) {
    it(`MEDUSA_RECEIPT_RE matches: ${JSON.stringify(line)}`, () => {
      assert.match(line, uth.MEDUSA_RECEIPT_RE);
    });
  }

  it('MEDUSA_RECEIPT_RE does not match ordinary prose that happens to contain a digit', () => {
    assert.doesNotMatch('I read 3 files and found the bug.', uth.MEDUSA_RECEIPT_RE);
  });
});

describe('parity with public/v6-shell.js\'s own copy, the two files this car keeps in sync by hand', () => {
  const shellFilter = loadShellFilter();

  for (const [name, lines] of Object.entries({
    'a wrapped notice plus legitimate before/after lines': ['before', ...WRAPPED_NOTICE, 'after'],
    'two distinct notices back to back': [...WRAPPED_NOTICE, 'middle', ...WRAPPED_NOTICE, 'tail'],
    'a notice that breaks mid-way': ['[TangleClaw Switchboard] You have 1 unread Medusa message(s): tc message', 'totally unrelated line'],
    'no notice at all': ['just', 'ordinary', 'lines'],
    'a tc message command echo and a receipt line': ['$ tc message read', 'Message to x: received. Exchange mx_1 (normal, delivered).', 'kept']
  })) {
    it(`matches v6-shell.js's output for: ${name}`, () => {
      // The sandboxed v6-shell.js's result is a different-realm array (its
      // own Array.prototype), so deepEqual needs a JSON round-trip first —
      // same reason test/v6-b1-ui-shell.test.js's own `plain()` exists.
      assert.deepEqual(uth.filterPeekTrafficLines(lines, true), JSON.parse(JSON.stringify(shellFilter(lines, true))));
    });
  }

  it('matches with hideTraffic off too (both return the input unchanged)', () => {
    const lines = [...WRAPPED_NOTICE, 'after'];
    assert.deepEqual(uth.filterPeekTrafficLines(lines, false), JSON.parse(JSON.stringify(shellFilter(lines, false))));
  });
});

describe('tcV6ExtractLiveTurns: wrapped-URL stitching, #3291', () => {
  const extract = loadExtractLiveTurns();
  const run = (lines) => JSON.parse(JSON.stringify(extract(lines, 'claude', [])));
  const padding = 'x'.repeat(40);

  it('glues a URL wrapped at "https://github.com/Jason-" | "Vaughan/..." with no inserted space', () => {
    const out = run(['> go', `See this issue: ${padding} https://github.com/Jason-`, 'Vaughan/TangleClaw/issues/3290 for details']);
    assert.match(out.turns[1].text, /https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/issues\/3290/);
    assert.doesNotMatch(out.turns[1].text, /Jason- Vaughan/);
  });

  it('glues a URL wrapped at "https://github" | ".com/Jason-Vaughan/..." with no inserted space', () => {
    const out = run(['> go', `See this issue: ${padding} https://github`, '.com/Jason-Vaughan/TangleClaw/issues/3290 for details']);
    assert.match(out.turns[1].text, /https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/issues\/3290/);
    assert.doesNotMatch(out.turns[1].text, /github \.com/);
  });

  it('still inserts a space for an ordinary wrapped word, unaffected by the URL fix', () => {
    const out = run(['> go', `${'x'.repeat(55)} and the rest of the sentence.`]);
    assert.equal(out.turns[1].text, `${'x'.repeat(55)} and the rest of the sentence.`);
  });
});

describe('fitsNotice / compileNotice', () => {
  it('matches a real notice exactly, and any proper prefix of it (the incremental-wrap case)', () => {
    const full = uth.NOTICE_TEMPLATES.length > 0;
    assert.ok(full);
    const sample = '[TangleClaw] Your workload report has expired, so coordinators now read this lane as UNKNOWN. Report what you are doing with `tc workload set <working|waiting-external|blocked|complete> --clearance <safe-to-clear|do-not-clear|unknown> --summary "<one line>"`. This is a reminder, sent once for this report; it changes nothing about your task.';
    assert.equal(uth.fitsNotice(sample), true);
    assert.equal(uth.fitsNotice(sample.slice(0, 20)), true, 'a proper prefix still fits, for incremental wrap matching');
  });

  it('rejects text that is not the start of any known template', () => {
    assert.equal(uth.fitsNotice('this is just ordinary chat text'), false);
  });

  it('compileNotice splits on each slot kind and strips whitespace', () => {
    const { parts, slots } = uth.compileNotice('[X] # items at @ end');
    assert.deepEqual(slots, ['#', '@']);
    assert.deepEqual(parts, ['[X]', 'itemsat', 'end']);
  });
});
