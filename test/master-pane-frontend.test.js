'use strict';

/*
 * Frontend structural tests for chunk G slice 2 (#331) — the landing-page
 * Project Master pane. The chat surface IS the terminal: a ttyd iframe onto
 * the reserved tmux session `tangleclaw-master`, attached ONLY after
 * POST /api/master/ensure succeeds (ttyd attaches to existing sessions only).
 *
 * ui.js / index.html render via static markup + DOM wiring with many
 * top-level deps, so source-level structural assertions are the pragmatic
 * contract lock-in — same pattern as test/upload-modal-frontend.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Project Master pane — landing page (chunk G slice 2, #331)', () => {
  let html;
  let js;
  let css;
  let sw;
  /** The ui.js Project Master section, isolated so assertions about what the
   *  master code must NOT do (e.g. polling) don't trip on unrelated code. */
  let masterSection;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    js = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
    sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');

    const start = js.indexOf('── Project Master');
    const end = js.indexOf('── Event Bindings ──');
    assert.ok(start > -1 && end > start, 'ui.js has a Project Master section before Event Bindings');
    masterSection = js.slice(start, end);
  });

  describe('markup', () => {
    it('header has a Master toggle button wired to the panel with a status dot', () => {
      assert.match(html, /id="masterToggle"[^>]*aria-controls="masterPanel"/s);
      assert.match(html, /id="masterToggle"[^>]*aria-expanded="false"/s);
      assert.match(html, /id="masterDot"/);
    });

    it('the master panel carries a status row, retry button, and the iframe', () => {
      assert.match(html, /id="masterPanel" class="master-panel"/);
      assert.match(html, /id="masterPanelDot"/);
      assert.match(html, /id="masterStatusText"/);
      assert.match(html, /id="masterRetryBtn"/);
      assert.match(html, /id="masterFrame"/);
    });

    it('the iframe ships WITHOUT a src — attach happens only after ensure', () => {
      const iframeTag = html.match(/<iframe id="masterFrame"[^>]*>/);
      assert.ok(iframeTag, 'master iframe exists');
      assert.ok(!/\ssrc=/.test(iframeTag[0]), 'iframe must not have a static src attribute');
    });
  });

  describe('ensure-then-attach flow', () => {
    it('opening the panel runs the ensure flow', () => {
      assert.match(masterSection, /function toggleMaster\(\)/);
      assert.match(masterSection, /if \(state\.masterOpen\) ensureMasterAttached\(\);/);
    });

    it('ensure POSTs /api/master/ensure and only attaches on success', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('async function ensureMasterAttached'),
        masterSection.indexOf('function attachMasterFrame')
      );
      assert.match(fn, /api\('\/api\/master\/ensure', \{ method: 'POST' \}\)/);
      // Failure path returns BEFORE attachMasterFrame is reached.
      const failIdx = fn.indexOf('if (!result)');
      const attachIdx = fn.indexOf('attachMasterFrame()');
      assert.ok(failIdx > -1, 'ensure checks the api() null-on-error contract');
      assert.ok(attachIdx > failIdx, 'attach happens only after the failure guard');
      assert.match(fn, /setMasterStatus\('down'/);
    });

    it('failure surfaces the real server message and a retry affordance', () => {
      assert.match(masterSection, /api\.lastError/);
      assert.match(js, /\$\('masterRetryBtn'\)\.addEventListener\('click', ensureMasterAttached\)/);
    });

    it('the iframe attaches to the reserved tmux session, once per page load', () => {
      assert.match(masterSection, /frame\.src = '\/terminal\/\?arg=tangleclaw-master';/);
      assert.match(masterSection, /if \(frame\.dataset\.attached === 'true'\) return;/);
    });

    it('re-ensure is re-entrant-guarded', () => {
      assert.match(masterSection, /if \(state\.masterEnsuring\) return;/);
    });
  });

  describe('terminal parity with the session page', () => {
    it('applies the #431 ⌥+drag local-selection override so copy reaches the browser', () => {
      assert.match(masterSection, /macOptionClickForcesSelection = true/);
      assert.match(masterSection, /doc\.execCommand\('copy'\)/);
      assert.match(masterSection, /tcCopyOnMouseUp/);
    });

    it('pushes the operator theme into the iframe xterm instance', () => {
      assert.match(masterSection, /MASTER_XTERM_THEMES\[theme\]/);
      assert.match(masterSection, /'high-contrast':/);
    });

    it('wires the mobile touch-scroll shim (iPhone Safari is the primary platform)', () => {
      assert.match(masterSection, /function wireMasterTouchScroll\(/);
      assert.match(masterSection, /'ontouchstart' in window/);
      assert.match(masterSection, /term\.scrollLines\(linesToScroll\)/);
      assert.match(masterSection, /wireMasterTouchScroll\(frame, term, doc\)/);
      assert.match(masterSection, /\{ passive: true \}/);
    });
  });

  describe('status dot', () => {
    it('a one-shot load probe colors the dot from /api/master/status — no polling', () => {
      assert.match(masterSection, /api\('\/api\/master\/status'\)/);
      assert.ok(!/setInterval/.test(masterSection), 'no timer-driven polling in the master section (no-UI-timers rule)');
    });

    it('toggle + dot wiring is bound', () => {
      assert.match(js, /\$\('masterToggle'\)\.addEventListener\('click', toggleMaster\)/);
      assert.match(js, /refreshMasterDot\(\);/);
    });
  });

  describe('styling + service worker', () => {
    it('the panel uses the standard collapsible pattern and the dot has all three states', () => {
      assert.match(css, /\.master-panel\.open \{/);
      assert.match(css, /\.master-frame \{/);
      assert.match(css, /\.master-dot\.live \{/);
      assert.match(css, /\.master-dot\.pending \{/);
      assert.match(css, /\.master-dot\.down \{/);
    });

    it('CACHE_NAME is bumped so active service workers surface the new shell', () => {
      assert.match(sw, /const CACHE_NAME = 'tangleclaw-v3-32';/);
    });
  });
});
