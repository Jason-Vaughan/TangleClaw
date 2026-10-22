'use strict';

/**
 * The store's shared database handle and the helpers that need nothing but it:
 * the error class, the initialization guard, the JSON reader, the accessor the
 * health check uses, and the two transaction wrappers (a savepoint, and one
 * `BEGIN IMMEDIATE`).
 *
 * `lib/store.js` is the facade: it opens the database in `init()`, binds the
 * handle here and into every domain module with `_bind`, and unbinds them all
 * in `close()`. A module keeps its own copy of the handle so every `_db.`
 * call site reads exactly as it did in the one file; the facade is the only
 * writer of the handle, and a module the facade has not bound fails at first
 * use with `NOT_INITIALIZED` rather than reaching a stale database.
 *
 * Everything below is moved from `lib/store.js` unchanged (#2248); what this
 * file adds is the handle, `_bind` and the export list.
 *
 * @module lib/store/_db
 */

let _db = null;

/**
 * Bind the database handle the facade opened, or unbind it with `null`.
 * @param {import('node:sqlite').DatabaseSync|null} db - The open database, or null on close.
 * @returns {void}
 */
function _bind(db) {
  _db = db;
}

/**
 * Custom error class for store operations.
 */
class StoreError extends Error {
  /**
   * @param {string} message - Error description
   * @param {string} code - Machine-readable error code
   * @param {Error} [cause] - Underlying error
   */
  constructor(message, code, cause) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.detail = message;
    if (cause) this.cause = cause;
  }
}

/**
 * Safely parse a JSON string.
 * @param {string} str - JSON string
 * @param {*} fallback - Fallback value on parse failure
 * @returns {*}
 */
function _jsonParse(str, fallback) {
  if (str == null) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Ensure the database is initialized.
 */
function _ensureDb() {
  if (!_db) {
    throw new StoreError('Store not initialized. Call store.init() first.', 'NOT_INITIALIZED');
  }
}

/**
 * Get the SQLite database instance (for health checks).
 * @returns {DatabaseSync|null}
 */
function getDb() {
  return _db;
}

/**
 * Run `fn` atomically whether or not the caller holds a transaction.
 *
 * Its callers are the startup-control trims, which run inside or outside the
 * fire service's `BEGIN IMMEDIATE`, and the session-rule replacement paths,
 * which must write the replacement and its follow-up together or not at all.
 * A SAVEPOINT, not a BEGIN, because SQLite refuses a nested BEGIN. A savepoint
 * is legal in both places — outside a transaction it opens one and RELEASE
 * commits it; inside one it is a nested scope that RELEASE folds into the
 * caller's — so ownership never has to be sniffed from the runtime (a `DatabaseSync.isTransaction` probe would need a
 * Node minor the product's declared floor does not guarantee).
 * @param {() => *} fn - Synchronous work.
 * @returns {*}
 */
function _withSavepoint(fn) {
  _db.exec('SAVEPOINT with_savepoint');
  try {
    const out = fn();
    _db.exec('RELEASE with_savepoint');
    return out;
  } catch (err) {
    try {
      _db.exec('ROLLBACK TO with_savepoint');
      _db.exec('RELEASE with_savepoint');
    } catch { /* the caller's transaction, if any, decides what happens next */ }
    throw err;
  }
}

/**
 * Run `fn` inside one `BEGIN IMMEDIATE` transaction and return its result:
 * the one write-serializing wrapper the startupControl APIs share. A fire's
 * checks and its intent row are one decision, and a channel's state merge is
 * a read-modify-write; this keeps two concurrent callers from both passing.
 * @param {() => *} fn - Synchronous work.
 * @returns {*} Whatever `fn` returns.
 */
function _startupControlTransaction(fn) {
  _ensureDb();
  _db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    _db.exec('COMMIT');
    return out;
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
}

module.exports = { _bind, StoreError, _ensureDb, _jsonParse, getDb, _withSavepoint, _startupControlTransaction };
