'use strict';
/**
 * Exclusive ownership of ONE worktree by ONE live session, and detection of a
 * foreign write landing in it underneath the session that believes it owns it.
 *
 * #1332: a worktree created and verified clean by one session can still be
 * written, committed into, and merged by a DIFFERENT repo's session (or a
 * subagent spawned by a different coordinator) with nothing noticing unless
 * the owning session happens to run `git status` at the right moment. This
 * module gives that check a name: a marker claimed per worktree, and a
 * baseline the owner can snapshot and later verify against.
 *
 * The marker lives inside the worktree's OWN gitdir (`git rev-parse
 * --git-dir`, not `--git-common-dir`) — unlike a primary checkout's shared
 * status file (`scripts/install-primary-guard.js`), ownership here is a
 * property of one specific worktree, not of the repository as a whole.
 *
 * @module lib/checkout-ownership
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const stagedWrite = require('./staged-write');

/** Marker filename inside a worktree's own gitdir. */
const MARKER_BASENAME = 'tangleclaw-owner.json';

/** Staging-name prefix for `stagedWrite.writeAtomic`, distinct per caller. */
const STAGING_PREFIX = '.checkout-ownership.';

/** Lock directory suffix for the marker's own claim/release critical section. */
const LOCK_SUFFIX = '.lock';

/** A lock older than this is presumed abandoned by a holder that crashed. */
const LOCK_STALE_MS = 30 * 1000;

/** Give up acquiring the lock after this long, rather than block forever. */
const LOCK_MAX_WAIT_MS = 2000;

/**
 * How long a claim keeps counting as "live" with no renewal, before a new
 * claimant no longer needs `force` to take over. Mirrors
 * `scripts/install-primary-guard.js`'s `LOCK_STALE_MS` convention — a session
 * that crashed mid-work must not wedge a worktree's ownership forever, but a
 * normal work session (minutes to a few hours) must not be treated as
 * abandoned out from under it.
 */
const OWNERSHIP_STALE_MS = 4 * 60 * 60 * 1000;

/**
 * Resolve the absolute path to `worktreeRoot`'s own gitdir via `git
 * rev-parse --git-dir` — the worktree-specific directory
 * (`<primary>/.git/worktrees/<name>` for a linked worktree, `.git` itself for
 * the primary), not the common dir every worktree shares.
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @returns {string} Absolute gitdir path.
 */
function gitDirFor(worktreeRoot) {
  const raw = execFileSync('git', ['-C', worktreeRoot, 'rev-parse', '--git-dir'],
    { encoding: 'utf8' }).trim();
  return path.resolve(worktreeRoot, raw);
}

/**
 * Where this worktree's ownership marker lives.
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @returns {string} Absolute path to the marker file.
 */
function markerPath(worktreeRoot) {
  return path.join(gitDirFor(worktreeRoot), MARKER_BASENAME);
}

/**
 * Write the marker atomically via the repo's shared staged-write helper
 * (`lib/staged-write.js`) rather than a second copy of the same tmp+rename
 * pattern — its directory must already exist, which the marker's always
 * does (it lives inside a gitdir git itself created).
 *
 * @param {string} file - Absolute destination path.
 * @param {object} data - Serialized as JSON.
 * @returns {void}
 */
function _writeMarkerAtomic(file, data) {
  stagedWrite.writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`, STAGING_PREFIX);
}

/**
 * A short-lived exclusive lock around one claim/release of a worktree's
 * marker, so two sessions racing to claim or release the SAME worktree
 * cannot both observe "no owner yet" and both write — the exact race
 * `evaluateWorktreeWriteAdmission` exists to protect against, now closed at
 * its own read-modify-write too. Same posture as `lib/branch-ownership.js`'s
 * lock: an atomic `mkdirSync` as the mutex, a stale lock broken rather than
 * honoured forever, and a bounded wait rather than blocking indefinitely.
 *
 * @param {string} file - The marker file this lock protects.
 * @returns {string|null} The lock path to pass to `_releaseLock`, or `null`
 *   if it could not be acquired within the wait budget.
 */
function _acquireLock(file) {
  const lockPath = `${file}${LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      let stale;
      try {
        stale = (Date.now() - fs.statSync(lockPath).mtimeMs) > LOCK_STALE_MS;
      } catch (statErr) {
        stale = true;
      }
      if (stale) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (rmErr) { /* another holder cleared it first */ }
        continue;
      }
      if (Date.now() >= deadline) return null;
      const spinUntil = Date.now() + 25;
      while (Date.now() < spinUntil) { /* short, local, synchronous — no async primitive to await here */ }
    }
  }
}

/**
 * Release a lock from `_acquireLock`. Idempotent and silent if already gone.
 * @param {string|null} lockPath
 * @returns {void}
 */
function _releaseLock(lockPath) {
  if (!lockPath) return;
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (err) { /* already gone */ }
}

/**
 * Read a worktree's ownership marker, tolerating absence or corruption the
 * same way `readStatus` does elsewhere in this repo: a marker nothing but
 * this module writes end-to-end should recover to "no owner" rather than
 * crash a caller on one stray byte.
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @returns {object|null} The owner record, or `null` if absent/unreadable.
 */
function readWorktreeOwnership(worktreeRoot) {
  let file;
  try {
    file = markerPath(worktreeRoot);
  } catch (err) {
    return null; // not a git checkout, or git itself unavailable
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * Is this owner record still within its liveness window?
 * @param {object|null} owner
 * @returns {boolean}
 */
function _isLive(owner) {
  if (!owner || typeof owner.claimedAt !== 'string') return false;
  const claimedAt = Date.parse(owner.claimedAt);
  if (!Number.isFinite(claimedAt)) return false;
  return (Date.now() - claimedAt) < OWNERSHIP_STALE_MS;
}

/**
 * Does `caller` identify the same session as `owner`?
 * @param {object|null} owner
 * @param {object|null} caller
 * @returns {boolean}
 */
function _sameOwner(owner, caller) {
  return !!owner && !!caller
    && owner.sessionId === caller.sessionId
    && owner.launchId === caller.launchId;
}

/**
 * Claim exclusive ownership of a worktree.
 *
 * Refuses a DIFFERENT, still-live owner unless `ownerMeta.force === true` —
 * an explicit assertion of authority the caller makes, not inferred. A
 * matching owner (same `sessionId` + `launchId`) re-claiming is a renewal:
 * it always succeeds and refreshes `claimedAt`.
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @param {object} ownerMeta - `{sessionId, projectId, launchId, workspaceId,
 *   branch, baselineHeadSha?, baselineStatusHash?, force?}`.
 * @returns {{ok:boolean, code?:string, owner:object}} `owner` is the record
 *   now on disk when `ok`, or the conflicting live owner when not.
 */
function claimWorktreeOwnership(worktreeRoot, ownerMeta) {
  const marker = markerPath(worktreeRoot);
  const lockPath = _acquireLock(marker);
  if (!lockPath) return { ok: false, code: 'LOCK_CONTENDED', owner: readWorktreeOwnership(worktreeRoot) };
  try {
    const existing = readWorktreeOwnership(worktreeRoot);
    if (existing && _isLive(existing) && !_sameOwner(existing, ownerMeta) && ownerMeta.force !== true) {
      return { ok: false, code: 'OWNER_MISMATCH', owner: existing };
    }
    const record = {
      sessionId: ownerMeta.sessionId,
      projectId: ownerMeta.projectId,
      launchId: ownerMeta.launchId,
      workspaceId: ownerMeta.workspaceId,
      branch: ownerMeta.branch,
      claimedAt: new Date().toISOString(),
      baselineHeadSha: ownerMeta.baselineHeadSha ?? null,
      baselineStatusHash: ownerMeta.baselineStatusHash ?? null
    };
    _writeMarkerAtomic(marker, record);
    return { ok: true, owner: record };
  } finally {
    _releaseLock(lockPath);
  }
}

/**
 * Release a worktree's ownership marker.
 *
 * Only the current owner (or an explicit `callerMeta.force === true`) may
 * release — a session releasing a worktree it does not hold must not be able
 * to clear someone else's claim by accident.
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @param {object} callerMeta - `{sessionId, launchId, force?}`.
 * @returns {{ok:boolean, code?:string, owner:object|null}} The record that
 *   was released (or `null` if there was none), or the current owner when
 *   refused.
 */
function releaseWorktreeOwnership(worktreeRoot, callerMeta) {
  const marker = markerPath(worktreeRoot);
  const lockPath = _acquireLock(marker);
  if (!lockPath) return { ok: false, code: 'LOCK_CONTENDED', owner: readWorktreeOwnership(worktreeRoot) };
  try {
    const existing = readWorktreeOwnership(worktreeRoot);
    if (!existing) return { ok: true, owner: null };
    if (!_sameOwner(existing, callerMeta) && callerMeta.force !== true) {
      return { ok: false, code: 'OWNER_MISMATCH', owner: existing };
    }
    try {
      fs.unlinkSync(marker);
    } catch (err) { /* already gone */ }
    return { ok: true, owner: existing };
  } finally {
    _releaseLock(lockPath);
  }
}

/**
 * Parse `git status --porcelain=v1 -z` output into one entry per path.
 *
 * `-z` is not a formatting nicety here — it is the only mode where git emits
 * a path's raw bytes, unquoted. In the default (non-`-z`) mode, git quotes
 * any non-ASCII byte as a C-style OCTAL escape (`"\303\251.txt"` for
 * `é.txt`), which is NOT valid JSON despite looking close to it — `\3` is
 * not a legal JSON escape, so `JSON.parse` throws, and a naive catch that
 * leaves the literal quoted string in place silently produces a path that
 * does not exist on disk (#1332 Round 2 finding). `-z` sidesteps the whole
 * quoting question: entries are NUL-separated and a rename/copy's two paths
 * (new, then original) are each their own NUL-terminated field — `R  NEW
 * NUL OLD NUL` rather than `R  OLD -> NEW`.
 *
 * @param {string} raw - Raw `-z` output.
 * @returns {{code:string, relPath:string}[]} One entry per path, using the
 *   NEW path for a rename/copy (the ORIGINAL path field is consumed but not
 *   returned — this module only cares what exists on disk now).
 */
function _parsePorcelainZ(raw) {
  const tokens = raw.split('\u0000');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue; // trailing empty field after the last NUL
    const code = token.slice(0, 2);
    const relPath = token.slice(3);
    entries.push({ code, relPath });
    // A rename or copy carries a SECOND NUL-terminated field (the original
    // path) immediately after — consume it so the next iteration lands on
    // the next real entry, not on half of this one's own record.
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') {
      i += 1;
    }
  }
  return entries;
}

/**
 * Every staged blob's OID, keyed by path relative to `worktreeRoot` — what
 * the INDEX currently holds for each staged path, independent of both HEAD
 * and the working tree. An `MM` entry (staged diff from HEAD, plus a
 * further unstaged diff on top) can have its STAGED blob changed — e.g. via
 * `git update-index --cacheinfo` — without touching the working-tree file
 * or HEAD at all; porcelain's status code stays `MM` either way, since the
 * code encodes which THREE-WAY comparisons differ, not what specifically
 * changed (#1332 Round 3 finding, confirmed empirically). Reading the
 * working-tree file, as `_entryDigest` already does, says nothing about
 * this — it is a genuinely separate piece of state this digest must cover.
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @returns {Map<string,string>} Path → index blob OID, for every path the
 *   index currently has staged. A path with no staged entry (untracked, or
 *   staged-deleted) is simply absent from the map.
 */
function _stagedBlobOids(worktreeRoot) {
  const raw = execFileSync('git', ['-C', worktreeRoot, 'ls-files', '--stage', '-z'],
    { encoding: 'utf8' });
  const map = new Map();
  for (const token of raw.split('\u0000')) {
    if (!token) continue;
    const tab = token.indexOf('\t');
    if (tab === -1) continue;
    const [, oid] = token.slice(0, tab).split(' '); // "<mode> <oid> <stage>"
    if (oid) map.set(token.slice(tab + 1), oid);
  }
  return map;
}

/**
 * A digest for one porcelain entry that changes when EITHER the working
 * tree file's content changes OR the staged index blob's content changes —
 * two different edits to the same already-modified file both show as
 * `M path` in porcelain, so the status code alone cannot tell them apart,
 * and the two content sources (working tree, index) are independent of
 * each other and of HEAD.
 *
 * Only a GENUINELY ABSENT working-tree path (deleted — `ENOENT`) digests
 * its working-tree half to a fixed sentinel. Any other read failure
 * (permissions, or anything else) means the entry exists but this could
 * not read it, which is not the same claim — silently folding that into
 * the same sentinel as "deleted" would make a real, unreadable change
 * compare as unchanged (#1332 Round 2 finding), so it throws instead of
 * returning a falsely-stable value.
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @param {string} code - The two-character porcelain status code.
 * @param {string} relPath - Path relative to `worktreeRoot`.
 * @param {Map<string,string>} stagedOids - From `_stagedBlobOids`.
 * @returns {string}
 */
function _entryDigest(worktreeRoot, code, relPath, stagedOids) {
  const stagedOid = stagedOids.get(relPath) || 'NONE';
  let buf;
  try {
    buf = fs.readFileSync(path.join(worktreeRoot, relPath));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return `${code}\u0000${relPath}\u0000ABSENT\u0000${stagedOid}`;
    }
    throw err;
  }
  const contentDigest = crypto.createHash('sha256').update(buf).digest('hex');
  return `${code}\u0000${relPath}\u0000${contentDigest}\u0000${stagedOid}`;
}

/**
 * Snapshot a worktree's current state: its HEAD commit plus a digest that
 * changes if ANY tracked, staged, or untracked file's actual content
 * changes — not merely if `git status`'s own status-code summary does, and
 * not merely the working-tree half of that content (the staged INDEX blob
 * is independently covered too).
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @returns {{headSha:string|null, statusHash:string, capturedAt:string}}
 *   `headSha` is `null` for a worktree with no commits yet (an unborn HEAD).
 */
function captureBaselineTreeState(worktreeRoot) {
  let headSha = null;
  try {
    headSha = execFileSync('git', ['-C', worktreeRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' }).trim();
  } catch (err) { /* unborn HEAD — no commits yet */ }

  const porcelain = execFileSync('git',
    ['-C', worktreeRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { encoding: 'utf8' });
  const stagedOids = _stagedBlobOids(worktreeRoot);
  const entries = _parsePorcelainZ(porcelain)
    .map(({ code, relPath }) => _entryDigest(worktreeRoot, code, relPath, stagedOids))
    .sort();

  const statusHash = crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
  return { headSha, statusHash, capturedAt: new Date().toISOString() };
}

/**
 * Has anything changed in `worktreeRoot` since `baselineState` was captured?
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @param {{headSha:string|null, statusHash:string}} baselineState - A value
 *   previously returned by `captureBaselineTreeState`.
 * @returns {{ok:boolean, code?:string, details?:object}}
 */
function verifyTreeUnchangedSinceBaseline(worktreeRoot, baselineState) {
  if (!baselineState || typeof baselineState.statusHash !== 'string') {
    return { ok: false, code: 'INVALID_BASELINE', details: { baselineState } };
  }
  const current = captureBaselineTreeState(worktreeRoot);
  if (current.headSha !== baselineState.headSha || current.statusHash !== baselineState.statusHash) {
    return { ok: false, code: 'FOREIGN_WORKTREE_MUTATION', details: { baseline: baselineState, current } };
  }
  return { ok: true };
}

/**
 * Should a write into `worktreeRoot` by `callerMeta` be admitted right now?
 *
 * Fails closed on either of two independent conditions: a different, still-
 * live session owns the worktree, or the tree has drifted since the owner's
 * own last recorded baseline (a foreign mutation, whether or not the foreign
 * session went through an engine with no `PreToolUse` hook of its own).
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @param {object} callerMeta - `{sessionId, launchId, ...}` — compared
 *   against the current owner, if any.
 * @returns {{allowed:boolean, code?:string, details?:object}}
 */
function evaluateWorktreeWriteAdmission(worktreeRoot, callerMeta) {
  const owner = readWorktreeOwnership(worktreeRoot);
  if (owner && _isLive(owner) && !_sameOwner(owner, callerMeta)) {
    return { allowed: false, code: 'OWNER_MISMATCH', details: { owner } };
  }
  if (owner && owner.baselineHeadSha !== null && owner.baselineStatusHash !== null) {
    const verified = verifyTreeUnchangedSinceBaseline(worktreeRoot,
      { headSha: owner.baselineHeadSha, statusHash: owner.baselineStatusHash });
    if (!verified.ok) return { allowed: false, code: verified.code, details: verified.details };
  }
  return { allowed: true };
}

module.exports = {
  MARKER_BASENAME,
  OWNERSHIP_STALE_MS,
  LOCK_SUFFIX,
  LOCK_STALE_MS,
  LOCK_MAX_WAIT_MS,
  gitDirFor,
  markerPath,
  claimWorktreeOwnership,
  readWorktreeOwnership,
  releaseWorktreeOwnership,
  captureBaselineTreeState,
  verifyTreeUnchangedSinceBaseline,
  evaluateWorktreeWriteAdmission
};
