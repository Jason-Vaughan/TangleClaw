'use strict';

/**
 * The soak's evidence bundle (#2020): one directory holding everything a
 * finished (or failed) soak produced, with a manifest that binds every file.
 *
 * `buildBundle` copies the schedule, the driver's log and any sidecar beside
 * it, the integrity samples and the guest attestations the operator names,
 * and takes a consistent snapshot of the guest database (`VACUUM INTO`), which
 * it checks with `integrity_check`. `manifest.json` names each file with its
 * size and sha256, names the release candidate the operator says the soak
 * ran (`candidateSha`), and carries a summary: the log's disposition as the
 * driver reads it, event outcomes by kind, and the samples' worst readings.
 *
 * It judges nothing, and it never refuses because the run went badly: a log
 * the driver will not read as evidence (a lost lock, an open segment) is
 * still bundled, with the refusal recorded, because that is exactly the run
 * an operator needs to investigate. It refuses only what would make the
 * bundle itself untrustworthy: an existing output directory, a missing,
 * malformed or abbreviated candidate SHA, a missing or symlinked input, or
 * two inputs that would land on the same name.
 *
 * @module lib/soak/bundle
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const driver = require('./driver');
const scheduleLib = require('./schedule');
const integrity = require('./integrity');
const local = require('./local');

const MANIFEST_SCHEMA = 'tc.soak-evidence/v1';

/**
 * A release candidate's full commit SHA. The bundle binds the exact candidate
 * the soak ran, so only the full 40 lowercase hex characters are accepted: an
 * abbreviation could name a different commit.
 */
const CANDIDATE_SHA_RE = /^[0-9a-f]{40}$/;

/** A bundle input that cannot be used: exit 3 with this code. */
class BundleRefusal extends Error {
  /**
   * @param {string} message - What is wrong
   */
  constructor(message) {
    super(message);
    this.name = 'BundleRefusal';
    this.code = 'BUNDLE_REFUSED';
  }
}

/**
 * The sha256 and size of a file.
 * @param {string} file - File
 * @returns {{bytes: number, sha256: string}} Its size and digest
 */
function fileDigest(file) {
  const buf = fs.readFileSync(file);
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/**
 * Refuse an input that is missing or not a plain file. A symlink is refused
 * rather than followed, so the bundle holds exactly the file named.
 * @param {string} file - Input path
 * @param {string} what - What it is, for the message
 */
function _requirePlainFile(file, what) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new BundleRefusal(`${what} ${file} does not exist`);
    throw err;
  }
  if (!st.isFile()) throw new BundleRefusal(`${what} ${file} is not a regular file`);
}

/**
 * Copy one input into the bundle, owner-only.
 * @param {string} from - Source
 * @param {string} out - Bundle directory
 * @param {string} rel - Path inside the bundle
 * @returns {string} The destination
 */
function _copyIn(from, out, rel) {
  const to = path.join(out, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, 0o600);
  return to;
}

/**
 * Summarize a log's records: event outcomes by kind, and whether it ended.
 * Lines that are not JSON (a torn tail, a sealed fragment) are counted, not
 * read.
 * @param {string} logPath - Log file
 * @returns {{scheduleDigest: string|null, ended: boolean, unparsedLines: number, byKind: Object<string, {ran: number, ok: number, failed: number, skipped: number, codes: Object<string, number>}>}} Summary
 */
function summarizeLog(logPath) {
  const out = { scheduleDigest: null, ended: false, unparsedLines: 0, byKind: {} };
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    if (line === '') continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      out.unparsedLines++;
      continue;
    }
    if (r.type === 'header') out.scheduleDigest = r.scheduleDigest;
    if (r.type === 'end') out.ended = true;
    if (r.type !== 'event') continue;
    const k = out.byKind[r.kind] || (out.byKind[r.kind] = { ran: 0, ok: 0, failed: 0, skipped: 0, codes: {} });
    if (r.skipped) k.skipped++;
    else {
      k.ran++;
      if (r.ok === true) k.ok++;
      else k.failed++;
    }
    if (r.ok !== true) k.codes[r.code] = (k.codes[r.code] || 0) + 1;
  }
  return out;
}

/**
 * The driver's own reading of a log: its disposition, or why it refuses it.
 * @param {string} logPath - Log file
 * @returns {object} `{readable: true, ended, ownership, certification}` or `{readable: false, refusal: {code, message}}`
 */
function logDisposition(logPath) {
  try {
    const r = driver.readLog(logPath);
    return { readable: true, ended: r.ended, tornTail: r.tornTail, ownership: r.ownership, certification: r.certification };
  } catch (err) {
    if (!(err instanceof driver.DriverRefusal)) throw err;
    return { readable: false, refusal: { code: err.code, message: err.message } };
  }
}

/**
 * The samples' coverage and worst readings over the run. Coverage comes
 * first: a clean verdict from samples that stopped early is not a clean run,
 * so the first and last sample times, the largest gap between samples, and
 * how many samples failed are all reported.
 * @param {{samples: object[], tornTail: boolean}} read - From `integrity.readSamples`
 * @returns {object} Summary
 */
function summarizeSamples(read) {
  const all = read.samples;
  const ok = all.filter((x) => x.type === 'sample');
  let largestGapMs = null;
  for (let i = 1; i < all.length; i++) largestGapMs = Math.max(largestGapMs || 0, all[i].at - all[i - 1].at);
  const db = { ok: 0, corrupt: 0, unavailable: 0, firstCorrupt: null };
  let rssMin = null;
  let rssMax = null;
  let fdMax = null;
  let freeMin = null;
  let processDown = 0;
  let processUnknown = 0;
  let healthBad = 0;
  for (const x of ok) {
    db[x.db.state] = (db[x.db.state] || 0) + 1;
    if (x.db.state === integrity.DB_STATE.CORRUPT && db.firstCorrupt === null) db.firstCorrupt = { seq: x.seq, at: x.at, check: x.db.check };
    if (x.process.alive === true) {
      rssMin = rssMin === null ? x.process.rssKb : Math.min(rssMin, x.process.rssKb);
      rssMax = rssMax === null ? x.process.rssKb : Math.max(rssMax, x.process.rssKb);
      if (x.process.openFds !== null) fdMax = fdMax === null ? x.process.openFds : Math.max(fdMax, x.process.openFds);
    } else if (x.process.alive === false) processDown++;
    else processUnknown++;
    freeMin = freeMin === null ? x.disk.freeBytes : Math.min(freeMin, x.disk.freeBytes);
    if (x.health.status !== 200) healthBad++;
  }
  return {
    // The interval the sampler was asked for, from its header, so a coverage
    // check compares gaps against this run's own interval.
    intervalMs: read.header && Number.isInteger(read.header.intervalMs) ? read.header.intervalMs : null,
    count: ok.length,
    failed: all.length - ok.length,
    firstAt: all.length > 0 ? all[0].at : null,
    lastAt: all.length > 0 ? all[all.length - 1].at : null,
    largestGapMs,
    tornTail: read.tornTail,
    db,
    rssKb: { min: rssMin, max: rssMax },
    openFdsMax: fdMax,
    freeBytesMin: freeMin,
    processDown,
    processUnknown,
    healthNot200: healthBad
  };
}

/**
 * Snapshot the guest database into the bundle and check the copy.
 * `VACUUM INTO` runs in one read transaction, so the copy is consistent even
 * while the server writes.
 * @param {string} home - Guest TangleClaw home
 * @param {string} to - Snapshot path
 * @returns {object} `{state, check, bytes}` or `{error}`
 */
function snapshotDatabase(home, to) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  let db = null;
  try {
    db = new DatabaseSync(path.join(home, local.DB_FILE), { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(to);
  } catch (err) {
    if (err && typeof err.errcode === 'number') return { error: String(err.errstr || err.message) };
    throw err;
  } finally {
    if (db) db.close();
  }
  fs.chmodSync(to, 0o600);
  const verdict = integrity.checkDatabase(to, 'integrity_check');
  return { ...verdict, bytes: fs.statSync(to).size };
}

/**
 * Build the evidence bundle.
 * @param {object} opts - Inputs
 * @param {string} opts.out - Bundle directory; must not exist
 * @param {string} opts.candidateSha - The release candidate the soak ran, as the operator pinned it: full 40-hex SHA
 * @param {string} opts.schedule - Schedule file
 * @param {string} opts.log - Driver log
 * @param {string} [opts.samples] - Integrity samples file
 * @param {string} [opts.home] - Guest TangleClaw home, for the database snapshot, already admitted by `local.admitGuestReader`
 * @param {string[]} [opts.attestations] - Guest attestation files
 * @param {() => number} [opts.now] - Clock
 * @returns {{out: string, manifest: string, manifestSha256: string, summary: object}} Where it is, and what it says
 * @throws {BundleRefusal} On an unusable input or an existing output
 */
function buildBundle(opts) {
  const now = opts.now || Date.now;
  if (typeof opts.out !== 'string' || !path.isAbsolute(opts.out)) throw new BundleRefusal('--out must be an absolute path');
  if (fs.existsSync(opts.out)) throw new BundleRefusal(`${opts.out} already exists: a bundle is written once, into a new directory`);
  // The candidate is stated by the operator, never inferred from a checkout
  // or from the certification run it will be judged against: the judge
  // compares the two, so taking one from the other would bind nothing.
  if (typeof opts.candidateSha !== 'string' || !CANDIDATE_SHA_RE.test(opts.candidateSha)) {
    throw new BundleRefusal('--candidate-sha must be the pinned release candidate\'s full 40-character lowercase hex SHA');
  }
  _requirePlainFile(opts.schedule, 'schedule');
  _requirePlainFile(opts.log, 'log');
  if (opts.samples !== undefined) _requirePlainFile(opts.samples, 'samples');
  const attestations = opts.attestations || [];
  for (const a of attestations) _requirePlainFile(a, 'attestation');
  const names = attestations.map((a) => path.basename(a));
  if (new Set(names).size !== names.length) throw new BundleRefusal('two attestations share a file name; rename one');
  // `--home` is admitted by the caller (`local.admitGuestReader`): the
  // snapshot reads a TangleClaw database, which is only done in the guest.
  const home = opts.home === undefined ? null : opts.home;

  let schedule;
  try {
    schedule = JSON.parse(fs.readFileSync(opts.schedule, 'utf8'));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new BundleRefusal(`schedule ${opts.schedule} is not JSON`);
  }
  const violations = scheduleLib.validateSchedule(schedule);
  let samplesRead = null;
  if (opts.samples !== undefined) {
    try {
      samplesRead = integrity.readSamples(opts.samples);
    } catch (err) {
      // Damaged samples are still bundled, with what could not be read.
      if (err.code !== 'SAMPLES_UNREADABLE') throw err;
      samplesRead = { unreadable: err.message };
    }
  }

  fs.mkdirSync(opts.out, { mode: 0o700 });
  const files = [];
  const add = (from, rel) => files.push({ path: rel, ...fileDigest(_copyIn(from, opts.out, rel)) });
  add(opts.schedule, 'schedule.json');
  add(opts.log, 'soak-log.ndjson');
  // The sidecars say why a log is not evidence; they travel with it.
  // Like every input, a sidecar is copied only as a regular file, never
  // through a symlink; anything else there is named in the summary instead.
  const sidecarsNotCopied = [];
  for (const side of [driver.lockLostPath(opts.log), driver.segmentPath(opts.log)]) {
    let st = null;
    try {
      st = fs.lstatSync(side);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (st && st.isFile()) add(side, `soak-log.ndjson${side.slice(opts.log.length)}`);
    else if (st) sidecarsNotCopied.push(path.basename(side));
  }
  if (opts.samples !== undefined) add(opts.samples, 'samples.ndjson');
  attestations.forEach((a, i) => add(a, path.join('attestations', names[i])));
  let snapshot = null;
  if (home) {
    const rel = path.join('db', local.DB_FILE);
    snapshot = snapshotDatabase(home, path.join(opts.out, rel));
    if (!snapshot.error) files.push({ path: rel, ...fileDigest(path.join(opts.out, rel)) });
  }

  const logSummary = summarizeLog(opts.log);
  const summary = {
    schedule: { digest: typeof schedule.digest === 'string' ? schedule.digest : null, valid: violations.length === 0, violations: violations.slice(0, 10), phase: schedule.params ? schedule.params.phase : null },
    // `ended` (from the driver's reading) is the log's verdict. `endRecordSeen`
    // is only this summary's own parse, kept for a log the driver refuses.
    log: { ...logDisposition(opts.log), scheduleMatches: logSummary.scheduleDigest !== null && logSummary.scheduleDigest === schedule.digest, endRecordSeen: logSummary.ended, unparsedLines: logSummary.unparsedLines, byKind: logSummary.byKind, ...(sidecarsNotCopied.length > 0 ? { sidecarsNotCopied } : {}) },
    samples: samplesRead === null ? null : (samplesRead.unreadable ? { unreadable: samplesRead.unreadable } : summarizeSamples(samplesRead)),
    dbSnapshot: snapshot
  };
  const manifest = { schema: MANIFEST_SCHEMA, candidateSha: opts.candidateSha, createdAt: now(), files, summary };
  const manifestPath = path.join(opts.out, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { out: opts.out, manifest: manifestPath, manifestSha256: fileDigest(manifestPath).sha256, summary };
}

module.exports = { MANIFEST_SCHEMA, CANDIDATE_SHA_RE, BundleRefusal, fileDigest, summarizeLog, logDisposition, summarizeSamples, snapshotDatabase, buildBundle };
