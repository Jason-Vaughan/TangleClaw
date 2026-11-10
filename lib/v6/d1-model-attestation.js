'use strict';

/**
 * v6 (#2985, V6-12 / D1, Car V60-T2-W1-A, BRIDGE-4): durable cross-generation
 * model/effort selection attestation — read/write over
 * `model_selection_attestations` (DDL in
 * `lib/store/_schema.js#_v6D1ModelAttestationDdl`, not here).
 *
 * This car's envelope is `lib/store/_schema.js` (additive only) +
 * `lib/v6/d1-model-attestation.js` + tests — zero `server.js` edits, so
 * mounting the catalog UI (#2985 deliverable 1, `GET /api/engines/
 * catalog`) and wiring this table into the REAL launch path (today's
 * `session.model-launch-requested`/`session.model-launch-verified`
 * activity-log rows, `lib/sessions.js#_scheduleModelReconciliation`) are
 * `BRIDGE-1`/`BRIDGE-5` (named in #2985 itself), a later car's scope.
 *
 * Model id validity reuses `lib/engine-models.js#isWellFormedModelId`
 * (`#2188`, cited in #2985 itself as shipped precedent) rather than
 * re-deriving the shape — "every question about a model is answered [t]here,"
 * per that module's own doc comment, and this module asks it rather than
 * disagreeing with it.
 *
 * `confidence`'s vocabulary deliberately matches
 * `lib/v6/b4-telemetry-header.js`'s `observed`/`estimated`/`unavailable`
 * badges from the same wave — one shared "how sure are we" scale across v6,
 * not two.
 *
 * @module lib/v6/d1-model-attestation
 */

const { isWellFormedModelId } = require('../engine-models');

/** How an observed model value was determined. */
const SOURCES = Object.freeze(['cli-roster', 'pane-derived', 'operator-declared', 'unavailable']);
/** Matches `lib/v6/b4-telemetry-header.js`'s CONFIDENCE_LEVELS, by design (see module doc). */
const CONFIDENCE_LEVELS = Object.freeze(['observed', 'estimated', 'unavailable']);

/**
 * Record (or update) one session generation's attestation — `(session_id,
 * generation)` is unique: a first call for a generation inserts, a later
 * call for the SAME generation (e.g. the request lands first, the
 * observation resolves moments later) updates that same row in place
 * rather than accumulating a new row per observation attempt.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, sessionId: number, generation: number, engineId: string,
 *   requestedModel?: string|null, observedModel?: string|null, source: string,
 *   confidence: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function recordAttestation(db, {
  projectId, sessionId, generation, engineId, requestedModel = null, observedModel = null,
  source, confidence, now = () => new Date().toISOString()
}) {
  if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(sessionId) ||
    !Number.isSafeInteger(generation) || generation < 1 ||
    typeof engineId !== 'string' || !engineId || engineId.length > 60 ||
    !SOURCES.includes(source) || !CONFIDENCE_LEVELS.includes(confidence)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (requestedModel != null && !isWellFormedModelId(requestedModel)) return { ok: false, code: 'MODEL_MALFORMED' };
  if (observedModel != null && !isWellFormedModelId(observedModel)) return { ok: false, code: 'MODEL_MALFORMED' };

  const existing = db.prepare(
    'SELECT id FROM model_selection_attestations WHERE session_id = ? AND generation = ?'
  ).get(sessionId, generation);

  if (existing) {
    db.prepare(
      'UPDATE model_selection_attestations SET engine_id = ?, requested_model = ?, observed_model = ?, '
      + 'source = ?, confidence = ?, attested_at = ? WHERE id = ?'
    ).run(engineId, requestedModel, observedModel, source, confidence, now(), existing.id);
    return { ok: true, code: 'UPDATED' };
  }
  db.prepare(
    'INSERT INTO model_selection_attestations (project_id, session_id, generation, engine_id, '
    + 'requested_model, observed_model, source, confidence, attested_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(projectId, sessionId, generation, engineId, requestedModel, observedModel, source, confidence, now());
  return { ok: true, code: 'RECORDED' };
}

/**
 * Read one session generation's attestation.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionId: number, generation: number}} args
 * @returns {object|null}
 */
function getAttestation(db, { sessionId, generation }) {
  return db.prepare(
    'SELECT * FROM model_selection_attestations WHERE session_id = ? AND generation = ?'
  ).get(sessionId, generation) || null;
}

/**
 * Read every generation's attestation for a session, oldest first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionId: number}} args
 * @returns {Array<object>}
 */
function getAttestationHistory(db, { sessionId }) {
  return db.prepare(
    'SELECT * FROM model_selection_attestations WHERE session_id = ? ORDER BY generation ASC'
  ).all(sessionId);
}

module.exports = {
  SOURCES,
  CONFIDENCE_LEVELS,
  recordAttestation,
  getAttestation,
  getAttestationHistory
};
