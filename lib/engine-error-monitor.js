'use strict';

/**
 * Engine-error pane monitor: the one periodic read of every live tmux
 * session's pane tail, which feeds engine API error detection
 * (`lib/engine-errors.js`, #261).
 *
 * Nothing read here can start, request or open a wrap (#2027). Pane text is
 * not a trustworthy request channel, because anything that can print into a
 * pane can print anything: the engine quoting a document, a tool's output, a
 * relayed Medusa message. The wrap drawer opens only from the explicit Wrap
 * button, and the governed headless path (`tc finalize`) is an authenticated
 * API call.
 *
 * Only tmux sessions are read: engine-error patterns apply to pane text, and a
 * webui (ClawBridge gateway) session has no pane.
 *
 * Lifecycle mirrors the other boot-time monitors (`tunnel-monitor`,
 * `ttyd-watcher`): `start()` arms a `setInterval` tick wired in `server.js`;
 * `stop()` clears it. All state is in-memory; a restart re-reads every pane on
 * its first tick and re-detects an error still on screen.
 */

const { createLogger } = require('./logger');
const engineErrors = require('./engine-errors');

const log = createLogger('engine-error-monitor');

const DEFAULT_INTERVAL_MS = 4000;
const TMUX_TAIL_LINES = 80;

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/** Session ids seen on the previous tick, so an ended session's state is forgotten. @type {Set<number>} */
const _seen = new Set();

/**
 * Engine profiles resolved during the current tick, keyed by engine id.
 * `store.engines.get` reads and parses the profile file on every call, so
 * without this a fleet of N sessions on one engine read it N times per tick.
 * Cleared at the top of every tick so an edited profile is seen on the next.
 * A failed load is remembered as `null` for the tick, so one malformed file
 * is reported once rather than once per session.
 * @type {Map<string, object|null>}
 */
const _profileCache = new Map();

/**
 * The engine profile for `engineId`, read at most once per tick. A profile
 * that cannot be loaded (missing, malformed JSON) answers `null` and is
 * logged, so the scan that asked keeps running.
 * @param {string|null|undefined} engineId - The session's engine id.
 * @returns {object|null}
 */
function _profileFor(engineId) {
  if (!engineId) return null;
  if (_profileCache.has(engineId)) return _profileCache.get(engineId);
  let profile = null;
  try {
    profile = _internal.getEngineProfile(engineId) || null;
  } catch (err) {
    log.warn('engine profile unreadable — error detection off for this tick', { engine: engineId, error: err.message });
  }
  _profileCache.set(engineId, profile);
  return profile;
}

/**
 * Read one live tmux session's pane tail and hand it to engine-error detection.
 * @param {object} session - A `store.sessions.listLiveAll()` record
 * @returns {void}
 */
function _scanSession(session) {
  if (session.sessionMode === 'webui' || !session.tmuxSession) return;
  let cap;
  try {
    cap = _internal.capturePane(session.tmuxSession, { lines: TMUX_TAIL_LINES });
  } catch {
    // Pane vanished mid-poll (session dying); the next tick's prune drops it.
    return;
  }
  _internal.observeEngineErrors(session, cap.lines || [], _profileFor(session.engineId));
}

/**
 * One monitor tick: forget ended sessions, then scan every live one.
 * Exposed via `_internal.tick` so tests drive it deterministically.
 * @returns {Promise<void>}
 */
async function _tick() {
  _profileCache.clear();
  let live;
  try {
    live = _internal.listLiveAll();
  } catch (err) {
    log.warn('listLiveAll failed', { error: err.message });
    return;
  }
  const liveIds = new Set(live.map((s) => s.id));
  for (const sid of _seen) {
    if (liveIds.has(sid)) continue;
    _seen.delete(sid);
    _internal.forgetEngineErrors(sid);
  }
  for (const session of live) {
    _seen.add(session.id);
    try {
      _scanSession(session);
    } catch (err) {
      log.warn('scan failed', { sessionId: session.id, engine: session.engineId, error: err.message });
    }
  }
}

/**
 * Start the monitor. Idempotent — a second call while running is a no-op.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=4000] - Tick cadence.
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  _timer = setInterval(() => {
    _tick().catch((err) => log.warn('tick error', { error: err.message }));
  }, intervalMs);
  if (_timer.unref) _timer.unref(); // never hold the event loop open
  log.info('engine-error monitor started', { intervalMs });
}

/**
 * Stop the monitor and clear all in-memory state.
 * @returns {void}
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _seen.clear();
  _profileCache.clear();
  engineErrors._reset();
}

const _internal = {
  listLiveAll: () => require('./store').sessions.listLiveAll(),
  capturePane: (session, options) => require('./tmux').capturePane(session, options),
  getEngineProfile: (engineId) => (engineId ? require('./store').engines.get(engineId) : null),
  observeEngineErrors: (session, lines, profile) => require('./engine-errors').observe(session, lines, profile),
  forgetEngineErrors: (sessionId) => require('./engine-errors').forget(sessionId),
  tick: _tick
};

module.exports = {
  start,
  stop,
  _internal
};
