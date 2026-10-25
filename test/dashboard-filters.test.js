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
    const idx = UI_SRC.indexOf(': `<a class="btn btn-compact btn-launch" data-project-name=');
    assert.ok(idx > -1, 'ui.js must render an <a href="/?launch=..."> for the not-yet-active case');
    const snippet = UI_SRC.slice(idx, idx + 260);
    assert.match(snippet, /href="\/\?launch=\$\{encodeURIComponent\(project\.name\)\}"/);
    assert.match(snippet, /onclick="event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*launchProject/,
      'left-click must still preventDefault and run launchProject immediately, without a page reload');
    assert.match(snippet, />Launch<\/a>/);
  });

  it('both controls carry data-project-name, HTML-escaped the same way every other attribute on the card is', () => {
    const openIdx = UI_SRC.indexOf('? `<a class="btn btn-compact btn-launch"');
    const launchIdx = UI_SRC.indexOf(': `<a class="btn btn-compact btn-launch" data-project-name=');
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

describe('consumeLaunchQueryParam turns a ?launch=<name> landing into a real launch (#2124)', () => {
  /**
   * Run the real consumeLaunchQueryParam() against a mocked location/history,
   * capturing what it does rather than re-declaring its logic.
   * @param {string} search - `location.search` to present, e.g. '?launch=foo'.
   * @returns {{launched: string[], replaced: Array<{url:string}>}}
   */
  function run(search) {
    const launched = [];
    const replaced = [];
    const ctx = vm.createContext({
      URLSearchParams,
      location: { search, pathname: '/' },
      history: { replaceState: (state, title, url) => replaced.push({ url }) },
      launchProject: (name) => { launched.push(name); }
    });
    const fnSrc = liftDeclaration(LANDING_SRC, 'function consumeLaunchQueryParam()');
    vm.runInContext(`${fnSrc}\nconsumeLaunchQueryParam();`, ctx);
    return { launched, replaced };
  }

  it('is a no-op with no launch param', () => {
    const { launched, replaced } = run('');
    assert.deepEqual(launched, []);
    assert.deepEqual(replaced, []);
  });

  it('strips the param and launches the named project', () => {
    const { launched, replaced } = run('?launch=my-project');
    assert.deepEqual(launched, ['my-project']);
    assert.equal(replaced.length, 1);
    assert.equal(replaced[0].url, '/');
  });

  it('decodes an encoded project name', () => {
    const { launched } = run(`?launch=${encodeURIComponent("O'Brien's Project")}`);
    assert.deepEqual(launched, ["O'Brien's Project"]);
  });

  it('preserves other query params when stripping launch', () => {
    const { replaced } = run('?launch=my-project&foo=bar');
    assert.equal(replaced[0].url, '/?foo=bar');
  });

  it('init() calls it once, after loadProjects() populates state.projects and renders the card', () => {
    const body = liftDeclaration(LANDING_SRC, 'async function init()');
    const loadIdx = body.indexOf('await loadProjects()');
    const consumeIdx = body.indexOf('consumeLaunchQueryParam()');
    assert.ok(loadIdx > -1 && consumeIdx > -1 && loadIdx < consumeIdx,
      'consumeLaunchQueryParam() must run after loadProjects(), once state.projects (and the rendered card) exist');
  });
});
