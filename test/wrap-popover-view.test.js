'use strict';

/*
 * The view-model behind the Wrap popover (#1312, #1229): the Wrap button as the
 * run's surface, a step's elapsed time on the server's clock, the handback's row
 * and Retry states, and the `preflight` resolution. Pure functions from
 * `public/wrap-drawer.js`, driven through every phase and state.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const D = require('../public/wrap-drawer');
const C = require('../public/wrap-run-controller');

const RUN = 'r'.repeat(32);

/**
 * A following run whose live view has seen the given events, each stamped the
 * way `session.js` stamps a frame.
 * @param {object[]} events - Decoded frames
 * @returns {object} Controller state
 */
function following(events) {
  let s = C.reduceWrapRun(C.initialWrapRun(), { type: 'follow', runId: RUN });
  for (const event of events) s = C.reduceWrapRun(s, { type: 'event', runId: RUN, event });
  return s;
}

const STEPS = [{ stepId: 'preflight', kind: 'preflight' }, { stepId: 'test', kind: 'test' }, { stepId: 'changelog-update', kind: 'ai-content' }];

describe('step timing on the server clock', () => {
  it('formats m:ss and h:mm:ss', () => {
    assert.equal(D.formatElapsed(0), '0:00');
    assert.equal(D.formatElapsed(102_400), '1:42');
    assert.equal(D.formatElapsed(3_723_000), '1:02:03');
    assert.equal(D.formatElapsed(NaN), '0:00');
  });

  it('elapsed corrects for skew and never goes negative; no timestamp is no clock', () => {
    assert.equal(D.elapsedSince(1_000, 500, 2_000), 500);
    assert.equal(D.elapsedSince(1_000, null, 2_000), 1_000);
    assert.equal(D.elapsedSince(5_000, 0, 2_000), 0);
    assert.equal(D.elapsedSince(null, 0, 2_000), null);
  });

  it('a reload replaying an old step-start still times it from when it began', () => {
    // The page's clock runs 3s ahead; the step began 90s before the replay.
    const serverNow = 1_000_000;
    const skew = 3_000;
    const replayed = following([
      { type: 'run-start', steps: STEPS, at: serverNow - 95_000, sentAt: serverNow, receivedAt: serverNow + skew + 40 },
      { type: 'step-start', stepId: 'test', kind: 'test', at: serverNow - 90_000, sentAt: serverNow, receivedAt: serverNow + skew + 41 }
    ]);
    const timing = D.liveStepTiming(replayed.live, serverNow + skew + 1_000);
    assert.equal(timing.ordinal, 2);
    assert.equal(timing.total, 3);
    assert.ok(Math.abs(timing.elapsedMs - 91_000) < 100, `elapsed ${timing.elapsedMs}`);
  });

  it('keeps the smallest delay seen as the skew estimate', () => {
    assert.equal(D.foldSkew(null, { sentAt: 10, receivedAt: 60 }), 50);
    assert.equal(D.foldSkew(50, { sentAt: 10, receivedAt: 30 }), 20);
    assert.equal(D.foldSkew(20, { sentAt: 10, receivedAt: 900 }), 20);
    assert.equal(D.foldSkew(20, { type: 'legacy' }), 20);
    assert.equal(D.foldSkew(null, {}), null);
  });

  it('a settled step clears the running clock', () => {
    const s = following([
      { type: 'run-start', steps: STEPS },
      { type: 'step-start', stepId: 'preflight', kind: 'preflight', at: 100 },
      { type: 'step-done', stepId: 'preflight', kind: 'preflight', status: 'done', at: 200 }
    ]);
    assert.equal(s.live.currentStepStartedAt, null);
    assert.equal(D.liveStepTiming(s.live, 1_000), null);
  });

  it('a legacy step-start with no `at` shows the step without a clock, never NaN', () => {
    const s = following([{ type: 'run-start', steps: STEPS }, { type: 'step-start', stepId: 'test', kind: 'test' }]);
    const view = D.wrapButtonView(s, { nowMs: 5_000 });
    assert.equal(view.label, 'Wrapping 2/3');
    assert.doesNotMatch(view.label + view.ariaLabel, /NaN/);
  });
});

describe('the Wrap button as the run\'s surface', () => {
  it('with no run it opens the wrap modal, disabled once the session ended or wrapped', () => {
    assert.deepEqual(D.wrapButtonView(C.initialWrapRun(), { nowMs: 0 }),
      { label: 'Wrap', ariaLabel: 'Wrap this session', mode: 'confirm', slow: false, disabled: false });
    assert.equal(D.wrapButtonView(null, { nowMs: 0, sessionEnded: true }).disabled, true);
    assert.equal(D.wrapButtonView(C.initialWrapRun(), { nowMs: 0, wrapCompleted: true }).disabled, true);
  });

  it('while starting, it toggles the popover', () => {
    const s = C.reduceWrapRun(C.initialWrapRun(), { type: 'start', retry: false });
    assert.deepEqual([D.wrapButtonView(s, { nowMs: 0 }).label, D.wrapButtonView(s, { nowMs: 0 }).mode], ['Wrapping…', 'toggle']);
  });

  it('while following, it shows step N of M and the step\'s time; amber and marked past SLOW_STEP_MS', () => {
    const s = following([
      { type: 'run-start', steps: STEPS, at: 0, sentAt: 0, receivedAt: 0 },
      { type: 'step-start', stepId: 'changelog-update', kind: 'ai-content', at: 10_000, sentAt: 10_000, receivedAt: 10_000 }
    ]);
    const early = D.wrapButtonView(s, { nowMs: 10_000 + 102_000 });
    assert.equal(early.label, 'Wrapping 3/3 · 1:42');
    assert.equal(early.mode, 'toggle');
    assert.equal(early.slow, false);
    const late = D.wrapButtonView(s, { nowMs: 10_000 + D.SLOW_STEP_MS });
    assert.equal(late.slow, true);
    assert.ok(late.label.startsWith('⚠ '), 'slow is marked in text, not colour alone');
    assert.match(late.ariaLabel, /taking long/);
  });

  it('after a blocked run it reads "Wrap blocked", then follows the handback', () => {
    let s = C.reduceWrapRun(following([{ type: 'run-start', steps: STEPS }]),
      { type: 'event', runId: RUN, event: { type: 'run-done', result: { ok: false, pipelineResult: { ok: false, blockedAt: 'changelog-update', results: [] } } } });
    assert.equal(s.phase, 'settled');
    assert.equal(D.wrapButtonView(s, { nowMs: 0 }).label, 'Wrap blocked');
    s = C.reduceWrapRun(s, { type: 'handback', runId: RUN, handback: { state: 'working', startedAt: 1_000 } });
    assert.equal(D.wrapButtonView(s, { nowMs: 43_000 }).label, 'Fixing · 0:42');
    s = C.reduceWrapRun(s, { type: 'handback', runId: RUN, handback: { state: 'ready', completedVia: 'marker', startedAt: 1_000 } });
    assert.equal(D.wrapButtonView(s, { nowMs: 50_000 }).label, 'Ready: Retry');
    s = C.reduceWrapRun(s, { type: 'handback', runId: RUN, handback: { state: 'quiet', completedVia: 'quiet', startedAt: 1_000 } });
    assert.equal(D.wrapButtonView(s, { nowMs: 50_000 }).label, 'Check terminal');
    s = C.reduceWrapRun(s, { type: 'handback', runId: RUN, handback: { state: 'timed-out', error: 'x', startedAt: 1_000 } });
    assert.equal(D.wrapButtonView(s, { nowMs: 50_000 }).label, 'Wrap blocked');
  });

  it('a successful, stalled, lost or retry-refused run still toggles its popover', () => {
    const ok = C.reduceWrapRun(following([]), { type: 'event', runId: RUN, event: { type: 'run-done', result: { ok: true } } });
    assert.deepEqual([D.wrapButtonView(ok, { nowMs: 0 }).label, D.wrapButtonView(ok, { nowMs: 0 }).mode], ['Wrapped', 'toggle']);
    const stalled = C.reduceWrapRun(following([]), { type: 'event', runId: RUN, event: { type: 'run-done', stale: true, result: null } });
    assert.equal(D.wrapButtonView(stalled, { nowMs: 0 }).label, 'Wrap: not reporting');
    const lost = C.reduceWrapRun(following([]), { type: 'status', runId: RUN, status: { runId: 'other' } });
    assert.equal(D.wrapButtonView(lost, { nowMs: 0 }).label, 'Wrap: lost track');
    const blocked = C.reduceWrapRun(following([]), { type: 'event', runId: RUN, event: { type: 'run-done', result: { ok: false } } });
    const refusedRetry = C.reduceWrapRun(C.reduceWrapRun(blocked, { type: 'start', retry: true }), { type: 'refused', error: 'busy' });
    assert.equal(D.wrapButtonView(refusedRetry, { nowMs: 0 }).mode, 'toggle');
    const refusedFirst = C.reduceWrapRun(C.reduceWrapRun(C.initialWrapRun(), { type: 'start' }), { type: 'refused', error: 'no' });
    assert.equal(D.wrapButtonView(refusedFirst, { nowMs: 0 }).mode, 'confirm', 'a refused first wrap has no report to toggle');
  });
});

describe('handback row and Retry (#1312)', () => {
  it('working shows the fix\'s time and neither lights Retry nor allows a resend', () => {
    const v = D.handbackView({ state: 'working', startedAt: 1_000 }, { nowMs: 61_000, skewMs: 0 });
    assert.deepEqual(v, { state: 'working', detail: 'Fixing in the session · 1:00', tone: 'working', retryReady: false, canResend: false });
  });

  it('ready on the marker lights Retry; a quiet session does not, and says it may be waiting on you', () => {
    assert.equal(D.handbackView({ state: 'ready', completedVia: 'marker' }, { nowMs: 0 }).retryReady, true);
    // Seen live: handed a gate it would not fake, Claude stopped to ask the
    // operator and printed no marker. Sixty quiet seconds later that is not "done".
    const quiet = D.handbackView({ state: 'quiet', completedVia: 'quiet', completionNote: 'no completion marker seen — the terminal was unchanged for 60s' }, { nowMs: 0 });
    assert.equal(quiet.retryReady, false);
    assert.equal(quiet.canResend, true);
    assert.equal(quiet.tone, 'problem');
    assert.match(quiet.detail, /may be waiting on you/);
  });

  it('timed-out and failed explain, allow a resend, and do not light Retry', () => {
    for (const state of ['timed-out', 'failed']) {
      const v = D.handbackView({ state, error: 'Could not read the terminal: gone' }, { nowMs: 0 });
      assert.equal(v.tone, 'problem');
      assert.equal(v.retryReady, false);
      assert.equal(v.canResend, true);
      assert.match(v.detail, /Could not read the terminal: gone Check the terminal, then Retry\./);
    }
  });

  it('nothing, superseded or malformed shows nothing', () => {
    assert.equal(D.handbackView(null, { nowMs: 0 }), null);
    assert.equal(D.handbackView({ state: 'superseded' }, { nowMs: 0 }), null);
    assert.equal(D.handbackView({ state: 3 }, { nowMs: 0 }), null);
  });

  it('Retry reads "Skip & continue" when a skip is ticked, even when the fix is ready', () => {
    assert.equal(D.retryLabel({}), 'Retry');
    assert.equal(D.retryLabel({ handbackReady: true }), 'Ready: Retry');
    assert.equal(D.retryLabel({ handbackReady: true, skipChosen: true }), 'Skip & continue');
  });
});

describe('a blocked preflight row (#1229)', () => {
  const blockedPreflight = { stepId: 'preflight', kind: 'preflight', status: 'blocked', blockers: ['CRITIC: no review captured'], output: { remediation: 'Run /prawduct:critic.' } };

  it('a halting preflight is resolvable by the session and offers "Wrap anyway"', () => {
    const row = D.buildStepRow(blockedPreflight, { blockedAt: 'preflight' });
    assert.equal(row.agentResolvable, true);
    assert.deepEqual(D.decisionWidgetForBlockedStep(row), {
      kind: 'preflight',
      optionsKey: 'skipPreflight',
      label: 'Wrap anyway — pass over the prawduct gates and record it in the commit body',
      inputType: 'checkbox'
    });
  });

  it('an advisory preflight (the wrap went on) offers neither', () => {
    const row = D.buildStepRow({ ...blockedPreflight, output: { ...blockedPreflight.output, advisory: true, warning: true } }, { blockedAt: null });
    assert.equal(row.agentResolvable, false);
    assert.equal(D.decisionWidgetForBlockedStep(row), null);
  });

  it('the handback prompt carries prawduct\'s block text and forbids waiving the gate, on one line', () => {
    const row = D.buildStepRow(blockedPreflight, { blockedAt: 'preflight' });
    const prompt = D.composeHandbackPrompt(row);
    assert.match(prompt, /prawduct says: CRITIC: no review captured/);
    assert.match(prompt, /How to fix it: Run \/prawduct:critic\./);
    assert.match(prompt, /never waive it \(\.prawduct\/\.gates-waived\)/);
    assert.doesNotMatch(prompt, /write a genuine entry/);
    assert.doesNotMatch(prompt, /[\r\n]/);
  });

  it('a content step\'s handback prompt is unchanged in kind', () => {
    const row = D.buildStepRow({ stepId: 'changelog-update', kind: 'ai-content', status: 'blocked', blockers: ['no entry'], output: { remediation: 'Write it.' } }, { blockedAt: 'changelog-update' });
    const prompt = D.composeHandbackPrompt(row);
    assert.match(prompt, /write a genuine entry/);
    assert.doesNotMatch(prompt, /prawduct says/);
  });

  it('Retry\'s option collector carries "Wrap anyway" only when ticked', () => {
    assert.equal(D.collectOptionsFromAccessors({ skipPreflight: () => true }).skipPreflight, true);
    assert.equal('skipPreflight' in D.collectOptionsFromAccessors({ skipPreflight: () => false }), false);
    assert.equal('skipPreflight' in D.collectOptionsFromAccessors({}), false);
  });

  it('other structural blocks stay unresolvable by the session', () => {
    const row = D.buildStepRow({ stepId: 'test', kind: 'test', status: 'blocked', blockers: ['failed'] }, { blockedAt: 'test' });
    assert.equal(row.agentResolvable, false);
  });
});
