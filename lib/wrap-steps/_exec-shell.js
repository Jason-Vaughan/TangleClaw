'use strict';

/**
 * The shell runner shared by the wrap steps that execute a project command.
 *
 * It lived as a byte-identical copy in `test.js` and `lint.js`. Both copies
 * carried the same dead timeout branch (#894) and both had to be fixed
 * separately, which is the argument for one copy — a defect in a duplicated
 * function is a defect per duplicate, and the one that gets missed is the one
 * nobody was looking at.
 *
 * Conventional shell exit code for a command killed by a timeout, so the caller
 * can tell it apart from any code the command itself could have produced.
 */
const TIMEOUT_EXIT_CODE = 124;

const { exec } = require('node:child_process');
const { wasTimedOut } = require('../exec-timeout');

/**
 * Run a shell command and resolve to a structured result.
 *
 * Never throws, and never rejects: a non-zero exit is an ordinary outcome here
 * (it is the whole point of a test or lint step), so the exit code is data
 * rather than an error.
 *
 * @param {string} command - Shell command string (e.g. `"npm test"`).
 * @param {object} options - Run options.
 * @param {string} options.cwd - Working directory.
 * @param {number} options.timeoutMs - Wall clock before the command is killed.
 * @param {number} options.maxBufferBytes - Output cap before the child is killed.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string,
 *   error: string|null, timedOut: boolean}>} `timedOut` distinguishes a command
 *   that was KILLED from one that ran and failed — callers branch on it to pick
 *   what they tell the operator, so it is part of the contract, not a hint.
 *   Anything constructing this shape by hand (a test double, say) must set it.
 */
function execShell(command, options) {
  return new Promise((resolve) => {
    exec(command, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
      env: process.env
    }, (err, stdout, stderr) => {
      // `wasTimedOut`, not `err.code === undefined && err.killed`: async `exec`
      // DOES set `killed`, but its `code` is `null` rather than `undefined`, so
      // that branch died on its first clause and a killed command fell through
      // as an ordinary non-zero exit — reported to the operator as a failure
      // that never happened (#894).
      if (wasTimedOut(err)) {
        resolve({
          exitCode: TIMEOUT_EXIT_CODE,
          stdout: stdout || '',
          stderr: stderr || '',
          error: `timed out after ${options.timeoutMs}ms`,
          timedOut: true
        });
        return;
      }
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({
        exitCode,
        stdout: stdout || '',
        stderr: stderr || '',
        // A NUMERIC code means the command ran and exited, and that code IS the
        // answer. Anything else is the run itself failing, and the old
        // `=== undefined` test caught none of them — most reachably an output
        // overflow (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), which arrived as a
        // bare exit 1 with no explanation for a suite that simply printed too
        // much. (A command that does not EXIST is not one of these: `exec` runs
        // through a shell, so that is the shell exiting 127 — numeric, and
        // already reported correctly.)
        error: err && typeof err.code !== 'number' ? err.message : null,
        timedOut: false
      });
    });
  });
}

module.exports = { execShell, TIMEOUT_EXIT_CODE };
