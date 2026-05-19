'use strict';

/**
 * Methodology-action dispatcher (#139 Chunk 11b).
 *
 * Methodology templates declare server-actionable buttons in their
 * `actions[]` block (e.g. prawduct's `{label: "Run Critic", command:
 * "invoke-critic"}`). The frontend POSTs to
 * `/api/projects/:name/actions/:command`; the server endpoint calls
 * `runAction(project, command)`, which validates the command against
 * the project's methodology and dispatches to a handler module under
 * `lib/actions/`.
 *
 * **Contract.** Adding a new action = one entry in `ACTION_DISPATCH`
 * plus a sibling module under `lib/actions/` exposing
 * `run(project, options) -> {ok, output, error}`. Unknown commands
 * return `{ok: false, error: 'unknown action ...'}`. Commands that
 * exist as handlers but are NOT declared by the project's methodology
 * also fail closed — the methodology template is the authorization
 * surface.
 *
 * **Scope discipline.** Action handlers are write-on-demand from a
 * deliberate user click. They are NOT invoked by the wrap pipeline
 * runner; the runner has its own dispatch table in
 * `lib/wrap-pipeline.js`. Keeping the two dispatchers separate avoids
 * accidental coupling between "the user clicked this button" and
 * "the wrap pipeline ran this step."
 */

const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('actions');

/**
 * Dispatch table — methodology-declared action `command` → handler
 * module under `lib/actions/`.
 *
 * @type {Record<string, {run: (project: object, options?: object) => object}>}
 */
const ACTION_DISPATCH = {
  'invoke-critic': require('./actions/invoke-critic')
};

/**
 * Look up a methodology's declared action by command string. Returns
 * the action descriptor (`{label, command, confirm?, ...}`) when found,
 * `null` otherwise.
 *
 * @param {string} methodologyId
 * @param {string} command
 * @returns {object|null}
 */
function _findDeclaredAction(methodologyId, command) {
  const template = store.templates.get(methodologyId);
  if (!template || !Array.isArray(template.actions)) return null;
  return template.actions.find((a) => a && a.command === command) || null;
}

/**
 * Run a methodology action for a project.
 *
 * @param {string} projectName
 * @param {string} command - Action command string (e.g. `invoke-critic`)
 * @param {object} [options] - Forwarded to the handler verbatim
 * @returns {{ok: boolean, output: object|null, error: string|null}}
 */
function runAction(projectName, command, options) {
  if (typeof projectName !== 'string' || !projectName) {
    return { ok: false, output: null, error: 'projectName is required' };
  }
  if (typeof command !== 'string' || !command) {
    return { ok: false, output: null, error: 'action command is required' };
  }

  const project = store.projects.getByName(projectName);
  if (!project) {
    return { ok: false, output: null, error: `Project "${projectName}" not found` };
  }

  const declared = _findDeclaredAction(project.methodology, command);
  if (!declared) {
    return {
      ok: false,
      output: null,
      error: `methodology "${project.methodology}" does not declare action "${command}"`
    };
  }

  const handler = ACTION_DISPATCH[command];
  if (!handler) {
    return {
      ok: false,
      output: null,
      error: `no handler registered for action "${command}"`
    };
  }

  try {
    const result = handler.run(project, options || {});
    log.info('action ran', { project: projectName, command, ok: result && result.ok });
    return result;
  } catch (err) {
    log.error('action handler threw', { project: projectName, command, error: err.message });
    return { ok: false, output: null, error: `action handler threw: ${err.message}` };
  }
}

module.exports = {
  runAction,
  ACTION_DISPATCH
};
