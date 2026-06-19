'use strict';

/*
 * Frontend regression tests for #162 — OpenClaw Web UI dashboard cached its
 * derived WebSocket URL in localStorage on the TC origin, then a subsequent
 * load of a *different* OpenClaw connection re-used the stale URL and routed
 * traffic to the wrong tunnel. Fix: clear stale entries before navigating the
 * iframe; the dashboard JS running inside the iframe falls through to
 * deriving its URL fresh from the iframe's own location.
 *
 * Both behavioural tests (against a mock Storage) and source-level structural
 * assertions (that openclaw-view.html loads the helper script, that
 * openclaw-view.js actually calls the helper before frame.src is set).
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { clearStaleOpenclawCache } = require('../public/openclaw-cache.js');

/**
 * Minimal in-memory Storage shim with the same surface clearStaleOpenclawCache uses:
 *   length, key(i), getItem(k), removeItem(k), setItem(k, v).
 */
function makeStorage(initial) {
  const data = new Map();
  for (const [k, v] of Object.entries(initial || {})) data.set(k, v);
  return {
    get length() { return data.size; },
    key(i) {
      let n = 0;
      for (const k of data.keys()) {
        if (n === i) return k;
        n++;
      }
      return null;
    },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); }
  };
}

describe('clearStaleOpenclawCache (#162)', () => {
  const CURRENT = '90df52c9-3782-4ad0-8dc2-927ef4d57f89'; // Claw-Node-01
  const STALE = '7923a71f-b6da-49a3-805a-b063c3b22af8';   // RentalClaw

  it('removes localStorage entries whose values reference a different openclaw-direct connId', () => {
    const storage = makeStorage({
      'oc-gateway-url': `wss://192.168.10.99:3102/openclaw-direct/${STALE}`,
      'oc-pairing-token': 'abcdef'
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 1, 'one mismatched entry removed');
    assert.equal(storage.getItem('oc-gateway-url'), null);
    assert.equal(storage.getItem('oc-pairing-token'), 'abcdef',
      'unrelated entry preserved');
  });

  it('preserves entries whose values match the current connId (idempotent on same connection)', () => {
    const storage = makeStorage({
      'oc-gateway-url': `wss://192.168.10.99:3102/openclaw-direct/${CURRENT}`,
      'oc-prefs': '{"theme":"dark"}'
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 0);
    assert.equal(storage.getItem('oc-gateway-url'),
      `wss://192.168.10.99:3102/openclaw-direct/${CURRENT}`);
    assert.equal(storage.getItem('oc-prefs'), '{"theme":"dark"}');
  });

  it('leaves unrelated localStorage entries alone (TC settings, third-party widgets, etc.)', () => {
    const storage = makeStorage({
      'tc_my-project_panel': '"open"',
      'tc_showUnregistered': 'true',
      'tc_updateDismissed_3.16.0': '1'
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 0, 'no openclaw-direct refs anywhere → nothing removed');
    assert.equal(storage.getItem('tc_my-project_panel'), '"open"');
    assert.equal(storage.getItem('tc_showUnregistered'), 'true');
    assert.equal(storage.getItem('tc_updateDismissed_3.16.0'), '1');
  });

  it('handles multiple stale entries in one pass (e.g. cached wsUrl + cached signer URL)', () => {
    const storage = makeStorage({
      'oc-gateway-url': `wss://host/openclaw-direct/${STALE}`,
      'oc-signer-url': `https://host/openclaw-direct/${STALE}/sign`,
      'oc-some-other-state': '{"foo":"bar"}'
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 2);
    assert.equal(storage.getItem('oc-gateway-url'), null);
    assert.equal(storage.getItem('oc-signer-url'), null);
    assert.equal(storage.getItem('oc-some-other-state'), '{"foo":"bar"}',
      'entries not referencing openclaw-direct preserved');
  });

  it('walks safely while removing — does not skip live mutations', () => {
    // Critical: if you iterate forward and removeItem() during the loop,
    // entries get skipped because indices shift. clearStaleOpenclawCache walks
    // BACKWARDS specifically to avoid this. Pin the contract.
    const storage = makeStorage({
      'a': `wss://h/openclaw-direct/${STALE}/a`,
      'b': `wss://h/openclaw-direct/${STALE}/b`,
      'c': `wss://h/openclaw-direct/${STALE}/c`,
      'd': `wss://h/openclaw-direct/${STALE}/d`
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 4, 'all four mismatched entries removed (none skipped)');
    assert.equal(storage.length, 0);
  });

  it('ignores non-string values without throwing', () => {
    const storage = makeStorage({});
    // Most Storage implementations coerce to string, but a custom Storage
    // shim or a corrupted serialization could surface a non-string.
    storage.getItem = (k) => (k === 'broken' ? { not: 'a string' } : null);
    storage.key = (i) => (i === 0 ? 'broken' : null);
    Object.defineProperty(storage, 'length', { get: () => 1 });
    assert.doesNotThrow(() => clearStaleOpenclawCache(CURRENT, storage));
  });

  it('returns 0 when storage is null/undefined (e.g. incognito or disabled)', () => {
    assert.equal(clearStaleOpenclawCache(CURRENT, null), 0);
    assert.equal(clearStaleOpenclawCache(CURRENT, undefined), 0);
  });

  it('returns 0 when storage access throws (incognito on Safari, etc.)', () => {
    const storage = makeStorage({});
    Object.defineProperty(storage, 'length', { get: () => { throw new Error('access denied'); } });
    assert.equal(clearStaleOpenclawCache(CURRENT, storage), 0);
  });

  it('returns 0 when currentConnId is empty/missing (defensive against an unbound route)', () => {
    const storage = makeStorage({
      'oc-gateway-url': `wss://h/openclaw-direct/${STALE}`
    });
    assert.equal(clearStaleOpenclawCache('', storage), 0,
      'empty connId — refuse to touch anything');
    assert.equal(clearStaleOpenclawCache(undefined, storage), 0);
    assert.equal(clearStaleOpenclawCache(null, storage), 0);
    assert.equal(storage.getItem('oc-gateway-url'),
      `wss://h/openclaw-direct/${STALE}`,
      'storage untouched on a defensive no-op');
  });

  it('compares connId case-insensitively (UUIDs are case-insensitive per RFC 4122)', () => {
    // Critic MAJOR-3: uppercase / mixed-case UUIDs from the dashboard must
    // be treated as the SAME connection, not classified as stale. Previously
    // the comparison was strict-equality which would have over-deleted
    // legitimate same-connection state if OpenClaw ever emitted a non-
    // lowercase UUID.
    const upper = STALE.toUpperCase();
    const storage = makeStorage({
      'oc-gateway-url': `wss://h/openclaw-direct/${upper}`,
      'oc-mixed-case': `wss://h/openclaw-direct/${STALE.slice(0, 4).toUpperCase()}${STALE.slice(4)}`
    });
    // currentConnId is lowercase; cached values are uppercase/mixed of the
    // SAME id. They are the current connection, not stale — preserve them.
    const removed = clearStaleOpenclawCache(STALE, storage);
    assert.equal(removed, 0, 'case differences are NOT stale');
    assert.equal(storage.getItem('oc-gateway-url'),
      `wss://h/openclaw-direct/${upper}`,
      'uppercase same-connection entry preserved');
    assert.equal(storage.getItem('oc-mixed-case'),
      `wss://h/openclaw-direct/${STALE.slice(0, 4).toUpperCase()}${STALE.slice(4)}`,
      'mixed-case same-connection entry preserved');
  });

  it('preserves composite values that reference BOTH the current and a stale connId (Critic MAJOR-2)', () => {
    // OpenClaw could store a JSON blob containing references to multiple
    // connections (e.g. a recent-connections list). If even ONE reference
    // matches the current connection, the entry holds legitimate state and
    // must be preserved.
    const storage = makeStorage({
      'oc-recent-connections': JSON.stringify({
        recent: [
          `wss://h/openclaw-direct/${STALE}`,
          `wss://h/openclaw-direct/${CURRENT}`
        ]
      })
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 0,
      'composite value containing the current connId is preserved even if also referencing a stale one');
    assert.ok(storage.getItem('oc-recent-connections').includes(CURRENT));
  });

  it('deletes values that reference only stale ids, even if there are multiple stales', () => {
    // Counterpart to the previous test — multi-reference values where none
    // matches CURRENT should be removed (every reference is stale).
    const STALE2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const storage = makeStorage({
      'oc-list': JSON.stringify([
        `wss://h/openclaw-direct/${STALE}`,
        `wss://h/openclaw-direct/${STALE2}`
      ])
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 1, 'all-stale composite removed');
    assert.equal(storage.getItem('oc-list'), null);
  });

  it('clears stale entries whose URL has JSON-escaped forward slashes (#162-followup)', () => {
    // OpenClaw's bundled dashboard serializes its gatewayUrl via JSON, and
    // some build configurations escape forward slashes (`\/`) — a valid
    // JSON encoding the raw regex doesn't match. Normalize before matching.
    const storage = makeStorage({
      'openclaw.control.settings.v1:default': `{"gatewayUrl":"wss:\\/\\/h\\/openclaw-direct\\/${STALE}"}`
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 1, 'JSON-escaped slashes still classified as stale');
    assert.equal(storage.getItem('openclaw.control.settings.v1:default'), null);
  });

  it('clears stale entries whose URL has URL-encoded slashes (%2F)', () => {
    const storage = makeStorage({
      'oc-recent': `wss://h%2Fopenclaw-direct%2F${STALE}`
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 1, 'URL-encoded slashes still classified as stale');
    assert.equal(storage.getItem('oc-recent'), null);
  });

  it('clears stale entries whose URL has unicode-escaped slashes (\\u002F)', () => {
    const storage = makeStorage({
      'oc-cached': `wss:\\u002F\\u002Fh\\u002Fopenclaw-direct\\u002F${STALE}`
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 1, 'unicode-escaped slashes still classified as stale');
    assert.equal(storage.getItem('oc-cached'), null);
  });

  it('preserves same-connection entries even when slashes are escape-encoded', () => {
    const storage = makeStorage({
      'json-self': `{"gatewayUrl":"wss:\\/\\/h\\/openclaw-direct\\/${CURRENT}"}`,
      'percent-self': `wss://h%2Fopenclaw-direct%2F${CURRENT}`
    });
    const removed = clearStaleOpenclawCache(CURRENT, storage);
    assert.equal(removed, 0, 'escape-form encoding of current connId is still current, not stale');
    assert.ok(storage.getItem('json-self'));
    assert.ok(storage.getItem('percent-self'));
  });

  it('refuses to touch storage when currentConnId is malformed (Critic MINOR-4)', () => {
    // Defensive: a malformed connId (non-UUID-shape) should not unleash a
    // localStorage walk that potentially deletes legitimate entries. The
    // server route currently guarantees a non-empty connId but the helper
    // is called from frontend code that could be wired up in unexpected
    // ways in the future — shape validation is belt + suspenders.
    const storage = makeStorage({
      'oc-gateway-url': `wss://h/openclaw-direct/${STALE}`
    });
    assert.equal(clearStaleOpenclawCache('short', storage), 0,
      'too-short id — refuse');
    assert.equal(clearStaleOpenclawCache('not-a-uuid-shape!@#$%', storage), 0,
      'non-hex/-dash characters — refuse');
    assert.equal(clearStaleOpenclawCache('z'.repeat(20), storage), 0,
      'non-hex letters — refuse');
    assert.equal(storage.getItem('oc-gateway-url'),
      `wss://h/openclaw-direct/${STALE}`,
      'storage untouched on malformed-input defense');
  });
});

describe('OpenClaw view wiring for cache-bust (#162)', () => {
  let viewJs, viewHtml;

  beforeEach(() => {
    viewJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'openclaw-view.js'), 'utf8');
    viewHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'openclaw-view.html'), 'utf8');
  });

  it('openclaw-view.html loads openclaw-cache.js BEFORE openclaw-view.js', () => {
    const cacheIdx = viewHtml.indexOf('openclaw-cache.js');
    const viewIdx = viewHtml.indexOf('openclaw-view.js');
    assert.ok(cacheIdx > 0, 'openclaw-cache.js script tag present in openclaw-view.html');
    assert.ok(viewIdx > 0, 'openclaw-view.js script tag present');
    assert.ok(cacheIdx < viewIdx,
      'helper must load BEFORE the view script that calls it — otherwise the call is a TypeError on first session');
  });

  it('all frame.src writers go through the setFrameSrc helper (Critic MINOR-1/MINOR-2)', () => {
    // Pre-Critic, only the initial init() site was preceded by the cache-bust;
    // the post-pairing reload at the auto-approve path was an un-cleared
    // direct `frame.src = frame.src`. Now every writer must route through
    // setFrameSrc, which is the only place the cache-bust runs.
    const setFrameSrcDef = viewJs.indexOf('function setFrameSrc(');
    assert.ok(setFrameSrcDef > 0, 'setFrameSrc helper must be defined');
    // Find every literal `frame.src = ` assignment in the source. The only
    // legal one is INSIDE the setFrameSrc body itself; all other `frame.src`
    // mutations must go via the helper.
    const allDirectAssignments = [...viewJs.matchAll(/frame\.src\s*=\s*[^;]/g)];
    // One assignment lives inside the helper definition (frame.src = url);
    // any other direct assignment is a regression.
    const setFrameSrcBlockEnd = (() => {
      // Find the closing brace of the setFrameSrc function (rough but
      // sufficient for this single-statement-body helper).
      const helperStart = setFrameSrcDef;
      const helperBodyOpen = viewJs.indexOf('{', helperStart);
      let depth = 0;
      for (let i = helperBodyOpen; i < viewJs.length; i++) {
        if (viewJs[i] === '{') depth++;
        else if (viewJs[i] === '}') {
          depth--;
          if (depth === 0) return i;
        }
      }
      return viewJs.length;
    })();
    const insideHelper = allDirectAssignments.filter(
      (m) => m.index >= setFrameSrcDef && m.index <= setFrameSrcBlockEnd
    );
    const outsideHelper = allDirectAssignments.filter(
      (m) => m.index < setFrameSrcDef || m.index > setFrameSrcBlockEnd
    );
    assert.equal(insideHelper.length, 1,
      'setFrameSrc body should contain exactly one direct frame.src assignment');
    assert.equal(outsideHelper.length, 0,
      'no direct frame.src writes outside setFrameSrc — all writers must clear the cache first');
  });

  it('setFrameSrc is called from at least two sites (init load + post-pairing reload)', () => {
    const calls = [...viewJs.matchAll(/setFrameSrc\(/g)];
    // Definition + at least two call sites = 3 occurrences minimum.
    assert.ok(calls.length >= 3,
      `expected setFrameSrc to be defined and called at >= 2 sites, found ${calls.length} occurrences`);
  });

  it('cache-bust call is guarded by typeof check (allows helper to be omitted in tests without crashing init)', () => {
    assert.match(viewJs, /typeof tcClearStaleOpenclawCache === 'function'/,
      'guard prevents init() from throwing if the helper script failed to load');
  });
});

describe('service worker cache strategy for cache-bust scripts (#246)', () => {
  let swSrc;

  beforeEach(() => {
    swSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  });

  it('CACHE_NAME is bumped to v3-12 or higher (post-#246 unblock)', () => {
    // #246 root cause: existing operators with an active SW had
    // tangleclaw-v3-11's cache holding the pre-#245 openclaw-cache.js
    // script. Bumping CACHE_NAME triggers the install + activate event
    // pair that clears the old cache. This test pins the bump so a
    // future hand-edit reverting to v3-11 (or earlier) fails loud
    // rather than silently re-stranding the fix.
    const match = swSrc.match(/CACHE_NAME\s*=\s*['"]tangleclaw-v3-(\d+)['"]/);
    assert.ok(match, 'CACHE_NAME must follow the tangleclaw-v3-N pattern');
    const version = parseInt(match[1], 10);
    assert.ok(version >= 12, `CACHE_NAME version must be >= 12 (post-#246); found v3-${version}`);
  });

  it('/openclaw-cache.js is in NETWORK_FIRST_PATHS (cache-first branch carve-out)', () => {
    // The structural fix in #246: openclaw-cache.js must NOT be served
    // from the SW's cache-first branch, since its whole job is cache
    // invalidation and a stale copy is by definition wrong. Without
    // this carve-out, every future change to the script gets stranded
    // until the operator manually clears their SW cache.
    assert.match(swSrc, /NETWORK_FIRST_PATHS/,
      'sw.js must declare a NETWORK_FIRST_PATHS set/list (#246)');
    assert.match(swSrc, /['"]\/openclaw-cache\.js['"]/,
      '/openclaw-cache.js must be present in the network-first carve-out');
  });

  it('#271 — core UI assets are in NETWORK_FIRST_PATHS (prevents stale-UI bug recurrence)', () => {
    // #267 verification pass surfaced that the new findings panel didn't
    // render until `Cmd+Shift+R` because the SW served a stale
    // session.js. This pattern recurs every time a feature PR touches
    // public/session.js, public/landing.js, or public/session.css. Pin
    // each path so a future SW edit can't silently drop the carve-out
    // and let the bug come back. Landing has no dedicated CSS today
    // (style.css covers the landing surface) — `/landing.css` is
    // intentionally omitted; add it when/if the asset materializes.
    // /wrap-drawer.js (#268): session.js (network-first) calls its pure
    // helpers directly, so a stale cached wrap-drawer.js against a fresh
    // session.js is a version skew that throws on a missing helper. Pin it
    // alongside the #271 set so the two stay in lockstep.
    for (const p of ['/session.js', '/session.css', '/landing.js', '/wrap-drawer.js']) {
      assert.match(swSrc, new RegExp(`['"]${p.replace(/[/\\.]/g, '\\$&')}['"]`),
        `${p} must be present in NETWORK_FIRST_PATHS so feature-PR UI changes reach operators without hard-reload`);
    }
  });

  it('fetch handler consults NETWORK_FIRST_PATHS alongside /api/ and navigate', () => {
    // Pin that the carve-out is wired into the routing decision, not
    // just declared as dead code. The branch that triggers network-
    // first treatment must reference NETWORK_FIRST_PATHS — otherwise
    // adding entries to the set silently has no effect.
    assert.match(swSrc, /NETWORK_FIRST_PATHS\.has\(url\.pathname\)/,
      'fetch handler must invoke NETWORK_FIRST_PATHS.has(url.pathname) to route the request');
  });
});

describe('service worker registration (#258)', () => {
  let swRegisterJs;

  beforeEach(() => {
    // SW registration moved out of landing.js into public/sw-register.js
    // (#380, layer 2) so the iOS update-propagation logic is unit-testable;
    // the #258 contract below now lives there. Behavioural coverage of the
    // option is in test/sw-register.test.js.
    swRegisterJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw-register.js'), 'utf8');
  });

  it("serviceWorker.register passes updateViaCache: 'none' to bypass the HTTP cache on SW updates", () => {
    // #258 — without this option, the browser may cache `/sw.js` per the
    // HTTP cache (default `'imports'` mode caches importScripts but
    // still respects HTTP Cache-Control on the top-level SW). Server
    // sends `Cache-Control: no-cache` but aggressive proxies can hold
    // the old SW for up to 24h. `'none'` is belt-and-suspenders so a
    // bumped CACHE_NAME (the immediate-unblock tool for future SW
    // cache bugs — see #246) propagates without waiting on cache TTL.
    assert.match(
      swRegisterJs,
      /register\(\s*['"]\/sw\.js['"]\s*,\s*\{[^}]*updateViaCache:\s*['"]none['"]/,
      "register('/sw.js', { updateViaCache: 'none' }) — option must be on the registration call"
    );
  });
});

describe('clearStaleOpenclawCache diagnostic instrumentation (#246)', () => {
  let originalConsoleWarn;
  let warnCalls;

  beforeEach(() => {
    warnCalls = [];
    originalConsoleWarn = console.warn;
    console.warn = (...args) => { warnCalls.push(args); };
  });

  function restore() { console.warn = originalConsoleWarn; }

  it('emits a console.warn naming the removed count when entries are cleared', () => {
    const connA = '7923a71f-b6da-49a3-805a-b063c3b22af8';
    const connB = '90df52c9-3782-4ad0-8dc2-927ef4d57f89';
    const storage = makeStorage({
      'openclaw.control.settings.v1':
        `{"gatewayUrl":"wss://host:3102/openclaw-direct/${connA}"}`
    });

    try {
      const removed = clearStaleOpenclawCache(connB, storage);
      assert.equal(removed, 1, 'precondition: removal should have occurred');
      assert.equal(warnCalls.length, 1, 'console.warn must fire when entries are removed');
      // Message includes the removed count + the current connId so an
      // operator looking at devtools can correlate.
      const msg = warnCalls[0].join(' ');
      assert.match(msg, /\[oc-cache\] removed 1/);
      assert.match(msg, new RegExp(connB));
    } finally {
      restore();
    }
  });

  it('is quiet (no console.warn) on the common case of zero removed entries', () => {
    const connA = '7923a71f-b6da-49a3-805a-b063c3b22af8';
    const storage = makeStorage({
      // Same-connection value → not stale → not removed.
      'openclaw.control.settings.v1':
        `{"gatewayUrl":"wss://host:3102/openclaw-direct/${connA}"}`
    });

    try {
      const removed = clearStaleOpenclawCache(connA, storage);
      assert.equal(removed, 0);
      assert.equal(warnCalls.length, 0,
        'normal page loads must not log — only removed > 0 should be visible');
    } finally {
      restore();
    }
  });
});
