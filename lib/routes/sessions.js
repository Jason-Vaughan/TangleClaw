'use strict';

/**
 * The session lifecycle route family — launch (`POST /api/sessions/:project`),
 * kill, status, the startup-prompt fire, command injection, governed
 * finalization, the terminal peek, the clipboard read and the history read —
 * with the post-launch stranded-wrap check (`_checkStrandedAfterLaunch`),
 * moved out of `server.js` unchanged (#2248).
 *
 * `register(deps)` registers the routes through the shared kernel, in the
 * order they held in `server.js`, from the position the first of them held.
 * The family sat in three places there, around other families; registering it
 * from one call moves its later routes ahead of those, which is safe because
 * no pattern overlaps and `test/route-reachability.test.js` proves it. Four
 * things the handlers use still live in `server.js` — the durable HOLD/STOP
 * gate (`controlRefused`), the coordinator epoch gate
 * (`coordinatorGateRefused`), the startup prompt's proof options
 * (`_startupPromptProofOptions`) and the activity observer instance
 * (`activityObserver`) — so they arrive as `deps` rather than through a
 * require of the entry point, which would be a cycle. When the areas that own
 * them have modules of their own, this one requires them from there and
 * `register` takes nothing.
 *
 * @module lib/routes/sessions
 */

const { createLogger } = require('../logger');
const store = require('../store');
const projects = require('../projects');
const sessions = require('../sessions');
const launchWarmup = require('../launch-warmup');
const sessionOwnership = require('../session-ownership');
const strandedCheck = require('../stranded-check');
const sharedDocsAccess = require('../shared-docs-access');
const startupPrompt = require('../startup-prompt');
const sessionFinalize = require('../session-finalize');
const permissionRequests = require('../permission-requests');
const usageWindows = require('../usage-windows');
const modelSwitch = require('../model-switch');
const lifecycleHandoff = require('../lifecycle-handoff');
const workloadFleet = require('../workload-fleet');
const workloadCompose = require('../workload-compose');
const controlState = require('../control-state');
const path = require('node:path');
const mergeGateWiring = require('../tc-docs-scorecard-merge-wiring');
const mergeInboxGate = require('../merge-inbox-gate');
const mergeRoleGuard = require('../merge-role-guard');
const chunkBoundary = require('../chunk-boundary');
const chunkBoundaryHttp = require('../chunk-boundary-http');
const { route, jsonResponse, errorResponse, reqUrl, parseQuery, MESSAGE_BODY_LIMIT_BYTES } = require('./_kernel');
const { _callerProjectId, _requireOperatorWrite, _requireSessionLifecycleCaller, _hasDelegatedLifecycleAuthority } = require('./_callers');

// The logger keeps the entry point's name so every log line this family writes
// reads exactly as it did before the move.
const log = createLogger('server');

/**
 * Start the GitHub check for stranded wraps after a launch succeeded (#1542),
 * without waiting for it: the launch has already answered, and the check
 * records its own outcome, including a failure.
 * @param {object} project - Project row
 * @returns {void}
 */
function _checkStrandedAfterLaunch(project) {
  strandedCheck.checkAfterLaunch(project).catch((err) => {
    log.error('Stranded-wrap check after launch failed', { project: project.name, error: err.message });
  });
}

// The startup admission gate's read of a session (#1633) is
// `sessions.startupReadiness`/`sessions.activeStartupReadiness` — shared with
// `lib/projects.js`'s project-card enrichment (#1633 R2 Fix 4) so a session's
// status payload, its command gate, and its project card can never disagree
// about whether it is ready.

/**
 * A pane-visible prefix naming the verified caller of a `/command` injection
 * (#2402), or null for the operator (who needs none) or an unbound/invalid
 * caller (who has no verified identity to name). Drawn only from `access` —
 * the `sharedDocsAccess.resolveAccess` result the launch binding itself
 * proved — never from anything the request body claims, so the caller cannot
 * choose or omit it.
 * @param {{kind: string, projectId: (number|null), sessionId?: number}} access - From `sharedDocsAccess.resolveAccess`
 * @returns {string|null}
 */
function _verifiedSenderStamp(access) {
  if (access.kind === sharedDocsAccess.KINDS.PROJECT) {
    const callerProject = store.projects.get(access.projectId);
    const name = callerProject ? callerProject.name : `project ${access.projectId}`;
    return `[DIRECT INPUT from project "${name}" session ${access.sessionId}, verified by TangleClaw]`;
  }
  if (access.kind === sharedDocsAccess.KINDS.MASTER) {
    return '[DIRECT INPUT from the Project Master, verified by TangleClaw]';
  }
  return null;
}

/**
 * The verified-caller summary a `/command` submission receipt reports (#2402).
 * @param {{kind: string, projectId: (number|null), sessionId?: number}} access - From `sharedDocsAccess.resolveAccess`
 * @returns {{kind: string, projectId?: number, sessionId?: number}}
 */
function _verifiedCallerSummary(access) {
  if (access.kind === sharedDocsAccess.KINDS.PROJECT) {
    return { kind: access.kind, projectId: access.projectId, sessionId: access.sessionId };
  }
  return { kind: access.kind };
}

/**
 * Whether a `/clear` sent as a `/command` injection is the governed path
 * (#2824, Rule #285 §5): the caller is a PROJECT session holding delegated
 * lifecycle authority over the target lane (the same test
 * `lib/routes/_callers.js#_hasDelegatedLifecycleAuthority` applies to
 * launch/wrap), AND the target lane itself currently composes
 * AVAILABLE/safe-to-clear — never a guess, and never a lane that is busy,
 * held, stale, or has no current receipt. Every other slash command, and a
 * `/clear` the lane does not currently support, stays operator-only.
 * @param {{kind: string, projectId: (number|null)}} access - The caller, from `sharedDocsAccess.resolveAccess`
 * @param {object} commandProject - The target project row
 * @param {object} activityObserver - The server's activity observer
 * @returns {boolean}
 * @throws {controlState.ControlError} 503 when the target's authority matrix is unreadable
 */
function _isDelegatedSafeClear(access, commandProject, activityObserver) {
  if (access.kind !== sharedDocsAccess.KINDS.PROJECT) return false;
  if (!_hasDelegatedLifecycleAuthority(access.projectId, commandProject.id)) return false;
  const session = store.sessions.getActive(commandProject.id);
  if (!session) return false;
  const lane = workloadFleet.laneFor(session, { observer: activityObserver, projectName: commandProject.name });
  return lane.composed.availability === workloadCompose.AVAILABILITY.AVAILABLE
    && lane.composed.clearance === 'safe-to-clear';
}

/**
 * Register the session lifecycle routes on the shared route table.
 * @param {object} deps - What the handlers use that still lives in `server.js`.
 * @param {(res: object, args: {surface: string, subject: object}) => boolean} deps.controlRefused -
 *   Ask the durable HOLD/STOP gate before a governed mutation; true when refused and answered.
 * @param {(req: object, res: object, projectId: number|null, action: string, extra?: object) => boolean} deps.coordinatorGateRefused -
 *   Apply the coordinator epoch gate to a coordinator-authority mutation; true when refused.
 * @param {(action: string, logContext: object) => object} deps._startupPromptProofOptions -
 *   The operator-proof options the startup prompt's writes share.
 * @param {object} deps.activityObserver - The server's activity observer, which governed finalization reports to.
 * @returns {void}
 */
function register(deps) {
  const { controlRefused, coordinatorGateRefused, _startupPromptProofOptions, activityObserver } = deps;

  // POST /api/sessions/:project — Launch session
  route('POST', '/api/sessions/:project', async (_req, res, params, body) => {
    const project = projects.getProjectRow(params.project);
    if (!project) {
      return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    }
    // #2129: only the operator or the Project Master may launch a session —
    // never a project's own already-launched session, through this route.
    if (!_requireSessionLifecycleCaller(_req, res, { action: 'launch', targetProject: project, allowOwnProject: false, body })) {
      return;
    }

    // Stamp the session with the signed-in user, or null when no login is
    // required. The TangleClaw session is the only identity source (ADR 0016 OQ2).
    const owner = (_req.tcSession && _req.tcSession.username) || null;

    // #991, #1678: warm the CI verdict and the checkout facts OFF the event loop
    // before the synchronous launch reads them for the prime. Shared with the
    // operator bridge's consented launch, which must start a session the same way.
    await launchWarmup.warmForLaunch(project);

    // The operator's own request carries the host they actually reached this
    // server on — better evidence than probing this machine, which names the box
    // rather than whatever proxy hostname they typed. Same trust gate as `owner`.
    const operatorTopology = sessionOwnership.resolveOperatorHost(_req.headers, store.config.load());
    const operatorHost = operatorTopology.host;
    // `source` is the only thing separating "no header sent" from "a header was
    // refused as duplicated, malformed or loopback". Without it a prime that says
    // the host is unknown is indistinguishable from one that never looked.
    log.debug('Resolved operator host for launch', {
      project: params.project, host: operatorHost, source: operatorTopology.source
    });

    const result = sessions.launchSession(params.project, {
      primePrompt: body ? body.primePrompt : true,
      operatorHost,
      engineOverride: body ? body.engineOverride : null,
      mode: body ? body.mode : undefined,
      launchMode: body ? body.launchMode : undefined,
      continuityMode: body ? body.continuityMode : undefined,
      // #1539: stranded wraps the operator acknowledges as part of this launch.
      acknowledgeStranded: body ? body.acknowledgeStranded : undefined,
      // #2401: proceed past a missing/placeholder-path warning the operator
      // has already seen and confirmed.
      confirmFreshStart: Boolean(body && body.confirmFreshStart === true),
      owner
    });

    // Web UI mode — delegate to async launch path
    if (result.webui) {
      const launchOpts = {
        force: body ? body.force === true : false,
        // #210 Phase 2 — forward the launch-mode picker choice through to
        // launchWebuiSession so it can pre-create a ClawBridge session
        // with the matching permissionMode (resolved against the engine
        // profile's bridgePermissionMode mapping).
        launchMode: body ? body.launchMode : null,
        owner  // the webui session is stamped with the signed-in user too
      };
      sessions.launchWebuiSession(params.project, result._conn, result._engineId, result._engineProfile, result._project, launchOpts)
        .then((webuiResult) => {
          if (webuiResult.error) {
            const status = webuiResult.staleTunnel ? 409 : 500;
            const code = webuiResult.staleTunnel ? 'TUNNEL_CONFLICT' : 'INTERNAL_ERROR';
            const payload = { error: webuiResult.error, code };
            if (webuiResult.staleTunnel) payload.staleTunnel = webuiResult.staleTunnel;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
            return;
          }
          _checkStrandedAfterLaunch(project);
          jsonResponse(res, 201, {
            sessionId: webuiResult.session.id,
            project: params.project,
            engine: webuiResult.session.engineId,
            sessionMode: 'webui',
            // The session row records the mode that actually took effect: the
            // requested one only when the ClawBridge pre-create succeeded.
            launchMode: webuiResult.session.launchMode || null,
            strandedUnchecked: result.strandedUnchecked || null,
            tmuxSession: null,
            primePrompt: null,
            startedAt: webuiResult.session.startedAt,
            iframeUrl: webuiResult.iframeUrl,
            ttydUrl: null,
            // A web UI launch starts no engine process on this host, so it never
            // has a private socket root. Null, as on a tmux launch whose engine
            // declares none: present, so a caller need not tell absent from none.
            privateTempRoot: null,
            // No engine starts on this host, so no launch-isolation check runs
            // and no override can apply. Present for the same reason as above.
            isolationOverride: null,
            // #2401: the webui branch returns before launchSession reaches the
            // path-health check at all, so there is no real answer to carry —
            // present and null for the same reason as the two fields above.
            pathHealthWarning: null
          });
        })
        .catch((err) => {
          errorResponse(res, 500, `Web UI launch failed: ${err.message}`, 'INTERNAL_ERROR');
        });
      return;
    }

    if (result.error) {
      // A refusal that carries a CODE is classified by it. The prose matching below
      // predates codes here and stays for the callers that still return only a
      // sentence, but nothing new should join them: a status code that depends on
      // the wording of a message changes when the message is improved.
      // #1861: a STOPPED lane (or an unreadable control store for a governed
      // one) refuses the launch with the gate's own status and bounded details.
      if (result.controlRefusal) {
        const r = result.controlRefusal;
        return errorResponse(res, r.status, r.message, r.code, r.details);
      }
      if (result.code === 'LIVENESS_UNKNOWN') {
        // 503, not 500: nothing internal failed. tmux — a dependency — did not
        // answer, this call changed nothing, and trying again once the server is
        // responsive is the remedy.
        return errorResponse(res, 503, result.error, result.code);
      }
      // #1539: stranded wraps hold the launch. 409 with the items, so the client
      // can show them and resend the launch acknowledging each one. The other
      // codes are an acknowledgement in that resend that failed.
      if (result.code === 'STRANDED_WRAPS') {
        return errorResponse(res, 409, result.error, result.code, { items: result.items });
      }
      // #2233: the engine command could not be shown isolated from a background
      // process the engine shares between sessions, so no pane was created. 409
      // with the adapter's reason code and recovery, never a 500: nothing failed.
      if (result.code === 'LAUNCH_ISOLATION_UNVERIFIED') {
        return errorResponse(res, 409, result.error, result.code, result.isolation);
      }
      // Train 21: the pane started and its session row did not. The code travels
      // so the dashboard can say whether a pane was left running.
      if (result.code === 'ORPHANED_LAUNCH' || result.code === 'LAUNCH_BIND_FAILED') {
        return errorResponse(res, 500, result.error, result.code);
      }
      // #2128: the installed engine profile is not the profile that was asked
      // for (not a profile object, or no matching `id`). 409, not 500: nothing
      // internal failed and nothing was started; the profile file is what needs
      // repairing, and the message says how.
      if (result.code === 'ENGINE_PROFILE_INVALID') {
        return errorResponse(res, 409, result.error, result.code);
      }
      const ackStatus = { BAD_REQUEST: 400, NOT_FOUND: 404, WRITE_FAILED: 500 }[result.code];
      if (ackStatus) {
        return errorResponse(res, ackStatus, result.error, result.code);
      }
      if (result.error.includes('already active')) {
        return errorResponse(res, 409, result.error, 'CONFLICT');
      }
      if (result.error.includes('not available')) {
        return errorResponse(res, 400, result.error, 'BAD_REQUEST');
      }
      return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
    }

    _checkStrandedAfterLaunch(project);
    jsonResponse(res, 201, {
      sessionId: result.session.id,
      project: params.project,
      engine: result.session.engineId,
      sessionMode: result.session.sessionMode || 'tmux',
      launchMode: result.session.launchMode || null,
      tmuxSession: result.session.tmuxSession,
      primePrompt: result.primePrompt,
      startedAt: result.session.startedAt,
      iframeUrl: null,
      ttydUrl: result.ttydUrl,
      // #2401: present only when the project's folder looked missing or
      // placeholder-only — the launch still proceeded, this just gives the
      // operator the same warning unarchive would have refused on.
      pathHealthWarning: result.pathHealthWarning || null,
      // #1539: why the stranded-wrap check was skipped, or null when it ran.
      strandedUnchecked: result.strandedUnchecked || null,
      // #1904: whether the engine got its private socket root, and if not, which
      // path failed and the hand-run fix. Null for an engine that declares none.
      privateTempRoot: result.privateTempRoot || null,
      // #2229: the launch-isolation override this launch ran under, as the
      // launch reports it. Null for a launch that needed none.
      isolationOverride: result.isolationOverride || null
    });
  });

  // DELETE /api/sessions/:project — Kill session
  route('DELETE', '/api/sessions/:project', (_req, res, params, body) => {
    // #2129: only the operator or the Project Master may kill a session —
    // never a project's own already-launched session, through this route.
    const killProject = projects.getProjectRow(params.project);
    if (!_requireSessionLifecycleCaller(_req, res, { action: 'kill', targetProject: killProject, allowOwnProject: false, body })) {
      return;
    }
    const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
    if (!passwordCheck.allowed) {
      return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
    }

    const result = sessions.killSession(params.project, body ? body.reason : undefined);
    if (result.error) {
      if (result.error.includes('not found') || result.error.includes('No active')) {
        return errorResponse(res, 404, result.error, 'NOT_FOUND');
      }
      return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
    }

    // Orphan tmux reconciliation — DB had no session row but tmux had one (#105).
    if (result.reconciled) {
      return jsonResponse(res, 200, {
        ok: true,
        project: params.project,
        reconciled: true
      });
    }

    jsonResponse(res, 200, {
      ok: true,
      sessionId: result.session.id,
      project: params.project,
      durationSeconds: result.session.durationSeconds,
      status: result.session.status
    });
  });

  // GET /api/sessions/:project/status — Session status + idle detection
  route('GET', '/api/sessions/:project/status', (_req, res, params) => {
    const status = sessions.getSessionStatus(params.project);
    if (!status) {
      return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    }
    // The startup admission gate's read of this session (#1633), so the
    // session page can show "Starting — step X of 4" / "Needs attention" /
    // "Ready" from the same poll that already carries `launchBlocker`.
    status.startupReadiness = sessions.activeStartupReadiness(store.projects.getByName(params.project));
    jsonResponse(res, 200, status);
  });

  // POST /api/sessions/:project/startup-prompt/fire — fire the current prompt at
  // one exact launch. Body: {sessionId, sequenceId, expectedRevision,
  // idempotencyKey}; the path project, session and sequence must agree. The
  // operator (strict write), or an agent session whose project the current
  // revision lists as a firer and which shares a project group with the target.
  // An out-of-scope target answers the same 404 as a missing one, and the denial
  // is recorded internally. Every fire is recorded in startup_prompt_fires; an
  // engine with no supported startupControl channel gets a typed 409, with no
  // fallback.
  route('POST', '/api/sessions/:project/startup-prompt/fire', async (req, res, params, body) => {
    // #2032: firing a startup prompt starts a turn in the coordinator's thread,
    // so it is judged by the epoch gate like a typed command.
    const gatedProject = store.projects.getByName(params.project);
    if (gatedProject && coordinatorGateRefused(req, res, gatedProject.id, 'session-command')) return;
    const access = sharedDocsAccess.resolveAccess(req);
    let clearance = 'project-binding';
    if (access.kind === 'operator') {
      const proof = _requireOperatorWrite(req, res,
        _startupPromptProofOptions('fire the startup prompt', { project: params.project }));
      if (!proof) return;
      clearance = proof.clearance;
    } else {
      const refusal = sharedDocsAccess.projectRefusalFor(access, sharedDocsAccess.NEEDS.OWN_PROJECT);
      if (refusal) return errorResponse(res, refusal.status, refusal.message, refusal.code);
    }
    const b = body && typeof body === 'object' ? body : {};
    // #1861 — the startup prompt is opaque injected work: a held lane takes none.
    const fireProject = store.projects.getByName(params.project);
    if (fireProject && controlRefused(res, { surface: 'startup-prompt-fire', subject: { kind: 'target', projectId: fireProject.id } })) return;
    const result = await startupPrompt.fire({
      projectName: params.project,
      sessionId: b.sessionId,
      sequenceId: b.sequenceId,
      expectedRevision: b.expectedRevision,
      idempotencyKey: b.idempotencyKey,
      caller: access,
      clearance
    });
    if (result.status >= 400) {
      log.warn('Startup prompt fire refused', { project: params.project, code: result.body.code, caller: access.kind });
      return errorResponse(res, result.status, result.body.error, result.body.code, result.body);
    }
    jsonResponse(res, result.status, result.body);
  }, { gatedAction: 'session-command' });

  // POST /api/sessions/:project/command — Inject command
  route('POST', '/api/sessions/:project/command', (_req, res, params, body) => {
    // #2032: typing into a coordinator's pane can hand it new work, so a
    // coordinator bound to a rotation epoch is typed into only from its bound
    // replacement (or by the operator), and not at all while it reconciles. The
    // rotation's own /clear does not come through here.
    const commandProject = store.projects.getByName(params.project);
    if (commandProject && coordinatorGateRefused(_req, res, commandProject.id, 'session-command')) return;
    // Checked before the startup admission gate below (#1633 R2 Fix 4): a held
    // or stopped lane answers 423 CONTROL_HELD/CONTROL_STOPPED either way, and
    // must keep doing so once a session with no bound launch sequence starts
    // failing the readiness gate closed instead of open — a held lane should
    // never read as merely "not ready yet".
    if (commandProject && controlRefused(res, { surface: 'session-command', subject: { kind: 'target', projectId: commandProject.id } })) return;
    if (!body || !body.command) {
      return errorResponse(res, 400, 'command is required', 'BAD_REQUEST');
    }
    if (body.command.length > 4096) {
      return errorResponse(res, 400, 'Command exceeds maximum length of 4096 characters', 'BAD_REQUEST');
    }

    // #2402 (1): a leading `/` runs as a slash command in the RECIPIENT before
    // it is read as a message — a peer session or the Master injecting
    // "[DIRECT INPUT ...] /clear" (or any other slash command) would act on
    // the recipient's pane, not merely be read by it. Refused for anyone the
    // verified-caller resolver does not say is the operator — EXCEPT a
    // governed `/clear` from a delegated Fleet Coordinator/ProjectManager
    // (#2824, Rule #285 §5), and only while the target lane itself currently
    // composes AVAILABLE/safe-to-clear. Whitespace ahead of the slash does
    // not excuse it, since the recipient's own TUI strips leading whitespace
    // the same way a human's paste would.
    const access = sharedDocsAccess.resolveAccess(_req);
    if (/^\s*\//.test(body.command) && access.kind !== sharedDocsAccess.KINDS.OPERATOR) {
      let governedClear;
      try {
        governedClear = /^\s*\/clear\s*$/.test(body.command) && commandProject
          && _isDelegatedSafeClear(access, commandProject, activityObserver);
      } catch (err) {
        if (!(err instanceof controlState.ControlError)) throw err;
        return errorResponse(res, err.status, err.message, err.code, err.details || {});
      }
      if (!governedClear) {
        return errorResponse(res, 403,
          'A command beginning with "/" runs a slash command in the recipient session and is refused from '
            + 'anyone but the operator.', 'SLASH_COMMAND_OPERATOR_ONLY');
      }
    }

    // The startup admission gate (#1633): ordinary task work waits for the
    // session's current launch sequence to be READY, so it is never typed
    // into a pane still mid-prime or sitting on an uncleared recovery.
    // `startupIntervention: true` is the dialog/recovery/auth sender's own
    // escape hatch — those sends ARE the thing clearing the launch, so they
    // cannot wait behind it.
    if (body.startupIntervention !== true) {
      const readiness = sessions.activeStartupReadiness(commandProject);
      if (readiness.state !== 'ready') {
        return errorResponse(res, 409,
          `This session's launch is not yet ready (${readiness.state}).`, 'STARTUP_NOT_READY', { startupReadiness: readiness });
      }
    }

    // #2402 (2): without a stamp, text typed by a verified peer project or the
    // Master is indistinguishable in the pane from the operator's own typing.
    // The stamp is a line the SERVER prepends from the verified caller
    // `resolveAccess` already proved — never from anything in `body` — so the
    // sender cannot choose or omit it. The operator gets no stamp: it is
    // already distinguished by needing none. Passed as `serverPrefix` rather
    // than concatenated here: `injectCommand`'s own 4096-char cap checks
    // `body.command` alone that way, so a documented-size submission from a
    // verified peer cannot fail only because the stamp pushed it over a limit
    // that was never about the stamp.
    const senderStamp = _verifiedSenderStamp(access);

    const result = sessions.injectCommand(params.project, body.command, {
      enter: body.enter !== false,
      serverPrefix: senderStamp
    });

    if (!result.ok && result.controlRefusal) {
      const r = result.controlRefusal;
      return errorResponse(res, r.status, r.message, r.code, r.details);
    }
    if (!result.ok && result.startupDialog) {
      // The send was withheld for an engine startup dialog (#2128): one on the
      // pane, a recorded blocker not yet positively cleared, or a half-drawn
      // frame. Nothing failed, and the caller needs to know which dialog.
      return errorResponse(res, 409, result.error, 'STARTUP_DIALOG', { startupDialog: result.startupDialog });
    }
    if (!result.ok && result.wrapRunning) {
      // The send was withheld because the project's wrap is running (#2269):
      // nothing failed, the same way a startup dialog withholding it is not a
      // failure — the caller needs to know a wrap, not an error, is why.
      return errorResponse(res, 409, result.error, 'WRAP_RUNNING', { wrapRunning: result.wrapRunning });
    }
    if (!result.ok) {
      if (result.error.includes('not found') || result.error.includes('No active')) {
        return errorResponse(res, 404, result.error, 'NOT_FOUND');
      }
      return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
    }

    // #2402 (3): a 200 used to mean only "this was typed" — nothing told the
    // sender it actually went in, as whom, or when. The receipt names the
    // verified caller the stamp (if any) was drawn from, so a peer session
    // can confirm its own identity reached the pane correctly.
    jsonResponse(res, 200, {
      ok: true,
      project: params.project,
      command: body.command,
      receipt: {
        submittedAt: new Date().toISOString(),
        stamped: senderStamp !== null,
        verifiedCaller: _verifiedCallerSummary(access)
      }
    });
  }, { maxBodySize: MESSAGE_BODY_LIMIT_BYTES, gatedAction: 'session-command' });

  // POST /api/sessions/:project/finalize — Governed headless finalization (#2027).
  // A reconciled, clean, drained session is retired by itself or by the principal
  // its assignment names in `authority.lifecycle`, with no drawer, no wrap
  // pipeline and no git. Every precondition and the order they are checked in live
  // in `lib/session-finalize.js`; `tc finalize` is the client. Unlike
  // `/wrap/complete`, the caller must be a verified launch and must name the
  // session, and a repeat after success answers the same outcome again.
  route('POST', '/api/sessions/:project/finalize', async (req, res, params, body) => {
    // The coordinator epoch fence (#2032): ending a lane is a wrap of that lane,
    // and a coordinator exercising lifecycle authority over another lane is
    // exercising control authority, so a rotating coordinator is fenced as both.
    const finalizeProject = store.projects.getByName(params.project);
    if (finalizeProject && coordinatorGateRefused(req, res, finalizeProject.id, 'wrap')) return;
    const finalizeCaller = _callerProjectId(req);
    if (finalizeCaller !== null && (!finalizeProject || finalizeCaller !== finalizeProject.id)
        && coordinatorGateRefused(req, res, finalizeCaller, 'control-mutate')) return;
    const result = await sessionFinalize.finalize({ req, projectName: params.project, body, observer: activityObserver });
    if (!result.ok) return errorResponse(res, result.status, result.message, result.code, result.details);
    return jsonResponse(res, result.status, result.body);
  }, { gatedAction: 'wrap' });

  // GET /api/sessions/:project/peek — Peek at terminal output
  route('GET', '/api/sessions/:project/peek', (req, res, params) => {
    const urlObj = reqUrl(req);
    const query = parseQuery(urlObj.search);
    const full = query.full === 'true';
    const lines = query.lines ? parseInt(query.lines, 10) : 5;

    const result = sessions.peek(params.project, { lines, full });
    if (result.error) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }

    jsonResponse(res, 200, {
      lines: result.lines,
      project: params.project,
      tmuxSession: result.tmuxSession,
      alternateScreen: result.alternateScreen || false
    });
  });

  // GET /api/sessions/:project/clipboard — the newest tmux buffer, i.e. what the
  // operator last copied in the terminal (#438). Touch devices have no Option
  // key for the #431 local-selection gesture, so this is their copy path: the
  // TUI's own copy sets a tmux buffer server-side, and the session page hands
  // it to the browser clipboard. Every refusal is a 404 with the reason and a
  // code the client can name — "nothing to copy yet" is not "session gone".
  route('GET', '/api/sessions/:project/clipboard', (_req, res, params) => {
    const result = sessions.clipboard(params.project);
    if (result.error) {
      return errorResponse(res, 404, result.error, result.code || 'NOT_FOUND');
    }

    jsonResponse(res, 200, {
      text: result.text,
      chars: result.text.length,
      project: params.project,
      tmuxSession: result.tmuxSession
    });
  });

  // GET /api/sessions/:project/history — Session history
  route('GET', '/api/sessions/:project/history', (req, res, params) => {
    const urlObj = reqUrl(req);
    const query = parseQuery(urlObj.search);

    const result = sessions.getSessionHistory(params.project, {
      limit: query.limit ? parseInt(query.limit, 10) : 20,
      status: query.status || undefined
    });

    if (result.error) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }

    jsonResponse(res, 200, {
      sessions: result.sessions,
      total: result.total
    });
  });

  // #2352: durable scoped permission requests (Architect Ruling A475-W2C-TRUST,
  // confirmed A475-W2C-R1). The record and its state machine live in
  // `lib/permission-requests.js`; these four routes are its HTTP surface.

  /**
   * Translate a `{ok, code, message, request}` result from
   * `lib/permission-requests.js` into an HTTP response. `request` (present on
   * both success and most failures) is always serialized camelCase, exactly
   * as that module returns it.
   * @param {http.ServerResponse} res
   * @param {object} result
   * @returns {void}
   */
  function _respondPermissionResult(res, result) {
    if (result.ok) return jsonResponse(res, result.replay ? 200 : 201, result);
    const status = {
      PERMISSION_REQUEST_NOT_FOUND: 404,
      PERMISSION_REQUEST_EXPIRED: 409,
      PERMISSION_LAUNCH_SUPERSEDED: 409,
      PERMISSION_DECISION_CONFLICT: 409,
      PERMISSION_SCOPE_MISMATCH: 409,
      PERMISSION_BRIDGE_DUPLICATE_DECISION: 409,
      PERMISSION_BRIDGE_BODY_MISMATCH: 409,
      PERMISSION_BRIDGE_DECISION_AMBIGUOUS: 409,
      PERMISSION_BRIDGE_DECISION_MISMATCH: 409,
      AMBIGUOUS_PERMISSION_REPLY: 400,
      PERMISSION_DECISION_INVALID: 400,
      PERMISSION_SCOPE_BUNDLED: 400,
      PERMISSION_REQUEST_INVALID: 400,
      PERMISSION_BRIDGE_UNAUTHORIZED: 403,
      PERMISSION_BRIDGE_BODY_UNAVAILABLE: 409
    }[result.code] || 400;
    return errorResponse(res, status, result.message, result.code, { recovery: result.recovery, request: result.request });
  }

  /**
   * Whether this caller may read a permission request belonging to `projectId`:
   * the Operator, the Master, or that project's own verified launch.
   * @param {{kind: string, projectId: (number|null)}} access
   * @param {number} projectId
   * @returns {boolean}
   */
  function _mayReadPermissionsFor(access, projectId) {
    return access.kind === sharedDocsAccess.KINDS.OPERATOR
      || access.kind === sharedDocsAccess.KINDS.MASTER
      || (access.kind === sharedDocsAccess.KINDS.PROJECT && access.projectId === projectId);
  }

  // POST /api/sessions/:project/permissions — a verified project launch asks
  // for a scoped permission. Idempotent on (sessionId, launchId, body.requestId).
  route('POST', '/api/sessions/:project/permissions', (req, res, params, body) => {
    const project = projects.getProjectRow(params.project);
    // Same fence every other session-scoped mutation in this family applies
    // (#2032): a rotating coordinator asking for a permission on another
    // lane's behalf is new work handed to a pane that has not claimed the
    // epoch yet.
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (access.kind !== sharedDocsAccess.KINDS.PROJECT || access.projectId !== project.id) {
      return errorResponse(res, 403, 'Only a verified launch of this project may ask for a permission.', 'FORBIDDEN');
    }
    const b = body && typeof body === 'object' ? body : {};
    if (!b.requestId || typeof b.requestId !== 'string') {
      return errorResponse(res, 400, 'requestId (an idempotency key) is required', 'BAD_REQUEST');
    }
    const result = permissionRequests.createPermissionRequest({
      idemKey: `${access.sessionId}:${access.launchId}:${b.requestId}`,
      projectId: project.id,
      sessionId: access.sessionId,
      launchId: access.launchId,
      scope: b.scope,
      scopeTarget: b.scopeTarget,
      gate: b.gate,
      actionSummary: b.actionSummary,
      expectedAnswer: b.expectedAnswer,
      ttlMs: b.ttlMs
    });
    _respondPermissionResult(res, result);
  }, { gatedAction: 'session-command' });

  // GET /api/sessions/:project/permissions — session-scoped listing, for the
  // Operator, the Master, or this project's own verified launch. A read by the
  // requesting launch itself marks every returned request's receipt delivered.
  route('GET', '/api/sessions/:project/permissions', (req, res, params) => {
    const project = projects.getProjectRow(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayReadPermissionsFor(access, project.id)) {
      return errorResponse(res, 403, 'Not permitted to read this project\'s permission requests.', 'FORBIDDEN');
    }
    const urlObj = reqUrl(req);
    const query = parseQuery(urlObj.search);
    // Deliberately asymmetric, not a parity bug: the requesting launch sees
    // only its OWN current session's requests (`access.sessionId`) — a
    // session has no business reading an earlier relaunch's asks. The
    // Operator and the Master instead span every session this project has
    // ever had (up to 100), since either may need the full history to
    // decide something the requesting launch itself never saw pending.
    const sessionIds = access.kind === sharedDocsAccess.KINDS.PROJECT
      ? [access.sessionId]
      : store.sessions.list(project.id, { limit: 100 }).map((s) => s.id);
    const requests = sessionIds
      .flatMap((sessionId) => permissionRequests.listPermissionRequestsForSession(sessionId, { state: query.state || undefined }))
      .sort((a, b2) => (a.createdAt < b2.createdAt ? 1 : -1));
    if (access.kind === sharedDocsAccess.KINDS.PROJECT) {
      for (const r of requests) permissionRequests.markReceiptDelivered(r.requestId);
    }
    jsonResponse(res, 200, { requests });
  });

  // GET /api/permissions/requests/:requestId — the durable request + decision
  // receipt, for the Operator, the Master, or the requesting project's own
  // verified launch. A read by the requesting launch marks receipt_delivered_at.
  route('GET', '/api/permissions/requests/:requestId', (req, res, params) => {
    const existing = permissionRequests.getPermissionRequest(params.requestId);
    if (!existing) return errorResponse(res, 404, `No permission request "${params.requestId}"`, 'PERMISSION_REQUEST_NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayReadPermissionsFor(access, existing.projectId)) {
      return errorResponse(res, 403, 'Not permitted to read this permission request.', 'FORBIDDEN');
    }
    const isRequestingLaunch = access.kind === sharedDocsAccess.KINDS.PROJECT && access.sessionId === existing.sessionId;
    const result = isRequestingLaunch ? permissionRequests.markReceiptDelivered(params.requestId) : { ok: true, request: existing };
    jsonResponse(res, 200, { request: result.request });
  });

  // POST /api/permissions/requests/:requestId/decide — grant or refuse. Two
  // trust boundaries share this one route: the Operator (dashboard, proven by
  // `_requireOperatorWrite`'s CSRF check) and a verified Master relay reporting
  // a Discord reply it already resolved (`permissionRequests.decideFromBridge`,
  // which separately verifies the reply's own provenance — see that module).
  route('POST', '/api/permissions/requests/:requestId/decide', (req, res, params, body) => {
    const access = sharedDocsAccess.resolveAccess(req);
    const b = body && typeof body === 'object' ? body : {};
    if (access.kind === sharedDocsAccess.KINDS.OPERATOR) {
      const proof = _requireOperatorWrite(req, res, {
        logEvent: 'Refused a permission decision',
        logContext: { requestId: params.requestId },
        fallbackAction: 'decide a permission request',
        sameOriginWhat: 'A permission decision',
        unauthenticated: 'Sign in to decide a permission request.',
        machineClient: 'A local process may not decide a permission request.',
        openToken: 'An open-install token is required to decide a permission request.',
        gateUnsupported: (gateState) => `Cannot decide a permission request while the login gate is "${gateState}".`
      });
      if (!proof) return;
      return _respondPermissionResult(res, permissionRequests.decidePermissionRequest(params.requestId, {
        decision: b.decision,
        decidedBySurface: 'dashboard',
        decidedByActor: proof.actor || 'operator',
        decisionProof: JSON.stringify({ clearance: proof.clearance }),
        expectedScope: b.expectedScope
      }));
    }
    if (access.kind === sharedDocsAccess.KINDS.MASTER && typeof b.bridgeRouteId === 'string') {
      return _respondPermissionResult(res, permissionRequests.decideFromBridge(params.requestId, {
        decision: b.decision,
        expectedScope: b.expectedScope,
        bridgeRouteId: b.bridgeRouteId,
        replyText: b.replyText
      }));
    }
    return errorResponse(res, 403, 'Only the Operator or a verified Master relay may decide a permission request.', 'FORBIDDEN');
  });

  // GET /api/usage/windows — multi-provider usage & quota window telemetry
  // (#2599): rolling 5-hour/weekly/monthly usage per provider/model parsed
  // from each CLI's own local transcript log, the weekly reset schedule, any
  // operator calibration on file, and the recommended Builder model-tier
  // policy. Read-only and fleet-wide (not scoped to one project), so it needs
  // no caller binding, the same as `GET /api/ports` — but, UNLIKE `GET
  // /api/ports`, none of `claudeProjectsDir`/`codexSessionsDir`/
  // `antigravityBrainDir` are ever taken from the query string here:
  // `usageWindows.getUsageWindows` would hand any of them straight to a
  // recursive directory walk, and an unauthenticated caller must never
  // steer a server-side file read at an arbitrary path. Each override
  // exists in the library function for tests only.
  route('GET', '/api/usage/windows', (req, res) => {
    const urlObj = reqUrl(req);
    const query = parseQuery(urlObj.search);
    // A timestamp, unlike a directory path, steers nothing a server-side
    // read could be pointed at — only which already-parsed records a sum
    // includes — so it is safe to take from an unauthenticated query string.
    const sprintStartMs = query.sprintStartMs !== undefined ? Number(query.sprintStartMs) : undefined;
    jsonResponse(res, 200, usageWindows.getUsageWindows({
      policyProvider: query.provider || undefined,
      sprintStartMs: Number.isFinite(sprintStartMs) ? sprintStartMs : undefined
    }));
  });

  // POST /api/usage/calibrate — an operator's percentage correction (#2599):
  // parsed-transcript token totals are not the provider's own, possibly
  // weighted, quota accounting. #2599 names this an OPERATOR calibration —
  // restricted to the Operator (write-proofed the same way a dashboard
  // decision is) or the Project Master relay, never an ordinary project's
  // own verified launch: this is fleet-wide policy, not something one
  // Builder/Reviewer lane should be able to overwrite for every other lane.
  //
  // Deliberately NOT special-casing "the PM/decider project" by a hardcoded
  // project id: TangleClaw itself has no generic notion of one project
  // being another's appointed decider — that is this fleet's own
  // LANE_QUEUE/Charter convention, not a platform concept, and baking a
  // specific id into shared server code would be fleet-specific brittleness
  // in a generic file. If a decider project genuinely needs to calibrate,
  // route it through the Operator or Master, the same as any other lane.
  route('POST', '/api/usage/calibrate', (req, res, _params, body) => {
    const access = sharedDocsAccess.resolveAccess(req);
    if (access.kind === sharedDocsAccess.KINDS.OPERATOR) {
      const proof = _requireOperatorWrite(req, res, {
        logEvent: 'Refused a usage calibration',
        logContext: {},
        fallbackAction: 'calibrate usage windows',
        sameOriginWhat: 'A usage calibration',
        unauthenticated: 'Sign in to calibrate usage windows.',
        machineClient: 'A local process may not calibrate usage windows.',
        openToken: 'An open-install token is required to calibrate usage windows.',
        gateUnsupported: (gateState) => `Cannot calibrate usage windows while the login gate is "${gateState}".`
      });
      if (!proof) return;
    } else if (access.kind !== sharedDocsAccess.KINDS.MASTER) {
      return errorResponse(res, 403, 'Only the Operator or the Project Master may calibrate usage windows.', 'CALLER_NOT_AUTHORIZED');
    }
    const b = body && typeof body === 'object' ? body : {};
    const result = usageWindows.calibrateUsage({
      provider: b.provider, weeklyPct: b.weeklyPct, fiveHourPct: b.fiveHourPct, calibratedAt: b.calibratedAt
    });
    if (!result.ok) return errorResponse(res, 400, result.errors.join('; '), 'CALIBRATION_INVALID');
    jsonResponse(res, 200, { calibration: result.calibration });
  });

  // GET /api/usage/sessions — per-session live usage & context readings
  // (#2787): one row per live session answering "is this session close
  // enough to its own usage limit that a mechanical hand-off should happen
  // now" — a number, not a pane an operator has to eyeball by hand (#2787's
  // own repro: four Codex sessions frozen 7 hours on a rate-limit prompt
  // nobody was watching for). Read-only and fleet-wide, so it needs no caller
  // binding, the same as GET /api/usage/windows directly above and GET
  // /api/ports. Optional `?projectId=`, `?engine=`, `?lowOnly=true` filters.
  route('GET', '/api/usage/sessions', async (req, res) => {
    const query = parseQuery(reqUrl(req).search);
    if (query.projectId !== undefined && !Number.isFinite(Number(query.projectId))) {
      // A non-numeric projectId must be reported, not silently matched
      // against nothing — Number(NaN) in `_filterUsageSessionReadings`
      // would otherwise filter out every row and read as "no live sessions"
      // rather than "you asked for an invalid filter".
      return errorResponse(res, 400, 'projectId must be a number.', 'INVALID_PROJECT_ID');
    }
    const readings = await _buildUsageSessionReadings(query);
    const filtered = _filterUsageSessionReadings(readings, query);
    jsonResponse(res, 200, { sessions: filtered });
  });

  // GET /api/usage/sessions/:sessionId — one session's own reading (#2787).
  route('GET', '/api/usage/sessions/:sessionId', async (req, res, params) => {
    const sessionId = Number(params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return errorResponse(res, 400, 'sessionId must be a number.', 'INVALID_SESSION_ID');
    }
    // Forwards the query the same way the list route above does, so
    // ?lowUsageHandoffThresholdPct= overrides the 12% default here too —
    // the list route isn't the only caller that might want it.
    const query = parseQuery(reqUrl(req).search);
    const readings = await _buildUsageSessionReadings(query);
    const reading = readings.find((r) => r.sessionId === sessionId);
    if (!reading) return errorResponse(res, 404, `No live session "${sessionId}" has a usage reading.`, 'SESSION_NOT_FOUND');
    jsonResponse(res, 200, reading);
  });

  // POST /api/sessions/:project/switch-model — governed model/engine switch
  // (#2598): `boundary` mode (default) only ever touches a session provably
  // at a clean chunk boundary; `outage-takeover` snapshots whatever the
  // worktree holds before terminating an unresponsive one. Checked in the
  // same order every other mutation in this family uses (#2032, #1861): the
  // coordinator epoch fence first (a rotating coordinator has not claimed the
  // epoch yet, so this is new work handed to it), then the durable HOLD/STOP
  // gate, then who may ask. This is a consequential write — it can clear,
  // relaunch or kill the TARGET session — so only the Operator (write-proofed
  // the same way a dashboard decision is), the Project Master relay, or the
  // target project's own verified launch (acting on itself) may call it; an
  // unprivileged project trying to switch or kill a DIFFERENT lane is refused.
  route('POST', '/api/sessions/:project/switch-model', async (req, res, params, body) => {
    const switchProject = store.projects.getByName(params.project);
    if (switchProject && coordinatorGateRefused(req, res, switchProject.id, 'session-command')) return;
    if (switchProject && controlRefused(res, { surface: 'session-command', subject: { kind: 'target', projectId: switchProject.id } })) return;
    const access = sharedDocsAccess.resolveAccess(req);
    if (access.kind === sharedDocsAccess.KINDS.OPERATOR) {
      const proof = _requireOperatorWrite(req, res, {
        logEvent: 'Refused a model/engine switch',
        logContext: { project: params.project },
        fallbackAction: 'switch a session\'s model',
        sameOriginWhat: 'A model/engine switch',
        unauthenticated: 'Sign in to switch a session\'s model.',
        machineClient: 'A local process may not switch a session\'s model.',
        openToken: 'An open-install token is required to switch a session\'s model.',
        gateUnsupported: (gateState) => `Cannot switch a session's model while the login gate is "${gateState}".`
      });
      if (!proof) return;
    } else if (access.kind === sharedDocsAccess.KINDS.MASTER) {
      // The Project Master relay — a verified fleet-wide decider.
    } else if (access.kind === sharedDocsAccess.KINDS.PROJECT && switchProject && access.projectId === switchProject.id) {
      // A session switching its own model — allowed self-service.
    } else {
      return errorResponse(res, 403, 'Only the Operator, the Project Master, or this project\'s own verified launch may switch its model.', 'FORBIDDEN');
    }
    const b = body && typeof body === 'object' ? body : {};
    const result = await modelSwitch.switchSessionModel(params.project, {
      engine: b.engine, model: b.model, effort: b.effort, mode: b.mode, reason: b.reason
    }, { observer: activityObserver });
    if (!result.ok) return errorResponse(res, result.status, result.error, result.code, result.blockers ? { blockers: result.blockers } : undefined);
    jsonResponse(res, 200, result);
  }, { gatedAction: 'session-command' });

  // #2073 Slice 1 (Architect Ruling A2073): closed-loop session lifecycle
  // handoff. Every route below shares the SAME `_requireSessionLifecycleCaller`
  // `action: 'wrap'` gate the manual `/wrap` route and the governed-wrap
  // routes (`lib/routes/wrap.js`) already apply -- never a second, divergent
  // authority check. `lib/lifecycle-handoff.js` validates and records each
  // step; it does not perform the wrap or the launch itself except where its
  // own doc says so (`launchReplacement` calls `sessions.launchSession` for real).

  /**
   * The lifecycle-handoff delegate identity for the verified caller this
   * route's own `_requireSessionLifecycleCaller` call already admitted --
   * the same derivation `lib/routes/wrap.js#_governedInitiator` uses for
   * governed-wrap (#2072), mirrored here rather than shared across route
   * families to avoid a cross-family require.
   * @param {{kind: string, projectId?: number}} access - From `sharedDocsAccess.resolveAccess`
   * @returns {string} `'operator'`, `'master'`, or `'project:<id>'`
   */
  function _handoffDelegatePrincipal(access) {
    if (access.kind === sharedDocsAccess.KINDS.OPERATOR) return 'operator';
    return access.kind === sharedDocsAccess.KINDS.MASTER ? 'master' : `project:${access.projectId}`;
  }

  // POST /api/sessions/:project/lifecycle-handoff — checkpoint + open the handoff.
  route('POST', '/api/sessions/:project/lifecycle-handoff', (req, res, params, body) => {
    const target = store.projects.getByName(params.project);
    if (target && coordinatorGateRefused(req, res, target.id, 'wrap')) return;
    if (!_requireSessionLifecycleCaller(req, res, { action: 'wrap', targetProject: target, allowOwnProject: true, body })) return;
    const access = sharedDocsAccess.resolveAccess(req);
    const b = body || {};
    const r = lifecycleHandoff.createHandoff({
      projectName: params.project, sourceSessionId: b.sourceSessionId, transitionType: b.transitionType,
      delegatePrincipal: _handoffDelegatePrincipal(access), checkpoint: b.checkpoint
    });
    if (!r.ok) {
      const status = r.code === 'NOT_FOUND' ? 404 : (r.code === 'LIFECYCLE_HANDOFF_IN_PROGRESS' ? 409 : 400);
      return errorResponse(res, status, r.message, r.code, r);
    }
    jsonResponse(res, 201, { ok: true, handoff: r.handoff });
  }, { gatedAction: 'wrap' });

  // GET /api/sessions/:project/lifecycle-handoff — the project's one open handoff, if any.
  route('GET', '/api/sessions/:project/lifecycle-handoff', (req, res, params) => {
    const target = store.projects.getByName(params.project);
    if (!target) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const open = lifecycleHandoff.getOpenForProject(target.id);
    if (!open) return errorResponse(res, 404, `"${params.project}" has no open lifecycle handoff`, 'NOT_FOUND');
    jsonResponse(res, 200, { ok: true, handoff: open });
  });

  /**
   * Shared shape for every `.../lifecycle-handoff/:handoffId/<step>` route:
   * gate, then call one `lib/lifecycle-handoff.js` step function with
   * `(handoffId, ...extra)`, answering its own result.
   * @param {(handoffId: string, ...extra: *) => object} stepFn
   * @param {(body: object, access: object) => *} [extraOf] - Reads `extra` from the request body
   *   and the verified caller `_requireSessionLifecycleCaller` already admitted (for
   *   `reconcileStartup`/`recordTakeover`'s own caller-identity proof -- never from anything the body
   *   claims). An array return spreads as multiple `stepFn` arguments (`reconcileStartup` needs both
   *   the caller AND the reconciliation receipt).
   * @param {{requireDelegate?: boolean}} [opts] - `requireDelegate: false` (default `true`) skips
   *   the recorded-delegate binding below for a step whose OWN authority proof binds to a DIFFERENT
   *   principal on purpose (`reconcileStartup`/`recordTakeover` bind to the REPLACEMENT, via
   *   `lifecycleHandoff`'s own `_isReplacementCaller` -- never the delegate who drove the earlier steps).
   * @returns {(req: object, res: object, params: object, body: object) => void}
   */
  function _handoffStepRoute(stepFn, extraOf, opts) {
    const requireDelegate = !opts || opts.requireDelegate !== false;
    return (req, res, params, body) => {
      const target = store.projects.getByName(params.project);
      if (!target) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
      if (coordinatorGateRefused(req, res, target.id, 'wrap')) return;
      if (!_requireSessionLifecycleCaller(req, res, { action: 'wrap', targetProject: target, allowOwnProject: true, body })) return;
      // PRR-B I-Gate Round 1 Finding 2 / A-Gate Round 1 Blocking 1: the URL's
      // :project authorizes the caller, not the record -- a handoff
      // belonging to a DIFFERENT project must 404 here, never be driven or
      // cancelled through a project the caller legitimately owns.
      const existing = lifecycleHandoff.getHandoff(params.handoffId);
      if (!existing || existing.projectId !== target.id) {
        return errorResponse(res, 404, `No lifecycle handoff "${params.handoffId}" for "${params.project}".`, 'NOT_FOUND');
      }
      const access = sharedDocsAccess.resolveAccess(req);
      // PRR-B I-Gate Round 2 Finding 4: `_requireSessionLifecycleCaller`
      // above proves general `wrap` authority over the TARGET project --
      // not that THIS caller is the specific principal `createHandoff`
      // recorded as this handoff's delegate. Without this, the target's own
      // session (admitted by `allowOwnProject: true`) could drive, fail or
      // cancel a handoff a DIFFERENT delegate was assigned. The operator
      // always has the explicit recovery path the review asked for.
      if (requireDelegate && access.kind !== sharedDocsAccess.KINDS.OPERATOR) {
        const principal = _handoffDelegatePrincipal(access);
        if (principal !== existing.delegatePrincipal) {
          return errorResponse(res, 403,
            `Only "${existing.delegatePrincipal}" (this handoff's own delegate) or the Operator may drive this step.`,
            'LIFECYCLE_HANDOFF_NOT_DELEGATE');
        }
      }
      const extra = extraOf ? extraOf(body || {}, access) : undefined;
      const r = Array.isArray(extra) ? stepFn(params.handoffId, ...extra) : stepFn(params.handoffId, extra);
      if (!r.ok) {
        const status = r.code === 'NOT_FOUND' ? 404
          : (r.code === 'LIFECYCLE_HANDOFF_INVALID' ? 400
            : (r.code === 'LIFECYCLE_HANDOFF_NOT_REPLACEMENT' ? 403 : 409));
        return errorResponse(res, status, r.message, r.code, r);
      }
      jsonResponse(res, 200, { ok: true, handoff: r.handoff, ...(r.launched ? { launched: r.launched } : {}) });
    };
  }

  route('POST', '/api/sessions/:project/lifecycle-handoff/:handoffId/wrap-initiated',
    _handoffStepRoute(lifecycleHandoff.recordWrapInitiated), { gatedAction: 'wrap' });
  route('POST', '/api/sessions/:project/lifecycle-handoff/:handoffId/terminal-confirmed',
    _handoffStepRoute(lifecycleHandoff.recordTerminalConfirmed), { gatedAction: 'wrap' });
  route('POST', '/api/sessions/:project/lifecycle-handoff/:handoffId/launch-replacement',
    _handoffStepRoute(lifecycleHandoff.launchReplacement, (b) => b.launchOptions), { gatedAction: 'wrap' });
  route('POST', '/api/sessions/:project/lifecycle-handoff/:handoffId/reconcile-startup',
    _handoffStepRoute(lifecycleHandoff.reconcileStartup,
      (b, access) => [access, { checkpointDigest: b.checkpointDigest, generation: b.generation !== undefined ? b.generation : null }],
      { requireDelegate: false }),
    { gatedAction: 'wrap' });
  route('POST', '/api/sessions/:project/lifecycle-handoff/:handoffId/takeover',
    _handoffStepRoute(lifecycleHandoff.recordTakeover, (_b, access) => access, { requireDelegate: false }), { gatedAction: 'wrap' });
  route('POST', '/api/sessions/:project/lifecycle-handoff/:handoffId/blocker',
    _handoffStepRoute(lifecycleHandoff.recordBlocker, (b) => ({ code: b.code, detail: b.detail })), { gatedAction: 'wrap' });
  route('POST', '/api/sessions/:project/lifecycle-handoff/:handoffId/cancel',
    _handoffStepRoute((handoffId, reason) => lifecycleHandoff.cancelHandoff(handoffId, reason), (b) => b.reason), { gatedAction: 'wrap' });

  // ---------------------------------------------------------------------
  // #2878 — lib/merge-inbox-gate.js's durable hold ledger, live over HTTP.
  // The ledger's own file is deliberately decided HERE (Slice 2's job, per
  // that module's own docstring): one file per TangleClaw project, under
  // its `.tangleclaw/` directory, so every lane that can reach this
  // project's session routes shares the same hold state regardless of
  // which lane's pane happens to be asking — the whole reason #1717 moved
  // merge authority out of an inbox message in the first place.
  // ---------------------------------------------------------------------

  /**
   * The durable hold store every project's merge-inbox-gate reads and
   * writes — ONE file, server-wide, not per-project (Architect Ruling
   * A504-W1A-R3 BLOCKING 2). `identity.repo` inside each hold is what scopes
   * a hold to a GitHub repository; keying the FILE by `:project` as well
   * split one repo's holds across however many different projects happened
   * to call this route under their own name, and left `lib/merge-queue.js`
   * — which has no `:project` URL context at all — with no file it could
   * reliably read the same ledger from. `store._getBasePath()` is the one
   * location every caller (every HTTP route, and `lib/merge-queue.js`
   * directly) can resolve the same way.
   * @returns {string}
   */
  function _mergeGateFile() {
    return path.join(store._getBasePath(), 'merge-inbox-gate-holds.json');
  }

  /**
   * Whether `access` may ISSUE a hold: the Operator, the Master, or any
   * verified project launch — the same breadth `lib/control-api.js`'s
   * HOLD/STOP accepts (`caller.kind === 'operator' || caller.kind ===
   * 'project'`), because a hold's whole point is authority that travels
   * across lanes, not one scoped to whichever project's file happens to
   * store it. Resolving (not clearing or overriding) is narrower -- see
   * {@link _mayAcknowledgeMergeGateHold}/{@link _mayOverrideMergeGateHold}
   * below (I-Gate R1 BLOCKING 3, PR #2908).
   * @param {{kind: string}} access
   * @returns {boolean}
   */
  function _mayWriteMergeGate(access) {
    return access.kind === sharedDocsAccess.KINDS.OPERATOR
      || access.kind === sharedDocsAccess.KINDS.MASTER
      || access.kind === sharedDocsAccess.KINDS.PROJECT;
  }

  /**
   * The caller's own VERIFIED identity label for a merge-gate action --
   * never a free-text field the request body supplies. The Operator/Master
   * are fixed labels; a project caller is its own verified project name
   * (the same string this fleet's lane ids already are, e.g. `TC-Lane-D`),
   * resolved from `access.projectId` -- the caller's OWN launch binding,
   * never `params.project` (a project may act on another project's merge
   * gate, #1717's whole point, so the URL's project name is not who is
   * acting). `null` for a kind this route does not expect to see (already
   * refused upstream by `_mayWriteMergeGate`/`_mayReadPermissionsFor`).
   * @param {{kind: string, projectId: (number|null)}} access
   * @returns {string|null}
   */
  function _mergeGateCallerIdentity(access) {
    if (access.kind === sharedDocsAccess.KINDS.OPERATOR) return 'operator';
    if (access.kind === sharedDocsAccess.KINDS.MASTER) return 'master';
    if (access.kind === sharedDocsAccess.KINDS.PROJECT) {
      const caller = store.projects.get(access.projectId);
      return caller ? caller.name : null;
    }
    return null;
  }

  /**
   * Whether `access` may acknowledge `hold`: the Operator, the Master, or
   * exactly the identity that issued it (I-Gate R1 BLOCKING 3) -- the
   * active lane rule's own "only the issuing reviewer resolves an
   * unresolved HOLD" applies identically to a merge-gate hold. A different
   * project's launch, however broadly it may issue its OWN holds, may not
   * clear one it did not issue.
   * @param {{kind: string, projectId: (number|null)}} access
   * @param {{issuedBy: string}} hold
   * @returns {boolean}
   */
  function _mayAcknowledgeMergeGateHold(access, hold) {
    if (access.kind === sharedDocsAccess.KINDS.OPERATOR || access.kind === sharedDocsAccess.KINDS.MASTER) return true;
    const identity = _mergeGateCallerIdentity(access);
    return identity !== null && identity === hold.issuedBy;
  }

  /**
   * Whether `access` may override `hold` for one named action (I-Gate R1
   * BLOCKING 3): the Operator, the Master, the identity that issued it
   * (overriding its own hold), or a caller whose verified project name
   * resolves to an `architect`, `pm` or `integrator` role under the SAME
   * lane-id mapping `lib/merge-role-guard.js#_resolveRoleCategory` already
   * uses for "who may merge a PR" -- a Builder or Reviewer lane may never
   * override a hold it did not issue, no matter how it is addressed.
   * @param {{kind: string, projectId: (number|null)}} access
   * @param {{issuedBy: string}} hold
   * @returns {boolean}
   */
  function _mayOverrideMergeGateHold(access, hold) {
    if (access.kind === sharedDocsAccess.KINDS.OPERATOR || access.kind === sharedDocsAccess.KINDS.MASTER) return true;
    const identity = _mergeGateCallerIdentity(access);
    if (identity === null) return false;
    if (identity === hold.issuedBy) return true;
    const category = mergeRoleGuard._resolveRoleCategory({ lane: identity });
    return category === 'architect' || category === 'pm' || category === 'integrator';
  }

  /** Map a `{ok:false, code}` merge-inbox-gate refusal to its HTTP status. */
  function _mergeGateStatus(code) {
    return { INVALID_IDENTITY: 400, INVALID_INPUT: 400, HOLD_NOT_FOUND: 404, HOLD_NOT_ACTIVE: 409, CORRUPT_STORE: 409 }[code] || 400;
  }

  function _respondMergeGateResult(res, result) {
    if (result.ok === false) return errorResponse(res, _mergeGateStatus(result.code), result.message, result.code);
    jsonResponse(res, 200, result);
  }

  /**
   * `lib/merge-inbox-gate.js#_identity` requires `pr`/`issue` to be actual
   * numbers (`Number.isInteger`) -- a numeric STRING fails closed as
   * `INVALID_IDENTITY`, which is exactly what both HTTP transports hand this
   * route by construction: a URL query value is always a string, and a JSON
   * body value is a string whenever the caller is itself a CLI (`tc
   * merge-gate`'s own flags are `process.argv` strings). Coerced once, here,
   * at the boundary, rather than asking every caller to know this library's
   * internal type strictness.
   * @param {*} v
   * @returns {number|undefined} The coerced integer, or the original value
   *   unchanged when it is not a numeric string -- `_identity` still refuses
   *   that case, correctly, with its own message.
   */
  function _coercePosInt(v) {
    if (typeof v === 'string' && /^[1-9][0-9]*$/.test(v)) return Number(v);
    return v;
  }

  /**
   * Build `{repo, pr?, branch?, issue?}` from a query string or a parsed
   * JSON body, coercing `pr`/`issue` to real numbers (see
   * {@link _coercePosInt}).
   * @param {object} source - `query` or `body`.
   * @returns {object}
   */
  function _mergeGateIdentity(source) {
    const s = source || {};
    return { repo: s.repo, pr: _coercePosInt(s.pr), branch: s.branch, issue: _coercePosInt(s.issue) };
  }

  // POST /api/sessions/:project/merge-gate/holds — issue a hold. `issuedBy`
  // is the caller's own VERIFIED identity (I-Gate R1 BLOCKING 3) -- an
  // Operator/Master may still name any actor; a project caller's hold is
  // recorded under its own verified project name, never a free-text body
  // field it could otherwise set to impersonate a different lane.
  route('POST', '/api/sessions/:project/merge-gate/holds', (req, res, params, body) => {
    const project = projects.getProjectRow(params.project);
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayWriteMergeGate(access)) return errorResponse(res, 403, 'Not permitted to issue a merge-gate hold.', 'FORBIDDEN');
    const b = body && typeof body === 'object' ? body : {};
    const isPrivileged = access.kind === sharedDocsAccess.KINDS.OPERATOR || access.kind === sharedDocsAccess.KINDS.MASTER;
    const issuedBy = isPrivileged ? (b.issuedBy || _mergeGateCallerIdentity(access)) : _mergeGateCallerIdentity(access);
    const result = mergeGateWiring.mergeGateIssueHold(_mergeGateFile(), {
      ..._mergeGateIdentity(b), reason: b.reason, issuedBy, supersedes: b.supersedes
    });
    _respondMergeGateResult(res, result);
  }, { gatedAction: 'session-command' });

  // POST /api/sessions/:project/merge-gate/holds/:holdId/ack — I-Gate R1
  // BLOCKING 3: only the identity that issued a hold (or the Operator/
  // Master) may acknowledge it. The hold is read FIRST so the authority
  // check runs against its real `issuedBy`, not a caller's own claim.
  route('POST', '/api/sessions/:project/merge-gate/holds/:holdId/ack', (req, res, params, body) => {
    const project = projects.getProjectRow(params.project);
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayWriteMergeGate(access)) return errorResponse(res, 403, 'Not permitted to acknowledge a merge-gate hold.', 'FORBIDDEN');
    const file = _mergeGateFile();
    const existing = mergeInboxGate.getHold(file, params.holdId);
    if (!existing) return errorResponse(res, 404, `No such hold "${params.holdId}"`, 'HOLD_NOT_FOUND');
    if (!_mayAcknowledgeMergeGateHold(access, existing)) {
      return errorResponse(res, 403, 'Only the identity that issued this hold (or the Operator/Master) may acknowledge it.', 'FORBIDDEN');
    }
    const isPrivileged = access.kind === sharedDocsAccess.KINDS.OPERATOR || access.kind === sharedDocsAccess.KINDS.MASTER;
    const b = body && typeof body === 'object' ? body : {};
    const by = isPrivileged ? (b.by || _mergeGateCallerIdentity(access)) : _mergeGateCallerIdentity(access);
    const result = mergeGateWiring.mergeGateAcknowledgeHold(file, params.holdId, { by, note: b.note });
    _respondMergeGateResult(res, result);
  }, { gatedAction: 'session-command' });

  // POST /api/sessions/:project/merge-gate/holds/:holdId/override — I-Gate
  // R1 BLOCKING 3: the issuer, an Operator/Master, or an authorized
  // architect/pm/integrator lane may override. The hold is read FIRST, same
  // reason as ack above.
  route('POST', '/api/sessions/:project/merge-gate/holds/:holdId/override', (req, res, params, body) => {
    const project = projects.getProjectRow(params.project);
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayWriteMergeGate(access)) return errorResponse(res, 403, 'Not permitted to override a merge-gate hold.', 'FORBIDDEN');
    const file = _mergeGateFile();
    const existing = mergeInboxGate.getHold(file, params.holdId);
    if (!existing) return errorResponse(res, 404, `No such hold "${params.holdId}"`, 'HOLD_NOT_FOUND');
    if (!_mayOverrideMergeGateHold(access, existing)) {
      return errorResponse(res, 403, 'Only the issuer, the Operator/Master, or an authorized architect/pm/integrator lane may override this hold.', 'FORBIDDEN');
    }
    const isPrivileged = access.kind === sharedDocsAccess.KINDS.OPERATOR || access.kind === sharedDocsAccess.KINDS.MASTER;
    const b = body && typeof body === 'object' ? body : {};
    const by = isPrivileged ? (b.by || _mergeGateCallerIdentity(access)) : _mergeGateCallerIdentity(access);
    const result = mergeGateWiring.mergeGateOverrideHold(file, params.holdId, { by, reason: b.reason, action: b.action });
    _respondMergeGateResult(res, result);
  }, { gatedAction: 'session-command' });

  // GET /api/sessions/:project/merge-gate/holds — list, optionally ?repo=&activeOnly=true.
  route('GET', '/api/sessions/:project/merge-gate/holds', (req, res, params) => {
    const project = projects.getProjectRow(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayReadPermissionsFor(access, project.id)) return errorResponse(res, 403, 'Not permitted to read this project\'s merge-gate holds.', 'FORBIDDEN');
    const query = parseQuery(reqUrl(req).search);
    const holds = mergeGateWiring.mergeGateListHolds(_mergeGateFile(), {
      repo: query.repo, activeOnly: query.activeOnly === 'true'
    });
    jsonResponse(res, 200, { holds });
  });

  // GET /api/sessions/:project/merge-gate/holds/:holdId
  route('GET', '/api/sessions/:project/merge-gate/holds/:holdId', (req, res, params) => {
    const project = projects.getProjectRow(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayReadPermissionsFor(access, project.id)) return errorResponse(res, 403, 'Not permitted to read this project\'s merge-gate holds.', 'FORBIDDEN');
    const hold = mergeInboxGate.getHold(_mergeGateFile(), params.holdId);
    if (!hold) return errorResponse(res, 404, `No such hold "${params.holdId}"`, 'HOLD_NOT_FOUND');
    jsonResponse(res, 200, { hold });
  });

  // GET /api/sessions/:project/merge-gate/evaluate — ?repo=&pr=&branch=&issue=&autoMerge=true
  route('GET', '/api/sessions/:project/merge-gate/evaluate', (req, res, params) => {
    const project = projects.getProjectRow(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayReadPermissionsFor(access, project.id)) return errorResponse(res, 403, 'Not permitted to evaluate this project\'s merge-gate.', 'FORBIDDEN');
    const query = parseQuery(reqUrl(req).search);
    const result = mergeGateWiring.mergeGateEvaluate({
      file: _mergeGateFile(), identity: _mergeGateIdentity(query), autoMerge: query.autoMerge === 'true'
    });
    _respondMergeGateResult(res, result);
  });

  // POST /api/sessions/:project/merge-gate/publish-status — inert unless body.enabled === true.
  route('POST', '/api/sessions/:project/merge-gate/publish-status', async (req, res, params, body) => {
    const project = projects.getProjectRow(params.project);
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayWriteMergeGate(access)) return errorResponse(res, 403, 'Not permitted to publish this project\'s merge-gate status check.', 'FORBIDDEN');
    const b = body && typeof body === 'object' ? body : {};
    const result = await mergeGateWiring.publishMergeGateStatusCheck({
      file: _mergeGateFile(), identity: _mergeGateIdentity(b), sha: b.sha, enabled: b.enabled === true
    });
    _respondMergeGateResult(res, result);
  }, { gatedAction: 'session-command' });

  // ---------------------------------------------------------------------
  // #2888 (Architect Scope Ruling A501-W1C-R1, I-Gate R2): mounting
  // lib/chunk-boundary-http.js's already-self-contained handlers onto
  // real routes, Slice 3 of #2836/#1889. Every handler already returns its
  // own `statusSurface` (lib/chunk-boundary-ui.js's view model) alongside
  // the raw receipt, so these routes serve that verbatim -- no extra
  // transformation needed here.
  // ---------------------------------------------------------------------

  /** Same breadth as {@link _mayWriteMergeGate}: the Operator, the Master, or any verified project launch. */
  function _mayWriteChunkBoundary(access) {
    return access.kind === sharedDocsAccess.KINDS.OPERATOR
      || access.kind === sharedDocsAccess.KINDS.MASTER
      || access.kind === sharedDocsAccess.KINDS.PROJECT;
  }

  /** Map a chunk-boundary handler's `{ok:false, code}` refusal to its HTTP status. */
  function _chunkBoundaryStatus(code) {
    return {
      CHUNK_BOUNDARY_RECEIPT_NOT_FOUND: 404,
      CHUNK_BOUNDARY_SUPERSEDED: 409,
      CHUNK_BOUNDARY_TRANSITION_INVALID: 409,
      CHUNK_BOUNDARY_OUTCOME_ALREADY_RECORDED: 409,
      CHUNK_BOUNDARY_OUTCOME_NOT_SUCCESSFUL: 409
    }[code] || 400;
  }

  /**
   * Answer a chunk-boundary handler's `{ok, ...}` result (every one of
   * `handleCreateReceipt`/`handleGetReceipt`/`handleMarkReadyToClear`/etc.
   * except `handleValidateNextChunkDispatch`, which answers through {@link
   * _respondChunkBoundaryAdmission} instead).
   * @param {object} res
   * @param {object} result
   * @param {number} [okStatus] - HTTP status on `ok:true` (200 unless given)
   * @returns {void}
   */
  function _respondChunkBoundaryResult(res, result, okStatus = 200) {
    if (result.ok) return jsonResponse(res, okStatus, result);
    return errorResponse(res, _chunkBoundaryStatus(result.code), result.message, result.code, { statusSurface: result.statusSurface });
  }

  /**
   * Whether `receipt` (or a `null` "no such receipt" answer) belongs to
   * `project` -- the same "the URL's :project authorizes, a caller-named id
   * must not reach across projects" check the merge-gate and governed-wrap
   * routes above already apply, adapted to a receipt that already carries
   * its own `projectId`.
   * @param {object} res
   * @param {object|null} receipt
   * @param {object} project
   * @param {string} receiptId - For the 404 message when `receipt` is null or mismatched
   * @returns {boolean}
   */
  function _receiptBelongsToProject(res, receipt, project, receiptId) {
    if (!receipt || receipt.projectId !== project.id) {
      errorResponse(res, 404, `No chunk-boundary receipt "${receiptId}" for "${project.name}".`, 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND');
      return false;
    }
    return true;
  }

  // POST /api/sessions/:project/chunk-boundary — create a receipt.
  // `projectId` is always the URL's resolved project, never trusted from
  // the body (same reasoning as every other identity field derived from
  // verified context elsewhere in this file).
  route('POST', '/api/sessions/:project/chunk-boundary', (req, res, params, body) => {
    const project = projects.getProjectRow(params.project);
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayWriteChunkBoundary(access)) return errorResponse(res, 403, 'Not permitted to create a chunk-boundary receipt.', 'FORBIDDEN');
    const b = body && typeof body === 'object' ? body : {};
    const result = chunkBoundaryHttp.handleCreateReceipt({ ...b, projectId: project.id });
    _respondChunkBoundaryResult(res, result, result.ok && !result.replay ? 201 : 200);
  }, { gatedAction: 'session-command' });

  // GET /api/sessions/:project/chunk-boundary/:receiptId — read one receipt.
  route('GET', '/api/sessions/:project/chunk-boundary/:receiptId', (req, res, params) => {
    const project = projects.getProjectRow(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const existing = chunkBoundary.getChunkBoundaryReceipt(params.receiptId);
    if (!_receiptBelongsToProject(res, existing, project, params.receiptId)) return;
    _respondChunkBoundaryResult(res, chunkBoundaryHttp.handleGetReceipt(params.receiptId));
  });

  // GET /api/sessions/:project/chunk-boundary?assignmentId=&chunkNumber= —
  // the receipt on record for one (project, assignment, chunk) triple.
  route('GET', '/api/sessions/:project/chunk-boundary', (req, res, params) => {
    const project = projects.getProjectRow(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const query = parseQuery(reqUrl(req).search);
    const chunkNumber = _coercePosInt(query.chunkNumber);
    if (!query.assignmentId || typeof chunkNumber !== 'number') {
      return errorResponse(res, 400, 'assignmentId and chunkNumber (a positive integer) are both required.', 'BAD_REQUEST');
    }
    _respondChunkBoundaryResult(res, chunkBoundaryHttp.handleGetReceiptForChunk(project.id, query.assignmentId, chunkNumber));
  });

  /**
   * The shared preamble every chunk-boundary MUTATION route on an existing
   * receipt needs: project lookup, the coordinator gate, write
   * permission, and that the named receipt actually belongs to this
   * project. Returns the project row to proceed with, or `null` once a
   * refusal has already been written.
   * @param {object} req
   * @param {object} res
   * @param {object} params
   * @returns {object|null}
   */
  function _chunkBoundaryMutationPreamble(req, res, params) {
    const project = projects.getProjectRow(params.project);
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return null;
    if (!project) {
      errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
      return null;
    }
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayWriteChunkBoundary(access)) {
      errorResponse(res, 403, 'Not permitted to act on this chunk-boundary receipt.', 'FORBIDDEN');
      return null;
    }
    const existing = chunkBoundary.getChunkBoundaryReceipt(params.receiptId);
    if (!_receiptBelongsToProject(res, existing, project, params.receiptId)) return null;
    return project;
  }

  // POST /api/sessions/:project/chunk-boundary/:receiptId/ready-to-clear
  route('POST', '/api/sessions/:project/chunk-boundary/:receiptId/ready-to-clear', (req, res, params) => {
    if (!_chunkBoundaryMutationPreamble(req, res, params)) return;
    _respondChunkBoundaryResult(res, chunkBoundaryHttp.handleMarkReadyToClear(params.receiptId));
  }, { gatedAction: 'session-command' });

  // POST /api/sessions/:project/chunk-boundary/:receiptId/clear-intent
  route('POST', '/api/sessions/:project/chunk-boundary/:receiptId/clear-intent', (req, res, params, body) => {
    if (!_chunkBoundaryMutationPreamble(req, res, params)) return;
    const b = body && typeof body === 'object' ? body : {};
    _respondChunkBoundaryResult(res, chunkBoundaryHttp.handleRecordClearIntent(params.receiptId, b));
  }, { gatedAction: 'session-command' });

  // POST /api/sessions/:project/chunk-boundary/:receiptId/clear-outcome
  route('POST', '/api/sessions/:project/chunk-boundary/:receiptId/clear-outcome', (req, res, params, body) => {
    if (!_chunkBoundaryMutationPreamble(req, res, params)) return;
    const b = body && typeof body === 'object' ? body : {};
    _respondChunkBoundaryResult(res, chunkBoundaryHttp.handleRecordClearOutcome(params.receiptId, b));
  }, { gatedAction: 'session-command' });

  // POST /api/sessions/:project/chunk-boundary/:receiptId/ready-after-clear
  route('POST', '/api/sessions/:project/chunk-boundary/:receiptId/ready-after-clear', (req, res, params, body) => {
    if (!_chunkBoundaryMutationPreamble(req, res, params)) return;
    const b = body && typeof body === 'object' ? body : {};
    _respondChunkBoundaryResult(res, chunkBoundaryHttp.handleAcknowledgeReadyAfterClear(params.receiptId, b));
  }, { gatedAction: 'session-command' });

  // POST /api/sessions/:project/chunk-boundary/:receiptId/supersede
  route('POST', '/api/sessions/:project/chunk-boundary/:receiptId/supersede', (req, res, params, body) => {
    if (!_chunkBoundaryMutationPreamble(req, res, params)) return;
    const b = body && typeof body === 'object' ? body : {};
    _respondChunkBoundaryResult(res, chunkBoundaryHttp.handleSupersede(params.receiptId, b));
  }, { gatedAction: 'session-command' });

  // POST /api/sessions/:project/chunk-boundary/validate-next-dispatch — the
  // admission gate itself, a pure read. Answers 200 with the verdict inline
  // (`ok:true`/`ok:false, hold:true`), the same "a gate's own refusal is a
  // normal answer, not an HTTP error" convention `/merge-gate/evaluate`
  // above already uses -- a HOLD is an expected, common outcome here, not
  // a caller mistake. `projectId` is forced from the URL, same as the
  // create-receipt route.
  route('POST', '/api/sessions/:project/chunk-boundary/validate-next-dispatch', (req, res, params, body) => {
    const project = projects.getProjectRow(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const b = body && typeof body === 'object' ? body : {};
    const result = chunkBoundaryHttp.handleValidateNextChunkDispatch({ ...(b.candidate || {}), projectId: project.id }, b.opts);
    jsonResponse(res, 200, result);
  });
}

/**
 * Every live session's own usage reading, built from the real store (#2787)
 * — the single place both `GET /api/usage/sessions` route handlers above
 * assemble `buildSessionUsageReadings`'s real inputs, so the list and
 * single-session routes can never disagree on how a reading is built.
 * @param {{lowUsageHandoffThresholdPct?: string}} query
 * @returns {Promise<object[]>}
 */
async function _buildUsageSessionReadings(query) {
  const projects = new Map(store.projects.list().map((p) => [p.id, p]));
  const thresholdPct = query.lowUsageHandoffThresholdPct !== undefined
    ? Number(query.lowUsageHandoffThresholdPct) : undefined;
  return usageWindows.buildSessionUsageReadings({
    sessions: store.sessions.listLiveAll(),
    projects,
    // No explicit getActiveModel here: buildSessionUsageReadings' own
    // default (_defaultGetActiveModel) already calls
    // profileReconciler._observeViaTrustedSource — passing it again would
    // just duplicate the default with no divergence (Critic note).
    lowUsageHandoffThresholdPct: Number.isFinite(thresholdPct) ? thresholdPct : undefined
  });
}

/**
 * Apply `GET /api/usage/sessions`'s own optional filters to an already-built
 * reading list (#2787).
 * @param {object[]} readings
 * @param {{projectId?: string, engine?: string, lowOnly?: string}} query
 * @returns {object[]}
 */
function _filterUsageSessionReadings(readings, query) {
  let out = readings;
  if (query.projectId !== undefined) {
    const projectId = Number(query.projectId);
    out = out.filter((r) => r.projectId === projectId);
  }
  if (query.engine) {
    out = out.filter((r) => r.engine === query.engine);
  }
  if (query.lowOnly === 'true') {
    out = out.filter((r) => r.lowUsageHandOffRecommended);
  }
  return out;
}

module.exports = { register };
