'use strict';

/**
 * The decisions behind the ttyd churn harness (#1245), kept free of processes
 * so each one can be tested: whether a run may start, when it must stop, what
 * counts as a wedged child, how long exiting children really live, and what
 * verdict a run earns. `scripts/ttyd-churn.js` drives a scratch ttyd with these.
 *
 * The harness exists to answer one question with evidence rather than
 * inference: does a given ttyd + attach-script pair leave children stuck in the
 * exiting state under websocket churn? It must be able to say "yes" (the
 * installed build is expected to), "no" (a fix), and must never say either
 * about a run it could not measure.
 */

// Host guards (Architect ruling R22 Q6). A run shares the machine's PTY pool
// with the live service, so it is capped hard and stopped early.
const MAX_CONCURRENCY = 10;
const STOP_AT_WEDGES = 5;
const STOP_AT_POOL_RATIO = 0.25;
// Refuse to START above this, leaving room below the stop line for the run
// itself (10 clients plus whatever wedges before the stop fires).
const PREFLIGHT_MAX_POOL_RATIO = 0.15;
// A child SEEN exiting for this long has not merely been slow to exit: a normal
// `tmux attach` exits in milliseconds. Measured by the sampler from the first
// sample that saw the child exiting, never from `ps etime` (how long the
// process has existed, which says nothing about when it began to exit).
const WEDGE_FLOOR_MS = 10 * 1000;
// Acceptance for a candidate that may ship (R22 Q7).
const ACCEPT_CYCLES = 2000;
const ACCEPT_SOAK_MS = 2 * 60 * 60 * 1000;
const RETURN_WINDOW_MS = 30 * 1000;
const FD_TOLERANCE = 4;

const CLOSE_MODES = Object.freeze(['clean', 'abrupt', 'paused', 'replay', 'noread']);

/**
 * Decide whether a run may start.
 * @param {object} facts
 * @param {string} facts.platform - `process.platform`.
 * @param {string|null} facts.ttydLeakState - The live health panel's `ttyd-leak` state, or null if unreadable.
 * @param {{used: number, cap: number}|null} facts.pool - Global PTY pool, or null if unreadable.
 * @param {boolean} facts.socketInUse - Whether the scratch socket path already exists.
 * @param {string|null} facts.ttydBin - Resolved ttyd binary, or null.
 * @param {string|null} facts.tmuxBin - Resolved tmux binary, or null.
 * @param {number} facts.concurrency - Requested concurrency.
 * @returns {{ok: boolean, reasons: string[]}}
 */
function checkPreflight(facts) {
  const reasons = [];
  if (facts.platform !== 'darwin') reasons.push(`platform is ${facts.platform}; the leak and this harness are macOS-only`);
  if (facts.ttydLeakState !== 'clear') {
    reasons.push(`the live health panel's ttyd row is ${facts.ttydLeakState === null ? 'unreadable' : facts.ttydLeakState}, not clear`);
  }
  if (!facts.pool) {
    reasons.push('the global PTY pool could not be read');
  } else if (facts.pool.used / facts.pool.cap > PREFLIGHT_MAX_POOL_RATIO) {
    reasons.push(`global PTY use is ${facts.pool.used}/${facts.pool.cap}, above the ${Math.round(PREFLIGHT_MAX_POOL_RATIO * 100)}% start limit`);
  }
  if (facts.socketInUse) reasons.push('the scratch socket path already exists: another run may be live');
  if (!facts.ttydBin) reasons.push('no ttyd binary was found');
  if (!facts.tmuxBin) reasons.push('no tmux binary was found');
  if (!Number.isInteger(facts.concurrency) || facts.concurrency < 1 || facts.concurrency > MAX_CONCURRENCY) {
    reasons.push(`concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * How many children have been seen exiting for at least `floorMs`.
 * @param {number[]} exitingForMs - `LifetimeTracker#stillOpen`: how long each
 *   still-exiting child has been observed exiting.
 * @param {number} [floorMs=WEDGE_FLOOR_MS]
 * @returns {number}
 */
function countWedges(exitingForMs, floorMs = WEDGE_FLOOR_MS) {
  return exitingForMs.filter((ms) => ms >= floorMs).length;
}

/**
 * Decide, between batches, whether the run continues.
 * @param {object} s
 * @param {number|null} s.wedges - Confirmed scratch wedges now, or null if the children could not be read.
 * @param {{used: number, cap: number}|null} s.pool - Global PTY pool now, or null.
 * @returns {'continue'|'reproduced'|'aborted-pool'|'aborted-unmeasured'}
 */
function nextStep(s) {
  // A blind run is not a safe run: without the pool, the 25% stop cannot fire.
  if (!s.pool || s.wedges === null) return 'aborted-unmeasured';
  if (s.pool.used / s.pool.cap >= STOP_AT_POOL_RATIO) return 'aborted-pool';
  // Every mode stops here: a baseline has shown the leak, and a candidate
  // has failed. Neither earns more cycles against the shared pool.
  if (s.wedges >= STOP_AT_WEDGES) return 'reproduced';
  return 'continue';
}

/**
 * Tracks each exiting child of the scratch ttyd across samples, so the run can
 * report how long an exiting child really lives. That distribution is what sets
 * the watcher's wedge age from data rather than a guess (R22 Q3).
 */
class LifetimeTracker {
  constructor() {
    this._open = new Map();
    this.lifetimes = [];
  }

  /**
   * Record one sample.
   * @param {Array<{pid: number, stat: string, ageMs: number|null}>} children - The scratch ttyd's children now.
   * @param {number} now - Sample time, ms.
   * @returns {void}
   */
  observe(children, now) {
    const seen = new Set();
    for (const c of children) {
      if (!(c.stat.includes('E') || c.stat.includes('Z'))) continue;
      seen.add(c.pid);
      if (!this._open.has(c.pid)) this._open.set(c.pid, { firstSeen: now, lastSeen: now });
      else this._open.get(c.pid).lastSeen = now;
    }
    for (const [pid, span] of this._open) {
      if (seen.has(pid)) continue;
      // Gone since the last sample. Its exiting time is at least lastSeen -
      // firstSeen; a child seen once lived under one sample interval.
      this.lifetimes.push(span.lastSeen - span.firstSeen);
      this._open.delete(pid);
    }
  }

  /**
   * Children still exiting at the end of the run, with how long they have been.
   * @param {number} now - Time, ms.
   * @returns {number[]}
   */
  stillOpen(now) {
    return [...this._open.values()].map((span) => now - span.firstSeen);
  }
}

/**
 * Parse `ps -A -o pid=,ppid=,pgid=,stat=,etime=,lstart=` into a process table.
 * `lstart` (the process's start time) is what makes a process's identity
 * survive PID reuse: macOS recycles PIDs, and a two-hour run spawns tens of
 * thousands of short-lived processes.
 * @param {string} out - The `ps` stdout.
 * @returns {Array<{pid: number, ppid: number, pgid: number, stat: string, etime: string, lstart: string}>}
 */
function parseProcTable(out) {
  const rows = [];
  for (const line of String(out).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S.*\S)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], stat: m[4], etime: m[5], lstart: m[6].replace(/\s+/g, ' ') });
  }
  return rows;
}

/**
 * Every descendant of `root` in a process table, however deep.
 * @param {Array<{pid: number, ppid: number}>} table
 * @param {number} root - Ancestor PID.
 * @returns {Array<object>} Rows, root excluded.
 */
function descendantsOf(table, root) {
  const byParent = new Map();
  for (const r of table) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const out = [];
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length) {
    for (const child of byParent.get(queue.shift()) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * Every process the scratch run owns, recorded AS IT APPEARS rather than
 * rediscovered at the end: a process that outlives the scratch ttyd is
 * reparented to launchd, so an end-time walk of ttyd's descendants would miss
 * exactly the survivors that matter. Records the scratch ttyd, each descendant
 * PID, and each descendant's process group (a ttyd child is a session leader,
 * so its group gathers whatever it forks).
 */
class ProcessLedger {
  /**
   * @param {number} rootPid - The scratch ttyd.
   * @param {string|null} [rootStart] - Its `lstart`, when known.
   */
  constructor(rootPid, rootStart = null) {
    this.root = rootPid;
    // Identity is PID + start time, and EVERY start time seen for a PID is
    // kept: within one long run a PID can be reused by another of the run's own
    // processes, and that one may be the one that leaks.
    this.procs = new Map([[rootPid, new Set(rootStart ? [rootStart] : [])]]);
    // Group id → every start time seen for its leader.
    this.groups = new Map();
    this.pids = new Set([rootPid]);
    this.pgids = new Set();
  }

  /**
   * Remember one identity.
   * @param {Map<number, Set<string>>} map
   * @param {number} id
   * @param {string|null} start
   * @returns {void}
   */
  static _add(map, id, start) {
    if (!map.has(id)) map.set(id, new Set());
    if (start) map.get(id).add(start);
  }

  /**
   * Record every current descendant of the scratch ttyd.
   * @param {Array<object>} table - From `parseProcTable`.
   * @returns {void}
   */
  record(table) {
    const rootRow = table.find((r) => r.pid === this.root);
    if (rootRow) ProcessLedger._add(this.procs, this.root, rootRow.lstart);
    for (const r of descendantsOf(table, this.root)) {
      ProcessLedger._add(this.procs, r.pid, r.lstart);
      this.pids.add(r.pid);
      if (r.pgid !== this.root) {
        this.pgids.add(r.pgid);
        const leader = table.find((x) => x.pid === r.pgid);
        ProcessLedger._add(this.groups, r.pgid, leader ? leader.lstart : null);
      }
    }
  }

  /**
   * Whether a row is a process this run recorded: same PID and a start time
   * seen for it (a PID recorded before its start time was known matches any).
   * @param {object} r - A process-table row.
   * @returns {boolean}
   */
  owns(r) {
    const starts = this.procs.get(r.pid);
    return !!starts && (starts.size === 0 || starts.has(r.lstart));
  }

  /**
   * The rows of a table that are exactly this run's recorded processes — the
   * set whose PTYs are measured. No process-group fallback here: a group match
   * is evidence of a survivor, not proof of identity.
   * @param {Array<object>} table - From `parseProcTable`.
   * @returns {Array<object>}
   */
  owned(table) {
    return table.filter((r) => this.owns(r));
  }

  /**
   * Processes in a table that belong to this run: a recorded process (PID and
   * start time), or a member of a recorded process group — which catches a
   * child forked after the last sample — unless that group id has visibly been
   * reused (a live leader whose start time was never seen for it).
   * @param {Array<object>} table - From `parseProcTable`.
   * @returns {Array<object>}
   */
  survivors(table) {
    const byPid = new Map(table.map((r) => [r.pid, r]));
    return table.filter((r) => {
      if (this.owns(r)) return true;
      const starts = this.groups.get(r.pgid);
      if (!starts) return false;
      const leader = byPid.get(r.pgid);
      return !leader || starts.size === 0 || starts.has(leader.lstart);
    });
  }
}

/**
 * The PIDs an `lsof -F pn` output reports on.
 * @param {string} out - lsof stdout.
 * @returns {Set<number>}
 */
function lsofReportedPids(out) {
  const reported = new Set();
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^p(\d+)$/);
    if (m) reported.add(+m[1]);
  }
  return reported;
}

/**
 * Whether an `lsof` result can be read as a true reading of the processes it
 * was asked about (Architect ruling on #1245 chunk 07). A clean exit is. A
 * timeout, a signal or an overflowing buffer means the output was CUT OFF and
 * is never a reading. Exit 1 is a reading ONLY when the output names no
 * process that was not requested and every requested process it omitted is,
 * by a process-state read taken AFTER lsof:
 *   - identity-proven gone: its PID is absent, or now has a different start
 *     time (the PID was reused, so the requested process is gone); or
 *   - the SAME identity (PID and start time) in exact state E or Z, i.e.
 *     exiting or a zombie, whose file table the kernel has already torn down
 *     so lsof has nothing to list. (The PTY masters its parent ttyd holds for
 *     it are still listed, under ttyd.)
 * A missing post-lsof state read, or an omitted process still running, is
 * unmeasured — never an empty measurement. Recognizing E/Z here only explains
 * an omission; it never removes that identity from the ledger or survivor check.
 * @param {Error|null} err - `execFile`'s error.
 * @param {string} stdout - What lsof printed (`-F pn`).
 * @param {Array<{pid: number, lstart: string}>} requested - The identities lsof was asked about.
 * @param {Map<number, {lstart: string, stat: string}>|null} after - State of the
 *   OMITTED PIDs read after lsof (absent key = no such PID), or null if unreadable.
 * @returns {string|null} The output to parse, or null when unmeasured.
 */
function lsofOutput(err, stdout, requested, after) {
  const out = stdout || '';
  if (!err) return out;
  if (err.killed || err.signal || err.code !== 1) return null;
  const reported = lsofReportedPids(out);
  const asked = new Set(requested.map((r) => r.pid));
  for (const pid of reported) if (!asked.has(pid)) return null;
  const omitted = requested.filter((r) => !reported.has(r.pid));
  if (omitted.length === 0) return out;
  if (!after) return null;
  for (const r of omitted) {
    const now = after.get(r.pid);
    if (!now) continue;
    if (now.lstart !== r.lstart) continue;
    // In macOS `ps` state strings, uppercase E and Z mean only "trying to
    // exit" and "zombie" — the same test the watcher uses.
    if (!/[EZ]/.test(now.stat)) return null;
  }
  return out;
}

/**
 * Parse `lsof -F pn` output into the PTYs it shows held: slave devices
 * (`/dev/ttysNNN`, by name) and master handles (`/dev/ptmx`, by count).
 * @param {string} out - `lsof -F pn` stdout.
 * @returns {{slaves: string[], masters: number}}
 */
function parseLsofPtys(out) {
  const slaves = new Set();
  let masters = 0;
  for (const line of String(out).split('\n')) {
    if (!line.startsWith('n')) continue;
    const name = line.slice(1);
    if (/^\/dev\/ttys\d+$/.test(name)) slaves.add(name);
    else if (name === '/dev/ptmx') masters++;
  }
  return { slaves: [...slaves].sort(), masters };
}

/**
 * Whether the run-owned PTYs are back where they started: no slave device
 * still held, and no more master handles than at the baseline.
 * @param {{slaves: string[], masters: number}|null} baseline
 * @param {{slaves: string[], masters: number}|null} final
 * @returns {boolean|null} null when either side was not measured.
 */
function ownedPtysReturned(baseline, final) {
  if (!baseline || !final) return null;
  return final.slaves.length <= baseline.slaves.length && final.masters <= baseline.masters;
}

/**
 * Nearest-rank percentiles of a list of durations.
 * @param {number[]} values
 * @returns {{n: number, p50: number|null, p95: number|null, p99: number|null, max: number|null}}
 */
function percentiles(values) {
  if (values.length === 0) return { n: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] };
}

/**
 * Whether a resource count came back to its baseline.
 * @param {number|null} baseline
 * @param {number|null} final
 * @param {number} tolerance
 * @returns {boolean|null} null when either side was not measured.
 */
function returned(baseline, final, tolerance) {
  if (baseline === null || final === null) return null;
  return final <= baseline + tolerance;
}

/**
 * The verdict a finished run earns. A run that could not measure what its
 * verdict depends on gets `inconclusive`, never a pass.
 *
 * - `baseline` expects the leak: `reproduced` confirms the mechanism (and that the
 *   harness can see it); anything else means the harness or the hypothesis is wrong.
 * - `control` runs a command that exits cleanly and must show zero wedges; a
 *   wedge there means the harness is producing its own.
 * - `candidate` is a fix: it must meet R22 Q7 in full.
 *
 * @param {object} r
 * @param {'baseline'|'control'|'candidate'} r.mode
 * @param {string} r.stop - The `nextStep` outcome that ended the run, or `'completed'`.
 * @param {number} r.cycles - Websocket open/close cycles completed.
 * @param {number} r.soakMs - Quiet soak time completed after the churn.
 * @param {number} r.confirmedWedges - Maximum confirmed scratch wedges seen.
 * @param {number} r.restarts - Scratch ttyd restarts during the run.
 * @param {number} r.clientErrors - Clients that failed to connect or complete.
 * @param {number} r.withOutput - Clients that received terminal output before closing.
 * @param {boolean} [r.outputExpected=true] - False when every client was one that never reads (`noread`) and so cannot see output.
 * @param {number|null} r.lingering - Children of the scratch ttyd still present, in any state, after the quiet window; null if unread.
 * @param {boolean|null} r.ownedPtysReturned - The run's own PTYs back at baseline (`ownedPtysReturned`).
 *   The GLOBAL pool is never an input: it counts every terminal on the host,
 *   the live service's leaks included, so it is reported as a diagnostic only.
 * @param {boolean|null} r.fdsReturned
 * @param {boolean} r.cleanupOk - Every scratch process ended and was verified gone.
 * @returns {{verdict: 'reproduced'|'not-reproduced'|'pass'|'fail'|'harness-fault'|'inconclusive', why: string[]}}
 */
function verdict(r) {
  const why = [];
  if (!r.cleanupOk) why.push('cleanup did not verify: a scratch process may remain');
  if (r.stop === 'aborted-unmeasured') return { verdict: 'inconclusive', why: [...why, 'a measurement failed mid-run'] };
  if (r.stop === 'aborted-pool') return { verdict: 'inconclusive', why: [...why, 'stopped at the global PTY limit'] };
  // A run that did not exercise ttyd the way it asked proves nothing either way:
  // a candidate that refused every connection would otherwise "pass".
  if (r.clientErrors > 0) return { verdict: 'inconclusive', why: [...why, `${r.clientErrors} clients failed, so ttyd was not churned as asked`] };
  if (r.mode !== 'control' && r.outputExpected !== false && r.withOutput === 0) return { verdict: 'inconclusive', why: [...why, 'no client received terminal output'] };

  if (r.mode === 'baseline') {
    if (r.confirmedWedges >= STOP_AT_WEDGES) return { verdict: 'reproduced', why };
    return { verdict: 'not-reproduced', why: [...why, `only ${r.confirmedWedges} confirmed wedges in ${r.cycles} cycles`] };
  }
  if (r.mode === 'control') {
    if (r.confirmedWedges > 0) return { verdict: 'harness-fault', why: [...why, `${r.confirmedWedges} wedges from a command that exits cleanly`] };
    return { verdict: why.length ? 'inconclusive' : 'pass', why };
  }
  if (r.confirmedWedges > 0) why.push(`${r.confirmedWedges} confirmed wedges`);
  // A child that never exits, in ANY state, holds a PTY as surely as a wedge.
  if (r.lingering > 0) why.push(`${r.lingering} children still present after every client closed`);
  if (r.restarts > 0) why.push(`${r.restarts} restarts`);
  if (r.ownedPtysReturned === false) why.push('the run\'s own PTYs did not return to baseline');
  if (r.fdsReturned === false) why.push('ttyd\'s fd count did not return to baseline');
  if (why.length) return { verdict: 'fail', why };
  const short = [];
  if (r.cycles < ACCEPT_CYCLES) short.push(`${r.cycles} of ${ACCEPT_CYCLES} cycles`);
  if (r.soakMs < ACCEPT_SOAK_MS) short.push(`${Math.round(r.soakMs / 60000)} of ${ACCEPT_SOAK_MS / 60000} soak minutes`);
  if (r.ownedPtysReturned === null || r.fdsReturned === null || r.lingering === null) short.push('resource return was not measured');
  if (short.length) return { verdict: 'inconclusive', why: short };
  return { verdict: 'pass', why };
}

module.exports = {
  checkPreflight,
  countWedges,
  parseProcTable,
  descendantsOf,
  ProcessLedger,
  parseLsofPtys,
  ownedPtysReturned,
  lsofOutput,
  lsofReportedPids,
  nextStep,
  LifetimeTracker,
  percentiles,
  returned,
  verdict,
  MAX_CONCURRENCY,
  STOP_AT_WEDGES,
  STOP_AT_POOL_RATIO,
  PREFLIGHT_MAX_POOL_RATIO,
  WEDGE_FLOOR_MS,
  ACCEPT_CYCLES,
  ACCEPT_SOAK_MS,
  RETURN_WINDOW_MS,
  FD_TOLERANCE,
  CLOSE_MODES
};
