'use strict';

/*
 * The one-shot private handoff that carries the Project Master's bridge
 * credential from the server to the Master pane (ADR 0023 Decision 14).
 *
 * The credential must reach the Master's process environment without ever
 * being an argument to a command. `tmux new-session -e` and
 * `tmux set-environment` both fail that: the first puts the value in argv,
 * and both leave it in the tmux session environment, where
 * `tmux show-environment` hands it to anything that can reach the socket.
 *
 * So the server makes a FIFO only this user can open, in a directory only this
 * user can enter, and names its path in the pane's launch command. The pane
 * reads one line from it into a variable, and the FIFO is removed. Only the
 * path is ever an argument; the value crosses the pipe once and is never on
 * disk.
 *
 * What this does not do: it does not hide the credential from another process
 * running as the same user, which can read a process's environment, and it
 * does not stop the Master's own shell from printing it. Those are the host's
 * current trust boundary, not something a token can defeat.
 *
 * Nothing here touches the store, so the pane-side reader loads no database.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/** Environment variable the Master pane carries the credential in. */
const CREDENTIAL_ENV = 'TANGLECLAW_BRIDGE_CREDENTIAL';

/** Prefix that marks a value as a Master bridge credential. */
const CREDENTIAL_PREFIX = 'mbk_';

/** How long the server keeps trying to hand the credential over. */
const DELIVER_TIMEOUT_MS = 8000;

/** How long the pane waits for it. Longer than the server tries, so the pane never gives up first. */
const RECEIVE_TIMEOUT_MS = 12000;

/** Pause between attempts on either side. */
const POLL_MS = 40;

/** A credential line is this long at most; anything longer is not ours. */
const MAX_LINE = 256;

/**
 * Mint a credential and the hash the server keeps in its place.
 * @returns {{credential: string, hash: string}}
 */
function mintCredential() {
  const credential = CREDENTIAL_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { credential, hash: hashCredential(credential) };
}

/**
 * The verification material for a credential.
 * @param {string} credential - The credential as presented.
 * @returns {string} SHA-256, hex.
 */
function hashCredential(credential) {
  return crypto.createHash('sha256').update(String(credential), 'utf8').digest('hex');
}

/**
 * Whether a string has the shape of a credential this module minted.
 * @param {*} value - Candidate.
 * @returns {boolean}
 */
function looksLikeCredential(value) {
  return typeof value === 'string' && /^mbk_[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * Remove a FIFO if it is still there. Safe to call any number of times.
 * @param {string} fifoPath - Path to remove.
 * @returns {void}
 */
function removeFifo(fifoPath) {
  try {
    fs.unlinkSync(fifoPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Create the FIFO for one launch. Anything an earlier, interrupted launch left
 * in the directory is removed first, so a crash never accumulates pipes.
 * @param {string} dir - Private handoff directory; created 0700 if absent.
 * @returns {string} The FIFO's path.
 */
function prepareFifo(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  for (const name of fs.readdirSync(dir)) removeFifo(path.join(dir, name));
  const fifoPath = path.join(dir, `handoff-${crypto.randomBytes(12).toString('hex')}`);
  execFileSync('mkfifo', ['-m', '600', fifoPath], { stdio: 'ignore' });
  return fifoPath;
}

/**
 * Quote a string for a POSIX shell.
 * @param {string} value - Raw string.
 * @returns {string}
 */
function _shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a pane's launch command so it first takes the credential from the FIFO
 * into its environment. The reader prints the value to a command substitution,
 * so it is on no terminal and in no argument list.
 * @param {string} launchCmd - The command the pane would otherwise run.
 * @param {string} fifoPath - FIFO created by {@link prepareFifo}.
 * @param {object} [options]
 * @param {string} [options.nodePath] - Node binary to run the reader with.
 * @param {string} [options.receiverPath] - Reader script path.
 * @returns {string}
 */
function wrapLaunchCommand(launchCmd, fifoPath, options = {}) {
  const nodePath = options.nodePath || process.execPath;
  const receiverPath = options.receiverPath || path.join(__dirname, '..', 'bin', 'tc-bridge-receive');
  const read = `${_shellQuote(nodePath)} ${_shellQuote(receiverPath)} ${_shellQuote(fifoPath)}`;
  return `${CREDENTIAL_ENV}="$(${read})"; export ${CREDENTIAL_ENV}; ${launchCmd}`;
}

/** One string as {@link _shellQuote} writes it. */
const QUOTED = "'(?:[^']|'\\\\'')*'";

/** The prefix {@link wrapLaunchCommand} writes, whatever three paths it was given. */
const WRAPPER = new RegExp(`^${CREDENTIAL_ENV}="\\$\\(${QUOTED} ${QUOTED} ${QUOTED}\\)"; export ${CREDENTIAL_ENV}; `);

/**
 * Take the credential handoff back off a pane command: the inverse of
 * {@link wrapLaunchCommand}. A command that does not open with exactly that
 * prefix is returned as it is.
 * @param {string} command - A pane command.
 * @returns {string}
 */
function unwrapLaunchCommand(command) {
  const wrapper = WRAPPER.exec(typeof command === 'string' ? command : '');
  return wrapper ? command.slice(wrapper[0].length) : command;
}

/**
 * Block the calling thread briefly.
 * @param {number} ms - Milliseconds.
 * @returns {void}
 */
function _sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait one poll interval.
 * @param {boolean} background - When true the wait does not hold the process
 *   open: a handoff nobody is going to complete must not delay an exit.
 * @returns {Promise<void>}
 */
function _pause(background) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, POLL_MS);
    if (background) timer.unref();
  });
}

/**
 * Pane side: read the credential line from the FIFO, then remove the FIFO.
 * Bounded: returns null once `timeoutMs` passes with no complete line. Never
 * throws, so the pane's launch is never broken by a handoff that did not happen.
 * @param {string} fifoPath - FIFO named in the launch command.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - How long to wait.
 * @returns {string|null} The credential, or null.
 */
function receiveCredential(fifoPath, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? RECEIVE_TIMEOUT_MS);
  let fd = null;
  try {
    // Non-blocking, so opening does not wait for the server to open its end.
    fd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFIFO()) return null;
    const chunk = Buffer.alloc(MAX_LINE);
    let got = '';
    while (Date.now() < deadline) {
      let n = 0;
      try {
        n = fs.readSync(fd, chunk, 0, chunk.length, null);
      } catch (err) {
        if (err.code !== 'EAGAIN') return null;
      }
      // Zero bytes means no writer has written yet, not that there never will be one.
      if (n > 0) {
        got += chunk.toString('utf8', 0, n);
        const end = got.indexOf('\n');
        if (end !== -1) {
          const line = got.slice(0, end);
          return looksLikeCredential(line) ? line : null;
        }
        if (got.length > MAX_LINE) return null;
      } else {
        _sleepSync(POLL_MS);
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { removeFifo(fifoPath); } catch { /* the server removes it too */ }
  }
}

/**
 * Server side: write the credential into the FIFO once the pane has it open,
 * then remove the FIFO. Bounded on the open and on the write, and the FIFO is
 * removed on every path out.
 * @param {string} fifoPath - FIFO created by {@link prepareFifo}.
 * @param {string} credential - The credential to hand over.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - How long to keep trying.
 * @param {boolean} [options.background] - Do not hold the process open while waiting.
 * @returns {Promise<{delivered: boolean, code: string}>} `code` is `delivered`,
 *   `no-reader` (the pane never opened it), or `write-failed`.
 */
async function deliverCredential(fifoPath, credential, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? DELIVER_TIMEOUT_MS);
  const line = Buffer.from(`${credential}\n`, 'utf8');
  let fd = null;
  try {
    while (fd === null) {
      try {
        // ENXIO until a reader has the FIFO open; never blocks.
        fd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      } catch (err) {
        if (err.code !== 'ENXIO') return { delivered: false, code: 'write-failed' };
        if (Date.now() >= deadline) return { delivered: false, code: 'no-reader' };
        await _pause(options.background === true);
      }
    }
    let written = 0;
    while (written < line.length) {
      try {
        written += fs.writeSync(fd, line, written, line.length - written);
      } catch (err) {
        if (err.code !== 'EAGAIN' || Date.now() >= deadline) return { delivered: false, code: 'write-failed' };
        await _pause(options.background === true);
      }
    }
    return { delivered: true, code: 'delivered' };
  } finally {
    line.fill(0);
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { removeFifo(fifoPath); } catch { /* nothing more to do */ }
  }
}

module.exports = {
  CREDENTIAL_ENV,
  CREDENTIAL_PREFIX,
  DELIVER_TIMEOUT_MS,
  RECEIVE_TIMEOUT_MS,
  mintCredential,
  hashCredential,
  looksLikeCredential,
  prepareFifo,
  removeFifo,
  wrapLaunchCommand,
  unwrapLaunchCommand,
  receiveCredential,
  deliverCredential
};
