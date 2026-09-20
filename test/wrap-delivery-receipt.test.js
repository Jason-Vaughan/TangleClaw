'use strict';

const test = require('node:test');
const assert = require('node:assert');

const receipt = require('../lib/wrap-delivery-receipt');
const medusaWake = require('../lib/medusa-wake');

/**
 * A pane reader that replays scripted frames, one per poll.
 * The last frame repeats so a test can hold a state until the window expires.
 * @param {Array<{lines: Array<string>, cursor?: object}>} frames - Scripted reads.
 * @returns {{capturePane: Function, cursorInfo: Function, reads: number}}
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

// The codex profile is the one with the fullest declared vocabulary
// (busyMarker, idleMarker, promptPattern, promptGlyph), so it exercises every
// branch. Read from the real profiles rather than a hand-built stub: a test
// that invents its own vocabulary stops testing the thing that ships.
const CODEX = 'codex';

test('wrap delivery receipt', async (t) => {
  await t.test('an engine with no declared wake vocabulary answers unknown, never accepted', async () => {
    const r = await receipt.verifySubmission('s', 'aider', 'NONCE-x', {
      capturePane: () => { throw new Error('must not be read'); },
      cursorInfo: () => { throw new Error('must not be read'); }
    });
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /no wake vocabulary/);
  });

  await t.test('openclaw, the other no-vocabulary engine, also answers unknown', async () => {
    const r = await receipt.verifySubmission('s', 'openclaw', 'NONCE-x', {
      capturePane: () => { throw new Error('must not be read'); },
      cursorInfo: () => { throw new Error('must not be read'); }
    });
    assert.equal(r.outcome, 'unknown');
  });

  await t.test('a working engine is accepted', async () => {
    const busy = medusaWake.ENGINE_WAKE_PROFILES[CODEX].busyMarker;
    const pane = paneScript([{ lines: [`  ${busy}  `] }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-abc123', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
    assert.match(r.reason, /working/);
  });

  await t.test("a nonce echoed OUTSIDE the composer is accepted even when the pane reads idle", async () => {
    // cursor.y = 0 marks line 0 as the composer; the nonce is on line 1, in the
    // transcript, which only a SUBMITTED prompt can reach.
    const pane = paneScript([{
      lines: ['› \u001b[2mAsk Codex to do anything\u001b[0m', 'NONCE-abc123 running', '· Ready ·'],
      cursor: { x: 2, y: 0, line: '› \u001b[2mAsk Codex to do anything\u001b[0m' }
    }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-abc123', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
    assert.match(r.reason, /echoed/);
  });

  await t.test('input left in the composer is a DELIVERY FAILURE, not a slow model', async () => {
    // The real shape, and it matters: for an engine declaring an `idleMarker`,
    // `_assessPane` short-circuits on `not-at-rest` before it ever reaches the
    // composer check. So the Ready footer must be present for the composer
    // verdict to surface at all — which is exactly what Codex renders while
    // text sits unsubmitted in the composer. A fixture without the footer tests
    // a pane state that never occurs.
    const pane = paneScript([{
      lines: ['› [TangleClaw wrap', '· Ready ·'],
      cursor: { x: 17, y: 0, line: '› [TangleClaw wrap' }
    }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-unmatched', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
    assert.match(r.reason, /never submitted/);
  });

  await t.test('an at-rest pane with an empty composer stays unknown — it is not evidence either way', async () => {
    // The cursor is REQUIRED for this case: claiming "empty composer" without
    // one would assert something nothing observed, which the cursor-failure
    // branch exists to prevent.
    const line = '› \u001b[2mAsk Codex to do anything\u001b[0m';
    const pane = paneScript([{ lines: [line, '· Ready ·'], cursor: { x: 2, y: 0, line } }]);
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-unmatched', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.equal(r.outcome, 'unknown');
    // The reason must say what was observed, so the caller can stop blaming the model.
    assert.match(r.reason, /at rest with an empty composer/);
    assert.match(r.reason, /not evidence either way/);
  });

  await t.test('an unreadable pane is unknown, and says the read failed', async () => {
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-x', {
      capturePane: () => { throw new Error('pane gone'); },
      cursorInfo: () => null,
      now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /could not be read/);
    assert.match(r.reason, /pane gone/);
  });

  await t.test('a cursor read that throws does not lose the evidence in the tail', async () => {
    const busy = medusaWake.ENGINE_WAKE_PROFILES[CODEX].busyMarker;
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-x', {
      capturePane: () => ({ lines: [`  ${busy}  `] }),
      cursorInfo: () => { throw new Error('no cursor'); },
      now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
  });

  await t.test('acceptance is detected on a later poll, not only the first', async () => {
    const busy = medusaWake.ENGINE_WAKE_PROFILES[CODEX].busyMarker;
    const pane = paneScript([
      { lines: ['› \u001b[2mAsk Codex to do anything\u001b[0m'] },
      { lines: ['› \u001b[2mAsk Codex to do anything\u001b[0m'] },
      { lines: [`  ${busy}  `] }
    ]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-unmatched', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
    assert.ok(pane.state.reads >= 3, 'should have polled past the first frame');
  });

  await t.test('the echo check strips SGR, so styled output still matches', async () => {
    const styled = '\u001b[2mNONCE-abc123\u001b[0m';
    const pane = paneScript([{
      lines: ['› \u001b[2mAsk Codex to do anything\u001b[0m', styled, '· Ready ·'],
      cursor: { x: 2, y: 0, line: '› \u001b[2mAsk Codex to do anything\u001b[0m' }
    }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-abc123', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
    assert.match(r.reason, /echoed/);
  });
});

test('#1685 R-1 — the composer must never be read as an echo', async (t) => {
  await t.test('an UNSUBMITTED prompt sitting in the composer is not-accepted, even though it contains the nonce', async () => {
    // THE regression. sendKeys clears the composer, pastes, then sends Enter —
    // so a prompt that was never submitted renders ON the composer line, nonce
    // and all, inside the very capture the echo check reads. The first cut of
    // this module ran the echo check first over the whole capture and answered
    // `accepted` for exactly the case it exists to catch. The original fixture
    // hid it by passing a nonce that appeared nowhere.
    const pane = paneScript([{
      lines: ['› NONCE-live123 please do the thing', '· Ready ·'],
      cursor: { x: 20, y: 0, line: '› NONCE-live123 please do the thing' }
    }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-live123', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
    assert.match(r.reason, /never submitted/);
  });

  await t.test('with no cursor the echo check does not run — the composer cannot be located', async () => {
    // Without a cursor there is no way to tell the composer line from the
    // transcript, so accepting on an echo would restore the collision above by
    // another route. Answer unknown instead.
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-live123', {
      capturePane: () => ({ lines: ['› NONCE-live123 pasted', '· Ready ·'] }),
      cursorInfo: () => null,
      now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.notEqual(r.outcome, 'accepted');
  });

  await t.test('a persistent cursor failure is reported, not narrated as an empty composer', async () => {
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-x', {
      capturePane: () => ({ lines: ['› \u001b[2mAsk Codex to do anything\u001b[0m', '· Ready ·'] }),
      cursorInfo: () => { throw new Error('no cursor'); },
      now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /cursor could not be read/);
    // The claim it must NOT make: that it saw an empty composer.
    assert.doesNotMatch(r.reason, /at rest with an empty composer/);
  });
});

test('#1685 R-1 — a stale echo from a previous attempt must not be accepted', async (t) => {
  await t.test("a retry does not match the FAILED attempt's text still in scrollback", async () => {
    // The needle is this send's nonce, not the step header, which is
    // byte-identical on every attempt. A header needle matches scrollback left
    // by the attempt that just failed — the same stale-scrollback trap the
    // per-send nonce already closes for the completion marker.
    const pane = paneScript([{
      lines: [
        '[TangleClaw wrap — step 2 of 3: learnings-capture]',
        'NONCE-oldattempt output from the previous try',
        '› \u001b[2mAsk Codex to do anything\u001b[0m',
        '· Ready ·'
      ],
      cursor: { x: 2, y: 2, line: '› \u001b[2mAsk Codex to do anything\u001b[0m' }
    }]);
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-newattempt', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.notEqual(r.outcome, 'accepted');
  });
});

test('#1685 R-2 — the claude profile, whose shape differs from codex', async (t) => {
  await t.test('claude declares no idleMarker, and a busy pane is still accepted', async () => {
    const busy = medusaWake.ENGINE_WAKE_PROFILES.claude.busyMarker;
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', 'claude', 'NONCE-x', {
      capturePane: () => ({ lines: [`  ${busy}  `] }),
      cursorInfo: () => null,
      now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
  });

  await t.test('claude input in the composer is not-accepted', async () => {
    const profile = medusaWake.ENGINE_WAKE_PROFILES.claude;
    const line = `${profile.promptGlyph} NONCE-live typed text`;
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', 'claude', 'NONCE-live', {
      capturePane: () => ({ lines: [line] }),
      cursorInfo: () => ({ x: line.length - 1, y: 0, line }),
      now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
  });
});

test('#1685 R-2 — a filled composer is confirmed before it is believed', async (t) => {
  await t.test('a single frame showing input is NOT enough to answer not-accepted', async () => {
    // medusa-wake documents composer-has-input as also reachable by a glyph-led
    // selector row holding the cursor. One frame of it must not block a wrap.
    const held = '› NONCE-live typed';
    const idle = '› \u001b[2mAsk Codex to do anything\u001b[0m';
    const pane = paneScript([
      { lines: [held, '· Ready ·'], cursor: { x: 17, y: 0, line: held } },
      { lines: [idle, '· Ready ·'], cursor: { x: 2, y: 0, line: idle } }
    ]);
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-unmatched', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep, windowMs: 3000
    });
    assert.notEqual(r.outcome, 'not-accepted');
  });

  await t.test('two consecutive frames showing input ARE enough', async () => {
    const held = '› NONCE-live typed';
    const pane = paneScript([{ lines: [held, '· Ready ·'], cursor: { x: 17, y: 0, line: held } }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-unmatched', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
    assert.match(r.reason, /consecutive reads/);
  });
});

test('#1685 R-3 — an engine that says it discarded the submission', async (t) => {
  await t.test("antigravity's declared rejection marker is not-accepted, not a 300s wait", async () => {
    const marker = medusaWake.ENGINE_WAKE_PROFILES.antigravity.pasteRejectedMarker;
    assert.ok(marker, 'the fixture depends on this engine declaring the marker');
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', 'antigravity', 'NONCE-x', {
      capturePane: () => ({ lines: [`something. ${marker}`] }),
      cursorInfo: () => null,
      now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
    assert.match(r.reason, /discarded the submission/);
  });

  await t.test('an engine that declares no such marker is unaffected', async () => {
    assert.equal(medusaWake.ENGINE_WAKE_PROFILES[CODEX].pasteRejectedMarker, undefined);
  });
});

test('transcript outside the composer', async (t) => {
  await t.test('drops the composer line by CONTENT, wherever it sits in the capture', () => {
    const out = receipt._transcriptOutsideComposer(['a', 'b', 'c'], { y: 99, line: 'b' });
    assert.equal(out, 'a\nc');
  });

  await t.test('ignores the row index entirely — cursor.y does not index the capture', () => {
    // capturePane issues `-S -80`, so row 0 is 80 rows ABOVE the pane top while
    // cursor_y is pane-relative. An index-based filter dropped an arbitrary
    // scrollback row and left the composer in the body.
    const out = receipt._transcriptOutsideComposer(['old', '› typed', 'tail'], { y: 0, line: '› typed' });
    assert.equal(out, 'old\ntail');
  });

  await t.test('matches through SGR, since the capture is styled and the cursor line may not be', () => {
    const out = receipt._transcriptOutsideComposer(['\u001b[2m› typed\u001b[0m', 'tail'], { y: 0, line: '› typed' });
    assert.equal(out, 'tail');
  });

  await t.test('with no cursor it yields nothing, so no echo can match', () => {
    assert.equal(receipt._transcriptOutsideComposer(['a', 'b'], null), '');
  });
});

test('#1685 verify-1 — scrollback above the visible pane must not defeat the composer exclusion', async (t) => {
  await t.test('an unsubmitted paste is still not-accepted when the capture carries scrollback', async () => {
    // THE regression this round. Every earlier fixture modelled the capture as
    // the visible pane alone, which is the one shape where cursor.y happens to
    // index it. A real capture is `-S -80`, so the composer sits far down the
    // array while cursor.y stays small — the index filter dropped a scrollback
    // row, left the composer in the echo body, and the nonce (which rides at
    // the END of the prompt) matched it: `accepted`, on poll 1, before the
    // two-poll composer confirmation could ever fire.
    const composer = '› NONCE-live123 please do the thing';
    const lines = ['scroll A', 'scroll B', 'scroll C', composer, '· Ready ·'];
    const pane = paneScript([{ lines, cursor: { x: 20, y: 0, line: composer } }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-live123', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
  });

  await t.test('a genuine transcript echo with scrollback present is still accepted', async () => {
    const composer = '› \u001b[2mAsk Codex to do anything\u001b[0m';
    const lines = ['scroll A', 'NONCE-live123 working on it', composer, '· Ready ·'];
    const pane = paneScript([{ lines, cursor: { x: 2, y: 0, line: composer } }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-live123', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
    assert.match(r.reason, /echoed/);
  });
});

test('receipt description', async (t) => {
  await t.test('names each outcome distinctly', () => {
    assert.match(receipt.describeReceipt({ outcome: 'accepted', reason: 'r' }), /^delivery confirmed/);
    assert.match(receipt.describeReceipt({ outcome: 'not-accepted', reason: 'r' }), /^delivery FAILED/);
    assert.match(receipt.describeReceipt({ outcome: 'unknown', reason: 'r' }), /^delivery unconfirmed/);
  });

  await t.test('an unrecognised outcome reads as unconfirmed, never as confirmed', () => {
    // Fail closed: a new outcome nobody taught this function must not read as success.
    assert.match(receipt.describeReceipt({ outcome: 'something-new', reason: 'r' }), /^delivery unconfirmed/);
    assert.match(receipt.describeReceipt(null), /^delivery unconfirmed/);
  });
});
