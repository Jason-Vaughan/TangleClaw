'use strict';

/*
 * Scheduling around the wake gates (#2086): a slow or hung pane must not
 * serially stall the recipients scanned after it.
 *
 * Three rules are under test, and each only ever adds a deferral:
 *   - a tick stops reading panes once it has spent its budget, or met one slow
 *     read, and the sessions it did not reach wait one tick (`scan-deferred`);
 *   - those sessions are scanned first on the next tick;
 *   - a pane whose read was slow is left alone for a growing interval
 *     (`pane-read-backoff`) and one ordinary read clears it.
 *
 * Time is the synthetic fleet's virtual clock, so every number here is exact.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('medusa-wake-scheduling');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');
const matrix = require('./helpers/medusa-wake-matrix');

const HUNG_MS = 5000;

/**
 * Install a fleet, run `fn` against it, and always restore the monitor.
 * @template T
 * @param {object[]} fleet - `matrix.buildFleet` output, or hand-built sessions
 * @param {object} opts - `matrix.install` options
 * @param {(world: object) => T} fn - The test body
 * @returns {T}
 */
function withFleet(fleet, opts, fn) {
  const world = matrix.install(fleet, opts);
  try {
    return fn(world);
  } finally {
    world.restore();
  }
}

/**
 * How many times one session's pane was read.
 * @param {object} world - The installed world
 * @param {number} sessionId - The session
 * @returns {number}
 */
const readsOf = (world, sessionId) => world.paneReads.filter((r) => r.sessionId === sessionId).length;

describe('wake scheduling — a hung pane is read once per backoff, not once per tick (#2086)', () => {
  it('after one slow read the pane is left alone, and the ticks that follow are ordinary again', () => {
    const fleet = matrix.buildFleet({ size: 30, lead: ['slow'] });
    withFleet(fleet, {}, (world) => {
      const ticks = matrix.runTicks(world, 3);
      assert.equal(readsOf(world, fleet[0].record.id), 1, 'the hung pane was read on the first tick only');
      assert.ok(ticks[0].durationMs >= HUNG_MS);
      assert.ok(ticks[1].durationMs < wake.PANE_READ_BUDGET_MS, `second tick took ${ticks[1].durationMs} ms`);
      assert.ok(ticks[2].durationMs < wake.PANE_READ_BUDGET_MS, `third tick took ${ticks[2].durationMs} ms`);
      assert.equal(wake.tickMetrics().last.order.find((o) => o.id === fleet[0].record.id).result, 'pane-read-backoff');
    });
  });

  it('the backoff grows with each slow read in a row and stops growing at its last step', () => {
    const hung = matrix.makeSession(1, 'slow');
    withFleet([hung], {}, (world) => {
      matrix.runTicks(world, 60);
      const at = world.paneReads.map((r) => r.at);
      assert.ok(at.length >= 5, `the pane was retried ${at.length} times`);
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      gaps.forEach((gap, i) => {
        const step = wake.PANE_BACKOFF_MS[Math.min(i, wake.PANE_BACKOFF_MS.length - 1)];
        // A read ends one timeout after it starts, and the backoff runs from there.
        assert.ok(gap >= HUNG_MS + step, `retry ${i + 1} came ${gap} ms after the last, under ${HUNG_MS + step}`);
        assert.ok(gap < HUNG_MS + step + 2 * matrix.INTERVAL_MS, `retry ${i + 1} came ${gap} ms after the last, well past its backoff`);
      });
    });
  });

  it('one ordinary read clears the backoff, and the recipient is then nudged once like any other', () => {
    const recovering = matrix.makeSession(1, 'slow', { slowReads: 1 });
    withFleet([recovering], {}, (world) => {
      matrix.runTicks(world, 12);
      assert.equal(world.injected.filter((n) => n.sessionId === 1).length, 1);
      // One slow read, then exactly the two at-rest observations the debounce asks for.
      const before = world.paneReads.filter((r) => r.at < world.injected[0].at).length;
      assert.equal(before, 1 + wake.IDLE_TICKS_REQUIRED);
    });
  });

  it('a pane that recovers and then hangs again starts its backoff from the first step', () => {
    const flaky = matrix.makeSession(1, 'busy');
    flaky.slowReadsLeft = 1;
    withFleet([flaky], {}, (world) => {
      // One slow read, then ticks until an ordinary one lands.
      while (world.paneReads.length < 2) matrix.runTicks(world, 1);
      flaky.slowReadsLeft = 1;
      while (world.paneReads.length < 3) matrix.runTicks(world, 1);
      const hungAgainAt = world.paneReads[2].at;
      while (world.paneReads.length < 4) matrix.runTicks(world, 1);
      const gap = world.paneReads[3].at - hungAgainAt;
      assert.ok(gap >= HUNG_MS + wake.PANE_BACKOFF_MS[0], `retried after ${gap} ms`);
      assert.ok(gap < HUNG_MS + wake.PANE_BACKOFF_MS[1], `retried after ${gap} ms, which is the second step, not the first`);
    });
  });

  it('a session in backoff is never typed into', () => {
    const hung = matrix.makeSession(1, 'slow');
    withFleet([hung], {}, (world) => {
      matrix.runTicks(world, 30);
      assert.equal(world.injected.length, 0);
    });
  });
});

describe('wake scheduling — several hung panes cost one timeout per tick between them (#2086)', () => {
  it('a fleet whose every pane read hangs holds no tick for more than one timeout', () => {
    const fleet = matrix.buildFleet({ size: 12, lead: new Array(11).fill('slow'), fillers: ['slow'] });
    withFleet(fleet, {}, (world) => {
      const ticks = matrix.runTicks(world, 8);
      for (const [i, t] of ticks.entries()) {
        const slowReads = world.paneReads.filter((r) => r.at >= t.startedAt && r.at < t.startedAt + t.durationMs
          && fleet.find((x) => x.record.id === r.sessionId).state === 'slow').length;
        assert.ok(slowReads <= 1, `tick ${i + 1} read ${slowReads} hung panes`);
        assert.ok(t.durationMs < HUNG_MS + 1000, `tick ${i + 1} took ${t.durationMs} ms`);
      }
      assert.equal(world.injected.filter((n) => n.sessionId !== fleet[11].record.id).length, 0);
    });
  });

  it('a read that is slow without reaching the budget still ends the tick\'s pane reads', () => {
    const slowMs = 3000;
    assert.ok(slowMs >= wake.SLOW_PANE_READ_MS && slowMs < wake.PANE_READ_BUDGET_MS);
    const fleet = matrix.buildFleet({ size: 6, lead: new Array(5).fill('slow') });
    withFleet(fleet, { slowMs }, (world) => {
      const ticks = matrix.runTicks(world, 4);
      for (const [i, t] of ticks.entries()) {
        assert.ok(t.durationMs < slowMs + 1000, `tick ${i + 1} took ${t.durationMs} ms`);
      }
    });
  });

  for (const hung of [1, 2, 3]) {
    it(`${hung} hung pane(s) scanned first at 30 sessions: the last recipient is still woken, once`, () => {
      const cell = matrix.runCell({ size: 30, lead: new Array(hung).fill('slow'), maxTicks: 20 });
      assert.equal(cell.nudgesToEligible, 1);
      assert.equal(cell.nudgesToOthers, 0);
    });
  }
});

describe('wake scheduling — the pane-read budget and its fairness (#2086)', () => {
  // A second per session: far over an ordinary read, and still under the
  // slow-read line, so only the budget is in play.
  const COSTS = { capturePane: 600, cursorInfo: 400 };

  it('a tick stops reading panes at its budget, and every session is still read within a few ticks', () => {
    const fleet = matrix.buildFleet({ size: 13, fillers: ['busy'] });
    withFleet(fleet, { costs: COSTS }, (world) => {
      const ticks = matrix.runTicks(world, 5);
      for (const [i, t] of ticks.entries()) {
        assert.ok(t.durationMs <= wake.PANE_READ_BUDGET_MS + 1500, `tick ${i + 1} took ${t.durationMs} ms`);
      }
      assert.deepEqual(
        [...new Set(world.paneReads.map((r) => r.sessionId))].sort((a, b) => a - b),
        fleet.map((x) => x.record.id)
      );
    });
  });

  it('sessions a tick deferred are scanned first on the next, in their roster order', () => {
    const fleet = matrix.buildFleet({ size: 13, fillers: ['busy'] });
    withFleet(fleet, { costs: COSTS }, (world) => {
      matrix.runTicks(world, 1);
      const first = wake.tickMetrics().last.order;
      const deferred = first.filter((o) => o.result === 'scan-deferred').map((o) => o.id);
      assert.ok(deferred.length > 0, 'the first tick deferred nothing');
      assert.deepEqual(first.map((o) => o.id), fleet.map((x) => x.record.id), 'the first tick scans in roster order');
      matrix.runTicks(world, 1);
      const second = wake.tickMetrics().last.order;
      assert.deepEqual(second.slice(0, deferred.length).map((o) => o.id), deferred);
      assert.notEqual(second[0].result, 'scan-deferred', 'a session deferred last tick is read on this one');
    });
  });

  it('a recipient in a fleet over its budget is nudged on two consecutive ticks, once', () => {
    const fleet = matrix.buildFleet({ size: 13, fillers: ['busy'] });
    withFleet(fleet, { costs: COSTS }, (world) => {
      const eligible = fleet[12].record.id;
      let ticks = 0;
      while (ticks < 20 && world.injected.length === 0) { matrix.runTicks(world, 1); ticks += 1; }
      assert.equal(world.injected.length, 1);
      assert.equal(world.injected[0].sessionId, eligible);
      const reads = world.paneReads.filter((r) => r.sessionId === eligible && r.at < world.injected[0].at);
      assert.equal(reads.length, wake.IDLE_TICKS_REQUIRED);
      assert.ok(reads[1].at - reads[0].at <= matrix.INTERVAL_MS + 10, `its two observations were ${reads[1].at - reads[0].at} ms apart`);
      matrix.runTicks(world, 6);
      assert.equal(world.injected.length, 1, 'and it is not nudged again');
    });
  });

  it('a deferred session is recorded as pending, never as a skip in the delivery ledger', () => {
    const fleet = matrix.buildFleet({ size: 13, fillers: ['busy'] });
    withFleet(fleet, { costs: COSTS }, (world) => {
      matrix.runTicks(world, 2);
      assert.ok(world.facts.some((f) => f.fact === 'wake_pending' && f.code === 'scan-deferred'));
      assert.equal(world.recorded.filter((r) => r.skipReason === 'scan-deferred').length, 0);
    });
  });

  it('an ordinary fleet never reaches the budget: 30 sessions with mail in every pane defer nothing', () => {
    const cell = matrix.runCell({ size: 30, fillers: ['busy', 'draft'] });
    assert.ok(!cell.verdicts.includes('scan-deferred'));
    assert.equal(cell.nudgesToEligible, 1);
  });
});

describe('wake scheduling — a tick that did not look at a pane is not an observation of it (#2086)', () => {
  it('a pane seen at rest, then deferred, is not nudged on its next observation: it needs two fresh consecutive ones', () => {
    // Two recipients at rest. Both are seen at rest on the first tick. On the
    // second, the first one's pane read hangs, so the second is deferred.
    const first = matrix.makeSession(1, 'idle-mail');
    const second = matrix.makeSession(2, 'idle-mail');
    withFleet([first, second], {}, (world) => {
      const nudged = () => world.injected.filter((n) => n.sessionId === 2).length;
      const reads = () => readsOf(world, 2);
      matrix.runTicks(world, 1);
      assert.equal(reads(), 1);
      first.slowReadsLeft = 1;
      matrix.runTicks(world, 1);
      assert.equal(reads(), 1, 'the second recipient was deferred behind the hung read');
      assert.equal(wake.tickMetrics().last.order.find((o) => o.id === 2).result, 'scan-deferred');
      matrix.runTicks(world, 1);
      assert.equal(reads(), 2);
      assert.equal(nudged(), 0, 'one observation after the gap is not enough, though the pane was at rest before it');
      matrix.runTicks(world, 1);
      assert.equal(reads(), 3);
      assert.equal(nudged(), 1);
    });
  });

  it('a pane seen at rest, then backed off after a slow read, needs two fresh consecutive observations', () => {
    const only = matrix.makeSession(1, 'idle-mail');
    withFleet([only], {}, (world) => {
      matrix.runTicks(world, 1);
      assert.equal(readsOf(world, 1), 1);
      only.slowReadsLeft = 1;
      let ticks = 0;
      while (ticks < 12 && world.injected.length === 0) { matrix.runTicks(world, 1); ticks += 1; }
      assert.equal(world.injected.length, 1);
      const reads = world.paneReads.filter((r) => r.at < world.injected[0].at);
      // At rest, hung, then two ordinary reads one tick apart.
      assert.equal(reads.length, 4);
      assert.ok(reads[3].at - reads[2].at <= matrix.INTERVAL_MS + 10);
      assert.ok(reads[2].at - reads[1].at >= HUNG_MS + wake.PANE_BACKOFF_MS[0]);
    });
  });

  it('a slow read that still answers counts as no observation once the pane is backed off', () => {
    const only = matrix.makeSession(1, 'idle-mail');
    only.slowAnswersLeft = 1;
    withFleet([only], { slowMs: 3000 }, (world) => {
      let ticks = 0;
      while (ticks < 12 && world.injected.length === 0) { matrix.runTicks(world, 1); ticks += 1; }
      assert.equal(world.injected.length, 1);
      const reads = world.paneReads.filter((r) => r.at < world.injected[0].at);
      // The slow answer showed the pane at rest, and it still takes two more.
      assert.equal(reads.length, 1 + wake.IDLE_TICKS_REQUIRED);
      assert.ok(reads[2].at - reads[1].at <= matrix.INTERVAL_MS + 10);
    });
  });

  it('a pane that moved during the gap is seen as writing, not at rest', () => {
    const first = matrix.makeSession(1, 'idle-mail');
    const second = matrix.makeSession(2, 'idle-mail');
    withFleet([first, second], {}, (world) => {
      matrix.runTicks(world, 1);
      first.slowReadsLeft = 1;
      matrix.runTicks(world, 1);
      // While it was deferred, the second recipient's transcript gained a line.
      second.pane = ['a line of new output', ...second.pane];
      matrix.runTicks(world, 1);
      assert.equal(wake.tickMetrics().last.order.find((o) => o.id === 2).result, 'pane-writing');
      assert.equal(world.injected.filter((n) => n.sessionId === 2).length, 0);
    });
  });
});

describe('wake scheduling — what the two holds are, and are not (#2086)', () => {
  it('both new verdicts have a meaning a sender can be shown', () => {
    assert.match(wake.peerReasonMeaning('scan-deferred'), /next/);
    assert.match(wake.peerReasonMeaning('pane-read-backoff'), /slow/);
  });

  it('a clock that cannot be read never defers or backs off: every pane is read every tick, as before', () => {
    const fleet = matrix.buildFleet({ size: 5, lead: ['slow'] });
    withFleet(fleet, { clock: () => { throw new Error('no clock'); } }, (world) => {
      matrix.runTicks(world, 3);
      assert.equal(readsOf(world, fleet[0].record.id), 3);
      assert.equal(world.injected.filter((n) => n.sessionId === fleet[4].record.id).length, 1);
      assert.equal(world.injected.length, 1);
    });
  });

  it('stop() forgets backoffs and deferrals', () => {
    const fleet = matrix.buildFleet({ size: 3, lead: ['slow'] });
    withFleet(fleet, {}, (world) => {
      matrix.runTicks(world, 1);
      assert.equal(readsOf(world, fleet[0].record.id), 1);
      wake.stop();
      matrix.runTicks(world, 1);
      assert.equal(readsOf(world, fleet[0].record.id), 2);
    });
  });

  for (const engine of ['claude', 'antigravity']) {
    it(`${engine}: a mixed fleet behind a hung pane nudges the one eligible recipient and no other`, () => {
      const cell = matrix.runCell({ size: 10, engine, lead: ['slow'] });
      assert.equal(cell.nudgesToEligible, 1);
      assert.equal(cell.nudgesToOthers, 0);
    });

    it(`${engine}: a fleet over its pane-read budget nudges the one eligible recipient and no other`, () => {
      const cell = matrix.runCell({ size: 13, engine, fillers: ['busy', 'draft'], costs: { capturePane: 600, cursorInfo: 400 }, maxTicks: 20 });
      assert.equal(cell.nudgesToEligible, 1);
      assert.equal(cell.nudgesToOthers, 0);
    });
  }
});
