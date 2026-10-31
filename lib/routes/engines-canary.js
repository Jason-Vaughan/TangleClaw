'use strict';

/**
 * The `/api/engines/:engineId/canary*` route family (#1897): the operator-
 * facing surface over `lib/engine-canary.js`'s evidence store — read one
 * build's resolved compatibility state, read every build recorded for an
 * engine, and record an explicit override.
 *
 * `register()` registers the routes through the shared kernel. It takes no
 * `deps`: unlike a family that still calls back into `server.js`-resident
 * gate helpers, every proof this family needs (`_requireOperatorRead`,
 * `_requireOperatorWrite`) already lives in `./_callers`, which binds its
 * own three raw gate helpers once at load — the same pattern
 * `lib/routes/launch-recovery.js` uses.
 *
 * Evidence recording itself (a canary run's own probe results landing in the
 * store) is not a route here: the disposable canary runner named in #1897's
 * delivery slice 3 writes evidence through `lib/engine-canary.js` directly,
 * the same way a build process writes without an HTTP round trip to itself.
 * What belongs on an HTTP surface is what another party reads or decides:
 * the resolved state, and the operator's own override.
 *
 * Not yet wired into `server.js`: mounting a new route family is a
 * `server.js` edit, and `server.js` is outside this car's file scope
 * (`LANE_QUEUE.md` row `W1-B`). `register()` is written to the same contract
 * every other family uses (`require('./lib/routes/engines-canary').register()`
 * at the position its routes should hold), so wiring it in is a one-line
 * follow-up once a session holding `server.js` in scope does it.
 *
 * @module lib/routes/engines-canary
 */

const store = require('../store');
const engineCanary = require('../engine-canary');
const { route, jsonResponse, errorResponse } = require('./_kernel');
const { _requireOperatorRead, _requireOperatorWrite } = require('./_callers');

/**
 * The resolved-state payload shared by every read route: the evidence (when
 * any was recorded), the launch-gate decision built from it, and the
 * engine's most recent `verified` build, used to fill a refusal's rollback
 * guidance.
 * @param {string} baseDir - The store's base path.
 * @param {string} engineId - Engine identifier.
 * @param {string} buildFingerprint - Exact build fingerprint.
 * @returns {{found: boolean, reason?: string, doc?: object, gate?: object}}
 */
function _resolvedPayload(baseDir, engineId, buildFingerprint) {
  const file = engineCanary.evidencePath(baseDir, engineId, buildFingerprint);
  const read = engineCanary.readEvidence(file);
  if (read.status !== engineCanary.READ_STATUS.OK) {
    return { found: false, reason: read.reason || read.status };
  }
  const lastVerified = engineCanary
    .listEvidenceForEngine(baseDir, engineId)
    .find((row) => row.status === engineCanary.READ_STATUS.OK && row.doc.state === engineCanary.STATES.VERIFIED);
  const gate = engineCanary.decideLaunchGate({
    evidenceDoc: read.doc,
    lastVerifiedEvidence: lastVerified ? lastVerified.doc : null
  });
  return { found: true, doc: read.doc, gate };
}

/**
 * Register this family's routes.
 * @returns {void}
 */
function register() {
  // GET /api/engines/:engineId/canary/:buildFingerprint — the resolved
  // compatibility state for one exact engine build, plus the launch-gate
  // decision it implies. Read-only, so every signed-in operator may read it
  // (no project scoping: a canary build's compatibility is install-wide, not
  // per-project).
  route('GET', '/api/engines/:engineId/canary/:buildFingerprint', (req, res, params) => {
    const reader = _requireOperatorRead(req, res, {
      logEvent: 'Refused an engine canary read',
      fallbackAction: 'read an engine compatibility canary record',
      noLogin: 'This install has no login, so an engine compatibility canary record cannot be read here: nothing '
        + 'would establish that the reader is the operator. Turn the login on and sign in.',
      unauthenticated: 'Sign in to read an engine compatibility canary record: this install requires a login.',
      gateUnsupported: (gateState) =>
        `An engine compatibility canary record cannot be read while the login gate is "${gateState}". Resolve the `
        + 'gate first.'
    });
    if (!reader) return;

    let payload;
    try {
      payload = _resolvedPayload(store._getBasePath(), params.engineId, params.buildFingerprint);
    } catch (err) {
      if (!(err instanceof engineCanary.CanaryError)) throw err;
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    if (!payload.found) {
      return errorResponse(res, 404, payload.reason, 'CANARY_EVIDENCE_NOT_FOUND');
    }
    jsonResponse(res, 200, {
      gateState: reader.gateState,
      engineId: params.engineId,
      buildFingerprint: params.buildFingerprint,
      evidence: payload.doc,
      launchGate: payload.gate
    });
  });

  // GET /api/engines/:engineId/canary — every build recorded for one engine,
  // newest first, for a diagnostics or settings view.
  route('GET', '/api/engines/:engineId/canary', (req, res, params) => {
    const reader = _requireOperatorRead(req, res, {
      logEvent: 'Refused an engine canary list read',
      fallbackAction: 'list an engine\'s recorded compatibility canary records',
      noLogin: 'This install has no login, so an engine\'s recorded compatibility canary records cannot be listed '
        + 'here: nothing would establish that the reader is the operator. Turn the login on and sign in.',
      unauthenticated: 'Sign in to list an engine\'s recorded compatibility canary records: this install requires '
        + 'a login.',
      gateUnsupported: (gateState) =>
        `An engine's recorded compatibility canary records cannot be listed while the login gate is `
        + `"${gateState}". Resolve the gate first.`
    });
    if (!reader) return;

    let rows;
    try {
      rows = engineCanary.listEvidenceForEngine(store._getBasePath(), params.engineId);
    } catch (err) {
      if (!(err instanceof engineCanary.CanaryError)) throw err;
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    jsonResponse(res, 200, {
      gateState: reader.gateState,
      engineId: params.engineId,
      builds: rows.map((row) => ({
        buildFingerprint: row.buildFingerprint,
        status: row.status,
        state: row.doc ? row.doc.state : null,
        verifiedAt: row.doc ? row.doc.verifiedAt : null,
        overridden: row.doc ? engineCanary.isOverridden(row.doc) : false,
        reason: row.reason
      }))
    });
  });

  // POST /api/engines/:engineId/canary/:buildFingerprint/override — an
  // explicit, recorded operator override of a non-`verified` build.
  // Body: {acknowledgedRisk: true, reason, lastVerifiedVersion, rollbackCommand}
  //
  // The issue's own words: "An operator may use an explicit, recorded
  // override, but the UI must name the risk and provide the last verified
  // version and rollback command." `lib/engine-canary.js#applyOverride`
  // refuses an override missing any of those; this route's only job is the
  // operator proof and shaping the body into the override input.
  route('POST', '/api/engines/:engineId/canary/:buildFingerprint/override', (req, res, params, body) => {
    const proof = _requireOperatorWrite(req, res, {
      logEvent: 'Refused an engine canary override',
      logContext: { engineId: params.engineId },
      fallbackAction: 'record an engine compatibility canary override',
      sameOriginWhat: 'An engine compatibility canary override',
      unauthenticated: 'Sign in to override an engine compatibility canary result: this install requires a login, '
        + "and an override is an operator's decision.",
      machineClient: 'A compatibility canary override is an operator\'s decision, and a local process is not one.',
      openToken: 'This install has no login, so a canary override must carry the anti-forgery token its dashboard '
        + 'was issued. Reload the dashboard and try again.',
      gateUnsupported: (gateState) =>
        `A compatibility canary override cannot be recorded while the login gate is "${gateState}". Resolve the `
        + 'gate first.'
    });
    if (!proof) return;

    if (!body || typeof body !== 'object') {
      return errorResponse(res, 400, 'The request body must be an object carrying the override.', 'BAD_REQUEST');
    }
    const file = engineCanary.evidencePath(store._getBasePath(), params.engineId, params.buildFingerprint);
    let updated;
    try {
      updated = engineCanary.applyOverride(file, {
        actor: proof.actor || 'open-install',
        acknowledgedRisk: body.acknowledgedRisk,
        reason: body.reason,
        lastVerifiedVersion: body.lastVerifiedVersion === undefined ? null : body.lastVerifiedVersion,
        rollbackCommand: body.rollbackCommand === undefined ? '' : body.rollbackCommand
      });
    } catch (err) {
      if (!(err instanceof engineCanary.CanaryError)) throw err;
      return errorResponse(res, 400, err.message, 'CANARY_OVERRIDE_INVALID');
    }
    jsonResponse(res, 200, {
      gateState: proof.clearance,
      engineId: params.engineId,
      buildFingerprint: params.buildFingerprint,
      evidence: updated
    });
  });
}

module.exports = { register };
