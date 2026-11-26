'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 3;
const ROTATION_CHECK_INTERVAL = 1000; // check every N writes

let _level = LEVELS.info;
let _logDir = null;
let _logFile = null;
let _fd = null;
let _writeCount = 0;
let _consoleStream = null;
let _streamErrorGuardsInstalled = false;

/**
 * Attach idempotent `'error'` listeners to `process.stdout`/`process.stderr`
 * that swallow `EPIPE`/`ERR_STREAM_DESTROYED` (#3315). Without this, a
 * closed pipe's write raises an unhandled stream `'error'` event, which
 * becomes an `uncaughtException` — and if that handler itself logs, the
 * retry raises the same error again, forever. Installed once at module
 * load, unconditionally: every process that requires this module gets the
 * guard, not just a scratch-mode one.
 */
function _ensureStreamErrorGuards() {
  if (_streamErrorGuardsInstalled) return;
  _streamErrorGuardsInstalled = true;
  const swallow = () => {};
  process.stdout.on('error', swallow);
  process.stderr.on('error', swallow);
}
_ensureStreamErrorGuards();

/**
 * Write to a console stream without ever throwing. A destroyed/closed pipe
 * (EPIPE from a harness that died, `ERR_STREAM_DESTROYED`) must not crash
 * the process or recurse into an `uncaughtException` handler that likely
 * also logs (#3315).
 * @param {{write: function, destroyed?: boolean, writableEnded?: boolean, writable?: boolean}} stream
 * @param {string} text
 */
function _safeStreamWrite(stream, text) {
  if (!stream || stream.destroyed || stream.writableEnded || stream.writable === false) return;
  try {
    stream.write(text);
  } catch (_err) {
    // Swallowed: the stream's own 'error' event is handled by
    // _ensureStreamErrorGuards above; a synchronous throw here must not
    // escape into whatever caller was just trying to log something.
  }
}

/**
 * Pin all console output to one stream, regardless of level.
 *
 * The default split (below-ERROR to stdout, ERROR to stderr) suits a long-lived
 * server, where stdout is just the console. It is wrong for a CLI whose stdout
 * is a parsed contract: a single INFO line lands in front of the payload and
 * silently breaks every caller that reads stdout as data. Passing
 * `process.stderr` here keeps diagnostics visible and stdout clean.
 *
 * Level filtering and file logging are unaffected — this only redirects the
 * console copy, so an audit trail written via {@link initFileLogging} survives.
 *
 * @param {{write: function}|null} stream - Stream for all levels, or null to
 *   restore the default stdout/stderr split.
 */
function setConsoleStream(stream) {
  _consoleStream = stream;
}

/**
 * Set the minimum log level.
 * @param {string} level - One of 'debug', 'info', 'warn', 'error'
 */
function setLevel(level) {
  const normalized = String(level).toLowerCase();
  if (LEVELS[normalized] === undefined) {
    throw new Error(`Invalid log level: "${level}". Must be one of: ${Object.keys(LEVELS).join(', ')}`);
  }
  _level = LEVELS[normalized];
}

/**
 * Get the current log level name.
 * @returns {string}
 */
function getLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === _level);
}

/**
 * Initialize file logging to the specified directory.
 *
 * @param {string} logDir - Directory for log files (e.g. ~/.tangleclaw/logs)
 * @param {object} [options]
 * @param {boolean} [options.rotate=true] - Rotate an oversized log **on open**.
 *   Pass `false` from a short-lived process sharing the server's log directory:
 *   rotation renames the file, and the long-running server holds an open fd to
 *   the old inode, so it would go on writing to `tangleclaw.log.1` unnoticed
 *   until its next restart. The owner of the log owns its rotation.
 *   Scope note: this gates the open-time check only. `_write` still runs a
 *   rotation check every `ROTATION_CHECK_INTERVAL` writes regardless — out of
 *   reach for a process that logs a line or two, which is the intended caller,
 *   but not a process-wide guarantee.
 */
function initFileLogging(logDir, options = {}) {
  _logDir = logDir;
  _logFile = path.join(logDir, 'tangleclaw.log');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  }

  if (options.rotate !== false) _rotateIfNeeded();
  _openFd();
}

/**
 * Close the log file.
 */
function closeFileLogging() {
  if (_fd !== null) {
    fs.closeSync(_fd);
    _fd = null;
  }
  _logDir = null;
  _logFile = null;
  _writeCount = 0;
}

/**
 * Format a log line.
 * @param {string} levelName - Level label (e.g. 'INFO')
 * @param {string} module - Module tag
 * @param {string} message - Log message
 * @param {object} [context] - Optional key=value context
 * @returns {string}
 */
function _formatLine(levelName, module, message, context) {
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [${levelName}] [${module}] ${message}`;

  if (context && typeof context === 'object' && Object.keys(context).length > 0) {
    const pairs = Object.entries(context)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    line += ` ${pairs}`;
  }

  return line;
}

/**
 * Write a log line to all outputs.
 * @param {number} levelIndex - Numeric level
 * @param {string} module - Module tag
 * @param {string} message - Log message
 * @param {object} [context] - Optional context
 */
function _write(levelIndex, module, message, context) {
  if (levelIndex < _level) return;

  const levelName = LEVEL_NAMES[levelIndex];
  const line = _formatLine(levelName, module, message, context);

  // stdout/stderr — or a single pinned stream (see setConsoleStream).
  const stream = _consoleStream
    || (levelIndex >= LEVELS.error ? process.stderr : process.stdout);
  _safeStreamWrite(stream, line + '\n');

  // file (synchronous append)
  if (_fd !== null) {
    try {
      fs.writeSync(_fd, line + '\n');
      _writeCount++;

      if (_writeCount % ROTATION_CHECK_INTERVAL === 0) {
        _rotateIfNeeded();
      }
    } catch (err) {
      _safeStreamWrite(process.stderr, `[LOG WRITE ERROR] ${err.message}\n`);
    }
  }
}

/**
 * Rotate log file if it exceeds the size threshold.
 *
 * #3315: the old version checked `fs.existsSync(_logFile)` / `fs.statSync`
 * on the PATH alone, which silently became a no-op forever once the path
 * was unlinked (or its whole directory removed) while `_fd` stayed open —
 * `_fd` kept writing to the orphaned inode with nothing ever rotating it.
 * With `_fd` open, the open descriptor's own `fstatSync` is the source of
 * truth for size, and its inode is compared against the path's to detect
 * exactly that unlinked/replaced case.
 */
function _rotateIfNeeded() {
  if (!_logFile) return;

  try {
    if (_fd === null) {
      // Rotate-on-open: nothing held open yet, so the path is all there is
      // to check (initFileLogging calls this BEFORE _openFd()).
      if (!fs.existsSync(_logFile)) return;
      if (fs.statSync(_logFile).size < MAX_LOG_SIZE) return;
      _rotateFile();
      return;
    }

    const fdStats = fs.fstatSync(_fd);
    const unlinked = !fs.existsSync(_logFile) || fs.statSync(_logFile).ino !== fdStats.ino;

    if (unlinked) {
      fs.closeSync(_fd);
      _fd = null;
      if (!fs.existsSync(_logDir)) {
        // The log directory itself is gone (e.g. a removed scratch
        // TANGLECLAW_HOME) -- nothing to reopen into. Stop file logging
        // rather than keep writing to an unlinked inode in a directory
        // that no longer exists.
        return;
      }
      if (fdStats.size >= MAX_LOG_SIZE) _rotateFile();
      else _openFd();
      return;
    }

    if (fdStats.size < MAX_LOG_SIZE) return;
    _rotateFile();
  } catch (err) {
    _safeStreamWrite(process.stderr, `[LOG ROTATION ERROR] ${err.message}\n`);
    // Hard ceiling (#3315): rotation itself failed -- if the open
    // descriptor has already grown to double the normal cap, stop writing
    // rather than let a single fd grow unbounded forever.
    if (_fd !== null) {
      try {
        if (fs.fstatSync(_fd).size >= MAX_LOG_SIZE * 2) {
          fs.closeSync(_fd);
          _fd = null;
        }
      } catch (_statErr) {
        // Best effort: if even fstat fails there is nothing more this
        // guard can safely check.
      }
    }
  }
}

/**
 * The rename-chain-then-reopen half of rotation, shared by the normal
 * size-based path and the unlinked-file recovery path in
 * {@link _rotateIfNeeded} (#3315).
 */
function _rotateFile() {
  if (_fd !== null) {
    fs.closeSync(_fd);
    _fd = null;
  }

  // Shift existing rotated files (work backwards to avoid overwriting)
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    const from = i === 1 ? _logFile : `${_logFile}.${i - 1}`;
    const to = `${_logFile}.${i}`;
    if (fs.existsSync(from)) {
      fs.renameSync(from, to);
    }
  }

  // Reopen fd for new file
  _openFd();
}

/**
 * Open or reopen the log file descriptor for appending.
 */
function _openFd() {
  if (!_logFile) return;
  _fd = fs.openSync(_logFile, 'a', 0o600);
}

/**
 * Create a module-tagged logger instance.
 * @param {string} module - Module name (e.g. 'server', 'store', 'tmux')
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
function createLogger(module) {
  return {
    /**
     * Log a debug message.
     * @param {string} message
     * @param {object} [context]
     */
    debug(message, context) {
      _write(LEVELS.debug, module, message, context);
    },

    /**
     * Log an info message.
     * @param {string} message
     * @param {object} [context]
     */
    info(message, context) {
      _write(LEVELS.info, module, message, context);
    },

    /**
     * Log a warning message.
     * @param {string} message
     * @param {object} [context]
     */
    warn(message, context) {
      _write(LEVELS.warn, module, message, context);
    },

    /**
     * Log an error message.
     * @param {string} message
     * @param {object} [context]
     */
    error(message, context) {
      _write(LEVELS.error, module, message, context);
    }
  };
}

/**
 * Whether file logging currently holds an open descriptor. Test-only (#3315):
 * lets a test confirm `_rotateIfNeeded` actually closed `_fd` when the log
 * directory disappeared, rather than silently writing to an unlinked inode
 * forever — `_fd` is module-private otherwise.
 * @returns {boolean}
 */
function _isFileLoggingActiveForTesting() {
  return _fd !== null;
}

module.exports = {
  createLogger, setLevel, getLevel, setConsoleStream, initFileLogging, closeFileLogging,
  _isFileLoggingActiveForTesting
};
