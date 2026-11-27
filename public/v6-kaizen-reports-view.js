'use strict';

/**
 * v6 (#3266, V6-017/V6-034, Car V665-W1-B): the Kaizen & Reports workspace
 * tab's primary in-product view — pure markup generators for the version
 * picker, a report's settled post-mortem content, and Kaizen ledger items,
 * reading from the single canonical sources this repo already has:
 * `lib/native-sprint-tracker.js#parseSprintReportSettlement`'s result
 * shape for report content, and `kaizen_items`' own row shape
 * (`lib/v6/e5-kaizen-ledger.js`) for ledger items.
 *
 * NOT YET WIRED INTO THE LIVE PAGE, the same reason
 * `public/v6-uth-filter.js` (#3261, Car V662-W1-B) isn't: doing that needs
 * a `public/index.html` `<script>` tag and updating
 * `public/v6-shell.js`'s actual Kaizen & Reports tab render path, which —
 * per `test/v6-b1-ui-shell.test.js`'s own sandbox loader only ever loading
 * `v6-shell.js`'s own source — would need that out-of-scope test file
 * updated too, or every existing test exercising that tab starts failing
 * with "not a function". A future car that owns both can wire this module
 * in; until then it exists as a real, tested, documented reference.
 *
 * Zero-dependency, no jsdom (this repo's own convention): every dynamic
 * value is run through {@link escapeHtml} before it reaches a template
 * string.
 *
 * @module public/v6-kaizen-reports-view
 */

(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    factory(global);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (attachTo) {
  /**
   * Escape a value for safe interpolation into an HTML template string.
   * `null`/`undefined` become `''`, never the literal text "null"/"undefined".
   * @param {*} value
   * @returns {string}
   */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** What each Kaizen catalog entry's `kind` renders as. */
  const CATALOG_KIND_LABELS = Object.freeze({ report: 'Sprint Report', retrospective: 'Train Retrospective' });

  /**
   * The version/train picker dropdown: one `<option>` per catalog entry
   * (the same `{id, version, title, url, kind}` shape
   * `lib/native-sprint-tracker.js`'s own `_normalizeReportsCatalog`
   * produces), the selected one marked.
   * @param {Array<{id: string, version: (string|null), title: string, url: (string|null), kind: string}>} catalog
   * @param {string|null} [selectedId]
   * @returns {string} HTML.
   */
  function versionPickerMarkup(catalog, selectedId) {
    const list = Array.isArray(catalog) ? catalog : [];
    if (!list.length) return '<p class="v6-kaizen-picker-empty">No sprint reports are published yet.</p>';
    const options = list.map((entry) => {
      const label = CATALOG_KIND_LABELS[entry.kind] || CATALOG_KIND_LABELS.report;
      const selected = selectedId != null && String(selectedId) === String(entry.id) ? ' selected' : '';
      return `<option value="${escapeHtml(entry.id)}"${selected}>${escapeHtml(entry.title)} (${label})</option>`;
    }).join('');
    return `<label class="v6-kaizen-picker-label">Sprint report / train retrospective
      <select id="v6KaizenReportPicker" class="filter-input v6-kaizen-picker" aria-label="Choose a sprint report or train retrospective to view">${options}</select>
    </label>`;
  }

  /**
   * A settled report's post-mortem content — the exact result shape
   * {@link module:lib/native-sprint-tracker.parseSprintReportSettlement}
   * returns — or a clear placeholder when the report has not settled yet,
   * or none was found at all. Mirrors `lib/sprint-report-gate.js#evaluateReportGate`'s
   * own three outcomes so the viewer and the Gate 4 policy never disagree
   * about what state a report is in.
   * @param {{passed: boolean, reason: string, settlement: (object|null)}|null} gateResult -
   *   `evaluateReportGate`'s own return shape, or `null` when nothing has been evaluated yet.
   * @returns {string} HTML.
   */
  function reportContentMarkup(gateResult) {
    if (!gateResult) return '<p class="v6-kaizen-report-empty">Choose a report above to view it.</p>';
    // `evaluateReportGate` calls the real settlement parser whenever a
    // report was supplied at all, whether or not it turns out settled --
    // `settlement` is only ever `null` for "no report found," "not
    // mandatory," or "an operator exception applied" (none of which parsed
    // anything). An UNSETTLED report still carries a real settlement
    // object (`settled: false`), so both cases must show the gate's own
    // reason, not just the `settlement === null` one.
    if (!gateResult.settlement || !gateResult.settlement.settled) {
      return `<p class="v6-kaizen-report-unsettled">${escapeHtml(gateResult.reason)}</p>`;
    }
    const { whatWorked, whatDidnt, rule283PassCount } = gateResult.settlement.postMortem;
    const list = (items, emptyText) => (items.length
      ? `<ul>${items.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : `<p class="v6-kaizen-report-empty">${escapeHtml(emptyText)}</p>`);
    return `<section class="v6-kaizen-report-content">
      <h3>What worked</h3>${list(whatWorked, 'Nothing recorded.')}
      <h3>What didn't</h3>${list(whatDidnt, 'Nothing recorded.')}
      <p class="v6-kaizen-report-rule283">Rule #283: ${rule283PassCount} passing</p>
    </section>`;
  }

  /** What each Kaizen ledger `lifecycle_state` renders as a CSS modifier (kebab-case, lower-cased). */
  function _lifecycleModifier(state) {
    return String(state || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';
  }

  /**
   * One Kaizen ledger item (`kaizen_items`' own row shape,
   * `lib/v6/e5-kaizen-ledger.js`), as a summary card.
   * @param {{id: string, origin_sprint: string, finding_id: string, defect_category: string,
   *   corrective_action_spec: string, owner_role: string, lifecycle_state: string,
   *   effectiveness_status: string, linked_issue_id: (string|number|null)}} item
   * @returns {string} HTML.
   */
  function kaizenItemMarkup(item) {
    const modifier = _lifecycleModifier(item.lifecycle_state);
    const issue = item.linked_issue_id != null ? `<span class="v6-kaizen-item-issue">#${escapeHtml(item.linked_issue_id)}</span>` : '';
    return `<li class="v6-kaizen-item is-${modifier}" data-kaizen-id="${escapeHtml(item.id)}">
      <span class="v6-kaizen-item-category">${escapeHtml(item.defect_category)}</span>
      <span class="v6-kaizen-item-state">${escapeHtml(item.lifecycle_state)}</span>
      ${issue}
      <p class="v6-kaizen-item-action">${escapeHtml(item.corrective_action_spec)}</p>
      <p class="v6-kaizen-item-meta">Origin: ${escapeHtml(item.origin_sprint)} (${escapeHtml(item.finding_id)}) — Owner: ${escapeHtml(item.owner_role)} — Effectiveness: ${escapeHtml(item.effectiveness_status)}</p>
    </li>`;
  }

  /**
   * The Kaizen ledger panel: one card per item, newest first (the caller's
   * own job to sort — this renders whatever order it is given).
   * @param {object[]} items - `kaizen_items` rows.
   * @returns {string} HTML.
   */
  function kaizenLedgerMarkup(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '<p class="v6-kaizen-ledger-empty">No Kaizen items recorded.</p>';
    return `<ul class="v6-kaizen-ledger-list">${list.map(kaizenItemMarkup).join('')}</ul>`;
  }

  const exported = {
    escapeHtml, CATALOG_KIND_LABELS, versionPickerMarkup, reportContentMarkup, kaizenItemMarkup, kaizenLedgerMarkup
  };
  if (attachTo) attachTo.tcV6KaizenReportsView = exported;
  return exported;
});
