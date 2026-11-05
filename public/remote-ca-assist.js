'use strict';
/* ── TangleClaw — remote CA-trust assist rendering (#400) ── */
/*                                                                     */
/* Renders the plan `lib/remote-ca-installer.js#planInstall` returns   */
/* into the same markup shape the Setup Wizard's existing "Remote      */
/* browser trust" panel uses (`setup-https-trust-step`/`setup-https-   */
/* code`, see `public/setup.js`), so Slice 2 (#2886) can drop this in  */
/* without a new visual language. Not wired into the wizard yet.      */
/*                                                                     */
/* Same UMD-ish factory pattern as `public/openclaw-cache.js`: exposed */
/* on `window` for the browser, and `module.exports`'d for tests.      */

(function (global) {
  /**
   * Escape the five characters that let text become markup. Local rather
   * than shared, so this file has no load-order dependency on another
   * script tag — the one thing a "not wired in yet" module must not need.
   * @param {*} value - Any value; non-strings are stringified first.
   * @returns {string}
   */
  function escHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Human-readable wording for whether a step runs itself or needs a
   * person: the same "no silent escalation" boundary
   * `lib/remote-ca-installer.js#executeStep` enforces, said in words.
   * @param {object} step - One entry from a `planInstall(...).steps` array.
   * @returns {string}
   */
  function describePrivilegeBoundary(step) {
    return step && step.privileged
      ? 'Needs admin/sudo on the target machine — run it yourself there.'
      : 'The assistant can run this step.';
  }

  /**
   * Render one install plan as the wizard's own trust-step markup: a
   * labelled block per step, the command in a `<pre><code>` when it has
   * one, and the privilege boundary stated beside it. Every value is
   * escaped; nothing here trusts `plan`.
   * @param {{caRootPath?: string, rootCaPath?: string, steps?: object[]}} plan - A `planInstall` result.
   * @returns {string} HTML.
   */
  function renderPlanSteps(plan) {
    const p = plan || {};
    const steps = Array.isArray(p.steps) ? p.steps : [];
    if (steps.length === 0) return '<p class="setup-text-muted">No install steps to show.</p>';
    return steps.map((step) => {
      const platformLabel = step.platform ? `<strong>${escHtml(step.platform)}</strong> — ` : '';
      const command = step.command
        ? `<pre class="setup-https-code"><code>${escHtml(step.command)}</code></pre>`
        : '';
      return `
      <div class="setup-https-trust-step remote-ca-assist-step${step.privileged ? ' remote-ca-assist-step-privileged' : ''}">
        <div class="setup-https-trust-label">${platformLabel}${escHtml(step.label || '')}</div>
        ${command}
        <p class="setup-text-muted remote-ca-assist-boundary">${escHtml(describePrivilegeBoundary(step))}</p>
      </div>`;
    }).join('');
  }

  const api = { escHtml, describePrivilegeBoundary, renderPlanSteps };

  // Browser: expose on window for the setup wizard (once Slice 2 loads this script).
  if (global) {
    global.tcRenderRemoteCaPlanSteps = renderPlanSteps;
    global.tcDescribeRemoteCaPrivilegeBoundary = describePrivilegeBoundary;
  }
  // Node (test): expose via CommonJS module.exports too.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
