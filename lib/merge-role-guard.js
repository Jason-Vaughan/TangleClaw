'use strict';

/**
 * Cross-engine Builder `gh pr merge` role guard (#2601, Architect Ruling
 * A2601, `v5.61.0` Car 61-A Slice 1).
 *
 * `gh pr merge` talks directly to the GitHub API and triggers no local git
 * `pre-push` hook (`lib/control-hooks.js:12-13`), and a tracked
 * `.claude/settings.json` hook is engine-specific and shared across every
 * clone -- neither stops a Builder/Reviewer/Architect/Coordinator lane from
 * merging its own PR, which Rule #282 reserves for the Integrator alone.
 *
 * A pure classifier/evaluator: {@link detectMergeInvocation} and
 * {@link evaluateMergeRoleGuard} take a candidate shell command string and
 * the caller's own already-resolved role/lane identity as plain data, and
 * return a computed verdict -- nothing here reads `TANGLECLAW_ROLE` from the
 * environment, intercepts a real shell command, or writes a launch-env `PATH`
 * wrapper or hook file. Wiring this into an actual pre-execution guard (a
 * launch-env wrapper, a `tc` verb, an engine shell hook) is Slice 2,
 * deliberately deferred so Car 61-A stays 100% file-disjoint from this
 * wave's other `v5.61.0` cars.
 *
 * @module lib/merge-role-guard
 */

/** Role categories this module recognizes, resolved from either an explicit `role` or a lane id. */
const ROLE_CATEGORIES = Object.freeze(['builder', 'reviewer', 'architect', 'pm', 'integrator']);

/** The role categories Rule #282 forbids from merging a PR. */
const FORBIDDEN_ROLE_CATEGORIES = Object.freeze(['builder', 'reviewer', 'architect', 'pm']);

/** The only merge method `gh pr merge`/the REST merge endpoint may use (Rule #282: a true merge commit, never squash or rebase). */
const ALLOWED_MERGE_METHOD = 'merge';

/** Every merge method this module recognizes in a candidate command. */
const MERGE_METHODS = Object.freeze(['merge', 'squash', 'rebase']);

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * Resolve a caller's own role/lane identity into one of {@link ROLE_CATEGORIES},
 * or `'operator'` for an explicit operator context -- `null` when neither an
 * explicit `role` nor a recognized lane id is given. An explicit `role` is
 * trusted outright when it names a known category; a lane id is pattern-
 * matched only when `role` is absent, never used to override an explicit role.
 * @param {{role?: string, lane?: string, isOperator?: boolean}} input
 * @returns {string|null}
 */
function _resolveRoleCategory(input) {
  if (input.isOperator === true) return 'operator';
  if (typeof input.role === 'string' && ROLE_CATEGORIES.includes(input.role)) return input.role;
  if (typeof input.lane === 'string' && input.lane) {
    if (/^TC-Lane-INT$/i.test(input.lane)) return 'integrator';
    if (/^TC-Lane-PRR(-[A-Za-z0-9]+)?$/i.test(input.lane)) return 'reviewer';
    if (/^TC-Lane-Arc$/i.test(input.lane)) return 'architect';
    if (/^TC-Lane-PM$/i.test(input.lane)) return 'pm';
    if (/^TC-Lane-[A-Za-z]$/i.test(input.lane)) return 'builder';
  }
  return null;
}

/**
 * Whether a candidate shell command invokes a PR merge, and which merge
 * method it names, if any (#2601). Recognizes `gh pr merge`, `gh api ...
 * /pulls/<n>/merge` and a raw `curl -X PUT .../pulls/<n>/merge` -- the three
 * shapes the ruling names ("across engine shell/command hooks and
 * wrappers"). A command with none of these patterns is not a merge
 * invocation at all; this function never raises on one, since most commands
 * a shell hook sees are not a merge attempt.
 * @param {string} commandText
 * @returns {{isMergeInvocation: boolean, mergeMethod: (string|null), via: (string|null)}}
 */
function detectMergeInvocation(commandText) {
  if (typeof commandText !== 'string' || !commandText) {
    return { isMergeInvocation: false, mergeMethod: null, via: null };
  }
  const isGhPrMerge = /\bgh\s+pr\s+merge\b/.test(commandText);
  const mergeEndpointRe = /\/pulls\/[^/\s"']+\/merge\b/;
  const isGhApiMerge = !isGhPrMerge && /\bgh\s+api\b/.test(commandText) && mergeEndpointRe.test(commandText);
  const isRestPutMerge = !isGhPrMerge && !isGhApiMerge && /-X\s*PUT\b/i.test(commandText) && mergeEndpointRe.test(commandText);
  const isMergeInvocation = isGhPrMerge || isGhApiMerge || isRestPutMerge;

  let mergeMethod = null;
  for (const method of MERGE_METHODS) {
    if (new RegExp(`--${method}\\b`).test(commandText) || new RegExp(`merge_method["']?[=:\\s]+["']?${method}`, 'i').test(commandText)) {
      mergeMethod = method;
      break;
    }
  }

  return { isMergeInvocation, mergeMethod, via: isGhPrMerge ? 'gh-pr-merge' : (isGhApiMerge ? 'gh-api' : (isRestPutMerge ? 'rest-put' : null)) };
}

/**
 * Evaluate whether a candidate command's PR-merge attempt (if it is one)
 * may proceed, for a given caller identity (#2601). A command that is not a
 * merge invocation at all always proceeds -- this guard has nothing to say
 * about any other command. Role is checked before merge method: a forbidden
 * caller using `--squash` gets `MERGE_ROLE_FORBIDDEN`, the more fundamental
 * violation, not `MERGE_METHOD_FORBIDDEN`.
 * @param {object} input
 * @param {string} input.commandText - The candidate shell command
 * @param {string} [input.role] - One of {@link ROLE_CATEGORIES}
 * @param {string} [input.lane] - A lane id (`TC-Lane-A`..`TC-Lane-D`, `TC-Lane-INT`,
 *   `TC-Lane-PRR-A`/`-B`, `TC-Lane-Arc`, `TC-Lane-PM`), used only when `role` is absent
 * @param {boolean} [input.isOperator] - An explicit operator context; overrides role/lane
 * @returns {{ok: true, result: {allowed: true, reason: string}}|{ok: false, code: string, message: string}}
 */
function evaluateMergeRoleGuard(input) {
  if (!input || typeof input !== 'object' || typeof input.commandText !== 'string') {
    return _refuse('MERGE_ROLE_GUARD_INVALID', 'input.commandText must be a string.');
  }
  if (input.role !== undefined && typeof input.role !== 'string') {
    return _refuse('MERGE_ROLE_GUARD_INVALID', 'input.role must be a string when present.');
  }
  if (input.lane !== undefined && typeof input.lane !== 'string') {
    return _refuse('MERGE_ROLE_GUARD_INVALID', 'input.lane must be a string when present.');
  }

  const detected = detectMergeInvocation(input.commandText);
  if (!detected.isMergeInvocation) {
    return { ok: true, result: { allowed: true, reason: 'not a PR-merge invocation' } };
  }

  const category = _resolveRoleCategory(input);
  if (category !== 'operator' && category !== 'integrator') {
    return _refuse('MERGE_ROLE_FORBIDDEN',
      'Only the Integrator or an explicit operator may merge a PR (Rule #282); '
      + `this caller's role/lane (${input.role || input.lane || 'unrecognized'}) is not authorized.`);
  }
  if (detected.mergeMethod && detected.mergeMethod !== ALLOWED_MERGE_METHOD) {
    return _refuse('MERGE_METHOD_FORBIDDEN',
      `--${detected.mergeMethod} is forbidden; every PR merges via a true merge commit (--merge) under Rule #282, never squash or rebase.`);
  }

  return { ok: true, result: { allowed: true, reason: category === 'operator' ? 'explicit operator context' : 'authorized Integrator' } };
}

module.exports = {
  ROLE_CATEGORIES,
  FORBIDDEN_ROLE_CATEGORIES,
  ALLOWED_MERGE_METHOD,
  MERGE_METHODS,
  detectMergeInvocation,
  evaluateMergeRoleGuard
};
