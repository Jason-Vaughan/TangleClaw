'use strict';

/**
 * Multi-channel watch inventory, bounded untrusted watch ingestion, and the
 * scoped publication-grant contract (#2394, v5.59.0 Wave 1 Car 59-D,
 * Architect Ruling A2394).
 *
 * Self-contained, same shape as `lib/governed-wrap.js`/`lib/chunk-boundary.js`:
 * this module owns its own storage via `ensureBridgeChannelsSchema`, applied
 * additively (`CREATE TABLE IF NOT EXISTS`) on `store.getDb()` -- it never
 * touches `lib/store/_schema.js` or `lib/bridge-schema.js`.
 *
 * The problem (Ruling A2394's own words): today the bridge has one private
 * channel. This module lets the operator register MULTIPLE Discord channels
 * and forum threads to watch, read what arrives there as bounded, explicitly
 * untrusted data, and post to a channel only against an explicit, narrowly
 * scoped grant -- never an implicit "the bridge may post wherever it is
 * watching."
 *
 * ## Three pieces
 *
 * 1. **Channel/forum inventory** ({@link registerChannel}, {@link listChannels},
 *    {@link updateChannel}, {@link getChannel}): `mode` (`'watch-only'` or
 *    `'two-way'`) and `sendAllowed` are deliberately separate fields -- a
 *    channel can be watched two-way (read and reply) without ever being
 *    postable, and `sendAllowed` is what {@link createPublicationGrant}
 *    actually checks. A forum channel's scope is either an explicit allowlist
 *    of thread ids, or every thread, and the broad form requires the operator
 *    to say so explicitly (`operatorApprovedAllThreads: true`) -- `allThreads`
 *    alone is refused, so a channel can never silently widen from "a few
 *    named threads" to "everything" by a caller merely omitting the allowlist.
 * 2. **Bounded untrusted watch ingestion** ({@link recordWatchedMessage},
 *    {@link listWatchedMessages}, {@link pruneExpiredWatchedMessages}): every
 *    row this module stores from a watched channel -- including one the
 *    Operator themself typed into that channel -- carries the fixed
 *    `authority: 'watched-untrusted'` and a retention bound. This module
 *    provides NO function that promotes a watched message into a bridge
 *    route, an answer, a candidate or an approval -- the prevention is
 *    structural (no such path exists here), never a flag a caller could
 *    bypass by choosing not to check it.
 * 3. **Scoped publication grant** ({@link createPublicationGrant},
 *    {@link validateAndConsumePublicationGrant}): posting to a channel is
 *    held unless backed by a grant bound to the EXACT
 *    `(destinationChannelId, textSha256, operatorRouteId, idempotencyKey)` a
 *    poster presents, on a channel with `sendAllowed === true`. A grant is
 *    idempotent on its own `idempotencyKey`: creating one twice with the
 *    same bound fields replays the first; consuming one with an `'unknown'`
 *    outcome (the poster could not confirm whether Discord accepted it)
 *    leaves it readable and re-consumable with a later, confirmed outcome,
 *    rather than discarding the uncertainty.
 *
 * @module lib/bridge-channels
 */

const crypto = require('node:crypto');
const store = require('./store');

/** The two ways a watched channel may be used. `sendAllowed` is a separate field -- never implied by `mode`. */
const MODES = Object.freeze(['watch-only', 'two-way']);

/** The one authority a watched message may ever carry. Never a parameter; never a caller's choice. */
const WATCHED_UNTRUSTED = 'watched-untrusted';

/** How long a watched message is kept before it is eligible for pruning, by default. */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A publication grant's own lifecycle. */
const GRANT_STATES = Object.freeze(['pending', 'consumed']);

/** How long a publication grant stays usable before it expires, by default. */
const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;

/** An outcome {@link validateAndConsumePublicationGrant} may record. */
const GRANT_OUTCOMES = Object.freeze(['posted', 'failed', 'unknown']);

/** Seams for tests: the clock and the id source. */
const _internal = {
  now: () => new Date().toISOString(),
  grantId: () => `bpg_${crypto.randomBytes(12).toString('hex')}`
};

/**
 * A refusal, in the shape the other bridge/decision modules already use.
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

/**
 * The DDL for this module's three tables. Purely additive (`IF NOT EXISTS`).
 * @returns {string}
 */
function _tablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS bridge_watched_channels (
      channel_id                     TEXT    PRIMARY KEY CHECK (length(channel_id) BETWEEN 1 AND 64),
      guild_id                       TEXT    NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 64),
      name                           TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      mode                           TEXT    NOT NULL CHECK (mode IN ('watch-only','two-way')),
      send_allowed                   INTEGER NOT NULL DEFAULT 0 CHECK (send_allowed IN (0, 1)),
      parent_channel_id              TEXT    CHECK (parent_channel_id IS NULL OR length(parent_channel_id) <= 64),
      thread_ids_json                TEXT    CHECK (thread_ids_json IS NULL OR length(thread_ids_json) <= 8000),
      all_threads                    INTEGER NOT NULL DEFAULT 0 CHECK (all_threads IN (0, 1)),
      operator_approved_all_threads  INTEGER NOT NULL DEFAULT 0 CHECK (operator_approved_all_threads IN (0, 1)),
      created_at                     TEXT    NOT NULL,
      updated_at                     TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_watched_messages (
      message_id    TEXT    PRIMARY KEY CHECK (length(message_id) BETWEEN 1 AND 64),
      channel_id    TEXT    NOT NULL,
      thread_id     TEXT    CHECK (thread_id IS NULL OR length(thread_id) <= 64),
      author_label  TEXT    NOT NULL CHECK (length(author_label) BETWEEN 1 AND 200),
      authority     TEXT    NOT NULL CHECK (authority = 'watched-untrusted'),
      source_label  TEXT    NOT NULL CHECK (length(source_label) BETWEEN 1 AND 200),
      text          TEXT    CHECK (text IS NULL OR length(text) <= 8000),
      received_at   TEXT    NOT NULL,
      expires_at    TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bridge_watched_messages_channel
      ON bridge_watched_messages(channel_id, received_at);
    CREATE INDEX IF NOT EXISTS idx_bridge_watched_messages_expiry
      ON bridge_watched_messages(expires_at);

    CREATE TABLE IF NOT EXISTS bridge_publication_grants (
      grant_id               TEXT    PRIMARY KEY CHECK (length(grant_id) BETWEEN 1 AND 64),
      destination_channel_id TEXT    NOT NULL CHECK (length(destination_channel_id) BETWEEN 1 AND 64),
      text_sha256            TEXT    NOT NULL CHECK (length(text_sha256) = 64),
      operator_route_id      TEXT    NOT NULL CHECK (length(operator_route_id) BETWEEN 1 AND 128),
      idempotency_key        TEXT    NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
      state                  TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','consumed')),
      outcome                TEXT    CHECK (outcome IS NULL OR outcome IN ('posted','failed','unknown')),
      consumed_at            TEXT,
      expires_at             TEXT    NOT NULL,
      created_at             TEXT    NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_publication_grants_idem
      ON bridge_publication_grants(idempotency_key);
  `;
}

/** Whether `ensureBridgeChannelsSchema` has already run against this exact db handle. */
const _initialized = new WeakSet();

/**
 * Apply this module's schema, additively and idempotently. Safe to call on
 * every public entry point.
 * @param {object} db - An open database handle (`store.getDb()`)
 * @returns {void}
 */
function ensureBridgeChannelsSchema(db) {
  if (_initialized.has(db)) return;
  db.exec(_tablesDdl());
  _initialized.add(db);
}

/**
 * The open database, with this module's schema guaranteed present.
 * @returns {object}
 * @throws {Error} When the store is not initialized
 */
function _db() {
  const db = store.getDb();
  ensureBridgeChannelsSchema(db);
  return db;
}

/**
 * One channel row, as the public shape callers read.
 * @param {object} row
 * @returns {object}
 */
function _channelView(row) {
  return {
    channelId: row.channel_id,
    guildId: row.guild_id,
    name: row.name,
    mode: row.mode,
    sendAllowed: row.send_allowed === 1,
    parentChannelId: row.parent_channel_id,
    threadIds: row.thread_ids_json ? JSON.parse(row.thread_ids_json) : null,
    allThreads: row.all_threads === 1,
    operatorApprovedAllThreads: row.operator_approved_all_threads === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * One watched-message row, as the public shape callers read.
 * @param {object} row
 * @returns {object}
 */
function _messageView(row) {
  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    authorLabel: row.author_label,
    authority: row.authority,
    sourceLabel: row.source_label,
    text: row.text,
    receivedAt: row.received_at,
    expiresAt: row.expires_at
  };
}

/**
 * One publication-grant row, as the public shape callers read.
 * @param {object} row
 * @returns {object}
 */
function _grantView(row) {
  return {
    grantId: row.grant_id,
    destinationChannelId: row.destination_channel_id,
    textSha256: row.text_sha256,
    operatorRouteId: row.operator_route_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    outcome: row.outcome,
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

/**
 * Validate a channel registration's forum-scope fields together: `allThreads`
 * is refused without the operator's explicit `operatorApprovedAllThreads:
 * true` alongside it, and `threadIds` (when given) must be a non-empty array
 * of strings. The two scopes are mutually exclusive -- a channel names an
 * explicit allowlist OR every thread, never a combination that could be read
 * either way.
 * @param {object} input
 * @returns {{ok: false, code: string, message: string}|null}
 */
function _validateForumScope(input) {
  const { threadIds, allThreads, operatorApprovedAllThreads } = input;
  if (allThreads === true && operatorApprovedAllThreads !== true) {
    return _refuse('BRIDGE_CHANNEL_ALL_THREADS_NOT_APPROVED',
      'allThreads requires the operator\'s explicit operatorApprovedAllThreads: true; it is never implied.');
  }
  // `null` means the same as "not given" here (what `_channelView` reads
  // back for "no allowlist"), so `updateChannel`'s merge of an existing
  // channel's view can round-trip through this validation without the
  // absence of an allowlist itself reading as an invalid one.
  if (threadIds !== undefined && threadIds !== null) {
    if (!Array.isArray(threadIds) || threadIds.length === 0 || !threadIds.every((t) => typeof t === 'string' && t)) {
      return _refuse('BRIDGE_CHANNEL_INVALID', 'threadIds, when given, must be a non-empty array of strings.');
    }
    if (allThreads === true) {
      return _refuse('BRIDGE_CHANNEL_INVALID', 'threadIds and allThreads are mutually exclusive -- a channel names one scope or the other.');
    }
  }
  return null;
}

/**
 * Register a new watched channel, or re-register an existing one (an upsert
 * by `channelId`) -- the existing single private channel becomes the first
 * row here on upgrade, with whatever `mode`/`sendAllowed` it already had.
 * @param {object} input
 * @param {string} input.channelId
 * @param {string} input.guildId
 * @param {string} input.name
 * @param {'watch-only'|'two-way'} input.mode
 * @param {boolean} [input.sendAllowed] - Default `false`
 * @param {string} [input.parentChannelId] - Set when this is a forum thread
 * @param {string[]} [input.threadIds] - An explicit allowlist, when the scope is not every thread
 * @param {boolean} [input.allThreads] - Requires `operatorApprovedAllThreads: true`
 * @param {boolean} [input.operatorApprovedAllThreads]
 * @returns {{ok: true, channel: object}|{ok: false, code: string, message: string}}
 */
function registerChannel(input) {
  const { channelId, guildId, name, mode } = input || {};
  if (typeof channelId !== 'string' || !channelId) return _refuse('BRIDGE_CHANNEL_INVALID', 'channelId is required.');
  if (typeof guildId !== 'string' || !guildId) return _refuse('BRIDGE_CHANNEL_INVALID', 'guildId is required.');
  if (typeof name !== 'string' || !name) return _refuse('BRIDGE_CHANNEL_INVALID', 'name is required.');
  if (!MODES.includes(mode)) return _refuse('BRIDGE_CHANNEL_INVALID', `mode must be one of ${MODES.join(', ')}.`);
  const scopeBad = _validateForumScope(input);
  if (scopeBad) return scopeBad;

  const now = _internal.now();
  const sendAllowed = input.sendAllowed === true;
  const threadIdsJson = input.threadIds ? JSON.stringify(input.threadIds) : null;
  const allThreads = input.allThreads === true;
  const operatorApprovedAllThreads = input.operatorApprovedAllThreads === true;
  const parentChannelId = typeof input.parentChannelId === 'string' && input.parentChannelId ? input.parentChannelId : null;

  _db().prepare(
    `INSERT INTO bridge_watched_channels
       (channel_id, guild_id, name, mode, send_allowed, parent_channel_id, thread_ids_json, all_threads,
        operator_approved_all_threads, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       guild_id = excluded.guild_id, name = excluded.name, mode = excluded.mode, send_allowed = excluded.send_allowed,
       parent_channel_id = excluded.parent_channel_id, thread_ids_json = excluded.thread_ids_json,
       all_threads = excluded.all_threads, operator_approved_all_threads = excluded.operator_approved_all_threads,
       updated_at = excluded.updated_at`
  ).run(channelId, guildId, name, mode, sendAllowed ? 1 : 0, parentChannelId, threadIdsJson, allThreads ? 1 : 0,
    operatorApprovedAllThreads ? 1 : 0, now, now);

  return { ok: true, channel: getChannel(channelId) };
}

/**
 * Update one or more fields of an existing channel. The same forum-scope
 * validation `registerChannel` applies, checked against the MERGED result
 * (existing fields the caller did not name, plus the ones it did), so a
 * partial update can never produce a row `registerChannel` itself would
 * have refused.
 * @param {string} channelId
 * @param {object} patch - Any subset of `registerChannel`'s own fields (except `channelId`)
 * @returns {{ok: true, channel: object}|{ok: false, code: string, message: string}}
 */
function updateChannel(channelId, patch) {
  const existing = getChannel(channelId);
  if (!existing) return _refuse('NOT_FOUND', `No watched channel "${channelId}".`);
  const merged = { ...existing, ...(patch || {}), channelId };
  return registerChannel(merged);
}

/**
 * One watched channel by id.
 * @param {string} channelId
 * @returns {object|null}
 */
function getChannel(channelId) {
  const row = _db().prepare('SELECT * FROM bridge_watched_channels WHERE channel_id = ?').get(channelId);
  return row ? _channelView(row) : null;
}

/**
 * Every watched channel, by name.
 * @returns {object[]}
 */
function listChannels() {
  return _db().prepare('SELECT * FROM bridge_watched_channels ORDER BY name, channel_id').all().map(_channelView);
}

/**
 * Whether a thread is within a channel's forum scope: named in its explicit
 * allowlist, or the channel is scoped to every (operator-approved) thread.
 * A channel with neither set watches no thread at all -- only its own
 * top-level messages, if it has any.
 * @param {object} channel - As {@link getChannel} answers
 * @param {string|null} threadId
 * @returns {boolean}
 */
function _threadInScope(channel, threadId) {
  if (!threadId) return true;
  if (channel.allThreads && channel.operatorApprovedAllThreads) return true;
  return Array.isArray(channel.threadIds) && channel.threadIds.includes(threadId);
}

/**
 * Record one message from a watched channel or thread as bounded, explicitly
 * untrusted data (#2394). `authority` is never a parameter: every row this
 * function writes carries the fixed {@link WATCHED_UNTRUSTED}, including a
 * message the Operator themself typed into the watched channel -- being the
 * Operator does not make a channel message trusted. This function has no
 * return path into a bridge route, answer, candidate or approval; nothing in
 * this module promotes a watched message into one.
 * @param {object} input
 * @param {string} input.messageId
 * @param {string} input.channelId - Must already be registered
 * @param {string} [input.threadId] - Must be within the channel's forum scope, when given
 * @param {string} input.authorLabel
 * @param {string} input.sourceLabel
 * @param {string} [input.text]
 * @param {number} [input.retentionMs] - Default {@link DEFAULT_RETENTION_MS}
 * @returns {{ok: true, message: object}|{ok: false, code: string, message: string}}
 */
function recordWatchedMessage(input) {
  // A defined lifecycle boundary for pruning (PRR-A I-Gate Round 1 Finding
  // 2): this module has no scheduler of its own, so rather than leave
  // `pruneExpiredWatchedMessages` an export nothing calls, every new write
  // -- the one event guaranteed to recur as long as anything is watching --
  // also sweeps whatever has aged out since the last one.
  pruneExpiredWatchedMessages();
  const { messageId, channelId, threadId, authorLabel, sourceLabel, text } = input || {};
  if (typeof messageId !== 'string' || !messageId) return _refuse('BRIDGE_WATCHED_MESSAGE_INVALID', 'messageId is required.');
  if (typeof authorLabel !== 'string' || !authorLabel) return _refuse('BRIDGE_WATCHED_MESSAGE_INVALID', 'authorLabel is required.');
  if (typeof sourceLabel !== 'string' || !sourceLabel) return _refuse('BRIDGE_WATCHED_MESSAGE_INVALID', 'sourceLabel is required.');
  const channel = getChannel(channelId);
  if (!channel) return _refuse('NOT_FOUND', `No watched channel "${channelId}".`);
  if (!_threadInScope(channel, threadId)) {
    return _refuse('BRIDGE_CHANNEL_OUT_OF_SCOPE', `Thread "${threadId}" is outside "${channelId}"'s watched forum scope.`);
  }
  const retentionMs = Number.isFinite(input.retentionMs) && input.retentionMs > 0 ? input.retentionMs : DEFAULT_RETENTION_MS;
  const now = _internal.now();
  const expiresAt = new Date(Date.parse(now) + retentionMs).toISOString();

  const db = _db();
  db.prepare(
    `INSERT INTO bridge_watched_messages (message_id, channel_id, thread_id, author_label, authority, source_label, text, received_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(messageId, channelId, threadId || null, authorLabel, WATCHED_UNTRUSTED, sourceLabel, typeof text === 'string' ? text.slice(0, 8000) : null, now, expiresAt);

  return { ok: true, message: _messageView(db.prepare('SELECT * FROM bridge_watched_messages WHERE message_id = ?').get(messageId)) };
}

/**
 * Watched messages, newest first, optionally scoped to one channel/thread.
 * Always excludes a message past its own `expiresAt` (PRR-A I-Gate Round 1
 * Finding 2) -- the bounded-retention contract is enforced on READ, never
 * left to depend on some caller remembering to prune first; an expired row
 * physically still on disk (pruning is opportunistic, see
 * {@link recordWatchedMessage}) must never be served as live.
 * @param {object} [filter]
 * @param {string} [filter.channelId]
 * @param {string} [filter.threadId]
 * @param {number} [filter.limit] - Default 100
 * @returns {object[]}
 */
function listWatchedMessages(filter = {}) {
  const clauses = ['expires_at > ?'];
  const params = [_internal.now()];
  if (filter.channelId) { clauses.push('channel_id = ?'); params.push(filter.channelId); }
  if (filter.threadId) { clauses.push('thread_id = ?'); params.push(filter.threadId); }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? Math.min(filter.limit, 500) : 100;
  return _db().prepare(`SELECT * FROM bridge_watched_messages ${where} ORDER BY received_at DESC LIMIT ?`).all(...params, limit).map(_messageView);
}

/**
 * Delete every watched message past its own retention bound.
 * @param {object} [options]
 * @param {string} [options.at] - Clock override
 * @returns {number} How many rows were deleted
 */
function pruneExpiredWatchedMessages(options = {}) {
  const now = options.at || _internal.now();
  return _db().prepare('DELETE FROM bridge_watched_messages WHERE expires_at <= ?').run(now).changes;
}

/**
 * Create a scoped publication grant: posting to `destinationChannelId` is
 * held until a grant exists, bound to the exact text/route/idempotency-key a
 * poster later presents. Refuses on a channel whose `sendAllowed` is not
 * `true` -- a watch-only or two-way-but-not-postable channel can never be
 * granted a posting right by creating one here. Idempotent on
 * `idempotencyKey`: a repeat call with the identical bound fields replays
 * the first grant rather than erroring; one with the SAME key but different
 * bound fields is refused as a conflict, since replaying it would silently
 * authorize a different post under the caller's earlier approval.
 * @param {object} input
 * @param {string} input.destinationChannelId
 * @param {string} input.textSha256 - 64 lowercase hex characters
 * @param {string} input.operatorRouteId
 * @param {string} input.idempotencyKey
 * @param {number} [input.ttlMs] - Default {@link DEFAULT_GRANT_TTL_MS}
 * @returns {{ok: true, grant: object, replayed: boolean}|{ok: false, code: string, message: string}}
 */
function createPublicationGrant(input) {
  const { destinationChannelId, textSha256, operatorRouteId, idempotencyKey } = input || {};
  if (typeof destinationChannelId !== 'string' || !destinationChannelId) {
    return _refuse('BRIDGE_GRANT_INVALID', 'destinationChannelId is required.');
  }
  if (typeof textSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(textSha256)) {
    return _refuse('BRIDGE_GRANT_INVALID', 'textSha256 must be 64 lowercase hex characters.');
  }
  if (typeof operatorRouteId !== 'string' || !operatorRouteId) return _refuse('BRIDGE_GRANT_INVALID', 'operatorRouteId is required.');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) return _refuse('BRIDGE_GRANT_INVALID', 'idempotencyKey is required.');

  const channel = getChannel(destinationChannelId);
  if (!channel) return _refuse('NOT_FOUND', `No watched channel "${destinationChannelId}".`);
  if (!channel.sendAllowed) return _refuse('BRIDGE_CHANNEL_SEND_NOT_ALLOWED', `"${destinationChannelId}" does not allow sending.`);

  const db = _db();
  const existing = db.prepare('SELECT * FROM bridge_publication_grants WHERE idempotency_key = ?').get(idempotencyKey);
  if (existing) {
    const matches = existing.destination_channel_id === destinationChannelId && existing.text_sha256 === textSha256
      && existing.operator_route_id === operatorRouteId;
    if (!matches) {
      return _refuse('BRIDGE_GRANT_IDEMPOTENCY_CONFLICT',
        `idempotencyKey "${idempotencyKey}" is already bound to a different grant.`);
    }
    return { ok: true, grant: _grantView(existing), replayed: true };
  }

  const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_GRANT_TTL_MS;
  const now = _internal.now();
  const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
  const grantId = _internal.grantId();
  db.prepare(
    `INSERT INTO bridge_publication_grants
       (grant_id, destination_channel_id, text_sha256, operator_route_id, idempotency_key, state, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(grantId, destinationChannelId, textSha256, operatorRouteId, idempotencyKey, expiresAt, now);
  return { ok: true, grant: _grantView(db.prepare('SELECT * FROM bridge_publication_grants WHERE grant_id = ?').get(grantId)), replayed: false };
}

/**
 * Load a grant by `idempotencyKey` and verify the presented post matches it
 * EXACTLY -- shared by {@link checkPublicationGrant} and
 * {@link validateAndConsumePublicationGrant}, which otherwise diverge on
 * what an already-consumed or expired grant means to each of them.
 * @param {object} input
 * @param {string} input.idempotencyKey
 * @param {string} input.destinationChannelId
 * @param {string} input.textSha256
 * @param {string} input.operatorRouteId
 * @returns {{row: object}|{refusal: {ok: false, code: string, message: string}}}
 */
function _loadMatchingGrant({ idempotencyKey, destinationChannelId, textSha256, operatorRouteId }) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
    return { refusal: _refuse('BRIDGE_GRANT_INVALID', 'idempotencyKey is required.') };
  }
  const row = _db().prepare('SELECT * FROM bridge_publication_grants WHERE idempotency_key = ?').get(idempotencyKey);
  if (!row) return { refusal: _refuse('NOT_FOUND', `No publication grant for idempotencyKey "${idempotencyKey}".`) };
  if (row.destination_channel_id !== destinationChannelId || row.text_sha256 !== textSha256 || row.operator_route_id !== operatorRouteId) {
    return { refusal: _refuse('BRIDGE_GRANT_MISMATCH', 'The presented post does not match exactly what this grant authorizes.') };
  }
  return { row };
}

/**
 * Read-only preflight: whether a presented grant may actually be acted on
 * RIGHT NOW -- never mutates anything, and must be called BEFORE a helper
 * attempts the real Discord post, never after (PRR-A I-Gate Round 1
 * Finding 1). {@link validateAndConsumePublicationGrant} cannot serve this
 * purpose itself: it needs an `outcome` the helper cannot know until AFTER
 * it has already tried to post, so calling it first either consumes the
 * grant before the attempt (whether or not it succeeds) or invents an
 * outcome that was never observed. This checks the exact binding, that the
 * grant is not already consumed, that a fresh grant's own expiry has not
 * passed, and -- re-read now, never trusted from grant-creation time -- that
 * the channel's CURRENT `sendAllowed` is still true, so revoking send
 * permission on a channel with a pending grant actually stops the next post.
 * @param {object} input
 * @param {string} input.idempotencyKey
 * @param {string} input.destinationChannelId
 * @param {string} input.textSha256
 * @param {string} input.operatorRouteId
 * @returns {{ok: true, grant: object}|{ok: false, code: string, message: string}}
 */
function checkPublicationGrant(input) {
  const { row, refusal } = _loadMatchingGrant(input || {});
  if (refusal) return refusal;
  if (row.state === 'consumed') {
    return _refuse('BRIDGE_GRANT_ALREADY_CONSUMED',
      `Grant for idempotencyKey "${row.idempotency_key}" was already consumed with outcome "${row.outcome}".`, { outcome: row.outcome });
  }
  // PRR-A I-Gate Round 2 Finding: unlike validateAndConsumePublicationGrant
  // (which may still need to SETTLE an already-recorded 'unknown' outcome
  // after the TTL closes), this is the gate for attempting a NEW post --
  // expiry applies here regardless of outcome, or an 'unknown' outcome
  // would let pre-send authorization outlive the grant's TTL indefinitely.
  if (_internal.now() > row.expires_at) {
    return _refuse('BRIDGE_GRANT_EXPIRED', `Grant for idempotencyKey "${row.idempotency_key}" has expired.`);
  }
  const channel = getChannel(row.destination_channel_id);
  if (!channel || !channel.sendAllowed) {
    return _refuse('BRIDGE_CHANNEL_SEND_NOT_ALLOWED', `"${row.destination_channel_id}" no longer allows sending.`);
  }
  return { ok: true, grant: _grantView(row) };
}

/**
 * Record the outcome of a post a helper has ALREADY attempted, against its
 * grant. Every bound field must match EXACTLY -- a grant authorizes one
 * post, not "a post like this one." Never re-validates `sendAllowed`: by
 * this point the post was already attempted (or deliberately not, per
 * {@link checkPublicationGrant}'s own refusal), and a channel's permission
 * changing after that moment has nothing left here to protect -- only a
 * record to settle. An `'unknown'` outcome (the poster could not confirm
 * whether Discord accepted it) is recorded but the grant is NOT marked
 * consumed: a later call with a confirmed outcome (`'posted'` or `'failed'`)
 * may still settle it, so the uncertainty is never silently discarded. A
 * grant already settled with a confirmed outcome answers that same outcome
 * again on a repeat (idempotent readback), never re-evaluates.
 * @param {object} input
 * @param {string} input.idempotencyKey
 * @param {string} input.destinationChannelId
 * @param {string} input.textSha256
 * @param {string} input.operatorRouteId
 * @param {'posted'|'failed'|'unknown'} input.outcome
 * @returns {{ok: true, grant: object}|{ok: false, code: string, message: string}}
 */
function validateAndConsumePublicationGrant(input) {
  const { outcome } = input || {};
  if (!GRANT_OUTCOMES.includes(outcome)) return _refuse('BRIDGE_GRANT_INVALID', `outcome must be one of ${GRANT_OUTCOMES.join(', ')}.`);
  const { row, refusal } = _loadMatchingGrant(input || {});
  if (refusal) return refusal;
  if (row.state === 'consumed') {
    // A confirmed outcome never re-evaluates -- idempotent readback.
    return { ok: true, grant: _grantView(row) };
  }
  // Expiry bounds a FRESH grant's first attempt only. Once any outcome
  // (including 'unknown') has been recorded, resolving that uncertainty
  // later is never blocked by the original window having closed.
  if (row.outcome === null && _internal.now() > row.expires_at) {
    return _refuse('BRIDGE_GRANT_EXPIRED', `Grant for idempotencyKey "${row.idempotency_key}" has expired.`);
  }

  const db = _db();
  // 'unknown' never consumes the grant -- it stays exactly as it was
  // (pending, or consumed from an earlier 'unknown'), so a later confirmed
  // outcome may still settle it. 'posted'/'failed' consume it now.
  if (outcome === 'unknown') {
    db.prepare('UPDATE bridge_publication_grants SET outcome = ? WHERE idempotency_key = ?').run(outcome, row.idempotency_key);
  } else {
    db.prepare('UPDATE bridge_publication_grants SET state = ?, outcome = ?, consumed_at = ? WHERE idempotency_key = ?')
      .run('consumed', outcome, _internal.now(), row.idempotency_key);
  }
  return { ok: true, grant: _grantView(db.prepare('SELECT * FROM bridge_publication_grants WHERE idempotency_key = ?').get(row.idempotency_key)) };
}

module.exports = {
  MODES,
  WATCHED_UNTRUSTED,
  GRANT_STATES,
  GRANT_OUTCOMES,
  DEFAULT_RETENTION_MS,
  DEFAULT_GRANT_TTL_MS,
  ensureBridgeChannelsSchema,
  registerChannel,
  updateChannel,
  getChannel,
  listChannels,
  recordWatchedMessage,
  listWatchedMessages,
  pruneExpiredWatchedMessages,
  createPublicationGrant,
  checkPublicationGrant,
  validateAndConsumePublicationGrant,
  _internal
};
