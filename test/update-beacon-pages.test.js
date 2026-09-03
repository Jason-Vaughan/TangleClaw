'use strict';

/*
 * #931 — the dashboard and a session must announce an update IDENTICALLY.
 *
 * That is the whole issue. The update pill and the session badge were both
 * correct in isolation and wrong together: one could apply the update and was
 * invisible from where operators work, the other was visible and fired agent
 * instructions on a single un-confirmed tap. So the criterion is not "each page
 * has a beacon" — it is "there is one beacon, and both pages are on it".
 *
 * A per-page test cannot see that. These drive BOTH pages' wiring in one
 * process and compare what comes out, so a page that grows its own render is a
 * failure here even while its own suite stays green.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const BEACON_SRC = read('update-beacon.js');
const API_HELPER_SRC = read('api-helper.js');
const LANDING_SRC = read('landing.js');
const SESSION_SRC = read('session.js');
const INDEX_HTML = read('index.html');
const SESSION_HTML = read('session.html');

const AVAILABLE = {
  updateAvailable: true,
  currentVersion: '5.1.0',
  latestVersion: '5.1.2',
  checkedAt: '2026-08-15T10:00:00.000Z',
  releaseUrl: 'https://github.com/Jason-Vaughan/TangleClaw/releases/tag/v5.1.2'
};

/**
 * Slice a page's `tcCreateUpdateBeacon({...})` construction out of its source
 * and run THAT, so the test exercises each page's real dependency wiring —
 * anchor id, latch, confirm text, secondary action — rather than a
 * reconstruction of it.
 *
 * @param {string} src - The page script's source.
 * @returns {string} The `tcCreateUpdateBeacon(...)` call text.
 */
function beaconConstruction(src) {
  const start = src.indexOf('tcCreateUpdateBeacon({');
  assert.notEqual(start, -1, 'the page must construct the shared beacon');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, src.indexOf(')', i) + 1);
  }
  assert.fail('unbalanced braces in the beacon construction');
}

/**
 * Stand a page's beacon up in a sandbox.
 *
 * @param {'dashboard'|'session'} page - Which page's wiring to run.
 * @param {{confirm?: boolean}} [opts] - Dialog answer. Default declines, so a
 *   test that only needs the toast rendered cannot start a real restart; pass
 *   `{confirm: true}` to drive the flow through to its routes.
 * @returns {object} The vm context with test handles attached.
 */
function loadPage(page, opts = {}) {
  const { doc, ids } = makeDocument(['updateBeacon']);
  const calls = { confirms: [], alerts: [], fetches: [], timers: [], injected: [] };
  const src = page === 'dashboard' ? LANDING_SRC : SESSION_SRC;

  const sandbox = {
    console, Response, Headers,
    document: doc,
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
    clearTimeout: (h) => { if (calls.timers[h - 1]) calls.timers[h - 1].cleared = true; },
    setInterval: () => 1,
    clearInterval: () => {},
    location: { reload: () => {} },
    // The dashboard's latch lives on its `state` object, shared with the #235
    // stale-server restart; the session page has its own binding. Both are
    // provided so each page's real accessors resolve.
    state: { restartInFlight: false },
    restartInFlight: false,
    fetch: async (url, init) => {
      calls.fetches.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    // session.js's secondary action calls this; capturing it here is what lets
    // the "agent link does not start the update" assertion below be about the
    // page's OWN wiring rather than a stand-in.
    injectUpdatePrompt: (data) => { calls.injected.push(data); }
  };
  sandbox.confirm = (msg) => { calls.confirms.push(msg); return opts.confirm === true; };
  sandbox.alert = (msg) => { calls.alerts.push(msg); };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(API_HELPER_SRC, sandbox);
  vm.runInContext(BEACON_SRC, sandbox);
  vm.runInContext(`
    const api = tcCreateApi({});
    const apiMutate = tcCreateApiMutate(api);
    const restartFlow = tcCreateRestartFlow({ api, apiMutate, win: window });
    globalThis.beacon = ${beaconConstruction(src)};
  `, sandbox);

  sandbox.calls = calls;
  sandbox.toast = () => ids.updateBeacon.querySelector('.beacon-toast');
  sandbox.dot = () => ids.updateBeacon.querySelector('.beacon-dot');
  sandbox.runTimers = () => { for (const t of calls.timers) if (!t.cleared) t.fn(); };
  return sandbox;
}

/**
 * Describe what a beacon has rendered, in terms a comparison can use.
 * @param {object} ctx - A loaded page context.
 * @returns {object} A structural summary.
 */
function shape(ctx) {
  const toast = ctx.toast();
  const dot = ctx.dot();
  return {
    hasToast: !!toast,
    toastText: toast ? toast.text : null,
    toastRole: toast ? toast.getAttribute('role') : null,
    hasApply: !!(toast && toast.querySelector('.beacon-toast-apply')),
    hasClose: !!(toast && toast.querySelector('.beacon-toast-close')),
    hasDot: !!dot,
    dotTag: dot ? dot.tagName : null,
    dotLabel: dot ? dot.getAttribute('aria-label') : null
  };
}

describe('#931 both pages announce an update the same way', () => {
  it('the first pop is identical on the dashboard and in a session', () => {
    const dash = loadPage('dashboard');
    const sess = loadPage('session');
    dash.beacon.render(AVAILABLE);
    sess.beacon.render(AVAILABLE);

    assert.deepEqual(shape(sess), shape(dash),
      'one module, one appearance — this is the issue, restated as an assertion');
    assert.equal(shape(dash).hasDot, true);
    assert.equal(shape(dash).hasToast, true);
    // THE MUTATION THIS CATCHES: giving either page its own render path. Both
    // suites would still pass on their own; only comparing them catches it.
  });

  it('the dot survives the fade on both, and re-opens on both', () => {
    const pages = { dashboard: loadPage('dashboard'), session: loadPage('session') };
    for (const ctx of Object.values(pages)) {
      ctx.beacon.render(AVAILABLE);
      ctx.runTimers();
    }
    assert.deepEqual(shape(pages.session), shape(pages.dashboard), 'same resting state');
    assert.equal(shape(pages.dashboard).hasDot, true);
    assert.equal(shape(pages.dashboard).hasToast, false);

    for (const ctx of Object.values(pages)) ctx.dot().dispatch('click');
    assert.equal(shape(pages.dashboard).hasClose, true, 're-opened, dismissible');
    assert.equal(shape(pages.session).hasClose, true);
  });

  it('both reach the same routes, in the same order, from Update now', async () => {
    const seen = {};
    for (const page of ['dashboard', 'session']) {
      // ACCEPT the confirm. The first version of this test declined it on both
      // pages and then compared the results — which were `{confirms: 1,
      // fetches: []}` on both because no request is made before the confirm.
      // It compared an empty list to an empty list, so the mutation it named
      // (pointing a page at a different route) could not redden it. A guard
      // has to be able to fail (#749, #895).
      const ctx = loadPage(page, { confirm: true });
      ctx.beacon.render(AVAILABLE);
      ctx.toast().querySelector('.beacon-toast-apply').dispatch('click');
      // Three awaits: apply → server-info → restart. Each is a separate
      // microtask hop, so one flush is not enough to reach the end.
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
      seen[page] = ctx.calls.fetches.map((f) => f.url);
    }
    assert.deepEqual(seen.dashboard,
      ['/api/update/apply', '/api/server-info', '/api/server/restart'],
      'the #229 sequence');
    assert.deepEqual(seen.session, seen.dashboard,
      'and a session takes the identical path — same module, same routes, same order');
    // THE MUTATION THIS CATCHES: pointing either page at a different route, or
    // dropping the server-info baseline capture on one of them.
  });
});

describe('#931 each page keeps what is genuinely its own', () => {
  it('only the session page offers the agent path, and only after a re-open', () => {
    const dash = loadPage('dashboard');
    const sess = loadPage('session');
    for (const ctx of [dash, sess]) { ctx.beacon.render(AVAILABLE); ctx.runTimers(); ctx.dot().dispatch('click'); }

    assert.equal(dash.toast().querySelector('.beacon-toast-secondary'), null,
      'the dashboard has no agent to ask');
    const link = sess.toast().querySelector('.beacon-toast-secondary');
    assert.ok(link, 'the #730 path survives — demoted, not deleted');
    assert.equal(link.textContent, 'Ask the agent');
  });

  it('both pages\' confirms offer "or newer", never a bare version (#994)', async () => {
    // The session page overrides `confirmText`; the beacon's default test
    // cannot see it, so the last word before the checkout moves is pinned here
    // on the page's OWN wiring.
    for (const page of ['landing', 'session']) {
      const ctx = loadPage(page, { confirm: false });
      ctx.beacon.render(AVAILABLE);
      await ctx.beacon.apply(AVAILABLE);
      assert.equal(ctx.calls.confirms.length, 1, `${page}: apply asks first`);
      assert.match(ctx.calls.confirms[0], /v5\.1\.2 or newer and restart\?/, `${page}: a floor, not a promise`);
    }
  });

  it('the session\'s agent link injects the prompt and does NOT start the update', () => {
    const sess = loadPage('session');
    sess.beacon.render(AVAILABLE);
    sess.runTimers();
    sess.dot().dispatch('click');
    sess.toast().querySelector('.beacon-toast-secondary').dispatch('click');

    assert.equal(sess.calls.injected.length, 1, 'the agent is asked');
    assert.equal(sess.calls.injected[0].latestVersion, '5.1.2', 'with the payload');
    assert.equal(sess.calls.confirms.length, 0, 'and nothing was restarted');
    assert.equal(sess.calls.fetches.length, 0);
    // THE MUTATION THIS CATCHES: swapping the two handlers — asking the agent
    // would restart the server, and Update now would type at a terminal.
  });

  it('each page tells the truth about what its own surface does during the restart', () => {
    const dash = loadPage('dashboard');
    const sess = loadPage('session');
    dash.beacon.render(AVAILABLE);
    sess.beacon.render(AVAILABLE);
    for (const ctx of [dash, sess]) ctx.toast().querySelector('.beacon-toast-apply').dispatch('click');

    const [d, s] = [dash.calls.confirms[0], sess.calls.confirms[0]];
    assert.match(s, /terminal below blips and reconnects/,
      'the session says what happens to the thing the operator is looking at');
    assert.doesNotMatch(d, /terminal below/, 'the dashboard has no terminal below');
    for (const text of [d, s]) {
      assert.match(text, /~3 seconds/,
        'ONE restart, ONE duration — two numbers for one operation is the '
        + 'inconsistency this beacon exists to remove, in prose instead of pixels');
    }
    // THE MUTATION THIS CATCHES: letting the two confirms drift on the shared
    // fact while differing on the page-specific one.
  });
});

describe('#931 the markup anchors exist on both pages', () => {
  for (const [name, html] of [['index.html', INDEX_HTML], ['session.html', SESSION_HTML]]) {
    it(`${name} anchors the beacon on the logo and loads its module`, () => {
      // Not executable: whether the page ships the element the beacon renders
      // into, and the files that render it. Everything else in this file runs.
      assert.match(html, /class="beacon-anchor" id="updateBeacon"/,
        'the wrapper the dot and toast hang off');
      const anchor = html.slice(html.indexOf('id="updateBeacon"'));
      assert.match(anchor.slice(0, 400), /<img[^>]+logo/,
        'and it wraps the serpent, which is where the operator already looks');
      assert.match(html, /<script src="\/update-beacon\.js"><\/script>/);
      assert.match(html, /<link rel="stylesheet" href="\/beacon\.css">/,
        'one stylesheet for one appearance — a copy per page is how the pill '
        + 'and the badge diverged');
    });

    it(`${name} has no markup left for the surface it replaced`, () => {
      assert.ok(!html.includes('id="updatePill"'));
      assert.ok(!html.includes('id="updateBadge"'));
    });
  }

  it('the beacon assets are network-first', () => {
    const sw = read('sw.js');
    const networkFirst = sw.slice(sw.indexOf('const NETWORK_FIRST_PATHS'), sw.indexOf(']);', sw.indexOf('const NETWORK_FIRST_PATHS')));
    for (const asset of ['/update-beacon.js', '/beacon.css']) {
      assert.match(networkFirst, new RegExp(`'${asset}'`),
        `${asset} must not be served stale from the SW cache — it is the surface `
        + 'that tells an operator a release exists, including the release that '
        + 'would fix it (#271 pattern, worst case)');
    }
    // Deliberately NOT asserted here: that `CACHE_NAME` kept its value. A bump
    // tears down and reinstalls the worker in every browser, which behind the
    // basic_auth gate produced the repeating credential prompt in #710 — so
    // this change did not make one, and the carve-out above is why it did not
    // need to. But pinning the literal generation string would fail the next
    // legitimate bump with a message about the beacon, which is worse than no
    // guard. It is a property of a diff, not of the file.
  });
});
