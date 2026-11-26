'use strict';

/**
 * v6 (#3267, V6-018 / V6-038, Car V665-W1-A): deriving one car's
 * real-time 5-status lifecycle (`not-started` / `in-progress` /
 * `in-review` / `completed` / `deployed`, plus a `blocked` overlay) from
 * the live signals that actually exist today, instead of the binary
 * "not started -> merged" jump the issue's own Problem section names.
 *
 * Scope boundary (#3267 AC2, Never silently drop a requirement): this
 * module is the PURE DERIVATION only. It takes already-fetched signals
 * (a workload receipt, a GitHub PR's state, the wave scheduler's own run
 * state, and 4-Gate/CI verdicts) and returns a verdict; it does not
 * itself call `tc workload`, the GitHub API, or parse `LANE_QUEUE.md`/
 * `roadmap2-data.json` (that fetching lives outside this car's `lib/v6/`
 * envelope, in server/route code), and it does not touch
 * `public/v6-shell.js`'s Sprint & Cars VIEW rendering (V6-038) — a later
 * car's integration is one function call per car.
 *
 * @module lib/v6/sprint-car-status-sync
 */

const { CAR_STATUSES: WAVE_RUN_STATUSES } = require('./c3-wave-scheduler');

/** Error for status-sync input that does not match this module's contract. */
class SprintCarStatusSyncError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Refuse unless `cond` holds.
 * @param {boolean} cond
 * @param {string} code
 * @param {string} message
 * @returns {void}
 * @throws {SprintCarStatusSyncError}
 */
function need(cond, code, message) {
  if (!cond) throw new SprintCarStatusSyncError(code, message);
}

/**
 * The 5-status car/train lifecycle the issue's own Problem section names,
 * in their natural progression order.
 * @type {ReadonlyArray<string>}
 */
const CAR_LIFECYCLE_STATUSES = Object.freeze(['not-started', 'in-progress', 'in-review', 'completed', 'deployed']);

/** `tc workload set`'s own states (`CLAUDE.md`'s Session Memory / workload rules). */
const WORKLOAD_STATES = Object.freeze(['working', 'waiting-external', 'blocked', 'complete']);

/** A GitHub PR's state, as `gh`/the GitHub API reports it, plus `'none'` for no PR opened yet. */
const PR_STATES = Object.freeze(['none', 'OPEN', 'MERGED', 'CLOSED']);

/** The 4-Gate + CI checks AC1 names (`O-Gate`, `A-Gate`, `Gate 3`, `R-Gate`, `CI`). */
const GATE_NAMES = Object.freeze(['oGate', 'aGate', 'gate3', 'rGate', 'ci']);

/** Each named gate's own verdict. */
const GATE_VERDICTS = Object.freeze(['pending', 'pass', 'fail']);

/**
 * `lib/v6/c3-wave-scheduler.js`'s own, lower-level DAG engine states,
 * mapped onto this module's user-facing 5-status lifecycle — reused
 * rather than re-derived, so the two vocabularies cannot silently drift
 * against each other. `cancelled` has no real lifecycle equivalent (a
 * cancelled car is not "in progress" toward anything); it maps to `null`,
 * meaning "this signal has nothing to contribute," not "not-started."
 * @type {Readonly<Object<string, string|null>>}
 */
const WAVE_RUN_STATUS_TO_LIFECYCLE = Object.freeze({
  pending: 'not-started',
  running: 'in-progress',
  'awaiting-gate': 'in-review',
  'gate-held': 'in-review',
  complete: 'completed',
  stalled: 'in-progress',
  cancelled: null
});

/**
 * A wave run state that itself signals a blocker, independent of any
 * gate's own `fail` verdict — `gate-held` and `stalled` both mean
 * something is stuck, even before a specific gate reports `fail`.
 * @type {ReadonlySet<string>}
 */
const WAVE_RUN_STATUS_BLOCKS = Object.freeze(new Set(['gate-held', 'stalled']));

/**
 * The lifecycle status a PR's own state settles outright — a PR existing
 * at all is never "not started," and its state alone overrides every
 * other signal below it in {@link deriveCarStatus}'s precedence.
 * @param {{prState?: string, deployed?: boolean}|null} pr
 * @returns {string|null} `null` when `pr` carries no PR (not yet opened).
 */
function _statusFromPr(pr) {
  const p = pr || {};
  if (p.prState === 'MERGED') return p.deployed === true ? 'deployed' : 'completed';
  if (p.prState === 'OPEN') return 'in-review';
  return null;
}

/**
 * Derive one car's real-time 5-status lifecycle bucket plus a `blocked`
 * overlay (#3267 AC1) from whichever live signals the caller has.
 * Precedence, most authoritative first:
 *   1. The PR's own state ({@link _statusFromPr}) — a PR existing at all
 *      is never "not started," and settles `completed`/`deployed`/
 *      `in-review` outright.
 *   2. The wave scheduler's own run state ({@link
 *      WAVE_RUN_STATUS_TO_LIFECYCLE}), when no PR exists yet or the PR
 *      state maps to nothing (never, today, but defensive).
 *   3. The workload receipt's own state, as the coarsest fallback.
 *   4. `'not-started'`, when none of the above says anything.
 * `blocked`/`blockedBy` are reported ALONGSIDE the bucket, never instead
 * of it — an `in-review` car blocked by a failed gate is reported as
 * `in-review`, blocked: true, not silently reclassified into some other
 * bucket a caller never asked for.
 * @param {{
 *   workload?: {state?: string}|null,
 *   pr?: {prState?: string, deployed?: boolean}|null,
 *   waveRunState?: string|null,
 *   gates?: Object<string, string>|null
 * }} signals
 * @returns {{status: string, blocked: boolean, blockedBy: string[]}}
 * @throws {SprintCarStatusSyncError} `WORKLOAD_STATE_INVALID`, `PR_STATE_INVALID`,
 *   `WAVE_RUN_STATE_INVALID`, `GATE_NAME_INVALID`, `GATE_VERDICT_INVALID`
 */
function deriveCarStatus(signals) {
  const s = signals || {};

  if (s.workload && s.workload.state !== undefined) {
    need(WORKLOAD_STATES.includes(s.workload.state), 'WORKLOAD_STATE_INVALID',
      `workload.state must be one of ${WORKLOAD_STATES.join(', ')}`);
  }
  if (s.pr && s.pr.prState !== undefined) {
    need(PR_STATES.includes(s.pr.prState), 'PR_STATE_INVALID', `pr.prState must be one of ${PR_STATES.join(', ')}`);
  }
  if (s.waveRunState != null) {
    need(WAVE_RUN_STATUSES.includes(s.waveRunState), 'WAVE_RUN_STATE_INVALID',
      `waveRunState must be one of ${WAVE_RUN_STATUSES.join(', ')}`);
  }
  const gates = s.gates || {};
  for (const [name, verdict] of Object.entries(gates)) {
    need(GATE_NAMES.includes(name), 'GATE_NAME_INVALID', `unknown gate "${name}", expected one of ${GATE_NAMES.join(', ')}`);
    need(GATE_VERDICTS.includes(verdict), 'GATE_VERDICT_INVALID', `gate "${name}"'s verdict must be one of ${GATE_VERDICTS.join(', ')}`);
  }

  const fromPr = _statusFromPr(s.pr);
  const fromWaveRun = s.waveRunState != null ? WAVE_RUN_STATUS_TO_LIFECYCLE[s.waveRunState] : null;
  const fromWorkload = s.workload && s.workload.state
    ? (s.workload.state === 'complete' ? 'completed' : 'in-progress')
    : null;
  const status = fromPr || fromWaveRun || fromWorkload || 'not-started';

  const blockedBy = [];
  if (s.workload && s.workload.state === 'blocked') blockedBy.push('workload');
  if (s.waveRunState && WAVE_RUN_STATUS_BLOCKS.has(s.waveRunState)) blockedBy.push(`waveRun:${s.waveRunState}`);
  for (const [name, verdict] of Object.entries(gates)) {
    if (verdict === 'fail') blockedBy.push(name);
  }

  return { status, blocked: blockedBy.length > 0, blockedBy };
}

module.exports = {
  SprintCarStatusSyncError,
  CAR_LIFECYCLE_STATUSES,
  WORKLOAD_STATES,
  PR_STATES,
  GATE_NAMES,
  GATE_VERDICTS,
  WAVE_RUN_STATUS_TO_LIFECYCLE,
  deriveCarStatus
};
