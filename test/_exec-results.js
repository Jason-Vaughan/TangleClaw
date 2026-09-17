'use strict';

/*
 * Test doubles for `lib/exec.js` results that are awkward to produce for real
 * in a unit test: a binary that will not start, and a command our timeout
 * killed. `test/exec.test.js` checks each one against a real spawn, so a double
 * cannot drift from what the runner actually returns.
 */

const { TIMEOUT_EXIT_CODE } = require('../lib/exec');

/**
 * What the runner returns when the executable (or the working directory) is missing.
 * @param {string} bin - The executable that was spawned
 * @returns {{exitCode: number, stdout: string, stderr: string, error: string, errorCode: string, timedOut: boolean}}
 */
function notFound(bin) {
  return { exitCode: 1, stdout: '', stderr: '', error: `spawn ${bin} ENOENT`, errorCode: 'ENOENT', signal: null, timedOut: false };
}

/**
 * What the runner returns for another spawn failure, such as EACCES.
 * @param {string} bin
 * @param {string} code - e.g. `EACCES`
 * @returns {object}
 */
function spawnFailed(bin, code) {
  return { exitCode: 1, stdout: '', stderr: '', error: `spawn ${bin} ${code}`, errorCode: code, signal: null, timedOut: false };
}

/**
 * What the runner returns when its timeout killed the command.
 * @param {number} [ms] - The timeout that applied
 * @returns {object}
 */
function stopped(ms = 15000) {
  return { exitCode: TIMEOUT_EXIT_CODE, stdout: '', stderr: '', error: `timed out after ${ms}ms`, errorCode: null, signal: null, timedOut: true };
}

/**
 * What the runner returns for a command that ran and exited non-zero.
 * @param {string} [stderr]
 * @param {number} [exitCode]
 * @returns {object}
 */
function exited(stderr = '', exitCode = 1) {
  return { exitCode, stdout: '', stderr, error: null, errorCode: null, signal: null, timedOut: false };
}

/**
 * What the runner returns for a child stopped by a signal that was not our
 * timeout (a crash, or a kill from outside).
 * @param {string} command - The command line, as Node words its error message
 * @param {string} [signal]
 * @returns {object}
 */
function killedBy(command, signal = 'SIGABRT') {
  return { exitCode: 1, stdout: '', stderr: '', error: `Command failed: ${command}`, errorCode: null, signal, timedOut: false };
}

module.exports = { notFound, spawnFailed, stopped, exited, killedBy };
