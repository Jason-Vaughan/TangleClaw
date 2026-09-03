'use strict';

/**
 * #583 — In-memory wrap-run registry: server-side single-flight guard +
 * observable run state for the V2 wrap pipeline.
 *
 * The 2026-07-16 incident proved that client-side single-flight guards
 * (#519 / UI-3B8N) cannot span tabs, devices, or page reloads: a wrap
 * lived and died with one HTTP POST, so a dropped connection read as
 * "Wrap failed", the operator re-POSTed, and a second full pipeline
 * re-fired every AI content step from step 0 — while the first ran on
 * (or had been killed) invisibly. This registry is the server-side
 * truth for "is a wrap running for this project, and what happened to
 * the last one":
 *
 *   - `begin` is the single-flight gate — one running wrap per project.
 *     It mints the run's `runId`, the handle a client presents to
 *     `GET /api/sessions/:project/wrap/stream/:runId` (#185).
 *   - `emit` records pipeline progress as an ordered event log (wired to
 *     the runner's `onStepEvent` hook) so the status endpoint can say
 *     WHERE a running wrap is, and the stream route can replay what a
 *     late subscriber missed before handing it live events.
 *   - `finish` stores the completed run's result so a client whose
 *     POST connection died can still fetch the outcome
 *     (`GET /api/sessions/:project/wrap/status`) instead of blindly
 *     re-wrapping — and appends the terminal `run-done` event, which
 *     is what closes every open stream.
 *
 * Process-local BY DESIGN: a pipeline cannot survive a server restart,
 * so an empty registry after boot is the truth — a post-restart `begin`
 * legitimately starts fresh. No persistence wanted.
 *
 * Stale takeover: pipeline wall-time is bounded well under 30 minutes
 * (3 × 5-min ai-content caps + tests + git steps), so a "running" entry
 * older than STALE_RUN_MS is a wedged/leaked run, not a live one. A new
 * `begin` takes it over with a warning rather than locking wraps out of
 * the project forever. Subscribers of the displaced run are ended, not
 * silently migrated — they were watching a run that no longer exists.
 */

const crypto = require('node:crypto');
const { createLogger } = require('./logger');

const log = createLogger('wrap-run-registry');

// A running entry older than this is treated as wedged and may be taken
// over by a new `begin`. Generous multiple of the worst-case pipeline
// wall-time (~17 min) so a slow-but-alive run is never stolen from.
const STALE_RUN_MS = 30 * 60 * 1000;

/**
 * Per-project run state, keyed by project name.
 * @type {Map<string, {
 *   runId: string,
 *   running: boolean,
 *   sessionId: number|null,
 *   startedAt: number,
 *   currentStepId: string|null,
 *   finishedAt: number|null,
 *   result: object|null,
 *   events: Array<{seq: number, type: string}>,
 *   subscribers: Set<{onEvent: Function, onEnd: Function}>
 * }>}
 */
const _runs = new Map();

/**
 * End every subscriber of a run and forget them. Used when the run
 * finishes (the stream's normal close) and when a stale run is taken over
 * (the stream's abnormal close — its run is gone). A throwing subscriber is
 * dropped and logged: one broken client must not stop the others, or the
 * pipeline, from finishing.
 *
 * @param {object} run - Registry entry
 * @param {string} projectName - For the log line
 * @returns {void}
 */
function _endSubscribers(run, projectName) {
  for (const sub of run.subscribers) {
    try {
      sub.onEnd();
    } catch (err) { // prawduct:allow prawduct/broad-except -- a subscriber is a network client; its failure is logged and must not reach the pipeline
      log.warn('wrap-run subscriber threw on end', { project: projectName, error: err.message });
    }
  }
  run.subscribers.clear();
}

/**
 * Try to claim the single-flight slot for a project's wrap. Exactly one
 * caller may hold it at a time; the loser gets the running run's info so
 * routes can answer 409 with "since when / where it is".
 *
 * A stale running entry (older than STALE_RUN_MS — a wedged or leaked
 * pipeline) is taken over with a warning instead of blocking forever.
 *
 * The `runId` is 128 random bits, hex — unguessable, so presenting it to
 * the stream route is evidence the caller learned it from a route that
 * already answered them, and unique per run, so a stream opened against
 * a previous wrap's id is refused rather than fed the wrong run's events.
 *
 * @param {string} projectName - Registry key (route-level project name)
 * @param {number|null} sessionId - Session record id the wrap targets
 * @returns {{ok: true, runId: string} | {ok: false, running: {runId: string, sessionId: number|null, startedAt: number, currentStepId: string|null}}}
 */
function begin(projectName, sessionId) {
  const existing = _runs.get(projectName);
  if (existing && existing.running) {
    const age = _internal.now() - existing.startedAt;
    if (age < STALE_RUN_MS) {
      return {
        ok: false,
        running: {
          runId: existing.runId,
          sessionId: existing.sessionId,
          startedAt: existing.startedAt,
          currentStepId: existing.currentStepId
        }
      };
    }
    log.warn('Taking over stale wrap run', {
      project: projectName,
      staleSessionId: existing.sessionId,
      ageMs: age
    });
    _endSubscribers(existing, projectName);
  }
  const runId = _internal.newRunId();
  _runs.set(projectName, {
    runId,
    running: true,
    sessionId: sessionId == null ? null : sessionId,
    startedAt: _internal.now(),
    currentStepId: null,
    finishedAt: null,
    result: null,
    events: [],
    subscribers: new Set()
  });
  return { ok: true, runId };
}

/**
 * Append one event to the running run's log and deliver it to every open
 * subscriber. No-op when no run is active for the project (a
 * finished/taken-over run must not be scribbled on by a zombie pipeline's
 * late callbacks) — the same rule `updateStep` follows.
 *
 * The stored event is the caller's payload plus a monotonic `seq`, which
 * is the SSE `id:` a reconnecting client sends back as `Last-Event-ID`.
 *
 * @param {object} run - Registry entry (must be running)
 * @param {string} projectName - For log lines
 * @param {{type: string}} event - Event payload; `type` is required
 * @returns {object} The stored event, `seq` included
 */
function _append(run, projectName, event) {
  const stored = { ...event, seq: run.events.length + 1 };
  run.events.push(stored);
  for (const sub of run.subscribers) {
    try {
      sub.onEvent(stored);
    } catch (err) { // prawduct:allow prawduct/broad-except -- a subscriber is a network client; its failure is logged and dropped so the pipeline's progress reporting cannot alter its outcome
      log.warn('wrap-run subscriber threw — dropping it', { project: projectName, error: err.message });
      run.subscribers.delete(sub);
    }
  }
  return stored;
}

/**
 * Record a pipeline progress event for the running wrap (#185). The
 * runner's `onStepEvent` hook lands here. A `step-start` event also moves
 * `currentStepId`, so `GET /wrap/status` and the stream agree on where the
 * run is. Ignored — with a debug line, not an error — when no run is
 * active, for the same zombie-callback reason `updateStep` ignores it.
 *
 * @param {string} projectName - Registry key
 * @param {{type: string, stepId?: string}} event - Runner event
 *   (`run-start` / `step-start` / `step-done` / `step-blocked`)
 * @returns {object|null} The stored event (with `seq`), or null when dropped
 */
function emit(projectName, event) {
  const run = _runs.get(projectName);
  if (!run || !run.running) {
    log.debug('wrap-run event with no running run — dropped', { project: projectName, type: event && event.type });
    return null;
  }
  if (!event || typeof event.type !== 'string' || event.type === '') {
    log.warn('wrap-run event without a type — dropped', { project: projectName });
    return null;
  }
  if (event.type === 'step-start' && typeof event.stepId === 'string') {
    run.currentStepId = event.stepId;
  }
  return _append(run, projectName, event);
}

/**
 * Record which pipeline step the running wrap has reached. No-op when no
 * run is active for the project (a finished/taken-over run must not be
 * scribbled on by a zombie pipeline's late callbacks).
 *
 * Narrower than `emit`: it moves the status pointer and logs nothing to
 * the event stream. Kept for callers that report position only.
 *
 * @param {string} projectName - Registry key
 * @param {string} stepId - The step now starting (from wrap_pipeline.steps[].id)
 * @returns {void}
 */
function updateStep(projectName, stepId) {
  const run = _runs.get(projectName);
  if (!run || !run.running) return;
  run.currentStepId = stepId;
}

/**
 * Mark the project's wrap run finished and retain its result for
 * later `get` calls (the reattach path). Keeps the LAST result only —
 * replaced when the next run begins. No-op when no run is active
 * (e.g. a taken-over stale run finishing late must not clobber the
 * takeover's state).
 *
 * Appends the terminal `run-done` event carrying the result, delivers it,
 * and ends every subscriber: that is how a stream closes. The result is
 * stored on the event raw — the stream route shapes it into the wrap
 * POST's payload at write time, the same way `GET /wrap/status` does, so
 * the three surfaces cannot drift.
 *
 * @param {string} projectName - Registry key
 * @param {object|null} result - The outer `triggerWrap` result for the run
 * @returns {void}
 */
function finish(projectName, result) {
  const run = _runs.get(projectName);
  if (!run || !run.running) return;
  run.running = false;
  run.finishedAt = _internal.now();
  run.result = result == null ? null : result;
  run.currentStepId = null;
  _append(run, projectName, { type: 'run-done', result: run.result });
  _endSubscribers(run, projectName);
}

/**
 * Read a project's wrap-run state — the payload behind
 * `GET /api/sessions/:project/wrap/status`.
 *
 * @param {string} projectName - Registry key
 * @returns {{runId: string|null, running: boolean, sessionId: number|null, startedAt: number|null, currentStepId: string|null, finishedAt: number|null, result: object|null}}
 */
function get(projectName) {
  const run = _runs.get(projectName);
  if (!run) {
    return { runId: null, running: false, sessionId: null, startedAt: null, currentStepId: null, finishedAt: null, result: null };
  }
  return {
    runId: run.runId,
    running: run.running,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    currentStepId: run.currentStepId,
    finishedAt: run.finishedAt,
    result: run.result
  };
}

/**
 * Attach a listener to one run's event log (#185) — the stream route's
 * whole contract. Synchronous on purpose: the replay snapshot and the
 * listener registration happen in one call, so no event can land between
 * them and be neither replayed nor delivered.
 *
 * Refused (`ok:false`) when the project has no run or the `runId` names a
 * different one — a stream must never be fed another run's events. A
 * finished run is still subscribable: its full log is replayed and
 * `finished` tells the caller to close immediately rather than wait for a
 * `run-done` that has already been delivered.
 *
 * @param {string} projectName - Registry key
 * @param {string} runId - The run the caller means to watch
 * @param {object} listener
 * @param {(event: object) => void} listener.onEvent - Called for each live event
 * @param {() => void} listener.onEnd - Called once when the run finishes or is displaced
 * @param {number} [listener.afterSeq=0] - Replay only events with `seq` above this
 *   (a reconnecting client's `Last-Event-ID`)
 * @returns {{ok: false} | {ok: true, replay: object[], finished: boolean, unsubscribe: () => void}}
 */
function subscribe(projectName, runId, listener) {
  const run = _runs.get(projectName);
  if (!run || typeof runId !== 'string' || run.runId !== runId) return { ok: false };
  const afterSeq = Number.isFinite(listener.afterSeq) && listener.afterSeq > 0 ? listener.afterSeq : 0;
  const replay = run.events.filter((ev) => ev.seq > afterSeq);
  if (!run.running) {
    return { ok: true, replay, finished: true, unsubscribe: () => {} };
  }
  const sub = { onEvent: listener.onEvent, onEnd: listener.onEnd };
  run.subscribers.add(sub);
  return {
    ok: true,
    replay,
    finished: false,
    unsubscribe: () => { run.subscribers.delete(sub); }
  };
}

/**
 * Name of the first project with a wrap currently running, or null.
 * Used by `POST /api/server/restart` to refuse restarting out from
 * under a live pipeline (the incident's first domino).
 *
 * @returns {string|null}
 */
function anyRunning() {
  for (const [projectName, run] of _runs) {
    if (run.running) return projectName;
  }
  return null;
}

/**
 * Test-only: drop all registry state so suites are isolated.
 * @returns {void}
 */
function _resetForTests() {
  for (const [projectName, run] of _runs) _endSubscribers(run, projectName);
  _runs.clear();
}

const _internal = {
  now: () => Date.now(),
  /**
   * Mint a run id. A seam so tests can pin a known id; production ids are
   * 128 random bits.
   * @returns {string} 32 hex characters
   */
  newRunId: () => crypto.randomBytes(16).toString('hex')
};

module.exports = { begin, emit, updateStep, finish, get, subscribe, anyRunning, STALE_RUN_MS, _resetForTests, _internal };
