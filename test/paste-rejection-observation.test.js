'use strict';

/*
 * #1134 — a prime the engine DISCARDED was logged as delivered.
 *
 * Measured live on antigravity 1.1.22 (sessions 899/900/901): a freshly booted
 * CLI renders the complete at-rest UI — bare `>` AND the positive
 * `? for shortcuts` marker — while still verifying the account, and discards
 * whatever is submitted with "Please try again shortly". #1133's readiness gate
 * observes the pane BEFORE the send, so both its signals passed, the paste went
 * out, the ledger recorded `delivered`, and no agent brain was ever born.
 *
 * **Why this watches for the REJECTION and not the landing.** Watching the
 * prime arrive was built first and does not work: a real generated prime is
 * 37–225 lines on this machine (`# Session Start — <project>` is its first
 * line), so once it echoes and the engine answers, no part of it is still in a
 * pane tail. That check reads "not landed" on every healthy launch and then
 * re-pastes the whole prime into a session that already had it — worse than the
 * bug. The rejection text is one line, on screen at the moment it matters, and
 * is positive evidence rather than the absence of evidence.
 *
 * The bias that creates is deliberate and asserted below: this only ever
 * DOWNGRADES. A swallow the engine does not announce is still missed, and
 * nothing here can manufacture a retry on a healthy launch.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const sessions = require('../lib/sessions');
const medusaWake = require('../lib/medusa-wake');

const MARKER = medusaWake.ENGINE_WAKE_PROFILES.antigravity.pasteRejectedMarker;

/**
 * An antigravity pane in the shape the live probe captured (agy 1.1.24).
 * @param {object} opts - `rejected` (the discard banner), `busy`, `extra`.
 * @returns {{lines: string[]}}
 */
function pane(opts = {}) {
  const lines = ['  Antigravity CLI', '─'.repeat(40)];
  for (const l of opts.extra || []) lines.push(l);
  if (opts.rejected) lines.push(`  ⚠ ${MARKER}`);
  lines.push('─'.repeat(40), '>', '─'.repeat(40));
  lines.push(opts.busy ? '  esc to cancel                Gemini 3.1 Pro · high'
    : '? for shortcuts               Gemini 3.1 Pro · high');
  return { lines };
}

/** @returns {object} seams that make the watch synchronous */
function seams(captures) {
  let i = 0;
  let clock = 0;
  return {
    capture: () => {
      const c = captures[Math.min(i, captures.length - 1)];
      i += 1;
      if (c instanceof Error) throw c;
      return c;
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  };
}

describe('#1134 — the engine profile declares how a discard reads', () => {
  it('antigravity carries the marker quoted from the live capture', () => {
    assert.equal(typeof MARKER, 'string');
    assert.ok(MARKER.trim().length > 0);
    assert.equal(sessions._pasteRejectedMarker('antigravity'), MARKER);
  });

  it('engines whose discarding behaviour was never measured declare none', () => {
    // Inferring one engine's rejection text for another is how a guard ends up
    // matching nothing, or matching ordinary prose.
    for (const id of ['claude', 'codex', 'aider', 'nonexistent']) {
      assert.equal(sessions._pasteRejectedMarker(id), null, id);
    }
  });
});

describe('#1134 — _observePasteRejected', () => {
  it('rejected: the engine says it discarded the paste', async () => {
    const res = await sessions._observePasteRejected('s', 'antigravity',
      seams([pane({ rejected: true })]));
    assert.equal(res.observed, 'rejected');
    assert.match(res.reason, new RegExp(MARKER));
  });

  it('finds it on a later poll, not only the first', async () => {
    const res = await sessions._observePasteRejected('s', 'antigravity',
      seams([pane(), pane(), pane({ rejected: true })]));
    assert.equal(res.observed, 'rejected');
  });

  it('no-rejection: a healthy pane is NOT typed as a failure', async () => {
    // The property the previous design got wrong. A healthy launch must never
    // produce a downgrade or a retry.
    const res = await sessions._observePasteRejected('s', 'antigravity',
      seams([pane({ extra: ['  OK, reading the project files now.'] })]));
    assert.equal(res.observed, 'no-rejection');
  });

  it('a long prime scrolling out of the pane is still no-rejection', async () => {
    // The exact shape that broke the landing-based check: the prime is far
    // above the window and nothing of it is visible. That is a normal launch.
    const res = await sessions._observePasteRejected('s', 'antigravity',
      seams([pane({ extra: ['  …analysing 225 lines of context', '  Done.'] })]));
    assert.equal(res.observed, 'no-rejection');
  });

  it('unmeasured: an engine that declares no marker is not watched', async () => {
    for (const id of ['claude', 'codex']) {
      const res = await sessions._observePasteRejected('s', id, seams([pane({ rejected: true })]));
      assert.equal(res.observed, 'unmeasured', id);
      assert.match(res.reason, /never been measured/);
    }
  });

  it('unmeasured: a pane that never read is an unknown, not an absence', async () => {
    // Typing an unreadable pane as "no rejection" would let it vouch for a send.
    const res = await sessions._observePasteRejected('s', 'antigravity',
      seams([new Error('tmux gone')]));
    assert.equal(res.observed, 'unmeasured');
    assert.match(res.reason, /tmux gone/);
  });

  it('a pane that read at least once, then failed, is not an unknown', async () => {
    const res = await sessions._observePasteRejected('s', 'antigravity',
      seams([pane(), new Error('tmux gone')]));
    assert.equal(res.observed, 'no-rejection');
  });
});

describe('#1134 — _paneIsBusy: three states, so a retry never injects blind', () => {
  it('true when the busy marker is on the pane', () => {
    const saved = require('../lib/tmux').capturePane;
    require('../lib/tmux').capturePane = () => pane({ busy: true });
    try { assert.equal(sessions._paneIsBusy('s', 'antigravity'), true); }
    finally { require('../lib/tmux').capturePane = saved; }
  });

  it('false on an idle pane', () => {
    const saved = require('../lib/tmux').capturePane;
    require('../lib/tmux').capturePane = () => pane();
    try { assert.equal(sessions._paneIsBusy('s', 'antigravity'), false); }
    finally { require('../lib/tmux').capturePane = saved; }
  });

  it('null — never false — when it cannot be told', () => {
    // The caller re-pastes only on a definite `false`, so an unknown holds the
    // retry rather than injecting over a turn nobody confirmed had finished.
    const saved = require('../lib/tmux').capturePane;
    require('../lib/tmux').capturePane = () => { throw new Error('gone'); };
    try {
      assert.equal(sessions._paneIsBusy('s', 'antigravity'), null, 'unreadable pane');
      assert.equal(sessions._paneIsBusy('s', 'codex'), null, 'engine with no busy marker');
    } finally { require('../lib/tmux').capturePane = saved; }
  });
});

describe('#1134 — _primePasteOutcome only ever downgrades', () => {
  const readyGate = { gated: true, ready: true };
  const blindGate = { gated: false, reason: 'pasted blind after a fixed 1500ms delay' };
  const rejected = { observed: 'rejected', reason: 'the engine answered the paste with "…"' };

  it('a satisfied gate whose paste the engine REJECTED records unverified — the #1134 bug', () => {
    const out = sessions._primePasteOutcome(readyGate, rejected);
    assert.equal(out.outcome, 'unverified');
    assert.equal(out.skipReason, rejected.reason);
  });

  it('a healthy watch leaves the gate verdict untouched, in both directions', () => {
    // The safety property: this can never invent a delivery, and can never
    // downgrade a launch nobody observed failing.
    for (const observed of ['no-rejection', 'unmeasured']) {
      assert.equal(sessions._primePasteOutcome(readyGate, { observed, reason: 'r' }).outcome,
        'delivered', observed);
      assert.equal(sessions._primePasteOutcome(blindGate, { observed, reason: 'r' }).outcome,
        'unverified', observed);
    }
  });

  it('the gate reason survives onto the durable row, with the watch reason alongside', () => {
    // A row read months later has to say why the gate was unsatisfied AND why
    // nothing watched the far side; the earlier draft dropped the first.
    const out = sessions._primePasteOutcome(blindGate, { observed: 'unmeasured', reason: 'nothing watched' });
    assert.match(out.skipReason, /pasted blind/);
    assert.match(out.skipReason, /nothing watched/);
  });

  it('with no watch at all, the pre-#1134 behaviour is preserved exactly', () => {
    assert.equal(sessions._primePasteOutcome(readyGate).outcome, 'delivered');
    assert.equal(sessions._primePasteOutcome(blindGate).outcome, 'unverified');
    assert.equal(sessions._primePasteOutcome(blindGate).skipReason, blindGate.reason);
    assert.equal(sessions._primePasteOutcome(null).outcome, 'unverified');
  });

  it('never records delivered when the engine announced a rejection', () => {
    for (const gate of [readyGate, blindGate, null, undefined, { gated: true, ready: false, reason: 'x' }]) {
      assert.equal(sessions._primePasteOutcome(gate, rejected).outcome, 'unverified', JSON.stringify(gate));
    }
  });
});
