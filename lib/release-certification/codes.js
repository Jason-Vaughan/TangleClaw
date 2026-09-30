'use strict';

/**
 * The closed vocabulary of release-candidate certification.
 *
 * A certification's evidence is read by the public scorecard, the registry
 * cards and the release promotion step. None of them may parse prose, so every
 * state, every reason an interval did not count and every reason a run failed
 * is one of the codes below. A code nothing here declares is a programming
 * error, not a new kind of evidence.
 *
 * The categories are disjoint, and the category decides the effect:
 * - an EXTEND code makes the interval it names earn no qualified time;
 * - a HARD_FAIL code ends the run in `failed`, and nothing reopens it;
 * - a TRANSITION code names why the state moved when no failure or extension did;
 * - a REFUSAL code is thrown by an operation the current state does not allow.
 *
 * @module lib/release-certification/codes
 */

/** Schema tag carried by every persisted certification document. */
const SCHEMA = 'tc.release-certification/v1';

/**
 * Certification states. `failed`, `passed` and `cancelled` are terminal.
 * @type {Readonly<Record<string, string>>}
 */
const STATES = Object.freeze({
  NOT_STARTED: 'not-started',
  RUNNING: 'running',
  EXTENDED: 'extended',
  FAILED: 'failed',
  AWAITING_REVIEW: 'awaiting-review',
  PASSED: 'passed',
  CANCELLED: 'cancelled'
});

/** @type {readonly string[]} */
const TERMINAL_STATES = Object.freeze([STATES.FAILED, STATES.PASSED, STATES.CANCELLED]);

/**
 * Reasons an interval earns no qualified time. Listed in the order they are
 * reported when several apply, so the first one is the interval's primary
 * reason: what stopped the clock before anything about the samples themselves.
 * @type {Readonly<Record<string, string>>}
 */
const EXTEND = Object.freeze({
  MONITOR_GAP: 'MONITOR_GAP',
  SLEEP_DETECTED: 'SLEEP_DETECTED',
  CLOCK_SKEW: 'CLOCK_SKEW',
  INTERVAL_TOO_LONG: 'INTERVAL_TOO_LONG',
  SERVER_RESTARTED: 'SERVER_RESTARTED',
  PROBE_UNKNOWN: 'PROBE_UNKNOWN',
  ISOLATION_UNATTESTED: 'ISOLATION_UNATTESTED',
  RUNTIME_UNPROVEN: 'RUNTIME_UNPROVEN',
  GITHUB_UNAVAILABLE: 'GITHUB_UNAVAILABLE',
  CHECKS_PENDING: 'CHECKS_PENDING',
  PTY_TARGET_UNMET: 'PTY_TARGET_UNMET'
});

/**
 * Conditions that end a run. Listed in reporting priority: the guest's
 * isolation first (a breach, a reboot or a changed packet filter invalidates
 * everything else it observed), then the candidate itself, then the runtime
 * claiming to be it, then the ttyd it owns, then the required checks.
 * @type {Readonly<Record<string, string>>}
 */
const HARD_FAIL = Object.freeze({
  ISOLATION_BREACHED: 'ISOLATION_BREACHED',
  BOOT_CHANGED: 'BOOT_CHANGED',
  ISOLATION_CHANGED: 'ISOLATION_CHANGED',
  HEAD_DRIFT: 'HEAD_DRIFT',
  WORKTREE_NOT_DETACHED: 'WORKTREE_NOT_DETACHED',
  WORKTREE_DIRTY: 'WORKTREE_DIRTY',
  SERVER_NOT_IN_WORKTREE: 'SERVER_NOT_IN_WORKTREE',
  RUNTIME_SHA_MISMATCH: 'RUNTIME_SHA_MISMATCH',
  RUNTIME_CHECKOUT_DRIFT: 'RUNTIME_CHECKOUT_DRIFT',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  TTYD_NOT_APPLICABLE: 'TTYD_NOT_APPLICABLE',
  TTYD_NOT_OWNED: 'TTYD_NOT_OWNED',
  TTYD_GENERATION_CHANGED: 'TTYD_GENERATION_CHANGED',
  LEAK_FIRED: 'LEAK_FIRED',
  WEDGED_CHILD: 'WEDGED_CHILD',
  ORPHAN_GATE: 'ORPHAN_GATE',
  REQUIRED_CHECK_FAILED: 'REQUIRED_CHECK_FAILED'
});

/**
 * Why a state moved when neither a failure nor an extension moved it.
 * @type {Readonly<Record<string, string>>}
 */
const TRANSITION = Object.freeze({
  ADMITTED: 'ADMITTED',
  RECOVERED: 'RECOVERED',
  TARGET_REACHED: 'TARGET_REACHED',
  OPERATOR_ACCEPTED: 'OPERATOR_ACCEPTED',
  OPERATOR_CANCELLED: 'OPERATOR_CANCELLED'
});

/**
 * Every state change a certification may make, and the codes that may explain
 * it: the one definition the state machine asserts its own transitions
 * against and the branch verifier judges published history by. It is how the
 * verifier refuses a published `passed` that skipped review, or review that
 * did not follow a live run. That is a check on the history's shape, not
 * evidence that the run it describes took place.
 * @type {readonly {from: string, to: string, codes: readonly string[]}[]}
 */
const TRANSITIONS = Object.freeze([
  { from: STATES.NOT_STARTED, to: STATES.RUNNING, codes: Object.freeze([TRANSITION.ADMITTED]) },
  { from: STATES.RUNNING, to: STATES.EXTENDED, codes: Object.freeze(Object.values(EXTEND)) },
  { from: STATES.EXTENDED, to: STATES.RUNNING, codes: Object.freeze([TRANSITION.RECOVERED]) },
  { from: STATES.RUNNING, to: STATES.AWAITING_REVIEW, codes: Object.freeze([TRANSITION.TARGET_REACHED]) },
  { from: STATES.EXTENDED, to: STATES.AWAITING_REVIEW, codes: Object.freeze([TRANSITION.TARGET_REACHED]) },
  { from: STATES.RUNNING, to: STATES.FAILED, codes: Object.freeze(Object.values(HARD_FAIL)) },
  { from: STATES.EXTENDED, to: STATES.FAILED, codes: Object.freeze(Object.values(HARD_FAIL)) },
  { from: STATES.AWAITING_REVIEW, to: STATES.FAILED, codes: Object.freeze(Object.values(HARD_FAIL)) },
  { from: STATES.AWAITING_REVIEW, to: STATES.PASSED, codes: Object.freeze([TRANSITION.OPERATOR_ACCEPTED]) },
  { from: STATES.RUNNING, to: STATES.CANCELLED, codes: Object.freeze([TRANSITION.OPERATOR_CANCELLED]) },
  { from: STATES.EXTENDED, to: STATES.CANCELLED, codes: Object.freeze([TRANSITION.OPERATOR_CANCELLED]) },
  { from: STATES.AWAITING_REVIEW, to: STATES.CANCELLED, codes: Object.freeze([TRANSITION.OPERATOR_CANCELLED]) }
]);

/**
 * Whether one transition, with its code, is allowed.
 * @param {string} from - State before
 * @param {string} to - State after
 * @param {string} code - Why
 * @returns {boolean} True when the table allows it
 */
function transitionAllowed(from, to, code) {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.codes.includes(code));
}

/**
 * Whether a state can be reached from another through zero or more allowed
 * transitions: the test for two published scorecards of one run, which may
 * be several transitions apart.
 * @param {string} from - Earlier state
 * @param {string} to - Later state
 * @returns {boolean} True when reachable
 */
function reachable(from, to) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift();
    if (at === to) return true;
    for (const t of TRANSITIONS) {
      if (t.from === at && !seen.has(t.to)) {
        seen.add(t.to);
        queue.push(t.to);
      }
    }
  }
  return false;
}

/**
 * Refusals thrown by operations on a certification and by its evidence store.
 * @type {Readonly<Record<string, string>>}
 */
const REFUSAL = Object.freeze({
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  INVALID_SAMPLE: 'INVALID_SAMPLE',
  INVALID_ACTOR: 'INVALID_ACTOR',
  ADMISSION_REFUSED: 'ADMISSION_REFUSED',
  NOT_AWAITING_REVIEW: 'NOT_AWAITING_REVIEW',
  NOT_CANONICAL: 'NOT_CANONICAL',
  ALREADY_TERMINAL: 'ALREADY_TERMINAL',
  STORE_UNSAFE: 'STORE_UNSAFE',
  RUN_EXISTS: 'RUN_EXISTS',
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  MANIFEST_TAMPERED: 'MANIFEST_TAMPERED',
  EVIDENCE_CORRUPT: 'EVIDENCE_CORRUPT',
  LOCK_HELD: 'LOCK_HELD',
  LOCK_LOST: 'LOCK_LOST',
  PUBLISH_FAILED: 'PUBLISH_FAILED',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  ADMISSION_CONFLICT: 'ADMISSION_CONFLICT',
  ADMISSION_UNPUBLISHED: 'ADMISSION_UNPUBLISHED',
  EVENTS_DIVERGED: 'EVENTS_DIVERGED',
  WOULD_VIOLATE: 'WOULD_VIOLATE',
  METRICS_TREE_UNSAFE: 'METRICS_TREE_UNSAFE',
  NOT_HOST_ATTESTED: 'NOT_HOST_ATTESTED',
  NOT_FINALIZED: 'NOT_FINALIZED',
  HISTORY_INVALID: 'HISTORY_INVALID',
  NOT_FAST_FORWARD: 'NOT_FAST_FORWARD',
  PUBLICATION_MISMATCH: 'PUBLICATION_MISMATCH',
  RECORD_CONFLICT: 'RECORD_CONFLICT',
  FINALIZATION_SEALED: 'FINALIZATION_SEALED'
});

/**
 * Where a reason came from: one of a sample's probes, the clocks, the runner,
 * or (for an interval) the previous sample's own reason.
 * @type {readonly string[]}
 */
const PROBES = Object.freeze(['worktree', 'server', 'ttyd', 'github', 'pty', 'clock', 'runner', 'prior-sample']);

/**
 * The values a probe reports for one required check.
 * @type {readonly string[]}
 */
const CHECK_STATES = Object.freeze(['success', 'failure', 'pending', 'missing']);

/** The ttyd leak condition's states, as `lib/system-health.js` reports them. */
const LEAK_STATES = Object.freeze(['fired', 'clear', 'unknown']);

/**
 * A refused certification operation, carrying one REFUSAL code and bounded
 * facts (codes, states, sequence numbers), never paths or prose to parse.
 */
class CertificationError extends Error {
  /**
   * @param {string} code - One of REFUSAL
   * @param {string} message - Human-readable reason
   * @param {object} [details] - Bounded facts
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CertificationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Whether a state is terminal.
 * @param {string} state - A STATES value
 * @returns {boolean} True for failed, passed and cancelled
 */
function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Rank a code by its position in its category's declared order.
 * @param {Readonly<Record<string, string>>} category - EXTEND or HARD_FAIL
 * @param {string} code - A code from that category
 * @returns {number} Its priority; lower reports first
 */
function priority(category, code) {
  return Object.values(category).indexOf(code);
}

module.exports = {
  SCHEMA,
  STATES,
  TERMINAL_STATES,
  EXTEND,
  HARD_FAIL,
  TRANSITION,
  REFUSAL,
  PROBES,
  CHECK_STATES,
  LEAK_STATES,
  TRANSITIONS,
  CertificationError,
  isTerminal,
  priority,
  transitionAllowed,
  reachable
};
