'use strict';

/**
 * #1629 — the wrap commit must not feed a removed rename source to `git add`.
 *
 * Every case here runs REAL git, per the issue: the failure was a disagreement
 * between what git accepts from `add` and from `commit`, and a mocked runner
 * asserts only what we already believed. The assertions are on the resulting
 * COMMIT CONTENTS and the surviving index, not on command arguments.
 *
 * The property: `stageable` is the complete authorized commit selection and
 * `addable` is the subset `git add` can resolve. A path git has already removed
 * from the index belongs in the first and not the second.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ownership = require('../lib/wrap-steps/_file-ownership');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * Run git in a repo and return stdout.
 * @param {string} cwd - Repo root
 * @param {...string} args - git arguments
 * @returns {string}
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * A repo with one commit, on a feature branch.
 * @returns {string} Its path
 */
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1629-')));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  // Distinct contents: identical files let git's rename detection pair them
  // arbitrarily, which makes a fixture that proves nothing about the case it
  // claims to be testing.
  fs.writeFileSync(path.join(dir, 'old.md'), 'the moved document, line one\n');
  fs.writeFileSync(path.join(dir, 'other.md'), 'a different file entirely\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

/**
 * The paths a commit changed, with git's own rename notation.
 * @param {string} repo - Repo root
 * @returns {string[]}
 */
function committedPaths(repo) {
  return git(repo, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean);
}

/**
 * Stage exactly what the wrap would: add the addable paths, commit the stageable ones.
 * @param {string} repo - Repo root
 * @param {object} selection - From `ownership.selectionOf`
 * @returns {void}
 */
function wrapCommit(repo, selection) {
  if (selection.addable.length > 0) {
    const f = path.join(repo, '.add-pathspec');
    fs.writeFileSync(f, `${selection.addable.map((p) => `:(top,literal)${p}`).join('\0')}\0`);
    git(repo, 'add', '-A', `--pathspec-from-file=${f}`, '--pathspec-file-nul');
    fs.rmSync(f);
  }
  const c = path.join(repo, '.commit-pathspec');
  fs.writeFileSync(c, `${selection.stageable.map((p) => `:(top,literal)${p}`).join('\0')}\0`);
  git(repo, 'commit', '-q', '-m', 'wrap', `--pathspec-from-file=${c}`, '--pathspec-file-nul');
  fs.rmSync(c);
}

/**
 * The selection the wrap would build for everything dirty in a repo.
 * @param {string} repo - Repo root
 * @returns {object} `{dirty, ...selection}`
 */
function selectionFor(repo) {
  const dirty = ownership.parseStatus(git(repo, 'status', '--porcelain', '-z'));
  const owned = dirty.map((f) => f.path).filter((p) => !p.startsWith('.add-') && !p.startsWith('.commit-'));
  return { dirty, ...ownership.selectionOf({ owned, included: [], tangleclawMaintenance: [] }, dirty) };
}

describe('#1629 — a staged rename reaches the commit', () => {
  it('commits a staged rename as a rename', () => {
    const repo = makeRepo();
    git(repo, 'mv', 'old.md', 'new.md');
    const sel = selectionFor(repo);

    assert.ok(sel.stageable.includes('old.md'), 'the source is in the commit selection');
    assert.ok(!sel.addable.includes('old.md'), 'and out of what git add is handed');

    wrapCommit(repo, sel);
    assert.deepEqual(committedPaths(repo), ['R100\told.md\tnew.md'],
      'git recorded a rename, not an add plus an orphaned source');
    assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'and the tree is clean');
  });

  it('is the case that used to exit 128', () => {
    // The literal reproduction from the issue: feeding the source to `git add`.
    const repo = makeRepo();
    git(repo, 'mv', 'old.md', 'new.md');
    const f = path.join(repo, 'ps');
    fs.writeFileSync(f, 'new.md\0old.md\0');
    assert.throws(
      () => git(repo, 'add', '-A', `--pathspec-from-file=${f}`, '--pathspec-file-nul'),
      /did not match any files/,
      'git still refuses it — the fix is to not ask, not to expect git to change'
    );
  });

  it('commits an unstaged deletion, which git add CAN resolve', () => {
    const repo = makeRepo();
    fs.rmSync(path.join(repo, 'old.md'));
    const sel = selectionFor(repo);
    assert.ok(sel.addable.includes('old.md'),
      'an unstaged deletion is still in the index; withholding it would stop the wrap committing removals');
    wrapCommit(repo, sel);
    assert.deepEqual(committedPaths(repo), ['D\told.md']);
  });

  it('commits an already-staged deletion', () => {
    const repo = makeRepo();
    git(repo, 'rm', '-q', 'old.md');
    const sel = selectionFor(repo);
    assert.ok(sel.stageable.includes('old.md'));
    assert.ok(!sel.addable.includes('old.md'));
    wrapCommit(repo, sel);
    assert.deepEqual(committedPaths(repo), ['D\told.md']);
  });

  it('leaves the operator\'s own staged work staged and uncommitted', () => {
    const repo = makeRepo();
    git(repo, 'mv', 'old.md', 'new.md');
    fs.writeFileSync(path.join(repo, 'mine.md'), 'operator work\n');
    git(repo, 'add', 'mine.md');

    const dirty = ownership.parseStatus(git(repo, 'status', '--porcelain', '-z'));
    // The wrap owns the rename; `mine.md` is the operator's and is not authorized.
    const sel = ownership.selectionOf(
      { owned: ['new.md', 'old.md'], included: [], tangleclawMaintenance: [] }, dirty
    );
    wrapCommit(repo, sel);

    assert.deepEqual(committedPaths(repo), ['R100\told.md\tnew.md'], 'only the rename landed');
    assert.match(git(repo, 'status', '--porcelain'), /^A {2}mine\.md$/m,
      'the operator\'s staged file is still staged, still uncommitted');
  });

  it('handles a rename whose names carry pathspec metacharacters', () => {
    const repo = makeRepo();
    const weird = 'a*b?[c].md';
    fs.writeFileSync(path.join(repo, weird), 'literal name\n');
    fs.writeFileSync(path.join(repo, 'decoy.md'), 'must not be committed\n');
    git(repo, 'add', weird);
    git(repo, 'commit', '-q', '-m', 'add the odd name');
    git(repo, 'mv', weird, 'renamed-odd.md');

    const dirty = ownership.parseStatus(git(repo, 'status', '--porcelain', '-z'));
    const sel = ownership.selectionOf(
      { owned: ['renamed-odd.md', weird], included: [], tangleclawMaintenance: [] }, dirty
    );
    wrapCommit(repo, sel);

    assert.deepEqual(committedPaths(repo), [`R100\t${weird}\trenamed-odd.md`]);
    assert.match(git(repo, 'status', '--porcelain'), /decoy\.md/,
      'the untracked decoy was not swept in by a glob');
  });

  it('commits several renames and ordinary edits together', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'second.md'), 'another mover\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'second');
    git(repo, 'mv', 'old.md', 'moved-one.md');
    git(repo, 'mv', 'second.md', 'moved-two.md');
    fs.appendFileSync(path.join(repo, 'other.md'), 'edited\n');

    const sel = selectionFor(repo);
    assert.equal(sel.splitRenames.length, 0, 'both halves of both renames are authorized');
    wrapCommit(repo, sel);

    const landed = committedPaths(repo).sort();
    assert.deepEqual(landed, ['M\tother.md', 'R100\told.md\tmoved-one.md', 'R100\tsecond.md\tmoved-two.md']);
    assert.equal(git(repo, 'status', '--porcelain').trim(), '');
  });

  it('sees the split when only one half of a rename is authorized', () => {
    // The commit step refuses on this rather than publishing half a rename;
    // here the selection just has to SEE it, which is what the step reads.
    const repo = makeRepo();
    git(repo, 'mv', 'old.md', 'new.md');
    const dirty = ownership.parseStatus(git(repo, 'status', '--porcelain', '-z'));

    const destOnly = ownership.selectionOf({ owned: ['new.md'], included: [], tangleclawMaintenance: [] }, dirty);
    assert.equal(destOnly.splitRenames.length, 1);
    assert.deepEqual(destOnly.splitRenames[0].left, ['old.md']);

    const srcOnly = ownership.selectionOf({ owned: ['old.md'], included: [], tangleclawMaintenance: [] }, dirty);
    assert.equal(srcOnly.splitRenames.length, 1, 'and the other way round');
    assert.deepEqual(srcOnly.splitRenames[0].left, ['new.md']);
  });

  it('shows what half-committing a rename would actually have produced', () => {
    // Why the split is a blocker and not a warning: committing the destination
    // alone is not a partial rename, it is a DIFFERENT change — the source stays
    // tracked and the file exists twice.
    const repo = makeRepo();
    git(repo, 'mv', 'old.md', 'new.md');
    const dirty = ownership.parseStatus(git(repo, 'status', '--porcelain', '-z'));
    wrapCommit(repo, ownership.selectionOf(
      { owned: ['new.md'], included: [], tangleclawMaintenance: [] }, dirty
    ));

    const tracked = git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').sort();
    assert.deepEqual(tracked, ['new.md', 'old.md', 'other.md'],
      'the moved document is now committed under BOTH names — this is what the blocker prevents');
  });
});
