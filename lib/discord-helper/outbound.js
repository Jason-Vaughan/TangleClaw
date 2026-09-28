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
 * the operator, like `uncertain`) and the rest keep moving. Any other refusal
 * (the token, the channel's permissions, a rate limit) concerns the whole
 * channel, so the poll stops and backs off.
 *
 * Discord allows 2000 characters a message, so a long item is posted as up to
 * `MAX_PARTS` messages, each with its own nonce and recorded as it lands, and
 * acknowledged with the first one's id. Anything past the last part is cut,
 * with a note saying how much.
 *
 * @module lib/discord-helper/outbound
 */

const { nonceFor } = require('./state');

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

/** How TangleClaw's notification types are titled. An unknown type is still posted, generically. */
const NOTIFICATION_TITLES = Object.freeze({
  'operator-needed': 'Operator needed',
  'work-blocked': 'Work blocked',
  'fleet-idle': 'Fleet idle',
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
 * Make the outbound relay.
 * @param {object} opts
 * @param {{listOutbound: Function, ack: Function}} opts.c1 - Operator-channel client
 * @param {{createMessage: Function}} opts.rest - Discord REST client
 * @param {object} opts.state - The durable record from `state.openState`
 * @param {string} opts.channelId - The allowlisted Discord channel
 * @param {function(string, object=): void} opts.log - Closed-code log
 * @param {function(): number} [opts.now] - Clock, in ms
 * @param {object} [opts.timers] - `{setTimeout, clearTimeout}`
 * @param {number} [opts.intervalMs] - Poll interval when all is well
 * @param {number} [opts.maxBackoffMs] - Longest wait after failures
 * @returns {{tick: function(): Promise<string>, start: function(): void, stop: function(): void,
 *   status: function(): object, settleUncertain: function(number, object): object}}
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
   * @throws {Error} When TangleClaw could not record the ack; the entry stays `posted`
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
      throw err;
    }
    state.remove(id);
    log('outbound-acked', { outboundId: id });
  }

  /**
   * Post one item (every part not yet posted), then acknowledge it.
   * @param {{id: number, kind?: string, type?: (string|null), text: string, inReplyTo: ({messageId: string}|null)}} item
   * @returns {Promise<string>} `acked`, `uncertain`, `rejected`, or `skipped`
   * @throws {Error} On a Discord or TangleClaw failure; the poll then backs off
   */
  async function settle(item) {
    const id = item.id;
    let entry = state.get(id);
    if (entry && HELD.has(entry.state)) return 'skipped';
    if (!entry || entry.state !== 'posted') {
      entry = entry && entry.state === 'posting' ? entry : { state: 'posting', since: null, parts: [] };
      const parts = split(render(item));
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
        if (opened) entry.since = now();
        state.set(id, entry);
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
            state.set(id, { ...entry, state: 'rejected' });
            log('outbound-rejected', { outboundId: id, part: i });
            return 'rejected';
          }
          log('outbound-post-failed', { outboundId: id, status: Number(err && err.status) || 0 });
          throw err;
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
   * One poll: acknowledge anything already posted, then post what is waiting, in order.
   * @returns {Promise<string>} `ok` or `failed`
   */
  async function pass() {
    try {
      for (const [id, entry] of state.entries()) {
        if (entry.state === 'posted') await ack(id, entry.postedId);
      }
      let items;
      try {
        items = await c1.listOutbound();
      // prawduct:allow prawduct/broad-except -- a failed poll is one answer: try later, backing off
      } catch (err) {
        log('outbound-poll-failed', { status: Number(err && err.status) || 0 });
        throw err;
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
    // prawduct:allow prawduct/broad-except -- each failure was logged where it happened; the loop only backs off
    } catch {
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
     * The operator settles a held (`uncertain` or `rejected`) item after looking in Discord:
     * `{postedId}` if it did post (it is then acknowledged with that id), or
     * `{repost: true}` if it did not (it is posted afresh on the next poll).
     * @param {number} id - Outbound id
     * @param {{postedId?: string, repost?: boolean}} how - The operator's finding
     * @returns {{outboundId: number, state: string}}
     * @throws {Error} When the item is not held, or `how` names neither
     */
    settleUncertain(id, how) {
      const entry = state.get(id);
      if (!entry || !HELD.has(entry.state)) throw new Error('not-held');
      if (how && typeof how.postedId === 'string' && /^\d{1,32}$/.test(how.postedId)) {
        state.set(id, { state: 'posted', postedId: how.postedId });
        return { outboundId: id, state: 'posted' };
      }
      if (how && how.repost === true) {
        // Parts already known to have posted stay posted; only the doubtful one is retried.
        state.set(id, { state: 'posting', since: null, parts: entry.parts || [] });
        return { outboundId: id, state: 'posting' };
      }
      throw new Error('bad-settlement');
    }
  };
}

module.exports = { createOutbound, render, split, DISCORD_MAX, MAX_PARTS, NONCE_WINDOW_MS, NOTIFICATION_TITLES };
