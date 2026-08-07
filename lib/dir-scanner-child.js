'use strict';

/**
 * The sacrificial half of the directory scanner: a forked process that performs
 * filesystem work on paths the operator chose, so the server never does.
 *
 * WHY A SEPARATE PROCESS AND NOT A THREAD. A TCC-protected path on macOS does
 * not fail a read, it never answers one — the `open()` stays in the kernel for
 * the life of the process. `fs.promises` puts that call on libuv's threadpool,
 * which defaults to FOUR threads and is shared by every async filesystem call
 * in the process. A deadline can abandon the promise; it cannot cancel the
 * syscall, so the thread is gone for good. Four such reads and the process can
 * no longer perform ANY filesystem operation, on any path, while `/api/health`
 * keeps answering 200 and nothing surfaces.
 *
 * `worker_threads` is not a substitute: workers share the process-wide libuv
 * pool, and `terminate()` cannot interrupt a thread blocked in a syscall. Only
 * killing the process that owns the blocked thread reclaims the resource, and
 * that is what this file exists to be — the thing that can be killed.
 *
 * It therefore holds no state worth keeping and nothing else depends on it
 * being alive. The supervisor in `dir-scanner.js` kills it on a deadline and
 * forks a replacement on the next request.
 */

const fsp = require('node:fs').promises;

/**
 * Reduce a `Dirent` to the fields that survive a structured-clone IPC hop.
 *
 * `Dirent` answers its questions through methods, and a method does not cross a
 * process boundary — a caller that received the object verbatim would find
 * `entry.isDirectory` undefined and silently classify every entry as a file.
 * Flattening to booleans here is what makes the answer usable on the far side.
 *
 * @param {import('node:fs').Dirent} entry - One entry from a `withFileTypes` read.
 * @returns {{name: string, isDirectory: boolean, isFile: boolean, isSymbolicLink: boolean}}
 */
function _plainDirent(entry) {
  return {
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    isSymbolicLink: entry.isSymbolicLink()
  };
}

/**
 * The operations this child will perform. Anything not named here is refused
 * rather than guessed at, so a typo in a caller is a clear error instead of a
 * silent no-op.
 *
 * Each handler takes the request payload and resolves with a JSON-serialisable
 * value. Handlers may hang forever — that is the case this whole design exists
 * for — so none of them may hold state the supervisor would miss.
 */
const HANDLERS = {
  /**
   * Confirm the child is alive and answering, and say which process answered.
   *
   * The pid is the point: it is how a caller tells "the same child replied"
   * from "a replacement child replied", which is the difference between a
   * healthy round trip and a silent respawn after a crash.
   *
   * @returns {Promise<{pid: number}>}
   */
  async ping() {
    return { pid: process.pid };
  },

  /**
   * Read the immediate entries of a directory.
   *
   * Always reads with file types and flattens them: the caller's next question
   * is invariably "which of these are directories", and answering it here costs
   * nothing while answering it on the parent side would mean a `stat` per entry
   * over the very tree suspected of not answering.
   *
   * @param {object} payload - Request payload.
   * @param {string} payload.dir - Absolute directory to read.
   * @returns {Promise<{entries: Array<{name: string, isDirectory: boolean, isFile: boolean, isSymbolicLink: boolean}>}>}
   */
  async readdir({ dir }) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return { entries: entries.map(_plainDirent) };
  }
};

/**
 * Flatten an error into something IPC can carry.
 *
 * `code` travels separately from the message because callers branch on it —
 * `ENOENT` means "offer to create this directory" and a reworded sentence must
 * not be able to change that. The stack is deliberately dropped: it describes
 * this file, not the caller's problem.
 *
 * @param {Error|any} err - Whatever the handler threw.
 * @returns {{message: string, code: string|undefined}}
 */
function _plainError(err) {
  if (err && typeof err === 'object') {
    return { message: String(err.message || err), code: err.code };
  }
  return { message: String(err), code: undefined };
}

/**
 * Run one request and reply with its outcome.
 *
 * Never throws and never rejects: this is the top of the child's call stack, so
 * an escaping error would kill the process and strand the supervisor's pending
 * request until its deadline — a five-second wait for a failure already known.
 * A reply that says "this failed, and why" is strictly better.
 *
 * @param {{id: number, op: string, payload: object}} msg - Request from the supervisor.
 * @returns {Promise<void>}
 */
async function _handle(msg) {
  const { id, op, payload } = msg || {};
  const handler = HANDLERS[op];

  if (!handler) {
    _reply({ id, ok: false, error: { message: `unknown scanner operation: ${op}`, code: 'ENOSYS' } });
    return;
  }

  try {
    const value = await handler(payload || {});
    _reply({ id, ok: true, value });
  } catch (err) { // prawduct:allow prawduct/broad-except -- top of the child's call stack; the error is reported to the supervisor, not swallowed
    _reply({ id, ok: false, error: _plainError(err) });
  }
}

/**
 * Send a reply, tolerating a supervisor that has already gone away.
 *
 * `process.send` throws on a closed channel, and the channel closing is the
 * NORMAL end of this process's life — the supervisor kills children that took
 * too long, and a killed child's last in-flight reply races the kill. Throwing
 * there would turn an expected shutdown into an unhandled rejection in the logs.
 *
 * @param {object} message - The reply envelope.
 * @returns {void}
 */
function _reply(message) {
  if (!process.connected) return;
  try {
    process.send(message);
  } catch { // prawduct:allow prawduct/broad-except -- the channel closed between the check and the send; there is no one left to tell
    // The supervisor is gone. It has already failed this request on its side.
  }
}

// Only when actually forked. A test that requires this file for its helpers must
// not thereby install a `disconnect` handler on ITS OWN process — the test runner
// forks test files too, so the handler would fire on the runner's channel and
// exit the test process mid-suite. `require.main` is the exact distinction:
// `fork()` makes this file the entry point, `require()` never does.
if (require.main === module) {
  process.on('message', (msg) => { _handle(msg); });

  // Outlive nothing. If the supervisor dies — crash, kill, server restart — this
  // process has no reason to exist and no one to answer; without this it would be
  // reparented to init and linger, holding whatever it was blocked on. Children
  // that survive their parent are how a leak becomes permanent.
  process.on('disconnect', () => { process.exit(0); });
}

module.exports = { HANDLERS, _plainDirent, _plainError, _handle };
