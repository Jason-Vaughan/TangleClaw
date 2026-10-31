'use strict';

/*
 * #2747 — the Global Settings "Engine Settings" panel: a selector across
 * every registered engine (including `pickerHidden` ones such as OpenClaw,
 * which the create picker excludes) feeding that engine's read-only
 * inventory row from `GET /api/engines/inventory` (`lib/engine-tabs.js`),
 * plus the create wizard's per-engine creation-seed defaults for
 * First-Session Settings.
 *
 * Note: #2747's third requirement ("#581 TangleTweaker shell docking") is
 * deliberately NOT implemented here. #581 is closed WONTFIX
 * ("TangleTweaker is a separate product wearing feature clothes"); #2747
 * re-asked for it anyway, which is a conflict between two of the operator's
 * own decisions this session was not positioned to resolve silently, and the
 * operator chose to skip it rather than reopen #581.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { liftDeclaration, loadEsc } = require('./helpers/lift');
const loadApiHelperGlobals = require('./_api-helper-globals');

const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
const esc = loadEsc();

describe('tcEngineCreationDefaults (#2747)', () => {
  const { tcEngineCreationDefaults } = loadApiHelperGlobals();

  it('seeds defaultLaunchMode from the "default" key when the profile has one', () => {
    // Not deepEqual: `tcEngineCreationDefaults` runs in loadApiHelperGlobals's
    // own vm context, so its plain object has a different Object.prototype
    // than one built here, and deepStrictEqual checks that too.
    const profile = { launchModes: { default: {}, fullAuto: { warning: 'x' } } };
    const seed = tcEngineCreationDefaults(profile);
    assert.equal(seed.defaultLaunchMode, 'default');
    assert.equal(seed.showLaunchModePicker, true);
    assert.equal(seed.silentPrime, true);
  });

  it('falls back to a non-warned mode when the profile has no "default" key', () => {
    const profile = { launchModes: { risky: { warning: 'x' }, safe: {} } };
    assert.equal(tcEngineCreationDefaults(profile).defaultLaunchMode, 'safe');
  });

  it('falls back to the first declared key when every mode carries a warning', () => {
    const profile = { launchModes: { onlyOne: { warning: 'x' } } };
    assert.equal(tcEngineCreationDefaults(profile).defaultLaunchMode, 'onlyOne');
  });

  it('falls back to the literal "default" with no profile, or no launchModes at all', () => {
    assert.equal(tcEngineCreationDefaults(null).defaultLaunchMode, 'default');
    assert.equal(tcEngineCreationDefaults({}).defaultLaunchMode, 'default');
  });

  it('always seeds showLaunchModePicker and silentPrime true — no per-engine signal exists for either', () => {
    const seed = tcEngineCreationDefaults({ launchModes: {} });
    assert.equal(seed.showLaunchModePicker, true);
    assert.equal(seed.silentPrime, true);
  });

  it('every bundled profile seeds a mode it actually declares', () => {
    const dataDir = path.join(__dirname, '..', 'data', 'engines');
    for (const file of fs.readdirSync(dataDir)) {
      const profile = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      const seed = tcEngineCreationDefaults(profile);
      assert.ok(Object.keys(profile.launchModes || {}).includes(seed.defaultLaunchMode),
        `${file}: seeded mode "${seed.defaultLaunchMode}" is not one of its own launchModes`);
    }
  });
});

describe('tcEngineInventoryOptions (#2747)', () => {
  const { tcEngineInventoryOptions } = loadApiHelperGlobals();

  it('lists every row, including pickerHidden ones the create picker excludes', () => {
    const rows = [
      { id: 'claude', name: 'Claude Code', pickerHidden: false },
      { id: 'openclaw:conn1', name: 'Lab OpenClaw', pickerHidden: true }
    ];
    const html = tcEngineInventoryOptions(rows, 'claude', esc);
    assert.match(html, /<option value="claude" selected>Claude Code<\/option>/);
    assert.match(html, /<option value="openclaw:conn1"\s*>Lab OpenClaw \(hidden from create picker\)<\/option>/);
  });

  it('escapes names', () => {
    const html = tcEngineInventoryOptions([{ id: 'x', name: '<b>bad</b>' }], '', esc);
    assert.doesNotMatch(html, /<b>/);
  });

  it('returns empty markup for a non-array input', () => {
    assert.equal(tcEngineInventoryOptions(null, '', esc), '');
    assert.equal(tcEngineInventoryOptions(undefined, '', esc), '');
  });
});

describe('renderEngineInventorySummary (#2747)', () => {
  /**
   * Render against the shipped source, with only `esc` as a dependency.
   * @param {object} row - An inventory row, or null.
   * @returns {string}
   */
  function render(row) {
    const src = `${liftDeclaration(ui, 'function renderEngineInventorySummary(')}\nreturn renderEngineInventorySummary;`;
    return new Function('esc', src)(esc)(row);
  }

  it('says so for a missing row', () => {
    assert.match(render(null), /No inventory for this engine/);
  });

  it('shows the generated-config carrier when one exists', () => {
    const html = render({
      id: 'claude', name: 'Claude Code', pickerHidden: false,
      configFormat: { filename: 'CLAUDE.md', syntax: 'markdown', generator: 'claude-md' },
      statusPage: null,
      capabilities: { supportsPrimePrompt: true, silentPrimeSupported: true },
      extensions: { probed: false, reason: 'no known convention' }
    });
    assert.match(html, /<code>CLAUDE\.md<\/code>/);
    assert.match(html, /markdown/);
    assert.match(html, /claude-md/);
  });

  it('shows the absentReason, and the pickerHidden note, when there is no generated config', () => {
    const html = render({
      id: 'openclaw', name: 'OpenClaw', pickerHidden: true,
      configFormat: { filename: null, absentReason: 'runs on a remote host' },
      statusPage: null,
      capabilities: {},
      extensions: { probed: false, reason: 'x' }
    });
    assert.match(html, /No generated config for this engine: runs on a remote host\./);
    assert.match(html, /hidden from the create picker/);
  });

  it('shows the status page url and component name when declared', () => {
    const html = render({
      id: 'claude', name: 'Claude Code',
      configFormat: {}, statusPage: { url: 'https://status.claude.com/x', componentName: 'Claude Code' },
      capabilities: {}, extensions: { probed: false, reason: 'x' }
    });
    assert.match(html, /<code>https:\/\/status\.claude\.com\/x<\/code>/);
    assert.match(html, /\(Claude Code\)/);
  });

  it('says so when no status page is declared', () => {
    const html = render({
      id: 'claude', name: 'Claude Code',
      configFormat: {}, statusPage: null, capabilities: {}, extensions: { probed: false, reason: 'x' }
    });
    assert.match(html, /No status page declared for this engine\./);
  });

  it('lists plugins, skills and MCP servers when extensions were probed, "none found" per empty category', () => {
    const html = render({
      id: 'claude', name: 'Claude Code',
      configFormat: {}, statusPage: null, capabilities: {},
      extensions: { probed: true, plugins: ['p1'], skills: [], mcpServers: ['m1'] }
    });
    assert.match(html, /Plugins: p1\./);
    assert.match(html, /Skills: none found\./);
    assert.match(html, /MCP servers: m1\./);
  });

  it('shows the probe-skipped reason when extensions were not probed', () => {
    const html = render({
      id: 'codex', name: 'Codex',
      configFormat: {}, statusPage: null, capabilities: {},
      extensions: { probed: false, reason: 'no known local-extension convention for "codex"' }
    });
    assert.match(html, /not checked — no known local-extension convention for &quot;codex&quot;\./);
  });

  it('shows both capability dispositions', () => {
    const html = render({
      id: 'codex', name: 'Codex', configFormat: {}, statusPage: null,
      capabilities: { supportsPrimePrompt: true, silentPrimeSupported: false },
      extensions: { probed: false, reason: 'x' }
    });
    assert.match(html, /Startup prime prompt: supported\./);
    assert.match(html, /Silent prime: not supported\./);
  });
});

describe('_loadEngineInventorySection (#2747, PRR-B)', () => {
  /**
   * Run the shipped loader against stub `document`/`api`, with the real
   * `tcEngineInventoryOptions` and `renderEngineInventorySummary`.
   * @param {object} container - Stub `#gsEngineSettingsContainer`.
   * @param {object} bodyEl - Stub `#gsEngineInventoryBody`.
   * @param {function} apiImpl - Stub `api()`.
   * @returns {Promise<void>}
   */
  function run(container, bodyEl, apiImpl) {
    const { tcEngineInventoryOptions } = loadApiHelperGlobals();
    const docStub = {
      getElementById: (id) => {
        if (id === 'gsEngineSettingsContainer') return container;
        if (id === 'gsEngineInventoryBody') return bodyEl;
        return null;
      }
    };
    const src = [
      liftDeclaration(ui, 'function renderEngineInventorySummary('),
      liftDeclaration(ui, 'async function _loadEngineInventorySection(')
    ].join('\n');
    const fn = new Function('document', 'api', 'esc', 'tcEngineInventoryOptions', `${src}\nreturn _loadEngineInventorySection;`)(
      docStub, apiImpl, esc, tcEngineInventoryOptions
    );
    return fn();
  }

  /** A row with no interesting inventory detail — just a usable id/name. */
  const bareRow = (id, name) => ({
    id, name, configFormat: {}, statusPage: null, capabilities: {}, extensions: { probed: false, reason: 'x' }
  });

  it('assigns a single-slot `.onchange` handler, not a stacking `addEventListener`', () => {
    const body = liftDeclaration(ui, 'async function _loadEngineInventorySection(');
    assert.doesNotMatch(body, /\.addEventListener\(/, 'must not add a listener the container can accumulate');
    assert.match(body, /\.onchange\s*=/);
  });

  it('a second call against the SAME (unreset) container replaces, not stacks, the handler', async () => {
    // Under the current single call-site (inside openGlobalSettings, which
    // resets this container's innerHTML before each call) this never
    // actually happens — but the guarantee is cheap and protects a future
    // caller (e.g. a Refresh button) that invokes the loader again without
    // resetting the container first.
    const container = { innerHTML: '', onchange: null };
    const bodyEl = { innerHTML: '' };

    await run(container, bodyEl, async () => ({ engines: [bareRow('a', 'Engine A')] }));
    await run(container, bodyEl, async () => ({ engines: [bareRow('b', 'Engine B')] }));

    assert.equal(typeof container.onchange, 'function', 'exactly one handler is live');
    container.onchange({ target: { id: 'gsEngineInventorySelect', value: 'b' } });
    assert.match(bodyEl.innerHTML, /Engine B/, 'the live handler must resolve against the SECOND call\'s rows, not a stale first one');
  });

  it('covers every registered engine, pickerHidden ones included, in the rendered selector', async () => {
    const container = { innerHTML: '', onchange: null };
    const bodyEl = { innerHTML: '' };
    await run(container, bodyEl, async () => ({
      engines: [bareRow('claude', 'Claude Code'), { ...bareRow('openclaw:c1', 'Lab OpenClaw'), pickerHidden: true }]
    }));
    assert.match(container.innerHTML, /Claude Code/);
    assert.match(container.innerHTML, /Lab OpenClaw \(hidden from create picker\)/);
  });

  it('reports the fetch failure instead of leaving a stale loading hint', async () => {
    const container = { innerHTML: '<div class="form-hint">Loading…</div>', onchange: null };
    await run(container, { innerHTML: '' }, async () => null);
    assert.match(container.innerHTML, /Could not load engine inventory/);
  });
});

describe('create wizard per-engine creation-seed defaults (#2747)', () => {
  it('createNext re-seeds First-Session Settings only on an actual engine change', () => {
    const body = liftDeclaration(ui, 'function createNext(');
    assert.match(body, /_defaultsSeededFor !== chosen/);
    assert.match(body, /tcEngineCreationDefaults\(/);
  });

  it('openCreateModal seeds from the initial engine profile, not a hardcoded literal', () => {
    const body = liftDeclaration(ui, 'function openCreateModal(');
    assert.doesNotMatch(body, /defaultLaunchMode:\s*'default'/, 'must derive the seed, not hardcode it');
    assert.match(body, /tcEngineCreationDefaults\(profile\)/);
  });

  it('step 2 renders the seed-at-creation UI copy', () => {
    const body = liftDeclaration(ui, 'function renderCreateStep(');
    assert.match(body, /applied once when this project is created, and never changed automatically afterward/);
  });
});
