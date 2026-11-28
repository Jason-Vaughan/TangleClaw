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
 * this module is lift-and-run testable in isolation. The live server mounts
 * it (#3087, Ruling A774) by registering each of `endpoints` through its own
 * route table, so the routes get the same launch-binding floor, body parsing
 * and size limits as every other route.
 *
 * @module lib/routes/sprint-wave-routes
 */

const {
  jsonResponse, errorResponse, parseBody, reqUrl
} = require('./_kernel');
const {
  validateWaveDisjointness, syncWaveDispatchState, buildNativeSprintReportSummary, syncRoadmapWithBackoff,
  buildSprintWaveSnapshot, SPRINT_VERSION_RE, parseSprintReportSettlement
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
 * @param {('repo'|'car')} [deps.lsFilesScope] - Same call's `lsFilesScope`
 *   (default `'repo'` — the scope {@link module:lib/native-sprint-tracker.gitLsFilesAt}
 *   itself answers).
 * @param {() => Promise<{status: number, body: *}>} deps.fetchRoadmap - Passed
 *   through to {@link module:lib/native-sprint-tracker.syncRoadmapWithBackoff}
 *   for `POST /api/sprint-waves/sync`.
 * @param {{read: Function, write: Function}} [deps.snapshotStore] - Same call, for
 *   the last-good roadmap snapshot.
 * @param {object} [deps.backoffOptions] - Same call's `maxRetries`/`baseDelayMs`/
 *   `maxDelayMs`/`retryableStatuses`/`sleepFn`, held fixed for every sync.
 * @param {(req: object, res: object) => boolean} [deps.authorizeSync] - Gate for
 *   `POST /api/sprint-waves/sync`, which writes the roadmap snapshot: return
 *   true to proceed, or false having already sent the refusal.
 * @param {() => ({data: object, repo: (string|null), source: string}|Promise<*>)} [deps.getRoadmapData] -
 *   The loaded roadmap data for `GET /api/sprint-waves` to pass into
 *   {@link module:lib/native-sprint-tracker.buildSprintWaveSnapshot} (#3134)
 *   — `data` is the `roadmap2-data.json`-shaped object (or this server's own
 *   fallback), `repo` its `owner/name` slug when known, and `source` which
 *   one was used (`'roadmap2-data.json'` or `'fallback'`), echoed back in the
 *   response so a caller can tell which it got. Omit to leave the panel's
 *   releases ungrouped, as before #3134.
 * @param {(repo: (string|null)) => (string|null|Promise<string|null>)} [deps.getRoadmapUrl] -
 *   (#3345, #3325 fast-follow) A link for `getRoadmapData`'s own resolved `repo`
 *   (same slug `syncWaveDispatchState`'s `prUrl` already derives from), returned
 *   as `GET /api/sprint-waves`'s `roadmapUrl` field alongside `projectName`/
 *   `groupName` (read straight off `resolveScope`'s own result, never through a
 *   dep). Omit, or answer `null`, to leave `roadmapUrl` null, as before #3345 —
 *   `public/sprint-wave-ui.js` renders no roadmap link at all in that case
 *   rather than defaulting to any one install's own hardcoded page.
 * @param {() => (string[]|Promise<string[]>)} [deps.getShippedVersions] - Bare
 *   (or `v`-prefixed; {@link module:lib/native-sprint-tracker.buildSprintWaveSnapshot}
 *   normalizes either) versions already released, passed as `shippedVersions`
 *   into the snapshot so a historical release classifies under
 *   `releases.shipped` instead of `releases.planned` (#3162). Omit to classify
 *   nothing as shipped, as before #3162 (every non-current release reads
 *   `planned`).
 * @param {() => (Array<object>|Promise<Array<object>>)} [deps.getReports] - The
 *   Sprint Reports Hub's catalog (`{id, version, title, url, kind}`), shared by
 *   `GET /api/sprint-waves` and `GET /api/sprint-reports/:version` (#3164).
 *   Omit for an empty catalog, as before #3164.
 * @param {(version: string) => (string|null|Promise<string|null>)} [deps.getReleaseCommit] -
 *   The merge/release commit SHA for a shipped version, for `GET
 *   /api/sprint-reports/:version`'s `heroKpis.releaseCommit` (#3164). Only
 *   overwrites what `getSprintDataForVersion` itself may have already
 *   resolved (the wave run's own `releaseCommit`) when it resolves to a
 *   real, non-empty string — a null answer never stomps out a value already
 *   correct (Architect Ruling A859, R2). Omit to leave whatever
 *   `getSprintDataForVersion` supplied untouched.
 * @param {() => (*|Promise<*>)} [deps.getSyncStatus] - Parsed
 *   `roadmap-sync-status.json`, or null when it could not be read, passed to
 *   {@link module:lib/native-sprint-tracker.validateRoadmapSyncStatus} (#3166).
 *   Omit to leave the snapshot's `roadmapSyncStatus` field absent entirely, as
 *   before #3166 — a caller that cannot read the status file is different from
 *   one that read it and found it degraded.
 * @param {() => (string|Promise<string>)} [deps.getReportsHubHtml] - The Sprint
 *   Reports Hub's own `index.html`, for the same `roadmapSyncStatus` check's
 *   hub-link half (#3166). Omit to skip that half; the verdict then rests on
 *   `getSyncStatus` alone.
 * @param {(version: string) => (string|null|Promise<string|null>)} [deps.getSprintReportHtml] -
 *   One version's own `sprint-reports/vX.Y.Z/index.html` (#3175): used both
 *   for `GET /api/sprint-waves`'s `roadmapSyncStatus` report-settlement half
 *   (called with the current sprint's version; resolve `null` when the file
 *   does not exist, so a missing report reads degraded rather than skipping
 *   the check) and for `GET /api/sprint-reports/:version`'s `settled`/
 *   `postMortem` fields (called with the resolved version; omit the fields
 *   entirely by resolving anything other than a string). Omit this dep to
 *   skip both -- unchanged from before #3175.
 * @param {() => Promise<object>} [deps.getGithubActivity] - Live PRs, open
 *   issues, milestones and the latest release for `GET
 *   /api/sprint-waves/github-activity` (#3134). Omit to answer 503
 *   `NOT_CONFIGURED`.
 * @param {(req: object) => ({projectId: (number|null), fleetId: (string|null),
 *   groupId: (string|null), projectPath: (string|null), sharedDir: (string|null)}
 *   |Promise<*>)} [deps.resolveScope] - Which project's/fleet's/group's data
 *   `GET /api/sprint-waves`, `GET /api/sprint-reports/:version` and `GET
 *   /api/sprint-waves/github-activity` answer (#3325 Fleet/Workspace Document
 *   & Wave Isolation): resolved once per request and threaded into every
 *   other scoped dep call above (`getSprintData`, `getSprintDataForVersion`,
 *   `getRoadmapData`, `getShippedVersions`, `getReports`, `getReleaseCommit`,
 *   `getSyncStatus`, `getReportsHubHtml`, `getSprintReportHtml`,
 *   `getGithubActivity`) as their own second argument (third, for the two
 *   that already take `version` first). Omit to pass `{}` to each of them,
 *   unchanged from before #3325 — the router itself never resolves a
 *   project, group or launch binding; that is this dep's job precisely so
 *   this module stays free of a live database or session lookup.
 * @returns {{routes: Array<{method: string, pattern: string}>,
 *   endpoints: Array<{method: string, pattern: string, handler: Function}>,
 *   handle: (req: object, res: object) => Promise<boolean>}} `endpoints` lets
 *   a server mount each route through its own route table (#3087), where the
 *   body is already parsed; `handle` stays for standalone use.
 */
function createSprintWaveRouter(deps) {
  const d = deps || {};

  async function handleGetSprintWaves(req, res) {
    // #3325: resolved once per request and threaded into every scoped dep
    // call below -- see `resolveScope`'s own JSDoc on `createSprintWaveRouter`.
    const scope = typeof d.resolveScope === 'function' ? await d.resolveScope(req) : {};
    const data = await d.getSprintData(scope);
    // #3134: closes the gap #3112's own comment flagged -- a loaded
    // roadmap (real `roadmap2-data.json`, or this server's own fallback)
    // now reaches both the dispatch rows (for `prUrl`) and the snapshot
    // (for release grouping), instead of neither ever seeing one.
    const roadmap = typeof d.getRoadmapData === 'function' ? await d.getRoadmapData(scope) : null;
    const roadmapData = roadmap && roadmap.data && typeof roadmap.data === 'object' ? roadmap.data : null;
    const repo = roadmap && typeof roadmap.repo === 'string' ? roadmap.repo : null;
    // #3162/#3164/#3166: each optional, each omit-safe -- a deps object that
    // never mentions one of these behaves exactly as it did before this
    // issue's fix for it (see the dep's own JSDoc for which omitted behavior
    // that is), so an existing caller that supplies none of them is unaffected.
    const shippedVersions = typeof d.getShippedVersions === 'function' ? await d.getShippedVersions(scope) : undefined;
    const reports = typeof d.getReports === 'function' ? await d.getReports(scope) : undefined;
    const syncStatusInput = {};
    if (typeof d.getSyncStatus === 'function') syncStatusInput.syncStatus = await d.getSyncStatus(scope);
    if (typeof d.getReportsHubHtml === 'function') syncStatusInput.hubHtml = await d.getReportsHubHtml(scope);
    // #3175: only when the current sprint actually resolved a version --
    // asking for "current"'s own report with no version to name one is
    // not a question this dep can answer.
    if (typeof d.getSprintReportHtml === 'function' && data.version) {
      syncStatusInput.reportHtml = await d.getSprintReportHtml(data.version, scope);
    }
    const dispatch = syncWaveDispatchState({
      cars: data.cars, lanes: data.lanes, pullRequests: data.pullRequests, repo
    });
    const snapshot = buildSprintWaveSnapshot({
      cars: data.cars, lanes: data.lanes, pullRequests: data.pullRequests, repo,
      roadmapData: roadmapData || undefined, currentVersion: data.version,
      shippedVersions, reports, ...syncStatusInput
    });
    // #3345 (#3325 fast-follow, outside this file's originally-declared
    // scope -- flagged to PM): projectName/groupName are already resolved
    // onto `scope` by `resolveScope`; `roadmapUrl` is computed from the same
    // `repo` the dispatch rows above already read, so the renderer can show
    // which project/fleet it is actually looking at instead of a label
    // hardcoded for one specific install.
    const roadmapUrl = typeof d.getRoadmapUrl === 'function' ? d.getRoadmapUrl(repo) : null;
    jsonResponse(res, 200, {
      ok: true, waves: data.waves || [], dispatch, snapshot,
      roadmapSource: roadmap ? roadmap.source : 'unconfigured',
      projectName: scope && typeof scope.projectName === 'string' ? scope.projectName : null,
      groupName: scope && typeof scope.groupName === 'string' ? scope.groupName : null,
      roadmapUrl
    });
  }

  async function handleGetGithubActivity(req, res) {
    if (typeof d.getGithubActivity !== 'function') {
      return errorResponse(res, 503, 'GitHub activity is not configured on this server', 'NOT_CONFIGURED');
    }
    const scope = typeof d.resolveScope === 'function' ? await d.resolveScope(req) : {};
    const activity = await d.getGithubActivity(scope);
    jsonResponse(res, activity && activity.ok ? 200 : 502, activity);
  }

  async function handleValidateDisjointness(_req, res, _params, body) {
    const cars = body && Array.isArray(body.cars) ? body.cars : null;
    if (!cars) {
      return errorResponse(res, 400, 'Request body must be a JSON object with a "cars" array', 'BAD_REQUEST');
    }
    try {
      const result = validateWaveDisjointness(cars, { lsFiles: d.lsFiles, lsFilesScope: d.lsFilesScope });
      jsonResponse(res, 200, { ok: true, result });
    } catch (err) {
      errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
  }

  async function handleGetSprintReport(req, res, params) {
    // #3087 (Ruling A774): only `current` or a version reaches the lookup.
    if (typeof params.version !== 'string' || !SPRINT_VERSION_RE.test(params.version)) {
      return errorResponse(res, 400, 'version must be "current" or X.Y.Z', 'BAD_REQUEST');
    }
    // #3325: resolved once per request and threaded into every scoped dep
    // call below -- see `resolveScope`'s own JSDoc on `createSprintWaveRouter`.
    const scope = typeof d.resolveScope === 'function' ? await d.resolveScope(req) : {};
    const sprintData = await d.getSprintDataForVersion(params.version, scope);
    if (!sprintData) {
      return errorResponse(res, 404, `No sprint data for version "${params.version}"`, 'NOT_FOUND');
    }
    // #3164: `buildNativeSprintReportSummary` already reads `sprintData.reports`
    // and `sprintData.releaseCommit` straight through (it has for #3112's own
    // Kaizen catalog field) -- the gap was never that function, it was that
    // nothing supplying real values ever reached it. Merged onto a COPY, never
    // the object `d.getSprintDataForVersion` returned, since that may be a
    // cached/shared reference a second call reuses.
    const enrichedData = { ...sprintData };
    if (typeof d.getReports === 'function') enrichedData.reports = await d.getReports(scope);
    // #3164 (Architect Ruling A859, R2): `getSprintDataForVersion` can
    // already have resolved a real `releaseCommit` itself (the wave run's
    // own `releaseCommit`/`metadata.releaseCommit` field) -- only overwrite
    // it when `getReleaseCommit` actually found one of its own (a resolved
    // git tag), never with a null that would stomp out a value already
    // correct. `sprintData.releaseCommit` is the fallback either way, so
    // this never regresses to the hardcoded-null-always behavior before
    // #3164's own fix in `sprintDataFromWaveRuns`.
    //
    // Resolved against `enrichedData.version` (what `sprintDataFromWaveRuns`
    // actually resolved, e.g. `v6.5.3`), not the raw `params.version` this
    // route received (PRR-B R-Gate REVISE, BLOCKING 1d): a request for
    // `current` passed `'current'` to `getReleaseCommit` literally, which
    // can never name a real git tag and always answered null -- falling
    // back to `params.version` only for the pathological case where the
    // sprint data carries no `version` of its own at all.
    if (typeof d.getReleaseCommit === 'function') {
      const resolved = await d.getReleaseCommit(enrichedData.version || params.version, scope);
      if (typeof resolved === 'string' && resolved) enrichedData.releaseCommit = resolved;
    }
    const summary = buildNativeSprintReportSummary(enrichedData);
    // #3175: settled/postMortem merged onto a COPY of the summary, same
    // reasoning as `enrichedData` above -- resolved against
    // `enrichedData.version` (what the lookup actually resolved), not the
    // raw `params.version`, for the same "current" case `getReleaseCommit`
    // above already guards against.
    let report = summary;
    if (typeof d.getSprintReportHtml === 'function') {
      const html = await d.getSprintReportHtml(enrichedData.version || params.version, scope);
      if (typeof html === 'string') {
        const settlement = parseSprintReportSettlement(html);
        report = { ...summary, settled: settlement.settled, postMortem: settlement.postMortem };
      }
    }
    jsonResponse(res, 200, { ok: true, report });
  }

  async function handleSyncWaves(req, res) {
    if (typeof d.authorizeSync === 'function' && !d.authorizeSync(req, res)) return;
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
    { method: 'POST', pattern: '/api/sprint-waves/sync', handler: handleSyncWaves },
    { method: 'GET', pattern: '/api/sprint-waves/github-activity', handler: handleGetGithubActivity }
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
    endpoints: table.map((entry) => ({ method: entry.method, pattern: entry.pattern, handler: entry.handler })),
    handle
  };
}

module.exports = { createSprintWaveRouter };
