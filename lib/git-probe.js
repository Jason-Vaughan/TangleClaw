'use strict';

/**
 * One way to run git for the server's read-only checkout probes.
 *
 * `lib/checkout-state.js` and `lib/upstream-observer.js` run every git call
 * through {@link runGit}, and need the same four guarantees; kept here so a
 * fix to one reaches both. `lib/behind-origin.js` shares the spawn guard, the
 * network environment ({@link callEnv}) and the no-git classification, but
 * keeps its own callback runner, whose options its tests pin:
 *
 * - **Never on the event loop.** `execFile`, argv form, no shell, with a
 *   timeout — a hung git or a hung remote cannot stall request handling.
 * - **Never a prompt.** The server has no terminal, so a credential prompt
 *   could only wait out its timeout. Network calls also run ssh in batch mode.
 * - **Never a lock.** Local calls run with `--no-optional-locks`, so a poll
 *   never takes the index lock from a session committing in the same clone.
 * - **Never a real spawn under the test runner** unless a test passes its own
 *   `execFile`: an unstubbed route test would otherwise run git — or a
 *   network fetch — against the developer's checkout.
 *
 * Every call resolves, never rejects, to `{ok, stdout, err}`; the caller turns
 * a failure into its own `unknown` with {@link failureReason}. `lib/git.js` is a
 * different thing: the synchronous helper the directory-scanner child runs.
 *
 * @module lib/git-probe
 */

const childProcess = require('node:child_process');
const { NO_PROMPT_ENV } = require('./exec');
const { redactRemoteOutput } = require('./remote-output');

/** Default bound on a local git call. */
const LOCAL_TIMEOUT_MS = 5000;

/** Default bound on a git call that reaches a remote. */
const NETWORK_TIMEOUT_MS = 20000;

/** Largest stdout accepted from one call (a huge untracked tree must not OOM the server). */
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Why the default seam must not spawn, or null when it may. Node's test
 * runner sets `NODE_TEST_CONTEXT` for every file it runs.
 *
 * @returns {string|null}
 */
function spawnBlockedReason() {
  if (process.env.NODE_TEST_CONTEXT) return 'node test runner';
  return null;
}

/**
 * The default `execFile`: the real one, unless spawning is blocked.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {object} options
 * @param {Function} cb
 */
function defaultExecFile(file, args, options, cb) {
  const blocked = spawnBlockedReason();
  if (blocked) return void setImmediate(() => cb(new Error(`git spawn blocked: ${blocked}`)));
  childProcess.execFile(file, args, options, cb);
}

/**
 * The environment for one call. A network call gets the no-prompt variables
 * and batch-mode ssh; every call gets the C locale so parsed output is stable.
 *
 * @param {boolean} network
 * @returns {object}
 */
function callEnv(network) {
  const env = { ...process.env, ...NO_PROMPT_ENV, LC_ALL: 'C' };
  if (network) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  return env;
}

/**
 * Run one git command in `cwd`. Resolves — never rejects — to the outcome.
 *
 * @param {Function} execFile - `child_process.execFile`-compatible.
 * @param {string} cwd
 * @param {string[]} args - Arguments after `git --no-optional-locks`.
 * @param {object} [opts]
 * @param {boolean} [opts.network=false] - The call reaches a remote.
 * @param {number} [opts.timeoutMs] - Defaults by `network`.
 * @returns {Promise<{ok: boolean, stdout: string, err: Error|null}>}
 */
function runGit(execFile, cwd, args, opts = {}) {
  const network = opts.network === true;
  const timeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : (network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
  return new Promise((resolve) => {
    try {
      execFile('git', ['--no-optional-locks', ...args], {
        cwd,
        encoding: 'utf8',
        timeout,
        maxBuffer: MAX_BUFFER,
        env: callEnv(network)
      }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || ''), err: err || null }));
    } catch (err) {
      resolve({ ok: false, stdout: '', err });
    }
  });
}

/**
 * Whether a failure means "no git here by design" — the binary is missing, or
 * the directory is not a repository — rather than a probe that should have
 * worked.
 *
 * @param {Error|null} err
 * @returns {boolean}
 */
function isNoGit(err) {
  if (!err) return false;
  if (err.code === 'ENOENT') return true;
  const text = `${err.message || ''} ${err.stderr || ''}`;
  return /not a git repository/i.test(text);
}

/**
 * Remove the locations git echoes into its errors — a quoted path or URL, a
 * `scheme://` URL, an scp-style remote, an absolute path — so a reason can be
 * shown to a caller who may see the repository's identity but not where it
 * lives. The words around them, which say what went wrong, are kept.
 *
 * @param {string} text
 * @returns {string}
 */
function scrubLocations(text) {
  return String(text || '')
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<remote>')
    .replace(/\S+@[^\s:]+:\S+/g, '<remote>')
    .replace(/(^|[\s(=])\/[^\s:,)]+/g, '$1<path>');
}

/**
 * One-line reason for a failed call: the first non-empty line of stderr (or
 * the message), with credentials redacted and every path or remote location
 * removed ({@link scrubLocations}), since the reason can reach a caller who
 * may not see where the repository lives.
 *
 * @param {string} what - Which fact the call was for.
 * @param {Error|null} err
 * @returns {string}
 */
function failureReason(what, err) {
  if (err && err.killed) return `${what}: git timed out`;
  const raw = String((err && (err.stderr || err.message)) || 'failed');
  const line = raw.split('\n').find((l) => l.trim()) || 'failed';
  return `${what}: ${scrubLocations(redactRemoteOutput(line.trim()) || 'failed').slice(0, 200)}`;
}

module.exports = {
  runGit,
  isNoGit,
  failureReason,
  scrubLocations,
  spawnBlockedReason,
  defaultExecFile,
  callEnv,
  LOCAL_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  MAX_BUFFER
};
