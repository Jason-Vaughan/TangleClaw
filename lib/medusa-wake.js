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
 *    false-idle under output-age alone). A pane is judged idle only when the
 *    engine's `busyMarker` is absent AND a bare input-prompt line matching the
 *    engine's `promptRe` is present (a pending permission dialog replaces the
 *    bare prompt with option rows — Claude's `❯ 1. Yes` — so requiring a BARE
 *    prompt line also refuses to type into a dialog, where injected text could
 *    answer it, or over an operator's half-typed input). An engine whose bare
 *    prompt PERSISTS during a turn (antigravity/Gemini-CLI keeps `>` while
 *    "Generating…", #560 live spike) also carries a positive `idleMarker` that
 *    must be present — its at-rest status hint (`? for shortcuts`), absent
 *    during both generation and any dialog/menu — so the busy-marker gate is
 *    never the only thing standing between a nudge and a busy pane. Two
 *    consecutive idle ticks are required (debounce against capture races at
 *    turn boundaries).
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
 * 5. **Profiled tmux engines only (#560 — engine-aware).** Each supported
 *    engine has an entry in `ENGINE_WAKE_PROFILES` carrying its live-probed
 *    idle/busy markers: Claude (`esc to interrupt` + bare `❯`) and antigravity/
 *    Gemini-CLI (`esc to cancel` + bare `>` + the `? for shortcuts` at-rest
 *    marker). webui/gateway sessions (no tmux pane — injection unsupported) and
 *    engines with no profile (e.g. codex, aider — no live idle signature
 *    captured yet) are skipped and logged once per session, never silent.
 *    Guessing an unprofiled engine's idle signature is exactly the false-idle
 *    hazard property 1 forbids, so an unknown engine stays off until probed.
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

/**
 * Per-engine idle/busy detection profiles (#560 — engine-aware wake). Each
 * value's markers were derived from a LIVE pane capture, never guessed — a
 * false-idle read is the core injection hazard (header, safety property 1), so
 * an engine with no live signature stays absent here (→ skipped-and-logged).
 *
 * - `busyMarker` (string): substring present iff a turn is in flight; its
 *   presence blocks a nudge. Load-bearing when the prompt persists during a turn.
 * - `promptRe` (RegExp): matches a BARE input-prompt line (no dialog/menu row,
 *   no operator half-typed text). At least one line must match for idle.
 * - `idleMarker` (string|null): a POSITIVE at-rest signal that must be present
 *   for idle. Set only for engines whose bare prompt persists during a turn
 *   (antigravity keeps `>` while "Generating…"), so the busy-marker gate is
 *   never the sole guard; also excludes dialog/menu states that drop the hint.
 *   `null` for engines (Claude) where a busy turn already hides the bare prompt.
 *
 * @type {Object<string, {busyMarker: string, promptRe: RegExp, idleMarker: (string|null)}>}
 */
const ENGINE_WAKE_PROFILES = {
  // Claude Code (T2 spike, 2026-07-11): `esc to interrupt` in the status line
  // iff busy; a busy turn hides the bare `❯`, so no positive idle marker needed.
  claude: { busyMarker: 'esc to interrupt', promptRe: /^\s*❯\s*$/, idleMarker: null },
  // antigravity / Gemini CLI (#560 spike, 2026-07-14): status flips to
  // `esc to cancel` (from `? for shortcuts`) while a spinner shows "Generating…"
  // — but the bare `>` input line is STILL rendered mid-turn, so `? for
  // shortcuts` is required as the positive at-rest signal.
  antigravity: { busyMarker: 'esc to cancel', promptRe: /^\s*>\s*$/, idleMarker: '? for shortcuts' }
};

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
 * @type {RegExp} The running-subagent-fleet indicator in a Claude Code pane's
 * status line, from the live capture in #783: `⏵⏵ bypass permissions … · ← 1 agent`.
 *
 * Deliberately broader than "a subagent currently has focus". Focus can change
 * between the capture and the paste, and only one live capture of the
 * multi-agent render exists — inferring the focused-main variant from it would
 * be the guessing this module forbids for engine markers. Refusing while ANY
 * agent runs costs a delayed nudge that the next tick retries; the failure it
 * prevents is a reviewer acting on someone else's mail mid-review.
 */
const _FLEET_RE = /←\s*\d+\s*agents?\b/;

/**
 * Judge a captured pane tail against an engine profile: is the session safe to
 * type into right now?
 *
 * Pure — the whole idle policy lives here so tests can pin it byte-for-byte.
 * Gate order (each blocks alone): busy marker present → `turn-in-flight`;
 * a running subagent fleet → `agents-running`;
 * a positive `idleMarker` required-but-absent → `not-at-rest` (covers an
 * engine whose prompt persists mid-turn, and any dialog/menu that drops the
 * at-rest hint); no bare `promptRe` line → `no-bare-prompt`; else idle.
 * @param {string[]} lines - Pane tail lines (raw, may carry ANSI).
 * @param {{busyMarker: string, promptRe: RegExp, idleMarker: (string|null)}} profile
 *   - The engine's detection profile (from `ENGINE_WAKE_PROFILES`).
 * @returns {{idle: boolean, reason: string}} `idle` true only when the busy
 *   marker is absent, any required idle marker is present, AND a bare prompt
 *   line is present; `reason` is one of
 *   `turn-in-flight` | `not-at-rest` | `no-bare-prompt` | `at-prompt`.
 */
function _assessPane(lines, profile) {
  const text = _strip((lines || []).join('\n'));
  if (text.includes(profile.busyMarker)) return { idle: false, reason: 'turn-in-flight' };
  // A running subagent fleet makes the pane unsafe to type into for two
  // independent reasons, so this gate sits above the prompt checks rather than
  // beside them (#783). First, the busy marker MOVES: with a subagent focused
  // the turn indicator lives in the agent block below the status line, so
  // `esc to interrupt` is absent and the bare prompt IS rendered — a session
  // seven minutes into a turn reads `at-prompt`, and the two-tick debounce
  // confirms the false read instead of rejecting it, because the state is
  // stable for minutes. Second, paste-buffer targets whichever view holds
  // focus, so the nudge lands in the subagent's composer — and the nudge tells
  // its reader to fetch and act on Medusa mail, which a reviewer mid-review
  // must not do.
  if (_FLEET_RE.test(text)) return { idle: false, reason: 'agents-running' };
  if (profile.idleMarker && !text.includes(profile.idleMarker)) {
    return { idle: false, reason: 'not-at-rest' };
  }
  const hasBarePrompt = text.split('\n').some((l) => profile.promptRe.test(l));
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
  return _nudgeLineFor(`/api/sessions/${encodeURIComponent(projectName)}/medusa`, unread);
}

/**
 * The nudge line for any switchboard API base — a project session's
 * `/api/sessions/:project/medusa` or the Master's `/api/master/medusa`. The
 * Master has no project name to encode, so the base is the parameter; the
 * bytes are otherwise the same fixed TC-controlled text (safety property 2).
 * @param {string} apiBase - The recipient's switchboard API base path.
 * @param {number} unread - Unread count (informational only).
 * @returns {string} The nudge line.
 */
function _nudgeLineFor(apiBase, unread) {
  return `[TangleClaw Switchboard] You have ${unread} unread Medusa message(s). ` +
    `Fetch them from the TangleClaw API (base URL + auth are in your project guide): ` +
    `GET ${apiBase}/messages — act on them as appropriate, ` +
    `then mark them read: POST ${apiBase}/read`;
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
    st = { idleTicks: 0, lastNudgedKey: null, skipLogged: false, configWarnLogged: false, lastRecorded: null };
    _sessions.set(sessionId, st);
  }

  /**
   * Record what became of the nudge for the session's current inbox edge (#792).
   *
   * Two rules keep this a ledger of EVENTS rather than of polling. First, it
   * records a transition: the monitor runs on a timer, so a row per tick would
   * bury the one moment that matters and blow through retention within an hour.
   * Second, it records only when there is mail to miss — a session with an empty
   * inbox has not been failed by anything, and rows saying so would drown the
   * ones that mean something.
   *
   * Non-throwing by design, for the same reason the rules ledger is: an audit
   * write must never be the reason a nudge does not happen.
   *
   * @param {string} outcome - One of `nudged` | `skipped` | `failed`.
   * @param {string} channel - Delivery channel, or `none` when never attempted.
   * @param {string|null} reason - Why not; required unless nudged.
   * @returns {void}
   */
  function record(outcome, channel, reason) {
    let status;
    try {
      status = _internal.getStatus(sessionId);
    } catch {
      return; // no identity, nothing to say about its mail
    }
    if (!status || status.unread === 0) return;

    let key;
    try {
      key = _newestKey(_internal.getMessages(sessionId));
    } catch {
      key = null;
    }
    if (key === null) return;

    const stamp = `${key}|${outcome}|${reason || ''}`;
    if (st.lastRecorded === stamp) return;
    st.lastRecorded = stamp;

    try {
      _internal.recordDelivery({
        sessionId,
        projectId: session.projectId ?? null,
        workspaceId: status.workspaceId || null,
        messageKey: key,
        unread: status.unread,
        channel,
        outcome,
        skipReason: reason || undefined
      });
    } catch (err) {
      log.warn('medusa-wake: failed to record a delivery outcome', {
        sessionId, outcome, error: err.message
      });
    }
  }

  // Transport + engine gates (#560 — engine-aware): a live tmux pane and a
  // known wake profile for the session's engine. webui has no pane; an
  // unprofiled engine has no live-captured idle signature to type against
  // safely. Logged once per session so an unsupported-but-opted-in session is
  // never a silent no-op.
  const profile = ENGINE_WAKE_PROFILES[session.engineId];
  if (session.sessionMode === 'webui' || !session.tmuxSession || !profile) {
    if (!st.skipLogged) {
      st.skipLogged = true;
      log.info('medusa-wake: session skipped (unsupported transport or unprofiled engine)', {
        sessionId, sessionMode: session.sessionMode, engineId: session.engineId
      });
    }
    record('skipped', 'none', session.sessionMode === 'webui' ? 'no-pane' : 'unprofiled-engine');
    return;
  }

  // A wrapping (or otherwise non-active) session is ending — never nudge it.
  if (session.status && session.status !== 'active') {
    st.idleTicks = 0;
    record('skipped', 'none', `session-${session.status}`);
    return;
  }

  // Who is being scanned decides two things and nothing else: where the opt-in
  // is read from, and how the nudge is delivered. Every gate between — listener
  // state, fresh mail, the idle verdict, the debounce — is identical, because
  // the safety property those gates protect (never type into a busy pane) does
  // not care whose pane it is.
  //
  // The Master carries its opt-in ON the record (`lib/master.js#masterWakeRecord`
  // reads it from global config) because it has no project config to load; a
  // project session's lives in its project config, read here.
  let project = null;
  let optedIn;
  if (session.isMaster) {
    optedIn = session.medusaWake === true;
  } else {
    project = _internal.getProject(session.projectId);
    if (!project) { st.idleTicks = 0; record('skipped', 'none', 'no-project'); return; }

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
      record('skipped', 'none', 'config-unreadable');
      return;
    }
    optedIn = Boolean(projConfig) && projConfig.medusaWake === true;
  }
  // The most consequential skip in the file: a session sitting on unread mail
  // that nothing will ever tell it about, because the wake is off. Silent until
  // #792, and indistinguishable from an empty inbox from anywhere outside.
  if (!optedIn) { st.idleTicks = 0; record('skipped', 'none', 'wake-not-opted-in'); return; }

  // Listener + fresh-mail gates. The two non-nudge outcomes are distinct:
  // HOLD (listener not `listening`) vs CONSUME (inbox read). The listener
  // preserves inbox/unread across a reconnect, so a tick landing in a
  // `connecting`/`error` backoff window must NOT advance the watermark — the
  // pending wake fires once the listener is back (Critic cumulative WARNING,
  // 2026-07-11). Only a genuinely-read inbox (`unread === 0`) consumes the edge.
  const status = _internal.getStatus(sessionId);
  if (status.state !== 'listening') {
    st.idleTicks = 0;
    record('skipped', 'none', `listener-${status.state}`);
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
    record('skipped', 'none', 'pane-capture-failed');
    return;
  }
  const verdict = _assessPane(cap.lines || [], profile);
  if (!verdict.idle) {
    st.idleTicks = 0;
    record('skipped', 'none', `pane-${verdict.reason}`);
    return;
  }
  st.idleTicks += 1;
  if (st.idleTicks < IDLE_TICKS_REQUIRED) return;

  // Inject into the session we just JUDGED (MED-7Q4C). Addressing by project
  // name alone would let injectCommand re-resolve `getActive` independently, so
  // the nudge could land in a pane this scan never assessed once a project holds
  // more than one live session. The explicit handle keeps judgment and delivery
  // on one session; injectCommand re-checks it is still an active session of
  // this project, so a session that ended mid-tick fails closed rather than
  // misrouting.
  //
  // Watermark advances only on a successful injection so a transient tmux
  // failure retries next tick instead of silently dropping the wake.
  //
  // The Master goes through its own injector rather than `injectCommand`,
  // because that function's ownership check — the addressed session must be an
  // active session OF the named project — is exactly the property the Master
  // cannot satisfy: it belongs to no project. `injectMasterCommand` applies the
  // checks that do transfer (length cap, confirmed-live pane) itself.
  const label = session.isMaster ? session.name : project.name;
  const result = session.isMaster
    ? _internal.injectMaster(_nudgeLineFor(session.apiBase, status.unread))
    : _internal.injectCommand(project.name, _nudgeLine(project.name, status.unread), { sessionId });
  const channel = session.isMaster ? 'master-inject' : 'tmux-inject';
  st.idleTicks = 0;
  if (!result.ok) {
    log.warn('medusa-wake: nudge injection failed', { project: label, sessionId, error: result.error });
    // #791: an injection that reached the pane and did not land used to leave
    // no trace anywhere, so a broken channel read exactly like a quiet peer.
    record('failed', channel, `inject-failed: ${result.error || 'unknown'}`);
    return;
  }
  st.lastNudgedKey = newest;
  record('nudged', channel, null);
  log.info('medusa-wake: nudged idle session about fresh inbox mail', {
    project: label, sessionId, unread: status.unread
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
  // The Master joins the scan as one more session-shaped record, so it is
  // pruned, gated and debounced by the same code as everyone else. Its own
  // failure is contained: a broken Master probe must not cost the projects
  // their tick, and `null` (absent, or tmux silent) simply means nothing to scan.
  try {
    const masterRecord = _internal.masterWakeRecord();
    if (masterRecord) live = live.concat([masterRecord]);
  } catch (err) {
    log.warn('medusa-wake: master record failed', { error: err.message });
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
  injectCommand: (projectName, command, options) => require('./sessions').injectCommand(projectName, command, options),
  // The Master's two seams, lazy like the rest so requiring this module never
  // pulls `lib/master.js` (and its store/engine graph) in behind it.
  masterWakeRecord: () => require('./master').masterWakeRecord(),
  injectMaster: (command) => require('./master').injectMasterCommand(command),
  recordDelivery: (entry) => require('./store').medusaDeliveries.record(entry),
  tick: _tick
};

module.exports = {
  start,
  stop,
  ENGINE_WAKE_PROFILES,
  IDLE_TICKS_REQUIRED,
  _assessPane,
  _nudgeLine,
  _nudgeLineFor,
  _internal
};
