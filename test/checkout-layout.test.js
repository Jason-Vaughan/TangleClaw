'use strict';

/*
 * `lib/checkout-layout.js` — where the primary checkout is, and which of its
 * worktrees a path belongs to (#798).
 *
 * The guard's own tests drive the happy paths end-to-end through a real
 * repository. These cover the answers that decide whether the guard REFUSES,
 * which is the direction that costs the operator a working session: a layout it
 * cannot read, a worktree record it cannot parse, and the shapes that must not
 * be mistaken for a worktree at all.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { initRepo } = require('./_temp-repo');
const {
  realOrSelf, locateCheckouts, linkedWorktreeRoots, landsInPrimary
} = require('../lib/checkout-layout');

describe('locateCheckouts', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-layout-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('reports a real repository and its worktree, and agrees on the primary', () => {
    const primary = path.join(base, 'primary');
    fs.mkdirSync(primary);
    initRepo(primary, ['-b', 'main']);
    const git = (...a) => execFileSync('git', a, { cwd: primary, stdio: ['pipe', 'pipe', 'pipe'] });
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(primary, 'f.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const wt = path.join(primary, '.claude', 'worktrees', 'w');
    git('worktree', 'add', '-q', wt, '-b', 'b');

    assert.deepEqual(locateCheckouts(primary), { primary, isWorktree: false });
    // The same primary from either side, or the guard would compute a different
    // "live install" depending on where the session happened to start.
    assert.deepEqual(locateCheckouts(wt), { primary, isWorktree: true });
  });

  it('answers null for a directory that is not a checkout', () => {
    assert.equal(locateCheckouts(base), null);
  });

  it('answers null for a .git that is neither a directory nor a file', () => {
    const root = path.join(base, 'odd');
    fs.mkdirSync(root);
    fs.symlinkSync('/nowhere', path.join(root, '.git'));
    // A dangling symlink lstats as a link, not a file — inventing a primary from
    // it would point the guard at a path nobody serves.
    assert.equal(locateCheckouts(root), null);
  });

  it('answers null for a .git file with no gitdir line', () => {
    const root = path.join(base, 'nogitdir');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.git'), 'something else\n');
    assert.equal(locateCheckouts(root), null);
  });

  it('does not read a plain directory named "worktrees" as a worktree record', () => {
    // Anchored on the `.git/worktrees` PAIR. Keyed to the last `worktrees`
    // segment alone, this would report `/x/worktrees` — three components up from
    // a path that is not a git record at all — as a primary checkout.
    const root = path.join(base, 'fake');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${path.join(base, 'a', 'worktrees', 'w')}\n`);
    assert.equal(locateCheckouts(root), null);
  });
});

describe('linkedWorktreeRoots', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wtroots-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('is empty, not an error, for a repository with no worktrees', () => {
    assert.deepEqual(linkedWorktreeRoots(base), { roots: [], unreadable: [] });
  });

  it('reports a record it cannot read instead of silently skipping it', () => {
    // An unsubtracted worktree makes the guard MORE likely to refuse — writes
    // inside that worktree read as writes to the primary. A silent skip would
    // present that as normal operation.
    const recs = path.join(base, '.git', 'worktrees');
    fs.mkdirSync(path.join(recs, 'good'), { recursive: true });
    fs.mkdirSync(path.join(recs, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(recs, 'good', 'gitdir'), `${path.join(base, 'wt', '.git')}\n`);
    // No `gitdir` file at all in `broken`.
    const out = linkedWorktreeRoots(base);
    assert.deepEqual(out.roots, [path.join(base, 'wt')]);
    assert.deepEqual(out.unreadable, ['broken']);
  });

  it('reports an empty gitdir file as unreadable rather than as the filesystem root', () => {
    const recs = path.join(base, '.git', 'worktrees');
    fs.mkdirSync(path.join(recs, 'empty'), { recursive: true });
    fs.writeFileSync(path.join(recs, 'empty', 'gitdir'), '\n');
    assert.deepEqual(linkedWorktreeRoots(base), { roots: [], unreadable: ['empty'] });
  });
});

describe('landsInPrimary', () => {
  let base, primary, wt;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lands-')));
    primary = path.join(base, 'p');
    wt = path.join(primary, '.claude', 'worktrees', 'w');
    fs.mkdirSync(path.join(wt, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(primary, 'lib'), { recursive: true });
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('subtracts a worktree NESTED inside the primary', () => {
    // Without the subtraction every path in every worktree is lexically inside
    // the primary and the guard refuses all of them.
    assert.equal(landsInPrimary(path.join(primary, 'lib', 'a.js'), primary, [wt]), true);
    assert.equal(landsInPrimary(path.join(wt, 'lib', 'a.js'), primary, [wt]), false);
  });

  it('answers false for a path outside the primary entirely', () => {
    assert.equal(landsInPrimary(path.join(base, 'elsewhere.js'), primary, [wt]), false);
  });

  it('without allowRoot, a checkout root is not inside itself', () => {
    assert.equal(landsInPrimary(primary, primary, [wt]), false);
    assert.equal(landsInPrimary(wt, primary, [wt]), true);
  });

  it('with allowRoot, both roots answer for themselves', () => {
    // The pair that matters: the primary root must land IN the primary (a git
    // command run there is the case to refuse) and the worktree root must not
    // (that command is exactly where it belongs).
    assert.equal(landsInPrimary(primary, primary, [wt], { allowRoot: true }), true);
    assert.equal(landsInPrimary(wt, primary, [wt], { allowRoot: true }), false);
  });
});

describe('realOrSelf', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-real-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('resolves a path whose final component does not exist yet', () => {
    // The guard's targets are routinely about to be created; realpathSync alone
    // throws on them.
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
    assert.equal(realOrSelf(path.join(base, 'link', 'new.js')), path.join(base, 'real', 'new.js'));
  });

  it('resolves the final component when it IS a link', () => {
    fs.writeFileSync(path.join(base, 'target.js'), '');
    fs.symlinkSync(path.join(base, 'target.js'), path.join(base, 'alias.js'));
    assert.equal(realOrSelf(path.join(base, 'alias.js')), path.join(base, 'target.js'));
  });
});
