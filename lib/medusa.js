'use strict';

/**
 * Medusa service layer (MED-2K9P Chunk 01).
 *
 * Owns the lifecycle of per-session `MedusaListener` instances and mediates
 * between TC's server routes and the WS listener + id registry. Server routes
 * are thin pass-throughs to the functions here; the browser never talks to the
 * Medusa Bridge directly — TC is the single integration point.
 *
 * This chunk implements start/stop/status plus inbox pass-throughs. Outbound
 * send (`sendMessage`) and roster proxying (`getRoster`) are added in Chunk 03 —
 * they talk to the Bridge's HTTP API (`:3009`), whereas the listener speaks WS
 * (`:3010`); the browser still never touches the Bridge directly.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');
const registry = require('./medusa-registry');
const { MedusaListener } = require('./medusa-listener');

const log = createLogger('medusa');

/** @type {Map<string, MedusaListener>} Active listeners keyed by session id. */
const listeners = new Map();

/**
 * @type {Map<string, Set<string>>} Loop ids each session KNOWS about, keyed by
 * session id (MED-2K9P v2 T4). The Bridge has no `GET /loops` list endpoint, so
 * TC tracks discovery itself: `openLoop` records ids on the initiator side;
 * `getLoops` re-learns ids from inbound inbox messages tagged `loopId` (the
 * target side's only discovery path). In-memory by design — a TC restart
 * forgets loops until their next inbound round message re-surfaces them (the
 * Bridge's own loop store is in-memory too, so ids don't outlive it either).
 */
const knownLoops = new Map();

/**
 * Record a loop id as known to a session (creates the per-session set lazily).
 * @param {string} sessionKey - String session id.
 * @param {string} loopId - Bridge loop id.
 * @returns {void}
 */
function _trackLoop(sessionKey, loopId) {
  let set = knownLoops.get(sessionKey);
  if (!set) {
    set = new Set();
    knownLoops.set(sessionKey, set);
  }
  set.add(loopId);
}

/**
 * @type {string} Default Bridge HTTP base URL (loopback per the trust model).
 * The Bridge serves its HTTP API on `:3009` and its WS on `:3010` (HTTP port + 1);
 * send + roster use the HTTP side. Operator-overridable via `MEDUSA_BRIDGE_HTTP_URL`.
 */
const DEFAULT_BRIDGE_HTTP_URL = 'http://localhost:3009';

/** @type {string} Resolved Bridge HTTP base URL (env at load; test-overridable). */
let bridgeHttpUrl = process.env.MEDUSA_BRIDGE_HTTP_URL || DEFAULT_BRIDGE_HTTP_URL;

/**
 * Override the Bridge HTTP base URL (test seam; points send/roster at a fake
 * Bridge). Pass no argument to reset to the env/default.
 * @param {string} [url] - Base URL, or omit to reset.
 * @returns {void}
 */
function _setBridgeHttpUrl(url) {
  bridgeHttpUrl = url || process.env.MEDUSA_BRIDGE_HTTP_URL || DEFAULT_BRIDGE_HTTP_URL;
}

/**
 * An error carrying an HTTP status for the route layer to surface honestly.
 * @param {string} message - Human-readable reason.
 * @param {number} httpStatus - HTTP status the route should return.
 * @param {string} code - Machine-readable error code.
 * @returns {Error} The error, with `httpStatus` and `code` attached.
 */
function sendError(message, httpStatus, code) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  err.code = code;
  return err;
}

/** @type {{state: string, workspaceId: null, unread: number, lastError: null}} Status for a session with no listener. */
const OFF_STATUS = { state: 'off', workspaceId: null, unread: 0, lastError: null };

/**
 * Start a listener for a session (idempotent per session). Ensures a stable
 * workspace id via the registry, creates + starts a `MedusaListener`, and
 * returns its status. If a listener already exists for the session, its current
 * status is returned without double-starting.
 * @param {object} options
 * @param {string} options.projectPath - Absolute path to the project directory.
 * @param {string|number} options.sessionId - The TC session id.
 * @param {string} options.name - Human-readable name for id minting + logging.
 * @param {string} [options.workspaceId] - Pre-minted workspace id from the launch
 *   path (MED-2K9P v2 T1) so the listener registers under the exact identity
 *   already injected into the session's prime prompt. Omitted by the toggle /
 *   reconnect paths, which keep the registry's existing id.
 * @param {string} [options.bridgeUrl] - Override Bridge WS URL (default loopback).
 * @param {(url: string) => object} [options.wsFactory] - Socket factory passed to the
 *   listener (test seam; defaults to the built-in `WebSocket` inside the listener).
 * @returns {{state: string, workspaceId: (string|null), unread: number, lastError: (string|null)}}
 */
function startSession({ projectPath, sessionId, name, workspaceId: preferredId, bridgeUrl, wsFactory }) {
  const key = String(sessionId);
  const existing = listeners.get(key);
  if (existing) return existing.getStatus();

  const workspaceId = registry.ensureWorkspaceId(projectPath, sessionId, name, preferredId);
  const listener = new MedusaListener({ bridgeUrl, workspaceId, name, wsFactory });
  listeners.set(key, listener);
  listener.start();
  log.info('Started Medusa listener', { sessionId: key, workspaceId });
  return listener.getStatus();
}

/**
 * Mint (but do not persist) a workspace id for a launch (MED-2K9P v2 T1).
 * The launch path calls this BEFORE the session record exists so the prime
 * prompt and the listener share one identity: the minted id goes into the
 * prime, then rides `startSession({ workspaceId })` into the registry. If the
 * listener never starts (Bridge down, launch aborted) the id was never
 * persisted, so nothing leaks.
 * @param {string} name - Human-readable name used to build the id slug.
 * @returns {string} A freshly minted workspace id.
 */
function mintWorkspaceId(name) {
  return registry.mintId(name);
}

/**
 * Stop and remove a session's listener. The registry entry is intentionally
 * retained (forget-on-end is a later chunk's concern). No-op if none exists.
 * @param {string|number} sessionId - The TC session id.
 * @returns {void}
 */
function stopSession(sessionId) {
  const key = String(sessionId);
  const listener = listeners.get(key);
  if (!listener) return;
  listener.stop();
  listeners.delete(key);
  log.info('Stopped Medusa listener', { sessionId: key });
}

/**
 * Tear down a session's Medusa presence on session end (MED-2K9P Chunk 04):
 * stop the listener (closing the WS — the Bridge auto-drops it from `wsClients`)
 * and forget the persisted workspace id so the session is no longer addressable
 * and a future session mints a fresh id. Best-effort and never throws — session
 * teardown must not be blocked by a Medusa cleanup failure. No server-side
 * deregister call: a WS-only id is never in the Bridge's `workspaceRegistry`, so
 * `DELETE /workspaces/:id` is a no-op for it (see api-notes-medusa.md Chunk 04).
 * @param {object} options
 * @param {string} options.projectPath - Absolute path to the project directory.
 * @param {string|number} options.sessionId - The TC session id.
 * @returns {void}
 */
function forgetSession({ projectPath, sessionId }) {
  try {
    stopSession(sessionId);
    // Loop tracking dies with the session identity (a banner toggle-off keeps
    // it so a toggle cycle can still observe its loops; session END does not).
    knownLoops.delete(String(sessionId));
    if (projectPath) registry.forgetWorkspace(projectPath, sessionId);
  } catch (err) {
    log.warn('Failed to forget Medusa session on teardown', { sessionId: String(sessionId), error: err.message });
  }
}

/**
 * Return the observable status for a session's listener, or an `off` status
 * when there is no listener (or no session id).
 * @param {string|number|null} sessionId - The TC session id.
 * @returns {{state: string, workspaceId: (string|null), unread: number, lastError: (string|null)}}
 */
function getStatus(sessionId) {
  if (sessionId == null) return { ...OFF_STATUS };
  const listener = listeners.get(String(sessionId));
  return listener ? listener.getStatus() : { ...OFF_STATUS };
}

/**
 * Return a copy of a session's in-memory inbox (empty when no listener).
 * @param {string|number} sessionId - The TC session id.
 * @returns {Array<object>} The received messages, oldest first.
 */
function getMessages(sessionId) {
  const listener = listeners.get(String(sessionId));
  return listener ? listener.inbox.slice() : [];
}

/**
 * Mark a session's inbox as read (resets the unread badge). No-op if none.
 * @param {string|number} sessionId - The TC session id.
 * @returns {void}
 */
function markRead(sessionId) {
  const listener = listeners.get(String(sessionId));
  if (listener) listener.markRead();
}

/**
 * Send a direct message from a session to another workspace (MED-2K9P Chunk 03).
 *
 * The session must have a running listener — its stable workspace id becomes the
 * truthful `from` (the Bridge trusts `from` verbatim, so TC never lets the browser
 * set it). The result is honest: `received` (delivered live), `queued` (recipient
 * offline, stored in the Hub inbox), never a blanket "sent". Failures throw a
 * status-carrying error rather than reporting a false success.
 *
 * The Bridge does NOT validate the message body (a missing body still queues —
 * verify-api 2026-07-10), so a non-empty text is enforced here.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The sending TC session id.
 * @param {string} options.to - Target workspace id (from the roster).
 * @param {string} options.message - Message text (must be non-empty).
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{status: string, id: (string|undefined), to: string}>}
 * @throws {Error} With `httpStatus`/`code` when validation fails, the session
 *   isn't listening, or the Bridge rejects/ is unreachable.
 */
async function sendMessage({ sessionId, to, message, fetchImpl }) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw sendError('Message text is required', 400, 'EMPTY_MESSAGE');
  if (!to || typeof to !== 'string') throw sendError('A target workspace is required', 400, 'NO_TARGET');

  const listener = listeners.get(String(sessionId));
  if (!listener || listener.state === 'off') {
    throw sendError('Enable Medusa for this session before sending', 409, 'NOT_LISTENING');
  }
  const from = listener.workspaceId;
  if (to === from) throw sendError('Cannot send a message to this same session', 400, 'SELF_TARGET');

  const doFetch = fetchImpl || fetch;
  let res;
  let data;
  try {
    res = await doFetch(`${bridgeHttpUrl}/messages/direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, from, message: text })
    });
    data = await res.json();
  } catch (err) {
    log.warn('Medusa send failed to reach the Bridge', { sessionId: String(sessionId), to, error: err.message });
    throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
  }

  // The Bridge returns `success:true` for received/queued; anything else (e.g. a
  // 404 "Peer/Workspace not found") is a real failure — never a silent success.
  if (!res.ok || !data || data.success !== true) {
    const reason = (data && (data.error || data.message)) || `Bridge returned HTTP ${res.status}`;
    log.warn('Medusa send rejected by the Bridge', { sessionId: String(sessionId), to, status: res.status, reason });
    throw sendError(reason, 502, 'SEND_REJECTED');
  }

  log.info('Medusa message sent', { sessionId: String(sessionId), from, to, status: data.status });
  return { status: data.status, id: data.id, to };
}

/**
 * Fetch the live roster of registered workspaces from the Bridge, excluding the
 * calling session's own workspace so it can't message itself (MED-2K9P Chunk 03).
 * A thin proxy — TC is the single integration point; the browser never calls the
 * Bridge directly.
 * @param {object} options
 * @param {string|number} [options.sessionId] - The calling session (for self-exclusion).
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<Array<object>>} Roster entries (other workspaces).
 * @throws {Error} With `httpStatus`/`code` when the Bridge is unreachable or errors.
 */
async function getRoster({ sessionId, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  let res;
  let data;
  try {
    res = await doFetch(`${bridgeHttpUrl}/workspaces`);
    data = await res.json();
  } catch (err) {
    log.warn('Medusa roster fetch failed to reach the Bridge', { error: err.message });
    throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
  }
  if (!res.ok || !data) {
    throw sendError(`Bridge returned HTTP ${res.status}`, 502, 'ROSTER_FAILED');
  }
  const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
  const listener = sessionId == null ? null : listeners.get(String(sessionId));
  const selfId = listener ? listener.workspaceId : null;
  return workspaces.filter((w) => w && w.id && w.id !== selfId);
}

/** @type {string[]} Loop judge modes the Bridge accepts (MED-2K9P v2 T3). */
const LOOP_MODES = ['supervised', 'autonomous'];
/** @type {number} Default max-rounds guard when the modal leaves it blank. */
const DEFAULT_MAX_ROUNDS = 10;
/**
 * Default wall-clock guard (seconds) per judge mode, applied when the caller
 * omits `maxWallTimeSeconds` (MED-6V3R).
 *
 * The Bridge halts a loop once `now - startedAt` exceeds this budget: total
 * elapsed since first delivery, never paused and never reset per round
 * (Medusa `checkWallTimeGuardForLoop`; Medusa#54 moved the origin off loop
 * creation, but the clock still runs while a loop merely waits). That makes
 * one shared default wrong, because the two modes bound different things:
 *
 * - `autonomous` — agents drive every round unattended, so the clock measures
 *   AGENT WORK and the guard is genuine runaway protection. 10 minutes.
 * - `supervised` — a round advances only when the initiator sends, so the loop
 *   cannot run away by construction (`maxRounds` already bounds it) and the
 *   clock measures HUMAN DELIBERATION. The guard is an abandonment bound, not
 *   a runaway bound. 8 hours outlives real thinking time while still reaping
 *   loops left open overnight; the old 10-minute budget halted live supervised
 *   fixtures three times purely because the operator stepped away (VRF-561).
 *
 * @type {{supervised: number, autonomous: number}}
 */
const DEFAULT_WALL_SECONDS = {
  supervised: 28800,
  autonomous: 600
};

/**
 * Validate a guard value: a positive integer, or undefined to take the default.
 * @param {*} value - Raw guard value from the request body.
 * @param {number} fallback - Default when the value is undefined/null.
 * @returns {number|null} The validated integer, or null when invalid.
 */
function _guardInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Open a Medusa loop from a session to a target workspace (MED-2K9P v2 T3) —
 * the setup modal's launch path. One Bridge call over the public contract:
 * `POST /loops` creates the loop object (initiator = this session's workspace
 * id, the chosen mode, and the server-enforced guards) and the Bridge itself
 * delivers a `loopInvite` message to the target — durably queued in the
 * target's inbox and pushed live over WS when it is online (Medusa#47, fixed
 * upstream in Medusa PR #48; TC's prior out-of-band task notice was dropped as
 * redundant — TC#552).
 *
 * The Bridge's open response does not report the invite's live-vs-queued
 * delivery (unlike `/messages/direct`), so TC makes no claim beyond what the
 * contract guarantees: the invite is durably queued and reaches the target on
 * connect. No fake "delivered live" status is invented.
 *
 * Guards are the two the Bridge actually enforces (maxRounds,
 * maxWallTimeSeconds). A token-budget guard is deliberately NOT offered until
 * Medusa enforces one — an unenforced knob would be a dishonest control. An
 * omitted `maxWallTimeSeconds` defaults per judge mode, because the modes bound
 * different things — see `DEFAULT_WALL_SECONDS` (MED-6V3R).
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.target - Target workspace id (from the roster).
 * @param {string} options.task - The task the target is asked to do.
 * @param {string} options.doneCriteria - What the initiator will judge against.
 * @param {string} [options.mode='supervised'] - Judge mode (`supervised` | `autonomous`).
 * @param {{maxRounds?: number, maxWallTimeSeconds?: number}} [options.guards] - Runaway guards.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loop: object}>}
 * @throws {Error} With `httpStatus`/`code` on validation failure, a missing
 *   listener, Bridge rejection, or unreachable Bridge.
 */
async function openLoop({ sessionId, target, task, doneCriteria, mode, guards, fetchImpl }) {
  const taskText = typeof task === 'string' ? task.trim() : '';
  if (!taskText) throw sendError('A task is required', 400, 'EMPTY_TASK');
  const doneText = typeof doneCriteria === 'string' ? doneCriteria.trim() : '';
  if (!doneText) throw sendError('Done criteria are required — the initiator judges against them', 400, 'EMPTY_DONE_CRITERIA');
  if (!target || typeof target !== 'string') throw sendError('A target workspace is required', 400, 'NO_TARGET');

  const chosenMode = mode === undefined || mode === null || mode === '' ? 'supervised' : mode;
  if (!LOOP_MODES.includes(chosenMode)) {
    throw sendError(`Mode must be one of: ${LOOP_MODES.join(', ')}`, 400, 'BAD_MODE');
  }

  const g = guards || {};
  const maxRounds = _guardInt(g.maxRounds, DEFAULT_MAX_ROUNDS);
  const maxWallTimeSeconds = _guardInt(g.maxWallTimeSeconds, DEFAULT_WALL_SECONDS[chosenMode]);
  if (maxRounds === null || maxWallTimeSeconds === null) {
    throw sendError('Guards must be positive integers (maxRounds, maxWallTimeSeconds)', 400, 'BAD_GUARDS');
  }

  const listener = listeners.get(String(sessionId));
  if (!listener || listener.state === 'off') {
    throw sendError('Enable Medusa for this session before opening a loop', 409, 'NOT_LISTENING');
  }
  const initiator = listener.workspaceId;
  if (target === initiator) throw sendError('Cannot open a loop with this same session', 400, 'SELF_TARGET');

  const doFetch = fetchImpl || fetch;
  let res;
  let loop;
  try {
    res = await doFetch(`${bridgeHttpUrl}/loops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initiator,
        target,
        task: taskText,
        doneCriteria: doneText,
        mode: chosenMode,
        guards: { maxRounds, maxWallTimeSeconds }
      })
    });
    loop = await res.json();
  } catch (err) {
    log.warn('Medusa loop open failed to reach the Bridge', { sessionId: String(sessionId), target, error: err.message });
    throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
  }
  if (!res.ok || !loop || !loop.id) {
    const reason = (loop && (loop.error || loop.message)) || `Bridge returned HTTP ${res.status}`;
    log.warn('Medusa loop open rejected by the Bridge', { sessionId: String(sessionId), target, status: res.status, reason });
    throw sendError(reason, 502, 'LOOP_REJECTED');
  }

  // The Bridge delivers the loopInvite to the target itself (Medusa#47 → PR
  // #48) — no out-of-band task notice needed (TC#552). Track the id so the
  // banner loop view can observe this loop (no Bridge list endpoint exists).
  _trackLoop(String(sessionId), loop.id);

  log.info('Medusa loop opened', {
    sessionId: String(sessionId), loopId: loop.id, initiator, target, mode: chosenMode
  });
  return { loop };
}

/** @type {string[]} Loop states in which the Bridge still accepts messages/close. */
const ACTIVE_LOOP_STATES = ['initiated', 'responded', 'continue'];

/**
 * List the loops a session knows about, with live state from the Bridge
 * (MED-2K9P v2 T4 — the banner loop view's data source). Discovery is TC-side
 * because the Bridge exposes no `GET /loops` list: ids recorded by `openLoop`
 * plus ids re-learned from inbound inbox messages tagged `loopId` (loopInvite,
 * round messages, close notifications — the target side's only path).
 *
 * Each known id is fetched via `GET /loops/:id`, which also triggers the
 * Bridge's wall-clock guard check — so a timed-out loop is reported `halted`
 * the moment the banner looks at it, not on its next message. A 404 (the
 * Bridge restarted and lost its in-memory loop store) untracks the id —
 * self-healing, never a phantom row.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The observing TC session id.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<Array<object>>} Loop objects, each with a TC-derived
 *   `role` (`'initiator'` | `'target'`) for this session. Empty when the
 *   session has no listener (no identity → no vantage point).
 * @throws {Error} With `httpStatus`/`code` when the Bridge is unreachable.
 */
async function getLoops({ sessionId, fetchImpl }) {
  const key = String(sessionId);
  const listener = listeners.get(key);
  if (!listener || listener.state === 'off') return [];
  const self = listener.workspaceId;

  const ids = new Set(knownLoops.get(key) || []);
  for (const msg of listener.inbox) {
    if (msg && typeof msg.loopId === 'string' && msg.loopId) {
      ids.add(msg.loopId);
      _trackLoop(key, msg.loopId);
    }
  }
  if (ids.size === 0) return [];

  const doFetch = fetchImpl || fetch;
  const loops = [];
  for (const id of ids) {
    let res;
    let loop;
    try {
      res = await doFetch(`${bridgeHttpUrl}/loops/${encodeURIComponent(id)}`);
      loop = await res.json();
    } catch (err) {
      log.warn('Medusa loop fetch failed to reach the Bridge', { sessionId: key, loopId: id, error: err.message });
      throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
    }
    if (res.status === 404) {
      // The Bridge lost this loop (its store is in-memory) — stop tracking it.
      const set = knownLoops.get(key);
      if (set) set.delete(id);
      continue;
    }
    if (!res.ok || !loop || !loop.id) continue; // transient Bridge error — skip this poll, keep tracking.
    loops.push({ ...loop, role: loop.initiator === self ? 'initiator' : 'target' });
  }
  // Stable order: active loops first, then most recent first within each group.
  loops.sort((a, b) => {
    const aActive = ACTIVE_LOOP_STATES.includes(a.state) ? 0 : 1;
    const bActive = ACTIVE_LOOP_STATES.includes(b.state) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return loops;
}

/**
 * Force-done a loop from its initiating session (MED-2K9P v2 T4) — the human
 * kill-switch of the loop protocol's control invariant ("a human can always
 * intervene; only the initiator ends a loop, never the receiver").
 *
 * Mapping decision (pinned against Bridge source 2026-07-14): the Bridge has
 * no external transition to `halted` — that state is reserved for its own
 * runaway guards. Force-done therefore rides the contract's close endpoint
 * with a structured `closeSignal.reason: 'force-done'`, and the loop lands in
 * `complete` with that reason recorded. TC renders the outcome from
 * `closeSignal.reason` — honest, no fake "halted" label. The Bridge enforces
 * the invariant itself: a non-initiator close is 403, and a guard-halted loop
 * rejects close with 400 ("a halted loop cannot be closed") — both surfaced
 * verbatim, never swallowed.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.loopId - The loop to force-done.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loopState: string, closeSignal: object}>} The Bridge's
 *   honest close result.
 * @throws {Error} With `httpStatus`/`code` on a missing listener, Bridge
 *   rejection (not initiator / already halted / unknown loop), or unreachable
 *   Bridge.
 */
async function forceDoneLoop({ sessionId, loopId, fetchImpl }) {
  return _closeLoop({
    sessionId,
    loopId,
    closeSignal: { reason: 'force-done', evidence: 'Operator force-done from the TangleClaw banner' },
    logLabel: 'force-done',
    errCode: 'FORCE_DONE_REJECTED',
    fetchImpl
  });
}

/**
 * Satisfied closeout — the CLOSEOUT half of the loop control spine (TC#561,
 * design §1: "initiator judges → CLOSEOUT (satisfied, ends) or FEEDBACK
 * (loops)"). The Bridge has a single `/close` endpoint, so this rides it with a
 * distinct `closeSignal.reason: 'satisfied'` — semantically separate from the
 * `force-done` kill-switch even though both land the loop in `complete`. TC
 * renders the outcome from the reason ("ended — marked done" vs "ended by
 * force-done"), so the operator's satisfied judgment is never mislabeled as a
 * kill. Same initiator-only (403) / already-closed (400) / unknown (404)
 * passthrough as force-done.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.loopId - The loop to close as satisfied.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loopState: string, closeSignal: object}>}
 * @throws {Error} With `httpStatus`/`code` on a missing listener, Bridge
 *   rejection, or unreachable Bridge.
 */
async function closeoutLoop({ sessionId, loopId, fetchImpl }) {
  return _closeLoop({
    sessionId,
    loopId,
    closeSignal: { reason: 'satisfied', evidence: 'Operator marked the loop satisfied from the TangleClaw banner' },
    logLabel: 'closeout',
    errCode: 'CLOSEOUT_REJECTED',
    fetchImpl
  });
}

/**
 * Shared Bridge close for the two initiator closeouts (force-done kill-switch
 * and satisfied closeout — TC#561). Both are `POST /loops/:id/close` with the
 * caller's `closeSignal`; only the reason + labels differ. The Bridge enforces
 * the control invariant: a non-initiator close is 403, an already
 * complete/halted loop is 400, an unknown loop 404 — all surfaced verbatim with
 * their real status, never swallowed.
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.loopId - The loop to close.
 * @param {{reason: string, evidence: string}} options.closeSignal - The close signal.
 * @param {string} options.logLabel - Short label for log lines (`force-done`|`closeout`).
 * @param {string} options.errCode - Error code on Bridge rejection.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loopState: string, closeSignal: object}>} The Bridge's honest close result.
 * @throws {Error} With `httpStatus`/`code` on missing listener / Bridge reject / unreachable.
 */
async function _closeLoop({ sessionId, loopId, closeSignal, logLabel, errCode, fetchImpl }) {
  if (!loopId || typeof loopId !== 'string') throw sendError('A loop id is required', 400, 'NO_LOOP_ID');
  const listener = listeners.get(String(sessionId));
  if (!listener || listener.state === 'off') {
    throw sendError('Enable Medusa for this session before ending a loop', 409, 'NOT_LISTENING');
  }

  const doFetch = fetchImpl || fetch;
  let res;
  let data;
  try {
    res = await doFetch(`${bridgeHttpUrl}/loops/${encodeURIComponent(loopId)}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: listener.workspaceId, closeSignal })
    });
    data = await res.json();
  } catch (err) {
    log.warn(`Medusa ${logLabel} failed to reach the Bridge`, { sessionId: String(sessionId), loopId, error: err.message });
    throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
  }
  if (!res.ok || !data || data.success !== true) {
    const reason = (data && (data.error || data.message)) || `Bridge returned HTTP ${res.status}`;
    log.warn(`Medusa ${logLabel} rejected by the Bridge`, { sessionId: String(sessionId), loopId, status: res.status, reason });
    // 400 = "already complete/halted" family; 403 = initiator-only invariant.
    throw sendError(reason, res.status === 400 || res.status === 403 || res.status === 404 ? res.status : 502, errCode);
  }

  log.info(`Medusa loop ${logLabel}`, { sessionId: String(sessionId), loopId, loopState: data.loopState });
  return { loopState: data.loopState, closeSignal: data.closeSignal };
}

/**
 * Send an initiator feedback round to continue a supervised loop (TC#561 — the
 * FEEDBACK half of the design §1 control spine). Posts to the Bridge's
 * `POST /loops/:id/message {from, message}`; the round lands in the target's
 * inbox tagged `loopId` and the loop advances `responded → continue` (round++).
 *
 * The Bridge accepts a round from the initiator ONLY once the target has
 * responded — posting while `initiated` yields `400 "Initiated loop expects
 * target response first"`. TC's UI therefore offers this only in `responded`
 * state; if a stale click still lands in the wrong state, the Bridge's 400
 * passes through verbatim (never a false "sent"). After the post, if the round
 * reaches `maxRounds` the Bridge auto-halts — reported on the next status poll.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.loopId - The loop to continue.
 * @param {string} options.message - The initiator's feedback text for this round.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loopState: string, round: number, delivered: boolean, messageId: (string|undefined)}>}
 * @throws {Error} With `httpStatus`/`code` on empty feedback, a missing
 *   listener, Bridge rejection (wrong state / unknown loop), or unreachable Bridge.
 */
async function continueLoop({ sessionId, loopId, message, fetchImpl }) {
  if (!loopId || typeof loopId !== 'string') throw sendError('A loop id is required', 400, 'NO_LOOP_ID');
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw sendError('Feedback is required to continue the loop', 400, 'EMPTY_FEEDBACK');
  const listener = listeners.get(String(sessionId));
  if (!listener || listener.state === 'off') {
    throw sendError('Enable Medusa for this session before continuing a loop', 409, 'NOT_LISTENING');
  }

  const doFetch = fetchImpl || fetch;
  let res;
  let data;
  try {
    res = await doFetch(`${bridgeHttpUrl}/loops/${encodeURIComponent(loopId)}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: listener.workspaceId, message: text })
    });
    data = await res.json();
  } catch (err) {
    log.warn('Medusa loop continue failed to reach the Bridge', { sessionId: String(sessionId), loopId, error: err.message });
    throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
  }
  if (!res.ok || !data || data.success !== true) {
    const reason = (data && (data.error || data.message)) || `Bridge returned HTTP ${res.status}`;
    log.warn('Medusa loop continue rejected by the Bridge', { sessionId: String(sessionId), loopId, status: res.status, reason });
    // 400 = wrong state ("target response first" / already closed); 404 = unknown loop.
    throw sendError(reason, res.status === 400 || res.status === 403 || res.status === 404 ? res.status : 502, 'CONTINUE_REJECTED');
  }

  log.info('Medusa loop continued', { sessionId: String(sessionId), loopId, loopState: data.loopState, round: data.round });
  return { loopState: data.loopState, round: data.round, delivered: !!data.delivered, messageId: data.messageId };
}

/**
 * Resolve Medusa's public consumer-contract doc for prime injection
 * (MED-2K9P v2 T1). The Bridge does not serve its contract over HTTP yet
 * (probed 2026-07-12 — a filed Medusa feature; when it lands this becomes a
 * Bridge fetch), so resolution is local-disk, in priority order:
 *
 *   1. `MEDUSA_CONTRACT_PATH` env override (operator control; also the test seam).
 *   2. `<medusaProjectPath>/docs/CONSUMER-CONTRACT.md` — the caller passes the
 *      registered "Medusa" project's path when one exists.
 *
 * Honest resolution: the failure return names every path tried so the prime
 * can say WHY the contract is missing instead of silently omitting it.
 * @param {object} [options]
 * @param {string} [options.medusaProjectPath] - Root of a local Medusa checkout.
 * @returns {{text: string, source: string}|{text: null, tried: string[]}}
 */
function readContract({ medusaProjectPath } = {}) {
  const candidates = [];
  if (process.env.MEDUSA_CONTRACT_PATH) candidates.push(process.env.MEDUSA_CONTRACT_PATH);
  if (medusaProjectPath) candidates.push(path.join(medusaProjectPath, 'docs', 'CONSUMER-CONTRACT.md'));

  const tried = [];
  for (const candidate of candidates) {
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      if (text.trim()) return { text, source: candidate };
      tried.push(`${candidate} (empty)`);
    } catch (err) {
      tried.push(`${candidate} (${err.code || err.message})`);
    }
  }
  if (tried.length > 0) {
    log.warn('Medusa consumer contract not resolvable for prime injection', { tried });
  }
  return { text: null, tried };
}

module.exports = {
  startSession,
  stopSession,
  forgetSession,
  getStatus,
  getMessages,
  markRead,
  sendMessage,
  getRoster,
  openLoop,
  getLoops,
  forceDoneLoop,
  closeoutLoop,
  continueLoop,
  mintWorkspaceId,
  readContract,
  _setBridgeHttpUrl
};
