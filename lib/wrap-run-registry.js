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
 *   - `updateStep` records pipeline progress (wired to the runner's
 *     `onStepStart` hook) so the status endpoint can say WHERE a
 *     running wrap is.
 *   - `finish` stores the completed run's result so a client whose
 *     POST connection died can still fetch the outcome
 *     (`GET /api/sessions/:project/wrap/status`) instead of blindly
 *     re-wrapping.
 *
 * Process-local BY DESIGN: a pipeline cannot survive a server restart,
 * so an empty registry after boot is the truth — a post-restart `begin`
 * legitimately starts fresh. No persistence wanted.
 *
 * Stale takeover: pipeline wall-time is bounded well under 30 minutes
 * (3 × 5-min ai-content caps + tests + git steps), so a "running" entry
 * older than STALE_RUN_MS is a wedged/leaked run, not a live one. A new
 * `begin` takes it over with a warning rather than locking wraps out of
 * the project forever.
 */

const { createLogger } = require('./logger');

const log = createLogger('wrap-run-registry');

// A running entry older than this is treated as wedged and may be taken
// over by a new `begin`. Generous multiple of the worst-case pipeline
// wall-time (~17 min) so a slow-but-alive run is never stolen from.
const STALE_RUN_MS = 30 * 60 * 1000;

/**
 * Per-project run state, keyed by project name.
 * @type {Map<string, {
 *   running: boolean,
 *   sessionId: number|null,
 *   startedAt: number,
 *   currentStepId: string|null,
 *   finishedAt: number|null,
 *   result: object|null
 * }>}
 */
const _runs = new Map();

/**
 * Try to claim the single-flight slot for a project's wrap. Exactly one
 * caller may hold it at a time; the loser gets the running run's info so
 * routes can answer 409 with "since when / where it is".
 *
 * A stale running entry (older than STALE_RUN_MS — a wedged or leaked
 * pipeline) is taken over with a warning instead of blocking forever.
 *
 * @param {string} projectName - Registry key (route-level project name)
 * @param {number|null} sessionId - Session record id the wrap targets
 * @returns {{ok: true} | {ok: false, running: {sessionId: number|null, startedAt: number, currentStepId: string|null}}}
 */
function begin(projectName, sessionId) {
  const existing = _runs.get(projectName);
  if (existing && existing.running) {
    const age = _internal.now() - existing.startedAt;
    if (age < STALE_RUN_MS) {
      return {
        ok: false,
        running: {
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
  }
  _runs.set(projectName, {
    running: true,
    sessionId: sessionId == null ? null : sessionId,
    startedAt: _internal.now(),
    currentStepId: null,
    finishedAt: null,
    result: null
  });
  return { ok: true };
}

/**
 * Record which pipeline step the running wrap has reached. No-op when no
 * run is active for the project (a finished/taken-over run must not be
 * scribbled on by a zombie pipeline's late callbacks).
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
}

/**
 * Read a project's wrap-run state — the payload behind
 * `GET /api/sessions/:project/wrap/status`.
 *
 * @param {string} projectName - Registry key
 * @returns {{running: boolean, sessionId: number|null, startedAt: number|null, currentStepId: string|null, finishedAt: number|null, result: object|null}}
 */
function get(projectName) {
  const run = _runs.get(projectName);
  if (!run) {
    return { running: false, sessionId: null, startedAt: null, currentStepId: null, finishedAt: null, result: null };
  }
  return {
    running: run.running,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    currentStepId: run.currentStepId,
    finishedAt: run.finishedAt,
    result: run.result
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
  _runs.clear();
}

const _internal = {
  now: () => Date.now()
};

module.exports = { begin, updateStep, finish, get, anyRunning, STALE_RUN_MS, _resetForTests, _internal };
