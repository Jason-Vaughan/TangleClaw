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
    assert.match(html, /href="\/session\.html\?project=TiLT%20v2"/);
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

  it('renders a "← Classic View" link back to #/', () => {
    const { root } = mount();
    assert.match(root.innerHTML, /id="v6ShellClassicLink"[^>]*href="#\/"[^>]*>← Classic View</);
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
    { id: 11, name: 'TC-Lane-B', model: 'claude-opus-5-5', engine: { id: 'claude', name: 'Claude Code' } },
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
    assert.match(root.innerHTML, /\/session\.html\?project=TC-Lane-B/);
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

  it('puts #v6ViewToggleBtn in .toolbar-right beside #newBtn', () => {
    const toolbar = HTML.slice(HTML.indexOf('<div class="toolbar-right">'), HTML.indexOf('id="newBtn"'));
    assert.match(toolbar, /<button type="button" class="btn btn-secondary" id="v6ViewToggleBtn" aria-label="Switch between Fleet Shell \(v6\) and Classic View">Fleet Shell \(v6\)<\/button>/);
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
