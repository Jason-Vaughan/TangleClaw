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
// Every port reads as free to PortHub's listener probe, so connection creates
// here do not depend on what this host is running (#814).
require('./_probe-stub').probeAnswersFromFixture();

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

  it('keeps answering switchboard reads promptly while a slow probe is in flight (#2557)', async () => {
    // An unreachable host holds the probe for its whole ssh connect timeout. The
    // read here is slow but asynchronous, as the real one is, and the switchboard
    // is asked throughout it. A probe that went back to a synchronous ssh would
    // stall the loop for as long as the host took, which the delay monitor sees
    // wherever in the window it happens and the switchboard timings see as one
    // read that waited for it.
    const { monitorEventLoopDelay } = require('node:perf_hooks');
    const FAST_ROUTE_BOUND_MS = 500;
    const PROBE_MS = 600;
    const name = 'version-probe-2557';
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    store.projects.create({ name, path: dir, engine: 'claude' });

    let probes = 0;
    ocv._internal.execAsync = () => {
      probes++;
      return new Promise((resolve) => setTimeout(resolve, PROBE_MS))
        .then(() => ({ stdout: 'OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.4\n' }));
    };

    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    try {
      let probeSettled = false;
      const slow = getJson(`/api/openclaw/connections/${connId}/version?force=1`)
        .then((r) => { probeSettled = true; return r; });

      const timings = [];
      while (!probeSettled) {
        const started = Date.now();
        const fast = await getJson(`/api/sessions/${name}/medusa/messages`);
        timings.push(Date.now() - started);
        assert.equal(fast.status, 200, 'every switchboard read must be answered');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      lag.disable();

      const { status, json } = await slow;
      assert.equal(status, 200);
      assert.equal(json.version, '2026.9.4', 'the slow probe still answers once the host does');
      assert.equal(probes, 1, 'a forced probe runs once');
      assert.ok(timings.length >= 5,
        `the switchboard must have been asked throughout the probe, not ${timings.length} time(s)`);
      const worst = Math.max(...timings);
      assert.ok(worst < FAST_ROUTE_BOUND_MS,
        `a switchboard read took ${worst}ms while a version probe was in flight (all: ${timings.join(', ')})`);
      assert.ok(lag.max / 1e6 < FAST_ROUTE_BOUND_MS,
        `the event loop stalled for ${(lag.max / 1e6).toFixed(0)}ms while a version probe was in flight`);
    } finally {
      lag.disable();
    }
  });
});
