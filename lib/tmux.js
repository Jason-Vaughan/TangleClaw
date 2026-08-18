'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, execFile } = require('node:child_process');
const { createLogger } = require('./logger');
const { wasTimedOut } = require('./exec-timeout');
const { createConditionLog } = require('./condition-log');
const serverInfo = require('./server-info');

const log = createLogger('tmux');

// The listing runs once per `GET /api/projects`, which the dashboard polls every
// ten seconds for as long as a tab is open. A wedge does not un-wedge between
// polls, so reporting it on every failure means an error line every ten seconds,
// forever — and the wedge is exactly when an operator reads the log.
const conditionLog = createConditionLog(log);

// One tmux SERVER, so one key: the condition is "the server did not answer",
// not "this caller did not get an answer". Keying per call would restore the
// flood through the back door, since each poll is a new call.
const TMUX_UNREACHABLE = 'tmux-list-sessions-unreachable';

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
    // `wasTimedOut`, not `err.killed`: `execSync` never sets that flag on the
    // error it throws, so this branch existed and had never once run — a wedged
    // tmux server produced no timeout log at all (#894).
    if (wasTimedOut(err)) {
      log.error('tmux command timed out', { command, timeout });
      // Flagged, because this throw REPLACES the error `wasTimedOut` can read:
      // a caller that needs to tell "tmux said no" from "tmux said nothing"
      // cannot re-derive it from a message string. `tcTimedOut` is the name the
      // scanner already uses for the same distinction (`lib/dir-scanner.js`).
      throw Object.assign(new Error(`tmux command timed out after ${timeout}ms`),
        { tcTimedOut: true });
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
 * Read every live session name in ONE invocation, asynchronously.
 *
 * `-F '#{session_name}'` alone, rather than the `|`-joined format `listSessions`
 * uses: one field has no delimiter to mis-split, so a session someone else
 * created whose name contains a `|` cannot be truncated into a name that
 * collides with one of ours. Run through `execFile` with an argv rather than a
 * shell string for the same reason — nothing here is re-parsed.
 *
 * NEVER REJECTS, and it never reports an absence it did not observe. Three
 * outcomes reach the caller, not two: tmux listed the live names, tmux told us
 * there is nothing live, or tmux did not answer at all. The third used to be
 * folded into the second — an unknown wearing a fact's clothes, which made a
 * wedged server report every running session as dead across the whole fleet
 * view (#94/#144/#380 record this install reaching exactly that state).
 *
 * ONLY A STOP WE CAUSED IS AN UNKNOWN. A tmux that replied — including the
 * exit-1 `no server running` that is the ordinary state of a machine with no
 * sessions, and a missing `tmux` binary — told us something, and that something
 * is "nothing is live". Calling every failure unknown would invert the bug
 * rather than fix it: after a reboot, every stale `active` row would sit at
 * unknown forever on every machine where tmux is simply not running. `git`
 * draws the same line with `weStopped` (`lib/git.js`).
 *
 * @param {Function} execFn - `execFile`-shaped runner.
 * @param {number} timeout - Milliseconds before the invocation is killed.
 * @returns {Promise<{names: Set<string>, answered: boolean, cause: string|null}>}
 *   `answered: false` means the set says nothing about what is live.
 */
function _readSessionNames(execFn, timeout) {
  return new Promise((resolve) => {
    execFn('tmux', ['list-sessions', '-F', '#{session_name}'],
      { timeout, encoding: 'utf8' }, (err, stdout) => {
        if (err) {
          // A timeout is worth saying out loud; "no server running" is the
          // ordinary state of a machine with no sessions and would be noise.
          if (wasTimedOut(err)) {
            conditionLog.report(TMUX_UNREACHABLE, 'error',
              'tmux session listing timed out — no session\'s liveness can be '
              + 'established from this read', { timeout });
            resolve({ names: new Set(), answered: false, cause: 'read-timed-out' });
            return;
          }
          // tmux ANSWERED — including the exit-1 "no server running" that is the
          // ordinary state of a machine with no sessions. Whatever it says, a
          // server that replies is not a wedged one, so the next wedge is a new
          // incident and has to be loud again.
          conditionLog.resolved(TMUX_UNREACHABLE);
          resolve({ names: new Set(), answered: true, cause: null });
          return;
        }
        conditionLog.resolved(TMUX_UNREACHABLE);
        const names = new Set();
        for (const line of String(stdout || '').split('\n')) {
          const name = line.trim();
          if (name) names.add(name);
        }
        resolve({ names, answered: true, cause: null });
      });
  });
}

/**
 * A single-flight, lazily-loaded snapshot of the live session names.
 *
 * Exists because liveness used to be asked one project at a time: enriching a
 * fleet ran `tmux has-session` once per project, on the event loop, each with
 * its own 5s cap — so the honest worst case scaled with the project count while
 * the answer for all of them fits in one invocation.
 *
 * Lazy AND memoised, both load-bearing. Lazy: a fleet whose projects have no
 * sessions at all must still cost nothing, so nothing is spawned until someone
 * asks. Memoised on the PROMISE rather than the result: the callers run
 * concurrently under `Promise.all`, so caching only the settled value would let
 * every one of them miss and spawn before the first reply landed — N spawns
 * again, from a cache that looks like it works.
 *
 * Deliberately one-shot, with no expiry. A snapshot is meant to answer one
 * list, and its holder throws it away; a long-lived cache here would hand
 * stale liveness to callers that kill and type into sessions.
 *
 * `get()` resolves the whole VERDICT — `{ names, answered, cause }` — not a bare
 * set, so a caller cannot read "this name is not in the set" without also being
 * told whether tmux answered at all. That is the shape, rather than a set plus
 * a second accessor, because the failure being prevented is precisely reading
 * one without the other.
 *
 * @param {object} [options] - Options.
 * @param {Function} [options.execFn] - Injected `execFile` (tests).
 * @param {number} [options.timeout] - Milliseconds before the invocation is killed.
 * @returns {{ get: () => Promise<{names: Set<string>, answered: boolean, cause: string|null}> }}
 */
function createSessionNameSnapshot(options = {}) {
  const execFn = options.execFn || execFile;
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  let pending = null;
  return {
    get() {
      if (!pending) pending = _readSessionNames(execFn, timeout);
      return pending;
    }
  };
}

/**
 * Check if a tmux session exists.
 *
 * Matches the name EXACTLY: a live `Foo-Bar` does not make `hasSession('Foo')`
 * true. Callers rely on this to decide whether to kill, adopt, or type into a
 * session, so a near-miss must read as absent (see `_target`).
 *
 * Deliberately uncached and synchronous. Its callers kill, adopt and type into
 * the session they are asking about, so an answer that was true a moment ago is
 * not good enough — `createSessionNameSnapshot` is for the read-only fleet view,
 * this is for acting on one session.
 *
 * FALSE MEANS "not confirmed live", which is the right answer for a caller about
 * to act on a pane and the wrong one for a caller about to RECORD that the pane
 * is gone — a tmux that did not answer would have a live session written off as
 * crashed. Anything that persists or refuses on the strength of the answer must
 * use `probeSession` and check `answered` first.
 *
 * @param {string} name - Session name
 * @param {object} [options] - Passed through to the exec (`timeout`).
 * @returns {boolean}
 */
function hasSession(name, options) {
  return probeSession(name, options).live;
}

/**
 * Ask whether one session is live, and whether tmux answered at all.
 *
 * The same question `hasSession` asks, with the third outcome kept instead of
 * flattened: a wedged tmux server (#94/#144/#380) makes every probe fail, and a
 * caller that treats that failure as "the pane is gone" writes a fact nobody
 * established. `createSessionNameSnapshot` draws the same distinction for the
 * whole fleet at once; this is the single-session form, for callers that need
 * an answer about a specific pane right now.
 *
 * `answered: true` with `live: false` is a real negative — tmux ran and said the
 * session is not there. Only a read our own timeout stopped is unknown; the
 * asymmetry, and why widening it would invert the bug, is argued at
 * `_readSessionNames`.
 *
 * @param {string} name - Session name
 * @param {object} [options] - Passed through to the exec.
 * @param {number} [options.timeout] - Milliseconds before the probe is killed.
 *   The same injection seam `createSessionNameSnapshot` takes, and for the same
 *   reason: the unanswered branch can only be driven by a probe that really is
 *   killed, and a test cannot wait out the default cap to see it.
 * @returns {{live: boolean, answered: boolean, cause: string|null}}
 */
function probeSession(name, options = {}) {
  try {
    _exec(`tmux has-session -t ${_target(name)} 2>/dev/null`, options);
    return { live: true, answered: true, cause: null };
  } catch (err) {
    if (err && err.tcTimedOut) return { live: false, answered: false, cause: 'read-timed-out' };
    return { live: false, answered: true, cause: null };
  }
}

/**
 * When a session was created, as a Unix timestamp in seconds.
 *
 * Exists so a caller can tell whether a LIVE session predates a file it was
 * supposed to read at launch — the Project Master loads its `CLAUDE.md` into
 * context once, at start, and never re-reads it, so an identity written after
 * the session began has reached nobody (#968).
 *
 * Three-state, exactly like {@link probeSession} and for the same reason: a
 * wedged tmux server (#94/#144/#380) makes every read fail, and a caller that
 * flattens that into "not stale" writes a fact nobody established. `answered:
 * true` with `createdAt: null` is a real negative — tmux ran and there is no
 * such session.
 *
 * @param {string} name - Session name
 * @param {object} [options] - Passed through to the exec.
 * @param {number} [options.timeout] - Milliseconds before the read is killed.
 * @returns {{createdAt: number|null, answered: boolean, cause: string|null}}
 */
function sessionCreatedAt(name, options = {}) {
  // Existence checked FIRST, and not as belt-and-braces: `display-message` is the
  // one target-taking command that does not fail on an absent session — it
  // silently answers for the attached client instead, so `_target`'s exact-match
  // wrapper cannot protect it the way it protects the others. Without this, a
  // machine with no Master session gets some OTHER session's start time back, and
  // the "no such session" branch below is unreachable in production.
  // `isAlternateScreen` guards the same way for the same reason.
  //
  // Through `probeSession` rather than `hasSession`, because this function's
  // whole contract is three-state: a probe that could not run must stay unknown
  // rather than collapsing into "no session".
  const probe = probeSession(name, options);
  if (!probe.answered) return { createdAt: null, answered: false, cause: probe.cause };
  if (!probe.live) return { createdAt: null, answered: true, cause: null };

  try {
    const raw = _exec(`tmux display-message -p -t ${_target(name)} '#{session_created}' 2>/dev/null`, options);
    const seconds = Number(String(raw).trim());
    // A tmux that answers with something unparseable is NOT the same as one that
    // did not answer, but it is equally unusable — so it reports answered with
    // no timestamp, and the caller's unknown branch handles both.
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { createdAt: null, answered: true, cause: 'unparseable' };
    }
    return { createdAt: seconds, answered: true, cause: null };
  } catch (err) {
    if (err && err.tcTimedOut) return { createdAt: null, answered: false, cause: 'read-timed-out' };
    return { createdAt: null, answered: true, cause: null };
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
      const current = exec(`tmux show-option -t ${_target(session.name)} status-left 2>/dev/null`);
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
      exec(`tmux set-option -t ${_target(session.name)} status-left ${_escapeArg(desired)}`);
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
    _exec(`tmux set-option -t ${_target(name)} history-limit 50000`);
  } catch (err) {
    log.warn('Failed to set history-limit', { name, error: err.message });
  }

  // Configure status bar — show "TangleClaw v<version>" on left, time/date on right
  try {
    _exec(`tmux set-option -t ${_target(name)} status-left ${_escapeArg(buildStatusLeft(serverInfo.getRunningVersion()))}`);
    _exec(`tmux set-option -t ${_target(name)} status-right ${_escapeArg('#[fg=#777777] %H:%M  %Y-%m-%d ')}`);
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

  _exec(`tmux kill-session -t ${_target(name)}`);
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
    _exec(`tmux paste-buffer -p -t ${_target(session)}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_e) { /* ignore cleanup errors */ }
  }

  if (enter) {
    // Delay to let the terminal process the pasted content before sending Enter
    execSync(`sleep ${enterDelay / 1000}`);
    _exec(`tmux send-keys -t ${_target(session)} Enter`);
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
  _exec(`tmux send-keys -t ${_target(session)} ${_escapeArg(key)}`);
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
  // display-message is the one target-taking command that does NOT fail on an
  // absent session — it silently answers for the attached client instead, so an
  // exact-match target cannot protect it the way it protects the others. Check
  // existence explicitly, or a missing session reads as "whatever pane the
  // operator happens to be looking at".
  if (!hasSession(session)) {
    return false;
  }

  try {
    const result = _exec(
      `tmux display-message -t ${_target(session)} -p '#{alternate_on}'`
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
        `tmux capture-pane -t ${_target(session)} -p`
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
      `tmux capture-pane -t ${_target(session)} -p ${rangeFlag}`
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
  _exec(`tmux set-option -t ${_target(session)} mouse ${value}`);

  if (options.hooks) {
    if (on) {
      // Set hooks that auto-toggle mouse on window changes
      try {
        _exec(`tmux set-hook -t ${_target(session)} after-select-window "set mouse on"`);
        _exec(`tmux set-hook -t ${_target(session)} after-select-pane "set mouse on"`);
      } catch (err) {
        log.warn('Failed to set mouse hooks', { session, error: err.message });
      }
    } else {
      try {
        _exec(`tmux set-hook -u -t ${_target(session)} after-select-window`);
        _exec(`tmux set-hook -u -t ${_target(session)} after-select-pane`);
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
    const sessionVal = _exec(`tmux show-options -t ${_target(session)} -v mouse 2>/dev/null`).trim();
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
  _exec(`tmux set-option -u -t ${_target(session)} mouse`);
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

/**
 * Build a `-t` target argument that matches a session name EXACTLY.
 *
 * tmux resolves a target name by trying, in order: the exact session name, then
 * a unique PREFIX of one, then an fnmatch pattern. That fallback is a
 * convenience for humans typing at a prompt, and it is destructive from code:
 * with no session named `TangleClaw`, `kill-session -t TangleClaw` silently
 * resolves to `TangleClaw-Roadmap` and kills a different project's session —
 * which is how one project's relaunch killed another's live session. The same
 * fallback was verified on `send-keys` and `set-option`, so it could also type
 * into, and reconfigure, a neighbour.
 *
 * The `=` prefix demands an exact match. The trailing colon is not cosmetic:
 * `=name` is honoured only by commands taking a *target-session*
 * (`has-session`, `kill-session`). Commands taking a target-pane or an option
 * scope — `send-keys`, `capture-pane`, `paste-buffer`, `set-option`,
 * `show-option(s)`, `set-hook` — reject a bare `=name` outright ("can't find
 * pane"), and accept `=name:` , which resolves the session exactly and then
 * takes its current window/pane. Verified against tmux 3.6a, including that
 * `set-option -t '=name:'` still writes the SESSION option, not a window one.
 *
 * Every `-t` in this module must go through here. The one command this cannot
 * protect is `display-message`, which falls back to the attached client instead
 * of erroring on an absent session — its caller guards existence separately.
 *
 * @param {string} name - Session name
 * @returns {string} Shell-escaped exact-match target (e.g. `'=TangleClaw:'`)
 */
function _target(name) {
  return _escapeArg(`=${String(name)}:`);
}

module.exports = {
  toSessionName,
  isValidSessionName,
  listSessions,
  createSessionNameSnapshot,
  hasSession,
  probeSession,
  sessionCreatedAt,
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
  _escapeArg,
  // Test seam. The cadence state is process-lifetime by design, so a guard for
  // "the second wedge is loud again" needs a way to start from a known point
  // rather than inferring it from whatever earlier tests happened to log.
  _conditionLog: conditionLog,
  _TMUX_UNREACHABLE: TMUX_UNREACHABLE
};
