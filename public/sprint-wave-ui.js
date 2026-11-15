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
   * placed there, then the car progress matrix with each car's six gates
   * (#3088; see {@link carGates}).
   * @param {{innerHTML?: string}|null} container - A DOM element to write
   *   into, or `null`/omit to only get the HTML string back.
   * @param {{waves?: string[][], dispatch?: Object<string, {stage: string, laneName?: (string|null),
   *   openPrNumber?: (number|null), headSha?: string, gates?: object}>}} data -
   *   `GET /api/sprint-waves`'s response shape; `headSha` and `gates` are read when a producer adds them.
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
    const html = `<div class="sprint-wave-board">${columns}</div>${_gateMatrix(data)}`;
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  /** The six governance gates a car passes, in board order (#3088). */
  const GATES = Object.freeze([
    Object.freeze({ key: 'g0', label: 'G0', name: 'Gate 0 (charter & disjointness)' }),
    Object.freeze({ key: 'aGate', label: 'A', name: 'A-Gate (architect, exact head)' }),
    Object.freeze({ key: 'oGate', label: 'O', name: 'O-Gate (independent peer, exact head)' }),
    Object.freeze({ key: 'prr', label: 'PRR', name: 'PRR-Gate (adversarial review)' }),
    Object.freeze({ key: 'ci', label: 'CI', name: 'CI receipt' }),
    Object.freeze({ key: 'iGate', label: 'I', name: 'I-Gate (integrator merge)' })
  ]);

  /** What each gate status is called, and the only statuses a pill can show. */
  const GATE_STATUS_LABELS = Object.freeze({
    pass: 'passed', fail: 'failed', in_progress: 'in progress', pending: 'pending', blocked: 'blocked', unknown: 'unknown'
  });

  /** Spellings producers use for a gate status, each mapped to one the board shows. */
  const GATE_STATUS_ALIASES = Object.freeze({
    pass: 'pass', passed: 'pass', approve: 'pass', approved: 'pass', success: 'pass', green: 'pass', merged: 'pass',
    fail: 'fail', failed: 'fail', failure: 'fail', red: 'fail', hold: 'fail', rejected: 'fail',
    in_progress: 'in_progress', running: 'in_progress', reviewing: 'in_progress',
    pending: 'pending', queued: 'pending', waiting: 'pending',
    blocked: 'blocked', unknown: 'unknown'
  });

  /**
   * What the stage alone says about each gate when nothing records it (PM
   * ruling a79f9e44, mapped onto the stages `syncWaveDispatchState` assigns;
   * the ruling's own stage names are accepted too). Order follows {@link GATES}.
   * A bare `closed` cannot tell a merged car from a cancelled one (the tracker
   * closes a cancelled car's marker issue too), so past Gate 0 it says only
   * `unknown`; the explicit `merged`/`complete` mean all six passed.
   */
  const STAGE_GATES = (() => {
    const all = (s) => GATES.map(() => s);
    const after0 = (rest) => ['pass'].concat(rest);
    const review = after0(['in_progress', 'in_progress', 'in_progress', 'in_progress', 'pending']);
    const building = after0(['pending', 'pending', 'pending', 'pending', 'pending']);
    const stopped = after0(['blocked', 'blocked', 'blocked', 'blocked', 'blocked']);
    const ended = after0(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    const table = {
      closed: ended, complete: all('pass'), merged: all('pass'),
      'in-review': review, review, in_review: review, gating: review,
      'in-progress': building, claimed: building, unassigned: building,
      active: building, building, running: building, planned: building, queued: building,
      blocked: stopped, failed: stopped, cancelled: stopped
    };
    return Object.freeze(table);
  })();

  /**
   * A gate status as one the board shows, or null when it names none.
   * @param {*} value
   * @returns {string|null}
   */
  function _gateStatus(value) {
    if (typeof value !== 'string') return null;
    const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return Object.prototype.hasOwnProperty.call(GATE_STATUS_ALIASES, key) ? GATE_STATUS_ALIASES[key] : null;
  }

  /**
   * A commit SHA's first 8 characters, or null for anything that is not a
   * 7- to 40-character hex SHA (so nothing else is ever shown as one).
   * @param {*} value
   * @returns {string|null}
   */
  function _shortSha(value) {
    return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim()) ? value.trim().slice(0, 8).toLowerCase() : null;
  }

  /**
   * A car's six gates (#3088, Rulings A782 and PM a79f9e44). A gate the row
   * records (`row.gates[key]`, a status or `{status, sha, token}`) is shown as
   * recorded; otherwise the stage's inference is shown, marked as inferred and
   * never with a SHA; with neither, the gate is unknown. A recorded gate bound
   * to a different SHA from the car's head is marked stale.
   * @param {{stage?: string, gates?: object, headSha?: string, exactHead?: string}} row
   * @returns {Array<{key: string, label: string, name: string, status: string,
   *   source: ('recorded'|'stage'|'unknown'), sha: (string|null), token: (string|null), stale: boolean}>}
   */
  function carGates(row) {
    const r = row && typeof row === 'object' ? row : {};
    const gates = r.gates && typeof r.gates === 'object' ? r.gates : {};
    const stage = typeof r.stage === 'string' ? r.stage : '';
    const inferred = Object.prototype.hasOwnProperty.call(STAGE_GATES, stage) ? STAGE_GATES[stage] : null;
    const head = _shortSha(r.headSha) || _shortSha(r.exactHead);
    return GATES.map((gate, i) => {
      const raw = Object.prototype.hasOwnProperty.call(gates, gate.key) ? gates[gate.key] : undefined;
      const entry = raw && typeof raw === 'object' ? raw : { status: raw };
      const recorded = _gateStatus(entry.status);
      if (recorded) {
        const sha = _shortSha(entry.sha);
        const token = typeof entry.token === 'string' && entry.token.trim() ? entry.token.trim() : null;
        const stale = Boolean(sha && head && !sha.startsWith(head) && !head.startsWith(sha));
        return { key: gate.key, label: gate.label, name: gate.name, status: recorded, source: 'recorded', sha, token, stale };
      }
      if (inferred) return { key: gate.key, label: gate.label, name: gate.name, status: inferred[i], source: 'stage', sha: null, token: null, stale: false };
      return { key: gate.key, label: gate.label, name: gate.name, status: 'unknown', source: 'unknown', sha: null, token: null, stale: false };
    });
  }

  /**
   * One gate pill: its short label, coloured by status, with a tip naming
   * the gate, its status, where that status came from, and any SHA or token.
   * It is `role="img"` so a screen reader announces that tip as its name, not
   * just the label (the status is otherwise only colour and border).
   * @param {ReturnType<typeof carGates>[number]} gate
   * @returns {string}
   */
  function _gatePill(gate) {
    const from = gate.source === 'stage' ? ' (from stage)' : gate.source === 'unknown' ? ' (not recorded)' : '';
    const tip = `${gate.name}: ${GATE_STATUS_LABELS[gate.status]}${from}`
      + (gate.sha ? ` @ ${gate.sha}` : '') + (gate.token ? ` · ${gate.token}` : '')
      + (gate.stale ? ' — bound to a different head' : '');
    return `<span class="sprint-gate-pill is-${gate.status}${gate.source === 'stage' ? ' is-inferred' : ''}${gate.stale ? ' is-stale' : ''}"`
      + ` role="img" title="${_escapeHtml(tip)}" aria-label="${_escapeHtml(tip)}">${_escapeHtml(gate.label)}</span>`;
  }

  /**
   * The car progress matrix (#3088): one row per car, grouped by wave when
   * the run lists its waves, with its lane, PR, head SHA and six gate pills.
   * @param {{waves?: Array, dispatch?: object}} data
   * @returns {string}
   */
  function _gateMatrix(data) {
    const dispatch = (data && data.dispatch && typeof data.dispatch === 'object') ? data.dispatch : {};
    const ids = Object.keys(dispatch);
    if (!ids.length) return '';
    const waves = Array.isArray(data.waves) ? data.waves.filter(Array.isArray) : [];
    const placed = new Set();
    const groups = waves.map((wave, i) => {
      const cars = wave.filter((id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(dispatch, id) && !placed.has(id));
      cars.forEach((id) => placed.add(id));
      return { title: `Wave ${i + 1}`, cars };
    }).filter((g) => g.cars.length);
    const rest = ids.filter((id) => !placed.has(id));
    if (rest.length) groups.push({ title: groups.length ? 'Not in a wave' : null, cars: rest });
    const header = GATES.map((g) => `<th scope="col" title="${_escapeHtml(g.name)}">${_escapeHtml(g.label)}</th>`).join('');
    const rows = groups.map((group) => (
      (group.title ? `<tr class="sprint-gate-wave"><th scope="rowgroup" colspan="${4 + GATES.length}">${_escapeHtml(group.title)}</th></tr>` : '')
      + group.cars.map((id) => {
        const row = dispatch[id] || {};
        const head = _shortSha(row.headSha) || _shortSha(row.exactHead);
        const gates = carGates(row);
        return `<tr class="sprint-gate-row" data-car-id="${_escapeHtml(id)}">`
          + `<th scope="row" class="sprint-gate-car">${_escapeHtml(id)}</th>`
          + `<td class="sprint-gate-lane">${_escapeHtml(row.laneName || '—')}</td>`
          + `<td class="sprint-gate-pr">${row.openPrNumber !== null && row.openPrNumber !== undefined ? `#${_escapeHtml(row.openPrNumber)}` : '—'}</td>`
          + `<td class="sprint-gate-head">${head ? `<code>${_escapeHtml(head)}</code>` : '—'}</td>`
          + gates.map((g) => `<td class="sprint-gate-cell">${_gatePill(g)}</td>`).join('')
          + '</tr>';
      }).join('')
    )).join('');
    return `<table class="sprint-gate-matrix"><caption>Cars and their gates</caption>`
      + `<thead><tr><th scope="col">Car</th><th scope="col">Lane</th><th scope="col">PR</th><th scope="col">Head</th>${header}</tr></thead>`
      + `<tbody>${rows}</tbody></table>`;
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
    STAGE_ORDER, STAGE_LABELS, GATES, renderSprintKpiCards, renderSprintWaveBoard, filterSprintWaveRows, carGates,
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
