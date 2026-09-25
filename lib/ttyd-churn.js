'use strict';

/**
 * The decisions behind the ttyd churn harness (#1245), kept free of processes
 * so each one can be tested: whether a run may start, when it must stop, what
 * counts as a wedged child, how long exiting children really live, and what
 * verdict a run earns. `scripts/ttyd-churn.js` drives a scratch ttyd with these.
 *
 * The harness exists to answer one question with evidence rather than
 * inference: does a given ttyd + attach-script pair leave children stuck in the
 * exiting state under websocket churn? It must be able to say "yes" (the
 * installed build is expected to), "no" (a fix), and must never say either
 * about a run it could not measure.
 */

// Host guards (Architect ruling R22 Q6). A run shares the machine's PTY pool
// with the live service, so it is capped hard and stopped early.
const MAX_CONCURRENCY = 10;
const STOP_AT_WEDGES = 5;
const STOP_AT_POOL_RATIO = 0.25;
// Refuse to START above this, leaving room below the stop line for the run
// itself (10 clients plus whatever wedges before the stop fires).
const PREFLIGHT_MAX_POOL_RATIO = 0.15;
// A child exiting for this long has not merely been slow to exit: a normal
// `tmux attach` exits in milliseconds. Used only inside the harness, where the
// sampler sees every child from birth.
const WEDGE_FLOOR_MS = 10 * 1000;
// Acceptance for a candidate that may ship (R22 Q7).
const ACCEPT_CYCLES = 2000;
const ACCEPT_SOAK_MS = 2 * 60 * 60 * 1000;
const RETURN_WINDOW_MS = 30 * 1000;
// Resources are "back to baseline" within this slack: the host keeps opening
// and closing its own terminals while a run is in progress.
const POOL_TOLERANCE = 3;
const FD_TOLERANCE = 4;

const CLOSE_MODES = Object.freeze(['clean', 'abrupt', 'paused', 'replay', 'noread']);

/**
 * Decide whether a run may start.
 * @param {object} facts
 * @param {string} facts.platform - `process.platform`.
 * @param {string|null} facts.ttydLeakState - The live health panel's `ttyd-leak` state, or null if unreadable.
 * @param {{used: number, cap: number}|null} facts.pool - Global PTY pool, or null if unreadable.
 * @param {boolean} facts.socketInUse - Whether the scratch socket path already exists.
 * @param {string|null} facts.ttydBin - Resolved ttyd binary, or null.
 * @param {string|null} facts.tmuxBin - Resolved tmux binary, or null.
 * @param {number} facts.concurrency - Requested concurrency.
 * @returns {{ok: boolean, reasons: string[]}}
 */
function checkPreflight(facts) {
  const reasons = [];
  if (facts.platform !== 'darwin') reasons.push(`platform is ${facts.platform}; the leak and this harness are macOS-only`);
  if (facts.ttydLeakState !== 'clear') {
    reasons.push(`the live health panel's ttyd row is ${facts.ttydLeakState === null ? 'unreadable' : facts.ttydLeakState}, not clear`);
  }
  if (!facts.pool) {
    reasons.push('the global PTY pool could not be read');
  } else if (facts.pool.used / facts.pool.cap > PREFLIGHT_MAX_POOL_RATIO) {
    reasons.push(`global PTY use is ${facts.pool.used}/${facts.pool.cap}, above the ${Math.round(PREFLIGHT_MAX_POOL_RATIO * 100)}% start limit`);
  }
  if (facts.socketInUse) reasons.push('the scratch socket path already exists: another run may be live');
  if (!facts.ttydBin) reasons.push('no ttyd binary was found');
  if (!facts.tmuxBin) reasons.push('no tmux binary was found');
  if (!Number.isInteger(facts.concurrency) || facts.concurrency < 1 || facts.concurrency > MAX_CONCURRENCY) {
    reasons.push(`concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * The scratch ttyd's children that are exiting (`E`/`Z`) and have been for at
 * least `floorMs`.
 * @param {Array<{pid: number, stat: string, ageMs: number|null}>} children - From `_parseChildren`.
 * @param {number} [floorMs=WEDGE_FLOOR_MS]
 * @returns {Array<{pid: number, stat: string, ageMs: number|null}>}
 */
function scratchWedges(children, floorMs = WEDGE_FLOOR_MS) {
  return children.filter((c) => (c.stat.includes('E') || c.stat.includes('Z'))
    && c.ageMs !== null && c.ageMs >= floorMs);
}

/**
 * Decide, between batches, whether the run continues.
 * @param {object} s
 * @param {number|null} s.wedges - Confirmed scratch wedges now, or null if the children could not be read.
 * @param {{used: number, cap: number}|null} s.pool - Global PTY pool now, or null.
 * @returns {'continue'|'reproduced'|'aborted-pool'|'aborted-unmeasured'}
 */
function nextStep(s) {
  // A blind run is not a safe run: without the pool, the 25% stop cannot fire.
  if (!s.pool || s.wedges === null) return 'aborted-unmeasured';
  if (s.pool.used / s.pool.cap >= STOP_AT_POOL_RATIO) return 'aborted-pool';
  // Every mode stops here: a baseline has shown the leak, and a candidate
  // has failed. Neither earns more cycles against the shared pool.
  if (s.wedges >= STOP_AT_WEDGES) return 'reproduced';
  return 'continue';
}

/**
 * Tracks each exiting child of the scratch ttyd across samples, so the run can
 * report how long an exiting child really lives. That distribution is what sets
 * the watcher's wedge age from data rather than a guess (R22 Q3).
 */
class LifetimeTracker {
  constructor() {
    this._open = new Map();
    this.lifetimes = [];
  }

  /**
   * Record one sample.
   * @param {Array<{pid: number, stat: string, ageMs: number|null}>} children - The scratch ttyd's children now.
   * @param {number} now - Sample time, ms.
   * @returns {void}
   */
  observe(children, now) {
    const seen = new Set();
    for (const c of children) {
      if (!(c.stat.includes('E') || c.stat.includes('Z'))) continue;
      seen.add(c.pid);
      if (!this._open.has(c.pid)) this._open.set(c.pid, { firstSeen: now, lastSeen: now });
      else this._open.get(c.pid).lastSeen = now;
    }
    for (const [pid, span] of this._open) {
      if (seen.has(pid)) continue;
      // Gone since the last sample. Its exiting time is at least lastSeen -
      // firstSeen; a child seen once lived under one sample interval.
      this.lifetimes.push(span.lastSeen - span.firstSeen);
      this._open.delete(pid);
    }
  }

  /**
   * Children still exiting at the end of the run, with how long they have been.
   * @param {number} now - Time, ms.
   * @returns {number[]}
   */
  stillOpen(now) {
    return [...this._open.values()].map((span) => now - span.firstSeen);
  }
}

/**
 * Nearest-rank percentiles of a list of durations.
 * @param {number[]} values
 * @returns {{n: number, p50: number|null, p95: number|null, p99: number|null, max: number|null}}
 */
function percentiles(values) {
  if (values.length === 0) return { n: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] };
}

/**
 * Whether a resource count came back to its baseline.
 * @param {number|null} baseline
 * @param {number|null} final
 * @param {number} tolerance
 * @returns {boolean|null} null when either side was not measured.
 */
function returned(baseline, final, tolerance) {
  if (baseline === null || final === null) return null;
  return final <= baseline + tolerance;
}

/**
 * The verdict a finished run earns. A run that could not measure what its
 * verdict depends on gets `inconclusive`, never a pass.
 *
 * - `baseline` expects the leak: `reproduced` confirms the mechanism (and that the
 *   harness can see it); anything else means the harness or the hypothesis is wrong.
 * - `control` runs a command that exits cleanly and must show zero wedges; a
 *   wedge there means the harness is producing its own.
 * - `candidate` is a fix: it must meet R22 Q7 in full.
 *
 * @param {object} r
 * @param {'baseline'|'control'|'candidate'} r.mode
 * @param {string} r.stop - The `nextStep` outcome that ended the run, or `'completed'`.
 * @param {number} r.cycles - Websocket open/close cycles completed.
 * @param {number} r.soakMs - Quiet soak time completed after the churn.
 * @param {number} r.confirmedWedges - Maximum confirmed scratch wedges seen.
 * @param {number} r.restarts - Scratch ttyd restarts during the run.
 * @param {boolean|null} r.poolReturned
 * @param {boolean|null} r.fdsReturned
 * @param {boolean} r.cleanupOk - Every scratch process ended and was verified gone.
 * @returns {{verdict: 'reproduced'|'not-reproduced'|'pass'|'fail'|'harness-fault'|'inconclusive', why: string[]}}
 */
function verdict(r) {
  const why = [];
  if (!r.cleanupOk) why.push('cleanup did not verify: a scratch process may remain');
  if (r.stop === 'aborted-unmeasured') return { verdict: 'inconclusive', why: [...why, 'a measurement failed mid-run'] };
  if (r.stop === 'aborted-pool') return { verdict: 'inconclusive', why: [...why, 'stopped at the global PTY limit'] };

  if (r.mode === 'baseline') {
    if (r.confirmedWedges >= STOP_AT_WEDGES) return { verdict: 'reproduced', why };
    return { verdict: 'not-reproduced', why: [...why, `only ${r.confirmedWedges} confirmed wedges in ${r.cycles} cycles`] };
  }
  if (r.mode === 'control') {
    if (r.confirmedWedges > 0) return { verdict: 'harness-fault', why: [...why, `${r.confirmedWedges} wedges from a command that exits cleanly`] };
    return { verdict: why.length ? 'inconclusive' : 'pass', why };
  }
  if (r.confirmedWedges > 0) why.push(`${r.confirmedWedges} confirmed wedges`);
  if (r.restarts > 0) why.push(`${r.restarts} restarts`);
  if (r.poolReturned === false) why.push('the PTY pool did not return to baseline');
  if (r.fdsReturned === false) why.push('ttyd\'s fd count did not return to baseline');
  if (why.length) return { verdict: 'fail', why };
  const short = [];
  if (r.cycles < ACCEPT_CYCLES) short.push(`${r.cycles} of ${ACCEPT_CYCLES} cycles`);
  if (r.soakMs < ACCEPT_SOAK_MS) short.push(`${Math.round(r.soakMs / 60000)} of ${ACCEPT_SOAK_MS / 60000} soak minutes`);
  if (r.poolReturned === null || r.fdsReturned === null) short.push('resource return was not measured');
  if (short.length) return { verdict: 'inconclusive', why: short };
  return { verdict: 'pass', why };
}

module.exports = {
  checkPreflight,
  scratchWedges,
  nextStep,
  LifetimeTracker,
  percentiles,
  returned,
  verdict,
  MAX_CONCURRENCY,
  STOP_AT_WEDGES,
  STOP_AT_POOL_RATIO,
  PREFLIGHT_MAX_POOL_RATIO,
  WEDGE_FLOOR_MS,
  ACCEPT_CYCLES,
  ACCEPT_SOAK_MS,
  RETURN_WINDOW_MS,
  POOL_TOLERANCE,
  FD_TOLERANCE,
  CLOSE_MODES
};
