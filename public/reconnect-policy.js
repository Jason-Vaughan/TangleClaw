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
     * Run one probe and, if the server is still gone, decide whether the
     * outage has outlived the ceiling.
     *
     * The ceiling is only consulted AFTER the probe, and only while the outage
     * is still open: a probe that succeeds calls `end()` re-entrantly through
     * the page's `setConnected`, which clears `outageStartedAt`, and escalating
     * after that would render a dead-server message over a live server.
     * @returns {Promise<void>}
     */
    async function attempt() {
      await probe();
      if (outageStartedAt === null) return; // recovered during the probe
      if (!escalated && elapsedMs() >= ceilingMs) {
        escalated = true;
        onEscalate();
      }
    }

    /** Schedule the next probe, unless the outage has already ended. */
    function loop() {
      if (outageStartedAt === null) return;
      timer = schedule(async () => {
        if (outageStartedAt === null) return;
        await attempt();
        loop();
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
          loop();
        }
      },

      /** Leave the outage state: stop probing, reset, and let the page clean up. */
      end() {
        if (timer !== null) {
          cancel(timer);
          timer = null;
        }
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

      elapsedMs,
      /** @returns {boolean} Whether this outage has already escalated. */
      hasEscalated() { return escalated; },
      /** @returns {boolean} Whether an outage is currently open. */
      isOutage() { return outageStartedAt !== null; },
      /** @returns {number} The configured ceiling, so pages can report it. */
      ceilingMs() { return ceilingMs; }
    };
  }

  global.tcCreateReconnectPolicy = tcCreateReconnectPolicy;
  global.TC_RECONNECT_DEFAULTS = {
    ceilingMs: DEFAULT_CEILING_MS,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    jitterRatio: DEFAULT_JITTER_RATIO
  };
})(typeof window !== 'undefined' ? window : globalThis);
