'use strict';

/**
 * #1685 regression — consecutive wrap content steps where the FIRST completes
 * normally and the SECOND is dropped, rejected, or left unsubmitted.
 *
 * This is the shape the issue reported: run `61e435294f079a2e8550729eb2c51e79`
 * completed `changelog-update` with a correct marker, logged the next
 * `learnings-capture` prompt as sent, and waited 300s for a task that never
 * existed. The contract these tests hold is that the second step's failure is
 * reported as a DELIVERY failure and is distinguishable from a slow model.
 */

const test = require('node:test');
const assert = require('node:assert');

const aiContent = require('../lib/wrap-steps/ai-content');

/**
 * Minimal step/context scaffolding for `_runTmuxCapture`.
 * @param {object} over - Overrides merged into the context.
 * @returns {object} A context accepted by `_runTmuxCapture`.
 */
function ctx(over = {}) {
  return {
    project: { name: 'proj', path: process.cwd(), engineId: 'codex' },
    session: { tmuxSession: 'sess' },
    step: { id: 'learnings-capture', prompt: 'do the thing' },
    previousResults: [],
    staged: null,
    ...over
  };
}

/**
 * Swap `_internal` members for a test, restoring them afterwards.
 * @param {object} patch - Members to override.
 * @returns {Function} Restore function.
 */
function patchInternal(patch) {
  const internal = aiContent._internal;
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = internal[k]; internal[k] = patch[k]; }
  return () => { for (const k of Object.keys(saved)) internal[k] = saved[k]; };
}

test('#1685 consecutive content steps', async (t) => {
  await t.test('a second prompt left unsubmitted blocks as a DELIVERY failure, not a timeout', async () => {
    let waited = false;
    const restore = patchInternal({
      sendKeys: () => {},
      verifySubmission: async () => ({
        outcome: 'not-accepted',
        reason: 'the composer is holding input — the prompt was pasted but never submitted'
      }),
      // If the step ever reaches the wait loop, this flips — which would mean
      // the fix failed and we are back to spending MAX_WAIT_MS on a task that
      // was never queued.
      sleep: async () => { waited = true; },
      readPaneTail: () => { waited = true; return ''; }
    });
    try {
      const r = await aiContent._runTmuxCapture(ctx());
      assert.equal(r.ok, false);
      assert.equal(r.status, 'blocked');
      assert.equal(r.deliveryOutcome, 'not-accepted');
      assert.equal(waited, false, 'must not wait out MAX_WAIT_MS for a task that was never queued');
      const text = r.blockers.join(' ');
      assert.match(text, /never became a task/);
      assert.match(text, /not the model taking too long/);
      assert.match(text, /learnings-capture/);
    } finally { restore(); }
  });

  await t.test('the blocker names the step, so two consecutive steps are distinguishable', async () => {
    const restore = patchInternal({
      sendKeys: () => {},
      verifySubmission: async () => ({ outcome: 'not-accepted', reason: 'r' })
    });
    try {
      const r = await aiContent._runTmuxCapture(ctx({ step: { id: 'changelog-update', prompt: 'p' } }));
      assert.match(r.blockers.join(' '), /changelog-update/);
    } finally { restore(); }
  });

  await t.test('an accepted delivery proceeds to the existing wait — no behaviour change', async () => {
    let polled = false;
    const restore = patchInternal({
      sendKeys: () => {},
      verifySubmission: async () => ({ outcome: 'accepted', reason: 'the engine is working (turn-in-flight)' }),
      sleep: async () => {},
      // Advance in steps small enough that the wait loop actually runs, then
      // exceeds MAX_WAIT_MS. A clock that jumps the whole budget on its first
      // read skips the loop entirely and proves nothing.
      now: (() => { let t = 0; return () => (t += 20 * 1000); })(),
      readPaneTail: () => { polled = true; return ''; }
    });
    try {
      const r = await aiContent._runTmuxCapture(ctx());
      // It times out here because nothing ever completes, which is the PRE-EXISTING
      // behaviour for an accepted-but-unfinished step. The point is that it got
      // past the receipt rather than being blocked by it.
      // EXACT, not notEqual: `notEqual(undefined, 'not-accepted')` is green when
      // the field is dropped entirely, which is how the value went missing the
      // first time it was wired.
      assert.equal(r.deliveryOutcome, 'accepted');
      assert.equal(polled, true, 'an accepted prompt must still reach the completion wait');
    } finally { restore(); }
  });

  await t.test('an UNKNOWN receipt proceeds to the wait — it must not block engines with no vocabulary', async () => {
    let polled = false;
    const restore = patchInternal({
      sendKeys: () => {},
      verifySubmission: async () => ({
        outcome: 'unknown',
        reason: 'engine aider declares no wake vocabulary, so nothing here can observe whether the prompt became a task'
      }),
      sleep: async () => {},
      now: (() => { let t = 0; return () => (t += 20 * 1000); })(),
      readPaneTail: () => { polled = true; return ''; }
    });
    try {
      const r = await aiContent._runTmuxCapture(ctx({
        project: { name: 'p', path: process.cwd(), engineId: 'aider' }
      }));
      // It still ends blocked, because nothing completed — that is the
      // PRE-EXISTING timeout path and is exactly what must be preserved. What
      // must NOT happen is the receipt itself blocking the step: an engine with
      // no declared vocabulary would otherwise have every wrap refused.
      assert.equal(r.deliveryOutcome, 'unknown');
      assert.equal(polled, true, 'unknown must reach the completion wait, not short-circuit');
    } finally { restore(); }
  });

  await t.test('a step whose send THREW carries no deliveryOutcome — absent, not a measured unknown', async () => {
    const restore = patchInternal({
      sendKeys: () => { throw new Error('tmux gone'); },
      verifySubmission: async () => { throw new Error('must not be reached'); }
    });
    try {
      const r = await aiContent._runTmuxCapture(ctx());
      assert.equal(r.status, 'blocked');
      assert.equal(Object.prototype.hasOwnProperty.call(r, 'deliveryOutcome'), false);
    } finally { restore(); }
  });

  await t.test('the receipt is asked for the engine the project actually runs', async () => {
    const seen = [];
    const restore = patchInternal({
      sendKeys: () => {},
      verifySubmission: async (_s, engineId, nonce) => {
        seen.push(engineId);
        assert.equal(typeof nonce, 'string');
        assert.ok(nonce.length > 0, 'the receipt must be given this send\'s nonce');
        return { outcome: 'not-accepted', reason: 'r' };
      }
    });
    try {
      await aiContent._runTmuxCapture(ctx({
        project: { name: 'p', path: process.cwd(), engineId: 'openclaw:abc-123' }
      }));
      // An openclaw project's engineId carries its connection id, which matches
      // no wake-profile key. Normalized, or every openclaw wrap silently answers
      // "no vocabulary" for the wrong reason.
      assert.deepEqual(seen, ['openclaw']);
    } finally { restore(); }
  });
});

test('#1685 receipt engine id', async (t) => {
  await t.test('strips an openclaw connection id', () => {
    assert.equal(aiContent._receiptEngineId({ engineId: 'openclaw:9f3' }), 'openclaw');
  });

  await t.test('passes other engines through unchanged', () => {
    assert.equal(aiContent._receiptEngineId({ engineId: 'codex' }), 'codex');
  });

  await t.test('a project with no engine yields an empty id rather than throwing', () => {
    assert.equal(aiContent._receiptEngineId({}), '');
    assert.equal(aiContent._receiptEngineId(undefined), '');
  });
});
