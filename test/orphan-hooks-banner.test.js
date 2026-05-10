'use strict';

/*
 * Frontend regression tests for #145 chunk 2 — the dashboard orphan-hooks
 * banner. landing.js is the host (loadProjects + state init); index.html
 * carries the banner markup; style.css carries the visual treatment.
 *
 * Source-level structural assertions are the pragmatic way to lock in the
 * contract — same pattern used for the silentPrime modal in
 * test/settings-modal-silentprime.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Dashboard orphan-hooks banner (#145, chunk 2)', () => {
  let html, css, js;

  before(() => {
    html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
  });

  describe('markup', () => {
    it('renders an orphanHooksBanner element inside projectsContainer, hidden by default', () => {
      assert.match(html, /<main id="projectsContainer"[\s\S]*?id="orphanHooksBanner"[^>]*class="orphan-banner hidden"/);
    });

    it('banner declares role=alert for assistive tech', () => {
      assert.match(html, /id="orphanHooksBanner"[^>]*role="alert"/);
    });

    it('banner has a Repair All button and a Details button with stable ids', () => {
      assert.match(html, /id="orphanHooksRepairBtn"/);
      assert.match(html, /id="orphanHooksDetailsBtn"/);
    });

    it('banner exposes a text slot for the count message', () => {
      assert.match(html, /id="orphanHooksBannerText"/);
    });
  });

  describe('CSS', () => {
    it('amber warning treatment + .hidden toggling', () => {
      assert.match(css, /\.orphan-banner\s*\{[\s\S]*?background:\s*var\(--amber\)/);
      assert.match(css, /\.orphan-banner\.hidden\s*\{\s*display:\s*none/);
    });
  });

  describe('landing.js wiring', () => {
    it('state.orphanHooks is initialized so first-render does not throw', () => {
      assert.match(js, /orphanHooks:\s*null/);
    });

    it('loadProjects triggers loadOrphanHooksInventory (non-blocking on failure)', () => {
      assert.match(js, /loadOrphanHooksInventory\(\)\.catch\(/);
    });

    it('loadOrphanHooksInventory fetches the scan endpoint and re-renders the banner', () => {
      assert.match(js, /async function loadOrphanHooksInventory/);
      assert.match(js, /api\(['"]\/api\/projects\/orphan-hooks-scan['"]\)/);
      assert.match(js, /renderOrphanHooksBanner\(/);
    });

    it('renderOrphanHooksBanner hides on empty inventory, shows + populates count when non-empty', () => {
      assert.match(js, /function renderOrphanHooksBanner/);
      // Hides when nothing to show
      assert.match(js, /banner\.classList\.add\(['"]hidden['"]\)/);
      // Shows + writes a count line when there are projects
      assert.match(js, /banner\.classList\.remove\(['"]hidden['"]\)/);
      // Singular vs. plural copy so the banner reads correctly with N=1
      assert.match(js, /list\.length === 1.*'project has' : 'projects have'/);
    });

    it('repairAllOrphanHooks POSTs to the repair endpoint then reloads', () => {
      assert.match(js, /async function repairAllOrphanHooks/);
      assert.match(js, /apiMutate\(['"]\/api\/projects\/repair-orphan-hooks['"]\s*,\s*['"]POST['"]/);
      assert.match(js, /await loadProjects\(\)/);
    });

    it('repair path surfaces partial-failure via toast-warn when errors[] is non-empty (Critic M1)', () => {
      // Without an explicit errorN check, a server response with errors[] but
      // no thrown exception would land silently — banner left stale, no user
      // feedback. The structural lock-in: a `Array.isArray(data.errors)`
      // branch must drive a `toast-warn` class.
      assert.match(js, /Array\.isArray\(data\.errors\)/);
      assert.match(js, /toast-warn visible/);
    });

    it('repair path surfaces no-response failure separately from successful empty repair (Critic M1)', () => {
      assert.match(js, /Repair failed \(no response\)/);
    });

    it('wire handler surfaces thrown errors via toast rather than swallowing (Critic M1)', () => {
      // Previously the `.catch(() => {})` silently absorbed every throw.
      // After Critic M1, the handler logs to console AND fires a toast-warn
      // with the error message so a permanent failure is visible.
      assert.match(js, /console\.error\(['"]orphan-hooks repair failed['"]/);
      assert.match(js, /err\.message/);
    });

    it('polling-driven loadOrphanHooksInventory is gated on orphanHooksRepairInFlight (Critic N3)', () => {
      // Without the gate, the 10s polling tick could fire between the
      // confirm-click and the POST returning, briefly flashing the
      // pre-repair banner state back. The gate skips the scan refresh
      // while the POST is in flight.
      assert.match(js, /orphanHooksRepairInFlight:\s*false/);
      assert.match(js, /if\s*\(\s*!state\.orphanHooksRepairInFlight\s*\)/);
      assert.match(js, /state\.orphanHooksRepairInFlight\s*=\s*true/);
      assert.match(js, /state\.orphanHooksRepairInFlight\s*=\s*false/);
    });

    it('repair confirm dialog warns about scope (preserves non-orphan hooks + other keys)', () => {
      // Critical: the user needs to understand this isn't nuking all hooks.
      assert.match(js, /Non-orphan hooks and all other settings keys are preserved/);
    });

    it('showOrphanHooksDetails surfaces the per-project missing-paths breakdown', () => {
      assert.match(js, /function showOrphanHooksDetails/);
      // Each line should reference the event name and the missing paths
      assert.match(js, /o\.event/);
      assert.match(js, /o\.missing\.join/);
    });

    it('wireOrphanHooksBanner is called from init so click handlers exist before first render', () => {
      assert.match(js, /function wireOrphanHooksBanner/);
      const initIdx = js.indexOf('async function init()');
      assert.ok(initIdx >= 0);
      const initSlice = js.slice(initIdx, initIdx + 2000);
      assert.match(initSlice, /wireOrphanHooksBanner\(\)/);
    });
  });
});
