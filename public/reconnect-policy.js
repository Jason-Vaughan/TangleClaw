'use strict';
/* ── TangleClaw — Shared reconnect + escalation policy ── */
/* Single source of truth for how every page behaves while the server is not */
/* answering: how often it retries, and when it stops calling the outage a   */
/* blip. Loaded as a plain script before any page script.                    */

(function (global) {
  /** How long an outage must provably last before it stops being a blip. */
  const DEFAULT_CEILING_MS = 20000;
  /** Nominal gap between reconnect probes. */
  const DEFAULT_BASE_DELAY_MS = 5000;
  /** Fraction of the base delay each probe is randomly spread across. */
  const DEFAULT_JITTER_RATIO = 0.2;

  /**
   * Create the reconnect policy for a page.
   *
   * This exists as ONE module because the dashboard and the session page each
   * carried their own copy of the retry loop, and the escalation that turns a
   * dead server into an honest message was therefore built on the dashboard
   * alone — a session tab looped "Connection lost. Retrying…" against a server
   * that was never coming back. Two copies of a rule produce two behaviors;
   * the page supplies what differs (how to probe, what to render) and nothing
   * else.
   *
   * **The ceiling is elapsed time, not a count of attempts.** Attempts are not
   * a stable measure of how long a server has been gone: browsers clamp timers
   * in a backgrounded tab to roughly one per minute, so a fixed attempt count
   * escalated at about twenty seconds in the foreground tab and about four
   * minutes in a background one. The operator routinely keeps several
   * dashboards and several session tabs open, and watching them disagree about
   * whether the server is down undermines the honesty the escalation exists to
   * provide. Elapsed time makes every tab reach the same verdict without any
   * tab having to talk to another. A throttled tab still escalates only when it
   * next wakes, so its worst case is one throttled interval past the ceiling
   * rather than four times the ceiling.
   *
   * **Probes are jittered** so that N open tabs do not converge into a
   * synchronized burst against a server that is in the middle of booting.
   *
   * Deliberately NOT cross-tab coordinated. Per-tab state is honest — each page
   * really cannot reach the server — and the elapsed-time ceiling removes the
   * visible inconsistency at a fraction of the complexity a shared channel
   * would add.
   *
   * @param {object} opts
   * @param {() => Promise<void>} opts.probe - One reconnect attempt. Expected to
   *   flip the page's connection state through its own `setConnected`, which is
   *   what calls `end()` on success.
   * @param {() => void} [opts.onEscalate] - Called once per outage, the first
   *   time a probe fails at or past the ceiling.
   * @param {() => void} [opts.onRecover] - Called by `end()` when the server
   *   answers again, so the page can dismiss whatever `onEscalate` rendered.
   * @param {number} [opts.ceilingMs] - Escalation ceiling in ms.
   * @param {number} [opts.baseDelayMs] - Nominal probe interval in ms.
   * @param {number} [opts.jitterRatio] - Spread applied to each interval.
   * @param {() => number} [opts.now] - Clock, injectable for tests.
   * @param {(fn: Function, ms: number) => any} [opts.schedule] - Timer factory.
   * @param {(handle: any) => void} [opts.cancel] - Timer canceller.
   * @param {() => number} [opts.random] - Randomness source for jitter.
   * @returns {object} The policy handle.
   */
  function tcCreateReconnectPolicy(opts) {
    const o = opts || {};
    const probe = typeof o.probe === 'function' ? o.probe : async () => {};
    const onEscalate = typeof o.onEscalate === 'function' ? o.onEscalate : () => {};
    const onRecover = typeof o.onRecover === 'function' ? o.onRecover : () => {};
    const ceilingMs = typeof o.ceilingMs === 'number' ? o.ceilingMs : DEFAULT_CEILING_MS;
    const baseDelayMs = typeof o.baseDelayMs === 'number' ? o.baseDelayMs : DEFAULT_BASE_DELAY_MS;
    const jitterRatio = typeof o.jitterRatio === 'number' ? o.jitterRatio : DEFAULT_JITTER_RATIO;
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const schedule = typeof o.schedule === 'function'
      ? o.schedule
      : (fn, ms) => global.setTimeout(fn, ms);
    const cancel = typeof o.cancel === 'function'
      ? o.cancel
      : (handle) => global.clearTimeout(handle);
    const random = typeof o.random === 'function' ? o.random : () => Math.random();

    let timer = null;
    let outageStartedAt = null;
    let escalated = false;
    // Which outage a scheduled callback belongs to. A probe can be in flight
    // when the page flaps connected-then-disconnected (each page runs its own
    // status poller calling the same `setConnected`, so a restarting server
    // produces both transitions inside one probe window). Without this, the
    // resuming `loop()` and the one `begin()` started would each arm a chain
    // and the orphan would double the probe rate against a booting server —
    // the opposite of what the jitter is for.
    let generation = 0;
    // Fires once per outage, at the ceiling, INDEPENDENTLY of any probe. The
    // probe-side checks alone cannot deliver the ceiling: `loop()` re-arms only
    // after `await attempt()` resolves, so while a probe is stalled there is no
    // pending timer at all and nothing to notice that the ceiling passed. That
    // is not a corner case — it is the black-holed host (a sleeping machine, a
    // tailnet route withdrawn), where `fetch` has no deadline and the connect
    // hangs for the browser's own multi-minute timeout. The first probe is
    // scheduled well before the ceiling, so the stall begins while the ceiling
    // is not yet due and the pre-probe check cannot help.
    //
    // Inside the no-UI-timers norm (#98/#268), not an exception to it: this
    // timer changes nothing on its own and navigates nowhere. It only lets the
    // page read a fact whose truth is already fixed by the clock — the outage
    // has lasted `ceilingMs` — and that fact is held in `outageStartedAt`,
    // which is the elsewhere the norm requires.
    let ceilingTimer = null;

    /**
     * Next probe delay, spread across ±`jitterRatio` of the base.
     * @returns {number} Delay in ms, never negative.
     */
    function nextDelayMs() {
      const spread = baseDelayMs * jitterRatio;
      const delay = baseDelayMs - spread + random() * spread * 2;
      return Math.max(0, Math.round(delay));
    }

    /**
     * How long the current outage has provably lasted.
     * @returns {number} Elapsed ms, or 0 when connected.
     */
    function elapsedMs() {
      return outageStartedAt === null ? 0 : now() - outageStartedAt;
    }

    /**
     * Escalate if the outage is still open and has outlived the ceiling.
     *
     * Guarded on the outage still being open because a probe that succeeds
     * calls `end()` re-entrantly through the page's `setConnected`, and
     * escalating after that would render a dead-server message over a live
     * server.
     */
    function escalateIfDue() {
      if (outageStartedAt === null || escalated) return;
      if (elapsedMs() < ceilingMs) return;
      escalated = true;
      onEscalate();
    }

    /**
     * Run one probe, checking the ceiling on both sides of it.
     *
     * Checking BEFORE the probe catches the case where the ceiling fell due
     * while the previous probe was running, so a stalling probe does not push
     * the verdict a further interval out. It is NOT what guarantees the
     * ceiling — a probe that stalls before the ceiling is due leaves no timer
     * pending at all, and no check here can run. The `ceilingTimer` armed in
     * `begin()` is what makes the ceiling a promise; these two checks are what
     * keep it honest in a throttled tab, where that timer fires late.
     *
     * A probe that REJECTS must not take the loop down with it. Neither page
     * can trigger that today (both route through `api()`, which catches), but
     * `probe` is this module's extension point, and an unhandled rejection
     * here would stop the re-arm for the life of the page — silently restoring
     * the exact bug this module exists to remove.
     *
     * @returns {Promise<void>}
     */
    async function attempt() {
      escalateIfDue();
      try {
        await probe();
      } catch (err) {
        // prawduct:allow prawduct/broad-except -- a probe is caller-supplied and
        // may fail in any way; the loop must survive every one of them. Logged,
        // never swallowed.
        if (global.console && global.console.warn) {
          global.console.warn('[tc] reconnect probe threw; continuing to retry', err);
        }
      }
      if (outageStartedAt === null) return; // recovered during the probe
      escalateIfDue();
    }

    /**
     * Schedule the next probe, unless the outage has already ended or this
     * callback belongs to an outage that has.
     * @param {number} gen - The outage generation this chain belongs to.
     */
    function loop(gen) {
      if (outageStartedAt === null || gen !== generation) return;
      timer = schedule(async () => {
        if (outageStartedAt === null || gen !== generation) return;
        await attempt();
        loop(gen);
      }, nextDelayMs());
    }

    return {
      /**
       * Enter (or stay in) the outage state. Idempotent: the outage clock is
       * stamped once, so a repeated disconnection signal cannot keep pushing
       * the ceiling out of reach.
       */
      begin() {
        if (outageStartedAt === null) {
          outageStartedAt = now();
          escalated = false;
          generation++;
          // Armed here rather than after a probe, so a stalled probe cannot
          // hold the verdict. A tab whose timers are throttled gets it late
          // rather than never, and the probe-side checks still cover that case.
          //
          // No generation guard on this one, unlike `loop`: `escalateIfDue`
          // re-reads the live outage clock, so a timer that somehow outlived
          // its outage re-evaluates the CURRENT one honestly rather than
          // escalating on the old one's behalf. A guard here would be a branch
          // no test could ever turn red.
          ceilingTimer = schedule(() => {
            ceilingTimer = null;
            escalateIfDue();
          }, ceilingMs);
          loop(generation);
        }
      },

      /** Leave the outage state: stop probing, reset, and let the page clean up. */
      end() {
        if (timer !== null) {
          cancel(timer);
          timer = null;
        }
        if (ceilingTimer !== null) {
          cancel(ceilingTimer);
          ceilingTimer = null;
        }
        // Retire this outage's generation so a probe still in flight cannot
        // re-arm a chain after the server has come back.
        generation++;
        outageStartedAt = null;
        escalated = false;
        onRecover();
      },

      /**
       * Probe immediately rather than waiting out the current interval — what
       * an operator-facing "Retry now" control calls. The scheduled loop keeps
       * running underneath, so this adds an attempt rather than replacing one.
       * @returns {Promise<void>}
       */
      async retryNow() {
        if (outageStartedAt === null) return;
        await attempt();
      },

      // The three reads below exist so this state machine can be ASSERTED on
      // rather than inferred from what a page happened to render — the outage
      // clock, the escalation latch and the open/closed flag are the whole of
      // its state. A `ceilingMs()` accessor was dropped rather than shipped:
      // neither surface names a duration to the operator, so it would have
      // been a reader with no reader.
      elapsedMs,
      /** @returns {boolean} Whether this outage has already escalated. */
      hasEscalated() { return escalated; },
      /** @returns {boolean} Whether an outage is currently open. */
      isOutage() { return outageStartedAt !== null; }
    };
  }

  global.tcCreateReconnectPolicy = tcCreateReconnectPolicy;
  global.TC_RECONNECT_DEFAULTS = {
    ceilingMs: DEFAULT_CEILING_MS,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    jitterRatio: DEFAULT_JITTER_RATIO
  };
})(typeof window !== 'undefined' ? window : globalThis);
