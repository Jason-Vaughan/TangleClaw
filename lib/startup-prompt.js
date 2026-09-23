'use strict';

/**
 * The startup prompt service (#1825): the one path the dashboard and the API
 * both take to read, edit and fire the persisted, revisioned startup prompt.
 *
 * Request-level operator proof (the strict operator write: a signed-in session
 * plus CSRF, or same-origin plus the open-install token) is the route's job,
 * because it reads the HTTP request; the route hands the resulting clearance
 * in. Everything that decides WHAT may happen lives here, so a second caller of
 * these functions cannot skip a rule the first one enforced.
 *
 * Every result is `{status, body}`. A refusal's body is the `{error, code}`
 * shape `errorResponse` sends, plus any extra fields. No result or audit row
 * carries a launch id: it is a bearer credential, so targets are named by
 * session id and launch-sequence row id.
 */

const store = require('./store');
const startupControl = require('./startup-control');

/** Longest prompt accepted, in UTF-8 bytes. It is a short instruction, not a document. */
const MAX_PROMPT_BYTES = 4096;

/** Most projects one revision may authorize to fire. */
const MAX_FIRERS = 64;

/** What an idempotency key may look like: 8–128 URL-safe characters. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

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
  if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) return `text must be at most ${MAX_PROMPT_BYTES} bytes of UTF-8`;
  // LF is the one control character a multi-line instruction needs. Any other
  // (escape sequences, carriage returns, tabs, NUL) could steer a terminal or a
  // protocol frame rather than read as words. The text is stored and hashed
  // exactly as sent, with no Unicode normalization.
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
 * Read the current startup prompt, shaped for the caller.
 *
 * The operator sees the whole firer list. A bound project session sees the
 * prompt and its digests, and only whether ITS project is listed: the list is
 * other projects' authority, and a session has no need to learn it.
 *
 * @param {{kind: string, projectId: (number|null)}} caller - A resolved caller.
 * @param {object} [deps=DEFAULT_DEPS] - Lookups.
 * @returns {{status: number, body: object}}
 */
function read(caller, deps = DEFAULT_DEPS) {
  const p = deps.prompts.current();
  const body = {
    revision: p.revision,
    text: p.text,
    textDigest: p.textDigest,
    policyDigest: p.policyDigest,
    updatedAt: p.createdAt
  };
  if (caller && caller.kind === 'operator') {
    body.firerProjectIds = p.firerProjectIds;
    body.updatedByKind = p.createdByKind;
    body.updatedBy = p.createdBy;
  } else {
    body.callerListedAsFirer = !!(caller && Number.isInteger(caller.projectId) && p.firerProjectIds.includes(caller.projectId));
  }
  return { status: 200, body };
}

/**
 * Write a new revision: the full prompt state, `{text, firerProjectIds,
 * expectedRevision}`. The route must already have proven the operator and
 * passes that proof in, so the revision records how well its author was
 * proven.
 * @param {{text: *, firerProjectIds: *, expectedRevision: *}} input - Request body.
 * @param {{clearance: string, actor: (string|null)}} proof - From the strict operator write.
 * @param {object} [deps=DEFAULT_DEPS] - Lookups.
 * @returns {{status: number, body: object}}
 */
function update(input, proof, deps = DEFAULT_DEPS) {
  const body = input && typeof input === 'object' ? input : {};
  if (!Number.isInteger(body.expectedRevision)) {
    return _refuse(400, 'STARTUP_PROMPT_INVALID', 'expectedRevision must be an integer');
  }
  if (body.firerProjectIds === undefined) {
    return _refuse(400, 'STARTUP_PROMPT_INVALID',
      'firerProjectIds is required: a save states the whole prompt, and an empty list means only the operator may fire');
  }
  const problem = textProblem(body.text) || firersProblem(body.firerProjectIds, deps);
  if (problem) return _refuse(400, 'STARTUP_PROMPT_INVALID', problem);
  const result = deps.prompts.update({
    text: body.text,
    firerProjectIds: body.firerProjectIds,
    expectedRevision: body.expectedRevision,
    byKind: proof.clearance,
    byName: proof.actor
  });
  if (!result.ok) {
    return _refuse(409, 'STALE_STARTUP_PROMPT',
      `The startup prompt changed since revision ${body.expectedRevision}. Reload it and try again.`,
      { currentRevision: result.currentRevision });
  }
  return read({ kind: 'operator' }, deps);
}

/**
 * Whether a caller may fire the prompt at a session of `targetProjectId`.
 *
 * The operator may fire anywhere. An agent session may fire only when its
 * project is in the current revision's firer list AND it currently shares a
 * project group with the target: the list says who is trusted, the group says
 * where. This is project authority, not a human role; the Master and every
 * unbound caller are denied.
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
 * The refusal for a target the caller cannot see. The same answer whether the
 * target does not exist or is out of scope, so a fire attempt cannot be used
 * to map other groups' sessions.
 * @param {string} projectName - Path project.
 * @param {*} sessionId - Requested session.
 * @returns {{status: number, body: object}}
 */
function _notFound(projectName, sessionId) {
  return _refuse(404, 'SESSION_NOT_FOUND', `No active session ${sessionId} in ${projectName}`);
}

/**
 * The response for an existing fire record: the unsupported refusal it was, or
 * the record itself.
 * @param {object} fire - Stored fire.
 * @param {boolean} duplicate - Whether this answers a repeated key.
 * @param {string} [engine] - Engine id, when known.
 * @returns {{status: number, body: object}}
 */
function _fireResult(fire, duplicate, engine) {
  if (fire.outcome === 'unsupported') {
    return _refuse(409, 'STARTUP_CONTROL_UNSUPPORTED',
      `startupControl is unsupported for this session: ${fire.reason}`,
      { engine, reasonCode: fire.reasonCode, reason: fire.reason, fire, duplicate });
  }
  if (fire.outcome === 'denied') return _notFound('this project', fire.sessionId);
  return { status: 200, body: { fire, duplicate } };
}

/**
 * Fire the current startup prompt at one exact launch.
 *
 * Every check and the fire's intent row are one transaction: the current
 * prompt revision, the target's current launch, the caller's scope, the
 * launch's single active slot and the applied-once key are all read and the
 * row is written before anything could leave the process. A repeat of the
 * same `idempotencyKey` returns the first record. An engine with no supported
 * startupControl channel gets a typed refusal: there is no fallback, and
 * nothing is typed into its pane.
 *
 * @param {object} input
 * @param {string} input.projectName - Path project.
 * @param {*} input.sessionId - Target session id.
 * @param {*} input.sequenceId - Target launch-sequence row id.
 * @param {*} input.expectedRevision - Prompt revision the caller means.
 * @param {*} input.idempotencyKey - Caller-chosen key for this attempt.
 * @param {object} input.caller - Resolved caller (`resolveAccess`).
 * @param {string} input.clearance - 'operator-verified', 'open-install-unverified' or 'project-binding'.
 * @param {object} [deps=DEFAULT_DEPS] - Lookups.
 * @returns {{status: number, body: object}}
 */
function fire(input, deps = DEFAULT_DEPS) {
  const { projectName, sessionId, sequenceId, expectedRevision, idempotencyKey, caller, clearance } = input;
  if (!Number.isInteger(sessionId) || !Number.isInteger(sequenceId) || !Number.isInteger(expectedRevision)) {
    return _refuse(400, 'STARTUP_PROMPT_INVALID', 'sessionId, sequenceId and expectedRevision must be integers');
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return _refuse(400, 'STARTUP_PROMPT_INVALID', 'idempotencyKey must be 8-128 characters of A-Z, a-z, 0-9, _ or -');
  }

  return deps.prompts.transaction(() => {
    const project = deps.getProjectByName(projectName);
    const session = project ? deps.getSession(sessionId) : null;
    const exists = !!(session && session.projectId === project.id && session.status === store.SESSION_STATUS.ACTIVE);
    const prompt = deps.prompts.current();

    if (!exists) return _notFound(projectName, sessionId);

    const launch = deps.getLaunchBySession(sessionId);
    const record = {
      idempotencyKey,
      projectId: project.id,
      sessionId,
      sequenceId,
      promptRevision: prompt.revision,
      promptTextDigest: prompt.textDigest,
      policyDigest: prompt.policyDigest,
      callerKind: caller.kind === 'operator' ? 'operator' : 'project',
      callerClearance: clearance,
      callerProjectId: caller.kind === 'project' ? caller.projectId : null
    };

    if (!canFire(caller, project.id, prompt, deps)) {
      // Audited, and answered exactly like a target that does not exist. A
      // repeated key is not recorded twice.
      if (!deps.prompts.getFireByKey(idempotencyKey) && launch) {
        deps.prompts.insertFire({
          ...record,
          sequenceId: launch.id,
          outcome: 'denied',
          reasonCode: 'fire_scope_denied',
          reason: 'caller is not a listed firer sharing a project group with the target'
        });
      }
      return _notFound(projectName, sessionId);
    }

    const replay = deps.prompts.getFireByKey(idempotencyKey);
    if (replay) {
      if (replay.sessionId !== sessionId || replay.sequenceId !== sequenceId) {
        return _refuse(409, 'IDEMPOTENCY_KEY_REUSED', 'That idempotencyKey was already used for a different target');
      }
      return _fireResult(replay, true, session.engineId);
    }

    if (!launch || launch.id !== sequenceId) {
      return _refuse(409, 'LAUNCH_NOT_CURRENT', `Launch ${sequenceId} is not session ${sessionId}'s current launch`);
    }
    if (expectedRevision !== prompt.revision) {
      return _refuse(409, 'STALE_STARTUP_PROMPT',
        `The startup prompt is at revision ${prompt.revision}, not ${expectedRevision}. Reload it and try again.`,
        { currentRevision: prompt.revision });
    }
    if (deps.prompts.appliedFire(sequenceId, prompt.revision)) {
      return _refuse(409, 'STARTUP_PROMPT_ALREADY_APPLIED',
        `Revision ${prompt.revision} was already applied to this launch, and is never injected twice`);
    }
    const active = deps.prompts.activeFire(sequenceId);
    if (active) {
      return _refuse(409, 'STARTUP_FIRE_IN_FLIGHT',
        `A fire is already ${active.outcome} for this launch`, { fire: active });
    }

    const capability = startupControl.resolve(deps.getEngine(session.engineId), deps.adapters);
    if (!capability.supported) {
      const row = deps.prompts.insertFire({
        ...record, outcome: 'unsupported', reasonCode: capability.reasonCode, reason: capability.reason
      });
      return _fireResult(row, false, session.engineId);
    }

    // Dispatch through a registered adapter is the adapter chunk's (B2), which
    // defines the intent → dispatching → receipt transitions against a live
    // receipt. The registry ships empty, so this is unreachable in
    // production; if a test or a stray registration reaches it, the answer is
    // an honest refusal that records nothing and types nothing.
    return _refuse(501, 'STARTUP_CONTROL_DISPATCH_UNAVAILABLE',
      `Engine ${session.engineId} has a registered startupControl adapter, but this TangleClaw cannot dispatch to it yet`,
      { engine: session.engineId });
  });
}

module.exports = {
  MAX_PROMPT_BYTES, MAX_FIRERS, IDEMPOTENCY_KEY_PATTERN, DEFAULT_DEPS,
  textProblem, firersProblem, read, update, canFire, fire
};
