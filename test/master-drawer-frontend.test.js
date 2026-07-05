'use strict';

/*
 * Frontend structural tests for chunk G slice 3 (#331) — the in-session
 * Project Master drawer. Same contract as the landing pane (slice 2,
 * test/master-pane-frontend.test.js): the chat surface IS the terminal — a
 * ttyd iframe onto the reserved tmux session `tangleclaw-master`, attached
 * ONLY after POST /api/master/ensure succeeds (ttyd attaches to existing
 * sessions only). The drawer is the "reach it without leaving a session"
 * surface (design decision D7).
 *
 * session.js drives a real iframe/DOM at runtime with no headless harness in
 * this repo, so these are source-level structural assertions — the same
 * pattern as test/master-pane-frontend.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Project Master drawer — session page (chunk G slice 3, #331)', () => {
  let html;
  let js;
  let css;
  let sw;
  /** The session.js Project Master Drawer section, isolated so assertions
   *  about what the drawer code must NOT do (e.g. polling) don't trip on
   *  unrelated code. */
  let drawerSection;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    html = fs.readFileSync(path.join(pub, 'session.html'), 'utf8');
    js = fs.readFileSync(path.join(pub, 'session.js'), 'utf8');
    css = fs.readFileSync(path.join(pub, 'session.css'), 'utf8');
    sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');

    const start = js.indexOf('── Project Master Drawer');
    const end = js.indexOf('── Terminal Setup ──');
    assert.ok(start > -1 && end > start, 'session.js has a Project Master Drawer section before Terminal Setup');
    drawerSection = js.slice(start, end);
  });

  describe('markup', () => {
    it('the banner has a Master button wired to the drawer', () => {
      assert.match(html, /id="masterBtn"[^>]*aria-expanded="false"/s);
      assert.match(html, /id="masterBtn"[^>]*aria-controls="masterDrawer"/s);
    });

    it('the drawer carries a status row, retry button, and the iframe', () => {
      assert.match(html, /<aside class="master-drawer" id="masterDrawer" role="dialog"/);
      assert.match(html, /id="masterBackdrop"/);
      assert.match(html, /id="masterDrawerDot"/);
      assert.match(html, /id="masterDrawerStatusText"/);
      assert.match(html, /id="masterDrawerRetryBtn"/);
      assert.match(html, /id="masterDrawerFrame"/);
    });

    it('the iframe ships WITHOUT a src — attach happens only after ensure', () => {
      const iframeTag = html.match(/<iframe id="masterDrawerFrame"[^>]*>/);
      assert.ok(iframeTag, 'drawer iframe exists');
      assert.ok(!/\ssrc=/.test(iframeTag[0]), 'iframe must not have a static src attribute');
    });
  });

  describe('ensure-then-attach flow', () => {
    it('opening the drawer runs the ensure flow', () => {
      assert.match(drawerSection, /function openMasterDrawer\(\)/);
      assert.match(drawerSection, /ensureMasterDrawerAttached\(\);/);
    });

    it('ensure POSTs /api/master/ensure and only attaches on success', () => {
      const fn = drawerSection.slice(
        drawerSection.indexOf('async function ensureMasterDrawerAttached'),
        drawerSection.indexOf('function attachMasterDrawerFrame')
      );
      assert.match(fn, /api\('\/api\/master\/ensure', \{ method: 'POST' \}\)/);
      // Failure path returns BEFORE attachMasterDrawerFrame is reached.
      const failIdx = fn.indexOf('if (!result)');
      const attachIdx = fn.indexOf('attachMasterDrawerFrame()');
      assert.ok(failIdx > -1, 'ensure checks the api() null-on-error contract');
      assert.ok(attachIdx > failIdx, 'attach happens only after the failure guard');
      assert.match(fn, /setMasterDrawerStatus\('down'/);
    });

    it('failure surfaces the real server message and a retry affordance', () => {
      assert.match(drawerSection, /api\.lastError/);
      assert.match(js, /\$\('masterDrawerRetryBtn'\)\.addEventListener\('click', ensureMasterDrawerAttached\)/);
    });

    it('the iframe attaches to the reserved tmux session, once per page load', () => {
      assert.match(drawerSection, /frame\.src = '\/terminal\/\?arg=tangleclaw-master';/);
      assert.match(drawerSection, /if \(frame\.dataset\.attached === 'true'\) return;/);
    });

    it('re-ensure is re-entrant-guarded', () => {
      assert.match(drawerSection, /if \(sessionState\.masterEnsuring\) return;/);
    });

    it('closing only hides the surface — the master session persists', () => {
      const closeFn = drawerSection.slice(
        drawerSection.indexOf('function closeMasterDrawer'),
        drawerSection.indexOf('async function ensureMasterDrawerAttached')
      );
      assert.ok(!/api\(/.test(closeFn), 'close must not call the API (no kill, no re-ensure)');
      assert.match(closeFn, /classList\.remove\('open'\)/);
    });
  });

  describe('terminal parity (shared pipeline)', () => {
    it('delegates frame wiring to the shared pipeline (theme + #431 + #443 + #445)', () => {
      assert.match(drawerSection, /window\.tcWireTerminalFrame\(window, frame,/);
    });

    it('passes the operator theme lazily so config loaded after attach still wins', () => {
      assert.match(drawerSection, /\(\) => \(sessionState\.config && sessionState\.config\.theme\) \|\| 'dark'/);
    });

    it('live theme switches repaint the drawer terminal too', () => {
      const applyFn = js.slice(
        js.indexOf('function applyTerminalTheme'),
        js.indexOf('function applyTerminalTheme') + 700
      );
      assert.match(applyFn, /'masterDrawerFrame'/);
      assert.match(applyFn, /tcApplyTerminalTheme\(term, theme\)/);
    });
  });

  describe('bindings + discipline', () => {
    it('open/close/retry wiring is bound', () => {
      assert.match(js, /\$\('masterBtn'\)\.addEventListener\('click', openMasterDrawer\)/);
      assert.match(js, /\$\('masterCloseBtn'\)\.addEventListener\('click', closeMasterDrawer\)/);
      assert.match(js, /\$\('masterBackdrop'\)\.addEventListener\('click', closeMasterDrawer\)/);
    });

    it('no timer-driven polling in the drawer section (no-UI-timers rule)', () => {
      assert.ok(!/setInterval/.test(drawerSection), 'status repaints on open/ensure only');
    });
  });

  describe('styling + service worker', () => {
    it('the drawer uses the bottom-sheet pattern and the dot has all three states', () => {
      assert.match(css, /\.master-drawer\.open \{/);
      assert.match(css, /\.master-drawer-frame \{/);
      assert.match(css, /\.master-dot\.live \{/);
      assert.match(css, /\.master-dot\.pending \{/);
      assert.match(css, /\.master-dot\.down \{/);
    });

    it('CACHE_NAME is bumped so active service workers surface the new shell', () => {
      // Past the pre-#331-slice-3 generation; the exact current pin lives in
      // test/bridge-port-input.test.js, which owns the latest bump (#489).
      assert.match(sw, /const CACHE_NAME = 'tangleclaw-v3-\d+';/);
      assert.ok(!/const CACHE_NAME = 'tangleclaw-v3-3[1234]';/.test(sw),
        'cache generation must be past v3-34 (the pre-#331-slice-3 shell)');
    });
  });
});
