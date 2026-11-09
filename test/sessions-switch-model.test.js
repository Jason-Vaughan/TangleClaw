'use strict';

/*
 * Route-level coverage for #2598's second admission bug: POST
 * /api/sessions/:project/switch-model refusing a verified Fleet Coordinator
 * switching one of its own fleet's sibling lanes (403 FORBIDDEN).
 * lib/model-switch.js's own boundary logic (the self-request exception, the
 * OTHER #2598 bug) is covered in test/model-switch.test.js; this file only
 * exercises the route handler's OWN admission branch (the `fleetCoordinator`
 * check in lib/routes/sessions.js), which nothing calling
 * switchSessionModel() directly can reach — that branch, and the message it
 * produces on refusal, live entirely in the route, not in lib/model-switch.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');
const { bindProject, sendAs } = require('./_shared-docs-callers');

/** Make `project` a verified Fleet Coordinator: the flag on disk, the role in the DB. */
function makeCoordinator(project) {
  const config = store.projectConfig.load(project.path);
  store.projectConfig.save(project.path, { ...config, fleetCoordinator: true });
  store.coordinatorRoles.grant({
    roleId: `role_${project.id}`, projectId: project.id, role: 'project-manager', note: null, now: new Date().toISOString()
  });
}

describe('POST /api/sessions/:project/switch-model — Fleet Coordinator admission (#2598)', () => {
  let tmpDir;
  let server;
  let projectsDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-switch-model-route-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProject(name) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return store.projects.create({ name, path: dir });
  }

  it('a verified Fleet Coordinator passes admission for a sibling in its namespace (refused only for having no active session, never 403)', async () => {
    const pm = makeProject('TC-PM');
    makeCoordinator(pm);
    const pmBind = bindProject(pm);
    const target = makeProject('TC-Lane-X');

    const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/switch-model`,
      { engine: 'claude', model: 'claude-sonnet-5' }, pmBind.headers);

    // Whatever switchSessionModel() itself makes of the request (here,
    // ENGINE_HAS_NO_MODELS from this fresh store's real engine registry
    // having no cached model list — a downstream validation detail, not
    // this route's own admission gate) is fine. The one thing that must
    // never happen is the 403 the route used to answer before #2598.
    assert.notEqual(res.status, 403, JSON.stringify(res.data));
    assert.notEqual(res.data.code, 'FORBIDDEN', 'must reach switchSessionModel, not be turned back at the 403 admission gate');
  });

  it('refuses the same verified Fleet Coordinator for outage-takeover mode (self, Operator or Master only)', async () => {
    const pm = makeProject('TC-PM2');
    makeCoordinator(pm);
    const pmBind = bindProject(pm);
    const target = makeProject('TC-Lane-Y');

    const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/switch-model`,
      { engine: 'claude', model: 'claude-sonnet-5', mode: 'outage-takeover' }, pmBind.headers);

    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'FORBIDDEN');
  });

  it('refuses a verified Fleet Coordinator for a project OUTSIDE its own fleet namespace', async () => {
    const pm = makeProject('TC-PM3');
    makeCoordinator(pm);
    const pmBind = bindProject(pm);
    const outsider = makeProject('Other-Lane-X');

    const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(outsider.name)}/switch-model`,
      { engine: 'claude', model: 'claude-sonnet-5' }, pmBind.headers);

    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'FORBIDDEN');
    assert.match(res.data.error, /verified Fleet Coordinator/);
  });

  it('refuses a project that is not a verified Fleet Coordinator at all, trying to switch a sibling', async () => {
    const plain = makeProject('TC-Plain');
    const plainBind = bindProject(plain);
    const target = makeProject('TC-Lane-Z');

    const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/switch-model`,
      { engine: 'claude', model: 'claude-sonnet-5' }, plainBind.headers);

    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'FORBIDDEN');
  });

  it('self-service is unaffected: a project switching its own model still reaches switchSessionModel (no regression)', async () => {
    const target = makeProject('TC-Lane-Self');
    const selfBind = bindProject(target);

    const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/switch-model`,
      { engine: 'claude', model: 'claude-sonnet-5' }, selfBind.headers);

    // Same reasoning as the coordinator case above: whatever downstream
    // validation switchSessionModel() itself applies is not this test's
    // concern. Self-service must never be turned back at the 403 gate.
    assert.notEqual(res.status, 403, JSON.stringify(res.data));
    assert.notEqual(res.data.code, 'FORBIDDEN');
  });
});
