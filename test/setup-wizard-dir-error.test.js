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
function loadSetup(lastError, protectedRoots) {
  const elements = new Map();
  const sandbox = {
    console, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    Promise, Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, Error,
    esc: (str) => (typeof str !== 'string' ? '' : str),
    apiMutate: async () => null,
    api: Object.assign(async () => null, { lastError }),
    loadConfig: async () => {}, loadProjects: async () => {}, loadStats: async () => {},
    loadPorts: async () => {}, maybeShowFilter: () => {}, startPolling: () => {},
    state: {
      engines: [],
      config: { setupComplete: false, protectedRoots: protectedRoots || [] }
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
  vm.runInContext(SETUP_JS_SRC, sandbox);
  return sandbox;
}

describe('Setup wizard — projects-directory errors (#859)', () => {
  // Verbatim what the server sends for this failure (`_scanFailureHint` in
  // lib/projects.js, composed into the SCAN_FAILED error). A stand-in, not an
  // assertion target — these tests pin that the wizard shows whatever the
  // server said. Kept in sync so the fixture stays a real example.
  const PROTECTED_DIR_MESSAGE = 'Could not read ~/Documents/Projects — the directory did not '
    + 'respond. On macOS that is what a protected folder does when node has no Full Disk '
    + 'Access. Grant it, or choose a projects directory outside ~/Documents, ~/Desktop and '
    + '~/Downloads';

  it('shows what the server said, not a generic not-found line', async () => {
    const ctx = loadSetup(PROTECTED_DIR_MESSAGE);
    ctx.document.getElementById('setupProjectsDir').value = '~/Documents/Projects';

    await ctx.wizardValidateDir();

    const err = ctx.document.getElementById('setupDirError');
    assert.equal(err.textContent, PROTECTED_DIR_MESSAGE);
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

  describe('the caution that arrives before the choice, not after it', () => {
    const MAC_ROOTS = ['~/Documents', '/Users/dev/Documents', '~/Desktop', '/Users/dev/Desktop'];

    it('warns about the pre-filled default before the operator presses Next', async () => {
      // The wizard PRE-FILLS ~/Documents/Projects, so on a stock Mac the product
      // recommends the one directory it may not be able to read. The scan is the
      // only thing that can prove it either way, but the cheapest fix — type
      // somewhere else — is available only while the operator is still looking
      // at the field.
      const ctx = loadSetup(null, MAC_ROOTS);
      ctx.wizard.projectsDir = '~/Documents/Projects';
      ctx.document.getElementById('setupProjectsDir').value = '~/Documents/Projects';
      ctx.renderProjectsDir(ctx.document.getElementById('setupBody'));

      const advice = ctx.document.getElementById('setupDirProtected');
      assert.equal(advice.classList.contains('hidden'), false, 'the caution must be visible');
      assert.match(advice.innerHTML, /Full Disk Access/);
      assert.match(advice.innerHTML, /~\/Documents/, 'must name the folder it is about');
    });

    it('follows what the operator types, not just what was pre-filled', async () => {
      const ctx = loadSetup(null, MAC_ROOTS);
      ctx.wizard.projectsDir = '~/Documents/Projects';
      ctx.document.getElementById('setupProjectsDir').value = '~/Documents/Projects';
      ctx.renderProjectsDir(ctx.document.getElementById('setupBody'));

      ctx.document.getElementById('setupProjectsDir').value = '~/code';
      ctx.wizardUpdateDirAdvice();
      const advice = ctx.document.getElementById('setupDirProtected');
      assert.equal(advice.classList.contains('hidden'), true,
        'moving out of the protected tree must clear the caution');

      ctx.document.getElementById('setupProjectsDir').value = '/Users/dev/Desktop/work';
      ctx.wizardUpdateDirAdvice();
      assert.equal(advice.classList.contains('hidden'), false,
        'the absolute form of a protected root must match too');
    });

    it('says nothing on a host with no protected directories', async () => {
      // The server sends an empty list off macOS. `~/Documents` means nothing on
      // Linux, and a caution that fires where it does not apply is one people
      // learn to ignore everywhere.
      const ctx = loadSetup(null, []);
      ctx.wizard.projectsDir = '~/Documents/Projects';
      ctx.document.getElementById('setupProjectsDir').value = '~/Documents/Projects';
      ctx.renderProjectsDir(ctx.document.getElementById('setupBody'));

      assert.equal(ctx.document.getElementById('setupDirProtected').classList.contains('hidden'),
        true, 'a Linux install must not be warned about a macOS rule');
    });

    it('matches the folder however the operator capitalised it', async () => {
      // macOS is case-insensitive by default, so ~/documents/Projects IS
      // ~/Documents/Projects — the same protected directory, and the operator
      // who types it in lower case would have been the one person the caution
      // skipped.
      const ctx = loadSetup(null, MAC_ROOTS);
      ctx.wizard.projectsDir = '~/documents/projects';
      ctx.document.getElementById('setupProjectsDir').value = '~/documents/projects';
      ctx.renderProjectsDir(ctx.document.getElementById('setupBody'));

      const advice = ctx.document.getElementById('setupDirProtected');
      assert.equal(advice.classList.contains('hidden'), false);
      assert.match(advice.innerHTML, /~\/Documents/,
        'and it names the folder the way the system spells it, not the way it was typed');
    });

    it('does not mistake a lookalike sibling for a protected folder', async () => {
      // `~/Documents-old` starts with `~/Documents` as a string but is a
      // different directory, and TCC does not protect it.
      const ctx = loadSetup(null, MAC_ROOTS);
      ctx.wizard.projectsDir = '~/Documents-old/Projects';
      ctx.document.getElementById('setupProjectsDir').value = '~/Documents-old/Projects';
      ctx.renderProjectsDir(ctx.document.getElementById('setupBody'));

      assert.equal(ctx.document.getElementById('setupDirProtected').classList.contains('hidden'),
        true, 'prefix matching must respect path boundaries');
    });
  });

  describe('the missing folder the operator can fix from here', () => {
    it('offers to create a directory that simply is not there', async () => {
      // The pre-filled ~/Documents/Projects does not exist on a stock Mac —
      // macOS makes Documents, nothing makes Projects — so this is the first
      // thing a brand-new install hits. Saying "does not exist" and stopping is
      // accurate and useless.
      const ctx = loadSetup('Directory does not exist: ~/Documents/Projects');
      ctx.api.lastErrorCode = 'DIR_MISSING';
      ctx.document.getElementById('setupProjectsDir').value = '~/Documents/Projects';

      await ctx.wizardValidateDir();

      const offer = ctx.document.getElementById('setupDirCreate');
      assert.equal(offer.classList.contains('hidden'), false, 'the way out must be on screen');
      assert.match(offer.innerHTML, /wizardCreateDir\(\)/);
      assert.match(offer.innerHTML, /~\/Documents\/Projects/, 'and name what it will create');
    });

    it('does NOT offer to create a directory that exists but cannot be read', async () => {
      // The TCC case. The folder is right there; creating it is not the fix and
      // the button would do nothing but confuse. Full Disk Access is the fix,
      // and the message already says so.
      const ctx = loadSetup(PROTECTED_DIR_MESSAGE);
      ctx.api.lastErrorCode = 'SCAN_FAILED';
      ctx.document.getElementById('setupProjectsDir').value = '~/Documents/Projects';

      await ctx.wizardValidateDir();

      assert.equal(ctx.document.getElementById('setupDirCreate').classList.contains('hidden'),
        true, 'a present-but-unreadable folder must not be offered a Create button');
    });
  });

  it('clears a stale error and offer when the operator types a different path', async () => {
    // The verdict belonged to the OLD path. Left on screen it offers to create
    // a folder nobody is asking about, under an error that is no longer true.
    const ctx = loadSetup('Directory does not exist: ~/Documents/Projects');
    ctx.api.lastErrorCode = 'DIR_MISSING';
    ctx.document.getElementById('setupProjectsDir').value = '~/Documents/Projects';
    await ctx.wizardValidateDir();
    assert.equal(ctx.document.getElementById('setupDirCreate').classList.contains('hidden'), false);

    ctx.document.getElementById('setupProjectsDir').value = '~/somewhere-else';
    ctx.wizardUpdateDirAdvice();

    assert.equal(ctx.document.getElementById('setupDirError').classList.contains('hidden'), true,
      'the old error must not describe the new path');
    assert.equal(ctx.document.getElementById('setupDirCreate').classList.contains('hidden'), true,
      'and neither must the old offer');
  });

  it('still asks for a path before calling the server at all', async () => {
    const ctx = loadSetup(PROTECTED_DIR_MESSAGE);
    ctx.document.getElementById('setupProjectsDir').value = '   ';

    await ctx.wizardValidateDir();

    const err = ctx.document.getElementById('setupDirError');
    assert.equal(err.textContent, 'Please enter a directory path.',
      'an empty box is the operator\'s own error and must not be reported as the server\'s');
  });
});
