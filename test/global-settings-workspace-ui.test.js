'use strict';

/*
 * #3319 — Global Settings rebuilt from a skinny 440px modal into a
 * full-screen workspace with a left-hand category rail (General & Server,
 * Storage & System Health, Engines & Quotas, Security & Auth, Backups &
 * Maintenance, Bridge & Notifications — the charter's own list), a search
 * box that filters across every category, and a deep-linkable `#settings/
 * <category>` hash. Every existing control/id/handler from the old modal
 * must survive unchanged (`saveGlobalSettings`/`closeGlobalSettings`/
 * `openGlobalSettings` and every `gs*`-prefixed id other test files already
 * assert on), so this file does not re-test those — only what #3319 added.
 *
 * `public/ui.js` renders via innerHTML strings with many top-level
 * dependencies (state, esc, api, apiMutate), so — matching this repo's own
 * established convention for this file (see test/settings-credential.test.js)
 * — the markup/wiring shape is pinned with structural source assertions.
 * The new rail/search/hash logic (`_gsShowCategory`, `_gsApplySearchFilter`,
 * `_gsActiveCategoryFromHash`) is small and free of DOM-mutation side
 * effects beyond simple property/attribute writes, so it is additionally
 * lifted and run against a minimal hand-built fake document/window to pin
 * real behavior, not just source shape.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { liftDeclaration } = require('./helpers/lift');

const UI_PATH = path.join(__dirname, '..', 'public', 'ui.js');
const HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');

const CATEGORIES = ['general', 'storage', 'engines', 'security', 'backups', 'bridge'];

describe('Global Settings workspace markup (#3319)', () => {
  let html;
  let modalBlock;

  before(() => {
    html = fs.readFileSync(HTML_PATH, 'utf8');
    const start = html.indexOf('<div class="modal-backdrop" id="globalSettingsModal">');
    assert.ok(start > -1, 'globalSettingsModal must exist');
    const end = html.indexOf('<!-- Setup Wizard Overlay -->', start);
    assert.ok(end > start, 'could not bound the Global Settings modal block');
    modalBlock = html.slice(start, end);
  });

  it('is a true full-viewport page, not the old bounded 440px box', () => {
    assert.doesNotMatch(modalBlock, /max-width:\s*440px/);
    assert.match(modalBlock, /position:\s*fixed;\s*inset:\s*0/);
    assert.match(modalBlock, /width:\s*100vw;\s*height:\s*100vh/);
  });

  it('carries the global-settings-modal class for the new CSS layout rules', () => {
    assert.match(modalBlock, /class="modal-content global-settings-modal"/);
  });

  it('has a search input and a dedicated close button, both with accessible labels', () => {
    assert.match(modalBlock, /id="gsSearchFilter"/);
    assert.match(modalBlock, /aria-label="Search Global Settings"/);
    assert.match(modalBlock, /id="globalSettingsCloseBtn"/);
    assert.match(modalBlock, /aria-label="Close Global Settings"/);
  });

  it('has exactly the 6 charter categories in the rail, each with a stable id', () => {
    for (const cat of CATEGORIES) {
      assert.match(modalBlock, new RegExp(`data-gs-category="${cat}"`),
        `rail is missing category "${cat}"`);
    }
    const railButtons = modalBlock.match(/data-gs-category="[a-z]+"/g) || [];
    assert.equal(railButtons.length, CATEGORIES.length,
      'rail must declare each category exactly once');
  });

  it('still has the Cancel/Save actions, unchanged ids', () => {
    assert.match(modalBlock, /id="globalSettingsCancelBtn"/);
    assert.match(modalBlock, /id="globalSettingsSaveBtn"/);
  });

  it('still has the #globalSettingsBody content pane the save/load code targets', () => {
    assert.match(modalBlock, /id="globalSettingsBody"/);
  });
});

describe('Global Settings workspace CSS (#3319)', () => {
  let css;

  before(() => {
    css = fs.readFileSync(CSS_PATH, 'utf8');
  });

  it('defines the full-viewport flex-column shell, mirroring .settings-modal', () => {
    assert.match(css, /\.modal-content\.global-settings-modal\s*\{[^}]*display:\s*flex/s);
    assert.match(css, /\.modal-content\.global-settings-modal\s*\{[^}]*flex-direction:\s*column/s);
  });

  it('defines the rail and content pane as a row, and a narrow-viewport collapse', () => {
    assert.match(css, /\.gs-category-rail\s*\{/);
    assert.match(css, /\.gs-workspace-content\s*\{/);
    assert.match(css, /@media \(max-width:\s*720px\)\s*\{[^]*\.gs-category-rail/);
  });

  it('uses this app\'s real theme variables, not guessed/undefined ones', () => {
    const railBlock = css.slice(css.indexOf('.gs-category-rail {'), css.indexOf('.gs-workspace-content {'));
    assert.doesNotMatch(railBlock, /--border-color\b/, 'this app uses --border, not --border-color');
    assert.doesNotMatch(railBlock, /--accent\b/, 'this app uses --primary, not --accent');
    assert.doesNotMatch(railBlock, /--hover-bg\b/, 'this app uses --elevated-bg for hover states');
  });

  it('hides a non-active/non-matching category section out of layout entirely', () => {
    assert.match(css, /\.gs-category-section\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  });
});

describe('openGlobalSettings() re-bucketing and the new storage field (#3319)', () => {
  let src;
  let fn;

  before(() => {
    src = fs.readFileSync(UI_PATH, 'utf8');
    fn = liftDeclaration(src, 'function openGlobalSettings(');
  });

  it('wraps every section in a <section data-gs-category> with balanced open/close tags', () => {
    const opens = (fn.match(/<section class="gs-category-section"/g) || []).length;
    const closes = (fn.match(/^\s*<\/section>\s*$/gm) || []).length;
    assert.ok(opens > 0, 'must have at least one category section');
    assert.equal(opens, closes, 'every <section> opened in the template must be closed');
  });

  it('declares every one of the 6 charter categories at least once', () => {
    for (const cat of CATEGORIES) {
      assert.match(fn, new RegExp(`data-gs-category="${cat}"`), `missing section for "${cat}"`);
    }
  });

  it('keeps every existing control the save/load handlers depend on, unchanged by id', () => {
    // gsTailscaleMode is deliberately excluded here: it is rendered by a
    // separate renderTailscaleModeSetting(c) call interpolated into this
    // template, so its id literal lives in THAT function's own source, not
    // openGlobalSettings's — saveGlobalSettings's own test below already
    // covers that the Save handler still reads it.
    const existingIds = [
      'gsTheme', 'gsPeekMode', 'gsChimeMuted', 'gsDefaultEngine', 'gsProjectsDir',
      'gsPortScannerEnabled', 'gsPortScannerInterval', 'gsStripAiCoauthors',
      'gsServiceTokenEnabled', 'gsBindAllInterfaces',
      'gsOperatorBridgeSection', 'gsBridgeStepUpSection', 'gsBridgeSettingsSection',
      'gsIsolationOverrideSection', 'gsEngineSettingsContainer', 'gsRestartBtn',
      'gsRecoveryCodesSection'
    ];
    for (const id of existingIds) {
      assert.match(fn, new RegExp(`id="${id}"`), `must still render #${id}`);
    }
  });

  it('renders the Tailscale mode setting inside the "security" category (via its own helper call)', () => {
    const securityStart = fn.indexOf('data-gs-category="security"');
    const securityEnd = fn.indexOf('</section>', securityStart);
    const securityBlock = fn.slice(securityStart, securityEnd);
    assert.match(securityBlock, /renderTailscaleModeSetting\(c\)/);
  });

  it('places the new storage threshold field inside the "storage" category only', () => {
    const storageSection = fn.slice(
      fn.indexOf('data-gs-category="storage"'),
      fn.indexOf('</section>', fn.indexOf('data-gs-category="storage"'))
    );
    assert.match(storageSection, /id="gsStorageWarningThresholdPct"/);
    assert.match(storageSection, /min="50"/);
    assert.match(storageSection, /max="98"/);

    // And nowhere else.
    const occurrences = (fn.match(/id="gsStorageWarningThresholdPct"/g) || []).length;
    assert.equal(occurrences, 1);
  });

  it('defaults the storage threshold to 85 and clamps to [50, 98] when reading config', () => {
    assert.match(src, /storageWarningThresholdPct\s*=\s*Math\.min\(98,\s*Math\.max\(50,/);
    assert.match(src, /\?\?\s*c\.storageWarningThresholdPct\s*\?\?\s*85/);
  });

  it('shows a "not yet active" caveat on the storage field until the backend recognizes either field name (Critic finding, Car V667-W1-A)', () => {
    assert.match(src, /storageThresholdPersists\s*=\s*\n?\s*c\.diskWarningThresholdPercent !== undefined \|\| c\.storageWarningThresholdPct !== undefined/);
    const storageSection = fn.slice(
      fn.indexOf('data-gs-category="storage"'),
      fn.indexOf('</section>', fn.indexOf('data-gs-category="storage"'))
    );
    assert.match(storageSection, /storageThresholdPersists \? '' : '<br><strong>Not yet active:/);
  });

  it('selects the initial category on every open, but does NOT re-wire the rail/search box', () => {
    assert.match(fn, /_gsShowCategory\(_gsActiveCategoryFromHash\(\) \|\| 'general'\)/);
    // Critic cumulative review, Car V667-W1-A: the rail and search box are
    // static markup outside #globalSettingsBody, so wiring them from inside
    // openGlobalSettings() would stack a fresh listener on every open. They
    // are wired exactly once at module load instead — see the two "wires
    // exactly once at module load" tests below.
    assert.doesNotMatch(fn, /_gsWireCategoryRail\(\);/);
    assert.doesNotMatch(fn, /_gsWireSearchFilter\(\);/);
  });
});

describe('Rail/search wiring happens exactly once, not on every open (#3319)', () => {
  let src;

  before(() => {
    src = fs.readFileSync(UI_PATH, 'utf8');
  });

  it('_gsWireCategoryRail() and _gsWireSearchFilter() are each called exactly once in the whole file', () => {
    const wireRailCalls = (src.match(/_gsWireCategoryRail\(\);/g) || []).length;
    const wireSearchCalls = (src.match(/_gsWireSearchFilter\(\);/g) || []).length;
    assert.equal(wireRailCalls, 1, '_gsWireCategoryRail() must be called exactly once (module load), never from openGlobalSettings()');
    assert.equal(wireSearchCalls, 1, '_gsWireSearchFilter() must be called exactly once (module load), never from openGlobalSettings()');
  });

  it('that one call site sits in the top-level event-wiring block, not inside a function', () => {
    const idx = src.indexOf('_gsWireCategoryRail();');
    assert.ok(idx > -1);
    // Top-level statements in this file are not indented; a call wired
    // inside openGlobalSettings() or any other function would be indented.
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    assert.equal(src.slice(lineStart, idx), '', 'the call must be a top-level, unindented statement');
  });
});

describe('saveGlobalSettings() sends the new field defensively (#3319/#3318)', () => {
  let fn;

  before(() => {
    const src = fs.readFileSync(UI_PATH, 'utf8');
    fn = liftDeclaration(src, 'async function saveGlobalSettings(');
  });

  it('sends both candidate backend field names, so persistence starts working under whichever name lands', () => {
    assert.match(fn, /diskWarningThresholdPercent:\s*storageThresholdPct/);
    assert.match(fn, /storageWarningThresholdPct:\s*storageThresholdPct/);
  });

  it('clamps a manually-typed out-of-range or non-numeric value before sending it', () => {
    assert.match(fn, /parseInt\(storageThresholdEl\.value,\s*10\)/);
    assert.match(fn, /Math\.min\(98,\s*Math\.max\(50,\s*isNaN\(storageThresholdRaw\)\s*\?\s*85\s*:\s*storageThresholdRaw\)\)/);
  });

  it('still sends every pre-existing field unchanged', () => {
    for (const key of [
      'theme:', 'peekMode:', 'chimeMuted:', 'defaultEngine:', 'projectsDir:',
      'portScannerEnabled:', 'portScannerIntervalMs:', 'stripAiCoauthors:',
      'serviceTokenEnabled:', 'tailscaleMode:'
    ]) {
      assert.match(fn, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});

describe('closeGlobalSettings() drops the deep-link hash on close (#3319)', () => {
  it('clears the hash when one was set, leaving the rest of the URL untouched', () => {
    const src = fs.readFileSync(UI_PATH, 'utf8');
    const fn = liftDeclaration(src, 'function closeGlobalSettings(');
    assert.match(fn, /_gsActiveCategoryFromHash\(\)/);
    assert.match(fn, /window\.history\.replaceState\(null, '', window\.location\.pathname \+ window\.location\.search\)/);
  });
});

describe('Escape and the dedicated close button (#3319)', () => {
  it('wires globalSettingsCloseBtn to closeGlobalSettings', () => {
    const src = fs.readFileSync(UI_PATH, 'utf8');
    assert.match(src, /\$\('globalSettingsCloseBtn'\)\.addEventListener\('click', closeGlobalSettings\)/);
  });

  it('wires Escape to close the workspace only while it is open', () => {
    const src = fs.readFileSync(UI_PATH, 'utf8');
    const idx = src.indexOf("e.key === 'Escape' && $('globalSettingsModal')");
    assert.ok(idx > -1, 'must guard Escape handling on the modal\'s own .open state');
    const handler = src.slice(idx, src.indexOf('});', idx) + 3);
    assert.match(handler, /classList\.contains\('open'\)/);
    assert.match(handler, /closeGlobalSettings\(\)/);
  });
});

/*
 * Behavioral coverage for the new rail/search/hash logic, lifted and run
 * against a minimal hand-built fake document/window — NOT a full mini-DOM.
 * Every fake element implements only what these functions actually call
 * (getAttribute/setAttribute/classList.toggle/querySelectorAll on `.form-
 * group`/textContent/hidden), listed explicitly below so a future change
 * that starts calling something new fails loudly here instead of silently
 * no-op'ing on an unimplemented fake method.
 */
describe('Global Settings rail/search/hash behavior (#3319)', () => {
  function makeRailItem(category) {
    const item = { category, classes: new Set(), attrs: {} };
    item.getAttribute = (name) => (name === 'data-gs-category' ? item.category : null);
    item.setAttribute = (name, val) => { item.attrs[name] = val; };
    item.classList = {
      toggle: (cls, state) => { if (state) item.classes.add(cls); else item.classes.delete(cls); },
      remove: (cls) => { item.classes.delete(cls); }
    };
    return item;
  }

  function makeGroup(text) {
    return { textContent: text, hidden: false };
  }

  function makeSection(category, groups) {
    const section = { category, hidden: true, groups: groups || [] };
    section.getAttribute = (name) => (name === 'data-gs-category' ? section.category : null);
    section.querySelectorAll = (sel) => (sel === '.form-group' ? section.groups : []);
    return section;
  }

  function makeEnv({ hash = '' } = {}) {
    const sections = CATEGORIES.map((cat) => makeSection(cat, [makeGroup(`${cat} field one`), makeGroup(`${cat} field two`)]));
    const railItems = CATEGORIES.map((cat) => makeRailItem(cat));
    const searchEl = { value: '' };
    const historyCalls = [];
    const win = {
      location: { hash, pathname: '/app', search: '' },
      history: {
        replaceState(state, title, url) {
          historyCalls.push(url);
          win.location.hash = url.indexOf('#') === 0 ? url : '';
        }
      }
    };
    const doc = {
      querySelectorAll(sel) {
        if (sel === '.gs-category-section') return sections;
        if (sel === '.gs-category-rail-item') return railItems;
        return [];
      },
      getElementById(id) { return id === 'gsSearchFilter' ? searchEl : null; }
    };
    return { doc, win, sections, railItems, searchEl, historyCalls };
  }

  function loadGs() {
    const src = fs.readFileSync(UI_PATH, 'utf8');
    const startIdx = src.indexOf('const GS_CATEGORIES = [');
    assert.ok(startIdx > -1, 'GS_CATEGORIES must exist');
    const wireSearchDecl = liftDeclaration(src, 'function _gsWireSearchFilter(');
    const endIdx = src.indexOf(wireSearchDecl) + wireSearchDecl.length;
    const block = src.slice(startIdx, endIdx);
    const factory = new Function('document', 'window', `
      ${block}
      return {
        showCategory: _gsShowCategory,
        wireCategoryRail: _gsWireCategoryRail,
        applySearchFilter: _gsApplySearchFilter,
        wireSearchFilter: _gsWireSearchFilter,
        activeCategoryFromHash: _gsActiveCategoryFromHash,
        categories: GS_CATEGORIES,
        hashPrefix: GS_HASH_PREFIX,
        getActive: () => gsActiveCategory
      };
    `);
    return factory;
  }

  it('GS_CATEGORIES is exactly the 6 charter categories, in rail order', () => {
    const { doc, win } = makeEnv();
    const gs = loadGs()(doc, win);
    assert.deepEqual(gs.categories, CATEGORIES);
  });

  it('_gsShowCategory shows only the chosen category\'s section and marks its rail item active', () => {
    const { doc, win, sections, railItems } = makeEnv();
    const gs = loadGs()(doc, win);
    gs.showCategory('security');
    for (const section of sections) {
      assert.equal(section.hidden, section.category !== 'security',
        `section "${section.category}" hidden should reflect whether it is the chosen category`);
    }
    for (const item of railItems) {
      assert.equal(item.classes.has('is-active'), item.category === 'security');
      assert.equal(item.attrs['aria-pressed'], item.category === 'security' ? 'true' : 'false');
    }
  });

  it('_gsShowCategory falls back to "general" for an unknown category name', () => {
    const { doc, win } = makeEnv();
    const gs = loadGs()(doc, win);
    gs.showCategory('not-a-real-category');
    assert.equal(gs.getActive(), 'general');
  });

  it('_gsShowCategory reflects the chosen category in the hash via replaceState', () => {
    const { doc, win, historyCalls } = makeEnv();
    const gs = loadGs()(doc, win);
    gs.showCategory('bridge');
    assert.equal(historyCalls[historyCalls.length - 1], '#settings/bridge');
    assert.equal(win.location.hash, '#settings/bridge');
  });

  it('_gsShowCategory clears the search box so switching categories never leaves a stale filter applied', () => {
    const { doc, win, searchEl } = makeEnv();
    searchEl.value = 'leftover query';
    const gs = loadGs()(doc, win);
    gs.showCategory('engines');
    assert.equal(searchEl.value, '');
  });

  it('_gsActiveCategoryFromHash reads a valid deep-link hash', () => {
    const { doc, win } = makeEnv({ hash: '#settings/security' });
    const gs = loadGs()(doc, win);
    assert.equal(gs.activeCategoryFromHash(), 'security');
  });

  it('_gsActiveCategoryFromHash rejects an unknown category name in the hash', () => {
    const { doc, win } = makeEnv({ hash: '#settings/not-a-category' });
    const gs = loadGs()(doc, win);
    assert.equal(gs.activeCategoryFromHash(), null);
  });

  it('_gsActiveCategoryFromHash returns null for a hash that is not a settings deep link at all', () => {
    const { doc, win } = makeEnv({ hash: '#/some/other/route' });
    const gs = loadGs()(doc, win);
    assert.equal(gs.activeCategoryFromHash(), null);
  });

  it('a non-empty search query reveals every category that has a matching field, not just the active one', () => {
    const { doc, win, sections } = makeEnv();
    const gs = loadGs()(doc, win);
    gs.showCategory('general'); // start somewhere other than the matches, to prove search isn't scoped to it
    gs.applySearchFilter('bridge field');
    const bridgeSection = sections.find((s) => s.category === 'bridge');
    const generalSection = sections.find((s) => s.category === 'general');
    assert.equal(bridgeSection.hidden, false, 'the category containing a match must be revealed');
    assert.equal(generalSection.hidden, true, 'a category with no matching field must hide');
  });

  it('search hides only the non-matching fields within a revealed category, not the matching ones', () => {
    const { doc, win, sections } = makeEnv();
    const gs = loadGs()(doc, win);
    const target = sections.find((s) => s.category === 'storage');
    target.groups = [makeGroup('storage warning threshold'), makeGroup('unrelated storage field')];
    gs.applySearchFilter('warning threshold');
    assert.equal(target.groups[0].hidden, false);
    assert.equal(target.groups[1].hidden, true);
  });

  it('search is case-insensitive', () => {
    const { doc, win, sections } = makeEnv();
    const gs = loadGs()(doc, win);
    gs.applySearchFilter('SECURITY');
    const securitySection = sections.find((s) => s.category === 'security');
    assert.equal(securitySection.hidden, false);
  });

  it('clearing the search query reverts to the plain single-category view', () => {
    const { doc, win, sections } = makeEnv();
    const gs = loadGs()(doc, win);
    gs.showCategory('engines');
    gs.applySearchFilter('bridge field');
    gs.applySearchFilter(''); // clear
    for (const section of sections) {
      assert.equal(section.hidden, section.category !== 'engines',
        'an empty query must restore the rail\'s own current category selection');
    }
  });

  it('_gsWireCategoryRail attaches a click listener per rail item that calls showCategory', () => {
    const listeners = [];
    const { doc, win, railItems } = makeEnv();
    for (const item of railItems) {
      item.addEventListener = (type, fn) => listeners.push({ type, fn, category: item.category });
    }
    const gs = loadGs()(doc, win);
    gs.wireCategoryRail();
    assert.equal(listeners.length, CATEGORIES.length);
    const bridgeListener = listeners.find((l) => l.category === 'bridge');
    bridgeListener.fn();
    assert.equal(gs.getActive(), 'bridge');
  });

  it('_gsWireSearchFilter attaches an input listener that calls applySearchFilter with the live value', () => {
    const { doc, win, searchEl, sections } = makeEnv();
    searchEl.addEventListener = (type, fn) => { searchEl._inputHandler = fn; };
    const gs = loadGs()(doc, win);
    gs.wireSearchFilter();
    searchEl.value = 'bridge field';
    searchEl._inputHandler();
    const bridgeSection = sections.find((s) => s.category === 'bridge');
    assert.equal(bridgeSection.hidden, false);
  });
});
