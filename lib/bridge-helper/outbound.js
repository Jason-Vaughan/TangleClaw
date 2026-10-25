'use strict';

/**
 * TangleClaw to Discord (#2031, ADR 0023 Decision 11).
 *
 * Each pass claims what waits at the bridge, posts each item to the one
 * allowlisted channel, and acknowledges it under its lease only once Discord
 * has returned the posted message's id. Nothing is acknowledged on hope.
 *
 * A lease gives the helper two minutes; it does not make a post safe to
 * repeat. Three things do, together:
 *
 * - **The bridge's record of parts.** Each message Discord makes is reported
 *   at once. A later claim of the same item says which parts are already
 *   posted, so whoever picks the item up carries on after them. A reply to a
 *   posted part is known for what it answers from that moment.
 * - **The helper's own record** (`state.js`), for the one thing the bridge
 *   cannot know: an attempt whose outcome is in doubt. Before a part goes out
 *   the entry records that an attempt began (`since`). A failure Discord
 *   definitely did not act on clears it, but only when that same attempt set
 *   it. A failure that may have posted keeps it.
 * - **Discord's nonce.** A retry of an attempt in doubt reuses its nonce, so
 *   inside Discord's de-duplication window it returns the message already
 *   made. Past that window a retry could duplicate, so the item is held as
 *   `uncertain`, never reposted by itself.
 *
 * The helper discards nothing. What it cannot post it reports, with a reason
 * from the bridge's closed list. A reason a retry may fix leaves the item
 * waiting. One it will not (Discord rejects the content, the bot may not post
 * in the channel, an outcome that can no longer be verified) has the bridge
 * set the item aside and tell the operator; it stays there until the Project
 * Master or the operator puts it back or withdraws it.
 *
 * The nonce of a claim is recorded before the claim is made, and cleared only
 * when everything it handed over has been dealt with. Until then each pass
 * asks the same claim again first, and the bridge returns the same leases. So
 * a lost answer, a pass that stopped part-way and a restart all carry on with
 * what was already handed over, without waiting for a lease to lapse.
 *
 * An item is checked before it is posted: its text against the digest it was
 * handed over with, and the channel it names against the allowlisted one. The
 * helper posts to that one channel and no other, whatever an item says.
 *
 * @module lib/bridge-helper/outbound
 */

const crypto = require('node:crypto');
const { nonceFor } = require('./state');
const { newNonce } = require('./bridge-client');

/** The most characters posted as one Discord message; Discord allows 2000. */
const PART_MAX = 1900;

/** How long a nonce is trusted to de-duplicate a retry. Discord promises "the past few minutes"; this stays inside that. */
const NONCE_WINDOW_MS = 2 * 60 * 1000;

/** The least time a lease must have left for a part to be posted under it. */
const LEASE_MARGIN_MS = 20 * 1000;

/**
 * Discord's own error codes that say the chat itself will not take posts,
 * and the bridge's reason for each.
 */
const CONFIGURATION_CODES = Object.freeze({
  10003: 'chat-channel-missing',
  10004: 'chat-guild-missing',
  50001: 'chat-permission-denied',
  50013: 'chat-permission-denied'
});

/** Discord's codes for a reply whose target cannot be replied to: it is gone, or its history cannot be read. */
const REPLY_TARGET_CODES = new Set([10008, 160002]);

/**
 * What one attempt to post a message came to, as one of a closed set. This is
 * the only place a failed post is judged; `relay` acts on the answer and
 * decides nothing itself.
 *
 * The helper posts to one fixed channel, so what Discord's answer means there
 * is known:
 *
 * | Discord said | It is |
 * |---|---|
 * | may have acted (timeout, dropped connection, 5xx, an answer with no message id) | `unknown` |
 * | not reached, a redirect, or 429 | `transient` |
 * | code 10003, 10004, 50001 or 50013 | `circuit`, with that code's reason |
 * | 401 | `circuit`, `chat-auth-refused` |
 * | code 10008 or 160002, on a post that named a message to reply to | `retry-unthreaded` |
 * | code 10008 or 160002, on a post that named none | `unplaceable` |
 * | 403 with no code | `circuit`, `chat-permission-denied` |
 * | 404 with no code, on a post that named a message to reply to | `retry-unthreaded` |
 * | 404 with no code, on a post that named none | `circuit`, `chat-channel-missing` |
 * | 403 or 404 with a code not listed here | `unplaceable` |
 * | 400 | `rejected` |
 * | any other 4xx | `unplaceable` |
 *
 * `circuit`, `rejected` and `unplaceable` are definite refusals: Discord did
 * not post this attempt. That settles the item only when this attempt is the
 * first for the part. If an earlier attempt is still in doubt, a refusal now
 * says nothing about whether that one landed, so the answer is `uncertain`:
 * never `transient`, which would be retried, and never a post.
 * @param {object} attempt
 * @param {('no'|'unknown')} attempt.sent - Whether Discord may have acted.
 * @param {number} attempt.status - HTTP status, or 0 for none.
 * @param {number|null} [attempt.discordCode] - Discord's own error code; null, absent or 0 when it gave none.
 * @param {boolean} attempt.fresh - True when no earlier attempt for this part is in doubt.
 * @param {boolean} attempt.threaded - True when this attempt named a message to reply to.
 * @returns {{kind: ('unknown'|'transient'|'retry-unthreaded'|'uncertain'|'rejected'|'unplaceable'|'circuit'), reason?: string}}
 */
function classifyAttempt({ sent, status, discordCode, fresh, threaded }) {
  if (sent !== 'no') return { kind: 'unknown' };
  if (status < 400 || status >= 500 || status === 429) return { kind: 'transient' };
  const coded = Number.isInteger(discordCode) && discordCode !== 0;
  /**
   * What Discord's refusal is, before asking whether an earlier attempt is in doubt.
   * @returns {{kind: string, reason?: string}}
   */
  const said = () => {
    if (CONFIGURATION_CODES[discordCode]) return { kind: 'circuit', reason: CONFIGURATION_CODES[discordCode] };
    if (status === 401) return { kind: 'circuit', reason: 'chat-auth-refused' };
    if (REPLY_TARGET_CODES.has(discordCode)) return { kind: threaded ? 'retry-unthreaded' : 'unplaceable' };
    if (status === 403) return coded ? { kind: 'unplaceable' } : { kind: 'circuit', reason: 'chat-permission-denied' };
    if (status === 404 && coded) return { kind: 'unplaceable' };
    if (status === 404) return threaded ? { kind: 'retry-unthreaded' } : { kind: 'circuit', reason: 'chat-channel-missing' };
    return { kind: status === 400 ? 'rejected' : 'unplaceable' };
  };
  const verdict = said();
  return fresh || verdict.kind === 'retry-unthreaded' ? verdict : { kind: 'uncertain' };
}

/** The state the operator settles by hand; a pass never retries it. */
const HELD = new Set(['uncertain']);

/** A failure that was logged where it happened. It ends the pass, and the pass has nothing to add. */
class Reported extends Error {
  constructor() {
    super('reported');
  }
}

/**
 * A settlement the operator asked for that cannot be applied. `code` says
 * why: `not-held`, `duplicate-part`, `bad-id` or `bad-settlement`.
 */
class SettleError extends Error {
  /**
   * @param {string} code - The closed reason.
   */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * The text to post for one item: who it is from, then what was said. The
 * label is the bridge's; anything in it that Discord would read as formatting
 * is escaped, so a project's name cannot restyle the line.
 * @param {{sourceLabel: string, text: string}} item - A claimed item.
 * @returns {string}
 */
function render(item) {
  const label = String(item.sourceLabel || 'TangleClaw').replace(/([\\*_~`|>#[\]()@:])/g, '\\$1');
  return `**${label}**\n${item.text}`;
}

/**
 * Split text into Discord-sized parts, preferring a line break in the second
 * half of a part, and never splitting a character in two.
 * @param {string} text - Rendered text.
 * @returns {string[]}
 */
function split(text) {
  const chars = Array.from(text);
  const parts = [];
  let at = 0;
  while (chars.length - at > PART_MAX) {
    let cut = at + PART_MAX;
    for (let i = cut; i > at + PART_MAX / 2; i--) {
      if (chars[i - 1] === '\n') { cut = i; break; }
    }
    parts.push(chars.slice(at, cut).join(''));
    at = cut;
  }
  parts.push(chars.slice(at).join(''));
  return parts.filter((part) => part.trim().length > 0);
}

/**
 * What the helper tells the bridge of its Discord connection, from the
 * gateway's own status: closed values only, like everything the helper says.
 *
 * `since` is the time the bridge should count from: when the connection became
 * ready, or, while it is not, when it last stopped being ready. The time the
 * current state began is not sent: a connection that is down changes state on
 * every attempt. The close code is sent only for a connection Discord refused.
 * @param {{state: string, since: string, notReadySince: (string|null), fatalCloseCode: (number|null)}} status - `gateway.status()`.
 * @returns {{state: string, since: string, fatalCloseCode: (number|null)}}
 */
function gatewayReport(status) {
  return {
    state: status.state,
    since: status.notReadySince || status.since,
    fatalCloseCode: status.state === 'fatal' ? status.fatalCloseCode : null
  };
}

/**
 * Make the outbound relay.
 * @param {object} opts
 * @param {string} opts.channelId - The one allowlisted channel.
 * @param {{claim: Function, ack: Function}} opts.bridge - Bridge client.
 * @param {{createMessage: Function}} opts.rest - Discord REST client.
 * @param {object} opts.state - Open state record (`state.js#openState`).
 * @param {function(string, object=): void} opts.log - Closed-code log.
 * @param {function(): number} [opts.now] - Clock, epoch ms.
 * @param {function(): object} [opts.gatewayStatus] - Reads the Discord gateway's
 *   status, which every claim then reports; absent, a claim reports nothing.
 * @returns {{pass: function(): Promise<{ok: boolean, posted: number, acked: number, held: number}>}}
 */
function createOutbound({ channelId, bridge, rest, state, log, now = Date.now, gatewayStatus = null }) {
  /** Entries this process could not write back, so a posted part is never forgotten while it runs. */
  const unsaved = new Map();
  /**
   * An item's entry: this process's own when a write failed, else the record's.
   * @param {number} id - Outbound id.
   * @returns {object|undefined}
   */
  const entryOf = (id) => unsaved.get(id) || state.get(id);

  /**
   * Record an item's entry. A write that fails is reported and ends the pass.
   *
   * What this process then remembers depends on what the write was for. A
   * write made after Discord answered records something that has happened, so
   * the entry is kept here and the part is not posted again while the helper
   * runs. A write made before a post records an intention; if it fails the
   * intention is dropped, not remembered, so the next pass must write it
   * again before it may post.
   * @param {number} id - Outbound id.
   * @param {object} entry - What to hold.
   * @param {object} [options]
   * @param {boolean} [options.happened=true] - False for the write made before a post.
   * @returns {void}
   * @throws {Reported} When the record could not be written.
   */
  function save(id, entry, options = {}) {
    // A copy: the caller goes on changing its own entry, and the record must
    // hold what was written, not what happened afterwards.
    const held = { ...entry, parts: [...entry.parts] };
    try {
      state.set(id, held);
      unsaved.delete(id);
    } catch { // prawduct:allow prawduct/broad-except -- the state module answers every failed write with one closed code
      if (options.happened !== false) unsaved.set(id, held);
      log('state-write-failed', { outboundId: id });
      throw new Reported();
    }
  }

  /**
   * Forget an item: the bridge has it, or has set it aside or let it go.
   * @param {number} id - Outbound id.
   * @returns {void}
   * @throws {Reported} When the record could not be written.
   */
  function forget(id) {
    try {
      state.remove(id);
      unsaved.delete(id);
    } catch { // prawduct:allow prawduct/broad-except -- the state module answers every failed write with one closed code
      log('state-write-failed', { outboundId: id });
      throw new Reported();
    }
  }

  /**
   * What a refusal from the bridge about an item means for the helper.
   *
   * `unbound`: the lease is not the helper's to use any more. The bridge says
   * nothing about the item: it may be delivered, set aside, withdrawn or
   * still waiting, and if it still waits it is handed over again. An
   * acknowledgement the bridge did not apply is read the same way: the item
   * is no longer one this lease can deliver, and asking again under it gets
   * the same answer until the lease lapses, with every other item waiting
   * behind it. `conflict`:
   * the bridge's record of the item disagrees with the helper's. `down`: the
   * bridge did not answer, or refused for a reason that is not about the item.
   * @param {object} err - A BridgeError.
   * @returns {('unbound'|'conflict'|'down')}
   */
  function refusalKind(err) {
    const code = err && err.refusalCode;
    if (['LEASE_LAPSED', 'LEASE_NOT_FOUND', 'LEASE_NOT_YOURS', 'ACK_NOT_APPLIED'].includes(code)) return 'unbound';
    if (['ACK_MISMATCH', 'PART_MISMATCH', 'PART_ID_COLLISION', 'PART_OUT_OF_ORDER'].includes(code)) return 'conflict';
    return 'down';
  }

  /**
   * Tell the bridge an item could not be posted. Best effort for a reason a
   * retry may fix: the item waits either way. For a reason that sets the item
   * aside the report is what raises it with the operator, so a report that
   * does not land is made again on the next pass.
   * @param {object} item - The claimed item.
   * @param {object} entry - Its entry, with the parts that did post.
   * @param {string} reason - One of the bridge's failure reasons.
   * @param {number} total - How many parts the item has.
   * @returns {Promise<boolean>} Whether the bridge took the report.
   */
  async function report(item, entry, reason, total) {
    try {
      await bridge.fail(item.outboundId, item.leaseId, reason, entry.parts, total);
      return true;
    } catch (err) { // prawduct:allow prawduct/broad-except -- every failure is the client's typed BridgeError; a report that did not land is logged and made again
      if (err && err.refusalCode === 'REDIRECT_REFUSED') log('redirect-refused', { status: Number(err.status) || 0 });
      log('outbound-report-failed', { outboundId: item.outboundId, status: Number(err && err.status) || 0 });
      return false;
    }
  }

  /**
   * Give the bridge one posted part's id.
   * @param {object} item - The claimed item.
   * @param {object} entry - Its entry.
   * @param {number} index - Which part.
   * @param {number} total - How many parts the item has.
   * @returns {Promise<('recorded'|'unbound')>}
   * @throws {Reported} When the bridge did not answer, or its record disagrees.
   */
  async function receipt(item, entry, index, total) {
    const id = item.outboundId;
    try {
      await bridge.part(id, item.leaseId, { index, count: total, externalId: entry.parts[index] });
      entry.receipted = Math.max(entry.receipted || 0, index + 1);
      save(id, entry);
      return 'recorded';
    } catch (err) { // prawduct:allow prawduct/broad-except -- a Reported passes through; every other failure is the client's typed BridgeError, answered below
      if (err instanceof Reported) throw err;
      const kind = refusalKind(err);
      const status = Number(err && err.status) || 0;
      if (kind === 'unbound') {
        log('outbound-ack-failed', { outboundId: id, status });
        return 'unbound';
      }
      if (kind === 'conflict') {
        // The message is in the channel and the bridge will not record it as
        // this item's. Nothing the helper does next is safe, so the item is
        // set aside for the operator and the helper lets go of it.
        log('outbound-part-conflict', { outboundId: id, part: index, status });
        if (await report(item, { parts: entry.parts.slice(0, index) }, 'part-conflict', total)) forget(id);
        throw new Reported();
      }
      if (err && err.refusalCode === 'REDIRECT_REFUSED') log('redirect-refused', { status });
      log('outbound-ack-failed', { outboundId: id, status });
      throw new Reported();
    }
  }

  /**
   * Seal a fully posted item under a lease.
   * @param {number} id - Outbound id.
   * @param {object} entry - Its entry, with every part posted.
   * @param {string} leaseId - The lease to acknowledge under.
   * @returns {Promise<boolean>} True when the bridge has it as delivered.
   * @throws {Reported} When the bridge could not be reached.
   */
  async function acknowledge(id, entry, leaseId) {
    try {
      await bridge.ack(id, leaseId, entry.parts);
      forget(id);
      log('outbound-acked', { outboundId: id });
      return true;
    } catch (err) { // prawduct:allow prawduct/broad-except -- a Reported passes through; every other failure is the client's typed BridgeError, answered below
      if (err instanceof Reported) throw err;
      const status = Number(err && err.status) || 0;
      const kind = refusalKind(err);
      if (kind === 'conflict') {
        // The bridge's record of the item's parts is not the helper's. The
        // helper does not seal the item on somebody else's record: it asks for
        // the item to be set aside, and lets go once the bridge has it so.
        log('outbound-part-conflict', { outboundId: id, status });
        if (await report({ outboundId: id, leaseId }, { parts: [] }, 'part-conflict', entry.parts.length)) forget(id);
        return false;
      }
      if (err && err.refusalCode === 'REDIRECT_REFUSED') log('redirect-refused', { status });
      log('outbound-ack-failed', { outboundId: id, status });
      if (kind === 'unbound') {
        // The lease is no longer the helper's, and the bridge says nothing of
        // the item. If the bridge already holds every part, the helper's own
        // record adds nothing: whatever became of the item, it will not be
        // posted again, and if it still waits it is handed over with its
        // parts and sealed then.
        if ((entry.receipted || 0) >= entry.parts.length) {
          forget(id);
        } else if (entry.leaseId) {
          // A lease that is no longer live never becomes usable again, so the
          // helper stops asking under it. The parts it posted stay on its
          // record, to be reported if the item is ever handed over again.
          const { leaseId: spent, ...kept } = entry;
          save(id, kept);
        }
        return false;
      }
      throw new Reported();
    }
  }

  /**
   * Post what is left of one claimed item, then acknowledge it.
   *
   * The bridge says which parts an earlier holder already posted, and the
   * helper's own record may know of one more that it posted and could not
   * report. Posting carries on after the last part either of them knows.
   * @param {object} item - A claimed item with a live lease.
   * @returns {Promise<{outcome: ('acked'|'unacked'|'held'|'set-aside'|'skipped'), posted: boolean}>} `held`: kept here as `uncertain` for the operator. `set-aside`: the bridge was asked to set it aside and the helper keeps nothing. `posted` says whether any part was sent on this call.
   * @throws {Reported} When the pass should stop.
   */
  async function relay(item) {
    const id = item.outboundId;
    const stored = entryOf(id);
    if (item.inReplyTo && item.inReplyTo.channelId !== channelId) {
      log('outbound-foreign-channel', { outboundId: id });
      return { outcome: 'skipped', posted: false };
    }
    if (typeof item.text !== 'string' || crypto.createHash('sha256').update(item.text, 'utf8').digest('hex') !== item.digest) {
      log('outbound-digest-mismatch', { outboundId: id });
      return { outcome: 'skipped', posted: false };
    }
    const parts = split(render(item));
    const total = parts.length;
    if (stored && HELD.has(stored.status)) {
      // Held here for the operator; make sure the bridge knows, so they are told.
      await report(item, stored, 'outcome-unverifiable', total);
      return { outcome: 'held', posted: false };
    }
    const atBridge = Array.isArray(item.postedParts) ? item.postedParts : [];
    const mine = stored ? stored.parts : [];
    if (atBridge.some((partId, i) => i < mine.length && mine[i] !== partId) || (item.partCount && item.partCount !== total)) {
      log('outbound-part-conflict', { outboundId: id });
      if (await report(item, { parts: [] }, 'part-conflict', total) && stored) forget(id);
      return { outcome: 'skipped', posted: false };
    }
    const entry = {
      status: 'posting', round: 0, ...(stored || {}), leaseId: item.leaseId,
      parts: mine.length >= atBridge.length ? [...mine] : [...atBridge], receipted: atBridge.length
    };
    // An attempt in doubt is in doubt for one part: the one after the last the
    // helper knew of. If the bridge already has that part, somebody settled
    // it, and the mark says nothing about the part that comes next.
    if (atBridge.length > mine.length) delete entry.since;
    // Anything this helper posted and could not report is reported before more is posted.
    for (let index = atBridge.length; index < entry.parts.length; index++) {
      if (await receipt(item, entry, index, total) !== 'recorded') return { outcome: 'unacked', posted: false };
    }

    let posted = false;
    while (entry.parts.length < total) {
      const part = entry.parts.length;
      if (entry.since && now() - entry.since > NONCE_WINDOW_MS) {
        save(id, { ...entry, status: 'uncertain' });
        log('outbound-uncertain', { outboundId: id, part });
        await report(item, entry, 'outcome-unverifiable', total);
        return { outcome: 'held', posted };
      }
      if (Date.parse(item.expiresAt) - now() < LEASE_MARGIN_MS) {
        log('outbound-lease-short', { outboundId: id });
        return { outcome: 'skipped', posted };
      }
      const opened = !entry.since;
      if (opened) {
        // On disk before anything is sent, or nothing is sent.
        const since = now();
        save(id, { ...entry, since }, { happened: false });
        entry.since = since;
      }
      const message = { content: parts[part], nonce: nonceFor(state.salt, id, part, entry.round) };
      const replyTo = part === 0 && item.inReplyTo ? item.inReplyTo.externalId : null;
      // Once a part has been tried by itself it stays that way: a later pass
      // does not go back to replying to a message that was not there.
      let threaded = Boolean(replyTo) && entry.unthreaded !== part;
      let made = null;
      let verdict = null;
      let status = 0;
      while (!made) {
        try {
          made = await rest.createMessage(channelId, { ...message, replyTo: threaded ? replyTo : null });
        } catch (err) { // prawduct:allow prawduct/broad-except -- every post failure is the client's typed DiscordError; the classifier answers each one
          status = Number(err && err.status) || 0;
          verdict = classifyAttempt({ sent: err && err.sent, status, discordCode: err && err.discordCode, fresh: opened, threaded });
          if (verdict.kind !== 'retry-unthreaded') break;
          // The message this answers may be gone. That is not the channel
          // being broken: the part is tried once more by itself, under the
          // same nonce, and the log line after this one says how that went.
          log('outbound-reply-target-missing', { outboundId: id });
          threaded = false;
          entry.unthreaded = part;
          save(id, entry);
        }
      }
      if (!made) {
        log('outbound-post-failed', { outboundId: id, status });
        /**
         * Discord did not post this attempt and none before it is in doubt: nothing is in doubt now.
         * @returns {void}
         */
        const settled = () => {
          delete entry.since;
          save(id, entry);
        };
        switch (verdict.kind) {
          case 'unknown':
            // It may have landed. The mark stays, and the next pass retries under the same nonce.
            await report(item, entry, 'outcome-unknown', total);
            throw new Reported();
          case 'transient':
            if (opened) settled();
            await report(item, entry, 'transient', total);
            throw new Reported();
          case 'uncertain':
            // A refusal now does not settle an earlier attempt that may have landed.
            save(id, { ...entry, status: 'uncertain' });
            log('outbound-uncertain', { outboundId: id, part });
            await report(item, entry, 'outcome-unverifiable', total);
            return { outcome: 'held', posted };
          case 'rejected':
            // Discord refused this item's own content, and would again. The
            // bridge sets it aside and tells the operator; the helper lets go.
            settled();
            log('outbound-rejected', { outboundId: id, part });
            if (await report(item, entry, 'rejected-by-chat', total)) forget(id);
            return { outcome: 'set-aside', posted };
          case 'unplaceable':
            // A refusal the helper cannot place: not the item's content, not
            // the channel, not a rate limit. Nothing was posted. It is not
            // retried on a guess: the item is set aside for a person to look at.
            settled();
            log('outbound-unplaceable', { outboundId: id, status });
            if (await report(item, entry, 'outcome-unverifiable', total)) forget(id);
            return { outcome: 'set-aside', posted };
          default:
            // `circuit`: Discord says the chat is closed to the helper
            // altogether. The bridge sets this item aside, stops handing
            // anything over, and tells the operator once; the helper stops here.
            settled();
            log('outbound-chat-closed', { outboundId: id, status, reason: verdict.reason });
            if (await report(item, entry, verdict.reason, total)) forget(id);
            throw new Reported();
        }
      }
      posted = true;
      entry.parts.push(made.id);
      delete entry.since;
      if (entry.parts.length === total) entry.status = 'posted';
      // If this write fails the part stays on the entry this process holds,
      // so it is not posted again while the helper runs.
      save(id, entry);
      log('outbound-posted', { outboundId: id, part });
      if (await receipt(item, entry, part, total) !== 'recorded') return { outcome: 'unacked', posted };
    }
    return { outcome: (await acknowledge(id, entry, item.leaseId)) ? 'acked' : 'unacked', posted };
  }

  /**
   * Ask the bridge for a claim's items, by its nonce.
   * @param {string} nonce - The claim's nonce.
   * @returns {Promise<object[]|null>} The items whose lease is live; null when the bridge refused the claim itself.
   * @throws {Reported} When the bridge could not be asked.
   */
  async function ask(nonce) {
    try {
      // Read at the moment of asking, so a claim asked again says how the
      // connection is now and not how it was when the claim was first made.
      const { items } = await bridge.claim(nonce, undefined, gatewayStatus ? gatewayReport(gatewayStatus()) : undefined);
      return items.filter((item) => item.leaseState === 'live');
    } catch (err) { // prawduct:allow prawduct/broad-except -- every claim failure is the client's typed BridgeError, answered below
      const status = Number(err && err.status) || 0;
      // The nonce is another request's now: the helper token was replaced
      // since the claim was made. There is nothing of it left to carry on with.
      if (err && err.refusalCode === 'NONCE_REUSED') return null;
      if (err && err.refusalCode === 'BRIDGE_CONFIGURATION_BLOCKED') {
        // The bridge hands nothing over until its configuration circuit is
        // reset. Asking changes nothing there; the helper waits and asks again.
        log('bridge-configuration-blocked', { status });
        throw new Reported();
      }
      if (err && err.refusalCode === 'REDIRECT_REFUSED') log('redirect-refused', { status });
      log('claim-failed', { status });
      throw new Reported();
    }
  }

  /**
   * Record the nonce of the claim in progress, or that there is none.
   * @param {string|null} nonce - The nonce.
   * @returns {void}
   * @throws {Reported} When the record could not be written.
   */
  function noteClaim(nonce) {
    try {
      state.setClaim(nonce);
    } catch { // prawduct:allow prawduct/broad-except -- the state module answers every failed write with one closed code
      log('state-write-failed');
      throw new Reported();
    }
  }

  return {
    /**
     * One pass: acknowledge what was posted and not yet taken, carry on with
     * the claim in progress if there is one, then make a new claim and relay
     * what it hands over.
     * @returns {Promise<{ok: boolean, posted: number, acked: number, held: number}>} `posted` counts the items a part was sent for; `ok` is false when the pass stopped early and the helper should back off.
     */
    async pass() {
      const out = { ok: true, posted: 0, acked: 0, held: 0 };
      /**
       * Relay every item of one claim.
       * @param {object[]|null} items - The claim's live items.
       * @returns {Promise<void>}
       */
      const relayAll = async (items) => {
        for (const item of items || []) {
          const done = await relay(item);
          if (done.posted) out.posted += 1;
          if (done.outcome === 'acked') out.acked += 1;
        }
      };
      try {
        for (const [id, entry] of state.entries()) {
          if (entry.status === 'posted' && entry.leaseId && await acknowledge(id, entry, entry.leaseId)) out.acked += 1;
        }
        const inProgress = state.claim();
        if (inProgress) await relayAll(await ask(inProgress));
        // Recorded before it is asked, so a claim the bridge acted on is
        // never one the helper has forgotten.
        const nonce = newNonce();
        noteClaim(nonce);
        await relayAll(await ask(nonce));
        noteClaim(null);
      } catch (err) { // prawduct:allow prawduct/broad-except -- a pass never throws: a Reported was logged where it happened, anything else is logged here by its type alone
        if (!(err instanceof Reported)) log('outbound-pass-failed', { error: err && err.name ? String(err.name) : 'Error' });
        out.ok = false;
      }
      out.held = state.entries().filter(([, entry]) => HELD.has(entry.status)).length;
      return out;
    }
  };
}

/**
 * Settle an item held as `uncertain` with what the operator saw in the
 * channel. Run with the helper stopped.
 *
 * The part in doubt either posted (`posted`: its Discord id is recorded and
 * the relay goes on from the next part) or did not (`repost`: it is posted
 * again, under a new nonce). The bridge set the item aside when it was held,
 * so it moves again only once the Project Master or the operator has put it
 * back.
 * @param {object} state - Open state record (`state.js#openState`).
 * @param {number} id - Outbound id.
 * @param {{posted?: string, repost?: boolean}} finding - Exactly one.
 * @returns {{part: number}} The part the relay carries on from.
 * @throws {SettleError}
 */
function settleHeld(state, id, finding) {
  const entry = state.get(id);
  if (!entry || !HELD.has(entry.status)) throw new SettleError('not-held');
  const posted = Boolean(finding) && finding.posted !== undefined;
  if (posted === Boolean(finding && finding.repost)) throw new SettleError('bad-settlement');
  const next = { ...entry, parts: [...entry.parts], status: 'posting' };
  delete next.since;
  if (posted) {
    if (typeof finding.posted !== 'string' || !/^\d{15,20}$/.test(finding.posted)) throw new SettleError('bad-id');
    if (entry.parts.includes(finding.posted)) throw new SettleError('duplicate-part');
    next.parts.push(finding.posted);
  } else {
    next.round = (entry.round || 0) + 1;
  }
  state.set(id, next);
  return { part: next.parts.length + 1 };
}

module.exports = { createOutbound, gatewayReport, settleHeld, classifyAttempt, render, split, SettleError, PART_MAX, NONCE_WINDOW_MS, LEASE_MARGIN_MS };
