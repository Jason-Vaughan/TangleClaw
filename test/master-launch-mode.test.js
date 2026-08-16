'use strict';

/*
 * #756 — the Master settings modal's launch-mode picker, at the frontend.
 *
 * The Master had no launch mode at any layer; `lib/master.js` hardcoded `null`
 * into its launch command. The backend half is covered in `test/master.test.js`.
 * This covers the surface, and specifically the two ways a mode picker lies:
 *
 *  1. Re-deriving which modes exist instead of rendering what the server said
 *     this engine offers — the third-source-of-truth failure #768 names.
 *  2. Dropping a stored mode the current engine cannot honor, so the modal
 *     shows `default` while config still holds the operator's real choice. That
 *     is the silent-ignore failure #741 documents.
 *
 * These LIFT the real functions out of public/ui.js and RUN them, rather than
 * regex-matching the source: the existing master-settings suite is source-pinned
 * (see backlog TST-6L2P), and a source pin cannot tell a rendered option from a
 * string that merely appears in the file.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
// `esc` is defined in landing.js and shared globally with ui.js — both scripts
// load on the dashboard. Lifting the REAL one keeps escaping behaviour honest
// rather than stubbing it into something more forgiving than production.
const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text.
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find.
 * @returns {string} The declaration plus its balanced body.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/** The settings shape `GET /api/master/status` returns, with overrides. */
function status(over = {}) {
  return {
    accessLevel: 'read-only',
    accessLevels: ['read-only', 'suggest', 'write'],
    enabledAccessLevels: ['read-only'],
    engine: 'claude',
    resolvedEngine: 'claude',
    launchMode: 'default',
    resolvedLaunchMode: 'default',
    // The real shape `getMasterStatus` emits, verified against the module:
    // `{id, label}`, so the picker can render "Accept Edits" like its sibling
    // rather than the raw id.
    launchModes: [
      { id: 'default', label: 'Interactive' },
      { id: 'acceptEdits', label: 'Accept Edits' },
      { id: 'plan', label: 'Plan Only' },
      { id: 'bypassPermissions', label: 'Bypass' }
    ],
    scope: 'all',
    autoStart: false,
    enforcement: 'structural',
    ...over
  };
}

/**
 * Render the settings body with the real function and return its HTML.
 * @param {object} settings - `status.settings` payload.
 * @returns {string} Rendered innerHTML.
 */
function render(settings) {
  const bodyEl = { innerHTML: '' };
  const sandbox = {
    console,
    state: { engines: [] },
    document: { getElementById: (id) => (id === 'masterSettingsBody' ? bodyEl : null) },
    // Not under test here; the engine picker has its own coverage (#707).
    buildEngineOptions: () => '<option value="claude">Claude</option>'
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    liftFunction(LANDING_SRC, 'function esc(str)'),
    liftFunction(UI_SRC, 'function renderMasterSettingsBody(s, groups)'),
    'globalThis.renderMasterSettingsBody = renderMasterSettingsBody;'
  ].join('\n'), sandbox);
  sandbox.renderMasterSettingsBody(settings, []);
  return bodyEl.innerHTML;
}

/**
 * Run the real save handler against a fake form and capture the PATCH body.
 * @param {object} fields - Values the form controls report.
 * @returns {Promise<object|null>} The `master` patch that would be sent.
 */
async function save(fields) {
  let sent = null;
  const els = {
    masterEngineSelect: { value: fields.engine || '' },
    masterScopeSelect: { value: fields.scope || '' },
    masterAutoStart: { checked: !!fields.autoStart }
  };
  if (fields.launchMode !== undefined) {
    els.masterLaunchModeSelect = { value: fields.launchMode };
  }
  const sandbox = {
    console,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => ({ value: fields.accessLevel || 'read-only' })
    },
    apiMutate: async (_p, _m, body) => { sent = body; return { ok: true }; },
    api: { lastError: null },
    _setMasterRulesStatus: () => {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    liftFunction(UI_SRC, 'async function saveMasterSettings()'),
    'globalThis.saveMasterSettings = saveMasterSettings;'
  ].join('\n'), sandbox);
  await sandbox.saveMasterSettings();
  return sent && sent.master;
}

describe('#756 — the Master settings modal offers a launch mode', () => {
  it('renders exactly the modes the server said this engine offers', () => {
    const html = render(status({
      launchModes: [{ id: 'default', label: 'Interactive' }, { id: 'acceptEdits', label: 'Accept Edits' }]
    }));
    assert.match(html, /id="masterLaunchModeSelect"/);
    assert.match(html, /<option value="acceptEdits"/);
    assert.match(html, />Accept Edits</,
      'the picker must render the human label, like the project-settings picker does');
    assert.doesNotMatch(html, />acceptEdits</,
      'a raw mode id in the option text is the visibly-poorer-sibling failure');
    // Claude defines these, but this payload did not offer them. Rendering them
    // anyway would mean the modal derived the list itself.
    assert.doesNotMatch(html, /<option value="plan"/);
    assert.doesNotMatch(html, /<option value="bypassPermissions"/);
  });

  it('selects the stored mode', () => {
    const html = render(status({ launchMode: 'acceptEdits' }));
    assert.match(html, /<option value="acceptEdits" selected>/);
  });

  it('keeps a stranded mode visible, selected, and named as unavailable', () => {
    // The operator picked acceptEdits on Claude, then switched to an engine
    // that cannot honor it. Config still holds acceptEdits, so showing
    // "default" would misreport what is saved.
    const html = render(status({
      engine: 'aider', resolvedEngine: 'aider',
      launchMode: 'acceptEdits', resolvedLaunchMode: 'default',
      launchModes: [{ id: 'default', label: 'Interactive' }, { id: 'yesAlways', label: 'Yes To All' }]
    }));
    assert.match(html, /<option value="acceptEdits" selected>/,
      'the saved choice must still be the selected one');
    assert.match(html, /not available on this engine/i);
    assert.match(html, /will start in <code>default<\/code>/,
      'and it must say what will actually run instead');
  });

  it('says there are no modes rather than rendering an empty picker', () => {
    const html = render(status({ resolvedEngine: null, launchModes: [] }));
    assert.doesNotMatch(html, /id="masterLaunchModeSelect"/);
    assert.match(html, /no launch modes to choose from/i);
    // With no engine there is nothing to strand the stored mode against. The
    // previous version of this test asserted only the picker's absence, so it
    // passed while the output also said "saved as default, which this engine
    // cannot honor" — directly under "there are no modes to choose from".
    assert.doesNotMatch(html, /cannot honor/i,
      'an install with no engine must not also claim the mode is unhonorable');
    assert.doesNotMatch(html, /not available on this engine/i);
  });

  it('names the two axes as separate, so neither implies the other', () => {
    const html = render(status());
    assert.match(html, /separate from/i);
    assert.match(html, /Access level/);
  });

  it('calls out write + bypassPermissions rather than letting it pass unremarked', () => {
    // #756: that combination is legitimate and selectable, but must not be
    // reachable without the operator seeing what they picked.
    const loud = render(status({ accessLevel: 'write', resolvedLaunchMode: 'bypassPermissions' }));
    assert.match(loud, /no confirmation at any layer/i);
    const quiet = render(status({ accessLevel: 'read-only', resolvedLaunchMode: 'bypassPermissions' }));
    assert.doesNotMatch(quiet, /no confirmation at any layer/i,
      'a read-only master in bypass is coherent — it must not be flagged as dangerous');
  });
});

describe('#756 — saving the launch mode', () => {
  it('sends the picked mode in the master patch', async () => {
    const patch = await save({ launchMode: 'acceptEdits', engine: 'claude' });
    assert.equal(patch.launchMode, 'acceptEdits');
  });

  it('omits launchMode entirely when the engine offered no picker', async () => {
    // Sending a guess here would overwrite the operator's stored choice with
    // whatever the modal happened to default to. PATCH merges, so omitting
    // leaves it intact.
    const patch = await save({ engine: 'claude' });
    assert.ok(!('launchMode' in patch),
      'no picker means no opinion — the stored mode must survive the save');
    assert.equal(patch.accessLevel, 'read-only', 'the rest of the form still saves');
  });
});
