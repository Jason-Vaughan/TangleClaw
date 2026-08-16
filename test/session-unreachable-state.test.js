'use strict';

/*
 * #941 — the session page must stop looping "Connection lost. Retrying…"
 * forever against a dead server.
 *
 * #709 built the escalation on the dashboard only, so a session tab kept
 * claiming a transient blip indefinitely behind a cached service-worker shell
 * — the exact symptom #709 was filed to kill, on the surface the operator
 * actually works in.
 *
 * The shape here is deliberately NOT the dashboard's. The dashboard covers its
 * controls with a full-screen overlay, which is honest because every control
 * under it depends on the server that just died. The session page embeds ttyd
 * in an iframe on a SEPARATE PORT: the API can be unreachable while the
 * terminal is perfectly alive and the operator is mid-command. Covering it
 * would assert something this page cannot establish — that the session is gone
 * — so the escalation is a banner that takes space from the terminal instead
 * of covering it, and names the two axes separately.
 *
 * The "does not cover the terminal" guarantee is structural, not visual: there
 * is no layout engine here, so it is pinned as the two properties that make it
 * true — the banner is a flow sibling ordered before the terminal viewport,
 * and it is not positioned out of flow.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeElement, makeDocument } = require('./_mini-dom');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const SESSION_SRC = pub('session.js');
const SESSION_HTML = pub('session.html');
const SESSION_CSS = pub('session.css');
const RECONNECT_SRC = pub('reconnect-policy.js');

/**
 * Slice a top-level function (declaration + body) out of source text.
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find.
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

/**
 * Slice a top-level call statement out of source text by paren-matching, so
 * the test drives the page's OWN policy construction rather than a copy.
 * @param {string} src - File source text.
 * @param {string} head - Statement head.
 * @returns {string} The statement through its balanced closing paren + `;`.
 */
function liftCall(src, head) {
  const start = src.indexOf(head);
  assert.notEqual(start, -1, `${head} must exist`);
  const open = src.indexOf('(', start + head.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return `${src.slice(start, i + 1)};`;
  }
  assert.fail(`${head} call must close`);
}

/** The real ceiling in ms, read from the policy source so the test follows it. */
function realCeilingMs() {
  const m = RECONNECT_SRC.match(/const DEFAULT_CEILING_MS = (\d+);/);
  assert.ok(m, 'DEFAULT_CEILING_MS must be declared');
  return Number(m[1]);
}

/**
 * Build a sandbox running the session page's real connection-state code.
 * @returns {object} vm context with `ids` and clock controls attached.
 */
function loadSessionConnectionState() {
  // The page's real static mount points, including the terminal the banner
  // must never displace.
  const { doc, ids } = makeDocument(
    ['toast', 'statusDot', 'commandSend', 'sessionUnreachable', 'terminalFrame']);

  const state = { clock: 0, pending: [], probes: 0, serverUp: false };
  const sandbox = {
    console, Math,
    Date: { now: () => state.clock },
    setTimeout: (fn, ms) => { state.pending.push({ fn, ms }); return state.pending.length; },
    clearTimeout: () => { state.pending.length = 0; },
    sessionState: { connected: true },
    location: { origin: 'https://tc.example:3102' },
    document: doc
  };
  sandbox.pollStatus = async () => {
    state.probes++;
    sandbox.setConnected(state.serverUp);
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RECONNECT_SRC, sandbox);
  vm.runInContext([
    liftFunction(SESSION_SRC, 'function esc(str)'),
    liftFunction(SESSION_SRC, 'function renderSessionUnreachable()'),
    liftFunction(SESSION_SRC, 'function hideSessionUnreachable()'),
    liftCall(SESSION_SRC, 'const reconnectPolicy = tcCreateReconnectPolicy('),
    liftFunction(SESSION_SRC, 'async function retrySessionConnectionNow()'),
    liftFunction(SESSION_SRC, 'function setConnected(connected)'),
    'globalThis.reconnectPolicy = reconnectPolicy;',
    'globalThis.setConnected = setConnected;',
    'globalThis.retrySessionConnectionNow = retrySessionConnectionNow;'
  ].join('\n'), sandbox);

  sandbox.ids = ids;
  sandbox.state = state;
  sandbox.advance = (ms) => { state.clock += ms; };
  return sandbox;
}

const banner = (ctx) => ctx.ids.sessionUnreachable;
const toast = (ctx) => ctx.ids.toast;

/** Let the outage outlive the ceiling, then probe. */
async function probePastCeiling(ctx) {
  ctx.advance(realCeilingMs());
  await ctx.reconnectPolicy.retryNow();
}

describe('a dead API escalates on the session page too (#941)', () => {
  it('holds the toast below the ceiling, then raises the banner', async () => {
    const ctx = loadSessionConnectionState();
    ctx.setConnected(false);

    ctx.advance(Math.floor(realCeilingMs() / 3));
    await ctx.reconnectPolicy.retryNow();
    assert.equal(banner(ctx).classList.contains('visible'), false,
      'below the ceiling this is still plausibly a blip');
    assert.equal(toast(ctx).classList.contains('visible'), true);

    await probePastCeiling(ctx);
    assert.equal(banner(ctx).classList.contains('visible'), true,
      'past the ceiling the session page must stop claiming a blip');
    assert.equal(toast(ctx).classList.contains('visible'), false,
      'the toast and the banner answer the same question — leaving "Retrying…" '
      + 'pinned above the banner says both at once');
  });

  it('names what is unknown: the API is down, the terminal may still be live', async () => {
    const ctx = loadSessionConnectionState();
    ctx.setConnected(false);
    await probePastCeiling(ctx);

    const html = banner(ctx).innerHTML;
    assert.match(html, /https:\/\/tc\.example:3102/, 'must name what it is trying to reach');
    assert.match(html, /cache/i, 'must say the shell may be stale');
    assert.match(html, /terminal below/i,
      'must say the terminal is a separate thing — the whole reason this is a banner');
    assert.match(html, /can't tell|cannot tell/i,
      'must state the unknown as an unknown, not guess at it');
    assert.match(html, /launchctl list \| grep tangleclaw/);
    assert.match(html, /server\.err\.log/);
    assert.match(html, /retrySessionConnectionNow/, 'must offer an explicit retry action');
  });

  it('recovers automatically and re-arms the ceiling', async () => {
    const ctx = loadSessionConnectionState();
    ctx.setConnected(false);
    await probePastCeiling(ctx);
    assert.equal(banner(ctx).classList.contains('visible'), true);

    ctx.state.serverUp = true;
    await ctx.reconnectPolicy.retryNow();
    assert.equal(banner(ctx).classList.contains('visible'), false,
      'recovery dismisses the banner without any operator action');
    assert.equal(ctx.sessionState.connected, true);

    ctx.state.serverUp = false;
    ctx.setConnected(false);
    ctx.advance(1000);
    await ctx.reconnectPolicy.retryNow();
    assert.equal(banner(ctx).classList.contains('visible'), false,
      'one failure after recovery is a blip again');
  });

  it('the Retry button shows the attempt in flight', async () => {
    const ctx = loadSessionConnectionState();
    ctx.setConnected(false);
    await probePastCeiling(ctx);

    assert.match(banner(ctx).innerHTML, /id="sessionUnreachableRetryBtn"/,
      'the fixture id must match the id the rendered banner actually carries');
    // The button must reuse session.css's own button system: it is the only
    // recovery control in a role="alert" region on a touch-first surface, so it
    // needs `.btn`'s 44px min-height and its focus-visible outline. A
    // hand-rolled lookalike loses both silently.
    assert.match(banner(ctx).innerHTML, /class="btn btn-danger"/,
      'the retry control must carry the shared button classes, not bespoke styling');
    const btn = makeElement('button', ctx.document);
    btn.id = 'sessionUnreachableRetryBtn';
    btn.textContent = 'Retry now';
    ctx.ids.sessionUnreachableRetryBtn = btn;

    let release;
    ctx.pollStatus = () => new Promise((resolve) => {
      release = () => { ctx.setConnected(false); resolve(); };
    });
    const pressed = ctx.retrySessionConnectionNow();
    await new Promise((r) => setImmediate(r));
    assert.equal(btn.disabled, true, 'the press must disable the button while in flight');
    assert.equal(btn.textContent, 'Retrying…');

    release();
    await pressed;
    assert.equal(btn.disabled, false, 'a failed attempt re-arms the button');
    assert.equal(btn.textContent, 'Retry now');
  });

  it('renders its markup once, not on every escalation', async () => {
    const ctx = loadSessionConnectionState();
    ctx.setConnected(false);
    await probePastCeiling(ctx);
    const first = banner(ctx).innerHTML;
    ctx.renderSessionUnreachable = undefined; // not used; guard against accidental reliance
    banner(ctx).classList.remove('visible');
    await probePastCeiling(ctx);
    assert.equal(banner(ctx).innerHTML, first,
      're-rendering must not duplicate or churn the banner content');
  });
});

describe('the banner must never cover the terminal (#941 design constraint)', () => {
  it('is a flow sibling ordered before the terminal viewport', () => {
    const bannerAt = SESSION_HTML.indexOf('id="sessionUnreachable"');
    const viewportAt = SESSION_HTML.indexOf('id="terminalViewport"');
    assert.ok(bannerAt !== -1, 'the session page must carry the banner mount point');
    assert.ok(viewportAt !== -1, 'the terminal viewport must still exist');
    assert.ok(bannerAt < viewportAt,
      'the banner must precede the terminal in flow so it shortens it rather than covering it');
  });

  it('is not positioned out of the document flow', () => {
    // `position: fixed/absolute` — or a full-bleed `inset: 0` — is precisely
    // how the dashboard's overlay covers what is under it. Doing that here
    // would hide a terminal that may still be working.
    const start = SESSION_CSS.indexOf('.session-unreachable {');
    assert.notEqual(start, -1, '.session-unreachable must be styled');
    const block = SESSION_CSS.slice(start, SESSION_CSS.indexOf('}', start));
    assert.doesNotMatch(block, /position\s*:\s*(fixed|absolute)/,
      'the banner must stay in flow — an out-of-flow banner covers the terminal');
    assert.doesNotMatch(block, /inset\s*:\s*0/,
      'a full-bleed inset is an overlay by another name');
    assert.match(block, /flex-shrink\s*:\s*0/,
      'the banner must hold its height so the flex column shortens the terminal instead');
    assert.match(block, /display\s*:\s*none/,
      'a healthy session must render nothing here');
  });

  it('does not disable the terminal or the page beneath it', () => {
    // The controls that genuinely cannot work without the API (command send)
    // are disabled by setConnected; nothing else should be.
    const render = liftFunction(SESSION_SRC, 'function renderSessionUnreachable()');
    assert.doesNotMatch(render, /terminalFrame|terminalViewport/,
      'the escalation must not touch the terminal it cannot make claims about');
    assert.doesNotMatch(render, /\.src\s*=/,
      'the escalation must never tear down the terminal iframe');
  });
});

describe('session escalation never navigates for the operator (source pin)', () => {
  it('no reload, redirect or assignment out of the state', () => {
    // The no-UI-timers norm (#98, #268): honest state plus explicit user
    // action, not a blind refresh.
    for (const decl of ['function renderSessionUnreachable()',
      'function hideSessionUnreachable()', 'async function retrySessionConnectionNow()']) {
      const body = liftFunction(SESSION_SRC, decl);
      assert.doesNotMatch(body, /location\.reload|location\.href\s*=|location\.assign/,
        `${decl} must not navigate for the operator`);
    }
  });
});
