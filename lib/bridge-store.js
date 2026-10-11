'use strict';

/*
 * Durable state of the Master-mediated operator bridge (ADR 0023, #2031).
 *
 * Everything the gateway remembers lives in the tables of lib/bridge-schema.js
 * and is read and written here. Callers pass decisions in; this module makes
 * each one atomic, idempotent on its request id, checked against the route's
 * version, and audited on first use, refusals included.
 */

const crypto = require('node:crypto');
const store = require('./store');
const { ROUTE_STATES, FAILURE_REASONS } = require('./bridge-schema');

/** Longest list a single read returns. */
const MAX_LIST = 100;

/** States in which a route still needs somebody's attention. */
const OPEN_ROUTE_STATES = Object.freeze(ROUTE_STATES.filter((s) => s !== 'closed'));

/**
 * Run `fn` as one write transaction.
 * @param {() => *} fn - Synchronous work.
 * @returns {*} Whatever `fn` returns.
 */
function transaction(fn) {
  const db = store.getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
}

/**
 * SHA-256 of a string, hex: the digest every bridge body and token is kept by.
 * @param {string} text - Input.
 * @returns {string}
 */
function digest(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * The current time as an ISO string; a seam so a caller can fix it.
 * @param {string} [at] - Explicit timestamp.
 * @returns {string}
 */
function _now(at) {
  return at || new Date().toISOString();
}

const settings = {
  /**
   * Read one bridge setting.
   * @param {string} key - Setting name.
   * @returns {string|null} The stored value, or null when unset.
   */
  get(key) {
    const row = store.getDb().prepare('SELECT value FROM bridge_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  /**
   * Write one bridge setting. The operator is the only writer there is.
   * @param {string} key - Setting name.
   * @param {string|null} value - New value.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  set(key, value, options = {}) {
    store.getDb().prepare(
      "INSERT INTO bridge_settings (key, value, updated_by, updated_at) VALUES (?, ?, 'operator', ?) "
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at'
    ).run(key, value, _now(options.at));
  },

  /**
   * Whether the operator has enabled the bridge. Off until they say otherwise.
   * @returns {boolean}
   */
  isEnabled() {
    return settings.get('enabled') === 'true';
  }
};

const masterCredentials = {
  /**
   * Record a newly minted credential's hash as the next generation, revoking
   * every generation still live. The new row is `pending` until the credential
   * is known to have reached the Master pane.
   * @param {string} credentialHash - SHA-256 of the credential, hex.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} The new generation.
   */
  mint(credentialHash, options = {}) {
    const at = _now(options.at);
    return transaction((db) => {
      db.prepare(
        "UPDATE bridge_master_credentials SET status = 'revoked', revoked_at = ?, revoke_reason = 'superseded' "
        + "WHERE status IN ('pending','active')"
      ).run(at);
      const next = db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS g FROM bridge_master_credentials').get().g;
      db.prepare(
        "INSERT INTO bridge_master_credentials (generation, credential_hash, status, minted_at) VALUES (?, ?, 'pending', ?)"
      ).run(next, credentialHash, at);
      return next;
    });
  },

  /**
   * Mark a pending generation as delivered to the Master pane. Named by its
   * hash as well as its number, so a handoff that settles late can only ever
   * touch the row it minted.
   * @param {number} generation - Generation to activate.
   * @param {string} credentialHash - SHA-256 of that generation's credential, hex.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {boolean} False when that generation is no longer pending.
   */
  activate(generation, credentialHash, options = {}) {
    const result = store.getDb().prepare(
      "UPDATE bridge_master_credentials SET status = 'active', delivered_at = ? "
      + "WHERE generation = ? AND credential_hash = ? AND status = 'pending'"
    ).run(_now(options.at), generation, credentialHash);
    return result.changes === 1;
  },

  /**
   * Revoke every live generation, or one named generation.
   * @param {string} reason - Closed reason code.
   * @param {object} [options]
   * @param {number} [options.generation] - Revoke only this generation; needs `credentialHash`.
   * @param {string} [options.credentialHash] - Hash of the generation being revoked.
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} How many generations were revoked.
   */
  revoke(reason, options = {}) {
    const at = _now(options.at);
    const db = store.getDb();
    const result = options.generation
      ? db.prepare(
        "UPDATE bridge_master_credentials SET status = 'revoked', revoked_at = ?, revoke_reason = ? "
        + "WHERE generation = ? AND credential_hash = ? AND status IN ('pending','active')"
      ).run(at, reason, options.generation, options.credentialHash)
      : db.prepare(
        "UPDATE bridge_master_credentials SET status = 'revoked', revoked_at = ?, revoke_reason = ? "
        + "WHERE status IN ('pending','active')"
      ).run(at, reason);
    return Number(result.changes);
  },

  /**
   * Revoke a generation still waiting for its handoff. Nothing carries a
   * handoff across a server restart, so a pending row found at boot can never
   * become active.
   * @param {string} reason - Closed reason code.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} How many generations were revoked.
   */
  revokePending(reason, options = {}) {
    const result = store.getDb().prepare(
      "UPDATE bridge_master_credentials SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE status = 'pending'"
    ).run(_now(options.at), reason);
    return Number(result.changes);
  },

  /**
   * The active generation, if the presented hash is its hash. Compared in
   * constant time against the one active row rather than looked up by value.
   * @param {string} credentialHash - SHA-256 of the presented credential, hex.
   * @returns {{generation: number, status: string}|null} Null unless the hash
   *   is the active generation's.
   */
  findActive(credentialHash) {
    const row = store.getDb().prepare(
      "SELECT generation, status, credential_hash FROM bridge_master_credentials WHERE status = 'active'"
    ).get();
    if (!row || typeof credentialHash !== 'string' || credentialHash.length !== row.credential_hash.length) return null;
    const same = crypto.timingSafeEqual(Buffer.from(credentialHash), Buffer.from(row.credential_hash));
    return same ? { generation: row.generation, status: row.status } : null;
  },

  /**
   * The live generation, if any, without its hash.
   * @returns {{generation: number, status: string, mintedAt: string, deliveredAt: (string|null)}|null}
   */
  live() {
    const row = store.getDb().prepare(
      "SELECT generation, status, minted_at, delivered_at FROM bridge_master_credentials WHERE status IN ('pending','active')"
    ).get();
    return row
      ? { generation: row.generation, status: row.status, mintedAt: row.minted_at, deliveredAt: row.delivered_at }
      : null;
  }
};

/**
 * Shape an audit row for callers.
 * @param {object} row - A `bridge_audit` row.
 * @returns {object}
 */
function _auditRow(row) {
  return {
    seq: row.audit_seq,
    op: row.op,
    requestId: row.request_id,
    actor: row.actor,
    proof: row.proof,
    masterGeneration: row.master_generation,
    routeId: row.route_id,
    expectedVersion: row.expected_version,
    outcome: row.outcome,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
    at: row.at
  };
}

const audit = {
  /**
   * Append one audit row. Call inside the transaction that made the change it
   * describes, so the two land or fail together.
   * @param {object} entry
   * @param {string} entry.op - Operation name.
   * @param {string|null} [entry.requestId] - Caller's idempotency key.
   * @param {string} entry.actor - Who acted.
   * @param {string} entry.proof - How the actor was verified.
   * @param {number|null} [entry.masterGeneration] - Master generation, when Master acted.
   * @param {string|null} [entry.routeId] - Route concerned.
   * @param {number|null} [entry.expectedVersion] - Version the caller named.
   * @param {string} entry.outcome - Closed outcome code.
   * @param {object|null} [entry.detail] - Small structured detail; never a body.
   * @param {string} [entry.at] - Timestamp override.
   * @returns {object} The stored row.
   */
  append(entry) {
    const db = store.getDb();
    const result = db.prepare(
      'INSERT INTO bridge_audit (op, request_id, actor, proof, master_generation, route_id, expected_version, outcome, detail_json, at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      entry.op, entry.requestId ?? null, entry.actor, entry.proof, entry.masterGeneration ?? null,
      entry.routeId ?? null, entry.expectedVersion ?? null, entry.outcome,
      entry.detail ? JSON.stringify(entry.detail) : null, _now(entry.at)
    );
    return _auditRow(db.prepare('SELECT * FROM bridge_audit WHERE audit_seq = ?').get(result.lastInsertRowid));
  },

  /**
   * The audit row a request id already produced for an operation.
   * @param {string} op - Operation name.
   * @param {string} requestId - Caller's idempotency key.
   * @returns {object|null}
   */
  findRequest(op, requestId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_audit WHERE op = ? AND request_id = ?').get(op, requestId);
    return row ? _auditRow(row) : null;
  },

  /**
   * Remove the oldest audit rows, folding them into the audit anchor.
   *
   * Takes the longest run from the start of the table in which every row is
   * older than `before` and belongs to no route that is still open, so a route
   * in progress never loses its history. The anchor is moved first, in the
   * same transaction: that is what permits the delete, and its count and
   * chained digest are all that remains of the rows afterwards. The anchor is
   * one row however many compactions run.
   * @param {object} options
   * @param {string} options.before - Remove rows written before this instant.
   * @param {string} [options.at] - Timestamp override.
   * @returns {{removed: number, throughSeq: (number|null), digest: (string|null)}}
   */
  compact(options) {
    const at = _now(options.at);
    return transaction((db) => {
      const blocker = db.prepare(
        'SELECT MIN(a.audit_seq) AS seq FROM bridge_audit a '
        + 'LEFT JOIN bridge_routes r ON r.route_id = a.route_id '
        + "WHERE a.at >= ? OR (r.route_id IS NOT NULL AND r.state <> 'closed')"
      ).get(options.before).seq;
      const rows = blocker === null
        ? db.prepare('SELECT * FROM bridge_audit ORDER BY audit_seq').all()
        : db.prepare('SELECT * FROM bridge_audit WHERE audit_seq < ? ORDER BY audit_seq').all(blocker);
      if (!rows.length) return { removed: 0, throughSeq: null, digest: null };
      const anchor = db.prepare('SELECT * FROM bridge_audit_anchor WHERE anchor_id = 1').get();
      const hash = crypto.createHash('sha256');
      hash.update(anchor.chain_digest || '');
      for (const row of rows) hash.update(`\n${JSON.stringify(row)}`);
      const digest = hash.digest('hex');
      const throughSeq = rows[rows.length - 1].audit_seq;
      db.prepare(
        'UPDATE bridge_audit_anchor SET through_seq = ?, removed_count = removed_count + ?, compactions = compactions + 1, '
        + 'chain_digest = ?, updated_at = ? WHERE anchor_id = 1'
      ).run(throughSeq, rows.length, digest, at);
      db.prepare('DELETE FROM bridge_audit WHERE audit_seq <= ?').run(throughSeq);
      return { removed: rows.length, throughSeq, digest };
    });
  },

  /**
   * What retention has removed from the audit so far.
   * @returns {{throughSeq: number, removedCount: number, compactions: number, chainDigest: (string|null), updatedAt: string}}
   */
  anchor() {
    const row = store.getDb().prepare('SELECT * FROM bridge_audit_anchor WHERE anchor_id = 1').get();
    return {
      throughSeq: row.through_seq, removedCount: row.removed_count, compactions: row.compactions,
      chainDigest: row.chain_digest, updatedAt: row.updated_at
    };
  },

  /**
   * Audit rows for one route, oldest first.
   * @param {string} routeId - Route id.
   * @returns {object[]}
   */
  forRoute(routeId) {
    return store.getDb().prepare('SELECT * FROM bridge_audit WHERE route_id = ? ORDER BY audit_seq')
      .all(routeId).map(_auditRow);
  },

  /**
   * Where the gateway suggested a route might go, when it handed the route to
   * the Master. A route is given one suggestion, when it arrives, and it is
   * never rewritten: a route that comes back to the Master after a failure
   * keeps the one it had. A suggestion is a record of what was found, never a
   * decision.
   * @param {string} routeId - Route id.
   * @returns {{by: (string|null), to: (string|null), projectId: (number|null), reason: (string|null)}|null}
   */
  suggestionFor(routeId) {
    const row = store.getDb().prepare(
      "SELECT detail_json FROM bridge_audit WHERE route_id = ? AND op = 'suggest' AND outcome = 'applied' ORDER BY audit_seq LIMIT 1"
    ).get(routeId);
    if (!row) return null;
    const d = JSON.parse(row.detail_json || '{}');
    return { by: d.by ?? null, to: d.to ?? null, projectId: d.projectId ?? null, reason: d.reason ?? null };
  },

  /**
   * Whether the operator wrote a message to `@master` by that name. Read from
   * what the gateway recorded when the message arrived, which is never
   * rewritten: a message addressed to a project, to a nickname, or to nothing
   * is not one, wherever the Master later routed it. Only the gateway's own
   * record counts, so no other writer's row could ever stand in for it; a
   * route with no such record is not one either.
   * @param {string} routeId - Route id.
   * @returns {boolean}
   */
  addressedToMaster(routeId) {
    const row = store.getDb().prepare(
      "SELECT detail_json FROM bridge_audit WHERE route_id = ? AND op = 'suggest' AND actor = 'gateway' AND outcome = 'applied' ORDER BY audit_seq LIMIT 1"
    ).get(routeId);
    if (!row) return false;
    const d = JSON.parse(row.detail_json || '{}');
    return d.reserved === true;
  },

  /**
   * The write that last changed a route: its operation and detail. What put
   * the route where it is now, from the record itself.
   * @param {string} routeId - Route id.
   * @returns {{op: string, detail: object}|null}
   */
  lastApplied(routeId) {
    const row = store.getDb().prepare(
      "SELECT op, detail_json FROM bridge_audit WHERE route_id = ? AND outcome = 'applied' AND actor IN ('master', 'gateway', 'operator') "
      + "AND op NOT IN ('adopted', 'launch') ORDER BY audit_seq DESC LIMIT 1"
    ).get(routeId);
    return row ? { op: row.op, detail: JSON.parse(row.detail_json || '{}') } : null;
  },

  /**
   * How the Master's scope last read, as the gateway recorded it: `scope-unresolved`,
   * `scope-resolved`, or null when it has never been recorded.
   * @returns {string|null}
   */
  lastScope() {
    const row = store.getDb().prepare("SELECT outcome FROM bridge_audit WHERE op = 'scope' ORDER BY audit_seq DESC LIMIT 1").get();
    return row ? row.outcome : null;
  }
};

/**
 * Shape a route row for callers. Carries no body. Every route passes through
 * here, so every route says what posted message it answers, or that it
 * answers none: `replyContext` is always present, and null when there is none.
 * @param {object} row - A `bridge_routes` row.
 * @returns {object}
 */
function _routeRow(row) {
  return _withReplyContext({
    routeId: row.route_id,
    externalId: row.external_id,
    context: {
      authorId: row.author_id, spaceId: row.space_id, channelId: row.channel_id,
      threadId: row.thread_id, replyToExternalId: row.reply_to_external_id
    },
    state: row.state,
    version: row.version,
    resolvedBy: row.resolved_by,
    destination: row.destination_kind
      ? { kind: row.destination_kind, projectId: row.destination_project_id, workspaceId: row.destination_workspace_id }
      : null,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pendingNoticeAt: row.pending_notice_at,
    masterWakeAt: row.master_wake_at,
    resolvedGeneration: row.resolved_generation,
    closedAt: row.closed_at,
    closedBy: row.closed_by
  });
}

/**
 * Add to a route which posted message it answers, when it answers one.
 * @param {object} route - A shaped route.
 * @returns {object} The route, with `replyContext` set or null.
 */
function _withReplyContext(route) {
  const row = store.getDb().prepare('SELECT * FROM bridge_route_reply_context WHERE route_id = ?').get(route.routeId);
  route.replyContext = row ? {
    repliedExternalId: row.replied_external_id, canonicalExternalId: row.canonical_external_id, outboundId: row.outbound_id,
    partIndex: row.part_index, partCount: row.part_count, kind: row.kind, notifyType: row.notify_type,
    routeId: row.replied_route_id, candidateId: row.candidate_id, candidateKind: row.candidate_kind,
    questionId: row.question_id
  } : null;
  return route;
}

const routes = {
  /**
   * Store one inbound operator message as a route, with its body beside it.
   * A second call with the same external id and the same message changes
   * nothing and returns the route the first call made. The same external id
   * with a different body or chat context is refused as a mismatch.
   * @param {object} input
   * @param {string} input.routeId - New route id.
   * @param {string} input.externalId - The chat's own message id.
   * @param {string} input.authorId - Chat author id.
   * @param {string} input.spaceId - Chat space (guild) id.
   * @param {string} input.channelId - Chat channel id.
   * @param {string|null} [input.threadId] - Chat thread id.
   * @param {string|null} [input.replyToExternalId] - Message this one answers.
   * @param {string} input.text - Message body.
   * @param {string} input.digest - SHA-256 of the body, hex.
   * @param {string} [input.at] - Timestamp override.
   * @returns {{created: boolean, mismatch: boolean, route: (object|null)}}
   */
  accept(input) {
    const at = _now(input.at);
    return transaction((db) => {
      const result = db.prepare(
        'INSERT INTO bridge_routes (route_id, external_id, author_id, space_id, channel_id, thread_id, '
        + 'reply_to_external_id, body_digest, state, created_at, updated_at) '
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?) ON CONFLICT(external_id) DO NOTHING"
      ).run(
        input.routeId, input.externalId, input.authorId, input.spaceId, input.channelId,
        input.threadId ?? null, input.replyToExternalId ?? null, input.digest, at, at
      );
      const created = result.changes === 1;
      const row = db.prepare('SELECT * FROM bridge_routes WHERE external_id = ?').get(input.externalId);
      if (!created) {
        // A replay is the same message again. The same id on a different
        // message, or from a different place, is not a replay and must not be
        // answered with somebody else's route.
        const same = row.body_digest === input.digest
          && row.author_id === input.authorId && row.space_id === input.spaceId
          && row.channel_id === input.channelId
          && (row.thread_id ?? null) === (input.threadId ?? null)
          && (row.reply_to_external_id ?? null) === (input.replyToExternalId ?? null);
        if (!same) return { created: false, mismatch: true, route: null };
      }
      if (created) {
        db.prepare(
          "INSERT INTO bridge_route_bodies (route_id, role, text, digest, created_at) VALUES (?, 'inbound', ?, ?, ?) "
          + 'ON CONFLICT(route_id, role) DO NOTHING'
        ).run(input.routeId, input.text, input.digest, at);
        // If this answers a message the helper posted, say which, now and
        // for good: what it answers is a fact about the message, fixed when
        // it arrives, not something to work out again later.
        const answered = input.replyToExternalId ? parts.find(input.replyToExternalId) : null;
        if (answered) {
          db.prepare(
            'INSERT INTO bridge_route_reply_context (route_id, replied_external_id, canonical_external_id, outbound_id, part_index, part_count, '
            + 'kind, notify_type, replied_route_id, candidate_id, candidate_kind, question_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(
            input.routeId, answered.externalId, answered.canonicalExternalId, answered.outboundId, answered.partIndex, answered.partCount,
            answered.kind, answered.notifyType, answered.routeId, answered.candidateId, answered.candidateKind, answered.questionId, at
          );
        }
      }
      return { created, mismatch: false, route: _routeRow(row) };
    });
  },

  /**
   * One route by id.
   * @param {string} routeId - Route id.
   * @returns {object|null}
   */
  get(routeId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_routes WHERE route_id = ?').get(routeId);
    return row ? _routeRow(row) : null;
  },

  /**
   * Routes in the given states, oldest first.
   * @param {object} [options]
   * @param {string[]} [options.states] - States to include; open states by default.
   * @param {number} [options.limit] - At most this many, capped at {@link MAX_LIST}.
   * @returns {object[]}
   */
  list(options = {}) {
    const states = (options.states && options.states.length ? options.states : OPEN_ROUTE_STATES)
      .filter((s) => ROUTE_STATES.includes(s));
    if (!states.length) return [];
    const limit = Math.min(Math.max(Number(options.limit) || MAX_LIST, 1), MAX_LIST);
    return store.getDb().prepare(
      `SELECT * FROM bridge_routes WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at, route_id LIMIT ?`
    ).all(...states, limit).map(_routeRow);
  },

  /**
   * The bodies held for a route. A cleared body has `text: null`.
   * @param {string} routeId - Route id.
   * @returns {{role: string, text: (string|null), digest: string, clearedAt: (string|null)}[]}
   */
  bodies(routeId) {
    return store.getDb().prepare(
      'SELECT role, text, digest, cleared_at FROM bridge_route_bodies WHERE route_id = ? ORDER BY body_id'
    ).all(routeId).map((r) => ({ role: r.role, text: r.text, digest: r.digest, clearedAt: r.cleared_at }));
  },

  /**
   * The route an external chat message id belongs to.
   * @param {string} externalId - The chat's own message id.
   * @returns {object|null}
   */
  getByExternalId(externalId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_routes WHERE external_id = ?').get(externalId);
    return row ? _routeRow(row) : null;
  },

  /**
   * Store or replace one body of a route. Call inside the route's write.
   * @param {string} routeId - Route id.
   * @param {('inbound'|'reply'|'answer')} role - Which body.
   * @param {string} text - Body text.
   * @param {string} digest - SHA-256 of the text, hex.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  putBody(routeId, role, text, digest, options = {}) {
    store.getDb().prepare(
      'INSERT INTO bridge_route_bodies (route_id, role, text, digest, created_at) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(route_id, role) DO UPDATE SET text = excluded.text, digest = excluded.digest, '
      + 'created_at = excluded.created_at, cleared_at = NULL'
    ).run(routeId, role, text, digest, _now(options.at));
  },

  /**
   * One held body of a route.
   * @param {string} routeId - Route id.
   * @param {string} role - Which body.
   * @returns {{text: (string|null), digest: string}|null}
   */
  body(routeId, role) {
    const row = store.getDb().prepare('SELECT text, digest FROM bridge_route_bodies WHERE route_id = ? AND role = ?').get(routeId, role);
    return row ? { text: row.text, digest: row.digest } : null;
  },

  /**
   * Record when the Master was last told about a route. The gateway's
   * bookkeeping, so it does not change the route's version.
   * @param {string} routeId - Route id.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  noteMasterTold(routeId, options = {}) {
    store.getDb().prepare('UPDATE bridge_routes SET master_wake_at = ? WHERE route_id = ?').run(_now(options.at), routeId);
  },

  /**
   * Clear every body still held for a route, keeping the digests.
   * @param {string} routeId - Route id.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} How many bodies were cleared.
   */
  clearBodies(routeId, options = {}) {
    const result = store.getDb().prepare(
      'UPDATE bridge_route_bodies SET text = NULL, cleared_at = ? WHERE route_id = ? AND text IS NOT NULL'
    ).run(_now(options.at), routeId);
    return Number(result.changes);
  }
};

const proofs = {
  /**
   * Record which Hub message belongs to a route, and under what proof.
   * @param {object} proof
   * @param {string} proof.routeId - Route id.
   * @param {('to-target'|'from-target')} proof.direction - Which way the message went.
   * @param {string} proof.hubId - The Hub's id for the message.
   * @param {string|null} [proof.exchangeId] - The Medusa exchange id.
   * @param {string|null} [proof.inReplyToHubId] - The bridge message a reply answers.
   * @param {('master-launch'|'gateway'|'launch')} proof.senderProof - How the sender was verified.
   * @param {number|null} [proof.masterGeneration] - Master generation, for `master-launch`.
   * @param {number|null} [proof.senderProjectId] - Replying project.
   * @param {string|null} [proof.senderLaunchId] - Replying launch.
   * @param {number|null} [proof.targetProjectId] - Project a sent message went to.
   * @param {string|null} [proof.targetWorkspaceId] - Workspace a sent message went to.
   * @param {number|null} [proof.targetSessionId] - Session a sent message went to.
   * @param {string|null} [proof.targetLaunchId] - That session's launch.
   * @param {string} [proof.at] - Timestamp override.
   * @returns {void}
   */
  record(proof) {
    store.getDb().prepare(
      'INSERT INTO bridge_route_proofs (route_id, direction, hub_id, exchange_id, in_reply_to_hub_id, sender_proof, '
      + 'master_generation, sender_project_id, sender_launch_id, target_project_id, target_workspace_id, target_session_id, '
      + 'target_launch_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      proof.routeId, proof.direction, proof.hubId, proof.exchangeId ?? null, proof.inReplyToHubId ?? null,
      proof.senderProof, proof.masterGeneration ?? null, proof.senderProjectId ?? null, proof.senderLaunchId ?? null,
      proof.targetProjectId ?? null, proof.targetWorkspaceId ?? null, proof.targetSessionId ?? null,
      proof.targetLaunchId ?? null,
      _now(proof.at)
    );
  },

  /**
   * The proof row for a Hub message.
   * @param {string} hubId - Hub message id.
   * @returns {{routeId: string, direction: string, hubId: string, exchangeId: (string|null), senderProof: string, targetWorkspaceId: (string|null), targetSessionId: (number|null), targetLaunchId: (string|null)}|null}
   */
  byHubId(hubId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_route_proofs WHERE hub_id = ?').get(hubId);
    return row
      ? {
        routeId: row.route_id, direction: row.direction, hubId: row.hub_id, exchangeId: row.exchange_id,
        senderProof: row.sender_proof, targetProjectId: row.target_project_id, targetWorkspaceId: row.target_workspace_id,
        targetSessionId: row.target_session_id, targetLaunchId: row.target_launch_id
      }
      : null;
  },

  /**
   * The proof row for a Medusa exchange.
   * @param {string} exchangeId - Exchange id.
   * @returns {object|null} As {@link proofs.byHubId} returns it.
   */
  byExchangeId(exchangeId) {
    const row = store.getDb().prepare('SELECT hub_id FROM bridge_route_proofs WHERE exchange_id = ?').get(exchangeId);
    return row ? proofs.byHubId(row.hub_id) : null;
  },

  /**
   * The newest message the bridge sent to a route's destination.
   * @param {string} routeId - Route id.
   * @returns {{hubId: string, exchangeId: (string|null)}|null}
   */
  latestToTarget(routeId) {
    const row = store.getDb().prepare(
      "SELECT hub_id, exchange_id FROM bridge_route_proofs WHERE route_id = ? AND direction = 'to-target' ORDER BY proof_id DESC LIMIT 1"
    ).get(routeId);
    return row ? { hubId: row.hub_id, exchangeId: row.exchange_id } : null;
  }
};

/**
 * Shape an outbound row for callers.
 * @param {object} row - A `bridge_outbound` row.
 * @returns {object}
 */
function _outboundRow(row) {
  return {
    outboundId: row.outbound_id,
    idemKey: row.idem_key,
    kind: row.kind,
    notifyType: row.notify_type,
    routeId: row.route_id,
    questionId: row.question_id,
    sourceLabel: row.source_label,
    text: row.text,
    state: row.state,
    dropCode: row.drop_code,
    blockCode: row.block_code,
    attempts: row.attempts,
    deliveredRef: row.delivered_ref,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at
  };
}

/**
 * The only sentences a status item may carry (ADR 0023 Decisions 4 and 17).
 * Transport control the server wrote, not content.
 */
const STATUS_TEXT = Object.freeze({
  pending: 'Still waiting on an answer to your message. Nothing is lost; you will get it here.',
  'master-unavailable': 'Your message is queued: the Project Master is not available right now.'
});

const outbound = {
  /**
   * Queue one item for the helper. A second call with the same idempotency
   * key changes nothing and returns the item the first call made.
   * @param {object} item
   * @param {string} item.idemKey - The item's own idempotency key.
   * @param {('reply'|'notification'|'failure'|'candidate'|'question')} item.kind - Which kind. A status item goes through `enqueueStatus`.
   * @param {string|null} [item.notifyType] - Notification type.
   * @param {string|null} [item.routeId] - Route it belongs to.
   * @param {string|null} [item.candidateId] - Candidate it was approved from.
   * @param {string} item.sourceLabel - Compact source label shown with it.
   * @param {string} item.text - What to post.
   * @param {string} item.digest - SHA-256 of the text, hex.
   * @param {number|null} [item.releasedGeneration] - Master generation that released it.
   * @param {string|null} [item.questionId] - The question a `question` item asks.
   * @param {string} [item.at] - Timestamp override.
   * @returns {object} The stored item.
   */
  enqueue(item) {
    if (item.kind === 'status') throw new Error('a status item carries fixed text: use enqueueStatus');
    const at = _now(item.at);
    const db = store.getDb();
    db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, notify_type, route_id, candidate_id, question_id, source_label, text, digest, state, '
      + "released_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?) "
      + 'ON CONFLICT(idem_key) DO NOTHING'
    ).run(
      item.idemKey, item.kind, item.notifyType ?? null, item.routeId ?? null, item.candidateId ?? null, item.questionId ?? null, item.sourceLabel,
      item.text, item.digest, item.releasedGeneration ?? null, at, at
    );
    return _outboundRow(db.prepare('SELECT * FROM bridge_outbound WHERE idem_key = ?').get(item.idemKey));
  },

  /**
   * Queue the one status notice a route may have. The text is one of the
   * fixed sentences the server wrote, chosen by name: a status item carries
   * nobody's prose. A route has one notice in its life: the route records
   * when it was raised, and that record, not the notice's row, is what a
   * second attempt is refused on.
   * @param {string} routeId - Route id.
   * @param {('pending'|'master-unavailable')} which - Which fixed notice.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {{created: boolean, item: (object|null)}} `item` is null once the notice's row has been removed.
   */
  enqueueStatus(routeId, which, options = {}) {
    const text = STATUS_TEXT[which];
    if (!text) throw new Error(`unknown status notice "${which}"`);
    const at = _now(options.at);
    return transaction((db) => {
      // The route itself remembers that it has had its notice. The notice's
      // own row is not the record: it is let go and later removed, and a
      // route may stay open long after that.
      const claimed = db.prepare(
        'UPDATE bridge_routes SET pending_notice_at = ? WHERE route_id = ? AND pending_notice_at IS NULL'
      ).run(at, routeId).changes === 1;
      if (claimed) {
        db.prepare(
          'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
          + "VALUES (?, 'status', ?, 'TangleClaw', ?, ?, 'ready', ?, ?)"
        ).run(`route:${routeId}:pending`, routeId, text, digest(text), at, at);
      }
      const row = db.prepare("SELECT * FROM bridge_outbound WHERE route_id = ? AND kind = 'status'").get(routeId);
      return { created: claimed, item: row ? _outboundRow(row) : null };
    });
  },

  /**
   * Items waiting for the helper, oldest first.
   * @param {object} [options]
   * @param {number} [options.limit] - At most this many, capped at {@link MAX_LIST}.
   * @returns {object[]}
   */
  ready(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), MAX_LIST);
    return store.getDb().prepare("SELECT * FROM bridge_outbound WHERE state = 'ready' ORDER BY outbound_id LIMIT ?")
      .all(limit).map(_outboundRow);
  },

  /**
   * One item by id.
   * @param {number} outboundId - Item id.
   * @returns {object|null}
   */
  get(outboundId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_outbound WHERE outbound_id = ?').get(outboundId);
    return row ? _outboundRow(row) : null;
  },

  /**
   * Whether a request is bound to an item: it names a lease that exists, was
   * issued for this item, and was issued to the token presenting it. This is
   * answered before anything about the item is: a caller that does not hold
   * the lease learns nothing of what became of the item, not even whether
   * there is one.
   * @param {number} outboundId - Item id.
   * @param {{leaseId: string, tokenId: string}} ack - What the caller presents.
   * @returns {object|('lease-not-found'|'lease-not-yours')} The lease row, or why not.
   */
  binding(outboundId, ack) {
    const lease = store.getDb().prepare('SELECT * FROM bridge_outbound_leases WHERE lease_id = ?').get(ack.leaseId);
    if (!lease || lease.outbound_id !== outboundId) return 'lease-not-found';
    return lease.token_id === ack.tokenId ? lease : 'lease-not-yours';
  },

  /**
   * Whether a lease is live at an instant: not settled, and inside its window.
   * A lease that is not live is told that and nothing else, on every route:
   * not whether its item was delivered, set aside, withdrawn or let go.
   * Holding a lease once is not holding it now. (An item never changes state
   * under a live lease: nothing lets go of, withdraws, sets aside or delivers
   * an item without settling the lease first, so a live lease's item waits.)
   * @param {object} lease - The lease row, from {@link outbound.binding}.
   * @param {string} at - The current instant, ISO.
   * @returns {boolean}
   */
  live(lease, at) {
    return lease.state === 'live' && lease.expires_at >= at;
  },

  /**
   * What an acknowledgement would do, without doing it. An acknowledgement
   * names the lease the item was handed over under and every message the
   * chat made for it, in order.
   *
   * The binding is judged first (see {@link outbound.binding}). Then there is
   * one thing a settled lease may still learn: the lease that sealed a
   * delivery is that delivery's receipt, kept as long as the item is, and an
   * exact repeat of its acknowledgement is answered as a repeat. Every other
   * lease that is not live has lapsed, and is told so and nothing more. For a
   * live lease, a set that disagrees with a part already recorded for the
   * item, or names a message the bridge knows as something else, is refused.
   * @param {number} outboundId - Item id.
   * @param {string[]} partIds - The chat's id for each posted message, in order.
   * @param {object} ack
   * @param {string} ack.leaseId - The lease the item was claimed under.
   * @param {string} ack.tokenId - The helper token presenting it.
   * @param {string} ack.at - The current instant, ISO.
   * @returns {('deliverable'|'already-delivered'|'reference-mismatch'|'lease-not-found'|'lease-not-yours'|'lease-lapsed'|'part-mismatch'|'part-collision')}
   */
  ackVerdict(outboundId, partIds, ack) {
    const lease = outbound.binding(outboundId, ack);
    if (typeof lease === 'string') return lease;
    const recorded = parts.forItem(outboundId);
    if (lease.state === 'used') {
      return recorded.length === partIds.length && recorded.every((id, i) => id === partIds[i]) ? 'already-delivered' : 'reference-mismatch';
    }
    if (!outbound.live(lease, ack.at)) return 'lease-lapsed';
    if (recorded.length > partIds.length || recorded.some((id, i) => id !== partIds[i])) return 'part-mismatch';
    if (recorded.length && parts.countFor(outboundId) !== partIds.length) return 'part-mismatch';
    return partIds.slice(recorded.length).some((id) => parts.known(id)) ? 'part-collision' : 'deliverable';
  },

  /**
   * Record that the chat confirmed an item was posted: mark it delivered,
   * drop its text, record any message not yet recorded for it, and settle the
   * lease it was posted under. The first message's id is the item's
   * reference. The set seals the item: it must be whole and agree with every
   * part recorded so far.
   *
   * Repeating it with the same messages changes nothing; different ones are
   * refused. Call inside a transaction: the writes land together or not at all.
   * @param {number} outboundId - Item id.
   * @param {string[]} partIds - The chat's id for each posted message, in order.
   * @param {object} ack
   * @param {string} ack.leaseId - The lease the item was claimed under.
   * @param {string} ack.tokenId - The helper token presenting it.
   * @param {string} [ack.at] - Timestamp override.
   * @returns {{outcome: string, item: (object|null)}} `outcome` is `delivered`, a refusal from
   *   {@link outbound.ackVerdict}, or `item-not-ready` when the item was not there to be delivered.
   */
  markDelivered(outboundId, partIds, ack) {
    const at = _now(ack.at);
    const db = store.getDb();
    const verdict = outbound.ackVerdict(outboundId, partIds, { ...ack, at });
    if (verdict !== 'deliverable') return { outcome: verdict, item: outbound.get(outboundId) };
    // The item first, and nothing else until it is known to have moved: an
    // item that is no longer `ready` (set aside, withdrawn, removed) is not
    // delivered by being told so, and nothing is recorded as if it were.
    const moved = Number(db.prepare(
      "UPDATE bridge_outbound SET state = 'delivered', delivered_ref = ?, delivered_at = ?, updated_at = ?, text = NULL "
      + "WHERE outbound_id = ? AND state = 'ready'"
    ).run(partIds[0], at, at, outboundId).changes);
    if (moved !== 1) {
      // No row moved. That is a delivery only when the item is already in
      // exactly the state this call would have left it in: delivered, under
      // this first message, with this same list of messages.
      const row = db.prepare('SELECT state, delivered_ref FROM bridge_outbound WHERE outbound_id = ?').get(outboundId);
      const recorded = parts.forItem(outboundId);
      const identical = Boolean(row) && row.state === 'delivered' && row.delivered_ref === partIds[0]
        && recorded.length === partIds.length && recorded.every((id, i) => id === partIds[i]);
      return { outcome: identical ? 'delivered' : 'item-not-ready', item: outbound.get(outboundId) };
    }
    const recorded = parts.forItem(outboundId).length;
    partIds.slice(recorded).forEach((id, offset) => parts.insert(outboundId, recorded + offset, partIds.length, id, at));
    db.prepare("UPDATE bridge_outbound_leases SET state = 'used', settled_at = ? WHERE lease_id = ? AND state = 'live'").run(at, ack.leaseId);
    return { outcome: 'delivered', item: outbound.get(outboundId) };
  },

  /**
   * Set an item aside: the helper reported it cannot be posted, for a reason
   * a retry will not fix. It is handed to nobody until Master or the operator
   * requeues it or withdraws it. The lease it was held under is settled.
   * @param {number} outboundId - Item id.
   * @param {string} reason - One of the schema's `BLOCK_CODES`.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {boolean} Whether this call set it aside.
   */
  block(outboundId, reason, options = {}) {
    const at = _now(options.at);
    const db = store.getDb();
    const changed = db.prepare(
      "UPDATE bridge_outbound SET state = 'blocked', block_code = ?, updated_at = ? WHERE outbound_id = ? AND state = 'ready'"
    ).run(reason, at, outboundId).changes === 1;
    if (changed) {
      db.prepare("UPDATE bridge_outbound_leases SET state = 'lapsed', settled_at = ? WHERE outbound_id = ? AND state = 'live'").run(at, outboundId);
    }
    return changed;
  },

  /**
   * Items set aside, oldest first.
   * @returns {object[]}
   */
  blocked() {
    return store.getDb().prepare("SELECT * FROM bridge_outbound WHERE state = 'blocked' ORDER BY outbound_id LIMIT ?")
      .all(MAX_LIST).map(_outboundRow);
  },

  /**
   * Whether any undelivered item of a route is in a helper's hands right now.
   * @param {string} routeId - Route id.
   * @returns {boolean}
   */
  inFlight(routeId) {
    return Boolean(store.getDb().prepare(
      "SELECT 1 FROM bridge_outbound o JOIN bridge_outbound_leases l ON l.outbound_id = o.outbound_id AND l.state = 'live' "
      + "WHERE o.route_id = ? AND o.state IN ('ready','blocked') LIMIT 1"
    ).get(routeId));
  },

  /**
   * Withdraw every undelivered item of a route: it will not be posted. What
   * was already delivered is history and stays as it is.
   * @param {string} routeId - Route id.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} How many were withdrawn.
   */
  withdrawForRoute(routeId, options = {}) {
    const at = _now(options.at);
    return _withdraw("route_id = ? AND state IN ('ready','blocked')", [routeId], at);
  }
};

/** The most messages one item may be posted as. */
const MAX_PARTS = 32;

const parts = {
  /**
   * The item a posted message is a part of, by the chat's id for that
   * message. Answers after the item itself has been removed.
   * @param {string} externalId - The chat's id for a message the helper posted.
   * @returns {{externalId: string, canonicalExternalId: string, outboundId: number, partIndex: number, partCount: number, kind: string, notifyType: (string|null), routeId: (string|null), candidateId: (string|null), candidateKind: (string|null), questionId: (string|null)}|null}
   */
  find(externalId) {
    const db = store.getDb();
    const row = db.prepare('SELECT * FROM bridge_outbound_parts WHERE part_external_id = ?').get(externalId);
    if (!row) return null;
    const first = db.prepare('SELECT part_external_id FROM bridge_outbound_parts WHERE outbound_id = ? AND part_index = 0').get(row.outbound_id);
    return {
      externalId: row.part_external_id, canonicalExternalId: first.part_external_id, outboundId: row.outbound_id,
      partIndex: row.part_index, partCount: row.part_count, kind: row.kind, notifyType: row.notify_type,
      routeId: row.route_id, candidateId: row.candidate_id, candidateKind: row.candidate_kind, questionId: row.question_id
    };
  },

  /**
   * The chat's id for each message recorded for an item, in order.
   * @param {number} outboundId - Item id.
   * @returns {string[]}
   */
  forItem(outboundId) {
    return store.getDb().prepare('SELECT part_external_id FROM bridge_outbound_parts WHERE outbound_id = ? ORDER BY part_index')
      .all(outboundId).map((row) => row.part_external_id);
  },

  /**
   * How many messages an item is to be posted as, by what its recorded parts say.
   * @param {number} outboundId - Item id.
   * @returns {number|null} Null when no part is recorded yet.
   */
  countFor(outboundId) {
    const row = store.getDb().prepare('SELECT part_count FROM bridge_outbound_parts WHERE outbound_id = ? LIMIT 1').get(outboundId);
    return row ? row.part_count : null;
  },

  /**
   * Whether the bridge already knows a chat message id, as a part of some
   * item or as a message the operator sent.
   * @param {string} externalId - A chat message id.
   * @returns {boolean}
   */
  known(externalId) {
    return Boolean(store.getDb().prepare(
      'SELECT 1 FROM bridge_outbound_parts WHERE part_external_id = ? UNION ALL SELECT 1 FROM bridge_routes WHERE external_id = ?'
    ).get(externalId, externalId));
  },

  /**
   * Write one part's row, with what its item is, taken from the item.
   * @param {number} outboundId - Item id.
   * @param {number} index - The part's position, from 0.
   * @param {number} count - How many parts the item has.
   * @param {string} externalId - The chat's id for the posted message.
   * @param {string} at - The current instant, ISO.
   * @returns {void}
   */
  insert(outboundId, index, count, externalId, at) {
    const db = store.getDb();
    const item = db.prepare(
      'SELECT o.kind, o.notify_type, o.route_id, o.candidate_id, o.question_id, c.kind AS candidate_kind FROM bridge_outbound o '
      + 'LEFT JOIN bridge_candidates c ON c.candidate_id = o.candidate_id WHERE o.outbound_id = ?'
    ).get(outboundId);
    db.prepare(
      'INSERT INTO bridge_outbound_parts (part_external_id, outbound_id, part_index, part_count, kind, notify_type, route_id, candidate_id, '
      + 'candidate_kind, question_id, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(externalId, outboundId, index, count, item.kind, item.notify_type, item.route_id, item.candidate_id, item.candidate_kind, item.question_id, at);
  },

  /**
   * Record one posted message for an item, as soon as the chat confirms it.
   * From then on a reply to that message is known for what it answers, and a
   * helper that picks the item up again is told the part is already posted.
   *
   * Bound like an acknowledgement: only the lease's own token, only while the
   * lease is live and the item still waits. Parts are recorded in order.
   * Repeating a part exactly changes nothing; a different message for a part
   * already recorded, a different count, or a message the bridge knows as
   * something else, is refused.
   * @param {number} outboundId - Item id.
   * @param {{index: number, count: number, externalId: string}} part - The part.
   * @param {object} ack
   * @param {string} ack.leaseId - The lease the item was claimed under.
   * @param {string} ack.tokenId - The helper token presenting it.
   * @param {string} [ack.at] - Timestamp override.
   * @returns {('recorded'|'replayed'|'lease-not-found'|'lease-not-yours'|'lease-lapsed'|'part-mismatch'|'part-out-of-order'|'part-collision')}
   */
  receipt(outboundId, part, ack) {
    const at = _now(ack.at);
    const lease = outbound.binding(outboundId, ack);
    if (typeof lease === 'string') return lease;
    if (!outbound.live(lease, at)) return 'lease-lapsed';
    const recorded = parts.forItem(outboundId);
    const count = parts.countFor(outboundId);
    if (count !== null && count !== part.count) return 'part-mismatch';
    if (part.index < recorded.length) return recorded[part.index] === part.externalId ? 'replayed' : 'part-mismatch';
    if (part.index !== recorded.length) return 'part-out-of-order';
    if (parts.known(part.externalId)) return 'part-collision';
    parts.insert(outboundId, part.index, part.count, part.externalId, at);
    return 'recorded';
  }
};

/** How long the helper has to post an item it claimed and say so. */
const LEASE_MS = 2 * 60 * 1000;

/** The most items one claim hands over. */
const MAX_CLAIM = 20;

/**
 * Shape a lease row joined to its item.
 * @param {object} row - The item's columns with the lease's beside them; the lease's state as `lease_state`.
 * @returns {object}
 */
function _leaseRow(row) {
  return {
    leaseId: row.lease_id, claimNonce: row.claim_nonce, outboundId: row.outbound_id, itemDigest: row.item_digest,
    tokenId: row.token_id, state: row.lease_state, issuedAt: row.issued_at, expiresAt: row.expires_at, settledAt: row.settled_at,
    item: _outboundRow(row)
  };
}

const leases = {
  /**
   * Settle every lease whose window has passed. Its item, if still waiting,
   * is then free to be claimed again.
   * @param {object} [options]
   * @param {string} [options.at] - The current instant, ISO.
   * @returns {number} How many lapsed.
   */
  lapse(options = {}) {
    const at = _now(options.at);
    return Number(store.getDb().prepare(
      "UPDATE bridge_outbound_leases SET state = 'lapsed', settled_at = ? WHERE state = 'live' AND expires_at < ?"
    ).run(at, at).changes);
  },

  /**
   * The leases one claim issued, oldest item first, each with its item as it
   * is now.
   * @param {string} nonce - The claim's nonce.
   * @returns {object[]}
   */
  forClaim(nonce) {
    return store.getDb().prepare(
      'SELECT o.*, l.lease_id, l.claim_nonce, l.item_digest, l.token_id, l.state AS lease_state, l.issued_at, l.expires_at, l.settled_at '
      + 'FROM bridge_outbound_leases l JOIN bridge_outbound o ON o.outbound_id = l.outbound_id WHERE l.claim_nonce = ? ORDER BY l.outbound_id'
    ).all(nonce).map(_leaseRow);
  },

  /**
   * Hand waiting items to the helper, each under a lease of its own.
   *
   * A claim is named by its nonce and belongs to the token that made it.
   * Repeating a claim exactly returns the leases it issued the first time and
   * issues nothing: a helper that never saw the answer asks again and gets
   * the same one. The same nonce from another token, with a different
   * request, or already used by another helper write, is a conflict.
   *
   * Leases whose window has passed lapse first, and what waited past its
   * limit is let go first, so a lease is only ever issued for an item still
   * inside its limit. An item holds at most one live lease.
   * @param {object} request
   * @param {string} request.nonce - The request's nonce.
   * @param {string} request.tokenId - The helper token making it.
   * @param {number} [request.limit] - At most this many, capped at {@link MAX_CLAIM}.
   * @param {string} [request.at] - Timestamp override.
   * @returns {{outcome: ('claimed'|'replayed'|'nonce-conflict'), leases: object[]}}
   */
  claim(request) {
    const at = _now(request.at);
    const limit = Math.min(Math.max(Number(request.limit) || 10, 1), MAX_CLAIM);
    const requestDigest = digest(JSON.stringify({ limit }));
    expire({ now: at });
    return transaction((db) => {
      const prior = db.prepare('SELECT token_id, request_digest FROM bridge_outbound_claims WHERE claim_nonce = ?').get(request.nonce);
      if (prior) {
        const same = prior.token_id === request.tokenId && prior.request_digest === requestDigest;
        return same ? { outcome: 'replayed', leases: leases.forClaim(request.nonce) } : { outcome: 'nonce-conflict', leases: [] };
      }
      if (!nonces.claim(request.nonce, { at })) return { outcome: 'nonce-conflict', leases: [] };
      db.prepare('INSERT INTO bridge_outbound_claims (claim_nonce, token_id, request_digest, claimed_at) VALUES (?, ?, ?, ?)')
        .run(request.nonce, request.tokenId, requestDigest, at);
      const free = db.prepare(
        "SELECT outbound_id, digest FROM bridge_outbound o WHERE state = 'ready' "
        + "AND NOT EXISTS (SELECT 1 FROM bridge_outbound_leases l WHERE l.outbound_id = o.outbound_id AND l.state = 'live') "
        + 'ORDER BY outbound_id LIMIT ?'
      ).all(limit);
      const issue = db.prepare(
        'INSERT INTO bridge_outbound_leases (lease_id, claim_nonce, outbound_id, item_digest, token_id, state, issued_at, expires_at) '
        + "VALUES (?, ?, ?, ?, ?, 'live', ?, ?)"
      );
      const expiresAt = new Date(Date.parse(at) + LEASE_MS).toISOString();
      // Counted once for each hand-over. A claim that is repeated under its
      // nonce hands nothing over, so it never reaches this line.
      const handedOver = db.prepare('UPDATE bridge_outbound SET attempts = attempts + 1 WHERE outbound_id = ?');
      for (const item of free) {
        issue.run(`bol_${crypto.randomBytes(16).toString('base64url')}`, request.nonce, item.outbound_id, item.digest, request.tokenId, at, expiresAt);
        handedOver.run(item.outbound_id);
      }
      return { outcome: 'claimed', leases: leases.forClaim(request.nonce) };
    });
  }
};

/**
 * Withdraw outbound items: they will not be posted, and their text is dropped.
 * The one statement every withdrawal goes through, so an item withdrawn by a
 * close, by a decision or by a circuit reset ends in exactly the same state.
 * @param {string} where - SQL condition choosing the items; trusted, never caller text.
 * @param {Array} params - Values for the condition's placeholders.
 * @param {string} at - The current instant, ISO.
 * @returns {number} How many were withdrawn.
 */
function _withdraw(where, params, at) {
  const db = store.getDb();
  const withdrawn = Number(db.prepare(
    `UPDATE bridge_outbound SET state = 'dropped', drop_code = 'withdrawn', block_code = NULL, text = NULL, updated_at = ? WHERE ${where}`
  ).run(at, ...params).changes);
  // A question whose text will now never be posted cannot be answered: it
  // ends here, whoever withdrew the item, so the message can be asked about again.
  if (withdrawn) {
    db.prepare(
      "UPDATE bridge_questions SET state = 'cancelled', settled_at = ? WHERE state = 'open' AND question_id IN ("
      + "SELECT question_id FROM bridge_outbound WHERE kind = 'question' AND state = 'dropped' AND drop_code = 'withdrawn')"
    ).run(at);
  }
  return withdrawn;
}

/**
 * The released routes whose unposted answer a withdrawal is about to take:
 * the routes {@link _closeRoutesOfWithdrawnAnswers} will close afterwards,
 * withdrawing everything else queued for them.
 * @param {string} where - SQL condition over `bridge_outbound o` naming the items to be withdrawn.
 * @param {Array} params - Its parameters.
 * @returns {string[]} Route ids.
 */
function _routesAnswerWithdrawalWouldClose(where, params) {
  return store.getDb().prepare(
    "SELECT DISTINCT o.route_id FROM bridge_outbound o JOIN bridge_routes r ON r.route_id = o.route_id "
    + `WHERE r.state = 'released' AND o.kind = 'reply' AND o.state IN ('ready','blocked') AND ${where} ORDER BY o.route_id`
  ).all(...params).map((row) => row.route_id);
}

/**
 * Close every route whose answer was withdrawn before it was posted. Call
 * inside the transaction that withdrew it.
 *
 * A released route is waiting for one thing, its answer being posted. Once
 * that answer is withdrawn nothing is coming, so the route does not stay
 * `released` with its text held: it is closed by whoever withdrew the answer
 * and its text is cleared, exactly as a close would have done. The operator
 * writes again to be answered again.
 * @param {object} who
 * @param {('master'|'operator')} who.actor - Who withdrew.
 * @param {string} who.proof - The proof they came in under.
 * @param {number|null} [who.masterGeneration] - The Master generation, for a Master write.
 * @param {object} [who.detail] - What the write's own audit row carries about who made it; never a secret.
 * @param {string} at - The current instant, ISO.
 * @returns {string[]} The routes closed.
 */
function _closeRoutesOfWithdrawnAnswers(who, at) {
  const db = store.getDb();
  const left = db.prepare(
    "SELECT r.route_id, r.version, o.outbound_id FROM bridge_routes r JOIN bridge_outbound o ON o.route_id = r.route_id "
    + "WHERE r.state = 'released' AND o.kind = 'reply' AND o.state = 'dropped' AND o.drop_code = 'withdrawn' ORDER BY r.route_id"
  ).all();
  for (const row of left) {
    db.prepare("UPDATE bridge_routes SET state = 'closed', closed_by = ?, closed_at = ?, version = version + 1, updated_at = ? WHERE route_id = ? AND version = ?")
      .run(who.actor, at, at, row.route_id, row.version);
    // Whatever else was queued for the route goes with it, as when a route is closed.
    const withdrawn = outbound.withdrawForRoute(row.route_id, { at });
    const bodiesCleared = routes.clearBodies(row.route_id, { at });
    audit.append({
      op: 'answer-withdrawn', actor: who.actor, proof: who.proof, masterGeneration: who.masterGeneration ?? null, routeId: row.route_id,
      expectedVersion: row.version, outcome: 'applied', detail: { ...(who.detail || {}), outboundId: row.outbound_id, bodiesCleared, withdrawn }, at
    });
  }
  return left.map((row) => row.route_id);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long each kind of thing may wait before it is let go (Architect ruling,
 * 2026-10-04). A reply is the operator's answer and is never let go; nothing
 * else waits forever.
 *
 * - A milestone is news: after a week it is no longer worth saying.
 * - An operator action stays wanted far longer than news stays new.
 * - `work-blocked`, `operator-needed` and `lane-silent` describe something
 *   that is still so until somebody acts, so they keep for a week.
 * - `gateway-down` is the same: the helper is not hearing the operator until
 *   its connection is back, so it keeps for a week.
 * - `fleet-idle`, `gateway-recovered` and a route's status notice describe a
 *   moment; a day later they describe nothing.
 * - A delivery-failure notice is a fixed sentence the server wrote, not an
 *   answer, and keeps for thirty days.
 *
 * A candidate has two clocks. Waiting to be decided runs from when it was
 * submitted; waiting to be collected runs from when it was approved, because
 * approval is a new fact about how fresh it is.
 */
const EXPIRY_MS = Object.freeze({
  candidate: Object.freeze({ milestone: 7 * DAY_MS, 'operator-action-required': 30 * DAY_MS }),
  notification: Object.freeze({ 'work-blocked': 7 * DAY_MS, 'operator-needed': 7 * DAY_MS, 'fleet-idle': DAY_MS, 'lane-silent': 7 * DAY_MS, 'gateway-down': 7 * DAY_MS, 'gateway-recovered': DAY_MS }),
  status: DAY_MS,
  failure: 30 * DAY_MS
});

/**
 * Why something was let go. Fixed codes, one per way of waiting too long: a
 * candidate has two, because being decided on and being collected are
 * different waits with different clocks.
 */
const EXPIRY_REASONS = Object.freeze({
  undecided: 'undecided-expired',
  approvedUncollected: 'approved-uncollected-expired',
  uncollected: 'uncollected-expired',
  unanswered: 'unanswered-expired'
});

/**
 * How long a waiting outbound item may wait, or null for one that never expires.
 * @param {{kind: string, notify_type: (string|null), candidate_kind: (string|null)}} row - The item, with its candidate's kind.
 * @returns {number|null}
 */
function _outboundTtl(row) {
  if (row.kind === 'status') return EXPIRY_MS.status;
  if (row.kind === 'failure') return EXPIRY_MS.failure;
  if (row.kind === 'notification') return EXPIRY_MS.notification[row.notify_type] ?? null;
  if (row.kind === 'candidate') return EXPIRY_MS.candidate[row.candidate_kind] ?? null;
  return null;
}

/**
 * Let go of what waited too long. A candidate the Master never decided is
 * rejected as expired; an item the helper never collected is dropped. Each one
 * is audited by itself, with a fixed reason from {@link EXPIRY_REASONS} and the
 * id of what was let go. Being let go is final: a dropped item cannot be
 * acknowledged afterwards. An item the helper holds a live lease on is not let
 * go while that lease lasts; once it lapses the item is judged like any other. Nothing is deleted here, and nothing let go is raised again
 * under its own key: its row and its idempotency key remain, so the event
 * that made it is still accounted for. Retention removes the rows later.
 *
 * One kind of thing is a condition and not an event, and is told again: a
 * `gateway-down` notice nobody collected, when the helper still reports that
 * outage. The row let go here stays as it is; `lib/bridge-notify.js` raises a
 * new notice, keyed by this one, so that an outage still going on is not left
 * unsaid because the helper could not post for a while.
 *
 * Something expires when it has waited strictly longer than its limit.
 * @param {object} [options]
 * @param {string} [options.now] - The current instant, ISO; the clock by default.
 * @returns {{outbound: number, candidates: number, questions: number}}
 */
function expire(options = {}) {
  const at = _now(options.now);
  const now = Date.parse(at);
  const db = store.getDb();
  return transaction(() => {
    const out = { outbound: 0, candidates: 0, questions: 0 };
    // A lease that is still live holds its item: the helper was handed it
    // inside its limit and has the lease's window to say it was posted.
    leases.lapse({ at });
    const waiting = db.prepare(
      'SELECT o.outbound_id, o.kind, o.notify_type, o.created_at, c.kind AS candidate_kind FROM bridge_outbound o '
      + "LEFT JOIN bridge_candidates c ON c.candidate_id = o.candidate_id WHERE o.state IN ('ready','blocked') AND o.kind <> 'reply' "
      + "AND NOT EXISTS (SELECT 1 FROM bridge_outbound_leases l WHERE l.outbound_id = o.outbound_id AND l.state = 'live')"
    ).all();
    const drop = db.prepare(
      "UPDATE bridge_outbound SET state = 'dropped', drop_code = ?, block_code = NULL, text = NULL, updated_at = ? "
      + "WHERE outbound_id = ? AND state IN ('ready','blocked')"
    );
    for (const row of waiting) {
      const ttl = _outboundTtl(row);
      if (ttl === null || now - Date.parse(row.created_at) <= ttl) continue;
      const reason = row.kind === 'candidate' ? EXPIRY_REASONS.approvedUncollected : EXPIRY_REASONS.uncollected;
      if (drop.run(reason, at, row.outbound_id).changes !== 1) continue;
      out.outbound += 1;
      audit.append({
        op: 'expire', actor: 'gateway', proof: 'gateway', outcome: reason,
        detail: { what: 'outbound', outboundId: row.outbound_id, kind: row.kind, type: row.notify_type || row.candidate_kind || null }, at
      });
    }
    const undecided = db.prepare("SELECT candidate_id, kind, created_at FROM bridge_candidates WHERE state = 'submitted'").all();
    const reject = db.prepare(
      "UPDATE bridge_candidates SET state = 'rejected', version = version + 1, decided_at = ? WHERE candidate_id = ? AND state = 'submitted'"
    );
    for (const row of undecided) {
      const ttl = EXPIRY_MS.candidate[row.kind];
      if (!ttl || now - Date.parse(row.created_at) <= ttl) continue;
      if (reject.run(at, row.candidate_id).changes !== 1) continue;
      out.candidates += 1;
      audit.append({
        op: 'expire', actor: 'gateway', proof: 'gateway', outcome: EXPIRY_REASONS.undecided,
        detail: { what: 'candidate', candidateId: row.candidate_id, kind: row.kind }, at
      });
    }
    // A question nobody answered in time grants nothing from here on. The
    // message it was about stays held, exactly as it was: only its version
    // moves, so that the Master is told. If the question was never posted it
    // is not posted now, and the operator, who was never asked, is told
    // nothing. Otherwise they are sent one fixed sentence.
    const unanswered = db.prepare("SELECT * FROM bridge_questions WHERE state = 'open' AND expires_at <= ? ORDER BY asked_at, question_id").all(at);
    for (const row of unanswered) {
      if (db.prepare(
        "SELECT 1 FROM bridge_outbound o JOIN bridge_outbound_leases l ON l.outbound_id = o.outbound_id AND l.state = 'live' WHERE o.question_id = ? LIMIT 1"
      ).get(row.question_id)) continue;
      if (db.prepare("UPDATE bridge_questions SET state = 'expired', settled_at = ? WHERE question_id = ? AND state = 'open'").run(at, row.question_id).changes !== 1) continue;
      _withdraw("question_id = ? AND state IN ('ready','blocked')", [row.question_id], at);
      db.prepare('UPDATE bridge_routes SET version = version + 1, updated_at = ? WHERE route_id = ?').run(at, row.route_id);
      const posted = questions.wasPosted(row.question_id);
      if (posted) {
        const text = QUESTION_EXPIRED_TEXT[row.purpose];
        outbound.enqueue({
          idemKey: `route:${row.route_id}:question-expired:${row.question_id}`, kind: 'failure', routeId: row.route_id,
          sourceLabel: 'TangleClaw', text, digest: digest(text), at
        });
      }
      out.questions += 1;
      audit.append({
        op: 'expire', actor: 'gateway', proof: 'gateway', routeId: row.route_id, outcome: EXPIRY_REASONS.unanswered,
        detail: { what: 'question', questionId: row.question_id, purpose: row.purpose, operatorTold: posted }, at
      });
    }
    return out;
  });
}

const nonces = {
  /**
   * Record a helper request nonce. False when it was already seen.
   * @param {string} nonce - The request's nonce.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {boolean} True the first time a nonce is seen.
   */
  claim(nonce, options = {}) {
    const result = store.getDb().prepare(
      'INSERT INTO bridge_nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING'
    ).run(nonce, _now(options.at));
    return result.changes === 1;
  }
};

/**
 * Settle every live lease whose token is no longer the active one. A revoked
 * token can acknowledge nothing, so what it held returns to the mailbox at
 * once instead of waiting out its window.
 * @param {object} db - The open database, inside a transaction.
 * @param {string} at - The current instant, ISO.
 * @returns {void}
 */
function _lapseRevokedLeases(db, at) {
  db.prepare(
    "UPDATE bridge_outbound_leases SET state = 'lapsed', settled_at = ? WHERE state = 'live' "
    + "AND token_id NOT IN (SELECT token_id FROM bridge_helper_tokens WHERE status = 'active')"
  ).run(at);
}

const helperTokens = {
  /**
   * Replace the helper token: revoke the active one and record the new hash.
   * @param {string} tokenId - New token's id.
   * @param {string} tokenHash - SHA-256 of the new token, hex.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  replace(tokenId, tokenHash, options = {}) {
    const at = _now(options.at);
    transaction((db) => {
      db.prepare("UPDATE bridge_helper_tokens SET status = 'revoked', revoked_at = ? WHERE status = 'active'").run(at);
      _lapseRevokedLeases(db, at);
      db.prepare(
        "INSERT INTO bridge_helper_tokens (token_id, token_hash, status, created_by, created_at) VALUES (?, ?, 'active', 'operator', ?)"
      ).run(tokenId, tokenHash, at);
    });
  },

  /**
   * Revoke the active helper token.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} How many tokens were revoked.
   */
  revoke(options = {}) {
    const at = _now(options.at);
    return transaction((db) => {
      const result = db.prepare("UPDATE bridge_helper_tokens SET status = 'revoked', revoked_at = ? WHERE status = 'active'").run(at);
      _lapseRevokedLeases(db, at);
      return Number(result.changes);
    });
  },

  /**
   * Whether a presented hash is the active token's, compared in constant time.
   * @param {string} tokenHash - SHA-256 of the presented token, hex.
   * @returns {{tokenId: string}|null}
   */
  findActive(tokenHash) {
    const row = store.getDb().prepare("SELECT token_id, token_hash FROM bridge_helper_tokens WHERE status = 'active'").get();
    if (!row || typeof tokenHash !== 'string' || tokenHash.length !== row.token_hash.length) return null;
    return crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(row.token_hash)) ? { tokenId: row.token_id } : null;
  },

  /**
   * The active token's id and age, without its hash.
   * @returns {{tokenId: string, createdAt: string}|null}
   */
  active() {
    const row = store.getDb().prepare("SELECT token_id, created_at FROM bridge_helper_tokens WHERE status = 'active'").get();
    return row ? { tokenId: row.token_id, createdAt: row.created_at } : null;
  }
};

/**
 * Shape a destination from a row carrying `destination_kind` and `destination_project_id`.
 * @param {object} row - Alias or pin row.
 * @returns {{kind: string, projectId: (number|null)}}
 */
function _destination(row) {
  return { kind: row.destination_kind, projectId: row.destination_project_id };
}

/**
 * @param {object} row - A `bridge_aliases` row.
 * @returns {object} The nickname with everything recorded about it.
 */
function _nicknameRow(row) {
  return {
    alias: row.alias, display: row.display || row.alias, destination: _destination(row),
    createdBy: row.created_by, createdAt: row.created_at,
    // Empty for a row from before these were recorded: it says nothing it did not record at the time.
    changedBy: row.changed_by, changedAt: row.changed_at, confirmedRouteId: row.confirmed_route_id
  };
}

const aliases = {
  /**
   * Create a nickname, or point an existing one somewhere else. Records who
   * wrote it and when, the nickname as it was typed, and, when the Project
   * Master wrote it, the operator message that authorised it. Who first
   * created it, and when, is kept.
   * @param {string} alias - Normalised nickname.
   * @param {{kind: ('master'|'project'), projectId?: number}} destination - Where it points.
   * @param {object} [options]
   * @param {('operator'|'master')} [options.by='operator'] - Who is writing it.
   * @param {string|null} [options.confirmedRouteId] - The operator message behind a Master's write.
   * @param {string|null} [options.display] - The nickname as typed.
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  set(alias, destination, options = {}) {
    const at = _now(options.at);
    const by = options.by || 'operator';
    store.getDb().prepare(
      'INSERT INTO bridge_aliases (alias, destination_kind, destination_project_id, created_by, created_at, changed_by, changed_at, confirmed_route_id, display) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(alias) DO UPDATE SET destination_kind = excluded.destination_kind, '
      + 'destination_project_id = excluded.destination_project_id, changed_by = excluded.changed_by, changed_at = excluded.changed_at, '
      + 'confirmed_route_id = excluded.confirmed_route_id, display = excluded.display'
    ).run(alias, destination.kind, destination.kind === 'project' ? destination.projectId : null, by, at, by, at, options.confirmedRouteId ?? null, options.display || alias);
  },

  /**
   * Give a nickname a new name. What it points at, and who first created it, stay.
   * @param {string} alias - The nickname as it is.
   * @param {string} next - The normalised new name.
   * @param {object} [options] - As for {@link aliases.set}.
   * @returns {boolean} Whether there was such a nickname.
   */
  rename(alias, next, options = {}) {
    const at = _now(options.at);
    const by = options.by || 'operator';
    return store.getDb().prepare(
      'UPDATE bridge_aliases SET alias = ?, changed_by = ?, changed_at = ?, confirmed_route_id = ?, display = ? WHERE alias = ?'
    ).run(next, by, at, options.confirmedRouteId ?? null, options.display || next, alias).changes === 1;
  },

  /**
   * Remove an alias.
   * @param {string} alias - Normalised alias.
   * @returns {boolean} Whether one existed.
   */
  remove(alias) {
    return store.getDb().prepare('DELETE FROM bridge_aliases WHERE alias = ?').run(alias).changes === 1;
  },

  /**
   * Where an alias points.
   * @param {string} alias - Normalised alias.
   * @returns {{kind: string, projectId: (number|null)}|null}
   */
  get(alias) {
    const row = store.getDb().prepare('SELECT * FROM bridge_aliases WHERE alias = ?').get(alias);
    return row ? _destination(row) : null;
  },

  /**
   * Everything recorded about one nickname.
   * @param {string} alias - Normalised nickname.
   * @returns {object|null}
   */
  record(alias) {
    const row = store.getDb().prepare('SELECT * FROM bridge_aliases WHERE alias = ?').get(alias);
    return row ? _nicknameRow(row) : null;
  },

  /**
   * Every alias.
   * @returns {{alias: string, destination: object}[]}
   */
  list() {
    return store.getDb().prepare('SELECT * FROM bridge_aliases ORDER BY alias').all()
      .map((row) => ({ alias: row.alias, destination: _destination(row) }));
  },

  /**
   * Every nickname with everything recorded about it.
   * @returns {object[]}
   */
  records() {
    return store.getDb().prepare('SELECT * FROM bridge_aliases ORDER BY alias').all().map(_nicknameRow);
  }
};

const pins = {
  /**
   * Set the operator's global pin for a conversation, or for every
   * conversation when `conversationKey` is null. Replaces the active one.
   * @param {object} pin
   * @param {string} pin.pinId - New pin id.
   * @param {string|null} pin.conversationKey - Conversation, or null for all.
   * @param {{kind: ('master'|'project'), projectId?: number}} pin.destination - Where it points.
   * @param {string} [pin.at] - Timestamp override.
   * @returns {void}
   */
  setGlobal(pin) {
    const at = _now(pin.at);
    transaction((db) => {
      db.prepare(
        "UPDATE bridge_pins SET revoked_at = ? WHERE scope = 'global' AND revoked_at IS NULL AND COALESCE(conversation_key, '*') = COALESCE(?, '*')"
      ).run(at, pin.conversationKey ?? null);
      db.prepare(
        'INSERT INTO bridge_pins (pin_id, scope, conversation_key, destination_kind, destination_project_id, created_by, created_at) '
        + "VALUES (?, 'global', ?, ?, ?, 'operator', ?)"
      ).run(pin.pinId, pin.conversationKey ?? null, pin.destination.kind,
        pin.destination.kind === 'project' ? pin.destination.projectId : null, at);
    });
  },

  /**
   * Set the Master's pin for one conversation, replacing its active one.
   * Call inside the route write that decided it.
   * @param {object} pin
   * @param {string} pin.pinId - New pin id.
   * @param {string} pin.conversationKey - Conversation.
   * @param {{kind: ('master'|'project'), projectId?: number}} pin.destination - Where it points.
   * @param {number} pin.masterGeneration - Master generation that decided it.
   * @param {string} [pin.at] - Timestamp override.
   * @returns {void}
   */
  setConversation(pin) {
    const at = _now(pin.at);
    const db = store.getDb();
    db.prepare(
      "UPDATE bridge_pins SET revoked_at = ? WHERE scope = 'conversation' AND revoked_at IS NULL AND conversation_key = ?"
    ).run(at, pin.conversationKey);
    db.prepare(
      'INSERT INTO bridge_pins (pin_id, scope, conversation_key, destination_kind, destination_project_id, created_by, master_generation, created_at) '
      + "VALUES (?, 'conversation', ?, ?, ?, 'master', ?, ?)"
    ).run(pin.pinId, pin.conversationKey, pin.destination.kind,
      pin.destination.kind === 'project' ? pin.destination.projectId : null, pin.masterGeneration, at);
  },

  /**
   * Revoke one active pin.
   * @param {string} pinId - Pin id.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {boolean} Whether an active pin was revoked.
   */
  revoke(pinId, options = {}) {
    const result = store.getDb().prepare('UPDATE bridge_pins SET revoked_at = ? WHERE pin_id = ? AND revoked_at IS NULL')
      .run(_now(options.at), pinId);
    return result.changes === 1;
  },

  /**
   * The pin that applies to a conversation: the operator's pin for it, then
   * the operator's pin for every conversation, then the Master's pin for it.
   * @param {string} conversationKey - Conversation.
   * @returns {{pinId: string, scope: string, destination: object}|null}
   */
  forConversation(conversationKey) {
    const db = store.getDb();
    const row = db.prepare(
      "SELECT * FROM bridge_pins WHERE scope = 'global' AND revoked_at IS NULL AND conversation_key = ?"
    ).get(conversationKey)
      || db.prepare("SELECT * FROM bridge_pins WHERE scope = 'global' AND revoked_at IS NULL AND conversation_key IS NULL").get()
      || db.prepare("SELECT * FROM bridge_pins WHERE scope = 'conversation' AND revoked_at IS NULL AND conversation_key = ?").get(conversationKey);
    return row ? { pinId: row.pin_id, scope: row.scope, destination: _destination(row) } : null;
  },

  /**
   * Every active pin.
   * @returns {object[]}
   */
  list() {
    return store.getDb().prepare('SELECT * FROM bridge_pins WHERE revoked_at IS NULL ORDER BY created_at, pin_id').all()
      .map((row) => ({
        pinId: row.pin_id, scope: row.scope, conversationKey: row.conversation_key,
        destination: _destination(row), createdBy: row.created_by
      }));
  }
};

/** Receipt kinds a candidate may rest on. Each names an append-only record the server itself wrote. */
const RECEIPT_KINDS = Object.freeze(['workload']);

/** How many undecided candidates one launch may have waiting at a time. */
const MAX_OPEN_CANDIDATES_PER_LAUNCH = 5;

/**
 * Every column of `workload_receipts`, in the order they are hashed. The whole
 * row is covered; a test holds this list to the table, so a column added later
 * cannot be left out of the digest unnoticed.
 */
const WORKLOAD_RECEIPT_COLUMNS = Object.freeze(['receipt_id', 'project_id', 'session_id', 'launch_id', 'assignment_id', 'seq', 'state',
  'clearance', 'summary', 'wait_kind', 'wait_detail', 'refs_json', 'branch', 'head_sha', 'source', 'received_at']);

/** Names the canonical form a workload receipt is hashed in. A change to the columns or their order is a new version. */
const WORKLOAD_RECEIPT_DIGEST_VERSION = 'workload-receipt.v1';

/**
 * The digest of a workload receipt: SHA-256 over the version and the whole
 * stored row, columns in a fixed order. The table is append-only, so a row's digest never changes; a
 * candidate records it at submission and it is computed again at approval.
 * @param {object} row - A `workload_receipts` row.
 * @returns {string}
 */
function _workloadReceiptDigest(row) {
  return digest(`${WORKLOAD_RECEIPT_DIGEST_VERSION}\n${JSON.stringify(WORKLOAD_RECEIPT_COLUMNS.map((c) => [c, row[c] ?? null]))}`);
}

/**
 * The digest of what a session submitted as a candidate: its kind, its text
 * and the receipts it named. It is what a replay is compared against, and it
 * does not change when a merge later gives the candidate more receipts.
 * @param {string} kind - Candidate kind.
 * @param {string} text - Candidate text.
 * @param {{kind: string, id: string}[]} named - The receipts the session named.
 * @returns {string}
 */
function candidatePayloadDigest(kind, text, named) {
  const ids = named.map((r) => `${r.kind}:${r.id}`).sort();
  return digest(JSON.stringify(['candidate.v1', kind, text, ids]));
}

const receipts = {
  /**
   * A launch's own workload receipt, by the sequence number the session was
   * given for it. Looked up within the launch, so a session can only ever
   * name a receipt that is its own.
   * @param {string} launchId - The launch.
   * @param {number} seq - The receipt's sequence within that launch.
   * @returns {{receiptId: string, projectId: number, launchId: string, seq: number, state: string, digest: string}|null}
   */
  workloadForLaunch(launchId, seq) {
    const row = store.getDb().prepare('SELECT * FROM workload_receipts WHERE launch_id = ? AND seq = ?').get(launchId, seq);
    return row ? receipts._view(row) : null;
  },

  /**
   * A workload receipt by its id, as stored on a candidate.
   * @param {string} receiptId - The receipt's id.
   * @returns {{receiptId: string, projectId: number, launchId: string, seq: number, state: string, digest: string}|null}
   */
  workloadById(receiptId) {
    if (!/^\d{1,15}$/.test(String(receiptId))) return null;
    const row = store.getDb().prepare('SELECT * FROM workload_receipts WHERE receipt_id = ?').get(Number(receiptId));
    return row ? receipts._view(row) : null;
  },

  /**
   * Shape a workload receipt for the bridge.
   * @param {object} row - A `workload_receipts` row.
   * @returns {object}
   */
  _view(row) {
    return {
      receiptId: String(row.receipt_id), projectId: row.project_id, launchId: row.launch_id, seq: row.seq,
      state: row.state, digest: _workloadReceiptDigest(row)
    };
  }
};

/**
 * Shape a candidate row for callers.
 * @param {object} row - A `bridge_candidates` row.
 * @returns {object}
 */
function _candidateRow(row) {
  return {
    candidateId: row.candidate_id, kind: row.kind, sourceProjectId: row.source_project_id, sourceLaunchId: row.source_launch_id,
    payloadDigest: row.digest,
    text: row.text, state: row.state, version: row.version, decidedGeneration: row.decided_generation,
    createdAt: row.created_at, decidedAt: row.decided_at
  };
}

const candidates = {
  /**
   * Store a candidate and the receipts it rests on, together. Idempotent on
   * its key: a repeat returns the candidate the first call made.
   * @param {object} input
   * @param {string} input.candidateId - New candidate id.
   * @param {string} input.idemKey - The submission's idempotency key.
   * @param {('milestone'|'operator-action-required')} input.kind - What it claims.
   * @param {number} input.sourceProjectId - The submitting project.
   * @param {string} input.sourceLaunchId - The submitting launch.
   * @param {string} input.text - What the session wants said.
   * @param {{kind: string, id: string, digest: string}[]} input.receipts - What it rests on; at least one.
   * @param {string} [input.at] - Timestamp override.
   * @returns {{created: boolean, overLimit: boolean, candidate: (object|null)}}
   */
  submit(input) {
    if (!Array.isArray(input.receipts) || input.receipts.length === 0) throw new Error('a candidate rests on at least one receipt');
    const at = _now(input.at);
    return transaction((db) => {
      const existing = db.prepare('SELECT * FROM bridge_candidates WHERE idem_key = ?').get(input.idemKey);
      if (existing) return { created: false, overLimit: false, candidate: _candidateRow(existing) };
      const open = db.prepare(
        "SELECT COUNT(*) AS n FROM bridge_candidates WHERE source_launch_id = ? AND state = 'submitted'"
      ).get(input.sourceLaunchId).n;
      if (open >= MAX_OPEN_CANDIDATES_PER_LAUNCH) return { created: false, overLimit: true, candidate: null };
      db.prepare(
        'INSERT INTO bridge_candidates (candidate_id, idem_key, kind, source_project_id, source_launch_id, text, digest, state, created_at) '
        + "VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)"
      ).run(input.candidateId, input.idemKey, input.kind, input.sourceProjectId, input.sourceLaunchId, input.text,
        candidatePayloadDigest(input.kind, input.text, input.receipts), at);
      const bind = db.prepare('INSERT INTO bridge_candidate_receipts (candidate_id, receipt_kind, receipt_id, receipt_digest) VALUES (?, ?, ?, ?)');
      for (const receipt of input.receipts) bind.run(input.candidateId, receipt.kind, receipt.id, receipt.digest);
      return { created: true, overLimit: false, candidate: candidates.get(input.candidateId) };
    });
  },

  /**
   * One candidate by id.
   * @param {string} candidateId - Candidate id.
   * @returns {object|null}
   */
  get(candidateId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_candidates WHERE candidate_id = ?').get(candidateId);
    return row ? _candidateRow(row) : null;
  },

  /**
   * Candidates in a state, oldest first.
   * @param {object} [options]
   * @param {string} [options.state='submitted'] - Which state.
   * @param {number} [options.limit] - At most this many, capped at {@link MAX_LIST}.
   * @returns {object[]}
   */
  list(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || MAX_LIST, 1), MAX_LIST);
    return store.getDb().prepare('SELECT * FROM bridge_candidates WHERE state = ? ORDER BY created_at, candidate_id LIMIT ?')
      .all(options.state || 'submitted', limit).map(_candidateRow);
  },

  /**
   * The receipts a candidate rests on: the ones its session named, and any
   * carried to it from a candidate the Master merged into it.
   * @param {string} candidateId - Candidate id.
   * @returns {{kind: string, id: string, digest: string}[]}
   */
  receipts(candidateId) {
    return store.getDb().prepare(
      'SELECT receipt_kind, receipt_id, receipt_digest FROM bridge_candidate_receipts WHERE candidate_id = ? ORDER BY receipt_kind, receipt_id'
    ).all(candidateId).map((r) => ({ kind: r.receipt_kind, id: r.receipt_id, digest: r.receipt_digest }));
  }
};

/**
 * Apply the Master's decision on a candidate: idempotent on the request id,
 * refused unless the caller named the candidate's current version, and
 * audited on its first use whether it is applied or refused. The counterpart
 * of {@link applyRouteWrite} for a record that is not a route.
 *
 * `change` decides and writes nothing: it returns `{refuse: '<code>'}` or
 * `{state, outbound?, carryReceiptsTo?}`. An `outbound` item is enqueued in the
 * same transaction, so a candidate is approved and its item exists together
 * or not at all; `carryReceiptsTo` copies this candidate's receipts onto
 * another, for a merge.
 * @param {object} write
 * @param {string} write.op - Operation name.
 * @param {string} write.requestId - Caller's idempotency key.
 * @param {string} write.candidateId - Candidate to decide.
 * @param {number} write.expectedVersion - The version the caller read.
 * @param {number} write.masterGeneration - The Master generation deciding.
 * @param {(candidate: object) => {refuse?: string, state?: string, outbound?: object, carryReceiptsTo?: string, detail?: object}} write.change - The decision.
 * @param {string} [write.at] - Timestamp override.
 * @returns {{outcome: string, replayed: boolean, candidate: (object|null)}}
 */
function applyCandidateWrite(write) {
  const at = _now(write.at);
  return transaction((db) => {
    const prior = audit.findRequest(write.op, write.requestId);
    if (prior) {
      const same = prior.detail && prior.detail.candidateId === write.candidateId;
      return { outcome: same ? prior.outcome : 'request-id-reused', replayed: true, candidate: candidates.get(write.candidateId) };
    }
    const record = (outcome, detail) => audit.append({
      op: write.op, requestId: write.requestId, actor: 'master', proof: 'master-launch', masterGeneration: write.masterGeneration,
      expectedVersion: write.expectedVersion, outcome, detail: { ...(detail || {}), candidateId: write.candidateId }, at
    });
    const candidate = candidates.get(write.candidateId);
    if (!candidate) {
      record('candidate-not-found');
      return { outcome: 'candidate-not-found', replayed: false, candidate: null };
    }
    if (candidate.version !== write.expectedVersion) {
      record('version-conflict', { currentVersion: candidate.version });
      return { outcome: 'version-conflict', replayed: false, candidate };
    }
    const decision = write.change(candidate) || {};
    if (decision.refuse) {
      record(decision.refuse, decision.detail);
      return { outcome: decision.refuse, replayed: false, candidate };
    }
    const result = db.prepare(
      'UPDATE bridge_candidates SET state = ?, version = version + 1, decided_generation = ?, decided_at = ? '
      + "WHERE candidate_id = ? AND version = ? AND state = 'submitted'"
    ).run(decision.state, write.masterGeneration, at, write.candidateId, candidate.version);
    if (result.changes !== 1) throw new Error('bridge candidate changed inside its own write transaction');
    const detail = { ...(decision.detail || {}) };
    if (decision.carryReceiptsTo) {
      // The surviving candidate rests on everything the folded one did.
      detail.receiptsCarried = Number(db.prepare(
        'INSERT OR IGNORE INTO bridge_candidate_receipts (candidate_id, receipt_kind, receipt_id, receipt_digest) '
        + 'SELECT ?, receipt_kind, receipt_id, receipt_digest FROM bridge_candidate_receipts WHERE candidate_id = ?'
      ).run(decision.carryReceiptsTo, write.candidateId).changes);
      // What the survivor rests on has changed, so its version moves: a
      // decision made on what it was before the merge is refused as stale.
      const moved = db.prepare(
        "UPDATE bridge_candidates SET version = version + 1 WHERE candidate_id = ? AND state = 'submitted'"
      ).run(decision.carryReceiptsTo);
      if (moved.changes !== 1) throw new Error('bridge merge target changed inside its own write transaction');
    }
    if (decision.outbound) {
      detail.outboundId = outbound.enqueue({ ...decision.outbound, candidateId: write.candidateId, at }).outboundId;
    }
    record('applied', detail);
    return { outcome: 'applied', replayed: false, candidate: candidates.get(write.candidateId) };
  });
}

/** The operations by which the Project Master changes a nickname. One operator message authorises one of them. */
const NICKNAME_OPS = Object.freeze(['nickname-set', 'nickname-rename', 'nickname-forget']);

/**
 * Apply one nickname change the Project Master makes, on the authority of one
 * operator message. Idempotent on the request id and audited on its first
 * use, applied or refused, like every other Master write.
 *
 * The message named by `answeredBy` must be one of two things, and the check
 * is mechanical:
 *
 * - **An instruction the operator sent to the Master**: an inbound the
 *   operator addressed to `@master` by that name, which the Master has routed
 *   to itself, still open, and which has authorised no nickname change before. Whether its words are an instruction to do this is the Master's
 *   reading; that it is the operator's message, addressed to the Master and
 *   used once, is checked here.
 * - **A reply to a clarifying question** the Master asked about such a
 *   message, and about no other kind (Architect ruling, 2026-10-05: a message
 *   addressed to a project gains no nickname authority by being asked about),
 *   by the same correlation every question's answer is held to. Adopting it
 *   routes that message to the Master, as the Master's own decision about
 *   it, settles the question and closes the reply's route, in this
 *   transaction with the change: all of it or none. A message that cannot
 *   be routed to the Master as it stands is refused, and nothing is used.
 *
 * Anything else authorises nothing. `change` then decides what is written: it
 * returns `{refuse: '<code>', detail?}` or `{detail}` after writing through
 * {@link aliases}, and runs inside the transaction.
 * @param {object} write
 * @param {string} write.op - One of {@link NICKNAME_OPS}.
 * @param {string} write.requestId - Caller's idempotency key.
 * @param {string} write.answeredBy - Route id of the operator message that authorises it.
 * @param {string} write.proof - How the Master was verified.
 * @param {number} write.masterGeneration - Master generation.
 * @param {(authority: {routeId: string, via: ('instruction'|'reply')}) => {refuse?: string, detail?: object}} write.change - The change.
 * @param {string} [write.at] - Timestamp override.
 * @returns {{outcome: string, replayed: boolean, detail: (object|null)}}
 */
function applyNicknameWrite(write) {
  const at = _now(write.at);
  return transaction((db) => {
    const prior = audit.findRequest(write.op, write.requestId);
    if (prior) return { outcome: prior.outcome, replayed: true, detail: prior.detail || null };
    const record = (outcome, detail) => audit.append({
      op: write.op, requestId: write.requestId, actor: 'master', proof: write.proof, masterGeneration: write.masterGeneration,
      routeId: write.answeredBy, outcome, detail: detail || null, at
    });
    const refused = (outcome, detail) => { record(outcome, detail); return { outcome, replayed: false, detail: null }; };
    const row = db.prepare('SELECT * FROM bridge_routes WHERE route_id = ?').get(write.answeredBy);
    if (!row) return refused('not-an-instruction');
    const route = _withReplyContext(_routeRow(row));
    let via;
    let question = null;
    let instruction = null;
    // One operator message authorises one change, however it came to: on the message itself, or on the
    // operator's reply to a question the Master asked about it.
    const usedUp = (instructionId) => db.prepare(
      `SELECT 1 FROM bridge_audit WHERE route_id = ? AND outcome = 'applied' AND op IN (${NICKNAME_OPS.map(() => '?').join(', ')}) LIMIT 1`
    ).get(instructionId, ...NICKNAME_OPS)
      || db.prepare("SELECT 1 FROM bridge_questions WHERE route_id = ? AND state = 'adopted' AND adopted_for = 'nickname' LIMIT 1").get(instructionId);
    if (route.replyContext && route.replyContext.kind === 'question') {
      const asked = questions.get(route.replyContext.questionId);
      if (!asked) return refused('not-an-answer');
      // The reply borrows its authority from the message the question was about, and from no other: that
      // message must be one the operator wrote to @master. A message written to a project gains no
      // authority over nicknames by being asked about.
      if (!audit.addressedToMaster(asked.routeId)) return refused('not-an-instruction');
      const judged = questions.adoptVerdict(asked.routeId, write.answeredBy, ['clarify'], at);
      if (judged.verdict !== 'adoptable') return refused(judged.verdict);
      if (usedUp(asked.routeId)) return refused('instruction-used');
      // The change and the Master's decision to take that message for itself are one write (Architect
      // ruling, 2026-10-05): the message must be one that can be routed to the Master as it stands now.
      instruction = db.prepare('SELECT route_id, version, state FROM bridge_routes WHERE route_id = ?').get(asked.routeId);
      if (!instruction || instruction.state !== 'awaiting-master') {
        return refused('not-awaiting-master', { instructionRouteId: asked.routeId, state: instruction ? instruction.state : null });
      }
      question = judged.question;
      via = 'reply';
    } else {
      // The operator's own message: written to @master, and taken by the Master as one for itself.
      if (!audit.addressedToMaster(write.answeredBy)) return refused('not-an-instruction');
      if (route.state !== 'routed' || !route.destination || route.destination.kind !== 'master') return refused('not-an-instruction');
      if (usedUp(write.answeredBy)) return refused('instruction-used');
      via = 'instruction';
    }
    const decision = write.change({ routeId: write.answeredBy, via }) || {};
    // A refusal of the change itself says which nickname it was about: ids and names, never the message's words.
    if (decision.refuse) return refused(decision.refuse, decision.detail);
    const detail = { ...(decision.detail || {}), via, questionId: question ? question.questionId : null };
    if (question) {
      // All of it or none of it: the message the question was about is routed to the Master, the question is
      // settled, the reply's route is closed and the change stands, or this throws and nothing does.
      const routed = db.prepare(
        "UPDATE bridge_routes SET state = 'accepted', resolved_by = 'master', destination_kind = 'master', destination_project_id = NULL, "
        + "resolved_generation = ?, failure_code = NULL, version = ?, updated_at = ? WHERE route_id = ? AND version = ? AND state = 'awaiting-master'"
      ).run(write.masterGeneration, instruction.version + 1, at, instruction.route_id, instruction.version);
      if (routed.changes !== 1) throw new Error('bridge route changed inside its own write transaction');
      questions.settleOnReply(question, write.answeredBy, 'nickname', { requestId: write.requestId, masterGeneration: write.masterGeneration }, at);
      // The Master's decision about that message, on that message's own record.
      audit.append({
        op: 'route', requestId: null, actor: 'master', proof: write.proof, masterGeneration: write.masterGeneration,
        routeId: instruction.route_id, expectedVersion: instruction.version, outcome: 'applied', at,
        detail: {
          to: 'master', projectId: null, questionId: question.questionId, replyRouteId: write.answeredBy, adoptedFor: 'nickname',
          with: write.op, ..._noLongerHeld(instruction.route_id, at)
        }
      });
      detail.instructionRouteId = instruction.route_id;
    }
    record('applied', detail);
    return { outcome: 'applied', replayed: false, detail };
  });
}

/**
 * How long a question stays answerable, by what it is for (operator ruling,
 * 2026-10-05). Consent to launch is asked about a moment and goes stale
 * within the hour; a clarifying question can wait a day. When the time is up
 * the question grants nothing more, and the held message stays held.
 */
const QUESTION_TTL_MS = Object.freeze({ clarify: 24 * 60 * 60 * 1000, launch: 60 * 60 * 1000 });

/**
 * The fixed sentences the operator is sent when a question went unanswered.
 * The server wrote them: nobody's prose is carried, and neither says anything
 * of what the held message or the question said.
 */
const QUESTION_EXPIRED_TEXT = Object.freeze({
  clarify: 'I asked a question about your message and had no answer. Your message is still held, and nothing has been sent on.',
  launch: 'I asked whether to launch a session for your message and had no answer. Your message is still held, and nothing was launched.'
});

/**
 * The states in which a message is held for the Project Master's decision.
 * Being queued because the Master is away is still being held: nothing about
 * the message or what was asked about it has changed.
 */
const HELD_ROUTE_STATES = Object.freeze(['awaiting-master', 'queued-master-unavailable']);

/**
 * What becomes of what was asked about a message once it is no longer held
 * for the Master: the one place that decides it, for every way a route stops
 * being held. An open question ends and, if it was never posted, is not
 * posted; a launch not yet settled is abandoned.
 * @param {string} routeId - The route that is no longer held.
 * @param {string} at - The current instant, ISO.
 * @returns {{questionCancelled?: string, launchesAbandoned?: number}} What was ended, for the audit.
 */
function _noLongerHeld(routeId, at) {
  const out = {};
  const cancelled = questions.cancelFor(routeId, at);
  if (cancelled) out.questionCancelled = cancelled;
  const abandoned = launches.abandonFor(routeId, at);
  if (abandoned) out.launchesAbandoned = abandoned;
  return out;
}

/**
 * @param {object} row - A `bridge_questions` row.
 * @returns {object} The question in the store's shape.
 */
function _questionRow(row) {
  return {
    questionId: row.question_id, routeId: row.route_id, purpose: row.purpose, targetProjectId: row.target_project_id,
    state: row.state, askedGeneration: row.asked_generation, askedAt: row.asked_at, expiresAt: row.expires_at,
    adoptedRouteId: row.adopted_route_id, adoptedFor: row.adopted_for, settledAt: row.settled_at
  };
}

const questions = {
  /**
   * @param {string} questionId - Question id.
   * @returns {object|null}
   */
  get(questionId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_questions WHERE question_id = ?').get(questionId);
    return row ? _questionRow(row) : null;
  },

  /**
   * The question a held message is waiting on, if it is waiting on one.
   * @param {string} routeId - The held message's route.
   * @returns {object|null}
   */
  openFor(routeId) {
    const row = store.getDb().prepare("SELECT * FROM bridge_questions WHERE route_id = ? AND state = 'open'").get(routeId);
    return row ? _questionRow(row) : null;
  },

  /**
   * Every question a held message has been asked, oldest first.
   * @param {string} routeId - The held message's route.
   * @returns {object[]}
   */
  listFor(routeId) {
    return store.getDb().prepare('SELECT * FROM bridge_questions WHERE route_id = ? ORDER BY asked_at, question_id').all(routeId).map(_questionRow);
  },

  /**
   * Whether an operator message may be taken as the answer to the question a
   * held message is waiting on. Mechanical, and the whole of the correlation:
   * the reply must be recorded, from when it arrived, as a reply to a posted
   * part of that very question. Its wording, its timing and its place in the
   * conversation count for nothing.
   * @param {string} routeId - The held message's route.
   * @param {string} replyRouteId - The operator message offered as the answer.
   * @param {string[]} purposes - What the question must have been asked for.
   * @param {string} at - The current instant, ISO.
   * @returns {{verdict: string, question: (object|null)}} `verdict` is `adoptable` or a closed refusal.
   */
  adoptVerdict(routeId, replyRouteId, purposes, at) {
    const db = store.getDb();
    const replyRow = replyRouteId === routeId ? null : db.prepare('SELECT * FROM bridge_routes WHERE route_id = ?').get(replyRouteId);
    if (!replyRow) return { verdict: 'not-an-answer', question: null };
    const reply = _withReplyContext(_routeRow(replyRow));
    const context = reply.replyContext;
    if (!context || context.kind !== 'question' || !context.questionId || context.routeId !== routeId) return { verdict: 'not-an-answer', question: null };
    const question = questions.get(context.questionId);
    if (!question || question.routeId !== routeId) return { verdict: 'not-an-answer', question: null };
    if (question.state !== 'open') return { verdict: 'question-settled', question };
    if (Date.parse(question.expiresAt) <= Date.parse(at)) return { verdict: 'question-expired', question };
    if (!purposes.includes(question.purpose)) return { verdict: 'question-purpose', question };
    if (!HELD_ROUTE_STATES.includes(reply.state)) return { verdict: 'reply-not-held', question };
    leases.lapse({ at });
    if (outbound.inFlight(replyRouteId)) return { verdict: 'outbound-in-flight', question };
    return { verdict: 'adoptable', question };
  },

  /**
   * Settle a question on the operator message that answered it, and close
   * that message's route: one use of one reply, in the caller's transaction.
   * Call only after {@link questions.adoptVerdict} said `adoptable`, inside
   * the same transaction.
   * @param {object} question - The open question.
   * @param {string} replyRouteId - The operator message adopted.
   * @param {('route'|'launch'|'decline'|'nickname')} adoptedFor - What it was adopted for.
   * @param {object} by - `{requestId, masterGeneration}` of the Master's write.
   * @param {string} at - The current instant, ISO.
   * @returns {{withdrawn: number, bodiesCleared: number}} What closing the reply's route let go.
   */
  settleOnReply(question, replyRouteId, adoptedFor, by, at) {
    const db = store.getDb();
    const settled = db.prepare(
      "UPDATE bridge_questions SET state = ?, adopted_route_id = ?, adopted_for = ?, settled_at = ? WHERE question_id = ? AND state = 'open'"
    ).run(adoptedFor === 'decline' ? 'declined' : 'adopted', replyRouteId, adoptedFor, at, question.questionId);
    if (settled.changes !== 1) throw new Error('bridge question changed inside its own write transaction');
    const closed = db.prepare(
      "UPDATE bridge_routes SET state = 'closed', closed_by = 'master', closed_at = ?, failure_code = NULL, version = version + 1, updated_at = ? "
      + "WHERE route_id = ? AND state IN ('awaiting-master','queued-master-unavailable')"
    ).run(at, at, replyRouteId);
    if (closed.changes !== 1) throw new Error('bridge reply route changed inside its own write transaction');
    // The reply is itself a message that was held, and may have been asked about in its turn.
    const ended = _noLongerHeld(replyRouteId, at);
    const out = { withdrawn: outbound.withdrawForRoute(replyRouteId, { at }), bodiesCleared: routes.clearBodies(replyRouteId, { at }), ...ended };
    // The reply's own route says, on its own record, what became of it. Ids
    // only. It carries no request id of its own: it is part of the Master's
    // write, which is the one that is idempotent.
    audit.append({
      op: 'adopted', actor: 'master', proof: 'master-launch', masterGeneration: by.masterGeneration ?? null,
      routeId: replyRouteId, outcome: 'applied',
      detail: { questionId: question.questionId, heldRouteId: question.routeId, purpose: question.purpose, for: adoptedFor, ...out }, at
    });
    return out;
  },

  /**
   * End the question a held message is waiting on, when the message stops
   * waiting for another reason. A question not yet posted is withdrawn, so it
   * is never put to the operator about a message already decided; a posted
   * one simply stops being answerable.
   * @param {string} routeId - The held message's route.
   * @param {string} at - The current instant, ISO.
   * @returns {string|null} The id of the question ended, or null.
   */
  cancelFor(routeId, at) {
    const open = questions.openFor(routeId);
    if (!open) return null;
    store.getDb().prepare("UPDATE bridge_questions SET state = 'cancelled', settled_at = ? WHERE question_id = ? AND state = 'open'").run(at, open.questionId);
    _withdraw("question_id = ? AND state IN ('ready','blocked')", [open.questionId], at);
    return open.questionId;
  },

  /**
   * Whether a question's text is in the helper's hands right now: it may be
   * posting it, so the question cannot be ended this instant.
   * @param {string} questionId - Question id.
   * @returns {boolean}
   */
  inFlight(questionId) {
    return Boolean(store.getDb().prepare(
      "SELECT 1 FROM bridge_outbound o JOIN bridge_outbound_leases l ON l.outbound_id = o.outbound_id AND l.state = 'live' "
      + "WHERE o.question_id = ? AND o.state IN ('ready','blocked') LIMIT 1"
    ).get(questionId));
  },

  /**
   * Whether the operator was ever shown a question: at least one part of it was posted.
   * @param {string} questionId - Question id.
   * @returns {boolean}
   */
  wasPosted(questionId) {
    return Boolean(store.getDb().prepare('SELECT 1 FROM bridge_outbound_parts WHERE question_id = ? LIMIT 1').get(questionId));
  },

  /**
   * Whether the wait on a held message is, as far as the operator has been
   * told, the operator's own: a question about it is open, or one ran out
   * and they were sent the notice saying the message is still held.
   * @param {string} routeId - The held message's route.
   * @returns {boolean}
   */
  operatorWasTold(routeId) {
    if (questions.openFor(routeId)) return true;
    return Boolean(store.getDb().prepare(
      "SELECT 1 FROM bridge_outbound WHERE route_id = ? AND kind = 'failure' AND idem_key LIKE ? LIMIT 1"
    ).get(routeId, `route:${routeId}:question-expired:%`));
  }
};

/**
 * @param {object} row - A `bridge_launches` row.
 * @returns {object} The launch in the store's shape.
 */
function _launchRow(row) {
  return {
    launchSeq: row.launch_seq, routeId: row.route_id, questionId: row.question_id, consentRouteId: row.consent_route_id,
    projectId: row.project_id, masterGeneration: row.master_generation, state: row.state, sessionId: row.session_id,
    launchId: row.launch_id, startedSession: row.started_session === null ? null : row.started_session === 1,
    failureCode: row.failure_code, requestedAt: row.requested_at, startedAt: row.started_at, settledAt: row.settled_at
  };
}

const launches = {
  /**
   * The launch a held message is waiting on, if any is unsettled.
   * @param {string} routeId - The held message's route.
   * @returns {object|null}
   */
  unsettledFor(routeId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_launches WHERE route_id = ? AND settled_at IS NULL').get(routeId);
    return row ? _launchRow(row) : null;
  },

  /**
   * Every unsettled launch, in the order consent was adopted: the one in
   * flight if there is one, then those waiting their turn.
   * @returns {object[]}
   */
  unsettled() {
    return store.getDb().prepare('SELECT * FROM bridge_launches WHERE settled_at IS NULL ORDER BY launch_seq').all().map(_launchRow);
  },

  /**
   * End every unsettled launch of a held message without launching or
   * dispatching anything more for it. A session already started is left as it is.
   * @param {string} routeId - The held message's route.
   * @param {string} at - The current instant, ISO.
   * @returns {number} How many were ended.
   */
  abandonFor(routeId, at) {
    return Number(store.getDb().prepare(
      "UPDATE bridge_launches SET state = 'abandoned', settled_at = ? WHERE route_id = ? AND settled_at IS NULL"
    ).run(at, routeId).changes);
  },

  /**
   * @param {number} launchSeq - Launch sequence number.
   * @returns {object|null}
   */
  get(launchSeq) {
    const row = store.getDb().prepare('SELECT * FROM bridge_launches WHERE launch_seq = ?').get(launchSeq);
    return row ? _launchRow(row) : null;
  },

  /**
   * The newest launch a route has had, settled or not: what a dispatch that
   * follows a launch is held to.
   * @param {string} routeId - Route id.
   * @returns {object|null}
   */
  latestFor(routeId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_launches WHERE route_id = ? ORDER BY launch_seq DESC LIMIT 1').get(routeId);
    return row ? _launchRow(row) : null;
  },

  /**
   * Record that a queued launch now waits on one named session: the one the
   * server started for it, or one found already live. Audited. The store
   * admits one such launch at a time on the install.
   * @param {number} launchSeq - Launch sequence number.
   * @param {object} session
   * @param {number} session.sessionId - The session waited for.
   * @param {string} session.launchId - Its launch id.
   * @param {boolean} session.startedSession - True when the bridge started it; false when it was already live.
   * @param {string} session.at - The current instant, ISO.
   * @returns {object} The launch.
   */
  begin(launchSeq, session) {
    return transaction((db) => {
      const moved = db.prepare(
        "UPDATE bridge_launches SET state = 'waiting-ready', session_id = ?, launch_id = ?, started_session = ?, started_at = ? "
        + "WHERE launch_seq = ? AND state = 'queued'"
      ).run(session.sessionId, session.launchId, session.startedSession ? 1 : 0, session.at, launchSeq);
      if (moved.changes !== 1) throw new Error('bridge launch was not queued when it was begun');
      const launch = launches.get(launchSeq);
      audit.append({
        op: 'launch', actor: 'gateway', proof: 'gateway', masterGeneration: null, routeId: launch.routeId, outcome: 'waiting-ready',
        detail: { launchSeq, projectId: launch.projectId, sessionId: launch.sessionId, startedSession: launch.startedSession }, at: session.at
      });
      return launch;
    });
  },

  /**
   * End an unsettled launch as failed or abandoned. Audited. Nothing is
   * retried: a later launch for the same message needs a new consent.
   * @param {number} launchSeq - Launch sequence number.
   * @param {('failed'|'abandoned')} state - How it ended.
   * @param {string|null} code - The closed failure code; required for `failed`.
   * @param {string} at - The current instant, ISO.
   * @returns {object|null} The launch, or null when it was already settled.
   */
  end(launchSeq, state, code, at) {
    return transaction(() => _endLaunch(launchSeq, state, code, at));
  }
};

/**
 * End an unsettled launch and audit it, inside the caller's transaction.
 * {@link launches.end} is this in a transaction of its own; a route write
 * that reports a failed launch ends the launch with it (`failLaunch`).
 * @param {number} launchSeq - Launch sequence number.
 * @param {('failed'|'abandoned')} state - How it ended.
 * @param {string|null} code - The closed failure code; required for `failed`.
 * @param {string} at - The current instant, ISO.
 * @returns {object|null} The launch, or null when it was already settled.
 */
function _endLaunch(launchSeq, state, code, at) {
  const moved = store.getDb().prepare(
    'UPDATE bridge_launches SET state = ?, failure_code = ?, settled_at = ? WHERE launch_seq = ? AND settled_at IS NULL'
  ).run(state, state === 'failed' ? code : null, at, launchSeq);
  if (moved.changes !== 1) return null;
  const launch = launches.get(launchSeq);
  audit.append({
    op: 'launch', actor: 'gateway', proof: 'gateway', masterGeneration: null, routeId: launch.routeId, outcome: state,
    detail: { launchSeq, projectId: launch.projectId, sessionId: launch.sessionId, code: code || null }, at
  });
  return launch;
}

const optouts = {
  /**
   * Whether the operator has taken a project out of reach of the bridge.
   * @param {number} projectId - Project id.
   * @returns {boolean}
   */
  has(projectId) {
    return Boolean(store.getDb().prepare('SELECT 1 FROM bridge_project_optouts WHERE project_id = ?').get(projectId));
  },

  /**
   * Take a project out of reach. The operator is the only writer there is.
   * @param {number} projectId - Project id.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {boolean} True when it was not out of reach before.
   */
  set(projectId, options = {}) {
    return store.getDb().prepare(
      "INSERT INTO bridge_project_optouts (project_id, set_by, set_at) VALUES (?, 'operator', ?) ON CONFLICT(project_id) DO NOTHING"
    ).run(projectId, _now(options.at)).changes === 1;
  },

  /**
   * Put a project back within reach.
   * @param {number} projectId - Project id.
   * @returns {boolean} True when it had been out of reach.
   */
  remove(projectId) {
    return store.getDb().prepare('DELETE FROM bridge_project_optouts WHERE project_id = ?').run(projectId).changes === 1;
  },

  /**
   * Every project the operator has taken out of reach, oldest first.
   * @returns {{projectId: number, setAt: string}[]}
   */
  list() {
    return store.getDb().prepare('SELECT project_id, set_at FROM bridge_project_optouts ORDER BY set_at, project_id').all()
      .map((row) => ({ projectId: row.project_id, setAt: row.set_at }));
  }
};

/**
 * Apply one write to a route: idempotent on the request id, refused unless the
 * caller named the route's current version, and audited on its first use
 * whether it is applied or refused.
 *
 * A request id is bound to the outcome of its first use, a refusal included: a
 * write refused for a stale version stays refused under that id, and the
 * caller retries with a new one.
 *
 * `change` decides what the write does and writes nothing itself. It receives
 * the current route and returns either `{refuse: '<code>'}` or
 * `{set: {column: value, ...}}`, optionally naming effects: `body` (store a
 * body), `proof` (record which Hub message belongs to the route), `outbound`
 * (enqueue an item for the helper), `pin` (set a conversation pin), `deliver`
 * (mark an outbound item as posted) and `clearBodies`. This function performs them, in that order and in the same
 * transaction, and only on the applied path.
 *
 * Two more effects are about the operator being asked something. `ask`
 * (`{questionId, purpose, targetProjectId?, text, digest, sourceLabel}`) opens
 * a question on the route and queues its text; it is refused `question-open`
 * while the route already waits on one. `adopt` (`{replyRouteId, for,
 * purposes, launchProjectId?}`) takes an operator message as the answer to the
 * route's open question: it is refused with the verdict of
 * {@link questions.adoptVerdict} unless that message is recorded as a reply to
 * that very question, and otherwise settles the question, closes the reply's
 * route and, for a launch, records the consented launch, all with the route's
 * own change. `settleLaunch` (`{launchSeq}`) marks the launch in flight for
 * this route as dispatched, with the write that sends the message on. A write that takes the route out of the Master's hands (anywhere
 * but {@link HELD_ROUTE_STATES}) ends an open question it did not adopt and
 * any launch not yet settled, and is refused `outbound-in-flight` while the
 * helper holds that question's text. A repeated
 * request id returns the outcome its first use produced, applies nothing and
 * adds no audit row.
 * `failLaunch` (`{launchSeq, code}`) ends an unsettled launch of this route as failed,
 * in the same transaction as the route's change and the notice in `outbound`
 * (#2112); a launch already ended, or another route's, is refused
 * `launch-settled` before anything changes.
 *
 * A `deliver` whose item is not there to be delivered undoes the whole write:
 * the route is as it was, nothing is audited, and the outcome is the one
 * {@link outbound.markDelivered} gave (`item-not-ready`, or a lease refusal).
 * @param {object} write
 * @param {string} write.op - Operation name.
 * @param {string} write.requestId - Caller's idempotency key.
 * @param {string} write.routeId - Route to change.
 * @param {number} write.expectedVersion - The version the caller read.
 * @param {string} write.actor - Who is acting.
 * @param {string} write.proof - How the actor was verified.
 * @param {number|null} [write.masterGeneration] - Master generation, when Master acts.
 * @param {(route: object) => {refuse?: string, set?: object, body?: object, proof?: object, outbound?: object, pin?: object, deliver?: object, withdraw?: boolean, clearBodies?: boolean, ask?: object, adopt?: object, settleLaunch?: object, failLaunch?: object, detail?: object}} write.change - The decision.
 * @param {string} [write.at] - Timestamp override.
 * @returns {{outcome: string, replayed: boolean, route: (object|null)}}
 */
function applyRouteWrite(write) {
  try {
    return _applyRouteWrite(write);
  } catch (err) {
    if (!err || err.code !== 'DELIVER_NOT_APPLIED') throw err;
    return { outcome: err.outcome, replayed: false, route: routes.get(write.routeId) };
  }
}

/**
 * The transaction behind {@link applyRouteWrite}.
 * @param {object} write - As for {@link applyRouteWrite}.
 * @returns {{outcome: string, replayed: boolean, route: (object|null)}}
 * @throws {Error} With `code` `DELIVER_NOT_APPLIED` and the `outcome`, after rolling back, when a `deliver` did not apply.
 */
function _applyRouteWrite(write) {
  const at = _now(write.at);
  return transaction((db) => {
    const prior = audit.findRequest(write.op, write.requestId);
    if (prior) {
      // The same key for a different route is a caller's mistake, not a replay.
      const outcome = prior.routeId === write.routeId ? prior.outcome : 'request-id-reused';
      return { outcome, replayed: true, route: routes.get(write.routeId) };
    }
    const record = (outcome, detail) => audit.append({
      op: write.op, requestId: write.requestId, actor: write.actor, proof: write.proof,
      masterGeneration: write.masterGeneration ?? null, routeId: write.routeId,
      expectedVersion: write.expectedVersion, outcome, detail: detail || null, at
    });
    const row = db.prepare('SELECT * FROM bridge_routes WHERE route_id = ?').get(write.routeId);
    if (!row) {
      record('route-not-found');
      return { outcome: 'route-not-found', replayed: false, route: null };
    }
    if (row.version !== write.expectedVersion) {
      record('version-conflict', { currentVersion: row.version });
      return { outcome: 'version-conflict', replayed: false, route: _routeRow(row) };
    }
    const decision = write.change(_routeRow(row)) || {};
    if (decision.refuse) {
      record(decision.refuse, decision.detail);
      return { outcome: decision.refuse, replayed: false, route: _routeRow(row) };
    }
    // A write that withdraws what is queued for the route must not pull an
    // item out of a helper's hands: the helper may be posting it now. Judged
    // here, in the store, so that no caller can cascade past it.
    if (decision.withdraw) {
      leases.lapse({ at });
      if (outbound.inFlight(write.routeId)) {
        record('outbound-in-flight', decision.detail);
        return { outcome: 'outbound-in-flight', replayed: false, route: _routeRow(row) };
      }
    }
    // Being asked, and an answer being adopted, are judged here for the same
    // reason: no caller can open a second question or take a reply that was
    // not the answer.
    if (decision.ask && questions.openFor(write.routeId)) {
      record('question-open', decision.detail);
      return { outcome: 'question-open', replayed: false, route: _routeRow(row) };
    }
    const leavingHeld = HELD_ROUTE_STATES.includes(row.state)
      && !HELD_ROUTE_STATES.includes(decision.set && decision.set.state ? decision.set.state : row.state);
    if (leavingHeld && !decision.adopt) {
      // The question about this message would end with this write. If the
      // helper is posting it now, it would be put to the operator about a
      // message already decided: refused, to be asked again once the lease has settled.
      const pending = questions.openFor(write.routeId);
      leases.lapse({ at });
      if (pending && questions.inFlight(pending.questionId)) {
        record('outbound-in-flight', { ...(decision.detail || {}), questionId: pending.questionId });
        return { outcome: 'outbound-in-flight', replayed: false, route: _routeRow(row) };
      }
    }
    // A write that reports a failed launch ends that launch itself. One that is already ended, or is
    // another message's, has nothing left to report: refused, so that nothing is marked or queued twice.
    if (decision.failLaunch) {
      const waiting = db.prepare('SELECT 1 FROM bridge_launches WHERE launch_seq = ? AND route_id = ? AND settled_at IS NULL')
        .get(decision.failLaunch.launchSeq, write.routeId);
      if (!waiting) {
        record('launch-settled', decision.detail);
        return { outcome: 'launch-settled', replayed: false, route: _routeRow(row) };
      }
    }
    let adopting = null;
    if (decision.adopt) {
      const judged = questions.adoptVerdict(write.routeId, decision.adopt.replyRouteId, decision.adopt.purposes, at);
      if (judged.verdict !== 'adoptable') {
        record(judged.verdict, { ...(decision.detail || {}), replyRouteId: decision.adopt.replyRouteId, questionId: judged.question ? judged.question.questionId : null });
        return { outcome: judged.verdict, replayed: false, route: _routeRow(row) };
      }
      adopting = judged.question;
    }
    const set = { ...(decision.set || {}), version: row.version + 1, updated_at: at };
    const columns = Object.keys(set);
    const result = db.prepare(
      `UPDATE bridge_routes SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE route_id = ? AND version = ?`
    ).run(...columns.map((c) => set[c]), write.routeId, row.version);
    if (result.changes !== 1) throw new Error('bridge route changed inside its own write transaction');
    const detail = { ...(decision.detail || {}) };
    if (adopting) {
      Object.assign(detail, { questionId: adopting.questionId, replyRouteId: decision.adopt.replyRouteId, adoptedFor: decision.adopt.for });
      questions.settleOnReply(adopting, decision.adopt.replyRouteId, decision.adopt.for, { requestId: write.requestId, masterGeneration: write.masterGeneration }, at);
      if (decision.adopt.for === 'launch') {
        const queued = db.prepare(
          'INSERT INTO bridge_launches (route_id, question_id, consent_route_id, project_id, master_generation, state, requested_at) '
          + "VALUES (?, ?, ?, ?, ?, 'queued', ?)"
        ).run(write.routeId, adopting.questionId, decision.adopt.replyRouteId, adopting.targetProjectId, write.masterGeneration, at);
        detail.launchSeq = Number(queued.lastInsertRowid);
        detail.projectId = adopting.targetProjectId;
      }
    }
    // The launch this write completes is settled before the route leaves the
    // Master's hands, so that leaving does not abandon it.
    if (decision.settleLaunch) {
      const done = db.prepare(
        "UPDATE bridge_launches SET state = 'dispatched', settled_at = ? WHERE launch_seq = ? AND route_id = ? AND state = 'waiting-ready'"
      ).run(at, decision.settleLaunch.launchSeq, write.routeId);
      if (done.changes !== 1) throw new Error('bridge launch changed inside its own write transaction');
      detail.launchSeq = decision.settleLaunch.launchSeq;
    }
    // The launch this write reports as failed is ended with it: the launch's end, the route's
    // failure code and the operator's notice (the write's `outbound`) are one transaction, so a
    // stop anywhere leaves all of them or none (#2112).
    if (decision.failLaunch) {
      if (!_endLaunch(decision.failLaunch.launchSeq, 'failed', decision.failLaunch.code, at)) {
        throw new Error('bridge launch changed inside its own write transaction');
      }
    }
    // The message is no longer held for the Master, so nothing asked about
    // it can still be answered and nothing is launched for it any more.
    if (leavingHeld) Object.assign(detail, _noLongerHeld(write.routeId, at));
    if (decision.ask) {
      const ttl = QUESTION_TTL_MS[decision.ask.purpose];
      db.prepare(
        'INSERT INTO bridge_questions (question_id, route_id, purpose, target_project_id, state, asked_generation, asked_at, expires_at) '
        + "VALUES (?, ?, ?, ?, 'open', ?, ?, ?)"
      ).run(decision.ask.questionId, write.routeId, decision.ask.purpose, decision.ask.targetProjectId ?? null, write.masterGeneration, at, new Date(Date.parse(at) + ttl).toISOString());
      const asked = outbound.enqueue({
        idemKey: `route:${write.routeId}:ask:${decision.ask.questionId}`, kind: 'question', routeId: write.routeId, questionId: decision.ask.questionId,
        sourceLabel: decision.ask.sourceLabel, text: decision.ask.text, digest: decision.ask.digest, releasedGeneration: write.masterGeneration, at
      });
      Object.assign(detail, { questionId: decision.ask.questionId, purpose: decision.ask.purpose, outboundId: asked.outboundId });
      if (decision.ask.targetProjectId) detail.projectId = decision.ask.targetProjectId;
    }
    if (decision.body) routes.putBody(write.routeId, decision.body.role, decision.body.text, decision.body.digest, { at });
    if (decision.proof) proofs.record({ ...decision.proof, routeId: write.routeId, at });
    if (decision.outbound) {
      const item = outbound.enqueue({ ...decision.outbound, routeId: write.routeId, at });
      detail.outboundId = item.outboundId;
    }
    if (decision.pin) pins.setConversation({ ...decision.pin, masterGeneration: write.masterGeneration, at });
    if (decision.deliver) {
      const delivered = outbound.markDelivered(decision.deliver.outboundId, decision.deliver.partIds, { ...decision.deliver, at });
      if (delivered.outcome !== 'delivered') {
        // Thrown so the route's own change above is rolled back with it.
        throw Object.assign(new Error(`bridge outbound item could not be marked delivered: ${delivered.outcome}`), { code: 'DELIVER_NOT_APPLIED', outcome: delivered.outcome });
      }
    }
    if (decision.withdraw) detail.withdrawn = outbound.withdrawForRoute(write.routeId, { at });
    if (decision.clearBodies) detail.bodiesCleared = routes.clearBodies(write.routeId, { at });
    record('applied', detail);
    return { outcome: 'applied', replayed: false, route: routes.get(write.routeId) };
  });
}

/**
 * Apply one decision about an item that was set aside: put it back in the
 * mailbox, or withdraw it. Idempotent on the request id and audited, like
 * every other bridge write.
 *
 * An item is withdrawn only when no helper holds it: with a live lease the
 * helper may be posting it at this moment, and a withdrawal that succeeded
 * then would be followed by the post it was meant to prevent.
 * @param {object} write
 * @param {('outbound-requeue'|'outbound-withdraw')} write.op - Which decision.
 * @param {string} write.requestId - Caller's idempotency key.
 * @param {number} write.outboundId - The item.
 * @param {('master'|'operator')} write.actor - Who decided.
 * @param {string} write.proof - The proof the caller came in under.
 * @param {number|null} [write.masterGeneration] - The Master generation, for a Master write.
 * @param {object} [write.detail] - Small structured detail for the audit, such as who the operator is; never a secret.
 * @param {string} [write.at] - Timestamp override.
 * @returns {{outcome: ('applied'|'outbound-not-found'|'not-blocked'|'not-waiting'|'outbound-in-flight'|'request-id-reused'), replayed: boolean, item: (object|null)}}
 */
function applyOutboundWrite(write) {
  const at = _now(write.at);
  return transaction((db) => {
    const prior = audit.findRequest(write.op, write.requestId);
    if (prior) {
      const same = prior.detail && prior.detail.outboundId === write.outboundId;
      return { outcome: same ? prior.outcome : 'request-id-reused', replayed: true, item: outbound.get(write.outboundId) };
    }
    const done = (outcome, detail) => {
      audit.append({
        op: write.op, requestId: write.requestId, actor: write.actor, proof: write.proof, masterGeneration: write.masterGeneration ?? null,
        outcome, detail: { ...(write.detail || {}), ...(detail || {}), outboundId: write.outboundId }, at
      });
      return { outcome, replayed: false, item: outbound.get(write.outboundId) };
    };
    const row = db.prepare('SELECT state, block_code FROM bridge_outbound WHERE outbound_id = ?').get(write.outboundId);
    if (!row) return done('outbound-not-found');
    if (write.op === 'outbound-requeue') {
      if (row.state !== 'blocked') return done('not-blocked', { state: row.state });
      db.prepare("UPDATE bridge_outbound SET state = 'ready', block_code = NULL, updated_at = ? WHERE outbound_id = ?").run(at, write.outboundId);
      return done('applied', { was: row.block_code });
    }
    if (row.state !== 'ready' && row.state !== 'blocked') return done('not-waiting', { state: row.state });
    leases.lapse({ at });
    if (db.prepare("SELECT 1 FROM bridge_outbound_leases WHERE outbound_id = ? AND state = 'live'").get(write.outboundId)) {
      return done('outbound-in-flight');
    }
    // Withdrawing a released route's answer closes that route and withdraws
    // whatever else is queued for it. The same guard applies to those: none
    // of them may be in a helper's hands.
    const cascades = _routesAnswerWithdrawalWouldClose('o.outbound_id = ?', [write.outboundId]);
    const held = cascades.find((routeId) => outbound.inFlight(routeId));
    if (held) return done('outbound-in-flight', { routeId: held });
    _withdraw('outbound_id = ?', [write.outboundId], at);
    const routesClosed = _closeRoutesOfWithdrawnAnswers(write, at);
    return done('applied', { was: row.state, ...(routesClosed.length ? { routesClosed } : {}) });
  });
}

/**
 * Everything queued that no open route owns: what would still be waiting, or
 * still be posted, after every route was closed.
 *
 * Closing a route withdraws what was released for it. Nothing does that for
 * the rest: a candidate nobody has decided, a milestone approved and not yet
 * collected, a typed notification, a notice left behind by a route that has
 * since closed, an item set aside. (An item cannot outlive its route's row: the
 * store removes a route's items with it.) They wait through a disabled bridge and are handed over
 * when it is next enabled, so somebody has to be able to see them.
 *
 * Ids, kinds, states and times only. Never text: this is what the operator's
 * status shows, and a signed-in operator reading status must not thereby read
 * what a session wrote.
 * @returns {{ref: ('candidate'|'item'), id: (string|number), kind: string, state: string, createdAt: string}[]}
 *   Undecided candidates first, then items, each oldest first.
 */
function routelessInventory() {
  const db = store.getDb();
  const undecided = db.prepare(
    "SELECT candidate_id, kind, created_at FROM bridge_candidates WHERE state = 'submitted' ORDER BY created_at, candidate_id LIMIT ?"
  ).all(MAX_LIST);
  const items = db.prepare(
    'SELECT o.outbound_id, o.kind, o.notify_type, o.state, o.block_code, o.created_at FROM bridge_outbound o '
    + 'LEFT JOIN bridge_routes r ON r.route_id = o.route_id '
    + "WHERE o.state IN ('ready','blocked') AND (o.route_id IS NULL OR r.state = 'closed') "
    + 'ORDER BY o.outbound_id LIMIT ?'
  ).all(MAX_LIST);
  return [
    ...undecided.map((c) => ({ ref: 'candidate', id: c.candidate_id, kind: `candidate:${c.kind}`, state: 'undecided', createdAt: c.created_at })),
    ...items.map((o) => ({
      ref: 'item', id: o.outbound_id, kind: o.notify_type ? `${o.kind}:${o.notify_type}` : o.kind,
      state: o.state === 'blocked' ? `set-aside:${o.block_code}` : 'waiting', createdAt: o.created_at
    }))
  ];
}

/**
 * The operator withdraws a candidate nobody has decided: it will never be
 * approved or posted. Idempotent on the request id and audited with who did
 * it. The Master decides candidates; this is the operator's way to clear one
 * when the bridge is being wound down and the Master's decision is refused.
 * @param {object} write
 * @param {string} write.requestId - Caller's idempotency key.
 * @param {string} write.candidateId - The candidate.
 * @param {object} [write.detail] - Small structured detail for the audit; never a secret.
 * @param {string} [write.at] - Timestamp override.
 * @returns {{outcome: ('applied'|'candidate-not-found'|'not-waiting'|'request-id-reused'), replayed: boolean, candidate: (object|null)}}
 */
function withdrawCandidateAsOperator(write) {
  const at = _now(write.at);
  const op = 'candidate-withdraw';
  return transaction((db) => {
    const prior = audit.findRequest(op, write.requestId);
    if (prior) {
      const same = prior.detail && prior.detail.candidateId === write.candidateId;
      return { outcome: same ? prior.outcome : 'request-id-reused', replayed: true, candidate: candidates.get(write.candidateId) };
    }
    const done = (outcome, detail) => {
      audit.append({
        op, requestId: write.requestId, actor: 'operator', proof: 'verified-session', outcome,
        detail: { ...(write.detail || {}), ...(detail || {}), candidateId: write.candidateId }, at
      });
      return { outcome, replayed: false, candidate: candidates.get(write.candidateId) };
    };
    const row = db.prepare('SELECT state FROM bridge_candidates WHERE candidate_id = ?').get(write.candidateId);
    if (!row) return done('candidate-not-found');
    if (row.state !== 'submitted') return done('not-waiting', { state: row.state });
    db.prepare(
      "UPDATE bridge_candidates SET state = 'rejected', version = version + 1, decided_generation = NULL, decided_at = ? "
      + "WHERE candidate_id = ? AND state = 'submitted'"
    ).run(at, write.candidateId);
    return done('applied', { was: 'submitted' });
  });
}

/**
 * Shape a circuit episode.
 * @param {object} row - A `bridge_config_circuit` row.
 * @returns {{episodeId: number, reason: string, outboundId: number, openedAt: string, closedAt: (string|null), closedBy: (string|null), decision: (string|null), masterToldAt: (string|null), masterToldGeneration: (number|null), masterAckedAt: (string|null), masterAckedGeneration: (number|null)}}
 */
function _episodeRow(row) {
  return {
    episodeId: row.episode_id, reason: row.reason, outboundId: row.outbound_id, openedAt: row.opened_at,
    closedAt: row.closed_at, closedBy: row.closed_by, decision: row.decision,
    masterToldAt: row.master_told_at, masterToldGeneration: row.master_told_generation,
    masterAckedAt: row.master_acked_at, masterAckedGeneration: row.master_acked_generation
  };
}

/** The idempotency key of the one notice an episode raises. */
const circuitNoticeKey = (episodeId) => `config-circuit:${episodeId}`;

const circuit = {
  /**
   * The episode that is open, if one is. While one is open the chat is not
   * taking posts, and nothing is handed to the helper.
   * @returns {object|null}
   */
  open() {
    const row = store.getDb().prepare('SELECT * FROM bridge_config_circuit WHERE closed_at IS NULL').get();
    return row ? _episodeRow(row) : null;
  },

  /**
   * Open an episode, unless one is open already. Call inside a transaction.
   * @param {string} reason - One of `FAILURE_REASONS.circuit`.
   * @param {number} outboundId - The item whose post found the chat closed.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {{opened: boolean, episode: object}} `opened` is false when an episode was already open; that one is returned.
   */
  trip(reason, outboundId, options = {}) {
    const existing = circuit.open();
    if (existing) return { opened: false, episode: existing };
    store.getDb().prepare('INSERT INTO bridge_config_circuit (reason, outbound_id, opened_at) VALUES (?, ?, ?)').run(reason, outboundId, _now(options.at));
    return { opened: true, episode: circuit.open() };
  },

  /**
   * Record that the Project Master was told of the open episode just now,
   * and which Master generation was live to be told. In the store, so that
   * who was told survives a restart.
   * @param {number} episodeId - The episode.
   * @param {number|null} generation - The live Master generation, or null when none was.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  noteMasterTold(episodeId, generation, options = {}) {
    store.getDb().prepare('UPDATE bridge_config_circuit SET master_told_at = ?, master_told_generation = ? WHERE episode_id = ? AND closed_at IS NULL')
      .run(_now(options.at), generation, episodeId);
  },

  /**
   * Record that the Project Master has taken up the open episode: it knows
   * the chat is not taking posts and that what it releases meanwhile only
   * queues. It is that generation's knowledge, not the episode's: a Master
   * launched later has not been told, so it acknowledges for itself and its
   * acknowledgement replaces the earlier one. A second acknowledgement by the
   * same generation, or one by a generation older than the one recorded,
   * changes nothing. Audited.
   * @param {number} episodeId - The episode the Master names.
   * @param {number} generation - The Master generation acknowledging.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {{outcome: ('acked'|'already-acked'|'not-open'), episode: (object|null)}}
   */
  ack(episodeId, generation, options = {}) {
    const at = _now(options.at);
    return transaction((db) => {
      const episode = circuit.open();
      if (!episode || episode.episodeId !== episodeId) return { outcome: 'not-open', episode };
      if (episode.masterAckedGeneration !== null && episode.masterAckedGeneration >= generation) return { outcome: 'already-acked', episode };
      db.prepare('UPDATE bridge_config_circuit SET master_acked_at = ?, master_acked_generation = ? WHERE episode_id = ?').run(at, generation, episodeId);
      audit.append({ op: 'circuit-ack', actor: 'master', proof: 'master-launch', masterGeneration: generation, outcome: 'applied', detail: { episodeId }, at });
      return { outcome: 'acked', episode: circuit.open() };
    });
  }
};

/**
 * Close the open configuration episode, and say what becomes of the items it
 * set aside. The Project Master's or the operator's alone, after the chat's
 * configuration has been put right: nothing closes an episode by the passage
 * of time. Idempotent on the request id and audited.
 *
 * Every item set aside for a configuration reason is put back or withdrawn,
 * as the caller decides, and the episode's own notice is withdrawn if it was
 * never posted: whoever is resetting the circuit has plainly been told.
 * @param {object} write
 * @param {string} write.requestId - Caller's idempotency key.
 * @param {('requeue'|'withdraw')} write.decision - What becomes of the items set aside.
 * @param {('master'|'operator')} write.actor - Who decided.
 * @param {string} write.proof - The proof the caller came in under.
 * @param {number|null} [write.masterGeneration] - The Master generation, for a Master write.
 * @param {object} [write.detail] - Small structured detail for the audit; never a secret.
 * @param {string} [write.at] - Timestamp override.
 * @returns {{outcome: ('applied'|'circuit-not-open'|'outbound-in-flight'|'request-id-reused'), replayed: boolean, episode: (object|null), items: number}}
 */
function applyCircuitReset(write) {
  const at = _now(write.at);
  return transaction((db) => {
    const prior = audit.findRequest('circuit-reset', write.requestId);
    if (prior) {
      const same = prior.detail && prior.detail.decision === write.decision;
      const episode = prior.detail && prior.detail.episodeId
        ? db.prepare('SELECT * FROM bridge_config_circuit WHERE episode_id = ?').get(prior.detail.episodeId) : null;
      return { outcome: same ? prior.outcome : 'request-id-reused', replayed: true, episode: episode ? _episodeRow(episode) : null, items: (prior.detail && prior.detail.items) || 0 };
    }
    const record = (outcome, detail) => audit.append({
      op: 'circuit-reset', requestId: write.requestId, actor: write.actor, proof: write.proof, masterGeneration: write.masterGeneration ?? null,
      outcome, detail: { ...(write.detail || {}), ...(detail || {}), decision: write.decision }, at
    });
    const episode = circuit.open();
    if (!episode) {
      record('circuit-not-open');
      return { outcome: 'circuit-not-open', replayed: false, episode: null, items: 0 };
    }
    const reasons = FAILURE_REASONS.circuit.map(() => '?').join(', ');
    const caught = `state = 'blocked' AND block_code IN (${reasons})`;
    if (write.decision === 'withdraw') {
      // Withdrawing a set-aside answer closes its route and takes the rest of
      // that route's queue with it. Not while a helper holds any of it.
      leases.lapse({ at });
      const held = _routesAnswerWithdrawalWouldClose(`o.block_code IN (${reasons})`, FAILURE_REASONS.circuit).find((routeId) => outbound.inFlight(routeId));
      if (held) {
        record('outbound-in-flight', { episodeId: episode.episodeId, routeId: held });
        return { outcome: 'outbound-in-flight', replayed: false, episode, items: 0 };
      }
    }
    const items = write.decision === 'requeue'
      ? Number(db.prepare(`UPDATE bridge_outbound SET state = 'ready', block_code = NULL, updated_at = ? WHERE ${caught}`).run(at, ...FAILURE_REASONS.circuit).changes)
      : _withdraw(caught, FAILURE_REASONS.circuit, at);
    _withdraw("idem_key = ? AND state = 'ready'", [circuitNoticeKey(episode.episodeId)], at);
    const routesClosed = write.decision === 'withdraw' ? _closeRoutesOfWithdrawnAnswers(write, at) : [];
    db.prepare('UPDATE bridge_config_circuit SET closed_at = ?, closed_by = ?, decision = ? WHERE episode_id = ?')
      .run(at, write.actor, write.decision, episode.episodeId);
    record('applied', { episodeId: episode.episodeId, items, ...(routesClosed.length ? { routesClosed: routesClosed.length } : {}) });
    const closed = db.prepare('SELECT * FROM bridge_config_circuit WHERE episode_id = ?').get(episode.episodeId);
    return { outcome: 'applied', replayed: false, episode: _episodeRow(closed), items };
  });
}

/**
 * How long each kind of bridge record is kept (ADR 0023 Decision 20). Bodies
 * are not here: they are cleared on confirmed delivery or close, not by age.
 */
const RETENTION = Object.freeze({
  nonceMs: 24 * 60 * 60 * 1000,
  settledLeaseMs: 24 * 60 * 60 * 1000,
  closedRouteMs: 30 * 24 * 60 * 60 * 1000,
  settledOutboundMs: 30 * 24 * 60 * 60 * 1000,
  decidedCandidateMs: 30 * 24 * 60 * 60 * 1000,
  revokedCredentialMs: 90 * 24 * 60 * 60 * 1000,
  auditMs: 90 * 24 * 60 * 60 * 1000
});

/**
 * Remove every bridge record that has outlived its retention. What is still
 * in progress is never removed: an open route, a live lease, an undelivered outbound item,
 * an outbound item with no route that is still undelivered, an undecided
 * candidate and the live credential all stay whatever their age. Removing a
 * closed route removes its bodies, proofs and outbound items with it, in any
 * state: a route closes only once its answer has been relayed or abandoned.
 *
 * The record of which posted message belonged to which item is not removed
 * here or anywhere. It holds ids and no text, and a reply to a posted message
 * can arrive at any time: removing the record would turn that reply into a
 * message that answers nothing, with nothing to say it had happened.
 * @param {object} [options]
 * @param {string} [options.now] - The current instant, ISO; the clock by default.
 * @returns {{nonces: number, leases: number, claims: number, routes: number, outbound: number, candidates: number, pins: number, helperTokens: number, credentials: number, audit: number}}
 */
function prune(options = {}) {
  const now = Date.parse(_now(options.now));
  const before = (ms) => new Date(now - ms).toISOString();
  const db = store.getDb();
  const removed = transaction(() => ({
    nonces: Number(db.prepare('DELETE FROM bridge_nonces WHERE seen_at < ?').run(before(RETENTION.nonceMs)).changes),
    // A live lease is never removed, and neither is the one an item was
    // delivered under: it is the receipt that lets the helper that made the
    // acknowledgement learn it landed, and it leaves with its item. A claim
    // stays while any lease it issued does.
    leases: Number(db.prepare(
      "DELETE FROM bridge_outbound_leases WHERE state = 'lapsed' AND settled_at < ?"
    ).run(before(RETENTION.settledLeaseMs)).changes),
    claims: Number(db.prepare(
      'DELETE FROM bridge_outbound_claims WHERE claimed_at < ? '
      + 'AND NOT EXISTS (SELECT 1 FROM bridge_outbound_leases l WHERE l.claim_nonce = bridge_outbound_claims.claim_nonce)'
    ).run(before(RETENTION.settledLeaseMs)).changes),
    routes: Number(db.prepare(
      "DELETE FROM bridge_routes WHERE state = 'closed' AND closed_at < ?"
    ).run(before(RETENTION.closedRouteMs)).changes),
    // A settled item of a route that is still open stays with its route: it
    // is part of what happened to a message somebody is still waiting on.
    outbound: Number(db.prepare(
      "DELETE FROM bridge_outbound WHERE state IN ('delivered','dropped') AND updated_at < ? "
      + "AND (route_id IS NULL OR NOT EXISTS (SELECT 1 FROM bridge_routes r WHERE r.route_id = bridge_outbound.route_id AND r.state <> 'closed'))"
    ).run(before(RETENTION.settledOutboundMs)).changes),
    // A candidate outlives every item made from it: removing it removes its
    // items, and one still waiting or not yet past its own retention must
    // leave by its own rule, audited, not as a side effect of this.
    candidates: Number(db.prepare(
      "DELETE FROM bridge_candidates WHERE state <> 'submitted' AND decided_at < ? "
      + 'AND NOT EXISTS (SELECT 1 FROM bridge_outbound o WHERE o.candidate_id = bridge_candidates.candidate_id)'
    ).run(before(RETENTION.decidedCandidateMs)).changes),
    pins: Number(db.prepare(
      'DELETE FROM bridge_pins WHERE revoked_at IS NOT NULL AND revoked_at < ?'
    ).run(before(RETENTION.revokedCredentialMs)).changes),
    helperTokens: Number(db.prepare(
      "DELETE FROM bridge_helper_tokens WHERE status = 'revoked' AND revoked_at < ?"
    ).run(before(RETENTION.revokedCredentialMs)).changes),
    credentials: Number(db.prepare(
      // The newest generation stays whatever its age: the next one is numbered from it.
      "DELETE FROM bridge_master_credentials WHERE status = 'revoked' AND revoked_at < ? "
      + 'AND generation < (SELECT MAX(generation) FROM bridge_master_credentials)'
    ).run(before(RETENTION.revokedCredentialMs)).changes)
  }));
  // After the routes: a route that just left no longer holds its audit rows back.
  const compacted = audit.compact({ before: before(RETENTION.auditMs), at: _now(options.now) });
  return { ...removed, audit: compacted.removed };
}

module.exports = {
  digest,
  expire,
  EXPIRY_MS,
  EXPIRY_REASONS,
  WORKLOAD_RECEIPT_COLUMNS,
  candidatePayloadDigest,
  STATUS_TEXT,
  RETENTION,
  prune,
  MAX_LIST,
  OPEN_ROUTE_STATES,
  transaction,
  settings,
  masterCredentials,
  audit,
  routes,
  proofs,
  outbound,
  leases,
  parts,
  MAX_PARTS,
  LEASE_MS,
  MAX_CLAIM,
  nonces,
  helperTokens,
  aliases,
  questions,
  launches,
  optouts,
  HELD_ROUTE_STATES,
  QUESTION_TTL_MS,
  QUESTION_EXPIRED_TEXT,
  pins,
  receipts,
  candidates,
  RECEIPT_KINDS,
  MAX_OPEN_CANDIDATES_PER_LAUNCH,
  applyCandidateWrite,
  applyOutboundWrite,
  routelessInventory,
  withdrawCandidateAsOperator,
  applyCircuitReset,
  circuit,
  circuitNoticeKey,
  applyRouteWrite,
  applyNicknameWrite,
  NICKNAME_OPS
};
