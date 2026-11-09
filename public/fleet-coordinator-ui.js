'use strict';

/**
 * Fleet Coordinator / Decider toggle (#2937) — the Project Settings modal's
 * one extra field, wired entirely from this file rather than from
 * `public/ui.js`'s own settings template.
 *
 * `#settingsBody`'s innerHTML is replaced wholesale every time Settings
 * opens (`public/ui.js`'s own doc comment on that element says so, and
 * `test/project-update-two-phase.test.js`'s static parser only scans
 * `ui.js`'s literal `body = {...}`/`body.x =` save-phase assignments and
 * `session.js`'s inline `apiMutate` PATCH bodies — never this file), so this
 * script never edits `ui.js` and never routes its own save through the
 * generic project-settings PATCH: it reads and writes the flag through its
 * own dedicated `/api/tc/fleet/coordinator` endpoint, fully disjoint from
 * both.
 *
 * `#settingsBody` itself IS a stable element across opens (only its
 * innerHTML is swapped) — the same fact `ui.js`'s own `handleProjectRulesEvent`
 * wiring relies on — so one delegated `change` listener attached once here
 * keeps working for every render.
 *
 * @module public/fleet-coordinator-ui
 */

(function () {
  const TOGGLE_ID = 'fleetCoordinatorToggle';
  const STATUS_ID = 'fleetCoordinatorStatus';

  /**
   * Build the toggle's markup. No current state yet — filled in once the
   * read below answers, so a slow network never shows a wrong checked state.
   * @returns {string}
   */
  function _blockHtml() {
    return `
    <div class="form-group" id="fleetCoordinatorGroup">
      <label class="gs-toggle-label">
        <span>Fleet Coordinator / Decider (can provision &amp; govern its own fleet)</span>
        <input type="checkbox" id="${TOGGLE_ID}" disabled>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint" id="${STATUS_ID}">Loading…</div>
    </div>`;
  }

  /**
   * The settings modal's current project NAME, read from the one field
   * `ui.js`'s own template always renders (`#settingsName`) — never from a
   * `ui.js` internal, since none is reachable from here.
   * @returns {string|null}
   */
  function _currentProjectName() {
    const el = document.getElementById('settingsName');
    return el && el.value ? el.value : null;
  }

  /**
   * This project's numeric id, resolved by name through the existing
   * read-only project API (a call, not an edit, of a file outside this
   * car's scope).
   * @param {string} name
   * @returns {Promise<number|null>}
   */
  async function _resolveProjectId(name) {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`);
      if (!res.ok) return null;
      const project = await res.json();
      return Number.isInteger(project.id) ? project.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Inject the toggle into the freshly-rendered settings body, then fill in
   * its real state. A no-op if it is already there (this runs on every
   * mutation of `#settingsBody`, not only the first).
   * @returns {Promise<void>}
   */
  async function _ensureInjected() {
    const body = document.getElementById('settingsBody');
    if (!body || !document.getElementById('settingsName')) return;
    if (document.getElementById(TOGGLE_ID)) return;
    body.insertAdjacentHTML('beforeend', _blockHtml());

    const name = _currentProjectName();
    const checkbox = document.getElementById(TOGGLE_ID);
    const status = document.getElementById(STATUS_ID);
    const projectId = name ? await _resolveProjectId(name) : null;
    if (!projectId) {
      status.textContent = 'Could not resolve this project — reopen Settings to try again.';
      return;
    }
    checkbox.dataset.projectId = String(projectId);
    try {
      const res = await fetch(`/api/tc/fleet/coordinator?projectId=${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      checkbox.checked = !!data.fleetCoordinator;
      checkbox.disabled = false;
      status.textContent = checkbox.checked
        ? 'This project may provision its own sibling fleet.'
        : 'Operator only. Grants self-service fleet provisioning.';
    } catch (err) {
      status.textContent = `Could not read the current setting: ${err.message}`;
    }
  }

  /**
   * One delegated listener, attached once to the stable `#settingsBody`
   * element (same pattern `ui.js` itself uses for
   * `handleProjectRulesEvent` — see its own comment on that element).
   * @param {Event} ev
   * @returns {Promise<void>}
   */
  async function _onChange(ev) {
    if (ev.target.id !== TOGGLE_ID) return;
    const checkbox = ev.target;
    const projectId = Number(checkbox.dataset.projectId);
    const status = document.getElementById(STATUS_ID);
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    status.textContent = 'Saving…';
    try {
      const res = await fetch('/api/tc/fleet/coordinator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, enabled })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      status.textContent = enabled
        ? 'This project may provision its own sibling fleet.'
        : 'Operator only. Grants self-service fleet provisioning.';
    } catch (err) {
      checkbox.checked = !enabled;
      status.textContent = `Could not save: ${err.message}`;
    } finally {
      checkbox.disabled = false;
    }
  }

  const settingsBody = document.getElementById('settingsBody');
  if (settingsBody) {
    settingsBody.addEventListener('change', _onChange);
    new MutationObserver(() => { _ensureInjected(); }).observe(settingsBody, { childList: true });
  }
})();
