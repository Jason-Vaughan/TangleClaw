'use strict';

/*
 * #1570 — the terminal's prompt line stays visible above the soft keyboard.
 *
 * On iOS Safari the keyboard shrinks only the VISUAL viewport: the layout
 * viewport (and so `100dvh`, the session page's body height) stays put under
 * the keyboard, and the terminal's bottom rows — the prompt — are covered.
 * Chrome on Android does the same by default since 108, and honours
 * `interactive-widget=resizes-content` to shrink the layout viewport too;
 * no shipped Safari reads that key yet (WebKit merged it 2026-08). So both
 * pages carry the meta for Android, and a `visualViewport` listener publishes
 * the visible height and offset for iOS. Only while the keyboard is up does
 * the root carry `data-tc-keyboard`, and only then does any CSS read the
 * vars — a page with no keyboard is the old layout byte for byte. ttyd refits
 * xterm on its window's resize, so a shorter iframe re-rows the terminal and
 * the prompt moves up with the bottom edge. No timers: the layout follows the
 * viewport's own events.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../public/api-helper.js');
const { tcVisualViewportVars, tcWireVisualViewport } = globalThis;

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

describe('tcVisualViewportVars (pure): is the keyboard up, and how tall is what is left', () => {
  it('a visual viewport at least 100px shorter than the window means the keyboard is up', () => {
    assert.deepEqual(tcVisualViewportVars({ height: 420.4, offsetTop: 0 }, 844), { height: 420, top: 0 });
    assert.deepEqual(tcVisualViewportVars({ height: 500, offsetTop: 120.6 }, 844), { height: 500, top: 121 });
    assert.deepEqual(tcVisualViewportVars({ height: 744, offsetTop: 0 }, 844), { height: 744, top: 0 });
  });

  it('a smaller difference (the collapsing toolbar, a rounding wobble) is not a keyboard', () => {
    assert.equal(tcVisualViewportVars({ height: 800, offsetTop: 0 }, 844), null);
    assert.equal(tcVisualViewportVars({ height: 745, offsetTop: 0 }, 844), null);
    assert.equal(tcVisualViewportVars({ height: 844, offsetTop: 0 }, 844), null);
  });

  it('an orientation change is read against the new window height', () => {
    assert.equal(tcVisualViewportVars({ height: 390, offsetTop: 0 }, 390), null);
    assert.deepEqual(tcVisualViewportVars({ height: 180, offsetTop: 0 }, 390), { height: 180, top: 0 });
  });

  it('pinch-zoom shrinks the visual viewport too, and is not a keyboard: the comparison is made at layout scale', () => {
    // Zoomed 2x on an 844px window: the visual viewport reports 422 CSS px.
    assert.equal(tcVisualViewportVars({ height: 422, offsetTop: 0, scale: 2 }, 844), null);
    assert.equal(tcVisualViewportVars({ height: 700, offsetTop: 0, scale: 1.2 }, 844), null);
    // Zoomed 2x AND the keyboard up: 844 - 2*300 = 244 short, so keyboard.
    assert.deepEqual(tcVisualViewportVars({ height: 300, offsetTop: 40, scale: 2 }, 844), { height: 300, top: 40 });
    // No scale reported (older browsers) reads as 1.
    assert.deepEqual(tcVisualViewportVars({ height: 420, offsetTop: 0 }, 844), { height: 420, top: 0 });
    assert.deepEqual(tcVisualViewportVars({ height: 420, offsetTop: 0, scale: NaN }, 844), { height: 420, top: 0 });
  });

  it('no visual viewport, or nonsense numbers, means no keyboard', () => {
    assert.equal(tcVisualViewportVars(null, 844), null);
    assert.equal(tcVisualViewportVars({ height: NaN, offsetTop: 0 }, 844), null);
    assert.equal(tcVisualViewportVars({ height: 400, offsetTop: 0 }, NaN), null);
    assert.equal(tcVisualViewportVars({ height: 0, offsetTop: 0 }, 844), null);
  });
});

/**
 * A fake window with a visualViewport that records listeners.
 * @param {{height: number, offsetTop: number}|null} vv
 * @param {number} innerHeight
 * @returns {object}
 */
function makeWin(vv, innerHeight) {
  const win = { innerHeight, timeouts: 0, intervals: 0 };
  win.setTimeout = () => { win.timeouts += 1; return 1; };
  win.setInterval = () => { win.intervals += 1; return 1; };
  if (vv) {
    win.visualViewport = Object.assign({ listeners: {} }, vv, {
      addEventListener(type, cb) {
        (win.visualViewport.listeners[type] = win.visualViewport.listeners[type] || []).push(cb);
      }
    });
  }
  return win;
}

/**
 * A fake document whose root records style properties and attributes.
 * @returns {object}
 */
function makeDoc() {
  const props = {};
  const attrs = {};
  return {
    props,
    attrs,
    documentElement: {
      style: {
        setProperty(k, v) { props[k] = v; },
        removeProperty(k) { delete props[k]; }
      },
      setAttribute(k, v) { attrs[k] = v; },
      removeAttribute(k) { delete attrs[k]; }
    }
  };
}

describe('tcWireVisualViewport: publish the visible area while the keyboard is up', () => {
  it('returns false and touches nothing when the browser has no visualViewport', () => {
    const doc = makeDoc();
    assert.equal(tcWireVisualViewport(makeWin(null, 844), doc), false);
    assert.deepEqual(doc.props, {});
    assert.deepEqual(doc.attrs, {});
    assert.equal(tcWireVisualViewport(null, doc), false);
  });

  it('listens to resize and scroll, and reads the viewport once at wire time', () => {
    const win = makeWin({ height: 844, offsetTop: 0 }, 844);
    const doc = makeDoc();
    assert.equal(tcWireVisualViewport(win, doc), true);
    assert.equal(win.visualViewport.listeners.resize.length, 1);
    assert.equal(win.visualViewport.listeners.scroll.length, 1);
    assert.deepEqual(doc.attrs, {}, 'no keyboard at wire time');
  });

  it('keyboard opens: the root gains the attribute and both vars; closes: all three go', () => {
    const win = makeWin({ height: 844, offsetTop: 0 }, 844);
    const doc = makeDoc();
    tcWireVisualViewport(win, doc);
    win.visualViewport.height = 420;
    win.visualViewport.offsetTop = 60;
    win.visualViewport.listeners.resize[0]();
    assert.deepEqual(doc.attrs, { 'data-tc-keyboard': 'open' });
    assert.deepEqual(doc.props, { '--tc-visual-height': '420px', '--tc-visual-top': '60px' });
    win.visualViewport.offsetTop = 0;
    win.visualViewport.listeners.scroll[0]();
    assert.equal(doc.props['--tc-visual-top'], '0px', 'a scroll while open re-reads the offset');
    win.visualViewport.height = 844;
    win.visualViewport.listeners.resize[0]();
    assert.deepEqual(doc.attrs, {});
    assert.deepEqual(doc.props, {});
  });

  it('is idempotent per window and never starts a timer', () => {
    const win = makeWin({ height: 844, offsetTop: 0 }, 844);
    const doc = makeDoc();
    tcWireVisualViewport(win, doc);
    tcWireVisualViewport(win, doc);
    assert.equal(win.visualViewport.listeners.resize.length, 1);
    assert.equal(win.timeouts + win.intervals, 0);
  });
});

describe('#1570 the pages read what the listener publishes', () => {
  const sessionCss = stripCss(read('session.css'));
  const styleCss = stripCss(read('style.css'));
  const sessionHtml = read('session.html');
  const indexHtml = read('index.html');
  const sessionJs = read('session.js');
  const landingJs = read('landing.js');
  const helper = read('api-helper.js');

  /**
   * The declarations of the first rule for `selector` in `css`.
   * @param {string} css
   * @param {string} selector - Exact selector text as written
   * @returns {string|null}
   */
  function ruleBody(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    return m ? m[1] : null;
  }

  it('both pages gate the body change on the root attribute, sized and offset by the vars', () => {
    for (const [name, css] of [['session.css', sessionCss], ['style.css', styleCss]]) {
      const body = ruleBody(css, 'html[data-tc-keyboard] body');
      assert.ok(body, `${name}: html[data-tc-keyboard] body rule exists`);
      assert.match(body, /height: var\(--tc-visual-height\)/, name);
      assert.match(body, /transform: translateY\(var\(--tc-visual-top\)\)/, name);
      const plainBody = ruleBody(css, 'body');
      assert.doesNotMatch(plainBody, /transform/, `${name}: the ungated body must not carry a transform (it would become a containing block for every fixed element)`);
      assert.doesNotMatch(plainBody, /--tc-visual/, `${name}: the ungated body must not read the vars`);
    }
  });

  it('the Master frames size against the visible height, falling back to the layout viewport', () => {
    assert.match(ruleBody(styleCss, '.master-frame'), /height: calc\(var\(--tc-visual-height, 100dvh\) \* 0\.6\)/);
    assert.match(ruleBody(sessionCss, '.master-drawer-frame'), /height: calc\(var\(--tc-visual-height, 100dvh\) \* 0\.6\)/);
  });

  it('both shells ask Android to resize the layout viewport for the keyboard', () => {
    for (const [name, html] of [['session.html', sessionHtml], ['index.html', indexHtml]]) {
      const meta = /<meta name="viewport" content="([^"]*)">/.exec(html);
      assert.ok(meta, `${name}: viewport meta`);
      assert.match(meta[1], /interactive-widget=resizes-content/, name);
      assert.match(meta[1], /width=device-width/, `${name}: the rest of the meta is kept`);
      assert.match(meta[1], /viewport-fit=cover/, `${name}: the rest of the meta is kept`);
    }
  });

  it('both pages wire the listener at boot, through the shared helper', () => {
    assert.match(sessionJs, /window\.tcWireVisualViewport\(window, document\);/);
    assert.match(landingJs, /window\.tcWireVisualViewport\(window, document\);/);
    assert.match(helper, /global\.tcWireVisualViewport = tcWireVisualViewport;/);
    assert.match(helper, /global\.tcVisualViewportVars = tcVisualViewportVars;/);
  });

  it('the wiring body has no timer (the layout follows viewport events only)', () => {
    const start = helper.indexOf('function tcWireVisualViewport');
    const end = helper.indexOf('function tcWireTerminalFrame');
    assert.ok(start > -1 && end > start);
    assert.doesNotMatch(helper.slice(start, end), /setTimeout|setInterval|requestAnimationFrame/);
  });
});
