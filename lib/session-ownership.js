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
 * Remote `openclaw:<connId>` sessions are ENUMERATED (never silently dropped)
 * and the connection's host read AS-IS. The SYNCHRONOUS resolvers carry db-only
 * remote liveness (the network must stay off the prime-gen + migration hot
 * paths); the ASYNC `probeLiveness` / `listLiveProbed` give accurate ClawBridge
 * liveness via `clawbridge.getStatus` for consumers that can await (Slice 2b /
 * #364 — now unblocked: ClawBridge v1.7.1 ships `GET /v2/session/status`) (separate repo); in-session identity injection is Slice 3.
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
const clawbridge = require('./clawbridge');
const { createLogger } = require('./logger');

const log = createLogger('session-ownership');

const OPENCLAW_PREFIX = 'openclaw:';
const TAILSCALE_TIMEOUT_MS = 3000;

// Indirection seam for tests (mirrors lib/server-info.js#_internal): override
// `_internal.execSync` / `_internal.hostname` to make local-host resolution
// deterministic without shelling out.
const _internal = {
  execSync,
  hostname: () => os.hostname(),
  // ClawBridge remote-liveness probe (#364). Injectable so tests exercise
  // the openclaw liveness branches without a real bridge or tunnel.
  bridgeStatus: clawbridge.getStatus
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
 * Classify a session's transport.
 *
 * `openclaw:<connId>` engine → remote `openclaw`. A `webui`-mode session that
 * is NOT openclaw is a local-but-paneless `webui` transport (distinct from
 * tmux — there is no tmux pane to probe). Everything else is local `tmux`.
 * (Today every webui session is also openclaw, so the openclaw prefix wins;
 * the `webui` branch guards a future local-webui session against the tmux
 * liveness path.)
 *
 * @param {object} session - Session object from the store
 * @returns {'tmux'|'openclaw'|'webui'}
 */
function _transportOf(session) {
  const engineId = session && typeof session.engineId === 'string' ? session.engineId : '';
  if (engineId.startsWith(OPENCLAW_PREFIX)) return 'openclaw';
  if (session && session.sessionMode === 'webui') return 'webui';
  return 'tmux';
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
  // Only remote openclaw sessions read a connection host; every local
  // transport (tmux and the paneless local webui) resolves to the local host.
  if (_transportOf(session) !== 'openclaw') return _localHost();
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
 * Only a local tmux session with a recorded tmux handle can be confirmed
 * against an actual pane (`tmux.hasSession` on the session's own
 * `tmuxSession`, not a name re-derived from the project) — the process must
 * exist, not merely have an `active` DB row. openclaw (remote) and the
 * paneless local webui transport fall back to the DB status (`active` or
 * `wrapping`). This is the SYNCHRONOUS signal — kept on the hot paths
 * (prime-gen scope guard, migration live-check). For accurate remote bridge
 * liveness (#364 / Slice 2b) use the async `probeLiveness` / `listLiveProbed`,
 * which consult `clawbridge.getStatus` off the hot path.
 *
 * @param {object} session - Session object from the store
 * @returns {{ live: boolean, source: 'tmux'|'db' }}
 */
function _liveness(session) {
  if (_transportOf(session) === 'tmux' && session.tmuxSession) {
    return { live: tmux.hasSession(session.tmuxSession), source: 'tmux' };
  }
  return { live: session.status === 'active' || session.status === 'wrapping', source: 'db' };
}

/**
 * Accurately probe a session's liveness, consulting the ClawBridge for remote
 * `openclaw` sessions (#364 / #347 Slice 2b — the accurate replacement for the
 * db-only remote signal `_liveness` returns).
 *
 * ASYNC by necessity: a remote probe is a network round-trip through the SSH
 * tunnel. This is deliberately a SEPARATE path from the synchronous `_liveness`
 * (and the sync resolvers built on it) so the prime-generation + migration hot
 * paths never block on a slow/hung bridge — they keep the fast, honestly-
 * labeled db signal. Enumeration consumers that can await (the Project Master
 * #331, Switchboard #333) use this for accurate remote status via `listLiveProbed`.
 *
 * - **tmux / local webui** → delegates to the synchronous `_liveness` (no network).
 * - **openclaw remote** → resolves the connection and calls `clawbridge.getStatus`:
 *     - reachable bridge → `{ live: status.active, source: 'bridge' }` (the bridge
 *       returns 200 + `active:false` for "no live session" — an accurate dead signal);
 *     - unreachable bridge (`ok:false`), no connection, no `bridgePort`, or no
 *       resolvable project → honest fallback to the db signal (`source:'db'`),
 *       NEVER a fabricated "dead" (an unreachable bridge ≠ a dead session).
 *
 * @param {object} session - Session object from the store
 * @returns {Promise<{ live: boolean, source: 'tmux'|'db'|'bridge' }>}
 */
async function probeLiveness(session) {
  if (_transportOf(session) !== 'openclaw') return _liveness(session);

  const connId = session.engineId.slice(OPENCLAW_PREFIX.length);
  const conn = store.openclawConnections.get(connId);
  if (!conn || !conn.bridgePort) return _liveness(session); // bridge not configured → honest db fallback

  const project = store.projects.get(session.projectId);
  if (!project || !project.name) return _liveness(session);

  let status;
  try {
    status = await _internal.bridgeStatus({
      localPort: conn.bridgePort,
      token: conn.bridgeToken,
      project: project.name
    });
  } catch (err) {
    // getStatus resolves-never-rejects, but guard anyway: a throw is an
    // unreachable bridge, not a dead session.
    log.debug('Bridge liveness probe threw; falling back to db', { sessionId: session.id, error: err.message });
    return _liveness(session);
  }

  if (!status || !status.ok) return _liveness(session); // unreachable → honest db fallback
  return { live: !!status.active, source: 'bridge' };
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
  const { live, source } = _liveness(session);
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
 * Resolve ownership for a project's current live session.
 *
 * Resolves the live session — `active` OR `wrapping` — to match `listLive`
 * and `resolveBySessionId` (the agent is still running mid-wrap, exactly the
 * case #340's scope guard must handle). Active wins when both somehow exist.
 *
 * @param {string} projectName - Project directory name
 * @returns {object|null} - Ownership object, or null if no live session
 */
function resolveByProject(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) return null;
  const session = store.sessions.getActive(project.id) || store.sessions.getWrapping(project.id);
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
 * Enumerate the CONFIRMED-live sessions with accurate remote liveness — the
 * async sibling of `listLive` (#364). Local (tmux/webui) entries keep their
 * synchronous liveness; remote `openclaw` entries are re-probed against the
 * bridge via `probeLiveness`, concurrently, so one slow bridge doesn't serialize
 * the rest. The result is then filtered to `live` only, so callers get a clean
 * "actually-live tabs" set: a stale local row whose tmux pane is gone AND a
 * db-`active` remote row whose bridge session is gone are both dropped (the
 * point of #364 — neither should masquerade as a live tab). An *unreachable*
 * bridge falls back to the db signal and is kept (honest — we can't prove it
 * dead). Unlike `listLive` (which returns every live-status row with a `live`
 * flag for the caller to filter), this returns only the live ones.
 *
 * This is the accurate enumeration entry point for the async dashboard consumers
 * (Project Master #331, Switchboard #333). The synchronous `listLive` is retained
 * for the hot paths (prime-gen scope guard, migration live-check) that must not
 * block on the network.
 *
 * @returns {Promise<object[]>} - Confirmed-live ownership objects, most-recently-started first
 */
async function listLiveProbed() {
  const base = listLive();
  const probed = await Promise.all(base.map(async (o) => {
    if (o.transport !== 'openclaw') return o; // already accurate (tmux pane / local db)
    const session = store.sessions.get(o.sessionId);
    if (!session) return o;
    const { live, source } = await probeLiveness(session);
    return { ...o, live, livenessSource: source };
  }));
  // Drop remote sessions the bridge confirmed dead — they are no longer live tabs.
  return probed.filter((o) => o.live);
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

/**
 * Render the in-session scope-guard directive for a session's prime (#340).
 *
 * This is the first **consumer** of the ownership primitive: it builds on the
 * identity-only block `primeSection` injects and adds the *behavior* — flag a
 * request that clearly belongs to a different project before acting. The two
 * are kept in separate functions on purpose: `primeSection` is asserted
 * identity-only (so "flag"/"wrong" can't leak into it), and the guard's posture
 * is **surface, never refuse** — lead with a one-line flag, name the likely tab
 * when known, and wait for the operator (who can always say "do it here").
 *
 * The "other tabs" list is drawn from `listLive()` (the launch-time snapshot of
 * live sessions) minus the owned project, so the flag can name the likely tab.
 * Only sessions whose liveness is actually **confirmed** (`o.live`) are listed —
 * a local tmux session is confirmed against a real pane (`tmux.hasSession`), so
 * stale `active`/`wrapping` DB rows whose pane is gone are dropped rather than
 * named as phantom tabs; remote (openclaw) sessions carry db-only liveness until
 * Slice 2b lands, which is the honest best we can do for them today.
 * The current session's row does not exist at prime-gen time, so `listLive`
 * already excludes self; we also drop by name to handle a prior same-project
 * session still wrapping. It's a snapshot — a tab opened mid-session won't
 * appear, which is acceptable for a naming hint (the core directive always
 * renders regardless of the list).
 *
 * @param {object} project - Project object (needs `name`)
 * @returns {string[]} - Markdown lines for the prime (empty array if no project)
 */
function scopeGuardSection(project) {
  if (!project || !project.name) return [];
  const owned = project.name;

  // Other projects with a live session right now (excludes the owned project).
  let others = [];
  try {
    others = listLive()
      .filter((o) => o.live)
      .map((o) => o.project)
      .filter((name) => name && name !== owned);
    others = [...new Set(others)];
  } catch {
    // Enumeration is a best-effort naming hint; never block prime generation
    // on it. The core directive below renders regardless.
    others = [];
  }

  const lines = [
    '## Scope Guard',
    `You own **${owned}** this session (see Session Ownership above).`
  ];
  if (others.length > 0) {
    lines.push('Other projects have a live session right now:');
    for (const name of others) lines.push(`- \`${name}\``);
  }
  lines.push(
    `Before acting on a request that clearly belongs to a different project — editing or `
    + `committing in another repo's territory — STOP and flag it in one line `
    + `(e.g. "Heads up: this looks like another project's work, not ${owned}. Do it here `
    + `anyway, or is it meant for that tab?"). Name the likely tab when you can, then wait `
    + `for the operator's confirmation.`
  );
  lines.push(
    `Surface the mismatch — never refuse outright; the operator can always say "do it here."`
  );
  lines.push('');
  return lines;
}

module.exports = {
  resolveBySessionId,
  resolveByProject,
  listLive,
  listLiveProbed,
  probeLiveness,
  primeSection,
  scopeGuardSection,
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
