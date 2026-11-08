'use strict';

/**
 * The `/api/sessions/:project/engine-health*` and `/engine-failover` route
 * family (#109): a background probe loop classifies each project's active
 * engine as HEALTHY, DEGRADED, or CRASHED (via `lib/engine-health.js`), a
 * GET surfaces that classification plus recent crash telemetry, and a POST
 * carries out a user-confirmed recovery action — restart, swap to another
 * engine, continue manually, or kill. **Never auto-swap**: every mutating
 * action here refuses outright unless the request body says
 * `userConfirmed: true`, checked before anything else.
 *
 * Engine addressing follows the session model as it actually exists, not
 * the issue's own sketch: a project has at most one active session, keyed
 * by project NAME (`:project`, matching `DELETE /api/sessions/:project` and
 * every other session-lifecycle route — not an opaque `:sessionId`, which
 * nothing in this codebase uses for addressing a session route). A tmux
 * engine is probed directly (`lib/engine-health.js#probeTmuxEngine`); a
 * `webui` engine is OpenClaw specifically in this codebase (`sessionMode:
 * 'webui'` only ever means an OpenClaw connection, `getSessionStatus`'s own
 * branch confirms it), reached over SSH rather than a bare fetchable HTTP
 * endpoint — so this bridges to the health level `lib/sidecar.js` already
 * polls and caches for the OpenClaw header pills (#128), instead of
 * re-probing a URL that does not exist on these connections.
 * `probeWebuiEngine`'s own generic HTTP form stays in `lib/engine-health.js`
 * for an engine that genuinely has one; nothing here calls it.
 *
 * Kill and restart reuse `lib/sessions.js#killSession`/`launchSession` and
 * their existing `_requireSessionLifecycleCaller` gate UNCHANGED — this
 * family adds the `userConfirmed` requirement on top, never a weaker path
 * around it. A swap's handoff prime is delivered as a follow-up
 * `injectCommand` call after the new engine launches (`lib/sessions.js`
 * does not expose a hook to splice custom text into its own generated
 * prime, and that file is outside this car's scope) — truncated to
 * `injectCommand`'s 4096-char cap. This is a known, flagged limitation:
 * `injectCommand` is called once `launchSession` has returned, which proves
 * the engine already accepted its own first prime, but neither function is
 * promise-based here, so there is no await to hang this second send on
 * beyond that — reviewed and accepted rather than silently assumed safe.
 *
 * @module lib/routes/engine-health-routes
 */

const store = require('../store');
const projects = require('../projects');
const sessions = require('../sessions');
const sidecar = require('../sidecar');
const engineHealth = require('../engine-health');
const { route, jsonResponse, errorResponse } = require('./_kernel');
const { _requireOperatorWrite, _requireSessionLifecycleCaller } = require('./_callers');

/** Per-project probe state (strikes, last captured terminal lines). Module-level: one process, one fleet. */
const _tracker = engineHealth.createHealthTracker();

/** Project names with the `longRunningTask` suppression flag on. */
const _suppressed = new Set();

/** Crash telemetry, newest first — a running diagnostic, not a durable log (see `lib/engine-health.js`). */
const _telemetry = [];

/** Project name -> ms the current active session started, for a crash's `durationMs`. */
const _startedAtMs = new Map();

let _probeTimer = null;

/**
 * Classify a `webui` (OpenClaw) session's health from the telemetry
 * `lib/sidecar.js` already polls, in `lib/engine-health.js#probeTmuxEngine`'s
 * result shape, so `recordProbeResult` can treat either kind of probe the same.
 * @param {string} projectName - The project to classify.
 * @returns {{answered: boolean, live: boolean, cause: string|null}}
 */
function _probeWebuiOnce(projectName) {
  const connId = sidecar.resolveConnectionId(projectName);
  if (!connId) return { answered: false, live: false, cause: 'no-openclaw-connection' };
  const { health } = sidecar.getTelemetry(connId);
  if (!health) return { answered: false, live: false, cause: 'no-telemetry-yet' };
  if (health.level === 'alarm') return { answered: true, live: false, cause: health.healthSummary };
  if (health.level === 'ok' || health.level === 'warn') return { answered: true, live: true, cause: null };
  return { answered: false, live: false, cause: health.healthSummary || 'unverified' };
}

/**
 * One probe round over every project with an active session.
 * @returns {void}
 */
function _probeOnce() {
  let rows;
  try {
    rows = store.projects.list();
  } catch { // prawduct:allow prawduct/broad-except -- a probe round skipping itself on a store read failure is strictly better than crashing the server's own interval
    return;
  }
  for (const project of rows) {
    let active;
    try {
      active = store.sessions.getActive(project.id);
    } catch { // prawduct:allow prawduct/broad-except -- same as above, per-project
      continue;
    }
    if (!active) {
      _tracker.delete(project.name);
      _startedAtMs.delete(project.name);
      continue;
    }
    if (!_startedAtMs.has(project.name)) _startedAtMs.set(project.name, Date.now());

    let probeResult;
    if (active.sessionMode === 'webui') {
      probeResult = _probeWebuiOnce(project.name);
    } else if (active.tmuxSession) {
      probeResult = engineHealth.probeTmuxEngine(active.tmuxSession);
    } else {
      continue; // No addressable pane or connection to probe this round.
    }

    const classification = engineHealth.recordProbeResult(
      _tracker, project.name, probeResult, { suppressProbe: _suppressed.has(project.name) }
    );
    if (classification.state === engineHealth.STATES.CRASHED) {
      const startedAt = _startedAtMs.get(project.name) || Date.now();
      engineHealth.recordCrashTelemetry(_telemetry, {
        engine: active.engineId,
        durationMs: Date.now() - startedAt,
        crashedAt: new Date().toISOString(),
        reason: classification.reason
      });
      _startedAtMs.delete(project.name);
    }
  }
}

/**
 * Start the background probe loop. Safe to call when already running.
 * @param {object} [opts] - Options.
 * @param {number} [opts.intervalMs] - Probe interval. Defaults to `engineHealth.DEFAULT_PROBE_INTERVAL_MS`.
 * @returns {void}
 */
function startEngineHealthProbeLoop(opts = {}) {
  if (_probeTimer) return;
  const intervalMs = opts.intervalMs || engineHealth.DEFAULT_PROBE_INTERVAL_MS;
  _probeTimer = setInterval(_probeOnce, intervalMs);
  if (_probeTimer.unref) _probeTimer.unref();
}

/**
 * Stop the background probe loop. Safe to call when not running.
 * @returns {void}
 */
function stopEngineHealthProbeLoop() {
  if (!_probeTimer) return;
  clearInterval(_probeTimer);
  _probeTimer = null;
}

/**
 * The GET payload: current classification plus this project's slice of the
 * shared crash telemetry log.
 * @param {string} projectName - Project name.
 * @param {object} project - Project row (for `engineId` when there is no active session).
 * @returns {object}
 */
function _statusPayload(projectName, project) {
  const active = store.sessions.getActive(project.id);
  const entry = _tracker.get(projectName);
  return {
    project: projectName,
    active: !!active,
    engine: active ? active.engineId : null,
    sessionMode: active ? (active.sessionMode || 'tmux') : null,
    state: entry ? _classificationFromStrikes(entry) : (active ? engineHealth.STATES.HEALTHY : null),
    strikes: entry ? entry.strikes : 0,
    suppressed: _suppressed.has(projectName),
    probeIntervalMs: engineHealth.DEFAULT_PROBE_INTERVAL_MS,
    recentCrashes: _telemetry.filter((t) => active && t.engine === active.engineId).slice(0, 10)
  };
}

/**
 * The tracker only stores strikes and cached lines, not the last resolved
 * state — re-derive it the same way `recordProbeResult` would report it for
 * a GET that must not itself count as a probe (reading status must never
 * perturb the strike count).
 * @param {{strikes: number}} entry - A tracker entry.
 * @returns {string}
 */
function _classificationFromStrikes(entry) {
  if (entry.strikes >= engineHealth.UNRESPONSIVE_STRIKES_FOR_CRASHED) return engineHealth.STATES.CRASHED;
  if (entry.strikes > 0) return engineHealth.STATES.DEGRADED;
  return engineHealth.STATES.HEALTHY;
}

/**
 * Register this family's routes.
 * @returns {void}
 */
function register() {
  // GET /api/sessions/:project/engine-health — current classification + recent crash telemetry.
  // Unauthenticated, same as the sibling `GET /api/sessions/:project/status` this complements:
  // a per-project read is scoped to one project's own status, not the fleet-wide reach
  // `_requireOperatorRead` exists for (that gate's own doc says so explicitly), so this route
  // relies on the same network-level perimeter every other per-project status read does.
  route('GET', '/api/sessions/:project/engine-health', (req, res, params) => {
    const project = store.projects.getByName(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');

    jsonResponse(res, 200, _statusPayload(params.project, project));
  });

  // POST /api/sessions/:project/engine-health/suppress — toggle the longRunningTask flag.
  // Body: {suppressProbe: boolean}
  route('POST', '/api/sessions/:project/engine-health/suppress', (req, res, params, body) => {
    const proof = _requireOperatorWrite(req, res, {
      logEvent: 'Refused an engine health suppression toggle',
      logContext: { project: params.project },
      fallbackAction: 'toggle a project\'s engine health probe suppression',
      sameOriginWhat: 'An engine health probe suppression toggle',
      unauthenticated: 'Sign in to toggle engine health probe suppression: this install requires a login.',
      machineClient: 'Engine health probe suppression is an operator\'s decision, and a local process is not one.',
      openToken: 'This install has no login, so a probe suppression toggle must carry the anti-forgery token its '
        + 'dashboard was issued. Reload the dashboard and try again.',
      gateUnsupported: (gateState) =>
        `Engine health probe suppression cannot be toggled while the login gate is "${gateState}". Resolve the `
        + 'gate first.'
    });
    if (!proof) return;

    if (!body || typeof body !== 'object' || typeof body.suppressProbe !== 'boolean') {
      return errorResponse(res, 400, 'The request body must carry a boolean `suppressProbe`.', 'BAD_REQUEST');
    }
    const project = store.projects.getByName(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');

    if (body.suppressProbe) _suppressed.add(params.project);
    else _suppressed.delete(params.project);

    jsonResponse(res, 200, { gateState: proof.clearance, project: params.project, suppressed: body.suppressProbe });
  });

  // POST /api/sessions/:project/engine-failover — the user-confirmed recovery action.
  // Body: {action: 'restart'|'swap'|'kill'|'continue-manually', userConfirmed: true, targetEngine?, reason?}
  route('POST', '/api/sessions/:project/engine-failover', (req, res, params, body) => {
    if (!body || typeof body !== 'object' || body.userConfirmed !== true) {
      // Checked before any proof or gate: "no auto-swap" means an unconfirmed
      // request never even reaches the question of who is asking.
      return errorResponse(
        res, 400,
        'An engine failover action requires explicit confirmation: the request body must carry `userConfirmed: true`.',
        'USER_CONFIRMATION_REQUIRED'
      );
    }
    const { action, targetEngine } = body;
    if (!['restart', 'swap', 'kill', 'continue-manually'].includes(action)) {
      return errorResponse(res, 400, `Unknown engine failover action "${action}".`, 'BAD_REQUEST');
    }
    if (action === 'swap' && typeof targetEngine !== 'string') {
      return errorResponse(res, 400, 'A "swap" action requires `targetEngine`.', 'BAD_REQUEST');
    }

    const project = store.projects.getByName(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');

    if (action === 'continue-manually') {
      const proof = _requireOperatorWrite(req, res, _continueManuallyProof);
      if (!proof) return;
      return jsonResponse(res, 200, { gateState: proof.clearance, project: params.project, action });
    }

    // restart | swap | kill: the kill half is always needed (a restart or
    // swap begins by ending the crashed/degraded engine's session), so this
    // is the gate every one of them must pass, with `allowOwnProject: false`
    // unchanged — the same "never Kill through self-authorization" rule the
    // existing DELETE route enforces.
    if (!_requireSessionLifecycleCaller(req, res, { action: 'kill', targetProject: project, allowOwnProject: false, body })) {
      return;
    }
    const passwordCheck = projects.checkDeletePassword(body.password);
    if (!passwordCheck.allowed) return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');

    const active = store.sessions.getActive(project.id);
    const crashedEngine = active ? active.engineId : null;
    const lastLines = engineHealth.lastKnownLines(_tracker, params.project);
    const reason = body.reason || `engine-failover: user-confirmed ${action}`;

    const killResult = sessions.killSession(params.project, reason);
    if (killResult.error && !killResult.reconciled) {
      if (killResult.error.includes('not found') || killResult.error.includes('No active')) {
        return errorResponse(res, 404, killResult.error, 'NOT_FOUND');
      }
      return errorResponse(res, 500, killResult.error, 'INTERNAL_ERROR');
    }

    if (action === 'kill') {
      return jsonResponse(res, 200, { project: params.project, action, killed: true });
    }

    // restart | swap: the relaunch half needs its own lifecycle proof —
    // `_requireSessionLifecycleCaller` answers "may THIS action happen",
    // separately for each action, exactly as `action: 'launch'` already
    // does for the plain launch route this reuses.
    if (!_requireSessionLifecycleCaller(req, res, { action: 'launch', targetProject: project, allowOwnProject: false, body })) {
      return;
    }
    const launchOptions = action === 'swap' ? { engineOverride: targetEngine } : {};
    const launchResult = sessions.launchSession(params.project, launchOptions);
    if (launchResult.error) {
      return errorResponse(res, 500, launchResult.error, 'INTERNAL_ERROR', { killedFirst: true });
    }

    let handoffPrime = null;
    if (action === 'swap' && crashedEngine) {
      const prime = engineHealth.buildFailoverHandoffPrime({
        previousEngine: crashedEngine,
        crashedAt: new Date().toISOString(),
        lastAction: body.lastAction || null,
        lastTerminalLines: lastLines || []
      });
      // injectCommand's own cap (lib/sessions.js, 4096 chars) is a CALLER
      // limit, not a framing one — truncate here rather than let a long
      // capture make the whole handoff silently fail to send.
      handoffPrime = prime.length > 4096 ? `${prime.slice(0, 4093)}...` : prime;
      sessions.injectCommand(params.project, handoffPrime);
    }

    jsonResponse(res, 200, {
      project: params.project,
      action,
      killed: true,
      relaunched: true,
      engine: launchResult.session ? launchResult.session.engineId : null,
      handoffPrimeSent: handoffPrime !== null
    });
  });
}

/** `_requireOperatorWrite` options for the lightweight `continue-manually` action. */
const _continueManuallyProof = {
  logEvent: 'Refused an engine failover "continue manually" acknowledgement',
  fallbackAction: 'acknowledge an engine failover notice',
  sameOriginWhat: 'An engine failover acknowledgement',
  unauthenticated: 'Sign in to acknowledge an engine failover notice: this install requires a login.',
  machineClient: 'Acknowledging an engine failover notice is an operator\'s decision, and a local process is not one.',
  openToken: 'This install has no login, so acknowledging an engine failover notice must carry the anti-forgery '
    + 'token its dashboard was issued. Reload the dashboard and try again.',
  gateUnsupported: (gateState) =>
    `An engine failover notice cannot be acknowledged while the login gate is "${gateState}". Resolve the gate first.`
};

module.exports = {
  register,
  startEngineHealthProbeLoop,
  stopEngineHealthProbeLoop,
  // Test seams: a suite drives probe rounds and reads the shared state
  // directly rather than waiting out a real interval or faking a clock.
  _probeOnce,
  _tracker,
  _suppressed,
  _telemetry
};
