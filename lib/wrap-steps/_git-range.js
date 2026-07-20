'use strict';

/**
 * Shared session-range resolution for wrap steps.
 *
 * Several steps need the same question answered — "which commits belong to this
 * session?" — and the answer has non-obvious parts (a recorded SHA that may no
 * longer resolve, a trunk fallback, and a two-dot/three-dot choice that means
 * different things to different git commands). Two independent copies drifted on
 * exactly the detail that is easy to get wrong: the `lastWrapSha` shape regex was
 * `{7,64}` in one and `{7,40}` in the other, for the same field.
 *
 * Range resolution is here; what each step does with the range stays with the step.
 */

const { execSync } = require('node:child_process');

/** Bound on every git call made here. */
const GIT_EXEC_TIMEOUT_MS = 10 * 1000;

/**
 * Shape of a `lastWrapSha`. The upper bound is 64, not 40, so the check keeps
 * working under SHA-256 object format rather than silently rejecting every SHA and
 * falling back to the trunk range.
 */
const SHA_RE = /^[0-9a-f]{7,64}$/i;

/** Trunk branch candidates, in preference order, for the first-wrap fallback. */
const BASE_BRANCH_CANDIDATES = ['main', 'master'];

/**
 * Resolve the range of commits belonging to the current session.
 *
 * Prefers `<lastWrapSha>..HEAD` — everything merged since the previous wrap,
 * regardless of branch topology — and falls back to the trunk branch when no SHA
 * is recorded (the project's first wrap) or the recorded one no longer resolves
 * (history rewritten by a rebase, or a fresh clone lacking that object).
 *
 * **The `dots` parameter is not cosmetic.** Three-dot means "since the merge base"
 * to `git diff` but "symmetric difference" to `git log` — a three-dot range fed to
 * `git log` lists commits that are on the base and absent from HEAD, which are not
 * this session's work. Callers must pass the form their git command reads:
 * `'three'` for `git diff`, `'two'` for `git log`. It applies only to the
 * base-branch fallback; a `<sha>..HEAD` range is two-dot either way.
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {string|null} [lastWrapSha] - `projConfig.lastWrapSha`, or null/undefined.
 * @param {object} [options] - Resolution options.
 * @param {'two'|'three'} [options.dots='three'] - Range form for the base-branch fallback.
 * @param {Function} [options.exec] - `execSync` replacement, for tests.
 * @returns {{range:string, kind:'session'|'branch', baseBranch:(string|null)}|null}
 *   Null when neither a session SHA nor a base branch resolves.
 */
function resolveSessionRange(cwd, lastWrapSha, options = {}) {
  const { dots = 'three', exec = execSync } = options;
  if (lastWrapSha && SHA_RE.test(lastWrapSha) && isResolvableCommit(cwd, lastWrapSha, exec)) {
    return { range: `${lastWrapSha}..HEAD`, kind: 'session', baseBranch: null };
  }
  const baseBranch = resolveBaseBranch(cwd, exec);
  if (baseBranch) {
    const sep = dots === 'two' ? '..' : '...';
    return { range: `${baseBranch}${sep}HEAD`, kind: 'branch', baseBranch };
  }
  return null;
}

/**
 * Whether `ref` resolves to a commit in the local repo. Peels with `^{commit}` so a
 * tag or tree object cannot masquerade as a valid range endpoint.
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {string} ref - A git ref or SHA.
 * @param {Function} [exec=execSync] - `execSync` replacement, for tests.
 * @returns {boolean}
 */
function isResolvableCommit(cwd, ref, exec = execSync) {
  try {
    exec(`git rev-parse --verify --quiet ${ref}^{commit}`, {
      cwd,
      timeout: GIT_EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return true;
  } catch {
    // `rev-parse --verify` exits non-zero for "no such ref", which is the answer
    // this function exists to give. It also exits non-zero when git is missing or
    // the directory is not a repo — indistinguishable here, and deliberately so:
    // every caller's next move on false is the same fallback. Callers that must
    // tell the two apart should probe the repo separately.
    return false;
  }
}

/**
 * Resolve the trunk branch to measure divergence from. Returns null when no
 * candidate resolves as a verifiable ref.
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {Function} [exec=execSync] - `execSync` replacement, for tests.
 * @returns {string|null}
 */
function resolveBaseBranch(cwd, exec = execSync) {
  for (const candidate of BASE_BRANCH_CANDIDATES) {
    try {
      exec(`git rev-parse --verify --quiet ${candidate}`, {
        cwd,
        timeout: GIT_EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return candidate;
    } catch {
      // Ref does not exist locally — try the next candidate.
    }
  }
  return null;
}

module.exports = {
  resolveSessionRange,
  isResolvableCommit,
  resolveBaseBranch,
  SHA_RE,
  GIT_EXEC_TIMEOUT_MS
};
