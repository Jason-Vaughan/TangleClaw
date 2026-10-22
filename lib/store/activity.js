'use strict';

/**
 * The activity log: the event trail the dashboard shows, its per-type
 * retention, and the one insert every writer goes through.
 *
 * The first domain out of `lib/store.js` (#2248), because it is the leaf every
 * other domain calls and none that calls back: moving it first proves the
 * dependency direction. The facade binds the handle with `_bind` from
 * `init()` and unbinds it from `close()`; every `_db.` call site below reads
 * as it did in the one file.
 *
 * Everything below is moved from `lib/store.js` unchanged (#2248); what this
 * file adds is the handle, its binder and guard, and the export list.
 *
 * @module lib/store/activity
 */

const { createLogger } = require('../logger');
const { StoreError, _jsonParse } = require('./_db');

// The logger keeps the facade's name so every log line this domain writes
// reads exactly as it did before the move.
const log = createLogger('store');

let _db = null;

/**
 * Bind the database handle the facade opened, or unbind it with `null`.
 * @param {import('node:sqlite').DatabaseSync|null} db - The open database, or null on close.
 * @returns {void}
 */
function _bind(db) {
  _db = db;
}

/**
 * Refuse while THIS module holds no handle. Over the module's own handle, not
 * the handle module's: a domain the facade forgot to bind would otherwise pass
 * the shared guard and read a null handle, and the lenient `log()` below would
 * drop every event silently. Checking here is what makes that slip fail at the
 * first strict use (`logOrThrow`, `query`) with `NOT_INITIALIZED`; `log()` stays
 * lenient by contract and only ever does nothing.
 * @returns {void}
 * @throws {StoreError} `NOT_INITIALIZED` when the facade has not bound this module.
 */
function _ensureDb() {
  if (!_db) {
    throw new StoreError('Store not initialized. Call store.init() first.', 'NOT_INITIALIZED');
  }
}

// ── Activity Log ──

/**
 * Default per-`event_type` retention for `activity_log` (#869).
 *
 * A per-type cap is the mechanical rule that separates churn from forensic
 * history, and it needs no classification step: because the cap applies within
 * a type, cross-type eviction is impossible by construction. A high-volume type
 * (`port.leased`, 2,167 rows and 36% of the table when this was measured) hits
 * the cap and rotates, while a rare type stays under it for a long time —
 * without anyone maintaining an exemption list that the next `activity.log`
 * call site would silently fall outside of. Rarity exempts itself, and a
 * brand-new event type is bounded on its first insert with nothing to update.
 * The flip side: a type that grows steadily reaches the cap eventually. A record
 * that must outlive such a type gets a rare type of its own, as a stranded wrap
 * does (`wrap.stranded`, separate from the busier `wrap.auto_pr`).
 *
 * A time-based TTL is the wrong instrument for the same reason: at any age
 * cutoff it deletes the rare forensic rows first while leaving the churn that
 * actually grows the table.
 *
 * Scoped per `event_type`, never `project_id`: every `port.leased` and
 * `port.released` row carries a NULL `project_id`, so a project-keyed prune
 * would leave the single largest type entirely unbounded — the case
 * `_pruneSessionRuleDeliveries` documents itself as not covering.
 * @type {number}
 */
const ACTIVITY_LOG_RETENTION = 500;

/** Live retention, defaulting to the constant; overridable via the test seam. */
let _activityLogRetention = ACTIVITY_LOG_RETENTION;

/**
 * The event type recording a retention sweep. Named once so the emit site and
 * the re-entrancy guard below cannot drift apart.
 * @type {string}
 */
const ACTIVITY_PRUNE_EVENT = 'activity.pruned';

/**
 * Test/embedder seam to override the per-`event_type` retention, mirroring
 * `_setSessionRuleVersionRetention`.
 * @param {number} n - Rows to keep per event_type; <= 0 keeps all (unbounded)
 * @returns {void}
 */
function _setActivityLogRetention(n) {
  _activityLogRetention = n;
}

/**
 * Trim one event type's history to the newest `keep` rows. No-op when
 * `keep <= 0` (unbounded) or the type already has <= `keep` rows. Runs after
 * each insert so the table stays bounded without a sweeper.
 *
 * Ordered by `id` rather than `created_at`: `created_at` has one-second
 * resolution, so a burst of inserts within the same second has no total order
 * and "the newest `keep`" would be arbitrary among them. `id` is AUTOINCREMENT
 * and therefore monotonic with insertion.
 * @param {string} eventType - The event type to prune
 * @param {number} keep - Newest rows to retain
 * @returns {number} Rows deleted
 */
function _pruneActivityLog(eventType, keep) {
  if (!keep || keep <= 0) return 0;
  const info = _db.prepare(
    `DELETE FROM activity_log
      WHERE event_type = @eventType
        AND id < (
          SELECT MIN(id) FROM (
            SELECT id FROM activity_log
             WHERE event_type = @eventType
             ORDER BY id DESC
             LIMIT @keep
          )
        )`
  ).run({ eventType, keep });
  return info.changes;
}

/**
 * Oldest `created_at` still held for an event type — the history horizon a
 * sweep left behind, so the report can say what survived rather than only how
 * much died.
 * @param {string} eventType - The event type to measure
 * @returns {string|null} ISO-ish SQLite timestamp, or null if the type has no rows
 */
function _oldestActivityAt(eventType) {
  const row = _db.prepare(
    'SELECT MIN(created_at) AS oldest FROM activity_log WHERE event_type = ?'
  ).get(eventType);
  return (row && row.oldest) || null;
}


/**
 * Write one activity event and trim its type to the retention cap. Throws on a
 * failed insert or prune, with `activityPhase` on the error saying which.
 *
 * This is the only insert into `activity_log`, and both `activityApi.log` and
 * `activityApi.logOrThrow` go through it, so the prune still runs after every
 * insert.
 * @param {object} event - See `activityApi.log`
 * @returns {void}
 */
function _writeActivity(event) {
  // Which step failed, for the caller. A lost event and a retention sweep
  // that has thrown on every insert for a week are different incidents, and
  // the second one means `activity_log` is unbounded again — the condition
  // this policy exists to prevent — while every surface still looks healthy.
  let phase = 'insert';
  try {
    const detail = event.detail ? JSON.stringify(event.detail) : null;
    _db.prepare(
      'INSERT INTO activity_log (project_id, session_id, event_type, detail) VALUES (?, ?, ?, ?)'
    ).run(event.projectId || null, event.sessionId || null, event.eventType, detail);
    phase = 'prune';

    const pruned = _pruneActivityLog(event.eventType, _activityLogRetention);
    // A steady-state trim removes exactly one row: the insert above put this
    // type one over its cap. More than one means a backlog converged — the cap
    // newly applied to an install with existing history, or lowered — which is
    // the only case that deletes history an operator might be looking for, and
    // so the only case worth reporting.
    //
    // That rests on an invariant worth stating, because nothing enforces it:
    // this is the ONLY insert into `activity_log`, and the prune runs after
    // every one of them. A bulk writer, backfill or migration added later would
    // make multi-row trims routine and turn this threshold back into a flood.
    // If a second writer is ever added, this moves with it.
    //
    // Reporting every trim instead makes the report the problem: at steady
    // state each churny insert would write a second row, doubling the table's
    // write rate, flooding the log with one WARN per insert, and making
    // `activity.pruned` the churniest type in the table — where it would then
    // rotate at its own cap and evict the convergence record it exists to keep.
    if (pruned > 1) {
      const retainedFrom = _oldestActivityAt(event.eventType);
      // Warned for EVERY converged type, this one included. A sweep that runs
      // unattended names what it displaced, and exempting the audit type from
      // that would make its own convergence the one deletion nothing records.
      log.warn('Retention sweep pruned activity log', {
        eventType: event.eventType, count: pruned, retainedFrom
      });
      // The durable half: recorded in the table it just pruned, so the
      // deletion outlives the process that did it. Rare by the threshold
      // above, so it never approaches its own cap.
      //
      // Only the ROW is gated, not the warning — a row inserts and would
      // re-enter this path, a warning cannot, so termination stays obvious
      // rather than merely argued while the norm above still holds.
      if (event.eventType !== ACTIVITY_PRUNE_EVENT) {
        activityApi.log({
          eventType: ACTIVITY_PRUNE_EVENT,
          detail: { prunedType: event.eventType, count: pruned, retainedFrom }
        });
      }
    }
  } catch (err) {
    err.activityPhase = phase;
    throw err;
  }
}

const activityApi = {
  /**
   * Log an activity event. Never throws — failures go to the log.
   * @param {object} event
   * @param {number} [event.projectId] - Project id
   * @param {number} [event.sessionId] - Session id
   * @param {string} event.eventType - Event type
   * @param {*} [event.detail] - Event detail (will be JSON-stringified)
   */
  log(event) {
    try {
      if (!_db) return;
      _writeActivity(event);
    } catch (err) {
      // Swallowed on purpose — activity logging must never break its caller.
      // Routed through `log.error` rather than a raw stderr write so it reaches
      // the rotating log file the operator actually greps, and carries `phase`
      // so a prune failing on every insert is distinguishable from one lost
      // event: the first means the table is growing unbounded again.
      log.error('Activity log write failed', {
        phase: err.activityPhase || 'insert', eventType: event && event.eventType, error: err.message
      });
    }
  },

  /**
   * Log an activity event, or throw. For a caller that writes the row inside
   * a transaction with something that must not exist without it: a failed
   * insert or prune, or no open database, throws, and the caller's
   * transaction rolls both back. Everything else uses `log`.
   * @param {object} event - See `log`
   * @returns {void}
   * @throws {Error} When the row could not be written
   */
  logOrThrow(event) {
    _ensureDb();
    _writeActivity(event);
  },

  /**
   * Query activity log entries.
   * @param {object} [options]
   * @param {number} [options.projectId] - Filter by project
   * @param {number} [options.sessionId] - Filter by session
   * @param {string} [options.eventType] - Filter by event type
   * @param {string} [options.since] - ISO 8601 timestamp
   * @param {number} [options.limit] - Max results (default 50)
   * @returns {object[]}
   */
  query(options = {}) {
    _ensureDb();
    const conditions = [];
    const params = [];

    if (options.projectId) {
      conditions.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.eventType) {
      conditions.push('event_type = ?');
      params.push(options.eventType);
    }
    if (options.since) {
      conditions.push('created_at > ?');
      params.push(options.since);
    }

    let sql = 'SELECT * FROM activity_log';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC';
    sql += ` LIMIT ${options.limit || 50}`;

    return _db.prepare(sql).all(...params).map(_rowToActivity);
  }
};

/**
 * Convert a SQLite activity_log row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToActivity(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    eventType: row.event_type,
    detail: _jsonParse(row.detail, null),
    createdAt: row.created_at
  };
}

module.exports = { _bind, activityApi, ACTIVITY_LOG_RETENTION, ACTIVITY_PRUNE_EVENT, _setActivityLogRetention };
