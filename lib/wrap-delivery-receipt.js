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
 * - `accepted` — positive evidence: the engine is working, or this send's nonce
 *   is echoed in the transcript OUTSIDE the composer line.
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

/**
 * How long to watch for acceptance evidence before answering.
 *
 * Bounded deliberately and kept far below the caller's `MAX_WAIT_MS`: this is
 * paid on EVERY content step, including the ones that work, so it buys a fast
 * answer for a failure rather than adding meaningfully to a healthy wrap. An
 * engine slower than this to repaint answers `unknown`, which costs the caller
 * only the wait it already had.
 */
const RECEIPT_WINDOW_MS = 4000;

/**
 * Wait before the FIRST read, so the terminal has drawn its response to Enter.
 *
 * Polling at t≈0 reads a pane that has not yet become either answer — the
 * composer may still show the paste that is about to be submitted, which is the
 * exact state this module must not misread.
 */
const RECEIPT_SETTLE_MS = 600;

/**
 * Consecutive reads that must show a filled composer before answering
 * `not-accepted`. One frame is not enough: the signal is also reachable by a
 * selector row holding the cursor, and a false failure blocks a healthy wrap.
 */
const COMPOSER_CONFIRM_POLLS = 2;

/** Gap between pane reads inside the window. */
const RECEIPT_POLL_MS = 400;

/**
 * Pane tail depth. Deep enough that a submitted prompt's echo is still on
 * screen within the window, shallow enough that the read stays cheap.
 */
const RECEIPT_TAIL_LINES = 80;

/**
 * The echo check's needle is the send's NONCE, not its step header.
 *
 * A header (`_wrapStepHeader`) is byte-identical on every attempt at a step, so
 * a retry matches the FAILED attempt's header still sitting in scrollback and
 * answers `accepted` for a prompt that just failed again. That is the same
 * stale-scrollback trap the per-send nonce already closes for the completion
 * marker, so the nonce is what this looks for too: it is unique per send, so a
 * match can only have come from THIS attempt.
 */

/**
 * Read a pane's tail and cursor together.
 *
 * Both reads are attempted independently: the cursor is an optional refinement
 * while the lines carry the activity check, so a cursor read that throws must
 * not cost us the evidence the tail still holds.
 *
 * A cursor failure is REPORTED rather than swallowed. `composer-has-input` is
 * reachable only through the cursor, so a persistent failure silently disables
 * the only outcome that can answer `not-accepted` — the caller has to be able
 * to tell that apart from a composer it genuinely observed to be empty.
 *
 * @param {string} tmuxName - tmux session name.
 * @param {object} deps - Injected seams (`capturePane`, `cursorInfo`).
 * @returns {{lines: Array<string>|null, cursor: object|null, error: string|null,
 *   cursorError: string|null}}
 */
function _readPane(tmuxName, deps) {
  let lines = null;
  let cursor = null;
  let error = null;
  let cursorError = null;
  try {
    lines = (deps.capturePane(tmuxName, { lines: RECEIPT_TAIL_LINES }) || {}).lines || null;
  } catch (err) {
    error = err.message;
  }
  try {
    cursor = deps.cursorInfo(tmuxName) || null;
    if (!cursor) cursorError = 'the cursor position was unavailable';
  } catch (err) {
    cursorError = err.message;
    cursor = null;
  }
  return { lines, cursor, error, cursorError };
}

/**
 * The captured tail with the composer's own line removed, matched by CONTENT.
 *
 * The composer is where an unsubmitted paste renders, so an echo check that
 * reads it cannot distinguish "the engine took this" from "this is still
 * sitting in the box".
 *
 * **Not by row index.** `capturePane(name, {lines: N})` issues `-S -N` for a
 * pane that is not on the alternate screen, so row 0 of the capture is N rows
 * ABOVE the visible pane top, while `cursor_y` is pane-relative — the two do
 * not share an origin, and only the alternate-screen branch happens to align.
 * An index-based filter therefore drops an arbitrary scrollback row and leaves
 * the composer in the body the echo searches, which is the whole defect
 * restored. Matching the cursor's rendered line by content has no origin to get
 * wrong, and is the same thing `_composerEmpty` already trusts.
 *
 * Every occurrence is dropped, not just the first: a duplicate can only cost a
 * missed echo (answering `unknown`), while keeping one costs a false
 * `accepted`, and those are not equally bad.
 *
 * @param {Array<string>} lines - Captured pane lines.
 * @param {{line: string}|null} cursor - `cursorInfo` result.
 * @returns {string} The tail text with the composer line excluded.
 */
function _transcriptOutsideComposer(lines, cursor) {
  const rows = lines || [];
  if (!cursor || typeof cursor.line !== 'string') return '';
  const composer = medusaWake._strip(cursor.line).trim();
  if (!composer) return '';
  return rows.filter((l) => medusaWake._strip(String(l)).trim() !== composer).join('\n');
}

/**
 * Verify that a just-sent wrap prompt became a task on the engine's pane.
 *
 * Evidence is checked in this order, and the ORDER IS LOAD-BEARING:
 *
 * 1. **Engine working** — `_assessPane` reports `turn-in-flight` or
 *    `agents-running`. The engine picked the task up. Strongest signal.
 * 2. **Composer holding input** — `_assessPane` reports `composer-has-input`.
 *    Positive evidence of FAILURE: the text is sitting there unsubmitted.
 * 3. **Echo** — the send's nonce appears in the transcript, OUTSIDE the
 *    composer line.
 *
 * **Why the composer check must precede the echo check.** `sendKeys` clears the
 * composer, pastes the prompt, then sends Enter. So a prompt that was pasted and
 * never submitted is rendered *on the composer line*, inside the same capture
 * the echo check reads. Running the echo check first made this module answer
 * `accepted` for exactly the case it exists to catch. Ordering alone is not
 * enough either, because `composer-has-input` is only reachable when the cursor
 * could be read — so the echo check additionally excludes the cursor's line, and
 * refuses to run at all when the cursor is unknown. Without a cursor there is no
 * way to tell the composer from the transcript, and a guess here is the whole
 * bug.
 *
 * Anything else is `unknown`, including an at-rest pane with an empty composer.
 * That case is genuinely ambiguous at this boundary — an engine that accepted
 * the task and finished it within the window is indistinguishable from one that
 * never received it — and #1685 forbids asserting a cause for it.
 *
 * @param {string} tmuxName - tmux session name the prompt was sent to.
 * @param {string} engineId - Engine id, for its declared wake vocabulary.
 * @param {string} nonce - This send's unique nonce, the echo check's needle.
 * @param {object} [opts] - Test seams: `capturePane`, `cursorInfo`, `now`,
 *   `sleep`, `windowMs`, `pollMs`, `settleMs`.
 * @returns {Promise<{outcome: 'accepted'|'not-accepted'|'unknown', reason: string}>}
 */
async function verifySubmission(tmuxName, engineId, nonce, opts = {}) {
  const deps = {
    capturePane: opts.capturePane || ((name, o) => tmux.capturePane(name, o)),
    cursorInfo: opts.cursorInfo || ((name) => tmux.cursorInfo(name)),
    now: opts.now || (() => Date.now()),
    sleep: opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  };
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : RECEIPT_WINDOW_MS;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : RECEIPT_POLL_MS;
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : RECEIPT_SETTLE_MS;

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

  const needle = typeof nonce === 'string' ? nonce.trim() : '';
  const startedAt = deps.now();
  let lastReason = 'the pane was never read';
  let cursorFailures = 0;
  let reads = 0;
  let linesRead = 0;
  let composerHolds = 0;

  // Let the terminal draw before the first read. Without it the first poll lands
  // at t≈0 — before the engine has repainted from its own Enter — and reads a
  // pane that has not yet become either answer.
  await deps.sleep(settleMs);

  while (deps.now() - startedAt < windowMs) {
    const { lines, cursor, error, cursorError } = _readPane(tmuxName, deps);
    reads += 1;
    if (cursorError) cursorFailures += 1;
    if (lines) linesRead += 1;
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
      // is the same absence-read-as-presence fault this module exists to close.
      if (verdict.idle === false
          && (verdict.reason === 'turn-in-flight' || verdict.reason === 'agents-running')) {
        return { outcome: 'accepted', reason: `the engine is working (${verdict.reason})` };
      }

      // 2a. The engine SAID it discarded the submission. Some engines declare a
      //     measured rejection marker (antigravity's, from #1134); where one
      //     exists it is the strongest failure evidence there is — the engine's
      //     own words — and reaching `unknown` with it on screen would burn the
      //     caller's full wait on a rejection we had already been told about.
      if (profile.pasteRejectedMarker
          && medusaWake._strip(lines.join('\n')).includes(profile.pasteRejectedMarker)) {
        return {
          outcome: 'not-accepted',
          reason: `the engine reported it discarded the submission ("${profile.pasteRejectedMarker}")`
        };
      }

      // 2b. The text is sitting in the composer, unsubmitted. BEFORE the echo
      //    check — the composer line is inside the capture the echo reads.
      //
      // CONFIRMED over two consecutive polls, never one. `medusa-wake`
      // documents `composer-has-input` as also reachable by a glyph-led
      // selector row that happens to hold the cursor, and a single frame can
      // catch a mid-repaint composer that is about to clear. A false
      // `not-accepted` blocks a wrap that would have worked, which is worse
      // than the wait it saves — so the cheap confirmation is worth its one
      // extra poll.
      if (verdict.reason === 'composer-has-input') {
        composerHolds += 1;
        if (composerHolds >= COMPOSER_CONFIRM_POLLS) {
          return {
            outcome: 'not-accepted',
            reason: `the composer is holding input on ${composerHolds} consecutive reads — `
              + 'the prompt was pasted but never submitted'
          };
        }
      } else {
        composerHolds = 0;
      }

      // 3. Our nonce reached the transcript, outside the composer line.
      if (needle && cursor) {
        const body = _transcriptOutsideComposer(lines, cursor);
        if (medusaWake._strip(body).includes(needle)) {
          return { outcome: 'accepted', reason: "this send's nonce is echoed in the pane transcript" };
        }
      }

      lastReason = verdict.reason === 'at-prompt'
        ? 'the pane is at rest with an empty composer and no echo of the prompt'
        : verdict.reason === 'not-at-rest'
          ? "the engine's idle marker was absent from the tail, which is not evidence of work"
          : `the pane shows ${verdict.reason}`;
    }
    await deps.sleep(pollMs);
  }

  // A cursor that never read is not a detail: `composer-has-input` is reachable
  // only through it, so a persistent cursor failure silently disables the ONLY
  // outcome that can answer `not-accepted`, and the echo check with it. Saying
  // "at rest with an empty composer" there would claim an observation nothing
  // made.
  // Only when the TAIL was readable. A pane we could not read at all already has
  // a truer reason, and reporting the cursor there would name the smaller
  // failure.
  if (linesRead > 0 && cursorFailures === reads) {
    log.warn('the pane cursor could not be read on any poll — composer state was never observed', {
      session: tmuxName, engineId, reads
    });
    return {
      outcome: 'unknown',
      reason: `the pane cursor could not be read on any of ${reads} polls, so the composer was never `
        + 'observed — the one check that can prove a prompt was left unsubmitted was unavailable'
    };
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
  // Routed through `describeReceipt` so the statement has ONE author. Formatting
  // it here as well would be a second copy of the same sentence, free to drift
  // from the first the moment an outcome is added.
  const payload = { ...fields, outcome: receipt.outcome, reason: receipt.reason };
  const statement = describeReceipt(receipt);
  if (receipt.outcome === 'not-accepted') log.warn(statement, payload);
  else log.info(statement, payload);
}

module.exports = {
  verifySubmission,
  describeReceipt,
  logReceipt,
  RECEIPT_WINDOW_MS,
  RECEIPT_POLL_MS,
  RECEIPT_TAIL_LINES,
  RECEIPT_SETTLE_MS,
  COMPOSER_CONFIRM_POLLS,
  _transcriptOutsideComposer,
  _readPane
};
