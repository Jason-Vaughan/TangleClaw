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

  // #613 — the API used to upsert unconditionally, so a lease request for a
  // port another project owned silently replaced the owner with a 201. The
  // documented contract said "never overwrite another project's lease"; it was
  // enforced only by client convention, and the convention failed live.
  it('POST /api/ports/lease returns 409 when another project owns the port', async () => {
    store.portLeases.lease({ port: 5100, project: 'Owner', service: 'dev-server' });

    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5100,
      project: 'Intruder',
      service: 'api'
    });

    assert.equal(status, 409, 'a taken port is a conflict, not a bad request');
    assert.equal(data.code, 'PORT_CONFLICT');
    assert.equal(data.owner.project, 'Owner', 'the response names the owner so the caller can choose another port');
    assert.equal(data.owner.service, 'dev-server');
    assert.equal(store.portLeases.get(5100).project, 'Owner', 'the owner keeps the lease');
  });

  it('POST /api/ports/lease renews the same project\'s own lease with 201', async () => {
    store.portLeases.lease({ port: 5101, project: 'Renewer', service: 'api' });

    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5101,
      project: 'Renewer',
      service: 'api-v2'
    });

    assert.equal(status, 201, 'renewing your own lease is not a conflict');
    assert.equal(data.service, 'api-v2');
  });

  it('POST /api/ports/lease takes the port over when force is set', async () => {
    store.portLeases.lease({ port: 5102, project: 'Owner', service: 'dev-server' });

    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5102,
      project: 'Taker',
      service: 'api',
      force: true
    });

    assert.equal(status, 201);
    assert.equal(data.project, 'Taker');
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

  // #656 — release and heartbeat took only a port, so any caller could delete or
  // renew another project's lease. They now verify ownership when a project is named
  // (opt-in, so old {port}-only callers still work). A stray release is a silent
  // deletion, the wider hole than the lease overwrite #613 closed.
  it('POST /api/ports/release returns 409 when another project owns the live port', async () => {
    store.portLeases.lease({ port: 6100, project: 'Owner', service: 'dev-server' });

    const { status, data } = await request(server, 'POST', '/api/ports/release', {
      port: 6100,
      project: 'Intruder'
    });

    assert.equal(status, 409, 'releasing another project\'s live port is a conflict');
    assert.equal(data.code, 'PORT_CONFLICT');
    assert.equal(data.owner.project, 'Owner', 'the response names the owner');
    assert.ok(store.portLeases.get(6100), 'the owner keeps the lease after a refused release');
  });

  it('POST /api/ports/release with force removes another project\'s lease', async () => {
    store.portLeases.lease({ port: 6101, project: 'Owner', service: 'dev-server' });

    const { status } = await request(server, 'POST', '/api/ports/release', {
      port: 6101, project: 'Taker', force: true
    });

    assert.equal(status, 200);
    assert.equal(store.portLeases.get(6101), null);
  });

  it('POST /api/ports/release with the owning project succeeds', async () => {
    store.portLeases.lease({ port: 6102, project: 'Mine', service: 'temp' });

    const { status } = await request(server, 'POST', '/api/ports/release', {
      port: 6102, project: 'Mine'
    });

    assert.equal(status, 200);
    assert.equal(store.portLeases.get(6102), null);
  });

  it('POST /api/ports/release with no project still deletes (backward compat)', async () => {
    store.portLeases.lease({ port: 6103, project: 'Whoever', service: 'temp' });

    const { status } = await request(server, 'POST', '/api/ports/release', { port: 6103 });
    assert.equal(status, 200);
    assert.equal(store.portLeases.get(6103), null);
  });

  it('POST /api/ports/heartbeat returns 409 when another project owns the lease', async () => {
    store.portLeases.lease({ port: 7100, project: 'Owner', service: 'dev', ttlMs: 60000 });

    const { status, data } = await request(server, 'POST', '/api/ports/heartbeat', {
      port: 7100, project: 'Intruder'
    });

    assert.equal(status, 409);
    assert.equal(data.code, 'PORT_CONFLICT');
    assert.equal(data.owner.project, 'Owner');
  });
});
