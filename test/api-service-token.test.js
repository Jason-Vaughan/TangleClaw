'use strict';

// AUTH-4 — the M2M service-token gate over a REAL HTTP request: the dispatch
// gate on the PortHub + shared-docs surfaces, config redaction of the raw token,
// auto-generation on enable, scope (a non-gated route stays open), and
// reversibility (disable re-opens). The pure gate logic is covered in
// test/service-token.test.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');

/** HTTP request; returns { status, data }. */
function request(server, method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders }
    }, (res) => {
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('AUTH-4 — service-token gate over HTTP', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-svc-token-'));
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

  it('default-off: PortHub is reachable with no token', async () => {
    const { status } = await request(server, 'GET', '/api/ports');
    assert.equal(status, 200);
  });

  it('enabling via PATCH auto-generates a token and redacts it', async () => {
    const { status, data } = await request(server, 'PATCH', '/api/config', { serviceTokenEnabled: true });
    assert.equal(status, 200);
    assert.equal(data.config.serviceTokenEnabled, true);
    assert.equal(data.config.serviceTokenConfigured, true);
    assert.equal(data.config.serviceToken, undefined, 'raw token must never leave via the config API');
    // The token was actually generated and persisted.
    assert.match(store.config.load().serviceToken, /^tcsk_/);
  });

  it('GET /api/config redacts the raw token', async () => {
    const { data } = await request(server, 'GET', '/api/config');
    assert.equal(data.serviceTokenConfigured, true);
    assert.equal(data.serviceToken, undefined);
  });

  it('gated PortHub: 401 without a token', async () => {
    const { status, data } = await request(server, 'GET', '/api/ports');
    assert.equal(status, 401);
    assert.equal(data.code, 'UNAUTHORIZED');
  });

  it('gated PortHub: 401 with a wrong token', async () => {
    const { status, data } = await request(server, 'GET', '/api/ports', null, bearer('tcsk_wrong'));
    assert.equal(status, 401);
    assert.equal(data.code, 'INVALID_SERVICE_TOKEN');
  });

  it('gated PortHub: 200 with the correct token', async () => {
    const token = store.config.load().serviceToken;
    const { status } = await request(server, 'GET', '/api/ports', null, bearer(token));
    assert.equal(status, 200);
  });

  it('gated shared-docs: 401 without a token, 200 with it', async () => {
    const noTok = await request(server, 'GET', '/api/shared-docs');
    assert.equal(noTok.status, 401);
    const token = store.config.load().serviceToken;
    const withTok = await request(server, 'GET', '/api/shared-docs', null, bearer(token));
    assert.equal(withTok.status, 200);
  });

  it('scope: a non-gated route (/api/groups) stays open with the gate on', async () => {
    const { status } = await request(server, 'GET', '/api/groups');
    assert.equal(status, 200);
  });

  it('reversible: disabling re-opens PortHub with no token', async () => {
    const off = await request(server, 'PATCH', '/api/config', { serviceTokenEnabled: false });
    assert.equal(off.status, 200);
    const { status } = await request(server, 'GET', '/api/ports');
    assert.equal(status, 200);
  });

  it('rejects a non-boolean serviceTokenEnabled', async () => {
    const { status, data } = await request(server, 'PATCH', '/api/config', { serviceTokenEnabled: 'yes' });
    assert.equal(status, 400);
    assert.equal(data.code, 'BAD_REQUEST');
  });
});
