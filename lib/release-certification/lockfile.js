'use strict';

/**
 * A cross-process lock for one certification run's evidence.
 *
 * The runner and the operator's `accept`/`cancel` commands are separate
 * processes writing the same `state.json`, so each read-modify-write happens
 * under this lock. It is a file created with O_EXCL holding
 * `{pid, machine, host, writtenAt, token}`.
 *
 * `machine` is a stable identity of this computer (the platform UUID on macOS,
 * `/etc/machine-id` on Linux), and it, not the host name, decides whether a
 * lock's process can be checked here. macOS changes its host name with the
 * network it joins, so a lock keyed on the host name alone would wedge a run
 * that crashed before a rename: its process could never be checked again.
 *
 * A lock left by a crashed process is reclaimed only when it provably belongs
 * to nobody, and every test for that can only vote "not held" (the reasoning in
 * `lib/pidfile.js`):
 * - its pid is not alive;
 * - it was written before this machine booted;
 * - the process now holding its pid started after the lock was written, so the
 *   pid was reused.
 * A lock from another machine is never reclaimed: this machine cannot see its
 * process. When the machine id cannot be read, the host name stands in for it.
 *
 * Reclaiming renames the stale file aside and checks that the file it moved is
 * the one it judged, so a lock taken fresh between the judgement and the move
 * is put back rather than deleted. Because no reclaim can be perfectly atomic,
 * a holder re-checks its token (`assertHeld`) immediately before it commits,
 * so a lost lock aborts the write instead of racing it.
 *
 * @module lib/release-certification/lockfile
 */

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const pidfile = require('../pidfile');
const privateFs = require('./private-fs');
const { REFUSAL, CertificationError } = require('./codes');

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_MS = 50;
const SKEW_MS = 2000;
/** A holder writes its record microseconds after creating the file; an unreadable lock older than this was torn by a crash. */
const TORN_GRACE_MS = 10 * 1000;
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;

/**
 * When a process started, in epoch ms, or null when it cannot be read.
 * @param {number} pid - Process id
 * @returns {number|null} Start time
 */
function processStartMs(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * A stable identity for this computer, read once.
 * @returns {string} `darwin:<platform uuid>`, `linux:<machine-id>`, or `host:<name>` when neither can be read
 */
function machineId() {
  if (_machineId) return _machineId;
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/"IOPlatformUUID" = "([0-9A-Fa-f-]{36})"/);
      if (m) _machineId = `darwin:${m[1]}`;
    } else if (process.platform === 'linux') {
      const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(id)) _machineId = `linux:${id}`;
    }
  } catch {
    _machineId = null;
  }
  if (!_machineId) _machineId = `host:${os.hostname()}`;
  return _machineId;
}

let _machineId = null;

/** @type {object} The real environment; tests replace members. */
const DEFAULT_DEPS = Object.freeze({
  isAlive: pidfile.isProcessAlive,
  bootTime: () => Date.now() - os.uptime() * 1000,
  processStart: processStartMs,
  hostname: () => os.hostname(),
  machine: machineId,
  now: () => Date.now(),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
});

/**
 * Read a lock record, or null when the file is absent or unreadable as one.
 * @param {string} file - Lock path
 * @returns {object|null} `{pid, host, writtenAt, token}`
 */
function readRecord(file) {
  const text = privateFs.readPrivate(file);
  if (text === null) return null;
  try {
    const r = JSON.parse(text);
    if (r && typeof r.token === 'string') return r;
  } catch {
    // Unreadable: a holder mid-write, or one that crashed during it.
  }
  let mtimeMs = null;
  try {
    mtimeMs = fs.lstatSync(file).mtimeMs;
  } catch {
    return null;
  }
  return { token: null, mtimeMs };
}

/**
 * Whether a lock record provably belongs to no live process on this host.
 * A record that cannot be read is a holder between creating the file and
 * writing it, or one that crashed there; only an old one is the crash.
 * @param {object} record - Lock record
 * @param {object} deps - Environment
 * @returns {boolean} True when it may be reclaimed
 */
function isStale(record, deps) {
  if (record.token === null) return record.mtimeMs !== null && deps.now() - record.mtimeMs > TORN_GRACE_MS;
  const sameMachine = typeof record.machine === 'string' ? record.machine === deps.machine() : record.host === deps.hostname();
  if (!sameMachine) return false;
  if (!Number.isSafeInteger(record.pid) || !deps.isAlive(record.pid)) return true;
  if (Number.isFinite(record.writtenAt) && record.writtenAt < deps.bootTime() - SKEW_MS) return true;
  const started = deps.processStart(record.pid);
  return started !== null && Number.isFinite(record.writtenAt) && started > record.writtenAt + SKEW_MS;
}

/**
 * Try once to create the lock.
 * @param {string} file - Lock path
 * @param {object} deps - Environment
 * @returns {string|null} The token when created, or null when the lock exists
 */
function _tryCreate(file, deps) {
  const token = crypto.randomBytes(16).toString('hex');
  const body = JSON.stringify({ pid: process.pid, machine: deps.machine(), host: deps.hostname(), writtenAt: deps.now(), token });
  let fd;
  try {
    fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, privateFs.FILE_MODE);
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return token;
}

/**
 * Move a stale lock aside, restoring it if it turned out not to be the one judged.
 * @param {string} file - Lock path
 * @param {object} judged - The stale record
 * @returns {boolean} True when the judged lock was removed; false when it was gone or was put back
 */
function _reclaim(file, judged) {
  const aside = `${file}.stale.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const moved = readRecord(aside);
  let removed = true;
  if (moved && moved.token !== judged.token) {
    removed = false;
    try {
      fs.linkSync(aside, file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  fs.rmSync(aside, { force: true });
  return removed;
}

/**
 * Acquire the lock, waiting up to a timeout and reclaiming a stale one.
 * @param {string} file - Lock path
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - How long to wait for a live holder
 * @param {function(object): void} [opts.onReclaim] - Told the record of each stale lock reclaimed
 * @param {object} [opts.deps] - Environment overrides (tests)
 * @returns {string} The token that proves ownership
 */
function acquire(file, opts = {}) {
  const deps = { ...DEFAULT_DEPS, ...opts.deps };
  const deadline = deps.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    const token = _tryCreate(file, deps);
    if (token) return token;
    const record = readRecord(file);
    if (record && isStale(record, deps)) {
      if (_reclaim(file, record) && opts.onReclaim) {
        opts.onReclaim({ pid: record.pid ?? null, machine: record.machine ?? null, host: record.host ?? null, writtenAt: record.writtenAt ?? null });
      }
      continue;
    }
    if (deps.now() >= deadline) {
      const holder = record && record.token ? { pid: record.pid, host: record.host, writtenAt: record.writtenAt } : {};
      throw new CertificationError(REFUSAL.LOCK_HELD, 'the evidence is locked by another process', holder);
    }
    deps.sleep(RETRY_MS);
  }
}

/**
 * Refuse to continue unless this token still holds the lock.
 * @param {string} file - Lock path
 * @param {string} token - Token from `acquire`
 * @returns {void}
 */
function assertHeld(file, token) {
  const record = readRecord(file);
  if (!record || record.token !== token) throw new CertificationError(REFUSAL.LOCK_LOST, 'the evidence lock was lost before commit');
}

/**
 * Release the lock if this token still holds it. Never removes another holder's lock.
 * @param {string} file - Lock path
 * @param {string} token - Token from `acquire`
 * @returns {boolean} True when released
 */
function release(file, token) {
  const record = readRecord(file);
  if (!record || record.token !== token) return false;
  fs.rmSync(file, { force: true });
  return true;
}

module.exports = { acquire, release, assertHeld, isStale, readRecord, processStartMs, machineId };
