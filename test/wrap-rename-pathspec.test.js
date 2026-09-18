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
const commitStep = require('../lib/wrap-steps/commit');
const launchBaseline = require('../lib/launch-baseline');
const wrapScope = require('../lib/wrap-scope');
const { execFileArgs } = require('../lib/exec');

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

/** The argv runner the scope takes in production. */
const asyncExec = (cmd, args, opts) => Promise.resolve(execFileArgs(cmd, args, opts));

/**
 * Resolve the real wrap scope for a repo.
 * @param {string} repo - Repo root
 * @param {object|null} baseline - Launch baseline
 * @returns {Promise<object>}
 */
function scopeFor(repo, baseline) {
  return wrapScope.resolve({ name: 'own', path: repo }, { id: 1, tmuxSession: 'own', startedAt: '2000-01-01 00:00:00' }, {
    exec: asyncExec,
    paneCurrentPath: () => repo,
    getLaunchBaseline: () => baseline
  });
}

/**
 * Run the REAL commit step, as the pipeline runs it.
 *
 * Not a re-implementation of the add/commit sequence: the whole defect was a
 * disagreement between two commands inside that step, so a test that rebuilds
 * the sequence tests the rebuild. It would pass against a step that still had
 * the bug.
 *
 * @param {string} repo - Repo root
 * @param {object} scope - From `scopeFor`
 * @param {object} [options] - Wrap run options (`pathDecisions`)
 * @returns {Promise<object>} The step result
 */
function runCommit(repo, scope, options = {}) {
  return commitStep.run({
    project: wrapScope.stepProject({ id: 1, name: 'own', path: repo }, scope),
    session: null,
    step: { id: 'commit' },
    previousResults: [],
    staged: {},
    options,
    scope
  });
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
  it('the real commit step commits a staged rename as a rename', async () => {
    // Through `commitStep.run`, not a replica of its add/commit sequence: the
    // defect WAS that sequence, so anything that rebuilds it tests the rebuild.
    const repo = makeRepo();
    const baseline = launchBaseline.capture(repo);
    git(repo, 'mv', 'old.md', 'new.md');
    const r = await runCommit(repo, await scopeFor(repo, baseline));

    assert.notEqual(r.status, 'blocked', `the wrap blocked: ${JSON.stringify(r.blockers || [])}`);
    assert.deepEqual(committedPaths(repo), ['R100\told.md\tnew.md'],
      'git recorded a rename, not an add plus an orphaned source');
  });

  it('is the case that used to exit 128', () => {
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

  it('commits an unstaged deletion, which git add CAN resolve', async () => {
    const repo = makeRepo();
    const baseline = launchBaseline.capture(repo);
    fs.rmSync(path.join(repo, 'old.md'));
    const r = await runCommit(repo, await scopeFor(repo, baseline));
    assert.notEqual(r.status, 'blocked', `blocked: ${JSON.stringify(r.blockers || [])}`);
    assert.deepEqual(committedPaths(repo), ['D\told.md']);
  });

  it('commits an already-staged deletion', async () => {
    const repo = makeRepo();
    const baseline = launchBaseline.capture(repo);
    git(repo, 'rm', '-q', 'old.md');
    const r = await runCommit(repo, await scopeFor(repo, baseline));
    assert.notEqual(r.status, 'blocked', `blocked: ${JSON.stringify(r.blockers || [])}`);
    assert.deepEqual(committedPaths(repo), ['D\told.md']);
  });

  it('commits several renames and ordinary edits in one commit', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'second.md'), 'another mover\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'second');
    const baseline = launchBaseline.capture(repo);
    git(repo, 'mv', 'old.md', 'moved-one.md');
    git(repo, 'mv', 'second.md', 'moved-two.md');
    fs.appendFileSync(path.join(repo, 'other.md'), 'edited\n');

    const r = await runCommit(repo, await scopeFor(repo, baseline));
    assert.notEqual(r.status, 'blocked', `blocked: ${JSON.stringify(r.blockers || [])}`);
    assert.deepEqual(committedPaths(repo).sort(),
      ['M\tother.md', 'R100\told.md\tmoved-one.md', 'R100\tsecond.md\tmoved-two.md']);
  });

  it('handles a rename whose names carry pathspec metacharacters', async () => {
    const repo = makeRepo();
    const weird = 'a*b?[c].md';
    fs.writeFileSync(path.join(repo, weird), 'literal name\n');
    git(repo, 'add', '--', weird);
    git(repo, 'commit', '-q', '-m', 'add the odd name');
    const baseline = launchBaseline.capture(repo);
    git(repo, 'mv', weird, 'renamed-odd.md');

    const r = await runCommit(repo, await scopeFor(repo, baseline));
    assert.notEqual(r.status, 'blocked', `blocked: ${JSON.stringify(r.blockers || [])}`);
    assert.deepEqual(committedPaths(repo), [`R100\t${weird}\trenamed-odd.md`]);
  });

  it('leaves the operator\'s own staged work staged and uncommitted', async () => {
    // `mine.md` was already uncommitted at launch, so it is the operator\'s and
    // the wrap must not carry it — while the rename, which is the session\'s,
    // still lands.
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'mine.md'), 'operator work\n');
    git(repo, 'add', '--', 'mine.md');
    const baseline = launchBaseline.capture(repo);
    git(repo, 'mv', 'old.md', 'new.md');

    const r = await runCommit(repo, await scopeFor(repo, baseline), { pathDecisions: { 'mine.md': 'leave' } });
    assert.notEqual(r.status, 'blocked', `blocked: ${JSON.stringify(r.blockers || [])}`);
    assert.deepEqual(committedPaths(repo), ['R100\told.md\tnew.md'], 'only the rename landed');
    assert.match(git(repo, 'status', '--porcelain'), /^A {2}mine\.md$/m,
      'the operator\'s staged file is still staged, still uncommitted');
  });

  it('refuses a half-committed rename WITHOUT leaving a wrap branch behind', async () => {
    // The split blocker, and the residue question three reviewers raised: it has
    // to refuse before the step creates a wrap branch, or the refusal leaves the
    // orphan branch this whole fix exists to stop producing.
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'old.md'), 'operator touched this before launch\n');
    const baseline = launchBaseline.capture(repo);
    git(repo, 'mv', 'old.md', 'new.md');

    const before = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    const headBefore = git(repo, 'rev-parse', 'HEAD').trim();
    const branchesBefore = git(repo, 'branch', '--format=%(refname:short)').trim();
    const r = await runCommit(repo, await scopeFor(repo, baseline), { pathDecisions: { 'old.md': 'leave' } });

    assert.equal(r.status, 'blocked');
    assert.match(r.blockers.join(' '), /half-committed/);
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), before,
      'HEAD did not move onto a wrap branch');
    assert.equal(git(repo, 'branch', '--format=%(refname:short)').trim(), branchesBefore,
      'and no wrap branch was created to be cleaned up later');
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), headBefore, 'nothing was committed');
  });

  it('names a remedy the operator can actually carry out', () => {
    const decidable = ownership.selectionOf(
      { owned: ['new.md'], included: [], tangleclawMaintenance: [], left: ['old.md'], undecided: [] },
      ownership.parseStatus('R  new.md\0old.md\0')
    ).splitRenames;
    assert.equal(decidable[0].reason, 'decision', 'the operator chose Leave and can choose again');

    const withheld = ownership.selectionOf(
      { owned: ['new.md'], included: [], tangleclawMaintenance: [], left: [], undecided: [] },
      ownership.parseStatus('R  new.md\0old.md\0')
    ).splitRenames;
    assert.equal(withheld[0].reason, 'not-committable',
      'a half no decision can include must not be described as one they can include');
  });

  it('does not treat a COPY as half a rename', () => {
    // A copy leaves its source in place, so committing the copy alone is an
    // ordinary add. Pairing copies would block a wrap on a repo configured with
    // `status.renames=copies` for a change nobody split.
    const dirty = ownership.parseStatus('C  copy.md\0src.md\0');
    assert.deepEqual(dirty.filter((f) => f.renamePair !== null), []);
    assert.equal(dirty.find((f) => f.path === 'src.md').indexRemoved, false,
      'and the source is still addable');
  });

  it('shows what half-committing a rename would actually have produced', () => {
    // Why the split is a blocker and not a warning, demonstrated rather than
    // asserted: the destination alone leaves the file committed under BOTH names.
    const repo = makeRepo();
    git(repo, 'mv', 'old.md', 'new.md');
    const f = path.join(repo, 'ps');
    fs.writeFileSync(f, ':(top,literal)new.md\0');
    git(repo, 'add', '-A', `--pathspec-from-file=${f}`, '--pathspec-file-nul');
    fs.rmSync(f);
    git(repo, 'commit', '-q', '-m', 'half', '--', 'new.md');

    const tracked = git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').sort();
    assert.deepEqual(tracked, ['new.md', 'old.md', 'other.md'],
      'committed under both names — this is what the blocker prevents');
  });
});
