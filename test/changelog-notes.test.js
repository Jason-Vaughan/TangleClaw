'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setLevel } = require('../lib/logger');
setLevel('error');

const { extractReleaseNotes } = require('../lib/changelog-notes');

const BRACKETED = `# Changelog

All notable changes are documented in this file.

## [Unreleased]

## [4.32.1] - 2026-07-26

### Fixed
- Port reporting matches what the server binds (#654).

### Internal
- Generated engine configs are gitignored (#708).

## [4.32.0] - 2026-07-26

### Added
- Something older.
`;

const BARE = `# Changelog

## Unreleased

## 1.4.2 - 2026-01-05

### Fixed
- A bare-style project's fix.

## 1.4.1 - 2026-01-01

### Added
- Older bare entry.
`;

test('extracts the body of a bracketed release section', () => {
  const notes = extractReleaseNotes(BRACKETED, '4.32.1');
  assert.match(notes, /### Fixed/);
  assert.match(notes, /#654/);
  assert.match(notes, /### Internal/);
  assert.match(notes, /#708/);
});

test('excludes the heading line itself from the body', () => {
  const notes = extractReleaseNotes(BRACKETED, '4.32.1');
  assert.ok(!notes.includes('## [4.32.1]'), 'heading leaked into the notes body');
  assert.ok(notes.startsWith('### Fixed'), `expected body to start at first entry, got: ${notes.slice(0, 40)}`);
});

test('stops at the next release heading — does not bleed into older sections', () => {
  const notes = extractReleaseNotes(BRACKETED, '4.32.1');
  assert.ok(!notes.includes('Something older'), 'notes bled into the previous release');
  assert.ok(!notes.includes('4.32.0'), 'notes included the next heading');
});

test('a leading "v" on the requested version is accepted', () => {
  assert.equal(extractReleaseNotes(BRACKETED, 'v4.32.1'), extractReleaseNotes(BRACKETED, '4.32.1'));
});

test('extracts from a bare-style changelog (## X.Y.Z - date)', () => {
  // version-bump emits bare headings for projects already using that convention
  // (lib/wrap-steps/version-bump.js), so the extractor must read them too.
  const notes = extractReleaseNotes(BARE, '1.4.2');
  assert.match(notes, /A bare-style project's fix/);
  assert.ok(!notes.includes('Older bare entry'), 'bled into the previous bare section');
});

test('returns null when the version has no section', () => {
  assert.equal(extractReleaseNotes(BRACKETED, '9.9.9'), null);
});

test('never matches the Unreleased section', () => {
  assert.equal(extractReleaseNotes(BRACKETED, 'Unreleased'), null);
});

test('a version that is a prefix of another does not match it', () => {
  const text = `# Changelog

## [4.3.10] - 2026-02-02

### Fixed
- The ten release.
`;
  assert.equal(extractReleaseNotes(text, '4.3.1'), null, '4.3.1 must not match the 4.3.10 heading');
  assert.match(extractReleaseNotes(text, '4.3.10'), /The ten release/);
});

test('handles a release that is the last section in the file', () => {
  const text = `# Changelog

## [1.0.0] - 2026-01-01

### Added
- First release.
`;
  const notes = extractReleaseNotes(text, '1.0.0');
  assert.match(notes, /First release/);
  assert.ok(!notes.endsWith('\n\n'), 'trailing blank lines should be trimmed');
});

test('returns null for an empty section rather than an empty string', () => {
  const text = `# Changelog

## [1.0.0] - 2026-01-01

## [0.9.0] - 2025-12-01

### Added
- Older.
`;
  assert.equal(extractReleaseNotes(text, '1.0.0'), null,
    'an empty release section must not produce empty release notes');
});

test('guards against bad input instead of throwing', () => {
  assert.equal(extractReleaseNotes('', '1.0.0'), null);
  assert.equal(extractReleaseNotes(null, '1.0.0'), null);
  assert.equal(extractReleaseNotes(BRACKETED, ''), null);
  assert.equal(extractReleaseNotes(BRACKETED, null), null);
});

test("this repo's own CHANGELOG yields notes for the shipped version", () => {
  const root = path.resolve(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')).version;
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const notes = extractReleaseNotes(changelog, version);
  assert.ok(notes && notes.length > 0,
    `no CHANGELOG section for the current version ${version} — the release workflow would fail`);
});

test('the release workflow references an extractor path that exists', () => {
  // release.yml shells out to the extractor by path. A rename would break the
  // release chain silently and surface only at the next release.
  const root = path.resolve(__dirname, '..');
  const workflowPath = path.join(root, '.github/workflows/release.yml');
  assert.ok(fs.existsSync(workflowPath), 'release workflow is missing');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  const refs = [...workflow.matchAll(/(?:node\s+)(lib\/[\w./-]+\.js)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, 'expected release.yml to invoke a lib/ script for release notes');
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(root, ref)), `release.yml references missing file: ${ref}`);
  }
});
