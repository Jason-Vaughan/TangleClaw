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
 *      changed yet; it is still the authorized publisher ({@link authorizePublisher}).
 *    - `quiesced`: the old attempt has stopped making new progress; its WIP
 *      is preserved in the checkpoint already recorded at `prepared`. No
 *      attempt is authorized to publish from here until `active`.
 *    - `revoked`: the old attempt's publication lease and epoch are
 *      EXPLICITLY revoked — `revokedAt` is recorded on the record itself,
 *      not merely implied by the stage name. From here on, anything that
 *      still presents the old epoch is stale.
 *    - `attested`: the replacement is checked against the EXACT checkout,
 *      worktree and state the checkpoint named — not merely that one exists.
 *      A mismatch refuses and leaves the record at `revoked`, retryable.
 *    - `active`: authority transfers to the replacement, exactly once.
 *      {@link transferAuthority} is a compare-and-set: a retry that repeats
 *      the same already-active attempt is a no-op: a retry naming a
 *      DIFFERENT attempt is refused outright, never silently accepted.
 *
 * Every transition validates the record's current stage explicitly and
 * returns a new record rather than mutating the one it was given. The
 * record also carries a monotonic `revision`, and {@link writeRotation}
 * enforces it as a compare-and-set against whatever is actually on disk: a
 * second writer that read the same prior revision and computed a DIFFERENT
 * next state is refused (PRR-B R1 Finding 4) rather than silently
 * overwriting the first writer's transition — the classic lost-update
 * race a bare `fs.writeFileSync` never guards against. A true idempotent
 * retry (the same revision, byte-identical content) is a no-op success.
 * {@link authorizePublisher} is the complementary read-side primitive: a
 * caller outside this module's own scope (the resource's actual write
 * path) asks it before honoring a write, so a stale attempt that still
 * presents its old (attemptId, epoch) is refused structurally rather than
 * merely by this record's own bookkeeping never being consulted.
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

/** Stages at and after `revoked`, where `revokedAt` must be set. */
const STAGES_AFTER_REVOCATION = Object.freeze([STAGES.REVOKED, STAGES.ATTESTED, STAGES.ACTIVE]);

/** Identifiers are filesystem path segments and log fields: keep them boring. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Suffix of the exclusive lock file {@link writeRotation} holds across its read-check-write critical section. */
const LOCK_SUFFIX = '.lock';

/** How long {@link writeRotation} retries acquiring the lock before giving up. */
const LOCK_TIMEOUT_MS = 5000;

/** Backoff between lock-acquisition attempts. */
const LOCK_RETRY_MS = 20;

/**
 * How old an unreleased lock file must be before a later writer may reclaim
 * it. This module's own critical section (a `stat`+`readFileSync` and a
 * `writeAtomic`) completes in low single-digit milliseconds, so a lock still
 * held after 30s did not survive its holder — the holder's process is gone,
 * not merely slow — and the alternative (never reclaiming) would let one
 * crashed writer wedge this rotation's record forever.
 */
const LOCK_STALE_MS = 30_000;

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
    'schema', 'rotationId', 'resourceId', 'oldAttemptId', 'oldEpoch', 'nextEpoch', 'checkpoint', 'stage', 'revision', 'createdAt', 'updatedAt'
  ], ['newAttemptId', 'attestation', 'abandonedReason', 'revokedAt']);
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
  _need(Number.isInteger(r.revision) && r.revision >= 1, 'rotation.revision must be a positive integer');
  _needEpochMs(r.createdAt, 'rotation.createdAt');
  _needEpochMs(r.updatedAt, 'rotation.updatedAt');

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
    if (r.revokedAt !== undefined) _needEpochMs(r.revokedAt, 'rotation.revokedAt');
  } else {
    _need(r.abandonedReason === undefined, 'rotation.abandonedReason may only be set once rotation.stage is "abandoned"');
    if (STAGES_AFTER_REVOCATION.includes(r.stage)) {
      _need(r.revokedAt !== undefined, `rotation.revokedAt is required once rotation.stage reaches "${STAGES.REVOKED}" — the old epoch's revocation must be explicit, not merely implied by the stage name`);
      _needEpochMs(r.revokedAt, 'rotation.revokedAt');
    } else {
      _need(r.revokedAt === undefined, `rotation.revokedAt may only be set once rotation.stage reaches "${STAGES.REVOKED}"`);
    }
  }
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
 * @returns {object} The new rotation record, at stage `prepared`, revision 1.
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
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
  validateRotationRecord(record);
  return record;
}

/**
 * Advance a record to the next stage, or to `abandoned`, incrementing its
 * revision.
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
  const next = { ...record, ...patch, stage: toStage, revision: record.revision + 1, updatedAt: now };
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
 * Revoke the old attempt's publication lease and epoch, EXPLICITLY: this
 * records `revokedAt` on the record itself (PRR-B R1 Finding 4), not merely
 * the stage name "revoked". From this point on, anything that still
 * presents `oldEpoch` is stale and must be refused by {@link authorizePublisher}
 * or whatever gate checks epochs for this resource.
 * @param {object} record - A record at stage `quiesced`.
 * @param {object} [opts]
 * @param {number} [opts.now] - Current time in epoch ms.
 * @returns {object} The new record, at stage `revoked`.
 */
function revokeLease(record, { now = Date.now() } = {}) {
  return _advance(record, STAGES.REVOKED, { revokedAt: now }, now);
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
 * Whether a presented `(attemptId, epoch)` pair is the one entitled to
 * publish right now, for the resource this record governs (PRR-B R1 Finding
 * 4's "active-publisher enforcement"). Pure: a caller outside this module's
 * own scope — the resource's actual write path — asks this before honoring
 * a write, so a stale attempt that still presents its old epoch is refused
 * structurally, rather than this record's own bookkeeping simply never
 * being consulted by whatever guards the resource.
 *
 * `prepared` is the only non-terminal stage where the OLD attempt is still
 * authorized: by `quiesced` it has (by contract) stopped making new
 * progress, and by `revoked` its epoch is explicitly dead. The NEW attempt
 * is authorized only once the record reaches `active` — never at
 * `attested`, which has checked identity but not yet transferred authority.
 * @param {object} record - A rotation record.
 * @param {{attemptId: string, epoch: number}} presented - What the caller claims.
 * @returns {{authorized: boolean, reason?: string}}
 */
function authorizePublisher(record, { attemptId, epoch }) {
  if (record.stage === STAGES.PREPARED) {
    if (attemptId === record.oldAttemptId && epoch === record.oldEpoch) return { authorized: true };
    return { authorized: false, reason: `only the old attempt ("${record.oldAttemptId}" at epoch ${record.oldEpoch}) may publish while the rotation is "${record.stage}"` };
  }
  if (record.stage === STAGES.ACTIVE) {
    if (attemptId === record.newAttemptId && epoch === record.nextEpoch) return { authorized: true };
    return { authorized: false, reason: `only the new attempt ("${record.newAttemptId}" at epoch ${record.nextEpoch}) may publish once the rotation is "${record.stage}"` };
  }
  // quiesced / revoked / attested: the old attempt has stopped by contract
  // and the new one has not yet been granted authority — nobody may publish
  // mid-rotation. abandoned: the rotation never completed, so nobody
  // inherited authority through it.
  return { authorized: false, reason: `no attempt may publish while the rotation is "${record.stage}"` };
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
 * The exclusive lock path for one rotation record, a sibling of the record
 * itself.
 * @param {string} file - Rotation record path.
 * @returns {string}
 */
function _lockPath(file) {
  return `${file}${LOCK_SUFFIX}`;
}

/**
 * A true synchronous sleep (not a busy-wait), the idiom this codebase
 * already uses for a sync retry backoff (`lib/bridge-handoff.js`,
 * `lib/release-certification/lockfile.js`, `lib/store.js`).
 * @param {number} ms
 * @returns {void}
 */
function _sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The lock file's content: who holds it, and the unique token that proves
 * it (PRR-B R3 Finding). `null` when the file is missing, empty, or not the
 * shape a holder writes — treated the same as "no identifiable holder",
 * never as this caller's own.
 * @param {string} lockPath - The lock file's path.
 * @returns {{pid: number, token: string}|null}
 */
function _readLockHolder(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Number.isInteger(parsed.pid) && typeof parsed.token === 'string' && parsed.token.length > 0) return parsed;
  } catch {
    // fall through — corrupt/unparseable reads as no identifiable holder
  }
  return null;
}

/**
 * Whether a pid names a process that is still alive, on THIS machine (this
 * module's locks are never expected to cross hosts — a rotation's old and
 * new attempts both act on the same local resource). `process.kill(pid, 0)`
 * sends no signal; it only probes existence/permission.
 * @param {number} pid
 * @returns {boolean}
 */
function _pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true; // no error: the process exists and we may signal it
  } catch (err) {
    if (err.code === 'ESRCH') return false; // definitively: no such process
    if (err.code === 'EPERM') return true; // exists, owned by someone else: still alive
    return true; // anything else is uncertain — never reclaim on uncertainty
  }
}

/**
 * Acquire the exclusive lock guarding one rotation record's read-check-write
 * critical section (PRR-B R2 Finding 1): `writeRotation`'s compare-and-set
 * is only as good as its ability to stop a SECOND writer from entering that
 * same section while the first is still inside it, including during its
 * own `writeAtomic` call — a plain read-then-write with no lock lets two
 * writers both pass the same predecessor check before either one's write
 * lands. `fs.openSync(lockPath, 'wx')` is exclusive-create: it throws
 * `EEXIST` for every caller but the one that actually created the file.
 *
 * A lock older than {@link LOCK_STALE_MS} is a CANDIDATE for reclamation,
 * never an automatic one (PRR-B R3 Finding): its content names the pid
 * that wrote it, and reclamation checks that pid is actually dead
 * (`process.kill(pid, 0)` throwing `ESRCH`) before unlinking — age alone
 * cannot tell a crashed holder from one merely slow (GC, disk I/O,
 * scheduling) past the staleness window, and only a confirmed-dead pid can.
 * A lock file that is itself corrupt or empty (no readable `{pid, token}`)
 * has no identifiable holder to confirm alive, so staleness by age alone
 * is what reclaims it.
 * @param {string} file - Rotation record path whose lock to acquire.
 * @param {number} [timeoutMs] - Overrides {@link LOCK_TIMEOUT_MS}; test-only
 *   (a production caller never needs a shorter wait than the default).
 * @returns {string} The unique token this acquisition wrote, to hand back to {@link _releaseLock}.
 * @throws {AdmissionError} When the lock cannot be acquired within the timeout.
 */
function _acquireLock(file, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockPath = _lockPath(file);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = crypto.randomUUID();
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(fd);
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let reclaim = false;
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        const holder = _readLockHolder(lockPath);
        reclaim = holder === null || !_pidAlive(holder.pid);
      }
    } catch (statErr) {
      if (statErr.code === 'ENOENT') continue; // released between our open() and stat(): retry immediately
      throw statErr;
    }
    if (reclaim) {
      try { fs.unlinkSync(lockPath); } catch (unlinkErr) { if (unlinkErr.code !== 'ENOENT') throw unlinkErr; }
      continue; // retry immediately — the slot may now be free
    }
    _need(Date.now() < deadline, `CAS: could not acquire the rotation lock within ${timeoutMs}ms — another writer is holding it`);
    _sleepSync(LOCK_RETRY_MS);
  }
}

/**
 * Release the lock {@link _acquireLock} took — but ONLY the one this exact
 * caller took (PRR-B R3 Finding): unlinking the lock path unconditionally
 * would delete whatever lock currently occupies it, which, after a
 * reclaim elsewhere, can be a DIFFERENT holder's live lock. The token
 * {@link _acquireLock} returned is the proof of ownership; a lock whose
 * recorded token does not match (or that is already gone, or unreadable)
 * is left untouched.
 *
 * Called from a `finally` guarding only the critical section AFTER a
 * successful acquire — never called when `_acquireLock` itself threw (a
 * timeout), which never wrote a lock this caller could own in the first
 * place.
 * @param {string} file - Rotation record path whose lock to release.
 * @param {string} token - The token {@link _acquireLock} returned.
 * @returns {void}
 */
function _releaseLock(file, token) {
  const lockPath = _lockPath(file);
  const holder = _readLockHolder(lockPath);
  if (holder === null || holder.token !== token) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Replace a rotation record, enforced as a compare-and-set against whatever
 * is actually on disk (PRR-B R1 Finding 4): revision 1 may only be written
 * where nothing is recorded yet, and revision N (N > 1) may only be written
 * where the on-disk record is still at revision N-1 for this SAME
 * `rotationId`. A write at the same revision as what is already on disk is
 * an idempotent no-op when the content is byte-identical (a safe retry
 * after an uncertain response), and a refusal otherwise (a concurrent
 * writer already claimed that revision with different content). Any other
 * mismatch — stale, out of order, or for a different rotation — refuses,
 * naming the on-disk revision so the caller re-reads and retries rather
 * than silently losing whichever writer went second.
 *
 * The read, the compare, and the write all happen while holding
 * {@link _acquireLock}'s exclusive lock on this exact file (PRR-B R2
 * Finding 1): the compare-and-set above is only as strong as the mutual
 * exclusion guarding it — without the lock, two writers can both pass the
 * same predecessor check (both reading the same on-disk revision) before
 * either one's `writeAtomic` call lands, which is a lost update no amount
 * of comparing revision NUMBERS prevents by itself.
 * @param {string} file - Rotation record path.
 * @param {object} record - The rotation record.
 * @param {object} [opts]
 * @param {number} [opts.lockTimeoutMs] - Overrides the default lock-acquisition timeout; test-only.
 * @returns {void}
 * @throws {AdmissionError} When the record does not match the schema, the
 *   compare-and-set fails, or the lock cannot be acquired in time.
 */
function writeRotation(file, record, { lockTimeoutMs } = {}) {
  validateRotationRecord(record);
  const lockToken = _acquireLock(file, lockTimeoutMs);
  try {
    const existing = readRotation(file);
    if (record.revision === 1) {
      _need(existing.status === 'missing', 'CAS: a rotation record already exists for this id; refusing to write revision 1 over it');
    } else {
      _need(existing.status === 'ok', `CAS: cannot verify the on-disk predecessor before writing revision ${record.revision} (on-disk status: ${existing.status}${existing.reason ? `, ${existing.reason}` : ''})`);
      _need(existing.record.rotationId === record.rotationId, 'CAS: the on-disk record is for a different rotationId');
      if (existing.record.revision === record.revision) {
        _need(JSON.stringify(existing.record) === JSON.stringify(record),
          `CAS: revision ${record.revision} is already recorded on disk with different content — a concurrent writer claimed it first; re-read and retry`);
        return; // idempotent retry of an already-persisted write: nothing to do
      }
      _need(existing.record.revision === record.revision - 1,
        `CAS: the on-disk record is at revision ${existing.record.revision}, not ${record.revision - 1} — someone else already advanced this rotation; re-read and retry`);
    }
    const body = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(body) > MAX_BYTES) throw new AdmissionError(`rotation record is larger than ${MAX_BYTES} bytes`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stagedWrite.writeAtomic(file, body, STAGING_PREFIX);
  } finally {
    _releaseLock(file, lockToken);
  }
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
  authorizePublisher,
  rotationPath,
  readRotation,
  writeRotation,
  _lockPath,
  _acquireLock,
  _releaseLock
};
