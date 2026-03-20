'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { createServer } = require('../server');

setLevel('error');

/**
 * Make an HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: object }>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
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
      engineId: 'claude',
      methodology: 'prawduct'
    });
    projectId = project.id;

    // Create a test group
    const group = store.projectGroups.create({ name: 'MemberTestGroup' });
    groupId = group.id;

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
