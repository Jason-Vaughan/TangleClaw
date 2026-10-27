'use strict';

/**
 * The `tc` command line's routes — the launch sequence (`start/next`,
 * `start/ready`, `start/status`, `start/review`) and the rules-delivery
 * receipt, the lane's own workload write and read and the operator's narrowing,
 * the governed coordinator rotation with the operator's rotation and
 * coordinator-role reads, the identity answer (`whoami`) and the fleet roster
 * (`sessions`), and the check watches a session registers on a named check
 * (`check-watches`) — with the helpers only this family holds: the launch identity
 * a request carries, the capability rows `whoami` reports, the binding verdict
 * and the awareness receipt every tc invocation records, and the lane
 * composition the roster and the operator bridge both read, moved out of
 * `server.js` unchanged (#2248). `/api/rotations` and `/api/coordinator-roles`
 * are here because they share the rotation helpers.
 *
 * `register(deps)` registers the routes through the shared kernel, in the
 * order they held in `server.js`; the entry point calls it at the position
 * the family's first route held, so the route table reads as before apart
 * from the operator bridge's routes, which registered between the workload
 * routes and the rotation ones and now follow the family. The activity
 * observer is one instance the entry point creates and other families share,
 * so it arrives through `deps` and is held here for the lane composition,
 * which the entry point reads back for the bridge's lane reader. The
 * coordinator epoch gate the workload write applies lives with the other
 * caller-identity helpers in `./_callers`, where every family that applies
 * it can reach it.
 *
 * @module lib/routes/tc
 */

const { createLogger } = require('../logger');
const store = require('../store');
const engines = require('../engines');
const launchSequence = require('../launch-sequence');
const master = require('../master');
const sharedDocsAccess = require('../shared-docs-access');
const launchBindingGuard = require('../launch-binding-guard');
const workload = require('../workload');
const coordinatorRotation = require('../coordinator-rotation');
const workloadFleet = require('../workload-fleet');
const startupControl = require('../startup-control');
const httpsSetup = require('../https-setup');
const sessionOwnership = require('../session-ownership');
const checkWatchApi = require('../check-watch-api');
const medusaRegistry = require('../medusa-registry');
const { workloadSentence } = require('../ecosystem-primer');
const { resolveControlCaller } = require('../control-auth');
const { route, jsonResponse, errorResponse, reqUrl, parseQuery, MESSAGE_BODY_LIMIT_BYTES } = require('./_kernel');
const { _callerProjectId, coordinatorGateRefused, _engineThread } = require('./_callers');

// The logger keeps the entry point's name so every log line this family writes
// reads exactly as it did before the move.
const log = createLogger('server');

// The activity observer the entry point creates, set by `register`. One
// instance, shared with the session lifecycle routes and the boot monitors,
// and never replaced: the tests that stub a reading stub its method.
let activityObserver;

/**
 * The identity a pane presents to the launch-sequence routes: the launch id
 * TangleClaw exported into it, and the project id it already carries. Both are
 * claims, and the sequence lookup validates them against each other — neither
 * is a credential (see `lib/launch-sequence.js`).
 *
 * The Project Master's pane carries a launch id too, but only as its shared-docs
 * binding (#1626): it is never phased-launched, so it has no sequence. A Master
 * request (role header, no project claim) is answered as a pane without a
 * sequence, the answer it got before it carried the id. Without this its
 * unrecorded id reads as a launch still recording, and `tc start` retries and
 * then reports a failed launch.
 * @param {object} req - The request
 * @returns {{launchId: string|null, projectId: number|null}}
 */
function _launchIdentity(req) {
  const raw = req.headers['x-tangleclaw-launch-id'];
  const projectRaw = req.headers['x-tangleclaw-project-id'];
  const projectId = Number(projectRaw);
  if (req.headers['x-tangleclaw-role'] === 'master' && projectRaw === undefined) {
    return { launchId: null, projectId: null };
  }
  return {
    launchId: typeof raw === 'string' && raw ? raw : null,
    projectId: Number.isInteger(projectId) ? projectId : null
  };
}

// Governed coordinator context rotation (#2032). A coordinator prepares its
// own rotation with a structured checkpoint; the server fences its new
// dispatch, types /clear, binds the one replacement thread it can prove and
// delivers a re-entry turn; the replacement context resumes with a receipt the
// server cross-checks before lifting the fence. Prepare, show, advance and
// resume are bound to the caller's own verified launch, like workload; the
// relaunch claim, abandon and the operator reads are the operator's alone.

/**
 * The caller's verified launch for a rotation route, or a refusal written to
 * `res`.
 * @param {object} req - The request.
 * @param {object} res - The response.
 * @returns {object|null} The access, or null when refused.
 */
function _rotationAccess(req, res) {
  const access = sharedDocsAccess.resolveAccess(req);
  if (access.kind === sharedDocsAccess.KINDS.PROJECT) return access;
  const why = access.kind === sharedDocsAccess.KINDS.INVALID ? access.reason : access.kind;
  errorResponse(res, 403, 'A coordinator rotation is prepared, read and resumed only by the session\'s own verified launch '
    + `(x-tangleclaw-project-id and x-tangleclaw-launch-id). This caller is ${why}.`, 'ROTATION_BINDING_REQUIRED', { reason: why });
  return null;
}

/**
 * The `provenance-watermark` capability row for whoami (ADR 0019): whether
 * this project stamps its private generated files, and which ones. Read-only —
 * the setting is the operator's, changed in Project Settings, so the detail
 * names no mutation route. Surfaces are reported by id, never by path.
 * @param {object|null} project - The resolved project row, if any.
 * @param {object|null} projConfig - That project's config (defaults merged).
 * @returns {{id: string, enabled: boolean, detail: string}}
 */
function _provenanceCapability(project, projConfig) {
  if (!project || !projConfig) {
    return { id: 'provenance-watermark', enabled: false, detail: 'unavailable: this call did not resolve to a registered project' };
  }
  let report;
  try {
    report = engines.provenanceSurfaces(project.path, projConfig, project.engineId, engines.resolveProfile(project.engineId));
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- a read-only report must not cost
    // the caller the rest of its capability roster; the failure is named instead.
    log.warn('Could not report the provenance surfaces', { project: project.name, error: err.message });
    return { id: 'provenance-watermark', enabled: false, detail: 'unavailable: TangleClaw could not read this project\'s provenance setting' };
  }
  const unstamped = report.unstamped.map((u) => `${u.surfaceId} (${u.reason})`).join(', ');
  const scope = `surfaces that carry it: ${report.stamped.join(', ')}${unstamped ? `; not: ${unstamped}` : ''}`;
  return {
    id: 'provenance-watermark',
    enabled: report.enabled,
    detail: report.enabled
      ? `a "tangleclaw:provenance" line names this project on its private generated files, each at its next regeneration — ${scope}. The operator sets it in Project Settings`
      : `off for this project: no generated file carries a provenance line. If the operator turns it on in Project Settings, ${scope}`
  };
}

/**
 * The `startup-control` capability row for whoami (#1825): whether the
 * startup prompt can be fired at this session through its engine's native
 * channel. Reported disabled, with the reason, rather than omitted.
 * @param {object|null} activeSession - The caller's active session, if resolved.
 * @returns {{id: string, enabled: boolean, detail: string}}
 */
function _startupControlCapability(activeSession) {
  if (!activeSession) {
    return { id: 'startup-control', enabled: false, detail: 'unavailable: this call did not resolve to an active session' };
  }
  const resolved = startupControl.resolveEngine(activeSession.engineId, engines.resolveProfile);
  return {
    id: 'startup-control',
    enabled: resolved.supported,
    detail: resolved.supported
      ? `the startup prompt can be fired at this session through its native channel (${resolved.reason})`
      : `unsupported: ${resolved.reason}. The startup prompt cannot be fired at this session; its launch uses the legacy path`
  };
}

/**
 * Who the launch-binding floor admitted to a write, as fields for the request
 * log line: what admitted it, and for a project its id and session. Empty for
 * a read, which the floor does not judge, so reads log as they did.
 * @param {{via: string, access?: {projectId?: (number|null), sessionId?: number}}} binding - The floor's verdict
 * @returns {{via?: string, admittedProject?: number, admittedSession?: number}}
 */
function _admittedAs(binding) {
  if (!binding || binding.via === 'not-mutating') return {};
  const access = binding.access || {};
  if (binding.via !== sharedDocsAccess.KINDS.PROJECT) return { via: binding.via };
  return { via: binding.via, admittedProject: access.projectId, admittedSession: access.sessionId };
}

/**
 * The verdict on the launch binding a whoami request carries: `verified`,
 * `stale` or `unbound`, with the cause and the recovery in the words the write
 * floor refuses in (`lib/launch-binding-guard.js#describeBinding`).
 *
 * A check that throws answers `unknown`, never `verified`: whoami is how a
 * pane diagnoses its identity, so it still answers, and says the check did not
 * run rather than leaving the field out. A Project Master launch id that tmux
 * could not be asked about is `unknown` here too, with the resolver's own
 * cause and recovery: nothing was found wrong with it, so the report does not
 * call it stale. The write floor still refuses it; only this report differs.
 *
 * A stale binding is logged at warn, without the launch id. An absent one is
 * not: every browser preview of this route is unbound.
 * @param {object} req - The request
 * @returns {{state: string, reason: (string|null), role: (string|null), projectId: (number|null), sessionId: (number|null), cause: (string|null), recovery: (string|null)}}
 */
function _whoamiBinding(req) {
  try {
    const described = launchBindingGuard.describeBinding(req);
    if (described.reason === sharedDocsAccess.INVALID_REASONS.MASTER_UNVERIFIABLE) return { ...described, state: 'unknown' };
    if (described.state === launchBindingGuard.BINDING_STATES.STALE) {
      log.warn('whoami found a stale launch binding', {
        reason: described.reason,
        claimedProjectId: req.headers[sharedDocsAccess.PROJECT_HEADER] || null,
        claimedRole: req.headers[sharedDocsAccess.ROLE_HEADER] || null,
        sessionId: described.sessionId
      });
    }
    return described;
  } catch (err) { // prawduct:allow prawduct/broad-except -- whoami is how a pane diagnoses its identity: a failed check is reported as unknown, not as a failed request
    log.warn('Launch binding could not be checked for whoami: reported as unknown', { error: err.message });
    return {
      state: 'unknown',
      reason: 'check-failed',
      role: null,
      projectId: null,
      sessionId: null,
      cause: 'TangleClaw could not check this launch binding just now.',
      recovery: 'Run `tc whoami` again. Until it reads verified, do not rely on this pane\'s identity.'
    };
  }
}

/**
 * The one verb label an awareness receipt may carry: the client's declared
 * header, capped at 64 chars and falling back rather than rejecting — a skewed
 * or hand-rolled client with a junk verb header is still an invocation worth
 * counting. Shared by every receipt recorder so the label semantics cannot
 * fork by request path.
 * @param {unknown} rawHeader - The `x-tangleclaw-verb` header value, if any
 * @param {string} fallback - Verb to record when the header is absent/empty
 * @returns {string}
 */
function awarenessVerbLabel(rawHeader, fallback) {
  const raw = typeof rawHeader === 'string' ? rawHeader.trim() : '';
  return (raw || fallback).slice(0, 64);
}

/**
 * Resolve a claimed numeric project id to its project row and active session,
 * best-effort and nullable by design: a wrong or missing id still yields a
 * recordable invocation (the ledger measures "the CLI was invoked at all",
 * which must not depend on the ids being right). Shared by every awareness
 * recorder so resolution semantics cannot fork by request path.
 * @param {number|null} claimedProjectId - The id the caller claimed
 * @returns {{project: object|null, activeSession: object|null}}
 */
function resolveClaimedProject(claimedProjectId) {
  let project = null;
  if (Number.isInteger(claimedProjectId)) {
    // A store failure is NOT a genuinely unresolvable id, and the receipt it
    // files in the null bucket would be indistinguishable from one. The write
    // still proceeds (the invocation happened and must be recorded), but the
    // failure is named so an unresolved-heavy ledger can be told apart from a
    // broken lookup.
    try {
      project = store.projects.get(claimedProjectId) || null;
    } catch (err) {
      log.warn('claimed-project lookup failed — the receipt will file as unresolved', {
        claimedProjectId, error: err.message
      });
      project = null;
    }
  }
  const activeSession = project ? store.sessions.getActive(project.id) : null;
  return { project, activeSession };
}

/**
 * Write one awareness receipt. Never throws: a ledger write must not take the
 * actual answer down with it — failure is loud in the logs and null to the
 * caller. The single write path for both recorders (whoami route and the
 * dispatcher interception).
 * @param {object} entry
 * @param {object|null} entry.project - Resolved project (or null)
 * @param {object|null} entry.activeSession - Resolved active session (or null)
 * @param {string|null} entry.workspaceId - Workspace id the caller carried
 * @param {string} entry.verb - Verb label (see awarenessVerbLabel)
 * @param {string} entry.source - 'tc-cli' | 'http'
 * @param {string|null} [entry.role] - 'master' for the Project Master (#1141);
 *   anything else records as null — junk must not grow the role vocabulary
 * @returns {object|null} The recorded receipt, or null on failure
 */
function writeAwarenessReceipt({ project, activeSession, workspaceId, verb, source, role }) {
  try {
    return store.awarenessReceipts.record({
      projectId: project ? project.id : null,
      sessionId: activeSession ? activeSession.id : null,
      workspaceId,
      verb,
      source,
      // A claimed project outranks a role claim, HERE — the one writer both
      // request paths share — not per-route. Enforced only at the whoami route,
      // a pane carrying both a project id and role=master minted 'master'
      // receipts on every OTHER verb through the dispatcher, and listForMaster
      // counted them: a false Master 'confirmed', the exact signal this
      // feature ships to make trustworthy (Critic R-2/R-7/R-11).
      role: role === 'master' && !project ? 'master' : null
    });
  } catch (err) {
    log.warn('awareness receipt write failed', { error: err.message });
    return null;
  }
}

/**
 * The workspace id a whoami/capabilities answer reports (#2153). The Medusa
 * registry is the authoritative, server-side record of a session's live
 * binding; the caller's claimed id (its own `TANGLECLAW_WORKSPACE_ID`) can be
 * empty or stale right after a session restart, before the pane's env var
 * catches up, even while the registry — and the real Medusa send/receive
 * routes, which read it the same way — already agree on the live id. The
 * registry wins whenever a session resolved; the claim is used only when no
 * session resolved (a Master pane, or a project that failed to resolve),
 * where there is no registry entry to consult.
 * @param {object|null} project - The resolved project row, if any.
 * @param {object|null} activeSession - The resolved active session, if any.
 * @param {string|null} claimedWorkspaceId - The id the caller's query carried.
 * @returns {string|null} The workspace id to report.
 */
function _resolveWorkspaceId(project, activeSession, claimedWorkspaceId) {
  if (!project || !activeSession) return claimedWorkspaceId;
  let registered = null;
  try {
    registered = medusaRegistry.getWorkspaceId(project.path, activeSession.id);
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- whoami still answers on a registry
    // read failure; it reports the binding as absent rather than trusting a
    // claim the real send path (lib/medusa.js) cannot corroborate.
    log.warn('Medusa registry read failed while resolving whoami workspace id — reporting no binding rather than the caller\'s stale claim', {
      project: project.name, error: err.message
    });
    return null;
  }
  if (registered && claimedWorkspaceId && registered !== claimedWorkspaceId) {
    log.warn('whoami workspace id disagreed with the live Medusa registry binding — the registry wins', {
      project: project.name, sessionId: activeSession.id, claimed: claimedWorkspaceId, registered
    });
  }
  return registered;
}

/**
 * Record one awareness receipt for a tc-CLI-identified request from its
 * provenance headers — a thin composition of the shared resolve/label/write
 * core, so the dispatcher and the whoami route cannot drift apart in what a
 * receipt means.
 * @param {object} headers - `req.headers` (keys lower-cased by Node)
 * @returns {void}
 */
function recordTcAwareness(headers) {
  const resolved = resolveClaimedProject(
    headers['x-tangleclaw-project-id'] !== undefined ? Number(headers['x-tangleclaw-project-id']) : null
  );
  const workspaceId = typeof headers['x-tangleclaw-workspace-id'] === 'string' && headers['x-tangleclaw-workspace-id']
    ? headers['x-tangleclaw-workspace-id'] : null;
  writeAwarenessReceipt({
    ...resolved,
    workspaceId,
    verb: awarenessVerbLabel(headers['x-tangleclaw-verb'], 'unknown'),
    source: 'tc-cli',
    role: typeof headers['x-tangleclaw-role'] === 'string' ? headers['x-tangleclaw-role'] : null
  });
}

/**
 * A lane's workload blocks for the fleet read (#1912, ADR 0020 §6, §10):
 * `engine` from the observer's cache, `workload` from the receipts, `composed`
 * from the one composition. Runs no tmux. A lane that fails to compose reads
 * UNKNOWN rather than taking the roster down.
 * @param {object} session - A live session
 * @param {string|null} projectName - Its project's name
 * @returns {{engine: object, workload: object, composed: object}}
 */
function _composedLane(session, projectName) {
  try {
    return { ...workloadFleet.laneFor(session, { observer: activityObserver, projectName }), ..._laneRotation(session) };
  } catch (err) { // prawduct:allow prawduct/broad-except -- one lane's store failure must not take the fleet roster down; it composes UNKNOWN, fail-closed, and is logged
    log.warn('workload composition failed for a lane', { sessionId: session.id, error: err.message });
    return {
      engine: activityObserver.get(session.id),
      workload: { receipt: null, provenance: 'none', staleReason: null, ageSeconds: null },
      composed: { availability: 'UNKNOWN', clearance: 'unknown', reasons: ['compose-failed'] }
    };
  }
}

/**
 * A lane's coordinator rotation, for the fleet read (#2032, ruling A13):
 * present while one is open, with its state, blocker, digest, receipt verdict
 * and the one next command, so a coordinator reading `tc sessions` sees a
 * rotating peer as exactly that.
 * @param {object} session - The session row.
 * @returns {{rotation?: object}}
 */
function _laneRotation(session) {
  const open = coordinatorRotation.openRotation(session.projectId);
  if (!open) return {};
  const v = coordinatorRotation.view(open);
  return {
    rotation: {
      rotationId: v.rotationId, state: v.state, mode: v.mode, generation: v.generation, checkpointDigest: v.checkpointDigest,
      binding: v.binding, receiptVerdict: v.receiptVerdict, blocker: v.blocker, nextCommand: v.nextCommand
    }
  };
}

// ── Check watches (#2323): register, read and cancel a watch on a named check ──
//
// The handlers live in lib/check-watch-api.js. Nothing here reads GitHub.

/**
 * Register one check watch route.
 * @param {string} method - HTTP method
 * @param {string} pattern - Route pattern
 * @param {(req: object, params: object, body: object) => ({status: number, body: object}|Promise<{status: number, body: object}>)} fn - Handler
 * @param {object} [options] - The route's registration options, passed to `route`
 * @returns {void}
 */
function checkWatchRoute(method, pattern, fn, options) {
  route(method, pattern, async (req, res, params, body) => {
    let out;
    try {
      out = await fn(req, params, body);
    } catch (err) { // prawduct:allow prawduct/broad-except -- a watch request that did not finish must never read as registered or cancelled: a WatchError keeps its own status and code, and anything else (the store threw) is the fail-closed 503
      if (err instanceof checkWatchApi.WatchError) {
        return errorResponse(res, err.status, err.message, err.code, err.details);
      }
      log.error('Check watches unavailable', { method, pattern, error: err.message });
      return errorResponse(res, 503, 'Check watches could not answer. Read the watches again before repeating the request.', 'CHECK_WATCH_UNAVAILABLE');
    }
    jsonResponse(res, out.status, out.body);
  }, options);
}

/**
 * Register the tc routes on the shared route table.
 * @param {object} deps - What the handlers use that still lives in `server.js`.
 * @param {{get: (sessionId: number) => object}} deps.activityObserver - The
 *   activity observer whose cached reading the lane composition takes.
 * @returns {void}
 */
function register(deps) {
  ({ activityObserver } = deps);

  // POST /api/tc/rule-receipt — the startup-rules hook vouching that it RAN
  // (#1063).
  //
  // The rules ledger records `written` when TangleClaw puts the shards on disk,
  // because that is all it knows at launch time. This route is the only thing
  // that can turn that into `delivered`: the hook posts the token TangleClaw left
  // beside the shards, and reaching this handler is proof an engine executed the
  // hook. Before it existed, #759 — every Claude SessionStart hook failing, whole
  // sessions booting with no rules — produced a clean ledger across multiple
  // sessions and two projects, invisible to every record TangleClaw kept.
  //
  // Deliberately narrow. It carries one verb, `written` → `delivered`, and
  // `markDelivered` refuses every other transition, so a receipt can never
  // launder a `skipped` or `unverified` row into a success, and the route takes
  // no outcome from the caller — only a row id.
  //
  // The id is not a credential, and the token carrying it is not one either: it
  // is a small integer in a file in the project directory, on a route outside the
  // service-token gate. What bounds the damage is the transition plus a freshness
  // window in `markDelivered`, not a secret. A row already `delivered`, `skipped`
  // or `unverified` is inert here, and a `written` row older than the window is
  // refused.
  //
  // What a receipt proves is that A hook ran in that project directory — not
  // which session's. It cannot prove that: the hook is registered on `startup` in
  // the project's own settings, so every `claude` opened there runs it. The
  // residual, stated rather than claimed closed: a `claude` opened by hand inside
  // the window, for a launch whose own hook failed, confirms that launch's row.
  // The window bounds it; nothing here makes it impossible.
  //
  // Always 200, never an error, when the id simply did not match: the caller is a
  // shell script inside an engine's startup path, and a 4xx there is noise in a
  // place where noise gets fed back to the engine as a synthetic turn. The body
  // says whether anything was upgraded, for the operator and for tests.
  route('POST', '/api/tc/rule-receipt', (req, res, _params, body) => {
    const deliveryId = body && body.deliveryId;
    const upgraded = store.sessionRuleDeliveries.markDelivered(deliveryId);
    if (!upgraded) {
      // Not an error and not silence: a receipt for a row that is not `written`
      // is the ordinary shape of a stale token, but a receipt that NEVER matches
      // means the channel is confirming nothing and the ledger will read
      // `written` forever, so it is visible at debug level with the id that missed.
      log.debug('Rule-receipt matched no written delivery', { deliveryId });
      return jsonResponse(res, 200, { upgraded: false });
    }
    log.info('Startup rules confirmed delivered by the engine hook', {
      deliveryId: upgraded.id, projectId: upgraded.projectId, sessionId: upgraded.sessionId
    });
    return jsonResponse(res, 200, { upgraded: true, delivery: upgraded });
  });

  // POST /api/tc/start/next — serve the next page of the launch sequence, after
  // applying an acknowledgement when one is sent (Train 21, #1581).
  //
  // The whole exchange is one transaction in `lib/launch-sequence.js`: two
  // identical acks cannot both advance the cursor, and a lost response is safe to
  // replay because a repeat of an ack already applied is idempotent rather than a
  // second advance.
  //
  // Under the same loopback machine-client trust as `/api/tc/rule-receipt`. A
  // local process can forge an acknowledgement; doing so grants nothing — the
  // sequence records what was delivered and read, not authorization.
  route('POST', '/api/tc/start/next', (req, res, _params, body) => {
    const { launchId, projectId } = _launchIdentity(req);
    const sent = body || {};
    const result = launchSequence.next({
      launchId,
      projectId,
      ack: sent.ack,
      page: sent.page === null || sent.page === undefined ? undefined : sent.page
    });
    return jsonResponse(res, result.status, result.body);
  });

  // POST /api/tc/start/ready — record the agent's attestation that it read and
  // acknowledged its whole launch sequence (Train 21, #1582).
  //
  // The verdict in the artifact must equal the one the server recorded: it is how
  // the attestation evidences that step 3 was read, so the refusal deliberately
  // does not echo the right answer back.
  //
  // READY is initialization, NOT task authorization, and it is an unauthenticated
  // local attestation (see `lib/launch-sequence.js`). A forged one marks a
  // sequence read; it grants nothing and changes no operator confirmation rule.
  route('POST', '/api/tc/start/ready', (req, res, _params, body) => {
    const { launchId, projectId } = _launchIdentity(req);
    const result = launchSequence.ready({ launchId, projectId, artifact: body || null });
    return jsonResponse(res, result.status, result.body);
  });

  // POST /api/tc/workload — a session asserts its own workload (#1912, ADR 0020).
  //
  // The one write surface for workload: `tc workload set` in the lane's own pane.
  // Only a verified project launch may write, and only for itself; the server
  // stamps project, session, launch, assignment, sequence, time and source from
  // that launch (`lib/workload.js`). An assertion, never evidence, and it grants
  // nothing.
  route('POST', '/api/tc/workload', (req, res, _params, body) => {
    if (coordinatorGateRefused(req, res, _callerProjectId(req), 'workload-set')) return;
    const result = workload.record({ req, body });
    return jsonResponse(res, result.status, result.body);
  });

  // GET /api/tc/workload — the calling lane's own newest receipt (`tc workload
  // show`). Same verified-launch binding as the write.
  route('GET', '/api/tc/workload', (req, res) => {
    const access = sharedDocsAccess.resolveAccess(req);
    const result = workload.readOwn({ req, access });
    if (result.status !== 200) return jsonResponse(res, result.status, result.body);
    // The lane's own composed verdict, from the same composition the fleet read
    // uses (ADR 0020 §1, §10), so `tc workload show` says what coordinators see.
    const session = store.sessions.get(access.sessionId);
    const project = session ? store.projects.get(session.projectId) : null;
    const lane = session ? _composedLane(session, project ? project.name : null) : null;
    return jsonResponse(res, 200, { ...result.body, ...(lane || {}) });
  });

  // POST /api/tc/rotation/prepare — `{attemptKey, checkpoint}`: begin a rotation
  // of the caller's own session and start the server's side of it.
  route('POST', '/api/tc/rotation/prepare', async (req, res, _params, body) => {
    const access = _rotationAccess(req, res);
    if (!access) return;
    const result = await coordinatorRotation.prepare({ access, body });
    if (result.status === 201 || result.status === 200) coordinatorRotation.drive(result.body.rotation.rotationId);
    return jsonResponse(res, result.status, result.body);
  }, { maxBodySize: MESSAGE_BODY_LIMIT_BYTES });

  // GET /api/tc/rotation — the caller's open rotation, checkpoint included (what
  // the replacement context reconciles against), or `rotation: null` when none
  // is open; `latest` is the most recent one in any state, and `generation` the
  // project's current generation.
  route('GET', '/api/tc/rotation', (req, res) => {
    const access = _rotationAccess(req, res);
    if (!access) return;
    const open = coordinatorRotation.openRotation(access.projectId);
    const channel = store.startupControlChannels.getOpenBySession(access.sessionId);
    const channelThread = channel && channel.adapterState ? channel.adapterState.threadId || null : null;
    const forwardedThread = _engineThread(req);
    return jsonResponse(res, 200, {
      rotation: coordinatorRotation.view(open, { checkpoint: true }),
      // The most recent rotation whatever its state, so a caller that has just
      // resumed (or lost a response) can still see where it stands.
      latest: coordinatorRotation.view(store.coordinatorRotations.latestForProject(access.projectId)),
      generation: store.coordinatorRotations.currentGeneration(access.projectId),
      // Read-only binding evidence for the caller's own launch: the thread tc
      // forwarded beside the one its control channel records. The live-Codex
      // integration check reads it (scripts/rotation-live-check.js).
      binding: { forwardedThread, channelThread, matches: !!forwardedThread && forwardedThread === channelThread }
    });
  });

  // POST /api/tc/rotation/advance — retry the server's side of the caller's open
  // rotation after a failure it has since fixed (a busy thread, a refused clear).
  route('POST', '/api/tc/rotation/advance', async (req, res) => {
    const access = _rotationAccess(req, res);
    if (!access) return;
    const open = coordinatorRotation.openRotation(access.projectId);
    if (!open) return errorResponse(res, 404, 'This project has no rotation in progress.', 'ROTATION_NOT_FOUND');
    const r = await coordinatorRotation.advance(open.rotationId);
    if (r && (r.state === 'fenced' || r.state === 'rebinding')) coordinatorRotation.drive(r.rotationId);
    return jsonResponse(res, 200, { rotation: coordinatorRotation.view(r) });
  });

  // POST /api/tc/rotation/resume — `{rotationId, attemptKey, generation, receipt}`:
  // the replacement context's proof. Accepted only when every fact the server can
  // observe agrees; that acceptance is what lifts the fence.
  route('POST', '/api/tc/rotation/resume', async (req, res, _params, body) => {
    const access = _rotationAccess(req, res);
    if (!access) return;
    const result = await coordinatorRotation.resume({ access, body, threadId: _engineThread(req) });
    return jsonResponse(res, result.status, result.body);
  }, { maxBodySize: MESSAGE_BODY_LIMIT_BYTES });

  // POST /api/tc/rotation/relaunch — `{rotationId}`: the operator's explicit
  // relaunch transition for a `relaunch` rotation. Launches the successor and
  // binds exactly that session and launch to the rotation; nothing else is ever
  // claimed. Operator only.
  route('POST', '/api/tc/rotation/relaunch', async (req, res, _params, body) => {
    const result = await coordinatorRotation.claimRelaunch({ caller: resolveControlCaller(req), body });
    return jsonResponse(res, result.status, result.body);
  });

  // GET /api/rotations — the operator's read surface for coordinator rotations
  // (ruling A13): each recent rotation's state, blocker, checkpoint digest,
  // receipt verdict and the one command that moves it. Operator only.
  route('GET', '/api/rotations', (req, res) => {
    const caller = resolveControlCaller(req);
    if (caller.kind !== 'operator') return errorResponse(res, 403, 'Only the operator reads every coordinator rotation.', 'OPERATOR_ONLY');
    const rows = store.coordinatorRotations.listRecent(50);
    return jsonResponse(res, 200, {
      rotations: rows.map((r) => {
        const project = store.projects.get(r.projectId);
        return { project: project ? project.name : null, ...coordinatorRotation.view(r) };
      })
    });
  });

  // POST /api/tc/rotation/abandon — `{rotationId, reason}`: the operator ends a
  // rotation that cannot finish, lifting the fence. Operator only.
  route('POST', '/api/tc/rotation/abandon', (req, res, _params, body) => {
    const result = coordinatorRotation.abandon({ caller: resolveControlCaller(req), body });
    return jsonResponse(res, result.status, result.body);
  });

  // Coordinator-role contracts (#2032, ruling A6a): the operator's durable
  // statement that a project is a coordinator, which a rotation's prepare
  // requires and its resume re-checks. Operator only.
  route('GET', '/api/coordinator-roles', (req, res) => {
    const caller = resolveControlCaller(req);
    if (caller.kind !== 'operator') return errorResponse(res, 403, 'Only the operator lists coordinator roles.', 'OPERATOR_ONLY');
    return jsonResponse(res, 200, { roles: store.coordinatorRoles.list() });
  });

  route('POST', '/api/coordinator-roles', (req, res, _params, body) => {
    const result = coordinatorRotation.grantRole({ caller: resolveControlCaller(req), body });
    return jsonResponse(res, result.status, result.body);
  }, { signedInOperator: { action: 'grant a coordinator role' } });

  route('POST', '/api/coordinator-roles/revoke', (req, res, _params, body) => {
    const result = coordinatorRotation.revokeRole({ caller: resolveControlCaller(req), body });
    return jsonResponse(res, result.status, result.body);
  });

  // POST /api/tc/workload/narrowing — the operator narrows (or clears a
  // narrowing of) one lane's composed verdict (ADR 0020 §7). Operator only, with
  // control's proof tiers; a narrowing only ever lowers the verdict.
  route('POST', '/api/tc/workload/narrowing', (req, res, _params, body) => {
    const result = workload.recordNarrowing({ caller: resolveControlCaller(req), body });
    return jsonResponse(res, result.status, result.body);
  });

  // GET /api/tc/start/status — where the sequence stands: the cursor, and what
  // was served and acknowledged per step (Train 21, #1581).
  //
  // Read-only, and it answers a pane launched before phased launch too, saying
  // that it has no sequence rather than refusing it.
  route('GET', '/api/tc/start/status', (req, res) => {
    const { launchId, projectId } = _launchIdentity(req);
    const result = launchSequence.status({ launchId, projectId });
    return jsonResponse(res, result.status, result.body);
  });

  // GET /api/tc/start/review?step=&page= — re-read a page of an ATTESTED launch
  // (#1761), for a session whose context was cleared or compacted after READY.
  //
  // Read-only: nothing is marked served or acknowledged and the snapshot is never
  // revised, so it is safe at any point after READY. Same launch binding and the
  // same loopback machine-client trust as the other `start` routes.
  route('GET', '/api/tc/start/review', (req, res) => {
    const { launchId, projectId } = _launchIdentity(req);
    const query = parseQuery(reqUrl(req).search);
    const step = /^\d+$/.test(query.step || '') ? Number(query.step) : (query.step || undefined);
    const page = query.page === undefined || query.page === '' ? undefined
      : (/^\d+$/.test(query.page) ? Number(query.page) : query.page);
    const result = launchSequence.review({ launchId, projectId, step, page });
    return jsonResponse(res, result.status, result.body);
  });

  // GET /api/tc/whoami — the `tc` CLI's one verb (ambient-awareness Chunk 02).
  // Answers "who am I, where is TangleClaw, and what can I do through it" for the
  // pane that asks, and the GET itself IS the awareness receipt: recording
  // happens server-side on every invocation, so the CLI cannot forget to report
  // and a receipt row means this handler actually ran. Ids are taken as claimed
  // and resolved best-effort — an invocation with a wrong or missing project id
  // still records a receipt (project null), because the fact this ledger
  // measures is "an agent discovered and ran the CLI at all" (the plan's
  // HIGH-impact assumption), not whether its ids were right.
  //
  // Capabilities are reported honestly, ABSENCE INCLUDED (Direction §3 amendment):
  // a disabled capability appears with enabled:false and a reason rather than
  // vanishing — an agent that cannot discover it lacks a tool will improvise one,
  // which is the fabrication that opened this plan. No secrets in the response:
  // the service token stays behind its own endpoint.
  route('GET', '/api/tc/whoami', (req, res) => {
    const query = parseQuery(reqUrl(req).search);
    const claimedProjectId = query.projectId !== undefined ? Number(query.projectId) : null;
    const claimedWorkspaceId = typeof query.workspaceId === 'string' && query.workspaceId ? query.workspaceId : null;
    // The verb this invocation counts as: `tc capabilities` answers from this
    // same route, so the client declares its verb by header; absent (a browser,
    // or a pre-verb-roster tc binary) it counts as whoami. An auxiliary identity
    // side-fetch (x-tangleclaw-aux — e.g. `tc message` resolving its project
    // name) records NOTHING here: its primary request already records at the
    // dispatcher, and counting it twice would inflate the very ledger this
    // endpoint exists to keep honest.
    const isAux = !!req.headers['x-tangleclaw-aux'];
    const verb = awarenessVerbLabel(req.headers['x-tangleclaw-verb'], 'whoami');

    const { project, activeSession } = resolveClaimedProject(claimedProjectId);
    // The live binding wins over the caller's own claim (#2153): see
    // `_resolveWorkspaceId`.
    const workspaceId = _resolveWorkspaceId(project, activeSession, claimedWorkspaceId);
    // What the launch binding this request carries is worth (#2233). The project
    // above is the one the caller CLAIMS, resolved without asking who it is;
    // this is the server's own answer about the launch id beside it.
    const binding = _whoamiBinding(req);

    // Provenance (not authentication): the tc client identifies itself with a
    // header, so a browser preview or health check records as 'http' and cannot
    // fabricate the "this session became aware" fact the awareness view keys on.
    const source = req.headers['x-tangleclaw-cli'] ? 'tc-cli' : 'http';

    // The Project Master (#1141): role rides query or header (same dual pattern
    // as the project id), and only counts when no project was claimed — a pane
    // carrying BOTH is answering as a project session and the role is noise.
    const claimedRole = typeof query.role === 'string' ? query.role
      : (typeof req.headers['x-tangleclaw-role'] === 'string' ? req.headers['x-tangleclaw-role'] : null);
    const isMaster = claimedRole === 'master' && !project;

    // The receipt is the point of the endpoint, but failing to write one must
    // not cost the caller its answer — the shared writer warns and returns null.
    const receipt = isAux ? null : writeAwarenessReceipt({
      project, activeSession, workspaceId, verb, source, role: claimedRole
    });

    const config = store.config.load();
    const protocol = httpsSetup.effectiveServerProtocol(config);
    const port = httpsSetup.effectiveServerPort(config);
    const operatorTopologyWhoami = sessionOwnership.resolveOperatorHost(req.headers, config);
    const operatorHost = operatorTopologyWhoami.host;
    // Same reason as the launch path: without `source`, a null here cannot be
    // told apart from a header that was refused as malformed or loopback.
    log.debug('Resolved operator host for whoami', {
      host: operatorHost, source: operatorTopologyWhoami.source
    });

    let projConfig = null;
    if (project) {
      try { projConfig = store.projectConfig.load(project.path); } catch { projConfig = null; }
    }
    const medusaEnabled = !!(projConfig && projConfig.medusaEnabled === true);

    const api = `${protocol}://localhost:${port}`;
    const capabilities = [
      {
        id: 'session-rules', enabled: !!project,
        detail: project
          ? `durable project rules: GET/POST ${api}/api/session-rules?projectId=${project.id} (a POST needs x-tangleclaw-project-id and x-tangleclaw-launch-id; your rules land as status='proposed' until the operator approves, and only the operator changes, disables or removes a governing rule)`
          : 'unavailable: this call did not resolve to a registered project'
      },
      {
        id: 'porthub', enabled: true,
        detail: `port assignments go through PortHub: ${api}/api/ports`
      },
      {
        id: 'shared-docs', enabled: true,
        detail: `cross-project shared documents: ${api}/api/shared-docs`
      },
      {
        // #542 — the universal floor for "plans openable from anywhere": every
        // engine can hand back a served link, not just the one with Artifacts.
        id: 'plan-docs', enabled: !!project,
        detail: project
          ? `plan/design docs are served at a shareable URL: GET ${api}/api/projects/${project.id}/plans lists each .tangleclaw/plans/*.md with its link (/plans/${project.id}/<file>.md, behind the same gate as the dashboard) — hand the operator that link, never a file path`
          : 'unavailable: this call did not resolve to a registered project'
      },
      {
        // #1861: durable HOLD/STOP. Experimental, and documented as such.
        id: 'control', enabled: !!project,
        detail: project
          ? `durable HOLD/STOP control (experimental): \`tc control status\` shows whether your lane is held, \`tc control ack <generation>\` acknowledges it; GET ${api}/api/control/mine (send x-tangleclaw-project-id and x-tangleclaw-launch-id). A HOLD refuses TangleClaw-governed mutations; it cannot block shell git/gh, so honour it there too`
          : 'unavailable: this call did not resolve to a registered project'
      },
      {
        // #1678: the fleet's checkouts, shaped to what this project may see.
        id: 'checkouts', enabled: true,
        detail: `which commit each live session is on and how it stands against origin/main: \`tc freshness\`, or GET ${api}/api/checkouts (your own row and your project groups' rows; send x-tangleclaw-project-id and x-tangleclaw-launch-id)`
      },
      {
        // #1912, ADR 0020: a lane asserts its own workload; coordinators read
        // the composed verdict fleet-wide.
        id: 'workload', enabled: !!project,
        detail: project
          ? `report your workload so coordinators can read fleet capacity. ${workloadSentence()} \`tc workload show\` shows what coordinators see.`
          : 'unavailable: this call did not resolve to a registered project'
      },
      _startupControlCapability(activeSession),
      _provenanceCapability(project, projConfig),
      {
        id: 'switchboard', enabled: medusaEnabled && !!workspaceId,
        detail: medusaEnabled && workspaceId
          ? `message other sessions: POST ${api}/api/sessions/${encodeURIComponent(project.name)}/medusa/send — your workspace id is ${workspaceId}`
          : (medusaEnabled
            ? 'enabled for this project, but this pane carries no workspace id — it was not launched with one, so you cannot send or receive; say so rather than improvising a channel'
            : 'not enabled for this project — you CANNOT message other sessions; say so rather than improvising a channel')
      }
    ];

    if (isMaster) {
      // The Master's answer: fleet-read identity, no project to claim. Its
      // capability roster is master-shaped — the Read API it governs the fleet
      // through, and the switchboard per ITS settings with the same honest
      // absence the project roster ships.
      let masterMedusaEnabled = false;
      try {
        masterMedusaEnabled = !!master.masterSettings(config).medusaEnabled;
      } catch (err) {
        // Logged, never silent: on a failed settings read the roster below says
        // "not enabled", which is the restrictive direction — but the log must
        // carry the truth that it was a read failure, not a setting.
        log.warn('master settings read failed during whoami — switchboard reported as unavailable', { error: err.message });
      }
      return jsonResponse(res, 200, {
        role: 'master',
        project: null,
        sessionId: null,
        binding,
        workspaceId,
        api: { origin: api, note: 'localhost is correct for YOUR OWN calls from this host' },
        operator: {
          host: operatorHost,
          note: `Never hand the operator a localhost link — they are almost never on this machine; ${sessionOwnership.operatorLinkDirective(operatorHost)}.`
        },
        capabilities: [
          {
            id: 'read-api', enabled: true,
            detail: `the fleet-wide Read API is yours: ${api}/api/awareness (you appear in its master entry), ${api}/api/tc/sessions, ${api}/api/ports, ${api}/api/shared-docs (send x-tangleclaw-role: master and x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID)`
          },
          {
            id: 'checkouts', enabled: true,
            detail: `every live session's checkout against origin/main: \`tc freshness\`, or GET ${api}/api/checkouts (send x-tangleclaw-role: master and x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID)`
          },
          {
            id: 'switchboard', enabled: masterMedusaEnabled && !!workspaceId,
            detail: masterMedusaEnabled && workspaceId
              ? `message other sessions: POST ${api}/api/master/medusa/send — your workspace id is ${workspaceId}`
              : (masterMedusaEnabled
                ? 'enabled for the Master, but this pane carries no workspace id — you cannot send or receive; say so rather than improvising a channel'
                : 'not enabled for the Master — you CANNOT message other sessions; say so rather than improvising a channel')
          }
        ],
        receiptRecorded: !!receipt
      });
    }

    return jsonResponse(res, 200, {
      project: project
        ? { id: project.id, name: project.name }
        : null,
      unresolved: project ? undefined : `projectId ${query.projectId === undefined ? '(absent)' : query.projectId} did not resolve to a registered project — identity claims below are limited to instance facts`,
      sessionId: activeSession ? activeSession.id : null,
      binding,
      workspaceId,
      api: {
        origin: api,
        note: 'localhost is correct for YOUR OWN calls from this host'
      },
      operator: {
        host: operatorHost,
        note: `Never hand the operator a localhost link — they are almost never on this machine; ${sessionOwnership.operatorLinkDirective(operatorHost)}.`
      },
      capabilities,
      receiptRecorded: !!receipt
    });
  });

  // GET /api/tc/sessions — the fleet-wide live-session roster for `tc sessions`
  // (ambient-awareness Chunk 03). Every session still running — `active` is the
  // only non-terminal status, and it spans a wrap — across all projects, enriched
  // with the project name so the caller need not
  // resolve numeric ids. An empty list is an honest answer (the fleet is idle),
  // and the receipt for a tc invocation of this route is recorded by the
  // dispatcher's provenance interception, not here.
  route('GET', '/api/tc/sessions', (_req, res) => {
    const projectNames = new Map();
    const sessions = store.sessions.listLiveAll().map((s) => {
      if (!projectNames.has(s.projectId)) {
        let p = null;
        // Same contract as the receipt path's claimed-project lookup: a store
        // failure must not take the roster down, but it is not the same fact as
        // "no such project" — name it, or a broken lookup renders as a fleet of
        // anonymous sessions with nothing anywhere saying why.
        try {
          p = store.projects.get(s.projectId);
        } catch (err) {
          log.warn('project-name lookup failed for tc sessions roster', {
            projectId: s.projectId, error: err.message
          });
          p = null;
        }
        projectNames.set(s.projectId, p ? p.name : null);
      }
      return {
        id: s.id,
        projectId: s.projectId,
        projectName: projectNames.get(s.projectId),
        engineId: s.engineId,
        status: s.status,
        startedAt: s.startedAt,
        ..._composedLane(s, projectNames.get(s.projectId))
      };
    });
    jsonResponse(res, 200, { sessions });
  });

  checkWatchRoute('POST', '/api/tc/check-watches', (req, _params, body) => checkWatchApi.register(req, body));
  checkWatchRoute('GET', '/api/tc/check-watches', (req) => checkWatchApi.list(req, parseQuery(reqUrl(req).search)));
  checkWatchRoute('GET', '/api/tc/check-watches/:id', (req, params) => checkWatchApi.show(req, params));
  checkWatchRoute('POST', '/api/tc/check-watches/:id/cancel', (req, params) => checkWatchApi.cancel(req, params));
}

module.exports = { register, _admittedAs, recordTcAwareness, _composedLane };
