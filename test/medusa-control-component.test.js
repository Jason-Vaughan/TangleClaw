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
  it('a prefixed host gets prefixed ids, including real loop ids (#1083)', () => {
    const ids = G.tcMedusaIds('masterDrawer');
    for (const v of Object.values(ids).filter(Boolean)) assert.ok(v.startsWith('masterDrawer'), v);
    assert.equal(ids.control, 'masterDrawerMedusa', 'the id the bar has always emitted');
    // #1083: the Master bar now mounts the loop UI too (`tcCreateMedusaLoops`),
    // so these three — null before this car, per #996's own deferral comment —
    // are real, collision-safe ids like every other field here.
    assert.equal(ids.loop, 'masterDrawerMedusaLoop');
    assert.equal(ids.loopsChip, 'masterDrawerMedusaLoopsChip');
    assert.equal(ids.loopsPanel, 'masterDrawerMedusaLoopsPanel');
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

  it('a connecting state is no longer silent when a preflight verdict came with it (#1130)', () => {
    // `connecting` was the state that said NOTHING — "Connecting to the message
    // bridge…" and no more, which is exactly the reported "green toggle plus an
    // endless generic reconnect loop". The preflight's verdict now lands there.
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({
      state: 'connecting', unread: 0,
      bridge: { healthy: false, code: 'BRIDGE_ABSENT', detail: 'Nothing answered at http://localhost:3009', hint: 'Install the Bridge' }
    });
    const label = w.el.medusaHeads.getAttribute('aria-label');
    assert.match(label, /Nothing answered/);
    assert.match(label, /Install the Bridge/);
  });

  it('an error with a classified code explains what the code MEANS, not just the raw sentence', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({
      state: 'error', unread: 0,
      lastError: 'Bridge did not complete the register handshake within 10000ms',
      lastErrorCode: 'HANDSHAKE_TIMEOUT'
    });
    const label = w.el.medusaHeads.getAttribute('aria-label');
    assert.match(label, /never completed registration/);
  });

  it('prefers the preflight verdict over the listener code — it probed both transports', () => {
    // The listener only ever tried the WebSocket, so it cannot establish anything
    // about the Bridge AS A WHOLE. The preflight can, so it wins.
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({
      state: 'error', unread: 0, lastError: 'Socket error: refused', lastErrorCode: 'CONNECT_FAILED',
      bridge: { healthy: false, code: 'BRIDGE_ABSENT', detail: 'Nothing answered anywhere', hint: 'Install it' }
    });
    const label = w.el.medusaHeads.getAttribute('aria-label');
    assert.match(label, /Nothing answered anywhere/);
    assert.doesNotMatch(label, /probably not running/, 'the listener-code prose must not also appear');
  });

  it('a preflight verdict is dropped once the listener proves the Bridge is there', () => {
    // The verdict is evidence with a shelf life, and diagnosis() prefers it over
    // the live code — so without this a disproven "install the Bridge" would
    // resurface hours later, on a session that is demonstrably connected.
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({
      state: 'connecting', unread: 0,
      bridge: { healthy: false, code: 'BRIDGE_ABSENT', detail: 'Nothing answered', hint: 'Install the Bridge' }
    });
    assert.match(w.el.medusaHeads.getAttribute('aria-label'), /Install the Bridge/);
    c.applyStatus({ state: 'listening', unread: 0 });
    assert.equal(c.state.bridge, null, 'a connected listener disproves an absent-Bridge verdict');
    assert.doesNotMatch(w.el.medusaHeads.getAttribute('aria-label'), /Install the Bridge/);
  });

  it('a healthy preflight adds nothing — no noise on the happy path', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 0, bridge: { healthy: true, detail: 'all good' } });
    assert.doesNotMatch(w.el.medusaHeads.getAttribute('aria-label'), /all good/);
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

  // #1009 — the Bridge's own version/update-status, from `getStatus()`'s
  // cached reading (never this control's own fetch).
  it('shows the Bridge version and updater status in the tooltip and as data attributes', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 0, bridgeVersion: '1.0.0-rc2', bridgeUpdaterStatus: 'up-to-date' });
    assert.match(w.el.medusaHeads.title, /Medusa Bridge v1\.0\.0-rc2 \(up-to-date\)\./);
    assert.equal(w.el.medusaHeads.getAttribute('data-medusa-bridge-version'), '1.0.0-rc2');
    assert.equal(w.el.medusaHeads.getAttribute('data-medusa-bridge-updater-status'), 'up-to-date');
  });

  it('renders the version alone when no updater status is known', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 0, bridgeVersion: '1.0.0-rc2' });
    assert.match(w.el.medusaHeads.title, /Medusa Bridge v1\.0\.0-rc2\./);
    assert.doesNotMatch(w.el.medusaHeads.title, /v1\.0\.0-rc2 \(/, 'no parenthetical when there is no updater status');
  });

  it('adds nothing when the Bridge version has never been measured', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'off', unread: 0 });
    assert.doesNotMatch(w.el.medusaHeads.title, /Medusa Bridge v/);
    assert.equal(w.el.medusaHeads.getAttribute('data-medusa-bridge-version'), '');
    assert.equal(w.el.medusaHeads.getAttribute('data-medusa-bridge-updater-status'), '');
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

  it('openInbox renders escaped messages newest-first, and toggles closed', async () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids, {
      messages: { messages: [{ from: 'a', message: 'first' }, { from: '<b>', message: '<script>x</script>' }] }
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
    await c.openInbox();
    assert.equal(w.el.medusaPanel.hidden, true, 'a second call toggles it closed');
  });

  // #1987 (Architect ruling, option B): opening the panel is a pure observation.
  // Acknowledging by id closed normal exchanges and removed the agent's mail
  // before it saw it; even the bodyless badge clear zeroes `unread`, which the
  // wake monitor reads as "inbox read" and so cancels the agent's nudge. The
  // badge therefore means "the agent has not handled this" and viewing leaves it.
  it('openInbox makes no /read call of either form: displaying mail never speaks for the agent (#1987)', async () => {
    const ids = G.tcMedusaIds('');
    for (const messages of [
      [{ id: 'm1', from: 'a', message: 'first' }, { id: 'm2', from: 'b', message: 'second' }],
      [{ from: 'a', message: 'no id' }],
      []
    ]) {
      const w = world(ids, { messages: { messages } });
      const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
      await c.openInbox();
      assert.deepEqual(w.calls.map((call) => call.url), ['/api/sessions/p/medusa/messages'],
        `only the GET, for ${messages.length} message(s)`);
      assert.ok(!w.calls.some((call) => call.opts && call.opts.method === 'POST'), 'nothing is posted');
    }
  });

  it('openInbox leaves the unread badge as the agent left it, and a later arrival still shows (#1987)', async () => {
    const ids = G.tcMedusaIds('');
    // `read` answers as the server would (unread zeroed), so a regression that
    // posts either form is caught here as well as in the call-log test above.
    const w = world(ids, { messages: { messages: [{ id: 'm1', from: 'a', message: 'first' }] }, read: { state: 'listening', unread: 0 } });
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 1 });
    await c.openInbox();
    assert.equal(c.state.unread, 1, 'viewing does not clear the count');
    assert.equal(w.el.medusaBadge.hidden, false, 'the badge still says the agent has mail');
    c.applyStatus({ state: 'listening', unread: 2 });
    assert.equal(c.state.unread, 2, 'a post-fetch arrival is counted, not hidden');
    assert.equal(w.el.medusaBadge.hidden, false);
  });

  it('stays hidden when the project has not opted in (#820)', async () => {
    // The flag used to gate only the AUTOSTART, so the control appeared on every
    // session page rendering `is-off` — and one click on it started the listener.
    // A feature the operator has not turned on must not be one idle click away.
    const ids = G.tcMedusaIds('');
    const w = world(ids, {});
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'off', unread: 0, enabled: false });
    assert.equal(w.el.medusaControl.hidden, true);
  });

  it('shows once the project opts in', async () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids, {});
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'off', unread: 0, enabled: false });
    assert.equal(w.el.medusaControl.hidden, true);
    c.applyStatus({ state: 'listening', unread: 0, enabled: true });
    assert.equal(w.el.medusaControl.hidden, false);
  });

  it('does not hide on a payload that carries no gate at all', async () => {
    // Strictly `=== false`, never falsy: an absent `enabled` means the gate was
    // not computed (a toggle response carries none), and hiding a control
    // because a field is missing is its own dishonesty.
    const ids = G.tcMedusaIds('');
    const w = world(ids, {});
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 0, enabled: true });
    c.applyStatus({ state: 'listening', unread: 1 });
    assert.equal(w.el.medusaControl.hidden, false);
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

describe('tcFetchMedusaExchanges (#2137 V5560-W1-A client support)', () => {
  it('requests the plain exchanges endpoint with no role by default', async () => {
    const calls = [];
    const api = async (url) => { calls.push(url); return { exchanges: [] }; };
    await G.tcFetchMedusaExchanges(api, '/api/sessions/p/medusa');
    assert.deepEqual(calls, ['/api/sessions/p/medusa/exchanges']);
  });

  it('forwards an explicit role as a query param', async () => {
    const calls = [];
    const api = async (url) => { calls.push(url); return { exchanges: [] }; };
    await G.tcFetchMedusaExchanges(api, '/api/sessions/p/medusa', { role: 'recipient' });
    assert.deepEqual(calls, ['/api/sessions/p/medusa/exchanges?role=recipient']);
  });

  it('returns null, like every other api() caller, when the request fails', async () => {
    const result = await G.tcFetchMedusaExchanges(async () => null, '/api/master/medusa', { role: 'all' });
    assert.equal(result, null);
  });
});

// INTV-V5540-01 — require confirmation before a toggle-off would silence a
// session that has unread mail (a toggle-ON, or an off session with nothing
// unread, needs none: there is nothing a confirm here would be protecting).
describe('tcCreateMedusaControl — toggle-off guard on unread mail (INTV-V5540-01)', () => {
  it('confirms before turning off while unread mail is pending, and proceeds on yes', async () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids, { toggle: { state: 'off', unread: 3 } });
    const asked = [];
    const c = G.tcCreateMedusaControl({
      doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids,
      confirm: (msg) => { asked.push(msg); return true; }
    });
    c.applyStatus({ state: 'listening', unread: 3 });
    await c.toggle();
    assert.equal(asked.length, 1);
    assert.match(asked[0], /3 messages are unread/);
    assert.deepEqual(w.calls.map((x) => x.url), ['/api/sessions/p/medusa/toggle'], 'the toggle still ran');
    assert.equal(c.state.state, 'off');
  });

  it('declining the confirm leaves the listener untouched — no API call at all', async () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids, { toggle: { state: 'off', unread: 3 } });
    const c = G.tcCreateMedusaControl({
      doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids,
      confirm: () => false
    });
    c.applyStatus({ state: 'listening', unread: 3 });
    await c.toggle();
    assert.deepEqual(w.calls, [], 'declined: the toggle never ran');
    assert.equal(c.state.state, 'listening', 'state is exactly as it was');
  });

  it('no confirm available means no silent toggle-off — fails CLOSED, not open', async () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids, { toggle: { state: 'off', unread: 3 } });
    // No `confirm` in deps, and no `global.confirm` either — the sandbox this
    // suite shares carries none. The naive `typeof ask === 'function' && !ask(...)`
    // spelling would evaluate false here and let the toggle proceed unconfirmed;
    // this pins that it does not.
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 3 });
    await c.toggle();
    assert.deepEqual(w.calls, [], 'no way to confirm: refused, not allowed through');
    assert.equal(c.state.state, 'listening');
  });

  it('needs no confirm to turn OFF with nothing unread, or to turn ON', async () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids, { toggle: { state: 'listening', unread: 0 } });
    const asked = [];
    const c = G.tcCreateMedusaControl({
      doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids,
      confirm: (msg) => { asked.push(msg); return true; }
    });
    // Off → on: nothing to protect.
    c.applyStatus({ state: 'off', unread: 0 });
    await c.toggle();
    // On, nothing unread → off: also nothing to protect.
    c.applyStatus({ state: 'listening', unread: 0 });
    await c.toggle();
    assert.deepEqual(asked, [], 'never asked — no unread mail was ever at risk');
    assert.equal(w.calls.length, 2, 'both toggles still went through');
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
    assert.deepEqual(bound, {
      'heads.click': 1, 'heads.mouseenter': 1, 'heads.mouseleave': 1, 'badge.click': 1,
      // #1576: panel.click now also routes a nickname-compose Send click;
      // panel.keydown is new — Enter sends from the compose input.
      'panel.click': 1, 'panel.keydown': 1
    });
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

/*
 * #1576 — Team Chat `@nickname` routing, directly on the shared
 * `tcCreateMedusaControl` component (Ruling A505-R2.4/R2.6: the shared UI
 * surface, not a separate "Team Chat UI" that does not exist anywhere in
 * this repo — see this car's PR body for that verification).
 */
describe('tcParseMedusaNicknameTags — pure tag parsing + roster resolution (#1576)', () => {
  const ROSTER = [
    { id: 'tc-lane-arc-4041e89e', name: 'TC-Lane-Arc', connected: true },
    { id: 'tc-lane-pm-9d85f3aa', name: 'TC-Lane-PM', connected: true },
    { id: 'tc-lane-prr-a-11112222', name: 'TC-Lane-PRR-A', connected: false }
  ];

  // `G.tcParseMedusaNicknameTags` runs in the lifted sandbox (a separate vm
  // realm): its own plain objects/arrays are not reference-equal to this
  // file's, so `assert.deepEqual` reports a false mismatch ("same structure
  // but not reference-equal") unless both sides are normalised through
  // JSON first — the same cross-realm fix `message-size-ui.test.js` already
  // uses for a lifted function's own object/array results.
  const plain = (v) => JSON.parse(JSON.stringify(v));

  it('resolves a tag against the short tc-lane- alias, case-insensitively', () => {
    const r = G.tcParseMedusaNicknameTags('@ARC please review', ROSTER);
    assert.deepEqual(plain(r.recipients), [{ tag: 'ARC', workspaceId: 'tc-lane-arc-4041e89e', name: 'TC-Lane-Arc' }]);
    assert.deepEqual(plain(r.unresolved), []);
    assert.equal(r.body, '@ARC please review');
  });

  it('resolves a multi-hyphen alias (prr-a) without splitting on every hyphen', () => {
    const r = G.tcParseMedusaNicknameTags('@prr-a take a look', ROSTER);
    assert.deepEqual(plain(r.recipients), [{ tag: 'prr-a', workspaceId: 'tc-lane-prr-a-11112222', name: 'TC-Lane-PRR-A' }]);
  });

  it('resolves against the full workspaceId or the display name too', () => {
    assert.equal(G.tcParseMedusaNicknameTags('@tc-lane-pm-9d85f3aa hi', ROSTER).recipients[0].workspaceId, 'tc-lane-pm-9d85f3aa');
    assert.equal(G.tcParseMedusaNicknameTags('@TC-Lane-PM hi', ROSTER).recipients[0].workspaceId, 'tc-lane-pm-9d85f3aa');
  });

  it('skips an email-like @ (preceded by a local-part character) — never a tag', () => {
    const r = G.tcParseMedusaNicknameTags('contact arc@example.com for details', ROSTER);
    assert.equal(r.recipients.length, 0);
    assert.equal(r.unresolved.length, 0);
  });

  it('reports an unmatched tag as unresolved, never silently dropped', () => {
    const r = G.tcParseMedusaNicknameTags('@ghost are you there', ROSTER);
    assert.deepEqual(plain(r.unresolved), ['ghost']);
    assert.equal(r.recipients.length, 0);
  });

  it('a message with no @tag at all resolves to zero recipients (not an error here — the caller decides)', () => {
    const r = G.tcParseMedusaNicknameTags('no tag in this one', ROSTER);
    assert.equal(r.recipients.length, 0);
    assert.equal(r.unresolved.length, 0);
  });

  it('dedupes a repeated tag, and two tags resolving to the same workspace, into one recipient', () => {
    const r = G.tcParseMedusaNicknameTags('@arc @ARC @tc-lane-arc-4041e89e please', ROSTER);
    assert.equal(r.recipients.length, 1);
    assert.equal(r.recipients[0].workspaceId, 'tc-lane-arc-4041e89e');
  });

  it('resolves more than one distinct tag in one message', () => {
    const r = G.tcParseMedusaNicknameTags('@arc @pm both please look', ROSTER);
    assert.deepEqual(plain(r.recipients.map((x) => x.workspaceId).sort()), ['tc-lane-arc-4041e89e', 'tc-lane-pm-9d85f3aa']);
  });
});

describe('tcCreateMedusaControl#sendTaggedMessage — the impure half (#1576)', () => {
  const ROSTER = [{ id: 'tc-lane-arc-4041e89e', name: 'TC-Lane-Arc', connected: true }];

  /**
   * A control plus recording `api`/`apiMutate`, programmed by path.
   * @param {object} [opts]
   * @returns {{c: object, apiCalls: object[], mutateCalls: object[]}}
   */
  function control(opts = {}) {
    const ids = G.tcMedusaIds('');
    const { doc } = makeDocument(Object.values(ids).filter(Boolean));
    const apiCalls = [];
    const api = async (url) => {
      apiCalls.push(url);
      if (url.endsWith('/roster')) return opts.rosterAnswer !== undefined ? opts.rosterAnswer : { workspaces: ROSTER };
      return null;
    };
    api.lastError = opts.lastError || null;
    const mutateCalls = [];
    const apiMutate = async (url, method, body) => {
      mutateCalls.push({ url, method, body });
      const key = body && body.to;
      const answers = opts.sendAnswers || {};
      const a = answers[key];
      return typeof a === 'function' ? a() : (a === undefined ? { status: 'received' } : a);
    };
    // A live, listening participant by default — the realistic case for
    // exercising the send path. `tcCreateMedusaControl` itself defaults an
    // unset `state` to 'off' (the off-state refusal test below passes its
    // own `state: 'off'` to exercise that path deliberately).
    const state = Object.assign({ state: 'listening' }, opts.state);
    const c = G.tcCreateMedusaControl({ doc, api, apiMutate, apiBase: '/api/sessions/p/medusa', ids, state });
    return { c, apiCalls, mutateCalls };
  }

  it('refuses MEDUSA_SEND_BLOCKED before ever reading the roster — a read-only Master may not', async () => {
    const { c, apiCalls } = control({ state: { outbound: { allowed: false, reason: 'read-only access level' } } });
    const r = await c.sendTaggedMessage('@arc hi');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEDUSA_SEND_BLOCKED');
    assert.equal(r.reason, 'read-only access level');
    assert.equal(apiCalls.length, 0);
  });

  it('refuses MEDUSA_SEND_BLOCKED while the listener is off — lib/medusa.js#sendMessage would '
    + 'otherwise throw NOT_LISTENING (409); refused here instead of promising a send that cannot succeed', async () => {
    const { c, apiCalls } = control({ state: { state: 'off' } });
    const r = await c.sendTaggedMessage('@arc hi');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEDUSA_SEND_BLOCKED');
    assert.equal(apiCalls.length, 0);
  });

  it('refuses MEDUSA_ROSTER_FAILED when the roster fetch fails', async () => {
    const { c, mutateCalls } = control({ rosterAnswer: null });
    const r = await c.sendTaggedMessage('@arc hi');
    assert.equal(r.code, 'MEDUSA_ROSTER_FAILED');
    assert.equal(mutateCalls.length, 0);
  });

  it('refuses MEDUSA_NICKNAME_UNRESOLVED and sends nothing, for an unmatched tag', async () => {
    const { c, mutateCalls } = control();
    const r = await c.sendTaggedMessage('@ghost hi');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEDUSA_NICKNAME_UNRESOLVED');
    assert.deepEqual(JSON.parse(JSON.stringify(r.unresolved)), ['ghost']);
    assert.equal(mutateCalls.length, 0);
  });

  it('refuses MEDUSA_NICKNAME_REQUIRED for a message with no @tag at all', async () => {
    const { c, mutateCalls } = control();
    const r = await c.sendTaggedMessage('no tag here');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEDUSA_NICKNAME_REQUIRED');
    assert.equal(mutateCalls.length, 0);
  });

  it('sends to the resolved recipient, preserving the @tag text in the body (Discord-style, not stripped)', async () => {
    const { c, mutateCalls } = control();
    const r = await c.sendTaggedMessage('@arc please review this');
    assert.equal(r.ok, true);
    assert.equal(mutateCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(mutateCalls[0])), {
      url: '/api/sessions/p/medusa/send', method: 'POST',
      body: { to: 'tc-lane-arc-4041e89e', message: '@arc please review this' }
    });
  });

  it('reports a per-recipient failure without aborting the others, and ok:false overall', async () => {
    const roster = [
      { id: 'tc-lane-arc-4041e89e', name: 'Arc' },
      { id: 'tc-lane-pm-9d85f3aa', name: 'PM' }
    ];
    const { c, mutateCalls } = control({
      rosterAnswer: { workspaces: roster },
      sendAnswers: { 'tc-lane-arc-4041e89e': { status: 'received' }, 'tc-lane-pm-9d85f3aa': null }
    });
    const r = await c.sendTaggedMessage('@arc @pm both please');
    assert.equal(r.ok, false, 'one recipient failed, so the aggregate is honest about it');
    assert.equal(mutateCalls.length, 2, 'the failure never aborted the other send');
    const okCount = r.results.filter((x) => x.ok).length;
    assert.equal(okCount, 1);
  });
});

describe('renderMessages — the nickname-compose row is gated on sendBlocked (#1576)', () => {
  it('is present when sending is allowed (listening, no access-level block)', () => {
    const ids = G.tcMedusaIds('');
    const { doc } = makeDocument(Object.values(ids).filter(Boolean));
    const c = G.tcCreateMedusaControl({ doc, api: async () => null, apiBase: '/api/sessions/p/medusa', ids, state: { state: 'listening' } });
    assert.match(c.renderMessages([]), /medusa-nickname-compose/);
  });

  it('is absent for a read-only Master (outbound.allowed === false) — it would deterministically 403', () => {
    const ids = G.tcMedusaIds('masterDrawer');
    const { doc } = makeDocument(Object.values(ids).filter(Boolean));
    const c = G.tcCreateMedusaControl({
      doc, api: async () => null, apiBase: '/api/master/medusa', ids,
      state: { state: 'listening', outbound: { allowed: false, reason: 'read-only' } }
    });
    assert.doesNotMatch(c.renderMessages([]), /medusa-nickname-compose/);
  });

  it('is absent while the listener is off — lib/medusa.js#sendMessage throws NOT_LISTENING (409) '
    + 'for exactly this case, so offering the row would promise a send that deterministically fails', () => {
    const ids = G.tcMedusaIds('');
    const { doc } = makeDocument(Object.values(ids).filter(Boolean));
    const c = G.tcCreateMedusaControl({ doc, api: async () => null, apiBase: '/api/sessions/p/medusa', ids, state: { state: 'off' } });
    assert.doesNotMatch(c.renderMessages([]), /medusa-nickname-compose/);
  });
});

describe('render — the badge stays reachable at zero unread so the @nickname composer can be opened (#1576 I-Gate Round 2 C1)', () => {
  it('shows an "@" opener at zero unread when listening and not access-blocked', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 0 });
    assert.equal(w.el.medusaBadge.hidden, false, 'zero unread must not make the composer unreachable');
    assert.equal(w.el.medusaBadge.textContent, '@');
    assert.match(w.el.medusaBadge.getAttribute('aria-label'), /tagged message/);
  });

  it('a real unread count still wins over the opener label', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 3 });
    assert.equal(w.el.medusaBadge.hidden, false);
    assert.equal(w.el.medusaBadge.textContent, '3');
  });

  it('stays hidden at zero unread while the listener is off — nothing to truthfully open yet', () => {
    const ids = G.tcMedusaIds('');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'off', unread: 0 });
    assert.equal(w.el.medusaBadge.hidden, true);
  });

  it('stays hidden at zero unread for a read-only Master — the compose row it would open is hidden too', () => {
    const ids = G.tcMedusaIds('masterDrawer');
    const w = world(ids);
    const c = G.tcCreateMedusaControl({ doc: w.doc, api: w.api, apiBase: '/api/master/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 0, outbound: { allowed: false, reason: 'read-only' } });
    assert.equal(w.el.masterDrawerMedusaBadge.hidden, true);
  });
});

describe('tcParseMedusaNicknameTags / sendTaggedMessage — ambiguous nickname refused, not guessed (#1576 I-Gate Round 2 C2)', () => {
  const AMBIGUOUS_ROSTER = [
    { id: 'tc-lane-arc-11111111', name: 'TC-Lane-Arc (old, offline)', connected: false },
    { id: 'tc-lane-arc-22222222', name: 'TC-Lane-Arc', connected: true }
  ];

  it('tcParseMedusaNicknameTags reports an alias matching two roster entries as ambiguous, not the first', () => {
    const r = G.tcParseMedusaNicknameTags('@arc hi', AMBIGUOUS_ROSTER);
    assert.equal(r.recipients.length, 0, 'never silently picks one');
    assert.equal(r.ambiguous.length, 1);
    assert.equal(r.ambiguous[0].tag, 'arc');
    assert.deepEqual(JSON.parse(JSON.stringify(r.ambiguous[0].candidates)).sort(),
      ['tc-lane-arc-11111111', 'tc-lane-arc-22222222']);
  });

  it('an exact, full workspaceId is authoritative even when its alias also matches another entry', () => {
    const r = G.tcParseMedusaNicknameTags('@tc-lane-arc-22222222 hi', AMBIGUOUS_ROSTER);
    assert.equal(r.ambiguous.length, 0);
    assert.equal(r.recipients.length, 1);
    assert.equal(r.recipients[0].workspaceId, 'tc-lane-arc-22222222');
  });

  it('sendTaggedMessage refuses MEDUSA_NICKNAME_AMBIGUOUS before sending anything', async () => {
    const ids = G.tcMedusaIds('');
    const { doc } = makeDocument(Object.values(ids).filter(Boolean));
    const mutateCalls = [];
    const c = G.tcCreateMedusaControl({
      doc, api: async (url) => (url.endsWith('/roster') ? { workspaces: AMBIGUOUS_ROSTER } : null),
      apiMutate: async (url, method, body) => { mutateCalls.push({ url, method, body }); return { status: 'received' }; },
      apiBase: '/api/sessions/p/medusa', ids, state: { state: 'listening' }
    });
    const r = await c.sendTaggedMessage('@arc hi');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEDUSA_NICKNAME_AMBIGUOUS');
    assert.equal(r.ambiguous[0].tag, 'arc');
    assert.equal(mutateCalls.length, 0);
  });
});

describe('sendTaggedMessage — a partial multi-recipient failure retries only the unresolved recipients (#1576 I-Gate Round 2 C2)', () => {
  it('retrying the SAME text after @arc succeeded / @pm failed resends only to @pm', async () => {
    const roster = [{ id: 'tc-lane-arc-4041e89e', name: 'Arc' }, { id: 'tc-lane-pm-9d85f3aa', name: 'PM' }];
    const ids = G.tcMedusaIds('');
    const { doc } = makeDocument(Object.values(ids).filter(Boolean));
    let pmShouldFail = true;
    const mutateCalls = [];
    const c = G.tcCreateMedusaControl({
      doc, api: async (url) => (url.endsWith('/roster') ? { workspaces: roster } : null),
      apiMutate: async (url, method, body) => {
        mutateCalls.push({ url, method, body });
        if (body.to === 'tc-lane-pm-9d85f3aa' && pmShouldFail) return null;
        return { status: 'received' };
      },
      apiBase: '/api/sessions/p/medusa', ids, state: { state: 'listening' }
    });

    const first = await c.sendTaggedMessage('@arc @pm both please');
    assert.equal(first.ok, false, 'PM failed, so the attempt as a whole is not ok');
    assert.equal(mutateCalls.length, 2, 'both were attempted the first time');

    pmShouldFail = false;
    mutateCalls.length = 0;
    const retry = await c.sendTaggedMessage('@arc @pm both please');
    assert.equal(retry.ok, true);
    assert.equal(mutateCalls.length, 1, 'only PM is re-sent — Arc, already delivered, is never posted to twice');
    assert.equal(mutateCalls[0].body.to, 'tc-lane-pm-9d85f3aa');
  });

  it('editing the text before retrying starts a fresh attempt — the old delivery tracking does not leak in', async () => {
    const roster = [{ id: 'tc-lane-arc-4041e89e', name: 'Arc' }];
    const ids = G.tcMedusaIds('');
    const { doc } = makeDocument(Object.values(ids).filter(Boolean));
    const mutateCalls = [];
    const c = G.tcCreateMedusaControl({
      doc, api: async (url) => (url.endsWith('/roster') ? { workspaces: roster } : null),
      apiMutate: async (url, method, body) => { mutateCalls.push({ url, method, body }); return { status: 'received' }; },
      apiBase: '/api/sessions/p/medusa', ids, state: { state: 'listening' }
    });
    await c.sendTaggedMessage('@arc first message');
    assert.equal(mutateCalls.length, 1);
    await c.sendTaggedMessage('@arc a different message');
    assert.equal(mutateCalls.length, 2, 'a genuinely new message to the SAME recipient must still send');
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

describe('the live-loop glow must not erase the mark\'s state channel (#556)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'shared-controls.css'), 'utf8');

  /**
   * Count the class selectors in one compound selector — CSS specificity's
   * middle number, which is what decides between two rules setting `filter`.
   * @param {string} sel - A compound selector.
   * @returns {number}
   */
  function classCount(sel) {
    return (sel.match(/[.:]/g) || []).length;
  }

  it('gates the glow so it cannot outrank the off and error states', () => {
    // `filter` REPLACES, it does not compose. The glow rule sits later in the
    // file than the state rules, so at equal specificity it won outright: an off
    // listener rendered fully saturated and glowing, and an error rendered with
    // no amber at all — a live loop hid the very failures the mark reports.
    const glow = css.match(/^(\.medusa-control\.has-live-loop[^{]*?)\.medusa-mark img \{[^}]*filter:/m);
    assert.ok(glow, 'the glow rule must still exist');
    assert.match(glow[1], /:not\(\.is-off\)/);
    assert.match(glow[1], /:not\(\.is-error\)/);
  });

  it('does not glow blue on gold art', () => {
    // --root-accent is #4a9eff; a blue halo around gold blends to a muddy green,
    // which reads as a third state that does not exist.
    //
    // Read the rule's BODY, not the line the selector happens to sit on: the
    // declaration spans two lines, so a line-wise search matched the selector —
    // which contains no colour at all — and passed no matter what the glow was
    // set to. Caught by mutating the token back to --root-accent and watching
    // this stay green.
    const rule = css.match(/\.medusa-control\.has-live-loop[^{]*\.medusa-mark img \{([^}]*)\}/);
    assert.ok(rule, 'the glow rule must still exist');
    assert.match(rule[1], /filter:\s*drop-shadow/, 'precondition: this is the rule that draws the halo');
    assert.ok(!/--root-accent/.test(rule[1]), 'the glow must not use the blue accent');
    assert.match(rule[1], /--medusa-loop-glow/);
  });

  it('defines its own glow token, since both surfaces load this sheet', () => {
    assert.match(css, /--medusa-loop-glow:\s*#[0-9a-f]{3,8}/i);
  });

  it('suppresses the pulse under reduced motion at MATCHING specificity', () => {
    // The gate above raised the animated selector's specificity, so a plainer
    // `animation: none` would now LOSE the cascade and the pulse would run for
    // an operator who asked it not to.
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*([^{]*?)\{\s*animation:\s*none/);
    assert.ok(reduced, 'reduced-motion suppression must live in the shared sheet');
    const animated = css.split('\n').find((l) => /has-live-loop.*medusa-mark \{ animation: medusa-loop-glow/.test(l));
    assert.ok(animated, 'animated rule not found');
    assert.ok(
      classCount(reduced[1]) >= classCount(animated.split('{')[0]),
      `reduced-motion selector (${reduced[1].trim()}) must not be less specific than the rule it suppresses`
    );
  });
});

/*
 * #1083 — the loop setup modal/chip/panel, extracted from `session.js` into
 * the sibling shared component `public/medusa-loops-ui.js#tcCreateMedusaLoops`
 * so the Master bar can mount it too. Before this car it was reachable only
 * from `session.js` — a page script that cannot be require()d (see this
 * file's own header) — so NONE of what follows existed as automated coverage
 * previously; it was "tested" only by grepping source, the exact gap #928 R-1
 * flags as proving nothing about runtime.
 *
 * What is pinned:
 *   1. The id scheme: real, collision-safe ids for a prefixed host (not null
 *      — the gap #996 deliberately left open, closed here).
 *   2. Markup: every id the component drives is present, for both subjects.
 *   3. `canLaunch` gating via `onControlRender`: `outbound.allowed === false`
 *      (a read-only Master, #1083's own stated requirement) hides the launch
 *      affordance even while the listener is on — not just the `state === 'off'`
 *      case the session always had.
 *   4. The chip's live/ended/error labelling, and escaping of loop/peer text
 *      the panel renders (cross-session data, same discipline as the base
 *      control's own inbox panel).
 *   5. `mount()` binds once; the ➤ button fetches the roster and opens the modal.
 *   6. `guardPresets` is a real override seam, not a hardcoded value — the
 *      Master-specific-preset decision #1083's own issue names as open stays
 *      open; this only pins that a future car has somewhere to put the answer.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Lift `api-helper.js` then `medusa-loops-ui.js` into ONE sandbox — the
 * second file reads `global.tcMedusaIds`/`tcMessageSize`/`tcTooLongText`/
 * `tcApiFailureText`/`tcEscapeHtml`, all published by the first, exactly the
 * way they run on a real page (api-helper.js's script tag loads first).
 * @returns {object} The sandbox, carrying every `tc*` global both files publish.
 */
function loadMedusaLoopsGlobals() {
  const apiHelperSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
  const loopsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'medusa-loops-ui.js'), 'utf8');
  const sandbox = { console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(apiHelperSrc, sandbox);
  vm.runInContext(loopsSrc, sandbox);
  return sandbox;
}

const L = loadMedusaLoopsGlobals();

/**
 * A document holding one loops-UI instance's elements, plus a recording
 * `api`/`apiMutate` a test programs by path. Mirrors this file's own `world()`
 * above, extended with the modal's form fields and the loop-UI's own default
 * resting state (`modal` carries no `.open` class until opened; `loopsChip`/
 * `loopsPanel` start hidden, same as the base control's).
 * @param {object} ids - From `tcMedusaLoopIds`.
 * @param {object} [answers] - path (relative to apiBase) → payload, or a function.
 * @param {object} [mutateAnswers] - `${method} ${path}` → payload, or a function.
 * @returns {{doc: object, el: object, calls: object[], mutateCalls: object[],
 *   api: Function, apiMutate: Function}}
 */
function loopsWorld(ids, answers = {}, mutateAnswers = {}) {
  const { doc, ids: el } = makeDocument(Object.values(ids).filter(Boolean));
  for (const key of ['loop', 'loopsChip', 'loopsPanel']) if (el[ids[key]]) el[ids[key]].hidden = true;
  // Unlike `hidden`/`innerHTML`, the mini DOM's `makeElement` declares no
  // default for `.value` — a real browser's form fields are never `undefined`
  // (`.value` defaults to `''`), so an untouched field here would crash
  // `payload()`'s `.trim()` the way no real page ever does.
  for (const key of ['target', 'task', 'done', 'mode', 'maxRounds', 'maxMinutes']) {
    if (el[ids[key]]) el[ids[key]].value = '';
  }
  doc.addEventListener = (type, fn) => { (doc._listeners || (doc._listeners = {}))[type] = fn; };
  doc.activeElement = null;
  const calls = [];
  const api = async (url, opts) => {
    calls.push({ url, opts: opts || null });
    const key = url.replace(/^.*\/medusa\//, '');
    const a = answers[key];
    return typeof a === 'function' ? a() : (a === undefined ? null : a);
  };
  api.lastError = null;
  const mutateCalls = [];
  const apiMutate = async (url, method, body) => {
    mutateCalls.push({ url, method, body });
    const key = `${method} ${url.replace(/^.*\/medusa\//, '')}`;
    const a = mutateAnswers[key];
    return typeof a === 'function' ? a() : (a === undefined ? null : a);
  };
  return { doc, el, calls, mutateCalls, api, apiMutate };
}

describe('tcMedusaLoopIds — combines the base control ids with the modal\'s own', () => {
  it('the session keeps its historical unprefixed ids', () => {
    const ids = L.tcMedusaLoopIds('');
    assert.equal(ids.loop, 'medusaLoop');
    assert.equal(ids.loopsChip, 'medusaLoopsChip');
    assert.equal(ids.loopsPanel, 'medusaLoopsPanel');
    assert.equal(ids.modal, 'medusaLoopModal');
    assert.equal(ids.target, 'medusaLoopTarget');
    assert.equal(ids.launchBtn, 'medusaLoopLaunchBtn');
  });
  it('a prefixed host gets every field prefixed, colliding with nothing the session uses', () => {
    const unprefixed = new Set(Object.values(L.tcMedusaLoopIds('')).filter(Boolean));
    const ids = L.tcMedusaLoopIds('masterDrawer');
    for (const v of Object.values(ids).filter(Boolean)) {
      assert.ok(v.startsWith('masterDrawer'), v);
      assert.ok(!unprefixed.has(v), `${v} collides with the session's own id`);
    }
    assert.equal(ids.modal, 'masterDrawerMedusaLoopModal');
    assert.equal(ids.maxMinutes, 'masterDrawerMedusaLoopMaxMinutes');
  });
});

describe('tcMedusaLoopsControlMarkup / tcMedusaLoopModalMarkup', () => {
  it('the inline markup carries every id the component mounts on', () => {
    const ids = L.tcMedusaLoopIds('masterPanel');
    const html = L.tcMedusaLoopsControlMarkup(ids, 'the Master');
    for (const key of ['loop', 'loopsChip', 'loopsPanel']) {
      assert.match(html, new RegExp(`id="${ids[key]}"`), `${key} missing`);
    }
    assert.match(html, /aria-label="Set up a loop for the Master"/);
    assert.doesNotMatch(html, /master-bar-pending|aria-disabled/, 'no pending treatment by default');
  });
  it('the modal markup carries every form field id, and escapes a subject with markup-looking text', () => {
    const ids = L.tcMedusaLoopIds('masterDrawer');
    const html = L.tcMedusaLoopModalMarkup(ids, 'a Master loop');
    for (const key of ['modal', 'target', 'rosterStatus', 'task', 'done', 'size', 'mode', 'maxRounds', 'maxMinutes', 'guardHint', 'error', 'cancelBtn', 'launchBtn']) {
      assert.match(html, new RegExp(`id="${ids[key]}"`), `${key} missing`);
    }
    assert.match(html, /class="modal-backdrop"/);
  });
});

describe('tcCreateMedusaLoops — onControlRender (#1083 outbound.allowed gating)', () => {
  it('hides the launch affordance when the listener is off, same as before #1083', () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state: {} });
    loops.onControlRender({ state: 'off', loops: [] });
    assert.equal(w.el[ids.loop].hidden, true);
  });
  it('shows the launch affordance when listening and outbound is allowed (the default)', () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state: {} });
    loops.onControlRender({ state: 'listening', loops: [], outbound: { allowed: true, reason: null } });
    assert.equal(w.el[ids.loop].hidden, false);
  });
  it('hides the launch affordance for a listening-but-outbound-blocked participant (a read-only Master, #1083)', () => {
    const ids = L.tcMedusaLoopIds('masterDrawer');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/master/medusa', state: {} });
    loops.onControlRender({ state: 'listening', loops: [], outbound: { allowed: false, reason: 'read-only' } });
    assert.equal(w.el[ids.loop].hidden, true, 'read-only must not offer a launch that would 403');
  });
  it('closing-the-modal side effect: going outbound-blocked while the modal is open closes it', () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state: {} });
    w.el[ids.modal].classList.add('open');
    loops.onControlRender({ state: 'listening', loops: [], outbound: { allowed: false, reason: 'read-only' } });
    assert.ok(!w.el[ids.modal].classList.contains('open'));
  });
});

describe('tcCreateMedusaLoops — renderChip', () => {
  it('stays hidden with no loops and no error', () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state: {} });
    loops.renderChip({ loops: [], loopsError: null });
    assert.equal(w.el[ids.loopsChip].hidden, true);
    assert.equal(w.el[ids.control].classList.contains('has-live-loop'), false);
  });
  it('shows a round count for one live loop, and flags has-live-loop on the control', () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state: {} });
    loops.renderChip({ loops: [{ id: 'l1', state: 'initiated', round: 1, guards: { maxRounds: 10 } }], loopsError: null });
    assert.equal(w.el[ids.loopsChip].hidden, false);
    assert.equal(w.el[ids.loopsChip].textContent, '⟳ R1/10');
    assert.equal(w.el[ids.control].classList.contains('has-live-loop'), true);
  });
  it('surfaces a loopsError on the chip without throwing', () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state: {} });
    loops.renderChip({ loops: [], loopsError: 'bridge down' });
    assert.equal(w.el[ids.loopsChip].hidden, false);
    assert.match(w.el[ids.loopsChip].getAttribute('aria-label'), /bridge down/);
  });
});

describe('tcCreateMedusaLoops — renderPanel row actions gated on outbound.allowed (#1083 I-Gate Round 1 C2)', () => {
  const LIVE_LOOP = { id: 'loop-1', role: 'initiator', state: 'responded', round: 2, target: 'peer-ws', guards: { maxRounds: 10 } };

  it('a live initiator loop offers Send feedback / Mark done / Force-done when outbound is allowed (the default)', async () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids);
    const state = { loops: [LIVE_LOOP], outbound: { allowed: true, reason: null } };
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state });
    loops.mount();
    w.el[ids.loopsChip].dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    const html = w.el[ids.loopsPanel].innerHTML;
    assert.match(html, /medusa-loop-continue/);
    assert.match(html, /medusa-loop-closeout/);
    assert.match(html, /medusa-force-done/);
  });

  it('a read-only Master (outbound.allowed === false) gets the reason instead of mutation controls, '
    + 'but transcript stays available — the three Master routes behind them all 403 (#1083)', async () => {
    const ids = L.tcMedusaLoopIds('masterDrawer');
    const w = loopsWorld(ids);
    const state = { loops: [LIVE_LOOP], outbound: { allowed: false, reason: 'read-only access level' } };
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/master/medusa', state });
    loops.mount();
    w.el[ids.loopsChip].dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    const html = w.el[ids.loopsPanel].innerHTML;
    assert.doesNotMatch(html, /medusa-loop-continue/, 'Send feedback must not be offered');
    assert.doesNotMatch(html, /medusa-loop-closeout/, 'Mark done must not be offered');
    assert.doesNotMatch(html, /medusa-force-done/, 'Force-done must not be offered');
    assert.match(html, /read-only access level/, 'the server\'s own reason must be shown');
    assert.match(html, /medusa-loop-transcript-toggle/, 'read-only affordances (transcript) stay available');
  });
});

describe('tcCreateMedusaLoops — mount() binds once; the ➤ button fetches the roster', () => {
  it('opening the modal fetches the roster and populates the target picker', async () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids, { roster: { workspaces: [{ id: 'live-ws', name: 'Live', connected: true }] } });
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state: {} });
    loops.mount();
    const fired = w.el[ids.loop].dispatch('click');
    assert.ok(fired);
    // The fetch is awaited inside the click handler's own async function, not
    // by this dispatch — give it a tick to resolve before asserting.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(w.el[ids.modal].classList.contains('open'), true);
    assert.match(w.el[ids.target].innerHTML, /Live/);
    assert.equal(w.calls[0].url, '/api/sessions/p/medusa/roster');
  });
  it('a second mount() does not double-bind (two clicks, not a double roster fetch per click)', () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids, { roster: { workspaces: [] } });
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state: {} });
    loops.mount();
    loops.mount();
    w.el[ids.loop].dispatch('click');
    assert.equal(w.calls.length, 1, 'one bind, one fetch per click');
  });
});

describe('tcCreateMedusaLoops — guardPresets is a real override seam (#1083), partial-merged per mode', () => {
  it('defaults to the session\'s historical presets for both maxMinutes and maxRounds', () => {
    const ids = L.tcMedusaLoopIds('');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({ doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/sessions/p/medusa', state: {} });
    loops.mount();
    w.el[ids.mode].value = 'autonomous';
    w.el[ids.mode].dispatch('change');
    assert.equal(w.el[ids.maxMinutes].value, String(L.tcMedusaLoopGuardPresets.autonomous.maxMinutes));
    assert.equal(w.el[ids.maxRounds].value, String(L.tcMedusaLoopGuardPresets.autonomous.maxRounds));
  });
  it('an injected guardPresets overrides the default, for a host that has decided its own', () => {
    const ids = L.tcMedusaLoopIds('masterDrawer');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({
      doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/master/medusa', state: {},
      guardPresets: { supervised: { maxMinutes: 5, maxRounds: 2, hint: 'master-specific' }, autonomous: { maxMinutes: 1, maxRounds: 1, hint: 'master-specific' } }
    });
    loops.mount();
    w.el[ids.mode].dispatch('change');
    assert.equal(w.el[ids.maxMinutes].value, '5');
    assert.equal(w.el[ids.maxRounds].value, '2');
    assert.equal(w.el[ids.guardHint].textContent, 'master-specific');
  });
  it('Ruling A505-R2.6 — a PARTIAL autonomous-only override (Master\'s ratified 6 rounds / 15 minutes) leaves '
    + 'supervised at the session default, and never drops autonomous\'s own hint when only the numbers are given', () => {
    const ids = L.tcMedusaLoopIds('masterPanel');
    const w = loopsWorld(ids);
    const loops = L.tcCreateMedusaLoops({
      doc: w.doc, ids, api: w.api, apiMutate: w.apiMutate, apiBase: '/api/master/medusa', state: {},
      guardPresets: { autonomous: { maxRounds: 6, maxMinutes: 15 } }
    });
    loops.mount();
    w.el[ids.mode].value = 'autonomous';
    w.el[ids.mode].dispatch('change');
    assert.equal(w.el[ids.maxRounds].value, '6');
    assert.equal(w.el[ids.maxMinutes].value, '15');
    assert.equal(w.el[ids.guardHint].textContent, L.tcMedusaLoopGuardPresets.autonomous.hint, 'the default hint survives a numbers-only override');

    w.el[ids.mode].value = 'supervised';
    w.el[ids.mode].dispatch('change');
    assert.equal(w.el[ids.maxRounds].value, String(L.tcMedusaLoopGuardPresets.supervised.maxRounds), 'supervised is untouched by an autonomous-only override');
    assert.equal(w.el[ids.maxMinutes].value, String(L.tcMedusaLoopGuardPresets.supervised.maxMinutes));
  });
});
