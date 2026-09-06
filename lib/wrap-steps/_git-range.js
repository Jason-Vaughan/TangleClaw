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
const { wasTimedOut } = require('../exec-timeout');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-git-range');

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
 * Note that a probe was STOPPED by our own timeout rather than answering.
 *
 * Every probe here answers a yes/no question by catching a non-zero exit, which
 * makes a killed command indistinguishable from a confident "no" — and each of
 * those "no"s widens the session range. A stopped `merge-base --is-ancestor`
 * reads as "the recorded SHA is orphaned" and silently falls back to the whole
 * trunk divergence, which is the range-ballooning shape that made a wrap sweep
 * up sessions of already-released work. The fallback is still the right move on
 * an unknown answer; what was missing was any record that the answer was
 * unknown rather than negative (#897).
 *
 * @param {Error} err - The error `execSync` threw.
 * @param {string} command - The git command, for the log line.
 * @param {string} cwd - Where it ran.
 * @param {((command: string) => void)|null} onStopped - Optional collector so a
 *   caller can report the degraded answer alongside the range it returns.
 * @returns {void}
 */
function _noteIfStopped(err, command, cwd, onStopped) {
  if (!wasTimedOut(err)) return;
  log.warn('git probe was stopped before it answered; treating it as a negative answer', {
    command, cwd, timeoutMs: GIT_EXEC_TIMEOUT_MS
  });
  if (onStopped) onStopped(command);
}

/**
 * Resolve the range of commits belonging to the current session.
 *
 * Prefers `<lastWrapSha>..<tip>` — everything merged since the previous wrap,
 * regardless of branch topology — and falls back to the trunk branch when no SHA
 * is recorded (the project's first wrap) or the recorded one no longer resolves
 * (history rewritten by a rebase, or a fresh clone lacking that object).
 *
 * **The `dots` parameter is not cosmetic.** Three-dot means "since the merge base"
 * to `git diff` but "symmetric difference" to `git log` — a three-dot range fed to
 * `git log` lists commits that are on the base and absent from HEAD, which are not
 * this session's work. Callers must pass the form their git command reads:
 * `'three'` for `git diff`, `'two'` for `git log`. It applies only to the
 * base-branch fallback; a `<sha>..<tip>` range is two-dot either way.
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {string|null} [lastWrapSha] - `projConfig.lastWrapSha`, or null/undefined.
 * @param {object} [options] - Resolution options.
 * @param {'two'|'three'} [options.dots='three'] - Range form for the base-branch fallback.
 * @param {string} [options.tip='HEAD'] - Far end of the range. See `_decideRange`.
 * @param {Function} [options.exec] - `execSync` replacement, for tests.
 * @param {(command: string) => void} [options.onStopped] - Called with each
 *   probe our own timeout killed. Needed as well as the returned `stopped`
 *   because the NULL return — "no range resolves" — is exactly the case a
 *   killed `rev-parse` can manufacture, and a null carries no field to say so.
 * @returns {{range:string, kind:'session'|'branch', baseBranch:(string|null),
 *   stopped:string[]}|null} Null when neither a session SHA nor a base branch
 *   resolves. `stopped` names any probe our own timeout killed rather than let
 *   answer — non-empty means the range is a fallback taken on an UNKNOWN answer,
 *   not a negative one, and callers that tell an operator why they got the range
 *   they did must say so (#897).
 */
function resolveSessionRange(cwd, lastWrapSha, options = {}) {
  const { dots = 'three', tip = 'HEAD', exec = execSync, onStopped = null } = options;
  const stopped = [];
  const note = (command) => {
    stopped.push(command);
    if (onStopped) onStopped(command);
  };
  const shaUsable = Boolean(lastWrapSha) && SHA_RE.test(lastWrapSha)
    && isResolvableCommit(cwd, lastWrapSha, exec, note)
    && isAncestorOf(cwd, lastWrapSha, tip, exec, note);
  const decided = _decideRange({
    lastWrapSha, tip, dots, shaUsable,
    baseBranch: shaUsable ? null : resolveBaseBranch(cwd, exec, note)
  });
  return decided ? { ...decided, stopped } : null;
}

/**
 * Async twin of {@link resolveSessionRange}, for a step whose git seam is the
 * argv-style async runner (`_exec-shell.execFileArgs`) rather than `execSync`.
 *
 * The two forms exist because the wrap's steps do not share one git seam: the
 * older steps shell out synchronously, the newer ones run argv-style and read a
 * `timedOut` flag off the result instead of catching a throw. Making one call the
 * other would mean either blocking an async step on `execSync` or forcing a sync
 * step to become async — so the probes are written twice and the ORDERING, which
 * is the part that actually drifted before this module existed, is written once
 * in {@link _decideRange} and shared. `wrap-git-range.test.js` asserts the two
 * resolvers agree on the same inputs.
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {string|null} [lastWrapSha] - `projConfig.lastWrapSha`, or null/undefined.
 * @param {object} [options] - Resolution options.
 * @param {'two'|'three'} [options.dots='three'] - Range form for the base-branch fallback.
 * @param {string} [options.tip='HEAD'] - Far end of the range. See `_decideRange`.
 * @param {Function} options.exec - Argv-style async runner:
 *   `(file, args, {cwd}) => Promise<{exitCode, stdout, stderr, error, timedOut}>`.
 * @param {(command: string) => void} [options.onStopped] - As above.
 * @returns {Promise<{range:string, kind:'session'|'branch', baseBranch:(string|null),
 *   stopped:string[]}|null>}
 */
async function resolveSessionRangeAsync(cwd, lastWrapSha, options = {}) {
  const { dots = 'three', tip = 'HEAD', exec, onStopped = null } = options;
  const stopped = [];
  const note = (command) => {
    stopped.push(command);
    if (onStopped) onStopped(command);
  };
  const shaUsable = Boolean(lastWrapSha) && SHA_RE.test(lastWrapSha)
    && await isResolvableCommitAsync(cwd, lastWrapSha, exec, note)
    && await isAncestorOfAsync(cwd, lastWrapSha, tip, exec, note);
  const decided = _decideRange({
    lastWrapSha, tip, dots, shaUsable,
    baseBranch: shaUsable ? null : await resolveBaseBranchAsync(cwd, exec, note)
  });
  return decided ? { ...decided, stopped } : null;
}

/**
 * The ordering policy, with every probe already answered. Pure, so the sync and
 * async resolvers can share the one decision that matters and cannot drift on it.
 *
 * The recorded SHA must be an ANCESTOR of the tip, not merely resolvable. A wrap
 * stamps its base and the wrap squash-merges onto the trunk; an older stamp made
 * before #664 recorded the wrap BRANCH commit, which squash-merge orphans. An
 * orphaned SHA still resolves (the object exists) but is not on the tip's history,
 * so `<sha>..<tip>` widens to the last shared ancestor — many sessions of
 * already-released work. Falling back to the trunk range keeps a stale or
 * orphaned stamp from ballooning the session (#664).
 *
 * **`tip` is not always HEAD.** A step that runs AFTER the wrap commit must
 * measure to that commit, because #467's auto-PR close-loop may already have
 * returned the checkout to the original branch — HEAD is then the pre-wrap trunk
 * and the range is empty. The ancestry probe takes the same tip for the same
 * reason: asking whether the base is an ancestor of HEAD answers a different
 * question than the range being built.
 *
 * @param {object} args
 * @param {string|null} args.lastWrapSha - The recorded base, or null.
 * @param {string} args.tip - Far end of the range.
 * @param {'two'|'three'} args.dots - Range form for the base-branch fallback.
 * @param {boolean} args.shaUsable - Did `lastWrapSha` pass shape + resolvable + ancestor?
 * @param {string|null} args.baseBranch - Resolved trunk branch, or null (only
 *   probed when `shaUsable` is false).
 * @returns {{range:string, kind:'session'|'branch', baseBranch:(string|null)}|null}
 */
function _decideRange({ lastWrapSha, tip, dots, shaUsable, baseBranch }) {
  if (shaUsable) {
    return { range: `${lastWrapSha}..${tip}`, kind: 'session', baseBranch: null };
  }
  if (baseBranch) {
    const sep = dots === 'two' ? '..' : '...';
    return { range: `${baseBranch}${sep}${tip}`, kind: 'branch', baseBranch };
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
 * @param {((command: string) => void)|null} [onStopped] - Notified when our own
 *   timeout killed the probe rather than letting it answer.
 * @returns {boolean}
 */
function isResolvableCommit(cwd, ref, exec = execSync, onStopped = null) {
  const command = `git rev-parse --verify --quiet ${ref}^{commit}`;
  try {
    exec(command, {
      cwd,
      timeout: GIT_EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return true;
  } catch (err) {
    // `rev-parse --verify` exits non-zero for "no such ref", which is the answer
    // this function exists to give. It also exits non-zero when git is missing or
    // the directory is not a repo — indistinguishable here, and deliberately so:
    // every caller's next move on false is the same fallback. Callers that must
    // tell the two apart should probe the repo separately.
    //
    // A KILL is the one shape that must not vanish into that set: it is not an
    // answer at all, and returning `false` for it silently changes which range
    // the wrap measures.
    _noteIfStopped(err, command, cwd, onStopped);
    return false;
  }
}

/**
 * Whether `ref` is an ancestor of `tip` — i.e. on that history, so a
 * `<ref>..<tip>` range means "commits since ref" rather than a walk back to the
 * last shared ancestor. Guards against a `lastWrapSha` orphaned by squash-merge.
 *
 * The tip is a parameter because a step running after the wrap commit measures to
 * that commit rather than to HEAD, and asking about the wrong end answers a
 * different question than the range being built (see `_decideRange`).
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {string} ref - A git ref or SHA already known to resolve.
 * @param {string} [tip='HEAD'] - The descendant end to test against.
 * @param {Function} [exec=execSync] - `execSync` replacement, for tests.
 * @param {((command: string) => void)|null} [onStopped] - Notified when our own
 *   timeout killed the probe rather than letting it answer.
 * @returns {boolean}
 */
function isAncestorOf(cwd, ref, tip = 'HEAD', exec = execSync, onStopped = null) {
  const command = `git merge-base --is-ancestor ${ref} ${tip}`;
  try {
    exec(command, {
      cwd,
      timeout: GIT_EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return true;
  } catch (err) {
    // Exit 1 = resolves but is not an ancestor (the orphaned-stamp case). Any
    // other non-zero (bad repo, missing git) lands here too, and the caller's
    // move is the same either way: fall back to the trunk range.
    //
    // This is the costliest probe to answer wrongly. A `false` here abandons a
    // perfectly good `<sha>..<tip>` range for the whole trunk divergence — many
    // sessions of already-released work — so a kill reported as "not an
    // ancestor" balloons the range with nothing anywhere saying why.
    _noteIfStopped(err, command, cwd, onStopped);
    return false;
  }
}

/**
 * Resolve the trunk branch to measure divergence from. Returns null when no
 * candidate resolves as a verifiable ref.
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {Function} [exec=execSync] - `execSync` replacement, for tests.
 * @param {((command: string) => void)|null} [onStopped] - Notified when our own
 *   timeout killed a probe rather than letting it answer.
 * @returns {string|null}
 */
function resolveBaseBranch(cwd, exec = execSync, onStopped = null) {
  for (const candidate of BASE_BRANCH_CANDIDATES) {
    const command = `git rev-parse --verify --quiet ${candidate}`;
    try {
      exec(command, {
        cwd,
        timeout: GIT_EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return candidate;
    } catch (err) {
      // Ref does not exist locally — try the next candidate. Trying the next
      // one is right for a kill too, but the null this can produce is reported
      // upstream as "this repo has no main/master", which a stopped probe is
      // no evidence for.
      _noteIfStopped(err, command, cwd, onStopped);
    }
  }
  return null;
}

// ── argv-style async probes ───────────────────────────────────────────────────
//
// The same three questions, asked through `_exec-shell.execFileArgs` instead of
// `execSync`. That runner reports a kill as `timedOut` on a resolved result
// rather than by throwing, so these read the flag where the sync twins catch —
// which is the whole reason they cannot delegate to each other. Everything that
// is a DECISION rather than a probe lives in `_decideRange`, shared by both.

/**
 * Run one argv-style probe and answer the yes/no question its exit code encodes.
 *
 * @param {Function} exec - `(file, args, {cwd}) => Promise<{exitCode, timedOut, error}>`.
 * @param {string} cwd - Absolute path to run git in.
 * @param {string[]} args - Argv after `git`.
 * @param {((command: string) => void)|null} onStopped - Notified when our own
 *   timeout killed the probe rather than letting it answer.
 * @returns {Promise<boolean>} True iff git exited zero.
 */
async function _probeAsync(exec, cwd, args, onStopped) {
  const command = `git ${args.join(' ')}`;
  let res;
  try {
    res = await exec('git', args, { cwd });
  } catch (err) {
    // The production runner (`_exec-shell.execFileArgs`) always RESOLVES — a
    // missing binary and an unusable cwd both come back as a failure result, not
    // a throw. This catch is for a step whose `_internal.exec` seam is replaced
    // with one that throws, which several suites do to drive the no-repo path.
    log.debug('git probe threw', { command, cwd, error: err.message });
    return false;
  }
  if (res && res.timedOut) {
    log.warn('git probe was stopped before it answered; treating it as a negative answer', {
      command, cwd, error: res.error
    });
    if (onStopped) onStopped(command);
    return false;
  }
  return Boolean(res) && res.exitCode === 0;
}

/**
 * Async twin of {@link isResolvableCommit}.
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {string} ref - A git ref or SHA.
 * @param {Function} exec - Argv-style async runner.
 * @param {((command: string) => void)|null} [onStopped] - As above.
 * @returns {Promise<boolean>}
 */
function isResolvableCommitAsync(cwd, ref, exec, onStopped = null) {
  return _probeAsync(exec, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], onStopped);
}

/**
 * Async twin of {@link isAncestorOf}.
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {string} ref - A git ref or SHA already known to resolve.
 * @param {string} [tip='HEAD'] - The descendant end to test against.
 * @param {Function} exec - Argv-style async runner.
 * @param {((command: string) => void)|null} [onStopped] - As above.
 * @returns {Promise<boolean>}
 */
function isAncestorOfAsync(cwd, ref, tip = 'HEAD', exec, onStopped = null) {
  return _probeAsync(exec, cwd, ['merge-base', '--is-ancestor', ref, tip], onStopped);
}

/**
 * Async twin of {@link resolveBaseBranch}.
 *
 * @param {string} cwd - Absolute path to run git in.
 * @param {Function} exec - Argv-style async runner.
 * @param {((command: string) => void)|null} [onStopped] - As above.
 * @returns {Promise<string|null>}
 */
async function resolveBaseBranchAsync(cwd, exec, onStopped = null) {
  for (const candidate of BASE_BRANCH_CANDIDATES) {
    if (await _probeAsync(exec, cwd, ['rev-parse', '--verify', '--quiet', candidate], onStopped)) {
      return candidate;
    }
  }
  return null;
}

module.exports = {
  resolveSessionRange,
  resolveSessionRangeAsync,
  isResolvableCommit,
  isResolvableCommitAsync,
  isAncestorOf,
  isAncestorOfAsync,
  resolveBaseBranch,
  resolveBaseBranchAsync,
  SHA_RE,
  GIT_EXEC_TIMEOUT_MS
};
