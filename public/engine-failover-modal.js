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
   * @returns {{mount: () => void, poll: () => Promise<void>, isOpen: () => boolean}}
   */
  function create(deps) {
    const { doc, api, apiMutate, projectName, getEngines, buildEngineOptions, toast } = deps;
    let open = false;
    let busy = false;

    function els() {
      return {
        backdrop: doc.getElementById('engineFailoverModal'),
        detail: doc.getElementById('engineFailoverDetail'),
        status: doc.getElementById('engineFailoverStatus'),
        targetSelect: doc.getElementById('engineFailoverTargetEngine'),
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
     * @returns {Promise<void>}
     */
    async function poll() {
      const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/engine-health`);
      if (!data) return;
      if (data.state === 'CRASHED' && !open) show(data);
      else if (data.state !== 'CRASHED' && open) hide();
    }

    /**
     * Open the modal with this probe's detail.
     * @param {object} data - The `GET .../engine-health` payload.
     * @returns {void}
     */
    function show(data) {
      const { backdrop, detail, targetSelect, status } = els();
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
      const { status } = els();
      if (status) status.textContent = 'Working…';
      const result = await apiMutate(
        `/api/sessions/${encodeURIComponent(projectName)}/engine-failover`,
        'POST',
        { action, userConfirmed: true, ...extra }
      );
      busy = false;
      if (result) {
        hide();
        return;
      }
      const message = (api.lastError) || `Could not ${action}. Try again.`;
      if (status) status.textContent = message;
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
