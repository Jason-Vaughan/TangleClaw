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
  /** The ui.js Project Master section, isolated so assertions about what the
   *  master code must NOT do (e.g. polling) don't trip on unrelated code. */
  let masterSection;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    js = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');

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
      // Same move as the drawer's: the page carries the mount root, the shared
      // component carries the controls. See master-drawer-frontend for why both
      // halves are asserted.
      assert.match(html, /id="masterPanelBar"/);
      const bar = require('./_api-helper-globals')().tcMasterControlBarMarkup('masterPanel', {});
      assert.match(bar, /id="masterPanelDot"/);
      assert.match(bar, /id="masterPanelStatusText"/);
      assert.match(bar, /id="masterPanelRetryBtn"/);
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
      // `'down'` is no longer the unconditional argument: a refusal because tmux
      // never answered is an unknown, not a down master, and painting it red
      // would state the exact fact the server said it could not establish. The
      // down path still exists and is now proven by EXECUTION in
      // `test/master-unknown-frontend.test.js` ("still paints down when the
      // ensure genuinely failed"), which is a stronger claim than this slice.
      assert.match(fn, /setMasterStatus\(unknown \? '' : 'down'/);
    });

    it('failure surfaces the real server message and a retry affordance', () => {
      assert.match(masterSection, /api\.lastError/);
      assert.match(js, /onRetry: ensureMasterAttached/);
    });

    it('the iframe attaches to the reserved tmux session, once per page load', () => {
      assert.match(masterSection, /frame\.src = '\/terminal\/\?arg=tangleclaw-master';/);
      assert.match(masterSection, /if \(frame\.dataset\.attached === 'true'\) return;/);
    });

    it('re-ensure is re-entrant-guarded', () => {
      assert.match(masterSection, /if \(state\.masterEnsuring\) return;/);
    });
  });

  describe('relaunch (#3130 PRR-A R1 BLOCKING 1)', () => {
    it('is composed from the same two routes Kill and Launch already call, in sequence, behind a confirm', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('function relaunchMaster'),
        masterSection.indexOf('function addMasterRelaunchButton')
      );
      assert.match(fn, /window\.confirm\(/);
      assert.match(fn, /api\('\/api\/master\/kill', \{ method: 'POST' \}\)/);
      assert.match(fn, /\.then\(\(\) => api\('\/api\/master\/ensure', \{ method: 'POST' \}\)\)/);
      // Kill is issued and its promise chained before ensure ever runs.
      const killIdx = fn.indexOf("api('/api/master/kill'");
      const ensureIdx = fn.indexOf("api('/api/master/ensure'");
      assert.ok(killIdx > -1 && ensureIdx > killIdx, 'kill must be issued, and chained, before ensure');
      assert.match(fn, /if \(state\.masterEnsuring\) return;/, 're-entrant-guarded like ensureMasterAttached');
    });

    it('a failed relaunch surfaces the real server message, same as a failed ensure', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('function relaunchMaster'),
        masterSection.indexOf('function addMasterRelaunchButton')
      );
      assert.match(fn, /api\.lastErrorCode === 'MASTER_LIVENESS_UNKNOWN'/);
      assert.match(fn, /api\.lastError \|\| 'Failed to relaunch the master session'/);
    });

    it('the button is inserted as a sibling of Kill, outside the shared bar component, and wired after mount', () => {
      assert.match(masterSection, /function addMasterRelaunchButton\(prefix\)/);
      assert.match(masterSection, /document\.getElementById\(`\$\{prefix\}KillBtn`\)/);
      assert.match(masterSection, /btn\.addEventListener\('click', relaunchMaster\);/);
      assert.match(masterSection, /killBtn\.parentNode\.insertBefore\(btn, killBtn\);/);
      assert.match(js, /masterBar\.mount\(\);\s*\n\s*addMasterRelaunchButton\('masterPanel'\);/);
    });

    it('setMasterStatus hides the injected button exactly when it hides Kill — status "down"', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('function setMasterStatus'),
        masterSection.indexOf('async function ensureMasterAttached')
      );
      assert.match(fn, /masterPanelRelaunchBtn/);
      assert.match(fn, /relaunchBtn\.classList\.toggle\('hidden', status === 'down'\);/);
    });
  });

  describe('terminal parity with the session page', () => {
    it('delegates frame wiring to the shared pipeline (theme + #431 + #443 + #445)', () => {
      // Since UI-4C7R the pane carries no wiring of its own: api-helper.js's
      // tcWireTerminalFrame owns the readiness retry and applies the theme,
      // the ⌥+drag local-selection override, the touch-scroll shim, and
      // drag-copy — identically on every terminal surface.
      assert.match(masterSection, /window\.tcWireTerminalFrame\(window, frame,/);
      assert.ok(!/MASTER_XTERM_THEMES/.test(js),
        'the per-pane palette copy (UI-4C7R) must not return');
      assert.ok(!/function wireMasterTouchScroll\(/.test(masterSection),
        'the dead per-pane shim (#443) must not return');
    });

    it('passes the operator theme lazily so config loaded after attach still wins', () => {
      assert.match(masterSection, /\(\) => \(state\.config && state\.config\.theme\) \|\| 'dark'/);
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
  });
});
