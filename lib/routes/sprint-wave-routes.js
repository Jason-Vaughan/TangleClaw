'use strict';

/**
 * The HTTP adapter for `lib/native-sprint-tracker.js` (#2644): a clean route
 * factory, `createSprintWaveRouter(deps)`, exposing the sprint wave board,
 * the disjointness check, a release's report summary, and the roadmap sync
 * trigger.
 *
 * Deliberately NOT registered through `lib/routes/_kernel.js`'s shared
 * `route()` table — that table is one singleton every route module and test
 * file populates by requiring it, so mounting here would collide with the
 * live server and with every other test that imports a `lib/routes/*.js`
 * module in the same process. `createSprintWaveRouter` instead returns its
 * own local route list and a self-contained `handle(req, res)`, built on
 * the kernel's stateless response/body helpers (not its route table), so
 * this module is lift-and-run testable in isolation. Mounting it behind the
 * real HTTP server is separately tracked work; this adapter is what that
 * mount will call unchanged.
 *
 * @module lib/routes/sprint-wave-routes
 */

const {
  jsonResponse, errorResponse, parseBody, reqUrl
} = require('./_kernel');
const {
  validateWaveDisjointness, syncWaveDispatchState, buildNativeSprintReportSummary, syncRoadmapWithBackoff
} = require('../native-sprint-tracker');

/**
 * Compile one `:param`-bearing pattern to a matcher, independent of the
 * kernel's own route table (see the module doc for why).
 * @param {string} pattern - e.g. `/api/sprint-reports/:version`.
 * @returns {{regex: RegExp, paramNames: string[]}}
 */
function _compile(pattern) {
  const paramNames = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

/**
 * Create the sprint wave router: four read/write endpoints over
 * `lib/native-sprint-tracker.js`, each fed by an injected `deps` function
 * so this adapter never reaches for a live database, git checkout or
 * network call on its own.
 * @param {object} deps
 * @param {() => (object|Promise<object>)} deps.getSprintData - `{cars, lanes,
 *   pullRequests, waves, learnings, releaseCommit}` for the CURRENT sprint,
 *   used by `GET /api/sprint-waves`.
 * @param {(version: string) => (object|Promise<object>)} deps.getSprintDataForVersion -
 *   The same shape for a named released/in-progress version, used by
 *   `GET /api/sprint-reports/:version`.
 * @param {((car: object) => (string[]|null))} [deps.lsFiles] - Passed through to
 *   {@link module:lib/native-sprint-tracker.validateWaveDisjointness} for
 *   `POST /api/sprint-waves/validate-disjointness`.
 * @param {() => Promise<{status: number, body: *}>} deps.fetchRoadmap - Passed
 *   through to {@link module:lib/native-sprint-tracker.syncRoadmapWithBackoff}
 *   for `POST /api/sprint-waves/sync`.
 * @param {{read: Function, write: Function}} [deps.snapshotStore] - Same call, for
 *   the last-good roadmap snapshot.
 * @param {object} [deps.backoffOptions] - Same call's `maxRetries`/`baseDelayMs`/
 *   `maxDelayMs`/`retryableStatuses`/`sleepFn`, held fixed for every sync.
 * @returns {{routes: Array<{method: string, pattern: string}>, handle: (req: object, res: object) => Promise<boolean>}}
 */
function createSprintWaveRouter(deps) {
  const d = deps || {};

  async function handleGetSprintWaves(_req, res) {
    const data = await d.getSprintData();
    const dispatch = syncWaveDispatchState({
      cars: data.cars, lanes: data.lanes, pullRequests: data.pullRequests
    });
    jsonResponse(res, 200, { ok: true, waves: data.waves || [], dispatch });
  }

  async function handleValidateDisjointness(_req, res, _params, body) {
    const cars = body && Array.isArray(body.cars) ? body.cars : null;
    if (!cars) {
      return errorResponse(res, 400, 'Request body must be a JSON object with a "cars" array', 'BAD_REQUEST');
    }
    try {
      const result = validateWaveDisjointness(cars, { lsFiles: d.lsFiles });
      jsonResponse(res, 200, { ok: true, result });
    } catch (err) {
      errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
  }

  async function handleGetSprintReport(_req, res, params) {
    const sprintData = await d.getSprintDataForVersion(params.version);
    if (!sprintData) {
      return errorResponse(res, 404, `No sprint data for version "${params.version}"`, 'NOT_FOUND');
    }
    const summary = buildNativeSprintReportSummary(sprintData);
    jsonResponse(res, 200, { ok: true, report: summary });
  }

  async function handleSyncWaves(_req, res) {
    if (typeof d.fetchRoadmap !== 'function') {
      return errorResponse(res, 503, 'Roadmap sync is not configured on this server', 'NOT_CONFIGURED');
    }
    const outcome = await syncRoadmapWithBackoff(d.fetchRoadmap, {
      ...(d.backoffOptions || {}), snapshotStore: d.snapshotStore
    });
    jsonResponse(res, outcome.ok ? 200 : 502, outcome);
  }

  const table = [
    { method: 'GET', pattern: '/api/sprint-waves', handler: handleGetSprintWaves },
    { method: 'POST', pattern: '/api/sprint-waves/validate-disjointness', handler: handleValidateDisjointness },
    { method: 'GET', pattern: '/api/sprint-reports/:version', handler: handleGetSprintReport },
    { method: 'POST', pattern: '/api/sprint-waves/sync', handler: handleSyncWaves }
  ].map((entry) => ({ ...entry, ..._compile(entry.pattern) }));

  /**
   * Match and dispatch one request against this router's own table.
   * @param {object} req - A Node `http.IncomingMessage`.
   * @param {object} res - Its `http.ServerResponse`.
   * @returns {Promise<boolean>} Whether this router handled the request.
   */
  async function handle(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const pathname = reqUrl(req).pathname;
    for (const entry of table) {
      if (entry.method !== method) continue;
      const match = pathname.match(entry.regex);
      if (!match) continue;
      const params = {};
      entry.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      let body = null;
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          body = await parseBody(req);
        } catch (err) {
          errorResponse(res, err.status || 500, err.message, err.code || 'INTERNAL_ERROR', err.extra);
          return true;
        }
      }
      await entry.handler(req, res, params, body);
      return true;
    }
    return false;
  }

  return {
    routes: table.map((entry) => ({ method: entry.method, pattern: entry.pattern })),
    handle
  };
}

module.exports = { createSprintWaveRouter };
