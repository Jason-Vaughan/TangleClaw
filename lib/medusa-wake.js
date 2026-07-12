'use strict';

/**
 * Medusa wake-nudge monitor (MED-2K9P v2 Slice 1, chunk T2) — the idle-gated
 * inbox-watcher.
 *
 * An idle LLM session is free but not self-triggering: it won't *notice* an
 * inbound Medusa message on its own (switchboard-v2-design.md §4). This
 * monitor supplies the one mechanical primitive the plumbing must add — when a
 * session with a live listener has fresh inbound mail, it types a minimal,
 * fixed nudge line into the session's tmux pane so the agent spends a turn
 * reading its inbox via TC's existing API. Everything else (drain, act, reply)
 * is the agent + the consumer contract; the boundary stays crisp.
 *
 * Safety properties (each one is load-bearing):
 *
 * 1. **Idle-gated — a busy turn is never interrupted.** The T2 spike
 *    (2026-07-11, live probe over 4 sessions) found Claude Code's status line
 *    carries a deterministic busy marker: `esc to interrupt` is present iff a
 *    turn is in flight — strictly more truthful than the 3-line output-age
 *    heuristic in `sessions.detectIdle` (a long quiet tool call reads
 *    false-idle under output-age alone). A pane is judged idle only when BOTH
 *    the busy marker is absent AND a bare `❯` input-prompt line is present
 *    (a pending permission dialog replaces the bare prompt with `❯ 1. Yes`
 *    option rows, so requiring a BARE prompt line also refuses to type into a
 *    dialog — where injected text could answer it — or over an operator's
 *    half-typed input). Two consecutive idle ticks are required (debounce
 *    against capture races at turn boundaries).
 * 2. **Zero attacker-controlled bytes.** The nudge is a fixed template — the
 *    inbound message text is NEVER typed into the pane (cross-session text
 *    typed into a terminal is an injection surface; the agent fetches it over
 *    HTTP instead, where it's data, not keystrokes).
 * 3. **One nudge per fresh-mail edge.** A per-session watermark (the newest
 *    inbox message key at last nudge) re-arms only on a genuinely new arrival,
 *    so an unhandled backlog never re-fires a nudge loop; a burst that piled
 *    up while busy drains FIFO on the single wake (the agent GETs the whole
 *    inbox). When the inbox goes read (`unread === 0`), the watermark advances
 *    silently so only future arrivals nudge.
 * 4. **Opt-in, per project.** Gated on the `medusaWake` project preference
 *    (default OFF): a wake spends a real turn (tokens/money), which v1's
 *    passive badge never did — upgrading TC must not change what an inbound
 *    message costs without the operator choosing it. Requires the listener
 *    already `listening` (i.e. `medusaEnabled`/banner opt-in) on top.
 * 5. **Claude/tmux only (Slice 1).** The idle signature is Claude Code's TUI;
 *    other engines and webui/gateway sessions are skipped (injection is
 *    unsupported for webui; other engines are a later slice). Skips are
 *    logged once per session, never silent.
 *
 * Lifecycle mirrors the other boot-time monitors (`wrap-sentinel`,
 * `tunnel-monitor`): `start()` arms a `setInterval` tick wired in `server.js`;
 * `stop()` clears it. All state is in-memory — a TC restart re-baselines (an
 * un-nudged backlog nudges again on the first post-restart idle tick, which is
 * at-most-once-late, never lost, because the inbox itself is the source).
 */

const { createLogger } = require('./logger');

const log = createLogger('medusa-wake');

const DEFAULT_INTERVAL_MS = 5000;
/** Consecutive idle ticks required before injecting (capture-race debounce). */
const IDLE_TICKS_REQUIRED = 2;
/** Pane tail depth — enough to see the input box + status line. */
const TMUX_TAIL_LINES = 15;
/** Claude Code's in-flight-turn marker (T2 spike finding — see header). */
const BUSY_MARKER = 'esc to interrupt';
/** A bare input-prompt line: `❯` alone (whitespace-padded), no dialog row. */
const BARE_PROMPT_RE = /^\s*❯\s*$/;

// CSI escape sequences + bare CR (same construction as wrap-sentinel.js:
// explicit unicode escapes, newlines preserved so line structure survives).
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp('\\u001b\\[[0-9;:?]*[ -/]*[@-~]|\\u001b[()][AB0-2]|\\r', 'g');

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/**
 * Per-session monitor state.
 * @type {Map<number, {idleTicks: number, lastNudgedKey: string|null, skipLogged: boolean, configWarnLogged: boolean}>}
 */
const _sessions = new Map();

/**
 * Strip ANSI escape sequences (and CR), preserving newlines.
 * @param {string} text - Raw pane text.
 * @returns {string} Plain text.
 */
function _strip(text) {
  return String(text == null ? '' : text).replace(ANSI_RE, '');
}

/**
 * Judge a captured pane tail: is the session safe to type into right now?
 *
 * Pure — the whole idle policy lives here so tests can pin it byte-for-byte.
 * @param {string[]} lines - Pane tail lines (raw, may carry ANSI).
 * @returns {{idle: boolean, reason: string}} `idle` true only when the busy
 *   marker is absent AND a bare `❯` prompt line is present; `reason` is one of
 *   `turn-in-flight` | `no-bare-prompt` | `at-prompt`.
 */
function _assessPane(lines) {
  const text = _strip((lines || []).join('\n'));
  if (text.includes(BUSY_MARKER)) return { idle: false, reason: 'turn-in-flight' };
  const hasBarePrompt = text.split('\n').some((l) => BARE_PROMPT_RE.test(l));
  if (!hasBarePrompt) return { idle: false, reason: 'no-bare-prompt' };
  return { idle: true, reason: 'at-prompt' };
}

/**
 * Identity key of the newest inbox message, for the nudge watermark. Prefers
 * the Bridge's `messageId`/`id`; falls back to a length-stamped key so a
 * missing id still advances the watermark on new arrivals.
 * @param {Array<object>} inbox - The session's inbox (oldest first).
 * @returns {string|null} Key of the newest message, or null when empty.
 */
function _newestKey(inbox) {
  if (!inbox || inbox.length === 0) return null;
  const last = inbox[inbox.length - 1];
  const id = last && (last.messageId != null ? last.messageId : last.id);
  return id != null ? String(id) : `len:${inbox.length}`;
}

/**
 * Build the fixed nudge line for a project. Contains ONLY TC-controlled bytes
 * (safety property 2) — never message content; single line (no embedded
 * newlines — `tmux.sendKeys` sends one Enter, after the full line).
 * @param {string} projectName - The receiving session's project.
 * @param {number} unread - Unread count (informational only).
 * @returns {string} The nudge line.
 */
function _nudgeLine(projectName, unread) {
  const proj = encodeURIComponent(projectName);
  return `[TangleClaw Switchboard] You have ${unread} unread Medusa message(s). ` +
    `Fetch them from the TangleClaw API (base URL + auth are in your project guide): ` +
    `GET /api/sessions/${proj}/medusa/messages — act on them as appropriate, ` +
    `then mark them read: POST /api/sessions/${proj}/medusa/read`;
}

/**
 * Scan one live session: gate (transport → engine → pref → listener → fresh
 * mail → idle debounce), then inject the nudge and advance the watermark.
 * @param {object} session - A `store.sessions.listLiveAll()` record.
 * @returns {void}
 */
function _scanSession(session) {
  const sessionId = session.id;
  let st = _sessions.get(sessionId);
  if (!st) {
    st = { idleTicks: 0, lastNudgedKey: null, skipLogged: false, configWarnLogged: false };
    _sessions.set(sessionId, st);
  }

  // Transport + engine gates (Slice 1: Claude over tmux only). Logged once per
  // session so an unsupported-but-opted-in session is never a silent no-op.
  if (session.sessionMode === 'webui' || !session.tmuxSession || session.engineId !== 'claude') {
    if (!st.skipLogged) {
      st.skipLogged = true;
      log.info('medusa-wake: session skipped (unsupported transport/engine for Slice 1)', {
        sessionId, sessionMode: session.sessionMode, engineId: session.engineId
      });
    }
    return;
  }

  // A wrapping (or otherwise non-active) session is ending — never nudge it.
  if (session.status && session.status !== 'active') {
    st.idleTicks = 0;
    return;
  }

  const project = _internal.getProject(session.projectId);
  if (!project) { st.idleTicks = 0; return; }

  // Opt-in gate: the wake spends a turn — explicit `medusaWake: true` only.
  let projConfig;
  try {
    projConfig = _internal.loadProjectConfig(project.path);
  } catch (err) {
    // Unreadable config — treat as opted out this tick, but never silently:
    // log once per session (the module's no-silent-skip discipline).
    if (!st.configWarnLogged) {
      st.configWarnLogged = true;
      log.warn('medusa-wake: project config unreadable — treating as opted out', {
        sessionId, project: project.name, error: err.message
      });
    }
    st.idleTicks = 0;
    return;
  }
  if (!projConfig || projConfig.medusaWake !== true) { st.idleTicks = 0; return; }

  // Listener + fresh-mail gates. The two non-nudge outcomes are distinct:
  // HOLD (listener not `listening`) vs CONSUME (inbox read). The listener
  // preserves inbox/unread across a reconnect, so a tick landing in a
  // `connecting`/`error` backoff window must NOT advance the watermark — the
  // pending wake fires once the listener is back (Critic cumulative WARNING,
  // 2026-07-11). Only a genuinely-read inbox (`unread === 0`) consumes the edge.
  const status = _internal.getStatus(sessionId);
  if (status.state !== 'listening') {
    st.idleTicks = 0;
    return; // hold — watermark untouched, wake survives the reconnect window
  }
  if (status.unread === 0) {
    // Nothing pending: keep the watermark at the inbox edge so only a FUTURE
    // arrival nudges (a backlog the operator/agent already read never fires).
    st.lastNudgedKey = _newestKey(_internal.getMessages(sessionId));
    st.idleTicks = 0;
    return;
  }
  const inbox = _internal.getMessages(sessionId);
  const newest = _newestKey(inbox);
  if (newest === null || newest === st.lastNudgedKey) {
    st.idleTicks = 0; // already nudged for this edge — the agent owns it now
    return;
  }

  // Idle gate + debounce.
  let cap;
  try {
    cap = _internal.capturePane(session.tmuxSession, { lines: TMUX_TAIL_LINES });
  } catch {
    st.idleTicks = 0; // pane vanished mid-poll (session dying) — prune pass drops it
    return;
  }
  const verdict = _assessPane(cap.lines || []);
  if (!verdict.idle) {
    st.idleTicks = 0;
    return;
  }
  st.idleTicks += 1;
  if (st.idleTicks < IDLE_TICKS_REQUIRED) return;

  // Inject. Watermark advances only on a successful injection so a transient
  // tmux failure retries next tick instead of silently dropping the wake.
  const result = _internal.injectCommand(project.name, _nudgeLine(project.name, status.unread));
  st.idleTicks = 0;
  if (!result.ok) {
    log.warn('medusa-wake: nudge injection failed', { project: project.name, sessionId, error: result.error });
    return;
  }
  st.lastNudgedKey = newest;
  log.info('medusa-wake: nudged idle session about fresh inbox mail', {
    project: project.name, sessionId, unread: status.unread
  });
}

/**
 * One monitor tick: prune state for ended sessions, then scan every live one.
 * Exposed via `_internal.tick` so tests drive it deterministically.
 * @returns {void}
 */
function _tick() {
  let live;
  try {
    live = _internal.listLiveAll();
  } catch (err) {
    log.warn('medusa-wake: listLiveAll failed', { error: err.message });
    return;
  }
  const liveIds = new Set(live.map((s) => s.id));
  for (const sid of _sessions.keys()) {
    if (!liveIds.has(sid)) _sessions.delete(sid);
  }
  for (const session of live) {
    try {
      _scanSession(session);
    } catch (err) {
      log.warn('medusa-wake: scan failed', { sessionId: session.id, error: err.message });
    }
  }
}

/**
 * Start the monitor. Idempotent — a second call while running is a no-op.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=5000] - Tick cadence.
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  _timer = setInterval(() => {
    try {
      _tick();
    } catch (err) {
      log.warn('medusa-wake: tick error', { error: err.message });
    }
  }, intervalMs);
  if (_timer.unref) _timer.unref(); // never hold the event loop open
  log.info('medusa-wake monitor started', { intervalMs });
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
}

/** Injectable seams (lazy requires mirror wrap-sentinel — no require cycles). */
const _internal = {
  listLiveAll: () => require('./store').sessions.listLiveAll(),
  getProject: (projectId) => require('./store').projects.get(projectId),
  loadProjectConfig: (projectPath) => require('./store').projectConfig.load(projectPath),
  getStatus: (sessionId) => require('./medusa').getStatus(sessionId),
  getMessages: (sessionId) => require('./medusa').getMessages(sessionId),
  capturePane: (session, options) => require('./tmux').capturePane(session, options),
  injectCommand: (projectName, command) => require('./sessions').injectCommand(projectName, command),
  tick: _tick
};

module.exports = {
  start,
  stop,
  BUSY_MARKER,
  IDLE_TICKS_REQUIRED,
  _assessPane,
  _nudgeLine,
  _internal
};
