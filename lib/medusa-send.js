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
 * Why a send must not cross from the sender's fleet into another (#3077), or
 * null when it may go. The Master (no sender project), the Operator and the
 * Master as callers are exempt, and `allowCrossFleet: true` is the explicit
 * override. Otherwise the recipient must be the Master, the operator bridge or
 * a workspace of a project in the sender's fleet (`medusa.sameFleet`, Ruling
 * A738) — resolved through the live participant first (which follows a
 * rotated workspace id), then the registry index (which places an offline
 * peer). A recipient that belongs to no local project is refused to a grouped
 * or tagged sender: cross-fleet traffic is never implicit.
 * When a project registry could not be read, the refusal carries
 * `details: {reason: 'REGISTRY_UNREADABLE', unreadableRegistries}` (#3084).
 * When no registry in the sender's OWN fleet is unreadable but a registry
 * outside it is — `inFleet.unmappedRefusedForUnreadableRegistry` (#3099) —
 * an unmapped recipient still cannot be ruled out, and the refusal instead
 * carries `details: {reason: 'REGISTRY_UNREADABLE_OUTSIDE_FLEET'}`, naming
 * no project: which registry that is belongs to the other fleet, not this
 * caller (#3103, Rulings A781/A782).
 * @param {object} input
 * @param {number|null} input.senderProjectId
 * @param {object} input.caller - Resolved caller (`kind`)
 * @param {object} input.body - The request body (`to`, `allowCrossFleet`)
 * @returns {{status: number, body: object}|null}
 */
function _crossFleetRefusal({ senderProjectId, caller, body }) {
  if (senderProjectId == null) return null;
  const kind = caller && caller.kind;
  if (kind === 'operator' || kind === 'operator-ui' || kind === 'master') return null;
  if (body && body.allowCrossFleet === true) return null;
  const to = body && body.to;
  const local = _resolveLocalParticipant(to);
  let unreadable = [];
  let outsideFleetUnreadable = false;
  if (local) {
    if (local.projectId == null) return null; // the Master's own listener
    if (medusa.sameFleet(senderProjectId, local.projectId)) return null;
  } else {
    const inFleet = medusa.fleetMembership(senderProjectId);
    if (inFleet(to)) return null;
    unreadable = inFleet.unreadableRegistries || [];
    // `inFleet.unmappedRefusedForUnreadableRegistry` describes the SENDER's
    // overall state, not whether THIS `to` was the unmapped case it covers:
    // a `to` already found in the registry index belongs to a known,
    // different-fleet project and is refused with full confidence regardless
    // of any unrelated registry's readability, so only a genuinely unmapped
    // target (absent from the index too) gets the uncertain wording (#3103).
    const mapped = medusa.workspaceProjectIndex().has(to);
    outsideFleetUnreadable = !mapped && unreadable.length === 0 && inFleet.unmappedRefusedForUnreadableRegistry === true;
  }
  // #3084: still refused, but when a project registry could not be read the
  // recipient may really be in this fleet, so the refusal names those
  // registries instead of a bare "not in your fleet". #3103: when it is a
  // registry OUTSIDE the sender's fleet that is unreadable instead, the
  // same uncertainty applies to an unmapped workspace, but the reason code
  // and wording are distinct — and never name the other fleet's projects.
  let details = {};
  let error;
  if (unreadable.length > 0) {
    details = { details: { reason: 'REGISTRY_UNREADABLE', unreadableRegistries: unreadable } };
    error = `${to} could not be placed in your fleet: ${unreadable.length} project registr${unreadable.length === 1 ? 'y' : 'ies'} could not be read. Send with allowCrossFleet: true if this is intended.`;
  } else if (outsideFleetUnreadable) {
    details = { details: { reason: 'REGISTRY_UNREADABLE_OUTSIDE_FLEET' } };
    error = `${to} could not be placed: a project registry outside your fleet could not be read, so an unmapped workspace cannot be ruled out. Send with allowCrossFleet: true if this is intended.`;
  } else {
    error = `${to} is not in your fleet (no shared project group). Send with allowCrossFleet: true if this is intended.`;
  }
  return {
    status: 403,
    body: {
      ...details,
      error,
      code: 'CROSS_FLEET_FORBIDDEN'
    }
  };
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
  // #3077: refused before any exchange is recorded or the Hub is reached.
  const crossFleet = _crossFleetRefusal({ senderProjectId, caller, body });
  if (crossFleet) return crossFleet;
  const to = body && body.to;
  let intent = null;
  let result;
  try {
    result = await medusa.sendMessage({
      sessionId,
      to,
      message: body && body.message,
      // The request id IS the idempotency key (#2347): both already name the
      // same send, and `createSendIntent` below already refuses a reused
      // `requestId` before the Hub is ever reached, so a genuinely new HTTP
      // call under this `sendTracked` path only ever happens once per
      // `requestId` anyway -- passing it through just lets the Hub apply the
      // SAME guarantee on its own side, for a caller (`lib/check-watch.js`)
      // that reconciles and resends outside this path entirely on a retry.
      idempotencyKey: meta.requestId,
      beforeHub: ({ from }) => {
        const local = _resolveLocalParticipant(to);
        intent = exchanges.createSendIntent({
          meta,
          sender: { projectId: senderProjectId, sessionId, workspaceId: from },
          recipient: { workspaceId: to, projectId: local ? local.projectId : null, sessionId: local ? local.sessionId : null },
          tracking: local ? 'tracked' : 'untracked'
        });
        // Returned, not just closed over (#2347 R4): a FUNCTION `body.message`
        // (check-watch.js's own case) is resolved against exactly this
        // intent's own `created_at`, never a second clock reading.
        return intent;
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
    // #3155: tell this process's own wake monitor the Hub id just sent needs
    // no pane wake. Scoped to a successful send with a real Hub id — never
    // speculatively, and never before the Hub has actually accepted it. Only
    // suppresses a LOCAL recipient's wake (the mark lives in this process's
    // own `medusa-wake.js` module instance); a cross-host recipient's own
    // wake monitor is a different process and never sees it — see
    // `lib/medusa-wake.js#_noWakeIds`'s own doc comment for why that is an
    // honest gap this car's file scope does not close, not a silent one.
    if (body && body.noWake === true && result.id) medusaWake.markNoWake(result.id);
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
