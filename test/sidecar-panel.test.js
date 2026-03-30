'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ��─ Test Helpers ──

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
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Tests ──

describe('Sidecar Panel — HTML', () => {
  let html;

  before(async () => {
    const res = await request('/session/test-project');
    html = res.data;
  });

  it('should include sidecar panel backdrop', () => {
    assert.ok(html.includes('id="sidecarBackdrop"'));
    assert.ok(html.includes('class="drawer-backdrop"'));
  });

  it('should include sidecar panel aside element', () => {
    assert.ok(html.includes('id="sidecarPanel"'));
    assert.ok(html.includes('class="sidecar-panel"'));
    assert.ok(html.includes('aria-label="Process detail"'));
  });

  it('should include sidecar panel header with title and actions', () => {
    assert.ok(html.includes('id="sidecarTitle"'));
    assert.ok(html.includes('id="sidecarRefresh"'));
    assert.ok(html.includes('id="sidecarClose"'));
  });

  it('should include sidecar detail container', () => {
    assert.ok(html.includes('id="sidecarDetail"'));
  });

  it('should place sidecar panel before peek drawer', () => {
    const sidecarPos = html.indexOf('id="sidecarPanel"');
    const peekPos = html.indexOf('id="peekDrawer"');
    assert.ok(sidecarPos < peekPos, 'sidecar panel should come before peek drawer');
  });
});

describe('Sidecar Panel — CSS', () => {
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
    assert.ok(css.includes('.sidecar-panel-actions'));
  });

  it('should include detail content styles', () => {
    assert.ok(css.includes('.sidecar-detail'));
    assert.ok(css.includes('.sidecar-detail-empty'));
  });

  it('should include process nav styles', () => {
    assert.ok(css.includes('.sidecar-nav'));
    assert.ok(css.includes('.sidecar-nav-btn'));
    assert.ok(css.includes('.sidecar-nav-btn.active'));
  });

  it('should include detail field styles', () => {
    assert.ok(css.includes('.sidecar-field'));
    assert.ok(css.includes('.sidecar-field-label'));
    assert.ok(css.includes('.sidecar-field-value'));
  });

  it('should include status badge styles for all statuses', () => {
    assert.ok(css.includes('.sidecar-status-badge--running'));
    assert.ok(css.includes('.sidecar-status-badge--quiet'));
    assert.ok(css.includes('.sidecar-status-badge--completed'));
    assert.ok(css.includes('.sidecar-status-badge--failed'));
    assert.ok(css.includes('.sidecar-status-badge--terminated'));
    assert.ok(css.includes('.sidecar-status-badge--unknown'));
  });

  it('should include attention flag styles', () => {
    assert.ok(css.includes('.sidecar-flags'));
    assert.ok(css.includes('.sidecar-flag'));
    assert.ok(css.includes('.sidecar-flag--danger'));
  });

  it('should include output snippet styles', () => {
    assert.ok(css.includes('.sidecar-output'));
    assert.ok(css.includes('.sidecar-output-label'));
    assert.ok(css.includes('.sidecar-output-content'));
    assert.ok(css.includes('.sidecar-output-empty'));
  });

  it('should include clickable pill cursor styles', () => {
    assert.ok(css.includes('.sidecar-pill[data-process-id]'));
    assert.ok(css.includes('cursor: pointer'));
  });
});

describe('Sidecar Panel — JS', () => {
  let js;

  before(async () => {
    const res = await request('/session.js');
    js = res.data;
  });

  it('should include openSidecarPanel function', () => {
    assert.ok(js.includes('function openSidecarPanel('));
    assert.ok(js.includes('sidecarBackdrop'));
    assert.ok(js.includes('sidecarPanel'));
  });

  it('should include closeSidecarPanel function', () => {
    assert.ok(js.includes('function closeSidecarPanel()'));
  });

  it('should include autoSelectProcess function', () => {
    assert.ok(js.includes('function autoSelectProcess()'));
    assert.ok(js.includes('needsAttention'));
  });

  it('should include renderSidecarDetail function', () => {
    assert.ok(js.includes('function renderSidecarDetail()'));
    assert.ok(js.includes('sidecar-status-badge'));
    assert.ok(js.includes('sidecar-field'));
  });

  it('should include formatTimestamp helper', () => {
    assert.ok(js.includes('function formatTimestamp('));
  });

  it('should include sidecarField helper', () => {
    assert.ok(js.includes('function sidecarField('));
  });

  it('should include handlePillClick for pill interaction', () => {
    assert.ok(js.includes('function handlePillClick('));
    assert.ok(js.includes('openSidecarPanel'));
  });

  it('should include refreshSidecarPanel function', () => {
    assert.ok(js.includes('async function refreshSidecarPanel()'));
    assert.ok(js.includes('pollSidecarProcesses'));
  });

  it('should cache processes in sidecarProcesses array', () => {
    assert.ok(js.includes('sidecarProcesses = all'));
  });

  it('should update detail panel during poll when open', () => {
    assert.ok(js.includes('if (sidecarPanelOpen) renderSidecarDetail()'));
  });

  it('should wire sidecar panel events in DOMContentLoaded', () => {
    assert.ok(js.includes("$('sidecarClose').addEventListener('click', closeSidecarPanel)"));
    assert.ok(js.includes("$('sidecarRefresh').addEventListener('click', refreshSidecarPanel)"));
    assert.ok(js.includes("$('sidecarBackdrop').addEventListener('click', closeSidecarPanel)"));
    assert.ok(js.includes("$('sidecarPills').addEventListener('click', handlePillClick)"));
  });

  it('should render process nav when multiple processes', () => {
    assert.ok(js.includes('sidecar-nav'));
    assert.ok(js.includes('sidecar-nav-btn'));
    assert.ok(js.includes('data-nav-id'));
  });

  it('should render attention flags for flagged processes', () => {
    assert.ok(js.includes('waitingForInput'));
    assert.ok(js.includes('suspectedStalled'));
    assert.ok(js.includes('Waiting for Input'));
    assert.ok(js.includes('Suspected Stalled'));
    assert.ok(js.includes('Needs Attention'));
  });

  it('should render output snippet area', () => {
    assert.ok(js.includes('lastOutputSnippet'));
    assert.ok(js.includes('sidecar-output-content'));
    assert.ok(js.includes('No output captured'));
  });

  it('should display exit code and signal when available', () => {
    assert.ok(js.includes('exitCode'));
    assert.ok(js.includes('Exit Code'));
    assert.ok(js.includes('Signal'));
  });
});
