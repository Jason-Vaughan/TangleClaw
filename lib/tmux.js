'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('tmux');

const SESSION_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_TIMEOUT = 5000;

/**
 * Convert a project name to a tmux-safe session name.
 * Replaces spaces with hyphens and strips characters not in [a-zA-Z0-9_-].
 * @param {string} name - Project name
 * @returns {string}
 */
function toSessionName(name) {
  return name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Validate a tmux session name.
 * @param {string} name - Session name to validate
 * @returns {boolean}
 */
function isValidSessionName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 128) return false;
  return SESSION_NAME_REGEX.test(name);
}

/**
 * Execute a tmux command with timeout protection.
 * @param {string} command - Shell command to run
 * @param {object} [options] - Options
 * @param {number} [options.timeout] - Timeout in ms (default 5000)
 * @returns {string} - stdout output
 */
function _exec(command, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  try {
    return execSync(command, { timeout, encoding: 'utf8' }).trim();
  } catch (err) {
    if (err.killed) {
      log.error('tmux command timed out', { command, timeout });
      throw new Error(`tmux command timed out after ${timeout}ms`);
    }
    throw err;
  }
}

/**
 * List all tmux sessions.
 * @returns {{ name: string, windows: number, created: string, attached: boolean }[]}
 */
function listSessions() {
  try {
    const output = _exec('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}" 2>/dev/null');
    if (!output) return [];
    return output.split('\n').filter(Boolean).map((line) => {
      const [name, windows, created, attached] = line.split('|');
      return {
        name,
        windows: parseInt(windows, 10) || 1,
        created: created || '',
        attached: attached === '1'
      };
    });
  } catch {
    return [];
  }
}

/**
 * Check if a tmux session exists.
 * @param {string} name - Session name
 * @returns {boolean}
 */
function hasSession(name) {
  try {
    _exec(`tmux has-session -t ${_escapeArg(name)} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new tmux session.
 * @param {string} name - Session name
 * @param {object} [options] - Options
 * @param {string} [options.cwd] - Working directory
 * @param {string} [options.command] - Initial command to run
 * @param {object} [options.env] - Environment variables
 * @returns {boolean} - Whether session was created
 */
function createSession(name, options = {}) {
  if (!isValidSessionName(name)) {
    throw new Error(`Invalid tmux session name: "${name}"`);
  }

  if (hasSession(name)) {
    log.warn('Session already exists', { name });
    return false;
  }

  let cmd = `tmux new-session -d -s ${_escapeArg(name)}`;

  if (options.cwd) {
    cmd += ` -c ${_escapeArg(options.cwd)}`;
  }

  if (options.command) {
    cmd += ` ${_escapeArg(options.command)}`;
  }

  _exec(cmd);

  // Set environment variables (after session exists)
  if (options.env && typeof options.env === 'object') {
    for (const [key, value] of Object.entries(options.env)) {
      try {
        _exec(`tmux set-environment -t ${_escapeArg(name)} ${_escapeArg(key)} ${_escapeArg(String(value))}`);
      } catch (err) {
        log.warn('Failed to set env var', { name, key, error: err.message });
      }
    }
  }
  log.info('Created tmux session', { name });
  return true;
}

/**
 * Kill a tmux session.
 * @param {string} name - Session name
 * @returns {boolean} - Whether session was killed
 */
function killSession(name) {
  if (!hasSession(name)) {
    return false;
  }

  _exec(`tmux kill-session -t ${_escapeArg(name)}`);
  log.info('Killed tmux session', { name });
  return true;
}

/**
 * Send keys to a tmux session.
 * @param {string} session - Session name
 * @param {string} text - Text to send
 * @param {object} [options] - Options
 * @param {boolean} [options.enter] - Whether to send Enter after text (default true)
 */
function sendKeys(session, text, options = {}) {
  if (!hasSession(session)) {
    throw new Error(`tmux session "${session}" does not exist`);
  }

  const enter = options.enter !== false;
  const enterDelay = options.enterDelay || 500;

  // Use tmux load-buffer + paste-buffer for reliable delivery of large text.
  // This properly triggers bracketed paste mode in the target terminal.
  const tmpFile = path.join(os.tmpdir(), `tangleclaw-paste-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpFile, text);
    _exec(`tmux load-buffer ${_escapeArg(tmpFile)}`);
    _exec(`tmux paste-buffer -t ${_escapeArg(session)}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_e) { /* ignore cleanup errors */ }
  }

  if (enter) {
    // Delay to let the terminal process the pasted content before sending Enter
    execSync(`sleep ${enterDelay / 1000}`);
    _exec(`tmux send-keys -t ${_escapeArg(session)} Enter`);
  }

  log.debug('Sent keys to session', { session, length: text.length });
}

/**
 * Send a raw tmux key name (e.g. Enter, Down, Up, Escape).
 * Unlike sendKeys which sends text, this sends tmux key literals directly.
 * @param {string} session - Session name
 * @param {string} key - tmux key name (e.g. 'Enter', 'Down', 'Up')
 */
function sendRawKey(session, key) {
  if (!hasSession(session)) {
    throw new Error(`tmux session "${session}" does not exist`);
  }
  _exec(`tmux send-keys -t ${_escapeArg(session)} ${_escapeArg(key)}`);
  log.debug('Sent raw key to session', { session, key });
}

/**
 * Capture the current pane output.
 * @param {string} session - Session name
 * @param {object} [options] - Options
 * @param {number} [options.lines] - Number of lines to capture (default 5)
 * @returns {string[]}
 */
function capturePane(session, options = {}) {
  if (!hasSession(session)) {
    throw new Error(`tmux session "${session}" does not exist`);
  }

  const lines = options.lines || 5;
  const start = -lines;

  try {
    const output = _exec(
      `tmux capture-pane -t ${_escapeArg(session)} -p -S ${start}`
    );
    return output.split('\n');
  } catch (err) {
    log.error('Failed to capture pane', { session, error: err.message });
    return [];
  }
}

/**
 * Set tmux mouse mode on or off for a session.
 * @param {string} session - Session name
 * @param {boolean} on - Whether to enable mouse mode
 * @param {object} [options] - Options
 * @param {boolean} [options.hooks] - Set mouse-toggle hooks
 */
function setMouse(session, on, options = {}) {
  if (!hasSession(session)) {
    throw new Error(`tmux session "${session}" does not exist`);
  }

  const value = on ? 'on' : 'off';
  _exec(`tmux set-option -t ${_escapeArg(session)} mouse ${value}`);

  if (options.hooks) {
    if (on) {
      // Set hooks that auto-toggle mouse on window changes
      try {
        _exec(`tmux set-hook -t ${_escapeArg(session)} after-select-window "set mouse on"`);
        _exec(`tmux set-hook -t ${_escapeArg(session)} after-select-pane "set mouse on"`);
      } catch (err) {
        log.warn('Failed to set mouse hooks', { session, error: err.message });
      }
    } else {
      try {
        _exec(`tmux set-hook -u -t ${_escapeArg(session)} after-select-window`);
        _exec(`tmux set-hook -u -t ${_escapeArg(session)} after-select-pane`);
      } catch (err) {
        log.warn('Failed to unset mouse hooks', { session, error: err.message });
      }
    }
  }

  log.debug('Set mouse mode', { session, mouse: on });
}

/**
 * Get the current mouse mode for a session.
 * @param {string} session - Session name
 * @returns {boolean}
 */
function getMouse(session) {
  if (!hasSession(session)) {
    throw new Error(`tmux session "${session}" does not exist`);
  }

  try {
    const output = _exec(`tmux show-options -t ${_escapeArg(session)} -v mouse 2>/dev/null`);
    return output.trim() === 'on';
  } catch {
    return false;
  }
}

/**
 * Check if tmux server is running.
 * @returns {boolean}
 */
function isServerRunning() {
  try {
    _exec('tmux list-sessions 2>/dev/null');
    return true;
  } catch {
    // tmux server not running or no sessions — check if binary exists
    try {
      _exec('which tmux');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Escape a shell argument for safe use in commands.
 * @param {string} arg - Argument to escape
 * @returns {string}
 */
function _escapeArg(arg) {
  // Use single quotes, escaping any embedded single quotes
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  toSessionName,
  isValidSessionName,
  listSessions,
  hasSession,
  createSession,
  killSession,
  sendKeys,
  sendRawKey,
  capturePane,
  setMouse,
  getMouse,
  isServerRunning,
  _exec,
  _escapeArg
};
