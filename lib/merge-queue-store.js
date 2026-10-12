'use strict';

/**
 * The merge queue's records: every read and write over `merge_queues`,
 * `merge_queue_entries` and `merge_queue_events`.
 *
 * Each write runs in one `BEGIN IMMEDIATE` transaction together with the event
 * row that records it, so a change and its history land or fail as one. A
 * write that is not allowed changes nothing and answers
 * `{ ok: false, code, message }` with a code from
 * `lib/merge-queue-state.js#REFUSALS`; a database error is thrown.
 *
 * This module decides what the records permit: who may write (the Operator
 * for a queue and its Operator gate, the owner project for everything about
 * an entry), which moves are allowed, and that only one entry is active. It
 * does not decide who the caller is. The HTTP layer resolves that
 * (`lib/control-auth.js`) and passes an actor:
 * `{ kind: 'operator', operatorProof }` or
 * `{ kind: 'project', projectId, launchId }`.
 *
 * It calls nothing outside the database: no GitHub, no session lookup.
 *
 * @module lib/merge-queue-store
 */

const crypto = require('node:crypto');
const store = require('./store');
const state = require('./merge-queue-state');

const { REFUSALS } = state;

const REPO_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_SHAPE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
const SHA_SHAPE = /^[0-9a-f]{40}$/;
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REFERENCE = 300;
const MAX_EVENT_DETAIL = 4096;
const MAX_DETAIL = 1000;

/** The halt the queue puts on itself when a landed tree is not the tested one. */
const HALT_TREE_MISMATCH = 'TREE_MISMATCH';

/** Seams for tests: the clock and the id source. */
const _internal = {
  now: () => new Date().toISOString(),
  id: (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`
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
  const db = store.getDb();
  if (!db) throw new Error('The store is not initialized.');
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

/**
 * A check run's id as text: a non-empty string or a positive integer, as
 * GitHub gives it. Anything else, `null` included, is not an id.
 * @param {*} value - Candidate id
 * @returns {string|null}
 */
function _runId(value) {
  if (Number.isInteger(value) && value > 0) return String(value);
  return _text(value, 64);
}

/**
 * An actor in the shape the events table keeps, or null when it is not one.
 * @param {object} actor - `{ kind: 'operator', operatorProof }` or `{ kind: 'project', projectId, launchId }`
 * @returns {{kind: string, projectId: (number|null), launchId: (string|null), proof: (string|null)}|null}
 */
function _actor(actor) {
  if (!actor || typeof actor !== 'object') return null;
  if (actor.kind === 'operator') {
    const proof = _text(actor.operatorProof, 64);
    return proof ? { kind: 'operator', projectId: null, launchId: null, proof } : null;
  }
  if (actor.kind === 'project') {
    const launchId = _text(actor.launchId, 128);
    if (!Number.isInteger(actor.projectId) || actor.projectId <= 0 || !launchId) return null;
    return { kind: 'project', projectId: actor.projectId, launchId, proof: null };
  }
  return null;
}

/**
 * Append one event to a queue's history, numbered after the last one. Called
 * inside the transaction that makes the change it records. A detail that
 * would not fit the column once written as JSON is replaced by a marker
 * saying so: the row and its columns hold the facts, and a history that
 * cannot be written must never be what stops a change.
 * @param {object} db - The database, inside a transaction
 * @param {object} event - `{ queueId, entryId?, event, from?, to?, actor, detail?, at }`
 * @returns {number} The event's sequence in its queue
 */
function _appendEvent(db, event) {
  const next = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM merge_queue_events WHERE queue_id = ?').get(event.queueId).n;
  let detail = event.detail ? JSON.stringify(event.detail) : null;
  if (detail && detail.length > MAX_EVENT_DETAIL) detail = JSON.stringify({ omitted: 'detail too long to record', length: detail.length });
  db.prepare(
    'INSERT INTO merge_queue_events (queue_id, entry_id, sequence, event, from_state, to_state, '
    + 'actor_kind, actor_project_id, actor_launch_id, actor_proof, detail_json, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    event.queueId, event.entryId || null, next, event.event, event.from || null, event.to || null,
    event.actor.kind, event.actor.projectId, event.actor.launchId, event.actor.proof,
    detail, event.at
  );
  return next;
}

/**
 * A queue row as callers see it.
 * @param {object} row - A `merge_queues` row
 * @returns {object|null}
 */
function _queue(row) {
  if (!row) return null;
  return {
    queueId: row.queue_id,
    repo: row.repo,
    baseBranch: row.base_branch,
    ownerProjectId: row.owner_project_id,
    status: row.status,
    createdBy: { kind: row.created_by_kind, operatorProof: row.created_by_proof },
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    halt: row.halted_at ? { at: row.halted_at, code: row.halt_code, detail: row.halt_detail } : null
  };
}

/**
 * An entry row as callers see it.
 * @param {object} row - A `merge_queue_entries` row
 * @returns {object|null}
 */
function _entry(row) {
  if (!row) return null;
  const ownerGate = (name) => ({
    status: row[`${name}_gate_status`], reference: row[`${name}_gate_ref`], recordedAt: row[`${name}_gate_recorded_at`]
  });
  return {
    entryId: row.entry_id,
    queueId: row.queue_id,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    position: row.position,
    state: row.state,
    gates: {
      review: ownerGate('review'),
      test: ownerGate('test'),
      base: ownerGate('base'),
      operator: {
        status: row.operator_gate_status, reference: row.operator_gate_ref,
        operatorProof: row.operator_gate_proof, recordedAt: row.operator_gate_recorded_at
      }
    },
    headCheck: row.head_check_read_at
      ? { runId: row.head_check_run_id, conclusion: row.head_check_conclusion, readAt: row.head_check_read_at }
      : null,
    submittedBy: { projectId: row.submitted_by_project_id, launchId: row.submitted_by_launch_id },
    candidate: row.candidate_sha
      ? {
        ref: row.candidate_ref, baseSha: row.candidate_base_sha, sha: row.candidate_sha, tree: row.candidate_tree,
        checkRunId: row.candidate_check_run_id, checkConclusion: row.candidate_check_conclusion
      }
      : null,
    landed: row.landed_sha
      ? { sha: row.landed_sha, tree: row.landed_tree, treeMatches: row.landed_tree_matches === 1, at: row.landed_at }
      : null,
    failure: row.failure_code ? { code: row.failure_code, detail: row.failure_detail } : null,
    withdrawnReason: row.withdrawn_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  };
}

/**
 * An event row as callers see it.
 * @param {object} row - A `merge_queue_events` row
 * @returns {object}
 */
function _event(row) {
  let detail = null;
  if (row.detail_json) {
    try { detail = JSON.parse(row.detail_json); } catch { detail = { unreadable: true }; }
  }
  return {
    sequence: row.sequence,
    queueId: row.queue_id,
    entryId: row.entry_id,
    event: row.event,
    from: row.from_state,
    to: row.to_state,
    actor: { kind: row.actor_kind, projectId: row.actor_project_id, launchId: row.actor_launch_id, operatorProof: row.actor_proof },
    detail,
    at: row.created_at
  };
}

/**
 * Read a queue row inside a transaction.
 * @param {object} db - The database
 * @param {string} queueId - Queue id
 * @returns {object|undefined} The raw row
 */
function _queueRow(db, queueId) {
  return db.prepare('SELECT * FROM merge_queues WHERE queue_id = ?').get(String(queueId));
}

/**
 * Read an entry row inside a transaction.
 * @param {object} db - The database
 * @param {string} entryId - Entry id
 * @returns {object|undefined} The raw row
 */
function _entryRow(db, entryId) {
  return db.prepare('SELECT * FROM merge_queue_entries WHERE entry_id = ?').get(String(entryId));
}

/**
 * The refusal, if any, that stops this actor writing to an entry of this
 * queue: only a launch of the queue's owner project may.
 * @param {object} queueRow - The queue's raw row
 * @param {object|null} actor - A normalized actor
 * @returns {object|null} A refusal, or null when the actor is the owner
 */
function _ownerRefusal(queueRow, actor) {
  if (!actor) return _refuse(REFUSALS.INVALID_INPUT, 'An actor is required: the Operator or a project launch.');
  if (actor.kind !== 'project' || actor.projectId !== queueRow.owner_project_id) {
    return _refuse(REFUSALS.NOT_OWNER, `Only a launch of project ${queueRow.owner_project_id}, which owns this queue, may change its entries.`);
  }
  return null;
}

/**
 * The refusal, if any, that stops a queue moving an entry forward: it is
 * retired, or it has halted itself and the Operator has not cleared it.
 * @param {object} queueRow - The queue's raw row
 * @returns {object|null}
 */
function _stoppedRefusal(queueRow) {
  if (queueRow.status !== 'active') {
    return _refuse(REFUSALS.QUEUE_RETIRED, 'This queue is retired. It keeps its history and takes nothing new.');
  }
  if (queueRow.halted_at) {
    return _refuse(REFUSALS.QUEUE_HALTED, `This queue halted itself (${queueRow.halt_code}). Nothing advances until the Operator clears the halt.`);
  }
  return null;
}

/**
 * Make a queue for one repository and base branch and name its owner. Only the
 * Operator may. A second active queue for the same repository and base is
 * refused.
 * @param {object} input - `{ repo, baseBranch, ownerProjectId, actor }`
 * @returns {{ok: true, queue: object}|{ok: false, code: string, message: string}}
 */
function createQueue(input) {
  const { repo, baseBranch, ownerProjectId } = input || {};
  const actor = _actor(input && input.actor);
  if (!actor || actor.kind !== 'operator') {
    return _refuse(REFUSALS.OPERATOR_ONLY, 'Only the Operator makes a merge queue and names its owner.');
  }
  if (typeof repo !== 'string' || !REPO_SHAPE.test(repo)) {
    return _refuse(REFUSALS.INVALID_INPUT, 'repo must be "owner/name".');
  }
  if (typeof baseBranch !== 'string' || !BRANCH_SHAPE.test(baseBranch) || baseBranch.includes('..') || baseBranch.endsWith('/')) {
    return _refuse(REFUSALS.INVALID_INPUT, 'baseBranch must be a branch name.');
  }
  if (!Number.isInteger(ownerProjectId) || ownerProjectId <= 0) {
    return _refuse(REFUSALS.INVALID_INPUT, 'ownerProjectId must be a project id.');
  }
  return _transaction((db) => {
    const existing = db.prepare("SELECT queue_id FROM merge_queues WHERE repo = ? AND base_branch = ? AND status = 'active'").get(repo, baseBranch);
    if (existing) {
      return _refuse(REFUSALS.QUEUE_EXISTS, `${repo} already has an active queue for ${baseBranch} (${existing.queue_id}). Retire it before making another.`, { queueId: existing.queue_id });
    }
    const queueId = _internal.id('mq');
    const at = _internal.now();
    db.prepare(
      'INSERT INTO merge_queues (queue_id, repo, base_branch, owner_project_id, status, created_by_kind, created_by_proof, created_at) '
      + "VALUES (?, ?, ?, ?, 'active', 'operator', ?, ?)"
    ).run(queueId, repo, baseBranch, ownerProjectId, actor.proof, at);
    _appendEvent(db, { queueId, event: 'queue-created', actor, detail: { repo, baseBranch, ownerProjectId }, at });
    return { ok: true, queue: _queue(_queueRow(db, queueId)) };
  });
}

/**
 * Retire a queue. Only the Operator may, and only when no entry is unfinished:
 * a queue with work in it is emptied first, by landing or withdrawing.
 * @param {string} queueId - Queue id
 * @param {object} input - `{ actor }`
 * @returns {{ok: true, queue: object}|{ok: false, code: string, message: string}}
 */
function retireQueue(queueId, input) {
  const actor = _actor(input && input.actor);
  if (!actor || actor.kind !== 'operator') return _refuse(REFUSALS.OPERATOR_ONLY, 'Only the Operator retires a merge queue.');
  return _transaction((db) => {
    const queueRow = _queueRow(db, queueId);
    if (!queueRow) return _refuse(REFUSALS.QUEUE_NOT_FOUND, 'No such merge queue.');
    if (queueRow.status !== 'active') return _refuse(REFUSALS.QUEUE_RETIRED, 'This queue is already retired.');
    const open = db.prepare(
      `SELECT COUNT(*) AS n FROM merge_queue_entries WHERE queue_id = ? AND state NOT IN (${state.FINISHED_STATES.map(() => '?').join(',')})`
    ).get(queueRow.queue_id, ...state.FINISHED_STATES).n;
    if (open) return _refuse(REFUSALS.QUEUE_NOT_EMPTY, `This queue has ${open === 1 ? 'an unfinished entry' : 'unfinished entries'}. Land or withdraw every entry before retiring it.`);
    const at = _internal.now();
    db.prepare("UPDATE merge_queues SET status = 'retired', retired_at = ? WHERE queue_id = ?").run(at, queueRow.queue_id);
    _appendEvent(db, { queueId: queueRow.queue_id, event: 'queue-retired', actor, at });
    return { ok: true, queue: _queue(_queueRow(db, queueRow.queue_id)) };
  });
}

/**
 * Clear a queue's halt so it may advance again. Only the Operator may: a halt
 * means the base holds a tree no test run passed, and a person decides what
 * that needs before anything else lands on it.
 * @param {string} queueId - Queue id
 * @param {object} input - `{ actor, reference }`, `reference` being what the Operator checked or decided
 * @returns {{ok: true, queue: object}|{ok: false, code: string, message: string}}
 */
function clearHalt(queueId, input) {
  const actor = _actor(input && input.actor);
  if (!actor || actor.kind !== 'operator') return _refuse(REFUSALS.OPERATOR_ONLY, 'Only the Operator clears a halted merge queue.');
  const reference = _text(input && input.reference, MAX_REFERENCE);
  if (!reference) return _refuse(REFUSALS.INVALID_INPUT, `reference is required: what was checked or decided, in at most ${MAX_REFERENCE} characters.`);
  return _transaction((db) => {
    const queueRow = _queueRow(db, queueId);
    if (!queueRow) return _refuse(REFUSALS.QUEUE_NOT_FOUND, 'No such merge queue.');
    if (!queueRow.halted_at) return _refuse(REFUSALS.QUEUE_NOT_HALTED, 'This queue is not halted.');
    const at = _internal.now();
    db.prepare('UPDATE merge_queues SET halted_at = NULL, halt_code = NULL, halt_detail = NULL WHERE queue_id = ?').run(queueRow.queue_id);
    _appendEvent(db, {
      queueId: queueRow.queue_id, event: 'queue-halt-cleared', actor, at,
      detail: { reference, haltedAt: queueRow.halted_at, code: queueRow.halt_code }
    });
    return { ok: true, queue: _queue(_queueRow(db, queueRow.queue_id)) };
  });
}

/**
 * Add one pull request at one exact head commit to the back of a queue, with
 * the owner's three gates and whether the Operator gate is required. Only a
 * launch of the owner project may. A pull request that already has an
 * unfinished entry is refused.
 * @param {object} input - `{ queueId, prNumber, headSha, gates: { review, test, base, operatorRequired }, headCheck?: { runId, conclusion, readAt? }, actor }`;
 *   each owner gate is its reference. `headCheck` is what the queue itself read of the head's check, when it read one.
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string}}
 */
function submitEntry(input) {
  const { queueId, prNumber, headSha, headCheck } = input || {};
  const gates = (input && input.gates) || {};
  const actor = _actor(input && input.actor);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return _refuse(REFUSALS.INVALID_INPUT, 'prNumber must be a pull request number.');
  if (typeof headSha !== 'string' || !SHA_SHAPE.test(headSha)) {
    return _refuse(REFUSALS.INVALID_INPUT, 'headSha must be the full 40-character commit id, in lower case.');
  }
  const references = {};
  for (const name of state.OWNER_GATES) {
    references[name] = _text(gates[name], MAX_REFERENCE);
    if (!references[name]) {
      return _refuse(REFUSALS.GATE_REFERENCE_MISSING, `The ${name} gate needs a reference of at most ${MAX_REFERENCE} characters: where its result is recorded.`, { gate: name });
    }
  }
  if (typeof gates.operatorRequired !== 'boolean') {
    return _refuse(REFUSALS.INVALID_INPUT, 'gates.operatorRequired must say whether this entry needs the Operator gate: true or false.');
  }
  let check = null;
  if (headCheck !== undefined && headCheck !== null) {
    const runId = _runId(headCheck.runId);
    const conclusion = _text(headCheck.conclusion, 32);
    if (!runId || !conclusion) return _refuse(REFUSALS.INVALID_INPUT, 'headCheck needs the run id and its conclusion.');
    check = { runId, conclusion, readAt: _text(headCheck.readAt, 64) };
  }
  return _transaction((db) => {
    const queueRow = _queueRow(db, queueId);
    if (!queueRow) return _refuse(REFUSALS.QUEUE_NOT_FOUND, 'No such merge queue.');
    const notOwner = _ownerRefusal(queueRow, actor);
    if (notOwner) return notOwner;
    if (queueRow.status !== 'active') return _refuse(REFUSALS.QUEUE_RETIRED, 'This queue is retired. It keeps its history and takes nothing new.');
    const duplicate = db.prepare(
      `SELECT entry_id FROM merge_queue_entries WHERE queue_id = ? AND pr_number = ? AND state NOT IN (${state.FINISHED_STATES.map(() => '?').join(',')})`
    ).get(queueRow.queue_id, prNumber, ...state.FINISHED_STATES);
    if (duplicate) {
      return _refuse(REFUSALS.DUPLICATE_PR, `Pull request ${prNumber} already has an unfinished entry (${duplicate.entry_id}). Withdraw it before submitting a new head.`, { entryId: duplicate.entry_id });
    }
    const entryId = _internal.id('mqe');
    const at = _internal.now();
    const position = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM merge_queue_entries WHERE queue_id = ?').get(queueRow.queue_id).n;
    db.prepare(
      'INSERT INTO merge_queue_entries (entry_id, queue_id, pr_number, head_sha, position, state, '
      + 'review_gate_status, review_gate_ref, review_gate_recorded_at, '
      + 'test_gate_status, test_gate_ref, test_gate_recorded_at, '
      + 'base_gate_status, base_gate_ref, base_gate_recorded_at, '
      + 'operator_gate_status, head_check_run_id, head_check_conclusion, head_check_read_at, '
      + 'submitted_by_project_id, submitted_by_launch_id, created_at, updated_at) '
      + "VALUES (?, ?, ?, ?, ?, 'queued', 'recorded', ?, ?, 'recorded', ?, ?, 'recorded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      entryId, queueRow.queue_id, prNumber, headSha, position,
      references.review, at, references.test, at, references.base, at,
      gates.operatorRequired ? 'required' : 'not-required',
      check ? check.runId : null, check ? check.conclusion : null, check ? (check.readAt || at) : null,
      actor.projectId, actor.launchId, at, at
    );
    _appendEvent(db, {
      queueId: queueRow.queue_id, entryId, event: 'submitted', to: 'queued', actor, at,
      detail: { prNumber, headSha, position, gates: { ...references, operatorRequired: gates.operatorRequired }, headCheck: check }
    });
    return { ok: true, entry: _entry(_entryRow(db, entryId)) };
  });
}

/**
 * Record the Operator gate of an entry that was submitted as needing one. Only
 * the Operator may, and the proof of who they were is kept with it.
 * @param {string} entryId - Entry id
 * @param {object} input - `{ reference, actor }`
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string}}
 */
function recordOperatorGate(entryId, input) {
  const actor = _actor(input && input.actor);
  if (!actor || actor.kind !== 'operator') {
    return _refuse(REFUSALS.OPERATOR_ONLY, 'Only the Operator records the Operator gate. A session saying the Operator agreed is not the Operator.');
  }
  const reference = _text(input && input.reference, MAX_REFERENCE);
  if (!reference) return _refuse(REFUSALS.GATE_REFERENCE_MISSING, `The Operator gate needs a reference of at most ${MAX_REFERENCE} characters.`, { gate: 'operator' });
  return _transaction((db) => {
    const row = _entryRow(db, entryId);
    if (!row) return _refuse(REFUSALS.ENTRY_NOT_FOUND, 'No such merge queue entry.');
    if (state.isFinished(row.state)) return _refuse(REFUSALS.ENTRY_FINISHED, `The entry is ${row.state} and cannot change.`);
    if (row.operator_gate_status === 'not-required') {
      return _refuse(REFUSALS.OPERATOR_GATE_NOT_REQUIRED, 'This entry was submitted as not needing the Operator gate.');
    }
    if (row.operator_gate_status === 'recorded') {
      return _refuse(REFUSALS.OPERATOR_GATE_ALREADY_RECORDED, 'The Operator gate of this entry is already recorded.');
    }
    const at = _internal.now();
    db.prepare(
      "UPDATE merge_queue_entries SET operator_gate_status = 'recorded', operator_gate_ref = ?, operator_gate_proof = ?, "
      + 'operator_gate_recorded_at = ?, updated_at = ? WHERE entry_id = ?'
    ).run(reference, actor.proof, at, at, row.entry_id);
    _appendEvent(db, { queueId: row.queue_id, entryId: row.entry_id, event: 'operator-gate-recorded', actor, at, detail: { reference } });
    return { ok: true, entry: _entry(_entryRow(db, row.entry_id)) };
  });
}

/**
 * Move one entry to another state: the one path every entry change takes.
 * Checks the owner, the allowed moves and whatever `guard` adds, writes the
 * state with the columns in `set`, and appends the event, all in one
 * transaction.
 * @param {string} entryId - Entry id
 * @param {string} to - The state asked for
 * @param {object} input - The caller's input, carrying `actor`
 * @param {object} [options] - `{ forward, guard(row, queueRow, db), set(row, at), detail(row), after(db, row, queueRow, actor, at) }`.
 *   `forward` marks a move a retired or halted queue refuses. `guard` returns a refusal or null.
 *   `set` returns the further columns to write. `after` runs once the entry is written and may add to the answer.
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string}}
 */
function _move(entryId, to, input, options = {}) {
  const actor = _actor(input && input.actor);
  return _transaction((db) => {
    const row = _entryRow(db, entryId);
    if (!row) return _refuse(REFUSALS.ENTRY_NOT_FOUND, 'No such merge queue entry.');
    const queueRow = _queueRow(db, row.queue_id);
    const notOwner = _ownerRefusal(queueRow, actor);
    if (notOwner) return notOwner;
    const allowed = state.checkTransition(row.state, to);
    if (!allowed.ok) return allowed;
    if (options.forward) {
      const stopped = _stoppedRefusal(queueRow);
      if (stopped) return stopped;
    }
    const refused = options.guard ? options.guard(row, queueRow, db) : null;
    if (refused) return refused;
    const at = _internal.now();
    const columns = { state: to, updated_at: at, ...(options.set ? options.set(row, at) : {}) };
    if (state.isFinished(to)) columns.finished_at = at;
    const names = Object.keys(columns);
    db.prepare(`UPDATE merge_queue_entries SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE entry_id = ?`)
      .run(...names.map((n) => columns[n]), row.entry_id);
    _appendEvent(db, {
      queueId: row.queue_id, entryId: row.entry_id, event: allowed.event, from: row.state, to, actor, at,
      detail: options.detail ? options.detail(row) : null
    });
    const extra = options.after ? options.after(db, row, queueRow, actor, at) : null;
    return { ok: true, entry: _entry(_entryRow(db, row.entry_id)), ...(extra || {}) };
  });
}

/** The columns that describe a candidate, as cleared when one is discarded. */
const NO_CANDIDATE = Object.freeze({
  candidate_ref: null, candidate_base_sha: null, candidate_sha: null, candidate_tree: null,
  candidate_check_run_id: null, candidate_check_conclusion: null
});

/**
 * Start assembling the entry at the front of the queue. Refused when another
 * entry is active or an earlier one is still waiting: the queue works one
 * entry at a time, in submission order.
 * @param {string} entryId - Entry id
 * @param {object} input - `{ actor }`
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string}}
 */
function beginAssembly(entryId, input) {
  return _move(entryId, 'assembling', input, {
    forward: true,
    guard: (row, queueRow, db) => {
      if (row.state !== 'queued') {
        return _refuse(REFUSALS.TRANSITION_NOT_ALLOWED, `Only a queued entry starts assembling; this one is ${row.state}. A candidate that no longer stands is discarded instead.`);
      }
      const unfinished = db.prepare(
        `SELECT entry_id, state, position FROM merge_queue_entries WHERE queue_id = ? AND state NOT IN (${state.FINISHED_STATES.map(() => '?').join(',')})`
      ).all(row.queue_id, ...state.FINISHED_STATES);
      const next = state.nextActive(unfinished);
      if (next && next.entry_id !== row.entry_id) {
        return state.isActive(next.state)
          ? _refuse(REFUSALS.QUEUE_BUSY, `Entry ${next.entry_id} is ${next.state}. The queue works one entry at a time.`, { activeEntryId: next.entry_id })
          : _refuse(REFUSALS.NOT_FRONT, `Entry ${next.entry_id} was submitted earlier and goes first.`, { frontEntryId: next.entry_id });
      }
      return null;
    }
  });
}

/**
 * Record the candidate the queue made for an entry: the branch, the base it
 * was made on, and the commit and tree that merging the head into that base
 * produced. The entry then waits for the candidate's test.
 * @param {string} entryId - Entry id
 * @param {object} input - `{ ref, baseSha, sha, tree, actor }`
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string}}
 */
function recordCandidate(entryId, input) {
  const { baseSha, sha, tree } = input || {};
  const ref = _text(input && input.ref, 255);
  if (!ref || ![baseSha, sha, tree].every((v) => typeof v === 'string' && SHA_SHAPE.test(v))) {
    return _refuse(REFUSALS.INVALID_INPUT, 'A candidate needs its ref, and its base, commit and tree as full 40-character ids.');
  }
  return _move(entryId, 'testing', input, {
    forward: true,
    guard: (row) => (row.state === 'assembling'
      ? null
      : _refuse(REFUSALS.TRANSITION_NOT_ALLOWED, `A candidate is recorded for an assembling entry; this one is ${row.state}.`)),
    set: () => ({
      candidate_ref: ref, candidate_base_sha: baseSha, candidate_sha: sha, candidate_tree: tree,
      candidate_check_run_id: null, candidate_check_conclusion: null
    }),
    detail: () => ({ ref, baseSha, sha, tree })
  });
}

/**
 * Discard an entry's candidate and go back to assembling, because the base
 * moved after the candidate was made. Not a failure: the entry keeps its
 * place and a new candidate is made on the new base.
 * @param {string} entryId - Entry id
 * @param {object} input - `{ reason, actor }`
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string}}
 */
function discardCandidate(entryId, input) {
  const reason = _text(input && input.reason, MAX_REFERENCE);
  if (!reason) return _refuse(REFUSALS.INVALID_INPUT, `reason is required: why the candidate no longer stands, in at most ${MAX_REFERENCE} characters.`);
  return _move(entryId, 'assembling', input, {
    forward: true,
    guard: (row) => (row.state === 'queued'
      ? _refuse(REFUSALS.TRANSITION_NOT_ALLOWED, 'A queued entry has no candidate to discard.')
      : null),
    set: () => ({ ...NO_CANDIDATE }),
    detail: (row) => ({ reason, discarded: { ref: row.candidate_ref, baseSha: row.candidate_base_sha, sha: row.candidate_sha, tree: row.candidate_tree } })
  });
}

/**
 * Start landing an entry: the last recorded step before the merge is asked
 * for. Refused unless the candidate's check concluded success and every gate
 * is met, read from the record in the same transaction that writes the state.
 * @param {string} entryId - Entry id
 * @param {object} input - `{ candidateCheck: { runId, conclusion }, actor }`
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string, problems?: Array}}
 */
function beginLanding(entryId, input) {
  const check = (input && input.candidateCheck) || {};
  const runId = _runId(check.runId);
  const conclusion = _text(check.conclusion, 32);
  if (!runId || !conclusion) return _refuse(REFUSALS.INVALID_INPUT, 'candidateCheck needs the run id and its conclusion.');
  return _move(entryId, 'landing', input, {
    forward: true,
    guard: (row) => {
      if (conclusion !== 'success') {
        return _refuse(REFUSALS.CANDIDATE_NOT_GREEN, `The candidate's check concluded "${conclusion}". Only success lands.`);
      }
      const problems = state.gateProblems(_entry(row));
      if (problems.length) {
        return _refuse(REFUSALS.GATES_NOT_MET, `Not every gate is met: ${problems.map((p) => p.message).join(' ')}`, { problems });
      }
      return null;
    },
    set: () => ({ candidate_check_run_id: runId, candidate_check_conclusion: conclusion }),
    detail: (row) => ({ candidateSha: row.candidate_sha, candidateCheck: { runId, conclusion } })
  });
}

/**
 * Record that the merge was not made: its outcome was read and the pull
 * request is still open. The entry goes back to waiting with its candidate.
 * @param {string} entryId - Entry id
 * @param {object} input - `{ reason, actor }`
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string}}
 */
function recordLandingNotMade(entryId, input) {
  const reason = _text(input && input.reason, MAX_REFERENCE);
  if (!reason) return _refuse(REFUSALS.INVALID_INPUT, `reason is required: what was read, in at most ${MAX_REFERENCE} characters.`);
  return _move(entryId, 'testing', input, {
    guard: (row) => (row.state === 'assembling'
      ? _refuse(REFUSALS.TRANSITION_NOT_ALLOWED, 'An assembling entry reaches testing by recording its candidate.')
      : null),
    detail: () => ({ reason })
  });
}

/**
 * Record a landing: the merge commit that reached the base and its tree. The
 * tree is compared with the candidate's here. When they differ the entry is
 * still recorded as landed, because the merge happened, and the queue halts
 * itself in the same transaction: the base then holds a tree no test passed.
 * @param {string} entryId - Entry id
 * @param {object} input - `{ landedSha, landedTree, landedAt?, actor }`
 * @returns {{ok: true, entry: object, treeMatches: boolean, queueHalted: boolean}|{ok: false, code: string, message: string}}
 */
function recordLanded(entryId, input) {
  const { landedSha, landedTree } = input || {};
  if (![landedSha, landedTree].every((v) => typeof v === 'string' && SHA_SHAPE.test(v))) {
    return _refuse(REFUSALS.INVALID_INPUT, 'A landing needs the merge commit and its tree as full 40-character ids.');
  }
  const landedAt = _text(input && input.landedAt, 64);
  return _move(entryId, 'landed', input, {
    set: (row, at) => ({
      landed_sha: landedSha, landed_tree: landedTree, landed_at: landedAt || at,
      landed_tree_matches: landedTree === row.candidate_tree ? 1 : 0
    }),
    detail: (row) => ({ landedSha, landedTree, candidateTree: row.candidate_tree, treeMatches: landedTree === row.candidate_tree }),
    after: (db, row, queueRow, actor, at) => {
      const treeMatches = landedTree === row.candidate_tree;
      if (treeMatches) return { treeMatches, queueHalted: false };
      const detail = `Entry ${row.entry_id} landed as ${landedSha} with tree ${landedTree}; its tested candidate ${row.candidate_sha} has tree ${row.candidate_tree}.`;
      db.prepare('UPDATE merge_queues SET halted_at = ?, halt_code = ?, halt_detail = ? WHERE queue_id = ?')
        .run(at, HALT_TREE_MISMATCH, detail, queueRow.queue_id);
      _appendEvent(db, {
        queueId: queueRow.queue_id, entryId: row.entry_id, event: 'queue-halted', actor, at,
        detail: { code: HALT_TREE_MISMATCH, landedSha, landedTree, candidateSha: row.candidate_sha, candidateTree: row.candidate_tree }
      });
      return { treeMatches, queueHalted: true };
    }
  });
}

/**
 * Fail an entry and free the queue for the next one.
 * @param {string} entryId - Entry id
 * @param {object} input - `{ code, detail?, actor }`; `detail` longer than the column holds is cut to fit
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string}}
 */
function failEntry(entryId, input) {
  const code = input && input.code;
  if (typeof code !== 'string' || !CODE_SHAPE.test(code)) return _refuse(REFUSALS.INVALID_INPUT, 'A failure needs a code: letters, digits, "_" or "-", at most 64.');
  const detail = typeof (input && input.detail) === 'string' && input.detail.trim()
    ? input.detail.trim().slice(0, MAX_DETAIL)
    : null;
  return _move(entryId, 'failed', input, {
    set: () => ({ failure_code: code, failure_detail: detail }),
    detail: () => ({ code, detail })
  });
}

/**
 * Withdraw an entry. Refused once landing has started: the merge's outcome is
 * read first.
 * @param {string} entryId - Entry id
 * @param {object} input - `{ reason, actor }`
 * @returns {{ok: true, entry: object}|{ok: false, code: string, message: string}}
 */
function withdrawEntry(entryId, input) {
  const reason = _text(input && input.reason, MAX_DETAIL);
  if (!reason) return _refuse(REFUSALS.INVALID_INPUT, `reason is required, in at most ${MAX_DETAIL} characters.`);
  return _move(entryId, 'withdrawn', input, {
    set: () => ({ withdrawn_reason: reason }),
    detail: () => ({ reason })
  });
}

/**
 * One queue.
 * @param {string} queueId - Queue id
 * @returns {object|null}
 */
function getQueue(queueId) {
  return _queue(_queueRow(store.getDb(), queueId));
}

/**
 * The active queue of a repository and base branch, if there is one.
 * @param {string} repo - "owner/name"
 * @param {string} baseBranch - Base branch
 * @returns {object|null}
 */
function findActiveQueue(repo, baseBranch) {
  return _queue(store.getDb().prepare(
    "SELECT * FROM merge_queues WHERE repo = ? AND base_branch = ? AND status = 'active'"
  ).get(String(repo), String(baseBranch)));
}

/**
 * Every queue, oldest first.
 * @param {object} [options] - `{ includeRetired }`, default false
 * @returns {object[]}
 */
function listQueues(options = {}) {
  const rows = store.getDb().prepare(
    `SELECT * FROM merge_queues ${options.includeRetired ? '' : "WHERE status = 'active'"} ORDER BY created_at, queue_id`
  ).all();
  return rows.map(_queue);
}

/**
 * One entry.
 * @param {string} entryId - Entry id
 * @returns {object|null}
 */
function getEntry(entryId) {
  return _entry(_entryRow(store.getDb(), entryId));
}

/**
 * A queue's entries in submission order.
 * @param {string} queueId - Queue id
 * @param {object} [options] - `{ includeFinished }`, default true
 * @returns {object[]}
 */
function listEntries(queueId, options = {}) {
  const all = options.includeFinished !== false;
  const rows = store.getDb().prepare(
    `SELECT * FROM merge_queue_entries WHERE queue_id = ? ${all ? '' : `AND state NOT IN (${state.FINISHED_STATES.map(() => '?').join(',')})`} ORDER BY position`
  ).all(String(queueId), ...(all ? [] : state.FINISHED_STATES));
  return rows.map(_entry);
}

/**
 * The entry that holds the queue or is next to: the active one, otherwise the
 * queued entry submitted first.
 * @param {string} queueId - Queue id
 * @returns {object|null}
 */
function nextEntry(queueId) {
  return state.nextActive(listEntries(queueId, { includeFinished: false }));
}

/**
 * A queue's history in order, or one entry's.
 * @param {string} queueId - Queue id
 * @param {object} [options] - `{ entryId, afterSequence, limit }`; `limit` defaults to 500 and is capped at 2000
 * @returns {object[]}
 */
function listEvents(queueId, options = {}) {
  const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : 500, 1), 2000);
  const after = Number.isInteger(options.afterSequence) ? options.afterSequence : 0;
  const byEntry = options.entryId !== undefined && options.entryId !== null;
  const rows = store.getDb().prepare(
    `SELECT * FROM merge_queue_events WHERE queue_id = ? AND sequence > ? ${byEntry ? 'AND entry_id = ?' : ''} ORDER BY sequence LIMIT ?`
  ).all(String(queueId), after, ...(byEntry ? [String(options.entryId)] : []), limit);
  return rows.map(_event);
}

module.exports = {
  HALT_TREE_MISMATCH,
  createQueue,
  retireQueue,
  clearHalt,
  submitEntry,
  recordOperatorGate,
  beginAssembly,
  recordCandidate,
  discardCandidate,
  beginLanding,
  recordLandingNotMade,
  recordLanded,
  failEntry,
  withdrawEntry,
  getQueue,
  findActiveQueue,
  listQueues,
  getEntry,
  listEntries,
  nextEntry,
  listEvents,
  _internal
};
