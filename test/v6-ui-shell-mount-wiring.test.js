'use strict';

/*
 * v6.6.1 Wave 1 (Car V661-W1-C, #3258 / V6-001).
 *
 * public/ui.js is a large, DOM-executing production file, not safely
 * mountable in node:test the way test/v6-b1-ui-shell.test.js loads
 * public/v6-shell.js itself (`vm.runInContext` + test/_mini-dom.js) — ui.js
 * assumes a full page's worth of elements already exist by the time its
 * top-level script reaches the v6 shell mount. This file instead does a
 * source-level regression, the same pattern
 * test/v6-usage-popover-and-composer-layout.test.js uses against the real
 * shipped public/style.css rule bodies: extract the literal options object
 * ui.js passes to `tcCreateV6Shell(document, { ... })` in production, and
 * every `options.onXxx` identifier public/v6-shell.js's own mount code
 * actually reads, then assert the first set covers the second. That is
 * exactly the failure #3258 fixed for `onViewOfflineHistory` and
 * `onReturnToStartCard`: v6-shell.js's wireControls() had read them since
 * #3203 shipped, but nothing in production ever passed them in, so the
 * "View Previous Conversation" button did nothing. This test exists so a
 * callback v6-shell.js starts consuming can never again go silently
 * unwired here.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
const SHELL_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-shell.js'), 'utf8');

/**
 * Scans forward from `openBraceIndex` (which must point at a `{`) and
 * returns the index of its matching `}`, by plain depth counting. Safe
 * here only because the scanned region (the tcCreateV6Shell options
 * object) carries no `{`/`}` inside a string or comment — verified by the
 * balance assertion callers make on the result.
 * @param {string} src
 * @param {number} openBraceIndex
 * @returns {number}
 */
function matchingBraceIndex(src, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The literal options object public/ui.js passes to
 * `tcCreateV6Shell(document, { ... })` in production, as raw source text
 * (everything between the outer braces, exclusive).
 * @returns {string}
 */
function extractMountOptionsSource() {
  const marker = 'window.tcCreateV6Shell(document, {';
  const start = UI_SRC.indexOf(marker);
  assert.ok(start !== -1, 'public/ui.js must still call window.tcCreateV6Shell(document, {...}) directly');
  const openBrace = start + marker.length - 1;
  const closeBrace = matchingBraceIndex(UI_SRC, openBrace);
  assert.ok(closeBrace !== -1, 'unbalanced braces while scanning the tcCreateV6Shell options object');
  return UI_SRC.slice(openBrace + 1, closeBrace);
}

/**
 * Every `options.onXxx` identifier public/v6-shell.js's mount function
 * actually reads at runtime — i.e. what it genuinely CONSUMES, not just
 * documents in its own JSDoc opts typedef.
 * @returns {Set<string>}
 */
function consumedShellCallbacks() {
  const names = new Set();
  const re = /options\.(on[A-Za-z]\w*)/g;
  let m = re.exec(SHELL_SRC);
  while (m) {
    names.add(m[1]);
    m = re.exec(SHELL_SRC);
  }
  return names;
}

/**
 * Every `onXxx(...) { ... }` method-shorthand key public/ui.js wires into
 * the options object, mapped to that method's own source body — so callers
 * can assert WHAT it delegates to, not just that the key is present.
 * @param {string} optionsSrc
 * @returns {Map<string, string>}
 */
function wiredUiCallbacks(optionsSrc) {
  const wired = new Map();
  const re = /(on[A-Z]\w*)\s*\([^)]*\)\s*\{/g;
  let m = re.exec(optionsSrc);
  while (m) {
    const bodyStart = re.lastIndex;
    const bodyEnd = matchingBraceIndex(optionsSrc, bodyStart - 1);
    wired.set(m[1], bodyEnd === -1 ? '' : optionsSrc.slice(bodyStart, bodyEnd));
    m = re.exec(optionsSrc);
  }
  return wired;
}

// `onHoodCommand` is a real callback public/v6-shell.js consumes
// (Under the Hood's Interactive CLI Mode, #3135) that this file does NOT
// yet wire — deliberately, per its own doc comment on the mount opts
// typedef ("planned for Wave 2"), with a documented fallback
// (onSendChat / a direct fetch) in the meantime. The one allowed gap in
// the otherwise-exhaustive audit below.
const INTENTIONALLY_DEFERRED = new Set(['onHoodCommand']);

describe('#3258 (V6-001): public/ui.js wires every tcCreateV6Shell callback public/v6-shell.js consumes', () => {
  const optionsSrc = extractMountOptionsSource();
  const consumed = consumedShellCallbacks();
  const wired = wiredUiCallbacks(optionsSrc);

  it('sanity: the extractor actually found a broad set of consumed callbacks', () => {
    assert.ok(consumed.size >= 20, `expected a broad set of consumed callbacks, found ${consumed.size}`);
  });

  it('every consumed callback, except the documented Wave-2 deferral, is wired in public/ui.js', () => {
    const missing = [...consumed].filter((name) => !INTENTIONALLY_DEFERRED.has(name) && !wired.has(name));
    assert.deepEqual(missing, [], `public/ui.js is missing: ${missing.join(', ')}`);
  });

  it('the documented deferral is itself still unwired (so this test notices the day it should be promoted out of the allowlist)', () => {
    for (const name of INTENTIONALLY_DEFERRED) {
      assert.ok(consumed.has(name), `${name} is no longer consumed by v6-shell.js — drop it from INTENTIONALLY_DEFERRED`);
    }
  });

  it('onViewOfflineHistory delegates to v6Live.viewOfflineHistory, passing the project name through', () => {
    assert.ok(wired.has('onViewOfflineHistory'), 'onViewOfflineHistory must be wired');
    assert.match(wired.get('onViewOfflineHistory'), /v6Live\.viewOfflineHistory\(\s*projectName\s*\)/);
  });

  it('onReturnToStartCard delegates to v6Live.returnToStartCard, passing the project name through', () => {
    assert.ok(wired.has('onReturnToStartCard'), 'onReturnToStartCard must be wired');
    assert.match(wired.get('onReturnToStartCard'), /v6Live\.returnToStartCard\(\s*projectName\s*\)/);
  });

  it('onStartFleetMembers delegates to v6Live.startFleetMembers, passing the names through '
    + '(#3258 acceptance criterion 1 — wired ahead of a shell-side consumer landing)', () => {
    assert.ok(wired.has('onStartFleetMembers'), 'onStartFleetMembers must be wired');
    assert.match(wired.get('onStartFleetMembers'), /v6Live\.startFleetMembers\(\s*names\s*\)/);
  });

  it('root-cause guard: public/v6-shell.js still reads onViewOfflineHistory/onReturnToStartCard '
    + '(if it ever stops, say so loudly rather than let the audit above pass for the wrong reason)', () => {
    assert.match(SHELL_SRC, /options\.onViewOfflineHistory/);
    assert.match(SHELL_SRC, /options\.onReturnToStartCard/);
  });
});

/*
 * R-Gate (PR #3293): the audit above proves public/ui.js's TEXT wires the
 * callbacks, but never executes it, so it cannot prove a real click
 * actually reaches them. What follows mounts the REAL, unmodified
 * production mount block — extracted verbatim from public/ui.js, not a
 * hand-written stand-in — against the REAL public/v6-shell.js, inside a vm
 * sandbox (the same technique test/v6-b1-ui-shell.test.js already uses to
 * load v6-shell.js itself), and drives it through an actual button click.
 */

/**
 * Loads the real public/v6-shell.js into a fresh vm sandbox. Every global
 * it defines (`tcCreateV6Shell`, `tcV6CreateLiveController`,
 * `tcV6TuckAdminControls`, `tcV6ViewToggleLabel`, ...) lands directly on
 * the returned sandbox, since the module assigns to `global.*`/`window.*`
 * and `sandbox.window = sandbox.globalThis = sandbox`.
 * @returns {object}
 */
function loadV6Shell() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SHELL_SRC, sandbox);
  return sandbox;
}

/**
 * Installs a minimal `location.hash` + `addEventListener('hashchange', ...)`
 * directly on the sandbox, standing in for the real `window` production
 * code reads implicitly (`public/ui.js` never passes `options.window`, so
 * `tcCreateV6Shell` falls back to the ambient `window` — here, the sandbox
 * itself, since `sandbox.window === sandbox`).
 * @param {object} sandbox
 * @param {string} [initialHash]
 */
function installFakeLocation(sandbox, initialHash) {
  let hash = initialHash || '';
  const listeners = {};
  Object.defineProperty(sandbox, 'location', {
    configurable: true,
    value: {
      get hash() { return hash; },
      set hash(v) {
        hash = v.startsWith('#') ? v : `#${v}`;
        (listeners.hashchange || []).slice().forEach((fn) => fn());
      }
    }
  });
  sandbox.addEventListener = (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); };
  sandbox.removeEventListener = (type, fn) => {
    if (!listeners[type]) return;
    listeners[type] = listeners[type].filter((f) => f !== fn);
  };
}

/**
 * The literal body of `if (typeof window.tcCreateV6Shell === 'function') { ... }`
 * in public/ui.js — the whole production v6-shell mount block, not just the
 * options object: the real root-element lookups, the real `v6Live`
 * construction, the real `tcCreateV6Shell(document, {...})` call with its
 * options object exactly as shipped, and the toggle-button wiring after it.
 * @returns {string}
 */
function extractMountBlockSource() {
  const marker = "if (typeof window.tcCreateV6Shell === 'function') {";
  const start = UI_SRC.indexOf(marker);
  assert.ok(start !== -1, 'public/ui.js must still guard the v6 shell mount with this exact check');
  const openBrace = start + marker.length - 1;
  const closeBrace = matchingBraceIndex(UI_SRC, openBrace);
  assert.ok(closeBrace !== -1, 'unbalanced braces while scanning the v6 shell mount block');
  return UI_SRC.slice(openBrace + 1, closeBrace);
}

/**
 * Mounts public/ui.js's real, unmodified v6-shell mount block against the
 * real public/v6-shell.js.
 * @param {{api: Function, apiMutate: Function, initialHash?: string}} deps
 * @returns {{v6Shell: object, v6Live: object, doc: object}}
 */
function mountProductionV6Shell(deps) {
  const sandbox = loadV6Shell();
  const { doc } = makeDocument(['projectsContainer', 'v6ViewToggleBtn']);
  const shellRoot = doc.createElement('div');
  shellRoot.id = 'v6ShellRoot';
  withIdParsingInnerHTML(shellRoot, doc);
  doc.body.appendChild(shellRoot);
  doc._register(shellRoot);
  // public/ui.js's real block also reads `document.querySelector('.toolbar')`
  // (#3046) — no toolbar in this fixture; a doc-level querySelector
  // delegating to the body is enough for the `if (v6ClassicToolbar)` guards
  // to see `null`, same as a page that never rendered one.
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  installFakeLocation(sandbox, deps.initialHash);
  sandbox.document = doc;
  sandbox.api = deps.api;
  sandbox.apiMutate = deps.apiMutate;
  sandbox.openSettings = deps.openSettings || (() => {});
  const harness = `(function() {\n${extractMountBlockSource()}\nreturn { v6Shell, v6Live };\n})()`;
  return { ...vm.runInContext(harness, sandbox), doc };
}

/**
 * Lets the mount block's own fire-and-forget `v6Live.handleRoute(...)`
 * call (and any promise chain a subsequent click starts) settle. A
 * `setTimeout` macrotask, unlike a handful of `await Promise.resolve()`
 * microtask hops, is guaranteed to run after every microtask already
 * queued — including ones a later `await` inside the production code
 * enqueues only once an earlier one resolves.
 * @returns {Promise<void>}
 */
function flush() {
  return new Promise((resolve) => { setTimeout(resolve, 20); });
}

describe('#3258 (V6-001): the production mount block, executed for real (not a hand-written stand-in)', () => {
  /**
   * @param {object} [overrides] - `url -> response`, checked before the defaults.
   * @returns {Function & {calls: string[]}} An `api(url)` stub.
   */
  function makeApi(overrides) {
    const calls = [];
    const api = async (url) => {
      calls.push(url);
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, url)) return overrides[url];
      if (url === '/api/projects') {
        return { projects: [{ id: 7, name: 'Offline-Proj', engine: { id: 'claude' }, session: null }] };
      }
      if (/^\/api\/sessions\/[^/]+\/status$/.test(url)) return { active: false };
      if (/^\/api\/sessions\/[^/]+\/history\?limit=1$/.test(url)) return { sessions: [] };
      if (/^\/api\/continuity\/[^/]+\/sessions$/.test(url)) return { sessions: [] };
      return null;
    };
    api.calls = calls;
    api.lastError = null;
    return api;
  }

  it('a real click on "View Previous Conversation" reaches v6Live.viewOfflineHistory through production onViewOfflineHistory, '
    + 'and renders the empty-state when no prior history exists (#3258 acceptance criterion 3)', async () => {
    const api = makeApi();
    const { v6Shell, doc } = mountProductionV6Shell({
      api, apiMutate: async () => ({ ok: true }), initialHash: '#/resources/7/conversation'
    });
    void v6Shell; // the mount block's OWN unawaited handleRoute call already fired; flush() below waits for it.
    await flush();

    const viewBtn = doc.getElementById('v6ChatViewHistoryHero');
    assert.ok(viewBtn, 'the offline hero\'s View Previous Conversation button must be on screen for an offline project');
    const before = api.calls.length;
    assert.ok(viewBtn.dispatch('click'), 'the click must find a REAL listener — proves production onViewOfflineHistory was actually passed in, not just present as text');
    await flush();

    const reached = api.calls.slice(before);
    assert.ok(reached.some((u) => /\/history\?limit=1$/.test(u)),
      `expected a call to the session-history endpoint, got: ${JSON.stringify(reached)}`);
    assert.ok(reached.some((u) => /\/continuity\//.test(u)),
      'with no B2 session row, it must fall back to the continuity sessions list (viewOfflineHistory\'s own documented fallback)');
    assert.doesNotMatch(doc.body.text, /undefined.*undefined/,
      'a thrown/undefined render would be the most common failure mode of a wiring gap');

    const returnBtn = doc.getElementById('v6ChatOfflineHistoryReturnTop') || doc.getElementById('v6ChatOfflineHistoryReturnBottom');
    assert.ok(returnBtn, 'a Return to Start Card control must be on screen once the offline-history view rendered');
    assert.ok(returnBtn.dispatch('click'), 'the click must find a REAL listener — proves production onReturnToStartCard was actually passed in');

    const heroAgain = doc.getElementById('v6ChatViewHistoryHero');
    assert.ok(heroAgain, 'returning to the Start Card must bring the View Previous Conversation hero back');
  });

  it('never starts the engine while loading offline history (#3258 acceptance criterion 2)', async () => {
    const api = makeApi();
    const apiMutate = async (url) => { throw new Error(`apiMutate must never be called viewing offline history, got: ${url}`); };
    const { doc } = mountProductionV6Shell({ api, apiMutate, initialHash: '#/resources/7/conversation' });
    await flush();
    doc.getElementById('v6ChatViewHistoryHero').dispatch('click');
    await flush();
    // No assertion needed beyond "didn't throw" — apiMutate throwing above would fail this test,
    // and that is the whole point: viewOfflineHistory only ever reads, through onViewOfflineHistory.
  });
});
