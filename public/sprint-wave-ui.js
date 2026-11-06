'use strict';
/* ── TangleClaw — Native Sprint Wave Board UI Helpers (#2644) ── */
/* Pure view-model/HTML builders over lib/native-sprint-tracker.js's shapes  */
/* (GET /api/sprint-waves' {waves, dispatch}, buildNativeSprintReportSummary's */
/* heroKpis). Every render* function RETURNS the HTML string it built and    */
/* only ALSO writes it into `container.innerHTML` when a container with that */
/* property was passed, so this file runs unchanged in a browser or under    */
/* plain Node (`require`), with no DOM and no other global required.        */
/* Mounting this onto the real dashboard/reports pages is separately tracked */
/* work; this module is what that mount will call unchanged.                */

(function (global) {
  /** Dispatch stages, in the column order the board renders them. */
  const STAGE_ORDER = ['unassigned', 'claimed', 'in-progress', 'in-review', 'blocked', 'closed'];

  /** Display label for each dispatch stage. */
  const STAGE_LABELS = {
    unassigned: 'Unassigned',
    claimed: 'Claimed',
    'in-progress': 'In Progress',
    'in-review': 'In Review',
    blocked: 'Blocked',
    closed: 'Closed'
  };

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /**
   * Escape a value for safe inclusion in HTML text/attribute content.
   * `null`/`undefined` become `''` rather than the literal string "null".
   * @param {*} value
   * @returns {string}
   */
  function _escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  /**
   * Render the 8 Hero KPI cards from a sprint report's `heroKpis`
   * (`lib/native-sprint-tracker.js#buildNativeSprintReportSummary`).
   * @param {{innerHTML?: string}|null} container - A DOM element to write
   *   into, or `null`/omit to only get the HTML string back.
   * @param {{issuesClosed?: number, builderPRs?: number, waves?: number,
   *   fileCollisions?: number, reviewRounds?: number, cycleTimeHours?: (number|null),
   *   netLOC?: number, releaseCommit?: (string|null)}} kpis
   * @returns {string} The rendered HTML.
   */
  function renderSprintKpiCards(container, kpis) {
    const k = kpis || {};
    const cards = [
      { label: 'Issues Closed', value: k.issuesClosed },
      { label: 'Builder PRs', value: k.builderPRs },
      { label: 'Waves', value: k.waves },
      { label: 'File Collisions', value: k.fileCollisions },
      { label: 'Review Rounds', value: k.reviewRounds },
      { label: 'Cycle Time (h)', value: k.cycleTimeHours },
      { label: 'Net LOC', value: k.netLOC },
      { label: 'Release Commit', value: k.releaseCommit }
    ];
    const html = `<div class="sprint-kpi-row">${cards.map((card) => (
      `<div class="sprint-kpi-card"><div class="sprint-kpi-label">${_escapeHtml(card.label)}</div>`
      + `<div class="sprint-kpi-value">${_escapeHtml(card.value === null || card.value === undefined ? '—' : card.value)}</div></div>`
    )).join('')}</div>`;
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  /**
   * Render the sprint wave board: one column per dispatch stage, each
   * holding the cars `lib/native-sprint-tracker.js#syncWaveDispatchState`
   * placed there.
   * @param {{innerHTML?: string}|null} container - A DOM element to write
   *   into, or `null`/omit to only get the HTML string back.
   * @param {{dispatch?: Object<string, {stage: string, laneName?: (string|null),
   *   openPrNumber?: (number|null)}>}} data - `GET /api/sprint-waves`'s response shape.
   * @returns {string} The rendered HTML.
   */
  function renderSprintWaveBoard(container, data) {
    const dispatch = (data && data.dispatch) || {};
    const rows = Object.keys(dispatch).map((carId) => Object.assign({ carId }, dispatch[carId]));
    const columns = STAGE_ORDER.map((stage) => {
      const rowsInStage = rows.filter((row) => row.stage === stage);
      const items = rowsInStage.map((row) => (
        `<li class="sprint-wave-card" data-car-id="${_escapeHtml(row.carId)}">`
        + `<span class="sprint-wave-car-id">${_escapeHtml(row.carId)}</span>`
        + (row.laneName ? `<span class="sprint-wave-lane">${_escapeHtml(row.laneName)}</span>` : '')
        + (row.openPrNumber !== null && row.openPrNumber !== undefined
          ? `<span class="sprint-wave-pr">#${_escapeHtml(row.openPrNumber)}</span>` : '')
        + '</li>'
      )).join('');
      return (
        `<div class="sprint-wave-column" data-stage="${_escapeHtml(stage)}">`
        + `<div class="sprint-wave-column-title">${_escapeHtml(STAGE_LABELS[stage] || stage)} (${rowsInStage.length})</div>`
        + `<ul class="sprint-wave-column-list">${items}</ul></div>`
      );
    }).join('');
    const html = `<div class="sprint-wave-board">${columns}</div>`;
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  /**
   * Filter the board's flattened `{carId, stage, laneName, openPrNumber}`
   * rows by stage, lane name, and/or a case-insensitive substring search
   * over the car id and lane name. Pure: returns a new array, never
   * mutates `rows`.
   * @param {Array<{carId: string, stage: string, laneName?: (string|null)}>} rows
   * @param {{stage?: string, laneName?: string, search?: string}} [filter]
   * @returns {Array<object>}
   */
  function filterSprintWaveRows(rows, filter) {
    const list = Array.isArray(rows) ? rows : [];
    const f = filter || {};
    const search = typeof f.search === 'string' ? f.search.trim().toLowerCase() : '';
    return list.filter((row) => {
      if (!row) return false;
      if (f.stage && row.stage !== f.stage) return false;
      if (f.laneName && row.laneName !== f.laneName) return false;
      if (search) {
        const haystack = `${row.carId || ''} ${row.laneName || ''}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  const sprintWaveUi = {
    STAGE_ORDER, STAGE_LABELS, renderSprintKpiCards, renderSprintWaveBoard, filterSprintWaveRows
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = sprintWaveUi;
  }
  if (global) {
    global.TangleClawSprintWaveUi = sprintWaveUi;
  }
})(typeof window !== 'undefined' ? window : null);
