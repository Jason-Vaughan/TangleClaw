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

module.exports = {
  supportsSubagentDispatch,
  subagentDispatchReason,
  evaluateSubagentTask,
  asHypothesis
};
