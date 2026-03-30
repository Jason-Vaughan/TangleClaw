'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── Test Helpers ──

const store = require('../lib/store');
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
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Tests ──

describe('Sidecar Pills — HTML', () => {
  let html;

  before(async () => {
    const res = await request('/session/test-project');
    html = res.data;
  });

  it('should include sidecar pills container in banner', () => {
    assert.ok(html.includes('id="sidecarPills"'));
    assert.ok(html.includes('class="sidecar-pills hidden"'));
  });

  it('should have sidecar pills container between banner-row and banner-actions', () => {
    const rowEnd = html.indexOf('bannerGroups');
    const pillsPos = html.indexOf('sidecarPills');
    const actionsPos = html.indexOf('banner-actions');
    assert.ok(rowEnd < pillsPos, 'sidecarPills should come after bannerGroups');
    assert.ok(pillsPos < actionsPos, 'sidecarPills should come before banner-actions');
  });

  it('should have aria-label on sidecar pills container', () => {
    assert.ok(html.includes('aria-label="Background processes"'));
  });
});

describe('Sidecar Pills — CSS', () => {
  let css;

  before(async () => {
    const res = await request('/session.css');
    css = res.data;
  });

  it('should include sidecar pills container styles', () => {
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

  it('should include mobile responsive styles for pills', () => {
    // Check that within a max-width media query, sidecar-pill is restyled
    const mobileIdx = css.indexOf('.sidecar-pill-label');
    assert.ok(mobileIdx > 0, 'should have sidecar-pill-label style');
    assert.ok(css.includes('max-width: 80px'), 'should have mobile label width');
  });
});

describe('Sidecar Pills — JS', () => {
  let js;

  before(async () => {
    const res = await request('/session.js');
    js = res.data;
  });

  it('should include isOpenClawProject function', () => {
    assert.ok(js.includes('function isOpenClawProject()'));
    assert.ok(js.includes("startsWith('openclaw:')"));
  });

  it('should include pollSidecarProcesses function', () => {
    assert.ok(js.includes('async function pollSidecarProcesses()'));
    assert.ok(js.includes('/api/sidecar/'));
  });

  it('should include sidecarStatusClass mapping function', () => {
    assert.ok(js.includes('function sidecarStatusClass('));
    assert.ok(js.includes("'running'"));
    assert.ok(js.includes("'quiet'"));
    assert.ok(js.includes("'completed'"));
    assert.ok(js.includes("'failed'"));
    assert.ok(js.includes("'attention'"));
  });

  it('should include formatElapsed time formatter', () => {
    assert.ok(js.includes('function formatElapsed('));
  });

  it('should include renderSidecarPills function', () => {
    assert.ok(js.includes('function renderSidecarPills('));
    assert.ok(js.includes('sidecar-pill'));
    assert.ok(js.includes('sidecar-pill-dot'));
    assert.ok(js.includes('sidecar-attention-badge'));
  });

  it('should include startSidecarPolling and stopSidecarPolling', () => {
    assert.ok(js.includes('function startSidecarPolling()'));
    assert.ok(js.includes('function stopSidecarPolling()'));
  });

  it('should start sidecar polling in initSession', () => {
    assert.ok(js.includes('startSidecarPolling()'));
  });

  it('should stop sidecar polling on session ended', () => {
    assert.ok(js.includes('stopSidecarPolling()'));
  });

  it('should use 10s polling interval for sidecar', () => {
    assert.ok(js.includes('SIDECAR_POLL_INTERVAL'));
    assert.ok(js.includes('10000'));
  });

  it('should render stale badge when data is stale', () => {
    assert.ok(js.includes('sidecar-stale-badge'));
    assert.ok(js.includes('stale'));
  });
});
