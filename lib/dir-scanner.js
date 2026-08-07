'use strict';

/**
 * Supervisor for the forked directory scanner.
 *
 * WHAT THIS BUYS. A directory read on a TCC-protected macOS path never returns.
 * Run in-process, `fs.promises` hands that read a libuv threadpool thread — four
 * by default, shared by every async filesystem call in the process — and a
 * deadline cannot get it back, because abandoning a promise does not cancel a
 * syscall. Four such reads and the server can no longer touch the filesystem AT
 * ALL, on any path, permanently, while `/api/health` still answers 200. Worse
 * than the outage is the diagnosis: every subsequent failure then times out, so
 * the product blames Full Disk Access for directories that were never protected
 * and sends the operator to change a permission that was never the problem.
 *
 * Moving the read into a child process makes the blocked thread belong to
 * something disposable. The deadline stops being a way to answer the request and
 * starts being a way to RECLAIM the resource: kill the child, and the threads it
 * had blocked in the kernel go with it.
 *
 * WHY ONE LONG-LIVED CHILD RATHER THAN A FORK PER SCAN. The dashboard polls
 * `GET /api/projects` every ten seconds for as long as a browser tab is open.
 * Fork-per-request means a node process spawn every ten seconds, forever, on the
 * healthy path, to guard against a failure almost no install ever hits. A
 * supervised child answers a warm IPC round trip instead, and is killed and
 * replaced only when it actually hangs.
 *
 * THE LIMIT, STATED HONESTLY, AS A RATE. `SIGKILL` removes the child from the
 * scheduler, but a thread already blocked inside an uninterruptible kernel call
 * does not necessarily unwind, so a killed child can linger in the process table
 * until this process exits and reaps it. The parent's threadpool is unaffected
 * either way — that is the defect being fixed — but the exchange is one stuck
 * process per hung REQUEST, and requests are not rare on the install this fixes:
 * the dashboard polls every ten seconds for as long as a tab is open, so an
 * unreadable projects directory produces roughly six unreapable processes per
 * minute, indefinitely. "One per hang" would read bounded and it is not. Each is
 * logged with a running total rather than only its pid, so the shape is visible
 * as a trend; capping the RATE is the per-path failure cache, which is why that
 * cache is part of this fix rather than a refinement of it.
 */

const path = require('node:path');
const { fork } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('dir-scanner');

// How long a scanner request may take before the child is written off. Not a
// performance budget — a local readdir is sub-millisecond. It is the point at
// which "slow" becomes indistinguishable from "never going to answer", and the
// only remedy for the second is to kill the process holding the blocked thread.
// Generous enough that a slow network mount still succeeds.
const DEFAULT_TIMEOUT_MS = 5000;

// How long to wait for a `SIGKILL`ed child to actually leave the process table
// before saying so. A child blocked in an uninterruptible syscall may never go,
// and that is worth one log line naming the pid — silent accumulation of stuck
// processes is how the leak this file fixes would come back wearing a different
// hat.
const CHILD_EXIT_GRACE_MS = 2000;

const DEFAULT_CHILD_PATH = path.join(__dirname, 'dir-scanner-child.js');

/**
 * Build an error that says the path never answered.
 *
 * Carries `tcTimedOut` so callers can tell "this directory is not responding"
 * from an ordinary filesystem error and offer the Full Disk Access remedy —
 * which is only ever the right advice for THIS failure.
 *
 * @param {number} ms - The deadline that expired.
 * @param {string} what - Short description of the work, e.g. `reading /a/b`.
 * @returns {Error}
 */
function _timedOut(ms, what) {
  const err = new Error(`timed out after ${ms}ms ${what}`);
  err.tcTimedOut = true;
  return err;
}

/**
 * Build an error for work that was cut short by something other than its own
 * deadline — a sibling request's kill, a child crash, or shutdown.
 *
 * DELIBERATELY NOT `tcTimedOut`. Collateral work did not time out; it was
 * travelling in a child that had to die for another request's sake, and its path
 * may be perfectly healthy. Marking it timed-out would resurrect the exact
 * misdiagnosis this whole change exists to remove: the operator told to grant
 * Full Disk Access for a directory that was never protected.
 *
 * @param {string} reason - Why the work was abandoned, in a caller-facing phrase.
 * @returns {Error}
 */
function _aborted(reason) {
  const err = new Error(`directory scan abandoned: ${reason}`);
  err.tcAborted = true;
  return err;
}

/**
 * Rebuild an error from the child's flattened form.
 *
 * `code` is restored as a property rather than folded into the message because
 * callers branch on it — `ENOENT` is what makes the wizard offer to create a
 * directory — and a condition that travels as prose breaks when the prose is
 * reworded.
 *
 * @param {{message: string, code: string|undefined}} plain - Serialised error.
 * @returns {Error}
 */
function _rehydrate(plain) {
  const err = new Error((plain && plain.message) || 'directory scan failed');
  if (plain && plain.code) err.code = plain.code;
  // A walk that ran out of budget, as opposed to a path that never answered.
  // The caller words a different sentence for each, and only the second earns
  // the Full Disk Access remedy.
  if (plain && plain.tcTruncated) err.tcTruncated = true;
  return err;
}

/**
 * Create a scanner: a lazily-forked, supervised child process that performs
 * filesystem work, plus the request/response protocol over it.
 *
 * The child is not forked until the first request, so a server that never lists
 * a directory never pays for one. It is re-forked on the next request after any
 * death, whatever the cause, so a crash degrades one request rather than every
 * request from then on.
 *
 * @param {object} [options] - Overrides.
 * @param {string} [options.childPath] - Module to fork. Injectable so a test can
 *   supply a child that genuinely hangs; production never passes it.
 * @param {number} [options.timeoutMs] - Default per-request deadline.
 * @param {number} [options.exitGraceMs] - How long a killed child may take to exit
 *   before that is logged.
 * @param {Function} [options.forkFn] - Injectable `child_process.fork`.
 * @returns {{request: Function, shutdown: Function, childPid: Function}}
 */
function createScanner(options = {}) {
  const childPath = options.childPath || DEFAULT_CHILD_PATH;
  const defaultTimeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const exitGraceMs = options.exitGraceMs === undefined ? CHILD_EXIT_GRACE_MS : options.exitGraceMs;
  const forkFn = options.forkFn || fork;

  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;

  // EVERY PENDING REQUEST NAMES THE CHILD IT WAS SENT TO. Ownership used to be
  // inferred from whichever child was current at the moment something happened,
  // and that inference is wrong in both directions: a dying child's late `exit`
  // would fail work already in flight on its replacement, and a child replaced
  // before its `exit` arrived would never fail the work it was actually holding
  // — that work then waited out its full deadline and was reported `tcTimedOut`,
  // the Full Disk Access misdiagnosis this module exists to remove, on a path
  // that may be perfectly healthy. `owner` makes it a fact instead of a guess.
  /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout, owner: object, what: string}>} */
  const pending = new Map();

  // Children already written off, so a second signal about the same one — an
  // `exit` following the kill that caused it, a `disconnect` racing both — is a
  // no-op rather than a second kill and a second sweep.
  const discarded = new WeakSet();

  let nextId = 0;
  let shuttingDown = false;
  let orphanCount = 0;

  /**
   * Settle a pending request exactly once, clearing its deadline.
   *
   * Every settlement path routes through here — reply, deadline, child death,
   * shutdown — because they race each other by nature: a child's last reply can
   * arrive after the kill that was meant to pre-empt it. Removing the entry
   * before settling makes the loser of that race a no-op instead of a
   * double-settle.
   *
   * @param {number} id - Correlation id.
   * @param {Error|null} err - Rejection cause, or null to resolve.
   * @param {any} [value] - Resolution value when `err` is null.
   * @returns {boolean} Whether this call was the one that settled it.
   */
  function _settle(id, err, value) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    _syncChannel(entry.owner);
    if (err) entry.reject(err); else entry.resolve(value);
    return true;
  }

  /**
   * Fail the work `victim` was holding, and say how much there was.
   *
   * Scoped to one child rather than to everything outstanding: a supervisor that
   * failed the whole map on any child's death would reject healthy requests
   * belonging to a successor.
   *
   * The count is logged because a kill sweeps N requests and only ONE of them —
   * the deadline's owner — is logged anywhere else. Without this, N-1 rejections
   * reaching callers have no server-side record at all.
   *
   * @param {object|null} victim - The child whose work is being failed.
   * @param {string} reason - Caller-facing phrase for what happened.
   * @returns {number} How many requests were swept.
   */
  function _failFor(victim, reason) {
    if (!victim) return 0;
    let swept = 0;
    for (const [id, entry] of [...pending]) {
      if (entry.owner !== victim) continue;
      swept++;
      _settle(id, _aborted(reason));
    }
    if (swept > 0) {
      log.warn('Directory scans abandoned with the scanner process that was holding them',
        { count: swept, pid: victim.pid, reason });
    }
    return swept;
  }

  /**
   * Hold the event loop open for `target` exactly while it owes a reply.
   *
   * An idle scanner must not be a reason for the process to stay up: a CLI that
   * listed one directory would never exit, and a test that forgot to shut down
   * would hang rather than fail.
   *
   * Computed from the map rather than tracked as a count, and taken against the
   * child that OWNS the work rather than whichever child is current. The earlier
   * shape leaked: with two requests in flight, killing the child settled one,
   * dropped the reference, then settled the rest against a null `child` — so a
   * killed child's channel was never released, and a child that lingers (the
   * expected case for a thread blocked in the kernel) held the loop open forever.
   *
   * @param {object|null} target - The child whose channel to re-evaluate.
   * @returns {void}
   */
  function _syncChannel(target) {
    if (!target || !target.channel) return;
    let outstanding = false;
    for (const entry of pending.values()) {
      if (entry.owner === target) { outstanding = true; break; }
    }
    if (outstanding) target.channel.ref();
    else target.channel.unref();
  }

  /**
   * Write off a child: fail what it was holding, release it, and kill it.
   *
   * Idempotent, because the signals that mean "this child is finished" arrive in
   * no guaranteed order and sometimes all three arrive. `SIGKILL` rather than
   * `SIGTERM` because the reason for killing is that the child is wedged, and a
   * wedged child cannot run a signal handler.
   *
   * @param {import('node:child_process').ChildProcess|null} victim - Child to kill.
   * @param {string} reason - Caller-facing phrase, used for both the rejections and the log.
   * @returns {void}
   */
  function _discardChild(victim, reason) {
    if (!victim || discarded.has(victim)) return;
    discarded.add(victim);
    if (child === victim) child = null;

    _failFor(victim, reason);
    // Released by the same code that drops the child, so the hold cannot outlive
    // the thing it was taken for.
    if (victim.channel) victim.channel.unref();

    if (victim.exitCode !== null || victim.signalCode !== null) return;

    const pid = victim.pid;
    let exited = false;
    victim.once('exit', () => { exited = true; });
    victim.kill('SIGKILL');

    if (exitGraceMs > 0) {
      const check = setTimeout(() => {
        if (exited) return;
        // Not a formality, and not a one-off. A thread blocked inside an
        // uninterruptible kernel call does not unwind on SIGKILL, so the process
        // sits in the table until this one exits and reaps it — and on the very
        // install this module fixes, the dashboard's ten-second poll produces
        // another one every ten seconds for as long as the directory stays
        // unreadable. The running total is logged, not just the latest pid,
        // because one line per kill reads like an incident while the number
        // reads like a trend. TangleClaw has been here before: architecture.md
        // calls ttyd's identical accumulation of kernel-wedged children the
        // machine's first hard ceiling.
        orphanCount++;
        log.warn('Scanner child did not exit after SIGKILL — it is blocked in the kernel and can '
          + 'only be reaped by the server exiting', { pid, reason, orphansThisRun: orphanCount });
      }, exitGraceMs);
      check.unref();
    }
  }

  /**
   * The live child, forked on demand.
   *
   * Lazy because most of this server's life involves no directory scan at all,
   * and re-forked after any death because the alternative — a supervisor that
   * gives up once — turns one crash into a permanently broken route.
   *
   * @returns {import('node:child_process').ChildProcess}
   */
  function _ensureChild() {
    if (child && child.connected) return child;

    // A child whose channel has closed is dead, whether or not its `exit` event
    // has arrived — Node does not order those two. Forking PAST it, as this used
    // to, left an orphan nobody killed (so the blocked thread this module exists
    // to reclaim was not reclaimed) whose in-flight work nobody failed.
    if (child) _discardChild(child, 'the scanner process closed its channel');

    const spawned = forkFn(childPath, [], {
      // stdout is inherited by nothing: the child says everything it has to say
      // over IPC, where it belongs to a request. stderr is PIPED rather than
      // ignored because one class of failure never reaches IPC at all — a child
      // that dies before it can reply, or fails to load. Discarding it leaves
      // `exited (code 1, signal null)` as the entire diagnosis.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json'
    });

    // Bounded on purpose. This exists to explain a death, and the first lines do
    // that; an unbounded buffer on a child that decided to log in a loop would be
    // a memory leak in the supervisor guarding against a resource leak.
    let stderr = '';
    if (spawned.stderr) {
      spawned.stderr.setEncoding('utf8');
      spawned.stderr.on('data', (chunk) => {
        if (stderr.length < 4096) stderr += chunk;
      });
      // MUST be unref'd, and it is easy to miss. A piped stdio stream is a
      // socket, and a socket with a `data` listener holds the event loop open on
      // its own — independently of the child handle and the IPC channel, both
      // unref'd below. Without this, any process that forks a scanner and does
      // not explicitly shut it down never exits: the work finishes, the tests
      // pass, and the runner hangs afterwards with no failing assertion to point
      // at. That is exactly how it was found.
      spawned.stderr.unref();
    }

    spawned.on('message', (msg) => {
      if (!msg || typeof msg.id !== 'number') return;
      if (msg.ok) _settle(msg.id, null, msg.value);
      else _settle(msg.id, _rehydrate(msg.error));
    });

    // Settles only the work THIS child was holding. A dying child's `exit`
    // arrives after the kill that caused it, by which time the next request may
    // already be in flight on a successor — failing the whole map here would
    // reject a healthy request because an unrelated predecessor finished dying.
    // Ownership answers that, so this no longer needs to guard on being current.
    spawned.on('exit', (code, signal) => {
      if (child === spawned) child = null;
      discarded.add(spawned);
      // An unexpected death is worth a line with whatever the child managed to
      // say. A deliberate kill is not: the deadline path has already logged the
      // reason, and repeating it as a failure would read like two problems.
      if (code) {
        const detail = { pid: spawned.pid, code, signal };
        // Only when there is something to say. A child killed by `process.exit`
        // writes nothing, and a logged `stderr=undefined` is noise that reads
        // like a second missing thing.
        if (stderr.trim()) detail.stderr = stderr.trim();
        log.warn('Scanner child exited unexpectedly', detail);
      }
      _failFor(spawned, `the scanner process exited (code ${code}, signal ${signal})`);
    });

    spawned.on('error', (err) => {
      log.warn('Scanner child failed', { error: err && err.message });
      if (child === spawned) child = null;
      discarded.add(spawned);
      _failFor(spawned, 'the scanner process could not be started');
    });

    // Never a reason for the process to stay alive on its own; see _syncChannel.
    spawned.unref();
    if (spawned.channel) spawned.channel.unref();

    child = spawned;
    return spawned;
  }

  /**
   * Ask the child to perform one operation, bounded by a deadline.
   *
   * On expiry the child is KILLED, not merely abandoned — that is the whole
   * point of this module. Requests travelling in the same child die with it and
   * are rejected as abandoned rather than timed out, so a healthy path caught in
   * someone else's kill is not reported as an unresponsive directory.
   *
   * @param {string} op - Operation name the child recognises.
   * @param {object} [payload] - Operation arguments.
   * @param {object} [opts] - Per-request overrides.
   * @param {number} [opts.timeoutMs] - Deadline for this request.
   * @param {string} [opts.what] - Short phrase for the timeout message, e.g. `reading /a/b`.
   * @returns {Promise<any>} The child's result, or a rejection carrying
   *   `tcTimedOut` (the path never answered) or `tcAborted` (collateral).
   */
  function request(op, payload = {}, opts = {}) {
    if (shuttingDown) {
      return Promise.reject(_aborted('the scanner is shutting down'));
    }

    const timeoutMs = opts.timeoutMs || defaultTimeoutMs;
    const what = opts.what || `running ${op}`;
    const id = ++nextId;

    let target;
    try {
      target = _ensureChild();
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Settle the owner of the deadline FIRST, so the kill's collateral sweep
        // cannot relabel it as abandoned. This request is the one that timed
        // out; it is the only one entitled to say the path did not answer.
        _settle(id, _timedOut(timeoutMs, what));
        // The path comes from the PAYLOAD, not from the caller's optional
        // phrase: `what` falls back to `running readdir`, and the child holding
        // the only other copy is about to be killed. An operator reading this
        // line afterwards must be able to tell WHICH directory hung — otherwise
        // the log misattributes at one layer down exactly as the product did at
        // the top. The id is here so the kill can be tied to the abandonment
        // sweep that follows it.
        log.warn('Directory scan did not answer — killing the scanner process to reclaim the '
          + 'thread it blocked', { id, op, dir: payload && payload.dir, timeoutMs, pid: target.pid });
        _discardChild(target,
          'the scanner process was killed after another request stopped responding');
      }, timeoutMs);
      // Deliberately NOT unref'd: an unref'd deadline does not fire when nothing
      // else keeps the loop alive, which is precisely the case it exists for.

      pending.set(id, { resolve, reject, timer, owner: target, what });
      _syncChannel(target);

      target.send({ id, op, payload }, (err) => {
        if (err) _settle(id, _aborted(`the scanner process could not be reached (${err.message})`));
      });
    });
  }

  /**
   * Stop the scanner and release its child.
   *
   * Required for an orderly server shutdown and for tests: an idle child holds
   * no loop reference, but it is still a live process, and a suite that forks one
   * per case would leave them behind.
   *
   * TERMINAL. Later requests are refused rather than forking a replacement — a
   * scanner that quietly came back to life after shutdown would leave a process
   * running past the teardown that was supposed to end it. Build a new scanner
   * instead.
   *
   * Returns once the kill has been ISSUED, not once the child is reaped: a child
   * blocked in an uninterruptible syscall may never be, and shutdown must not be
   * the thing that waits forever on it.
   *
   * @returns {Promise<void>}
   */
  async function shutdown() {
    shuttingDown = true;
    _discardChild(child, 'the scanner is shutting down');
    // Anything still outstanding belongs to a child already written off — an
    // orphan that outlived its kill. It is nobody's collateral now, and a caller
    // left waiting on it would wait for a process that will never reply.
    for (const id of [...pending.keys()]) {
      _settle(id, _aborted('the scanner is shutting down'));
    }
    child = null;
  }

  /**
   * The live child's pid, or null when none is running.
   *
   * Exposed because "was the child actually replaced" is not otherwise
   * observable, and it is the assertion that distinguishes a real kill from a
   * request that merely gave up.
   *
   * @returns {number|null}
   */
  function childPid() {
    return child && child.connected ? child.pid : null;
  }

  return { request, shutdown, childPid };
}

// The scanner the server uses. One per process: the child multiplexes correlated
// requests, and there is exactly one route family calling it, polling every ten
// seconds — a queue of at most a few requests, not a case for parallelism. If a
// second consumer with different latency appears, revisit before adding more.
const _defaultScanner = createScanner();

module.exports = {
  createScanner,
  request: (op, payload, opts) => _defaultScanner.request(op, payload, opts),
  shutdown: () => _defaultScanner.shutdown(),
  childPid: () => _defaultScanner.childPid()
};
