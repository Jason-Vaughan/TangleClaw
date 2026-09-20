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
    const r = await receipt.verifySubmission('s', 'aider', 'prompt', {
      capturePane: () => { throw new Error('must not be read'); },
      cursorInfo: () => { throw new Error('must not be read'); }
    });
    assert.equal(r.outcome, 'unknown');
    assert.match(r.reason, /no wake vocabulary/);
  });

  await t.test('openclaw, the other no-vocabulary engine, also answers unknown', async () => {
    const r = await receipt.verifySubmission('s', 'openclaw', 'prompt', {
      capturePane: () => { throw new Error('must not be read'); },
      cursorInfo: () => { throw new Error('must not be read'); }
    });
    assert.equal(r.outcome, 'unknown');
  });

  await t.test('a working engine is accepted', async () => {
    const busy = medusaWake.ENGINE_WAKE_PROFILES[CODEX].busyMarker;
    const pane = paneScript([{ lines: [`  ${busy}  `] }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, '[TangleClaw wrap — step 2 of 3]', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
    assert.match(r.reason, /working/);
  });

  await t.test('an echoed prompt header is accepted even when the pane reads idle', async () => {
    const header = '[TangleClaw wrap — step 2 of 3: learnings-capture]';
    const pane = paneScript([{ lines: ['› Ask Codex to do anything', header, '· Ready ·'] }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, `${header}\n\nbody text`, {
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
    const r = await receipt.verifySubmission('s', CODEX, 'ZZZ-no-echo-match', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'not-accepted');
    assert.match(r.reason, /never submitted/);
  });

  await t.test('an at-rest pane with an empty composer stays unknown — it is not evidence either way', async () => {
    const pane = paneScript([{ lines: ['› Ask Codex to do anything', '· Ready ·'] }]);
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'ZZZ-no-echo-match', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep, windowMs: 2000
    });
    assert.equal(r.outcome, 'unknown');
    // The reason must say what was observed, so the caller can stop blaming the model.
    assert.match(r.reason, /at rest with an empty composer/);
    assert.match(r.reason, /not evidence either way/);
  });

  await t.test('an unreadable pane is unknown, and says the read failed', async () => {
    const clock = fakeClock(1000);
    const r = await receipt.verifySubmission('s', CODEX, 'p', {
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
    const r = await receipt.verifySubmission('s', CODEX, 'p', {
      capturePane: () => ({ lines: [`  ${busy}  `] }),
      cursorInfo: () => { throw new Error('no cursor'); },
      now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
  });

  await t.test('acceptance is detected on a later poll, not only the first', async () => {
    const busy = medusaWake.ENGINE_WAKE_PROFILES[CODEX].busyMarker;
    const pane = paneScript([
      { lines: ['› Ask Codex to do anything'] },
      { lines: ['› Ask Codex to do anything'] },
      { lines: [`  ${busy}  `] }
    ]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, 'ZZZ-no-echo-match', {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
    assert.ok(pane.state.reads >= 3, 'should have polled past the first frame');
  });

  await t.test('the echo check strips SGR, so styled output still matches', async () => {
    const header = '[TangleClaw wrap — step 2 of 3: learnings-capture]';
    const styled = `\u001b[2m${header}\u001b[0m`;
    const pane = paneScript([{ lines: ['› Ask Codex to do anything', styled] }]);
    const clock = fakeClock(400);
    const r = await receipt.verifySubmission('s', CODEX, `${header}\n\nbody`, {
      capturePane: pane.capturePane, cursorInfo: pane.cursorInfo, now: clock.now, sleep: clock.sleep
    });
    assert.equal(r.outcome, 'accepted');
    assert.match(r.reason, /echoed/);
  });
});

test('echo needle', async (t) => {
  await t.test('takes the first non-blank line, trimmed to the slice', () => {
    const n = receipt._echoNeedle('\n\n  [TangleClaw wrap — step 1]  \nbody\n');
    assert.equal(n, '[TangleClaw wrap — step 1]');
  });

  await t.test('is bounded, so a long first line cannot become the whole prompt', () => {
    const n = receipt._echoNeedle('x'.repeat(500));
    assert.equal(n.length, receipt.ECHO_SLICE_CHARS);
  });

  await t.test('a non-string prompt yields no needle rather than throwing', () => {
    assert.equal(receipt._echoNeedle(undefined), '');
    assert.equal(receipt._echoNeedle(null), '');
  });

  await t.test('an all-blank prompt yields no needle, so the echo check is skipped', () => {
    assert.equal(receipt._echoNeedle('\n\n   \n'), '');
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
