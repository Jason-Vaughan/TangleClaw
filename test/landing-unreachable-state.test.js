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
