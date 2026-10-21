'use strict';

/*
 * The wrap's CHANGELOG write transaction — a cross-step contract that spans
 * `changelog-update` (the AI edits CHANGELOG.md on disk), `version-bump` (reads
 * CHANGELOG.md and stages the WHOLE promoted file), and `commit` (flushes every
 * staged write back to disk verbatim).
 *
 * The hazard: a staged whole-file snapshot taken BEFORE the AI's edit is
 * written back AFTER it, silently discarding the edit. That is exactly what
 * happened while `version-bump` ran ahead of `changelog-update` — the AI's
 * entry never survived a wrap that bumped, and the bump level was derived from
 * a CHANGELOG missing the session's own entry. The order is the fix, so these
 * tests pin the order AND the behavior it buys, not just one of the two.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const vb = require('../lib/wrap-steps/version-bump');
const commit = require('../lib/wrap-steps/commit');
const store = require('../lib/store');
const wrapDefaultPipeline = require('../lib/wrap-default-pipeline');

const AI_LINE = '- **The entry the AI wrote this session (#12345).**';

const CHANGELOG_WITH_AI_EDIT = `# Changelog

## [Unreleased]

### Added
${AI_LINE}

## [1.4.2] - 2026-05-01

### Fixed
- something old
`;

describe('wrap CHANGELOG transaction — step order is load-bearing', () => {
  const steps = wrapDefaultPipeline.steps();
  const idx = (id) => steps.findIndex((s) => s.id === id);

  it('every ai-content step that must change CHANGELOG.md runs BEFORE version-bump', () => {
    // The general invariant, not just today's step names: version-bump stages a
    // whole-file CHANGELOG snapshot, so any agent step contracted to edit that
    // file must have already done so.
    const vbIdx = idx('version-bump');
    assert.ok(vbIdx >= 0, 'precondition: the pipeline has a version-bump step');
    const changelogEditors = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => Array.isArray(s.verifyChanged) && s.verifyChanged.includes('CHANGELOG.md'));
    assert.ok(changelogEditors.length > 0, 'precondition: some step is contracted to edit CHANGELOG.md');
    for (const { s, i } of changelogEditors) {
      assert.ok(i < vbIdx,
        `"${s.id}" edits CHANGELOG.md but runs at ${i}, after version-bump at ${vbIdx} — `
        + 'its edit would be discarded by the commit flush of version-bump\'s staged snapshot');
    }
  });

  it('changelog-update precedes version-bump precedes commit', () => {
    assert.ok(idx('changelog-update') < idx('version-bump'));
    assert.ok(idx('version-bump') < idx('commit'));
  });

  // The step order used to live in a per-project JSON template, so reaching an
  // already-onboarded install needed a `schemaRevision` ratchet — pinned here by
  // a per-revision order fingerprint, plus a suite proving the re-sync landed.
  // The pipeline is code now (#538): the order ships with the code that runs it
  // and cannot lag on any install, so there is nothing left to propagate. The
  // order itself is pinned in test/wrap-default-pipeline.test.js.
});

describe('wrap CHANGELOG transaction — the AI edit survives into the release', () => {
  let savedInternal;
  let savedLoad;

  beforeEach(() => {
    savedInternal = { ...vb._internal };
    savedLoad = store.projectConfig.load;
    store.projectConfig.load = () => ({});
    vb._internal.todayIso = () => '2026-07-19';
  });

  afterEach(() => {
    Object.assign(vb._internal, savedInternal);
    store.projectConfig.load = savedLoad;
  });

  it('version-bump promotes the AI entry it finds on disk (so the release contains it)', async () => {
    vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('CHANGELOG.md');
    vb._internal.readFileSync = (p) => (p.endsWith('version.json')
      ? '{"version":"1.4.2"}'
      : CHANGELOG_WITH_AI_EDIT);

    const context = {
      project: { name: 'p', path: '/p' },
      step: { id: 'version-bump', kind: 'version-bump' },
      staged: {},
      options: {}
    };
    const res = await vb.run(context);

    assert.equal(res.status, 'done', 'precondition: the bump happened');
    const stagedChangelog = context.staged['version-bump:changelog'];
    assert.ok(stagedChangelog, 'the changelog promote was staged');
    assert.ok(stagedChangelog.newContent.includes(AI_LINE),
      'THE PIN: the promoted changelog carries the AI-written entry — running version-bump '
      + 'after changelog-update is what puts the session entry inside the release section');
    assert.match(stagedChangelog.newContent, /## \[1\.5\.0\] - 2026-07-19/,
      'and the entry was promoted into a dated release heading');
  });
});

describe('wrap CHANGELOG transaction — why the order matters (the clobber mechanism)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-clobber-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('the commit flush overwrites an on-disk edit made after a write was staged', () => {
    // This documents the mechanism the step order defends against: staged
    // whole-file content is written back verbatim, with no re-read and no merge.
    const target = path.join(tmpDir, 'CHANGELOG.md');
    fs.writeFileSync(target, 'snapshot taken here\n');
    const staged = {
      'version-bump:changelog': {
        primingPath: target,
        newContent: 'snapshot taken here\n',
        changed: true
      }
    };
    // ...an agent edits the same file after the snapshot was staged...
    fs.writeFileSync(target, 'snapshot taken here\nAI ADDED THIS\n');

    commit._flushStagedWrites(staged);

    assert.equal(fs.readFileSync(target, 'utf8'), 'snapshot taken here\n',
      'the flush discards the later on-disk edit — hence the ordering invariant above');
  });
});

// ---------------------------------------------------------------------------
// #1220 C03 — changelog fragments ride the release cut, and the cut is
// recoverable until its commit lands. Real repositories throughout: which files
// a commit holds, what the index records and what `git status` reports are
// git's answers, and the recovery is proven by comparing them before and after.
// ---------------------------------------------------------------------------
const { after } = require('node:test');
const { execFileSync } = require('node:child_process');
const launchBaseline = require('../lib/launch-baseline');
const wrapScope = require('../lib/wrap-scope');
const { execFileArgs } = require('../lib/exec');
const { initRepo } = require('./_temp-repo');

const repoDirs = [];
after(() => { for (const d of repoDirs) fs.rmSync(d, { recursive: true, force: true }); });

const FRAGMENT = '- A feature the fragment records (#7)\n';
const UNRELEASED_EMPTY = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- first\n';
const RELEASE_TARGETS = ['CHANGELOG.md', 'version.json', 'changelog.d'];

/**
 * Run git in a repo.
 * @param {string} cwd - Repo directory.
 * @param {...string} args - Argv after `git`.
 * @returns {string} Trimmed stdout.
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A temp directory removed after the suite.
 * @param {string} prefix - Directory name prefix.
 * @param {{resolve?:boolean}} [opts] - `resolve: false` keeps the path as `os.tmpdir()` spells it (a symlink on macOS).
 * @returns {string} Path.
 */
function tmpRepoDir(prefix, { resolve = true } = {}) {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = resolve ? fs.realpathSync(made) : made;
  repoDirs.push(dir);
  return dir;
}

/**
 * A released project with committed fragments, on a feature branch, its project
 * config committed so the config file is not itself an uncommitted change.
 * @param {object} [opts]
 * @param {object} [opts.config] - `.tangleclaw/project.json` contents.
 * @param {boolean} [opts.resolve] - See {@link tmpRepoDir}.
 * @param {Record<string,string>} [opts.fragments] - `changelog.d/` files by name.
 * @returns {string} Repo path.
 */
function makeFragmentRepo({ config = {}, resolve = true, fragments = { '7.feature.added.md': FRAGMENT } } = {}) {
  const dir = tmpRepoDir('tc-frag-txn-', { resolve });
  initRepo(dir, ['-q', '-b', 'main']);
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'version.json'), '{\n  "version": "1.0.0"\n}\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), UNRELEASED_EMPTY);
  fs.mkdirSync(path.join(dir, 'changelog.d'));
  for (const [name, body] of Object.entries(fragments)) fs.writeFileSync(path.join(dir, 'changelog.d', name), body);
  fs.mkdirSync(path.join(dir, '.tangleclaw'));
  fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), JSON.stringify(config));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/session');
  return dir;
}

/**
 * Everything a restore must bring back: the release files' bytes, the index
 * entries of the release targets, and the whole `git status`.
 * @param {string} repo - Repo path.
 * @returns {{files:Record<string,string|null>, index:string, status:string}}
 */
function treeState(repo) {
  const files = {};
  for (const rel of ['CHANGELOG.md', 'version.json']) {
    files[rel] = fs.existsSync(path.join(repo, rel)) ? fs.readFileSync(path.join(repo, rel), 'utf8') : null;
  }
  const fragDir = path.join(repo, 'changelog.d');
  for (const name of (fs.existsSync(fragDir) ? fs.readdirSync(fragDir) : [])) {
    files[`changelog.d/${name}`] = fs.readFileSync(path.join(fragDir, name), 'utf8');
  }
  return {
    files,
    index: execFileSync('git', ['ls-files', '-s', '--', ...RELEASE_TARGETS], { cwd: repo, encoding: 'utf8' }),
    status: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })
  };
}

/**
 * Run version-bump then commit as the pipeline would, for a session launched now.
 * @param {string} repo - Repo path.
 * @param {object} [opts]
 * @param {object} [opts.options] - Run options.
 * @param {object|null} [opts.baseline] - Launch baseline; captured now when omitted.
 * @param {string} [opts.runId] - The wrap run id the recovery record is keyed by.
 * @returns {Promise<{bump:object, commitRes:object, staged:object, artifactDir:string}>}
 */
async function runCut(repo, { options = {}, baseline = launchBaseline.capture(repo), runId = 'run-test' } = {}) {
  const scope = await wrapScope.resolve({ name: 'own', path: repo }, { id: 1, tmuxSession: 'own', startedAt: '2000-01-01 00:00:00' }, {
    exec: (file, args, opts) => execFileArgs(file, args, { cwd: opts.cwd, timeoutMs: 10000, maxBufferBytes: 1024 * 1024 }),
    paneCurrentPath: () => repo,
    getLaunchBaseline: () => baseline
  });
  const project = wrapScope.stepProject({ id: 1, name: 'own', path: repo }, scope);
  const staged = {};
  const bump = await vb.run({ project, step: { id: 'version-bump', kind: 'version-bump' }, staged, options, previousResults: [] });
  const commitRes = await commit.run({ project, session: null, step: { id: 'commit' }, previousResults: [], staged, options, scope, wrapRunId: runId });
  return { bump, commitRes, staged, artifactDir: path.join(scope.configRoot, vb.RELEASE_RECOVERY_REL, runId) };
}

/**
 * Make one git command fail through the commit step's exec seam.
 * @param {(args:string[]) => boolean} predicate - Which git argv to refuse.
 * @param {object} [result] - Fields merged over the refusal.
 * @returns {() => void} Restores the seam.
 */
function failGit(predicate, result = {}) {
  const orig = commit._internal.exec;
  commit._internal.exec = async (file, args, opts) => (file === 'git' && predicate(args)
    ? { exitCode: 1, stdout: '', stderr: 'seam: refused', error: null, timedOut: false, ...result }
    : orig(file, args, opts));
  return () => { commit._internal.exec = orig; };
}

/**
 * `git status` over the release targets only: a landed commit also stamps the
 * untracked `.tangleclaw/state.json`, which is the wrap's boundary, not a release file.
 * @param {string} repo - Repo path.
 * @returns {string} Porcelain output.
 */
function releaseStatus(repo) {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...RELEASE_TARGETS], { cwd: repo, encoding: 'utf8' });
}

/**
 * Files in the HEAD commit, deletions included.
 * @param {string} repo - Repo path.
 * @returns {string[]} Sorted paths.
 */
function committedFiles(repo) {
  return git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
}

describe('wrap CHANGELOG transaction — fragments ride the release cut, recoverably (#1220 C03)', () => {
  let savedInternal;
  let savedCommitInternal;

  beforeEach(() => {
    savedInternal = { ...vb._internal };
    savedCommitInternal = { ...commit._internal };
    vb._internal.todayIso = () => '2026-10-21';
  });

  afterEach(() => {
    Object.assign(vb._internal, savedInternal);
    Object.assign(commit._internal, savedCommitInternal);
  });

  describe('Safeguard 1 — the flush deletes a staged fragment, and the snapshot carries it', () => {
    it('_flushStagedWrites unlinks a delete entry, reports it, and refuses one already gone', () => {
      const dir = tmpRepoDir('tc-frag-flush-');
      const target = path.join(dir, 'changelog.d', '7.feature.added.md');
      fs.mkdirSync(path.dirname(target));
      fs.writeFileSync(target, FRAGMENT);
      const staged = { 'version-bump:fragment:7.feature.added.md': { primingPath: target, newContent: null, delete: true, changed: true, fragment: true } };

      assert.deepEqual(commit._flushStagedWrites(staged), [{ stepId: 'version-bump:fragment:7.feature.added.md', path: target, deleted: true }]);
      assert.equal(fs.existsSync(target), false);
      assert.throws(() => commit._flushStagedWrites(staged), { code: 'ENOENT' }, 'a fragment already gone is an error, not a silent success');
      assert.ok(commit._isDeleteEntry(staged['version-bump:fragment:7.feature.added.md']));
      assert.equal(commit._isDeleteEntry({ primingPath: target, delete: true }), false, 'newContent must be exactly null');
      assert.equal(commit._isDeleteEntry({ primingPath: target, newContent: null }), false, 'delete must be stated');
      assert.deepEqual(commit._flushStagedWrites({ x: { primingPath: target, newContent: undefined, delete: true } }), [], 'an entry with no content is still skipped');
    });

    it('_snapshotStagedTargets records a delete target\'s prior bytes, and _restoreSnapshot puts them back byte for byte', () => {
      const dir = tmpRepoDir('tc-frag-snap-');
      const target = path.join(dir, '7.feature.added.md');
      const bytes = Buffer.from('- entry with trailing spaces   \r\n  and a continuation\n');
      fs.writeFileSync(target, bytes);
      const staged = { f: { primingPath: target, newContent: null, delete: true, changed: true } };
      const snapshot = commit._snapshotStagedTargets(staged);
      assert.equal(snapshot.length, 1);
      assert.equal(snapshot[0].existed, true);
      assert.ok(Buffer.isBuffer(snapshot[0].content));
      commit._flushStagedWrites(staged);
      assert.equal(fs.existsSync(target), false);
      assert.deepEqual(commit._restoreSnapshot(snapshot), []);
      assert.ok(fs.readFileSync(target).equals(bytes), 'byte-identical, CRLF and trailing spaces included');
    });
  });

  describe('Safeguard 2 — a deleted path still resolves under a symlinked root', () => {
    it('_realpathOr resolves a missing file through its real parent', () => {
      const real = tmpRepoDir('tc-frag-real-');
      const link = path.join(tmpRepoDir('tc-frag-link-'), 'via-link');
      fs.symlinkSync(real, link);
      assert.equal(commit._realpathOr(path.join(link, 'gone.md')), path.join(real, 'gone.md'));
      assert.equal(commit._realpathOr(path.join(link, 'deeper', 'gone.md')), path.join(real, 'deeper', 'gone.md'));
      fs.writeFileSync(path.join(real, 'here.md'), 'x');
      assert.equal(commit._realpathOr(path.join(link, 'here.md')), path.join(real, 'here.md'));
    });

    it('a fragment deletion under os.tmpdir() as spelled (a symlink on macOS) lands in the commit', async () => {
      const repo = makeFragmentRepo({ resolve: false });
      const { bump, commitRes } = await runCut(repo);
      assert.equal(bump.status, 'done', JSON.stringify(bump));
      assert.equal(commitRes.status, 'done', JSON.stringify(commitRes.blockers));
      assert.ok(committedFiles(repo).includes('changelog.d/7.feature.added.md'), committedFiles(repo).join(', '));
      assert.equal(releaseStatus(repo), '');
    });
  });

  describe('the cut as one transaction', () => {
    it('a successful cut commits the promoted CHANGELOG, the bump and the fragment deletion as one commit, and removes the recovery record', async () => {
      const repo = makeFragmentRepo();
      const head = git(repo, 'rev-parse', 'HEAD');
      const { bump, commitRes, artifactDir } = await runCut(repo);

      assert.equal(bump.status, 'done', JSON.stringify(bump));
      assert.deepEqual(bump.output.fragments, { compiled: 1, files: ['7.feature.added.md'] });
      assert.equal(commitRes.status, 'done', JSON.stringify(commitRes.blockers));
      assert.notEqual(git(repo, 'rev-parse', 'HEAD'), head);
      assert.deepEqual(committedFiles(repo), ['CHANGELOG.md', 'changelog.d/7.feature.added.md', 'version.json']);
      assert.match(git(repo, 'show', 'HEAD:CHANGELOG.md'), /## \[Unreleased\]\n\n## \[1\.1\.0\] - 2026-10-21\n\n### Added\n- A feature the fragment records \(#7\)\n\n## \[1\.0\.0\]/);
      assert.throws(() => git(repo, 'cat-file', '-e', 'HEAD:changelog.d/7.feature.added.md'), 'the fragment is gone from the tree');
      assert.match(commitRes.output.message, /- Bumped 1\.0\.0 → 1\.1\.0 \(minor\)\n- Compiled 1 changelog fragment\(s\)/);
      assert.ok(commitRes.output.flushed.some((f) => f.deleted === true && f.path.endsWith('7.feature.added.md')));
      assert.deepEqual(commitRes.output.releaseRecovery, { artifactDir, removed: true });
      assert.equal(fs.existsSync(artifactDir), false, 'the record is removed once the commit landed');
      assert.equal(releaseStatus(repo), '', 'the release files are clean; the wrap state stamp is the only untracked file');
    });

    it('a failing releasePrepareCommand puts CHANGELOG, the version file and the fragment back byte for byte', async () => {
      const repo = makeFragmentRepo({ config: { releasePrepareCommand: 'exit 1' } });
      const before = treeState(repo);
      const head = git(repo, 'rev-parse', 'HEAD');
      const { commitRes, artifactDir } = await runCut(repo);

      assert.equal(commitRes.status, 'blocked');
      assert.match(commitRes.blockers[0], /releasePrepareCommand exited 1/);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'nothing was committed');
      assert.deepEqual(treeState(repo), before, 'files, index and status are the pre-cut state');
      assert.match(commitRes.output.remediation, /consumed changelog fragments were put back, so Retry cuts the release again from scratch/);
      assert.doesNotMatch(commitRes.output.remediation, /git checkout/, 'no checkout is ever recommended: it would discard an untracked fragment and unrelated edits');
      assert.equal(commitRes.output.releaseRecovery.retained, false);
      assert.equal(fs.existsSync(artifactDir), false);
    });
  });

  describe('Safeguard 3 — recovery after the flush, with no releasePrepareCommand at all', () => {
    it('a failing git add restores the work tree and the index, and removes the record', async () => {
      const repo = makeFragmentRepo();
      const before = treeState(repo);
      const restore = failGit((args) => args[0] === 'add');
      let out;
      try { out = await runCut(repo); } finally { restore(); }

      assert.equal(out.commitRes.status, 'blocked');
      assert.match(out.commitRes.blockers[0], /git add failed/);
      assert.deepEqual(treeState(repo), before);
      assert.match(out.commitRes.output.remediation, /were put back, and the index entries of those files with them, so Retry cuts the release again/);
      assert.equal(out.commitRes.output.releaseRecovery.indexRestored, true);
      assert.deepEqual(out.commitRes.output.releaseRecovery.problems, []);
      assert.equal(fs.existsSync(out.artifactDir), false);
    });

    it('a rejected git commit (not a timeout) restores the same, index included, after a real git add', async () => {
      const repo = makeFragmentRepo();
      const before = treeState(repo);
      const restore = failGit((args) => args[0] === 'commit');
      let out;
      try { out = await runCut(repo); } finally { restore(); }

      assert.equal(out.commitRes.status, 'blocked');
      assert.match(out.commitRes.blockers[0], /git commit failed/);
      assert.deepEqual(treeState(repo), before, 'the real git add staged the cut; the restore unstaged it exactly');
      assert.equal(fs.existsSync(out.artifactDir), false);
    });

    it('a git commit stopped by its timeout restores nothing, keeps the record, and names it', async () => {
      const repo = makeFragmentRepo();
      const before = treeState(repo);
      const restore = failGit((args) => args[0] === 'commit', { timedOut: true, error: 'timed out after 1ms' });
      let out;
      try { out = await runCut(repo); } finally { restore(); }

      assert.equal(out.commitRes.status, 'blocked');
      assert.match(out.commitRes.blockers[0], /git commit did not finish and was stopped/);
      const after_ = treeState(repo);
      assert.notEqual(after_.files['CHANGELOG.md'], before.files['CHANGELOG.md'], 'the promoted CHANGELOG stays, since the commit may still land');
      assert.equal(after_.files['changelog.d/7.feature.added.md'], undefined, 'the fragment stays consumed');
      assert.ok(fs.existsSync(path.join(out.artifactDir, 'manifest.json')), 'the record is retained');
      assert.equal(out.commitRes.output.releaseRecovery.retained, true);
      assert.match(out.commitRes.output.remediation, /were NOT put back/);
      assert.match(out.commitRes.output.remediation, /Run `git log -1` first/);
      assert.ok(out.commitRes.output.remediation.includes(out.artifactDir));
      assert.doesNotMatch(after_.status, /release-recovery/, 'the record ignores itself: git never sees it');
      const manifest = JSON.parse(fs.readFileSync(path.join(out.artifactDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.runId, 'run-test');
      assert.deepEqual(manifest.cut, { from: '1.0.0', to: '1.1.0' });
      const fragmentTarget = manifest.targets.find((t) => t.path.endsWith('7.feature.added.md'));
      assert.equal(fragmentTarget.existed, true);
      assert.equal(fs.readFileSync(path.join(out.artifactDir, fragmentTarget.file), 'utf8'), FRAGMENT, 'the record holds the fragment\'s exact prior bytes');
      assert.equal(fragmentTarget.repoPath, 'changelog.d/7.feature.added.md');
      assert.match(fragmentTarget.index.object, /^[0-9a-f]{40}$/, 'and its index entry');
    });

    it('an untracked fragment whose restore fails stays recoverable from the record, which names itself', async () => {
      const repo = makeFragmentRepo();
      const baseline = launchBaseline.capture(repo);
      const untracked = path.join(repo, 'changelog.d', '8.new.fixed.md');
      const untrackedBytes = '- a fix this session added and never committed (#8)\n';
      fs.writeFileSync(untracked, untrackedBytes);
      commit._internal.writeFileSync = (p, c) => {
        if (String(p).endsWith('8.new.fixed.md')) throw new Error('disk full');
        return fs.writeFileSync(p, c);
      };
      const restore = failGit((args) => args[0] === 'add');
      let out;
      try { out = await runCut(repo, { baseline }); } finally { restore(); }

      assert.equal(out.commitRes.status, 'blocked');
      const report = out.commitRes.output.releaseRecovery;
      assert.equal(report.retained, true);
      assert.ok(report.putBack.some((p) => p.endsWith('CHANGELOG.md')) && report.putBack.some((p) => p.endsWith('version.json')) && report.putBack.some((p) => p.endsWith('7.feature.added.md')));
      assert.ok(report.problems.some((p) => p.includes('8.new.fixed.md') && p.includes('disk full')));
      assert.equal(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), UNRELEASED_EMPTY);
      assert.equal(fs.existsSync(untracked), false, 'the one file that could not be put back');
      assert.ok(fs.existsSync(path.join(out.artifactDir, 'manifest.json')));
      const manifest = JSON.parse(fs.readFileSync(path.join(out.artifactDir, 'manifest.json'), 'utf8'));
      const target = manifest.targets.find((t) => t.path === untracked);
      assert.equal(target.existed, true);
      assert.equal(target.index, null, 'recorded as absent from the index: HEAD never held it');
      assert.equal(fs.readFileSync(path.join(out.artifactDir, target.file), 'utf8'), untrackedBytes, 'the exact bytes of a fragment HEAD does not hold');
      assert.match(out.commitRes.output.remediation, /Not everything was put back/);
      assert.ok(out.commitRes.output.remediation.includes(out.artifactDir), 'the manifest\'s directory is named');
      assert.match(out.commitRes.output.remediation, /No release is cut while it exists/);
      assert.doesNotMatch(out.commitRes.output.remediation, /from scratch/, 'never says the tree is clean');
      assert.doesNotMatch(treeState(repo).status, /release-recovery/);
      // And the next cut refuses until it is dealt with.
      Object.assign(commit._internal, savedCommitInternal);
      const next = await runCut(repo, { runId: 'run-next' });
      assert.equal(next.bump.status, 'needs-operator');
      assert.match(next.bump.output.reason, /did not land and its files' prior bytes are still unrecovered/);
    });

    it('an unrelated uncommitted edit to CHANGELOG.md survives a restore', async () => {
      const repo = makeFragmentRepo();
      const baseline = launchBaseline.capture(repo);
      const edited = `${UNRELEASED_EMPTY}\n<!-- an operator note, uncommitted -->\n`;
      fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), edited);
      const restore = failGit((args) => args[0] === 'add');
      let out;
      try { out = await runCut(repo, { baseline }); } finally { restore(); }

      assert.equal(out.commitRes.status, 'blocked');
      assert.equal(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), edited, 'the edit, not HEAD, is what comes back');
      assert.equal(fs.existsSync(out.artifactDir), false);
    });

    for (const [how, arrange] of [
      ['a failing git add', (repo) => failGit((args) => args[0] === 'add')],
      ['a failing pre-commit hook', (repo) => {
        // `initRepo` copies no template, so the hooks directory starts absent.
        fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook refused" >&2\nexit 1\n', { mode: 0o755 });
        return () => fs.rmSync(path.join(repo, '.git', 'hooks', 'pre-commit'));
      }]
    ]) {
      it(`pre-existing partial staging of the release targets is put back exactly: ${how}`, async () => {
        const repo = makeFragmentRepo();
        const baseline = launchBaseline.capture(repo);
        // The operator's own staged hunk on CHANGELOG.md, and a staged new fragment.
        fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), `${UNRELEASED_EMPTY}\n<!-- staged by the operator -->\n`);
        git(repo, 'add', 'CHANGELOG.md');
        fs.writeFileSync(path.join(repo, 'changelog.d', '9.staged.fixed.md'), '- staged, not committed (#9)\n');
        git(repo, 'add', 'changelog.d/9.staged.fixed.md');
        const before = treeState(repo);
        assert.match(before.status, /^M  CHANGELOG\.md$/m);
        assert.match(before.status, /^A  changelog\.d\/9\.staged\.fixed\.md$/m);
        const restore = arrange(repo);
        let out;
        try { out = await runCut(repo, { baseline }); } finally { restore(); }

        assert.equal(out.commitRes.status, 'blocked', JSON.stringify(out.commitRes));
        assert.deepEqual(out.bump.output.fragments.files, ['7.feature.added.md', '9.staged.fixed.md']);
        const after_ = treeState(repo);
        assert.equal(after_.index, before.index, 'git ls-files -s on the targets is byte-identical to the pre-add record');
        assert.equal(after_.status, before.status, 'git status is identical to the pre-wrap state');
        assert.deepEqual(after_.files, before.files);
        assert.equal(fs.existsSync(out.artifactDir), false);
      });
    }

    it('a failed index restore retains the record and prints the repair', async () => {
      const repo = makeFragmentRepo();
      const restore = failGit((args) => args[0] === 'commit' || args[0] === 'update-index');
      let out;
      try { out = await runCut(repo); } finally { restore(); }

      assert.equal(out.commitRes.status, 'blocked');
      const report = out.commitRes.output.releaseRecovery;
      assert.equal(report.indexRestored, false);
      assert.equal(report.retained, true);
      assert.ok(report.problems.some((p) => /index entries of the release files could not be put back/.test(p)));
      assert.ok(fs.existsSync(path.join(out.artifactDir, 'manifest.json')));
      assert.match(out.commitRes.output.remediation, /git update-index --add --cacheinfo <mode>,<object>,<path>/);
      assert.equal(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), UNRELEASED_EMPTY, 'the work tree was still put back');
    });

    it('a failing pre-add index read refuses the cut with nothing flushed', async () => {
      const repo = makeFragmentRepo();
      const before = treeState(repo);
      const restore = failGit((args) => args[0] === 'ls-files');
      let out;
      try { out = await runCut(repo); } finally { restore(); }

      assert.equal(out.bump.status, 'done');
      assert.equal(out.commitRes.status, 'blocked');
      assert.match(out.commitRes.blockers[0], /release cut refused: the index entries of the release files could not be recorded/);
      assert.match(out.commitRes.output.remediation, /Nothing was written or committed/);
      assert.deepEqual(treeState(repo), before);
      assert.equal(fs.existsSync(path.dirname(out.artifactDir)), false, 'no record was written either');
    });

    it('a cut whose every release file was left out of the commit is put back, and the skip says so', async () => {
      const repo = makeFragmentRepo();
      fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), `${UNRELEASED_EMPTY}\n<!-- dirty at launch -->\n`);
      fs.writeFileSync(path.join(repo, 'version.json'), '{\n  "version": "1.0.0",\n  "note": "dirty at launch"\n}\n');
      fs.writeFileSync(path.join(repo, 'changelog.d', '7.feature.added.md'), `${FRAGMENT}  with a continuation line added before launch\n`);
      const baseline = launchBaseline.capture(repo);
      const before = treeState(repo);
      const leave = { 'CHANGELOG.md': 'leave', 'version.json': 'leave', 'changelog.d/7.feature.added.md': 'leave' };
      const out = await runCut(repo, { baseline, options: { pathDecisions: leave } });

      assert.equal(out.bump.status, 'done');
      assert.equal(out.commitRes.status, 'skipped', JSON.stringify(out.commitRes));
      assert.match(out.commitRes.output.reason, /every uncommitted file was left out; the release cut was put back/);
      assert.deepEqual(treeState(repo), before, 'the dirty-at-launch bytes, fragment included, are back');
      assert.equal(out.commitRes.output.releaseRecovery.retained, false);
      assert.equal(fs.existsSync(out.artifactDir), false);
    });
  });
});
