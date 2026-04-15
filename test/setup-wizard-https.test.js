'use strict';

/*
 * Frontend tests for the HTTPS step added to public/setup.js in chunk 2 of
 * issue #61. The wizard script is a plain <script>-loaded file, so we load
 * it into a `vm` context with a minimal DOM stub instead of pulling in a
 * full browser environment.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SETUP_JS_PATH = path.join(__dirname, '..', 'public', 'setup.js');
const RAW_SRC = fs.readFileSync(SETUP_JS_PATH, 'utf8');
// Top-level `const`/`let` declarations don't get attached to a vm context's
// global object the way `var` does, so we can't read `wizard` from the
// sandbox after running the script. Rewrite the one top-level binding we
// need to introspect and append an export so the tests can reach it.
const SETUP_JS_SRC = RAW_SRC.replace(/^const wizard = /m, 'var wizard = ')
  + '\n;globalThis.wizard = wizard;\n';

/**
 * Create a minimal element stub that mirrors the handful of DOM APIs the
 * wizard touches (innerHTML, value, disabled, classList, addEventListener).
 * @param {string} id
 */
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
      contains: (c) => classSet.has(c),
      toggle: (c) => { if (classSet.has(c)) classSet.delete(c); else classSet.add(c); },
      _set: classSet
    },
    focus() {},
    addEventListener() {},
    dispatchEvent() {}
  };
}

/**
 * Load public/setup.js into a sandbox with stubbed browser globals.
 * @param {object} [overrides] - Optional overrides/mocks for globals.
 * @returns {object} The sandbox context (each wizard function is a property on it).
 */
function loadSetup(overrides = {}) {
  const elements = new Map();
  const navigations = [];
  const fetchCalls = [];
  const apiCalls = [];

  const sandbox = {
    console,
    setTimeout: (fn, _ms) => { fn(); return 0; },
    clearTimeout() {},
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    String,
    Number,
    Boolean,
    Error,

    // Globals defined in landing.js / ui.js that setup.js calls.
    esc: (str) => {
      if (typeof str !== 'string') return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    apiMutate: async (url, method, body) => {
      apiCalls.push({ url, method, body });
      if (overrides.apiMutate) return overrides.apiMutate(url, method, body);
      return null;
    },
    // Minimal api() stub — wizard handlers read api.lastError for the
    // #80 server-error surfacing; tests can override via overrides.api.
    api: Object.assign(
      overrides.api || (async () => null),
      { lastError: null, lastErrorCode: null }
    ),
    loadConfig: async () => {},
    loadProjects: async () => {},
    loadStats: async () => {},
    loadPorts: async () => {},
    maybeShowFilter: () => {},
    startPolling: () => {},
    dismissWizard: overrides.dismissWizard || (() => {}),
    state: {
      engines: [],
      methodologies: [],
      config: { setupComplete: false }
    },

    fetch: overrides.fetch || (async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true };
    })
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
  sandbox.location = {
    get href() { return null; },
    set href(v) { navigations.push(v); }
  };

  vm.createContext(sandbox);
  vm.runInContext(SETUP_JS_SRC, sandbox);

  // setup.js declares its own `function dismissWizard()`, which overwrites the
  // sandbox property during runInContext. Re-apply test overrides afterwards
  // so calls made from wizard code pick up the test stub.
  if (overrides.dismissWizard) sandbox.dismissWizard = overrides.dismissWizard;

  sandbox.__elements = elements;
  sandbox.__navigations = navigations;
  sandbox.__fetchCalls = fetchCalls;
  sandbox.__apiCalls = apiCalls;
  return sandbox;
}

describe('Setup wizard — HTTPS step (frontend)', () => {
  describe('wizard structure', () => {
    it('has seven total steps after HTTPS insertion', () => {
      const ctx = loadSetup();
      assert.equal(ctx.wizard.totalSteps, 7);
    });

    it('initializes HTTPS state as unconfigured', () => {
      const ctx = loadSetup();
      assert.equal(ctx.wizard.httpsCheckLoaded, false);
      assert.equal(ctx.wizard.httpsMode, null);
      assert.equal(ctx.wizard.httpsGenerated, null);
      assert.equal(ctx.wizard.httpsRemoteTrustConfirmed, false);
    });
  });

  describe('_httpsCanAdvance', () => {
    it('allows advance on skip mode immediately', () => {
      const ctx = loadSetup();
      ctx.wizard.httpsMode = 'skip';
      assert.equal(ctx._httpsCanAdvance(), true);
    });

    it('blocks mkcert advance until cert generated and remote trust confirmed', () => {
      const ctx = loadSetup();
      ctx.wizard.httpsMode = 'mkcert';
      assert.equal(ctx._httpsCanAdvance(), false);
      ctx.wizard.httpsGenerated = { certPath: '/a', keyPath: '/b' };
      ctx.wizard.httpsCertPath = '/a';
      ctx.wizard.httpsKeyPath = '/b';
      assert.equal(ctx._httpsCanAdvance(), false, 'still blocks without trust confirm');
      ctx.wizard.httpsRemoteTrustConfirmed = true;
      assert.equal(ctx._httpsCanAdvance(), true);
    });

    it('requires both paths in manual mode', () => {
      const ctx = loadSetup();
      ctx.wizard.httpsMode = 'manual';
      assert.equal(ctx._httpsCanAdvance(), false);
      ctx.wizard.httpsCertPath = '/etc/cert.pem';
      assert.equal(ctx._httpsCanAdvance(), false);
      ctx.wizard.httpsKeyPath = '/etc/key.pem';
      assert.equal(ctx._httpsCanAdvance(), true);
    });
  });

  describe('_buildHttpsPayload', () => {
    it('returns enabled + paths for mkcert mode', () => {
      const ctx = loadSetup();
      ctx.wizard.httpsMode = 'mkcert';
      ctx.wizard.httpsCertPath = '/root/.tangleclaw/certs/cert.pem';
      ctx.wizard.httpsKeyPath = '/root/.tangleclaw/certs/key.pem';
      assert.deepEqual(JSON.parse(JSON.stringify(ctx._buildHttpsPayload())), {
        httpsEnabled: true,
        httpsCertPath: '/root/.tangleclaw/certs/cert.pem',
        httpsKeyPath: '/root/.tangleclaw/certs/key.pem'
      });
    });

    it('returns enabled + paths for manual mode', () => {
      const ctx = loadSetup();
      ctx.wizard.httpsMode = 'manual';
      ctx.wizard.httpsCertPath = '/etc/ssl/mysite.pem';
      ctx.wizard.httpsKeyPath = '/etc/ssl/mysite-key.pem';
      assert.deepEqual(JSON.parse(JSON.stringify(ctx._buildHttpsPayload())), {
        httpsEnabled: true,
        httpsCertPath: '/etc/ssl/mysite.pem',
        httpsKeyPath: '/etc/ssl/mysite-key.pem'
      });
    });

    it('returns disabled + null paths for skip mode', () => {
      const ctx = loadSetup();
      ctx.wizard.httpsMode = 'skip';
      ctx.wizard.httpsCertPath = '/stale';
      ctx.wizard.httpsKeyPath = '/stale';
      assert.deepEqual(JSON.parse(JSON.stringify(ctx._buildHttpsPayload())), {
        httpsEnabled: false,
        httpsCertPath: null,
        httpsKeyPath: null
      });
    });

    it('returns disabled payload when no mode chosen', () => {
      const ctx = loadSetup();
      assert.deepEqual(JSON.parse(JSON.stringify(ctx._buildHttpsPayload())), {
        httpsEnabled: false,
        httpsCertPath: null,
        httpsKeyPath: null
      });
    });
  });

  describe('_httpsSummaryLabel', () => {
    it('labels each mode correctly in the confirm summary', () => {
      const ctx = loadSetup();
      ctx.wizard.httpsMode = 'mkcert';
      assert.equal(ctx._httpsSummaryLabel(), 'Enabled (mkcert)');
      ctx.wizard.httpsMode = 'manual';
      assert.equal(ctx._httpsSummaryLabel(), 'Enabled (manual)');
      ctx.wizard.httpsMode = 'skip';
      assert.equal(ctx._httpsSummaryLabel(), 'Disabled');
      ctx.wizard.httpsMode = null;
      assert.equal(ctx._httpsSummaryLabel(), 'Not configured');
    });
  });

  describe('renderHttpsSetup', () => {
    it('calls https-check on first render and defaults to mkcert when available', async () => {
      const ctx = loadSetup({
        apiMutate: async (url) => {
          if (url === '/api/setup/https-check') {
            return {
              mkcert: { available: true, version: '1.4.4', carootPath: '/ca', caInstalled: true },
              certsDir: '/certs'
            };
          }
          return null;
        }
      });
      const body = ctx.document.getElementById('setupBody');
      await ctx.renderHttpsSetup(body);
      assert.equal(ctx.wizard.httpsCheckLoaded, true);
      assert.equal(ctx.wizard.mkcertAvailable, true);
      assert.equal(ctx.wizard.httpsMode, 'mkcert');
      assert.match(body.innerHTML, /mkcert detected/);
    });

    it('falls back to manual mode when mkcert is unavailable', async () => {
      const ctx = loadSetup({
        apiMutate: async () => ({ mkcert: { available: false }, certsDir: '/certs' })
      });
      const body = ctx.document.getElementById('setupBody');
      await ctx.renderHttpsSetup(body);
      assert.equal(ctx.wizard.httpsMode, 'manual');
      assert.match(body.innerHTML, /mkcert not installed/);
    });

    it('treats a failed https-check as mkcert-unavailable', async () => {
      const ctx = loadSetup({ apiMutate: async () => null });
      const body = ctx.document.getElementById('setupBody');
      await ctx.renderHttpsSetup(body);
      assert.equal(ctx.wizard.httpsCheckLoaded, true);
      assert.equal(ctx.wizard.mkcertAvailable, false);
      assert.equal(ctx.wizard.httpsMode, 'manual');
    });
  });

  describe('wizardSelectHttpsMode', () => {
    it('clears stale cert state when switching modes', () => {
      const ctx = loadSetup();
      ctx.wizard.httpsCheckLoaded = true;
      ctx.wizard.httpsMode = 'mkcert';
      ctx.wizard.httpsGenerated = { certPath: '/certs/cert.pem', keyPath: '/certs/key.pem' };
      ctx.wizard.httpsCertPath = '/certs/cert.pem';
      ctx.wizard.httpsKeyPath = '/certs/key.pem';
      ctx.wizard.httpsRemoteTrustConfirmed = true;

      ctx.wizardSelectHttpsMode('manual');

      assert.equal(ctx.wizard.httpsMode, 'manual');
      assert.equal(ctx.wizard.httpsGenerated, null);
      assert.equal(ctx.wizard.httpsCertPath, '');
      assert.equal(ctx.wizard.httpsKeyPath, '');
      assert.equal(ctx.wizard.httpsRemoteTrustConfirmed, false);
    });
  });

  describe('wizardGenerateCerts', () => {
    it('stores generated data and paths on success', async () => {
      const ctx = loadSetup({
        apiMutate: async (url) => {
          if (url === '/api/setup/generate-cert') {
            return {
              ok: true,
              certPath: '/certs/cert.pem',
              keyPath: '/certs/key.pem',
              hosts: ['localhost'],
              expiry: '2027-01-01T00:00:00Z',
              remoteTrust: { caRootPath: '/ca', rootCaPath: '/ca/rootCA.pem', steps: [], note: 'n' }
            };
          }
          return null;
        }
      });
      ctx.wizard.httpsMode = 'mkcert';
      ctx.wizard.httpsCheckLoaded = true;
      await ctx.wizardGenerateCerts();
      assert.equal(ctx.wizard.httpsCertPath, '/certs/cert.pem');
      assert.equal(ctx.wizard.httpsKeyPath, '/certs/key.pem');
      assert.ok(ctx.wizard.httpsGenerated);
      assert.equal(ctx.wizard.httpsGenerated.expiry, '2027-01-01T00:00:00Z');
    });

    it('surfaces an error and preserves state on failure', async () => {
      const ctx = loadSetup({ apiMutate: async () => null });
      ctx.wizard.httpsMode = 'mkcert';
      ctx.wizard.httpsCheckLoaded = true;
      await ctx.wizardGenerateCerts();
      assert.equal(ctx.wizard.httpsGenerated, null);
      assert.equal(ctx.wizard.httpsCertPath, '');
    });

    it('renders api.lastError in #setupHttpsError when server surfaces a message (#80)', async () => {
      const ctx = loadSetup({ apiMutate: async () => null });
      // Simulate what the real api() helper does on 4xx — populates its
      // side-channel with the server's error string.
      ctx.api.lastError = 'mkcert binary not found on PATH';
      ctx.wizard.httpsMode = 'mkcert';
      ctx.wizard.httpsCheckLoaded = true;
      await ctx.wizardGenerateCerts();
      const errEl = ctx.__elements.get('setupHttpsError');
      assert.ok(errEl, 'setupHttpsError element should have been touched');
      assert.equal(errEl.textContent, 'mkcert binary not found on PATH');
      assert.equal(errEl.classList.contains('hidden'), false);
    });

    it('falls back to generic message when api.lastError is empty (#80)', async () => {
      const ctx = loadSetup({ apiMutate: async () => null });
      ctx.api.lastError = null;
      ctx.wizard.httpsMode = 'mkcert';
      ctx.wizard.httpsCheckLoaded = true;
      await ctx.wizardGenerateCerts();
      const errEl = ctx.__elements.get('setupHttpsError');
      assert.equal(errEl.textContent, 'Certificate generation failed.');
    });
  });

  describe('wizardComplete', () => {
    it('includes HTTPS fields in the setup-complete payload', async () => {
      let dismissed = false;
      const ctx = loadSetup({
        apiMutate: async (url, _method, body) => {
          if (url === '/api/setup/complete') {
            return { ok: true, setupComplete: true, attached: [], warnings: [], restart: false, redirectUrl: null, __body: body };
          }
          return null;
        },
        dismissWizard: () => { dismissed = true; }
      });
      ctx.wizard.httpsMode = 'mkcert';
      ctx.wizard.httpsCertPath = '/certs/cert.pem';
      ctx.wizard.httpsKeyPath = '/certs/key.pem';
      ctx.wizard.defaultEngine = 'claude';
      ctx.wizard.defaultMethodology = 'minimal';
      ctx.wizard.projectsDir = '/proj';
      await ctx.wizardComplete();
      const call = ctx.__apiCalls.find((c) => c.url === '/api/setup/complete');
      assert.ok(call, 'setup-complete call made');
      assert.equal(call.body.httpsEnabled, true);
      assert.equal(call.body.httpsCertPath, '/certs/cert.pem');
      assert.equal(call.body.httpsKeyPath, '/certs/key.pem');
      assert.equal(dismissed, true);
    });

    it('shows restart overlay and skips normal dismiss when server schedules a restart', async () => {
      let dismissed = false;
      const ctx = loadSetup({
        apiMutate: async (url) => {
          if (url === '/api/setup/complete') {
            return { ok: true, setupComplete: true, attached: [], warnings: [], restart: true, redirectUrl: 'https://localhost:3102' };
          }
          return null;
        },
        fetch: async () => ({ ok: true }),
        dismissWizard: () => { dismissed = true; }
      });
      ctx.wizard.httpsMode = 'mkcert';
      ctx.wizard.httpsCertPath = '/certs/cert.pem';
      ctx.wizard.httpsKeyPath = '/certs/key.pem';
      await ctx.wizardComplete();
      const body = ctx.document.getElementById('setupBody');
      assert.match(body.innerHTML, /Restarting TangleClaw/);
      assert.match(body.innerHTML, /https:\/\/localhost:3102/);
      assert.equal(dismissed, false, 'does not run the normal dismiss flow');
    });

    it('still shows the restart overlay when redirectUrl is missing', async () => {
      let dismissed = false;
      const ctx = loadSetup({
        apiMutate: async (url) => {
          if (url === '/api/setup/complete') {
            return { ok: true, setupComplete: true, attached: [], warnings: [], restart: true, redirectUrl: null };
          }
          return null;
        },
        fetch: async () => ({ ok: true }),
        dismissWizard: () => { dismissed = true; }
      });
      ctx.location = { origin: 'http://localhost:3102', get href() { return null; }, set href(_v) {} };
      ctx.wizard.httpsMode = 'skip';
      await ctx.wizardComplete();
      const body = ctx.document.getElementById('setupBody');
      assert.match(body.innerHTML, /Restarting TangleClaw/);
      assert.equal(dismissed, false);
    });
  });

  describe('_pollRestartAndRedirect', () => {
    it('navigates to the redirect URL once the server responds', async () => {
      const ctx = loadSetup({ fetch: async () => ({ ok: true }) });
      await ctx._pollRestartAndRedirect('https://localhost:3102');
      assert.ok(ctx.__navigations.includes('https://localhost:3102'));
    });
  });
});
