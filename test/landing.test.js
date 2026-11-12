'use strict';

// #3029: landing.js loads before ui.js, and init() used to read ui.js's
// `renderCard` straight after its first await, assuming the parser had run
// ui.js by then. On a fast loopback or a service-worker cache hit it had
// not: the read threw `ReferenceError: renderCard is not defined` and
// aborted the rest of init(). These tests lift the two helpers that replace
// that assumption and run them against a fake document whose `ui.js` only
// "loads" (defines renderCard) after the helpers start waiting.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { liftDeclaration } = require('./_page-globals');

const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

/**
 * A vm context holding the two lifted helpers and a stubbed
 * `renderHeldWakeBadge` (a free variable of the wrapper).
 * @param {{badge?: string|null}} [opts]
 * @returns {object}
 */
function context({ badge = '<b class="held">held</b>' } = {}) {
  const warnings = [];
  const win = {};
  const ctx = vm.createContext({
    console: { warn: (msg) => warnings.push(String(msg)) },
    renderHeldWakeBadge: () => badge,
    window: win,
    Promise
  });
  vm.runInContext([
    liftDeclaration(LANDING_SRC, 'function whenPageScriptsLoaded('),
    liftDeclaration(LANDING_SRC, 'function wrapRenderCardWithHeldWakeBadge('),
    'this.whenPageScriptsLoaded = whenPageScriptsLoaded;',
    'this.wrapRenderCardWithHeldWakeBadge = wrapRenderCardWithHeldWakeBadge;'
  ].join('\n'), ctx);
  ctx.warnings = warnings;
  ctx.win = win;
  return ctx;
}

/**
 * A fake document that is still `loading` until `finishParsing()` runs,
 * which fires DOMContentLoaded exactly as a real parser would after the
 * last classic script.
 * @returns {{doc: object, finishParsing: Function}}
 */
function parsingDocument() {
  const listeners = [];
  const doc = {
    readyState: 'loading',
    addEventListener(type, fn, opts) {
      assert.equal(type, 'DOMContentLoaded');
      assert.deepEqual(JSON.parse(JSON.stringify(opts)), { once: true });
      listeners.push(fn);
    }
  };
  return { doc, finishParsing() { doc.readyState = 'interactive'; for (const fn of listeners.splice(0)) fn(); } };
}

const CARD = (p) => `<div class="card">${p.name}<span class="card-row-actions">x</span></div>`;

describe('whenPageScriptsLoaded (#3029)', () => {
  it('resolves at once when the document is already parsed', async () => {
    const ctx = context();
    for (const readyState of ['interactive', 'complete']) {
      await ctx.whenPageScriptsLoaded({ readyState, addEventListener() { throw new Error('must not wait'); } });
    }
  });

  it('waits for DOMContentLoaded while the document is still loading', async () => {
    const ctx = context();
    const { doc, finishParsing } = parsingDocument();
    let resolved = false;
    const waiting = ctx.whenPageScriptsLoaded(doc).then(() => { resolved = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false, 'must not resolve before the parser has run every classic script');
    finishParsing();
    await waiting;
    assert.equal(resolved, true);
  });
});

describe('wrapRenderCardWithHeldWakeBadge (#3029, #2578)', () => {
  it('a missing renderCard is warned about and skipped, never thrown', () => {
    const ctx = context();
    const win = ctx.win;
    assert.equal(ctx.wrapRenderCardWithHeldWakeBadge(), false);
    assert.equal(win.renderCard, undefined);
    assert.match(ctx.warnings[0], /renderCard is not defined/);
  });

  it('wraps renderCard to inject the held-wake badge before card-row-actions', () => {
    const ctx = context();
    const win = ctx.win;
    win.renderCard = CARD;
    assert.equal(ctx.wrapRenderCardWithHeldWakeBadge(), true);
    assert.equal(win.renderCard({ name: 'p' }), '<div class="card">p<b class="held">held</b><span class="card-row-actions">x</span></div>');
  });

  it('leaves a card unchanged when there is no badge', () => {
    const ctx = context({ badge: null });
    const win = ctx.win;
    win.renderCard = CARD;
    ctx.wrapRenderCardWithHeldWakeBadge();
    assert.equal(win.renderCard({ name: 'p' }), CARD({ name: 'p' }));
  });

  it('is idempotent: a second call never double-injects the badge', () => {
    const ctx = context();
    const win = ctx.win;
    win.renderCard = CARD;
    ctx.wrapRenderCardWithHeldWakeBadge();
    const once = win.renderCard;
    assert.equal(ctx.wrapRenderCardWithHeldWakeBadge(), true);
    assert.equal(win.renderCard, once);
    assert.equal(win.renderCard({ name: 'p' }).match(/class="held"/g).length, 1);
  });
});

describe('the #3029 race, reproduced end to end', () => {
  it('ui.js arriving after landing.js starts waiting is still wrapped, with no throw', async () => {
    const ctx = context();
    const { doc, finishParsing } = parsingDocument();
    const win = ctx.win;
    // init() as it now runs: wait for every classic script, then wrap.
    const boot = ctx.whenPageScriptsLoaded(doc).then(() => ctx.wrapRenderCardWithHeldWakeBadge());
    await new Promise((r) => setImmediate(r));
    win.renderCard = CARD; // ui.js executes later in the parse
    finishParsing();
    assert.equal(await boot, true);
    assert.match(win.renderCard({ name: 'p' }), /class="held"/);
    assert.deepEqual(ctx.warnings, []);
  });

  it('init() waits for the page scripts before wrapping, and no longer reads a bare renderCard', () => {
    const body = liftDeclaration(LANDING_SRC, 'async function init()');
    const waitIdx = body.indexOf('await whenPageScriptsLoaded(document)');
    const wrapIdx = body.indexOf('wrapRenderCardWithHeldWakeBadge()');
    assert.ok(waitIdx > -1 && wrapIdx > waitIdx, 'init() must await the page scripts before wrapping renderCard');
    assert.doesNotMatch(body, /=\s*renderCard\s*;/, 'init() must not read the bare renderCard global itself');
  });
});
