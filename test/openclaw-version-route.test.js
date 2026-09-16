'use strict';

/*
 * #1527 — GET /api/openclaw/connections/:id/version must AWAIT the async
 * version read. If the `await` is dropped the route still answers 200, but with
 * `version` undefined, so the panel shows "unknown" for every connection and
 * the module tests stay green. This drives the real handler to pin it.
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const ocv = require('../lib/openclaw-version');
const { handleRequest } = require('../server');

setLevel('error');

/**
 * Drive a GET through the real request handler and parse the JSON reply.
 * @param {string} url - Raw request target.
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

describe('GET /api/openclaw/connections/:id/version (#1527)', () => {
  let tmpDir;
  let connId;
  const realExec = ocv._internal.execAsync;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-version-route-'));
    store._setBasePath(tmpDir);
    store.init();
    connId = store.openclawConnections.create({
      name: 'VersionRoute',
      host: '10.0.0.9',
      sshUser: 'admin',
      sshKeyPath: '~/.ssh/id_rsa',
      instanceDir: '~/openclaw'
    }).id;
  });

  afterEach(() => {
    ocv._internal.execAsync = realExec;
    ocv.invalidate(connId);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the version from an async read', async () => {
    ocv._internal.execAsync = () => new Promise((resolve) => {
      setTimeout(() => resolve({ stdout: 'OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.4\n' }), 5);
    });
    const { status, json } = await getJson(`/api/openclaw/connections/${connId}/version`);
    assert.equal(status, 200);
    assert.equal(json.version, '2026.9.4', 'the route must await the read, not serialise a pending promise');
    assert.equal(json.cached, false);
    assert.equal(json.error, null);
  });

  it('reports an unreachable host as version null with the reason', async () => {
    ocv._internal.execAsync = async () => { throw Object.assign(new Error('timeout'), { stderr: 'Operation timed out' }); };
    const { status, json } = await getJson(`/api/openclaw/connections/${connId}/version`);
    assert.equal(status, 200);
    assert.equal(json.version, null);
    assert.match(json.error, /ssh read failed: Operation timed out/);
  });

  it('404s an unknown connection without attempting ssh', async () => {
    let called = false;
    ocv._internal.execAsync = async () => { called = true; return { stdout: '' }; };
    const { status } = await getJson('/api/openclaw/connections/no-such-id/version');
    assert.equal(status, 404);
    assert.equal(called, false);
  });
});
