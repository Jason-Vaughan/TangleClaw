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
 * #1265 (Ruling A1265, Car 60-D) remediated all six of these pairs in
 * `public/style.css` -- `--text-muted` and the light theme's own `--danger`
 * override now clear the 4.5:1 floor there, so `style.css`'s entries were
 * deleted per this file's own "Expected" contract above. `#2862` (Ruling
 * A503-R1, Car 66-A) applies the identical remediation to `session.css`, so
 * its six entries are deleted here too -- both sheets now carry the same
 * remediated palette, with none below the floor.
 *
 * Pinned to the exact ratio so the waiver cannot absorb a REGRESSION: making
 * either pair worse fails here, and making it pass means deleting its entry.
 */
const KNOWN_BELOW_FLOOR = [];

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
              const known = KNOWN_BELOW_FLOOR.find((k) => k.sheet === sheet
                && k.theme === theme && k.token === token && k.surface === surface);
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

/*
 * #3133: the official TangleClaw Dark Brand Palette, declared once in
 * `style.css`'s `:root` for the v6 shell's own dark-locked surfaces
 * (scrollbars, Under the Hood, the Sprint & Cars board, Waiting-On) —
 * unlike the semantic tokens above, these are NOT re-themed per
 * `data-theme`, so they are checked separately, against their own
 * intended dark canvas rather than against THEMES/SURFACES: pairing a
 * near-white brand text token against the Light theme's own near-white
 * surfaces would fail for a reason that has nothing to do with this
 * palette, which never renders under that theme.
 */
describe('the TangleClaw Dark Brand Palette (#3133) is readable on its own canvas', () => {
  const BRAND_TEXT_TOKENS = ['--tc-fang-ivory', '--tc-muted-sage', '--tc-predator-gold', '--tc-predator-gold-alt'];
  const BRAND_SURFACES = ['--tc-obsidian-void', '--tc-panel-surface', '--tc-panel-surface-alt'];
  const src = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const tokens = themeTokens(src, ':root');

  it('declares every brand text token and canvas surface', () => {
    for (const token of [...BRAND_TEXT_TOKENS, ...BRAND_SURFACES]) {
      assert.ok(tokens[token], `${token} is expected in style.css's :root but was not declared`);
    }
  });

  for (const token of BRAND_TEXT_TOKENS) {
    for (const surface of BRAND_SURFACES) {
      it(`keeps ${token} above ${FLOOR}:1 on ${surface}`, () => {
        const ratio = contrast(tokens[token], tokens[surface]);
        assert.ok(ratio >= FLOOR,
          `${token} (${tokens[token]}) on ${surface} (${tokens[surface]}) `
          + `is ${ratio.toFixed(2)}:1, below the ${FLOOR}:1 floor`);
      });
    }
  }
});

/*
 * #3167: full-width chat wrapping and the busy-indicator CSS. Both new
 * colors used here (`--tc-venom-green`) are already brand text tokens
 * checked against their own canvas by the describe block above, so no new
 * token needs adding to TEXT_TOKENS/BRAND_TEXT_TOKENS — these assertions
 * only confirm the new rules exist with the properties this car's
 * acceptance criteria name, the same scope-limited style the other CSS
 * regression tests in this repo use (property presence, not a cascade
 * audit).
 */
describe('full-width chat wrapping and the busy-indicator CSS (#3167)', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');

  it('spans the conversation stream/event/content to the full center-pane width and wraps long tokens', () => {
    assert.match(css, /\.v6-conversation-stream,\s*\.v6-conversation-event,\s*\.v6-conversation-event\.is-assistant,\s*\.v6-conversation-content \{\s*width: 100%;\s*max-width: none;\s*box-sizing: border-box;\s*overflow-wrap: anywhere;\s*word-break: normal;\s*\}/);
  });

  it('gives #v6ChatActivity.is-busy a rotating spinner that respects reduced motion', () => {
    assert.match(css, /\.v6-chat-activity\.is-busy::before \{[^}]*content: '⟳';[^}]*animation: spin 1s linear infinite;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.v6-chat-activity\.is-busy::before \{ animation: none; \}/);
  });

  it('defines .v6-uth-status--busy as a pulsing badge for the Under the Hood summary bar, respecting reduced motion', () => {
    assert.match(css, /\.v6-uth-status--busy \{[^}]*display: inline-flex;/);
    assert.match(css, /\.v6-uth-status--busy::before \{[^}]*animation: v6-uth-status-pulse 1\.2s ease-in-out infinite;/);
    assert.match(css, /@keyframes v6-uth-status-pulse \{\s*0%, 100% \{ opacity: 1; transform: scale\(1\); \}\s*50% \{ opacity: 0\.4; transform: scale\(0\.7\); \}\s*\}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.v6-uth-status--busy::before \{ animation: none; \}/);
  });
});

/*
 * #3173: `.v6-shell-root`'s `align-items: start` let `.v6-shell-view` size to
 * its own content instead of the bounded `1fr` track, overflowing the root's
 * `overflow: hidden` and disabling the view's own `overflow-y: auto` — the
 * same property-presence style as the other CSS regression blocks in this
 * file (#3167 above), scoped to the properties this car's fix added rather
 * than a cascade/layout audit a browser check already covers.
 */
describe('v6 shell internal scroll and chat reachability (#3173)', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');

  it('stretches .v6-shell-view to the grid row it is bound to instead of sizing to its content', () => {
    assert.match(css, /\.v6-shell-view \{[^}]*align-self: stretch;[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow-y: auto;/s);
  });

  it('bounds the chat column, #v6ShellDetail and the chat view to the viewport as a fallback alongside their flex-column rule', () => {
    assert.match(css, /\.v6-shell-root--chat \.v6-shell-view,\s*#v6ShellDetail:not\(\[hidden\]\),\s*\.v6-chat \{\s*max-height: 100%;\s*overflow-y: auto;\s*\}/);
  });

  it('keeps the chat stream scrollable with iOS momentum scroll, without reintroducing its retired resize handle', () => {
    assert.match(css, /\.v6-chat-stream \{[^}]*overflow-y: auto;[^}]*-webkit-overflow-scrolling: touch;/s);
    assert.doesNotMatch(css, /\.v6-chat-stream \{[^}]*resize: vertical;/s);
  });

  it('caps Under the Hood\'s drag-resize so it cannot push the composer off-screen', () => {
    assert.match(css, /\.v6-chat-under-hood\[open\] \{[^}]*resize: vertical;[^}]*max-height: 45vh;/s);
  });

  it('caps the composer\'s drag-resize the same way, with its own scroll for taller content', () => {
    assert.match(css, /\.v6-chat-input \{[^}]*max-height: 30vh;[^}]*overflow-y: auto;[^}]*resize: vertical;/s);
  });
});
