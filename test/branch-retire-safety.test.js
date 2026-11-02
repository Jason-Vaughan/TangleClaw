'use strict';

/*
 * #1878 — can a local branch be retired without losing work?
 *
 * The real-git half is the contract: each acceptance case the issue names is
 * built as a throwaway repository with a bare "origin" beside it, and the
 * oracle runs the actual argv against the installed git. The stubbed half
 * drives the failure paths real git cannot be made to take on demand — a git
 * that errors mid-check, a branch that moves while it is being looked at —
 * because the property that matters most is that no failure ever reads `safe`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const brs = require('../lib/branch-retire-safety');
const { initRepo, cloneRepo } = require('./_temp-repo');

const { VERDICTS, REASONS } = brs;

/**
 * The reason codes of an assessment, for set-like assertions.
 * @param {object} a
 * @returns {string[]}
 */
function codes(a) {
  return a.reasons.map((r) => r.code);
}

describe('branch-retire-safety: parsers', () => {
  it('parses worktree list porcelain, including detached, bare and prunable trees', () => {
    const out = [
      'worktree /r/main', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '',
      'worktree /r/wt1', 'HEAD ' + 'b'.repeat(40), 'detached', '',
      'worktree /r/gone', 'HEAD ' + 'c'.repeat(40), 'branch refs/heads/feat', 'prunable gitdir file points to non-existent location', '',
      'worktree /r/bare.git', 'bare', ''
    ].join('\n');
    const t = brs.parseWorktreeList(out);
    assert.equal(t.length, 4);
    assert.deepEqual(t[0], { path: '/r/main', head: 'a'.repeat(40), branch: 'refs/heads/main', detached: false, bare: false, prunable: false });
    assert.equal(t[1].detached, true);
    assert.equal(t[1].branch, null);
    assert.equal(t[2].prunable, true);
    assert.equal(t[3].bare, true);
  });

  it('counts staged, unstaged, unmerged, untracked and ignored separately, skipping a rename\'s original path', () => {
    const recs = [
      '# branch.oid ' + 'a'.repeat(40),
      '1 M. N... 100644 100644 100644 x x staged.js',
      '1 .M N... 100644 100644 100644 x x unstaged.js',
      '1 MM N... 100644 100644 100644 x x both.js',
      '2 R. N... 100644 100644 100644 x x R100 new.js', 'old.js',
      'u UU N... 100644 100644 100644 100644 x x x conflict.js',
      '? plan.md',
      '! local.env'
    ];
    assert.deepEqual(brs.parseDirt(recs.join('\0') + '\0'), { staged: 3, unstaged: 2, unmerged: 1, untracked: 1, ignored: 1 });
  });

  it('an ignored-only status is parsed as dirt (the module\'s dirtiness checks treat ignored > 0 as dirty)', () => {
    assert.deepEqual(brs.parseDirt('! secret.env\0'), { staged: 0, unstaged: 0, unmerged: 0, untracked: 0, ignored: 1 });
  });
});

describe('branch-retire-safety: against real git', () => {
  let root;
  let n = 0;
  const realExec = childProcess.execFile;

  /**
   * The environment every git call in this file runs under, the
   * repository-making ones included, built fresh at each call.
   *
   * @returns {object} Environment for the git child
   */
  function gitEnv() {
    return { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: root };
  }

  /**
   * Run git synchronously with a fixed identity.
   * @param {string} cwd
   * @param {...string} args
   * @returns {string}
   */
  function git(cwd, ...args) {
    return childProcess.execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv()
    }).trim();
  }

  /**
   * Commit one file change on the current branch.
   * @param {string} dir
   * @param {string} file
   * @param {string} msg
   * @returns {string} The new commit's SHA.
   */
  function commit(dir, file, msg) {
    fs.writeFileSync(path.join(dir, file), `${msg}\n`);
    git(dir, 'add', file);
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
    return git(dir, 'rev-parse', 'HEAD');
  }

  /**
   * A bare origin plus a clone of it on main with one pushed commit.
   * @returns {{origin: string, dir: string}}
   */
  function makeClone() {
    const base = path.join(root, `case${++n}`);
    fs.mkdirSync(base);
    const origin = path.join(base, 'origin.git');
    initRepo(base, ['--bare', '-b', 'main', origin], { env: gitEnv() });
    const dir = path.join(base, 'work');
    cloneRepo(origin, dir, [], { cwd: base, env: gitEnv() });
    git(dir, 'checkout', '-q', '-b', 'main');
    commit(dir, 'README.md', 'init');
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    return { origin, dir };
  }

  /**
   * Run the oracle with the real git.
   * @param {string} dir
   * @param {string} branch
   * @returns {Promise<object>}
   */
  function check(dir, branch) {
    return brs.assess({ repo: dir, branch, execFile: realExec });
  }

  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-branch-retire-')); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a branch fully reachable upstream, clean and not checked out, is safe', async () => {
    const { dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    const sha = commit(dir, 'a.txt', 'feature');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    git(dir, 'checkout', '-q', 'main');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.SAFE, JSON.stringify(a.reasons));
    assert.deepEqual(codes(a), [REASONS.ALL_REACHABLE]);
    assert.equal(a.oid, sha);
    assert.equal(a.ref, 'refs/heads/feat');
    assert.equal(a.remote, 'origin');
    assert.equal(a.upstream, 'origin/feat');
    assert.equal(a.fetch.ok, true);
    assert.deepEqual(a.unique, { count: 0, shas: [] });
    assert.match(a.safeNextAction, /git branch -d feat/);
  });

  it('the #1878 incident: a merged branch with a later unpushed wrap commit is preserved, naming the commit', async () => {
    const { dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'a.txt', 'feature');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    // The PR merges on the remote side...
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
    git(dir, 'push', '-q', 'origin', 'main');
    // ...and a wrap commit lands on the branch afterwards, never pushed.
    git(dir, 'checkout', '-q', 'feat');
    const wrap = commit(dir, 'wrap.md', 'auto-stub wrap');
    git(dir, 'checkout', '-q', 'main');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.PRESERVE);
    assert.deepEqual(codes(a), [REASONS.UNIQUE_COMMITS]);
    assert.deepEqual(a.unique, { count: 1, shas: [wrap] });
    assert.match(a.safeNextAction, /Do not delete or reset 'feat'/);
    assert.match(a.safeNextAction, /git worktree add <new-path> origin\/main/);
    assert.doesNotMatch(a.safeNextAction, /worktree remove/, 'no tree holds it, so no tree-retire step is offered');
    assert.doesNotMatch(a.safeNextAction, /git branch -d/);
    assert.match(brs.render(a), new RegExp(wrap));
  });

  it('an untracked plan in the worktree holding the branch is preserved even with every commit upstream', async () => {
    const { dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'a.txt', 'feature');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    fs.mkdirSync(path.join(dir, 'plans'));
    fs.writeFileSync(path.join(dir, 'plans', 'next.md'), 'the plan\n');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.PRESERVE);
    assert.deepEqual(codes(a).sort(), [REASONS.CHECKED_OUT, REASONS.WORKTREE_DIRTY].sort());
    const held = a.worktrees.filter((w) => w.holdsTarget);
    assert.equal(held.length, 1);
    assert.deepEqual(held[0].dirt, { staged: 0, unstaged: 0, unmerged: 0, untracked: 1, ignored: 0 });
    assert.match(a.safeNextAction, /plain `git worktree remove <tree>` \(never `--force`\)/);
    assert.match(a.safeNextAction, /--ignored/);
    assert.ok(a.safeNextAction.includes(held[0].path), 'the advice names the tree holding the branch');
  });

  it('a gitignored file (no other changes) in the worktree holding the branch is also preserved, not just untracked ones', async () => {
    const { dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'local.env\n');
    git(dir, 'add', '.gitignore');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'ignore local.env');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    fs.writeFileSync(path.join(dir, 'local.env'), 'SECRET=1\n');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.PRESERVE);
    assert.ok(codes(a).includes(REASONS.WORKTREE_DIRTY));
    const held = a.worktrees.filter((w) => w.holdsTarget);
    assert.deepEqual(held[0].dirt, { staged: 0, unstaged: 0, unmerged: 0, untracked: 0, ignored: 1 });
  });

  it('a stale remote-tracking ref is never evidence: the fresh fetch prunes it and the commit is unique again', async () => {
    const { origin, dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    const sha = commit(dir, 'a.txt', 'feature');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    git(dir, 'checkout', '-q', 'main');
    // Someone else deletes the branch on the remote (a squash merge, say) —
    // this clone's origin/feat still says the commit is upstream.
    git(origin, 'update-ref', '-d', 'refs/heads/feat');
    assert.equal(git(dir, 'rev-parse', 'refs/remotes/origin/feat'), sha, 'precondition: the cached ref still claims it');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.PRESERVE);
    assert.deepEqual(codes(a), [REASONS.UNIQUE_COMMITS]);
    assert.deepEqual(a.unique.shas, [sha]);
  });

  it('a failed fetch is unknown, and cached remote refs do not rescue it', async () => {
    const { dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'a.txt', 'feature');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'remote', 'set-url', 'origin', path.join(root, 'no-such-remote.git'));

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.ok(codes(a).includes(REASONS.FETCH_FAILED));
    assert.equal(a.fetch.attempted, true);
    assert.equal(a.fetch.ok, false);
    // The pushed commit is only on origin/feat — excluded without a fresh fetch.
    assert.ok(codes(a).includes(REASONS.UNIQUE_COMMITS));
    assert.doesNotMatch(a.fetch.detail, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no filesystem location leaks into the reason');
  });

  it('multiple worktrees: the branch checked out in a linked worktree with dirt there is preserved; the other trees are listed', async () => {
    const { dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'a.txt', 'feature');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    git(dir, 'checkout', '-q', 'main');
    const linked = path.join(path.dirname(dir), 'wt-feat');
    git(dir, 'worktree', 'add', '-q', linked, 'feat');
    const other = path.join(path.dirname(dir), 'wt-other');
    git(dir, 'worktree', 'add', '-q', '-b', 'other', other);
    fs.writeFileSync(path.join(linked, 'a.txt'), 'edited\n');
    fs.writeFileSync(path.join(linked, 'staged.txt'), 'new\n');
    git(linked, 'add', 'staged.txt');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.PRESERVE);
    assert.deepEqual(codes(a).sort(), [REASONS.CHECKED_OUT, REASONS.WORKTREE_DIRTY].sort());
    assert.equal(a.worktrees.length, 3);
    const held = a.worktrees.filter((w) => w.holdsTarget);
    assert.equal(held.length, 1);
    assert.equal(fs.realpathSync(held[0].path), fs.realpathSync(linked));
    assert.deepEqual(held[0].dirt, { staged: 1, unstaged: 1, unmerged: 0, untracked: 0, ignored: 0 });

    // The same repository answers safe for a branch no tree holds, whatever
    // dirt sits in trees that do not hold it.
    git(other, 'push', '-q', '-u', 'origin', 'other');
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'x\n');
    git(dir, 'branch', 'spare', 'main');
    const spare = await check(dir, 'spare');
    assert.equal(spare.verdict, VERDICTS.SAFE, JSON.stringify(spare.reasons));
  });

  it('a linked worktree deleted from disk is unknown, not safe', async () => {
    const { dir } = makeClone();
    git(dir, 'branch', 'feat');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    const linked = path.join(path.dirname(dir), 'wt-gone');
    git(dir, 'worktree', 'add', '-q', linked, 'feat');
    fs.rmSync(linked, { recursive: true, force: true });

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.ok(codes(a).includes(REASONS.WORKTREE_MISSING));
  });

  it('a worktree detached at the branch tip is preserved', async () => {
    const { dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'a.txt', 'feature');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    git(dir, 'checkout', '-q', '--detach', 'feat');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.PRESERVE);
    assert.deepEqual(codes(a), [REASONS.DETACHED_AT_TARGET]);
  });

  it('a commit reachable only from a tag counts as retained', async () => {
    const { dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'a.txt', 'feature');
    git(dir, 'tag', 'keep-feat');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'config', 'branch.feat.remote', 'origin');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.SAFE, JSON.stringify(a.reasons));
  });

  it('two remotes and no upstream is ambiguous: unknown, and nothing is fetched', async () => {
    const { origin, dir } = makeClone();
    git(dir, 'remote', 'add', 'fork', origin);
    git(dir, 'branch', 'feat');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.ok(codes(a).includes(REASONS.REMOTE_AMBIGUOUS));
    assert.equal(a.fetch.attempted, false);
  });

  it('a repository with no remote is unknown', async () => {
    const dir = path.join(root, `case${++n}`);
    fs.mkdirSync(dir);
    initRepo(dir, ['-b', 'main'], { env: gitEnv() });
    commit(dir, 'README.md', 'init');
    git(dir, 'branch', 'feat');

    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.ok(codes(a).includes(REASONS.NO_REMOTE));
    assert.doesNotMatch(a.safeNextAction, /origin/, 'no remote is invented for the next step');
    assert.match(a.safeNextAction, /Do not delete or reset 'feat'/);
  });

  it('a missing branch, an option-shaped name and a non-repository are unknown', async () => {
    const { dir } = makeClone();
    assert.deepEqual(codes(await check(dir, 'nope')), [REASONS.TARGET_NOT_FOUND]);
    assert.deepEqual(codes(await check(dir, '-D')), [REASONS.INVALID_BRANCH_NAME]);
    assert.deepEqual(codes(await check(dir, 'a..b')), [REASONS.INVALID_BRANCH_NAME]);
    const plain = path.join(root, `plain${++n}`);
    fs.mkdirSync(plain);
    const a = await check(plain, 'feat');
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.deepEqual(codes(a), [REASONS.NOT_A_REPOSITORY]);
  });

  it('the rule\'s worktree sequence holds: plain `worktree remove` refuses an untracked plan, then the branch checks safe', async () => {
    const { dir } = makeClone();
    git(dir, 'branch', 'feat');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    const linked = path.join(path.dirname(dir), 'wt-retire');
    git(dir, 'worktree', 'add', '-q', linked, 'feat');
    fs.writeFileSync(path.join(linked, 'plan.md'), 'unsaved plan\n');

    // The global rule leans on git refusing this without --force.
    assert.throws(() => git(dir, 'worktree', 'remove', linked));
    assert.ok(fs.existsSync(path.join(linked, 'plan.md')), 'the untracked plan survived the refused removal');
    assert.equal((await check(dir, 'feat')).verdict, VERDICTS.PRESERVE);

    fs.rmSync(path.join(linked, 'plan.md'));
    // Why the rule's clean-tree step asks for --ignored: a gitignored file is
    // not a reason for git to refuse, and it is gone with the tree.
    fs.writeFileSync(path.join(linked, '.gitignore'), 'local.env\n');
    git(linked, 'add', '.gitignore');
    git(linked, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'ignore local.env');
    git(linked, 'push', '-q');
    fs.writeFileSync(path.join(linked, 'local.env'), 'SECRET=1\n');
    assert.match(git(linked, 'status', '--porcelain', '--untracked-files=all', '--ignored'), /!! local\.env/);
    git(dir, 'worktree', 'remove', linked);
    assert.equal(fs.existsSync(linked), false, 'plain remove deleted the tree, ignored file included');
    const a = await check(dir, 'feat');
    assert.equal(a.verdict, VERDICTS.SAFE, JSON.stringify(a.reasons));
  });

  it('never deletes, resets or moves anything', async () => {
    const { dir } = makeClone();
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'a.txt', 'feature');
    git(dir, 'checkout', '-q', 'main');
    const before = git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
    await check(dir, 'feat');
    assert.equal(git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), before);
    assert.equal(git(dir, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  });
});

describe('branch-retire-safety: failure paths (stubbed git)', () => {
  const OID = 'a'.repeat(40);

  /**
   * A fake execFile answering by a key built from the argv.
   * @param {(args: string[]) => (string|Error|undefined)} answer
   * @returns {Function}
   */
  function fakeGit(answer) {
    return (file, args, _opts, cb) => {
      assert.equal(file, 'git');
      const a = answer(args.slice(1));
      setImmediate(() => {
        if (a instanceof Error) cb(a, '');
        else if (a === undefined) cb(new Error(`unexpected git ${args.slice(1).join(' ')}`), '');
        else cb(null, a);
      });
    };
  }

  /**
   * A healthy repository's answers, overridable per call.
   * @param {object} [over] - Keyed by the first two argv words, or the first alone.
   * @returns {Function}
   */
  function healthy(over = {}) {
    let resolves = 0;
    return fakeGit((args) => {
      const key = args.slice(0, 2).join(' ');
      const hit = key in over ? key : (args[0] in over ? args[0] : null);
      if (hit !== null) {
        const v = over[hit];
        return typeof v === 'function' ? v(args, ++resolves) : v;
      }
      if (key === 'rev-parse --show-toplevel') return '/r\n';
      if (key === 'check-ref-format --branch') return `${args[2]}\n`;
      if (key === 'rev-parse --verify') return `${OID}\n`;
      if (key === 'config --get') return args[2].endsWith('.remote') ? 'origin\n' : 'refs/heads/feat\n';
      if (args[0] === 'remote') return 'origin\n';
      if (key === 'fetch --prune') return '';
      if (key === 'symbolic-ref --quiet') return 'origin/main\n';
      if (args[0] === 'rev-list') return '';
      if (key === 'worktree list') return `worktree /r\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/main\n`;
      return undefined;
    });
  }

  it('the healthy stub is safe, so each failure below is the only thing that changed', async () => {
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile: healthy() });
    assert.equal(a.verdict, VERDICTS.SAFE, JSON.stringify(a.reasons));
  });

  it('a reachability failure is unknown', async () => {
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile: healthy({ 'rev-list': new Error('boom') }) });
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.ok(codes(a).includes(REASONS.REACHABILITY_FAILED));
    assert.equal(a.unique.count, null);
  });

  it('only a refreshed remote is passed to the reachability walk', async () => {
    const seen = [];
    const ok = healthy({ 'rev-list': (args) => { seen.push(args); return ''; } });
    await brs.assess({ repo: '/r', branch: 'feat', execFile: ok });
    assert.ok(seen[0].includes('--remotes=origin'));
    assert.ok(seen[0].includes('--exclude=feat'));

    const seenFail = [];
    const failed = healthy({
      'fetch --prune': new Error('Could not read from remote repository.'),
      'rev-list': (args) => { seenFail.push(args); return ''; }
    });
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile: failed });
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.ok(!seenFail[0].some((x) => x.startsWith('--remotes')));
  });

  it('a branch that moves during the check is unknown', async () => {
    const execFile = healthy({
      'rev-parse --verify': (_args, i) => (i === 1 ? `${OID}\n` : `${'c'.repeat(40)}\n`)
    });
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile });
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.deepEqual(codes(a), [REASONS.TARGET_MOVED]);
  });

  it('a worktree list failure is unknown', async () => {
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile: healthy({ 'worktree list': new Error('x') }) });
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.ok(codes(a).includes(REASONS.WORKTREE_LIST_FAILED));
  });

  it('an empty worktree list is unknown: git always lists the main worktree, so nothing parsed means a bad read', async () => {
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile: healthy({ 'worktree list': '' }) });
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.deepEqual(codes(a), [REASONS.WORKTREE_LIST_FAILED]);
  });

  it('a status failure in the tree holding the branch is unknown', async () => {
    const execFile = healthy({
      'worktree list': `worktree /r\nHEAD ${OID}\nbranch refs/heads/feat\n`,
      'status --porcelain=v2': new Error('index locked')
    });
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile });
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.deepEqual(codes(a).sort(), [REASONS.CHECKED_OUT, REASONS.WORKTREE_STATUS_FAILED].sort());
  });

  it('a rebase of the branch in progress in a detached worktree is preserved', async () => {
    const execFile = healthy({
      'worktree list': `worktree /r\nHEAD ${'d'.repeat(40)}\ndetached\n`,
      'rev-parse --git-path': (args) => `.git/${args[2]}\n`,
      'status --porcelain=v2': ''
    });
    const readFile = async (file) => {
      if (file.endsWith(path.join('rebase-merge', 'head-name'))) return 'refs/heads/feat\n';
      const e = new Error('nope');
      e.code = 'ENOENT';
      throw e;
    };
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile, readFile });
    assert.equal(a.verdict, VERDICTS.PRESERVE);
    assert.deepEqual(codes(a), [REASONS.OPERATION_IN_PROGRESS]);
  });

  it('an unreadable rebase state in a detached worktree is unknown', async () => {
    const execFile = healthy({
      'worktree list': `worktree /r\nHEAD ${'d'.repeat(40)}\ndetached\n`,
      'rev-parse --git-path': (args) => `.git/${args[2]}\n`
    });
    const readFile = async () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile, readFile });
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.ok(codes(a).includes(REASONS.WORKTREE_STATUS_FAILED));
  });

  it('an upstream remote that is not a configured remote is unknown', async () => {
    const execFile = healthy({ 'config --get': (args) => (args[2].endsWith('.remote') ? 'gone\n' : 'refs/heads/feat\n') });
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile });
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.ok(codes(a).includes(REASONS.REMOTE_INVALID));
    assert.equal(a.fetch.attempted, false);
  });

  it('a thrown execFile never escapes: it is folded into unknown', async () => {
    const execFile = () => { throw new Error('spawn EAGAIN'); };
    const a = await brs.assess({ repo: '/r', branch: 'feat', execFile });
    assert.equal(a.verdict, VERDICTS.UNKNOWN);
    assert.deepEqual(codes(a), [REASONS.NOT_A_REPOSITORY]);
  });

  it('every reason code maps to exactly one verdict, and only ALL_REACHABLE maps to safe', () => {
    for (const code of Object.values(REASONS)) assert.ok(Object.values(VERDICTS).includes(brs.REASON_VERDICT[code]), code);
    const safe = Object.entries(brs.REASON_VERDICT).filter(([, v]) => v === VERDICTS.SAFE).map(([k]) => k);
    assert.deepEqual(safe, [REASONS.ALL_REACHABLE]);
  });

  it('render lists every reason and caps a long SHA list, pointing at --json', () => {
    const shas = Array.from({ length: 25 }, (_, i) => String(i).padStart(40, '0'));
    const a = {
      verdict: VERDICTS.PRESERVE, branch: 'feat', ref: 'refs/heads/feat', oid: OID, remote: 'origin', upstream: 'origin/feat',
      fetch: { attempted: true, ok: true, remote: 'origin', at: '2026-09-27T00:00:00.000Z', detail: null },
      unique: { count: 25, shas }, worktrees: [],
      reasons: [{ code: REASONS.UNIQUE_COMMITS, verdict: VERDICTS.PRESERVE, detail: '25 commit(s)' }],
      safeNextAction: 'Keep it.'
    };
    const out = brs.render(a);
    assert.match(out, /PRESERVE — do not retire/);
    assert.match(out, /\[UNIQUE_COMMITS\]/);
    assert.match(out, /… 5 more \(--json lists all\)/);
    assert.ok(!out.includes(shas[24]));
  });
});

/*
 * #1267 — a worktree/branch retirement PLANNER and EXECUTOR built on top of
 * the oracle above. Every case here is a throwaway repository (never the
 * real host's worktrees), per the issue's own acceptance criterion 4.
 */
describe('branch-retire-safety: worktree & branch retirement (#1267)', () => {
  let root;
  let n = 0;
  const realExec = childProcess.execFile;

  /**
   * @returns {object} Environment for the git child.
   */
  function gitEnv() {
    return { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: root };
  }

  /**
   * @param {string} cwd
   * @param {...string} args
   * @returns {string}
   */
  function git(cwd, ...args) {
    return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() }).trim();
  }

  /**
   * @param {string} dir
   * @param {string} file
   * @param {string} content
   * @param {string} msg
   * @returns {string} The new commit's SHA.
   */
  function commit(dir, file, content, msg) {
    fs.writeFileSync(path.join(dir, file), `${content}\n`);
    git(dir, 'add', file);
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
    return git(dir, 'rev-parse', 'HEAD');
  }

  /**
   * A bare origin plus a clone of it on main with one pushed commit.
   * @returns {{origin: string, dir: string}}
   */
  function makeClone() {
    const base = path.join(root, `case${++n}`);
    fs.mkdirSync(base);
    const origin = path.join(base, 'origin.git');
    initRepo(base, ['--bare', '-b', 'main', origin], { env: gitEnv() });
    const dir = path.join(base, 'work');
    cloneRepo(origin, dir, [], { cwd: base, env: gitEnv() });
    git(dir, 'checkout', '-q', '-b', 'main');
    commit(dir, 'README.md', 'init', 'init');
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    return { origin, dir, base };
  }

  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-branch-retire-1267-')); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('planWorktreeRetirement', () => {
    it('a merged branch\'s worktree is eligible, class ancestor-of-main', async () => {
      const { dir, base } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      commit(dir, 'a.txt', 'x', 'feature');
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(dir, 'push', '-q', 'origin', 'main');
      const linked = path.join(base, 'wt-feat');
      git(dir, 'worktree', 'add', '-q', linked, 'feat');

      const plan = await brs.planWorktreeRetirement({ repo: dir, cwd: path.join(base, 'elsewhere'), execFile: realExec });
      assert.equal(plan.eligible.length, 1);
      assert.equal(fs.realpathSync(plan.eligible[0].path), fs.realpathSync(linked));
      assert.equal(plan.eligible[0].class, brs.WT_CLASS.ANCESTOR_OF_MAIN);
      assert.equal(plan.skipped.length, 0);
    });

    it('a squash-merged branch\'s worktree is eligible, class identical-to-main, though not an ancestor', async () => {
      const { dir, base } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      commit(dir, 'squash.txt', 'same content', 'feature');
      git(dir, 'checkout', '-q', 'main');
      // The "squash merge": main gets the same tree content under a brand new
      // commit, so `feat` is never an ancestor of `main`.
      commit(dir, 'squash.txt', 'same content', 'squash-merge feat');
      git(dir, 'push', '-q', 'origin', 'main');
      assert.throws(() => git(dir, 'merge-base', '--is-ancestor', 'feat', 'main'), 'precondition: feat is not an ancestor of main');
      const linked = path.join(base, 'wt-feat');
      git(dir, 'worktree', 'add', '-q', linked, 'feat');

      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.eligible.length, 1);
      assert.equal(plan.eligible[0].class, brs.WT_CLASS.IDENTICAL_TO_MAIN);
    });

    it('a branch worktree whose upstream is gone is eligible, class gone-upstream', async () => {
      const { origin, dir, base } = makeClone();
      git(dir, 'branch', 'feat');
      git(dir, 'push', '-q', '-u', 'origin', 'feat');
      const linked = path.join(base, 'wt-feat');
      git(dir, 'worktree', 'add', '-q', linked, 'feat');
      git(origin, 'update-ref', '-d', 'refs/heads/feat');

      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.eligible.length, 1);
      assert.equal(plan.eligible[0].class, brs.WT_CLASS.GONE_UPSTREAM);
    });

    it('a dirty worktree is skipped, never retired, even if otherwise merged', async () => {
      const { dir, base } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      commit(dir, 'a.txt', 'x', 'feature');
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      const linked = path.join(base, 'wt-feat');
      git(dir, 'worktree', 'add', '-q', linked, 'feat');
      fs.writeFileSync(path.join(linked, 'untracked.txt'), 'oops\n');

      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.eligible.length, 0);
      assert.equal(plan.skipped.length, 1);
      assert.equal(plan.skipped[0].reason, brs.WT_SKIP.DIRTY);
    });

    it('a worktree with only a gitignored file is held, never retired — `git worktree remove` deletes ignored files too', async () => {
      const { dir, base } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'local.env\n');
      commit(dir, '.gitignore', 'local.env', 'ignore local.env');
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(dir, 'push', '-q', 'origin', 'main');
      const linked = path.join(base, 'wt-feat');
      git(dir, 'worktree', 'add', '-q', linked, 'feat');
      fs.writeFileSync(path.join(linked, 'local.env'), 'SECRET=1\n');

      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.eligible.length, 0, 'an ignored-only file must still hold the worktree');
      assert.equal(plan.skipped.length, 1);
      assert.equal(plan.skipped[0].reason, brs.WT_SKIP.DIRTY);

      const result = await brs.retireWorktrees({ eligible: [plan.skipped[0]] }, { repo: dir, apply: true, execFile: realExec });
      assert.equal(result.removed.length, 0, 'the re-verify at apply must also catch the ignored file');
      assert.equal(fs.existsSync(path.join(linked, 'local.env')), true);
    });

    it('the worktree matching the running process cwd is always skipped, whatever its state', async () => {
      const { dir, base } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      commit(dir, 'a.txt', 'x', 'feature');
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      const linked = path.join(base, 'wt-feat');
      git(dir, 'worktree', 'add', '-q', linked, 'feat');

      const plan = await brs.planWorktreeRetirement({ repo: dir, cwd: linked, execFile: realExec });
      assert.equal(plan.eligible.length, 0);
      assert.equal(plan.skipped.length, 1);
      assert.equal(plan.skipped[0].reason, brs.WT_SKIP.ACTIVE_CWD);
    });

    it('a detached worktree at an ancestor of main is eligible', async () => {
      const { dir, base } = makeClone();
      const mainSha = git(dir, 'rev-parse', 'HEAD');
      commit(dir, 'later.txt', 'x', 'later on main');
      const linked = path.join(base, 'wt-detached');
      git(dir, 'worktree', 'add', '-q', '--detach', linked, mainSha);

      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.eligible.length, 1);
      assert.equal(plan.eligible[0].class, brs.WT_CLASS.ANCESTOR_OF_MAIN);
      assert.equal(plan.eligible[0].detached, true);
    });

    it('a detached worktree at an unmerged commit is refused, not retired', async () => {
      const { dir, base } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      const sha = commit(dir, 'a.txt', 'x', 'unmerged feature');
      git(dir, 'checkout', '-q', 'main');
      const linked = path.join(base, 'wt-detached');
      git(dir, 'worktree', 'add', '-q', '--detach', linked, sha);

      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.eligible.length, 0);
      assert.equal(plan.skipped[0].reason, brs.WT_SKIP.DETACHED_UNMERGED);
    });

    it('the primary checkout is never a candidate, eligible or skipped', async () => {
      const { dir } = makeClone();
      const plan = await brs.planWorktreeRetirement({ repo: dir, cwd: path.join(path.dirname(dir), 'nowhere'), execFile: realExec });
      assert.equal(plan.eligible.length, 0);
      assert.equal(plan.skipped.length, 0);
    });

    it('fails closed when the fetch fails: an otherwise-eligible worktree is held, reason fetch-failed, never classified against stale remote refs', async () => {
      const { dir, base } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      commit(dir, 'a.txt', 'x', 'feature');
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(dir, 'push', '-q', 'origin', 'main');
      const linked = path.join(base, 'wt-feat');
      git(dir, 'worktree', 'add', '-q', linked, 'feat');
      // Break the remote so `git fetch --prune origin` fails, the same way a
      // network blip or a dead remote would — the worktree is a genuine
      // ancestor-of-main candidate were the fetch to succeed.
      git(dir, 'remote', 'set-url', 'origin', path.join(base, 'does-not-exist.git'));

      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.fetch.ok, false);
      assert.equal(plan.eligible.length, 0, 'nothing may be classified eligible off a failed fetch');
      assert.equal(plan.skipped.length, 1);
      assert.equal(plan.skipped[0].reason, brs.WT_SKIP.FETCH_FAILED);
      assert.match(plan.skipped[0].detail, /fetch failed/);
    });

    it('a worktree bound to a live session is held even though it would otherwise be eligible — checked for any path, not only agent-<hash>-named ones', async () => {
      const { dir, base } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      commit(dir, 'a.txt', 'x', 'feature');
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(dir, 'push', '-q', 'origin', 'main');
      const linked = path.join(base, 'wt-feat'); // plain name, does not match agent-<hash>
      git(dir, 'worktree', 'add', '-q', linked, 'feat');

      const seen = [];
      const lookupSession = async (p) => {
        seen.push(p);
        return fs.realpathSync(p) === fs.realpathSync(linked) ? { sessionId: 'sess-live-1' } : null;
      };
      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec, lookupSession });
      assert.equal(plan.eligible.length, 0, 'the live session must hold the tree, even though it is otherwise an ancestor-of-main');
      assert.equal(plan.skipped.length, 1);
      assert.equal(plan.skipped[0].reason, brs.WT_SKIP.LIVE_SESSION);
      assert.match(plan.skipped[0].detail, /sess-live-1/);
      assert.equal(plan.skipped[0].provenance.sessionId, 'sess-live-1');
      assert.ok(seen.length > 0, 'lookupSession must be consulted for a non-agent-named worktree too');
    });
  });

  describe('retireWorktrees', () => {
    /**
     * @returns {Promise<{dir: string, base: string, linked: string}>}
     */
    async function eligibleFixture() {
      const { dir, base } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      commit(dir, 'a.txt', 'x', 'feature');
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(dir, 'push', '-q', 'origin', 'main');
      const linked = path.join(base, 'wt-feat');
      git(dir, 'worktree', 'add', '-q', linked, 'feat');
      return { dir, base, linked };
    }

    it('--dry-run reports what would be removed and removes nothing', async () => {
      const { dir, linked } = await eligibleFixture();
      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      const result = await brs.retireWorktrees(plan, { repo: dir, apply: false, execFile: realExec });
      assert.equal(result.dryRun, true);
      assert.equal(result.removed[0].action, 'would-remove');
      assert.equal(fs.existsSync(linked), true);
    });

    it('--apply actually removes an eligible worktree', async () => {
      const { dir, linked } = await eligibleFixture();
      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      const result = await brs.retireWorktrees(plan, { repo: dir, apply: true, execFile: realExec });
      assert.equal(result.removed[0].action, 'removed');
      assert.equal(fs.existsSync(linked), false);
    });

    it('re-verifies immediately before removing: a worktree dirtied after planning is skipped at apply, not removed', async () => {
      const { dir, linked } = await eligibleFixture();
      const plan = await brs.planWorktreeRetirement({ repo: dir, execFile: realExec });
      fs.writeFileSync(path.join(linked, 'late.txt'), 'snuck in after the plan\n');

      const result = await brs.retireWorktrees(plan, { repo: dir, apply: true, execFile: realExec });
      assert.equal(result.removed.length, 0);
      assert.equal(result.skipped[0].action, 'skipped-at-apply');
      assert.equal(fs.existsSync(linked), true);
    });
  });

  describe('planBranchRetirement', () => {
    it('runs branch-first order correctly: a gone branch no worktree holds, with every commit reachable, is eligible', async () => {
      const { origin, dir } = makeClone();
      git(dir, 'branch', 'feat');
      git(dir, 'push', '-q', '-u', 'origin', 'feat');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(origin, 'update-ref', '-d', 'refs/heads/feat');

      const plan = await brs.planBranchRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.eligible.length, 1);
      assert.equal(plan.eligible[0].branch, 'feat');
      assert.equal(plan.eligible[0].assessment.verdict, brs.VERDICTS.SAFE);
    });

    it('a gone branch still held by a worktree is skipped, not retired (worktrees must retire first)', async () => {
      const { origin, dir, base } = makeClone();
      git(dir, 'branch', 'feat');
      git(dir, 'push', '-q', '-u', 'origin', 'feat');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(origin, 'update-ref', '-d', 'refs/heads/feat');
      git(dir, 'worktree', 'add', '-q', path.join(base, 'wt-feat'), 'feat');

      const plan = await brs.planBranchRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.eligible.length, 0);
      const feat = plan.skipped.find((s) => s.branch === 'feat');
      assert.equal(feat.verdict, brs.VERDICTS.PRESERVE);
    });

    it('a gone branch with a commit unique to it is skipped (preserve), never force-deleted', async () => {
      const { origin, dir } = makeClone();
      git(dir, 'checkout', '-q', '-b', 'feat');
      const wrap = commit(dir, 'wrap.md', 'x', 'unpushed wrap commit');
      git(dir, 'push', '-q', '-u', 'origin', 'feat');
      // The remote branch existed only transiently — delete it, simulating a
      // branch whose upstream went gone before the wrap commit was ever seen.
      git(origin, 'update-ref', '-d', 'refs/heads/feat');
      git(dir, 'checkout', '-q', 'main');

      const plan = await brs.planBranchRetirement({ repo: dir, execFile: realExec });
      assert.equal(plan.eligible.length, 0);
      const feat = plan.skipped.find((s) => s.branch === 'feat');
      assert.equal(feat.verdict, brs.VERDICTS.PRESERVE);
      assert.ok(feat.reasons.some((r) => r.code === brs.REASONS.UNIQUE_COMMITS));
      assert.equal(git(dir, 'rev-parse', 'feat'), wrap, 'the branch and its commit still exist');
    });

    it('a branch whose upstream is not gone is skipped outright, assess() never consulted for it', async () => {
      const { dir } = makeClone();
      git(dir, 'branch', 'feat');
      git(dir, 'push', '-q', '-u', 'origin', 'feat');

      const plan = await brs.planBranchRetirement({ repo: dir, execFile: realExec });
      const feat = plan.skipped.find((s) => s.branch === 'feat');
      assert.equal(feat.verdict, null);
      assert.match(feat.detail, /not gone/);
    });

    it('a branch named in activeBranches is held even though it would otherwise be safe to retire', async () => {
      const { origin, dir } = makeClone();
      git(dir, 'branch', 'feat');
      git(dir, 'push', '-q', '-u', 'origin', 'feat');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(origin, 'update-ref', '-d', 'refs/heads/feat');

      const plan = await brs.planBranchRetirement({ repo: dir, execFile: realExec, activeBranches: new Set(['feat']) });
      assert.equal(plan.eligible.length, 0, 'a live-session-held branch must never be eligible');
      const feat = plan.skipped.find((s) => s.branch === 'feat');
      assert.equal(feat.verdict, null, 'assess() must never even run for a branch already held by a live session');
      assert.match(feat.detail, /live session/);
    });

    it('activeBranches also accepts a plain array, not only a Set', async () => {
      const { origin, dir } = makeClone();
      git(dir, 'branch', 'feat');
      git(dir, 'push', '-q', '-u', 'origin', 'feat');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(origin, 'update-ref', '-d', 'refs/heads/feat');

      const plan = await brs.planBranchRetirement({ repo: dir, execFile: realExec, activeBranches: ['feat'] });
      assert.equal(plan.eligible.length, 0);
    });
  });

  describe('retireBranches', () => {
    /**
     * @returns {Promise<{dir: string, origin: string}>}
     */
    async function eligibleFixture() {
      const { origin, dir } = makeClone();
      git(dir, 'branch', 'feat');
      git(dir, 'push', '-q', '-u', 'origin', 'feat');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feat', 'feat');
      git(origin, 'update-ref', '-d', 'refs/heads/feat');
      return { origin, dir };
    }

    it('--dry-run reports what would be deleted and deletes nothing', async () => {
      const { dir } = await eligibleFixture();
      const plan = await brs.planBranchRetirement({ repo: dir, execFile: realExec });
      const result = await brs.retireBranches(plan, { repo: dir, apply: false, execFile: realExec });
      assert.equal(result.removed[0].action, 'would-delete');
      assert.doesNotThrow(() => git(dir, 'rev-parse', '--verify', 'feat'));
    });

    it('--apply deletes an eligible branch with plain `git branch -d`', async () => {
      const { dir } = await eligibleFixture();
      const plan = await brs.planBranchRetirement({ repo: dir, execFile: realExec });
      const result = await brs.retireBranches(plan, { repo: dir, apply: true, execFile: realExec });
      assert.equal(result.removed[0].action, 'deleted');
      assert.throws(() => git(dir, 'rev-parse', '--verify', 'refs/heads/feat'));
    });

    it('re-verifies immediately before deleting: a branch that grows a unique commit after planning is skipped at apply', async () => {
      const { dir } = await eligibleFixture();
      const plan = await brs.planBranchRetirement({ repo: dir, execFile: realExec });
      git(dir, 'checkout', '-q', 'feat');
      commit(dir, 'late.txt', 'x', 'snuck in after the plan');
      git(dir, 'checkout', '-q', 'main');

      const result = await brs.retireBranches(plan, { repo: dir, apply: true, execFile: realExec });
      assert.equal(result.removed.length, 0);
      assert.equal(result.skipped[0].action, 'skipped-at-apply');
      assert.doesNotThrow(() => git(dir, 'rev-parse', '--verify', 'feat'));
    });
  });

  describe('describeProvenance', () => {
    it('parses an issue number and reads a creation time from an agent-<hash>-<issue> directory', async () => {
      const dir = path.join(root, `agent-3f9a1c2b-1267`);
      fs.mkdirSync(dir);
      const p = await brs.describeProvenance(dir);
      assert.equal(p.issueNumber, 1267);
      assert.equal(p.source, 'name-parse');
      assert.ok(p.createdAt && !Number.isNaN(Date.parse(p.createdAt)));
      assert.equal(p.sessionId, null);
    });

    it('cross-references a caller-supplied session lookup when one resolves', async () => {
      const dir = path.join(root, `agent-00ff00ff`);
      fs.mkdirSync(dir);
      const p = await brs.describeProvenance(dir, { lookupSession: async () => ({ sessionId: 'sess-42' }) });
      assert.equal(p.sessionId, 'sess-42');
      assert.equal(p.source, 'name-parse+store');
    });

    it('an unparseable directory name yields source unknown, nothing guessed', async () => {
      const dir = path.join(root, 'scratch-dir');
      fs.mkdirSync(dir);
      const p = await brs.describeProvenance(dir);
      assert.equal(p.source, 'unknown');
      assert.equal(p.issueNumber, null);
      assert.equal(p.createdAt, null);
      assert.equal(p.sessionId, null);
    });

    it('cross-references a caller-supplied session lookup even when the directory name does not parse — a live session is not only ever named agent-<hash>', async () => {
      const dir = path.join(root, 'wt-plain-name');
      fs.mkdirSync(dir);
      const p = await brs.describeProvenance(dir, { lookupSession: async () => ({ sessionId: 'sess-99' }) });
      assert.equal(p.sessionId, 'sess-99');
      assert.equal(p.source, 'store');
      assert.equal(p.issueNumber, null, 'no name to parse an issue number from');
    });

    it('never throws when the lookup or the stat fails', async () => {
      const missing = path.join(root, 'agent-deadbeef');
      const p1 = await brs.describeProvenance(missing);
      assert.equal(p1.source, 'name-parse');
      assert.equal(p1.createdAt, null);

      const dir = path.join(root, 'agent-cafef00d');
      fs.mkdirSync(dir);
      const p2 = await brs.describeProvenance(dir, { lookupSession: async () => { throw new Error('store unreachable'); } });
      assert.equal(p2.source, 'name-parse');
      assert.equal(p2.sessionId, null);
    });
  });
});
