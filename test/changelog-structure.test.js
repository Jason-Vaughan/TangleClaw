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

/**
 * Find release sections that carry the same `###` subsection twice.
 *
 * This is the tell for a section ABSORPTION: a squash merge lands a branch's
 * CHANGELOG edit under the wrong heading, the older release's `## [X.Y.Z]`
 * line is dropped, and its whole body ends up inside the newer section. The
 * result reads as one enormous release and, because `lib/changelog-notes.js`
 * extracts by heading, the newer version's GitHub Release republishes the
 * older one's notes verbatim.
 *
 * It has happened twice: #598/#597, and again when v5.7.0's 527-line body was
 * absorbed into `## [5.8.0]` — which published a v5.8.0 release page claiming
 * every v5.7.0 feature as new. A duplicated `### Added` was the visible seam
 * both times, because Keep a Changelog gives each section at most one of each.
 *
 * Fenced blocks are skipped: this changelog quotes markdown, so a `### ` line
 * inside a fence is content, not a heading.
 *
 * @param {string} text - Full CHANGELOG.md contents.
 * @returns {Array<{section: string, subsection: string, line: number}>}
 */
function findDuplicateSubsections(text) {
  const violations = [];
  let section = null;
  let seen = new Set();
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    if (/^## /.test(line)) {
      section = line.replace(/^##\s+/, '').trim();
      seen = new Set();
      return;
    }
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (!m || section === null) return;
    const name = m[1];
    if (seen.has(name)) violations.push({ section, subsection: name, line: i + 1 });
    else seen.add(name);
  });
  return violations;
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

function findUnreleasedHeadings(text) {
  const lines = [];
  text.split('\n').forEach((line, i) => {
    if (UNRELEASED_HEADING_RE.test(line)) lines.push(i + 1);
  });
  return lines;
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

  it('exactly one [Unreleased] heading exists (invariant #5 — #281)', () => {
    const unreleased = findUnreleasedHeadings(changelog);
    assert.equal(
      unreleased.length,
      1,
      unreleased.length === 1
        ? undefined
        : `CHANGELOG.md must have exactly one "## [Unreleased]" heading; found ${unreleased.length} at line(s) ${unreleased.join(', ')}. A second [Unreleased] is the #281 failure shape — release notes that were never promoted to a dated section (the version-bump left the heading behind).`,
    );
  });

  // Sections that already carried repeated subsections before this guard existed.
  // They are all 3.x, they pre-date the current release process, and a released
  // section is immutable history — rewriting them would edit the record to satisfy
  // a test. Keyed by version rather than line number so the baseline does not rot
  // as the file grows above them. NOTHING NEW MAY JOIN THIS LIST: a duplicate in
  // any other section is an absorption and fails.
  const PRE_GUARD_SECTIONS = new Set(['3.20.0', '3.18.0', '3.16.0', '3.13.0', '3.0.1']);

  it('no release section carries the same ### subsection twice (invariant #6 — absorption)', () => {
    const violations = findDuplicateSubsections(changelog)
      .filter((v) => {
        const m = v.section.match(/^\[(\d+\.\d+\.\d+)\]/);
        return !(m && PRE_GUARD_SECTIONS.has(m[1]));
      });
    assert.equal(
      violations.length,
      0,
      violations.length === 0
        ? ''
        : 'a repeated ### subsection means one release section swallowed another (a squash '
          + 'dropped the older `## [X.Y.Z]` heading). The newer version then publishes the older '
          + "one's notes as its own. Offenders: "
          + violations.map((v) => `"${v.section}" repeats "### ${v.subsection}" at line ${v.line}`).join('; ')
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

  it('an absorbed release section is detected (invariant #6 — the v5.7.0-into-v5.8.0 shape)', () => {
    // The exact wound: [5.8.0] keeps its own Added/Fixed, then [5.7.0]'s heading
    // is gone and its Added/Changed body continues inside the same section.
    const absorbed = [
      '## [Unreleased]',
      '',
      '## [5.8.0] - 2026-08-18',
      '',
      '### Added',
      '- 5.8.0 own entry',
      '',
      '### Fixed',
      '- 5.8.0 own fix',
      '',
      '### Added',
      "- 5.7.0's entry, absorbed when the squash dropped its heading",
      '',
      '### Changed',
      "- 5.7.0's change",
      '',
    ].join('\n');
    const violations = findDuplicateSubsections(absorbed);
    assert.equal(violations.length, 1, 'the repeated ### Added must be flagged');
    assert.equal(violations[0].section, '[5.8.0] - 2026-08-18');
    assert.equal(violations[0].subsection, 'Added');
  });

  it('a ### line inside a fenced block is content, not a subsection (invariant #6 false-positive guard)', () => {
    const fenced = [
      '## [1.0.0] - 2026-01-01',
      '',
      '### Added',
      '- an entry that quotes markdown:',
      '',
      '  ```markdown',
      '  ### Added',
      '  ### Added',
      '  ```',
      '',
    ].join('\n');
    assert.deepEqual(findDuplicateSubsections(fenced), [],
      'repeated headings inside a fence are quoted content and must not trip the detector');
  });

  it('a buried second [Unreleased] heading is detected (invariant #5 — #281 shape)', () => {
    // The #281 reproduction: a stray [Unreleased] mid-file holding release
    // notes that were never stamped with their version (e.g. v3.2.3–v3.2.9
    // collapsed under one orphaned heading).
    const BURIED = [
      '## [Unreleased]',
      '',
      '## [3.3.0] - 2026-03-23',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '- orphaned note never promoted',
      '',
      '## [3.2.2] - 2026-03-20',
      '',
    ].join('\n');
    const unreleased = findUnreleasedHeadings(BURIED);
    assert.equal(unreleased.length, 2);
    assert.deepEqual(unreleased, [1, 5]);
  });
});
