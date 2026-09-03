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
 *     live, livenessSource, incomplete, livenessCause,
 *     handle, engineId, status, startedAt }
 *
 *   canonical handle string: `${host}/${project}#${sessionId}`
 *
 *   `live` is TRI-STATE: `true`, `false`, or `null` for "could not be
 *   established" — with `incomplete: ['live']` and `livenessCause` saying why.
 *   `incomplete` is `[]` on every established answer rather than absent.
 *   Read-only consumers must keep what they cannot disprove (`live !== false`);
 *   consumers about to ACT on the pane treat an unknown as "may be live".
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
const authIdentity = require('./auth-identity');

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
 * (`.Self.DNSName`, e.g. `your-host.tailnet-name.ts.net.`). The trailing dot is
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
 * Hosts that must never be handed to the operator as a link target.
 *
 * The whole point of the operator-topology fact is that the operator is almost
 * never on this machine, so a loopback name is not a weaker answer — it is the
 * wrong one, and rendering it produces a sentence that contradicts itself
 * ("never use localhost; use http://localhost:<port>").
 *
 * @type {string[]}
 */
const NON_OPERATOR_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0', ''];

/** Hostname shape: letters, digits, dots and hyphens, or a bracketed IPv6 literal. */
const HOST_SHAPE = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

/**
 * Reduce a `Host`-style header value to a bare hostname, or null.
 *
 * Strips the port (these headers carry `name:3102`, and the consumers append
 * their own `:<port>` — pasting the raw value produced `host:3102:8080`), takes
 * the FIRST entry of a comma-joined chain (a second proxy appends rather than
 * replaces), and refuses anything that is not hostname-shaped rather than
 * letting an arbitrary string reach a generated sentence.
 *
 * @param {string|string[]|undefined} raw - The header value as Node delivers it.
 * @returns {string|null}
 */
function _hostFromHeader(raw) {
  // An array means a duplicated header — ambiguous, so refuse rather than guess.
  if (typeof raw !== 'string') return null;
  const first = raw.split(',')[0].trim();
  if (!first) return null;
  // Bracketed IPv6 keeps its brackets; everything else drops a trailing :port.
  const host = first.startsWith('[')
    ? first.slice(0, first.indexOf(']') + 1)
    : first.split(':')[0];
  const lowered = host.toLowerCase();
  if (!HOST_SHAPE.test(lowered)) return null;
  // Compare unbracketed: `[::1]` is the same loopback as `::1`, and only the
  // bracketed spelling reaches here from an IPv6 Host header.
  if (NON_OPERATOR_HOSTS.includes(lowered.replace(/^\[|\]$/g, ''))) return null;
  return lowered;
}

/**
 * The host the operator actually reaches this machine on — measured from their
 * own request where possible, probed otherwise, and `null` when neither works.
 *
 * `_localHost()` answers "what is this machine called", which is a good default
 * and the wrong question when the operator arrives through a reverse proxy on
 * some other name: the prime then confidently names a host they are not using.
 * The request they launched from carries the real answer.
 *
 * `x-forwarded-host` is believed ONLY behind the live proxy gate — it is
 * caller-supplied, and what reads this ends up in hidden model context, so an
 * ungated read would let anyone who can reach the port steer the agent's links.
 * `Host` is used otherwise: it is what the operator's own client sent.
 *
 * Returns `null` rather than a fallback when no usable host can be established.
 * A fabricated `localhost` here is precisely the lie this fact exists to
 * prevent, so the caller must render the unknown, not invent a plausible URL.
 *
 * @param {object} [headers] - Request headers (Node's lower-cased map).
 * @param {object} [config] - Loaded server config, for the proxy-trust gate.
 * @returns {{host: string|null, source: 'forwarded-host'|'host'|'local-probe'|null}}
 */
function resolveOperatorHost(headers, config) {
  const h = headers || {};
  if (authIdentity.isProxyHeaderTrusted(config)) {
    const fwd = _hostFromHeader(h['x-forwarded-host']);
    if (fwd) return { host: fwd, source: 'forwarded-host' };
  }
  const direct = _hostFromHeader(h.host);
  if (direct) return { host: direct, source: 'host' };

  const probed = _localHost();
  if (probed && !NON_OPERATOR_HOSTS.includes(String(probed).toLowerCase().replace(/^\[|\]$/g, ''))) {
    return { host: probed, source: 'local-probe' };
  }
  return { host: null, source: null };
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
 * Only a local tmux session with a recorded tmux handle can be probed against
 * an actual pane (`tmux.probeSession` on the session's own `tmuxSession`, not
 * a name re-derived from the project) — the process must exist, not merely
 * have an `active` DB row. openclaw (remote) and the
 * paneless local webui transport fall back to the DB status (`active` or
 * `wrapping`). This is the SYNCHRONOUS signal — kept on the hot paths
 * (prime-gen scope guard, migration live-check). For accurate remote bridge
 * liveness (#364 / Slice 2b) use the async `probeLiveness` / `listLiveProbed`,
 * which consult `clawbridge.getStatus` off the hot path.
 *
 * This is a pure READ — it returns a liveness verdict and nothing else — so it
 * reports THREE outcomes, not two: the pane is there, the pane is not there, or
 * tmux could not be asked. It used to call `hasSession`, whose `false` means
 * "not confirmed live" — the right answer for a caller about to act on a pane
 * and the wrong one for a caller about to RECORD that the pane is gone. A tmux
 * server too wedged to reply made every session it owned report as dead, which
 * is an unknown wearing a fact's clothes and the same defect the tri-state
 * payloads elsewhere exist to prevent.
 *
 * `live: null` with `incomplete: ['live']` and a `cause` is the family's shape
 * for a fact that could not be established. Consumers must branch on it rather
 * than reading `null` as falsy — a wedge is exactly when a session is most
 * likely still running.
 *
 * @param {object} session - Session object from the store
 * @returns {{ live: boolean|null, source: 'tmux'|'db', incomplete: string[], cause: string|null }}
 */
function _liveness(session) {
  if (_transportOf(session) === 'tmux' && session.tmuxSession) {
    const probe = tmux.probeSession(session.tmuxSession);
    if (!probe.answered) {
      return { live: null, source: 'tmux', incomplete: ['live'], cause: probe.cause };
    }
    return { live: probe.live, source: 'tmux', incomplete: [], cause: null };
  }
  // The db row is an established answer about a transport with no pane to
  // probe, not a failed read — `incomplete` stays empty.
  return {
    live: session.status === 'active' || session.status === 'wrapping',
    source: 'db',
    incomplete: [],
    cause: null
  };
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
 * Carries the same tri-state `_liveness` does: the local delegation can return
 * `live: null` when tmux could not be asked, while a reachable bridge and the
 * db fallback are both established answers.
 *
 * @returns {Promise<{ live: boolean|null, source: 'tmux'|'db'|'bridge', incomplete: string[], cause: string|null }>}
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
  // A reachable bridge is an established answer, so nothing is incomplete.
  return { live: !!status.active, source: 'bridge', incomplete: [], cause: null };
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
  const { live, source, incomplete, cause } = _liveness(session);
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
    // Empty on every established answer rather than absent, so a consumer
    // reads a value instead of probing for a field. `livenessCause` rather
    // than the family's bare `cause` because this object already carries a
    // `livenessSource` it pairs with, and a lone `cause` here would not say
    // cause of what.
    incomplete,
    livenessCause: cause,
    handle: `${host || 'unknown'}/${project.name}#${session.id}`,
    engineId: session.engineId,
    status: session.status,
    startedAt: session.startedAt,
    owner: session.owner || null  // AUTH-3: proxy-authenticated user who launched it (null if direct mode)
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
 * Enumerate the sessions not known to be dead, with accurate remote liveness —
 * the async sibling of `listLive` (#364). Local (tmux/webui) entries keep their
 * synchronous liveness; remote `openclaw` entries are re-probed against the
 * bridge via `probeLiveness`, concurrently, so one slow bridge doesn't serialize
 * the rest.
 *
 * The result drops only what was CONFIRMED dead, so callers get a usable
 * "live tabs" set without it quietly becoming a lie: a stale local row whose
 * tmux pane is established gone AND a db-`active` remote row whose bridge
 * session is gone are both dropped (the point of #364 — neither should
 * masquerade as a live tab), while anything whose liveness could not be
 * established is KEPT. An unreachable bridge falls back to the db signal, and a
 * tmux too wedged to answer yields `live: null` — in both cases we cannot prove
 * the session dead, and during a wedge those are exactly the sessions an
 * operator is looking for. Unlike `listLive` (which returns every live-status
 * row for the caller to filter), this drops the proven-dead ones.
 *
 * This is the accurate enumeration entry point for the async dashboard consumers
 * (Project Master #331, Switchboard #333). The synchronous `listLive` is retained
 * for the hot paths (prime-gen scope guard, migration live-check) that must not
 * block on the network.
 *
 * @returns {Promise<object[]>} - Ownership objects not known to be dead, most-recently-started first
 */
async function listLiveProbed() {
  const base = listLive();
  const probed = await Promise.all(base.map(async (o) => {
    if (o.transport !== 'openclaw') return o; // already accurate (tmux pane / local db)
    const session = store.sessions.get(o.sessionId);
    if (!session) return o;
    const { live, source, incomplete, cause } = await probeLiveness(session);
    return { ...o, live, livenessSource: source, incomplete, livenessCause: cause };
  }));
  // Drop only what was CONFIRMED dead. `live === null` means the probe could
  // not establish anything — a wedged tmux, most often — and filtering on
  // truthiness would silently delete exactly the sessions an operator is
  // hunting for during a wedge, which is the failure the tri-state exists to
  // prevent. We cannot prove it dead, so we do not drop it.
  return probed.filter((o) => o.live !== false);
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
 * Sessions are listed unless their liveness is **established dead**
 * (`o.live !== false`) — a local tmux session is probed against a real pane
 * (`tmux.probeSession`), so stale `active`/`wrapping` DB rows whose pane is
 * confirmed gone are dropped rather than named as phantom tabs; remote
 * (openclaw) sessions carry db-only liveness until Slice 2b lands, which is
 * the honest best we can do for them today.
 *
 * A session whose liveness could NOT be established (`o.live === null`, a tmux
 * too wedged to answer) is NAMED. This reverses the #340 locked decision of
 * "confirmed-live only" on purpose, and the asymmetry is the reason: failing
 * to warn lets a session commit into the wrong repo, while warning about a tab
 * that turns out to be closed costs the operator one sentence they can
 * override. Recorded in `.prawduct/artifacts/session-ownership-primitive.md`.
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
      // `live === null` is "tmux could not be asked", not "no session". The
      // guard's job is to warn that another project may be open in another
      // tab, so an unestablished liveness must be NAMED rather than dropped:
      // under-warning here means a session quietly commits into the wrong
      // repo, while over-warning costs the operator one sentence.
      .filter((o) => o.live !== false)
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
  resolveOperatorHost,
  _localHost,
  _detectMagicDnsName,
  _hostFromHeader,
  NON_OPERATOR_HOSTS,
  _resetHostCacheForTest,
  _internal,
  _transportOf,
  _resolveHost,
  _liveness,
  _toOwnership
};
