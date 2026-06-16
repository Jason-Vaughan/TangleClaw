'use strict';

/**
 * Session-ownership primitive (#347) — Slice 1: local read-side object.
 *
 * A first-class, queryable binding of each session to the project it owns,
 * built ONCE and shared, so its three 4.0 consumers — #340 (scope guard),
 * #333 (Switchboard routing), and #331 (Project Master enumeration) — read
 * the same object instead of each growing a subtly-incompatible one.
 *
 * This slice resolves ownership for LOCAL (tmux) sessions with accurate
 * liveness and a structured, host-qualified address. Remote
 * `openclaw:<connId>` sessions are still ENUMERATED (never silently dropped)
 * but carry db-only liveness and the connection's host read AS-IS — accurate
 * bridge liveness and Tailscale Magic DNS normalization land in Slice 2.
 *
 * Address shape (the lock-in surface — deliberately DERIVED, not persisted):
 *
 *   { sessionId, project, projectId, host, transport, mode, remote,
 *     live, livenessSource, handle, engineId, status, startedAt }
 *
 *   canonical handle string: `${host}/${project}#${sessionId}`
 *
 * Decisions (see `.prawduct/artifacts/session-ownership-primitive.md`):
 *  - Reuse `sessions.id` as the stable, globally-unique, N-ready handle key.
 *  - Derive the address; add no persisted column until a consumer needs one.
 *  - Remote addressing uses Tailscale Magic DNS names, never literal IPs —
 *    the connection host is read as-is here; Slice 2 normalizes it.
 *
 * @module lib/session-ownership
 */

const store = require('./store');
const tmux = require('./tmux');
const { createLogger } = require('./logger');

const log = createLogger('session-ownership');

const OPENCLAW_PREFIX = 'openclaw:';

/**
 * Resolve the local host identity used in a session address.
 *
 * Slice 1 returns `'localhost'` — a deliberate seam. Slice 2 resolves the
 * machine's Tailscale Magic DNS name here, so local and remote addresses are
 * uniformly host-qualified and never IP-bound.
 *
 * @returns {string}
 */
function _localHost() {
  return 'localhost';
}

/**
 * Classify a session's transport from its engine id.
 * @param {object} session - Session object from the store
 * @returns {'tmux'|'openclaw'}
 */
function _transportOf(session) {
  const engineId = session && typeof session.engineId === 'string' ? session.engineId : '';
  return engineId.startsWith(OPENCLAW_PREFIX) ? 'openclaw' : 'tmux';
}

/**
 * Resolve the host for a session's address.
 *
 * Local (tmux) sessions resolve to the local host identity. Remote
 * `openclaw:<connId>` sessions read the connection's `host` AS-IS — this is
 * the Magic DNS value the operator configured; the primitive never mints or
 * normalizes an IP. Returns `null` when a remote connection can't be found.
 *
 * @param {object} session - Session object from the store
 * @returns {string|null}
 */
function _resolveHost(session) {
  if (_transportOf(session) === 'tmux') return _localHost();
  const connId = session.engineId.slice(OPENCLAW_PREFIX.length);
  const conn = store.openclawConnections.get(connId);
  if (!conn || !conn.host) {
    log.debug('Remote session has no resolvable connection host', { sessionId: session.id, connId });
    return null;
  }
  return conn.host;
}

/**
 * Determine whether a session is live, and how that was determined.
 *
 * Local sessions are confirmed against tmux — the process must actually
 * exist, not merely have an `active` DB row. Remote sessions fall back to the
 * DB status; accurate bridge liveness is Slice 2.
 *
 * @param {object} session - Session object from the store
 * @param {object} project - Project object from the store
 * @returns {{ live: boolean, source: 'tmux'|'db' }}
 */
function _liveness(session, project) {
  if (_transportOf(session) === 'openclaw') {
    return { live: session.status === 'active' || session.status === 'wrapping', source: 'db' };
  }
  const name = tmux.toSessionName(project.name);
  return { live: tmux.hasSession(name), source: 'tmux' };
}

/**
 * Build the ownership/address object for a (session, project) pair.
 * @param {object} session - Session object from the store
 * @param {object} project - Project object from the store
 * @returns {object} - Ownership object (see module docstring for shape)
 */
function _toOwnership(session, project) {
  const host = _resolveHost(session);
  const transport = _transportOf(session);
  const { live, source } = _liveness(session, project);
  return {
    sessionId: session.id,
    project: project.name,
    projectId: project.id,
    host,
    transport,
    mode: session.sessionMode,
    remote: transport === 'openclaw',
    live,
    livenessSource: source,
    handle: `${host || 'unknown'}/${project.name}#${session.id}`,
    engineId: session.engineId,
    status: session.status,
    startedAt: session.startedAt
  };
}

/**
 * Resolve ownership for a session by its id (any status, any project).
 * @param {number} sessionId - Session id
 * @returns {object|null} - Ownership object, or null if the session or its project is gone
 */
function resolveBySessionId(sessionId) {
  const session = store.sessions.get(sessionId);
  if (!session) return null;
  const project = store.projects.get(session.projectId);
  if (!project) {
    log.debug('Session has no resolvable project', { sessionId, projectId: session.projectId });
    return null;
  }
  return _toOwnership(session, project);
}

/**
 * Resolve ownership for a project's current active session.
 * @param {string} projectName - Project directory name
 * @returns {object|null} - Ownership object, or null if no active session
 */
function resolveByProject(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) return null;
  const session = store.sessions.getActive(project.id);
  if (!session) return null;
  return _toOwnership(session, project);
}

/**
 * Enumerate ownership objects for every live session across all projects.
 *
 * Includes remote (openclaw) sessions — they are never silently dropped — but
 * those carry db-only liveness until Slice 2. A live session whose project
 * row is gone is skipped (logged at debug).
 *
 * @returns {object[]} - Ownership objects, most-recently-started first
 */
function listLive() {
  const sessions = store.sessions.listLiveAll();
  const out = [];
  for (const session of sessions) {
    const project = store.projects.get(session.projectId);
    if (!project) {
      log.debug('Live session has no resolvable project; skipping', { sessionId: session.id });
      continue;
    }
    out.push(_toOwnership(session, project));
  }
  return out;
}

module.exports = {
  resolveBySessionId,
  resolveByProject,
  listLive,
  // Exported for tests + Slice 2 extension points.
  _localHost,
  _transportOf,
  _resolveHost,
  _liveness,
  _toOwnership
};
