'use strict';

/**
 * Private file primitives for certification evidence.
 *
 * Certification evidence names the host, the worktree and the ttyd pid, and a
 * release decision rests on it, so every directory is the owner's alone (0700)
 * and every file is too (0600), whatever the umask. Nothing here follows a
 * symlink: a planted link at any evidence path is refused or replaced, never
 * written through.
 *
 * Durability: a replaced file is written to a fresh name, fsynced, renamed
 * into place and its directory fsynced, so a crash leaves the old contents or
 * the new, never a mixture. An appended line is fsynced before the call
 * returns. A crash mid-append can leave a torn final line; `readLines` drops
 * it, and the next append cuts it off before writing, so a torn fragment never
 * ends up between two whole records.
 *
 * @module lib/release-certification/private-fs
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REFUSAL, CertificationError } = require('./codes');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const { O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_NOFOLLOW, O_APPEND, O_RDONLY } = fs.constants;

/**
 * Throw STORE_UNSAFE.
 * @param {string} message - Why the path is refused
 * @returns {never}
 */
function _unsafe(message) {
  throw new CertificationError(REFUSAL.STORE_UNSAFE, message);
}

/**
 * Create each missing level of a path, making every new level 0700 at once.
 * A recursive mkdir applies the umask to the levels it creates, and a
 * restrictive umask (0277) would leave an intermediate level the owner cannot
 * create the next one inside.
 * @param {string} dir - Absolute directory path
 * @returns {void}
 */
function _mkdirEachLevel(dir) {
  const missing = [];
  for (let at = dir; !fs.existsSync(at); at = path.dirname(at)) {
    missing.unshift(at);
    if (path.dirname(at) === at) break;
  }
  for (const level of missing) {
    try {
      fs.mkdirSync(level, DIR_MODE);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    fs.chmodSync(level, DIR_MODE);
  }
}

/**
 * Make a directory the owner's alone, refusing a symlink, a non-directory or
 * another user's directory, and tightening a loose mode.
 * @param {string} dir - Absolute directory path
 * @returns {string} The directory
 */
function ensurePrivateDir(dir) {
  _mkdirEachLevel(dir);
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) _unsafe('an evidence directory is a symlink');
  if (!st.isDirectory()) _unsafe('an evidence directory is not a directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) _unsafe('an evidence directory belongs to another user');
  if ((st.mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE);
  return dir;
}

/**
 * fsync a directory so a rename or create inside it is durable.
 * @param {string} dir - Directory path
 * @returns {void}
 */
function _syncDir(dir) {
  const fd = fs.openSync(dir, O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write bytes to a new 0600 file that must not already exist, and fsync it.
 * @param {string} file - Path
 * @param {string} data - Contents
 * @returns {void}
 */
function _writeNew(file, data) {
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
  try {
    fs.fchmodSync(fd, FILE_MODE);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create a file that must not exist yet: the write-once path for a manifest.
 * @param {string} file - Path
 * @param {string} data - Contents
 * @returns {boolean} True when created; false when a file was already there
 */
function writeOnce(file, data) {
  try {
    _writeNew(file, data);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  _syncDir(path.dirname(file));
  return true;
}

/**
 * Create a file that must not exist yet, atomically: the contents are written
 * and fsynced under a temporary name, then hard-linked into place, which
 * fails if the name exists. A crash at any point leaves either no file or
 * the whole file, never a partial one under the final name.
 * @param {string} file - Path
 * @param {string} data - Contents
 * @returns {boolean} True when created; false when a file was already there
 */
function createOnceAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  _writeNew(tmp, data);
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  _syncDir(path.dirname(file));
  return true;
}

/**
 * Replace a file's contents atomically. A symlink at the target is replaced,
 * not written through, because rename swaps the directory entry.
 * @param {string} file - Path
 * @param {string} data - Contents
 * @returns {void}
 */
function replaceAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    _writeNew(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  _syncDir(path.dirname(file));
}

/**
 * Read a whole file without following a symlink.
 * @param {string} file - Path
 * @returns {string|null} Contents, or null when absent
 */
function readPrivate(file) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') _unsafe('an evidence file is a symlink');
    throw err;
  }
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The length of a file up to and including its last newline, found by
 * reading backwards so a long ledger is not read whole on every append.
 * @param {number} fd - Open descriptor
 * @param {number} size - File size
 * @returns {number} Offset just past the last newline, or 0 when there is none
 */
function _completeLength(fd, size) {
  const chunk = Buffer.alloc(64 * 1024);
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunk.length);
    const n = fs.readSync(fd, chunk, 0, end - start, start);
    const at = chunk.subarray(0, n).lastIndexOf(0x0a);
    if (at !== -1) return start + at + 1;
    end = start;
  }
  return 0;
}

/**
 * Append one line and fsync it. A file whose last byte is not a newline ends
 * in a torn line from an interrupted append; that fragment was never
 * committed, so it is truncated away before this line is written, and the
 * caller is told how much was cut so the recovery leaves a trace.
 * @param {string} file - Path
 * @param {string} line - One line, without a newline
 * @returns {{truncatedBytes: number}} Bytes of torn tail removed
 */
function appendLine(file, line) {
  if (line.includes('\n')) throw new CertificationError(REFUSAL.INVALID_SAMPLE, 'a record must be one line');
  let fd;
  try {
    fd = fs.openSync(file, O_RDWR | O_CREAT | O_APPEND | O_NOFOLLOW, FILE_MODE);
  } catch (err) {
    if (err.code === 'ELOOP') _unsafe('an evidence file is a symlink');
    throw err;
  }
  try {
    fs.fchmodSync(fd, FILE_MODE);
    const { size } = fs.fstatSync(fd);
    const complete = size > 0 ? _completeLength(fd, size) : 0;
    if (complete !== size) fs.ftruncateSync(fd, complete);
    fs.writeSync(fd, `${line}\n`);
    fs.fsyncSync(fd);
    return { truncatedBytes: size - complete };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read newline-delimited JSON records. A final line with no newline after it
 * is a torn append and is dropped; a malformed line anywhere else means the
 * file was damaged, and is refused rather than skipped.
 * @param {string} file - Path
 * @returns {{records: object[], tornTail: boolean}} Parsed records and whether a torn line was dropped
 */
function readLines(file) {
  const text = readPrivate(file);
  if (!text) return { records: [], tornTail: false };
  const lines = text.split('\n');
  const tail = lines.pop();
  const records = [];
  for (const line of lines) {
    if (line === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new CertificationError(REFUSAL.EVIDENCE_CORRUPT, 'a sample record is not valid JSON');
    }
  }
  return { records, tornTail: tail !== '' };
}

module.exports = {
  createOnceAtomic,
  DIR_MODE,
  FILE_MODE,
  ensurePrivateDir,
  writeOnce,
  replaceAtomic,
  readPrivate,
  appendLine,
  readLines
};
