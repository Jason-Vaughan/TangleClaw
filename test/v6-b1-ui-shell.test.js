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

// ── #3022 (Car V601-UI-WIREUP): live wire-up ──

describe('tcV6SynthesizeTreeFromProjects (#3022 deliverable b)', () => {
  const G = loadV6Shell();
  const ROWS = [
    { id: 12, name: 'TC-Lane-PM' },
    { id: 10, name: 'TC-Lane-A' },
    { id: 11, name: 'TC-Lane-B' },
    { id: 20, name: 'Medusa-PM' },
    { id: 21, name: 'Medusa-Lane-A' },
    { id: 30, name: 'TangleClaw' },
    { id: 31, name: 'HDMI-Watch' }
  ];

  it('groups projects sharing a first dash segment into one Logical Project named for their common prefix', () => {
    const tree = plain(G.tcV6SynthesizeTreeFromProjects(ROWS));
    const tc = tree.find((p) => p.id === 'tc-lane');
    assert.ok(tc, JSON.stringify(tree));
    assert.equal(tc.displayName, 'TC-Lane');
    assert.equal(tc.fleets.length, 1);
    assert.equal(tc.fleets[0].displayName, 'TC-Lane Fleet');
    assert.deepEqual(tc.fleets[0].members, [
      { seatId: '10', role: 'TC-Lane-A' },
      { seatId: '11', role: 'TC-Lane-B' },
      { seatId: '12', role: 'TC-Lane-PM' }
    ]);
    const medusa = tree.find((p) => p.id === 'medusa');
    assert.equal(medusa.displayName, 'Medusa', 'common prefix stops at whole segments');
    assert.deepEqual(medusa.fleets[0].members.map((m) => m.role), ['Medusa-Lane-A', 'Medusa-PM']);
  });

  it('puts every ungrouped project — no dash, or a dash head nobody shares — in Workspace Projects, last', () => {
    const tree = plain(G.tcV6SynthesizeTreeFromProjects(ROWS));
    const last = tree[tree.length - 1];
    assert.equal(last.id, 'workspace');
    assert.deepEqual(last.fleets[0].members, [
      { seatId: '31', role: 'HDMI-Watch' },
      { seatId: '30', role: 'TangleClaw' }
    ]);
  });

  it('makes every input project navigable exactly once', () => {
    const tree = plain(G.tcV6SynthesizeTreeFromProjects(ROWS));
    const seats = tree.flatMap((p) => p.fleets.flatMap((f) => f.members.map((m) => m.seatId))).sort();
    assert.deepEqual(seats, ROWS.map((r) => String(r.id)).sort());
  });

  it('is deterministic regardless of input order', () => {
    const a = plain(G.tcV6SynthesizeTreeFromProjects(ROWS));
    const b = plain(G.tcV6SynthesizeTreeFromProjects(ROWS.slice().reverse()));
    assert.deepEqual(a, b);
  });

  it('skips malformed rows and treats a non-array as empty', () => {
    assert.deepEqual(plain(G.tcV6SynthesizeTreeFromProjects(null)), []);
    assert.deepEqual(plain(G.tcV6SynthesizeTreeFromProjects([null, { id: 1 }, { name: 'x' }, { id: 2, name: '' }])), []);
  });

  it('never yields an id that collides with the workspace group, a numeric project id, or another group', () => {
    const tree = plain(G.tcV6SynthesizeTreeFromProjects([
      { id: 1, name: 'Workspace-A' }, { id: 2, name: 'Workspace-B' },
      { id: 3, name: '2029-A' }, { id: 4, name: '2029-B' },
      { id: 5, name: 'TC-x' }, { id: 6, name: 'TC-y' },
      { id: 7, name: 'tc-a' }, { id: 8, name: 'tc-b' },
      { id: 9, name: 'Solo' }
    ]));
    const ids = tree.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids));
    assert.ok(ids.every((id) => id && !/^\d+$/.test(id)), JSON.stringify(ids));
    assert.equal(ids.filter((id) => id === 'workspace').length, 1);
  });
});

describe('tcV6SidebarMarkup member links (#3022 deliverable b)', () => {
  const G = loadV6Shell();
  const tree = () => G.tcV6BuildHierarchyTree([{
    id: 'tc-lane', displayName: 'TC-Lane',
    fleets: [{ id: 'tc-lane', displayName: 'TC-Lane Fleet', members: [{ seatId: '11', role: 'TC-Lane-B' }, { role: 'Unseated' }] }]
  }]);

  it('links a member with a seat id to its B2 Conversation View', () => {
    const html = G.tcV6SidebarMarkup(tree());
    assert.match(html, /href="#\/resources\/11\/conversation"/);
  });

  it('leaves a member with no seat id as plain text', () => {
    const html = G.tcV6SidebarMarkup(tree());
    assert.match(html, /<li class="v6-shell-member">Unseated \(\)<\/li>/);
  });

  it('marks the member for the active resource', () => {
    const html = G.tcV6SidebarMarkup(tree(), { activeResourceId: '11' });
    assert.match(html, /v6-shell-member-link is-active"\s*aria-current="page"/);
  });

  it('escapes an attacker-controlled seat id inside the link', () => {
    const html = G.tcV6SidebarMarkup(G.tcV6BuildHierarchyTree([{
      id: 'p', displayName: 'P', fleets: [{ id: 'f', displayName: 'F', members: [{ seatId: '"><img src=x>', role: 'r' }] }]
    }]));
    assert.doesNotMatch(html, /<img/);
  });
});

describe('tcV6FleetPlanMarkup / tcV6ConversationViewMarkup (#3022 deliverables d, e)', () => {
  const G = loadV6Shell();

  it('summarizes a plan\'s immediate and deferred seats', () => {
    const html = G.tcV6FleetPlanMarkup({
      templateId: 'small-4-seat',
      immediateSeats: [{ role: 'PM', seatId: 'pm' }],
      deferredSeats: [{ role: 'Builder', seatId: 'builder-a' }, { role: 'Builder', seatId: 'builder-b' }]
    });
    assert.match(html, /small-4-seat/);
    assert.match(html, /1 seat\(s\) start immediately, 2 deferred/);
    assert.match(html, /builder-b/);
  });

  it('renders nothing for a null plan and escapes seat roles', () => {
    assert.equal(G.tcV6FleetPlanMarkup(null), '');
    assert.doesNotMatch(G.tcV6FleetPlanMarkup({ templateId: 't', immediateSeats: [{ role: '<b>x</b>' }] }), /<b>/);
  });

  it('renders the event stream and an Open Hood link with the project name URL-encoded', () => {
    const html = G.tcV6ConversationViewMarkup({
      project: { id: 7, name: 'TiLT v2' }, sessionId: 99,
      events: [{ seq: 1, role: 'user', content: 'hello <script>' }, { seq: 2, role: 'assistant', content: 'hi' }]
    });
    assert.match(html, /href="\/session\/TiLT%20v2"/);
    assert.match(html, /Open Hood \(Live Terminal\)/);
    assert.match(html, /hello &lt;script&gt;/);
    assert.match(html, /is-assistant/);
  });

  it('says there is no live session rather than rendering an empty stream', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 7, name: 'X' }, sessionId: null });
    assert.match(html, /No live session/);
    assert.match(html, /Open Hood/, 'the terminal link is still offered');
  });

  it('distinguishes "no events yet" from a failed load', () => {
    assert.match(G.tcV6ConversationViewMarkup({ project: { name: 'X' }, sessionId: 1, events: [] }), /No conversation events recorded/);
    assert.match(G.tcV6ConversationViewMarkup({ project: { name: 'X' }, sessionId: 1, error: 'boom' }), /boom/);
  });

  it('renders a not-found message when no project matches the resource', () => {
    assert.match(G.tcV6ConversationViewMarkup({ project: null }), /No project matches this resource/);
  });
});

describe('tcV6ViewToggleLabel / tcV6PickAttestation (#3022 deliverables a, e)', () => {
  const G = loadV6Shell();

  it('names where a click goes', () => {
    assert.equal(G.tcV6ViewToggleLabel({ view: null }), 'Fleet Shell (v6)');
    assert.equal(G.tcV6ViewToggleLabel(null), 'Fleet Shell (v6)');
    assert.equal(G.tcV6ViewToggleLabel({ view: 'project', projectId: '1' }), 'Classic View');
    assert.equal(G.tcV6ViewToggleLabel({ view: 'settings', settingsPath: '' }), 'Classic View');
  });

  it('prefers the latest recorded generation', () => {
    const picked = plain(G.tcV6PickAttestation([{ generation: 1, observed_model: 'a' }, { generation: 2, observed_model: 'b' }], { model: 'z' }));
    assert.equal(picked.observed_model, 'b');
  });

  it('falls back to the project\'s configured model and engine, marked estimated (a confidence D1 and B4 both accept)', () => {
    const picked = plain(G.tcV6PickAttestation([], { model: 'claude-opus-5-5', engine: { id: 'claude', name: 'Claude Code' } }));
    assert.deepEqual(picked, { requested_model: 'claude-opus-5-5', observed_model: 'Claude Code', confidence: 'estimated' });
    const engineOnly = plain(G.tcV6PickAttestation(null, { model: null, engine: { id: 'codex' } }));
    assert.equal(engineOnly.requested_model, 'codex');
  });

  it('returns null when there is nothing to show', () => {
    assert.equal(G.tcV6PickAttestation(null, null), null);
    assert.equal(G.tcV6PickAttestation([], { engine: null }), null);
  });
});

describe('tcV6ResolveRouteProject (#3022 deliverable e, PRR-B R1 HOLD)', () => {
  const G = loadV6Shell();
  const ROWS = [
    { id: 10, name: 'TC-Lane-A', session: { active: false } },
    { id: 11, name: 'TC-Lane-B', session: { active: true } },
    { id: 12, name: 'TC-Lane-PM' },
    { id: 30, name: 'TangleClaw' }
  ];
  const resolve = (route, rows) => {
    const p = G.tcV6ResolveRouteProject(route, rows || ROWS);
    return p ? p.id : null;
  };

  it('resolves a conversation route and a real project id directly', () => {
    assert.equal(resolve({ view: 'conversation', resourceId: '12' }), 12);
    assert.equal(resolve({ view: 'project', projectId: '30' }), 30);
  });

  // #3047 replaced "first member with a live session" with the project's
  // Designated Delegate, which defaults to its -PM member: these three
  // assertions moved with the requirement. The live-member and first-member
  // fallbacks keep their own tests, on rows with no PM.
  it('resolves a synthesized logical project to its designated delegate, its -PM member by default (#3047)', () => {
    assert.equal(resolve({ view: 'project', projectId: 'tc-lane' }), 12);
  });

  const NO_PM = ROWS.filter((r) => r.name !== 'TC-Lane-PM');

  it('with no PM, resolves to the member with a live session', () => {
    assert.equal(resolve({ view: 'project', projectId: 'tc-lane' }, NO_PM), 11);
  });

  it('with no PM and no live session, falls back to the first member', () => {
    const idle = NO_PM.map((r) => Object.assign({}, r, { session: null }));
    assert.equal(resolve({ view: 'project', projectId: 'tc-lane' }, idle), 10);
  });

  it('honours a configured delegate', () => {
    assert.equal(G.tcV6ResolveRouteProject({ view: 'project', projectId: 'tc-lane' }, ROWS, { 'tc-lane': '10' }).id, 10);
  });

  it('resolves a fleet route through its fleet, and refuses a fleet the project does not have', () => {
    assert.equal(resolve({ view: 'fleet', projectId: 'tc-lane', fleetId: 'tc-lane' }), 12);
    assert.equal(resolve({ view: 'fleet', projectId: 'tc-lane', fleetId: 'nope' }), null);
    assert.equal(resolve({ view: 'fleet', projectId: 'workspace', fleetId: 'workspace' }), 30);
  });

  it('returns null for an unknown id, a settings route, no route, or no projects', () => {
    assert.equal(resolve({ view: 'project', projectId: 'ghost' }), null);
    assert.equal(resolve({ view: 'conversation', resourceId: '999' }), null);
    assert.equal(resolve({ view: 'settings', settingsPath: '' }), null);
    assert.equal(resolve(null), null);
    assert.equal(G.tcV6ResolveRouteProject({ view: 'project', projectId: 'tc-lane' }, null), null);
  });
});

describe('tcCreateV6Shell — Classic View link and detail slot (#3022 deliverable a)', () => {
  function mount(opts) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const win = makeFakeWindow((opts && opts.initialHash) || '#/projects/1');
    const shell = G.tcCreateV6Shell(doc, Object.assign({ root, window: win }, opts || {}));
    return { shell, root, win };
  }

  // #3053 removed the inner "← Classic View" link: the page header's
  // Fleet/Classic switcher (#3046) is the one way back, so the shell no
  // longer draws a second one. This assertion moved with that requirement.
  it('draws no inner Classic View link: the page header switcher is the way back (#3053)', () => {
    const { root } = mount();
    assert.doesNotMatch(root.innerHTML, /v6ShellClassicLink|← Classic View/);
  });

  it('setDetail renders into #v6ShellDetail and clears with null', () => {
    const { shell, root } = mount();
    shell.setDetail({ kind: 'plan', plan: { templateId: 'tiny', immediateSeats: [], deferredSeats: [] } });
    assert.match(root.innerHTML, /Plan preview — tiny/);
    shell.setDetail({ kind: 'error', message: 'nope <i>' });
    assert.match(root.innerHTML, /role="alert">nope &lt;i&gt;/);
    shell.setDetail(null);
    assert.doesNotMatch(root.innerHTML, /Plan preview|nope/);
  });
});

describe('tcV6CreateLiveController (#3022 deliverables b–e)', () => {
  const PROJECTS = [
    { id: 10, name: 'TC-Lane-A', model: null, engine: { id: 'claude', name: 'Claude Code' } },
    { id: 11, name: 'TC-Lane-B', model: 'claude-opus-5-5', engine: { id: 'claude', name: 'Claude Code' }, session: { active: true } },
    { id: 30, name: 'TangleClaw', model: null, engine: { id: 'codex', name: 'Codex' } }
  ];

  /**
   * A fake `api()` answering from a url -> value map (a function value is
   * called, and may return a promise); every call is recorded. An unmapped
   * url answers null, the real api()'s failure value.
   */
  function makeApi(map) {
    const calls = [];
    const api = async (url) => {
      calls.push(url);
      const v = map[url];
      return typeof v === 'function' ? v(url) : (v === undefined ? null : v);
    };
    return { api, calls };
  }

  function baseMap(extra) {
    return Object.assign({
      '/api/projects': { projects: PROJECTS },
      '/api/v6/fleet-templates': { templates: [{ id: 'small-4-seat', name: 'Small', seats: [1, 2, 3, 4] }] },
      '/api/sessions/TC-Lane-A/status': { active: false },
      '/api/sessions/TC-Lane-B/status': { active: true, sessionId: 501 },
      '/api/v6/projects/11/sessions/501/conversation/events': { events: [{ seq: 1, role: 'user', content: 'ship it' }] },
      '/api/v6/projects/11/sessions/501/attestations': { attestations: [] }
    }, extra || {});
  }

  /** Mount a real shell wired exactly as public/ui.js wires it. */
  function mountLive(map, opts) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const win = makeFakeWindow((opts && opts.initialHash) || '');
    const { api, calls } = makeApi(map);
    const mutateCalls = [];
    const apiMutate = async (url, method, body) => {
      mutateCalls.push({ url, method, body });
      return (opts && opts.mutate) ? opts.mutate(url) : null;
    };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate });
    shell = G.tcCreateV6Shell(doc, {
      root,
      window: win,
      onLaunchTemplate: (id) => pending.push(live.launchTemplate(id)),
      onRender: (route) => pending.push(live.handleRoute(route))
    });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { shell, root, win, doc, live, calls, mutateCalls, settle, pending };
  }

  it('loads nothing while the Classic View is showing', async () => {
    const { calls, settle } = mountLive(baseMap());
    await settle();
    assert.deepEqual(calls, []);
  });

  it('entering the shell loads the tree, the telemetry bar and the templates', async () => {
    const map = baseMap({
      '/api/v6/projects/tc-lane/telemetry?scope=global': {
        scope: 'global', metrics: { activeSessions: { value: 4, confidence: 'observed' } }
      }
    });
    const { win, root, calls, settle } = mountLive(map);
    win.location.hash = '#/projects/tc-lane';
    await settle();
    assert.ok(calls.includes('/api/projects'));
    assert.ok(calls.includes('/api/v6/projects/tc-lane/telemetry?scope=global'), JSON.stringify(calls));
    assert.ok(calls.includes('/api/v6/fleet-templates'));
    assert.match(root.innerHTML, /TC-Lane Fleet/);
    assert.match(root.innerHTML, /href="#\/resources\/11\/conversation"/);
    assert.match(root.innerHTML, /v6-telemetry-chip is-observed[\s\S]*>4</);
    assert.match(root.innerHTML, /v6ShellWizardLaunch-small-4-seat/);
  });

  it('re-renders caused by its own setters do not refetch (no onRender feedback loop)', async () => {
    const { win, calls, settle } = mountLive(baseMap());
    win.location.hash = '#/projects/tc-lane';
    await settle();
    const count = calls.filter((u) => u === '/api/projects').length;
    assert.equal(count, 1, JSON.stringify(calls));
  });

  it('a conversation route with a live session renders its events, the Open Hood link and the attestation fallback', async () => {
    const { win, root, calls, settle } = mountLive(baseMap());
    win.location.hash = '#/resources/11/conversation';
    await settle();
    assert.ok(calls.includes('/api/v6/projects/11/sessions/501/conversation/events'));
    assert.ok(calls.includes('/api/v6/projects/11/sessions/501/attestations'));
    assert.match(root.innerHTML, /ship it/);
    assert.match(root.innerHTML, /\/session\/TC-Lane-B/);
    assert.match(root.innerHTML, /v6-model-attestation is-estimated[\s\S]*Claude Code/);
  });

  it('prefers a recorded attestation over the fallback', async () => {
    const map = baseMap({
      '/api/v6/projects/11/sessions/501/attestations': {
        attestations: [{ generation: 1, requested_model: 'r', observed_model: 'claude-opus-5-5', confidence: 'observed' }]
      }
    });
    const { win, root, settle } = mountLive(map);
    win.location.hash = '#/resources/11/conversation';
    await settle();
    assert.match(root.innerHTML, /v6-model-attestation is-observed[\s\S]*claude-opus-5-5/);
  });

  it('a project with no live session says so and fetches no session routes', async () => {
    const { win, root, calls, settle } = mountLive(baseMap());
    win.location.hash = '#/resources/10/conversation';
    await settle();
    assert.match(root.innerHTML, /No live session/);
    assert.ok(!calls.some((u) => u.includes('/sessions/') && u.includes('/conversation/events')));
  });

  it('a failed events load is reported, not shown as an empty conversation', async () => {
    const map = baseMap({ '/api/v6/projects/11/sessions/501/conversation/events': null });
    const { win, root, settle } = mountLive(map);
    win.location.hash = '#/resources/11/conversation';
    await settle();
    assert.match(root.innerHTML, /Could not load this session/);
    assert.doesNotMatch(root.innerHTML, /No conversation events recorded/);
  });

  it('a #/projects/:id route naming a real project id shows that project\'s conversation', async () => {
    const { win, root, settle } = mountLive(baseMap());
    win.location.hash = '#/projects/11';
    await settle();
    assert.match(root.innerHTML, /ship it/);
  });

  it('the toggle\'s own landing route hydrates a real member\'s conversation and attestation (PRR-B R1 HOLD)', async () => {
    const { live, win, root, calls, settle } = mountLive(baseMap());
    const hash = await live.enterHash();
    assert.equal(hash, '#/projects/tc-lane');
    win.location.hash = hash;
    await settle();
    assert.ok(calls.includes('/api/v6/projects/11/sessions/501/conversation/events'), JSON.stringify(calls));
    assert.ok(calls.includes('/api/v6/projects/11/sessions/501/attestations'));
    assert.match(root.innerHTML, /ship it/);
    assert.match(root.innerHTML, /\/session\/TC-Lane-B/);
    assert.match(root.innerHTML, /v6-model-attestation is-estimated[\s\S]*Claude Code/);
  });

  it('a fleet route hydrates its member\'s conversation and attestation (PRR-B R1 HOLD)', async () => {
    const { win, root, calls, settle } = mountLive(baseMap());
    win.location.hash = '#/projects/tc-lane/fleets/tc-lane';
    await settle();
    assert.ok(calls.includes('/api/v6/projects/11/sessions/501/conversation/events'), JSON.stringify(calls));
    assert.ok(calls.includes('/api/v6/projects/11/sessions/501/attestations'));
    assert.match(root.innerHTML, /ship it/);
    assert.match(root.innerHTML, /v6-model-attestation is-estimated/);
  });

  it('the Workspace Projects group hydrates its member too', async () => {
    const { win, root, calls, settle } = mountLive(baseMap({ '/api/sessions/TangleClaw/status': { active: false } }));
    win.location.hash = '#/projects/workspace';
    await settle();
    assert.ok(calls.includes('/api/sessions/TangleClaw/status'), JSON.stringify(calls));
    assert.match(root.innerHTML, /\/session\/TangleClaw/);
    assert.match(root.innerHTML, /No live session/);
  });

  it('an unknown resource renders the not-found message', async () => {
    const { win, root, settle } = mountLive(baseMap());
    win.location.hash = '#/resources/999/conversation';
    await settle();
    assert.match(root.innerHTML, /No project matches this resource/);
  });

  it('drops a slow response for a route the operator has already left', async () => {
    let releaseSlow;
    const slow = new Promise((resolve) => { releaseSlow = resolve; });
    const map = baseMap({
      '/api/sessions/TC-Lane-B/status': () => slow.then(() => ({ active: true, sessionId: 501 }))
    });
    const { win, root, settle, pending } = mountLive(map);
    win.location.hash = '#/resources/11/conversation';
    // Let the first load reach its pending status read, then set it aside
    // (it cannot settle until released) and move on to a second route.
    await new Promise((r) => setImmediate(r));
    const slowLoads = pending.splice(0);
    win.location.hash = '#/resources/10/conversation';
    await settle();
    assert.match(root.innerHTML, /No live session/);
    releaseSlow();
    await Promise.all(slowLoads);
    await settle();
    assert.match(root.innerHTML, /No live session/, 'the newer route\'s detail must survive');
    assert.doesNotMatch(root.innerHTML, /ship it/);
  });

  it('launching a template shows its plan preview', async () => {
    const plan = { templateId: 'small-4-seat', immediateSeats: [{ role: 'PM', seatId: 'pm' }], deferredSeats: [{ role: 'Builder', seatId: 'builder-a' }] };
    const { win, doc, root, mutateCalls, settle } = mountLive(baseMap(), { mutate: () => plan });
    win.location.hash = '#/projects/tc-lane';
    await settle();
    doc.getElementById('v6ShellWizardLaunch-small-4-seat').dispatch('click');
    await settle();
    assert.deepEqual(mutateCalls.map((c) => [c.url, c.method]), [['/api/v6/fleet-templates/small-4-seat/plan', 'POST']]);
    assert.match(root.innerHTML, /1 seat\(s\) start immediately, 1 deferred/);
  });

  it('a failed plan request is reported', async () => {
    const { win, doc, root, settle } = mountLive(baseMap());
    win.location.hash = '#/projects/tc-lane';
    await settle();
    doc.getElementById('v6ShellWizardLaunch-small-4-seat').dispatch('click');
    await settle();
    assert.match(root.innerHTML, /Could not plan template/);
  });

  it('enterHash names the first logical project, loading the projects if needed', async () => {
    const { live } = mountLive(baseMap());
    assert.equal(await live.enterHash(), '#/projects/tc-lane');
  });

  it('enterHash falls back to settings when there are no projects', async () => {
    const { live } = mountLive(baseMap({ '/api/projects': { projects: [] } }));
    assert.equal(await live.enterHash(), '#/settings/');
  });

  it('a failed telemetry read leaves the bar unavailable rather than throwing', async () => {
    const { win, root, settle } = mountLive(baseMap());
    win.location.hash = '#/projects/tc-lane';
    await settle();
    assert.match(root.innerHTML, /v6-telemetry-header is-unavailable/);
  });

  it('called before the shell handle exists, it records nothing, so the kick-off call still loads', async () => {
    const G = loadV6Shell();
    const { api, calls } = makeApi(baseMap());
    let shell = null;
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null });
    await live.handleRoute({ view: 'project', projectId: 'tc-lane' });
    assert.deepEqual(calls, []);
    shell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setDetail() {} };
    await live.handleRoute({ view: 'project', projectId: 'tc-lane' });
    assert.ok(calls.includes('/api/projects'));
  });
});

describe('page wiring (#3022 deliverable a) — index.html and ui.js', () => {
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const UI = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

  // #3046 (Gate 0, Charter A673 v1.1): the switcher moved from the Classic
  // toolbar into the page header, so it stays put while the toolbar hides.
  it('puts #v6ViewToggleBtn in the header\'s .dash-actions, and nowhere in the Classic toolbar', () => {
    const actions = HTML.slice(HTML.indexOf('<div class="dash-actions">'), HTML.indexOf('id="masterToggle"'));
    assert.match(actions, /<button type="button" class="dash-action v6-view-toggle" id="v6ViewToggleBtn" aria-label="Switch between Fleet Shell \(v6\) and Classic View">Fleet Shell \(v6\)<\/button>/);
    const toolbar = HTML.slice(HTML.indexOf('<nav class="toolbar"'), HTML.indexOf('</nav>', HTML.indexOf('<nav class="toolbar"')));
    assert.doesNotMatch(toolbar, /v6ViewToggleBtn/);
    assert.equal(HTML.match(/id="v6ViewToggleBtn"/g).length, 1);
  });

  it('ui.js wires the chat\'s send, delegate, refresh and project-settings controls to the live controller (#3047)', () => {
    const block = UI.slice(UI.indexOf("if (typeof window.tcCreateV6Shell === 'function')"));
    assert.match(block, /onSendChat\(text\) \{ v6Live\.sendChat\(text\); \}/);
    assert.match(block, /onChangeDelegate\(nodeId, projectId\) \{ v6Live\.changeDelegate\(nodeId, projectId\); \}/);
    assert.match(block, /onRefreshChat\(\) \{ v6Live\.refresh\(\); \}/);
    assert.match(block, /onOpenProjectSettings\(projectName\) \{ openSettings\(projectName\); \}/);
    assert.match(UI, /^function openSettings\(name, options\) \{/m, 'the settings opener the chat calls exists at top level');
  });

  it('ui.js wires the chat\'s attachment controls to the live controller (#3053)', () => {
    const block = UI.slice(UI.indexOf("if (typeof window.tcCreateV6Shell === 'function')"));
    assert.match(block, /onAttachFiles\(files\) \{ v6Live\.attachFiles\(files\); \}/);
    assert.match(block, /onRemoveAttachment\(index\) \{ v6Live\.removeAttachment\(index\); \}/);
  });

  it('ui.js wires Start, Start fleet and the sidebar refresh to the live controller (#3053)', () => {
    const block = UI.slice(UI.indexOf("if (typeof window.tcCreateV6Shell === 'function')"));
    assert.match(block, /onStartSession\(\) \{ v6Live\.startSession\(\); \}/);
    assert.match(block, /onStartFleet\(\) \{ v6Live\.startFleet\(\); \}/);
    assert.match(block, /onTreeLinkClick\(hash\) \{ v6Live\.treeLinkClicked\(hash\); \}/);
  });

  it('ui.js hides the Classic toolbar while the Fleet View shows, and hands the shell its project rows', () => {
    const block = UI.slice(UI.indexOf("if (typeof window.tcCreateV6Shell === 'function')"));
    assert.match(block, /const v6ClassicToolbar = document\.querySelector\('\.toolbar'\);/);
    assert.match(block, /if \(v6ClassicToolbar\) v6ClassicToolbar\.classList\.toggle\('hidden', active\);/);
  });

  it('ui.js mounts the live controller and wires the toggle to it', () => {
    const block = UI.slice(UI.indexOf("if (typeof window.tcCreateV6Shell === 'function')"));
    assert.match(block, /window\.tcV6CreateLiveController\(\{ getShell: \(\) => v6Shell, api, apiMutate \}\)/);
    assert.match(block, /onLaunchTemplate\(templateId\) \{ v6Live\.launchTemplate\(templateId\); \}/);
    assert.match(block, /v6Live\.handleRoute\(route\)/);
    assert.match(block, /getElementById\('v6ViewToggleBtn'\)/);
    assert.match(block, /v6Shell\.navigate\('#\/'\)/);
    assert.match(block, /v6Shell\.navigate\(await v6Live\.enterHash\(\)\)/);
  });
});

// ── #3046 (Car V622-W1-A): layout, scroll, focus, collapsible drawer and tree nodes ──

/**
 * An in-memory stand-in for `localStorage` (string values, like the real one).
 * @param {object} [seed] - Initial key/value pairs; values are stored as given.
 * @returns {{getItem: Function, setItem: Function, removeItem: Function, data: object}}
 */
function makeStorage(seed) {
  const data = Object.assign(Object.create(null), seed || {});
  return {
    data,
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
}

/**
 * Mount a shell on a mini-dom root with an injectable storage.
 * @param {object} [opts] - Extra `tcCreateV6Shell` options, plus `initialHash`.
 * @returns {{shell: object, doc: object, win: object, root: object, G: object}}
 */
function mountShell(opts) {
  const G = loadV6Shell();
  const { doc } = makeDocument([]);
  const root = doc.createElement('div');
  root.id = 'v6ShellRoot';
  withIdParsingInnerHTML(root, doc);
  doc.body.appendChild(root);
  doc._register(root);
  const win = makeFakeWindow((opts && opts.initialHash) || '#/projects/tc-lane');
  const shell = G.tcCreateV6Shell(doc, Object.assign({ root, window: win }, opts || {}));
  return { shell, doc, win, root, G };
}

const TWO_GROUP_TREE = [
  { id: 'tc-lane', displayName: 'TC-Lane', fleets: [{ id: 'tc-lane', displayName: 'TC-Lane Fleet',
    members: [{ seatId: '11', role: 'TC-Lane-A' }, { seatId: '12', role: 'TC-Lane-PM' }] }] },
  { id: 'medusa', displayName: 'Medusa', fleets: [{ id: 'medusa', displayName: 'Medusa Fleet',
    members: [{ seatId: '21', role: 'Medusa-PM' }] }] }
];

describe('public/style.css grid rows (#3046)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  function ruleBodyFor(selector) {
    const re = new RegExp(`${selector.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
    const match = CSS.match(re);
    return match ? match[1] : null;
  }

  it('gives the root explicit rows, so the sidebar\'s 1 / -1 spans all of them and the main view starts at the top', () => {
    const body = ruleBodyFor('.v6-shell-root');
    assert.match(body, /grid-template-rows:\s*auto\s+1fr\s+auto/);
  });

  it('pins the telemetry header, main view and footer to rows 1, 2 and 3 of column 2', () => {
    assert.match(ruleBodyFor('.v6-telemetry-header'), /grid-row:\s*1;/);
    assert.match(ruleBodyFor('.v6-shell-view'), /grid-row:\s*2;/);
    assert.match(ruleBodyFor('.v6-shell-watermark'), /grid-row:\s*3;/);
  });

  it('makes the sidebar its own sticky scroll container', () => {
    const body = ruleBodyFor('.v6-shell-sidebar');
    assert.match(body, /position:\s*sticky/);
    assert.match(body, /max-height:\s*calc\(100vh - 110px\)/);
    assert.match(body, /overflow-y:\s*auto/);
  });

  it('collapses the sidebar column only on desktop, where the mobile drawer is not in charge', () => {
    const desktop = CSS.slice(CSS.indexOf('@media (min-width: 761px)'));
    assert.ok(CSS.includes('@media (min-width: 761px)'), 'a desktop-only block must exist');
    assert.match(desktop, /\.v6-shell-root--sidebar-collapsed\s*\{\s*grid-template-columns:\s*0\s+1fr;/);
    assert.match(desktop, /\.v6-shell-root--sidebar-collapsed \.v6-shell-sidebar\s*\{\s*display:\s*none;/);
  });
});

describe('tcCreateV6Shell — sidebar scroll and focus survive a re-render (#3046)', () => {
  it('keeps the sidebar\'s scroll position across a re-render', () => {
    const { shell, doc } = mountShell({ tree: TWO_GROUP_TREE });
    doc.getElementById('v6ShellSidebar').scrollTop = 240;
    shell.setTelemetry(null);
    assert.equal(doc.getElementById('v6ShellSidebar').scrollTop, 240);
  });

  it('gives focus back to the same control, caret included, after a re-render', () => {
    const { shell, doc } = mountShell({ tree: TWO_GROUP_TREE });
    const before = doc.getElementById('v6SidebarCollapse');
    before.selectionStart = 2;
    before.selectionEnd = 4;
    before.focus();
    let range = null;
    shell.setTelemetry(null);
    const after = doc.getElementById('v6SidebarCollapse');
    assert.notEqual(after, before, 'the re-render replaced the element');
    assert.equal(doc.activeElement, after);
    after.setSelectionRange = (s, e) => { range = [s, e]; };
    after.focus();
    shell.setTelemetry(null);
    const third = doc.getElementById('v6SidebarCollapse');
    assert.equal(doc.activeElement, third);
    assert.equal(range, null, 'an element with no caret has none restored');
  });

  it('restores a caret position through setSelectionRange when the new element supports it', () => {
    const { shell, doc } = mountShell({ tree: TWO_GROUP_TREE });
    const before = doc.getElementById('v6SidebarCollapse');
    before.selectionStart = 3;
    before.selectionEnd = 5;
    before.focus();
    const seen = [];
    const realGet = doc.getElementById;
    doc.getElementById = (id) => {
      const el = realGet(id);
      if (el && id === 'v6SidebarCollapse' && el !== before) el.setSelectionRange = (s, e) => seen.push([s, e]);
      return el;
    };
    shell.setTelemetry(null);
    assert.deepEqual(seen, [[3, 5]]);
  });

  it('leaves focus alone when nothing inside the shell had it', () => {
    const { shell, doc } = mountShell({ tree: TWO_GROUP_TREE });
    doc.activeElement = null;
    shell.setTelemetry(null);
    assert.equal(doc.activeElement, null);
  });
});

describe('tcCreateV6Shell — collapsible sidebar drawer (#3046)', () => {
  it('Hide Fleet collapses the sidebar, shows Show Fleet in the header, and remembers it', () => {
    const storage = makeStorage();
    const { shell, doc, root } = mountShell({ tree: TWO_GROUP_TREE, storage });
    assert.equal(shell.isSidebarCollapsed(), false);
    assert.match(root.innerHTML, /data-action="toggle-sidebar-drawer"/);
    doc.getElementById('v6SidebarCollapse').dispatch('click');
    assert.equal(shell.isSidebarCollapsed(), true);
    assert.equal(root.classList.contains('v6-shell-root--sidebar-collapsed'), true);
    assert.ok(doc.getElementById('v6SidebarExpand'), 'Show Fleet must render while collapsed');
    assert.match(root.innerHTML, /» Show Fleet/);
    assert.equal(storage.data.tc_v6_sidebar_collapsed, 'true');
  });

  it('Show Fleet expands it again and remembers that too', () => {
    const storage = makeStorage({ tc_v6_sidebar_collapsed: 'true' });
    const { shell, doc, root } = mountShell({ tree: TWO_GROUP_TREE, storage });
    assert.equal(shell.isSidebarCollapsed(), true, 'a remembered collapse is restored on mount');
    doc.getElementById('v6SidebarExpand').dispatch('click');
    assert.equal(shell.isSidebarCollapsed(), false);
    assert.equal(root.classList.contains('v6-shell-root--sidebar-collapsed'), false);
    assert.doesNotMatch(root.innerHTML, /» Show Fleet/);
    assert.equal(storage.data.tc_v6_sidebar_collapsed, 'false');
  });

  it('a storage that throws on every call does not break the mount or the toggle', () => {
    const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const { shell, doc } = mountShell({ tree: TWO_GROUP_TREE, storage });
    doc.getElementById('v6SidebarCollapse').dispatch('click');
    assert.equal(shell.isSidebarCollapsed(), true);
  });

  it('a corrupt stored value is ignored rather than trusted', () => {
    const storage = makeStorage({ tc_v6_sidebar_collapsed: '{not json', tc_v6_collapsed_nodes: '"a string"' });
    const { shell, root } = mountShell({ tree: TWO_GROUP_TREE, storage });
    assert.equal(shell.isSidebarCollapsed(), false);
    assert.match(root.innerHTML, /v6-shell-fleets/);
  });
});

describe('tcCreateV6Shell — collapsible project and fleet nodes (#3046)', () => {
  it('gives every project and fleet that has children a fold toggle, with its node id and state', () => {
    const { root } = mountShell({ tree: TWO_GROUP_TREE });
    const toggles = root.innerHTML.match(/data-action="toggle-tree-node"/g) || [];
    assert.equal(toggles.length, 4, 'two projects and two fleets');
    assert.match(root.innerHTML, /data-node-id="p:tc-lane"[^>]*aria-expanded="true"/);
    assert.match(root.innerHTML, /data-node-id="f:tc-lane\/tc-lane"/);
  });

  it('a project or fleet with nothing under it gets no toggle', () => {
    const { root } = mountShell({ tree: [{ id: 'solo', displayName: 'Solo', fleets: [] }] });
    assert.doesNotMatch(root.innerHTML, /toggle-tree-node/);
  });

  it('folding a project hides its fleets, unfolding shows them, and the state is remembered', () => {
    const storage = makeStorage();
    const { doc, root } = mountShell({ tree: TWO_GROUP_TREE, storage });
    doc.getElementById('v6TreeToggle-p0').dispatch('click');
    assert.doesNotMatch(root.innerHTML, /TC-Lane Fleet/);
    assert.match(root.innerHTML, /Medusa Fleet/, 'only the folded project hides');
    assert.match(root.innerHTML, /data-node-id="p:tc-lane"[^>]*aria-expanded="false"/);
    assert.deepEqual(JSON.parse(storage.data.tc_v6_collapsed_nodes), ['p:tc-lane']);
    doc.getElementById('v6TreeToggle-p0').dispatch('click');
    assert.match(root.innerHTML, /TC-Lane Fleet/);
    assert.deepEqual(JSON.parse(storage.data.tc_v6_collapsed_nodes), []);
  });

  it('folding a fleet hides only its members', () => {
    const { doc, root } = mountShell({ tree: TWO_GROUP_TREE });
    doc.getElementById('v6TreeToggle-f0-0').dispatch('click');
    assert.match(root.innerHTML, /TC-Lane Fleet/);
    assert.doesNotMatch(root.innerHTML, /TC-Lane-PM \(12\)/);
    assert.match(root.innerHTML, /Medusa-PM \(21\)/);
  });

  it('a remembered fold is restored on mount', () => {
    const storage = makeStorage({ tc_v6_collapsed_nodes: JSON.stringify(['p:medusa']) });
    const { root } = mountShell({ tree: TWO_GROUP_TREE, storage });
    assert.doesNotMatch(root.innerHTML, /Medusa Fleet/);
    assert.match(root.innerHTML, /TC-Lane Fleet/);
  });

  // Restated by #3068: the Operator found Expand all did not help and the toolbar dropped it, with Collapse all.
  it('the Expand all and Collapse all buttons are gone; each project and fleet keeps its own fold toggle', () => {
    const { root } = mountShell({ tree: TWO_GROUP_TREE });
    assert.doesNotMatch(root.innerHTML, /v6TreeExpandAll|v6TreeCollapseAll|>Expand all<|>Collapse all</);
    assert.equal((root.innerHTML.match(/data-action="toggle-tree-node"/g) || []).length, 4);
  });

  it('a fold toggle names what it folds for a screen reader, escaped', () => {
    const { root } = mountShell({ tree: [{ id: 'x', displayName: '<b>X</b>', fleets: [{ id: 'f', displayName: 'F', members: [{ seatId: '1', role: 'r' }] }] }] });
    assert.match(root.innerHTML, /aria-label="Collapse &lt;b&gt;X&lt;\/b&gt;"/);
    assert.doesNotMatch(root.innerHTML, /<b>X<\/b>/);
  });
});

// ── #3046 (Car V622-W1-A): single- and multi-select filters for the sidebar tree ──

const FILTER_PROJECTS = [
  { id: 11, name: 'TC-Lane-A', engine: { id: 'claude' } },
  { id: 12, name: 'TC-Lane-PM', engine: { id: 'codex' } },
  { id: 21, name: 'Medusa-PM', engine: { id: 'claude' } }
];

describe('tcV6FilterTree (#3046)', () => {
  const G = loadV6Shell();
  const tree = () => G.tcV6BuildHierarchyTree(TWO_GROUP_TREE);
  const byId = () => new Map(FILTER_PROJECTS.map((p) => [String(p.id), p]));
  const names = (t) => plain(t).flatMap((p) => p.fleets.flatMap((f) => f.members.map((m) => m.role)));

  it('with no filters returns the whole tree', () => {
    assert.deepEqual(names(G.tcV6FilterTree(tree(), {}, byId())), ['TC-Lane-A', 'TC-Lane-PM', 'Medusa-PM']);
  });

  it('text matching a member keeps only matching members; matching a project keeps all of its members', () => {
    assert.deepEqual(names(G.tcV6FilterTree(tree(), { text: '-pm' }, byId())), ['TC-Lane-PM', 'Medusa-PM']);
    assert.deepEqual(names(G.tcV6FilterTree(tree(), { text: 'medusa' }, byId())), ['Medusa-PM']);
    assert.deepEqual(names(G.tcV6FilterTree(tree(), { text: 'TC-LANE FLEET' }, byId())), ['TC-Lane-A', 'TC-Lane-PM']);
  });

  it('drops a project or fleet left with no members', () => {
    const out = plain(G.tcV6FilterTree(tree(), { text: 'Lane-A' }, byId()));
    assert.deepEqual(out.map((p) => p.id), ['tc-lane']);
  });

  it('engine keeps members whose project runs it, and drops members with no project row', () => {
    assert.deepEqual(names(G.tcV6FilterTree(tree(), { engine: 'claude' }, byId())), ['TC-Lane-A', 'Medusa-PM']);
    assert.deepEqual(names(G.tcV6FilterTree(tree(), { engine: 'claude' }, new Map())), []);
  });

  it('a group set keeps only those logical projects, whatever the other filters say', () => {
    assert.deepEqual(names(G.tcV6FilterTree(tree(), { groups: ['medusa'] }, byId())), ['Medusa-PM']);
    assert.deepEqual(names(G.tcV6FilterTree(tree(), { groups: ['medusa', 'tc-lane'] }, byId())), ['TC-Lane-A', 'TC-Lane-PM', 'Medusa-PM']);
    assert.deepEqual(names(G.tcV6FilterTree(tree(), { groups: ['tc-lane'], engine: 'codex' }, byId())), ['TC-Lane-PM']);
  });

  it('filters combine', () => {
    assert.deepEqual(names(G.tcV6FilterTree(tree(), { text: 'pm', engine: 'claude', groups: ['medusa', 'tc-lane'] }, byId())), ['Medusa-PM']);
  });
});

describe('tcCreateV6Shell — filter controls (#3046)', () => {
  function mountWithProjects(opts) {
    const m = mountShell(Object.assign({ tree: TWO_GROUP_TREE }, opts || {}));
    m.shell.setProjects(FILTER_PROJECTS);
    return m;
  }

  // Restated by #3068: the pills, All and Multi became one fleet picker; search and engine sit behind the search toggle.
  it('renders a fleet picker (All Fleets, then one option per logical project) and, once opened, search and engine', () => {
    const { root, doc } = mountWithProjects();
    assert.match(root.innerHTML, /<select id="v6FilterFleet"[^>]*aria-label="Show fleet"[^>]*><option value="" selected>All Fleets<\/option><option value="tc-lane">TC-Lane<\/option><option value="medusa">Medusa<\/option><\/select>/);
    assert.doesNotMatch(root.innerHTML, /v6GroupPill|v6FilterMulti|v6FilterAll/);
    assert.match(root.innerHTML, /<div id="v6SidebarSearch"[^>]*hidden>/, 'search and engine start hidden');
    doc.getElementById('v6SidebarSearchToggle').dispatch('click');
    assert.match(root.innerHTML, /<div id="v6SidebarSearch" class="v6-sidebar-filters" role="search" aria-label="Filter the fleet tree">/);
    assert.match(root.innerHTML, /id="v6FilterSearch"/);
    assert.match(root.innerHTML, /<option value="">All Engines<\/option><option value="claude">claude<\/option><option value="codex">codex<\/option>/);
  });

  it('typing in search filters the tree immediately and keeps focus in the box', () => {
    const { doc, root } = mountWithProjects();
    doc.getElementById('v6SidebarSearchToggle').dispatch('click'); // #3068: search sits behind its toggle
    const box = doc.getElementById('v6FilterSearch');
    box.focus();
    box.value = 'medusa';
    box.dispatch('input');
    assert.doesNotMatch(root.innerHTML, /TC-Lane-A \(11\)/);
    assert.match(root.innerHTML, /Medusa-PM \(21\)/);
    assert.match(root.innerHTML, /id="v6FilterSearch"[^>]*value="medusa"/);
    assert.equal(doc.activeElement, doc.getElementById('v6FilterSearch'));
  });

  it('choosing an engine filters by it and keeps it selected', () => {
    const { doc, root } = mountWithProjects();
    doc.getElementById('v6SidebarSearchToggle').dispatch('click'); // #3068: search sits behind its toggle
    const select = doc.getElementById('v6FilterEngine');
    select.value = 'codex';
    select.dispatch('change');
    assert.match(root.innerHTML, /TC-Lane-PM \(12\)/);
    assert.doesNotMatch(root.innerHTML, /TC-Lane-A \(11\)/);
    assert.match(root.innerHTML, /<option value="codex" selected>/);
  });

  // Restated by #3068: choosing in the picker replaces the pills' single mode.
  it('picking a fleet shows only it, picking another replaces it, and All Fleets clears it; remembered', () => {
    const storage = makeStorage();
    const { doc, root } = mountWithProjects({ storage });
    const pick = (value) => { const el = doc.getElementById('v6FilterFleet'); el.value = value; el.dispatch('change'); };
    pick('medusa');
    assert.doesNotMatch(root.innerHTML, /TC-Lane Fleet/);
    assert.match(root.innerHTML, /<option value="medusa" selected>Medusa<\/option>/);
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), ['medusa']);
    pick('tc-lane');
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), ['tc-lane']);
    pick('tc-lane');
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), ['tc-lane'], 'choosing the same fleet keeps it, unlike the old pill toggle');
    pick('');
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), []);
    assert.match(root.innerHTML, /Medusa Fleet/);
  });

  // Restated by #3068: Multi mode is removed; a several-fleet selection it saved still filters, and says so.
  it('a remembered several-fleet selection keeps filtering and shows as "Several fleets (2)" rather than All Fleets', () => {
    const storage = makeStorage({ tc_v6_selected_groups: JSON.stringify(['tc-lane', 'medusa']), tc_v6_filter_multi_mode: 'true' });
    const { root } = mountWithProjects({ storage });
    assert.match(root.innerHTML, /<option value="">All Fleets<\/option><option value="" disabled selected>Several fleets \(2\)<\/option>/);
    assert.doesNotMatch(root.innerHTML, /<option value="" selected>All Fleets/);
    assert.match(root.innerHTML, /TC-Lane Fleet/);
    assert.match(root.innerHTML, /Medusa Fleet/);
    assert.doesNotMatch(root.innerHTML, /v6FilterMulti/);
  });

  // Restated by #3068: no pills to Ctrl-click; the additive selectGroup API remains.
  it('the additive selectGroup API still adds to the selection, and the picker says how many', () => {
    const { shell, root } = mountWithProjects();
    shell.selectGroup('tc-lane', false);
    assert.match(root.innerHTML, /<option value="tc-lane" selected>TC-Lane<\/option>/);
    shell.selectGroup('medusa', true);
    assert.match(root.innerHTML, /TC-Lane Fleet/);
    assert.match(root.innerHTML, /Medusa Fleet/);
    assert.match(root.innerHTML, /<option value="" disabled selected>Several fleets \(2\)<\/option>/);
    shell.selectGroup('medusa', false);
    shell.selectGroup('medusa', false);
    assert.match(root.innerHTML, /<option value="" selected>All Fleets<\/option>/, 'a non-additive repeat still clears');
  });

  // Restated by #3068: All Fleets in the picker replaces the All pill.
  it('a remembered fleet is restored on mount, selected in the picker, and All Fleets clears it', () => {
    const storage = makeStorage({ tc_v6_selected_groups: JSON.stringify(['medusa']) });
    const { doc, root } = mountWithProjects({ storage });
    assert.doesNotMatch(root.innerHTML, /TC-Lane Fleet/, 'a remembered selection is restored on mount');
    assert.match(root.innerHTML, /<option value="medusa" selected>Medusa<\/option>/);
    const el = doc.getElementById('v6FilterFleet');
    el.value = '';
    el.dispatch('change');
    assert.match(root.innerHTML, /TC-Lane Fleet/);
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), []);
  });

  it('says so when nothing matches, and fold toggles follow the filtered tree', () => {
    const { doc, root } = mountWithProjects();
    const box = doc.getElementById('v6FilterSearch');
    box.value = 'medusa';
    box.dispatch('input');
    assert.match(root.innerHTML, /id="v6TreeToggle-p0"[^>]*data-node-id="p:medusa"/, 'positional ids follow the filtered tree');
    box.value = 'zzz-nothing';
    box.dispatch('input');
    assert.match(root.innerHTML, /No projects match these filters\./);
  });

  it('escapes a hostile engine id and project name in the controls', () => {
    const { shell, root } = mountShell({ tree: [{ id: 'x', displayName: '<i>x</i>', fleets: [] }] });
    shell.setProjects([{ id: 1, name: 'x', engine: { id: '"><script>' } }]);
    assert.doesNotMatch(root.innerHTML, /<script>|<i>x<\/i>/);
  });
});

describe('tcV6CreateLiveController hands the shell its project rows (#3046)', () => {
  it('passes the loaded rows to setProjects, so the engine filter and its options have data', async () => {
    const G = loadV6Shell();
    const rows = [{ id: 11, name: 'TC-Lane-A', engine: { id: 'claude' } }, { id: 12, name: 'TC-Lane-PM', engine: { id: 'codex' } }];
    const api = async (url) => (url === '/api/projects' ? { projects: rows } : null);
    const seen = [];
    const shell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setDetail() {},
      setProjects(r) { seen.push(plain(r)); } };
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null });
    await live.handleRoute({ view: 'settings', settingsPath: '' });
    assert.deepEqual(seen, [rows]);
  });

  it('a shell without setProjects (an older caller) is not broken by it', async () => {
    const G = loadV6Shell();
    const api = async (url) => (url === '/api/projects' ? { projects: [{ id: 1, name: 'a' }] } : null);
    const shell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setDetail() {} };
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null });
    await live.handleRoute({ view: 'settings', settingsPath: '' });
  });
});

// ── #3047 (Car V622-W1-A): Project Delegate Chat ──

const LANE_ROWS = [
  { id: 10, name: 'TC-Lane-A', engine: { id: 'claude' }, session: { active: true } },
  { id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } },
  { id: 14, name: 'TC-Lane-Master', engine: { id: 'claude' } },
  { id: 21, name: 'Medusa-INT', engine: { id: 'claude' } },
  { id: 22, name: 'Medusa-Ops', engine: { id: 'claude' }, session: { active: true } }
];

describe('tcV6ResolveDelegateProject (#3047)', () => {
  const G = loadV6Shell();
  const nodeFor = (id, rows) => plain(G.tcV6SynthesizeTreeFromProjects(rows || LANE_ROWS)).find((n) => n.id === id);
  const pick = (id, state) => {
    const p = G.tcV6ResolveDelegateProject(nodeFor(id, state && state.rows), Object.assign({ projects: LANE_ROWS }, state || {}));
    return p ? p.id : null;
  };

  it('defaults to the -PM member, even when another member has the live session', () => {
    assert.equal(pick('tc-lane'), 12);
  });

  it('takes a -Master member when there is no -PM', () => {
    const rows = LANE_ROWS.filter((r) => r.id !== 12);
    assert.equal(pick('tc-lane', { rows, projects: rows }), 14);
  });

  it('takes a member whose role is pm (a native fleet tree)', () => {
    const node = { id: 'n', fleets: [{ id: 'n', members: [{ seatId: '21', role: 'reviewer' }, { seatId: '22', role: 'PM' }] }] };
    assert.equal(G.tcV6ResolveDelegateProject(node, { projects: LANE_ROWS }).id, 22);
  });

  it('with no PM, falls back to the first member with a live session, then the first member', () => {
    assert.equal(pick('medusa'), 22);
    const idle = LANE_ROWS.map((r) => Object.assign({}, r, { session: null }));
    assert.equal(pick('medusa', { rows: idle, projects: idle }), 21);
  });

  it('a configured delegate wins, but only while it is still a member', () => {
    assert.equal(pick('tc-lane', { delegates: { 'tc-lane': '10' } }), 10);
    assert.equal(pick('tc-lane', { delegates: { 'tc-lane': '22' } }), 12, 'a delegate from another project is ignored');
    assert.equal(pick('tc-lane', { delegates: { 'tc-lane': '999' } }), 12, 'a delegate that no longer exists is ignored');
  });

  it('scopes the choice to one fleet when given', () => {
    const node = { id: 'x', fleets: [
      { id: 'a', members: [{ seatId: '12', role: 'TC-Lane-PM' }] },
      { id: 'b', members: [{ seatId: '10', role: 'TC-Lane-A' }] }
    ] };
    assert.equal(G.tcV6ResolveDelegateProject(node, { projects: LANE_ROWS, fleetId: 'b' }).id, 10);
  });

  it('returns null with no node or no matching rows', () => {
    assert.equal(G.tcV6ResolveDelegateProject(null, { projects: LANE_ROWS }), null);
    assert.equal(G.tcV6ResolveDelegateProject(nodeFor('tc-lane'), { projects: [] }), null);
  });
});

describe('tcV6ConversationViewMarkup — chat (#3047)', () => {
  const G = loadV6Shell();
  const base = (chat, extra) => Object.assign({
    project: { id: 12, name: 'TC-Lane-PM' }, sessionId: 1592, events: [],
    chat: Object.assign({
      mode: 'delegate', nodeId: 'tc-lane', nodeName: 'TC-Lane', status: 'active',
      members: [{ id: '10', name: 'TC-Lane-A' }, { id: '12', name: 'TC-Lane-PM' }]
    }, chat || {})
  }, extra || {});

  it('names who you are talking to, as the project\'s delegate, with its session and status', () => {
    const html = G.tcV6ConversationViewMarkup(base());
    // Restated by #3059: "Talking to:" and the mode are screen-reader text and a tooltip around a compact strip.
    assert.match(html, /Talking to: <\/span><strong>TC-Lane-PM<\/strong> \(#1592\)<span class="sr-only"> · Designated Project Delegate<\/span>/);
    assert.match(html, /<p class="v6-chat-talking-to" title="Talking to TC-Lane-PM \(#1592\) · Designated Project Delegate · Active">/);
    assert.match(html, /<span class="v6-chat-mode" aria-hidden="true">Delegate<\/span>/);
    assert.match(html, /class="v6-chat-pill is-active">Active</);
    assert.match(html, /<h2 class="v6-detail-title">TC-Lane<\/h2>/);
  });

  it('offers every member as the delegate, the current one selected', () => {
    const html = G.tcV6ConversationViewMarkup(base());
    assert.match(html, /<select id="v6ChatDelegate"[^>]*data-action="change-project-delegate"/);
    assert.match(html, /<option value="10">TC-Lane-A<\/option><option value="12" selected>TC-Lane-PM<\/option>/);
  });

  it('a direct session says so and offers the way back to the delegate', () => {
    const html = G.tcV6ConversationViewMarkup(base({ mode: 'direct', delegate: { id: '12', name: 'TC-Lane-PM' } },
      { project: { id: 10, name: 'TC-Lane-A' } }));
    assert.match(html, /Direct Session/);
    assert.doesNotMatch(html, /v6ChatDelegate/);
    // Restated by #3059: a compact chip, its full meaning in its title and accessible name.
    assert.match(html, /<a id="v6ChatToDelegate"[^>]*href="#\/projects\/tc-lane"[^>]*title="Switch to Delegate: TC-Lane-PM" aria-label="Switch to Delegate: TC-Lane-PM"><span aria-hidden="true">⇄<\/span> TC-Lane-PM<\/a>/);
  });

  it('a direct session that is the delegate needs no switch link', () => {
    const html = G.tcV6ConversationViewMarkup(base({ mode: 'direct', delegate: { id: '12', name: 'TC-Lane-PM' } }));
    assert.doesNotMatch(html, /v6ChatToDelegate/);
  });

  it('renders the composer addressed to the target, with Enter/Shift+Enter guidance', () => {
    const html = G.tcV6ConversationViewMarkup(base());
    assert.match(html, /<form id="v6ChatForm" class="v6-chat-composer" data-action="send-chat-form"/);
    assert.match(html, /<textarea id="v6ChatInput" class="v6-chat-input" name="message"[^>]*placeholder="Message TC-Lane-PM… \(Enter to send, Shift\+Enter for newline\)"/);
    assert.match(html, /<button type="submit" id="v6ChatSend" class="btn btn-primary v6-chat-send-btn">Send<\/button>/);
  });

  it('an offline target disables the composer and says why', () => {
    const html = G.tcV6ConversationViewMarkup(base({ status: 'offline' }, { sessionId: null }));
    assert.match(html, /class="v6-chat-pill is-offline">Offline</);
    assert.match(html, /<textarea id="v6ChatInput"[^>]*disabled/);
    assert.match(html, /<button type="submit"[^>]*disabled/);
    assert.match(html, /TC-Lane-PM has no live session/);
  });

  it('an idle session is labelled idle', () => {
    assert.match(G.tcV6ConversationViewMarkup(base({ status: 'idle' })), /class="v6-chat-pill is-idle">Idle</);
  });

  it('shows the live output panel, escaped, only for a live session', () => {
    const html = G.tcV6ConversationViewMarkup(base({ peek: { lines: ['$ ok', '<b>bold</b>'] } }));
    assert.match(html, /<pre id="v6ChatPeek" class="v6-chat-peek"[^>]*>\$ ok\n&lt;b&gt;bold&lt;\/b&gt;<\/pre>/);
    assert.doesNotMatch(G.tcV6ConversationViewMarkup(base({ status: 'offline' }, { sessionId: null })), /v6ChatPeek/);
    assert.match(G.tcV6ConversationViewMarkup(base({ peek: { error: 'gone' } })), /v6ChatPeek[^>]*>Could not read live output: gone</);
    assert.match(G.tcV6ConversationViewMarkup(base()), /v6ChatPeek[^>]*>Waiting for output…</);
  });

  it('renders the send outcome line and the remembered draft, escaped', () => {
    const html = G.tcV6ConversationViewMarkup(base({ send: { kind: 'error', message: 'Not sent: <held>' }, draft: 'half <typed>' }));
    assert.match(html, /<p id="v6ChatStatus" class="v6-chat-send-status is-error" role="status" aria-live="polite">Not sent: &lt;held&gt;<\/p>/);
    assert.match(html, /<textarea id="v6ChatInput"[^>]*>half &lt;typed&gt;<\/textarea>/);
  });

  it('escapes hostile member and node names everywhere they appear', () => {
    const html = G.tcV6ConversationViewMarkup(base({
      nodeName: '<i>n</i>', members: [{ id: '"><x', name: '<script>' }], delegate: { id: '1', name: '<u>d</u>' }
    }, { project: { id: 1, name: '<b>p</b>' } }));
    assert.doesNotMatch(html, /<script>|<i>n<\/i>|<b>p<\/b>|<u>d<\/u>|"><x/);
  });

  it('a view with no chat context still renders the composer for its project', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 7, name: 'X' }, sessionId: 3, events: [] });
    assert.match(html, /v6-chat-composer/);
    assert.match(html, /Direct Session/);
  });
});

describe('tcV6ChatKeyAction (#3047)', () => {
  const G = loadV6Shell();
  it('Enter sends; Shift+Enter, an IME composition, and other keys do not', () => {
    assert.equal(G.tcV6ChatKeyAction({ key: 'Enter' }), 'send');
    assert.equal(G.tcV6ChatKeyAction({ key: 'Enter', shiftKey: true }), null);
    assert.equal(G.tcV6ChatKeyAction({ key: 'Enter', isComposing: true }), null);
    assert.equal(G.tcV6ChatKeyAction({ key: 'a' }), null);
    assert.equal(G.tcV6ChatKeyAction(null), null);
  });
});

describe('Project Delegate Chat, end to end through the shell and live controller (#3047)', () => {
  /**
   * A shell wired to a live controller the way public/ui.js wires them, with
   * an injectable storage, interval timers and api/apiMutate fakes. The fake
   * api carries the real helper's lastError/lastErrorCode side channel.
   */
  function mountChat(opts) {
    const o = opts || {};
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const win = makeFakeWindow(o.initialHash || '#/projects/tc-lane');
    const calls = [];
    const map = Object.assign({
      '/api/projects': { projects: LANE_ROWS },
      '/api/sessions/TC-Lane-PM/status': { active: true, sessionId: 1592, idle: false },
      '/api/sessions/TC-Lane-A/status': { active: true, sessionId: 1660, idle: true },
      '/api/sessions/Medusa-INT/status': { active: false },
      '/api/v6/projects/12/sessions/1592/conversation/events': { events: [{ seq: 1, role: 'user', content: 'earlier' }] },
      '/api/v6/projects/12/sessions/1592/conversation/events?includeDeleted=1': { events: [{ seq: 1 }, { seq: 4, deleted_at: 'x' }] },
      '/api/v6/projects/12/sessions/1592/attestations': { attestations: [] },
      '/api/sessions/TC-Lane-PM/peek?lines=80': { lines: ['pm line 1'] },
      '/api/sessions/TC-Lane-A/peek?lines=80': { lines: ['a line'] }
    }, o.map || {});
    const api = async (url) => {
      calls.push(url);
      const v = map[url];
      return typeof v === 'function' ? v(url) : (v === undefined ? null : v);
    };
    api.lastError = null;
    api.lastErrorCode = null;
    const mutateCalls = [];
    const apiMutate = async (url, method, body) => {
      mutateCalls.push({ url, method, body: plain(body) });
      api.lastError = null;
      api.lastErrorCode = null;
      return o.mutate ? o.mutate(url, plain(body), api, mutateCalls) : { ok: true };
    };
    const timers = [];
    const storage = o.storage || makeStorage();
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({
      getShell: () => shell, api, apiMutate, storage,
      setInterval: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
      clearInterval: (id) => { if (timers[id]) timers[id].cleared = true; }
    });
    shell = G.tcCreateV6Shell(doc, {
      root, window: win, storage,
      onRender: (route) => pending.push(live.handleRoute(route)),
      onSendChat: (text) => pending.push(live.sendChat(text)),
      onChangeDelegate: (nodeId, projectId) => pending.push(live.changeDelegate(nodeId, projectId)),
      onRefreshChat: () => pending.push(live.refresh())
    });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { G, shell, root, doc, win, live, calls, mutateCalls, timers, storage, settle, api };
  }

  async function typeAndSend(m, text) {
    const input = m.doc.getElementById('v6ChatInput');
    input.value = text;
    input.dispatch('input');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await m.settle();
  }

  it('a project route opens a chat with its PM delegate, its live output and its events', async () => {
    const m = mountChat();
    await m.settle();
    assert.ok(m.calls.includes('/api/sessions/TC-Lane-PM/status'));
    assert.ok(m.calls.includes('/api/sessions/TC-Lane-PM/peek?lines=80'));
    assert.match(m.root.innerHTML, /Talking to: <\/span><strong>TC-Lane-PM<\/strong> \(#1592\)/);
    assert.match(m.root.innerHTML, /pm line 1/);
    assert.match(m.root.innerHTML, /earlier/);
  });

  it('a remembered delegate is used', async () => {
    const m = mountChat({ storage: makeStorage({ tc_v6_project_delegates: JSON.stringify({ 'tc-lane': '10' }) }) });
    await m.settle();
    assert.match(m.root.innerHTML, /Talking to: <\/span><strong>TC-Lane-A<\/strong> \(#1660\)/);
    assert.match(m.root.innerHTML, /class="v6-chat-pill is-idle">Idle</);
  });

  it('changing the delegate remembers it and reloads the chat for the new one', async () => {
    const m = mountChat();
    await m.settle();
    const select = m.doc.getElementById('v6ChatDelegate');
    select.value = '10';
    select.dispatch('change');
    await m.settle();
    assert.deepEqual(JSON.parse(m.storage.data.tc_v6_project_delegates), { 'tc-lane': '10' });
    assert.match(m.root.innerHTML, /Talking to: <\/span><strong>TC-Lane-A<\/strong>/);
  });

  it('a member route is a direct session, with the way back to the delegate', async () => {
    const m = mountChat({ initialHash: '#/resources/10/conversation' });
    await m.settle();
    assert.match(m.root.innerHTML, /Direct Session/);
    assert.match(m.root.innerHTML, /Switch to Delegate: TC-Lane-PM/);
  });

  it('sending types the message into the session, records it with the next seq, and confirms', async () => {
    const m = mountChat();
    await m.settle();
    await typeAndSend(m, 'ship the release');
    assert.deepEqual(m.mutateCalls[0], {
      url: '/api/sessions/TC-Lane-PM/command', method: 'POST', body: { command: 'ship the release', enter: true }
    });
    assert.deepEqual(m.mutateCalls[1], {
      url: '/api/v6/projects/12/sessions/1592/conversation/events', method: 'POST',
      body: { launchId: 'v6-chat-ui', seq: 5, tier: 'A', adapter: 'v6-chat-ui', role: 'user', content: 'ship the release' }
    });
    assert.match(m.root.innerHTML, /v6-chat-send-status is-ok[^>]*>Sent to TC-Lane-PM\.</);
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*><\/textarea>/, 'the composer is cleared');
  });

  it('records with the session\'s own launch id when its status carries one', async () => {
    const m = mountChat({ map: { '/api/sessions/TC-Lane-PM/status': { active: true, sessionId: 1592, launchId: 'L-77' } } });
    await m.settle();
    await typeAndSend(m, 'hi');
    assert.equal(m.mutateCalls[1].body.launchId, 'L-77');
  });

  it('a refused message says why, records nothing, and keeps the text', async () => {
    const m = mountChat({
      mutate: (url, body, api) => {
        if (url.endsWith('/command')) { api.lastError = 'Lane is held by its coordinator'; api.lastErrorCode = 'CONTROL_HELD'; return null; }
        return { ok: true };
      }
    });
    await m.settle();
    await typeAndSend(m, 'keep me');
    assert.equal(m.mutateCalls.length, 1, 'no conversation event for a message that was not sent');
    assert.match(m.root.innerHTML, /v6-chat-send-status is-error[^>]*>Not sent: Lane is held by its coordinator</);
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*>keep me<\/textarea>/);
  });

  it('retries the record once on a seq conflict, with a freshly read seq', async () => {
    let reads = 0;
    const m = mountChat({
      map: { '/api/v6/projects/12/sessions/1592/conversation/events?includeDeleted=1': () => ({ events: [{ seq: 3 + reads++ }] }) },
      mutate: (url, body, api, sent) => {
        if (url.endsWith('/conversation/events') && sent.filter((c) => c.url.endsWith('/conversation/events')).length === 1) {
          api.lastError = 'seq taken'; api.lastErrorCode = 'SEQ_CONFLICT'; return null;
        }
        return { ok: true };
      }
    });
    await m.settle();
    await typeAndSend(m, 'race');
    const events = m.mutateCalls.filter((c) => c.url.endsWith('/conversation/events'));
    assert.deepEqual(events.map((c) => c.body.seq), [4, 5]);
    assert.match(m.root.innerHTML, /is-ok[^>]*>Sent to TC-Lane-PM\.</);
  });

  it('a message that was sent but could not be recorded says exactly that', async () => {
    const m = mountChat({
      mutate: (url, body, api) => {
        if (url.endsWith('/conversation/events')) { api.lastError = 'boom'; api.lastErrorCode = 'INTERNAL'; return null; }
        return { ok: true };
      }
    });
    await m.settle();
    await typeAndSend(m, 'x');
    assert.match(m.root.innerHTML, /is-warning[^>]*>Sent to TC-Lane-PM, but it could not be recorded in the conversation: boom</);
  });

  it('an empty or blank message sends nothing', async () => {
    const m = mountChat();
    await m.settle();
    await typeAndSend(m, '   \n ');
    assert.equal(m.mutateCalls.length, 0);
  });

  it('a target with no live session is not typed into', async () => {
    const m = mountChat({ storage: makeStorage({ tc_v6_project_delegates: JSON.stringify({ medusa: '21' }) }), initialHash: '#/projects/medusa' });
    await m.settle();
    await m.live.sendChat('hello');
    assert.equal(m.mutateCalls.length, 0);
    assert.match(m.root.innerHTML, /Medusa-INT has no live session/);
    // #3053: an offline chat polls its status (to turn Active by itself),
    // never its pane, which has nothing to show.
    assert.equal(m.timers.length, 1);
    const before = m.calls.length;
    await m.timers[0].fn();
    assert.deepEqual(m.calls.slice(before), ['/api/sessions/Medusa-INT/status']);
  });

  it('polls the live output every 4 s without re-rendering the composer, and stops when the route changes', async () => {
    let n = 0;
    const m = mountChat({ map: { '/api/sessions/TC-Lane-PM/peek?lines=80': () => ({ lines: [`tick ${n++}`] }) } });
    await m.settle();
    assert.equal(m.timers.length, 1);
    assert.equal(m.timers[0].ms, 4000);
    const input = m.doc.getElementById('v6ChatInput');
    await m.timers[0].fn();
    assert.match(m.doc.getElementById('v6ChatPeek').innerHTML, /tick 1/);
    assert.equal(m.doc.getElementById('v6ChatInput'), input, 'a peek refresh leaves the composer element alone');
    m.win.location.hash = '#/settings/';
    await m.settle();
    assert.equal(m.timers[0].cleared, true);
  });

  it('a poll that lands after the operator moved on is dropped', async () => {
    const m = mountChat();
    await m.settle();
    const tick = m.timers[0].fn;
    m.win.location.hash = '#/projects/medusa';
    await m.settle();
    const before = m.root.innerHTML;
    await tick();
    assert.equal(m.root.innerHTML, before);
  });

  it('Refresh reloads the conversation', async () => {
    const m = mountChat();
    await m.settle();
    const statusReads = () => m.calls.filter((u) => u === '/api/sessions/TC-Lane-PM/status').length;
    const first = statusReads();
    m.doc.getElementById('v6ChatRefresh').dispatch('click');
    await m.settle();
    assert.equal(statusReads(), first + 1);
  });

  it('the draft survives a re-render that is not a send', async () => {
    const m = mountChat();
    await m.settle();
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'half typed';
    input.dispatch('input');
    m.shell.setTelemetry(null);
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*>half typed<\/textarea>/);
  });
});

describe('remembered settings without a usable store (#3047)', () => {
  it('a delegate change still takes effect for this page when storage is unavailable', async () => {
    const G = loadV6Shell();
    const rows = LANE_ROWS;
    const api = async (url) => ({
      '/api/projects': { projects: rows },
      '/api/sessions/TC-Lane-PM/status': { active: false },
      '/api/sessions/TC-Lane-A/status': { active: false }
    })[url] || null;
    let route = { view: 'project', projectId: 'tc-lane' };
    const views = [];
    const shell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setProjects() {},
      setDetail(d) { if (d && d.kind === 'conversation') views.push(plain(d.view)); }, getRoute: () => route };
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null });
    await live.handleRoute(route);
    assert.equal(views[views.length - 1].project.name, 'TC-Lane-PM');
    await live.changeDelegate('tc-lane', '10');
    assert.equal(views[views.length - 1].project.name, 'TC-Lane-A');
  });
});

describe('the page header holds the Fleet/Classic switcher without overflowing (#3046)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  it('the base .dash-bar wraps, so the action pills drop a row instead of running off the right edge', () => {
    const body = CSS.match(/(^|\n)\.dash-bar\s*\{([^}]*)\}/)[2];
    assert.match(body, /flex-wrap:\s*wrap/);
  });
});

describe('Project Delegate Chat review fixes (#3047)', () => {
  function mountPair(opts) {
    const o = opts || {};
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const win = makeFakeWindow(o.initialHash || '#/projects/tc-lane');
    const calls = [];
    let rows = LANE_ROWS;
    const map = {
      '/api/sessions/TC-Lane-PM/status': { active: true, sessionId: 1592 },
      '/api/sessions/TC-Lane-A/status': { active: true, sessionId: 1660 },
      '/api/v6/projects/12/sessions/1592/conversation/events': { events: [] },
      '/api/v6/projects/10/sessions/1660/conversation/events': { events: [] }
    };
    const api = async (url) => { calls.push(url); if (url === '/api/projects') return { projects: rows }; return map[url] === undefined ? null : map[url]; };
    const mutateCalls = [];
    let release = null;
    const apiMutate = async (url, method, body) => {
      mutateCalls.push({ url, body: plain(body) });
      if (o.hold && url.endsWith('/command')) await new Promise((r) => { release = r; });
      return { ok: true };
    };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate, storage: null });
    shell = G.tcCreateV6Shell(doc, {
      root, window: win, storage: null,
      onRender: (route) => pending.push(live.handleRoute(route)),
      onSendChat: (text) => pending.push(live.sendChat(text))
    });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { shell, root, doc, win, live, calls, mutateCalls, settle, setRows: (r) => { rows = r; }, release: () => release && release() };
  }

  it('an unsent message stays with its own chat and never follows the operator to another one', async () => {
    const m = mountPair();
    await m.settle();
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'for the PM only';
    input.dispatch('input');
    m.win.location.hash = '#/resources/10/conversation';
    await m.settle();
    assert.match(m.root.innerHTML, /Talking to: <\/span><strong>TC-Lane-A<\/strong>/);
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*><\/textarea>/, 'the other chat starts empty');
    m.win.location.hash = '#/projects/tc-lane';
    await m.settle();
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*>for the PM only<\/textarea>/, 'the draft is still there on return');
  });

  it('a second Enter or Send while the first is still sending is ignored, and Send is disabled meanwhile', async () => {
    const m = mountPair({ hold: true });
    await m.settle();
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'once';
    input.dispatch('input');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    // Restated by #3082 (Ruling A757): the box stays open so Force Send can push an urgent
    // message in meanwhile; Send itself stays disabled, so a plain second send cannot happen.
    assert.doesNotMatch(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*disabled/);
    assert.match(m.root.innerHTML, /<button type="submit"[^>]*disabled/);
    assert.doesNotMatch(m.root.innerHTML, /<button type="button" id="v6ChatForceSend"[^>]*disabled/);
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await m.live.sendChat('once');
    m.release();
    await m.settle();
    assert.equal(m.mutateCalls.filter((c) => c.url.endsWith('/command')).length, 1);
    assert.match(m.root.innerHTML, /Sent to TC-Lane-PM\./);
  });

  it('a message sent while the operator left the chat is not waiting to be sent again on return', async () => {
    const m = mountPair({ hold: true });
    await m.settle();
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'sent once';
    input.dispatch('input');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    m.win.location.hash = '#/resources/10/conversation';
    await new Promise((r) => setImmediate(r));
    m.release();
    await m.settle();
    m.win.location.hash = '#/projects/tc-lane';
    await m.settle();
    assert.equal(m.mutateCalls.filter((c) => c.url.endsWith('/command')).length, 1);
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*><\/textarea>/, 'the sent text does not come back');
  });

  it('a message delivered after the operator left the chat is still recorded, against its own target, and the new chat is untouched', async () => {
    const m = mountPair({ hold: true });
    await m.settle();
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'record me';
    input.dispatch('input');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    m.win.location.hash = '#/resources/10/conversation';
    await new Promise((r) => setImmediate(r));
    m.release();
    await m.settle();
    const commands = m.mutateCalls.filter((c) => c.url.endsWith('/command'));
    const events = m.mutateCalls.filter((c) => c.url.endsWith('/conversation/events'));
    assert.deepEqual(commands.map((c) => c.url), ['/api/sessions/TC-Lane-PM/command']);
    assert.deepEqual(events.map((c) => [c.url, c.body.content, c.body.role]),
      [['/api/v6/projects/12/sessions/1592/conversation/events', 'record me', 'user']]);
    assert.match(m.root.innerHTML, /Talking to: <\/span><strong>TC-Lane-A<\/strong>/, 'the chat on screen is still the one the operator moved to');
    assert.doesNotMatch(m.root.innerHTML, /Sent to TC-Lane-PM/, 'no stale outcome line lands in the other chat');
  });

  it('Refresh hands the freshly read project rows to the sidebar and its engine filter', async () => {
    const m = mountPair();
    await m.settle();
    m.setRows(LANE_ROWS.concat([{ id: 30, name: 'TC-Lane-New', engine: { id: 'codex' } }]));
    await m.live.refresh();
    await m.settle();
    assert.match(m.root.innerHTML, /TC-Lane-New \(30\)/);
    assert.match(m.root.innerHTML, /<option value="codex">codex<\/option>/);
  });
});

describe('Hide Fleet / Show Fleet keep keyboard focus (#3046)', () => {
  it('focus moves to the control that undoes the action, rather than to the page', () => {
    const { doc } = mountShell({ tree: TWO_GROUP_TREE, storage: null });
    const hide = doc.getElementById('v6SidebarCollapse');
    hide.focus();
    hide.dispatch('click');
    assert.equal(doc.activeElement, doc.getElementById('v6SidebarExpand'));
    doc.getElementById('v6SidebarExpand').dispatch('click');
    assert.equal(doc.activeElement, doc.getElementById('v6SidebarCollapse'));
  });
});

// ── #3052 (Car V623-W1-A): Above-the-Hood turns from a session's live output ──
// Synthetic pane text per engine, built from the markers #3052 names: no real
// session content is captured into this repo.

const PANES = {
  claude: [
    'When the user wants to wrap up, run the wrap protocol.',
    '### Medusa consumer contract (read docs/CONSUMER-CONTRACT.md)',
    '[TangleClaw Switchboard] You have 1 unread Medusa message(s): tc message read.',
    '> ship the release',
    '⏺ I\'ll check the branch first.',
    '⏺ Bash(git status)',
    '  ⎿  On branch main',
    '     nothing to commit',
    '⏺ The branch is clean.',
    '  Should I push it?',
    '╭──────────────────────────────────╮',
    '│ >                                │',
    '╰──────────────────────────────────╯',
    '  ? for shortcuts'
  ],
  codex: [
    'TangleClaw\'d into existence. Reading launch context via tc start next.',
    '› run the tests',
    '• Ran npm test',
    '  └ 12 passing',
    '▸ Thought for 3s',
    '• All 12 tests pass.',
    '⣷ Running command (esc to interrupt)',
    '───────────────────────────',
    '› '
  ],
  antigravity: [
    '❯ fix the button',
    '○ Thought for 4s',
    '● Ran npm test',
    '● Explored 3 files',
    '… 2 more actions …',
    '● Edited public/ui.js',
    'The button now confirms on a second click.',
    'Does that match what you wanted?',
    '❯ ',
    'How\'s the CLI experience so far? (1-5)'
  ],
  aider: [
    '> add a test for the empty case',
    'Tokens: 1.2k sent, 300 received. Cost: $0.01 message.',
    'Applied edit to test/a.test.js',
    'I added a regression test for the empty case.',
    'Commit 1a2b3c4 add empty-case test',
    '> '
  ]
};

describe('tcV6ExtractLiveTurns (#3052)', () => {
  const G = loadV6Shell();
  const run = (engine, known) => plain(G.tcV6ExtractLiveTurns(PANES[engine], engine, known || []));

  it('claude: keeps the replies, drops boilerplate, wakes, tool calls and their output, and the prompt box', () => {
    const out = run('claude');
    assert.deepEqual(out.turns, [
      { role: 'user', text: 'ship the release' },
      { role: 'assistant', text: 'I\'ll check the branch first.\nThe branch is clean.\nShould I push it?' }
    ]);
    assert.equal(out.question, 'Should I push it?');
    assert.equal(out.activity, null);
  });

  it('codex: drops Ran/Thought lines and reports the running spinner as activity', () => {
    const out = run('codex');
    assert.deepEqual(out.turns, [
      { role: 'user', text: 'run the tests' },
      { role: 'assistant', text: 'All 12 tests pass.' }
    ]);
    assert.equal(out.question, null);
    assert.match(out.activity, /Running command/);
  });

  it('antigravity: drops ○/● tool lines, the action fold and the CLI survey', () => {
    const out = run('antigravity');
    assert.deepEqual(out.turns, [
      { role: 'user', text: 'fix the button' },
      { role: 'assistant', text: 'The button now confirms on a second click.\nDoes that match what you wanted?' }
    ]);
    assert.equal(out.question, 'Does that match what you wanted?');
  });

  it('aider: drops token, applied-edit and commit lines', () => {
    const out = run('aider');
    assert.deepEqual(out.turns, [
      { role: 'user', text: 'add a test for the empty case' },
      { role: 'assistant', text: 'I added a regression test for the empty case.' }
    ]);
  });

  it('a prompt already recorded as a user event is not repeated', () => {
    const out = run('claude', ['ship the release']);
    // Restated by #3079 item 6: it keeps its place among the replies, once, marked recorded.
    assert.deepEqual(out.turns, [{ role: 'user', text: 'ship the release', recorded: true },
      { role: 'assistant', text: 'I\'ll check the branch first.\nThe branch is clean.\nShould I push it?' }]);
  });

  it('a question the operator has already answered is no longer pinned', () => {
    const lines = PANES.antigravity.slice(0, 8).concat(['❯ yes, ship it', 'Shipping now.']);
    const out = plain(G.tcV6ExtractLiveTurns(lines, 'antigravity', []));
    assert.equal(out.question, null);
    assert.equal(out.turns[out.turns.length - 1].text, 'Shipping now.');
  });

  it('strips terminal colour codes and keeps any line it does not recognise', () => {
    const out = plain(G.tcV6ExtractLiveTurns(['> hi', '\u001b[32mHello there\u001b[0m', 'An unusual line: 42%'], 'claude', []));
    assert.deepEqual(out.turns[1], { role: 'assistant', text: 'Hello there\nAn unusual line: 42%' });
  });

  it('an unknown engine uses every engine\'s markers; empty or malformed input yields nothing', () => {
    assert.deepEqual(run('antigravity').turns, plain(G.tcV6ExtractLiveTurns(PANES.antigravity, 'mystery', [])).turns);
    // Restated by #3076/#3079: the result also carries the question queue and the switchboard's traffic.
    assert.deepEqual(plain(G.tcV6ExtractLiveTurns(null, 'claude', [])), { turns: [], question: null, questions: [], activity: null, switchboard: [] });
    assert.deepEqual(plain(G.tcV6ExtractLiveTurns([null, 7, '   '], 'claude', [])).turns, []);
  });

  it('activity is reported only while the busy marker is the latest thing on screen', () => {
    const settled = PANES.codex.slice(0, 6).concat(['• Done. Anything else?', '› ']);
    assert.equal(plain(G.tcV6ExtractLiveTurns(settled, 'codex', [])).activity, null);
    const thinking = ['> go', '✶ Thinking… (esc to interrupt)'];
    assert.match(plain(G.tcV6ExtractLiveTurns(thinking, 'claude', [])).activity, /Thinking/);
  });
});

describe('Above-the-Hood chat view (#3052)', () => {
  const G = loadV6Shell();
  const view = (chat, extra) => Object.assign({
    project: { id: 12, name: 'TC-Lane-PM' }, sessionId: 1592,
    events: [{ seq: 1, role: 'user', content: 'ship the release' }],
    chat: Object.assign({ mode: 'delegate', nodeId: 'tc-lane', nodeName: 'TC-Lane', status: 'active', members: [] }, chat || {})
  }, extra || {});

  it('shows live assistant turns as ASSISTANT (<project>) bubbles after the recorded events', () => {
    const html = G.tcV6ConversationViewMarkup(view({ live: { turns: [{ role: 'assistant', text: 'The branch is clean.' }], question: null, activity: null } }));
    assert.match(html, /<ol id="v6ChatLive" class="v6-conversation-stream v6-chat-live-turns"[^>]*><li class="v6-conversation-event is-assistant is-live">/);
    assert.match(html, /<span class="v6-conversation-role">assistant <span class="v6-conversation-who">\(TC-Lane-PM\)<\/span><\/span>/);
    assert.match(html, /The branch is clean\./);
    assert.ok(html.indexOf('ship the release') < html.indexOf('The branch is clean.'), 'recorded events come first');
  });

  it('pins the question the assistant is waiting on, and shows what it is busy doing, above the composer', () => {
    const html = G.tcV6ConversationViewMarkup(view({ live: { turns: [], question: 'Should I <push>?', activity: 'Running command' } }));
    assert.match(html, /<div id="v6ChatQuestion" class="v6-chat-question is-asking"[^>]*>[\s\S]*Should I &lt;push&gt;\?/);
    // Restated by #3057: the busy line now carries animated dots and an elapsed time after its label.
    assert.match(html, /<p id="v6ChatActivity" class="v6-chat-activity is-busy"[^>]*><span class="v6-chat-activity-label">Running command<\/span><span class="v6-chat-activity-dots" aria-hidden="true"><\/span> <span id="v6ChatActivityTimer" class="v6-chat-activity-timer" aria-hidden="true">0s<\/span><\/p>/);
    assert.ok(html.indexOf('v6ChatQuestion') < html.indexOf('v6ChatForm'));
  });

  it('keeps empty question and activity slots, so a poll can fill them in place', () => {
    const html = G.tcV6ConversationViewMarkup(view({ live: null }));
    assert.match(html, /<div id="v6ChatQuestion" class="v6-chat-question"[^>]*><\/div>/);
    assert.match(html, /<p id="v6ChatActivity" class="v6-chat-activity"[^>]*><\/p>/);
    assert.match(html, /<ol id="v6ChatLive"[^>]*><\/ol>/);
  });

  it('puts the raw output in a collapsed Under the Hood drawer, open only when asked', () => {
    const closed = G.tcV6ConversationViewMarkup(view({ peek: { lines: ['$ ok'] } }));
    // Restated by #3076: the switchboard's traffic list sits above the raw output, inside the drawer.
    // Restated by #3082: the summary carries the tucked count, and the verbosity filter and the
    // tucked list come first.
    assert.match(closed, /<details id="v6ChatUnderHood" class="v6-chat-under-hood">\s*<summary>🔧 Under the Hood \(Raw CLI &amp; Tool Activity\) <span id="v6ChatTuckedCount" class="v6-chat-tucked-count"><\/span><\/summary>\s*<fieldset class="v6-chat-verbosity">[\s\S]*?<\/fieldset>\s*<section class="v6-chat-tucked"[\s\S]*?<\/section>\s*<section class="v6-chat-switchboard"[\s\S]*?<\/section>\s*<pre id="v6ChatPeek"/);
    assert.match(G.tcV6ConversationViewMarkup(view({ peek: { lines: [] }, hoodOpen: true })), /<details id="v6ChatUnderHood" class="v6-chat-under-hood" open>/);
  });

  it('wraps both streams in one scroll container', () => {
    assert.match(G.tcV6ConversationViewMarkup(view()), /<div id="v6ChatStream" class="v6-chat-stream"[^>]*>\s*<ol class="v6-conversation-stream"/);
  });

  it('with no recorded events but live turns, shows the turns instead of "no events"', () => {
    const html = G.tcV6ConversationViewMarkup(view({ live: { turns: [{ role: 'assistant', text: 'hi' }] } }, { events: [] }));
    assert.doesNotMatch(html, /No conversation events recorded/);
    assert.match(html, /is-live/);
  });
});

describe('Above-the-Hood chat, live in the shell (#3052)', () => {
  function mountLiveChat(peeks) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const win = makeFakeWindow('#/projects/tc-lane');
    let n = 0;
    const rows = [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }, { id: 10, name: 'TC-Lane-A', engine: { id: 'claude' } }];
    const api = async (url) => {
      if (url === '/api/projects') return { projects: rows };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1592 };
      if (url === '/api/v6/projects/12/sessions/1592/conversation/events') return { events: [{ seq: 1, role: 'user', content: 'ship the release' }] };
      if (url === '/api/sessions/TC-Lane-PM/peek?lines=80') return { lines: peeks[Math.min(n++, peeks.length - 1)] };
      return null;
    };
    const timers = [];
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => ({ ok: true }), storage: null,
      setInterval: (fn, ms) => { timers.push(fn); return timers.length - 1; }, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: win, storage: null, onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { shell, root, doc, timers, settle };
  }

  it('extracts the reply from the peek with the project\'s engine, without repeating the recorded prompt', async () => {
    const m = mountLiveChat([PANES.claude]);
    await m.settle();
    assert.match(m.root.innerHTML, /is-live[\s\S]*The branch is clean\./);
    // The raw drawer shows the pane as it is; the conversation must not repeat the prompt.
    const html = m.root.innerHTML;
    const conversation = html.slice(html.indexOf('id="v6ChatStream"'), html.indexOf('id="v6ChatUnderHood"'));
    assert.equal((conversation.match(/ship the release/g) || []).length, 1, 'the recorded prompt is not shown twice');
    assert.match(m.root.innerHTML, /v6-chat-question is-asking[\s\S]*Should I push it\?/);
  });

  it('a poll updates the live turns, question and activity in place, leaving the composer alone', async () => {
    const m = mountLiveChat([PANES.claude, ['> ship the release', '⏺ Pushing now.', '✶ Thinking… (esc to interrupt)']]);
    await m.settle();
    const input = m.doc.getElementById('v6ChatInput');
    await m.timers[0]();
    assert.match(m.doc.getElementById('v6ChatLive').innerHTML, /Pushing now\./);
    assert.equal(m.doc.getElementById('v6ChatQuestion').innerHTML, '');
    assert.match(m.doc.getElementById('v6ChatActivity').innerHTML, /Thinking/);
    assert.equal(m.doc.getElementById('v6ChatInput'), input);
  });

  it('the Under the Hood drawer stays open across re-renders once the operator opens it', async () => {
    const m = mountLiveChat([PANES.claude]);
    await m.settle();
    const hood = m.doc.getElementById('v6ChatUnderHood');
    hood.open = true;
    hood.dispatch('toggle');
    m.shell.setTelemetry(null);
    assert.match(m.root.innerHTML, /<details id="v6ChatUnderHood" class="v6-chat-under-hood" open>/);
  });

  it('scrolls the conversation and the raw output to the bottom on first render', async () => {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const realGet = doc.getElementById;
    doc.getElementById = (id) => {
      const el = realGet(id);
      if (el && (id === 'v6ChatStream' || id === 'v6ChatPeek') && el.scrollHeight === undefined) {
        el.scrollHeight = 900; el.clientHeight = 300; el.scrollTop = 0;
      }
      return el;
    };
    const shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/projects/tc-lane'), storage: null });
    shell.setDetail({ kind: 'conversation', view: { project: { id: 12, name: 'TC-Lane-PM' }, sessionId: 1, events: [],
      chat: { status: 'active', peek: { lines: ['x'] } } } });
    assert.equal(doc.getElementById('v6ChatStream').scrollTop, 900);
    assert.equal(doc.getElementById('v6ChatPeek').scrollTop, 900);
  });
});

// ── #3053 (Car V623-W1-A): attachments in the chat composer ──

describe('tcV6SanitizeUploadName (#3053)', () => {
  const G = loadV6Shell();
  const clean = (name, taken) => G.tcV6SanitizeUploadName(name, new Set(taken || []));

  it('turns a browser file name into one the secure-clipboard route accepts', () => {
    assert.equal(clean('Screenshot 2026-11-13 at 10.00 AM.png'), 'Screenshot-2026-11-13-at-10.00-AM.png');
    assert.equal(clean('../etc/passwd'), 'etc-passwd');
    assert.equal(clean('café notes (v2).txt'), 'caf-notes-v2.txt');
  });

  it('never yields an empty, dot-only or over-long name', () => {
    assert.equal(clean(''), 'attachment');
    assert.equal(clean('..'), 'attachment');
    assert.equal(clean('???'), 'attachment');
    const long = clean(`${'a'.repeat(200)}.png`);
    assert.equal(long.length, 128);
    assert.match(long, /\.png$/);
    for (const name of ['Screenshot 1.png', '../x', '..', '']) assert.match(clean(name), /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/);
  });

  it('suffixes a name already taken in the same chat', () => {
    assert.equal(clean('a.png', ['a.png']), 'a-2.png');
    assert.equal(clean('a.png', ['a.png', 'a-2.png']), 'a-3.png');
    assert.equal(clean('README', ['README']), 'README-2');
  });
});

describe('tcV6FilesFromEvent (#3053)', () => {
  const G = loadV6Shell();
  it('reads files from a drop, a paste (files or file items) and a file input; nothing else', () => {
    const f = { name: 'a.png', size: 3 };
    assert.equal(G.tcV6FilesFromEvent({ dataTransfer: { files: [f] } }).length, 1);
    assert.equal(G.tcV6FilesFromEvent({ clipboardData: { files: [f] } }).length, 1);
    assert.equal(G.tcV6FilesFromEvent({ clipboardData: { files: [], items: [{ kind: 'file', getAsFile: () => f }, { kind: 'string' }] } }).length, 1);
    assert.equal(G.tcV6FilesFromEvent({ target: { files: [f, f] } }).length, 2);
    assert.equal(G.tcV6FilesFromEvent({ clipboardData: { files: [], items: [{ kind: 'string' }] } }).length, 0);
    assert.equal(G.tcV6FilesFromEvent(null).length, 0);
  });
});

describe('chat composer attachment markup (#3053)', () => {
  const G = loadV6Shell();
  const v = (chat) => ({ project: { id: 12, name: 'TC-Lane-PM' }, sessionId: 1, events: [],
    chat: Object.assign({ status: 'active' }, chat || {}) });

  it('offers an Attach button and a hidden multi-file input inside the composer', () => {
    const html = G.tcV6ConversationViewMarkup(v());
    assert.match(html, /<button type="button" id="v6ChatAttachBtn" class="btn btn-secondary btn-small v6-chat-attach-btn"[^>]*>📎 Attach<\/button>/);
    assert.match(html, /<input type="file" id="v6ChatFileInput" class="v6-chat-file-input" multiple hidden>/);
  });

  it('shows one removable chip per attachment, with its state, escaped', () => {
    const html = G.tcV6ConversationViewMarkup(v({ attachments: [
      { name: 'a.png', status: 'ready', relPath: '.tangleclaw/secrets/a.png' },
      { name: '<b>.txt', status: 'uploading' },
      { name: 'big.mov', status: 'error', error: 'over 5 MB' }
    ] }));
    assert.match(html, /<div id="v6ChatAttachments" class="v6-chat-attachments"/);
    assert.match(html, /class="v6-chat-chip is-ready"[^>]*>a\.png/);
    assert.match(html, /class="v6-chat-chip is-uploading"[^>]*>&lt;b&gt;\.txt/);
    assert.match(html, /class="v6-chat-chip is-error"[^>]*title="over 5 MB"/);
    assert.match(html, /<button type="button" id="v6ChatAttachRemove-2" class="v6-chat-chip-remove" aria-label="Remove big\.mov">×<\/button>/);
    assert.doesNotMatch(html, /<b>\.txt/);
  });

  // Attaching saves files into the project; only sending needs a live
  // session, so files can be attached first and sent once the chat is started.
  it('an offline target can still take attachments, while sending stays disabled', () => {
    const html = G.tcV6ConversationViewMarkup(v({ status: 'offline' }));
    assert.doesNotMatch(html, /id="v6ChatAttachBtn"[^>]*disabled/);
    assert.match(html, /<button type="submit" id="v6ChatSend"[^>]*disabled/);
  });
});

describe('chat attachments, end to end through the shell and controller (#3053)', () => {
  function mountUploads(opts) {
    const o = opts || {};
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const win = makeFakeWindow(o.initialHash || '#/projects/tc-lane');
    const rows = [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }, { id: 10, name: 'TC-Lane-A', engine: { id: 'claude' } }];
    const posts = [];
    let release = null;
    const api = async (url, init) => {
      // The real listing route: an empty secrets store.
      if (init && init.method === 'GET' && /\/secure-clipboard$/.test(url)) return { files: [] };
      if (init && init.method === 'POST') {
        posts.push({ url, headers: plain(init.headers), body: JSON.parse(init.body) });
        if (o.hold) await new Promise((r) => { release = r; });
        if (o.refuse) { api.lastError = 'Sign in to send a secret into a project session'; return null; }
        const b = JSON.parse(init.body);
        // The real route's shape: relPath is relative to the project's .tangleclaw/ directory.
        return { ok: true, mode: 'file', relPath: `secrets/${b.filename}`, bytes: 3 };
      }
      if (url === '/api/projects') return { projects: rows };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1592 };
      if (url === '/api/sessions/TC-Lane-A/status') return { active: true, sessionId: 1660 };
      if (/\/conversation\/events/.test(url)) return { events: [] };
      return null;
    };
    const mutateCalls = [];
    const apiMutate = async (url, method, body) => { mutateCalls.push({ url, body: plain(body) }); return { ok: true }; };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({
      getShell: () => shell, api, apiMutate, storage: null,
      readFileAsBase64: async (file) => Buffer.from(file.content || 'abc').toString('base64'),
      operatorHeaders: async () => ({ 'Content-Type': 'application/json', 'X-TC-Open-Token': 'tok' })
    });
    shell = G.tcCreateV6Shell(doc, {
      root, window: win, storage: null,
      onRender: (r) => pending.push(live.handleRoute(r)),
      onSendChat: (t) => pending.push(live.sendChat(t)),
      onAttachFiles: (files) => pending.push(live.attachFiles(files)),
      onRemoveAttachment: (i) => pending.push(live.removeAttachment(i))
    });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    const pick = (files) => { const input = doc.getElementById('v6ChatFileInput'); input.files = files; input.dispatch('change'); };
    return { shell, root, doc, win, live, posts, mutateCalls, settle, pick, release: () => release && release() };
  }

  it('a picked file is uploaded to the project with operator proof, then becomes a ready chip', async () => {
    const m = mountUploads();
    await m.settle();
    m.pick([{ name: 'Screen Shot.png', size: 3, content: 'png' }]);
    await m.settle();
    assert.equal(m.posts.length, 1);
    assert.equal(m.posts[0].url, '/api/sessions/TC-Lane-PM/secure-clipboard');
    assert.deepEqual(m.posts[0].body, { text: Buffer.from('png').toString('base64'), mode: 'file', filename: 'Screen-Shot.png', encoding: 'base64' });
    assert.equal(m.posts[0].headers['X-TC-Open-Token'], 'tok');
    assert.match(m.root.innerHTML, /v6-chat-chip is-ready[^>]*>Screen-Shot\.png/);
  });

  it('sending appends one Attached line per ready file, and the chips clear once it is sent', async () => {
    const m = mountUploads();
    await m.settle();
    m.pick([{ name: 'a.png', size: 3 }, { name: 'b.txt', size: 3 }]);
    await m.settle();
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'look at these';
    input.dispatch('input');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await m.settle();
    assert.equal(m.mutateCalls[0].body.command, 'look at these\n\nAttached: .tangleclaw/secrets/a.png\nAttached: .tangleclaw/secrets/b.txt');
    assert.doesNotMatch(m.root.innerHTML, /v6-chat-chip/);
  });

  it('attachments alone can be sent, with no text', async () => {
    const m = mountUploads();
    await m.settle();
    m.pick([{ name: 'a.png', size: 3 }]);
    await m.settle();
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await m.settle();
    assert.equal(m.mutateCalls[0].body.command, 'Attached: .tangleclaw/secrets/a.png');
  });

  it('a file over 5 MB is refused on the chip and never uploaded', async () => {
    const m = mountUploads();
    await m.settle();
    m.pick([{ name: 'big.mov', size: 5 * 1024 * 1024 + 1 }]);
    await m.settle();
    assert.equal(m.posts.length, 0);
    assert.match(m.root.innerHTML, /v6-chat-chip is-error[^>]*title="Over the 5 MB limit for an attachment\."/);
  });

  it('an upload the server refuses shows its reason on the chip, and is not referenced in a send', async () => {
    const m = mountUploads({ refuse: true });
    await m.settle();
    m.pick([{ name: 'a.png', size: 3 }]);
    await m.settle();
    assert.match(m.root.innerHTML, /v6-chat-chip is-error[^>]*title="Sign in to send a secret into a project session"/);
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'hi';
    input.dispatch('input');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await m.settle();
    assert.equal(m.mutateCalls[0].body.command, 'hi');
  });

  it('sending while a file is still uploading waits, and says why', async () => {
    const m = mountUploads({ hold: true });
    await m.settle();
    m.pick([{ name: 'a.png', size: 3 }]);
    await new Promise((r) => setImmediate(r));
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'hi';
    input.dispatch('input');
    await m.live.sendChat('hi');
    assert.equal(m.mutateCalls.length, 0);
    assert.match(m.root.innerHTML, /is-error[^>]*>Not sent: wait for 1 upload to finish\./);
    m.release();
    await m.settle();
  });

  it('a removed chip is gone, and an upload that finishes after its removal is discarded', async () => {
    const m = mountUploads({ hold: true });
    await m.settle();
    m.pick([{ name: 'a.png', size: 3 }]);
    await new Promise((r) => setImmediate(r));
    m.doc.getElementById('v6ChatAttachRemove-0').dispatch('click');
    m.release();
    await m.settle();
    assert.doesNotMatch(m.root.innerHTML, /v6-chat-chip/);
  });

  it('attachments belong to their chat and do not follow the operator to another one', async () => {
    const m = mountUploads();
    await m.settle();
    m.pick([{ name: 'a.png', size: 3 }]);
    await m.settle();
    m.win.location.hash = '#/resources/10/conversation';
    await m.settle();
    assert.doesNotMatch(m.root.innerHTML, /v6-chat-chip/);
    m.win.location.hash = '#/projects/tc-lane';
    await m.settle();
    assert.match(m.root.innerHTML, /v6-chat-chip is-ready[^>]*>a\.png/);
  });

  it('two files with the same name in one chat get distinct names', async () => {
    const m = mountUploads();
    await m.settle();
    m.pick([{ name: 'a.png', size: 3 }, { name: 'a.png', size: 3 }]);
    await m.settle();
    assert.deepEqual(m.posts.map((p) => p.body.filename), ['a.png', 'a-2.png']);
  });
});

// ── #3053 (Car V623-W1-A): start from the chat, refresh, delegate recognition, chrome ──

describe('chat start controls and delegate recognition markup (#3053)', () => {
  const G = loadV6Shell();
  const base = (chat, extra) => Object.assign({
    project: { id: 12, name: 'TC-Lane-PM' }, sessionId: null,
    chat: Object.assign({ mode: 'delegate', nodeId: 'tc-lane', nodeName: 'TC-Lane', status: 'offline',
      members: [{ id: '10', name: 'TC-Lane-A', live: true }, { id: '12', name: 'TC-Lane-PM', live: false }, { id: '14', name: 'TC-Lane-B', live: false }] }, chat || {})
  }, extra || {});

  it('an offline target offers Start in the header and the offline banner, plus the Classic launcher', () => {
    const html = G.tcV6ConversationViewMarkup(base());
    assert.match(html, /<button type="button" id="v6ChatStart" class="btn btn-primary btn-small v6-chat-start" data-action="start-chat-session">▶ Start TC-Lane-PM<\/button>/);
    assert.match(html, /<p class="v6-chat-offline">TC-Lane-PM has no live session\.[\s\S]*id="v6ChatStartBanner"[^>]*data-action="start-chat-session"/);
    // Classic's launch link needs an intent token (#2124), so the chat links
    // to Classic View itself and says so, rather than to a launcher it cannot open.
    assert.match(html, /<a class="v6-chat-classic-launch" href="#\/">Open Classic View to launch TC-Lane-PM<\/a>/);
    assert.doesNotMatch(html, /\?launch=/);
  });

  it('a live target offers no Start for itself (a group may still offer Start for its offline members)', () => {
    assert.doesNotMatch(G.tcV6ConversationViewMarkup(base({ status: 'active' }, { sessionId: 1 })), /id="v6ChatStart"|v6ChatStartBanner/);
  });

  it('a group with offline members offers Start for them, counted, and asks again before starting', () => {
    assert.match(G.tcV6ConversationViewMarkup(base()),
      /<button type="button" id="v6ChatStartFleet" class="btn btn-secondary btn-small v6-chat-start-fleet" data-action="start-chat-fleet">▶ Start TC-Lane \(2 offline\)<\/button>/);
    assert.match(G.tcV6ConversationViewMarkup(base({ fleetArmed: true })), /id="v6ChatStartFleet"[^>]*>Click again to start 2 sessions<\/button>/);
    const allLive = base({ members: [{ id: '10', name: 'A', live: true }] });
    assert.doesNotMatch(G.tcV6ConversationViewMarkup(allLive), /v6ChatStartFleet/);
  });

  it('a direct route whose member is the delegate is shown as the Designated Project Delegate, with the picker', () => {
    const html = G.tcV6ConversationViewMarkup(base({ mode: 'direct', delegate: { id: '12', name: 'TC-Lane-PM' }, status: 'active' }, { sessionId: 1 }));
    assert.match(html, /Designated Project Delegate/);
    assert.match(html, /id="v6ChatDelegate"/);
    assert.doesNotMatch(html, /Direct Session/);
  });

  it('a direct route to a member that is not the delegate stays a Direct Session', () => {
    const html = G.tcV6ConversationViewMarkup(base({ mode: 'direct', delegate: { id: '12', name: 'TC-Lane-PM' }, status: 'active' },
      { project: { id: 10, name: 'TC-Lane-A' }, sessionId: 1 }));
    assert.match(html, /Direct Session/);
    assert.match(html, /Switch to Delegate: TC-Lane-PM/);
  });
});

describe('tcCreateV6Shell — chrome in the conversation view (#3053)', () => {
  it('keeps the template wizard and attestation slots in the page but hidden while a conversation shows', () => {
    const { shell, root } = mountShell({ tree: TWO_GROUP_TREE, templates: [{ id: 't1', name: 'T', seats: [1] }] });
    // Restated by #3086: the wizard slot is now the Wizard tab's panel, so it carries role="tabpanel" and names its tab.
    assert.match(root.innerHTML, /<div id="v6ShellWizard" role="tabpanel" aria-labelledby="v6WorkspaceMode-wizard">/);
    shell.setDetail({ kind: 'conversation', view: { project: { id: 1, name: 'x' }, sessionId: null, chat: {} } });
    assert.match(root.innerHTML, /<div id="v6ShellWizard" role="tabpanel" aria-labelledby="v6WorkspaceMode-wizard" hidden>[\s\S]*v6ShellWizardLaunch-t1/);
    assert.match(root.innerHTML, /<div id="v6ShellAttestation" hidden>/);
  });

  it('gives every sidebar link a positional id, and reports a click on it with its hash', () => {
    const clicked = [];
    const { doc, root } = mountShell({ tree: TWO_GROUP_TREE, onTreeLinkClick: (hash) => clicked.push(hash) });
    assert.match(root.innerHTML, /class="v6-shell-project[^"]*"[^>]*id="v6TreeLink-p0"/);
    assert.match(root.innerHTML, /class="v6-shell-fleet[^"]*"[^>]*id="v6TreeLink-f0-0"/);
    assert.match(root.innerHTML, /class="v6-shell-member-link[^"]*"[^>]*id="v6TreeLink-m1-0-0"/);
    doc.getElementById('v6TreeLink-p0').dispatch('click');
    doc.getElementById('v6TreeLink-m1-0-0').dispatch('click');
    assert.deepEqual(clicked, ['#/projects/tc-lane', '#/resources/21/conversation']);
  });
});

describe('start, refresh and offline polling through the live controller (#3053)', () => {
  function mountStart(opts) {
    const o = opts || {};
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const win = makeFakeWindow(o.initialHash || '#/projects/tc-lane');
    const live = { 10: true, 12: false, 14: false };
    const rows = () => [
      { id: 10, name: 'TC-Lane-A', engine: { id: 'claude' }, session: live[10] ? { active: true } : null },
      { id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' }, session: live[12] ? { active: true } : null },
      { id: 14, name: 'TC-Lane-B', engine: { id: 'claude' }, session: live[14] ? { active: true } : null }
    ];
    const byName = { 'TC-Lane-A': 10, 'TC-Lane-PM': 12, 'TC-Lane-B': 14 };
    const calls = [];
    const api = async (url) => {
      calls.push(url);
      if (url === '/api/projects') return { projects: rows() };
      const st = /^\/api\/sessions\/([^/]+)\/status$/.exec(url);
      if (st) { const id = byName[decodeURIComponent(st[1])]; return live[id] ? { active: true, sessionId: id * 100 } : { active: false }; }
      if (/conversation\/events/.test(url)) return { events: [] };
      return null;
    };
    const mutateCalls = [];
    const apiMutate = async (url, method, body) => {
      mutateCalls.push({ url, method, body: plain(body) });
      const m = /^\/api\/sessions\/([^/]+)$/.exec(url);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (o.refuse && o.refuse[name]) { api.lastError = o.refuse[name]; return null; }
        live[byName[name]] = true;
        return { ok: true };
      }
      return { ok: true };
    };
    api.lastError = null;
    const timers = [];
    let shell = null;
    const pending = [];
    const ctl = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate, storage: null,
      setInterval: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
      clearInterval: (id) => { if (timers[id]) timers[id].cleared = true; } });
    shell = G.tcCreateV6Shell(doc, {
      root, window: win, storage: null,
      onRender: (r) => pending.push(ctl.handleRoute(r)),
      onStartSession: () => pending.push(ctl.startSession()),
      onStartFleet: () => pending.push(ctl.startFleet()),
      onTreeLinkClick: (hash) => pending.push(ctl.treeLinkClicked(hash))
    });
    pending.push(ctl.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { shell, root, doc, win, ctl, calls, mutateCalls, timers, live, settle };
  }

  it('Start launches the offline target and reloads the chat in place as Active', async () => {
    const m = mountStart();
    await m.settle();
    assert.match(m.root.innerHTML, /is-offline/);
    m.doc.getElementById('v6ChatStart').dispatch('click');
    await m.settle();
    assert.deepEqual(m.mutateCalls[0], { url: '/api/sessions/TC-Lane-PM', method: 'POST', body: {} });
    assert.match(m.root.innerHTML, /class="v6-chat-pill is-active">Active</);
  });

  it('a refused start shows the server\'s reason and leaves the chat offline', async () => {
    const m = mountStart({ refuse: { 'TC-Lane-PM': 'Stranded wraps need acknowledging (STRANDED_WRAPS)' } });
    await m.settle();
    m.doc.getElementById('v6ChatStartBanner').dispatch('click');
    await m.settle();
    assert.match(m.root.innerHTML, /is-error[^>]*>Not started: Stranded wraps need acknowledging \(STRANDED_WRAPS\)</);
    assert.match(m.root.innerHTML, /is-offline/);
  });

  it('Start fleet asks again first, then starts each offline member and reports the result', async () => {
    const m = mountStart({ refuse: { 'TC-Lane-B': 'no engine' } });
    await m.settle();
    m.doc.getElementById('v6ChatStartFleet').dispatch('click');
    await m.settle();
    assert.equal(m.mutateCalls.length, 0, 'the first click only arms it');
    assert.match(m.root.innerHTML, /Click again to start 2 sessions/);
    m.doc.getElementById('v6ChatStartFleet').dispatch('click');
    await m.settle();
    // In the sidebar's member order (by name).
    assert.deepEqual(m.mutateCalls.map((c) => c.url), ['/api/sessions/TC-Lane-B', '/api/sessions/TC-Lane-PM']);
    assert.match(m.root.innerHTML, /Started 1 of 2\. TC-Lane-B: no engine/);
    assert.match(m.root.innerHTML, /class="v6-chat-pill is-active">Active</, 'the PM started, and the chat reloaded');
  });

  it('an offline chat polls its status and turns Active by itself once the session starts elsewhere', async () => {
    const m = mountStart();
    await m.settle();
    assert.equal(m.timers.length, 1, 'an offline chat polls too');
    m.live[12] = true;
    await m.timers[0].fn();
    await m.settle();
    assert.match(m.root.innerHTML, /class="v6-chat-pill is-active">Active</);
  });

  it('re-clicking the route already on screen refreshes it', async () => {
    const m = mountStart();
    await m.settle();
    const reads = () => m.calls.filter((u) => u === '/api/projects').length;
    const before = reads();
    m.ctl.treeLinkClicked('#/projects/tc-lane');
    await m.settle();
    assert.equal(reads(), before + 1);
  });

  it('clicking another route reloads the projects for it, so its session state is current', async () => {
    const m = mountStart();
    await m.settle();
    const reads = () => m.calls.filter((u) => u === '/api/projects').length;
    const before = reads();
    m.live[14] = true;
    m.ctl.treeLinkClicked('#/resources/14/conversation');
    m.win.location.hash = '#/resources/14/conversation';
    await m.settle();
    assert.equal(reads(), before + 1);
    assert.match(m.root.innerHTML, /class="v6-chat-pill is-active">Active</);
  });

  it('coming back to the Fleet View from Classic reloads the projects (no separate refresh needed)', async () => {
    const m = mountStart();
    await m.settle();
    const reads = () => m.calls.filter((u) => u === '/api/projects').length;
    const before = reads();
    m.win.location.hash = '#/';
    await m.settle();
    m.win.location.hash = '#/projects/tc-lane';
    await m.settle();
    assert.equal(reads(), before + 1);
  });
});

// ── #3053 item 4 and the cumulative review's fixes (Car V623-W1-A) ──

describe('tcV6MemberIndicators (#3053 item 4, Option A)', () => {
  const G = loadV6Shell();
  const ind = (row, health) => plain(G.tcV6MemberIndicators(row, health || {}));
  // A live session as lib/projects.js#_liveSession sends it, after
  // enrichProject fills startupReadiness: the store's status column only
  // ever says 'active' here; starting and wrapping have their own fields.
  const live = (over) => ({ session: Object.assign({
    active: true, status: 'active', startedAt: '2026-11-13T22:00:00Z', tmuxSession: 'tc-x', sessionMode: 'tmux',
    incomplete: [], cause: null, lastEngineError: null, launchBlocker: null, heldWakeReason: null,
    startupReadiness: { state: 'ready', step: 4, sequenceId: 1, revision: 1, readyAt: 1 }, wrapping: false
  }, over || {}) });

  it('reads a member\'s session state from the fields the server actually sends', () => {
    assert.equal(ind(live()).state, 'live');
    assert.equal(ind(live({ startupReadiness: { state: 'starting', step: 2 } })).state, 'starting');
    assert.equal(ind(live({ wrapping: { step: 'commit', since: 1, stale: false } })).state, 'wrapping');
    assert.match(ind(live({ wrapping: { step: 'commit', since: 1, stale: false } })).title, /commit/);
    assert.equal(ind({ session: null }).state, 'offline');
    assert.equal(ind(null).state, 'offline');
  });

  it('needs attention: a launch blocker, a held wake, an engine error, a startup that needs attention, a stale wrap, or a last session that crashed or left work', () => {
    const blocked = ind(live({ launchBlocker: { label: 'trust dialog', message: 'folder trust dialog' } }));
    assert.equal(blocked.state, 'attention');
    assert.match(blocked.title, /folder trust dialog/);
    assert.equal(ind(live({ heldWakeReason: 'pane-composer-has-input' })).state, 'attention');
    assert.equal(ind(live({ lastEngineError: { message: 'rate limit' } })).state, 'attention');
    const startup = ind(live({ startupReadiness: { state: 'needs-attention', blocker: 'missing-launch-sequence' } }));
    assert.equal(startup.state, 'attention');
    assert.match(startup.title, /missing-launch-sequence/);
    assert.equal(ind(live({ wrapping: { step: 'push', since: 1, stale: true } })).state, 'attention');
    assert.equal(ind({ session: null, sessionHealth: { status: 'crashed', state: 'clean' } }).state, 'attention');
    assert.equal(ind({ session: null, sessionHealth: { status: 'wrapped', state: 'left-work' } }).state, 'attention');
  });

  it('gives each state its glyph', () => {
    assert.deepEqual([live(), live({ heldWakeReason: 'pane-not-at-rest' }), live({ startupReadiness: { state: 'starting' } }), {}]
      .map((r) => ind(r).glyph), ['●', '⚠', '◐', '○']);
  });

  it('reads the Medusa link as on, link-only (wake off) or off', () => {
    assert.equal(ind({ medusaEnabled: true, medusaWake: true }).medusa, 'on');
    assert.equal(ind({ medusaEnabled: true, medusaWake: false }).medusa, 'wake-off');
    assert.equal(ind({ medusaEnabled: false, medusaWake: true }).medusa, 'off');
    assert.equal(ind({}).medusa, 'off');
  });

  it('names the engine by a short code and colours it by its health', () => {
    const health = { claude: { status: 'operational' }, codex: { status: 'degraded' }, antigravity: { status: 'outage' } };
    assert.deepEqual(ind({ engine: { id: 'claude', name: 'Claude Code' } }, health).engine, { code: 'CC', name: 'Claude Code', health: 'operational' });
    assert.equal(ind({ engine: { id: 'codex' } }, health).engine.code, 'CX');
    assert.equal(ind({ engine: { id: 'antigravity' } }, health).engine.health, 'outage');
    assert.equal(ind({ engine: { id: 'aider' } }, health).engine.code, 'AI');
    assert.deepEqual(ind({ engine: { id: 'openclaw' } }, health).engine, { code: 'OP', name: 'openclaw', health: 'unknown' });
    assert.equal(ind({}).engine, null);
  });

  it('shows the engine a member is really on: its live session, else its last session, else the configured one (#3094, A767/A768)', () => {
    const health = { claude: { status: 'operational' }, codex: { status: 'degraded' }, antigravity: { status: 'outage' } };
    const configured = { engine: { id: 'claude', name: 'Claude Code' } };
    assert.deepEqual(ind(configured, health).engine, { code: 'CC', name: 'Claude Code', health: 'operational' });
    // The last session's engine beats the configured one, in either field the server may send.
    assert.deepEqual(ind({ ...configured, lastSessionEngineId: 'codex' }, health).engine, { code: 'CX', name: 'codex', health: 'degraded' });
    assert.equal(ind({ ...configured, sessionHealth: { engineId: 'antigravity' } }, health).engine.code, 'AG');
    assert.equal(ind({ ...configured, lastSessionEngineId: 'codex', sessionHealth: { engineId: 'antigravity' } }, health).engine.code, 'CX');
    // A live session's engine beats both, in each shape it can take.
    const last = { ...configured, lastSessionEngineId: 'codex' };
    assert.equal(ind({ ...last, session: { active: true, engineId: 'antigravity' } }, health).engine.code, 'AG');
    assert.equal(ind({ ...last, session: { active: true, engine: { id: 'antigravity' } } }, health).engine.code, 'AG');
    assert.equal(ind({ ...last, session: { active: true, engine: 'antigravity' } }, health).engine.code, 'AG');
    // A configured engine given as a bare id still counts.
    assert.equal(ind({ engine: 'codex' }, health).engine.code, 'CX');
    // An id that names a prototype property is not a known engine.
    assert.deepEqual(ind({ lastSessionEngineId: 'constructor' }, { constructor: { status: 'operational' } }).engine,
      { code: 'CO', name: 'constructor', health: 'operational' });
    assert.deepEqual(ind({ lastSessionEngineId: 'toString' }, {}).engine, { code: 'TO', name: 'toString', health: 'unknown' });
  });

  it('adds the model to the engine badge\'s tooltip when one is known (#3094)', () => {
    assert.equal(ind({ engine: { id: 'claude' }, session: { active: true, launchedModel: 'opus', model: 'sonnet' }, model: 'haiku' }).engine.model, 'opus');
    assert.equal(ind({ engine: { id: 'claude' }, session: { active: true, model: 'sonnet' }, model: 'haiku' }).engine.model, 'sonnet');
    assert.equal(ind({ engine: { id: 'claude' }, model: 'haiku' }).engine.model, 'haiku');
    const html = G.tcV6MemberIndicatorsMarkup(G.tcV6MemberIndicators({ engine: { id: 'codex', name: 'Codex' }, model: 'gpt-5 <b>' }, { codex: { status: 'operational' } }));
    assert.match(html, /<span class="v6-member-ai-status is-operational" title="Codex \(gpt-5 &lt;b&gt;\): operational">CX<\/span>/);
    const bare = G.tcV6MemberIndicatorsMarkup(G.tcV6MemberIndicators({ engine: { id: 'codex', name: 'Codex' } }, { codex: { status: 'operational' } }));
    assert.match(bare, /title="Codex: operational">CX</);
  });
});

describe('sidebar member status indicators (#3053 item 4)', () => {
  const ROWS = [
    { id: 11, name: 'TC-Lane-A', engine: { id: 'claude', name: 'Claude Code' }, session: { active: true, status: 'active', wrapping: false, startupReadiness: { state: 'ready' } }, medusaEnabled: true, medusaWake: true },
    { id: 12, name: 'TC-Lane-PM', engine: { id: 'codex', name: 'Codex' }, session: { active: true, status: 'active', wrapping: false, launchBlocker: { message: '<held> by INT' } }, medusaEnabled: true, medusaWake: false },
    { id: 21, name: 'Medusa-PM', engine: { id: 'aider' }, session: null }
  ];

  it('styles each member by its session state and adds the link and engine symbols beside it', () => {
    const { shell, root } = mountShell({ tree: TWO_GROUP_TREE });
    shell.setProjects(ROWS);
    shell.setEngineHealth({ claude: { status: 'operational' }, codex: { status: 'degraded' } });
    const html = root.innerHTML;
    assert.match(html, /class="v6-shell-member-link is-live[^"]*"[\s\S]{0,200}<span class="v6-member-glyph" aria-hidden="true">●<\/span>TC-Lane-A \(11\)/);
    assert.match(html, /class="v6-shell-member-link is-attention[^"]*"[^>]*title="Needs attention: &lt;held&gt; by INT"/);
    assert.match(html, /class="v6-shell-member-link is-offline/);
    assert.match(html, /<span class="v6-member-indicators"><span class="v6-member-link-status is-on" title="Medusa link and wake on">🔗<\/span><span class="v6-member-ai-status is-operational" title="Claude Code: operational">CC<\/span><\/span>/);
    assert.match(html, /v6-member-link-status is-wake-off" title="Medusa link on, wake off"/);
    assert.match(html, /v6-member-ai-status is-degraded" title="Codex: degraded">CX</);
    assert.match(html, /v6-member-link-status is-off" title="Medusa link off"/);
    assert.match(html, /v6-member-ai-status is-unknown" title="aider: status unknown">AI</);
  });

  it('a member with no project row is drawn as before, with no indicators', () => {
    const { root } = mountShell({ tree: TWO_GROUP_TREE });
    assert.doesNotMatch(root.innerHTML, /v6-member-indicators/);
  });

  it('the live controller hands the shell the engine health from /api/models/status', async () => {
    const G = loadV6Shell();
    const seen = [];
    const api = async (url) => (url === '/api/projects' ? { projects: [] }
      : (url === '/api/models/status' ? { status: { claude: { status: 'operational' } } } : null));
    const shell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setDetail() {}, setProjects() {},
      setEngineHealth(h) { seen.push(plain(h)); } };
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null });
    await live.handleRoute({ view: 'settings', settingsPath: '' });
    assert.deepEqual(seen, [{ claude: { status: 'operational' } }]);
  });
});

describe('tcV6ExtractLiveTurns keeps ordinary prose (cumulative review)', () => {
  const G = loadV6Shell();
  it('a reply mentioning thinking, a running command, tokens used or the context window is kept, not dropped or read as activity', () => {
    const out = plain(G.tcV6ExtractLiveTurns(['> go', 'I was thinking about the plan.', 'Running command line tools is fine.',
      'We have used 10k tokens so far.', 'The context window is large.'], 'claude', []));
    assert.equal(out.turns[1].text, 'I was thinking about the plan.\nRunning command line tools is fine.\nWe have used 10k tokens so far.\nThe context window is large.');
    assert.equal(out.activity, null);
  });

  it('an indented line under a status or boilerplate line is kept; only a tool line hides what is indented under it', () => {
    const out = plain(G.tcV6ExtractLiveTurns(['> go', '[TangleClaw Switchboard] wake', '  This reply line is indented.'], 'claude', []));
    // Restated by #3082: a reply after a wake is marked as switchboard-triggered.
    assert.deepEqual(out.turns[1], { role: 'assistant', text: 'This reply line is indented.', trigger: 'switchboard' });
  });
});

describe('tcV6ExtractLiveTurns does not repeat a multi-line or wrapped message (cumulative review)', () => {
  const G = loadV6Shell();
  it('a message sent with attachments is recognised by its lines, including its Attached lines', () => {
    const sent = 'look at these\n\nAttached: .tangleclaw/secrets/a.png';
    const out = plain(G.tcV6ExtractLiveTurns(['> look at these', 'Attached: .tangleclaw/secrets/a.png', '⏺ Got it.'], 'claude', [sent]));
    // Restated by #3079 item 6: one user turn carrying the recorded message, then the reply.
    assert.deepEqual(out.turns, [{ role: 'user', text: sent, recorded: true }, { role: 'assistant', text: 'Got it.' }]);
  });

  it('a long prompt the terminal wrapped is recognised by its first line', () => {
    const sent = 'please review the release notes for v6.2.3 and tell me whether the delegate order reads correctly';
    const out = plain(G.tcV6ExtractLiveTurns(['> please review the release notes for v6.2.3 and tell', '⏺ It reads correctly.'], 'claude', [sent]));
    // Restated by #3079 item 6: one user turn carrying the whole recorded message, then the reply.
    assert.deepEqual(out.turns, [{ role: 'user', text: sent, recorded: true }, { role: 'assistant', text: 'It reads correctly.' }]);
  });
});

describe('an upload never overwrites an earlier one (cumulative review)', () => {
  function mountNames(existing) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const win = makeFakeWindow('#/projects/tc-lane');
    const posts = [];
    const api = async (url, init) => {
      if (init && init.method === 'POST') { const b = JSON.parse(init.body); posts.push(b.filename); return { ok: true, relPath: `secrets/${b.filename}` }; }
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }, { id: 10, name: 'TC-Lane-A' }] };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1 };
      if (url === '/api/sessions/TC-Lane-PM/secure-clipboard') return { files: (existing || []).map((filename) => ({ filename })) };
      if (/conversation\/events/.test(url)) return { events: [] };
      return null;
    };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => ({ ok: true }), storage: null,
      readFileAsBase64: async () => 'eA==', operatorHeaders: async () => ({}) });
    shell = G.tcCreateV6Shell(doc, { root, window: win, storage: null, onRender: (r) => pending.push(live.handleRoute(r)),
      onSendChat: (t) => pending.push(live.sendChat(t)), onAttachFiles: (f) => pending.push(live.attachFiles(f)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { live, settle, posts };
  }

  it('a second pasted image.png after a send gets a new name rather than replacing the first', async () => {
    const m = mountNames();
    await m.settle();
    await m.live.attachFiles([{ name: 'image.png', size: 1 }]);
    await m.live.sendChat('first');
    await m.live.attachFiles([{ name: 'image.png', size: 1 }]);
    await m.settle();
    assert.deepEqual(m.posts, ['image.png', 'image-2.png']);
  });

  it('a name already in the project\'s secrets store is not reused', async () => {
    const m = mountNames(['image.png', 'image-2.png']);
    await m.settle();
    await m.live.attachFiles([{ name: 'image.png', size: 1 }]);
    assert.deepEqual(m.posts, ['image-3.png']);
  });
});

describe('tcV6ExtractLiveTurns: the interrupt hint is chrome only in its UI form (cumulative review, R-2)', () => {
  const G = loadV6Shell();
  it('a reply that mentions pressing esc to interrupt or cancel is kept and is not read as activity', () => {
    const out = plain(G.tcV6ExtractLiveTurns(['> how do I stop it?', 'Press esc to interrupt the run, or esc to cancel a menu.'], 'claude', []));
    assert.equal(out.turns[1].text, 'Press esc to interrupt the run, or esc to cancel a menu.');
    assert.equal(out.activity, null);
  });

  it('the hint in its UI form is still chrome or activity', () => {
    assert.match(plain(G.tcV6ExtractLiveTurns(['> go', 'Working (esc to interrupt)'], 'claude', [])).activity, /Working/);
    assert.deepEqual(plain(G.tcV6ExtractLiveTurns(['> go', 'esc to cancel'], 'claude', [])).turns.length, 1);
  });
});

describe('offline status polling does not overlap itself (cumulative review note)', () => {
  it('a tick that arrives while a slow status read is still running does nothing', async () => {
    const G = loadV6Shell();
    let release = null;
    let statusReads = 0;
    const api = async (url) => {
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM' }] };
      if (url === '/api/sessions/TC-Lane-PM/status') {
        statusReads++;
        if (statusReads === 1) return { active: false };
        await new Promise((r) => { release = r; });
        return { active: false };
      }
      return null;
    };
    const timers = [];
    const shell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setDetail() {}, setProjects() {},
      getRoute: () => ({ view: 'conversation', resourceId: '12' }) };
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null,
      setInterval: (fn) => { timers.push(fn); return timers.length - 1; }, clearInterval: () => {} });
    await live.handleRoute({ view: 'conversation', resourceId: '12' });
    const first = timers[0]();
    await new Promise((r) => setImmediate(r));
    await timers[0]();
    assert.equal(statusReads, 2, 'the overlapping tick did not read again');
    release();
    await first;
  });
});

describe('the secrets-store listing is read with full operator proof (INT R-Gate)', () => {
  it('the default headers carry the CSRF token as well as the open-install proof, since api() adds CSRF to writes only', async () => {
    const G = loadV6Shell();
    G.tcOperatorProofHeaders = async () => ({ 'Content-Type': 'application/json', 'X-TC-Open-Token': 'tok' });
    G.tcCsrfToken = () => 'csrf-1';
    const seen = [];
    const api = async (url, init) => {
      if (init && init.method) { seen.push({ url, method: init.method, headers: plain(init.headers) }); return init.method === 'GET' ? { files: [] } : { relPath: 'secrets/a.png' }; }
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM' }] };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1 };
      return null;
    };
    const shell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setDetail() {}, setProjects() {} };
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null, readFileAsBase64: async () => 'eA==' });
    await live.handleRoute({ view: 'conversation', resourceId: '12' });
    await live.attachFiles([{ name: 'a.png', size: 1 }]);
    const get = seen.find((c) => c.method === 'GET');
    assert.equal(get.url, '/api/sessions/TC-Lane-PM/secure-clipboard');
    assert.equal(get.headers['X-CSRF-Token'], 'csrf-1');
    assert.equal(get.headers['X-TC-Open-Token'], 'tok');
  });

  it('when the listing cannot be read, nothing is uploaded: the chip says why, since a stored file could be overwritten', async () => {
    const G = loadV6Shell();
    const posts = [];
    const api = async (url, init) => {
      if (init && init.method === 'GET') { api.lastError = 'This request is missing a valid CSRF token.'; return null; }
      if (init && init.method === 'POST') { posts.push(JSON.parse(init.body).filename); return { relPath: 'secrets/x' }; }
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM' }] };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1 };
      return null;
    };
    const views = [];
    const shell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setProjects() {},
      setDetail(d) { if (d && d.kind === 'conversation') views.push(plain(d.view)); } };
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null,
      readFileAsBase64: async () => 'eA==', operatorHeaders: async () => ({}) });
    await live.handleRoute({ view: 'conversation', resourceId: '12' });
    await live.attachFiles([{ name: 'image.png', size: 1 }]);
    assert.deepEqual(posts, [], 'no upload without a checked listing');
    const chip = views[views.length - 1].chat.attachments[0];
    assert.equal(chip.status, 'error');
    assert.match(chip.error, /could not be checked[\s\S]*missing a valid CSRF token/);
  });
});

describe('live turns from the pane are HTML-escaped, on first render and on every poll (Lane C B1)', () => {
  const HOSTILE_A = '<img src=x onerror=alert(1)> done';
  const HOSTILE_U = '<script>alert(2)</script>';

  it('the chat markup escapes assistant and user live turns', () => {
    const G = loadV6Shell();
    const html = G.tcV6ConversationViewMarkup({ project: { id: 12, name: 'TC-Lane-PM' }, sessionId: 1, events: [],
      chat: { status: 'active', live: { turns: [{ role: 'user', text: HOSTILE_U }, { role: 'assistant', text: HOSTILE_A }] } } });
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; done/);
    assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<img src=x|<script>alert/);
  });

  it('a hostile pane line is escaped when first rendered and when a poll swaps the live turns in', async () => {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    let n = 0;
    const peeks = [[`> ${HOSTILE_U}`, HOSTILE_A], [`> ${HOSTILE_U}`, `<b>bold</b> ${HOSTILE_A}`]];
    const api = async (url) => {
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }] };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1 };
      if (/conversation\/events$/.test(url)) return { events: [] };
      if (url === '/api/sessions/TC-Lane-PM/peek?lines=80') return { lines: peeks[Math.min(n++, 1)] };
      return null;
    };
    const timers = [];
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null,
      setInterval: (fn) => { timers.push(fn); return timers.length - 1; }, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null,
      onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    while (pending.length) await pending.shift();
    const first = root.innerHTML.slice(root.innerHTML.indexOf('id="v6ChatLive"'), root.innerHTML.indexOf('id="v6ChatUnderHood"'));
    assert.match(first, /&lt;img src=x onerror=alert\(1\)&gt; done/);
    assert.match(first, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/, 'the unrecorded user prompt too');
    assert.doesNotMatch(first, /<img src=x|<script>alert/);
    await timers[0]();
    const polled = doc.getElementById('v6ChatLive').innerHTML;
    assert.match(polled, /&lt;b&gt;bold&lt;\/b&gt; &lt;img src=x onerror=alert\(1\)&gt; done/);
    assert.match(polled, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.doesNotMatch(polled, /<img src=x|<script>alert|<b>bold/);
  });
});

describe('Claude tool-status lines are not reply text (PRR-B R2)', () => {
  const G = loadV6Shell();
  it('⏺ Ran / Explored / Edited / Read / Searched / Wrote lines and their indented output are dropped', () => {
    const out = plain(G.tcV6ExtractLiveTurns(['> check it', '⏺ Ran npm test', '  ⎿ 265 tests passed', '⏺ Explored 3 files',
      '⏺ Edited public/ui.js', '⏺ Read lib/x.js', '⏺ Searched for renderCard', '⏺ Wrote notes.md', '⏺ Everything passes.'], 'claude', []));
    assert.deepEqual(out.turns, [{ role: 'user', text: 'check it' }, { role: 'assistant', text: 'Everything passes.' }]);
  });

  it('a reply sentence that happens to start with one of those verbs is kept', () => {
    const out = plain(G.tcV6ExtractLiveTurns(['> how?', '⏺ Read the docs first, then try again.', '⏺ Ranking the options, I prefer B.'], 'claude', []));
    assert.equal(out.turns[1].text, 'Read the docs first, then try again.\nRanking the options, I prefer B.');
  });
});

describe('tcV6ExtractLiveTurns keeps indented replies after a tool line (#3057)', () => {
  const G = loadV6Shell();
  const run = (lines, engine) => plain(G.tcV6ExtractLiveTurns(lines, engine, []));

  it('antigravity: a 2-space reply right under ● Explored, with a list and a second paragraph, is one assistant turn', () => {
    const out = run(['❯ what is the difference?', '● Explored 1 file (ctrl+o to expand)',
      '  Here is the exact distinction:', '  1. A blocker stops the launch.', '  2. A warning does not.',
      '', '  - Both are logged.', '  Want me to change it?'], 'antigravity');
    assert.deepEqual(out.turns, [
      { role: 'user', text: 'what is the difference?' },
      { role: 'assistant', text: 'Here is the exact distinction:\n1. A blocker stops the launch.\n2. A warning does not.\n- Both are logged.\nWant me to change it?' }
    ]);
    assert.equal(out.question, 'Want me to change it?');
  });

  it('a reply indented after a blank line under each engine\'s own tool line is kept', () => {
    const toolLines = { antigravity: '● Ran npm test', claude: '⏺ Ran npm test', codex: '• Ran npm test',
      aider: 'Applied edit to test/a.test.js', mystery: '● Ran npm test' };
    Object.keys(toolLines).forEach((engine) => {
      const out = run(['> go', toolLines[engine], '', '  All tests pass.'], engine);
      assert.deepEqual(out.turns, [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'All tests pass.' }], engine);
    });
  });

  it('tool output is still dropped: ⎿ and └ lines at any indent, and 4+-space lines right under a tool line', () => {
    const claude = run(['> check', '⏺ Bash(npm test)', '  ⎿  265 passing', '     0 failing', '  The suite is green.'], 'claude');
    assert.deepEqual(claude.turns[1], { role: 'assistant', text: 'The suite is green.' });
    const codex = run(['› check', '• Ran npm test', '  └ 12 passing', '    0 failing', '  Done.'], 'codex');
    assert.deepEqual(codex.turns[1], { role: 'assistant', text: 'Done.' });
    const afterBlank = run(['> check', '⏺ Bash(ls)', '', '  ⎿  a.txt', 'Listed.'], 'claude');
    assert.deepEqual(afterBlank.turns[1], { role: 'assistant', text: 'Listed.' });
  });

  it('tool output with a blank line inside it stays out of the chat; the next 2-space line is the reply (cumulative review)', () => {
    const claude = run(['> status?', '⏺ Bash(git status)', '  ⎿  On branch main', '', '     nothing to commit, working tree clean',
      '', '  The tree is clean.'], 'claude');
    assert.deepEqual(claude.turns, [{ role: 'user', text: 'status?' }, { role: 'assistant', text: 'The tree is clean.' }]);
    const codex = run(['› test', '• Ran npm test', '  └ 12 passing', '', '    0 failing', '  All green.'], 'codex');
    assert.deepEqual(codex.turns, [{ role: 'user', text: 'test' }, { role: 'assistant', text: 'All green.' }]);
    const ag = run(['❯ go', '● Ran npm test', '', '    deeper output after the blank', '  Done.'], 'antigravity');
    assert.deepEqual(ag.turns, [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'Done.' }]);
  });

  it('a blank line between reply paragraphs keeps both in one turn', () => {
    const out = run(['> go', '⏺ First paragraph.', '', '  Second paragraph.'], 'claude');
    assert.deepEqual(out.turns[1], { role: 'assistant', text: 'First paragraph.\nSecond paragraph.' });
  });
});

// ── #3057 (Car V624-W1-A): Show Fleet from the chat, the busy clock, and the target's version and branch ──

describe('chat header version and branch badges (#3057)', () => {
  const G = loadV6Shell();
  const view = (project) => ({ project: Object.assign({ id: 12, name: 'TC-Lane-PM' }, project), sessionId: 1,
    events: [], chat: { mode: 'direct', status: 'active', members: [] } });
  const header = (html) => html.slice(html.indexOf('class="v6-chat-talking-to"'), html.indexOf('class="v6-chat-actions"'));

  it('shows the project version and its git branch inside .v6-chat-talking-to', () => {
    const html = header(G.tcV6ConversationViewMarkup(view({ version: '6.2.3', git: { branch: 'main', dirty: false, latestTag: 'v6.2.2' } })));
    assert.match(html, /<span class="v6-chat-version-badge" title="This project's version">6\.2\.3<\/span>/);
    assert.match(html, /<span class="v6-chat-git-badge" title="Git branch">⎇ main<\/span>/);
  });

  it('falls back to the latest tag, stars only a branch known to be dirty, and escapes both', () => {
    const tagged = header(G.tcV6ConversationViewMarkup(view({ version: null, git: { branch: 'fix/<x>', dirty: true, latestTag: 'v1.0.0' } })));
    assert.match(tagged, /v6-chat-version-badge[^>]*>v1\.0\.0</);
    assert.match(tagged, /<span class="v6-chat-git-badge is-dirty" title="Git branch, with uncommitted changes">⎇ fix\/&lt;x&gt;\*<\/span>/);
    const unknown = header(G.tcV6ConversationViewMarkup(view({ git: { branch: 'main', dirty: null } })));
    assert.match(unknown, /<span class="v6-chat-git-badge" title="Git branch">⎇ main<\/span>/);
    assert.doesNotMatch(unknown, /v6-chat-version-badge/);
  });

  it('renders no badge for a row with neither field', () => {
    const html = header(G.tcV6ConversationViewMarkup(view({})));
    assert.doesNotMatch(html, /v6-chat-version-badge|v6-chat-git-badge/);
  });
});

describe('» Show Fleet from the chat (#3057)', () => {
  const G = loadV6Shell();
  const chatView = { project: { id: 12, name: 'TC-Lane-PM' }, sessionId: 1, events: [], chat: { mode: 'direct', status: 'active', members: [] } };

  // Restated by #3059: the button moved from the head of the actions to the head of the identity strip.
  it('leads the chat toolbar\'s identity strip only while the sidebar is collapsed', () => {
    const shown = G.tcV6ConversationViewMarkup(Object.assign({}, chatView, { chat: Object.assign({}, chatView.chat, { sidebarCollapsed: true }) }));
    const actions = shown.slice(shown.indexOf('class="v6-chat-identity"'));
    assert.match(actions, /^class="v6-chat-identity"><button type="button" id="v6ChatShowFleet" class="btn btn-secondary btn-small v6-chat-show-fleet"\s+data-action="toggle-sidebar-drawer" aria-controls="v6ShellSidebar" aria-expanded="false"\s+aria-label="Show Fleet sidebar" title="Restore the Fleet sidebar">» Show Fleet<\/button>/);
    assert.doesNotMatch(G.tcV6ConversationViewMarkup(chatView), /v6ChatShowFleet/);
  });

  it('in the mounted shell, both Show Fleet controls appear once the sidebar hides, and the chat one restores it', () => {
    const { shell, doc, root } = mountShell({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView } });
    assert.doesNotMatch(root.innerHTML, /id="v6ChatShowFleet"/);
    doc.getElementById('v6SidebarCollapse').dispatch('click');
    assert.match(root.innerHTML, /id="v6SidebarExpand"/, 'the header control');
    assert.match(root.innerHTML, /id="v6ChatShowFleet"/, 'the chat control');
    const chatButton = doc.getElementById('v6ChatShowFleet');
    chatButton.focus();
    chatButton.dispatch('click');
    assert.equal(shell.isSidebarCollapsed(), false);
    assert.doesNotMatch(root.innerHTML, /id="v6ChatShowFleet"|id="v6SidebarExpand"/);
    assert.equal(doc.activeElement, doc.getElementById('v6SidebarCollapse'));
  });

  it('the header holding » Show Fleet is sticky while the sidebar is collapsed', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.v6-shell-root--sidebar-collapsed \.v6-shell-header \{\s*position: sticky;\s*top: 0;/);
  });
});

describe('tcV6FormatElapsed and the busy line markup (#3057)', () => {
  const G = loadV6Shell();
  it('formats seconds, minutes and hours', () => {
    assert.deepEqual([0, 999, 1000, 59999, 60000, 72000, 3599000, 3600000, 3723000, -5, NaN].map(G.tcV6FormatElapsed),
      ['0s', '0s', '1s', '59s', '1m 0s', '1m 12s', '59m 59s', '1h 0m', '1h 2m', '0s', '0s']);
  });

  it('strips the label\'s static dots and adds animated dots and the time; an empty label reads Working', () => {
    const chat = (activity) => G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 1, events: [],
      chat: { status: 'active', members: [], live: { turns: [], question: null, activity }, activityElapsed: '1m 12s' } });
    [['Thinking…', 'Thinking'], ['Running command...', 'Running command'], ['Working..', 'Working'], ['Reading.', 'Reading'],
      ['…', 'Working'], ['Compiling', 'Compiling']].forEach(([input, label]) => {
      assert.match(chat(input), new RegExp(`<span class="v6-chat-activity-label">${label}</span><span class="v6-chat-activity-dots" aria-hidden="true"></span> <span id="v6ChatActivityTimer" class="v6-chat-activity-timer" aria-hidden="true">1m 12s</span>`), input);
    });
  });

  it('a pending send reads as Working before the engine reports anything', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 1, events: [],
      chat: { status: 'active', members: [], live: null, send: { kind: 'pending', message: 'Sending to P…' } } });
    assert.match(html, /<p id="v6ChatActivity" class="v6-chat-activity is-busy"[^>]*><span class="v6-chat-activity-label">Working<\/span>/);
  });

  it('the dots animate, and hold still under reduced motion', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.v6-chat-activity-dots::after \{[^}]*content: '\.\.\.';[^}]*animation: v6-chat-dots [^;]*steps\(4, end\) infinite;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.v6-chat-activity-dots::after \{ animation: none; width: auto; \}/);
  });
});

describe('the busy clock in the mounted shell and live controller (#3057)', () => {
  /**
   * A chat on a fake clock: `peeks` are what each read of the pane shows.
   * @param {Array<Array<string>>} peeks
   */
  function mountBusyChat(peeks) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    let n = 0;
    let clock = 1000000;
    const rows = [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }];
    const api = async (url) => {
      if (url === '/api/projects') return { projects: rows };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1592 };
      if (/conversation\/events/.test(url)) return { events: [] };
      if (url === '/api/sessions/TC-Lane-PM/peek?lines=80') return { lines: peeks[Math.min(n++, peeks.length - 1)] };
      return null;
    };
    const polls = [];
    const ticks = new Map();
    let nextTick = 0;
    const cleared = [];
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => ({ ok: true }), storage: null,
      setInterval: (fn) => { polls.push(fn); return polls.length - 1; }, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null,
      now: () => clock,
      setInterval: (fn, ms) => { assert.equal(ms, 1000); const id = `t${nextTick++}`; ticks.set(id, fn); return id; },
      clearInterval: (id) => { cleared.push(id); ticks.delete(id); },
      onRender: (r) => pending.push(live.handleRoute(r)), onSendChat: (t) => pending.push(live.sendChat(t)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    const advance = (ms) => { clock += ms; [...ticks.values()].forEach((fn) => fn()); };
    const activity = () => doc.getElementById('v6ChatActivity');
    return { shell, doc, root, polls, ticks, cleared, settle, advance, activity, live };
  }

  // The mini DOM registers elements by id only: a full render is read from
  // the root's markup, an in-place update from the element it changed.
  const timerIn = (html) => { const m = /id="v6ChatActivityTimer"[^>]*>([^<]*)</.exec(html); return m ? m[1] : null; };
  const labelIn = (html) => { const m = /class="v6-chat-activity-label">([^<]*)</.exec(html); return m ? m[1] : null; };

  it('the elapsed time ticks each second while busy, keeps its start across polls, and stops with its ticker once idle', async () => {
    const busy = ['> go', '✶ Thinking… (esc to interrupt)'];
    const m = mountBusyChat([busy, busy, ['> go', '⏺ Done.']]);
    await m.settle();
    assert.match(m.root.innerHTML, /<p id="v6ChatActivity" class="v6-chat-activity is-busy"/);
    assert.equal(labelIn(m.root.innerHTML), 'Thinking');
    assert.equal(timerIn(m.root.innerHTML), '0s');
    assert.equal(m.ticks.size, 1);
    m.advance(1000);
    assert.equal(m.doc.getElementById('v6ChatActivityTimer').innerHTML, '1s');
    m.advance(71000);
    assert.equal(m.doc.getElementById('v6ChatActivityTimer').innerHTML, '1m 12s');
    await m.polls[0]();
    assert.equal(timerIn(m.activity().innerHTML), '1m 12s', 'a poll that is still busy keeps the start');
    assert.equal(m.activity().className, 'v6-chat-activity is-busy');
    assert.equal(m.ticks.size, 1, 'one ticker, not one per poll');
    await m.polls[0]();
    assert.equal(m.activity().className, 'v6-chat-activity');
    assert.equal(m.activity().innerHTML, '');
    assert.equal(m.ticks.size, 0);
    assert.equal(m.cleared.length, 1);
  });

  it('a full re-render keeps the running time, and destroy() stops the ticker', async () => {
    const busy = ['> go', '✶ Thinking… (esc to interrupt)'];
    const m = mountBusyChat([busy]);
    await m.settle();
    m.advance(5000);
    m.shell.toggleSidebar(true);
    assert.equal(timerIn(m.root.innerHTML), '5s');
    assert.equal(m.ticks.size, 1);
    m.shell.destroy();
    assert.equal(m.ticks.size, 0);
  });

  it('a sent message reads as Working at once and stays so until the engine takes over, then follows the engine', async () => {
    const before = ['> earlier', '⏺ Earlier reply.'];
    const m = mountBusyChat([before, before, before, ['> earlier', '⏺ Earlier reply.', '> go', '✶ Running… (esc to interrupt)']]);
    await m.settle();
    assert.doesNotMatch(m.root.innerHTML, /is-busy/, 'idle before the send');
    m.doc.getElementById('v6ChatInput').value = 'go';
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await m.settle();
    assert.equal(labelIn(m.root.innerHTML), 'Working', 'Working after delivery, before the pane shows anything');
    m.advance(3000);
    await m.polls[m.polls.length - 1]();
    assert.equal(labelIn(m.activity().innerHTML), 'Working');
    await m.polls[m.polls.length - 1]();
    assert.equal(labelIn(m.activity().innerHTML), 'Running', 'the engine\'s own label takes over');
    assert.equal(timerIn(m.activity().innerHTML), '3s', 'one clock from the send onwards');
  });

  it('a just-sent chat stops reading as Working once a new reply appears, or after three reads with neither', async () => {
    const before = ['> earlier', '⏺ Earlier reply.'];
    const replied = mountBusyChat([before, ['> earlier', '⏺ Earlier reply.', '> go', '⏺ Done already.']]);
    await replied.settle();
    replied.doc.getElementById('v6ChatInput').value = 'go';
    replied.doc.getElementById('v6ChatForm').dispatch('submit');
    await replied.settle();
    assert.doesNotMatch(replied.root.innerHTML, /is-busy/, 'a reply already on screen ends the wait');
    assert.equal(replied.ticks.size, 0);

    const silent = mountBusyChat([before]);
    await silent.settle();
    silent.doc.getElementById('v6ChatInput').value = 'go';
    silent.doc.getElementById('v6ChatForm').dispatch('submit');
    await silent.settle();
    assert.equal(labelIn(silent.root.innerHTML), 'Working', 'first read after the send');
    await silent.polls[silent.polls.length - 1]();
    await silent.polls[silent.polls.length - 1]();
    assert.equal(labelIn(silent.activity().innerHTML), 'Working', 'still waiting at the third read');
    await silent.polls[silent.polls.length - 1]();
    assert.equal(silent.activity().innerHTML, '', 'a fourth read with no engine activity ends it');
    assert.equal(silent.ticks.size, 0);
  });
});

describe('the busy pill keeps its time visible on a phone (#3057 browser check)', () => {
  it('is a flex row whose label truncates while the dots and time keep their width', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.v6-chat-activity\.is-busy \{[^}]*display: inline-flex;/);
    assert.match(css, /\.v6-chat-activity-label \{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;\s*\}/);
    assert.match(css, /\.v6-chat-activity-dots,\s*\.v6-chat-activity-timer \{\s*flex: none;\s*\}/);
    assert.match(css, /\.v6-chat-git-badge\.is-dirty \{ border-color: #d4a72c; \}/, 'amber border only, readable text in both themes');
  });
});

describe('Open Hood matches the chat\'s compact buttons (#3057, PM)', () => {
  const G = loadV6Shell();
  it('is a small button without an underline inside .v6-chat-actions', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 1, events: [], chat: { status: 'active', members: [] } });
    // Restated by #3059: Open Hood is now a >_ icon button, named by its title and aria-label.
    assert.match(html, /<a class="btn btn-secondary btn-small v6-chat-icon-btn v6-open-hood" href="\/session\/P" title="Open Hood \(Live Terminal\)" aria-label="Open Hood \(Live Terminal\)"><span aria-hidden="true">&gt;_<\/span><\/a>/);
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.v6-chat-actions \.v6-open-hood \{\s*display: inline-flex;\s*margin-bottom: 0;\s*text-decoration: none;\s*\}/);
  });
});

describe('pane and repo text reaching the chat header and busy line is escaped (#3057, TC-Lane-C R-Gate B1/B2)', () => {
  const G = loadV6Shell();
  const hostile = '<img src=x onerror=alert(1)>';

  it('B1: a busy label taken from the pane renders escaped, on first render and through setLive', () => {
    const live = plain(G.tcV6ExtractLiveTurns(['> go', `✶ ${hostile}… (esc to interrupt)`], 'claude', []));
    assert.equal(live.activity, `${hostile}…`, 'the extractor hands the label on as raw pane text');
    const chatView = (l) => ({ project: { id: 12, name: 'TC-Lane-PM' }, sessionId: 1, events: [], chat: { mode: 'direct', status: 'active', members: [], live: l } });
    const { shell, root, doc } = mountShell({ tree: TWO_GROUP_TREE, storage: null, setInterval: () => 1, clearInterval: () => {},
      detail: { kind: 'conversation', view: chatView(null) } });
    shell.setDetail({ kind: 'conversation', view: chatView(live) });
    const first = root.innerHTML.slice(root.innerHTML.indexOf('id="v6ChatActivity"'), root.innerHTML.indexOf('id="v6ChatForm"'));
    assert.match(first, /class="v6-chat-activity-label">&lt;img src=x onerror=alert\(1\)&gt;</);
    assert.doesNotMatch(first, /<img/);
    shell.setLive({ peek: null, live: Object.assign({}, live, { activity: `${hostile} again` }) });
    const polled = doc.getElementById('v6ChatActivity').innerHTML;
    assert.match(polled, /class="v6-chat-activity-label">&lt;img src=x onerror=alert\(1\)&gt; again</);
    assert.doesNotMatch(polled, /<img/);
  });

  it('B2: a version or latest tag from the repo renders escaped in its badge', () => {
    const header = (project) => {
      const html = G.tcV6ConversationViewMarkup({ project: Object.assign({ id: 12, name: 'P' }, project), sessionId: 1, events: [], chat: { status: 'active', members: [] } });
      return html.slice(html.indexOf('class="v6-chat-talking-to"'), html.indexOf('class="v6-chat-actions"'));
    };
    const fromVersion = header({ version: '<b>x</b>' });
    assert.match(fromVersion, /v6-chat-version-badge[^>]*>&lt;b&gt;x&lt;\/b&gt;</);
    assert.doesNotMatch(fromVersion, /<b>x/);
    const fromTag = header({ version: null, git: { latestTag: `v1${hostile}` } });
    assert.match(fromTag, /v6-chat-version-badge[^>]*>v1&lt;img src=x onerror=alert\(1\)&gt;</);
    assert.doesNotMatch(fromTag, /<img/);
  });
});

// ── #3059 (Car V625-W1-A): the lane being talked to in the sidebar, and a one-row icon toolbar ──

describe('the sidebar marks the lane the chat talks to (#3059)', () => {
  /**
   * A shell and live controller on `hash`, over a TC-Lane group whose PM is the delegate.
   * @param {string} hash
   */
  function mountRoute(hash) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const rows = [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }, { id: 10, name: 'TC-Lane-A', engine: { id: 'claude' } }];
    const api = async (url) => {
      if (url === '/api/projects') return { projects: rows };
      if (/\/status$/.test(url)) return { active: true, sessionId: 1 };
      if (/conversation\/events$/.test(url)) return { events: [] };
      if (/\/peek\?lines=80$/.test(url)) return { lines: [] };
      return null;
    };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null,
      setInterval: () => 0, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow(hash), storage: null, setInterval: () => 0, clearInterval: () => {},
      onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    /** @returns {Array<string>} The member links marked active, as their hrefs. */
    const activeMembers = () => [...root.innerHTML.matchAll(/<a class="v6-shell-member-link[^"]*\bis-active"\s+aria-current="page"[^>]*href="([^"]+)"/g)].map((x) => x[1]);
    return { root, settle, activeMembers };
  }

  it('a project route marks its delegate member active, with aria-current="page"', async () => {
    const m = mountRoute('#/projects/tc-lane');
    await m.settle();
    assert.match(m.root.innerHTML, /Talking to: <\/span><strong>TC-Lane-PM<\/strong>/, 'the chat resolved to the PM delegate');
    assert.deepEqual(m.activeMembers(), ['#/resources/12/conversation']);
  });

  it('a fleet route marks the same delegate, and a member route marks the member it names', async () => {
    const fleet = mountRoute('#/projects/tc-lane/fleets/tc-lane');
    await fleet.settle();
    assert.deepEqual(fleet.activeMembers(), ['#/resources/12/conversation']);
    const direct = mountRoute('#/resources/10/conversation');
    await direct.settle();
    assert.deepEqual(direct.activeMembers(), ['#/resources/10/conversation']);
  });

  it('a route with no chat marks no member', async () => {
    const m = mountRoute('#/settings/help');
    await m.settle();
    assert.deepEqual(m.activeMembers(), []);
  });

  it('the active lane is bold, tinted and accented on its left edge', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.v6-shell-member-link\.is-active \{\s*background: var\(--accent-bg[^;]*;\s*font-weight: 700;\s*box-shadow: inset 3px 0 0 #56d364;\s*\}/);
    assert.match(css, /\.v6-shell-project\.is-active,\s*\.v6-shell-fleet\.is-active \{[^}]*font-weight: 700;/);
  });
});

describe('the chat header is one compact row of identity and icons (#3059)', () => {
  const G = loadV6Shell();
  const view = (chat, project) => ({ project: Object.assign({ id: 12, name: 'TC-Lane-PM' }, project), sessionId: 1592, events: [],
    chat: Object.assign({ mode: 'delegate', nodeId: 'tc-lane', nodeName: 'TC-Lane', status: 'active',
      members: [{ id: '10', name: 'TC-Lane-A' }, { id: '12', name: 'TC-Lane-PM' }] }, chat || {}) });
  const header = (html) => html.slice(html.indexOf('<header class="v6-chat-header">'), html.indexOf('</header>'));

  it('Open Hood, Refresh and Project Settings are icon buttons named by title and aria-label, ids kept', () => {
    const h = header(G.tcV6ConversationViewMarkup(view()));
    assert.match(h, /class="btn btn-secondary btn-small v6-chat-icon-btn v6-open-hood"[^>]*title="Open Hood \(Live Terminal\)" aria-label="Open Hood \(Live Terminal\)"><span aria-hidden="true">&gt;_<\/span><\/a>/);
    assert.match(h, /<button type="button" id="v6ChatRefresh" class="btn btn-secondary btn-small v6-chat-icon-btn" title="Refresh conversation" aria-label="Refresh conversation"><span aria-hidden="true">↻<\/span><\/button>/);
    assert.match(h, /<button type="button" id="v6ChatSettings" class="btn btn-secondary btn-small v6-chat-icon-btn" title="Project Settings" aria-label="Project Settings"><span aria-hidden="true">⚙<\/span><\/button>/);
    assert.doesNotMatch(h, />Refresh<|>Project Settings<|>Open Hood \(Live Terminal\)</, 'no word labels left in the toolbar');
  });

  it('the identity strip carries the full detail as a tooltip and screen-reader text, and short chips on screen', () => {
    const delegate = header(G.tcV6ConversationViewMarkup(view()));
    assert.match(delegate, /<div class="v6-chat-identity">\s*<p class="v6-chat-talking-to" title="Talking to TC-Lane-PM \(#1592\) · Designated Project Delegate · Active"><span class="sr-only">Talking to: <\/span><strong>TC-Lane-PM<\/strong> \(#1592\)<span class="sr-only"> · Designated Project Delegate<\/span>/);
    assert.match(delegate, /<span class="v6-chat-mode" aria-hidden="true">Delegate<\/span>/);
    const direct = header(G.tcV6ConversationViewMarkup(view({ mode: 'direct', status: 'idle' }, { id: 10, name: 'TC-Lane-A' })));
    assert.match(direct, /title="Talking to TC-Lane-A \(#1592\) · Direct Session · Idle"/);
    assert.match(direct, /<span class="v6-chat-mode" aria-hidden="true">Direct<\/span>/);
  });

  it('the identity tooltip escapes the project name', () => {
    const h = header(G.tcV6ConversationViewMarkup(view({}, { name: 'x"><img src=x onerror=alert(1)>' })));
    assert.match(h, /title="Talking to x&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt; \(#1592\)/);
    assert.doesNotMatch(h, /<img/);
  });

  it('the delegate select keeps its accessible name, gains a tooltip, and its visible label text is gone', () => {
    const h = header(G.tcV6ConversationViewMarkup(view()));
    // Restated by #3063: the tooltip now leads with what the select does, then the #3059 wording.
    // Restated by #3079: the label is hidden (the Fleet sidebar switches members); the node stays.
    assert.match(h, /<label class="v6-chat-delegate-label" hidden><span class="sr-only">Delegate<\/span>\s*<select id="v6ChatDelegate"[^>]*aria-label="Choose who this project's chat talks to" title="Choose who this project's chat talks to — Switch Designated Project Delegate">/);
  });

  it('in a chat the route heading and the group heading are hidden from sight but kept for screen readers', () => {
    const { root, shell } = mountShell({ tree: TWO_GROUP_TREE, storage: null, initialHash: '#/resources/12/conversation',
      detail: { kind: 'conversation', view: view() } });
    assert.ok(root.classList.contains('v6-shell-root--chat'));
    assert.match(root.innerHTML, /<h1 class="v6-shell-title">/, 'the h1 is still in the page');
    assert.match(root.innerHTML, /<h2 class="v6-detail-title">TC-Lane<\/h2>/);
    shell.setDetail(null);
    assert.equal(root.classList.contains('v6-shell-root--chat'), false, 'other views keep their heading');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.v6-shell-root--chat \.v6-shell-title,\s*\.v6-chat-header \.v6-detail-title \{\s*position: absolute;\s*width: 1px;\s*height: 1px;[^}]*clip: rect\(0, 0, 0, 0\);/);
    assert.match(css, /\.v6-chat-header \{\s*display: flex;\s*flex-wrap: wrap;\s*align-items: center;\s*justify-content: space-between;/);
    assert.match(css, /\.v6-chat-icon-btn \{\s*min-width: 44px;/, 'icon buttons keep a 44px target');
  });
});

describe('the delegate chip escapes the delegate name in its title and accessible name (#3059, Charter A708 guardrail 4)', () => {
  const G = loadV6Shell();
  it('a hostile delegate name renders escaped in the title, the aria-label and the text', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 10, name: 'TC-Lane-A' }, sessionId: 1, events: [],
      chat: { mode: 'direct', nodeId: 'tc-lane', status: 'active', members: [], delegate: { id: '12', name: '<b>x</b>"' } } });
    const chip = html.slice(html.indexOf('<a id="v6ChatToDelegate"'), html.indexOf('</a>', html.indexOf('<a id="v6ChatToDelegate"')) + 4);
    assert.match(chip, /title="Switch to Delegate: &lt;b&gt;x&lt;\/b&gt;&quot;"/);
    assert.match(chip, /aria-label="Switch to Delegate: &lt;b&gt;x&lt;\/b&gt;&quot;"/);
    assert.match(chip, /<span aria-hidden="true">⇄<\/span> &lt;b&gt;x&lt;\/b&gt;&quot;<\/a>$/);
    assert.doesNotMatch(chip, /<b>x/);
  });
});

// ── #3063 (Car V626-W1-A): telemetry and the chat header share one condensed row ──

describe('telemetry chips say what they measure (#3063)', () => {
  const G = loadV6Shell();
  const bar = { scope: 'global', metrics: {
    activeSessions: { value: 23, confidence: 'observed' },
    health: { value: 'healthy', confidence: 'estimated' },
    versionDrift: { value: '6.2.5', confidence: 'observed' }
  } };
  const titles = (html) => [...html.matchAll(/<span class="v6-telemetry-chip[^"]*" title="([^"]*)">/g)].map((m) => m[1]);

  // Restated by #3079: Active sessions, Health and Version are drawn in the footer status bar,
  // so the header and the footer together carry every chip.
  const both = (b) => G.tcV6TelemetryHeaderMarkup(b) + G.tcV6WatermarkFooterMarkup(true, b);

  it('every chip has a tip with its value, its meaning and how sure the reading is', () => {
    assert.deepEqual(titles(both(bar)), [
      'Tokens: no reading yet — model tokens used (unavailable)',
      'Quota window: no reading yet — engine usage-quota window (unavailable)',
      'Context: no reading yet — how full a session&#39;s context window is (unavailable)',
      'Medusa: no reading yet — Medusa messages waiting to be read (unavailable)',
      'Active sessions: 23 — live sessions on this TangleClaw server (observed)',
      'Health: healthy — server health (estimated)',
      'Version: 6.2.5 — the TangleClaw version this server runs (observed)'
    ]);
  });

  it('a metric that gains a reading never reads as uncollected beside its value (cumulative review)', () => {
    const tips = titles(G.tcV6TelemetryHeaderMarkup({ scope: 'global', metrics: { tokens: { value: 1234, confidence: 'observed' } } }));
    assert.equal(tips[0], 'Tokens: 1234 — model tokens used (observed)');
    assert.doesNotMatch(tips.join('\n'), /not collected/);
  });

  it('a hostile metric value is escaped in the tip and in the chip', () => {
    const html = both({ scope: 'global', metrics: { versionDrift: { value: '"><img src=x onerror=alert(1)>', confidence: 'observed' } } });
    assert.match(html, /title="Version: &quot;&gt;&lt;img src=x onerror=alert\(1\)&gt; — the TangleClaw version this server runs \(observed\)"/);
    assert.doesNotMatch(html, /<img/);
  });

  it('a chip with no reading stays in the page (B4 keeps every metric)', () => {
    const html = both(bar);
    assert.equal((html.match(/class="v6-telemetry-chip /g) || []).length, 7);
    assert.equal((html.match(/v6-telemetry-chip is-unavailable/g) || []).length, 4);
  });
});

describe('in a chat the telemetry bar sits inside the chat header row (#3063)', () => {
  const G = loadV6Shell();
  const bar = { scope: 'global', metrics: { activeSessions: { value: 23, confidence: 'observed' } } };
  const chatView = { project: { id: 12, name: 'TC-Lane-PM' }, sessionId: 1, events: [], chat: { mode: 'direct', status: 'active', members: [] } };

  it('the bar renders once, inside .v6-chat-header between the identity strip and the actions', () => {
    const { root } = mountShell({ tree: TWO_GROUP_TREE, storage: null, telemetry: bar, detail: { kind: 'conversation', view: chatView } });
    const html = root.innerHTML;
    assert.equal((html.match(/class="v6-telemetry-header"/g) || []).length, 1, 'one bar, not two');
    const header = html.slice(html.indexOf('<header class="v6-chat-header">'), html.indexOf('</header>'));
    const identity = header.indexOf('class="v6-chat-identity"');
    const telemetry = header.indexOf('class="v6-telemetry-header"');
    const actions = header.indexOf('class="v6-chat-actions"');
    assert.ok(identity !== -1 && identity < telemetry && telemetry < actions, 'identity, then telemetry, then actions');
    assert.ok(html.indexOf('class="v6-telemetry-header"') > html.indexOf('<main id="v6ShellMain"'), 'not in the top grid row');
  });

  it('with no bar yet, the chat row carries the unavailable placeholder rather than a second row', () => {
    const { root } = mountShell({ tree: TWO_GROUP_TREE, storage: null, telemetry: null, detail: { kind: 'conversation', view: chatView } });
    const header = root.innerHTML.slice(root.innerHTML.indexOf('<header class="v6-chat-header">'), root.innerHTML.indexOf('</header>'));
    assert.match(header, /class="v6-telemetry-header is-unavailable"/);
    assert.equal((root.innerHTML.match(/v6-telemetry-header/g) || []).length, 1);
  });

  it('outside a chat the bar returns to its own row above the main view', () => {
    const { root, shell } = mountShell({ tree: TWO_GROUP_TREE, storage: null, telemetry: bar, detail: { kind: 'conversation', view: chatView } });
    shell.setDetail(null);
    const html = root.innerHTML;
    assert.equal((html.match(/class="v6-telemetry-header"/g) || []).length, 1);
    assert.ok(html.indexOf('class="v6-telemetry-header"') < html.indexOf('<main id="v6ShellMain"'));
  });

  it('a conversation rendered without a bar (the pure markup call) draws none', () => {
    assert.doesNotMatch(G.tcV6ConversationViewMarkup(chatView), /v6-telemetry-header/);
  });

  it('in a chat the chips are one-line pills and a chip with no reading is hidden', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.v6-shell-root--chat \.v6-telemetry-chip \{\s*flex-direction: row;\s*align-items: center;\s*gap: 4px;\s*padding: 1px 8px;\s*border-radius: 999px;\s*font-size: 0\.8em;/);
    assert.match(css, /\.v6-shell-root--chat \.v6-telemetry-chip\.is-unavailable \{\s*display: none;\s*\}/);
    assert.match(css, /\.v6-shell-root--chat \.v6-telemetry-header \{\s*margin-bottom: 0;/);
  });
});

// ── #3068 (Car V627-W1-A): four-icon sidebar toolbar, fleet picker, higher-contrast chat ──

describe('the sidebar\'s four-icon toolbar (#3068)', () => {
  const projects = [{ id: 11, name: 'TC-Lane-A', engine: { id: 'claude' } }, { id: 21, name: 'Medusa-PM', engine: { id: 'codex' } }];
  function mount(opts) {
    const m = mountShell(Object.assign({ tree: TWO_GROUP_TREE, storage: null }, opts || {}));
    m.shell.setProjects(projects);
    return m;
  }

  it('renders four symbol-only icons, each named by its title and aria-label, in a toolbar', () => {
    const { root } = mount();
    const bar = root.innerHTML.slice(root.innerHTML.indexOf('role="toolbar"'), root.innerHTML.indexOf('id="v6FilterFleet"'));
    assert.match(bar, /aria-label="Fleet sidebar tools"/);
    const icon = (id) => new RegExp(`<button type="button" id="${id}" class="btn btn-secondary btn-small v6-sidebar-icon[^"]*"[^>]*>`).exec(bar);
    assert.match(icon('v6SidebarCollapse')[0], /class="[^"]*v6-sidebar-collapse"[^>]*data-action="toggle-sidebar-drawer"[^>]*title="Hide Fleet sidebar" aria-label="Hide Fleet sidebar"/);
    assert.match(icon('v6SidebarModeFleet')[0], /aria-pressed="true"[^>]*title="Fleet view" aria-label="Fleet view"/);
    assert.match(icon('v6SidebarSearchToggle')[0], /aria-controls="v6SidebarSearch" aria-expanded="false" aria-pressed="false"[^>]*title="Search projects and filter by engine"/);
    // Restated by #3066: the reserved slot became the chat history and recents toggle.
    assert.match(icon('v6SidebarFutureSlot')[0], /aria-controls="v6HistoryPanel" aria-expanded="false" aria-pressed="false"[^>]*title="Chat history and recents" aria-label="Chat history and recents"/);
    assert.doesNotMatch(icon('v6SidebarFutureSlot')[0], / disabled/);
    for (const glyph of ['«', '❖', '🔍', '🕓']) assert.match(bar, new RegExp(`<span aria-hidden="true">${glyph}</span>`));
    assert.doesNotMatch(bar, />« Hide Fleet<|>Expand all<|>Collapse all</, 'no words on the toolbar');
  });

  it('the fleet-view icon is the only mode today: clicking it keeps it pressed and changes nothing', () => {
    const { doc, root } = mount();
    const before = root.innerHTML;
    doc.getElementById('v6SidebarModeFleet').dispatch('click');
    assert.equal(root.innerHTML, before);
  });

  it('the search icon opens search and engine; closing it clears both, so a hidden filter never narrows the tree', () => {
    const { doc, root } = mount();
    doc.getElementById('v6SidebarSearchToggle').dispatch('click');
    assert.match(root.innerHTML, /id="v6SidebarSearchToggle"[^>]*aria-expanded="true" aria-pressed="true"[^>]*title="Hide search and engine filter"/);
    assert.doesNotMatch(root.innerHTML, /<div id="v6SidebarSearch"[^>]*hidden>/);
    assert.equal(doc.activeElement, doc.getElementById('v6SidebarSearchToggle'), 'focus stays on the toggle');
    const box = doc.getElementById('v6FilterSearch');
    box.value = 'medusa';
    box.dispatch('input');
    const engine = doc.getElementById('v6FilterEngine');
    engine.value = 'codex';
    engine.dispatch('change');
    assert.doesNotMatch(root.innerHTML, /TC-Lane Fleet/);
    doc.getElementById('v6SidebarSearchToggle').dispatch('click');
    assert.match(root.innerHTML, /<div id="v6SidebarSearch"[^>]*hidden>/);
    assert.match(root.innerHTML, /id="v6FilterSearch"[^>]*value=""/);
    assert.match(root.innerHTML, /<option value="" selected>All Engines|<option value="">All Engines<\/option><option value="claude">/);
    assert.doesNotMatch(root.innerHTML, /<option value="codex" selected>/);
    assert.match(root.innerHTML, /TC-Lane Fleet/, 'the tree is whole again');
  });

  it('a filter in force stays in sight: re-renders keep the panel open, and only closing (which clears) hides it', () => {
    const { doc, root, shell } = mount();
    doc.getElementById('v6SidebarSearchToggle').dispatch('click');
    const box = doc.getElementById('v6FilterSearch');
    box.value = 'tc';
    box.dispatch('input');
    shell.setTree(TWO_GROUP_TREE);
    shell.setProjects(projects);
    assert.doesNotMatch(root.innerHTML, /<div id="v6SidebarSearch"[^>]*hidden>/);
    assert.match(root.innerHTML, /id="v6FilterSearch"[^>]*value="tc"/);
  });

  it('the fleet picker escapes a hostile project name and id', () => {
    const { root } = mountShell({ tree: [{ id: '"><img src=x>', displayName: '<b>x</b>', fleets: [] }], storage: null });
    const picker = root.innerHTML.slice(root.innerHTML.indexOf('<select id="v6FilterFleet"'), root.innerHTML.indexOf('</select>', root.innerHTML.indexOf('<select id="v6FilterFleet"')));
    assert.match(picker, /<option value="&quot;&gt;&lt;img src=x&gt;">&lt;b&gt;x&lt;\/b&gt;<\/option>/);
    assert.doesNotMatch(picker, /<b>x|<img/);
  });

  it('the toolbar, picker and search panel are styled for it', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.v6-sidebar-filters\[hidden\] \{\s*display: none;\s*\}/, 'hidden must win over the panel\'s display rule');
    assert.match(css, /\.v6-sidebar-icon \{\s*min-width: 44px;/);
    assert.match(css, /\.v6-sidebar-icon\[aria-pressed="true"\] \{\s*border-color: #56d364;/);
    assert.match(css, /\.v6-filter-fleet \{\s*width: 100%;/);
    assert.doesNotMatch(css, /\.v6-filter-pill|\.v6-filter-multi/, 'the pills\' rules went with the pills');
  });
});

describe('higher-contrast outlines and surfaces in the chat window (#3068)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const body = (selector) => {
    const m = new RegExp(`(^|\\n)${selector.replace(/[.[\]"=]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
    return m ? m[2] : '';
  };

  it('defines the outline and surface on the shell, with a lighter outline for the light theme', () => {
    assert.match(body('.v6-shell-root'), /--v6-outline: #3d444d;\s*--v6-surface: var\(--card-bg, #0d0d0d\);/);
    assert.match(body('[data-theme="light"] .v6-shell-root'), /--v6-outline: #8c959f;/);
  });

  it('gives the chat header, events and under-the-hood drawer 1.5px outlines and a surface fill', () => {
    for (const sel of ['.v6-chat-header', '.v6-conversation-event', '.v6-chat-under-hood']) {
      assert.match(body(sel), /border: 1\.5px solid var\(--v6-outline, #3d444d\);/, sel);
      assert.match(body(sel), /background: var\(--v6-surface, #0d0d0d\);/, sel);
    }
    assert.match(body('.v6-shell-sidebar'), /border-right: 1\.5px solid var\(--v6-outline, #3d444d\);/);
  });

  it('gives the composer a 2px outline and a green focus ring (PRR-B R1 B2)', () => {
    assert.match(body('.v6-chat-input'), /border: 2px solid var\(--v6-outline, #3d444d\);/);
    assert.match(body('.v6-chat-input'), /background: var\(--v6-surface, #0d0d0d\);/);
    assert.match(css, /\.v6-chat-input:focus,\s*\.v6-chat-input:focus-visible \{\s*outline: none;\s*border-color: #56d364;\s*box-shadow: 0 0 0 2px rgba\(86, 211, 100, 0\.35\);\s*\}/);
  });

  it('gives user and assistant turns distinct left accent bars (PRR-B R1 B1)', () => {
    assert.match(body('.v6-conversation-event.is-assistant'), /border-left: 3px solid #56d364;/);
    assert.match(body('.v6-conversation-event.is-user'), /border-left: 3px solid #58a6ff;/);
    const G = loadV6Shell();
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 1,
      events: [{ seq: 1, role: 'user', content: 'hi' }, { seq: 2, role: 'assistant', content: 'hello' }], chat: { status: 'active', members: [] } });
    assert.match(html, /class="v6-conversation-event is-user"/, 'the class the user bar keys on is rendered');
    assert.match(html, /class="v6-conversation-event is-assistant"/);
  });
});

describe('a remembered fleet that is gone does not trap the picker (#3068, cumulative review)', () => {
  it('shows "Fleet not found", and All Fleets then brings the whole tree back', () => {
    const storage = makeStorage({ tc_v6_selected_groups: JSON.stringify(['gone-fleet']) });
    const { doc, root } = mountShell({ tree: TWO_GROUP_TREE, storage });
    assert.match(root.innerHTML, /<option value="">All Fleets<\/option><option value="" disabled selected>Fleet not found<\/option>/);
    const el = doc.getElementById('v6FilterFleet');
    el.value = '';
    el.dispatch('change');
    assert.match(root.innerHTML, /TC-Lane Fleet/);
    assert.match(root.innerHTML, /Medusa Fleet/);
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), []);
  });

  it('before the project list loads it says so, and keeps the remembered choice', () => {
    const storage = makeStorage({ tc_v6_selected_groups: JSON.stringify(['medusa']) });
    const { root, shell } = mountShell({ tree: [], storage });
    assert.match(root.innerHTML, /<option value="" disabled selected>Loading fleets…<\/option>/);
    shell.setTree(TWO_GROUP_TREE);
    assert.match(root.innerHTML, /<option value="medusa" selected>Medusa<\/option>/);
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), ['medusa'], 'the saved choice survived the load');
  });

  it('"Several fleets" counts only fleets still there, and one survivor is simply selected', () => {
    const several = mountShell({ tree: TWO_GROUP_TREE, storage: makeStorage({ tc_v6_selected_groups: JSON.stringify(['tc-lane', 'medusa', 'gone']) }) });
    assert.match(several.root.innerHTML, /disabled selected>Several fleets \(2\)</);
    const single = mountShell({ tree: TWO_GROUP_TREE, storage: makeStorage({ tc_v6_selected_groups: JSON.stringify(['medusa', 'gone']) }) });
    assert.match(single.root.innerHTML, /<option value="medusa" selected>Medusa<\/option>/);
    assert.doesNotMatch(single.root.innerHTML, /disabled selected/);
  });
});

// ── #3071 (Car V628-W1-A): rename a fleet member from the chat header ──

describe('the chat\'s rename control (#3071)', () => {
  const G = loadV6Shell();
  const view = (status, name, extra) => ({ project: { id: 12, name: name || 'TC-Lane-A' }, sessionId: status === 'offline' ? null : 1, events: [],
    chat: Object.assign({ mode: 'direct', status, members: [] }, extra || {}) });

  it('offers a pencil to rename a project with no live session', () => {
    const html = G.tcV6ConversationViewMarkup(view('offline'));
    assert.match(html, /<button type="button" id="v6ChatRename" class="btn btn-secondary btn-small v6-chat-icon-btn"\s+title="Rename TC-Lane-A" aria-label="Rename TC-Lane-A"><span aria-hidden="true">✎<\/span><\/button>/);
  });

  it('disables it, and says why, while the project has a session (the server refuses and a rename moves its directory)', () => {
    for (const status of ['active', 'idle']) {
      const html = G.tcV6ConversationViewMarkup(view(status));
      assert.match(html, /id="v6ChatRename"[^>]*title="Stop TC-Lane-A&#39;s session to rename it" aria-label="Stop TC-Lane-A&#39;s session to rename it" disabled>/, status);
    }
  });

  it('the open form carries the current name, escaped, and never opens over a live session', () => {
    const hostile = 'x"><img src=x onerror=alert(1)>';
    const open = G.tcV6ConversationViewMarkup(view('offline', hostile, { rename: { open: true } }));
    assert.match(open, /<form id="v6ChatRenameForm"[^>]*aria-label="Rename x&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;">/);
    assert.match(open, /<input id="v6ChatRenameInput"[^>]*value="x&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
    assert.doesNotMatch(open, /<img/);
    assert.doesNotMatch(G.tcV6ConversationViewMarkup(view('active', 'P', { rename: { open: true } })), /v6ChatRenameForm/);
  });
});

describe('renaming through the mounted shell (#3071)', () => {
  const chatView = { project: { id: 12, name: 'TC-Lane-A' }, sessionId: null, events: [], chat: { mode: 'direct', status: 'offline', members: [] } };

  it('the pencil opens the form with focus in it; Cancel and Escape close it and return focus to the pencil', () => {
    const { doc, root } = mountShell({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView } });
    // The mini DOM's dispatch carries no key, so capture the input's keydown
    // handler as it is wired and call it with a real-shaped event.
    const keydowns = new Map();
    const register = doc._register.bind(doc);
    doc._register = (el) => {
      const add = el.addEventListener.bind(el);
      el.addEventListener = (type, fn) => { if (type === 'keydown') keydowns.set(el.id, fn); return add(type, fn); };
      return register(el);
    };
    doc.getElementById('v6ChatRename').dispatch('click');
    assert.match(root.innerHTML, /id="v6ChatRenameForm"/);
    assert.equal(doc.activeElement, doc.getElementById('v6ChatRenameInput'));
    doc.getElementById('v6ChatRenameCancel').dispatch('click');
    assert.doesNotMatch(root.innerHTML, /id="v6ChatRenameForm"/);
    assert.equal(doc.activeElement, doc.getElementById('v6ChatRename'));
    doc.getElementById('v6ChatRename').dispatch('click');
    keydowns.get('v6ChatRenameInput')({ key: 'Enter' });
    assert.match(root.innerHTML, /id="v6ChatRenameForm"/, 'another key leaves the form open');
    keydowns.get('v6ChatRenameInput')({ key: 'Escape' });
    assert.doesNotMatch(root.innerHTML, /id="v6ChatRenameForm"/);
  });

  // Restated after the cumulative Critic (R1 blocking): the form closes only once the rename is done.
  it('Save hands the old and the trimmed new name to the page; the form stays open until the page reports it done', () => {
    const calls = [];
    const { doc, root, shell } = mountShell({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView },
      onRenameProject: (from, to, opts) => calls.push([from, to, opts]) });
    doc.getElementById('v6ChatRename').dispatch('click');
    doc.getElementById('v6ChatRenameInput').value = '  TC-Lane-Alpha  ';
    doc.getElementById('v6ChatRenameForm').dispatch('submit');
    assert.deepEqual(calls, [['TC-Lane-A', 'TC-Lane-Alpha', undefined]]);
    assert.match(root.innerHTML, /id="v6ChatRenameForm"/, 'still open while the rename is in flight');
    shell.renameResult({ ok: true });
    assert.doesNotMatch(root.innerHTML, /id="v6ChatRenameForm"/);
  });

  it('a refusal keeps the form open with the name the operator typed (cumulative review R1)', () => {
    const { doc, root, shell } = mountShell({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView },
      onRenameProject: () => {} });
    doc.getElementById('v6ChatRename').dispatch('click');
    doc.getElementById('v6ChatRenameInput').value = 'Taken-Name';
    doc.getElementById('v6ChatRenameForm').dispatch('submit');
    shell.renameResult({ ok: false });
    assert.match(root.innerHTML, /<input id="v6ChatRenameInput"[^>]*value="Taken-Name"/);
  });

  it('an orphan-risk refusal shows the server\'s warning and a Rename anyway that resends with confirmOrphanRisk', () => {
    const calls = [];
    const { doc, root, shell } = mountShell({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView },
      onRenameProject: (from, to, opts) => calls.push([from, to, opts]) });
    doc.getElementById('v6ChatRename').dispatch('click');
    doc.getElementById('v6ChatRenameInput').value = 'New';
    doc.getElementById('v6ChatRenameForm').dispatch('submit');
    shell.renameResult({ ok: false, warning: 'WARNING: renaming "/a" to "/b" will orphan claude engine state <keyed>' });
    assert.match(root.innerHTML, /<p id="v6ChatRenameWarning" class="v6-chat-rename-warning" role="alert">WARNING: renaming &quot;\/a&quot; to &quot;\/b&quot; will orphan claude engine state &lt;keyed&gt;<\/p>/);
    doc.getElementById('v6ChatRenameConfirm').dispatch('click');
    assert.deepEqual(plain(calls[1]), ['TC-Lane-A', 'New', { confirmOrphanRisk: true }]);
  });
});

describe('the live controller renames the chat\'s target (#3071)', () => {
  /**
   * A controller over one offline project, with a scripted PATCH outcome.
   * @param {object|null} patchResult - What apiMutate resolves for the PATCH.
   * @param {string} [lastError]
   */
  function mountRename(patchResult, lastError) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    let rows = [{ id: 12, name: 'TC-Lane-A', engine: { id: 'claude' } }];
    const calls = [];
    const api = async (url) => {
      calls.push(`GET ${url}`);
      if (url === '/api/projects') return { projects: rows };
      if (/\/status$/.test(url)) return { active: false };
      return null;
    };
    api.lastError = null;
    const apiMutate = async (url, method, body) => {
      calls.push(`${method} ${url} ${JSON.stringify(body)}`);
      if (patchResult) rows = [{ id: 12, name: body.name, engine: { id: 'claude' } }];
      else api.lastError = lastError || null;
      return patchResult;
    };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate, storage: null, setInterval: () => 0, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null,
      setInterval: () => 0, clearInterval: () => {},
      onRender: (r) => pending.push(live.handleRoute(r)), onRenameProject: (a, b) => pending.push(live.renameProject(a, b)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    const submit = async (value) => {
      doc.getElementById('v6ChatRename').dispatch('click');
      doc.getElementById('v6ChatRenameInput').value = value;
      doc.getElementById('v6ChatRenameForm').dispatch('submit');
      await settle();
    };
    return { root, calls, settle, submit };
  }
  const patches = (calls) => calls.filter((c) => c.startsWith('PATCH'));
  const status = (root) => (/<p id="v6ChatStatus" class="v6-chat-send-status is-(\w+)"[^>]*>([^<]*)</.exec(root.innerHTML) || []).slice(1);

  it('renames through PATCH /api/projects/<old>, then reloads so the header and sidebar show the new name', async () => {
    const m = mountRename({ project: { name: 'TC-Lane-Alpha' }, warnings: [] });
    await m.settle();
    const before = m.calls.filter((c) => c === 'GET /api/projects').length;
    await m.submit('TC-Lane-Alpha');
    assert.deepEqual(patches(m.calls), ['PATCH /api/projects/TC-Lane-A {"name":"TC-Lane-Alpha"}']);
    assert.ok(m.calls.filter((c) => c === 'GET /api/projects').length > before, 'the rows were reloaded');
    assert.match(m.root.innerHTML, /Talking to: <\/span><strong>TC-Lane-Alpha<\/strong>/);
    assert.match(m.root.innerHTML, /TC-Lane-Alpha \(12\)/, 'the sidebar row too');
    assert.deepEqual(status(m.root), ['ok', 'Renamed TC-Lane-A to TC-Lane-Alpha.']);
  });

  it('reports the server\'s warnings with the rename', async () => {
    const m = mountRename({ project: { name: 'B' }, warnings: ['Update your scripts that name the old folder.'] });
    await m.settle();
    await m.submit('B');
    assert.deepEqual(status(m.root), ['warning', 'Renamed TC-Lane-A to B. Update your scripts that name the old folder.']);
  });

  it('a refusal shows the server\'s reason and changes nothing', async () => {
    const m = mountRename(null, 'Project "B" already exists');
    await m.settle();
    await m.submit('B');
    assert.equal(patches(m.calls).length, 1);
    assert.deepEqual(status(m.root), ['error', 'Not renamed: Project &quot;B&quot; already exists']);
    assert.match(m.root.innerHTML, /<strong>TC-Lane-A<\/strong>/);
  });

  it('an empty, unchanged or out-of-set name is refused here, with no request', async () => {
    const m = mountRename({ project: {}, warnings: [] });
    await m.settle();
    await m.submit('   ');
    assert.deepEqual(status(m.root), ['error', 'Not renamed: give TC-Lane-A a different name.']);
    await m.submit('TC-Lane-A');
    assert.deepEqual(status(m.root), ['error', 'Not renamed: give TC-Lane-A a different name.']);
    await m.submit('bad/name');
    assert.deepEqual(status(m.root), ['error', 'Not renamed: use only letters, digits, spaces, dashes and underscores.']);
    assert.deepEqual(patches(m.calls), []);
  });
});

describe('the controller asks before a rename that would orphan engine state (#3071, cumulative review R2)', () => {
  it('a refusal carrying the server\'s orphan-risk warning asks; Rename anyway resends with confirmOrphanRisk and completes', async () => {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    let rows = [{ id: 12, name: 'TC-Lane-A', engine: { id: 'claude' } }];
    const bodies = [];
    const api = async (url) => (url === '/api/projects' ? { projects: rows } : (/\/status$/.test(url) ? { active: false } : null));
    // Built by the server's own function, so a change to its wording fails here (cumulative review W4).
    const warning = require('../lib/workspace-rename-check').renameWarningFor(
      { hasOrphanRisk: true, affectedEngines: ['claude'], migrationSteps: ['mv ~/.claude/projects/-p-TC-Lane-A ~/.claude/projects/-p-B'] },
      '/p/TC-Lane-A', '/p/B');
    const apiMutate = async (url, method, body) => {
      bodies.push(JSON.parse(JSON.stringify(body)));
      if (!body.confirmOrphanRisk) { api.lastError = warning; return null; }
      rows = [{ id: 12, name: body.name, engine: { id: 'claude' } }];
      return { project: { name: body.name }, warnings: [] };
    };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate, storage: null, setInterval: () => 0, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null, setInterval: () => 0, clearInterval: () => {},
      onRender: (r) => pending.push(live.handleRoute(r)), onRenameProject: (a, b, o) => pending.push(live.renameProject(a, b, o)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    await settle();
    doc.getElementById('v6ChatRename').dispatch('click');
    doc.getElementById('v6ChatRenameInput').value = 'B';
    doc.getElementById('v6ChatRenameForm').dispatch('submit');
    await settle();
    assert.deepEqual(bodies, [{ name: 'B' }], 'the first try asks without confirmation');
    assert.match(root.innerHTML, /id="v6ChatRenameWarning"[^>]*>WARNING: renaming/);
    assert.match(root.innerHTML, /is-warning[^>]*>TC-Lane-A has engine state its rename would leave behind/);
    assert.match(root.innerHTML, /<input id="v6ChatRenameInput"[^>]*value="B"/);
    doc.getElementById('v6ChatRenameConfirm').dispatch('click');
    await settle();
    assert.deepEqual(bodies[1], { name: 'B', confirmOrphanRisk: true });
    assert.doesNotMatch(root.innerHTML, /id="v6ChatRenameForm"/);
    assert.match(root.innerHTML, /<strong>B<\/strong>/);
  });
});

// ── #3066 (Car V628-W1-A): chat history search, Recents and Reference in chat ──

describe('the history panel markup (#3066)', () => {
  const G = loadV6Shell();
  const hostile = '<img src=x onerror=alert(1)>';

  it('is reached from the sidebar clock, which is now live', () => {
    const { root, doc } = mountShell({ tree: TWO_GROUP_TREE, storage: null });
    doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    assert.match(root.innerHTML, /id="v6SidebarFutureSlot"[^>]*aria-expanded="true" aria-pressed="true"[^>]*title="Hide chat history and recents"/);
    assert.match(root.innerHTML, /<section id="v6HistoryPanel"[^>]*>\s*<p class="v6-history-status" role="status">Open a chat to see its history\.<\/p>/);
    doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    assert.doesNotMatch(root.innerHTML, /id="v6HistoryPanel"/);
  });

  it('escapes every server value: member, session, date, hit location and line, sections and excerpts', () => {
    const chatView = { project: { id: 12, name: 'TC-Lane-A' }, sessionId: 1, events: [], chat: { mode: 'direct', status: 'active', members: [] } };
    const { root, doc, shell } = mountShell({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView }, onHistoryLoad: () => {} });
    doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    shell.setHistory({ status: 'ready', mode: 'search', q: hostile, member: hostile, fleet: { name: hostile, count: 2 },
      items: [{ member: hostile, sid: hostile, date: hostile, matchCount: 2, hits: [{ loc: hostile, line: hostile }] }],
      notes: [hostile],
      snapshot: { member: hostile, sid: hostile, date: hostile, sections: [{ name: hostile, body: hostile }], excerpts: [{ loc: hostile, snippet: hostile }], note: hostile } });
    const panel = root.innerHTML.slice(root.innerHTML.indexOf('<section id="v6HistoryPanel"'), root.innerHTML.indexOf('</section>', root.innerHTML.indexOf('<section id="v6HistoryPanel"')));
    assert.doesNotMatch(panel, /<img/);
    assert.ok((panel.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 12, 'every value shows escaped');
  });

  it('lists results by member and session, and says how many matched', () => {
    const chatView = { project: { id: 12, name: 'TC-Lane-A' }, sessionId: 1, events: [], chat: { mode: 'direct', status: 'active', members: [] } };
    const { root, doc, shell } = mountShell({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView }, onHistoryLoad: () => {} });
    doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    shell.setHistory({ status: 'ready', mode: 'search', q: 'deploy', member: 'TC-Lane-A', fleet: { name: 'TC-Lane', count: 2 },
      items: [{ member: 'TC-Lane-PM', sid: '1663', date: '2026-11-13', matchCount: 3, hits: [{ loc: 'Decisions', line: 'deploy on Friday' }] }] });
    assert.match(root.innerHTML, /<p class="v6-history-status" role="status">1 session match “deploy”<\/p>/);
    assert.match(root.innerHTML, /<button type="button" id="v6HistoryItem-0" class="v6-history-item">\s*<span class="v6-history-who">TC-Lane-PM<\/span> session #1663\s*<span class="v6-history-date">2026-11-13 · 3 hits<\/span><\/button><span class="v6-history-hit"><span class="v6-history-hit-loc">Decisions<\/span> deploy on Friday<\/span>/);
    assert.match(root.innerHTML, /<option value="fleet">Whole fleet \(TC-Lane\) · 2<\/option>/);
  });
});

describe('the history panel in the mounted shell (#3066)', () => {
  const chatView = { project: { id: 12, name: 'TC-Lane-A' }, sessionId: 1, events: [], chat: { mode: 'direct', status: 'active', members: [] } };
  function mount(extra) {
    const loads = [];
    const opens = [];
    const m = mountShell(Object.assign({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView },
      onHistoryLoad: (f) => loads.push(plain(f)), onHistoryOpenSession: (p) => opens.push(plain(p)) }, extra || {}));
    return Object.assign(m, { loads, opens });
  }
  const snapshot = { member: 'TC-Lane-PM', sid: '1663', date: '2026-11-13', sections: [{ name: 'Decisions', body: 'Ship it on Friday.\nThen tag.' }], excerpts: [] };

  it('opening it loads the chat\'s recents (member scope, no query), and the form searches with what was set', () => {
    const m = mount();
    m.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    assert.deepEqual(m.loads, [{ scope: 'member', kind: 'summaries', q: '' }]);
    assert.match(m.root.innerHTML, /role="status">Loading…</);
    m.doc.getElementById('v6HistoryScope').value = 'fleet';
    m.doc.getElementById('v6HistoryKind').value = 'transcripts';
    m.doc.getElementById('v6HistorySearch').value = '  deploy ';
    m.doc.getElementById('v6HistoryForm').dispatch('submit');
    assert.deepEqual(m.loads[1], { scope: 'fleet', kind: 'transcripts', q: 'deploy' });
  });

  it('a result opens its session read-only, with the query', () => {
    const m = mount();
    m.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    m.shell.setHistory({ status: 'ready', mode: 'recents', member: 'TC-Lane-A', fleet: { name: 'TC-Lane', count: 2 },
      items: [{ member: 'TC-Lane-PM', sid: '1663', date: '2026-11-13', matchCount: 0, hits: [] }] });
    m.doc.getElementById('v6HistoryItem-0').dispatch('click');
    assert.deepEqual(m.opens, [{ member: 'TC-Lane-PM', sid: '1663', q: '', kind: 'summaries' }]);
  });

  it('Reference in chat adds the session\'s reference to this chat\'s message, after any text already typed', () => {
    const m = mount();
    m.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'Following up on';
    input.dispatch('input');
    m.shell.setHistory({ status: 'ready', mode: 'recents', member: 'TC-Lane-A', fleet: { name: 'TC-Lane', count: 2 }, items: [], snapshot });
    assert.match(m.root.innerHTML, /<div id="v6HistorySnapshot"[^>]*aria-label="TC-Lane-PM session 1663">/);
    m.doc.getElementById('v6HistoryReference').dispatch('click');
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*>Following up on\n\[TC-Lane-PM session #1663 · 2026-11-13\] Ship it on Friday\.<\/textarea>/);
    assert.equal(m.doc.activeElement, m.doc.getElementById('v6ChatInput'));
  });

  it('a reference prefers the first transcript excerpt and is cut to 200 characters', () => {
    const m = mount();
    m.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    m.shell.setHistory({ status: 'ready', mode: 'search', q: 'x', member: 'A', fleet: { name: '', count: 1 }, items: [],
      snapshot: { member: 'A', sid: '7', sections: [{ name: 'S', body: 'summary' }], excerpts: [{ loc: 'user', snippet: 'y'.repeat(300) }] } });
    m.doc.getElementById('v6HistoryReference').dispatch('click');
    assert.match(m.root.innerHTML, new RegExp(`<textarea id="v6ChatInput"[^>]*>\\[A session #7\\] ${'y'.repeat(199)}…</textarea>`));
  });

  it('Close leaves the list and drops the snapshot', () => {
    const m = mount();
    m.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    m.shell.setHistory({ status: 'ready', mode: 'recents', member: 'A', fleet: { name: '', count: 1 },
      items: [{ member: 'A', sid: '7', date: '', matchCount: 0, hits: [] }], snapshot });
    m.doc.getElementById('v6HistorySnapshotClose').dispatch('click');
    assert.doesNotMatch(m.root.innerHTML, /id="v6HistorySnapshot"/);
    assert.match(m.root.innerHTML, /id="v6HistoryItem-0"/);
  });

  it('an open panel follows the chat to a new target and reloads its recents', () => {
    const m = mount();
    m.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    m.shell.setDetail({ kind: 'conversation', view: Object.assign({}, chatView, { project: { id: 21, name: 'Medusa-PM' } }) });
    assert.equal(m.loads.length, 2);
  });
});

describe('the live controller loads history (#3066)', () => {
  /**
   * A controller on TC-Lane-A, whose group also holds TC-Lane-PM.
   * @param {object} answers - URL -> response (null for a failure).
   */
  function mountHistory(answers) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const rows = [{ id: 11, name: 'TC-Lane-A', engine: { id: 'claude' } }, { id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }];
    const calls = [];
    const api = async (url) => {
      if (url === '/api/projects') return { projects: rows };
      if (/\/api\/sessions\/[^/]+\/status$/.test(url)) return { active: false };
      if (url.startsWith('/api/continuity/')) {
        calls.push(url);
        const answer = answers[url];
        if (answer === null) { api.lastError = `refused ${url}`; return null; }
        return answer || { sessions: [] };
      }
      return null;
    };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null, setInterval: () => 0, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/11/conversation'), storage: null, setInterval: () => 0, clearInterval: () => {},
      onRender: (r) => pending.push(live.handleRoute(r)),
      onHistoryLoad: (f) => pending.push(live.loadHistory(f)), onHistoryOpenSession: (p) => pending.push(live.openHistorySession(p)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { root, doc, shell, calls, settle, live };
  }
  const rows = (root) => [...root.innerHTML.matchAll(/<span class="v6-history-who">([^<]*)<\/span> session #([^\s<]*)/g)].map((x) => `${x[1]}#${x[2]}`);

  it('member recents: one sessions read, newest first', async () => {
    const m = mountHistory({ '/api/continuity/TC-Lane-A/sessions': { sessions: [{ sid: '1', date: '2026-11-01' }, { sid: '2', date: '2026-11-09' }] } });
    await m.settle();
    m.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    await m.settle();
    assert.deepEqual(m.calls, ['/api/continuity/TC-Lane-A/sessions']);
    assert.deepEqual(rows(m.root), ['TC-Lane-A#2', 'TC-Lane-A#1']);
    assert.match(m.root.innerHTML, /2 recent sessions, newest first/);
  });

  it('a fleet search asks every member, merges the answers best match first, and names a member that failed', async () => {
    const m = mountHistory({
      '/api/continuity/TC-Lane-A/search?q=deploy&scope=transcripts': { sessions: [{ sid: '5', date: '2026-11-02', matchCount: 1, hits: [{ source: 'user', line: 'deploy?' }] }] },
      '/api/continuity/TC-Lane-PM/search?q=deploy&scope=transcripts': { sessions: [{ sid: '9', date: '2026-11-01', matchCount: 4, hits: [] }] }
    });
    await m.settle();
    await m.live.loadHistory({ scope: 'fleet', kind: 'transcripts', q: 'deploy' });
    assert.deepEqual(m.calls.sort(), ['/api/continuity/TC-Lane-A/search?q=deploy&scope=transcripts', '/api/continuity/TC-Lane-PM/search?q=deploy&scope=transcripts']);
    m.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    await m.settle();
    await m.live.loadHistory({ scope: 'fleet', kind: 'transcripts', q: 'deploy' });
    assert.deepEqual(rows(m.root), ['TC-Lane-PM#9', 'TC-Lane-A#5'], 'four hits outrank one');
    const failing = mountHistory({ '/api/continuity/TC-Lane-PM/search?q=x': null, '/api/continuity/TC-Lane-A/search?q=x': { sessions: [{ sid: '1', date: '', matchCount: 1, hits: [] }] } });
    await failing.settle();
    failing.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    await failing.settle();
    await failing.live.loadHistory({ scope: 'fleet', kind: 'summaries', q: 'x' });
    assert.deepEqual(rows(failing.root), ['TC-Lane-A#1']);
    assert.match(failing.root.innerHTML, /<p class="v6-history-note">Could not read TC-Lane-PM&#39;s history: refused \/api\/continuity\/TC-Lane-PM\/search\?q=x<\/p>/);
  });

  it('opening a session shows its wrap summary and, for a query, the transcript lines that match', async () => {
    const m = mountHistory({
      '/api/continuity/TC-Lane-PM/sessions/9': { sid: '9', session: { date: '2026-11-01' }, summary: { meta: {}, sections: { Decisions: 'Ship Friday.', Delta: '' } } },
      '/api/continuity/TC-Lane-PM/sessions/9/transcript/search?q=ship': { available: true, excerpts: [{ role: 'assistant', timestamp: 't1', snippet: 'we ship' }] }
    });
    await m.settle();
    m.doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    await m.settle();
    await m.live.openHistorySession({ member: 'TC-Lane-PM', sid: '9', q: 'ship' });
    assert.match(m.root.innerHTML, /<strong>TC-Lane-PM · session #9<\/strong>\s*<span class="v6-history-date">2026-11-01<\/span>/);
    assert.match(m.root.innerHTML, /<strong>Decisions<\/strong><div>Ship Friday\.<\/div>/);
    assert.doesNotMatch(m.root.innerHTML, /<strong>Delta<\/strong>/, 'empty sections are left out');
    assert.match(m.root.innerHTML, /<span class="v6-history-hit-loc">assistant · t1<\/span> we ship/);
  });
});

describe('the history panel and rename warning are styled for the narrow sidebar (#3066, #3071)', () => {
  it('stacks the panel, gives results a 44px target, wraps long text, and keeps the rename warning\'s line breaks', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.v6-history \{\s*display: flex;\s*flex-direction: column;/);
    assert.match(css, /\.v6-history-item \{[^}]*min-height: 44px;[^}]*overflow-wrap: anywhere;/);
    assert.match(css, /\.v6-history-section > div \{\s*white-space: pre-wrap;/);
    assert.match(css, /\.v6-chat-rename-warning \{[^}]*white-space: pre-wrap;/);
  });
});

describe('history panel fixes from the cumulative review (#3066)', () => {
  const chatView = { project: { id: 12, name: 'TC-Lane-A' }, sessionId: 1, events: [], chat: { mode: 'direct', status: 'active', members: [] } };

  it('W1: a transcript flagged for secrets is marked in the list and the snapshot, and its lines are never quoted into chat', () => {
    const loads = [];
    const { root, doc, shell } = mountShell({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView }, onHistoryLoad: (f) => loads.push(f) });
    doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    shell.setHistory({ status: 'ready', mode: 'search', q: 'k', member: 'A', fleet: { name: '', count: 1 },
      items: [{ member: 'A', sid: '7', date: '', matchCount: 1, secretsFlagged: true, hits: [] }],
      snapshot: { member: 'A', sid: '7', secretsFlagged: true, secretTypes: ['<aws>'], sections: [{ name: 'Decisions', body: 'Rotate the key.' }],
        excerpts: [{ loc: 'user', snippet: 'AKIA-SECRET-VALUE' }] } });
    assert.match(root.innerHTML, /<span class="v6-history-secret" title="Transcript flagged for possible secrets">⚠ secrets<\/span>/);
    assert.match(root.innerHTML, /<p class="v6-history-secret" role="note">⚠ This transcript was flagged for possible secrets \(&lt;aws&gt;\)\./);
    doc.getElementById('v6HistoryReference').dispatch('click');
    assert.match(root.innerHTML, /<textarea id="v6ChatInput"[^>]*>\[A session #7\] Rotate the key\.<\/textarea>/);
    assert.doesNotMatch(root.innerHTML.slice(root.innerHTML.indexOf('<textarea id="v6ChatInput"')), /AKIA-SECRET-VALUE<\/textarea>/);
  });

  it('W3: a refresh of the same chat keeps the panel and its snapshot; a rename of the member reloads it', () => {
    const loads = [];
    const { doc, shell, root } = mountShell({ tree: TWO_GROUP_TREE, storage: null, detail: { kind: 'conversation', view: chatView }, onHistoryLoad: (f) => loads.push(f) });
    doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    assert.equal(loads.length, 1);
    shell.setHistory({ status: 'ready', mode: 'recents', member: 'TC-Lane-A', fleet: { name: '', count: 1 }, items: [],
      snapshot: { member: 'TC-Lane-A', sid: '3', sections: [], excerpts: [] } });
    shell.setDetail({ kind: 'loading' });
    shell.setDetail({ kind: 'conversation', view: chatView });
    assert.equal(loads.length, 1, 'no reload for the same chat');
    assert.match(root.innerHTML, /id="v6HistorySnapshot"/, 'the snapshot survived the refresh');
    shell.setDetail({ kind: 'conversation', view: Object.assign({}, chatView, { project: { id: 12, name: 'TC-Lane-Alpha' } }) });
    assert.equal(loads.length, 2, 'a rename reloads');
  });
});

describe('the controller drops history answers that a newer request overtook (#3066, cumulative review W2)', () => {
  it('a slow earlier search never overwrites a newer one, and a late list never closes a snapshot opened after it', async () => {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const rows = [{ id: 11, name: 'TC-Lane-A', engine: { id: 'claude' } }];
    const gates = {};
    const hold = (url) => new Promise((resolve) => { gates[url] = resolve; });
    const api = async (url) => {
      if (url === '/api/projects') return { projects: rows };
      if (/\/status$/.test(url)) return { active: false };
      if (url.startsWith('/api/continuity/')) return hold(url);
      return null;
    };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null, setInterval: () => 0, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/11/conversation'), storage: null, setInterval: () => 0, clearInterval: () => {},
      onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    while (pending.length) await pending.shift();
    doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    const tick = () => new Promise((r) => setImmediate(r));
    const slow = live.loadHistory({ scope: 'member', kind: 'summaries', q: 'old' });
    await tick();
    const fast = live.loadHistory({ scope: 'member', kind: 'summaries', q: 'new' });
    await tick();
    gates['/api/continuity/TC-Lane-A/search?q=new']({ sessions: [{ sid: '2', date: '', matchCount: 1, hits: [] }] });
    await fast;
    gates['/api/continuity/TC-Lane-A/search?q=old']({ sessions: [{ sid: '1', date: '', matchCount: 1, hits: [] }] });
    await slow;
    assert.match(root.innerHTML, /session #2/);
    assert.doesNotMatch(root.innerHTML, /session #1/, 'the overtaken answer was dropped');
    const list = live.loadHistory({ scope: 'member', kind: 'summaries', q: '' });
    await tick();
    const open = live.openHistorySession({ member: 'TC-Lane-A', sid: '2', q: '' });
    await tick();
    gates['/api/continuity/TC-Lane-A/sessions/2']({ sid: '2', session: {}, summary: { sections: { Decisions: 'kept' } } });
    await open;
    gates['/api/continuity/TC-Lane-A/sessions']({ sessions: [] });
    await list;
    assert.match(root.innerHTML, /id="v6HistorySnapshot"/, 'the late list did not close the snapshot');
    const slowOpen = live.openHistorySession({ member: 'TC-Lane-A', sid: '8', q: '' });
    await tick();
    const fastOpen = live.openHistorySession({ member: 'TC-Lane-A', sid: '9', q: '' });
    await tick();
    gates['/api/continuity/TC-Lane-A/sessions/9']({ sid: '9', session: {}, summary: { sections: { Decisions: 'nine' } } });
    await fastOpen;
    gates['/api/continuity/TC-Lane-A/sessions/8']({ sid: '8', session: {}, summary: { sections: { Decisions: 'eight' } } });
    await slowOpen;
    assert.match(root.innerHTML, /TC-Lane-A · session #9/, 'the newer session stays open');
    assert.doesNotMatch(root.innerHTML, /TC-Lane-A · session #8/);
  });
});

describe('the chat\'s own history button and the Open Hood path (#3066, #3073)', () => {
  const G = loadV6Shell();
  const chatView = (name) => ({ project: { id: 12, name: name || 'TC-Lane-A' }, sessionId: 1, events: [], chat: { mode: 'direct', status: 'active', members: [] } });

  it('Open Hood links to /session/<name>, the path the server serves, URL-encoded (#3073)', () => {
    const html = G.tcV6ConversationViewMarkup(chatView('TiLT v2'));
    assert.match(html, /v6-open-hood" href="\/session\/TiLT%20v2"/);
    assert.doesNotMatch(html, /session\.html\?project=/);
  });

  it('the chat actions carry a clock for this member\'s history, its name escaped', () => {
    const html = G.tcV6ConversationViewMarkup(chatView('a"<b>'));
    assert.match(html, /<button type="button" id="v6ChatHistory" class="btn btn-secondary btn-small v6-chat-icon-btn" title="History and recents for a&quot;&lt;b&gt;" aria-label="History and recents for a&quot;&lt;b&gt;"><span aria-hidden="true">🕓<\/span><\/button>/);
  });

  it('it opens the member\'s history in the sidebar, revealing a hidden sidebar and opening the phone drawer', () => {
    const loads = [];
    const storage = makeStorage({ tc_v6_sidebar_collapsed: 'true' });
    const { doc, root, shell } = mountShell({ tree: TWO_GROUP_TREE, storage, detail: { kind: 'conversation', view: chatView() }, onHistoryLoad: (f) => loads.push(plain(f)) });
    assert.equal(shell.isSidebarCollapsed(), true);
    doc.getElementById('v6ChatHistory').dispatch('click');
    assert.equal(shell.isSidebarCollapsed(), false);
    assert.equal(storage.data.tc_v6_sidebar_collapsed, 'false');
    assert.equal(shell.isDrawerOpen(), true);
    assert.equal(shell.isHistoryOpen(), true);
    assert.deepEqual(loads, [{ scope: 'member', kind: 'summaries', q: '' }]);
    assert.match(root.innerHTML, /id="v6HistoryPanel"/);
  });

  it('a session flagged only on its session record still shows the secrets warning (verify observation)', async () => {
    const H = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const api = async (url) => {
      if (url === '/api/projects') return { projects: [{ id: 11, name: 'A', engine: { id: 'claude' } }] };
      if (/\/status$/.test(url)) return { active: false };
      if (url === '/api/continuity/A/sessions/old-1') return { sid: 'old-1', session: { secretsFlagged: true }, transcript: null, summary: { sections: { Decisions: 'd' } } };
      return { sessions: [] };
    };
    let shell = null;
    const pending = [];
    const live = H.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null, setInterval: () => 0, clearInterval: () => {} });
    shell = H.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/11/conversation'), storage: null, setInterval: () => 0, clearInterval: () => {},
      onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    while (pending.length) await pending.shift();
    doc.getElementById('v6SidebarFutureSlot').dispatch('click');
    await live.openHistorySession({ member: 'A', sid: 'old-1', q: '' });
    assert.match(root.innerHTML, /<p class="v6-history-secret" role="note">⚠ This transcript was flagged for possible secrets/);
  });
});

// ── #3076 / #3079 (Car V629-W1-A): switchboard Under the Hood, Medusa indicator, chat polish ──

describe('switchboard traffic leaves the conversation (#3076)', () => {
  const G = loadV6Shell();
  const run = (lines, known) => plain(G.tcV6ExtractLiveTurns(lines, 'claude', known || []));

  it('a wake typed into the pane is switchboard traffic, not the operator, with its wrapped lines joined', () => {
    // The real wake's words (lib/medusa-wake.js), wrapped as the pane shows them.
    const out = run(['> fix it', '⏺ Fixed. Shall I push?', '> [TangleClaw Switchboard] You have 2 unread Medusa message(s): tc message read.',
      '  Reply where an answer is needed, BEFORE marking it handled: tc message send']);
    assert.deepEqual(out.turns.map((t) => t.role), ['user', 'assistant']);
    assert.deepEqual(out.switchboard, [{ dir: 'in', text: '[TangleClaw Switchboard] You have 2 unread Medusa message(s): tc message read. Reply where an answer is needed, BEFORE marking it handled: tc message send' }]);
    assert.deepEqual(out.questions, ['Fixed. Shall I push?'], 'a wake does not answer the question');
  });

  it('a bare wake or TangleClaw notice line is traffic too (the fixture pane)', () => {
    assert.deepEqual(run(PANES.claude).switchboard, [{ dir: 'in', text: '[TangleClaw Switchboard] You have 1 unread Medusa message(s): tc message read.' }]);
    assert.deepEqual(run(['[TangleClaw] Your workload report has expired']).switchboard, [{ dir: 'in', text: '[TangleClaw] Your workload report has expired' }]);
  });

  it('a tc message send in a tool line or a shell line is outbound traffic; prose that mentions it is a reply', () => {
    const out = run(['> reply to PM', '⏺ Bash(tc message send --in-reply-to m1 tc-lane-pm "done")', '  ⎿  received',
      '$ tc message send tc-lane-int "ready"', '⏺ I used tc message send to tell them.']);
    assert.deepEqual(out.switchboard.map((x) => x.dir), ['out', 'out']);
    assert.match(out.switchboard[0].text, /^⏺ Bash\(tc message send --in-reply-to m1/);
    assert.deepEqual(out.turns[1], { role: 'assistant', text: 'I used tc message send to tell them.' });
  });

  it('a recorded wake leaves the stream and is listed Under the Hood, escaped; a pane copy of it is not listed twice', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 2,
      events: [{ seq: 1, role: 'user', content: 'real ask' }, { seq: 2, role: 'user', content: '[TangleClaw Switchboard] <b>1</b> unread' }],
      chat: { status: 'active', members: [], live: { turns: [], switchboard: [
        { dir: 'in', text: '[TangleClaw Switchboard] <b>1</b> unread' }, { dir: 'out', text: 'tc message send x "<i>hi</i>"' }] } } });
    const stream = html.slice(html.indexOf('id="v6ChatStream"'), html.indexOf('id="v6ChatUnderHood"'));
    assert.match(stream, /real ask/);
    assert.doesNotMatch(stream, /TangleClaw Switchboard/);
    const hood = html.slice(html.indexOf('id="v6ChatSwitchboard"'), html.indexOf('id="v6ChatPeek"'));
    assert.equal((hood.match(/is-in/g) || []).length, 1, 'the pane copy of a recorded wake is not repeated');
    assert.match(hood, /<li class="v6-chat-switchboard-item is-in"><span class="v6-chat-switchboard-dir">← in<\/span> <span class="v6-chat-switchboard-text">\[TangleClaw Switchboard\] &lt;b&gt;1&lt;\/b&gt; unread<\/span><\/li>/);
    assert.match(hood, /is-out[\s\S]*tc message send x &quot;&lt;i&gt;hi&lt;\/i&gt;&quot;/);
    assert.doesNotMatch(hood, /<b>|<i>/);
  });

  it('with no traffic the list says so', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 2, events: [], chat: { status: 'active', members: [] } });
    assert.match(html, /<ol id="v6ChatSwitchboard"[^>]*><li class="v6-chat-switchboard-empty">No switchboard traffic on screen\.<\/li><\/ol>/);
  });
});

describe('the Medusa indicator in the chat header (#3076)', () => {
  const G = loadV6Shell();

  it('draws nothing before a status answers or where Medusa is not turned on', () => {
    assert.equal(G.tcV6MedusaIndicatorMarkup(null), '');
    assert.equal(G.tcV6MedusaIndicatorMarkup(undefined), '');
    assert.equal(G.tcV6MedusaIndicatorMarkup({ state: 'listening', unread: 2, enabled: false }), '');
  });

  it('shows both heads around an @ badge, which becomes the unread count', () => {
    const idle = G.tcV6MedusaIndicatorMarkup({ state: 'listening', unread: 0, enabled: true, inbound: 1, outbound: 0 });
    assert.match(idle, /<button type="button" id="v6ChatMedusa" class="v6-chat-medusa is-listening" aria-controls="v6ChatUnderHood"/);
    assert.match(idle, /<img class="v6-medusa-head v6-medusa-head--in" src="\/medusa-head-left\.webp" alt=""[\s\S]*<span id="v6ChatMedusaBadge" class="v6-chat-medusa-badge" aria-hidden="true">@<\/span>[\s\S]*<img class="v6-medusa-head v6-medusa-head--out" src="\/medusa-head-right\.webp" alt=""/);
    assert.match(idle, /title="Medusa: listening · 0 unread · on screen: 1 in, 0 out — open Under the Hood for the traffic"/);
    const mail = G.tcV6MedusaIndicatorMarkup({ state: 'listening', unread: 3 });
    assert.match(mail, /<span id="v6ChatMedusaBadge" class="v6-chat-medusa-badge has-unread" aria-hidden="true">3<\/span>/);
  });

  it('blinks the head for the direction traffic moved, and an unknown state reads as off', () => {
    assert.match(G.tcV6MedusaIndicatorMarkup({ state: 'listening', flowIn: true }), /class="v6-chat-medusa is-listening is-flow-in"/);
    assert.match(G.tcV6MedusaIndicatorMarkup({ state: 'listening', flowOut: true }), /class="v6-chat-medusa is-listening is-flow-out"/);
    assert.match(G.tcV6MedusaIndicatorMarkup({ state: '"><x' }), /class="v6-chat-medusa is-off"/);
  });

  it('escapes the listener error in its tip and label', () => {
    const html = G.tcV6MedusaIndicatorMarkup({ state: 'error', lastError: '"><img src=x onerror=alert(1)>', unread: '<b>' });
    assert.match(html, /title="Medusa: error \(&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;\) · 0 unread/);
    assert.doesNotMatch(html, /<img src=x|<b>/);
    // The count is read as a number before it is drawn, so a non-number reads as no mail.
    assert.match(html, /<span id="v6ChatMedusaBadge" class="v6-chat-medusa-badge" aria-hidden="true">@<\/span>/);
  });

  it('sits in the chat actions only while the session is live', () => {
    const view = (status) => G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: status === 'offline' ? null : 2, events: [],
      chat: { status, members: [], medusa: { state: 'listening', unread: 1 } } });
    assert.match(view('active'), /<div class="v6-chat-actions">\s*<span id="v6ChatMedusaSlot" class="v6-chat-medusa-slot"><button type="button" id="v6ChatMedusa"/);
    assert.doesNotMatch(view('offline'), /v6ChatMedusa/);
  });
});

describe('the Waiting on you queue (#3079)', () => {
  const G = loadV6Shell();
  const run = (lines, known) => plain(G.tcV6ExtractLiveTurns(lines, 'claude', known || []));

  it('collects every question in the newest reply, list markers stripped, not only the last line', () => {
    const out = run(['> plan it', '⏺ Three things first:', '  1. Should I branch from main?', '  2) Is the 7-file scope final?',
      '  - Do you want a PR now?', '  Then I start.']);
    assert.deepEqual(out.questions, ['Should I branch from main?', 'Is the 7-file scope final?', 'Do you want a PR now?']);
    assert.equal(out.question, null, 'the single-question field still reads the last line only');
  });

  it('an answer clears the queue even when the pane echoes a prompt that is already recorded', () => {
    const lines = ['⏺ Ready?', '> yes go'];
    assert.deepEqual(run(lines, ['yes go']).questions, []);
    assert.deepEqual(run(lines, []).questions, []);
  });

  it('numbers several questions, escapes each, and gives each a dismiss button', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 2, events: [],
      chat: { status: 'active', members: [], live: { turns: [{ role: 'assistant', text: 'x' }], questions: ['A <b>?', 'B?'] } } });
    assert.match(html, /<div id="v6ChatQuestion" class="v6-chat-question is-asking"/);
    assert.match(html, /<span class="v6-chat-question-badge" aria-hidden="true">\(1\)<\/span> <span class="v6-chat-question-text">A &lt;b&gt;\?<\/span>/);
    assert.match(html, /<span class="v6-chat-question-badge" aria-hidden="true">\(2\)<\/span> <span class="v6-chat-question-text">B\?<\/span>/);
    assert.match(html, /id="v6ChatQuestionDismiss0" data-index="0" title="Dismiss this question" aria-label="Dismiss question 1"/);
    assert.match(html, /id="v6ChatQuestionDismiss1"/);
    assert.doesNotMatch(html, /<b>/);
  });

  it('one question carries no badge', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 2, events: [],
      chat: { status: 'active', members: [], live: { turns: [], questions: ['Only?'] } } });
    assert.doesNotMatch(html, /v6-chat-question-badge/);
    assert.match(html, /<span class="v6-chat-question-text">Only\?<\/span>/);
  });

  /** A shell showing a chat whose newest reply asks two questions. */
  function mountQuestions(onSendChat) {
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/projects/x'), storage: null, onSendChat });
    const live = { turns: [{ role: 'assistant', text: 'One?\nTwo?' }], questions: ['One?', 'Two?'] };
    shell.setDetail({ kind: 'conversation', view: { project: { id: 12, name: 'P' }, sessionId: 1, events: [], chat: { status: 'active', members: [], live } } });
    return { shell, doc, root, live };
  }

  it('✕ dismisses one question, and a poll reading the same reply does not bring it back', () => {
    const m = mountQuestions();
    m.doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    const q = m.doc.getElementById('v6ChatQuestion');
    assert.doesNotMatch(q.innerHTML, /One\?/);
    assert.match(q.innerHTML, /Two\?/);
    m.shell.setLive({ peek: null, live: m.live });
    assert.doesNotMatch(m.doc.getElementById('v6ChatQuestion').innerHTML, /One\?/);
  });

  it('the same words asked in a later reply show again, once the first was answered', () => {
    const m = mountQuestions();
    m.doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'user', text: 'ok' }], questions: [] } });
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'assistant', text: 'New reply. One?' }], questions: ['One?'] } });
    assert.match(m.doc.getElementById('v6ChatQuestion').innerHTML, /One\?/);
  });

  it('the same words asked in the very next reply show, with no empty poll between (PRR-B R1)', () => {
    const m = mountQuestions();
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'user', text: 'u1' }, { role: 'assistant', text: 'One?' }], questions: ['One?'] } });
    m.doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    assert.doesNotMatch(m.doc.getElementById('v6ChatQuestion').innerHTML, /One\?/);
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'user', text: 'u1' }, { role: 'assistant', text: 'One?' },
      { role: 'user', text: 'u2' }, { role: 'assistant', text: 'Still: One?' }], questions: ['One?'] } });
    assert.match(m.doc.getElementById('v6ChatQuestion').innerHTML, /One\?/);
  });

  it('a dismissal holds while the same reply grows, by a wake or by more text (Critic W2)', () => {
    const m = mountQuestions();
    m.doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'assistant', text: 'One?\nTwo?\nAnd a reply to the wake.' }], questions: ['One?', 'Two?'] } });
    const html = m.doc.getElementById('v6ChatQuestion').innerHTML;
    assert.doesNotMatch(html, /One\?/);
    assert.match(html, /Two\?/);
  });

  it('a failed read of the pane does not spend a dismissal (second review, W1)', () => {
    const m = mountQuestions();
    m.doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    m.shell.setLive({ peek: { error: 'x' }, live: null });
    m.shell.setLive({ peek: { error: 'x' }, live: { turns: [], question: null, activity: 'Working' } });
    m.shell.setLive({ peek: null, live: m.live });
    assert.doesNotMatch(m.doc.getElementById('v6ChatQuestion').innerHTML, /One\?/);
  });

  it('a poll that changes nothing leaves the question slot, and the ✕ that has focus, alone (Critic W1)', () => {
    const m = mountQuestions();
    const q = m.doc.getElementById('v6ChatQuestion');
    let writes = 0;
    let html = q.innerHTML;
    Object.defineProperty(q, 'innerHTML', { configurable: true, get: () => html, set: (v) => { writes++; html = v; } });
    m.shell.setLive({ peek: null, live: m.live });
    m.shell.setLive({ peek: null, live: m.live });
    assert.equal(writes, 0);
  });

  it('dismissing a question moves focus to the ✕ now in its place, then to the message box', () => {
    const m = mountQuestions();
    m.doc.getElementById('v6ChatQuestionDismiss1').dispatch('click');
    assert.equal(m.doc.activeElement, m.doc.getElementById('v6ChatQuestionDismiss0'));
    m.doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    assert.equal(m.doc.activeElement, m.doc.getElementById('v6ChatInput'));
  });

  it('sending a reply clears the queue, once the send really goes', () => {
    const sent = [];
    const m = mountQuestions((t) => sent.push(t));
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'both yes';
    input.dispatch('input');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    assert.deepEqual(sent, ['both yes']);
    // Restated by #3082: a press that sends nothing (a send still on its way) must not clear it,
    // so the queue clears when the controller begins the send.
    m.shell.beginSend(12, 'both yes', 1);
    const q = m.doc.getElementById('v6ChatQuestion');
    assert.equal(q.innerHTML, '');
    assert.equal(q.className, 'v6-chat-question');
  });
});

describe('the Medusa indicator, live through the controller (#3076)', () => {
  /** A live chat whose peek and Medusa status answer in sequence, one entry per read. */
  function mountMedusa(peeks, statuses) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    let p = 0;
    let s = 0;
    const calls = [];
    const api = async (url) => {
      calls.push(url);
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }] };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1592 };
      if (url === '/api/v6/projects/12/sessions/1592/conversation/events') return { events: [] };
      if (url === '/api/sessions/TC-Lane-PM/peek?lines=80') return { lines: peeks[Math.min(p++, peeks.length - 1)] };
      if (url === '/api/sessions/TC-Lane-PM/medusa/status') return statuses[Math.min(s++, statuses.length - 1)];
      return null;
    };
    const timers = [];
    const storage = makeStorage();
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => ({ ok: true }), storage,
      setInterval: (fn) => { timers.push(fn); return timers.length - 1; }, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage, onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { shell, root, doc, timers, settle, calls, storage };
  }

  it('reads the status with the peek; the first reading never blinks, even with mail waiting', async () => {
    const m = mountMedusa([['> go']], [{ state: 'listening', unread: 2, enabled: true }]);
    await m.settle();
    assert.ok(m.calls.includes('/api/sessions/TC-Lane-PM/medusa/status'));
    assert.match(m.root.innerHTML, /class="v6-chat-medusa is-listening"/);
    assert.match(m.root.innerHTML, /<span id="v6ChatMedusaBadge" class="v6-chat-medusa-badge has-unread" aria-hidden="true">2<\/span>/);
  });

  it('more unread blinks the inbound head; a new send blinks the outbound head; a quiet poll stops both', async () => {
    const m = mountMedusa(
      [['> go'], ['> go'], ['> go', '⏺ Bash(tc message send peer "hi")'], ['> go', '⏺ Bash(tc message send peer "hi")']],
      [{ state: 'listening', unread: 0 }, { state: 'listening', unread: 1 }, { state: 'listening', unread: 1 }, { state: 'listening', unread: 1 }]);
    await m.settle();
    // Updated in place, so the button the operator may be on is never replaced (Critic W1).
    const btn = m.doc.getElementById('v6ChatMedusa');
    await m.timers[0]();
    assert.equal(btn.className, 'v6-chat-medusa is-listening is-flow-in');
    assert.equal(m.doc.getElementById('v6ChatMedusaBadge').textContent, '1');
    assert.equal(m.doc.getElementById('v6ChatMedusaBadge').className, 'v6-chat-medusa-badge has-unread');
    assert.equal(btn.getAttribute('aria-label'), 'Medusa: listening · 1 unread · on screen: 0 in, 0 out — open Under the Hood for the traffic');
    await m.timers[0]();
    assert.equal(btn.className, 'v6-chat-medusa is-listening is-flow-out');
    assert.match(m.doc.getElementById('v6ChatSwitchboard').innerHTML, /is-out[\s\S]*tc message send peer/);
    await m.timers[0]();
    assert.equal(btn.className, 'v6-chat-medusa is-listening');
    assert.equal(m.doc.getElementById('v6ChatMedusa'), btn);
  });

  it('a quiet poll does not touch the indicator at all, and one that hides it removes it', async () => {
    const m = mountMedusa([['> go']], [{ state: 'listening', unread: 0 }, { state: 'listening', unread: 0 }, { state: 'listening', enabled: false }]);
    await m.settle();
    const slot = m.doc.getElementById('v6ChatMedusaSlot');
    let writes = 0;
    let html = slot.innerHTML;
    Object.defineProperty(slot, 'innerHTML', { configurable: true, get: () => html, set: (v) => { writes++; html = v; } });
    await m.timers[0]();
    assert.equal(writes, 0);
    await m.timers[0]();
    assert.equal(writes, 1);
    assert.equal(html, '');
  });

  it('a new wake on screen blinks the inbound head even before unread moves', async () => {
    const m = mountMedusa([['> go'], ['> go', '> [TangleClaw Switchboard] You have 1 unread']], [{ state: 'listening', unread: 1 }]);
    await m.settle();
    await m.timers[0]();
    assert.equal(m.doc.getElementById('v6ChatMedusa').className, 'v6-chat-medusa is-listening is-flow-in');
  });

  it('a failed status read keeps the last reading without blinking', async () => {
    const m = mountMedusa([['> go']], [{ state: 'listening', unread: 1 }, null]);
    await m.settle();
    const slot = m.doc.getElementById('v6ChatMedusaSlot');
    let writes = 0;
    Object.defineProperty(slot, 'innerHTML', { configurable: true, get: () => '', set: () => { writes++; } });
    await m.timers[0]();
    assert.equal(writes, 0, 'the indicator was neither emptied nor redrawn');
    // Nothing changed, so nothing was redrawn: the first render's markup stands.
    assert.match(m.root.innerHTML, /<button type="button" id="v6ChatMedusa" class="v6-chat-medusa is-listening" /);
    assert.match(m.root.innerHTML, /<span id="v6ChatMedusaBadge" class="v6-chat-medusa-badge has-unread" aria-hidden="true">1<\/span>/);
  });

  it('clicking it opens Under the Hood at the switchboard traffic, and remembers the drawer open', async () => {
    const m = mountMedusa([['> go']], [{ state: 'listening', unread: 0 }]);
    await m.settle();
    m.doc.getElementById('v6ChatMedusa').dispatch('click');
    assert.equal(m.doc.getElementById('v6ChatUnderHood').open, true);
    assert.equal(m.doc.activeElement, m.doc.getElementById('v6ChatSwitchboard'));
    m.shell.setTelemetry(null);
    assert.match(m.root.innerHTML, /<details id="v6ChatUnderHood" class="v6-chat-under-hood" open>/);
  });
});

describe('the footer status bar (#3079)', () => {
  const G = loadV6Shell();
  const bar = { scope: 'global', metrics: { activeSessions: { value: 4, confidence: 'observed' }, health: { value: 'ok', confidence: 'estimated' } } };

  it('carries Active sessions, Health and Version, announced, beside the hidden watermark word', () => {
    const html = G.tcV6WatermarkFooterMarkup(true, bar);
    assert.match(html, /^<footer class="v6-shell-watermark has-status"><div id="v6ShellStatusBar" class="v6-shell-status-bar" role="status" aria-label="Server status">/);
    assert.deepEqual([...html.matchAll(/title="([A-Za-z ]+):/g)].map((x) => x[1]), ['Active sessions', 'Health', 'Version']);
    assert.match(html, /<span class="v6-shell-watermark-mark" aria-hidden="true">TangleClaw<\/span><\/footer>$/);
    assert.doesNotMatch(html, /<footer[^>]*aria-hidden/);
  });

  it('with the watermark off it is the status bar alone; with no readings it is the old watermark or nothing', () => {
    assert.doesNotMatch(G.tcV6WatermarkFooterMarkup(false, bar), /v6-shell-watermark-mark|>TangleClaw</);
    assert.match(G.tcV6WatermarkFooterMarkup(false, bar), /id="v6ShellStatusBar"/);
    assert.equal(G.tcV6WatermarkFooterMarkup(true, null), '<footer class="v6-shell-watermark" aria-hidden="true">TangleClaw</footer>');
    assert.equal(G.tcV6WatermarkFooterMarkup(false, null), '');
  });

  it('the header bar no longer carries them, in a chat or outside one', () => {
    const header = G.tcV6TelemetryHeaderMarkup(bar);
    assert.doesNotMatch(header, /Active sessions|Health|Version/);
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/projects/x'), storage: null });
    shell.setTelemetry(bar);
    const html = root.innerHTML;
    assert.equal((html.match(/title="Active sessions:/g) || []).length, 1);
    assert.ok(html.indexOf('title="Active sessions:') > html.indexOf('<footer class="v6-shell-watermark has-status">'));
  });
});

describe('a slim top bar in the v6 shell (#3079)', () => {
  const G = loadV6Shell();
  /**
   * A small tree with real sibling order — what the tuck needs that the
   * shared mini-DOM does not model (insertBefore and nextSibling).
   */
  function makeHeader() {
    const byId = {};
    const node = (tag, id, className) => {
      const classes = new Set(String(className || '').split(/\s+/).filter(Boolean));
      const el = {
        tagName: tag.toUpperCase(), id: id || '', childNodes: [], parentNode: null, attrs: {}, listeners: {}, open: false, textContent: '', title: '',
        get className() { return [...classes].join(' '); }, set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
        classList: { contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
        get nextSibling() { const p = el.parentNode; return p ? p.childNodes[p.childNodes.indexOf(el) + 1] || null : null; },
        setAttribute(k, v) { el.attrs[k] = String(v); },
        addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
        appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = el; el.childNodes.push(c); return c; },
        insertBefore(c, ref) { if (c.parentNode) c.remove(); c.parentNode = el; el.childNodes.splice(el.childNodes.indexOf(ref), 0, c); return c; },
        remove() { const p = el.parentNode; if (p) p.childNodes.splice(p.childNodes.indexOf(el), 1); el.parentNode = null; if (el.id && byId[el.id] === el && !isAttached(el)) { /* kept findable, as getElementById is only asked of attached ids below */ } },
        querySelector(sel) { for (const c of el.childNodes) { if (sel === '.dash-actions' && c.classList.contains('dash-actions')) return c; const d = c.querySelector(sel); if (d) return d; } return null; }
      };
      if (id) byId[id] = el;
      return el;
    };
    const body = node('body');
    const isAttached = (el) => { let p = el; while (p) { if (p === body) return true; p = p.parentNode; } return false; };
    const left = body.appendChild(node('div', '', 'dash-auth'));
    ['signOutBtn', 'ttydNotice'].forEach((id) => left.appendChild(node('button', id)));
    const actions = body.appendChild(node('div', '', 'dash-actions'));
    ['v6ViewToggleBtn', 'masterToggle', 'advisorToggle', 'portsToggle', 'usageToggle', 'groupsToggle', 'openclawToggle',
      'auditToggle', 'fleetRecoveryToggle', 'rulesToggle', 'gearBtn'].forEach((id) => actions.appendChild(node('button', id)));
    const doc = {
      body,
      createElement: (tag) => node(tag),
      getElementById: (id) => (byId[id] && isAttached(byId[id]) ? byId[id] : null),
      querySelector: (sel) => body.querySelector(sel),
      _register: (el) => { if (el.id) byId[el.id] = el; }
    };
    const ids = (el) => el.childNodes.map((c) => c.id);
    return { doc, body, left, actions, ids };
  }

  it('tucks the admin controls into a More menu, keeping Classic View, Master and Advisor in the bar', () => {
    const h = makeHeader();
    G.tcV6TuckAdminControls(h.doc, true);
    assert.ok(h.body.classList.contains('v6-shell-active'));
    assert.deepEqual(h.ids(h.actions), ['v6ViewToggleBtn', 'masterToggle', 'advisorToggle', 'gearBtn', 'v6AdminMenu']);
    const panel = h.doc.getElementById('v6AdminMenuPanel');
    assert.deepEqual(h.ids(panel), ['portsToggle', 'usageToggle', 'groupsToggle', 'openclawToggle', 'auditToggle', 'fleetRecoveryToggle', 'rulesToggle', 'signOutBtn']);
    const summary = h.doc.getElementById('v6AdminMenu').childNodes[0];
    assert.equal(summary.tagName, 'SUMMARY');
    assert.equal(summary.attrs['aria-label'], 'More dashboard controls');
    assert.deepEqual(h.ids(h.left), ['ttydNotice']);
  });

  it('is safe to repeat on every render, and choosing a control closes the menu', () => {
    const h = makeHeader();
    G.tcV6TuckAdminControls(h.doc, true);
    G.tcV6TuckAdminControls(h.doc, true);
    assert.equal(h.ids(h.actions).filter((id) => id === 'v6AdminMenu').length, 1);
    assert.equal(h.ids(h.doc.getElementById('v6AdminMenuPanel')).length, 8);
    const menu = h.doc.getElementById('v6AdminMenu');
    menu.open = true;
    h.doc.getElementById('v6AdminMenuPanel').listeners.click.forEach((fn) => fn());
    assert.equal(menu.open, false);
  });

  it('leaving the shell puts every control back exactly where it was and removes the menu, after any number of renders', () => {
    const h = makeHeader();
    const before = { actions: h.ids(h.actions), left: h.ids(h.left) };
    G.tcV6TuckAdminControls(h.doc, true);
    G.tcV6TuckAdminControls(h.doc, true);
    G.tcV6TuckAdminControls(h.doc, false);
    assert.ok(!h.body.classList.contains('v6-shell-active'));
    assert.deepEqual(h.ids(h.actions), before.actions);
    assert.deepEqual(h.ids(h.left), before.left);
    assert.equal(h.doc.getElementById('v6AdminMenu'), null);
  });

  it('ui.js runs it from the shell\'s render hook with whether the shell shows', () => {
    const UI = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    assert.match(UI, /if \(typeof window\.tcV6TuckAdminControls === 'function'\) window\.tcV6TuckAdminControls\(document, active\);/);
  });
});

describe('V629 styles (#3076, #3079)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  it('tints each turn in its accent colour, in both themes, under a 1.5px dashed divider in that colour', () => {
    assert.match(CSS, /\.v6-conversation-event\.is-user \{\s*background: rgba\(56, 139, 253, 0\.07\);\s*\}/);
    assert.match(CSS, /\.v6-conversation-event\.is-assistant \{\s*background: rgba\(46, 160, 67, 0\.06\);\s*\}/);
    assert.match(CSS, /\[data-theme="light"\] \.v6-conversation-event\.is-user \{\s*background: rgba\(9, 105, 218, 0\.07\);\s*\}/);
    assert.match(CSS, /\[data-theme="light"\] \.v6-conversation-event\.is-assistant \{\s*background: rgba\(26, 127, 55, 0\.07\);\s*\}/);
    assert.match(CSS, /\.v6-conversation-event > \.v6-conversation-content \{[^}]*border-top: 1\.5px dashed/);
    assert.match(CSS, /\.v6-conversation-event\.is-user > \.v6-conversation-content \{\s*border-top-color: #58a6ff;\s*\}/);
    assert.match(CSS, /\.v6-conversation-event\.is-assistant > \.v6-conversation-content \{\s*border-top-color: #56d364;\s*\}/);
  });

  it('keeps the hidden delegate picker out of sight, and gives each dismiss button a 44px target', () => {
    assert.match(CSS, /\.v6-chat-delegate-label\[hidden\] \{\s*display: none;\s*\}/);
    assert.match(CSS, /\.v6-chat-question-dismiss \{[^}]*min-width: 44px;\s*min-height: 44px;/);
  });

  it('blinks the Medusa heads only for traffic, and not at all under reduced motion', () => {
    assert.match(CSS, /\.v6-chat-medusa\.is-flow-in \.v6-medusa-head--in,\s*\.v6-chat-medusa\.is-flow-out \.v6-medusa-head--out \{[^}]*animation: v6-medusa-blink/);
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\.v6-chat-medusa \.v6-medusa-head \{\s*animation: none;/);
  });

  it('lays the footer out as a status bar and floats the More menu over the page', () => {
    assert.match(CSS, /\.v6-shell-watermark\.has-status \{[^}]*display: flex;[^}]*opacity: 1;/);
    assert.match(CSS, /\.v6-admin-menu-panel \{[^}]*position: absolute;[^}]*z-index: 30;/);
  });
});

describe('a message longer than the command route takes (#3079 item 5)', () => {
  /**
   * A live chat that records what it uploads and sends. `upload` answers the
   * secure-clipboard POST (null = refused).
   */
  function mountLong(opts) {
    const o = opts || {};
    const G = loadV6Shell();
    G.TextEncoder = TextEncoder;
    G.btoa = btoa;
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const uploads = [];
    const listings = [];
    const sends = [];
    const events = [];
    const api = async (url, init) => {
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }] };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1592 };
      if (/conversation\/events/.test(url)) return { events: events.map((e, i) => ({ seq: i + 1, role: e.role, content: e.content })) };
      if (url === '/api/sessions/TC-Lane-PM/peek?lines=80' && o.peek) return { lines: o.peek() };
      if (url === '/api/sessions/TC-Lane-PM/secure-clipboard' && init && init.method === 'GET') {
        listings.push(init.headers);
        api.lastError = o.listing === null ? 'listing refused' : null;
        return o.listing === undefined ? { files: [] } : o.listing;
      }
      if (url === '/api/sessions/TC-Lane-PM/secure-clipboard' && init && init.method === 'POST') {
        uploads.push({ headers: init.headers, body: JSON.parse(init.body) });
        api.lastError = o.upload === null ? 'Secure clipboard is locked' : null;
        return o.upload === null ? null : { relPath: `secrets/${JSON.parse(init.body).filename}` };
      }
      return null;
    };
    api.lastError = null;
    api.lastErrorCode = null;
    const apiMutate = async (url, method, body) => {
      if (/\/command$/.test(url)) sends.push(plain(body));
      if (/conversation\/events$/.test(url)) events.push(plain(body));
      return { ok: true };
    };
    let shell = null;
    const pending = [];
    const timers = [];
    const deps = { getShell: () => shell, api, apiMutate, storage: null,
      setInterval: (fn) => { timers.push(fn); return timers.length - 1; }, clearInterval: () => {},
      now: () => 1700000000000, operatorHeaders: async () => ({ 'Content-Type': 'application/json', 'X-TC-Open-Token': 'tok' }) };
    if (o.textToBase64) deps.textToBase64 = o.textToBase64;
    const live = G.tcV6CreateLiveController(deps);
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null,
      setInterval: () => 0, clearInterval: () => {},
      onRender: (r) => pending.push(live.handleRoute(r)), onSendChat: (t) => pending.push(live.sendChat(t)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    const send = async (text) => {
      await settle();
      const input = doc.getElementById('v6ChatInput');
      input.value = text;
      input.dispatch('input');
      doc.getElementById('v6ChatForm').dispatch('submit');
      await settle();
    };
    return { G, doc, root, uploads, listings, sends, events, send, shell, timers };
  }

  it('a message within the limit is sent as it is, with nothing saved', async () => {
    const m = mountLong();
    const text = 'x'.repeat(4096);
    await m.send(text);
    assert.equal(m.uploads.length, 0);
    assert.deepEqual(m.sends, [{ command: text, enter: true }]);
  });

  it('a longer one is saved whole as a file, the session is sent its start and where the rest is, and the chat records what fits', async () => {
    const m = mountLong();
    const text = `Plan ✓ ${'é'.repeat(3000)} 🙂 ${'line\n'.repeat(400)}end`;
    assert.ok(text.length > 4096);
    await m.send(text);
    assert.equal(m.uploads.length, 1);
    const up = m.uploads[0];
    assert.deepEqual({ mode: up.body.mode, filename: up.body.filename, encoding: up.body.encoding },
      { mode: 'file', filename: 'prompt-1700000000000.md', encoding: 'base64' });
    assert.equal(Buffer.from(up.body.text, 'base64').toString('utf8'), text, 'the file holds the whole message, as UTF-8');
    assert.equal(up.headers['X-TC-Open-Token'], 'tok', 'with the page\'s operator proof');
    assert.equal(m.sends.length, 1);
    const cmd = m.sends[0].command;
    assert.ok(cmd.length <= 4096, `command is ${cmd.length} chars`);
    assert.ok(cmd.startsWith(text.slice(0, 3000)));
    assert.ok(cmd.endsWith(`\n\n[Full prompt (${text.length} chars) saved to: .tangleclaw/secrets/prompt-1700000000000.md — read that file in full]`), cmd.slice(-160));
    assert.equal(m.events.length, 1);
    // Ruling A739/A740: over 8,000 bytes of JSON-encoded event body, the record keeps its start and the path.
    const recorded = m.events[0].content;
    assert.ok(Buffer.byteLength(JSON.stringify(m.events[0])) <= 8000, `${Buffer.byteLength(JSON.stringify(m.events[0]))} bytes`);
    assert.ok(text.startsWith(recorded.split('\n\n[Full prompt')[0]));
    assert.ok(recorded.endsWith(`\n\n[Full prompt (${text.length} chars) saved to: .tangleclaw/secrets/prompt-1700000000000.md — read that file in full]`));
  });

  it('one that is long but light records whole', async () => {
    const m = mountLong();
    const text = 'w'.repeat(5000);
    await m.send(text);
    assert.equal(m.uploads.length, 1);
    assert.equal(m.events[0].content, text, 'the conversation shows the whole message');
  });

  it('a quote-heavy message over 10 KB records within the route cap, and so does a short one full of control characters', async () => {
    for (const text of ['"'.repeat(11000), '\u0001'.repeat(2000)]) {
      const m = mountLong();
      await m.send(text);
      assert.equal(m.uploads.length, 1, 'saved, so the record can point at it');
      const body = JSON.stringify(m.events[0]);
      assert.ok(Buffer.byteLength(body) <= 8000, `${Buffer.byteLength(body)} bytes`);
      assert.ok(Buffer.byteLength(body) < 10 * 1024);
      assert.match(m.events[0].content, /\[Full prompt \(\d+ chars\) saved to: \.tangleclaw\/secrets\/prompt-1700000000000\.md — read that file in full\]$/);
      assert.equal(m.sends[0].command.length <= 4096, true);
    }
  });

  it('checks the project\'s saved files first: an unreadable listing saves and sends nothing, and a taken name gets a new one', async () => {
    const refused = mountLong({ listing: null });
    await refused.send('q'.repeat(5000));
    assert.equal(refused.uploads.length, 0);
    assert.equal(refused.sends.length, 0);
    assert.match(refused.root.innerHTML, /Not sent: the long message was not saved: the project&#39;s saved files could not be checked \(listing refused\)/);
    const taken = mountLong({ listing: { files: [{ filename: 'prompt-1700000000000.md' }] } });
    await taken.send('q'.repeat(5000));
    assert.equal(taken.listings[0]['X-TC-Open-Token'], 'tok');
    assert.equal(taken.uploads[0].body.filename, 'prompt-1700000000000-2.md');
    assert.match(taken.sends[0].command, /saved to: \.tangleclaw\/secrets\/prompt-1700000000000-2\.md/);
  });

  it('the recorded text is cut between characters and weighs what the route will see', () => {
    const G = loadV6Shell();
    const path = '.tangleclaw/secrets/p.md';
    const out = G.tcV6RecordedText('🙂'.repeat(5000), path, 'v6-chat-ui');
    assert.doesNotMatch(out.split('\n\n[Full prompt')[0], /[\uD800-\uDBFF]$/);
    assert.ok(G.tcV6EventBodyBytes(out, 'v6-chat-ui') <= 8000);
    // As much as fits: one more character would not.
    const head = Array.from(out.split('\n\n[Full prompt')[0]);
    const note = out.slice(out.indexOf('\n\n[Full prompt'));
    assert.ok(G.tcV6EventBodyBytes(head.concat('🙂').join('') + note, 'v6-chat-ui') > 8000);
    const body = JSON.stringify({ launchId: 'v6-chat-ui', seq: Number.MAX_SAFE_INTEGER, tier: 'A', adapter: 'v6-chat-ui', role: 'user', content: '"é🙂\u0001' });
    assert.equal(G.tcV6EventBodyBytes('"é🙂\u0001', 'v6-chat-ui'), new TextEncoder().encode(body).length);
    assert.equal(G.tcV6RecordedText('short', path, 'v6-chat-ui'), 'short');
  });

  it('when the file cannot be saved, nothing is sent and the text is kept', async () => {
    const m = mountLong({ upload: null });
    const text = 'y'.repeat(5000);
    await m.send(text);
    assert.equal(m.sends.length, 0);
    assert.equal(m.events.length, 0);
    assert.match(m.root.innerHTML, /Not sent: the long message could not be saved for the session: Secure clipboard is locked/);
    assert.match(m.root.innerHTML, new RegExp(`<textarea id="v6ChatInput"[^>]*>${'y'.repeat(5000)}</textarea>`));
  });

  it('over the 5 MB limit for a saved file it is refused before anything is uploaded', async () => {
    // Restated by PRR-B R1: the limit counts the message's UTF-8 bytes, so exactly 5 MiB is allowed.
    const m = mountLong();
    await m.send('z'.repeat(5 * 1024 * 1024 + 1));
    assert.equal(m.uploads.length, 0);
    assert.equal(m.sends.length, 0);
    assert.match(m.root.innerHTML, /Not sent: the message is over the 5 MB limit for a saved prompt\./);
  });

  it('a message of exactly 5 MiB of UTF-8 is saved, base64 padding notwithstanding (PRR-B R1)', async () => {
    const m = mountLong();
    const text = 'é'.repeat(5 * 1024 * 1024 / 2);
    assert.equal(Buffer.byteLength(text), 5242880);
    await m.send(text);
    assert.equal(m.uploads.length, 1);
    assert.equal(Buffer.from(m.uploads[0].body.text, 'base64').length, 5242880);
  });

  it('the stand-in command fills the limit exactly and never splits a surrogate pair', () => {
    const G = loadV6Shell();
    const path = '.tangleclaw/secrets/prompt-1.md';
    const flat = G.tcV6LongPromptCommand('a'.repeat(9000), path);
    assert.equal(flat.length, 4096);
    const note = `\n\n[Full prompt (9000 chars) saved to: ${path} — read that file in full]`;
    const cut = 4096 - note.length;
    const pairs = 'a'.repeat(cut - 1) + '🙂'.repeat(2000);
    const out = G.tcV6LongPromptCommand(pairs, path);
    assert.ok(out.length <= 4096);
    assert.doesNotMatch(out.split('\n\n[Full prompt')[0], /[\uD800-\uDBFF]$/);
  });
});

describe('turns in the order they happened, and a composer that empties on Enter (#3079 item 6)', () => {
  const G = loadV6Shell();
  const view = (events, turns, chat) => ({ project: { id: 12, name: 'P' }, sessionId: 2, events,
    chat: Object.assign({ status: 'active', members: [], live: { turns, questions: [] } }, chat || {}) });
  const order = (html) => [...html.matchAll(/<span class="v6-conversation-content">([^<]*)<\/span>/g)].map((m) => m[1]);
  const ev = (seq, content) => ({ seq, role: 'user', content });

  it('interleaves each user message with the replies around it, each drawn once, a sent one not yet on screen last', () => {
    const html = G.tcV6ConversationViewMarkup(view([ev(1, 'User1'), ev(2, 'User2'), ev(3, 'User3')], [
      { role: 'user', text: 'User1', recorded: true }, { role: 'assistant', text: 'Asst1' },
      { role: 'user', text: 'User2', recorded: true }, { role: 'assistant', text: 'Asst2' }]));
    assert.deepEqual(order(html), ['User1', 'Asst1', 'User2', 'Asst2', 'User3']);
  });

  it('messages from before the pane come first, and a message sent twice pairs with its newest copy', () => {
    const html = G.tcV6ConversationViewMarkup(view([ev(1, 'Old'), ev(2, 'again'), ev(3, 'again')], [
      { role: 'user', text: 'again', recorded: true }, { role: 'assistant', text: 'Reply' }]));
    assert.deepEqual(order(html), ['Old', 'again', 'again', 'Reply']);
  });

  it('pairs keep the pane\'s order when a message repeats', () => {
    const html = G.tcV6ConversationViewMarkup(view([ev(1, 'a'), ev(2, 'b'), ev(3, 'a')], [
      { role: 'user', text: 'a', recorded: true }, { role: 'assistant', text: 'A1' },
      { role: 'user', text: 'b', recorded: true }, { role: 'assistant', text: 'A2' }]));
    assert.deepEqual(order(html), ['a', 'A1', 'b', 'A2', 'a']);
  });

  it('with nothing of it on screen, only the message this chat just sent goes last', () => {
    const turns = [{ role: 'assistant', text: 'Asst' }];
    assert.deepEqual(order(G.tcV6ConversationViewMarkup(view([ev(1, 'Earlier'), ev(2, 'Mine')], turns))), ['Earlier', 'Mine', 'Asst']);
    assert.deepEqual(order(G.tcV6ConversationViewMarkup(view([ev(1, 'Earlier'), ev(2, 'Mine')], turns, { lastSent: { id: 1, text: 'Mine' } }))),
      ['Earlier', 'Asst', 'Mine']);
  });

  it('a long message recorded in part is still drawn once, where the pane shows it', () => {
    const full = `${'Long message line. '.repeat(400)}end`;
    const recorded = `${full.slice(0, 3000)}\n\n[Full prompt (${full.length} chars) saved to: .tangleclaw/secrets/p.md — read that file in full]`;
    const html = G.tcV6ConversationViewMarkup(view([ev(1, recorded)], [
      { role: 'user', text: full, recorded: true }, { role: 'assistant', text: 'Read it.' }]));
    assert.equal(order(html).length, 2);
    assert.equal(order(html)[1], 'Read it.');
  });

  it('the pane\'s saved-path line under a long prompt is not taken for a reply', () => {
    const full = `please read the whole plan before you start ${'x'.repeat(5000)}`;
    const out = plain(G.tcV6ExtractLiveTurns([`> ${full.slice(0, 60)}`,
      `[Full prompt (${full.length} chars) saved to: .tangleclaw/secrets/prompt-1.md — read that file in full]`, '⏺ Reading it now.'], 'claude', [full]));
    assert.deepEqual(out.turns.map((t) => t.role), ['user', 'assistant']);
    assert.equal(out.turns[1].text, 'Reading it now.');
  });

  it('a pending message is escaped, and is not drawn once its recorded copy is', () => {
    const pending = { id: 7, text: '<b>hi</b>' };
    const html = G.tcV6ConversationViewMarkup(view([], [], { pending }));
    assert.match(html, /<ol id="v6ChatPending"[^>]*><li class="v6-conversation-event is-user is-pending">[\s\S]*&lt;b&gt;hi&lt;\/b&gt;[\s\S]*Sending…/);
    assert.doesNotMatch(html, /<b>hi/);
    assert.doesNotMatch(G.tcV6ConversationViewMarkup(view([ev(1, '<b>hi</b>')], [], { pending, lastSent: { id: 7, text: '<b>hi</b>' } })), /is-pending/);
  });
});

describe('sending, through the controller (#3079 item 6)', () => {
  /** A live chat whose command route answers `sendOk`, recording what it is sent. */
  function mountSend(sendOk) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const events = [];
    const api = async (url) => {
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }] };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1592 };
      if (/conversation\/events/.test(url)) return { events: events.map((e, i) => ({ seq: i + 1, role: e.role, content: e.content })) };
      if (url === '/api/sessions/TC-Lane-PM/peek?lines=80') return { lines: ['⏺ Earlier reply.'] };
      return null;
    };
    api.lastError = null;
    const apiMutate = async (url, method, body) => {
      if (/\/command$/.test(url)) { api.lastError = sendOk ? null : 'the lane is held'; return sendOk ? { ok: true } : null; }
      if (/conversation\/events$/.test(url)) { events.push(plain(body)); return { ok: true }; }
      return { ok: true };
    };
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate, storage: null, setInterval: () => 0, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null,
      setInterval: () => 0, clearInterval: () => {},
      onRender: (r) => pending.push(live.handleRoute(r)), onSendChat: (t) => pending.push(live.sendChat(t)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    const type = (text) => {
      const input = doc.getElementById('v6ChatInput');
      input.value = text;
      input.dispatch('input');
      doc.getElementById('v6ChatForm').dispatch('submit');
    };
    return { doc, root, settle, type, events };
  }
  const textarea = (html) => /<textarea id="v6ChatInput"[^>]*>([^<]*)<\/textarea>/.exec(html)[1];

  it('Enter empties the composer at once and shows the message, escaped, at the bottom', async () => {
    const m = mountSend(true);
    await m.settle();
    m.type('<i>next</i> step');
    // Before anything is awaited: the page as drawn the moment Enter is handled.
    assert.equal(textarea(m.root.innerHTML), '');
    const html = m.root.innerHTML;
    assert.match(html, /<ol id="v6ChatPending"[^>]*><li class="v6-conversation-event is-user is-pending">[\s\S]*&lt;i&gt;next&lt;\/i&gt; step/);
    assert.ok(html.indexOf('Earlier reply.') < html.indexOf('is-pending'), 'below the replies before it');
    await m.settle();
  });

  it('once sent, the pending message gives way to its recorded copy, drawn once, after the replies', async () => {
    const m = mountSend(true);
    await m.settle();
    m.type('next step');
    await m.settle();
    const html = m.root.innerHTML;
    assert.doesNotMatch(html, /is-pending/);
    assert.equal((html.match(/>next step</g) || []).length, 1);
    assert.ok(html.indexOf('Earlier reply.') < html.indexOf('>next step<'));
    assert.match(html, /<ol id="v6ChatRecordedTail"[^>]*><li class="v6-conversation-event is-user">/);
  });

  it('a refused send puts the text back and removes the pending message', async () => {
    const m = mountSend(false);
    await m.settle();
    m.type('keep me');
    await m.settle();
    assert.equal(textarea(m.root.innerHTML), 'keep me');
    assert.doesNotMatch(m.root.innerHTML, /is-pending/);
    assert.match(m.root.innerHTML, /Not sent: the lane is held/);
    assert.equal(m.events.length, 0);
  });
});

describe('a long message recorded only in part is not read back as a reply (third review, R-4)', () => {
  // CJK text that never repeats, so no later line is already part of the recorded start.
  const zh = Array.from({ length: 6000 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919) % 20000))).join('');

  it('after a reload, with only the cut record known, its indented continuation is still the prompt', () => {
    const G = loadV6Shell();
    const recorded = G.tcV6RecordedText(zh, '.tangleclaw/secrets/p.md', 'v6-chat-ui');
    assert.ok(recorded.length < 3990, 'the record is shorter than the command');
    const lines = [`> ${zh.slice(0, 40)}`, `  ${zh.slice(3000, 3060)}`, `  ${zh.slice(3900, 3960)}`,
      `[Full prompt (${zh.length} chars) saved to: .tangleclaw/secrets/p.md — read that file in full]`, '⏺ 收到。'];
    const out = plain(G.tcV6ExtractLiveTurns(lines, 'claude', [recorded]));
    assert.deepEqual(out.turns.map((t) => t.role), ['user', 'assistant']);
    assert.equal(out.turns[1].text, '收到。');
  });

  it('through the controller, every later poll still knows the whole message it sent', async () => {
    let pane = ['⏺ Ready.'];
    const H = loadV6Shell();
    H.TextEncoder = TextEncoder;
    H.btoa = btoa;
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const events = [];
    const api = async (url, init) => {
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }] };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1592 };
      if (/conversation\/events/.test(url)) return { events: events.map((e, i) => ({ seq: i + 1, role: e.role, content: e.content })) };
      if (url === '/api/sessions/TC-Lane-PM/peek?lines=80') return { lines: pane };
      if (/secure-clipboard$/.test(url) && init && init.method === 'GET') return { files: [] };
      if (/secure-clipboard$/.test(url)) return { relPath: `secrets/${JSON.parse(init.body).filename}` };
      return null;
    };
    api.lastError = null;
    const apiMutate = async (url, method, body) => {
      if (/conversation\/events$/.test(url)) events.push(plain(body));
      return { ok: true };
    };
    const timers = [];
    let shell = null;
    const pending = [];
    const live = H.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate, storage: null, now: () => 1,
      operatorHeaders: async () => ({}), setInterval: (fn) => { timers.push(fn); return timers.length - 1; }, clearInterval: () => {} });
    shell = H.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null,
      setInterval: () => 0, clearInterval: () => {},
      onRender: (r) => pending.push(live.handleRoute(r)), onSendChat: (t) => pending.push(live.sendChat(t)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    await settle();
    const input = doc.getElementById('v6ChatInput');
    input.value = zh;
    input.dispatch('input');
    doc.getElementById('v6ChatForm').dispatch('submit');
    await settle();
    // The pane echoes the command, wrapped flush left, past what the record holds.
    pane = [`> ${zh.slice(0, 40)}`, zh.slice(3000, 3060), zh.slice(3900, 3960), '⏺ 收到。'];
    const tick = timers[timers.length - 1];
    await tick();
    await tick();
    const liveHtml = doc.getElementById('v6ChatLive').innerHTML;
    assert.equal((liveHtml.match(/is-assistant/g) || []).length, 1, liveHtml.slice(0, 400));
    const replies = [...liveHtml.matchAll(/<li class="v6-conversation-event is-assistant is-live">[\s\S]*?<\/li>/g)].map((x) => x[0]).join('');
    assert.ok(!replies.includes(zh.slice(3000, 3060)) && !replies.includes(zh.slice(3900, 3960)), 'no line of the message reads as a reply');
    assert.match(liveHtml, /is-assistant is-live">[\s\S]*收到。/);
  });
});

describe('a short prompt is never taken for a longer one that contains its words (fourth review, O-1)', () => {
  it('"ok" stays "ok" beside a recorded "look at the logs", and a line of a longer message still finds it', () => {
    const G = loadV6Shell();
    const out = plain(G.tcV6ExtractLiveTurns(['> look at the logs', '⏺ Looking.', '> ok', '⏺ Done.'], 'claude', ['look at the logs', 'ok']));
    assert.deepEqual(out.turns.filter((t) => t.role === 'user').map((t) => t.text), ['look at the logs', 'ok']);
    const multi = plain(G.tcV6ExtractLiveTurns(['> check this', 'Attached: a.png', '⏺ Seen.'], 'claude', ['check this\n\nAttached: a.png', 'look']));
    assert.equal(multi.turns[0].text, 'check this\n\nAttached: a.png');
  });
});

describe('a wrapped wake never swallows the session\'s reply (Lane-B O-Gate and PRR-B R2)', () => {
  const G = loadV6Shell();
  const run = (lines, engine) => plain(G.tcV6ExtractLiveTurns(lines, engine || 'claude', []));
  const wake = '[TangleClaw Switchboard] You have 1 unread Medusa message(s): tc message read. Reply where an answer is needed, BEFORE marking it handled: tc message send --in-reply-to <message-id> <sender-workspace-id> "<reply>"; then tc message ack <message-id>. The initiator closes the exchange, so no answer leaves them blocked; tc message owed lists what you owe. Never use /clear as an acknowledgement. Without tc: API at http://localhost:3102/api/sessions/P/medusa: GET /messages; POST /send (inReplyTo) and /read need launch headers. (wake ref 2c463327fbfc)';

  it('Antigravity\'s indented reply after a typed wake is a reply, questions and all', () => {
    const out = run(['❯ [TangleClaw Switchboard] You have 1 unread', '  I read the message from PM.', '  Shall I proceed?'], 'antigravity');
    assert.equal(out.switchboard.length, 1);
    assert.deepEqual(out.turns, [{ role: 'assistant', text: 'I read the message from PM.\nShall I proceed?', trigger: 'switchboard' }]);
    assert.deepEqual(out.questions, ['Shall I proceed?']);
  });

  it('a whole wake wrapped across lines is joined, and the reply after its wake ref is not', () => {
    const words = wake.split(' ');
    const lines = [`> ${words.slice(0, 12).join(' ')}`];
    for (let i = 12; i < words.length; i += 10) lines.push(`  ${words.slice(i, i + 10).join(' ')}`);
    lines.push('  Reading them now.');
    const out = run(lines, 'antigravity');
    assert.deepEqual(out.switchboard, [{ dir: 'in', text: wake }]);
    assert.deepEqual(out.turns, [{ role: 'assistant', text: 'Reading them now.', trigger: 'switchboard' }]);
  });

  it('a wake with a project\'s own reply guidance, wrapped mid-word, is joined whole; the reply after it is not (third review, blocking)', () => {
    // lib/medusa-wake.js#_nudgeText puts replyGuidance where the default reply step goes.
    const custom = '[TangleClaw Switchboard] You have 12 unread Medusa message(s): tc message read. Reply where an answer is needed, BEFORE marking it handled: answer in the PR thread first, then ack. The initiator closes the exchange, so no answer leaves them blocked; tc message owed lists what you owe. Never use /clear as an acknowledgement. Without tc: API at https://host.example:8443/api/sessions/P/medusa: GET /messages; POST /send (inReplyTo) and /read need launch headers. (wake ref 0123456789ab)';
    // Cut every 37 characters, through words, as a narrow pane would.
    const chunks = [];
    for (let i = 0; i < custom.length; i += 37) chunks.push(custom.slice(i, i + 37));
    const lines = [`> ${chunks[0]}`].concat(chunks.slice(1).map((c) => `  ${c.trim()}`), ['  Fixed. Shall I push?']);
    const out = run(lines, 'antigravity');
    assert.equal(out.switchboard.length, 1);
    assert.equal(out.switchboard[0].text.replace(/\s+/g, ''), custom.replace(/\s+/g, ''));
    assert.deepEqual(out.turns, [{ role: 'assistant', text: 'Fixed. Shall I push?', trigger: 'switchboard' }]);
    assert.deepEqual(out.questions, ['Fixed. Shall I push?']);
  });

  it('reply guidance as long as a project may set (2000 characters) still joins, and so does an address keeping \'()!*\' (fifth review)', () => {
    const guidance = 'Answer in the PR thread first, then ack it here. '.repeat(40).slice(0, 2000);
    const wakeText = `[TangleClaw Switchboard] You have 3 unread Medusa message(s): tc message read. Reply where an answer is needed, BEFORE marking it handled: ${guidance}. The initiator closes the exchange, so no answer leaves them blocked; tc message owed lists what you owe. Never use /clear as an acknowledgement. Without tc: API at http://localhost:3102/api/sessions/it's(new)!*/medusa: GET /messages; POST /send (inReplyTo) and /read need launch headers. (wake ref 0123456789ab)`;
    const chunks = [];
    for (let i = 0; i < wakeText.length; i += 61) chunks.push(wakeText.slice(i, i + 61));
    const out = run([`> ${chunks[0]}`].concat(chunks.slice(1).map((c) => `  ${c.trim()}`), ['  Shall I merge?']), 'antigravity');
    assert.equal(out.switchboard.length, 1);
    assert.equal(out.switchboard[0].text.replace(/\s+/g, ''), wakeText.replace(/\s+/g, ''));
    assert.deepEqual(out.turns, [{ role: 'assistant', text: 'Shall I merge?', trigger: 'switchboard' }]);
  });

  it('a blank line ends a wake, even mid-sentence', () => {
    const out = run(['> [TangleClaw Switchboard] You have 1 unread Medusa message(s): tc message read.', '', '  Reply where an answer is needed, BEFORE'], 'antigravity');
    assert.equal(out.switchboard[0].text, '[TangleClaw Switchboard] You have 1 unread Medusa message(s): tc message read.');
    assert.deepEqual(out.turns.map((t) => t.role), ['assistant']);
  });

  it('the workload reminder wraps and joins too', () => {
    const out = run(['> [TangleClaw] Your workload report has expired, so coordinators', '  now read this lane as UNKNOWN. Report what you are doing with', '⏺ Reporting.']);
    assert.equal(out.switchboard[0].text, '[TangleClaw] Your workload report has expired, so coordinators now read this lane as UNKNOWN. Report what you are doing with');
    assert.equal(out.turns[0].text, 'Reporting.');
  });
});

describe('a dismissal belongs to the reply that asked it (PRR-B R2)', () => {
  const G = loadV6Shell();
  function mount() {
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/projects/x'), storage: null });
    shell.setDetail({ kind: 'conversation', view: { project: { id: 12, name: 'P' }, sessionId: 1, events: [],
      chat: { status: 'active', members: [], live: { turns: [{ role: 'user', text: 'ok' }, { role: 'assistant', text: 'One?' }], questions: ['One?'] } } } });
    return { shell, doc };
  }
  const shows = (m) => /One\?/.test(m.doc.getElementById('v6ChatQuestion').innerHTML);

  it('the same answer, then the same question again, with no empty poll between: it shows', () => {
    const m = mount();
    m.doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    assert.equal(shows(m), false);
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'user', text: 'ok' }, { role: 'assistant', text: 'One?' },
      { role: 'user', text: 'ok' }, { role: 'assistant', text: 'One?' }], questions: ['One?'] } });
    assert.equal(shows(m), true);
  });

  it('a different exchange of the same length asking the same words shows', () => {
    const m = mount();
    m.doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'user', text: 'yes' }, { role: 'assistant', text: 'One?' }], questions: ['One?'] } });
    assert.equal(shows(m), true);
  });

  it('the same reply growing, or its earlier turns scrolling off the top, keeps it dismissed', () => {
    const m = mount();
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'assistant', text: 'Earlier.' }, { role: 'user', text: 'ok' }, { role: 'assistant', text: 'One?' }], questions: ['One?'] } });
    m.doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'assistant', text: 'Earlier.' }, { role: 'user', text: 'ok' }, { role: 'assistant', text: 'One?\nAnd more.' }], questions: ['One?'] } });
    assert.equal(shows(m), false, 'grown');
    m.shell.setLive({ peek: null, live: { turns: [{ role: 'user', text: 'ok' }, { role: 'assistant', text: 'One?\nAnd more.' }], questions: ['One?'] } });
    assert.equal(shows(m), false, 'scrolled');
  });
});

// ── #3082 (Car V6210-W1-A): links, thumbnails, verbosity filter ──

describe('links in messages open in a new tab, and only http(s) is ever a link (#3082)', () => {
  const G = loadV6Shell();
  const f = (t, thumbs) => G.tcV6MessageMarkup(t, thumbs);

  it('a bare URL, MagicDNS port and all, is a new-tab link; trailing punctuation is not part of it', () => {
    const html = f('Plan: https://cursatory.tail123678.ts.net:8443/plans/111/p.md, read it.');
    assert.equal(html, 'Plan: <a class="v6-chat-link" href="https://cursatory.tail123678.ts.net:8443/plans/111/p.md" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">https://cursatory.tail123678.ts.net:8443/plans/111/p.md</a>, read it.');
    assert.match(f('(see https://x.example/a)'), /href="https:\/\/x\.example\/a"[^>]*>https:\/\/x\.example\/a<\/a>\)$/);
    assert.match(f('https://x.example/wiki/A_(b)'), /href="https:\/\/x\.example\/wiki\/A_\(b\)"/);
  });

  it('a Markdown link shows its label; a same-origin path may be a target', () => {
    assert.match(f('[the plan](https://a.example/p)'), /<a class="v6-chat-link" href="https:\/\/a\.example\/p"[^>]*>the plan<\/a>/);
    assert.match(f('[plans](/plans/111/x.md)'), /<a class="v6-chat-link" href="\/plans\/111\/x\.md"/);
  });

  it('javascript:, data:, vbscript:, file: and protocol-relative targets are never links', () => {
    for (const t of ['[x](javascript:alert(1))', 'javascript:alert(1)', 'data:text/html,<b>1</b>', '[y](vbscript:msgbox(1))', 'file:///etc/passwd', '[z](//evil.example/x)',
      '[w](/\\evil.example/x)', '[v](/a\\b)']) {
      assert.doesNotMatch(f(t), /<a /, t);
    }
  });

  it('escapes everything around and inside links', () => {
    const html = f('<b>hi</b> [<i>lbl</i>](https://a.example/?q=1&r=2) "https://b.example/x"');
    assert.doesNotMatch(html, /<b>|<i>/);
    assert.match(html, /href="https:\/\/a\.example\/\?q=1&amp;r=2"[^>]*>&lt;i&gt;lbl&lt;\/i&gt;<\/a>/);
    // A quote ends a bare URL, so it can never break out of the href.
    assert.match(f('https://a.example/x"onmouseover="y'), /href="https:\/\/a\.example\/x"[^>]*>https:\/\/a\.example\/x<\/a>&quot;onmouseover=&quot;y/);
    assert.match(html, /&quot;<a class="v6-chat-link" href="https:\/\/b\.example\/x"/);
  });

  it('an external image URL in an assistant turn is a link card and NO img, so nothing is fetched (A752-1)', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 2, events: [],
      chat: { status: 'active', members: [], live: { turns: [{ role: 'assistant', text: 'See https://attacker.example/p.png?d=SECRET now' }] } } });
    const live = html.slice(html.indexOf('id="v6ChatLive"'), html.indexOf('id="v6ChatRecordedTail"'));
    assert.match(live, /<a class="v6-chat-link-preview" href="https:\/\/attacker\.example\/p\.png\?d=SECRET" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/);
    assert.match(live, /<span class="v6-chat-link-preview-host">attacker\.example<\/span><span class="v6-chat-link-preview-path">\/p\.png\?d=SECRET<\/span>/);
    assert.doesNotMatch(html, /<img[^>]*attacker/);
    assert.doesNotMatch(live, /<img/);
  });

  it('an attached image with a blob URL is a thumbnail opening in a new tab; otherwise, or any non-blob value, a chip', () => {
    const thumb = f('look\nAttached: .tangleclaw/secrets/shot.png', { 'shot.png': 'blob:http://h/1' });
    assert.match(thumb, /^look\n<a class="v6-chat-link-preview v6-chat-thumb-link" href="blob:http:\/\/h\/1" target="_blank" rel="noopener noreferrer"[^>]*><img class="v6-chat-thumb" src="blob:http:\/\/h\/1" alt="shot\.png">/);
    assert.match(f('Attached: secrets/shot.png'), /^<span class="v6-chat-attachment"><span aria-hidden="true">📎<\/span> shot\.png<\/span>$/);
    assert.doesNotMatch(f('Attached: .tangleclaw/secrets/shot.png', { 'shot.png': 'javascript:alert(1)' }), /<img|href/);
    assert.doesNotMatch(f('Attached: .tangleclaw/secrets/notes.txt', { 'notes.txt': 'blob:http://h/2' }), /<img/);
  });
});

describe('attachment thumbnails through the controller (#3082, A752-2)', () => {
  /** A live chat whose messages attach shot.png, with fetch and object-URL seams. */
  function mountThumbs(opts) {
    const o = opts || {};
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const fetches = [];
    const created = [];
    const revoked = [];
    let n = 0;
    const rows = [{ id: 12, name: 'TC Lane PM', engine: { id: 'claude' } }, { id: 13, name: 'Other', engine: { id: 'claude' } }];
    const api = async (url) => {
      if (url === '/api/projects') return { projects: rows };
      if (/\/status$/.test(url)) return { active: true, sessionId: 1592 };
      if (/conversation\/events/.test(url)) return { events: [{ seq: 1, role: 'user', content: 'see this\n\nAttached: .tangleclaw/secrets/shot.png' }] };
      if (/peek/.test(url)) return { lines: ['⏺ Got it.'] };
      return null;
    };
    const timers = [];
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => ({ ok: true }), storage: null,
      operatorHeaders: async () => ({ 'X-TC-Open-Token': 'tok' }),
      // A refused Response still has blob(); only ok tells the two apart.
      fetch: async (url, init) => { fetches.push({ url, headers: init.headers }); return o.fail ? { ok: false, status: 403, blob: async () => ({ kind: 'json-error' }) } : { ok: true, blob: async () => ({ kind: 'blob' }) }; },
      createObjectURL: () => { const u = `blob:test/${++n}`; created.push(u); return u; },
      revokeObjectURL: (u) => revoked.push(u),
      setInterval: (fn) => { timers.push(fn); return timers.length - 1; }, clearInterval: () => {} });
    const win = makeFakeWindow('#/resources/12/conversation');
    shell = G.tcCreateV6Shell(doc, { root, window: win, storage: null, onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { for (let i = 0; i < 5; i++) { while (pending.length) await pending.shift(); await new Promise((r) => setImmediate(r)); } };
    return { shell, root, doc, win, timers, settle, fetches, created, revoked };
  }
  const thumbIn = (m) => (/<img class="v6-chat-thumb" src="([^"]+)"/.exec(m.root.innerHTML + (m.doc.getElementById('v6ChatRecorded') || {}).innerHTML) || [])[1];

  it('fetches the attached image once, with the operator proof, from the project\'s secure-clipboard file route', async () => {
    const m = mountThumbs();
    await m.settle();
    assert.equal(m.fetches.length, 1);
    assert.equal(m.fetches[0].url, '/api/sessions/TC%20Lane%20PM/secure-clipboard/shot.png');
    assert.equal(m.fetches[0].headers['X-TC-Open-Token'], 'tok');
    assert.equal(thumbIn(m), 'blob:test/1');
  });

  it('keeps the exact same blob URL across a live poll, fetching and creating nothing new (A752-2)', async () => {
    const m = mountThumbs();
    await m.settle();
    const before = thumbIn(m);
    await m.timers[m.timers.length - 1]();
    await m.settle();
    assert.equal(thumbIn(m), before);
    assert.equal(m.fetches.length, 1);
    assert.deepEqual(m.created, ['blob:test/1']);
    assert.deepEqual(m.revoked, [], 'a poll revokes nothing');
  });

  it('releases the blob URL when the chat moves to another project, and on teardown', async () => {
    const m = mountThumbs();
    await m.settle();
    m.win.location.hash = '#/resources/13/conversation';
    await m.settle();
    assert.deepEqual(m.revoked, ['blob:test/1']);
    const t = mountThumbs();
    await t.settle();
    t.shell.destroy();
    assert.deepEqual(t.revoked, ['blob:test/1']);
  });

  it('an image the operator attached in this browser seeds the cache from its own bytes, so nothing is fetched', async () => {
    const G = loadV6Shell();
    const created = [];
    const fetches = [];
    let events = [];
    let shell = null;
    const live = G.tcV6CreateLiveController({ getShell: () => shell,
      api: async (url, init) => {
        if (url === '/api/projects') return { projects: [{ id: 12, name: 'P', engine: { id: 'claude' } }] };
        if (/\/status$/.test(url)) return { active: true, sessionId: 1 };
        if (/secure-clipboard$/.test(url) && init && init.method === 'GET') return { files: [] };
        if (/secure-clipboard$/.test(url)) return { relPath: 'secrets/shot.png' };
        if (/conversation\/events/.test(url)) return { events };
        if (/peek/.test(url)) return { lines: [] };
        return null;
      },
      apiMutate: async () => ({ ok: true }), storage: null, operatorHeaders: async () => ({}), readFileAsBase64: async () => 'eA==',
      fetch: async (url) => { fetches.push(url); return { ok: false }; },
      createObjectURL: (b) => { created.push(b); return 'blob:local/1'; }, revokeObjectURL: () => {},
      setInterval: () => 0, clearInterval: () => {} });
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const pending = [];
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null, onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    while (pending.length) await pending.shift();
    const file = { name: 'shot.png', size: 3 };
    await live.attachFiles([file]);
    assert.deepEqual(created, [file], 'the local file itself became the blob URL');
    // The message that attaches it is then sent and recorded.
    events = [{ seq: 1, role: 'user', content: 'Attached: .tangleclaw/secrets/shot.png' }];
    await live.refresh();
    assert.deepEqual(fetches, [], 'no fetch for a file this browser already holds');
    assert.match(root.innerHTML + doc.getElementById('v6ChatRecorded').innerHTML, /<img class="v6-chat-thumb" src="blob:local\/1"/);
  });

  it('a file attached in this browser replaces a fetch that was refused', async () => {
    const G = loadV6Shell();
    let shell = null;
    const created = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell,
      api: async (url, init) => {
        if (url === '/api/projects') return { projects: [{ id: 12, name: 'P', engine: { id: 'claude' } }] };
        if (/\/status$/.test(url)) return { active: true, sessionId: 1 };
        if (/secure-clipboard$/.test(url) && init && init.method === 'GET') return { files: [] };
        if (/secure-clipboard$/.test(url)) return { relPath: 'secrets/shot.png' };
        if (/conversation\/events/.test(url)) return { events: [{ seq: 1, role: 'user', content: 'Attached: .tangleclaw/secrets/shot.png' }] };
        if (/peek/.test(url)) return { lines: [] };
        return null;
      },
      apiMutate: async () => ({ ok: true }), storage: null, operatorHeaders: async () => ({}), readFileAsBase64: async () => 'eA==',
      fetch: async () => ({ ok: false, status: 404, blob: async () => ({}) }),
      createObjectURL: (b) => { created.push(b); return 'blob:local/9'; }, revokeObjectURL: () => {},
      setInterval: () => 0, clearInterval: () => {} });
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const pending = [];
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null, onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    for (let i = 0; i < 4; i++) { while (pending.length) await pending.shift(); await new Promise((r) => setImmediate(r)); }
    assert.deepEqual(created, [], 'the refused fetch made no URL');
    const file = { name: 'shot.png', size: 3 };
    await live.attachFiles([file]);
    await live.refresh();
    assert.deepEqual(created, [file]);
    assert.match(root.innerHTML + doc.getElementById('v6ChatRecorded').innerHTML, /<img class="v6-chat-thumb" src="blob:local\/9"/);
  });

  it('a refused fetch leaves a file-name chip and is not retried on the next poll', async () => {
    const m = mountThumbs({ fail: true });
    await m.settle();
    assert.equal(thumbIn(m), undefined);
    assert.match(m.root.innerHTML, /<span class="v6-chat-attachment"><span aria-hidden="true">📎<\/span> shot\.png<\/span>/);
    await m.timers[m.timers.length - 1]();
    await m.settle();
    assert.equal(m.fetches.length, 1);
  });
});

describe('the verbosity filter on Under the Hood (#3082)', () => {
  const G = loadV6Shell();
  const run = (lines) => plain(G.tcV6ExtractLiveTurns(lines, 'claude', []));
  const wake = '> [TangleClaw Switchboard] You have 1 unread Medusa message(s): tc message read.';

  it('a reply already answering the operator stays theirs when a wake lands mid-reply (chunk review, blocking)', () => {
    const out = run(['> what next?', '⏺ The release is cut tomorrow.', wake, '⏺ Acked INT.']);
    assert.deepEqual(out.turns, [{ role: 'user', text: 'what next?' }, { role: 'assistant', text: 'The release is cut tomorrow.' },
      { role: 'assistant', text: 'Acked INT.', trigger: 'switchboard' }]);
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 2, events: [],
      chat: { status: 'active', members: [], live: out } });
    const live = html.slice(html.indexOf('id="v6ChatLive"'), html.indexOf('id="v6ChatRecordedTail"'));
    assert.match(live, /The release is cut tomorrow\./, 'the direct answer is not tucked away');
    assert.doesNotMatch(live, /Acked INT\./);
  });

  it('a question asked before a wake still waits after the session answers the wake (verify, blocking)', () => {
    const out = run(['> fix it', '⏺ Fixed. Shall I push?', wake, '⏺ Acked INT.']);
    assert.deepEqual(out.questions, ['Fixed. Shall I push?']);
    assert.deepEqual(run(['> fix it', '⏺ Fixed. Shall I push?', wake, '⏺ Acked INT.', '> yes']).questions, [], 'the operator answering clears it');
  });

  it('a dismissal holds when a wake reply splits the turn after it', () => {
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/projects/x'), storage: null });
    const before = run(['> fix it', '⏺ Fixed. Shall I push?']);
    shell.setDetail({ kind: 'conversation', view: { project: { id: 1, name: 'P' }, sessionId: 2, events: [], chat: { status: 'active', members: [], live: before } } });
    doc.getElementById('v6ChatQuestionDismiss0').dispatch('click');
    shell.setLive({ peek: null, live: run(['> fix it', '⏺ Fixed. Shall I push?', wake, '⏺ Acked INT.']) });
    assert.doesNotMatch(doc.getElementById('v6ChatQuestion').innerHTML, /Shall I push/);
  });

  it('marks a reply a wake set going, until the operator speaks again', () => {
    const out = run([wake, '⏺ Acked INT.', '> what next?', '⏺ The release.']);
    assert.deepEqual(out.turns.map((t) => t.trigger || 'direct'), ['switchboard', 'direct', 'direct']);
  });

  it('shows a question whose ? is followed by more words, a parenthetical or markdown, and queues it (O-Gate B2)', () => {
    const asked = ['Operator: should I merge #12? Reply yes/no.', 'Proceed? (y/n)', '**Need your call: ship it?**'];
    for (const text of asked) {
      const out = run([wake, `⏺ ${text}`]);
      assert.deepEqual(out.questions, [text], `${text} reaches Waiting on you`);
      const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 2, events: [],
        chat: { status: 'active', members: [], live: { turns: out.turns } } });
      const live = html.slice(html.indexOf('id="v6ChatLive"'), html.indexOf('id="v6ChatRecordedTail"'));
      assert.match(live, new RegExp(text.slice(-8).replace(/[?*()]/g, '\\$&')), `${text} stays in the chat`);
      assert.match(html, /id="v6ChatTuckedCount"[^>]*><\/span>|id="v6ChatTuckedCount"[^>]*hidden/, `${text} is not tucked`);
    }
  });

  it('a ? inside a URL or inline code is not a question', () => {
    for (const text of ['Acked; see https://example.com/pr?_id=12 for it.', 'Ran `ls build? out` and routed it.', 'Acked INT re: a?b.']) {
      assert.deepEqual(run([wake, `⏺ ${text}`]).questions, [], text);
    }
  });

  /** A chat whose live turns hold one reply of each kind after a wake. */
  function view(verbosity) {
    const turns = [
      { role: 'assistant', text: 'PR 3081 merged as d78e877e.', trigger: 'switchboard' },
      { role: 'assistant', text: 'CI failed on the large tier.', trigger: 'switchboard' },
      { role: 'assistant', text: 'Acked and routed to INT.', trigger: 'switchboard' },
      { role: 'assistant', text: 'Shall I rebase?', trigger: 'switchboard' },
      { role: 'assistant', text: 'Direct answer.' }
    ];
    return G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 2, events: [],
      chat: { status: 'active', members: [], live: { turns }, verbosity } });
  }
  const liveOf = (html) => html.slice(html.indexOf('id="v6ChatLive"'), html.indexOf('id="v6ChatRecordedTail"'));

  it('by default shows blockers, milestones, questions and direct chat, and tucks fleet chatter with a count', () => {
    const html = view();
    const live = liveOf(html);
    assert.match(live, /PR 3081 merged/);
    assert.match(live, /CI failed/);
    assert.match(live, /Shall I rebase\?/);
    assert.match(live, /Direct answer\./);
    assert.doesNotMatch(live, /Acked and routed/);
    assert.match(html, /<span id="v6ChatTuckedCount" class="v6-chat-tucked-count">1 tucked<\/span>/);
    assert.match(html, /<li class="v6-chat-tucked-item is-chatter"><span class="v6-chat-tucked-kind">Fleet chatter<\/span> <span class="v6-conversation-content">Acked and routed to INT\.<\/span>/);
    assert.match(html, /<input type="checkbox" id="v6ChatShowBlockers" data-verbosity="blockers" checked>/);
    assert.match(html, /<input type="checkbox" id="v6ChatShowMilestones" data-verbosity="milestones" checked>/);
    assert.match(html, /<input type="checkbox" id="v6ChatShowChatter" data-verbosity="chatter">/);
  });

  it('a tucked reply is escaped like any other', () => {
    const html = G.tcV6ConversationViewMarkup({ project: { id: 1, name: 'P' }, sessionId: 2, events: [],
      chat: { status: 'active', members: [], live: { turns: [{ role: 'assistant', text: 'Acked <img src=x onerror=alert(1)>', trigger: 'switchboard' }] } } });
    const tucked = html.slice(html.indexOf('id="v6ChatTucked"'), html.indexOf('</ol>', html.indexOf('id="v6ChatTucked"')));
    assert.match(tucked, /Acked &lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
  });

  it('each kind follows its own box; questions and direct chat always show', () => {
    const live = liveOf(view({ blockers: false, milestones: false, chatter: true }));
    assert.doesNotMatch(live, /PR 3081 merged/);
    assert.doesNotMatch(live, /CI failed/);
    assert.match(live, /Acked and routed/);
    assert.match(live, /Shall I rebase\?/);
    assert.match(live, /Direct answer\./);
  });

  it('a box changes the chat in place and is remembered', () => {
    const storage = makeStorage();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/projects/x'), storage });
    shell.setDetail({ kind: 'conversation', view: { project: { id: 1, name: 'P' }, sessionId: 2, events: [],
      chat: { status: 'active', members: [], live: { turns: [{ role: 'assistant', text: 'Acked.', trigger: 'switchboard' }] } } } });
    // The badge as the page drew it ("1 tucked"); the mini-DOM's stub starts empty.
    doc.getElementById('v6ChatTuckedCount').innerHTML = '1 tucked';
    const box = doc.getElementById('v6ChatShowChatter');
    box.checked = true;
    box.setAttribute('data-verbosity', 'chatter');
    box.dispatch('change');
    assert.match(doc.getElementById('v6ChatLive').innerHTML, /Acked\./);
    assert.equal(doc.getElementById('v6ChatTuckedCount').innerHTML, '');
    assert.deepEqual(JSON.parse(storage.data.tc_v6_chat_verbosity), { blockers: true, milestones: true, chatter: true });
    // A later visit starts from the remembered choice.
    const next = makeDocument([]);
    const root2 = next.doc.createElement('div');
    withIdParsingInnerHTML(root2, next.doc);
    next.doc.body.appendChild(root2);
    const again = G.tcCreateV6Shell(next.doc, { root: root2, window: makeFakeWindow('#/projects/x'), storage });
    again.setDetail({ kind: 'conversation', view: { project: { id: 1, name: 'P' }, sessionId: 2, events: [],
      chat: { status: 'active', members: [], live: { turns: [{ role: 'assistant', text: 'Acked.', trigger: 'switchboard' }] } } } });
    const html = root2.innerHTML;
    assert.match(html.slice(html.indexOf('id="v6ChatLive"'), html.indexOf('id="v6ChatRecordedTail"')), /Acked\./);
    assert.match(html, /<input type="checkbox" id="v6ChatShowChatter" data-verbosity="chatter" checked>/);
  });
});

describe('V6210 chunk 01 styles (#3082)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  it('styles links, the external image card, thumbnails, the filter and the tucked count', () => {
    assert.match(CSS, /\.v6-chat-link \{[^}]*text-decoration: underline;/);
    assert.match(CSS, /\.v6-chat-link-preview \{[^}]*display: inline-flex;/);
    assert.match(CSS, /\.v6-chat-thumb \{[^}]*max-width: 220px;[^}]*max-height: 160px;/);
    assert.match(CSS, /\.v6-chat-verbosity \{[^}]*display: flex;/);
    assert.match(CSS, /\.v6-chat-tucked-count:not\(:empty\) \{[^}]*background: #d4a72c;/);
  });
});

describe('Force Send (#3082 item 3, Ruling A757)', () => {
  const G = loadV6Shell();

  it('Ctrl/Cmd+Shift+Enter is Force Send; Shift+Enter alone stays a newline; Enter sends', () => {
    assert.equal(G.tcV6ChatKeyAction({ key: 'Enter', shiftKey: true, ctrlKey: true }), 'force');
    assert.equal(G.tcV6ChatKeyAction({ key: 'Enter', shiftKey: true, metaKey: true }), 'force');
    assert.equal(G.tcV6ChatKeyAction({ key: 'Enter', shiftKey: true }), null);
    assert.equal(G.tcV6ChatKeyAction({ key: 'Enter' }), 'send');
    assert.equal(G.tcV6ChatKeyAction({ key: 'Enter', shiftKey: true, ctrlKey: true, isComposing: true }), null);
  });

  it('draws a named Force button that stays enabled while a send is pending, and is off with no session', () => {
    const view = (chat, extra) => G.tcV6ConversationViewMarkup(Object.assign({ project: { id: 1, name: 'P' }, sessionId: 2, events: [],
      chat: Object.assign({ status: 'active', members: [] }, chat || {}) }, extra || {}));
    const pending = view({ send: { kind: 'pending', message: 'Sending…' } });
    assert.match(pending, /<button type="button" id="v6ChatForceSend" class="btn btn-secondary v6-chat-force-send"\s+title="Send now, even while a reply or another send is in flight \(Ctrl\/Cmd\+Shift\+Enter\)"\s+aria-label="Force send: send now, even while a reply or another send is in flight"><span aria-hidden="true">⚡<\/span> Force<\/button>/);
    assert.match(pending, /<button type="submit" id="v6ChatSend"[^>]*disabled/);
    assert.match(view({ status: 'offline' }, { sessionId: null }), /id="v6ChatForceSend"[^>]*disabled/);
  });

  /**
   * A live chat wired as public/ui.js wires it (onSendChat gets the text
   * alone), whose command route can be held in flight or refuse.
   */
  function mountForce(opts) {
    const o = opts || {};
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const commands = [];
    const releases = [];
    const api = async (url) => {
      if (url === '/api/projects') return { projects: [{ id: 12, name: 'TC-Lane-PM', engine: { id: 'claude' } }] };
      if (url === '/api/sessions/TC-Lane-PM/status') return { active: true, sessionId: 1592 };
      if (/conversation\/events/.test(url)) return { events: [] };
      if (o.ask && /peek/.test(url)) return { lines: o.pane || ['⏺ Ready to go?'] };
      return null;
    };
    api.lastError = null;
    const headersSeen = [];
    // The command route: a forced send must arrive with the operator proof.
    const command = async (body, headers) => {
      commands.push(plain(body));
      headersSeen.push(headers === undefined ? undefined : plain(headers));
      if (o.refuse && body.priority) { api.lastError = o.refuse; return null; }
      const first = commands.length === 1;
      if (o.hold && first) await new Promise((r) => releases.push(r));
      if (o.refuseFirst && first) { api.lastError = o.refuseFirst; return null; }
      return { ok: true };
    };
    const apiRead = api;
    const apiWithPost = async (url, opts) => {
      if (opts && opts.method === 'POST' && /\/command$/.test(url)) return command(JSON.parse(opts.body), opts.headers);
      return apiRead(url, opts);
    };
    Object.defineProperty(apiWithPost, 'lastError', { get: () => api.lastError, set: (v) => { api.lastError = v; } });
    const apiMutate = async (url, method, body) => {
      if (!/\/command$/.test(url)) return { ok: true };
      // apiMutate carries no operator proof, so a priority command through it is refused by the route.
      if (body && body.priority) throw new Error('a priority command went through apiMutate, without the operator proof');
      return command(body, undefined);
    };
    const operatorHeaders = o.proofFails
      ? async () => { throw new Error('no open token'); }
      : async () => ({ 'Content-Type': 'application/json', 'X-TC-Open-Token': 'tok' });
    let shell = null;
    const pending = [];
    const timers = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api: apiWithPost, apiMutate, operatorHeaders, storage: null,
      setInterval: (fn) => { timers.push(fn); return timers.length - 1; }, clearInterval: () => {} });
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null,
      onRender: (r) => pending.push(live.handleRoute(r)),
      onSendChat: o.twoArgs ? (t, f) => { o.seen = f; pending.push(live.sendChat(t, f)); } : (t) => pending.push(live.sendChat(t)) });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    const type = (text) => { const input = doc.getElementById('v6ChatInput'); input.value = text; input.dispatch('input'); };
    // What the queue has dismissed so far, read through the shell's own question slot markup.
    const dismissed = () => (/id="v6ChatQuestion"[^>]*>([\s\S]*?)<\/div>/.exec(root.innerHTML) || [])[1];
    return { doc, root, shell, commands, headersSeen, settle, type, dismissed, timers, release: () => releases.forEach((r) => r()) };
  }
  const flags = { command: 'now!', enter: true, priority: true, startupIntervention: true };

  it('sends a forced message with the operator proof, and a plain one without it', async () => {
    const m = mountForce();
    await m.settle();
    m.type('now!');
    m.doc.getElementById('v6ChatForceSend').dispatch('click');
    await m.settle();
    m.type('later');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await m.settle();
    assert.deepEqual(m.commands, [flags, { command: 'later', enter: true }]);
    assert.deepEqual(m.headersSeen, [{ 'Content-Type': 'application/json', 'X-TC-Open-Token': 'tok' }, undefined]);
  });

  it('a forced send whose operator proof cannot be made is not sent, says why and keeps the text', async () => {
    const m = mountForce({ proofFails: true });
    await m.settle();
    m.type('now!');
    m.doc.getElementById('v6ChatForceSend').dispatch('click');
    await m.settle();
    assert.deepEqual(m.commands, []);
    assert.match(m.root.innerHTML, /Not sent: no open token/);
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*>now!<\/textarea>/);
  });

  it('pushes an urgent message in while another send is still in flight, even through a page that passes the text alone', async () => {
    const m = mountForce({ hold: true });
    await m.settle();
    m.type('first');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    m.type('second');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    assert.equal(m.commands.length, 1, 'a plain send still waits');
    m.type('now!');
    m.doc.getElementById('v6ChatForceSend').dispatch('click');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(m.commands, [{ command: 'first', enter: true }, flags]);
    // The forced send is done, the first is not: a plain send still waits for it.
    await new Promise((r) => setImmediate(r));
    m.type('third');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    assert.equal(m.commands.length, 2);
    m.release();
    await m.settle();
  });

  it('the keyboard shortcut forces too, and a forced send leaves the next plain one plain', async () => {
    const m = mountForce();
    await m.settle();
    // Catch the keydown handler the shell gives the box, to call it with a real key event's fields.
    const keydowns = [];
    const realRegister = m.doc._register;
    m.doc._register = (el) => {
      if (el && el.id === 'v6ChatInput') {
        const add = el.addEventListener;
        el.addEventListener = (type, fn) => { if (type === 'keydown') keydowns.push(fn); return add.call(el, type, fn); };
      }
      return realRegister(el);
    };
    m.shell.setTelemetry(null);
    m.type('now!');
    let prevented = false;
    keydowns.forEach((fn) => fn({ key: 'Enter', shiftKey: true, ctrlKey: true, preventDefault: () => { prevented = true; } }));
    await m.settle();
    assert.ok(keydowns.length >= 1, 'the shell gave the box a keydown handler');
    assert.equal(prevented, true);
    m.type('later');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await m.settle();
    assert.deepEqual(m.commands, [flags, { command: 'later', enter: true }]);
  });

  it('also hands the flags to a page that takes a second argument', async () => {
    const o = { twoArgs: true };
    const m = mountForce(o);
    await m.settle();
    m.type('now!');
    m.doc.getElementById('v6ChatForceSend').dispatch('click');
    await m.settle();
    assert.deepEqual(plain(o.seen), { priority: true, startupIntervention: true });
    assert.deepEqual(m.commands, [flags]);
    // Such a page never takes them from the shell, and the next plain send must not inherit them.
    m.type('later');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await m.settle();
    assert.deepEqual(m.commands, [flags, { command: 'later', enter: true }]);
  });

  it('while a send is on its way: Send is drawn disabled, a plain press says to use Force, and each send keeps its own bubble (Force Send review)', async () => {
    const m = mountForce({ hold: true });
    await m.settle();
    m.type('first');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    m.type('now!');
    m.doc.getElementById('v6ChatForceSend').dispatch('click');
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    // The forced send finished and reloaded the chat; the first is still on its way.
    const html = m.root.innerHTML;
    assert.match(html, /<button type="submit" id="v6ChatSend"[^>]*disabled/, 'Send stays disabled while the first is out');
    assert.match(html, /<ol id="v6ChatPending"[^>]*><li class="v6-conversation-event is-user is-pending">[\s\S]*first[\s\S]*Sending…/, 'the first message keeps its bubble');
    // The forced send's own settling repainted the pending list: the first's bubble is still in it.
    assert.match(m.doc.getElementById('v6ChatPending').innerHTML, /first[\s\S]*Sending…/);
    assert.doesNotMatch(m.doc.getElementById('v6ChatPending').innerHTML, /now!/);
    m.type('third');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    assert.equal(m.commands.length, 2);
    assert.match(m.root.innerHTML, /Not sent yet: the last message to TC-Lane-PM is still on its way\. Use ⚡ Force to send this one now\./);
    m.release();
    await m.settle();
    assert.doesNotMatch(m.root.innerHTML, /<button type="submit" id="v6ChatSend"[^>]*disabled/, 'Send is free once both landed');
    assert.doesNotMatch(m.root.innerHTML, /is-pending/);
  });

  it('a first send refused after a forced send reloaded the chat still shows its refusal (Force Send review)', async () => {
    const m = mountForce({ hold: true, refuseFirst: 'The lane is held' });
    await m.settle();
    m.type('first');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    m.type('now!');
    m.doc.getElementById('v6ChatForceSend').dispatch('click');
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    m.release();
    await m.settle();
    assert.match(m.root.innerHTML, /Not sent: The lane is held/);
  });

  it('a press that sends nothing leaves the question queue alone', async () => {
    const o = { hold: true, ask: true };
    const m = mountForce(o);
    await m.settle();
    m.type('first');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    // While the first is on its way, the session asks something new.
    o.pane = ['> first', '⏺ Which branch?'];
    await m.timers[m.timers.length - 1]();
    m.type('second');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    // The ignored press re-drew the chat (its note); the question is still there.
    assert.match(m.root.innerHTML, /Not sent yet:/);
    assert.match(m.dismissed() || '', /Which branch\?/, 'the ignored press dismissed nothing');
    m.release();
    await m.settle();
  });

  it('a refusal the server still makes (an engine startup dialog) shows its reason and puts the text back', async () => {
    const m = mountForce({ refuse: 'An engine startup dialog is on the pane' });
    await m.settle();
    m.type('now!');
    m.doc.getElementById('v6ChatForceSend').dispatch('click');
    await m.settle();
    assert.match(m.root.innerHTML, /Not sent: An engine startup dialog is on the pane/);
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*>now!<\/textarea>/);
  });
});

describe('the workspace mode bar and wizard launcher (#3086)', () => {
  const G = loadV6Shell();
  const MODES = ['chat', 'sprint', 'charter', 'kaizen', 'wizard'];

  it('shows the detail in Chat, the wizard in Wizard even in a chat, and a panel in the data modes', () => {
    assert.deepEqual(plain(G.tcV6WorkspaceVisibility('chat', false)), { detail: true, wizard: true, attestation: true, panel: false });
    assert.deepEqual(plain(G.tcV6WorkspaceVisibility('chat', true)), { detail: true, wizard: false, attestation: false, panel: false });
    assert.deepEqual(plain(G.tcV6WorkspaceVisibility('wizard', true)), { detail: false, wizard: true, attestation: true, panel: false });
    for (const mode of ['sprint', 'charter', 'kaizen']) {
      assert.deepEqual(plain(G.tcV6WorkspaceVisibility(mode, true)), { detail: false, wizard: false, attestation: false, panel: true }, mode);
    }
    assert.deepEqual(plain(G.tcV6WorkspaceVisibility('nonsense', true)), plain(G.tcV6WorkspaceVisibility('chat', true)));
  });

  it('draws five tabs in order, one selected and in the tab order, each naming the region it shows, plus the launcher', () => {
    const html = G.tcV6WorkspaceModeBarMarkup('charter');
    assert.match(html, /<div id="v6WorkspaceModeBar" class="v6-workspace-mode-bar" role="tablist" aria-label="Workspace">/);
    const tabs = [...html.matchAll(/<button type="button" role="tab" id="v6WorkspaceMode-(\w+)" class="v6-workspace-mode( is-active)?"\s+data-workspace-mode="\1" aria-selected="(true|false)" aria-controls="(\w+)"\s+tabindex="(-?\d)"><span aria-hidden="true">([^<]+)<\/span> ([^<]+)<\/button>/g)]
      .map((m) => [m[1], Boolean(m[2]), m[3], m[4], m[5], m[6], m[7]]);
    assert.deepEqual(tabs, [
      ['chat', false, 'false', 'v6ShellDetail', '-1', '💬', 'Chat'],
      ['sprint', false, 'false', 'v6WorkspacePanel', '-1', '📋', 'Sprint &amp; Cars'],
      ['charter', true, 'true', 'v6WorkspacePanel', '0', '🧭', 'Charter &amp; Roadmap'],
      ['kaizen', false, 'false', 'v6WorkspacePanel', '-1', '📈', 'Kaizen &amp; Reports'],
      ['wizard', false, 'false', 'v6ShellWizard', '-1', '🧙', 'Wizard']
    ]);
    assert.match(html, /<button type="button" id="v6ShellWizardOpenTop" class="btn btn-secondary btn-small v6-wizard-open v6-wizard-open--top"\s+data-workspace-mode="wizard" title="New project or fleet: open the wizard"\s+aria-label="New project or fleet: open the wizard"><span aria-hidden="true">＋<\/span> New<\/button>/);
    assert.match(G.tcV6WorkspaceModeBarMarkup('bogus'), /id="v6WorkspaceMode-chat" class="v6-workspace-mode is-active"/);
  });

  /** A shell in a conversation (unless `noChat`), its keydown listeners caught, with a viewer storage and its window. */
  function mount(seed, extra) {
    const { doc } = makeDocument([]);
    const keydowns = new Map();
    const realRegister = doc._register;
    doc._register = (el) => {
      if (el && typeof el.id === 'string' && el.id.startsWith('v6WorkspaceMode-')) {
        const add = el.addEventListener;
        el.addEventListener = (type, fn) => { if (type === 'keydown') keydowns.set(el.id, fn); return add.call(el, type, fn); };
      }
      return realRegister(el);
    };
    const root = doc.createElement('div');
    root.id = 'v6ShellRoot';
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const storage = makeStorage(seed);
    const win = makeFakeWindow('#/projects/tc-lane');
    const shell = G.tcCreateV6Shell(doc, Object.assign({ root, window: win, storage }, extra || {}));
    const chatOf = (id) => ({ kind: 'conversation', view: { project: { id, name: `P${id}` }, sessionId: 2, events: [], chat: { status: 'active', members: [] } } });
    if (!(extra && extra.noChat)) shell.setDetail(chatOf(1));
    const key = (id, k) => keydowns.get(id)({ key: k, preventDefault() {} });
    const selected = () => MODES.filter((m) => doc.getElementById(`v6WorkspaceMode-${m}`).getAttribute('aria-selected') === 'true');
    return { doc, root, shell, storage, key, selected, chatOf, win };
  }

  it('opens the wizard from the sidebar launcher inside a chat, keeping the chat in the page', () => {
    const m = mount();
    assert.match(m.root.innerHTML, /<button type="button" id="v6ShellWizardOpenBtn" class="btn btn-secondary v6-wizard-open" data-workspace-mode="wizard"><span aria-hidden="true">＋<\/span> New Project \/ Fleet Wizard<\/button>/);
    // The test DOM keeps ids, not attributes, so the first drawing is read from its markup.
    assert.match(m.root.innerHTML, /<div id="v6ShellWizard" role="tabpanel" aria-labelledby="v6WorkspaceMode-wizard" hidden>/, 'the wizard is out of sight in a chat');
    assert.match(m.root.innerHTML, /<div id="v6ShellDetail" role="tabpanel" aria-labelledby="v6WorkspaceMode-chat">/);
    assert.match(m.root.innerHTML, /<section id="v6WorkspacePanel" class="v6-workspace-panel" role="tabpanel"\s+aria-labelledby="v6WorkspaceMode-sprint" hidden><\/section>/);
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'half a thought';
    m.doc.getElementById('v6ShellWizardOpenBtn').dispatch('click');
    assert.equal(m.doc.getElementById('v6ShellWizard').hidden, false);
    assert.equal(m.doc.getElementById('v6ShellAttestation').hidden, false);
    assert.equal(m.doc.getElementById('v6ShellDetail').hidden, true);
    assert.equal(m.doc.getElementById('v6WorkspacePanel').hidden, true);
    assert.strictEqual(m.doc.getElementById('v6ChatInput'), input, 'the chat was not redrawn');
    assert.equal(input.value, 'half a thought');
    assert.deepEqual(m.selected(), ['wizard']);
    assert.equal(m.doc.getElementById('v6WorkspaceMode-wizard').getAttribute('tabindex'), '0');
    assert.equal(m.doc.getElementById('v6WorkspaceMode-chat').getAttribute('tabindex'), '-1');
    assert.equal(m.doc.activeElement, m.doc.getElementById('v6WorkspaceMode-wizard'));
    assert.equal(m.storage.data.tc_v6_workspace_mode, undefined, 'the mode is not stored');
    assert.equal(m.shell.getWorkspaceMode(), 'wizard');
    // Back to Chat: the same chat, and the wizard is out of sight again.
    m.doc.getElementById('v6WorkspaceMode-chat').dispatch('click');
    assert.equal(m.doc.getElementById('v6ShellDetail').hidden, false);
    assert.equal(m.doc.getElementById('v6ShellWizard').hidden, true);
    assert.strictEqual(m.doc.getElementById('v6ChatInput'), input);
  });

  it('every tab controls a region drawn as a tab panel that names a tab (cumulative review W-2)', () => {
    const html = mount(undefined, { noChat: true }).root.innerHTML;
    const controls = [...html.matchAll(/role="tab" id="v6WorkspaceMode-\w+"[^>]*aria-controls="(\w+)"/g)].map((x) => x[1]);
    assert.equal(controls.length, 5);
    for (const id of new Set(controls)) {
      assert.match(html, new RegExp(`id="${id}"[^>]*role="tabpanel"[^>]*aria-labelledby="v6WorkspaceMode-\\w+"`), id);
    }
    assert.match(html, /<div id="v6ShellDetail" role="tabpanel" aria-labelledby="v6WorkspaceMode-chat">/);
    assert.match(html, /<div id="v6ShellWizard" role="tabpanel" aria-labelledby="v6WorkspaceMode-wizard">/);
  });

  it('the top launcher opens the wizard too', () => {
    const m = mount();
    m.doc.getElementById('v6ShellWizardOpenTop').dispatch('click');
    assert.deepEqual(m.selected(), ['wizard']);
    assert.equal(m.doc.getElementById('v6ShellWizard').hidden, false);
    m.shell.setWorkspaceMode('admin');
    assert.equal(m.shell.getWorkspaceMode(), 'wizard', 'a name that is not a mode is ignored');
    assert.deepEqual(m.selected(), ['wizard']);
  });

  it('moves between tabs with the arrow keys, Home and End, choosing as it goes and wrapping at the ends', () => {
    const m = mount();
    m.key('v6WorkspaceMode-chat', 'ArrowRight');
    assert.deepEqual(m.selected(), ['sprint']);
    assert.equal(m.doc.activeElement, m.doc.getElementById('v6WorkspaceMode-sprint'));
    assert.equal(m.doc.getElementById('v6WorkspacePanel').hidden, false);
    assert.equal(m.doc.getElementById('v6ShellDetail').hidden, true);
    assert.match(m.doc.getElementById('v6WorkspacePanel').innerHTML, /<h2 class="v6-workspace-panel-title">Sprint &amp; Cars<\/h2>/);
    assert.equal(m.doc.getElementById('v6WorkspacePanel').getAttribute('aria-labelledby'), 'v6WorkspaceMode-sprint');
    m.key('v6WorkspaceMode-sprint', 'End');
    assert.deepEqual(m.selected(), ['wizard']);
    m.key('v6WorkspaceMode-wizard', 'ArrowRight');
    assert.deepEqual(m.selected(), ['chat'], 'wraps to the first');
    m.key('v6WorkspaceMode-chat', 'ArrowLeft');
    assert.deepEqual(m.selected(), ['wizard'], 'wraps to the last');
    m.key('v6WorkspaceMode-wizard', 'Home');
    assert.deepEqual(m.selected(), ['chat']);
    m.key('v6WorkspaceMode-chat', 'ArrowLeft');
    m.key('v6WorkspaceMode-wizard', 'ArrowLeft');
    assert.deepEqual(m.selected(), ['kaizen']);
    assert.match(m.doc.getElementById('v6WorkspacePanel').innerHTML, /Kaizen &amp; Reports/);
    m.key('v6WorkspaceMode-kaizen', 'a');
    assert.deepEqual(m.selected(), ['kaizen'], 'another key does nothing');
  });

  it('every route opens in Chat, a reload included; a redraw on the same route keeps the chosen mode (chunk review W-1)', () => {
    const m = mount({ tc_v6_workspace_mode: JSON.stringify('wizard') });
    assert.match(m.root.innerHTML, /id="v6WorkspaceMode-chat" class="v6-workspace-mode is-active"/, 'a stored mode is not used');
    assert.equal(m.shell.getWorkspaceMode(), 'chat');
    m.doc.getElementById('v6WorkspaceMode-wizard').dispatch('click');
    // The chat arriving, or a poll, on the same route keeps Wizard.
    m.shell.setDetail(m.chatOf(1));
    m.shell.setDetail(m.chatOf(3));
    assert.equal(m.shell.getWorkspaceMode(), 'wizard');
    assert.match(m.root.innerHTML, /<div id="v6ShellDetail" role="tabpanel" aria-labelledby="v6WorkspaceMode-chat" hidden>/);
    // Going to another member shows its chat.
    m.win.location.hash = '#/resources/3/conversation';
    assert.equal(m.shell.getWorkspaceMode(), 'chat');
    assert.match(m.root.innerHTML, /<div id="v6ShellDetail" role="tabpanel" aria-labelledby="v6WorkspaceMode-chat">/);
    assert.match(m.root.innerHTML, /id="v6WorkspaceMode-chat" class="v6-workspace-mode is-active"/);
  });

  it('hides the chat header docked in the top bar while the mode hides the chat (chunk review W-2)', () => {
    // render() takes the docked header out before each redraw and ui.js docks a fresh, visible one; this stand-in
    // plays both, so a redraw that forgets to hide the new header shows.
    const header = { hidden: false, remove() { this.hidden = false; } };
    const bar = { querySelector: (sel) => (sel === '.v6-chat-header' ? header : null) };
    const m = mount(undefined, { noChat: true });
    const realQuery = m.doc.querySelector;
    m.doc.querySelector = (sel) => (sel === '.dash-bar' ? bar : (realQuery ? realQuery.call(m.doc, sel) : null));
    m.shell.setDetail(m.chatOf(1));
    assert.equal(header.hidden, false, 'shown in Chat');
    m.doc.getElementById('v6WorkspaceMode-wizard').dispatch('click');
    assert.equal(header.hidden, true, 'hidden in Wizard');
    m.shell.setDetail(m.chatOf(1));
    assert.equal(header.hidden, true, 'still hidden after a redraw of the same chat');
    m.doc.getElementById('v6WorkspaceMode-sprint').dispatch('click');
    assert.equal(header.hidden, true, 'hidden in a data mode');
    m.doc.getElementById('v6WorkspaceMode-chat').dispatch('click');
    assert.equal(header.hidden, false, 'shown again on Chat');
  });

  it('styles the tabs as 44px targets that scroll sideways on a narrow screen and mark the chosen one', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.#>-]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
    assert.match(rule('.v6-workspace-mode-bar'), /overflow-x: auto;/);
    assert.match(rule('.v6-workspace-mode'), /min-height: 44px;/);
    assert.match(rule('.v6-workspace-mode.is-active'), /border-bottom-color: #2ea043;/);
    assert.match(rule('.v6-workspace-mode:focus-visible'), /outline: 2px solid/);
    assert.match(rule('.v6-wizard-open'), /min-height: 44px;/);
  });

});

describe('the workspace data panels (#3086, Rulings A760, A761, A774)', () => {
  const G = loadV6Shell();
  const content = (mode, result, ui) => G.tcV6WorkspacePanelContent(mode, result, ui);
  const waves = { waves: [{ id: 1, cars: ['a', 'b'] }, { id: '2<i>', cars: [] }],
    dispatch: { 'V630-W1-A': { stage: 'in-review', laneName: 'TC-Lane-A', openPrNumber: 3096 }, '<b>x': { stage: 'constructor', laneName: null, openPrNumber: null } } };
  const report = { report: { version: '6.3.0<', heroKpis: { issuesClosed: 3, builderPRs: 2, waves: 1, fileCollisions: 0, reviewRounds: null, cycleTimeHours: 4.5, netLOC: -10, releaseCommit: '<abc>' },
    guardrailLedger: [{ guardrail: 'G1', triggered: true, count: 2 }, { guardrail: 'G2', triggered: false, count: 0 }] } };

  it('says a missing route is not available yet, and names any other failure, escaped', () => {
    assert.equal(content('sprint', { ok: false, notFound: true }), '<p class="v6-workspace-empty">Not available on this server yet.</p>');
    assert.equal(content('kaizen', { ok: false, error: 'boom <script>' }), '<p class="v6-workspace-empty is-error">Could not load this: boom &lt;script&gt;.</p>');
    assert.match(content('charter', { ok: false }), /Could not load this: the server did not answer\./);
  });

  it('draws through the sprint UI when it is loaded, the board container-first and the two new panels data-first', () => {
    const calls = [];
    const ui = {
      renderSprintWaveBoard: (...a) => { calls.push(['board', ...a]); return '<div>board</div>'; },
      renderCharterReadinessPanel: (...a) => { calls.push(['charter', ...a]); return '<div>charter</div>'; },
      renderKaizenLedgerPanel: (...a) => { calls.push(['kaizen', ...a]); return '<div>kaizen</div>'; }
    };
    assert.equal(content('sprint', { ok: true, data: waves }, ui), '<div>board</div>');
    assert.equal(content('charter', { ok: true, data: waves }, ui), '<div>charter</div>');
    assert.equal(content('kaizen', { ok: true, data: report }, ui), '<div>kaizen</div>');
    assert.deepEqual(calls, [['board', null, waves], ['charter', waves], ['kaizen', report.report]]);
  });

  it('falls back to its own escaped drawing when a builder is missing, throws or returns nothing', () => {
    const throwing = { renderSprintWaveBoard: () => { throw new Error('bad'); } };
    const blank = { renderSprintWaveBoard: () => undefined };
    for (const ui of [null, {}, throwing, blank]) {
      const html = content('sprint', { ok: true, data: waves }, ui);
      assert.match(html, /<li class="v6-workspace-item"><span class="v6-workspace-item-id">V630-W1-A<\/span> <span class="v6-workspace-item-stage">In Review<\/span> <span class="v6-workspace-item-lane">TC-Lane-A<\/span> <span class="v6-workspace-item-pr">#3096<\/span><\/li>/);
      // A stage that names a prototype property is shown as written, and the id is escaped.
      assert.match(html, /<span class="v6-workspace-item-id">&lt;b&gt;x<\/span> <span class="v6-workspace-item-stage">constructor<\/span><\/li>/);
    }
    assert.equal(content('sprint', { ok: true, data: { dispatch: {} } }, null), '<p class="v6-workspace-empty">No cars are on the board yet.</p>');
    const charter = content('charter', { ok: true, data: waves }, null);
    assert.match(charter, /<span class="v6-workspace-item-id">Wave 1<\/span> <span class="v6-workspace-item-stage">2 cars<\/span>/);
    assert.match(charter, /<span class="v6-workspace-item-id">Wave 2&lt;i&gt;<\/span> <span class="v6-workspace-item-stage">0 cars<\/span>/);
    assert.match(content('charter', { ok: true, data: { waves: [{ id: 7, cars: ['x'] }] } }, null), /1 car<\/span>/);
    assert.equal(content('charter', { ok: true, data: {} }, null), '<p class="v6-workspace-empty">No waves are planned yet.</p>');
  });

  it('draws the report\'s version, hero figures and triggered guardrails itself when the sprint UI is not there', () => {
    const html = content('kaizen', { ok: true, data: report }, null);
    assert.match(html, /Version 6\.3\.0&lt;/);
    assert.match(html, /<div><dt>Issues closed<\/dt><dd>3<\/dd><\/div><div><dt>Builder PRs<\/dt><dd>2<\/dd><\/div>/);
    assert.match(html, /<dt>Review rounds<\/dt><dd>—<\/dd>/);
    assert.match(html, /<dt>Release commit<\/dt><dd>&lt;abc&gt;<\/dd>/);
    assert.match(html, /<li class="v6-workspace-item">Guardrail G1: 2<\/li>/);
    assert.doesNotMatch(html, /Guardrail G2/);
    assert.equal(content('kaizen', { ok: true, data: {} }, null), '<p class="v6-workspace-empty">No report for this version yet.</p>');
  });

  /**
   * A live controller over a fake page: a shell stand-in, a script-tag recorder and a stubbed api.
   * `handleRoute(null)` registers the panel loader and stops there, so no route load runs.
   */
  function controller(o) {
    const opts = o || {};
    const scripts = [];
    const timers = [];
    const page = {
      head: { appendChild: (el) => { scripts.push(el); } },
      createElement: (tag) => {
        const listeners = {};
        return { tag, id: '', src: '', listeners, addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }, fire: (t) => (listeners[t] || []).forEach((fn) => fn()) };
      },
      getElementById: (id) => scripts.find((x) => x.id === id) || (opts.byId && id === 'tcSprintWaveUiScript' ? opts.byId : null),
      querySelector: (sel) => (opts.existing && sel === 'script[src="/sprint-wave-ui.js"]' ? opts.existing : null)
    };
    const win = {};
    const urls = [];
    const api = async (url) => {
      urls.push(url);
      if (opts.notFound) { api.lastError = 'GET /api/x not found'; api.lastErrorCode = 'NOT_FOUND'; return null; }
      if (url === '/api/sprint-waves') return { ok: true, waves: [], dispatch: { C1: { stage: 'claimed' } } };
      return { ok: true, report: { version: '6.3.0', heroKpis: {}, guardrailLedger: [] } };
    };
    const panels = [];
    let loader = null;
    const shell = { setWorkspaceLoader: (fn) => { loader = fn; }, setWorkspacePanel: (mode, html) => panels.push([mode, html]) };
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate: async () => null, storage: null,
      window: win, document: page, setTimeout: (fn) => { timers.push(fn); },
      setInterval: () => 0, clearInterval: () => {} });
    return { live, scripts, timers, win, urls, panels, page, load: (mode, version) => loader(mode, { version }) };
  }

  it('adds the sprint UI script once, draws with it when it loads, and never adds it twice', async () => {
    const c = controller();
    await c.live.handleRoute(null);
    c.load('sprint', '6.3.0');
    await new Promise((r) => setImmediate(r));
    assert.equal(c.scripts.length, 1);
    assert.equal(c.scripts[0].id, 'tcSprintWaveUiScript');
    assert.equal(c.scripts[0].src, '/sprint-wave-ui.js');
    c.load('charter', '6.3.0');
    await new Promise((r) => setImmediate(r));
    assert.equal(c.scripts.length, 1, 'a second panel waits on the same script');
    assert.equal(c.scripts[0].listeners.load.length, 1, 'through the one wait already running');
    c.win.TangleClawSprintWaveUi = { renderSprintWaveBoard: (container, data) => `<div>board ${Object.keys(data.dispatch).join()}</div>` };
    c.scripts[0].fire('load');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.panels[0], ['sprint', '<div>board C1</div>']);
    assert.match(c.panels[1][1], /No waves are planned yet\./, 'a builder the loaded UI lacks falls back');
    assert.deepEqual(c.urls, ['/api/sprint-waves', '/api/sprint-waves']);
    // Loaded: later panels use it straight away.
    c.load('sprint', '6.3.0');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(c.scripts.length, 1);
    assert.deepEqual(c.panels[2], ['sprint', '<div>board C1</div>']);
  });

  it('waits on a script already in the page rather than adding another, and tries again after a failed load', async () => {
    const existing = { id: '', src: '/sprint-wave-ui.js', listeners: {}, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); } };
    const c = controller({ existing });
    await c.live.handleRoute(null);
    c.load('sprint', '6.3.0');
    await new Promise((r) => setImmediate(r));
    assert.equal(c.scripts.length, 0);
    existing.listeners.error.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.match(c.panels[0][1], /<span class="v6-workspace-item-id">C1<\/span> <span class="v6-workspace-item-stage">Claimed<\/span>/, 'built-in drawing after a failed load');
    c.load('sprint', '6.3.0');
    await new Promise((r) => setImmediate(r));
    assert.equal(existing.listeners.load.length, 2, 'a later panel waits on the page\'s script again');
    assert.equal(c.scripts.length, 0, 'still never adds its own');
    // A script that never answers gives up at the timer.
    c.timers.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(c.panels.length, 2);
  });

  it('finds a script the page already has by its id too', async () => {
    const byId = { id: 'tcSprintWaveUiScript', src: '/other.js', listeners: {}, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); } };
    const c = controller({ byId });
    await c.live.handleRoute(null);
    c.load('sprint', '6.3.0');
    await new Promise((r) => setImmediate(r));
    assert.equal(c.scripts.length, 0);
    assert.equal(byId.listeners.load.length, 1);
  });

  it('reads the running version\'s report, says when no version is known, and says when the route is missing', async () => {
    const c = controller();
    await c.live.handleRoute(null);
    c.win.TangleClawSprintWaveUi = {};
    c.load('kaizen', '6.3.0 rc/1');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.urls, ['/api/sprint-reports/6.3.0%20rc%2F1']);
    assert.match(c.panels[0][1], /Version 6\.3\.0/);
    c.load('kaizen', null);
    await new Promise((r) => setImmediate(r));
    assert.equal(c.urls.length, 1, 'no version, no request');
    assert.match(c.panels[1][1], /Could not load this: the running version is not known yet\./);
    const missing = controller({ notFound: true });
    await missing.live.handleRoute(null);
    missing.load('sprint', '6.3.0');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(missing.panels[0], ['sprint', '<p class="v6-workspace-empty">Not available on this server yet.</p>']);
    assert.equal(missing.scripts.length, 0, 'a failed read loads no script');
  });

  it('the shell asks for a panel with the running version when its mode is shown, and paints only the mode on screen', () => {
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    root.id = 'v6ShellRoot';
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/projects/tc-lane'), storage: makeStorage() });
    shell.setTelemetry({ versionDrift: { value: '6.3.0' } });
    const asked = [];
    shell.setWorkspaceLoader((mode, context) => asked.push([mode, plain(context)]));
    assert.deepEqual(asked, [], 'Chat needs no panel');
    doc.getElementById('v6WorkspaceMode-sprint').dispatch('click');
    assert.deepEqual(asked, [['sprint', { version: '6.3.0' }]]);
    assert.match(doc.getElementById('v6WorkspacePanel').innerHTML, /<p class="v6-workspace-empty" role="status">Loading…<\/p>/);
    shell.setWorkspacePanel('sprint', '<div>board</div>');
    assert.match(doc.getElementById('v6WorkspacePanel').innerHTML, /<h2 class="v6-workspace-panel-title">Sprint &amp; Cars<\/h2>\s*<div>board<\/div>/);
    shell.setWorkspacePanel('kaizen', '<div>report</div>');
    assert.doesNotMatch(doc.getElementById('v6WorkspacePanel').innerHTML, /report/, 'a mode not on screen is kept, not painted');
    doc.getElementById('v6WorkspaceMode-kaizen').dispatch('click');
    assert.match(doc.getElementById('v6WorkspacePanel').innerHTML, /<div>report<\/div>/, 'kept content shows at once');
    assert.deepEqual(asked[1], ['kaizen', { version: '6.3.0' }], 'and is refreshed');
    shell.setWorkspacePanel('bogus', '<div>x</div>');
    shell.setWorkspacePanel('kaizen', 42);
    assert.match(doc.getElementById('v6WorkspacePanel').innerHTML, /<div>report<\/div>/);
    // A loader registered while a data mode is shown is asked at once; without telemetry the version is null.
    const again = [];
    shell.setTelemetry(null);
    shell.setWorkspaceLoader((mode, context) => again.push([mode, plain(context)]));
    assert.deepEqual(again, [['kaizen', { version: null }]]);
  });
});

describe('one top bar in the v6 shell (Rulings A764, A765)', () => {
  const G = loadV6Shell();

  /** A small page with real sibling order: the dashboard bar, and the shell's main and footer. */
  function makePage() {
    const byId = {};
    const node = (tag, id, className) => {
      const classes = new Set(String(className || '').split(/\s+/).filter(Boolean));
      const el = {
        tagName: tag.toUpperCase(), id: id || '', childNodes: [], parentNode: null, open: false, textContent: '', title: '', attrs: {}, listeners: {},
        get className() { return [...classes].join(' '); }, set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
        classList: { contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
        get nextSibling() { const p = el.parentNode; return p ? p.childNodes[p.childNodes.indexOf(el) + 1] || null : null; },
        setAttribute(k, v) { el.attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
        removeAttribute(k) { delete el.attrs[k]; },
        addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
        appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = el; el.childNodes.push(c); return c; },
        insertBefore(c, ref) { if (c.parentNode) c.remove(); c.parentNode = el; el.childNodes.splice(el.childNodes.indexOf(ref), 0, c); return c; },
        // As a browser does, moving a node that holds focus blurs it.
        remove() { const p = el.parentNode; if (p) p.childNodes.splice(p.childNodes.indexOf(el), 1); el.parentNode = null; if (doc.activeElement && el.contains(doc.activeElement)) doc.activeElement = body; },
        contains(other) { for (let n = other; n; n = n.parentNode) if (n === el) return true; return false; },
        focus() { doc.activeElement = el; },
        querySelector(sel) {
          const cls = sel.replace(/^\./, '');
          for (const c of el.childNodes) { if (c.classList.contains(cls)) return c; const d = c.querySelector(sel); if (d) return d; }
          return null;
        }
      };
      if (id) byId[id] = el;
      return el;
    };
    const body = node('body');
    const attached = (el) => { for (let n = el; n; n = n.parentNode) if (n === body) return true; return false; };
    const doc = {
      body, activeElement: null,
      createElement: (tag) => node(tag),
      getElementById: (id) => (byId[id] && attached(byId[id]) ? byId[id] : null),
      querySelector: (sel) => body.querySelector(sel),
      _register: (el) => { if (el.id) byId[el.id] = el; }
    };
    const bar = body.appendChild(node('header', '', 'dash-bar'));
    const brand = bar.appendChild(node('div', '', 'dash-brand'));
    const stats = bar.appendChild(node('div', 'dashStats', 'dash-stats'));
    const actions = bar.appendChild(node('div', '', 'dash-actions'));
    actions.appendChild(node('button', 'v6ViewToggleBtn'));
    const shellRoot = body.appendChild(node('div', 'v6ShellRoot'));
    const drawChat = () => {
      shellRoot.childNodes.slice().forEach((c) => c.remove());
      const main = shellRoot.appendChild(node('main', 'v6ShellMain'));
      const header = main.appendChild(node('header', '', 'v6-chat-header'));
      header.appendChild(node('button', 'v6ChatRename'));
      shellRoot.appendChild(node('footer', '', 'v6-shell-watermark')).appendChild(node('div', 'v6ShellStatusBar', 'v6-shell-status-bar'));
      return header;
    };
    return { doc, bar, brand, stats, actions, drawChat };
  }
  const kids = (el) => el.childNodes.map((c) => c.id || c.className);

  it('docks the chat header into the dashboard bar, before its actions, keeping focus inside it', () => {
    const p = makePage();
    const header = p.drawChat();
    p.doc.getElementById('v6ChatRename').focus();
    G.tcV6TuckAdminControls(p.doc, true);
    assert.deepEqual(kids(p.bar), ['dash-brand', 'v6-chat-header', 'dash-actions']);
    assert.equal(header.parentNode, p.bar);
    assert.equal(p.doc.activeElement, p.doc.getElementById('v6ChatRename'), 'focus stayed in the moved header');
  });

  it('a later drawing replaces the docked header, never leaving two; leaving the shell takes it out', () => {
    const p = makePage();
    p.drawChat();
    G.tcV6TuckAdminControls(p.doc, true);
    const second = p.drawChat();
    G.tcV6TuckAdminControls(p.doc, true);
    assert.equal(kids(p.bar).filter((k) => k === 'v6-chat-header').length, 1);
    assert.equal(p.bar.querySelector('.v6-chat-header'), second);
    G.tcV6TuckAdminControls(p.doc, false);
    assert.equal(p.bar.querySelector('.v6-chat-header'), null);
  });

  it('moves the CPU/MEM/DISK/UP stats into the footer status bar, and back to their exact place in Classic', () => {
    const p = makePage();
    p.drawChat();
    G.tcV6TuckAdminControls(p.doc, true);
    assert.equal(p.stats.parentNode, p.doc.getElementById('v6ShellStatusBar'));
    assert.ok(!kids(p.bar).includes('dashStats'), 'not shown twice');
    // The footer is a status region; the 30 s refresh must not be announced there.
    assert.equal(p.stats.getAttribute('aria-live'), 'off');
    G.tcV6TuckAdminControls(p.doc, false);
    assert.deepEqual(kids(p.bar), ['dash-brand', 'dashStats', 'dash-actions']);
    assert.equal(p.stats.getAttribute('aria-live'), null, 'back home, as it was');
  });

  it('a shell redraw sends the live stats home first, so the same node survives and moves into the new footer', () => {
    const { doc } = makeDocument([]);
    const bar = doc.createElement('header');
    bar.className = 'dash-bar';
    const stats = doc.createElement('div');
    stats.id = 'dashStats';
    doc._register(stats);
    bar.appendChild(stats);
    doc.body.appendChild(bar);
    doc.querySelector = (sel) => doc.body.querySelector(sel);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    // Where the stats are as the shell hands over to onRender: home in the bar, never left in the
    // footer the redraw just replaced (a browser would have dropped them with it).
    const atHandover = [];
    const shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/projects/x'), storage: null,
      onRender: () => { atHandover.push(stats.parentNode); G.tcV6TuckAdminControls(doc, true); } });
    const bar1 = { scope: 'global', metrics: { activeSessions: { value: 1, confidence: 'observed' } } };
    shell.setTelemetry(bar1);
    const footer1 = doc.getElementById('v6ShellStatusBar');
    assert.equal(stats.parentNode, footer1);
    shell.setTelemetry(Object.assign({}, bar1));
    const footer2 = doc.getElementById('v6ShellStatusBar');
    assert.notEqual(footer2, footer1, 'the footer was redrawn');
    assert.equal(doc.getElementById('dashStats'), stats, 'the same live node');
    assert.equal(stats.parentNode, footer2);
    assert.equal(atHandover[atHandover.length - 1], bar, 'the redraw sent the stats home first');
  });

  it('styles the docked header as a segment of the one bar, and the moved stats in the footer', () => {
    const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    // The docked header is outside #v6ShellRoot: the #3063 pills and the shell's tokens are restated for it.
    assert.match(CSS, /\.dash-bar \.v6-chat-header \{\s*--v6-outline: #3d444d;\s*--v6-surface: var\(--card-bg, #0d0d0d\);\s*\}/);
    assert.match(CSS, /\[data-theme="light"\] \.dash-bar \.v6-chat-header \{\s*--v6-outline: #8c959f;\s*\}/);
    assert.match(CSS, /\.dash-bar \.v6-chat-header \.v6-telemetry-chip \{\s*flex-direction: row;/);
    assert.match(CSS, /\.dash-bar \.v6-chat-header \.v6-telemetry-chip\.is-unavailable \{\s*display: none;\s*\}/);
    assert.match(CSS, /\.dash-bar \.v6-chat-header \.v6-telemetry-header \{\s*margin-bottom: 0;/);
    assert.match(CSS, /\.dash-bar \.v6-chat-header \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;[^}]*margin: 0;[^}]*padding: 0;[^}]*border: 0;[^}]*background: transparent;/);
    assert.match(CSS, /\.v6-shell-status-bar \.dash-stats \{[^}]*display: inline-flex;/);
  });
});

// ── #3085 frontend (Car V6210-W1-A): the 3-engine usage meter ──

describe('the 3-engine usage meter (#3085, Contract A753-1)', () => {
  const G = loadV6Shell();
  const windows = (over) => Object.assign({
    resetSchedule: { nextWeeklyResetAt: '2026-11-19T14:00:00.000Z', hoursUntilWeeklyReset: 106.5 },
    byProviderModel: {
      claude: { opus: { fiveHour: { totalTokens: 1000 }, weekly: { totalTokens: 5000 }, sprint: { totalTokens: 700 } }, sonnet: { fiveHour: { totalTokens: 500 }, weekly: { totalTokens: 2500 } } },
      codex: { sol: { fiveHour: { totalTokens: 3e8 }, weekly: { totalTokens: 9.42e8 } } }
    },
    calibration: { claude: { weeklyPct: 40, fiveHourPct: 60 }, codex: null }
  }, over || {});
  const model = (w, sess) => plain(G.tcV6UsageMeterModel(w, sess));

  it('always shows all three engines, summing each one\'s models; a missing engine counts as none', () => {
    const m = model(windows());
    assert.deepEqual(m.engines.map((e) => [e.key, e.label]), [['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'AGY']]);
    assert.deepEqual(m.engines[0].tokens, { fiveHour: 1500, weekly: 7500, sprint: 700 });
    assert.deepEqual(m.engines[2].tokens, { fiveHour: 0, weekly: 0, sprint: 0 });
    assert.equal(m.resetHours, 106.5);
    assert.deepEqual(model(null).engines.map((e) => e.state), ['unknown', 'unknown', 'unknown']);
  });

  it('a session reading that only reports the calibration back is not live; a combined one says so (O-Gate N2)', () => {
    const echoed = model(windows(), { sessions: [{ engine: 'claude', source: 'provider-window', weeklyRemainingPct: 3 }] });
    assert.deepEqual([echoed.engines[0].remainingPct, echoed.engines[0].source, echoed.engines[0].sessions], [40, 'calibrated', 1]);
    const mixed = model(windows(), { sessions: [{ engine: 'claude', source: 'combined', weeklyRemainingPct: 30 },
      { engine: 'codex', source: 'terminal-statusline', weeklyRemainingPct: 50 }] });
    assert.deepEqual(mixed.engines.slice(0, 2).map((e) => [e.remainingPct, e.source]), [[30, 'live and calibrated'], [50, 'live']]);
    assert.equal(model(windows(), { sessions: [{ engine: 'claude', source: 'none', weeklyRemainingPct: 1 }] }).engines[0].source, 'calibrated');
  });

  it('% left is the lowest a live session reports, else the calibration (both REMAINING), else unknown', () => {
    const live = { sessions: [{ engine: 'codex', weeklyRemainingPct: 7 }, { engine: 'codex', fiveHourRemainingPct: 0 }, { engine: 'claude', weeklyRemainingPct: null }] };
    const m = model(windows(), live);
    assert.deepEqual(m.engines.map((e) => [e.remainingPct, e.source, e.sessions]), [[40, 'calibrated', 1], [0, 'live', 2], [null, 'none', 0]]);
    // A live reading wins over a calibration on file, even a more hopeful one.
    const both = model(windows(), { sessions: [{ engine: 'claude', weeklyRemainingPct: 3 }] });
    assert.deepEqual([both.engines[0].remainingPct, both.engines[0].source, both.engines[0].state], [3, 'live', 'critical']);
  });

  it('colours by what is left: above 25 healthy, 25 down to 6 warning, 5 or less critical', () => {
    const at = (pct) => model(windows({ calibration: { claude: { weeklyPct: pct } } })).engines[0].state;
    assert.deepEqual([26, 25, 6, 5, 0].map(at), ['healthy', 'warning', 'warning', 'critical', 'critical']);
  });

  it('draws a pill per engine with its state classes, a fill as wide as what is left, and a summary to screen readers', () => {
    const html = G.tcV6UsageMeterMarkup(G.tcV6UsageMeterModel(windows({ calibration: { claude: { weeklyPct: 40 }, codex: { weeklyPct: 20 }, antigravity: { weeklyPct: 3 } } })), { open: false });
    assert.match(html, /<button type="button" id="v6EngineUsageMeter" class="v6-usage-meter" aria-expanded="false" aria-controls="v6EngineUsagePopover"/);
    assert.match(html, /aria-label="Engine usage: Claude 40% left, Codex 20% left, Antigravity 3% left\. Open the breakdown\."/);
    assert.match(html, /<span class="v6-usage-pill is-healthy is-green" data-engine="claude"[^>]*>[\s\S]*?style="width: 40%"[\s\S]*?40% left/);
    assert.match(html, /<span class="v6-usage-pill is-warning is-amber" data-engine="codex"/);
    assert.match(html, /<span class="v6-usage-pill is-critical is-red" data-engine="antigravity"/);
    assert.match(html, /<div id="v6EngineUsagePopover" class="v6-usage-popover" role="dialog" aria-label="Engine usage" hidden>/);
    const none = G.tcV6UsageMeterMarkup(G.tcV6UsageMeterModel(windows()), {});
    assert.match(none, /data-engine="codex"[^>]*>[\s\S]*?style="width: 0%"[\s\S]*?942M this week/, 'no % reported: the week\'s tokens');
  });

  it('the breakdown lists 5h, week and sprint tokens, sessions, the reset, and a % left input pair with Set for each engine', () => {
    const html = G.tcV6UsageMeterMarkup(G.tcV6UsageMeterModel(windows(), { sessions: [{ engine: 'claude' }] }), { open: true });
    assert.doesNotMatch(html, /v6EngineUsagePopover"[^>]*hidden/);
    assert.match(html, /<p class="v6-usage-reset">Resets in 4d 10h<\/p>/);
    assert.match(html, /<tr data-engine="claude"><th scope="row">Claude<\/th><td>1\.5k<\/td><td>7\.5k<\/td><td>700<\/td><td>1<\/td><td>40%<\/td>/);
    for (const key of ['claude', 'codex', 'antigravity']) {
      assert.match(html, new RegExp(`id="v6UsageWeekly-${key}"`));
      assert.match(html, new RegExp(`id="v6UsageFiveHour-${key}"`));
      assert.match(html, new RegExp(`<button type="button" id="v6UsageSave-${key}"`));
    }
  });

  it('escapes a calibration message', () => {
    const html = G.tcV6UsageMeterMarkup(G.tcV6UsageMeterModel(windows()), { open: true, status: { kind: 'error', message: 'Codex not set: <img src=x onerror=alert(1)>' } });
    assert.match(html, /<p id="v6EngineUsageStatus" class="v6-usage-status is-error" role="status">Codex not set: &lt;img src=x onerror=alert\(1\)&gt;<\/p>/);
    assert.doesNotMatch(html, /<img src=x/);
  });

  /** A shell with the meter, its calibrate action recorded. */
  function mountMeter(calibrate) {
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/projects/x'), storage: null });
    const calls = [];
    shell.setUsageActions({ calibrate: async (...a) => { calls.push(a); return calibrate ? calibrate(...a) : { ok: true }; } });
    shell.setUsage({ windows: windows(), sessions: { sessions: [] } });
    return { shell, doc, root, calls };
  }

  it('renders in the footer even before telemetry, in chat and outside it, and opens in place', () => {
    const m = mountMeter();
    assert.match(m.root.innerHTML, /<footer class="v6-shell-watermark has-status"><div id="v6EngineUsageSlot" class="v6-usage-slot"><button type="button" id="v6EngineUsageMeter"/);
    m.doc.getElementById('v6EngineUsageMeter').dispatch('click');
    assert.match(m.doc.getElementById('v6EngineUsageSlot').innerHTML, /aria-expanded="true"/);
    assert.doesNotMatch(m.doc.getElementById('v6EngineUsageSlot').innerHTML, /v6EngineUsagePopover"[^>]*hidden/);
  });

  it('Set records a valid % left through the page\'s action; a bad or empty value says why and calls nothing', async () => {
    const m = mountMeter();
    m.doc.getElementById('v6EngineUsageMeter').dispatch('click');
    m.doc.getElementById('v6UsageWeekly-codex').value = '150';
    m.doc.getElementById('v6UsageSave-codex').dispatch('click');
    assert.deepEqual(m.calls, []);
    assert.match(m.doc.getElementById('v6EngineUsageSlot').innerHTML, /Codex: enter a weekly or 5-hour % left between 0 and 100\./);
    m.doc.getElementById('v6UsageWeekly-codex').value = '';
    m.doc.getElementById('v6UsageFiveHour-codex').value = '';
    m.doc.getElementById('v6UsageSave-codex').dispatch('click');
    assert.deepEqual(m.calls, []);
    m.doc.getElementById('v6UsageWeekly-antigravity').value = '12';
    m.doc.getElementById('v6UsageFiveHour-antigravity').value = '';
    m.doc.getElementById('v6UsageSave-antigravity').dispatch('click');
    await new Promise((r) => setImmediate(r));
    // The empty 5-hour field is left out (undefined, which JSON shows as null).
    assert.deepEqual(plain(m.calls), [['antigravity', 12, null]]);
    assert.match(m.doc.getElementById('v6EngineUsageSlot').innerHTML, /Antigravity set\./);
  });

  it('a refresh keeps what the operator typed in the breakdown, and their focus; Escape closes it', () => {
    const m = mountMeter();
    // A redraw makes new elements, as a browser's would.
    const slot = withIdParsingInnerHTML(m.doc.getElementById('v6EngineUsageSlot'), m.doc);
    m.doc.getElementById('v6EngineUsageMeter').dispatch('click');
    m.doc.getElementById('v6UsageWeekly-codex').value = '17';
    m.doc.getElementById('v6UsageFiveHour-codex').focus();
    m.shell.setUsage({ windows: windows(), sessions: { sessions: [] } });
    assert.equal(m.doc.getElementById('v6UsageWeekly-codex').value, '17');
    assert.equal(m.doc.activeElement, m.doc.getElementById('v6UsageFiveHour-codex'));
    // Catch the keydown handler the next redraw gives the breakdown, to send it a real Escape.
    const keydowns = [];
    const realRegister = m.doc._register;
    m.doc._register = (el) => {
      if (el && el.id === 'v6EngineUsagePopover') {
        const add = el.addEventListener;
        el.addEventListener = (type, fn) => { if (type === 'keydown') keydowns.push(fn); return add.call(el, type, fn); };
      }
      return realRegister(el);
    };
    m.shell.setUsage({ windows: windows(), sessions: { sessions: [] } });
    assert.ok(keydowns.length >= 1);
    keydowns[keydowns.length - 1]({ key: 'Enter' });
    assert.match(slot.innerHTML, /aria-expanded="true"/, 'another key closes nothing');
    keydowns[keydowns.length - 1]({ key: 'Escape' });
    assert.match(slot.innerHTML, /aria-expanded="false"/);
    assert.equal(m.doc.activeElement, m.doc.getElementById('v6EngineUsageMeter'), 'focus goes back to the meter');
  });

  it('a refused calibration shows the server\'s reason', async () => {
    const m = mountMeter(() => ({ ok: false, error: 'Only the Operator or the Project Master may calibrate usage windows.' }));
    m.doc.getElementById('v6EngineUsageMeter').dispatch('click');
    m.doc.getElementById('v6UsageWeekly-claude').value = '50';
    m.doc.getElementById('v6UsageSave-claude').dispatch('click');
    await new Promise((r) => setImmediate(r));
    assert.match(m.doc.getElementById('v6EngineUsageSlot').innerHTML, /Claude not set: Only the Operator or the Project Master may calibrate usage windows\./);
  });

  it('the controller loads the meter on a route, posts a calibration with the operator proof, and refreshes every 15 chat reads', async () => {
    const calls = [];
    const mutations = [];
    let shell = null;
    const pending = [];
    const live = G.tcV6CreateLiveController({ getShell: () => shell,
      operatorHeaders: async () => ({ 'Content-Type': 'application/json', 'X-TC-Open-Token': 'tok' }),
      api: async (url, init) => {
        calls.push(url);
        // Restated by the cumulative review: the calibration carries the operator proof itself
        // (the page's apiMutate adds it to one config call only).
        if (url === '/api/usage/calibrate') { mutations.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) }); return { calibration: {} }; }
        if (url === '/api/projects') return { projects: [{ id: 12, name: 'P', engine: { id: 'claude' } }] };
        if (/\/status$/.test(url)) return { active: true, sessionId: 1 };
        if (url === '/api/usage/windows') return windows();
        if (url === '/api/usage/sessions') return { sessions: [] };
        if (/conversation\/events/.test(url)) return { events: [] };
        return null;
      },
      apiMutate: async () => { throw new Error('the calibration must not go through apiMutate'); },
      storage: null, setInterval: (fn) => { timers.push(fn); return timers.length - 1; }, clearInterval: () => {} });
    const timers = [];
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    shell = G.tcCreateV6Shell(doc, { root, window: makeFakeWindow('#/resources/12/conversation'), storage: null, onRender: (r) => pending.push(live.handleRoute(r)) });
    pending.push(live.handleRoute(shell.getRoute()));
    for (let i = 0; i < 3; i++) { while (pending.length) await pending.shift(); await new Promise((r) => setImmediate(r)); }
    assert.ok(calls.includes('/api/usage/windows') && calls.includes('/api/usage/sessions'));
    assert.match(root.innerHTML, /id="v6EngineUsageMeter"/);
    doc.getElementById('v6EngineUsageMeter').dispatch('click');
    doc.getElementById('v6UsageWeekly-codex').value = '0';
    doc.getElementById('v6UsageFiveHour-codex').value = '5';
    doc.getElementById('v6UsageSave-codex').dispatch('click');
    const loadsBefore = calls.filter((c) => c === '/api/usage/windows').length;
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(plain(mutations), [{ url: '/api/usage/calibrate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TC-Open-Token': 'tok' }, body: { provider: 'codex', weeklyPct: 0, fiveHourPct: 5 } }]);
    assert.equal(calls.filter((c) => c === '/api/usage/windows').length, loadsBefore + 1, 'the meter reloads after a calibration');
    const before = calls.filter((c) => c === '/api/usage/windows').length;
    const poll = timers[timers.length - 1];
    for (let i = 0; i < 14; i++) await poll();
    assert.equal(calls.filter((c) => c === '/api/usage/windows').length, before, 'not before the 15th read');
    await poll();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.filter((c) => c === '/api/usage/windows').length, before + 1);
  });

  it('styles the thresholds: green, amber, red and pulsing (not under reduced motion)', () => {
    const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(CSS, /\.v6-usage-pill\.is-green \.v6-usage-fill \{\s*background: #2ea043;/);
    assert.match(CSS, /\.v6-usage-pill\.is-amber \.v6-usage-fill \{\s*background: #d4a72c;/);
    assert.match(CSS, /\.v6-usage-pill\.is-red \.v6-usage-fill \{\s*background: #f85149;/);
    assert.match(CSS, /\.v6-usage-pill\.is-critical \{\s*animation: v6-usage-pulse/);
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\.v6-usage-pill\.is-critical \{\s*animation: none;/);
  });
});
