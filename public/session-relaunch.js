/* ── TangleClaw — session relaunch (pure state) ── */

/**
 * The "Restart Session" action on the session page's ended bar (#1637).
 *
 * A wrap is most often run to clear the model's context and carry on in the
 * same project. Once the wrap has ended the session, this starts the next one
 * from the page the operator is already on, instead of a round trip through the
 * landing page.
 *
 * It is deliberately thin. The relaunch IS the canonical launch transaction —
 * `POST /api/sessions/:project`, the route the landing page uses — so every gate
 * that route enforces (STOP, stranded wraps, an active session, unknown
 * liveness, the handoff preflight) stays authoritative here. Nothing in this
 * file decides whether a launch may happen; it decides only
 *
 *   - whether to OFFER the action (`relaunchEligibility`),
 *   - what to send (`relaunchRequestBody`),
 *   - what a refusal means for the button (`classifyLaunchFailure`), and
 *   - what a status read says after an outcome nobody can vouch for
 *     (`reconcileOutcome`).
 *
 * `createRelaunchController` ties those together behind one latch, so a click
 * produces at most one launch request and an ambiguous answer is resolved by a
 * status READ, never by a second POST.
 *
 * DOM-free: every rule is tested in Node (`test/session-relaunch.test.js`).
 * Loaded by the browser as a plain script before `session.js`, and by tests.
 */
(function (global) {
  'use strict';

  const LABEL_IDLE = 'Restart Session';
  const LABEL_BUSY = 'Restarting…';
  const LABEL_CHECKING = 'Checking…';

  /**
   * Refusals after which nothing was launched and trying again is harmless. The
   * button comes back; whether a retry succeeds is the server's call, and a STOP
   * that still stands refuses it again.
   */
  const RETRYABLE = new Set([
    'CONTROL_STOPPED',
    'CONTROL_HELD',
    'CONTROL_STATE_UNAVAILABLE',
    'NOT_FOUND',
    'BAD_REQUEST',
    'UNAUTHENTICATED',
    'ACCOUNT_REQUIRED',
    'CSRF_TOKEN_INVALID'
  ]);

  /**
   * Refusals that need a choice or an acknowledgement the landing page offers
   * and this page does not. Acknowledging stranded wraps on the operator's
   * behalf would be the bypass the launch gate exists to prevent, so the answer
   * is to send them there.
   */
  const NEEDS_LANDING = new Set(['STRANDED_WRAPS', 'TUNNEL_CONFLICT']);

  /**
   * Should the ended bar offer a relaunch for this status read?
   *
   * Only on durable evidence that the latest session WRAPPED and is no longer
   * running. The status route answers `active: false` only when tmux confirmed
   * absence; `null` is unknown liveness and never counts. `lastSession` is the
   * project's newest session row, so an older wrap cannot vouch for a newer
   * session that was killed or crashed.
   *
   * @param {object|null|undefined} status - Body of `GET /api/sessions/:project/status`.
   * @returns {{eligible: boolean, reason: string}} `reason` names why, for tests and diagnostics.
   */
  function relaunchEligibility(status) {
    if (!status || typeof status !== 'object') return { eligible: false, reason: 'no-status' };
    if (status.active === true) return { eligible: false, reason: 'active' };
    if (status.active !== false) return { eligible: false, reason: 'liveness-unknown' };
    if (status.wrapping) return { eligible: false, reason: 'wrapping' };
    if (status.untracked) return { eligible: false, reason: 'untracked' };
    const last = status.lastSession;
    if (!last || typeof last !== 'object') return { eligible: false, reason: 'no-last-session' };
    if (last.status !== 'wrapped') return { eligible: false, reason: `last-session-${last.status || 'unknown'}` };
    return { eligible: true, reason: 'wrapped' };
  }

  /**
   * The launch request body. Only the continuity choice is sent: the fresh
   * context must still receive the wrap's published handoff, so this is never
   * the landing page's "Fresh start". Launch mode, engine and stranded
   * acknowledgements are left out on purpose — the server then applies the
   * project's configured defaults, rather than silently repeating whatever
   * one-off choice started the session that just ended.
   *
   * @returns {{continuityMode: 'continue'}}
   */
  function relaunchRequestBody() {
    return { continuityMode: 'continue' };
  }

  /**
   * The session page URL for a project.
   *
   * @param {string} project - Project name.
   * @param {{launched?: boolean}} [opts] - `launched` adds `?launched=1`, which
   *   gives the new page the grace polls a just-started tmux needs.
   * @returns {string}
   */
  function sessionUrl(project, opts) {
    const base = `/session/${encodeURIComponent(project)}`;
    return opts && opts.launched ? `${base}?launched=1` : base;
  }

  /**
   * What a failed launch means for the button.
   *
   * `uncertain` covers every answer after which a session MAY exist: a lost
   * connection (`code === null`), a pane started without a bound row, a server
   * error, an "already active" conflict, and any code this file does not know.
   * Those are settled by reading status, never by asking again.
   *
   * @param {string|null|undefined} code - The refusal's `code`, or null when no structured answer arrived.
   * @returns {('retryable'|'needs-landing'|'liveness-unknown'|'uncertain')}
   */
  function classifyLaunchFailure(code) {
    if (code && RETRYABLE.has(code)) return 'retryable';
    if (code && NEEDS_LANDING.has(code)) return 'needs-landing';
    if (code === 'LIVENESS_UNKNOWN') return 'liveness-unknown';
    return 'uncertain';
  }

  /**
   * Read a reconcile status after an uncertain launch outcome.
   *
   * @param {object|null|undefined} status - Status body, or null when the read itself failed.
   * @returns {('open-active'|'absent'|'unknown')}
   */
  function reconcileOutcome(status) {
    if (!status || typeof status !== 'object') return 'unknown';
    if (status.active === true) return 'open-active';
    if (status.active === false) return 'absent';
    return 'unknown';
  }

  /**
   * Turn an `apiMutate` result into a launch result. `apiMutate` returns the
   * body or null, and reports why through `api.lastErrorCode` (a structured
   * refusal) or `api.lastError` alone (no answer reached the page).
   *
   * @param {object|null} data - What `apiMutate` returned.
   * @param {{lastError?: (string|null), lastErrorCode?: (string|null)}} api - The page's `api` side channel.
   * @returns {{ok: true, data: object}|{ok: false, code: (string|null), error: (string|null)}}
   */
  function launchResultFromApi(data, api) {
    if (data) return { ok: true, data };
    const a = api || {};
    return { ok: false, code: a.lastErrorCode || null, error: a.lastError || null };
  }

  /**
   * Build the controller for one ended page.
   *
   * Phases: `ready` (the button can be pressed), `launching`, `reconciling`,
   * `navigating` (terminal: the page is leaving) and `blocked` (terminal until
   * reload: a gate this page cannot resolve, or an outcome nobody can confirm).
   * `activate` does nothing outside `ready`, and the phase leaves `ready`
   * before the first await — that ordering is the at-most-one-POST guarantee.
   *
   * @param {object} deps
   * @param {string} deps.project - Project name.
   * @param {(body: object) => Promise<object>} deps.launch - Sends the launch; resolves to a `launchResultFromApi` shape.
   * @param {() => Promise<(object|null)>} deps.readStatus - Reads `GET /status`; resolves null on failure.
   * @param {(url: string) => void} deps.navigate - Leaves the page.
   * @param {(view: object) => void} deps.render - Paints `{label, disabled, message, tone, pointToLanding}`.
   * @returns {{activate: () => Promise<string>, phase: () => string}}
   */
  function createRelaunchController(deps) {
    let phase = 'ready';

    /**
     * Paint a view.
     * @param {string} label
     * @param {boolean} disabled
     * @param {string} message
     * @param {(string|null)} tone - `error`, `warn`, `info` or null.
     * @param {boolean} [pointToLanding]
     */
    function paint(label, disabled, message, tone, pointToLanding) {
      deps.render({ label, disabled, message, tone, pointToLanding: Boolean(pointToLanding) });
    }

    /**
     * Leave for a session page. Terminal: nothing on this page acts again.
     * @param {string} url
     * @param {string} message
     */
    function leave(url, message) {
      phase = 'navigating';
      paint(LABEL_BUSY, true, message, 'info');
      deps.navigate(url);
    }

    /**
     * Stop in a state this page cannot resolve on its own.
     * @param {string} message
     * @param {string} tone
     * @param {boolean} [pointToLanding]
     */
    function block(message, tone, pointToLanding) {
      phase = 'blocked';
      paint(LABEL_IDLE, true, message, tone, pointToLanding);
    }

    /**
     * Settle an outcome nobody can vouch for by READING status. Never POSTs.
     * @param {(string|null)} error - What the launch said, if anything.
     * @returns {Promise<string>} The resulting phase.
     */
    async function reconcile(error) {
      phase = 'reconciling';
      paint(LABEL_CHECKING, true, 'Checking whether a session started…', 'info');
      let status = null;
      try {
        status = await deps.readStatus();
      } catch (_err) { // prawduct:allow prawduct/broad-except -- any failed read is "could not confirm", which is the state painted next
        status = null;
      }
      const outcome = reconcileOutcome(status);
      if (outcome === 'open-active') {
        leave(sessionUrl(deps.project), 'A session is running for this project — opening it.');
      } else if (outcome === 'absent') {
        phase = 'ready';
        paint(LABEL_IDLE, false,
          `${error || 'The launch did not complete.'} No session is running, so you can try again.`, 'error');
      } else {
        block('Could not confirm whether a session started. Reload the page to check before trying again.', 'warn');
      }
      return phase;
    }

    /**
     * Handle one press of the button.
     * @returns {Promise<string>} The resulting phase (`ignored` when the press did nothing).
     */
    async function activate() {
      if (phase !== 'ready') return 'ignored';
      phase = 'launching';
      paint(LABEL_BUSY, true, '', null);

      let result;
      try {
        result = await deps.launch(relaunchRequestBody());
      } catch (_err) { // prawduct:allow prawduct/broad-except -- a thrown launch is an answer that never arrived; it is reconciled, not retried
        result = { ok: false, code: null, error: null };
      }

      if (result && result.ok) {
        leave(sessionUrl(deps.project, { launched: true }), 'Session started — opening it.');
        return phase;
      }

      const code = result ? result.code : null;
      const error = result ? result.error : null;
      const kind = classifyLaunchFailure(code);
      if (kind === 'retryable') {
        phase = 'ready';
        paint(LABEL_IDLE, false, error || 'The launch was refused.', 'error');
        return phase;
      }
      if (kind === 'needs-landing') {
        block(`${error || 'The launch needs a decision this page cannot take.'} Use Back to Projects to resolve it and launch from there.`,
          'warn', true);
        return phase;
      }
      if (kind === 'liveness-unknown') {
        block(`${error || 'TangleClaw could not tell whether a session is running.'} Reload the page to check before trying again.`, 'warn');
        return phase;
      }
      return reconcile(error);
    }

    return { activate, phase: () => phase };
  }

  const relaunch = {
    LABEL_IDLE,
    LABEL_BUSY,
    relaunchEligibility,
    relaunchRequestBody,
    sessionUrl,
    classifyLaunchFailure,
    reconcileOutcome,
    launchResultFromApi,
    createRelaunchController
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = relaunch;
  }
  if (global) {
    global.tcSessionRelaunch = relaunch;
  }
})(typeof window !== 'undefined' ? window : null);
