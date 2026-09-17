'use strict';

/*
 * Session range and work-tree scope (#1309, #1450, #1469).
 *
 * Every case here builds a REAL repository, because the defects were all about
 * the shape real history takes: a branch that pulls the trunk mid-session, PR
 * merges on a trunk checkout, a coordinator committing into the same clone, and a
 * session whose pane sits in a `git worktree`. A stubbed git would only restate
 * the model these fixes replace.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const gitRange = require('../lib/wrap-steps/_git-range');
const coverage = require('../lib/wrap-steps/changelog-coverage');
const featuresToc = require('../lib/wrap-steps/features-toc');
const continuityWrite = require('../lib/wrap-steps/continuity-write');
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
 * Write a file and commit it.
 * @param {string} cwd - Repo directory.
 * @param {string} rel - Path to write.
 * @param {string} message - Commit subject.
 * @returns {string} The new HEAD sha.
 */
function commitFile(cwd, rel, message) {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), `${message}\n`);
  git(cwd, 'add', '--', rel);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * A repo on `main` with one root commit.
 * @returns {string} Repo path (symlinks resolved).
 */
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scope-')));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  commitFile(dir, 'README.md', 'init');
  return dir;
}

/** The argv runner the async twins take in production. */
const asyncExec = (file, args, opts) => execFileArgs(file, args, { cwd: opts.cwd, timeoutMs: 10000, maxBufferBytes: 5 * 1024 * 1024 });

describe('the range opens at the later of launch and a wrap inside the session', () => {
  it('takes the launch sha over an OLDER recorded wrap boundary (#1309)', () => {
    const repo = makeRepo();
    const oldWrap = commitFile(repo, 'a.js', 'another session');
    const launch = commitFile(repo, 'b.js', 'also before launch');
    commitFile(repo, 'c.js', 'this session');
    const r = gitRange.resolveSessionRange(repo, oldWrap, { dots: 'two', launchSha: launch });
    assert.equal(r.kind, 'launch');
    assert.equal(r.range, `${launch}..HEAD`);
  });

  it('takes a recorded boundary that is LATER than the launch — a wrap already ran in this session', () => {
    const repo = makeRepo();
    const launch = commitFile(repo, 'a.js', 'session part one');
    const midWrap = commitFile(repo, 'b.js', 'Session wrap');
    commitFile(repo, 'c.js', 'session part two');
    const r = gitRange.resolveSessionRange(repo, midWrap, { dots: 'two', launchSha: launch });
    assert.equal(r.kind, 'session');
    assert.equal(r.base, midWrap);
  });

  it('uses the recorded boundary when the launch sha is not on HEAD\'s history, and the trunk when neither is', () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'side');
    const offHistory = commitFile(repo, 'side.js', 'side');
    git(repo, 'checkout', '-q', 'main');
    const recorded = commitFile(repo, 'a.js', 'recorded');
    commitFile(repo, 'b.js', 'work');
    assert.equal(gitRange.resolveSessionRange(repo, recorded, { dots: 'two', launchSha: offHistory }).kind, 'session');
    git(repo, 'checkout', '-q', '-b', 'feat');
    const r = gitRange.resolveSessionRange(repo, null, { dots: 'two', launchSha: offHistory });
    assert.equal(r.kind, 'branch');
  });

  it('the sync and async resolvers agree with a launch sha in play', async () => {
    const repo = makeRepo();
    const oldWrap = commitFile(repo, 'a.js', 'a');
    const launch = commitFile(repo, 'b.js', 'b');
    commitFile(repo, 'c.js', 'c');
    for (const [recorded, launchSha] of [[oldWrap, launch], [launch, oldWrap], [null, launch], [oldWrap, null], ['deadbee', launch]]) {
      const sync = gitRange.resolveSessionRange(repo, recorded, { launchSha });
      const asyncR = await gitRange.resolveSessionRangeAsync(repo, recorded, { launchSha, exec: asyncExec });
      assert.deepEqual(asyncR, sync, `disagree on recorded=${recorded} launch=${launchSha}`);
    }
  });
});

describe('the first-parent walk ignores a trunk merged into the session\'s branch', () => {
  /**
   * Launch on `feat`, do work, pull main (which moved with another session's
   * commit), do more work.
   * @returns {{repo:string, launch:string}}
   */
  function branchWithTrunkSync() {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'feat');
    const launch = git(repo, 'rev-parse', 'HEAD');
    commitFile(repo, 'lib/mine-1.js', 'my first change');
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'lib/theirs.js', 'another session merged this');
    git(repo, 'checkout', '-q', 'feat');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge branch main into feat', 'main');
    commitFile(repo, 'lib/mine-2.js', 'my second change');
    return { repo, launch };
  }

  it('marks the sync merge and keeps its paths out of the session\'s net change', () => {
    const { repo, launch } = branchWithTrunkSync();
    const commits = gitRange.listSessionCommits(repo, `${launch}..HEAD`);
    const merge = commits.find((c) => c.isMerge);
    assert.equal(merge.trunkSync, true);
    assert.equal(commits.some((c) => c.subject === 'another session merged this'), false,
      'the second parent\'s commits are never listed');
    const net = gitRange.netChanges(commits);
    assert.deepEqual(net.touched.sort(), ['lib/mine-1.js', 'lib/mine-2.js']);
  });

  it('features-toc stubs only this session\'s files, where a plain diff would add the trunk\'s (#1309 repro)', () => {
    const { repo, launch } = branchWithTrunkSync();
    const plainDiff = git(repo, 'diff', '--name-only', `${launch}..HEAD`).split('\n');
    assert.ok(plainDiff.includes('lib/theirs.js'), 'fixture precondition: the old diff carries the other session\'s file');
    const touched = featuresToc._sessionTouchedFiles(repo, `${launch}..HEAD`);
    assert.deepEqual(touched.sort(), ['lib/mine-1.js', 'lib/mine-2.js']);
  });

  it('changelog coverage does not judge the trunk\'s commits, so they cannot block the wrap', () => {
    const { repo, launch } = branchWithTrunkSync();
    const scope = { lastWrapSha: null, baseline: { sha: launch }, trunk: undefined };
    const out = coverage.evaluate(repo, ['CHANGELOG.md'], [], scope);
    assert.equal(out.verdict, coverage.VERDICTS.UNCOVERED);
    const subjects = out.uncovered.map((c) => c.subject).sort();
    assert.deepEqual(subjects, ['my first change', 'my second change'],
      'only this session\'s commits are named, never the merge or the trunk commit behind it');
  });

  it('the async walk agrees with the sync walk', async () => {
    const { repo, launch } = branchWithTrunkSync();
    const sync = gitRange.listSessionCommits(repo, `${launch}..HEAD`);
    const asyncC = await gitRange.listSessionCommitsAsync(repo, `${launch}..HEAD`, { exec: asyncExec });
    assert.deepEqual(asyncC, sync);
  });

  it('continuity-write records only the session\'s files through the same walk', async () => {
    const { repo, launch } = branchWithTrunkSync();
    const delta = await continuityWrite._sessionDelta(repo, { launchSha: launch });
    assert.equal(delta.kind, 'session');
    assert.deepEqual(delta.touched.sort(), ['lib/mine-1.js', 'lib/mine-2.js']);
  });
});

describe('on a trunk checkout a PR merge counts, with what it brought in', () => {
  it('lists the merge with its first-parent paths and does not mark it a sync', () => {
    const repo = makeRepo();
    const launch = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'feat/x');
    commitFile(repo, 'lib/feature.js', 'feature work');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from feat/x', 'feat/x');
    const commits = gitRange.listSessionCommits(repo, `${launch}..HEAD`);
    assert.equal(commits.length, 1, 'first-parent: the merge alone stands for the PR');
    assert.equal(commits[0].trunkSync, false);
    assert.deepEqual(commits[0].files, ['lib/feature.js']);
  });
});

describe('a first wrap measures from the launch, not the trunk divergence (#1450 repro)', () => {
  it('a coordinator\'s commits made before launch are outside the range', () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'feat');
    commitFile(repo, 'results/a.md', 'coordinator results');
    commitFile(repo, 'curriculum/b.md', 'coordinator curriculum');
    const launch = git(repo, 'rev-parse', 'HEAD');
    commitFile(repo, 'memo.md', 'session bridge memo');
    const withoutBaseline = coverage.evaluate(repo, ['CHANGELOG.md'], [], { lastWrapSha: null, baseline: null });
    assert.equal(withoutBaseline.uncovered.length, 3, 'fixture precondition: the fallback range judges the coordinator too');
    const withBaseline = coverage.evaluate(repo, ['CHANGELOG.md'], [], { lastWrapSha: null, baseline: { sha: launch } });
    assert.deepEqual(withBaseline.uncovered.map((c) => c.subject), ['session bridge memo']);
  });
});

describe('wrap-scope picks the tree the session\'s pane is in (#1469)', () => {
  const noopDeps = (paneCwd) => ({ exec: asyncExec, paneCurrentPath: () => paneCwd });

  it('targets a worktree of the same repository and keeps config in the registered checkout', async () => {
    const repo = makeRepo();
    const wt = `${repo}-wt`;
    dirs.push(wt);
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/wt', wt);
    const project = { name: 'p', path: repo };
    const session = { id: 1, tmuxSession: 'p', startedAt: '2026-09-14 10:00:00' };
    const scope = await wrapScope.resolve(project, session, { ...noopDeps(path.join(wt)), getLaunchBaseline: () => null });
    assert.equal(scope.worktreeTarget, true);
    assert.equal(scope.workTree, fs.realpathSync(wt));
    assert.equal(scope.configRoot, repo);
    const stepProject = wrapScope.stepProject(project, scope);
    assert.equal(stepProject.path, fs.realpathSync(wt));
    assert.equal(stepProject.configPath, repo);
  });

  it('reads the wrap boundary from the registered checkout\'s state file on a worktree wrap (#1510)', async () => {
    const wrapState = require('../lib/wrap-state');
    const repo = makeRepo();
    const boundary = git(repo, 'rev-parse', 'HEAD');
    wrapState.stampLastWrapSha(repo, boundary);
    const wt = `${repo}-wt`;
    dirs.push(wt);
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/wt-boundary', wt);
    assert.equal(fs.existsSync(path.join(wt, '.tangleclaw', 'state.json')), false, 'fixture precondition: the worktree has no state file');
    const project = { name: 'p', path: repo };
    const session = { id: 1, tmuxSession: 'p', startedAt: '2026-09-14 10:00:00' };
    const scope = await wrapScope.resolve(project, session, { ...noopDeps(wt), getLaunchBaseline: () => null });
    assert.equal(scope.worktreeTarget, true);
    assert.equal(scope.lastWrapSha, boundary);
    assert.equal(scope.lastWrapShaRead, 'recorded');
  });

  it('keeps the registered checkout for a pane in the checkout, in another repo, or unreadable', async () => {
    const repo = makeRepo();
    const other = makeRepo();
    const project = { name: 'p', path: repo };
    const session = { id: 1, tmuxSession: 'p' };
    for (const [pane, reason] of [
      [path.join(repo), /registered checkout/],
      [other, /different repository/],
      [null, /could not be read/],
      [os.tmpdir(), /not inside a git repo|different repository/]
    ]) {
      const t = await wrapScope.resolveWorkTree(project, session, noopDeps(pane));
      assert.equal(t.worktreeTarget, false, `pane ${pane}`);
      assert.equal(t.workTree, repo);
      assert.match(t.reason, reason);
    }
    const noPane = await wrapScope.resolveWorkTree(project, { id: 1, tmuxSession: null }, noopDeps(repo));
    assert.match(noPane.reason, /no pane/);
  });

  it('keeps a project registered below its repo root at the same offset in the worktree', async () => {
    const repo = makeRepo();
    commitFile(repo, 'packages/app/index.js', 'app');
    const wt = `${repo}-wt`;
    dirs.push(wt);
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/sub', wt);
    const t = await wrapScope.resolveWorkTree({ path: path.join(repo, 'packages', 'app') }, { tmuxSession: 'p' }, noopDeps(wt));
    assert.equal(t.workTree, path.join(fs.realpathSync(wt), 'packages', 'app'));
  });

  it('applies the launch dirty snapshot only to the tree it was taken in', async () => {
    const repo = makeRepo();
    const wt = `${repo}-wt`;
    dirs.push(wt);
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/snap', wt);
    const baseline = { sha: git(repo, 'rev-parse', 'HEAD'), toplevel: repo, dirty: { paths: ['x'], truncated: false } };
    const project = { name: 'p', path: repo };
    const inCheckout = await wrapScope.resolve(project, { id: 1, tmuxSession: 'p' }, { ...noopDeps(repo), getLaunchBaseline: () => baseline });
    assert.equal(inCheckout.snapshotApplies, true);
    const inWorktree = await wrapScope.resolve(project, { id: 1, tmuxSession: 'p' }, { ...noopDeps(wt), getLaunchBaseline: () => baseline });
    assert.equal(inWorktree.snapshotApplies, false);
    const truncated = await wrapScope.resolve(project, { id: 1, tmuxSession: 'p' }, {
      ...noopDeps(repo), getLaunchBaseline: () => ({ ...baseline, dirty: { paths: [], truncated: true } })
    });
    assert.equal(truncated.snapshotApplies, false, 'a partial list is never trusted as complete');
  });

  it('a git that refuses is reported as git refusing, not as "not a git repo", and the wrap says so instead of skipping', async () => {
    const repo = makeRepo();
    const refusing = async (file, args) => (args.includes('--path-format=absolute')
      ? { exitCode: 129, stdout: '', stderr: "error: unknown option `path-format=absolute'\nusage: git rev-parse", error: null, timedOut: false }
      : asyncExec(file, args, { cwd: repo }));
    const scope = await wrapScope.resolve({ name: 'p', path: repo }, { id: 1, tmuxSession: 'p' }, {
      exec: refusing, paneCurrentPath: () => repo, getLaunchBaseline: () => null
    });
    assert.equal(scope.workToplevel, null);
    assert.match(scope.workTreeProblem, /git refused to read the repository.*unknown option/);
    assert.match(scope.workTreeReason, /git refused/);
    const sessionFiles = require('../lib/wrap-steps/session-files');
    const r = await sessionFiles.run({ project: { name: 'p', path: repo }, scope, options: {} });
    assert.equal(r.status, 'blocked');
    assert.match(r.blockers[0], /git could not be read/);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scope-norepo-'));
    dirs.push(plain);
    const none = await wrapScope.resolve({ name: 'p', path: plain }, null, { exec: asyncExec, paneCurrentPath: () => null, getLaunchBaseline: () => null });
    assert.equal(none.workTreeProblem, null, 'a directory that is simply not a repo is an answer, not a problem');
  });

  it('the session-files row names why a session with a pane is wrapping the checkout rather than a worktree', () => {
    const sessionFiles = require('../lib/wrap-steps/session-files');
    assert.match(sessionFiles._detail({ workTree: null, checkoutReason: 'pane directory could not be read', ownedCount: 1, included: [], left: [] }),
      /^Wrapping the registered checkout \(pane directory could not be read\)/);
    assert.doesNotMatch(sessionFiles._detail({ workTree: null, checkoutReason: null, ownedCount: 1, included: [], left: [] }), /Wrapping/);
  });

  it('reads the session start as UTC', () => {
    assert.equal(wrapScope._startedAtMs('2026-09-14 10:00:00'), Date.UTC(2026, 8, 14, 10, 0, 0));
    assert.equal(wrapScope._startedAtMs(null), null);
  });
});

describe('the AI prompts name the range the wrap\'s checks judge', () => {
  const aiContent = require('../lib/wrap-steps/ai-content');
  const defaultPipeline = require('../lib/wrap-default-pipeline');

  it('no shipped prompt guesses HEAD~10 or says the wrap commits everything', () => {
    for (const step of defaultPipeline.steps()) {
      if (typeof step.prompt !== 'string') continue;
      assert.doesNotMatch(step.prompt, /HEAD~10/, `${step.id} still guesses a range`);
      assert.doesNotMatch(step.prompt, /git add -A/, `${step.id} still describes the sweep`);
    }
    const scoped = defaultPipeline.steps().filter((s) => typeof s.prompt === 'string' && s.prompt.includes('{sessionScope}')).map((s) => s.id);
    assert.deepEqual(scoped.sort(), ['changelog-update', 'memory-update', 'release-recommendation']);
  });

  it('hands the AI the launch-based first-parent range', () => {
    const repo = makeRepo();
    const launch = commitFile(repo, 'a.js', 'before');
    commitFile(repo, 'b.js', 'mine');
    const text = aiContent._interpolatePrompt('Scope: {sessionScope}', [], { path: repo }, { lastWrapSha: null, baseline: { sha: launch } });
    assert.match(text, new RegExp(`git log --oneline --first-parent ${launch}\\.\\.HEAD`));
    assert.doesNotMatch(text, /no launch record/);
  });

  it('says so when the range is only the branch, and when there is none at all', () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'feat');
    commitFile(repo, 'x.js', 'x');
    const branch = aiContent._interpolatePrompt('{sessionScope}', [], { path: repo }, { lastWrapSha: null, baseline: null });
    assert.match(branch, /main\.\.HEAD/);
    assert.match(branch, /no launch record/);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scope-plain-'));
    dirs.push(plain);
    assert.match(aiContent._interpolatePrompt('{sessionScope}', [], { path: plain }, null), /No session range could be established/);
  });
});

describe('wrap steps read project config from the registered checkout', () => {
  // A worktree carries no `.tangleclaw/project.json`, so a step that reads config
  // from `project.path` on a worktree wrap loads the defaults and silently changes
  // what it does. The family: every projectConfig load/save, and every direct
  // read of the config file by path.
  const stepsDir = path.join(__dirname, '..', 'lib', 'wrap-steps');
  const sources = fs.readdirSync(stepsDir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(stepsDir, f), 'utf8')]);

  it('no step loads or saves config from project.path or a bare cwd', () => {
    const offenders = [];
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/projectConfig\.(load|save)\(\s*([^,)]+)/g)) {
        const arg = m[2].trim();
        // `[^,)]+` stops inside `configRootOf(project)`, so its form is matched as a prefix.
        if (!/^(configRootOf\(project|configRoot|projectPath)$/.test(arg)) offenders.push(`${file}: projectConfig.${m[1]}(${arg}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('every projectPath-taking config helper is called with the config root', () => {
    const commit = sources.find(([f]) => f === 'commit.js')[1];
    assert.match(commit, /_readLastWrapSha\(configRootOf\(project\)\)/);
    assert.match(commit, /_stampLastWrapSha\(configRootOf\(project\), stampSha\)/);
    const priming = sources.find(([f]) => f === 'priming-roll.js')[1];
    assert.match(priming, /_resolvePlanPath\(project\.path, step, configRootOf\(project\)\)/);
    const continuity = sources.find(([f]) => f === 'continuity-write.js')[1];
    assert.doesNotMatch(continuity, /continuity\.\w+\(project\.path/, 'the continuity store is machine state in the registered checkout');
  });

  it('the pipeline hands steps the scoped project, never the registered record', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wrap-pipeline.js'), 'utf8');
    assert.match(src, /_buildStepContext\(stepProject, session, step, runState, options\)/);
    assert.doesNotMatch(src, /options\.scope/, 'the scope never comes from caller options');
  });
});
