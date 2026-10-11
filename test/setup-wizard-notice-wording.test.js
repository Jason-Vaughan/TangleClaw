'use strict';

/*
 * Frontend tests for the sentence that heads the server's notices on the
 * wizard's confirm step (#2284).
 *
 * `POST /api/setup/complete` answers a list of notices. Some are skipped
 * projects; others are not: the Master's launch mode was reset, a project
 * failed to attach, the ingress was left alone, a credential was saved but not
 * enforced. The heading used to say every one of them "were skipped", which
 * told an operator whose launch mode had just been reset that nothing had
 * happened to it. So the heading counts the notices and claims nothing about
 * their kind; each notice says what happened in its own words.
 *
 * Same vm-plus-DOM-stub approach as setup-wizard-login-gate.test.js: setup.js
 * is a plain <script> file, not a module.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LANDING_JSARG_SRC } = require('./_page-globals');

const SETUP_JS_PATH = path.join(__dirname, '..', 'public', 'setup.js');
const RAW_SRC = fs.readFileSync(SETUP_JS_PATH, 'utf8');
const SETUP_JS_SRC = RAW_SRC.replace(/^const wizard = /m, 'var wizard = ')
  + '\n;globalThis.wizard = wizard;\n';

// Notices shaped like the ones the route answers (server.js, lib/master.js).
const RESET = 'The Master\'s launch mode is reset to Default. Full auto was chosen for Codex '
  + 'and does not carry to Claude Code. Choose a launch mode for Claude Code if you want one.';
const SKIPPED = 'Skipped "old-project": path does not exist or is not a directory';
const ALREADY = 'Project "site" already registered at /Users/x/site, skipped';
const ATTACH_FAILED = 'Failed to attach "api": EACCES: permission denied';
const INGRESS_REASON = 'Caddy is not installed, so TangleClaw cannot put a login in front of itself yet.';
const CREDENTIAL_SAVED = 'Admin credential saved, but TangleClaw did not change the live ingress '
  + 'because another site already answers on that address.';

/**
 * The part of the sentence before the notices themselves.
 * @param {string} sentence - What the wizard wrote.
 * @param {string} firstNotice - The first notice in it.
 * @returns {string}
 */
function headingOf(sentence, firstNotice) {
  const at = sentence.indexOf(firstNotice);
  assert.notEqual(at, -1, 'the first notice is in the sentence');
  return sentence.slice(0, at);
}

/**
 * Minimal element stub. `#setupCompleteError` starts hidden, as the confirm
 * step renders it.
 * @param {string} id
 * @returns {object}
 */
function makeElement(id) {
  const classSet = new Set(id === 'setupCompleteError' ? ['hidden'] : []);
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
 * Load setup.js in a sandbox whose `POST /api/setup/complete` answers `warnings`.
 * @param {*} warnings - What the response carries as `warnings`.
 * @returns {object} The sandbox.
 */
function loadSetup(warnings) {
  const elements = new Map();
  const sandbox = {
    console,
    setTimeout: (fn) => { Promise.resolve().then(fn); return 0; },
    clearTimeout() {},
    Promise, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, Error, Date,
    esc: (str) => (typeof str !== 'string' ? '' : str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')),
    apiMutate: async () => ({ ok: true, setupComplete: true, attached: [], warnings, restart: false }),
    api: Object.assign(async () => null, { lastError: null, lastErrorCode: null }),
    loadConfig: async () => {}, loadProjects: async () => ({}), loadStats: async () => {},
    loadPorts: async () => {}, maybeShowFilter: () => {}, startPolling: () => {},
    state: {
      engines: [{ id: 'claude', name: 'Claude Code', available: true }],
      config: { setupComplete: false }
    },
    fetch: async (url) => {
      if (String(url).includes('/api/setup/ingress-state')) {
        return {
          ok: true,
          json: async () => ({
            plan: { action: 'refuse', reason: INGRESS_REASON, remedy: null },
            credential: { required: true, optOutAllowed: true, optOutRefusal: null, skipAllowed: false }
          })
        };
      }
      return { ok: true, json: async () => ({}) };
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
  sandbox.location = { origin: 'http://localhost:3102', href: null, replace() {} };
  vm.createContext(sandbox);
  // landing.js's `jsArg` is a page global setup.js calls (#1902).
  vm.runInContext(LANDING_JSARG_SRC, sandbox);
  vm.runInContext(SETUP_JS_SRC, sandbox);
  return sandbox;
}

/** Let queued microtasks run to completion. */
async function settle(rounds = 200) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * Finish the wizard against a response carrying `warnings`, and return the
 * element the confirm step reports them in.
 * @param {*} warnings
 * @returns {Promise<object>} The `#setupCompleteError` stub.
 */
async function finishWith(warnings) {
  const ctx = loadSetup(warnings);
  ctx.showWizard();
  await settle();
  ctx.dismissWizard = () => {};
  await ctx.wizardComplete();
  await settle();
  return ctx.document.getElementById('setupCompleteError');
}

describe('Setup wizard: the confirm step heads the server\'s notices without calling them skipped (#2284)', () => {
  it('does not tell an operator whose launch mode was reset that an item was skipped', async () => {
    const el = await finishWith([RESET]);
    assert.equal(el.classList.contains('hidden'), false, 'the notice is shown');
    assert.doesNotMatch(el.textContent, /skipped/i);
    assert.ok(el.textContent.endsWith(RESET), 'the notice\'s own text is unchanged');
    assert.equal(headingOf(el.textContent, RESET), 'Setup finished. One thing to know: ');
  });

  it('still says a skipped project was skipped, in the notice\'s own words', async () => {
    const el = await finishWith([SKIPPED]);
    assert.ok(el.textContent.endsWith(SKIPPED));
    assert.doesNotMatch(headingOf(el.textContent, SKIPPED), /skipped/i);
  });

  it('counts a reset and a skipped item together and keeps the server\'s order', async () => {
    const el = await finishWith([RESET, SKIPPED]);
    const heading = headingOf(el.textContent, RESET);
    assert.equal(heading, 'Setup finished. 2 things to know: ');
    assert.doesNotMatch(heading, /skipped/i);
    assert.ok(el.textContent.indexOf(RESET) < el.textContent.indexOf(SKIPPED));
    assert.equal(el.textContent, `${heading}${RESET}; ${SKIPPED}`);
  });

  it('heads none of the route\'s other notices as skipped', async () => {
    for (const notice of [ALREADY, ATTACH_FAILED, INGRESS_REASON, CREDENTIAL_SAVED]) {
      const el = await finishWith([notice]);
      assert.ok(el.textContent.endsWith(notice), `kept: ${notice}`);
      assert.doesNotMatch(headingOf(el.textContent, notice), /skipped/i, `heading for: ${notice}`);
    }
  });

  it('writes nothing and stays hidden when there is nothing to report', async () => {
    for (const warnings of [[], undefined, null, 'Skipped "x"', { length: 1, 0: SKIPPED }, ['', null, 7]]) {
      const el = await finishWith(warnings);
      assert.equal(el.textContent, '', `nothing written for ${JSON.stringify(warnings)}`);
      assert.equal(el.classList.contains('hidden'), true, `still hidden for ${JSON.stringify(warnings)}`);
    }
  });

  it('counts only the notices it shows', async () => {
    const el = await finishWith([RESET, '', null, SKIPPED]);
    assert.equal(el.textContent, `Setup finished. 2 things to know: ${RESET}; ${SKIPPED}`);
  });

  it('sets a notice as text, never as markup', async () => {
    const hostile = 'Failed to attach "<img src=x onerror=alert(1)>": no such directory';
    const el = await finishWith([hostile]);
    assert.ok(el.textContent.endsWith(hostile), 'the characters arrive as written');
    assert.equal(el.innerHTML, '', 'nothing is parsed as markup');
  });

  it('words the sentence in one function the page calls', () => {
    const ctx = loadSetup([]);
    assert.equal(ctx._noticesSentence([RESET]), `Setup finished. One thing to know: ${RESET}`);
    assert.equal(ctx._noticesSentence([]), '');
    assert.equal(ctx._noticesSentence(undefined), '');
  });

  it('no longer carries the sentence that called every notice skipped', () => {
    assert.doesNotMatch(RAW_SRC, /were skipped/);
    assert.doesNotMatch(RAW_SRC, /Surface anything the server skipped/);
  });

  it('leaves the later screens\' heading for the same list as it was', () => {
    const ctx = loadSetup([]);
    assert.equal(ctx._warningsBlock([SKIPPED]),
      '<div class="form-error" role="status"><strong>Also worth knowing:</strong><ul>'
      + '<li>Skipped &quot;old-project&quot;: path does not exist or is not a directory</li></ul></div>');
  });
});
