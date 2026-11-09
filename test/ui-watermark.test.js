'use strict';

/*
 * The subtle TangleClaw background watermark (#2930): a non-interactive
 * `<img>` overlay behind the terminal viewport (`.tc-session-watermark`,
 * `public/session.html` + `public/openclaw-view.html`) and behind the
 * dashboard's project cards/drawers (`.tc-bg-watermark`, `public/index.html`),
 * plus a `Ctrl+Shift+Up/Down/0` opacity shortcut in `public/api-helper.js`
 * (PM Ruling A506-W1B-R1: ported from TangleClaw-Builder1's live-tuned
 * reference, approved by the Operator).
 *
 * This repo is zero-dependency (no jsdom): markup/CSS are asserted against
 * the static file text, the same pattern `test/wrap-indicator-card.test.js`
 * and friends use for `public/*.html`/`public/*.css`; the keyboard-shortcut
 * logic is lifted out of `public/api-helper.js`'s source text with
 * `test/helpers/lift.js`, the same pattern `test/terminal-chrome-slice2.test.js`
 * uses for other `public/*.js` UMD modules.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { liftDeclaration } = require('./helpers/lift');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * @param {string} name - A file under `public/`.
 * @returns {string}
 */
function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

/**
 * The watermark `<div>` markup shared by both terminal-viewport hosts.
 * @param {string} className - `tc-session-watermark` or `tc-bg-watermark`.
 * @returns {RegExp}
 */
function watermarkMarkup(className) {
  return new RegExp(
    `<div class="${className}" aria-hidden="true"><img src="/tangleclaw-logo\\.png" onerror="this\\.onerror=null;this\\.src='/logo-icon\\.png'" alt=""></div>`
  );
}

describe('#2930 watermark asset', () => {
  it('ships public/tangleclaw-logo.png as a real PNG', () => {
    const file = path.join(PUBLIC_DIR, 'tangleclaw-logo.png');
    assert.equal(fs.existsSync(file), true);
    const header = fs.readFileSync(file).subarray(0, 8);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(header.toString('hex'), '89504e470d0a1a0a');
  });

  it('is deliberately NOT in sw.js STATIC_ASSETS (test/cache-bump-guard.test.js\'s own ' +
    'documented reason: an un-precached public/* image is still cache-first and refreshed ' +
    'by the CACHE_NAME bump alone -- listing it would be redundant, not a fix)', () => {
    const sw = readPublic('sw.js');
    const staticAssetsBlock = sw.match(/const STATIC_ASSETS = \[([\s\S]*?)\n\];/);
    assert.ok(staticAssetsBlock, 'sw.js is missing the STATIC_ASSETS array');
    assert.doesNotMatch(staticAssetsBlock[1], /tangleclaw-logo\.png/);
  });
});

describe('#2930 terminal-viewport watermark markup', () => {
  for (const [file, iframeTitle] of [
    ['session.html', 'Terminal session'],
    ['openclaw-view.html', 'OpenClaw Control UI'],
  ]) {
    it(`${file} overlays .tc-session-watermark inside #terminalViewport, after the iframe`, () => {
      const html = readPublic(file);
      assert.match(html, watermarkMarkup('tc-session-watermark'));
      const viewportMatch = html.match(
        /<div class="terminal-viewport" id="terminalViewport">([\s\S]*?)<\/div>/
      );
      assert.ok(viewportMatch, `${file} is missing #terminalViewport`);
      const inner = viewportMatch[1];
      const iframeIdx = inner.indexOf(`title="${iframeTitle}"`);
      const watermarkIdx = inner.indexOf('tc-session-watermark');
      assert.ok(iframeIdx !== -1, `${file} is missing the terminal iframe`);
      assert.ok(watermarkIdx !== -1, `${file} is missing the watermark inside the viewport`);
      assert.ok(
        watermarkIdx > iframeIdx,
        `${file}'s watermark must come after the iframe so it paints on top`
      );
    });
  }
});

describe('#2930 dashboard watermark markup', () => {
  it('index.html overlays .tc-bg-watermark immediately inside <body>', () => {
    const html = readPublic('index.html');
    assert.match(html, watermarkMarkup('tc-bg-watermark'));
    const bodyIdx = html.indexOf('<body>');
    const watermarkIdx = html.indexOf('tc-bg-watermark');
    assert.ok(bodyIdx !== -1 && watermarkIdx !== -1 && watermarkIdx > bodyIdx);
  });
});

describe('#2930 watermark CSS never intercepts input, and is opacity-var driven', () => {
  /**
   * @param {string} css - A stylesheet's full text.
   * @param {string} selector - e.g. `.tc-session-watermark`.
   * @returns {string} The rule body.
   */
  function rule(css, selector) {
    const escaped = selector.replace(/[.[\]]/g, '\\$&');
    const m = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
    assert.ok(m, `missing rule: ${selector}`);
    return m[1];
  }

  for (const [file, wrapperClass] of [
    ['session.css', 'tc-session-watermark'],
    ['style.css', 'tc-bg-watermark'],
  ]) {
    it(`${file}: .${wrapperClass} is pointer-events: none`, () => {
      const css = readPublic(file);
      assert.match(rule(css, `.${wrapperClass}`), /pointer-events:\s*none/);
    });

    it(`${file}: .${wrapperClass} img reads --tc-watermark-opacity (default 0.16, Car ` +
      '5720-W3-E/#2930 follow-up — was 0.10) with the reference\'s rgba(86, 211, 100) ' +
      'glow, and a light-theme override (also 0.16 as of this car — was 0.08)', () => {
      const css = readPublic(file);
      const img = rule(css, `.${wrapperClass} img`);
      assert.match(img, /opacity:\s*var\(--tc-watermark-opacity,\s*0\.16\)/);
      assert.match(img, /rgba\(86,\s*211,\s*100,\s*0\.18\)/);
      const light = rule(css, `html[data-theme="light"] .${wrapperClass} img`);
      assert.match(light, /opacity:\s*var\(--tc-watermark-opacity,\s*0\.16\)/);
    });
  }
});

describe('#2930 cache bust', () => {
  it('sw.js bumps CACHE_NAME so open sessions pick up the watermark on reload', () => {
    const sw = readPublic('sw.js');
    const match = sw.match(/const CACHE_NAME = 'tangleclaw-v3-(\d+)';/);
    assert.ok(match, 'sw.js is missing the expected CACHE_NAME literal');
    assert.ok(Number(match[1]) >= 77, `CACHE_NAME must be bumped past v3-76, got v3-${match[1]}`);
  });
});

describe('#2930 api-helper.js opacity shortcut (Ctrl+Shift+Up/Down/0)', () => {
  /**
   * Lift the easter egg's pure-ish helpers out of `public/api-helper.js` by
   * source text (no jsdom in this repo), the same way
   * `test/terminal-chrome-slice2.test.js` lifts other `public/*.js` pieces.
   *
   * `_tcHandleWatermarkKeydown`'s body contains string literals with a bare
   * `'}'` character (`k === '}'`), which defeats `liftDeclaration`'s naive
   * brace counter (it counts every `{`/`}` found, including inside strings
   * -- documented and pinned behavior in `test/helpers/lift.js`). So that
   * one function is hand-sliced between two exact markers instead of lifted
   * generically; the other two have no such literal and lift normally.
   * @returns {{STORAGE_KEY: string, DEFAULT: number, readWatermarkOpacity: Function, applyWatermarkOpacity: Function, handleWatermarkKeydown: Function}}
   */
  function loadEasterEgg() {
    const src = readPublic('api-helper.js');
    const constsStart = src.indexOf('const TC_WATERMARK_STORAGE_KEY');
    assert.notEqual(constsStart, -1, 'TC_WATERMARK_STORAGE_KEY must exist');
    const constsEndMarker = "const TC_WATERMARK_DEFAULT_LIGHT = 0.16;";
    const constsEndIdx = src.indexOf(constsEndMarker);
    assert.notEqual(constsEndIdx, -1, 'TC_WATERMARK_DEFAULT_LIGHT must exist and be 0.16');
    const consts = src.slice(constsStart, constsEndIdx + constsEndMarker.length);

    const keydownStart = src.indexOf('function _tcHandleWatermarkKeydown(');
    assert.notEqual(keydownStart, -1, '_tcHandleWatermarkKeydown must exist');
    const keydownEndMarker = '\n\n  function _tcInitWatermarkEasterEgg';
    const keydownEndIdx = src.indexOf(keydownEndMarker, keydownStart);
    assert.notEqual(keydownEndIdx, -1, '_tcHandleWatermarkKeydown must be followed by _tcInitWatermarkEasterEgg');
    const handleWatermarkKeydown = src.slice(keydownStart, keydownEndIdx);

    const body = [
      consts,
      liftDeclaration(src, 'function _tcWatermarkThemeDefault('),
      liftDeclaration(src, 'function _tcReadWatermarkOpacity('),
      liftDeclaration(src, 'function _tcApplyWatermarkOpacity('),
      handleWatermarkKeydown,
      'return { STORAGE_KEY: TC_WATERMARK_STORAGE_KEY, DEFAULT: TC_WATERMARK_DEFAULT,' +
        ' DEFAULT_LIGHT: TC_WATERMARK_DEFAULT_LIGHT,' +
        ' readWatermarkOpacity: _tcReadWatermarkOpacity,' +
        ' applyWatermarkOpacity: _tcApplyWatermarkOpacity,' +
        ' handleWatermarkKeydown: _tcHandleWatermarkKeydown };',
    ].join('\n');
    return new Function('global', body);
  }

  /** A minimal localStorage stub backed by a plain object. */
  function fakeLocalStorage() {
    const store = {};
    return {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      _store: store,
    };
  }

  /**
   * A minimal document stub so `_tcApplyWatermarkOpacity`/`_tcWatermarkThemeDefault`
   * can run without a real DOM.
   * @param {{theme?: string}} [opts] - `theme: 'light'` sets `data-theme="light"`.
   */
  function fakeDocument(opts = {}) {
    const props = {};
    return {
      documentElement: {
        style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } },
        getAttribute: (name) => (name === 'data-theme' ? (opts.theme || null) : null),
      },
      body: null,
      getElementById: () => null,
      _props: props,
    };
  }

  it('uses the underscored localStorage key and the 0.16 default (Car 5720-W3-E, ' +
    '#2930 follow-up — not the issue text\'s hyphenated "tc-watermark-opacity" typo)', () => {
    const factory = loadEasterEgg();
    const egg = factory({});
    assert.equal(egg.STORAGE_KEY, 'tc_watermark_opacity');
    assert.equal(egg.DEFAULT, 0.16);
    assert.equal(egg.DEFAULT_LIGHT, 0.16);
  });

  it('readWatermarkOpacity: null when unset, parses a valid stored value, rejects out-of-range/garbage', () => {
    const factory = loadEasterEgg();
    const localStorage = fakeLocalStorage();
    const egg = factory({ localStorage });
    assert.equal(egg.readWatermarkOpacity(), null);
    localStorage.setItem('tc_watermark_opacity', '0.2');
    assert.equal(egg.readWatermarkOpacity(), 0.2);
    localStorage.setItem('tc_watermark_opacity', '0.99');
    assert.equal(egg.readWatermarkOpacity(), null, 'above the 0.85 ceiling is rejected');
    localStorage.setItem('tc_watermark_opacity', 'not-a-number');
    assert.equal(egg.readWatermarkOpacity(), null);
  });

  it('Ctrl+Shift+ArrowUp in LIGHT theme steps off the CSS default it actually renders ' +
    'at, via _tcWatermarkThemeDefault\'s own theme branch, not a hardcoded value ' +
    '(PRR-A I-Gate finding, originally 8% -> 10% when the two defaults differed; Car ' +
    '5720-W3-E/#2930 made DEFAULT and DEFAULT_LIGHT the same 0.16, so this specific ' +
    'assertion can no longer tell "used the light branch" apart from "always used the ' +
    'dark one" by its OUTCOME alone — it still exercises the real code path, and its ' +
    'full differentiating power returns automatically the moment the two constants ' +
    'diverge again)', () => {
    const factory = loadEasterEgg();
    const localStorage = fakeLocalStorage();
    const document = fakeDocument({ theme: 'light' });
    const egg = factory({ localStorage, document });
    egg.handleWatermarkKeydown({ ctrlKey: true, shiftKey: true, key: 'ArrowUp', code: 'ArrowUp', preventDefault: () => {}, stopPropagation: () => {} });
    assert.equal(localStorage.getItem('tc_watermark_opacity'), '0.18');
  });

  it('Ctrl+Shift+ArrowUp increases opacity by 0.02 off the default and persists it', () => {
    const factory = loadEasterEgg();
    const localStorage = fakeLocalStorage();
    const document = fakeDocument();
    const egg = factory({ localStorage, document });
    let prevented = false;
    egg.handleWatermarkKeydown({ ctrlKey: true, shiftKey: true, key: 'ArrowUp', code: 'ArrowUp', preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
    assert.equal(prevented, true);
    assert.equal(localStorage.getItem('tc_watermark_opacity'), '0.18');
  });

  it('Ctrl+Shift+ArrowDown decreases opacity by 0.02, clamped at 0', () => {
    const factory = loadEasterEgg();
    const localStorage = fakeLocalStorage();
    const document = fakeDocument();
    const egg = factory({ localStorage, document });
    localStorage.setItem('tc_watermark_opacity', '0.01');
    egg.handleWatermarkKeydown({ ctrlKey: true, shiftKey: true, key: 'ArrowDown', code: 'ArrowDown', preventDefault: () => {}, stopPropagation: () => {} });
    assert.equal(localStorage.getItem('tc_watermark_opacity'), '0');
  });

  it('Ctrl+Shift+0 resets by clearing the stored override', () => {
    const factory = loadEasterEgg();
    const localStorage = fakeLocalStorage();
    const document = fakeDocument();
    const egg = factory({ localStorage, document });
    localStorage.setItem('tc_watermark_opacity', '0.4');
    egg.handleWatermarkKeydown({ ctrlKey: true, shiftKey: true, key: '0', code: 'Digit0', preventDefault: () => {}, stopPropagation: () => {} });
    assert.equal(localStorage.getItem('tc_watermark_opacity'), null);
  });

  it('ignores a plain (unmodified) key -- never swallows ordinary terminal input', () => {
    const factory = loadEasterEgg();
    const localStorage = fakeLocalStorage();
    const document = fakeDocument();
    const egg = factory({ localStorage, document });
    let prevented = false;
    egg.handleWatermarkKeydown({ ctrlKey: false, shiftKey: false, key: 'ArrowUp', code: 'ArrowUp', preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
    assert.equal(prevented, false);
    assert.equal(localStorage.getItem('tc_watermark_opacity'), null);
  });
});
