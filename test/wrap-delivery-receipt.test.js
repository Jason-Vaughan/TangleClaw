'use strict';

/*
 * #1685 — the wrap delivery receipt, as a NEGATIVE receipt.
 *
 * It answers `not-accepted` only on evidence attributable to THIS send, and
 * `unknown` otherwise. There is no `accepted`: four review rounds found four
 * reachable paths to a false one, every one in the accept half, and the
 * Architect removed the positive claim (2026-09-20). Success is established
 * downstream by the completion marker, capture file and settle watch.
 */

const test = require('node:test');
const assert = require('node:assert');

// A real store on a throwaway base path, established SYNCHRONOUSLY at require
// time. `ENGINE_WAKE_PROFILES` is derived from the profiles the store holds, so
// without this the file leans on whatever `~/.tangleclaw/engines` the host
// happens to have: green on a dev machine with a live install, red on CI where
// every engine reads as unprofiled. This file learned that the hard way — it
// went green locally and failed CI with "Cannot read properties of undefined
// (reading 'busyMarker')" on eight tests, which also means those tests were
// exercising nothing on CI rather than merely erroring.
const { useThrowawayStore } = require('./_engine-store');

const engineStore = useThrowawayStore('wrap-delivery-receipt');

const receipt = require('../lib/wrap-delivery-receipt');
const medusaWake = require('../lib/medusa-wake');

test.after(() => engineStore.cleanup());

/**
 * A pane reader that replays scripted frames, one per poll.
 * The last frame repeats so a test can hold a state until the window expires.
 * @param {Array<{lines: Array<string>, cursor?: object}>} frames - Scripted reads.
 * @returns {{capturePane: Function, cursorInfo: Function, state: object}}
 */
function paneScript(frames) {
  const state = { reads: 0 };
  const frameAt = () => frames[Math.min(state.reads, frames.length - 1)];
  return {
    capturePane: () => { const f = frameAt(); state.reads += 1; return { lines: f.lines }; },
    cursorInfo: () => (frameAt().cursor === undefined ? null : frameAt().cursor),
    state
  };
}

/**
 * A clock that advances a fixed step per sleep, so windows expire without
 * wall-clock waiting.
 * @param {number} stepMs - Milliseconds each sleep advances.
 * @returns {{now: Function, sleep: Function}}
 */
function fakeClock(stepMs) {
  let t = 0;
  return { now: () => t, sleep: async () => { t += stepMs; } };
}

// Read from the real profiles rather than a hand-built stub: a test that
// invents its own vocabulary stops testing the thing that ships.
const CODEX = 'codex';
const PROFILE = medusaWake.ENGINE_WAKE_PROFILES[CODEX];
const IDLE = '· Ready ·';
const AT_REST = '› \u001b[2mAsk Codex to do anything\u001b[0m';

/**
 * Drive `verifySubmission` over scripted frames.
 * @param {Array<object>} frames - Pane frames.
 * @param {string} nonce - This send's nonce.
 * @param {object} [opts] - Extra options (`engine`, `windowMs`, `stepMs`).
 * @returns {Promise<{outcome: string, reason: string}>}
 */
function run(frames, nonce, opts = {}) {
  const pane = paneScript(frames);
  const clock = fakeClock(opts.stepMs || 1000);
  return receipt.verifySubmission('s', opts.engine || CODEX, nonce, {
    capturePane: pane.capturePane,
    cursorInfo: pane.cursorInfo,
    now: clock.now,
    sleep: clock.sleep,
    windowMs: opts.windowMs || 3000
  });
}

test('the receipt never makes a positive claim', async (t) => {
  await t.test('NOTHING returns accepted, whatever the pane shows', async () => {
    // The guard that matters. A future edit reintroducing a positive claim from
    // rendered-pane inference fails here: the ruling requires an engine-native
    // acknowledgement tied to this nonce and another contract amendment.
    const shapes = [
      { label: 'busy', frame: { lines: [`  ${PROFILE.busyMarker}  `] } },
      {
        label: 'nonce echoed in the transcript',
        frame: { lines: ['NONCE-x echoed', AT_REST, IDLE], cursor: { x: 2, y: 1, line: AT_REST } }
      },
      {
        label: 'at rest, empty composer',
        frame: { lines: [AT_REST, IDLE], cursor: { x: 2, y: 0, line: AT_REST } }
      },
      {
        label: 'unlocatable composer carrying the nonce',
        frame: { lines: ['scroll', 'NONCE-x mid-prompt', 'trailing'], cursor: { x: 3, y: 2, line: 'trailing' } }
      },
      {
        label: 'busy AND unlocatable',
        frame: {
          lines: [`  ${PROFILE.busyMarker}  `, 'NONCE-x mid', 'tail'],
          cursor: { x: 2, y: 2, line: 'tail' }
        }
      }
    ];
    for (const { label, frame } of shapes) {
      const r = await run([frame], 'NONCE-x');
      assert.notEqual(r.outcome, 'accepted', `"${label}" returned accepted`);
    }
  });

  await t.test('describeReceipt has no confirmed wording, and an unknown outcome never reads as success', () => {
    assert.match(receipt.describeReceipt({ outcome: 'not-accepted', reason: 'r' }), /^delivery FAILED/);
    assert.match(receipt.describeReceipt({ outcome: 'unknown', reason: 'r' }), /^delivery unconfirmed/);
    // Fail closed: an outcome nobody taught it — including a reintroduced
    // 'accepted' — must not read as success.
    assert.match(receipt.describeReceipt({ outcome: 'accepted', reason: 'r' }), /^delivery unconfirmed/);
    assert.match(receipt.describeReceipt(null), /^delivery unconfirmed/);
  });
});

test('not-accepted — attributable to THIS send', async (t) => {
  await t.test('our nonce in a located composer, confirmed over two reads', async () => {
    const line = '› NONCE-live typed into the box';
    const r = await run([{ lines: [line, IDLE], cursor: { x: 20, y: 0, line } }], 'NONCE-live', { stepMs: 400 });
    assert.equal(r.outcome, 'not-accepted');
    assert.match(r.reason, /still in the composer/);
  });

  await t.test('a MULTI-ROW paste is caught — the nonce need not be on the cursor row', async () => {
    // The shipped prompt wraps, and `_completionInstruction` puts ~110
    // characters after the nonce, so the nonce lands on a non-cursor composer
    // row. A one-row check missed exactly this.
    const rows = [
      '› [TangleClaw wrap — step 2 of 3: learnings-capture]',
      '  capture the learnings, then print the completion line containing',
      '  TCWRAP-DONE then `NONCE-multi`. TangleClaw waits for that line',
      '  before sending anything else.'
    ];
    const r = await run(
      [{ lines: ['transcript above', ...rows, IDLE], cursor: { x: 24, y: 4, line: rows[3] } }],
      'NONCE-multi',
      { stepMs: 400 }
    );
    assert.equal(r.outcome, 'not-accepted');
  });

  await t.test('ONE read is not enough — a single frame must not condemn a healthy wrap', async () => {
    const held = '› NONCE-blip typed';
    const r = await run([
      { lines: [held, IDLE], cursor: { x: 18, y: 0, line: held } },
      { lines: [AT_REST, IDLE], cursor: { x: 2, y: 0, line: AT_REST } }
    ], 'NONCE-blip');
    assert.notEqual(r.outcome, 'not-accepted');
  });

  await t.test('a rejection marker that APPEARS during the watch is attributable', async () => {
    const marker = medusaWake.ENGINE_WAKE_PROFILES.antigravity.pasteRejectedMarker;
    assert.ok(marker, 'fixture depends on this engine declaring the marker');
    const r = await run([
      { lines: ['nothing yet'] },
      { lines: [`something. ${marker}`] }
    ], 'NONCE-x', { engine: 'antigravity' });
    assert.equal(r.outcome, 'not-accepted');
    assert.match(r.reason, /appeared after this send/);
  });

  await t.test('a rejection drawn DURING the settle is still attributable', async () => {
    // The baseline is taken BEFORE the settle for exactly this: an engine that
    // discards a paste announces it immediately, well inside RECEIPT_SETTLE_MS.
    // Baselining after the settle would find the engine's own rejection already
    // on screen and call it pre-existing scrollback. Pre- and post-fix code
    // answer differently here, which is what makes this a test of the change
    // rather than of the code it replaced.
    const marker = medusaWake.ENGINE_WAKE_PROFILES.antigravity.pasteRejectedMarker;
    let reads = 0;
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', 'antigravity', 'NONCE-x', {
      // Read 0 is the pre-settle baseline: clean. Every read after it shows the
      // marker, i.e. the engine painted its refusal during the settle window.
      capturePane: () => { const first = reads === 0; reads += 1; return { lines: first ? ['clean'] : [`refused. ${marker}`] }; },
      cursorInfo: () => null,
      now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
    assert.match(r.reason, /appeared after this send/);
  });

  await t.test('a baseline read that FAILED cannot attribute a marker — stale stays stale', async () => {
    // A failed pre-read recording `false` would claim the marker was absent
    // before the send, which an unread pane cannot establish — and an earlier
    // send's marker would then block a healthy wrap. A false not-accepted is
    // the one direction this module must never fail in.
    const marker = medusaWake.ENGINE_WAKE_PROFILES.antigravity.pasteRejectedMarker;
    let reads = 0;
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', 'antigravity', 'NONCE-x', {
      capturePane: () => {
        reads += 1;
        if (reads === 1) throw new Error('baseline read failed');
        return { lines: [`old scrollback. ${marker}`] };
      },
      cursorInfo: () => null,
      now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.notEqual(r.outcome, 'not-accepted');
  });

  await t.test('a rejection marker ALREADY present on the first read is stale, not evidence', async () => {
    // It may have been left by an earlier send. `not-accepted` must be about
    // THIS one, so an un-attributable marker is unknown.
    const marker = medusaWake.ENGINE_WAKE_PROFILES.antigravity.pasteRejectedMarker;
    const r = await run([{ lines: [`old scrollback. ${marker}`] }], 'NONCE-x', { engine: 'antigravity' });
    assert.equal(r.outcome, 'unknown');
  });
});

test('unknown — every silence names itself', async (t) => {
  await t.test('an engine with no declared wake vocabulary', async () => {
    for (const engine of ['aider', 'openclaw']) {
      const r = await receipt.verifySubmission('s', engine, 'NONCE-x', {
        capturePane: () => { throw new Error('must not be read'); },
        cursorInfo: () => { throw new Error('must not be read'); }
      });
      assert.equal(r.outcome, 'unknown');
      assert.match(r.reason, /no wake vocabulary/);
    }
  });

  await t.test("a composer holding SOMEONE ELSE'S text is not proof about our prompt", async () => {
    const line = '› the operator was half-way through a sentence';
    const r = await run([{ lines: [line, IDLE], cursor: { x: 40, y: 0, line } }], 'NONCE-ours');
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /operator input or a selector row/);
  });

  await t.test('an unlocatable composer boundary says so', async () => {
    const r = await run([{ lines: ['body one', 'body two'], cursor: { x: 4, y: 1, line: 'body two' } }], 'NONCE-x');
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /could not be located/);
  });

  await t.test('a busy engine says what busy does and does not mean', async () => {
    // Needs a readable cursor: with none, the cursor-failure branch answers
    // first and rightly so — it cannot claim to have observed the composer.
    const r = await run([{
      lines: [`  ${PROFILE.busyMarker}  `, AT_REST], cursor: { x: 2, y: 1, line: AT_REST }
    }], 'NONCE-x');
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /not that THIS prompt was the thing taken/);
  });

  await t.test("an absent idle marker is NOT reported as the engine working", async () => {
    // `_assessActivity` answers working:true for `not-at-rest`, which means only
    // that the idle marker was missing from the bounded tail — a scrolled pane
    // produces it too. Rendering that to the operator as "the engine is
    // working" is absence-read-as-presence surviving in the reason string after
    // being removed from the logic.
    const composer = '› \u001b[2mAsk Codex to do anything\u001b[0m';
    const r = await run([{ lines: ['scrolled transcript', composer], cursor: { x: 2, y: 1, line: composer } }], 'NONCE-x');
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /not evidence of work/);
    assert.doesNotMatch(r.reason, /the engine is working/);
  });

  await t.test('an at-rest pane with an empty composer', async () => {
    const r = await run([{ lines: [AT_REST, IDLE], cursor: { x: 2, y: 0, line: AT_REST } }], 'NONCE-x');
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /at rest with an empty composer/);
  });

  await t.test('an unreadable pane names the read failure', async () => {
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-x', {
      capturePane: () => { throw new Error('pane gone'); },
      cursorInfo: () => null,
      now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /pane gone/);
  });

  await t.test('a persistent cursor failure is reported, not narrated as an empty composer', async () => {
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-x', {
      capturePane: () => ({ lines: [AT_REST, IDLE] }),
      cursorInfo: () => { throw new Error('no cursor'); },
      now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /cursor could not be read/);
    assert.doesNotMatch(r.reason, /at rest with an empty composer/);
  });
});

test('splitting a capture at the composer', async (t) => {
  await t.test('splits at the glyph-led row, not the cursor row', () => {
    const r = receipt._splitAtComposer(['old', '› typed', 'wrapped continuation'],
      { y: 0, line: 'wrapped continuation' }, PROFILE);
    assert.equal(r.located, true);
    assert.equal(r.composer, '› typed\nwrapped continuation');
  });

  await t.test('ignores the row index — cursor.y does not index the capture', () => {
    // capturePane issues `-S -80`, so row 0 is 80 rows ABOVE the pane top while
    // cursor_y is pane-relative. They share no origin.
    const r = receipt._splitAtComposer(['old', '› typed'], { y: 99, line: '› typed' }, PROFILE);
    assert.equal(r.located, true);
    assert.equal(r.composer, '› typed');
  });

  await t.test('locates the composer through SGR, since the capture is styled', () => {
    const r = receipt._splitAtComposer(['above', '\u001b[2m› typed\u001b[0m'], { y: 0, line: '› typed' }, PROFILE);
    assert.equal(r.located, true);
  });

  await t.test('a glyph MID-LINE is transcript, not a prompt', () => {
    // `startsWith` after trimming, matching `_paneDigest`. `includes` would
    // treat any transcript line mentioning the glyph as the composer's head.
    const r = receipt._splitAtComposer(['talking about › here', '› typed'], { y: 0, line: '› typed' }, PROFILE);
    assert.equal(r.composer, '› typed');
  });

  await t.test('NO glyph row is NOT LOCATED — never a one-row fallback', () => {
    // The tail is bounded, and a composer taller than the visible pane scrolls
    // its own head out of it. Falling back to the cursor's single row silently
    // restored the defect the region exclusion existed to fix.
    const r = receipt._splitAtComposer(['body one', 'body two'], { y: 0, line: 'body two' }, PROFILE);
    assert.equal(r.located, false);
    assert.equal(r.composer, '');
  });

  await t.test('no cursor means not located', () => {
    assert.equal(receipt._splitAtComposer(['a', 'b'], null, PROFILE).located, false);
  });
});

test('the claude profile, whose shape differs from codex', async (t) => {
  await t.test('claude declares no idleMarker, and its composer input is still caught', async () => {
    const profile = medusaWake.ENGINE_WAKE_PROFILES.claude;
    const line = `${profile.promptGlyph} NONCE-claude typed text`;
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', 'claude', 'NONCE-claude', {
      capturePane: () => ({ lines: [line] }),
      cursorInfo: () => ({ x: line.length - 1, y: 0, line }),
      now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
  });

  await t.test('a busy claude pane is unknown, not accepted', async () => {
    const busy = medusaWake.ENGINE_WAKE_PROFILES.claude.busyMarker;
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', 'claude', 'NONCE-x', {
      capturePane: () => ({ lines: [`  ${busy}  `] }),
      cursorInfo: () => null,
      now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.equal(r.outcome, 'unknown');
  });
});
