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
const { _requireOperatorWrite, _requireSessionLifecycleCaller, coordinatorGateRefused } = require('./_callers');

/** Per-project probe state (strikes, last captured terminal lines). Module-level: one process, one fleet. */
const _tracker = engineHealth.createHealthTracker();

/**
 * Project name -> the session id suppression applies to (`longRunningTask`,
 * or an acknowledged `continue-manually`/`kill`). PRR-B finding: a plain
 * `Set<projectName>` outlives the session it was set for — a project-name
 * key with no session scope stays set across a LATER, ordinary launch that
 * never goes through this family's own restart/swap cleanup, silently
 * hiding that new session's own, genuinely different crashes forever.
 * Scoped by session id so a different session (by definition a different
 * id) is never suppressed by an earlier one's acknowledgement.
 */
const _suppressed = new Map();

/**
 * Whether suppression is in force for exactly this project's exactly this
 * session — never a stale entry left over from an earlier one.
 * @param {string} projectName - Project name.
 * @param {number|null|undefined} sessionId - The session suppression is being checked against.
 * @returns {boolean}
 */
function _isSuppressed(projectName, sessionId) {
  return sessionId != null && _suppressed.get(projectName) === sessionId;
}

/** Crash telemetry, newest first — a running diagnostic, not a durable log (see `lib/engine-health.js`). */
const _telemetry = [];

/** Project name -> ms the current active session started, for a crash's `durationMs`. */
const _startedAtMs = new Map();

/**
 * Project name -> the session id `_tracker`'s entry (and `_startedAtMs`)
 * actually describe. PRR-B Round 3 finding: `_tracker` is keyed by project
 * name alone, so a CRASHED entry from a session that just ended is still
 * sitting there, unchanged, the instant a brand new session starts for the
 * same project — and `_probeOnce`'s own interval (up to
 * `DEFAULT_PROBE_INTERVAL_MS`) may not run again for a while to overwrite
 * it. A GET in that window would read the old entry as if it described the
 * new session. Checked (never written) by `_statusPayload`, a pure read;
 * written only by `_probeOnce`, the one place that actually resets state
 * for a session transition.
 */
const _currentSessionId = new Map();

/**
 * If `sessionId` is not the one `_tracker`/`_startedAtMs` currently
 * describe for `projectName`, this IS a session transition this probe
 * round has not reconciled yet — clear the stale entries before anything
 * below reads or writes them, and record which session owns them now.
 * Read-only call sites (`_statusPayload`) must never call this; they only
 * check `_currentSessionId` and treat a mismatch as "not yet probed",
 * never mutate on a read.
 * @param {string} projectName - Project name.
 * @param {number} sessionId - The session now active for this project.
 * @returns {void}
 */
function _reconcileSessionTransition(projectName, sessionId) {
  if (_currentSessionId.get(projectName) === sessionId) return;
  _currentSessionId.set(projectName, sessionId);
  _tracker.delete(projectName);
  _startedAtMs.delete(projectName);
}

/**
 * Session ids this family has already recorded telemetry for — not project
 * names, because `lib/sessions.js`'s OWN status read (every `pollStatus` tick
 * on the session page, far faster than this family's `DEFAULT_PROBE_INTERVAL_MS`)
 * can mark a tmux session `crashed` before this probe loop's next tick ever
 * runs. Keyed by session id so the one crash is recorded once however it was
 * first observed, by either path.
 */
const _telemetryRecordedFor = new Set();

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
      // No active row — but `lib/sessions.js`'s own status read may already
      // have marked the session `crashed` (ended) faster than this loop's
      // own interval could. Record the telemetry this family owns, once per
      // session id, however it was first observed (PRR-B/Architect finding:
      // a crash caught by that faster path was invisible here entirely).
      const latest = store.sessions.getLatest(project.id);
      if (latest && latest.status === 'crashed' && !_telemetryRecordedFor.has(latest.id)) {
        _telemetryRecordedFor.add(latest.id);
        engineHealth.recordCrashTelemetry(_telemetry, {
          engine: latest.engineId,
          durationMs: (latest.durationSeconds || 0) * 1000,
          crashedAt: latest.endedAt || new Date().toISOString(),
          reason: latest.stopReason || 'tmux session died'
        });
      }
      _tracker.delete(project.name);
      _startedAtMs.delete(project.name);
      _currentSessionId.delete(project.name);
      continue;
    }
    // PRR-B Round 3 finding: if this is a different session than the one
    // `_tracker`/`_startedAtMs` last described (a new launch since the
    // previous tick, possibly without this loop ever observing the gap in
    // between), their old entries belong to a session that is gone — clear
    // them before anything below reads or writes them.
    _reconcileSessionTransition(project.name, active.id);
    if (!_startedAtMs.has(project.name)) _startedAtMs.set(project.name, Date.now());

    let probeResult;
    if (active.sessionMode === 'webui') {
      probeResult = _probeWebuiOnce(project.name);
    } else if (active.tmuxSession) {
      probeResult = engineHealth.probeTmuxEngine(active.tmuxSession);
    } else {
      continue; // No addressable pane or connection to probe this round.
    }

    // Captured before `recordProbeResult` mutates the tracker entry in
    // place — the only way to tell "just became CRASHED" from "still
    // CRASHED since an earlier tick" (PRR-B/Architect F2: recording
    // telemetry on every CRASHED tick, with `_startedAtMs` re-seeded each
    // time, clobbered `recentCrashes[0]` with `durationMs` near zero).
    const existing = _tracker.get(project.name);
    const prevState = existing ? existing.state : engineHealth.STATES.HEALTHY;

    const classification = engineHealth.recordProbeResult(
      _tracker, project.name, probeResult, { suppressProbe: _isSuppressed(project.name, active.id) }
    );
    if (classification.state === engineHealth.STATES.CRASHED && prevState !== engineHealth.STATES.CRASHED) {
      const startedAt = _startedAtMs.get(project.name) || Date.now();
      engineHealth.recordCrashTelemetry(_telemetry, {
        engine: active.engineId,
        durationMs: Date.now() - startedAt,
        crashedAt: new Date().toISOString(),
        reason: classification.reason
      });
      // `_startedAtMs` is NOT cleared here: the crashed row is still
      // `active` in the store (nothing here ends a session on its own),
      // so the very next tick would otherwise re-seed it to `Date.now()`
      // via the check at the top of this loop and repeat the same bug.
      // It is cleared only when the session genuinely ends (above) or a
      // recovery action runs (kill/restart/swap, in the route handler).
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

  if (active) {
    // PRR-B Round 3 finding: `_tracker`'s entry for this project name can
    // belong to a session that already ended — trust it only when
    // `_currentSessionId` agrees it is still describing THIS session.
    // Never reconciled here: a GET must not perturb state
    // (`_reconcileSessionTransition` is `_probeOnce`'s job alone). A
    // mismatch (including "never probed yet") reads as "nothing observed
    // for this session" — HEALTHY, not a stale verdict from a different one.
    const entryIsCurrent = _currentSessionId.get(projectName) === active.id;
    const entry = entryIsCurrent ? _tracker.get(projectName) : null;
    // PRR-B finding: suppression scoped to THIS session's id, never a
    // stale entry an earlier, different session left behind — see
    // `_isSuppressed`.
    const suppressed = _isSuppressed(projectName, active.id);
    return {
      project: projectName,
      active: true,
      engine: active.engineId,
      sessionMode: active.sessionMode || 'tmux',
      // PRR-B/Architect F1: `entry.state` is the tracker's own last-resolved
      // classification, not re-derived from `strikes` — an immediate CRASHED
      // from an answered-but-not-live probe carries `strikes: 0`, which a
      // strikes-only read cannot tell apart from HEALTHY. Suppression still
      // overrides to HEALTHY here regardless of what the tracker holds
      // (`continue-manually` reuses the same flag — see the POST handler —
      // so this is also what stops the modal from re-opening after it).
      state: suppressed ? engineHealth.STATES.HEALTHY : (entry ? entry.state : engineHealth.STATES.HEALTHY),
      strikes: entry ? entry.strikes : 0,
      suppressed,
      probeIntervalMs: engineHealth.DEFAULT_PROBE_INTERVAL_MS,
      recentCrashes: _telemetry.filter((t) => t.engine === active.engineId).slice(0, 10)
    };
  }

  // No active row. PRR-B/Architect (the "recovery 404" finding):
  // `lib/sessions.js`'s own status read already probes tmux on every
  // session-page poll and marks a dead session `crashed` (ended) — often
  // well before this family's own, slower probe interval would catch it.
  // Recognizing that here (rather than reporting "no session") is what lets
  // `GET .../engine-health` and the modal it feeds answer honestly for the
  // common case, and what lets the POST handler below treat the row as
  // already-terminated instead of 404ing on a `killSession` call that has
  // nothing left to kill.
  const latest = store.sessions.getLatest(project.id);
  const justCrashed = !!(latest && latest.status === 'crashed');
  const suppressed = justCrashed && _isSuppressed(projectName, latest.id);
  return {
    project: projectName,
    active: false,
    engine: justCrashed ? latest.engineId : null,
    sessionMode: justCrashed ? (latest.sessionMode || 'tmux') : null,
    state: justCrashed ? (suppressed ? engineHealth.STATES.HEALTHY : engineHealth.STATES.CRASHED) : null,
    strikes: 0,
    suppressed,
    probeIntervalMs: engineHealth.DEFAULT_PROBE_INTERVAL_MS,
    recentCrashes: justCrashed ? _telemetry.filter((t) => t.engine === latest.engineId).slice(0, 10) : []
  };
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
    const project = store.projects.getByName(params.project);
    // Coordinator-epoch gate (Rule #286's own test, test/api-coordinator-
    // rotation.test.js): every mutating /api/sessions/:project/* route must
    // either declare `gatedAction` (below) and actually enforce it inline,
    // or name a reviewed reason it does not. Matches the convention every
    // other route in this family (lib/routes/sessions.js) already uses —
    // checked before any other proof, same as e.g. POST .../merge-gate/holds.
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;
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
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');

    if (body.suppressProbe) {
      // Scoped to the session this request was actually about — a long-
      // running-task flag set for THIS session must not silently carry
      // over and suppress a later, different session's own crashes.
      const active = store.sessions.getActive(project.id);
      if (active) _suppressed.set(params.project, active.id);
    } else {
      _suppressed.delete(params.project);
    }

    jsonResponse(res, 200, { gateState: proof.clearance, project: params.project, suppressed: body.suppressProbe });
  }, { gatedAction: 'session-command' });

  // POST /api/sessions/:project/engine-failover — the user-confirmed recovery action.
  // Body: {action: 'restart'|'swap'|'kill'|'continue-manually', userConfirmed: true, targetEngine?, reason?}
  route('POST', '/api/sessions/:project/engine-failover', (req, res, params, body) => {
    const project = store.projects.getByName(params.project);
    // Coordinator-epoch gate, same convention as every other gatedAction
    // route in this codebase (test/api-coordinator-rotation.test.js's own
    // generic sweep documents it: "the gate runs before body validation on
    // every one of these handlers") — checked first, before this route's
    // own userConfirmed/action checks below, not after them. "No auto-swap"
    // still holds: a stale-epoch coordinator is refused before it, and
    // everyone else, reaches the confirmation question at all.
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;

    if (!body || typeof body !== 'object' || body.userConfirmed !== true) {
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
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');

    if (action === 'continue-manually') {
      const proof = _requireOperatorWrite(req, res, _continueManuallyProof);
      if (!proof) return;
      // PRR-B/Architect F3: without this, the next poll (seconds later, on
      // the session page's existing cadence) sees the same CRASHED
      // classification and reopens the non-dismissible modal right back
      // over the choice the operator just made. Reuses the same flag the
      // `longRunningTask` suppress toggle uses — the Architect's own
      // suggested fix — cleared below once a real recovery action runs.
      // Scoped to the exact session this acknowledgement was about (PRR-B
      // Round 2 finding): a session row might still be `active` (the
      // DEGRADED/CRASHED-by-this-family's-own-tracker case) or already
      // `crashed` (the faster existing detector got there first) — either
      // way, suppress THAT one, never the project generically.
      const relevantSession = store.sessions.getActive(project.id) || store.sessions.getLatest(project.id);
      if (relevantSession) _suppressed.set(params.project, relevantSession.id);
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
    // PRR-B/Architect finding: the relaunch half's own lifecycle proof used
    // to be checked AFTER the kill already ran, which is irreversible — an
    // unauthorized relaunch left the session dead with no path back except
    // a second request. Checked here, before anything is touched, so
    // restart/swap either has both authorizations or mutates nothing.
    if (action !== 'kill'
      && !_requireSessionLifecycleCaller(req, res, { action: 'launch', targetProject: project, allowOwnProject: false, body })) {
      return;
    }
    const passwordCheck = projects.checkDeletePassword(body.password);
    if (!passwordCheck.allowed) return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');

    const active = store.sessions.getActive(project.id);
    let crashedEngine = active ? active.engineId : null;
    const lastLines = engineHealth.lastKnownLines(_tracker, params.project);
    const reason = body.reason || `engine-failover: user-confirmed ${action}`;

    if (active) {
      const killResult = sessions.killSession(params.project, reason);
      if (killResult.error && !killResult.reconciled) {
        if (killResult.error.includes('No active')) {
          // Raced with `lib/sessions.js`'s own, faster tmux-crash detector
          // between this handler's `getActive` read and `killSession`'s own
          // — the row ended in between. Falls through to the
          // already-terminated handling below, same as the `!active` branch.
        } else if (killResult.error.includes('not found')) {
          return errorResponse(res, 404, killResult.error, 'NOT_FOUND');
        } else {
          return errorResponse(res, 500, killResult.error, 'INTERNAL_ERROR');
        }
      }
    } else {
      // PRR-B/Architect "recovery 404" finding: `lib/sessions.js`'s own
      // status read (every `pollStatus` tick, far faster than this family's
      // own probe interval) may already have marked the session `crashed`
      // — there is nothing left to kill. `kill` now succeeds idempotently;
      // `restart`/`swap` proceed straight to launching the replacement
      // rather than 404ing on a session that is already gone. A project
      // with no session at all (never launched, or genuinely unknown) still
      // 404s, below.
      const latest = store.sessions.getLatest(project.id);
      if (!latest) return errorResponse(res, 404, `No active session for "${params.project}"`, 'NOT_FOUND');
      if (!crashedEngine) crashedEngine = latest.engineId;
    }

    // A recovery action is in progress: whatever the tracker remembers
    // about the crash that triggered it no longer describes what happens
    // next — kept past this point it would either stale-report a session
    // that no longer exists (kill) or re-seed telemetry against the wrong
    // baseline for the one about to launch (restart/swap). Also lifts any
    // suppression `continue-manually` left behind, so a later, genuinely
    // new crash on this project is not silently swallowed by it.
    //
    // A plain `kill` leaving `_suppressed` cleared means the very next GET
    // can see the (unchangeable — `store.sessions` transitions are one-way)
    // `crashed` row and report CRASHED again. That is deliberately this
    // route's problem alone to answer honestly, not something papered over
    // here — `public/engine-failover-modal.js`'s own `justActedOn` flag is
    // what stops the modal from reopening client-side after a confirmed
    // kill, the same tick that lets `pollStatus`'s generic ended-flow take
    // over as it should once the operator has explicitly ended the session.
    _tracker.delete(params.project);
    _startedAtMs.delete(params.project);
    _suppressed.delete(params.project);
    // So a `restart`/`swap`'s new session is never read against this
    // project's PRIOR session id — the first GET after it launches must
    // see "not yet probed" (HEALTHY), never whatever `_currentSessionId`
    // last recorded, until `_probeOnce` reconciles the real new session id.
    _currentSessionId.delete(params.project);

    if (action === 'kill') {
      return jsonResponse(res, 200, { project: params.project, action, killed: true });
    }

    const launchOptions = action === 'swap' ? { engineOverride: targetEngine } : {};
    const launchResult = sessions.launchSession(params.project, launchOptions);
    if (launchResult.error) {
      return errorResponse(res, 500, launchResult.error, 'INTERNAL_ERROR', { killedFirst: true });
    }

    let handoffPrime = null;
    let handoffPrimeSent = false;
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
      // PRR-B/Architect finding: the result was discarded, so a failed
      // injection (e.g. the fresh pane refusing a send) was reported as
      // sent anyway. `injectCommand`'s own `{ok, error}` is checked here.
      const injectResult = sessions.injectCommand(params.project, handoffPrime);
      handoffPrimeSent = !!(injectResult && injectResult.ok);
    }

    jsonResponse(res, 200, {
      project: params.project,
      action,
      killed: true,
      relaunched: true,
      engine: launchResult.session ? launchResult.session.engineId : null,
      handoffPrimeSent
    });
  }, { gatedAction: 'session-command' });
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
