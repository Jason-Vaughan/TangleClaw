'use strict';

/*
 * The subtle TangleClaw background watermark (#2930): a non-interactive
 * `<img>` overlay behind the terminal viewport (`.tc-session-watermark`,
 * `public/session.html` + `public/openclaw-view.html`) and behind the
 * dashboard's project cards/drawers (`.tc-bg-watermark`, `public/index.html`).
 * This repo is zero-dependency (no jsdom), so the markup and CSS are
 * asserted directly against the static file text, the same pattern
 * `test/wrap-indicator-card.test.js` and friends use for `public/*.html`
 * and `public/*.css`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

describe('#2930 watermark CSS never intercepts input', () => {
  it('session.css: .tc-session-watermark is pointer-events: none and dim', () => {
    const css = readPublic('session.css');
    const block = css.match(/\.tc-session-watermark\s*\{([\s\S]*?)\}/);
    assert.ok(block, 'session.css is missing .tc-session-watermark');
    assert.match(block[1], /pointer-events:\s*none/);
    const imgBlock = css.match(/\.tc-session-watermark img\s*\{([\s\S]*?)\}/);
    assert.ok(imgBlock, 'session.css is missing .tc-session-watermark img');
    assert.match(imgBlock[1], /opacity:\s*0\.055/);
    const lightBlock = css.match(
      /html\[data-theme="light"\]\s*\.tc-session-watermark img\s*\{([\s\S]*?)\}/
    );
    assert.ok(lightBlock, 'session.css is missing the light-theme opacity override');
    assert.match(lightBlock[1], /opacity:\s*0\.07/);
  });

  it('style.css: .tc-bg-watermark is pointer-events: none and dim', () => {
    const css = readPublic('style.css');
    const block = css.match(/\.tc-bg-watermark\s*\{([\s\S]*?)\}/);
    assert.ok(block, 'style.css is missing .tc-bg-watermark');
    assert.match(block[1], /pointer-events:\s*none/);
    assert.match(block[1], /z-index:\s*0/);
    const imgBlock = css.match(/\.tc-bg-watermark img\s*\{([\s\S]*?)\}/);
    assert.ok(imgBlock, 'style.css is missing .tc-bg-watermark img');
    assert.match(imgBlock[1], /opacity:\s*0\.06/);
  });
});

describe('#2930 cache bust', () => {
  it('sw.js bumps CACHE_NAME so open sessions pick up the watermark on reload', () => {
    const sw = readPublic('sw.js');
    const match = sw.match(/const CACHE_NAME = 'tangleclaw-v3-(\d+)';/);
    assert.ok(match, 'sw.js is missing the expected CACHE_NAME literal');
    assert.ok(Number(match[1]) >= 76, `CACHE_NAME must be bumped past v3-75, got v3-${match[1]}`);
  });
});
