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

describe('API /api/shared-docs', () => {
  let tmpDir;
  let server;
  let groupId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-shareddocs-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a test group
    const group = store.projectGroups.create({ name: 'DocTestGroup' });
    groupId = group.id;

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/shared-docs returns empty list initially', async () => {
    const { status, data } = await request(server, 'GET', '/api/shared-docs');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.docs));
    assert.equal(data.docs.length, 0);
  });

  it('POST /api/shared-docs creates a document', async () => {
    const { status, data } = await request(server, 'POST', '/api/shared-docs', {
      groupId,
      name: 'API Guide',
      filePath: '/tmp/api-guide.md',
      injectIntoConfig: true,
      injectMode: 'reference',
      description: 'API documentation'
    });
    assert.equal(status, 201);
    assert.equal(data.name, 'API Guide');
    assert.equal(data.groupId, groupId);
    assert.equal(data.injectIntoConfig, true);
    assert.equal(data.injectMode, 'reference');
  });

  it('POST /api/shared-docs rejects missing required fields', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs', { name: 'Incomplete' });
    assert.equal(status, 400);
  });

  it('POST /api/shared-docs rejects invalid injectMode', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs', {
      groupId,
      name: 'Bad Mode',
      filePath: '/tmp/bad.md',
      injectMode: 'invalid'
    });
    assert.equal(status, 400);
  });

  it('POST /api/shared-docs rejects nonexistent group', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs', {
      groupId: 'nonexistent-group',
      name: 'Orphan',
      filePath: '/tmp/orphan.md'
    });
    assert.equal(status, 404);
  });

  it('POST /api/shared-docs rejects duplicate file path in same group', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs', {
      groupId,
      name: 'Dup',
      filePath: '/tmp/api-guide.md'
    });
    assert.equal(status, 409);
  });

  it('GET /api/shared-docs?groupId= filters by group', async () => {
    const { status, data } = await request(server, 'GET', `/api/shared-docs?groupId=${groupId}`);
    assert.equal(status, 200);
    assert.ok(data.docs.length >= 1);
    assert.ok(data.docs.every(d => d.groupId === groupId));
  });

  it('GET /api/shared-docs/:id returns a document with lock status', async () => {
    const listRes = await request(server, 'GET', '/api/shared-docs');
    const docId = listRes.data.docs[0].id;

    const { status, data } = await request(server, 'GET', `/api/shared-docs/${docId}`);
    assert.equal(status, 200);
    assert.equal(data.name, 'API Guide');
    assert.equal(data.lock, null);
  });

  it('GET /api/shared-docs/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'GET', '/api/shared-docs/nonexistent');
    assert.equal(status, 404);
  });

  it('PUT /api/shared-docs/:id updates a document', async () => {
    const listRes = await request(server, 'GET', '/api/shared-docs');
    const docId = listRes.data.docs[0].id;

    const { status, data } = await request(server, 'PUT', `/api/shared-docs/${docId}`, {
      name: 'Updated Guide',
      description: 'Updated desc'
    });
    assert.equal(status, 200);
    assert.equal(data.name, 'Updated Guide');
    assert.equal(data.description, 'Updated desc');
  });

  it('PUT /api/shared-docs/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'PUT', '/api/shared-docs/nonexistent', { name: 'X' });
    assert.equal(status, 404);
  });

  it('DELETE /api/shared-docs/:id deletes a document', async () => {
    // Create a doc to delete
    const createRes = await request(server, 'POST', '/api/shared-docs', {
      groupId,
      name: 'ToDelete',
      filePath: '/tmp/delete-me.md'
    });
    const docId = createRes.data.id;

    const { status, data } = await request(server, 'DELETE', `/api/shared-docs/${docId}`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);

    // Confirm gone
    const getRes = await request(server, 'GET', `/api/shared-docs/${docId}`);
    assert.equal(getRes.status, 404);
  });

  it('DELETE /api/shared-docs/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'DELETE', '/api/shared-docs/nonexistent');
    assert.equal(status, 404);
  });
});

describe('API /api/shared-docs/:id/lock', () => {
  let tmpDir;
  let server;
  let groupId;
  let docId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-locks-'));
    store._setBasePath(tmpDir);
    store.init();

    const group = store.projectGroups.create({ name: 'LockTestGroup' });
    groupId = group.id;

    const doc = store.sharedDocs.create({
      groupId,
      name: 'LockableDoc',
      filePath: '/tmp/lockable.md',
      injectIntoConfig: true
    });
    docId = doc.id;

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/shared-docs/:id/lock shows unlocked state', async () => {
    const { status, data } = await request(server, 'GET', `/api/shared-docs/${docId}/lock`);
    assert.equal(status, 200);
    assert.equal(data.locked, false);
    assert.equal(data.lock, null);
  });

  it('POST /api/shared-docs/:id/lock acquires a lock', async () => {
    const { status, data } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {
      sessionId: 1,
      projectName: 'test-project'
    });
    assert.equal(status, 200);
    assert.equal(data.documentId, docId);
    assert.equal(data.lockedBySession, 1);
    assert.equal(data.lockedByProject, 'test-project');
    assert.ok(data.expiresAt);
  });

  it('GET /api/shared-docs/:id/lock shows locked state', async () => {
    const { status, data } = await request(server, 'GET', `/api/shared-docs/${docId}/lock`);
    assert.equal(status, 200);
    assert.equal(data.locked, true);
    assert.equal(data.lock.lockedByProject, 'test-project');
  });

  it('POST /api/shared-docs/:id/lock returns conflict when already locked', async () => {
    const { status, data } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {
      sessionId: 2,
      projectName: 'other-project'
    });
    assert.equal(status, 409);
    assert.equal(data.code, 'LOCK_CONFLICT');
  });

  it('POST /api/shared-docs/:id/lock rejects missing fields', async () => {
    const { status } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {});
    assert.equal(status, 400);
  });

  it('POST /api/shared-docs/:id/lock returns 404 for unknown doc', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs/nonexistent/lock', {
      sessionId: 1,
      projectName: 'test'
    });
    assert.equal(status, 404);
  });

  it('DELETE /api/shared-docs/:id/lock releases a lock', async () => {
    const { status, data } = await request(server, 'DELETE', `/api/shared-docs/${docId}/lock`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);

    // Confirm unlocked
    const getRes = await request(server, 'GET', `/api/shared-docs/${docId}/lock`);
    assert.equal(getRes.data.locked, false);
  });

  it('DELETE /api/shared-docs/:id/lock returns 404 for unknown doc', async () => {
    const { status } = await request(server, 'DELETE', '/api/shared-docs/nonexistent/lock');
    assert.equal(status, 404);
  });

  it('GET /api/shared-docs/:id/lock returns 404 for unknown doc', async () => {
    const { status } = await request(server, 'GET', '/api/shared-docs/nonexistent/lock');
    assert.equal(status, 404);
  });

  it('POST /api/shared-docs/:id/lock overrides expired lock', async () => {
    // Acquire with very short TTL — we'll manipulate the DB directly
    store.documentLocks.acquire(docId, 10, 'old-project', 0.001); // ~60ms TTL
    // Wait briefly for expiry
    const start = Date.now();
    while (Date.now() - start < 100) { /* spin */ }

    const { status, data } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {
      sessionId: 20,
      projectName: 'new-project'
    });
    assert.equal(status, 200);
    assert.equal(data.lockedByProject, 'new-project');

    // Clean up
    store.documentLocks.release(docId);
  });
});
