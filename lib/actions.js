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
 * As of #267 the dispatcher is async-aware: handlers may return a
 * Promise (e.g. `invoke-critic` now awaits tmux send + idle poll +
 * findings-file read). The dispatcher `await`s the handler result;
 * legacy sync handlers continue to work because `Promise.resolve()`
 * passes through a plain value unchanged.
 *
 * The dispatcher also looks up the project's active session and
 * injects it into `options.session` so handlers don't need to depend
 * on `store.sessions` directly. Handlers can fall back gracefully
 * when no session is active.
 *
 * @param {string} projectName
 * @param {string} command - Action command string (e.g. `invoke-critic`)
 * @param {object} [options] - Forwarded to the handler verbatim
 *   (after session injection). The dispatcher does NOT overwrite an
 *   explicit `options.session` from the caller — tests can inject a
 *   stub session and the dispatcher honors it.
 * @returns {Promise<{ok: boolean, output: object|null, error: string|null}>}
 */
async function runAction(projectName, command, options) {
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

  // Inject the active session into options if the caller didn't already
  // provide one. Handlers (e.g. invoke-critic) use this to decide
  // between real invocation and ack-only fallback. Lookup is best-
  // effort — a project with no active session still gets handler
  // dispatch (handler decides what "no session" means).
  const enrichedOptions = options ? Object.assign({}, options) : {};
  if (enrichedOptions.session === undefined) {
    try {
      const active = store.sessions.getActive(project.id);
      if (active) enrichedOptions.session = active;
    } catch (err) {
      log.warn('failed to resolve active session for action dispatch', {
        project: projectName,
        command,
        error: err.message
      });
    }
  }

  try {
    const result = await Promise.resolve(handler.run(project, enrichedOptions));
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
