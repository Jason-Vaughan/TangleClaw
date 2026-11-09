'use strict';

/**
 * Cross-machine secure clipboard sync and file/secret uploader (#1032).
 *
 * Lets the operator's browser carry a secret — an API key, an SSH key, a
 * token — into a project's own session workspace without it ever appearing
 * in a log line, a chat history, or a terminal command history. Two
 * delivery shapes:
 *
 *   - **file**: written to `<project>/.tangleclaw/secrets/<filename>`, a
 *     `0700` directory holding `0600` files, the same posture
 *     `lib/draft-store.js` uses for its own private recovery store.
 *   - **paste**: injected directly into the project's live tmux pane via
 *     `lib/tmux.js#sendKeys` (reached through `lib/sessions.js#injectCommand`
 *     from the route — this module owns only the FILE half, so it stays
 *     unit-testable without a real tmux binary).
 *
 * **The log carries names and types, never values.** Every write here runs
 * the content through `lib/secret-scan.js` (flag-only: pattern TYPES, never
 * the matched text) and logs only `{bytes, secretTypesDetected}` — the same
 * privacy invariant `lib/draft-store.js` states for its own log lines, for
 * the same reason: even a short hash is payload-derived and
 * guessable-confirmable, so nothing derived from the secret itself is kept
 * beyond its byte count and which credential shapes it resembled.
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
 * `ATTEMPT_KEY_RE` uses for its own caller-supplied key.
 */
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

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

module.exports = {
  MAX_FILE_BYTES,
  secretsDir, scanForAudit, writeSecretFile, listSecretFiles, deleteSecretFile
};
