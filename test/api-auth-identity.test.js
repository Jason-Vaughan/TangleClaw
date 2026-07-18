'use strict';

// AUTH-3 (#1): the proxy-authenticated identity reaches TC through a REAL HTTP
// request. Unit tests cover the trust gate (auth-identity.test.js) and the
// Caddy header emission (caddy.test.js); this proves the server wiring — that
// `/api/server-info` reports `currentUser` from the request's X-Auth-User header
// only when the gate is live. The launch endpoint reads the same header via the
// same helper, so this also covers the header-from-HTTP path it depends on.

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

/** GET with optional extra headers; returns { status, body }. */
function get(server, urlPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...extraHeaders }
    }, (res) => {
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
    req.end();
  });
}

/** Patch the persisted config (merged into DEFAULT_CONFIG on load). */
function setConfig(patch) {
  const config = store.config.load();
  Object.assign(config, patch);
  store.config.save(config);
}

describe('AUTH-3 — /api/server-info currentUser (proxy identity over HTTP)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-authid-'));
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

  it('reports currentUser when the Caddy gate is live and the header is present', async () => {
    setConfig({ ingressMode: 'caddy', authEnabled: true });
    const res = await get(server, '/api/server-info', { 'X-Auth-User': 'jason' });
    assert.equal(res.status, 200);
    assert.equal(res.body.currentUser, 'jason');
  });

  it('ignores the header in direct mode — currentUser is null (spoof defense)', async () => {
    setConfig({ ingressMode: 'direct', authEnabled: false });
    const res = await get(server, '/api/server-info', { 'X-Auth-User': 'attacker' });
    assert.equal(res.status, 200);
    assert.equal(res.body.currentUser, null);
  });

  it('reports null when the gate is live but no identity header is sent', async () => {
    setConfig({ ingressMode: 'caddy', authEnabled: true });
    const res = await get(server, '/api/server-info');
    assert.equal(res.status, 200);
    assert.equal(res.body.currentUser, null);
  });

  // AUTH-2K9D — /api/server-info also reports authStatus (config-vs-live mismatch).
  it("reports authStatus 'live' when caddy gate is up and identity arrives", async () => {
    setConfig({ ingressMode: 'caddy', authEnabled: true });
    const res = await get(server, '/api/server-info', { 'X-Auth-User': 'jason' });
    assert.equal(res.body.authStatus, 'live');
  });

  it("reports authStatus 'configured-inert' when authEnabled but direct mode (AUTH-2)", async () => {
    setConfig({ ingressMode: 'direct', authEnabled: true });
    const res = await get(server, '/api/server-info');
    assert.equal(res.body.authStatus, 'configured-inert');
    assert.equal(res.body.currentUser, null);
  });

  it("reports authStatus 'configured-no-identity' when a proxied request lacks identity (AUTH-3)", async () => {
    setConfig({ ingressMode: 'caddy', authEnabled: true });
    // X-Forwarded-For marks the request as having traversed Caddy, so the
    // missing identity is real evidence of broken header_up forwarding.
    const res = await get(server, '/api/server-info', { 'X-Forwarded-For': '100.64.0.7' });
    assert.equal(res.body.authStatus, 'configured-no-identity');
  });

  it("reports authStatus 'configured-bypassed' on a direct loopback request (AUTH-5N2J regression)", async () => {
    setConfig({ ingressMode: 'caddy', authEnabled: true });
    // This request really does hit the server's loopback listener with no proxy
    // in front — exactly the dashboard-on-localhost load that used to
    // false-positive the amber configured-no-identity warning.
    const res = await get(server, '/api/server-info');
    assert.equal(res.body.authStatus, 'configured-bypassed');
    assert.equal(res.body.currentUser, null);
  });

  it("reports authStatus 'off' when auth is disabled", async () => {
    setConfig({ ingressMode: 'direct', authEnabled: false });
    const res = await get(server, '/api/server-info');
    assert.equal(res.body.authStatus, 'off');
  });
});
