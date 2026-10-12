'use strict';

/**
 * Who decides when a project's pull requests merge (#2320).
 *
 * Arming GitHub auto-merge is a merge decision taken ahead of time: once armed,
 * the pull request lands by itself when its checks pass. A project that works
 * under a coordinator has handed that decision to the coordinator, so nothing
 * incidental (a wrap, a checkpoint) may arm it there. Every place that can arm
 * auto-merge asks this module first, and `test/auto-merge-callers.test.js`
 * fails when one does not.
 *
 * The record that says a project works under a coordinator is the
 * `workloadNudge.coordinatorProject` setting of its own
 * `.tangleclaw/project.json`. When the project's repository and base branch
 * have an active merge queue, the queue's owner must agree with it: a
 * disagreement is not resolved here, it is reported as `unknown`.
 *
 * The answer is `self` only when the settings were read cleanly and name no
 * coordinator. Anything that could not be read is `unknown`, and `unknown` arms
 * nothing: a project whose role cannot be established is treated as one that
 * has given the decision away.
 *
 * @module lib/merge-authority
 */

const { createLogger } = require('./logger');
const { configRootOf } = require('./wrap-steps/_config-root');

const log = createLogger('merge-authority');

/** The three answers. */
const AUTHORITIES = Object.freeze(['self', 'integrator', 'unknown']);

/** A GitHub repository as the merge queue records it. */
const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The `owner/name` of a remote URL, or null when the URL is not a github.com
 * repository. The merge queue keys its records on this form.
 * @param {string|null|undefined} remoteUrl - What `git remote get-url origin` printed
 * @returns {string|null}
 */
function repoFromRemoteUrl(remoteUrl) {
  const host = _internal.repoOf(remoteUrl);
  return host ? host.slice(host.indexOf('/') + 1) : null;
}

/**
 * An `unknown` answer.
 * @param {string} reason - What could not be read or did not agree, as a clause
 * @returns {{authority: 'unknown', reason: string}}
 */
function _unknown(reason) {
  return { authority: 'unknown', reason };
}

/**
 * The coordinator a project's settings name.
 * @param {string} root - The directory holding `.tangleclaw/project.json`
 * @returns {{coordinator: string|null}|{problem: string}} The name, or null when
 *   none is named; or why the settings do not say
 */
function _coordinatorOf(root) {
  let readError = null;
  const config = _internal.loadConfig(root, { onError: (err) => { readError = err; } });
  if (readError) return { problem: 'this project\'s settings (.tangleclaw/project.json) could not be read' };
  const raw = config ? config.workloadNudge : undefined;
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { problem: 'this project\'s workloadNudge setting is not an object, so it does not say whether a coordinator is named' };
  }
  const setting = _internal.resolveSetting(config);
  if (setting.sources.coordinatorProject === 'invalid') {
    return { problem: 'this project\'s workloadNudge.coordinatorProject setting is not a project name' };
  }
  return { coordinator: setting.coordinatorProject };
}

/**
 * Who decides when this project's pull requests merge. Never throws.
 *
 * @param {object} project - The project record (`name`, `path`, and `id` when registered)
 * @param {object} [where] - Where the pull request is
 * @param {string|null} [where.repo] - The repository as `owner/name`, or null when it could not be named
 * @param {string|null} [where.baseBranch] - The pull request's base branch, or null when unknown
 * @returns {{authority: 'self'}
 *   |{authority: 'integrator', integrator: string, source: 'coordinator'|'coordinator-and-queue'}
 *   |{authority: 'unknown', reason: string}}
 */
function forProject(project, where = {}) {
  try {
    return _forProject(project, where || {});
  } catch (err) {
    log.warn('merge authority could not be read', { project: project && project.name, error: err && err.message });
    return _unknown(`reading it failed (${err && err.message ? err.message : 'unknown error'})`);
  }
}

/**
 * {@link forProject} without its catch.
 * @param {object} project - The project record
 * @param {{repo?: string|null, baseBranch?: string|null}} where - Where the pull request is
 * @returns {object} One of the three answers
 */
function _forProject(project, where) {
  const root = configRootOf(project);
  if (!root) return _unknown('this project has no folder, so its settings could not be read');

  const named = _coordinatorOf(root);
  if (named.problem) return _unknown(named.problem);
  const coordinator = named.coordinator;
  if (!coordinator) return { authority: 'self' };

  const { repo, baseBranch } = where;
  if (typeof repo !== 'string' || !REPO_SHAPE.test(repo)) {
    return _unknown(`its settings name ${coordinator} as coordinator, but the repository could not be named, so the merge queue could not be looked up`);
  }
  if (typeof baseBranch !== 'string' || !baseBranch.trim()) {
    return _unknown(`its settings name ${coordinator} as coordinator, but the base branch is not known, so the merge queue could not be looked up`);
  }

  let queue;
  try {
    queue = _internal.findActiveQueue(repo, baseBranch);
  } catch (err) {
    log.warn('merge queue record could not be read', { project: project.name, repo, baseBranch, error: err && err.message });
    return _unknown(`its settings name ${coordinator} as coordinator, but the merge queue's record for ${repo} ${baseBranch} could not be read`);
  }
  if (!queue) return { authority: 'integrator', integrator: coordinator, source: 'coordinator' };

  if (project.id !== undefined && project.id !== null && queue.ownerProjectId === project.id) {
    return { authority: 'integrator', integrator: project.name, source: 'coordinator-and-queue' };
  }
  const owner = _internal.getProject(queue.ownerProjectId);
  if (owner && owner.name === coordinator) {
    return { authority: 'integrator', integrator: coordinator, source: 'coordinator-and-queue' };
  }
  const ownerSaid = owner ? owner.name : `project ${queue.ownerProjectId}, which is not registered`;
  return _unknown(`its settings name ${coordinator} as coordinator, but the merge queue for ${repo} ${baseBranch} is owned by ${ownerSaid}`);
}

/**
 * Whether a caller holding this answer may arm GitHub auto-merge.
 * @param {object|null|undefined} answer - From {@link forProject}
 * @returns {boolean} True only for `self`
 */
function mayArmAutoMerge(answer) {
  return !!answer && answer.authority === 'self';
}

/**
 * Why auto-merge is not armed, as one sentence a person reads in a wrap's
 * result and in the pull request. Null when it may be armed.
 * @param {object|null|undefined} answer - From {@link forProject}
 * @param {object} [project] - The project asked about, to tell a coordinator's own wrap apart
 * @returns {string|null}
 */
function describe(answer, project) {
  if (mayArmAutoMerge(answer)) return null;
  if (answer && answer.authority === 'integrator') {
    if (project && project.name === answer.integrator) {
      return `${answer.integrator} coordinates the merges of this repository's lane, so its own pull requests merge by that lane's gates and nothing arms auto-merge on them.`;
    }
    return `This project's merges belong to ${answer.integrator}, the coordinator its settings name: ${answer.integrator} merges this pull request, and nothing arms auto-merge on it.`;
  }
  const reason = answer && typeof answer.reason === 'string' && answer.reason ? answer.reason : 'no answer was given';
  return `Who merges for this project could not be established: ${reason}. Nothing arms auto-merge until it can be.`;
}

const _internal = {
  loadConfig: (root, options) => require('./store').projectConfig.load(root, options),
  resolveSetting: (config) => require('./project-config').resolveWorkloadNudge(config),
  findActiveQueue: (repo, baseBranch) => require('./merge-queue-store').findActiveQueue(repo, baseBranch),
  getProject: (id) => require('./store').projects.get(id),
  repoOf: (url) => require('./stranded-check').repoOf(url)
};

module.exports = {
  AUTHORITIES,
  forProject,
  mayArmAutoMerge,
  describe,
  repoFromRemoteUrl,
  _internal
};
