'use strict';

/*
 * What a wrap may commit (#1406), and where (#1469).
 *
 * Driven against real repositories: the defect was a real `git add -A` sweeping
 * real uncommitted work, and the fix leans on git's own pathspec and
 * `commit <pathspec>` semantics, which only a real git can confirm.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const ownership = require('../lib/wrap-steps/_file-ownership');
const sessionFiles = require('../lib/wrap-steps/session-files');
const commitStep = require('../lib/wrap-steps/commit');
const coverage = require('../lib/wrap-steps/changelog-coverage');
const launchBaseline = require('../lib/launch-baseline');
const wrapScope = require('../lib/wrap-scope');
const { execFileArgs } = require('../lib/wrap-steps/_exec-shell');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * Run git with a fixed identity.
 * @param {string} cwd - Repo directory.
 * @param {...string} args - Argv after `git`.
 * @returns {string} Trimmed stdout.
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
}

/**
 * `git status --porcelain`, untrimmed (a leading space is part of the status
 * code), without the `.tangleclaw/` directory the commit step writes its
 * last-wrap record into.
 * @param {string} cwd - Repo directory.
 * @returns {string}
 */
function porcelain(cwd) {
  return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
    .split('\n').filter((l) => l && !l.includes('.tangleclaw/')).join('\n');
}

/**
 * A repo on a feature branch with one commit and a local identity (the commit
 * step runs git without the test's env).
 * @returns {string} Repo path, symlinks resolved.
 */
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-own-')));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  fs.writeFileSync(path.join(dir, 'shared.js'), 'v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/session');
  return dir;
}

/** The argv runner the scope takes in production. */
const asyncExec = (file, args, opts) => execFileArgs(file, args, { cwd: opts.cwd, timeoutMs: 10000, maxBufferBytes: 1024 * 1024 });

/**
 * Resolve the real scope for a session launched at `baseline`, whose pane is at `paneCwd`.
 * @param {string} repo - Registered checkout.
 * @param {object|null} baseline - Launch baseline.
 * @param {string} [paneCwd] - Pane directory.
 * @returns {Promise<object>}
 */
function scopeFor(repo, baseline, paneCwd = repo) {
  return wrapScope.resolve({ name: 'own', path: repo }, { id: 1, tmuxSession: 'own', startedAt: '2000-01-01 00:00:00' }, {
    exec: asyncExec,
    paneCurrentPath: () => paneCwd,
    getLaunchBaseline: () => baseline
  });
}

/**
 * Run a step against the scoped project, as the pipeline would.
 * @param {object} step - Step module.
 * @param {string} repo - Registered checkout.
 * @param {object} scope - Scope.
 * @param {object} [options] - Run options.
 * @returns {Promise<object>}
 */
function runStep(step, repo, scope, options = {}) {
  return step.run({
    project: wrapScope.stepProject({ id: 1, name: 'own', path: repo }, scope),
    session: null,
    step: { id: step === commitStep ? 'commit' : 'session-files' },
    previousResults: [],
    staged: {},
    options,
    scope
  });
}

describe('the #1406 repro: work already uncommitted at launch is not swept into the wrap', () => {
  /**
   * The operator has uncommitted work in `shared.js` when the session launches;
   * the session then writes `mine.js`.
   * @returns {Promise<{repo:string, scope:object}>}
   */
  async function operatorWipThenSession() {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'shared.js'), 'operator half-finished edit\n');
    const baseline = launchBaseline.capture(repo);
    fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    return { repo, scope: await scopeFor(repo, baseline) };
  }

  it('session-files blocks and names the operator\'s file, and only that file', async () => {
    const { repo, scope } = await operatorWipThenSession();
    const r = await runStep(sessionFiles, repo, scope);
    assert.equal(r.status, 'blocked');
    assert.deepEqual(r.output.foreignPaths.map((f) => f.path), ['shared.js']);
    assert.match(r.output.foreignPaths[0].why, /already uncommitted when this session launched/);
    assert.match(r.output.remediation, /Leave never discards anything/);
  });

  it('the commit refuses to run without a decision, even if the earlier step was skipped', async () => {
    const { repo, scope } = await operatorWipThenSession();
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'blocked');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'nothing was committed');
  });

  it('Leave: the wrap commits the session\'s file and the operator\'s edit stays uncommitted', async () => {
    const { repo, scope } = await operatorWipThenSession();
    const options = { pathDecisions: { 'shared.js': 'leave' } };
    assert.equal((await runStep(sessionFiles, repo, scope, options)).status, 'done');
    const r = await runStep(commitStep, repo, scope, options);
    assert.equal(r.status, 'done');
    assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['mine.js']);
    assert.equal(fs.readFileSync(path.join(repo, 'shared.js'), 'utf8'), 'operator half-finished edit\n');
    assert.match(porcelain(repo), /^ M shared\.js$/m, 'still uncommitted, untouched');
  });

  it('Include: the operator\'s file goes into the wrap commit too', async () => {
    const { repo, scope } = await operatorWipThenSession();
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'shared.js': 'include' } });
    assert.equal(r.status, 'done');
    assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['mine.js', 'shared.js']);
    assert.equal(porcelain(repo), '', 'nothing of the session\'s or the operator\'s is left uncommitted');
  });

  it('a file the operator had already staged stays staged and out of the commit', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'staged-by-operator.js'), 'x\n');
    git(repo, 'add', 'staged-by-operator.js');
    const baseline = launchBaseline.capture(repo);
    fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    const scope = await scopeFor(repo, baseline);
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'staged-by-operator.js': 'leave' } });
    assert.equal(r.status, 'done');
    assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['mine.js']);
    assert.match(git(repo, 'status', '--porcelain'), /^A  staged-by-operator\.js$/m);
  });

  it('only every file left out means nothing to commit: a skip, not an empty commit', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'shared.js'), 'operator wip\n');
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'shared.js': 'leave' } });
    assert.equal(r.status, 'skipped');
    assert.deepEqual(r.output.left, ['shared.js']);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  });

  it('a path spelled like a glob is committed as that one file', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'a1.js'), 'operator\n');
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    fs.writeFileSync(path.join(repo, 'a*.js'), 'session\n');
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'a1.js': 'leave' } });
    assert.equal(r.status, 'done');
    assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['a*.js']);
  });

  it('a session deletion is committed', async () => {
    const repo = makeRepo();
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    fs.rmSync(path.join(repo, 'shared.js'));
    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'done');
    assert.match(git(repo, 'show', '--name-status', '--format=', 'HEAD'), /^D\tshared\.js$/m);
  });
});

describe('classify', () => {
  const scope = (over = {}) => ({
    snapshotApplies: true,
    baseline: { dirty: { paths: ['old.js'], truncated: false } },
    startedAtMs: 1000,
    workToplevel: '/repo',
    ...over
  });

  it('a decision is honored only for a path it calls foreign — "leave" cannot drop the session\'s own file', () => {
    const c = ownership.classify(scope(), [{ path: 'new.js', deleted: false }, { path: 'old.js', deleted: false }], {
      decisions: { 'new.js': 'leave', 'old.js': 'include', 'elsewhere.js': 'include' }
    });
    assert.deepEqual(c.stageable.sort(), ['new.js', 'old.js']);
    assert.deepEqual(c.left, []);
  });

  it('a file the wrap wrote is its own even when it was dirty at launch', () => {
    const c = ownership.classify(scope(), [{ path: 'old.js', deleted: false }], { wrapWritten: ['old.js'] });
    assert.deepEqual(c.owned, ['old.js']);
    assert.deepEqual(c.undecided, []);
  });

  it('with no usable snapshot, file time decides, and a deletion or unknown start is asked about', () => {
    const noSnap = scope({ snapshotApplies: false });
    const mtimeMs = (abs) => ({ '/repo/fresh.js': 1000, '/repo/stale.js': 999 }[abs] ?? null);
    const c = ownership.classify(noSnap, [
      { path: 'fresh.js', deleted: false },
      { path: 'stale.js', deleted: false },
      { path: 'gone.js', deleted: true }
    ], { mtimeMs });
    assert.deepEqual(c.owned, ['fresh.js']);
    assert.deepEqual(c.undecided.map((f) => [f.path, f.reason]), [['stale.js', 'predates-launch'], ['gone.js', 'unknown-deletion']]);
    const noStart = ownership.classify(scope({ snapshotApplies: false, startedAtMs: null }), [{ path: 'x.js', deleted: false }]);
    assert.equal(noStart.undecided[0].reason, 'unknown-start');
  });

  it('drops malformed decisions that arrived over HTTP', () => {
    assert.deepEqual(ownership.sanitizeDecisions({ 'a.js': 'include', 'b.js': 'commit-everything', '': 'leave', 'c.js': 7 }), { 'a.js': 'include' });
    assert.deepEqual(ownership.sanitizeDecisions(['a.js']), {});
    assert.deepEqual(ownership.sanitizeDecisions(null), {});
  });

  it('parses renames as the new path plus the old path deleted', () => {
    assert.deepEqual(ownership.parseStatus('R  new.js\0old.js\0?? u.js\0 D d.js\0'), [
      { path: 'new.js', deleted: false }, { path: 'old.js', deleted: true },
      { path: 'u.js', deleted: false }, { path: 'd.js', deleted: true }
    ]);
  });
});

describe('the changelog check judges only what the wrap will commit', () => {
  it('an operator source file that is left uncommitted is not unlogged session work', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'shared.js'), 'operator wip\n');
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    const judgedWithout = coverage.evaluate(repo, ['CHANGELOG.md'], [], { ...scope, baseline: { ...scope.baseline, sha: null } });
    assert.deepEqual(judgedWithout.uncommittedWork, [], 'undecided foreign work is not committed, so it is not judged');
    const included = coverage.evaluate(repo, ['CHANGELOG.md'], [], scope, { pathDecisions: { 'shared.js': 'include' } });
    assert.deepEqual(included.uncommittedWork, ['shared.js'], 'once included it will ship, so it needs an entry');
  });
});

describe('the #1469 repro: a session in a worktree wraps the worktree', () => {
  it('commits on the worktree\'s branch and leaves the registered checkout alone', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', 'main');
    // The generated guide TangleClaw rewrites at launch, uncommitted in the
    // registered checkout — the file #1469's wrap looped on.
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'regenerated guide\n');
    const baseline = launchBaseline.capture(repo);
    const wt = `${repo}-wt`;
    dirs.push(wt);
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/in-worktree', wt);
    fs.writeFileSync(path.join(wt, 'feature.js'), 'worktree work\n');

    const scope = await scopeFor(repo, baseline, wt);
    assert.equal(scope.worktreeTarget, true);
    const files = await runStep(sessionFiles, repo, scope);
    assert.equal(files.status, 'done', 'the checkout\'s CLAUDE.md is not this tree\'s concern');
    assert.match(files.output.detail, /Wrapping worktree/);

    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'done');
    assert.equal(r.output.branch, 'feat/in-worktree');
    assert.deepEqual(git(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['feature.js']);
    assert.match(git(repo, 'status', '--porcelain'), /CLAUDE\.md/, 'the registered checkout is untouched');
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  });
});
