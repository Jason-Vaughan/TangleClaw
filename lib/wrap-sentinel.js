'use strict';

/**
 * Wrap-sentinel monitor (CC-7 Slice C) — trigger parity for a typed "wrap".
 *
 * Goal: typing "wrap" (or "let's wrap up", "end session", …) inside a live
 * session is a second front door to the SAME wrap drawer the Wrap button opens
 * — cross-model, cross-transport, no Claude-only skill lock-in. The NL variation
 * is absorbed by the **AI** (instructed via the prime prompt): on recognizing
 * wrap intent it emits a fixed, render-safe marker — the bare token
 * `TANGLECLAW_WRAP` on a line by itself. TC's side is deterministic: it watches
 * each live session's output for that exact token and, on a fresh emission,
 * raises a per-project "wrap requested" flag. The session view's status poll
 * sees the flag and opens the wrap drawer (it does NOT auto-commit or kill —
 * the operator still reviews + confirms; the drawer is the safety).
 *
 * Why a plain token (not `<<TANGLECLAW_WRAP>>`): the CC-7 Slice B1 spike proved
 * Claude Code's TUI render mangles markdown-significant chars (`<<`, `>>`, `##`)
 * and reflows lines, but letters/digits/underscore survive verbatim — so a
 * single fixed alphanumeric token is the only form that detects reliably across
 * BOTH transports (tmux pane scrape AND the ClawBridge gateway output stream).
 *
 * False-positive discipline (the token also appears when the AI is *told* about
 * it): two independent guards keep mere mentions from tripping a wrap.
 *   1. **Standalone-word match.** Detection matches the token only as a
 *      whitespace-delimited word (`SENTINEL_RE`). The prime instruction phrases
 *      it in backticks / with a trailing period, so the instruction text never
 *      matches; a bare emission on its own line does.
 *   2. **Fresh-emission only.** Per session, the monitor establishes a baseline
 *      on first sight (gateway: start at the live cursor edge, skipping the
 *      backlog incl. the prime echo; tmux: record whether the token is already
 *      present) and flags only a later absent→present transition. It flags at
 *      most once per session (`requested`), so a lingering token never re-fires.
 *
 * Lifecycle mirrors the other boot-time monitors (`tunnel-monitor`,
 * `ttyd-watcher`): `start()` arms a `setInterval` tick wired in `server.js`;
 * `stop()` clears it. All state is in-memory and ephemeral — a restart simply
 * re-baselines every session (a pending nudge is lost, which is harmless: the
 * operator can still click Wrap, or re-type it).
 *
 * Cross-reference: `lib/wrap-steps/ai-content.js` (the B1 gateway capture path
 * shares `lib/bridge-context.js#resolveBridgeContext`).
 */

const { createLogger } = require('./logger');
const { resolveBridgeContext } = require('./bridge-context');

const log = createLogger('wrap-sentinel');

const DEFAULT_INTERVAL_MS = 4000;
/** The render-safe marker the AI emits on recognizing wrap intent. */
const SENTINEL_TOKEN = 'TANGLECLAW_WRAP';
/**
 * Match the marker ONLY as a standalone whitespace-delimited word. Prose that
 * merely mentions it — the prime phrases it as `` `TANGLECLAW_WRAP` `` or
 * `TANGLECLAW_WRAP.` — has a non-space neighbour (backtick / period) and never
 * matches; a bare emission on its own line (or space-padded by gateway reflow)
 * does.
 */
const SENTINEL_RE = /(?:^|\s)TANGLECLAW_WRAP(?:\s|$)/;
const TMUX_TAIL_LINES = 80;
const GATEWAY_MAX_EVENTS = 300;
// CSI escape sequences + bare CR, built with explicit unicode escapes so no
// raw ESC byte sits in source. Newlines are intentionally preserved so line
// structure survives for the standalone-word match; the \\u001b lead-in means
// legitimate bracketed text like "[INFO]" is never stripped.
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp('\\u001b\\[[0-9;:?]*[ -/]*[@-~]|\\u001b[()][AB0-2]|\\r', 'g');

/** @type {NodeJS.Timeout|null} */
let _timer = null;
/**
 * Per-session monitor state.
 * @type {Map<number, {armed: boolean, prevHadSentinel: boolean, cursor: number|null, requested: boolean, projectName: string|null}>}
 */
const _sessions = new Map();
/**
 * Projects with a pending (un-acked) wrap request.
 * @type {Map<string, {sessionId: number, detectedAt: number}>}
 */
const _pending = new Map();

/**
 * Strip ANSI escape sequences (and CR) so the standalone-word match sees plain
 * text. Newlines are preserved.
 * @param {string} text
 * @returns {string}
 */
function _strip(text) {
  return String(text == null ? '' : text).replace(ANSI_RE, '');
}

/**
 * True when the (ANSI-stripped) text contains the sentinel as a standalone word.
 * @param {string} text
 * @returns {boolean}
 */
function _hasSentinel(text) {
  return SENTINEL_RE.test(_strip(text));
}

/**
 * Raise the per-project wrap-request flag for a session (idempotent — flags at
 * most once per session via `st.requested`).
 * @param {object} st - The session's monitor state
 * @param {number} sessionId
 * @param {string} projectName
 * @returns {void}
 */
function _flag(st, sessionId, projectName) {
  st.requested = true;
  _pending.set(projectName, { sessionId, detectedAt: _internal.now() });
  log.info('wrap sentinel detected — drawer requested', { project: projectName, sessionId });
}

/**
 * Scan one live session for a fresh sentinel emission. Establishes a baseline
 * on first sight (never flags the backlog / prime echo), then flags a later
 * absent→present transition exactly once.
 * @param {object} session - A `store.sessions.listLiveAll()` record
 * @returns {Promise<void>}
 */
async function _scanSession(session) {
  const sessionId = session.id;
  let st = _sessions.get(sessionId);
  if (!st) {
    st = { armed: false, prevHadSentinel: false, cursor: null, requested: false, projectName: null };
    _sessions.set(sessionId, st);
  }
  if (st.requested) return; // one wrap nudge per session — already flagged

  const projectName = st.projectName || _internal.getProjectName(session.projectId);
  st.projectName = projectName;
  if (!projectName) return;

  const firstSight = !st.armed;

  if (session.sessionMode === 'webui') {
    const bridge = _internal.getBridgeContext(session, projectName);
    if (!bridge) { st.armed = true; return; } // no sidecar → can't watch this session
    if (firstSight) {
      // Baseline at the live cursor edge so the backlog (incl. the prime echo)
      // is never scanned — only genuinely new output can flag. If the bridge
      // can't give us the current cursor this tick, stay UN-armed and retry the
      // baseline next tick rather than falling back to cursor 0 — a 0 baseline
      // would scan the entire backlog and could spuriously flag a token already
      // sitting there (e.g. a pre-wrap emission after a restart re-baseline).
      const status = await _internal.getStatus(bridge);
      if (!status || !status.ok || typeof status.cursor !== 'number') return;
      st.cursor = status.cursor;
      st.armed = true;
      return;
    }
    const out = await _internal.getOutput({ ...bridge, cursor: st.cursor, maxEvents: GATEWAY_MAX_EVENTS });
    if (!out || !out.ok) return; // transient bridge hiccup — retry next tick, cursor unchanged
    const text = (out.events || [])
      .filter((e) => e && (e.kind === 'text' || e.kind === undefined))
      .map((e) => (e.text != null ? e.text : (e.data != null ? e.data : '')))
      .join('\n');
    if (typeof out.cursorEnd === 'number') st.cursor = out.cursorEnd;
    if (_hasSentinel(text)) _flag(st, sessionId, projectName); // gateway delta is new text → a hit IS fresh
    return;
  }

  // tmux transport
  if (!session.tmuxSession) { st.armed = true; return; }
  let cap;
  try {
    cap = _internal.capturePane(session.tmuxSession, { lines: TMUX_TAIL_LINES });
  } catch {
    // Pane vanished mid-poll (session dying). Arm + skip; the prune pass drops it.
    st.armed = true;
    return;
  }
  const hadSentinel = _hasSentinel((cap.lines || []).join('\n'));
  if (firstSight) {
    // Record the starting state so only a later absent→present flip flags — the
    // prime echo (if present in the tail at start) is captured here, not flagged.
    st.prevHadSentinel = hadSentinel;
    st.armed = true;
    return;
  }
  if (hadSentinel && !st.prevHadSentinel) _flag(st, sessionId, projectName);
  st.prevHadSentinel = hadSentinel;
}

/**
 * One monitor tick: prune state for ended sessions, then scan every live one.
 * Exposed via `_internal.tick` so tests drive it deterministically.
 * @returns {Promise<void>}
 */
async function _tick() {
  let live;
  try {
    live = _internal.listLiveAll();
  } catch (err) {
    log.warn('wrap-sentinel: listLiveAll failed', { error: err.message });
    return;
  }
  const liveIds = new Set(live.map((s) => s.id));

  // Prune ended sessions + drop a still-pending flag whose owning session ended
  // un-acked (a wrap nudge for a dead session is stale).
  for (const [sid, st] of _sessions) {
    if (liveIds.has(sid)) continue;
    _sessions.delete(sid);
    const pend = st.projectName && _pending.get(st.projectName);
    if (pend && pend.sessionId === sid) _pending.delete(st.projectName);
  }

  for (const session of live) {
    try {
      await _scanSession(session);
    } catch (err) {
      log.warn('wrap-sentinel: scan failed', { sessionId: session.id, error: err.message });
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
    _tick().catch((err) => log.warn('wrap-sentinel: tick error', { error: err.message }));
  }, intervalMs);
  if (_timer.unref) _timer.unref(); // never hold the event loop open
  log.info('wrap-sentinel monitor started', { intervalMs });
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
  _sessions.clear();
  _pending.clear();
}

/**
 * Whether a project has an un-acked typed-wrap request pending.
 * @param {string} projectName
 * @returns {boolean}
 */
function isWrapRequested(projectName) {
  return _pending.has(projectName);
}

/**
 * Acknowledge (clear) a project's pending wrap request — called once the
 * session view has opened the wrap drawer, so the poll won't reopen it. The
 * session's `requested` latch stays set, so the lingering token never re-fires.
 * @param {string} projectName
 * @returns {boolean} True if a pending request was cleared.
 */
function ackWrapRequest(projectName) {
  return _pending.delete(projectName);
}

const _internal = {
  listLiveAll: () => require('./store').sessions.listLiveAll(),
  getProjectName: (projectId) => {
    const p = require('./store').projects.get(projectId);
    return p ? p.name : null;
  },
  capturePane: (session, options) => require('./tmux').capturePane(session, options),
  getBridgeContext: resolveBridgeContext,
  getStatus: (opts) => require('./clawbridge').getStatus(opts),
  getOutput: (opts) => require('./clawbridge').getOutput(opts),
  now: () => Date.now(),
  tick: _tick
};

module.exports = {
  start,
  stop,
  isWrapRequested,
  ackWrapRequest,
  SENTINEL_TOKEN,
  _internal,
  _hasSentinel
};
