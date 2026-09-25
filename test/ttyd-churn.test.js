'use strict';

/*
 * The churn harness's decisions (#1245): when a run may start, when it must
 * stop, what counts as a wedge, how exiting children's lifetimes are measured,
 * and which verdict a run earns. The harness itself spawns a scratch ttyd and
 * is never run by the suite; these are the parts that decide what its numbers mean.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const churn = require('../lib/ttyd-churn');
const { parseArgs } = require('../scripts/ttyd-churn');

/** Preflight facts for a run that should be allowed. @returns {object} */
function goodFacts(overrides = {}) {
  return {
    platform: 'darwin',
    ttydLeakState: 'clear',
    pool: { used: 31, cap: 511 },
    socketInUse: false,
    ttydBin: '/opt/homebrew/bin/ttyd',
    tmuxBin: '/opt/homebrew/bin/tmux',
    concurrency: 10,
    ...overrides
  };
}

/** A finished candidate run meeting R22 Q7 in full. @returns {object} */
function passingCandidate(overrides = {}) {
  return {
    mode: 'candidate',
    stop: 'completed',
    cycles: churn.ACCEPT_CYCLES,
    soakMs: churn.ACCEPT_SOAK_MS,
    confirmedWedges: 0,
    restarts: 0,
    clientErrors: 0,
    withOutput: 1600,
    lingering: 0,
    poolReturned: true,
    fdsReturned: true,
    cleanupOk: true,
    ...overrides
  };
}

describe('lib/ttyd-churn (#1245 harness decisions)', () => {
  describe('checkPreflight — the host guards before a run (R22 Q6)', () => {
    it('allows a run on a quiet macOS host', () => {
      assert.deepEqual(churn.checkPreflight(goodFacts()), { ok: true, reasons: [] });
    });

    it('refuses unless the live ttyd row is clear', () => {
      for (const state of ['fired', 'unknown', null]) {
        const r = churn.checkPreflight(goodFacts({ ttydLeakState: state }));
        assert.equal(r.ok, false, String(state));
        assert.match(r.reasons.join(), /ttyd row is/);
      }
    });

    it('refuses above the start limit on PTY use, and when the pool is unreadable', () => {
      const cap = 511;
      const limit = Math.floor(cap * churn.PREFLIGHT_MAX_POOL_RATIO);
      assert.equal(churn.checkPreflight(goodFacts({ pool: { used: limit, cap } })).ok, true);
      assert.equal(churn.checkPreflight(goodFacts({ pool: { used: limit + 1, cap } })).ok, false);
      assert.equal(churn.checkPreflight(goodFacts({ pool: null })).ok, false);
    });

    it('refuses more than the concurrency cap, or a non-integer', () => {
      assert.equal(churn.checkPreflight(goodFacts({ concurrency: churn.MAX_CONCURRENCY })).ok, true);
      for (const c of [0, churn.MAX_CONCURRENCY + 1, 2.5]) {
        assert.equal(churn.checkPreflight(goodFacts({ concurrency: c })).ok, false, String(c));
      }
    });

    it('refuses off macOS, with a live scratch socket, or with a binary missing, naming each reason', () => {
      const r = churn.checkPreflight(goodFacts({ platform: 'linux', socketInUse: true, ttydBin: null, tmuxBin: null }));
      assert.equal(r.ok, false);
      assert.equal(r.reasons.length, 4);
    });
  });

  describe('countWedges — time SEEN exiting, never process age', () => {
    it('counts children observed exiting for at least the floor', () => {
      const f = churn.WEDGE_FLOOR_MS;
      assert.equal(churn.countWedges([f, f + 1, f - 1, 0]), 2);
    });

    it('an hours-old child first seen exiting now is not a wedge: the tracker, not etime, decides', () => {
      const t = new churn.LifetimeTracker();
      t.observe([{ pid: 10, stat: '?Es', ageMs: 5 * 3600 * 1000 }], 1000);
      assert.equal(churn.countWedges(t.stillOpen(1000)), 0);
      assert.equal(churn.countWedges(t.stillOpen(1000 + churn.WEDGE_FLOOR_MS)), 1);
    });
  });

  describe('nextStep — when a run stops', () => {
    const pool = (used) => ({ used, cap: 511 });

    it('continues while under both stop lines', () => {
      assert.equal(churn.nextStep({ wedges: churn.STOP_AT_WEDGES - 1, pool: pool(40) }), 'continue');
    });

    it('stops at the wedge limit', () => {
      assert.equal(churn.nextStep({ wedges: churn.STOP_AT_WEDGES, pool: pool(40) }), 'reproduced');
    });

    it('stops at the global PTY limit, before the wedge check', () => {
      const atLimit = Math.ceil(511 * churn.STOP_AT_POOL_RATIO);
      assert.equal(churn.nextStep({ wedges: 0, pool: pool(atLimit) }), 'aborted-pool');
      assert.equal(churn.nextStep({ wedges: 99, pool: pool(atLimit) }), 'aborted-pool');
    });

    it('stops when it cannot measure: a blind run cannot enforce its own limits', () => {
      assert.equal(churn.nextStep({ wedges: 0, pool: null }), 'aborted-unmeasured');
      assert.equal(churn.nextStep({ wedges: null, pool: pool(40) }), 'aborted-unmeasured');
    });
  });

  describe('LifetimeTracker — how long an exiting child really lives', () => {
    it('records a child\'s exiting span once it is gone, and ignores live children', () => {
      const t = new churn.LifetimeTracker();
      t.observe([{ pid: 10, stat: '?Es', ageMs: 0 }, { pid: 11, stat: 'Ss', ageMs: 0 }], 1000);
      t.observe([{ pid: 10, stat: '?Es', ageMs: 0 }], 1250);
      t.observe([{ pid: 10, stat: '?Es', ageMs: 0 }], 1500);
      t.observe([], 1750);
      assert.deepEqual(t.lifetimes, [500]);
    });

    it('reports a child seen in only one sample as a zero-length span, not as missing', () => {
      const t = new churn.LifetimeTracker();
      t.observe([{ pid: 10, stat: 'Z', ageMs: 0 }], 1000);
      t.observe([], 1250);
      assert.deepEqual(t.lifetimes, [0]);
    });

    it('reports children still exiting at the end, with how long they have been', () => {
      const t = new churn.LifetimeTracker();
      t.observe([{ pid: 10, stat: '?Es', ageMs: 0 }], 1000);
      assert.deepEqual(t.stillOpen(31000), [30000]);
      assert.deepEqual(t.lifetimes, []);
    });
  });

  describe('percentiles', () => {
    it('uses nearest rank and reports the maximum', () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      assert.deepEqual(churn.percentiles(values), { n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
    });

    it('returns nulls for no data rather than zeros', () => {
      assert.deepEqual(churn.percentiles([]), { n: 0, p50: null, p95: null, p99: null, max: null });
    });
  });

  describe('returned', () => {
    it('allows the tolerance, refuses beyond it, and is null when unmeasured', () => {
      assert.equal(churn.returned(30, 30 + churn.POOL_TOLERANCE, churn.POOL_TOLERANCE), true);
      assert.equal(churn.returned(30, 31 + churn.POOL_TOLERANCE, churn.POOL_TOLERANCE), false);
      assert.equal(churn.returned(null, 30, 3), null);
      assert.equal(churn.returned(30, null, 3), null);
    });
  });

  describe('verdict — a run earns only what it measured', () => {
    it('a baseline that hit the wedge limit reproduced the leak', () => {
      const v = churn.verdict({ ...passingCandidate(), mode: 'baseline', stop: 'reproduced', confirmedWedges: churn.STOP_AT_WEDGES });
      assert.equal(v.verdict, 'reproduced');
    });

    it('a baseline that did not reproduce says so, with the numbers', () => {
      const v = churn.verdict({ ...passingCandidate(), mode: 'baseline', cycles: 300, confirmedWedges: 1 });
      assert.equal(v.verdict, 'not-reproduced');
      assert.match(v.why.join(), /only 1 confirmed wedges in 300 cycles/);
    });

    it('a control run with any wedge is a harness fault', () => {
      assert.equal(churn.verdict({ ...passingCandidate(), mode: 'control', confirmedWedges: 1 }).verdict, 'harness-fault');
      assert.equal(churn.verdict({ ...passingCandidate(), mode: 'control' }).verdict, 'pass');
    });

    it('a candidate passes only on the full R22 Q7 contract', () => {
      assert.deepEqual(churn.verdict(passingCandidate()), { verdict: 'pass', why: [] });
    });

    it('a candidate fails on any wedge, any lingering child, any restart, or resources that did not return', () => {
      for (const bad of [{ confirmedWedges: 1 }, { lingering: 1 }, { restarts: 1 }, { poolReturned: false }, { fdsReturned: false }]) {
        assert.equal(churn.verdict(passingCandidate(bad)).verdict, 'fail', JSON.stringify(bad));
      }
    });

    it('a clean candidate short of the cycles, the soak or a resource measurement is inconclusive, never a pass', () => {
      for (const short of [
        { cycles: churn.ACCEPT_CYCLES - 1 },
        { soakMs: churn.ACCEPT_SOAK_MS - 1 },
        { poolReturned: null },
        { fdsReturned: null },
        { lingering: null }
      ]) {
        assert.equal(churn.verdict(passingCandidate(short)).verdict, 'inconclusive', JSON.stringify(short));
      }
    });

    it('a run stopped by the pool limit, or blind, is inconclusive in every mode', () => {
      for (const mode of ['baseline', 'control', 'candidate']) {
        assert.equal(churn.verdict(passingCandidate({ mode, stop: 'aborted-pool' })).verdict, 'inconclusive', mode);
        assert.equal(churn.verdict(passingCandidate({ mode, stop: 'aborted-unmeasured' })).verdict, 'inconclusive', mode);
      }
    });

    it('a run whose clients failed, or that never saw output, proves nothing in any mode', () => {
      for (const mode of ['baseline', 'candidate']) {
        assert.equal(churn.verdict(passingCandidate({ mode, clientErrors: 1 })).verdict, 'inconclusive', mode);
        assert.equal(churn.verdict(passingCandidate({ mode, withOutput: 0 })).verdict, 'inconclusive', mode);
      }
      // A run of only never-reading clients cannot see output, by design.
      assert.equal(churn.verdict(passingCandidate({ withOutput: 0, outputExpected: false })).verdict, 'pass');
      // The control's child writes nothing by design, so no output is expected there.
      assert.equal(churn.verdict(passingCandidate({ mode: 'control', withOutput: 0 })).verdict, 'pass');
      assert.equal(churn.verdict(passingCandidate({ mode: 'control', clientErrors: 2 })).verdict, 'inconclusive');
    });

    it('a failed cleanup is always named and blocks a pass', () => {
      const v = churn.verdict(passingCandidate({ cleanupOk: false }));
      assert.equal(v.verdict, 'fail');
      assert.match(v.why.join(), /cleanup did not verify/);
    });
  });

  describe('scripts/ttyd-churn.js parseArgs', () => {
    it('requires a mode, and defaults a candidate to the full acceptance cycle count', () => {
      assert.throws(() => parseArgs([]), /--mode must be/);
      assert.equal(parseArgs(['--mode', 'candidate']).cycles, churn.ACCEPT_CYCLES);
      assert.equal(parseArgs(['--mode', 'baseline']).concurrency, churn.MAX_CONCURRENCY);
    });

    it('runs every close mode by default, and only the named ones with --modes', () => {
      assert.deepEqual(parseArgs(['--mode', 'baseline']).modes, [...churn.CLOSE_MODES]);
      assert.deepEqual(parseArgs(['--mode', 'candidate', '--modes', 'noread,replay']).modes, ['noread', 'replay']);
      assert.throws(() => parseArgs(['--mode', 'candidate', '--modes', 'noread,sideways']), /--modes must be/);
    });

    it('refuses an unknown argument or a bad cycle count rather than guessing', () => {
      assert.throws(() => parseArgs(['--mode', 'baseline', '--cyles', '5']), /unknown argument/);
      assert.throws(() => parseArgs(['--mode', 'baseline', '--cycles', '0']), /positive integer/);
    });
  });
});
