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
 * Capture never throws and never blocks a launch: a directory that is not a repo,
 * a probe that fails, or one our own timeout stops all give a null baseline (or a
 * null field), logged with the reason, and the wrap falls back to what it did
 * before a baseline existed.
 */

const { execFileSync } = require('node:child_process');
const { wasTimedOut } = require('./exec-timeout');
const { createLogger } = require('./logger');

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
 * Parse `git status --porcelain -z` output into repo-root-relative paths.
 *
 * Porcelain paths are relative to the repository root regardless of the cwd
 * the command ran in, which is the form the wrap compares against. A rename or
 * copy entry carries its ORIGINAL path as the next NUL field; both names are
 * recorded, since both are paths the session did not start clean on.
 *
 * @param {string} stdout - Raw `-z` output.
 * @returns {string[]} Deduplicated paths, in output order.
 */
function parsePorcelainZ(stdout) {
  const fields = String(stdout || '').split('\0');
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    add(entry.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') {
      i += 1;
      add(fields[i]);
    }
  }
  return out;
}

/**
 * Capture the launch baseline for a project directory.
 *
 * @param {string} projectPath - The project's registered path.
 * @param {object} [options]
 * @param {Function} [options.exec] - `execFileSync` replacement, for tests.
 * @returns {{sha:string, toplevel:string, dirty:({paths:string[], truncated:boolean}|null)}|null}
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

  const status = _probe(projectPath, ['status', '--porcelain', '-z', '--untracked-files=all'], exec);
  let dirty = null;
  if (status !== null) {
    const paths = parsePorcelainZ(status);
    const truncated = paths.length > MAX_DIRTY_PATHS;
    dirty = { paths: truncated ? paths.slice(0, MAX_DIRTY_PATHS) : paths, truncated };
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
  parsePorcelainZ,
  MAX_DIRTY_PATHS,
  PROBE_TIMEOUT_MS
};
