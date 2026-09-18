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
const { execFileArgs } = require('../lib/exec');

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

  it('Leave on a dirty-at-launch CHANGELOG.md holds even when a wrap step flushes a rewrite of it', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changelog\n\noperator draft entry\n');
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    const r = await commitStep.run({
      project: wrapScope.stepProject({ id: 1, name: 'own', path: repo }, scope),
      session: null,
      step: { id: 'commit' },
      previousResults: [],
      // A whole-file rewrite staged the way version-bump stages its promotion.
      staged: { 'version-bump:changelog': { primingPath: path.join(repo, 'CHANGELOG.md'), newContent: '# Changelog\n\n## [1.0.0]\noperator draft entry\n', changed: true } },
      options: { pathDecisions: { 'CHANGELOG.md': 'leave' } },
      scope
    });
    assert.equal(r.status, 'done');
    assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['mine.js'],
      'the operator\'s draft is not committed under the wrap\'s rewrite');
    assert.match(porcelain(repo), /^\?\? CHANGELOG\.md$/m, 'still uncommitted, with the wrap\'s rewrite on disk');
  });

  it('in a worktree (no snapshot), Leave on a pre-session CHANGELOG.md holds through a version-bump rewrite', async () => {
    const repo = makeRepo();
    const wt = `${repo}-wt`;
    dirs.push(wt);
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/leave-wt', wt);
    fs.writeFileSync(path.join(wt, 'CHANGELOG.md'), '# Changelog\n\noperator draft\n');
    const old = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(path.join(wt, 'CHANGELOG.md'), old, old);
    const scope = await wrapScope.resolve({ name: 'own', path: repo }, { id: 1, tmuxSession: 'own', startedAt: '2020-01-01 00:00:00' }, {
      exec: asyncExec, paneCurrentPath: () => wt, getLaunchBaseline: () => launchBaseline.capture(repo)
    });
    assert.equal(scope.snapshotApplies, false, 'fixture precondition: the launch snapshot describes the checkout, not the worktree');
    fs.writeFileSync(path.join(wt, 'feature.js'), 'session work\n');
    const project = wrapScope.stepProject({ id: 1, name: 'own', path: repo }, scope);
    const options = { pathDecisions: { 'CHANGELOG.md': 'leave' } };
    const r = await commitStep.run({
      project, session: null, step: { id: 'commit' }, previousResults: [], options, scope,
      staged: { 'version-bump:changelog': { primingPath: path.join(wt, 'CHANGELOG.md'), newContent: '# Changelog\n\n## [1.0.0]\noperator draft\n', changed: true } }
    });
    assert.equal(r.status, 'done');
    assert.deepEqual(git(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['feature.js']);
  });

  it('a wrap during an unfinished merge stops with a merge-specific reason and commits nothing', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'shared.js'), 'main side\n');
    git(repo, 'commit', '-q', '-am', 'main change');
    git(repo, 'checkout', '-q', 'feat/session');
    fs.writeFileSync(path.join(repo, 'shared.js'), 'branch side\n');
    git(repo, 'commit', '-q', '-am', 'branch change');
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    try { git(repo, 'merge', 'main'); } catch { /* conflict expected */ }
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'shared.js': 'include' } });
    assert.equal(r.status, 'blocked');
    assert.match(r.blockers[0], /merge is in progress/);
    assert.match(r.output.remediation, /git merge --abort/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
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

  it('a file dirty at launch stays the operator\'s call even after the wrap rewrites it, and Leave keeps it out', () => {
    const asked = ownership.classify(scope(), [{ path: 'old.js', deleted: false }], { wrapWritten: ['old.js'] });
    assert.deepEqual(asked.undecided.map((f) => f.path), ['old.js']);
    const left = ownership.classify(scope(), [{ path: 'old.js', deleted: false }], {
      wrapWritten: ['old.js'], decisions: { 'old.js': 'leave' }
    });
    assert.deepEqual(left.stageable, []);
    assert.deepEqual(left.left, ['old.js']);
  });

  it('with no snapshot, a Leave already given still wins after a wrap step rewrites the file', () => {
    const noSnap = scope({ snapshotApplies: false });
    // Before the wrap wrote it, the file predated the session, so the operator was asked.
    const asked = ownership.classify(noSnap, [{ path: 'CHANGELOG.md', deleted: false }], { mtimeMs: () => 1 });
    assert.equal(asked.undecided[0].reason, 'predates-launch');
    // After version-bump's rewrite, its file time is the wrap's; the answer must still hold.
    const after = ownership.classify(noSnap, [{ path: 'CHANGELOG.md', deleted: false }], {
      wrapWritten: ['CHANGELOG.md'], decisions: { 'CHANGELOG.md': 'leave' }, mtimeMs: () => 5000
    });
    assert.deepEqual(after.stageable, []);
    assert.deepEqual(after.left, ['CHANGELOG.md']);
  });

  it('with no snapshot, a file the wrap wrote is its own, and an unreadable time is named as such', () => {
    const noSnap = scope({ snapshotApplies: false });
    const mtimeMs = () => null;
    const c = ownership.classify(noSnap, [{ path: 'written.js', deleted: false }, { path: 'vanished.js', deleted: false }], {
      wrapWritten: ['written.js'], mtimeMs
    });
    assert.deepEqual(c.owned, ['written.js']);
    assert.deepEqual(c.undecided.map((f) => [f.path, f.reason]), [['vanished.js', 'unreadable-time']]);
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

  it('TangleClaw machine state is named among the files the wrap will not commit', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'session-prime.md'), 'prime\n');
    fs.writeFileSync(path.join(repo, 'shared.js'), 'operator wip\n');
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    assert.deepEqual([...coverage._excludedFromCommit(repo, scope, {})].sort(), ['.tangleclaw/session-prime.md', 'shared.js']);
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

describe('#1508/#1509: TangleClaw\'s own files dirty at launch are not asked about on every wrap', () => {
  const engines = require('../lib/engines');
  const MD = engines._managedBlockMarkers('markdown');
  const guide = (body, operator = 'Operator notes.\n') => `# Project\n\n${operator}\n${MD.begin}\n${body}\n${MD.end}\n`;
  // The committed copy still carries the retired `lastWrapSha`; TangleClaw's
  // migration removes it before the session launches (#1510).
  const config = (sha) => `${JSON.stringify(sha ? { engine: 'claude', lastWrapSha: sha } : { engine: 'claude' }, null, 2)}\n`;

  /**
   * A project that tracks its engine config, project.json and a state file, where
   * TangleClaw rewrote all three before the session launched — the state every
   * later wrap used to ask about — and the session then wrote `mine.js`.
   * @param {object} [opts]
   * @param {string} [opts.operatorLine] - Also add this line outside the managed block.
   * @param {boolean} [opts.sessionWork=true] - Whether the session writes `mine.js`.
   * @returns {Promise<{repo:string, scope:object}>}
   */
  async function tangleclawWritesThenSession({ operatorLine = null, sessionWork = true } = {}) {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), guide('guide v1'));
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'project.json'), config('aaa'));
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'session-prime.md'), 'prime v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'tracked tangleclaw files');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), guide('guide v2', operatorLine ? `Operator notes.\n${operatorLine}\n` : 'Operator notes.\n'));
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'project.json'), config(null));
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'session-prime.md'), 'prime v2\n');
    const baseline = launchBaseline.capture(repo);
    if (sessionWork) fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    return { repo, scope: await scopeFor(repo, baseline) };
  }

  it('session-files and commit agree: maintenance is committed by name, state is left, nothing is asked', async () => {
    const { repo, scope } = await tangleclawWritesThenSession();
    assert.equal(scope.snapshotApplies, true, 'fixture precondition: the files are dirty at launch per the snapshot');

    // session-prime.md is tracked, so the one-time un-track offer (#1512) asks first;
    // keeping it tracked is the answer that leaves this test's subject unchanged.
    const asked = await runStep(sessionFiles, repo, scope);
    assert.equal(asked.status, 'needs-operator');
    assert.deepEqual(asked.output.untrackOffer.paths, ['.tangleclaw/session-prime.md']);
    const keep = { untrackState: 'decline' };

    const files = await runStep(sessionFiles, repo, scope, keep);
    assert.equal(files.status, 'done', files.blockers.join('; '));
    assert.deepEqual(files.output.tangleclawMaintenance.sort(), ['.tangleclaw/project.json', 'CLAUDE.md']);
    assert.deepEqual(files.output.tangleclawState, ['.tangleclaw/session-prime.md']);
    assert.match(files.output.detail, /2 TangleClaw updates to commit · 1 TangleClaw state file not committed/);

    const r = await runStep(commitStep, repo, scope, keep);
    assert.equal(r.status, 'done');
    assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.tangleclaw/project.json', 'CLAUDE.md', 'mine.js']);
    assert.match(r.output.message, /^- TangleClaw maintenance \(changed only where TangleClaw writes\): .*CLAUDE\.md/m);
    assert.deepEqual(r.output.tangleclawMaintenance.sort(), ['.tangleclaw/project.json', 'CLAUDE.md']);
    assert.equal(fs.readFileSync(path.join(repo, '.tangleclaw', 'session-prime.md'), 'utf8'), 'prime v2\n');
    assert.equal(git(repo, 'status', '--porcelain', '--', '.tangleclaw/session-prime.md'), 'M .tangleclaw/session-prime.md', 'state stays uncommitted');
  });

  it('a project upgraded with an old boundary stamp dirty at launch is not asked about it (#1510)', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'project.json'), config('aaa'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'tracked project.json');
    // The last wrap before the upgrade stamped a new boundary into the tracked file.
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'project.json'), config('bbb'));
    const baseline = launchBaseline.capture(repo);
    fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    const scope = await scopeFor(repo, baseline);
    assert.equal(scope.snapshotApplies, true, 'fixture precondition: project.json is dirty at launch per the snapshot');

    const files = await runStep(sessionFiles, repo, scope);
    assert.equal(files.status, 'done', files.blockers.join('; '));
    assert.deepEqual(files.output.tangleclawState, ['.tangleclaw/project.json']);
  });

  it('one operator line outside the managed block still asks, exactly as before', async () => {
    const { repo, scope } = await tangleclawWritesThenSession({ operatorLine: 'My own line.' });
    const files = await runStep(sessionFiles, repo, scope);
    assert.equal(files.status, 'blocked');
    assert.deepEqual(files.output.foreignPaths.map((f) => f.path), ['CLAUDE.md']);
    const head = git(repo, 'rev-parse', 'HEAD');
    assert.equal((await runStep(commitStep, repo, scope)).status, 'blocked');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'nothing was committed');
  });

  it('the changelog check does not demand an entry for TangleClaw maintenance', async () => {
    const { repo, scope } = await tangleclawWritesThenSession({ sessionWork: false });
    // The session made no commits, so the range from its launch SHA is empty and
    // only the uncommitted tree is judged.
    const judged = coverage.evaluate(repo, ['CHANGELOG.md'], [], scope);
    assert.deepEqual(judged.uncommittedWork, [], 'a managed-block refresh is not the session\'s unlogged work');
    assert.equal(judged.verdict, coverage.VERDICTS.COVERED);
  });

  it('a tree dirty only with TangleClaw state skips the commit and says why', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.tangleclaw', 'continuity'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'continuity', 'index.md'), 'v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'tracked continuity');
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'continuity', 'index.md'), 'v2\n');
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    const head = git(repo, 'rev-parse', 'HEAD');
    const keep = { untrackState: 'decline' };
    assert.equal((await runStep(sessionFiles, repo, scope, keep)).status, 'done');
    const r = await runStep(commitStep, repo, scope, keep);
    assert.equal(r.status, 'skipped');
    assert.match(r.output.reason, /only uncommitted files are TangleClaw state/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  });
});

describe('#1512: the one-time offer to stop tracking TangleClaw state', () => {
  const wrapState = require('../lib/wrap-state');

  /**
   * A project that committed two state files, an authored plan, and the operator's
   * own staged work; TangleClaw then rewrote a state file and the session wrote `mine.js`.
   * @returns {Promise<{repo:string, scope:object}>}
   */
  async function trackedStateProject() {
    const repo = makeRepo();
    for (const [rel, text] of [['.tangleclaw/medusa/registry.json', '{}\n'], ['.tangleclaw/session-prime.md', 'p1\n'], ['.tangleclaw/plans/a.md', 'plan\n']]) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text);
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'tracked state');
    fs.writeFileSync(path.join(repo, 'shared.js'), 'operator staged\n');
    git(repo, 'add', 'shared.js');
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'session-prime.md'), 'p2\n');
    const baseline = launchBaseline.capture(repo);
    fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    return { repo, scope: await scopeFor(repo, baseline) };
  }

  it('asks once, naming exactly the tracked state paths, and never an authored file', async () => {
    const { repo, scope } = await trackedStateProject();
    const r = await runStep(sessionFiles, repo, scope, { pathDecisions: { 'shared.js': 'leave' } });
    assert.equal(r.status, 'needs-operator');
    assert.deepEqual(r.output.untrackOffer.paths, ['.tangleclaw/medusa/registry.json', '.tangleclaw/session-prime.md']);
    assert.match(r.blockers[0], /2 TangleClaw state files are tracked by git/);
    assert.match(r.output.remediation, /git rm --cached/);
  });

  it('an Include / Leave question comes first; the offer waits until those are settled', async () => {
    const { repo, scope } = await trackedStateProject();
    const r = await runStep(sessionFiles, repo, scope);
    assert.equal(r.status, 'blocked');
    assert.ok(Array.isArray(r.output.foreignPaths));
    assert.equal(r.output.untrackOffer, undefined);
  });

  it('approve: the wrap commit removes exactly those paths from tracking, the files stay, the operator\'s staged work stays out', async () => {
    const { repo, scope } = await trackedStateProject();
    const options = { pathDecisions: { 'shared.js': 'leave' }, untrackState: 'approve' };
    const files = await runStep(sessionFiles, repo, scope, options);
    assert.equal(files.status, 'done', files.blockers.join('; '));
    assert.match(files.output.detail, /2 TangleClaw state files to stop tracking/);

    const r = await runStep(commitStep, repo, scope, options);
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(r.output.untrackState, ['.tangleclaw/medusa/registry.json', '.tangleclaw/session-prime.md']);
    const changed = git(repo, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort();
    assert.deepEqual(changed, ['A\tmine.js', 'D\t.tangleclaw/medusa/registry.json', 'D\t.tangleclaw/session-prime.md']);
    assert.match(r.output.message, /^- Stopped tracking TangleClaw state \(the files stay on disk\): \.tangleclaw\/medusa\/registry\.json, \.tangleclaw\/session-prime\.md$/m);
    assert.equal(fs.readFileSync(path.join(repo, '.tangleclaw', 'session-prime.md'), 'utf8'), 'p2\n', 'the file stays on disk');
    assert.deepEqual(git(repo, 'ls-files', '--', '.tangleclaw').split('\n'), ['.tangleclaw/plans/a.md'], 'authored content stays tracked');
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'shared.js', 'the operator\'s staged work is still staged, and not committed');
  });

  it('approve with nothing else to commit still makes the un-track commit, and stages nothing else', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.tangleclaw', 'medusa'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'medusa', 'registry.json'), '{}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'tracked registry');
    fs.writeFileSync(path.join(repo, 'untracked-operator.txt'), 'not mine to commit\n');
    const baseline = launchBaseline.capture(repo);
    const scope = await scopeFor(repo, baseline);
    const options = { pathDecisions: { 'untracked-operator.txt': 'leave' }, untrackState: 'approve' };
    assert.equal((await runStep(sessionFiles, repo, scope, options)).status, 'done');
    const r = await runStep(commitStep, repo, scope, options);
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(git(repo, 'show', '--name-status', '--format=', 'HEAD').split('\n'), ['D\t.tangleclaw/medusa/registry.json']);
    assert.match(git(repo, 'status', '--porcelain'), /\?\? untracked-operator\.txt/);
  });

  it('approve on an otherwise clean tree (the state file unchanged) still removes it from tracking', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.tangleclaw', 'medusa'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'medusa', 'registry.json'), '{}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'tracked registry');
    assert.equal(git(repo, 'status', '--porcelain'), '', 'fixture precondition: nothing is dirty');
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    const options = { untrackState: 'approve' };
    const files = await runStep(sessionFiles, repo, scope, options);
    assert.equal(files.status, 'done');
    const r = await runStep(commitStep, repo, scope, options);
    assert.equal(r.status, 'done', r.output && r.output.reason);
    assert.deepEqual(git(repo, 'show', '--name-status', '--format=', 'HEAD').split('\n'), ['D\t.tangleclaw/medusa/registry.json']);
    assert.equal(git(repo, 'ls-files', '--', '.tangleclaw'), '');
  });

  it('commit removes only the paths session-files showed, not one tracked after it asked', async () => {
    const { repo, scope } = await trackedStateProject();
    const options = { pathDecisions: { 'shared.js': 'leave' }, untrackState: 'approve' };
    const files = await runStep(sessionFiles, repo, scope, options);
    assert.deepEqual(files.output.untrackState, ['.tangleclaw/medusa/registry.json', '.tangleclaw/session-prime.md']);
    // A state file becomes tracked between the question and the commit.
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'critic-runs.json'), '[]\n');
    git(repo, 'add', '.tangleclaw/critic-runs.json');
    git(repo, 'commit', '-q', '-m', 'tracked late', '--', '.tangleclaw/critic-runs.json');
    const r = await commitStep.run({
      project: wrapScope.stepProject({ id: 1, name: 'own', path: repo }, scope),
      session: null,
      step: { id: 'commit' },
      previousResults: [{ stepId: 'session-files', status: 'done', output: files.output }],
      staged: {},
      options,
      scope
    });
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(r.output.untrackState, ['.tangleclaw/medusa/registry.json', '.tangleclaw/session-prime.md']);
    assert.equal(git(repo, 'ls-files', '--', '.tangleclaw/critic-runs.json'), '.tangleclaw/critic-runs.json', 'never shown, so never removed');
  });

  it('decline over an unreadable state file is not remembered, and the unreadable boundary stays unreadable', async () => {
    const { repo, scope } = await trackedStateProject();
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'state.json'), '{ corrupt');
    const r = await runStep(sessionFiles, repo, scope, { pathDecisions: { 'shared.js': 'leave' }, untrackState: 'decline' });
    assert.equal(r.status, 'done');
    assert.equal(fs.readFileSync(path.join(repo, '.tangleclaw', 'state.json'), 'utf8'), '{ corrupt');
    assert.equal(wrapState.readLastWrapSha(repo).read, 'unreadable');
  });

  it('decline is remembered, so the next wrap does not ask; a newly tracked state path is offered again', async () => {
    const { repo, scope } = await trackedStateProject();
    const declined = await runStep(sessionFiles, repo, scope, { pathDecisions: { 'shared.js': 'leave' }, untrackState: 'decline' });
    assert.equal(declined.status, 'done');
    assert.match(declined.output.detail, /kept 2 TangleClaw state files tracked, as you chose/);
    assert.deepEqual(wrapState.readUntrackDeclined(repo), ['.tangleclaw/medusa/registry.json', '.tangleclaw/session-prime.md']);

    const next = await runStep(sessionFiles, repo, scope, { pathDecisions: { 'shared.js': 'leave' } });
    assert.equal(next.status, 'done', 'a remembered decline is not asked again');

    fs.writeFileSync(path.join(repo, '.tangleclaw', 'critic-runs.json'), '[]\n');
    git(repo, 'add', '.tangleclaw/critic-runs.json');
    git(repo, 'commit', '-q', '-m', 'tracked another', '--', '.tangleclaw/critic-runs.json');
    const again = await runStep(sessionFiles, repo, scope, { pathDecisions: { 'shared.js': 'leave' } });
    assert.equal(again.status, 'needs-operator');
    assert.deepEqual(again.output.untrackOffer.paths, ['.tangleclaw/critic-runs.json']);
  });

  it('commit removes nothing without an approval, even when state is tracked', async () => {
    const { repo, scope } = await trackedStateProject();
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'shared.js': 'leave' } });
    assert.equal(r.status, 'done');
    assert.deepEqual(r.output.untrackState, []);
    assert.equal(git(repo, 'ls-files', '--', '.tangleclaw/medusa/registry.json'), '.tangleclaw/medusa/registry.json');
  });

  it('an unrecognised answer is no answer', async () => {
    const { repo, scope } = await trackedStateProject();
    const r = await runStep(sessionFiles, repo, scope, { pathDecisions: { 'shared.js': 'leave' }, untrackState: 'yes' });
    assert.equal(r.status, 'needs-operator');
  });

  it('a failed un-track preparation commits nothing and names the git step', async () => {
    const orig = commitStep._internal.exec;
    const { repo, scope } = await trackedStateProject();
    commitStep._internal.exec = (file, args, opts) => (args[0] === 'read-tree'
      ? Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: bad tree' })
      : orig(file, args, opts));
    try {
      const head = git(repo, 'rev-parse', 'HEAD');
      const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'shared.js': 'leave' }, untrackState: 'approve' });
      assert.equal(r.status, 'blocked');
      assert.match(r.blockers[0], /preparing the commit \(git read-tree\) failed, so nothing was committed/);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    } finally {
      commitStep._internal.exec = orig;
    }
  });
});

describe('#1619 — an identity-carrying carrier is asked about, not staged', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const tcOwned = require('../lib/wrap-steps/_tc-owned-paths');

  const MARK = { begin: '<!-- BEGIN:tangleclaw -->', end: '<!-- END:tangleclaw -->' };
  const carrier = (body) => `# Project\n\nOperator notes.\n\n${MARK.begin}\n${body}\n${MARK.end}\n`;

  /**
   * A repo whose CLAUDE.md is committed with `head` and then rewritten to
   * `work` — the shape the running server produces mid-session.
   * @param {string} head
   * @param {string} work
   * @returns {string} repo root
   */
  function repoWithCarrier(head, work) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-own-id-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), carrier(head));
    execFileSync('git', ['-C', dir, 'add', 'CLAUDE.md']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed']);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), carrier(work));
    return dir;
  }

  // The dominant case, and the one the fix is named for: the carrier was clean
  // at launch and the running server regenerated it DURING the session, so its
  // mtime is this session's. Before the refusal reached this decision, `judge`
  // returning `{kind: null}` only moved the file from `tangleclawMaintenance`
  // to `owned` — and `stageableOf` stages both. The guard changed which bucket
  // it was staged from, and nothing else.
  const scopeFor = (root) => ({
    snapshotApplies: true,
    baseline: { dirty: { paths: [], truncated: false } },
    startedAtMs: 1000,
    workToplevel: root
  });

  it('is NOT stageable, and is surfaced with a reason the operator can act on', () => {
    const root = repoWithCarrier(
      'Routes: `<api>/api/sessions/<project-name>/medusa/send` — resolve at run time.',
      '**TangleClaw API base URL**: `http://localhost:3102`'
    );
    const dirty = [{ path: 'CLAUDE.md', deleted: false }];
    const c = ownership.classify(scopeFor(root), dirty, {});

    assert.ok(!c.stageable.includes('CLAUDE.md'),
      'a block carrying an origin must not be staged, from any bucket');
    assert.ok(!c.tangleclawMaintenance.includes('CLAUDE.md'));
    assert.ok(!c.owned.includes('CLAUDE.md'),
      'and must not fall through to owned, which is where it used to land');
    const asked = c.foreign.find((f) => f.path === 'CLAUDE.md');
    assert.ok(asked, 'it must reach the operator');
    assert.equal(asked.reason, 'carries-identity');
    assert.match(asked.why, /must not be committed/);
  });

  it('an ordinary regenerated block is still staged silently', () => {
    // The other half. If this fires, every wrap becomes a question.
    const root = repoWithCarrier(
      'Routes: `<api>/api/sessions/<project-name>/medusa/send` — old wording.',
      'Routes: `<api>/api/sessions/<project-name>/medusa/send` — resolve at run time.'
    );
    const c = ownership.classify(scopeFor(root), [{ path: 'CLAUDE.md', deleted: false }], {});
    assert.ok(c.stageable.includes('CLAUDE.md'), 'an ordinary block refresh must still stage without asking');
    assert.ok(c.tangleclawMaintenance.includes('CLAUDE.md'));
    assert.ok(!c.foreign.some((f) => f.path === 'CLAUDE.md'));
  });

  it('judge reports the refusal so the ownership rules can act on it', () => {
    const root = repoWithCarrier('neutral', 'inbox `GET http://h/api/sessions/TangleClaw-Builder1/medusa/messages`');
    const verdicts = tcOwned.judge(root, [{ path: 'CLAUDE.md', deleted: false }]);
    assert.equal(verdicts.has('CLAUDE.md'), false, 'still not maintenance');
    assert.ok(verdicts.identityRefusals.has('CLAUDE.md'), 'and the reason survives the call');
    assert.match(verdicts.identityRefusals.get('CLAUDE.md'), /session route|origin|token/);
  });
});

describe('#1619 — the refusal survives every route into a null verdict', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');

  const MARK = { begin: '<!-- BEGIN:tangleclaw -->', end: '<!-- END:tangleclaw -->' };
  const carrier = (body, prose = 'Operator notes.') =>
    `# Project\n\n${prose}\n\n${MARK.begin}\n${body}\n${MARK.end}\n`;
  const IDENTITY = '**TangleClaw API base URL**: `http://localhost:3102`';
  const NEUTRAL = 'Routes: `<api>/api/sessions/<project-name>/medusa/send` — resolve at run time.';

  const scopeFor = (root) => ({
    snapshotApplies: true,
    baseline: { dirty: { paths: [], truncated: false } },
    startedAtMs: 1000,
    workToplevel: root
  });

  /**
   * @param {string|null} head - committed carrier body, or null to leave the file untracked
   * @param {string} workFile - the work-tree carrier content
   * @returns {string} repo root
   */
  function repo(head, workFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-route-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    if (head !== null) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), carrier(head));
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed']);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), workFile);
    return dir;
  }

  it('a COMPOUND change — block acquires identity while the operator edits their own prose', () => {
    // The route the previous fix missed. `differsOnlyInsideManagedBlock` returns
    // false, the carrier branch returned a bare null, and a bare null falls
    // through to the mtime rule and is staged from `owned`. Nothing exotic: an
    // operator editing the top of their own CLAUDE.md in the session the server
    // regenerated the block underneath them.
    const root = repo(NEUTRAL, carrier(IDENTITY, 'Operator notes, with a line the operator added.'));
    const c = ownership.classify(scopeFor(root), [{ path: 'CLAUDE.md', deleted: false }], {});
    assert.ok(!c.stageable.includes('CLAUDE.md'), 'a compound change must not stage an identity-carrying block');
    assert.ok(!c.owned.includes('CLAUDE.md'));
    assert.equal(c.foreign.find((f) => f.path === 'CLAUDE.md').reason, 'carries-identity');
  });

  it('a carrier with NO HEAD copy — newly tracked this session', () => {
    // Generation had classified it private (it was ignored) and wrote an origin
    // into it; tracking it now means `git show HEAD:CLAUDE.md` has nothing to
    // show, so the comparison throws before anything reads the file.
    const root = repo(null, carrier(IDENTITY));
    const c = ownership.classify(scopeFor(root), [{ path: 'CLAUDE.md', deleted: false }], {});
    assert.ok(!c.stageable.includes('CLAUDE.md'), 'no HEAD copy is not a reason to stage identity');
    assert.equal(c.foreign.find((f) => f.path === 'CLAUDE.md').reason, 'carries-identity');
  });

  it('a compound change with a NEUTRAL block still stages, as the session\'s own file', () => {
    // The counter-case, kept adjacent on purpose: widening the refusal must not
    // turn an ordinary edit into a question. The operator changed their own
    // prose this session, so the file is theirs and is staged — which is the
    // behaviour that existed before this guard and must survive it.
    const root = repo(NEUTRAL, carrier(NEUTRAL, 'Operator notes, edited.'));
    const c = ownership.classify(scopeFor(root), [{ path: 'CLAUDE.md', deleted: false }], {});
    assert.ok(c.stageable.includes('CLAUDE.md'), 'an ordinary compound edit must still stage');
    assert.ok(c.owned.includes('CLAUDE.md'), 'as the session\'s own file');
    assert.ok(!c.foreign.some((f) => f.path === 'CLAUDE.md'),
      'and the operator is not asked about their own edit');
  });
});
