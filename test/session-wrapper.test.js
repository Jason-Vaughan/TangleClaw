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
 * @param {object} [opts]
 * @returns {Promise<{status: number, data: string|object, headers: object}>}
 */
function request(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: opts.headers || {}
    };

    const req = http.request(reqOpts, (res) => {
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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-session-wrapper-'));

  const projectsDir = path.join(testDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  store._setBasePath(path.join(testDir, 'tangleclaw'));
  store.init();
  const config = store.config.load();
  config.projectsDir = projectsDir;
  config.deletePassword = null;
  config.ttydPort = 19999; // Unlikely to be in use — ensures proxy tests get connection refused
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

describe('Session Wrapper UI', () => {

  describe('Session page serving', () => {
    it('should serve session.html for /session/:name', async () => {
      const res = await request('/session/my-project');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      assert.ok(typeof res.data === 'string');
      assert.ok(res.data.includes('TangleClaw'));
      assert.ok(res.data.includes('session.js'));
      assert.ok(res.data.includes('session.css'));
    });

    it('should serve session.html for encoded project names', async () => {
      const res = await request('/session/my%20project');
      assert.equal(res.status, 200);
      assert.ok(res.data.includes('session.js'));
    });

    it('should serve session.css', async () => {
      const res = await request('/session.css');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/css'));
      assert.ok(typeof res.data === 'string');
      assert.ok(res.data.includes('--primary'));
    });

    it('should serve session.js', async () => {
      const res = await request('/session.js');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('javascript'));
      assert.ok(typeof res.data === 'string');
      assert.ok(res.data.includes('sessionState'));
    });

    it('should still serve landing page at /', async () => {
      const res = await request('/');
      assert.equal(res.status, 200);
      assert.ok(res.data.includes('landing.js'));
    });

    it('should not serve session.html for deeper paths like /session/a/b', async () => {
      const res = await request('/session/a/b');
      assert.equal(res.status, 200);
      // Should fall through to SPA fallback (index.html) since it doesn't match /session/:name
      assert.ok(res.data.includes('landing.js'));
    });
  });

  describe('Session page HTML structure', () => {
    let html;

    before(async () => {
      const res = await request('/session/test-project');
      html = res.data;
    });

    it('should have proper DOCTYPE and html tag', () => {
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('<html lang="en">'));
    });

    it('should have viewport meta for mobile', () => {
      assert.ok(html.includes('viewport-fit=cover'));
      assert.ok(html.includes('width=device-width'));
    });

    it('should have PWA meta tags', () => {
      assert.ok(html.includes('apple-mobile-web-app-capable'));
      assert.ok(html.includes('manifest.json'));
    });

    it('should include banner with back link', () => {
      assert.ok(html.includes('class="banner"'));
      assert.ok(html.includes('class="banner-back"'));
      assert.ok(html.includes('href="/"'));
    });

    it('should include status dot', () => {
      assert.ok(html.includes('status-dot'));
      assert.ok(html.includes('statusDot'));
    });

    it('should include command bar', () => {
      assert.ok(html.includes('commandBar'));
      assert.ok(html.includes('commandInput'));
      assert.ok(html.includes('commandSend'));
      assert.ok(html.includes('commandPills'));
    });

    it('should include terminal viewport with iframe', () => {
      assert.ok(html.includes('terminal-viewport'));
      assert.ok(html.includes('terminalFrame'));
      assert.ok(html.includes('<iframe'));
    });

    it('should include peek drawer', () => {
      assert.ok(html.includes('peekDrawer'));
      assert.ok(html.includes('peekContent'));
      assert.ok(html.includes('peek-drawer'));
    });

    it('should include settings modal', () => {
      assert.ok(html.includes('settingsModal'));
      assert.ok(html.includes('chimeToggle'));
      assert.ok(html.includes('pollInterval'));
      assert.ok(html.includes('mouseToggle'));
    });

    it('should include kill confirmation modal', () => {
      assert.ok(html.includes('killModal'));
      assert.ok(html.includes('killPassword'));
      assert.ok(html.includes('killConfirmBtn'));
    });

    it('should include wrap confirmation modal', () => {
      assert.ok(html.includes('wrapModal'));
      assert.ok(html.includes('wrapPassword'));
      assert.ok(html.includes('wrapConfirmBtn'));
    });

    it('should include session ended bar', () => {
      assert.ok(html.includes('sessionEnded'));
      assert.ok(html.includes('countdown'));
    });

    it('should include connection toast', () => {
      assert.ok(html.includes('id="toast"'));
      assert.ok(html.includes('aria-live="assertive"'));
    });

    it('should include banner action buttons', () => {
      assert.ok(html.includes('cmdBtn'));
      assert.ok(html.includes('peekBtn'));
      assert.ok(html.includes('settingsBtn'));
      assert.ok(html.includes('wrapBtn'));
      assert.ok(html.includes('killBtn'));
    });

    it('should have proper aria attributes', () => {
      assert.ok(html.includes('aria-label'));
      assert.ok(html.includes('aria-expanded'));
      assert.ok(html.includes('aria-controls'));
      assert.ok(html.includes('role="dialog"'));
    });
  });

  describe('Session CSS structure', () => {
    let css;

    before(async () => {
      const res = await request('/session.css');
      css = res.data;
    });

    it('should include v2 color palette variables', () => {
      assert.ok(css.includes('--primary: #8BC34A'));
      assert.ok(css.includes('--danger: #EF5350'));
      assert.ok(css.includes('--bg: #000000'));
      assert.ok(css.includes('--card-bg: #0D0D0D'));
    });

    it('should use 100dvh for session viewport', () => {
      assert.ok(css.includes('100dvh'));
    });

    it('should prevent overscroll', () => {
      assert.ok(css.includes('overscroll-behavior: none'));
    });

    it('should have 44px minimum touch targets', () => {
      assert.ok(css.includes('min-height: 44px'));
      assert.ok(css.includes('min-width: 44px'));
    });

    it('should include banner styles', () => {
      assert.ok(css.includes('.banner'));
      assert.ok(css.includes('.banner-back'));
      assert.ok(css.includes('.banner-name'));
      assert.ok(css.includes('.banner-btn'));
    });

    it('should include status dot with breathing animation', () => {
      assert.ok(css.includes('.status-dot'));
      assert.ok(css.includes('@keyframes breathe'));
      assert.ok(css.includes('.status-dot.disconnected'));
    });

    it('should include command bar styles', () => {
      assert.ok(css.includes('.command-bar'));
      assert.ok(css.includes('.command-input'));
      assert.ok(css.includes('.command-pill'));
    });

    it('should include peek drawer styles', () => {
      assert.ok(css.includes('.peek-drawer'));
      assert.ok(css.includes('.peek-content'));
      assert.ok(css.includes('max-height: 70vh'));
    });

    it('should include terminal viewport styles', () => {
      assert.ok(css.includes('.terminal-viewport'));
      assert.ok(css.includes('.terminal-frame'));
      assert.ok(css.includes('touch-action: auto'));
    });

    it('should include safe-area-inset for mobile', () => {
      assert.ok(css.includes('safe-area-inset-top'));
      assert.ok(css.includes('safe-area-inset-bottom'));
    });

    it('should include engine-specific badge colors', () => {
      assert.ok(css.includes('[data-engine="codex"]'));
      assert.ok(css.includes('[data-engine="aider"]'));
      assert.ok(css.includes('[data-engine="genesis"]'));
    });

    it('should include mobile banner breakpoint', () => {
      assert.ok(css.includes('@media (max-width: 600px)'));
    });

    it('should respect prefers-reduced-motion', () => {
      assert.ok(css.includes('prefers-reduced-motion'));
    });

    it('should include toggle switch styles', () => {
      assert.ok(css.includes('.toggle-switch'));
      assert.ok(css.includes('.toggle-slider'));
    });
  });

  describe('Session JS structure', () => {
    let js;

    before(async () => {
      const res = await request('/session.js');
      js = res.data;
    });

    it('should extract project name from URL', () => {
      assert.ok(js.includes("window.location.pathname.replace(/^\\/session\\//"));
    });

    it('should define api helper functions', () => {
      assert.ok(js.includes('async function api('));
      assert.ok(js.includes('async function apiMutate('));
    });

    it('should include HTML escaping function', () => {
      assert.ok(js.includes('function esc('));
      assert.ok(js.includes('&amp;'));
    });

    it('should include connection state management', () => {
      assert.ok(js.includes('function setConnected('));
      assert.ok(js.includes('reconnectTimer'));
    });

    it('should include command bar functions', () => {
      assert.ok(js.includes('function toggleCommandBar()'));
      assert.ok(js.includes('async function sendCommand('));
      assert.ok(js.includes('function renderCommandPills()'));
      assert.ok(js.includes('function createPill('));
    });

    it('should include peek drawer functions', () => {
      assert.ok(js.includes('async function openPeek()'));
      assert.ok(js.includes('function closePeek()'));
      assert.ok(js.includes('async function refreshPeek()'));
    });

    it('should include chime system with Web Audio', () => {
      assert.ok(js.includes('function initAudio()'));
      assert.ok(js.includes('function playChime()'));
      assert.ok(js.includes('AudioContext'));
    });

    it('should include mobile audio unlock on first gesture', () => {
      assert.ok(js.includes('touchstart'));
      assert.ok(js.includes('once: true'));
    });

    it('should include settings management', () => {
      assert.ok(js.includes('function openSettings()'));
      assert.ok(js.includes('async function closeSettings()'));
    });

    it('should include session status polling', () => {
      assert.ok(js.includes('async function pollStatus()'));
      assert.ok(js.includes('function startPolling()'));
      assert.ok(js.includes('function stopPolling()'));
    });

    it('should include idle detection for chime', () => {
      assert.ok(js.includes('idleCount'));
      assert.ok(js.includes('data.idle'));
    });

    it('should include session ended handling', () => {
      assert.ok(js.includes('function handleSessionEnded('));
      assert.ok(js.includes('countdown'));
      assert.ok(js.includes('Returning in'));
    });

    it('should include kill and wrap modal functions', () => {
      assert.ok(js.includes('function openKillModal()'));
      assert.ok(js.includes('async function confirmKill()'));
      assert.ok(js.includes('function openWrapModal()'));
      assert.ok(js.includes('async function confirmWrap()'));
    });

    it('should include terminal setup', () => {
      assert.ok(js.includes('function setupTerminal('));
      assert.ok(js.includes('/terminal/'));
    });

    it('should include mouse guard for touch devices', () => {
      assert.ok(js.includes('function startMouseGuard()'));
      assert.ok(js.includes('ontouchstart'));
    });

    it('should include localStorage persistence', () => {
      assert.ok(js.includes('function loadSetting('));
      assert.ok(js.includes('function saveSetting('));
      assert.ok(js.includes('localStorage'));
    });

    it('should include command history', () => {
      assert.ok(js.includes('commandHistory'));
      assert.ok(js.includes('function addToHistory('));
    });

    it('should initialize with parallel data loading', () => {
      assert.ok(js.includes('async function initSession()'));
      assert.ok(js.includes('Promise.all'));
    });

    it('should bind events in initialization', () => {
      assert.ok(js.includes('function bindEvents()'));
      assert.ok(js.includes("addEventListener('click'"));
      assert.ok(js.includes("addEventListener('keydown'"));
    });
  });

  describe('Terminal proxy', () => {
    it('should return 502 when ttyd is not running', async () => {
      const res = await request('/terminal/');
      // ttyd isn't running in test, expect 502
      assert.equal(res.status, 502);
      assert.ok(res.headers['content-type'].includes('json'));
      assert.equal(res.data.code, 'BAD_GATEWAY');
    });

    it('should proxy terminal subpaths', async () => {
      const res = await request('/terminal/token');
      assert.equal(res.status, 502);
      assert.equal(res.data.code, 'BAD_GATEWAY');
    });
  });
});
