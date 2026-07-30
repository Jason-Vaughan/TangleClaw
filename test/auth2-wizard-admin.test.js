'use strict';

// Frontend wizard admin step. public/setup.js is a plain <script>-loaded file,
// so (like setup-wizard-https.test.js) it's loaded into a `vm` context with a
// minimal DOM stub. These tests cover step insertion, the client-side password
// gate, and the completion payload.
//
// Step insertion is no longer keyed on `ingressMode === 'caddy'`. A login is the
// default outcome of setup, so the step appears whenever the SERVER says a gate
// can be provisioned here (GET /api/setup/ingress-state → `plan.action`) — which
// on a fresh install means direct mode. Keying it on config was how a fresh
// install finished with no login at all. The probe-driven behaviour and the
// provisioning outcome live in setup-wizard-login-gate.test.js; these cases pin
// the step list, the gate and the payload against the plan.

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

// What GET /api/setup/ingress-state answers with. `provision` is the default
// install's answer: nothing a human maintains is in the way, so TangleClaw puts
// a login up.
const PROVISION_PLAN = { action: 'provision', reason: '', remedy: null };
const REFUSE_PLAN = {
  action: 'refuse',
  reason: 'Caddy is not installed, so TangleClaw cannot put a login in front of itself yet.',
  remedy: 'Install Caddy, then run `node scripts/ingress-cutover.js --to caddy`.'
};

/**
 * Load public/setup.js into a sandbox.
 * @param {object} [opts]
 * @param {object} [opts.config] - state.config contents (e.g. { ingressMode: 'caddy' }).
 * @param {object} [opts.plan] - `plan` the ingress-state probe returns; defaults
 *   to PROVISION_PLAN. Tests that read the step list synchronously should also
 *   seed `wizard.ingressPlan`, since the probe is asynchronous.
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
    },
    // showWizard probes for the login plan. Answer it, so the probe neither
    // throws nor leaves the step list depending on a race.
    fetch: async (url) => {
      if (String(url).includes('/api/setup/ingress-state')) {
        return { ok: true, json: async () => ({ plan: opts.plan || PROVISION_PLAN }) };
      }
      throw new Error('unreachable');
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
    it('adds the admin step when a gate can be provisioned — including in direct mode', () => {
      // The flip. `ingressMode: 'direct'` used to mean "no admin step", which is
      // the state every fresh install is in, so no fresh install was ever asked
      // for a login.
      const ctx = loadSetup({ config: { ingressMode: 'direct' } });
      ctx.wizard.ingressPlan = PROVISION_PLAN;
      const keys = ctx.wizardStepKeys();
      assert.equal(keys.includes('admin'), true);
      assert.equal(keys.length, 8);
      // admin must sit immediately before the final confirm step.
      assert.equal(keys[keys.length - 2], 'admin');
      assert.equal(keys[keys.length - 1], 'confirm');
    });

    it('omits the admin step when no gate can be put up, even in caddy mode', () => {
      // Config is no longer the deciding fact in either direction: an install
      // already behind Caddy whose config must not be touched has to skip too,
      // or the wizard collects a credential nothing will enforce.
      const ctx = loadSetup({ config: { ingressMode: 'caddy' }, plan: REFUSE_PLAN });
      ctx.wizard.ingressPlan = REFUSE_PLAN;
      assert.equal(ctx.wizardStepKeys().includes('admin'), false);
      assert.equal(ctx.wizardStepKeys().length, 7);
    });

    it('hides the Skip button when a credential is mandatory', () => {
      const gated = loadSetup({ config: { ingressMode: 'direct' } });
      gated.wizard.ingressPlan = PROVISION_PLAN;
      gated._syncSkipButton();
      assert.equal(gated.document.getElementById('setupSkipBtn').style.display, 'none');

      const open = loadSetup({ plan: REFUSE_PLAN });
      open.wizard.ingressPlan = REFUSE_PLAN;
      open._syncSkipButton();
      assert.equal(open.document.getElementById('setupSkipBtn').style.display, '');
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

  describe('_adminRuleHint — first unmet rule, in gate order (AUTH-7P3M)', () => {
    it('names each rule with the exact operator-facing message', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      assert.equal(ctx._adminRuleHint('', '', ''), 'Enter a username.');
      assert.equal(ctx._adminRuleHint('admin', 'short', 'short'), 'Password must be at least 12 characters.');
      assert.equal(ctx._adminRuleHint('admin', 'a-strong-passphrase-42', 'different!'), 'Passwords do not match.');
      assert.equal(ctx._adminRuleHint('jason', 'jasons-long-password', 'jasons-long-password'), 'Password must not contain the username.');
      assert.equal(ctx._adminRuleHint('admin', 'a-strong-passphrase-42', 'a-strong-passphrase-42'), null);
    });

    it('reports the FIRST unmet rule when several fail (the elkaholic 11-char repro)', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      // Missing username outranks the short password.
      assert.equal(ctx._adminRuleHint('', 'short', 'other'), 'Enter a username.');
      // The 2026-06-26 repro: 11 chars, confirm untouched — length fires first,
      // so the operator sees the actual blocker instead of a generic mismatch.
      assert.equal(ctx._adminRuleHint('admin', 'elevenchars', ''), 'Password must be at least 12 characters.');
    });

    it('is the single source: _adminCanAdvance is true exactly when the hint is null', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      for (const [u, p, c] of [
        ['admin', 'a-strong-passphrase-42', 'a-strong-passphrase-42'],
        ['', 'a-strong-passphrase-42', 'a-strong-passphrase-42'],
        ['admin', 'short', 'short'],
        ['admin', 'a-strong-passphrase-42', 'nope'],
        ['jason', 'jasons-long-password', 'jasons-long-password']
      ]) {
        ctx.wizard.adminUser = u;
        ctx.wizard.adminPassword = p;
        ctx.wizard.adminPasswordConfirm = c;
        assert.equal(ctx._adminCanAdvance(), ctx._adminRuleHint(u, p, c) === null,
          `gate/hint disagree for ${JSON.stringify([u, p, c])}`);
      }
    });
  });

  describe('live hint rendering (AUTH-7P3M)', () => {
    it('stays hidden on a pristine step, shows the first unmet rule once the operator types', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      ctx.renderAdminSetup(ctx.document.getElementById('setupBody'));
      const hint = ctx.document.getElementById('setupAdminLiveHint');
      assert.equal(hint.classList.contains('hidden'), true, 'pristine step must not scold');

      ctx.wizard.adminUser = 'admin';
      ctx.wizard.adminPassword = 'elevenchars';
      ctx._updateAdminLiveHint();
      assert.equal(hint.classList.contains('hidden'), false);
      assert.equal(hint.textContent, 'Password must be at least 12 characters.');

      ctx.wizard.adminPassword = 'a-strong-passphrase-42';
      ctx.wizard.adminPasswordConfirm = 'a-strong-passphrase-42';
      ctx._updateAdminLiveHint();
      assert.equal(hint.classList.contains('hidden'), true, 'hint clears when all rules pass');
      assert.equal(hint.textContent, '');
    });

    it('wires the hint into the input sync path and the initial render (structural)', () => {
      const src = fs.readFileSync(SETUP_JS_PATH, 'utf8');
      const syncBlock = src.slice(src.indexOf('const sync = ()'), src.indexOf('function _updateAdminLiveHint'));
      assert.ok(syncBlock.includes('_updateAdminLiveHint()'), 'sync() must refresh the live hint on every input');
      assert.match(src, /setupAdminLiveHint/, 'render must include the live-hint element');
    });

    it('wizardAdminNext error path uses the same first-unmet-rule message', () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' } });
      ctx.document.getElementById('setupAdminUser').value = 'admin';
      ctx.document.getElementById('setupAdminPassword').value = 'elevenchars';
      ctx.document.getElementById('setupAdminPasswordConfirm').value = 'elevenchars';
      ctx.wizardAdminNext();
      const err = ctx.document.getElementById('setupAdminError');
      assert.equal(err.textContent, 'Password must be at least 12 characters.');
      assert.equal(err.classList.contains('hidden'), false);
    });
  });

  describe('completion payload', () => {
    // Sent under exactly the predicate that collected it. A payload keyed on a
    // different fact from the step list is how a wizard ends up either asking for
    // a password it never sends, or sending one it never asked for.
    it('includes adminUser + adminPassword when the admin step was shown', async () => {
      const ctx = loadSetup({ config: { ingressMode: 'direct' }, apiMutate: async () => ({ ok: true }) });
      ctx.wizard.ingressPlan = PROVISION_PLAN;
      ctx.wizard.adminUser = 'admin';
      ctx.wizard.adminPassword = 'a-strong-passphrase-42';
      await ctx.wizardComplete();
      const call = ctx.__apiCalls.find((c) => c.url === '/api/setup/complete');
      assert.ok(call, 'setup/complete was called');
      assert.equal(call.body.adminUser, 'admin');
      assert.equal(call.body.adminPassword, 'a-strong-passphrase-42');
    });

    it('omits admin fields when the step was skipped', async () => {
      const ctx = loadSetup({ config: { ingressMode: 'caddy' }, plan: REFUSE_PLAN,
        apiMutate: async () => ({ ok: true }) });
      ctx.wizard.ingressPlan = REFUSE_PLAN;
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
