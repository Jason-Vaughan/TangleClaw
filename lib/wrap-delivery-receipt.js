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
 * This module answers the only question a rendered pane can answer safely:
 * **after the submit, does the pane PROVE the prompt did not become a task?**
 * It never claims the converse.
 *
 * ## A NEGATIVE receipt: two outcomes, and no positive claim
 *
 * - `not-accepted` — attributable, positive evidence that THIS send was not
 *   accepted.
 * - `unknown` — everything else.
 *
 * **There is no `accepted`.** It was removed by Architect ruling (2026-09-20)
 * after four reachable false-positive variants in four review rounds, every one
 * of them in the accept half. The boundary between a composer and a transcript,
 * read from a bounded capture of a rendered TUI, cannot support a positive
 * claim safely: the composer wraps across rows, scrolls its own head out of the
 * tail, and can be drawn without a glyph. Each guard added another place the
 * inference could be wrong in the permissive direction — and a false `accepted`
 * is the exact defect #1685 exists to catch, restored one layer up.
 *
 * The accept inference also had **no independent behavioral consumer**: an
 * `accepted` step fell through to the same wait it would have done anyway. It
 * carried all the risk and delivered no behaviour.
 *
 * **Success is established downstream, as it always was** — the completion
 * marker, the capture file, and the settle watch in `ai-content.js`. That is the
 * positive evidence. This module's job is to catch the failure fast, and to say
 * honestly when it cannot.
 *
 * Reintroducing `accepted` requires an engine-native acknowledgement or an
 * authoritative transcript event tied to this nonce — not rendered-pane
 * inference — and another explicit contract amendment.
 *
 * ## Attribution: `not-accepted` must be about THIS send
 *
 * Only two things qualify:
 *
 * 1. **This send's nonce still inside a reliably located composer**, across the
 *    confirmation reads. Our own text, where it would be if it had never been
 *    submitted.
 * 2. **An engine's declared rejection marker that APPEARED during the watch**.
 *    A marker merely present in bounded scrollback may be stale — left by an
 *    earlier send — so it is evidence only when it was absent on the first read
 *    and present later.
 *
 * A composer holding some OTHER text is not proof our prompt was unsubmitted:
 * it may be the operator's input or a selector row. That is `unknown`.
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
 * How long to watch for failure evidence before answering `unknown`.
 *
 * Bounded deliberately and kept far below the caller's `MAX_WAIT_MS`: this is
 * paid on EVERY content step, including the ones that work, so it buys a fast
 * answer for a failure rather than adding meaningfully to a healthy wrap. A
 * healthy send is EXPECTED to spend the whole window and answer `unknown` —
 * there is no positive outcome to exit early on.
 */
const RECEIPT_WINDOW_MS = 4000;

/**
 * Wait before the first COMPOSER read, so the terminal has drawn its response
 * to Enter.
 *
 * Not the first read of all: the rejection-marker baseline is taken BEFORE this
 * sleep, because an engine that discards a paste announces it well inside this
 * window and a baseline taken afterwards would mistake that announcement for
 * pre-existing scrollback.
 *
 * The composer checks do need it. At t≈0 the pane has not repainted from its
 * own Enter, so the composer still holds the text that is about to be
 * submitted — the exact state this module must not misread as unsubmitted.
 */
const RECEIPT_SETTLE_MS = 600;

/**
 * Consecutive reads that must show THIS SEND'S NONCE inside a located composer
 * before answering `not-accepted`.
 *
 * One frame is not enough: a single capture can catch the composer mid-repaint,
 * between the paste landing and the submit taking effect. A false
 * `not-accepted` blocks a wrap that would have succeeded, which is the one
 * direction this module must never fail in.
 *
 * Note what does NOT reach this counter: a composer holding some OTHER text. It
 * may be operator input or a selector row, which says nothing about our prompt,
 * so it is `unknown` rather than weaker failure evidence.
 */
const COMPOSER_CONFIRM_POLLS = 2;

/** Gap between pane reads inside the window. */
const RECEIPT_POLL_MS = 400;

/**
 * Pane tail depth. Deep enough to carry the composer region and the rows above
 * it, shallow enough that the read stays cheap. It does NOT need to reach far
 * enough to catch a transcript echo: there is no echo check — a bounded tail is
 * exactly why the composer's head can scroll out of view, which is what made
 * the echo unsafe to read in the first place.
 */
const RECEIPT_TAIL_LINES = 80;

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
 * Verify that a just-sent wrap prompt became a task on the engine's pane.
 *
 * A NEGATIVE receipt. It answers `not-accepted` only on evidence attributable
 * to THIS send, and `unknown` otherwise. It never answers `accepted`.
 *
 * 1. **A declared rejection marker that APPEARED during the watch** — absent on
 *    the first read, present later. A marker already in the bounded scrollback
 *    may belong to an earlier send.
 * 2. **This send's nonce still inside a reliably located composer**, confirmed
 *    over `COMPOSER_CONFIRM_POLLS` consecutive reads.
 *
 * Everything else is `unknown`, and its reason says which silence it was: an
 * unlocatable composer boundary, a composer holding someone else's text, a busy
 * engine, an at-rest empty composer, an unreadable pane, or an engine that
 * declares no wake vocabulary.
 *
 * **Why no positive outcome.** Four review rounds found four reachable paths to
 * a false `accepted`, every one of them in the accept half, because the
 * composer/transcript boundary in a bounded capture of a rendered TUI cannot
 * carry a positive claim. Success is established downstream by the completion
 * marker, capture file and settle watch — which is where it always was.
 *
 * @param {string} tmuxName - tmux session name the prompt was sent to.
 * @param {string} engineId - Engine id, for its declared wake vocabulary.
 * @param {string} nonce - This send's unique nonce — what makes a composer's
 *   contents attributable to THIS send rather than an earlier one.
 * @param {object} [opts] - Test seams: `capturePane`, `cursorInfo`, `now`,
 *   `sleep`, `windowMs`, `pollMs`, `settleMs`.
 * @returns {Promise<{outcome: 'not-accepted'|'unknown', reason: string}>}
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
  // null until the first read; then whether the rejection marker was ALREADY
  // there, which is what makes a later appearance attributable to this send.
  let markerSeenFirstRead = null;

  // Baseline the rejection marker BEFORE the settle. `markerSeenFirstRead` is
  // what makes a marker attributable to this send, and an engine that discards
  // a paste announces it immediately — well inside RECEIPT_SETTLE_MS. Taking
  // the baseline after the settle would therefore find the engine's OWN
  // rejection already on screen, call it pre-existing scrollback, and degrade a
  // failure the engine stated in words into `unknown` — leaving the caller to
  // wait out MAX_WAIT_MS for something already announced.
  //
  // This read is for the marker ONLY. It is deliberately not used for the
  // composer or activity checks, which DO need the settle: at t≈0 the pane has
  // not repainted from its own Enter, and the composer still holds the text
  // that is about to be submitted.
  {
    const preMarker = (typeof profile.pasteRejectedMarker === 'string'
      && profile.pasteRejectedMarker.trim()) ? profile.pasteRejectedMarker : null;
    if (preMarker) {
      const pre = _readPane(tmuxName, deps);
      // STAYS NULL when the baseline read produced nothing. `false` here would
      // claim the marker was absent before the send, which an unread pane
      // cannot establish — and an EARLIER send's marker would then satisfy the
      // attributability test and block a healthy wrap. A false `not-accepted`
      // is the direction this module must never fail in: it refuses work that
      // would otherwise have succeeded.
      markerSeenFirstRead = pre.lines
        ? medusaWake._strip(pre.lines.join('\n')).includes(preMarker)
        : null;
    } else {
      markerSeenFirstRead = false;
    }
  }

  // Let the terminal draw before the first real read. Without it the first poll
  // lands at t≈0 — before the engine has repainted from its own Enter — and
  // reads a pane that has not yet become either answer.
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
      const split = medusaWake.locateComposer(lines, cursor, profile);
      const nonceInComposer = Boolean(needle && split.located
        && medusaWake._strip(split.composer).includes(needle));

      // 1. The engine SAID it discarded the submission — but only when the
      //    marker APPEARED during this watch. A declared marker sitting in the
      //    bounded scrollback may have been left by an earlier send, and
      //    `not-accepted` must be attributable to THIS one.
      const rejectedMarker = (typeof profile.pasteRejectedMarker === 'string'
        && profile.pasteRejectedMarker.trim()) ? profile.pasteRejectedMarker : null;
      const markerNow = Boolean(rejectedMarker && text.includes(rejectedMarker));
      // `=== false` deliberately, not falsy: `null` means the baseline was never
      // measured, and an unmeasured baseline cannot attribute a marker to this
      // send.
      if (markerNow && markerSeenFirstRead === false) {
        return {
          outcome: 'not-accepted',
          reason: `the engine reported it discarded the submission ("${rejectedMarker}") — the marker `
            + 'appeared after this send, so it belongs to it'
        };
      }

      // 2. OUR OWN TEXT is still inside a RELIABLY LOCATED composer. The only
      //    positive failure evidence a rendered pane can carry, and the only one
      //    that survives a paste wrapped across several composer rows.
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
      composerHolds = 0;

      // Everything else is UNKNOWN. Each silence names itself, because the
      // reason is what the operator reads instead of a wrong explanation.
      //
      // Note what is deliberately NOT here: a busy engine, an apparent
      // transcript echo, an empty composer. Each of those once returned
      // `accepted`, and each produced a false one. Busy says SOMETHING is
      // running, not that ours was taken. An echo is read from a boundary that
      // cannot be located reliably. An empty composer cannot tell a prompt that
      // was taken and finished from one that never arrived.
      lastReason = !split.located
        ? 'the composer could not be located in the captured tail, so this send\'s own text could '
          + 'not be looked for where it would be if it had never been submitted'
        : composerEmpty === false
          ? 'the composer is holding text that is not this send — it may be operator input or a '
            + 'selector row, which says nothing about whether this prompt was submitted'
          : activity.reason === 'turn-in-flight' || activity.reason === 'agents-running'
            ? `the engine is working (${activity.reason}), which says something is running but not `
              + 'that THIS prompt was the thing taken'
            : activity.working
              ? "the engine's idle marker was absent from the captured tail, which a scrolled pane "
                + 'also produces — it is not evidence of work'
            : composerEmpty === true
              ? 'the pane is at rest with an empty composer and this send\'s text is not in it'
              : 'the pane showed no attributable evidence';
    }
    await deps.sleep(pollMs);
  }

  // A cursor that never read is not a detail. The composer boundary is located
  // from the cursor's own rendered line, so without it `locateComposer`
  // answers `located: false` on every poll — and the nonce-in-composer check,
  // the ONLY path that can answer `not-accepted`, is gated on that flag. A
  // persistent cursor failure therefore disables the module's single positive
  // capability in silence. Saying "at rest with an empty composer" there would
  // claim an observation nothing made.
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
  _readPane
};
