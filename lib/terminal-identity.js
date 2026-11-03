'use strict';

/**
 * Deterministic per-project visual identity for terminal views (#1573,
 * Architect Ruling A1573, `v5.60.0` Car 60-D Slice 1).
 *
 * A pure derivation library: {@link deriveProjectIdentity} takes a
 * project's own id/name (plus optional explicit overrides) as plain data
 * and returns a computed identity profile -- nothing here touches the
 * filesystem, a project's stored config, or `public/app.js`'s DOM. Wiring
 * this into the real Project Settings controls (background/logo/size/
 * opacity/position) and live preview is Slice 2, deliberately deferred so
 * Car 60-D stays 100% file-disjoint from this wave's other `v5.60.0` cars
 * -- #1573's own issue describes that full control surface, while this
 * ruling scopes Slice 1 to the deterministic profile those controls will
 * read and write.
 *
 * {@link relativeLuminance} and {@link contrastRatio} also back #1265's
 * remediation of `public/style.css` (reused rather than a third copy of
 * the same WCAG math `test/theme-contrast.test.js` already has its own).
 *
 * @module lib/terminal-identity
 */

/** The small, fixed set of decorative background patterns a profile may pick. */
const PATTERN_CLASSES = Object.freeze(['dots', 'stripes', 'grid', 'waves', 'none']);

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * WCAG relative luminance of a `#rgb`/`#rrggbb` colour.
 * @param {string} hex
 * @returns {number}
 */
function relativeLuminance(hex) {
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
 * @param {string} hexA
 * @param {string} hexB
 * @returns {number}
 */
function contrastRatio(hexA, hexB) {
  const [hi, lo] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A stable, deterministic 32-bit hash of a string (FNV-1a) -- the same
 * `projectId` always derives the same identity, across sessions, restarts
 * and engines.
 * @param {string} s
 * @returns {number}
 */
function _hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * HSL to `#rrggbb`.
 * @param {number} h - `0`-`360`
 * @param {number} s - `0`-`1`
 * @param {number} l - `0`-`1`
 * @returns {string}
 */
function _hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toByte = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/**
 * Pick whichever of pure black/white clears {@link module:lib/terminal-identity}'s
 * `4.5:1` floor against `bgHex` -- guaranteed to succeed for ANY `bgHex`,
 * since a background's luminance is always either low enough for white
 * text or high enough for black text to clear the floor (the two ranges
 * overlap; this picks white first when both qualify, favoring the WCAG
 * convention of light text on a mid-range chip).
 * @param {string} bgHex
 * @returns {string} `#FFFFFF` or `#000000`
 */
function _readableTextOn(bgHex) {
  return contrastRatio('#FFFFFF', bgHex) >= 4.5 ? '#FFFFFF' : '#000000';
}

/**
 * Derive a deterministic per-project visual identity profile (#1573) from
 * `projectId` (the stable key -- never `projectName`, which can be
 * renamed), with optional explicit overrides for the project's own chosen
 * color/icon. Guarantees `>= 4.5:1` badge text contrast by construction
 * (see {@link _readableTextOn}) and distinct visual chrome across
 * projects (the hash varies the hue continuously across the whole wheel).
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} [input.projectName] - For the derived `sigil` only
 * @param {string} [input.overrideColor] - `#rrggbb`; replaces the
 *   hash-derived accent/badge background outright when given
 * @param {string} [input.overrideIcon] - Replaces the derived `sigil` outright
 * @returns {{ok: true, identity: {accentHex: string, borderHex: string,
 *   badgeBgHex: string, badgeTextHex: string, sigil: string,
 *   patternClass: string, cssVars: Record<string, string>}}
 *   |{ok: false, code: string, message: string}}
 */
function deriveProjectIdentity(input) {
  if (!input || typeof input !== 'object' || typeof input.projectId !== 'string' || !input.projectId) {
    return _refuse('TERMINAL_IDENTITY_INVALID', 'input.projectId is required.');
  }
  if (input.overrideColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(input.overrideColor)) {
    return _refuse('TERMINAL_IDENTITY_INVALID', 'input.overrideColor must be a #rrggbb hex string.');
  }
  if (input.overrideIcon !== undefined && (typeof input.overrideIcon !== 'string' || !input.overrideIcon)) {
    return _refuse('TERMINAL_IDENTITY_INVALID', 'input.overrideIcon must be a non-empty string.');
  }

  const hash = _hash(input.projectId);
  const hue = hash % 360;

  const accentHex = input.overrideColor || _hslToHex(hue, 0.55, 0.55);
  const borderHex = input.overrideColor ? input.overrideColor : _hslToHex(hue, 0.55, 0.35);
  const badgeBgHex = accentHex;
  const badgeTextHex = _readableTextOn(badgeBgHex);

  const name = typeof input.projectName === 'string' && input.projectName ? input.projectName : input.projectId;
  const sigil = input.overrideIcon || name.trim().charAt(0).toUpperCase() || '?';

  const patternClass = PATTERN_CLASSES[Math.floor((hash / 360) % PATTERN_CLASSES.length)];

  return {
    ok: true,
    identity: {
      accentHex, borderHex, badgeBgHex, badgeTextHex, sigil, patternClass,
      cssVars: {
        '--project-identity-accent': accentHex,
        '--project-identity-border': borderHex,
        '--project-identity-badge-bg': badgeBgHex,
        '--project-identity-badge-text': badgeTextHex
      }
    }
  };
}

module.exports = {
  PATTERN_CLASSES,
  relativeLuminance,
  contrastRatio,
  deriveProjectIdentity
};
