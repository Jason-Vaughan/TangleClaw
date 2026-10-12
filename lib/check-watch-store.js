'use strict';

/**
 * The check watch's records: every read and write over `check_watches` and
 * `check_watch_facts`.
 *
 * Each write runs in one `BEGIN IMMEDIATE` transaction together with the fact
 * that records it, so a change and its history land or fail as one. A write
 * that is not allowed changes nothing and answers `{ ok: false, code, message }`
 * with a code from `lib/check-watch-state.js#REFUSALS`; a database error is
 * thrown.
 *
 * This module decides what the records permit: that a watch names something
 * GitHub can be asked about, that its due time is inside the limit, that a
 * project holds one open watch per check and no more than its share, that a
 * result is written once and only from a terminal conclusion, that each of
 * a watch's two messages is recorded as sent once, and that a watch is expired
 * once and only when it has gone unresolved long enough. It does not decide who the
 * caller is (the HTTP layer resolves that) and it calls nothing outside the
 * database: no GitHub, no switchboard, no session lookup.
 *
 * @module lib/check-watch-store
 */

const crypto = require('node:crypto');
const store = require('./store');
const state = require('./check-watch-state');
const githubChecks = require('./github-checks');

const { REFUSALS } = state;

const CODE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const EXCHANGE_ID_SHAPE = /^[A-Za-z0-9._:-]{1,64}$/;
const WORKSPACE_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_READ_DETAIL = 500;
const MAX_FACT_DETAIL = 4096;

/** What makes a watch open: no result, not cancelled, not expired. The partial unique index in `lib/store.js` says the same. */
const OPEN = 'result_read_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL';

/** The fact each of a watch's messages leaves when the switchboard accepts it, and when it cannot be delivered. */
const MESSAGE_FACTS = Object.freeze({
  wake: Object.freeze({ sent: 'woke', undeliverable: 'wake-undeliverable' }),
  alarm: Object.freeze({ sent: 'alarmed', undeliverable: 'alarm-undeliverable' })
});

/** Seams for tests: the clock and the id source. */
const _internal = {
  now: () => new Date().toISOString(),
  id: () => `cw_${crypto.randomBytes(12).toString('hex')}`
};

/**
 * A refusal, in the one shape every write answers with.
 * @param {string} code - A code from `REFUSALS`
 * @param {string} message - What was refused and what to do, for a person
 * @param {object} [extra] - Further fields for the caller
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

/**
 * Run `fn` inside one `BEGIN IMMEDIATE` transaction and return its result. A
 * refusal returned by `fn` rolls the transaction back, so a refused write
 * leaves no partial change.
 * @param {(db: object) => object} fn - Synchronous work
 * @returns {object} Whatever `fn` returns
 */
function _transaction(fn) {
  const db = _db();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(db);
    db.exec(out && out.ok === false ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
}

/**
 * The open database.
 * @returns {object}
 * @throws {Error} When the store is not initialized
 */
function _db() {
  const db = store.getDb();
  if (!db) throw new Error('The store is not initialized.');
  return db;
}

/**
 * A trimmed, non-empty string no longer than `max`, or null.
 * @param {*} value - Candidate text
 * @param {number} max - Longest length allowed
 * @returns {string|null}
 */
function _text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** The furthest a JavaScript Date reaches either side of 1970, in milliseconds. */
const MAX_DATE_MS = 8.64e15;

/**
 * A time as an ISO string, or null when it is not a time. A number beyond
 * what a Date can hold is not a time: it is answered as one, not thrown on.
 * @param {*} value - An ISO string, a Date or a number of milliseconds
 * @returns {string|null}
 */
function _iso(value) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string' && value.trim()) value = Date.parse(value);
  return Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS ? new Date(value).toISOString() : null;
}

/**
 * Append one fact to a watch's history. Called inside the transaction that
 * makes the change it records. A detail that would not fit the column once
 * written as JSON is replaced by a marker saying so: the row holds the facts,
 * and a history that cannot be written must never be what stops a change.
 * @param {object} db - The database, inside a transaction
 * @param {object} fact - `{ watchId, kind, code?, requestId?, exchangeId?, workspaceId?, detail?, at }`
 * @returns {void}
 */
function _appendFact(db, fact) {
  let detail = fact.detail ? JSON.stringify(fact.detail) : null;
  if (detail && detail.length > MAX_FACT_DETAIL) detail = JSON.stringify({ omitted: 'detail too long to record', length: detail.length });
  db.prepare(
    'INSERT INTO check_watch_facts (watch_id, kind, code, request_id, exchange_id, recipient_workspace_id, detail_json, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    fact.watchId, fact.kind, fact.code || null, fact.requestId || null, fact.exchangeId || null,
    fact.workspaceId || null, detail, fact.at
  );
}

/**
 * A watch row as callers see it.
 * @param {object} row - A `check_watches` row
 * @returns {object|null}
 */
function _watch(row) {
  if (!row) return null;
  return {
    watchId: row.watch_id,
    projectId: row.project_id,
    registeredBy: { sessionId: row.registered_session_id, launchId: row.registered_launch_id },
    repo: row.repo,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    checkName: row.check_name,
    dueAt: row.due_at,
    registeredAt: row.registered_at,
    result: row.result_read_at
      ? { conclusion: row.result_conclusion, runId: row.result_run_id, completedAt: row.result_completed_at, readAt: row.result_read_at }
      : null,
    lastRead: row.last_read_at ? { at: row.last_read_at, outcome: row.last_read_outcome, detail: row.last_read_detail } : null,
    cancelled: row.cancelled_at
      ? { at: row.cancelled_at, projectId: row.cancelled_by_project_id, launchId: row.cancelled_by_launch_id }
      : null,
    expired: row.expired_at ? { at: row.expired_at } : null
  };
}

/**
 * A fact row as callers see it.
 * @param {object} row - A `check_watch_facts` row
 * @returns {object}
 */
function _fact(row) {
  let detail = null;
  if (row.detail_json) {
    try { detail = JSON.parse(row.detail_json); } catch { detail = { unreadable: true }; }
  }
  return {
    factId: row.fact_id,
    watchId: row.watch_id,
    kind: row.kind,
    code: row.code,
    requestId: row.request_id,
    exchangeId: row.exchange_id,
    workspaceId: row.recipient_workspace_id,
    detail,
    at: row.created_at
  };
}

/**
 * Read a watch row inside a transaction.
 * @param {object} db - The database
 * @param {*} watchId - Watch id
 * @returns {object|undefined} The raw row
 */
function _row(db, watchId) {
  return db.prepare('SELECT * FROM check_watches WHERE watch_id = ?').get(String(watchId));
}

/**
 * One fact of a watch by kind, for the kinds a watch holds once.
 * @param {object} db - The database
 * @param {string} watchId - Watch id
 * @param {string} kind - A once-only fact kind
 * @returns {object|null}
 */
function _factOf(db, watchId, kind) {
  const row = db.prepare('SELECT * FROM check_watch_facts WHERE watch_id = ? AND kind = ?').get(watchId, kind);
  return row ? _fact(row) : null;
}

/**
 * The refusal for a watch id that names nothing.
 * @param {*} watchId - The id asked for
 * @returns {{ok: false, code: string, message: string}}
 */
function _notFound(watchId) {
  return _refuse(REFUSALS.NOT_FOUND, `There is no check watch ${String(watchId)}.`);
}

/**
 * Register a watch: a project asks to be told when one named check finishes
 * on one exact commit of a pull request, with a time after which silence is
 * itself reported.
 * @param {object} input
 * @param {number} input.projectId - The project the watch belongs to and whose live session is woken
 * @param {number|null} [input.sessionId] - The session that registered it
 * @param {string} input.launchId - The launch that registered it
 * @param {string} input.repo - `owner/name`
 * @param {number} input.prNumber - The pull request the commit belongs to
 * @param {string} input.headSha - The exact commit, 40 lower-case hex characters
 * @param {string} input.checkName - The check's name, exactly as GitHub shows it
 * @param {string|number|Date} input.dueAt - When an unresolved check is reported; after now and no further ahead than the limit
 * @returns {{ok: true, watch: object}|{ok: false, code: string, message: string}}
 */
function registerWatch(input) {
  const i = input || {};
  const launchId = _text(i.launchId, 128);
  const sessionId = i.sessionId === undefined || i.sessionId === null ? null : i.sessionId;
  if (!Number.isInteger(i.projectId) || i.projectId <= 0 || !launchId) {
    return _refuse(REFUSALS.MALFORMED, 'A watch is registered by a project and a launch.');
  }
  if (sessionId !== null && (!Number.isInteger(sessionId) || sessionId <= 0)) {
    return _refuse(REFUSALS.MALFORMED, 'The registering session must be a session number.');
  }
  if (!Number.isInteger(i.prNumber) || i.prNumber <= 0) return _refuse(REFUSALS.MALFORMED, 'The pull request must be a positive number.');
  const invalid = githubChecks.invalidRequest(i.repo, i.headSha, i.checkName);
  if (invalid) return _refuse(REFUSALS.MALFORMED, `A watch cannot be read as asked: ${invalid}.`);
  const dueAt = _iso(i.dueAt);
  if (!dueAt) return _refuse(REFUSALS.MALFORMED, 'A watch needs a due time.');

  return _transaction((db) => {
    const at = _internal.now();
    const ahead = Date.parse(dueAt) - Date.parse(at);
    if (!(ahead > 0) || ahead > state.MAX_DUE_AHEAD_MS) {
      return _refuse(REFUSALS.DUE_OUT_OF_RANGE,
        `The due time must be after now and at most ${state.MAX_DUE_AHEAD_MS / 3600000} hours ahead.`);
    }
    const open = db.prepare(
      'SELECT watch_id FROM check_watches WHERE project_id = ? AND repo = ? AND head_sha = ? AND check_name = ? '
      + `AND ${OPEN}`
    ).get(i.projectId, i.repo, i.headSha, i.checkName);
    if (open) {
      return _refuse(REFUSALS.DUPLICATE, `This project already watches that check on that commit (${open.watch_id}).`, { watchId: open.watch_id });
    }
    if (_countOpen(db, i.projectId) >= state.MAX_OPEN_PER_PROJECT) {
      return _refuse(REFUSALS.LIMIT,
        `This project already has ${state.MAX_OPEN_PER_PROJECT} open watches. Cancel one, or wait for one to resolve.`);
    }
    const watchId = _internal.id();
    db.prepare(
      'INSERT INTO check_watches (watch_id, project_id, registered_session_id, registered_launch_id, repo, pr_number, '
      + 'head_sha, check_name, due_at, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(watchId, i.projectId, sessionId, launchId, i.repo, i.prNumber, i.headSha, i.checkName, dueAt, at);
    _appendFact(db, { watchId, kind: 'registered', detail: { sessionId, launchId, dueAt }, at });
    return { ok: true, watch: _watch(_row(db, watchId)) };
  });
}

/**
 * A reading from `lib/github-checks.js#readCheck` in the shape this module
 * records, or null when it is not one. A concluded reading must carry a
 * conclusion GitHub gives, the run's id and when it completed.
 * @param {*} reading - Candidate reading
 * @returns {object|null}
 */
function _reading(reading) {
  if (!reading || typeof reading !== 'object') return null;
  if (reading.status === 'not-found') return { status: 'not-found' };
  if (reading.status === 'running') return { status: 'running' };
  if (reading.status === 'unavailable') {
    const reason = typeof reading.reason === 'string' && reading.reason.trim() ? reading.reason.trim() : 'no reason given';
    return { status: 'unavailable', reason: reason.slice(0, MAX_READ_DETAIL) };
  }
  if (reading.status === 'concluded') {
    const runId = _text(reading.runId, 64);
    const completedAt = _iso(reading.completedAt);
    if (!githubChecks.CONCLUSIONS.includes(reading.conclusion) || !runId || !completedAt) return null;
    return { status: 'concluded', conclusion: reading.conclusion, runId, completedAt };
  }
  return null;
}

/**
 * Record one read of GitHub for a watch.
 *
 * A concluded reading writes the watch's result, once: this is the only way a
 * result is ever written. A running or not-found reading records that GitHub
 * was read. An unavailable reading records that it could not be, and writes no
 * result. The history gains `read-failed` when reads start failing and
 * `read-recovered` when they work again, not one fact per read.
 *
 * A cancelled watch, an expired watch and a watch that already has its result
 * are not read again, so recording a read for any of them is refused.
 * @param {string} watchId - Watch id
 * @param {object} reading - What `readCheck` returned
 * @returns {{ok: true, watch: object, recorded: (string|null)}|{ok: false, code: string, message: string}}
 */
function recordRead(watchId, reading) {
  const read = _reading(reading);
  if (!read) return _refuse(REFUSALS.MALFORMED, 'That is not a reading of a check.');
  return _transaction((db) => {
    const row = _row(db, watchId);
    if (!row) return _notFound(watchId);
    if (row.cancelled_at) return _refuse(REFUSALS.CANCELLED, `Watch ${row.watch_id} was cancelled and is not read again.`);
    if (row.expired_at) return _refuse(REFUSALS.EXPIRED, `Watch ${row.watch_id} expired unresolved and is not read again. Register a new watch.`);
    if (row.result_read_at) return _refuse(REFUSALS.ALREADY_RESOLVED, `Watch ${row.watch_id} already has its result.`);
    const at = _internal.now();
    const wasFailing = row.last_read_outcome === 'failed';
    let recorded = null;
    if (read.status === 'unavailable') {
      db.prepare("UPDATE check_watches SET last_read_at = ?, last_read_outcome = 'failed', last_read_detail = ? WHERE watch_id = ?")
        .run(at, read.reason, row.watch_id);
      if (!wasFailing) {
        recorded = 'read-failed';
        _appendFact(db, { watchId: row.watch_id, kind: recorded, detail: { reason: read.reason }, at });
      }
    } else if (read.status === 'concluded') {
      db.prepare(
        "UPDATE check_watches SET last_read_at = ?, last_read_outcome = 'ok', last_read_detail = NULL, "
        + 'result_conclusion = ?, result_run_id = ?, result_completed_at = ?, result_read_at = ? WHERE watch_id = ?'
      ).run(at, read.conclusion, read.runId, read.completedAt, at, row.watch_id);
      recorded = 'resolved';
      _appendFact(db, { watchId: row.watch_id, kind: recorded, code: read.conclusion, detail: { runId: read.runId, completedAt: read.completedAt }, at });
    } else {
      db.prepare("UPDATE check_watches SET last_read_at = ?, last_read_outcome = 'ok', last_read_detail = NULL WHERE watch_id = ?")
        .run(at, row.watch_id);
      if (wasFailing) {
        recorded = 'read-recovered';
        _appendFact(db, { watchId: row.watch_id, kind: recorded, at });
      }
    }
    return { ok: true, watch: _watch(_row(db, row.watch_id)), recorded };
  });
}

/**
 * The refusal, if any, that says a watch has not reached the point where this
 * message exists: a wake needs a recorded result, an alarm a due time that
 * has passed.
 * @param {object} row - The raw watch row
 * @param {'wake'|'alarm'} messageKind - Which message
 * @param {string} at - The time now
 * @returns {{ok: false, code: string, message: string}|null}
 */
function _notYet(row, messageKind, at) {
  if (messageKind === 'wake' && !row.result_read_at) {
    return _refuse(REFUSALS.NOT_RESOLVED, `Watch ${row.watch_id} has no result yet, so there is no wake to record.`);
  }
  if (messageKind === 'alarm' && !(Date.parse(at) >= Date.parse(row.due_at))) {
    return _refuse(REFUSALS.NOT_DUE, `Watch ${row.watch_id} is not due until ${row.due_at}, so there is no alarm to record.`);
  }
  return null;
}

/**
 * Record that one of a watch's two messages was accepted by the switchboard:
 * the wake for its result, or the alarm for its due time. Once per watch and
 * message, enforced here and by the database, and stored with the request id
 * the message is always sent under ({@link state.requestIdFor}), the exchange
 * that carries its delivery receipt, and the workspace it went to.
 *
 * It is not refused for a cancelled watch: a message that was sent before the
 * cancellation landed was still sent, and the record has to say so.
 * @param {string} watchId - Watch id
 * @param {'wake'|'alarm'} messageKind - Which message
 * @param {object} sent
 * @param {string} sent.exchangeId - The switchboard exchange made for the send
 * @param {string} sent.workspaceId - The workspace it was sent to
 * @param {string} [sent.code] - A short code for how it came to be recorded
 * @returns {{ok: true, watch: object, fact: object}|{ok: false, code: string, message: string}}
 */
function recordSent(watchId, messageKind, sent) {
  const kinds = MESSAGE_FACTS[messageKind];
  const s = sent || {};
  if (!kinds) return _refuse(REFUSALS.MALFORMED, 'A watch sends a wake or an alarm and nothing else.');
  if (typeof s.exchangeId !== 'string' || !EXCHANGE_ID_SHAPE.test(s.exchangeId)) {
    return _refuse(REFUSALS.MALFORMED, 'A sent message is recorded with its exchange id.');
  }
  if (typeof s.workspaceId !== 'string' || !WORKSPACE_ID_SHAPE.test(s.workspaceId)) {
    return _refuse(REFUSALS.MALFORMED, 'A sent message is recorded with the workspace it went to.');
  }
  if (s.code !== undefined && s.code !== null && (typeof s.code !== 'string' || !CODE_SHAPE.test(s.code))) {
    return _refuse(REFUSALS.MALFORMED, 'The code must be 1 to 64 letters, digits, _ or -.');
  }
  return _transaction((db) => {
    const row = _row(db, watchId);
    if (!row) return _notFound(watchId);
    const at = _internal.now();
    const notYet = _notYet(row, messageKind, at);
    if (notYet) return notYet;
    const already = _factOf(db, row.watch_id, kinds.sent);
    if (already) {
      return _refuse(REFUSALS.ALREADY_RECORDED, `Watch ${row.watch_id}'s ${messageKind} is already recorded as sent.`, { fact: already });
    }
    _appendFact(db, {
      watchId: row.watch_id, kind: kinds.sent, code: s.code || null, requestId: state.requestIdFor(row.watch_id, messageKind),
      exchangeId: s.exchangeId, workspaceId: s.workspaceId, at
    });
    return { ok: true, watch: _watch(row), fact: _factOf(db, row.watch_id, kinds.sent) };
  });
}

/**
 * Record that one of a watch's two messages could not be delivered when it
 * fell due, because the project had no live session to receive it. Once per
 * watch and message. It does not close anything: the message is still owed
 * and is sent when a session of the project is next live.
 * @param {string} watchId - Watch id
 * @param {'wake'|'alarm'} messageKind - Which message
 * @param {object} why
 * @param {string} why.code - A short code for why it could not be delivered
 * @param {string} [why.workspaceId] - The workspace it would have gone to, when known
 * @param {string} [why.detail] - More, for a person
 * @returns {{ok: true, watch: object, fact: object}|{ok: false, code: string, message: string}}
 */
function recordUndeliverable(watchId, messageKind, why) {
  const kinds = MESSAGE_FACTS[messageKind];
  const w = why || {};
  if (!kinds) return _refuse(REFUSALS.MALFORMED, 'A watch sends a wake or an alarm and nothing else.');
  if (typeof w.code !== 'string' || !CODE_SHAPE.test(w.code)) {
    return _refuse(REFUSALS.MALFORMED, 'An undeliverable message is recorded with a code of 1 to 64 letters, digits, _ or -.');
  }
  const hasWorkspace = w.workspaceId !== undefined && w.workspaceId !== null;
  if (hasWorkspace && (typeof w.workspaceId !== 'string' || !WORKSPACE_ID_SHAPE.test(w.workspaceId))) {
    return _refuse(REFUSALS.MALFORMED, 'The workspace is not a workspace id.');
  }
  const detail = w.detail === undefined || w.detail === null ? null : _text(w.detail, 1000);
  if (w.detail !== undefined && w.detail !== null && !detail) {
    return _refuse(REFUSALS.MALFORMED, 'The detail must be 1 to 1000 characters.');
  }
  return _transaction((db) => {
    const row = _row(db, watchId);
    if (!row) return _notFound(watchId);
    if (row.cancelled_at) return _refuse(REFUSALS.CANCELLED, `Watch ${row.watch_id} was cancelled; it owes no message.`);
    const at = _internal.now();
    const notYet = _notYet(row, messageKind, at);
    if (notYet) return notYet;
    const already = _factOf(db, row.watch_id, kinds.sent) || _factOf(db, row.watch_id, kinds.undeliverable);
    if (already) {
      return _refuse(REFUSALS.ALREADY_RECORDED, `Watch ${row.watch_id}'s ${messageKind} is already recorded as ${already.kind}.`, { fact: already });
    }
    _appendFact(db, {
      watchId: row.watch_id, kind: kinds.undeliverable, code: w.code, workspaceId: hasWorkspace ? w.workspaceId : null,
      detail: detail ? { detail } : null, at
    });
    return { ok: true, watch: _watch(row), fact: _factOf(db, row.watch_id, kinds.undeliverable) };
  });
}

/**
 * Expire a watch: it went unresolved for `EXPIRE_AFTER_DUE_MS` past its due
 * time, so it is not read again and no longer counts as open. Once per watch.
 *
 * Refused for a watch that has its result (a result is never replaced by an
 * expiry), a cancelled one, one already expired, and one that has not yet
 * been unresolved that long.
 * @param {string} watchId - Watch id
 * @returns {{ok: true, watch: object}|{ok: false, code: string, message: string}}
 */
function recordExpired(watchId) {
  return _transaction((db) => {
    const row = _row(db, watchId);
    if (!row) return _notFound(watchId);
    if (row.result_read_at) return _refuse(REFUSALS.ALREADY_RESOLVED, `Watch ${row.watch_id} already has its result, so it does not expire.`);
    if (row.cancelled_at) return _refuse(REFUSALS.CANCELLED, `Watch ${row.watch_id} was cancelled, so it does not expire.`);
    if (row.expired_at) return _refuse(REFUSALS.EXPIRED, `Watch ${row.watch_id} has already expired.`);
    const at = _internal.now();
    const expiresAt = Date.parse(row.due_at) + state.EXPIRE_AFTER_DUE_MS;
    if (!(Date.parse(at) >= expiresAt)) {
      return _refuse(REFUSALS.NOT_DUE,
        `Watch ${row.watch_id} does not expire until ${state.EXPIRE_AFTER_DUE_MS / 3600000} hours after its due time (${row.due_at}).`);
    }
    db.prepare('UPDATE check_watches SET expired_at = ? WHERE watch_id = ?').run(at, row.watch_id);
    _appendFact(db, { watchId: row.watch_id, kind: 'expired', detail: { dueAt: row.due_at }, at });
    return { ok: true, watch: _watch(_row(db, row.watch_id)) };
  });
}

/**
 * Cancel a watch. Only the project it belongs to may, and once. A cancelled
 * watch is never read again and is owed no message; a result it already has
 * stays recorded.
 * @param {string} watchId - Watch id
 * @param {{projectId: number, launchId: string}} actor - The launch cancelling it
 * @returns {{ok: true, watch: object}|{ok: false, code: string, message: string}}
 */
function cancelWatch(watchId, actor) {
  const a = actor || {};
  const launchId = _text(a.launchId, 128);
  if (!Number.isInteger(a.projectId) || a.projectId <= 0 || !launchId) {
    return _refuse(REFUSALS.MALFORMED, 'A watch is cancelled by a project and a launch.');
  }
  return _transaction((db) => {
    const row = _row(db, watchId);
    if (!row) return _notFound(watchId);
    if (row.project_id !== a.projectId) return _refuse(REFUSALS.NOT_OWNER, 'Only the project a watch belongs to may cancel it.');
    if (row.cancelled_at) return _refuse(REFUSALS.CANCELLED, `Watch ${row.watch_id} is already cancelled.`);
    const at = _internal.now();
    db.prepare('UPDATE check_watches SET cancelled_at = ?, cancelled_by_project_id = ?, cancelled_by_launch_id = ? WHERE watch_id = ?')
      .run(at, a.projectId, launchId, row.watch_id);
    _appendFact(db, { watchId: row.watch_id, kind: 'cancelled', detail: { projectId: a.projectId, launchId }, at });
    return { ok: true, watch: _watch(_row(db, row.watch_id)) };
  });
}

/**
 * How many open watches a project holds: those with no result, not cancelled
 * and not expired.
 * @param {object} db - The database
 * @param {number} projectId - Project id
 * @returns {number}
 */
function _countOpen(db, projectId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM check_watches WHERE project_id = ? AND ${OPEN}`
  ).get(projectId).n;
}

/**
 * How many open watches a project holds.
 * @param {number} projectId - Project id
 * @returns {number}
 */
function countOpen(projectId) {
  return _countOpen(_db(), projectId);
}

/**
 * One watch.
 * @param {string} watchId - Watch id
 * @returns {object|null}
 */
function getWatch(watchId) {
  return _watch(_row(_db(), watchId));
}

/**
 * A project's watches, newest first.
 * @param {number} projectId - Project id
 * @param {{openOnly?: boolean}} [opts] - `openOnly` leaves out resolved, cancelled and expired watches
 * @returns {object[]}
 */
function listWatches(projectId, opts = {}) {
  const open = opts.openOnly ? ` AND ${OPEN}` : '';
  return _db().prepare(`SELECT * FROM check_watches WHERE project_id = ?${open} ORDER BY registered_at DESC, rowid DESC`)
    .all(projectId).map(_watch);
}

/**
 * Every open watch, which is every watch still to be read from GitHub. The watch
 * read longest ago comes first, and one never read before any that was.
 * @returns {object[]}
 */
function listUnresolved() {
  return _db().prepare(
    `SELECT * FROM check_watches WHERE ${OPEN} ORDER BY last_read_at IS NOT NULL, last_read_at, rowid`
  ).all().map(_watch);
}

/**
 * Every watch that owes one of its two messages: for `wake`, a result with no
 * `woke` fact; for `alarm`, a due time at or before `now` with no result and
 * no `alarmed` fact. A cancelled watch owes nothing. An expired watch still
 * owes an alarm it was never sent: each watch says whether it expired, so the
 * caller can leave those out.
 * @param {'wake'|'alarm'} messageKind - Which message
 * @param {string|number|Date} [now] - The time to judge due times against, for `alarm`
 * @returns {object[]} Oldest registration first
 * @throws {Error} When the message kind is not one a watch sends
 */
function listOwed(messageKind, now) {
  const kinds = MESSAGE_FACTS[messageKind];
  if (!kinds) throw new Error('listOwed needs the message kind wake or alarm');
  const notSent = 'NOT EXISTS (SELECT 1 FROM check_watch_facts f WHERE f.watch_id = w.watch_id AND f.kind = ?)';
  if (messageKind === 'wake') {
    return _db().prepare(
      `SELECT w.* FROM check_watches w WHERE w.result_read_at IS NOT NULL AND w.cancelled_at IS NULL AND ${notSent} `
      + 'ORDER BY w.registered_at, w.rowid'
    ).all(kinds.sent).map(_watch);
  }
  const at = _iso(now === undefined ? _internal.now() : now);
  if (!at) throw new Error('listOwed needs a time');
  return _db().prepare(
    `SELECT w.* FROM check_watches w WHERE w.result_read_at IS NULL AND w.cancelled_at IS NULL AND w.due_at <= ? AND ${notSent} `
    + 'ORDER BY w.registered_at, w.rowid'
  ).all(at, kinds.sent).map(_watch);
}

/**
 * A watch's history, oldest first.
 * @param {string} watchId - Watch id
 * @returns {object[]}
 */
function listFacts(watchId) {
  return _db().prepare('SELECT * FROM check_watch_facts WHERE watch_id = ? ORDER BY fact_id').all(String(watchId)).map(_fact);
}

module.exports = {
  registerWatch,
  recordRead,
  recordSent,
  recordUndeliverable,
  recordExpired,
  cancelWatch,
  countOpen,
  getWatch,
  listWatches,
  listUnresolved,
  listOwed,
  listFacts,
  MESSAGE_FACTS,
  _internal
};
