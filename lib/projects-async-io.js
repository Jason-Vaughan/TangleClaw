'use strict';

/**
 * Async, bounded, non-blocking project-path I/O helpers (#1350 Slice 1,
 * v5.61.0 Car 61-D, Architect Ruling A1350).
 *
 * `lib/projects.js` makes 43 SYNCHRONOUS filesystem calls on paths the
 * operator chose. Run on the server's single event loop, a call against a
 * TCC-protected or stalled network mount does not fail -- it never answers,
 * and a synchronous call cannot be interrupted by any deadline, so the whole
 * single-threaded server wedges for the life of the process. #859, #883 and
 * #884 already fixed this for the scan and project-facts paths; #1350 is the
 * remainder those sweeps never reached.
 *
 * **This module is the reusable primitive layer only** -- Ruling A1350's own
 * file envelope names exactly this file and its test, not `lib/projects.js`
 * itself. Replacing the 43 call sites with these readers is a later slice.
 *
 * Three `fs.promises`-based readers, each non-blocking (an async call never
 * freezes the event loop, however long the real mount takes to answer --
 * unlike the sync call it is meant to replace), bounded in concurrency (a
 * cap on how many of THIS module's OWN operations are in flight at once, so
 * a burst across many operator paths cannot exhaust file descriptors), timed
 * out (a caller-visible deadline -- the underlying op has no cancellation
 * API, so a timeout here means "stop waiting and report it," never "the
 * real read actually stopped"), and short-TTL cached (a repeat call for the
 * same path within the window is answered from memory, never a second
 * syscall) -- the same per-path timeout/TTL discipline `lib/dir-scanner.js`
 * already established for its own child-process scanning path, adapted here
 * to this module's simpler same-process shape.
 *
 * @module lib/projects-async-io
 */

const fs = require('node:fs/promises');

/**
 * Seams for tests: the real `fs.promises` surface this module calls through,
 * never called directly by name, so a test can inject a fake with
 * artificial delay (to exercise the timeout and concurrency bound
 * deterministically, without a real stalled mount) or a controlled failure.
 */
const _internal = { fs };

/** How many of this module's own fs operations may be in flight at once, per reader. */
const DEFAULT_CONCURRENCY = 8;

/** How long a single operation may take before its caller gives up waiting. */
const DEFAULT_TIMEOUT_MS = 5000;

/** How long a successful result is served from cache before the next call re-reads. */
const DEFAULT_CACHE_TTL_MS = 2000;

/**
 * A result this module's own deadline gave up waiting for -- never a real
 * filesystem error. The underlying `fs.promises` call is never cancelled:
 * Node gives it no cancellation API, so a slow mount's real read keeps
 * running in the background after this rejects.
 */
class TimeoutError extends Error {
  /**
   * @param {string} what - Named for the error message (e.g. `reading /a/b`).
   * @param {number} timeoutMs
   */
  constructor(what, timeoutMs) {
    super(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    this.name = 'TimeoutError';
    this.code = 'PROJECTS_ASYNC_IO_TIMEOUT';
    this.what = what;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race a promise against a deadline.
 * @param {Promise<*>} promise
 * @param {number} timeoutMs - `<= 0` disables the deadline.
 * @param {string} what - Named for the error message.
 * @returns {Promise<*>}
 */
function _withTimeout(promise, timeoutMs, what) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A bounded-concurrency queue: at most `limit` of its own functions run at
 * once, the rest wait their turn in order. One instance per exported
 * reader, so a burst of `scanProjectMetadataAsync` calls cannot starve
 * `readProjectFileAsync`'s own budget, and vice versa.
 * @param {number} limit
 * @returns {{run: function(function(): Promise<*>): Promise<*>}}
 */
function _boundedQueue(limit) {
  let active = 0;
  const waiting = [];
  function _next() {
    if (active >= limit || waiting.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(
      (v) => { active -= 1; resolve(v); _next(); },
      (err) => { active -= 1; reject(err); _next(); }
    );
  }
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject });
        _next();
      });
    }
  };
}

/**
 * A short-TTL cache keyed by an arbitrary string. Caches a settled,
 * FULFILLED result only -- never a rejection, so a transient failure (a
 * timeout, a momentarily unreachable mount) is always retried on the very
 * next call rather than repeated from memory for the rest of the window.
 * @param {number} ttlMs
 * @returns {{get: function(string): *, set: function(string, *): void, clear: function(): void}}
 */
function _ttlCache(ttlMs) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.set(key, { value, at: Date.now() });
    },
    clear() {
      entries.clear();
    }
  };
}

const _readQueue = _boundedQueue(DEFAULT_CONCURRENCY);
const _statQueue = _boundedQueue(DEFAULT_CONCURRENCY);
const _scanQueue = _boundedQueue(DEFAULT_CONCURRENCY);
const _readCache = _ttlCache(DEFAULT_CACHE_TTL_MS);
const _statCache = _ttlCache(DEFAULT_CACHE_TTL_MS);
const _scanCache = _ttlCache(DEFAULT_CACHE_TTL_MS);

/**
 * Read a project-chosen file's content, async, bounded, timed out and
 * short-TTL cached. Replaces a synchronous `fs.readFileSync` call site.
 * @param {string} filePath - Absolute path the operator chose.
 * @param {object} [options]
 * @param {string} [options.encoding='utf8']
 * @param {number} [options.timeoutMs] - Default {@link DEFAULT_TIMEOUT_MS}.
 * @param {boolean} [options.noCache] - Skip the cache for this one call, read and write alike.
 * @returns {Promise<string>}
 * @throws {TimeoutError|Error} A real fs error (e.g. `ENOENT`) or a timeout; never swallowed.
 */
async function readProjectFileAsync(filePath, options = {}) {
  const encoding = options.encoding || 'utf8';
  const key = `read:${encoding}:${filePath}`;
  if (!options.noCache) {
    const cached = _readCache.get(key);
    if (cached !== undefined) return cached;
  }
  const value = await _withTimeout(
    _readQueue.run(() => _internal.fs.readFile(filePath, encoding)),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    `reading ${filePath}`
  );
  if (!options.noCache) _readCache.set(key, value);
  return value;
}

/**
 * Stat a project-chosen path, async, bounded, timed out and short-TTL
 * cached. Replaces a synchronous `fs.statSync`/`fs.lstatSync`/
 * `fs.existsSync` call site: `exists` answers the `existsSync` shape
 * directly (an `ENOENT` is not an error here, just `exists: false`); any
 * OTHER stat failure (e.g. `EACCES`) still rejects, since that is not "the
 * path is absent," and silently reading it as absent would be the wrong
 * answer for a caller branching on existence.
 * @param {string} targetPath - Absolute path the operator chose.
 * @param {object} [options]
 * @param {boolean} [options.followSymlinks=true] - `false` uses `lstat`.
 * @param {number} [options.timeoutMs] - Default {@link DEFAULT_TIMEOUT_MS}.
 * @param {boolean} [options.noCache]
 * @returns {Promise<{exists: boolean, stats: (import('node:fs').Stats|null)}>}
 */
async function statProjectPathAsync(targetPath, options = {}) {
  const followSymlinks = options.followSymlinks !== false;
  const key = `stat:${followSymlinks}:${targetPath}`;
  if (!options.noCache) {
    const cached = _statCache.get(key);
    if (cached !== undefined) return cached;
  }
  let result;
  try {
    const stats = await _withTimeout(
      _statQueue.run(() => (followSymlinks ? _internal.fs.stat(targetPath) : _internal.fs.lstat(targetPath))),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      `stat-ing ${targetPath}`
    );
    result = { exists: true, stats };
  } catch (err) {
    if (err && err.code === 'ENOENT') result = { exists: false, stats: null };
    else throw err;
  }
  if (!options.noCache) _statCache.set(key, result);
  return result;
}

/**
 * List a project-chosen directory's own entries, async, bounded, timed out
 * and short-TTL cached. Replaces a synchronous `fs.readdirSync` call site.
 * A directory that does not exist answers `[]`, the same "nothing here"
 * shape a `fs.readdirSync` caller in this codebase already branches on; any
 * other failure (e.g. `ENOTDIR`, `EACCES`) still rejects.
 * @param {string} dirPath - Absolute directory path the operator chose.
 * @param {object} [options]
 * @param {boolean} [options.withFileTypes=false]
 * @param {number} [options.timeoutMs] - Default {@link DEFAULT_TIMEOUT_MS}.
 * @param {boolean} [options.noCache]
 * @returns {Promise<Array<string|import('node:fs').Dirent>>}
 */
async function scanProjectMetadataAsync(dirPath, options = {}) {
  const withFileTypes = options.withFileTypes === true;
  const key = `scan:${withFileTypes}:${dirPath}`;
  if (!options.noCache) {
    const cached = _scanCache.get(key);
    if (cached !== undefined) return cached;
  }
  let result;
  try {
    result = await _withTimeout(
      _scanQueue.run(() => _internal.fs.readdir(dirPath, withFileTypes ? { withFileTypes: true } : undefined)),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      `scanning ${dirPath}`
    );
  } catch (err) {
    if (err && err.code === 'ENOENT') result = [];
    else throw err;
  }
  if (!options.noCache) _scanCache.set(key, result);
  return result;
}

/**
 * Drop every cached result from every reader. Test-only seam; production
 * code relies on the short TTL alone to go stale.
 * @returns {void}
 */
function _clearCaches() {
  _readCache.clear();
  _statCache.clear();
  _scanCache.clear();
}

module.exports = {
  TimeoutError,
  DEFAULT_CONCURRENCY,
  readProjectFileAsync,
  statProjectPathAsync,
  scanProjectMetadataAsync,
  _clearCaches,
  _internal
};
