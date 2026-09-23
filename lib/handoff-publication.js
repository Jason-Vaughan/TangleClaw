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
 * A probe failure is a REASON or it is nothing.
 *
 * An empty or blank string is the shape a reason takes when a producer meant to
 * name one and had nothing to say. Storing it would make the document's null
 * worktree ambiguous in a third way — read as a failure by anything testing
 * presence, and as a non-repo by anything reading the text — so it normalizes
 * to null, which is one of the two states the field exists to separate.
 *
 * The reason is stored AS GIVEN. Whitespace decides whether one was supplied;
 * rewriting the producer's own text would edit recorded evidence on its way
 * into bytes that are frozen and can never be revisited.
 *
 * @param {unknown} value - The caller's `worktreeProblem`
 * @returns {string|null} The reason exactly as supplied, or null
 */
function _normalizeProblem(value) {
  return typeof value === 'string' && value.trim() ? value : null;
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
 * @param {object|null} input.worktree - Git facts, or null when the work tree has no git
 *   identity OR the probe that would have read it failed; `worktreeProblem` says which
 * @param {string|null} [input.worktreeProblem] - Why the work tree could not be read, when
 *   that is the reason `worktree` is null. Mutually exclusive with a `worktree` object: a
 *   document carrying both claims it read a tree it also says it could not read
 * @param {object[]} input.rules - `{id, source, revision, contentHash}` rows, plus an optional
 *   `label` (what step 3 prints instead of a bare id) and `measured: false` on a row whose
 *   content the producer could not read — a null `contentHash` is not a hash, and two of them
 *   must never compare equal into "unchanged"
 * @param {string[]} [input.manifestSources] - Which governing sources `rules` actually covers.
 *   Absent means a pre-21.10 producer, which covered the project rules and nothing else; the
 *   next launch's drift diff reads the difference and reports the rest as `not-recorded`
 *   rather than as unchanged.
 * @param {string|null} input.globalRulesHash - Hash of the global rule set, UNTRIMMED. It
 *   predates the drift diff and 21.8's preflight reads it, so it keeps its own rule. The
 *   authority for "did the global rules change" is the `source: 'global'` row inside `rules`,
 *   which is trimmed; this field answers the preflight's question, not the diff's. Two hashes
 *   of one document is the cost of not changing a field an earlier car already depends on.
 * @param {string|null} input.engineConfigHash - Hash of the engine config
 * @param {string|null} input.continuityIndexHash - Hash of the continuity index
 * @param {string} input.wrapOutcome - 'complete' | 'degraded'
 * @param {string[]} [input.missingEvidence] - Every non-ok step, named
 * @param {string|null} [input.nextAction] - The wrap's next action, if any
 * @param {object|null} [input.resume] - The resume text this wrap wrote to the continuity index
 *   (#1675): `{currentState, nextAction, freshness: {sha, branch, writtenAt, tier}}`, or null when
 *   the wrap wrote none. Left out entirely (undefined) only by a producer that predates the field
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

  // The same honesty contract as the pair above, for the tree. A null
  // `worktree` is read by the launch as "this project is not a git repository",
  // which disables both workspace checks and is a precondition of `ok`; a
  // `worktreeProblem` says that null means "we could not look" instead. Both at
  // once is a document claiming it both read the tree and failed to, and the
  // bytes are frozen at staging, so a caller that cannot make up its mind is
  // refused here rather than believed by every later reader.
  // #1675 — a `resume` block and the top-level `nextAction` are one value in
  // two places, kept for readers that predate the block. They are derived from
  // one canonical value and never allowed to disagree: a document carrying two
  // next actions carries two truths, and the bytes are frozen at staging.
  const resume = input.resume !== undefined ? _normalizeResume(input.resume) : undefined;
  if (resume && _optionalText(input.nextAction ?? null, 'nextAction') !== resume.nextAction) {
    throw new Error(
      `handoff nextAction and resume.nextAction must be the same value: ${JSON.stringify(input.nextAction ?? null)} vs ${JSON.stringify(resume.nextAction)}`
    );
  }

  const worktreeProblem = _normalizeProblem(input.worktreeProblem);
  if (worktreeProblem && input.worktree) {
    throw new Error(
      `a handoff cannot record worktree facts and a probe failure at once: ${worktreeProblem}`
    );
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
    worktreeProblem,
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
    // #1738 — whether the session's engine could run the project's methodology.
    // Omitted when the producer did not say, so absence stays readable as
    // "unknown" rather than as any one answer.
    ...(input.methodology ? { methodology: _normalizeMethodology(input.methodology) } : {}),
    nextAction: resume ? resume.nextAction : (input.nextAction ?? null),
    // #1675 — what the next launch's Resume block renders, frozen with the rest
    // so the text a launch proposes is the text this publication vouches for.
    // `null` says this wrap wrote no resume; absence says the producer predates
    // the field, and the two are read differently.
    ...(resume !== undefined ? { resume } : {}),
    planRef: input.planRef ?? null
  };
}

/** Freshness keys a `resume` block may carry. @type {string[]} */
const RESUME_FRESHNESS_KEYS = ['sha', 'branch', 'writtenAt', 'tier'];

/**
 * A string, or null for anything empty. Resume text is prose a model captured,
 * so a blank value is "not captured", never an empty claim.
 * @param {unknown} value
 * @param {string} label - What to call it in a refusal
 * @returns {string|null}
 */
function _optionalText(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`handoff ${label} must be a string or null, got ${JSON.stringify(value)}`);
  }
  return value.trim() ? value : null;
}

/**
 * Validate and copy a `resume` block (#1675). Refused rather than frozen when
 * it is malformed: the bytes cannot be repaired after staging, and the next
 * launch shows this text to the operator as what the last session recorded.
 * @param {object|null} r
 * @returns {{currentState: (string|null), nextAction: (string|null), freshness: object}|null}
 */
function _normalizeResume(r) {
  if (r === null) return null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    throw new Error(`handoff resume must be an object or null, got ${JSON.stringify(r)}`);
  }
  const f = r.freshness === undefined || r.freshness === null ? {} : r.freshness;
  if (typeof f !== 'object' || Array.isArray(f)) {
    throw new Error(`handoff resume.freshness must be an object, got ${JSON.stringify(r.freshness)}`);
  }
  const freshness = {};
  for (const key of RESUME_FRESHNESS_KEYS) freshness[key] = _optionalText(f[key], `resume.freshness.${key}`);
  return {
    currentState: _optionalText(r.currentState, 'resume.currentState'),
    nextAction: _optionalText(r.nextAction, 'resume.nextAction'),
    freshness
  };
}

/**
 * Whether a parsed document's `resume` block is one a reader may render.
 *
 * Not part of `readDocument`'s verdict on purpose: the block is what a launch
 * SHOWS, not what decides its recovery verdict, so a malformed one costs the
 * launch its resume text — said out loud by the caller — rather than turning an
 * otherwise sound handoff into `handoff-corrupt`.
 * @param {object} doc - A parsed `tc.handoff/1` document
 * @returns {'absent'|'none'|'valid'|'malformed'} `absent` when the producer
 *   predates the field, `none` when it recorded that no resume was written, and
 *   `malformed` for a block that is not the right shape or whose next action
 *   disagrees with the document's top-level one
 */
function resumeState(doc) {
  if (!doc || !Object.prototype.hasOwnProperty.call(doc, 'resume')) return 'absent';
  if (doc.resume === null) return 'none';
  let resume;
  try {
    resume = _normalizeResume(doc.resume);
  } catch {
    return 'malformed';
  }
  // Bytes something else produced may carry two next actions. Neither can be
  // believed over the other, so the block is not rendered from.
  let top;
  try {
    top = _optionalText(doc.nextAction ?? null, 'nextAction');
  } catch {
    return 'malformed';
  }
  return top === resume.nextAction ? 'valid' : 'malformed';
}

/**
 * The dispositions a handoff's `methodology` block may carry (#1738).
 * @type {string[]}
 */
const METHODOLOGY_DISPOSITIONS = ['measured', 'unmeasured', 'not-applicable', 'capability-unavailable'];

/**
 * Validate and copy a `methodology` block. A disposition outside the set is
 * refused rather than frozen: the bytes cannot be repaired after staging, and
 * the next launch acts on this value.
 * @param {{disposition: string, engineId?: (string|null)}} m
 * @returns {{disposition: string, engineId: (string|null)}}
 */
function _normalizeMethodology(m) {
  if (!m || !METHODOLOGY_DISPOSITIONS.includes(m.disposition)) {
    throw new Error(`handoff methodology.disposition must be one of ${METHODOLOGY_DISPOSITIONS.join(', ')}, got ${JSON.stringify(m && m.disposition)}`);
  }
  return { disposition: m.disposition, engineId: m.engineId ?? null };
}

/**
 * What is wrong with a parsed document's worktree block, or null when nothing is.
 *
 * Three legitimate shapes, and they are the three states the producer can be
 * in: facts (an object naming the tree it measured), a probe failure (null
 * facts plus a reason), and no git identity (null facts, no reason). Anything
 * else is a document that cannot be read about the tree it describes, which is
 * the one question the launch's recovery decision turns on.
 *
 * @param {object} parsed - A parsed `tc.handoff/1` document
 * @returns {string|null} Why it is unreadable, or null
 */
function _worktreeShapeProblem(parsed) {
  const { worktree, worktreeProblem } = parsed;
  const hasProblem = worktreeProblem !== undefined && worktreeProblem !== null;
  if (hasProblem && (typeof worktreeProblem !== 'string' || !worktreeProblem.trim())) {
    return `worktreeProblem is ${JSON.stringify(worktreeProblem)}, expected a reason or null`;
  }
  if (worktree === undefined || worktree === null) {
    return null;
  }
  if (typeof worktree !== 'object' || Array.isArray(worktree)) {
    return `worktree is ${JSON.stringify(worktree)}, expected an object or null`;
  }
  if (hasProblem) {
    // Both at once: the document says it measured the tree and says it could
    // not look. `buildHandoffDocument` refuses to write this; a reader meets it
    // only in bytes something else produced, and there is no safe way to pick a
    // side — believing the facts is exactly the reassuring read this issue is about.
    return `worktree records facts and worktreeProblem records a failure to read it: ${worktreeProblem}`;
  }
  for (const key of ['path', 'toplevel']) {
    if (typeof worktree[key] !== 'string' || !worktree[key]) {
      return `worktree.${key} is ${JSON.stringify(worktree[key])}, expected a path`;
    }
  }
  return null;
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
  // The worktree block decides a recovery verdict, so its SHAPE is validated
  // here rather than trusted and read field by field downstream. A reader that
  // takes `doc.worktree` as an object because it is truthy, and then finds
  // `toplevel` undefined, reports a worktree it never had — and the bytes are
  // frozen, so nothing can go back and ask. Absent is fine: it is what a
  // non-git project and every pre-#1649 producer both write.
  const worktreeReason = _worktreeShapeProblem(parsed);
  if (worktreeReason) {
    return { outcome: 'corrupt', doc: null, digest: digestOf(text), reason: worktreeReason };
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
  readDocument,
  resumeState,
  normalizeResume: _normalizeResume,
  METHODOLOGY_DISPOSITIONS
};
