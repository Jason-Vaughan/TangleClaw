'use strict';
/* ── TangleClaw — the fleet recovery panel (#2049) ── */
/* The signed-in operator's view of every launch on this install that is      */
/* waiting on their clear, and the one place they clear several at once.      */
/* Loaded as a plain script after api-helper.js and before ui.js, exposing a  */
/* controller and a mount function on `window`.                              */
/*                                                                            */
/* It calls three routes and no others: the fleet read, the batch clear and   */
/* the read of one batch. All three are refused unless the caller is an       */
/* operator signed in on an install with a login, and the panel adds nothing  */
/* to that: on a refusal it shows the server's words and offers no control.   */
/*                                                                            */
/* The order is fixed: choose, review, clear. Nothing is sent from the list,  */
/* and the review names each launch by the exact binding the operator read,   */
/* which is what the server compares before it clears anything.               */
/*                                                                            */
/* What a launch says after a clear is shown as an observation, with the time */
/* it was read. A launch that is no longer held has not thereby done          */
/* anything, and nothing here looks at a pane, so the panel says neither.     */

(function (global) {
  /**
   * HTML-escape a value for interpolation into markup, with the page's shared
   * escaper (`api-helper.js`, loaded before this file). Looked up on each call
   * rather than captured, so the panel escapes with whatever the page escapes
   * with and holds no copy that could drift from it.
   * @param {*} value - Anything; coerced to a string.
   * @returns {string}
   */
  function escapeHtml(value) {
    return global.tcEscapeHtml(value);
  }

  /** The routes this panel calls, and no others. */
  const ROUTES = Object.freeze({
    held: '/api/launch/recovery-held',
    clearBatch: '/api/launch/recovery-clear-batch',
    batch: (batchId) => `/api/launch/recovery-clear-batch/${encodeURIComponent(String(batchId))}`
  });

  /**
   * The most launches one request may name. The server holds the limit and
   * refuses a longer request whole; this copy only lets the panel say so
   * before the operator has reviewed a list that cannot be sent.
   */
  const MAX_ITEMS = 100;

  /**
   * What each outcome of a batch item means, in the operator's words. `changed`
   * says whether the request changed the launch: true for one outcome only.
   * `error` marks the outcome where something went wrong, apart from the
   * ones where the server looked and correctly left the launch alone.
   * An outcome missing from here is shown by its code and never as a clear.
   * @type {Readonly<Record<string, {label: string, detail: string, changed: boolean, error?: boolean}>>}
   */
  const OUTCOMES = Object.freeze({
    cleared: { label: 'Cleared', detail: 'This request cleared the launch\'s recovery.', changed: true },
    'already-clear': {
      label: 'Already clear',
      detail: 'The launch was already cleared at the revision you reviewed. This request changed nothing.',
      changed: false
    },
    stale: {
      label: 'Changed since you read it',
      detail: 'The launch is not as you reviewed it, so it was left alone. Refresh the list and look again.',
      changed: false
    },
    advisory: {
      label: 'Not an operator\'s to clear',
      detail: 'This launch is in advisory mode: its session clears it by a written reconciliation.',
      changed: false
    },
    'session-ended': {
      label: 'Session ended',
      detail: 'The launch\'s session is no longer active, so there is nothing to clear it for.',
      changed: false
    },
    'not-found': {
      label: 'Not found',
      detail: 'No such project, or no such launch of that session in that project.',
      changed: false
    },
    archived: {
      label: 'Project archived',
      detail: 'An archived project\'s launches are not cleared in a batch.',
      changed: false
    },
    failed: {
      label: 'Failed',
      detail: 'Deciding or recording this item failed. This machine\'s server log names the error.',
      changed: false,
      error: true
    }
  });

  /** How each part of the uncertain-work evidence is named. An unknown kind is shown by its own name. */
  const PART_LABELS = Object.freeze({
    strandedWraps: 'Stranded wraps',
    stagedHandoff: 'Staged handoff',
    startupPromptFire: 'Startup prompt dispatch',
    launchNudge: 'Launch nudges',
    paneInput: 'Pane input'
  });

  /**
   * The key a launch is selected under: the launch and the recovery revision
   * it was read at. A launch whose revision moves is a different decision, so
   * a selection made on the earlier one does not carry over.
   * @param {object} launch - A row of the fleet read
   * @returns {string}
   */
  function keyOf(launch) {
    return `${launch.sequenceId}:${launch.recoveryRevision}`;
  }

  /**
   * One stored value, said as what it is. Null and undefined are "not
   * recorded", never a blank and never false.
   * @param {*} value - A stored value
   * @returns {string} Markup, already escaped
   */
  function stored(value) {
    if (value === null || value === undefined) return '<em>not recorded</em>';
    if (typeof value === 'object') return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
    return `<code>${escapeHtml(value)}</code>`;
  }

  /**
   * The preflight record a launch stored, shown whole.
   *
   * The verdict and reason lead because they are what an operator reads
   * first. Every other field follows as stored, including the ones this page
   * has no word for: the operator is deciding on this record, so nothing in
   * it is left out, defaulted or reworded.
   * @param {object|null} preflight - The record, or null when the store could not parse it
   * @returns {string} Markup, already escaped
   */
  function preflightHtml(preflight) {
    if (!preflight || typeof preflight !== 'object') {
      return '<div class="fleet-recovery-line rules-status-err">Preflight: the stored record could not be read, '
        + 'so there is no preflight evidence to show for this launch.</div>';
    }
    const rest = Object.keys(preflight).filter((key) => key !== 'verdict' && key !== 'reason');
    return `<div class="fleet-recovery-line">Preflight verdict: ${stored(preflight.verdict)}. `
      + `Reason: ${preflight.reason ? escapeHtml(preflight.reason) : '<em>not recorded</em>'}</div>`
      + (rest.length
        ? `<div class="fleet-recovery-line fleet-recovery-muted">${rest
          .map((key) => `${escapeHtml(key)}: ${stored(preflight[key])}`).join(' | ')}</div>`
        : '');
  }

  /**
   * The session that ended before a launch, as stored.
   * @param {object|null|undefined} prior - `priorSession` from the fleet read
   * @returns {string} Markup, already escaped
   */
  function priorSessionHtml(prior) {
    const state = prior && prior.state;
    if (state === 'recorded') {
      return `<div class="fleet-recovery-line">Prior session ${escapeHtml(prior.sessionId)}: stored status `
        + `${stored(prior.status)}, ended ${prior.endedAt ? escapeHtml(prior.endedAt) : '<em>no end time recorded</em>'}. `
        + 'The status is the session row\'s own word; no reason for the end is recorded.</div>';
    }
    if (state === 'none-recorded') {
      return '<div class="fleet-recovery-line">Prior session: this project has no earlier session on record.</div>';
    }
    return '<div class="fleet-recovery-line rules-status-err">Prior session: could not be read'
      + `${prior && prior.reasonCode ? ` (${escapeHtml(prior.reasonCode)})` : ''}. That is not a statement that there was none.</div>`;
  }

  /**
   * One part of the uncertain-work evidence.
   *
   * The three states are worded apart, because they mean different things: a
   * source that holds rows, a source that was read and holds none, and a
   * source that could not be read or does not exist.
   * @param {object} part - One entry of `uncertainWork`
   * @returns {string} Markup, already escaped
   */
  function partHtml(part) {
    const name = escapeHtml(PART_LABELS[part.kind] || part.kind);
    const note = part.note ? ` ${escapeHtml(part.note)}` : '';
    // How complete the source is travels with every state: an empty read of a
    // pruned source is not proof that nothing happened.
    const source = `<span class="fleet-recovery-muted"> Source: ${escapeHtml(part.source)}`
      + `${part.completeness ? `; completeness: ${escapeHtml(part.completeness)}` : ''}.</span>`;
    if (part.state === 'unavailable') {
      return `<li><strong>${name}:</strong> unknown${part.reasonCode ? ` (${escapeHtml(part.reasonCode)})` : ''}.${note}${source}</li>`;
    }
    if (part.state === 'none-recorded') {
      return `<li><strong>${name}:</strong> none recorded.${note}${source}</li>`;
    }
    if (part.state !== 'recorded') {
      return `<li><strong>${name}:</strong> reported as ${stored(part.state)}, which this page does not know.${source}</li>`;
    }
    // A recorded part carries either a list of rows or its own fields.
    const shownAbove = ['kind', 'source', 'state', 'note', 'completeness', 'items'];
    const rows = Array.isArray(part.items)
      ? part.items.map((item) => `<code>${escapeHtml(JSON.stringify(item))}</code>`).join('<br>')
      : Object.keys(part).filter((key) => !shownAbove.includes(key))
        .map((key) => `${escapeHtml(key)}: ${stored(part[key])}`).join(' | ');
    return `<li><strong>${name}:</strong> recorded.${note}${source}<br>${rows}</li>`;
  }

  /**
   * The uncertain-work evidence of one launch, folded behind a summary that
   * already says how many parts hold something and how many are unknown.
   * @param {object[]|undefined} parts - `uncertainWork` from the fleet read
   * @returns {string} Markup, already escaped
   */
  function uncertainWorkHtml(parts) {
    if (!Array.isArray(parts)) {
      return '<div class="fleet-recovery-line rules-status-err">Work that may have been queued or in flight: '
        + 'the server sent no evidence for this launch.</div>';
    }
    const count = (state) => parts.filter((part) => part.state === state).length;
    return '<details class="fleet-recovery-evidence"><summary>Work that may have been queued or in flight: '
      + `${count('recorded')} recorded, ${count('none-recorded')} none recorded, ${count('unavailable')} unknown</summary>`
      + `<ul>${parts.map(partHtml).join('')}</ul></details>`;
  }

  /**
   * Who a launch is, by the binding a clear names.
   * @param {object} item - A row of the fleet read, or an item of a batch
   * @param {string|null} name - The project's name as the fleet read listed it, when known
   * @returns {string} Markup, already escaped
   */
  function bindingHtml(item, name) {
    return `<span class="fleet-recovery-binding"><strong>${name ? escapeHtml(name) : `project ${escapeHtml(item.projectId)}`}</strong> `
      + `<span class="fleet-recovery-muted">project ${escapeHtml(item.projectId)} | session ${escapeHtml(item.sessionId)} | `
      + `launch ${escapeHtml(item.sequenceId)} | recovery revision ${escapeHtml(item.recoveryRevision)}</span></span>`;
  }

  /**
   * What one launch says now, as read back with its batch.
   *
   * Stored facts and the time they were read. A READY attestation is reported
   * as recorded or not recorded and as nothing more.
   * @param {object|null|undefined} observation - `observation` on an item of the batch read
   * @returns {string} Markup, already escaped
   */
  function observationHtml(observation) {
    const state = observation && observation.state;
    if (state === 'none-recorded') {
      return 'the launch could not be found as this item names it, so nothing is known about it now.';
    }
    if (state !== 'recorded') {
      return `the launch could not be read${observation && observation.reasonCode ? ` (${escapeHtml(observation.reasonCode)})` : ''}, `
        + 'so nothing is known about it now. That is not a statement that it is no longer held.';
    }
    const status = observation.sessionStatus || {};
    let session = `could not be read${status.reasonCode ? ` (${escapeHtml(status.reasonCode)})` : ''}`;
    if (status.state === 'recorded') {
      session = `${stored(status.value)}${status.endedAt ? `, ended ${escapeHtml(status.endedAt)}` : ''}`;
    } else if (status.state === 'none-recorded') {
      session = 'no session row found';
    }
    return `recovery ${stored(observation.recovery)} at revision ${escapeHtml(observation.recoveryRevision)}`
      + ` (${observation.stillBlocked ? 'still held' : 'not held'}) | launch step cursor: ${escapeHtml(observation.cursor)}`
      + ` | READY attestation: ${observation.attestedReady ? `recorded ${escapeHtml(observation.readyAt)}` : 'none recorded'}`
      + ` | session's stored status: ${session}`;
  }

  /**
   * Make the panel's controller: its state, what it draws, and what each
   * control does. It touches no DOM, so a test can drive it directly.
   * @param {object} deps
   * @param {Function} deps.api - The page's `api()`; its `lastError` and `lastErrorCode` say why a call returned null.
   * @param {Function} deps.apiMutate - The page's `apiMutate(url, method, body)`, which carries the CSRF token.
   * @returns {{load: function(): Promise<void>, act: function(string, object=): Promise<void>, html: function(): string, state: object}}
   */
  function tcCreateFleetRecoveryPanel(deps) {
    const state = {
      /** Which step is on screen: `list`, `review` or `result`. */
      phase: 'list',
      /** The fleet read's answer: `{generatedAt, launches}`. */
      held: null,
      /** Why the fleet read was refused or failed: `{code, message}`. */
      refused: null,
      /** The keys ({@link keyOf}) of the launches the operator chose. */
      selected: new Set(),
      /** The launches under review, as read when Review was pressed. */
      reviewing: [],
      /** The batch clear's own answer. */
      batch: null,
      /** The batch read back, with what each launch says now. */
      observed: null,
      /** The last thing an action reported: `{ok, text}`. */
      notice: null,
      /** Whether a request is on its way, so no control sends a second one. */
      busy: false
    };

    /**
     * Why the last call returned nothing.
     * @returns {{code: (string|null), message: string}}
     */
    function lastError() {
      return { code: deps.api.lastErrorCode || null, message: deps.api.lastError || 'The server did not answer.' };
    }

    /**
     * The launches listed now, or none when the list is not held.
     * @returns {object[]}
     */
    function launches() {
      return state.held && Array.isArray(state.held.launches) ? state.held.launches : [];
    }

    /**
     * Read the fleet's held launches. A selection survives only for a launch
     * that is still listed at the revision it was chosen at.
     * @returns {Promise<void>}
     */
    async function load() {
      const held = await deps.api(ROUTES.held);
      if (!held) {
        state.held = null;
        state.refused = lastError();
        state.selected.clear();
        return;
      }
      state.held = held;
      state.refused = null;
      const listed = new Set(launches().map(keyOf));
      for (const key of [...state.selected]) {
        if (!listed.has(key)) state.selected.delete(key);
      }
    }

    /**
     * Read the batch back, for what each of its launches says now.
     * @returns {Promise<void>}
     */
    async function observe() {
      const observed = await deps.api(ROUTES.batch(state.batch.batchId));
      if (observed) {
        state.observed = observed;
        state.notice = null;
      } else {
        state.notice = { ok: false, text: `What the launches say now could not be read: ${lastError().message}` };
      }
    }

    /**
     * Send the reviewed launches as one batch, each named by its binding as read.
     * @returns {Promise<void>}
     */
    async function clear() {
      const items = state.reviewing.map((launch) => ({
        projectId: launch.projectId,
        sessionId: launch.sessionId,
        sequenceId: launch.sequenceId,
        recoveryRevision: launch.recoveryRevision
      }));
      const batch = await deps.apiMutate(ROUTES.clearBatch, 'POST', { items });
      if (!batch || !Array.isArray(batch.items)) {
        // Sending again is safe: a launch this request did clear answers
        // "already clear" to the next one, under a new batch id.
        state.notice = {
          ok: false,
          text: `The batch was not confirmed: ${lastError().message} If the answer was lost, sending again is safe: `
            + 'a launch that was cleared answers "already clear".'
        };
        return;
      }
      state.batch = batch;
      state.observed = null;
      state.phase = 'result';
      state.selected.clear();
      state.notice = null;
      await observe();
    }

    /**
     * Do what a control asks. Unknown actions and a second press while a
     * request is out are ignored.
     * @param {string} action - The control's `data-fleet-action`
     * @param {object} [fields] - What the control carries: `{key}` for a launch's checkbox
     * @returns {Promise<void>}
     */
    async function act(action, fields = {}) {
      if (state.busy) return;
      state.busy = true;
      try {
        if (action === 'refresh') {
          state.notice = null;
          await load();
        } else if (action === 'toggle') {
          if (state.selected.has(fields.key)) state.selected.delete(fields.key);
          else if (launches().some((launch) => keyOf(launch) === fields.key)) state.selected.add(fields.key);
        } else if (action === 'select-all') {
          for (const launch of launches()) state.selected.add(keyOf(launch));
        } else if (action === 'select-none') {
          state.selected.clear();
        } else if (action === 'review') {
          const chosen = launches().filter((launch) => state.selected.has(keyOf(launch)));
          if (chosen.length === 0 || chosen.length > MAX_ITEMS) return;
          state.reviewing = chosen;
          state.phase = 'review';
          state.notice = null;
        } else if (action === 'back') {
          state.phase = 'list';
          state.reviewing = [];
          state.notice = null;
        } else if (action === 'clear' && state.phase === 'review' && state.reviewing.length) {
          await clear();
        } else if (action === 'observe' && state.batch) {
          await observe();
        } else if (action === 'done') {
          state.phase = 'list';
          state.reviewing = [];
          state.batch = null;
          state.observed = null;
          state.notice = null;
          await load();
        }
      } finally {
        state.busy = false;
      }
    }

    /**
     * The notice line, when an action reported something.
     * @returns {string}
     */
    function noticeHtml() {
      if (!state.notice) return '';
      return `<div class="fleet-recovery-notice ${state.notice.ok ? 'rules-status-ok' : 'rules-status-err'}" role="status">`
        + `${escapeHtml(state.notice.text)}</div>`;
    }

    /**
     * The list step: every held launch with its evidence and a checkbox.
     * @returns {string}
     */
    function listHtml() {
      const rows = launches();
      const refresh = '<button type="button" class="btn btn-sm" data-fleet-action="refresh">Refresh</button>';
      if (rows.length === 0) {
        return '<h3 class="fleet-recovery-heading" tabindex="-1">Launches waiting on an operator</h3>'
          + `<p class="fleet-recovery-line">No launch of an active session is waiting on an operator's clear. `
          + `<span class="fleet-recovery-muted">Read ${escapeHtml(state.held.generatedAt)}.</span></p>${refresh}${noticeHtml()}`;
      }
      const chosen = rows.filter((launch) => state.selected.has(keyOf(launch))).length;
      const tooMany = chosen > MAX_ITEMS;
      const items = rows.map((launch) => {
        const key = keyOf(launch);
        return `<li class="fleet-recovery-item">
          <label class="fleet-recovery-pick">
            <input type="checkbox" data-fleet-action="toggle" data-fleet-key="${escapeHtml(key)}"${state.selected.has(key) ? ' checked' : ''}>
            ${bindingHtml(launch, launch.projectName)}
          </label>
          <div class="fleet-recovery-line fleet-recovery-muted">Launched ${escapeHtml(launch.createdAt)} | recovery ${stored(launch.recovery)} in ${stored(launch.recoveryMode)} mode | session's stored status ${stored(launch.sessionStatus && launch.sessionStatus.value)}; nothing checked that its pane is alive</div>
          ${preflightHtml(launch.preflight)}
          ${priorSessionHtml(launch.priorSession)}
          ${uncertainWorkHtml(launch.uncertainWork)}
        </li>`;
      }).join('');
      return '<h3 class="fleet-recovery-heading" tabindex="-1">Launches waiting on an operator</h3>'
        + `<p class="fleet-recovery-line">${escapeHtml(rows.length)} launch(es) of active sessions are held until an operator clears them. `
        + 'Choose the ones to clear, then review them. Nothing is sent from this list. '
        + `<span class="fleet-recovery-muted">Read ${escapeHtml(state.held.generatedAt)}.</span></p>`
        + '<div class="fleet-recovery-controls">'
        + '<button type="button" class="btn btn-sm" data-fleet-action="select-all">Select all</button>'
        + '<button type="button" class="btn btn-sm" data-fleet-action="select-none">Select none</button>'
        + refresh
        + `<button type="button" class="btn btn-sm btn-primary" data-fleet-action="review"${chosen === 0 || tooMany ? ' disabled' : ''}>`
        + `Review ${escapeHtml(chosen)} selected</button></div>`
        + (tooMany
          ? `<div class="fleet-recovery-notice rules-status-err" role="status">One batch clears at most ${MAX_ITEMS} launches `
            + `and ${escapeHtml(chosen)} are selected. Clear them in smaller batches.</div>`
          : '')
        + `${noticeHtml()}<ul class="fleet-recovery-list">${items}</ul>`;
    }

    /**
     * The review step: exactly what will be sent, and what a clear is.
     * @returns {string}
     */
    function reviewHtml() {
      const items = state.reviewing.map((launch) => `<li class="fleet-recovery-item">
          ${bindingHtml(launch, launch.projectName)}
          ${preflightHtml(launch.preflight)}
          ${priorSessionHtml(launch.priorSession)}
        </li>`).join('');
      return '<h3 class="fleet-recovery-heading" tabindex="-1">Review before clearing</h3>'
        + `<p class="fleet-recovery-line">You are about to clear the recovery hold on ${escapeHtml(state.reviewing.length)} launch(es), `
        + 'each named by the binding shown here. A launch that has changed since this list was read is left alone and reported. '
        + 'Each clear is recorded under your account with one shared batch id. Clearing types nothing into any pane.</p>'
        + `<ul class="fleet-recovery-list">${items}</ul>`
        + '<div class="fleet-recovery-controls">'
        + `<button type="button" class="btn btn-sm btn-primary" data-fleet-action="clear"${state.busy ? ' disabled' : ''}>`
        + `Clear ${escapeHtml(state.reviewing.length)} launch(es)</button>`
        + '<button type="button" class="btn btn-sm" data-fleet-action="back">Back to the list</button></div>'
        + noticeHtml();
    }

    /**
     * The result step: one outcome per item, then what each launch says now.
     * @returns {string}
     */
    function resultHtml() {
      const names = new Map(state.reviewing.map((launch) => [launch.sequenceId, launch.projectName]));
      const observations = new Map(
        (state.observed && Array.isArray(state.observed.items) ? state.observed.items : []).map((item) => [item.index, item])
      );
      const cleared = state.batch.items.filter((item) => item.outcome === 'cleared').length;
      const items = state.batch.items.map((item) => {
        const known = Object.prototype.hasOwnProperty.call(OUTCOMES, item.outcome) ? OUTCOMES[item.outcome] : null;
        const outcome = known
          ? `<span class="${known.changed ? 'rules-status-ok' : (known.error ? 'rules-status-err' : 'rules-status-warn')}"><strong>${escapeHtml(known.label)}.</strong></span> ${escapeHtml(known.detail)}`
          : `<span class="rules-status-err"><strong>Outcome ${stored(item.outcome)}</strong></span>, which this page does not know. It is not a clear.`;
        const unrecorded = item.recorded === false
          ? ' <span class="rules-status-err">This outcome could not be written to the batch\'s record.</span>'
          : '';
        const observed = observations.get(item.index);
        return `<li class="fleet-recovery-item">
          ${bindingHtml(item, names.get(item.sequenceId) || null)}
          <div class="fleet-recovery-line">${outcome}${unrecorded}</div>
          <div class="fleet-recovery-line fleet-recovery-muted">${state.observed
            ? `Observed ${escapeHtml(state.observed.observedAt)}: ${observed ? observationHtml(observed.observation) : 'this item is not in the batch\'s record, so nothing was read for it.'}`
            : 'Not read back yet.'}</div>
        </li>`;
      }).join('');
      const missing = state.observed && Array.isArray(state.observed.unrecordedIndexes) && state.observed.unrecordedIndexes.length
        ? `<div class="fleet-recovery-notice rules-status-err" role="status">The batch's record holds no row for item(s) `
          + `${escapeHtml(state.observed.unrecordedIndexes.join(', '))}.</div>`
        : '';
      return '<h3 class="fleet-recovery-heading" tabindex="-1">Batch result</h3>'
        + `<p class="fleet-recovery-line">${escapeHtml(cleared)} of ${escapeHtml(state.batch.items.length)} launch(es) cleared. `
        + `<span class="fleet-recovery-muted">Batch <code>${escapeHtml(state.batch.batchId)}</code>, sent by ${escapeHtml(state.batch.requestedBy)} `
        + `at ${escapeHtml(state.batch.requestedAt)}.</span></p>`
        + '<p class="fleet-recovery-line fleet-recovery-muted">The second line of each item is an observation: what the launch\'s '
        + 'stored record said when it was read. It can differ on the next read. The step cursor is the launch protocol\'s own '
        + 'position among its steps.</p>'
        + `${missing}<ul class="fleet-recovery-list">${items}</ul>`
        + '<div class="fleet-recovery-controls">'
        + '<button type="button" class="btn btn-sm" data-fleet-action="observe">Read the launches again</button>'
        + '<button type="button" class="btn btn-sm" data-fleet-action="done">Back to the list</button></div>'
        + noticeHtml();
    }

    /**
     * What the panel shows now.
     * @returns {string} Markup, already escaped
     */
    function html() {
      if (state.phase === 'result' && state.batch) return resultHtml();
      if (state.phase === 'review') return reviewHtml();
      if (state.refused) {
        // The server's own words: on an install with no login they say why
        // there is no fleet clear and where a single launch is still cleared.
        return '<h3 class="fleet-recovery-heading" tabindex="-1">Launches waiting on an operator</h3>'
          + `<p class="fleet-recovery-line rules-status-err" role="status">${escapeHtml(state.refused.message)}</p>`
          + (state.refused.code === 'LOGIN_GATE_REQUIRED'
            ? ''
            : '<button type="button" class="btn btn-sm" data-fleet-action="refresh">Try again</button>');
      }
      if (!state.held) return '<p class="fleet-recovery-line fleet-recovery-muted">Reading the launches waiting on an operator…</p>';
      return listHtml();
    }

    return { load, act, html, state };
  }

  /** What is drawn in each container: `{panel, draw}`. */
  const mounted = new WeakMap();

  /**
   * Draw the panel in a container and wire its controls.
   *
   * One listener on the container serves every control, so a redraw needs no
   * re-wiring. After a redraw the step's heading takes focus when the step
   * changed, and otherwise the control that was pressed keeps it, so a
   * keyboard or screen-reader user is not dropped at the top of the page.
   *
   * Mounting a container a second time keeps what it holds. On the list it
   * reads the list again, with the selection kept for each launch still listed
   * as it was chosen. A review or a batch result is left exactly as it is:
   * closing the panel and opening it again must not discard the answer to a
   * clear the operator has already sent.
   * @param {HTMLElement|null} container - Where it goes.
   * @param {object} deps - As {@link tcCreateFleetRecoveryPanel}.
   * @returns {Promise<object|null>} The controller, or null with no container.
   */
  async function tcMountFleetRecovery(container, deps) {
    if (!container) return null;
    const existing = mounted.get(container);
    if (existing) {
      if (existing.panel.state.phase === 'list') {
        await existing.panel.act('refresh');
        existing.draw();
      }
      return existing.panel;
    }
    const panel = tcCreateFleetRecoveryPanel(deps);
    /**
     * Redraw, and put focus where the operator's attention already is.
     * @param {string|null} [selector] - The control to focus again, when the step did not change
     * @param {string} [phaseBefore] - The step shown before the action
     * @returns {void}
     */
    const draw = (selector, phaseBefore) => {
      container.innerHTML = panel.html();
      if (typeof container.querySelector !== 'function') return;
      const target = phaseBefore !== undefined && phaseBefore !== panel.state.phase
        ? container.querySelector('.fleet-recovery-heading')
        : (selector ? container.querySelector(selector) : null);
      if (target && typeof target.focus === 'function') target.focus();
    };
    container.addEventListener('click', async (evt) => {
      const target = evt && evt.target;
      const action = target && target.dataset && target.dataset.fleetAction;
      if (!action || target.disabled) return;
      const phaseBefore = panel.state.phase;
      const key = target.dataset.fleetKey;
      // The key is read back from markup, so it goes into a selector only in the shape this panel writes.
      const selector = /^\d+:\d+$/.test(key || '')
        ? `[data-fleet-key="${key}"]`
        : `[data-fleet-action="${action}"]`;
      const acting = panel.act(action, { key });
      // Shown while the request is out, so the pressed control cannot be pressed twice.
      if (action === 'clear') container.innerHTML = panel.html();
      await acting;
      draw(selector, phaseBefore);
    });
    mounted.set(container, { panel, draw });
    draw();
    await panel.load();
    draw();
    return panel;
  }

  global.tcCreateFleetRecoveryPanel = tcCreateFleetRecoveryPanel;
  global.tcMountFleetRecovery = tcMountFleetRecovery;
  global.tcFleetRecoveryRoutes = ROUTES;
})(typeof window !== 'undefined' ? window : globalThis);
