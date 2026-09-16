'use strict';

// Non-blocking child-process runners for the OpenClaw request handlers that reach
// a remote host: instanceDir detection, pairing approval and the connection test.
// (The connection version read keeps its own runner in lib/openclaw-version.js.)
// Each such call can wait out a full SSH connect timeout when the host does not
// answer, and a synchronous call holds the server's single event loop for all of
// it: WebSockets drop and the dashboard reloads. These runners keep the wait off
// the loop, and `_internal` is the one seam the tests stub.

const { exec, execFile } = require('node:child_process');
const { wasTimedOut } = require('./exec-timeout');

/**
 * Settle a child-process callback into a promise, attaching the captured
 * streams to the rejection so callers can report the remote side's own words.
 *
 * The rejection's text is rewritten, because every caller shows
 * `err.stderr || err.message` to the operator. Node's own message is
 * `Command failed: <the whole command line>`: it never says a timeout killed the
 * command, and it echoes whatever the command interpolated. A timeout is
 * therefore named in both fields, and any other failure carries its exit status
 * instead of the command line.
 * @param {Function} resolve
 * @param {Function} reject
 * @param {number|undefined} timeout - The timeout that was set, for the message.
 * @returns {(err: Error|null, stdout: string, stderr: string) => void}
 */
function _settle(resolve, reject, timeout) {
  return (err, stdout, stderr) => {
    if (!err) {
      resolve({ stdout, stderr });
      return;
    }
    const said = (stderr || '').trimEnd();
    if (wasTimedOut(err)) {
      const note = `timed out after ${timeout}ms`;
      err.timedOut = true;
      err.message = note;
      err.stderr = said ? `${said} (${note})` : '';
    } else {
      if (typeof err.code === 'number') err.message = `exited with status ${err.code}`;
      err.stderr = stderr;
    }
    err.stdout = stdout;
    reject(err);
  };
}

/**
 * Write `input` to a child's stdin and close it.
 * @param {import('node:child_process').ChildProcess} child
 * @param {string|undefined} input
 * @returns {void}
 */
function _feed(child, input) {
  // A child that exits before reading stdin raises EPIPE on the stream; the
  // exit callback already reports that outcome, so the stream error is dropped.
  child.stdin.on('error', () => {});
  child.stdin.end(input == null ? '' : input);
}

/**
 * Run a shell command without blocking.
 * @param {string} cmd - Shell command line. Callers validate anything they interpolate.
 * @param {object} [opts]
 * @param {string} [opts.input] - Written to stdin (promisified `exec` has no `input`).
 * @param {number} [opts.timeout] - Kill the command after this many ms.
 * @returns {Promise<{stdout: string, stderr: string}>} Rejects with an error carrying
 *   `stdout`, `stderr`, `code`, and `timedOut` when our timeout killed it.
 */
function _runShell(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { timeout: opts.timeout, encoding: 'utf8' }, _settle(resolve, reject, opts.timeout));
    _feed(child, opts.input);
  });
}

/**
 * Run a program with an argument vector (no shell) without blocking.
 * @param {string} file - Program to run.
 * @param {string[]} args - Arguments, passed verbatim.
 * @param {object} [opts]
 * @param {number} [opts.timeout] - Kill the program after this many ms.
 * @returns {Promise<{stdout: string, stderr: string}>} Rejects with an error carrying
 *   `stdout`, `stderr`, `code`, and `timedOut` when our timeout killed it.
 */
function _runFile(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: opts.timeout, encoding: 'utf8' }, _settle(resolve, reject, opts.timeout));
    _feed(child, undefined);
  });
}

// Overridable for tests.
const _internal = { runShell: _runShell, runFile: _runFile };

/**
 * Run a shell command without blocking (see `_runShell`).
 * @param {string} cmd
 * @param {object} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runShell(cmd, opts) {
  return _internal.runShell(cmd, opts);
}

/**
 * Run a program without a shell and without blocking (see `_runFile`).
 * @param {string} file
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runFile(file, args, opts) {
  return _internal.runFile(file, args, opts);
}

module.exports = { runShell, runFile, _internal, _runShell, _runFile };
