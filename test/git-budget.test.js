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
const { initRepo } = require('./_temp-repo');

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
 * A subcommand it does not stall exits 0, and `status` answers with a parseable
 * `## main` — see the body for why an empty answer there silently disarmed every
 * guard downstream of it.
 *
 * Patterns are shell globs matched against the WHOLE argument list rather than
 * the subcommand alone, so calls sharing a `$1` can be told apart — `rev-parse`
 * backs both the is-a-repo probe and the branch recovery beside it.
 *
 * @param {string[]|null} stallOn - Globs to stall on (`null` = every invocation).
 * @returns {void}
 */
function shadowGit(stallOn) {
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-slow-git-'));
  // Spaces escaped rather than quoted: a quoted case pattern is literal, and
  // these need to stay globs so `status*` matches its flags.
  const patterns = stallOn && stallOn.map((g) => g.replace(/ /g, '\\ ')).join('|');
  const stall = stallOn === null
    ? `sleep ${STALL_SECONDS}\n`
    : `case "$*" in\n  ${patterns}) sleep ${STALL_SECONDS} ;;\nesac\n`;
  // A `status` this fake does not stall must answer PARSEABLY, or every read
  // stops at the first step and the later ones are never reached.
  //
  // This is not cosmetic. `_fetchInfo` now takes branch, dirtiness and
  // has-commits from one `status`, and treats output it cannot parse as
  // "established nothing" — so a fake that answered `status` with empty stdout
  // made every downstream assertion pass off an early return, with the command
  // under test never invoked. The `log*` guard below was exactly that shape:
  // green, and measuring nothing. A stall guard has to reach the step it stalls.
  const answer = 'case "$*" in\n  status*) echo "## main" ;;\nesac\n';
  fs.writeFileSync(path.join(fakeBinDir, 'git'),
    `#!/bin/sh\n${stall}${answer}exit 0\n`, { mode: 0o755 });
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
    it('stops near its budget instead of paying the per-call cap once per spawn', () => {
      shadowGit(null);
      const startedAt = Date.now();
      const info = git._fetchInfo(REPO_ROOT, { budgetMs: 1000 });
      const elapsed = Date.now() - startedAt;

      assert.ok(info !== null, 'a repository whose git work stalls is still a repository');
      // The assertion that matters is "nowhere near one cap per spawn", not a
      // precise number — a loaded CI box is allowed to be late. Stated as the
      // shape rather than as an arithmetic product, because the product moved
      // when the read went from seven invocations to three and this comment did
      // not notice.
      assert.ok(elapsed < 5000, `expected the read to stop near its budget, took ${elapsed}ms`);
    });

    it('names every field it did not establish', () => {
      shadowGit(['status*', 'log*', 'describe*']);
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
      shadowGit(['status*']);
      const info = git._fetchInfo(REPO_ROOT, { budgetMs: 2000 });

      assert.ok(info.incomplete.includes('dirty'),
        'a field whose spawn was killed by the cap must be named unestablished');
    });

    it('calls a repository we STOPPED slow, not broken', () => {
      // The distinction an operator acts on. A `status` our own cap killed means
      // a SLOW repository — #891's entire scenario — and the remedy is patience
      // or a bigger budget. A `status` git ran and refused means a repository
      // that needs repairing. They arrive identically: both are a throw.
      //
      // THE MUTATION THIS CATCHES: deriving the cause from the remaining budget
      // instead of from `weStopped` at the throw. Every production caller passes
      // a positive budget, so that version could only ever say "git refused" —
      // and would send an operator to repair a healthy repository. A test using
      // `budgetMs: 0` passes against that bug, because zero is the one input
      // production never supplies; this one uses a real stalling `git` under a
      // budget production actually uses.
      const { setConsoleStream, setLevel } = require('../lib/logger');
      const lines = [];
      setConsoleStream({ write: (s) => lines.push(s) });
      setLevel('debug');
      try {
        shadowGit(['status*']);
        git._fetchInfo(REPO_ROOT, { budgetMs: 1500 });
      } finally {
        setConsoleStream(null);
        setLevel('info');
      }

      const joined = lines.join('\n');
      assert.match(joined, /read-timed-out/,
        'a status WE killed is a slow repository, and must be reported as one');
      assert.doesNotMatch(joined, /git-refused-to-read-repository/,
        'and must never be reported as a repository git refused to read');
    });

    it('marks BOTH fields of a killed two-field read, not just the one it names', () => {
      // THE CONTRACT THIS HAS ALWAYS PROTECTED, unchanged: a step the cap KILLED
      // establishes nothing, and every field that step would have answered must
      // be named — never left reporting its empty fallback as though something
      // had looked.
      //
      // WHAT MOVED, and why this test was rewritten rather than deleted (#895):
      // it used to stall `git rev-parse HEAD`, the separate has-commits probe.
      // That probe is gone — has-commits is now read off `status`'s `## No
      // commits yet on …` marker, which is free and cannot be killed on its own —
      // so shadowing `rev-parse HEAD` now stalls a command nobody runs, and the
      // test passed for a mechanism that no longer exists.
      //
      // The same hazard lives on the invocation that replaced it: `log -1
      // --format=%s%n%cr` answers lastCommit AND lastCommitAge together, so a
      // kill there must name both. Naming only the field the step is keyed under
      // would leave the other reporting `''` as an established answer — the exact
      // shape #891 removed.
      //
      // `latestTag` is deliberately NOT asserted here any more: `describe` is its
      // own invocation and still runs, so it is genuinely established. Under the
      // old shape it was unestablished only because the dead gate probe stopped
      // it being attempted at all. That is a strictly more honest answer, not a
      // weakened assertion.
      shadowGit(['log*']);
      const info = git._fetchInfo(REPO_ROOT, { budgetMs: 3000 });

      for (const field of ['lastCommit', 'lastCommitAge']) {
        assert.ok(info.incomplete.includes(field),
          `${field} was to be answered by a step that was killed, so it was never established`);
      }
      assert.equal(info.lastCommit, '', 'and its value stays empty rather than half-parsed');
      assert.equal(info.lastCommitAge, '');
    });
  });

  describe('an unestablished field never reads as a definite answer', () => {
    it('reports dirty as null rather than false when it could not look', () => {
      shadowGit(['status*']);
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
      shadowGit(['status*']);
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
        shadowGit(['status*']);
        git._fetchInfo(REPO_ROOT, { budgetMs: 2000 });
        git._fetchInfo(REPO_ROOT, { budgetMs: 2000 });

        const budgetLines = lines.filter((l) => l.includes('Git info incomplete'));
        assert.equal(budgetLines.length, 2, 'both reads must reach the log — neither is silent');
        assert.match(budgetLines[0], /WARN/);
        assert.match(budgetLines[1], /DEBUG/);
      } finally {
        setConsoleStream(null);
        setLevel(priorLogLevel);
      }
    });
  });

  describe('the read that establishes nothing is the one that must say so', () => {
    it('reports when even the is-a-repo probe never answered', () => {
      // That probe failing takes an early return with a hand-built
      // all-incomplete object, which bypassed the shared report below it — so
      // the ONE path that established nothing at all was also the one path that
      // logged nothing at all. Silent-failure shape, and this file family has
      // been bitten by it twice (PRJ-2F8W, #884).
      const lines = [];
      setConsoleStream({ write: (s) => lines.push(s) });
      setLevel('debug');
      try {
        shadowGit(null);
        const info = git._fetchInfo(REPO_ROOT, { budgetMs: 800 });

        assert.equal(info.incomplete.length, 5, 'precondition: nothing was established');
        const reported = lines.filter((l) => l.includes('Git info incomplete'));
        assert.equal(reported.length, 1, 'the emptiest read must not be the quietest one');
        assert.match(reported[0], /WARN/);
      } finally {
        setConsoleStream(null);
        setLevel(priorLogLevel);
      }
    });
  });

  describe('a deadlined walk passes its remainder down, not the default budget', () => {
    it('reads each directory under what is LEFT of the walk, never a fresh full budget', () => {
      // The walk loops in `lib/dir-scanner-child.js` check their deadline
      // BETWEEN iterations, and a synchronous git spawn inside one cannot be
      // interrupted. So a per-directory read that took `git.getInfo`'s own
      // default would overrun the walk's bound by a whole budget no matter how
      // little of the walk was left — the walk's deadline would be documented
      // rather than enforced. Asserted against the source because the overrun is
      // a property of what the call site passes, not of anything git returns.
      const source = fs.readFileSync(
        path.join(REPO_ROOT, 'lib', 'dir-scanner-child.js'), 'utf8');

      const perDirectoryCalls = [...source.matchAll(/_gitInfo\(([^)]*)\)/g)]
        .map((m) => m[1])
        .filter((args) => args.includes('dirPath'));

      assert.ok(perDirectoryCalls.length >= 2,
        'expected the walk call sites to still exist');
      for (const args of perDirectoryCalls) {
        assert.match(args, /deadlineAt/,
          `a per-directory git read must be given the walk's remaining budget, got _gitInfo(${args})`);
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
    initRepo(repo);
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
      initRepo(empty);
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
