'use strict';

/**
 * Fault executors for the release-candidate soak (#2020).
 *
 * Each fault disturbs the guest's own TangleClaw in one way, then checks that
 * it recovered. Like every executor it resolves to an outcome and never
 * throws. A fault reports `ok: true` only when the disturbance was applied
 * AND the server came back as the fault predicts: the same server for a
 * disturbance it should ride out, a new one for a restart. What the
 * disturbance cost (failed calls while it was applied, how long a restart
 * took) is recorded beside the outcome, and judged elsewhere.
 *
 * Faults act on the machine the driver runs on, so they run only with the
 * local context `lib/soak/local.js#requireLocalControl` admitted (`ctx.local`).
 * Without it every fault refuses (`NO_LOCAL_CONTROL`) and touches nothing.
 *
 * Every fault acts only on what the harness owns or the guest TangleClaw
 * serves: its own stub session's tmux session, the guest's database file
 * under `--home`, a ballast directory under `--home`, and the guest's own
 * launchd jobs.
 *
 * @module lib/soak/faults
 */

const fs = require('node:fs');
const path = require('node:path');

const ex = require('./executors');

/** Closed set of fault outcome codes, beyond the HTTP ones in `executors.OUTCOME`. */
const FAULT_OUTCOME = Object.freeze({
  NO_LOCAL_CONTROL: 'NO_LOCAL_CONTROL',
  // The server answered 501: it has no launchd or systemd job to restart.
  NO_RESTART_MECHANISM: 'NO_RESTART_MECHANISM',
  // A wrap held the restart off for the whole window. Never forced.
  RESTART_BLOCKED: 'RESTART_BLOCKED',
  NOT_RESTARTED: 'NOT_RESTARTED',
  // The server's start time changed where the fault should have been ridden out.
  SERVER_RESTARTED: 'SERVER_RESTARTED',
  NOT_RECOVERED: 'NOT_RECOVERED',
  NOT_HARNESS_SESSION: 'NOT_HARNESS_SESSION',
  KILL_FAILED: 'KILL_FAILED',
  NOT_DETECTED: 'NOT_DETECTED',
  LOCK_NOT_ACQUIRED: 'LOCK_NOT_ACQUIRED',
  NO_HEADROOM: 'NO_HEADROOM',
  BALLAST_FAILED: 'BALLAST_FAILED',
  NOT_DESTRUCTIVE: 'NOT_DESTRUCTIVE',
  TTYD_UNREADABLE: 'TTYD_UNREADABLE',
  TTYD_NOT_RESTARTED: 'TTYD_NOT_RESTARTED'
});

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * How long each fault holds its disturbance and waits for recovery. A soak
 * measures stability, so every wait is bounded, and a server that never
 * comes back is an outcome, not a hang.
 * - `restartMs`: a requested restart producing a server with a new start time.
 * - `restartBlockedMs`: retrying a restart a running wrap refuses.
 * - `recoveryMs`: the server answering health again after a disturbance.
 * - `detectMs`: the server reporting a killed tmux session as not active.
 * - `lockHoldMs`: how long the database stays exclusively locked.
 * - `pressureHoldMs`: how long the disk stays under pressure.
 * - `ttydMs`: launchd starting a new ttyd after the kickstart.
 * - `aborts`, `abortAfterMs`: how many requests are cut off, and how soon.
 * - `ballastFloorBytes`: free space the ballast always leaves.
 * - `ballastMaxBytes`, `ballastMinBytes`: the ballast's size bounds.
 * - `ballastChunkBytes`: the size of each ballast write.
 */
const FAULT_LIMITS = Object.freeze({
  restartMs: 3 * 60 * 1000,
  restartBlockedMs: 10 * 60 * 1000,
  recoveryMs: 2 * 60 * 1000,
  detectMs: 60 * 1000,
  lockHoldMs: 5 * 1000,
  pressureHoldMs: 30 * 1000,
  ttydMs: 60 * 1000,
  aborts: 5,
  abortAfterMs: 5,
  ballastFloorBytes: 2 * GIB,
  ballastMaxBytes: 64 * GIB,
  ballastMinBytes: 64 * MIB,
  ballastChunkBytes: 16 * MIB
});

/** The ballast directory, inside the guest TangleClaw's home. */
const BALLAST_DIR = 'soak-ballast';

/** Ballast file names. Only files matching this are ever removed. */
const BALLAST_RE = /^ballast-[0-9a-f-]+\.bin$/;

/** The launchd label of the ttyd the server attaches terminals through (`deploy/com.tangleclaw.ttyd.plist`). */
const TTYD_LABEL = 'com.tangleclaw.ttyd';

/** Reads that a client abort cuts off. None of them changes state. */
const ABORT_ROUTES = Object.freeze(['/api/projects', '/api/server-info', '/api/system/health', '/api/ports', '/api/medusa/deliveries']);

/**
 * The tmux session name TangleClaw derives from a project name
 * (`lib/tmux.js#toSessionName`, which a test pins this to).
 * @param {string} name - Project name
 * @returns {string} Session name
 */
function tmuxName(name) {
  return name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * The limits in force: the defaults, with a test's overrides.
 * @param {object} ctx - Call context
 * @returns {object} Limits
 */
function _limits(ctx) {
  return { ...FAULT_LIMITS, ...((ctx.local && ctx.local.limits) || {}) };
}

/**
 * The server's start time, or why it could not be read.
 * @param {object} ctx - Call context
 * @returns {Promise<{ok: true, startedAt: string}|{ok: false, code: string, status: number|null}>} The start time, or the failure
 */
async function _startedAt(ctx) {
  const r = await ex.call(ctx, 'GET', '/api/server-info');
  if (!r.ok) return { ok: false, code: r.code, status: r.status };
  if (!r.body || typeof r.body.startedAt !== 'string') return { ok: false, code: ex.OUTCOME.BAD_BODY, status: r.status };
  return { ok: true, startedAt: r.body.startedAt };
}

/**
 * Wait for the server to answer health again, and check whether it is still
 * the server that was running before the fault.
 * @param {object} ctx - Call context
 * @param {string} before - The start time before the fault
 * @param {number} budgetMs - How long recovery may take
 * @returns {Promise<{ok: boolean, code: string, status: number|null, recoveryMs: number}>} Recovered as the same server, or why not
 */
async function _recovered(ctx, before, budgetMs) {
  const now = typeof ctx.now === 'function' ? ctx.now : Date.now;
  const began = now();
  let last = null;
  const r = await ex.poll(ctx, budgetMs, async () => {
    const h = await ex.call(ctx, 'GET', '/api/health');
    if (!h.ok) { last = { code: h.code, status: h.status }; return { done: false }; }
    const s = await _startedAt(ctx);
    if (!s.ok) { last = { code: s.code, status: s.status }; return { done: false }; }
    last = { startedAt: s.startedAt };
    return { done: true };
  });
  const recoveryMs = now() - began;
  if (r.timedOut || !last || last.startedAt === undefined) {
    return { ok: false, code: FAULT_OUTCOME.NOT_RECOVERED, status: last ? last.status || null : null, recoveryMs, ...(last && last.code ? { lastCode: last.code } : {}) };
  }
  if (last.startedAt !== before) return { ok: false, code: FAULT_OUTCOME.SERVER_RESTARTED, status: null, recoveryMs };
  return { ok: true, code: ex.OUTCOME.OK, status: null, recoveryMs };
}

/**
 * Wrap a fault so it refuses without local control, touching nothing.
 * @param {(ctx: object, params: object) => Promise<object>} fn - The fault
 * @returns {(ctx: object, params: object) => Promise<object>} Executor
 */
function _local(fn) {
  return async (ctx, params) => {
    if (!ctx.local) return { ok: false, code: FAULT_OUTCOME.NO_LOCAL_CONTROL, status: null, step: 'local' };
    return fn(ctx, params);
  };
}

/**
 * Restart the guest server through its own restart route, and wait for a new
 * server to answer.
 *
 * The route runs the product's own `launchctl kickstart`, so this exercises
 * the restart path an operator uses. A running wrap makes the route refuse
 * (`409 WRAP_RESTART_BLOCKED`). The fault retries within `restartBlockedMs`
 * and never sends `force`, since forcing would kill a wrap the load owns.
 * @param {object} ctx - Call context with `local`
 * @returns {Promise<object>} Outcome, with `restartMs` when the new server answered
 */
async function serverRestart(ctx) {
  const lim = _limits(ctx);
  const now = typeof ctx.now === 'function' ? ctx.now : Date.now;
  const before = await _startedAt(ctx);
  if (!before.ok) return { ok: false, code: before.code, status: before.status, step: 'before' };

  let blocked = 0;
  let req = null;
  await ex.poll(ctx, lim.restartBlockedMs, async () => {
    req = await ex.call(ctx, 'POST', '/api/server/restart', {});
    if (req.status === 409 && req.body && req.body.code === 'WRAP_RESTART_BLOCKED') { blocked++; return { done: false }; }
    return { done: true };
  });
  const blockedNote = blocked > 0 ? { blockedRetries: blocked } : {};
  if (req.status === 409 && req.body && req.body.code === 'WRAP_RESTART_BLOCKED') {
    return { ok: false, code: FAULT_OUTCOME.RESTART_BLOCKED, status: 409, step: 'restart', ...blockedNote };
  }
  if (req.status === 501) return { ok: false, code: FAULT_OUTCOME.NO_RESTART_MECHANISM, status: 501, step: 'restart', ...blockedNote };
  if (!req.ok || req.status !== 202) return { ok: false, code: req.ok ? ex.OUTCOME.HTTP_STATUS : req.code, status: req.status, step: 'restart', ...blockedNote };

  const began = now();
  let after = null;
  const r = await ex.poll(ctx, lim.restartMs, async () => {
    // Refused connections and 502s are expected while the old process exits.
    const s = await _startedAt(ctx);
    if (s.ok && s.startedAt !== before.startedAt) { after = s.startedAt; return { done: true }; }
    return { done: false };
  });
  if (r.timedOut || after === null) return { ok: false, code: FAULT_OUTCOME.NOT_RESTARTED, status: null, step: 'await-restart', ...blockedNote };
  const restartMs = now() - began;
  const health = await ex.call(ctx, 'GET', '/api/health');
  if (!health.ok) return { ok: false, code: health.code, status: health.status, step: 'health', restartMs, ...blockedNote };
  return { ok: true, code: ex.OUTCOME.OK, status: null, step: null, restartMs, ...blockedNote };
}

/**
 * Kill a harness session's tmux session behind the server's back, and check
 * that the server notices.
 *
 * The project first passes the same leftover check as every engine cycle. The
 * fault then launches its own stub session and kills exactly the tmux session
 * that launch named, and only after checking that the name is the project's
 * derived one and the engine is the stub. `=` makes tmux match the name
 * exactly, never as a prefix of another session.
 * @param {object} ctx - Call context with `local`
 * @param {{project: string}} params - Event params
 * @returns {Promise<object>} Outcome
 */
async function tmuxSessionKill(ctx, params) {
  const lim = _limits(ctx);
  const base = ex.sessionBase(params.project);
  const guard = await ex.clearLeftover(ctx, params.project);
  if (!guard.ok) return guard;
  const preNote = guard.preKilled ? { preKilled: true } : {};

  const launch = await ex.call(ctx, 'POST', base, { engineOverride: ex.STUB_ENGINE_ID, primePrompt: false });
  if (!launch.ok) return { ok: false, code: launch.code, status: launch.status, step: 'launch', ...preNote };
  const cleanup = async () => {
    const k = await ex.call(ctx, 'DELETE', base, { reason: 'soak fault: tmux session kill' });
    // The server may already have ended the crashed session: nothing to kill is clean.
    return k.ok || k.status === 404;
  };
  const name = launch.body && launch.body.tmuxSession;
  if (name !== tmuxName(params.project) || launch.body.engine !== ex.STUB_ENGINE_ID) {
    return { ok: false, code: FAULT_OUTCOME.NOT_HARNESS_SESSION, status: null, step: 'launch', cleanupFailed: !(await cleanup()), ...preNote };
  }

  const kill = await ctx.local.run('tmux', ['kill-session', '-t', `=${name}`], { timeoutMs: 10 * 1000 });
  if (kill.code !== 0) {
    return { ok: false, code: FAULT_OUTCOME.KILL_FAILED, status: null, step: 'kill', error: kill.error, cleanupFailed: !(await cleanup()), ...preNote };
  }

  let failure = null;
  const seen = await ex.poll(ctx, lim.detectMs, async () => {
    const s = await ex.call(ctx, 'GET', `${base}/status`);
    if (!s.ok) { failure = { code: s.code, status: s.status }; return { done: false }; }
    failure = null;
    return { done: !!s.body && s.body.active === false };
  });
  const cleaned = await cleanup();
  if (seen.timedOut) {
    return { ok: false, code: failure ? failure.code : FAULT_OUTCOME.NOT_DETECTED, status: failure ? failure.status : null, step: 'detect', cleanupFailed: !cleaned, ...preNote };
  }
  if (!cleaned) return { ok: false, code: ex.OUTCOME.HTTP_STATUS, status: null, step: 'cleanup', cleanupFailed: true, ...preNote };
  return { ok: true, code: ex.OUTCOME.OK, status: null, step: null, ...preNote };
}

/**
 * Cut off several reads mid-flight, then check that the same server still
 * answers. A client that disconnects must never take the server down.
 *
 * Only reads are aborted, so a cut-off request cannot leave half-made state
 * behind. Whether each one was cut off before or after its answer is a race,
 * and both are recorded.
 * @param {object} ctx - Call context with `local`
 * @returns {Promise<object>} Outcome, with how many requests were `aborted` and how many `completed`
 */
async function clientAbort(ctx) {
  const lim = _limits(ctx);
  const before = await _startedAt(ctx);
  if (!before.ok) return { ok: false, code: before.code, status: before.status, step: 'before' };
  let aborted = 0;
  let completed = 0;
  for (let i = 0; i < lim.aborts; i++) {
    const route = ABORT_ROUTES[i % ABORT_ROUTES.length];
    const ac = new AbortController();
    const headers = { accept: 'application/json' };
    if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;
    const timer = setTimeout(() => ac.abort(), lim.abortAfterMs);
    try {
      const res = await ctx.fetch(new URL(route, ctx.apiBase), { method: 'GET', redirect: 'manual', headers, signal: ac.signal });
      await res.text();
      completed++;
    } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: the abort itself surfaces as a rejected fetch or body read, which is the fault working
      aborted++;
    } finally {
      clearTimeout(timer);
    }
  }
  const rec = await _recovered(ctx, before.startedAt, lim.recoveryMs);
  return { ...rec, step: rec.ok ? null : 'recover', aborted, completed };
}

/**
 * Probe the server while a disturbance is applied: one read and one write.
 * Their outcomes are recorded, not judged: a server may answer an error while
 * its database is locked or its disk full, and what matters is that it
 * answers and recovers.
 * @param {object} ctx - Call context
 * @returns {Promise<object[]>} `{step, ok, code, status}` per probe
 */
async function _probeDuring(ctx) {
  const port = 5000 + ((ctx.eventIndex || 0) % 1000);
  const out = [];
  const read = await ex.call(ctx, 'GET', '/api/projects');
  out.push({ step: 'read', ok: read.ok, code: read.code, status: read.status });
  const lease = await ex.call(ctx, 'POST', '/api/ports/lease', { port, host: 'localhost', project: ex.LEASE_PROJECT, service: 'soak-fault', permanent: false, ttl: 5 * 60 * 1000 });
  out.push({ step: 'write', ok: lease.ok, code: lease.code, status: lease.status });
  if (lease.ok) {
    const rel = await ex.call(ctx, 'POST', '/api/ports/release', { port, host: 'localhost', project: ex.LEASE_PROJECT });
    out.push({ step: 'release', ok: rel.ok, code: rel.code, status: rel.status });
  }
  return out;
}

/**
 * Hold an exclusive lock on the guest database while the server takes load,
 * then release it and check the same server recovers.
 *
 * `BEGIN EXCLUSIVE` keeps every other connection from reading or writing, and
 * the transaction is rolled back, so the fault never changes the database. A
 * lock the server holds at that moment is waited on briefly; if the lock is
 * never taken the fault did not happen, and says so. If the driver dies while
 * holding it, the operating system releases the lock with the process.
 * @param {object} ctx - Call context with `local`
 * @returns {Promise<object>} Outcome, with the probes made while locked (`during`)
 */
async function dbLockContention(ctx) {
  const lim = _limits(ctx);
  const before = await _startedAt(ctx);
  if (!before.ok) return { ok: false, code: before.code, status: before.status, step: 'before' };
  const { DatabaseSync } = require('node:sqlite');
  let db = null;
  let locked = false;
  let during;
  try {
    try {
      db = new DatabaseSync(ctx.local.dbPath, { open: true });
      db.exec('PRAGMA busy_timeout = 2000');
      db.exec('BEGIN EXCLUSIVE');
      locked = true;
    } catch (err) { // prawduct:allow prawduct/broad-except -- the lock not being taken is this fault's recorded outcome, whatever SQLite's reason
      return { ok: false, code: FAULT_OUTCOME.LOCK_NOT_ACQUIRED, status: null, step: 'lock', error: String(err && err.message) };
    }
    const sleep = typeof ctx.sleep === 'function' ? ctx.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    during = await _probeDuring(ctx);
    await sleep(lim.lockHoldMs);
  } finally {
    if (db) {
      if (locked) db.exec('ROLLBACK');
      db.close();
    }
  }
  const rec = await _recovered(ctx, before.startedAt, lim.recoveryMs);
  return { ...rec, step: rec.ok ? null : 'recover', during };
}

/**
 * Remove every ballast file a previous run left, for example one whose driver
 * died while the disk was under pressure. Only files matching `BALLAST_RE`
 * are touched.
 * @param {string} dir - Ballast directory
 * @param {object} fsImpl - `node:fs`-shaped
 * @returns {number} How many were removed
 */
function _clearBallast(dir, fsImpl) {
  let removed = 0;
  for (const name of fsImpl.readdirSync(dir)) {
    if (!BALLAST_RE.test(name)) continue;
    fsImpl.unlinkSync(path.join(dir, name));
    removed++;
  }
  return removed;
}

/**
 * The ballast directory under the guest home, created if missing. It must be
 * a plain directory owned by this user, so the fault never writes, or later
 * removes files, anywhere else.
 * @param {object} ctx - Call context with `local`
 * @param {object} fsImpl - `node:fs`-shaped
 * @returns {{dir: string}|{problem: string}} The directory, or why it cannot be used
 */
function _ballastDir(ctx, fsImpl) {
  const dir = path.join(ctx.local.home, BALLAST_DIR);
  try {
    fsImpl.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') return { problem: `cannot create ${dir}: ${err.code}` };
  }
  const st = fsImpl.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return { problem: `${dir} is not a plain directory` };
  if (st.uid !== ctx.local.uid) return { problem: `${dir} is owned by uid ${st.uid}` };
  return { dir };
}

/**
 * Fill the guest disk to a fixed floor of free space, hold it there while the
 * server takes load, then free it and check the same server recovers.
 *
 * The ballast never takes the disk below `ballastFloorBytes` free, and never
 * exceeds `ballastMaxBytes`. Too little headroom to write `ballastMinBytes`
 * is `NO_HEADROOM`: the fault could not be applied, which is not a pass.
 * The ballast is real bytes, not a sparse file, so it takes real space. It is
 * removed whatever happens, and any leftover from a dead run is removed first.
 * @param {object} ctx - Call context with `local`
 * @returns {Promise<object>} Outcome, with `ballastBytes`, `freeBefore` and the probes made under pressure (`during`)
 */
async function diskPressure(ctx) {
  const lim = _limits(ctx);
  const fsImpl = ctx.local.fs || fs;
  const before = await _startedAt(ctx);
  if (!before.ok) return { ok: false, code: before.code, status: before.status, step: 'before' };
  // Preparing the ballast touches the filesystem three ways (the directory,
  // the sweep, the free-space read); any of them failing is this fault's
  // recorded outcome, with the filesystem's reason, not a thrown executor.
  let where;
  let leftover;
  let freeBefore;
  try {
    where = _ballastDir(ctx, fsImpl);
    if (where.problem) return { ok: false, code: FAULT_OUTCOME.BALLAST_FAILED, status: null, step: 'ballast-dir', error: where.problem };
    leftover = _clearBallast(where.dir, fsImpl);
    const st = fsImpl.statfsSync(where.dir);
    freeBefore = st.bavail * st.bsize;
  } catch (err) {
    if (!err || typeof err.code !== 'string') throw err;
    return { ok: false, code: FAULT_OUTCOME.BALLAST_FAILED, status: null, step: 'ballast-prepare', error: err.code };
  }
  const leftNote = leftover > 0 ? { leftoverRemoved: leftover } : {};
  const target = Math.min(lim.ballastMaxBytes, freeBefore - lim.ballastFloorBytes);
  if (target < lim.ballastMinBytes) return { ok: false, code: FAULT_OUTCOME.NO_HEADROOM, status: null, step: 'ballast', freeBefore, ...leftNote };

  // Named by the run and the event, in the characters `BALLAST_RE` accepts,
  // so a later run recognises it as ballast and removes it.
  const file = path.join(where.dir, `ballast-${String(ctx.runKey || '0').toLowerCase().replace(/[^0-9a-f-]/g, '-')}-${ctx.eventIndex || 0}.bin`);
  const chunk = Buffer.alloc(lim.ballastChunkBytes, 0xa5);
  let written = 0;
  let during = null;
  let failure = null;
  try {
    const fh = await fsImpl.promises.open(file, 'wx', 0o600);
    try {
      while (written < target) {
        const n = Math.min(chunk.length, target - written);
        const { bytesWritten } = await fh.write(chunk, 0, n);
        written += bytesWritten;
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    const sleep = typeof ctx.sleep === 'function' ? ctx.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    during = await _probeDuring(ctx);
    await sleep(lim.pressureHoldMs);
  } catch (err) {
    if (!err || typeof err.code !== 'string') throw err;
    failure = err.code;
  } finally {
    try {
      fsImpl.unlinkSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT') failure = failure || `unlink ${err.code}`;
    }
  }
  if (failure) return { ok: false, code: FAULT_OUTCOME.BALLAST_FAILED, status: null, step: 'ballast', error: failure, ballastBytes: written, freeBefore, ...leftNote };
  const rec = await _recovered(ctx, before.startedAt, lim.recoveryMs);
  return { ...rec, step: rec.ok ? null : 'recover', ballastBytes: written, freeBefore, during, ...leftNote };
}

/**
 * The ttyd launchd job's pid, from `launchctl list <label>`, which prints a
 * property list with a `"PID" = <n>;` line while the job runs.
 * @param {object} ctx - Call context with `local`
 * @returns {Promise<number|null>} The pid, or null when not running or unreadable
 */
async function _ttydPid(ctx) {
  const r = await ctx.local.run('launchctl', ['list', TTYD_LABEL], { timeoutMs: 10 * 1000 });
  if (r.code !== 0) return null;
  const m = /"PID"\s*=\s*(\d+);/.exec(r.stdout);
  return m ? Number(m[1]) : null;
}

/**
 * Restart the ttyd every terminal attaches through, the way
 * `lib/ttyd-watcher.js` does (`launchctl kickstart -k gui/<uid>/<label>`),
 * and wait for launchd to run a new one.
 *
 * This changes the ttyd generation, which fails a certification outright, so
 * the schedule allows it only in a destructive phase. The fault checks the
 * phase itself as well, and refuses (`NOT_DESTRUCTIVE`) in any other.
 * @param {object} ctx - Call context with `local`
 * @returns {Promise<object>} Outcome, with the pids `before` and `after`
 */
async function ttydRestart(ctx) {
  const lim = _limits(ctx);
  if (ctx.local.phase !== 'destructive') return { ok: false, code: FAULT_OUTCOME.NOT_DESTRUCTIVE, status: null, step: 'phase' };
  const before = await _ttydPid(ctx);
  if (before === null) return { ok: false, code: FAULT_OUTCOME.TTYD_UNREADABLE, status: null, step: 'before' };
  const kick = await ctx.local.run('launchctl', ['kickstart', '-k', `gui/${ctx.local.uid}/${TTYD_LABEL}`], { timeoutMs: 30 * 1000 });
  if (kick.code !== 0) return { ok: false, code: FAULT_OUTCOME.KILL_FAILED, status: null, step: 'kickstart', error: kick.error, before };
  let after = null;
  const r = await ex.poll(ctx, lim.ttydMs, async () => {
    const pid = await _ttydPid(ctx);
    if (pid !== null && pid !== before) { after = pid; return { done: true }; }
    return { done: false };
  });
  if (r.timedOut || after === null) return { ok: false, code: FAULT_OUTCOME.TTYD_NOT_RESTARTED, status: null, step: 'await-ttyd', before };
  const health = await ex.call(ctx, 'GET', '/api/health');
  if (!health.ok) return { ok: false, code: health.code, status: health.status, step: 'health', before, after };
  return { ok: true, code: ex.OUTCOME.OK, status: null, step: null, before, after };
}

/**
 * The fault executors by event kind. Each takes `(ctx, params)`.
 * @type {Object<string, (ctx: object, params: object) => Promise<object>>}
 */
const FAULT_EXECUTORS = Object.freeze({
  'fault.server.restart': _local(serverRestart),
  'fault.tmux.session-kill': _local(tmuxSessionKill),
  'fault.client.abort': _local(clientAbort),
  'fault.db.lock-contention': _local(dbLockContention),
  'fault.disk.pressure': _local(diskPressure),
  'fault.ttyd.restart': _local(ttydRestart)
});

module.exports = { FAULT_EXECUTORS, FAULT_OUTCOME, FAULT_LIMITS, BALLAST_DIR, BALLAST_RE, TTYD_LABEL, ABORT_ROUTES, tmuxName };
