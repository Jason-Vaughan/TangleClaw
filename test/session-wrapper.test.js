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

    it('should include peek search bar', () => {
      assert.ok(html.includes('peekSearchBar'));
      assert.ok(html.includes('peekSearchInput'));
      assert.ok(html.includes('peekSearchCount'));
      assert.ok(html.includes('peekSearchPrev'));
      assert.ok(html.includes('peekSearchNext'));
      assert.ok(html.includes('peekSearchClose'));
      assert.ok(html.includes('peekSearchBtn'));
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

    it('should include wrap-idle modal with Return / Resume buttons (#98)', () => {
      // #sessionWrapIdle is now a .modal-backdrop / .modal-content modal
      // (was inline banner before #98). Sticky once shown — backdrop click
      // dismisses (= Resume working).
      assert.ok(html.includes('sessionWrapIdle'));
      assert.ok(html.includes('wrapReturnBtn'));
      assert.ok(html.includes('wrapResumeBtn'));
      // Locate the modal element and assert it carries the modal classes.
      const idx = html.indexOf('id="sessionWrapIdle"');
      assert.ok(idx >= 0, 'sessionWrapIdle must exist in markup');
      const openTag = html.slice(html.lastIndexOf('<', idx), html.indexOf('>', idx) + 1);
      assert.ok(openTag.includes('modal-backdrop'), 'sessionWrapIdle must carry modal-backdrop');
      // Modal-content with role="dialog" + aria-modal must be present in the slice.
      const slice = html.slice(idx, html.indexOf('</div>', idx) + 200);
      assert.ok(slice.includes('modal-content'), 'must contain modal-content');
      assert.ok(slice.includes('aria-modal="true"'), 'must be aria-modal');
      assert.ok(slice.includes('modal-actions'), 'must contain modal-actions');
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

    it('should have compact touch targets', () => {
      assert.ok(css.includes('min-height: 32px') || css.includes('min-height: 30px'));
      assert.ok(css.includes('min-width: 32px') || css.includes('min-width: 30px'));
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

    it('should not carry the legacy wrap-idle banner CSS class (#98)', () => {
      // The .session-wrap-idle inline-banner class was removed when the
      // wrap-idle UI moved to the existing .modal-backdrop / .modal-content
      // pattern. The tests for those classes live elsewhere.
      assert.ok(!css.includes('.session-wrap-idle'));
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

    it('should include peek search styles', () => {
      assert.ok(css.includes('.peek-search'));
      assert.ok(css.includes('.peek-search-input'));
      assert.ok(css.includes('.peek-search-count'));
      assert.ok(css.includes('.peek-search-match'));
      assert.ok(css.includes('.peek-search-match-active'));
      assert.ok(css.includes('.peek-search-nav'));
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
      assert.ok(css.includes('[data-engine="antigravity"]'));
      assert.ok(!css.includes('[data-engine="genesis"]'), 'genesis retired (#458)');
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

    it('should bind api helper from the shared factory', () => {
      // After #82, api()/apiMutate() live in /api-helper.js. session.js binds
      // them at module load via window.tcCreateApi / window.tcCreateApiMutate.
      assert.ok(js.includes('window.tcCreateApi'));
      assert.ok(js.includes('window.tcCreateApiMutate'));
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

    it('should include peek search functions', () => {
      assert.ok(js.includes('function openPeekSearch()'));
      assert.ok(js.includes('function closePeekSearch()'));
      assert.ok(js.includes('function executePeekSearch('));
      assert.ok(js.includes('function renderPeekWithHighlights()'));
      assert.ok(js.includes('function peekSearchNext()'));
      assert.ok(js.includes('function peekSearchPrev()'));
      assert.ok(js.includes('function scrollToCurrentMatch()'));
      assert.ok(js.includes('function updatePeekSearchCount()'));
      assert.ok(js.includes('function escapeHtml('));
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

    it('should require 8 idle polls before showing wrap-idle banner (#91)', () => {
      // Idle threshold raised from 3 (~6s) to 8 (~16s) to survive brief
      // git push / Critic pauses without false-positive completion.
      assert.ok(js.includes('wrapIdleCount >= 8'));
      assert.ok(!js.includes('wrapIdleCount >= 3'));
    });

    it('should not have a 120s wrap force-completion timeout (#91)', () => {
      // The hard timeout was removed — kill button is the escape hatch.
      assert.ok(!js.includes('120_000'));
      assert.ok(!js.includes('wrapTimeoutTimer'));
      assert.ok(!js.includes('clearWrapTimeout'));
    });

    it('should expose wrap-idle modal handlers (#91, renamed in #98)', () => {
      assert.ok(js.includes('function showWrapIdleModal('));
      assert.ok(!js.includes('function showWrapIdleBanner('));
      assert.ok(js.includes('function resumeFromWrapIdle('));
      assert.ok(js.includes('async function confirmReturnFromWrapIdle('));
    });

    it('wrap-idle modal is sticky once shown — no auto-hide on idle flip-flop (#98)', () => {
      // PR #93 added a Critic-MAJOR-2 auto-hide that called resumeFromWrapIdle()
      // from the poll handler when data.wrapping && !data.idle and the banner
      // was shown. #98 dropped that branch — incidental ttyd redraw events were
      // dismissing the modal under the cursor. Verify the auto-hide call is
      // no longer wired through that branch.
      const branchIdx = js.indexOf('AI active again');
      assert.ok(branchIdx >= 0, 'expected the wrapping-active comment');
      // Slice ~400 chars after the comment — that's the poll-handler else-branch.
      const slice = js.slice(branchIdx, branchIdx + 400);
      assert.ok(!slice.includes('resumeFromWrapIdle()'),
        'auto-hide-on-resume must be removed from the poll handler');
    });

    it('wrap-idle modal supports backdrop click → dismiss (#98)', () => {
      // Mirror of the wrapModal / killModal backdrop pattern: clicking the
      // .modal-backdrop element (not its content) calls resumeFromWrapIdle.
      // Brace-walk the listener body so a wrapping comment doesn't escape the
      // window — the body itself is what we're asserting.
      const wireIdx = js.indexOf("$('sessionWrapIdle').addEventListener");
      assert.ok(wireIdx >= 0, 'sessionWrapIdle must have a click listener wired');
      const arrowStart = js.indexOf('=>', wireIdx);
      assert.ok(arrowStart >= 0, 'expected arrow function in listener');
      let i = js.indexOf('{', arrowStart);
      assert.ok(i >= 0, 'expected listener body open brace');
      let depth = 0;
      let end = -1;
      for (; i < js.length; i++) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      const body = js.slice(wireIdx, end + 1);
      assert.ok(body.includes('e.target === e.currentTarget'),
        'backdrop click must guard on event target equality');
      assert.ok(body.includes('resumeFromWrapIdle'),
        'backdrop click must call resumeFromWrapIdle');
      assert.ok(body.includes('wrapCompleting'),
        'backdrop click must short-circuit while a Return POST is in flight');
    });

    it('should not navigate when /wrap/complete POST fails (#91 Critic)', () => {
      // Regression: if apiMutate returns null (network/server error),
      // tmux is still alive — the user must not be silently bounced to /.
      // The handler should re-enable buttons and show a toast instead.
      const start = js.indexOf('async function confirmReturnFromWrapIdle(');
      assert.ok(start >= 0);
      let depth = 0;
      let i = js.indexOf('{', start);
      let end = -1;
      for (; i < js.length; i++) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      const body = js.slice(start, end + 1);
      assert.ok(body.includes('if (!data)'),
        'must guard the navigate behind a truthy data check');
      assert.ok(body.includes("wrapReturnBtn').disabled = false") ||
                body.includes("wrapReturnBtn').disabled  = false"),
        'must re-enable wrapReturnBtn on POST failure');
      assert.ok(body.includes('toast'),
        'must surface a toast on POST failure');
    });

    it('should not auto-redirect from handleWrapCompleted (#91)', () => {
      // The 20s countdown that auto-navigated to / has been removed.
      // Slice handleWrapCompleted's body and assert no setInterval/Returning in.
      const start = js.indexOf('function handleWrapCompleted(');
      assert.ok(start >= 0, 'handleWrapCompleted must exist');
      // Walk braces to find the function body end.
      let depth = 0;
      let i = js.indexOf('{', start);
      let end = -1;
      for (; i < js.length; i++) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      assert.ok(end > start, 'handleWrapCompleted body must close');
      const body = js.slice(start, end + 1);
      assert.ok(!body.includes('setInterval'),
        'handleWrapCompleted must not start an auto-redirect interval');
      assert.ok(!body.includes('Returning in'),
        'handleWrapCompleted must not show a countdown');
      assert.ok(!body.includes("window.location.href = '/'"),
        'handleWrapCompleted must not navigate automatically');
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
