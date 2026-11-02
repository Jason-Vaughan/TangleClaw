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

/** Marker filename inside a worktree's own gitdir. */
const MARKER_BASENAME = 'tangleclaw-owner.json';

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
 * Write a file atomically: write to a pid-suffixed temp file in the same
 * directory, then rename over the target. Same shape as every other atomic
 * write this repo already uses (`writeStatusAtomic`) — a crash mid-write
 * must never leave a truncated marker for the next reader.
 *
 * @param {string} file - Absolute destination path.
 * @param {object} data - Serialized as JSON.
 * @returns {void}
 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
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
  writeJsonAtomic(markerPath(worktreeRoot), record);
  return { ok: true, owner: record };
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
  const existing = readWorktreeOwnership(worktreeRoot);
  if (!existing) return { ok: true, owner: null };
  if (!_sameOwner(existing, callerMeta) && callerMeta.force !== true) {
    return { ok: false, code: 'OWNER_MISMATCH', owner: existing };
  }
  try {
    fs.unlinkSync(markerPath(worktreeRoot));
  } catch (err) { /* already gone */ }
  return { ok: true, owner: existing };
}

/**
 * Parse one `git status --porcelain` line into its status code and the path
 * it refers to (the NEW path, for a rename's `R  old -> new`).
 *
 * @param {string} line - One porcelain line, no trailing newline.
 * @returns {{code:string, relPath:string}}
 */
function _parsePorcelainLine(line) {
  const code = line.slice(0, 2);
  let rest = line.slice(3);
  const arrow = rest.indexOf(' -> ');
  if (arrow !== -1) rest = rest.slice(arrow + 4);
  if (rest.length >= 2 && rest[0] === '"' && rest[rest.length - 1] === '"') {
    try {
      rest = JSON.parse(rest);
    } catch (err) { /* leave as-is — not valid JSON-style quoting */ }
  }
  return { code, relPath: rest };
}

/**
 * A digest for one porcelain entry that changes when the FILE'S CONTENT
 * changes, not just when its status code does — two different edits to the
 * same already-modified file both show as `M path` in porcelain, so the
 * status code alone cannot tell them apart. A path that no longer exists
 * (deleted, or a directory porcelain can report but this never reads) digests
 * to a fixed sentinel instead of throwing.
 *
 * @param {string} worktreeRoot - Absolute path to a checkout.
 * @param {string} code - The two-character porcelain status code.
 * @param {string} relPath - Path relative to `worktreeRoot`.
 * @returns {string}
 */
function _entryDigest(worktreeRoot, code, relPath) {
  let contentDigest = 'ABSENT';
  try {
    const buf = fs.readFileSync(path.join(worktreeRoot, relPath));
    contentDigest = crypto.createHash('sha256').update(buf).digest('hex');
  } catch (err) { /* deleted, or unreadable — ABSENT is still a stable, comparable value */ }
  return `${code}\u0000${relPath}\u0000${contentDigest}`;
}

/**
 * Snapshot a worktree's current state: its HEAD commit plus a digest that
 * changes if ANY tracked, staged, or untracked file's actual content
 * changes — not merely if `git status`'s own status-code summary does.
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
    ['-C', worktreeRoot, 'status', '--porcelain', '--untracked-files=all'],
    { encoding: 'utf8' });
  const entries = porcelain.split('\n')
    .filter((l) => l.trim())
    .map((l) => _parsePorcelainLine(l))
    .map(({ code, relPath }) => _entryDigest(worktreeRoot, code, relPath))
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
  gitDirFor,
  markerPath,
  claimWorktreeOwnership,
  readWorktreeOwnership,
  releaseWorktreeOwnership,
  captureBaselineTreeState,
  verifyTreeUnchangedSinceBaseline,
  evaluateWorktreeWriteAdmission
};
