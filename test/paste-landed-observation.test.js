'use strict';

/*
 * #1134 — a prime the engine DISCARDED was logged as delivered.
 *
 * Measured live on antigravity 1.1.22 (sessions 899/900/901): a freshly booted
 * CLI renders the complete at-rest UI — bare `>` AND the positive
 * `? for shortcuts` marker — while still verifying the account, and discards
 * whatever is submitted. #1133's readiness gate observes the pane BEFORE the
 * send, so both its signals passed, the paste went out, the ledger recorded
 * `delivered`, and no agent brain was ever born from it. There is no lexical
 * tell separating the swallowing state from the ready one, so the only honest
 * evidence is what happens AFTER the send.
 *
 * Shape measured on agy 1.1.24 while building this (a cold boot in a temp
 * workspace, captured through tmux):
 *   - a LANDED submission echoes the text into the transcript and returns the
 *     composer to a bare `>`;
 *   - typing alone ALREADY moves the pane digest, before Enter — so "the
 *     transcript changed" is satisfied by our own keystrokes and is not a
 *     landing signal. That measurement is why this watches for the echo plus a
 *     bare composer rather than for digest movement.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const sessions = require('../lib/sessions');

const PRIME = 'You are working in TangleClaw. Read .tangleclaw/memories/MEMORY.md first.\nMore prime text follows.';
const TOKEN = sessions._pasteEchoToken(PRIME);

/**
 * An antigravity pane, in the shape the live probe captured.
 * @param {object} opts - `echo` (our text in the transcript), `composer`
 *   ('bare' | 'busy'), `extra` (transcript lines).
 * @returns {{lines: string[]}}
 */
function pane(opts) {
  const lines = ['  Antigravity CLI 1.1.24', '  Gemini 3.1 Pro (High)', '─'.repeat(60)];
  if (opts.echo) lines.push(`> ${PRIME.split('\n')[0]}`, '  OK');
  for (const l of opts.extra || []) lines.push(l);
  lines.push('─'.repeat(60));
  lines.push(opts.composer === 'busy' ? '> still typing…' : '>');
  lines.push('─'.repeat(60), '? for shortcuts                     Gemini 3.1 Pro · high');
  return { lines };
}

/** @returns {object} test seams that make the watch synchronous */
function seams(captures) {
  let i = 0;
  let clock = 0;
  return {
    capture: () => captures[Math.min(i++, captures.length - 1)],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    timeoutMs: 20000
  };
}

describe('#1134 — the echo token', () => {
  it('is taken from the first non-empty line and is long enough not to collide', () => {
    assert.equal(TOKEN.length, 24);
    assert.ok(PRIME.replace(/\s+/g, ' ').includes(TOKEN));
  });

  it('is empty when the text is too short to yield a distinctive one', () => {
    // A short token would match ordinary transcript prose, so the watch says
    // `unmeasured` rather than reporting a landing it cannot tell from noise.
    assert.equal(sessions._pasteEchoToken('hi'), '');
    assert.equal(sessions._pasteEchoToken(''), '');
    assert.equal(sessions._pasteEchoToken(null), '');
  });

  it('skips leading blank lines rather than yielding nothing', () => {
    assert.equal(sessions._pasteEchoToken(`\n\n${PRIME}`), TOKEN);
  });
});

describe('#1134 — _observePasteLanded', () => {
  it('landed: our text is in the transcript and the composer came back bare', async () => {
    const res = await sessions._observePasteLanded('s', 'antigravity', PRIME,
      seams([pane({ echo: true, composer: 'bare' })]));
    assert.equal(res.observed, 'landed');
    assert.match(res.reason, /transcript/);
  });

  it('not-landed: the composer is bare and our text is nowhere — the swallow', async () => {
    // The #1134 shape exactly: the engine cleared the composer and discarded
    // the content, so the pane looks idle and carries no trace of the paste.
    const res = await sessions._observePasteLanded('s', 'antigravity', PRIME,
      seams([pane({ echo: false, composer: 'bare', extra: ['  Please try again shortly'] })]));
    assert.equal(res.observed, 'not-landed');
    assert.match(res.reason, /discarded/);
  });

  it('keeps waiting while the engine is still working, then reports the landing', async () => {
    const res = await sessions._observePasteLanded('s', 'antigravity', PRIME, seams([
      pane({ echo: true, composer: 'busy' }),
      pane({ echo: true, composer: 'busy' }),
      pane({ echo: true, composer: 'bare' })
    ]));
    assert.equal(res.observed, 'landed');
    assert.ok(res.waitedMs > 0, 'it actually waited rather than answering on the first look');
  });

  it('the echo alone is NOT a landing — a half-typed composer must not count', async () => {
    // Measured on 1.1.24: the composer renders our text while it is being
    // typed, before Enter. An echo-only check would call that delivered.
    const res = await sessions._observePasteLanded('s', 'antigravity', PRIME,
      seams([pane({ echo: false, composer: 'busy', extra: [`> ${PRIME.split('\n')[0]}`] })]));
    assert.equal(res.observed, 'not-landed');
  });

  it('unmeasured: an engine with no live-probed prompt signature says so', async () => {
    // codex and aider have no wake profile. Reporting a landing for them would
    // be the fabrication this whole change removes.
    for (const engine of ['codex', 'aider', 'nonexistent']) {
      const res = await sessions._observePasteLanded('s', engine, PRIME,
        seams([pane({ echo: true, composer: 'bare' })]));
      assert.equal(res.observed, 'unmeasured', engine);
      assert.match(res.reason, /not observed|no live-probed/);
    }
  });

  it('unmeasured: a prime too short to yield a token', async () => {
    const res = await sessions._observePasteLanded('s', 'antigravity', 'hi',
      seams([pane({ echo: true, composer: 'bare' })]));
    assert.equal(res.observed, 'unmeasured');
  });

  it('a pane that cannot be read is not-landed, and the reason names the read failure', async () => {
    const res = await sessions._observePasteLanded('s', 'antigravity', PRIME, {
      capture: () => { throw new Error('tmux gone'); },
      now: (() => { let c = 0; return () => (c += 0); })(),
      sleep: async () => {},
      timeoutMs: 3000,
      ...(() => { let clock = 0; return { now: () => clock, sleep: async (ms) => { clock += ms; } }; })()
    });
    assert.equal(res.observed, 'not-landed');
    assert.match(res.reason, /tmux gone/);
  });
});

describe('#1134 — _primePasteOutcome: the observation outranks the gate', () => {
  const readyGate = { gated: true, ready: true };
  const blindGate = { gated: false, reason: 'pasted blind after a fixed 1500ms delay' };

  it('a satisfied gate whose paste was NOT taken records unverified — the #1134 bug', () => {
    // This is the whole issue: before this change the left-hand side alone
    // decided, and this exact combination produced `delivered`.
    const out = sessions._primePasteOutcome(readyGate, { observed: 'not-landed', reason: 'the engine discarded it' });
    assert.equal(out.outcome, 'unverified');
    assert.equal(out.skipReason, 'the engine discarded it');
  });

  it('a blind gate whose paste WAS watched landing records delivered', () => {
    // The other direction: post-send evidence is stronger than a pre-send
    // guess, so watching the paste land rescues an engine with no at-rest marker.
    assert.equal(sessions._primePasteOutcome(blindGate, { observed: 'landed', reason: 'r' }).outcome, 'delivered');
  });

  it('when nothing could observe the far side, the gate verdict stands — unchanged behaviour', () => {
    assert.equal(sessions._primePasteOutcome(readyGate, { observed: 'unmeasured', reason: 'r' }).outcome, 'delivered');
    const blind = sessions._primePasteOutcome(blindGate, { observed: 'unmeasured', reason: 'r' });
    assert.equal(blind.outcome, 'unverified');
    assert.match(blind.skipReason, /blind/);
  });

  it('with no observation at all, the pre-#1134 behaviour is preserved exactly', () => {
    assert.equal(sessions._primePasteOutcome(readyGate).outcome, 'delivered');
    assert.equal(sessions._primePasteOutcome(blindGate).outcome, 'unverified');
    assert.equal(sessions._primePasteOutcome(null).outcome, 'unverified');
  });

  it('never records `delivered` on an unverified-or-worse observation', () => {
    // The property, not the cases: no combination of inputs may produce
    // `delivered` when the paste was observed not to land.
    for (const gate of [readyGate, blindGate, null, undefined, { gated: true, ready: false, reason: 'x' }]) {
      assert.equal(sessions._primePasteOutcome(gate, { observed: 'not-landed', reason: 'r' }).outcome,
        'unverified', JSON.stringify(gate));
    }
  });
});
