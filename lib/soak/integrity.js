'use strict';

/**
 * Integrity and resource sampling for the release-candidate soak (#2020).
 *
 * The soak's acceptance gates need to see, over the whole run, whether the
 * guest's database stayed intact and whether the server leaked memory, file
 * descriptors or disk. The release-certification runner samples the server's
 * API and the guest's isolation. This sampler covers what it cannot see from
 * the API: the database file itself, the server process, and the disk.
 *
 * Each sample appends one record to an ndjson file, `0600`, flushed to disk
 * before the next. It judges nothing: a corrupt database is recorded as
 * `corrupt`, and the evidence bundle (`lib/soak/bundle.js`) and the
 * acceptance gates decide what that means.
 *
 * What a sample reads:
 * - **The database**, through its own read-only connection: `PRAGMA
 *   quick_check` on most samples and the full `integrity_check` on every
 *   `fullEvery`-th. Only a check that reports problems, or SQLite reporting
 *   the file corrupt or not a database, is `corrupt`; a check that could not
 *   run (the server holding a lock) is `unavailable`. Either check holds a shared lock while it runs, so the server's
 *   writers wait for it; on the soak's small database that is milliseconds.
 * - **The server process**, named by `<home>/tangleclaw.pid`: its resident
 *   memory (`ps`) and open file descriptors (`lsof`).
 * - **The disk** holding the home: free and total bytes.
 * - **`/api/health`**: its status and its own database verdict.
 *
 * The sampler reads the guest's home directly, so it runs only where the
 * driver's faults may: inside the soak guest, with no live install
 * (`lib/soak/local.js`).
 *
 * @module lib/soak/integrity
 */

const fs = require('node:fs');
const path = require('node:path');

const local = require('./local');

const SAMPLES_SCHEMA = 'tc.soak-samples/v1';

/** How often a full `integrity_check` replaces the `quick_check`, in samples. */
const FULL_EVERY = 6;

/** The default gap between samples. */
const INTERVAL_MS = 10 * 60 * 1000;

/** How long a sample waits on a database the server holds locked. */
const DB_BUSY_MS = 5000;

/** Problems kept from a failed check; the rest are counted. */
const MAX_PROBLEMS = 10;

/**
 * SQLite primary result codes that positively report damage. Any other error
 * (a lock the server holds, a file that cannot be opened) says the check did
 * not run, which is `unavailable`, never `corrupt`.
 */
const DAMAGE_CODES = new Set([11, 26]); // SQLITE_CORRUPT, SQLITE_NOTADB

/** Closed set of database verdicts. */
const DB_STATE = Object.freeze({ OK: 'ok', CORRUPT: 'corrupt', UNAVAILABLE: 'unavailable' });

/**
 * Check the database with its own read-only connection.
 * @param {string} dbPath - Database file
 * @param {'quick_check'|'integrity_check'} check - Which pragma
 * @param {object} [opts] - `{busyMs}`: how long to wait on a lock (default `DB_BUSY_MS`)
 * @returns {{check: string, state: string, problems?: string[], problemCount?: number, error?: string}} The verdict
 */
function checkDatabase(dbPath, check, opts = {}) {
  const { DatabaseSync } = require('node:sqlite');
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${Number.isInteger(opts.busyMs) ? opts.busyMs : DB_BUSY_MS}`);
    const rows = db.prepare(`PRAGMA ${check}`).all().map((r) => String(Object.values(r)[0]));
    if (rows.length === 1 && rows[0] === 'ok') return { check, state: DB_STATE.OK };
    return { check, state: DB_STATE.CORRUPT, problems: rows.slice(0, MAX_PROBLEMS), problemCount: rows.length };
  } catch (err) {
    // node:sqlite reports SQLite's extended code as `errcode`; its low byte is the primary one.
    if (err && typeof err.errcode === 'number') {
      const primary = err.errcode & 0xff;
      return { check, state: DAMAGE_CODES.has(primary) ? DB_STATE.CORRUPT : DB_STATE.UNAVAILABLE, error: String(err.errstr || err.message) };
    }
    if (err && err.code === 'ENOENT') return { check, state: DB_STATE.UNAVAILABLE, error: 'ENOENT' };
    throw err;
  } finally {
    if (db) db.close();
  }
}

/**
 * The pid the server's pidfile names (`<home>/tangleclaw.pid`), in either of
 * the forms `lib/pidfile.js` writes: `{"pid": n, ...}` or a bare number.
 * Read here rather than through `lib/pidfile.js`, so everything the soak runs
 * stays inside `lib/soak/`, the files the guest's checkout trust check covers.
 * @param {string} home - TangleClaw home
 * @returns {number|null} The pid, or null when there is no usable file
 */
function readServerPid(home) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, 'tangleclaw.pid'), 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let pid;
  if (text.startsWith('{')) {
    try {
      pid = Number.parseInt(JSON.parse(text).pid, 10);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return null;
    }
  } else {
    pid = /^\d+$/.test(text) ? Number(text) : NaN;
  }
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The server process's resident memory and open descriptors.
 *
 * `alive` is `false` only when the process is positively gone: no usable
 * pidfile, or `ps` answering that no such process exists (exit 1 with no
 * output). A `ps` that failed any other way, or timed out, says nothing about
 * the server, so `alive` is `null` and `reason` says why. A failed `lsof`
 * leaves `openFds` null with its own reason.
 * @param {string} home - TangleClaw home
 * @param {Function} run - `local.runCommand`-shaped
 * @returns {Promise<{pid: number|null, alive: boolean|null, rssKb: number|null, openFds: number|null, reason?: string}>} What could be read, and why not where it could not
 */
async function processStats(home, run) {
  const pid = readServerPid(home);
  if (pid === null) return { pid: null, alive: false, rssKb: null, openFds: null, reason: 'no-pidfile' };
  const ps = await run('ps', ['-o', 'rss=', '-p', String(pid)], { timeoutMs: 10 * 1000 });
  if (ps.code === 1 && ps.stdout.trim() === '') return { pid, alive: false, rssKb: null, openFds: null, reason: 'not-running' };
  const rss = ps.code === 0 ? Number.parseInt(ps.stdout.trim(), 10) : NaN;
  if (!Number.isInteger(rss)) return { pid, alive: null, rssKb: null, openFds: null, reason: `ps-failed:${ps.error || 'unparsable'}` };
  // `-F f` prints one `f<fd>` line per open descriptor, plus a `p<pid>` line.
  const ls = await run('lsof', ['-n', '-P', '-p', String(pid), '-F', 'f'], { timeoutMs: 30 * 1000 });
  if (ls.code !== 0) return { pid, alive: true, rssKb: rss, openFds: null, reason: `lsof-failed:${ls.error || ls.code}` };
  return { pid, alive: true, rssKb: rss, openFds: ls.stdout.split('\n').filter((l) => /^f\d+$/.test(l)).length };
}

/**
 * Free and total bytes on the disk holding `dir`.
 * @param {string} dir - Directory
 * @param {object} fsImpl - `node:fs`-shaped
 * @returns {{freeBytes: number, totalBytes: number}} Disk space
 */
function diskStats(dir, fsImpl) {
  const st = fsImpl.statfsSync(dir);
  return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
}

/**
 * `/api/health`: its status code, its `status`, and its database service.
 * @param {object} ctx - `{apiBase, token, fetch}`
 * @returns {Promise<{status: number|null, code: string, reported: string|null, database: string|null}>} What health said
 */
async function healthStats(ctx) {
  const ex = require('./executors');
  const r = await ex.call(ctx, 'GET', '/api/health');
  const body = r.body && typeof r.body === 'object' ? r.body : {};
  const db = body.services && typeof body.services === 'object' ? body.services.database : null;
  return { status: r.status, code: r.code, reported: typeof body.status === 'string' ? body.status : null, database: typeof db === 'string' ? db : (db && typeof db.status === 'string' ? db.status : null) };
}

/**
 * Take one sample.
 * @param {object} opts - `{home, apiBase, token, fetch, seq, now, run, fs, fullEvery}`
 * @returns {Promise<object>} The sample record
 */
async function sampleOnce(opts) {
  const fsImpl = opts.fs || fs;
  const full = opts.seq % (opts.fullEvery || FULL_EVERY) === 0;
  const at = opts.now();
  const db = checkDatabase(path.join(opts.home, local.DB_FILE), full ? 'integrity_check' : 'quick_check');
  const dbBytes = (() => {
    try { return fsImpl.statSync(path.join(opts.home, local.DB_FILE)).size; } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  })();
  const proc = await processStats(opts.home, opts.run);
  const disk = diskStats(opts.home, fsImpl);
  const health = await healthStats({ apiBase: opts.apiBase, token: opts.token, fetch: opts.fetch });
  return { type: 'sample', seq: opts.seq, at, db: { ...db, bytes: dbBytes }, process: proc, disk, health };
}

/**
 * Append one record and flush it to disk.
 * @param {string} file - Samples file
 * @param {object} record - Record
 * @param {object} fsImpl - `node:fs`-shaped
 */
function appendSample(file, record, fsImpl = fs) {
  const fd = fsImpl.openSync(file, 'a', 0o600);
  try {
    fsImpl.writeSync(fd, `${JSON.stringify(record)}\n`);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * Read a samples file back: its header and every complete record, failed
 * samples included. A final
 * line torn by a crash is reported and ignored, never repaired. Damage
 * anywhere else is refused (`SAMPLES_UNREADABLE`).
 * @param {string} file - Samples file
 * @param {object} [fsImpl] - `node:fs`-shaped
 * @returns {{header: object|null, samples: object[], tornTail: boolean}} What it holds
 */
function readSamples(file, fsImpl = fs) {
  const text = fsImpl.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const last = lines.pop();
  const tornTail = last !== '';
  let header = null;
  const samples = [];
  for (const [i, line] of lines.entries()) {
    let r;
    try {
      r = JSON.parse(line);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      const e = new Error(`${file} line ${i + 1} is not JSON`);
      e.code = 'SAMPLES_UNREADABLE';
      throw e;
    }
    if (r.type === 'header') header = header || r;
    else if (r.type === 'sample' || r.type === 'sample-failed') samples.push(r);
  }
  return { header, samples, tornTail };
}

/**
 * Hold the samples file for one sampler: `<file>.lock`, created exclusively
 * with this process's pid. A lock whose process is gone is taken over; a live
 * one is refused.
 * @param {string} file - Samples file
 * @param {object} [fsImpl] - `node:fs`-shaped
 * @returns {{release: () => void}} The held lock
 * @throws {Error} `SAMPLER_LOCKED` when another live sampler holds it
 */
function lockSamples(file, fsImpl = fs) {
  const lockPath = `${file}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fsImpl.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      return { release: () => fsImpl.rmSync(lockPath, { force: true }) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = Number.parseInt(fsImpl.readFileSync(lockPath, 'utf8'), 10);
      let alive = false;
      if (Number.isInteger(holder) && holder > 0) {
        try { process.kill(holder, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      }
      if (alive || attempt > 0) {
        const e = new Error(`${lockPath} is held by pid ${holder}${alive ? ', which is running' : ''}`);
        e.code = 'SAMPLER_LOCKED';
        throw e;
      }
      fsImpl.rmSync(lockPath, { force: true });
    }
  }
  throw new Error('unreachable');
}

/**
 * Sample until stopped, or for `count` samples.
 *
 * A sample that throws is recorded as `sample-failed` with its error, and
 * sampling carries on: a sampler that stopped silently would leave a long run
 * looking clean over hours nobody sampled.
 *
 * A new file starts with a header naming the home, the target and the
 * interval. An existing one is continued: its header must name the same home,
 * and sequence numbers carry on from its last sample. A full check runs on
 * the first sample and every `fullEvery`-th after it.
 * @param {object} opts - `{file, home, apiBase, token, fetch, intervalMs, count, clock: {now, sleep}, shouldStop, run, fs, fullEvery}`
 * @returns {Promise<{taken: number, lastSeq: number}>} How many samples this call took
 */
async function runSampler(opts) {
  const fsImpl = opts.fs || fs;
  const lock = lockSamples(opts.file, fsImpl);
  try {
    let seq = 0;
    if (fsImpl.existsSync(opts.file)) {
      const prior = readSamples(opts.file, fsImpl);
      if (!prior.header || prior.header.home !== opts.home) {
        const e = new Error(`${opts.file} belongs to another home (${prior.header ? prior.header.home : 'no header'})`);
        e.code = 'SAMPLES_MISMATCH';
        throw e;
      }
      if (prior.tornTail) {
        const e = new Error(`${opts.file} ends in a torn line; start a new samples file`);
        e.code = 'SAMPLES_TORN';
        throw e;
      }
      seq = prior.samples.length > 0 ? prior.samples[prior.samples.length - 1].seq + 1 : 0;
    } else {
      appendSample(opts.file, { type: 'header', schema: SAMPLES_SCHEMA, home: opts.home, target: new URL(opts.apiBase).origin, intervalMs: opts.intervalMs, fullEvery: opts.fullEvery || FULL_EVERY, startedAt: opts.clock.now() }, fsImpl);
    }
    let taken = 0;
    for (;;) {
      if (opts.shouldStop()) break;
      let record;
      try {
        record = await sampleOnce({ ...opts, seq, now: opts.clock.now });
      } catch (err) { // prawduct:allow prawduct/broad-except -- a supervisor loop: one failed reading must not end 72 hours of sampling; it is recorded instead
        record = { type: 'sample-failed', seq, at: opts.clock.now(), error: String(err && (err.code || err.message)) };
      }
      appendSample(opts.file, record, fsImpl);
      taken++;
      seq++;
      if (opts.count !== undefined && taken >= opts.count) break;
      // Wait in short slices, so a stop is honoured promptly.
      const until = opts.clock.now() + opts.intervalMs;
      while (opts.clock.now() < until && !opts.shouldStop()) await opts.clock.sleep(Math.min(1000, until - opts.clock.now()));
    }
    return { taken, lastSeq: seq - 1 };
  } finally {
    lock.release();
  }
}

module.exports = { SAMPLES_SCHEMA, FULL_EVERY, INTERVAL_MS, DB_STATE, checkDatabase, readServerPid, processStats, diskStats, healthStats, sampleOnce, appendSample, readSamples, lockSamples, runSampler };
