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
 * @param {string} logDir - Directory for log files (e.g. ~/.tangleclaw/logs)
 */
function initFileLogging(logDir) {
  _logDir = logDir;
  _logFile = path.join(logDir, 'tangleclaw.log');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  }

  _rotateIfNeeded();
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

  // stdout/stderr
  if (levelIndex >= LEVELS.error) {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }

  // file (synchronous append)
  if (_fd !== null) {
    try {
      fs.writeSync(_fd, line + '\n');
      _writeCount++;

      if (_writeCount % ROTATION_CHECK_INTERVAL === 0) {
        _rotateIfNeeded();
      }
    } catch (err) {
      process.stderr.write(`[LOG WRITE ERROR] ${err.message}\n`);
    }
  }
}

/**
 * Rotate log file if it exceeds the size threshold.
 */
function _rotateIfNeeded() {
  if (!_logFile) return;

  try {
    if (!fs.existsSync(_logFile)) return;

    const stats = fs.statSync(_logFile);
    if (stats.size < MAX_LOG_SIZE) return;

    // Close current fd before rotating
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
  } catch (err) {
    process.stderr.write(`[LOG ROTATION ERROR] ${err.message}\n`);
  }
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

module.exports = { createLogger, setLevel, getLevel, initFileLogging, closeFileLogging };
