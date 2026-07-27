'use strict';

/**
 * Extract a single release's notes from a Keep a Changelog file.
 *
 * The release automation turns a version bump landing on `main` into a tagged
 * GitHub Release, and the Release body is the CHANGELOG section for that
 * version. Both halves of the update path (`lib/update-checker.js`,
 * `lib/update-applier.js`) treat the newest origin tag as their only input, so
 * the tag is what delivers a release — these notes are what make the release
 * page readable once an operator follows the update pill to it.
 *
 * Returning `null` rather than an empty string for a missing or empty section is
 * deliberate: the caller fails the release loudly instead of publishing a release
 * with a blank body. A silently empty release is the same "assumed the step
 * happened" failure that let five releases ship untagged.
 */

// A level-2 heading that opens a release section, in either convention the wrap
// emits: `## [1.2.3] - 2026-01-01` or the bare `## 1.2.3 - 2026-01-01`.
// `lib/wrap-steps/version-bump.js` picks the style per the file's existing
// convention rather than imposing one, so both must be readable here.
const RELEASE_HEADING_RE = /^##\s+(?:\[([^\]]+)\]|(\d+\.\d+\.\d+[^\s]*))/;

// Any level-2 heading terminates a section, including `## [Unreleased]` and
// non-release headings a hand-maintained file might carry.
const ANY_H2_RE = /^##\s+/;

/**
 * Normalize a version for comparison: strip a leading `v` and surrounding space.
 * @param {string} version
 * @returns {string}
 */
function _normalize(version) {
  return String(version).trim().replace(/^v/, '');
}

/**
 * Extract the body of the section for `version` from a changelog.
 *
 * Matching is exact against the heading's version token, so `4.3.1` does not
 * match a `4.3.10` heading. `Unreleased` never matches — it is not a release,
 * and releasing its contents under a version number would publish notes for
 * work that has not shipped.
 *
 * @param {string} changelogText - Full contents of CHANGELOG.md
 * @param {string} version - Version to extract, with or without a leading `v`
 * @returns {string|null} The section body with the heading removed and outer
 *   blank lines trimmed, or `null` if there is no such section or it is empty.
 */
function extractReleaseNotes(changelogText, version) {
  if (!changelogText || typeof changelogText !== 'string') return null;
  if (!version || typeof version !== 'string') return null;

  const wanted = _normalize(version);
  if (!wanted || wanted.toLowerCase() === 'unreleased') return null;

  const lines = changelogText.split('\n');
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(RELEASE_HEADING_RE);
    if (!match) continue;
    const token = _normalize(match[1] || match[2] || '');
    if (token.toLowerCase() === 'unreleased') continue;
    if (token === wanted) {
      start = i + 1;
      break;
    }
  }

  if (start === -1) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (ANY_H2_RE.test(lines[i])) {
      end = i;
      break;
    }
  }

  const body = lines.slice(start, end).join('\n').trim();
  return body.length > 0 ? body : null;
}

module.exports = { extractReleaseNotes };

// CLI shim so the release workflow can call this directly:
//   node lib/changelog-notes.js 4.32.1 > notes.md
// Exits non-zero with a diagnostic when there is nothing to publish, which is
// what stops the workflow before it creates an empty release.
if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');

  const requested = process.argv[2];
  if (!requested) {
    process.stderr.write('usage: node lib/changelog-notes.js <version> [changelog-path]\n');
    process.exit(2);
  }

  const changelogPath = process.argv[3] || path.resolve(__dirname, '..', 'CHANGELOG.md');
  let text;
  try {
    text = fs.readFileSync(changelogPath, 'utf8');
  } catch (err) {
    process.stderr.write(`cannot read changelog at ${changelogPath}: ${err.message}\n`);
    process.exit(2);
  }

  const notes = extractReleaseNotes(text, requested);
  if (!notes) {
    process.stderr.write(
      `No CHANGELOG section found for version ${requested} in ${changelogPath}.\n` +
      'The version was bumped without promoting the [Unreleased] section, so there\n' +
      'are no release notes to publish. Add the section and re-run.\n'
    );
    process.exit(1);
  }

  process.stdout.write(`${notes}\n`);
}
