'use strict';

/*
 * Frontend tests for the wizard's engine step (#707).
 *
 * The defect these pin: the availability list rendered "✓ Codex / ✗ Claude —
 * Not found" while the Default Engine dropdown immediately below it offered
 * every engine and pre-selected Claude, because `renderEngines` built its
 * options from the full list and `showWizard` seeded `defaultEngine` to the
 * shipped 'claude' unconditionally. A Codex-only operator finished setup with a
 * default naming a binary they did not have, and only found out later when the
 * Project Master refused to launch.
 *
 * Same vm-plus-DOM-stub approach as setup-wizard-https.test.js — setup.js is a
 * plain <script> file, not a module.
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

const CLAUDE = { id: 'claude', name: 'Claude Code' };
const CODEX = { id: 'codex', name: 'Codex CLI' };
const AIDER = { id: 'aider', name: 'Aider' };

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
 * Load setup.js with a given engine roster and config.
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

describe('Setup wizard — engine step (#707)', () => {
  describe('the Codex-only machine: config default is an uninstalled engine', () => {
    const roster = [
      { ...CLAUDE, available: false },
      { ...CODEX, available: true }
    ];

    it('does not seed the default from an uninstalled config value', () => {
      const ctx = loadSetup(roster, { defaultEngine: 'claude' });
      ctx.showWizard();
      assert.equal(ctx.wizard.defaultEngine, 'codex',
        'the shipped claude default must not survive on a machine without claude');
    });

    it('pre-selects the installed engine in the dropdown, not the missing one', () => {
      const ctx = loadSetup(roster, { defaultEngine: 'claude' });
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /<option value="codex"[^>]*\sselected/,
        'the installed engine must be the selected option');
      assert.doesNotMatch(html, /<option value="claude"[^>]*\sselected/,
        'an uninstalled engine must never be pre-selected');
    });

    it('keeps uninstalled engines listed but labelled and unselectable', () => {
      // Listed so an operator who installs one later can find it; disabled so
      // the value cannot be chosen in the meantime.
      const ctx = loadSetup(roster, { defaultEngine: 'claude' });
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /<option value="claude"[^>]*disabled[^>]*>Claude Code \(not installed\)</,
        'uninstalled engines stay listed, labelled, and disabled');
      assert.doesNotMatch(html, /<option value="codex"[^>]*disabled/,
        'an installed engine must remain selectable');
    });

    it('corrects an unavailable selection on re-render, not just on first seed', () => {
      // Guards the path where wizard state is mutated between renders (Back,
      // then forward again) — the correction has to be per-render, not one-shot.
      const ctx = loadSetup(roster, { defaultEngine: 'claude' });
      ctx.showWizard();
      ctx.wizard.defaultEngine = 'claude';
      renderEngineStep(ctx);
      assert.equal(ctx.wizard.defaultEngine, 'codex');
    });
  });

  describe('a profile with no usable name', () => {
    it('labels the option with the id rather than rendering blank', () => {
      // `name` is not validated when an engine profile is saved (only `id` is),
      // and `esc` returns '' for a non-string — so a hand-added profile would
      // otherwise show an unidentifiable empty option in the wizard's picker.
      const ctx = loadSetup([{ id: 'homegrown', available: true }], { defaultEngine: 'homegrown' });
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      // Scoped to the <option>, not the whole step: the step also renders
      // <span class="setup-engine-name">, so a loose />homegrown</ matches the
      // availability list and stays green while the option renders blank.
      assert.match(html, /<option value="homegrown"[^>]*>homegrown</,
        'a nameless profile must fall back to its id in the picker itself');
    });
  });

  describe('an installed config default is respected', () => {
    it('keeps the operator\'s choice when that engine is present', () => {
      const ctx = loadSetup(
        [{ ...CLAUDE, available: true }, { ...CODEX, available: true }],
        { defaultEngine: 'codex' }
      );
      ctx.showWizard();
      assert.equal(ctx.wizard.defaultEngine, 'codex',
        'availability resolution must not override a valid explicit choice');
    });

    it('falls to the first installed engine when config names nothing', () => {
      const ctx = loadSetup([{ ...CLAUDE, available: false }, { ...AIDER, available: true }], {});
      ctx.showWizard();
      assert.equal(ctx.wizard.defaultEngine, 'aider');
    });
  });

  describe('no engine installed at all', () => {
    const roster = [{ ...CLAUDE, available: false }, { ...CODEX, available: false }];

    it('resolves the default to null rather than inventing one', () => {
      const ctx = loadSetup(roster, { defaultEngine: 'claude' });
      ctx.showWizard();
      assert.equal(ctx.wizard.defaultEngine, null);
    });

    it('replaces the picker with a warning instead of offering only refused options', () => {
      const ctx = loadSetup(roster, { defaultEngine: 'claude' });
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /No AI engine is installed yet/);
      assert.doesNotMatch(html, /<select[^>]*id="setupDefaultEngine"/,
        'a dropdown whose every option is disabled is worse than saying so');
    });

    it('parks setup here — there is no way forward with nothing to launch', () => {
      // TangleClaw's whole job is running an engine's CLI. Finishing without one
      // hands the operator a finished-looking dashboard that can launch nothing,
      // and they find out at the first Launch button with nothing explaining it.
      // The server refuses on both routes that complete setup; this screen is
      // what makes the refusal make sense.
      const ctx = loadSetup(roster, {});
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.doesNotMatch(html, /onclick="wizardNext\(\)"/,
        'Next must not be offered — the server would refuse it anyway');
      assert.match(html, /wizardRecheckEngines\(\)/,
        'and the way forward must be on screen: install one, then check again');
    });

    it('offers Continue anyway when detection could not look', () => {
      // The half a server-side fail-open does not buy. If the wizard still
      // renders no way forward, an operator whose engine IS installed and whose
      // shell would not answer is walled in regardless of what the server would
      // have allowed — pressing Check again forever against a broken check.
      const ctx = loadSetup(roster, {});
      ctx.state.engineDetectionCertain = false;
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /could not check for an AI engine/i,
        'it must say it could not tell, not assert an absence');
      assert.match(html, /Continue anyway/);
      assert.match(html, /wizardRecheckEngines\(\)/, 'and still offer the re-check');
    });

    it('prefers a fresh re-check over the answer the page loaded with', () => {
      // wizardRecheckEngines writes wizard.engineDetectionCertain; the initial
      // page load writes state.engineDetectionCertain. The fresher one has to
      // win, or pressing Check again on a machine whose shell started answering
      // would keep showing the stale verdict.
      const ctx = loadSetup(roster, {});
      ctx.state.engineDetectionCertain = true;
      ctx.wizard.engineDetectionCertain = false;
      ctx.showWizard();
      ctx.wizard.engineDetectionCertain = false;
      const html = renderEngineStep(ctx);
      assert.match(html, /Continue anyway/,
        'the re-check said "could not tell" and that is the current answer');
    });

    it('wires the server flag through loadEngines — the middle link', () => {
      // Source-level, matching how every other landing.js surface is covered
      // (it is a browser global script, not require()-able). The chain is
      // server -> loadEngines -> state -> wizard, and the two tests above pin
      // only the last hop: delete the mapping and they stay green while the
      // release valve silently stops appearing.
      const landing = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
      assert.match(landing, /state\.engineDetectionCertain\s*=\s*data\.detectionCertain !== false/,
        'loadEngines must map the server field into state, and default a MISSING '
        + 'field to certain rather than to uncertain');
    });

    it('offers NO way past when it genuinely confirmed there is nothing', () => {
      // Otherwise the gate is decoration. A confirmed absence has nothing to
      // launch, and the operator finding that out at the first Launch button is
      // the failure this whole slice exists to prevent.
      const ctx = loadSetup(roster, {});
      ctx.state.engineDetectionCertain = true;
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /No AI engine is installed yet/);
      assert.doesNotMatch(html, /Continue anyway/);
      assert.doesNotMatch(html, /onclick="wizardNext\(\)"/);
    });

    it('gives the exact command and the vendor page for each engine', () => {
      // A command is what someone at a terminal wants; the docs page is the half
      // that cannot go stale, because the vendor maintains it. Both, per engine.
      const withInstall = [
        { ...CLAUDE, available: false,
          install: { command: 'npm install -g @anthropic-ai/claude-code',
            docsUrl: 'https://code.claude.com/docs/en/setup' } },
        { ...CODEX, available: false,
          install: { command: 'npm install -g @openai/codex',
            docsUrl: 'https://developers.openai.com/codex/cli' } }
      ];
      const ctx = loadSetup(withInstall, {});
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /npm install -g @anthropic-ai\/claude-code/);
      assert.match(html, /npm install -g @openai\/codex/);
      assert.match(html, /href="https:\/\/code\.claude\.com\/docs\/en\/setup"/);
      assert.match(html, /rel="noopener noreferrer"/,
        'a target=_blank link without noopener hands the opened page a handle back');
    });

    it('drops a docs link that is not http(s)', () => {
      // Engine profiles are operator-authored through the API and this value
      // goes straight into an href. `javascript:` there is a script the page
      // runs when someone clicks "Install instructions".
      const hostile = [{ ...CLAUDE, available: false,
        install: { command: 'npm i -g x', docsUrl: 'javascript:alert(1)' } }];
      const ctx = loadSetup(hostile, {});
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.doesNotMatch(html, /javascript:/i, 'the scheme must never reach the href');
      assert.match(html, /npm i -g x/, 'and the usable half is still offered');
    });

    it('says so plainly for an engine that carries no install info', () => {
      // Operator-added profiles are not required to tell us how they install.
      // An honest "we do not know" beats a guessed command.
      const ctx = loadSetup([{ ...CLAUDE, available: false }], {});
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /No install command on file/);
    });

    it('still lists what was looked for, so the operator knows their options', () => {
      const ctx = loadSetup(roster, {});
      ctx.showWizard();
      const html = renderEngineStep(ctx);
      assert.match(html, /Claude Code/);
      assert.match(html, /Codex CLI/);
      assert.match(html, /Not found/);
    });

    it('reports "None installed" in the confirm summary, never a literal null', () => {
      const ctx = loadSetup(roster, {});
      ctx.showWizard();
      const body = ctx.document.getElementById('setupBody');
      ctx.renderConfirm(body);
      assert.match(body.innerHTML, /None installed/);
      assert.doesNotMatch(body.innerHTML, /null/);
    });
  });
});
