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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sidecar-panel-'));
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

describe('Sidecar Panel — session page should NOT have sidecar markup', () => {
  let html;

  before(async () => {
    const res = await request('/session/test-project');
    html = res.data;
  });

  it('should NOT include sidecar panel backdrop', () => {
    assert.ok(!html.includes('id="sidecarBackdrop"'));
  });

  it('should NOT include sidecar panel aside', () => {
    assert.ok(!html.includes('id="sidecarPanel"'));
  });

  it('should NOT include sidecar detail container', () => {
    assert.ok(!html.includes('id="sidecarDetail"'));
  });
});

describe('Sidecar Panel — CSS remains in shared stylesheet', () => {
  let css;

  before(async () => {
    const res = await request('/session.css');
    css = res.data;
  });

  it('should include sidecar panel base styles', () => {
    assert.ok(css.includes('.sidecar-panel'));
    assert.ok(css.includes('.sidecar-panel.open'));
  });

  it('should include panel header styles', () => {
    assert.ok(css.includes('.sidecar-panel-header'));
    assert.ok(css.includes('.sidecar-panel-title'));
  });

  it('should include detail content styles', () => {
    assert.ok(css.includes('.sidecar-detail'));
    assert.ok(css.includes('.sidecar-detail-empty'));
  });

  it('should include process nav styles', () => {
    assert.ok(css.includes('.sidecar-nav'));
    assert.ok(css.includes('.sidecar-nav-btn'));
  });

  it('should include status badge styles for all statuses', () => {
    assert.ok(css.includes('.sidecar-status-badge--running'));
    assert.ok(css.includes('.sidecar-status-badge--quiet'));
    assert.ok(css.includes('.sidecar-status-badge--completed'));
    assert.ok(css.includes('.sidecar-status-badge--failed'));
    assert.ok(css.includes('.sidecar-status-badge--terminated'));
  });

  it('should include attention flag styles', () => {
    assert.ok(css.includes('.sidecar-flags'));
    assert.ok(css.includes('.sidecar-flag'));
  });

  it('should include output snippet styles', () => {
    assert.ok(css.includes('.sidecar-output'));
    assert.ok(css.includes('.sidecar-output-content'));
  });
});

describe('Sidecar — getProcessesByConnection', () => {
  let connId;

  before(() => {
    const conn = store.openclawConnections.create({
      name: 'PanelTest',
      host: '198.51.100.10',
      port: 18789,
      sshUser: 'test',
      sshKeyPath: '~/.ssh/test',
      localPort: 19998,
      availableAsEngine: false
    });
    connId = conn.id;
  });

  it('should return error for unknown connection', () => {
    const result = sidecar.getProcessesByConnection('nonexistent');
    assert.equal(result.error, 'Connection not found');
    assert.deepEqual(result.active, []);
    assert.deepEqual(result.recent, []);
  });

  it('should return empty arrays for valid connection with no cached data', () => {
    const result = sidecar.getProcessesByConnection(connId);
    assert.deepEqual(result.active, []);
    assert.deepEqual(result.recent, []);
    assert.equal(result.stale, false);
  });

  it('should return cached data when available', () => {
    // Manually seed cache
    sidecar._cache.set(connId, {
      processes: {
        active: [{ id: 'p1', type: 'claude', status: 'running', label: 'test run' }],
        recent: [{ id: 'p2', type: 'exec', status: 'completed', label: 'done' }]
      },
      lastPollAt: new Date().toISOString(),
      error: null,
      stale: false
    });

    const result = sidecar.getProcessesByConnection(connId);
    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].id, 'p1');
    assert.equal(result.recent.length, 1);
    assert.equal(result.recent[0].id, 'p2');
    assert.equal(result.stale, false);

    // Cleanup
    sidecar._cache.delete(connId);
  });
});
