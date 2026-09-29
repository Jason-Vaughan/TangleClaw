'use strict';

/**
 * The launch baseline: what a project's git tree looked like the moment a
 * session was launched, before TangleClaw wrote anything for that launch.
 *
 * A wrap has to answer two questions about "this session" that nothing else can
 * answer after the fact:
 *
 * - **Which commits are its work?** Without a start point the wrap measured from
 *   whichever wrap stamped `lastWrapSha` last, or from the trunk on a first wrap —
 *   so merges made by other sessions were attributed to this one (#1309, #1450).
 *   `sha` is that start point.
 * - **Which uncommitted files are its work?** A file that was already dirty when
 *   the session launched belongs to someone else — the operator, or a
 *   co-resident session — and committing it under a "Session wrap" subject is
 *   the #1406 sweep. `dirty` is that set.
 *
 * - **Is a file that was dirty at launch still exactly as it was?** Governed
 *   finalization (#2027) may retire a session only when it left such a file
 *   untouched, so each dirty path is fingerprinted by identity, not by time
 *   (`fingerprints`, see {@link fingerprint}). A write that restores the same
 *   bytes leaves the fingerprint unchanged; a changed byte, symlink target,
 *   executable bit, or a removal changes it.
 *
 * Capture never throws and never blocks a launch: a directory that is not a repo,
 * a probe that fails, or one our own timeout stops all give a null baseline (or a
 * null field), logged with the reason, and the wrap falls back to what it did
 * before a baseline existed.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { wasTimedOut } = require('./exec-timeout');
const { createLogger } = require('./logger');
const ownership = require('./wrap-steps/_file-ownership');

const log = createLogger('launch-baseline');

/** Bound on each git probe. A launch waits on these, so they stay short. */
const PROBE_TIMEOUT_MS = 5 * 1000;

/** Output ceiling for the status listing; a huge untracked tree must not throw. */
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;

/**
 * Most dirty paths recorded. Past this the set is marked `truncated`, and the
 * ownership check stops trusting it as a complete list (it falls back to file
 * times), because a partial "dirty at launch" list would silently make every
 * unlisted pre-existing file look like this session's work.
 */
const MAX_DIRTY_PATHS = 5000;

/** Version of the fingerprint format, stored with the set so a reader can refuse one it does not know. */
const FINGERPRINT_VERSION = 1;

/** Largest single file fingerprinted; a larger one is recorded unfingerprinted (null). */
const MAX_FINGERPRINT_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Most bytes read to fingerprint one launch's dirty set. A launch waits on
 * this, so past the budget the remaining paths are recorded unfingerprinted
 * (null), which a reader treats as "cannot show it unchanged".
 */
const MAX_FINGERPRINT_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * The identity of one path in a work tree, as git would see it:
 * - `absent` when nothing is there;
 * - `symlink:<sha256 of the target>`;
 * - `file:<755|644>:<sha256 of the bytes>`, where the mode is the git-relevant
 *   executable bit.
 *
 * Anything it cannot establish is null: another kind (a directory, a socket),
 * an unreadable path, a file over `maxBytes`. A null never compares equal to
 * anything, so it is always "cannot show unchanged".
 * @param {string} root - Work tree root the path is relative to
 * @param {string} relPath - Repo-relative path
 * @param {number} [maxBytes] - Largest file to read
 * @returns {string|null}
 */
function fingerprint(root, relPath, maxBytes = MAX_FINGERPRINT_FILE_BYTES) {
  const abs = path.join(root, relPath);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    return _identity.missing(err);
  }
  try {
    if (st.isSymbolicLink()) return _identity.symlink(fs.readlinkSync(abs));
    if (!_identity.readable(st, maxBytes)) return null;
    return _identity.file(st, fs.readFileSync(abs));
  } catch {
    return null;
  }
}

/**
 * The one definition of the fingerprint format, shared by the launch-time
 * reader ({@link fingerprint}) and the finalize-time one ({@link fingerprintAsync}):
 * finalize compares the two byte for byte, so they must never be able to drift.
 */
const _identity = Object.freeze({
  sha: (data) => crypto.createHash('sha256').update(data).digest('hex'),
  missing: (err) => (err && err.code === 'ENOENT' ? 'absent' : null),
  symlink: (target) => `symlink:${_identity.sha(target)}`,
  readable: (st, maxBytes) => st.isFile() && st.size <= maxBytes,
  file: (st, bytes) => `file:${(st.mode & 0o111) ? '755' : '644'}:${_identity.sha(bytes)}`
});

/**
 * {@link fingerprint}, reading without blocking the event loop: for a caller on
 * a request path (governed finalization), where a large file or a slow mount
 * must not stall the server. The same identity, byte for byte.
 * @param {string} root - Work tree root the path is relative to
 * @param {string} relPath - Repo-relative path
 * @param {number} [maxBytes] - Largest file to read
 * @returns {Promise<{fingerprint: (string|null), bytes: number}>} The identity, and the bytes read for it
 */
async function fingerprintAsync(root, relPath, maxBytes = MAX_FINGERPRINT_FILE_BYTES) {
  const abs = path.join(root, relPath);
  let st;
  try {
    st = await fs.promises.lstat(abs);
  } catch (err) {
    return { fingerprint: _identity.missing(err), bytes: 0 };
  }
  try {
    if (st.isSymbolicLink()) return { fingerprint: _identity.symlink(await fs.promises.readlink(abs)), bytes: 0 };
    if (!_identity.readable(st, maxBytes)) return { fingerprint: null, bytes: 0 };
    const data = await fs.promises.readFile(abs);
    return { fingerprint: _identity.file(st, data), bytes: data.length };
  } catch {
    return { fingerprint: null, bytes: 0 };
  }
}

/**
 * Fingerprint every path in a dirty set, within the byte budget.
 * @param {string} root - Work tree root
 * @param {string[]} paths - Repo-relative paths
 * @returns {Object<string, string|null>} Path → fingerprint (null: not established)
 */
function _fingerprintAll(root, paths) {
  const out = {};
  let budget = MAX_FINGERPRINT_TOTAL_BYTES;
  for (const rel of paths) {
    let size = 0;
    try {
      const st = fs.lstatSync(path.join(root, rel));
      size = st.isFile() ? st.size : 0;
    } catch { /* absent or unreadable: fingerprint() says which */ }
    if (size > budget) {
      out[rel] = null;
      continue;
    }
    out[rel] = fingerprint(root, rel);
    budget -= size;
  }
  return out;
}

/**
 * The linked worktrees of a repository, from `git worktree list --porcelain`:
 * every worktree except the one at `toplevel`.
 * @param {string} porcelain - The command's output
 * @param {string} toplevel - The main work tree
 * @returns {string[]} Absolute paths
 */
function parseLinkedWorktrees(porcelain, toplevel) {
  const out = [];
  for (const line of String(porcelain || '').split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const wt = line.slice('worktree '.length).trim();
    if (wt && wt !== toplevel) out.push(wt);
  }
  return out;
}

/**
 * Combine a worktree's status listing with its dirty paths' fingerprints into
 * one digest. Null when any path could not be fingerprinted: a digest that
 * skipped a file would compare equal while that file changed.
 * @param {string} statusOutput - `git status` output
 * @param {Array<string|null>} fingerprints - One per dirty path, in listing order
 * @returns {string|null}
 */
function _worktreeDigestFrom(statusOutput, fingerprints) {
  if (fingerprints.some((f) => f === null)) return null;
  return _identity.sha(`${String(statusOutput)}\0${fingerprints.join('\0')}`);
}

/**
 * The digest a linked worktree's state is compared by: its full `git status`
 * listing (untracked files included) and the identity of every dirty path in
 * it, so a content change to an already-dirty file changes the digest while an
 * identical rewrite does not. Read at launch.
 * @param {string} worktree - The worktree's path
 * @param {string} statusOutput - `git status` output from {@link ownership.statusArgs}
 * @returns {string|null} Null when a dirty path could not be fingerprinted
 */
function worktreeDigest(worktree, statusOutput) {
  const paths = ownership.parseStatus(statusOutput).map((e) => e.path);
  return _worktreeDigestFrom(statusOutput, paths.map((rel) => fingerprint(worktree, rel)));
}

/**
 * {@link worktreeDigest}, reading without blocking the event loop, for
 * finalization. The same digest, byte for byte.
 * @param {string} worktree - The worktree's path
 * @param {string} statusOutput - `git status` output
 * @returns {Promise<string|null>}
 */
async function worktreeDigestAsync(worktree, statusOutput) {
  const paths = ownership.parseStatus(statusOutput).map((e) => e.path);
  const fingerprints = [];
  for (const rel of paths) fingerprints.push((await fingerprintAsync(worktree, rel)).fingerprint);
  return _worktreeDigestFrom(statusOutput, fingerprints);
}

/**
 * Record each linked worktree's state at launch, so finalization (#2027) can
 * tell a worktree this session created or changed from one the operator
 * already had. Null when the listing itself did not answer.
 * @param {string} toplevel - The main work tree
 * @param {Function} exec - `execFileSync` replacement
 * @returns {{version: number, entries: Object<string, string|null>}|null} Path → status digest (null: unreadable)
 */
function _captureWorktrees(toplevel, exec) {
  const listing = _probe(toplevel, ['worktree', 'list', '--porcelain'], exec);
  if (listing === null) return null;
  const entries = {};
  for (const wt of parseLinkedWorktrees(listing, toplevel)) {
    const status = _probe(wt, ownership.statusArgs(), exec);
    entries[wt] = status === null ? null : worktreeDigest(wt, status);
  }
  return { version: FINGERPRINT_VERSION, entries };
}

/**
 * Run one git probe and return its trimmed stdout, or null with a logged reason.
 *
 * @param {string} cwd - Directory to run in.
 * @param {string[]} args - Argv after `git`.
 * @param {Function} exec - `execFileSync` replacement, for tests.
 * @returns {string|null}
 */
function _probe(cwd, args, exec) {
  try {
    return String(exec('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'ignore']
    }));
  } catch (err) {
    // Not a repo and a missing git exit non-zero the same way, and both mean
    // "no baseline". A stop is different — the tree may well be a repo — so it
    // is logged as unknown rather than as absent.
    if (wasTimedOut(err)) {
      log.warn('launch baseline probe was stopped before it answered; recording no baseline for it', {
        cwd, command: `git ${args.join(' ')}`, timeoutMs: PROBE_TIMEOUT_MS
      });
    } else {
      log.debug('launch baseline probe did not answer', { cwd, command: `git ${args.join(' ')}`, error: err.message });
    }
    return null;
  }
}

/**
 * Capture the launch baseline for a project directory.
 *
 * @param {string} projectPath - The project's registered path.
 * @param {object} [options]
 * @param {Function} [options.exec] - `execFileSync` replacement, for tests.
 * @returns {{sha:string, toplevel:string, dirty:({paths:string[], truncated:boolean, fingerprintVersion?: number, fingerprints?: Object<string, string|null>}|null)}|null}
 *   `dirty.fingerprints` is recorded only for a complete (untruncated) set.
 *   Null when the directory is not a git repo or HEAD cannot be read (a repo with
 *   no commits yet has no start point to measure from). `dirty` is null when the
 *   status listing itself did not answer — which is NOT "clean", and the ownership
 *   check treats it as no snapshot.
 */
function capture(projectPath, options = {}) {
  const exec = options.exec || execFileSync;
  if (!projectPath || typeof projectPath !== 'string') return null;

  const toplevel = _probe(projectPath, ['rev-parse', '--show-toplevel'], exec);
  if (toplevel === null || !toplevel.trim()) return null;
  const sha = _probe(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], exec);
  if (sha === null || !sha.trim()) return null;

  // The same listing and parser the wrap uses to read the tree it commits
  // (`wrap-steps/_file-ownership`). A launch set spelled differently from the wrap
  // set would make a file dirty at launch look like the session's own change.
  const status = _probe(projectPath, ownership.statusArgs(), exec);
  let dirty = null;
  if (status !== null) {
    const paths = ownership.parseStatus(status).map((e) => e.path);
    const truncated = paths.length > MAX_DIRTY_PATHS;
    dirty = { paths: truncated ? paths.slice(0, MAX_DIRTY_PATHS) : paths, truncated };
    if (!truncated) {
      dirty.fingerprintVersion = FINGERPRINT_VERSION;
      dirty.fingerprints = _fingerprintAll(toplevel.trim(), dirty.paths);
      dirty.worktrees = _captureWorktrees(toplevel.trim(), exec);
    }
    if (truncated) {
      log.info('launch baseline dirty set is larger than the cap; wraps will judge ownership by file time', {
        projectPath, count: paths.length, cap: MAX_DIRTY_PATHS
      });
    }
  }
  return { sha: sha.trim(), toplevel: toplevel.trim(), dirty };
}

module.exports = {
  capture,
  fingerprint,
  fingerprintAsync,
  parseLinkedWorktrees,
  worktreeDigest,
  worktreeDigestAsync,
  FINGERPRINT_VERSION,
  MAX_FINGERPRINT_FILE_BYTES,
  MAX_FINGERPRINT_TOTAL_BYTES,
  MAX_DIRTY_PATHS,
  PROBE_TIMEOUT_MS
};
