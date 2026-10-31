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
 * Every workspace id a live session on this host currently answers to
 * (#2726): the same candidate set `medusaWake.localParticipant` matches
 * against, read for `medusa._reresolveWorkspaceId`'s slug fallback rather
 * than for an exact-id lookup.
 * @returns {string[]}
 */
function _liveLocalWorkspaceIds() {
  const ids = store.sessions.listLiveAll()
    .map((s) => medusa.getStatus(s.id).workspaceId)
    .filter((id) => typeof id === 'string' && id);
  const masterId = medusa.getStatus(require('./master').MASTER_MEDUSA_KEY).workspaceId;
  if (typeof masterId === 'string' && masterId) ids.push(masterId);
  return ids;
}

/**
 * The live local participant a send's target names, resolving a stale,
 * rotated handle (#1023, #2726) by TangleClaw's own id slug when the target
 * no longer matches any live session's current workspace id exactly — so a
 * `blocking` send to a handle a local peer rotated away from is still
 * recorded as supervised, rather than falling to `untracked` purely because
 * the Hub round-trip that would otherwise refresh it has not happened yet.
 * @param {string} to - The send's target workspace id, as the caller gave it
 * @returns {{sessionKey: string, sessionId: (string|null), projectId: (number|null)}|null}
 */
function _resolveLocalParticipant(to) {
  const direct = medusaWake.localParticipant(to);
  if (direct) return direct;
  const resolved = medusa._reresolveWorkspaceId(to, _liveLocalWorkspaceIds().map((id) => ({ id })));
  return resolved.ok ? medusaWake.localParticipant(resolved.id) : null;
}

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
        const local = _resolveLocalParticipant(to);
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
    try {
      // An untracked intent's own retention sweep (#1879) runs synchronously
      // inside `createSendIntent`'s `beforeHub` call, before the Hub is even
      // reached -- so the row can already be gone by the time the Hub call
      // itself fails here. markSendUnknown/markSendRefused both throw
      // EXCHANGE_NOT_FOUND in that case; this response must still succeed.
      if (intent && err.hubOutcome === 'unknown') row = exchanges.markSendUnknown(intent.exchange_id, 'bridge-unreachable');
      else if (intent && err.hubOutcome === 'refused') row = exchanges.markSendRefused(intent.exchange_id, 'hub-refused');
    } catch (markErr) { // prawduct:allow prawduct/broad-except -- the Hub outcome is already final; a pruned exchange is reported as missing, never as a crash
      log.warn('Could not record a Medusa send outcome on its exchange', { exchangeId: intent && intent.exchange_id, error: markErr.message });
    }
    return {
      status: err.httpStatus || 502,
      body: { ...(row ? { exchange: exchanges.view(row) } : {}), error: err.message, code: err.code || 'MEDUSA_SEND_FAILED' }
    };
  }
  try {
    const deliveredRecipient = result.to ? medusaWake.localParticipant(result.to) : null;
    const row = result.id
      ? exchanges.bindHubId(intent.exchange_id, result.id, { hubStatus: result.status, deliveredTo: result.to, deliveredRecipient })
      : exchanges.markSendUnknown(intent.exchange_id, 'hub-no-id');
    return { status: 200, body: { ...result, exchange: exchanges.view(row) } };
  } catch (err) { // prawduct:allow prawduct/broad-except -- the message is already on the Hub; failing the response would invite a duplicate resend
    log.warn('Could not bind a sent Medusa message to its exchange', { exchangeId: intent.exchange_id, error: err.message });
    // Re-fetched, not captured from the failed call above: an untracked
    // exchange's own retention sweep (#1879) can prune it between the
    // insert and this catch, so the row may already be gone by now -- the
    // response must still succeed (the message is already on the Hub).
    const stale = store.medusaExchanges.get(intent.exchange_id);
    return {
      status: 200,
      body: { ...result, ...(stale ? { exchange: exchanges.view(stale) } : {}), exchangeError: 'binding-failed' }
    };
  }
}

module.exports = { sendTracked };
