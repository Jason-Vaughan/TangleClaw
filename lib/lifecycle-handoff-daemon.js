'use strict';

/**
 * Closed-loop session lifecycle handoff -- the background daemon (#2838,
 * v5.64.0 Wave 1 Car 64-D, Architect Ruling A501-W1D-R1). Slice 2 of #2073.
 *
 * `lib/lifecycle-handoff.js` (Slice 1) is a state machine driven entirely by
 * explicit calls; its own module doc names "an end-to-end background daemon
 * that polls ... and drives this state machine unattended" as exactly what
 * it is NOT. This module is that daemon.
 *
 * ## What the tick loop drives, and why it stops where it does
 *
 * Three of the state machine's steps need no caller identity at all --
 * each one is gated purely on evidence this process can read for itself:
 *
 *   - {@link recordWrapInitiated} (`checkpointed` -> `wrap_initiated`):
 *     gated on a real wrap/finalize run already being evidenced.
 *   - {@link recordTerminalConfirmed} (`wrap_initiated` -> `terminal_confirmed`):
 *     gated on the source session's real, stored `wrapped` status.
 *   - {@link launchReplacement} (`terminal_confirmed` -> `replacement_launched`):
 *     already idempotent and fenced to one attempt by its own attempt-token
 *     bookkeeping (Slice 1's own "single replacement launch fence").
 *
 * The tick loop ({@link createLifecycleHandoffDaemon}) drives exactly these
 * three, nothing else. It deliberately never calls `reconcileStartup` or
 * `recordTakeover`: both require proof the caller genuinely IS the
 * handoff's own replacement session (`lib/lifecycle-handoff.js#_isReplacementCaller`)
 * -- proof a background process acting on nobody's behalf cannot
 * manufacture without becoming exactly the forgery Slice 1's own I-Gate
 * rounds closed ("never a value the delegate could read back ... and
 * resubmit as if it were proof"). Constructing `{kind: 'project',
 * sessionId: row.replacementSessionId, launchId: row.replacementLaunchId}`
 * from the handoff's OWN recorded fields would rubber-stamp "the launch
 * sequence attested ready" as "the replacement actually read and
 * reconciled its checkpoint" -- the exact gap Slice 1's Round 2 Finding 1
 * closed by requiring the replacement's own reconciliation receipt.
 *
 * ## The route/CLI adapters
 *
 * {@link handleReconcileStartupRequest} and {@link handleTakeoverRequest}
 * are thin, self-contained adapters shaped exactly as a future HTTP route
 * or CLI command would call them: they parse an untrusted request body into
 * the exact shape `reconcileStartup`/`recordTakeover` require and forward
 * the ALREADY-AUTHENTICATED caller verbatim -- proving that identity is the
 * route/CLI layer's job, never this adapter's. Mounting them onto a real
 * route (`server.js`, `lib/routes/sessions.js`) or `bin/tc.js` is Slice 3,
 * tracked in #2885 and explicitly out of this envelope (Ruling A501-W1D-R1).
 *
 * @module lib/lifecycle-handoff-daemon
 */

const { createLogger } = require('./logger');
const lifecycleHandoff = require('./lifecycle-handoff');

const log = createLogger('lifecycle-handoff-daemon');

/** Default tick interval: frequent enough that a settled source session is noticed quickly, cheap enough to run forever. */
const DEFAULT_TICK_MS = 15 * 1000;

/** Seam for tests: the clock. */
const _internal = {
  now: () => Date.now()
};

/**
 * Advance one `checkpointed` handoff if real wrap/finalize evidence already
 * exists; a no-op (not a blocker) when it does not yet.
 * @param {object} handoff - `listOpen`'s view of one row
 * @returns {void}
 */
function _tickCheckpointed(handoff) {
  const r = lifecycleHandoff.recordWrapInitiated(handoff.handoffId);
  if (r.ok) {
    log.info('Lifecycle handoff daemon advanced a handoff to wrap_initiated', { handoffId: handoff.handoffId, project: handoff.projectName });
    return;
  }
  if (r.code === 'LIFECYCLE_HANDOFF_NOT_INITIATED') return; // expected: nothing to evidence yet, try again next tick
  _recordIfGenerationMoved(handoff, r);
}

/**
 * Advance one `wrap_initiated` handoff once the source session's real
 * status reaches `wrapped`; a no-op (not a blocker) until then -- this IS
 * the daemon's settled-end detection: the module's own real status read,
 * polled on a timer instead of waited on by a human.
 * @param {object} handoff - `listOpen`'s view of one row
 * @returns {void}
 */
function _tickWrapInitiated(handoff) {
  const r = lifecycleHandoff.recordTerminalConfirmed(handoff.handoffId);
  if (r.ok) {
    log.info('Lifecycle handoff daemon confirmed settled, conclusive inactivity', { handoffId: handoff.handoffId, project: handoff.projectName });
    return;
  }
  if (r.code === 'LIFECYCLE_HANDOFF_NOT_TERMINAL') return; // expected: not settled yet, try again next tick
  _recordIfGenerationMoved(handoff, r);
}

/**
 * Advance one `terminal_confirmed` handoff by launching its one replacement
 * -- `launchReplacement` is already fenced to a single attempt by its own
 * attempt-token bookkeeping, so the daemon's "fence" here is simply calling
 * it on a timer rather than waiting for a human to.
 * @param {object} handoff - `listOpen`'s view of one row
 * @param {object} [launchOptions] - Forwarded to `launchReplacement` verbatim
 * @returns {void}
 */
function _tickTerminalConfirmed(handoff, launchOptions) {
  const r = lifecycleHandoff.launchReplacement(handoff.handoffId, launchOptions);
  if (r.ok) {
    log.info('Lifecycle handoff daemon launched the replacement session', {
      handoffId: handoff.handoffId, project: handoff.projectName, replacementSessionId: r.launched.session.id
    });
    return;
  }
  // launchReplacement's own doc: a launch-level refusal "leaves the handoff
  // at terminal_confirmed -- retryable, not a failure" for every code except
  // a moved generation, which is this handoff's own one real blocker.
  _recordIfGenerationMoved(handoff, r);
}

/**
 * Record the one blocker the daemon ever auto-records: the control
 * generation this handoff was bound to moving since checkpointing. Every
 * other refusal the three driven steps can return is documented as
 * retryable by that step itself, so the daemon logs it and tries again next
 * tick rather than guessing at a terminal failure.
 * @param {object} handoff - `listOpen`'s view of one row
 * @param {{ok: false, code: string, message: string}} refusal
 * @returns {void}
 */
function _recordIfGenerationMoved(handoff, refusal) {
  if (refusal.code !== 'LIFECYCLE_HANDOFF_GENERATION_MOVED') {
    log.warn('Lifecycle handoff daemon tick made no progress; will retry', {
      handoffId: handoff.handoffId, project: handoff.projectName, state: handoff.state, code: refusal.code
    });
    return;
  }
  const blocked = lifecycleHandoff.recordBlocker(handoff.handoffId, {
    code: lifecycleHandoff.BLOCKER_CODES.GENERATION_MOVED,
    detail: refusal.message
  });
  log.warn('Lifecycle handoff daemon failed a handoff: its control generation moved', {
    handoffId: handoff.handoffId, project: handoff.projectName, recorded: blocked.ok
  });
}

/**
 * HTTP/CLI route adapter for {@link lifecycleHandoff.reconcileStartup}
 * (#2838 Slice 2; mounting is Slice 3, #2885). Parses an untrusted request
 * body into exactly the `{checkpointDigest, generation}` shape
 * `reconcileStartup` requires; `caller` must already be the
 * route/CLI layer's own verified identity, never derived here.
 * @param {string} handoffId
 * @param {{kind: string, sessionId?: number, launchId?: string}} caller - Already-verified caller identity
 * @param {object} body - Untrusted request body
 * @returns {{ok: true, handoff: object}|{ok: false, code: string, message: string}}
 */
function handleReconcileStartupRequest(handoffId, caller, body) {
  const b = body || {};
  const reconciliation = {
    checkpointDigest: typeof b.checkpointDigest === 'string' ? b.checkpointDigest : null,
    generation: typeof b.generation === 'number' || b.generation === null ? b.generation : undefined
  };
  return lifecycleHandoff.reconcileStartup(handoffId, caller, reconciliation);
}

/**
 * HTTP/CLI route adapter for {@link lifecycleHandoff.recordTakeover} (#2838
 * Slice 2; mounting is Slice 3, #2885). `caller` must already be the
 * route/CLI layer's own verified identity, never derived here.
 * @param {string} handoffId
 * @param {{kind: string, sessionId?: number, launchId?: string}} caller - Already-verified caller identity
 * @returns {{ok: true, handoff: object}|{ok: false, code: string, message: string}}
 */
function handleTakeoverRequest(handoffId, caller) {
  return lifecycleHandoff.recordTakeover(handoffId, caller);
}

/**
 * Build one lifecycle handoff daemon: a tick loop that sweeps every open
 * handoff on the host and advances each through the three steps that need
 * no caller identity (see module doc). A factory, not a singleton, so tests
 * (and, if ever needed, more than one independently-configured daemon) get
 * their own timer rather than sharing one module-level interval.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] - Tick interval; {@link DEFAULT_TICK_MS} otherwise.
 * @param {object} [opts.launchOptions] - Forwarded to `launchReplacement` verbatim on every launch tick.
 * @returns {{tick: () => void, start: () => void, stop: () => void}}
 */
function createLifecycleHandoffDaemon(opts = {}) {
  const intervalMs = Number.isInteger(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_TICK_MS;
  const launchOptions = opts.launchOptions || {};
  let timer = null;

  /**
   * One pass over every open handoff. Never throws: one handoff's own
   * unexpected error is logged and the sweep continues, the same contract
   * `lib/medusa-watchdog.js#tick` gives its own timer.
   * @returns {void}
   */
  function tick() {
    const started = _internal.now();
    let open;
    try {
      open = lifecycleHandoff.listOpen();
    } catch (err) { // prawduct:allow prawduct/broad-except -- a failed sweep must not kill the timer; the next tick tries again
      log.warn('Lifecycle handoff daemon could not list open handoffs', { error: err.message });
      return;
    }
    for (const handoff of open) {
      try {
        if (handoff.state === lifecycleHandoff.STATES.CHECKPOINTED) _tickCheckpointed(handoff);
        else if (handoff.state === lifecycleHandoff.STATES.WRAP_INITIATED) _tickWrapInitiated(handoff);
        else if (handoff.state === lifecycleHandoff.STATES.TERMINAL_CONFIRMED) _tickTerminalConfirmed(handoff, launchOptions);
        // REPLACEMENT_LAUNCHED and STARTUP_READY: waiting on the real
        // replacement's own reconciliation/takeover call (see module doc);
        // nothing for the daemon to do.
      } catch (err) { // prawduct:allow prawduct/broad-except -- one handoff's failure must not stop the sweep over the rest
        log.warn('Lifecycle handoff daemon could not tick a handoff', { handoffId: handoff.handoffId, error: err.message });
      }
    }
    log.info('Lifecycle handoff daemon tick complete', { open: open.length, durationMs: _internal.now() - started });
  }

  /**
   * Start the timer. Idempotent.
   * @returns {void}
   */
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        tick();
      } catch (err) { // prawduct:allow prawduct/broad-except -- the timer must not die; the next tick tries again
        log.warn('Lifecycle handoff daemon tick threw', { error: err.message });
      }
    }, intervalMs);
    if (timer.unref) timer.unref();
    log.info('Lifecycle handoff daemon started', { intervalMs });
  }

  /**
   * Stop the timer. Idempotent.
   * @returns {void}
   */
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}

module.exports = {
  createLifecycleHandoffDaemon,
  handleReconcileStartupRequest,
  handleTakeoverRequest,
  DEFAULT_TICK_MS,
  _internal
};
