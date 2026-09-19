'use strict';

/**
 * `tc.handoff/1` — the per-attempt handoff document (Train 21, #1585).
 *
 * Pure: this module builds and inspects bytes. It never touches the DB, the
 * filesystem or the clock beyond what a caller hands it, so the staged digest
 * and the published digest are the same value by construction rather than by
 * discipline.
 *
 * The bytes are frozen at staging and never rewritten. Publication time lives
 * only in the DB for exactly that reason: a document that carried its own
 * published-at would have to be edited to be published, and an edited document
 * cannot be the thing its digest attests to.
 */

const crypto = require('node:crypto');

/** The only schema tag these bytes are ever written with. */
const HANDOFF_SCHEMA = 'tc.handoff/1';

/** Publication kinds. A kept session checkpoints; a wrapping one finalizes. */
const HANDOFF_KINDS = ['final', 'checkpoint'];

/**
 * Mint a publication id: 128 random bits, base64url.
 *
 * Random rather than derived from `(session, run)` — a derived id would be
 * guessable from a session's own identifiers, and `UNIQUE (session_id,
 * wrap_run_id)` already supplies the collision guarantee a derived id would be
 * reached for.
 * @returns {string} 22-character base64url id
 */
function newPublicationId() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Serialize a handoff document to its canonical bytes.
 *
 * Key order is the insertion order `buildHandoffDocument` produced, so the same
 * input always yields the same bytes. Callers digest and write THESE bytes;
 * re-serializing a parsed document is not guaranteed to reproduce them, which
 * is why `readDocument` hands back the raw text alongside the parsed value.
 * @param {object} doc - A document from `buildHandoffDocument`
 * @returns {string} JSON text, newline-terminated
 */
function serializeDocument(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The sha256 of some handoff bytes, as lowercase hex.
 * @param {string} text - Serialized document bytes
 * @returns {string} Hex digest
 */
function digestOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Build the frozen `tc.handoff/1` document for one wrap attempt.
 *
 * `missingEvidence` is empty if and only if `wrapOutcome` is `complete`: the
 * pair is the wrap's honesty contract (wrap-direction §2 — a step degrades with
 * a visible reason, never silently nothing), so a caller that reports a
 * degraded wrap without naming what degraded is refused here rather than
 * writing a document that claims more than the wrap knows.
 *
 * @param {object} input - Attempt facts, all required unless marked optional
 * @param {string} input.publicationId - From `newPublicationId`
 * @param {number} input.projectId - Logical project ref
 * @param {string|null} input.workspaceId - Switchboard workspace id, or null
 * @param {number} input.sessionId - Producing session
 * @param {string} input.wrapRunId - The wrap run that staged this attempt
 * @param {string} input.engineId - Engine that ran the session
 * @param {string} input.kind - 'final' | 'checkpoint', fixed at staging
 * @param {string} input.stagedAt - ISO timestamp
 * @param {object|null} input.worktree - Git facts, or null for a non-git root
 * @param {object[]} input.rules - `{id, source, revision, contentHash}` rows
 * @param {string[]} [input.manifestSources] - Which governing sources `rules` actually covers.
 *   Absent means a pre-21.10 producer, which covered the project rules and nothing else; the
 *   next launch's drift diff reads the difference and reports the rest as `not-recorded`
 *   rather than as unchanged.
 * @param {string|null} input.globalRulesHash - Hash of the global rule set
 * @param {string|null} input.engineConfigHash - Hash of the engine config
 * @param {string|null} input.continuityIndexHash - Hash of the continuity index
 * @param {string} input.wrapOutcome - 'complete' | 'degraded'
 * @param {string[]} [input.missingEvidence] - Every non-ok step, named
 * @param {string|null} [input.nextAction] - The wrap's next action, if any
 * @param {string|null} [input.planRef] - Absolute path to the active plan
 * @returns {object} The document, ready for `serializeDocument`
 * @throws {Error} When kind, outcome or the evidence pair is inconsistent
 */
function buildHandoffDocument(input) {
  if (!HANDOFF_KINDS.includes(input.kind)) {
    throw new Error(`handoff kind must be one of ${HANDOFF_KINDS.join(', ')}, got ${JSON.stringify(input.kind)}`);
  }
  if (input.wrapOutcome !== 'complete' && input.wrapOutcome !== 'degraded') {
    throw new Error(`handoff wrapOutcome must be 'complete' or 'degraded', got ${JSON.stringify(input.wrapOutcome)}`);
  }
  const missingEvidence = input.missingEvidence ? [...input.missingEvidence] : [];
  if (input.wrapOutcome === 'degraded' && missingEvidence.length === 0) {
    throw new Error('a degraded wrap must name what degraded: missingEvidence was empty');
  }
  if (input.wrapOutcome === 'complete' && missingEvidence.length > 0) {
    throw new Error(`a complete wrap cannot carry missing evidence: ${missingEvidence.join(', ')}`);
  }

  return {
    schema: HANDOFF_SCHEMA,
    publicationId: input.publicationId,
    projectId: input.projectId,
    workspaceId: input.workspaceId ?? null,
    sessionId: input.sessionId,
    wrapRunId: input.wrapRunId,
    engineId: input.engineId,
    kind: input.kind,
    stagedAt: input.stagedAt,
    worktree: input.worktree ?? null,
    rules: input.rules ? [...input.rules] : [],
    // Omitted entirely when the producer did not declare it, so the absence
    // stays readable as "a producer that predates this field" rather than
    // becoming an empty list that claims the wrap looked at nothing.
    ...(Array.isArray(input.manifestSources) ? { manifestSources: [...input.manifestSources] } : {}),
    globalRulesHash: input.globalRulesHash ?? null,
    engineConfigHash: input.engineConfigHash ?? null,
    continuityIndexHash: input.continuityIndexHash ?? null,
    wrapOutcome: input.wrapOutcome,
    missingEvidence,
    nextAction: input.nextAction ?? null,
    planRef: input.planRef ?? null
  };
}

/**
 * Parse handoff bytes, reporting the read's OUTCOME rather than a plausible
 * default (architecture.md § Direction — a read that could not be established
 * names itself, never guesses).
 *
 * Three states, because a caller deciding whether to repair must tell them
 * apart: the file is a handoff (`ok`), the file exists but is not one
 * (`corrupt`, with a reason), or there was nothing to read (`absent`).
 * @param {string|null} text - Raw bytes, or null when the file was not found
 * @returns {{outcome: string, doc: object|null, digest: string|null, reason: string|null}}
 */
function readDocument(text) {
  if (text === null || text === undefined) {
    return { outcome: 'absent', doc: null, digest: null, reason: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { outcome: 'corrupt', doc: null, digest: digestOf(text), reason: `not JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { outcome: 'corrupt', doc: null, digest: digestOf(text), reason: 'not a JSON object' };
  }
  if (parsed.schema !== HANDOFF_SCHEMA) {
    return {
      outcome: 'corrupt',
      doc: null,
      digest: digestOf(text),
      reason: `schema is ${JSON.stringify(parsed.schema)}, expected ${HANDOFF_SCHEMA}`
    };
  }
  if (typeof parsed.publicationId !== 'string' || !parsed.publicationId) {
    return { outcome: 'corrupt', doc: null, digest: digestOf(text), reason: 'no publicationId' };
  }
  if (!HANDOFF_KINDS.includes(parsed.kind)) {
    return { outcome: 'corrupt', doc: null, digest: digestOf(text), reason: `kind is ${JSON.stringify(parsed.kind)}` };
  }
  return { outcome: 'ok', doc: parsed, digest: digestOf(text), reason: null };
}

module.exports = {
  HANDOFF_SCHEMA,
  HANDOFF_KINDS,
  newPublicationId,
  serializeDocument,
  digestOf,
  buildHandoffDocument,
  readDocument
};
