'use strict';

/**
 * The startup prompt service (#1825): the one path the dashboard and the API
 * both take to read, edit and fire the persisted, revisioned startup prompt.
 *
 * Request-level operator proof (the strict operator write: a signed-in session
 * plus CSRF, or same-origin plus the open-install token) is the route's job,
 * because it reads the HTTP request. Everything that decides WHAT may happen
 * lives here, so a second caller of these functions cannot skip a rule the
 * first one enforced.
 *
 * Every result is `{status, body}`. A refusal's body is the `{error, code}`
 * shape `errorResponse` sends, plus any extra fields. No result or audit row
 * carries a launch id: it is a bearer credential, so targets are named by
 * session id and launch-sequence row id.
 */

const store = require('./store');
const startupControl = require('./startup-control');

/** Longest prompt accepted, in characters. It is a short instruction, not a document. */
const MAX_PROMPT_CHARS = 4096;

/** Most projects one revision may authorize to fire. */
const MAX_FIRERS = 64;

/**
 * Store-backed lookups, replaceable in tests.
 * @type {object}
 */
const DEFAULT_DEPS = {
  prompts: store.startupPrompts,
  getProjectByName: (name) => store.projects.getByName(name),
  getProject: (id) => store.projects.get(id),
  getSession: (id) => store.sessions.get(id),
  getLaunchBySession: (sessionId) => store.launchSequences.getBySession(sessionId),
  getEngine: (engineId) => store.engines.get(engineId),
  groupsForProject: (projectId) => store.projectGroups.getByProject(projectId),
  adapters: startupControl.ADAPTERS
};

/**
 * A refusal result.
 * @param {number} status - HTTP status.
 * @param {string} code - Machine-readable code.
 * @param {string} error - Human-readable message.
 * @param {object} [extra] - Additional body fields.
 * @returns {{status: number, body: object}}
 */
function _refuse(status, code, error, extra = {}) {
  return { status, body: { ...extra, error, code } };
}

/**
 * Why a prompt text is unacceptable, or null when it is fine.
 * @param {*} text - Candidate text.
 * @returns {string|null}
 */
function textProblem(text) {
  if (typeof text !== 'string') return 'text must be a string';
  if (text.trim() === '') return 'text must not be empty';
  if (text.length > MAX_PROMPT_CHARS) return `text must be at most ${MAX_PROMPT_CHARS} characters`;
  // Newline is the one control character a multi-line instruction needs. Any
  // other (escape sequences, carriage returns, NUL) could steer a terminal or a
  // protocol frame rather than read as words.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) return 'text must not contain control characters other than newline';
  return null;
}

/**
 * Why a firer list is unacceptable, or null when it is fine.
 * @param {*} ids - Candidate project ids.
 * @param {object} deps - Lookups.
 * @returns {string|null}
 */
function firersProblem(ids, deps) {
  if (!Array.isArray(ids)) return 'firerProjectIds must be an array of project ids';
  if (ids.length > MAX_FIRERS) return `firerProjectIds may name at most ${MAX_FIRERS} projects`;
  if (!ids.every((id) => Number.isInteger(id) && id > 0)) return 'firerProjectIds must contain positive integer project ids';
  if (new Set(ids).size !== ids.length) return 'firerProjectIds must not repeat a project';
  const unknown = ids.filter((id) => !deps.getProject(id));
  if (unknown.length > 0) return `firerProjectIds names projects that do not exist: ${unknown.join(', ')}`;
  return null;
}

/**
 * The prompt as the API reports it.
 * @param {object} prompt - A store revision.
 * @returns {object}
 */
function _publicPrompt(prompt) {
  return {
    revision: prompt.revision,
    text: prompt.text,
    digest: prompt.digest,
    firerProjectIds: prompt.firerProjectIds,
    updatedAt: prompt.createdAt,
    updatedByKind: prompt.createdByKind
  };
}

/**
 * Read the current startup prompt.
 * @param {object} [deps=DEFAULT_DEPS] - Lookups.
 * @returns {{status: number, body: object}}
 */
function read(deps = DEFAULT_DEPS) {
  return { status: 200, body: _publicPrompt(deps.prompts.current()) };
}

/**
 * Write a new revision of the prompt and its firer list. The caller must
 * already have proven it is the operator.
 * @param {{text: *, firerProjectIds: *, expectedRevision: *}} input - Request body.
 * @param {object} [deps=DEFAULT_DEPS] - Lookups.
 * @returns {{status: number, body: object}}
 */
function update(input, deps = DEFAULT_DEPS) {
  const body = input && typeof input === 'object' ? input : {};
  if (!Number.isInteger(body.expectedRevision)) {
    return _refuse(400, 'STARTUP_PROMPT_INVALID', 'expectedRevision must be an integer');
  }
  const problem = textProblem(body.text)
    || firersProblem(body.firerProjectIds === undefined ? [] : body.firerProjectIds, deps);
  if (problem) return _refuse(400, 'STARTUP_PROMPT_INVALID', problem);
  const result = deps.prompts.update({
    text: body.text,
    firerProjectIds: body.firerProjectIds || [],
    expectedRevision: body.expectedRevision,
    byKind: 'operator'
  });
  if (!result.ok) {
    return _refuse(409, 'STALE_STARTUP_PROMPT',
      `The startup prompt changed since revision ${body.expectedRevision}. Reload it and try again.`,
      { currentRevision: result.currentRevision });
  }
  return { status: 200, body: _publicPrompt(result.prompt) };
}

/**
 * Whether a caller may fire the prompt at a session of `targetProjectId`.
 *
 * The operator may fire anywhere. An agent session may fire only when its
 * project is in the current revision's firer list AND it shares a project
 * group with the target: the list says who is trusted, the group says where.
 *
 * @param {{kind: string, projectId: (number|null), groupIds: string[]}} caller - A resolved caller.
 * @param {number} targetProjectId - The target session's project.
 * @param {object} prompt - The current revision.
 * @param {object} deps - Lookups.
 * @returns {boolean}
 */
function canFire(caller, targetProjectId, prompt, deps) {
  if (!caller) return false;
  if (caller.kind === 'operator') return true;
  if (caller.kind !== 'project' || !Number.isInteger(caller.projectId)) return false;
  if (!prompt.firerProjectIds.includes(caller.projectId)) return false;
  const targetGroups = new Set(deps.groupsForProject(targetProjectId).map((g) => g.id));
  return (caller.groupIds || []).some((id) => targetGroups.has(id));
}

/**
 * Fire the current startup prompt at one exact launch.
 *
 * The request names the prompt revision it expects and the session and launch
 * it means. A fire is recorded once per launch and revision, so a repeat
 * returns the first record instead of submitting the prompt again. An engine
 * with no supported startupControl channel gets a typed refusal: there is no
 * fallback, and nothing is typed into its pane.
 *
 * @param {{projectName: string, sessionId: *, sequenceId: *, expectedRevision: *, caller: object}} input
 * @param {object} [deps=DEFAULT_DEPS] - Lookups.
 * @returns {{status: number, body: object}}
 */
function fire(input, deps = DEFAULT_DEPS) {
  const { projectName, sessionId, sequenceId, expectedRevision, caller } = input;
  if (!Number.isInteger(sessionId) || !Number.isInteger(sequenceId) || !Number.isInteger(expectedRevision)) {
    return _refuse(400, 'STARTUP_PROMPT_INVALID', 'sessionId, sequenceId and expectedRevision must be integers');
  }
  const project = deps.getProjectByName(projectName);
  if (!project) return _refuse(404, 'SESSION_NOT_FOUND', `No project named ${projectName}`);

  const prompt = deps.prompts.current();
  if (!canFire(caller, project.id, prompt, deps)) {
    return _refuse(403, 'FIRE_SCOPE_DENIED',
      'This caller may not fire the startup prompt at this project. Only the operator, or a project the operator '
      + 'listed as a firer that shares a project group with the target, may.');
  }

  const session = deps.getSession(sessionId);
  if (!session || session.projectId !== project.id || session.status !== store.SESSION_STATUS.ACTIVE) {
    return _refuse(404, 'SESSION_NOT_FOUND', `No active session ${sessionId} in ${projectName}`);
  }
  const launch = deps.getLaunchBySession(sessionId);
  if (!launch || launch.id !== sequenceId) {
    return _refuse(409, 'LAUNCH_NOT_CURRENT', `Launch ${sequenceId} is not session ${sessionId}'s current launch`);
  }
  if (expectedRevision !== prompt.revision) {
    return _refuse(409, 'STALE_STARTUP_PROMPT',
      `The startup prompt is at revision ${prompt.revision}, not ${expectedRevision}. Reload it and try again.`,
      { currentRevision: prompt.revision });
  }

  const engineId = session.engineId;
  const capability = startupControl.resolve(deps.getEngine(engineId), deps.adapters);
  const record = {
    sessionId,
    sequenceId,
    promptRevision: prompt.revision,
    promptDigest: prompt.digest,
    callerKind: caller.kind,
    callerProjectId: caller.kind === 'project' ? caller.projectId : null
  };

  if (!capability.supported) {
    const { fire: row, duplicate } = deps.prompts.recordFire({ ...record, outcome: 'unsupported', reason: capability.reason });
    return _refuse(409, 'STARTUP_CONTROL_UNSUPPORTED',
      `startupControl is unsupported for this session: ${row.reason}`,
      { engine: engineId, reason: row.reason, fire: row, duplicate });
  }

  // Dispatch through a registered adapter is the Codex adapter's chunk (B2),
  // which defines the adapter contract against a live receipt. Until then the
  // registry ships empty, so this cannot be reached in production; if a test
  // or a stray registration reaches it, the answer is an honest refusal that
  // records nothing and types nothing.
  return _refuse(501, 'STARTUP_CONTROL_DISPATCH_UNAVAILABLE',
    `Engine ${engineId} has a registered startupControl adapter, but this TangleClaw cannot dispatch to it yet`,
    { engine: engineId });
}

module.exports = { MAX_PROMPT_CHARS, MAX_FIRERS, DEFAULT_DEPS, textProblem, firersProblem, read, update, canFire, fire };
