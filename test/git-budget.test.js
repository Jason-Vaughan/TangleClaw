'use strict';

/**
 * One budget across all of `_fetchInfo`'s spawns (#891).
 *
 * `lib/git.js` capped each `git` invocation at 5s and issued seven of them, so
 * the honest worst case was ~35s behind a 5s scan deadline: a repository whose
 * git work stalled was SIGKILLed with the child and reported to the operator as
 * a Full Disk Access problem it did not have.
 *
 * THE SLOW `git` HERE IS A REAL EXECUTABLE ON PATH, not a stubbed `_exec`. That
 * is what caught the bug this file's first draft missed: `execSync` does not set
 * `killed` on a timeout error, so the code's kill detection never fired and every
 * truncated read quietly reported its fallback as an answer. A stub resolving on
 * a timer would have asserted the arithmetic and reproduced none of it.
 *
 * Sleeps are 30s against sub-second budgets so a kill is never a race. The fake
 * git carries a few hundred ms of shell-spawn overhead, which is why budgets
 * here are seconds rather than the tens of ms a real git costs.
 */

const { describe, it, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = require('../lib/git');
const { setConsoleStream, setLevel, getLevel } = require('../lib/logger');
const { PROJECT_FACTS_TIMEOUT_MS } = require('../lib/project-facts');

const REPO_ROOT = path.join(__dirname, '..');
/** Long enough that a cap always wins the race, never the sleep. */
const STALL_SECONDS = 30;
/** Restored after the one test that turns the log level down. */
const priorLogLevel = getLevel();

/** Directory holding the fake `git`, prepended to PATH while a test runs. */
let fakeBinDir = null;
/** PATH as it was before a test shadowed `git`, restored afterwards. */
let realPath = null;

/**
 * Put a `git` that stalls on chosen subcommands at the front of PATH.
 *
 * It exits 0 with empty stdout otherwise, which is enough: these tests assert on
 * WHICH fields the budget establishes and how long the whole read takes, never
 * on git's output.
 *
 * @param {string[]|null} stallOn - Subcommands to stall on (`null` = all of them).
 * @returns {void}
 */
function shadowGit(stallOn) {
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-slow-git-'));
  const body = stallOn === null
    ? `sleep ${STALL_SECONDS}\n`
    : `case "$1" in\n  ${stallOn.join('|')}) sleep ${STALL_SECONDS} ;;\nesac\n`;
  fs.writeFileSync(path.join(fakeBinDir, 'git'), `#!/bin/sh\n${body}exit 0\n`, { mode: 0o755 });
  realPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${realPath}`;
}

/**
 * Undo `shadowGit`. Safe to call when it never ran.
 * @returns {void}
 */
function restoreGit() {
  if (realPath !== null) process.env.PATH = realPath;
  if (fakeBinDir) fs.rmSync(fakeBinDir, { recursive: true, force: true });
  fakeBinDir = null;
  realPath = null;
}

describe('git info budget (#891)', () => {
  afterEach(() => {
    restoreGit();
    git.clearCache();
  });

  describe('the budget bounds the whole read, not each spawn', () => {
    it('stops near its budget instead of paying the per-call cap seven times', () => {
      shadowGit(null);
      const startedAt = Date.now();
      const info = git._fetchInfo(REPO_ROOT, { budgetMs: 1000 });
      const elapsed = Date.now() - startedAt;

      assert.ok(info !== null, 'a repository whose git work stalls is still a repository');
      // The assertion that matters is "nowhere near seven caps" (35s), not a
      // precise number — a loaded CI box is allowed to be late.
      assert.ok(elapsed < 5000, `expected the read to stop near its budget, took ${elapsed}ms`);
    });

    it('names every field it did not establish', () => {
      shadowGit(['status', 'log', 'describe']);
      const info = git._fetchInfo(REPO_ROOT, { budgetMs: 2000 });

      assert.ok(Array.isArray(info.incomplete));
      assert.ok(info.incomplete.length > 0, 'a truncated read must say what it could not answer');
      for (const field of info.incomplete) {
        assert.ok(
          ['branch', 'dirty', 'lastCommit', 'lastCommitAge', 'latestTag'].includes(field),
          `incomplete named an unknown field: ${field}`
        );
      }
    });

    it('records a spawn the cap KILLED, not only one it skipped', () => {
      // The regression guard for the bug that shipped in this file's first
      // draft. `execSync` reports a timeout as code ETIMEDOUT / signal SIGTERM
      // and leaves `killed` undefined, so a `killed` check never fires: the
      // budget still stops the read, but the killed field is silently reported
      // as its fallback instead of as unestablished. Only `status` stalls here,
      // so `dirty` is cut short mid-call rather than skipped for want of budget.
      shadowGit(['status']);
      const info = git._fetchInfo(REPO_ROOT, { budgetMs: 2000 });

      assert.ok(info.incomplete.includes('dirty'),
        'a field whose spawn was killed by the cap must be named unestablished');
    });
  });

  describe('an unestablished field never reads as a definite answer', () => {
    it('reports dirty as null rather than false when it could not look', () => {
      shadowGit(['status']);
      const info = git._fetchInfo(REPO_ROOT, { budgetMs: 2000 });

      // THE GUARD THIS FILE EXISTS FOR. `_isDirty`'s catch returns `false`, and
      // `public/ui.js` renders `dirty` as a dot — so a check the budget cut
      // short would draw a dirty repository as clean. `false` here is a false
      // fact, not a default.
      assert.ok(info.incomplete.includes('dirty'), 'precondition: dirty was not established');
      assert.equal(info.dirty, null);
      assert.notEqual(info.dirty, false);
    });

    it('stays a non-null object so a stalled repository is still detected as a project', () => {
      // `lib/dir-scanner-child.js` derives `detected` from `gitInfo && gitInfo.branch`.
      // Returning null on exhaustion would make a real git-only project vanish
      // from the detected list rather than merely lose its badge.
      shadowGit(null);
      const info = git._fetchInfo(REPO_ROOT, { budgetMs: 1000 });

      assert.ok(info !== null);
      assert.ok(info.branch, 'branch must stay truthy so the detection predicate still fires');
    });
  });

  describe('a healthy repository is unaffected', () => {
    it('establishes every field and reports nothing incomplete', () => {
      const info = git._fetchInfo(REPO_ROOT);

      assert.ok(info !== null);
      assert.deepEqual(info.incomplete, []);
      assert.equal(typeof info.branch, 'string');
      assert.equal(typeof info.dirty, 'boolean');
      assert.equal(typeof info.lastCommit, 'string');
      assert.equal(typeof info.lastCommitAge, 'string');
    });

    it('still returns null for a directory that is not a repository', () => {
      assert.equal(git._fetchInfo(os.tmpdir()), null);
    });
  });

  describe('a truncated reading is not frozen in the cache', () => {
    it('re-reads after a partial instead of serving it for the whole TTL', () => {
      shadowGit(['status']);
      const first = git.getInfo(REPO_ROOT, { budgetMs: 2000 });
      assert.ok(first.incomplete.length > 0, 'precondition: the first read was partial');

      const second = git.getInfo(REPO_ROOT, { budgetMs: 2000 });
      // Identity, not contents: a cached answer is the SAME object. Caching a
      // partial would repeat one bad reading across twelve polls of a
      // repository that may be answering fine by now.
      assert.notEqual(first, second);
    });

    it('caches a complete reading as before', () => {
      const first = git.getInfo(REPO_ROOT);
      const second = git.getInfo(REPO_ROOT);
      assert.equal(first, second);
    });
  });

  describe('a persistently slow repository is reported once, not once per poll', () => {
    it('warns the first time and drops to debug for the same directory', () => {
      // A partial is deliberately not cached, so a repository that stays slow
      // re-reads on every ten-second poll. Warning each time would emit this
      // several times a minute and bury the warning it is meant to be — the
      // same call `lib/project-facts.js` makes for a remembered refusal.
      const lines = [];
      setConsoleStream({ write: (s) => lines.push(s) });
      setLevel('debug');
      try {
        shadowGit(['status']);
        git._fetchInfo(REPO_ROOT, { budgetMs: 2000 });
        git._fetchInfo(REPO_ROOT, { budgetMs: 2000 });

        const budgetLines = lines.filter((l) => l.includes('ran out of budget'));
        assert.equal(budgetLines.length, 2, 'both reads must reach the log — neither is silent');
        assert.match(budgetLines[0], /WARN/);
        assert.match(budgetLines[1], /DEBUG/);
      } finally {
        setConsoleStream(null);
        setLevel(priorLogLevel);
      }
    });
  });

  describe('the scan deadline is derived from the budget, not set beside it', () => {
    it('computes the deadline from the budget rather than restating a number', () => {
      // ASSERTED AGAINST THE SOURCE, DELIBERATELY. The obvious runtime check —
      // `PROJECT_FACTS_TIMEOUT_MS > GIT_INFO_BUDGET_MS` — is tautological: the
      // deadline IS the budget plus a margin, so that comparison holds for every
      // possible budget and cannot fail. It was written first and passed while
      // the value was hardcoded, which is the whole failure mode this guards.
      //
      // What can actually go wrong is someone restoring a literal here. Then the
      // two numbers drift again and git's work outlives the deadline that kills
      // the process performing it — the #891 defect, returned.
      const source = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'project-facts.js'), 'utf8');
      const assignment = source.match(/const PROJECT_FACTS_TIMEOUT_MS\s*=\s*([^;]+);/);

      assert.ok(assignment, 'PROJECT_FACTS_TIMEOUT_MS assignment not found');
      assert.match(
        assignment[1], /GIT_INFO_BUDGET_MS/,
        'the scan deadline must be computed from the git budget it contains, not restated as a literal'
      );
    });

    it('leaves the deadline above the budget it contains', () => {
      assert.ok(git.GIT_INFO_BUDGET_MS > 0);
      assert.ok(PROJECT_FACTS_TIMEOUT_MS > git.GIT_INFO_BUDGET_MS);
    });
  });
});

describe('git info budget — an empty budget never becomes an unbounded spawn (#891)', () => {
  let repo = null;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-budget-'));
    // Empty --template deliberately: a bare `git init` inherits the live global
    // template dir, which TangleClaw rewrites, and that flakes (#831).
    execFileSync('git', ['init', '--template=', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  });

  after(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    git.clearCache();
  });

  it('calls a repository with no commits answered, not unestablished', () => {
    // `git rev-parse HEAD` fails in a freshly-initialised repository, and it
    // fails the same way a spawn the budget killed does. Distinguishing them by
    // return value alone reported EVERY empty repository as incomplete — an
    // answer misfiled as a failure, which is the mirror of the false fact this
    // whole change exists to prevent.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-nocommit-'));
    try {
      execFileSync('git', ['init', '--template=', '-q'], { cwd: empty });
      const info = git._fetchInfo(empty);

      assert.ok(info !== null, 'an initialised repository is a repository');
      assert.deepEqual(info.incomplete, [],
        'no commits is a fact about the repository, not a field we failed to read');
      assert.equal(info.lastCommit, '');
      assert.equal(info.latestTag, null);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('skips every step rather than spawning git with no timeout', () => {
    // `execSync` treats `timeout: 0` as NO timeout. A cap computed as
    // min(perCall, remaining) therefore becomes UNBOUNDED the moment the budget
    // reaches zero — the exact inversion this fix exists to remove. A zero
    // budget must skip, never spawn.
    const startedAt = Date.now();
    const info = git._fetchInfo(repo, { budgetMs: 0 });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 1000, `a zero budget must not spawn anything, took ${elapsed}ms`);
    assert.ok(info !== null, 'an unread repository is unknown, not absent');
    assert.ok(info.incomplete.includes('dirty'));
    assert.equal(info.dirty, null);
  });
});
