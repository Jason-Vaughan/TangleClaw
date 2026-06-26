'use strict';

// AUTH-2 slice 2b — frontend wizard admin step. public/setup.js is a plain
// <script>-loaded file, so (like setup-wizard-https.test.js) it's loaded into a
// `vm` context with a minimal DOM stub. These tests cover the caddy-only step
// insertion, the client-side password gate, and the completion payload.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SETUP_JS_PATH = path.join(__dirname, '..', 'public', 'setup.js');
const RAW_SRC = fs.readFileSync(SETUP_JS_PATH, 'utf8');
// Expose the top-level `wizard` binding (a `const`, which a vm context doesn't
// attach to its global) so tests can read/mutate it.
const SETUP_JS_SRC = RAW_SRC.replace(/^const wizard = /m, 'var wizard = ')
  + '\n;globalThis.wizard = wizard;\n';

/** Minimal element stub mirroring the DOM APIs the wizard touches. */
function makeElement(id) {
  const classSet = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false,
    disabled: false, style: {}, className: '',
    classList: {
      add: (c) => classSet.add(c), remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c), _set: classSet
    },
    focus() {}, addEventListener() {}, dispatchEvent() {}
  };
}

/**
 * Load public/setup.js into a sandbox.
 * @param {object} [opts]
 * @param {object} [opts.config] - state.config contents (e.g. { ingressMode: 'caddy' }).
 * @param {Function} [opts.apiMutate] - apiMutate override.
 * @returns {object} sandbox context, with __apiCalls captured.
 */
function loadSetup(opts = {}) {
  const elements = new Map();
  const apiCalls = [];
  const sandbox = {
    console, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    Promise, Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, Error,
    esc: (s) => (typeof s !== 'string' ? '' : s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')),
    apiMutate: async (url, method, body) => {
      apiCalls.push({ url, method, body });
      return opts.apiMutate ? opts.apiMutate(url, method, body) : null;
    },
    api: Object.assign(async () => null, { lastError: null, lastErrorCode: null }),
    loadConfig: async () => {}, loadProjects: async () => {}, loadStats: async () => {},
    loadPorts: async () => {}, maybeShowFilter: () => {}, startPolling: () => {},
    dismissWizard: () => {},
    state: {
      engines: [], methodologies: [],
      config: Object.assign({ setupComplete: false }, opts.config || {})
    }
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
  sandbox.location = { get href() { return null; }, set href(_v) {} };

  vm.createContext(sandbox);
  vm.runInContext(SETUP_JS_SRC, sandbox);
  sandbox.__elements = elements;
  sandbox.__apiCalls = apiCalls;
  return sandbox;
}

describe('AUTH-2 wizard admin step (frontend)', () => {
  describe('step insertion', () => {
    it('adds the admin step only in caddy mode', () => {
      const direct = loadSetup({ config: { ingressMode: 'direct' } });
      assert.equal(direct.wizardStepKeys().includes('admin'), false);
      assert.equal(direct.wizardStepKeys().length, 7);

      const caddy = loadSetup({ config: { ingressMode: 'caddy' } });
      const keys = caddy.wizardStepKeys();
      assert.equal(keys.includes('admin'), true);
      assert.equal(keys.length, 8);
      // admin must sit immediately before the final confirm step.
      assert.equal(keys[keys.length - 2], 'admin');
      assert.equal(keys[keys.length - 1], 'confirm');
    });

    it('hides the Skip button in caddy mode', () => {
      const caddy = loadSetup({ config: { ingressMode: 'caddy' } });
      caddy.showWizard();
      assert.equal(caddy.document.getElementById('setupSkipBtn').style.display, 'none');

      const direct = loadSetup({ config: { ingressMode: 'direct' } });
      direct.showWizard();
      assert.equal(direct.document.getElementById('setupSkipBtn').style.display, '');
    });
  });

  describe('_adminCanAdvance', () => {
    function withAdmin(ctx, user, pw, confirm) {
      ctx.wizard.adminUser = user;
      ctx.wizard.adminPassword = pw;
      ctx.wizard.adminPasswordConfirm = confirm === undefined ? pw : confirm;
      return ctx._adminCanAdvance();
    }

    it('accepts a valid, matching, long-enough credential', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      assert.equal(withAdmin(ctx, 'admin', 'a-strong-passphrase-42'), true);
    });

    it('rejects a missing username', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      assert.equal(withAdmin(ctx, '', 'a-strong-passphrase-42'), false);
    });

    it('rejects a password under 12 characters', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      assert.equal(withAdmin(ctx, 'admin', 'short'), false);
    });

    it('rejects mismatched confirmation', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      assert.equal(withAdmin(ctx, 'admin', 'a-strong-passphrase-42', 'different-passphrase!'), false);
    });

    it('rejects a password containing the username', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      assert.equal(withAdmin(ctx, 'jason', 'jasons-long-password'), false);
    });
  });

  describe('completion payload', () => {
    it('includes adminUser + adminPassword in caddy mode', async () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' }, apiMutate: async () => ({ ok: true }) });
      ctx.wizard.adminUser = 'admin';
      ctx.wizard.adminPassword = 'a-strong-passphrase-42';
      await ctx.wizardComplete();
      const call = ctx.__apiCalls.find((c) => c.url === '/api/setup/complete');
      assert.ok(call, 'setup/complete was called');
      assert.equal(call.body.adminUser, 'admin');
      assert.equal(call.body.adminPassword, 'a-strong-passphrase-42');
    });

    it('omits admin fields in direct mode', async () => {
      const ctx = loadSetup({ config: { ingressMode: 'direct' }, apiMutate: async () => ({ ok: true }) });
      ctx.wizard.adminUser = 'admin';
      ctx.wizard.adminPassword = 'a-strong-passphrase-42';
      await ctx.wizardComplete();
      const call = ctx.__apiCalls.find((c) => c.url === '/api/setup/complete');
      assert.ok(call);
      assert.equal('adminUser' in call.body, false);
      assert.equal('adminPassword' in call.body, false);
    });
  });
});
