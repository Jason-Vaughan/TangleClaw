'use strict';
/* ── TangleClaw — Engine failover modal (#109) ── */
/*                                                                        */
/* Polls GET /api/sessions/:project/engine-health on the session page's   */
/* existing status-poll cadence (no new timer — `mount()`'s caller rides  */
/* `pollStatus()`, same convention `medusaControl.poll()` already uses).  */
/* On a CRASHED reading it opens session.html's static `engineFailoverModal`*/
/* markup and stays open until the operator picks a button — this file    */
/* never wires a backdrop-click or Escape close, which is what makes the  */
/* modal non-dismissible: "never auto-swap" means the choice is always    */
/* explicit, never a side effect of clicking outside it.                  */
/*                                                                        */
/* This file deliberately does NOT create the modal's DOM, the same       */
/* convention `medusa-loops-ui.js` documents for its own modal: the       */
/* markup is session.html's, unprefixed, and `mount()` only binds         */
/* listeners to elements it assumes already exist.                        */

(function (global) {
  /**
   * Build the engine-failover modal controller.
   * @param {object} deps
   * @param {Document} deps.doc - The document to query (tests pass a mini DOM).
   * @param {(url: string) => Promise<object|null>} deps.api - GET helper (null on failure).
   * @param {(url: string, method: string, body: object) => Promise<object|null>} deps.apiMutate - Mutating helper.
   * @param {string} deps.projectName - This session's project name.
   * @param {() => object[]} deps.getEngines - Returns the current `sessionState.engines` list,
   *   read lazily so a load that finishes after `mount()` is still picked up.
   * @param {(list: object[], selectedId: string) => string} deps.buildEngineOptions - The shared
   *   `<option>` builder session.js already uses for its own engine dropdown (installed-vs-not
   *   labelling stays single-sourced rather than forked here).
   * @param {(msg: string, isError?: boolean) => void} [deps.toast] - Optional toast on failure.
   * @param {() => boolean} [deps.isDeleteProtected] - Whether this install has a delete password
   *   configured (`sessionState.config.deleteProtected`) — kill/restart/swap all reuse the same
   *   `projects.checkDeletePassword` gate the plain Kill modal does, so this modal must offer the
   *   same field or every button on a password-protected install fails silently (PRR-B finding).
   * @returns {{mount: () => void, poll: () => Promise<{crashed: boolean, suppressed: boolean}>, isOpen: () => boolean}}
   */
  function create(deps) {
    const { doc, api, apiMutate, projectName, getEngines, buildEngineOptions, toast, isDeleteProtected } = deps;
    let open = false;
    let busy = false;
    // Set once a confirmed `kill` succeeds. The store's `crashed` status on
    // that row never changes afterward (`store.sessions` transitions are
    // one-way), so without this the very next poll would see that same
    // row, report CRASHED again, and reopen the modal right after the
    // operator just confirmed ending it. `restart`/`swap` never set it (a
    // new session is expected to keep being monitored). Cleared the moment
    // `poll()` next observes a genuinely live session — not a one-way latch
    // for the page's whole lifetime: `public/session.js`'s own
    // `startEndedWatch` can revive this same page for a brand new session
    // on the same project without a reload (PRR-B Round 2 finding).
    let justKilled = false;

    function els() {
      return {
        backdrop: doc.getElementById('engineFailoverModal'),
        detail: doc.getElementById('engineFailoverDetail'),
        status: doc.getElementById('engineFailoverStatus'),
        targetSelect: doc.getElementById('engineFailoverTargetEngine'),
        passwordGroup: doc.getElementById('engineFailoverPasswordGroup'),
        passwordInput: doc.getElementById('engineFailoverPassword'),
        restartBtn: doc.getElementById('engineFailoverRestartBtn'),
        swapBtn: doc.getElementById('engineFailoverSwapBtn'),
        continueBtn: doc.getElementById('engineFailoverContinueBtn'),
        killBtn: doc.getElementById('engineFailoverKillBtn')
      };
    }

    /**
     * One poll round: fetch the current classification and open/close the
     * modal to match. A read that errors (server unreachable) leaves the
     * modal exactly as it was — the next poll tries again, same as every
     * other reading this page's `pollStatus` already tolerates.
     *
     * Returns whether this family is already handling the session's end —
     * CRASHED (modal open, or about to be) or `suppressed` (the operator
     * already chose "Continue manually") — so `pollStatus` can skip the
     * generic ended-session flow instead of racing it (#109 "stopped
     * polling" finding: that flow calls `stopPolling()`, which would end
     * this poll loop, and therefore this modal, before it ever ran once for
     * the primary crash case).
     * @returns {Promise<{crashed: boolean, suppressed: boolean}>}
     */
    async function poll() {
      const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/engine-health`);
      if (!data) return { crashed: open, suppressed: false };
      if (data.active) {
        // A live session exists again — whatever `justKilled` was holding
        // open for is over. PRR-B Round 2 finding: `public/session.js`'s
        // own `startEndedWatch` can revive this exact page for a brand new
        // session on the same project without a reload, and the latch
        // must not keep refusing to poll for that new session forever.
        justKilled = false;
      }
      if (justKilled) {
        // The killed session's own `crashed`/`killed` row never changes,
        // so GET would otherwise keep answering about it forever. That
        // crash is already handled: never reopen for it, and tell
        // `pollStatus` nothing is handled here so its generic ended-flow
        // runs exactly as it would without this module's interception.
        if (open) hide();
        return { crashed: false, suppressed: false };
      }
      if (data.state === 'CRASHED' && !open) show(data);
      else if (data.state !== 'CRASHED' && open) hide();
      return { crashed: data.state === 'CRASHED', suppressed: !!data.suppressed };
    }

    /**
     * Open the modal with this probe's detail.
     * @param {object} data - The `GET .../engine-health` payload.
     * @returns {void}
     */
    function show(data) {
      const { backdrop, detail, targetSelect, status, passwordGroup, passwordInput } = els();
      if (!backdrop) return;
      open = true;
      const crash = Array.isArray(data.recentCrashes) ? data.recentCrashes[0] : null;
      const parts = [`Engine "${data.engine || 'unknown'}" is no longer responding.`];
      if (crash && crash.reason) parts.push(`Last known cause: ${crash.reason}.`);
      if (crash && Number.isFinite(crash.durationMs)) {
        parts.push(`It had been running for ${Math.round(crash.durationMs / 1000)}s.`);
      }
      if (detail) detail.textContent = parts.join(' ');
      if (status) status.textContent = '';
      if (targetSelect && typeof buildEngineOptions === 'function') {
        const engines = typeof getEngines === 'function' ? getEngines() : [];
        targetSelect.innerHTML = buildEngineOptions(engines, data.engine || '');
      }
      const protected_ = typeof isDeleteProtected === 'function' && isDeleteProtected();
      if (passwordGroup) passwordGroup.classList.toggle('hidden', !protected_);
      if (passwordInput) passwordInput.value = '';
      backdrop.classList.add('open');
    }

    /** Close the modal. @returns {void} */
    function hide() {
      open = false;
      const { backdrop } = els();
      if (backdrop) backdrop.classList.remove('open');
    }

    /**
     * Send a confirmed failover action and close on success.
     * @param {string} action - One of 'restart' | 'swap' | 'kill' | 'continue-manually'.
     * @param {object} [extra] - Extra body fields (e.g. `targetEngine` for 'swap').
     * @returns {Promise<void>}
     */
    async function sendAction(action, extra = {}) {
      if (busy) return;
      busy = true;
      const { status, passwordInput } = els();
      if (status) status.textContent = 'Working…';
      const body = { action, userConfirmed: true, ...extra };
      // Only kill/restart/swap reach `projects.checkDeletePassword` server
      // side — continue-manually mutates nothing, so it needs no password.
      if (action !== 'continue-manually' && passwordInput && passwordInput.value) {
        body.password = passwordInput.value;
      }
      const result = await apiMutate(
        `/api/sessions/${encodeURIComponent(projectName)}/engine-failover`,
        'POST',
        body
      );
      busy = false;
      if (result) {
        if (action === 'kill') justKilled = true;
        hide();
        return;
      }
      // A wrong/missing password (403 FORBIDDEN) must not look like "closed,
      // try the button again from scratch" — leave the field focused so the
      // operator can just retype it, matching the existing #killModal's
      // own `killError` pattern.
      const message = (api.lastError) || `Could not ${action}. Try again.`;
      if (status) status.textContent = message;
      if (passwordInput && !passwordInput.classList.contains('hidden')) passwordInput.focus();
      if (typeof toast === 'function') toast(message, true);
    }

    /**
     * Bind the modal's buttons. Deliberately does not bind a backdrop click
     * or an Escape handler — see the file header.
     * @returns {void}
     */
    function mount() {
      const { restartBtn, swapBtn, continueBtn, killBtn, targetSelect } = els();
      if (restartBtn) restartBtn.addEventListener('click', () => sendAction('restart'));
      if (swapBtn) {
        swapBtn.addEventListener('click', () => {
          const targetEngine = targetSelect ? targetSelect.value : '';
          if (!targetEngine) return;
          sendAction('swap', { targetEngine });
        });
      }
      if (continueBtn) continueBtn.addEventListener('click', () => sendAction('continue-manually'));
      if (killBtn) killBtn.addEventListener('click', () => sendAction('kill'));
    }

    return { mount, poll, isOpen: () => open };
  }

  global.tcCreateEngineFailoverModal = create;
})(window);
