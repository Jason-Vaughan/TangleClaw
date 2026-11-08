'use strict';

/**
 * Engine health probing and crash/failover detection (#109).
 *
 * A session's engine (Claude Code, Codex, Antigravity, Aider — anything
 * driven through a tmux pane — or an OpenClaw `webui`-mode session, probed
 * over HTTP) can crash or hang mid-session. This module answers one
 * question per probe — HEALTHY, DEGRADED, or CRASHED — and keeps just
 * enough per-session state (a consecutive-failure strike count and the
 * last terminal output successfully captured) to answer it honestly:
 *
 *   - A tmux pane that answered and says the session is gone is a real
 *     CRASHED, immediately — `lib/tmux.js#probeSession`'s `answered: true,
 *     live: false` already distinguishes this from a probe tmux itself
 *     could not complete.
 *   - A probe that tmux could not complete (`answered: false`, e.g. a
 *     wedged tmux server) or a webui healthcheck that failed to respond is
 *     DEGRADED on its own; three consecutive strikes promote it to CRASHED
 *     — the issue's own "unresponsive 3 times in a row" rule. A single
 *     blip never flips the modal on.
 *   - `suppressProbe: true` (the session's own `longRunningTask` flag)
 *     short-circuits to HEALTHY before any of the above runs, so a 20-minute
 *     silent test run is never mistaken for a hang.
 *
 * This module does not read or write `store` itself, and does not know
 * about HTTP, routes, or the modal — `lib/routes/engine-health-routes.js`
 * (pending a naming decision on the dispatch's collision with the existing,
 * unrelated `lib/routes/engines-canary.js` — flagged to TC-Lane-PM before
 * this file was written) owns wiring a session's stored engine/mode to the
 * right probe here, and the UI.
 *
 * @module lib/engine-health
 */

const tmux = require('./tmux');

/** The three states a probe (or a run of them) resolves to. */
const STATES = { HEALTHY: 'HEALTHY', DEGRADED: 'DEGRADED', CRASHED: 'CRASHED' };

/** Default probe interval, in ms — the issue's own number. Configurable per call. */
const DEFAULT_PROBE_INTERVAL_MS = 30000;

/** Consecutive unresponsive probes before DEGRADED is promoted to CRASHED. */
const UNRESPONSIVE_STRIKES_FOR_CRASHED = 3;

/** How many trailing terminal lines a handoff prime carries. */
const HANDOFF_TAIL_LINES = 50;

/**
 * Probe a tmux-backed session once.
 *
 * @param {string} sessionName - The tmux session name.
 * @param {object} [options] - Passed through to `tmux.probeSession`/`capturePane` (e.g. `timeout`).
 * @returns {{answered: boolean, live: boolean, cause: string|null, lines: string[]|null}}
 *   `lines` is the last `HANDOFF_TAIL_LINES` of pane output when the probe found the
 *   session live and could capture it; `null` otherwise (nothing to cache this round).
 */
function probeTmuxEngine(sessionName, options = {}) {
  const probe = tmux.probeSession(sessionName, options);
  if (!probe.answered) {
    return { answered: false, live: false, cause: probe.cause, lines: null };
  }
  if (!probe.live) {
    return { answered: true, live: false, cause: null, lines: null };
  }
  let lines = null;
  try {
    lines = tmux.capturePane(sessionName, { lines: HANDOFF_TAIL_LINES }).lines;
  } catch {
    // The pane existed a moment ago (`hasSession` just said so) but capture
    // can still race a session ending between the two calls. Not fatal to
    // this probe — the session is still reported live, just with no fresh
    // capture to cache this round.
  }
  return { answered: true, live: true, cause: null, lines };
}

/**
 * Probe a `webui`-mode session's engine over its HTTP healthcheck.
 *
 * @param {string} healthcheckUrl - The engine's healthcheck endpoint.
 * @param {object} [options] - Options.
 * @param {Function} [options.fetchImpl] - Injectable fetch, for tests. Defaults to the global `fetch`.
 * @param {number} [options.timeoutMs] - Abort the request after this many ms. Default 5000.
 * @returns {Promise<{answered: boolean, live: boolean, cause: string|null}>}
 *   `answered: false` means the request itself failed (network error, timeout, non-2xx) —
 *   the webui equivalent of a tmux probe tmux could not complete. There is no tmux-style
 *   "answered: true, live: false": an HTTP healthcheck that responds at all IS the engine
 *   answering, so a reachable-but-unhealthy engine is a product the engine itself would
 *   have to express (a non-2xx status), which this function already treats as unanswered.
 */
async function probeWebuiEngine(healthcheckUrl, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(healthcheckUrl, { signal: controller.signal });
    if (!res || !res.ok) {
      return { answered: false, live: false, cause: res ? `http-${res.status}` : 'no-response' };
    }
    return { answered: true, live: true, cause: null };
  } catch (err) {
    const cause = err && err.name === 'AbortError' ? 'timed-out' : (err && err.message) || 'request-failed';
    return { answered: false, live: false, cause };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a fresh, empty per-session health tracker.
 *
 * Holds exactly what honest classification needs across calls: a strike count
 * (consecutive unanswered/failed probes) and the last terminal output a probe
 * actually captured, per session id. Nothing here is persisted — a process
 * restart starts every session's health history over, which is correct: a
 * strike count from before a restart does not describe the engine running now.
 *
 * @returns {Map<string, {strikes: number, lastLines: string[]|null}>}
 */
function createHealthTracker() {
  return new Map();
}

/**
 * Fold one probe result into a session's tracked state and return the
 * resolved classification.
 *
 * @param {Map<string, {strikes: number, lastLines: string[]|null}>} tracker - From `createHealthTracker`.
 * @param {string} sessionId - The session this probe was for.
 * @param {{answered: boolean, live: boolean, cause: string|null, lines?: string[]|null}} probeResult -
 *   From `probeTmuxEngine` or `probeWebuiEngine`.
 * @param {object} [options] - Options.
 * @param {boolean} [options.suppressProbe] - The session's own `longRunningTask` flag. When true,
 *   this probe is ignored entirely — strikes neither accrue nor reset — and HEALTHY is reported
 *   regardless of `probeResult`, so a silent test run never trips the 3-strike promotion while
 *   suppressed, and resumes from wherever its strike count actually was once suppression lifts.
 * @returns {{state: string, strikes: number, reason: string|null}}
 */
function recordProbeResult(tracker, sessionId, probeResult, options = {}) {
  const entry = tracker.get(sessionId) || { strikes: 0, lastLines: null };
  if (options.suppressProbe) {
    tracker.set(sessionId, entry);
    return { state: STATES.HEALTHY, strikes: entry.strikes, reason: null };
  }

  if (probeResult.answered && !probeResult.live) {
    // tmux itself said the session is gone: a real crash, immediately — no
    // strike count needed, the same way `probeSession`'s own doc says a
    // confirmed negative is a fact, not a guess to average over three tries.
    entry.strikes = 0;
    tracker.set(sessionId, entry);
    return { state: STATES.CRASHED, strikes: 0, reason: probeResult.cause || 'session-gone' };
  }

  if (probeResult.answered && probeResult.live) {
    entry.strikes = 0;
    if (probeResult.lines) entry.lastLines = probeResult.lines;
    tracker.set(sessionId, entry);
    return { state: STATES.HEALTHY, strikes: 0, reason: null };
  }

  // Not answered: an unresponsive probe, counted toward the 3-strike promotion.
  entry.strikes += 1;
  tracker.set(sessionId, entry);
  if (entry.strikes >= UNRESPONSIVE_STRIKES_FOR_CRASHED) {
    return { state: STATES.CRASHED, strikes: entry.strikes, reason: probeResult.cause || 'unresponsive' };
  }
  return { state: STATES.DEGRADED, strikes: entry.strikes, reason: probeResult.cause || 'unresponsive' };
}

/**
 * The last terminal output this tracker captured for a session, if any —
 * what a handoff prime quotes when the session has since gone CRASHED and
 * there is nothing left to capture from.
 *
 * @param {Map<string, {strikes: number, lastLines: string[]|null}>} tracker - From `createHealthTracker`.
 * @param {string} sessionId - The session to read.
 * @returns {string[]|null}
 */
function lastKnownLines(tracker, sessionId) {
  const entry = tracker.get(sessionId);
  return entry ? entry.lastLines : null;
}

/**
 * Build the context-handoff prime string a newly-launched engine receives
 * after a user-confirmed swap, per the issue's own template.
 *
 * @param {object} params - Parameters.
 * @param {string} params.previousEngine - The engine id that crashed.
 * @param {string} params.crashedAt - ISO timestamp of the crash.
 * @param {string} [params.lastAction] - A short description of what the session was doing.
 * @param {string[]} [params.lastTerminalLines] - Trailing terminal output, already capped
 *   to `HANDOFF_TAIL_LINES` by the caller (this function does not re-slice it).
 * @returns {string}
 */
function buildFailoverHandoffPrime(params) {
  const { previousEngine, crashedAt, lastAction, lastTerminalLines } = params;
  const lines = [
    `Previous session was using ${previousEngine}, ended unexpectedly at ${crashedAt}.`
  ];
  if (lastAction) lines.push(`Last action: ${lastAction}`);
  if (lastTerminalLines && lastTerminalLines.length > 0) {
    lines.push('Last terminal output:', ...lastTerminalLines);
  }
  lines.push('Continue the work, or wait for user direction.');
  return lines.join('\n');
}

/**
 * Record one crash telemetry entry. Kept in-memory per process, newest
 * first — this is a running-session diagnostic surface ("Claude Code
 * crashes 30% of the time on long sessions"), not a durable audit log, so
 * it does not survive a restart and is not written through `store`.
 *
 * @param {Array<object>} log - The telemetry list to append to (caller owns its lifetime).
 * @param {object} entry - Entry fields.
 * @param {string} entry.engine - The engine id that crashed.
 * @param {number} entry.durationMs - How long the session ran before crashing.
 * @param {string} [entry.lastAction] - What the session was doing.
 * @param {string} entry.crashedAt - ISO timestamp of the crash.
 * @param {string} entry.reason - The probe cause that triggered CRASHED.
 * @returns {void}
 */
function recordCrashTelemetry(log, entry) {
  log.unshift({
    engine: entry.engine,
    durationMs: entry.durationMs,
    lastAction: entry.lastAction || null,
    crashedAt: entry.crashedAt,
    reason: entry.reason
  });
}

module.exports = {
  STATES,
  DEFAULT_PROBE_INTERVAL_MS,
  UNRESPONSIVE_STRIKES_FOR_CRASHED,
  HANDOFF_TAIL_LINES,
  probeTmuxEngine,
  probeWebuiEngine,
  createHealthTracker,
  recordProbeResult,
  lastKnownLines,
  buildFailoverHandoffPrime,
  recordCrashTelemetry
};
