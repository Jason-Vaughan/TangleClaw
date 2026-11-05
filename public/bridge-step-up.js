'use strict';
/* ── TangleClaw — Bridge step-up approval UI (#2842 Slice 2, Car 63-C) ── */
/*
 * A standalone module, loaded and run the same way `api-helper.js`
 * already is (`test/_api-helper-globals.js`'s `vm` lift, driven against
 * the mini DOM) -- a real script run against real output, not a source
 * probe (#928 R-1 is the standing example of why).
 *
 * NOT mounted into any page yet. Architect Scope Ruling A500-W1C-R1
 * explicitly defers `<script>` inclusion in `public/index.html` /
 * `public/session.html`, and any `server.js`/`lib/tc-verbs.js` singleton
 * wiring, to `#2884`.
 *
 * What it does: lists bridge actions classified `step-up` tier (#2106,
 * #2116's three-tier authority model) that are pending dashboard
 * approval -- the stronger-than-Discord proof a step-up action requires --
 * and lets the signed-in operator approve or deny each one.
 *
 * Each pending item's controls get a UNIQUE id keyed on its own
 * `confirmationId` (`${p}Approve_<id>`, `${p}Deny_<id>`,
 * `${p}DenyReason_<id>`) rather than a delegated click handler reading
 * `data-*` attributes off the DOM tree -- the mini-dom test harness
 * (`test/_mini-dom.js`) is deliberately not a real parser and derives no
 * attributes or ancestry from assigned `innerHTML`, only a flat set of
 * id-bearing elements. Binding directly to each render's own ids, the same
 * way the real browser's structured click would, keeps this file testable
 * without a stub that could pass while a real click does nothing.
 */

(function (global) {
  /**
   * Markup for the step-up panel's static shell: a status line and a list
   * host, both filled by {@link tcCreateBridgeStepUp}'s own `load()`.
   * @param {string} p - Id prefix.
   * @returns {string}
   */
  function tcBridgeStepUpMarkup(p) {
    return `
      <div class="bridge-step-up-status" id="${p}Status" role="status"></div>
      <ul class="bridge-step-up-list" id="${p}List"></ul>`;
  }

  /**
   * Markup for one pending item, with its own uniquely-id'd controls.
   * Exported (not `_`-prefixed) so a test can assert on the returned
   * string directly -- the mini-dom harness (`test/_mini-dom.js`) derives
   * ids only from a root element's OWN upgraded `innerHTML` setter, not
   * from a plain child's, so a list rebuilt via a child's `innerHTML`
   * (this component's own `load()`) never reaches the harness's id
   * extraction; `test/master-settings-frontend.test.js` hits the identical
   * wall for its own dynamic Hard-rules list and answers it the same way.
   * @param {string} p - Id prefix.
   * @param {object} item - One `listPendingConfirmations` entry.
   * @param {Function} esc - HTML-escaping function.
   * @returns {string}
   */
  function tcBridgeStepUpItemMarkup(p, item, esc) {
    const id = item.confirmationId;
    return `
      <li class="bridge-step-up-item">
        <div class="bridge-step-up-item-summary">
          <strong>${esc(item.actionKind)}</strong> — ${esc(item.targetRef)}
          <span class="bridge-step-up-expires">expires ${esc(item.expiresAt)}</span>
        </div>
        <input type="text" class="bridge-step-up-deny-reason" id="${p}DenyReason_${id}" placeholder="Reason for denying (optional)">
        <button type="button" class="btn btn-small" id="${p}Approve_${id}">Approve</button>
        <button type="button" class="btn btn-small btn-kill" id="${p}Deny_${id}">Deny</button>
      </li>`;
  }

  /**
   * Create a bridge step-up approval panel bound to one surface.
   * @param {object} deps
   * @param {Document} [deps.doc] - Owning document (defaults to global).
   * @param {string} deps.rootId - Id of the element to render into.
   * @param {string} deps.prefix - Id prefix for this surface's controls.
   * @param {Function} deps.api - GET helper returning parsed JSON or null.
   * @param {Function} [deps.apiMutate] - Mutating helper (url, method, body); without it, Approve/Deny are inert.
   * @param {Function} [deps.esc] - HTML-escaping function; defaults to the identity (tests only — a real page supplies one).
   * @param {Function} [deps.confirm] - Confirmation prompt for Deny; defaults to the window's.
   * @returns {{mount: Function, load: Function, approve: Function, deny: Function}}
   */
  function tcCreateBridgeStepUp(deps) {
    const doc = deps.doc || global.document;
    const p = deps.prefix;
    const esc = deps.esc || ((s) => String(s));
    const el = (suffix) => doc.getElementById(p + suffix);
    let pending = [];

    /**
     * Render the static shell into the root. Idempotent, same rule every
     * other component here follows: a page may mount at load and again
     * when something opens the surface.
     * @returns {boolean} True when the panel is present after this call.
     */
    function mount() {
      const root = doc.getElementById(deps.rootId);
      if (!root) return false;
      if (!el('List')) root.innerHTML = tcBridgeStepUpMarkup(p);
      return true;
    }

    /**
     * One pending confirmation, by id, from the last `load()` -- the
     * source `approve`/`deny` read `actionKind`/`targetRef`/`digestSha`/
     * `version` from, since the route binds a decision to the EXACT
     * action a pending item named, never a value re-typed by the UI.
     * @param {string} confirmationId
     * @returns {object|null}
     */
    function _find(confirmationId) {
      return pending.find((item) => item.confirmationId === confirmationId) || null;
    }

    /**
     * Approve one pending confirmation, then reload the list so an
     * approved item stops showing as pending.
     * @param {string} confirmationId
     * @returns {Promise<boolean>} True on success.
     */
    async function approve(confirmationId) {
      const item = _find(confirmationId);
      if (!item || !deps.apiMutate) return false;
      const result = await deps.apiMutate(`/api/bridge/operator/step-up/${encodeURIComponent(confirmationId)}/approve`, 'POST', {
        actionKind: item.actionKind, targetRef: item.targetRef, digestSha: item.digestSha, version: item.version
      });
      if (!result) return false;
      await load();
      return true;
    }

    /**
     * Deny one pending confirmation, then reload the list.
     * @param {string} confirmationId
     * @param {string} [reason]
     * @returns {Promise<boolean>} True on success.
     */
    async function deny(confirmationId, reason) {
      if (!deps.apiMutate) return false;
      const result = await deps.apiMutate(`/api/bridge/operator/step-up/${encodeURIComponent(confirmationId)}/deny`, 'POST', { reason });
      if (!result) return false;
      await load();
      return true;
    }

    /**
     * Bind each rendered item's Approve/Deny buttons directly, by the
     * unique id {@link _itemMarkup} gave them -- fresh every `load()`,
     * since the list host's own innerHTML is replaced wholesale each time
     * and would otherwise orphan the previous render's listeners.
     * @returns {void}
     */
    function _bindItems() {
      for (const item of pending) {
        const approveBtn = el(`Approve_${item.confirmationId}`);
        if (approveBtn) approveBtn.addEventListener('click', () => approve(item.confirmationId));
        const denyBtn = el(`Deny_${item.confirmationId}`);
        if (denyBtn) {
          denyBtn.addEventListener('click', () => {
            const ask = deps.confirm || global.confirm;
            if (typeof ask === 'function' && !ask('Deny this step-up request?')) return;
            const reasonInput = el(`DenyReason_${item.confirmationId}`);
            deny(item.confirmationId, reasonInput ? reasonInput.value : undefined);
          });
        }
      }
    }

    /**
     * Fetch and render the pending list.
     * @returns {Promise<void>}
     */
    async function load() {
      const status = el('Status');
      if (!deps.api) return;
      const result = await deps.api('/api/bridge/operator/step-up/pending');
      if (!result) {
        if (status) status.textContent = deps.api.lastError || 'Could not load pending step-up confirmations.';
        return;
      }
      pending = result.pending || [];
      if (status) status.textContent = pending.length ? `${pending.length} pending` : 'Nothing pending';
      const list = el('List');
      if (list) list.innerHTML = pending.map((item) => tcBridgeStepUpItemMarkup(p, item, esc)).join('');
      _bindItems();
    }

    return { mount, load, approve, deny };
  }

  global.tcBridgeStepUpMarkup = tcBridgeStepUpMarkup;
  global.tcBridgeStepUpItemMarkup = tcBridgeStepUpItemMarkup;
  global.tcCreateBridgeStepUp = tcCreateBridgeStepUp;
})(typeof window !== 'undefined' ? window : globalThis);
