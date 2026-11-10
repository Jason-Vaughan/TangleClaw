'use strict';

/*
 * v6 Train 2 Wave 2 (#2981, V6-08 / B1, Car V60-T2-W2-UI): the Fleet-First
 * route-based application shell (`public/v6-shell.js`).
 *
 * This repo ships zero npm dependencies (no jsdom) — pure logic and
 * markup-string functions are exercised directly against the real shipped
 * source (`vm.runInContext`, the same pattern `test/_api-helper-globals.js`
 * uses for `public/api-helper.js`); the interactive mount function is
 * driven through `test/_mini-dom.js`'s minimal DOM stand-in, the same
 * pattern `test/master-control-bar.test.js` uses for `tcCreateMasterControlBar`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-shell.js'), 'utf8');

/**
 * Load the real shipped module into a fresh sandbox.
 * @returns {object} The sandbox, carrying every `tcV6*`/`tcCreateV6Shell` global.
 */
function loadV6Shell() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

/**
 * Strip a value returned from the `vm` sandbox down to a plain object/array
 * from THIS realm, via a JSON round-trip. `vm.createContext` gives the
 * sandboxed module its own `Object`/`Array` prototypes, so
 * `assert.deepStrictEqual` (what `assert.deepEqual` is under `node:assert/
 * strict`) refuses a cross-realm object even when every field matches —
 * "same structure but not reference-equal." Every value this file compares
 * with `assert.deepEqual` that came out of the sandbox goes through this
 * first; a plain string/number/boolean round-trips unchanged.
 * @param {*} value
 * @returns {*}
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * A minimal, injectable stand-in for `window` — just enough `location.hash`
 * and `hashchange` plumbing for {@link tcCreateV6Shell} to drive itself.
 * @param {string} [initialHash]
 * @returns {object}
 */
function makeFakeWindow(initialHash) {
  let hash = initialHash || '';
  const listeners = {};
  return {
    location: {
      get hash() { return hash; },
      set hash(v) {
        hash = v.startsWith('#') ? v : `#${v}`;
        (listeners.hashchange || []).slice().forEach((fn) => fn());
      }
    },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    _fireHashChange() { (listeners.hashchange || []).slice().forEach((fn) => fn()); }
  };
}

describe('tcV6ParseRoute (#2981 deliverable 1)', () => {
  let G;
  it('parses #/projects/:id', () => {
    G = loadV6Shell();
    assert.deepEqual(plain(G.tcV6ParseRoute('#/projects/42')), { view: 'project', projectId: '42' });
  });

  it('parses #/projects/:id/fleets/:fleetId', () => {
    assert.deepEqual(plain(G.tcV6ParseRoute('#/projects/42/fleets/7')), { view: 'fleet', projectId: '42', fleetId: '7' });
  });

  it('parses #/resources/:id/conversation', () => {
    assert.deepEqual(plain(G.tcV6ParseRoute('#/resources/99/conversation')), { view: 'conversation', resourceId: '99' });
  });

  it('parses #/settings/* with and without a sub-path', () => {
    assert.deepEqual(plain(G.tcV6ParseRoute('#/settings/engines')), { view: 'settings', settingsPath: 'engines' });
    assert.deepEqual(plain(G.tcV6ParseRoute('#/settings')), { view: 'settings', settingsPath: '' });
  });

  it('decodes a URL-encoded segment', () => {
    assert.deepEqual(plain(G.tcV6ParseRoute('#/projects/my%20project')), { view: 'project', projectId: 'my project' });
  });

  it('returns {view: null} for an empty hash or anything unrecognized', () => {
    assert.deepEqual(plain(G.tcV6ParseRoute('')), { view: null });
    assert.deepEqual(plain(G.tcV6ParseRoute('#/')), { view: null });
    assert.deepEqual(plain(G.tcV6ParseRoute('#/something-else')), { view: null });
    assert.deepEqual(plain(G.tcV6ParseRoute(undefined)), { view: null });
  });

  it('a project route with no fleets segment is NOT misread as a fleet route', () => {
    assert.deepEqual(plain(G.tcV6ParseRoute('#/projects/42/fleets')), { view: 'project', projectId: '42' });
  });

  it('fails closed to {view: null} for a malformed percent-encoded segment, rather than throwing URIError (PRR-B R1 HOLD)', () => {
    assert.doesNotThrow(() => G.tcV6ParseRoute('#/projects/%E0%A4%A'));
    assert.deepEqual(plain(G.tcV6ParseRoute('#/projects/%E0%A4%A')), { view: null });
    assert.deepEqual(plain(G.tcV6ParseRoute('#/projects/%')), { view: null });
  });
});

describe('tcV6RouteHash (inverse of tcV6ParseRoute)', () => {
  const G = loadV6Shell();
  it('round-trips every route shape through parse -> hash -> parse', () => {
    const routes = [
      { view: 'project', projectId: '42' },
      { view: 'fleet', projectId: '42', fleetId: '7' },
      { view: 'conversation', resourceId: '99' },
      { view: 'settings', settingsPath: 'engines' }
    ];
    for (const route of routes) {
      const hash = G.tcV6RouteHash(route);
      assert.deepEqual(plain(G.tcV6ParseRoute(hash)), route, hash);
    }
  });

  it('encodes a segment containing special characters', () => {
    const hash = G.tcV6RouteHash({ view: 'project', projectId: 'a/b' });
    assert.doesNotMatch(hash, /#\/projects\/a\/b$/);
  });

  it('returns #/ for a null or viewless route', () => {
    assert.equal(G.tcV6RouteHash(null), '#/');
    assert.equal(G.tcV6RouteHash({ view: null }), '#/');
  });
});

describe('tcV6RouteTitle', () => {
  const G = loadV6Shell();
  it('names every route shape', () => {
    assert.equal(G.tcV6RouteTitle({ view: 'project', projectId: '42' }), 'Project 42');
    assert.equal(G.tcV6RouteTitle({ view: 'fleet', projectId: '42', fleetId: '7' }), 'Fleet 7');
    assert.equal(G.tcV6RouteTitle({ view: 'conversation', resourceId: '99' }), 'Conversation — Resource 99');
    assert.equal(G.tcV6RouteTitle({ view: 'settings', settingsPath: 'engines' }), 'Settings — engines');
    assert.equal(G.tcV6RouteTitle({ view: 'settings', settingsPath: '' }), 'Settings');
    assert.equal(G.tcV6RouteTitle({ view: null }), 'Projects');
    assert.equal(G.tcV6RouteTitle(null), 'Projects');
  });
});

describe('tcV6BuildHierarchyTree (#2981 deliverable 2)', () => {
  const G = loadV6Shell();
  it('defaults every missing field to an empty string/array rather than undefined', () => {
    const tree = G.tcV6BuildHierarchyTree([{ id: 1 }]);
    assert.deepEqual(plain(tree), [{ id: 1, displayName: '', fleets: [] }]);
  });

  it('normalizes a full project/fleet/member shape', () => {
    const tree = G.tcV6BuildHierarchyTree([
      { id: 1, displayName: 'Alpha', fleets: [{ id: 10, displayName: 'Core', members: [{ seatId: 'pm', role: 'PM' }] }] }
    ]);
    assert.deepEqual(plain(tree), [
      { id: 1, displayName: 'Alpha', fleets: [{ id: 10, displayName: 'Core', members: [{ seatId: 'pm', role: 'PM' }] }] }
    ]);
  });

  it('treats a non-array input as an empty tree', () => {
    assert.deepEqual(plain(G.tcV6BuildHierarchyTree(null)), []);
    assert.deepEqual(plain(G.tcV6BuildHierarchyTree(undefined)), []);
  });
});

describe('tcV6SidebarMarkup (#2981 deliverable 2) — escaping and structure', () => {
  const G = loadV6Shell();
  it('escapes an attacker-controlled project/fleet/member name (XSS)', () => {
    const tree = G.tcV6BuildHierarchyTree([
      { id: 1, displayName: '<script>alert(1)</script>', fleets: [{ id: 2, displayName: '"><img onerror=x>', members: [{ seatId: '</a>', role: 'PM' }] }] }
    ]);
    const html = G.tcV6SidebarMarkup(tree);
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img onerror=/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('marks the active project/fleet with aria-current="page" and is-active', () => {
    const tree = G.tcV6BuildHierarchyTree([{ id: 1, displayName: 'Alpha', fleets: [{ id: 10, displayName: 'Core' }] }]);
    const html = G.tcV6SidebarMarkup(tree, { activeProjectId: '1', activeFleetId: '10' });
    const fleetAnchor = html.match(/<a class="v6-shell-fleet[^"]*"[^>]*>/)[0];
    assert.match(fleetAnchor, /is-active/);
    assert.match(fleetAnchor, /aria-current="page"/);
  });

  it('does not render a nested fleet list for a project with no fleets', () => {
    const tree = G.tcV6BuildHierarchyTree([{ id: 1, displayName: 'Alpha' }]);
    const html = G.tcV6SidebarMarkup(tree);
    assert.doesNotMatch(html, /v6-shell-fleets/);
  });

  it('never uses role="tree"/"treeitem" without the roving-tabindex interaction model behind it', () => {
    const html = G.tcV6SidebarMarkup([]);
    assert.doesNotMatch(html, /role="tree/);
  });
});

describe('tcV6TelemetryHeaderMarkup (#2981 B4 render hook)', () => {
  const G = loadV6Shell();
  it('renders every metric with its confidence class', () => {
    const bar = { scope: 'global', metrics: { tokens: { value: 1234, confidence: 'observed' } } };
    const html = G.tcV6TelemetryHeaderMarkup(bar);
    assert.match(html, /is-observed/);
    assert.match(html, />1234</);
  });

  it('degrades a missing metric to an em-dash with is-unavailable', () => {
    const html = G.tcV6TelemetryHeaderMarkup({ scope: 'global', metrics: {} });
    assert.match(html, /is-unavailable/);
    assert.match(html, /—/);
  });

  it('renders the unavailable placeholder for a null bar, rather than throwing', () => {
    const html = G.tcV6TelemetryHeaderMarkup(null);
    assert.match(html, /is-unavailable/);
  });

  it('escapes an attacker-controlled scope name', () => {
    const html = G.tcV6TelemetryHeaderMarkup({ scope: '<script>x</script>', metrics: {} });
    assert.doesNotMatch(html, /<script>x/);
  });
});

describe('tcV6FleetWizardMarkup (#2981 C2 render hook)', () => {
  const G = loadV6Shell();
  it('renders a launch button per template with its seat count', () => {
    const html = G.tcV6FleetWizardMarkup([{ id: 'small-4-seat', name: 'Small 4-Seat Fleet', seats: [1, 2, 3, 4] }]);
    assert.match(html, /data-template-id="small-4-seat"/);
    assert.match(html, /\(4 seats\)/);
  });

  it('renders "configurable" for a template with seatGroups instead of a fixed seats array', () => {
    const html = G.tcV6FleetWizardMarkup([{ id: 'large-configurable', name: 'Large Configurable Fleet' }]);
    assert.match(html, /\(configurable seats\)/);
  });

  it('escapes an attacker-controlled template name', () => {
    const html = G.tcV6FleetWizardMarkup([{ id: 'x', name: '<img onerror=x>' }]);
    assert.doesNotMatch(html, /<img onerror=/);
  });

  it('renders nothing for a non-array input', () => {
    assert.equal(G.tcV6FleetWizardMarkup(null), '<ul class="v6-wizard-list" aria-label="Starter fleet templates"></ul>');
  });
});

describe('tcV6ModelAttestationMarkup (#2981 D1 render hook)', () => {
  const G = loadV6Shell();
  it('prefers the observed model over the requested one as the label', () => {
    const html = G.tcV6ModelAttestationMarkup({ requested_model: 'claude-sonnet-5', observed_model: 'claude-opus-5-5', confidence: 'observed' });
    assert.match(html, />claude-opus-5-5</);
    assert.match(html, /is-observed/);
  });

  it('falls back to the requested model when nothing is observed yet', () => {
    const html = G.tcV6ModelAttestationMarkup({ requested_model: 'claude-sonnet-5', observed_model: null, confidence: 'unavailable' });
    assert.match(html, />claude-sonnet-5</);
  });

  it('renders the unavailable placeholder for a null attestation', () => {
    assert.equal(G.tcV6ModelAttestationMarkup(null), '<span class="v6-model-attestation is-unavailable">No attestation</span>');
  });

  it('escapes an attacker-controlled model id', () => {
    const html = G.tcV6ModelAttestationMarkup({ observed_model: '<script>x</script>', confidence: 'observed' });
    assert.doesNotMatch(html, /<script>x/);
  });
});

describe('tcV6WatermarkFooterMarkup (#2981 H1 render hook)', () => {
  const G = loadV6Shell();
  it('renders the footer when showWatermark is true', () => {
    assert.match(G.tcV6WatermarkFooterMarkup(true), /v6-shell-watermark/);
  });

  it('renders nothing when showWatermark is false', () => {
    assert.equal(G.tcV6WatermarkFooterMarkup(false), '');
  });
});

describe('tcCreateV6Shell (#2981 deliverable 1 — mount and route sync)', () => {
  function mount(opts) {
    const G = loadV6Shell();
    const { doc, ids } = makeDocument([]);
    const root = doc.createElement('div');
    root.id = 'v6ShellRoot';
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    doc._register(root);
    const win = makeFakeWindow((opts && opts.initialHash) || '');
    const shell = G.tcCreateV6Shell(doc, Object.assign({ root, window: win }, opts || {}));
    return { shell, doc, win, root };
  }

  it('renders the Projects title for an empty hash', () => {
    const { root } = mount();
    assert.match(root.innerHTML, /Projects/);
  });

  it('re-renders with the new title when the hash changes', () => {
    const { root, win } = mount();
    win.location.hash = '#/projects/42';
    assert.match(root.innerHTML, /Project 42/);
  });

  it('getRoute reflects the current hash after a hashchange', () => {
    const { shell, win } = mount();
    win.location.hash = '#/projects/42/fleets/7';
    assert.deepEqual(plain(shell.getRoute()), { view: 'fleet', projectId: '42', fleetId: '7' });
  });

  it('navigate() drives the hash and re-renders', () => {
    const { shell, win, root } = mount();
    shell.navigate('#/settings/engines');
    assert.equal(win.location.hash, '#/settings/engines');
    assert.match(root.innerHTML, /Settings — engines/);
  });

  it('toggleDrawer opens and closes the sidebar', () => {
    const { shell, root } = mount();
    assert.equal(shell.isDrawerOpen(), false);
    shell.toggleDrawer();
    assert.equal(shell.isDrawerOpen(), true);
    assert.match(root.innerHTML, /v6-shell-sidebar is-open/);
    shell.toggleDrawer(false);
    assert.equal(shell.isDrawerOpen(), false);
  });

  it('clicking the drawer toggle button toggles the drawer', () => {
    const { shell, doc } = mount();
    const toggle = doc.getElementById('v6ShellDrawerToggle');
    assert.ok(toggle, 'drawer toggle button must be registered');
    toggle.dispatch('click');
    assert.equal(shell.isDrawerOpen(), true);
  });

  it('clicking the skip link focuses #v6ShellMain WITHOUT replacing the active route hash (PRR-B R1 HOLD)', () => {
    const { doc, win } = mount({ initialHash: '#/projects/42' });
    const skipLink = doc.getElementById('v6ShellSkipLink');
    assert.ok(skipLink, 'skip link must be registered');
    const main = doc.getElementById('v6ShellMain');
    skipLink.dispatch('click');
    assert.equal(win.location.hash, '#/projects/42', 'the active route hash must survive the skip-link click');
    assert.equal(doc.activeElement, main, 'focus must move to #v6ShellMain');
  });

  it('a keydown on the sidebar carrying no key does not close the drawer (negative case)', () => {
    // test/_mini-dom.js's dispatch(type) has no way to attach a `key` to the
    // synthesized event, so the actual Escape-closes-the-drawer behavior
    // (a simple `evt.key === 'Escape'` check in wireControls()) cannot be
    // exercised end-to-end by this repo's zero-dependency DOM stub. This
    // pins the negative case instead: a keydown that is NOT Escape must
    // never close the drawer.
    const { shell, doc } = mount();
    shell.toggleDrawer(true);
    const sidebar = doc.getElementById('v6ShellSidebar');
    sidebar.dispatch('keydown');
    assert.equal(shell.isDrawerOpen(), true);
  });

  it('setTree/setTelemetry/setTemplates/setAttestation each re-render with the new data', () => {
    const { shell, root } = mount();
    shell.setTree([{ id: 1, displayName: 'Alpha' }]);
    assert.match(root.innerHTML, /Alpha/);
    shell.setTelemetry({ scope: 'global', metrics: { tokens: { value: 42, confidence: 'observed' } } });
    assert.match(root.innerHTML, />42</);
    shell.setTemplates([{ id: 't1', name: 'Tiny Fleet', seats: [1] }]);
    assert.match(root.innerHTML, /Tiny Fleet/);
    shell.setAttestation({ observed_model: 'claude-opus-5-5', confidence: 'observed' });
    assert.match(root.innerHTML, /claude-opus-5-5/);
  });

  it('calls onRender with the parsed route on every render', () => {
    const seen = [];
    const { win } = mount({ onRender: (route) => seen.push(route.view) });
    win.location.hash = '#/projects/1';
    assert.deepEqual(seen, [null, 'project']);
  });

  it('respects showWatermark: false', () => {
    const { root } = mount({ showWatermark: false });
    assert.doesNotMatch(root.innerHTML, /v6-shell-watermark/);
  });

  it('destroy() stops reacting to further hashchange events', () => {
    const { shell, win, root } = mount();
    shell.destroy();
    win.location.hash = '#/projects/999';
    assert.doesNotMatch(root.innerHTML, /Project 999/);
  });

  it('onLaunchTemplate is called with the clicked template id', () => {
    const launched = [];
    const { doc } = mount({ templates: [{ id: 'small-4-seat', name: 'Small' }], onLaunchTemplate: (id) => launched.push(id) });
    const button = doc.getElementById('v6ShellWizardLaunch-small-4-seat');
    assert.ok(button, 'the launch button must be registered under its real id');
    button.dispatch('click');
    assert.deepEqual(launched, ['small-4-seat']);
  });
});

describe('public/style.css grid placement (#2981 PRR-B R1 HOLD)', () => {
  // Markup/CSS asserted against the static file text, the same pattern
  // test/ui-watermark.test.js and friends use for public/*.css — no real
  // layout engine to render against (this repo ships zero npm
  // dependencies), so the regression this pins is "the declaration that
  // fixed the bug is still there," not a rendered layout.
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  function ruleBodyFor(selector) {
    const re = new RegExp(`${selector.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
    const match = CSS.match(re);
    return match ? match[1] : null;
  }

  it('places the sidebar in column 1, spanning every row', () => {
    const body = ruleBodyFor('.v6-shell-sidebar');
    assert.ok(body, '.v6-shell-sidebar rule must exist');
    assert.match(body, /grid-column:\s*1/);
    assert.match(body, /grid-row:\s*1\s*\/\s*-1/);
  });

  it('places the main view, telemetry header, and watermark in column 2 on desktop', () => {
    for (const selector of ['.v6-shell-view', '.v6-telemetry-header', '.v6-shell-watermark']) {
      const body = ruleBodyFor(selector);
      assert.ok(body, `${selector} rule must exist`);
      assert.match(body, /grid-column:\s*2/, selector);
    }
  });

  it('resets every grid-placed element back to column 1 inside the mobile media query', () => {
    const mobileBlock = CSS.slice(CSS.indexOf('@media (max-width: 760px)'));
    assert.match(mobileBlock, /\.v6-shell-view,\s*\n\s*\.v6-telemetry-header,\s*\n\s*\.v6-shell-watermark\s*\{\s*\n\s*grid-column:\s*1;/);
  });
});
