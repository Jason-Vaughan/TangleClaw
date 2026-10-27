'use strict';

/**
 * A session's own read of the candidates it has submitted to the Project
 * Master (#2214). `tc candidate submit` offers a fact and learns only that it
 * was accepted into the queue; this is the other half — what became of it.
 *
 * Reads `bridge_candidates`, `bridge_outbound`, `bridge_outbound_parts` and
 * `bridge_audit` directly through `store.getDb()`, the same way
 * `lib/bridge-notify.js` already reads `bridge_outbound`. It never requires
 * or edits `lib/bridge-api.js` or `lib/bridge-store.js` (A475-W2-PACK: those
 * belong to the W2-A car) — the coarse `bridge_candidates.state` column
 * cannot by itself tell a Master rejection from an operator withdrawal or a
 * gateway expiry, so the fine distinction is recovered from the audit trail
 * those writers already leave behind.
 *
 * Mounted by the entry point, outside `bridgeApi.ROUTES`, so these reads
 * answer even while the operator bridge is disabled — a session's own
 * history does not depend on whether Discord delivery is currently switched
 * on.
 *
 * @module lib/bridge-candidates
 */

const store = require('./store');
const sharedDocsAccess = require('./shared-docs-access');

const CANDIDATE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** How many links of a merge chain this follows before giving up on the survivor's own outcome. */
const MAX_MERGE_DEPTH = 10;

/**
 * Send a refusal in the shape every bridge/session route uses.
 * @param {object} res
 * @param {Function} jsonResponse
 * @param {number} status
 * @param {string} code
 * @param {string} error
 * @returns {void}
 */
function _refuse(res, jsonResponse, status, code, error) {
  jsonResponse(res, status, { code, error });
}

/**
 * Audit rows for one candidate, by operation, oldest first. `detail_json` is
 * plain `JSON.stringify` text (see `bridgeStore.audit.append`), so a `LIKE`
 * prefilter narrows the scan and an exact-equality check on the parsed
 * `candidateId` is what actually decides membership — nothing here trusts
 * the substring match alone.
 *
 * Filtered to `outcome = 'applied'`: `applyCandidateWrite` and
 * `withdrawCandidateAsOperator` both audit a REFUSED attempt (version
 * conflict, already-decided, not-waiting) under the same op, with the same
 * `candidateId` in its detail. An unfiltered, oldest-first read could surface
 * a failed attempt's row instead of the terminal one — reading a candidate
 * that failed to withdraw (because it had already expired) as `withdrawn`,
 * or a candidate approved only after an earlier version-conflict as having
 * no outbound item at all (PRR-A round 1, B1). Ordered latest-first since a
 * decided candidate's one-way state transition makes more than one applied
 * row for the same op impossible in practice, but DESC costs nothing and
 * never relies on that invariant holding.
 * @param {object} db
 * @param {string} candidateId
 * @param {string[]} ops
 * @returns {object[]}
 */
function _auditRowsFor(db, candidateId, ops) {
  const placeholders = ops.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT * FROM bridge_audit WHERE op IN (${placeholders}) AND outcome = 'applied' AND detail_json LIKE ? ORDER BY audit_seq DESC`
  ).all(...ops, `%"candidateId":"${candidateId}"%`);
  return rows
    .map((row) => ({ ...row, detail: row.detail_json ? JSON.parse(row.detail_json) : null }))
    .filter((row) => row.detail && row.detail.candidateId === candidateId);
}

/**
 * The one `bridge_outbound` row a decided candidate's approval created, by
 * the id the `candidate-approve` audit row recorded — not by scanning for
 * `candidate_id`, so a future candidate with more than one outbound item
 * would not be guessed at here.
 * @param {object} db
 * @param {number} outboundId
 * @returns {object|null}
 */
function _outboundById(db, outboundId) {
  return db.prepare('SELECT * FROM bridge_outbound WHERE outbound_id = ?').get(outboundId) || null;
}

/**
 * The parts a posted candidate's message was split into, structural only —
 * `bridge_outbound_parts` carries no text column, so there is nothing here
 * to leak.
 * @param {object} db
 * @param {number} outboundId
 * @returns {{partId: string, index: number, count: number, deliveredAt: string}[]}
 */
function _partsFor(db, outboundId) {
  return db.prepare(
    'SELECT part_external_id, part_index, part_count, delivered_at FROM bridge_outbound_parts '
    + 'WHERE outbound_id = ? ORDER BY part_index ASC'
  ).all(outboundId).map((part) => ({
    partId: part.part_external_id, index: part.part_index, count: part.part_count, deliveredAt: part.delivered_at
  }));
}

/**
 * What became of one candidate, read only from the tables this module may
 * touch. `state` alone collapses several outcomes the fine reason lives in
 * the audit trail: a Master rejection sets `decided_generation`, an operator
 * withdrawal and a gateway expiry both leave it `NULL` and are told apart by
 * which op wrote the terminal row.
 * @param {object} db
 * @param {object} row - A `bridge_candidates` row.
 * @param {number} [depth] - Merge-chain recursion guard.
 * @returns {object}
 */
function _outcome(db, row, depth = 0) {
  if (row.state === 'submitted') return { outcome: 'waiting' };

  if (row.state === 'approved') {
    const approve = _auditRowsFor(db, row.candidate_id, ['candidate-approve'])[0];
    const wording = approve && approve.detail ? approve.detail.wording : null;
    const outboundId = approve && approve.detail ? approve.detail.outboundId : null;
    const outbound = outboundId ? _outboundById(db, outboundId) : null;
    if (!outbound) return { outcome: 'approved', wording, blockCode: null };
    if (outbound.state === 'delivered') {
      return {
        outcome: 'posted', wording,
        deliveredRef: outbound.delivered_ref, deliveredAt: outbound.delivered_at,
        parts: _partsFor(db, outbound.outbound_id)
      };
    }
    // Approved but its outbound item was dropped (uncollected past its TTL,
    // `EXPIRY_REASONS.approvedUncollected` in `lib/bridge-store.js`): it will
    // never post now. The Architect's ruling named `ready|blocked` for
    // `approved` and did not say what a dropped item reports as; reporting it
    // as discarded/expired rather than leaving it misleadingly `approved`
    // forever is a call made here, flagged in the PR body.
    if (outbound.state === 'dropped') return { outcome: 'discarded', reason: 'expired' };
    return { outcome: 'approved', wording, blockCode: outbound.block_code || null };
  }

  if (row.state === 'rejected') {
    // A Master rejection stamps the generation that decided it; a withdrawal
    // or an expiry never does (`lib/bridge-store.js`'s `withdrawCandidateAsOperator`
    // and `expire()` both leave `decided_generation` NULL).
    if (row.decided_generation !== null) return { outcome: 'discarded', reason: 'rejected' };
    if (_auditRowsFor(db, row.candidate_id, ['candidate-withdraw']).length) {
      return { outcome: 'discarded', reason: 'withdrawn' };
    }
    return { outcome: 'discarded', reason: 'expired' };
  }

  // row.state === 'merged': the only value `bridge_candidates`'s own CHECK
  // constraint leaves (`submitted`, `approved`, `rejected` are handled above),
  // so there is no further branch to fall through to.
  const merge = _auditRowsFor(db, row.candidate_id, ['candidate-merge'])[0];
  const into = merge && merge.detail ? merge.detail.into : null;
  if (!into || depth >= MAX_MERGE_DEPTH) return { outcome: 'discarded', reason: 'merged', mergedInto: into || null, mergedOutcome: null };
  const target = db.prepare('SELECT * FROM bridge_candidates WHERE candidate_id = ?').get(into);
  if (!target) return { outcome: 'discarded', reason: 'merged', mergedInto: into, mergedOutcome: null };
  // `mergeCandidate` (lib/bridge-api.js) lets the Master fold a candidate
  // into a survivor from ANY project — it never checks sourceProjectId
  // equality. Recursing into a cross-project survivor would hand this
  // launch's own read another project's candidate id, delivered ref and
  // parts (PRR-A round 1, B2): redact instead of resolving it.
  if (target.source_project_id !== row.source_project_id) {
    return { outcome: 'discarded', reason: 'merged', mergedInto: null, mergedOutcome: null };
  }
  return {
    outcome: 'discarded', reason: 'merged', mergedInto: into,
    mergedOutcome: _outcome(db, target, depth + 1)
  };
}

/**
 * One candidate as the session that submitted it (or another launch of the
 * same project) may read it.
 * @param {object} db
 * @param {object} row
 * @param {{projectId: number, launchId: string}} access
 * @returns {object}
 */
function _view(db, row, access) {
  return {
    candidateId: row.candidate_id,
    kind: row.kind,
    createdAt: row.created_at,
    submittedByThisLaunch: row.source_launch_id === access.launchId,
    ..._outcome(db, row)
  };
}

/**
 * The caller as a verified project launch, or `null` for anything else —
 * including the operator and the Master, neither of which this read is for.
 * @param {object} req
 * @returns {{projectId: number, launchId: string}|null}
 */
function _verifiedSession(req) {
  const access = sharedDocsAccess.resolveAccess(req);
  return access.kind === sharedDocsAccess.KINDS.PROJECT ? access : null;
}

/**
 * Mount the session-facing candidate-read routes on the shared route table.
 * Called once, from the entry point, right after the `bridgeApi.ROUTES`
 * loop — these two routes are not in that array and do not go through
 * `bridgeApi.handle`, so they are unaffected by the operator bridge's
 * enabled/disabled switch.
 * @param {{route: Function, jsonResponse: Function}} deps
 * @returns {void}
 */
function registerRoutes({ route, jsonResponse }) {
  route('GET', '/api/bridge/session/candidates', (req, res) => {
    const access = _verifiedSession(req);
    if (!access) return _refuse(res, jsonResponse, 403, 'VERIFIED_LAUNCH_REQUIRED', 'This read needs a verified project launch.');
    const db = store.getDb();
    const rows = db.prepare(
      'SELECT * FROM bridge_candidates WHERE source_project_id = ? ORDER BY created_at ASC'
    ).all(access.projectId);
    jsonResponse(res, 200, { candidates: rows.map((row) => _view(db, row, access)) });
  });

  route('GET', '/api/bridge/session/candidates/:candidateId', (req, res, params) => {
    const access = _verifiedSession(req);
    if (!access) return _refuse(res, jsonResponse, 403, 'VERIFIED_LAUNCH_REQUIRED', 'This read needs a verified project launch.');
    const candidateId = params.candidateId;
    if (!CANDIDATE_ID.test(candidateId)) return _refuse(res, jsonResponse, 404, 'CANDIDATE_NOT_FOUND', 'No such candidate.');
    const db = store.getDb();
    const row = db.prepare('SELECT * FROM bridge_candidates WHERE candidate_id = ?').get(candidateId);
    // Another project's candidate answers exactly as a nonexistent one does:
    // scope is not leaked even as a 403.
    if (!row || row.source_project_id !== access.projectId) {
      return _refuse(res, jsonResponse, 404, 'CANDIDATE_NOT_FOUND', 'No such candidate.');
    }
    jsonResponse(res, 200, _view(db, row, access));
  });
}

module.exports = { registerRoutes };
