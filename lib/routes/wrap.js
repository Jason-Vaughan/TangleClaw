'use strict';

/**
 * The `/api/sessions/:project/wrap/*` route family — start, cancel, status,
 * the live run stream, the handback and its stream, the PR-status probe and
 * manual completion — with the two payload shapers the stream's `run-done`
 * frame and `GET /wrap/status` share (`_wrapResultPayload`,
 * `_wrapStreamFrame`), moved out of `server.js` unchanged (#2248).
 *
 * `register(deps)` registers the routes through the shared kernel, in the order
 * they held in `server.js`; the entry point calls it at the position the routes
 * held, so the route table reads as before. Three gate helpers the handlers
 * call still live in `server.js` — the durable HOLD/STOP gate
 * (`controlRefused`, `controlJobSubject`) and the coordinator epoch gate
 * (`coordinatorGateRefused`) — so they arrive as `deps` rather than through a
 * require of the entry point, which would be a cycle. When the areas that own
 * them have modules of their own, this one requires them from there and
 * `register` takes nothing.
 *
 * @module lib/routes/wrap
 */

const { createLogger } = require('../logger');
const store = require('../store');
const projects = require('../projects');
const sessions = require('../sessions');
const projectConfig = require('../project-config');
const wrapHandback = require('../wrap-handback');
const { WRAP_STREAM_EVENTS } = require('../../public/wrap-stream-events');
const { route, jsonResponse, errorResponse, reqUrl, parseQuery, MESSAGE_BODY_LIMIT_BYTES } = require('./_kernel');

// The logger keeps the entry point's name so every log line this family writes
// reads exactly as it did before the move.
const log = createLogger('server');

/**
 * Shape a finished run's outcome (a `sessions.triggerWrap`-shaped result) into
 * the payload a client renders. Shared by the stream's `run-done` frame and
 * `GET /wrap/status`, so a page following the stream and a page that reloaded
 * and asked for the status render the same report — the two can't drift.
 *
 * @param {string} projectName - Route-level project name
 * @param {object} result - The run's recorded outcome
 * @returns {object} Result payload, with `sessionOutcome` (`ended`|`kept`|null)
 */
function _wrapResultPayload(projectName, result) {
  const payload = {
    ok: result.ok,
    // #185 — the run's stream handle; absent (not null) on the pre-pipeline
    // failures that never claimed a run, so the shape of those is unchanged.
    ...(typeof result.runId === 'string' ? { runId: result.runId } : {}),
    sessionId: result.sessionId,
    project: projectName,
    // NOT the `sessions.status` column — there is no such value there, and this
    // never read it. It reports the pipeline this call just started, which is
    // what `lib/wrap-run-registry.js` knows. A sweep that retires the persisted
    // session status must leave this alone (#1034).
    // #1707 — `cancelled` is its own word: an operator stopped the run and
    // nothing failed, so it must not read as a block to Retry or Skip.
    status: result.ok ? 'wrapping' : (result.outcome === 'cancelled' ? 'cancelled' : 'blocked'),
    ...(result.outcome === 'cancelled' ? { outcome: 'cancelled' } : {}),
    wrapCommand: result.wrapCommand,
    wrapSteps: result.wrapSteps,
    captureFields: result.captureFields,
    // #1558 — what the run did to the session, for the drawer's banner:
    // `ended` when it recorded the wrap and ended the session, `kept` when the
    // operator asked to keep it running, null when the run did not finish or
    // the session had already ended some other way (killed mid-wrap). A plain
    // boolean would call a killed session "still running".
    sessionOutcome: result.lifecycleCompleted === true ? 'ended' : (result.sessionKept === true ? 'kept' : null)
  };
  // #1675 — whether this run's handoff was published, and which one. Absent on
  // the pre-pipeline failures that never reached the finalizer, so their shape
  // is unchanged; a finished run always carries it.
  if (result.handoffPublication) payload.handoffPublication = result.handoffPublication;
  if (result.pipelineResult) payload.pipelineResult = result.pipelineResult;
  if (!result.ok && result.error) payload.error = result.error;
  return payload;
}

/**
 * Frame one wrap-run event as a Server-Sent Events message (#185): the
 * registry `seq` as the `id:` (what a reconnecting `EventSource` echoes back
 * as `Last-Event-ID`), the event `type` as the `event:` name, and the rest as
 * one JSON `data:` line. JSON never contains a raw newline, so a single
 * `data:` line is always a complete frame. A `run-done` event's raw result
 * is shaped through `_wrapResultPayload` — the same shaping the POST and
 * `GET /wrap/status` apply — so a client can render the stream's terminal
 * event exactly as it would render either of them. Every frame also carries
 * `sentAt`, the server time it was written.
 *
 * @param {string} projectName - Route-level project name (for the payload shape)
 * @param {{seq: number, type: string}} event - Registry event
 * @returns {string} The wire frame, terminated by the blank line SSE requires
 */
function _wrapStreamFrame(projectName, event) {
  const { seq, type, ...rest } = event;
  // `sentAt` is when this frame was written, so the page can measure its clock
  // against the server's even from a replay, whose `at` is minutes old.
  const sentAt = Date.now();
  const data = type === WRAP_STREAM_EVENTS.RUN_DONE
    ? { ...rest, sentAt, result: rest.result ? _wrapResultPayload(projectName, rest.result) : null }
    : { ...rest, sentAt };
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Register the wrap routes on the shared route table.
 * @param {object} deps - The gate helpers still resident in `server.js`.
 * @param {(res: object, args: {surface: string, subject: object}) => boolean} deps.controlRefused -
 *   Ask the durable HOLD/STOP gate before a governed mutation; true when refused and answered.
 * @param {(projectName: string) => object|null} deps.controlJobSubject -
 *   The job subject for a project named in a route, or null when it does not exist.
 * @param {(req: object, res: object, projectId: number|null, action: string, extra?: object) => boolean} deps.coordinatorGateRefused -
 *   Apply the coordinator epoch gate to a coordinator-authority mutation; true when refused.
 * @returns {void}
 */
function register(deps) {
  const { controlRefused, controlJobSubject, coordinatorGateRefused } = deps;

  // POST /api/sessions/:project/wrap — Start the wrap pipeline
  // Body: { password?, options? } — `options` carries the per-wrap user choices
  // the wrap modal and the drawer collected (`{skipTests, prHandling, keepSessionRunning, …}`).
  // A finished run ends the session unless `keepSessionRunning` is true (#1558).
  //
  // Answers 202 the moment the run is claimed, with its `runId`; the pipeline runs
  // on and its outcome is read from the stream (`run-done`) or `GET /wrap/status`.
  // It used to hold the request open for the whole pipeline, which left a browser
  // with no handle on the run it had just started: a Retry could not attach to the
  // new run's progress, and the drawer sat on the previous run's red report until
  // the retry's response finally came back. Every refusal below is still
  // synchronous and claims nothing.
  route('POST', '/api/sessions/:project/wrap', async (_req, res, params, body) => {
    // #2032: starting a wrap publishes a handoff and finalizes the session — a
    // coordinator-authority action the rotation epoch binds.
    const wrapProject = store.projects.getByName(params.project);
    if (wrapProject && coordinatorGateRefused(_req, res, wrapProject.id, 'wrap')) return;
    // Operator kill switch (incident 2026-07-16: wrap content steps re-fired
    // repeatedly into the session). Checked before anything else — while set,
    // no wrap can start regardless of caller. Re-enable via
    // PATCH /api/config {"wrapDisabled": false}.
    if (store.config.load().wrapDisabled === true) {
      return errorResponse(res, 503,
        'Session wrap is temporarily disabled by the operator (wrapDisabled). ' +
        'Re-enable via PATCH /api/config {"wrapDisabled": false}.',
        'WRAP_DISABLED');
    }
    const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
    if (!passwordCheck.allowed) {
      return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
    }
    // #1861 — a held or stopped lane does not start a wrap. The run itself asks
    // again at every step boundary, against the assignment it was admitted under.
    const wrapSubject = controlJobSubject(params.project);
    if (wrapSubject && controlRefused(res, { surface: 'wrap-start', subject: wrapSubject })) return;

    const options = body && typeof body.options === 'object' && body.options !== null ? body.options : undefined;
    const started = sessions.startWrap(params.project, options);
    if (!started.ok) {
      // #583 — server-side single-flight: a wrap pipeline is already running
      // for this project. 409 (not 500) so the frontend follows the running run
      // instead of re-triggering it; its `runId` rides along so it can.
      if (started.code === 'WRAP_IN_PROGRESS') {
        // #1805 — `wrapRun.stale` names the one case a stale run still
        // refuses: it had already passed its own cancel boundary (may be
        // committing, branching or pushing) when it went stale, so the
        // registry will not take the slot over — no request can make two
        // concurrent git mutations safe. There is no retry option for this
        // one; the slot frees itself when that pipeline finally finishes, or
        // the server restarts. A stale run that had NOT yet reached its
        // boundary is taken over automatically — `started.wrapRun` never
        // names one of those, because `begin` only refuses the kind it can't
        // safely take.
        return errorResponse(res, 409, started.error, 'WRAP_IN_PROGRESS',
          started.wrapRun && typeof started.wrapRun.runId === 'string'
            ? { runId: started.wrapRun.runId, stale: started.wrapRun.stale === true }
            : undefined);
      }
      // #1540: the stranded-wrap soft block. Nothing was claimed; the client shows
      // the items and may resend with `options.proceedPastStranded`.
      if (started.code === 'STRANDED_WRAPS') {
        return errorResponse(res, 409, started.error, 'STRANDED_WRAPS', { items: started.items });
      }
      if (started.code === 'BAD_REQUEST') {
        return errorResponse(res, 400, started.error, 'BAD_REQUEST');
      }
      // #1708: the project's keep-running setting is unreadable or not a boolean,
      // and the request did not decide. Nothing was claimed; fixing the setting,
      // or sending options.keepSessionRunning, starts the wrap.
      if (started.code === 'WRAP_KEEP_SETTING_INVALID') {
        return errorResponse(res, 409, started.error, 'WRAP_KEEP_SETTING_INVALID');
      }
      return errorResponse(res, 404, started.error, 'NOT_FOUND');
    }

    const project = encodeURIComponent(params.project);
    jsonResponse(res, 202, {
      ok: true,
      runId: started.runId,
      sessionId: started.sessionId,
      project: params.project,
      // Names the pipeline this call just started, sourced from
      // `lib/wrap-run-registry.js` — NOT the `sessions.status` column, which has
      // no such value (#1034).
      status: 'wrapping',
      // #1540: why the stranded-wrap check was skipped, or null when it ran.
      strandedUnchecked: started.strandedUnchecked || null,
      // #1708 — whether this run will end the session, and why: the request, the
      // project's `wrapKeepSessionRunning`, or the default. Stated before any step
      // moves, so a caller that did not choose can see what was chosen for it.
      sessionOutcomePlanned: started.sessionOutcomePlanned,
      keepSource: started.keepSource,
      statusUrl: `/api/sessions/${project}/wrap/status`,
      // #1707 — where to stop this run, while it is still before its commit step.
      cancelUrl: `/api/sessions/${project}/wrap/cancel`,
      streamUrl: `/api/sessions/${project}/wrap/stream/${encodeURIComponent(started.runId)}`
    });
  });

  // POST /api/sessions/:project/wrap/cancel — stop a running wrap at its next
  // step boundary (#1707). Body `{ runId }`: required, so a cancel lands only on
  // the run the caller is watching. Honoured only before the run's commit step;
  // after that the run may already have branched, committed, pushed or opened a
  // PR, and it is refused rather than left half-done. The running step always
  // finishes. Gated exactly as starting a wrap is. Not behind `wrapDisabled`:
  // that switch exists to stop wraps, and must never stop someone stopping one.
  route('POST', '/api/sessions/:project/wrap/cancel', async (_req, res, params, body) => {
    const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
    if (!passwordCheck.allowed) {
      return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
    }
    const runId = body && typeof body.runId === 'string' ? body.runId : '';
    if (!runId) return errorResponse(res, 400, 'runId is required: the run you mean to cancel', 'BAD_REQUEST');
    const answer = sessions.cancelWrap(params.project, runId);
    if (answer.ok) {
      return jsonResponse(res, 202, {
        ok: true,
        project: params.project,
        runId: answer.runId,
        cancelRequested: true,
        // The first step that has not started, or null when the running step is its last.
        willStopBefore: answer.willStopBefore,
        // The step still running: it finishes before the run stops.
        finishingStepId: answer.finishingStepId,
        // What stopping does NOT undo: the steps that ran may have left
        // uncommitted edits or local state. The guarantee is no commit, branch,
        // push, PR or auto-merge.
        note: 'The wrap will make no commit, branch, push, PR or auto-merge. Steps that already ran are not undone: '
          + 'uncommitted edits or local state they wrote may remain.'
      });
    }
    if (answer.code === 'WRAP_NOT_CANCELLABLE') {
      return errorResponse(res, 409, answer.error, 'WRAP_NOT_CANCELLABLE', { currentStepId: answer.currentStepId });
    }
    return errorResponse(res, 404, answer.error, answer.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'WRAP_RUN_NOT_FOUND');
  });

  // GET /api/sessions/:project/wrap/status — Wrap-run state (#583). Lets any
  // client (a reloaded page, another device, a page whose stream dropped)
  // follow a run: `running` + `currentStepId` while the pipeline runs, then the
  // finished run's `result` — the same payload the stream's `run-done` carries.
  // Registry is process-local: after a server restart this honestly reports no
  // run (nothing survived the restart).
  route('GET', '/api/sessions/:project/wrap/status', (_req, res, params) => {
    const status = sessions.getWrapRunStatus(params.project);
    jsonResponse(res, 200, {
      project: params.project,
      // #185 — the running (or last) run's stream handle, so a client that did
      // not start the run (or lost the 202) can open its stream.
      runId: status.runId,
      running: status.running,
      // #1314 — a run claimed and never settled reports `running: false` with
      // this true. The drawer's reattach decision needs the two apart: a wedged
      // run is not "no run", and telling the operator their wrap died is a claim
      // nobody here can make.
      stale: status.stale,
      sessionId: status.sessionId,
      startedAt: status.startedAt,
      currentStepId: status.currentStepId,
      // When the current step began (server epoch ms) — the Wrap button's elapsed time.
      currentStepStartedAt: status.currentStepStartedAt,
      finishedAt: status.finishedAt,
      result: status.result ? _wrapResultPayload(params.project, status.result) : null,
      // #1492 — the choices this run was started with. A Retry replays them, and a
      // reloaded page has no other copy; a Hold it lost would read as Auto.
      options: status.options,
      // #1708 — the resolved session outcome, from the options `startWrap`
      // recorded; null for a run recorded without them.
      ...projectConfig.plannedSessionOutcome(status.options),
      // #1707 — whether POST /wrap/cancel would still be honoured, and whether
      // one already was.
      cancellable: status.cancellable === true,
      cancelRequested: status.cancelRequested === true,
      // #1816 — a restart cuts the pipeline off with nothing in `running` or
      // `result` to show for it; these three say the run was interrupted
      // rather than never started, where it last reported, and whether it had
      // begun committing. Only ever true while `running` is false and no `run`
      // for this `runId` exists in this process — the registry clears it the
      // moment a fresh wrap begins.
      interrupted: status.interrupted === true,
      interruptedStepId: status.interruptedStepId,
      interruptedCommitStarted: status.interruptedCommitStarted === true,
      interruptedAt: status.interruptedAt,
      // The fix handed back to the session for this run's blocked step, so a
      // reloaded page can show "Fixing…" or "Ready: Retry" without re-sending it.
      handback: wrapHandback.get(params.project, status.runId)
    });
  });

  // GET /api/sessions/:project/wrap/stream/:runId — Live wrap progress (#185),
  // as `text/event-stream`. Replays every event the run has already emitted
  // (so a subscriber arriving at step 6 sees steps 1–5 settle), then streams
  // live ones, and closes on the terminal `run-done`. A run that already
  // finished is replayed in full and closed at once. `Last-Event-ID` (what an
  // `EventSource` sends when it reconnects) resumes after that seq, so a blip
  // mid-wrap does not repaint from scratch. An unknown or foreign `runId` is a
  // 404, not an empty stream — the client falls back to polling /wrap/status.
  //
  // Same read-only surface as /wrap/status: it exposes nothing the status
  // route does not (that route hands out the runId), and it starts nothing,
  // so the wrap POST's password gate is not re-applied here. It sits behind
  // every gate the POST does at the perimeter and in `handleRequest`; in
  // particular it is NOT a Caddy auth-bypass path (test/api-wrap-stream.test.js
  // pins that parity).
  route('GET', '/api/sessions/:project/wrap/stream/:runId', (req, res, params) => {
    const lastEventId = Number.parseInt(req.headers['last-event-id'], 10);
    let open = false;
    // Every path through this route logs, because a stream that never runs is
    // quiet on the page: the client falls back to polling /wrap/status, which
    // still delivers the report, and a maintainer is left nothing to bisect from
    // "live progress never appears". These lines are the only way to tell "it
    // worked" from "it never ran" — nothing else covers the route (only
    // unmatched paths hit the generic log, and only at debug).
    const safeWrite = (text) => {
      if (!open) return;
      try {
        res.write(text);
      } catch (err) { // prawduct:allow prawduct/broad-except -- a dead socket must end this stream, never reach the process-global handler without wrap context
        log.warn('Wrap stream write failed — closing', {
          project: params.project, runId: params.runId, error: err.message
        });
        open = false;
        if (sub) sub.unsubscribe();
        res.end();
      }
    };
    // Frame construction is INSIDE the guard, not an argument to it:
    // `_wrapStreamFrame` JSON-stringifies the event, and on the replay loop below
    // a throw escaping this would run after `writeHead(200)` and attempt a second
    // response. The live path is absorbed by the registry's subscriber try/catch;
    // replay has no such net.
    const write = (event) => {
      if (!open) return;
      let frame;
      try {
        frame = _wrapStreamFrame(params.project, event);
      } catch (err) { // prawduct:allow prawduct/broad-except -- an unserializable event must drop its frame, never the response
        log.warn('Wrap stream frame could not be built — skipping it', {
          project: params.project, runId: params.runId, type: event && event.type, error: err.message
        });
        return;
      }
      safeWrite(frame);
    };
    const end = () => {
      if (open) {
        open = false;
        log.info('Wrap stream closed', { project: params.project, runId: params.runId });
        res.end();
      }
    };
    // A socket that fails mid-write does NOT throw out of `res.write` — Node
    // emits `'error'` on the response asynchronously (`process.nextTick`). With
    // no listener that is an unhandled `'error'` event, which reaches the
    // process-global handler carrying no wrap context at all, and the
    // subscription it left behind goes on feeding a dead socket for the rest of
    // the run. The synchronous `try/catch` in `write` below covers a different
    // and rarer case (a throw on an already-destroyed stream); this covers the
    // one that actually happens.
    // Declared before every closure that reads it: the handlers below were
    // registered above this line, so a synchronous `'error'` emit would have
    // TDZ-thrown inside the listener whose whole job is to keep a failure legible.
    // eslint-disable-next-line prefer-const -- assigned once, after subscribe
    let sub = null;
    res.on('error', (err) => {
      if (!open) return;
      open = false;
      log.warn('Wrap stream socket errored — dropping the subscription', {
        project: params.project, runId: params.runId, error: err.message
      });
      if (sub) sub.unsubscribe();
    });
    sub = sessions.subscribeWrapRun(params.project, params.runId, {
      afterSeq: Number.isFinite(lastEventId) ? lastEventId : 0,
      onEvent: write,
      onEnd: end
    });
    if (!sub.ok) {
      // The documented restart case, and the only refusal this route has. At
      // warn because the client silently falls back — without this line the
      // refusal is invisible on both sides.
      log.warn('Wrap stream refused — no such run for this project', {
        project: params.project, runId: params.runId
      });
      return errorResponse(res, 404,
        `No wrap run "${params.runId}" for "${params.project}" — it may predate a server restart, or the id is not this project's.`,
        'WRAP_RUN_NOT_FOUND');
    }
    log.info('Wrap stream subscribed', {
      project: params.project,
      runId: params.runId,
      replayed: sub.replay.length,
      afterSeq: Number.isFinite(lastEventId) ? lastEventId : 0,
      finished: sub.finished
    });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Caddy/nginx honour this to disable response buffering, which would
      // otherwise hold every frame until the run ended — the exact opposite
      // of live progress.
      'X-Accel-Buffering': 'no'
    });
    open = true;
    // A leading comment line makes the browser treat the stream as open the
    // moment headers land, so `EventSource.onopen` fires before the first
    // event rather than after it. Through the same guarded path as every other
    // write, so the one raw `res.write` in the route is not the one with no
    // error handling.
    safeWrite(': wrap stream\n\n');
    for (const event of sub.replay) write(event);
    if (sub.finished) return end();
    // The client went away (tab closed, phone locked): stop feeding a dead
    // socket. The run itself is unaffected — the pipeline never waits on
    // a subscriber.
    req.on('close', () => {
      if (open) log.info('Wrap stream client went away', { project: params.project, runId: params.runId });
      open = false;
      sub.unsubscribe();
    });
  });

  // POST /api/sessions/:project/wrap/handback — Ask the session to fix the step
  // its settled wrap blocked on, and watch for it to finish (#1312).
  // Body: { stepId, prompt } — the drawer composes the prompt; the server appends
  // the completion instruction with a fresh nonce. Answers 202 once the prompt is
  // sent; the outcome is read from the handback stream or `GET /wrap/status`.
  // Gated like `POST /command`, which it replaces for the drawer: it sends a narrower
  // thing (a prompt for one blocked step) through the same injection path.
  // The 64 KB limit covers every route that carries operator or agent PROSE into a
  // session (#1514) — the switchboard sends, the loop bodies, `/command`, this
  // handback and the wrap summary below — not a hand-kept list of the ones that
  // were noticed. A 3800-character handback of multibyte text is ~11 KB, which the
  // 10 KB default refused before the handler's own cap could answer.
  route('POST', '/api/sessions/:project/wrap/handback', (_req, res, params, body) => {
    const handbackProject = store.projects.getByName(params.project);
    if (handbackProject && coordinatorGateRefused(_req, res, handbackProject.id, 'wrap')) return;
    const started = wrapHandback.start(params.project, body);
    if (!started.ok) return errorResponse(res, started.status, started.error, started.code);
    const project = encodeURIComponent(params.project);
    jsonResponse(res, 202, {
      ok: true,
      project: params.project,
      handbackId: started.handbackId,
      handback: started.handback,
      statusUrl: `/api/sessions/${project}/wrap/status`,
      streamUrl: `/api/sessions/${project}/wrap/handback/stream/${encodeURIComponent(started.handbackId)}`
    });
  }, { maxBodySize: MESSAGE_BODY_LIMIT_BYTES });

  // GET /api/sessions/:project/wrap/handback/stream/:handbackId — the handback's
  // watch as `text/event-stream`: `handback-start`, then one terminal
  // `handback-done` carrying `state`, after which the stream closes. A handback
  // that already ended replays both and closes at once. Unknown id → 404, and
  // the client reads `GET /wrap/status` instead. Read-only, like the run stream.
  route('GET', '/api/sessions/:project/wrap/handback/stream/:handbackId', (req, res, params) => {
    let open = false;
    let sub = null;
    const close = () => {
      if (!open) return;
      open = false;
      if (sub) sub.unsubscribe();
      res.end();
    };
    const write = (event) => {
      if (!open) return;
      const { seq, type, ...rest } = event;
      const data = { ...rest, sentAt: Date.now() };
      try {
        res.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (err) { // prawduct:allow prawduct/broad-except -- a dead socket must end this stream, never reach the process-global handler
        log.warn('Handback stream write failed — closing', { project: params.project, handbackId: params.handbackId, error: err.message });
        close();
      }
    };
    res.on('error', (err) => {
      if (!open) return;
      log.warn('Handback stream socket errored — dropping the subscription', {
        project: params.project, handbackId: params.handbackId, error: err.message
      });
      open = false;
      if (sub) sub.unsubscribe();
    });
    sub = wrapHandback.subscribe(params.project, params.handbackId, { onEvent: write, onEnd: close });
    if (!sub.ok) {
      log.warn('Handback stream refused — no such handback for this project', {
        project: params.project, handbackId: params.handbackId
      });
      return errorResponse(res, 404,
        `No handback "${params.handbackId}" for "${params.project}" — it may predate a server restart or have been replaced.`,
        'HANDBACK_NOT_FOUND');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    open = true;
    // A comment line opens the stream in the browser before the first event.
    try {
      res.write(': handback stream\n\n');
    } catch (err) { // prawduct:allow prawduct/broad-except -- a dead socket must end this stream, never reach the process-global handler
      log.warn('Handback stream open failed — closing', { project: params.project, handbackId: params.handbackId, error: err.message });
      return close();
    }
    for (const event of sub.replay) write(event);
    if (sub.finished) return close();
    req.on('close', () => {
      open = false;
      sub.unsubscribe();
    });
  });

  // GET /api/sessions/:project/wrap/pr-status — Live wrap-PR outcome (#638). The
  // wrap's commit step arms auto-merge and reports "armed", but the release only
  // lands when GitHub merges the PR; this read-only probe lets the drawer report
  // merged / pending / blocked / unknown after the pipeline returns, so a blocked
  // release (a red required check, the #636 case) never renders as success. The
  // `url` query param is validated against a github.com PR URL / number shape in
  // `lib/wrap-pr-status.js` before it can reach `gh`.
  route('GET', '/api/sessions/:project/wrap/pr-status', async (req, res, params) => {
    const query = parseQuery(reqUrl(req).search);
    const prRef = query.url || query.pr || '';
    if (!prRef) {
      return errorResponse(res, 400, 'Missing required query param: url (the wrap PR URL or number)', 'BAD_REQUEST');
    }
    const status = await sessions.getWrapPrStatus(params.project, prRef);
    jsonResponse(res, 200, { project: params.project, ...status });
  });

  // POST /api/sessions/:project/wrap/complete — Manual wrap completion
  route('POST', '/api/sessions/:project/wrap/complete', (_req, res, params, body) => {
    const completeProject = store.projects.getByName(params.project);
    if (completeProject && coordinatorGateRefused(_req, res, completeProject.id, 'wrap')) return;
    const result = sessions.completeWrap(params.project, body ? body.summary : undefined, body ? body.sessionId : undefined);
    if (result.error) {
      if (result.error.includes('not found') || result.error.includes('No active')) {
        return errorResponse(res, 404, result.error, 'NOT_FOUND');
      }
      // The session moved on between the client's observation and this request.
      // The caller's view is stale, not the server's state broken — a 500 here
      // reaches the page as a server fault, and its finalizer latches on that.
      //
      // Classified by CODE, not by matching the error prose: there are two ways to
      // be a stale view (the caller named a session that had moved on, or the right
      // one ended mid-finalize), and a second sentence to grep is how the first one
      // got missed.
      if (result.code === 'SESSION_CHANGED') {
        return errorResponse(res, 409, result.error, 'SESSION_CHANGED');
      }
      return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
    }

    jsonResponse(res, 200, {
      ok: true,
      session: result.session
    });
  }, { maxBodySize: MESSAGE_BODY_LIMIT_BYTES });
}

module.exports = { register };
