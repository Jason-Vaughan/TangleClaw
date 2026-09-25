'use strict';

/*
 * What kind of file a wrap is being asked to commit (#1858).
 *
 * The unit half pins the classifier's boundaries. The other half drives the
 * real `session-files` and `commit` steps against real repositories, because the
 * defect was a real Include putting a real SQLite file into a real wrap
 * selection, and only git can confirm what a pathspec commit leaves out.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const safety = require('../lib/wrap-steps/_file-safety');
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

/** Bytes that make a file a SQLite database to anything reading its header. */
const SQLITE_BYTES = Buffer.concat([safety.SQLITE_HEADER, Buffer.alloc(84)]);

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
 * A scratch directory removed after the run.
 * @param {string} prefix - mkdtemp prefix.
 * @returns {string}
 */
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/**
 * Write a file, creating its directories.
 * @param {string} root - Repo root.
 * @param {string} rel - Relative path.
 * @param {string|Buffer} content - Content.
 */
function put(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

/**
 * A repo on a feature branch whose `data/` directory already carries tracked
 * source, as TangleClaw's own does, and a tracked file the session edits.
 * @returns {string}
 */
function makeRepo() {
  const dir = tmp('tc-safe-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  put(dir, 'README.md', 'init\n');
  put(dir, 'mine.js', 'v0\n');
  put(dir, 'data/engines/claude.json', '{}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/session');
  return dir;
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
  return wrapScope.resolve({ name: 'safe', path: repo }, { id: 1, tmuxSession: 'safe', startedAt: '2000-01-01 00:00:00' }, {
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
 * @returns {Promise<object>}
 */
function runStep(step, repo, scope, options = {}) {
  return step.run({
    project: wrapScope.stepProject({ id: 1, name: 'safe', path: repo }, scope),
    session: null,
    step: { id: step === commitStep ? 'commit' : 'session-files' },
    previousResults: [],
    staged: {},
    options,
    scope
  });
}

/**
 * Paths in the last commit.
 * @param {string} repo - Checkout.
 * @returns {string[]}
 */
function committed(repo) {
  return git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
}

describe('safetyOf', () => {
  const classOf = (rel, root = null) => safety.safetyOf(root, rel).class;

  it('protects a database by extension, in any case, and TangleClaw\'s own runtime paths', () => {
    for (const p of ['app.db', 'x/APP.DB', 'store.sqlite', 'a/b.Sqlite3', 'c.db3', 'data/tangleclaw.db', 'data/tangleclaw.sqlite']) {
      assert.equal(classOf(p), 'protected', p);
    }
  });

  it('protects a sidecar only when it belongs to a database name', () => {
    for (const p of ['app.db-wal', 'app.db-shm', 'store.sqlite-journal', 'data/tangleclaw.sqlite-WAL']) {
      assert.equal(classOf(p), 'protected', p);
    }
    for (const p of ['notes-wal', 'docs/pre-journal', 'x.md-shm']) assert.equal(classOf(p), 'ambiguous', p);
  });

  it('calls Thumbs.db a local thumbnail cache, not a database', () => {
    assert.equal(classOf('Thumbs.db'), 'local');
    assert.equal(classOf('img/THUMBS.DB'), 'local');
    assert.equal(classOf('.DS_Store'), 'local');
  });

  it('protects a file by its SQLite header whatever it is called, and never follows a symlink', () => {
    const root = tmp('tc-safe-hdr-');
    put(root, 'dump.bin', SQLITE_BYTES);
    put(root, 'scratch/state', SQLITE_BYTES);
    put(root, 'plain.bin', Buffer.alloc(100));
    fs.symlinkSync(path.join(root, 'dump.bin'), path.join(root, 'link-to-db'));
    assert.equal(classOf('dump.bin', root), 'protected');
    assert.equal(classOf('scratch/state', root), 'protected', 'a database in scratch is still a database');
    assert.equal(classOf('plain.bin', root), 'ambiguous');
    assert.equal(classOf('link-to-db', root), 'ambiguous', 'git commits the link text, not the database');
    assert.equal(classOf('missing.bin', root), 'ambiguous');
  });

  it('calls generic runtime directories local only at the repository root', () => {
    for (const p of ['scratch/triage-plan.md', 'tmp/x', 'TEMP/y', 'cache/z', 'logs/a.txt', 'coverage/lcov.info']) {
      assert.equal(classOf(p), 'local', p);
    }
    for (const p of ['lib/cache/adapter.js', 'src/tmp/parser.js', 'docs/logs/index.md', 'scratch']) {
      assert.equal(classOf(p), 'ambiguous', p);
    }
  });

  it('calls node_modules and .cache local at any depth, and log/temp suffixes local anywhere', () => {
    for (const p of ['node_modules/x/i.js', 'pkg/node_modules/y.js', 'a/.cache/b', 'server.log', 'x/y.TMP', 'e.swp', 'notes.md~']) {
      assert.equal(classOf(p), 'local', p);
    }
  });

  it('recommends Include only for TangleClaw plans, priming prompts and memories', () => {
    for (const p of ['.tangleclaw/plans/a.md', '.tangleclaw/plans/archive/b.md', '.tangleclaw/priming/pm.md', '.tangleclaw/memories/m.md']) {
      assert.deepEqual([classOf(p), safety.safetyOf(null, p).recommendation], ['durable', 'include'], p);
    }
    for (const p of ['.tangleclaw/priming/old/x.md', '.tangleclaw/plans/a.json', 'docs/plan.md', 'lib/new.js']) {
      assert.equal(classOf(p), 'ambiguous', p);
    }
  });

  it('gives each class its recommendation, and ambiguous none', () => {
    assert.equal(safety.safetyOf(null, 'scratch/a').recommendation, 'leave');
    assert.equal(safety.safetyOf(null, 'a.db').recommendation, 'leave');
    assert.equal(safety.safetyOf(null, 'lib/x.js').recommendation, null);
    assert.equal(safety.safetyOf(null, 'lib/x.js').why, null);
  });
});

describe('ignoreSuggestions', () => {
  const classOf = (p) => safety.safetyOf(null, p).class;

  it('offers a root local directory only when nothing tracked or undecided could hide under it', () => {
    const lines = safety.ignoreSuggestions(['scratch/a.json', 'scratch/b.md', 'data/tangleclaw.sqlite'], {
      dirty: ['scratch/a.json', 'scratch/b.md', 'data/tangleclaw.sqlite'],
      hasTracked: (dir) => dir === 'data',
      classOf
    });
    assert.deepEqual(lines, ['/data/tangleclaw.sqlite', '/scratch/']);
    assert.ok(!lines.includes('/data/'), 'data/ carries source, so it is never suggested');
  });

  it('falls back to exact paths when the directory is tracked or holds an ambiguous file', () => {
    const tracked = safety.ignoreSuggestions(['tmp/a'], { dirty: ['tmp/a'], hasTracked: () => true, classOf });
    assert.deepEqual(tracked, ['/tmp/a']);
    const mixed = safety.ignoreSuggestions(['tmp/a'], { dirty: ['tmp/a', 'tmp/keep.js'], hasTracked: () => false, classOf: (p) => (p === 'tmp/keep.js' ? 'ambiguous' : 'local') });
    assert.deepEqual(mixed, ['/tmp/a']);
  });

  it('escapes every trailing space, so gitignore does not drop it and ignore a different file', () => {
    assert.deepEqual(safety.ignoreSuggestions(['notes.db  ', 'a b.db '], { dirty: [], hasTracked: () => true, classOf }),
      ['/a b.db\\ ', '/notes.db\\ \\ ']);
  });

  it('offers no line at all for a path with a line break, rather than a line that splits into rules', () => {
    const lines = safety.ignoreSuggestions(['evil.db\n!important.js', 'cr.db\r', 'ok.db'], { dirty: [], hasTracked: () => true, classOf });
    assert.deepEqual(lines, ['/ok.db']);
    assert.ok(lines.every((l) => !/[\r\n]/.test(l)));
  });

  it('escapes gitignore syntax so a line names exactly one file', () => {
    assert.deepEqual(safety.ignoreSuggestions(['we*rd[1].db', '#x.db', '!y.db'], { dirty: [], hasTracked: () => true, classOf }),
      ['/\\!y.db', '/\\#x.db', '/we\\*rd\\[1\\].db']);
  });
});

describe('the #1858 incident, end to end', () => {
  /**
   * Two new plans, a runtime database and three scratch files, as the PM wrap saw.
   * @returns {Promise<{repo:string, scope:object}>}
   */
  async function incidentTree() {
    const repo = makeRepo();
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    put(repo, 'mine.js', 'session edit\n');
    put(repo, '.tangleclaw/plans/one.md', '# one\n');
    put(repo, '.tangleclaw/plans/two.md', '# two\n');
    put(repo, 'data/tangleclaw.sqlite', SQLITE_BYTES);
    put(repo, 'scratch/b1_rules.json', '{}\n');
    put(repo, 'scratch/builder2-1628-dispatch.md', 'x\n');
    put(repo, 'scratch/triage-plan.md', 'y\n');
    return { repo, scope };
  }

  const PLANS = ['.tangleclaw/plans/one.md', '.tangleclaw/plans/two.md'];
  const SCRATCH = ['scratch/b1_rules.json', 'scratch/builder2-1628-dispatch.md', 'scratch/triage-plan.md'];
  const DB = 'data/tangleclaw.sqlite';

  it('recommends Include only for the plans, withholds the database, and preselects nothing', async () => {
    const { repo, scope } = await incidentTree();
    const r = await runStep(sessionFiles, repo, scope);
    assert.equal(r.status, 'blocked');
    const asked = Object.fromEntries(r.output.foreignPaths.map((f) => [f.path, f.recommendation]));
    assert.deepEqual(Object.keys(asked).sort(), [...PLANS, ...SCRATCH].sort(), 'the database is not a choice');
    for (const p of PLANS) assert.equal(asked[p], 'include', p);
    for (const p of SCRATCH) assert.equal(asked[p], 'leave', p);
    assert.deepEqual(r.output.safetyWithheld, [DB]);
    assert.deepEqual(r.output.manifest.protected, [DB]);
    assert.deepEqual(r.output.manifest.unresolved.sort(), [...PLANS, ...SCRATCH].sort(), 'advice is not an answer');
    assert.deepEqual(r.output.manifest.commit, ['mine.js']);
    assert.match(r.output.remediation, /separate ordinary commit outside the wrap/);
  });

  it('applying the recommendations commits the plans and leaves the database and scratch on disk', async () => {
    const { repo, scope } = await incidentTree();
    const options = { pathDecisions: Object.fromEntries([...PLANS.map((p) => [p, 'include']), ...SCRATCH.map((p) => [p, 'leave'])]) };
    const pre = await runStep(sessionFiles, repo, scope, options);
    assert.equal(pre.status, 'done');
    assert.deepEqual(pre.output.ignoreSuggestions, [`/${DB}`, '/scratch/'], 'exact database path; never data/');
    const r = await runStep(commitStep, repo, scope, options);
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(committed(repo), ['mine.js', ...PLANS].sort());
    for (const p of [DB, ...SCRATCH]) assert.ok(fs.existsSync(path.join(repo, p)), `${p} is still on disk`);
    assert.deepEqual(r.output.manifest.protected, [DB]);
    assert.deepEqual(r.output.manifest.keepLocal.sort(), SCRATCH);
  });

  it('Include for all six never stages the database, and says the Include was ignored', async () => {
    const { repo, scope } = await incidentTree();
    const options = { pathDecisions: Object.fromEntries([...PLANS, ...SCRATCH, DB].map((p) => [p, 'include'])) };
    const pre = await runStep(sessionFiles, repo, scope, options);
    assert.equal(pre.status, 'done');
    assert.deepEqual(pre.output.refusedIncludes, [DB]);
    assert.match(pre.output.detail, /Include ignored for 1 database file/);
    const r = await runStep(commitStep, repo, scope, options);
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.ok(!committed(repo).includes(DB));
    assert.deepEqual(r.output.refusedIncludes, [DB]);
    assert.match(git(repo, 'status', '--porcelain'), /^\?\? data\/tangleclaw\.sqlite$/m);
  });

  it('the commit step refuses a forged Include even when session-files never ran', async () => {
    const { repo, scope } = await incidentTree();
    const forged = { pathDecisions: { [DB]: 'include', [`${DB}-wal`]: 'include', ...Object.fromEntries([...PLANS, ...SCRATCH].map((p) => [p, 'leave'])) } };
    put(repo, `${DB}-wal`, 'wal\n');
    const r = await runStep(commitStep, repo, scope, forged);
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(committed(repo), ['mine.js']);
    assert.deepEqual(r.output.refusedIncludes.sort(), [DB, `${DB}-wal`]);
  });

  it('a changelog entry is not what a withheld database waits on', async () => {
    const { repo, scope } = await incidentTree();
    const excluded = coverage._excludedFromCommit(repo, scope, { [DB]: 'include' });
    assert.ok(excluded.has(DB), 'included or not, the database is not work the changelog must cover');
  });

  it('a plan that matches a secret rule is not recommended for Include, so Apply cannot commit it', async () => {
    const repo = makeRepo();
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    // Assembled so this file does not itself hold a token-shaped literal.
    const token = ['gh', 'p_'].join('') + 'Ab12Cd34Ef'.repeat(3) + 'Gh56Ij';
    put(repo, '.tangleclaw/plans/leaky.md', `token: ${token}\n`);
    put(repo, '.tangleclaw/plans/clean.md', '# clean\n');
    const r = await runStep(sessionFiles, repo, scope);
    assert.equal(r.status, 'blocked');
    const byPath = Object.fromEntries(r.output.foreignPaths.map((f) => [f.path, f]));
    assert.ok(byPath['.tangleclaw/plans/leaky.md'].secretRules.length > 0);
    assert.equal(byPath['.tangleclaw/plans/leaky.md'].recommendation, null);
    assert.equal(byPath['.tangleclaw/plans/clean.md'].recommendation, 'include');
  });

  it('a new source file stays an ordinary question with no recommendation', async () => {
    const repo = makeRepo();
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    put(repo, 'lib/new-module.js', 'module.exports = 1;\n');
    const r = await runStep(sessionFiles, repo, scope);
    assert.equal(r.status, 'blocked');
    const [entry] = r.output.foreignPaths;
    assert.deepEqual([entry.path, entry.reason, entry.kind, entry.recommendation], ['lib/new-module.js', 'untracked-new', 'ambiguous', null]);
  });
});

describe('#1858: a protected file is withheld from every bucket', () => {
  it('one the session staged itself stays staged and out of the wrap commit', async () => {
    const repo = makeRepo();
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    put(repo, 'mine.js', 'session edit\n');
    put(repo, 'app.db', SQLITE_BYTES);
    git(repo, 'add', 'app.db');
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'app.db': 'include' } });
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(committed(repo), ['mine.js']);
    assert.match(git(repo, 'status', '--porcelain'), /^A {2}app\.db$/m, 'still staged, still uncommitted');
  });

  it('a tracked database the session changed is withheld though it is the session\'s own edit', () => {
    const scope = { snapshotApplies: true, baseline: { dirty: { paths: [] } }, startedAtMs: 0, workToplevel: null };
    const c = ownership.classify(scope, [
      { path: 'fixtures/seed.db', deleted: false, indexRemoved: false, renamePair: null, newToRepo: false },
      { path: 'mine.js', deleted: false, indexRemoved: false, renamePair: null, newToRepo: false }
    ]);
    assert.deepEqual(c.owned, ['mine.js']);
    assert.deepEqual(c.safetyWithheld, ['fixtures/seed.db']);
    assert.ok(!c.stageable.includes('fixtures/seed.db'));
  });

  /**
   * A repo whose `tracked` files are committed, with the session then deleting
   * `gone` and editing `mine.js`, so the wrap has something of its own to commit.
   * @param {Object<string, string|Buffer>} tracked - Path → content.
   * @param {string[]} gone - Paths the session deletes.
   * @returns {Promise<{repo:string, scope:object}>}
   */
  async function sessionDeletes(tracked, gone) {
    const repo = makeRepo();
    for (const [p, content] of Object.entries(tracked)) put(repo, p, content);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'track');
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    for (const p of gone) fs.rmSync(path.join(repo, p));
    put(repo, 'mine.js', 'session edit\n');
    return { repo, scope };
  }

  /**
   * Assert a deletion stayed out of the wrap: still in HEAD, still an unstaged
   * deletion in the work tree, and never in the commit.
   * @param {string} repo - Checkout.
   * @param {string} p - Deleted path.
   */
  function withheldDeletion(repo, p) {
    assert.ok(!committed(repo).includes(p), `${p} is not in the wrap commit`);
    git(repo, 'cat-file', '-e', `HEAD:${p}`);
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Untrimmed: the status code's leading space is part of the answer.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.match(status, new RegExp(`^ D ${escaped}$`, 'm'), `${p} is still an uncommitted deletion`);
  }

  it('a tracked .db the session deleted is withheld, and stays deleted in the work tree only', async () => {
    const { repo, scope } = await sessionDeletes({ 'fixtures/seed.db': 'not read\n' }, ['fixtures/seed.db']);
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'fixtures/seed.db': 'include' } });
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(committed(repo), ['mine.js']);
    assert.deepEqual(r.output.safetyWithheld, ['fixtures/seed.db']);
    assert.deepEqual(r.output.refusedIncludes, ['fixtures/seed.db']);
    withheldDeletion(repo, 'fixtures/seed.db');
  });

  it('a deleted data/tangleclaw.sqlite is withheld', async () => {
    const { repo, scope } = await sessionDeletes({ 'data/tangleclaw.sqlite': SQLITE_BYTES }, ['data/tangleclaw.sqlite']);
    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(committed(repo), ['mine.js']);
    withheldDeletion(repo, 'data/tangleclaw.sqlite');
  });

  it('a deleted database sidecar is withheld by its name', async () => {
    const { repo, scope } = await sessionDeletes({ 'app.db-wal': 'wal\n' }, ['app.db-wal']);
    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(committed(repo), ['mine.js']);
    withheldDeletion(repo, 'app.db-wal');
  });

  it('a deleted file that only its former SQLite header marked follows ownership and commits as a deletion', async () => {
    const { repo, scope } = await sessionDeletes({ 'dump.bin': SQLITE_BYTES }, ['dump.bin']);
    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'done', (r.blockers || []).join('; '));
    assert.deepEqual(committed(repo), ['dump.bin', 'mine.js']);
    assert.deepEqual(r.output.safetyWithheld, []);
    assert.throws(() => git(repo, 'cat-file', '-e', 'HEAD:dump.bin'), 'gone from the project');
  });

  it('only a database left means a skip that says so', async () => {
    const repo = makeRepo();
    const scope = await scopeFor(repo, launchBaseline.capture(repo));
    put(repo, 'app.sqlite', SQLITE_BYTES);
    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'skipped');
    assert.match(r.output.reason, /databases, which a wrap never commits/);
  });
});
