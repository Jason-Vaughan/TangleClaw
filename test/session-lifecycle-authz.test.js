'use strict';

/**
 * #2129: session-lifecycle mutation routes (launch, kill, the four `/wrap*`
 * routes) must independently enforce WHO may do WHAT, rather than relying on
 * the generic launch-binding floor (`judge()`, already proven elsewhere) plus
 * caller self-restraint. This file tests the NEW narrower rule
 * `_requireSessionLifecycleCaller` adds on top of that floor: launch/kill are
 * operator-or-Master-only (never a project's own session, even its own), a
 * wrap is the operator, the Master, or the project's own CURRENT session
 * acting on ITSELF (never another project's), and the Master additionally
 * passes through its own lifecycle-authority gate (#2132/#966).
 *
 * @module test/session-lifecycle-authz
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const master = require('../lib/master');
const masterAuthority = require('../lib/master-authority');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

function request(server, method, urlPath, body, callerHeaders = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const bodyStr = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...callerHeaders };
    if (bodyStr !== null) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

function operatorRequest(server, method, urlPath, body) {
  return request(server, method, urlPath, body, operatorHeaders(server));
}

/**
 * Headers that make a request the live Project Master, by stubbing
 * `master.liveMasterLaunchId` to answer the given id — the same pattern
 * `test/api-sessions.test.js` already uses for this.
 * @param {string} launchId
 * @returns {Record<string, string>}
 */
function masterHeaders(launchId) {
  return { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': launchId };
}

describe('session-lifecycle caller-identity enforcement (#2129)', () => {
  let tmpDir;
  let server;
  let projectA;
  let projectB;
  const realLiveMasterLaunchId = master.liveMasterLaunchId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-session-authz-'));
    store._setBasePath(tmpDir);
    store.init();

    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    for (const name of ['authz-a', 'authz-b']) {
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      store.projects.create({ name, path: dir, engine: 'claude' });
    }
    projectA = store.projects.getByName('authz-a');
    projectB = store.projects.getByName('authz-b');

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    master.liveMasterLaunchId = realLiveMasterLaunchId;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    master.liveMasterLaunchId = realLiveMasterLaunchId;
    const config = store.config.load();
    delete config.master;
    store.config.save(config);
  });

  describe('launch (POST /api/sessions/:project) — operator or Master only', () => {
    it('the operator may launch', async () => {
      const res = await operatorRequest(server, 'POST', '/api/sessions/authz-a', {});
      assert.equal(res.status, 201);
      await operatorRequest(server, 'DELETE', '/api/sessions/authz-a', {});
    });

    it('the Master, with lifecycle authority granted, may launch', async () => {
      master.liveMasterLaunchId = () => ({ launchId: 'm-launch-1', answered: true, cause: null });
      const config = store.config.load();
      config.master = { apiTokenEnabled: true };
      masterAuthority.ensureApiTokenWhenEnabled(config);
      masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'test-operator' });
      store.config.save(config);

      const res = await request(server, 'POST', '/api/sessions/authz-a', {},
        { ...masterHeaders('m-launch-1'), Authorization: `Bearer ${config.master.apiToken}` });
      assert.equal(res.status, 201);
      await operatorRequest(server, 'DELETE', '/api/sessions/authz-a', {});
    });

    it('the Master is refused while its lifecycle authority is read-only (403 AUTHORITY_READ_ONLY)', async () => {
      master.liveMasterLaunchId = () => ({ launchId: 'm-launch-2', answered: true, cause: null });
      const config = store.config.load();
      config.master = { apiTokenEnabled: true };
      masterAuthority.ensureApiTokenWhenEnabled(config);
      store.config.save(config);

      const res = await request(server, 'POST', '/api/sessions/authz-a', {},
        { ...masterHeaders('m-launch-2'), Authorization: `Bearer ${config.master.apiToken}` });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'AUTHORITY_READ_ONLY');
    });

    it('the Master is refused with a wrong token (401 INVALID_MASTER_API_TOKEN)', async () => {
      master.liveMasterLaunchId = () => ({ launchId: 'm-launch-3', answered: true, cause: null });
      const config = store.config.load();
      config.master = { apiTokenEnabled: true };
      masterAuthority.ensureApiTokenWhenEnabled(config);
      masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'test-operator' });
      store.config.save(config);

      const res = await request(server, 'POST', '/api/sessions/authz-a', {},
        { ...masterHeaders('m-launch-3'), Authorization: 'Bearer not-the-real-token' });
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'INVALID_MASTER_API_TOKEN');
    });

    it('a project\'s own current session may NOT launch itself (403 SESSION_LIFECYCLE_FORBIDDEN) — the gap #2129 closes', async () => {
      const bound = bindProject(projectA);
      const res = await request(server, 'POST', '/api/sessions/authz-a', {}, bound.headers);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'SESSION_LIFECYCLE_FORBIDDEN');
      store.sessions.kill(bound.sessionId, 'test cleanup');
    });

    it('an unbound (headerless) caller is refused before reaching this check (403 LAUNCH_BINDING_REQUIRED)', async () => {
      const res = await request(server, 'POST', '/api/sessions/authz-a', {});
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'LAUNCH_BINDING_REQUIRED');
    });
  });

  describe('kill (DELETE /api/sessions/:project) — operator or Master only', () => {
    it('a project\'s own current session may NOT kill itself (403 SESSION_LIFECYCLE_FORBIDDEN)', async () => {
      const launch = await operatorRequest(server, 'POST', '/api/sessions/authz-a', {});
      assert.equal(launch.status, 201);
      const bound = bindProject(projectA);
      const res = await request(server, 'DELETE', '/api/sessions/authz-a', {}, bound.headers);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'SESSION_LIFECYCLE_FORBIDDEN');
      store.sessions.kill(bound.sessionId, 'test cleanup');
      await operatorRequest(server, 'DELETE', '/api/sessions/authz-a', {});
    });

    it('the operator may kill', async () => {
      await operatorRequest(server, 'POST', '/api/sessions/authz-a', {});
      const res = await operatorRequest(server, 'DELETE', '/api/sessions/authz-a', {});
      assert.equal(res.status, 200);
    });
  });

  describe('wrap (POST /api/sessions/:project/wrap and siblings) — operator, Master, or the project\'s OWN current session', () => {
    it('the project\'s own current session may start a wrap on itself', async () => {
      const bound = bindProject(projectA);
      const res = await request(server, 'POST', '/api/sessions/authz-a/wrap', {}, bound.headers);
      // Whatever the wrap pipeline itself decides (it may 409 on a password/
      // config precondition) — the point is it is NOT refused as a caller-
      // identity mismatch; it must never read SESSION_LIFECYCLE_FORBIDDEN or
      // the generic launch-binding codes.
      assert.notEqual(res.body && res.body.code, 'SESSION_LIFECYCLE_FORBIDDEN');
      assert.notEqual(res.status, 403);
      store.sessions.kill(bound.sessionId, 'test cleanup');
    });

    it('a project\'s own current session may NOT wrap a DIFFERENT project (403 SESSION_LIFECYCLE_FORBIDDEN)', async () => {
      const boundA = bindProject(projectA);
      const res = await request(server, 'POST', '/api/sessions/authz-b/wrap', {}, boundA.headers);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'SESSION_LIFECYCLE_FORBIDDEN');
      store.sessions.kill(boundA.sessionId, 'test cleanup');
    });

    it('a stale project claim (the launch exists but is not the project\'s CURRENT session) is refused as LAUNCH_BINDING_INVALID', async () => {
      const first = bindProject(projectA);
      const second = bindProject(projectA); // supersedes `first` as the current session
      const res = await request(server, 'POST', '/api/sessions/authz-a/wrap', {}, first.headers);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'LAUNCH_BINDING_INVALID');
      store.sessions.kill(first.sessionId, 'test cleanup');
      store.sessions.kill(second.sessionId, 'test cleanup');
    });
  });
});
