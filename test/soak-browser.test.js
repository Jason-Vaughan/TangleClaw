'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const browser = require('../lib/soak/browser');
const wd = require('../lib/soak/webdriver');
const ex = require('../lib/soak/executors');
const sched = require('../lib/soak/schedule');

const B = browser.BROWSER_EXECUTORS;
const O = browser.BROWSER_OUTCOME;
const B_PAGE_STATE = browser.PAGE_STATE_PROBE;
const API = 'http://127.0.0.1:3102';
const WD = 'http://127.0.0.1:4444';

/**
 * A fake serving the guest API and a WebDriver on their own origins.
 * @param {object} h - Handlers: `api(req)` and `wd(req)`, each returning `{status, body}` or an Error
 * @returns {{fetch: Function, calls: object[]}} Fake and its log
 */
function fake(h) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = { origin: url.origin, method: init.method, path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(req);
    const r = url.origin === WD ? h.wd(req) : h.api(req);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, calls };
}

/**
 * A call context with a WebDriver and an instant clock.
 * @param {Function} fetch - Fetch implementation
 * @returns {object} Context
 */
function ctx(fetch) {
  let t = 0;
  return { apiBase: `${API}/`, token: null, fetch, now: () => t, sleep: async (ms) => { t += ms; }, local: { webdriver: WD, home: '/x', uid: 501, phase: 'certifying' } };
}

/**
 * A WebDriver whose scripts answer from `scripts(script, n)`.
 * @param {object} [opt] - `{scripts, newSession, deleteFails}`
 * @returns {(req: object) => object} Handler
 */
function driver(opt = {}) {
  let n = 0;
  return (req) => {
    if (req.method === 'POST' && req.path === '/session') {
      return opt.newSession || { status: 200, body: { value: { sessionId: 'S1', capabilities: {} } } };
    }
    if (req.method === 'DELETE') return opt.deleteFails ? { status: 500, body: { value: { error: 'unknown error', message: 'x' } } } : { status: 200, body: { value: null } };
    if (req.path.endsWith('/url')) return { status: 200, body: { value: null } };
    if (req.path.endsWith('/execute/sync')) return { status: 200, body: { value: opt.scripts ? opt.scripts(req.body.script, n++) : null } };
    if (req.path.endsWith('/element')) return { status: 200, body: { value: { [wd.ELEMENT_KEY]: 'E1' } } };
    if (req.path.endsWith('/frame')) return { status: 200, body: { value: null } };
    return { status: 404, body: { value: { error: 'unknown command' } } };
  };
}

describe('soak browser — the catalogue', () => {
  it('has an executor for every browser kind and nothing else', () => {
    assert.deepEqual(Object.keys(B).sort(), sched.TASKS.filter((t) => t.class === 'browser').map((t) => t.kind).sort());
  });

  it('refuses without a WebDriver, sending nothing', async () => {
    for (const run of Object.values(B)) {
      const f = fake({ api: () => ({ status: 200, body: {} }), wd: () => ({ status: 200, body: { value: null } }) });
      const c = ctx(f.fetch);
      c.local.webdriver = null;
      assert.equal((await run(c, { project: 'soak-a' })).code, O.NO_LOCAL_CONTROL);
      assert.equal(f.calls.length, 0);
    }
  });
});

describe('soak browser — dashboard load', () => {
  it('loads the dashboard and waits for its scripts to fill the uptime', async () => {
    const f = fake({ api: () => ({ status: 200, body: {} }), wd: driver({ scripts: (s, n) => (n < 2 ? '--' : ' 3m ') }) });
    const r = await B['browser.dashboard.load'](ctx(f.fetch));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.uptime, '3m');
    const nav = f.calls.find((c) => c.path.endsWith('/url'));
    assert.equal(nav.body.url, `${API}/`);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1);
    assert.equal(f.calls.filter((c) => c.origin === API).length, 0, 'the dashboard load goes through the browser only');
  });

  it('records a dashboard that never renders, and still ends the session', async () => {
    const f = fake({ api: () => ({ status: 200, body: {} }), wd: driver({ scripts: () => '--' }) });
    const r = await B['browser.dashboard.load'](ctx(f.fetch));
    assert.equal(r.code, O.NOT_RENDERED);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1);
  });

  it('says the setup wizard covered the dashboard, rather than that it never rendered', async () => {
    const f = fake({ api: () => ({ status: 200, body: {} }), wd: driver({ scripts: (s) => (s === B_PAGE_STATE ? { visibility: 'visible', wizard: true } : '--') }) });
    const r = await B['browser.dashboard.load'](ctx(f.fetch));
    assert.deepEqual([r.code, r.step, r.visibility], [O.SETUP_WIZARD, 'render', 'visible']);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1);
  });

  it('says the page was hidden, so its scripts were never drawn', async () => {
    const f = fake({ api: () => ({ status: 200, body: {} }), wd: driver({ scripts: (s) => (s === B_PAGE_STATE ? { visibility: 'hidden', wizard: false } : '--') }) });
    const r = await B['browser.dashboard.load'](ctx(f.fetch));
    assert.deepEqual([r.code, r.step, r.visibility], [O.PAGE_HIDDEN, 'render', 'hidden']);
  });

  it('keeps NOT_RENDERED for a visible page with no wizard, and when the page state cannot be read', async () => {
    let f = fake({ api: () => ({ status: 200, body: {} }), wd: driver({ scripts: (s) => (s === B_PAGE_STATE ? { visibility: 'visible', wizard: false } : '--') }) });
    let r = await B['browser.dashboard.load'](ctx(f.fetch));
    assert.deepEqual([r.code, r.visibility], [O.NOT_RENDERED, 'visible']);
    f = fake({ api: () => ({ status: 200, body: {} }), wd: driver({ scripts: (s) => (s === B_PAGE_STATE ? 'not an object' : '--') }) });
    r = await B['browser.dashboard.load'](ctx(f.fetch));
    assert.equal(r.code, O.NOT_RENDERED);
    assert.equal('visibility' in r, false);
  });

  it('records a WebDriver that will not start a session', async () => {
    const f = fake({ api: () => ({ status: 200, body: {} }), wd: driver({ newSession: { status: 500, body: { value: { error: 'session not created', message: 'Could not create a session' } } } }) });
    const r = await B['browser.dashboard.load'](ctx(f.fetch));
    assert.deepEqual([r.code, r.error, r.step], [wd.WD_OUTCOME.WD_ERROR, 'session not created', 'browser-session']);
    assert.equal(f.calls.some((c) => c.method === 'DELETE'), false);
  });

  it('records a WebDriver that cannot be reached', async () => {
    const f = fake({ api: () => ({ status: 200, body: {} }), wd: () => new Error('ECONNREFUSED') });
    const r = await B['browser.dashboard.load'](ctx(f.fetch));
    assert.equal(r.code, wd.WD_OUTCOME.WD_NETWORK);
  });

  it('flags a session it could not end', async () => {
    const f = fake({ api: () => ({ status: 200, body: {} }), wd: driver({ scripts: () => '1h', deleteFails: true }) });
    const r = await B['browser.dashboard.load'](ctx(f.fetch));
    assert.equal(r.ok, true);
    assert.equal(r.browserCleanupFailed, true);
  });
});

describe('soak browser — terminal attach', () => {
  /**
   * The guest API for one project: a session that launches and a pty counter.
   * @param {object} [opt] - `{counts, launchEngine, statusActive}`
   * @returns {(req: object) => object} Handler
   */
  function api(opt = {}) {
    let reads = 0;
    const counts = opt.counts || [{ instance: 'I1', attaches: 3 }, { instance: 'I1', attaches: 4 }];
    return (req) => {
      if (req.path === '/api/sessions/soak-a/status') return { status: 200, body: opt.statusActive ? { active: true, engine: 'claude' } : { active: false } };
      if (req.method === 'POST' && req.path === '/api/sessions/soak-a') return { status: 201, body: { tmuxSession: 'soak-a', engine: opt.launchEngine || ex.STUB_ENGINE_ID } };
      if (req.method === 'DELETE') return { status: 200, body: { ok: true } };
      if (req.path === '/api/system/pty-activity') return { status: 200, body: counts[Math.min(reads++, counts.length - 1)] };
      return { status: 404, body: {} };
    };
  }
  const scripts = (s) => (s.includes('getAttribute') ? '/terminal/?arg=soak-a' : true);

  it('renders the terminal and sees the server count the attach', async () => {
    const f = fake({ api: api(), wd: driver({ scripts }) });
    const r = await B['browser.terminal.attach'](ctx(f.fetch), { project: 'soak-a' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.attaches, 1);
    assert.equal(r.cleanupFailed, false);
    assert.equal(f.calls.find((c) => c.path.endsWith('/url')).body.url, `${API}/session/soak-a`);
    assert.deepEqual(f.calls.find((c) => c.path.endsWith('/frame')).body, { id: { [wd.ELEMENT_KEY]: 'E1' } });
    assert.ok(f.calls.some((c) => c.origin === API && c.method === 'DELETE'), 'kills its session');
    assert.ok(f.calls.some((c) => c.origin === WD && c.method === 'DELETE'), 'ends the browser session');
  });

  it('records a terminal the server never counted', async () => {
    const f = fake({ api: api({ counts: [{ instance: 'I1', attaches: 3 }] }), wd: driver({ scripts }) });
    const r = await B['browser.terminal.attach'](ctx(f.fetch), { project: 'soak-a' });
    assert.equal(r.code, O.NOT_ATTACHED);
    assert.equal(r.cleanupFailed, false);
  });

  it('does not count an attach across a server restart', async () => {
    const f = fake({ api: api({ counts: [{ instance: 'I1', attaches: 3 }, { instance: 'I2', attaches: 9 }] }), wd: driver({ scripts }) });
    const r = await B['browser.terminal.attach'](ctx(f.fetch), { project: 'soak-a' });
    assert.equal(r.code, O.SERVER_RESTARTED);
  });

  it('records a frame that never gets its terminal src', async () => {
    const f = fake({ api: api(), wd: driver({ scripts: () => null }) });
    const r = await B['browser.terminal.attach'](ctx(f.fetch), { project: 'soak-a' });
    assert.deepEqual([r.code, r.step], [O.NOT_RENDERED, 'frame']);
  });

  it('says the session page was hidden when its frame never got a src', async () => {
    const f = fake({ api: api(), wd: driver({ scripts: (s) => (s === B_PAGE_STATE ? { visibility: 'hidden', wizard: false } : null) }) });
    const r = await B['browser.terminal.attach'](ctx(f.fetch), { project: 'soak-a' });
    assert.deepEqual([r.code, r.step, r.visibility], [O.PAGE_HIDDEN, 'frame', 'hidden']);
    assert.equal(r.cleanupFailed, false);
  });

  it('never touches a session on another engine', async () => {
    const f = fake({ api: api({ statusActive: true }), wd: driver({ scripts }) });
    const r = await B['browser.terminal.attach'](ctx(f.fetch), { project: 'soak-a' });
    assert.equal(r.code, ex.OUTCOME.FOREIGN_SESSION);
    assert.equal(f.calls.length, 1);
  });

  it('refuses and kills a launch that is not on the stub engine, opening no browser', async () => {
    const f = fake({ api: api({ launchEngine: 'claude' }), wd: driver({ scripts }) });
    const r = await B['browser.terminal.attach'](ctx(f.fetch), { project: 'soak-a' });
    assert.equal(r.code, O.NOT_HARNESS_SESSION);
    assert.equal(f.calls.some((c) => c.origin === WD), false);
    assert.ok(f.calls.some((c) => c.method === 'DELETE'));
  });
});

describe('soak browser — WebDriver client', () => {
  it('reads a W3C error and a non-JSON body as outcomes', async () => {
    const c = { fetch: async () => ({ status: 404, text: async () => JSON.stringify({ value: { error: 'no such element', message: 'x' } }) }), local: { webdriver: WD } };
    assert.deepEqual(await wd.findElement(c, 'S', '.x'), { ok: false, code: wd.WD_OUTCOME.WD_ERROR, error: 'no such element' });
    c.fetch = async () => ({ status: 200, text: async () => 'not json' });
    assert.equal((await wd.execute(c, 'S', 'return 1')).code, wd.WD_OUTCOME.WD_BAD_BODY);
  });

  it('never follows a redirect', async () => {
    let init;
    const c = { fetch: async (u, i) => { init = i; return { status: 200, text: async () => '{"value":null}' }; }, local: { webdriver: WD } };
    await wd.navigate(c, 'S', `${API}/`);
    assert.equal(init.redirect, 'manual');
  });
});
