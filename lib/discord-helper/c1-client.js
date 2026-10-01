'use strict';

/**
 * The helper's only door into TangleClaw: the operator channel's four helper
 * routes (`docs/operator-channel.md`; the fourth, the discard, is decided in
 * ADR 0022's amendment).
 *
 * The client has exactly four methods and no general request method, and the
 * paths it may build are a frozen list, so nothing in the helper can address
 * another route with the channel token even by mistake. The server refuses the
 * token everywhere else too (`403 CHANNEL_TOKEN_SCOPE`); this is the helper's
 * half of the same fence. The token is sent only as a bearer header and never
 * appears in a returned error.
 *
 * @module lib/discord-helper/c1-client
 */

/** The only paths this client can build. */
const PATHS = Object.freeze({
  inbound: '/api/operator-channel/inbound',
  outbound: '/api/operator-channel/outbound',
  ack: (id) => `/api/operator-channel/outbound/${Number(id)}/ack`,
  discard: (id) => `/api/operator-channel/outbound/${Number(id)}/discard`
});

/** A request that did not get a usable answer. `status` 0 means no HTTP answer at all. */
class C1Error extends Error {
  /**
   * @param {number} status - HTTP status, or 0 for a transport failure
   * @param {string|null} code - TangleClaw's refusal code, when it gave one
   */
  constructor(status, code) {
    super(`operator channel ${status || 'unreachable'}${code ? ` ${code}` : ''}`);
    this.status = status;
    this.refusalCode = code;
  }
}

/**
 * Make a client for one TangleClaw.
 * @param {object} opts
 * @param {string} opts.baseUrl - TangleClaw's origin, e.g. `http://127.0.0.1:3102`
 * @param {string} opts.token - The `ocsk_` channel token
 * @param {Function} [opts.fetch] - fetch implementation
 * @returns {{sendInbound: Function, listOutbound: Function, ack: Function, discard: Function}}
 */
function createC1Client({ baseUrl, token, fetch: fetchImpl = globalThis.fetch }) {
  const origin = new URL(baseUrl).origin;

  /**
   * @param {string} method - HTTP method
   * @param {string} p - One of PATHS
   * @param {object} [body] - JSON body
   * @returns {Promise<{status: number, body: object}>}
   */
  async function request(method, p, body) {
    let res;
    try {
      res = await fetchImpl(`${origin}${p}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });
    // prawduct:allow prawduct/broad-except -- any fetch failure is one answer: TangleClaw was not reached
    } catch {
      throw new C1Error(0, null);
    }
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; } // prawduct:allow prawduct/broad-except -- a body that is not JSON carries no code
    if (res.status >= 400) throw new C1Error(res.status, parsed && typeof parsed.code === 'string' ? parsed.code : null);
    return { status: res.status, body: parsed || {} };
  }

  return {
    /**
     * Hand over one operator message.
     * @param {{id: string, authorId: string, spaceId: string, channelId: string}} message - Ids
     * @param {string} text - The operator's text
     * @returns {Promise<{status: number, body: object}>} 202 new, 200 replay
     */
    sendInbound: (message, text) => request('POST', PATHS.inbound, { message, text }),
    /**
     * The replies waiting to be posted.
     * @returns {Promise<Array<{id: number, kind: string, type: (string|null), text: string, inReplyTo: ({messageId: string}|null)}>>}
     *   `kind` is `reply` or `notification`; `type` names a notification's event
     */
    listOutbound: async () => {
      const { body } = await request('GET', PATHS.outbound);
      return Array.isArray(body.replies) ? body.replies : [];
    },
    /**
     * Acknowledge one posted reply.
     * @param {number} id - Outbound id
     * @param {string} postedId - Discord's message id
     * @returns {Promise<{status: number, body: object}>}
     */
    ack: (id, postedId) => request('POST', PATHS.ack(id), { postedId }),
    /**
     * Discard one item Discord rejected. It is recorded as discarded, never as posted.
     * @param {number} id - Outbound id
     * @param {string} reason - One of the channel's closed discard reasons
     * @returns {Promise<{status: number, body: object}>}
     */
    discard: (id, reason) => request('POST', PATHS.discard(id), { reason })
  };
}

module.exports = { PATHS, C1Error, createC1Client };
