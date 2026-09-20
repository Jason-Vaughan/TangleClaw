'use strict';

/**
 * Wrap prompt delivery receipt (#1685).
 *
 * `lib/tmux.js::sendKeys` returning without throwing means tmux accepted
 * characters into a pty. It does NOT mean the engine turned them into a task.
 * `lib/wrap-steps/ai-content.js` logged `prompt sent` on that basis, so a
 * prompt that never became a task was indistinguishable from a slow model and
 * the run waited the full `MAX_WAIT_MS` before reporting a generic
 * non-completion.
 *
 * This module answers the narrower question the send site can actually ask:
 * **after the submit, does the pane show evidence the prompt became a task?**
 *
 * ## Three outcomes, and why the third is not a failure of nerve
 *
 * - `accepted` — positive evidence: the engine is working, or the text we sent
 *   is echoed in the transcript.
 * - `not-accepted` — positive evidence of the opposite: the composer is holding
 *   input. Our text was pasted and never submitted.
 * - `unknown` — the pane is at rest with an empty composer and no echo, or the
 *   engine declares no wake vocabulary, or the pane could not be read.
 *
 * `unknown` is a first-class value and never degrades into either neighbour.
 * Collapsing it into `accepted` restores the exact bug this module exists to
 * fix, one layer up. Collapsing it into `not-accepted` invents failures on the
 * two engines that declare no vocabulary, which is worse than today because it
 * would block wraps that currently work.
 *
 * That discipline is not a new idea here: `lib/sessions.js#_paneIsBusy` (#1134)
 * already answers `null` rather than `false` for an engine with no declared
 * marker, for the same reason. Car 21.10 shipped the opposite mistake three
 * times in one train — a value made honest at one level and flattened at the
 * next — and it is the defect class this module is written against.
 *
 * ## What this deliberately does NOT do
 *
 * It never re-pastes and never re-sends Enter. #1685 requires that duplicate
 * submission be prevented, and a re-send on a misread `not-accepted` submits
 * the same task twice. The receipt REPORTS; remediation is a separate decision
 * with its own evidence.
 *
 * ## The bias this creates, stated
 *
 * An `unknown` still costs the caller its existing wait. This module closes the
 * case it can prove — input left sitting in the composer — and refuses to
 * manufacture certainty about the case it cannot. What changes for `unknown` is
 * the *reason text*: the caller can now say what was and was not observed
 * instead of blaming the model for not finishing.
 */

const medusaWake = require('./medusa-wake');
const tmux = require('./tmux');
const { createLogger } = require('./logger');

const log = createLogger('wrap-delivery-receipt');

/** How long to watch for acceptance evidence before answering. */
const RECEIPT_WINDOW_MS = 4000;

/** Gap between pane reads inside the window. */
const RECEIPT_POLL_MS = 400;

/** Pane tail depth for the echo check. */
const RECEIPT_TAIL_LINES = 80;

/**
 * How much of the sent prompt to look for echoed back.
 *
 * The first line is the self-identifying step header (`_wrapStepHeader`), which
 * is what an operator reading the pane sees first and what the engine echoes
 * first. Matching on a short, distinctive slice rather than the whole prompt is
 * deliberate: a wrap prompt runs to thousands of characters, so by the time the
 * engine is answering, most of it has scrolled out of a tail capture. #1134
 * found that watching a whole prime arrive is not implementable from a pane
 * tail for exactly this reason.
 */
const ECHO_SLICE_CHARS = 60;

/**
 * The first line of a sent prompt, trimmed to the echo slice.
 * @param {string} prompt - The full prompt text that was sent.
 * @returns {string} A short distinctive prefix, or '' when there is nothing usable.
 */
function _echoNeedle(prompt) {
  if (typeof prompt !== 'string') return '';
  const firstLine = prompt.split('\n').find((l) => l.trim().length > 0) || '';
  return firstLine.trim().slice(0, ECHO_SLICE_CHARS);
}

/**
 * Read a pane's tail and cursor together.
 *
 * Both reads are attempted independently: the cursor is an optional refinement
 * (`_composerEmpty` answers `null` without it) while the lines carry the
 * activity and echo checks, so a cursor read that throws must not cost us the
 * evidence the tail still holds.
 *
 * @param {string} tmuxName - tmux session name.
 * @param {object} deps - Injected seams (`capturePane`, `cursorInfo`).
 * @returns {{lines: Array<string>|null, cursor: object|null, error: string|null}}
 */
function _readPane(tmuxName, deps) {
  let lines = null;
  let cursor = null;
  let error = null;
  try {
    lines = (deps.capturePane(tmuxName, { lines: RECEIPT_TAIL_LINES }) || {}).lines || null;
  } catch (err) {
    error = err.message;
  }
  try {
    cursor = deps.cursorInfo(tmuxName) || null;
  } catch (_err) {
    // Cursor is a refinement, not a requirement — see the docstring.
    cursor = null;
  }
  return { lines, cursor, error };
}

/**
 * Verify that a just-sent wrap prompt became a task on the engine's pane.
 *
 * Evidence is checked in order of strength, and the first positive answer wins:
 *
 * 1. **Engine working** — `_assessPane` reports not-idle for an activity
 *    reason. The engine picked the task up. Strongest signal.
 * 2. **Echo** — the step header we sent is visible in the pane tail. The text
 *    reached the transcript, which a paste that was never submitted cannot do.
 * 3. **Composer holding input** — `_assessPane` reports `composer-has-input`.
 *    Positive evidence of FAILURE: the text is sitting there unsubmitted.
 *
 * Anything else is `unknown`, including an at-rest pane with an empty composer.
 * That case is genuinely ambiguous at this boundary — an engine that accepted
 * the task and finished it within the window is indistinguishable from one that
 * never received it — and #1685 forbids asserting a cause for it.
 *
 * @param {string} tmuxName - tmux session name the prompt was sent to.
 * @param {string} engineId - Engine id, for its declared wake vocabulary.
 * @param {string} prompt - The prompt text that was sent, for the echo check.
 * @param {object} [opts] - Test seams: `capturePane`, `cursorInfo`, `now`,
 *   `sleep`, `windowMs`, `pollMs`.
 * @returns {Promise<{outcome: 'accepted'|'not-accepted'|'unknown', reason: string}>}
 */
async function verifySubmission(tmuxName, engineId, prompt, opts = {}) {
  const deps = {
    capturePane: opts.capturePane || ((name, o) => tmux.capturePane(name, o)),
    cursorInfo: opts.cursorInfo || ((name) => tmux.cursorInfo(name)),
    now: opts.now || (() => Date.now()),
    sleep: opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  };
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : RECEIPT_WINDOW_MS;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : RECEIPT_POLL_MS;

  // Property access, never a require-time destructure: `ENGINE_WAKE_PROFILES`
  // is a getter that resolves the profiles lazily, and destructuring it at
  // require time freezes whatever existed then (noted at its definition).
  const profile = medusaWake.ENGINE_WAKE_PROFILES[engineId];
  if (!profile) {
    return {
      outcome: 'unknown',
      reason: `engine ${engineId} declares no wake vocabulary, so nothing here can observe whether the prompt became a task`
    };
  }

  const needle = _echoNeedle(prompt);
  const startedAt = deps.now();
  let lastReason = 'the pane was never read';

  while (deps.now() - startedAt < windowMs) {
    const { lines, cursor, error } = _readPane(tmuxName, deps);
    if (error) {
      lastReason = `the pane could not be read (${error})`;
    } else if (lines) {
      const verdict = medusaWake._assessPane(lines, profile, cursor);

      // 1. The engine is working — it took the task.
      //
      // ONLY the two positive activity signals count. `_assessActivity` also
      // answers `working: true` with reason `not-at-rest`, which means merely
      // that the engine's declared idle marker was ABSENT from the tail — a
      // scrolled pane, a capture that did not reach the footer, or a redraw
      // mid-frame all produce it. Reading absence-of-idle as evidence-of-work
      // is the same absence-read-as-presence fault this module exists to close,
      // so it falls through to the later checks and, failing those, to
      // `unknown`.
      if (verdict.idle === false
          && (verdict.reason === 'turn-in-flight' || verdict.reason === 'agents-running')) {
        return { outcome: 'accepted', reason: `the engine is working (${verdict.reason})` };
      }

      // 2. Our text reached the transcript.
      if (needle && medusaWake._strip(lines.join('\n')).includes(needle)) {
        return { outcome: 'accepted', reason: 'the prompt is echoed in the pane transcript' };
      }

      // 3. The text is sitting in the composer, unsubmitted.
      if (verdict.reason === 'composer-has-input') {
        return {
          outcome: 'not-accepted',
          reason: 'the composer is holding input — the prompt was pasted but never submitted'
        };
      }

      lastReason = verdict.reason === 'at-prompt'
        ? 'the pane is at rest with an empty composer and no echo of the prompt'
        : verdict.reason === 'not-at-rest'
          ? "the engine's idle marker was absent from the tail, which is not evidence of work"
          : `the pane shows ${verdict.reason}`;
    }
    await deps.sleep(pollMs);
  }

  return {
    outcome: 'unknown',
    reason: `${lastReason} after ${windowMs}ms — an engine that accepted and finished within the window `
      + 'looks the same here as one that never received it, so this is not evidence either way'
  };
}

/**
 * One-line summary for logs and the step result.
 * @param {{outcome: string, reason: string}} receipt - A `verifySubmission` result.
 * @returns {string} Human-readable delivery statement.
 */
function describeReceipt(receipt) {
  const r = receipt || {};
  switch (r.outcome) {
    case 'accepted':
      return `delivery confirmed: ${r.reason}`;
    case 'not-accepted':
      return `delivery FAILED: ${r.reason}`;
    default:
      return `delivery unconfirmed: ${r.reason}`;
  }
}

/**
 * Log a receipt at the level its outcome deserves.
 * @param {object} fields - Log context (project, stepId, …).
 * @param {{outcome: string, reason: string}} receipt - A `verifySubmission` result.
 * @returns {void}
 */
function logReceipt(fields, receipt) {
  const payload = { ...fields, outcome: receipt.outcome, reason: receipt.reason };
  if (receipt.outcome === 'not-accepted') log.warn('wrap prompt was not accepted', payload);
  else if (receipt.outcome === 'unknown') log.info('wrap prompt delivery unconfirmed', payload);
  else log.info('wrap prompt delivery confirmed', payload);
}

module.exports = {
  verifySubmission,
  describeReceipt,
  logReceipt,
  RECEIPT_WINDOW_MS,
  RECEIPT_POLL_MS,
  RECEIPT_TAIL_LINES,
  ECHO_SLICE_CHARS,
  _echoNeedle,
  _readPane
};
