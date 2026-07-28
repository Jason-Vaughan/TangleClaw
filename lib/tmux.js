'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');
const serverInfo = require('./server-info');

const log = createLogger('tmux');

const SESSION_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_TIMEOUT = 5000;

// The word that marks a status bar as one TangleClaw wrote. `refreshStatusBars`
// re-stamps only bars carrying it, so a tmux session started by hand — which
// `listSessions()` returns alongside ours — never gets branded by us.
const STATUS_BRAND = 'TangleClaw';

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
 * Build the tmux `status-left` string for a TangleClaw session.
 *
 * The version is what makes the bar worth reading: a session is often the only
 * surface an operator has open, and until now it could not tell them which
 * TangleClaw they were talking to.
 *
 * A missing version degrades to the bare brand rather than to `v` + nothing or
 * `vnull`. That case is real — `getRunningVersion()` is null until the server
 * captures startup — and a bar that silently lies about the version is worse
 * than one that declines to name it.
 *
 * @param {string|null} [version] - The running version, e.g. `'4.35.0'`.
 * @returns {string} A tmux format string, already colour-prefixed.
 */
function buildStatusLeft(version) {
  const clean = typeof version === 'string' ? version.trim() : '';
  const label = clean ? `${STATUS_BRAND} v${clean}` : STATUS_BRAND;
  return `#[fg=#8BC34A,bold] ${label} `;
}

/**
 * Re-stamp the status bar of every session TangleClaw branded, so sessions that
 * predate an update stop advertising the version they were born under.
 *
 * Called at server startup, which is sufficient rather than merely convenient:
 * the running version can only change by this process restarting, so there is
 * no window in which a bar is stale and no need to poll or to embed a `#()`
 * subshell that would re-run per session on every status interval.
 *
 * Two refusals keep it from doing damage on a machine it does not own:
 * `listSessions()` returns every tmux session on the host, so a bar without the
 * TangleClaw brand is left untouched; and with no known version there is
 * nothing to correct, so it does not run at all — re-stamping then would strip
 * a good version off every bar.
 *
 * Never throws: a status bar is cosmetic, and a tmux quirk on one session must
 * not take down server startup.
 *
 * @param {object} [deps] - Seams for testing; defaults to this module's own.
 * @param {function(): {name: string}[]} [deps.listSessions] - Session lister.
 * @param {function(string): string} [deps.exec] - tmux command runner.
 * @param {function(): (string|null)} [deps.version] - Running-version reader.
 * @returns {{updated: number, skipped: number}} Counts by outcome.
 */
function refreshStatusBars(deps = {}) {
  const list = deps.listSessions || listSessions;
  const exec = deps.exec || _exec;
  const readVersion = deps.version || serverInfo.getRunningVersion;

  const version = readVersion();
  if (!version) {
    log.warn('Skipped status-bar refresh — running version unknown');
    return { updated: 0, skipped: 0 };
  }

  const desired = buildStatusLeft(version);
  let updated = 0;
  let skipped = 0;
  // Reasons, for the log only — `skipped` alone cannot tell a healthy no-op
  // from a guard that stopped recognizing our own bars. The return shape stays
  // two counts; these narrow the log line.
  let foreign = 0;
  let failed = 0;

  for (const session of list()) {
    try {
      const current = exec(`tmux show-option -t ${_escapeArg(session.name)} status-left 2>/dev/null`);
      // Not ours: re-stamping an unbranded bar would put TangleClaw's name on
      // a session someone else started.
      if (!current || !current.includes(STATUS_BRAND)) {
        skipped++;
        foreign++;
        continue;
      }
      // Already correct. Anchored at the end of the version rather than matched
      // as a bare substring: `v4.3` is contained in `v4.35.0`, so a plain
      // `includes` would read a v4.3 bar as current on a v4.35.0 server and
      // never correct it. Anchored on a character class instead of a trailing
      // space, because that space survives `_exec`'s trim only while tmux
      // chooses to quote a value containing one — a formatting detail this
      // should not depend on. The colour prefix is deliberately not compared: a
      // bar is current when it names the right version, whatever it is painted.
      const currentLabel = new RegExp(
        `${STATUS_BRAND} v${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`
      );
      if (currentLabel.test(current)) {
        skipped++;
        continue;
      }
      exec(`tmux set-option -t ${_escapeArg(session.name)} status-left ${_escapeArg(desired)}`);
      updated++;
    } catch (err) {
      // One unhealthy session must not stop the rest from being corrected.
      skipped++;
      failed++;
      log.warn('Failed to refresh status bar', { session: session.name, error: err.message });
    }
  }

  // Both outcomes are logged, and the skip reasons are broken out, because
  // "touched nothing" is also the shape a broken refresh takes — a changed
  // status-left format, or tmux answering in a way the guard no longer
  // recognizes. A bare skip count cannot tell that from a healthy no-op, and
  // on a host with hand-started tmux sessions it would report bars as current
  // that were never ours to begin with.
  const alreadyCurrent = skipped - foreign - failed;
  if (updated > 0 || skipped > 0) {
    log.info('Session status bars reconciled',
      { updated, alreadyCurrent, foreign, failed, version });
  }
  return { updated, skipped };
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

  // Env vars must be set on the new-session invocation via `-e KEY=VALUE`
  // (tmux ≥ 2.8) so they're present in the spawned launch command's
  // process env. Setting them via `tmux set-environment` AFTER the
  // session exists is too late — the initial command (e.g. an engine
  // launcher like `aider`) has already inherited the unsupplemented
  // parent env. `set-environment` only affects subsequently spawned
  // child processes within the session, which doesn't help the launch
  // command itself.
  if (options.env && typeof options.env === 'object') {
    for (const [key, value] of Object.entries(options.env)) {
      cmd += ` -e ${_escapeArg(`${key}=${String(value)}`)}`;
    }
  }

  if (options.command) {
    cmd += ` ${_escapeArg(options.command)}`;
  }

  _exec(cmd);

  // Set scrollback history to 50K lines for full peek capture
  try {
    _exec(`tmux set-option -t ${_escapeArg(name)} history-limit 50000`);
  } catch (err) {
    log.warn('Failed to set history-limit', { name, error: err.message });
  }

  // Configure status bar — show "TangleClaw v<version>" on left, time/date on right
  try {
    _exec(`tmux set-option -t ${_escapeArg(name)} status-left ${_escapeArg(buildStatusLeft(serverInfo.getRunningVersion()))}`);
    _exec(`tmux set-option -t ${_escapeArg(name)} status-right ${_escapeArg('#[fg=#777777] %H:%M  %Y-%m-%d ')}`);
  } catch (err) {
    log.warn('Failed to set status bar options', { name, error: err.message });
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
  // The -p flag inserts bracketed-paste control codes (CSI 200~ / CSI 201~)
  // when the target app advertises bracketed-paste mode. Without -p, tmux
  // replaces every LF with CR (its documented default), which collapses
  // multi-line payloads into a single line inside TUIs like Claude Code (#75).
  const tmpFile = path.join(os.tmpdir(), `tangleclaw-paste-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpFile, text);
    _exec(`tmux load-buffer ${_escapeArg(tmpFile)}`);
    _exec(`tmux paste-buffer -p -t ${_escapeArg(session)}`);
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
 * Check if a tmux pane is in alternate screen mode.
 * TUI applications (Codex, vim, etc.) switch to the alternate screen buffer,
 * which has no scrollback history and requires different capture handling.
 * @param {string} session - Session name
 * @returns {boolean}
 */
function isAlternateScreen(session) {
  try {
    const result = _exec(
      `tmux display-message -t ${_escapeArg(session)} -p '#{alternate_on}'`
    );
    return result.trim() === '1';
  } catch {
    return false;
  }
}

/**
 * Capture the current pane output.
 * For panes in alternate screen mode (TUI engines like Codex), the full
 * scrollback range flags (-S - -E -) may fail or return empty content.
 * In that case, falls back to capturing just the visible pane content.
 * @param {string} session - Session name
 * @param {object} [options] - Options
 * @param {number} [options.lines] - Number of lines to capture (default 5)
 * @param {boolean} [options.full] - Capture full scrollback buffer
 * @returns {{ lines: string[], alternateScreen: boolean }}
 */
function capturePane(session, options = {}) {
  if (!hasSession(session)) {
    throw new Error(`tmux session "${session}" does not exist`);
  }

  const altScreen = isAlternateScreen(session);

  // Alternate screen panes have no scrollback history — skip range flags
  // and capture only the visible content.
  if (altScreen) {
    try {
      const output = _exec(
        `tmux capture-pane -t ${_escapeArg(session)} -p`
      );
      return { lines: output.split('\n'), alternateScreen: true };
    } catch (err) {
      log.error('Failed to capture alternate screen pane', { session, error: err.message });
      return { lines: [], alternateScreen: true };
    }
  }

  let rangeFlag;
  if (options.full) {
    rangeFlag = '-S - -E -';
  } else {
    const lines = options.lines || 5;
    rangeFlag = `-S ${-lines}`;
  }

  try {
    const output = _exec(
      `tmux capture-pane -t ${_escapeArg(session)} -p ${rangeFlag}`
    );
    return { lines: output.split('\n'), alternateScreen: false };
  } catch (err) {
    log.error('Failed to capture pane', { session, error: err.message });
    return { lines: [], alternateScreen: false };
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
 * Resolve the EFFECTIVE tmux mouse value from the session-level and global
 * reads (#574 RC1). tmux's session-level `show-options -v mouse` is EMPTY
 * when the session carries no override, so the session value alone
 * misreports every global-`mouse on` session (deploy/tmux.conf) as off —
 * which poisoned `sessionState.mouseOn` and let select mode strand
 * session-level `mouse off` overrides. Empty session value → fall back to
 * the global.
 * @param {string} sessionVal - Trimmed `show-options -t <s> -v mouse` output
 * @param {string} globalVal - Trimmed `show-options -g -v mouse` output
 * @returns {boolean}
 */
function _resolveMouseValue(sessionVal, globalVal) {
  return _resolveMouseState(sessionVal, globalVal).on;
}

/**
 * Resolve the effective mouse value AND whether it comes from a
 * session-level override (#579). The value alone loses information a
 * correct restore needs: `mouse on` inherited from the global and `mouse on`
 * explicitly set on the session are the same boolean but different
 * configurations — restoring an inherited state by SETTING the value
 * strands a session-level override that pins the session against future
 * global changes (the benign-valued sibling of #574 RC2).
 * @param {string} sessionVal - Trimmed `show-options -t <s> -v mouse` output
 * @param {string} globalVal - Trimmed `show-options -g -v mouse` output
 * @returns {{on: boolean, explicit: boolean}} `explicit` = a session-level
 *   override exists (the session does NOT inherit the global)
 */
function _resolveMouseState(sessionVal, globalVal) {
  const explicit = sessionVal !== '';
  const effective = explicit ? sessionVal : globalVal;
  return { on: effective === 'on', explicit };
}

/**
 * Get the current EFFECTIVE mouse mode for a session: its session-level
 * override when one exists, else the global value it inherits.
 * @param {string} session - Session name
 * @returns {boolean}
 */
function getMouse(session) {
  return getMouseState(session).on;
}

/**
 * Get the effective mouse mode for a session plus its SOURCE (#579):
 * whether the value is a session-level override or inherited from the
 * global. Consumers restoring a prior state need the source — an inherited
 * state is restored by unsetting (see unsetMouse), not by re-setting the
 * value.
 * @param {string} session - Session name
 * @returns {{on: boolean, explicit: boolean}}
 */
function getMouseState(session) {
  if (!hasSession(session)) {
    throw new Error(`tmux session "${session}" does not exist`);
  }

  try {
    const sessionVal = _exec(`tmux show-options -t ${_escapeArg(session)} -v mouse 2>/dev/null`).trim();
    const globalVal = _exec('tmux show-options -g -v mouse 2>/dev/null').trim();
    return _resolveMouseState(sessionVal, globalVal);
  } catch {
    return { on: false, explicit: false };
  }
}

/**
 * Remove a session-level mouse override so the session inherits the global
 * value again (#579). This is the correct "restore" when the pre-change
 * state was inherited — setMouse would write an override that pins the
 * session against future global changes.
 * @param {string} session - Session name
 */
function unsetMouse(session) {
  if (!hasSession(session)) {
    throw new Error(`tmux session "${session}" does not exist`);
  }
  _exec(`tmux set-option -u -t ${_escapeArg(session)} mouse`);
  log.debug('Unset session-level mouse override', { session });
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
  buildStatusLeft,
  refreshStatusBars,
  killSession,
  sendKeys,
  sendRawKey,
  isAlternateScreen,
  capturePane,
  setMouse,
  unsetMouse,
  getMouse,
  getMouseState,
  _resolveMouseValue,
  _resolveMouseState,
  isServerRunning,
  _exec,
  _escapeArg
};
