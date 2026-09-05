'use strict';

/*
 * A colour the operator cannot read carries nothing.
 *
 * `nonfunctional-requirements.md` § Direction binds 4.5:1 for body text, and
 * nothing enforced it — so `var(--warning, #ffb300)` was spelled at five sites
 * with `--warning` declared in neither stylesheet, meaning every one of them
 * took the literal amber, which is 1.8:1 on the Light theme's white card. The
 * sentence that says half a setting does not work here (#1252) was the fifth.
 *
 * Scoped deliberately to the tokens a theme declares, not to every rule in the
 * sheets: a real audit of arbitrary selectors needs the cascade, and a guard
 * that pretends to do it while reading text would be worse than none. What is
 * checkable without a browser is that a semantic colour token clears the floor
 * against the surfaces its own theme defines — which is the whole of this
 * defect, root cause included.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
// Both sheets, because the token is spelled in both and a theme fixed in one
// leaves the other's readers below the floor — the dashboard and the session
// page are the same product to the operator.
const SHEETS = ['style.css', 'session.css'];
// The blocks that define a palette. `:root` is the dark default.
const THEMES = [':root', '[data-theme="light"]', '[data-theme="high-contrast"]'];
// Every background a token's text can land on within a theme.
const SURFACES = ['--bg', '--card-bg', '--elevated-bg'];
// Semantic text tokens that must be readable wherever they are used. Not the
// surfaces themselves, and not decorative accents that never carry text.
const TEXT_TOKENS = ['--warning', '--danger', '--text', '--text-muted'];
const FLOOR = 4.5;

/*
 * Pairs known to sit below the floor, each pinned to the ratio it measures
 * TODAY rather than merely excused.
 *
 * Both are in the v2 palette, which `public/style.css` marks "do not change" —
 * changing what `--danger` looks like product-wide is the operator's call, not
 * a side effect of the chunk that added a caveat line. Filed rather than fixed
 * or silently dropped from `TEXT_TOKENS`: narrowing the guard to the token this
 * bundle happened to touch would leave the sheet claiming a floor it does not
 * meet.
 *
 * Pinned to the exact ratio so the waiver cannot absorb a REGRESSION: making
 * either pair worse fails here, and making it pass means deleting its entry.
 */
const KNOWN_BELOW_FLOOR = [
  { theme: ':root', token: '--text-muted', surface: '--card-bg', ratio: 4.34 },
  { theme: ':root', token: '--text-muted', surface: '--elevated-bg', ratio: 3.89 },
  { theme: '[data-theme="light"]', token: '--text-muted', surface: '--elevated-bg', ratio: 4.35 },
  { theme: '[data-theme="light"]', token: '--danger', surface: '--bg', ratio: 3.20 },
  { theme: '[data-theme="light"]', token: '--danger', surface: '--card-bg', ratio: 3.49 },
  { theme: '[data-theme="light"]', token: '--danger', surface: '--elevated-bg', ratio: 2.64 }
];

/**
 * The custom properties a theme block declares, as `{ token: '#rrggbb' }`.
 *
 * A block, not the file: the same token is declared once per theme and the
 * whole point is to compare each theme's value against that theme's surfaces.
 *
 * @param {string} src - Stylesheet source.
 * @param {string} selector - The theme block's selector.
 * @returns {Record<string, string>}
 */
function themeTokens(src, selector) {
  const start = src.indexOf(`${selector} {`);
  if (start < 0) return {};
  const block = src.slice(start, src.indexOf('\n}', start));
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*[;}]/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * WCAG relative luminance of an `#rgb` or `#rrggbb` colour.
 * @param {string} hex - Colour.
 * @returns {number}
 */
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const channels = (h.match(/../g) || []).map((pair) => {
    const v = parseInt(pair, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * WCAG contrast ratio between two colours.
 * @param {string} a - Colour.
 * @param {string} b - Colour.
 * @returns {number}
 */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('a semantic colour token is readable on its own theme\'s surfaces', () => {
  it('computes the ratios WCAG defines', () => {
    // The arithmetic itself, against values with published ratios — without
    // this the whole file could be reporting 21:1 for everything and pass.
    assert.equal(contrast('#000000', '#FFFFFF').toFixed(2), '21.00');
    assert.equal(contrast('#FFFFFF', '#FFFFFF').toFixed(2), '1.00');
    assert.ok(contrast('#ffb300', '#FFFFFF') < 2,
      'the literal this defect shipped must still measure as unreadable on white');
  });

  for (const sheet of SHEETS) {
    const src = fs.readFileSync(path.join(PUB, sheet), 'utf8');

    describe(sheet, () => {
      it('declares every semantic text token in the default palette', () => {
        // The root cause, not the symptom: `--warning` was spelled at five
        // sites and declared nowhere, so every reader silently took its
        // fallback literal and no theme could correct it.
        const root = themeTokens(src, ':root');
        assert.ok(Object.keys(root).length > 0, `${sheet} has no :root palette — nothing parsed`);
        for (const token of TEXT_TOKENS) {
          assert.ok(root[token], `${token} is used by this sheet but declared in no palette`);
        }
      });

      for (const theme of THEMES) {
        it(`keeps them above ${FLOOR}:1 in ${theme}`, () => {
          const base = themeTokens(src, ':root');
          const tokens = { ...base, ...themeTokens(src, theme) };
          assert.ok(Object.keys(tokens).length > 0, `${theme} did not parse`);
          for (const token of TEXT_TOKENS) {
            for (const surface of SURFACES) {
              if (!tokens[token] || !tokens[surface]) continue;
              const ratio = contrast(tokens[token], tokens[surface]);
              const known = KNOWN_BELOW_FLOOR.find((k) =>
                k.theme === theme && k.token === token && k.surface === surface);
              if (known) {
                assert.equal(ratio.toFixed(2), known.ratio.toFixed(2),
                  `${sheet} ${theme}: ${token} on ${surface} is recorded below the floor at `
                  + `${known.ratio}:1 and now measures ${ratio.toFixed(2)}:1 — if this is the fix, `
                  + 'delete its entry; if it is a regression, it is one the palette cannot absorb');
                continue;
              }
              assert.ok(ratio >= FLOOR,
                `${sheet} ${theme}: ${token} (${tokens[token]}) on ${surface} `
                + `(${tokens[surface]}) is ${ratio.toFixed(2)}:1, below the ${FLOOR}:1 floor`);
            }
          }
        });
      }
    });
  }
});
