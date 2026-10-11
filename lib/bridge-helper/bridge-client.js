'use strict';

/**
 * The helper's only door into TangleClaw: the bridge's six helper routes
 * (#2031, `docs/operator-bridge.md` "The helper's routes").
 *
 * The client has six methods and no general request method, and the paths
 * it can build are a frozen list, so nothing in the helper can address
 * another route with the helper token even by mistake. The server refuses the
 * token everywhere else too; this is the helper's half of the same fence.
 *
 * The token travels only in its header, to the one origin the config names.
 * A redirect is never followed: an answer that points elsewhere is a refusal,
 * so the token cannot be carried to a host nobody configured.
 *
 * @module lib/bridge-helper/bridge-client
 */

const crypto = require('node:crypto');

const TOKEN_HEADER = 'x-tangleclaw-bridge-helper-token';
const NONCE_HEADER = 'x-tangleclaw-bridge-nonce';

/** The only paths this client can build. */
const PATHS = Object.freeze({
  preflight: '/api/bridge/helper/preflight',
  inbound: '/api/bridge/helper/inbound',
  claim: '/api/bridge/helper/outbound/claim',
  part: (id) => `/api/bridge/helper/outbound/${Number(id)}/parts`,
  ack: (id) => `/api/bridge/helper/outbound/${Number(id)}/ack`,
  failure: (id) => `/api/bridge/helper/outbound/${Number(id)}/failure`
});

/** How long a request may take before it is abandoned. */
const TIMEOUT_MS = 15000;

/** A request that did not get a usable answer. `status` 0 means no HTTP answer at all. */
class BridgeError extends Error {
  /**
   * @param {number} status - HTTP status, or 0 for a transport failure.
   * @param {string|null} code - TangleClaw's refusal code, or `REDIRECT_REFUSED`.
   */
  constructor(status, code) {
    super(`bridge ${status || 'unreachable'}${code ? ` ${code}` : ''}`);
    this.status = status;
    this.refusalCode = code;
  }
}

/**
 * A fresh request nonce.
 * @returns {string}
 */
function newNonce() {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * Make a client for one TangleClaw.
 * @param {object} opts
 * @param {string} opts.origin - TangleClaw's origin, already checked by the config.
 * @param {string} opts.token - The helper token.
 * @param {Function} [opts.fetch] - fetch implementation.
 * @returns {{preflight: Function, sendInbound: Function, claim: Function, part: Function, ack: Function, fail: Function}}
 */
function createBridgeClient({ origin, token, fetch: fetchImpl = globalThis.fetch }) {
  /**
   * @param {string} apiPath - One of PATHS.
   * @param {object} body - JSON body.
   * @param {string} nonce - The request's nonce.
   * @returns {Promise<{status: number, body: object}>}
   * @throws {BridgeError}
   */
  async function post(apiPath, body, nonce) {
    let res;
    try {
      res = await fetchImpl(`${origin}${apiPath}`, {
        method: 'POST',
        headers: { [TOKEN_HEADER]: token, [NONCE_HEADER]: nonce, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch { // prawduct:allow prawduct/broad-except -- any fetch failure is one answer: TangleClaw was not reached
      throw new BridgeError(0, null);
    }
    if (res.status >= 300 && res.status < 400) throw new BridgeError(res.status, 'REDIRECT_REFUSED');
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; } // prawduct:allow prawduct/broad-except -- a body that is not JSON carries no code
    if (res.status >= 400) throw new BridgeError(res.status, parsed && typeof parsed.code === 'string' ? parsed.code : null);
    return { status: res.status, body: parsed || {} };
  }

  return {
    /**
     * Ask the bridge what it can say before it is switched on: whether the
     * token is live and whether the helper's three ids are the allowlisted
     * ones. Reads only, and answers in yes, no and a closed word.
     * @param {{authorId: string, spaceId: string, channelId: string}} ids - The ids the helper is configured with.
     * @returns {Promise<{tokenLive: boolean, bridgeEnabled: boolean, allowlistSet: boolean, allowlistMatch: boolean, circuit: string}>}
     */
    preflight: async (ids) => (await post(PATHS.preflight, ids, newNonce())).body,

    /**
     * Hand over one operator message. Each attempt has a nonce of its own:
     * the message's own id is what makes a repeat harmless.
     * @param {{externalId: string, authorId: string, spaceId: string, channelId: string, replyToExternalId: (string|null), text: string}} message - The message.
     * @returns {Promise<{status: number, body: object}>} 202 when new, 200 for a repeat.
     */
    sendInbound: (message) => post(PATHS.inbound, message, newNonce()),

    /**
     * Collect what to post. The nonce names the claim: asking again with the
     * same one returns the same leases, so a claim whose answer was lost is
     * repeated with its own nonce, never a new one.
     *
     * The claim is also how the helper says how its Discord connection is:
     * it is the one request made on every pass, so the report needs no route
     * and no request of its own.
     * @param {string} nonce - The claim's nonce.
     * @param {number} [limit] - At most this many.
     * @param {{state: string, since: string, fatalCloseCode: (number|null)}} [discordGateway] - The
     *   Gateway report (`outbound.js#gatewayReport`); left out, nothing is reported.
     * @returns {Promise<{replayed: boolean, items: object[]}>}
     */
    claim: async (nonce, limit, discordGateway) => {
      const { body } = await post(PATHS.claim, {
        ...(limit === undefined ? {} : { limit }), ...(discordGateway ? { discordGateway } : {})
      }, nonce);
      return { replayed: body.replayed === true, items: Array.isArray(body.items) ? body.items : [] };
    },

    /**
     * Report one message Discord made for an item, as soon as it is made.
     * @param {number} outboundId - Item id.
     * @param {string} leaseId - The lease it was claimed under.
     * @param {{index: number, count: number, externalId: string}} part - Which part, of how many, and Discord's id for it.
     * @returns {Promise<{status: number, body: object}>}
     */
    part: (outboundId, leaseId, part) => post(PATHS.part(outboundId), {
      leaseId, partIndex: part.index, partCount: part.count, externalId: part.externalId
    }, newNonce()),

    /**
     * Acknowledge one posted item under its lease, with every message
     * Discord made for it. This seals the item.
     * @param {number} outboundId - Item id.
     * @param {string} leaseId - The lease it was claimed under.
     * @param {string[]} parts - Discord's id for each posted message, in order.
     * @returns {Promise<{status: number, body: object}>}
     */
    ack: (outboundId, leaseId, parts) => post(PATHS.ack(outboundId), { leaseId, parts, partCount: parts.length }, newNonce()),

    /**
     * Report that an item could not be posted, and which of its parts were.
     * @param {number} outboundId - Item id.
     * @param {string} leaseId - The lease it was claimed under.
     * @param {string} reason - One of the bridge's closed failure reasons.
     * @param {string[]} parts - Discord's id for each message that did post, in order.
     * @param {number} count - How many parts the item has.
     * @returns {Promise<{status: number, body: object}>}
     */
    fail: (outboundId, leaseId, reason, parts, count) => post(PATHS.failure(outboundId), {
      leaseId, reason, ...(parts.length ? { parts, partCount: count } : {})
    }, newNonce())
  };
}

module.exports = { PATHS, TOKEN_HEADER, NONCE_HEADER, BridgeError, createBridgeClient, newNonce };
