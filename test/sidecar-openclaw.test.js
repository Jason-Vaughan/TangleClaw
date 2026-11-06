'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── Test Helpers ──

const store = require('../lib/store');
const sidecar = require('../lib/sidecar');
const { createServer } = require('../server');

let server;
let baseUrl;
let testDir;

/**
 * Make an HTTP request to the test server.
 * @param {string} urlPath
 * @returns {Promise<{status: number, data: string|object, headers: object}>}
 */
function request(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET'
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        let data = body;
        if (contentType.includes('json') && body) {
          try { data = JSON.parse(body); } catch { /* keep as string */ }
        }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Setup/Teardown ──

// Every connection this file creates uses a non-routable TEST-NET-2 host
// (198.51.100.10) -- hitting the connection-based polling route now also
// triggers lib/sidecar.js's fire-and-forget telemetry refresh (#128,
// Ruling A505-R3.7), which would otherwise open a real `ssh` attempt per
// test and wait out its connect timeout in the background. Stubbed once,
// file-wide, to a safe default; individual tests override it further for
// their own assertions and restore this default in their own cleanup.
const _realDetectRuntimeAndStats = sidecar._seams.detectRuntimeAndStats;
sidecar._seams.detectRuntimeAndStats = async () => ({ mode: 'unknown', telemetry: null, health: null, error: 'stubbed in tests' });

before(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sidecar-oc-'));
  const projectsDir = path.join(testDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  store._setBasePath(path.join(testDir, 'tangleclaw'));
  store.init();
  const config = store.config.load();
  config.projectsDir = projectsDir;
  config.deletePassword = null;
  config.ttydPort = 19998;
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
  sidecar.stopAllPolling();
  sidecar._seams.detectRuntimeAndStats = _realDetectRuntimeAndStats;
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Tests ──

describe('Sidecar in openclaw-view — HTML structure', () => {
  let html;

  before(async () => {
    // Create a connection so we get a valid openclaw-view page
    store.openclawConnections.create({
      name: 'ViewTest',
      host: '198.51.100.10',
      port: 18789,
      sshUser: 'test',
      sshKeyPath: '~/.ssh/test',
      localPort: 19999,
      availableAsEngine: false
    });
    const res = await request('/openclaw-view/test-conn');
    html = res.data;
  });

  it('should include sidecarPills container', () => {
    assert.ok(html.includes('id="sidecarPills"'));
  });

  it('should include sidecar panel aside', () => {
    assert.ok(html.includes('id="sidecarPanel"'));
  });

  it('should include sidecar backdrop', () => {
    assert.ok(html.includes('id="sidecarBackdrop"'));
  });

  it('should include sidecar detail container', () => {
    assert.ok(html.includes('id="sidecarDetail"'));
  });

  it('should include sidecar nav container', () => {
    assert.ok(html.includes('id="sidecarNav"'));
  });

  it('should include sidecar refresh button', () => {
    assert.ok(html.includes('id="sidecarRefresh"'));
  });

  it('should include sidecar close button', () => {
    assert.ok(html.includes('id="sidecarClose"'));
  });

  it('should place pills between banner-row and terminal viewport', () => {
    const bannerRowIdx = html.indexOf('class="banner-row"');
    const pillsIdx = html.indexOf('id="sidecarPills"');
    const viewportIdx = html.indexOf('id="terminalViewport"');
    assert.ok(bannerRowIdx < pillsIdx, 'pills after banner-row');
    assert.ok(pillsIdx < viewportIdx, 'pills before viewport');
  });
});

describe('Sidecar in openclaw-view — JS functions', () => {
  let js;

  before(async () => {
    const res = await request('/openclaw-view.js');
    js = res.data;
  });

  it('should include sidecarStatusClass function', () => {
    assert.ok(js.includes('function sidecarStatusClass('));
  });

  it('should include formatElapsed function', () => {
    assert.ok(js.includes('function formatElapsed('));
  });

  it('should include formatTimestamp function', () => {
    assert.ok(js.includes('function formatTimestamp('));
  });

  it('should include renderSidecarPills function', () => {
    assert.ok(js.includes('function renderSidecarPills('));
  });

  it('should include autoSelectProcess function', () => {
    assert.ok(js.includes('function autoSelectProcess('));
  });

  it('should include renderSidecarDetail function', () => {
    assert.ok(js.includes('function renderSidecarDetail('));
  });

  it('should include openSidecarPanel function', () => {
    assert.ok(js.includes('function openSidecarPanel('));
  });

  it('should include closeSidecarPanel function', () => {
    assert.ok(js.includes('function closeSidecarPanel('));
  });

  it('should include pollSidecarProcesses function', () => {
    assert.ok(js.includes('function pollSidecarProcesses('));
  });

  it('should include startSidecarPolling function', () => {
    assert.ok(js.includes('function startSidecarPolling('));
  });

  it('should include stopSidecarPolling function', () => {
    assert.ok(js.includes('function stopSidecarPolling('));
  });

  it('should include initSidecar function', () => {
    assert.ok(js.includes('function initSidecar('));
  });

  it('should include sidecarField helper', () => {
    assert.ok(js.includes('function sidecarField('));
  });

  it('should include escapeHtml helper', () => {
    assert.ok(js.includes('function escapeHtml('));
  });

  it('should poll by connection ID, not project name', () => {
    assert.ok(js.includes('/api/sidecar/connection/'));
    assert.ok(!js.includes('/api/sidecar/${project}'));
  });

  it('should call initSidecar and startSidecarPolling in init()', () => {
    assert.ok(js.includes('initSidecar()'));
    assert.ok(js.includes('startSidecarPolling()'));
  });
});

describe('Sidecar in openclaw-view — connection-based polling API', () => {
  let connId;

  before(() => {
    const conn = store.openclawConnections.create({
      name: 'OcViewPollTest',
      host: '198.51.100.10',
      port: 18789,
      sshUser: 'test',
      sshKeyPath: '~/.ssh/test',
      localPort: 19997,
      availableAsEngine: false
    });
    connId = conn.id;
  });

  it('should return processes from connection-based endpoint', async () => {
    const res = await request(`/api/sidecar/connection/${connId}/processes`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.active));
    assert.ok(Array.isArray(res.data.recent));
  });

  it('should return cached active processes when seeded', async () => {
    sidecar._cache.set(connId, {
      processes: {
        active: [{ id: 'proc-1', type: 'claude', status: 'running', label: 'test task', needsAttention: false }],
        recent: []
      },
      lastPollAt: new Date().toISOString(),
      error: null,
      stale: false
    });

    const res = await request(`/api/sidecar/connection/${connId}/processes`);
    assert.equal(res.status, 200);
    assert.equal(res.data.active.length, 1);
    assert.equal(res.data.active[0].id, 'proc-1');

    sidecar._cache.delete(connId);
  });

  it('should return stale flag when data is stale', async () => {
    sidecar._cache.set(connId, {
      processes: { active: [], recent: [] },
      lastPollAt: new Date(Date.now() - 60000).toISOString(),
      error: null,
      stale: true
    });

    const res = await request(`/api/sidecar/connection/${connId}/processes`);
    assert.equal(res.status, 200);
    assert.equal(res.data.stale, true);

    sidecar._cache.delete(connId);
  });
});

describe('Sidecar telemetry/health wiring (#128, I-Gate Round 1, Ruling A505-R3.7)', () => {
  let connId;
  let realDetect;

  before(() => {
    const conn = store.openclawConnections.create({
      name: 'OcViewTelemetryTest',
      host: '198.51.100.11',
      port: 18789,
      sshUser: 'test',
      sshKeyPath: '~/.ssh/test',
      localPort: 19996,
      availableAsEngine: false
    });
    connId = conn.id;
    realDetect = sidecar._seams.detectRuntimeAndStats;
  });

  after(() => {
    sidecar._seams.detectRuntimeAndStats = realDetect;
    sidecar._telemetryCache.delete(connId);
    sidecar._telemetryInFlight.delete(connId);
  });

  it('getTelemetry reads null/null/null before anything has ever been measured', () => {
    assert.deepEqual(sidecar.getTelemetry(connId), { telemetry: null, health: null, telemetryAt: null });
  });

  it('GET .../processes includes telemetry:null and health:null when nothing is cached yet', async () => {
    const res = await request(`/api/sidecar/connection/${connId}/processes`);
    assert.equal(res.status, 200);
    assert.equal(res.data.telemetry, null);
    assert.equal(res.data.health, null);
  });

  it('_refreshTelemetry populates the cache from a successful SSH probe, and getTelemetry/the route both surface it', async () => {
    const telemetry = { mode: 'host', cpuPct: 12, memPct: 30, memUsedBytes: 1048576, memLimitBytes: null, stuckSessions: 0, lockHoldMaxMs: 0, lockHoldCount: 0, containerHealthy: null };
    const health = { level: 'ok', resourceSummary: 'CPU 12% · Mem 30%', healthSummary: 'no pathology detected', reasons: [] };
    sidecar._seams.detectRuntimeAndStats = async () => ({ mode: 'host', telemetry, health, error: null });

    sidecar._refreshTelemetry(connId);
    // The refresh is fire-and-forget; wait for the in-flight guard to clear,
    // which only happens once the stubbed promise above has settled.
    while (sidecar._telemetryInFlight.has(connId)) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.deepEqual(sidecar.getTelemetry(connId).telemetry, telemetry);
    assert.deepEqual(sidecar.getTelemetry(connId).health, health);
    assert.ok(sidecar.getTelemetry(connId).telemetryAt);

    const res = await request(`/api/sidecar/connection/${connId}/processes`);
    assert.deepEqual(res.data.telemetry, telemetry);
    assert.deepEqual(res.data.health, health);
  });

  it('never starts a second SSH probe for the same connection while one is already in flight', async () => {
    let calls = 0;
    let resolveFirst;
    sidecar._seams.detectRuntimeAndStats = () => new Promise((resolve) => {
      calls++;
      resolveFirst = () => resolve({ mode: 'unknown', telemetry: null, health: null, error: null });
    });

    sidecar._refreshTelemetry(connId);
    assert.equal(sidecar._telemetryInFlight.has(connId), true);
    sidecar._refreshTelemetry(connId); // must be a no-op: one is already in flight
    assert.equal(calls, 1);

    resolveFirst();
    while (sidecar._telemetryInFlight.has(connId)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it('a failed SSH probe never throws into the fire-and-forget caller, and leaves the prior cached reading in place', async () => {
    const telemetry = { mode: 'host', cpuPct: 5, memPct: 5, memUsedBytes: 100, memLimitBytes: null, stuckSessions: 0, lockHoldMaxMs: 0, lockHoldCount: 0, containerHealthy: null };
    const health = { level: 'ok', resourceSummary: 'CPU 5% · Mem 5%', healthSummary: 'no pathology detected', reasons: [] };
    sidecar._telemetryCache.set(connId, { telemetry, health, telemetryAt: new Date().toISOString() });

    sidecar._seams.detectRuntimeAndStats = async () => { throw new Error('ssh stats failed: connection refused'); };
    assert.doesNotThrow(() => sidecar._refreshTelemetry(connId));
    while (sidecar._telemetryInFlight.has(connId)) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.deepEqual(sidecar.getTelemetry(connId).telemetry, telemetry, 'the prior reading survives a failed refresh');
  });
});
