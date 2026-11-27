'use strict';

/*
 * v6.6.5 Wave 1 (Car V665-W1-A, #3267 / V6-018, V6-038).
 *
 * Covers lib/v6/sprint-car-status-sync.js's pure derivation
 * (deriveCarStatus) -- see that file's own top comment for the #3267
 * AC2 scope note: fetching the live signals (tc workload, GitHub, LANE_
 * QUEUE.md) and rendering the Sprint & Cars view are both outside this
 * car's envelope; this is the one function that turns already-fetched
 * signals into the 5-status verdict.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const sync = require('../lib/v6/sprint-car-status-sync');
const waveScheduler = require('../lib/v6/c3-wave-scheduler');

/**
 * Assert `fn` throws a SprintCarStatusSyncError with `code`.
 * @param {Function} fn
 * @param {string} code
 */
function throwsCode(fn, code) {
  assert.throws(fn, (err) => err instanceof sync.SprintCarStatusSyncError && err.code === code, code);
}

describe('WAVE_RUN_STATUS_TO_LIFECYCLE covers every real wave-scheduler CAR_STATUSES value', () => {
  it('maps every real status to a lifecycle bucket or an explicit null, with none stale', () => {
    const real = new Set(waveScheduler.CAR_STATUSES);
    const mapped = new Set(Object.keys(sync.WAVE_RUN_STATUS_TO_LIFECYCLE));
    assert.deepEqual([...mapped].sort(), [...real].sort());
  });

  it('every non-null mapped value is a real CAR_LIFECYCLE_STATUSES bucket', () => {
    for (const bucket of Object.values(sync.WAVE_RUN_STATUS_TO_LIFECYCLE)) {
      if (bucket !== null) assert.ok(sync.CAR_LIFECYCLE_STATUSES.includes(bucket), bucket);
    }
  });
});

describe('deriveCarStatus: PR state settles it outright (#3267 AC1, highest precedence)', () => {
  it('a merged, non-deployed PR reads completed', () => {
    assert.deepEqual(sync.deriveCarStatus({ pr: { prState: 'MERGED' } }), { status: 'completed', blocked: false, blockedBy: [] });
  });

  it('a merged, deployed PR reads deployed, not completed', () => {
    assert.deepEqual(sync.deriveCarStatus({ pr: { prState: 'MERGED', deployed: true } }), { status: 'deployed', blocked: false, blockedBy: [] });
  });

  it('an open PR reads in-review, whatever the workload or wave-run state says', () => {
    const res = sync.deriveCarStatus({ pr: { prState: 'OPEN' }, workload: { state: 'complete' }, waveRunState: 'pending' });
    assert.equal(res.status, 'in-review');
  });

  it('prState "none" or "CLOSED" (no merge) contributes nothing, falling through to the next signal', () => {
    assert.equal(sync.deriveCarStatus({ pr: { prState: 'none' }, workload: { state: 'working' } }).status, 'in-progress');
    assert.equal(sync.deriveCarStatus({ pr: { prState: 'CLOSED' }, workload: { state: 'working' } }).status, 'in-progress');
  });
});

describe('deriveCarStatus: wave-run state, when no PR signal settles it', () => {
  it('maps pending/running/awaiting-gate/gate-held/complete/stalled to their real lifecycle bucket', () => {
    assert.equal(sync.deriveCarStatus({ waveRunState: 'pending' }).status, 'not-started');
    assert.equal(sync.deriveCarStatus({ waveRunState: 'running' }).status, 'in-progress');
    assert.equal(sync.deriveCarStatus({ waveRunState: 'awaiting-gate' }).status, 'in-review');
    assert.equal(sync.deriveCarStatus({ waveRunState: 'gate-held' }).status, 'in-review');
    assert.equal(sync.deriveCarStatus({ waveRunState: 'complete' }).status, 'completed');
    assert.equal(sync.deriveCarStatus({ waveRunState: 'stalled' }).status, 'in-progress');
  });

  it('gate-held and stalled both carry their own blocked overlay, even with every gate verdict pending', () => {
    assert.deepEqual(sync.deriveCarStatus({ waveRunState: 'gate-held' }).blockedBy, ['waveRun:gate-held']);
    assert.deepEqual(sync.deriveCarStatus({ waveRunState: 'stalled' }).blockedBy, ['waveRun:stalled']);
  });

  it('cancelled contributes nothing (maps to null), falling through to workload or not-started', () => {
    assert.equal(sync.deriveCarStatus({ waveRunState: 'cancelled', workload: { state: 'working' } }).status, 'in-progress');
    assert.equal(sync.deriveCarStatus({ waveRunState: 'cancelled' }).status, 'not-started');
  });
});

describe('deriveCarStatus: workload receipt, as the coarsest fallback', () => {
  it('working/waiting-external/blocked all read in-progress as the base bucket', () => {
    for (const state of ['working', 'waiting-external', 'blocked']) {
      assert.equal(sync.deriveCarStatus({ workload: { state } }).status, 'in-progress', state);
    }
  });

  it('complete reads completed', () => {
    assert.equal(sync.deriveCarStatus({ workload: { state: 'complete' } }).status, 'completed');
  });

  it('a blocked workload sets the blocked overlay, without changing the in-progress bucket', () => {
    const res = sync.deriveCarStatus({ workload: { state: 'blocked' } });
    assert.equal(res.status, 'in-progress');
    assert.equal(res.blocked, true);
    assert.deepEqual(res.blockedBy, ['workload']);
  });
});

describe('deriveCarStatus: no signals at all', () => {
  it('reads not-started, not blocked', () => {
    assert.deepEqual(sync.deriveCarStatus({}), { status: 'not-started', blocked: false, blockedBy: [] });
    assert.deepEqual(sync.deriveCarStatus(), { status: 'not-started', blocked: false, blockedBy: [] });
    assert.deepEqual(sync.deriveCarStatus(null), { status: 'not-started', blocked: false, blockedBy: [] });
  });
});

describe('deriveCarStatus: gate verdicts, reported as blockers alongside whichever bucket wins', () => {
  it('a failed gate blocks an in-review car without reclassifying it', () => {
    const res = sync.deriveCarStatus({ pr: { prState: 'OPEN' }, gates: { rGate: 'fail', ci: 'pending' } });
    assert.equal(res.status, 'in-review');
    assert.equal(res.blocked, true);
    assert.deepEqual(res.blockedBy, ['rGate']);
  });

  it('collects every failed gate, in the order given', () => {
    const res = sync.deriveCarStatus({ pr: { prState: 'OPEN' }, gates: { oGate: 'pass', aGate: 'fail', gate3: 'fail', rGate: 'pending', ci: 'pass' } });
    assert.deepEqual(res.blockedBy, ['aGate', 'gate3']);
  });

  it('a pending/pass-only gate set blocks nothing', () => {
    const res = sync.deriveCarStatus({ pr: { prState: 'OPEN' }, gates: { oGate: 'pass', aGate: 'pending' } });
    assert.equal(res.blocked, false);
  });
});

describe('deriveCarStatus: input validation', () => {
  it('refuses an unrecognized workload.state, pr.prState, or waveRunState', () => {
    throwsCode(() => sync.deriveCarStatus({ workload: { state: 'nonsense' } }), 'WORKLOAD_STATE_INVALID');
    throwsCode(() => sync.deriveCarStatus({ pr: { prState: 'nonsense' } }), 'PR_STATE_INVALID');
    throwsCode(() => sync.deriveCarStatus({ waveRunState: 'nonsense' }), 'WAVE_RUN_STATE_INVALID');
  });

  it('refuses an unknown gate name or an unrecognized gate verdict', () => {
    throwsCode(() => sync.deriveCarStatus({ gates: { notAGate: 'pass' } }), 'GATE_NAME_INVALID');
    throwsCode(() => sync.deriveCarStatus({ gates: { ci: 'nonsense' } }), 'GATE_VERDICT_INVALID');
  });
});
