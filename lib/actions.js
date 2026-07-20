'use strict';

/**
 * Project-action dispatcher (#139 Chunk 11b).
 *
 * An action is a server-side operation the operator triggers from a button in
 * the session banner. The frontend POSTs to
 * `/api/projects/:name/actions/:command`; the server endpoint calls
 * `runAction(project, command)`, which checks the action is available to that
 * project and dispatches to a handler module under `lib/actions/`.
 *
 * **Availability is a fact about the project, not a label it wears.** Actions
 * used to be declared by the project's methodology template, which meant a
 * project could advertise "Run Critic" while nothing capable of running a
 * Critic was installed. Each action now declares a `requires` predicate over
 * the project's live `governanceState` (`lib/engines.js`), so the button
 * appears exactly when the operation can actually succeed.
 *
 * **One predicate, both sides.** `availableActions()` is the single
 * authorization surface: `enrichProject` renders the buttons from it and
 * `runAction` gates on it. They must never diverge — an asymmetric gate here
 * produces either a button that 404s or an action invocable with no button
 * (ADR 0001).
 *
 * **Contract.** Adding a new action = one entry in `ACTIONS` plus a sibling
 * module under `lib/actions/` exposing
 * `run(project, options) -> {ok, output, error}`.
 *
 * **Scope discipline.** Action handlers are write-on-demand from a
 * deliberate user click. They are NOT invoked by the wrap pipeline
 * runner; the runner has its own dispatch table in
 * `lib/wrap-pipeline.js`. Keeping the two dispatchers separate avoids
 * accidental coupling between "the user clicked this button" and
 * "the wrap pipeline ran this step."
 */

const store = require('./store');
const engines = require('./engines');
const { createLogger } = require('./logger');

const log = createLogger('actions');

/**
 * The code-owned action registry: descriptor + availability predicate +
 * handler, one entry per action.
 *
 * `requires` is the set of `governanceState` values the action needs. Run
 * Critic requires `governed-plugin` because the Prawduct V2 plugin is what
 * ships the Critic the handler invokes — a `governed-vendored` project's
 * legacy hook has no equivalent entry point, and an `ungoverned` one has
 * nothing at all.
 *
 * @type {Array<{label: string, command: string, confirm: boolean, confirmMessage?: string, successToast?: string, requires: string[], run: (project: object, options?: object) => object}>}
 */
const ACTIONS = [
  {
    label: 'Run Critic',
    command: 'invoke-critic',
    confirm: true,
    confirmMessage: 'Spawn an Independent Critic review for this branch.\n\nThe Critic will review the current diff against your project state, then surface findings in the session UI. This typically takes 30 seconds to 2 minutes. Findings are recorded against this branch and surfaced in the session UI. Continue?',
    successToast: 'Critic completed for {branchName} — {findingCount} finding(s)',
    requires: ['governed-plugin'],
    run: require('./actions/invoke-critic').run
  }
];

/**
 * The actions available to a project, as frontend-ready descriptors.
 *
 * @param {object} project - Project record (DB row; `path` and `engineId` read)
 * @returns {Array<{label: string, command: string, confirm: boolean, confirmMessage?: string, successToast?: string}>}
 */
function availableActions(project) {
  if (!project || !project.path) return [];
  const state = engines.governanceState(project.path, { engineId: project.engineId });
  return ACTIONS
    .filter((a) => a.requires.includes(state))
    .map((a) => {
      const out = { label: a.label, command: a.command, confirm: a.confirm === true };
      if (a.confirmMessage) out.confirmMessage = a.confirmMessage;
      if (a.successToast) out.successToast = a.successToast;
      return out;
    });
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
 * Dispatcher-level failures carry a `code` so callers can map them to a
 * response without pattern-matching on message text (`NOT_FOUND`,
 * `UNKNOWN_ACTION`, `UNAVAILABLE`, `HANDLER_THREW`). A handler's own
 * `{ok:false}` result passes through with no code — that is a soft failure the
 * caller surfaces as-is, not a routing decision.
 *
 * @param {string} projectName
 * @param {string} command - Action command string (e.g. `invoke-critic`)
 * @param {object} [options] - Forwarded to the handler verbatim
 *   (after session injection). The dispatcher does NOT overwrite an
 *   explicit `options.session` from the caller — tests can inject a
 *   stub session and the dispatcher honors it.
 * @returns {Promise<{ok: boolean, output: object|null, error: string|null, code?: string}>}
 */
async function runAction(projectName, command, options) {
  if (typeof projectName !== 'string' || !projectName) {
    return { ok: false, output: null, error: 'projectName is required', code: 'BAD_REQUEST' };
  }
  if (typeof command !== 'string' || !command) {
    return { ok: false, output: null, error: 'action command is required', code: 'BAD_REQUEST' };
  }

  const project = store.projects.getByName(projectName);
  if (!project) {
    return { ok: false, output: null, error: `Project "${projectName}" not found`, code: 'NOT_FOUND' };
  }

  const entry = ACTIONS.find((a) => a.command === command);
  if (!entry) {
    return { ok: false, output: null, error: `unknown action "${command}"`, code: 'UNKNOWN_ACTION' };
  }
  // Same predicate the button renders from — see availableActions.
  if (!availableActions(project).some((a) => a.command === command)) {
    return {
      ok: false,
      output: null,
      error: `action "${command}" is not available for project "${projectName}"`,
      code: 'UNAVAILABLE'
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
    const result = await Promise.resolve(entry.run(project, enrichedOptions));
    log.info('action ran', { project: projectName, command, ok: result && result.ok });
    return result;
  } catch (err) {
    log.error('action handler threw', { project: projectName, command, error: err.message });
    return { ok: false, output: null, error: `action handler threw: ${err.message}`, code: 'HANDLER_THREW' };
  }
}

module.exports = {
  runAction,
  availableActions,
  ACTIONS
};
