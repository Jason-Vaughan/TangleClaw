'use strict';

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
const PROFILE = medusaWake.ENGINE_WAKE_PROFILES[CODEX];

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
      lines: ['NONCE-abc123 running', '› \u001b[2mAsk Codex to do anything\u001b[0m', '· Ready ·'],
      cursor: { x: 2, y: 1, line: '› \u001b[2mAsk Codex to do anything\u001b[0m' }
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
      lines: [styled, '› \u001b[2mAsk Codex to do anything\u001b[0m', '· Ready ·'],
      cursor: { x: 2, y: 1, line: '› \u001b[2mAsk Codex to do anything\u001b[0m' }
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

test('#1685 verify-3 — the composer is a REGION, not a row', async (t) => {
  // The shipped prompt's real shape: `_wrapStepHeader` + body +
  // `_completionInstruction(nonce)`, which puts ~110 characters AFTER the nonce.
  // So on a wrapped composer the nonce lands on a row that is NOT the cursor's,
  // and a one-row filter leaves it in the echo body. Every fixture before this
  // one modelled a single-row composer carrying the nonce, which is why a green
  // suite shipped the bug.
  const NONCE = 'NONCE-live999';
  const composerRows = [
    '› [TangleClaw wrap — step 2 of 3: learnings-capture]',
    '  capture the session learnings into the file named below, then print the',
    `  completion line containing TCWRAP-DONE then \`${NONCE}\`. TangleClaw waits`,
    "  for that line before sending anything else, so print it only once the",
    "  step's work is done."
  ];
  const cursorLine = composerRows[composerRows.length - 1];

  await t.test('an unsubmitted MULTI-ROW paste is not-accepted — the nonce on a non-cursor row is not an echo', async () => {
    const pane = paneScript([{
      lines: ['transcript above', ...composerRows, '· Ready ·'],
      cursor: { x: 24, y: 4, line: cursorLine }
    }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, NONCE, {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted', 'the nonce sat on a composer row, not in the transcript');
  });

  await t.test('the region excludes every composer row, not just the cursor\'s', () => {
    const r = receipt._splitAtComposer(
      ['transcript above', ...composerRows, '· Ready ·'],
      { x: 24, y: 4, line: cursorLine },
      PROFILE
    );
    assert.equal(r.located, true);
    assert.equal(r.transcript, 'transcript above');
    assert.ok(!r.transcript.includes(NONCE), 'the nonce must not survive into the echo body');
    assert.ok(r.composer.includes(NONCE), 'the nonce belongs to the composer region');
  });

  await t.test('a busy engine holding our unsubmitted text is NOT accepted', async () => {
    // _assessPane answers one mutually-exclusive verdict, so busy used to win and
    // composer-has-input became unreachable — exactly the consecutive-step case.
    const busy = PROFILE.busyMarker;
    const pane = paneScript([{
      lines: [`  ${busy}  `, ...composerRows],
      cursor: { x: 24, y: 5, line: cursorLine }
    }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, NONCE, {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
  });
});

test('splitting a capture at the composer', async (t) => {
  await t.test('splits at the glyph-led row, not the cursor row', () => {
    const r = receipt._splitAtComposer(['old', '› typed', 'wrapped continuation'],
      { y: 0, line: 'wrapped continuation' }, PROFILE);
    assert.equal(r.located, true);
    assert.equal(r.transcript, 'old');
    assert.equal(r.composer, '› typed\nwrapped continuation');
  });

  await t.test('ignores the row index entirely — cursor.y does not index the capture', () => {
    // capturePane issues `-S -80`, so row 0 is 80 rows ABOVE the pane top while
    // cursor_y is pane-relative. They share no origin.
    const r = receipt._splitAtComposer(['old', '› typed', 'tail'], { y: 99, line: '› typed' }, PROFILE);
    assert.equal(r.transcript, 'old');
  });

  await t.test('locates the composer through SGR, since the capture is styled', () => {
    const r = receipt._splitAtComposer(['above', '\u001b[2m› typed\u001b[0m'], { y: 0, line: '› typed' }, PROFILE);
    assert.equal(r.located, true);
    assert.equal(r.transcript, 'above');
  });

  await t.test('a glyph MID-LINE is transcript, not a prompt', () => {
    // `startsWith` after trimming, matching _paneDigest. `includes` would treat
    // any transcript line mentioning the glyph as the composer's first row.
    const r = receipt._splitAtComposer(['talking about › here', '› typed'], { y: 0, line: '› typed' }, PROFILE);
    assert.equal(r.transcript, 'talking about › here');
  });

  await t.test('NO glyph row in the capture is NOT LOCATED — never a one-row fallback', () => {
    // THE regression this round. The tail is bounded, and a composer taller than
    // the visible pane scrolls its own head out of it — routine for a
    // multi-thousand-character wrap prompt. Falling back to the cursor's single
    // row silently restored the defect the region exclusion existed to fix.
    const r = receipt._splitAtComposer(['body row one', 'body row two'],
      { y: 0, line: 'body row two' }, PROFILE);
    assert.equal(r.located, false);
    assert.equal(r.transcript, '');
    assert.equal(r.composer, '');
  });

  await t.test('with no cursor it is not located, so no echo can match', () => {
    assert.equal(receipt._splitAtComposer(['a', 'b'], null, PROFILE).located, false);
  });
});

test('#1685 verify-4 — an unlocatable composer must not become an accept', async (t) => {
  await t.test('a capture whose composer head scrolled away answers unknown, not accepted', async () => {
    const NONCE = 'NONCE-scrolled';
    // No glyph row: the composer's first row is above the captured tail. The
    // nonce is present, on what USED to be mislabelled as transcript.
    const pane = paneScript([{
      lines: [`  wrapped body carrying ${NONCE} mid-prompt`, '  and its trailing instruction'],
      cursor: { x: 10, y: 1, line: '  and its trailing instruction' }
    }]);
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, NONCE, {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep, windowMs: 3000
    });
    assert.notEqual(r.outcome, 'accepted');
    assert.match(r.reason, /could not be located/);
  });

  await t.test('BUSY does not rescue an unlocatable composer — activity is not evidence THIS prompt was taken', async () => {
    // The busy sibling of the fixture above, and the fourth variant of one
    // defect. `located` guarded the two nonce checks and the reason wording but
    // not the activity check — the only one that returns a positive claim. A
    // previous turn still running while our paste sits unsubmitted is the
    // consecutive-step case by definition, so busy + unlocatable + our nonce
    // present must not be an accept.
    const NONCE = 'NONCE-busy-scrolled';
    const busy = PROFILE.busyMarker;
    const pane = paneScript([{
      lines: [`  ${busy}  `, `  wrapped body carrying ${NONCE} mid-prompt`, '  trailing instruction'],
      cursor: { x: 10, y: 2, line: '  trailing instruction' }
    }]);
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, NONCE, {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep, windowMs: 3000
    });
    assert.notEqual(r.outcome, 'accepted');
    assert.match(r.reason, /not evidence that THIS prompt was the thing taken/);
  });

  await t.test('a busy engine with a LOCATED empty composer is still accepted — the gate stays narrow', async () => {
    // The guard must not cost the normal accept path.
    const busy = PROFILE.busyMarker;
    const composer = '› \u001b[2mAsk Codex to do anything\u001b[0m';
    const pane = paneScript([{
      lines: [`  ${busy}  `, composer],
      cursor: { x: 2, y: 1, line: composer }
    }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'NONCE-elsewhere', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
  });

  await t.test('a genuine echo still wins over a composer holding something ELSE', async () => {
    // The operator's half-typed line, or a selector row the cursor sits on, says
    // nothing about OUR prompt. Letting it suppress a real echo answered
    // not-accepted for a prompt that had demonstrably been submitted.
    const NONCE = 'NONCE-submitted';
    const composer = '› operator half-typed something';
    const pane = paneScript([{
      lines: [`${NONCE} the model is answering`, composer],
      cursor: { x: 30, y: 1, line: composer }
    }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, NONCE, {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
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
    const pane = paneScript([{ lines, cursor: { x: 2, y: 2, line: composer } }]);
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
