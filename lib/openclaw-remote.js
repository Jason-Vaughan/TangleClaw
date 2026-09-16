'use strict';

// Non-blocking child-process runners for the OpenClaw routes that reach a remote
// host. Every such call can wait out a full SSH connect timeout when the host
// does not answer, and a synchronous call holds the server's single event loop
// for all of it: WebSockets drop and the dashboard reloads. These runners keep
// the wait off the loop, and `_internal` is the one seam the tests stub.

const { exec, execFile } = require('node:child_process');

/**
 * Settle a child-process callback into a promise, attaching the captured
 * streams to the rejection so callers can report the remote side's own words.
 * @param {Function} resolve
 * @param {Function} reject
 * @returns {(err: Error|null, stdout: string, stderr: string) => void}
 */
function _settle(resolve, reject) {
  return (err, stdout, stderr) => {
    if (err) {
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
      return;
    }
    resolve({ stdout, stderr });
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
 *   `stdout`, `stderr`, `code` and `killed`.
 */
function _runShell(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { timeout: opts.timeout, encoding: 'utf8' }, _settle(resolve, reject));
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
 *   `stdout`, `stderr`, `code` and `killed`.
 */
function _runFile(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: opts.timeout, encoding: 'utf8' }, _settle(resolve, reject));
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
