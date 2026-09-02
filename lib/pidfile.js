'use strict';

/**
 * PID file management for preventing duplicate server instances.
 *
 * Writes a PID file on startup and removes it on shutdown.
 * On startup, checks for an existing PID file and validates
 * whether the recorded process is still alive.
 *
 * ## Why liveness alone is not enough
 *
 * `process.kill(pid, 0)` answers "does SOME process hold this PID", never
 * "does TangleClaw hold this PID". PIDs are reused, most aggressively across
 * a reboot, so a PID file that outlives its process can name a stranger. A
 * field install hit exactly that (#1029): after a macOS restart the recorded
 * PID 633 belonged to an Apple AudioToolbox SandboxHelper, startup read it as
 * a live instance and exited 1, and because the LaunchAgent sets KeepAlive the
 * result was a permanent crash loop that only a hand-deleted PID file cleared.
 *
 * So identity is checked in two independent layers, cheapest first:
 *
 *   1. `writtenAt` versus boot time. A file written before this machine booted
 *      cannot describe a process running on it. This is pure arithmetic — no
 *      subprocess, no parsing, no ambiguity — and it alone settles the reboot
 *      case, which is the one that bricked a real install.
 *   2. The live process's command line. This catches same-boot reuse, which
 *      layer 1 cannot see because the file and the impostor share a boot.
 *
 * Each layer only ever votes "this is NOT us"; neither can assert that a
 * process IS TangleClaw. That asymmetry is deliberate — see `check`.
 *
 * @module lib/pidfile
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_DIR = path.join(process.env.HOME || '', '.tangleclaw');
const PID_FILENAME = 'tangleclaw.pid';

/**
 * Clock skew allowance when comparing the PID file's write time to boot time.
 *
 * Boot time is derived as `now - os.uptime()`, and both terms drift: uptime has
 * second granularity, and the wall clock can be stepped by NTP between the
 * write and the check. Without slack a file written seconds after boot could
 * be misread as pre-boot and a genuinely live instance declared stale, which
 * starts a second server. The window is generous because being wrong in that
 * direction is worse than leaving a rare same-boot impostor to layer 2.
 */
const BOOT_SKEW_MS = 60_000;

/**
 * Check if a process with the given PID is alive.
 * @param {number} pid - Process ID to check
 * @returns {boolean} True if process is running
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch (err) {
    // EPERM = process exists but we lack permission to signal it
    // ESRCH = no such process
    return err.code === 'EPERM';
  }
}

/**
 * Read the full PID file record.
 *
 * Two formats are accepted. Current writers emit JSON carrying the PID plus
 * the identity evidence; installs that predate this record a bare integer.
 * A legacy file is not an error — it yields a record with `writtenAt: null`,
 * which simply means layer 1 has nothing to compare and identity falls to the
 * command-line check.
 *
 * @param {string} [dir] - Directory containing the PID file
 * @returns {{ pid: number, writtenAt: number|null }|null} Record, or null when
 *   the file is absent, unreadable, or names no usable PID
 */
function readRecord(dir) {
  const filePath = path.join(dir || DEFAULT_DIR, PID_FILENAME);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }

  let pid = null;
  let writtenAt = null;

  if (content.startsWith('{')) {
    try {
      const parsed = JSON.parse(content);
      pid = Number.parseInt(parsed.pid, 10);
      writtenAt = Number.isFinite(parsed.writtenAt) ? parsed.writtenAt : null;
    } catch {
      return null; // corrupt JSON — treat as no usable record
    }
  } else {
    pid = Number.parseInt(content, 10);
  }

  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, writtenAt };
}

/**
 * Read the PID from an existing PID file.
 * @param {string} [dir] - Directory containing the PID file
 * @returns {number|null} The PID if file exists and is valid, null otherwise
 */
function readPid(dir) {
  const record = readRecord(dir);
  return record ? record.pid : null;
}

/**
 * Approximate the moment this machine booted, in epoch milliseconds.
 * @returns {number} Epoch ms of boot
 */
function bootTimeMs() {
  return Date.now() - os.uptime() * 1000;
}

/**
 * Layer 1 — did this PID file outlive a reboot?
 *
 * Answers only the falsifying question. `true` means the record provably
 * describes a process from a previous boot; `false` means it does not prove
 * that, which includes the legacy-format case where there is nothing to check.
 *
 * @param {{ writtenAt: number|null }} record - Record from `readRecord`
 * @param {object} [deps] - Seams for testing
 * @param {function(): number} [deps.bootTime] - Override boot-time source
 * @returns {boolean} True when the file predates the current boot
 */
function predatesBoot(record, deps = {}) {
  if (!record || record.writtenAt === null) return false;
  const boot = (deps.bootTime || bootTimeMs)();
  return record.writtenAt < boot - BOOT_SKEW_MS;
}

/**
 * Read a process's command line, or null when it cannot be determined.
 * @param {number} pid - Process ID to inspect
 * @returns {string|null} The command line, or null if unavailable
 */
function processCommand(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return out || null;
  } catch {
    return null; // no ps, no permission, or no such process
  }
}

/**
 * Layer 2 — does the live process look like something other than TangleClaw?
 *
 * Like layer 1 this only votes to falsify. A command line we cannot read
 * returns `false` (not proven foreign) rather than guessing, because `ps`
 * being unavailable is not evidence about the process.
 *
 * @param {number} pid - Process ID to inspect
 * @param {object} [deps] - Seams for testing
 * @param {function(number): (string|null)} [deps.readCommand] - Override the ps call
 * @returns {boolean} True when the process is provably not TangleClaw
 */
function isForeignProcess(pid, deps = {}) {
  const command = (deps.readCommand || processCommand)(pid);
  if (command === null) return false; // unknown — not proof of anything
  return !/tangleclaw|server\.js/i.test(command);
}

/**
 * Check for a running instance via PID file.
 *
 * Returns the existing PID if another instance is alive, null if clear to
 * start. Stale PID files — dead process, pre-boot record, or a PID that has
 * been reused by an unrelated process — are removed automatically.
 *
 * Both identity layers are one-directional on purpose: they can prove a PID is
 * NOT ours, never that it is. When neither can prove impostor, the PID is
 * reported as a live instance, preserving the original conservative behaviour.
 * The two error directions are not symmetric and the bias follows that: wrongly
 * concluding "stale" starts a second server, which fails loudly on the port
 * bind; wrongly concluding "running" is #1029, which bricks startup silently
 * until a human deletes a file.
 *
 * @param {string} [dir] - Directory containing the PID file
 * @param {object} [deps] - Seams for testing
 * @param {function(number): boolean} [deps.processAlive] - Override liveness check
 * @param {function(): number} [deps.bootTime] - Override boot-time source
 * @param {function(number): (string|null)} [deps.readCommand] - Override the ps call
 * @returns {number|null} PID of running instance, or null if none
 */
function check(dir, deps = {}) {
  const record = readRecord(dir);
  if (record === null) return null;

  const { pid } = record;
  if (pid === process.pid) return null; // it's us

  const alive = (deps.processAlive || isProcessAlive)(pid);
  const foreign = alive && (predatesBoot(record, deps) || isForeignProcess(pid, deps));

  if (alive && !foreign) {
    return pid; // another instance is running
  }

  // Stale — dead, from a previous boot, or a reused PID now held by a stranger.
  remove(dir);
  return null;
}

/**
 * Write the current process PID to the PID file.
 *
 * Records `writtenAt` alongside the PID so a later `check` can tell a live
 * instance from a record that outlived a reboot.
 *
 * @param {string} [dir] - Directory containing the PID file
 */
function write(dir) {
  const filePath = path.join(dir || DEFAULT_DIR, PID_FILENAME);
  const record = { pid: process.pid, writtenAt: Date.now() };
  fs.writeFileSync(filePath, JSON.stringify(record), 'utf8');
}

/**
 * Remove the PID file.
 * @param {string} [dir] - Directory containing the PID file
 */
function remove(dir) {
  const filePath = path.join(dir || DEFAULT_DIR, PID_FILENAME);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone — fine
  }
}

module.exports = {
  check,
  write,
  remove,
  readPid,
  readRecord,
  isProcessAlive,
  predatesBoot,
  isForeignProcess,
  PID_FILENAME,
  BOOT_SKEW_MS
};
