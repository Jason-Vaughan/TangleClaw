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
  UNREACHABLE: 'Not delivered: TangleClaw could not be reached. Send the message again later.',
  ADVISORY_LOOP_PAUSED: 'Not delivered: this advisory conversation is paused after too many consecutive automated turns. '
    + 'An operator message in this channel resumes it.',
  ADVISORY_MENTION_REQUIRED: 'Not delivered: this advisory channel requires mentioning the operator/Master or replying to an existing bridge message.'
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
 * Whether a MESSAGE_CREATE is an advisory peer's message (#2817-A): the
 * third, independently-enabled pinned surface, one channel in the
 * operator's own guild where any of several allowlisted peer authors --
 * human or bot -- may be heard. Unlike {@link isOperatorMessage}, a BOT
 * author is permitted here, but ONLY when that exact bot id is itself on
 * `allow.advisoryAuthorIds`; every other bot, and every webhook or
 * self-message, is still rejected before its content is ever read.
 * @param {object} d - MESSAGE_CREATE payload.
 * @param {{guildId: string, authorId: string, advisoryChannelId: (string|null), advisoryAuthorIds: string[], advisoryEnabled: boolean}} allow - The allowlist.
 * @param {string|null} selfId - The bot's own user id.
 * @returns {boolean}
 */
function isAdvisoryMessage(d, allow, selfId) {
  if (!allow.advisoryEnabled) return false;
  const author = d && d.author;
  if (!author || typeof author.id !== 'string') return false;
  if (d.webhook_id) return false;
  if (selfId && author.id === selfId) return false;
  if (!RELAYED_TYPES.has(d.type)) return false;
  if (typeof d.id !== 'string' || !SNOWFLAKE.test(d.id)) return false;
  if (d.guild_id !== allow.guildId || d.channel_id !== allow.advisoryChannelId) return false;
  if (author.bot === true) return allow.advisoryAuthorIds.includes(author.id);
  return allow.advisoryAuthorIds.includes(author.id) || author.id === allow.authorId;
}

/**
 * Whether a MESSAGE_CREATE actually mentions the operator or the bridge's
 * own bot (#2817-A I-Gate Round 1 Finding 1 on PR #2859: `acceptInbound`'s
 * `advisoryRequireMention` gate requires a verified signal, never a bare
 * field the helper never set). Checks Discord's own structured mentions
 * (`d.mentions`, populated from a real `<@id>` in the content) for the
 * operator's pinned author id or the bot's own id, and falls back to the
 * literal `@master`/`@tangleclaw` names the original spec (issue #2817
 * comment 6597028138) names as an alternative to a structured mention.
 * @param {object} d - MESSAGE_CREATE payload.
 * @param {{authorId: string}} allow - The allowlist.
 * @param {string|null} selfId - The bot's own user id.
 * @returns {boolean}
 */
function mentionsOperatorOrBot(d, allow, selfId) {
  const mentions = Array.isArray(d.mentions) ? d.mentions : [];
  if (mentions.some((u) => u && typeof u.id === 'string' && (u.id === allow.authorId || u.id === selfId))) return true;
  const text = typeof d.content === 'string' ? d.content : '';
  return /(^|[^\w@])@(master|tangleclaw)\b/i.test(text);
}

/**
 * Anchored-grammar parse of a same-user operator reply as a confirmation
 * presentation (#2842 Slice 2): the WHOLE trimmed message must BE the
 * command, not merely contain one -- the shape this repo's own
 * `.claude/rules/learnings/core.md` records after a denylist-scan parser
 * (`lib/permission-requests.js#_persistedBridgeDecision`) went through five
 * review rounds, each missing the next prose shape a human might type.
 * Returns the presented nonce, or null for any text that is not exactly
 * this one grammar -- ordinary conversation is never misread as a
 * confirmation attempt. A pure function: wiring its result into the live
 * message-handling loop (deciding WHEN to call it, and presenting the
 * result to `verifyAndConsumeConfirmation` via the server) is outside this
 * car's file envelope.
 * @param {string} text
 * @returns {string|null} The 64-character hex nonce, or null.
 */
function parseConfirmationReply(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*confirm\s+([0-9a-f]{64})\s*[.!]?\s*$/i.exec(text);
  return m ? m[1] : null;
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
    const onAdvisory = isAdvisoryMessage(d, allow, ctx.selfId || null);
    if (!onAdvisory && !isOperatorMessage(d, allow, ctx.selfId || null)) return 'inbound-ignored';
    // #2817-A anti-loop invariant: a refusal reply posted to another BOT in
    // the advisory channel would itself trigger that bot to reply, looping
    // forever. Stay silent in Discord for a bot sender -- log the refusal
    // locally and nothing more.
    const authorIsBot = d.author.bot === true;
    const maybeTellRefused = async (dd, key) => { if (!authorIsBot) await tellRefused(dd, key); };
    const text = typeof d.content === 'string' ? d.content : '';
    if (!text) {
      log('inbound-refused', { messageId: d.id, status: 0 });
      await maybeTellRefused(d, 'EMPTY_MESSAGE');
      return 'inbound-refused';
    }
    const repliedTo = d.type === 19 && d.message_reference ? d.message_reference.message_id : null;
    const message = {
      // A DM has no space of its own (#2433); the advisory channel is a
      // guild channel like any other, so it keeps its own guild_id as space.
      externalId: d.id, authorId: d.author.id, spaceId: d.guild_id || d.channel_id, channelId: d.channel_id,
      replyToExternalId: typeof repliedTo === 'string' && SNOWFLAKE.test(repliedTo) ? repliedTo : null, text,
      // #2817-A I-Gate Round 1 Finding 1 on PR #2859: a VERIFIED signal from
      // Discord's own mention data (or the literal @master/@tangleclaw
      // names), never a value the server would otherwise have to trust
      // unbacked. Harmless to send outside the advisory surface: the
      // server's own gateway only reads this for an advisory peer's own
      // message when advisoryRequireMention is on.
      mentionsOperator: mentionsOperatorOrBot(d, allow, ctx.selfId || null)
    };
    for (let attempt = 1; ; attempt++) {
      try {
        const { status } = await bridge.sendInbound(message);
        const code = status === 200 ? 'inbound-replayed' : 'inbound-accepted';
        log(code, { messageId: d.id, advisory: onAdvisory, authorIsBot });
        try {
          await rest.addReaction(d.channel_id, d.id, ACCEPTED_REACTION);
        } catch { // prawduct:allow prawduct/broad-except -- the message is already with TangleClaw; a missing reaction is cosmetic
          log('inbound-notice-failed', { messageId: d.id });
        }
        return code;
      } catch (err) { // prawduct:allow prawduct/broad-except -- every hand-over failure is typed by the client (BridgeError) and answered below
        const status = Number(err && err.status) || 0;
        const redirected = err && err.refusalCode === 'REDIRECT_REFUSED';
        // #2817-A: ADVISORY_LOOP_PAUSED and ADVISORY_MENTION_REQUIRED are
        // also 429/403, but neither resolves by retrying moments later the
        // way an ordinary rate limit does -- both need an operator message
        // in the channel (or a mention) to ever succeed, so they are never transient.
        const advisoryTerminal = err && (err.refusalCode === 'ADVISORY_LOOP_PAUSED' || err.refusalCode === 'ADVISORY_MENTION_REQUIRED');
        const transient = !redirected && !advisoryTerminal && (status === 0 || status >= 500 || status === 429);
        if (transient && attempt < TRANSPORT_ATTEMPTS) {
          await sleep(retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        if (redirected) log('redirect-refused', { status });
        const known = err && Object.prototype.hasOwnProperty.call(REFUSAL_TEXT, err.refusalCode) ? err.refusalCode : null;
        const key = transient || redirected ? 'UNREACHABLE' : (known || 'BAD_INBOUND');
        const code = transient || redirected ? 'inbound-transport-failed' : 'inbound-refused';
        log(code, { messageId: d.id, status, advisory: onAdvisory, authorIsBot });
        await maybeTellRefused(d, key);
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

module.exports = { createInbound, isAdvisoryMessage, mentionsOperatorOrBot, parseConfirmationReply, REFUSAL_TEXT };
