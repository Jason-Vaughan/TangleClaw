'use strict';

/**
 * One observation of `origin/main` per repository, shared by every session
 * that works a clone of it (#1678).
 *
 * Two sessions on two clones of one repository used to compare themselves
 * against two different `origin/main` refs — each only as fresh as that
 * clone's last fetch — so they could disagree about where upstream was while
 * both reading "up to date". This module asks the remote once per repository
 * (`git ls-remote origin refs/heads/main`) and hands every related session the
 * same answer, with the time it was observed.
 *
 * **Nothing is fetched into anyone's clone.** `ls-remote` reads the remote's
 * refs without writing objects, refs or locks locally, so observing from a
 * clone another session is working in cannot disturb that session. Each clone
 * then compares itself against the observed SHA using only its own objects
 * (`checkout-state.compareSnapshot`).
 *
 * **Keyed by repository identity**, the normalized origin URL
 * (`checkout-state.normalizeRemoteUrl`), never by project name or directory.
 * The first caller for an identity names the clone the observation runs from;
 * any clone of that repository gives the same answer, because `origin` in it
 * is, by construction, the URL the identity came from.
 *
 * **Unknown is never fresh.** A failed observation reads `state: 'unknown'`
 * with its reason and a null `sha`. The last successful answer is kept as
 * `lastKnown`, with its own time, so a reader can say "last seen at X" — but it
 * is never served as the current observation.
 *
 * **Off means off.** The caller passes whether the network check is enabled
 * (`behindOriginCheckEnabled` and its environment kill switch govern this
 * call too); when it is not, no call is started and the answer is
 * `state: 'disabled'`.
 *
 * @module lib/upstream-observer
 */

const gitProbe = require('./git-probe');

/** How long one observation is served before the remote is asked again. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** The branch every related session is compared against. */
const UPSTREAM_BRANCH_REF = 'refs/heads/main';

/** Seam for tests. */
const _internal = {
  execFile: gitProbe.defaultExecFile,
  now: () => Date.now()
};

// identity -> { value, at } — the last completed observation.
const _cache = new Map();
// identity -> Promise — the one in-flight observation.
const _inFlight = new Map();
// identity -> { sha, observedAt } — the last successful observation.
const _lastKnown = new Map();

/**
 * Parse `git ls-remote origin refs/heads/main` output.
 *
 * @param {string} out
 * @returns {{sha: string|null, found: boolean}|null} null when the output is malformed.
 */
function parseLsRemote(out) {
  const lines = String(out || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { sha: null, found: false };
  for (const line of lines) {
    const m = /^([0-9a-f]{7,64})\s+(\S+)$/.exec(line);
    if (!m) return null;
    if (m[2] === UPSTREAM_BRANCH_REF) return { sha: m[1], found: true };
  }
  return { sha: null, found: false };
}

/**
 * Ask the remote once. Resolves — never rejects.
 *
 * @param {{dir: string, name: string}} member - A clone of the repository.
 * @returns {Promise<{state: 'measured'|'absent'|'unknown', sha: string|null, observedAt: string|null,
 *   reason: string|null, observedFrom: string}>}
 */
async function observe(member) {
  const res = await gitProbe.runGit(_internal.execFile, member.dir,
    ['ls-remote', 'origin', UPSTREAM_BRANCH_REF], { network: true });
  const at = new Date(_internal.now()).toISOString();
  const base = { sha: null, observedAt: null, observedFrom: member.name };
  if (!res.ok) return { ...base, state: 'unknown', reason: gitProbe.failureReason('git ls-remote', res.err) };
  const parsed = parseLsRemote(res.stdout);
  if (parsed === null) return { ...base, state: 'unknown', reason: 'git ls-remote: unparseable output' };
  // The remote answered, and it has no main: a fact about the repository,
  // observed now — but not a SHA anything can be compared against.
  if (!parsed.found) return { ...base, state: 'absent', observedAt: at, reason: `origin has no ${UPSTREAM_BRANCH_REF}` };
  return { ...base, state: 'measured', sha: parsed.sha, observedAt: at, reason: null };
}

/**
 * Observe now, coalescing concurrent callers for the same identity.
 *
 * @param {string} identity
 * @param {{dir: string, name: string}} member
 * @returns {Promise<object>}
 */
function refresh(identity, member) {
  const pending = _inFlight.get(identity);
  if (pending) return pending;
  const p = observe(member).then((value) => {
    if (value.state === 'measured') _lastKnown.set(identity, { sha: value.sha, observedAt: value.observedAt });
    _cache.set(identity, { value, at: _internal.now() });
    _inFlight.delete(identity);
    return value;
  });
  _inFlight.set(identity, p);
  return p;
}

/**
 * Attach the last successful observation to an answer.
 *
 * @param {string} identity
 * @param {object} value
 * @returns {object}
 */
function _withLastKnown(identity, value) {
  return { ...value, lastKnown: _lastKnown.get(identity) || null };
}

/**
 * The observation for `identity`, returned at once. When enabled and the cache
 * is missing or older than {@link CACHE_TTL_MS}, one background observation
 * is started from `member`. Before the first answer the result is
 * `state: 'pending'`.
 *
 * @param {string|null} identity - Normalized repository identity.
 * @param {{dir: string, name: string}|null} member - A clone to observe from.
 * @param {{enabled: boolean}} opts - Whether the network check is on.
 * @returns {{state: string, sha: string|null, observedAt: string|null, reason: string|null,
 *   observedFrom: string|null, lastKnown: ({sha: string, observedAt: string}|null)}}
 */
function snapshot(identity, member, opts) {
  const empty = { sha: null, observedAt: null, observedFrom: null, lastKnown: null };
  if (!opts || opts.enabled !== true) return { ...empty, state: 'disabled', reason: 'check turned off' };
  if (!identity) return { ...empty, state: 'unknown', reason: 'no repository identity' };
  const hit = _cache.get(identity);
  if (member && (!hit || (_internal.now() - hit.at) >= CACHE_TTL_MS)) refresh(identity, member);
  if (!hit) {
    return _withLastKnown(identity, { ...empty, state: 'pending', reason: 'first observation in progress' });
  }
  return _withLastKnown(identity, hit.value);
}

/**
 * Observe when the cached answer has expired, and wait for it — the launch
 * path's warm-up. Resolves — never rejects — with the snapshot shape.
 *
 * @param {string|null} identity
 * @param {{dir: string, name: string}|null} member
 * @param {{enabled: boolean}} opts
 * @returns {Promise<object>}
 */
async function refreshIfStale(identity, member, opts) {
  if (!opts || opts.enabled !== true || !identity || !member) return snapshot(identity, member, opts);
  const hit = _cache.get(identity);
  if (!hit || (_internal.now() - hit.at) >= CACHE_TTL_MS) await refresh(identity, member);
  return snapshot(identity, member, opts);
}

/** Reset module state (tests only). */
function _reset() {
  _cache.clear();
  _inFlight.clear();
  _lastKnown.clear();
}

module.exports = {
  observe,
  refresh,
  refreshIfStale,
  snapshot,
  parseLsRemote,
  CACHE_TTL_MS,
  UPSTREAM_BRANCH_REF,
  _internal,
  _reset
};
