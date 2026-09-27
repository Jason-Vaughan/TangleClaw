'use strict';

/*
 * #1948 — the release workflow refuses release notes over 120,000 UTF-8 bytes
 * (scripts/release-notes-gate.js, #1947). It never truncates, so an oversized
 * [Unreleased] section fails the release at bump time, after everything in it
 * has merged. This is the early warning: it fails at merge time, while there is
 * still room to condense, well before the release gate would refuse.
 *
 * What is measured is what becomes the release notes: the [Unreleased] body,
 * which the version bump promotes under a version heading unchanged.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** The release gate's ceiling, in UTF-8 bytes (scripts/release-notes-gate.js). */
const RELEASE_NOTES_CEILING = 120000;

/** Where this test starts failing: early enough to leave room for the entries still in flight. */
const EARLY_WARNING_BYTES = 110000;

/**
 * The body of the [Unreleased] section: everything after its heading up to the
 * next level-2 heading.
 *
 * @param {string} text - CHANGELOG.md contents.
 * @returns {string|null} The body, or null when there is no [Unreleased] heading.
 */
function unreleasedBody(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## \[Unreleased\]/.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('CHANGELOG [Unreleased] size (#1948)', () => {
  it('stays under the early-warning line, well below the release-notes ceiling', () => {
    const body = unreleasedBody(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'));
    assert.notEqual(body, null, 'CHANGELOG.md must have an [Unreleased] section');
    const bytes = Buffer.byteLength(body, 'utf8');
    assert.ok(bytes <= EARLY_WARNING_BYTES,
      `[Unreleased] is ${bytes} UTF-8 bytes, over the ${EARLY_WARNING_BYTES}-byte early warning. `
      + `The release refuses notes over ${RELEASE_NOTES_CEILING} bytes and never truncates them. `
      + 'Condense entries (keep every item, its headline and its references; cut implementation narration), '
      + 'as #1948 did.');
  });

  it('measures the section body only, in UTF-8 bytes', () => {
    const sample = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- **é**\n\n## [1.0.0] - 2026-01-01\n\n- old\n';
    assert.equal(unreleasedBody(sample), '\n### Added\n\n- **é**\n');
    assert.equal(Buffer.byteLength(unreleasedBody(sample), 'utf8'), 21, 'é is two bytes, so 20 characters are 21 bytes');
    assert.equal(unreleasedBody('# Changelog\n'), null);
  });
});
