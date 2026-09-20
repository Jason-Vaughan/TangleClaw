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
 * Split a capture into transcript and composer at ONE boundary, and say whether
 * the boundary was actually found.
 *
 * The composer is where an unsubmitted paste renders, so an echo check that
 * reads it cannot tell "the engine took this" from "this is still in the box".
 * Three earlier attempts were wrong, and each is recorded because the fourth
 * has to survive all of them:
 *
 * 1. **By row index** (`lines[cursor.y]`) — `capturePane` issues `-S -N` off the
 *    alternate screen, so row 0 is N rows ABOVE the pane top while `cursor_y` is
 *    pane-relative. No shared origin.
 * 2. **By matching the cursor's ONE row** — a wrap prompt renders across many
 *    composer rows, and the nonce is not last in it (`_completionInstruction`
 *    puts ~110 characters after it), so the nonce lands on a non-cursor composer
 *    row and survives a one-row filter.
 * 3. **By region, but FALLING BACK to one row when no glyph row was found.**
 *    That is this function's own previous version. The tail is bounded
 *    (`RECEIPT_TAIL_LINES`), and a composer taller than the visible pane scrolls
 *    internally, so for a multi-thousand-character prompt the glyph row is
 *    routinely absent — and the fallback silently restored defect 2.
 *
 * So a boundary that cannot be found is reported as NOT FOUND. Both halves then
 * mean nothing and the caller must not read either: no echo may be trusted, and
 * no composer claim may be made. Returning an empty string for that case is what
 * let the previous version conflate "the composer starts at row 0" with "I could
 * not find it".
 *
 * @param {Array<string>} lines - Captured pane lines.
 * @param {{line: string}|null} cursor - `cursorInfo` result.
 * @param {object} profile - Engine wake profile, for `promptGlyph`.
 * @returns {{located: boolean, transcript: string, composer: string}}
 */
function _splitAtComposer(lines, cursor, profile) {
  const NOT_LOCATED = { located: false, transcript: '', composer: '' };
  const rows = lines || [];
  if (!cursor || typeof cursor.line !== 'string' || !profile || !profile.promptGlyph) return NOT_LOCATED;
  const composerLine = medusaWake._strip(cursor.line).trim();
  if (!composerLine) return NOT_LOCATED;

  // The cursor's row, located by CONTENT because the index cannot be trusted.
  // Last match wins: the composer is at the bottom, so a coincidental earlier
  // match in scrollback must not take the boundary with it.
  let cursorRow = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (medusaWake._strip(String(rows[i])).trim() === composerLine) { cursorRow = i; break; }
  }
  if (cursorRow === -1) return NOT_LOCATED;

  // The composer's first row is the nearest glyph-led row at or above the
  // cursor. `trimStart().startsWith(glyph)` rather than `includes`, matching
  // `medusa-wake._paneDigest`: a glyph appearing mid-line is transcript text
  // that happens to contain the character, not a prompt.
  let start = -1;
  for (let i = cursorRow; i >= 0; i--) {
    if (medusaWake._strip(String(rows[i])).trimStart().startsWith(profile.promptGlyph)) { start = i; break; }
  }
  // NO FALLBACK. An absent glyph row means the composer's head scrolled out of
  // the bounded tail, and guessing the boundary is how defect 2 came back.
  if (start === -1) return NOT_LOCATED;

  return {
    located: true,
    transcript: rows.slice(0, start).join('\n'),
    composer: rows.slice(start).join('\n')
  };
}

/**
 * Verify that a just-sent wrap prompt became a task on the engine's pane.
 *
 * Five checks, and **the order is load-bearing**:
 *
 * 1. **Declared rejection marker** — the engine's own words that it discarded
 *    the paste. The strongest failure evidence there is, where an engine
 *    declares one.
 * 2. **Our nonce inside the composer region** → `not-accepted` (confirmed over
 *    `COMPOSER_CONFIRM_POLLS` consecutive reads). The sharpest non-submission
 *    signal, and the only one that survives a multi-row paste.
 * 3. **Our nonce in the transcript above the composer** → `accepted`. Checked
 *    BEFORE the generic filled-composer signal, because a composer holding
 *    something else says nothing about our prompt.
 * 4. **The engine working** (`turn-in-flight` / `agents-running`) → `accepted`.
 * 5. **A composer holding anything else** → `not-accepted`, also confirmed.
 *
 * **Why the composer is read before the engine's activity.** A pane can be busy
 * AND holding our unsubmitted text — a previous turn still running while the new
 * paste sits in the composer, which is exactly the consecutive-step failure this
 * module exists to catch. Deriving both from `_assessPane`'s single
 * mutually-exclusive verdict made that case classify as `accepted`, so the two
 * questions are asked of `_assessActivity` and `_composerEmpty` separately.
 *
 * **Why the echo is bounded by a region.** `sendKeys` clears the composer,
 * pastes, then sends Enter, so an unsubmitted prompt renders across the composer
 * rows — inside the same capture the echo reads. `_splitAtComposer` draws that
 * boundary once, and reports when it could not find it at all; an unlocated
 * boundary means no echo may be trusted and no composer claim may be made.
 *
 * Anything else is `unknown`, including an at-rest pane with an empty composer:
 * an engine that accepted the task and finished it inside the window is
 * indistinguishable here from one that never received it, and #1685 forbids
 * asserting a cause for that.
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
      // TWO INDEPENDENT QUESTIONS, read from two independent primitives.
      //
      // `_assessPane` answers ONE mutually-exclusive verdict, and that is wrong
      // for this caller: a pane can be busy AND holding our unsubmitted text at
      // the same time — a previous turn still running while the new paste sits
      // in the composer, which is precisely the consecutive-step failure this
      // module exists to catch. Taking `_assessPane`'s verdict made
      // `composer-has-input` unreachable whenever the busy marker rendered, so
      // that case classified as `accepted`.
      const text = medusaWake._strip(lines.join('\n'));
      const activity = medusaWake._assessActivity(text, profile);
      const composerEmpty = medusaWake._composerEmpty(cursor, profile);

      // Our OWN text, found inside the composer region, is the sharpest evidence
      // there is that it was never submitted — and it is the only one that works
      // for a multi-row paste. `_composerEmpty` reads the cursor's row alone, so
      // on a continuation row with no prompt glyph it answers `null` and the
      // row-level signal never fires. That left `not-accepted` unreachable for
      // exactly the wrapped prompts this module is sent.
      const split = _splitAtComposer(lines, cursor, profile);
      const nonceInComposer = Boolean(needle && split.located
        && medusaWake._strip(split.composer).includes(needle));
      const nonceInTranscript = Boolean(needle && split.located
        && medusaWake._strip(split.transcript).includes(needle));

      // 1. The engine SAID it discarded the submission. Some engines declare a
      //    measured rejection marker; where one exists it is the strongest
      //    failure evidence there is — the engine's own words.
      // Validated the same way `lib/sessions.js#_pasteRejectedMarker` does — a
      // non-blank STRING, not mere truthiness — because a profile carrying `true`
      // or `""` would otherwise match every pane or none. Not imported from
      // there: `wrap-steps/` requiring `sessions` would add a back-edge into the
      // module that drives the wrap. The rule is duplicated deliberately; the
      // two must not drift.
      const rejectedMarker = (typeof profile.pasteRejectedMarker === 'string'
        && profile.pasteRejectedMarker.trim()) ? profile.pasteRejectedMarker : null;
      if (rejectedMarker && text.includes(rejectedMarker)) {
        return {
          outcome: 'not-accepted',
          reason: `the engine reported it discarded the submission ("${rejectedMarker}")`
        };
      }

      // 2. OUR OWN TEXT is still in the composer. The sharpest evidence of
      //    non-submission, and the only signal that works for a multi-row paste:
      //    `_composerEmpty` reads the cursor's row alone, so on a continuation
      //    row carrying no glyph it answers `null` and never fires.
      if (nonceInComposer) {
        composerHolds += 1;
        if (composerHolds >= COMPOSER_CONFIRM_POLLS) {
          return {
            outcome: 'not-accepted',
            reason: `this send's own text is still in the composer on ${composerHolds} consecutive `
              + 'reads — the prompt was pasted but never submitted'
          };
        }
        lastReason = "this send's text is in the composer, awaiting a confirming read";
        await deps.sleep(pollMs);
        continue;
      }

      // 3. Our nonce reached the transcript ABOVE the composer. Checked before
      //    the generic filled-composer signal: a composer holding something
      //    ELSE — the operator's half-typed line, or a selector row the cursor
      //    happens to sit on — says nothing about OUR prompt, and letting it
      //    suppress a genuine echo answered `not-accepted` for a prompt that had
      //    demonstrably been submitted.
      if (nonceInTranscript) {
        composerHolds = 0;
        return { outcome: 'accepted', reason: "this send's nonce is echoed in the pane transcript" };
      }

      // 4. The engine is working. ONLY the two positive activity signals:
      //    `_assessActivity` also answers working for `not-at-rest`, which means
      //    merely that the idle marker was absent from the tail — a scrolled
      //    pane produces that too, and absence is not evidence.
      if (activity.working
          && (activity.reason === 'turn-in-flight' || activity.reason === 'agents-running')) {
        composerHolds = 0;
        return { outcome: 'accepted', reason: `the engine is working (${activity.reason})` };
      }

      // 5. The composer holds SOMETHING, and it is not our nonce and there is no
      //    echo. Weaker than 2 — it cannot tell our paste from the operator's
      //    typing — so it still needs its confirming read.
      if (composerEmpty === false) {
        composerHolds += 1;
        if (composerHolds >= COMPOSER_CONFIRM_POLLS) {
          return {
            outcome: 'not-accepted',
            reason: `the composer is holding input on ${composerHolds} consecutive reads — `
              + 'the prompt was pasted but never submitted'
          };
        }
        lastReason = 'the composer is holding input, awaiting a confirming read';
      } else {
        composerHolds = 0;
        // Each silence says what it is. A boundary that could not be found is
        // NOT an observed at-rest pane, and must never be reported as one.
        lastReason = !split.located
          ? 'the composer could not be located in the captured tail, so neither the composer nor the '
            + 'transcript could be read'
          : composerEmpty === true
            ? 'the pane is at rest with an empty composer and no echo of the prompt'
            : activity.working
              ? "the engine's idle marker was absent from the tail, which is not evidence of work"
              : 'the pane showed no evidence either way';
      }
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
  _splitAtComposer,
  _readPane
};
