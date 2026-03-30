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
      host: '192.168.20.10',
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
      host: '192.168.20.10',
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
