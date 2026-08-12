'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const git = require('../lib/git');

describe('git', () => {
  afterEach(() => {
    git.clearCache();
  });

  describe('isGitRepo', () => {
    it('should return true for a git repository', () => {
      // This project is a git repo
      assert.ok(git.isGitRepo(path.join(__dirname, '..')));
    });

    it('should return false for a non-repo directory', () => {
      assert.equal(git.isGitRepo('/tmp'), false);
    });

    it('should return false for non-existent directory', () => {
      assert.equal(git.isGitRepo('/nonexistent/path'), false);
    });
  });

  describe('getInfo', () => {
    it('should return git info for a valid repo', () => {
      const info = git.getInfo(path.join(__dirname, '..'));
      assert.ok(info !== null);
      assert.ok(typeof info.branch === 'string');
      assert.ok(typeof info.dirty === 'boolean');
      assert.ok(typeof info.lastCommit === 'string');
      assert.ok(typeof info.lastCommitAge === 'string');
    });

    it('should return null for non-git directory', () => {
      const info = git.getInfo('/tmp');
      assert.equal(info, null);
    });

    it('should cache results', () => {
      const dir = path.join(__dirname, '..');
      const info1 = git.getInfo(dir);
      const info2 = git.getInfo(dir);
      // Same object reference since it's cached
      assert.equal(info1, info2);
    });

    it('should return fresh data after cache clear', () => {
      const dir = path.join(__dirname, '..');
      const info1 = git.getInfo(dir);
      git.clearCache();
      const info2 = git.getInfo(dir);
      // Different object reference but same data
      assert.notEqual(info1, info2);
      assert.equal(info1.branch, info2.branch);
    });
  });

  describe('clearCacheFor', () => {
    it('should clear cache for a specific directory', () => {
      const dir = path.join(__dirname, '..');
      const info1 = git.getInfo(dir);
      git.clearCacheFor(dir);
      const info2 = git.getInfo(dir);
      assert.notEqual(info1, info2);
    });
  });

  describe('_fetchInfo', () => {
    it('should return info without caching', () => {
      const info = git._fetchInfo(path.join(__dirname, '..'));
      assert.ok(info !== null);
      assert.ok(info.branch);
    });

    it('should return null for non-repo', () => {
      const info = git._fetchInfo('/tmp');
      assert.equal(info, null);
    });
  });

  // Reading one repository took SEVEN `git` invocations to answer five questions;
  // it takes three (#895). The collapse is a parsing change, so every state below
  // is driven by a REAL repository built into that state — a stubbed `git` output
  // would assert the author's model of what git prints, which is precisely the
  // thing under test.
  describe('one repository read costs three invocations, not seven (#895)', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { execSync } = require('node:child_process');

    const made = [];
    afterEach(() => {
      while (made.length) {
        const dir = made.pop();
        // Some fixtures deliberately remove read permission; restore it or the
        // cleanup fails and leaks the directory.
        try { execSync(`chmod -R u+rwX ${JSON.stringify(dir)}`); } catch { /* best effort */ }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    /**
     * Build a repository fixture and return its path.
     *
     * `--template=` deliberately empty: the default template installs sample
     * hooks, and a fixture that ships hooks is a fixture that can run them.
     * Identity is set locally because CI runners have no global git user.
     *
     * @param {string} label - Directory prefix, for readable failures.
     * @param {string[]} steps - Shell commands run in the fixture, in order.
     * @returns {string} The fixture path.
     */
    function repo(label, steps) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-git-${label}-`));
      made.push(dir);
      const setup = [
        'git init --template= -q -b main',
        'git config user.email t@example.com',
        'git config user.name Test',
        ...steps
      ];
      execSync(setup.join(' && '), { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      return dir;
    }

    /**
     * Count the `git` invocations one read makes, by wrapping the module's own
     * exec seam. Counting is the claim: the seven calls cost tens of milliseconds
     * warm, so wall-clock cannot tell three from seven.
     *
     * @param {string} dir - Repository to read.
     * @returns {{ info: object|null, commands: string[] }}
     */
    function readCounting(dir) {
      const commands = [];
      // Injected rather than monkey-patched: `_fetchInfo` calls its module-local
      // `_exec`, so reassigning the export counts nothing and every count-based
      // assertion would read zero. Same `execFn` seam as `lib/tmux.js` and
      // `lib/engines.js`, and it runs the REAL command underneath, so these stay
      // integration tests against real repositories.
      const execFn = (command, cwd, timeout) => {
        commands.push(command);
        return git._exec(command, cwd, timeout);
      };
      return { info: git._fetchInfo(dir, { execFn }), commands };
    }

    it('reads a healthy repository in three invocations', () => {
      const dir = repo('healthy', ['echo a > a.txt', 'git add a.txt', 'git commit -qm "the subject"']);
      const { info, commands } = readCounting(dir);

      // THE MUTATION THIS CATCHES: restoring any of the four removed invocations
      // — `--is-inside-work-tree`, `--abbrev-ref HEAD`, `rev-parse HEAD`, or a
      // second `log`. Every one of them still produces correct output, which is
      // why the guard has to count rather than compare answers.
      assert.equal(commands.length, 3,
        `expected three invocations, got: ${commands.join(' | ')}`);
      assert.equal(info.branch, 'main');
      assert.equal(info.dirty, false);
      assert.equal(info.lastCommit, 'the subject');
      assert.ok(info.lastCommitAge.length > 0, 'age must be established');
      assert.deepEqual(info.incomplete, []);
    });

    it('reads a repository with no commits in ONE invocation, and names its branch', () => {
      const dir = repo('unborn', []);
      const { info, commands } = readCounting(dir);

      // An unborn HEAD does not fail `status` — it reports `## No commits yet on
      // main`, exit 0 — so has-commits is read positively off that marker and
      // nothing downstream is attempted.
      //
      // THE MUTATION THIS CATCHES: inferring has-commits from a failing `log` or
      // `rev-parse HEAD` instead of the marker. That treats ANY failure of those
      // as "no commits", which is how a repository that failed them for some
      // other reason got reported as empty.
      assert.equal(commands.length, 1,
        `expected one invocation, got: ${commands.join(' | ')}`);
      // `rev-parse --abbrev-ref HEAD` FAILS on an unborn HEAD, so this used to be
      // `'unknown'` for every freshly-created project. git names the branch.
      assert.equal(info.branch, 'main');
      assert.equal(info.lastCommit, '');
      assert.equal(info.lastCommitAge, '');
      assert.equal(info.latestTag, null);
      assert.deepEqual(info.incomplete, [],
        'an empty repository is a known state, not an unestablished one');
    });

    it('a repository it cannot READ stays a project — it does not become null', () => {
      // THE CRITERION THE WHOLE DESIGN TURNS ON. Measured: with `.git/index`
      // unreadable, `git status` exits 128 while `rev-parse --is-inside-work-tree`
      // still answers `true`. So "status failed" must NOT be read as "not a
      // repository".
      //
      // THE MUTATION THIS CATCHES: concluding not-a-repository from a failed
      // `status` — the literal three-invocation design the issue proposed.
      // `lib/dir-scanner-child.js` decides a directory IS a project from
      // `gitInfo && gitInfo.branch`, so returning null here deletes a broken
      // project from the dashboard instead of costing it a badge.
      const dir = repo('unreadable', ['echo a > a.txt', 'git add a.txt', 'git commit -qm s']);
      fs.chmodSync(path.join(dir, '.git', 'index'), 0o000);

      const info = git._fetchInfo(dir);

      assert.ok(info !== null, 'a repository we cannot read is still a repository');
      assert.equal(info.dirty, null, 'unknown dirtiness must never render as clean');
      assert.ok(info.incomplete.includes('dirty'), 'and it must say what it could not establish');
      // The branch is NOT asserted unknown here: `.git/index` is what `status`
      // could not read, and naming the branch does not need the index, so the
      // read recovers it. `incomplete` must therefore NOT claim it is missing —
      // a field reported unestablished while carrying a real value is the same
      // class of false statement as the reverse, and both mislead #885's badge.
      assert.equal(info.branch, 'main');
      assert.ok(!info.incomplete.includes('branch'),
        'a field this read established must not be named unestablished');
    });

    it('names the branch of a CLONE of an empty repository, not the whole header', () => {
      // The case the shape table missed: an unborn HEAD can still track an
      // upstream. `git clone` of an empty repository prints
      // `## No commits yet on main...origin/main`, and taking the remainder of
      // that marker verbatim renders the entire string as the branch badge — for
      // precisely the brand-new project whose branch name this change exists to
      // report correctly.
      //
      // THE MUTATION THIS CATCHES: stripping the upstream on the normal path but
      // not on the unborn-HEAD path. Both paths now go through one helper, so
      // there is no second place for it to be forgotten.
      const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-emptyremote-'));
      made.push(remote);
      execSync('git init --template= -q -b main --bare', { cwd: remote, stdio: 'pipe' });

      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-emptyclone-'));
      made.push(parent);
      execSync(`git clone -q ${JSON.stringify(remote)} cloned`, { cwd: parent, stdio: 'pipe' });
      const dir = path.join(parent, 'cloned');

      const info = git._fetchInfo(dir);
      assert.ok(info !== null);
      assert.equal(info.branch, 'main',
        `expected the branch alone, got ${JSON.stringify(info.branch)}`);
      assert.equal(info.lastCommit, '');
    });

    it('still answers what it CAN when status fails on a real repository', () => {
      // `.git/index` unreadable: `status` fails, but neither `log` nor `describe`
      // reads the index, so the subject, the age and the tag are all still
      // answerable — and the seven-invocation read did answer them. Collapsing
      // them to unknown would tell the operator strictly less than before, which
      // is the one thing this change promised not to do.
      //
      // THE MUTATION THIS CATCHES: early-returning an all-unknown reading as soon
      // as `status` fails. Every assertion below flips at once.
      const dir = repo('degraded', [
        'echo a > a.txt', 'git add a.txt', 'git commit -qm "still readable"',
        'git tag v9.9.9'
      ]);
      fs.chmodSync(path.join(dir, '.git', 'index'), 0o000);

      const info = git._fetchInfo(dir);

      assert.ok(info !== null, 'a repository we cannot status is still a repository');
      assert.equal(info.branch, 'main', 'the branch is still answerable without the index');
      assert.equal(info.lastCommit, 'still readable');
      assert.ok(info.lastCommitAge.length > 0);
      assert.equal(info.latestTag, 'v9.9.9');
      // Only dirtiness is genuinely lost — `status` is its only source.
      assert.equal(info.dirty, null, 'and it must never render as clean');
      assert.deepEqual(info.incomplete, ['dirty'],
        'exactly one field was unestablished, and it is named');
    });

    it('names WHICH failure it hit, so the fixable one is distinguishable', () => {
      // Every short read logged an identical line, so "we stopped looking" and
      // "git refuses to read this repository" were the same event to an operator
      // — and only the second is something they can act on.
      //
      // THE MUTATION THIS CATCHES: dropping `cause` entirely. The harder half —
      // that a `status` our own CAP killed is also reported as stopped rather
      // than as broken — cannot be driven from here, because `budgetMs: 0` skips
      // the step instead of killing it. That path is guarded in
      // `test/git-budget.test.js` with a real stalling `git` under a budget
      // production actually uses; a guard written only against `budgetMs: 0`
      // passes against the inverted classifier this replaced.
      const { setConsoleStream, setLevel } = require('../lib/logger');
      const lines = [];
      setConsoleStream({ write: (s) => lines.push(s) });
      setLevel('debug');
      try {
        const broken = repo('cause-broken', ['echo a > a.txt', 'git add a.txt', 'git commit -qm s']);
        fs.chmodSync(path.join(broken, '.git', 'index'), 0o000);
        git._fetchInfo(broken);

        const starved = repo('cause-starved', ['echo a > a.txt', 'git add a.txt', 'git commit -qm s']);
        git._fetchInfo(starved, { budgetMs: 0 });
      } finally {
        setConsoleStream(null);
        setLevel('info');
      }

      const joined = lines.join('\n');
      assert.match(joined, /git-refused-to-read-repository/,
        'a repository git will not read must say so — it is the one an operator can fix');
      assert.match(joined, /read-timed-out/,
        'and a read that simply ran out of time must say that instead');
    });

    it('a directory that is genuinely not a repository still reads as null', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-plain-'));
      made.push(dir);
      assert.equal(git._fetchInfo(dir), null);
    });

    it('names a detached HEAD the way the probe it replaced did', () => {
      const dir = repo('detached', [
        'echo a > a.txt', 'git add a.txt', 'git commit -qm s', 'git checkout -q --detach HEAD'
      ]);
      // `## HEAD (no branch)`. `rev-parse --abbrev-ref HEAD` answered `HEAD`, and
      // callers already read it that way, so the collapse must not change it.
      assert.equal(git._fetchInfo(dir).branch, 'HEAD');
    });

    it('takes the branch name alone when an upstream is tracked', () => {
      const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-remote-'));
      made.push(remote);
      execSync('git init --template= -q -b main --bare', { cwd: remote, stdio: 'pipe' });
      const dir = repo('tracking', [
        'echo a > a.txt', 'git add a.txt', 'git commit -qm s',
        `git remote add origin ${JSON.stringify(remote)}`, 'git push -q -u origin main',
        'echo b > b.txt', 'git add b.txt', 'git commit -qm s2'
      ]);
      // `## main...origin/main [ahead 1]` — the upstream and the divergence count
      // are dropped. THE MUTATION THIS CATCHES: taking the header verbatim, which
      // renders the branch as `main...origin/main [ahead 1]` on the dashboard.
      assert.equal(git._fetchInfo(dir).branch, 'main');
    });

    it('reports a dirty tree as dirty, and a branch with a slash intact', () => {
      const dir = repo('slashy', [
        'git checkout -q -b feat/some-thing', 'echo a > a.txt', 'git add a.txt',
        'git commit -qm s', 'echo untracked > b.txt'
      ]);
      const info = git._fetchInfo(dir);
      assert.equal(info.branch, 'feat/some-thing');
      assert.equal(info.dirty, true);
    });

    it('keeps a multi-line commit message from pulling the age out of alignment', () => {
      // `%s` is the subject and is always ONE line — git folds a multi-line first
      // paragraph into it — which is what makes a two-line `%s%n%cr` format safe.
      //
      // THE MUTATION THIS CATCHES: reading the age from a fixed line index without
      // the folding assumption holding, or splitting the log output on the wrong
      // separator.
      const dir = repo('multiline', [
        'echo a > a.txt', 'git add a.txt',
        'git commit -qm "100% done" -m "a second paragraph"'
      ]);
      const info = git._fetchInfo(dir);
      assert.equal(info.lastCommit, '100% done');
      assert.match(info.lastCommitAge, /ago|second/,
        'the age must be the age, not the rest of the message');
    });

    it('reports nothing established when status answers in a shape it cannot read', () => {
      // A `status` that succeeds but carries no `## ` header is not output from
      // the command we asked for. The hazard is that it PARSES anyway: zero
      // further lines counts as zero changed paths, so the read would report a
      // repository as definitely CLEAN on the strength of output nothing
      // understood — an unknown wearing a fact's clothes, which is the failure
      // this module exists to prevent.
      //
      // THE MUTATION THIS CATCHES: dropping the header check and letting the
      // parser fall through, which yields `dirty: false` and a branch of
      // `'unknown'` — the second of those says it is unknown, the first lies.
      const { setConsoleStream, setLevel } = require('../lib/logger');
      const logged = [];
      setConsoleStream({ write: (s) => logged.push(s) });
      setLevel('debug');
      const dir = repo('nostatus', ['echo a > a.txt', 'git add a.txt', 'git commit -qm s']);
      const execFn = (command, cwd, timeout) => {
        if (command.includes('status')) return 'not a porcelain header at all';
        return git._exec(command, cwd, timeout);
      };

      let info;
      try {
        info = git._fetchInfo(dir, { execFn });
      } finally {
        setConsoleStream(null);
        setLevel('info');
      }

      assert.ok(info !== null, 'it is still a repository — status answered');
      assert.equal(info.dirty, null, 'unparsed output must never render as a clean tree');
      assert.ok(info.incomplete.includes('dirty'), 'and it must name what it lost');
      // Branch is recovered by its own probe, exactly as on the status-failed
      // path — an output we could not parse costs the field only `status` owns.
      assert.equal(info.branch, 'main');
      // And it is reported as its OWN cause: neither a repository git refused to
      // read nor one we ran out of time on. Those three call for different
      // responses, so a shared label would be no better than the single line they
      // all used to share.
      assert.match(logged.join('\n'), /git-status-unparsed/);
    });

    it('establishes nothing, and says so, when the budget is gone before it starts', () => {
      const dir = repo('nobudget', ['echo a > a.txt', 'git add a.txt', 'git commit -qm s']);
      const info = git._fetchInfo(dir, { budgetMs: 0 });

      assert.ok(info !== null, 'a budget we spent is not evidence the directory is not a repo');
      assert.equal(info.branch, 'unknown');
      assert.equal(info.dirty, null);
      for (const field of ['branch', 'dirty', 'lastCommit', 'lastCommitAge', 'latestTag']) {
        assert.ok(info.incomplete.includes(field), `${field} must be named as unestablished`);
      }
    });
  });

  describe('latestTag', () => {
    it('should include latestTag in getInfo result', () => {
      const info = git.getInfo(path.join(__dirname, '..'));
      assert.ok(info !== null);
      // latestTag is either a string (if tags exist) or null
      assert.ok(info.latestTag === null || typeof info.latestTag === 'string');
    });

    it('should return null latestTag for repo with no tags', () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const { execSync } = require('node:child_process');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
      try {
        // Local identity: CI runners ship git with no global user configured
        execSync('git init && git config user.email t@example.com && git config user.name Test && git commit --allow-empty -m "init"', { cwd: tmp, encoding: 'utf8' });
        const info = git._fetchInfo(tmp);
        assert.ok(info !== null);
        assert.equal(info.latestTag, null);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
