'use strict';

/**
 * The launch domain of the store: the launch sequences a session is served
 * at start (`launchSequencesApi`, the step ids, the insert that binds a
 * sequence to its session inside the session's own transaction), the
 * project's recovery state and the once-only inherited-mode notice
 * (`projectRecoveryStateApi`), and the recovery clearances with their batches
 * (`recoveryClearancesApi`, `recoveryClearBatchesApi`), with the row mappers
 * that read each back.
 *
 * The facade binds this module from `init()` and unbinds it from `close()`.
 * Two readers here filter on the sessions vocabulary (`SESSION_STATUS`), and
 * the sessions domain requires this one for the insert its `start()` runs, so
 * the constant arrives beside the handle through `_bind`, the way the schema
 * receives the same constant: neither module requires the other, and no
 * require cycle can hand either a half-built export.
 *
 * Everything below is moved from `lib/store.js` unchanged (#2248); what this
 * file adds is the handle, its binder and guard, and the export list.
 *
 * @module lib/store/launch
 */

const { StoreError, _jsonParse } = require('./_db');

let _db = null;
/** The sessions vocabulary, bound beside the handle; see `_bind`. */
let SESSION_STATUS = null;

/**
 * Bind the database handle the facade opened, with the sessions vocabulary
 * this domain filters on, or unbind both with `null`.
 * @param {{db: import('node:sqlite').DatabaseSync, SESSION_STATUS: object}|null} binding -
 *   The open database and the vocabulary, or null on close.
 * @returns {void}
 */
function _bind(binding) {
  _db = binding ? binding.db : null;
  SESSION_STATUS = binding ? binding.SESSION_STATUS : null;
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

// ── Launch sequences (Train 21) ──

/**
 * The step ids a launch sequence serves, in order. Pinned here because the
 * CHECK on `launch_sequence_steps.step_id` rejects anything else.
 * @type {string[]}
 */
const LAUNCH_STEP_IDS = ['identity', 'governance', 'state', 'task'];

/**
 * Insert a sequence row and its frozen steps. The caller holds the transaction.
 *
 * An applicable sequence carries exactly the four steps; a not-applicable one
 * carries none and must say why. Both are checked here rather than left to a
 * later reader, because a sequence missing a step would stall at that cursor
 * with nothing to serve.
 * @param {number} sessionId - The session being bound
 * @param {number} projectId - Its project
 * @param {string} engineId - The engine the session runs
 * @param {object} seq - `{launchId, pageBudget, applicability, notApplicableReason, preflight, recovery, recoveryMode, sourceManifest, steps}`,
 *   and optionally `claimInheritedNotice: true` to claim the project's once-only notice in this transaction
 * @returns {number} The new sequence id
 */
function _insertLaunchSequence(sessionId, projectId, engineId, seq) {
  const steps = Array.isArray(seq.steps) ? seq.steps : [];
  if (seq.applicability === 'applicable') {
    const ids = steps.map((st) => st.id).join(',');
    if (ids !== LAUNCH_STEP_IDS.join(',')) {
      throw new StoreError(`An applicable launch sequence needs the steps ${LAUNCH_STEP_IDS.join(', ')} in order; got "${ids}"`, 'BAD_REQUEST');
    }
  } else if (steps.length > 0) {
    throw new StoreError('A not-applicable launch sequence carries no steps', 'BAD_REQUEST');
  }
  // The once-only inherited-mode notice (#1937), claimed inside the caller's
  // transaction so the marker and the launch it names land or fail together:
  // a launch whose insert rolls back leaves the marker unset and the next
  // launch carries the notice. Only when the launch SAID it resolved the
  // inherited mode; every other launch leaves the marker alone.
  if (seq.claimInheritedNotice === true) _claimInheritedNotice(projectId, seq.launchId);
  // Recovery is decided once, here, from what the preflight found — never
  // recomputed later from the stored verdict. `requiresRecovery` is not a
  // function of the verdict word (`lib/sessions.js#_storedPreflight` says why),
  // so a reader that re-derived it would answer `false` for exactly the case
  // nobody measured. The column defaults cover a caller that passes neither,
  // and they default to the blocking side of the mode and the quiet side of the
  // state: no recovery asked for, and `operator` if one ever is.
  _db.prepare(
    `INSERT INTO launch_sequences (launch_id, session_id, project_id, engine_id, page_budget,
       applicability, not_applicable_reason, preflight, source_manifest, recovery, recovery_mode, startup_delivery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seq.launchId,
    sessionId,
    projectId,
    engineId,
    seq.pageBudget,
    seq.applicability,
    seq.notApplicableReason || null,
    JSON.stringify(seq.preflight),
    JSON.stringify(seq.sourceManifest),
    seq.recovery === 'required' ? 'required' : 'none',
    // Advisory only when the launch SAID so. A caller that names no mode gets
    // the blocking side; the default a launch resolves is decided before this,
    // in `lib/sessions.js`, and arrives here as an explicit value.
    seq.recoveryMode === 'advisory' ? 'advisory' : 'operator',
    // Native only when the launch SAID so; anything else, including a caller
    // that predates the field, is the keystroke path it always was.
    seq.startupDelivery === 'native' ? 'native' : 'legacy'
  );
  const sequenceId = _db.prepare('SELECT id FROM launch_sequences WHERE launch_id = ?').get(seq.launchId).id;
  const insertStep = _db.prepare(
    `INSERT INTO launch_sequence_steps (sequence_id, revision, step_index, step_id, content, digest, page_count, page_offsets)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
  );
  steps.forEach((st, index) => {
    insertStep.run(sequenceId, index, st.id, st.content, st.digest, st.pageOffsets.length, JSON.stringify(st.pageOffsets));
  });
  return sequenceId;
}

/**
 * Claim the once-only inherited-mode notice for a project (#1937).
 *
 * One statement, so there is no gap between "is there a row" and "claim it":
 * it inserts the project's row with the marker set, and on a row that already
 * exists it sets the marker only where it is still NULL. The pin columns are
 * not named in either arm, so a claim never changes an operator's decision.
 * @param {number} projectId - The project
 * @param {string} launchId - The launch that carries the notice
 * @returns {boolean} True when THIS call claimed it; false when an earlier launch already had
 */
function _claimInheritedNotice(projectId, launchId) {
  const result = _db.prepare(
    `INSERT INTO project_recovery_state (project_id, inherited_notice_at, inherited_notice_launch_id)
     VALUES (?, datetime('now'), ?)
     ON CONFLICT(project_id) DO UPDATE
       SET inherited_notice_at = excluded.inherited_notice_at,
           inherited_notice_launch_id = excluded.inherited_notice_launch_id
       WHERE project_recovery_state.inherited_notice_at IS NULL`
  ).run(projectId, launchId);
  return Number(result.changes) === 1;
}

/**
 * Map a `project_recovery_state` row to its camelCase shape.
 * @param {object|undefined} row - Raw SQLite row
 * @returns {{projectId: number, pinnedMode: ('operator'|null), pinnedAt: (string|null), pinnedBy: (string|null), inheritedNoticeAt: (string|null), inheritedNoticeLaunchId: (string|null)}|null}
 */
function _rowToProjectRecoveryState(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    pinnedMode: row.pinned_mode || null,
    pinnedAt: row.pinned_at || null,
    pinnedBy: row.pinned_by || null,
    inheritedNoticeAt: row.inherited_notice_at || null,
    inheritedNoticeLaunchId: row.inherited_notice_launch_id || null
  };
}

/**
 * Per-project recovery state (#1937): the operator's recovery-mode decision
 * and the once-only inherited-mode notice marker.
 *
 * Rows are written by exactly two events and deleted only with their project.
 * `recordDecision` writes the pin columns and never the marker; the notice
 * claim writes the marker and never the pin columns.
 */
const projectRecoveryStateApi = {
  /**
   * The project's recovery state row.
   * @param {number} projectId - The project
   * @returns {object|null} Null when nothing has been recorded for it. A row is
   *   not a pin: read `pinnedMode` and `pinnedAt`.
   */
  get(projectId) {
    _ensureDb();
    return _rowToProjectRecoveryState(
      _db.prepare('SELECT * FROM project_recovery_state WHERE project_id = ?').get(projectId)
    );
  },

  /**
   * Record the operator's decision of a project's recovery mode.
   *
   * `operator` sets the pin. `advisory` clears it and still stamps the
   * decision, creating the row when there is none: the operator choosing
   * advisory is a decision on record, which is what later tells it apart from
   * a mode nobody chose. Neither arm names the notice columns.
   * @param {number} projectId - The project
   * @param {'operator'|'advisory'} mode - The mode the operator chose
   * @param {string} decidedBy - The proof the decision was taken on, as the route recorded it
   *   (`operator-verified` or `open-install-unverified`); stored as given
   * @returns {object} The row as stored
   * @throws {StoreError} When the mode is not one of the two, or no proof word is given
   */
  recordDecision(projectId, mode, decidedBy) {
    _ensureDb();
    if (mode !== 'operator' && mode !== 'advisory') {
      throw new StoreError(`A recovery-mode decision is operator or advisory; got ${JSON.stringify(mode)}`, 'BAD_REQUEST');
    }
    if (typeof decidedBy !== 'string' || decidedBy === '') {
      throw new StoreError('A recovery-mode decision records who made it', 'BAD_REQUEST');
    }
    _db.prepare(
      `INSERT INTO project_recovery_state (project_id, pinned_mode, pinned_at, pinned_by)
       VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(project_id) DO UPDATE
         SET pinned_mode = excluded.pinned_mode,
             pinned_at = excluded.pinned_at,
             pinned_by = excluded.pinned_by`
    ).run(projectId, mode === 'operator' ? 'operator' : null, decidedBy);
    return projectRecoveryStateApi.get(projectId);
  },

  /**
   * Claim the once-only inherited-mode notice outside a launch insert. The
   * launch path claims through `sessions.start`, in the launch's own
   * transaction; this is the same statement for a caller that holds none.
   * @param {number} projectId - The project
   * @param {string} launchId - The launch that carries the notice
   * @returns {boolean} True when this call claimed it
   */
  claimInheritedNotice(projectId, launchId) {
    _ensureDb();
    return _claimInheritedNotice(projectId, launchId);
  }
};

/**
 * Map a `launch_sequences` row to its camelCase shape.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToLaunchSequence(row) {
  return {
    id: row.id,
    launchId: row.launch_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    engineId: row.engine_id,
    revision: row.revision,
    cursor: row.cursor,
    pageBudget: row.page_budget,
    applicability: row.applicability,
    notApplicableReason: row.not_applicable_reason,
    preflight: _jsonParse(row.preflight, null),
    sourceManifest: _jsonParse(row.source_manifest, null),
    readyAt: row.ready_at,
    readyArtifact: _jsonParse(row.ready_artifact, null),
    readyDigest: row.ready_digest,
    unreadyAt: row.unready_at,
    nudgeCount: row.nudge_count,
    lastNudgedAt: row.last_nudged_at,
    recovery: row.recovery,
    recoveryMode: row.recovery_mode,
    recoveryRevision: row.recovery_revision,
    recoveryClearedAt: row.recovery_cleared_at,
    recoveryClearedBy: row.recovery_cleared_by,
    recoveryClearance: row.recovery_clearance,
    startupDelivery: row.startup_delivery === 'native' ? 'native' : 'legacy',
    createdAt: row.created_at
  };
}

/**
 * Map a `launch_sequence_steps` row to its camelCase shape.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToLaunchStep(row) {
  return {
    sequenceId: row.sequence_id,
    revision: row.revision,
    index: row.step_index,
    id: row.step_id,
    content: row.content,
    digest: row.digest,
    pageCount: row.page_count,
    pageOffsets: _jsonParse(row.page_offsets, []),
    carriedFromRevision: row.carried_from_revision,
    pagesServed: _jsonParse(row.pages_served, []),
    servedAt: row.served_at,
    ackedAt: row.acked_at
  };
}

/**
 * Map a `launch_recovery_clearances` row to its camelCase shape.
 * @param {object} row - Raw SQLite row
 * @returns {object} `preflight` is the record as stored, or null when it cannot be parsed
 */
function _rowToRecoveryClearance(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    sequenceId: row.sequence_id,
    recoveryRevision: row.recovery_revision,
    clearance: row.clearance,
    clearedBy: row.cleared_by,
    preflight: _jsonParse(row.preflight, null),
    clearedAt: row.cleared_at
  };
}

/**
 * Reads of the operator clearance record. There is no writer here: a row is
 * written only by `launchSequences.clearRecoveryAsOperator`, in the transaction
 * that clears the launch.
 */
const recoveryClearancesApi = {
  /**
   * The clearance recorded for one launch.
   * @param {number} sequenceId - Launch sequence id
   * @returns {object|null} The clearance, or null when no operator cleared this launch
   */
  getForSequence(sequenceId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM launch_recovery_clearances WHERE sequence_id = ?').get(sequenceId);
    return row ? _rowToRecoveryClearance(row) : null;
  },

  /**
   * Every clearance made under one batch.
   * @param {string} batchId - Batch id
   * @returns {object[]} In the order they were written
   */
  listForBatch(batchId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM launch_recovery_clearances WHERE batch_id = ? ORDER BY id ASC')
      .all(batchId).map(_rowToRecoveryClearance);
  }
};

/**
 * Map a `launch_recovery_clear_batches` row to its camelCase shape.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToRecoveryClearBatch(row) {
  return {
    batchId: row.batch_id,
    requestedBy: row.requested_by,
    itemCount: row.item_count,
    requestedAt: row.requested_at
  };
}

/**
 * Map a `launch_recovery_clear_batch_items` row to its camelCase shape.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToRecoveryClearBatchItem(row) {
  return {
    batchId: row.batch_id,
    itemIndex: row.item_index,
    projectId: row.project_id,
    sessionId: row.session_id,
    sequenceId: row.sequence_id,
    recoveryRevision: row.recovery_revision,
    outcome: row.outcome,
    recordedAt: row.recorded_at
  };
}

/**
 * Insert one item outcome of a batch recovery clear. Shared by the writer for
 * a refused item and by the clear itself, which records `cleared` inside its
 * own transaction.
 * @param {object} item - `{batchId, itemIndex, projectId, sessionId, sequenceId, recoveryRevision, outcome}`
 * @returns {void}
 * @throws {Error} When the batch has no header, the item index is taken, or the outcome is not a known word.
 */
function _insertRecoveryClearBatchItem({ batchId, itemIndex, projectId, sessionId, sequenceId, recoveryRevision, outcome }) {
  _db.prepare(
    `INSERT INTO launch_recovery_clear_batch_items
       (batch_id, item_index, project_id, session_id, sequence_id, recovery_revision, outcome, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(batchId, itemIndex, projectId, sessionId, sequenceId, recoveryRevision, outcome);
}

/**
 * The record of each batch recovery clear: its header, and what happened to
 * every item in it. Append-only; nothing here updates or deletes.
 */
const recoveryClearBatchesApi = {
  /**
   * Record that an operator sent a batch, before any of its items is decided.
   * @param {object} args
   * @param {string} args.batchId - The batch's id, 1 to 64 characters
   * @param {string} args.requestedBy - The signed-in operator
   * @param {number} args.itemCount - How many items the request named
   * @returns {object} The header as stored
   * @throws {Error} When the header cannot be written.
   */
  create({ batchId, requestedBy, itemCount }) {
    _ensureDb();
    _db.prepare(
      `INSERT INTO launch_recovery_clear_batches (batch_id, requested_by, item_count, requested_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run(batchId, requestedBy, itemCount);
    return this.get(batchId);
  },

  /**
   * One batch's header.
   * @param {string} batchId - Batch id
   * @returns {object|null}
   */
  get(batchId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM launch_recovery_clear_batches WHERE batch_id = ?').get(batchId);
    return row ? _rowToRecoveryClearBatch(row) : null;
  },

  /**
   * Record what happened to an item that was not cleared. A cleared item is
   * recorded by `launchSequences.clearRecoveryAsOperator`, with the clear, and
   * is refused here so that `cleared` can never be written without one.
   * @param {object} item
   * @param {string} item.batchId - The batch
   * @param {number} item.itemIndex - The item's position in the request, from 0
   * @param {number} item.projectId - As the request named it
   * @param {number} item.sessionId - As the request named it
   * @param {number} item.sequenceId - As the request named it
   * @param {number} item.recoveryRevision - As the request named it
   * @param {string} item.outcome - One of `RECOVERY_BATCH_OUTCOMES` other than `cleared`
   * @returns {void}
   * @throws {Error} When the outcome is `cleared`, or the row cannot be written.
   */
  recordItem(item) {
    _ensureDb();
    if (item.outcome === 'cleared') {
      throw new Error('A cleared batch item is recorded with its clear, by clearRecoveryAsOperator.');
    }
    _insertRecoveryClearBatchItem(item);
  },

  /**
   * One item of a batch, by its position in the request.
   * @param {string} batchId - Batch id
   * @param {number} itemIndex - The item's position, from 0
   * @returns {object|null} Null when no outcome was recorded for it
   */
  getItem(batchId, itemIndex) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM launch_recovery_clear_batch_items WHERE batch_id = ? AND item_index = ?'
    ).get(batchId, itemIndex);
    return row ? _rowToRecoveryClearBatchItem(row) : null;
  },

  /**
   * Every recorded item of a batch, in request order.
   * @param {string} batchId - Batch id
   * @returns {object[]}
   */
  listItems(batchId) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM launch_recovery_clear_batch_items WHERE batch_id = ? ORDER BY item_index ASC'
    ).all(batchId).map(_rowToRecoveryClearBatchItem);
  }
};

/**
 * The compare-and-set that clears a required recovery. Private to this file on
 * purpose: the two public clears below are the only ways in, and each admits
 * only the clearance words it can account for, so a launch cannot be marked
 * as cleared by an operator without the record of that clearance.
 *
 * Nothing changes unless the row is still `required` at this `sessionId` and
 * `recoveryRevision`. That binding is the whole guard: a clear granted against
 * one launch, or against a revision whose step 3 has since been replaced, must
 * not silently apply to a newer one, because the clearer decided about a
 * verdict they were shown and not about whatever the row says now.
 * @param {number} sequenceId - Sequence id
 * @param {object} args - `{sessionId, recoveryRevision, clearance, clearedBy}`
 * @returns {object|null} The cleared sequence, or null when the binding did not match
 */
function _clearRecoveryCas(sequenceId, { sessionId, recoveryRevision, clearance, clearedBy }) {
  const written = _db.prepare(
    `UPDATE launch_sequences
        SET recovery = 'cleared', recovery_cleared_at = datetime('now'),
            recovery_cleared_by = ?, recovery_clearance = ?
      WHERE id = ? AND session_id = ? AND recovery_revision = ? AND recovery = 'required'`
  ).run(clearedBy, clearance, sequenceId, sessionId, recoveryRevision);
  if (written.changes === 0) return null;
  return _rowToLaunchSequence(_db.prepare('SELECT * FROM launch_sequences WHERE id = ?').get(sequenceId));
}

const OPERATOR_RECOVERY_CLEARANCES = Object.freeze(['operator-verified', 'open-install-unverified']);

const launchSequencesApi = {
  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction and return its result.
   * The ack protocol reads and writes a sequence as one decision; this is what
   * keeps two identical acks from both advancing the cursor.
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
   * The sequence a launch id is bound to.
   * @param {string} launchId - From the pane's TANGLECLAW_LAUNCH_ID
   * @returns {object|null} Null when no session row carries this launch id (yet)
   */
  getByLaunchId(launchId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM launch_sequences WHERE launch_id = ?').get(launchId);
    return row ? _rowToLaunchSequence(row) : null;
  },

  /**
   * The sequence bound to a session.
   * @param {number} sessionId - Session id
   * @returns {object|null}
   */
  getBySession(sessionId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM launch_sequences WHERE session_id = ?').get(sessionId);
    return row ? _rowToLaunchSequence(row) : null;
  },

  /**
   * The steps of one revision of a sequence, in serving order.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - Snapshot revision
   * @returns {object[]}
   */
  listSteps(sequenceId, revision) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM launch_sequence_steps WHERE sequence_id = ? AND revision = ? ORDER BY step_index'
    ).all(sequenceId, revision).map(_rowToLaunchStep);
  },

  /**
   * Record that a page was served. Serving is idempotent: a page already in
   * the set is not added twice, and `served_at` keeps its first value. This
   * records what was SENT, never what was received — only an ack says that.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - Snapshot revision
   * @param {number} stepIndex - 0–3
   * @param {number} page - Page index
   * @returns {object|null} The updated step
   */
  markPageServed(sequenceId, revision, stepIndex, page) {
    _ensureDb();
    const key = [sequenceId, revision, stepIndex];
    const row = _db.prepare(
      'SELECT pages_served FROM launch_sequence_steps WHERE sequence_id = ? AND revision = ? AND step_index = ?'
    ).get(...key);
    if (!row) return null;
    const served = new Set(_jsonParse(row.pages_served, []));
    served.add(page);
    _db.prepare(
      `UPDATE launch_sequence_steps
          SET pages_served = ?, served_at = COALESCE(served_at, datetime('now'))
        WHERE sequence_id = ? AND revision = ? AND step_index = ?`
    ).run(JSON.stringify([...served].sort((a, b) => a - b)), ...key);
    const updated = _db.prepare(
      'SELECT * FROM launch_sequence_steps WHERE sequence_id = ? AND revision = ? AND step_index = ?'
    ).get(...key);
    return _rowToLaunchStep(updated);
  },

  /**
   * Acknowledge the cursor step and advance the cursor past it, as one
   * compare-and-set: nothing changes unless the step is unacked and the cursor
   * is still on it at this revision.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - Snapshot revision
   * @param {number} stepIndex - The step being acknowledged
   * @returns {boolean} Whether this call advanced the cursor
   */
  ackStep(sequenceId, revision, stepIndex) {
    _ensureDb();
    const moved = _db.prepare(
      'UPDATE launch_sequences SET cursor = ? WHERE id = ? AND revision = ? AND cursor = ?'
    ).run(stepIndex + 1, sequenceId, revision, stepIndex);
    if (moved.changes === 0) return false;
    _db.prepare(
      `UPDATE launch_sequence_steps SET acked_at = datetime('now')
        WHERE sequence_id = ? AND revision = ? AND step_index = ? AND acked_at IS NULL`
    ).run(sequenceId, revision, stepIndex);
    return true;
  },

  /**
   * Record an accepted READY attestation, as one compare-and-set.
   *
   * Nothing changes unless the sequence is still unready at this revision, so
   * two callers racing the same artifact cannot both write one — the second
   * reads the stored digest and answers idempotently or as a conflict. The
   * caller holds the transaction and has already validated the artifact.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - The revision the artifact was accepted at
   * @param {object} artifact - The canonical `tc.ready/1` artifact as accepted
   * @param {string} digest - sha256 of the canonical artifact
   * @returns {boolean} Whether this call recorded the attestation
   */
  markReady(sequenceId, revision, artifact, digest) {
    _ensureDb();
    const written = _db.prepare(
      `UPDATE launch_sequences SET ready_at = datetime('now'), ready_artifact = ?, ready_digest = ?
        WHERE id = ? AND revision = ? AND ready_at IS NULL`
    ).run(JSON.stringify(artifact), digest, sequenceId, revision);
    return written.changes > 0;
  },

  /**
   * Replace a sequence's snapshot with a new revision.
   *
   * The new revision's step rows are inserted whole rather than updated in
   * place: an old revision's rows stay exactly as they were served, so evidence
   * recorded against content can never be re-pointed at different content. A
   * step the caller marks as carried keeps its acknowledgement, which is sound
   * only for byte-equal content — the caller decides that (§2.2), and passes
   * `carriedFromRevision` to say it did.
   * @param {number} sequenceId - Sequence id
   * @param {object} args
   * @param {number} args.revision - The new revision (the caller's old + 1)
   * @param {number} args.cursor - The first un-acked step of the new revision
   * @param {object} args.sourceManifest - The manifest the new revision was built from
   * @param {Array<{index: number, id: string, content: string, digest: string,
   *   pageOffsets: Array<[number, number]>, carriedFromRevision?: number|null,
   *   pagesServed?: number[], servedAt?: string|null, ackedAt?: string|null}>} args.steps -
   *   All steps of the new revision
   * @returns {object} The revised sequence row
   */
  revise(sequenceId, { revision, cursor, sourceManifest, steps }) {
    _ensureDb();
    const insert = _db.prepare(
      `INSERT INTO launch_sequence_steps (sequence_id, revision, step_index, step_id, content, digest,
         page_count, page_offsets, carried_from_revision, pages_served, served_at, acked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const st of steps) {
      const pagesServed = Array.isArray(st.pagesServed) ? st.pagesServed : [];
      insert.run(
        sequenceId, revision, st.index, st.id, st.content, st.digest,
        st.pageOffsets.length, JSON.stringify(st.pageOffsets),
        st.carriedFromRevision === undefined ? null : st.carriedFromRevision,
        JSON.stringify(pagesServed),
        // A carried step keeps its served stamp with its pages; a re-rendered
        // one has been served nothing, and saying otherwise would let ack rule
        // (f) pass over pages this revision never sent.
        st.servedAt || null,
        st.ackedAt || null
      );
    }
    // `recovery_revision` moves with the snapshot revision, and only with it.
    // A clear is an operator's decision about the verdict THEY read in step 3,
    // and a revision re-renders step 3 — so an outstanding clear for the old
    // revision is a decision about content that no longer exists. Binding it to
    // anything that moves more often would void clears for changes the operator
    // never saw; binding it to nothing would let a stale click clear a launch
    // whose story had changed underneath it.
    _db.prepare(
      `UPDATE launch_sequences
          SET revision = ?, cursor = ?, source_manifest = ?, recovery_revision = recovery_revision + 1
        WHERE id = ?`
    ).run(revision, cursor, JSON.stringify(sourceManifest), sequenceId);
    return _rowToLaunchSequence(_db.prepare('SELECT * FROM launch_sequences WHERE id = ?').get(sequenceId));
  },

  /**
   * Clear a sequence's required recovery as the session's own advisory
   * reconciliation, bound to the exact launch state it attested against.
   *
   * This is not an operator's clearance and writes no clearance record, so it
   * refuses the two operator words outright: an operator's clear goes through
   * {@link launchSequencesApi.clearRecoveryAsOperator}, which is the only write
   * that records one. `recovery_cleared_by` stays NULL, because nobody was
   * proven and the clearance word is what says who cleared it.
   *
   * Opens no transaction of its own: the caller holds the one the READY
   * attestation is written in, so the two land together.
   * @param {number} sequenceId - Sequence id
   * @param {object} args
   * @param {number} args.sessionId - The session the caller believes this is
   * @param {number} args.recoveryRevision - The recovery revision the caller read
   * @param {'agent-reconciled'} args.clearance - How it was cleared
   * @returns {object|null} The cleared sequence, or null when the binding did not match
   * @throws {Error} When `clearance` is anything but `agent-reconciled`; nothing is cleared.
   */
  clearRecovery(sequenceId, { sessionId, recoveryRevision, clearance }) {
    _ensureDb();
    if (clearance !== 'agent-reconciled') {
      throw new Error(
        `clearRecovery clears by reconciliation only and was given "${clearance}". An operator's clear is `
        + 'clearRecoveryAsOperator, which records the clearance.'
      );
    }
    return _clearRecoveryCas(sequenceId, { sessionId, recoveryRevision, clearance, clearedBy: null });
  },

  /**
   * Clear a sequence's required recovery as an operator's decision, and record
   * the clearance, as one transaction.
   *
   * The `launch_recovery_clearances` row is written beside the compare-and-set
   * or neither is: a launch must never read `cleared` with no durable record
   * of who cleared it, so a record that cannot be written rolls the clear back
   * and the error reaches the caller. A clear made in a batch also writes that
   * batch's `cleared` item outcome here, so the batch's own record cannot say
   * less than what was cleared under it.
   *
   * `clearedBy` is the operator's username where one authenticated, and NULL
   * where none did. It is never filled in with a placeholder: a row that names
   * nobody is the honest record of a clearance that proved nobody.
   *
   * The record copies the launch's own project, session and preflight from the
   * row that was cleared. Nothing in it is taken from the caller except the
   * proof and the batch.
   * @param {number} sequenceId - Sequence id
   * @param {object} args
   * @param {number} args.sessionId - The session the caller believes this is
   * @param {number} args.recoveryRevision - The recovery revision the caller read
   * @param {'operator-verified'|'open-install-unverified'} args.clearance - How the operator was proven
   * @param {string|null} [args.clearedBy] - The authenticated operator, or null
   * @param {string|null} [args.batchId] - The batch this clearance belongs to, or null for one made on its own
   * @param {number|null} [args.batchItemIndex] - The item's position in that batch; required with `batchId`
   * @returns {object|null} The cleared sequence, or null when the binding did not match
   * @throws {Error} When the clearance word is not an operator's, a batch is named without an
   *   item index, or a record cannot be written; nothing is cleared.
   */
  clearRecoveryAsOperator(sequenceId, {
    sessionId, recoveryRevision, clearance, clearedBy = null, batchId = null, batchItemIndex = null
  }) {
    _ensureDb();
    if (!OPERATOR_RECOVERY_CLEARANCES.includes(clearance)) {
      throw new Error(`clearRecoveryAsOperator records an operator's clearance and was given "${clearance}".`);
    }
    if (batchId !== null && !Number.isInteger(batchItemIndex)) {
      throw new Error('A clear made in a batch must name its item in that batch.');
    }
    return this.transaction(() => {
      const cleared = _clearRecoveryCas(sequenceId, { sessionId, recoveryRevision, clearance, clearedBy });
      if (!cleared) return null;
      const row = _db.prepare('SELECT preflight FROM launch_sequences WHERE id = ?').get(sequenceId);
      _db.prepare(
        `INSERT INTO launch_recovery_clearances
           (batch_id, project_id, session_id, sequence_id, recovery_revision, clearance, cleared_by, preflight, cleared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(batchId, cleared.projectId, cleared.sessionId, cleared.id, cleared.recoveryRevision,
        clearance, clearedBy, row.preflight, cleared.recoveryClearedAt);
      if (batchId !== null) {
        _insertRecoveryClearBatchItem({
          batchId,
          itemIndex: batchItemIndex,
          projectId: cleared.projectId,
          sessionId: cleared.sessionId,
          sequenceId: cleared.id,
          recoveryRevision: cleared.recoveryRevision,
          outcome: 'cleared'
        });
      }
      return cleared;
    });
  },

  /**
   * Stamp the unready window as passed. Idempotent: the first stamp stands, so
   * the window's start time is not re-dated by a later tick.
   *
   * Sets nothing else. The window is an observation, never a gate: it does not
   * move the cursor, does not require recovery, and does not make a later READY
   * any less valid (§2.3).
   * @param {number} sequenceId - Sequence id
   * @returns {boolean} Whether this call wrote the stamp
   */
  markUnready(sequenceId) {
    _ensureDb();
    const written = _db.prepare(
      "UPDATE launch_sequences SET unready_at = datetime('now') WHERE id = ? AND unready_at IS NULL"
    ).run(sequenceId);
    return written.changes > 0;
  },

  /**
   * Count one nudge that was SENT, on the sequence row rather than in
   * `activity_log` — the activity log is pruned per type, and "was this session
   * nudged" has to stay answerable for as long as the sequence does.
   * @param {number} sequenceId - Sequence id
   * @returns {object|null} The updated sequence
   */
  recordNudge(sequenceId) {
    _ensureDb();
    _db.prepare(
      "UPDATE launch_sequences SET nudge_count = nudge_count + 1, last_nudged_at = datetime('now') WHERE id = ?"
    ).run(sequenceId);
    const row = _db.prepare('SELECT * FROM launch_sequences WHERE id = ?').get(sequenceId);
    return row ? _rowToLaunchSequence(row) : null;
  },

  /**
   * Sequences of live sessions that have not attested READY.
   *
   * Bounded by the JOIN to active sessions on purpose: these rows are never
   * pruned, so every session that ended before attesting leaves one behind and
   * an unbounded `ready_at IS NULL` scan would grow forever.
   * @returns {object[]} Oldest first — the one most overdue is answered first
   */
  listUnreadyOfActiveSessions() {
    _ensureDb();
    return _db.prepare(
      `SELECT ls.* FROM launch_sequences ls
         JOIN sessions s ON s.id = ls.session_id
        WHERE ls.ready_at IS NULL AND ls.applicability = 'applicable' AND s.status = ?
        ORDER BY ls.created_at ASC`
    ).all(SESSION_STATUS.ACTIVE).map(_rowToLaunchSequence);
  },

  /**
   * Every launch across the install that is waiting on an operator's clear:
   * recovery `required` in `operator` mode, for a session whose stored status
   * is active, in a project that is not archived.
   *
   * "Active" is the session row's status. It is not a check that a pane is
   * alive. Bounded by the JOIN to active sessions for the reason
   * `listUnreadyOfActiveSessions` gives: these rows are never pruned.
   * @returns {object[]} Oldest launch first
   */
  listOperatorHeldOfActiveSessions() {
    _ensureDb();
    return _db.prepare(
      `SELECT ls.* FROM launch_sequences ls
         JOIN sessions s ON s.id = ls.session_id
         JOIN projects p ON p.id = ls.project_id
        WHERE ls.recovery = 'required' AND ls.recovery_mode = 'operator'
          AND s.status = ? AND p.archived = 0
        ORDER BY ls.created_at ASC, ls.id ASC`
    ).all(SESSION_STATUS.ACTIVE).map(_rowToLaunchSequence);
  },

  /**
   * Was any step of an EARLIER revision of this sequence served or acknowledged?
   *
   * The question behind it is whether a revision replaced content the session
   * had already read. A snapshot revised before anything went out replaced
   * nothing the agent saw, and treating that as something to reconcile asks for
   * an account of an event the agent never witnessed.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - The current revision; earlier ones are examined
   * @returns {boolean}
   */
  anyStepReadBefore(sequenceId, revision) {
    _ensureDb();
    const row = _db.prepare(
      `SELECT 1 FROM launch_sequence_steps
        WHERE sequence_id = ? AND revision < ? AND (served_at IS NOT NULL OR acked_at IS NOT NULL)
        LIMIT 1`
    ).get(sequenceId, revision);
    return Boolean(row);
  },

  /**
   * A project's most recent sequences, newest first, for the readiness panel.
   * @param {number} projectId - Project id
   * @param {number} [limit=5] - How many to return
   * @returns {object[]}
   */
  listForProject(projectId, limit = 5) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM launch_sequences WHERE project_id = ? ORDER BY id DESC LIMIT ?'
    ).all(projectId, limit).map(_rowToLaunchSequence);
  }
};

module.exports = {
  _bind,
  LAUNCH_STEP_IDS,
  _insertLaunchSequence,
  projectRecoveryStateApi,
  recoveryClearancesApi,
  recoveryClearBatchesApi,
  launchSequencesApi
};
