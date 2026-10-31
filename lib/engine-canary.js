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
 * `unknown` is never silently treated as `verified`, and the decision is
 * never taken on the strength of a stored word alone:
 *
 * - {@link resolveCanaryState} only ever returns `verified` when every
 *   required capability explicitly reported `pass` — an absent probe or an
 *   explicit `not-applicable` on a REQUIRED capability is `unknown`, never
 *   `verified` (PRR-B R1 Finding 1), and a non-empty `requiredCapabilityIds`
 *   is mandatory: a contract that requires nothing cannot resolve anything.
 * - `degraded` requires a fallback that is both capability-specific (its
 *   `coversCapabilityIds` must be a superset of what actually failed) and
 *   evidence-bound: {@link writeEvidence} and {@link readEvidence} both
 *   refuse a `degraded` document whose `degradedFallback.verifiedBuildFingerprint`
 *   does not name a build whose OWN recorded evidence is itself `verified`
 *   (PRR-B R1 Finding 3) — a truthy fallback object is never enough.
 * - {@link validateEvidenceDoc} recomputes the state from the document's own
 *   `capabilities` + `requiredCapabilityIds` + `degradedFallback` and refuses
 *   a document whose persisted `state` disagrees (PRR-B R1 Finding 2) — a
 *   stored `verified` can never coexist with a failed required capability.
 * - {@link decideLaunchGate} does the same recomputation itself rather than
 *   trusting `evidenceDoc.state`, and refuses outright (never waved through
 *   by an override recorded for a different build) when the caller names
 *   the build it expects and the evidence is for a different one.
 *
 * Adapters declare only their own capability probes; this module owns
 * resolution, evidence persistence and the override ledger, which stay
 * identical across every engine.
 *
 * Evidence is a small JSON document per (engine, exact build fingerprint),
 * written atomically (one reader never observes a partial write) and read
 * defensively (a page or gate renders whatever state the store is actually
 * in, never throwing on a missing or corrupt file) — the same discipline
 * `lib/scorecard-cache.js` uses for its own cached document.
 *
 * This module is deliberately silent on the remaining delivery slices named
 * in #1897 (exact-binary fingerprinting, the disposable canary runner, the
 * signed remote compatibility index): it is slice 1, "compatibility schema,
 * persisted evidence, and state resolver". `lib/routes/engines-canary.js` is
 * the HTTP surface over it, mounted in `server.js`.
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

/** What reading evidence found. Only `ok` carries a document. */
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
 * Validate a full evidence document, including that its persisted `state`
 * actually matches what its own `capabilities` + `requiredCapabilityIds` +
 * `degradedFallback` resolve to (PRR-B R1 Finding 2) — a document is never
 * accepted on the strength of its `state` field alone.
 * @param {*} doc - Candidate.
 * @returns {void}
 * @throws {CanaryError} When the document does not match the schema, or its
 *   persisted state disagrees with its own evidence.
 */
function validateEvidenceDoc(doc) {
  _needShape(doc, 'evidence', [
    'schema', 'engine', 'contractRevision', 'capabilities', 'requiredCapabilityIds', 'state', 'verifiedAt', 'tangleclawVersion', 'platform'
  ], ['degradedFallback', 'override']);
  _need(doc.schema === SCHEMA, `evidence.schema must be ${SCHEMA}`);
  _needEngine(doc.engine, 'evidence.engine');
  _need(Number.isInteger(doc.contractRevision) && doc.contractRevision >= 1, 'evidence.contractRevision must be a positive integer');
  _need(Array.isArray(doc.capabilities) && doc.capabilities.length <= MAX_CAPABILITIES, `evidence.capabilities must be an array of at most ${MAX_CAPABILITIES} entries`);
  doc.capabilities.forEach((c, i) => _needCapability(c, `evidence.capabilities[${i}]`));
  _need(Array.isArray(doc.requiredCapabilityIds) && doc.requiredCapabilityIds.length > 0 && doc.requiredCapabilityIds.length <= MAX_CAPABILITIES,
    `evidence.requiredCapabilityIds must be a non-empty array of at most ${MAX_CAPABILITIES} entries — a contract that requires nothing cannot resolve anything`);
  doc.requiredCapabilityIds.forEach((id, i) => _needId(id, `evidence.requiredCapabilityIds[${i}]`));
  _need(Object.values(STATES).includes(doc.state), `evidence.state must be one of ${Object.values(STATES).join(', ')}`);
  _needEpochMs(doc.verifiedAt, 'evidence.verifiedAt');
  _need(typeof doc.tangleclawVersion === 'string' && doc.tangleclawVersion.length <= 64, 'evidence.tangleclawVersion must be a string');
  _need(typeof doc.platform === 'string' && doc.platform.length <= 128, 'evidence.platform must be a string');

  let degradedFallback = null;
  if (doc.state === STATES.DEGRADED) {
    _need(doc.degradedFallback !== undefined && doc.degradedFallback !== null, 'evidence.degradedFallback is required when evidence.state is "degraded"');
    _needShape(doc.degradedFallback, 'evidence.degradedFallback', ['version', 'note', 'coversCapabilityIds', 'verifiedBuildFingerprint']);
    _need(typeof doc.degradedFallback.version === 'string' && doc.degradedFallback.version.length > 0, 'evidence.degradedFallback.version must be a non-empty string');
    _need(typeof doc.degradedFallback.note === 'string' && doc.degradedFallback.note.length <= 500, 'evidence.degradedFallback.note must be a string');
    _need(Array.isArray(doc.degradedFallback.coversCapabilityIds) && doc.degradedFallback.coversCapabilityIds.length > 0,
      'evidence.degradedFallback.coversCapabilityIds must be a non-empty array naming exactly which required capabilities this fallback is verified safe for');
    doc.degradedFallback.coversCapabilityIds.forEach((id, i) => _needId(id, `evidence.degradedFallback.coversCapabilityIds[${i}]`));
    _needId(doc.degradedFallback.verifiedBuildFingerprint, 'evidence.degradedFallback.verifiedBuildFingerprint');
    degradedFallback = doc.degradedFallback;
  } else if (doc.degradedFallback !== undefined) {
    throw new CanaryError('evidence.degradedFallback may only be set when evidence.state is "degraded"');
  }
  if (doc.override !== undefined && doc.override !== null) validateOverride(doc.override, 'evidence.override');

  // The cross-check: never accept a persisted `state` on its own word. A
  // hand-edited file, a stale write, or a caller that built the document by
  // hand rather than through `resolveCanaryState` must be refused here, not
  // discovered later by a launch gate that trusted it.
  const recomputed = resolveCanaryState({ capabilities: doc.capabilities, requiredCapabilityIds: doc.requiredCapabilityIds, degradedFallback });
  _need(recomputed.state === doc.state,
    `evidence.state is "${doc.state}" but its own capabilities and requiredCapabilityIds resolve to "${recomputed.state}" — refusing a document whose persisted state disagrees with its evidence`);
}

/**
 * Decide the compatibility state for one engine build from its capability
 * probe results. Pure and deterministic: the same inputs always resolve the
 * same state, and nothing here reaches a file or a clock.
 *
 * `unknown` is the default for anything this function cannot positively
 * clear as `verified` or `degraded`, or positively refuse as `incompatible`.
 * A required capability clears ONLY on an explicit `pass`: an absent probe
 * and an explicit `not-applicable` both count as not-yet-cleared for a
 * capability the contract requires (they differ for an OPTIONAL capability,
 * which this function never sees — only the required id list reaches it).
 * `degraded` requires a fallback that is both capability-specific (its
 * `coversCapabilityIds` must be a superset of what actually failed) and
 * leaves nothing missing; {@link writeEvidence}/{@link readEvidence} add the
 * evidence-binding half (the fallback's own build must itself be recorded
 * `verified`), which this pure function cannot check.
 * @param {object} o
 * @param {{id: string, result: ('pass'|'fail'|'not-applicable')}[]} o.capabilities - Every probe that ran.
 * @param {string[]} o.requiredCapabilityIds - The capability ids the shared
 *   contract (#1897's ten-point list, as the adapter maps it to its own probe
 *   ids) requires for `verified`. Must be non-empty: a contract requiring
 *   nothing cannot resolve anything.
 * @param {{coversCapabilityIds: string[]}|null} [o.degradedFallback] - A
 *   fallback naming exactly which required capabilities it is a verified
 *   safe path for. Only consulted when every required capability either
 *   passed or is named in `coversCapabilityIds`, and none is merely missing.
 * @returns {{state: string, failedCapabilityIds: string[], missingCapabilityIds: string[]}}
 * @throws {CanaryError} When `requiredCapabilityIds` is not a non-empty array.
 */
function resolveCanaryState({ capabilities, requiredCapabilityIds, degradedFallback = null }) {
  _need(Array.isArray(capabilities), 'capabilities must be an array');
  _need(Array.isArray(requiredCapabilityIds) && requiredCapabilityIds.length > 0,
    'requiredCapabilityIds must be a non-empty array — a contract that requires nothing cannot resolve to any state');
  const byId = new Map(capabilities.map((c) => [c.id, c.result]));
  const failedCapabilityIds = [];
  const missingCapabilityIds = [];
  for (const id of requiredCapabilityIds) {
    const result = byId.get(id);
    if (result === 'pass') continue;
    if (result === 'fail') failedCapabilityIds.push(id);
    else missingCapabilityIds.push(id); // absent, or explicitly 'not-applicable' — neither clears a REQUIRED capability
  }

  if (failedCapabilityIds.length > 0) {
    const covers = degradedFallback && Array.isArray(degradedFallback.coversCapabilityIds)
      ? new Set(degradedFallback.coversCapabilityIds)
      : null;
    if (missingCapabilityIds.length === 0 && covers && failedCapabilityIds.every((id) => covers.has(id))) {
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
 * Whether a `degraded` document's fallback is bound to real evidence: its
 * `verifiedBuildFingerprint` must name a DIFFERENT build (never itself) in
 * the same engine's evidence directory, whose own recorded evidence is
 * itself `verified`. Checked at both write time ({@link writeEvidence}) and
 * read time ({@link readEvidence}), so a fallback that was verified when
 * written but has since been superseded is refused when read, not just when
 * written (PRR-B R1 Finding 3).
 * @param {string} file - The evidence file this binding is being checked for.
 * @param {{verifiedBuildFingerprint: string}} degradedFallback
 * @returns {{ok: boolean, reason?: string}}
 */
function _degradedFallbackBinding(file, degradedFallback) {
  const fallbackFile = path.join(path.dirname(file), `${degradedFallback.verifiedBuildFingerprint}.json`);
  if (path.resolve(fallbackFile) === path.resolve(file)) {
    return { ok: false, reason: 'evidence.degradedFallback.verifiedBuildFingerprint must name a different build, never this one' };
  }
  // The fallback is always a build of the SAME engine (a build never falls
  // back to a different engine's evidence) — derived from the directory
  // `evidencePath` lays out, same as `fallbackFile` itself just was.
  const expectedEngineId = path.basename(path.dirname(file));
  const fallbackRead = readEvidence(fallbackFile, { expectedEngineId, expectedBuildFingerprint: degradedFallback.verifiedBuildFingerprint });
  if (fallbackRead.status === READ_STATUS.OK && fallbackRead.doc.state === STATES.VERIFIED) return { ok: true };
  return {
    ok: false,
    reason: `evidence.degradedFallback.verifiedBuildFingerprint ("${degradedFallback.verifiedBuildFingerprint}") must name a build whose own recorded evidence resolves to "verified" (found: ${fallbackRead.status})`
  };
}

/**
 * Read one evidence document and say what was found. Never throws for
 * anything the file holds: a launch gate or a page must act on whatever
 * state the store is actually in.
 *
 * When the caller knows which exact build it asked for — every real caller
 * does, since `file` itself was built from the same (engineId,
 * buildFingerprint) via {@link evidencePath} — pass it as `expectedEngineId`
 * / `expectedBuildFingerprint` so a document whose OWN recorded identity
 * disagrees with where it was found (a mislabeled or misplaced file) is
 * refused as `invalid` rather than trusted on the strength of its location
 * (PRR-B R2 Finding 2).
 * @param {string} file - Evidence file path.
 * @param {object} [opts]
 * @param {string|null} [opts.expectedEngineId] - The engine id this file is expected to hold evidence for.
 * @param {string|null} [opts.expectedBuildFingerprint] - The exact build fingerprint this file is expected to hold evidence for.
 * @returns {{status: string, doc?: object, reason?: string}}
 */
function readEvidence(file, { expectedEngineId = null, expectedBuildFingerprint = null } = {}) {
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
  if (expectedEngineId !== null && doc.engine.id !== expectedEngineId) {
    return { status: READ_STATUS.INVALID, reason: `evidence.engine.id ("${doc.engine.id}") does not match the engine ("${expectedEngineId}") this record was read for` };
  }
  if (expectedBuildFingerprint !== null && doc.engine.buildFingerprint !== expectedBuildFingerprint) {
    return { status: READ_STATUS.INVALID, reason: `evidence.engine.buildFingerprint ("${doc.engine.buildFingerprint}") does not match the build ("${expectedBuildFingerprint}") this record was read for` };
  }
  if (doc.state === STATES.DEGRADED) {
    const binding = _degradedFallbackBinding(file, doc.degradedFallback);
    if (!binding.ok) return { status: READ_STATUS.INVALID, reason: binding.reason };
  }
  return { status: READ_STATUS.OK, doc };
}

/**
 * Replace one build's evidence atomically: a reader sees either the previous
 * record or the complete new one, never a partial write.
 *
 * Refuses to persist a `degraded` document whose fallback is not bound to a
 * real `verified` build (same check {@link readEvidence} applies on the way
 * back out), so an unbound degraded claim can never even be written.
 * @param {string} file - Evidence file path.
 * @param {object} doc - The evidence document.
 * @returns {void}
 * @throws {CanaryError} When the document does not match the schema, or a
 *   `degraded` document's fallback is not bound to verified evidence.
 */
function writeEvidence(file, doc) {
  validateEvidenceDoc(doc);
  if (doc.state === STATES.DEGRADED) {
    const binding = _degradedFallbackBinding(file, doc.degradedFallback);
    _need(binding.ok, binding.reason);
  }
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
      const read = readEvidence(path.join(dir, n), { expectedEngineId: engineId, expectedBuildFingerprint: buildFingerprint });
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
 * @param {string|null} [opts.expectedEngineId] - The engine id this override is meant for; a document whose own identity disagrees is refused (PRR-B R2 Finding 2).
 * @param {string|null} [opts.expectedBuildFingerprint] - The exact build fingerprint this override is meant for; same refusal on disagreement.
 * @returns {object} The updated evidence document.
 * @throws {CanaryError} When no evidence exists yet, the override is incomplete, or the evidence's own identity disagrees with what was expected.
 */
function applyOverride(file, overrideInput, { now = Date.now(), expectedEngineId = null, expectedBuildFingerprint = null } = {}) {
  const read = readEvidence(file, { expectedEngineId, expectedBuildFingerprint });
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
 * Recomputes the state from `evidenceDoc`'s own `capabilities` +
 * `requiredCapabilityIds` + `degradedFallback` rather than trusting
 * `evidenceDoc.state` — the SAME binding {@link validateEvidenceDoc} enforces
 * at the storage boundary, applied again here so a decision is never taken
 * on a stored word alone, even if this function is handed a document that
 * never passed through {@link readEvidence} (PRR-B R1 Finding 2). A
 * malformed `requiredCapabilityIds` (missing or empty) is treated as
 * `unknown` rather than thrown, so this function itself never throws.
 *
 * `verified` and `degraded` always allow. `incompatible` and `unknown` allow
 * ONLY when the document carries a valid, explicit override — never by
 * inferring intent from anything else. When the caller names the exact
 * build it expects (`expectedEngineId` / `expectedBuildFingerprint`) and the
 * evidence is for a different one, the launch is refused outright: an
 * override recorded for one build must never be read as clearing another
 * (PRR-B R1 Finding 2's build-identity half).
 * @param {object} o
 * @param {object} o.evidenceDoc - This exact build's evidence document.
 * @param {object|null} [o.lastVerifiedEvidence] - The most recent `verified`
 *   evidence document for this engine, if any, used to fill the refusal's
 *   "latest verified version" and rollback guidance.
 * @param {string|null} [o.expectedEngineId] - The engine id the caller
 *   actually means to launch; a mismatch refuses regardless of state.
 * @param {string|null} [o.expectedBuildFingerprint] - The exact build
 *   fingerprint the caller actually means to launch; a mismatch refuses
 *   regardless of state.
 * @returns {{allowed: boolean, state: string, overridden: boolean, refusal: (object|null)}}
 */
function decideLaunchGate({ evidenceDoc, lastVerifiedEvidence = null, expectedEngineId = null, expectedBuildFingerprint = null }) {
  const identityMismatch = (expectedEngineId !== null && evidenceDoc.engine.id !== expectedEngineId)
    || (expectedBuildFingerprint !== null && evidenceDoc.engine.buildFingerprint !== expectedBuildFingerprint);

  let recomputed;
  try {
    recomputed = resolveCanaryState({
      capabilities: evidenceDoc.capabilities,
      requiredCapabilityIds: evidenceDoc.requiredCapabilityIds,
      degradedFallback: evidenceDoc.degradedFallback || null
    });
  } catch (err) {
    if (!(err instanceof CanaryError)) throw err;
    recomputed = { state: STATES.UNKNOWN, failedCapabilityIds: [], missingCapabilityIds: Array.isArray(evidenceDoc.requiredCapabilityIds) ? evidenceDoc.requiredCapabilityIds : [] };
  }
  const state = recomputed.state;
  const overridden = isOverridden(evidenceDoc);
  const blocking = identityMismatch || state === STATES.INCOMPATIBLE || state === STATES.UNKNOWN;
  // An identity mismatch is never waved through by an override recorded for
  // a DIFFERENT build — overridden alone cannot clear it.
  const allowed = !blocking || (overridden && !identityMismatch);
  if (allowed) return { allowed: true, state, overridden, refusal: null };

  return {
    allowed: false,
    state,
    overridden,
    refusal: {
      identityMismatch,
      detectedVersion: evidenceDoc.engine.version,
      detectedBuildFingerprint: evidenceDoc.engine.buildFingerprint,
      latestVerifiedVersion: lastVerifiedEvidence ? lastVerifiedEvidence.engine.version : null,
      failedCapabilityIds: recomputed.failedCapabilityIds,
      unknownCapabilityIds: recomputed.missingCapabilityIds,
      rollbackCommand: (evidenceDoc.override && evidenceDoc.override.rollbackCommand)
        || (lastVerifiedEvidence ? `Reinstall ${evidenceDoc.engine.id} ${lastVerifiedEvidence.engine.version}` : null),
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
