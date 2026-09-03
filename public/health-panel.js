'use strict';
/* ── TangleClaw — the system health panel (#345) ── */
/* Renders the conditions `GET /api/system/health` reports. Loaded as a plain  */
/* script before landing.js, exposing one render function on `window`.        */

(function (global) {
  /**
   * HTML-escape a value for interpolation into markup. Self-contained rather
   * than borrowed from the page script so this module renders the same on any
   * page that loads it.
   * @param {*} value - Anything; coerced to a string.
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * One rendered row for a condition that FIRED: its name, what was measured,
   * and the one-line remediation with a copy button (terminal copy on a phone
   * is not something the operator can rely on, #431).
   * @param {{id: string, title: string, detail: string, remediation: string}} c - The condition.
   * @returns {string} Markup.
   */
  function firedRow(c) {
    return '<div class="health-row health-fired" data-condition="' + escapeHtml(c.id) + '">'
      + '<span class="health-title">' + escapeHtml(c.title) + '</span>'
      + '<span class="health-detail">' + escapeHtml(c.detail) + '</span>'
      + '<span class="health-fix"><code>' + escapeHtml(c.remediation) + '</code>'
      + '<button type="button" class="btn btn-small health-copy" data-fix="' + escapeHtml(c.remediation) + '"'
      + ' title="Copy the fix">Copy</button></span>'
      + '</div>';
  }

  /**
   * One rendered row for a condition that could NOT be measured. Says so in
   * words — "could not check", with the reason — and shows no remediation,
   * because nothing has been found to remediate.
   * @param {{id: string, title: string, detail: string}} c - The condition.
   * @returns {string} Markup.
   */
  function unknownRow(c) {
    return '<div class="health-row health-unknown" data-condition="' + escapeHtml(c.id) + '">'
      + '<span class="health-title">Could not check: ' + escapeHtml(c.title) + '</span>'
      + '<span class="health-detail">' + escapeHtml(c.detail) + '</span>'
      + '</div>';
  }

  /**
   * Copy a remediation line to the clipboard when its button is pressed.
   * Delegated from the panel container so the buttons can be re-rendered on
   * every poll without re-binding. Silent when the clipboard API is absent
   * (plain-http origins) — the text is on screen either way.
   * @param {Event} evt - The click event.
   * @returns {void}
   */
  function onPanelClick(evt) {
    const target = evt && evt.target;
    const fix = target && target.dataset && target.dataset.fix;
    if (!fix) return;
    const clipboard = global.navigator && global.navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return;
    clipboard.writeText(fix).then(() => {
      target.textContent = 'Copied';
    }, () => {
      target.textContent = 'Copy failed';
    });
  }

  /**
   * Render the system health panel into `container` from a
   * `GET /api/system/health` payload.
   *
   * Shows ONLY what the operator must act on or cannot trust: conditions in
   * state `fired` (with their fix) and conditions in state `unknown` (named as
   * unmeasured). A `clear` condition draws nothing, and when nothing fired and
   * nothing is unknown the whole panel hides — a dashboard with no problems has
   * no health panel, rather than a green one that must be read to be dismissed.
   *
   * `unknown` is never treated as clear. A probe that could not run has not
   * said the machine is healthy, and hiding it would render silence as an
   * all-clear — the same rule the update beacon and the stale banner follow.
   *
   * @param {HTMLElement|null} container - The panel element (`#systemHealthPanel`).
   * @param {{conditions?: Array<{id: string, title: string, state: string, detail: string, remediation: string}>}|null} data - Route payload.
   * @param {{omit?: string[]}} [opts] - `omit`: condition ids a page renders
   *   through a dedicated surface of its own (the landing page's stale-server
   *   banner), so the same fact is not stated twice on one screen.
   * @returns {{fired: number, unknown: number, visible: boolean}} What was drawn.
   */
  function tcRenderHealthPanel(container, data, opts) {
    const result = { fired: 0, unknown: 0, visible: false };
    if (!container) return result;
    const omit = new Set((opts && opts.omit) || []);
    const conditions = (data && Array.isArray(data.conditions)) ? data.conditions : [];
    const fired = conditions.filter((c) => c && c.state === 'fired' && !omit.has(c.id));
    const unknown = conditions.filter((c) => c && c.state === 'unknown' && !omit.has(c.id));
    result.fired = fired.length;
    result.unknown = unknown.length;

    if (!container.dataset.healthBound) {
      container.addEventListener('click', onPanelClick);
      container.dataset.healthBound = '1';
    }

    if (fired.length === 0 && unknown.length === 0) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return result;
    }

    container.innerHTML =
      '<div class="health-heading">System health</div>'
      + fired.map(firedRow).join('')
      + unknown.map(unknownRow).join('');
    container.classList.remove('hidden');
    result.visible = true;
    return result;
  }

  global.tcRenderHealthPanel = tcRenderHealthPanel;
})(typeof window !== 'undefined' ? window : globalThis);
