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

  it('the toggle\'s own landing route hydrates a real member\'s conversation and attestation (PRR-B R1 HOLD)', async () => {
    const { live, win, root, calls, settle } = mountLive(baseMap());
    const hash = await live.enterHash();
    assert.equal(hash, '#/projects/tc-lane');
    win.location.hash = hash;
    await settle();
    assert.ok(calls.includes('/api/v6/projects/11/sessions/501/conversation/events'), JSON.stringify(calls));
    assert.ok(calls.includes('/api/v6/projects/11/sessions/501/attestations'));
    assert.match(root.innerHTML, /ship it/);
    assert.match(root.innerHTML, /\/session\.html\?project=TC-Lane-B/);
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
    assert.match(root.innerHTML, /\/session\.html\?project=TangleClaw/);
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

  it('Collapse all folds every project and fleet; Expand all unfolds them', () => {
    const storage = makeStorage();
    const { doc, root } = mountShell({ tree: TWO_GROUP_TREE, storage });
    doc.getElementById('v6TreeCollapseAll').dispatch('click');
    assert.doesNotMatch(root.innerHTML, /Fleet<\/a>/);
    assert.deepEqual(JSON.parse(storage.data.tc_v6_collapsed_nodes).sort(),
      ['f:medusa/medusa', 'f:tc-lane/tc-lane', 'p:medusa', 'p:tc-lane']);
    doc.getElementById('v6TreeExpandAll').dispatch('click');
    assert.match(root.innerHTML, /TC-Lane Fleet/);
    assert.match(root.innerHTML, /Medusa-PM \(21\)/);
    assert.deepEqual(JSON.parse(storage.data.tc_v6_collapsed_nodes), []);
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

  it('renders search, engine (one option per engine in use), one pill per logical project, Multi and All', () => {
    const { root } = mountWithProjects();
    assert.match(root.innerHTML, /id="v6FilterSearch"/);
    assert.match(root.innerHTML, /<option value="">All Engines<\/option><option value="claude">claude<\/option><option value="codex">codex<\/option>/);
    assert.match(root.innerHTML, /id="v6GroupPill-0"[^>]*>TC-Lane</);
    assert.match(root.innerHTML, /id="v6GroupPill-1"[^>]*>Medusa</);
    assert.match(root.innerHTML, /id="v6FilterMulti"[^>]*data-action="toggle-multi-filter"[^>]*aria-pressed="false"/);
    assert.match(root.innerHTML, /id="v6FilterAll"[^>]*aria-pressed="true"/);
  });

  it('typing in search filters the tree immediately and keeps focus in the box', () => {
    const { doc, root } = mountWithProjects();
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
    const select = doc.getElementById('v6FilterEngine');
    select.value = 'codex';
    select.dispatch('change');
    assert.match(root.innerHTML, /TC-Lane-PM \(12\)/);
    assert.doesNotMatch(root.innerHTML, /TC-Lane-A \(11\)/);
    assert.match(root.innerHTML, /<option value="codex" selected>/);
  });

  it('single mode: a pill shows only its project, a second pill replaces it, re-clicking the only one clears it', () => {
    const storage = makeStorage();
    const { doc, root } = mountWithProjects({ storage });
    doc.getElementById('v6GroupPill-1').dispatch('click');
    assert.doesNotMatch(root.innerHTML, /TC-Lane Fleet/);
    assert.match(root.innerHTML, /id="v6GroupPill-1"[^>]*aria-pressed="true"/);
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), ['medusa']);
    doc.getElementById('v6GroupPill-0').dispatch('click');
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), ['tc-lane']);
    doc.getElementById('v6GroupPill-0').dispatch('click');
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), []);
    assert.match(root.innerHTML, /Medusa Fleet/);
  });

  it('Multi mode: pills add to and remove from the selection, and the mode is remembered', () => {
    const storage = makeStorage();
    const { doc, root } = mountWithProjects({ storage });
    doc.getElementById('v6FilterMulti').dispatch('click');
    assert.equal(storage.data.tc_v6_filter_multi_mode, 'true');
    assert.match(root.innerHTML, /id="v6FilterMulti"[^>]*aria-pressed="true"/);
    doc.getElementById('v6GroupPill-0').dispatch('click');
    doc.getElementById('v6GroupPill-1').dispatch('click');
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), ['tc-lane', 'medusa']);
    doc.getElementById('v6GroupPill-0').dispatch('click');
    assert.deepEqual(JSON.parse(storage.data.tc_v6_selected_groups), ['medusa']);
  });

  it('a Ctrl/Cmd/Shift-click adds to the selection even in single mode', () => {
    const { shell, root } = mountWithProjects();
    shell.selectGroup('tc-lane', false);
    shell.selectGroup('medusa', true);
    assert.match(root.innerHTML, /TC-Lane Fleet/);
    assert.match(root.innerHTML, /Medusa Fleet/);
    assert.match(root.innerHTML, /id="v6FilterAll"[^>]*aria-pressed="false"/);
  });

  it('All clears the selection', () => {
    const storage = makeStorage({ tc_v6_selected_groups: JSON.stringify(['medusa']) });
    const { doc, root } = mountWithProjects({ storage });
    assert.doesNotMatch(root.innerHTML, /TC-Lane Fleet/, 'a remembered selection is restored on mount');
    doc.getElementById('v6FilterAll').dispatch('click');
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
    assert.match(html, /Talking to: <strong>TC-Lane-PM<\/strong> \(#1592\)/);
    assert.match(html, /Designated Project Delegate/);
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
    assert.match(html, /<a id="v6ChatToDelegate"[^>]*href="#\/projects\/tc-lane"[^>]*>Switch to Delegate: TC-Lane-PM<\/a>/);
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
    assert.match(m.root.innerHTML, /Talking to: <strong>TC-Lane-PM<\/strong> \(#1592\)/);
    assert.match(m.root.innerHTML, /pm line 1/);
    assert.match(m.root.innerHTML, /earlier/);
  });

  it('a remembered delegate is used', async () => {
    const m = mountChat({ storage: makeStorage({ tc_v6_project_delegates: JSON.stringify({ 'tc-lane': '10' }) }) });
    await m.settle();
    assert.match(m.root.innerHTML, /Talking to: <strong>TC-Lane-A<\/strong> \(#1660\)/);
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
    assert.match(m.root.innerHTML, /Talking to: <strong>TC-Lane-A<\/strong>/);
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
    assert.equal(m.timers.length, 0, 'nothing to poll');
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
    assert.match(m.root.innerHTML, /Talking to: <strong>TC-Lane-A<\/strong>/);
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*><\/textarea>/, 'the other chat starts empty');
    m.win.location.hash = '#/projects/tc-lane';
    await m.settle();
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*>for the PM only<\/textarea>/, 'the draft is still there on return');
  });

  it('a second Enter or Send while the first is still sending is ignored, and the composer is disabled meanwhile', async () => {
    const m = mountPair({ hold: true });
    await m.settle();
    const input = m.doc.getElementById('v6ChatInput');
    input.value = 'once';
    input.dispatch('input');
    m.doc.getElementById('v6ChatForm').dispatch('submit');
    await new Promise((r) => setImmediate(r));
    assert.match(m.root.innerHTML, /<textarea id="v6ChatInput"[^>]*disabled/);
    assert.match(m.root.innerHTML, /<button type="submit"[^>]*disabled/);
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
