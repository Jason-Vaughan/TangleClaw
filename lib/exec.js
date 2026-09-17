'use strict';

/**
 * The child-process runners shared by every module that runs a command and
 * wants a structured answer rather than a throw: the wrap steps, and the git/gh
 * readers outside them (#1561).
 *
 * Every child gets `NO_PROMPT_ENV`. The server has no terminal, so a `git` or
 * `gh` that reaches a credential prompt can never be answered; without these it
 * waits out its whole timeout instead of failing at once.
 *
 * The shell form lived as a byte-identical copy in `test.js` and `lint.js`. Both
 * copies carried the same dead timeout branch (#894) and both had to be fixed
 * separately, which is the argument for one copy — a defect in a duplicated
 * function is a defect per duplicate, and the one that gets missed is the one
 * nobody was looking at. Five more copies then turned up in `commit.js`,
 * `pr-merge.js`, `pr-check.js` and `continuity-write.js`, each with the same
 * missing distinction, which is why both forms now live here.
 *
 * Conventional shell exit code for a command killed by a timeout, so the caller
 * can tell it apart from any code the command itself could have produced.
 */
const TIMEOUT_EXIT_CODE = 124;

/**
 * The environment that makes git and gh fail instead of prompting.
 * @type {Readonly<{GIT_TERMINAL_PROMPT: string, GH_PROMPT_DISABLED: string}>}
 */
const NO_PROMPT_ENV = Object.freeze({ GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });

const { exec, execFile } = require('node:child_process');
const { wasTimedOut } = require('./exec-timeout');
const { redactRemoteOutput, REDACTED_PREFIX } = require('./remote-output');

/**
 * Turn one `child_process` callback into the structured result both runners
 * resolve to. Shared so the killed-vs-failed distinction is decided in exactly
 * one place: the whole of #894 and #897 is that distinction having been made
 * independently — and wrongly — at each site.
 *
 * @param {Error|null} err - Callback error.
 * @param {string|Buffer} stdout
 * @param {string|Buffer} stderr
 * @param {number} timeoutMs - The wall clock that was set, for the message.
 * @returns {{exitCode:number, stdout:string, stderr:string, error:string|null,
 *   errorCode:string|null, signal:string|null, timedOut:boolean}}
 */
function _toResult(err, stdout, stderr, timeoutMs) {
  const out = (stdout || '').toString();
  const errOut = (stderr || '').toString();
  // `wasTimedOut`, not `err.code === undefined && err.killed`: async `exec` and
  // `execFile` DO set `killed`, but their `code` is `null` rather than
  // `undefined`, so that branch died on its first clause and a killed command
  // fell through as an ordinary non-zero exit — reported to the operator as a
  // failure that never happened (#894).
  if (wasTimedOut(err)) {
    return {
      exitCode: TIMEOUT_EXIT_CODE,
      stdout: out,
      stderr: errOut,
      error: `timed out after ${timeoutMs}ms`,
      errorCode: null,
      signal: null,
      timedOut: true
    };
  }
  return {
    exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
    stdout: out,
    stderr: errOut,
    // A NUMERIC code means the command ran and exited, and that code IS the
    // answer. Anything else is the run itself failing, and the old
    // `=== undefined` test caught none of them — most reachably an output
    // overflow (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), which arrived as a bare
    // exit 1 with no explanation for a suite that simply printed too much.
    // A MISSING executable differs by form: through a shell it is the shell
    // exiting 127 (numeric, already reported correctly), while argv-style it is
    // `ENOENT` — non-numeric, so it lands here and is named rather than
    // flattened into "exit 1".
    error: err && typeof err.code !== 'number' ? err.message : null,
    // The same non-numeric code, kept as a value callers can branch on without
    // parsing `error`. `ENOENT` is a missing executable OR a missing working
    // directory: Node reports both the same way, so a caller that must tell
    // them apart asks again without the directory (`lib/stranded-check.js`).
    errorCode: err && typeof err.code === 'string' ? err.code : null,
    // A signal that was not our timeout (a crash, or a kill from outside). The
    // child produced no exit code, so its output is not an answer either.
    signal: err && err.signal ? err.signal : null,
    timedOut: false
  };
}

/**
 * The environment a child runs with: the caller's (or this process's), with
 * prompts disabled on top. A copy, so the caller's object is never changed.
 * @param {object|undefined} env
 * @returns {object}
 */
function _childEnv(env) {
  return { ...(env || process.env), ...NO_PROMPT_ENV };
}

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
 * @param {object} [options.env] - Child environment; defaults to this process's.
 *   `NO_PROMPT_ENV` is always applied on top.
 *   A caller that must pin a variable the child reads (the preflight step sets
 *   `CLAUDE_PROJECT_DIR` so prawduct resolves the project it is asked about,
 *   not whichever one this process was launched from) passes a copy with it set.
 * @param {boolean} [options.closeStdin] - End the child's stdin at once. The
 *   child's stdin is a pipe that nothing writes to and — measured — nothing
 *   closes either, so a child that reads stdin to EOF (prawduct's Stop hook
 *   reads its harness payload that way) hangs to the timeout and is reported
 *   as killed. Off by default: no existing caller's child reads stdin, and a
 *   flag keeps the change visible at the one site that needs it.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string,
 *   error: string|null, errorCode: string|null, signal: string|null, timedOut: boolean}>} `timedOut` distinguishes a command
 *   that was KILLED from one that ran and failed — callers branch on it to pick
 *   what they tell the operator, so it is part of the contract, not a hint.
 *   Anything constructing this shape by hand (a test double, say) must set it.
 */
function execShell(command, options) {
  return new Promise((resolve) => {
    const child = exec(command, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
      env: _childEnv(options.env)
    }, (err, stdout, stderr) => {
      resolve(_toResult(err, stdout, stderr, options.timeoutMs));
    });
    if (options.closeStdin === true && child.stdin) {
      // A spawn that fails asynchronously (a missing interpreter behind a
      // `#!` line — which an X_OK check on the script cannot see) emits
      // `'error'` on this stream. With no listener that is an unhandled
      // stream error taking down the process, instead of the resolved
      // failure result every caller here is written to receive. The exec
      // callback still reports the failure; this only stops the stream
      // half of it escaping.
      child.stdin.on('error', () => {});
      child.stdin.end();
    }
  });
}

/**
 * Run a command argv-style — no shell — and resolve to the same structured
 * result as {@link execShell}.
 *
 * This is a separate entry point rather than a flag because the absence of a
 * shell is the reason callers pick it: `commit.js` passes a multi-line commit
 * message to `git commit -m`, where every quote, newline and backtick must reach
 * the child's `argv[]` byte-intact. Routing that through a shell to save one
 * function would reintroduce the quoting bug the argv form exists to avoid.
 *
 * @param {string} file - Executable name (e.g. `'git'`).
 * @param {string[]} args - Arguments, each passed as its own `argv[]` entry.
 * @param {object} options - Run options.
 * @param {string} options.cwd - Working directory.
 * @param {number} options.timeoutMs - Wall clock before the command is killed.
 * @param {number} options.maxBufferBytes - Output cap before the child is killed.
 * @param {object} [options.env] - Child environment; see {@link execShell}.
 * @param {boolean} [options.closeStdin] - End the child's stdin at once; see
 *   {@link execShell}.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string,
 *   error: string|null, errorCode: string|null, signal: string|null, timedOut: boolean}>} Same contract as {@link execShell},
 *   `timedOut` included — a hand-built double must set it.
 */
function execFileArgs(file, args, options) {
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
      env: _childEnv(options.env)
    }, (err, stdout, stderr) => {
      resolve(_toResult(err, stdout, stderr, options.timeoutMs));
    });
    if (options.closeStdin === true && child.stdin) {
      // A spawn that fails asynchronously (a missing interpreter behind a
      // `#!` line — which an X_OK check on the script cannot see) emits
      // `'error'` on this stream. With no listener that is an unhandled
      // stream error taking down the process, instead of the resolved
      // failure result every caller here is written to receive. The exec
      // callback still reports the failure; this only stops the stream
      // half of it escaping.
      child.stdin.on('error', () => {});
      child.stdin.end();
    }
  });
}

/**
 * Whether a result is a run that never produced an answer: killed by our
 * timeout or a signal, or never started. A non-zero exit is NOT one of these —
 * that is the command answering.
 * @param {{timedOut: boolean, errorCode: (string|null), signal: (string|null)}} r
 * @returns {boolean}
 */
function didNotRun(r) {
  return !!(r && (r.timedOut || r.errorCode || r.signal));
}

/**
 * One line saying why a command did not succeed, redacted, for a reason an
 * operator reads. Shared so every caller names a missing program, a timeout and
 * a kill the same way.
 *
 * `ENOENT` is named as a missing program. A caller whose working directory may
 * be the missing thing asks first (`lib/stranded-check.js#spawnFailure`).
 *
 * @param {{exitCode: number, stdout: string, stderr: string, error: (string|null),
 *   errorCode: (string|null), signal: (string|null), timedOut: boolean}} r - A result from this module
 * @param {string} what - The command as the operator would name it, e.g. `gh pr list`
 * @returns {string}
 */
function describeFailure(r, what) {
  const bin = what.split(' ')[0];
  if (r.errorCode === 'ENOENT') return `${bin} is not installed`;
  if (r.timedOut) return `${what} ${r.error || 'timed out'}`;
  if (r.signal) return `${what} was stopped by ${r.signal}`;
  if (r.errorCode) return `${what} could not run (${r.errorCode})`;
  const line = `${r.stderr || ''}\n${r.stdout || ''}`.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  // These commands reach remotes, so their output can echo a tokenised URL.
  const safe = redactRemoteOutput(line);
  // A wholesale replacement drops the command's own words; the exit code is not
  // a credential, so it is named beside it.
  if (safe && safe.startsWith(REDACTED_PREFIX)) return `${what} failed (exit ${r.exitCode}): ${safe}`;
  return safe ? `${what} failed: ${safe}` : `${what} failed (exit ${r.exitCode})`;
}

module.exports = { execShell, execFileArgs, didNotRun, describeFailure, NO_PROMPT_ENV, TIMEOUT_EXIT_CODE };
