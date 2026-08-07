'use strict';

/*
 * Frontend test for the wizard's projects-directory error line (#859).
 *
 * The defect this pins: the step-2 handler threw the server's message away and
 * printed "Directory not found or not accessible." for every failure. That
 * sentence is right for a typo and wrong for the failure that actually strands
 * people — a directory under ~/Documents that exists, that the operator can
 * open in Finder, and that a launchd-spawned node cannot read without Full Disk
 * Access. Told it was "not found", the operator goes and fixes a path that has
 * nothing wrong with it. The server now names the real remedy, so the wizard
 * has to show it.
 *
 * Same vm-plus-DOM-stub approach as setup-wizard-engines.test.js — setup.js is
 * a plain <script> file, not a module.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SETUP_JS_PATH = path.join(__dirname, '..', 'public', 'setup.js');
const RAW_SRC = fs.readFileSync(SETUP_JS_PATH, 'utf8');
const SETUP_JS_SRC = RAW_SRC.replace(/^const wizard = /m, 'var wizard = ')
  + '\n;globalThis.wizard = wizard;\n';

/** Minimal element stub covering what the directory step touches. */
function makeElement(id) {
  const classSet = new Set(['hidden']);
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
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
 * Load setup.js with a scan that fails, carrying `lastError` as the real
 * `api()` helper does (it returns null and parks the server's message on the
 * function object — see public/api-helper.js).
 * @param {string|null} lastError - What the server said, or null for none.
 * @returns {object} sandbox
 */
function loadSetup(lastError) {
  const elements = new Map();
  const sandbox = {
    console, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    Promise, Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, Error,
    esc: (str) => (typeof str !== 'string' ? '' : str),
    apiMutate: async () => null,
    api: Object.assign(async () => null, { lastError }),
    loadConfig: async () => {}, loadProjects: async () => {}, loadStats: async () => {},
    loadPorts: async () => {}, maybeShowFilter: () => {}, startPolling: () => {},
    state: { engines: [], config: { setupComplete: false } },
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
  vm.runInContext(SETUP_JS_SRC, sandbox);
  return sandbox;
}

describe('Setup wizard — projects-directory errors (#859)', () => {
  const TCC_MESSAGE = 'Could not read ~/Documents/Projects — the directory did not respond; on '
    + 'macOS this is what a TCC-protected path does when node has no Full Disk Access — grant '
    + 'it, or choose a projects directory outside ~/Documents, ~/Desktop and ~/Downloads';

  it('shows what the server said, not a generic not-found line', async () => {
    const ctx = loadSetup(TCC_MESSAGE);
    ctx.document.getElementById('setupProjectsDir').value = '~/Documents/Projects';

    await ctx.wizardValidateDir();

    const err = ctx.document.getElementById('setupDirError');
    assert.equal(err.textContent, TCC_MESSAGE);
    assert.match(err.textContent, /Full Disk Access/,
      'the remedy must reach the screen, not just the server log');
    assert.equal(err.classList.contains('hidden'), false, 'the error must be visible');
  });

  it('falls back to the generic line when the server said nothing usable', async () => {
    // A network-level failure leaves no server message. Something must still
    // appear, or the Next button looks broken.
    const ctx = loadSetup(null);
    ctx.document.getElementById('setupProjectsDir').value = '/some/where';

    await ctx.wizardValidateDir();

    const err = ctx.document.getElementById('setupDirError');
    assert.equal(err.textContent, 'Directory not found or not accessible.');
    assert.equal(err.classList.contains('hidden'), false);
  });

  it('still asks for a path before calling the server at all', async () => {
    const ctx = loadSetup(TCC_MESSAGE);
    ctx.document.getElementById('setupProjectsDir').value = '   ';

    await ctx.wizardValidateDir();

    const err = ctx.document.getElementById('setupDirError');
    assert.equal(err.textContent, 'Please enter a directory path.',
      'an empty box is the operator\'s own error and must not be reported as the server\'s');
  });
});
