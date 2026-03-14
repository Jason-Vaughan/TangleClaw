'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const store = require('../lib/store');
const { createServer } = require('../server');

let server;
let baseUrl;
let testDir;

/**
 * Make an HTTP request to the test server.
 * @param {string} urlPath
 * @param {object} [opts]
 * @returns {Promise<{status: number, data: object, headers: object}>}
 */
function request(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    };

    const bodyStr = opts.body ? JSON.stringify(opts.body) : null;
    if (bodyStr) {
      reqOpts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let data = null;
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('json') && body) {
          try { data = JSON.parse(body); } catch { data = body; }
        } else {
          data = body;
        }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

before(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-e2e-'));
  const projectsDir = path.join(testDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  store._setBasePath(path.join(testDir, 'tangleclaw'));
  store.init();
  const config = store.config.load();
  config.projectsDir = projectsDir;
  config.deletePassword = null;
  store.config.save(config);

  server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('E2E Smoke Tests — Happy Path Lifecycle', () => {

  it('server starts and health check returns ok', async () => {
    const res = await request('/api/health');
    assert.ok([200, 503].includes(res.status));
    assert.equal(typeof res.data.status, 'string');
    assert.equal(typeof res.data.version, 'string');
  });

  it('create project → get project → list includes it → delete → verify 404', async () => {
    // Create
    const createRes = await request('/api/projects', {
      method: 'POST',
      body: { name: 'e2e-lifecycle', engine: 'claude-code', methodology: 'minimal', tags: ['smoke'] }
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.name, 'e2e-lifecycle');

    // Get
    const getRes = await request('/api/projects/e2e-lifecycle');
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.name, 'e2e-lifecycle');

    // List
    const listRes = await request('/api/projects');
    assert.equal(listRes.status, 200);
    const found = listRes.data.projects.find(p => p.name === 'e2e-lifecycle');
    assert.ok(found, 'project should appear in list');

    // Delete
    const delRes = await request('/api/projects/e2e-lifecycle', {
      method: 'DELETE',
      body: { deleteFiles: true }
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.ok, true);

    // Verify 404
    const goneRes = await request('/api/projects/e2e-lifecycle');
    assert.equal(goneRes.status, 404);
  });

  it('engine list is non-empty and engines have expected fields', async () => {
    const res = await request('/api/engines');
    assert.equal(res.status, 200);
    assert.ok(res.data.engines.length > 0);
    assert.ok(res.data.engines.some(e => e.id === 'claude-code'));
  });

  it('methodology list is non-empty and methodologies have expected fields', async () => {
    const res = await request('/api/methodologies');
    assert.equal(res.status, 200);
    assert.ok(res.data.methodologies.length > 0);
    assert.ok(res.data.methodologies.some(m => m.id === 'minimal'));
  });

  it('system stats return valid resource data', async () => {
    const res = await request('/api/system');
    assert.equal(res.status, 200);
    assert.ok(res.data.cpu.cores > 0);
    assert.ok(res.data.memory.total > 0);
    assert.ok(res.data.uptime >= 0);
  });
});
