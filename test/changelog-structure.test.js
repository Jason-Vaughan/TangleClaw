'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');
const VERSION_JSON_PATH = path.join(REPO_ROOT, 'version.json');

const RELEASE_HEADING_RE = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}\s*$/;
const UNRELEASED_HEADING_RE = /^## \[Unreleased\]\s*$/;
const BANNER_RE = /^> (🛟|🚀)/u;

function parseReleaseHeadings(text) {
  const headings = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(RELEASE_HEADING_RE);
    if (m) {
      headings.push({
        line: i + 1,
        version: [Number(m[1]), Number(m[2]), Number(m[3])],
        versionString: `${m[1]}.${m[2]}.${m[3]}`,
      });
    }
  });
  return headings;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function findOrphanBanners(text) {
  let currentSection = null;
  const orphans = [];
  text.split('\n').forEach((line, i) => {
    if (UNRELEASED_HEADING_RE.test(line)) {
      currentSection = 'unreleased';
      return;
    }
    if (RELEASE_HEADING_RE.test(line)) {
      currentSection = 'released';
      return;
    }
    if (BANNER_RE.test(line) && currentSection !== 'released') {
      orphans.push({ line: i + 1, raw: line });
    }
  });
  return orphans;
}

function findDuplicateHeadings(headings) {
  const seen = new Map();
  const dupes = [];
  for (const h of headings) {
    const prev = seen.get(h.versionString);
    if (prev) dupes.push({ versionString: h.versionString, lines: [prev.line, h.line] });
    else seen.set(h.versionString, h);
  }
  return dupes;
}

function findOutOfOrderPairs(headings) {
  const violations = [];
  for (let i = 1; i < headings.length; i += 1) {
    if (compareSemver(headings[i - 1].version, headings[i].version) <= 0) {
      violations.push({ prev: headings[i - 1], curr: headings[i] });
    }
  }
  return violations;
}

describe('CHANGELOG.md structural invariants (#168)', () => {
  const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const versionJson = JSON.parse(fs.readFileSync(VERSION_JSON_PATH, 'utf8'));
  const headings = parseReleaseHeadings(changelog);

  it('has at least one released-version heading', () => {
    assert.ok(headings.length > 0, 'CHANGELOG.md must contain at least one "## [X.Y.Z] - YYYY-MM-DD" heading');
  });

  it('released-version headings appear in descending semver order (invariant #2)', () => {
    const violations = findOutOfOrderPairs(headings);
    assert.equal(
      violations.length,
      0,
      violations.length === 0
        ? undefined
        : `CHANGELOG.md release headings out of order: ${violations
            .map((v) => `[${v.prev.versionString}] (line ${v.prev.line}) before [${v.curr.versionString}] (line ${v.curr.line})`)
            .join('; ')}`,
    );
  });

  it('no released-version heading appears twice (invariant #3)', () => {
    const dupes = findDuplicateHeadings(headings);
    assert.equal(
      dupes.length,
      0,
      dupes.length === 0
        ? undefined
        : `CHANGELOG.md duplicate release headings: ${dupes.map((d) => `[${d.versionString}] at lines ${d.lines.join(' and ')}`).join('; ')}`,
    );
  });

  it('top released-version heading agrees with version.json (invariant #4 — load-bearing)', () => {
    const top = headings[0];
    assert.equal(
      top.versionString,
      versionJson.version,
      `version.json says ${versionJson.version} but the top released CHANGELOG heading is [${top.versionString}] (line ${top.line}). PR #166-class regression: a release-version heading was deleted while its content remained.`,
    );
  });

  it('no release banner (> 🛟 / > 🚀) floats outside a released-version section (invariant #1)', () => {
    const orphans = findOrphanBanners(changelog);
    assert.equal(
      orphans.length,
      0,
      orphans.length === 0
        ? undefined
        : `Release banner(s) found outside a released-version section: ${orphans
            .map((o) => `line ${o.line}: ${o.raw.slice(0, 80)}`)
            .join('; ')}. Likely cause: the parent "## [X.Y.Z]" heading was deleted.`,
    );
  });
});

describe('CHANGELOG.md invariant detectors flag the post-#166 / pre-#167 regression shape', () => {
  // Synthesized minimal reproduction of the PR #166 state: the [3.16.1]
  // heading is gone, its banner + content remain under [Unreleased], and
  // version.json still says 3.16.1.
  const BROKEN = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '> 🛟 **Recommended bug-fix release.** Three fixes since v3.16.0…',
    '',
    '### Fixed',
    '',
    '- Some fix.',
    '',
    '## [3.16.0] - 2026-05-12',
    '',
    '### Added',
    '',
    '- Something.',
    '',
  ].join('\n');

  it('top released-version heading mismatch is detected (invariant #4)', () => {
    const headings = parseReleaseHeadings(BROKEN);
    assert.equal(headings[0].versionString, '3.16.0');
    assert.notEqual(headings[0].versionString, '3.16.1');
  });

  it('orphan release banner under [Unreleased] is detected (invariant #1)', () => {
    const orphans = findOrphanBanners(BROKEN);
    assert.equal(orphans.length, 1);
    assert.match(orphans[0].raw, /🛟/u);
  });

  it('out-of-order headings are detected (invariant #2)', () => {
    const SCRAMBLED = '## [3.15.0] - 2026-05-10\n\n## [3.16.0] - 2026-05-12\n';
    const violations = findOutOfOrderPairs(parseReleaseHeadings(SCRAMBLED));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].prev.versionString, '3.15.0');
    assert.equal(violations[0].curr.versionString, '3.16.0');
  });

  it('duplicate headings are detected (invariant #3)', () => {
    const DUPED = '## [3.16.0] - 2026-05-12\n\n## [3.16.0] - 2026-05-12\n';
    const dupes = findDuplicateHeadings(parseReleaseHeadings(DUPED));
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].versionString, '3.16.0');
  });
});
