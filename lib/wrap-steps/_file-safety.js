'use strict';

/**
 * What KIND of file an uncommitted path is, and whether a wrap may commit it (#1858).
 *
 * `./_file-ownership` answers WHO changed a file and `./_secret-check` answers
 * whether its text carries a credential. Neither answers what the file is, so a
 * runtime database, a scratch dump and a new project plan all reached the
 * operator as the same Include / Leave choice, with nothing to say which answer
 * was safe. `SECURITY.md` records that the runtime database holds remote-service
 * tokens in plaintext, which made the database one radio click from a public
 * commit.
 *
 * Four classes:
 * - **protected** — a SQLite database or one of its sidecars. Never staged by a
 *   wrap, whatever the owner rules or the operator's answer say; the only way
 *   to commit one is a separate ordinary commit outside the wrap.
 * - **local** — scratch, temp, cache and log output. Recommended Keep local; the
 *   operator may still Include it.
 * - **durable** — TangleClaw-authored project documents. Recommended Include.
 * - **ambiguous** — everything else, new source included. No recommendation:
 *   a real module and a throwaway script look alike from the path.
 *
 * A recommendation is advice. It never becomes a decision here; the drawer shows
 * it beside an unchecked choice.
 *
 * Generic directory names (`scratch`, `tmp`, `cache`…) count as local only at the
 * repository root, where they are conventional runtime directories: `lib/cache/`
 * is source. `node_modules` and `.cache` are local wherever they sit.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The first 16 bytes of every SQLite 3 database file. */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** Extensions a SQLite database is conventionally saved under (lower case). */
const DB_EXTENSIONS = Object.freeze(['.sqlite', '.sqlite3', '.db', '.db3']);

/** Files SQLite writes beside a database while it is open. */
const DB_SIDECAR_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal']);

/**
 * TangleClaw's own runtime database, wherever a project happens to hold a copy.
 * The extension rule already covers both; they are named so the class has a
 * stated anchor even if the extension list changes.
 */
const KNOWN_RUNTIME_PATHS = Object.freeze(['data/tangleclaw.db', 'data/tangleclaw.sqlite']);

/** Basenames that end in `.db` but are OS thumbnail caches, not databases (lower case). */
const LOCAL_BASENAMES = Object.freeze(['.ds_store', 'thumbs.db']);

/** Directories that are local runtime output only at the repository root. */
const ROOT_LOCAL_DIRS = Object.freeze(['scratch', 'tmp', 'temp', 'cache', 'logs', 'coverage']);

/** Directories that are local runtime output at any depth. */
const ANY_DEPTH_LOCAL_DIRS = Object.freeze(['node_modules', '.cache']);

/** Suffixes of local runtime output (lower case). */
const LOCAL_SUFFIXES = Object.freeze(['.log', '.tmp', '.swp', '~']);

/** TangleClaw-authored project documents: plans may nest, the other two may not. */
const DURABLE_PATTERNS = Object.freeze([
  /^\.tangleclaw\/plans\/.+\.md$/,
  /^\.tangleclaw\/priming\/[^/]+\.md$/,
  /^\.tangleclaw\/memories\/[^/]+\.md$/
]);

/** The four classes. */
const CLASSES = Object.freeze({ PROTECTED: 'protected', LOCAL: 'local', DURABLE: 'durable', AMBIGUOUS: 'ambiguous' });

/** Why each class got its answer, in words the drawer shows the operator. */
const WHY = Object.freeze({
  protected: 'a SQLite database, which can hold tokens in plaintext. A wrap never commits one. If it truly belongs in the project, commit it yourself in a separate ordinary commit outside the wrap',
  local: 'scratch, temp, cache or log output that normally stays on this machine',
  durable: 'a TangleClaw plan, priming prompt or memory, which is project content'
});

/**
 * Whether a path names a database by its file name alone.
 *
 * @param {string} lowerRel - Repo-root-relative path, lower-cased.
 * @returns {boolean}
 */
function _isDbName(lowerRel) {
  return DB_EXTENSIONS.some((ext) => lowerRel.endsWith(ext)) || KNOWN_RUNTIME_PATHS.includes(lowerRel);
}

/**
 * Whether a path is a SQLite sidecar of a file whose name marks it as a database.
 * `notes-wal` is not a sidecar; `app.db-wal` is.
 *
 * @param {string} lowerRel - Repo-root-relative path, lower-cased.
 * @returns {boolean}
 */
function _isDbSidecar(lowerRel) {
  const suffix = DB_SIDECAR_SUFFIXES.find((s) => lowerRel.endsWith(s));
  return Boolean(suffix) && _isDbName(lowerRel.slice(0, -suffix.length));
}

/**
 * Whether a regular file starts with the SQLite header. A symbolic link is never
 * followed (git commits the link text, not the target) and anything that cannot
 * be read is simply not a match.
 *
 * @param {string|null} root - Repository root, or null when unknown.
 * @param {string} rel - Repo-root-relative path.
 * @returns {boolean}
 */
function _hasSqliteHeader(root, rel) {
  if (!root) return false;
  const abs = path.join(root, rel);
  let fd = null;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size < SQLITE_HEADER.length) return false;
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(SQLITE_HEADER.length);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return n === buf.length && buf.equals(SQLITE_HEADER);
  } catch {
    // Unreadable or gone between status and here: the name rules have already
    // had their say, and an unreadable file has no header to match.
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed or never valid */ }
    }
  }
}

/**
 * Whether a path is local runtime output by name.
 *
 * @param {string} rel - Repo-root-relative path, forward slashes.
 * @returns {boolean}
 */
function _isLocalName(rel) {
  const lower = rel.toLowerCase();
  const segments = rel.split('/');
  const base = segments[segments.length - 1].toLowerCase();
  if (LOCAL_BASENAMES.includes(base)) return true;
  if (segments.length > 1 && ROOT_LOCAL_DIRS.includes(segments[0].toLowerCase())) return true;
  if (segments.slice(0, -1).some((s) => ANY_DEPTH_LOCAL_DIRS.includes(s.toLowerCase()))) return true;
  return LOCAL_SUFFIXES.some((s) => lower.endsWith(s));
}

/**
 * The class of one path, with the recommendation it earns.
 *
 * @param {string|null} root - Repository root (for the header read), or null.
 * @param {string} rel - Repo-root-relative path, forward slashes.
 * @returns {{class:string, recommendation:('include'|'leave'|null), why:(string|null)}}
 */
function safetyOf(root, rel) {
  const p = String(rel || '');
  const lower = p.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  // Checked before the database rule: `Thumbs.db` ends in `.db` and is a Windows
  // thumbnail cache, not a database.
  if (LOCAL_BASENAMES.includes(base)) return _answer(CLASSES.LOCAL);
  if (_isDbName(lower) || _isDbSidecar(lower) || _hasSqliteHeader(root, p)) return _answer(CLASSES.PROTECTED);
  if (_isLocalName(p)) return _answer(CLASSES.LOCAL);
  if (DURABLE_PATTERNS.some((re) => re.test(p))) return _answer(CLASSES.DURABLE);
  return _answer(CLASSES.AMBIGUOUS);
}

/**
 * The answer object for a class.
 *
 * @param {string} cls - One of {@link CLASSES}.
 * @returns {{class:string, recommendation:('include'|'leave'|null), why:(string|null)}}
 */
function _answer(cls) {
  const recommendation = cls === CLASSES.DURABLE ? 'include'
    : (cls === CLASSES.LOCAL || cls === CLASSES.PROTECTED ? 'leave' : null);
  return { class: cls, recommendation, why: WHY[cls] || null };
}

/**
 * Anchored ignore lines the operator could add for files kept local.
 *
 * Text only; nothing here writes an ignore file. Each path gets its exact,
 * root-anchored line. A root-level local directory (`/scratch/`) is offered in
 * its place only when that directory cannot hide anything the project may want:
 * git tracks nothing under it, and every uncommitted path under it is local or
 * protected. So a directory that also carries source, like `data/`, is never
 * suggested.
 *
 * @param {string[]} keptLocal - Repo-root-relative paths to suggest lines for.
 * @param {object} context
 * @param {string[]} context.dirty - Every uncommitted path in the tree.
 * @param {(dir: string) => boolean} context.hasTracked - Whether git tracks
 *   anything under a repo-root-relative directory.
 * @param {(rel: string) => string} context.classOf - The class of a path.
 * @returns {string[]} Sorted, de-duplicated ignore lines.
 */
function ignoreSuggestions(keptLocal, { dirty, hasTracked, classOf }) {
  const out = new Set();
  const dirOk = new Map();
  const safeDir = (dir) => {
    if (!dirOk.has(dir)) {
      const under = (dirty || []).filter((p) => p.startsWith(`${dir}/`));
      dirOk.set(dir, !hasTracked(dir)
        && under.every((p) => [CLASSES.LOCAL, CLASSES.PROTECTED].includes(classOf(p))));
    }
    return dirOk.get(dir);
  };
  for (const p of keptLocal || []) {
    const first = p.split('/')[0];
    const rootLocalDir = p.includes('/') && ROOT_LOCAL_DIRS.includes(first.toLowerCase());
    out.add(rootLocalDir && safeDir(first) ? `/${_literal(first)}/` : `/${_literal(p)}`);
  }
  return [...out].sort();
}

/**
 * Escape a path so gitignore reads it as that one literal name.
 *
 * @param {string} rel - Repo-root-relative path.
 * @returns {string}
 */
function _literal(rel) {
  return rel.replace(/[*?[\]\\!#]/g, '\\$&');
}

module.exports = {
  safetyOf,
  ignoreSuggestions,
  CLASSES,
  WHY,
  SQLITE_HEADER,
  KNOWN_RUNTIME_PATHS
};
