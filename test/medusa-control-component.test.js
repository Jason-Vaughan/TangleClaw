'use strict';

/**
 * #996 chunk 2 — the shared Medusa control, lifted out of `public/api-helper.js`
 * and RUN against the mini DOM (the lift-and-run convention of
 * `master-settings-mount.test.js`; a source probe proved a branch existed while
 * the real `api()` made it unreachable, #928 R-1).
 *
 * What is pinned:
 *   1. Parameterised by target: the same factory serves the session banner
 *      (unprefixed ids, `/api/sessions/:p/medusa`) and the Master bar
 *      (prefixed ids, `/api/master/medusa`) — and the two id sets cannot collide.
 *   2. Rendering from a status payload: state class, badge, label, first-render
 *      backlog seeding, and the inbound flow only on a rise.
 *   3. A receive-only participant (the Master at `read-only`) says so in its
 *      label and tooltip, with the server's reason — never a silent 403 later.
 *   4. Escaping of inbound text when the panel is built.
 *   5. `mount()` binds once, and the bar mounts it with the pending treatment gone.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const loadApiHelperGlobals = require('./_api-helper-globals');
const { makeDocument } = require('./_mini-dom');

const G = loadApiHelperGlobals();

/**
 * A document holding one control's elements for the given id set, plus a
 * recording `api` whose answers a test programs by path.
 * @param {object} ids - From `tcMedusaIds`.
 * @param {object} [answers] - path → payload (a function is called per request).
 * @returns {{doc: object, el: object, calls: Array<{url: string, opts: object}>, api: Function}}
 */
function world(ids, answers = {}) {
  const { doc, ids: el } = makeDocument(Object.values(ids).filter(Boolean));
  // The resting state the markup declares: control, badge, peers and panel all
  // start `hidden` (the mini DOM defaults every element to visible).
  for (const key of ['control', 'badge', 'peers', 'panel']) el[ids[key]].hidden = true;
  doc.addEventListener = (type, fn) => { (doc._listeners || (doc._listeners = {}))[type] = fn; };
  const calls = [];
  const api = async (url, opts) => {
    calls.push({ url, opts: opts || null });
    const a = answers[url.replace(/^.*\/medusa\//, '')];
    return typeof a === 'function' ? a() : (a === undefined ? null : a);
  };
  return { doc, el, calls, api };
}

describe('tcMedusaIds — one id scheme per host, no collisions', () => {
  it('the session keeps its historical unprefixed ids', () => {
    const ids = G.tcMedusaIds('');
    assert.equal(ids.control, 'medusaControl');
    assert.equal(ids.heads, 'medusaHeads');
    assert.equal(ids.panel, 'medusaPanel');
    assert.equal(ids.loop, 'medusaLoop');
  });
  it('a prefixed host gets prefixed ids and NO loop ids', () => {
    const ids = G.tcMedusaIds('masterDrawer');
    for (const v of Object.values(ids).filter(Boolean)) assert.ok(v.startsWith('masterDrawer'), v);
    assert.equal(ids.control, 'masterDrawerMedusa', 'the id the bar has always emitted');
    assert.equal(ids.loop, null);
    assert.equal(ids.loopsChip, null);
    assert.equal(ids.loopsPanel, null);
  });
  it('two hosts on one page share no id', () => {
    const a = new Set(Object.values(G.tcMedusaIds('')).filter(Boolean));
    const b = new Set(Object.values(G.tcMedusaIds('masterDrawer')).filter(Boolean));
    for (const id of b) assert.ok(!a.has(id), `${id} collides with the banner`);
  });
});

describe('tcMedusaControlMarkup', () => {
  it('renders the control hidden, with the real art and every element the component drives', () => {
    const ids = G.tcMedusaIds('masterPanel');
    const html = G.tcMedusaControlMarkup(ids);
    assert.match(html, new RegExp(`<span class="medusa-control is-off" id="${ids.control}" hidden>`));
    assert.match(html, /medusa-head--in[\s\S]*medusa-emblem[\s\S]*medusa-head--out/);
    for (const key of ['heads', 'badge', 'peers', 'panel', 'live']) {
      assert.match(html, new RegExp(`id="${ids[key]}"`), `${key} missing`);
    }
    assert.match(html, /aria-live="polite"/);
    assert.doesNotMatch(html, /master-bar-pending|aria-disabled/, 'a live control carries no pending treatment');
  });
});

describe('tcCreateMedusaControl — renders from a status payload', () => {
  it('reveals on first render, paints the state class, label, title and badge', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 2, workspaceId: 'p-1', lastError: null, loops: [], outbound: { allowed: true, reason: null } });
    assert.equal(w.el.medusaControl.hidden, false);
    assert.ok(w.el.medusaControl.classList.contains('is-listening'));
    assert.ok(!w.el.medusaControl.classList.contains('is-off'));
    assert.equal(w.el.medusaHeads.getAttribute('aria-pressed'), 'true');
    assert.match(w.el.medusaHeads.getAttribute('aria-label'), /on, listening, 2 unread/);
    assert.match(w.el.medusaHeads.title, /listening for messages/);
    assert.equal(w.el.medusaBadge.hidden, false);
    assert.equal(w.el.medusaBadge.textContent, '2');
  });

  it('does not announce a pre-existing backlog as new on first paint — and does announce a rise', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 3, workspaceId: 'p-1', lastError: null });
    assert.equal(w.el.medusaLive.textContent || '', '', 'backlog: nothing announced');
    assert.ok(!w.el.medusaControl.classList.contains('flow-in'));
    c.applyStatus({ state: 'listening', unread: 4, workspaceId: 'p-1', lastError: null });
    assert.equal(w.el.medusaLive.textContent, 'New Medusa message received');
    assert.ok(w.el.medusaControl.classList.contains('flow-in'));
  });

  it('a toggle response without loop fields leaves the last painted loops alone', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 0, loops: [{ id: 'l1', state: 'initiated' }], outbound: { allowed: true, reason: null } });
    c.applyStatus({ state: 'listening', unread: 0, workspaceId: 'p-1', lastError: null });
    assert.equal(c.state.loops.length, 1);
    assert.equal(c.state.outbound.allowed, true);
  });

  it('an error state names the error in the label and keeps the click meaning "disable"', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'error', unread: 0, lastError: 'ECONNREFUSED' });
    assert.ok(w.el.medusaControl.classList.contains('is-error'));
    assert.match(w.el.medusaHeads.getAttribute('aria-label'), /error — ECONNREFUSED.*Click to disable/);
  });

  it('drives the caller\'s own state object, so loop code reading it sees every update', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const shared = { state: 'off', unread: 0, prevUnread: 0, workspaceId: null, lastError: null, shown: false, loops: [], loopsError: null };
    const rendered = [];
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids, state: shared, hooks: { onRender: (m) => rendered.push(m.state) } });
    c.applyStatus({ state: 'connecting', unread: 0 });
    assert.equal(shared.state, 'connecting');
    assert.deepEqual(rendered, ['connecting'], 'the hook fires on each render with the state');
  });
});

describe('tcCreateMedusaControl — a receive-only participant says so (#996)', () => {
  it('the Master at read-only carries the refusal in its label and the server\'s reason in its title', () => {
    const ids = G.tcMedusaIds('masterPanel');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/master/medusa', ids, subject: 'the Master' });
    c.applyStatus({ state: 'listening', unread: 0, outbound: { allowed: false, reason: 'The Project Master is at access level "read-only", which can receive switchboard messages but not send them.' } });
    assert.match(w.el.masterPanelMedusaHeads.getAttribute('aria-label'), /receive-only at this access level/);
    assert.match(w.el.masterPanelMedusaHeads.title, /Sending is disabled: The Project Master is at access level "read-only"/);
  });

  it('a sending participant carries no such caveat', () => {
    const ids = G.tcMedusaIds('masterPanel');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/master/medusa', ids, subject: 'the Master' });
    c.applyStatus({ state: 'listening', unread: 0, outbound: { allowed: true, reason: null } });
    assert.doesNotMatch(w.el.masterPanelMedusaHeads.getAttribute('aria-label'), /receive-only/);
    assert.doesNotMatch(w.el.masterPanelMedusaHeads.title, /Sending is disabled/);
  });

  it('names its host in the off-state help — "the Master", not "this session"', () => {
    const ids = G.tcMedusaIds('masterPanel');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/master/medusa', ids, subject: 'the Master' });
    c.applyStatus({ state: 'off', unread: 0 });
    assert.match(w.el.masterPanelMedusaHeads.title, /Off — the Master can't send or receive/);
    assert.match(w.el.masterPanelMedusaHeads.title, /connect the Master/);
  });
});

describe('tcCreateMedusaControl — talks to ITS api base', () => {
  it('poll and toggle hit the participant\'s base, and toggle POSTs', async () => {
    const ids = G.tcMedusaIds('masterDrawer');
    const w = world(ids, { status: { state: 'off', unread: 0 }, toggle: { state: 'connecting', unread: 0, workspaceId: 'project-master-1' } });
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/master/medusa', ids });
    await c.poll();
    await c.toggle();
    assert.deepEqual(w.calls.map((x) => x.url), ['/api/master/medusa/status', '/api/master/medusa/toggle']);
    assert.equal(w.calls[1].opts.method, 'POST');
    assert.ok(w.el.masterDrawerMedusa.classList.contains('is-connecting'));
  });

  it('a failed fetch (null) changes nothing', async () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids, {});
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 1 });
    await c.poll();
    assert.equal(c.state.state, 'listening');
    assert.equal(c.state.unread, 1);
  });

  it('openInbox renders escaped messages newest-first, then marks read and clears the badge', async () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids, {
      messages: { messages: [{ from: 'a', message: 'first' }, { from: '<b>', message: '<script>x</script>' }] },
      read: { state: 'listening', unread: 0 }
    });
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 2 });
    await c.openInbox();
    const html = w.el.medusaPanel.innerHTML;
    assert.equal(w.el.medusaPanel.hidden, false);
    assert.ok(html.indexOf('&lt;script&gt;') >= 0 && html.indexOf('<script>') < 0, 'message body escaped');
    assert.ok(html.indexOf('&lt;b&gt;') >= 0, 'sender escaped');
    assert.ok(html.indexOf('&lt;b&gt;') < html.indexOf('>a<'), 'newest first');
    assert.match(html, /medusa-panel-close/);
    assert.equal(w.calls.at(-1).url, '/api/sessions/p/medusa/read');
    assert.equal(w.el.medusaBadge.hidden, true);
    await c.openInbox();
    assert.equal(w.el.medusaPanel.hidden, true, 'a second call toggles it closed');
  });

  it('uses the host\'s escaper when given one', async () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids, { messages: { messages: [{ from: 'x', message: 'y' }] }, read: { state: 'listening', unread: 0 } });
    const seen = [];
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids, esc: (s) => { seen.push(s); return String(s); } });
    await c.openInbox();
    assert.deepEqual(seen, ['x', 'y']);
  });
});

describe('tcCreateMedusaControl — mount', () => {
  it('binds heads, badge, panel, Escape and outside-click once; a second mount binds nothing more', () => {
    const ids = G.tcMedusaIds('masterPanel');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/master/medusa', ids });
    // Count bindings rather than trusting `mount()`'s return: the guard is on
    // BINDING, and a double bind is invisible to anything but the count.
    const bound = {};
    for (const key of ['heads', 'badge', 'panel']) {
      const node = w.el[ids[key]];
      const orig = node.addEventListener;
      node.addEventListener = (type, fn) => { bound[`${key}.${type}`] = (bound[`${key}.${type}`] || 0) + 1; orig.call(node, type, fn); };
    }
    assert.equal(c.mount(), true);
    assert.equal(c.mount(), true);
    assert.deepEqual(bound, { 'heads.click': 1, 'heads.mouseenter': 1, 'heads.mouseleave': 1, 'badge.click': 1, 'panel.click': 1 });
    assert.ok(w.doc._listeners.keydown, 'Escape bound on the document');
    assert.ok(w.doc._listeners.click, 'outside click bound on the document');
  });

  it('returns false when the control is not in the document', () => {
    const ids = G.tcMedusaIds('nowhere');
    const { doc } = makeDocument([]);
    const c = G.tcCreateMedusaControl({ doc, api: async () => null, apiBase: '/x', ids });
    assert.equal(c.mount(), false);
  });

  it('Escape closes an open panel; an outside click closes panel and peers', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.mount();
    w.el.medusaPanel.hidden = false;
    w.doc._listeners.keydown({ key: 'Escape' });
    assert.equal(w.el.medusaPanel.hidden, true);
    w.el.medusaPanel.hidden = false;
    w.el.medusaPeers.hidden = false;
    w.doc._listeners.click({ target: w.doc.body, composedPath: () => [w.doc.body] });
    assert.equal(w.el.medusaPanel.hidden, true);
    assert.equal(w.el.medusaPeers.hidden, true);
    // A click INSIDE the control leaves them be.
    w.el.medusaPanel.hidden = false;
    w.doc._listeners.click({ target: w.el.medusaHeads, composedPath: () => [w.el.medusaHeads, w.el.medusaControl] });
    assert.equal(w.el.medusaPanel.hidden, false);
  });
});

describe('the Master control bar mounts the shared control (#996)', () => {
  it('emits the control with prefixed ids, no pending treatment, and no reason element', () => {
    const html = G.tcMasterControlBarMarkup('masterDrawer');
    assert.match(html, /id="masterDrawerMedusa"/);
    assert.match(html, /id="masterDrawerMedusaHeads"/);
    assert.doesNotMatch(html, /masterDrawerMedusaWhy/);
    const control = html.slice(html.indexOf('id="masterDrawerMedusa"') - 60, html.indexOf('id="masterDrawerMedusa"'));
    assert.doesNotMatch(control, /master-bar-pending/);
  });

  it('setMedusa paints the control from the status payload; null leaves it untouched', () => {
    const ids = G.tcMedusaIds('masterPanel');
    const { doc, ids: el } = makeDocument([...Object.values(ids).filter(Boolean), 'masterPanelSettingsBtn', 'masterPanelBar']);
    doc.addEventListener = () => {};
    el.masterPanelMedusa.hidden = true;
    const bar = G.tcCreateMasterControlBar({ doc, rootId: 'masterPanelBar', prefix: 'masterPanel', api: async () => null, apiMutate: async () => null });
    bar.setMedusa({ state: 'listening', unread: 1, workspaceId: 'project-master-1', lastError: null, outbound: { allowed: true, reason: null } });
    assert.ok(el.masterPanelMedusa.classList.contains('is-listening'));
    assert.equal(el.masterPanelMedusaBadge.textContent, '1');
    bar.setMedusa(null);
    assert.ok(el.masterPanelMedusa.classList.contains('is-listening'), 'an unreadable status paints no false off');
  });

  it('loadAccess feeds the control from the ONE status fetch', async () => {
    const ids = G.tcMedusaIds('masterPanel');
    const { doc, ids: el } = makeDocument([...Object.values(ids).filter(Boolean), 'masterPanelSettingsBtn', 'masterPanelBar', 'masterPanelAccess']);
    doc.addEventListener = () => {};
    const urls = [];
    const api = async (url) => {
      urls.push(url);
      return url === '/api/master/status'
        ? { exists: true, settings: { accessLevel: 'write', enforcement: 'structural' }, medusa: { state: 'listening', unread: 0, outbound: { allowed: true, reason: null } } }
        : null;
    };
    const bar = G.tcCreateMasterControlBar({ doc, rootId: 'masterPanelBar', prefix: 'masterPanel', api, apiMutate: async () => null });
    await bar.loadAccess();
    assert.deepEqual(urls, ['/api/master/status'], 'no second request for the Medusa half');
    assert.ok(el.masterPanelMedusa.classList.contains('is-listening'));
  });
});
