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
 * send and roster proxying arrive in later chunks.
 */

const { createLogger } = require('./logger');
const registry = require('./medusa-registry');
const { MedusaListener } = require('./medusa-listener');

const log = createLogger('medusa');

/** @type {Map<string, MedusaListener>} Active listeners keyed by session id. */
const listeners = new Map();

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
 * @param {string} [options.bridgeUrl] - Override Bridge WS URL (default loopback).
 * @param {(url: string) => object} [options.wsFactory] - Socket factory passed to the
 *   listener (test seam; defaults to the built-in `WebSocket` inside the listener).
 * @returns {{state: string, workspaceId: (string|null), unread: number, lastError: (string|null)}}
 */
function startSession({ projectPath, sessionId, name, bridgeUrl, wsFactory }) {
  const key = String(sessionId);
  const existing = listeners.get(key);
  if (existing) return existing.getStatus();

  const workspaceId = registry.ensureWorkspaceId(projectPath, sessionId, name);
  const listener = new MedusaListener({ bridgeUrl, workspaceId, name, wsFactory });
  listeners.set(key, listener);
  listener.start();
  log.info('Started Medusa listener', { sessionId: key, workspaceId });
  return listener.getStatus();
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

module.exports = {
  startSession,
  stopSession,
  getStatus,
  getMessages,
  markRead
};
