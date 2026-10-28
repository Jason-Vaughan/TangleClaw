'use strict';

/**
 * Shared pane-writer behavior behind `launch-unready.js` and `launch-kickoff.js`
 * (#1669).
 *
 * Both modules watch a session's tmux pane, decide whether it is safe to type
 * into, and type one line into it — but each owns a different one-shot state
 * machine around that mechanics: `launch-unready` counts its nudge only AFTER
 * a successful send, while `launch-kickoff` claims its fire-once slot BEFORE
 * sending and releases it only on a pre-send bailout. This module extracts
 * the mechanics the two share (pane capture, idle assessment with a
 * best-effort cursor fallback, and injection classification) and leaves every
 * state-machine decision — when to count, when to claim, when to release —
 * with the caller.
 *
 * Every dependency (`capturePane`, `cursorInfo`, `assessIdle`, `inject`,
 * `activityLog`) is passed in by the caller on each call, rather than owned
 * here: both callers' own test suites stub these seams directly on their own
 * `_internal` object, and a seam owned by this module instead would be
 * invisible to those stubs.
 *
 * @module lib/launch-pane-writer
 */

/**
 * Capture a pane's tail and assess whether it is idle enough to type into,
 * with the cursor read treated as best-effort: a cursor probe failure falls
 * back to the weaker text check rather than losing the caller's turn.
 *
 * A pane-capture failure is not swallowed here — it propagates to the
 * caller — because the two callers disagree on what a capture failure means:
 * `launch-unready` ends its tick on it, `launch-kickoff` keeps polling.
 * @param {string} tmuxName - The tmux session name
 * @param {object} opts
 * @param {function} opts.capturePane - `(tmuxName, {lines}) => {lines: string[]}`
 * @param {function} opts.cursorInfo - `(tmuxName) => cursor`, best-effort
 * @param {function} opts.assessIdle - The shared idle gate (`medusaWake.assessSessionIdle`)
 * @param {object} opts.profile - The engine's wake profile
 * @param {number} opts.lineCount - How many pane lines to capture
 * @param {string} [opts.prevDigest] - The previous tick's/poll's pane digest
 * @param {number} [opts.idleTicks=0] - Consecutive idle observations so far
 * @param {function} [opts.onCursorError] - Called with the error when `cursorInfo` throws
 * @returns {{idle: boolean, reason: string, digest: string, idleTicks: number}}
 */
function assessPaneIdle(tmuxName, opts) {
  const { capturePane, cursorInfo, assessIdle, profile, lineCount, prevDigest, idleTicks = 0, onCursorError } = opts;
  const captured = capturePane(tmuxName, { lines: lineCount });
  let cursor = null;
  try {
    cursor = cursorInfo(tmuxName);
  } catch (err) {
    if (onCursorError) onCursorError(err);
  }
  return assessIdle({ lines: (captured && captured.lines) || [], profile, cursor, prevDigest, idleTicks });
}

/**
 * Type one line into a session's pane and classify the result.
 *
 * Classification only: the caller still decides what the classification
 * means for its own state (whether to count a nudge, whether to keep a
 * claimed fire-once slot) and still does its own logging, since the two
 * callers log at different levels with different metadata.
 * @param {function} inject - `(projectName, line, options) => {ok, error, controlRefusal}`
 * @param {string} projectName
 * @param {string} line - The one line to type
 * @param {object} options - Passed through to `inject`
 * @returns {{code: ('sent'|'control-held'|'inject-failed'), sent: object}}
 */
function injectLine(inject, projectName, line, options) {
  const sent = inject(projectName, line, options);
  if (!sent.ok && sent.controlRefusal) return { code: 'control-held', sent };
  if (!sent.ok) return { code: 'inject-failed', sent };
  return { code: 'sent', sent };
}

/**
 * Log an activity entry, swallowing a failure so a timeline write is never
 * the reason a launch step does not happen.
 * @param {function} activityLog - `(entry) => void`, the caller's `store.activity.log`
 * @param {object} log - The caller's module logger
 * @param {string} warnMessage - Logged, with the entry's `eventType` and the error, on failure
 * @param {object} entry
 * @returns {void}
 */
function logActivityBestEffort(activityLog, log, warnMessage, entry) {
  try {
    activityLog(entry);
  } catch (err) {
    log.warn(warnMessage, { eventType: entry.eventType, error: err.message });
  }
}

module.exports = { assessPaneIdle, injectLine, logActivityBestEffort };
