'use strict';

/**
 * Session-ownership primitive (#347) — Slice 1: local read-side object.
 *
 * A first-class, queryable binding of each session to the project it owns,
 * built ONCE and shared, so its three 4.0 consumers — #340 (scope guard),
 * #333 (Switchboard routing), and #331 (Project Master enumeration) — read
 * the same object instead of each growing a subtly-incompatible one.
 *
 * Slice 1 resolved ownership for LOCAL (tmux) sessions with accurate liveness
 * and a structured, host-qualified address. Slice 2a resolves `_localHost()`
 * to the machine's real Tailscale Magic DNS name (was the `'localhost'` seam).
 * Remote `openclaw:<connId>` sessions are still ENUMERATED (never silently
 * dropped) but carry db-only liveness and the connection's host read AS-IS —
 * accurate ClawBridge liveness (Slice 2b) is blocked on a ClawBridge status
 * contract (separate repo); in-session identity injection is Slice 3.
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

const os = require('node:os');
const { execSync } = require('node:child_process');
const store = require('./store');
const tmux = require('./tmux');
const { createLogger } = require('./logger');

const log = createLogger('session-ownership');

const OPENCLAW_PREFIX = 'openclaw:';
const TAILSCALE_TIMEOUT_MS = 3000;

// Indirection seam for tests (mirrors lib/server-info.js#_internal): override
// `_internal.execSync` / `_internal.hostname` to make local-host resolution
// deterministic without shelling out.
const _internal = {
  execSync,
  hostname: () => os.hostname()
};

// Memoized local Magic DNS name. undefined = not yet resolved; a string once
// resolved (the machine's host identity doesn't change within a process).
let _localHostCache;

/**
 * Detect the machine's Tailscale Magic DNS name via `tailscale status --json`
 * (`.Self.DNSName`, e.g. `cursatory.tail123678.ts.net.`). The trailing dot is
 * stripped and the name lowercased. Returns null when tailscale is absent, not
 * running, or its output can't be parsed — a best-effort probe, never throws.
 *
 * @returns {string|null}
 */
function _detectMagicDnsName() {
  try {
    const out = _internal.execSync('tailscale status --json', {
      encoding: 'utf8',
      timeout: TAILSCALE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const parsed = JSON.parse(String(out || ''));
    const dns = parsed && parsed.Self && typeof parsed.Self.DNSName === 'string'
      ? parsed.Self.DNSName.trim()
      : '';
    if (!dns) return null;
    return dns.replace(/\.$/, '').toLowerCase();
  } catch (err) {
    log.debug('Could not resolve Tailscale Magic DNS name', { error: err.message });
    return null;
  }
}

/**
 * Resolve the local host identity used in a session address.
 *
 * Prefers the machine's Tailscale Magic DNS name (the operator directive:
 * Magic DNS, never literal IPs), falling back to the OS hostname and finally
 * `'localhost'` when tailscale is unavailable. Memoized for the process
 * lifetime — the host identity doesn't change within a run.
 *
 * @returns {string}
 */
function _localHost() {
  if (_localHostCache !== undefined) return _localHostCache;
  _localHostCache = _detectMagicDnsName() || _internal.hostname() || 'localhost';
  return _localHostCache;
}

/**
 * Reset the memoized local-host value. Tests only.
 * @returns {void}
 */
function _resetHostCacheForTest() {
  _localHostCache = undefined;
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

/**
 * Render the in-session ownership identity block for a session's prime
 * (Slice 3). States the single project this session owns so a consumer — e.g.
 * #340's scope guard — can read a reliable identity from hidden prime context.
 *
 * The session id is NOT known when the prime is generated (the `sessions` row
 * is created after the prime file is written), so this carries the
 * pre-session address facts — owned project, host, transport — not the full
 * `host/project#sessionId` handle. This is identity ONLY: the wrong-tab
 * flagging behavior belongs to #340, the consumer.
 *
 * @param {object} project - Project object (needs `name`; `engineId` optional)
 * @returns {string[]} - Markdown lines for the prime (empty array if no project)
 */
function primeSection(project) {
  if (!project || !project.name) return [];
  const transport = _transportOf({ engineId: project.engineId });
  const host = _localHost();
  return [
    '## Session Ownership',
    `This session owns one project: **${project.name}**.`,
    `- Owned project: \`${project.name}\``,
    `- Host: \`${host}\``,
    `- Transport: \`${transport}\``,
    `Treat \`${project.name}\` as the project you are working in this session.`,
    ''
  ];
}

module.exports = {
  resolveBySessionId,
  resolveByProject,
  listLive,
  primeSection,
  // Exported for tests + Slice 2/3 extension points.
  _localHost,
  _detectMagicDnsName,
  _resetHostCacheForTest,
  _internal,
  _transportOf,
  _resolveHost,
  _liveness,
  _toOwnership
};
