'use strict';

/*
 * Authorization toggle: Allow sub-agent parallelization (#1257).
 *
 * A per-project toggle cannot know whether a given chunk is parallelizable —
 * only the Builder holding the chunk can decide that from its content. The
 * toggle exists to grant the Builder the AUTHORIZATION to make that call; it
 * does not make the call itself. This module holds the two things the
 * toggle's existence requires: whether the running engine can even dispatch
 * sub-agents at all (`supportsSubagentDispatch`, declared per engine in
 * `data/engines/*.json`, same shape as every other engine capability flag —
 * ADR 0013), and the Read/Write heuristic a Builder applies once authorized
 * (`evaluateSubagentTask`).
 */

const { engineDisplayName } = require('./engines');

/**
 * Whether the given engine profile declares native support for fanning work
 * out to sub-agents. Declared per engine (#1257), not derived — a future
 * engine states its own case in its own profile, the same pattern every other
 * `capabilities.*` flag in `data/engines/*.json` already follows.
 *
 * @param {object|null} engineProfile - Engine profile (`lib/engines.js#resolveProfile`).
 * @returns {boolean}
 */
function supportsSubagentDispatch(engineProfile) {
  return Boolean(
    engineProfile && engineProfile.capabilities
    && engineProfile.capabilities.supportsSubagentDispatch === true
  );
}

/**
 * The honest reason a project's "Allow sub-agent parallelization" toggle has
 * no effect here, for an engine that does not declare `supportsSubagentDispatch`
 * (ADR 0013: a control that does nothing must say so, not hide or log it).
 *
 * @param {object|null} engineProfile - Engine profile.
 * @returns {string}
 */
function subagentDispatchReason(engineProfile) {
  return `${engineDisplayName(engineProfile)} does not support sub-agent dispatch, so this setting has no effect on this project.`;
}

/**
 * The Read/Write heuristic a Builder applies to one task before fanning it
 * out, once the project's toggle has authorized the call (#1257). The
 * operative question is not a dependency graph, it is "does this task write":
 *
 *   - Pure reading/discovery (an engine capability sweep, a repo-wide grep,
 *     gathering context) can fan out safely.
 *   - Writing into shared files, or touching git state directly, must
 *     serialize: parallel checkouts yank a shared `HEAD`, and worktrees share
 *     a single stash list, so two sub-agents racing either corrupts the
 *     session's own working tree.
 *
 * @param {object} task - The task under consideration.
 * @param {boolean} task.writes - Whether the task writes to any file.
 * @param {boolean} [task.mutatesGitState] - Whether the task touches git
 *   state directly (checkout, stash, commit, branch), beyond writing files.
 * @returns {{parallelizable: boolean, reason: string}}
 */
function evaluateSubagentTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return {
      parallelizable: false,
      reason: 'no task description was given; serialize rather than guess'
    };
  }
  // Fail closed on an unknown write status (A506-W2C-R6): `{}` or any
  // non-boolean `writes` is NOT the same as a known `false`, and guessing
  // "no writes" for a task that never said so is exactly the false-safe
  // default this gate exists to refuse.
  if (typeof task.writes !== 'boolean') {
    return {
      parallelizable: false,
      reason: 'task.writes must be an explicit boolean — serialize rather than guess'
    };
  }
  if (task.mutatesGitState) {
    return {
      parallelizable: false,
      reason: 'the task mutates git state directly — parallel checkouts yank HEAD and worktrees share one stash list'
    };
  }
  if (task.writes) {
    return {
      parallelizable: false,
      reason: 'the task writes into shared files — writing must be serialized'
    };
  }
  return {
    parallelizable: true,
    reason: 'pure reading/discovery can fan out safely'
  };
}

/**
 * Wrap a sub-agent's finding as a hypothesis, never a fact, until the primary
 * session verifies it (#1257) — a sub-agent's finding is a hypothesis, and
 * adopting it unverified into the master plan is the critic-loop failure mode
 * this authorization toggle exists to avoid.
 *
 * @param {*} finding - The sub-agent's raw finding.
 * @param {string} [source] - What produced the finding (an agent id, a task label).
 * @returns {{status: 'hypothesis', finding: *, source: (string|null), verifiedAt: null}}
 */
function asHypothesis(finding, source) {
  return { status: 'hypothesis', finding, source: source || null, verifiedAt: null };
}

/**
 * The combined dispatch gate for one task (#1257, A506-W2C-R6): engine
 * capability, then project authorization, then the Read/Write heuristic, in
 * that order, failing closed on the first unsatisfied check. Each reason
 * names exactly which gate refused — a caller never has to infer which of
 * the three invariants failed from a generic denial.
 *
 * @param {object} opts
 * @param {object|null} opts.projectConfig - Per-project config.
 * @param {object|null} opts.engineProfile - The project's resolved engine profile.
 * @param {object} opts.task - The task under consideration (`evaluateSubagentTask`'s shape).
 * @returns {{authorized: boolean, reason: string}}
 */
function evaluateSubagentDispatch({ projectConfig, engineProfile, task } = {}) {
  if (!supportsSubagentDispatch(engineProfile)) {
    return { authorized: false, reason: subagentDispatchReason(engineProfile) };
  }
  if (!(projectConfig && projectConfig.subagentParallelizationEnabled === true)) {
    return { authorized: false, reason: 'this project has not authorized sub-agent parallelization' };
  }
  const taskVerdict = evaluateSubagentTask(task);
  if (!taskVerdict.parallelizable) {
    return { authorized: false, reason: taskVerdict.reason };
  }
  return { authorized: true, reason: taskVerdict.reason };
}

/**
 * Accept a sub-agent's finding into project/chunk state, but only once a
 * dispatch verdict has authorized the task that produced it (#1257,
 * A506-W2C-R6) — wraps it as a hypothesis when authorized, via `asHypothesis`,
 * and refuses outright otherwise, so an unauthorized sub-agent's output can
 * never reach the master plan through this path.
 *
 * @param {{authorized: boolean, reason: string}|null} dispatch - `evaluateSubagentDispatch`'s verdict for the task that produced this finding.
 * @param {*} finding - The sub-agent's raw finding.
 * @param {string} [source] - What produced the finding.
 * @returns {{status: 'hypothesis', finding: *, source: (string|null), verifiedAt: null}|{status: 'refused', reason: string}}
 */
function ingestSubagentFinding(dispatch, finding, source) {
  if (!dispatch || dispatch.authorized !== true) {
    return { status: 'refused', reason: (dispatch && dispatch.reason) || 'no authorized dispatch verdict was given' };
  }
  return asHypothesis(finding, source);
}

module.exports = {
  supportsSubagentDispatch,
  subagentDispatchReason,
  evaluateSubagentTask,
  asHypothesis,
  evaluateSubagentDispatch,
  ingestSubagentFinding
};
