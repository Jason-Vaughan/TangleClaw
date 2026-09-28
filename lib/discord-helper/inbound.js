'use strict';

/**
 * Discord to TangleClaw (#1799, invariants 4, 7 and 8).
 *
 * Every MESSAGE_CREATE the Gateway delivers passes an id-only filter first: the
 * one allowlisted author, guild and channel, no bot (this one included), no
 * webhook, and only an ordinary message or a reply. A message that fails is
 * dropped with a closed code, and its `content` is never read, so nothing from
 * anyone else can reach a log, a reply or TangleClaw.
 *
 * A message that passes goes to the operator channel under its Discord message
 * id, which is what makes a replay harmless: TangleClaw answers `200` for an id
 * it already has and records nothing new. The text is relayed as written. The
 * helper attaches no meaning to it, and TangleClaw delivers it as conversation,
 * never as authority. TangleClaw's display-safety, length and rate limits
 * decide what is accepted; the helper only tells the operator which one said no.
 *
 * @module lib/discord-helper/inbound
 */

/** Discord message types the helper relays: DEFAULT and REPLY. */
const RELAYED_TYPES = new Set([0, 19]);

/** The reaction that says TangleClaw has the message. A single code point, no variation selector. */
const ACCEPTED_REACTION = '✅';

/** How many times a message is offered to an unreachable TangleClaw before the operator is told. */
const TRANSPORT_ATTEMPTS = 3;

/**
 * What the operator is told when TangleClaw refuses a message. Fixed text:
 * nothing from the message or from TangleClaw's answer is echoed.
 * @type {Readonly<Record<string, string>>}
 */
const REFUSAL_TEXT = Object.freeze({
  CHANNEL_DISABLED: 'Not delivered: the TangleClaw operator channel is turned off.',
  NOT_ALLOWLISTED: 'Not delivered: TangleClaw does not allow this author, server or channel.',
  NO_TARGET: 'Not delivered: TangleClaw has no target project set for the operator channel.',
  UNSAFE_TEXT: 'Not delivered: the text is not display-safe. Emoji written with a variation selector or joiner, such as a red heart or a skin tone, are refused.',
  TOO_LONG: 'Not delivered: the text is over 4000 characters.',
  RATE_LIMITED: 'Not delivered: more than 20 messages in a minute. Wait a minute and send it again.',
  UNAUTHORIZED: 'Not delivered: TangleClaw refused the helper\'s token. The helper needs a current operator-channel token.',
  MALFORMED: 'Not delivered: TangleClaw could not accept this message (text only; attachments are not relayed).',
  UNREACHABLE: 'Not delivered: TangleClaw could not be reached. Send the message again later.'
});

/**
 * The refusal key for a failed hand-over.
 * @param {{status: number, refusalCode: (string|null)}} err - A C1Error
 * @returns {string} A key of REFUSAL_TEXT
 */
function refusalKey(err) {
  if (err.refusalCode && Object.prototype.hasOwnProperty.call(REFUSAL_TEXT, err.refusalCode)) return err.refusalCode;
  switch (err.status) {
    case 401: return 'UNAUTHORIZED';
    case 413: return 'TOO_LONG';
    case 429: return 'RATE_LIMITED';
    case 503: return 'CHANNEL_DISABLED';
    case 403: return 'NOT_ALLOWLISTED';
    case 409: return 'NO_TARGET';
    case 400: return 'MALFORMED';
    default: return 'UNREACHABLE';
  }
}

/**
 * Whether a MESSAGE_CREATE is the allowlisted operator's, judged on ids alone.
 * @param {object} d - MESSAGE_CREATE payload
 * @param {{authorId: string, guildId: string, channelId: string}} allow - The allowlist
 * @param {string|null} selfId - The bot's own user id
 * @returns {boolean}
 */
function isOperatorMessage(d, allow, selfId) {
  const author = d && d.author;
  if (!author || typeof author.id !== 'string') return false;
  if (author.bot === true || d.webhook_id) return false;
  if (selfId && author.id === selfId) return false;
  if (!RELAYED_TYPES.has(d.type)) return false;
  return author.id === allow.authorId && d.guild_id === allow.guildId && d.channel_id === allow.channelId
    && typeof d.id === 'string';
}

/**
 * Make the inbound handler.
 * @param {object} opts
 * @param {{authorId: string, guildId: string, channelId: string}} opts.allow - The one allowlisted author, guild and channel
 * @param {{sendInbound: Function}} opts.c1 - Operator-channel client
 * @param {{createMessage: Function, addReaction: Function}} opts.rest - Discord REST client
 * @param {function(string, object=): void} opts.log - Closed-code log
 * @param {function(number): Promise<void>} [opts.sleep] - Delay between transport retries
 * @param {number} [opts.retryDelayMs] - First retry delay; doubles each attempt
 * @returns {function(object, {selfId: (string|null)}=): Promise<string>} Resolves to the outcome's log code
 */
function createInbound({ allow, c1, rest, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 2000 }) {
  /**
   * Tell the operator a message was not delivered, as a reply to it. The nonce
   * is derived from the message id, so a replayed message cannot be answered twice.
   * @param {object} d - The operator's message
   * @param {string} key - A key of REFUSAL_TEXT
   * @returns {Promise<void>}
   */
  async function tellRefused(d, key) {
    try {
      await rest.createMessage(allow.channelId, { content: REFUSAL_TEXT[key], nonce: `r${d.id}`.slice(0, 25), replyTo: d.id });
    // prawduct:allow prawduct/broad-except -- a notice that cannot be posted is logged by code; the message itself was already refused
    } catch {
      log('inbound-notice-failed', { messageId: d.id });
    }
  }

  return async function handleMessageCreate(d, ctx = {}) {
    if (!isOperatorMessage(d, allow, ctx.selfId || null)) {
      log('inbound-ignored');
      return 'inbound-ignored';
    }
    const ids = { id: d.id, authorId: d.author.id, spaceId: d.guild_id, channelId: d.channel_id };
    const text = typeof d.content === 'string' ? d.content : '';
    for (let attempt = 1; ; attempt++) {
      try {
        const { status } = await c1.sendInbound(ids, text);
        const code = status === 200 ? 'inbound-replayed' : 'inbound-accepted';
        log(code, { messageId: d.id });
        try {
          await rest.addReaction(d.channel_id, d.id, ACCEPTED_REACTION);
        // prawduct:allow prawduct/broad-except -- the message is already with TangleClaw; a missing reaction is cosmetic
        } catch {
          log('inbound-notice-failed', { messageId: d.id });
        }
        return code;
      // prawduct:allow prawduct/broad-except -- every hand-over failure is typed by the client (C1Error) and answered below
      } catch (err) {
        const status = Number(err && err.status) || 0;
        const transient = status === 0 || (status >= 500 && status !== 503);
        if (transient && attempt < TRANSPORT_ATTEMPTS) {
          await sleep(retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        const key = transient ? 'UNREACHABLE' : refusalKey({ status, refusalCode: err && err.refusalCode });
        log(transient ? 'inbound-transport-failed' : 'inbound-refused', { messageId: d.id, status });
        await tellRefused(d, key);
        return transient ? 'inbound-transport-failed' : 'inbound-refused';
      }
    }
  };
}

module.exports = { createInbound, isOperatorMessage, refusalKey, REFUSAL_TEXT, ACCEPTED_REACTION, RELAYED_TYPES, TRANSPORT_ATTEMPTS };
