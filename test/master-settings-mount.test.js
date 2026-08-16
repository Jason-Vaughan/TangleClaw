'use strict';

/*
 * #768 chunk 1 — `tcCreateMasterSettings().mount()`, RUN rather than pinned.
 *
 * The extraction's whole premise is that one component serves the dashboard and
 * the session page. Two properties carry that premise, and both are runtime:
 *
 *  1. mount() injects the modal into a page that has none — otherwise the
 *     session page gets a component with nothing to render into.
 *  2. mount() is idempotent. Page load mounts once and the Master control bar
 *     will mount again on demand; an append-always mount would leave two
 *     `#masterSettingsModal` nodes and `getElementById` would render into the
 *     one the operator cannot see, which looks exactly like "the gear does
 *     nothing".
 *
 * The first version of these guards matched the SOURCE strings `if (!modal) {`
 * and `dataset.tcMasterSettingsBound === '1'`. That passes whether or not
 * mounting twice actually does anything, which is the vacuous-guard family
 * #928 R-1 records. These mount, mount again, and count.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

const HELPER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');

/**
 * Load api-helper.js in a context and return its exported globals.
 * @returns {object} The sandbox, carrying `tcCreateMasterSettings`.
 */
function loadHelper() {
  const sandbox = { console, setTimeout };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HELPER_SRC, sandbox);
  return sandbox;
}

/**
 * A document whose `createElement` returns holders that can take markup.
 * @returns {object} `{doc, ids}` from the mini-DOM, upgraded.
 */
function mountingDocument() {
  const { doc, ids } = makeDocument([]);
  const create = doc.createElement;
  doc.createElement = (tag) => withIdParsingInnerHTML(create(tag), doc);
  return { doc, ids };
}

/**
 * Build the component against a fresh document with stubbed dependencies.
 * @param {object} [over] - Dependency overrides.
 * @returns {object} `{component, doc, calls}`.
 */
function build(over = {}) {
  const { doc } = mountingDocument();
  const calls = [];
  const settings = {
    accessLevel: 'read-only',
    accessLevels: ['read-only'],
    enabledAccessLevels: ['read-only'],
    engine: 'claude',
    launchMode: 'default',
    resolvedLaunchMode: 'default',
    launchModes: [{ id: 'default', label: 'Interactive' }],
    scope: 'all',
    autoStart: false,
    enforcement: 'structural'
  };
  const api = async (url) => {
    calls.push(url);
    if (url.startsWith('/api/master/status')) return { settings };
    if (url === '/api/groups') return { groups: [] };
    return { rules: [] };
  };
  api.lastError = null;
  const component = loadHelper().tcCreateMasterSettings({
    api,
    apiMutate: async () => ({ ok: true }),
    esc: (s) => String(s == null ? '' : s),
    buildEngineOptions: () => '<option value="claude">Claude</option>',
    state: { engines: [] },
    document: doc,
    ...over
  });
  return { component, doc, calls };
}

describe('#768 — the Master settings modal mounts on a page that has none', () => {
  it('injects the modal and its body, close and save controls', () => {
    const { component, doc } = build();
    assert.equal(doc.getElementById('masterSettingsModal'), null,
      'precondition: the page starts without the modal');

    component.mount();

    assert.ok(doc.getElementById('masterSettingsModal'), 'the modal is injected');
    assert.ok(doc.getElementById('masterSettingsBody'), 'and its body');
    assert.ok(doc.getElementById('masterSettingsCloseBtn'), 'and Close');
    assert.ok(doc.getElementById('masterSettingsSaveBtn'), 'and Save');
    assert.equal(doc.body.childNodes.length, 1, 'exactly one node was added');
  });

  it('mounting twice adds no second modal and returns the same node', () => {
    const { component, doc } = build();
    const first = component.mount();
    const second = component.mount();

    assert.equal(doc.body.childNodes.length, 1,
      'a second mount must not stack another #masterSettingsModal');
    assert.equal(first, second, 'and must hand back the node already mounted');
  });

  it('mounting twice does not double-bind the close button', () => {
    // A second `addEventListener('click', closeMasterSettings)` is invisible
    // until something depends on how many times a handler ran. It is also the
    // exact symptom an append-always mount hides behind.
    const { component, doc } = build();
    component.mount();
    component.mount();

    const modal = doc.getElementById('masterSettingsModal');
    modal.classList.add('open');
    doc.getElementById('masterSettingsCloseBtn').dispatch('click');
    assert.equal(modal.classList.contains('open'), false, 'close still works');

    let closes = 0;
    const orig = modal.classList.remove;
    modal.classList.remove = (...a) => { closes += 1; return orig(...a); };
    doc.getElementById('masterSettingsCloseBtn').dispatch('click');
    assert.equal(closes, 1, 'the close handler is bound exactly once');
  });

  it('adopts a modal the page already carries instead of appending beside it', () => {
    // Neither page ships the markup today, but mount() must stay safe if one
    // ever does — two nodes means rendering into the invisible one.
    const { doc } = mountingDocument();
    const existing = doc.createElement('div');
    existing.id = 'masterSettingsModal';
    doc._register(existing);
    doc.body.appendChild(existing);

    const { component } = build({ document: doc });
    const mounted = component.mount();

    assert.equal(mounted, existing, 'the existing modal is adopted');
    assert.equal(doc.body.childNodes.length, 1, 'and nothing was appended beside it');
  });
});

describe('#768 — opening the mounted modal renders through it', () => {
  it('fetches status, groups and rules, opens, and renders the real body', async () => {
    const { component, doc, calls } = build();
    component.mount();

    await component.open();

    assert.deepEqual(calls, [
      '/api/master/status',
      '/api/groups',
      '/api/session-rules?kind=master&status=active'
    ], 'open() drives the three reads the dashboard always made');
    assert.equal(doc.getElementById('masterSettingsModal').classList.contains('open'), true);

    const body = doc.getElementById('masterSettingsBody').innerHTML;
    assert.match(body, /id="masterLaunchModeSelect"/, 'the launch-mode picker rendered');
    assert.match(body, /id="masterRulesList"/, 'and the Hard-rules editor');
    assert.match(body, /data-action="master-restore-defaults"/);
  });

  it('reports a failed status fetch through onOpenError rather than opening empty', async () => {
    // The dashboard paints its status dot from this; the session page logs it.
    // Either way the modal must NOT open onto a body it could not fill.
    const failing = async () => null;
    failing.lastError = 'Master settings unavailable';
    const reported = [];
    const { component, doc } = build({
      api: failing,
      onOpenError: (m) => reported.push(m)
    });
    component.mount();

    await component.open();

    assert.deepEqual(reported, ['Master settings unavailable']);
    assert.equal(doc.getElementById('masterSettingsModal').classList.contains('open'), false,
      'a modal that could not be filled must not open');
  });
});
