'use strict';

/**
 * The soak's certification judge (#1949): read one evidence bundle and say
 * whether it lets a release-certification run become a certification of
 * record.
 *
 * The bundle (`lib/soak/bundle`) records what a soak produced and judges
 * nothing. This module judges it, for exactly one certification run, and
 * fails closed: anything missing, malformed, unreadable or not bound to that
 * run is a reason, and a judgement with any reason is not a pass.
 *
 * Reasons come in two classes that never mix.
 *
 * - **Terminal** reasons make the verdict `fail`, and nothing waives them:
 *   a bundle whose bytes are not the manifest's, a candidate, schedule or log
 *   that is not bound to the run, a log that is not whole, a run shorter than
 *   its schedule, samples that do not cover the log, data corruption, a
 *   server that did not come back, and any fault event that was not `ok`.
 *   A fault is the soak's test of recovery, so one that failed or never ran
 *   leaves recovery unproven.
 * - **Reviewable** findings make the verdict `awaiting-review`, which does
 *   not certify either. There are two: a load event that ran and was not
 *   `ok`, or was skipped, while its record is intact and sits exactly once in
 *   its scheduled slot; and a log the driver recorded as ownership-unverified
 *   after a crash, which the driver binds to the log's exact bytes.
 *
 * Only an Operator can let reviewable findings through, and this module
 * never records that anyone did. It reads a **disposition proposal**
 * (`tc.soak-disposition/v1`): a file naming each finding one at a time, with
 * a classification, a rationale, evidence and a tracking issue. The judge
 * checks that the proposal is bound to this exact bundle and run and covers
 * exactly the findings, and records the proposal's sha256. The verdict stays
 * `awaiting-review`. The approval is the operator-only `rc-cert accept`,
 * which binds that sha256 into the run's acceptance record; the host checks
 * the two agree before it certifies (`lib/release-certification`). Nothing
 * in the proposal says who approved it or when, because a file could claim
 * anything.
 *
 * Nothing in the manifest's summary is trusted either. Every listed file is
 * re-hashed, a file the manifest does not list is refused, the schedule is
 * re-validated, the log re-read by the driver, the samples re-read and the
 * database snapshot re-checked. Where the summary also states something the
 * judge re-derives, the two must agree.
 *
 * It only reads files, so the host can run it on a bundle the transport
 * brought out of the guest.
 *
 * @module lib/soak/judge
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const bundleLib = require('./bundle');
const driver = require('./driver');
const integrity = require('./integrity');
const scheduleLib = require('./schedule');

const JUDGEMENT_SCHEMA = 'tc.soak-judgement/v1';
const DISPOSITION_SCHEMA = 'tc.soak-disposition/v1';

/** The only schedule length that certifies a release: the 72-hour soak. */
const CERTIFYING_DURATION_MS = 72 * 60 * 60 * 1000;

/** Where the bundle puts each input the judge needs (`bundle.buildBundle`). */
const FILES = Object.freeze({
  manifest: 'manifest.json',
  schedule: 'schedule.json',
  log: 'soak-log.ndjson',
  samples: 'samples.ndjson',
  db: path.join('db', 'tangleclaw.db')
});

/** What a judgement concludes. `awaiting-review` and `fail` both block certification. */
const VERDICT = Object.freeze({ PASS: 'pass', AWAITING_REVIEW: 'awaiting-review', FAIL: 'fail' });

/** The class of a reason: what it does to the verdict. */
const CLASS = Object.freeze({ TERMINAL: 'terminal', REVIEWABLE: 'reviewable', DISPOSITION: 'disposition' });

/** What a disposition proposal says a finding was. Closed set. */
const CLASSIFICATIONS = Object.freeze(['harness', 'environment', 'candidate-finding']);

/** What became of a disposition proposal the judge was given. */
const DISPOSITION_STATE = Object.freeze({ COVERS: 'covers', REJECTED: 'rejected', NOT_APPLIED: 'not-applied' });

/** Why a judgement is not a pass. Closed codes. */
const REASON = Object.freeze({
  MANIFEST_MISSING: 'MANIFEST_MISSING',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  FILE_MISSING: 'FILE_MISSING',
  FILE_MISMATCH: 'FILE_MISMATCH',
  FILE_UNLISTED: 'FILE_UNLISTED',
  CANDIDATE_SHA_INVALID: 'CANDIDATE_SHA_INVALID',
  CANDIDATE_SHA_MISMATCH: 'CANDIDATE_SHA_MISMATCH',
  SCHEDULE_INVALID: 'SCHEDULE_INVALID',
  SCHEDULE_NOT_CERTIFYING: 'SCHEDULE_NOT_CERTIFYING',
  SCHEDULE_DURATION: 'SCHEDULE_DURATION',
  LOG_REFUSED: 'LOG_REFUSED',
  LOG_NOT_ENDED: 'LOG_NOT_ENDED',
  LOG_TORN: 'LOG_TORN',
  LOG_SCHEDULE_MISMATCH: 'LOG_SCHEDULE_MISMATCH',
  SUMMARY_MISMATCH: 'SUMMARY_MISMATCH',
  EVENT_FAILED: 'EVENT_FAILED',
  EVENT_SKIPPED: 'EVENT_SKIPPED',
  FAULT_FAILED: 'FAULT_FAILED',
  FAULT_SKIPPED: 'FAULT_SKIPPED',
  EVENT_MISSING: 'EVENT_MISSING',
  EVENT_DUPLICATE: 'EVENT_DUPLICATE',
  EVENT_UNKNOWN: 'EVENT_UNKNOWN',
  EVENT_COUNT_MISMATCH: 'EVENT_COUNT_MISMATCH',
  OWNERSHIP_UNVERIFIED: 'OWNERSHIP_UNVERIFIED',
  OUTSIDE_RUN_WINDOW: 'OUTSIDE_RUN_WINDOW',
  RUN_TOO_SHORT: 'RUN_TOO_SHORT',
  SAMPLES_MISSING: 'SAMPLES_MISSING',
  SAMPLES_UNREADABLE: 'SAMPLES_UNREADABLE',
  SAMPLES_TORN: 'SAMPLES_TORN',
  COVERAGE: 'COVERAGE',
  DATA_CORRUPTION: 'DATA_CORRUPTION',
  DB_SNAPSHOT_MISSING: 'DB_SNAPSHOT_MISSING',
  DB_SNAPSHOT_NOT_OK: 'DB_SNAPSHOT_NOT_OK',
  SERVER_NOT_RECOVERED: 'SERVER_NOT_RECOVERED',
  DISPOSITION_INVALID: 'DISPOSITION_INVALID',
  DISPOSITION_UNBOUND: 'DISPOSITION_UNBOUND',
  DISPOSITION_INCOMPLETE: 'DISPOSITION_INCOMPLETE',
  DISPOSITION_EXTRA_EVENT: 'DISPOSITION_EXTRA_EVENT',
  DISPOSITION_EVIDENCE: 'DISPOSITION_EVIDENCE'
});

/** The reasons an Operator may review. Every other reason about the bundle is terminal. */
const REVIEWABLE = Object.freeze([REASON.EVENT_FAILED, REASON.EVENT_SKIPPED, REASON.OWNERSHIP_UNVERIFIED]);

/**
 * The class of a reason code.
 * @param {string} code - A `REASON` code
 * @returns {string} Its `CLASS`
 */
function classOf(code) {
  if (REVIEWABLE.includes(code)) return CLASS.REVIEWABLE;
  return code.startsWith('DISPOSITION_') ? CLASS.DISPOSITION : CLASS.TERMINAL;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * The sha256 of a buffer.
 * @param {Buffer} buf - Bytes
 * @returns {string} Hex digest
 */
function _sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Every regular file and symlink under a directory, as paths relative to it.
 * @param {string} dir - Directory
 * @param {string} [rel] - Prefix so far
 * @returns {string[]} Relative paths
 */
function _listFiles(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(..._listFiles(dir, p));
    else out.push(p);
  }
  return out;
}

/**
 * Read and hash the manifest, and check each listed file against the bytes
 * on disk. A file that is missing, a symlink, outside the bundle or of other
 * bytes, and a file on disk the manifest does not list, all make the bundle
 * untrustworthy, so nothing else in it is judged.
 * @param {string} bundleDir - Bundle directory
 * @param {function(string, object=): void} add - Reason sink
 * @returns {{manifest: object, manifestSha256: string}|null} The manifest, or null when the bundle cannot be trusted
 */
function _readManifest(bundleDir, add) {
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(bundleDir, FILES.manifest));
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    add(REASON.MANIFEST_MISSING);
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    add(REASON.MANIFEST_INVALID, { detail: 'not JSON' });
    return null;
  }
  if (!manifest || manifest.schema !== bundleLib.MANIFEST_SCHEMA || !Array.isArray(manifest.files) || !manifest.summary || typeof manifest.summary !== 'object') {
    add(REASON.MANIFEST_INVALID, { detail: `not a ${bundleLib.MANIFEST_SCHEMA} manifest` });
    return null;
  }
  return _checkFiles(bundleDir, manifest, add) ? { manifest, manifestSha256: _sha256(bytes) } : null;
}

/**
 * Check every listed file's bytes, and that nothing unlisted is present.
 * @param {string} bundleDir - Bundle directory
 * @param {object} manifest - Parsed manifest
 * @param {function(string, object=): void} add - Reason sink
 * @returns {boolean} True when the bundle's files are exactly the manifest's
 */
function _checkFiles(bundleDir, manifest, add) {
  let ok = true;
  const listed = new Set();
  for (const f of manifest.files) {
    const rel = f && typeof f.path === 'string' ? f.path : null;
    if (rel === null || path.isAbsolute(rel) || path.normalize(rel) !== rel || rel.split(path.sep).includes('..') || rel === FILES.manifest
      || !Number.isSafeInteger(f.bytes) || typeof f.sha256 !== 'string' || !DIGEST_RE.test(f.sha256) || listed.has(rel)) {
      add(REASON.MANIFEST_INVALID, { detail: 'a file entry is malformed, repeated or outside the bundle' });
      return false;
    }
    listed.add(rel);
    let st = null;
    try {
      st = fs.lstatSync(path.join(bundleDir, rel));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
    if (!st || !st.isFile()) {
      add(REASON.FILE_MISSING, { file: rel });
      ok = false;
      continue;
    }
    const buf = fs.readFileSync(path.join(bundleDir, rel));
    if (buf.length !== f.bytes || _sha256(buf) !== f.sha256) {
      add(REASON.FILE_MISMATCH, { file: rel });
      ok = false;
    }
  }
  for (const rel of _listFiles(bundleDir)) {
    if (rel !== FILES.manifest && !listed.has(rel)) {
      add(REASON.FILE_UNLISTED, { file: rel });
      ok = false;
    }
  }
  // The schedule and the log are what every other judgement is about, so a
  // bundle without them, as regular files it binds, has nothing to judge.
  for (const rel of [FILES.schedule, FILES.log]) {
    if (!listed.has(rel)) {
      add(REASON.FILE_MISSING, { file: rel });
      ok = false;
    }
  }
  return ok;
}

/**
 * Judge the candidate the bundle names against the run's (A5): it must be
 * stated, be a full SHA, and be the run's own.
 * @param {object} manifest - Bundle manifest
 * @param {string} expected - The run's candidate SHA
 * @param {function(string, object=): void} add - Reason sink
 * @returns {void}
 */
function _judgeCandidate(manifest, expected, add) {
  if (typeof manifest.candidateSha !== 'string' || !bundleLib.CANDIDATE_SHA_RE.test(manifest.candidateSha)) add(REASON.CANDIDATE_SHA_INVALID);
  else if (manifest.candidateSha !== expected) add(REASON.CANDIDATE_SHA_MISMATCH, { bundle: manifest.candidateSha, run: expected });
}

/**
 * Re-validate the bundled schedule, which must be a certifying one.
 * @param {string} bundleDir - Bundle directory
 * @param {object} manifest - Bundle manifest
 * @param {function(string, object=): void} add - Reason sink
 * @returns {object|null} The schedule, or null when it is unusable
 */
function _judgeSchedule(bundleDir, manifest, add) {
  let schedule;
  try {
    schedule = JSON.parse(fs.readFileSync(path.join(bundleDir, FILES.schedule), 'utf8'));
  } catch (err) {
    if (!(err instanceof SyntaxError) && err.code !== 'ENOENT') throw err;
    add(REASON.SCHEDULE_INVALID, { detail: err.code === 'ENOENT' ? 'absent' : 'not JSON' });
    return null;
  }
  const violations = scheduleLib.validateSchedule(schedule);
  if (violations.length > 0) {
    add(REASON.SCHEDULE_INVALID, { detail: String(violations[0]) });
    return null;
  }
  if (schedule.params.phase !== 'certifying') add(REASON.SCHEDULE_NOT_CERTIFYING, { phase: schedule.params.phase });
  if (schedule.params.durationMs !== CERTIFYING_DURATION_MS) add(REASON.SCHEDULE_DURATION, { durationMs: schedule.params.durationMs, required: CERTIFYING_DURATION_MS });
  const s = manifest.summary.schedule;
  if (!s || s.digest !== schedule.digest) add(REASON.SUMMARY_MISMATCH, { field: 'schedule.digest' });
  return schedule;
}

/**
 * The log's records, as the driver reads them. Only called on a log the
 * driver has read as evidence. A region a `torn-tail-sealed` record binds is
 * a crashed write the driver discarded and ran again, even when the fragment
 * happens to be a whole JSON record (a crash that lost only its newline), so
 * it is skipped by its byte offset, never counted. The only other lines that
 * are not JSON are sealed fragments too.
 * @param {Buffer} buf - Log bytes
 * @returns {object[]} Its JSON records, in order
 */
function _records(buf) {
  const lines = [];
  for (let start = 0; start < buf.length;) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    if (end > start) lines.push({ offset: start, text: buf.subarray(start, end).toString('utf8') });
    start = end + 1;
  }
  const parsed = lines.map((l) => {
    try {
      return { offset: l.offset, record: JSON.parse(l.text) };
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return null;
    }
  }).filter(Boolean);
  const sealed = new Set(parsed.filter((p) => p.record && p.record.type === 'torn-tail-sealed' && Number.isSafeInteger(p.record.offset)).map((p) => p.record.offset));
  return parsed.filter((p) => !sealed.has(p.offset)).map((p) => p.record);
}

/**
 * Judge the events: every event the schedule holds must have run exactly
 * once, as that event, and succeeded. A record that is missing, repeated or
 * not the schedule's is terminal, and so is a fault that was not `ok`. A load
 * event that ran and was not `ok`, or was skipped, is a reviewable finding.
 * Each reason names its first instance and how many there were; the findings
 * list every reviewable one.
 * @param {object[]} records - The log's records
 * @param {object} schedule - The validated schedule
 * @param {object|null} end - The log's `end` record
 * @param {function(string, object=): void} add - Reason sink
 * @returns {{type: 'event', index: number, kind: string, eventCode: string|null, skipped: boolean}[]} The reviewable event findings, in log order
 */
function _judgeEvents(records, schedule, end, add) {
  const found = new Map();
  const problems = new Map();
  const findings = [];
  const note = (code, detail) => {
    const p = problems.get(code);
    if (p) p.count++;
    else problems.set(code, { ...detail, count: 1 });
  };
  for (const r of records) {
    if (!r || r.type !== 'event') continue;
    const expected = Number.isInteger(r.index) ? schedule.events[r.index] : undefined;
    if (!expected || r.kind !== expected.kind) note(REASON.EVENT_UNKNOWN, { index: r.index, kind: r.kind });
    else if (found.has(r.index)) note(REASON.EVENT_DUPLICATE, { index: r.index });
    else {
      found.set(r.index, r);
      const skipped = r.skipped === true;
      if (!skipped && r.ok === true) continue;
      const eventCode = typeof r.code === 'string' ? r.code : null;
      if (expected.class === 'fault') note(skipped ? REASON.FAULT_SKIPPED : REASON.FAULT_FAILED, { index: r.index, kind: r.kind, eventCode });
      else {
        note(skipped ? REASON.EVENT_SKIPPED : REASON.EVENT_FAILED, { index: r.index, kind: r.kind, eventCode });
        findings.push({ type: 'event', index: r.index, kind: r.kind, eventCode, skipped });
      }
    }
  }
  for (const e of schedule.events) if (!found.has(e.index)) note(REASON.EVENT_MISSING, { index: e.index, kind: e.kind });
  if (end && end.events !== schedule.events.length) note(REASON.EVENT_COUNT_MISMATCH, { logged: end.events, scheduled: schedule.events.length });
  for (const [code, detail] of problems) add(code, detail);
  return findings;
}

/**
 * Re-read the bundled log with the driver, and judge it.
 * @param {string} bundleDir - Bundle directory
 * @param {object} manifest - Bundle manifest
 * @param {object|null} schedule - The validated schedule
 * @param {function(string, object=): void} add - Reason sink
 * @returns {{logBytes: number, logSha256: string, startedAt: number|null, completedAt: number|null, ownershipVerified: boolean, findings: object[]}|null} What the log binds and its reviewable findings, or null when it is refused
 */
function _judgeLog(bundleDir, manifest, schedule, add) {
  const logPath = path.join(bundleDir, FILES.log);
  const buf = fs.readFileSync(logPath);
  let r;
  try {
    r = driver.readLog(logPath);
  } catch (err) {
    if (!(err instanceof driver.DriverRefusal)) throw err;
    add(REASON.LOG_REFUSED, { refusal: err.code });
    return null;
  }
  const records = _records(buf);
  const last = records[records.length - 1];
  const end = r.ended && last && last.type === 'end' ? last : null;
  let findings = [];
  if (!r.ended || !end || !Number.isSafeInteger(end.completedAt)) add(REASON.LOG_NOT_ENDED);
  if (r.tornTail) add(REASON.LOG_TORN);
  if (!r.header || (schedule && r.header.scheduleDigest !== schedule.digest)) add(REASON.LOG_SCHEDULE_MISMATCH);
  else if (schedule) findings = _judgeEvents(records, schedule, end, add);
  const s = manifest.summary.log;
  if (!s || s.readable !== true || s.ended !== r.ended || !s.ownership || s.ownership.verified !== r.ownership.verified) add(REASON.SUMMARY_MISMATCH, { field: 'log' });
  const bound = {
    logBytes: buf.length,
    logSha256: _sha256(buf),
    startedAt: r.header ? r.header.startEpochMs : null,
    completedAt: end && Number.isSafeInteger(end.completedAt) ? end.completedAt : null,
    ownershipVerified: r.ownership.verified === true,
    findings
  };
  if (!bound.ownershipVerified) _judgeOwnership(s, bound, add);
  return bound;
}

/**
 * An ownership-unverified log is the one provenance state an Operator may
 * review, because the driver records it deliberately after a crash and binds
 * it to the log's exact bytes. It is reviewable only in that exact form: the
 * evidence the bundle recorded for the original log must name the bytes the
 * bundle holds. Anything else is an ownership record that does not match its
 * log, which is terminal.
 * @param {object|undefined} summaryLog - The manifest's `summary.log`
 * @param {{logBytes: number, logSha256: string, findings: object[]}} bound - The bundled log's size, digest and findings; the ownership finding is added to it
 * @param {function(string, object=): void} add - Reason sink
 * @returns {void}
 */
function _judgeOwnership(summaryLog, bound, add) {
  const cert = summaryLog ? summaryLog.certification : null;
  const e = cert && cert.operatorAcceptance ? cert.operatorAcceptance.evidence : null;
  if (!e || typeof e.logPath !== 'string' || e.logBytes !== bound.logBytes || e.logSha256 !== bound.logSha256) {
    add(REASON.SUMMARY_MISMATCH, { field: 'log.certification' });
    return;
  }
  add(REASON.OWNERSHIP_UNVERIFIED, { disposition: 'fail-reset' });
  bound.findings.push({ type: 'ownership', logPath: e.logPath, logBytes: e.logBytes, logSha256: e.logSha256 });
}

/**
 * Whether a sample is evidence of the system's state: a completed sample
 * whose database check ran and whose server liveness is known.
 * @param {object} x - Sample record: a sample with no time can place nothing, so it is not evidence
 * @returns {boolean} True when it is evidence
 */
function _evidentiary(x) {
  return x.type === 'sample' && Number.isSafeInteger(x.at) && x.db && x.db.state !== integrity.DB_STATE.UNAVAILABLE && x.process && typeof x.process.alive === 'boolean';
}

/**
 * Judge the integrity samples: they must cover the whole log, show no
 * corruption, and end with the server alive and healthy.
 * @param {string} bundleDir - Bundle directory
 * @param {object} manifest - Bundle manifest
 * @param {{startedAt: number|null, completedAt: number|null}|null} log - The log's window
 * @param {function(string, object=): void} add - Reason sink
 * @returns {void}
 */
function _judgeSamples(bundleDir, manifest, log, add) {
  if (!manifest.files.some((f) => f.path === FILES.samples)) {
    add(REASON.SAMPLES_MISSING);
    return;
  }
  let read;
  try {
    read = integrity.readSamples(path.join(bundleDir, FILES.samples));
  } catch (err) {
    // The sampler's reader assumes each line is an object; a line that is
    // JSON but not an object (`null`) fails there as a TypeError.
    if (err.code !== 'SAMPLES_UNREADABLE' && !(err instanceof TypeError)) throw err;
    add(REASON.SAMPLES_UNREADABLE);
    return;
  }
  if (read.tornTail) add(REASON.SAMPLES_TORN);
  const corrupt = read.samples.find((x) => x.type === 'sample' && x.db && x.db.state === integrity.DB_STATE.CORRUPT);
  if (corrupt) add(REASON.DATA_CORRUPTION, { sampleSeq: corrupt.seq });
  const interval = read.header && Number.isSafeInteger(read.header.intervalMs) && read.header.intervalMs > 0 ? read.header.intervalMs : null;
  const ev = read.samples.filter(_evidentiary);
  if (interval === null) add(REASON.SAMPLES_UNREADABLE, { detail: 'no sampling interval' });
  else _judgeCoverage(ev, interval, log, add);
  const last = ev[ev.length - 1];
  if (!last || last.process.alive !== true || !last.health || last.health.status !== 200) add(REASON.SERVER_NOT_RECOVERED, last ? { sampleSeq: last.seq } : {});
}

/**
 * At least two evidentiary samples must cover the log: the first within one
 * sampling interval of its start, the last within one of its end, and no gap
 * between them longer than two intervals.
 * @param {object[]} ev - Evidentiary samples, in order
 * @param {number} interval - The sampler's interval, ms
 * @param {{startedAt: number|null, completedAt: number|null}|null} log - The log's window
 * @param {function(string, object=): void} add - Reason sink
 * @returns {void}
 */
function _judgeCoverage(ev, interval, log, add) {
  if (ev.length < 2) {
    add(REASON.COVERAGE, { detail: 'fewer than two evidentiary samples' });
    return;
  }
  if (!log || log.startedAt === null || log.completedAt === null) {
    add(REASON.COVERAGE, { detail: 'the log has no window to cover' });
    return;
  }
  for (let i = 1; i < ev.length; i++) {
    if (ev[i].at <= ev[i - 1].at) {
      add(REASON.COVERAGE, { detail: 'out-of-order', afterSampleSeq: ev[i - 1].seq });
      return;
    }
  }
  if (ev[0].at - log.startedAt > interval) add(REASON.COVERAGE, { detail: 'late-start' });
  if (log.completedAt - ev[ev.length - 1].at > interval) add(REASON.COVERAGE, { detail: 'early-stop' });
  for (let i = 1; i < ev.length; i++) {
    if (ev[i].at - ev[i - 1].at > 2 * interval) {
      add(REASON.COVERAGE, { detail: 'gap', afterSampleSeq: ev[i - 1].seq });
      break;
    }
  }
}

/**
 * Re-check the bundled database snapshot with a full `integrity_check`.
 * @param {string} bundleDir - Bundle directory
 * @param {object} manifest - Bundle manifest
 * @param {function(string, object=): void} add - Reason sink
 * @returns {void}
 */
function _judgeSnapshot(bundleDir, manifest, add) {
  if (!manifest.files.some((f) => f.path === FILES.db)) {
    add(REASON.DB_SNAPSHOT_MISSING);
    return;
  }
  const verdict = integrity.checkDatabase(path.join(bundleDir, FILES.db), 'integrity_check');
  if (verdict.state !== integrity.DB_STATE.OK) add(REASON.DB_SNAPSHOT_NOT_OK, { state: verdict.state });
}

/**
 * Validate the identity of the run a bundle is judged for. These come from
 * the certification run itself, so a bad value is a caller's bug.
 * @param {object} run - `{candidateSha, runId, manifestDigest, startedAt, updatedAt}`
 * @returns {void}
 * @throws {TypeError} On a malformed run identity
 */
function _requireRun(run) {
  if (!run || typeof run.candidateSha !== 'string' || !bundleLib.CANDIDATE_SHA_RE.test(run.candidateSha)) throw new TypeError('run.candidateSha must be a full 40-hex SHA');
  if (typeof run.runId !== 'string' || run.runId === '') throw new TypeError('run.runId is required');
  if (typeof run.manifestDigest !== 'string' || run.manifestDigest === '') throw new TypeError('run.manifestDigest is required');
  if (!Number.isSafeInteger(run.startedAt) || !Number.isSafeInteger(run.updatedAt)) throw new TypeError('run.startedAt and run.updatedAt must be epoch ms');
}

/**
 * Whether an object has exactly the named keys, with `optional` ones allowed.
 * @param {*} o - Candidate
 * @param {string[]} required - Keys that must be present
 * @param {string[]} [optional] - Keys that may be
 * @returns {boolean} True for a plain object with only those keys
 */
function _exactKeys(o, required, optional = []) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = Object.keys(o);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

/**
 * Whether a value is a tracking issue: a repository and a positive issue number.
 * @param {*} t - Candidate
 * @returns {boolean} True when valid
 */
function _validIssue(t) {
  return _exactKeys(t, ['repo', 'number']) && typeof t.repo === 'string' && REPO_RE.test(t.repo) && Number.isSafeInteger(t.number) && t.number > 0;
}

/**
 * Whether a value is a rationale: prose, not blank.
 * @param {*} r - Candidate
 * @returns {boolean} True when valid
 */
function _validRationale(r) {
  return typeof r === 'string' && r.trim() !== '';
}

/**
 * Whether a proposal's evidence list names only the bundle's own files: at
 * least one entry, each a normalized bundle-relative path the manifest lists
 * with exactly that sha256, reached through no symlink. A path outside the
 * bundle, or a file the manifest does not bind, is evidence of nothing.
 * @param {*} evidence - The proposal's `evidence`
 * @param {string} bundleDir - Bundle directory
 * @param {object} manifest - Bundle manifest, whose files the judge has already re-hashed
 * @returns {boolean} True when every entry is bound
 */
function _validEvidence(evidence, bundleDir, manifest) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  return evidence.every((e) => {
    if (!_exactKeys(e, ['path', 'sha256']) || typeof e.path !== 'string' || e.path === '' || typeof e.sha256 !== 'string') return false;
    if (path.isAbsolute(e.path) || path.normalize(e.path) !== e.path || e.path.split(path.sep).includes('..')) return false;
    if (!manifest.files.some((f) => f.path === e.path && f.sha256 === e.sha256)) return false;
    // The bundle's own file check already fails a bundle holding a symlink,
    // so this cannot fire on a bundle that got this far. It is kept so the
    // rule is stated where evidence is read, not left to a distant check.
    let at = bundleDir;
    for (const part of e.path.split(path.sep)) {
      at = path.join(at, part);
      if (fs.lstatSync(at).isSymbolicLink()) return false;
    }
    return true;
  });
}

/**
 * Check a proposal's event entries against the reviewable event findings:
 * each well formed, each naming one finding by its index, kind and code, none
 * twice, and together all of them.
 * @param {*} events - The proposal's `events`
 * @param {object[]} findings - The reviewable event findings
 * @param {string} bundleDir - Bundle directory
 * @param {object} manifest - Bundle manifest
 * @param {function(string, object=): void} add - Reason sink
 * @returns {object[]} The well-formed entries that name a finding
 */
function _judgeProposedEvents(events, findings, bundleDir, manifest, add) {
  const covered = new Map();
  if (!Array.isArray(events)) {
    add(REASON.DISPOSITION_INVALID, { detail: 'events must be a list' });
    return [];
  }
  for (const e of events) {
    if (!_exactKeys(e, ['index', 'kind', 'eventCode', 'classification', 'rationale', 'evidence', 'trackingIssue']) || !Number.isSafeInteger(e.index)
      || !CLASSIFICATIONS.includes(e.classification) || !_validRationale(e.rationale) || !_validIssue(e.trackingIssue)) {
      add(REASON.DISPOSITION_INVALID, { detail: 'an event entry is malformed', index: e && Number.isSafeInteger(e.index) ? e.index : null });
      continue;
    }
    const finding = findings.find((f) => f.index === e.index && f.kind === e.kind && f.eventCode === e.eventCode);
    if (!finding || covered.has(e.index)) {
      add(REASON.DISPOSITION_EXTRA_EVENT, { index: e.index });
      continue;
    }
    if (!_validEvidence(e.evidence, bundleDir, manifest)) {
      add(REASON.DISPOSITION_EVIDENCE, { index: e.index });
      continue;
    }
    covered.set(e.index, { ...finding, classification: e.classification, rationale: e.rationale, evidence: e.evidence, trackingIssue: e.trackingIssue });
  }
  const missing = findings.filter((f) => !covered.has(f.index));
  if (missing.length > 0) add(REASON.DISPOSITION_INCOMPLETE, { index: missing[0].index, count: missing.length });
  return [...covered.values()];
}

/**
 * Check a proposal's ownership entry against the ownership finding. It must
 * name exactly the evidence the driver recorded for the log
 * (`driver.acceptanceMatches`), which the judge has already tied to the
 * bundled bytes.
 * @param {*} proposed - The proposal's `ownership`, or undefined
 * @param {object|undefined} finding - The ownership finding, if the log is ownership-unverified
 * @param {object} manifest - Bundle manifest
 * @param {function(string, object=): void} add - Reason sink
 * @returns {object|null} The entry when it covers the finding
 */
function _judgeProposedOwnership(proposed, finding, manifest, add) {
  if (proposed === undefined) {
    if (finding) add(REASON.DISPOSITION_INCOMPLETE, { detail: 'ownership' });
    return null;
  }
  if (!finding) {
    add(REASON.DISPOSITION_EXTRA_EVENT, { detail: 'ownership' });
    return null;
  }
  if (!_exactKeys(proposed, ['logPath', 'logBytes', 'logSha256', 'rationale', 'trackingIssue']) || !_validRationale(proposed.rationale) || !_validIssue(proposed.trackingIssue)) {
    add(REASON.DISPOSITION_INVALID, { detail: 'the ownership entry is malformed' });
    return null;
  }
  if (!driver.acceptanceMatches(manifest.summary.log.certification, proposed)) {
    add(REASON.DISPOSITION_UNBOUND, { field: 'ownership' });
    return null;
  }
  return { ...finding, rationale: proposed.rationale, trackingIssue: proposed.trackingIssue };
}

/**
 * Judge a disposition proposal against the reviewable findings. It covers
 * them only when it is well formed, bound to exactly this bundle and run,
 * and names exactly the findings. It never changes the verdict: covering
 * findings is not approving them.
 * @param {Buffer} bytes - The proposal file's bytes
 * @param {object} binding - What the judge derived: the run and the bundle's digests
 * @param {object[]} findings - The reviewable findings
 * @param {string} bundleDir - Bundle directory
 * @param {object} manifest - Bundle manifest
 * @param {function(string, object=): void} add - Reason sink
 * @returns {object[]} The findings as the proposal disposes of them
 */
function _judgeDisposition(bytes, binding, findings, bundleDir, manifest, add) {
  let d;
  try {
    d = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    add(REASON.DISPOSITION_INVALID, { detail: 'not JSON' });
    return [];
  }
  const bound = ['candidateSha', 'runId', 'bundleManifestSha256', 'scheduleDigest', 'logSha256', 'logBytes'];
  if (!_exactKeys(d, ['schema', ...bound, 'events'], ['ownership']) || d.schema !== DISPOSITION_SCHEMA) {
    add(REASON.DISPOSITION_INVALID, { detail: `not a ${DISPOSITION_SCHEMA} proposal` });
    return [];
  }
  if (findings.length === 0) {
    add(REASON.DISPOSITION_INVALID, { detail: 'there is no reviewable finding to dispose of' });
    return [];
  }
  const unbound = bound.find((k) => d[k] !== binding[k]);
  if (unbound) {
    add(REASON.DISPOSITION_UNBOUND, { field: unbound });
    return [];
  }
  const events = _judgeProposedEvents(d.events, findings.filter((f) => f.type === 'event'), bundleDir, manifest, add);
  const ownership = _judgeProposedOwnership(d.ownership, findings.find((f) => f.type === 'ownership'), manifest, add);
  return ownership ? [...events, ownership] : events;
}

/**
 * Judge one evidence bundle for one certification run.
 * @param {object} opts
 * @param {string} opts.bundleDir - The bundle directory (absolute)
 * @param {{candidateSha: string, runId: string, manifestDigest: string, startedAt: number, updatedAt: number}} opts.run - The certification run the bundle is judged for
 * @param {Buffer|null} [opts.disposition] - The bytes of a disposition proposal for the reviewable findings
 * @returns {{schema: string, verdict: string, reasons: object[], findings: object[], disposition: {sha256: string, state: string, findings: object[]}|null, binding: object}} The judgement. `binding` names every digest it vouches for and the run it was judged for; `findings` lists every reviewable finding; `disposition` is the proposal's digest, whether it covers the findings, and the findings as it disposes of them
 * @throws {TypeError} On a malformed run identity, a relative bundle path, or a disposition that is not bytes
 */
function judgeBundle(opts) {
  _requireRun(opts.run);
  if (typeof opts.bundleDir !== 'string' || !path.isAbsolute(opts.bundleDir)) throw new TypeError('bundleDir must be an absolute path');
  const proposal = opts.disposition === undefined || opts.disposition === null ? null : opts.disposition;
  if (proposal !== null && !Buffer.isBuffer(proposal)) throw new TypeError('disposition must be the proposal file\'s bytes');
  const reasons = [];
  // The code and its class go last, so no detail can overwrite them.
  const add = (code, extra = {}) => reasons.push({ ...extra, code, class: classOf(code) });
  const run = opts.run;
  const binding = {
    candidateSha: run.candidateSha, runId: run.runId, manifestDigest: run.manifestDigest,
    bundleManifestSha256: null, bundleCandidateSha: null, scheduleDigest: null, logBytes: null, logSha256: null,
    soakStartedAt: null, soakCompletedAt: null, ownershipVerified: null
  };
  let findings = [];
  const read = _readManifest(opts.bundleDir, add);
  if (read) {
    const { manifest } = read;
    binding.bundleManifestSha256 = read.manifestSha256;
    binding.bundleCandidateSha = typeof manifest.candidateSha === 'string' ? manifest.candidateSha : null;
    _judgeCandidate(manifest, run.candidateSha, add);
    const schedule = _judgeSchedule(opts.bundleDir, manifest, add);
    if (schedule) binding.scheduleDigest = schedule.digest;
    const log = _judgeLog(opts.bundleDir, manifest, schedule, add);
    if (log) {
      findings = log.findings;
      Object.assign(binding, { logBytes: log.logBytes, logSha256: log.logSha256, soakStartedAt: log.startedAt, soakCompletedAt: log.completedAt, ownershipVerified: log.ownershipVerified });
      if (log.startedAt === null || log.completedAt === null || log.startedAt < run.startedAt || log.completedAt > run.updatedAt) {
        add(REASON.OUTSIDE_RUN_WINDOW, { soak: [log.startedAt, log.completedAt], run: [run.startedAt, run.updatedAt] });
      }
      if (schedule && log.startedAt !== null && log.completedAt !== null && log.completedAt - log.startedAt < schedule.params.durationMs) {
        add(REASON.RUN_TOO_SHORT, { ranMs: log.completedAt - log.startedAt, durationMs: schedule.params.durationMs });
      }
    }
    _judgeSamples(opts.bundleDir, manifest, log, add);
    _judgeSnapshot(opts.bundleDir, manifest, add);
  }
  const terminal = reasons.some((r) => r.class === CLASS.TERMINAL);
  let disposition = null;
  if (proposal !== null) {
    // A proposal is not read at all beside a terminal reason: nothing it
    // could say would matter, and reading it would only add noise.
    const disposed = terminal ? [] : _judgeDisposition(proposal, binding, findings, opts.bundleDir, read.manifest, add);
    const rejected = reasons.some((r) => r.class === CLASS.DISPOSITION);
    disposition = {
      sha256: _sha256(proposal),
      state: terminal ? DISPOSITION_STATE.NOT_APPLIED : (rejected ? DISPOSITION_STATE.REJECTED : DISPOSITION_STATE.COVERS),
      findings: terminal || rejected ? [] : disposed
    };
  }
  const verdict = terminal ? VERDICT.FAIL : (reasons.length > 0 ? VERDICT.AWAITING_REVIEW : VERDICT.PASS);
  return { schema: JUDGEMENT_SCHEMA, verdict, reasons, findings, disposition, binding };
}

module.exports = { JUDGEMENT_SCHEMA, DISPOSITION_SCHEMA, CERTIFYING_DURATION_MS, CLASSIFICATIONS, REASON, classOf, judgeBundle };
