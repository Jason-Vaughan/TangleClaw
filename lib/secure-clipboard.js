'use strict';

/**
 * Cross-machine secure clipboard sync and file/secret uploader (#1032).
 *
 * Lets the operator's browser carry a secret — an API key, an SSH key, a
 * token — into a project's own session workspace without it ever appearing
 * in a log line, a chat history, or a terminal command history. This module
 * owns the one delivery shape that exists at the filesystem level: written
 * to `<project>/.tangleclaw/secrets/<filename>`, a `0700` directory holding
 * `0600` files, the same posture `lib/draft-store.js` uses for its own
 * private recovery store.
 *
 * The route's `mode: 'paste'` is NOT a second delivery shape at the
 * filesystem level — it writes through this same `writeSecretFile`, then
 * (from `lib/routes/secure-clipboard.js`, not here) injects only a
 * content-free POINTER into the project's live tmux pane via
 * `lib/sessions.js#injectCommand`, never the secret itself. An earlier
 * version of this feature injected the raw secret with no Enter, reasoning
 * an unsent composer line was safe; it was not (PRR-B R-Gate finding 2,
 * round 1) — see that route module's own docblock for the full story. This
 * module stays unit-testable without a real tmux binary either way, since
 * it never touches tmux.
 *
 * **The log carries names and types, never values.** A `utf8` write runs
 * the content through `lib/secret-scan.js` (flag-only: pattern TYPES, never
 * the matched text) and logs only `{bytes, secretTypesDetected}` — the same
 * privacy invariant `lib/draft-store.js` states for its own log lines, for
 * the same reason: even a short hash is payload-derived and
 * guessable-confirmable, so nothing derived from the secret itself is kept
 * beyond its byte count and which credential shapes it resembled. A
 * `base64` write (an actual file upload, not typed/pasted text) is never
 * scanned — `scanForAudit`/`writeSecretFile` both skip it deliberately,
 * since `secret-scan.js`'s patterns are written for human-readable text and
 * would find nothing meaningful in an opaque byte stream; its own
 * `secretTypesDetected` is always `[]` for that path, by construction, not
 * because nothing was found.
 *
 * @module lib/secure-clipboard
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('./logger');
const { configRootOf } = require('./wrap-steps/_config-root');
const secretScan = require('./secret-scan');

const log = createLogger('secure-clipboard');

/** Subdirectory of `.tangleclaw/` a project's pending secret files live in. */
const SECRETS_SUBDIR = 'secrets';

/** Largest decoded file content this store accepts. */
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Safe filenames: no `/`, so no caller can address a path outside the
 * secrets directory — the same defence `lib/draft-store.js`'s
 * `ATTEMPT_KEY_RE` uses for its own caller-supplied key. The leading
 * negative lookahead refuses exactly `.` or `..` (Architect hardening,
 * PR #2951 round 2): harmless here on their own, since there is no `/` to
 * walk with, but a file named `.` or `..` is still a needless, confusing
 * edge case `fs.readdirSync`/`fs.unlinkSync` need not be handed.
 */
const SAFE_FILENAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

/**
 * The directory a project's pending secret files live in.
 * @param {object} project - A project record.
 * @returns {string} Absolute path.
 */
function secretsDir(project) {
  return path.join(configRootOf(project), '.tangleclaw', SECRETS_SUBDIR);
}

/**
 * Make the secrets directory, refusing one that is a symlink or someone
 * else's — the same check `lib/draft-store.js#_ensureDir` runs for its own
 * private store.
 * @param {string} dir - The directory to make/verify.
 * @returns {void}
 */
function _ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error('the secrets directory is not a directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error('the secrets directory belongs to another user');
  }
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * Scan text for high-confidence secret shapes, for an audit log line that
 * never carries the text itself.
 * @param {string} text - The content about to be written or pasted.
 * @returns {{bytes: number, secretTypesDetected: string[]}}
 */
function scanForAudit(text) {
  if (typeof text !== 'string' || text.length === 0) return { bytes: 0, secretTypesDetected: [] };
  const buf = Buffer.from(text, 'utf8');
  if (buf.length > secretScan.SCAN_SIZE_CAP || !secretScan.looksLikeText(buf)) {
    return { bytes: buf.length, secretTypesDetected: [] };
  }
  return { bytes: buf.length, secretTypesDetected: secretScan.scanText(text).types };
}

/**
 * Write a secret to a project's `.tangleclaw/secrets/` directory.
 *
 * Atomic (temp file beside the destination, created exclusively and
 * `0600`, then renamed over the destination — the same shape
 * `lib/draft-store.js#saveDraft` uses), so a reader never observes a
 * partial secret. Overwrites an existing file of the same name: this is a
 * sync, and resending the same secret is the common case.
 *
 * @param {object} project - A project record.
 * @param {object} input
 * @param {string} input.filename - 1-128 chars of letters, digits, `.`,
 *   `-` or `_` — see {@link SAFE_FILENAME_RE}.
 * @param {string} input.content - The secret, in `input.encoding`.
 * @param {string} [input.encoding] - `'utf8'` (default) or `'base64'`.
 * @returns {{relPath: string, bytes: number, secretTypesDetected: string[]}}
 * @throws {Error} On a bad filename, bad/empty content, an over-limit
 *   decoded size, or a filesystem failure.
 */
function writeSecretFile(project, { filename, content, encoding = 'utf8' }) {
  if (typeof filename !== 'string' || !SAFE_FILENAME_RE.test(filename)) {
    throw new Error('filename must be 1-128 characters of letters, digits, dot, dash or underscore');
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('content must be a non-empty string');
  }
  if (encoding !== 'utf8' && encoding !== 'base64') {
    throw new Error(`unsupported encoding "${encoding}"; use "utf8" or "base64"`);
  }
  const buf = Buffer.from(content, encoding);
  if (buf.length === 0) throw new Error('decoded content is empty');
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`decoded content is ${buf.length} bytes, over the ${MAX_FILE_BYTES}-byte limit`);
  }

  const dir = secretsDir(project);
  _ensureDir(dir);
  const file = path.join(dir, filename);
  const tmp = path.join(dir, `.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);

  const audit = encoding === 'utf8' ? scanForAudit(content) : { bytes: buf.length, secretTypesDetected: [] };
  log.info('Wrote a secret file', { project: project.name, filename, bytes: buf.length, secretTypesDetected: audit.secretTypesDetected });
  return { relPath: path.join(SECRETS_SUBDIR, filename), bytes: buf.length, secretTypesDetected: audit.secretTypesDetected };
}

/**
 * The pending secret files for a project — metadata only, never content.
 * @param {object} project - A project record.
 * @returns {Array<{filename: string, bytes: number, mtimeMs: number}>} Newest first.
 */
function listSecretFiles(project) {
  const dir = secretsDir(project);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => SAFE_FILENAME_RE.test(name))
    .map((name) => {
      const st = fs.lstatSync(path.join(dir, name));
      return { filename: name, bytes: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Delete one pending secret file.
 * @param {object} project - A project record.
 * @param {string} filename - The exact name {@link listSecretFiles} reported.
 * @returns {{deleted: boolean}} `false` when no such file existed.
 * @throws {Error} On a bad filename, or a filesystem failure other than "not found".
 */
function deleteSecretFile(project, filename) {
  if (typeof filename !== 'string' || !SAFE_FILENAME_RE.test(filename)) {
    throw new Error('filename must be 1-128 characters of letters, digits, dot, dash or underscore');
  }
  const file = path.join(secretsDir(project), filename);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { deleted: false };
    throw err;
  }
  log.info('Deleted a secret file', { project: project.name, filename });
  return { deleted: true };
}

/**
 * The image types a pending file may be served back as (#3083, Ruling
 * A751), keyed by lowercased extension. Anything else in the secrets
 * directory is a secret, not a picture, and is never served by
 * {@link readImageFile}.
 * @type {Readonly<Record<string, string>>}
 */
const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
});

/**
 * Whether a file's leading bytes are the signature of `contentType`. A file
 * named `*.png` that is really a key or a text secret is refused rather
 * than sent with an image type it does not carry.
 * @param {Buffer} buf - The file's bytes.
 * @param {string} contentType - One of {@link IMAGE_TYPES}' values.
 * @returns {boolean}
 */
function _hasImageSignature(buf, contentType) {
  const starts = (bytes, at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
  switch (contentType) {
    case 'image/png': return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return starts([0xff, 0xd8, 0xff]);
    case 'image/gif': return starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    case 'image/webp': return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
    default: return false;
  }
}

/**
 * A refusal from {@link readImageFile}, carrying the HTTP status and code
 * the route answers with.
 * @param {number} status - HTTP status.
 * @param {string} code - Error code.
 * @param {string} message - Human-readable reason.
 * @returns {Error}
 */
function _imageError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Read one pending image file for an operator's thumbnail preview (#3083,
 * Ruling A751).
 *
 * Only a raster image is ever returned: the name must pass
 * {@link SAFE_FILENAME_RE}, carry an {@link IMAGE_TYPES} extension, and the
 * bytes must start with that type's signature. Anything else is `415`, so a
 * key or text secret in the same directory is never served. The secrets
 * directory must be a real directory this user owns, and the file is opened
 * `O_RDONLY | O_NOFOLLOW` and checked to be a regular file through its own
 * descriptor, so neither a symlinked directory nor a symlinked file can
 * point the read outside the directory.
 *
 * @param {object} project - A project record.
 * @param {string} filename - The exact name {@link listSecretFiles} reported.
 * @returns {{buffer: Buffer, contentType: string, bytes: number}}
 * @throws {Error} With `status`/`code`: `400 BAD_REQUEST` (bad name),
 *   `415 UNSUPPORTED_MEDIA_TYPE` (not an allowed image), `404 NOT_FOUND`
 *   (no such file, a symlink, or not a regular file), `413 TOO_LARGE`
 *   (over {@link MAX_FILE_BYTES}); any other filesystem failure is rethrown.
 */
function readImageFile(project, filename) {
  if (typeof filename !== 'string' || !SAFE_FILENAME_RE.test(filename)) {
    throw _imageError(400, 'BAD_REQUEST', 'filename must be 1-128 characters of letters, digits, dot, dash or underscore');
  }
  const contentType = IMAGE_TYPES[path.extname(filename).toLowerCase()];
  if (!contentType) {
    throw _imageError(415, 'UNSUPPORTED_MEDIA_TYPE', 'only .png, .jpg, .jpeg, .webp and .gif files can be previewed');
  }

  const dir = secretsDir(project);
  let dirStat;
  try {
    dirStat = fs.lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') throw _imageError(404, 'NOT_FOUND', `No pending file named "${filename}"`);
    throw err;
  }
  if (!dirStat.isDirectory() || (typeof process.getuid === 'function' && dirStat.uid !== process.getuid())) {
    log.warn('Refused an image read from an unsafe secrets directory', { project: project.name });
    throw _imageError(404, 'NOT_FOUND', `No pending file named "${filename}"`);
  }

  let fd;
  try {
    fd = fs.openSync(path.join(dir, filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    // ELOOP is O_NOFOLLOW refusing a symlink: there is no servable file of that name.
    if (err.code === 'ENOENT' || err.code === 'ELOOP') {
      throw _imageError(404, 'NOT_FOUND', `No pending file named "${filename}"`);
    }
    throw err;
  }
  let buffer;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw _imageError(404, 'NOT_FOUND', `No pending file named "${filename}"`);
    if (st.size > MAX_FILE_BYTES) {
      throw _imageError(413, 'TOO_LARGE', `the file is ${st.size} bytes, over the ${MAX_FILE_BYTES}-byte limit`);
    }
    buffer = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!_hasImageSignature(buffer, contentType)) {
    throw _imageError(415, 'UNSUPPORTED_MEDIA_TYPE', `the file's contents are not a ${contentType} image`);
  }
  return { buffer, contentType, bytes: buffer.length };
}

module.exports = {
  MAX_FILE_BYTES, IMAGE_TYPES,
  secretsDir, scanForAudit, writeSecretFile, listSecretFiles, deleteSecretFile, readImageFile
};
