'use strict';

/**
 * The public face of a release-candidate certification: the documents
 * published to the `metrics` branch, and the rules they obey.
 *
 * Everything here is built field by field from an allowlist, never by copying
 * private state and deleting what looks sensitive. A field added to the
 * private evidence later stays private until someone adds it here on purpose.
 * Never published: the worktree path, the host, the ttyd generation (it holds
 * a pid), raw samples, and probe diagnostics.
 *
 * The same module owns the validators, so the publisher, the GitHub check that
 * guards the branch and the release promotion step all judge a published
 * document by one definition. Times are epoch ms in UTC.
 *
 * Layout on the branch, under `release-certification/v1/`:
 *   admissions/<sha>.json   written once: what was admitted, with its manifest digest
 *   scorecards/<sha>.json   replaced on each publish: the run's current standing
 *   events/<sha>.ndjson     appended: one line per state transition
 *   index.json              every candidate, newest first
 *
 * @module lib/release-certification/scorecard
 */

const { STATES, EXTEND, HARD_FAIL, TRANSITION } = require('./codes');
const sm = require('./state-machine');

const ROOT = 'release-certification/v1/';

/** Schema tag of each published document. */
const SCHEMAS = Object.freeze({
  admission: 'tc.release-certification.admission/v1',
  scorecard: 'tc.release-certification.scorecard/v1',
  event: 'tc.release-certification.event/v1',
  index: 'tc.release-certification.index/v1',
  summary: 'tc.release-certification.summary/v1'
});

/** Violations a validator reports. */
const VIOLATIONS = Object.freeze({
  SCHEMA: 'SCHEMA',
  FIELD: 'FIELD',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD'
});

const { SHA_RE, DIGEST_RE, RUN_ID_RE, CHECKS_SOURCES, REPO_RE, TEXT_RE, ACTOR_RE, REQUIRED_CHECKS_SOURCES, isCount: _isCount, validRequiredChecks } = require('./formats');
const ALL_STATES = Object.values(STATES);
const ALL_CODES = [...Object.values(EXTEND), ...Object.values(HARD_FAIL), ...Object.values(TRANSITION)];

/**
 * Published paths for one candidate.
 * @param {string} sha - Candidate SHA
 * @returns {{admission: string, scorecard: string, events: string}} Repository-relative paths
 */
function paths(sha) {
  return {
    admission: `${ROOT}admissions/${sha}.json`,
    scorecard: `${ROOT}scorecards/${sha}.json`,
    events: `${ROOT}events/${sha}.ndjson`
  };
}

const INDEX_PATH = `${ROOT}index.json`;

/**
 * Every path a published document may have, built from the layout above so the
 * two can never disagree. The publisher refuses to write anything else, and the
 * branch verifier refuses any commit that touches anything else.
 */
const PUBLISHED_PATH = (() => {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const one = paths('SHA');
  const doc = (p) => esc(p.slice(ROOT.length)).replace('SHA', '[0-9a-f]{40}');
  return new RegExp(`^${esc(ROOT)}(?:${doc(one.admission)}|${doc(one.scorecard)}|${doc(one.events)}|${esc(INDEX_PATH.slice(ROOT.length))})$`);
})();

/**
 * What a published path names, read against the same layout.
 * @param {string} p - Repository-relative path
 * @returns {{kind: 'admission'|'scorecard'|'events', sha: string}|{kind: 'index'}|null} The document, or null when not a published path
 */
function parsePublishedPath(p) {
  if (!PUBLISHED_PATH.test(p)) return null;
  if (p === INDEX_PATH) return { kind: 'index' };
  const sha = p.match(/[0-9a-f]{40}/)[0];
  const docs = paths(sha);
  for (const kind of ['admission', 'scorecard', 'events']) if (docs[kind] === p) return { kind, sha };
  return null;
}

/**
 * The admission record: what was admitted and under which rules. Written once;
 * its `manifestDigest` is what makes the private manifest binding.
 * @param {object} manifest - The run's manifest
 * @param {string} manifestDigest - sha256 of the manifest's stored bytes
 * @returns {object} Admission document
 */
function admissionRecord(manifest, manifestDigest) {
  return {
    schema: SCHEMAS.admission,
    candidateSha: manifest.candidateSha,
    version: manifest.version,
    repository: manifest.repository,
    manifestDigest,
    admittedAt: manifest.createdAt,
    canonicalThresholds: sm.isCanonical(manifest),
    thresholds: { ...manifest.thresholds },
    requiredChecks: [...manifest.requiredChecks],
    requiredChecksSource: manifest.requiredChecksSource,
    // How the checks were judged, and the host-minted run they were judged
    // for. A host-attested run's pass is not certification of record until
    // the host that holds its ledger has finalized and relayed it (ADR 0021
    // point 10), and a reader can only know it owes that from here.
    checksSource: manifest.checksSource,
    runId: manifest.runId,
    // Where the run's baseline comes from, and whether the guest's isolation
    // is attested (A47): the manifest's own staging-time values are not the
    // baseline, and a reader must not take them for it.
    isolation: manifest.isolation,
    baselineSource: manifest.baselineSource
  };
}

/**
 * Copy an operator record, withholding the actor when asked.
 * @param {object|null} rec - `{actor, at}`
 * @param {boolean} publishActor - Whether the actor id is public
 * @returns {object|null} Public record
 */
function _operator(rec, publishActor) {
  if (!rec) return null;
  return publishActor ? { actor: rec.actor, at: rec.at } : { at: rec.at };
}

/**
 * The scorecard: the run's current standing, built from the structured
 * summary and never from private state directly.
 * @param {object} state - Committed state (carries `manifestDigest`)
 * @param {object} manifest - The manifest
 * @param {number} now - Epoch ms of this publish
 * @param {number} publishSeq - Strictly increasing per candidate
 * @returns {object} Scorecard document
 */
function scorecard(state, manifest, now, publishSeq) {
  const s = sm.summarize(state, manifest, now);
  // Only the manifest decides whether operator ids are public: it is pinned
  // and checksummed at admission, so no caller can publish an id the run
  // withheld (ADR 0021 point 6).
  const publishActor = manifest.publishActor !== false;
  const extensions = {};
  for (const [code, e] of Object.entries(s.extensions)) {
    if (Object.values(EXTEND).includes(code)) extensions[code] = { intervals: e.intervals, lostMs: e.lostMs };
  }
  return {
    schema: SCHEMAS.scorecard,
    candidateSha: s.candidateSha,
    version: s.version,
    manifestDigest: state.manifestDigest,
    state: s.state,
    canonicalThresholds: s.canonicalThresholds,
    requiredChecksSource: manifest.requiredChecksSource,
    checksSource: manifest.checksSource,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    lastSampleAt: s.lastSampleAt,
    monitorStale: s.monitorStale,
    elapsedMs: s.elapsedMs,
    qualifiedMs: s.qualifiedMs,
    targetMs: s.targetMs,
    remainingMs: s.remainingMs,
    extensions,
    pty: {
      attaches: s.pty.attaches,
      detaches: s.pty.detaches,
      firstEventAt: s.pty.firstEventAt,
      lastEventAt: s.pty.lastEventAt,
      spanMs: s.pty.spanMs,
      met: s.pty.met,
      target: { attaches: s.pty.target.attaches, detaches: s.pty.target.detaches, spanMs: s.pty.target.spanMs }
    },
    poolUsedTrend: s.poolUsedTrend.map((p) => ({ at: p.at, used: p.used })),
    failure: s.failure ? { code: s.failure.code, at: s.failure.at } : null,
    acceptance: _operator(s.acceptance, publishActor),
    cancellation: _operator(s.cancellation, publishActor),
    // Never before the time it reports, so `elapsedMs` of a live run is
    // exactly `publishedAt - startedAt`, which the verifier checks.
    publishedAt: Math.max(now, state.updatedAt),
    publishSeq
  };
}

/**
 * One published transition line.
 * @param {object} event - A transition event from the state machine
 * @returns {object} Event document
 */
function eventLine(event) {
  return { schema: SCHEMAS.event, from: event.from, to: event.to, code: event.code, at: event.at, sampleSeq: event.sampleSeq ?? null };
}

/**
 * The index of every published candidate, newest first.
 * @param {object[]} scorecards - Scorecard documents
 * @returns {object} Index document
 */
function indexDoc(scorecards) {
  const candidates = scorecards
    .map((c) => ({ candidateSha: c.candidateSha, version: c.version, state: c.state, updatedAt: c.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.candidateSha < b.candidateSha ? -1 : 1));
  return { schema: SCHEMAS.index, candidates };
}

/**
 * The certification section of the combined `scorecard/v1.json` (Architect
 * ruling for #1949: one published source, with `development` and
 * `certification` sections). It is derived from the per-candidate documents,
 * which stay the source of truth: the candidate list, and the newest
 * candidate's scorecard as published.
 * @param {object[]} scorecards - Published scorecard documents
 * @returns {object} Summary document
 */
function certificationSummary(scorecards) {
  const candidates = indexDoc(scorecards).candidates;
  const newest = candidates.length > 0 ? scorecards.find((c) => c.candidateSha === candidates[0].candidateSha) : null;
  return { schema: SCHEMAS.summary, candidates, current: newest ? structuredClone(newest) : null };
}

/**
 * A field checker that collects violations.
 * @param {string[]} out - Violations (mutated)
 * @returns {function(string, boolean): void} `check(field, ok)`
 */
function _checker(out) {
  return (field, ok) => {
    if (!ok) out.push(`${VIOLATIONS.FIELD}:${field}`);
  };
}

/**
 * Refuse keys a document may not carry: an allowlist on the way in as well as out.
 * @param {object} doc - Document
 * @param {string[]} allowed - Permitted keys
 * @param {string[]} out - Violations (mutated)
 * @returns {void}
 */
function _onlyKeys(doc, allowed, out) {
  for (const k of Object.keys(doc)) if (!allowed.includes(k)) out.push(`${VIOLATIONS.UNKNOWN_FIELD}:${k}`);
}

/**
 * Whether an object has exactly these keys, so a nested object can no more
 * carry an unexpected field than the document itself can.
 * @param {*} v - Value
 * @param {string[]} keys - Required and permitted keys
 * @returns {boolean} True when `v` is a plain object with exactly `keys`
 */
function _shape(v, keys) {
  return _obj(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}

/**
 * Whether a value is a plain object.
 * @param {*} v - Value
 * @returns {boolean} True for `{}`
 */
function _obj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate an admission document.
 * @param {*} doc - Parsed document
 * @returns {string[]} Violations; empty when valid
 */
function validateAdmission(doc) {
  if (!_obj(doc) || doc.schema !== SCHEMAS.admission) return [VIOLATIONS.SCHEMA];
  const out = [];
  const check = _checker(out);
  _onlyKeys(doc, ['schema', 'candidateSha', 'version', 'repository', 'manifestDigest', 'admittedAt', 'canonicalThresholds', 'thresholds', 'requiredChecks', 'requiredChecksSource', 'checksSource', 'runId', 'isolation', 'baselineSource'], out);
  check('candidateSha', SHA_RE.test(doc.candidateSha));
  check('version', typeof doc.version === 'string' && TEXT_RE.test(doc.version));
  check('repository', typeof doc.repository === 'string' && REPO_RE.test(doc.repository));
  check('manifestDigest', typeof doc.manifestDigest === 'string' && DIGEST_RE.test(doc.manifestDigest));
  check('admittedAt', _isCount(doc.admittedAt));
  const thresholdsOk = _shape(doc.thresholds, Object.keys(sm.DEFAULT_THRESHOLDS))
    && Object.values(doc.thresholds).every((v) => Number.isSafeInteger(v) && v > 0);
  check('thresholds', thresholdsOk);
  // Release promotion trusts this flag to decide whether a run can certify,
  // so it must agree with the thresholds rather than merely be a boolean.
  check('canonicalThresholds', thresholdsOk && doc.canonicalThresholds === sm.isCanonical({ thresholds: doc.thresholds }));
  check('requiredChecks', validRequiredChecks(doc.requiredChecks));
  check('requiredChecksSource', REQUIRED_CHECKS_SOURCES.includes(doc.requiredChecksSource));
  check('checksSource', CHECKS_SOURCES.includes(doc.checksSource));
  check('runId', typeof doc.runId === 'string' && RUN_ID_RE.test(doc.runId));
  check('isolation', doc.isolation === (doc.checksSource === 'host-attested' ? 'attested' : 'none'));
  check('baselineSource', doc.baselineSource === 'admission');
  return out;
}

/**
 * Validate an operator record: `{actor, at}`, or `{at}` when the actor was withheld.
 * @param {*} rec - Record or null
 * @returns {boolean} True when valid
 */
function _validOperator(rec) {
  if (rec === null) return true;
  if (_shape(rec, ['at'])) return _isCount(rec.at);
  return _shape(rec, ['actor', 'at']) && _isCount(rec.at) && typeof rec.actor === 'string' && ACTOR_RE.test(rec.actor);
}

/**
 * Validate a scorecard document.
 * @param {*} doc - Parsed document
 * @returns {string[]} Violations; empty when valid
 */
function validateScorecard(doc) {
  if (!_obj(doc) || doc.schema !== SCHEMAS.scorecard) return [VIOLATIONS.SCHEMA];
  const out = [];
  const check = _checker(out);
  _onlyKeys(doc, ['schema', 'candidateSha', 'version', 'manifestDigest', 'state', 'canonicalThresholds', 'requiredChecksSource', 'checksSource', 'startedAt', 'updatedAt',
    'lastSampleAt', 'monitorStale', 'elapsedMs', 'qualifiedMs', 'targetMs', 'remainingMs', 'extensions', 'pty', 'poolUsedTrend',
    'failure', 'acceptance', 'cancellation', 'publishedAt', 'publishSeq'], out);
  check('candidateSha', SHA_RE.test(doc.candidateSha));
  check('version', typeof doc.version === 'string' && TEXT_RE.test(doc.version));
  check('manifestDigest', typeof doc.manifestDigest === 'string' && DIGEST_RE.test(doc.manifestDigest));
  check('state', ALL_STATES.includes(doc.state) && doc.state !== STATES.NOT_STARTED);
  check('canonicalThresholds', typeof doc.canonicalThresholds === 'boolean');
  // A passed run is a certification, and only canonical thresholds certify.
  check('canonicalThresholds', doc.state !== STATES.PASSED || doc.canonicalThresholds === true);
  check('requiredChecksSource', REQUIRED_CHECKS_SOURCES.includes(doc.requiredChecksSource));
  check('checksSource', CHECKS_SOURCES.includes(doc.checksSource));
  check('monitorStale', typeof doc.monitorStale === 'boolean');
  for (const f of ['startedAt', 'updatedAt', 'lastSampleAt', 'elapsedMs', 'qualifiedMs', 'targetMs', 'remainingMs', 'publishedAt']) check(f, _isCount(doc[f]));
  check('publishSeq', Number.isSafeInteger(doc.publishSeq) && doc.publishSeq >= 1);
  check('extensions', _obj(doc.extensions) && Object.entries(doc.extensions).every(([k, e]) =>
    Object.values(EXTEND).includes(k) && _shape(e, ['intervals', 'lostMs']) && _isCount(e.intervals) && _isCount(e.lostMs)));
  const p = doc.pty;
  check('pty', _shape(p, ['attaches', 'detaches', 'firstEventAt', 'lastEventAt', 'spanMs', 'met', 'target'])
    && _isCount(p.attaches) && _isCount(p.detaches) && _isCount(p.spanMs) && typeof p.met === 'boolean'
    && (p.firstEventAt === null || _isCount(p.firstEventAt)) && (p.lastEventAt === null || _isCount(p.lastEventAt))
    && _shape(p.target, ['attaches', 'detaches', 'spanMs'])
    && _isCount(p.target.attaches) && _isCount(p.target.detaches) && _isCount(p.target.spanMs));
  check('poolUsedTrend', Array.isArray(doc.poolUsedTrend) && doc.poolUsedTrend.every((t) => _shape(t, ['at', 'used']) && _isCount(t.at) && _isCount(t.used)));
  check('failure', doc.failure === null || (_shape(doc.failure, ['code', 'at']) && Object.values(HARD_FAIL).includes(doc.failure.code) && _isCount(doc.failure.at)));
  check('failure', (doc.state === STATES.FAILED) === (doc.failure !== null));
  check('acceptance', _validOperator(doc.acceptance) && (doc.state === STATES.PASSED) === (doc.acceptance !== null));
  check('cancellation', _validOperator(doc.cancellation) && (doc.state === STATES.CANCELLED) === (doc.cancellation !== null));
  return out;
}

/**
 * Validate one event line.
 * @param {*} doc - Parsed line
 * @returns {string[]} Violations; empty when valid
 */
function validateEvent(doc) {
  if (!_obj(doc) || doc.schema !== SCHEMAS.event) return [VIOLATIONS.SCHEMA];
  const out = [];
  const check = _checker(out);
  _onlyKeys(doc, ['schema', 'from', 'to', 'code', 'at', 'sampleSeq'], out);
  check('from', ALL_STATES.includes(doc.from));
  check('to', ALL_STATES.includes(doc.to) && doc.to !== STATES.NOT_STARTED);
  check('code', ALL_CODES.includes(doc.code));
  check('at', _isCount(doc.at));
  check('sampleSeq', doc.sampleSeq === null || (Number.isSafeInteger(doc.sampleSeq) && doc.sampleSeq >= 1));
  return out;
}

/**
 * Validate the index document.
 * @param {*} doc - Parsed document
 * @returns {string[]} Violations; empty when valid
 */
function validateIndex(doc) {
  if (!_obj(doc) || doc.schema !== SCHEMAS.index) return [VIOLATIONS.SCHEMA];
  const out = [];
  _onlyKeys(doc, ['schema', 'candidates'], out);
  const ok = Array.isArray(doc.candidates) && doc.candidates.every((c) => _shape(c, ['candidateSha', 'version', 'state', 'updatedAt'])
    && SHA_RE.test(c.candidateSha) && typeof c.version === 'string' && TEXT_RE.test(c.version) && ALL_STATES.includes(c.state) && _isCount(c.updatedAt));
  if (!ok) out.push(`${VIOLATIONS.FIELD}:candidates`);
  return out;
}

/**
 * Validate the certification section of the combined scorecard. Its
 * `current` must be a valid scorecard for the newest listed candidate.
 * @param {*} doc - Parsed section
 * @returns {string[]} Violations; empty when valid
 */
function validateCertificationSummary(doc) {
  if (!_obj(doc) || doc.schema !== SCHEMAS.summary) return [VIOLATIONS.SCHEMA];
  const out = [];
  _onlyKeys(doc, ['schema', 'candidates', 'current'], out);
  const listed = validateIndex({ schema: SCHEMAS.index, candidates: doc.candidates });
  if (listed.length > 0) out.push(`${VIOLATIONS.FIELD}:candidates`);
  const first = Array.isArray(doc.candidates) && doc.candidates.length > 0 ? doc.candidates[0] : null;
  if (doc.current === null) {
    if (first !== null) out.push(`${VIOLATIONS.FIELD}:current`);
  } else if (validateScorecard(doc.current).length > 0 || !first || doc.current.candidateSha !== first.candidateSha) {
    out.push(`${VIOLATIONS.FIELD}:current`);
  }
  return out;
}

/**
 * Serialize a document exactly as it is published, so bytes compare stably.
 * @param {object} doc - Document
 * @returns {string} JSON text with a trailing newline
 */
function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

module.exports = {
  ROOT,
  SCHEMAS,
  VIOLATIONS,
  INDEX_PATH,
  PUBLISHED_PATH,
  parsePublishedPath,
  paths,
  admissionRecord,
  scorecard,
  eventLine,
  indexDoc,
  certificationSummary,
  validateAdmission,
  validateScorecard,
  validateEvent,
  validateIndex,
  validateCertificationSummary,
  serialize
};
