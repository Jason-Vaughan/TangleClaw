'use strict';

/*
 * Authorization toggle: Allow sub-agent parallelization, browser side (#1257).
 *
 * The toggle grants a Builder session the AUTHORIZATION to fan a chunk's
 * tasks out to sub-agents; it does not decide per task — that is
 * `lib/subagent-parallelization.js#evaluateSubagentTask`'s job, run by the
 * Builder session itself once authorized. This file is only the Project
 * Settings control: live where the selected engine declares
 * `capabilities.supportsSubagentDispatch`, inert with the reason where it
 * does not (ADR 0013) -- the same shape every other engine-conditional
 * toggle in `public/ui.js` already follows (`renderMedusaWakeToggle`,
 * `renderSilentPrimeToggle`).
 *
 * Depends on the global `esc` (landing.js/ui.js) and `tcSettingDisposition`
 * (api-helper.js), the same two conventions every sibling UI file here
 * declares.
 */

/**
 * Render the "Allow sub-agent parallelization" toggle inside
 * `#settingsSubagentParallelizationContainer` for the engine selected in the
 * dropdown -- live where the engine declares `supportsSubagentDispatch`,
 * inert with the reason where it does not. Mirrors
 * `renderMedusaWakeToggle`/`renderSilentPrimeToggle`: the inert branch
 * carries no `#settingsSubagentParallelization` element, so a save attaches
 * no value and the stored key stays whatever it was.
 *
 * @param {string} engineId - Engine id from the dropdown's current value.
 * @param {boolean} preserveChecked - The checkbox state to carry over (or initial).
 * @param {object|null} [projectEngine] - The project's own enriched engine, for
 *   the connection-backed ids `state.engines` omits.
 */
function renderSubagentParallelizationToggle(engineId, preserveChecked, projectEngine) {
  const container = document.getElementById('settingsSubagentParallelizationContainer');
  if (!container) return;
  const profile = tcResolveEngineProfile(state.engines, engineId, projectEngine);
  const disposition = tcSettingDisposition(
    'subagentParallelizationEnabled', { subagentParallelizationEnabled: preserveChecked }, profile
  );
  if (!disposition.applies) {
    container.innerHTML = `
    <div class="form-group">
      <label class="gs-toggle-label gs-toggle-label--disabled">
        <span>Allow sub-agent parallelization</span>
        <input type="checkbox" id="settingsSubagentParallelizationNotApplicable" disabled>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">${esc(disposition.reason)}</div>
    </div>`;
    return;
  }
  container.innerHTML = `
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Allow sub-agent parallelization</span>
        <input type="checkbox" id="settingsSubagentParallelization" ${preserveChecked ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">Authorizes a Builder session to fan this project's chunk work out to sub-agents — only for pure reading/discovery, never for writing or git-state mutation. The Builder still decides per task; this only grants it the authorization to. Off by default.</div>
    </div>`;
}
