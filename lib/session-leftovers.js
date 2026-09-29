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
 * The cached answer applies only when the project has no active session and
 * its latest one ended `killed` or `crashed`: a wrapped session committed its
 * own work. {@link probe} is also called directly, in strict mode, by governed
 * finalization (#2027) about a live session.
 *
 * The answer is about the project's own checkout, not other worktrees, and it
 * cannot tell whose work it is: another session sharing the checkout, or the
 * operator, may have made the change. Every surface says so.
 *
 * The default mode never reads the folder on the event loop, where a blocked
 * read stops the whole server: the folder is read by spawned `git` (killed by
 * its timeout), and whether it exists at all comes from the project list's
 * scanner. Strict mode reads file contents asynchronously within a byte
 * budget, with one exception: it asks the wrap's TangleClaw-ownership judge
 * (`wrap-steps/_tc-owned-paths#judge`), which reads the few files TangleClaw
 * writes synchronously and runs `git show` with a 10 s timeout. That is the
 * same judge, with the same cost, that the wrap pipeline runs in-process.
 *
 * The project list calls {@link read} on every poll, so reading never spawns.
 * It returns the cached answer and starts a refresh, off the event loop, when
 * the answer is missing or older than {@link REFRESH_AFTER_MS}. Nothing is
 * stored: the answer is always re-derived from the tree, so it clears itself
 * when the work is committed and pushed, and a new launch replaces the session
 * it is about.
 */

const store = require('./store');
const strandedCheck = require('./stranded-check');
const strandedWraps = require('./stranded-wraps');
const ownership = require('./wrap-steps/_file-ownership');
const tcOwned = require('./wrap-steps/_tc-owned-paths');
const launchBaseline = require('./launch-baseline');
const { describeFailure } = require('./exec');
const { createLogger } = require('./logger');

const log = createLogger('session-leftovers');

/** How old an answer may be before a read starts a fresh one. */
const REFRESH_AFTER_MS = 30 * 1000;
/** Paths carried in an answer; the total is carried separately. */
const MAX_PATHS = 5;
/** The ended statuses that skip the wrap. */
const ENDED_WITHOUT_WRAP = new Set([store.SESSION_STATUS.KILLED, store.SESSION_STATUS.CRASHED]);

const _internal = {
  /** The shared runner (`lib/exec.js`) with the stranded-wrap check's git timeout and output cap. */
  exec: (file, args, options) => strandedCheck.exec(file, args, options),
  now: () => Date.now(),
  /** The byte budget strict mode spends re-reading launch-dirty files; the launch's own cap. */
  fingerprintBudget: () => launchBaseline.MAX_FINGERPRINT_TOTAL_BYTES
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
  if (r.exitCode === 0) return r.stdout;
  if (r.errorCode === 'ENOENT') throw new ReadFailed(await strandedCheck.spawnFailure(cwd, _internal.exec));
  throw new ReadFailed(describeFailure(r, `git ${args[0]}`));
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
 * @param {object} session - The session whose launch baseline is compared (ended, or live for finalization)
 * @param {{exists?: boolean, unreadable?: string|null}|null} folder - What the
 *   scanner last said about the folder, when the caller has it
 * @param {object} [opts]
 * @param {boolean} [opts.strict] - Strict mode, for a decision that acts on the
 *   answer (governed finalization, #2027) rather than a display:
 *   - it refreshes every remote-tracking ref first (`git fetch --all --prune`),
 *     and a failed fetch answers `unknown`, because a stale ref can hold a
 *     commit the remote no longer has;
 *   - it requires a complete launch dirty set with identity fingerprints
 *     (`launch-baseline#fingerprint`), and a legacy baseline without them
 *     answers `unknown`;
 *   - a path dirty at launch whose fingerprint now differs (a byte, a symlink
 *     target, the executable bit, a removal or revert) is reported in
 *     `changedAtLaunchPaths` and makes the answer `left-work`. A rewrite that
 *     restores the exact fingerprint is not a change, whatever its file time;
 *   - a fingerprint that cannot be established, then or now, answers `unknown`;
 *   - paths TangleClaw provably owns (`wrap-steps/_tc-owned-paths#judge`:
 *     machine state, or a maintenance change to a file it writes) are not the
 *     session's work;
 *   - commits made since the session started on ANY local branch that no
 *     remote has, and stash entries created since then, are the session's
 *     work (`unpushedOnBranches`, `stashes`), judged by commit time because
 *     the baseline records only HEAD.
 * @returns {Promise<object>} The answer, without `checkedAt`
 */
async function _probe(project, session, folder, opts = {}) {
  const baseline = store.sessions.getLaunchBaseline(session.id);
  if (!baseline) {
    return _unknown('no launch record to compare with: the session launched before TangleClaw kept one, or the project is not a git repository');
  }
  const cwd = project.path;
  if (!cwd) return _unknown('the project has no folder path');
  // A folder the scanner could not find or read is not spawned into: git would
  // only wait out its timeout there.
  if (folder && folder.unreadable) return _unknown(`the project folder could not be read: ${folder.unreadable}`);
  if (folder && folder.exists === false) return _unknown(`the project folder is missing (${cwd})`);
  try {
    const top = (await _git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (baseline.toplevel && top !== baseline.toplevel) {
      return _unknown(`the project folder is now in a different repository (${top}) than at launch (${baseline.toplevel})`);
    }
    const strict = opts.strict === true;
    if (strict) {
      const dirty = baseline.dirty;
      if (!dirty || dirty.truncated) {
        return _unknown('the launch recorded no complete list of files already changed, so work since launch cannot be told apart from work before it');
      }
      if (dirty.paths.length > 0 && (!dirty.fingerprints || dirty.fingerprintVersion !== launchBaseline.FINGERPRINT_VERSION)) {
        return _unknown('the launch baseline predates identity fingerprints, so files already changed at launch cannot be shown untouched');
      }
      await _git(cwd, ['fetch', '--all', '--prune', '--quiet']);
    }
    const entries = ownership.parseStatus(await _git(cwd, ownership.statusArgs()));
    const paths = entries.map((e) => e.path);
    // An incomplete launch list can't say which paths are new, so every changed
    // path counts, and the answer says some may predate the session.
    const snapshotComplete = !!(baseline.dirty && !baseline.dirty.truncated);
    const atLaunch = new Set(snapshotComplete ? baseline.dirty.paths : []);
    // Strict mode judges TangleClaw's own writes the way the wrap does: machine
    // state and a provably-TangleClaw maintenance change (the engine config's
    // managed block, regenerated at launch after the baseline) are not the
    // session's work. Without this, every managed session whose generated block
    // changed would read as having left work.
    const tcOwnedPaths = strict ? new Set(tcOwned.judge(top, entries).keys()) : new Set();
    const newPaths = paths.filter((p) => !atLaunch.has(p) && !tcOwnedPaths.has(p)).sort();
    let changedAtLaunchPaths = [];
    if (strict) {
      const verdict = await _launchIdentity(top, baseline.dirty, tcOwnedPaths);
      if (verdict.unverifiable.length > 0) {
        return _unknown(`files already changed at launch cannot be shown untouched: ${verdict.unverifiable.slice(0, MAX_PATHS).join(', ')}`);
      }
      changedAtLaunchPaths = verdict.changed;
    }

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

    // Strict mode also looks past HEAD: a commit made since launch on another
    // local branch, or work stashed since launch, is the session's own work
    // even though HEAD does not show it. Judged by commit time against the
    // session's start, because the baseline records only HEAD.
    let elsewhere = null;
    if (strict) {
      const since = _startedAtSec(session);
      if (since === null) return _unknown('the session has no readable start time to compare other branches and stashes against');
      elsewhere = await _workElsewhere(cwd, since);
    }

    let state;
    if (newPaths.length > 0 || unpushed > 0 || changedAtLaunchPaths.length > 0
        || (elsewhere && (elsewhere.unpushedOnBranches > 0 || elsewhere.stashes > 0))) state = 'left-work';
    else if (unpushed === null) state = 'unknown';
    else state = 'clean';
    return {
      state,
      reason,
      newPaths: newPaths.slice(0, MAX_PATHS),
      newPathCount: newPaths.length,
      unpushed,
      snapshotComplete,
      ...(strict ? {
        changedAtLaunchPaths: changedAtLaunchPaths.slice(0, MAX_PATHS),
        changedAtLaunchCount: changedAtLaunchPaths.length,
        tangleclawOwnedCount: tcOwnedPaths.size,
        unpushedOnBranches: elsewhere.unpushedOnBranches,
        stashes: elsewhere.stashes
      } : {})
    };
  } catch (err) {
    if (err instanceof ReadFailed) return _unknown(err.message);
    throw err;
  }
}

/**
 * A session row's start as epoch seconds. SQLite's `datetime('now')` is UTC
 * with no zone marker.
 * @param {object} session - Session with `startedAt`
 * @returns {number|null}
 */
function _startedAtSec(session) {
  const raw = session && session.startedAt;
  if (typeof raw !== 'string' || !raw) return null;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Work a session may have left outside HEAD: commits made at or after
 * `sinceSec` on any local branch that no remote-tracking ref has, and stash
 * entries created at or after it. Throws {@link ReadFailed} when git cannot
 * answer.
 * @param {string} cwd - The checkout
 * @param {number} sinceSec - Session start, epoch seconds
 * @returns {Promise<{unpushedOnBranches: number, stashes: number}>}
 */
async function _workElsewhere(cwd, sinceSec) {
  const out = await _git(cwd, ['rev-list', '--count', '--branches', '--not', '--remotes', `--since-as-filter=@${sinceSec}`]);
  const unpushedOnBranches = Number.parseInt(out.trim(), 10);
  if (Number.isNaN(unpushedOnBranches)) throw new ReadFailed(`git rev-list printed no count: ${JSON.stringify(out.slice(0, 40))}`);
  // No stash ref is no stash: `rev-parse --verify --quiet` exits 1 and prints nothing.
  const probe = await _internal.exec('git', ['rev-parse', '--verify', '--quiet', 'refs/stash'], { cwd });
  let stashes = 0;
  if (probe.exitCode === 0) {
    const times = await _git(cwd, ['log', '-g', '--format=%ct', 'refs/stash']);
    stashes = times.split('\n').filter((t) => t.trim() && Number(t) >= sinceSec).length;
  } else if (probe.exitCode !== 1) {
    throw new ReadFailed(describeFailure(probe, 'git rev-parse refs/stash'));
  }
  return { unpushedOnBranches, stashes };
}

/**
 * Compare each path dirty at launch with its launch fingerprint. Reads without
 * blocking the event loop, and within the same total byte budget the launch
 * fingerprinted under: a path past it cannot be shown untouched.
 * @param {string} toplevel - Repository root the paths are relative to
 * @param {{paths: string[], fingerprints: Object<string, string|null>}} dirty - The launch dirty set
 * @param {Set<string>} tcOwnedPaths - Paths TangleClaw owns, which are not compared
 * @returns {Promise<{changed: string[], unverifiable: string[]}>} Both sorted
 */
async function _launchIdentity(toplevel, dirty, tcOwnedPaths) {
  const changed = [];
  const unverifiable = [];
  let budget = _internal.fingerprintBudget();
  for (const rel of dirty.paths) {
    if (tcOwnedPaths.has(rel)) continue;
    const then = dirty.fingerprints[rel];
    if (typeof then !== 'string' || budget <= 0) { unverifiable.push(rel); continue; }
    const { fingerprint: now, bytes } = await launchBaseline.fingerprintAsync(toplevel, rel, Math.min(budget, launchBaseline.MAX_FINGERPRINT_FILE_BYTES));
    budget -= bytes;
    if (now === null) unverifiable.push(rel);
    else if (now !== then) changed.push(rel);
  }
  return { changed: changed.sort(), unverifiable: unverifiable.sort() };
}

/**
 * Read the checkout now and cache the answer. Joins a read already running for
 * the project. Never rejects.
 * @param {object} project - Project with `id`, `name` and `path`
 * @param {{exists?: boolean, unreadable?: string|null}} [folder] - The scanner's
 *   latest facts about the folder, when the caller has them
 * @returns {Promise<object|null>} The full answer, or null when it does not apply
 */
function refresh(project, folder) {
  const running = _running.get(project.id);
  if (running) return running;
  const p = _refresh(project, folder || null).finally(() => _running.delete(project.id));
  _running.set(project.id, p);
  return p;
}

/**
 * One refresh, start to cache.
 * @param {object} project
 * @param {object|null} folder - Scanner facts, or null
 * @returns {Promise<object|null>}
 */
async function _refresh(project, folder) {
  let session;
  let answer;
  try {
    session = _endedSession(project);
    if (!session) {
      _cache.delete(project.id);
      return null;
    }
    answer = await _probe(project, session, folder);
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
  return { scope: 'session', sessionId: session.id, status: session.status, endedAt: strandedWraps.isoFromSqlite(session.endedAt), ...answer };
}


/**
 * What the project list shows. Never spawns: returns the cached answer and
 * starts a refresh when there is none for this session or it is stale.
 * Throws when the store cannot be read.
 * @param {object} project - Project with `id`, `name` and `path`
 * @param {{exists?: boolean, unreadable?: string|null}} [folder] - The scanner's
 *   latest facts about the folder, passed to a refresh this read starts
 * @returns {{scope: 'session', sessionId: number, status: 'killed'|'crashed', endedAt: string|null,
 *   state: 'left-work'|'clean'|'unknown'|'checking', checkedAt: string|null, reason: string|null,
 *   newPaths: string[], newPathCount: number, unpushed: number|null, snapshotComplete: boolean|null}|null}
 *   Null when there is an active session, or the latest one did not end killed or crashed.
 */
function read(project, folder) {
  if (!project || project.id == null) return null;
  const session = _endedSession(project);
  if (!session) {
    _cache.delete(project.id);
    return null;
  }
  const cached = _cache.get(project.id);
  if (!cached || cached.sessionId !== session.id) {
    refresh(project, folder);
    return _withSession(session, {
      state: 'checking', checkedAt: null, reason: null,
      newPaths: [], newPathCount: 0, unpushed: null, snapshotComplete: null
    });
  }
  if (_internal.now() - cached.at >= REFRESH_AFTER_MS) refresh(project, folder);
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
  // The comparison itself, for a caller that must decide on a live session's
  // checkout now rather than read a cached answer about an ended one: governed
  // finalization (#2027) refuses a session with work of its own to wrap.
  probe: _probe,
  REFRESH_AFTER_MS,
  MAX_PATHS,
  _internal,
  _reset
};
