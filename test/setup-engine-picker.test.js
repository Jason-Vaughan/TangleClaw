'use strict';

/*
 * #738 — the setup wizard's engine step converges its `<option>` markup onto
 * the shared `tcBuildEngineOptions` (`public/api-helper.js`), the one picker
 * #707 left as a hand-rolled copy. `test/setup-wizard-engines.test.js`
 * already pins the pre-convergence behavior and stays in force unmodified
 * (not touched here — out of this lane's file scope); this file pins what
 * is NEW or was never pinned at all:
 *
 *   - a profile with no usable name (`engineClientPayload`'s fallback, #736)
 *     rendering correctly through the now-shared `<option>` builder, AND in
 *     the availability list's `<span class="setup-engine-name">` — the old
 *     wizard test only pinned the `<option>` half and explicitly scoped its
 *     regex away from the span (its own comment: a loose match "stays green
 *     while the option renders blank"), so the span's fallback was never its
 *     own assertion. This file adds it.
 *   - the predicate change itself, approved by TC-Lane-INT: an engine
 *     entirely missing the `available` flag is now unavailable (strict
 *     `!e.available`), where the old loose check (`=== false`) would have
 *     left it selectable.
 *
 * Same vm-plus-DOM-stub approach as setup-wizard-engines.test.js, but this
 * sandbox also loads api-helper.js first — setup.js now calls
 * `tcBuildEngineOptions`, a global api-helper publishes, exactly as
 * `index.html` loads api-helper.js before setup.js for pages to share it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LANDING_JSARG_SRC } = require('./_page-globals');

const API_HELPER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
const SETUP_JS_PATH = path.join(__dirname, '..', 'public', 'setup.js');
const RAW_SETUP_SRC = fs.readFileSync(SETUP_JS_PATH, 'utf8');
const SETUP_JS_SRC = RAW_SETUP_SRC.replace(/^const wizard = /m, 'var wizard = ')
  + '\n;globalThis.wizard = wizard;\n';

const CLAUDE = { id: 'claude', name: 'Claude Code' };
const CODEX = { id: 'codex', name: 'Codex CLI' };

/** Minimal element stub covering what the engine step touches. */
function makeElement(id) {
  const classSet = new Set();
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    className: '',
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c)
    },
    focus() {},
    addEventListener() {},
    dispatchEvent() {}
  };
}

/**
 * Load api-helper.js then setup.js into one shared sandbox, so setup.js's
 * call to the real, shared `tcBuildEngineOptions` resolves — not a stub.
 * @param {object[]} engines - `[{id, name, available}]`
 * @param {object} [config] - Partial global config (e.g. `{defaultEngine: 'claude'}`)
 * @returns {object} sandbox
 */
function loadSetup(engines, config) {
  const elements = new Map();
  const sandbox = {
    console, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    Promise, Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, Error,
    esc: (str) => (typeof str !== 'string' ? '' : str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')),
    apiMutate: async () => null,
    api: Object.assign(async () => null, { lastError: null }),
    loadConfig: async () => {}, loadProjects: async () => {}, loadStats: async () => {},
    loadPorts: async () => {}, maybeShowFilter: () => {}, startPolling: () => {},
    state: {
      engines: engines || [],
      config: Object.assign({ setupComplete: false }, config || {})
    },
    fetch: async () => ({ ok: true })
  };
  sandbox.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    body: { classList: { add() {}, remove() {} } }
  };
  sandbox.window = sandbox;
  sandbox.location = { href: null };

  vm.createContext(sandbox);
  // api-helper.js first: it publishes `tcBuildEngineOptions` as a global, and
  // setup.js's `renderEngines` now calls it, same load order as index.html.
  vm.runInContext(API_HELPER_SRC, sandbox);
  // landing.js's `jsArg` is a page global setup.js calls (#1902).
  vm.runInContext(LANDING_JSARG_SRC, sandbox);
  vm.runInContext(SETUP_JS_SRC, sandbox);
  sandbox.__elements = elements;
  return sandbox;
}

/** Render the engine step and return its HTML. */
function renderEngineStep(ctx) {
  const body = ctx.document.getElementById('setupBody');
  ctx.renderEngines(body);
  return body.innerHTML;
}

describe('Setup wizard engine picker — convergence onto the shared builder (#738)', () => {
  describe('a profile with no usable name', () => {
    // Driven through `engineClientPayload`, which is what `/api/engines`
    // actually hands this step and is where the name fallback lives (#736).
    const projected = require('../lib/engines')
      .engineClientPayload({ id: 'homegrown' }, { available: true });

    it('falls back to its id in the <option>, through the shared builder', () => {
      const ctx = loadSetup([projected], { defaultEngine: 'homegrown' });
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /<option value="homegrown"[^>]*>homegrown</,
        'a nameless profile must fall back to its id in the picker itself');
    });

    it('also falls back to its id in the availability list span', () => {
      // The gap the pre-convergence test explicitly scoped around: it needed
      // a regex scoped to the <option> specifically because a loose match
      // would also hit this span and stay green even if the span rendered
      // blank. This is that missing, dedicated assertion.
      const ctx = loadSetup([projected], { defaultEngine: 'homegrown' });
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /<span class="setup-engine-name">homegrown<\/span>/,
        'the availability list must show the same id fallback as the dropdown');
    });
  });

  describe('a profile missing the `available` flag entirely', () => {
    // No `listWithAvailability()` call ever omits the flag for real data —
    // this is the synthetic edge case #738 asks the predicate to cover.
    const roster = [
      { ...CLAUDE },
      { ...CODEX, available: true }
    ];

    it('is disabled and labelled, not left selectable', () => {
      const ctx = loadSetup(roster, { defaultEngine: 'codex' });
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /<option value="claude"[^>]*disabled[^>]*>Claude Code \(not installed\)</,
        'missing `available` must read as unavailable — strict `!e.available`, not `=== false`');
    });

    it('is excluded from the seeded default and the first-available fallback', () => {
      const ctx = loadSetup(roster, { defaultEngine: 'claude' });
      ctx.showWizard();
      assert.equal(ctx.wizard.defaultEngine, 'codex',
        'an engine with no `available` flag must not be treated as installed');
    });
  });

  describe('parity with the pre-convergence hand-rolled loop', () => {
    const roster = [
      { ...CLAUDE, available: false },
      { ...CODEX, available: true }
    ];

    it('still pre-selects the installed engine and disables the uninstalled one', () => {
      const ctx = loadSetup(roster, { defaultEngine: 'claude' });
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /<option value="codex"[^>]*\sselected/,
        'the installed engine must be the selected option');
      assert.doesNotMatch(html, /<option value="claude"[^>]*\sselected/,
        'an uninstalled engine must never be pre-selected');
      assert.match(html, /<option value="claude"[^>]*disabled[^>]*>Claude Code \(not installed\)</,
        'the uninstalled engine stays listed, labelled, and disabled');
      assert.doesNotMatch(html, /<option value="codex"[^>]*disabled/,
        'an installed engine must remain selectable');
    });
  });
});
