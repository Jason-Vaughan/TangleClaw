'use strict';

/**
 * The handoffs domain of the store: the publications a wrap stages and
 * publishes (`handoffsApi`), the per-project epoch that says where handoffs
 * began (`handoffEpochApi`), the reason code a boundary read reports when the
 * epoch row is missing, and the row mappers that read each back.
 *
 * The facade binds the handle with `_bind` from `init()` and unbinds it from
 * `close()`. The baseline vocabulary the epoch is written in belongs to the
 * schema, which is required here directly: the schema requires no domain
 * module, so no require cycle can hand either a half-built export.
 *
 * Everything below is moved from `lib/store.js` unchanged (#2248); what this
 * file adds is the handle, its binder and guard, and the export list.
 *
 * @module lib/store/handoffs
 */

const { StoreError, _withSavepoint } = require('./_db');
const { HANDOFF_BASELINES } = require('./_schema');

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
 * the shared guard and read a null handle. Checking here is what makes that
 * slip fail at the first use with `NOT_INITIALIZED`.
 * @returns {void}
 * @throws {StoreError} `NOT_INITIALIZED` when the facade has not bound this module.
 */
function _ensureDb() {
  if (!_db) {
    throw new StoreError('Store not initialized. Call store.init() first.', 'NOT_INITIALIZED');
  }
}

/**
 * Why a boundary read found no row at all on a store that claims to carry them.
 * Read by the launch path, never written to the table: a missing row is an
 * integrity condition to report, never a licence to take today's `MAX(id)` and
 * call the result a recovered boundary.
 */
const EPOCH_ROW_MISSING = 'epoch-row-missing';

/**
 * Shape a `handoff_publications` row for callers, who work in camelCase and
 * should never see the column names.
 * @param {object} row - Raw row
 * @returns {object} The publication
 */
function _rowToHandoffPublication(row) {
  return {
    publicationId: row.publication_id,
    seq: row.seq,
    projectId: row.project_id,
    sessionId: row.session_id,
    wrapRunId: row.wrap_run_id,
    kind: row.kind,
    state: row.state,
    fileDigest: row.file_digest,
    eligibleAt: row.eligible_at,
    eligibleVia: row.eligible_via,
    stagedAt: row.staged_at,
    publishedAt: row.published_at,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by,
    abandonedAt: row.abandoned_at,
    abandonedReason: row.abandoned_reason
  };
}

/**
 * Shape one `project_handoff_epoch` row for callers.
 * @param {object} row - The row as stored
 * @returns {{projectId: number, epochSessionId: number, baseline: string, baselineReason: string|null, recordedAt: string}}
 */
function _rowToHandoffEpoch(row) {
  return {
    projectId: row.project_id,
    epochSessionId: row.epoch_session_id,
    baseline: row.baseline,
    baselineReason: row.baseline_reason,
    recordedAt: row.recorded_at
  };
}

/**
 * `project_handoff_epoch` — where handoffs began, per project (#1586).
 *
 * There is deliberately no update or recompute here. The boundary is written
 * once, by the v41→42 migration for projects that predate it and by
 * `projects.create` for every project after, and the launch preflight only ever
 * reads it.
 */
const handoffEpochApi = {
  /**
   * One project's recorded boundary, or null when none was ever recorded.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  get(projectId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM project_handoff_epoch WHERE project_id = ?').get(projectId);
    return row ? _rowToHandoffEpoch(row) : null;
  },

  /**
   * The boundary as the launch preflight reads it, present or not.
   *
   * A missing row on a store that carries this table is an integrity condition,
   * not a blank slate — so it answers with a cutoff of 0 and an `unclean`
   * baseline, and says `present: false` so the caller can report it. Both halves
   * matter: a cutoff of 0 means no session can be "pre-epoch", and an `unclean`
   * baseline withholds the clean-legacy exception, so the pair cannot combine
   * into `legacy` or `ok` for any project that has history. That is the whole
   * point — the alternative, taking today's `MAX(id)` to fill the gap, would
   * grant exactly the legacy acceptance the missing row fails to justify.
   *
   * @param {number} projectId - Project id
   * @returns {{epochSessionId: number, baseline: string, baselineReason: string|null, present: boolean}}
   */
  readBoundary(projectId) {
    const recorded = handoffEpochApi.get(projectId);
    if (recorded) {
      return {
        epochSessionId: recorded.epochSessionId,
        baseline: recorded.baseline,
        baselineReason: recorded.baselineReason,
        present: true
      };
    }
    return {
      epochSessionId: 0,
      baseline: HANDOFF_BASELINES.UNCLEAN,
      baselineReason: EPOCH_ROW_MISSING,
      present: false
    };
  },

  /**
   * Record an empty boundary for a project that has none yet.
   *
   * Idempotent, and never overwrites: a project that already has a boundary
   * keeps it, because re-deriving one is precisely the recompute the epoch
   * exists to prevent.
   *
   * @param {number} projectId - Project id
   * @returns {object} The project's boundary, new or pre-existing
   */
  ensureEmpty(projectId) {
    _ensureDb();
    _db.prepare(
      'INSERT OR IGNORE INTO project_handoff_epoch '
      + '(project_id, epoch_session_id, baseline, baseline_reason, recorded_at) VALUES (?, 0, ?, NULL, ?)'
    ).run(projectId, HANDOFF_BASELINES.EMPTY, new Date().toISOString());
    return handoffEpochApi.get(projectId);
  }
};

/**
 * Default retention for `handoff_publications`'s historical (terminal) rows
 * per project (#1602): how many `superseded`/`abandoned` attempts survive
 * before the row — and its `history/` or `staged-` file — is pruned.
 * Overridable via {@link handoffsApi._setRetention} for deterministic tests.
 * @type {Readonly<{historical: number}>}
 */
const HANDOFF_PUBLICATION_RETENTION = Object.freeze({ historical: 50 });

/** The retention currently in force; see {@link handoffsApi._setRetention}. */
let _retention = HANDOFF_PUBLICATION_RETENTION;

/**
 * Prune one project's historical (`superseded` or `abandoned`)
 * `handoff_publications` rows down to the current retention (#1602), ranked
 * `seq DESC` (newest first). Restricting candidates to those two states makes
 * the issue's two hard exemptions structural rather than separate checks: a
 * `staged` row (still reconciliation input for #1586, eligible or not) and
 * the one `published` row a project ever has are never candidates at all.
 *
 * A candidate whose `session_id` names a still-ACTIVE session is exempt too
 * — a crashed session's own history is left for its own reconciliation pass,
 * mirroring the exemption `_pruneLaunchSequences` (#1595) and
 * `_sweepEndedSessionMedusaDeliveries` (#1331) both apply. The literal
 * `'active'` is used rather than importing `SESSION_STATUS` from
 * `./sessions`: that module already `require('./handoffs')` for
 * `handoffsApi` (see its own module doc), so requiring it back here would
 * complete a cycle — at the point `sessions.js` first reaches that require,
 * its own exports have not run yet, and the back-require would see nothing.
 * The literal matches `SESSION_STATUS.ACTIVE`'s known value.
 *
 * Runs inside its own `SAVEPOINT` (not a `BEGIN`, matching
 * `_pruneMedusaDeliveries`'s caller, #1331) so it is safe to call whether or
 * not the caller already holds a transaction. Returns the pruned ids rather
 * than touching any file: this module does no filesystem I/O, so retiring
 * each id's `history/`/`staged-` bytes is the caller's job.
 *
 * @param {number} projectId - The project to sweep
 * @param {object} [opts] - Overrides `_retention` for this call only
 * @param {number} [opts.historical] - Row survival ceiling
 * @returns {string[]} The publication ids pruned
 */
function _pruneHandoffPublications(projectId, opts) {
  const retention = opts ? { ..._retention, ...opts } : _retention;
  const notExempt = "NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = hp.session_id AND s.status = 'active')";
  return _withSavepoint(() => {
    const toDelete = _db.prepare(
      `WITH ranked AS (
         SELECT hp.publication_id AS id, ROW_NUMBER() OVER (ORDER BY hp.seq DESC) AS rnk
           FROM handoff_publications hp
          WHERE hp.project_id = ? AND hp.state IN ('superseded', 'abandoned') AND ${notExempt}
       )
       SELECT id FROM ranked WHERE rnk > ?`
    ).all(projectId, retention.historical).map((r) => r.id);
    if (toDelete.length > 0) {
      const placeholders = toDelete.map(() => '?').join(',');
      _db.prepare(`DELETE FROM handoff_publications WHERE publication_id IN (${placeholders})`).run(...toDelete);
    }
    return toDelete;
  });
}

/**
 * Handoff publications (Train 21, #1585).
 *
 * The DB half of the handoff. Every guarantee here is about ONE attempt named
 * by its `publicationId`, so a late completion can only ever touch its own
 * attempt — never a neighbouring one that happens to share a session.
 *
 * `eligible_at` is the load-bearing column: it is the attempt-exact proof that
 * this attempt completed, written only by `bindLifecycleEligibility` (inside
 * the lifecycle transition) or `markCheckpointComplete`. Nothing infers it from
 * session status, because a failed attempt must never borrow a later attempt's
 * success.
 */
const handoffsApi = {
  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction and return its result.
   * Publishing reads several rows and the filesystem's answer as one decision;
   * this is what keeps two finalizers from both deciding they are newest.
   * @param {() => *} fn - Synchronous work
   * @returns {*} Whatever `fn` returns
   */
  transaction(fn) {
    _ensureDb();
    _db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      _db.exec('COMMIT');
      return out;
    } catch (err) {
      try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
  },

  /**
   * One publication by id.
   * @param {string} publicationId - Publication id
   * @returns {object|null} Null when no such attempt was ever staged
   */
  get(publicationId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM handoff_publications WHERE publication_id = ?').get(publicationId);
    return row ? _rowToHandoffPublication(row) : null;
  },

  /**
   * The attempt staged by a given wrap run, if any.
   *
   * This is what makes a replayed stage idempotent WITHIN one run: the unique
   * `(session_id, wrap_run_id)` means a second stage for the same run finds the
   * first rather than minting a second id for one attempt.
   * @param {number} sessionId - Session id
   * @param {string} wrapRunId - Wrap run id
   * @returns {object|null}
   */
  getByRun(sessionId, wrapRunId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM handoff_publications WHERE session_id = ? AND wrap_run_id = ?'
    ).get(sessionId, wrapRunId);
    return row ? _rowToHandoffPublication(row) : null;
  },

  /**
   * A session's attempts whose run id starts with a prefix, oldest first. A
   * producer that names its runs by prefix uses this to find its own attempts
   * for one session: governed finalization (#2027) finds the attempt its
   * lifecycle transition bound, to finish it on a repeat, and abandons any
   * attempt that never became eligible before staging a new one.
   * @param {number} sessionId - Session id
   * @param {string} runPrefix - Run id prefix, e.g. `finalize-`
   * @returns {object[]}
   */
  listBySessionRunPrefix(sessionId, runPrefix) {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM handoff_publications WHERE session_id = ? AND substr(wrap_run_id, 1, length(?)) = ? ORDER BY seq"
    ).all(sessionId, runPrefix, runPrefix).map(_rowToHandoffPublication);
  },

  /**
   * The currently published publication for a project, if there is one.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  getPublished(projectId) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM handoff_publications WHERE project_id = ? AND state = 'published' ORDER BY seq DESC LIMIT 1"
    ).get(projectId);
    return row ? _rowToHandoffPublication(row) : null;
  },

  /**
   * Every publication for a project, newest attempt first.
   * @param {number} projectId - Project id
   * @param {number} [limit] - Cap on rows returned
   * @returns {object[]}
   */
  listByProject(projectId, limit = 20) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM handoff_publications WHERE project_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(projectId, limit).map(_rowToHandoffPublication);
  },

  /**
   * A session's handoff attempts that are still `staged`: written by a wrap or
   * checkpoint run and neither published, superseded nor abandoned.
   * @param {number} sessionId - Session id
   * @returns {object[]} Newest attempt first
   */
  listStagedForSession(sessionId) {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM handoff_publications WHERE session_id = ? AND state = 'staged' ORDER BY seq DESC"
    ).all(sessionId).map(_rowToHandoffPublication);
  },

  /**
   * Stage an attempt, or return the one this run already staged.
   *
   * `seq` is allocated here as `MAX(seq) + 1`. It orders attempts across the
   * install, which is what lets finalize ask "is any NEWER publication already
   * published" — a question that has no answer without a total order.
   *
   * @param {object} attempt - The attempt being staged
   * @param {string} attempt.publicationId - From `newPublicationId`
   * @param {number} attempt.projectId - Logical project ref
   * @param {number} attempt.sessionId - Producing session
   * @param {string} attempt.wrapRunId - The wrap run staging this attempt
   * @param {string} attempt.kind - 'final' | 'checkpoint'
   * @param {string} attempt.fileDigest - sha256 of the staged bytes
   * @param {string} attempt.stagedAt - ISO timestamp
   * @returns {{publication: object, replayed: boolean}} `replayed` is true when
   *   this run had already staged an attempt and nothing was written.
   */
  stage(attempt) {
    _ensureDb();
    const existing = this.getByRun(attempt.sessionId, attempt.wrapRunId);
    if (existing) return { publication: existing, replayed: true };

    const nextSeq = (_db.prepare('SELECT MAX(seq) AS m FROM handoff_publications').get().m || 0) + 1;
    _db.prepare(`
      INSERT INTO handoff_publications
        (publication_id, seq, project_id, session_id, wrap_run_id, kind, state, file_digest, staged_at)
      VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?)
    `).run(
      attempt.publicationId, nextSeq, attempt.projectId, attempt.sessionId,
      attempt.wrapRunId, attempt.kind, attempt.fileDigest, attempt.stagedAt
    );
    return { publication: this.get(attempt.publicationId), replayed: false };
  },

  /**
   * Bind eligibility for a FINAL attempt. Call this only from inside the
   * lifecycle transition, so the `active → wrapped` UPDATE and this write
   * commit or fail together (plan §2.6 step 2).
   *
   * Returns false rather than throwing when the row does not match: the wrap
   * itself still completed, and the caller reports `publicationBound: false`
   * and abandons the attempt. A throw here would roll back a lifecycle
   * transition that was legitimate.
   *
   * @param {string} publicationId - The attempt to bind
   * @param {number} sessionId - The session whose lifecycle just completed
   * @param {string} wrapRunId - The run that staged the attempt
   * @param {string} at - ISO timestamp
   * @returns {boolean} True when this exact attempt was bound
   */
  bindLifecycleEligibility(publicationId, sessionId, wrapRunId, at) {
    _ensureDb();
    const changes = _db.prepare(`
      UPDATE handoff_publications
         SET eligible_at = ?, eligible_via = 'lifecycle-wrap'
       WHERE publication_id = ?
         AND session_id = ? AND wrap_run_id = ?
         AND kind = 'final' AND state = 'staged' AND eligible_at IS NULL
    `).run(at, publicationId, sessionId, wrapRunId).changes;
    return changes === 1;
  },

  /**
   * Bind eligibility for a CHECKPOINT attempt. There is no lifecycle
   * transition for a kept session, so this single write is the proof the
   * attempt completed. A crash before it leaves the attempt unbound, which
   * preflight reports as `unfinished` rather than repairing.
   * @param {string} publicationId - The attempt to bind
   * @param {string} wrapRunId - The run that staged it
   * @param {string} at - ISO timestamp
   * @returns {boolean} True when this exact attempt was bound
   */
  markCheckpointComplete(publicationId, wrapRunId, at) {
    _ensureDb();
    const changes = _db.prepare(`
      UPDATE handoff_publications
         SET eligible_at = ?, eligible_via = 'checkpoint-complete'
       WHERE publication_id = ? AND wrap_run_id = ?
         AND kind = 'checkpoint' AND state = 'staged' AND eligible_at IS NULL
    `).run(at, publicationId, wrapRunId).changes;
    return changes === 1;
  },

  /**
   * Is any publication NEWER than this one already published for the project?
   *
   * Finalize asks this so an older attempt can never overwrite a newer one's
   * `current.json`. Answering it needs the total order `seq` provides.
   * @param {number} projectId - Project id
   * @param {number} seq - The attempt's own seq
   * @returns {object|null} The newer published publication, or null
   */
  newerPublished(projectId, seq) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM handoff_publications WHERE project_id = ? AND state = 'published' AND seq > ? ORDER BY seq DESC LIMIT 1"
    ).get(projectId, seq);
    return row ? _rowToHandoffPublication(row) : null;
  },

  /**
   * Mark this attempt published and the one it replaces superseded.
   *
   * Call inside `transaction`, AFTER the file rename has succeeded — the rename
   * is what makes `current.json` these bytes, and this write is the record that
   * it happened. Splitting them is unavoidable (a filesystem rename cannot join
   * a SQL transaction), which is exactly why reconciliation exists and why an
   * atomic rename is never on its own trusted to prove the DB was updated.
   * @param {string} publicationId - The attempt now current
   * @param {string|null} supersededId - The publication it replaced, if any
   * @param {string} at - ISO timestamp
   * @returns {void}
   */
  recordPublished(publicationId, supersededId, at) {
    _ensureDb();
    if (supersededId) {
      _db.prepare(`
        UPDATE handoff_publications
           SET state = 'superseded', superseded_at = ?, superseded_by = ?
         WHERE publication_id = ? AND state = 'published'
      `).run(at, publicationId, supersededId);
    }
    _db.prepare(`
      UPDATE handoff_publications SET state = 'published', published_at = ?
       WHERE publication_id = ? AND state = 'staged'
    `).run(at, publicationId);
  },

  /**
   * Supersede an ELIGIBLE attempt that lost to a newer published one.
   *
   * Deliberately not `abandon`: the attempt did complete, and its
   * `eligible_at` is preserved so the record still says so. No file moves and
   * `current.json` is untouched — an older attempt never overwrites a newer.
   * @param {string} publicationId - The losing attempt
   * @param {string} supersededBy - The publication that won
   * @param {string} at - ISO timestamp
   * @returns {boolean} True when the row moved
   */
  supersedeBeforePublish(publicationId, supersededBy, at) {
    _ensureDb();
    return _db.prepare(`
      UPDATE handoff_publications
         SET state = 'superseded', superseded_at = ?, superseded_by = ?
       WHERE publication_id = ? AND state = 'staged' AND eligible_at IS NOT NULL
    `).run(at, supersededBy, publicationId).changes === 1;
  },

  /**
   * Abandon a staged attempt that never became eligible.
   *
   * Only ever from `staged` with a NULL `eligible_at`: an attempt that
   * completed is superseded instead, never abandoned. The staged file is left
   * on disk for forensics.
   * @param {string} publicationId - The attempt to abandon
   * @param {string} reason - Why, in a few words
   * @param {string} at - ISO timestamp
   * @returns {boolean} True when the row moved
   */
  abandon(publicationId, reason, at) {
    _ensureDb();
    return _db.prepare(`
      UPDATE handoff_publications
         SET state = 'abandoned', abandoned_at = ?, abandoned_reason = ?
       WHERE publication_id = ? AND state = 'staged' AND eligible_at IS NULL
    `).run(at, reason, publicationId).changes === 1;
  },

  /**
   * Every publication id for a project, any state, no limit (#1602).
   *
   * Used only by the retention sweep's orphan check: it needs the FULL live
   * set to tell a `history/`/`staged-` file with no matching row (drift from
   * a prior partial or crashed prune) apart from one that is merely old.
   * @param {number} projectId - Project id
   * @returns {string[]}
   */
  allIdsForProject(projectId) {
    _ensureDb();
    return _db.prepare('SELECT publication_id FROM handoff_publications WHERE project_id = ?')
      .all(projectId).map((r) => r.publication_id);
  },

  /**
   * Prune this project's historical publications down to retention, and
   * report which ids were removed so the caller can retire their files too
   * (#1602). See {@link _pruneHandoffPublications}.
   * @param {number} projectId - Project id
   * @param {object} [opts] - See {@link _pruneHandoffPublications}
   * @returns {string[]} Publication ids pruned
   */
  prune(projectId, opts) {
    _ensureDb();
    return _pruneHandoffPublications(projectId, opts);
  },

  /**
   * Override the retention {@link _pruneHandoffPublications} enforces, for
   * deterministic tests. No args restores {@link HANDOFF_PUBLICATION_RETENTION}.
   * @param {{historical: number}} [overrides]
   * @returns {void}
   */
  _setRetention(overrides) {
    _retention = overrides ? Object.freeze({ ...HANDOFF_PUBLICATION_RETENTION, ...overrides }) : HANDOFF_PUBLICATION_RETENTION;
  }
};

module.exports = {
  _bind,
  EPOCH_ROW_MISSING,
  HANDOFF_PUBLICATION_RETENTION,
  handoffEpochApi,
  handoffsApi
};
