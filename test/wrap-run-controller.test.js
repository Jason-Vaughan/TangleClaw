'use strict';

/*
 * `public/wrap-run-controller.js` — the pure state machine a session page
 * follows a wrap run through. Every transition that decides what the operator
 * sees is driven here directly; the effects it implies are executed against the
 * real session.js wiring in test/wrap-run-session-wiring.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../public/wrap-run-controller');

const RUN = 'a'.repeat(32);
const NEXT = 'b'.repeat(32);
const BLOCKED = {
  ok: false,
  status: 'blocked',
  pipelineResult: {
    blockedAt: 'test',
    results: [
      { stepId: 'preflight', kind: 'preflight', status: 'done', output: { x: 1 }, blockers: [] },
      { stepId: 'test', kind: 'test', status: 'blocked', output: null, blockers: ['failed'] }
    ]
  }
};

/**
 * Fold a list of signals from the initial state.
 * @param {object[]} signals
 * @returns {object}
 */
function run(signals) {
  return signals.reduce((s, sig) => C.reduceWrapRun(s, sig), C.initialWrapRun());
}

/** @returns {object} A state holding a blocked report for RUN */
function settledBlocked() {
  return run([
    { type: 'start', retry: false },
    { type: 'accepted', runId: RUN },
    { type: 'event', runId: RUN, event: { type: 'run-done', result: BLOCKED } }
  ]);
}

describe('wrap-run controller — starting a wrap', () => {
  it('start → starting; a second start while busy changes nothing (same object)', () => {
    const starting = C.reduceWrapRun(C.initialWrapRun(), { type: 'start', retry: false });
    assert.equal(starting.phase, 'starting');
    assert.equal(C.reduceWrapRun(starting, { type: 'start', retry: false }), starting);
    const following = C.reduceWrapRun(starting, { type: 'accepted', runId: RUN });
    assert.equal(C.reduceWrapRun(following, { type: 'start', retry: true }), following,
      'a live run cannot be restarted from the page');
  });

  it('accepted follows the named run by stream, visibly, with no live view yet', () => {
    const s = run([{ type: 'start' }, { type: 'accepted', runId: RUN }]);
    assert.deepEqual(
      [s.phase, s.runId, s.transport, s.visible, s.live, s.retry],
      ['following', RUN, 'stream', true, null, false]
    );
  });

  it('accepted is ignored unless a POST is out, and without a run id', () => {
    const idle = C.initialWrapRun();
    assert.equal(C.reduceWrapRun(idle, { type: 'accepted', runId: RUN }), idle);
    const starting = C.reduceWrapRun(idle, { type: 'start' });
    assert.equal(C.reduceWrapRun(starting, { type: 'accepted' }), starting);
  });

  it('a refused first wrap is not shown in the drawer — its reason belongs to the modal', () => {
    const s = run([{ type: 'start' }, { type: 'refused', error: 'Incorrect password' }]);
    assert.equal(s.phase, 'refused');
    assert.equal(s.error, 'Incorrect password');
    assert.equal(s.visible, false);
    assert.equal(run([{ type: 'start' }, { type: 'refused' }]).error, 'Wrap failed.', 'never an empty reason');
  });
});

describe('wrap-run controller — following a run', () => {
  it('folds stream frames into the live view, and ignores frames from any other run', () => {
    let s = run([{ type: 'start' }, { type: 'accepted', runId: RUN }]);
    s = C.reduceWrapRun(s, { type: 'event', runId: RUN, event: { type: 'run-start', steps: [{ stepId: 'preflight', kind: 'preflight' }] } });
    s = C.reduceWrapRun(s, { type: 'event', runId: RUN, event: { type: 'step-start', stepId: 'preflight', kind: 'preflight' } });
    assert.equal(s.live.results[0].status, 'running');
    assert.equal(C.reduceWrapRun(s, { type: 'event', runId: NEXT, event: { type: 'step-done', stepId: 'preflight', status: 'done' } }), s);
  });

  it('run-done with a result settles, holding the result the drawer renders', () => {
    const s = settledBlocked();
    assert.equal(s.phase, 'settled');
    assert.equal(s.result, BLOCKED);
    assert.equal(s.transport, null);
    assert.equal(s.visible, true);
  });

  it('a stale run-done is stalled — the outcome is unknown, not failed', () => {
    const s = run([{ type: 'follow', runId: RUN }, { type: 'event', runId: RUN, event: { type: 'run-done', stale: true, result: null } }]);
    assert.equal(s.phase, 'stalled');
    assert.equal(s.result, null);
  });

  it('stream-lost switches to polling; a second loss changes nothing', () => {
    const s = run([{ type: 'follow', runId: RUN }, { type: 'stream-lost', runId: RUN }]);
    assert.equal(s.transport, 'poll');
    assert.equal(C.reduceWrapRun(s, { type: 'stream-lost', runId: RUN }), s);
  });

  it('follow picks up a run this page did not start, and is idempotent for the same run', () => {
    const s = run([{ type: 'follow', runId: RUN }]);
    assert.equal(s.phase, 'following');
    assert.equal(s.retry, false);
    assert.equal(C.reduceWrapRun(s, { type: 'follow', runId: RUN }), s);
    const moved = C.reduceWrapRun(settledBlocked(), { type: 'follow', runId: NEXT });
    assert.equal(moved.result, null, 'a different run does not inherit the previous report');
  });
});

describe('wrap-run controller — statusForRun (what a status payload says about one run)', () => {
  it('reads running, settled, stalled and lost for the followed run', () => {
    assert.equal(C.statusForRun({ runId: RUN, running: true, result: null }, RUN), 'running');
    assert.equal(C.statusForRun({ runId: RUN, running: false, result: BLOCKED }, RUN), 'settled');
    assert.equal(C.statusForRun({ runId: RUN, running: false, stale: true, result: null }, RUN), 'stalled');
    assert.equal(C.statusForRun({ runId: RUN, running: false, stale: false, result: null }, RUN), 'lost');
  });

  it('a run that went stale and then settled reports its real outcome', () => {
    assert.equal(C.statusForRun({ runId: RUN, running: false, stale: true, result: BLOCKED }, RUN), 'settled');
  });

  it('THE PIN: a payload naming another run is never read as this run\'s outcome', () => {
    // Keyed on runId, not on clocks: the status route reports whichever run the
    // project holds last, and a previous wrap's report must not render as this one's.
    assert.equal(C.statusForRun({ runId: NEXT, running: false, result: BLOCKED }, RUN), 'lost');
    assert.equal(C.statusForRun({ runId: null, running: false, result: null }, RUN), 'lost');
  });

  it('no payload is no answer', () => {
    assert.equal(C.statusForRun(null, RUN), 'unknown');
    assert.equal(C.statusForRun('nope', RUN), 'unknown');
  });

  it('status signals only move a run followed by poll or stream to its verdict', () => {
    const polling = run([{ type: 'follow', runId: RUN }, { type: 'stream-lost', runId: RUN }]);
    assert.equal(C.reduceWrapRun(polling, { type: 'status', runId: RUN, status: null }), polling, 'a failed poll is a blip');
    assert.equal(C.reduceWrapRun(polling, { type: 'status', runId: RUN, status: { runId: RUN, running: true } }), polling);
    assert.equal(C.reduceWrapRun(polling, { type: 'status', runId: RUN, status: { runId: RUN, running: false, result: BLOCKED } }).phase, 'settled');
    assert.equal(C.reduceWrapRun(polling, { type: 'status', runId: RUN, status: { runId: NEXT, running: true } }).phase, 'lost');
    assert.equal(C.reduceWrapRun(polling, { type: 'status', runId: RUN, status: { runId: RUN, stale: true } }).phase, 'stalled');
  });
});

describe('wrap-run controller — Retry (#1312)', () => {
  it('a Retry\'s accepted run starts from the previous steps, all pending, marked retry', () => {
    const s = run([
      { type: 'start' }, { type: 'accepted', runId: RUN },
      { type: 'event', runId: RUN, event: { type: 'run-done', result: BLOCKED } },
      { type: 'start', retry: true }
    ]);
    assert.equal(s.phase, 'starting');
    assert.equal(s.result, BLOCKED, 'the report stays until the server accepts the retry');
    const retrying = C.reduceWrapRun(s, { type: 'accepted', runId: NEXT });
    assert.equal(retrying.phase, 'following');
    assert.equal(retrying.runId, NEXT);
    assert.equal(retrying.retry, true);
    assert.deepEqual(retrying.live.results.map((r) => [r.stepId, r.status, r.output, r.blockers.length]),
      [['preflight', 'pending', null, 0], ['test', 'pending', null, 0]],
      'no verdict, no output and no blocker survives into the new run');
    assert.equal(retrying.live.blockedAt, null);
    assert.equal(retrying.live.started, false, 'nothing claims to be running before the server says so');
  });

  it('the new run\'s run-start replaces the seeded rows, and its result ends retry mode', () => {
    let s = C.reduceWrapRun(C.reduceWrapRun(settledBlocked(), { type: 'start', retry: true }), { type: 'accepted', runId: NEXT });
    s = C.reduceWrapRun(s, { type: 'event', runId: NEXT, event: { type: 'run-start', steps: [{ stepId: 'commit', kind: 'commit' }] } });
    assert.deepEqual(s.live.results.map((r) => r.stepId), ['commit']);
    s = C.reduceWrapRun(s, { type: 'event', runId: NEXT, event: { type: 'run-done', result: { ok: true, pipelineResult: { results: [] } } } });
    assert.equal(s.phase, 'settled');
    assert.equal(s.retry, false);
  });

  it('a refused Retry stays visible on the report it retried, and can be retried again', () => {
    const refused = run([
      { type: 'start' }, { type: 'accepted', runId: RUN },
      { type: 'event', runId: RUN, event: { type: 'run-done', result: BLOCKED } },
      { type: 'start', retry: true }, { type: 'refused', error: 'nope' }
    ]);
    assert.equal(refused.phase, 'refused');
    assert.equal(refused.visible, true);
    assert.equal(refused.result, BLOCKED);
    const again = C.reduceWrapRun(C.reduceWrapRun(refused, { type: 'start', retry: true }), { type: 'accepted', runId: NEXT });
    assert.equal(again.live.results.length, 2, 'the seed still comes from the report on screen');
  });

  it('retrySeed returns null when there is nothing to seed from', () => {
    assert.equal(C.retrySeed(null), null);
    assert.equal(C.retrySeed({ ok: false, error: 'threw' }), null);
  });
});

describe('wrap-run controller — closing the drawer', () => {
  it('hiding a live run keeps following it', () => {
    const s = C.reduceWrapRun(run([{ type: 'follow', runId: RUN }]), { type: 'hide' });
    assert.equal(s.phase, 'following');
    assert.equal(s.visible, false);
    assert.equal(s.transport, 'stream');
  });

  it('the report of a hidden live run re-opens the drawer', () => {
    let s = C.reduceWrapRun(run([{ type: 'follow', runId: RUN }]), { type: 'hide' });
    s = C.reduceWrapRun(s, { type: 'event', runId: RUN, event: { type: 'run-done', result: BLOCKED } });
    assert.equal(s.visible, true);
  });

  it('hiding a finished run returns to idle; hiding nothing changes nothing', () => {
    assert.deepEqual(C.reduceWrapRun(settledBlocked(), { type: 'hide' }), C.initialWrapRun());
    const idle = C.initialWrapRun();
    assert.equal(C.reduceWrapRun(idle, { type: 'hide' }), idle);
  });
});

describe('wrap-run controller — input hygiene', () => {
  it('is pure and tolerates garbage', () => {
    const s = settledBlocked();
    const frozen = JSON.stringify(s);
    C.reduceWrapRun(s, { type: 'start', retry: true });
    C.reduceWrapRun(s, { type: 'hide' });
    assert.equal(JSON.stringify(s), frozen, 'the prior state is never mutated');
    assert.equal(C.reduceWrapRun(s, null), s);
    assert.equal(C.reduceWrapRun(s, { type: 'no-such-signal' }), s);
    assert.equal(C.reduceWrapRun(null, { type: 'hide' }).phase, 'idle');
  });
});
