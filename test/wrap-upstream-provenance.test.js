'use strict';

/*
 * Wrap advice that knows what upstream already holds (#1868).
 *
 * Driven against real repositories with a real bare origin: the defect was a
 * stale session checkout offering its own merged plan, and a carrier identical
 * to upstream, as new work. Only real git can show what `ls-tree`,
 * `hash-object` and a fetch report for that shape.
 */

const { describe, it, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const provenance = require('../lib/wrap-steps/_upstream-provenance');
const ownership = require('../lib/wrap-steps/_file-ownership');
const sessionFiles = require('../lib/wrap-steps/session-files');
const commitStep = require('../lib/wrap-steps/commit');
const secretCheck = require('../lib/wrap-steps/_secret-check');
const launchBaseline = require('../lib/launch-baseline');
const wrapScope = require('../lib/wrap-scope');
const { execFileArgs } = require('../lib/exec');
const { initRepo, cloneRepo } = require('./_temp-repo');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const realRefreshEnabled = sessionFiles._internal.refreshEnabled;
const realLogActivity = secretCheck._internal.logActivity;
beforeEach(() => {
  // A local bare origin needs no network, so the refresh is exercised for real.
  sessionFiles._internal.refreshEnabled = () => true;
  secretCheck._internal.logActivity = () => {};
});
afterEach(() => {
  sessionFiles._internal.refreshEnabled = realRefreshEnabled;
  secretCheck._internal.logActivity = realLogActivity;
});

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
 * `git status` in the form the wrap parses, untrimmed: a leading space is part
 * of the status code.
 * @param {string} cwd - Repo directory.
 * @returns {string}
 */
function rawStatus(cwd) {
  return execFileSync('git', ownership.statusArgs(), { cwd, encoding: 'utf8' });
}

/**
 * A fresh temporary directory, removed after the run.
 * @param {string} tag - Name hint.
 * @returns {string} Path, symlinks resolved.
 */
function tmp(tag) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tc-prov-${tag}-`)));
  dirs.push(d);
  return d;
}

/**
 * Write a file, creating its directory.
 * @param {string} root - Repo root.
 * @param {string} rel - Relative path.
 * @param {string} text - Content.
 */
function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/**
 * A text of `n` numbered lines.
 * @param {number} n - Line count.
 * @param {string} [tag] - Line prefix.
 * @returns {string}
 */
function lines(n, tag = 'line') {
  return Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';
}

/**
 * A bare origin, a writer clone standing in for the merged worktree PR, and a
 * session clone left at the first commit.
 * @param {object} [opts]
 * @param {string} [opts.branch='main'] - Default branch name.
 * @param {string} [opts.remote='origin'] - The session clone's remote name.
 * @returns {{origin:string, writer:string, session:string, branch:string, remote:string}}
 */
function makeFleet(opts = {}) {
  const branch = opts.branch || 'main';
  const remote = opts.remote || 'origin';
  const base = tmp('fleet');
  const origin = path.join(base, 'origin.git');
  fs.mkdirSync(origin);
  initRepo(origin, ['--bare', '-b', branch]);
  const writer = path.join(base, 'writer');
  cloneRepo(origin, writer);
  git(writer, 'config', 'user.email', 't@t');
  git(writer, 'config', 'user.name', 't');
  git(writer, 'checkout', '-q', '-b', branch);
  write(writer, 'README.md', 'init\n');
  write(writer, 'CLAUDE.md', 'rules v1\n');
  write(writer, 'lib.js', 'v1\n');
  git(writer, 'add', '-A');
  git(writer, 'commit', '-q', '-m', 'init');
  git(writer, 'push', '-q', 'origin', branch);
  const session = path.join(base, 'session');
  cloneRepo(origin, session, ['-o', remote]);
  git(session, 'config', 'user.email', 't@t');
  git(session, 'config', 'user.name', 't');
  return { origin, writer, session, branch, remote };
}

/**
 * Land a commit upstream through the writer clone.
 * @param {{writer:string, branch:string}} fleet
 * @param {Object<string,string>} files - Relative path to content.
 * @param {string} [msg] - Commit message.
 */
function landUpstream(fleet, files, msg = 'upstream change') {
  for (const [rel, text] of Object.entries(files)) write(fleet.writer, rel, text);
  git(fleet.writer, 'add', '-A');
  git(fleet.writer, 'commit', '-q', '-m', msg);
  git(fleet.writer, 'push', '-q', 'origin', fleet.branch);
}

/** The argv runner the scope takes in production. */
const asyncExec = (file, args, opts) => execFileArgs(file, args, { cwd: opts.cwd, timeoutMs: 10000, maxBufferBytes: 1024 * 1024 });

/**
 * The real scope for a session launched at `baseline`.
 * @param {string} repo - Checkout.
 * @param {object|null} baseline - Launch baseline.
 * @returns {Promise<object>}
 */
function scopeFor(repo, baseline) {
  return wrapScope.resolve({ name: 'prov', path: repo }, { id: 1, tmuxSession: 'prov', startedAt: '2000-01-01 00:00:00' }, {
    exec: asyncExec,
    paneCurrentPath: () => repo,
    getLaunchBaseline: () => baseline
  });
}

/**
 * Run a step as the pipeline would.
 * @param {object} step - Step module.
 * @param {string} repo - Checkout.
 * @param {object} scope - Scope.
 * @param {object} [options] - Run options.
 * @param {Array<object>} [previousResults] - Earlier results.
 * @returns {Promise<object>}
 */
function runStep(step, repo, scope, options = {}, previousResults = []) {
  return step.run({
    project: wrapScope.stepProject({ id: 1, name: 'prov', path: repo }, scope),
    session: null,
    step: { id: step === commitStep ? 'commit' : 'session-files' },
    previousResults,
    staged: {},
    options,
    scope
  });
}

/**
 * Everything a wrap must not change, apart from remote-tracking refs.
 * @param {string} repo - Checkout.
 * @param {string[]} files - Paths whose bytes are recorded.
 * @returns {object}
 */
function stateOf(repo, files) {
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    index: git(repo, 'ls-files', '-s'),
    status: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })
      .split('\n').filter((l) => l && !l.includes('.tangleclaw/last-wrap') && !l.includes('.tangleclaw/wrap')).join('\n'),
    bytes: Object.fromEntries(files.map((f) => [f, fs.existsSync(path.join(repo, f)) ? fs.readFileSync(path.join(repo, f), 'utf8') : null]))
  };
}

/**
 * The incident shape: upstream merged a plan (with a long status header) and a
 * regenerated CLAUDE.md; the session root is behind, holds an older untracked
 * copy of the plan, and a CLAUDE.md regenerated to exactly upstream's bytes.
 * @returns {Promise<{fleet:object, scope:object, plan:string}>}
 */
async function incident() {
  const fleet = makeFleet();
  const plan = '.tangleclaw/plans/1861-durable-control-state.md';
  landUpstream(fleet, { [plan]: lines(32, 'status') + lines(40, 'plan'), 'CLAUDE.md': 'rules v2\n' }, 'Merge PR #1866');
  for (let i = 0; i < 3; i += 1) landUpstream(fleet, { [`later-${i}.md`]: `${i}\n` }, `later ${i}`);
  const baseline = launchBaseline.capture(fleet.session);
  write(fleet.session, plan, lines(40, 'plan'));
  write(fleet.session, 'CLAUDE.md', 'rules v2\n');
  return { fleet, scope: await scopeFor(fleet.session, baseline), plan };
}

describe('the #1868 incident: a stale session root after its worktree PR merged', () => {
  it('recommends Keep local for the merged plan and leaves the identical CLAUDE.md out, asking nothing about it', async () => {
    const { fleet, scope, plan } = await incident();
    const res = await runStep(sessionFiles, fleet.session, scope);
    assert.equal(res.status, 'blocked');
    const asked = res.output.foreignPaths.find((f) => f.path === plan);
    assert.ok(asked, 'the plan is asked about');
    assert.equal(asked.reason, 'upstream-owns');
    assert.equal(asked.recommendation, 'leave');
    assert.match(asked.recommendationWhy, /origin\/main already tracks this path with different content \(72 lines there, 40 lines here\)/);
    assert.equal(res.output.foreignPaths.some((f) => f.path === 'CLAUDE.md'), false, 'identical content is never asked about');
    assert.deepEqual(res.output.alreadyUpstream, ['CLAUDE.md']);
    assert.deepEqual(res.output.manifest.alreadyUpstream, ['CLAUDE.md']);
    assert.equal(res.output.manifest.commit.includes('CLAUDE.md'), false);
    assert.equal(res.output.provenance.state, 'established');
    assert.equal(res.output.provenance.ref, 'origin/main');
    assert.equal(res.output.provenance.behind, 4);
    assert.equal(res.output.provenance.ahead, 0);
    assert.match(res.output.provenanceHeadline, /This checkout is 4 behind and 0 ahead of origin\/main \(checked just now\)/);
    assert.match(res.output.remediation, /^This checkout is 4 behind/);
  });

  it('Leave keeps both files as they are, the wrap goes on, and the commit step commits neither', async () => {
    const { fleet, scope, plan } = await incident();
    const watched = [plan, 'CLAUDE.md'];
    const before = stateOf(fleet.session, watched);
    const first = await runStep(sessionFiles, fleet.session, scope, { pathDecisions: { [plan]: 'leave' } });
    assert.equal(first.status, 'done');
    assert.deepEqual(first.output.left, [plan]);
    const results = [{ stepId: 'session-files', status: 'done', output: first.output }];
    const committed = await runStep(commitStep, fleet.session, scope, { pathDecisions: { [plan]: 'leave' } }, results);
    assert.notEqual(committed.status, 'done', 'there is nothing of this session\'s to commit');
    assert.deepEqual(committed.output.alreadyUpstream, ['CLAUDE.md']);
    const afterState = stateOf(fleet.session, watched);
    assert.deepEqual(afterState, before, 'no step changed HEAD, the index, the status or a byte of either file');
  });

  it('refuses an Include for the identical CLAUDE.md even when one is sent', async () => {
    const { fleet, scope, plan } = await incident();
    const res = await runStep(sessionFiles, fleet.session, scope, { pathDecisions: { [plan]: 'leave', 'CLAUDE.md': 'include' } });
    assert.equal(res.status, 'done');
    assert.deepEqual(res.output.provenanceRefusedIncludes, ['CLAUDE.md']);
    assert.deepEqual(res.output.manifest.refusedIncludes, ['CLAUDE.md']);
    assert.equal(res.output.manifest.commit.includes('CLAUDE.md'), false);
  });
});

describe('what upstream holds decides before what kind of file it is', () => {
  it('a tracked edit this session made that exactly matches upstream is not proposed for commit', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'lib.js': 'v2\n' });
    const baseline = launchBaseline.capture(fleet.session);
    write(fleet.session, 'lib.js', 'v2\n');
    const scope = await scopeFor(fleet.session, baseline);
    const res = await runStep(sessionFiles, fleet.session, scope);
    assert.equal(res.status, 'done');
    assert.deepEqual(res.output.alreadyUpstream, ['lib.js']);
    assert.deepEqual(res.output.manifest.commit, []);
    assert.equal(res.output.ownedCount, 0);
  });

  it('a genuinely new plan upstream has never seen keeps its Include advice', async () => {
    const fleet = makeFleet();
    const baseline = launchBaseline.capture(fleet.session);
    write(fleet.session, '.tangleclaw/plans/new-idea.md', '# idea\n');
    const scope = await scopeFor(fleet.session, baseline);
    const res = await runStep(sessionFiles, fleet.session, scope);
    const f = res.output.foreignPaths.find((x) => x.path === '.tangleclaw/plans/new-idea.md');
    assert.equal(f.recommendation, 'include');
    assert.equal(f.reason, 'untracked-new');
    assert.match(f.recommendationWhy, /project content; not on origin\/main yet$/);
  });

  it('an edit to a file upstream changed after this checkout forked is asked about, with Keep local advice', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'lib.js': 'upstream v2\n' });
    const baseline = launchBaseline.capture(fleet.session);
    write(fleet.session, 'lib.js', 'session v2\n');
    const scope = await scopeFor(fleet.session, baseline);
    const res = await runStep(sessionFiles, fleet.session, scope);
    assert.equal(res.status, 'blocked');
    const f = res.output.foreignPaths.find((x) => x.path === 'lib.js');
    assert.equal(f.reason, 'upstream-owns');
    assert.equal(f.recommendation, 'leave');
    assert.match(f.recommendationWhy, /origin\/main changed this file after your checkout \(you are 1 commit behind\)/);
  });

  it('on a branch that changed a file itself, matching upstream again is a real edit and is committed', async () => {
    const fleet = makeFleet();
    git(fleet.session, 'checkout', '-q', '-b', 'feat/own');
    write(fleet.session, 'lib.js', 'branch edit\n');
    git(fleet.session, 'commit', '-q', '-am', 'branch changes lib.js');
    const baseline = launchBaseline.capture(fleet.session);
    write(fleet.session, 'lib.js', 'v1\n');
    const scope = await scopeFor(fleet.session, baseline);
    const res = await runStep(sessionFiles, fleet.session, scope);
    assert.equal(res.status, 'done');
    assert.deepEqual(res.output.alreadyUpstream, [], 'the revert is not mistaken for upstream\'s content');
    assert.deepEqual(res.output.manifest.commit, ['lib.js']);
  });

  it('on a branch with its own commits to a file upstream also changed, the edit stays the branch\'s', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'lib.js': 'upstream v2\n' });
    git(fleet.session, 'checkout', '-q', '-b', 'feat/own');
    write(fleet.session, 'lib.js', 'branch edit\n');
    git(fleet.session, 'commit', '-q', '-am', 'branch changes lib.js');
    const baseline = launchBaseline.capture(fleet.session);
    write(fleet.session, 'lib.js', 'branch edit 2\n');
    const scope = await scopeFor(fleet.session, baseline);
    const res = await runStep(sessionFiles, fleet.session, scope);
    assert.equal(res.status, 'done');
    assert.deepEqual(res.output.manifest.commit, ['lib.js']);
  });

  it('a deletion upstream already made is not committed again, but deleting a file only this branch added is', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'gone.md': 'x\n' });
    git(fleet.session, 'pull', '-q', 'origin', 'main');
    git(fleet.writer, 'rm', '-q', 'gone.md');
    git(fleet.writer, 'commit', '-q', '-m', 'remove gone.md');
    git(fleet.writer, 'push', '-q', 'origin', 'main');
    git(fleet.session, 'checkout', '-q', '-b', 'feat/own');
    write(fleet.session, 'mine-only.md', 'y\n');
    git(fleet.session, 'add', 'mine-only.md');
    git(fleet.session, 'commit', '-q', '-m', 'branch adds mine-only.md');
    const baseline = launchBaseline.capture(fleet.session);
    fs.rmSync(path.join(fleet.session, 'gone.md'));
    fs.rmSync(path.join(fleet.session, 'mine-only.md'));
    const scope = await scopeFor(fleet.session, baseline);
    const res = await runStep(sessionFiles, fleet.session, scope);
    assert.deepEqual(res.output.alreadyUpstream, ['gone.md']);
    assert.deepEqual(res.output.manifest.commit, ['mine-only.md']);
  });

  it('an edit to a file upstream has left alone is committed as before', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'other.md': 'x\n' });
    const baseline = launchBaseline.capture(fleet.session);
    write(fleet.session, 'lib.js', 'session v2\n');
    const scope = await scopeFor(fleet.session, baseline);
    const res = await runStep(sessionFiles, fleet.session, scope);
    assert.equal(res.status, 'done');
    assert.equal(res.output.ownedCount, 1);
    assert.deepEqual(res.output.manifest.commit, ['lib.js']);
  });
});

describe('upstream that cannot be read, or was not refreshed', () => {
  it('with no reachable remote and no ref, nothing is recommended for the commit and Leave lets the wrap go on', async () => {
    const repo = tmp('unreach');
    initRepo(repo, ['-b', 'main']);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    write(repo, 'README.md', 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', path.join(repo, 'no-such-origin.git'));
    const baseline = launchBaseline.capture(repo);
    const plan = '.tangleclaw/plans/p.md';
    write(repo, plan, '# p\n');
    const scope = await scopeFor(repo, baseline);
    const res = await runStep(sessionFiles, repo, scope);
    assert.equal(res.output.provenance.state, 'unavailable');
    assert.equal(res.output.provenance.refresh, 'failed');
    const f = res.output.foreignPaths.find((x) => x.path === plan);
    assert.equal(f.recommendation, 'leave', 'an unverified plan is never recommended for Include');
    assert.match(f.recommendationWhy, /couldn't confirm what upstream holds/);
    write(repo, 'odd.txt', 'x\n');
    const withOdd = await runStep(sessionFiles, repo, scope);
    assert.equal(withOdd.output.foreignPaths.find((x) => x.path === 'odd.txt').recommendation, 'leave',
      'a file of no known kind that needs a decision defaults to Keep local too');
    fs.rmSync(path.join(repo, 'odd.txt'));
    assert.match(res.output.provenanceHeadline, /^Couldn't compare these files with upstream/);
    const left = await runStep(sessionFiles, repo, scope, { pathDecisions: { [plan]: 'leave' } });
    assert.equal(left.status, 'done');
    assert.equal(fs.readFileSync(path.join(repo, plan), 'utf8'), '# p\n');
  });

  it('a failed refresh falls back to the local ref: an exact match still counts, an absent path loses its Include advice', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'lib.js': 'v2\n' });
    git(fleet.session, 'fetch', '-q', 'origin');
    git(fleet.session, 'remote', 'set-url', 'origin', path.join(fleet.session, 'gone.git'));
    const baseline = launchBaseline.capture(fleet.session);
    write(fleet.session, 'lib.js', 'v2\n');
    write(fleet.session, '.tangleclaw/plans/q.md', '# q\n');
    const scope = await scopeFor(fleet.session, baseline);
    const res = await runStep(sessionFiles, fleet.session, scope);
    assert.equal(res.output.provenance.state, 'stale');
    assert.equal(res.output.provenance.refresh, 'failed');
    assert.ok(res.output.provenance.observedAt, 'the last fetch time comes from the reflog');
    assert.deepEqual(res.output.alreadyUpstream, ['lib.js']);
    const q = res.output.foreignPaths.find((x) => x.path === '.tangleclaw/plans/q.md');
    assert.equal(q.recommendation, 'leave');
    assert.match(res.output.provenanceHeadline, /as of the last fetch .* It was not refreshed this wrap/);
  });

  it('with the refresh turned off, no fetch is made and the ref is reported stale', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'lib.js': 'v2\n' });
    const before = git(fleet.session, 'rev-parse', 'refs/remotes/origin/main');
    const p = await provenance.capture(fleet.session, [], { refresh: false });
    assert.equal(p.state, 'stale');
    assert.equal(p.refresh, 'skipped');
    assert.equal(git(fleet.session, 'rev-parse', 'refs/remotes/origin/main'), before, 'the ref did not move');
  });

  it('a repository with no remote has nothing upstream, so the existing advice stands', async () => {
    const repo = tmp('local');
    initRepo(repo, ['-b', 'main']);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    write(repo, 'README.md', 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const baseline = launchBaseline.capture(repo);
    write(repo, '.tangleclaw/plans/p.md', '# p\n');
    const scope = await scopeFor(repo, baseline);
    const res = await runStep(sessionFiles, repo, scope);
    assert.equal(res.output.provenance.state, 'no-remote');
    assert.equal(res.output.provenanceHeadline, '');
    assert.equal(res.output.foreignPaths[0].recommendation, 'include');
  });
});

describe('the default branch is resolved, never assumed', () => {
  it('follows <remote>/HEAD to a branch named trunk on a remote named upstream', async () => {
    const fleet = makeFleet({ branch: 'trunk', remote: 'upstream' });
    landUpstream(fleet, { 'lib.js': 'v2\n' });
    write(fleet.session, 'lib.js', 'v2\n');
    const p = await provenance.capture(fleet.session, ownership.parseStatus(rawStatus(fleet.session)));
    assert.equal(p.remote, 'upstream');
    assert.equal(p.ref, 'upstream/trunk');
    assert.equal(p.state, 'established');
    assert.equal(p.behind, 1);
    assert.equal(p.paths['lib.js'].verdict, 'already-upstream');
  });

  it('works from a detached HEAD and from a linked worktree', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'lib.js': 'v2\n' });
    git(fleet.session, 'checkout', '-q', '--detach');
    const detached = await provenance.capture(fleet.session, []);
    assert.equal(detached.ref, 'origin/main');
    assert.equal(detached.behind, 1);
    const wt = path.join(tmp('wt'), 'tree');
    git(fleet.session, 'worktree', 'add', '-q', '-b', 'feat/x', wt, 'HEAD');
    write(wt, 'lib.js', 'v2\n');
    const linked = await provenance.capture(wt, ownership.parseStatus(rawStatus(wt)));
    assert.equal(linked.ref, 'origin/main');
    assert.equal(linked.paths['lib.js'].verdict, 'already-upstream');
  });
});

describe('the commit boundary re-judges against the recorded upstream commit (R11-E)', () => {
  /**
   * A session whose new plan is absent upstream when `session-files` runs; the
   * operator includes it; then the plan lands upstream and the local ref moves
   * before the commit step.
   * @returns {Promise<object>}
   */
  async function includeThenUpstreamLands() {
    const fleet = makeFleet();
    const baseline = launchBaseline.capture(fleet.session);
    const plan = '.tangleclaw/plans/race.md';
    write(fleet.session, plan, '# mine\n');
    const scope = await scopeFor(fleet.session, baseline);
    const options = { pathDecisions: { [plan]: 'include' }, pathDecisionBasis: { [plan]: 'none' } };
    const first = await runStep(sessionFiles, fleet.session, scope, options);
    assert.equal(first.status, 'done');
    assert.deepEqual(first.output.included, [plan]);
    landUpstream(fleet, { [plan]: '# theirs, merged\nwith more\n' });
    git(fleet.session, 'fetch', '-q', 'origin');
    return { fleet, scope, plan, options, results: [{ stepId: 'session-files', status: 'done', output: first.output }] };
  }

  it('blocks and asks again when the moved ref shows upstream now owns an included path, committing nothing', async () => {
    const { fleet, scope, plan, options, results } = await includeThenUpstreamLands();
    const before = stateOf(fleet.session, [plan]);
    const res = await runStep(commitStep, fleet.session, scope, options, results);
    assert.equal(res.status, 'blocked');
    assert.deepEqual(res.output.provenanceChanged, [plan]);
    assert.equal(res.output.provenance.refMoved, true);
    const f = res.output.foreignPaths.find((x) => x.path === plan);
    assert.equal(f.provenanceChanged, true);
    assert.equal(f.recommendation, 'leave');
    assert.match(res.output.remediation, /Upstream changed after you answered/);
    assert.deepEqual(stateOf(fleet.session, [plan]), before);
  });

  it('honors an Include given against the facts that are current', async () => {
    const { fleet, scope, plan, results } = await includeThenUpstreamLands();
    const res = await runStep(commitStep, fleet.session, scope,
      { pathDecisions: { [plan]: 'include' }, pathDecisionBasis: { [plan]: 'upstream-owns' } }, results);
    assert.equal(res.status, 'done');
    assert.ok(git(fleet.session, 'show', '--name-only', '--format=', 'HEAD').split('\n').includes(plan));
  });

  it('a session-files retry does not carry an Include sent with no basis onto a path upstream owns', async () => {
    const { scope, fleet, plan } = await incident().then((x) => ({ ...x }));
    const res = await runStep(sessionFiles, fleet.session, scope, { pathDecisions: { [plan]: 'include' } });
    assert.equal(res.status, 'blocked');
    assert.deepEqual(res.output.provenanceChanged, [plan]);
  });

  it('compares a file a wrap step rewrote after session-files, not the earlier bytes', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'lib.js': 'v2\n' });
    const baseline = launchBaseline.capture(fleet.session);
    write(fleet.session, 'lib.js', 'mine\n');
    const scope = await scopeFor(fleet.session, baseline);
    const first = await runStep(sessionFiles, fleet.session, scope, { pathDecisions: { 'lib.js': 'leave' } });
    assert.equal(first.status, 'done');
    // A later step rewrites the file to exactly upstream's bytes.
    write(fleet.session, 'lib.js', 'v2\n');
    const res = await runStep(commitStep, fleet.session, scope, { pathDecisions: { 'lib.js': 'leave' } },
      [{ stepId: 'session-files', status: 'done', output: first.output }]);
    assert.deepEqual(res.output.alreadyUpstream, ['lib.js']);
  });
});

describe('precedence: withholds outrank upstream, and upstream outranks file kind', () => {
  /**
   * A handcrafted provenance answer.
   * @param {Object<string,string>} verdicts - Path to verdict.
   * @returns {object}
   */
  function fakeProvenance(verdicts) {
    const paths = {};
    for (const [p, v] of Object.entries(verdicts)) {
      paths[p] = { upstream: v === 'already-upstream' ? 'equal' : 'different', upstreamChanged: true, verdict: v, localLines: 1, upstreamLines: 2 };
    }
    return { state: 'established', ref: 'origin/main', behind: 3, ahead: 0, problem: null, paths };
  }
  const scope = { snapshotApplies: true, baseline: { dirty: { paths: [] } }, startedAtMs: 0, workToplevel: null };

  it('a database stays withheld and a methodology path stays withheld, whatever upstream holds', () => {
    const dirty = [
      { path: 'data/app.db', deleted: false, indexRemoved: false, renamePair: null, newToRepo: false },
      { path: '.prawduct/state.yaml', deleted: false, indexRemoved: false, renamePair: null, newToRepo: false }
    ];
    const c = ownership.classify(scope, dirty, {
      provenance: fakeProvenance({ 'data/app.db': 'already-upstream', '.prawduct/state.yaml': 'upstream-owns' }),
      withheldPrefixes: ['.prawduct/']
    });
    assert.deepEqual(c.safetyWithheld, ['data/app.db']);
    assert.deepEqual(c.methodologyWithheld, ['.prawduct/state.yaml']);
    assert.deepEqual(c.alreadyUpstream, []);
    assert.equal(c.foreign.length, 0);
  });

  it('a secret match on a path upstream owns is still flagged and still never recommended for Include', async () => {
    const fleet = makeFleet();
    landUpstream(fleet, { 'notes.md': 'upstream notes\n' });
    const baseline = launchBaseline.capture(fleet.session);
    write(fleet.session, 'notes.md', `aws ${'AKIA'}${'ABCDEFGHIJKLMNOP'}\n`);
    const scope2 = await scopeFor(fleet.session, baseline);
    const res = await runStep(sessionFiles, fleet.session, scope2);
    const f = res.output.foreignPaths.find((x) => x.path === 'notes.md');
    assert.ok(f.secretRules && f.secretRules.length > 0);
    assert.notEqual(f.recommendation, 'include');
  });

  it('the drawer\'s basis echo is sanitized: unknown verdicts are dropped', () => {
    assert.deepEqual(ownership.sanitizeDecisionBasis({ a: 'upstream-owns', b: 'bogus', c: 3 }), { a: 'upstream-owns' });
    assert.deepEqual(ownership.sanitizeDecisionBasis(['x']), {});
  });
});

describe('verdicts and tightening', () => {
  const v = provenance._internal._verdict;
  it('maps facts to verdicts, with only an exact match trusted on a stale ref', () => {
    assert.equal(v('equal', false, {}, 'stale'), 'already-upstream');
    assert.equal(v('different', false, { newToRepo: true }, 'established'), 'upstream-owns');
    assert.equal(v('different', true, {}, 'stale'), 'upstream-owns');
    assert.equal(v('different', false, {}, 'established'), 'none');
    assert.equal(v('different', false, {}, 'stale'), 'unverified');
    assert.equal(v('equal', true, {}, 'established', true), 'none', 'undoing the branch\'s own change is a real edit');
    assert.equal(v('different', true, {}, 'established', true), 'none', 'both sides changed it: the branch\'s merge meets them');
    assert.equal(v('different', null, {}, 'established'), 'unverified');
    assert.equal(v('absent', null, {}, 'established'), 'none');
    assert.equal(v('absent', null, {}, 'stale'), 'unverified');
    assert.equal(v('unknown', null, {}, 'established'), 'unverified');
  });

  it('only ever tightens upward', () => {
    assert.equal(provenance.tightened('none', 'upstream-owns'), true);
    assert.equal(provenance.tightened(undefined, 'upstream-owns'), true);
    assert.equal(provenance.tightened('upstream-owns', 'upstream-owns'), false);
    assert.equal(provenance.tightened('upstream-owns', 'none'), false);
    assert.equal(provenance.tightened('unverified', 'already-upstream'), true);
    assert.equal(provenance.tightened('none', 'unverified'), true, 'an Include is not carried onto evidence that can no longer be read');
    assert.equal(provenance.tightened('unverified', 'unverified'), false);
  });

  it('counts lines, including a last line with no newline', () => {
    assert.equal(provenance._internal._countLines(''), 0);
    assert.equal(provenance._internal._countLines('a\nb\n'), 2);
    assert.equal(provenance._internal._countLines('a\nb'), 2);
  });
});
