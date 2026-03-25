'use strict';

/**
 * PID file management for preventing duplicate server instances.
 *
 * Writes a PID file on startup and removes it on shutdown.
 * On startup, checks for an existing PID file and validates
 * whether the recorded process is still alive.
 *
 * @module lib/pidfile
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(process.env.HOME || '', '.tangleclaw');
const PID_FILENAME = 'tangleclaw.pid';

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
 * Read the PID from an existing PID file.
 * @param {string} [dir] - Directory containing the PID file
 * @returns {number|null} The PID if file exists and is valid, null otherwise
 */
function readPid(dir) {
  const filePath = path.join(dir || DEFAULT_DIR, PID_FILENAME);
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Check for a running instance via PID file.
 * Returns the existing PID if another instance is alive, null if clear to start.
 * Cleans up stale PID files from dead processes automatically.
 * @param {string} [dir] - Directory containing the PID file
 * @returns {number|null} PID of running instance, or null if none
 */
function check(dir) {
  const pid = readPid(dir);
  if (pid === null) return null;

  if (pid === process.pid) return null; // it's us

  if (isProcessAlive(pid)) {
    return pid; // another instance is running
  }

  // Stale PID file — process is dead, clean it up
  remove(dir);
  return null;
}

/**
 * Write the current process PID to the PID file.
 * @param {string} [dir] - Directory containing the PID file
 */
function write(dir) {
  const filePath = path.join(dir || DEFAULT_DIR, PID_FILENAME);
  fs.writeFileSync(filePath, String(process.pid), 'utf8');
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

module.exports = { check, write, remove, readPid, isProcessAlive, PID_FILENAME };
