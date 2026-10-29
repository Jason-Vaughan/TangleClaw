'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { operatorOf } = require('./_shared-docs-callers');
const { createServer } = require('../server');

// The operator routes that grant authority need a signed-in operator (#2378).
// A suite that calls one turns the login on; this answers the operator's
// signed-in session there, and the dashboard's own shape wherever the login
// is still off, so every other request is sent exactly as before.
const operators = new WeakMap();

/**
 * The headers the operator's browser sends to this server, in whatever state
 * its login is in (see `operatorOf`).
 * @param {import('node:http').Server} server - The listening test server
 * @returns {Promise<Record<string, string>>}
 */
function operatorFor(server) {
  if (!operators.has(server)) operators.set(server, operatorOf(server));
  return operators.get(server)();
}

setLevel('error');

/**
 * Make an HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: object }>}
 */
async function request(server, method, urlPath, body) {
  const operatorWrite = await operatorFor(server);
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      // These suites exercise the dashboard's group and document management,
      // so every request is the operator's; a bare machine request is refused.
      headers: { 'Content-Type': 'application/json', ...operatorWrite }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('API /api/groups', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-groups-'));
    store._setBasePath(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/groups returns empty list initially', async () => {
    const { status, data } = await request(server, 'GET', '/api/groups');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.groups));
    assert.equal(data.groups.length, 0);
  });

  it('POST /api/groups creates a group', async () => {
    const { status, data } = await request(server, 'POST', '/api/groups', {
      name: 'TestGroup',
      description: 'A test group'
    });
    assert.equal(status, 201);
    assert.equal(data.name, 'TestGroup');
    assert.equal(data.description, 'A test group');
    assert.ok(data.id);
  });

  it('POST /api/groups rejects missing name', async () => {
    const { status } = await request(server, 'POST', '/api/groups', { description: 'no name' });
    assert.equal(status, 400);
  });

  it('POST /api/groups rejects duplicate name', async () => {
    await request(server, 'POST', '/api/groups', { name: 'DupGroup' });
    const { status, data } = await request(server, 'POST', '/api/groups', { name: 'DupGroup' });
    assert.equal(status, 409);
    assert.equal(data.code, 'CONFLICT');
  });

  it('GET /api/groups returns created groups with counts', async () => {
    const { status, data } = await request(server, 'GET', '/api/groups');
    assert.equal(status, 200);
    assert.ok(data.groups.length >= 1);
    const testGroup = data.groups.find(g => g.name === 'TestGroup');
    assert.ok(testGroup);
    assert.equal(testGroup.memberCount, 0);
    assert.equal(testGroup.docCount, 0);
  });

  it('GET /api/groups/:id returns a single group', async () => {
    const createRes = await request(server, 'POST', '/api/groups', { name: 'GetOneGroup' });
    const { status, data } = await request(server, 'GET', `/api/groups/${createRes.data.id}`);
    assert.equal(status, 200);
    assert.equal(data.name, 'GetOneGroup');
    assert.ok(Array.isArray(data.members));
    assert.ok(Array.isArray(data.docs));
  });

  it('GET /api/groups/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'GET', '/api/groups/nonexistent-id');
    assert.equal(status, 404);
  });

  it('PUT /api/groups/:id updates a group', async () => {
    const createRes = await request(server, 'POST', '/api/groups', { name: 'UpdateMe' });
    const { status, data } = await request(server, 'PUT', `/api/groups/${createRes.data.id}`, {
      name: 'Updated',
      description: 'new desc'
    });
    assert.equal(status, 200);
    assert.equal(data.name, 'Updated');
    assert.equal(data.description, 'new desc');
  });

  it('PUT /api/groups/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'PUT', '/api/groups/nonexistent-id', { name: 'X' });
    assert.equal(status, 404);
  });

  it('DELETE /api/groups/:id deletes a group', async () => {
    const createRes = await request(server, 'POST', '/api/groups', { name: 'DeleteMe' });
    const { status, data } = await request(server, 'DELETE', `/api/groups/${createRes.data.id}`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);

    // Confirm gone
    const getRes = await request(server, 'GET', `/api/groups/${createRes.data.id}`);
    assert.equal(getRes.status, 404);
  });

  it('DELETE /api/groups/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'DELETE', '/api/groups/nonexistent-id');
    assert.equal(status, 404);
  });
});

describe('API /api/groups/:id/members', () => {
  let tmpDir;
  let server;
  let groupId;
  let projectId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-members-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a test project
    const projPath = path.join(tmpDir, 'test-proj');
    fs.mkdirSync(projPath, { recursive: true });
    const project = store.projects.create({
      name: 'test-proj',
      path: projPath,
      engine: 'claude'
    });
    projectId = project.id;

    // Create a test group
    const group = store.projectGroups.create({ name: 'MemberTestGroup' });
    groupId = group.id;

    // This suite calls operator routes that grant authority over sessions,

    // which need the operator signed in (#2378): the login is on, and

    // `operatorFor` sends the operator's session.
    store.config.save({ ...store.config.load(), authEnabled: true, basicAuthUser: null, basicAuthHash: null });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/groups/:id/members returns empty list', async () => {
    const { status, data } = await request(server, 'GET', `/api/groups/${groupId}/members`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.members));
    assert.equal(data.members.length, 0);
  });

  it('POST /api/groups/:id/members adds a member', async () => {
    const { status, data } = await request(server, 'POST', `/api/groups/${groupId}/members`, {
      projectId
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  });

  it('GET /api/groups/:id/members returns enriched members', async () => {
    const { status, data } = await request(server, 'GET', `/api/groups/${groupId}/members`);
    assert.equal(status, 200);
    assert.equal(data.members.length, 1);
    assert.equal(data.members[0].id, projectId);
    assert.equal(data.members[0].name, 'test-proj');
  });

  it('POST /api/groups/:id/members rejects missing projectId', async () => {
    const { status } = await request(server, 'POST', `/api/groups/${groupId}/members`, {});
    assert.equal(status, 400);
  });

  it('POST /api/groups/:id/members returns 404 for unknown group', async () => {
    const { status } = await request(server, 'POST', '/api/groups/nonexistent/members', {
      projectId
    });
    assert.equal(status, 404);
  });

  it('POST /api/groups/:id/members returns 404 for unknown project', async () => {
    const { status } = await request(server, 'POST', `/api/groups/${groupId}/members`, {
      projectId: 99999
    });
    assert.equal(status, 404);
  });

  it('DELETE /api/groups/:id/members/:projectId removes a member', async () => {
    const { status, data } = await request(server, 'DELETE', `/api/groups/${groupId}/members/${projectId}`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);

    // Confirm removed
    const getRes = await request(server, 'GET', `/api/groups/${groupId}/members`);
    assert.equal(getRes.data.members.length, 0);
  });

  it('DELETE /api/groups/:id/members/:projectId returns 404 for unknown group', async () => {
    const { status } = await request(server, 'DELETE', `/api/groups/nonexistent/members/${projectId}`);
    assert.equal(status, 404);
  });
});

describe('API /api/groups/:id releaseOwnerProjectId (#1697)', () => {
  let tmpDir;
  let server;
  let groupId;
  let memberId;
  let otherId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-release-owner-'));
    store._setBasePath(tmpDir);
    store.init();

    // #1702 made 'operator' (release-capable) the unconfigured default, so
    // addMember's own auto-claim (#1697) would otherwise claim ownership the
    // moment either project joins. Pin both explicitly to 'off' so this
    // suite's PUT/GET route coverage starts from a genuinely vacant group.
    const memberPath = path.join(tmpDir, 'owner-proj');
    fs.mkdirSync(memberPath, { recursive: true });
    fs.mkdirSync(path.join(memberPath, '.tangleclaw'));
    fs.writeFileSync(path.join(memberPath, '.tangleclaw', 'project.json'), JSON.stringify({ releaseMode: 'off' }));
    memberId = store.projects.create({ name: 'owner-proj', path: memberPath, engine: 'claude' }).id;

    const otherPath = path.join(tmpDir, 'nonmember-proj');
    fs.mkdirSync(otherPath, { recursive: true });
    fs.mkdirSync(path.join(otherPath, '.tangleclaw'));
    fs.writeFileSync(path.join(otherPath, '.tangleclaw', 'project.json'), JSON.stringify({ releaseMode: 'off' }));
    otherId = store.projects.create({ name: 'nonmember-proj', path: otherPath, engine: 'claude' }).id;

    const group = store.projectGroups.create({ name: 'ReleaseOwnerGroup' });
    groupId = group.id;
    store.projectGroups.addMember(groupId, memberId);

    store.config.save({ ...store.config.load(), authEnabled: true, basicAuthUser: null, basicAuthHash: null });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/groups/:id reports releaseOwnerProjectId null before any owner is set', async () => {
    const { status, data } = await request(server, 'GET', `/api/groups/${groupId}`);
    assert.equal(status, 200);
    assert.equal(data.releaseOwnerProjectId, null);
  });

  it('PUT /api/groups/:id sets releaseOwnerProjectId to a current member', async () => {
    const { status, data } = await request(server, 'PUT', `/api/groups/${groupId}`, {
      releaseOwnerProjectId: memberId
    });
    assert.equal(status, 200);
    assert.equal(data.releaseOwnerProjectId, memberId);

    const getRes = await request(server, 'GET', `/api/groups/${groupId}`);
    assert.equal(getRes.data.releaseOwnerProjectId, memberId);
  });

  it('GET /api/groups includes releaseOwnerProjectId in the list view', async () => {
    const { data } = await request(server, 'GET', '/api/groups');
    const group = data.groups.find(g => g.id === groupId);
    assert.equal(group.releaseOwnerProjectId, memberId);
  });

  it('PUT /api/groups/:id rejects a non-member project id with 400', async () => {
    const { status } = await request(server, 'PUT', `/api/groups/${groupId}`, {
      releaseOwnerProjectId: otherId
    });
    assert.equal(status, 400);
    // The earlier, valid owner is unaffected by the rejected request.
    const getRes = await request(server, 'GET', `/api/groups/${groupId}`);
    assert.equal(getRes.data.releaseOwnerProjectId, memberId);
  });

  it('PUT /api/groups/:id clears releaseOwnerProjectId with an explicit null', async () => {
    const { status, data } = await request(server, 'PUT', `/api/groups/${groupId}`, {
      releaseOwnerProjectId: null
    });
    assert.equal(status, 200);
    assert.equal(data.releaseOwnerProjectId, null);
  });
});

describe('PATCH /api/projects/:name releaseMode group-ownership conflict (#1697, Architect B1)', () => {
  let tmpDir;
  let server;
  let ownerName;
  let otherName;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-patch-conflict-'));
    store._setBasePath(tmpDir);
    store.init();

    const ownerPath = path.join(tmpDir, 'patch-owner');
    fs.mkdirSync(ownerPath, { recursive: true });
    ownerName = store.projects.create({ name: 'patch-owner', path: ownerPath, engine: 'claude' }).name;
    const otherPath = path.join(tmpDir, 'patch-other');
    fs.mkdirSync(otherPath, { recursive: true });
    otherName = store.projects.create({ name: 'patch-other', path: otherPath, engine: 'claude' }).name;

    const ownerId = store.projects.getByName(ownerName).id;
    const otherId2 = store.projects.getByName(otherName).id;
    const group = store.projectGroups.create({ name: 'PatchConflictGroup' });
    store.projectGroups.addMember(group.id, ownerId);
    store.projectGroups.addMember(group.id, otherId2);
    store.projectGroups.claimReleaseOwnerIfVacant(group.id, ownerId);

    store.config.save({ ...store.config.load(), authEnabled: true, basicAuthUser: null, basicAuthHash: null });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PATCH /api/projects/:name returns 409 CONFLICT for a non-owner going release-capable', async () => {
    const { status, data } = await request(server, 'PATCH', `/api/projects/${otherName}`, { releaseMode: 'agent' });
    assert.equal(status, 409);
    assert.equal(data.code, 'CONFLICT');
    assert.match(data.error, /PatchConflictGroup/);
  });

  it('PATCH /api/projects/:name allows the actual owner through', async () => {
    const { status } = await request(server, 'PATCH', `/api/projects/${ownerName}`, { releaseMode: 'agent' });
    assert.equal(status, 200);
  });
});

describe('API /api/groups/:id/sync', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-sync-'));
    store._setBasePath(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/groups/:id/sync discovers .md files from sharedDir', async () => {
    // Create shared directory with files
    const sharedDir = path.join(tmpDir, 'shared-docs');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'NETWORK.md'), '# Network');
    fs.writeFileSync(path.join(sharedDir, 'SSH.md'), '# SSH');

    // Create group with sharedDir
    const groupRes = await request(server, 'POST', '/api/groups', {
      name: 'SyncTestGroup',
      sharedDir
    });
    assert.equal(groupRes.status, 201);
    assert.equal(groupRes.data.sharedDir, sharedDir);

    // Trigger sync
    const { status, data } = await request(server, 'POST', `/api/groups/${groupRes.data.id}/sync`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.added.length, 2);
    assert.ok(data.added.includes('NETWORK.md'));
    assert.ok(data.added.includes('SSH.md'));
  });

  it('POST /api/groups/:id/sync returns 400 when no sharedDir', async () => {
    const groupRes = await request(server, 'POST', '/api/groups', {
      name: 'NoDir'
    });
    const { status, data } = await request(server, 'POST', `/api/groups/${groupRes.data.id}/sync`);
    assert.equal(status, 400);
    assert.ok(data.error.includes('sharedDir'));
  });

  it('POST /api/groups/:id/sync returns 404 for unknown group', async () => {
    const { status } = await request(server, 'POST', '/api/groups/nonexistent/sync');
    assert.equal(status, 404);
  });

  it('POST /api/groups/:id/sync with sharedDir in group payload', async () => {
    const sharedDir = path.join(tmpDir, 'shared-docs2');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'API.md'), '# API');

    const groupRes = await request(server, 'POST', '/api/groups', {
      name: 'PayloadTest',
      sharedDir
    });

    // Verify sharedDir is returned in GET
    const getRes = await request(server, 'GET', `/api/groups/${groupRes.data.id}`);
    assert.equal(getRes.data.sharedDir, sharedDir);

    // Sync
    const syncRes = await request(server, 'POST', `/api/groups/${groupRes.data.id}/sync`);
    assert.equal(syncRes.data.added.length, 1);
    assert.ok(syncRes.data.added.includes('API.md'));
  });
});

describe('POST /api/groups/:id/members — defers-elsewhere does not double-claim (#2699 R-1/R-2)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-members-defer-'));
    store._setBasePath(tmpDir);
    store.init();
    store.config.save({ ...store.config.load(), authEnabled: true, basicAuthUser: null, basicAuthHash: null });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a project already deferring to a DIFFERENT group\'s owner does not also claim a second, vacant group it joins via the API', async () => {
    const ownerPath = path.join(tmpDir, 'defer-owner');
    fs.mkdirSync(ownerPath, { recursive: true });
    const ownerId = store.projects.create({ name: 'defer-owner', path: ownerPath, engine: 'claude' }).id;

    const memberPath = path.join(tmpDir, 'defer-member');
    fs.mkdirSync(memberPath, { recursive: true });
    const memberId = store.projects.create({ name: 'defer-member', path: memberPath, engine: 'claude' }).id;

    const groupA = await request(server, 'POST', '/api/groups', { name: 'defer-fleet-a' });
    const groupB = await request(server, 'POST', '/api/groups', { name: 'defer-fleet-b' });

    // owner joins groupA and auto-claims it (no on-disk config -> the
    // release-capable 'operator' default, #1702). member then joins the
    // SAME group too — groupA already has a DIFFERENT owner, so member's
    // own join is a no-op for ownership.
    const ownerJoinA = await request(server, 'POST', `/api/groups/${groupA.data.id}/members`, { projectId: ownerId });
    assert.equal(ownerJoinA.status, 200);
    const memberJoinA = await request(server, 'POST', `/api/groups/${groupA.data.id}/members`, { projectId: memberId });
    assert.equal(memberJoinA.status, 200);
    const groupAAfter = await request(server, 'GET', `/api/groups/${groupA.data.id}`);
    assert.equal(groupAAfter.data.releaseOwnerProjectId, ownerId);

    // Joining a second, vacant group through the same route must not ALSO
    // claim it for member — member already defers to groupA's owner (a
    // DIFFERENT project), and the point of R-1/R-2 is that this holds
    // through the real HTTP route, not just the direct store call.
    const memberJoinB = await request(server, 'POST', `/api/groups/${groupB.data.id}/members`, { projectId: memberId });
    assert.equal(memberJoinB.status, 200);
    const groupBAfter = await request(server, 'GET', `/api/groups/${groupB.data.id}`);
    assert.equal(groupBAfter.data.releaseOwnerProjectId, null,
      'groupB must stay vacant — member already holds release authority elsewhere');
  });
});
