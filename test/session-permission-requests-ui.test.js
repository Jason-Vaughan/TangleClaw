'use strict';

/*
 * #2352 — the session page's pending-permissions chip and panel. Lifts the
 * REAL render/toggle/decide functions out of public/session.js and runs them
 * against the mini DOM, per this repo's established convention
 * (test/engine-error-ui.test.js) for plain (non-factory) session.js UI code:
 * the assertion is about rendered state and real calls, not source text.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');
const { liftDeclaration } = require('./helpers/lift');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');

const REQUEST_A = {
  requestId: 'perm_aaa111', scope: 'repo-write', scopeTarget: 'origin/main',
  actionSummary: 'push a commit', state: 'pending'
};

/**
 * A sandbox with the real chip/panel/toggle/decide functions, a document
 * holding their two elements, and recording `api`/`apiMutate`/toast stubs.
 * @param {object} [options]
 * @param {object[]} [options.permissionRequests] - Seeds `sessionState.permissionRequests`
 * @param {Function} [options.apiImpl] - `api(url, fetchOpts)` stub; defaults to resolving `{requests: []}`
 * @param {Function} [options.apiMutateImpl] - `apiMutate()` stub; defaults to resolving `{ok: true}`
 * @returns {object} `{doc, el, calls, toasts, sandbox}`
 */
function load(options = {}) {
  const { doc, ids: el } = makeDocument(['permissionRequestsChip', 'permissionRequestsPanel']);
  el.permissionRequestsChip.hidden = true;
  el.permissionRequestsPanel.hidden = true;

  const calls = { api: [], apiMutate: [] };
  const toasts = [];
  const sandbox = {
    document: doc,
    console,
    encodeURIComponent,
    sessionState: { permissionRequests: options.permissionRequests || [] },
    projectName: 'demo-project',
    api: async (url, fetchOpts) => {
      calls.api.push({ url, fetchOpts });
      return (options.apiImpl || (() => ({ requests: [] })))(url, fetchOpts);
    },
    apiMutate: async (url, method, body) => {
      calls.apiMutate.push({ url, method, body });
      return (options.apiMutateImpl || (() => ({ ok: true })))(url, method, body);
    },
    showBannerActionToast: (message, isError) => { toasts.push({ message, isError }); },
    // Sibling popovers from the shared Medusa control cluster — not this
    // file's concern (they have their own tests), but togglePermissionRequestsPanel
    // closes them on open per R-3, so the lifted function needs them to exist.
    closeMedusaInbox: () => { calls.closedSiblings = (calls.closedSiblings || []).concat('inbox'); },
    hideMedusaPeers: () => { calls.closedSiblings = (calls.closedSiblings || []).concat('peers'); },
    closeMedusaLoopModal: () => { calls.closedSiblings = (calls.closedSiblings || []).concat('loopModal'); },
    closeMedusaLoopsPanel: () => { calls.closedSiblings = (calls.closedSiblings || []).concat('loopsPanel'); }
  };
  sandbox.api.lastError = null;
  vm.createContext(sandbox);
  vm.runInContext([
    liftDeclaration(SESSION_SRC, 'function esc(str)'),
    liftDeclaration(SESSION_SRC, 'async function pollPermissionRequests()'),
    liftDeclaration(SESSION_SRC, 'function renderPermissionRequestsChip(requests)'),
    liftDeclaration(SESSION_SRC, 'function renderPermissionRequestsPanel(requests)'),
    liftDeclaration(SESSION_SRC, 'function closePermissionRequestsPanel()'),
    liftDeclaration(SESSION_SRC, 'function togglePermissionRequestsPanel()'),
    liftDeclaration(SESSION_SRC, 'async function decidePermissionRequestFromUi(requestId, decision, expectedScope)'),
    'globalThis.pollPermissionRequests = pollPermissionRequests;',
    'globalThis.renderPermissionRequestsChip = renderPermissionRequestsChip;',
    'globalThis.renderPermissionRequestsPanel = renderPermissionRequestsPanel;',
    'globalThis.closePermissionRequestsPanel = closePermissionRequestsPanel;',
    'globalThis.togglePermissionRequestsPanel = togglePermissionRequestsPanel;',
    'globalThis.decidePermissionRequestFromUi = decidePermissionRequestFromUi;'
  ].join('\n'), sandbox);
  return { doc, el, calls, toasts, sandbox };
}

describe('#2352 session page: pending-permissions chip + panel', () => {
  it('the page ships both elements, hidden, reusing the Medusa panel\'s [hidden] handling', () => {
    assert.match(SESSION_HTML, /class="medusa-loops-chip" id="permissionRequestsChip" type="button" hidden/);
    assert.match(SESSION_HTML, /class="medusa-panel group-popover" id="permissionRequestsPanel"[^>]*hidden/);
  });

  it('the chip is hidden with nothing pending, and shows the count otherwise', () => {
    const { el, sandbox } = load();
    sandbox.renderPermissionRequestsChip([]);
    assert.equal(el.permissionRequestsChip.hidden, true);

    sandbox.renderPermissionRequestsChip([REQUEST_A, REQUEST_A]);
    assert.equal(el.permissionRequestsChip.hidden, false);
    assert.equal(el.permissionRequestsChip.textContent, '2');
    assert.match(el.permissionRequestsChip.getAttribute('aria-label'), /2 pending permission requests/);
  });

  it('renders a row per request with actionSummary/scope/scopeTarget escaped, never raw-interpolated', () => {
    const { el, sandbox } = load();
    const malicious = { ...REQUEST_A, actionSummary: '<script>alert(1)</script>', scope: 'a"b', scopeTarget: '<x>' };
    sandbox.renderPermissionRequestsPanel([malicious]);
    assert.doesNotMatch(el.permissionRequestsPanel.innerHTML, /<script>alert/);
    assert.match(el.permissionRequestsPanel.innerHTML, /&lt;script&gt;/);
    assert.match(el.permissionRequestsPanel.innerHTML, /data-request-id="perm_aaa111"/);
    assert.match(el.permissionRequestsPanel.innerHTML, /data-decision="grant"/);
    assert.match(el.permissionRequestsPanel.innerHTML, /data-decision="refuse"/);
  });

  it('shows the asker\'s expectedAnswer, escaped, when the request set one (PRR-B)', () => {
    const { el, sandbox } = load();
    sandbox.renderPermissionRequestsPanel([{ ...REQUEST_A, expectedAnswer: '<b>yes please</b>' }]);
    assert.doesNotMatch(el.permissionRequestsPanel.innerHTML, /<b>yes please/);
    assert.match(el.permissionRequestsPanel.innerHTML, /Asker expects: &lt;b&gt;yes please&lt;\/b&gt;/);
  });

  it('omits the expected-answer line entirely when the request never set one', () => {
    const { el, sandbox } = load();
    sandbox.renderPermissionRequestsPanel([REQUEST_A]);
    assert.doesNotMatch(el.permissionRequestsPanel.innerHTML, /permission-request-expected/);
  });

  it('shows an empty-state message with no pending requests', () => {
    const { el, sandbox } = load();
    sandbox.renderPermissionRequestsPanel([]);
    assert.match(el.permissionRequestsPanel.innerHTML, /No pending permission requests\./);
    assert.doesNotMatch(el.permissionRequestsPanel.innerHTML, /permission-request-row/);
  });

  it('the chip toggles the panel open and closed, flipping aria-expanded, and renders on open', () => {
    const { el, sandbox } = load({ permissionRequests: [REQUEST_A] });
    sandbox.togglePermissionRequestsPanel();
    assert.equal(el.permissionRequestsPanel.hidden, false);
    assert.equal(el.permissionRequestsChip.getAttribute('aria-expanded'), 'true');
    assert.match(el.permissionRequestsPanel.innerHTML, /perm_aaa111/);

    sandbox.togglePermissionRequestsPanel();
    assert.equal(el.permissionRequestsPanel.hidden, true);
    assert.equal(el.permissionRequestsChip.getAttribute('aria-expanded'), 'false');
  });

  it('opening closes every sibling popover in the Medusa control cluster first (R-3)', () => {
    const { sandbox, calls } = load();
    sandbox.togglePermissionRequestsPanel();
    assert.deepEqual(calls.closedSiblings.sort(), ['inbox', 'loopModal', 'loopsPanel', 'peers']);
  });

  it('closePermissionRequestsPanel is idempotent and is what the outside-click handler is wired to', () => {
    const { el, sandbox } = load();
    sandbox.closePermissionRequestsPanel();
    assert.equal(el.permissionRequestsPanel.hidden, true);
    sandbox.togglePermissionRequestsPanel();
    sandbox.closePermissionRequestsPanel();
    assert.equal(el.permissionRequestsPanel.hidden, true);
    assert.match(SESSION_SRC, /closePermissionRequestsPanel\(\);\s*\n\s*}\);/, 'bound in the outside-click handler');
  });

  it('a successful decide refreshes the panel from the server and shows no toast', async () => {
    let served = [REQUEST_A];
    const { sandbox, calls, toasts } = load({
      apiImpl: (url, fetchOpts) => {
        if (url === '/api/auth/me') return { openInstallToken: null };
        if (/\/decide$/.test(url)) {
          assert.equal(fetchOpts.method, 'POST');
          const body = JSON.parse(fetchOpts.body);
          assert.equal(body.decision, 'grant');
          assert.equal(body.expectedScope, 'repo-write');
          served = []; // the server now reports it decided
          return { ok: true, request: { ...REQUEST_A, state: 'granted' } };
        }
        return { requests: served };
      }
    });
    await sandbox.decidePermissionRequestFromUi('perm_aaa111', 'grant', 'repo-write');
    // /api/auth/me, the decide POST, and pollPermissionRequests's own GET.
    assert.equal(calls.api.length, 3, 'fetched the open-install token, decided, then refreshed via the same poll path');
    assert.equal(toasts.length, 0);
  });

  it('a failed decide shows a toast naming the server\'s error, and still refreshes', async () => {
    const { sandbox, calls, toasts } = load({
      apiImpl: (url) => {
        if (url === '/api/auth/me') return { openInstallToken: null };
        if (/\/decide$/.test(url)) { sandbox.api.lastError = 'already decided'; return null; }
        return { requests: [] };
      }
    });
    await sandbox.decidePermissionRequestFromUi('perm_aaa111', 'refuse', 'repo-write');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].isError, true);
    assert.match(toasts[0].message, /refuse the permission request: already decided/);
    assert.equal(calls.api.length, 3, 'still fetched the token, decided, and refreshed so the row\'s real state shows');
  });

  it('attaches X-TC-Open-Token on the decide request when the install has one, so Grant/Refuse works on an open install (PRR-B, live-browser verification)', async () => {
    const { sandbox, calls } = load({
      apiImpl: (url) => {
        if (url === '/api/auth/me') return { openInstallToken: 'tok_abc123' };
        if (/\/decide$/.test(url)) return { ok: true, request: { ...REQUEST_A, state: 'granted' } };
        return { requests: [] };
      }
    });
    await sandbox.decidePermissionRequestFromUi('perm_aaa111', 'grant', 'repo-write');
    const decideCall = calls.api.find((c) => /\/decide$/.test(c.url));
    assert.ok(decideCall, 'the decide request was made');
    assert.equal(decideCall.fetchOpts.headers['X-TC-Open-Token'], 'tok_abc123');
  });

  it('omits X-TC-Open-Token on an armed (login-configured) install, where /api/auth/me reports none', async () => {
    const { sandbox, calls } = load({
      apiImpl: (url) => {
        if (url === '/api/auth/me') return { openInstallToken: null };
        if (/\/decide$/.test(url)) return { ok: true, request: { ...REQUEST_A, state: 'granted' } };
        return { requests: [] };
      }
    });
    await sandbox.decidePermissionRequestFromUi('perm_aaa111', 'grant', 'repo-write');
    const decideCall = calls.api.find((c) => /\/decide$/.test(c.url));
    assert.ok(decideCall, 'the decide request was made');
    assert.equal(decideCall.fetchOpts.headers['X-TC-Open-Token'], undefined);
  });

  it('pollPermissionRequests renders both the chip and an OPEN panel, but leaves a closed one alone', async () => {
    const { el, sandbox } = load({ apiImpl: () => ({ requests: [REQUEST_A] }) });
    await sandbox.pollPermissionRequests();
    assert.equal(el.permissionRequestsChip.hidden, false);
    assert.equal(el.permissionRequestsPanel.innerHTML, '', 'closed panel is not rendered into');

    sandbox.togglePermissionRequestsPanel();
    const afterOpen = el.permissionRequestsPanel.innerHTML;
    assert.match(afterOpen, /perm_aaa111/);
  });

  it('pollStatus rides the status poll cadence — no new timer', () => {
    const poll = liftDeclaration(SESSION_SRC, 'async function pollStatus()');
    assert.match(poll, /pollPermissionRequests\(\)/);
  });

  it('the chip and panel are wired at init: chip click toggles, panel clicks delegate to grant/refuse/close', () => {
    assert.match(SESSION_SRC, /permissionRequestsChip\.addEventListener\('click', togglePermissionRequestsPanel\)/);
    assert.match(SESSION_SRC, /decidePermissionRequestFromUi\(row\.dataset\.requestId, btn\.dataset\.decision, row\.dataset\.scope\)/);
  });

  it('Escape closes the panel via the dedicated close function', () => {
    const keydown = liftDeclaration(SESSION_SRC, "document.addEventListener('keydown', (e) => {");
    assert.match(keydown, /permissionRequestsPanelEsc && !permissionRequestsPanelEsc\.hidden\) closePermissionRequestsPanel\(\)/);
  });
});
