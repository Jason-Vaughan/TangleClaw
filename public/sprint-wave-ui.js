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

  /**
   * The published public SSOT roadmap site (#3134) — a fixed, known URL,
   * not something any producer needs to supply.
   * @type {string}
   */
  const PUBLIC_SSOT_URL = 'https://jason-vaughan.github.io/TangleClaw/';

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
   *   openPrNumber?: (number|null), prUrl?: string, headSha?: string, gates?: object, pill?: object,
   *   files?: string[], reviewers?: object, issues?: object[], merged?: boolean}>}} data -
   *   `GET /api/sprint-waves`'s response shape; `headSha`/`gates` are read when a producer adds
   *   them, and `pill`/`files`/`reviewers`/`issues` the same way (#3112,
   *   `lib/native-sprint-tracker.js#syncWaveDispatchState` already adds `pill` to every row and
   *   the rest when the underlying car carries them, with zero change needed here or in
   *   `public/v6-shell.js`, which passes this whole response straight through).
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
        // #3138: a literal separator between adjacent fields, so they never
        // mash together ("V650-W1-ATC-Lane-DCompleted") regardless of
        // whether CSS for this card has landed yet.
        + (row.laneName ? ` · <span class="sprint-wave-lane">${_escapeHtml(row.laneName)}</span>` : '')
        + (row.openPrNumber !== null && row.openPrNumber !== undefined
          ? ` · ${row.prUrl ? `<a class="sprint-wave-pr" href="${_escapeHtml(row.prUrl)}" target="_blank" rel="noopener noreferrer">#${_escapeHtml(row.openPrNumber)}</a>`
            : `<span class="sprint-wave-pr">#${_escapeHtml(row.openPrNumber)}</span>`}` : '')
        + (row.pill ? ` ${_sixStagePillBadge(row.pill)}` : '')
        + '</li>'
      )).join('');
      return (
        `<div class="sprint-wave-column" data-stage="${_escapeHtml(stage)}">`
        + `<div class="sprint-wave-column-title">${_escapeHtml(STAGE_LABELS[stage] || stage)} (${rowsInStage.length})</div>`
        + `<ul class="sprint-wave-column-list">${items}</ul></div>`
      );
    }).join('');
    // #3138: used to also append `renderSprintCarCards` here for any row
    // carrying files/reviewers/issues (#3112) -- one of the three duplicate
    // car listings the Sprint & Cars panel reported. Dropped: the gate
    // matrix below is a separate, test-locked contract this file cannot
    // change, so the fix removes THIS listing rather than that one.
    // `renderSprintCarCards` stays exported for a caller that wants the
    // richer per-car detail view on its own.
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
   * @param {{stage?: string, gates?: object, headSha?: string, exactHead?: string, merged?: boolean}} row -
   *   `merged: true` (#3138, `lib/native-sprint-tracker.js#syncWaveDispatchState`'s own
   *   signal) on a `closed` row reads its stage-inference as `merged` -- all six passed --
   *   instead of the deliberately pessimistic bare `closed`; omit/false, or any other
   *   stage, is unaffected.
   * @returns {Array<{key: string, label: string, name: string, status: string,
   *   source: ('recorded'|'stage'|'unknown'), sha: (string|null), token: (string|null), stale: boolean}>}
   */
  function carGates(row) {
    const r = row && typeof row === 'object' ? row : {};
    const gates = r.gates && typeof r.gates === 'object' ? r.gates : {};
    const stage = typeof r.stage === 'string' ? r.stage : '';
    const inferenceStage = (stage === 'closed' && r.merged === true) ? 'merged' : stage;
    const inferred = Object.prototype.hasOwnProperty.call(STAGE_GATES, inferenceStage) ? STAGE_GATES[inferenceStage] : null;
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
          // #3138 (PRR-A R1): a clickable link when `row.prUrl` is known,
          // else the exact original plain-text cell -- `row.prUrl` is a new,
          // optional field, so a row without one (every existing caller,
          // and every fixture in test/v6-b1-ui-shell.test.js) renders
          // byte-identically to before.
          + `<td class="sprint-gate-pr">${row.openPrNumber !== null && row.openPrNumber !== undefined
            ? (row.prUrl ? `<a href="${_escapeHtml(row.prUrl)}" target="_blank" rel="noopener noreferrer">#${_escapeHtml(row.openPrNumber)}</a>` : `#${_escapeHtml(row.openPrNumber)}`)
            : '—'}</td>`
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
   *   startupSummary?: object, disjointness?: object, roadmapSnapshot?: object}} charterData -
   *   `GET /api/v6/projects/:id/charter*` and the disjointness check's shapes, plus (#3112,
   *   PRR-B I-Gate R1 BLOCKING 2) an optional `roadmapSnapshot`
   *   (`lib/native-sprint-tracker.js#buildSprintWaveSnapshot`'s own return shape) -- NOT yet
   *   something `public/v6-shell.js`'s charter panel call site supplies (it passes exactly
   *   `{charter, activeVersion, startupSummary, approvals}` today), so this composes the
   *   Release-First Roadmap only once a caller starts passing one.
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
    const roadmapSnapshot = d.roadmapSnapshot && typeof d.roadmapSnapshot === 'object' ? d.roadmapSnapshot : null;
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
      + '</section>'
      + (roadmapSnapshot ? renderReleaseRoadmap(roadmapSnapshot) : '');
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  /**
   * Render the Kaizen & Reports panel (#3087, Rulings A760/A761). Every field
   * is optional and every interpolated value is escaped here; a report link
   * is rendered only for an http(s) URL.
   * @param {{items?: object[], gate0Feed?: object[], reportSummary?: object,
   *   heroKpis?: object, reports?: object[]}} kaizenData -
   *   Kaizen ledger rows (`kaizen_items`), the Gate 0 feed, and a sprint
   *   report summary (`buildNativeSprintReportSummary`) -- OR, since
   *   `public/v6-shell.js`'s `workspacePanelContent('kaizen', ...)` already
   *   passes `data.report || data` straight through, `heroKpis` and
   *   `reports` directly from {@link module:lib/native-sprint-tracker.buildNativeSprintReportSummary}'s
   *   own return shape (#3112, PRR-B I-Gate R1 BLOCKING 2) -- composed with,
   *   never replacing, the ledger/feed/single-report rendering above.
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
    const heroKpis = d.heroKpis && typeof d.heroKpis === 'object' ? d.heroKpis : null;
    const reportsCatalog = Array.isArray(d.reports) && d.reports.length ? d.reports : null;
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
      + (heroKpis ? renderSprintKpiCards(null, heroKpis) : '')
      + (itemHtml ? `<ul class="sprint-kaizen-items">${itemHtml}</ul>` : '<div class="sprint-panel-empty">No Kaizen items</div>')
      + (feedHtml ? `<ul class="sprint-kaizen-gate0-feed">${feedHtml}</ul>` : '')
      + reportHtml
      + (reportsCatalog ? renderSprintReportsCatalog({ reports: reportsCatalog }) : '')
      + '</section>';
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  /**
   * One 6-stage pill badge (#3112): `lib/native-sprint-tracker.js#sixStagePill`'s
   * `{code, label}`, rendered the same visual language as {@link _gatePill}'s
   * gate pills but under its own class so the two never collide in CSS.
   * @param {{code?: string, label?: string}|null|undefined} pill
   * @returns {string}
   */
  function _sixStagePillBadge(pill) {
    const p = pill && typeof pill === 'object' ? pill : {};
    const code = typeof p.code === 'string' && p.code ? p.code : 'open';
    const label = typeof p.label === 'string' && p.label ? p.label : (STAGE_LABELS[code] || code);
    return `<span class="sprint-stage-pill is-${_escapeHtml(code)}">${_escapeHtml(label)}</span>`;
  }

  /**
   * One file-scope tag list, each file its own escaped `<code>` chip.
   * @param {string[]|null|undefined} files
   * @returns {string}
   */
  function _fileScopeTags(files) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return '';
    return `<ul class="sprint-file-scope">${list.map((f) => `<li><code>${_escapeHtml(f)}</code></li>`).join('')}</ul>`;
  }

  /**
   * The Release-First Roadmap (#3112): a summary metrics bar, then one
   * expandable `<details>` card per release group (Active, Planned, Shipped)
   * holding that release's own workstream/car table — each car's issues
   * shown with their 6-stage pill, prerequisites (`dependsOn`) and summary.
   * Renders below wherever the caller already draws the active Project
   * Charter & role sign-offs ({@link renderCharterReadinessPanel}) and above
   * wherever it already draws Train Launch controls (`public/v6-shell.js`'s
   * own `tcV6TrainResultMarkup`/charter panel controls) — neither is
   * duplicated here.
   * @param {{releases?: {active?: object[], planned?: object[], shipped?: object[]},
   *   summary?: {plannedVersions?: number, releasedVersions?: number,
   *   activeSprintProgress?: {closed?: number, total?: number, pct?: number},
   *   scheduledItems?: number}, cars?: Array<{id: string, version?: (string|null),
   *   lane?: (string|null), pill?: object, issues?: object[]}>}} snapshotData -
   *   `lib/native-sprint-tracker.js#buildSprintWaveSnapshot`'s own return shape.
   * @param {{innerHTML?: string}|null} [container] - A DOM element to write
   *   into, or omit to only get the HTML string back.
   * @returns {string} The rendered HTML.
   */
  function renderReleaseRoadmap(snapshotData, container) {
    _refuseContainerFirst(snapshotData, 'renderReleaseRoadmap');
    const d = snapshotData && typeof snapshotData === 'object' ? snapshotData : {};
    const releases = d.releases && typeof d.releases === 'object' ? d.releases : {};
    const summary = d.summary && typeof d.summary === 'object' ? d.summary : {};
    const progress = summary.activeSprintProgress && typeof summary.activeSprintProgress === 'object' ? summary.activeSprintProgress : {};
    const cars = Array.isArray(d.cars) ? d.cars : [];

    const metrics = [
      { label: 'Planned versions', value: summary.plannedVersions },
      { label: 'Released versions', value: summary.releasedVersions },
      { label: 'Active sprint progress', value: `${progress.closed === undefined ? '—' : progress.closed}/${progress.total === undefined ? '—' : progress.total} (${progress.pct === undefined ? '—' : progress.pct}%)` },
      { label: 'Scheduled items', value: summary.scheduledItems }
    ];
    const metricsBar = `<div class="sprint-roadmap-metrics">${metrics.map((m) => (
      `<div class="sprint-roadmap-metric"><div class="sprint-roadmap-metric-label">${_escapeHtml(m.label)}</div>`
      + `<div class="sprint-roadmap-metric-value">${_escapeHtml(m.value === null || m.value === undefined ? '—' : m.value)}</div></div>`
    )).join('')}</div>`;

    const carTable = (version) => {
      const versionCars = cars.filter((c) => c && c.version === version);
      if (!versionCars.length) return '<p class="sprint-panel-empty">No cars scheduled yet.</p>';
      const rows = versionCars.map((car) => {
        const issueRows = (Array.isArray(car.issues) ? car.issues : []).map((issue) => (
          `<tr class="sprint-roadmap-issue-row" data-issue-id="${_escapeHtml(issue && issue.id)}">`
          + `<td class="sprint-roadmap-issue-id">#${_escapeHtml(issue && issue.id)}</td>`
          + `<td class="sprint-roadmap-issue-pill">${_sixStagePillBadge(issue && issue.pill)}</td>`
          + `<td class="sprint-roadmap-issue-prereqs">${(issue && Array.isArray(issue.dependsOn) ? issue.dependsOn : []).map((p) => `<code>${_escapeHtml(p)}</code>`).join(', ') || '—'}</td>`
          + `<td class="sprint-roadmap-issue-summary">${_escapeHtml((issue && (issue.summary || issue.title)) || '—')}</td>`
          + '</tr>'
        )).join('');
        return `<tr class="sprint-roadmap-car-row" data-car-id="${_escapeHtml(car.id)}">`
          + `<th scope="row" class="sprint-roadmap-car-id">${_escapeHtml(car.id)}</th>`
          + `<td class="sprint-roadmap-car-lane">${_escapeHtml(car.lane || '—')}</td>`
          + `<td class="sprint-roadmap-car-pill">${_sixStagePillBadge(car.pill)}</td>`
          + `</tr>${issueRows}`;
      }).join('');
      return `<table class="sprint-roadmap-car-table"><thead><tr><th scope="col">Car</th><th scope="col">Lane</th>`
        + `<th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table>`;
    };

    const releaseCard = (release, open) => (
      `<details class="sprint-roadmap-release"${open ? ' open' : ''} data-version="${_escapeHtml(release.version)}">`
      + `<summary>${_escapeHtml(release.version)} (${_escapeHtml(release.carCount === undefined ? 0 : release.carCount)} car${release.carCount === 1 ? '' : 's'})</summary>`
      + carTable(release.version) + '</details>'
    );

    const group = (title, list, open) => {
      const items = Array.isArray(list) ? list : [];
      if (!items.length) return '';
      return `<section class="sprint-roadmap-group" aria-label="${_escapeHtml(title)}">`
        + `<h3 class="sprint-roadmap-group-title">${_escapeHtml(title)}</h3>`
        + items.map((r) => releaseCard(r, open)).join('') + '</section>';
    };

    const groupsHtml = group('Current Active Sprint', releases.active, true)
      + group('Upcoming Planned Releases', releases.planned, false)
      + group('Released Versions', releases.shipped, false);

    const html = '<section class="sprint-roadmap-panel" aria-label="Release-First Roadmap">'
      + '<h2 class="sprint-roadmap-title">Release-First Roadmap</h2>'
      + `<p class="sprint-roadmap-public-ssot"><a href="${PUBLIC_SSOT_URL}" target="_blank" rel="noopener noreferrer">🌐 Public SSOT Roadmap ↗</a></p>`
      + metricsBar
      + (groupsHtml || '<p class="sprint-panel-empty">No releases to show yet.</p>')
      + '</section>';
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  /**
   * Live Wave & Car execution cards (#3112), for `🚂 Sprint & Cars`: one card
   * per car with its assigned Builder lane, O-Gate/PRR reviewers, 6-stage
   * pill (car-level and per-issue), the six governance gate badges ({@link
   * carGates}/{@link _gatePill} — the same gate machinery {@link
   * renderSprintWaveBoard}'s matrix already uses, not a second one), and its
   * disjoint file-scope tags.
   * @param {{cars?: Array<{id: string, lane?: (string|null),
   *   reviewers?: {oGate?: string, prr?: string}, files?: string[],
   *   prNumber?: (number|null), prUrl?: string, pill?: object, issues?: object[]}>}} snapshotData -
   *   `lib/native-sprint-tracker.js#buildSprintWaveSnapshot`'s own return shape.
   * @param {{innerHTML?: string}|null} [container] - A DOM element to write
   *   into, or omit to only get the HTML string back.
   * @returns {string} The rendered HTML.
   */
  function renderSprintCarCards(snapshotData, container) {
    _refuseContainerFirst(snapshotData, 'renderSprintCarCards');
    const d = snapshotData && typeof snapshotData === 'object' ? snapshotData : {};
    const cars = Array.isArray(d.cars) ? d.cars : [];
    if (!cars.length) {
      const html = '<p class="sprint-panel-empty">No cars dispatched yet.</p>';
      if (container && typeof container === 'object') container.innerHTML = html;
      return html;
    }
    const cards = cars.map((car) => {
      const reviewers = car.reviewers && typeof car.reviewers === 'object' ? car.reviewers : {};
      // #3138 (PRR-A R1): merged/headSha threaded through so a completed car
      // reads all-pass gates here too, not just in the stage board/matrix.
      const gates = carGates({ stage: _pillToStage(car.pill), merged: car.merged, headSha: car.headSha });
      const issuePills = (Array.isArray(car.issues) ? car.issues : [])
        .map((issue) => `<li class="sprint-car-issue" data-issue-id="${_escapeHtml(issue && issue.id)}">`
          + `<span class="sprint-car-issue-id">#${_escapeHtml(issue && issue.id)}</span>${_sixStagePillBadge(issue && issue.pill)}</li>`)
        .join('');
      // #3138: a literal separator between adjacent fields, so they never
      // mash together, regardless of whether CSS for this card has landed yet.
      const prField = car.prNumber !== null && car.prNumber !== undefined
        ? (car.prUrl ? `<a class="sprint-car-pr" href="${_escapeHtml(car.prUrl)}" target="_blank" rel="noopener noreferrer">#${_escapeHtml(car.prNumber)}</a>`
          : `<span class="sprint-car-pr">#${_escapeHtml(car.prNumber)}</span>`)
        : '';
      const metaFields = [
        car.lane ? `<span class="sprint-car-lane">Builder: ${_escapeHtml(car.lane)}</span>` : '',
        reviewers.oGate ? `<span class="sprint-car-ogate">O-Gate: ${_escapeHtml(reviewers.oGate)}</span>` : '',
        reviewers.prr ? `<span class="sprint-car-prr">PRR: ${_escapeHtml(reviewers.prr)}</span>` : '',
        prField
      ].filter(Boolean);
      return `<article class="sprint-car-card" data-car-id="${_escapeHtml(car.id)}">`
        + `<header class="sprint-car-card-header"><span class="sprint-car-id">${_escapeHtml(car.id)}</span> ${_sixStagePillBadge(car.pill)}</header>`
        + `<div class="sprint-car-meta">${metaFields.join(' · ')}</div>`
        + `<div class="sprint-car-gates">${gates.map((g) => `<span class="sprint-gate-cell">${_gatePill(g)}</span>`).join('')}</div>`
        + (issuePills ? `<ul class="sprint-car-issues">${issuePills}</ul>` : '')
        + _fileScopeTags(car.files)
        + '</article>';
    }).join('');
    const html = `<div class="sprint-car-cards">${cards}</div>`;
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  /**
   * The best {@link carGates} stage to infer this car's six gates from,
   * given only its 6-stage pill code — {@link carGates} itself still reads
   * {@link STAGE_GATES}'s own dispatch-stage vocabulary, so this is the one
   * translation point back from the 6-stage pill to it.
   * @param {{code?: string}|null|undefined} pill
   * @returns {string}
   */
  function _pillToStage(pill) {
    const code = pill && typeof pill === 'object' && typeof pill.code === 'string' ? pill.code : 'open';
    if (code === 'open') return 'unassigned';
    if (code === 'deployed') return 'merged';
    return code;
  }

  /**
   * Live Kaizen & Sprint Reports catalog cards (#3112), for `📈 Kaizen &
   * Reports`: one card per report/retrospective from the Sprint Reports Hub
   * catalog, alongside whatever {@link renderKaizenLedgerPanel} already
   * draws for the live Kaizen ledger and Gate 0 feed — this renders only the
   * reports CATALOG (potentially several), where {@link renderKaizenLedgerPanel}'s
   * own `reportSummary` field is just the one current report.
   * @param {{reports?: Array<{id: string, version?: (string|null), title?: string,
   *   url?: (string|null), kind?: string}>}} snapshotData -
   *   `lib/native-sprint-tracker.js#buildSprintWaveSnapshot`'s own return shape.
   * @param {{innerHTML?: string}|null} [container] - A DOM element to write
   *   into, or omit to only get the HTML string back.
   * @returns {string} The rendered HTML.
   */
  function renderSprintReportsCatalog(snapshotData, container) {
    _refuseContainerFirst(snapshotData, 'renderSprintReportsCatalog');
    const d = snapshotData && typeof snapshotData === 'object' ? snapshotData : {};
    const reports = Array.isArray(d.reports) ? d.reports : [];
    if (!reports.length) {
      const html = '<p class="sprint-panel-empty">No sprint reports yet.</p>';
      if (container && typeof container === 'object') container.innerHTML = html;
      return html;
    }
    const cards = reports.map((r) => {
      const href = _safeHref(r && r.url);
      const title = (r && r.title) || (r && r.id) || 'Sprint report';
      const kind = r && r.kind === 'retrospective' ? 'retrospective' : 'report';
      return `<li class="sprint-report-card" data-kind="${_escapeHtml(kind)}" data-report-id="${_escapeHtml(r && r.id)}">`
        + (href
          ? `<a href="${_escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${_escapeHtml(title)}</a>`
          : `<span>${_escapeHtml(title)}</span>`)
        + (r && r.version ? `<span class="sprint-report-version">${_escapeHtml(r.version)}</span>` : '')
        + '</li>';
    }).join('');
    const html = `<ul class="sprint-report-cards">${cards}</ul>`;
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  /**
   * The 🐙 GitHub integration panel (#3134): live open PRs, open issues,
   * milestone progress and the latest release for this project's bound
   * repo, from `GET /api/sprint-waves/github-activity`. Not yet mounted as
   * a top-bar workspace tab — `public/v6-shell.js`'s `WORKSPACE_MODES`
   * array is a sibling lane's exclusive file scope this wave; this builder
   * is ready for that mount once it lands.
   * @param {{ok?: boolean, repo?: string, error?: string,
   *   pullRequests?: Array<{number: number, title: string, url: string, draft?: boolean}>,
   *   issues?: Array<{number: number, title: string, url: string}>,
   *   milestones?: Array<{title: string, openIssues?: number, closedIssues?: number, url?: string}>,
   *   latestRelease?: ({tagName: string, name?: string, url: string}|null)}} data -
   *   `GET /api/sprint-waves/github-activity`'s own response shape.
   * @param {{innerHTML?: string}|null} [container] - A DOM element to write
   *   into, or omit to only get the HTML string back.
   * @returns {string} The rendered HTML.
   */
  function renderGithubPanel(data, container) {
    _refuseContainerFirst(data, 'renderGithubPanel');
    const d = data && typeof data === 'object' ? data : {};
    if (d.ok === false) {
      const html = `<p class="sprint-panel-empty">GitHub activity is unavailable: ${_escapeHtml(d.error || 'unknown error')}</p>`;
      if (container && typeof container === 'object') container.innerHTML = html;
      return html;
    }
    const repo = typeof d.repo === 'string' ? d.repo : null;
    const link = (url, label) => {
      const href = _safeHref(url);
      return href ? `<a href="${_escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${_escapeHtml(label)}</a>` : _escapeHtml(label);
    };
    const list = (items, empty, render) => (items.length
      ? `<ul class="v6-workspace-list">${items.map(render).join('')}</ul>`
      : `<p class="sprint-panel-empty">${_escapeHtml(empty)}</p>`);

    const pulls = Array.isArray(d.pullRequests) ? d.pullRequests : [];
    const pullsHtml = list(pulls, 'No open pull requests.', (p) => (
      `<li class="v6-workspace-item">${link(p && p.url, `#${p && p.number} ${(p && p.title) || ''}`)}`
      + `${p && p.draft ? ' <span class="sprint-stage-pill is-pending">Draft</span>' : ''}</li>`
    ));

    const issues = Array.isArray(d.issues) ? d.issues : [];
    const issuesHtml = list(issues, 'No open issues.', (i) => (
      `<li class="v6-workspace-item">${link(i && i.url, `#${i && i.number} ${(i && i.title) || ''}`)}</li>`
    ));

    const milestones = Array.isArray(d.milestones) ? d.milestones : [];
    const milestonesHtml = list(milestones, 'No open milestones.', (m) => (
      `<li class="v6-workspace-item">${link(m && m.url, (m && m.title) || '')} `
      + `<span class="v6-workspace-item-stage">${_escapeHtml(m && m.openIssues !== undefined ? m.openIssues : '—')} open / `
      + `${_escapeHtml(m && m.closedIssues !== undefined ? m.closedIssues : '—')} closed</span></li>`
    ));

    const latest = d.latestRelease && typeof d.latestRelease === 'object' ? d.latestRelease : null;
    const releaseHtml = latest
      ? `<p>${link(latest.url, latest.name || latest.tagName)}</p>`
      : '<p class="sprint-panel-empty">No published release yet.</p>';

    const html = '<section class="sprint-panel" aria-label="GitHub">'
      + `<h2 class="sprint-panel-title">🐙 GitHub${repo ? ` — ${_escapeHtml(repo)}` : ''}</h2>`
      + `<h3 class="sprint-roadmap-group-title">Open pull requests</h3>${pullsHtml}`
      + `<h3 class="sprint-roadmap-group-title">Open issues</h3>${issuesHtml}`
      + `<h3 class="sprint-roadmap-group-title">Milestones</h3>${milestonesHtml}`
      + `<h3 class="sprint-roadmap-group-title">Latest release</h3>${releaseHtml}`
      + '</section>';
    if (container && typeof container === 'object') container.innerHTML = html;
    return html;
  }

  const sprintWaveUi = {
    STAGE_ORDER, STAGE_LABELS, GATES, renderSprintKpiCards, renderSprintWaveBoard, filterSprintWaveRows, carGates,
    renderCharterReadinessPanel, renderKaizenLedgerPanel,
    // The same two builders under the names the v6 workspace modes use (Ruling A774).
    renderSprintCharterRoadmapPanel: renderCharterReadinessPanel,
    renderSprintKaizenReportsPanel: renderKaizenLedgerPanel,
    // #3112: the Release-First Roadmap, enriched Sprint & Cars execution
    // cards, and the Sprint Reports/Retrospectives catalog -- all pure
    // builders over `buildSprintWaveSnapshot`'s shape, composed alongside
    // (never replacing) the two builders above.
    renderReleaseRoadmap, renderSprintCarCards, renderSprintReportsCatalog,
    // #3134: the GitHub integration panel and the public SSOT roadmap URL
    // it and renderReleaseRoadmap both link out to.
    renderGithubPanel, PUBLIC_SSOT_URL
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = sprintWaveUi;
  }
  if (global) {
    global.TangleClawSprintWaveUi = sprintWaveUi;
  }
})(typeof window !== 'undefined' ? window : null);
