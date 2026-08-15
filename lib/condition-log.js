'use strict';

/**
 * Loud once per condition, quiet while it persists, loud again when it recurs.
 *
 * The problem this exists for: a condition that is reported from inside a poll
 * is reported at the poll's cadence, not the condition's. A wedged tmux server
 * does not un-wedge between reads, so a listing that logs on every failure
 * emits the same line every ten seconds for as long as a dashboard tab is open
 * — and the wedge (#94/#144/#380) is precisely when an operator goes looking at
 * the log, so the diagnostic they need is buried under its own repetitions.
 *
 * `lib/git.js` `_reportIncomplete` solved this first, and this is that rule
 * lifted out so the sites that came after it share the behaviour rather than
 * each growing a near-copy. It is deliberately NOT retrofitted onto git.js:
 * that set is cleared by the git cache's lifecycle rather than by a successful
 * read, so the two re-arm on different events, and unifying them would change
 * git's behaviour to close a duplication nobody is being hurt by.
 *
 * RE-ARMING IS THE HALF A NAIVE "WARN ONCE" GETS WRONG. Suppressing forever
 * turns a recurring incident into a single line from hours ago; the second
 * wedge, after a recovery, is a new incident and has to be as loud as the
 * first. `resolved()` is what makes that true, which is why every caller must
 * call it on the path where the read succeeded — not only on the failing one.
 *
 * Per process, with no timer. This runs in a server the supervisor recreates,
 * so the state dies with the process and a genuinely new incident after a
 * restart is loud again — without an interval to tune, and without a timer to
 * get wrong.
 *
 * @param {object} log - A `createLogger` instance; needs the levels used.
 * @returns {{ report: (key: string, level: string, message: string, meta?: object) => void,
 *             resolved: (key: string) => void,
 *             _size: () => number }}
 */
function createConditionLog(log) {
  const active = new Set();

  return {
    /**
     * Report that a condition holds. First report is at `level`; while it keeps
     * holding, reports drop to `debug` so the log still carries the evidence
     * without drowning in it.
     * @param {string} key - Identifies the condition, NOT the call. One wedged
     *   tmux server is one key however many callers meet it; one unreachable
     *   pane must not silence a different pane, so panes key per session.
     * @param {string} level - Level for the FIRST report, e.g. `warn`, `error`.
     * @param {string} message - Log message.
     * @param {object} [meta] - Structured fields.
     * @returns {void}
     */
    report(key, level, message, meta) {
      const effective = active.has(key) ? 'debug' : level;
      active.add(key);
      log[effective](message, meta);
    },

    /**
     * Record that the condition no longer holds, so its next occurrence is loud
     * again. Call this on the SUCCESS path — a read that answered is the only
     * evidence a wedge is over.
     * @param {string} key - The same key `report` was called with.
     * @returns {void}
     */
    resolved(key) {
      active.delete(key);
    },

    /**
     * Number of conditions currently held. Test seam — lets a guard assert the
     * set is actually cleared rather than inferring it from log volume.
     * @returns {number}
     */
    _size() {
      return active.size;
    }
  };
}

module.exports = { createConditionLog };
