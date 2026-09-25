'use strict';

/**
 * Medusa send with a tracked exchange (#1839): the one path a switchboard
 * send takes, so every route (and later ones, such as #1873's retraction
 * notice) records delivery the same way.
 *
 * The order is fixed:
 * 1. Validate the delivery metadata against what the caller can prove.
 * 2. Record the intent after TangleClaw's own checks pass, just before the Hub
 *    is called.
 * 3. Bind the Hub's id, or record what the Hub's answer actually was: refused
 *    (undeliverable) or lost (send_unknown, never re-sent).
 *
 * The Hub and SQLite cannot commit together, so an exchange whose Hub answer
 * is known but cannot be bound is still reported as sent: failing the
 * response would invite the caller to send a second copy.
 *
 * Returns `{status, body}` for the route to write; it never touches a
 * response itself.
 *
 * @module lib/medusa-send
 */

const store = require('./store');
const medusa = require('./medusa');
const medusaWake = require('./medusa-wake');
const exchanges = require('./medusa-exchanges');
const watchdog = require('./medusa-watchdog');
const { createLogger } = require('./logger');

const log = createLogger('medusa-send');

/**
 * An HTTP answer for an exchange refusal.
 * @param {exchanges.ExchangeError} err - The refusal
 * @returns {{status: number, body: object}}
 */
function _refusal(err) {
  const details = err.details && Object.keys(err.details).length ? { details: err.details } : {};
  return { status: err.status, body: { ...details, error: err.message, code: err.code } };
}

/**
 * Send one message and track it as an exchange.
 * @param {object} input
 * @param {string|number} input.sessionId - The sending participant's listener key
 * @param {number|null} input.senderProjectId - The sending project, or null (the Master)
 * @param {object} input.caller - Resolved caller (see `medusa-exchanges#validateSendMeta`)
 * @param {object} input.body - The request body: `to`, `message` and the delivery metadata
 * @returns {Promise<{status: number, body: object}>}
 */
async function sendTracked({ sessionId, senderProjectId, caller, body }) {
  let meta;
  try {
    meta = exchanges.validateSendMeta(body, caller, senderProjectId, watchdog.sendThresholds());
  } catch (err) {
    if (err instanceof exchanges.ExchangeError) return _refusal(err);
    throw err;
  }
  const to = body && body.to;
  let intent = null;
  let result;
  try {
    result = await medusa.sendMessage({
      sessionId,
      to,
      message: body && body.message,
      beforeHub: ({ from }) => {
        const local = medusaWake.localParticipant(to);
        intent = exchanges.createSendIntent({
          meta,
          sender: { projectId: senderProjectId, sessionId, workspaceId: from },
          recipient: { workspaceId: to, projectId: local ? local.projectId : null, sessionId: local ? local.sessionId : null },
          tracking: local ? 'tracked' : 'untracked'
        });
      }
    });
  } catch (err) {
    if (err instanceof exchanges.ExchangeError) return _refusal(err);
    let row = null;
    if (intent && err.hubOutcome === 'unknown') row = exchanges.markSendUnknown(intent.exchange_id, 'bridge-unreachable');
    else if (intent && err.hubOutcome === 'refused') row = exchanges.markSendRefused(intent.exchange_id, 'hub-refused');
    return {
      status: err.httpStatus || 502,
      body: { ...(row ? { exchange: exchanges.view(row) } : {}), error: err.message, code: err.code || 'MEDUSA_SEND_FAILED' }
    };
  }
  try {
    const row = result.id
      ? exchanges.bindHubId(intent.exchange_id, result.id, { hubStatus: result.status, deliveredTo: result.to })
      : exchanges.markSendUnknown(intent.exchange_id, 'hub-no-id');
    return { status: 200, body: { ...result, exchange: exchanges.view(row) } };
  } catch (err) { // prawduct:allow prawduct/broad-except -- the message is already on the Hub; failing the response would invite a duplicate resend
    log.warn('Could not bind a sent Medusa message to its exchange', { exchangeId: intent.exchange_id, error: err.message });
    return {
      status: 200,
      body: { ...result, exchange: exchanges.view(store.medusaExchanges.get(intent.exchange_id)), exchangeError: 'binding-failed' }
    };
  }
}

module.exports = { sendTracked };
