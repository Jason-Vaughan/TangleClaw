'use strict';

/**
 * The two Discord REST calls the helper makes (#1799): post a message and add
 * a reaction. Discord's API over HTTPS, so no desktop app is involved.
 *
 * A post carries a nonce with `enforce_nonce: true`: Discord then checks the
 * nonce for uniqueness over the past few minutes and, for a repeat by the same
 * author, returns the message it already made instead of making another. That
 * is what lets a post interrupted by a crash be retried without a duplicate.
 * A 429 is honoured once with Discord's own `retry_after`, then reported as
 * rate-limited, so the helper never hammers Discord.
 *
 * @module lib/discord-helper/discord-rest
 */

const API = 'https://discord.com/api/v10';

/** A Discord call that did not succeed. `status` 0 means Discord was not reached. */
class DiscordError extends Error {
  /**
   * @param {number} status - HTTP status, or 0
   * @param {number|null} [discordCode] - Discord's JSON error code, when given
   */
  constructor(status, discordCode = null) {
    super(`discord ${status || 'unreachable'}${discordCode ? ` ${discordCode}` : ''}`);
    this.status = status;
    this.discordCode = discordCode;
  }
}

/**
 * Make the REST client.
 * @param {object} opts
 * @param {string} opts.token - Bot token
 * @param {Function} [opts.fetch] - fetch implementation
 * @param {function(number): Promise<void>} [opts.sleep] - Delay, for the one 429 retry
 * @param {string} [opts.api] - API base, for tests
 * @returns {{createMessage: Function, addReaction: Function}}
 */
function createDiscordRest({ token, fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), api = API }) {
  /**
   * @param {string} method - HTTP method
   * @param {string} p - Path under the API base
   * @param {object} [body] - JSON body
   * @returns {Promise<object>}
   */
  async function call(method, p, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${api}${p}`, {
          method,
          headers: {
            Authorization: `Bot ${token}`,
            'User-Agent': 'DiscordBot (https://github.com/Jason-Vaughan/TangleClaw, 1)',
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15000)
        });
      // prawduct:allow prawduct/broad-except -- any fetch failure is one answer: Discord was not reached
      } catch {
        throw new DiscordError(0);
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { parsed = null; } // prawduct:allow prawduct/broad-except -- 204 and non-JSON bodies carry nothing we read
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(Math.max(Number(parsed && parsed.retry_after) || 1, 0), 30);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 400) throw new DiscordError(res.status, parsed && typeof parsed.code === 'number' ? parsed.code : null);
      return parsed || {};
    }
    throw new DiscordError(429);
  }

  return {
    /**
     * Post a message.
     * @param {string} channelId - Channel
     * @param {object} opts
     * @param {string} opts.content - Text
     * @param {string} opts.nonce - At most 25 characters
     * @param {string} [opts.replyTo] - Message to reply to; a vanished one is not an error
     * @returns {Promise<{id: string}>}
     */
    async createMessage(channelId, { content, nonce, replyTo }) {
      const body = {
        content,
        nonce,
        enforce_nonce: true,
        // Mentions in relayed text must not ping anyone.
        allowed_mentions: { parse: [] }
      };
      if (replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
      const msg = await call('POST', `/channels/${encodeURIComponent(channelId)}/messages`, body);
      if (!msg || typeof msg.id !== 'string') throw new DiscordError(502);
      return { id: msg.id };
    },
    /**
     * React to a message.
     * @param {string} channelId - Channel
     * @param {string} messageId - Message
     * @param {string} emoji - A single Unicode emoji
     * @returns {Promise<void>}
     */
    async addReaction(channelId, messageId, emoji) {
      await call('PUT', `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`);
    }
  };
}

module.exports = { API, DiscordError, createDiscordRest };
