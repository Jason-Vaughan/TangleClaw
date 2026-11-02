'use strict';

/**
 * Per-session live usage & context readings (#2787): one row per live
 * session answering "is this session close enough to its own usage limit
 * that a mechanical hand-off should happen now" — a number, not a pane an
 * operator has to eyeball by hand (#2787's own repro: four Codex sessions
 * frozen 7 hours on a rate-limit prompt nobody was watching for).
 *
 * Sibling of `GET /api/usage/windows` (`lib/routes/sessions.js:760`), kept in
 * its own file rather than added there: `V5540-W1-D`'s own file scope
 * (confirmed against the live `LANE_QUEUE.md`, not just the dispatch
 * message) is `lib/usage-windows.js`, `lib/routes/usage.js`,
 * `test/usage-windows.test.js`, `changelog.d/2787.*` — `lib/routes/sessions.js`
 * is outside it, and editing it risks colliding with another lane's own
 * concurrent edit there.
 *
 * Read-only and fleet-wide, so it needs no caller binding — the same access
 * `GET /api/usage/windows` and `GET /api/ports` already have, and for the
 * same reason: nothing here is scoped to one project's own verified launch,
 * and no query parameter steers a server-side read at an arbitrary path (the
 * one thing that access model exists to prevent).
 *
 * @module lib/routes/usage
 */

const store = require('../store');
const usageWindows = require('../usage-windows');
const profileReconciler = require('../profile-reconciler');
const { route, jsonResponse, errorResponse, reqUrl, parseQuery } = require('./_kernel');

/**
 * Register this family's routes through the shared kernel. Called from
 * `server.js` alongside the other no-deps `.register()` calls (launch-recovery,
 * audit, engines-canary) — `server.js` was added to `V5540-W1-D`'s file scope
 * after this file's own routes shipped unreachable in the branch's first
 * commit; the live `LANE_QUEUE.md` is the record of that scope change.
 * @returns {void}
 */
function register() {
  // GET /api/usage/sessions — one row per live session (#2787). Optional
  // `?projectId=`, `?engine=`, `?lowOnly=true` filters.
  route('GET', '/api/usage/sessions', async (req, res) => {
    const query = parseQuery(reqUrl(req).search);
    if (query.projectId !== undefined && !Number.isFinite(Number(query.projectId))) {
      // A non-numeric projectId must be reported, not silently matched
      // against nothing — Number(NaN) in `_filterReadings` would otherwise
      // filter out every row and read as "no live sessions" rather than
      // "you asked for an invalid filter" (Critic R-3's own secondary note).
      return errorResponse(res, 400, 'projectId must be a number.', 'INVALID_PROJECT_ID');
    }
    const readings = await _buildFleetReadings(query);
    const filtered = _filterReadings(readings, query);
    jsonResponse(res, 200, { sessions: filtered });
  });

  // GET /api/usage/sessions/:sessionId — one session's own reading (#2787).
  route('GET', '/api/usage/sessions/:sessionId', async (req, res, params) => {
    const sessionId = Number(params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return errorResponse(res, 400, 'sessionId must be a number.', 'INVALID_SESSION_ID');
    }
    const readings = await _buildFleetReadings({});
    const reading = readings.find((r) => r.sessionId === sessionId);
    if (!reading) return errorResponse(res, 404, `No live session "${sessionId}" has a usage reading.`, 'SESSION_NOT_FOUND');
    jsonResponse(res, 200, reading);
  });
}

/**
 * Every live session's own reading, built from the real store — the single
 * place both route handlers above assemble `buildSessionUsageReadings`'s
 * real inputs, so the list and single-session routes can never disagree on
 * how a reading is built.
 * @param {{provider?: string, lowUsageHandoffThresholdPct?: string}} query -
 *   `provider` is accepted here only to let a caller override the threshold's
 *   own clock-free defaults forward; the per-session reading itself has no
 *   provider scoping (unlike `GET /api/usage/windows`'s `policyProvider`).
 * @returns {Promise<object[]>}
 */
async function _buildFleetReadings(query) {
  const projects = new Map(store.projects.list().map((p) => [p.id, p]));
  const thresholdPct = query.lowUsageHandoffThresholdPct !== undefined
    ? Number(query.lowUsageHandoffThresholdPct) : undefined;
  return usageWindows.buildSessionUsageReadings({
    sessions: store.sessions.listLiveAll(),
    projects,
    getActiveModel: profileReconciler._observeViaTrustedSource,
    lowUsageHandoffThresholdPct: Number.isFinite(thresholdPct) ? thresholdPct : undefined
  });
}

/**
 * Apply `GET /api/usage/sessions`'s own optional filters to an already-built
 * reading list.
 * @param {object[]} readings
 * @param {{projectId?: string, engine?: string, lowOnly?: string}} query
 * @returns {object[]}
 */
function _filterReadings(readings, query) {
  let out = readings;
  if (query.projectId !== undefined) {
    const projectId = Number(query.projectId);
    out = out.filter((r) => r.projectId === projectId);
  }
  if (query.engine) {
    out = out.filter((r) => r.engine === query.engine);
  }
  if (query.lowOnly === 'true') {
    out = out.filter((r) => r.lowUsageHandOffRecommended);
  }
  return out;
}

module.exports = { register };
