'use strict';

/*
 * #2884 I-Gate R1 Round 2 (A504-W1C-R5, finding 1) — the Notification
 * policy section of public/bridge-settings-ui.js rendered only a static
 * `<li>` per event kind, with no live control calling
 * setGlobalNotificationPolicy / setProjectNotificationOverride.
 * test/bridge-slice2-wiring.test.js's own existing tests for those two
 * functions call them directly, never through a rendered button — this
 * file is what was missing: a REAL click on the rendered toggle/clear
 * buttons, not a direct function call standing in for one.
 *
 * The mini-dom's `withIdParsingInnerHTML` (test/_mini-dom.js) only upgrades
 * the element it is given; `bridge-slice2-wiring.test.js`'s own harness
 * upgrades only the ROOT, so the dynamically-rendered policy list's own
 * `innerHTML =` never registers its buttons' ids on the document (the same
 * wall bridge-step-up.js's header comment documents for its own list).
 * Upgrading the `${p}PolicyList` element too, once `mount()` has created
 * it, lets `_bindPolicyRows`'s `el('PolicyToggle_...')` lookups find real,
 * clickable elements.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

/** @returns {object} The published globals of public/bridge-settings-ui.js. */
function loadBridgeSettingsUiGlobal() {
  const sandbox = { console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'bridge-settings-ui.js'), 'utf8'), sandbox);
  return sandbox;
}

const PROJECTS = [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }];
const ESC = (s) => String(s);

let G;
beforeEach(() => { G = loadBridgeSettingsUiGlobal(); });

/**
 * Mount a bridge-settings panel with the policy list's own dynamic
 * innerHTML upgraded too, so its rendered buttons are really clickable.
 * @param {object} [extraDeps]
 * @returns {{doc: object, ui: object}}
 */
function mountedWithClickablePolicyList(extraDeps) {
  const { doc, ids } = makeDocument(['root']);
  withIdParsingInnerHTML(ids.root, doc);
  const ui = G.tcCreateBridgeSettingsUi(Object.assign(
    { doc, rootId: 'root', prefix: 'bs', esc: ESC, projects: PROJECTS, eventKinds: ['fleet-idle', 'gateway-down'] },
    extraDeps
  ));
  ui.mount();
  withIdParsingInnerHTML(doc.getElementById('bsPolicyList'), doc);
  return { doc, ui };
}

/**
 * Wait past every already-queued microtask AND one macrotask tick -- long
 * enough for a fire-and-forget click/change handler's own async chain
 * (however many `await`s deep) to finish, without the test awaiting the
 * handler's promise directly (a plain DOM listener never hands one back).
 * @returns {Promise<void>}
 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('bridge-settings-ui.js notification policy -- live controls (#2884 I-Gate R1 Round 2)', () => {
  it('renders a scope selector naming every project, plus Global default', () => {
    const { doc, ui } = mountedWithClickablePolicyList({ api: async () => null });
    void ui;
    // The mini-dom's withIdParsingInnerHTML deliberately extracts ONLY ids
    // (test/_mini-dom.js's own documented limit) -- a looked-up element
    // never carries the real markup's attributes or children, only the
    // ROOT's own innerHTML getter still returns the raw string it was
    // assigned, so that is what a content check reads.
    const html = doc.getElementById('root').innerHTML;
    assert.match(html, /Global default/);
    assert.match(html, /<option value="1">alpha<\/option>/);
    assert.match(html, /<option value="2">beta<\/option>/);
  });

  it('clicking the toggle button in GLOBAL scope calls setGlobalNotificationPolicy with the opposite state', async () => {
    const calls = [];
    const { doc, ui } = mountedWithClickablePolicyList({
      api: async (p) => (p.includes('fleet-idle') ? { enabled: false, source: 'global' } : { enabled: true, source: 'default' }),
      apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { enabled: true, source: 'global' }; }
    });
    await ui.loadNotificationPolicy();

    // Same reason as above: the rendered label lives in the (upgraded)
    // PolicyList element's own raw innerHTML string, not on the flat
    // stand-in button element itself.
    assert.match(doc.getElementById('bsPolicyList').innerHTML, /id="bsPolicyToggle_fleet-idle">Turn on</);

    const toggleBtn = doc.getElementById('bsPolicyToggle_fleet-idle');
    assert.ok(toggleBtn, 'the toggle button must have been rendered and registered');
    const fired = toggleBtn.dispatch('click');
    assert.equal(fired, true, 'a listener must actually be bound');
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api/bridge/operator/notification-policy/global');
    assert.equal(calls[0][1], 'POST');
    assert.equal(calls[0][2].eventKind, 'fleet-idle');
    assert.equal(calls[0][2].enabled, true, 'currently off -> toggling must request on');
  });

  it('selecting a project scope reads that project\'s override, and the toggle calls setProjectNotificationOverride', async () => {
    const apiCalls = [];
    const mutateCalls = [];
    const { doc, ui } = mountedWithClickablePolicyList({
      api: async (p) => { apiCalls.push(p); return { enabled: true, source: 'project' }; },
      apiMutate: async (p, m, b) => { mutateCalls.push([p, m, b]); return { enabled: false, source: 'project' }; }
    });

    const scopeSelect = doc.getElementById('bsPolicyScope');
    scopeSelect.value = '2';
    // Through the real change listener mount() bound, not a direct call --
    // this is what proves the select is actually wired, not just readable.
    const scopeChanged = scopeSelect.dispatch('change');
    assert.equal(scopeChanged, true, 'the scope select must have a bound change listener');
    await settle();

    assert.ok(apiCalls.some((p) => p.includes('projectId=2')), 'the scoped read must query the selected project');

    const toggleBtn = doc.getElementById('bsPolicyToggle_gateway-down');
    assert.ok(toggleBtn);
    toggleBtn.dispatch('click');
    await settle();

    assert.equal(mutateCalls.length, 1);
    assert.equal(mutateCalls[0][0], '/api/bridge/operator/notification-policy/project/2');
    assert.equal(mutateCalls[0][2].eventKind, 'gateway-down');
    assert.equal(mutateCalls[0][2].enabled, false, 'currently on for this project -> toggling must request off');
  });

  it('renders a Clear override button only for a kind whose resolution actually came from this project, and clicking it clears', async () => {
    const mutateCalls = [];
    const { doc, ui } = mountedWithClickablePolicyList({
      api: async (p) => (p.includes('fleet-idle')
        ? { enabled: false, source: 'project' }
        : { enabled: true, source: 'default' }),
      apiMutate: async (p, m, b) => { mutateCalls.push([p, m, b]); return { ok: true }; }
    });
    doc.getElementById('bsPolicyScope').value = '1';
    await ui.loadNotificationPolicy();

    assert.ok(doc.getElementById('bsPolicyClear_fleet-idle'), 'source: project must get a Clear override button');
    assert.equal(doc.getElementById('bsPolicyClear_gateway-down'), null,
      'source: default has no project override to clear, so no button for it');

    doc.getElementById('bsPolicyClear_fleet-idle').dispatch('click');
    await settle();

    assert.equal(mutateCalls[0][0], '/api/bridge/operator/notification-policy/project/1');
    assert.equal(mutateCalls[0][2].eventKind, 'fleet-idle');
    assert.equal(mutateCalls[0][2].enabled, null);
  });

  it('never renders a Clear override button in GLOBAL scope, even for a kind the project layer set elsewhere', async () => {
    const { doc } = mountedWithClickablePolicyList({
      api: async () => ({ enabled: true, source: 'global' })
    });
    await settle();
    assert.equal(doc.getElementById('bsPolicyClear_fleet-idle'), null);
    assert.equal(doc.getElementById('bsPolicyClear_gateway-down'), null);
  });

  it('a second click on the project toggle posts the OPPOSITE of the reloaded state, not a repeat of the first (#2884 I-Gate R2 finding 1)', async () => {
    // A tiny real backend: fleet-idle starts ON for project 1, and the
    // mutate route actually flips it, the same as the live server would.
    const mutateCalls = [];
    let fleetIdleEnabled = true;
    const { doc, ui } = mountedWithClickablePolicyList({
      api: async () => ({ enabled: fleetIdleEnabled, source: 'project' }),
      apiMutate: async (p, m, b) => {
        mutateCalls.push([p, m, b]);
        fleetIdleEnabled = b.enabled;
        return { enabled: fleetIdleEnabled, source: 'project' };
      }
    });
    doc.getElementById('bsPolicyScope').value = '1';
    await ui.loadNotificationPolicy();

    // First click: on -> off.
    doc.getElementById('bsPolicyToggle_fleet-idle').dispatch('click');
    await settle();
    assert.equal(mutateCalls.length, 1);
    assert.equal(mutateCalls[0][2].enabled, false);
    // Without a reload after setProjectNotificationOverride, the button's
    // bound handler still closes over the ORIGINAL (stale) answer and the
    // SAME visible button posts `false` again here too -- the reload is
    // what makes it post the true opposite of what the server now holds.
    assert.match(doc.getElementById('bsPolicyList').innerHTML, /id="bsPolicyToggle_fleet-idle">Turn on</,
      'the re-rendered row must reflect the now-off state');

    // Second click on the (freshly rendered) button: off -> on.
    doc.getElementById('bsPolicyToggle_fleet-idle').dispatch('click');
    await settle();
    assert.equal(mutateCalls.length, 2);
    assert.equal(mutateCalls[1][2].enabled, true, 'the second click must toggle back on, not repeat false');
  });

  it('clicking Clear override removes its own button once the list reloads (#2884 I-Gate R2 finding 1)', async () => {
    let source = 'project';
    const { doc, ui } = mountedWithClickablePolicyList({
      api: async () => ({ enabled: true, source }),
      apiMutate: async () => { source = 'default'; return { enabled: true, source: 'default' }; }
    });
    doc.getElementById('bsPolicyScope').value = '1';
    await ui.loadNotificationPolicy();
    assert.ok(doc.getElementById('bsPolicyClear_fleet-idle'));

    doc.getElementById('bsPolicyClear_fleet-idle').dispatch('click');
    await settle();

    // Via the list's own raw markup, not doc.getElementById: the mini-dom
    // never forgets a once-seen id (test/_mini-dom.js's own documented
    // limit), so a stale reference from the FIRST render would still
    // answer truthy even though the id is genuinely absent from the
    // reloaded markup.
    assert.doesNotMatch(doc.getElementById('bsPolicyList').innerHTML, /bsPolicyClear_fleet-idle/,
      'a cleared override has nothing left to clear, so its own button must be gone after the reload');
  });

  it('a slower project-scope read resolving after a faster Global one does not paint over the newer selection (#2884 I-Gate R2 finding 2)', async () => {
    const projectCall = {};
    projectCall.promise = new Promise((resolve) => { projectCall.resolve = resolve; });
    const { doc, ui } = mountedWithClickablePolicyList({
      api: async (p) => {
        if (p.includes('projectId=1')) return projectCall.promise;
        return { enabled: false, source: 'global' };
      }
    });

    // Start the project-scope read (deliberately left unresolved)...
    const scopeSelect = doc.getElementById('bsPolicyScope');
    scopeSelect.value = '1';
    const loadA = ui.loadNotificationPolicy();

    // ...then switch back to Global before it answers, same as an operator
    // clicking the select twice in quick succession.
    scopeSelect.value = '';
    const loadB = ui.loadNotificationPolicy();
    await loadB;

    assert.match(doc.getElementById('bsPolicyList').innerHTML, /off \(global\)/,
      'the newer Global read must have painted the list');

    // Only now does the slower, STALE project read resolve.
    projectCall.resolve({ enabled: true, source: 'project' });
    await loadA;
    await settle();

    assert.match(doc.getElementById('bsPolicyList').innerHTML, /off \(global\)/,
      'the stale project answer must be discarded, not overwrite the current Global render');
    assert.doesNotMatch(doc.getElementById('bsPolicyList').innerHTML, /\(project\)/);
  });
});
