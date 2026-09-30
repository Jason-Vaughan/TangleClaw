'use strict';

/**
 * Publishing certification documents to the `metrics` branch: the git mechanics.
 *
 * The publisher keeps its own clone of just that branch inside the private
 * evidence base, one clone per remote (named by a digest of the remote URL),
 * each held under its own lock for the whole of a publish or read, so runs of
 * different candidates never reset, commit or push in one tree at once. It never uses the candidate's worktree, which must stay
 * exactly the candidate. It never runs the repository's git hooks, which
 * govern source work, not data. Every publish starts from the remote's current
 * tip: it fetches, discards anything local, asks the caller to compute its
 * changes against what the remote holds now, commits and pushes.
 *
 * It never force-pushes. A push the remote rejects because someone else
 * published first is retried from the new tip, with backoff, a bounded number
 * of times. Only paths under `release-certification/v1/` that name a
 * certification document can be written, so this code cannot touch source
 * even by mistake.
 *
 * @module lib/release-certification/publisher
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const privateFs = require('./private-fs');
const lockfile = require('./lockfile');
const sc = require('./scorecard');
const { REFUSAL, CertificationError } = require('./codes');

const DEFAULT_BRANCH = 'metrics';
const PUSH_ATTEMPTS = 4;
const BACKOFF_MS = 2000;
const GIT_TIMEOUT_MS = 60 * 1000;
/** How long a publish waits for another to finish with the same clone. */
const CLONE_WAIT_MS = 2 * 60 * 1000;
const CLONE_POLL_MS = 250;
/** How much of git's error output a refusal keeps: enough to diagnose, never a log. */
const STDERR_EXCERPT = 300;

/** The only paths a publish may write: the published layout's own allowlist. */
const ALLOWED_PATH = sc.PUBLISHED_PATH;

/**
 * The only kind of entry the metrics branch may hold: a regular, non-executable
 * file. A symlink, a submodule or anything else checked out into the clone
 * would let a push to `metrics` point a later read or write at a file outside
 * the clone.
 */
const REGULAR_ENTRY = '100644 blob';

/**
 * Throw a publishing refusal.
 * @param {string} code - A REFUSAL code
 * @param {string} message - Why
 * @param {object} [details] - Bounded facts
 * @returns {never}
 */
function _refuse(code, message, details) {
  throw new CertificationError(code, message, details);
}

/**
 * Run git with the repository's hooks and signing turned off: this clone
 * holds data, and a hook meant for source work has no business here.
 * @param {string[]} args - Arguments
 * @param {object} opts - `{cwd, env}`
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Result; never rejects
 */
function runGit(args, opts) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Whether a push failure is the remote having moved (retry) rather than
 * anything else (give up).
 * @param {string} stderr - git's stderr
 * @returns {boolean} True for a non-fast-forward rejection
 */
function _rejectedAsBehind(stderr) {
  return /\[rejected\]|non-fast-forward|fetch first|failed to update ref|cannot lock ref/.test(stderr);
}

/**
 * Create a publisher.
 * @param {object} ctx
 * @param {string} ctx.dir - The private directory holding one clone per remote
 * @param {string} ctx.remoteUrl - The repository to publish to
 * @param {{name: string, email: string}} ctx.identity - Commit author
 * @param {string} [ctx.branch] - Branch (default `metrics`)
 * @param {function(object): void} [ctx.onRecover] - Told when a dead publisher's clone lock is reclaimed
 * @param {object} [deps] - `{git, sleep}` seams
 * @returns {object} `{publish, read, cloneDir}`
 */
function createPublisher(ctx, deps = {}) {
  const git = deps.git || runGit;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const branch = ctx.branch || DEFAULT_BRANCH;
  const key = crypto.createHash('sha256').update(ctx.remoteUrl).digest('hex').slice(0, 16);
  const clone = { ...ctx, dir: path.join(ctx.dir, key) };
  const lockPath = path.join(ctx.dir, `${key}.lock`);
  const env = {
    GIT_AUTHOR_NAME: ctx.identity.name, GIT_AUTHOR_EMAIL: ctx.identity.email,
    GIT_COMMITTER_NAME: ctx.identity.name, GIT_COMMITTER_EMAIL: ctx.identity.email,
    GIT_TERMINAL_PROMPT: '0'
  };

  /**
   * Run git in the clone, refusing on failure.
   * @param {string[]} args - Arguments
   * @param {string} step - What was being done, for the refusal
   * @returns {Promise<string>} stdout
   */
  async function must(args, step) {
    const r = await git(args, { cwd: clone.dir, env });
    if (r.code !== 0) _refuse(REFUSAL.PUBLISH_FAILED, `git ${step} failed`, { step, stderr: r.stderr.trim().slice(-STDERR_EXCERPT) });
    return r.stdout;
  }

  /**
   * Hold the clone's lock around `fn`, waiting (without blocking the event
   * loop) while another publish is using the same clone.
   * @param {function(): Promise<*>} fn - Work to do under the lock
   * @returns {Promise<*>} What `fn` returns
   */
  async function withClone(fn) {
    privateFs.ensurePrivateDir(ctx.dir);
    const deadline = Date.now() + (deps.cloneWaitMs ?? CLONE_WAIT_MS);
    let token = null;
    while (token === null) {
      try {
        token = lockfile.acquire(lockPath, {
          timeoutMs: 0,
          onReclaim: (holder) => ctx.onRecover && ctx.onRecover({ kind: 'publish-lock-reclaimed', holder })
        });
      } catch (err) {
        if (err.code !== REFUSAL.LOCK_HELD || Date.now() >= deadline) throw err;
        // A real timer, not the backoff seam: waiting must yield to the event
        // loop, or the holder's git process could never finish.
        await new Promise((r) => setTimeout(r, CLONE_POLL_MS));
      }
    }
    try {
      return await fn();
    } finally {
      lockfile.release(lockPath, token);
    }
  }

  /**
   * Make the private clone if it does not exist yet.
   * @returns {Promise<void>}
   */
  async function ensureClone() {
    privateFs.ensurePrivateDir(clone.dir);
    if (fs.existsSync(path.join(clone.dir, '.git'))) {
      const url = await git(['remote', 'get-url', 'origin'], { cwd: clone.dir, env });
      if (url.code !== 0 || url.stdout.trim() !== ctx.remoteUrl) await must(['remote', 'set-url', 'origin', ctx.remoteUrl], 'remote set-url');
      return;
    }
    // No template: the machine's git template carries hooks for source repos,
    // and this clone holds only published data.
    await must(['init', '--template=', '-q', `--initial-branch=${branch}`], 'init');
    await must(['remote', 'add', 'origin', ctx.remoteUrl], 'remote add');
  }

  /**
   * Bring the clone to the remote's current tip, discarding anything local.
   * When the remote has no such branch yet, start an empty one.
   * @returns {Promise<boolean>} True when the remote branch exists
   */
  async function sync() {
    const fetched = await git(['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: clone.dir, env });
    if (fetched.code !== 0) {
      const probe = await git(['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: clone.dir, env });
      if (probe.code !== 2) _refuse(REFUSAL.PUBLISH_FAILED, 'could not reach the metrics remote', { step: 'fetch', stderr: fetched.stderr.trim().slice(-STDERR_EXCERPT) });
      await git(['update-ref', '-d', `refs/remotes/origin/${branch}`], { cwd: clone.dir, env });
      await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: clone.dir, env });
      await git(['update-ref', '-d', `refs/heads/${branch}`], { cwd: clone.dir, env });
      await must(['read-tree', '--empty'], 'read-tree');
      await must(['clean', '-q', '-fdx'], 'clean');
      return false;
    }
    // Judged from git's own record before anything is checked out, so a
    // symlink or submodule on the branch never reaches the working tree.
    const listed = await must(['ls-tree', '-r', '-z', '--format=%(objectmode) %(objecttype)%x09%(path)', `refs/remotes/origin/${branch}`], 'ls-tree');
    const irregular = listed.split('\0').filter(Boolean).map((e) => e.split('\t')).filter(([kind]) => kind !== REGULAR_ENTRY);
    if (irregular.length > 0) {
      _refuse(REFUSAL.METRICS_TREE_UNSAFE, 'the metrics branch holds an entry that is not a regular file', { entries: irregular.slice(0, 5).map(([kind, p]) => ({ kind, path: p })) });
    }
    await must(['checkout', '-q', '-B', branch, `refs/remotes/origin/${branch}`], 'checkout');
    await must(['reset', '-q', '--hard', `refs/remotes/origin/${branch}`], 'reset');
    await must(['clean', '-q', '-fdx'], 'clean');
    return true;
  }

  /**
   * Read a published file as the local clone holds it after `sync`.
   * @param {string} rel - Repository-relative path
   * @returns {string|null} Contents, or null when absent
   */
  function readLocal(rel) {
    const abs = _insideClone(rel, false);
    return abs === null ? null : privateFs.readPrivate(abs);
  }

  /**
   * The absolute path of a clone file, after checking that no directory on
   * the way to it is a symlink or anything but a directory. `sync` already
   * refuses a branch holding one; this holds even if something else put one
   * in the clone.
   * @param {string} rel - Repository-relative path
   * @param {boolean} create - Create missing directories (0700) on the way
   * @returns {string|null} The path, or null when a directory on the way is missing and `create` is false
   */
  function _insideClone(rel, create) {
    const parts = rel.split('/');
    let at = clone.dir;
    for (const part of parts.slice(0, -1)) {
      at = path.join(at, part);
      if (create) privateFs.ensurePrivateDir(at);
      else {
        let st;
        try {
          st = fs.lstatSync(at);
        } catch (err) {
          if (err.code === 'ENOENT') return null;
          throw err;
        }
        if (!st.isDirectory() || st.isSymbolicLink()) _refuse(REFUSAL.METRICS_TREE_UNSAFE, 'a directory in the metrics clone is not a plain directory', { path: rel });
      }
    }
    return path.join(at, parts[parts.length - 1]);
  }

  /**
   * Write the changed files, refusing any path outside the allowlist.
   * @param {Object<string, string>} files - Path to contents
   * @returns {string[]} Paths written
   */
  function writeFiles(files) {
    const written = [];
    for (const [rel, text] of Object.entries(files)) {
      if (!ALLOWED_PATH.test(rel)) _refuse(REFUSAL.PATH_NOT_ALLOWED, 'refusing to publish outside the certification documents', { path: rel });
      // Private, and never through a symlink: the rename replaces whatever
      // entry is there rather than following it.
      privateFs.replaceAtomic(_insideClone(rel, true), text);
      written.push(rel);
    }
    return written;
  }

  /**
   * Publish: compute changes against the remote's current tip, commit and
   * push, retrying from the new tip when someone else published first.
   * @param {function(function(string): (string|null)): (Object<string, string>|Promise<Object<string, string>>)} build - Given a reader of the remote's files, returns the files to write
   * @param {string} message - Commit message
   * @returns {Promise<{changed: boolean, commit: string|null}>} What was published
   */
  async function publish(build, message) {
    return withClone(async () => {
      await ensureClone();
      return _publishLocked(build, message);
    });
  }

  /**
   * The body of `publish`, run under the clone lock.
   * @param {Function} build - As for `publish`
   * @param {string} message - Commit message
   * @returns {Promise<{changed: boolean, commit: string|null}>} What was published
   */
  async function _publishLocked(build, message) {
    for (let attempt = 1; ; attempt++) {
      await sync();
      const files = await build(readLocal);
      const written = writeFiles(files);
      if (written.length === 0) return { changed: false, commit: null };
      await must(['add', '--', ...written], 'add');
      const staged = await git(['diff', '--cached', '--quiet'], { cwd: clone.dir, env });
      if (staged.code === 0) return { changed: false, commit: null };
      await must(['commit', '-q', '-m', message], 'commit');
      const pushed = await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: clone.dir, env });
      if (pushed.code === 0) return { changed: true, commit: (await must(['rev-parse', 'HEAD'], 'rev-parse')).trim() };
      if (!_rejectedAsBehind(pushed.stderr) || attempt >= PUSH_ATTEMPTS) {
        _refuse(REFUSAL.PUBLISH_FAILED, 'the metrics branch did not accept the publish', { step: 'push', attempts: attempt, stderr: pushed.stderr.trim().slice(-STDERR_EXCERPT) });
      }
      await sleep(BACKOFF_MS * attempt);
    }
  }

  /**
   * Read a file as the remote holds it now, fetched fresh: the read-back that
   * proves a publish landed.
   * @param {string} rel - Repository-relative path
   * @returns {Promise<string|null>} Contents, or null when absent
   */
  async function read(rel) {
    return withClone(async () => {
      await ensureClone();
      const exists = await sync();
      return exists ? readLocal(rel) : null;
    });
  }

  return { publish, read, cloneDir: clone.dir };
}

/**
 * Where and as whom a candidate's scorecard is published: the worktree's
 * `origin` and the operator's configured git identity. Commits on the public
 * branch carry the operator's own name, never an invented one.
 * @param {string} worktreePath - Candidate worktree
 * @param {function} [git] - `runGit` seam
 * @returns {Promise<{remoteUrl: string, identity: {name: string, email: string}}>} Facts
 */
async function repoFacts(worktreePath, git = runGit) {
  return { remoteUrl: await repoRemote(worktreePath, git), identity: await repoIdentity(worktreePath, git) };
}

/**
 * Read one git value from a worktree, refusing when it is not set.
 * @param {string} worktreePath - Candidate worktree
 * @param {string[]} args - git arguments
 * @param {string} what - What the value is, for the refusal
 * @param {function} git - `runGit` seam
 * @returns {Promise<string>} The value
 */
async function _readGit(worktreePath, args, what, git) {
  const r = await git(args, { cwd: worktreePath, env: {} });
  const v = r.stdout.trim();
  if (r.code !== 0 || !v) _refuse(REFUSAL.PUBLISH_FAILED, `could not read the worktree's ${what}`, { step: what });
  return v;
}

/**
 * The worktree's `origin`: where a run publishes when none is pinned.
 * @param {string} worktreePath - Candidate worktree
 * @param {function} [git] - `runGit` seam
 * @returns {Promise<string>} Remote URL
 */
async function repoRemote(worktreePath, git = runGit) {
  return _readGit(worktreePath, ['remote', 'get-url', 'origin'], 'origin', git);
}

/**
 * The operator's configured git identity. Read only when a run publishes the
 * operator's id: one that withholds it commits as a neutral identity and
 * needs no git configuration at all, as a guest may have none.
 * @param {string} worktreePath - Candidate worktree
 * @param {function} [git] - `runGit` seam
 * @returns {Promise<{name: string, email: string}>} Identity
 */
async function repoIdentity(worktreePath, git = runGit) {
  return { name: await _readGit(worktreePath, ['config', 'user.name'], 'user.name', git), email: await _readGit(worktreePath, ['config', 'user.email'], 'user.email', git) };
}

module.exports = { DEFAULT_BRANCH, ALLOWED_PATH, PUSH_ATTEMPTS, runGit, createPublisher, repoFacts, repoRemote, repoIdentity };
