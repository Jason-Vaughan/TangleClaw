'use strict';

/**
 * Measure a timer-driven pass over a list of items (#2086).
 *
 * The Medusa wake monitor and the delivery watchdog each run one synchronous
 * pass per `setInterval` tick. Neither recorded how long a pass took, whether
 * it started late, or which item in the pass was slow, so "the fleet is too
 * large for the tick" could be argued and not measured. A meter records those
 * facts and nothing else.
 *
 * It observes; it decides nothing. A pass runs the same items in the same
 * order and returns the same results whether or not it is metered, and a meter
 * that throws must never be the reason a pass does not run, so every recording
 * call is non-throwing.
 *
 * Everything is in memory and bounded: `capacity` passes are kept, and one
 * item list, the last pass's.
 */

const { performance } = require('node:perf_hooks');

const DEFAULT_CAPACITY = 120;

/**
 * The value at a percentile of an ascending list, by nearest rank.
 * @param {number[]} sorted - Ascending values
 * @param {number} p - Percentile, 0 to 100
 * @returns {number|null} Null for an empty list
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Summarize a list of durations.
 * @param {number[]} values - Milliseconds
 * @returns {{p50: number|null, p95: number|null, max: number|null}}
 */
function summarize(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.length ? sorted[sorted.length - 1] : null };
}

/**
 * Create a meter for one timer-driven pass.
 * @param {object} [opts]
 * @param {number} [opts.capacity=120] - Passes kept
 * @param {() => number} [opts.clock] - Monotonic milliseconds (a seam for tests)
 * @returns {{schedule: Function, unschedule: Function, begin: Function, snapshot: Function, reset: Function}}
 */
function createTickMeter(opts = {}) {
  const capacity = Number.isInteger(opts.capacity) && opts.capacity > 0 ? opts.capacity : DEFAULT_CAPACITY;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => performance.now();
  let intervalMs = null;
  let expectedAt = null;
  let passes = [];
  let lastItems = [];
  let total = 0;
  let overruns = 0;

  /**
   * Say the pass is now on a timer, so lateness can be measured.
   * @param {number} interval - Timer interval in ms
   * @returns {void}
   */
  function schedule(interval) {
    intervalMs = interval;
    try { expectedAt = clock() + interval; } catch { expectedAt = null; }
  }

  /**
   * Say the timer has stopped. Recorded passes are kept.
   * @returns {void}
   */
  function unschedule() {
    intervalMs = null;
    expectedAt = null;
  }

  /**
   * Forget every recorded pass.
   * @returns {void}
   */
  function reset() {
    passes = [];
    lastItems = [];
    total = 0;
    overruns = 0;
  }

  /**
   * Start measuring one pass.
   * @param {object} [o]
   * @param {boolean} [o.scheduled=false] - Whether the timer fired this pass. A
   *   pass a test or a caller runs by hand has no schedule to be late against.
   * @returns {{item: Function, end: Function}}
   */
  function begin(o = {}) {
    let startedAt = null;
    let lagMs = null;
    try {
      startedAt = clock();
      if (o.scheduled && expectedAt !== null && intervalMs !== null) {
        lagMs = Math.max(0, startedAt - expectedAt);
      }
      // Node re-arms an interval from the moment its callback starts, so the
      // next pass is due one interval after this one began, however late it was.
      if (o.scheduled && intervalMs !== null) expectedAt = startedAt + intervalMs;
    } catch { /* an unreadable clock leaves this pass unmeasured */ }
    const items = [];

    /**
     * Run one item of the pass and record how long it took.
     * @template T
     * @param {string|number} id - What the item is, for the report
     * @param {() => T} fn - The item's work
     * @returns {T} Whatever `fn` returned; an error it throws is rethrown
     */
    function item(id, fn) {
      let t0 = null;
      try { t0 = clock(); } catch { /* unmeasured */ }
      const entry = { id, position: items.length, ms: null, result: null, threw: false };
      items.push(entry);
      try {
        const result = fn();
        entry.result = typeof result === 'string' ? result : null;
        return result;
      } catch (err) {
        entry.threw = true;
        throw err;
      } finally {
        try { if (t0 !== null) entry.ms = clock() - t0; } catch { /* unmeasured */ }
      }
    }

    /**
     * Finish the pass and keep its record.
     * @returns {void}
     */
    function end() {
      try {
        const durationMs = startedAt === null ? null : clock() - startedAt;
        let slowest = null;
        for (const it of items) if (it.ms !== null && (slowest === null || it.ms > slowest.ms)) slowest = it;
        const overran = intervalMs !== null && durationMs !== null && durationMs > intervalMs;
        total += 1;
        if (overran) overruns += 1;
        passes.push({
          lagMs, durationMs, items: items.length, overran,
          threw: items.filter((it) => it.threw).length,
          slowest: slowest ? { id: slowest.id, position: slowest.position, ms: slowest.ms } : null
        });
        if (passes.length > capacity) passes = passes.slice(passes.length - capacity);
        lastItems = items;
      } catch { /* a meter never fails the pass it measures */ }
    }

    return { item, end };
  }

  /**
   * What the meter has recorded.
   * @returns {{intervalMs: number|null, passes: number, overruns: number, window: object, last: object|null}}
   */
  function snapshot() {
    const last = passes.length ? passes[passes.length - 1] : null;
    return {
      intervalMs,
      passes: total,
      overruns,
      window: {
        size: passes.length,
        durationMs: summarize(passes.map((p) => p.durationMs).filter((v) => v !== null)),
        lagMs: summarize(passes.map((p) => p.lagMs).filter((v) => v !== null)),
        maxItems: passes.reduce((m, p) => Math.max(m, p.items), 0)
      },
      last: last ? { ...last, order: lastItems.map((it) => ({ ...it })) } : null
    };
  }

  return { schedule, unschedule, begin, snapshot, reset };
}

module.exports = { createTickMeter, percentile, summarize };
