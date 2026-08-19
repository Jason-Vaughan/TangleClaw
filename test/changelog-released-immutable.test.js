'use strict';

/*
 * A released CHANGELOG section is a historical record: it was published to a
 * GitHub Release the moment its tag landed, and `lib/changelog-notes.js` reads
 * it by heading. Editing it afterwards makes the file disagree with the release
 * page that installers actually read.
 *
 * That happened three times in a single day:
 *   1. A squash dropped the `## [5.7.0]` heading and left its 527-line body
 *      inside `## [5.8.0]`, so v5.8.0's release page republished every v5.7.0
 *      feature as new.
 *   2. A rebase merged a feature branch's entries into the ALREADY-PUBLISHED
 *      `## [5.9.0]` section.
 *   3. The same rebase again, after the first repair.
 *
 * Invariant #6 in changelog-structure.test.js catches (1) — a section that
 * swallows another leaves a duplicated `### Added` as the seam. It provably does
 * NOT catch (2) or (3): a rebase that merges entries into a released section's
 * EXISTING subsections duplicates nothing, so the shape is invisible to it.
 * This guard closes that gap by pinning content rather than structure.
 *
 * WHEN THIS FAILS ON A RELEASE PR: cutting a release moves `[Unreleased]` under
 * a new dated heading, which is a NEW section, not an edit to an old one. Add
 * its line to the lock (the regen command is in the failure message). If it
 * fails naming a version that was already released, do NOT relock — an already-
 * published section changed underneath you, which is the bug this exists for.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(__dirname, 'fixtures', 'changelog-released-sections.lock.json');
const RELEASE_HEADING_RE = /^## \[(\d+\.\d+\.\d+)\] - /;

/**
 * Hash the body of every dated release section in the changelog.
 * @param {string} text - Full CHANGELOG.md contents.
 * @returns {Record<string, string>} version → 16-char sha256 prefix of its body.
 */
function hashReleasedSections(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    const m = line.match(RELEASE_HEADING_RE);
    if (m) starts.push({ index: i, version: m[1] });
  });
  const out = {};
  starts.forEach((s, n) => {
    const end = n + 1 < starts.length ? starts[n + 1].index : lines.length;
    const body = lines.slice(s.index + 1, end).join('\n').trim();
    out[s.version] = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  });
  return out;
}

describe('released CHANGELOG sections are immutable', () => {
  const changelog = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const current = hashReleasedSections(changelog);

  it('no already-released section has changed since it was locked', () => {
    const changed = Object.keys(lock).filter((v) => current[v] && current[v] !== lock[v]);
    assert.deepEqual(
      changed, [],
      changed.length === 0
        ? ''
        : `these released sections were edited after publication: ${changed.join(', ')}. `
          + 'Their GitHub Release pages already carry the old text, so the file now disagrees '
          + 'with what installers read. This is usually a rebase or squash folding branch '
          + 'entries into a dated section instead of [Unreleased] — move them back rather than '
          + 'relocking.'
    );
  });

  it('no released section has disappeared (the #5.7.0 absorption shape)', () => {
    const vanished = Object.keys(lock).filter((v) => !current[v]);
    assert.deepEqual(
      vanished, [],
      vanished.length === 0
        ? ''
        : `these release headings are gone from CHANGELOG.md: ${vanished.join(', ')}. `
          + 'A squash almost certainly dropped the heading and left the body inside the '
          + 'section above it, which makes that release republish this one\'s notes.'
    );
  });

  it('every released section is locked (a new release must add its line)', () => {
    const unlocked = Object.keys(current).filter((v) => !(v in lock));
    assert.deepEqual(
      unlocked, [],
      unlocked.length === 0
        ? ''
        : `released but not locked: ${unlocked.join(', ')}. If this is the release you are `
          + 'cutting, regenerate the lock and commit it with the release PR:\n'
          + '  node -e \'const fs=require("fs"),c=require("crypto");const t=fs.readFileSync("CHANGELOG.md","utf8").split("\\n");'
          + 'const s=[];t.forEach((l,i)=>{const m=l.match(/^## \\[(\\d+\\.\\d+\\.\\d+)\\] - /);if(m)s.push([i,m[1]]);});'
          + 'const o={};s.forEach(([i,v],n)=>{const e=n+1<s.length?s[n+1][0]:t.length;'
          + 'o[v]=c.createHash("sha256").update(t.slice(i+1,e).join("\\n").trim()).digest("hex").slice(0,16);});'
          + 'fs.writeFileSync("test/fixtures/changelog-released-sections.lock.json",JSON.stringify(o,null,2)+"\\n");\''
    );
  });
});
