'use strict';

/**
 * Structured roadmap train dependencies and a durable admission decision
 * before dispatch (#1894).
 *
 * On 2026-09-26 the Roadmap Board correctly stated that #721 is a
 * prerequisite for #777, while Train 4 still presented #777 as an assembled
 * car and #777 also appeared as unmilestoned, and the PM offered Train 4 as
 * overnight-ready anyway: discovery existed but was never bound to
 * admission. This module is that binding, as a self-contained library: a
 * classifier that turns a train's declared dependencies into one of three
 * machine-readable verdicts, a manifest that records the exact facts a
 * classification rested on, and a dispatch-time re-check that refuses to
 * trust a manifest once the world underneath it has moved.
 *
 * The actual Roadmap Board, its editorial source (`roadmap2-data.json`) and
 * its generator live in a separate repository this checkout does not hold
 * and is read-only on (ADR 0024, `roadmap-board/RULES.md`). Nothing here
 * reads or writes that data; every function takes plain JS objects and
 * returns plain JS objects, for that other repository (or the PM/Architect
 * tooling around it) to wire up to its real data.
 *
 * Responsibility boundary (#1894's own wording): the PM assembles trains and
 * sequences dispatch; the Architect owns admission review when a candidate
 * crosses an architectural or reserved boundary; a plan with no such
 * question never routes through the Architect. This module encodes exactly
 * that split — {@link classifyTrain} decides whether a pause is even needed,
 * and {@link validateTrainDispatchAdmission} is the one place that checks
 * whether a pause that WAS needed actually happened.
 *
 * @module lib/roadmap-admission
 */

/** Error for admission input that does not match this module's contract, or a classification that fails validation outright (contradictory placement). */
class RoadmapAdmissionError extends Error {}

/**
 * Refuse unless `cond` holds.
 * @param {boolean} cond
 * @param {string} msg
 * @returns {void}
 */
function _need(cond, msg) {
  if (!cond) throw new RoadmapAdmissionError(msg);
}

function _needArrayOfStrings(v, where) {
  _need(Array.isArray(v), `${where} must be an array`);
  for (const s of v) _need(typeof s === 'string' && s.length > 0, `${where} entries must be non-empty strings`);
}

/** The reserved-action gate kinds #1894 names explicitly. A candidate may declare any string here — this list is what {@link _conditionalReasons} recognizes by name, not a closed enum this module enforces. */
const RESERVED_GATE_KINDS = Object.freeze(['release', 'restart', 'db', 'security']);

/** The three machine-readable verdicts {@link classifyTrain} returns. */
const CLASSIFICATIONS = Object.freeze({
  EXECUTABLE: 'executable',
  CONDITIONAL: 'conditionally-executable',
  BLOCKED: 'blocked'
});

/** The three admission-receipt decisions {@link validateTrainDispatchAdmission} understands. */
const DECISIONS = Object.freeze({ APPROVED: 'APPROVED', MODIFY: 'MODIFY', REJECTED: 'REJECTED' });

/** How long a built manifest's facts are trusted before dispatch must refuse it as expired, absent a tighter caller-supplied value. Roughly "after meaningful merges" per #1894 — a day is long enough to span a dispatch round-trip, short enough that a manifest never silently outlives a sprint. */
const DEFAULT_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Validate a train candidate's shape. Every field but `trainId`/`issues` is
 * optional — a train with none of them is simply one with nothing to review.
 * @param {object} candidate
 * @returns {void}
 * @throws {RoadmapAdmissionError}
 */
function validateTrainCandidate(candidate) {
  _need(candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate), 'candidate must be an object');
  _need(typeof candidate.trainId === 'string' && candidate.trainId.length > 0, 'candidate.trainId must be a non-empty string');
  _needArrayOfStrings(candidate.issues, 'candidate.issues');
  if (candidate.prereqs !== undefined) _needArrayOfStrings(candidate.prereqs, 'candidate.prereqs');
  if (candidate.orderAfter !== undefined) _needArrayOfStrings(candidate.orderAfter, 'candidate.orderAfter');
  if (candidate.conflicts !== undefined) _needArrayOfStrings(candidate.conflicts, 'candidate.conflicts');
  if (candidate.reservedGates !== undefined) _needArrayOfStrings(candidate.reservedGates, 'candidate.reservedGates');
  if (candidate.operatorVerification !== undefined) {
    const ov = candidate.operatorVerification;
    _need(ov !== null && typeof ov === 'object', 'candidate.operatorVerification must be an object');
    _need(typeof ov.required === 'boolean', 'candidate.operatorVerification.required must be a boolean');
  }
  if (candidate.verifiedAt !== undefined) _need(typeof candidate.verifiedAt === 'string', 'candidate.verifiedAt must be a string');
  if (candidate.sourceRevision !== undefined) _need(typeof candidate.sourceRevision === 'string', 'candidate.sourceRevision must be a string');
  if (candidate.unmilestoned !== undefined) _need(typeof candidate.unmilestoned === 'boolean', 'candidate.unmilestoned must be a boolean');
}

/**
 * Whether a dependency id (an issue like `"#721"` or a train like
 * `"train:4"`) currently resolves as satisfied, from a facts object.
 * Unknown — neither an issue nor a train fact names it — fails safe as OPEN:
 * nothing confirms it is resolved, so it blocks rather than silently passing.
 * @param {string} depId
 * @param {object} facts
 * @returns {boolean} true if still open (blocking).
 */
function _isOpen(depId, facts) {
  const issue = facts.issues && facts.issues[depId];
  if (issue) return issue.state !== 'closed';
  const train = facts.trains && facts.trains[depId];
  if (train) return train.state !== 'closed' && train.state !== 'admitted';
  return true;
}

/**
 * Which of a candidate's hard prerequisites are still open against `facts`.
 * @param {object} candidate
 * @param {object} facts
 * @returns {string[]}
 */
function _openPrereqs(candidate, facts) {
  return (candidate.prereqs || []).filter((p) => _isOpen(p, facts));
}

/**
 * Human-readable reasons a train needing architectural review needs it,
 * drawn from exactly the boundary crossings #1894 names.
 * @param {object} candidate
 * @returns {string[]}
 */
function _conditionalReasons(candidate) {
  const reasons = [];
  if (candidate.reservedGates && candidate.reservedGates.length > 0) {
    reasons.push(`crosses reserved gate(s): ${candidate.reservedGates.join(', ')}`);
  }
  if (candidate.operatorVerification && candidate.operatorVerification.required) {
    reasons.push('requires operator-only verification');
  }
  if (candidate.conflicts && candidate.conflicts.length > 0) {
    reasons.push(`has open conflict(s): ${candidate.conflicts.join(', ')}`);
  }
  return reasons;
}

/**
 * Classify a train candidate against current facts.
 *
 * Fails validation outright — throws rather than classifying — on
 * contradictory placement: #1894's own example is an issue appearing both as
 * an admitted train car and unmilestoned/backlog, which this module reads as
 * `candidate.unmilestoned === true` (the caller is expected to have already
 * checked the train IS an admitted car; this function's whole input is "a
 * candidate for admission").
 *
 * @param {object} candidate - See {@link validateTrainCandidate} for shape.
 * @param {object} facts - `{issues: {[id]: {state}}, trains: {[id]: {state}}}`.
 * @returns {{classification: string, reasons: string[]}}
 * @throws {RoadmapAdmissionError} On contradictory placement or a malformed candidate.
 */
function classifyTrain(candidate, facts) {
  validateTrainCandidate(candidate);
  _need(facts !== null && typeof facts === 'object', 'facts must be an object');

  _need(candidate.unmilestoned !== true,
    `train "${candidate.trainId}" is both an admitted train car and unmilestoned/backlog — contradictory placement`);

  const openPrereqs = _openPrereqs(candidate, facts);
  if (openPrereqs.length > 0) {
    return { classification: CLASSIFICATIONS.BLOCKED, reasons: openPrereqs.map((p) => `hard prerequisite ${p} is still open`) };
  }

  const crossesBoundary = (candidate.reservedGates && candidate.reservedGates.length > 0)
    || (candidate.operatorVerification && candidate.operatorVerification.required === true)
    || (candidate.conflicts && candidate.conflicts.length > 0);

  if (!crossesBoundary) {
    return { classification: CLASSIFICATIONS.EXECUTABLE, reasons: ['no architectural, reserved-gate or conflict boundary crossed'] };
  }
  return { classification: CLASSIFICATIONS.CONDITIONAL, reasons: _conditionalReasons(candidate) };
}

/**
 * Snapshot each of the candidate's own issues' states, for the manifest's
 * record of exactly what it saw.
 * @param {object} candidate
 * @param {object} facts
 * @returns {Object<string, string>}
 */
function _snapshotIssueStates(candidate, facts) {
  const out = {};
  for (const id of candidate.issues) {
    out[id] = (facts.issues && facts.issues[id] && facts.issues[id].state) || 'unknown';
  }
  return out;
}

/**
 * Build the durable Train Admission Manifest #1894 asks for: the candidate's
 * exact issue states, its hard/cross-train prerequisites, open conflicts,
 * operator-only needs, reserved gates and the roadmap revision the decision
 * was made against — everything {@link validateTrainDispatchAdmission} later
 * needs to tell a fresh fact from a stale one, without re-deriving it from
 * the candidate alone.
 *
 * @param {object} candidate
 * @param {object} facts
 * @param {object} [opts]
 * @param {number} [opts.now] - Epoch ms; `Date.now()` when omitted.
 * @returns {object} The manifest.
 * @throws {RoadmapAdmissionError} Same as {@link classifyTrain}.
 */
function buildTrainAdmissionManifest(candidate, facts, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const { classification, reasons } = classifyTrain(candidate, facts);
  return {
    schema: 'tc.roadmap-admission-manifest/v1',
    trainId: candidate.trainId,
    issues: [...candidate.issues],
    issueStates: _snapshotIssueStates(candidate, facts),
    hardPrereqs: [...(candidate.prereqs || [])],
    conflicts: [...(candidate.conflicts || [])],
    operatorVerification: candidate.operatorVerification ? { ...candidate.operatorVerification } : { required: false },
    reservedGates: [...(candidate.reservedGates || [])],
    roadmapRevision: candidate.sourceRevision || null,
    classification,
    reasons,
    builtAt: now
  };
}

/**
 * Whether two dependency lists name the same set, order ignored.
 * @param {string[]} [a]
 * @param {string[]} [b]
 * @returns {boolean}
 */
function _sameSet(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * Whether `candidate` — what is actually about to be dispatched — is the
 * same train the manifest was built for, on every dependency-defining field.
 * Deliberately excludes `conflicts` (live and separately re-checked) and
 * `sourceRevision`/`verifiedAt` (staleness is its own check below).
 * @param {object} candidate
 * @param {object} manifest
 * @returns {boolean}
 */
function _candidateMatchesManifest(candidate, manifest) {
  if (candidate.trainId !== manifest.trainId) return false;
  if (!_sameSet(candidate.issues, manifest.issues)) return false;
  if (!_sameSet(candidate.prereqs, manifest.hardPrereqs)) return false;
  if (!_sameSet(candidate.reservedGates, manifest.reservedGates)) return false;
  const candidateRequiresOperator = !!(candidate.operatorVerification && candidate.operatorVerification.required);
  const manifestRequiresOperator = !!(manifest.operatorVerification && manifest.operatorVerification.required);
  return candidateRequiresOperator === manifestRequiresOperator;
}

/**
 * Re-validate a manifest's admission at dispatch time against the ACTUAL
 * candidate being dispatched and FRESH facts — the one place #1894 asks to
 * refuse rather than trust a manifest once the world underneath it has
 * moved, or to trust a candidate just because it shares the manifest's
 * train id.
 *
 * Order of checks (each an independent refusal reason):
 * 1. The candidate being dispatched right now matches the manifest on every
 *    dependency-defining field — not merely the same `trainId`.
 * 2. Hard prerequisites, re-checked live (a prerequisite the manifest saw
 *    closed may have reopened).
 * 3. The candidate's OWN issues, re-checked live against the manifest's
 *    captured `issueStates` — any drift (either direction) means the
 *    manifest's snapshot no longer describes reality and must be refreshed.
 * 4. A fresh conflict snapshot, required whenever the manifest recorded any
 *    conflict at build time (an omitted `currentFacts.conflicts` entry is
 *    "nobody checked," never silently read as "no conflicts"); then new
 *    conflicts live, for a train with or without recorded ones.
 * 5. Evidence staleness: the manifest's own age against `evidenceTtlMs`, or
 *    the roadmap revision having moved since it was built.
 * 6. Operator-only verification misrepresented as unattended-safe.
 * 7. An explicit REJECTED receipt.
 * 8. For `executable` candidates, nothing further is required — no
 *    Architect pause was ever needed, so admission proceeds on the live
 *    checks above alone.
 * 9. For `conditionally-executable`/`blocked` candidates, an explicit
 *    APPROVED or MODIFY receipt is required; its absence refuses. A MODIFY
 *    receipt's `admittedSubset` must name only issues the manifest knows,
 *    and the candidate's own issues must not exceed it.
 *
 * @param {object} manifest - From {@link buildTrainAdmissionManifest}.
 * @param {object} candidate - The train actually being dispatched right now; same shape as {@link validateTrainCandidate}.
 * @param {object} [receipt] - `{decision, admittedSubset?, sequence?, blockingDependency?, unattendedSafe?}`.
 * @param {object} currentFacts - `{issues, trains, conflicts: {[trainId]: string[]}, roadmapRevision}`, read fresh at dispatch time.
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.evidenceTtlMs] - Overrides {@link DEFAULT_EVIDENCE_TTL_MS}.
 * @returns {{admitted: boolean, reason?: string, detail?: *, decision?: string, admittedSubset?: *, sequence?: *}}
 */
function validateTrainDispatchAdmission(manifest, candidate, receipt, currentFacts, opts = {}) {
  _need(manifest !== null && typeof manifest === 'object' && manifest.schema === 'tc.roadmap-admission-manifest/v1', 'manifest must be a tc.roadmap-admission-manifest/v1 object');
  validateTrainCandidate(candidate);
  _need(currentFacts !== null && typeof currentFacts === 'object', 'currentFacts must be an object');
  const r = receipt || {};
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const evidenceTtlMs = typeof opts.evidenceTtlMs === 'number' ? opts.evidenceTtlMs : DEFAULT_EVIDENCE_TTL_MS;

  if (!_candidateMatchesManifest(candidate, manifest)) {
    return { admitted: false, reason: 'candidate-diverged-from-manifest', detail: { candidateTrainId: candidate.trainId, manifestTrainId: manifest.trainId } };
  }

  const stillOpen = (manifest.hardPrereqs || []).filter((p) => _isOpen(p, currentFacts));
  if (stillOpen.length > 0) return { admitted: false, reason: 'hard-prereq-open', detail: stillOpen };

  const issueDrift = Object.keys(manifest.issueStates || {}).filter((id) => {
    const fresh = currentFacts.issues && currentFacts.issues[id];
    const freshState = fresh ? fresh.state : 'unknown';
    return freshState !== manifest.issueStates[id];
  });
  if (issueDrift.length > 0) return { admitted: false, reason: 'issue-state-changed', detail: issueDrift };

  if ((manifest.conflicts || []).length > 0) {
    const hasFreshConflictData = !!currentFacts.conflicts && Object.prototype.hasOwnProperty.call(currentFacts.conflicts, manifest.trainId);
    if (!hasFreshConflictData) {
      return { admitted: false, reason: 'conflict-snapshot-missing', detail: 'the manifest recorded conflicts but currentFacts carries no fresh conflict snapshot for this train' };
    }
  }
  const liveConflicts = (currentFacts.conflicts && currentFacts.conflicts[manifest.trainId]) || [];
  const known = new Set(manifest.conflicts || []);
  const newConflicts = liveConflicts.filter((c) => !known.has(c));
  if (newConflicts.length > 0) return { admitted: false, reason: 'new-conflict-detected', detail: newConflicts };

  if (typeof manifest.builtAt === 'number' && now - manifest.builtAt > evidenceTtlMs) {
    return { admitted: false, reason: 'evidence-expired', detail: { builtAt: manifest.builtAt, evidenceTtlMs } };
  }
  if (currentFacts.roadmapRevision && manifest.roadmapRevision && currentFacts.roadmapRevision !== manifest.roadmapRevision) {
    return { admitted: false, reason: 'evidence-expired', detail: 'the roadmap revision has moved since this manifest was built' };
  }

  if (manifest.operatorVerification && manifest.operatorVerification.required && r.unattendedSafe === true) {
    return { admitted: false, reason: 'operator-verification-misrepresented', detail: manifest.operatorVerification.reason || null };
  }

  if (r.decision === DECISIONS.REJECTED) {
    return { admitted: false, reason: 'rejected', detail: r.blockingDependency || null };
  }

  if (manifest.classification === CLASSIFICATIONS.EXECUTABLE) {
    return { admitted: true, decision: DECISIONS.APPROVED };
  }

  if (r.decision !== DECISIONS.APPROVED && r.decision !== DECISIONS.MODIFY) {
    return { admitted: false, reason: 'architect-review-required', detail: manifest.reasons };
  }
  if (r.decision === DECISIONS.MODIFY) {
    const admittedSubset = Array.isArray(r.admittedSubset) ? r.admittedSubset : null;
    if (admittedSubset) {
      const unknown = admittedSubset.filter((id) => !manifest.issues.includes(id));
      if (unknown.length > 0) return { admitted: false, reason: 'modify-subset-invalid', detail: unknown };
      const exceeded = candidate.issues.filter((id) => !admittedSubset.includes(id));
      if (exceeded.length > 0) return { admitted: false, reason: 'modify-subset-exceeded', detail: exceeded };
    }
    return { admitted: true, decision: DECISIONS.MODIFY, admittedSubset: r.admittedSubset || null, sequence: r.sequence || null };
  }
  return { admitted: true, decision: DECISIONS.APPROVED };
}

module.exports = {
  RoadmapAdmissionError,
  CLASSIFICATIONS,
  DECISIONS,
  RESERVED_GATE_KINDS,
  DEFAULT_EVIDENCE_TTL_MS,
  validateTrainCandidate,
  classifyTrain,
  buildTrainAdmissionManifest,
  validateTrainDispatchAdmission
};
