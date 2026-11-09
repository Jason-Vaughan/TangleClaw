'use strict';

/**
 * The check watch monitor (#2323): the server reads each open watch's check
 * from GitHub itself, on a timer, records what it reads, and tells the watch's
 * project over the switchboard.
 *
 * A watch is a session's request to be told when one named check finishes on
 * one exact commit. A terminal result is recorded without anyone asking, a
 * watch that stays unresolved long past its due time is expired, and the
 * project is sent two messages at most: a wake when the result is recorded and
 * an alarm when the due time passes without one.
 *
 * Each pass, for every open watch that is due a read, least recently read
 * first: read the check (`lib/github-checks.js#readCheck`), record the reading
 * (`lib/check-watch-store.js#recordRead`), and then, if the watch still has no
 * result and is `EXPIRE_AFTER_DUE_MS` past its due time, expire it. The read
 * comes before the expiry so a result that is there at the last read is the
 * watch's result, not lost to the expiry. Then the pass sends what is owed.
 *
 * How a message is sent:
 * - **Through the tracked send, as a participant of its own.** The monitor has
 *   a switchboard listener under the key `LISTENER_KEY`, so each message is an
 *   exchange with a delivery receipt. It is the declared owner of every request
 *   id that begins `check-watch:`, and nothing else can make an exchange under
 *   one.
 * - **One request id per watch and message.** It is made from the watch's id
 *   and the message's kind, so a pass after a restart finds the exchange the
 *   earlier pass made and sends nothing new.
 * - **A marker on the last line.** Each message ends `ref: <request id>`. A
 *   message reaches the recipient's listener before the Hub has answered the
 *   send, so in the ordinary case it is the marker that binds the Hub's id to
 *   the exchange ({@link noteArrival}), not the Hub's answer. Nothing is ever
 *   matched by sender, recipient, order or time alone.
 * - **A literal one-wake contract, by idempotency key (#2347).** The request
 *   id a message is sent under IS the Hub idempotency key it is sent with
 *   ({@link module:lib/medusa}#sendMessage's `idempotencyKey`) -- the same
 *   stable value on every attempt, never a second id. A send whose outcome
 *   was never learned is reconciled by that key ({@link
 *   module:lib/medusa}#getMessageReceipt) once its recipient has been
 *   connected for `RECONCILE_AFTER_MS` without a break and no marked arrival
 *   has bound it: if the Hub already has it, that outcome is adopted and
 *   nothing is sent again; only if the Hub genuinely has no record is it
 *   resent, under the identical key and byte-identical text, which replays
 *   rather than duplicates if the Hub actually did take the first attempt
 *   after all. A send the Hub refused, or a key reused with different text
 *   (`IDEMPOTENCY_KEY_CONFLICT`, which cannot happen here since the text for
 *   a given watch+kind never varies), is final.
 *
 * The listener runs only while there is something it may have to send: a
 * watch that is open or owes a message and whose project has a session to
 * tell, or a send still awaiting reconciliation. An install with no watch
 * has one listener fewer.
 *
 * What it deliberately is not:
 * - **It never types into a pane, ends a session or changes anything on
 *   GitHub.** It records, and it sends switchboard messages.
 * - **It is not a retry loop on one watch.** A read that fails is recorded as
 *   failed and the watch waits its turn like any other.
 * - **It decides nothing about state.** What a watch reads as is
 *   `lib/check-watch-state.js#derive` over the record this writes.
 *
 * Three bounds on what it spends, because every read is a `gh` call under this
 * server's own GitHub identity, made with nobody asking:
 * - one pass at a time: a pass still reading when the timer fires again is not
 *   joined by a second;
 * - at most `MAX_IN_FLIGHT` reads at once;
 * - at most `MAX_READS_PER_PASS` reads in a pass, across every project. Past
 *   it the watches read longest ago go first and the rest wait for a later
 *   pass, so the cadence stretches and no watch is starved.
 *
 * An expiry is not held back by a last read that could not reach GitHub: a
 * watch on a repository that can no longer be read would otherwise be read for
 * ever and never free its place.
 *
 * Lifecycle mirrors `lib/workload-nudge.js`: `start()` arms a `setInterval`
 * wired in `server.js`, `stop()` clears it and stops the listener.
 *
 * @module lib/check-watch
 */

const path = require('node:path');
const { createLogger } = require('./logger');
const state = require('./check-watch-state');

const log = createLogger('check-watch');

/**
 * Pass cadence, which is what sets how often a watch is read: once a minute.
 * A check takes minutes, so a result recorded up to a minute late costs
 * nothing, and each read is a call to GitHub.
 * @type {number}
 */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * The least time between two reads of one watch. Shorter than the cadence on
 * purpose: a read is stamped when it completes, so a gap equal to the cadence
 * would find every watch a moment short of due and read it every other pass.
 * It is what stops a burst when passes come faster than the timer (a restart,
 * or a caller driving the monitor by hand).
 * @type {number}
 */
const MIN_READ_GAP_MS = 45_000;

/**
 * The most reads one pass makes, across every project. A project may hold
 * `MAX_OPEN_PER_PROJECT` open watches and nothing bounds the number of
 * projects, so without this the reads made with nobody asking grow with the
 * install and are spent from the one GitHub identity everything else here
 * reads with.
 * @type {number}
 */
const MAX_READS_PER_PASS = 30;

/** The most reads in flight at once: `lib/github-facts.js`'s number for the same `gh`. */
const MAX_IN_FLIGHT = 4;

/** The key of the monitor's own switchboard listener. A name, never a session number. */
const LISTENER_KEY = 'check-watch';

/** The name the monitor's listener registers under, which is what a roster shows. */
const LISTENER_NAME = 'Check Watch';

/**
 * How long a recipient must have been connected without a break, with no
 * marked arrival bound, before a send whose outcome was never learned is
 * reconciled with the Hub by idempotency key (#2347) and, only if the Hub
 * genuinely has no record of it, resent under that SAME key. A message the
 * Hub holds is delivered within milliseconds of its recipient connecting, so
 * two connected minutes of silence is strong evidence the Hub does not hold
 * it -- the same threshold the old second-attempt model used, kept
 * unchanged; only what happens once it fires has changed.
 * @type {number}
 */
const RECONCILE_AFTER_MS = 2 * 60_000;

/**
 * How long after it was sent a delivered message nobody acknowledged has its
 * exchange closed. The facts stay, and a later read or acknowledgement is
 * still recorded on it.
 * @type {number}
 */
const CLOSE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The most first sends one pass makes; the rest are sent by the next. */
const MAX_SENDS_PER_PASS = 30;

/**
 * How long a pass waits for the Hub to answer one send. The send is not
 * abandoned: its exchange already exists, and an answer that comes later is
 * still bound to it. The pass only stops waiting, so a Hub that hangs cannot
 * stop the reads.
 * @type {number}
 */
const SEND_WAIT_MS = 15_000;

/**
 * A request id the monitor makes: the kind and the watch. `(:2)?` is kept
 * recognizing, never generating (#2347) — a legacy second-attempt exchange
 * a pre-#2347 deployment already created still parses as the monitor's own.
 */
const REQUEST_ID_SHAPE = new RegExp(`^${state.REQUEST_ID_PREFIX}(${state.MESSAGE_KINDS.join('|')}):([A-Za-z0-9_-]{1,64})(:2)?$`);

/** The last line of every message the monitor sends. */
const MARKER_SHAPE = /^ref: (\S+)$/;

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/**
 * The pass now running, if one is.
 * @type {Promise<object>|null}
 */
let _pass = null;

/** Whether the last pass left watches unread because of the ceiling, so the log says it on a change and not every minute. */
let _deferring = false;

/** Whether the last pass asked for was skipped because one was still running, so the log says it on a change. */
let _skipping = false;

/** Whether the last pass had something to send and a listener of its own that was not connected, so the log says it on a change. */
let _unconnected = false;

/** The request ids already reported as held by an exchange the monitor did not make, so each is logged once. */
const _foreign = new Set();

/**
 * What one pass did, all zero. `sent` counts first sends and `reconciled`
 * counts a send whose outcome was reconciled with the Hub by idempotency key
 * (#2347) — whether that found an existing receipt (no resend) or genuinely
 * resent under the same key; `undeliverable` counts messages newly recorded
 * as having nobody to go to; `closed` counts exchanges closed for age.
 * @returns {{open: number, read: number, resolved: number, readFailed: number, expired: number, deferred: number, sent: number, reconciled: number, undeliverable: number, closed: number, errors: number}}
 */
function _summary() {
  return { open: 0, read: 0, resolved: 0, readFailed: 0, expired: 0, deferred: 0, sent: 0, reconciled: 0, undeliverable: 0, closed: 0, errors: 0 };
}

/**
 * Whether a watch is due a read: never read, or last read at least
 * `MIN_READ_GAP_MS` ago. A last read that cannot be placed in time, or that
 * lies ahead of the clock, does not hold a watch back.
 * @param {object} watch - An open watch
 * @param {number} now - The pass's clock reading, in ms
 * @returns {boolean}
 */
function _dueForRead(watch, now) {
  const last = watch.lastRead ? Date.parse(watch.lastRead.at) : NaN;
  if (!Number.isFinite(last)) return true;
  const gap = now - last;
  return !(gap >= 0 && gap < MIN_READ_GAP_MS);
}

/**
 * Read a watch's check. Never throws and always answers with a reading: a
 * reader that throws is a read that failed, said as one.
 * @param {object} watch - An open watch
 * @returns {Promise<object>} A reading in `readCheck`'s shape
 */
async function _read(watch) {
  try {
    return await _internal.readCheck(watch.repo, watch.headSha, watch.checkName);
  // prawduct:allow prawduct/broad-except -- whatever the reader throws, the watch is owed a recorded failed read; an unrecorded one would keep it at the head of every pass
  } catch (err) {
    return { status: 'unavailable', reason: `the check could not be read (${err && err.message ? err.message : 'unknown error'})` };
  }
}

/**
 * Record a reading, and record it as a failed read when the store does not
 * take it as a reading at all.
 * @param {object} watch - The watch read
 * @param {object} reading - What the reader answered
 * @returns {object} The store's answer
 */
function _record(watch, reading) {
  const out = _internal.recordRead(watch.watchId, reading);
  if (out.ok || out.code !== state.REFUSALS.MALFORMED) return out;
  return _internal.recordRead(watch.watchId, { status: 'unavailable', reason: 'the reader answered with something that is not a reading of a check' });
}

/**
 * Say in the log what a recorded read changed, when it changed something.
 * @param {object} names - The watch's identifying fields
 * @param {object} out - The store's answer to the read
 * @returns {void}
 */
function _logRead(names, out) {
  if (out.recorded === 'resolved') {
    log.info('Recorded a watched check\'s result', { ...names, conclusion: out.watch.result.conclusion, runId: out.watch.result.runId });
  } else if (out.recorded === 'read-failed') {
    log.warn('A watched check could not be read from GitHub; its watch reads unknown until a read works', {
      ...names, reason: out.watch.lastRead ? out.watch.lastRead.detail : null
    });
  } else if (out.recorded === 'read-recovered') {
    log.info('A watched check can be read from GitHub again', names);
  }
}

/**
 * Read one watch, record the reading, and expire the watch if it is still
 * unresolved long past its due time. Never throws.
 * @param {object} watch - An open watch
 * @param {number} now - The pass's clock reading, in ms
 * @param {object} summary - The pass's counts, added to here
 * @returns {Promise<void>}
 */
async function _readOne(watch, now, summary) {
  const names = { watch: watch.watchId, project: watch.projectId, repo: watch.repo, sha: watch.headSha, check: watch.checkName };
  try {
    const reading = await _read(watch);
    summary.read += 1;
    const out = _record(watch, reading);
    // Refused: the watch was cancelled, resolved or expired while GitHub was
    // being read. It is no longer this monitor's to write.
    if (!out.ok) return;
    _logRead(names, out);
    if (out.watch.lastRead && out.watch.lastRead.outcome === 'failed') summary.readFailed += 1;
    if (out.watch.result) {
      summary.resolved += 1;
      return;
    }
    if (!(now >= Date.parse(watch.dueAt) + state.EXPIRE_AFTER_DUE_MS)) return;
    const expired = _internal.recordExpired(watch.watchId);
    if (!expired.ok) return;
    summary.expired += 1;
    log.info('Expired a check watch that stayed unresolved; it is not read again and a new watch is needed', { ...names, dueAt: watch.dueAt });
  // prawduct:allow prawduct/broad-except -- one watch must not stop the pass; the next pass reads it again
  } catch (err) {
    summary.errors += 1;
    log.warn('Check watch read failed for one watch', { ...names, error: err && err.message });
  }
}

/**
 * Run `work` over `items`, at most `width` at a time.
 * @param {object[]} items - What to work through, in order
 * @param {number} width - The most in flight at once
 * @param {(item: object) => Promise<void>} work - Must not reject
 * @returns {Promise<void>}
 */
async function _pool(items, width, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

/**
 * The one request id (and, since #2347, the one Hub idempotency key) a
 * watch's message is sent under -- the watch's own, stable id, never a `:2`
 * variant. The same string is passed to the Hub as `idempotencyKey` on
 * every attempt (the first send and any later reconciliation resend alike),
 * which is what makes a resend replay instead of duplicate.
 * @param {string} watchId - Watch id
 * @param {'wake'|'alarm'} kind - Which message
 * @returns {string}
 */
function _requestId(watchId, kind) {
  return state.requestIdFor(watchId, kind);
}

/**
 * What a request id of the monitor's names, or null for an id it does not
 * make. Still recognizes a `:2` suffix (`attempt: 2`) so an exchange a
 * pre-#2347 deployment already made under the old second-attempt model is
 * still read as the monitor's own -- the monitor never MAKES one of these
 * again, but a live database can already hold one from before the upgrade.
 * @param {*} requestId - Candidate request id
 * @returns {{requestId: string, kind: ('wake'|'alarm'), watchId: string, attempt: (1|2)}|null}
 */
function _parseRequestId(requestId) {
  const m = typeof requestId === 'string' ? REQUEST_ID_SHAPE.exec(requestId) : null;
  return m ? { requestId, kind: m[1], watchId: m[2], attempt: m[3] ? 2 : 1 } : null;
}

/**
 * The marker a received message ends with, or null: the request id named on
 * its last line, when that is one the monitor makes.
 * @param {object} message - A received message
 * @returns {{requestId: string, kind: string, watchId: string, attempt: number}|null}
 */
function _markerOf(message) {
  const text = message && (message.message ?? message.content);
  if (typeof text !== 'string') return null;
  const m = MARKER_SHAPE.exec(text.trimEnd().split('\n').pop());
  return m ? _parseRequestId(m[1]) : null;
}

/**
 * Whether an exchange is one the monitor itself sent.
 * @param {object|null} exchange - Exchange row
 * @returns {boolean}
 */
function _isOwn(exchange) {
  return _internal.exchanges().systemOwnerOf(exchange) === LISTENER_KEY;
}

/**
 * The exchange that carried one of a watch's messages, and — only ever for
 * one made by a pre-#2347 deployment's old second-attempt model — a second
 * one under the legacy `:2` id. Since #2347 the monitor never makes a
 * second exchange for any new watch+kind: an uncertain send is reconciled
 * and, if truly never delivered, resent under the SAME id/idempotency key,
 * so `second` reads null for every watch this version of the monitor has
 * ever sent for. Only the monitor's own sends are answered; an exchange
 * anyone else made under one of these ids is not this message's.
 * @param {string} watchId - Watch id
 * @param {'wake'|'alarm'} kind - Which message
 * @returns {{first: (object|null), second: (object|null)}} Raw exchange rows
 */
function exchangesOf(watchId, kind) {
  const rows = _internal.exchangeRows();
  const own = (requestId) => {
    const row = rows.getByRequestId(requestId);
    return row && _isOwn(row) ? row : null;
  };
  return { first: own(_requestId(watchId, kind)), second: own(`${_requestId(watchId, kind)}:2`) };
}

/**
 * The words that open both of a watch's messages: which check, where.
 * @param {object} watch - The watch
 * @returns {string}
 */
function _subject(watch) {
  return `\`${watch.checkName}\` on PR #${watch.prNumber} of ${watch.repo}, commit ${watch.headSha}`;
}

/**
 * The lines every message of a watch ends with: how to read the watch, that
 * no reply is read, and the marker last. No longer varies by attempt
 * (#2347): the text a reconciliation resend sends must be byte-identical to
 * the original, since both go under the same Hub idempotency key, and only
 * an identical `{to, from, message}` replays rather than conflicts.
 * @param {object} watch - The watch
 * @param {string} requestId - The request id (and idempotency key) this message is sent under
 * @returns {string[]}
 */
function _closing(watch, requestId) {
  return [
    `Read it with \`tc check show ${watch.watchId}\`. This is from TangleClaw's check watch monitor; a reply is not read.`,
    `ref: ${requestId}`
  ];
}

/**
 * The wake: a watch's check finished, and how.
 * @param {object} watch - A watch with its result
 * @returns {string}
 */
function _wakeText(watch) {
  const { conclusion, runId, completedAt } = watch.result;
  return [
    `Check watch: ${_subject(watch)} finished: ${conclusion}.${conclusion === 'success' ? '' : ' It did not pass.'}`,
    `Completed ${completedAt} (run ${runId}); recorded ${watch.result.readAt}.`,
    ..._closing(watch, _requestId(watch.watchId, 'wake'))
  ].join('\n');
}

/**
 * The alarm: a watch's due time passed with no result. It always names the
 * due time and says whether the watch is still read; it says the alarm is
 * late by `firstSentAt`, a value fixed once (the exchange's own `created_at`
 * — see {@link _text}) and never recomputed, so a reconciliation resend's
 * text stays byte-identical to the original no matter how much later it is
 * actually transmitted.
 * @param {object} watch - A watch with no result
 * @param {number} firstSentAt - When this alarm's exchange was created, in ms — fixed for the life of the watch's alarm, not "now"
 * @returns {string}
 */
function _alarmText(watch, firstSentAt) {
  const due = Date.parse(watch.dueAt);
  const lines = [
    `Check watch: ${_subject(watch)} had no result at its due time, ${watch.dueAt}.`,
    `The watch reads unknown: the check is not known to have passed or failed. Read the check yourself (\`gh pr checks ${watch.prNumber}\`).`
  ];
  if (firstSentAt - due > 2 * DEFAULT_INTERVAL_MS) {
    const sent = new Date(firstSentAt).toISOString();
    lines.push(`This alarm is late. It was due at ${watch.dueAt} and was first sent at ${sent}: until then it could not be sent to a session of this project.`);
  }
  lines.push(watch.expired
    ? `The watch expired at ${watch.expired.at} with no result and is not read again. Register a new watch to go on watching.`
    : `It is still read until ${new Date(due + state.EXPIRE_AFTER_DUE_MS).toISOString()}, and a result recorded by then wakes you.`);
  return [...lines, ..._closing(watch, _requestId(watch.watchId, 'alarm'))].join('\n');
}

/**
 * The text of one of a watch's messages. Deterministic in (watch, kind,
 * firstSentAt) alone (#2347) — a wake's text never varies at all, and an
 * alarm's only free variable is `firstSentAt`, which the caller always
 * sources from the exchange's own `created_at` (see {@link _sendFirst} and
 * {@link _reconcile}), never from the current pass's clock — so the exact
 * same text is sent (and replayed, never duplicated) whether this is the
 * original send or a later reconciliation resend.
 * @param {object} watch - The watch
 * @param {'wake'|'alarm'} kind - Which message
 * @param {number} firstSentAt - When the message's exchange was created, in ms
 * @returns {string}
 */
function _text(watch, kind, firstSentAt) {
  return kind === 'wake' ? _wakeText(watch) : _alarmText(watch, firstSentAt);
}

/**
 * Who a project's message goes to: its one active session with a connected
 * listener. None, more than one, or one whose listener is not connected names
 * nobody, with the reason: which of two sessions a message is for is never
 * guessed, and the Hub refuses a send to a closed socket for good.
 * @param {{recipients: Map<number, object>}} ctx - The pass's cache, one answer per project
 * @param {number} projectId - Project id
 * @returns {{ok: true, workspaceId: string}|{ok: false, code: string, workspaceId: (string|null)}}
 */
function _recipient(ctx, projectId) {
  if (ctx.recipients.has(projectId)) return ctx.recipients.get(projectId);
  const medusa = _internal.medusa();
  const active = _internal.activeSessions(projectId);
  const reachable = active.map((session) => medusa.getStatus(session.id)).filter((status) => status.workspaceId);
  let answer;
  if (reachable.length === 0) {
    answer = { ok: false, code: active.length ? 'no-switchboard-session' : 'no-live-session', workspaceId: null };
  } else if (reachable.length > 1) {
    answer = { ok: false, code: 'several-live-sessions', workspaceId: null };
  } else if (reachable[0].state !== 'listening') {
    answer = { ok: false, code: 'recipient-not-connected', workspaceId: reachable[0].workspaceId };
  } else {
    answer = { ok: true, workspaceId: reachable[0].workspaceId };
  }
  ctx.recipients.set(projectId, answer);
  return answer;
}

/**
 * Record on the watch that its message's send was made, once, with how the
 * send stood then. What became of the message afterwards is read from its
 * exchanges, never from this code.
 * @param {object} watch - The watch
 * @param {'wake'|'alarm'} kind - Which message
 * @param {object} exchange - The first attempt's exchange row
 * @returns {void}
 */
function _recordSent(watch, kind, exchange) {
  const code = exchange.hub_id ? 'accepted' : (exchange.terminal_at ? 'refused' : 'uncertain');
  const out = _internal.watches().recordSent(watch.watchId, kind, {
    exchangeId: exchange.exchange_id, workspaceId: exchange.recipient_workspace_id, code
  });
  const names = { watch: watch.watchId, project: watch.projectId, message: kind, exchange: exchange.exchange_id, to: exchange.recipient_workspace_id };
  if (!out.ok) {
    if (out.code !== state.REFUSALS.ALREADY_RECORDED) log.warn('A check watch message was sent and could not be recorded on its watch', { ...names, code: out.code });
    return;
  }
  if (code === 'accepted') log.info('Sent a check watch message', names);
  else log.warn(`A check watch message was sent and its outcome is ${code}`, names);
}

/**
 * Go through the messages owed and settle every one that needs no send: a
 * message whose exchange already exists (an earlier pass made it, and nothing
 * new is sent on that id) is recorded from that exchange, and one with nobody
 * to go to is recorded as undeliverable, once, spending no request id. What is
 * left can be sent now.
 * @param {{now: number, recipients: Map<number, object>}} ctx - The pass
 * @param {object} summary - The pass's counts, added to here
 * @returns {Array<{watch: object, kind: string, to: string, requestId: string}>} What to send
 */
function _settleOwed(ctx, summary) {
  const watches = _internal.watches();
  const rows = _internal.exchangeRows();
  const sendable = [];
  for (const kind of state.MESSAGE_KINDS) {
    for (const watch of watches.listOwed(kind, ctx.now)) {
      const requestId = _requestId(watch.watchId, kind);
      const made = rows.getByRequestId(requestId);
      if (made) {
        if (_isOwn(made)) {
          _recordSent(watch, kind, made);
        } else if (!_foreign.has(requestId)) {
          // Never adopted: a receipt on an exchange the monitor did not make says nothing about its message.
          _foreign.add(requestId);
          log.warn('A check watch message cannot be sent: its request id is held by an exchange the monitor did not make', {
            watch: watch.watchId, message: kind, exchange: made.exchange_id
          });
        }
        continue;
      }
      const recipient = _recipient(ctx, watch.projectId);
      if (recipient.ok) {
        sendable.push({ watch, kind, to: recipient.workspaceId, requestId });
        continue;
      }
      const out = watches.recordUndeliverable(watch.watchId, kind, { code: recipient.code, workspaceId: recipient.workspaceId || undefined });
      if (out.ok) {
        summary.undeliverable += 1;
        log.info('A check watch message has nobody to go to yet; it is sent when the project has a session to tell', {
          watch: watch.watchId, project: watch.projectId, message: kind, code: recipient.code
        });
      }
    }
  }
  return sendable;
}

/**
 * Send one message through the tracked send and wait a bounded time for the
 * Hub's answer. Never throws. Whether anything was sent is read afterwards
 * from the exchange the send made, not from what this returns.
 * @param {string} requestId - The request id to send under
 * @param {string} to - The recipient's workspace
 * @param {string} message - The text, marker last
 * @returns {Promise<{status: number, body: object}|null>} The send's answer, or null when it threw or was not waited for
 */
async function _send(requestId, to, message) {
  let timer = null;
  try {
    const sending = _internal.sendTracked({
      sessionId: LISTENER_KEY,
      senderProjectId: null,
      caller: { kind: 'system' },
      body: { to, message, replyRequired: false, requestId }
    });
    const waited = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), _internal.sendWaitMs);
      if (timer.unref) timer.unref();
    });
    // The send is left to finish by itself when the wait ends first; whatever it does then is its own to record.
    sending.catch(() => {});
    return await Promise.race([sending, waited]);
  // prawduct:allow prawduct/broad-except -- a send that throws is one whose outcome is read from its exchange; it must not end the pass
  } catch (err) {
    log.warn('A check watch send threw', { requestId, error: err && err.message });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Send a message that is owed and record on its watch that the send was made.
 * A send refused before the Hub was called made no exchange and spent nothing:
 * the message is still owed and the next pass tries again.
 * @param {{watch: object, kind: string, to: string, requestId: string}} item - What to send
 * @param {number} now - The pass's clock reading, in ms
 * @param {object} summary - The pass's counts, added to here
 * @returns {Promise<void>}
 */
async function _sendFirst(item, now, summary) {
  const { watch, kind, to, requestId } = item;
  // `now`, not a stored `created_at`: there is no exchange yet (this call is
  // what creates one, inside `_send`/`sendTracked`), and this pass's clock
  // reading is what `created_at` will be set to microseconds from now in the
  // very same pass -- the only moment the two can ever legitimately differ is
  // on a later reconciliation resend, which reads the real stored value back
  // instead (see `_reconcile`).
  const answer = await _send(requestId, to, _text(watch, kind, now));
  const made = _internal.exchangeRows().getByRequestId(requestId);
  if (!made || !_isOwn(made)) {
    log.warn('A check watch message was not sent; it is still owed', {
      watch: watch.watchId, message: kind, to, code: answer && answer.body ? answer.body.code : null
    });
    return;
  }
  summary.sent += 1;
  _recordSent(watch, kind, made);
}

/**
 * When a send's outcome became uncertain, in ms: when the switchboard recorded
 * that the Hub's answer was lost, or, for a send no answer was ever recorded
 * for, when its intent was written.
 * @param {object} exchange - The exchange row
 * @returns {number}
 */
function _uncertainSince(exchange) {
  const lost = _internal.exchangeRows().facts(exchange.exchange_id).filter((f) => f.fact === 'send_unknown').pop();
  return Date.parse(lost ? lost.at : exchange.created_at);
}

/**
 * The status of the listener a send was addressed to, or null when the session
 * it went to has none any more, or has one under another workspace.
 * @param {object} exchange - The exchange row
 * @returns {object|null}
 */
function _recipientListener(exchange) {
  if (exchange.recipient_session_id == null) return null;
  const status = _internal.medusa().getStatus(exchange.recipient_session_id);
  return status.workspaceId && status.workspaceId === exchange.recipient_workspace_id ? status : null;
}

/**
 * The project's one current live, listening session's status — the same
 * "exactly one reachable, listening" rule {@link _recipient} applies for a
 * fresh first send, used here as the fallback target for reconciliation.
 * @param {number} projectId - Project id
 * @returns {object|null}
 */
function _currentRecipientStatus(projectId) {
  const medusa = _internal.medusa();
  const reachable = _internal.activeSessions(projectId)
    .map((session) => medusa.getStatus(session.id))
    .filter((status) => status.workspaceId && status.state === 'listening');
  return reachable.length === 1 ? reachable[0] : null;
}

/**
 * Who a watch's reconciliation should address, and whether that is the
 * exchange's own original recipient or a fallback (#2347): the original
 * recipient while it is still connected under the recorded identity, OR —
 * only once that specific session is genuinely gone, not merely
 * disconnected — the project's current live, listening session instead.
 * "A waiting session cleared/relaunched before delivery" must still reach
 * the project eventually, not wait forever on a session that will never
 * reconnect under the id an uncertain send happened to go out under. A
 * session that still exists but is simply not connected RIGHT NOW is not
 * the fallback case — that one keeps waiting on it specifically, the same
 * as before #2347.
 * @param {object} watch - The watch
 * @param {object} exchange - The exchange row
 * @returns {{status: object, workspaceId: string, isOriginal: boolean}|null}
 */
function _reconciliationTarget(watch, exchange) {
  const original = _recipientListener(exchange);
  if (original) return { status: original, workspaceId: exchange.recipient_workspace_id, isOriginal: true };
  if (exchange.recipient_session_id != null && _internal.medusa().getStatus(exchange.recipient_session_id).workspaceId) {
    return null; // that session still exists; it is just not reconnected as recorded -- wait on it, not the fallback
  }
  const current = _currentRecipientStatus(watch.projectId);
  return current ? { status: current, workspaceId: current.workspaceId, isOriginal: false } : null;
}

/**
 * Whether a send still awaits reconciliation (#2347): its outcome was never
 * learned, its watch still wants the message, and somebody (its original
 * recipient, or a fallback once that is genuinely gone — see
 * {@link _reconciliationTarget}) is connected to tell. An alarm is no
 * longer wanted once its watch has a result: it would say the check has
 * none, and the wake for that result says what it has. Applies equally to a
 * legacy `:2` exchange a pre-#2347 deployment left stuck uncertain — this
 * is a strict improvement over the old model's dead end (no `:3` ever
 * existed), not a new case to guard against.
 * @param {object} exchange - An open exchange of the monitor's
 * @returns {boolean}
 */
function _awaitsReconciliation(exchange) {
  const id = _parseRequestId(exchange.request_id);
  if (!id || exchange.hub_id || exchange.terminal_at) return false;
  const watch = _internal.watches().getWatch(id.watchId);
  if (!watch || watch.cancelled || (id.kind === 'alarm' && watch.result)) return false;
  return Boolean(_reconciliationTarget(watch, exchange));
}

/**
 * Reconcile a send whose outcome was never learned, when the rule allows it:
 * the recipient's listener has been connected without a break for
 * `RECONCILE_AFTER_MS`, counted from the later of when the outcome became
 * uncertain and when that listener last connected, and no marked arrival has
 * bound the send in that time (#2347).
 *
 * First asks the Hub, by the send's own request id as its idempotency key,
 * whether it already has this message (`medusa.getMessageReceipt`) — never
 * guesses from silence alone. Three outcomes:
 * - **Found**: the Hub already has it. Bind that outcome onto the SAME
 *   exchange; nothing is sent again.
 * - **Not found**: the Hub genuinely never got it. Resend under the
 *   IDENTICAL idempotency key and byte-identical text (fixed to the
 *   exchange's own `created_at`, never "now") — a replay if the Hub's
 *   answer to THIS attempt is itself later lost, never a duplicate.
 * - **Unreachable**: stays pending for a later pass. Never falls back to an
 *   unkeyed or differently-keyed resend — a literal one-wake contract means
 *   an unknown outcome stays unknown rather than risking two.
 *
 * A reused key the Hub reports as `IDEMPOTENCY_KEY_CONFLICT` (409) is a
 * final refusal, not retried — this cannot actually happen here, since this
 * module's own text for a given watch+kind never varies, but the Hub's
 * answer is still honored rather than assumed impossible.
 * @param {object} listed - The exchange row, as listed at the start of the pass
 * @param {number} now - The pass's clock reading, in ms
 * @param {object} summary - The pass's counts, added to here
 * @returns {Promise<void>}
 */
async function _reconcile(listed, now, summary) {
  // Read again: a marked arrival may have bound it while this pass was sending.
  const first = _internal.exchangeRows().getByRequestId(listed.request_id);
  if (!first || !_awaitsReconciliation(first)) return;
  const id = _parseRequestId(first.request_id);
  const watch = _internal.watches().getWatch(id.watchId);
  const target = _reconciliationTarget(watch, first);
  if (!target) return;
  const since = target.status.state === 'listening' && target.status.listeningSince ? Date.parse(target.status.listeningSince) : NaN;
  if (!Number.isFinite(since)) return;
  if (!(now - Math.max(_uncertainSince(first), since) >= RECONCILE_AFTER_MS)) return;

  const medusa = _internal.medusa();
  const exchanges = _internal.exchanges();
  const names = { watch: id.watchId, message: id.kind, exchange: first.exchange_id, to: target.workspaceId };

  let receipt;
  try {
    receipt = await medusa.getMessageReceipt({ idempotencyKey: first.request_id });
  } catch (err) {
    log.warn('Could not reconcile a check watch send with the Hub; staying pending', { ...names, error: err.message });
    return;
  }

  if (receipt.found) {
    try {
      exchanges.bindHubId(first.exchange_id, receipt.id, { hubStatus: receipt.status, deliveredTo: receipt.to || target.workspaceId });
    } catch (err) { // prawduct:allow prawduct/broad-except -- the Hub already answered; a binding failure must not be read as "still unknown"
      log.warn('Reconciled a check watch send but could not bind its receipt', { ...names, error: err.message });
    }
    summary.reconciled += 1;
    log.info('Reconciled a check watch send the Hub already had; no second send was made', { ...names, hubId: receipt.id });
    return;
  }

  // Not found on the Hub: genuinely never arrived. Resend under the SAME
  // idempotency key and the SAME text, directly against the Hub -- not
  // through `sendTracked`/`createSendIntent`, which would refuse a request
  // id that already made an exchange (`SEND_ALREADY_ATTEMPTED`); this
  // exchange already exists, so a resend binds onto it, never creates a new one.
  const text = _text(watch, id.kind, Date.parse(first.created_at));
  let result;
  try {
    result = await medusa.sendMessage({ sessionId: LISTENER_KEY, to: target.workspaceId, message: text, idempotencyKey: first.request_id });
  } catch (err) {
    // A conflict or an outright refusal is terminal: the exchange is
    // resolved (unfavorably) by this pass, so it counts as reconciled and is
    // never awaited again. An unreachable Hub resolves nothing -- the
    // exchange stays pending for a later pass, and this pass does not count.
    const terminal = err.hubOutcome === 'conflict' || err.hubOutcome === 'refused';
    try {
      if (err.hubOutcome === 'conflict') exchanges.markSendRefused(first.exchange_id, 'idempotency-key-conflict');
      else if (err.hubOutcome === 'refused') exchanges.markSendRefused(first.exchange_id, 'hub-refused');
      else exchanges.markSendUnknown(first.exchange_id, 'bridge-unreachable');
    } catch (markErr) { // prawduct:allow prawduct/broad-except -- the Hub outcome (or lack of one) is already final for this pass; a pruned exchange is reported as missing, never as a crash
      log.warn('Could not record a check watch reconciliation resend outcome', { ...names, error: markErr.message });
    }
    if (terminal) summary.reconciled += 1;
    log.warn(`A check watch reconciliation resend ${err.hubOutcome || 'failed'}`, { ...names, error: err.message, code: err.code });
    return;
  }
  try {
    if (result.id) exchanges.bindHubId(first.exchange_id, result.id, { hubStatus: result.status, deliveredTo: result.to });
    else exchanges.markSendUnknown(first.exchange_id, 'hub-no-id');
  } catch (err) { // prawduct:allow prawduct/broad-except -- the message is already on the Hub; failing here would invite a duplicate resend next pass
    log.warn('Could not bind a check watch reconciliation resend to its exchange', { ...names, error: err.message });
  }
  summary.reconciled += 1;
  log.warn('Resent a check watch message after reconciling: the Hub had no record of the first attempt', names);
}

/**
 * Close the monitor's exchanges that were delivered and that nobody
 * acknowledged within `CLOSE_AFTER_MS`. Only one with a Hub id is closed: a
 * read or an acknowledgement that comes later is recorded against that id and
 * still shows. A send that never got one stays open, because a late arrival
 * could bind nothing to a closed exchange and its receipt would be hidden.
 * @param {object[]} own - The monitor's open exchanges
 * @param {number} now - The pass's clock reading, in ms
 * @param {object} summary - The pass's counts, added to here
 * @returns {void}
 */
function _closeOld(own, now, summary) {
  for (const exchange of own) {
    if (!exchange.hub_id || !(now - Date.parse(exchange.created_at) >= CLOSE_AFTER_MS)) continue;
    try {
      _internal.exchanges().closeAsSystemOwner(exchange.exchange_id, { kind: 'system', sessionKey: LISTENER_KEY });
      summary.closed += 1;
    } catch (err) {
      // Ended some other way in the meantime is the same result.
      if (err.code !== 'EXCHANGE_TERMINAL') throw err;
    }
  }
}

/**
 * Make the monitor's listener match whether it has anything it may have to
 * send, and say whether it is connected. Whatever has arrived for it is
 * dropped: nothing the monitor sends asks for a reply, and none is read.
 * @param {boolean} wanted - Whether there is anything it may have to send
 * @returns {boolean} Whether the listener is connected now
 */
function _syncListener(wanted) {
  const medusa = _internal.medusa();
  if (!wanted) {
    medusa.stopSession(LISTENER_KEY);
    _unconnected = false;
    return false;
  }
  const status = medusa.startSession({ projectPath: _internal.listenerHome(), sessionId: LISTENER_KEY, name: LISTENER_NAME });
  const arrived = medusa.getMessages(LISTENER_KEY).map((message) => message && message.id).filter((id) => typeof id === 'string');
  if (arrived.length) medusa.markHandled(LISTENER_KEY, arrived);
  return status.state === 'listening';
}

/**
 * The sending half of a pass: settle what is owed and needs no send, keep the
 * listener only while there is something it may have to send, send what can be
 * sent, make the second attempts that are due, and close what is old. Never
 * throws: a pass that cannot send still read and recorded.
 * @param {object[]} open - The watches that were open when the pass began
 * @param {number} now - The pass's clock reading, in ms
 * @param {object} summary - The pass's counts, added to here
 * @returns {Promise<void>}
 */
async function _deliver(open, now, summary) {
  try {
    const ctx = { now, recipients: new Map() };
    const sendable = _settleOwed(ctx, summary);
    const own = _internal.exchanges().openSystemOwned(LISTENER_KEY);
    const pendingReconciliation = own.filter(_awaitsReconciliation);
    const wanted = sendable.length > 0 || pendingReconciliation.length > 0 || open.some((watch) => _recipient(ctx, watch.projectId).ok);
    const connected = _syncListener(wanted);
    const waiting = wanted && !connected && (sendable.length > 0 || pendingReconciliation.length > 0);
    if (waiting !== _unconnected) {
      _unconnected = waiting;
      if (waiting) log.warn('Check watch messages are waiting: the monitor\'s own switchboard listener is not connected', { owed: sendable.length, pendingReconciliation: pendingReconciliation.length });
      else if (connected) log.info('The check watch monitor\'s switchboard listener is connected again');
    }
    if (connected) {
      for (const item of sendable.slice(0, MAX_SENDS_PER_PASS)) await _sendFirst(item, now, summary);
      for (const exchange of pendingReconciliation) await _reconcile(exchange, now, summary);
    }
    _closeOld(own, now, summary);
  // prawduct:allow prawduct/broad-except -- whatever the switchboard or the store throws, the pass has already read and recorded; the next pass sends
  } catch (err) {
    summary.errors += 1;
    log.warn('Check watch pass could not finish sending', { error: err && err.message });
  }
}

/**
 * Hear of a message that reached a listener on this host, and bind it to the
 * exchange it belongs to when it is one of the monitor's own.
 *
 * A message binds only by its own marker: its last line names a request id,
 * the exchange made under that id is the monitor's, it came from the workspace
 * that exchange was sent from, and it reached the workspace that exchange was
 * addressed to. Anything else binds nothing. It is called for every arrival,
 * before the Hub has answered the send in the ordinary case, and never throws.
 * @param {object} arrival
 * @param {string} arrival.sessionKey - The receiving listener's key
 * @param {string} arrival.workspaceId - The receiving workspace
 * @param {object} arrival.message - The received message
 * @returns {{bound: boolean, reason: string}} What was done, and why nothing was when nothing was
 */
function noteArrival({ sessionKey, workspaceId, message } = {}) {
  try {
    // The monitor's own mail: nothing it sends asks for a reply, and none is read.
    if (sessionKey === LISTENER_KEY) return { bound: false, reason: 'own-inbox' };
    if (!message || typeof message.id !== 'string') return { bound: false, reason: 'no-message' };
    const marker = _markerOf(message);
    if (!marker) return { bound: false, reason: 'no-marker' };
    const names = { hubId: message.id, requestId: marker.requestId, to: workspaceId };
    const exchange = _internal.exchangeRows().getByRequestId(marker.requestId);
    const refuse = (reason) => {
      log.warn('A message carrying a check watch marker was not bound to an exchange', { ...names, reason });
      return { bound: false, reason };
    };
    if (!exchange || !_isOwn(exchange)) return refuse('no-such-send');
    if (typeof message.from !== 'string' || message.from !== exchange.sender_workspace_id) return refuse('other-sender');
    if (workspaceId !== exchange.recipient_workspace_id) return refuse('other-recipient');
    if (exchange.hub_id) return exchange.hub_id === message.id ? { bound: false, reason: 'already-bound' } : refuse('bound-to-another-message');
    if (exchange.terminal_at) return refuse('send-ended');
    _internal.exchanges().bindHubId(exchange.exchange_id, message.id);
    log.info('Bound a check watch message to its exchange by its marker', { ...names, exchange: exchange.exchange_id });
    return { bound: true, reason: 'marker' };
  // prawduct:allow prawduct/broad-except -- recording a receipt is bookkeeping about mail already delivered; it must never cost the recipient its message
  } catch (err) {
    log.warn('A check watch arrival could not be considered', { error: err && err.message });
    return { bound: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// GitHub CI state-change notifications (#1783)
//
// A SEPARATE notification path from the watch wake/alarm messages above: a
// watch tells the PROJECT that registered it; this tells the coordinator and
// the architect, for a PR's CI reaching a terminal state, regardless of
// whether any project happens to hold a watch on it. No webhook route is
// wired up by this module (that is a future car's job, outside this one's
// file scope) — `ingestGitHubCiWebhookEvent` is the entry point a route
// would call once it has normalized a raw GitHub payload into the shape
// below.
//
// Deliberately sent through `medusa.sendSystemMessage` directly, the same
// primitive `lib/shared-docs.js`'s own best-effort notices use, rather than
// through the tracked-exchange/request-id machinery `_send`/`noteArrival`
// use for wake/alarm above: that machinery's request-id parsing
// (`REQUEST_ID_SHAPE`, `_parseRequestId`) is hard-wired to the two watch
// message kinds, and widening it to recognize a structurally different id
// risks the one thing that must not regress — the already-working,
// already-tested wake/alarm delivery. Idempotency here is a module-level
// Set instead of the exchange system's request-id uniqueness, for the same
// reason `_foreign` above is an unbounded-but-small Set: there is no new
// store schema for this either way (`check-watch-state.js`'s fact kinds are
// CHECK-constrained and out of this module's file scope to extend), and the
// volume of terminal CI events a real install sees is small enough that
// process-lifetime (not restart-durable) idempotency is an acceptable,
// explicitly-scoped limit for this first version.
// ---------------------------------------------------------------------------

/** The two roles a terminal CI state change is reported to. */
const CI_NOTIFY_ROLES = Object.freeze(['coordinator', 'architect']);

/**
 * Which `config.checkWatch` key names each role's recipient project —
 * mirrors `workloadNudge.coordinatorProject`'s already-established
 * convention (`lib/workload-nudge.js#_coordinator`) rather than inventing a
 * new one.
 */
const CI_NOTIFY_CONFIG_KEYS = Object.freeze({ coordinator: 'coordinatorProject', architect: 'architectProject' });

/** GitHub Actions conclusions this module treats as a definite PASS. */
const CI_GREEN_CONCLUSIONS = Object.freeze(['success']);

/** GitHub Actions conclusions this module treats as a definite, worth-paging FAIL. */
const CI_RED_CONCLUSIONS = Object.freeze(['failure', 'cancelled', 'timed_out']);

/** Every conclusion this module treats as terminal — green or red; anything else (including a non-terminal `status`) is not notified. */
const CI_TERMINAL_CONCLUSIONS = Object.freeze([...CI_GREEN_CONCLUSIONS, ...CI_RED_CONCLUSIONS]);

/** `owner/repo`, the only shape this module accepts. */
const CI_REPO_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)\/[A-Za-z0-9](?:[A-Za-z0-9._-]*)$/;

/** A commit SHA, abbreviated or full. */
const CI_SHA_SHAPE = /^[0-9a-f]{7,40}$/i;

/**
 * Already-notified-OR-in-flight `(role, repo, PR, headSha, conclusion)` keys
 * — see the section comment above for why this is a plain, unbounded `Set`
 * rather than a store-backed record. A key is added BEFORE its send is
 * awaited, not after (Round 3, #1783): reserving it first is what makes two
 * overlapping calls for the same key — a replayed webhook delivery arriving
 * while the first delivery's send is still in flight — dedupe correctly;
 * adding it only on success would let both calls see no reservation yet and
 * both send. A failed send deletes its own key, so it stays retriable on a
 * later, genuinely new call.
 * @type {Set<string>}
 */
const _ciNotified = new Set();

/**
 * The idempotency key one role's notice for one terminal event is tracked
 * under.
 * @param {string} role
 * @param {object} event - A normalized event, from {@link _normalizeCiEvent}
 * @returns {string}
 */
function _ciNotifyKey(role, event) {
  return `${role}:${event.repo}:${event.prNumber}:${event.headSha}:${event.conclusion}`;
}

/**
 * Validate and normalize a CI-state-change payload. Never throws.
 * @param {object} payload
 * @returns {{ok: true, event: {repo: string, prNumber: number, headSha: string, conclusion: string, runId: (string|null), workflowName: (string|null), htmlUrl: (string|null)}}|{ok: false, code: string, reason: string}}
 */
function _normalizeCiEvent(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (typeof p.repo !== 'string' || !CI_REPO_SHAPE.test(p.repo)) {
    return { ok: false, code: 'MALFORMED', reason: 'repo must be "owner/repo"' };
  }
  if (!(Number.isInteger(p.prNumber) && p.prNumber > 0)) {
    return { ok: false, code: 'MALFORMED', reason: 'prNumber must be a positive integer' };
  }
  if (typeof p.headSha !== 'string' || !CI_SHA_SHAPE.test(p.headSha)) {
    return { ok: false, code: 'MALFORMED', reason: 'headSha must be a hex commit SHA' };
  }
  if (typeof p.conclusion !== 'string' || !p.conclusion) {
    return { ok: false, code: 'MALFORMED', reason: 'conclusion is required' };
  }
  return {
    ok: true,
    event: {
      repo: p.repo,
      prNumber: p.prNumber,
      headSha: p.headSha,
      conclusion: p.conclusion,
      runId: typeof p.runId === 'string' ? p.runId : null,
      workflowName: typeof p.workflowName === 'string' ? p.workflowName : null,
      htmlUrl: typeof p.htmlUrl === 'string' ? p.htmlUrl : null
    }
  };
}

/**
 * Resolve one role's live recipient workspace the same way
 * `lib/workload-nudge.js#_coordinator` resolves its one coordinator: a
 * config-named project, looked up by name, with exactly one live, reachable
 * session (reusing {@link _recipient}'s own resolution and its per-pass
 * cache).
 * @param {'coordinator'|'architect'} role
 * @param {{recipients: Map<number, object>}} ctx - Shared across both roles' lookups in one call
 * @returns {{ok: true, workspaceId: string, project: object}|{ok: false, code: string}}
 */
function _ciNotifyRecipient(role, ctx) {
  const config = _internal.config().load();
  const settings = (config && config.checkWatch) || {};
  const named = settings[CI_NOTIFY_CONFIG_KEYS[role]];
  if (!named) return { ok: false, code: 'not-configured' };
  const project = _internal.getProjectByName(named);
  if (!project) return { ok: false, code: 'unknown-project' };
  const recipient = _recipient(ctx, project.id);
  if (!recipient.ok) return { ok: false, code: recipient.code };
  return { ok: true, workspaceId: recipient.workspaceId, project };
}

/**
 * The text of a CI state-change notice.
 * @param {object} event - A normalized event
 * @returns {string}
 */
function _ciStateChangeText(event) {
  const verdict = CI_GREEN_CONCLUSIONS.includes(event.conclusion) ? 'passed' : 'FAILED';
  const lines = [
    `CI ${verdict}: PR #${event.prNumber} of ${event.repo}, commit ${event.headSha}` +
      `${event.workflowName ? ` (${event.workflowName})` : ''}.`,
    `Conclusion: ${event.conclusion}${event.runId ? ` (run ${event.runId})` : ''}.`
  ];
  if (event.htmlUrl) lines.push(event.htmlUrl);
  lines.push('This is from TangleClaw\'s check watch monitor; a reply is not read.');
  return lines.join('\n');
}

/**
 * Tell the coordinator and the architect a PR's CI reached a terminal state
 * (#1783): one notice per role, each tracked against {@link _ciNotified} so
 * a replayed or duplicate webhook delivery for a terminal state already
 * reported sends nothing a second time. Never throws. A role with no
 * configured recipient, or whose recipient has no live, reachable session,
 * is recorded as skipped rather than retried forever — a later call for the
 * SAME event still tries again (only a role that actually sent is marked
 * notified), and a genuinely new terminal event is unaffected either way.
 * @param {object} event - A normalized event, from {@link _normalizeCiEvent}
 *   (or built directly in the same shape by a caller that already has one)
 * @param {{roles?: Array<'coordinator'|'architect'>}} [opts] - `roles`
 *   narrows which roles are told; default both
 * @returns {Promise<{sent: string[], skipped: Array<{role: string, code: string}>, alreadyNotified: string[]}>}
 */
async function notifyCoordinatorAndArchitectOnCiStateChange(event, opts = {}) {
  const roles = Array.isArray(opts.roles) && opts.roles.length
    ? opts.roles.filter((r) => CI_NOTIFY_ROLES.includes(r))
    : CI_NOTIFY_ROLES;
  const ctx = { recipients: new Map() };
  const result = { sent: [], skipped: [], alreadyNotified: [] };
  const names = { repo: event.repo, prNumber: event.prNumber, headSha: event.headSha, conclusion: event.conclusion };
  for (const role of roles) {
    const key = _ciNotifyKey(role, event);
    if (_ciNotified.has(key)) {
      result.alreadyNotified.push(role);
      continue;
    }
    const recipient = _ciNotifyRecipient(role, ctx);
    if (!recipient.ok) {
      result.skipped.push({ role, code: recipient.code });
      log.info('A CI state-change notice has nobody configured or reachable to tell yet', { ...names, role, code: recipient.code });
      continue;
    }
    // Reserve the key BEFORE awaiting the send (Round 3, #1783): without
    // this, two overlapping calls for the same (role, repo, PR, headSha,
    // conclusion) — a replayed webhook delivery arriving while the first
    // delivery's send is still in flight — would both see `_ciNotified.has(key)`
    // as false and both call `sendSystemMessage`, sending a duplicate
    // notice. Reserving here makes the second, overlapping call see it as
    // already claimed; a failed send deletes the reservation below so it
    // stays retriable on a later, genuinely new call.
    _ciNotified.add(key);
    try {
      await _internal.medusa().sendSystemMessage({ to: recipient.workspaceId, message: _ciStateChangeText(event) });
    // prawduct:allow prawduct/broad-except -- a failed send for one role must not stop the other role's notice, and is retried on the next genuinely new event
    } catch (err) {
      _ciNotified.delete(key);
      result.skipped.push({ role, code: 'send-failed' });
      log.warn('A CI state-change notice could not be sent', { ...names, role, to: recipient.workspaceId, error: err && err.message });
      continue;
    }
    result.sent.push(role);
    log.info('Sent a CI state-change notice', { ...names, role, to: recipient.workspaceId });
  }
  return result;
}

/**
 * Entry point for a GitHub Actions CI-state-change event (#1783). No
 * webhook route is wired up by this module — a future route normalizes the
 * raw GitHub payload into this shape and calls this. Validates the event,
 * and when its conclusion is {@link CI_TERMINAL_CONCLUSIONS}, tells the
 * coordinator and the architect (see
 * {@link notifyCoordinatorAndArchitectOnCiStateChange}); a non-terminal
 * conclusion (or `status`) is read and dropped — it is not yet news. Never
 * throws.
 * @param {{repo: string, prNumber: number, headSha: string, conclusion: string, runId?: string, workflowName?: string, htmlUrl?: string}} payload
 * @param {{roles?: Array<'coordinator'|'architect'>}} [opts]
 * @returns {Promise<{ok: boolean, code?: string, reason?: string, notified?: boolean, result?: object}>}
 */
async function ingestGitHubCiWebhookEvent(payload, opts = {}) {
  const normalized = _normalizeCiEvent(payload);
  if (!normalized.ok) {
    log.warn('A GitHub CI webhook event could not be read', { code: normalized.code, reason: normalized.reason });
    return normalized;
  }
  const { event } = normalized;
  if (!CI_TERMINAL_CONCLUSIONS.includes(event.conclusion)) {
    return { ok: true, notified: false, reason: 'not-terminal' };
  }
  const result = await notifyCoordinatorAndArchitectOnCiStateChange(event, opts);
  return { ok: true, notified: result.sent.length > 0, result };
}

/**
 * One pass over the open watches, then over the messages owed.
 * @param {number} [given] - The clock reading to judge against; the clock is read here when none is given
 * @returns {Promise<object>} What the pass did
 */
async function _run(given) {
  const summary = _summary();
  const now = given === undefined ? _internal.now() : given;
  let open;
  try {
    open = _internal.listUnresolved();
  // prawduct:allow prawduct/broad-except -- a store that cannot be read ends this pass, not the server; the next pass asks again
  } catch (err) {
    summary.errors += 1;
    log.warn('Check watch pass could not list the open watches', { error: err && err.message });
    return summary;
  }
  summary.open = open.length;
  // The store lists the watch read longest ago first, so the ceiling takes
  // those and the rest are at the front of the next pass.
  const due = open.filter((watch) => _dueForRead(watch, now));
  const batch = due.slice(0, MAX_READS_PER_PASS);
  summary.deferred = due.length - batch.length;
  if ((summary.deferred > 0) !== _deferring) {
    _deferring = summary.deferred > 0;
    if (_deferring) {
      log.warn('More check watches are due a read than one pass reads; the rest wait for a later pass, so each is read less often', {
        due: due.length, ceiling: MAX_READS_PER_PASS, deferred: summary.deferred
      });
    } else {
      log.info('Every check watch due a read was read in one pass again', { due: due.length });
    }
  }
  await _pool(batch, MAX_IN_FLIGHT, (watch) => _readOne(watch, now, summary));
  await _deliver(open, now, summary);
  return summary;
}

/**
 * One pass over the open watches: read each that is due, record what was
 * read, and expire what stayed unresolved too long. Never throws and never
 * rejects. A pass asked for while one is running does nothing and says so.
 * @param {number} [now] - The clock reading to judge against
 * @returns {Promise<{open: number, read: number, resolved: number, readFailed: number, expired: number, deferred: number, sent: number, reconciled: number, undeliverable: number, closed: number, errors: number, skipped?: string}>}
 *   What the pass did, for the tests and for a caller driving the monitor by hand
 */
function tick(now) {
  if (_pass) {
    if (!_skipping) {
      _skipping = true;
      log.warn('A check watch pass was still running when the next was due; that pass is skipped, so watches are read less often until passes finish in time');
    }
    return Promise.resolve({ ..._summary(), skipped: 'pass-running' });
  }
  if (_skipping) {
    _skipping = false;
    log.info('Check watch passes finish in time again');
  }
  const pass = _run(now)
    // prawduct:allow prawduct/broad-except -- a monitor pass must never take the server down or leave an unhandled rejection
    .catch((err) => {
      log.warn('check-watch: pass error', { error: err && err.message });
      return { ..._summary(), errors: 1 };
    })
    .finally(() => {
      if (_pass === pass) _pass = null;
    });
  _pass = pass;
  return pass;
}

/**
 * Start the monitor. Idempotent: a second call while running is a no-op.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=60000] - Pass cadence
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  _timer = setInterval(() => { tick(); }, intervalMs);
  if (_timer.unref) _timer.unref(); // never hold the event loop open
  log.info('check-watch monitor started', { intervalMs, readsPerPass: MAX_READS_PER_PASS });
}

/**
 * Wait for the pass now running, if one is, to finish. For a caller driving
 * the monitor by hand; the timer never waits.
 * @returns {Promise<void>}
 */
async function settled() {
  while (_pass) await _pass;
}

/**
 * Stop the monitor and its listener. A pass already reading finishes and
 * records what it read.
 * @returns {void}
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _deferring = false;
  _skipping = false;
  _unconnected = false;
  _foreign.clear();
  try {
    _internal.medusa().stopSession(LISTENER_KEY);
  // prawduct:allow prawduct/broad-except -- stopping must not throw during shutdown; a listener left running ends with the process
  } catch (err) {
    log.warn('The check watch listener could not be stopped', { error: err && err.message });
  }
}

/**
 * Injectable seams, lazily required the way the other monitors do it: this
 * module is required by `server.js` at load, before the store is initialized.
 */
const _internal = {
  now: () => Date.now(),
  readCheck: (repo, sha, name) => require('./github-checks').readCheck(repo, sha, name),
  listUnresolved: () => require('./check-watch-store').listUnresolved(),
  recordRead: (watchId, reading) => require('./check-watch-store').recordRead(watchId, reading),
  recordExpired: (watchId) => require('./check-watch-store').recordExpired(watchId),
  watches: () => require('./check-watch-store'),
  medusa: () => require('./medusa'),
  sendTracked: (input) => require('./medusa-send').sendTracked(input),
  exchanges: () => require('./medusa-exchanges'),
  exchangeRows: () => require('./store').medusaExchanges,
  activeSessions: (projectId) => require('./store').sessions.list(projectId, { status: 'active', limit: 50 }),
  listenerHome: () => path.join(require('./store')._getBasePath(), 'check-watch'),
  sendWaitMs: SEND_WAIT_MS,
  config: () => require('./store').config,
  getProjectByName: (name) => require('./store').projects.getByName(name),
  // Test-only: `_ciNotified` is process-lifetime by design (see the CI
  // state-change notifications section above), so a test file that reuses
  // the same (repo, PR, headSha, conclusion) across cases — as this
  // module's own tests already do for commit numbers — needs to clear it
  // between cases rather than have state leak from one test into the next.
  resetCiNotified: () => _ciNotified.clear()
};

// The monitor finds its own sends again by request id, so nobody else may make
// an exchange under an id it would make.
require('./medusa-exchanges').declareSystemOwner(LISTENER_KEY, { requestIdPrefix: state.REQUEST_ID_PREFIX });

module.exports = {
  start,
  stop,
  tick,
  settled,
  noteArrival,
  exchangesOf,
  ingestGitHubCiWebhookEvent,
  notifyCoordinatorAndArchitectOnCiStateChange,
  LISTENER_KEY,
  RECONCILE_AFTER_MS,
  CLOSE_AFTER_MS,
  DEFAULT_INTERVAL_MS,
  MIN_READ_GAP_MS,
  MAX_READS_PER_PASS,
  MAX_IN_FLIGHT,
  _internal
};
