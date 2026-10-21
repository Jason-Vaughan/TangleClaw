'use strict';

/*
 * Early warning for the release notes gate (#2080). The release workflow
 * refuses notes over the gate's ceiling and never truncates them, so an
 * oversized [Unreleased] section would only be discovered at the version bump,
 * after everything in it has merged. This fails at merge time instead, on the
 * PR whose entry crosses the line, while there is still room to condense.
 *
 * What is measured is the file the release would publish, byte for byte. The
 * version bump promotes [Unreleased] under a version heading unchanged, and
 * release.yml then runs `node lib/changelog-notes.js <version> >
 * release-notes.md`. So the section is promoted in a scratch copy and that same
 * command writes the file that is counted, trailing newline included. Counting
 * the extractor's return value instead would come up a byte short.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MAX_RELEASE_BODY_BYTES } = require('../scripts/release-notes-gate');
const fragments = require('../lib/changelog-fragments');

const REPO_ROOT = path.join(__dirname, '..');
const EXTRACTOR = path.join(__dirname, '..', 'lib', 'changelog-notes.js');
const GATE = path.join(__dirname, '..', 'scripts', 'release-notes-gate.js');

/** Where this test starts failing: far enough under the ceiling to leave room for entries still in flight. */
const EARLY_WARNING_BYTES = 110000;

/** A version no real release uses, standing in for the one the bump would assign. */
const PROMOTED = '0.0.0-unreleased-size-check';

const UNRELEASED_HEADING_RE = /^## \[Unreleased\].*$/m;

let dir;
let seq = 0;

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-unreleased-size-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * Write the release-notes file the workflow would publish if [Unreleased] were
 * released now, using the workflow's own extractor command.
 * @param {string} changelogText - Full contents of a CHANGELOG.md
 * @returns {string|null} Path of the written notes file (empty when the section
 *   is empty, since the extractor then writes nothing), or null when there is no
 *   [Unreleased] heading.
 */
function writeUnreleasedNotesFile(changelogText) {
  if (!UNRELEASED_HEADING_RE.test(changelogText)) return null;
  const n = ++seq;
  const changelogPath = path.join(dir, `CHANGELOG-${n}.md`);
  const notesPath = path.join(dir, `release-notes-${n}.md`);
  fs.writeFileSync(changelogPath, changelogText.replace(UNRELEASED_HEADING_RE, `## [${PROMOTED}]`));
  const run = spawnSync(process.execPath, [EXTRACTOR, PROMOTED, changelogPath], { maxBuffer: 64 * 1024 * 1024 });
  // Exit 1 is the extractor's "no notes for this version": an empty section.
  assert.ok(run.status === 0 || run.status === 1, `changelog-notes.js exited ${run.status}: ${run.stderr}`);
  fs.writeFileSync(notesPath, run.stdout);
  return notesPath;
}

/**
 * The size of the file the release would publish for [Unreleased].
 * @param {string} changelogText - Full contents of a CHANGELOG.md
 * @returns {number|null} Bytes on disk, or null when there is no [Unreleased] heading.
 */
function unreleasedPublishBytes(changelogText) {
  const notesPath = writeUnreleasedNotesFile(changelogText);
  return notesPath === null ? null : fs.statSync(notesPath).size;
}

/**
 * Fail when a publish file is over the early-warning line.
 * @param {number} bytes - Size of the file the release would publish
 * @returns {void}
 */
function assertUnderEarlyWarning(bytes) {
  assert.ok(bytes <= EARLY_WARNING_BYTES,
    `[Unreleased] would publish ${bytes} UTF-8 bytes of release notes, over the ${EARLY_WARNING_BYTES}-byte early warning. `
    + `The release refuses notes over ${MAX_RELEASE_BODY_BYTES} bytes and never truncates them. `
    + 'Condense entries (keep every item, its headline and its references; cut implementation narration), or release what has accumulated.');
}

/**
 * A changelog whose [Unreleased] publishes a file of exactly `bytes` bytes.
 * @param {number} bytes - Size the published notes file must have, newline included
 * @returns {string}
 */
function changelogPublishing(bytes) {
  // The published file is the section body plus the extractor's one trailing newline.
  return `# Changelog\n\n## [Unreleased]\n\n${'x'.repeat(bytes - 1)}\n\n## [1.0.0] - 2026-01-01\n\n- old\n`;
}

describe('CHANGELOG [Unreleased] size early warning (#2080)', () => {
  it('warns below the release gate\'s ceiling, not at or above it', () => {
    assert.ok(EARLY_WARNING_BYTES < MAX_RELEASE_BODY_BYTES);
  });

  it('[Unreleased] stays under the early-warning line, the pending changelog fragments compiled in', () => {
    // A release compiles every fragment under changelog.d/ into [Unreleased]
    // before it promotes the block (#1220), so the file it would publish is the
    // spliced text, not CHANGELOG.md as committed.
    const pending = fragments.readFragments(REPO_ROOT);
    assert.ok(pending.ok, `changelog.d/ holds files the release would refuse: ${pending.refused.map((r) => `${r.path} (${r.code})`).join(', ')}`);
    const spliced = fragments.spliceIntoUnreleased(
      fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8'),
      fragments.compileFragments(pending.fragments)
    );
    assert.ok(spliced.ok, 'CHANGELOG.md must have an [Unreleased] section');
    const bytes = unreleasedPublishBytes(spliced.text);
    assert.notEqual(bytes, null, 'CHANGELOG.md must have an [Unreleased] section');
    assertUnderEarlyWarning(bytes);
  });

  it('counts a fragment the release would compile, not only what [Unreleased] holds today (#1220)', () => {
    const base = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- old\n';
    const compiled = fragments.compileFragments([{ issue: 1, slug: 'x', type: 'added', body: `- ${'y'.repeat(100)}\n` }]);
    const spliced = fragments.spliceIntoUnreleased(base, compiled).text;
    assert.equal(unreleasedPublishBytes(base), 0);
    assert.equal(unreleasedPublishBytes(spliced), Buffer.byteLength(`### Added\n- ${'y'.repeat(100)}`, 'utf8') + 1);
  });

  it('a publish file of exactly the early-warning size passes, and one byte more fails', () => {
    assert.equal(unreleasedPublishBytes(changelogPublishing(EARLY_WARNING_BYTES)), EARLY_WARNING_BYTES);
    assert.doesNotThrow(() => assertUnderEarlyWarning(unreleasedPublishBytes(changelogPublishing(EARLY_WARNING_BYTES))));

    assert.equal(unreleasedPublishBytes(changelogPublishing(EARLY_WARNING_BYTES + 1)), EARLY_WARNING_BYTES + 1);
    assert.throws(() => assertUnderEarlyWarning(unreleasedPublishBytes(changelogPublishing(EARLY_WARNING_BYTES + 1))),
      /over the 110000-byte early warning/);
  });

  it('counts the newline the extractor command appends, which the section body alone does not have', () => {
    const sample = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- **é**\n\n## [1.0.0] - 2026-01-01\n\n- old\n';
    const notesPath = writeUnreleasedNotesFile(sample);
    assert.equal(fs.readFileSync(notesPath, 'utf8'), '### Added\n\n- **é**\n');
    assert.equal(unreleasedPublishBytes(sample), Buffer.byteLength('### Added\n\n- **é**', 'utf8') + 1);
    assert.equal(Buffer.byteLength('é', 'utf8'), 2, 'bytes, not characters');
  });

  it('counts a fenced "## " line as content, as the extractor does, so the count cannot stop early', () => {
    const fenced = '## [Unreleased]\n\n- entry\n\n```\n## not a heading\n```\n\n- after the fence\n\n## [1.0.0]\n\n- old\n';
    assert.equal(fs.readFileSync(writeUnreleasedNotesFile(fenced), 'utf8'),
      '- entry\n\n```\n## not a heading\n```\n\n- after the fence\n');
  });

  it('reads an empty section as 0 bytes and a missing one as null', () => {
    assert.equal(unreleasedPublishBytes('# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n\n- old\n'), 0);
    assert.equal(unreleasedPublishBytes('# Changelog\n\n## [1.0.0]\n\n- old\n'), null);
  });
});

describe('the extractor command feeding the release notes gate, end to end (#2080)', () => {
  /**
   * Run the gate, as release.yml does, on the file the extractor command wrote.
   * @param {number} bytes - Size of the published notes file
   * @returns {{ status: number, stdout: string, stderr: string }}
   */
  function gateOnPublished(bytes) {
    const notesPath = writeUnreleasedNotesFile(changelogPublishing(bytes));
    assert.equal(fs.statSync(notesPath).size, bytes);
    const run = spawnSync(process.execPath, [GATE, notesPath], { encoding: 'utf8' });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  it('passes a published file of exactly the ceiling', () => {
    const run = gateOnPublished(MAX_RELEASE_BODY_BYTES);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /120000 of 120000 bytes/);
  });

  it('refuses a published file one byte over, where the section body alone would still have fit', () => {
    const run = gateOnPublished(MAX_RELEASE_BODY_BYTES + 1);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /120001 bytes, over the 120000-byte ceiling/);
  });
});
