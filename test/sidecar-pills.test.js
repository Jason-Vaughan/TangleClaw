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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sidecar-pills-'));
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

describe('Sidecar Pills — session.html should NOT have sidecar', () => {
  let html;

  before(async () => {
    const res = await request('/session/test-project');
    html = res.data;
  });

  it('should NOT include sidecarPills in session.html (moved to openclaw-view)', () => {
    assert.ok(!html.includes('id="sidecarPills"'));
  });

  it('should NOT include sidecar panel in session.html (moved to openclaw-view)', () => {
    assert.ok(!html.includes('id="sidecarPanel"'));
  });
});

describe('Sidecar Pills — CSS', () => {
  let css;

  before(async () => {
    const res = await request('/session.css');
    css = res.data;
  });

  it('should include sidecar pills container styles (shared CSS)', () => {
    assert.ok(css.includes('.sidecar-pills'));
  });

  it('should include sidecar pill base styles', () => {
    assert.ok(css.includes('.sidecar-pill'));
    assert.ok(css.includes('.sidecar-pill-dot'));
    assert.ok(css.includes('.sidecar-pill-label'));
    assert.ok(css.includes('.sidecar-pill-time'));
  });

  it('should include status-specific running styles', () => {
    assert.ok(css.includes('.sidecar-pill--running'));
    assert.ok(css.includes('.sidecar-pill--running .sidecar-pill-dot'));
  });

  it('should include status-specific quiet styles', () => {
    assert.ok(css.includes('.sidecar-pill--quiet'));
    assert.ok(css.includes('.sidecar-pill--quiet .sidecar-pill-dot'));
  });

  it('should include status-specific completed styles', () => {
    assert.ok(css.includes('.sidecar-pill--completed'));
  });

  it('should include status-specific failed styles', () => {
    assert.ok(css.includes('.sidecar-pill--failed'));
    assert.ok(css.includes('.sidecar-pill--failed .sidecar-pill-dot'));
  });

  it('should include attention pulse animation', () => {
    assert.ok(css.includes('.sidecar-pill--attention'));
    assert.ok(css.includes('@keyframes sidecar-pulse'));
  });

  it('should include attention badge styles', () => {
    assert.ok(css.includes('.sidecar-attention-badge'));
  });

  it('should include stale data indicator', () => {
    assert.ok(css.includes('.sidecar-stale-badge'));
  });

  it('should include sidecar panel styles', () => {
    assert.ok(css.includes('.sidecar-panel'));
    assert.ok(css.includes('.sidecar-detail'));
    assert.ok(css.includes('.sidecar-field'));
    assert.ok(css.includes('.sidecar-status-badge--running'));
    assert.ok(css.includes('.sidecar-output'));
  });
});

describe('Sidecar Pills — session.js should NOT have sidecar code', () => {
  let js;

  before(async () => {
    const res = await request('/session.js');
    js = res.data;
  });

  it('should NOT include sidecar polling functions', () => {
    assert.ok(!js.includes('function startSidecarPolling()'));
    assert.ok(!js.includes('function stopSidecarPolling()'));
    assert.ok(!js.includes('function pollSidecarProcesses()'));
  });

  it('should NOT include sidecar pill rendering', () => {
    assert.ok(!js.includes('function renderSidecarPills('));
  });

  it('should NOT include sidecar detail panel', () => {
    assert.ok(!js.includes('function openSidecarPanel('));
    assert.ok(!js.includes('function closeSidecarPanel()'));
    assert.ok(!js.includes('function renderSidecarDetail()'));
  });

  it('should NOT include isOpenClawProject', () => {
    assert.ok(!js.includes('function isOpenClawProject()'));
  });
});

describe('Sidecar — connection-based API route', () => {
  let connId;

  before(() => {
    const conn = store.openclawConnections.create({
      name: 'SidecarTest',
      host: '198.51.100.10',
      port: 18789,
      sshUser: 'test',
      sshKeyPath: '~/.ssh/test',
      localPort: 19999,
      availableAsEngine: false
    });
    connId = conn.id;
  });

  it('should return 404 for unknown connection ID', async () => {
    const res = await request('/api/sidecar/connection/nonexistent/processes');
    assert.equal(res.status, 404);
  });

  it('should return empty processes for valid connection with no data', async () => {
    const res = await request(`/api/sidecar/connection/${connId}/processes`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.active, []);
    assert.deepEqual(res.data.recent, []);
    assert.equal(res.data.stale, false);
  });

  it('should return lastPollAt and stale fields', async () => {
    const res = await request(`/api/sidecar/connection/${connId}/processes`);
    assert.equal(res.status, 200);
    assert.ok('lastPollAt' in res.data);
    assert.ok('stale' in res.data);
  });
});
