'use strict';

/**
 * Did the project's last session end leaving work behind (#1544)?
 *
 * A session that is killed or crashes skips the wrap, so whatever it changed
 * stays in the project's checkout: files edited and never committed, commits
 * made and never pushed. The next session starts on top of that without being
 * told. This module compares the checkout now with the launch baseline the
 * session recorded (`lib/launch-baseline.js`) and answers:
 *
 * - `left-work` — paths changed that were not already changed at launch, or
 *   commits made since launch that no remote-tracking ref has.
 * - `clean` — neither.
 * - `unknown` — the comparison could not be made (no baseline, a different
 *   repository at the path now, git failed), with the reason.
 * - `checking` — no answer yet; one is being read.
 *
 * It applies only when the project has no active session and its latest one
 * ended `killed` or `crashed`. A wrapped session committed its own work.
 *
 * The answer is about the project's own checkout, not other worktrees, and it
 * cannot tell whose work it is: another session sharing the checkout, or the
 * operator, may have made the change. Every surface says so.
 *
 * The project list calls {@link read} on every poll, so reading never spawns.
 * It returns the cached answer and starts a refresh, off the event loop, when
 * the answer is missing or older than {@link REFRESH_AFTER_MS}. Nothing is
 * stored: the answer is always re-derived from the tree, so it clears itself
 * when the work is committed and pushed, and a new launch replaces the session
 * it is about.
 */

const fs = require('node:fs');
const store = require('./store');
const strandedCheck = require('./stranded-check');
const ownership = require('./wrap-steps/_file-ownership');
const { redactRemoteOutput } = require('./remote-output');
const { createLogger } = require('./logger');

const log = createLogger('session-leftovers');

/** How old an answer may be before a read starts a fresh one. */
const REFRESH_AFTER_MS = 30 * 1000;
/** Paths carried in an answer; the total is carried separately. */
const MAX_PATHS = 5;
/** The ended statuses that skip the wrap. */
const ENDED_WITHOUT_WRAP = new Set([store.SESSION_STATUS.KILLED, store.SESSION_STATUS.CRASHED]);

const _internal = {
  /** The prompt-free `execFile` wrapper the stranded-wrap check uses. */
  exec: (file, args, options) => strandedCheck.exec(file, args, options),
  now: () => Date.now(),
  /**
   * Whether a directory exists; swappable for tests.
   * @param {string} dir
   * @returns {boolean}
   */
  dirExists: (dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }
};

/** @type {Map<number, {sessionId: number, at: number, answer: object}>} */
const _cache = new Map();
/** @type {Map<number, Promise<object|null>>} */
const _running = new Map();

/**
 * A failed read, carried to the top of the probe.
 */
class ReadFailed extends Error {}

/**
 * The session this module answers about, or null when it does not apply.
 * @param {object} project - Project with `id`
 * @returns {object|null} The latest session, when it ended killed or crashed
 *   and nothing is active
 */
function _endedSession(project) {
  if (store.sessions.getActive(project.id)) return null;
  const latest = store.sessions.getLatest(project.id);
  return latest && ENDED_WITHOUT_WRAP.has(latest.status) ? latest : null;
}

/**
 * Run one git read and return its stdout, or throw {@link ReadFailed}.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function _git(cwd, args) {
  const r = await _internal.exec('git', args, { cwd });
  if (r.exitCode === 0 && !r.error) return r.stdout;
  const what = `git ${args[0]}`;
  if (r.error && r.error.code === 'ENOENT') throw new ReadFailed('git is not installed');
  if (r.error && (r.error.killed || r.error.signal)) throw new ReadFailed(`${what} did not finish in time`);
  const line = `${r.stderr || ''}`.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  const safe = redactRemoteOutput(line || '');
  throw new ReadFailed(safe ? `${what} failed: ${safe}` : `${what} failed (exit ${r.exitCode})`);
}

/**
 * An `unknown` answer.
 * @param {string} reason
 * @returns {object}
 */
function _unknown(reason) {
  return { state: 'unknown', reason, newPaths: [], newPathCount: 0, unpushed: null, snapshotComplete: null };
}

/**
 * Compare the checkout with the session's launch baseline.
 * @param {object} project - Project with `path`
 * @param {object} session - The ended session
 * @returns {Promise<object>} The answer, without `checkedAt`
 */
async function _probe(project, session) {
  const baseline = store.sessions.getLaunchBaseline(session.id);
  if (!baseline) {
    return _unknown('no launch record to compare with: the session launched before TangleClaw kept one, or the project is not a git repository');
  }
  const cwd = project.path;
  if (!cwd || !_internal.dirExists(cwd)) return _unknown(`the project folder is missing (${cwd || 'no path'})`);
  try {
    const top = (await _git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (baseline.toplevel && top !== baseline.toplevel) {
      return _unknown(`the project folder is now in a different repository (${top}) than at launch (${baseline.toplevel})`);
    }
    const paths = ownership.parseStatus(await _git(cwd, ownership.statusArgs())).map((e) => e.path);
    // An incomplete launch list can't say which paths are new, so every changed
    // path counts, and the answer says some may predate the session.
    const snapshotComplete = !!(baseline.dirty && !baseline.dirty.truncated);
    const atLaunch = new Set(snapshotComplete ? baseline.dirty.paths : []);
    const newPaths = paths.filter((p) => !atLaunch.has(p)).sort();

    let unpushed = null;
    let reason = null;
    try {
      const out = await _git(cwd, ['rev-list', '--count', `${baseline.sha}..HEAD`, '--not', '--remotes']);
      const n = Number.parseInt(out.trim(), 10);
      if (Number.isNaN(n)) throw new ReadFailed(`git rev-list printed no count: ${JSON.stringify(out.slice(0, 40))}`);
      unpushed = n;
    } catch (err) {
      if (!(err instanceof ReadFailed)) throw err;
      // The changed paths are still a real answer; only the commit count is unknown.
      reason = `commits since launch could not be counted: ${err.message}`;
    }

    let state;
    if (newPaths.length > 0 || unpushed > 0) state = 'left-work';
    else if (unpushed === null) state = 'unknown';
    else state = 'clean';
    return {
      state,
      reason,
      newPaths: newPaths.slice(0, MAX_PATHS),
      newPathCount: newPaths.length,
      unpushed,
      snapshotComplete
    };
  } catch (err) {
    if (err instanceof ReadFailed) return _unknown(err.message);
    throw err;
  }
}

/**
 * Read the checkout now and cache the answer. Joins a read already running for
 * the project. Never rejects.
 * @param {object} project - Project with `id`, `name` and `path`
 * @returns {Promise<object|null>} The full answer, or null when it does not apply
 */
function refresh(project) {
  const running = _running.get(project.id);
  if (running) return running;
  const p = _refresh(project).finally(() => _running.delete(project.id));
  _running.set(project.id, p);
  return p;
}

/**
 * One refresh, start to cache.
 * @param {object} project
 * @returns {Promise<object|null>}
 */
async function _refresh(project) {
  let session;
  let answer;
  try {
    session = _endedSession(project);
    if (!session) {
      _cache.delete(project.id);
      return null;
    }
    answer = await _probe(project, session);
  } catch (err) { // prawduct:allow prawduct/broad-except -- a background read must never reject; whatever failed is kept as the answer's reason
    const message = err && err.message ? err.message : String(err);
    log.warn('Could not read what the last session left behind', { project: project.name, error: message });
    if (!session) return null;
    answer = _unknown(`internal error: ${message}`);
  }
  const at = _internal.now();
  const full = { ...answer, checkedAt: new Date(at).toISOString() };
  _cache.set(project.id, { sessionId: session.id, at, answer: full });
  if (full.state === 'left-work') {
    log.info('Last session left work behind', {
      project: project.name, sessionId: session.id, status: session.status,
      newPaths: full.newPathCount, unpushed: full.unpushed
    });
  }
  return _withSession(session, full);
}

/**
 * An answer with the session it is about.
 * @param {object} session
 * @param {object} answer
 * @returns {object}
 */
function _withSession(session, answer) {
  return { scope: 'session', sessionId: session.id, status: session.status, endedAt: _iso(session.endedAt), ...answer };
}

/**
 * SQLite's `datetime('now')` text (UTC, no zone) as ISO 8601 UTC.
 * @param {string|null|undefined} text - e.g. `2026-09-16 21:39:10`
 * @returns {string|null} e.g. `2026-09-16T21:39:10Z`
 */
function _iso(text) {
  if (typeof text !== 'string' || !text) return null;
  return /Z$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
}

/**
 * What the project list shows. Never spawns: returns the cached answer and
 * starts a refresh when there is none for this session or it is stale.
 * Throws when the store cannot be read.
 * @param {object} project - Project with `id`, `name` and `path`
 * @returns {{scope: 'session', sessionId: number, status: 'killed'|'crashed', endedAt: string|null,
 *   state: 'left-work'|'clean'|'unknown'|'checking', checkedAt: string|null, reason: string|null,
 *   newPaths: string[], newPathCount: number, unpushed: number|null, snapshotComplete: boolean|null}|null}
 *   Null when there is an active session, or the latest one did not end killed or crashed.
 */
function read(project) {
  if (!project || project.id == null) return null;
  const session = _endedSession(project);
  if (!session) {
    _cache.delete(project.id);
    return null;
  }
  const cached = _cache.get(project.id);
  if (!cached || cached.sessionId !== session.id) {
    refresh(project);
    return _withSession(session, {
      state: 'checking', checkedAt: null, reason: null,
      newPaths: [], newPathCount: 0, unpushed: null, snapshotComplete: null
    });
  }
  if (_internal.now() - cached.at >= REFRESH_AFTER_MS) refresh(project);
  return _withSession(session, cached.answer);
}

/**
 * Forget every cached answer. For tests.
 */
function _reset() {
  _cache.clear();
  _running.clear();
}

module.exports = {
  read,
  refresh,
  REFRESH_AFTER_MS,
  MAX_PATHS,
  _internal,
  _reset
};
