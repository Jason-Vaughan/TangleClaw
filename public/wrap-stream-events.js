/* ── TangleClaw — wrap-run stream event vocabulary ── */

/**
 * The names of the events a wrap run emits, declared once for both ends of the
 * stream.
 *
 * The server writes each as an SSE `event:` name, and a browser `EventSource`
 * delivers a named event ONLY to a listener registered for that exact name. So a
 * type the producer emits and the client never subscribed to is not an error
 * anywhere: no handler runs, no malformed-frame warning fires, and the drawer
 * simply never shows that step. Spelling the list out separately in the runner,
 * the registry, the subscription loop and the folding switch made that failure
 * one forgotten edit away, with every suite still green.
 *
 * Loaded by the browser as a plain script (sets `window.tcWrapStreamEvents`) and
 * required by the server (`lib/wrap-pipeline.js`, `lib/wrap-run-registry.js`).
 * `test/wrap-stream-event-vocabulary.test.js` fails when a declared type has no
 * client handler or a producer spells a type as a literal.
 */
(function (global) {
  'use strict';

  /**
   * Event names keyed by role.
   * @type {Readonly<{RUN_START: string, STEP_START: string, STEP_DONE: string, STEP_BLOCKED: string, CANCEL_REQUESTED: string, RUN_DONE: string}>}
   */
  const WRAP_STREAM_EVENTS = Object.freeze({
    // The run's shape: every step id and kind, before the first step moves.
    RUN_START: 'run-start',
    // One step began.
    STEP_START: 'step-start',
    // One step settled with `ok: true` (or was disabled by project config).
    STEP_DONE: 'step-done',
    // One step settled with `ok: false`; `halted` says whether the run stopped there.
    STEP_BLOCKED: 'step-blocked',
    // #1707 — an operator's cancel was accepted: `willStopBefore` (the first step
    // not started) and `finishingStepId` (the step still running). Appended by the
    // registry once per run, so every watcher (another tab, a reload's replay, the
    // PM) sees the run is stopping, not only the page that asked.
    CANCEL_REQUESTED: 'cancel-requested',
    // Terminal: carries the run's result. Appended by the registry, never the runner.
    RUN_DONE: 'run-done'
  });

  /**
   * Every event name, in the order a run emits them.
   * @type {ReadonlyArray<string>}
   */
  const WRAP_STREAM_EVENT_TYPES = Object.freeze(Object.values(WRAP_STREAM_EVENTS));

  /**
   * Event names on a handback's own stream: the watch TangleClaw runs after the
   * drawer asks the session to fix a blocked step. A separate stream, because a
   * settled run's stream has already delivered its terminal frame and closed.
   * @type {Readonly<{HANDBACK_START: string, HANDBACK_UPDATE: string, HANDBACK_DONE: string}>}
   */
  const HANDBACK_STREAM_EVENTS = Object.freeze({
    // The prompt was sent and the watch began.
    HANDBACK_START: 'handback-start',
    // The watch's state changed without ending: the terminal went quiet, or
    // started moving again after going quiet.
    HANDBACK_UPDATE: 'handback-update',
    // Terminal: the watch ended; `state` says how.
    HANDBACK_DONE: 'handback-done'
  });

  /**
   * Every handback event name, in emission order.
   * @type {ReadonlyArray<string>}
   */
  const HANDBACK_STREAM_EVENT_TYPES = Object.freeze(Object.values(HANDBACK_STREAM_EVENTS));

  const vocabulary = { WRAP_STREAM_EVENTS, WRAP_STREAM_EVENT_TYPES, HANDBACK_STREAM_EVENTS, HANDBACK_STREAM_EVENT_TYPES };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = vocabulary;
  }
  if (global) {
    global.tcWrapStreamEvents = vocabulary;
  }
})(typeof window !== 'undefined' ? window : null);
