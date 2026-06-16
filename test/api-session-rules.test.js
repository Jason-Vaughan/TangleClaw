'use strict';

/*
 * HTTP route tests for the session-rules REST API (#347/D1a):
 * GET/POST/PUT/DELETE /api/session-rules. Mirrors the harness in
 * test/api-actions.test.js (real server on an ephemeral port).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { createServer } = require('../server');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('api/session-rules (#347/D1a)', () => {
  let server;
  let port;
  let tmpDir;

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json' }
      };
      const bodyStr = body ? JSON.stringify(body) : null;
      if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-session-rules-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: create → list → update → delete', async () => {
    // Create
    const created = await request('POST', '/api/session-rules', { content: 'Prefer small commits' });
    assert.equal(created.status, 201);
    assert.equal(created.data.content, 'Prefer small commits');
    assert.equal(created.data.projectId, null);
    assert.equal(created.data.createdBy, 'operator');
    const id = created.data.id;

    // List (global scope)
    const listed = await request('GET', '/api/session-rules?scope=global');
    assert.equal(listed.status, 200);
    assert.ok(listed.data.rules.some((r) => r.id === id));

    // Update (disable)
    const updated = await request('PUT', `/api/session-rules/${id}`, { enabled: false });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.enabled, false);

    // Delete
    const deleted = await request('DELETE', `/api/session-rules/${id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.ok, true);

    const afterDelete = await request('GET', '/api/session-rules?scope=global');
    assert.ok(!afterDelete.data.rules.some((r) => r.id === id));
  });

  it('rejects empty content with 400', async () => {
    const res = await request('POST', '/api/session-rules', { content: '   ' });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'BAD_REQUEST');
  });

  it('returns 404 updating a missing rule', async () => {
    const res = await request('PUT', '/api/session-rules/99999', { enabled: false });
    assert.equal(res.status, 404);
  });

  it('returns 404 deleting a missing rule', async () => {
    const res = await request('DELETE', '/api/session-rules/99999');
    assert.equal(res.status, 404);
  });
});
