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

describe('API /api/ports', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-ports-'));
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

  it('GET /api/ports returns expected shape with grouped leases', async () => {
    // Seed some leases
    store.portLeases.lease({ port: 3100, project: 'TangleClaw', service: 'ttyd', permanent: true });
    store.portLeases.lease({ port: 3101, project: 'TangleClaw', service: 'server', permanent: true });
    store.portLeases.lease({ port: 4000, project: 'OtherProj', service: 'dev' });

    const { status, data } = await request(server, 'GET', '/api/ports');
    assert.equal(status, 200);
    assert.equal(data.totalLeases, 3);
    assert.ok(Array.isArray(data.leases));
    assert.ok(data.grouped.TangleClaw);
    assert.equal(data.grouped.TangleClaw.length, 2);
    assert.ok(data.grouped.OtherProj);
    assert.equal(data.grouped.OtherProj.length, 1);
  });

  it('POST /api/ports/lease creates a lease', async () => {
    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5000,
      project: 'NewProject',
      service: 'api',
      permanent: true
    });
    assert.equal(status, 201);
    assert.equal(data.port, 5000);
    assert.equal(data.project, 'NewProject');
    assert.equal(data.service, 'api');
    assert.equal(data.permanent, true);
  });

  it('POST /api/ports/lease validates required fields', async () => {
    const { status } = await request(server, 'POST', '/api/ports/lease', { port: 5001 });
    assert.equal(status, 400);
  });

  it('POST /api/ports/release removes a lease', async () => {
    store.portLeases.lease({ port: 6000, project: 'ToRelease', service: 'temp' });

    const { status, data } = await request(server, 'POST', '/api/ports/release', { port: 6000 });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.port, 6000);

    assert.equal(store.portLeases.get(6000), null);
  });

  it('POST /api/ports/heartbeat updates a lease', async () => {
    store.portLeases.lease({ port: 7000, project: 'HB', service: 'dev', ttlMs: 60000 });

    const { status, data } = await request(server, 'POST', '/api/ports/heartbeat', { port: 7000 });
    assert.equal(status, 200);
    assert.equal(data.port, 7000);
    assert.ok(data.lastHeartbeat);
  });

  it('POST /api/ports/heartbeat returns 404 for unknown port', async () => {
    const { status } = await request(server, 'POST', '/api/ports/heartbeat', { port: 99999 });
    assert.equal(status, 404);
  });
});
