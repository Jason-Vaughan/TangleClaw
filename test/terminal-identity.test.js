'use strict';

// #1573 (Architect Ruling A1573): deterministic per-project visual
// identity derivation for terminal views. Also covers #1265 (Ruling
// A1265)'s own requirement to "verify programmatic luminance contrast
// ratios (>= 4.5) in unit tests across all six remediated token pairs" in
// public/style.css -- co-located here per that ruling's own test envelope,
// reusing this module's own relativeLuminance/contrastRatio rather than a
// third copy of the same WCAG math test/theme-contrast.test.js already has.
//
// lib/terminal-identity.js is a pure library: no store, no route, no DOM.
// Every assertion here drives the real exported function.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ti = require('../lib/terminal-identity');

describe('terminal-identity: exported vocabulary', () => {
  it('exposes its own pattern-class vocabulary', () => {
    assert.deepEqual(ti.PATTERN_CLASSES, ['dots', 'stripes', 'grid', 'waves', 'none']);
  });
});

describe('terminal-identity: relativeLuminance / contrastRatio', () => {
  it('computes relative luminance at the WCAG extremes', () => {
    assert.equal(ti.relativeLuminance('#000000'), 0);
    assert.equal(ti.relativeLuminance('#FFFFFF'), 1);
  });

  it('expands a 3-digit hex the same way as its 6-digit equivalent', () => {
    assert.equal(ti.relativeLuminance('#fff'), ti.relativeLuminance('#ffffff'));
  });

  it('computes the ratios WCAG defines', () => {
    assert.equal(ti.contrastRatio('#000000', '#FFFFFF').toFixed(2), '21.00');
    assert.equal(ti.contrastRatio('#FFFFFF', '#FFFFFF').toFixed(2), '1.00');
  });

  it('is symmetric regardless of argument order', () => {
    assert.equal(ti.contrastRatio('#112233', '#FFFFFF'), ti.contrastRatio('#FFFFFF', '#112233'));
  });
});

describe('terminal-identity: deriveProjectIdentity (#1573)', () => {
  it('refuses a missing projectId', () => {
    assert.equal(ti.deriveProjectIdentity({}).code, 'TERMINAL_IDENTITY_INVALID');
  });

  it('refuses a malformed overrideColor', () => {
    const r = ti.deriveProjectIdentity({ projectId: 'p1', overrideColor: 'not-a-hex' });
    assert.equal(r.code, 'TERMINAL_IDENTITY_INVALID');
  });

  it('refuses an empty overrideIcon', () => {
    const r = ti.deriveProjectIdentity({ projectId: 'p1', overrideIcon: '' });
    assert.equal(r.code, 'TERMINAL_IDENTITY_INVALID');
  });

  it('is deterministic: the same projectId always derives the same identity', () => {
    const a = ti.deriveProjectIdentity({ projectId: 'proj-alpha' });
    const b = ti.deriveProjectIdentity({ projectId: 'proj-alpha' });
    assert.deepEqual(a.identity, b.identity);
  });

  it('keys off projectId, never projectName -- a rename does not change the identity', () => {
    const original = ti.deriveProjectIdentity({ projectId: 'proj-alpha', projectName: 'Alpha' });
    const renamed = ti.deriveProjectIdentity({ projectId: 'proj-alpha', projectName: 'Renamed Alpha' });
    assert.equal(original.identity.accentHex, renamed.identity.accentHex);
    assert.equal(original.identity.borderHex, renamed.identity.borderHex);
  });

  it('two different projectIds derive visually distinct accents', () => {
    const a = ti.deriveProjectIdentity({ projectId: 'proj-alpha' });
    const b = ti.deriveProjectIdentity({ projectId: 'proj-beta' });
    assert.notEqual(a.identity.accentHex, b.identity.accentHex);
  });

  it('derives sigil from the first character of projectName, uppercased', () => {
    const r = ti.deriveProjectIdentity({ projectId: 'p1', projectName: 'alpha project' });
    assert.equal(r.identity.sigil, 'A');
  });

  it('falls back to projectId for the sigil when projectName is absent', () => {
    const r = ti.deriveProjectIdentity({ projectId: 'zulu' });
    assert.equal(r.identity.sigil, 'Z');
  });

  it('an explicit overrideColor replaces the derived accent/border/badge background outright', () => {
    const r = ti.deriveProjectIdentity({ projectId: 'p1', overrideColor: '#112233' });
    assert.equal(r.identity.accentHex, '#112233');
    assert.equal(r.identity.borderHex, '#112233');
    assert.equal(r.identity.badgeBgHex, '#112233');
  });

  it('an explicit overrideIcon replaces the derived sigil outright', () => {
    const r = ti.deriveProjectIdentity({ projectId: 'p1', projectName: 'alpha', overrideIcon: 'Z' });
    assert.equal(r.identity.sigil, 'Z');
  });

  it('cssVars carries every chrome value under a stable key name', () => {
    const r = ti.deriveProjectIdentity({ projectId: 'p1' });
    assert.deepEqual(Object.keys(r.identity.cssVars).sort(), [
      '--project-identity-accent', '--project-identity-badge-bg', '--project-identity-badge-text', '--project-identity-border'
    ]);
  });

  it('badge text always clears 4.5:1 against the badge background, across many projectIds (#1573\'s own guarantee)', () => {
    let worst = Infinity;
    for (let i = 0; i < 500; i++) {
      const r = ti.deriveProjectIdentity({ projectId: `project-${i}` });
      const ratio = ti.contrastRatio(r.identity.badgeBgHex, r.identity.badgeTextHex);
      if (ratio < worst) worst = ratio;
    }
    assert.ok(worst >= 4.5, `worst observed badge contrast was ${worst}`);
  });

  it('badge text still clears 4.5:1 for an explicit overrideColor, whatever it is', () => {
    for (const color of ['#000000', '#FFFFFF', '#7f7f7f', '#8f3230', '#ffb300']) {
      const r = ti.deriveProjectIdentity({ projectId: 'p1', overrideColor: color });
      const ratio = ti.contrastRatio(r.identity.badgeBgHex, r.identity.badgeTextHex);
      assert.ok(ratio >= 4.5, `overrideColor ${color}: badge contrast was only ${ratio}`);
    }
  });

  it('patternClass is always one of PATTERN_CLASSES', () => {
    for (let i = 0; i < 50; i++) {
      const r = ti.deriveProjectIdentity({ projectId: `project-${i}` });
      assert.ok(ti.PATTERN_CLASSES.includes(r.identity.patternClass));
    }
  });
});

describe('style.css: #1265 remediation verifies at >= 4.5:1 (Ruling A1265)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  /**
   * The custom properties a theme block declares, as `{ token: '#rrggbb' }`.
   * @param {string} selector - The theme block's selector.
   * @returns {Record<string, string>}
   */
  function themeTokens(selector) {
    const start = src.indexOf(`${selector} {`);
    if (start < 0) return {};
    const block = src.slice(start, src.indexOf('\n}', start));
    const out = {};
    for (const m of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*[;}]/g)) {
      out[m[1]] = m[2];
    }
    return out;
  }

  const root = themeTokens(':root');
  const light = { ...root, ...themeTokens('[data-theme="light"]') };

  it('the remediation is actually present -- :root --text-muted is no longer the pre-#1265 literal', () => {
    assert.notEqual(root['--text-muted'], '#777');
  });

  it(':root --text-muted on --card-bg clears 4.5:1', () => {
    assert.ok(ti.contrastRatio(root['--text-muted'], root['--card-bg']) >= 4.5);
  });

  it(':root --text-muted on --elevated-bg clears 4.5:1', () => {
    assert.ok(ti.contrastRatio(root['--text-muted'], root['--elevated-bg']) >= 4.5);
  });

  it('light --text-muted on --elevated-bg clears 4.5:1', () => {
    assert.ok(ti.contrastRatio(light['--text-muted'], light['--elevated-bg']) >= 4.5);
  });

  it('light --danger on --bg clears 4.5:1', () => {
    assert.ok(ti.contrastRatio(light['--danger'], light['--bg']) >= 4.5);
  });

  it('light --danger on --card-bg clears 4.5:1', () => {
    assert.ok(ti.contrastRatio(light['--danger'], light['--card-bg']) >= 4.5);
  });

  it('light --danger on --elevated-bg clears 4.5:1', () => {
    assert.ok(ti.contrastRatio(light['--danger'], light['--elevated-bg']) >= 4.5);
  });
});

describe('style.css: #1573 terminal identity CSS styling (Ruling A1573)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  it('consumes every --project-identity-* variable deriveProjectIdentity emits, somewhere across the identity selectors', () => {
    const identityBlock = src.slice(src.indexOf('.terminal-identity-badge {'), src.indexOf('/* ── OpenClaw Connections Panel'));
    for (const cssVar of Object.keys(ti.deriveProjectIdentity({ projectId: 'p1' }).identity.cssVars)) {
      assert.ok(identityBlock.includes(`var(${cssVar}`), `no identity selector references ${cssVar}`);
    }
  });

  it('declares a chrome selector consuming --project-identity-accent', () => {
    const chromeBlock = src.slice(src.indexOf('.terminal-identity-chrome {'), src.indexOf('.terminal-identity-sigil'));
    assert.ok(chromeBlock.includes('var(--project-identity-accent'));
  });

  it('declares one pattern-class selector for every PATTERN_CLASSES entry', () => {
    for (const patternClass of ti.PATTERN_CLASSES) {
      assert.ok(src.includes(`.terminal-identity-pattern-${patternClass}`), `no selector for pattern class "${patternClass}"`);
    }
  });

  it('every non-"none" pattern selector is a background-image/opacity layer, never a text-affecting property', () => {
    for (const patternClass of ti.PATTERN_CLASSES.filter((p) => p !== 'none')) {
      const start = src.indexOf(`.terminal-identity-pattern-${patternClass} {`);
      const block = src.slice(start, src.indexOf('}', start));
      assert.match(block, /background-image:/, `${patternClass} has no background-image`);
      assert.ok(!/\bcolor\s*:/.test(block), `${patternClass} must not set text color -- terminal text stays fully opaque`);
    }
  });
});
