'use strict';

/**
 * #3325 (Fleet/Workspace Document & Wave Isolation): `createSprintWaveRouter`'s
 * own `resolveScope` dep -- resolved once per request for `GET
 * /api/sprint-waves`, `GET /api/sprint-reports/:version` and `GET
 * /api/sprint-waves/github-activity`, then threaded into every other scoped
 * dep call those three handlers make. `test/native-sprint-tracker.test.js`
 * already covers this router's non-scoping behavior end to end (dispatch
 * state, the roadmap snapshot, #3134/#3162/#3164/#3166/#3175's own threading);
 * this file is scoped to #3325's own addition: that `resolveScope`'s result
 * actually reaches every dep that needs it, and that omitting the dep keeps
 * every existing caller's behavior exactly as it was before #3325 (every dep
 * sees `{}` rather than `undefined`, so a dep reading `scope.sharedDir` never
 * throws on a caller that supplies none of this).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSprintWaveRouter } = require('../lib/routes/sprint-wave-routes');

/** @returns {{res: object, status: () => (number|null), json: () => (*|null)}} */
function fakeRes() {
  const state = { status: null, body: null };
  const res = {
    writeHead(status) { state.status = status; },
    end(body) { state.body = body; }
  };
  return {
    res,
    status: () => state.status,
    json: () => (state.body ? JSON.parse(state.body) : null)
  };
}

/**
 * A minimal fake `http.IncomingMessage`, same shape
 * `test/native-sprint-tracker.test.js`'s own `fakeReq` uses: a real
 * `EventEmitter` (so `parseBody`'s listeners attach cleanly) plus `method`,
 * `url` and `headers`. `headers` is overridable so a test can assert
 * `resolveScope` actually receives the real request object, not a copy.
 * @param {string} method
 * @param {string} url
 * @param {object} [headers]
 * @returns {EventEmitter}
 */
function fakeReq(method, url, headers) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers || { host: 'localhost' };
  return req;
}

describe('sprint-wave-routes: #3325 scope threading', () => {
  it('GET /api/sprint-waves resolves scope once and threads it into every scoped dep', async () => {
    const seen = {};
    const scope = { projectId: 7, fleetId: 'TiLT-Fleet', groupId: 'g1', projectPath: '/p', sharedDir: '/shared' };
    const router = createSprintWaveRouter({
      resolveScope: (req) => { seen.resolveScopeReq = req; return scope; },
      getSprintData: async (s) => { seen.getSprintData = s; return { waves: [], cars: [], lanes: [], pullRequests: [] }; },
      getRoadmapData: async (s) => { seen.getRoadmapData = s; return { data: { releases: [] }, repo: null, source: 'fallback' }; },
      getShippedVersions: async (s) => { seen.getShippedVersions = s; return []; },
      getReports: async (s) => { seen.getReports = s; return []; },
      getSyncStatus: async (s) => { seen.getSyncStatus = s; return null; },
      getReportsHubHtml: async (s) => { seen.getReportsHubHtml = s; return null; }
    });
    const req = fakeReq('GET', '/api/sprint-waves');
    const { res, status } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 200);
    assert.equal(seen.resolveScopeReq, req);
    for (const dep of ['getSprintData', 'getRoadmapData', 'getShippedVersions', 'getReports', 'getSyncStatus', 'getReportsHubHtml']) {
      assert.deepEqual(seen[dep], scope, `${dep} did not receive the resolved scope`);
    }
  });

  it('GET /api/sprint-waves threads the resolved scope into getSprintReportHtml, keyed off the resolved version', async () => {
    const scope = { projectId: 3, fleetId: null, groupId: null, projectPath: null, sharedDir: '/shared' };
    let seenScope = null;
    let seenVersion = null;
    const router = createSprintWaveRouter({
      resolveScope: () => scope,
      getSprintData: async () => ({ version: 'v1.2.3', waves: [], cars: [], lanes: [], pullRequests: [] }),
      getSprintReportHtml: async (version, s) => { seenVersion = version; seenScope = s; return null; }
    });
    const { res } = fakeRes();
    await router.handle(fakeReq('GET', '/api/sprint-waves'), res);
    assert.equal(seenVersion, 'v1.2.3');
    assert.deepEqual(seenScope, scope);
  });

  it('GET /api/sprint-waves passes {} to every scoped dep when resolveScope is omitted, unchanged from before #3325', async () => {
    const seen = {};
    const router = createSprintWaveRouter({
      getSprintData: async (s) => { seen.getSprintData = s; return { waves: [], cars: [], lanes: [], pullRequests: [] }; },
      getRoadmapData: async (s) => { seen.getRoadmapData = s; return null; },
      getShippedVersions: async (s) => { seen.getShippedVersions = s; return []; },
      getReports: async (s) => { seen.getReports = s; return []; }
    });
    const { res, status } = fakeRes();
    await router.handle(fakeReq('GET', '/api/sprint-waves'), res);
    assert.equal(status(), 200);
    for (const dep of ['getSprintData', 'getRoadmapData', 'getShippedVersions', 'getReports']) {
      assert.deepEqual(seen[dep], {}, `${dep} should have received {} with no resolveScope dep`);
    }
  });

  it('GET /api/sprint-reports/:version resolves scope once and threads it into getSprintDataForVersion, getReports, getReleaseCommit, getSprintReportHtml', async () => {
    const seen = {};
    const scope = { projectId: 11, fleetId: 'TiLT-Fleet', groupId: 'g2', projectPath: '/other-project', sharedDir: '/other-shared' };
    const router = createSprintWaveRouter({
      resolveScope: () => scope,
      getSprintDataForVersion: async (version, s) => { seen.getSprintDataForVersion = s; return { version, cars: [], pullRequests: [] }; },
      getReports: async (s) => { seen.getReports = s; return []; },
      getReleaseCommit: async (version, s) => { seen.getReleaseCommit = s; return null; },
      getSprintReportHtml: async (version, s) => { seen.getSprintReportHtml = s; return null; }
    });
    const { res, status } = fakeRes();
    await router.handle(fakeReq('GET', '/api/sprint-reports/v6.6.6'), res);
    assert.equal(status(), 200);
    for (const dep of ['getSprintDataForVersion', 'getReports', 'getReleaseCommit', 'getSprintReportHtml']) {
      assert.deepEqual(seen[dep], scope, `${dep} did not receive the resolved scope`);
    }
  });

  it('GET /api/sprint-reports/:version passes {} to every scoped dep when resolveScope is omitted, unchanged from before #3325', async () => {
    const seen = {};
    const router = createSprintWaveRouter({
      getSprintDataForVersion: async (version, s) => { seen.getSprintDataForVersion = s; return { version, cars: [], pullRequests: [] }; },
      getReports: async (s) => { seen.getReports = s; return []; },
      getReleaseCommit: async (version, s) => { seen.getReleaseCommit = s; return null; }
    });
    const { res, status } = fakeRes();
    await router.handle(fakeReq('GET', '/api/sprint-reports/v6.6.6'), res);
    assert.equal(status(), 200);
    for (const dep of ['getSprintDataForVersion', 'getReports', 'getReleaseCommit']) {
      assert.deepEqual(seen[dep], {}, `${dep} should have received {} with no resolveScope dep`);
    }
  });

  it('GET /api/sprint-reports/:version refuses a malformed version 400 without ever resolving scope (#3087 ordering preserved)', async () => {
    let resolved = false;
    const router = createSprintWaveRouter({
      resolveScope: () => { resolved = true; return {}; },
      getSprintDataForVersion: async () => null
    });
    const { res, status, json } = fakeRes();
    await router.handle(fakeReq('GET', '/api/sprint-reports/not-a-version'), res);
    assert.equal(status(), 400);
    assert.equal(json().code, 'BAD_REQUEST');
    assert.equal(resolved, false);
  });

  it('GET /api/sprint-waves/github-activity resolves scope once and threads it into getGithubActivity', async () => {
    const scope = { projectId: 9, fleetId: 'TiLT-Fleet', groupId: null, projectPath: null, sharedDir: null };
    let seenScope = null;
    const router = createSprintWaveRouter({
      resolveScope: () => scope,
      getGithubActivity: async (s) => { seenScope = s; return { ok: true, repo: 'a/b', pullRequests: [] }; }
    });
    const { res, status } = fakeRes();
    await router.handle(fakeReq('GET', '/api/sprint-waves/github-activity'), res);
    assert.equal(status(), 200);
    assert.deepEqual(seenScope, scope);
  });

  it('GET /api/sprint-waves/github-activity passes {} to getGithubActivity when resolveScope is omitted, unchanged from before #3325', async () => {
    let seenScope = 'unset';
    const router = createSprintWaveRouter({
      getGithubActivity: async (s) => { seenScope = s; return { ok: true, repo: 'a/b', pullRequests: [] }; }
    });
    const { res, status } = fakeRes();
    await router.handle(fakeReq('GET', '/api/sprint-waves/github-activity'), res);
    assert.equal(status(), 200);
    assert.deepEqual(seenScope, {});
  });

  it('GET /api/sprint-waves/github-activity answers 503 with no getGithubActivity dep, never calling resolveScope', async () => {
    let resolved = false;
    const router = createSprintWaveRouter({ resolveScope: () => { resolved = true; return {}; } });
    const { res, status, json } = fakeRes();
    await router.handle(fakeReq('GET', '/api/sprint-waves/github-activity'), res);
    assert.equal(status(), 503);
    assert.equal(json().code, 'NOT_CONFIGURED');
    assert.equal(resolved, false);
  });
});
