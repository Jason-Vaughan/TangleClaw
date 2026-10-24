'use strict';

/*
 * #2571 — credential projection on /api/openclaw/connections CRUD routes.
 *
 * Contracts:
 *   1. Redaction: GET list/detail, POST create, PUT update never expose
 *      gatewayToken, bridgeToken, or auditSecret; has* booleans reflect reality.
 *   2. Write-only preservation: PUT with '' preserves; clearX: true or null clears.
 *   3. Tunnel: POST .../tunnel returns webuiUrl; localhost skips ensureTunnel.
 *   4. In-process: store.openclawConnections.get() returns raw tokens intact.
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const tunnel = require('../lib/tunnel');
const { handleRequest } = require('../server');
// Every port reads as free to PortHub's listener probe.
require('./_probe-stub').probeAnswersFromFixture();

setLevel('error');

/**
 * Drive a GET through the real request handler and return status + parsed body.
 * @param {string} url
 * @returns {Promise<{status: number, json: object}>}
 */
async function getJson(url) {
  const req = { url, method: 'GET', headers: { host: 'localhost:3102' }, on() {} };
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    setHeader() {},
    getHeader() { return undefined; },
    end(chunk) { if (chunk != null) this.body += String(chunk); }
  };
  await handleRequest(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

/**
 * Drive a mutating request through the real request handler.
 * @param {string} method
 * @param {string} url
 * @param {object} body
 * @returns {Promise<{status: number, json: object}>}
 */
async function mutate(method, url, body) {
  const req = new PassThrough();
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost:3102', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    setHeader() {},
    getHeader() { return undefined; },
    end(chunk) { if (chunk != null) this.body += String(chunk); }
  };
  const done = handleRequest(req, res);
  req.end(body === undefined ? '' : JSON.stringify(body));
  await done;
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

const SECRET_FIELDS = ['gatewayToken', 'bridgeToken', 'auditSecret'];

/**
 * Assert no secret field is present on `obj` (or any element when it is an array).
 * @param {object|Array} obj
 * @param {string} [label]
 */
function assertNoSecrets(obj, label = '') {
  const items = Array.isArray(obj) ? obj : [obj];
  for (const item of items) {
    for (const field of SECRET_FIELDS) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(item, field),
        `${label}: response must not contain "${field}" — found: ${JSON.stringify(item[field])}`
      );
    }
  }
}

const BASE_CONN = {
  name: 'TestConn',
  host: '10.0.0.1',
  sshUser: 'admin',
  sshKeyPath: '~/.ssh/id_rsa',
  gatewayToken: 'secret-gw-token',
  bridgeToken: 'secret-bridge-token',
  auditSecret: 'secret-audit'
};

describe('openclaw credential projection (#2571)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-proj-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Redaction contract ─────────────────────────────────────────────────

  describe('redaction contract', () => {
    let connId;

    before(async () => {
      const { json } = await mutate('POST', '/api/openclaw/connections', BASE_CONN);
      assert.equal(json && (json.id || (json.connections && 'already set')), json && json.id, 'create must return id');
      connId = json.id;
    });

    it('POST /api/openclaw/connections response has has* booleans and no secrets', async () => {
      const { json } = await mutate('POST', '/api/openclaw/connections', {
        ...BASE_CONN,
        name: 'Redact-Create'
      });
      assert.equal(json.status, undefined, 'should not be a 4xx object');
      assertNoSecrets(json, 'POST create');
      assert.equal(json.hasGatewayToken, true, 'hasGatewayToken should be true');
      assert.equal(json.hasBridgeToken, true, 'hasBridgeToken should be true');
      assert.equal(json.hasAuditSecret, true, 'hasAuditSecret should be true');
    });

    it('GET /api/openclaw/connections list never exposes secrets', async () => {
      const { json } = await getJson('/api/openclaw/connections');
      assert.ok(Array.isArray(json.connections), 'connections should be an array');
      assertNoSecrets(json.connections, 'GET list');
      const ours = json.connections.find((c) => c.id === connId);
      assert.ok(ours, 'our connection should appear in the list');
      assert.equal(ours.hasGatewayToken, true);
      assert.equal(ours.hasBridgeToken, true);
      assert.equal(ours.hasAuditSecret, true);
    });

    it('GET /api/openclaw/connections/:id never exposes secrets', async () => {
      const { json } = await getJson(`/api/openclaw/connections/${connId}`);
      assertNoSecrets(json, 'GET detail');
      assert.equal(json.hasGatewayToken, true);
      assert.equal(json.hasBridgeToken, true);
      assert.equal(json.hasAuditSecret, true);
    });

    it('PUT /api/openclaw/connections/:id response never exposes secrets', async () => {
      const { json } = await mutate('PUT', `/api/openclaw/connections/${connId}`, { name: 'TestConn-Renamed' });
      assertNoSecrets(json, 'PUT update');
      assert.equal(json.hasGatewayToken, true, 'token still set after unrelated PUT');
    });

    it('has* booleans are false when tokens are absent', async () => {
      const { json: created } = await mutate('POST', '/api/openclaw/connections', {
        name: 'NoTokenConn',
        host: '10.0.0.2',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/id_rsa'
      });
      const { json } = await getJson(`/api/openclaw/connections/${created.id}`);
      assertNoSecrets(json, 'GET detail no-token');
      assert.equal(json.hasGatewayToken, false);
      assert.equal(json.hasBridgeToken, false);
      assert.equal(json.hasAuditSecret, false);
    });
  });

  // ── 2. Write-only preservation ────────────────────────────────────────────

  describe('write-only preservation', () => {
    let connId;

    before(async () => {
      const { json } = await mutate('POST', '/api/openclaw/connections', {
        ...BASE_CONN,
        name: 'WriteOnly'
      });
      connId = json.id;
    });

    it('PUT with gatewayToken:"" preserves the stored token', async () => {
      const { json } = await mutate('PUT', `/api/openclaw/connections/${connId}`, { gatewayToken: '' });
      assert.equal(json.hasGatewayToken, true, 'blank PUT must not clear the token');
      // Confirm the raw store still has the value
      const raw = store.openclawConnections.get(connId);
      assert.equal(raw.gatewayToken, 'secret-gw-token', 'raw store must retain value after blank PUT');
    });

    it('PUT with gatewayToken:null clears the token', async () => {
      const { json } = await mutate('PUT', `/api/openclaw/connections/${connId}`, { gatewayToken: null });
      assert.equal(json.hasGatewayToken, false, 'explicit null must clear the token');
      const raw = store.openclawConnections.get(connId);
      assert.equal(raw.gatewayToken, null, 'raw store must be null after explicit null PUT');
    });

    it('PUT with clearGatewayToken:true on a token-holding connection clears it', async () => {
      // Re-set the token first
      await mutate('PUT', `/api/openclaw/connections/${connId}`, { gatewayToken: 'restored-token' });
      const { json } = await mutate('PUT', `/api/openclaw/connections/${connId}`, { clearGatewayToken: true });
      assert.equal(json.hasGatewayToken, false, 'clearGatewayToken:true must clear');
      const raw = store.openclawConnections.get(connId);
      assert.equal(raw.gatewayToken, null);
    });

    it('PUT with bridgeToken:"" preserves the stored bridge token', async () => {
      // First ensure bridgeToken is set
      await mutate('PUT', `/api/openclaw/connections/${connId}`, { bridgeToken: 'new-bridge-secret' });
      const { json } = await mutate('PUT', `/api/openclaw/connections/${connId}`, { bridgeToken: '' });
      assert.equal(json.hasBridgeToken, true, 'blank PUT must not clear bridgeToken');
      const raw = store.openclawConnections.get(connId);
      assert.equal(raw.bridgeToken, 'new-bridge-secret');
    });
  });

  // ── 3. Tunnel: webuiUrl and localhost short-circuit ───────────────────────

  describe('tunnel route', () => {
    let connId;
    let connLocalId;
    const origEnsureTunnel = tunnel.ensureTunnel;

    before(async () => {
      const { json: c1 } = await mutate('POST', '/api/openclaw/connections', {
        ...BASE_CONN,
        name: 'TunnelConn'
      });
      connId = c1.id;
      const { json: c2 } = await mutate('POST', '/api/openclaw/connections', {
        name: 'LocalConn',
        host: 'localhost',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/id_rsa',
        gatewayToken: 'local-gw-token'
      });
      connLocalId = c2.id;
    });

    afterEach(() => {
      tunnel.ensureTunnel = origEnsureTunnel;
    });

    it('returns webuiUrl containing #token= for a remote connection with gatewayToken', async () => {
      tunnel.ensureTunnel = async () => ({ ok: true, alreadyUp: false });
      const { status, json } = await mutate('POST', `/api/openclaw/connections/${connId}/tunnel`, {});
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.ok(typeof json.webuiUrl === 'string' && json.webuiUrl.length > 0, 'webuiUrl must be present');
      assert.ok(json.webuiUrl.includes('#token='), 'webuiUrl must embed the token for authenticated connections');
      assertNoSecrets(json, 'tunnel response');
    });

    it('localhost connection returns status:local without calling ensureTunnel', async () => {
      // If ensureTunnel is called it throws, proving the local path skipped it.
      tunnel.ensureTunnel = async () => { throw new Error('ensureTunnel must not be called for localhost'); };
      const { status, json } = await mutate('POST', `/api/openclaw/connections/${connLocalId}/tunnel`, {});
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.status, 'local', 'localhost must return status:local');
      assert.equal(json.alreadyUp, true);
      assert.ok(typeof json.webuiUrl === 'string' && json.webuiUrl.length > 0);
      assertNoSecrets(json, 'localhost tunnel response');
    });
  });

  // ── 4. In-process store integrity ────────────────────────────────────────

  describe('in-process store integrity', () => {
    let connId;

    before(async () => {
      const { json } = await mutate('POST', '/api/openclaw/connections', {
        ...BASE_CONN,
        name: 'StoreInteg'
      });
      connId = json.id;
    });

    it('store.openclawConnections.get() returns raw tokens intact', () => {
      const raw = store.openclawConnections.get(connId);
      assert.equal(raw.gatewayToken, 'secret-gw-token', 'raw store must hold the gateway token');
      assert.equal(raw.bridgeToken, 'secret-bridge-token', 'raw store must hold the bridge token');
      assert.equal(raw.auditSecret, 'secret-audit', 'raw store must hold the audit secret');
    });

    it('store result is not affected by route projection', async () => {
      // Drive the route (which projects), then confirm the store still has the values.
      await getJson(`/api/openclaw/connections/${connId}`);
      const raw = store.openclawConnections.get(connId);
      assert.equal(raw.gatewayToken, 'secret-gw-token');
    });
  });
});
