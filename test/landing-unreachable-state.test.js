'use strict';

/*
 * #709 — a dead server must not render as an endless "Connection lost.
 * Retrying…" toast behind a cached service-worker shell.
 *
 * The SW serves the app shell from cache with the backend completely gone, so
 * the page looks healthy while nothing behind it answers — and the toast said
 * exactly the same thing after one failure and after two hundred. Past a
 * bounded ceiling of consecutive failed reconnects, the client must stop
 * claiming a transient blip and render the real unreachable state: what host
 * it is trying, that the shell may be cached, and the concrete checks to run
 * on the machine. Recovery stays automatic; nothing reloads or redirects
 * (no-UI-timers norm, #98/#268).
 *
 * These tests LIFT the real functions out of public/landing.js and RUN them —
 * asserting on rendered state, since the whole defect is what the operator
 * sees. Same lift-and-run approach as test/degraded-reads-frontend.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LANDING_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
const API_HELPER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
const SW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text by
 * brace-matching, so the sandbox runs the REAL code rather than a copy.
 *
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find, e.g. `function esc(str)`.
 * @returns {string} The declaration plus its balanced body.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/** The real ceiling, read from the source so the test follows it. */
function realCeiling() {
  const m = LANDING_SRC.match(/const UNREACHABLE_AFTER = (\d+);/);
  assert.ok(m, 'UNREACHABLE_AFTER must be declared');
  return Number(m[1]);
}

/** A DOM element stub covering what the connection-state code touches. */
function makeElement(tag) {
  const classSet = new Set();
  return {
    tagName: tag,
    id: '',
    innerHTML: '',
    textContent: '',
    get className() { return [...classSet].join(' '); },
    set className(v) { classSet.clear(); v.split(/\s+/).filter(Boolean).forEach((c) => classSet.add(c)); },
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c)
    },
    setAttribute() {},
    appendChild() {}
  };
}

/**
 * Build a sandbox running the real connection-state functions with a
 * test-controlled `loadProjects`.
 *
 * @returns {object} The vm context, with `elements` registry attached.
 */
function loadConnectionState() {
  const elements = [makeElement('div')];
  elements[0].id = 'toast';

  const sandbox = {
    console,
    // The reconnect loop schedules with setTimeout; the tests drive attempts
    // by hand, so scheduling records nothing and never fires.
    setTimeout: () => 7, clearTimeout() {},
    state: { connected: true },
    location: { origin: 'https://tc.example:3102' },
    // Mirrors the real contract: api() flips connectivity through
    // setConnected, and loadProjects rides on api(). The test decides whether
    // the "server" answers.
    serverUp: false,
    document: {
      getElementById: (id) => elements.find((e) => e.id === id) || null,
      createElement: (tag) => makeElement(tag),
      body: { appendChild: (el) => { elements.push(el); } }
    }
  };
  sandbox.loadProjects = async () => { sandbox.setConnected(sandbox.serverUp); };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const script = [
    'let reconnectTimer = null;',
    'let reconnectFailures = 0;',
    `const UNREACHABLE_AFTER = ${realCeiling()};`,
    liftFunction(LANDING_SRC, 'function esc(str)'),
    liftFunction(LANDING_SRC, 'async function attemptReconnect()'),
    liftFunction(LANDING_SRC, 'function renderUnreachableState()'),
    liftFunction(LANDING_SRC, 'function hideUnreachableState()'),
    liftFunction(LANDING_SRC, 'async function retryConnectionNow()'),
    liftFunction(LANDING_SRC, 'function setConnected(connected)'),
    'globalThis.attemptReconnect = attemptReconnect;',
    'globalThis.setConnected = setConnected;',
    'globalThis.retryConnectionNow = retryConnectionNow;'
  ].join('\n');
  vm.runInContext(script, sandbox);

  sandbox.elements = elements;
  return sandbox;
}

const overlay = (ctx) => ctx.elements.find((e) => e.id === 'unreachableState');
const toast = (ctx) => ctx.elements.find((e) => e.id === 'toast');

describe('dead server escalates to an honest unreachable state (#709)', () => {
  it('holds the toast below the ceiling, then renders the unreachable state', async () => {
    const ctx = loadConnectionState();
    const N = realCeiling();
    ctx.setConnected(false);

    for (let i = 0; i < N - 1; i++) await ctx.attemptReconnect();
    assert.equal(overlay(ctx), undefined,
      `below ${N} failures this is still plausibly a blip — no overlay yet`);
    assert.equal(toast(ctx).classList.contains('visible'), true,
      'the retry toast carries the state until the ceiling');

    await ctx.attemptReconnect();
    assert.ok(overlay(ctx), 'the ceiling must produce the unreachable state');
    assert.equal(overlay(ctx).classList.contains('visible'), true);
    assert.equal(toast(ctx).classList.contains('visible'), false,
      'the ambiguous toast stops claiming a blip once the state is honest');
  });

  it('names the origin, the cached-shell possibility, and the concrete checks', async () => {
    const ctx = loadConnectionState();
    ctx.setConnected(false);
    for (let i = 0; i < realCeiling(); i++) await ctx.attemptReconnect();

    const html = overlay(ctx).innerHTML;
    assert.match(html, /https:\/\/tc\.example:3102/, 'must name what it is trying to reach');
    assert.match(html, /cache/i, 'must say the shell may be cached — the honest part');
    assert.match(html, /launchctl list \| grep tangleclaw/);
    assert.match(html, /server\.err\.log/);
    assert.match(html, /retryConnectionNow/, 'must offer an explicit retry action');
  });

  it('the Retry button shows the attempt in flight (operator feedback, #709 smoke)', async () => {
    const ctx = loadConnectionState();
    ctx.setConnected(false);
    for (let i = 0; i < realCeiling(); i++) await ctx.attemptReconnect();

    // The button the overlay's markup renders, registered as the DOM would.
    const btn = makeElement('button');
    btn.id = 'unreachableRetryBtn';
    btn.textContent = 'Retry now';
    btn.disabled = false;
    ctx.elements.push(btn);

    // A slow server answer: the press must read as working, not dead.
    let release;
    ctx.loadProjects = () => new Promise((resolve) => {
      release = () => { ctx.setConnected(false); resolve(); };
    });
    const pressed = ctx.retryConnectionNow();
    await new Promise((r) => setImmediate(r));
    assert.equal(btn.disabled, true, 'the press must disable the button while in flight');
    assert.equal(btn.textContent, 'Retrying…', 'the pause must say it is working');

    release();
    await pressed;
    assert.equal(btn.disabled, false, 'a failed attempt re-arms the button');
    assert.equal(btn.textContent, 'Retry now');
  });

  it('recovers automatically and re-arms the ceiling', async () => {
    const ctx = loadConnectionState();
    ctx.setConnected(false);
    for (let i = 0; i < realCeiling(); i++) await ctx.attemptReconnect();
    assert.equal(overlay(ctx).classList.contains('visible'), true);

    // The server comes back: the next background attempt succeeds.
    ctx.serverUp = true;
    await ctx.attemptReconnect();
    assert.equal(overlay(ctx).classList.contains('visible'), false,
      'recovery must dismiss the state without any operator action');

    // The counter reset: a fresh outage gets a fresh ceiling, not an instant overlay.
    ctx.serverUp = false;
    ctx.setConnected(false);
    await ctx.attemptReconnect();
    assert.equal(overlay(ctx).classList.contains('visible'), false,
      'one failure after recovery is a blip again');
  });

  it('never reloads or redirects out of the unreachable state', () => {
    runNavigationPin();
  });
});

/** Shared by both suites: the three owning functions must not navigate. */
function runNavigationPin() {
  for (const decl of ['function renderUnreachableState()',
    'function hideUnreachableState()', 'async function retryConnectionNow()']) {
    const body = liftFunction(LANDING_SRC, decl);
    assert.doesNotMatch(body, /location\.reload|location\.href\s*=|location\.assign/,
      `${decl} must not navigate for the operator`);
  }
}

/*
 * The service-worker reality (Critic R-1 on the first round of this change):
 * on a SW-controlled page a dead server never REJECTS an /api fetch — sw.js
 * resolves it as either a cache-served 200 or a synthetic 503. The first
 * version of the escalation counted only fetch rejections, so the overlay was
 * unreachable in the exact scenario #709 names, and the tests above masked it
 * by synthesizing the connectivity signal. This suite drives the WHOLE chain —
 * the real sw.js response builders, the real api() from api-helper.js, the
 * real setConnected/attemptReconnect — with fetch resolving the shapes sw.js
 * actually produces.
 */

/**
 * Build the full client chain with a controllable fetch.
 *
 * @param {Function} fetchImpl - What the "service worker" hands the page.
 * @returns {object} vm context with `elements` attached.
 */
function loadFullChain(fetchImpl) {
  const elements = [makeElement('div')];
  elements[0].id = 'toast';
  const sandbox = {
    console, setTimeout: () => 7, clearTimeout() {},
    Response, Headers,
    state: { connected: true },
    location: { origin: 'https://tc.example:3102' },
    fetch: fetchImpl,
    document: {
      getElementById: (id) => elements.find((e) => e.id === id) || null,
      createElement: (tag) => makeElement(tag),
      body: { appendChild: (el) => { elements.push(el); } }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(API_HELPER_SRC, sandbox);
  vm.runInContext([
    'let reconnectTimer = null;',
    'let reconnectFailures = 0;',
    `const UNREACHABLE_AFTER = ${realCeiling()};`,
    liftFunction(LANDING_SRC, 'function esc(str)'),
    liftFunction(LANDING_SRC, 'async function attemptReconnect()'),
    liftFunction(LANDING_SRC, 'function renderUnreachableState()'),
    liftFunction(LANDING_SRC, 'function hideUnreachableState()'),
    liftFunction(LANDING_SRC, 'function setConnected(connected)'),
    // The page's real wiring shape: api() is created from the factory with
    // the page's setConnected, and loadProjects rides on it.
    'const api = tcCreateApi({ setConnected });',
    'async function loadProjects() { await api("/api/projects"); }',
    'globalThis.api = api;',
    'globalThis.attemptReconnect = attemptReconnect;',
    'globalThis.setConnected = setConnected;'
  ].join('\n'), sandbox);
  sandbox.elements = elements;
  return sandbox;
}

/** The REAL sw.js builders, lifted and run so the shapes cannot drift. */
function swBuilders() {
  const ctx = { Response, Headers, JSON, String };
  vm.createContext(ctx);
  vm.runInContext([
    liftFunction(SW_SRC, 'function _swErrorResponse(err)'),
    liftFunction(SW_SRC, 'function _withCacheFallbackMarker(cached)'),
    'globalThis.err = _swErrorResponse; globalThis.mark = _withCacheFallbackMarker;'
  ].join('\n'), ctx);
  return ctx;
}

describe('escalation works through the real service-worker response shapes (#709 R-1)', () => {
  it('the synthetic 503 counts as disconnected and reaches the overlay', async () => {
    const sw = swBuilders();
    const ctx = loadFullChain(async () => sw.err(new Error('Failed to fetch')));

    for (let i = 0; i < realCeiling(); i++) await ctx.attemptReconnect();

    assert.equal(ctx.state.connected, false,
      'a resolved 503 from the SW is a dead server, not a served answer');
    assert.ok(overlay(ctx), 'the ceiling must be reachable through the SW 503 shape');
    assert.equal(overlay(ctx).classList.contains('visible'), true);
  });

  it('a cache-served 200 is stale, not live: disconnected, no data, overlay reachable', async () => {
    const sw = swBuilders();
    const cached = new Response(JSON.stringify({ projects: [{ name: 'old' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    const served = sw.mark(cached);
    const ctx = loadFullChain(async () => served.clone());

    const first = await ctx.api('/api/projects');
    assert.equal(first, null,
      'cache-fallback data must not be handed to the renderer as a live answer');
    assert.equal(ctx.state.connected, false,
      'a marked cache fallback means the server did not answer');

    for (let i = 0; i < realCeiling(); i++) await ctx.attemptReconnect();
    assert.ok(overlay(ctx), 'the ceiling must be reachable through the cache-fallback shape');
    assert.equal(overlay(ctx).classList.contains('visible'), true);
  });

  it('a genuine 200 still connects and recovers from the overlay', async () => {
    const sw = swBuilders();
    let serverUp = false;
    const ctx = loadFullChain(async () => serverUp
      ? new Response(JSON.stringify({ projects: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
      : sw.err(new Error('Failed to fetch')));

    for (let i = 0; i < realCeiling(); i++) await ctx.attemptReconnect();
    assert.equal(overlay(ctx).classList.contains('visible'), true);

    serverUp = true;
    await ctx.attemptReconnect();
    assert.equal(ctx.state.connected, true, 'a real answer reconnects');
    assert.equal(overlay(ctx).classList.contains('visible'), false,
      'recovery through the real api() dismisses the state');
  });

  it('the marker survives the real sw.js copy and the real api() reads it', async () => {
    const sw = swBuilders();
    const cached = new Response('{}', { status: 200 });
    const served = sw.mark(cached);
    assert.equal(served.headers.get('X-TC-Cache-Fallback'), '1',
      'sw.js must mark what it serves in place of a dead network');
    assert.equal(served.status, 200, 'the stand-in keeps the cached status');
  });
});

/*
 * The proxied reality (#924, operator-observed): behind the Caddy ingress a
 * dead backend is not a failed fetch either — the gate ANSWERS for it with a
 * 502/503/504 whose body is empty or HTML. During the 2026-08-14 live smoke a
 * 40-second backend outage on the gate origin produced no toast and no
 * unreachable card; the dashboard looked connected throughout. The JSON test
 * is the discriminator: the server's own meaningful 5xxs (health 503,
 * tmux-dependency 503, Medusa-hub 502) are always `{error, code}` JSON and
 * must keep surfacing as route errors, never as outages.
 */
describe('escalation works through the gateway shapes (#924)', () => {
  // Verbatim what Caddy's reverse_proxy answers for a dead upstream: 502,
  // empty body, no content-type. `null` body, not '' — a string body makes
  // Response auto-attach text/plain, and the point is the header's absence.
  const caddy502 = () => new Response(null, { status: 502, statusText: 'Bad Gateway' });

  it('a gateway 502 counts as disconnected and reaches the overlay', async () => {
    const ctx = loadFullChain(async () => caddy502());

    const first = await ctx.api('/api/projects');
    assert.equal(first, null, 'a gateway page is not data');
    assert.equal(ctx.state.connected, false,
      'the gate answering FOR the backend is the backend not answering');

    for (let i = 0; i < realCeiling(); i++) await ctx.attemptReconnect();
    assert.ok(overlay(ctx), 'the ceiling must be reachable through the proxied shape');
    assert.equal(overlay(ctx).classList.contains('visible'), true);
  });

  it('an HTML 503/504 from the gate counts as disconnected too', async () => {
    for (const status of [503, 504]) {
      const ctx = loadFullChain(async () => new Response('<html><body>error</body></html>',
        { status, headers: { 'Content-Type': 'text/html' } }));
      await ctx.api('/api/projects');
      assert.equal(ctx.state.connected, false, `HTML ${status} must classify as an outage`);
    }
  });

  it("the server's own JSON 5xxs stay route errors, never outages", async () => {
    // The real shapes lib/errorResponse produces: tmux-dependency 503 and
    // Medusa-hub 502, both JSON with {error, code}.
    const shapes = [
      [503, { error: 'tmux did not answer', code: 'TMUX_UNAVAILABLE' }],
      [502, { error: 'Medusa hub unreachable', code: 'MEDUSA_SEND_FAILED' }]
    ];
    for (const [status, body] of shapes) {
      const ctx = loadFullChain(async () => new Response(JSON.stringify(body),
        { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
      const out = await ctx.api('/api/medusa-ish');
      assert.equal(out, null);
      assert.equal(ctx.state.connected, true,
        `a JSON ${status} is the server SPEAKING — it must not flip connectivity`);
      assert.equal(ctx.api.lastError, body.error, 'the route error must surface');
      assert.equal(ctx.api.lastErrorCode, body.code);
    }
  });

  it('recovery still works after a gateway outage', async () => {
    let gatewayDown = true;
    const ctx = loadFullChain(async () => gatewayDown
      ? caddy502()
      : new Response(JSON.stringify({ projects: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));

    for (let i = 0; i < realCeiling(); i++) await ctx.attemptReconnect();
    assert.equal(overlay(ctx).classList.contains('visible'), true);

    gatewayDown = false;
    await ctx.attemptReconnect();
    assert.equal(ctx.state.connected, true);
    assert.equal(overlay(ctx).classList.contains('visible'), false,
      'the backend returning through the gate dismisses the state');
  });
});

describe('unreachable-state functions never navigate (source pin)', () => {
  it('never reloads or redirects out of the unreachable state', () => {
    // The no-UI-timers norm (#98, #268): honest state plus explicit user
    // action, not a blind refresh. Pinned against the source of the three
    // functions that own this state.
    for (const decl of ['function renderUnreachableState()',
      'function hideUnreachableState()', 'async function retryConnectionNow()']) {
      const body = liftFunction(LANDING_SRC, decl);
      assert.doesNotMatch(body, /location\.reload|location\.href\s*=|location\.assign/,
        `${decl} must not navigate for the operator`);
    }
  });
});
