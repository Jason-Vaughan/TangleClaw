'use strict';

/**
 * Where a draft cleared before an injection is kept (#1507).
 *
 * Before TangleClaw pastes into a session it clears the composer, which destroys
 * whatever the operator had typed and not sent. That draft is kept so it can be
 * recovered — but never in the log. The log carries names, never payloads
 * (`observability-strategy.md`, Direction): it is tailed, pasted into issues and
 * handed to whoever is helping, and a half-typed line can hold a password or a
 * token. Even a short hash of a draft is payload-derived — a guessable draft can
 * be confirmed against it — so the log gets only an opaque reference to the
 * entry and its size.
 *
 * **Keyed by attempt, not by tmux name.** A tmux session name is reused by every
 * launch of a project, so a file named after it would hand one attempt's drafts
 * to the next. Each file belongs to one attempt: a project session's database id
 * (`session-<id>`), or, for a pane with no session row (the Project Master), the
 * tmux session's own creation time (`<name>@<created>`), which a relaunch changes.
 *
 * **Private and bounded.** The directory is `0700` and each file `0600`, created
 * without following a symlink planted in their place, and each file keeps its
 * most recent `KEEP` drafts.
 *
 * **Retention.** A file is deleted seven days after its attempt ended — the
 * operator's choice of how long a recoverable draft may outlive the session
 * that held it (Car A3 Chunk 03 plan).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** How many drafts each attempt's file keeps, newest last. */
const KEEP = 20;

/** How long a file outlives the attempt that wrote it. */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** The shapes an attempt key takes: a session row id, or a pane's name and creation time. */
const ATTEMPT_KEY_RE = /^(?:session-\d+|[A-Za-z0-9._-]+@\d+)$/;

/**
 * The directory drafts live in, under the TangleClaw home.
 * @returns {string}
 */
function draftsDir() {
  return path.join(require('./store')._getBasePath(), 'drafts');
}

/**
 * The attempt key for a project session's database row.
 * @param {number|string} sessionId - The session row's id.
 * @returns {string}
 */
function sessionAttemptKey(sessionId) {
  return `session-${sessionId}`;
}

/**
 * The file one attempt's drafts go to.
 * @param {string} attemptKey - From {@link sessionAttemptKey}, or `<name>@<created>`.
 * @returns {string}
 * @throws {Error} When the key is not one of the two shapes, so no caller can
 *   address a path outside the drafts directory.
 */
function draftFile(attemptKey) {
  if (typeof attemptKey !== 'string' || !ATTEMPT_KEY_RE.test(attemptKey)) {
    throw new Error('not an attempt key');
  }
  return path.join(draftsDir(), `${attemptKey}.jsonl`);
}

/**
 * Make the drafts directory, refusing one that is a symlink or someone else's.
 * @returns {string} The directory.
 */
function _ensureDir() {
  const dir = draftsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error('the drafts directory is not a directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error('the drafts directory belongs to another user');
  }
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * The drafts in a file, oldest first, read without following a symlink.
 * @param {string} file - Absolute path.
 * @returns {string[]} Raw JSON lines.
 */
function _readLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    return fs.readFileSync(fd, 'utf8').split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Keep a cleared draft, and describe it for the log without its contents.
 *
 * Throws on any failure; the caller decides what a failure costs.
 *
 * @param {string} attemptKey - The attempt the draft belongs to.
 * @param {{engineId: (string|null), text: string, rows: number, complete: boolean}} draft
 * @returns {{draftRef: string, chars: number, rows: number}} `draftRef` names the
 *   entry (`<attempt>:<id>`) and says nothing about its contents.
 */
function saveDraft(attemptKey, draft) {
  const file = draftFile(attemptKey);
  _ensureDir();
  const id = crypto.randomBytes(4).toString('hex');
  const entry = JSON.stringify({
    id, at: new Date().toISOString(), engineId: draft.engineId || null,
    complete: draft.complete, text: draft.text
  });
  const kept = [..._readLines(file), entry].slice(-KEEP);
  // Written to a fresh name that must not exist (O_EXCL) and is never followed
  // if something is planted there (O_NOFOLLOW), then renamed over the file:
  // rename replaces a symlink at `file` rather than writing through it.
  const tmp = `${file}.${process.pid}.${id}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, `${kept.join('\n')}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return { draftRef: `${attemptKey}:${id}`, chars: [...draft.text].length, rows: draft.rows };
}

/**
 * The drafts kept for one attempt, oldest first.
 * @param {string} attemptKey - The attempt.
 * @returns {Array<{id: string, at: string, engineId: (string|null), complete: boolean, text: string}>}
 */
function readDrafts(attemptKey) {
  return _readLines(draftFile(attemptKey)).map((l) => JSON.parse(l));
}

/**
 * Delete the files whose attempt ended more than `RETAIN_MS` ago.
 *
 * Never throws: a failed sweep leaves files in place, which is the side a
 * recovery store should fail on, and is reported in the result.
 *
 * @param {object} [options]
 * @param {number} [options.now] - Clock, for tests.
 * @param {(attemptKey: string) => (number|null)} [options.endedAtMs] - When the
 *   attempt ended, or null while it is still running. Defaults to the session
 *   row for `session-<id>` and the last write for any other attempt.
 * @returns {{deleted: string[], errors: string[]}}
 */
function pruneDrafts(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const endedAtMs = options.endedAtMs || _endedAtMs;
  const deleted = [];
  const errors = [];
  let names = [];
  try {
    names = fs.readdirSync(draftsDir());
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(err.message);
    return { deleted, errors };
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const key = name.slice(0, -'.jsonl'.length);
    if (!ATTEMPT_KEY_RE.test(key)) continue;
    try {
      const ended = endedAtMs(key);
      if (ended !== null && now - ended >= RETAIN_MS) {
        fs.unlinkSync(path.join(draftsDir(), name));
        deleted.push(key);
      }
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
    }
  }
  return { deleted, errors };
}

/**
 * When an attempt ended, from the record that knows.
 *
 * A session row says so directly. A pane with no row (`<name>@<created>`) has
 * no end record, so its last draft write stands in for it: the file is kept a
 * full retention period after the last draft it received.
 *
 * @param {string} attemptKey - The attempt.
 * @returns {number|null} Epoch ms, or null while the attempt is live.
 */
function _endedAtMs(attemptKey) {
  const m = /^session-(\d+)$/.exec(attemptKey);
  if (m) {
    const store = require('./store');
    const row = store.sessions.get(Number(m[1]));
    if (!row) return fs.lstatSync(draftFile(attemptKey)).mtimeMs;
    if (row.status === store.SESSION_STATUS.ACTIVE) return null;
    const ended = Date.parse(String(row.endedAt || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(row.endedAt || '')) ? '' : 'Z'));
    return Number.isFinite(ended) ? ended : fs.lstatSync(draftFile(attemptKey)).mtimeMs;
  }
  return fs.lstatSync(draftFile(attemptKey)).mtimeMs;
}

module.exports = {
  saveDraft, readDrafts, pruneDrafts, draftFile, draftsDir, sessionAttemptKey, KEEP, RETAIN_MS
};
