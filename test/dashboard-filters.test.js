'use strict';

/*
 * W1-A (#2122, #2123, #2124) — dashboard tag/engine filter persistence, the
 * toolbar's filter-group alignment, and the card Launch/Open control.
 *
 * #2122's logic (toggleTag, filterProjects, collectTags, collectEngines) is
 * lifted out of public/landing.js and public/ui.js and run for real against a
 * mocked localStorage/DOM — same lift-and-run approach as
 * test/landing-unreachable-state.test.js — so these tests exercise the actual
 * shipped functions, not a re-declaration of them. #2123 (CSS) and #2124 (the
 * anchor conversion) are source-level structural assertions, matching
 * test/mobile-toolbar-layout.test.js and test/landing-wake-hold-badge.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { liftDeclaration } = require('./helpers/lift');

const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

/**
 * A minimal in-memory localStorage mock (the real one is not available under
 * `node:vm`).
 * @returns {{getItem(string): string|null, setItem(string, string): void, store: Map<string,string>}}
 */
function fakeLocalStorage() {
  const store = new Map();
  return {
    store,
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); }
  };
}

/**
 * A minimal `#engineFilter` <select> stand-in: enough for collectEngines to
 * rebuild its options and read/write `.value`.
 * @returns {object}
 */
function fakeEngineSelect() {
  return {
    value: '',
    style: {},
    _options: [],
    set innerHTML(_v) { this._options = []; },
    get innerHTML() { return ''; },
    appendChild(opt) { this._options.push(opt); }
  };
}

/**
 * Build a vm context with `state`, a fake `localStorage`/`document`, and
 * no-op render stubs, then run the given landing.js declarations in it.
 * @param {string[]} decls - Declaration headers to lift from landing.js.
 * @param {object} [state] - Initial state object.
 * @returns {{ctx: object, calls: {renderTagRow: number, renderProjects: number}}}
 */
function buildLandingContext(decls, state) {
  const calls = { renderTagRow: 0, renderProjects: 0 };
  const select = fakeEngineSelect();
  const ctx = vm.createContext({
    state,
    localStorage: fakeLocalStorage(),
    document: {
      getElementById: (id) => (id === 'engineFilter' ? select : null),
      createElement: () => ({ value: '', textContent: '' })
    },
    renderTagRow: () => { calls.renderTagRow += 1; },
    renderProjects: () => { calls.renderProjects += 1; }
  });
  const fnSrc = decls.map((d) => liftDeclaration(LANDING_SRC, d)).join('\n');
  vm.runInContext(fnSrc, ctx);
  return { ctx, calls, select };
}

describe('dashboard filter persistence (#2122)', () => {
  it('toggleTag writes the selection to localStorage and updates state', () => {
    const state = { activeTag: null };
    const { ctx } = buildLandingContext(['function toggleTag('], state);
    vm.runInContext("toggleTag('infra')", ctx);
    assert.equal(state.activeTag, 'infra');
    assert.equal(ctx.localStorage.getItem('tc_filterActiveTag'), JSON.stringify('infra'));
  });

  it('toggleTag(null) ("All") persists null, not the string "null"', () => {
    const state = { activeTag: 'infra' };
    const { ctx } = buildLandingContext(['function toggleTag('], state);
    vm.runInContext('toggleTag(null)', ctx);
    assert.equal(state.activeTag, null);
    assert.equal(JSON.parse(ctx.localStorage.getItem('tc_filterActiveTag')), null);
  });

  it('collectTags drops a restored tag that no longer exists on any project', () => {
    const state = {
      activeTag: 'gone',
      allTags: [],
      projects: [{ tags: ['infra'] }, { tags: ['frontend'] }]
    };
    const { ctx } = buildLandingContext(['function collectTags('], state);
    vm.runInContext('collectTags()', ctx);
    // state.allTags is an Array built inside the vm's realm — deepEqual
    // against a main-realm literal needs it converted to this realm's Array.
    assert.deepEqual(Array.from(state.allTags), ['frontend', 'infra']);
    assert.equal(state.activeTag, null, 'a stale restored tag must be dropped, not hide every project');
  });

  it('collectTags keeps a restored tag that still exists', () => {
    const state = {
      activeTag: 'infra',
      allTags: [],
      projects: [{ tags: ['infra'] }, { tags: ['frontend'] }]
    };
    const { ctx } = buildLandingContext(['function collectTags('], state);
    vm.runInContext('collectTags()', ctx);
    assert.equal(state.activeTag, 'infra');
  });

  it('filterProjects applies a restored activeTag/activeEngine exactly like a freshly-clicked one', () => {
    const state = {
      filterText: '',
      showUnregistered: true,
      activeTag: 'infra',
      activeEngine: 'claude',
      projects: [
        { name: 'a', tags: ['infra'], engine: { name: 'claude' } },
        { name: 'b', tags: ['infra'], engine: { name: 'codex' } },
        { name: 'c', tags: ['frontend'], engine: { name: 'claude' } }
      ]
    };
    const { ctx } = buildLandingContext(['function filterProjects('], state);
    const result = vm.runInContext('filterProjects()', ctx);
    assert.deepEqual(result.map((p) => p.name), ['a']);
  });

  it('collectEngines restores state.activeEngine into the <select> when the DOM has not shown it yet', () => {
    const state = {
      activeEngine: 'claude',
      projects: [{ engine: { name: 'claude' } }, { engine: { name: 'codex' } }]
    };
    const { ctx, select } = buildLandingContext(['function collectEngines('], state);
    vm.runInContext('collectEngines()', ctx);
    assert.equal(select.value, 'claude');
    assert.equal(state.activeEngine, 'claude');
  });

  it('collectEngines drops a restored engine that no longer exists on any project', () => {
    const state = {
      activeEngine: 'gone',
      projects: [{ engine: { name: 'claude' } }]
    };
    const { ctx } = buildLandingContext(['function collectEngines('], state);
    vm.runInContext('collectEngines()', ctx);
    assert.equal(state.activeEngine, null, 'a stale restored engine must be dropped, not hide every project');
  });

  it("init() restores both filters from localStorage before the first loadProjects()", () => {
    const body = liftDeclaration(LANDING_SRC, 'async function init()');
    assert.match(body, /tc_filterActiveTag/);
    assert.match(body, /tc_filterActiveEngine/);
    const tagIdx = body.indexOf('tc_filterActiveTag');
    const loadIdx = body.indexOf('await loadProjects()');
    assert.ok(tagIdx > -1 && loadIdx > -1 && tagIdx < loadIdx,
      'the restore must run before loadProjects() -> collectTags()/collectEngines() runs');
  });

  it('the engineFilter change handler in ui.js persists the selection', () => {
    const idx = UI_SRC.indexOf("document.getElementById('engineFilter')");
    assert.ok(idx > -1, 'ui.js must still wire the engineFilter element');
    const nearby = UI_SRC.slice(idx, idx + 400);
    assert.match(nearby, /tc_filterActiveEngine/,
      "the engineFilter change handler must persist state.activeEngine to localStorage");
  });
});

describe('toolbar filter-group alignment (#2123)', () => {
  const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  const style = stripCss(CSS_SRC);

  it('the base .toolbar-center rule sits the filter group inline, shifted left (not centered)', () => {
    const m = /^\.toolbar-center\s*\{([^}]*)\}/m.exec(style);
    assert.ok(m, '.toolbar-center must have a base (non-media) rule');
    assert.match(m[1], /display:\s*flex/);
    assert.match(m[1], /justify-content:\s*flex-start/);
    assert.doesNotMatch(m[1], /justify-content:\s*center/);
  });

  it('the phone-portrait override (<600px, #1192) is untouched', () => {
    assert.match(style, /@media \(max-width: 600px\)[\s\S]*?\.toolbar-center\s*\{\s*flex:\s*1 1 100%;\s*order:\s*1;\s*justify-content:\s*flex-start;\s*\}/);
  });
});

describe('card Launch/Open control is a real link for both states (#2124)', () => {
  it('the active-session ("Open") branch is a real <a href="/session/:name">', () => {
    const idx = UI_SRC.indexOf('? `<a class="btn btn-compact btn-launch"');
    assert.ok(idx > -1, 'ui.js must render an <a> for the active-session case');
    const snippet = UI_SRC.slice(idx, idx + 220);
    assert.match(snippet, /href="\/session\/\$\{encodeURIComponent\(project\.name\)\}"/,
      'the href must point at the session page so right-click "Open in new tab" works');
    assert.match(snippet, /onclick="event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*launchProject/,
      'left-click must still preventDefault and run the existing navigate-to-session logic');
    assert.match(snippet, />Open<\/a>/);
  });

  it('the not-yet-active ("Launch") branch is a real <a href="/?launch=:name"> (PRR BLOCKING follow-up: a direct /session/:name link would show "no active session" for a never-launched project — /?launch=<name> instead re-enters the page and runs the real launch flow)', () => {
    const idx = UI_SRC.indexOf('return `<a class="btn btn-compact btn-launch" data-project-name=');
    assert.ok(idx > -1, 'ui.js must render an <a href="/?launch=..."> for the not-yet-active case');
    const snippet = UI_SRC.slice(idx, idx + 320);
    assert.match(snippet, /href="\/\?launch=\$\{encodeURIComponent\(project\.name\)\}\$\{intentFragment\}"/);
    assert.match(snippet, /onclick="event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*launchProject/,
      'left-click must still preventDefault and run launchProject immediately, without a page reload');
    assert.match(snippet, />Launch<\/a>/);
  });

  it('both controls carry data-project-name, HTML-escaped the same way every other attribute on the card is', () => {
    const openIdx = UI_SRC.indexOf('? `<a class="btn btn-compact btn-launch"');
    const launchIdx = UI_SRC.indexOf('return `<a class="btn btn-compact btn-launch" data-project-name=');
    for (const idx of [openIdx, launchIdx]) {
      const snippet = UI_SRC.slice(idx, idx + 90);
      assert.match(snippet, /data-project-name="\$\{n\}"/, 'must use the already-HTML-escaped `n`, not the raw project.name');
    }
  });

  it('doLaunchProject finds the control by a data-project-name attribute, cssEscape-d, not by parsing onclick text (CRITIC BLOCKING: an unregistered filesystem project can have a name with a quote in it, which breaks a selector built by string-interpolating the raw name between quote characters)', () => {
    const body = liftDeclaration(LANDING_SRC, 'async function doLaunchProject(');
    assert.match(body, /document\.querySelector\(`\[data-project-name="\$\{cssEscape\(name\)\}"\]`\)/,
      'the selector must look up a data-project-name attribute through cssEscape, not interpolate the raw name into onclick-text matching');

    // Lift and run the REAL cssEscape — no DOM/jsdom in this harness to call
    // the global CSS.escape it was written to replace (that gap is exactly
    // what broke 3 other test files that lift-and-run doLaunchProject; this
    // function exists so none of them need a CSS global). Verify the SAFETY
    // PROPERTY the fix depends on: for an adversarial name (the one Critic's
    // finding used, plus a backslash and an all-quotes name), the escaped
    // value, embedded in doLaunchProject's own template, never contains an
    // unescaped `"` that would close the attribute value early. Scanning
    // respects `\` as an escape prefix for the next character, which is
    // exactly what a CSS tokenizer does.
    const ctx = vm.createContext({});
    vm.runInContext(`${liftDeclaration(LANDING_SRC, 'function cssEscape(')}\nthis.cssEscape = cssEscape;`, ctx);
    const cssEscape = ctx.cssEscape;

    /**
     * Whether `selector` (a `[attr="value"]`-shaped string) has an unescaped
     * `"` anywhere except at the two quotes that delimit `value` — i.e.
     * whether the quoted value is intact rather than closed early.
     * @param {string} selector
     * @returns {boolean}
     */
    function quotedValueIntact(selector) {
      const openAt = selector.indexOf('="') + 1;
      let i = openAt + 1;
      while (i < selector.length) {
        if (selector[i] === '\\') { i += 2; continue; }
        if (selector[i] === '"') return selector[i + 1] === ']';
        i += 1;
      }
      return false;
    }

    for (const name of ['O\'Brien\'s "Project"', 'back\\slash', '"""', "'''", '\x01\x02control"chars']) {
      const selector = `[data-project-name="${cssEscape(name)}"]`;
      assert.ok(quotedValueIntact(selector),
        `CSS.escape(${JSON.stringify(name)}) must not let the attribute value close early: ${selector}`);
    }
  });

  it('doLaunchProject uses a CSS class for the pending state (.disabled is a no-op on an <a>)', () => {
    const body = liftDeclaration(LANDING_SRC, 'async function doLaunchProject(');
    assert.match(body, /btn\.classList\.add\('is-launching'\)/);
    assert.match(body, /btn\.classList\.remove\('is-launching'\)/);
    assert.doesNotMatch(body, /btn\.disabled/);
  });

  it('style.css defines the pending-state class with pointer-events: none', () => {
    const m = /\.btn-launch\.is-launching\s*\{([^}]*)\}/.exec(CSS_SRC);
    assert.ok(m, '.btn-launch.is-launching rule must exist');
    assert.match(m[1], /pointer-events:\s*none/);
  });
});

describe('getLaunchIntentToken + consumeLaunchQueryParam guard the launch against CSRF (#2124 PRR-A C5)', () => {
  const TTL_MS = 5 * 60 * 1000;

  /**
   * A minimal in-memory localStorage mock, same shape as `fakeLocalStorage()`
   * above but exposed per-test here so a stored record can be asserted on
   * directly (removed vs. still present) after the run.
   * @param {Record<string,string>} [seed] - Pre-populated keys (raw JSON strings).
   * @returns {{getItem(string): string|null, setItem(string,string): void, removeItem(string): void, store: Map<string,string>}}
   */
  function fakeStorage(seed) {
    const store = new Map(Object.entries(seed || {}));
    return {
      store,
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); }
    };
  }

  /** @param {string} token @param {number} mintedAt @returns {string} */
  function record(token, mintedAt) { return JSON.stringify({ token, mintedAt }); }

  describe('getLaunchIntentToken', () => {
    it('mints and stores a project-bound token when none exists', () => {
      const storage = fakeStorage();
      const ctx = vm.createContext({
        localStorage: storage,
        crypto: { randomUUID: () => 'minted-uuid' }
      });
      const token = vm.runInContext(
        `${liftDeclaration(UI_SRC, 'function getLaunchIntentToken(')}\ngetLaunchIntentToken('my-project');`, ctx);
      assert.equal(token, 'minted-uuid');
      const stored = JSON.parse(storage.getItem('tc_launchIntent:my-project'));
      assert.equal(stored.token, 'minted-uuid');
      assert.equal(typeof stored.mintedAt, 'number');
    });

    it('reads the existing token instead of minting a new one, when still fresh', () => {
      const storage = fakeStorage({ 'tc_launchIntent:my-project': record('already-there', Date.now()) });
      const ctx = vm.createContext({
        localStorage: storage,
        crypto: { randomUUID: () => { throw new Error('must not mint when a fresh token already exists'); } }
      });
      const token = vm.runInContext(
        `${liftDeclaration(UI_SRC, 'function getLaunchIntentToken(')}\ngetLaunchIntentToken('my-project');`, ctx);
      assert.equal(token, 'already-there');
    });

    it('mints a fresh token when the existing one has expired', () => {
      const storage = fakeStorage({
        'tc_launchIntent:my-project': record('stale-token', Date.now() - TTL_MS - 1000)
      });
      const ctx = vm.createContext({
        localStorage: storage,
        crypto: { randomUUID: () => 'fresh-uuid' }
      });
      const token = vm.runInContext(
        `${liftDeclaration(UI_SRC, 'function getLaunchIntentToken(')}\ngetLaunchIntentToken('my-project');`, ctx);
      assert.equal(token, 'fresh-uuid');
    });

    it('two projects get independent tokens under independent keys', () => {
      const storage = fakeStorage();
      let n = 0;
      const ctx = vm.createContext({ localStorage: storage, crypto: { randomUUID: () => `uuid-${++n}` } });
      const src = `${liftDeclaration(UI_SRC, 'function getLaunchIntentToken(')}`;
      const tokenA = vm.runInContext(`${src}\ngetLaunchIntentToken('project-a');`, ctx);
      const tokenB = vm.runInContext(`${src}\ngetLaunchIntentToken('project-b');`, ctx);
      assert.notEqual(tokenA, tokenB);
      assert.ok(storage.store.has('tc_launchIntent:project-a'));
      assert.ok(storage.store.has('tc_launchIntent:project-b'));
    });
  });

  describe('consumeLaunchQueryParam', () => {
    /**
     * Run the real consumeLaunchQueryParam() against a mocked
     * location/history/localStorage, capturing what it does rather than
     * re-declaring its logic.
     * @param {string} url - The `?search#hash` suffix to present (`intent`
     *   lives in the hash, matching the real href — a URL fragment is
     *   never sent to the server, unlike a query param).
     * @param {Record<string,string>} [storageSeed] - Pre-populated localStorage (raw JSON strings).
     * @param {object} [localStorageOverrides] - Extra/overriding localStorage methods (e.g. a failing removeItem).
     * @returns {{launched: string[], replaced: Array<{url:string}>, storage: object}}
     */
    function run(url, storageSeed, localStorageOverrides) {
      const hashIdx = url.indexOf('#');
      const search = hashIdx === -1 ? url : url.slice(0, hashIdx);
      const hash = hashIdx === -1 ? '' : url.slice(hashIdx);
      const launched = [];
      const replaced = [];
      const storage = { ...fakeStorage(storageSeed), ...(localStorageOverrides || {}) };
      const ctx = vm.createContext({
        URLSearchParams,
        location: { search, hash, pathname: '/' },
        history: { replaceState: (state, title, url) => replaced.push({ url }) },
        localStorage: storage,
        launchProject: (name) => { launched.push(name); }
      });
      const fnSrc = liftDeclaration(LANDING_SRC, 'function consumeLaunchQueryParam()');
      vm.runInContext(`${fnSrc}\nconsumeLaunchQueryParam();`, ctx);
      return { launched, replaced, storage };
    }

    it('is a no-op with no launch param at all', () => {
      const { launched, replaced } = run('');
      assert.deepEqual(launched, []);
      assert.deepEqual(replaced, []);
    });

    it('launches and consumes (removes) the token when intent matches (PRR-A C5: single-use)', () => {
      const { launched, replaced, storage } = run(
        '?launch=my-project#intent=tok-1', { 'tc_launchIntent:my-project': record('tok-1', Date.now()) });
      assert.deepEqual(launched, ['my-project']);
      assert.equal(replaced.length, 1);
      assert.equal(replaced[0].url, '/', 'both launch and intent must be stripped from the URL');
      assert.equal(storage.getItem('tc_launchIntent:my-project'), null, 'the token must be removed after use — single-use');
    });

    it('makes ZERO launch calls when intent is entirely absent — the pre-fix vulnerability this closes (PRR-A C5)', () => {
      const { launched } = run('?launch=my-project', { 'tc_launchIntent:my-project': record('tok-1', Date.now()) });
      assert.deepEqual(launched, [], 'a bare ?launch=<name> GET (what a cross-site link would carry) must never auto-launch');
    });

    it('makes ZERO launch calls when intent does not match the stored token', () => {
      const { launched } = run('?launch=my-project#intent=wrong-token', { 'tc_launchIntent:my-project': record('tok-1', Date.now()) });
      assert.deepEqual(launched, []);
    });

    it('makes ZERO launch calls when no token was ever minted (localStorage empty)', () => {
      const { launched } = run('?launch=my-project#intent=tok-1', {});
      assert.deepEqual(launched, []);
    });

    it('makes ZERO launch calls when the token has expired (PRR-A C5: expiring)', () => {
      const { launched } = run(
        '?launch=my-project#intent=tok-1',
        { 'tc_launchIntent:my-project': record('tok-1', Date.now() - TTL_MS - 1000) });
      assert.deepEqual(launched, []);
    });

    it("makes ZERO launch calls when intent is valid for a DIFFERENT project (PRR-A C5: project-bound)", () => {
      const { launched } = run(
        '?launch=project-b#intent=tok-1', { 'tc_launchIntent:project-a': record('tok-1', Date.now()) });
      assert.deepEqual(launched, [], "project-a's token must not validate a launch=project-b request");
    });

    it('fails CLOSED — makes ZERO launch calls — when localStorage.removeItem throws (PRR-A C5: single-use must be guaranteed, not best-effort)', () => {
      const { launched, storage } = run(
        '?launch=my-project#intent=tok-1',
        { 'tc_launchIntent:my-project': record('tok-1', Date.now()) },
        { removeItem: () => { throw new Error('storage full'); } });
      assert.deepEqual(launched, [], 'a launch must not proceed if single-use removal could not be confirmed');
      assert.ok(storage.getItem('tc_launchIntent:my-project'),
        'the token record is still present (removal failed) — confirms this is the fail-closed path, not a silent success');
    });

    it('a replayed (already-consumed) intent makes zero launch calls on a second attempt', () => {
      // First consumption removes the token; simulate the second attempt
      // starting from that post-removal state.
      const { storage: afterFirst } = run(
        '?launch=my-project#intent=tok-1', { 'tc_launchIntent:my-project': record('tok-1', Date.now()) });
      const replay = run('?launch=my-project#intent=tok-1', Object.fromEntries(afterFirst.store));
      assert.deepEqual(replay.launched, []);
    });

    it('two cards opened in sequence, same shared storage, no re-render in between — both launch, neither invalidates the other (PRR-A C2: the pre-fix single global token made consuming card A delete the token card B\'s already-rendered href needed)', () => {
      // Mint both tokens with the REAL getLaunchIntentToken() against ONE
      // shared storage — exactly what happens when renderCard() draws two
      // project cards into the same page before any poll re-renders them.
      const sharedStorage = fakeStorage();
      let n = 0;
      const mintCtx = vm.createContext({ localStorage: sharedStorage, crypto: { randomUUID: () => `uuid-${++n}` } });
      const mintSrc = liftDeclaration(UI_SRC, 'function getLaunchIntentToken(');
      const tokenA = vm.runInContext(`${mintSrc}\ngetLaunchIntentToken('project-a');`, mintCtx);
      const tokenB = vm.runInContext(`${mintSrc}\ngetLaunchIntentToken('project-b');`, mintCtx);
      assert.notEqual(tokenA, tokenB);

      // "Open card A's link in tab 1" then "open card B's link in tab 2" —
      // two separate consumeLaunchQueryParam() runs against the SAME
      // storage object, with no re-render (no fresh mint) between them.
      function consume(url) {
        const hashIdx = url.indexOf('#');
        const search = hashIdx === -1 ? url : url.slice(0, hashIdx);
        const hash = hashIdx === -1 ? '' : url.slice(hashIdx);
        const launched = [];
        const ctx = vm.createContext({
          URLSearchParams,
          location: { search, hash, pathname: '/' },
          history: { replaceState: () => {} },
          localStorage: sharedStorage,
          launchProject: (name) => { launched.push(name); }
        });
        const fnSrc = liftDeclaration(LANDING_SRC, 'function consumeLaunchQueryParam()');
        vm.runInContext(`${fnSrc}\nconsumeLaunchQueryParam();`, ctx);
        return launched;
      }

      const launchedA = consume(`?launch=project-a#intent=${tokenA}`);
      assert.deepEqual(launchedA, ['project-a'], "consuming card A's link must launch A");

      const launchedB = consume(`?launch=project-b#intent=${tokenB}`);
      assert.deepEqual(launchedB, ['project-b'],
        "consuming card B's link right after A, with no re-render in between, must still launch B — B's token must not have been invalidated by A's consumption");

      // Both are now single-use consumed; replaying either makes zero calls.
      assert.deepEqual(consume(`?launch=project-a#intent=${tokenA}`), []);
      assert.deepEqual(consume(`?launch=project-b#intent=${tokenB}`), []);
    });

    it('decodes an encoded project name', () => {
      const name = "O'Brien's Project";
      const { launched } = run(
        `?launch=${encodeURIComponent(name)}#intent=tok-1`, { [`tc_launchIntent:${name}`]: record('tok-1', Date.now()) });
      assert.deepEqual(launched, [name]);
    });

    it('preserves other query params when stripping launch and intent', () => {
      const { replaced } = run(
        '?launch=my-project&foo=bar#intent=tok-1', { 'tc_launchIntent:my-project': record('tok-1', Date.now()) });
      assert.equal(replaced[0].url, '/?foo=bar');
    });
  });

  it('the rendered Launch href carries #intent=<token> bound to the project name (ui.js)', () => {
    const idx = UI_SRC.indexOf('const launchIntentToken = getLaunchIntentToken(project.name);');
    assert.ok(idx > -1, 'a token minted for THIS project must be read before building the href');
    const snippet = UI_SRC.slice(idx, idx + 200);
    assert.match(snippet, /launchIntentToken \? `#intent=\$\{encodeURIComponent\(launchIntentToken\)\}` : ''/,
      "getLaunchIntentToken() returning null (e.g. crypto.randomUUID absent in an insecure context) must omit #intent= entirely, not embed an empty one");
  });

  it('getLaunchIntentToken falls back to crypto.getRandomValues when randomUUID is absent (PRR-A C1: the REAL shape of this product\'s supported plain-HTTP direct-ingress deployment — getRandomValues is available there even though randomUUID, secure-context-only, is not; returning null instead of falling back would silently disable one-click new-tab launch on a supported deployment)', () => {
    const storage = fakeStorage();
    const ctx = vm.createContext({
      localStorage: storage,
      crypto: {
        // No randomUUID — getRandomValues predates the secure-context
        // restriction and remains available everywhere, which is exactly
        // why it is the fallback rather than a second failure mode.
        getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = i; return arr; }
      }
    });
    const token = vm.runInContext(
      `${liftDeclaration(UI_SRC, 'function getLaunchIntentToken(')}\ngetLaunchIntentToken('my-project');`, ctx);
    assert.equal(typeof token, 'string');
    assert.match(token, /^[0-9a-f]{32}$/, 'must be a valid hex token, not null, so the Launch link still carries an intent');
    const stored = JSON.parse(storage.getItem('tc_launchIntent:my-project'));
    assert.equal(stored.token, token);
  });

  it('getLaunchIntentToken returns null, without throwing, when NEITHER crypto API is available (last-resort case — a throw here would abort the whole card grid render, not just this link)', () => {
    const storage = fakeStorage();
    const ctx = vm.createContext({
      localStorage: storage,
      crypto: {} // neither randomUUID nor getRandomValues
    });
    const token = vm.runInContext(
      `${liftDeclaration(UI_SRC, 'function getLaunchIntentToken(')}\ngetLaunchIntentToken('my-project');`, ctx);
    assert.equal(token, null);
    assert.equal(storage.store.size, 0, 'nothing should be written to localStorage when minting fails');
  });

  it('full mint -> consume round trip succeeds on the insecure-context shape (PRR-A C1: one-click new-tab launch must still work on a plain-HTTP deployment, not just avoid throwing)', () => {
    const sharedStorage = fakeStorage();
    const insecureCrypto = {
      getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 7) % 256; return arr; }
    };

    const mintCtx = vm.createContext({ localStorage: sharedStorage, crypto: insecureCrypto });
    const token = vm.runInContext(
      `${liftDeclaration(UI_SRC, 'function getLaunchIntentToken(')}\ngetLaunchIntentToken('my-project');`, mintCtx);
    assert.ok(token, 'a token must actually be minted, not null, on this supported deployment shape');

    const launched = [];
    const consumeCtx = vm.createContext({
      URLSearchParams,
      location: { search: '?launch=my-project', hash: `#intent=${token}`, pathname: '/' },
      history: { replaceState: () => {} },
      localStorage: sharedStorage,
      launchProject: (name) => { launched.push(name); }
    });
    vm.runInContext(
      `${liftDeclaration(LANDING_SRC, 'function consumeLaunchQueryParam()')}\nconsumeLaunchQueryParam();`, consumeCtx);
    assert.deepEqual(launched, ['my-project'],
      'the getRandomValues-minted token must be accepted by consumeLaunchQueryParam() exactly like a randomUUID-minted one');
  });

  it('init() calls consumeLaunchQueryParam once, after loadProjects() populates state.projects and renders the card', () => {
    const body = liftDeclaration(LANDING_SRC, 'async function init()');
    const loadIdx = body.indexOf('await loadProjects()');
    const consumeIdx = body.indexOf('consumeLaunchQueryParam()');
    assert.ok(loadIdx > -1 && consumeIdx > -1 && loadIdx < consumeIdx,
      'consumeLaunchQueryParam() must run after loadProjects(), once state.projects (and the rendered card) exist');
  });
});

/*
 * #2121 — the Peek panel used to be a DOM node appended to the card and
 * removed on toggle, so the 10s project poll's `grid.innerHTML` replace
 * wiped it out every cycle: it looked like a timer-driven auto-close even
 * though nothing explicitly closed it. `openPeekFromCard` now flips
 * `openPeekProject`/`peekCache` and re-renders, the same fix `toggleCardDetail`
 * already applied for the card detail panel (#1015) — run for real against a
 * `vm` context, the same approach the rest of this file uses for landing.js.
 * The two `let` lines mirror ui.js's own initial state rather than being
 * lifted (`liftDeclaration` only understands brace-bodied declarations).
 */
describe('Peek panel survives a poll re-render instead of auto-closing (#2121)', () => {
  const PROJECTS = [
    { name: 'proj-a', session: { active: true } },
    { name: 'proj-b', session: { active: true } }
  ];

  /**
   * Run the real `openPeekFromCard` in a `vm` context, with `api`/`document`/
   * `renderProjects` stubbed and recording.
   * @param {object[]} projects - `state.projects`.
   * @param {*} apiResult - What the stubbed `api()` resolves to.
   * @returns {{ctx: object, apiCalls: string[], renders: number[]}}
   */
  function buildPeekContext(projects, apiResult) {
    const apiCalls = [];
    const renders = [];
    const ctx = vm.createContext({
      state: { projects },
      api: async (url) => { apiCalls.push(url); return apiResult; },
      document: { querySelector: () => null },
      renderProjects: () => { renders.push(1); },
      CSS: { escape: (s) => s }
    });
    const src = `let openPeekProject = null;\nlet peekCache = {};\n${liftDeclaration(UI_SRC, 'async function openPeekFromCard(')}`;
    vm.runInContext(src, ctx);
    return { ctx, apiCalls, renders };
  }

  it('opens by setting state and re-rendering, not by appending a DOM node', async () => {
    const { ctx, renders } = buildPeekContext(PROJECTS, { lines: ['hello'] });
    await vm.runInContext("openPeekFromCard('proj-a')", ctx);
    assert.equal(vm.runInContext('openPeekProject', ctx), 'proj-a');
    assert.ok(renders.length >= 1, 'must call renderProjects(), which is what keeps it open across the poll');
  });

  it('clicking Peek again on the same project closes it, without a second fetch', async () => {
    const { ctx, apiCalls } = buildPeekContext(PROJECTS, { lines: ['hello'] });
    await vm.runInContext("openPeekFromCard('proj-a')", ctx);
    assert.equal(apiCalls.length, 1);
    await vm.runInContext("openPeekFromCard('proj-a')", ctx);
    assert.equal(vm.runInContext('openPeekProject', ctx), null, 'second click toggles it closed');
    assert.equal(apiCalls.length, 1, 'closing must not re-fetch');
  });

  it('opening a different project closes the first and fetches the second (only one Peek open at a time)', async () => {
    const { ctx, apiCalls } = buildPeekContext(PROJECTS, { lines: ['hello'] });
    await vm.runInContext("openPeekFromCard('proj-a')", ctx);
    await vm.runInContext("openPeekFromCard('proj-b')", ctx);
    assert.equal(vm.runInContext('openPeekProject', ctx), 'proj-b');
    assert.equal(apiCalls.length, 2);
  });

  it('a late response for a since-closed Peek never overwrites peekCache (stale-fetch guard)', async () => {
    let release;
    const apiCalls = [];
    const ctx = vm.createContext({
      state: { projects: PROJECTS },
      api: async (url) => {
        apiCalls.push(url);
        return new Promise((resolve) => { release = () => resolve({ lines: ['late'] }); });
      },
      document: { querySelector: () => null },
      renderProjects: () => {},
      CSS: { escape: (s) => s }
    });
    const src = `let openPeekProject = null;\nlet peekCache = {};\n${liftDeclaration(UI_SRC, 'async function openPeekFromCard(')}`;
    vm.runInContext(src, ctx);

    const firstOpen = vm.runInContext("openPeekFromCard('proj-a')", ctx); // fetch still in flight
    await vm.runInContext("openPeekFromCard('proj-a')", ctx); // closes it before the fetch resolves
    assert.equal(vm.runInContext('openPeekProject', ctx), null);
    release();
    await firstOpen;
    // Field-by-field, not deepEqual: the object is built inside the vm
    // realm, and deepEqual against a main-realm literal fails on the
    // prototype mismatch even when every field matches (same pitfall
    // collectTags's test above works around for a vm-realm Array).
    const cached = vm.runInContext('peekCache', ctx)['proj-a'];
    assert.equal(cached.loading, true, 'the late fetch for the already-closed Peek must not overwrite the cache with its stale content');
    assert.equal(cached.lines, null);
  });

  it("renderCard's isPeekOpen is typeof-guarded (several isolated-lift test harnesses run renderCard() standalone and don't declare openPeekProject — a bare reference ReferenceErrors there instead of evaluating false)", () => {
    const body = liftDeclaration(UI_SRC, 'function renderCard(project)');
    assert.match(body, /const isPeekOpen = typeof openPeekProject !== 'undefined' && openPeekProject === project\.name;/);
    assert.match(body, /\$\{isPeekOpen \? renderCardPeek\(project\) : ''\}/);
  });

  describe("renderProjects()'s scroll-position carry across the grid replace (Critic BLOCKING: the capture/restore had zero coverage)", () => {
    /**
     * Run the real `renderProjects` with a fake `.card-peek-content` element
     * that resets to `scrollTop: 0` the instant `grid.innerHTML` is
     * reassigned — exactly what a real re-render does, since the old node is
     * destroyed and a fresh one takes its place.
     * @param {string|null} openPeekProject - Which project's Peek is open, or none.
     * @param {number} startingScrollTop - Where the operator had scrolled to.
     * @returns {{render: Function, currentEl: () => {scrollTop: number}}}
     */
    function buildScrollHarness(openPeekProject, startingScrollTop) {
      let currentEl = { scrollTop: startingScrollTop };
      const grid = {};
      Object.defineProperty(grid, 'innerHTML', {
        get() { return ''; },
        // A fresh DOM node always starts at scrollTop 0, same as a real re-render.
        set() { currentEl = { scrollTop: 0 }; }
      });
      const documentStub = {
        getElementById: () => grid,
        querySelector: (sel) => (sel === '.card-peek-content' ? currentEl : null)
      };
      const render = new Function(
        'document', 'filterProjects', 'renderCard', 'renderRootPanel',
        'openCardDetail', 'ensureStrandedItems', 'state', 'openPeekProject',
        `${liftDeclaration(UI_SRC, 'function renderProjects()')}\nreturn renderProjects;`
      )(
        documentStub,
        () => [{ name: 'proj-a' }],
        (p) => `<card>${p.name}</card>`,
        () => '<ROOT-PANEL>',
        null,
        () => {},
        { projects: [{ name: 'proj-a' }], projectsScan: null },
        openPeekProject
      );
      return { render, currentEl: () => currentEl };
    }

    it('restores the operator\'s scroll position onto the fresh node when a Peek is open', () => {
      const { render, currentEl } = buildScrollHarness('proj-a', 137);
      render();
      assert.equal(currentEl().scrollTop, 137, 'the fresh .card-peek-content must be scrolled back to where it was before the poll');
    });

    it('does nothing when no Peek is open — the fresh node is left at its natural 0', () => {
      const { render, currentEl } = buildScrollHarness(null, 137);
      render();
      assert.equal(currentEl().scrollTop, 0, 'with openPeekProject null, nothing should attempt to read or restore scrollTop');
    });

    it('is typeof-guarded the same way isPeekOpen is (isolated-lift harnesses for renderProjects don\'t declare openPeekProject either)', () => {
      const body = liftDeclaration(UI_SRC, 'function renderProjects()');
      assert.match(body, /const peekIsOpen = typeof openPeekProject !== 'undefined' && openPeekProject;/);
    });
  });
});
