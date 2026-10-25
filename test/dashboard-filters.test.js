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

describe('card Launch/Open control is a real link only when it is pure navigation (#2124)', () => {
  const { loadJsArg } = require('./helpers/lift');
  const jsArg = loadJsArg('landing.js');

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

  it('the not-yet-active ("Launch") branch stays a plain <button> with no href (#2124 PRR BLOCKING: launching is a mutating POST — a GET-safe link to /session/:name would show "no active session" instead of starting one)', () => {
    const idx = UI_SRC.indexOf(': `<button class="btn btn-compact btn-launch"');
    assert.ok(idx > -1, 'ui.js must still render a <button> for the not-yet-active case');
    const snippet = UI_SRC.slice(idx, idx + 220);
    assert.doesNotMatch(snippet, /href=/, 'the Launch button must carry no href');
    assert.match(snippet, /onclick="event\.stopPropagation\(\);\s*launchProject/);
    assert.match(snippet, />Launch<\/button>/);
  });

  it('doLaunchProject\'s button lookup matches the ACTUAL rendered onclick attribute (PRR WARNING: jsArg renders a double-quoted argument, not single-quoted)', () => {
    const body = liftDeclaration(LANDING_SRC, 'async function doLaunchProject(');
    assert.match(body, /document\.querySelector\(`button\[onclick\*='launchProject\("\$\{name\}"\)'\]`\)/,
      'the selector must look for a double-quoted argument — that is what jsArg actually renders');

    // Reproduce the real pipeline: build the onclick attribute exactly as
    // ui.js does, decode it the way a browser decodes an HTML attribute
    // value, then confirm the FIXED selector's literal substring is actually
    // present — not just that the source text looks plausible.
    const name = "O'Brien's \"Project\"";
    const nArg = jsArg(name);
    const rawAttr = `event.stopPropagation(); launchProject(${nArg})`;
    const decoded = rawAttr
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const selectorSubstring = `launchProject(${JSON.stringify(name)})`;
    assert.ok(decoded.includes(selectorSubstring),
      `decoded onclick attribute (${decoded}) must contain the selector's substring (${selectorSubstring})`);
  });

  it('doLaunchProject uses the button\'s native .disabled (back to a <button>, no pending-state class needed)', () => {
    const body = liftDeclaration(LANDING_SRC, 'async function doLaunchProject(');
    assert.match(body, /btn\.disabled = true/);
    assert.match(body, /btn\.disabled = false/);
    assert.doesNotMatch(body, /classList/, 'no class-based pending state — the control is a real <button> again');
  });

  it('style.css carries no leftover .is-launching rule', () => {
    assert.doesNotMatch(CSS_SRC, /is-launching/);
  });
});
