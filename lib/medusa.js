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
  mintWorkspaceId,
  readContract,
  _setBridgeHttpUrl
};
