'use strict';

/**
 * The Discord REST calls the helper makes (#2031): post a message, add a
 * reaction, and ask where the Gateway is. Discord's API over HTTPS, so no
 * desktop app is involved.
 *
 * A post carries a nonce with `enforce_nonce: true`. Discord then checks the
 * nonce for uniqueness over the past few minutes and, for a repeat by the
 * same author, returns the message it already made instead of making another.
 * That is what lets a post interrupted by a crash be retried without a
 * duplicate. A 429 is honoured once with Discord's own `retry_after`, then
 * reported, so the helper never hammers Discord. A redirect is never
 * followed: the bot token goes to the API's own origin and nowhere else.
 *
 * @module lib/bridge-helper/discord-rest
 */

const API = 'https://discord.com/api/v10';

/** How long a request may take before it is abandoned. */
const TIMEOUT_MS = 15000;

/** The longest wait a 429 is honoured for, in seconds. */
const MAX_RATE_WAIT_S = 30;

/** Connection failures that happen before a request is written, so Discord cannot have acted on it. */
const NOT_SENT_CAUSES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * A Discord call that did not succeed. `status` 0 means no HTTP answer.
 * `sent` says whether Discord may have acted anyway: `no` for a refusal, a
 * redirect or a connection that never opened, `unknown` for a timeout, a
 * dropped connection or a server error, when a post may have landed.
 */
class DiscordError extends Error {
  /**
   * @param {number} status - HTTP status, or 0.
   * @param {('no'|'unknown')} sent - Whether Discord may have acted.
   * @param {number|null} [discordCode] - Discord's JSON error code, when given.
   */
  constructor(status, sent, discordCode = null) {
    super(`discord ${status || 'unreachable'}${discordCode ? ` ${discordCode}` : ''}`);
    this.status = status;
    this.sent = sent;
    this.discordCode = discordCode;
  }
}

/**
 * Make the REST client.
 * @param {object} opts
 * @param {string} opts.token - Bot token.
 * @param {Function} [opts.fetch] - fetch implementation.
 * @param {function(number): Promise<void>} [opts.sleep] - Delay, for the one 429 retry.
 * @param {string} [opts.api] - API base, for tests.
 * @param {function(string, object=): void} [opts.log] - Closed-code log.
 * @returns {{createMessage: Function, addReaction: Function, getGatewayUrl: Function, getSelf: Function, getChannel: Function}}
 */
function createDiscordRest({ token, fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), api = API, log = () => {} }) {
  /**
   * @param {string} method - HTTP method.
   * @param {string} apiPath - Path under the API base.
   * @param {object} [body] - JSON body.
   * @returns {Promise<object>}
   * @throws {DiscordError}
   */
  async function call(method, apiPath, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${api}${apiPath}`, {
          method,
          headers: {
            authorization: `Bot ${token}`,
            'user-agent': 'DiscordBot (https://github.com/Jason-Vaughan/TangleClaw, 2)',
            ...(body ? { 'content-type': 'application/json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });
      } catch (err) { // prawduct:allow prawduct/broad-except -- any fetch failure is one answer: Discord was not reached
        const cause = err && err.cause && err.cause.code;
        throw new DiscordError(0, NOT_SENT_CAUSES.has(cause) ? 'no' : 'unknown');
      }
      if (res.status >= 300 && res.status < 400) {
        log('redirect-refused', { status: res.status });
        throw new DiscordError(res.status, 'no');
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { parsed = null; } // prawduct:allow prawduct/broad-except -- 204 and non-JSON bodies carry nothing we read
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(Math.max(Number(parsed && parsed.retry_after) || 1, 0), MAX_RATE_WAIT_S);
        log('discord-rate-limited', { waitMs: Math.round(wait * 1000) });
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 400) {
        throw new DiscordError(res.status, res.status < 500 ? 'no' : 'unknown', parsed && typeof parsed.code === 'number' ? parsed.code : null);
      }
      return parsed || {};
    }
    throw new DiscordError(429, 'no');
  }

  return {
    /**
     * Post a message.
     * @param {string} channelId - Channel.
     * @param {object} message
     * @param {string} message.content - Text.
     * @param {string} message.nonce - At most 25 characters.
     * @param {string|null} [message.replyTo] - Message to reply to; a vanished one is not an error.
     * @returns {Promise<{id: string}>}
     */
    async createMessage(channelId, { content, nonce, replyTo }) {
      // Mentions in relayed text must not ping anyone.
      const body = { content, nonce, enforce_nonce: true, allowed_mentions: { parse: [] } };
      if (replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
      const made = await call('POST', `/channels/${encodeURIComponent(channelId)}/messages`, body);
      if (!made || typeof made.id !== 'string' || !/^\d{15,20}$/.test(made.id)) throw new DiscordError(502, 'unknown');
      return { id: made.id };
    },

    /**
     * Where to connect the Gateway: Discord's `GET /gateway/bot`.
     * @returns {Promise<string>} The URL Discord named.
     */
    async getGatewayUrl() {
      const body = await call('GET', '/gateway/bot');
      if (!body || typeof body.url !== 'string') throw new DiscordError(502, 'no');
      return body.url;
    },

    /**
     * Who the token is, by Discord's `GET /users/@me`. Reads only.
     * @returns {Promise<{id: string, bot: boolean}>}
     */
    async getSelf() {
      const body = await call('GET', '/users/@me');
      if (!body || typeof body.id !== 'string') throw new DiscordError(502, 'no');
      return { id: body.id, bot: body.bot === true };
    },

    /**
     * A channel as the token sees it, by Discord's `GET /channels/:id`. Reads
     * only. `recipientId` (#2433) is the one other party of a type-1 DM
     * channel, read from Discord's own `recipients` array; it is null for
     * every other channel type, where Discord sends none.
     * @param {string} channelId - Channel.
     * @returns {Promise<{id: string, guildId: (string|null), type: number, recipientId: (string|null)}>}
     */
    async getChannel(channelId) {
      const body = await call('GET', `/channels/${encodeURIComponent(channelId)}`);
      if (!body || typeof body.id !== 'string') throw new DiscordError(502, 'no');
      const recipients = Array.isArray(body.recipients) ? body.recipients : [];
      const recipientId = recipients.length === 1 && typeof recipients[0].id === 'string' ? recipients[0].id : null;
      return { id: body.id, guildId: typeof body.guild_id === 'string' ? body.guild_id : null, type: Number(body.type), recipientId };
    },

    /**
     * React to a message.
     * @param {string} channelId - Channel.
     * @param {string} messageId - Message.
     * @param {string} emoji - A single Unicode emoji.
     * @returns {Promise<void>}
     */
    async addReaction(channelId, messageId, emoji) {
      await call('PUT', `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`);
    }
  };
}

module.exports = { DiscordError, createDiscordRest };
