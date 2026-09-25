'use strict';

/**
 * Medusa wake transports (#1839): how a nudge reaches a session, and what can
 * be known afterwards about whether it arrived.
 *
 * The durable inbox is the source of truth for mail; a wake is only a
 * notification that there is some. Each transport says which receipts it can
 * give:
 * - `positive`: an engine-native acknowledgement tied to this attempt can
 *   prove the nudge was accepted. No transport here has one yet; the
 *   interface is shaped for one (Codex-native and Claude Stop-hook adapters
 *   are separate issues).
 * - `negative`: the pane can prove only that the nudge was NOT accepted (its
 *   nonce still sitting in the composer), never that it was. Guarded tmux
 *   injection is this kind, so a tmux wake tops out at "attempted".
 * - `none`: nothing observable after the attempt.
 *
 * A transport never decides whether to wake. Every gate (busy turn, draft,
 * wrap, identity, dedup, readiness) is applied by `lib/medusa-wake.js` before
 * `deliver` is called, and a transport never re-sends or presses Enter again.
 *
 * @module lib/wake-transports
 */

const crypto = require('node:crypto');

/**
 * A fresh per-attempt nonce. It rides the nudge line so a later look at the
 * composer can tell THIS attempt's text from any other.
 * @returns {string}
 */
function newNonce() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * The nudge line with its attempt nonce attached.
 * @param {string} line - The nudge line
 * @param {string} nonce - This attempt's nonce
 * @returns {string}
 */
function withNonce(line, nonce) {
  return `${line} (wake ref ${nonce})`;
}

/** Guarded tmux injection into a project session's pane. Negative receipts only. */
const tmuxTransport = Object.freeze({
  id: 'tmux',
  channel: 'tmux-inject',
  receipts: 'negative',

  /**
   * Inject the nudge into the project's pane.
   * @param {{project: object, sessionId: (string|number), line: string}} ctx
   * @param {{injectCommand: Function}} seams - The wake monitor's injection seam
   * @returns {{ok: boolean, error?: string}}
   */
  deliver(ctx, seams) {
    return seams.injectCommand(ctx.project.name, ctx.line, { sessionId: ctx.sessionId, controlExempt: 'medusa-wake' });
  },

  /**
   * After an attempt, ask whether the pane proves it was NOT accepted.
   * @param {{session: object, nonce: string}} ctx
   * @param {{verifySubmission: Function}} seams - The negative-receipt check
   * @returns {Promise<{outcome: 'not-accepted'|'unknown', reason: string}>}
   */
  verify(ctx, seams) {
    return seams.verifySubmission(ctx.session.tmuxSession, ctx.session.engineId, ctx.nonce);
  }
});

/** The Project Master's own injection path. Nothing observable after the attempt. */
const masterTransport = Object.freeze({
  id: 'master',
  channel: 'master-inject',
  receipts: 'none',

  /**
   * Inject the nudge into the Master pane.
   * @param {{line: string}} ctx
   * @param {{injectMaster: Function}} seams - The wake monitor's Master seam
   * @returns {{ok: boolean, error?: string}}
   */
  deliver(ctx, seams) {
    return seams.injectMaster(ctx.line);
  },

  /**
   * The Master path gives no receipt.
   * @returns {Promise<null>}
   */
  verify() {
    return Promise.resolve(null);
  }
});

/**
 * The transport for a session. Chosen by what the session is, not by a
 * hard-coded channel at the call site, so a receipt-bearing native adapter can
 * be slotted in per engine without touching the wake gates.
 * @param {{isMaster?: boolean}} session - The session being woken
 * @returns {typeof tmuxTransport}
 */
function forSession(session) {
  return session && session.isMaster ? masterTransport : tmuxTransport;
}

module.exports = { forSession, newNonce, withNonce, tmuxTransport, masterTransport };
