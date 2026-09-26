'use strict';

/**
 * The bounded background activity observer (#1912, ADR 0020 §5): the only
 * source of a lane's `engine` block in the fleet read.
 *
 * It exists because nothing else observes the fleet. The wake monitor stops
 * for a session at no-mail, before any pane is looked at, so most lanes would
 * never be observed; and the per-request status route captures a pane
 * synchronously, which a fleet read must never do. This module runs on its
 * own clock, independent of inbox state, and keeps one in-memory record per
 * live session that every reader shares.
 *
 * The budget is the contract:
 * - one tick every {@link TICK_MS};
 * - captures run serially, at most one per live session per tick, each bounded
 *   by {@link CAPTURE_TIMEOUT_MS};
 * - a tick stops starting captures once {@link TICK_BUDGET_MS} has elapsed, and
 *   the next tick resumes where it stopped (round-robin), so no session
 *   starves;
 * - an observation older than {@link FRESH_MS} reads as `unknown`.
 *
 * Captures are asynchronous (`execFile`), unlike `lib/tmux.js`, whose helpers
 * run through `execSync`. A synchronous capture would stall the whole server's
 * event loop for its duration, up to the full tick budget every tick.
 *
 * Classification reuses the wake monitor's pane assessment
 * (`assessSessionIdle`, which applies `_assessActivity`, the empty-composer
 * check and the pane-digest stability rule), so there is one definition of
 * "at rest". The observer asks the strictest form of it: typeable, two
 * consecutive stable observations. Output idleness alone never yields
 * `at-rest`.
 *
 * It reads engine activity only. It never derives workload or clearance from
 * pane text (ADR 0020 §8), and nothing it produces can assert availability:
 * the composition may only use it to downgrade.
 *
 * @module lib/activity-observer
 */

const { execFile } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('activity-observer');

/** Tick period. */
const TICK_MS = 10000;
/** Per-capture deadline, covering every tmux call a capture makes. */
const CAPTURE_TIMEOUT_MS = 1000;
/** Wall time after which a tick starts no further capture. */
const TICK_BUDGET_MS = 3000;
/** An observation older than this reads as `unknown`. */
const FRESH_MS = 30000;
/** Consecutive stable observations required for `at-rest`. */
const AT_REST_OBSERVATIONS = 2;
/** Lines of pane tail a capture reads (the wake monitor's own window). */
const TAIL_LINES = 15;

/** Engine activity values (ADR 0020 §5). */
const ACTIVITY = Object.freeze({
  BUSY: 'busy',
  AT_REST: 'at-rest',
  NOT_AT_REST: 'not-at-rest',
  UNKNOWN: 'unknown'
});

/**
 * Assessment reasons that mean the engine is doing something: a turn in flight
 * (the busy marker, or the pane still writing) or running agents (ADR 0020 §5).
 * Every other refusal means only that rest is not established: a filled
 * composer, a dialog, a first unconfirmed observation, and a missing at-rest
 * marker (`not-at-rest`), which a permission prompt, a menu or a resting Codex
 * pane also produce.
 */
const { ACTIVITY_REASONS } = require('./medusa-wake');
const BUSY_REASONS = new Set([
  ACTIVITY_REASONS.TURN_IN_FLIGHT, ACTIVITY_REASONS.AGENTS_RUNNING, ACTIVITY_REASONS.PANE_WRITING
]);

/**
 * Run one tmux command asynchronously with a deadline.
 * @param {string[]} args - tmux arguments
 * @param {number} timeoutMs - Deadline for this call
 * @returns {Promise<string>} stdout
 */
function _tmux(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: Math.max(1, timeoutMs), encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        reject(Object.assign(err, { tcTimedOut: err.killed === true || err.signal === 'SIGTERM' }));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Capture a pane's tail and cursor asynchronously, inside one overall deadline.
 * Checks the session exists first: `display-message` otherwise answers for
 * whatever client is attached, which would observe the wrong pane.
 * @param {string} tmuxSession - Session name
 * @param {number} [timeoutMs] - Overall deadline
 * @returns {Promise<{lines: string[], cursor: ({x: number, y: number, line: string}|null)}>}
 */
async function captureAsync(tmuxSession, timeoutMs = CAPTURE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw Object.assign(new Error('capture deadline passed'), { tcTimedOut: true });
    return ms;
  };
  const target = `=${tmuxSession}:`;
  await _tmux(['has-session', '-t', `=${tmuxSession}`], left());
  const meta = (await _tmux(['display-message', '-p', '-t', target, '#{alternate_on},#{cursor_x},#{cursor_y}'], left())).trim();
  const [alt, rawX, rawY] = meta.split(',');
  const captureArgs = alt === '1'
    ? ['capture-pane', '-p', '-t', target]
    : ['capture-pane', '-p', '-t', target, '-S', String(-TAIL_LINES)];
  const lines = (await _tmux(captureArgs, left())).split('\n');
  const x = Number.parseInt(rawX, 10);
  const y = Number.parseInt(rawY, 10);
  let cursor = null;
  if (Number.isInteger(x) && Number.isInteger(y)) {
    const line = await _tmux(['capture-pane', '-e', '-p', '-t', target, '-S', String(y), '-E', String(y)], left());
    cursor = { x, y, line: line.replace(/\n$/, '') };
  }
  return { lines, cursor };
}

/**
 * The default dependencies: the live store, the wake profiles and real tmux.
 * Required lazily so this module loads before `store.init()`.
 * @returns {{listSessions: function(): object[], profileFor: function(string): (object|null), capture: function(string, number): Promise<object>, assess: function(object): object, now: function(): number}}
 */
function defaultDeps() {
  return {
    listSessions: () => require('./store').sessions.listLiveAll(),
    profileFor: (engineId) => require('./medusa-wake').ENGINE_WAKE_PROFILES[engineId] || null,
    capture: captureAsync,
    assess: (opts) => require('./medusa-wake').assessSessionIdle(opts),
    now: () => Date.now()
  };
}

/**
 * Create an observer. `server.js` owns the one live instance; tests make
 * their own with injected dependencies.
 * @param {object} [overrides] - Replacement dependencies (see {@link defaultDeps})
 * @returns {{tick: function(): Promise<object>, get: function(number, number=): object, start: function(): void, stop: function(): void, stats: function(): object}}
 */
function createObserver(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  /** @type {Map<number, {activity: string, reason: string, observedAt: number, digest: (string|undefined), idleTicks: number}>} */
  const records = new Map();
  let nextIndex = 0;
  let timer = null;
  let running = false;
  const measured = { ticks: 0, lastTickMs: 0, maxCaptureMs: 0, lastCaptureMs: 0, captures: 0, skippedForBudget: 0 };

  /**
   * Observe one session and store its record.
   * @param {object} session - A live session row (`id`, `engineId`, `tmuxSession`, `sessionMode`)
   * @param {number} timeoutMs - This capture's deadline: the per-capture limit or what is left of the tick
   * @returns {Promise<void>}
   */
  async function observe(session, timeoutMs) {
    const now = deps.now();
    const prev = records.get(session.id);
    const profile = deps.profileFor(session.engineId);
    if (!profile || (session.sessionMode && session.sessionMode !== 'tmux') || !session.tmuxSession) {
      const reason = !profile ? 'no-wake-profile' : 'not-a-tmux-pane';
      records.set(session.id, { activity: ACTIVITY.UNKNOWN, reason, observedAt: now, digest: undefined, idleTicks: 0 });
      return;
    }
    const started = deps.now();
    let cap;
    try {
      cap = await deps.capture(session.tmuxSession, timeoutMs);
    } catch (err) {
      const reason = err && err.tcTimedOut ? 'capture-timeout' : 'capture-failed';
      // Logged when a session starts failing, not on every tick: a tmux that
      // cannot run would otherwise leave every lane "engine unknown" in silence.
      if (!prev || prev.reason !== reason) {
        log.warn('activity observer could not capture a pane', { sessionId: session.id, reason, error: err && err.message });
      }
      records.set(session.id, { activity: ACTIVITY.UNKNOWN, reason, observedAt: deps.now(), digest: undefined, idleTicks: 0 });
      return;
    } finally {
      const took = deps.now() - started;
      measured.captures += 1;
      measured.lastCaptureMs = took;
      measured.maxCaptureMs = Math.max(measured.maxCaptureMs, took);
    }
    if (prev && (prev.reason === 'capture-timeout' || prev.reason === 'capture-failed')) {
      log.info('activity observer capturing a pane again', { sessionId: session.id });
    }
    const verdict = deps.assess({
      lines: cap.lines || [],
      profile,
      cursor: cap.cursor === undefined ? null : cap.cursor,
      prevDigest: prev ? prev.digest : undefined,
      idleTicks: prev ? prev.idleTicks : 0,
      ticksRequired: AT_REST_OBSERVATIONS,
      mustBeTypeable: true
    });
    let activity;
    if (verdict.idle) activity = ACTIVITY.AT_REST;
    else if (BUSY_REASONS.has(verdict.reason)) activity = ACTIVITY.BUSY;
    else activity = ACTIVITY.NOT_AT_REST;
    records.set(session.id, {
      activity,
      reason: verdict.idle ? 'at-rest' : verdict.reason,
      observedAt: deps.now(),
      digest: verdict.digest,
      idleTicks: verdict.idleTicks
    });
  }

  /**
   * One tick: observe live sessions round-robin until the budget is spent,
   * and forget sessions that are no longer live.
   * @returns {Promise<{observed: number[], skipped: number[]}>}
   */
  async function tick() {
    const start = deps.now();
    const sessions = deps.listSessions().slice().sort((a, b) => a.id - b.id);
    const liveIds = new Set(sessions.map((s) => s.id));
    for (const id of records.keys()) if (!liveIds.has(id)) records.delete(id);

    const observed = [];
    const skipped = [];
    const n = sessions.length;
    if (n === 0) return { observed, skipped };
    const first = nextIndex % n;
    let i = 0;
    for (; i < n; i++) {
      const remaining = TICK_BUDGET_MS - (deps.now() - start);
      if (remaining <= 0) break;
      const session = sessions[(first + i) % n];
      // Never longer than what is left of the tick, so a capture started late
      // cannot carry the tick past its budget.
      try {
        await observe(session, Math.min(CAPTURE_TIMEOUT_MS, remaining));
      } catch (err) { // prawduct:allow prawduct/broad-except -- one session's failed assessment must not end the tick for every session after it; that session reads unknown and the rotation advances
        log.warn('activity observer could not assess a pane', { sessionId: session.id, error: err && err.message });
        records.set(session.id, { activity: ACTIVITY.UNKNOWN, reason: 'assess-failed', observedAt: deps.now(), digest: undefined, idleTicks: 0 });
      }
      observed.push(session.id);
    }
    for (let k = i; k < n; k++) skipped.push(sessions[(first + k) % n].id);
    nextIndex = (first + i) % n;
    measured.ticks += 1;
    measured.lastTickMs = deps.now() - start;
    measured.skippedForBudget += skipped.length;
    return { observed, skipped };
  }

  /**
   * A lane's engine block, as the fleet read reports it. An observation past
   * the freshness window reads as `unknown`, and a session never observed is
   * `unknown` too.
   * @param {number} sessionId - Session id
   * @param {number} [nowMs] - Clock (defaults to the observer's)
   * @returns {{activity: string, reason: string, observedAt: (string|null), ageSeconds: (number|null), provenance: string}}
   */
  function get(sessionId, nowMs = deps.now()) {
    const r = records.get(sessionId);
    if (!r) {
      return { activity: ACTIVITY.UNKNOWN, reason: 'not-observed', observedAt: null, ageSeconds: null, provenance: 'engine-observed' };
    }
    const age = nowMs - r.observedAt;
    const stale = age > FRESH_MS;
    return {
      activity: stale ? ACTIVITY.UNKNOWN : r.activity,
      reason: stale ? 'stale-observation' : r.reason,
      observedAt: new Date(r.observedAt).toISOString(),
      ageSeconds: Math.max(0, Math.round(age / 1000)),
      provenance: 'engine-observed'
    };
  }

  /**
   * Start ticking. A tick still running when the next is due is not
   * overlapped: the late tick is skipped, so the observer never runs two
   * capture loops at once.
   * @returns {void}
   */
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      tick()
        .catch((err) => log.warn('activity observer tick failed', { error: err.message })) // prawduct:allow prawduct/broad-except -- a background loop must survive one bad tick; the next tick re-observes
        .finally(() => { running = false; });
    }, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Stop ticking and forget every record.
   * @returns {void}
   */
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    records.clear();
  }

  /**
   * Measurements for the budget: tick and capture durations, and how many
   * sessions a tick had to leave for the next.
   * @returns {object}
   */
  function stats() {
    return { ...measured, tracked: records.size };
  }

  return { tick, get, start, stop, stats };
}

module.exports = {
  TICK_MS,
  CAPTURE_TIMEOUT_MS,
  TICK_BUDGET_MS,
  FRESH_MS,
  AT_REST_OBSERVATIONS,
  ACTIVITY,
  BUSY_REASONS,
  captureAsync,
  createObserver
};
