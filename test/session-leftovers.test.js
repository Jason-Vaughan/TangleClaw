'use strict';

/*
 * Did the last session end leaving work behind (#1544)?
 *
 * Most cases fake `git` through `_internal.exec`, so each decides exactly what
 * the checkout shows. Two cases run real git in a temp repository, because the
 * status comparison and the unpushed count are only as right as the git
 * commands behind them. Every case runs on a temp store, never the live one.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const doubles = require('./_exec-results');

const store = require('../lib/store');
const leftovers = require('../lib/session-leftovers');
const launchBaseline = require('../lib/launch-baseline');

const SHA = 'a'.repeat(40);

/**
 * `git status --porcelain -z` output for some paths.
 * @param {string[]} paths
 * @returns {string}
 */
function porcelain(paths) {
  return paths.map((p) => ` M ${p}\0`).join('');
}

/**
 * A fake `execFile` wrapper driven by a scenario.
 * - `toplevel`: what `rev-parse --show-toplevel` prints
 * - `status`: changed paths now
 * - `unpushed`: the `rev-list --count` answer (a number, or raw text)
 * - `fail`: `{toplevel|status|revList: execResult}` to fail that read
 * - `gitMissing`: `git --version` fails too (with `fail.toplevel`), so an
 *   ENOENT means git itself is missing rather than the folder
 * - `hold`: a promise every read waits on
 * @param {object} scenario
 * @returns {{exec: Function, calls: Array<string[]>}}
 */
function fakeGit(scenario) {
  const calls = [];
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', error: null });
  const fail = scenario.fail || {};
  const exec = async (file, args) => {
    assert.equal(file, 'git');
    calls.push(args);
    if (scenario.hold) await scenario.hold;
    if (args[0] === '--version') return scenario.gitMissing ? fail.toplevel : ok('git version 2.x\n');
    if (args[0] === 'rev-parse') return fail.toplevel || ok(`${scenario.toplevel}\n`);
    if (args[0] === 'status') return fail.status || ok(porcelain(scenario.status || []));
    if (args[0] === 'rev-list') return fail.revList || ok(`${scenario.unpushed ?? 0}\n`);
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { exec, calls };
}

describe('session leftovers (#1544)', () => {
  let storeDir;
  let prevBase;
  let project;
  let seq = 0;
  const realExec = leftovers._internal.exec;
  const realNow = leftovers._internal.now;

  before(() => {
    prevBase = store._getBasePath();
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-leftovers-'));
    store.close();
    store._setBasePath(storeDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seq += 1;
    const dir = fs.mkdtempSync(path.join(storeDir, 'proj-'));
    project = store.projects.create({ name: `leftovers-${seq}`, path: dir, engine: 'claude' });
    leftovers._reset();
  });

  afterEach(() => {
    leftovers._internal.exec = realExec;
    leftovers._internal.now = realNow;
    leftovers._reset();
  });

  /**
   * Start a session with a launch baseline and end it.
   * @param {'killed'|'crashed'|'wrapped'|'active'} how
   * @param {object|null} [baseline] - null for none
   * @returns {object} The session
   */
  function sessionThat(how, baseline = { sha: SHA, toplevel: project.path, dirty: { paths: ['already.txt'], truncated: false } }) {
    const s = store.sessions.start({ projectId: project.id, engineId: 'claude', launchBaseline: baseline });
    if (how === 'killed') store.sessions.kill(s.id, 'test');
    if (how === 'crashed') store.sessions.markCrashed(s.id, 'test');
    if (how === 'wrapped') store.sessions.wrap(s.id, 'done');
    return s;
  }

  /**
   * Install a scenario and read the answer after one refresh.
   * @param {object} scenario
   * @returns {Promise<object|null>}
   */
  async function answerWith(scenario) {
    leftovers._internal.exec = fakeGit({ toplevel: project.path, ...scenario }).exec;
    return leftovers.refresh(project);
  }

  describe('when it applies', () => {
    it('answers nothing while a session is active, and spawns nothing', async () => {
      sessionThat('active');
      const git = fakeGit({ toplevel: project.path });
      leftovers._internal.exec = git.exec;
      assert.equal(leftovers.read(project), null);
      assert.equal(await leftovers.refresh(project), null);
      assert.equal(git.calls.length, 0);
    });

    it('answers nothing while an older session is still recorded active', async () => {
      sessionThat('active');
      sessionThat('killed');
      const git = fakeGit({ toplevel: project.path, status: ['x.txt'] });
      leftovers._internal.exec = git.exec;
      assert.equal(leftovers.read(project), null);
      assert.equal(await leftovers.refresh(project), null);
      assert.equal(git.calls.length, 0);
    });

    it('answers nothing when the last session wrapped', async () => {
      sessionThat('wrapped');
      assert.equal(await answerWith({ status: ['new.txt'] }), null);
      assert.equal(leftovers.read(project), null);
    });

    it('answers nothing for a project that never ran a session', () => {
      assert.equal(leftovers.read(project), null);
    });

    it('answers about the latest session only, when an older one was killed', async () => {
      sessionThat('killed');
      sessionThat('wrapped');
      assert.equal(await answerWith({ status: ['new.txt'] }), null);
    });
  });

  describe('what a killed session left', () => {
    it('is clean when nothing changed and nothing is unpushed', async () => {
      const s = sessionThat('killed');
      const a = await answerWith({ status: [], unpushed: 0 });
      assert.equal(a.state, 'clean');
      assert.equal(a.sessionId, s.id);
      assert.equal(a.status, 'killed');
      assert.equal(a.scope, 'session');
      assert.match(a.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(a.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    it('does not count a path that was already changed at launch', async () => {
      sessionThat('killed');
      const a = await answerWith({ status: ['already.txt'], unpushed: 0 });
      assert.equal(a.state, 'clean');
      assert.equal(a.newPathCount, 0);
    });

    it('reports paths changed since launch, sorted and capped, with the total', async () => {
      sessionThat('killed');
      const paths = ['z.txt', 'already.txt', 'b.txt', 'a.txt', 'd.txt', 'c.txt', 'e.txt', 'f.txt'];
      const a = await answerWith({ status: paths, unpushed: 0 });
      assert.equal(a.state, 'left-work');
      assert.equal(a.newPathCount, 7);
      assert.deepEqual(a.newPaths, ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
      assert.equal(a.newPaths.length, leftovers.MAX_PATHS);
      assert.equal(a.snapshotComplete, true);
    });

    it('reports commits since launch that no remote has', async () => {
      sessionThat('killed');
      const git = fakeGit({ toplevel: project.path, status: [], unpushed: 3 });
      leftovers._internal.exec = git.exec;
      const a = await leftovers.refresh(project);
      assert.equal(a.state, 'left-work');
      assert.equal(a.unpushed, 3);
      assert.deepEqual(git.calls.find((c) => c[0] === 'rev-list'), ['rev-list', '--count', `${SHA}..HEAD`, '--not', '--remotes']);
    });

    for (const [label, dirty] of [['was not captured', null], ['was truncated', { paths: ['already.txt'], truncated: true }]]) {
      it(`counts every changed path when the launch list ${label}, and says so`, async () => {
        sessionThat('killed', { sha: SHA, toplevel: project.path, dirty });
        const a = await answerWith({ status: ['already.txt'], unpushed: 0 });
        assert.equal(a.state, 'left-work');
        assert.deepEqual(a.newPaths, ['already.txt']);
        assert.equal(a.snapshotComplete, false);
      });
    }
  });

  describe('a crashed session', () => {
    it('is answered the same way, clean or not', async () => {
      sessionThat('crashed');
      assert.equal((await answerWith({ status: [], unpushed: 0 })).state, 'clean');
      leftovers._reset();
      const a = await answerWith({ status: ['x.txt'], unpushed: 0 });
      assert.equal(a.state, 'left-work');
      assert.equal(a.status, 'crashed');
    });
  });

  describe('when it cannot tell', () => {
    it('says there is no launch record for a session without one, and spawns nothing', async () => {
      sessionThat('killed', null);
      const git = fakeGit({ toplevel: project.path });
      leftovers._internal.exec = git.exec;
      const a = await leftovers.refresh(project);
      assert.equal(a.state, 'unknown');
      assert.match(a.reason, /no launch record/);
      assert.equal(git.calls.length, 0);
    });

    it('does not spawn into a folder the scanner found missing or unreadable, and says which', async () => {
      sessionThat('killed');
      const git = fakeGit({ toplevel: project.path, status: ['x.txt'] });
      leftovers._internal.exec = git.exec;
      const missing = await leftovers.refresh(project, { exists: false, unreadable: null });
      assert.equal(missing.state, 'unknown');
      assert.match(missing.reason, /project folder is missing/);
      const blocked = await leftovers.refresh(project, { exists: false, unreadable: 'Operation not permitted' });
      assert.match(blocked.reason, /could not be read: Operation not permitted/);
      assert.equal(git.calls.length, 0);
      assert.equal((await leftovers.refresh(project, { exists: true, unreadable: null })).state, 'left-work');
    });

    it('passes the scanner facts from a read to the refresh it starts', async () => {
      sessionThat('killed');
      const git = fakeGit({ toplevel: project.path });
      leftovers._internal.exec = git.exec;
      assert.equal(leftovers.read(project, { exists: false, unreadable: null }).state, 'checking');
      await leftovers.refresh(project);
      assert.match(leftovers.read(project).reason, /project folder is missing/);
      assert.equal(git.calls.length, 0);
    });

    it('names a folder removed since the scan, not git, when the spawn cannot start', async () => {
      sessionThat('killed');
      fs.rmSync(project.path, { recursive: true, force: true });
      const a = await leftovers.refresh(project);
      assert.equal(a.state, 'unknown');
      assert.match(a.reason, /project folder is missing/);
      assert.doesNotMatch(a.reason, /git is not installed/);
    });

    it('says the folder is now a different repository', async () => {
      sessionThat('killed');
      const a = await answerWith({ toplevel: '/somewhere/else', status: ['x.txt'] });
      assert.equal(a.state, 'unknown');
      assert.match(a.reason, /different repository \(\/somewhere\/else\)/);
    });

    const failures = [
      ['git is missing', { gitMissing: true, fail: { toplevel: doubles.notFound('git') } }, /git is not installed/],
      ['the folder vanished after the scan', { fail: { toplevel: doubles.notFound('git') } }, /project folder is missing/],
      ['the status read times out', { status: doubles.stopped() }, /git status did not finish in time/],
      ['the status read fails', { status: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n', error: new Error('exit 128') } }, /git status failed: fatal: not a git repository/]
    ];
    for (const [label, fail, reason] of failures) {
      it(`answers unknown with the reason when ${label}`, async () => {
        sessionThat('killed');
        const scenario = fail.fail ? fail : { fail };
        const a = await answerWith({ ...scenario, status: ['x.txt'] });
        assert.equal(a.state, 'unknown');
        assert.match(a.reason, reason);
        assert.equal(a.newPathCount, 0);
      });
    }

    it('keeps the changed paths when only the commit count fails', async () => {
      sessionThat('killed');
      const fail = { revList: { exitCode: 128, stdout: '', stderr: `fatal: bad revision '${SHA}..HEAD'\n`, error: new Error('exit 128') } };
      const a = await answerWith({ fail, status: ['x.txt'] });
      assert.equal(a.state, 'left-work');
      assert.equal(a.unpushed, null);
      assert.match(a.reason, /commits since launch could not be counted: git rev-list failed: fatal: bad revision/);
    });

    it('is unknown, not clean, when nothing changed and the commit count fails', async () => {
      sessionThat('killed');
      const a = await answerWith({ status: [], unpushed: 'not-a-number' });
      assert.equal(a.state, 'unknown');
      assert.match(a.reason, /printed no count/);
    });
  });

  describe('reading from the project list', () => {
    it('says checking, starts one read, and serves the answer after it', async () => {
      sessionThat('killed');
      const git = fakeGit({ toplevel: project.path, status: ['x.txt'], unpushed: 0 });
      leftovers._internal.exec = git.exec;
      const first = leftovers.read(project);
      assert.equal(first.state, 'checking');
      assert.equal(first.checkedAt, null);
      assert.equal(leftovers.read(project).state, 'checking', 'a second read joins the running one');
      await leftovers.refresh(project);
      assert.equal(git.calls.filter((c) => c[0] === 'rev-parse').length, 1, 'one read, not three');
      assert.equal(leftovers.read(project).state, 'left-work');
    });

    it('serves a fresh answer without spawning, and refreshes a stale one', async () => {
      sessionThat('killed');
      let now = 1_000_000;
      leftovers._internal.now = () => now;
      const git = fakeGit({ toplevel: project.path, status: [], unpushed: 0 });
      leftovers._internal.exec = git.exec;
      await leftovers.refresh(project);
      const before = git.calls.length;
      now += leftovers.REFRESH_AFTER_MS - 1;
      assert.equal(leftovers.read(project).state, 'clean');
      assert.equal(git.calls.length, before, 'a fresh answer spawns nothing');
      now += 1;
      assert.equal(leftovers.read(project).state, 'clean', 'the stale answer is still served while it refreshes');
      await leftovers.refresh(project);
      assert.ok(git.calls.length > before, 'a stale answer starts a read');
    });

    it('clears itself once the work is gone', async () => {
      sessionThat('killed');
      const scenario = { toplevel: project.path, status: ['x.txt'], unpushed: 1 };
      leftovers._internal.exec = fakeGit(scenario).exec;
      assert.equal((await leftovers.refresh(project)).state, 'left-work');
      scenario.status = [];
      scenario.unpushed = 0;
      await leftovers.refresh(project);
      assert.equal(leftovers.read(project).state, 'clean');
    });

    it('does not serve an answer about an earlier session', async () => {
      sessionThat('killed');
      await answerWith({ status: ['x.txt'], unpushed: 0 });
      const second = sessionThat('killed');
      const a = leftovers.read(project);
      assert.equal(a.sessionId, second.id);
      assert.equal(a.state, 'checking');
    });

    it('drops its answer once a new session is active', async () => {
      sessionThat('killed');
      await answerWith({ status: ['x.txt'], unpushed: 0 });
      sessionThat('active');
      assert.equal(leftovers.read(project), null);
    });

    it('never rejects, and keeps an internal failure as the reason', async () => {
      sessionThat('killed');
      leftovers._internal.exec = async () => { throw new TypeError('boom'); };
      const a = await leftovers.refresh(project);
      assert.equal(a.state, 'unknown');
      assert.match(a.reason, /internal error: boom/);
    });
  });

  describe('on the project list', () => {
    const noSessions = { get: async () => ({ answered: true, names: new Set(), cause: null }) };

    it('carries the answer as sessionHealth, null when nothing applies', async () => {
      const projects = require('../lib/projects');
      assert.equal((await projects.enrichProject(project, {}, { tmuxSessionNames: noSessions })).sessionHealth, null);
      sessionThat('killed');
      leftovers._internal.exec = fakeGit({ toplevel: project.path, status: ['x.txt'], unpushed: 2 }).exec;
      await leftovers.refresh(project);
      const enriched = await projects.enrichProject(project, {}, { tmuxSessionNames: noSessions });
      assert.equal(enriched.sessionHealth.state, 'left-work');
      assert.equal(enriched.sessionHealth.unpushed, 2);
      assert.deepEqual(enriched.sessionHealth, leftovers.read(project));
    });

    it('hands the scanner\'s folder facts to the read, so a missing folder is never spawned into', async () => {
      const projects = require('../lib/projects');
      sessionThat('killed');
      const git = fakeGit({ toplevel: project.path });
      leftovers._internal.exec = git.exec;
      const first = await projects.enrichProject(project, { exists: false, unreadable: null }, { tmuxSessionNames: noSessions });
      assert.equal(first.sessionHealth.state, 'checking');
      await leftovers.refresh(project);
      const second = await projects.enrichProject(project, { exists: false, unreadable: null }, { tmuxSessionNames: noSessions });
      assert.match(second.sessionHealth.reason, /project folder is missing/);
      assert.equal(git.calls.length, 0);
    });

    it('reports a store that cannot be read as unknown with the reason, and still lists the project', async () => {
      const projects = require('../lib/projects');
      const realGetLatest = store.sessions.getLatest;
      store.sessions.getLatest = () => { throw new Error('database is locked'); };
      try {
        const enriched = await projects.enrichProject(project, {}, { tmuxSessionNames: noSessions });
        assert.equal(enriched.name, project.name);
        assert.equal(enriched.sessionHealth.state, 'unknown');
        assert.equal(enriched.sessionHealth.status, null);
        assert.match(enriched.sessionHealth.reason, /could not be read: database is locked/);
      } finally {
        store.sessions.getLatest = realGetLatest;
      }
    });
  });

  describe('against a real repository', () => {
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    /**
     * A repository with one commit pushed to a bare origin, and a file already
     * changed before launch.
     * @returns {{repo: string}}
     */
    function realRepo() {
      const repo = fs.realpathSync(project.path);
      const origin = fs.mkdtempSync(path.join(storeDir, 'origin-'));
      git(origin, 'init', '--bare', '-q');
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 't@example.com');
      git(repo, 'config', 'user.name', 'T');
      git(repo, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
      fs.writeFileSync(path.join(repo, 'before.txt'), 'one\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'first');
      git(repo, 'remote', 'add', 'origin', origin);
      git(repo, 'push', '-q', 'origin', 'main');
      fs.writeFileSync(path.join(repo, 'before.txt'), 'dirty before launch\n');
      return { repo };
    }

    it('finds a new file and an unpushed commit, and not the file dirty at launch', async () => {
      const { repo } = realRepo();
      const baseline = launchBaseline.capture(repo);
      assert.deepEqual(baseline.dirty.paths, ['before.txt']);
      sessionThat('killed', baseline);
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');
      git(repo, 'commit', '-q', '-m', 'unpushed', '--', 'tracked.txt');
      fs.writeFileSync(path.join(repo, 'new file.txt'), 'x\n');
      const a = await leftovers.refresh(project);
      assert.equal(a.state, 'left-work');
      assert.deepEqual(a.newPaths, ['new file.txt']);
      assert.equal(a.unpushed, 1);
    });

    it('is clean once the work is committed and pushed', async () => {
      const { repo } = realRepo();
      sessionThat('killed', launchBaseline.capture(repo));
      fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
      git(repo, 'add', 'new.txt');
      git(repo, 'commit', '-q', '-m', 'work');
      git(repo, 'push', '-q', 'origin', 'main');
      const a = await leftovers.refresh(project);
      assert.equal(a.state, 'clean');
      assert.equal(a.unpushed, 0);
    });
  });
});
