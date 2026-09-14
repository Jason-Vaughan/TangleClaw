/* ── TangleClaw — wrap-run controller (pure state) ── */

/**
 * The one state machine for "which wrap run is this page following, and what
 * does it know about it".
 *
 * Before this, that answer was spread across half a dozen loosely-coupled
 * globals in `session.js` and three overlapping flows (a stream discovered by
 * probing beside a blocking POST, a stream opened by that POST's reattach path,
 * and a status poll), and the flows disagreed about Retry: a Retry opened no
 * stream at all, so the drawer kept showing the previous run's red report until
 * the retry's response came back minutes later.
 *
 * `reduceWrapRun(state, signal)` is pure and DOM-free — every transition is
 * tested in Node (`test/wrap-run-controller.test.js`). `session.js` holds the
 * state, dispatches signals, and runs the effects each transition implies
 * (open or close the stream, start or stop the status poll, paint the drawer).
 *
 * Phases:
 *   - `idle`      — no run followed; the drawer is closed.
 *   - `starting`  — a wrap POST is in flight. A second start is ignored.
 *   - `following` — a run is being followed. `transport` is `'stream'` until the
 *                   stream ends without a terminal frame, then `'poll'`.
 *   - `settled`   — the run finished and its result is held.
 *   - `stalled`   — the run was claimed and stopped reporting; its outcome is
 *                   unknown, not failed.
 *   - `lost`      — the run was being followed and the server no longer holds
 *                   it (a restart): nothing it did can be read back.
 *   - `refused`   — the POST was refused before any run was claimed.
 *
 * Loaded by the browser as a plain script after `wrap-drawer.js` (it folds
 * stream events through that file's `applyWrapStreamEvent`), and by tests.
 */
(function (global) {
  'use strict';

  /**
   * The drawer-helper namespace the fold comes from. In the browser it is the
   * global `wrap-drawer.js` set; under Node it is required directly.
   * @returns {object}
   */
  function drawerHelpers() {
    if (global && global.tcWrapDrawerHelpers) return global.tcWrapDrawerHelpers;
    return require('./wrap-drawer.js');
  }

  /**
   * The state of a page following no run.
   * @returns {{phase: 'idle', runId: null, retry: false, transport: null, live: null, result: null, error: null, visible: false}}
   */
  function initialWrapRun() {
    return { phase: 'idle', runId: null, retry: false, transport: null, live: null, result: null, error: null, visible: false };
  }

  /**
   * Phases in which a run is being watched, so a new wrap must not start.
   * @param {object} state
   * @returns {boolean}
   */
  function isBusy(state) {
    return state.phase === 'starting' || state.phase === 'following';
  }

  /**
   * The live view a Retry starts from: the previous run's steps, every one
   * `pending`, so the operator watches the pipeline walk them again rather than
   * staring at the old verdict. Nothing is marked `running` — the server has not
   * said so yet — and `started` stays false until the new run's first frame.
   * @param {object|null} result - The previous run's result payload
   * @returns {object|null} A live view, or null when there were no steps to seed
   */
  function retrySeed(result) {
    const steps = result && result.pipelineResult && Array.isArray(result.pipelineResult.results)
      ? result.pipelineResult.results
      : [];
    if (steps.length === 0) return null;
    return {
      results: steps
        .filter((r) => r && typeof r.stepId === 'string')
        .map((r) => ({ stepId: r.stepId, kind: typeof r.kind === 'string' ? r.kind : '', status: 'pending', output: null, blockers: [] })),
      blockedAt: null,
      currentStepId: null,
      started: false,
      done: false,
      result: null
    };
  }

  /**
   * What a `GET /wrap/status` payload says about ONE run.
   *
   * Keyed on `runId`, not on clocks: the status route reports whichever run the
   * project holds last, so a payload naming a different run says nothing about
   * the one being followed except that the server no longer holds it.
   *
   * @param {object|null} status - `GET /wrap/status` body
   * @param {string} runId - The run being followed
   * @returns {'running'|'settled'|'stalled'|'lost'|'unknown'} `unknown` when the
   *   payload is missing (a failed poll is a blip, not an answer)
   */
  function statusForRun(status, runId) {
    if (!status || typeof status !== 'object') return 'unknown';
    if (status.runId !== runId) return 'lost';
    if (status.running === true) return 'running';
    // A run that went stale and then settled for real has an outcome, and the
    // outcome is the better answer — so a result is checked before `stale`.
    if (status.result && typeof status.result === 'object') return 'settled';
    if (status.stale === true) return 'stalled';
    return 'lost';
  }

  /**
   * Follow a run from a non-following phase.
   * @param {object} state - Prior state
   * @param {string} runId - The run to follow
   * @param {{retry: boolean, live: object|null}} how
   * @returns {object}
   */
  function follow(state, runId, how) {
    return {
      ...state,
      phase: 'following',
      runId,
      retry: how.retry,
      transport: 'stream',
      live: how.live,
      error: null,
      visible: true
    };
  }

  /**
   * Fold one signal into the controller state. Pure: never mutates `state`, and
   * returns the SAME object when the signal changes nothing, so the caller can
   * skip its effects with an identity check.
   *
   * Signals:
   *   - `start` `{retry}` — a wrap POST is about to go out. Ignored while busy.
   *   - `accepted` `{runId}` — the POST answered 202 for this run.
   *   - `refused` `{error}` — the POST was refused (or never answered) with no
   *     run to follow.
   *   - `follow` `{runId}` — follow a run this page did not start: a 409 naming
   *     the running run, or a page load finding one.
   *   - `event` `{runId, event}` — one decoded stream frame (`type` + data).
   *   - `stream-lost` `{runId}` — the stream ended without a terminal frame.
   *   - `status` `{runId, status}` — a `GET /wrap/status` payload, polled while
   *     the stream is gone.
   *   - `hide` — the operator closed the drawer (Close, Cancel, Done, backdrop).
   *
   * Signals naming a `runId` other than the followed one are ignored: a late
   * frame from a previous run must not repaint the current one.
   *
   * @param {object} state - Prior state (from `initialWrapRun` or a prior call)
   * @param {{type: string}} signal
   * @returns {object} Next state
   */
  function reduceWrapRun(state, signal) {
    const s = state && typeof state === 'object' && typeof state.phase === 'string' ? state : initialWrapRun();
    if (!signal || typeof signal.type !== 'string') return s;
    const followingThis = s.phase === 'following' && signal.runId === s.runId;

    switch (signal.type) {
      case 'start':
        if (isBusy(s)) return s;
        // The previous result is kept: a Retry seeds its live view from it, and a
        // refused retry still has a report on screen to show its error against.
        return { ...s, phase: 'starting', retry: signal.retry === true, transport: null, live: null, error: null };

      case 'accepted':
        if (s.phase !== 'starting' || typeof signal.runId !== 'string') return s;
        return follow(s, signal.runId, { retry: s.retry, live: s.retry ? retrySeed(s.result) : null });

      case 'refused':
        if (s.phase !== 'starting') return s;
        return {
          ...s,
          phase: 'refused',
          transport: null,
          live: null,
          error: typeof signal.error === 'string' && signal.error ? signal.error : 'Wrap failed.',
          // A refused first wrap has nothing to show in the drawer (its error
          // belongs in the wrap modal); a refused retry shows it on the report —
          // unless the operator closed the drawer while the POST was out, whose
          // report was cleared with it and must not be re-opened empty.
          visible: s.visible && s.retry && s.result !== null
        };

      case 'follow':
        if (typeof signal.runId !== 'string') return s;
        if (s.phase === 'following' && s.runId === signal.runId) return s;
        return follow({ ...s, result: null }, signal.runId, { retry: false, live: null });

      case 'event': {
        if (!followingThis || !signal.event || typeof signal.event.type !== 'string') return s;
        const live = drawerHelpers().applyWrapStreamEvent(s.live, signal.event);
        if (!live.done) return { ...s, live };
        if (signal.event.stale === true) {
          return { ...s, phase: 'stalled', transport: null, live, result: null, visible: true };
        }
        if (!live.result) {
          return { ...s, phase: 'lost', transport: null, live, result: null, visible: true };
        }
        return { ...s, phase: 'settled', transport: null, live, result: live.result, retry: false, visible: true };
      }

      case 'stream-lost':
        if (!followingThis || s.transport !== 'stream') return s;
        return { ...s, transport: 'poll' };

      case 'status': {
        if (!followingThis) return s;
        const verdict = statusForRun(signal.status, s.runId);
        if (verdict === 'running' || verdict === 'unknown') return s;
        if (verdict === 'settled') {
          return { ...s, phase: 'settled', transport: null, result: signal.status.result, retry: false, visible: true };
        }
        return { ...s, phase: verdict, transport: null, result: null, visible: true };
      }

      case 'hide':
        if (!s.visible) return s;
        // Hiding a live run keeps following it — its report re-opens the drawer
        // when it lands. So does hiding a Retry whose POST is still out: dropping
        // to idle there would ignore the `accepted` that follows, and the run the
        // server just started would go unwatched. Hiding a finished run lets it go.
        return isBusy(s) ? { ...s, visible: false } : initialWrapRun();

      default:
        return s;
    }
  }

  const controller = { initialWrapRun, reduceWrapRun, statusForRun, retrySeed, isBusy };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = controller;
  }
  if (global) {
    global.tcWrapRunController = controller;
  }
})(typeof window !== 'undefined' ? window : null);
