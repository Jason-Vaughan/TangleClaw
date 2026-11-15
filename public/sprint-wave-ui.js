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

  /**
   * A link target, or null: only an absolute `http:`/`https:` URL is ever
   * rendered as an href (#3087, Ruling A761). The data these panels show is
   * written by agents, so anything else (`javascript:`, `data:`, a relative
   * or protocol-relative path) stays plain text.
   * @param {*} value
   * @returns {string|null}
   */
  function _safeHref(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^https?:\/\/[^\s<>"']+$/i.test(trimmed) ? trimmed : null;
  }

  /**
   * The first present field of `obj` among `names`, so a panel reads both a
   * raw store row (snake_case) and a camelCase view-model.
   * @param {object|null|undefined} obj
   * @param {...string} names
   * @returns {*}
   */
  function _field(obj, ...names) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const name of names) {
      if (obj[name] !== undefined && obj[name] !== null) return obj[name];
    }
    return undefined;
  }

  /**
   * Refuse a builder called with its arguments swapped (#3087): these two take
   * the data first and the container second, unlike the board and KPI
   * builders above, so a container passed first is a mistake that would
   * otherwise render an empty panel without a word.
   * @param {*} data
   * @param {string} name
   * @returns {void}
   * @throws {TypeError}
   */
  function _refuseContainerFirst(data, name) {
    if (data && typeof data === 'object' && 'innerHTML' in data) {
      throw new TypeError(`${name}(data, container): the data comes first; a container was passed as the data`);
    }
  }

  /**
   * One escaped `label: value` row, or '' when the value is absent.
   * @param {string} label
   * @param {*} value
   * @returns {string}
   */
  function _row(label, value) {
    if (value === undefined || value === null || value === '') return '';
    const shown = typeof value === 'object' ? JSON.stringify(value) : value;
    return `<div class="sprint-panel-row"><span class="sprint-panel-label">${_escapeHtml(label)}</span>`
      + `<span class="sprint-panel-value">${_escapeHtml(shown)}</span></div>`;
  }

  /**
   * Render the Charter & Gate 0 Readiness panel (#3087, Rulings A760/A761).
   * Every field is optional and every interpolated value is escaped here.
   * @param {{charter?: object, activeVersion?: object, approvals?: object[],
   *   startupSummary?: object, disjointness?: object}} charterData -
   *   `GET /api/v6/projects/:id/charter*` and the disjointness check's shapes.
   * @param {{innerHTML?: string}|null} [container] - A DOM element to write
   *   into, or omit to only get the HTML string back.
   * @returns {string} The rendered HTML.
   */
  function renderCharterReadinessPanel(charterData, container) {
    _refuseContainerFirst(charterData, 'renderCharterReadinessPanel');
    const d = charterData && typeof charterData === 'object' ? charterData : {};
    const charter = d.charter || {};
    const summary = d.startupSummary || {};
    const version = d.activeVersion || {};
    const approvals = Array.isArray(d.approvals) ? d.approvals : [];
    const disjoint = d.disjointness || null;
    const title = _field(summary, 'title') || _field(charter, 'title');
    const approvalItems = approvals.map((a) => {
      const revoked = _field(a, 'revoked_at', 'revokedAt');
      return `<li class="sprint-panel-approval${revoked ? ' is-revoked' : ''}">`
        + `${_escapeHtml(_field(a, 'approver_role', 'approverRole') || 'approver')}: `
        + `${_escapeHtml(_field(a, 'approver_actor', 'approverActor') || '')}`
        + `${revoked ? ' (revoked)' : ''}</li>`;
    }).join('');
    let disjointHtml = '';
    if (disjoint) {
      const ok = disjoint.ok === true || (disjoint.result && disjoint.result.ok === true);
      const conflicts = (disjoint.conflicts || (disjoint.result && disjoint.result.conflicts) || []);
      disjointHtml = `<div class="sprint-panel-disjoint ${ok ? 'is-ok' : 'is-conflict'}">`
        + `${ok ? 'File-disjoint' : `Not disjoint: ${_escapeHtml(Array.isArray(conflicts) ? conflicts.length : 0)} conflict(s)`}</div>`;
    }
    const html = '<section class="sprint-panel sprint-charter-panel">'
      + `<div class="sprint-panel-title">${_escapeHtml(title || 'No active charter')}</div>`
      + _row('Status', _field(charter, 'status'))
      + _row('Version', _field(summary, 'versionNumber') || _field(version, 'version_number', 'versionNumber'))
      + _row('Mission', _field(summary, 'mission'))
      + _row('Constraints', _field(summary, 'activeConstraints'))
      + (approvalItems ? `<ul class="sprint-panel-approvals">${approvalItems}</ul>` : '<div class="sprint-panel-empty">No approvals recorded</div>')
      + disjointHtml
      + '</section>';
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  /**
   * Render the Kaizen & Reports panel (#3087, Rulings A760/A761). Every field
   * is optional and every interpolated value is escaped here; a report link
   * is rendered only for an http(s) URL.
   * @param {{items?: object[], gate0Feed?: object[], reportSummary?: object}} kaizenData -
   *   Kaizen ledger rows (`kaizen_items`), the Gate 0 feed, and a sprint
   *   report summary (`buildNativeSprintReportSummary`).
   * @param {{innerHTML?: string}|null} [container] - A DOM element to write
   *   into, or omit to only get the HTML string back.
   * @returns {string} The rendered HTML.
   */
  function renderKaizenLedgerPanel(kaizenData, container) {
    _refuseContainerFirst(kaizenData, 'renderKaizenLedgerPanel');
    const d = kaizenData && typeof kaizenData === 'object' ? kaizenData : {};
    const items = Array.isArray(d.items) ? d.items : [];
    const feed = Array.isArray(d.gate0Feed) ? d.gate0Feed : [];
    const report = d.reportSummary || null;
    const itemHtml = items.map((it) => (
      `<li class="sprint-kaizen-item" data-state="${_escapeHtml(_field(it, 'lifecycle_state', 'lifecycleState') || '')}">`
      + `<span class="sprint-kaizen-category">${_escapeHtml(_field(it, 'defect_category', 'defectCategory') || '')}</span>`
      + `<span class="sprint-kaizen-cause">${_escapeHtml(_field(it, 'root_cause', 'rootCause') || '')}</span>`
      + `<span class="sprint-kaizen-action">${_escapeHtml(_field(it, 'corrective_action_spec', 'correctiveActionSpec') || '')}</span>`
      + `<span class="sprint-kaizen-state">${_escapeHtml(_field(it, 'lifecycle_state', 'lifecycleState') || '')}</span>`
      + '</li>'
    )).join('');
    const feedHtml = feed.map((f) => (
      `<li class="sprint-kaizen-gate0">${_escapeHtml(_field(f, 'title', 'summary', 'finding_id', 'findingId') || '')}`
      + `${_field(f, 'gate0_disposition', 'gate0Disposition') ? ` (${_escapeHtml(_field(f, 'gate0_disposition', 'gate0Disposition'))})` : ''}</li>`
    )).join('');
    let reportHtml = '';
    if (report) {
      const href = _safeHref(_field(report, 'reportUrl', 'url', 'href'));
      const label = _field(report, 'title', 'version') || 'Sprint report';
      reportHtml = '<div class="sprint-kaizen-report">'
        + (href
          ? `<a href="${_escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${_escapeHtml(label)}</a>`
          : `<span>${_escapeHtml(label)}</span>`)
        + '</div>';
    }
    const html = '<section class="sprint-panel sprint-kaizen-panel">'
      + `<div class="sprint-panel-title">Kaizen ledger (${_escapeHtml(items.length)})</div>`
      + (itemHtml ? `<ul class="sprint-kaizen-items">${itemHtml}</ul>` : '<div class="sprint-panel-empty">No Kaizen items</div>')
      + (feedHtml ? `<ul class="sprint-kaizen-gate0-feed">${feedHtml}</ul>` : '')
      + reportHtml
      + '</section>';
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  const sprintWaveUi = {
    STAGE_ORDER, STAGE_LABELS, renderSprintKpiCards, renderSprintWaveBoard, filterSprintWaveRows,
    renderCharterReadinessPanel, renderKaizenLedgerPanel,
    // The same two builders under the names the v6 workspace modes use (Ruling A774).
    renderSprintCharterRoadmapPanel: renderCharterReadinessPanel,
    renderSprintKaizenReportsPanel: renderKaizenLedgerPanel
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = sprintWaveUi;
  }
  if (global) {
    global.TangleClawSprintWaveUi = sprintWaveUi;
  }
})(typeof window !== 'undefined' ? window : null);
