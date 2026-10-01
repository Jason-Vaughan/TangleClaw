'use strict';

/**
 * TangleClaw to Discord (#1799, invariants 5 and 6).
 *
 * A bounded poll collects the operator channel's waiting items (a project's
 * replies and TangleClaw's notifications), posts each to the allowlisted
 * channel, and acknowledges the exact item only once Discord has returned the
 * posted message's id. Nothing is acknowledged on hope.
 *
 * What makes a crash safe is the local record (`state.js`) and Discord's nonce:
 * - Before a post goes out, the item's entry records that an attempt whose
 *   outcome is not yet known began (`since`).
 * - A failure Discord definitely did not act on (a refusal, or a connection
 *   that never opened) clears `since`, so the next poll simply tries again,
 *   but only when that same attempt opened the doubt. An earlier attempt that
 *   may have landed stays in doubt whatever a later attempt says. This is what
 *   delivers everything after a Discord outage without ever posting twice.
 * - A failure that may have posted (a timeout, a 5xx, or a crash) keeps
 *   `since`. The retry reuses the same nonce with `enforce_nonce`, so inside
 *   Discord's de-duplication window it returns the message already made rather
 *   than making another.
 * - Past that window a retry could duplicate, so the item becomes `uncertain`:
 *   never acknowledged, never reposted by itself, and shown by `status` until
 *   the operator settles it. At most one reply is ever in doubt per item, and
 *   no loop can repeat it.
 *
 * A 400 from Discord rejects the item itself (its body), and would reject it
 * again on every retry, so that item alone is set aside as `rejected` (held for
 * the operator, like `uncertain`) and the rest keep moving. `rejected` means
 * Discord did not post it, so a 400 answering a retry made while an earlier
 * attempt is still in doubt holds the item `uncertain` instead. Any other
 * refusal (the token, the channel's permissions, a rate limit) concerns the
 * whole channel, so the poll stops and backs off.
 *
 * The operator settles a held item with what they saw in Discord
 * (`settleHeld`), and each held state takes only the settlement that is true
 * of it. An `uncertain` part either posted (its id is recorded and the relay
 * goes on from the next part) or did not (it is posted again). A `rejected`
 * item is discarded: the helper tells TangleClaw, which drops its text and
 * records it as discarded, never as delivered.
 *
 * The record is written before every post, so a write that fails
 * (`StateWriteError`) means that post was not made. One that fails after a post
 * leaves the posted part on the entry this process holds, so the next poll does
 * not post it again; a restart finds the earlier record, whose `since` is still
 * set, and falls back on the nonce or holds the item `uncertain`.
 *
 * Every way a poll can fail writes one closed code: the expected ones (a post,
 * an acknowledgement, a discard, the poll itself) where they happen, a failed
 * write of the record as `state-write-failed`, and
 * anything else as `outbound-pass-failed` with the error's type and nothing of
 * its message, which could quote a reply.
 *
 * Discord allows 2000 characters a message, so a long item is posted as up to
 * `MAX_PARTS` messages, each with its own nonce and recorded as it lands, and
 * acknowledged with the first one's id. Anything past the last part is cut,
 * with a note saying how much.
 *
 * @module lib/discord-helper/outbound
 */

const { nonceFor, StateWriteError } = require('./state');

/**
 * A failure that was logged where it happened. It ends the poll, and the
 * poll's last catch has nothing to add.
 */
class Reported extends Error {
  constructor() {
    super('reported');
  }
}

/** Discord's per-message limit. */
const DISCORD_MAX = 2000;

/** The most messages one item is split into. */
const MAX_PARTS = 5;

/**
 * How long a nonce is trusted to de-duplicate a retry. Discord promises "the
 * past few minutes"; this stays inside that.
 */
const NONCE_WINDOW_MS = 2 * 60 * 1000;

/** States the operator settles by hand; the relay never retries them. */
const HELD = new Set(['uncertain', 'rejected']);

/**
 * Why a rejected item is discarded, as TangleClaw records it: nothing of it
 * posted, or its earlier parts did. The operator channel accepts exactly these.
 */
const DISCARD_REASON = Object.freeze({ none: 'rejected-by-chat', some: 'rejected-by-chat-partly-posted' });

/**
 * A settlement the operator asked for that cannot be applied. `code` says why:
 * `not-held`, `wrong-state` (the held state takes another settlement),
 * `duplicate-part`, `bad-id` (not a Discord message id) or `bad-settlement`
 * (not exactly one finding).
 */
class SettleError extends Error {
  /**
   * @param {string} code - The closed reason
   * @param {string} [held] - The entry's held state, for `wrong-state`
   */
  constructor(code, held) {
    super(code);
    this.code = code;
    this.held = held || null;
  }
}

/** How TangleClaw's notification types are titled. An unknown type is still posted, generically. */
const NOTIFICATION_TITLES = Object.freeze({
  'operator-needed': 'Operator needed',
  'work-blocked': 'Work blocked',
  'fleet-idle': 'Fleet idle',
  'message-undelivered': 'Message not delivered',
  'release-action-needed': 'Release action needed',
  'certification-state-changed': 'Certification state changed'
});

/**
 * The text to post for one item: a reply as written, a notification under its title.
 * @param {{kind?: string, type?: (string|null), text: string}} item - An outbound item
 * @returns {string}
 */
function render(item) {
  const text = typeof item.text === 'string' ? item.text : '';
  if (item.kind !== 'notification') return text;
  // TangleClaw's own text names TangleClaw, so the title does not repeat it.
  const title = NOTIFICATION_TITLES[item.type] || 'Notification';
  return `\u{1F514} **${title}**\n${text}`;
}

/**
 * Split text into Discord-sized parts, preferring line breaks and never
 * splitting a character. Text past `MAX_PARTS` parts is replaced by a note.
 * @param {string} text - Rendered text
 * @returns {string[]} At least one part
 */
function split(text) {
  const chars = Array.from(text);
  if (chars.length <= DISCORD_MAX) return [text];
  const parts = [];
  let i = 0;
  while (i < chars.length && parts.length < MAX_PARTS) {
    let end = Math.min(i + DISCORD_MAX, chars.length);
    if (end < chars.length) {
      const nl = chars.lastIndexOf('\n', end - 1);
      if (nl > i + DISCORD_MAX / 2) end = nl + 1;
    }
    parts.push(chars.slice(i, end).join(''));
    i = end;
  }
  if (i < chars.length) {
    const last = Array.from(parts[parts.length - 1]);
    const noteFor = (n) => `\n[... ${n} more characters not shown]`;
    // The note may displace the end of the last part, and those characters are
    // cut too, which can lengthen the count; settle on a length that holds.
    let keep = last.length;
    for (;;) {
      const fits = DISCORD_MAX - noteFor(chars.length - i + last.length - keep).length;
      if (keep <= fits) break;
      keep = fits;
    }
    parts[parts.length - 1] = last.slice(0, keep).join('') + noteFor(chars.length - i + last.length - keep);
  }
  return parts;
}

/**
 * An entry for an item that is not `posted`, in another state, with no attempt
 * in doubt: its recorded parts and part count carried over, and nothing else.
 * @param {string} state - The state to give it
 * @param {{parts?: string[], total?: number}} from - The entry it replaces
 * @param {object} [extra] - Fields the new state adds
 * @returns {object}
 */
function carriedEntry(state, from, extra = {}) {
  return { state, since: null, parts: from.parts || [], ...(Number.isInteger(from.total) ? { total: from.total } : {}), ...extra };
}

/**
 * Make the outbound relay.
 * @param {object} opts
 * @param {{listOutbound: Function, ack: Function, discard: Function}} opts.c1 - Operator-channel client
 * @param {{createMessage: Function}} opts.rest - Discord REST client
 * @param {object} opts.state - The durable record from `state.openState`
 * @param {string} opts.channelId - The allowlisted Discord channel
 * @param {function(string, object=): void} opts.log - Closed-code log
 * @param {function(): number} [opts.now] - Clock, in ms
 * @param {object} [opts.timers] - `{setTimeout, clearTimeout}`
 * @param {number} [opts.intervalMs] - Poll interval when all is well
 * @param {number} [opts.maxBackoffMs] - Longest wait after failures
 * @returns {{tick: function(): Promise<string>, start: function(): void, stop: function(): void,
 *   status: function(): object, settleHeld: function(number, object): object}}
 */
function createOutbound({ c1, rest, state, channelId, log, now = Date.now, timers = globalThis, intervalMs = 15000, maxBackoffMs = 5 * 60 * 1000 }) {
  let delay = intervalMs;
  let timer = null;
  let running = null;
  let started = false;
  let lastPoll = null;

  /**
   * Acknowledge a posted item; on success its local entry is dropped.
   * @param {number} id - Outbound id
   * @param {string} postedId - Discord message id
   * @returns {Promise<void>}
   * @throws {Reported} When TangleClaw could not record the ack; the entry stays `posted`
   * @throws {StateWriteError} When the entry could not be dropped; it stays `posted` and is acknowledged again
   */
  async function ack(id, postedId) {
    try {
      await c1.ack(id, postedId);
    // prawduct:allow prawduct/broad-except -- every ack failure is a typed C1Error, sorted below
    } catch (err) {
      // 404: TangleClaw has no such item; 409: it is no longer relayable. Either way
      // there is nothing left to acknowledge, and retrying would never succeed.
      if (err && (err.status === 404 || err.status === 409)) {
        state.remove(id);
        return;
      }
      log('outbound-ack-failed', { outboundId: id, status: Number(err && err.status) || 0 });
      throw new Reported();
    }
    state.remove(id);
    log('outbound-acked', { outboundId: id });
  }

  /**
   * Tell TangleClaw the operator discarded a rejected item; on success its
   * local entry is dropped.
   * @param {number} id - Outbound id
   * @param {object} entry - Its `discarding` entry
   * @returns {Promise<void>}
   * @throws {Reported} When TangleClaw could not be asked; the entry stays `discarding`
   * @throws {StateWriteError} When the record could not be written; the discard is asked again
   */
  async function discard(id, entry) {
    try {
      await c1.discard(id, entry.reason);
    // prawduct:allow prawduct/broad-except -- every discard failure is a typed C1Error, sorted below
    } catch (err) {
      const status = Number(err && err.status) || 0;
      // TangleClaw has no such item, or it is no longer waiting: nothing is left
      // to discard. Said in the log, because the entry goes and `status` stops
      // listing the reply.
      if ((status === 404 && err.refusalCode === 'NOT_FOUND') || status === 409) {
        state.remove(id);
        log('outbound-discard-unneeded', { outboundId: id, status });
        return;
      }
      log('outbound-discard-failed', { outboundId: id, status });
      // No answer, a refused token, a rate limit or a server fault concerns
      // every call, so the poll ends and tries again. Any other refusal is
      // about this one request: a TangleClaw older than this helper answers
      // 403 (its token scope does not know the route) or 400 (it does not know
      // the reason). The item goes back to `rejected`, which is still true of
      // it, so it cannot hold up every reply behind it.
      if (status === 0 || status === 401 || status === 429 || status >= 500) throw new Reported();
      state.set(id, carriedEntry('rejected', entry));
      return;
    }
    state.remove(id);
    log('outbound-discarded', { outboundId: id });
  }

  /**
   * Post one item (every part not yet posted), then acknowledge it.
   * @param {{id: number, kind?: string, type?: (string|null), text: string, inReplyTo: ({messageId: string}|null)}} item
   * @returns {Promise<string>} `acked`, `uncertain`, `rejected`, or `skipped`
   * @throws {Reported} On a Discord or TangleClaw failure; the poll then backs off
   * @throws {StateWriteError} When the record could not be written; the poll then backs off
   */
  async function settle(item) {
    const id = item.id;
    let entry = state.get(id);
    // Only `posting` and `posted` are the relay's to act on. Anything else is
    // the operator's (held, or being discarded) or a state this code does not
    // know, and posting over it could post a reply twice.
    if (entry && entry.state !== 'posting' && entry.state !== 'posted') return 'skipped';
    if (!entry || entry.state !== 'posted') {
      const parts = split(render(item));
      // `total` lets a settlement know whether the part it confirms is the last.
      entry = { ...(entry || { state: 'posting', since: null, parts: [] }), total: parts.length };
      for (let i = entry.parts.length; i < parts.length; i++) {
        if (entry.since !== null && now() - entry.since > NONCE_WINDOW_MS) {
          state.set(id, { ...entry, state: 'uncertain' });
          log('outbound-uncertain', { outboundId: id, part: i });
          return 'uncertain';
        }
        // `since` marks the first attempt that may have landed. Only an attempt
        // that opened it may clear it: a definite failure says nothing about
        // whether an earlier, doubtful attempt posted.
        const opened = entry.since === null;
        // Stamped on a copy, adopted once written: if the write fails, no post
        // follows, and an entry left saying one may have landed would be false.
        const attempt = opened ? { ...entry, since: now() } : entry;
        state.set(id, attempt);
        entry = attempt;
        let posted;
        try {
          posted = await rest.createMessage(channelId, {
            content: parts[i],
            nonce: nonceFor(state.salt, id, i),
            replyTo: i === 0 && item.inReplyTo ? item.inReplyTo.messageId : undefined
          });
        // prawduct:allow prawduct/broad-except -- every post failure is a typed DiscordError, sorted below
        } catch (err) {
          if (err && err.sent === 'no' && opened) {
            entry.since = null;
            state.set(id, entry);
          }
          if (err && err.status === 400) {
            // Discord refused this attempt. With an earlier attempt at the same
            // part still in doubt, whether the part posted is not known, and
            // `rejected` would say it did not.
            const held = entry.since === null ? 'rejected' : 'uncertain';
            state.set(id, { ...entry, state: held });
            log(held === 'rejected' ? 'outbound-rejected' : 'outbound-uncertain', { outboundId: id, part: i });
            return held;
          }
          log('outbound-post-failed', { outboundId: id, status: Number(err && err.status) || 0 });
          throw new Reported();
        }
        entry.parts.push(posted.id);
        entry.since = null;
        state.set(id, entry);
      }
      entry = { state: 'posted', postedId: entry.parts[0] };
      state.set(id, entry);
      log('outbound-posted', { outboundId: id });
    }
    await ack(id, entry.postedId);
    return 'acked';
  }

  /**
   * One poll: acknowledge anything already posted and discard anything the
   * operator discarded, then post what is waiting, in order.
   * @returns {Promise<string>} `ok` or `failed`
   */
  async function pass() {
    try {
      for (const [id, entry] of state.entries()) {
        if (entry.state === 'posted') await ack(id, entry.postedId);
        else if (entry.state === 'discarding') await discard(id, entry);
      }
      let items;
      try {
        items = await c1.listOutbound();
      // prawduct:allow prawduct/broad-except -- a failed poll is one answer: try later, backing off
      } catch (err) {
        log('outbound-poll-failed', { status: Number(err && err.status) || 0 });
        throw new Reported();
      }
      lastPoll = now();
      if (items.length === 0) {
        // TangleClaw lists a page of items, not all of them, so an item missing
        // from a non-empty listing may only be further down. An empty listing
        // is complete whatever the page size: an entry for an item TangleClaw
        // no longer holds has nothing left to post or acknowledge.
        for (const [id, entry] of state.entries()) if (entry.state !== 'posted') state.remove(id);
      }
      let held = 0;
      for (const item of items) {
        if (item && Number.isInteger(item.id) && (await settle(item)) === 'skipped') held += 1;
      }
      // TangleClaw lists the oldest items first, and a held item stays listed
      // until the operator settles it. A listing of nothing but held items means
      // newer replies may be queued behind them, unseen: say so on every poll.
      if (items.length > 0 && held === items.length) log('outbound-queue-held', { held });
      return 'ok';
    // prawduct:allow prawduct/broad-except -- the poll's last catch: every failure ends as one closed code and a backoff
    } catch (err) {
      if (err instanceof StateWriteError) log('state-write-failed');
      else if (!(err instanceof Reported)) log('outbound-pass-failed', { error: err && typeof err.name === 'string' ? err.name : 'unknown' });
      return 'failed';
    }
  }

  /**
   * Run one poll, never two at once.
   * @returns {Promise<string>} `ok` or `failed`
   */
  function tick() {
    if (!running) running = pass().finally(() => { running = null; });
    return running;
  }

  /** @returns {void} */
  function schedule() {
    if (!started) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      const outcome = await tick();
      delay = outcome === 'ok' ? intervalMs : Math.min(delay * 2, maxBackoffMs);
      schedule();
    }, delay);
  }

  return {
    tick,
    /** Start polling. The first poll runs at once. @returns {void} */
    start() {
      if (started) return;
      started = true;
      delay = 0;
      schedule();
      delay = intervalMs;
    },
    /** Stop polling; a poll in progress finishes. @returns {void} */
    stop() {
      started = false;
      if (timer) { timers.clearTimeout(timer); timer = null; }
    },
    /**
     * Non-secret state for `status`: ids and states only, never text.
     * @returns {{lastPollAt: (string|null), nextDelayMs: number, items: Array<{outboundId: number, state: string, partsPosted: number}>}}
     */
    status: () => ({
      lastPollAt: lastPoll === null ? null : new Date(lastPoll).toISOString(),
      nextDelayMs: delay,
      items: state.entries().map(([outboundId, e]) => ({ outboundId, state: e.state, partsPosted: e.state === 'posted' ? 1 : (e.parts || []).length }))
    }),
    /**
     * The operator settles a held item after looking in Discord. Each held
     * state takes only the settlement that is true of it.
     *
     * An `uncertain` item's doubtful part either posted or did not:
     * - `{postedId}`: it did. The id joins the parts already recorded. If that
     *   was the last part the item is `posted`, to be acknowledged with its
     *   FIRST part's id; otherwise it is `posting` again and the next poll
     *   goes on from the part after. An entry with no recorded part count goes
     *   back to `posting` too: the relay finds what, if anything, is left.
     * - `{repost: true}`: it did not. The parts recorded stay posted, and the
     *   doubtful one and those after it are posted on the next poll.
     *
     * A `rejected` item did not post and would be refused again:
     * - `{discard: true}`: it becomes `discarding`, and the next poll tells
     *   TangleClaw, with a reason saying whether its earlier parts posted.
     * @param {number} id - Outbound id
     * @param {{postedId?: string, repost?: boolean, discard?: boolean}} how - The operator's finding
     * @returns {{outboundId: number, state: string, partsPosted: number, total: (number|null)}}
     * @throws {SettleError} `not-held`; `wrong-state` (with the held state);
     *   `duplicate-part` when the id is already an earlier part's; `bad-id`; `bad-settlement`
     * @throws {StateWriteError} When the record could not be written; the item is still held
     */
    settleHeld(id, how) {
      const entry = state.get(id);
      if (!entry || !HELD.has(entry.state)) throw new SettleError('not-held');
      const parts = entry.parts || [];
      const total = Number.isInteger(entry.total) ? entry.total : null;
      /**
       * Write the settled entry and say what it now is.
       * @param {object} next - The entry to record
       * @param {number} partsPosted - How many of the item's parts are recorded as posted
       * @returns {{outboundId: number, state: string, partsPosted: number, total: (number|null)}}
       */
      const done = (next, partsPosted) => {
        state.set(id, next);
        return { outboundId: id, state: next.state, partsPosted, total };
      };
      const h = how || {};
      const asked = [typeof h.postedId === 'string', h.repost === true, h.discard === true].filter(Boolean).length;
      if (asked !== 1) throw new SettleError('bad-settlement');
      if (h.discard === true) {
        if (entry.state !== 'rejected') throw new SettleError('wrong-state', entry.state);
        return done(carriedEntry('discarding', entry, { reason: parts.length > 0 ? DISCARD_REASON.some : DISCARD_REASON.none }), parts.length);
      }
      if (entry.state !== 'uncertain') throw new SettleError('wrong-state', entry.state);
      if (h.repost === true) return done(carriedEntry('posting', entry), parts.length);
      if (!/^\d{1,32}$/.test(h.postedId)) throw new SettleError('bad-id');
      // One Discord message is one part: an id already recorded cannot be another.
      if (parts.includes(h.postedId)) throw new SettleError('duplicate-part');
      const confirmed = [...parts, h.postedId];
      if (total !== null && confirmed.length >= total) return done({ state: 'posted', postedId: confirmed[0] }, confirmed.length);
      return done(carriedEntry('posting', { parts: confirmed, total: entry.total }), confirmed.length);
    }
  };
}

module.exports = { createOutbound, render, split, SettleError, DISCORD_MAX, MAX_PARTS, NONCE_WINDOW_MS, NOTIFICATION_TITLES, DISCARD_REASON };
