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
    ownedPtysReturned: true,
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

  describe('run-owned resources (Architect ruling on chunk 07)', () => {
    const T = 'Fri Sep 26 03:00:00 2026';
    const PS = [
      `    1     0     1 Ss   13-02:11:47 Sat Sep 13 00:48:13 2026`,
      `  500     1   500 S    01:00:00 ${T}`,
      `  600   500   600 Ss+  00:10 Fri Sep 26 03:59:50 2026`,
      `  601   600   600 S+   00:09 Fri Sep 26 03:59:51 2026`,
      `  700   500   700 ?Es  00:05 Fri Sep 26 03:59:55 2026`,
      `  900     1   900 S    02:00:00 Fri Sep 26 02:00:00 2026`
    ].join('\n');

    it('parses pid, ppid, pgid, state and elapsed time', () => {
      const t = churn.parseProcTable(PS);
      assert.equal(t.length, 6);
      assert.deepEqual(t[3], { pid: 601, ppid: 600, pgid: 600, stat: 'S+', etime: '00:09', lstart: 'Fri Sep 26 03:59:51 2026' });
    });

    it('finds every descendant, however deep, and nothing else', () => {
      assert.deepEqual(churn.descendantsOf(churn.parseProcTable(PS), 500).map((r) => r.pid).sort(), [600, 601, 700]);
    });

    // THE GAP THE RULING NAMED: a process that outlives the scratch ttyd is
    // reparented to launchd, so an end-time walk of ttyd's tree misses it.
    it('still finds a recorded process after it has been reparented to launchd', () => {
      const ledger = new churn.ProcessLedger(500);
      ledger.record(churn.parseProcTable(PS));
      const after = churn.parseProcTable('    1     0     1 Ss   13-02:11:47 Sat Sep 13 00:48:13 2026\n  700     1   700 ?Es  00:40 Fri Sep 26 03:59:55 2026\n  900     1   900 S    02:00:00 Fri Sep 26 02:00:00 2026');
      assert.deepEqual(ledger.survivors(after).map((r) => r.pid), [700], 'the reparented survivor is caught; the unrelated 900 is not');
    });

    it('catches a process forked into a recorded group after the last sample', () => {
      const ledger = new churn.ProcessLedger(500);
      ledger.record(churn.parseProcTable(PS));
      const after = churn.parseProcTable('  650     1   600 S    00:01 Fri Sep 26 04:00:10 2026');
      assert.deepEqual(ledger.survivors(after).map((r) => r.pid), [650]);
    });

    // macOS recycles PIDs, and a two-hour run spawns tens of thousands of
    // processes: a PID alone could make an unrelated process a "survivor".
    it('does not mistake a new process that reused a recorded PID for a survivor', () => {
      const ledger = new churn.ProcessLedger(500);
      ledger.record(churn.parseProcTable(PS));
      const after = churn.parseProcTable('  700     1   700 S    00:02 Fri Sep 26 05:10:00 2026');
      assert.deepEqual(ledger.survivors(after), [], 'same PID 700, different start time: not ours');
    });

    it('measures PTYs only over processes that are exactly the run\'s own (PID and start time)', () => {
      const ledger = new churn.ProcessLedger(500);
      ledger.record(churn.parseProcTable(PS));
      const later = churn.parseProcTable([
        `  500     1   500 S    01:00:00 ${T}`,
        '  700     1   700 S    00:02 Fri Sep 26 05:10:00 2026'
      ].join('\n'));
      assert.deepEqual(ledger.owned(later).map((r) => r.pid), [500], 'the recycled 700 is not the run\'s 700');
    });

    it('keeps every start time seen for a PID, so a later leak on a reused run PID is still caught', () => {
      const ledger = new churn.ProcessLedger(500);
      ledger.record(churn.parseProcTable(PS));
      ledger.record(churn.parseProcTable(`  500     1   500 S    01:00:00 ${T}\n  700   500   700 ?Es  00:01 Fri Sep 26 04:30:00 2026`));
      const after = churn.parseProcTable('  700     1   700 ?Es  00:40 Fri Sep 26 04:30:00 2026');
      assert.deepEqual(ledger.survivors(after).map((r) => r.pid), [700], 'the second 700 is the one that leaked');
    });

    it('does not claim a group whose id was reused by a new leader', () => {
      const ledger = new churn.ProcessLedger(500);
      ledger.record(churn.parseProcTable(PS));
      const after = churn.parseProcTable([
        '  600     1   600 Ss   00:05 Fri Sep 26 05:10:00 2026',
        '  651   600   600 S    00:04 Fri Sep 26 05:10:01 2026'
      ].join('\n'));
      assert.deepEqual(ledger.survivors(after), [], 'group 600 now has a different leader');
    });

    it('counts slave PTYs by name and master handles by count from lsof -F pn', () => {
      const out = 'p500\nn/dev/ptmx\nn/dev/ptmx\nn/dev/null\np700\nn/dev/ttys042\nn/dev/ttys042\nn/tmp/x.sock';
      assert.deepEqual(churn.parseLsofPtys(out), { slaves: ['/dev/ttys042'], masters: 2 });
    });

    it('says the run\'s PTYs returned only when nothing extra is held, and null when unmeasured', () => {
      const base = { slaves: [], masters: 0 };
      assert.equal(churn.ownedPtysReturned(base, { slaves: [], masters: 0 }), true);
      assert.equal(churn.ownedPtysReturned(base, { slaves: ['/dev/ttys042'], masters: 0 }), false);
      assert.equal(churn.ownedPtysReturned(base, { slaves: [], masters: 1 }), false);
      assert.equal(churn.ownedPtysReturned(null, base), null);
    });

    it('never judges a run by the GLOBAL pool: the verdict has no input for it', () => {
      assert.equal(churn.verdict({ ...passingCandidate(), poolReturned: false }).verdict, 'pass',
        'a stray global-pool flag changes nothing');
    });

    describe('lsofOutput — only a recognized reading is a reading', () => {
      const exit1 = () => Object.assign(new Error('Command failed'), { code: 1, killed: false, signal: null });
      const alive = (set) => (pid) => set.has(pid);

      it('keeps a clean run\'s output, and treats empty clean output as "nothing held"', () => {
        assert.equal(churn.lsofOutput(null, 'p1\nn/dev/ptmx', [1], alive(new Set([1]))), 'p1\nn/dev/ptmx');
        assert.equal(churn.lsofOutput(null, '', [1], alive(new Set([1]))), '');
      });

      it('keeps exit 1 when a missing process is exiting or a zombie, which lsof cannot list', () => {
        // mustBeReported is false for an E/Z process: the kernel has already torn
        // its file table down, and its PTY masters are listed under ttyd.
        const mustBeReported = (pid) => pid === 1;
        assert.equal(churn.lsofOutput(exit1(), 'p1\nn/dev/ptmx\nn/dev/ptmx', [1, 700], mustBeReported), 'p1\nn/dev/ptmx\nn/dev/ptmx');
      });

      it('keeps exit 1 when every missing process has really gone (lsof\'s ordinary vanished case)', () => {
        assert.equal(churn.lsofOutput(exit1(), 'p1\nn/dev/ptmx', [1, 2], alive(new Set([1]))), 'p1\nn/dev/ptmx');
        assert.equal(churn.lsofOutput(exit1(), '', [2, 3], alive(new Set())), '', 'all vanished: truly nothing held');
      });

      // THE CONDITION THE ARCHITECT SET: an arbitrary exit 1 — a permission
      // failure, say — is not an empty measurement.
      it('rejects exit 1 when a missing process is still alive, or the output names an unrequested one', () => {
        assert.equal(churn.lsofOutput(exit1(), 'p1\nn/dev/ptmx', [1, 2], alive(new Set([1, 2]))), null, '2 is alive but unreported');
        assert.equal(churn.lsofOutput(exit1(), '', [2], alive(new Set([2]))), null, 'empty output for a live process');
        assert.equal(churn.lsofOutput(exit1(), 'p9\nn/dev/ptmx', [1], alive(new Set())), null, 'reported a process never asked about');
      });

      it('rejects a timeout, a signal, a buffer overflow or any other exit as unmeasured', () => {
        const cases = [
          { code: null, killed: true, signal: 'SIGTERM' },
          { code: 1, killed: false, signal: 'SIGKILL' },
          { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' },
          { code: 2, killed: false, signal: null }
        ];
        for (const c of cases) assert.equal(churn.lsofOutput(Object.assign(new Error('x'), c), 'p1\nn/dev/ptmx', [1], alive(new Set())), null, JSON.stringify(c));
      });
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
      assert.equal(churn.returned(30, 30 + churn.FD_TOLERANCE, churn.FD_TOLERANCE), true);
      assert.equal(churn.returned(30, 31 + churn.FD_TOLERANCE, churn.FD_TOLERANCE), false);
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
      for (const bad of [{ confirmedWedges: 1 }, { lingering: 1 }, { restarts: 1 }, { ownedPtysReturned: false }, { fdsReturned: false }]) {
        assert.equal(churn.verdict(passingCandidate(bad)).verdict, 'fail', JSON.stringify(bad));
      }
    });

    it('a clean candidate short of the cycles, the soak or a resource measurement is inconclusive, never a pass', () => {
      for (const short of [
        { cycles: churn.ACCEPT_CYCLES - 1 },
        { soakMs: churn.ACCEPT_SOAK_MS - 1 },
        { ownedPtysReturned: null },
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

    it('records the clearing review id given with --review', () => {
      assert.equal(parseArgs(['--mode', 'candidate', '--review', 'rev-x']).review, 'rev-x');
      assert.equal(parseArgs(['--mode', 'candidate']).review, null);
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
