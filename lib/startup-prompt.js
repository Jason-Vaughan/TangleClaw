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

const crypto = require('node:crypto');

const store = require('./store');
const startupControl = require('./startup-control');
const engines = require('./engines');
const { createLogger } = require('./logger');

const log = createLogger('startup-prompt');

/** How long a fire waits for the engine's `accepted` before answering with the row as it stands. */
const ACCEPT_WAIT_MS = 10000;

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
  // resolveProfile, not store.engines.get: an OpenClaw session's engine id is
  // `openclaw:<connection>`, which only resolveProfile maps to a profile.
  getEngine: (engineId) => engines.resolveProfile(engineId),
  groupsForProject: (projectId) => store.projectGroups.getByProject(projectId),
  adapters: startupControl.ADAPTERS,
  // The launch-start payload's input: the frozen launch steps.
  listSteps: (sequenceId, revision) => store.launchSequences.listSteps(sequenceId, revision),
  logActivity: (entry) => store.activity.log(entry),
  acceptWaitMs: ACCEPT_WAIT_MS,
  adapterDeps: undefined
};

/**
 * JSON with every object's keys sorted, so the same facts always hash the
 * same way whatever order they were assembled in.
 * @param {*} value - Any JSON value.
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * SHA-256 of a string, hex.
 * @param {string} text - Input.
 * @returns {string}
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The canonicalization version stored with every payload, so a later change is a new version, not a silent one. */
const PAYLOAD_CANON_VERSION = 1;

/**
 * The launch-start payload a fire binds to, and its digest,
 * which becomes the engine-echoed `clientUserMessageId`.
 *
 * Every input is read from the FROZEN launch snapshot (the launch-sequence
 * row and its steps at the current revision), never from live state, so two
 * reads of one launch produce one digest. The launch id is hashed in and
 * never stored: it is the pane's bearer credential.
 *
 * - The priming pact is the digest of a domain-separated, versioned object
 *   over the four step digests at the launch revision: the exact frozen bytes
 *   the session was primed with. `sourceManifest` is provenance, not the pact.
 * - The role+assignment revision is the honest CURRENT PROXY the Architect
 *   selected (R-a): TangleClaw has no first-class role or assignment record.
 *   It hashes the target's project binding, `roleKind: project-bound`, the
 *   snapshot's rule fingerprints (governance, which is what defines a session
 *   here) and the handoff publication the launch consumed (continuity, not a
 *   persisted PM dispatch). A future first-class record is a new decision,
 *   not a silent change to this digest.
 *
 * @param {object} input
 * @param {object} input.launch - The launch-sequence row.
 * @param {object} input.session - The target session.
 * @param {object} input.project - Its project.
 * @param {object} input.prompt - The prompt revision being fired.
 * @param {object} deps - Lookups.
 * @returns {{stored: object, digest: string}} The payload without the bearer, and the digest over the payload with it.
 */
function buildLaunchPayload({ launch, session, project, prompt }, deps) {
  let steps = [];
  try {
    steps = deps.listSteps(launch.id, launch.revision) || [];
  } catch (err) {
    log.warn('Launch steps unreadable for the fire payload; the pact digest covers no steps', { launch: launch.id, error: err.message });
  }
  const stepDigests = {};
  for (const id of store.LAUNCH_STEP_IDS) {
    const step = steps.find((st) => st.id === id);
    stepDigests[id] = step ? step.digest : null;
  }
  const pact = { kind: 'startup-priming-pact', version: PAYLOAD_CANON_VERSION, launchRevision: launch.revision, steps: stepDigests };
  const primingPactDigest = sha256(canonicalJson(pact));

  const manifest = launch.sourceManifest && typeof launch.sourceManifest === 'object' ? launch.sourceManifest : {};
  const ruleFingerprints = Array.isArray(manifest.rules)
    ? manifest.rules.map((r) => ({ id: r.id, source: r.source || null, revision: r.revision === undefined ? null : r.revision, contentHash: r.contentHash || null }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    : [];
  const roleAssignment = {
    kind: 'startup-role-assignment',
    version: PAYLOAD_CANON_VERSION,
    projectId: project.id,
    projectName: manifest.renderContext && typeof manifest.renderContext.projectName === 'string' ? manifest.renderContext.projectName : null,
    roleKind: 'project-bound',
    ruleFingerprints,
    handoffPublicationId: manifest.handoffPublicationId || null,
    handoffDigest: manifest.handoffDigest || null
  };
  const roleAssignmentRevision = sha256(canonicalJson(roleAssignment));

  const full = {
    launchId: launch.launchId,
    sessionId: session.id,
    projectId: project.id,
    sequenceId: launch.id,
    launchRevision: launch.revision,
    stepDigests,
    primingPactDigest,
    roleAssignmentRevision,
    roleAssignmentSource: 'project-binding+session-rules+handoff',
    promptRevision: prompt.revision,
    promptTextDigest: prompt.textDigest,
    policyDigest: prompt.policyDigest,
    canonVersion: PAYLOAD_CANON_VERSION
  };
  const digest = sha256(canonicalJson(full));
  const { launchId, ...stored } = full;
  void launchId;
  return { stored: { ...stored, roleAssignment }, digest };
}

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
  // C1 (U+0080–U+009F) included: U+009B is a single-character CSI to some terminals.
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text)) return 'text must not contain control characters other than newline';
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
 * The response for a fire record: a typed refusal for the outcomes where
 * nothing was sent, otherwise the record itself.
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
  if (fire.outcome === 'blocked') {
    return _refuse(409, 'STARTUP_FIRE_BLOCKED',
      `the startup prompt was not sent: ${fire.reason}`,
      { engine, reasonCode: fire.reasonCode, reason: fire.reason, fire, duplicate });
  }
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
 * On a supported engine the row is written as `pending` and the adapter then
 * runs outside the transaction; every transition it reports is applied
 * through the store's transition map. The call returns once the engine has
 * accepted the prompt, the fire has ended, or `acceptWaitMs` has passed, with
 * the row as it then stands; the watch continues in the background.
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
 * @returns {Promise<{status: number, body: object}>}
 */
async function fire(input, deps = DEFAULT_DEPS) {
  const { projectName, sessionId, sequenceId, expectedRevision, idempotencyKey, caller, clearance } = input;
  if (!Number.isInteger(sessionId) || !Number.isInteger(sequenceId) || !Number.isInteger(expectedRevision)) {
    return _refuse(400, 'STARTUP_PROMPT_INVALID', 'sessionId, sequenceId and expectedRevision must be integers');
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return _refuse(400, 'STARTUP_PROMPT_INVALID', 'idempotencyKey must be 8-128 characters of A-Z, a-z, 0-9, _ or -');
  }

  // An indeterminate fire holds the launch's slot until the engine's own record
  // settles it. Reconciled here, before the decision, and never retried.
  await _reconcileIndeterminate(sequenceId, deps);

  const decided = deps.prompts.transaction(() => {
    const project = deps.getProjectByName(projectName);
    const session = project ? deps.getSession(sessionId) : null;
    const exists = !!(session && session.projectId === project.id && session.status === store.SESSION_STATUS.ACTIVE);
    const prompt = deps.prompts.current();

    if (!exists) return { result: _notFound(projectName, sessionId) };

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
      return { result: _notFound(projectName, sessionId) };
    }

    const replay = deps.prompts.getFireByKey(idempotencyKey);
    if (replay) {
      if (replay.sessionId !== sessionId || replay.sequenceId !== sequenceId) {
        return { result: _refuse(409, 'IDEMPOTENCY_KEY_REUSED', 'That idempotencyKey was already used for a different target') };
      }
      return { result: _fireResult(replay, true, session.engineId) };
    }

    if (!launch || launch.id !== sequenceId) {
      return { result: _refuse(409, 'LAUNCH_NOT_CURRENT', `Launch ${sequenceId} is not session ${sessionId}'s current launch`) };
    }
    if (expectedRevision !== prompt.revision) {
      return {
        result: _refuse(409, 'STALE_STARTUP_PROMPT',
          `The startup prompt is at revision ${prompt.revision}, not ${expectedRevision}. Reload it and try again.`,
          { currentRevision: prompt.revision })
      };
    }
    if (deps.prompts.appliedFire(sequenceId, prompt.revision)) {
      return {
        result: _refuse(409, 'STARTUP_PROMPT_ALREADY_APPLIED',
          `Revision ${prompt.revision} was already applied to this launch, and is never injected twice`)
      };
    }
    const active = deps.prompts.activeFire(sequenceId);
    if (active) {
      return {
        result: _refuse(409, 'STARTUP_FIRE_IN_FLIGHT',
          `A fire is already ${active.outcome} for this launch`, { fire: active })
      };
    }

    const capability = startupControl.resolveEngine(session.engineId, deps.getEngine, deps.adapters);
    if (!capability.supported) {
      const row = deps.prompts.insertFire({
        ...record, outcome: 'unsupported', reasonCode: capability.reasonCode, reason: capability.reason
      });
      return { result: _fireResult(row, false, session.engineId) };
    }
    if (typeof capability.adapter.fire !== 'function') {
      // A registered adapter that cannot dispatch: an honest refusal that
      // records nothing and types nothing.
      return {
        result: _refuse(501, 'STARTUP_CONTROL_DISPATCH_UNAVAILABLE',
          `Engine ${session.engineId} has a registered startupControl adapter, but this TangleClaw cannot dispatch to it yet`,
          { engine: session.engineId })
      };
    }

    // The intent row: durable before anything can leave the process.
    const payload = buildLaunchPayload({ launch, session, project, prompt }, deps);
    const row = deps.prompts.insertFire({
      ...record, outcome: 'pending', reasonCode: null, reason: null,
      payload: payload.stored, payloadDigest: payload.digest
    });
    return { dispatch: { row, session, project, prompt, capability, payloadDigest: payload.digest, launch } };
  });

  if (decided.result) return decided.result;
  return _dispatch(decided.dispatch, deps);
}

/**
 * Apply one adapter-reported transition to a fire row, and log it. A refused
 * transition (out of order, or after a terminal outcome) leaves the row as it
 * was and is logged, never thrown into the adapter.
 * @param {number} fireId - Fire row id.
 * @param {object} patch - Transition.
 * @param {object} deps - Lookups.
 * @returns {object} The row after the update.
 */
function applyFireTransition(fireId, patch, deps = DEFAULT_DEPS) {
  const result = deps.prompts.updateFire(fireId, patch);
  const row = result.fire || deps.prompts.getFireById(fireId);
  if (!result.ok) {
    log.warn('Fire transition refused', { fire: fireId, wanted: patch.outcome, reason: result.reason });
    return row;
  }
  try {
    deps.logActivity({
      projectId: row.projectId,
      sessionId: row.sessionId,
      eventType: `startup_prompt.fire.${row.outcome}`,
      detail: { fireId: row.id, sequenceId: row.sequenceId, revision: row.promptRevision, reasonCode: row.reasonCode, reason: row.reason }
    });
  } catch (err) {
    log.warn('Could not log a fire transition', { fire: fireId, error: err.message });
  }
  return row;
}

/**
 * Hand a pending fire to its adapter and wait, bounded, for the engine's
 * acceptance.
 * @param {object} d - The decision: `row, session, project, prompt, capability, payloadDigest`.
 * @param {object} deps - Lookups.
 * @returns {Promise<{status: number, body: object}>}
 */
async function _dispatch(d, deps) {
  const onUpdate = (patch) => applyFireTransition(d.row.id, patch, deps);
  let handles;
  try {
    handles = d.capability.adapter.fire({
      session: d.session,
      project: d.project,
      sequenceId: d.launch.id,
      promptText: d.prompt.text,
      promptTextDigest: d.prompt.textDigest,
      payloadDigest: d.payloadDigest,
      onUpdate
    }, deps.adapterDeps);
  } catch (err) {
    log.error('startupControl adapter threw before dispatching', { fire: d.row.id, error: err.message });
    const row = onUpdate({ outcome: 'failed', reasonCode: 'channel_lost', reason: `the adapter failed before sending: ${err.message}` });
    return _fireResult(row, false, d.session.engineId);
  }
  handles.settled.catch((err) => {
    log.error('startupControl adapter threw while watching a fire', { fire: d.row.id, error: err.message });
    onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: `the adapter failed while the turn ran: ${err.message}; never retried automatically` });
  });
  const waitMs = Number.isInteger(deps.acceptWaitMs) ? deps.acceptWaitMs : ACCEPT_WAIT_MS;
  let timer;
  await Promise.race([
    handles.accepted,
    new Promise((resolve) => { timer = setTimeout(resolve, waitMs); if (timer.unref) timer.unref(); })
  ]);
  clearTimeout(timer);
  const row = deps.prompts.getFireById(d.row.id);
  return _fireResult(row, false, d.session.engineId);
}

/**
 * Settle a launch's indeterminate fire from the engine's own record before a
 * new fire is decided. A fire that cannot be settled stays where it is,
 * and the new fire is then refused as in flight.
 * @param {number} sequenceId - Launch-sequence row id.
 * @param {object} deps - Lookups.
 * @returns {Promise<void>}
 */
async function _reconcileIndeterminate(sequenceId, deps) {
  let active;
  try {
    active = deps.prompts.activeFire(sequenceId);
  } catch {
    return;
  }
  if (!active || active.outcome !== 'indeterminate') return;
  const session = deps.getSession(active.sessionId);
  if (!session) return;
  const capability = startupControl.resolveEngine(session.engineId, deps.getEngine, deps.adapters);
  if (!capability.supported || typeof capability.adapter.reconcile !== 'function') return;
  try {
    await capability.adapter.reconcile({
      session,
      fire: active,
      onUpdate: (patch) => applyFireTransition(active.id, patch, deps)
    }, deps.adapterDeps);
  } catch (err) {
    log.warn('Reconcile of an indeterminate fire failed; it stays indeterminate', { fire: active.id, error: err.message });
  }
}

module.exports = {
  MAX_PROMPT_BYTES, MAX_FIRERS, IDEMPOTENCY_KEY_PATTERN, ACCEPT_WAIT_MS, PAYLOAD_CANON_VERSION, DEFAULT_DEPS,
  textProblem, firersProblem, read, update, canFire, fire, buildLaunchPayload, canonicalJson, applyFireTransition
};
