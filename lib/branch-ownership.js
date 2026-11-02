'use strict';
/**
 * Cross-session ownership of a BRANCH (not a worktree — a branch can be
 * checked out in worktrees belonging to several sessions over its life), plus
 * review evidence bound to the exact head it was recorded against.
 *
 * #1977: any active session can `git checkout`/`git push --force` a branch a
 * DIFFERENT session's workspace owns, silently clobbering unpublished work
 * and voiding review evidence recorded against the SHA a force-push rewrites
 * out from under it. This module gives the fleet a single, file-backed record
 * of who currently owns a branch (by generation, not just by session — the
 * same session can rotate through several generations of the same work), and
 * a guard that fails closed on a cross-generation mutation of someone else's
 * branch, force-push loudest of all.
 *
 * Deliberately conservative where `lib/checkout-ownership.js` is lenient:
 * there is no `force` escape and no staleness window here. A worktree claim
 * that goes stale is a convenience problem (two sessions wanting the SAME
 * workspace); a branch ownership guard going stale on a timer would silently
 * reopen the exact force-push window this module exists to close. The only
 * sanctioned way to move a branch's ownership is `handoffBranchOwnership`,
 * which requires proving the prior owner has nothing left to lose.
 *
 * Persisted once per repository, in the gitdir every worktree of it shares
 * (`git rev-parse --git-common-dir`) — a branch is not scoped to one
 * worktree the way `lib/checkout-ownership.js`'s marker is, and a session
 * working in ANY worktree of the repo needs to see the same record.
 *
 * @module lib/branch-ownership
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const stagedWrite = require('./staged-write');

/** Where the branch-ownership store lives, relative to the common gitdir. */
const STORE_BASENAME = 'tangleclaw-branch-ownership.json';

/** Staging-name prefix for `stagedWrite.writeAtomic`, distinct per caller. */
const STAGING_PREFIX = '.branch-ownership.';

/** Lock directory suffix for the store's own read-modify-write. */
const LOCK_SUFFIX = '.lock';

/** A lock older than this is presumed abandoned by a holder that crashed. */
const LOCK_STALE_MS = 30 * 1000;

/** Give up acquiring the lock after this long, rather than block forever. */
const LOCK_MAX_WAIT_MS = 2000;

/**
 * Resolve the absolute path to the shared branch-ownership store for the
 * repository `worktreeRoot` belongs to.
 *
 * @param {string} worktreeRoot - Absolute path to any checkout of the repo.
 * @returns {string} Absolute path to the store file.
 */
function storePath(worktreeRoot) {
  const commonDir = execFileSync('git', ['-C', worktreeRoot, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8' }).trim();
  return path.join(path.resolve(worktreeRoot, commonDir), STORE_BASENAME);
}

/**
 * A short-lived exclusive lock for one read-modify-write of the store, same
 * posture as `scripts/install-primary-guard.js`'s `acquireLock`: an atomic
 * directory create as the mutex, a stale lock broken rather than honoured
 * forever, and giving up after a bounded wait rather than blocking a caller
 * indefinitely.
 *
 * @param {string} file - The store file this lock protects.
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
 * Read the store, tolerating absence or corruption — this file is owned
 * end-to-end by this module, so recovering to `{}` on one bad byte is the
 * right failure, not a reader that crashes every branch-ownership call.
 *
 * @param {string} file - Absolute path to the store.
 * @returns {object} Map of branch name to its ownership record.
 */
function _readStore(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    return {};
  }
}

/**
 * Write the store atomically via the repo's shared staged-write helper
 * (`lib/staged-write.js`) rather than a second copy of the same tmp+rename
 * pattern. `_acquireLock` already ensured the directory exists.
 * @param {string} file - Absolute path to the store.
 * @param {object} data - The full branch → record map.
 * @returns {void}
 */
function _writeStoreAtomic(file, data) {
  stagedWrite.writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`, STAGING_PREFIX);
}

/**
 * Read-modify-write the store under the lock, in one step.
 * @param {string} worktreeRoot - Absolute path to any checkout of the repo.
 * @param {function(object): *} mutate - Mutates the branch → record map in place.
 * @returns {*} Whatever `mutate` returned, or `undefined` if the lock could
 *   not be acquired (the update is skipped, never applied unlocked).
 */
function _withStore(worktreeRoot, mutate) {
  const file = storePath(worktreeRoot);
  const lockPath = _acquireLock(file);
  if (!lockPath) return undefined;
  try {
    const store = _readStore(file);
    const result = mutate(store);
    _writeStoreAtomic(file, store);
    return result;
  } finally {
    _releaseLock(lockPath);
  }
}

/**
 * Does `caller` identify the same owner generation as `record`? Compared by
 * `generationId` whenever the STORED record has one — the authoritative
 * identity once a generation scheme is in play, since the same session can
 * rotate through several generations of work on the same branch. The
 * `sessionId` + `launchId` fallback applies only when the record itself has
 * no `generationId` at all (an older or never-generationed record) — NOT
 * merely because the caller happened to omit one. Falling back whenever
 * EITHER side omits `generationId` let a caller that simply forgot to pass
 * it (same `sessionId`/`launchId`, no `generationId`) pass as the owner of a
 * bound generation it is not (#1977 Round 2 finding) — a stale or
 * mistakenly-reused session identity bypassing the one check `generationId`
 * exists to make unbypassable.
 *
 * @param {object|null} record
 * @param {object|null} caller
 * @returns {boolean}
 */
function _sameGeneration(record, caller) {
  if (!record || !caller) return false;
  if (record.generationId != null) {
    return caller.generationId != null && record.generationId === caller.generationId;
  }
  return record.sessionId === caller.sessionId && record.launchId === caller.launchId;
}

/**
 * Bind a branch to an active owner generation.
 *
 * Succeeds for a first-ever bind, or a RENEWAL by the same generation already
 * bound (refreshing `headSha`/`boundAt`). Refuses outright for a different
 * generation already bound — deliberately no `force` here (see module doc);
 * `handoffBranchOwnership` is the only sanctioned way to move it.
 *
 * @param {object} args
 * @param {string} args.branch
 * @param {string} args.worktreeRoot - Absolute path to any checkout of the repo.
 * @param {string} args.sessionId
 * @param {number|string} args.projectId
 * @param {string} args.launchId
 * @param {string} args.generationId
 * @param {string} args.headSha
 * @returns {{ok:boolean, code?:string, owner:object}}
 */
function bindBranchOwnership({ branch, worktreeRoot, sessionId, projectId, launchId, generationId, headSha }) {
  return _withStore(worktreeRoot, (store) => {
    const existing = store[branch];
    if (existing && !_sameGeneration(existing, { generationId, sessionId, launchId })) {
      return { ok: false, code: 'BRANCH_OWNED_BY_OTHER_GENERATION', owner: existing };
    }
    const record = {
      branch,
      sessionId,
      projectId,
      launchId,
      generationId,
      headSha,
      boundAt: new Date().toISOString(),
      reviewEvidence: existing ? existing.reviewEvidence : []
    };
    store[branch] = record;
    return { ok: true, owner: record };
  }) ?? { ok: false, code: 'LOCK_CONTENDED', owner: null };
}

/**
 * Transfer a branch's ownership to a new generation, after proving the prior
 * owner has nothing unpublished to lose.
 *
 * With `verifyClean !== false` (the default posture): the working tree at
 * `worktreeRoot` must be clean (`git status --porcelain` empty), and its
 * local `HEAD` must not be ahead of the prior owner's own claimed head
 * (`fromOwner.headSha`, falling back to the branch's upstream tracking ref)
 * — proof there is no local commit the outgoing owner has not published.
 *
 * @param {object} args
 * @param {string} args.branch
 * @param {object} args.fromOwner - `{sessionId, launchId, generationId, headSha?}`
 *   — the generation being handed off; refused if it does not match the
 *   branch's actual current owner.
 * @param {object} args.toOwner - `{sessionId, projectId, launchId, generationId}`
 *   — the generation taking over.
 * @param {string} args.worktreeRoot - Absolute path to any checkout of the repo.
 * @param {string} [args.reason]
 * @param {boolean} [args.verifyClean]
 * @returns {{ok:boolean, code?:string, owner?:object, details?:object}}
 */
function handoffBranchOwnership({ branch, fromOwner, toOwner, worktreeRoot, reason, verifyClean }) {
  const shouldVerify = verifyClean !== false;
  if (shouldVerify) {
    const statusOut = execFileSync('git', ['-C', worktreeRoot, 'status', '--porcelain'],
      { encoding: 'utf8' });
    if (statusOut.trim()) {
      return { ok: false, code: 'UNPUBLISHED_LOCAL_WORK', details: { reason: 'working tree is not clean' } };
    }
    let localHead = null;
    try {
      localHead = execFileSync('git', ['-C', worktreeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch (err) { /* unborn HEAD */ }

    // The REAL published head — resolved from the repository itself, never
    // from a caller-supplied value. `fromOwner.headSha` is caller-asserted:
    // a caller that simply mirrors whatever `git rev-parse HEAD` returned
    // locally (published or not) would make localHead === expectedHeadSha
    // true by construction and this check would prove nothing (#1977 Round
    // 2 finding). Try the branch's own upstream tracking ref first, then
    // `refs/remotes/origin/<branch>` for a ref that exists without
    // tracking configured.
    let publishedHeadSha = null;
    try {
      publishedHeadSha = execFileSync('git', ['-C', worktreeRoot, 'rev-parse', `${branch}@{upstream}`],
        { encoding: 'utf8' }).trim();
    } catch (err) { /* no upstream tracking configured */ }
    if (!publishedHeadSha) {
      try {
        publishedHeadSha = execFileSync('git', ['-C', worktreeRoot, 'rev-parse', `refs/remotes/origin/${branch}`],
          { encoding: 'utf8' }).trim();
      } catch (err) { /* no origin/<branch> ref either */ }
    }
    if (!publishedHeadSha) {
      // Nothing in the repository itself gives anything to compare
      // `localHead` against — there is no basis here to assert "nothing
      // unpublished," so this must refuse, not silently pass as though the
      // (unestablished) check had succeeded.
      return {
        ok: false,
        code: 'UNABLE_TO_VERIFY_PUBLICATION',
        details: { reason: 'no upstream tracking ref and no refs/remotes/origin/<branch> to verify against', localHead }
      };
    }
    if (localHead !== publishedHeadSha) {
      return {
        ok: false,
        code: 'UNPUBLISHED_LOCAL_WORK',
        details: { reason: 'local HEAD is ahead of the actual published head', localHead, publishedHeadSha }
      };
    }
    // fromOwner.headSha, if supplied, is an ADDITIONAL corroborating check —
    // never a substitute for the repository-verified publishedHeadSha above.
    if (fromOwner && fromOwner.headSha && fromOwner.headSha !== localHead) {
      return {
        ok: false,
        code: 'UNPUBLISHED_LOCAL_WORK',
        details: {
          reason: 'fromOwner.headSha does not match the actual published head',
          localHead, publishedHeadSha, fromOwnerHeadSha: fromOwner.headSha
        }
      };
    }
  }

  return _withStore(worktreeRoot, (store) => {
    const existing = store[branch];
    if (existing && fromOwner && !_sameGeneration(existing, fromOwner)) {
      return { ok: false, code: 'FROM_OWNER_MISMATCH', owner: existing };
    }
    const record = {
      branch,
      sessionId: toOwner.sessionId,
      projectId: toOwner.projectId,
      launchId: toOwner.launchId,
      generationId: toOwner.generationId,
      headSha: (existing && existing.headSha) || null,
      boundAt: new Date().toISOString(),
      reviewEvidence: existing ? existing.reviewEvidence : [],
      handoffReason: reason || null
    };
    store[branch] = record;
    return { ok: true, owner: record };
  }) ?? { ok: false, code: 'LOCK_CONTENDED' };
}

/**
 * Record one piece of review evidence against an exact head.
 *
 * @param {object} args
 * @param {string} args.branch
 * @param {string} args.headSha
 * @param {string} args.gate
 * @param {string} args.reviewerId
 * @param {string} args.verdict
 * @param {string} [args.token]
 * @param {string} args.worktreeRoot - Absolute path to any checkout of the repo.
 * @returns {{ok:boolean, evidence?:object}}
 */
function recordReviewEvidence({ branch, headSha, gate, reviewerId, verdict, token, worktreeRoot }) {
  return _withStore(worktreeRoot, (store) => {
    const existing = store[branch] || { branch, reviewEvidence: [] };
    const entry = { headSha, gate, reviewerId, verdict, token: token || null, recordedAt: new Date().toISOString() };
    existing.reviewEvidence = [...(existing.reviewEvidence || []), entry];
    store[branch] = existing;
    return { ok: true, evidence: entry };
  }) ?? { ok: false };
}

/**
 * Drop review evidence recorded against a head that no longer exists — any
 * history rewrite, rebase, or amend changes the SHA review was conducted
 * against, so evidence tied to the OLD sha stops proving anything about what
 * is actually on the branch now.
 *
 * Every evidence entry whose `headSha` is not `newHeadSha` is dropped, not
 * just ones matching `previousHeadSha` literally — several review rounds can
 * leave more than one stale sha behind a single rewrite, and all of them are
 * equally invalid once the branch has moved.
 *
 * @param {object} args
 * @param {string} args.branch
 * @param {string} args.previousHeadSha
 * @param {string} args.newHeadSha
 * @param {string} args.worktreeRoot - Absolute path to any checkout of the repo.
 * @returns {{ok:boolean, invalidatedCount:number}}
 */
function invalidateReviewEvidenceOnRewrite({ branch, previousHeadSha, newHeadSha, worktreeRoot }) {
  return _withStore(worktreeRoot, (store) => {
    const existing = store[branch];
    if (!existing) return { ok: true, invalidatedCount: 0 };
    const before = existing.reviewEvidence || [];
    const kept = before.filter((e) => e.headSha === newHeadSha);
    existing.reviewEvidence = kept;
    existing.headSha = newHeadSha;
    store[branch] = existing;
    return { ok: true, invalidatedCount: before.length - kept.length };
  }) ?? { ok: false, invalidatedCount: 0 };
}

/**
 * Should this mutation of `branch` be admitted?
 *
 * Fails closed on any cross-generation mutation of a branch that already has
 * an owner bound — `CROSS_OWNER_FORCE_PUSH_FORBIDDEN` specifically for
 * `isForcePush === true`, `CROSS_OWNER_BRANCH_MUTATION_FORBIDDEN` otherwise
 * (an ordinary checkout, commit, or push). A branch with no owner bound yet
 * has nothing to protect, so it is admitted.
 *
 * @param {object} args
 * @param {string} args.branch
 * @param {string} args.worktreeRoot - Absolute path to any checkout of the repo.
 * @param {string} [args.commandOrAction]
 * @param {boolean} [args.isForcePush]
 * @param {object} args.caller - `{sessionId, launchId, generationId?}`.
 * @param {string} [args.headSha]
 * @returns {{allowed:boolean, code?:string, details?:object}}
 */
function evaluateBranchMutationGuard({ branch, worktreeRoot, commandOrAction, isForcePush, caller, headSha }) {
  const store = _readStore(storePath(worktreeRoot));
  const record = store[branch];
  if (!record) return { allowed: true };
  if (_sameGeneration(record, caller)) return { allowed: true };
  return {
    allowed: false,
    code: isForcePush ? 'CROSS_OWNER_FORCE_PUSH_FORBIDDEN' : 'CROSS_OWNER_BRANCH_MUTATION_FORBIDDEN',
    details: { owner: record, commandOrAction: commandOrAction || null, headSha: headSha || null }
  };
}

/**
 * Read a branch's current ownership record, or `null` if none is bound.
 * @param {string} worktreeRoot - Absolute path to any checkout of the repo.
 * @param {string} branch
 * @returns {object|null}
 */
function readBranchOwnership(worktreeRoot, branch) {
  const store = _readStore(storePath(worktreeRoot));
  return store[branch] || null;
}

module.exports = {
  STORE_BASENAME,
  LOCK_SUFFIX,
  LOCK_STALE_MS,
  LOCK_MAX_WAIT_MS,
  storePath,
  bindBranchOwnership,
  handoffBranchOwnership,
  recordReviewEvidence,
  invalidateReviewEvidenceOnRewrite,
  evaluateBranchMutationGuard,
  readBranchOwnership
};
