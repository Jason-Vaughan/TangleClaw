'use strict';

/**
 * The shared, engine-agnostic compatibility canary gate (#1897).
 *
 * LLM coding engines update independently of TangleClaw, and several ship with
 * automatic updates enabled: a previously compatible install can cross an
 * integration boundary between two launches with no TangleClaw change at all
 * (Incident #1895). This module is the one state resolver every adapter
 * (Codex, Claude Code, Antigravity, Aider, OpenClaw, and future ones) feeds
 * its capability-contract probe results into, so "is this exact engine build
 * safe to launch" is decided once, the same way, everywhere.
 *
 * Every build resolves to exactly one of four states:
 *   - `verified`     the full contract passed for this exact engine build
 *   - `degraded`     a specifically verified safe fallback is available
 *   - `incompatible` a required contract capability failed
 *   - `unknown`      this build has not completed certification
 *
 * `unknown` is never silently treated as `verified` — {@link resolveCanaryState}
 * only ever returns `verified` when every required capability explicitly
 * passed, and {@link decideLaunchGate} only ever allows a launch on `unknown`
 * or `incompatible` through an explicit, recorded {@link applyOverride}, never
 * by inference. Adapters declare only their own capability probes; this
 * module owns resolution, evidence persistence and the override ledger, which
 * stay identical across every engine.
 *
 * Evidence is a small JSON document per (engine, exact build fingerprint),
 * written atomically (one reader never observes a partial write) and read
 * defensively (a page or gate renders whatever state the store is actually
 * in, never throwing on a missing or corrupt file) — the same discipline
 * `lib/scorecard-cache.js` uses for its own cached document.
 *
 * This module is deliberately silent on the remaining delivery slices named
 * in #1897 (exact-binary fingerprinting, the disposable canary runner, the
 * signed remote compatibility index, and the launch-gate HTTP wiring): it is
 * slice 1, "compatibility schema, persisted evidence, and state resolver",
 * the part `lib/engine-canary.js` + `lib/routes/engines-canary.js` can
 * deliver inside this car's file scope.
 *
 * @module lib/engine-canary
 */

const fs = require('node:fs');
const path = require('node:path');
const stagedWrite = require('./staged-write');

/** Schema tag of an evidence document. */
const SCHEMA = 'tc.engine-canary/v1';

/** Schema tag of an override record. */
const OVERRIDE_SCHEMA = 'tc.engine-canary-override/v1';

/** The four resolved states. Never add a fifth without updating every reader. */
const STATES = Object.freeze({
  VERIFIED: 'verified',
  DEGRADED: 'degraded',
  INCOMPATIBLE: 'incompatible',
  UNKNOWN: 'unknown'
});

/** What a single capability probe may report. */
const CAPABILITY_RESULTS = Object.freeze(['pass', 'fail', 'not-applicable']);

/** Directory the evidence store lives under, relative to a TangleClaw base directory. */
const EVIDENCE_DIR = 'engine-canary';

/** Prefix for this module's atomic-write staging files. */
const STAGING_PREFIX = '.engine-canary.';

/** An evidence document is small by construction; anything larger is not one. */
const MAX_BYTES = 64 * 1024;

/** Upper bound on how many capability probes one contract revision may carry. */
const MAX_CAPABILITIES = 200;

/** Engine/build identifiers are filesystem path segments: keep them boring. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What reading evidence found. Only `ok` and `stale` carry a document. */
const READ_STATUS = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  UNREADABLE: 'unreadable',
  INVALID: 'invalid'
});

/** Error for a document that does not match a schema here. Never echoes raw input in the message. */
class CanaryError extends Error {}

/**
 * Refuse unless `cond` holds.
 * @param {boolean} cond - The check.
 * @param {string} msg - Reader-facing reason.
 * @returns {void}
 */
function _need(cond, msg) {
  if (!cond) throw new CanaryError(msg);
}

/**
 * Require a plain object carrying exactly the given keys.
 * @param {*} obj - Candidate.
 * @param {string} where - Its path, for the reason.
 * @param {string[]} required - Keys it must have.
 * @param {string[]} [optional] - Keys it may have.
 * @returns {void}
 */
function _needShape(obj, where, required, optional = []) {
  _need(obj !== null && typeof obj === 'object' && !Array.isArray(obj), `${where} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) _need(allowed.has(key), `${where} has unknown key "${key.slice(0, 40)}"`);
  for (const key of required) _need(obj[key] !== undefined, `${where}.${key} is missing`);
}

/**
 * Require a short identifier safe to use as a path segment.
 * @param {*} s - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needId(s, where) {
  _need(typeof s === 'string' && ID_RE.test(s), `${where} must be 1-128 characters of letters, digits, ".", "_" or "-", starting with a letter or digit`);
}

/**
 * Require epoch milliseconds.
 * @param {*} n - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needEpochMs(n, where) {
  _need(Number.isInteger(n) && n >= 0, `${where} must be epoch milliseconds`);
}

/**
 * Validate one capability probe result.
 * @param {*} c - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needCapability(c, where) {
  _needShape(c, where, ['id', 'result'], ['detail']);
  _needId(c.id, `${where}.id`);
  _need(CAPABILITY_RESULTS.includes(c.result), `${where}.result must be one of ${CAPABILITY_RESULTS.join(', ')}`);
  if (c.detail !== undefined) _need(typeof c.detail === 'string' && c.detail.length <= 500, `${where}.detail must be a string of at most 500 characters`);
}

/**
 * Validate the engine identity block.
 * @param {*} engine - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needEngine(engine, where) {
  _needShape(engine, where, ['id', 'executablePath', 'version', 'buildFingerprint']);
  _needId(engine.id, `${where}.id`);
  _need(typeof engine.executablePath === 'string' && engine.executablePath.length > 0 && engine.executablePath.length <= 1024, `${where}.executablePath must be a non-empty string`);
  _need(typeof engine.version === 'string' && engine.version.length > 0 && engine.version.length <= 128, `${where}.version must be a non-empty string`);
  _needId(engine.buildFingerprint, `${where}.buildFingerprint`);
}

/**
 * Validate an override record, standalone (not yet attached to a document).
 *
 * Every field the issue requires the UI to show is required here too, so an
 * override can never be persisted without the risk it waives, the version an
 * operator can fall back to, and the exact command to do it.
 * @param {*} o - Candidate.
 * @param {string} [where] - Its path.
 * @returns {void}
 */
function validateOverride(o, where = 'override') {
  _needShape(o, where, ['schema', 'actor', 'acknowledgedRisk', 'reason', 'lastVerifiedVersion', 'rollbackCommand', 'at']);
  _need(o.schema === OVERRIDE_SCHEMA, `${where}.schema must be ${OVERRIDE_SCHEMA}`);
  _need(typeof o.actor === 'string' && o.actor.trim().length > 0 && o.actor.length <= 200, `${where}.actor must be a non-empty string`);
  _need(o.acknowledgedRisk === true, `${where}.acknowledgedRisk must be true — an override that does not name the risk it is waiving is not recorded`);
  _need(typeof o.reason === 'string' && o.reason.trim().length > 0 && o.reason.length <= 2000, `${where}.reason must be a non-empty string`);
  _need(o.lastVerifiedVersion === null || (typeof o.lastVerifiedVersion === 'string' && o.lastVerifiedVersion.length <= 128), `${where}.lastVerifiedVersion must be a string or null`);
  _need(typeof o.rollbackCommand === 'string' && o.rollbackCommand.length <= 2000, `${where}.rollbackCommand must be a string (may be empty when none applies)`);
  _needEpochMs(o.at, `${where}.at`);
}

/**
 * Validate a full evidence document.
 * @param {*} doc - Candidate.
 * @returns {void}
 * @throws {CanaryError} When the document does not match the schema.
 */
function validateEvidenceDoc(doc) {
  _needShape(doc, 'evidence', [
    'schema', 'engine', 'contractRevision', 'capabilities', 'state', 'verifiedAt', 'tangleclawVersion', 'platform'
  ], ['degradedFallback', 'override']);
  _need(doc.schema === SCHEMA, `evidence.schema must be ${SCHEMA}`);
  _needEngine(doc.engine, 'evidence.engine');
  _need(Number.isInteger(doc.contractRevision) && doc.contractRevision >= 1, 'evidence.contractRevision must be a positive integer');
  _need(Array.isArray(doc.capabilities) && doc.capabilities.length <= MAX_CAPABILITIES, `evidence.capabilities must be an array of at most ${MAX_CAPABILITIES} entries`);
  doc.capabilities.forEach((c, i) => _needCapability(c, `evidence.capabilities[${i}]`));
  _need(Object.values(STATES).includes(doc.state), `evidence.state must be one of ${Object.values(STATES).join(', ')}`);
  _needEpochMs(doc.verifiedAt, 'evidence.verifiedAt');
  _need(typeof doc.tangleclawVersion === 'string' && doc.tangleclawVersion.length <= 64, 'evidence.tangleclawVersion must be a string');
  _need(typeof doc.platform === 'string' && doc.platform.length <= 128, 'evidence.platform must be a string');
  if (doc.state === STATES.DEGRADED) {
    _need(doc.degradedFallback !== undefined && doc.degradedFallback !== null, 'evidence.degradedFallback is required when evidence.state is "degraded"');
    _needShape(doc.degradedFallback, 'evidence.degradedFallback', ['version', 'note']);
    _need(typeof doc.degradedFallback.version === 'string' && doc.degradedFallback.version.length > 0, 'evidence.degradedFallback.version must be a non-empty string');
    _need(typeof doc.degradedFallback.note === 'string' && doc.degradedFallback.note.length <= 500, 'evidence.degradedFallback.note must be a string');
  } else if (doc.degradedFallback !== undefined) {
    throw new CanaryError('evidence.degradedFallback may only be set when evidence.state is "degraded"');
  }
  if (doc.override !== undefined && doc.override !== null) validateOverride(doc.override, 'evidence.override');
}

/**
 * Decide the compatibility state for one engine build from its capability
 * probe results. Pure and deterministic: the same inputs always resolve the
 * same state, and nothing here reaches a file or a clock.
 *
 * `unknown` is the default for anything this function cannot positively
 * clear as `verified` or `degraded`, or positively refuse as `incompatible`
 * — a missing or not-yet-run required probe is `unknown`, never `verified`.
 * @param {object} o
 * @param {{id: string, result: ('pass'|'fail'|'not-applicable')}[]} o.capabilities - Every probe that ran.
 * @param {string[]} o.requiredCapabilityIds - The capability ids the shared
 *   contract (#1897's ten-point list, as the adapter maps it to its own probe
 *   ids) requires for `verified`.
 * @param {{version: string, note: string}|null} [o.degradedFallback] - A
 *   specifically verified safe fallback, when the adapter has one for this
 *   exact failure shape. Only consulted when at least one required
 *   capability failed and the rest passed.
 * @returns {{state: string, failedCapabilityIds: string[], missingCapabilityIds: string[]}}
 */
function resolveCanaryState({ capabilities, requiredCapabilityIds, degradedFallback = null }) {
  _need(Array.isArray(capabilities), 'capabilities must be an array');
  _need(Array.isArray(requiredCapabilityIds), 'requiredCapabilityIds must be an array');
  const byId = new Map(capabilities.map((c) => [c.id, c.result]));
  const failedCapabilityIds = [];
  const missingCapabilityIds = [];
  for (const id of requiredCapabilityIds) {
    const result = byId.get(id);
    if (result === undefined) missingCapabilityIds.push(id);
    else if (result === 'fail') failedCapabilityIds.push(id);
  }

  if (failedCapabilityIds.length > 0) {
    if (missingCapabilityIds.length === 0 && degradedFallback) {
      return { state: STATES.DEGRADED, failedCapabilityIds, missingCapabilityIds };
    }
    return { state: STATES.INCOMPATIBLE, failedCapabilityIds, missingCapabilityIds };
  }
  if (missingCapabilityIds.length > 0) {
    return { state: STATES.UNKNOWN, failedCapabilityIds, missingCapabilityIds };
  }
  return { state: STATES.VERIFIED, failedCapabilityIds, missingCapabilityIds };
}

/**
 * Where one engine build's evidence lives under a TangleClaw base directory.
 * @param {string} baseDir - The base directory (the store's base path).
 * @param {string} engineId - Engine identifier (e.g. "codex").
 * @param {string} buildFingerprint - Exact build fingerprint.
 * @returns {string}
 */
function evidencePath(baseDir, engineId, buildFingerprint) {
  _needId(engineId, 'engineId');
  _needId(buildFingerprint, 'buildFingerprint');
  return path.join(baseDir, EVIDENCE_DIR, engineId, `${buildFingerprint}.json`);
}

/**
 * The directory holding every recorded build for one engine.
 * @param {string} baseDir - The base directory.
 * @param {string} engineId - Engine identifier.
 * @returns {string}
 */
function evidenceEngineDir(baseDir, engineId) {
  _needId(engineId, 'engineId');
  return path.join(baseDir, EVIDENCE_DIR, engineId);
}

/**
 * Read one evidence document and say what was found. Never throws for
 * anything the file holds: a launch gate or a page must act on whatever
 * state the store is actually in.
 * @param {string} file - Evidence file path.
 * @returns {{status: string, doc?: object, reason?: string}}
 */
function readEvidence(file) {
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { status: READ_STATUS.UNREADABLE, reason: 'the evidence record is not a regular file' };
    if (st.size > MAX_BYTES) return { status: READ_STATUS.INVALID, reason: `the evidence record is larger than ${MAX_BYTES} bytes` };
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: READ_STATUS.MISSING, reason: 'no evidence has been recorded for this exact build yet' };
    return { status: READ_STATUS.UNREADABLE, reason: `the evidence record could not be read (${err.code || 'error'})` };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { status: READ_STATUS.INVALID, reason: 'the evidence record is not valid JSON' };
  }
  try {
    validateEvidenceDoc(doc);
  } catch (err) {
    if (!(err instanceof CanaryError)) throw err;
    return { status: READ_STATUS.INVALID, reason: err.message };
  }
  return { status: READ_STATUS.OK, doc };
}

/**
 * Replace one build's evidence atomically: a reader sees either the previous
 * record or the complete new one, never a partial write.
 * @param {string} file - Evidence file path.
 * @param {object} doc - The evidence document.
 * @returns {void}
 * @throws {CanaryError} When the document does not match the schema.
 */
function writeEvidence(file, doc) {
  validateEvidenceDoc(doc);
  const body = JSON.stringify(doc, null, 2) + '\n';
  if (Buffer.byteLength(body) > MAX_BYTES) throw new CanaryError(`evidence record is larger than ${MAX_BYTES} bytes`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  stagedWrite.writeAtomic(file, body, STAGING_PREFIX);
}

/**
 * Every build recorded for one engine, newest first, each read the same
 * defensive way {@link readEvidence} reads one.
 * @param {string} baseDir - The base directory.
 * @param {string} engineId - Engine identifier.
 * @returns {{buildFingerprint: string, status: string, doc?: object, reason?: string}[]}
 */
function listEvidenceForEngine(baseDir, engineId) {
  const dir = evidenceEngineDir(baseDir, engineId);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const rows = names
    .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    .map((n) => {
      const buildFingerprint = n.slice(0, -'.json'.length);
      const read = readEvidence(path.join(dir, n));
      return { buildFingerprint, ...read };
    });
  rows.sort((a, b) => (b.doc?.verifiedAt || 0) - (a.doc?.verifiedAt || 0));
  return rows;
}

/**
 * Attach an explicit, recorded override to an existing evidence document.
 *
 * Refuses when no evidence exists yet for this build (there is nothing to
 * override — the operator is not acknowledging a risk they have not been
 * shown) and refuses an override missing any of the fields the issue
 * requires the UI to carry. The document's own `state` is left untouched:
 * the override is recorded alongside it, never collapsed into it, so a
 * reader always sees both what was resolved and that it was overridden.
 * @param {string} file - Evidence file path.
 * @param {{actor: string, acknowledgedRisk: true, reason: string, lastVerifiedVersion: (string|null), rollbackCommand: string}} overrideInput -
 *   Everything but `schema` and `at`, which this function fills in.
 * @param {object} [opts]
 * @param {number} [opts.now] - Current time in epoch ms; `Date.now()` when omitted.
 * @returns {object} The updated evidence document.
 * @throws {CanaryError} When no evidence exists yet, or the override is incomplete.
 */
function applyOverride(file, overrideInput, { now = Date.now() } = {}) {
  const read = readEvidence(file);
  _need(read.status === READ_STATUS.OK, `cannot override: ${read.reason || 'no valid evidence exists for this build yet'}`);
  const override = { schema: OVERRIDE_SCHEMA, at: now, ...overrideInput };
  validateOverride(override);
  const doc = { ...read.doc, override };
  writeEvidence(file, doc);
  return doc;
}

/**
 * Whether a recorded evidence document currently carries a valid override.
 * @param {object} doc - An evidence document.
 * @returns {boolean}
 */
function isOverridden(doc) {
  return doc != null && doc.override != null;
}

/**
 * Decide whether a launch may proceed for this exact evidence, and build the
 * refusal the issue's "Launch and UI behavior" section asks for when it may
 * not.
 *
 * `verified` and `degraded` always allow. `incompatible` and `unknown` allow
 * ONLY when the document carries a valid, explicit override — never by
 * inferring intent from anything else, which is the one invariant this whole
 * module exists to hold.
 * @param {object} o
 * @param {object} o.evidenceDoc - This exact build's evidence document.
 * @param {object|null} [o.lastVerifiedEvidence] - The most recent `verified`
 *   evidence document for this engine, if any, used to fill the refusal's
 *   "latest verified version" and rollback guidance.
 * @returns {{allowed: boolean, state: string, overridden: boolean, refusal: (object|null)}}
 */
function decideLaunchGate({ evidenceDoc, lastVerifiedEvidence = null }) {
  const overridden = isOverridden(evidenceDoc);
  const blocking = evidenceDoc.state === STATES.INCOMPATIBLE || evidenceDoc.state === STATES.UNKNOWN;
  const allowed = !blocking || overridden;
  if (allowed) return { allowed: true, state: evidenceDoc.state, overridden, refusal: null };

  const failedCapabilityIds = evidenceDoc.capabilities.filter((c) => c.result === 'fail').map((c) => c.id);
  const requiredIds = new Set(evidenceDoc.capabilities.map((c) => c.id));
  const certifiedIds = new Set(evidenceDoc.capabilities.filter((c) => c.result !== 'not-applicable').map((c) => c.id));
  // Anything required by the contract revision but absent from THIS document's
  // own capability list cannot be named here — this function only sees what
  // the evidence recorded, never a contract definition. Callers that know the
  // contract's full id list may merge those in; this refusal names only what
  // was observed and failed.
  void requiredIds;
  void certifiedIds;

  return {
    allowed: false,
    state: evidenceDoc.state,
    overridden,
    refusal: {
      detectedVersion: evidenceDoc.engine.version,
      detectedBuildFingerprint: evidenceDoc.engine.buildFingerprint,
      latestVerifiedVersion: lastVerifiedEvidence ? lastVerifiedEvidence.engine.version : null,
      failedCapabilityIds,
      unknownCapabilityIds: [],
      rollbackCommand: lastVerifiedEvidence?.override?.rollbackCommand || null,
      evidenceRef: { engine: evidenceDoc.engine.id, buildFingerprint: evidenceDoc.engine.buildFingerprint }
    }
  };
}

module.exports = {
  SCHEMA,
  OVERRIDE_SCHEMA,
  STATES,
  CAPABILITY_RESULTS,
  READ_STATUS,
  MAX_BYTES,
  MAX_CAPABILITIES,
  CanaryError,
  validateEvidenceDoc,
  validateOverride,
  resolveCanaryState,
  evidencePath,
  evidenceEngineDir,
  readEvidence,
  writeEvidence,
  listEvidenceForEngine,
  applyOverride,
  isOverridden,
  decideLaunchGate
};
