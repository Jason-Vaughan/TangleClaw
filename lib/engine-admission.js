'use strict';

/**
 * Engine portability beyond the wrap (#1809): capability-matched task
 * admission, and attested rotation of which engine attempt holds publication
 * authority over a resource.
 *
 * The 2026-09-21 Architect ruling on #1738 asked for more than the wrap.
 * Train A Car A3 Chunk 02 built the wrap's own engine-aware gates
 * (`not-applicable` / `capability-unavailable` step statuses). This module
 * builds the two pieces that ruling named as still missing everywhere else:
 *
 * 1. **Capability-matched admission** ({@link admitTask}) — match work to an
 *    engine that can perform it, so methodology-required work (Critic, PR,
 *    merge, release) is never dispatched to a session whose engine cannot
 *    run the project's methodology.
 * 2. **Attested rotation** ({@link prepareRotation} through
 *    {@link transferAuthority}) — replacing one engine attempt with another
 *    as a sequence with one durable record, so a relaunch on a different
 *    engine can never leave two attempts both believing they hold
 *    publication authority:
 *
 *      prepared -> quiesced -> revoked -> attested -> active   (any stage -> abandoned)
 *
 *    - `prepared`: the old attempt's checkpoint (WIP summary) is recorded
 *      and the next epoch is assigned. Nothing about the old attempt has
 *      changed yet.
 *    - `quiesced`: the old attempt has stopped making new progress; its WIP
 *      is preserved in the checkpoint already recorded at `prepared`.
 *    - `revoked`: the old attempt's publication lease and epoch are revoked.
 *      From here on, anything that still presents the old epoch is stale.
 *    - `attested`: the replacement is checked against the EXACT checkout,
 *      worktree and state the checkpoint named — not merely that one exists.
 *      A mismatch refuses and leaves the record at `revoked`, retryable.
 *    - `active`: authority transfers to the replacement, exactly once.
 *      {@link transferAuthority} is a compare-and-set: a retry that repeats
 *      the same already-active attempt is a no-op: a retry naming a
 *      DIFFERENT attempt is refused outright, never silently accepted.
 *
 * Every transition validates the record's current stage explicitly and
 * returns a new record rather than mutating the one it was given, so a
 * caller that persists after each step (via {@link writeRotation}) never
 * observes a half-applied transition.
 *
 * This module does not reach into the task dispatcher, the session
 * lifecycle, or the lease/epoch gate `lib/coordinator-rotation.js` already
 * runs for the PM/Architect role — those integrations are outside this
 * car's file scope (`lib/engine-admission.js` only). It is the self-contained
 * primitive those integrations call.
 *
 * @module lib/engine-admission
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const stagedWrite = require('./staged-write');

/** Schema tag of a rotation record. */
const SCHEMA = 'tc.engine-admission-rotation/v1';

/** Directory the rotation ledger lives under, relative to a TangleClaw base directory. */
const ROTATION_DIR = 'engine-admission/rotations';

/** Prefix for this module's atomic-write staging files. */
const STAGING_PREFIX = '.engine-admission.';

/** A rotation record is small by construction; anything larger is not one. */
const MAX_BYTES = 32 * 1024;

/** Rotation lifecycle stages, in the order a healthy rotation moves through them. */
const STAGES = Object.freeze({
  PREPARED: 'prepared',
  QUIESCED: 'quiesced',
  REVOKED: 'revoked',
  ATTESTED: 'attested',
  ACTIVE: 'active',
  ABANDONED: 'abandoned'
});

/** The stage each stage may legally advance to. `abandoned` is reachable from anywhere non-terminal. */
const NEXT_STAGE = Object.freeze({
  [STAGES.PREPARED]: STAGES.QUIESCED,
  [STAGES.QUIESCED]: STAGES.REVOKED,
  [STAGES.REVOKED]: STAGES.ATTESTED,
  [STAGES.ATTESTED]: STAGES.ACTIVE
});

/** Identifiers are filesystem path segments and log fields: keep them boring. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Error for admission/rotation input that does not match this module's contract. */
class AdmissionError extends Error {}

/**
 * Refuse unless `cond` holds.
 * @param {boolean} cond - The check.
 * @param {string} msg - Reader-facing reason.
 * @returns {void}
 */
function _need(cond, msg) {
  if (!cond) throw new AdmissionError(msg);
}

function _needId(s, where) {
  _need(typeof s === 'string' && ID_RE.test(s), `${where} must be 1-128 characters of letters, digits, ".", "_" or "-", starting with a letter or digit`);
}

function _needEpochMs(n, where) {
  _need(Number.isInteger(n) && n >= 0, `${where} must be epoch milliseconds`);
}

function _needDigest(s, where) {
  _need(typeof s === 'string' && s.length > 0 && s.length <= 256, `${where} must be a non-empty digest string`);
}

function _needShape(obj, where, required, optional = []) {
  _need(obj !== null && typeof obj === 'object' && !Array.isArray(obj), `${where} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) _need(allowed.has(key), `${where} has unknown key "${key.slice(0, 40)}"`);
  for (const key of required) _need(obj[key] !== undefined, `${where}.${key} is missing`);
}

// ── Capability-matched admission ──

/**
 * Capability ids this module knows the names of. An engine may declare any
 * capability id — {@link admit} is fully generic — but these are the ones
 * the issue names explicitly ("methodology-required work (Critic, PR,
 * merge, release)"), and every value {@link TASK_KIND_REQUIREMENTS} draws
 * from is checked against this list (see `test/engine-admission.test.js`),
 * so a typo added alongside a future task kind is caught at the definition,
 * not discovered later as a task that silently never admits.
 */
const KNOWN_CAPABILITIES = Object.freeze(['methodology', 'critic', 'pr', 'merge', 'release']);

/**
 * The capabilities each named task kind requires. Declared as data, not
 * hard-wired into {@link admitTask}, so a new task kind is one more entry,
 * never a new branch.
 */
const TASK_KIND_REQUIREMENTS = Object.freeze({
  critic: Object.freeze(['methodology', 'critic']),
  pr: Object.freeze(['methodology', 'pr']),
  merge: Object.freeze(['methodology', 'merge']),
  release: Object.freeze(['methodology', 'release'])
});

/**
 * Whether an engine's declared capabilities admit a piece of work that
 * requires a specific set of capabilities. Generic and task-agnostic: this
 * is the one check every admission decision in this module ultimately
 * reduces to.
 * @param {object} o
 * @param {string[]} o.engineCapabilities - What this engine attempt can do.
 * @param {string[]} o.requiredCapabilities - What the work needs.
 * @returns {{admitted: boolean, missingCapabilities: string[]}}
 */
function admit({ engineCapabilities, requiredCapabilities }) {
  _need(Array.isArray(engineCapabilities), 'engineCapabilities must be an array');
  _need(Array.isArray(requiredCapabilities), 'requiredCapabilities must be an array');
  const have = new Set(engineCapabilities);
  const missingCapabilities = requiredCapabilities.filter((c) => !have.has(c));
  return { admitted: missingCapabilities.length === 0, missingCapabilities };
}

/**
 * Whether an engine attempt may be admitted to a named task kind
 * ("critic" | "pr" | "merge" | "release"). Refuses to resolve an unknown
 * task kind rather than defaulting it to admitted — an unrecognized kind is
 * exactly the case where nothing has checked what the engine can do.
 * @param {object} o
 * @param {string[]} o.engineCapabilities - What this engine attempt can do.
 * @param {string} o.taskKind - One of the keys in {@link TASK_KIND_REQUIREMENTS}.
 * @returns {{admitted: boolean, missingCapabilities: string[], requiredCapabilities: string[]}}
 */
function admitTask({ engineCapabilities, taskKind }) {
  const requiredCapabilities = TASK_KIND_REQUIREMENTS[taskKind];
  _need(requiredCapabilities !== undefined, `taskKind must be one of ${Object.keys(TASK_KIND_REQUIREMENTS).join(', ')}`);
  const { admitted, missingCapabilities } = admit({ engineCapabilities, requiredCapabilities });
  return { admitted, missingCapabilities, requiredCapabilities: [...requiredCapabilities] };
}

// ── Attested rotation ──

/**
 * Validate a rotation record's shape and stage-appropriate fields.
 * @param {*} r - Candidate.
 * @returns {void}
 * @throws {AdmissionError}
 */
function validateRotationRecord(r) {
  _needShape(r, 'rotation', [
    'schema', 'rotationId', 'resourceId', 'oldAttemptId', 'oldEpoch', 'nextEpoch', 'checkpoint', 'stage', 'createdAt', 'updatedAt'
  ], ['newAttemptId', 'attestation', 'abandonedReason']);
  _need(r.schema === SCHEMA, `rotation.schema must be ${SCHEMA}`);
  _needId(r.rotationId, 'rotation.rotationId');
  _needId(r.resourceId, 'rotation.resourceId');
  _needId(r.oldAttemptId, 'rotation.oldAttemptId');
  _need(Number.isInteger(r.oldEpoch) && r.oldEpoch >= 0, 'rotation.oldEpoch must be a non-negative integer');
  _need(r.nextEpoch === r.oldEpoch + 1, 'rotation.nextEpoch must be rotation.oldEpoch + 1');
  _needShape(r.checkpoint, 'rotation.checkpoint', ['wipSummary', 'checkoutDigest', 'worktreeDigest', 'stateDigest']);
  _need(typeof r.checkpoint.wipSummary === 'string' && r.checkpoint.wipSummary.length <= 4000, 'rotation.checkpoint.wipSummary must be a string');
  _needDigest(r.checkpoint.checkoutDigest, 'rotation.checkpoint.checkoutDigest');
  _needDigest(r.checkpoint.worktreeDigest, 'rotation.checkpoint.worktreeDigest');
  _needDigest(r.checkpoint.stateDigest, 'rotation.checkpoint.stateDigest');
  _need(Object.values(STAGES).includes(r.stage), `rotation.stage must be one of ${Object.values(STAGES).join(', ')}`);
  _needEpochMs(r.createdAt, 'rotation.createdAt');
  _needEpochMs(r.updatedAt, 'rotation.updatedAt');

  const stageIndex = [STAGES.PREPARED, STAGES.QUIESCED, STAGES.REVOKED, STAGES.ATTESTED, STAGES.ACTIVE].indexOf(r.stage);
  const reachedAttested = stageIndex >= [STAGES.PREPARED, STAGES.QUIESCED, STAGES.REVOKED, STAGES.ATTESTED, STAGES.ACTIVE].indexOf(STAGES.ATTESTED);
  if (r.stage === STAGES.ATTESTED || r.stage === STAGES.ACTIVE) {
    _need(r.newAttemptId !== undefined, `rotation.newAttemptId is required once rotation.stage reaches "${STAGES.ATTESTED}"`);
    _needId(r.newAttemptId, 'rotation.newAttemptId');
    _need(r.attestation !== undefined, `rotation.attestation is required once rotation.stage reaches "${STAGES.ATTESTED}"`);
    _needShape(r.attestation, 'rotation.attestation', ['checkoutDigest', 'worktreeDigest', 'stateDigest', 'attestedAt']);
    _needDigest(r.attestation.checkoutDigest, 'rotation.attestation.checkoutDigest');
    _needDigest(r.attestation.worktreeDigest, 'rotation.attestation.worktreeDigest');
    _needDigest(r.attestation.stateDigest, 'rotation.attestation.stateDigest');
    _needEpochMs(r.attestation.attestedAt, 'rotation.attestation.attestedAt');
  } else {
    _need(r.newAttemptId === undefined, `rotation.newAttemptId may only be set once rotation.stage reaches "${STAGES.ATTESTED}"`);
    _need(r.attestation === undefined, `rotation.attestation may only be set once rotation.stage reaches "${STAGES.ATTESTED}"`);
  }
  if (r.stage === STAGES.ABANDONED) {
    _need(typeof r.abandonedReason === 'string' && r.abandonedReason.trim().length > 0, 'rotation.abandonedReason must be a non-empty string once rotation.stage is "abandoned"');
  } else {
    _need(r.abandonedReason === undefined, 'rotation.abandonedReason may only be set once rotation.stage is "abandoned"');
  }
  void reachedAttested;
}

/**
 * Begin a rotation: record the old attempt's checkpoint and assign the next
 * epoch. Nothing about the old attempt is touched yet — this step is pure
 * bookkeeping that the later steps act on.
 * @param {object} o
 * @param {string} o.rotationId - Caller-chosen identifier for this rotation.
 * @param {string} o.resourceId - What is being rotated (a task, session, or publication lease id).
 * @param {string} o.oldAttemptId - The engine attempt being replaced.
 * @param {number} o.oldEpoch - The old attempt's current epoch.
 * @param {{wipSummary: string, checkoutDigest: string, worktreeDigest: string, stateDigest: string}} o.checkpoint -
 *   The exact checkout/worktree/state the replacement must later attest against.
 * @param {object} [opts]
 * @param {number} [opts.now] - Current time in epoch ms; `Date.now()` when omitted.
 * @returns {object} The new rotation record, at stage `prepared`.
 */
function prepareRotation({ rotationId, resourceId, oldAttemptId, oldEpoch, checkpoint }, { now = Date.now() } = {}) {
  const record = {
    schema: SCHEMA,
    rotationId,
    resourceId,
    oldAttemptId,
    oldEpoch,
    nextEpoch: oldEpoch + 1,
    checkpoint,
    stage: STAGES.PREPARED,
    createdAt: now,
    updatedAt: now
  };
  validateRotationRecord(record);
  return record;
}

/**
 * Advance a record to the next stage, or to `abandoned`.
 * @param {object} record - Current rotation record.
 * @param {string} toStage - The stage to advance to.
 * @param {object} patch - Fields to merge in alongside the stage change.
 * @param {number} now - Current time in epoch ms.
 * @returns {object} The new record.
 * @throws {AdmissionError} When `toStage` is not reachable from the record's current stage.
 */
function _advance(record, toStage, patch, now) {
  _need(record.stage !== STAGES.ABANDONED, 'rotation is abandoned and cannot advance');
  if (toStage !== STAGES.ABANDONED) {
    _need(NEXT_STAGE[record.stage] === toStage, `rotation at stage "${record.stage}" cannot advance to "${toStage}" (expected "${NEXT_STAGE[record.stage]}")`);
  }
  const next = { ...record, ...patch, stage: toStage, updatedAt: now };
  validateRotationRecord(next);
  return next;
}

/**
 * Confirm the old attempt has stopped making new progress, its WIP already
 * preserved in the checkpoint recorded at {@link prepareRotation}.
 * @param {object} record - A record at stage `prepared`.
 * @param {object} [opts]
 * @param {number} [opts.now] - Current time in epoch ms.
 * @returns {object} The new record, at stage `quiesced`.
 */
function markQuiesced(record, { now = Date.now() } = {}) {
  return _advance(record, STAGES.QUIESCED, {}, now);
}

/**
 * Revoke the old attempt's publication lease and epoch. From this point on,
 * anything that still presents `oldEpoch` is stale and must be refused by
 * whatever gate checks epochs for this resource.
 * @param {object} record - A record at stage `quiesced`.
 * @param {object} [opts]
 * @param {number} [opts.now] - Current time in epoch ms.
 * @returns {object} The new record, at stage `revoked`.
 */
function revokeLease(record, { now = Date.now() } = {}) {
  return _advance(record, STAGES.REVOKED, {}, now);
}

/**
 * Attest the replacement attempt against the EXACT checkout, worktree and
 * state the checkpoint named. A mismatch refuses and leaves the record at
 * `revoked` — retryable once the replacement actually matches — rather than
 * advancing on a close-enough match.
 * @param {object} record - A record at stage `revoked`.
 * @param {object} o
 * @param {string} o.newAttemptId - The replacement engine attempt.
 * @param {string} o.checkoutDigest - The replacement's observed checkout digest.
 * @param {string} o.worktreeDigest - The replacement's observed worktree digest.
 * @param {string} o.stateDigest - The replacement's observed state digest.
 * @param {object} [opts]
 * @param {number} [opts.now] - Current time in epoch ms.
 * @returns {object} The new record, at stage `attested`.
 * @throws {AdmissionError} When any digest does not match the checkpoint recorded at `prepared`.
 */
function attestReplacement(record, { newAttemptId, checkoutDigest, worktreeDigest, stateDigest }, { now = Date.now() } = {}) {
  _need(record.stage === STAGES.REVOKED, `rotation must be at stage "${STAGES.REVOKED}" to attest (is "${record.stage}")`);
  _needId(newAttemptId, 'newAttemptId');
  _needDigest(checkoutDigest, 'checkoutDigest');
  _needDigest(worktreeDigest, 'worktreeDigest');
  _needDigest(stateDigest, 'stateDigest');
  const cp = record.checkpoint;
  const mismatches = [];
  if (!_digestsEqual(checkoutDigest, cp.checkoutDigest)) mismatches.push('checkoutDigest');
  if (!_digestsEqual(worktreeDigest, cp.worktreeDigest)) mismatches.push('worktreeDigest');
  if (!_digestsEqual(stateDigest, cp.stateDigest)) mismatches.push('stateDigest');
  _need(mismatches.length === 0, `replacement attestation does not match the checkpoint's recorded ${mismatches.join(', ')} — refusing to advance a stale or divergent checkout`);
  return _advance(record, STAGES.ATTESTED, {
    newAttemptId,
    attestation: { checkoutDigest, worktreeDigest, stateDigest, attestedAt: now }
  }, now);
}

/**
 * Constant-time comparison for digests, so this gate's own comparison is not
 * itself a timing side-channel on a value that may be security-sensitive.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _digestsEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Transfer authority to the replacement, exactly once.
 *
 * A compare-and-set: calling this again on an already-`active` record is a
 * no-op that returns the SAME record when it names the same `newAttemptId`
 * the record already transferred to (safe to retry after an uncertain
 * response), and a hard refusal when it names a different one (a second,
 * distinct transfer is never silently accepted).
 * @param {object} record - A record at stage `attested`, or already `active`.
 * @param {object} [opts]
 * @param {number} [opts.now] - Current time in epoch ms.
 * @returns {object} The new (or unchanged) record, at stage `active`.
 * @throws {AdmissionError} When the record is `active` under a different `newAttemptId`, or is at any other non-`attested` stage.
 */
function transferAuthority(record, { now = Date.now() } = {}) {
  if (record.stage === STAGES.ACTIVE) return record;
  return _advance(record, STAGES.ACTIVE, {}, now);
}

/**
 * Abandon a rotation (operator exit, or a failure with no retry planned).
 * Terminal: an abandoned rotation never advances again.
 * @param {object} record - Any non-abandoned rotation record.
 * @param {string} reason - Why it was abandoned.
 * @param {object} [opts]
 * @param {number} [opts.now] - Current time in epoch ms.
 * @returns {object} The new record, at stage `abandoned`.
 */
function abandonRotation(record, reason, { now = Date.now() } = {}) {
  _need(typeof reason === 'string' && reason.trim().length > 0, 'reason must be a non-empty string');
  return _advance(record, STAGES.ABANDONED, { abandonedReason: reason }, now);
}

/**
 * Where one rotation's record lives under a TangleClaw base directory.
 * @param {string} baseDir - The base directory (the store's base path).
 * @param {string} rotationId - Rotation identifier.
 * @returns {string}
 */
function rotationPath(baseDir, rotationId) {
  _needId(rotationId, 'rotationId');
  return path.join(baseDir, ROTATION_DIR, `${rotationId}.json`);
}

/**
 * Read a rotation record. Never throws for anything the file holds: a
 * caller deciding whether to retry a step must see whatever state the
 * ledger is actually in.
 * @param {string} file - Rotation record path.
 * @returns {{status: string, record?: object, reason?: string}}
 */
function readRotation(file) {
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { status: 'unreadable', reason: 'the rotation record is not a regular file' };
    if (st.size > MAX_BYTES) return { status: 'invalid', reason: `the rotation record is larger than ${MAX_BYTES} bytes` };
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing', reason: 'no rotation has been recorded for this id yet' };
    return { status: 'unreadable', reason: `the rotation record could not be read (${err.code || 'error'})` };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { status: 'invalid', reason: 'the rotation record is not valid JSON' };
  }
  try {
    validateRotationRecord(record);
  } catch (err) {
    if (!(err instanceof AdmissionError)) throw err;
    return { status: 'invalid', reason: err.message };
  }
  return { status: 'ok', record };
}

/**
 * Replace a rotation record atomically.
 * @param {string} file - Rotation record path.
 * @param {object} record - The rotation record.
 * @returns {void}
 * @throws {AdmissionError} When the record does not match the schema.
 */
function writeRotation(file, record) {
  validateRotationRecord(record);
  const body = JSON.stringify(record, null, 2) + '\n';
  if (Buffer.byteLength(body) > MAX_BYTES) throw new AdmissionError(`rotation record is larger than ${MAX_BYTES} bytes`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  stagedWrite.writeAtomic(file, body, STAGING_PREFIX);
}

module.exports = {
  SCHEMA,
  STAGES,
  NEXT_STAGE,
  KNOWN_CAPABILITIES,
  TASK_KIND_REQUIREMENTS,
  MAX_BYTES,
  AdmissionError,
  admit,
  admitTask,
  validateRotationRecord,
  prepareRotation,
  markQuiesced,
  revokeLease,
  attestReplacement,
  transferAuthority,
  abandonRotation,
  rotationPath,
  readRotation,
  writeRotation
};
