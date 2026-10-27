'use strict';

/**
 * Discord to TangleClaw (#2031, ADR 0023 Decisions 3 and 11).
 *
 * Every MESSAGE_CREATE the Gateway delivers passes an id-only filter first:
 * the one allowlisted author, server and channel, no bot (this one included),
 * no webhook, and only an ordinary message or a reply. A message that fails
 * is dropped, nothing is logged for it and its `content` is never read, so
 * nothing from anyone else can reach a log, a reply or TangleClaw. The bot
 * sees every channel it was invited to, and a line per message would fill the
 * log with other people's traffic. This is the
 * helper's half of the allowlist; the gateway checks the same three ids again
 * against the operator's own setting.
 *
 * A message that passes goes to the bridge under its Discord message id,
 * which is what makes a repeat harmless: TangleClaw answers `200` for an id
 * it already has and records nothing new. The text is relayed as written. The
 * helper attaches no meaning to it, and TangleClaw treats it as conversation,
 * never as authority.
 *
 * Messages are handed over one at a time, in the order the Gateway delivered
 * them. One waiting out a retry holds back those after it, so a later "wait,
 * don't" cannot arrive before the message it answers.
 *
 * @module lib/bridge-helper/inbound
 */

const { SNOWFLAKE } = require('./config');

/** Discord message types the helper relays: DEFAULT and REPLY. */
const RELAYED_TYPES = new Set([0, 19]);

/** The reaction that says TangleClaw has the message. A single code point. */
const ACCEPTED_REACTION = '✅';

/** How many times a message is offered to an unreachable TangleClaw before the operator is told. */
const TRANSPORT_ATTEMPTS = 3;

/**
 * What the operator is told when a message is not taken. Fixed text: nothing
 * of the message or of TangleClaw's answer is echoed.
 * @type {Readonly<Record<string, string>>}
 */
const REFUSAL_TEXT = Object.freeze({
  BRIDGE_DISABLED: 'Not delivered: the TangleClaw operator bridge is turned off.',
  ALLOWLIST_NOT_SET: 'Not delivered: the TangleClaw operator bridge has no allowlist set.',
  NOT_ALLOWLISTED: 'Not delivered: TangleClaw does not allow this author, server or channel.',
  INBOUND_TOO_LONG: 'Not delivered: the text is over 8000 characters.',
  EMPTY_MESSAGE: 'Not delivered: the message has no text. Attachments are not relayed.',
  HELPER_TOKEN_REQUIRED: 'Not delivered: TangleClaw refused the helper\'s token. The helper needs the current one.',
  LOOPBACK_REQUIRED: 'Not delivered: the helper is not reaching TangleClaw directly on its own machine. Its base URL needs correcting.',
  BAD_INBOUND: 'Not delivered: TangleClaw could not accept this message.',
  UNREACHABLE: 'Not delivered: TangleClaw could not be reached. Send the message again later.'
});

/**
 * Whether a MESSAGE_CREATE is the allowlisted operator's, judged on ids
 * alone: the pinned guild channel, or (#2433) the second, independently-
 * enabled pinned DM channel from the same author. A DM carries no `guild_id`
 * at all, which is what tells the two surfaces apart; every other DM (a
 * bot's, a webhook's, a group DM's own channel id) matches neither branch
 * and is rejected here, before its content is ever read.
 * @param {object} d - MESSAGE_CREATE payload.
 * @param {{authorId: string, guildId: string, channelId: string, dmChannelId: (string|null), dmEnabled: boolean}} allow - The allowlist.
 * @param {string|null} selfId - The bot's own user id.
 * @returns {boolean}
 */
function isOperatorMessage(d, allow, selfId) {
  const author = d && d.author;
  if (!author || typeof author.id !== 'string') return false;
  if (author.bot === true || d.webhook_id) return false;
  if (selfId && author.id === selfId) return false;
  if (!RELAYED_TYPES.has(d.type)) return false;
  if (typeof d.id !== 'string' || !SNOWFLAKE.test(d.id)) return false;
  if (author.id !== allow.authorId) return false;
  if (d.guild_id === allow.guildId && d.channel_id === allow.channelId) return true;
  return Boolean(allow.dmEnabled) && !d.guild_id && d.channel_id === allow.dmChannelId;
}

/**
 * Make the inbound handler.
 * @param {object} opts
 * @param {{authorId: string, guildId: string, channelId: string, dmChannelId: (string|null), dmEnabled: boolean}} opts.allow - The allowlisted author, server and channel, and (#2433) the second pinned DM channel.
 * @param {{sendInbound: Function}} opts.bridge - Bridge client.
 * @param {{createMessage: Function, addReaction: Function}} opts.rest - Discord REST client.
 * @param {function(string, object=): void} opts.log - Closed-code log.
 * @param {function(number): Promise<void>} [opts.sleep] - Delay between transport retries.
 * @param {number} [opts.retryDelayMs] - First retry delay; doubles each attempt.
 * @returns {function(object, {selfId: (string|null)}=): Promise<string>} Resolves to the outcome's log code, once this message and every one before it have been handled.
 */
function createInbound({ allow, bridge, rest, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 2000 }) {
  /**
   * Tell the operator a message was not delivered, as a reply to it, on the
   * surface it arrived on (#2433: a DM failure never falls back to the
   * guild channel, and the reverse). The nonce is derived from the message
   * id, so a replayed message is not answered twice.
   * @param {object} d - The operator's message.
   * @param {string} key - A key of REFUSAL_TEXT.
   * @returns {Promise<void>}
   */
  async function tellRefused(d, key) {
    try {
      await rest.createMessage(d.channel_id, { content: REFUSAL_TEXT[key], nonce: `r${d.id}`.slice(0, 25), replyTo: d.id });
    } catch { // prawduct:allow prawduct/broad-except -- a notice that cannot be posted is logged by code; the message itself was already refused
      log('inbound-notice-failed', { messageId: d.id });
    }
  }

  /**
   * Handle one message.
   * @param {object} d - MESSAGE_CREATE payload.
   * @param {{selfId?: (string|null)}} ctx - Gateway context.
   * @returns {Promise<string>} The outcome's log code.
   */
  async function handleOne(d, ctx) {
    if (!isOperatorMessage(d, allow, ctx.selfId || null)) return 'inbound-ignored';
    const text = typeof d.content === 'string' ? d.content : '';
    if (!text) {
      log('inbound-refused', { messageId: d.id, status: 0 });
      await tellRefused(d, 'EMPTY_MESSAGE');
      return 'inbound-refused';
    }
    const repliedTo = d.type === 19 && d.message_reference ? d.message_reference.message_id : null;
    const message = {
      // A DM has no space of its own (#2433): its channel id names both.
      externalId: d.id, authorId: d.author.id, spaceId: d.guild_id || d.channel_id, channelId: d.channel_id,
      replyToExternalId: typeof repliedTo === 'string' && SNOWFLAKE.test(repliedTo) ? repliedTo : null, text
    };
    for (let attempt = 1; ; attempt++) {
      try {
        const { status } = await bridge.sendInbound(message);
        const code = status === 200 ? 'inbound-replayed' : 'inbound-accepted';
        log(code, { messageId: d.id });
        try {
          await rest.addReaction(d.channel_id, d.id, ACCEPTED_REACTION);
        } catch { // prawduct:allow prawduct/broad-except -- the message is already with TangleClaw; a missing reaction is cosmetic
          log('inbound-notice-failed', { messageId: d.id });
        }
        return code;
      } catch (err) { // prawduct:allow prawduct/broad-except -- every hand-over failure is typed by the client (BridgeError) and answered below
        const status = Number(err && err.status) || 0;
        const redirected = err && err.refusalCode === 'REDIRECT_REFUSED';
        // Over the bridge's rate limit is a wait, like an unreachable bridge:
        // the message is offered again, and the operator is never told to
        // change a message that was only early.
        const transient = !redirected && (status === 0 || status >= 500 || status === 429);
        if (transient && attempt < TRANSPORT_ATTEMPTS) {
          await sleep(retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        if (redirected) log('redirect-refused', { status });
        const known = err && Object.prototype.hasOwnProperty.call(REFUSAL_TEXT, err.refusalCode) ? err.refusalCode : null;
        const key = transient || redirected ? 'UNREACHABLE' : (known || 'BAD_INBOUND');
        const code = transient || redirected ? 'inbound-transport-failed' : 'inbound-refused';
        log(code, { messageId: d.id, status });
        await tellRefused(d, key);
        return code;
      }
    }
  }

  /** The tail of the hand-over queue: each message starts when the one before it has settled. */
  let tail = Promise.resolve();
  return (d, ctx = {}) => {
    const turn = tail.then(() => handleOne(d, ctx));
    tail = turn.catch(() => {}); // prawduct:allow prawduct/broad-except -- one message's failure must not stall the queue; its own promise still rejects
    return turn;
  };
}

module.exports = { createInbound, REFUSAL_TEXT };
