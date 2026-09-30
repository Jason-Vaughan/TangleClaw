'use strict';

/**
 * The soak's certification judge (#2020): read one evidence bundle and decide
 * whether it lets a release-certification run become a certification of
 * record.
 *
 * The bundle (`lib/soak/bundle`) records what a soak produced and judges
 * nothing. This module judges it, for exactly one certification run, and
 * fails closed: anything missing, malformed, unreadable or not bound to that
 * run is a reason, and a judgement with any reason has not passed.
 *
 * - **Nothing in the manifest's summary is trusted.** Every file the
 *   manifest lists is re-hashed, and a file the bundle holds that the
 *   manifest does not list is refused. The schedule is re-validated, the log
 *   re-read by the driver, the samples re-read and the database snapshot
 *   re-checked. Where the summary also states something the judge
 *   re-derives, the two must agree.
 * - **It is bound to one run.** The bundle must name the run's candidate SHA,
 *   and the soak's log must lie inside the run's own window. The judgement
 *   carries every digest it vouches for, so a record that holds it binds the
 *   exact evidence.
 * - **An ownership-unverified log fails and resets** unless the Operator has
 *   accepted exactly that log's bytes (`driver.acceptanceMatches`).
 * - **Every scheduled event is a required test.** Each must appear exactly
 *   once, as the event the schedule put at that index, run and `ok`. A fault
 *   passes only when its executor injected it and its recovery checks
 *   passed, so a fault that could not be injected or recovered fails the
 *   soak like any other event.
 * - **The schedule is the certifying 72-hour one, and the log spans it.** A
 *   shorter or destructive schedule never certifies a release, and neither
 *   does a log whose `end` came before its start plus the schedule's
 *   duration: the driver writes `end` only at that horizon.
 * - **The samples show the system's state throughout.** At least two must be
 *   evidence, covering the whole log with no gap longer than two sampling
 *   intervals. Data corruption in any sample fails the soak, and so does a
 *   server that is not alive and healthy at the last evidentiary sample. A
 *   sample that failed or could not measure is not evidence, and is
 *   tolerated only while the coverage still holds.
 *
 * It only reads files, so the host can run it on a bundle the transport
 * brought out of the guest. Whether a judgement is good enough to certify is
 * the certifier's decision, not this module's: the host's finalization
 * (`lib/release-certification/host-checks`) records it and accepts it only
 * when it passed and is bound to that exact run.
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

/** Why a judgement did not pass. Closed codes. */
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
  EVENT_MISSING: 'EVENT_MISSING',
  EVENT_DUPLICATE: 'EVENT_DUPLICATE',
  EVENT_UNKNOWN: 'EVENT_UNKNOWN',
  EVENT_COUNT_MISMATCH: 'EVENT_COUNT_MISMATCH',
  OWNERSHIP_UNVERIFIED: 'OWNERSHIP_UNVERIFIED',
  ACCEPTANCE_INVALID: 'ACCEPTANCE_INVALID',
  OUTSIDE_RUN_WINDOW: 'OUTSIDE_RUN_WINDOW',
  RUN_TOO_SHORT: 'RUN_TOO_SHORT',
  SAMPLES_MISSING: 'SAMPLES_MISSING',
  SAMPLES_UNREADABLE: 'SAMPLES_UNREADABLE',
  SAMPLES_TORN: 'SAMPLES_TORN',
  COVERAGE: 'COVERAGE',
  DATA_CORRUPTION: 'DATA_CORRUPTION',
  DB_SNAPSHOT_MISSING: 'DB_SNAPSHOT_MISSING',
  DB_SNAPSHOT_NOT_OK: 'DB_SNAPSHOT_NOT_OK',
  SERVER_NOT_RECOVERED: 'SERVER_NOT_RECOVERED'
});

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
 * once, as that event, and succeeded. The first instance of each problem is
 * named, with how many there were.
 * @param {object[]} records - The log's records
 * @param {object} schedule - The validated schedule
 * @param {object|null} end - The log's `end` record
 * @param {function(string, object=): void} add - Reason sink
 * @returns {void}
 */
function _judgeEvents(records, schedule, end, add) {
  const found = new Map();
  const problems = new Map();
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
      if (r.skipped === true) note(REASON.EVENT_SKIPPED, { index: r.index, kind: r.kind, eventCode: r.code });
      else if (r.ok !== true) note(REASON.EVENT_FAILED, { index: r.index, kind: r.kind, eventCode: r.code });
    }
  }
  for (const e of schedule.events) if (!found.has(e.index)) note(REASON.EVENT_MISSING, { index: e.index, kind: e.kind });
  if (end && end.events !== schedule.events.length) note(REASON.EVENT_COUNT_MISMATCH, { logged: end.events, scheduled: schedule.events.length });
  for (const [code, detail] of problems) add(code, detail);
}

/**
 * Re-read the bundled log with the driver, and judge its disposition.
 * @param {string} bundleDir - Bundle directory
 * @param {object} manifest - Bundle manifest
 * @param {object|null} schedule - The validated schedule
 * @param {object|null|undefined} acceptance - The Operator's acceptance, if any
 * @param {function(string, object=): void} add - Reason sink
 * @returns {{logBytes: number, logSha256: string, startedAt: number|null, completedAt: number|null, ownershipVerified: boolean, operatorAcceptance: object|null}|null} What the log binds, or null when it is refused
 */
function _judgeLog(bundleDir, manifest, schedule, acceptance, add) {
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
  if (!r.ended || !end || !Number.isSafeInteger(end.completedAt)) add(REASON.LOG_NOT_ENDED);
  if (r.tornTail) add(REASON.LOG_TORN);
  if (!r.header || (schedule && r.header.scheduleDigest !== schedule.digest)) add(REASON.LOG_SCHEDULE_MISMATCH);
  else if (schedule) _judgeEvents(records, schedule, end, add);
  const s = manifest.summary.log;
  if (!s || s.readable !== true || s.ended !== r.ended || !s.ownership || s.ownership.verified !== r.ownership.verified) add(REASON.SUMMARY_MISMATCH, { field: 'log' });
  const bound = {
    logBytes: buf.length,
    logSha256: _sha256(buf),
    startedAt: r.header ? r.header.startEpochMs : null,
    completedAt: end && Number.isSafeInteger(end.completedAt) ? end.completedAt : null,
    ownershipVerified: r.ownership.verified === true,
    operatorAcceptance: null
  };
  if (!bound.ownershipVerified) bound.operatorAcceptance = _judgeOwnership(s, bound, acceptance, add);
  return bound;
}

/**
 * An ownership-unverified log is `fail-reset` unless the Operator accepted
 * exactly its bytes: the acceptance must match the disposition the bundle
 * recorded for the original log, and name the bytes the bundle holds.
 * @param {object|undefined} summaryLog - The manifest's `summary.log`
 * @param {{logBytes: number, logSha256: string}} bound - The bundled log's size and digest
 * @param {object|null|undefined} acceptance - The Operator's acceptance
 * @param {function(string, object=): void} add - Reason sink
 * @returns {{actor: string, at: number, logSha256: string}|null} The acceptance relied on, or null
 */
function _judgeOwnership(summaryLog, bound, acceptance, add) {
  if (acceptance === null || acceptance === undefined) {
    add(REASON.OWNERSHIP_UNVERIFIED, { disposition: 'fail-reset' });
    return null;
  }
  if (typeof acceptance !== 'object' || typeof acceptance.actor !== 'string' || acceptance.actor.trim() === '' || !Number.isSafeInteger(acceptance.at)) {
    add(REASON.ACCEPTANCE_INVALID);
    return null;
  }
  const certification = summaryLog ? summaryLog.certification : null;
  if (!driver.acceptanceMatches(certification, acceptance) || acceptance.logBytes !== bound.logBytes || acceptance.logSha256 !== bound.logSha256) {
    add(REASON.OWNERSHIP_UNVERIFIED, { disposition: 'fail-reset', acceptance: 'does not cover this log' });
    return null;
  }
  return { actor: acceptance.actor, at: acceptance.at, logSha256: acceptance.logSha256 };
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
 * Judge one evidence bundle for one certification run.
 * @param {object} opts
 * @param {string} opts.bundleDir - The bundle directory (absolute)
 * @param {{candidateSha: string, runId: string, manifestDigest: string, startedAt: number, updatedAt: number}} opts.run - The certification run the bundle is judged for
 * @param {{logPath: string, logBytes: number, logSha256: string, actor: string, at: number}|null} [opts.acceptance] - The Operator's acceptance of an ownership-unverified log
 * @returns {{schema: string, passed: boolean, reasons: object[], binding: object}} The judgement; `binding` names every digest it vouches for, and the run it was judged for
 * @throws {TypeError} On a malformed run identity or a relative bundle path
 */
function judgeBundle(opts) {
  _requireRun(opts.run);
  if (typeof opts.bundleDir !== 'string' || !path.isAbsolute(opts.bundleDir)) throw new TypeError('bundleDir must be an absolute path');
  const reasons = [];
  // The code goes last, so no detail can overwrite it.
  const add = (code, extra = {}) => reasons.push({ ...extra, code });
  const run = opts.run;
  const binding = {
    candidateSha: run.candidateSha, runId: run.runId, manifestDigest: run.manifestDigest,
    bundleManifestSha256: null, bundleCandidateSha: null, scheduleDigest: null, logBytes: null, logSha256: null,
    soakStartedAt: null, soakCompletedAt: null, ownershipVerified: null, operatorAcceptance: null
  };
  const read = _readManifest(opts.bundleDir, add);
  if (read) {
    const { manifest } = read;
    binding.bundleManifestSha256 = read.manifestSha256;
    binding.bundleCandidateSha = typeof manifest.candidateSha === 'string' ? manifest.candidateSha : null;
    _judgeCandidate(manifest, run.candidateSha, add);
    const schedule = _judgeSchedule(opts.bundleDir, manifest, add);
    if (schedule) binding.scheduleDigest = schedule.digest;
    const log = _judgeLog(opts.bundleDir, manifest, schedule, opts.acceptance, add);
    if (log) {
      Object.assign(binding, { logBytes: log.logBytes, logSha256: log.logSha256, soakStartedAt: log.startedAt, soakCompletedAt: log.completedAt,
        ownershipVerified: log.ownershipVerified, operatorAcceptance: log.operatorAcceptance });
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
  return { schema: JUDGEMENT_SCHEMA, passed: reasons.length === 0, reasons, binding };
}

module.exports = { JUDGEMENT_SCHEMA, CERTIFYING_DURATION_MS, FILES, REASON, judgeBundle };
