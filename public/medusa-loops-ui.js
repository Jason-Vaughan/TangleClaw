'use strict';
/* ── TangleClaw v3 — Medusa loop UI (MED-2K9P v2 T3/T4; extracted for #1083) ── */
/*                                                                        */
/* The loop setup modal (the ➤ button), the loops chip and the loops      */
/* panel used to live only in `session.js`, bound to that page's static   */
/* markup and globals. #1083 asks for the Master control bar to get the   */
/* same affordances on both its surfaces (the dashboard panel and the     */
/* session drawer), so this file carries the SAME parameterised-component */
/* pattern `public/api-helper.js#tcCreateMedusaControl` already set for    */
/* the base control (#996/#768 — reuse, don't fork): one factory, driven  */
/* by `deps.ids` (from `tcMedusaIds`, extended here with real loop ids for */
/* a prefixed host) and `deps.state` (the SAME state object the host's own */
/* `tcCreateMedusaControl` instance already carries `loops`/`loopsError`/  */
/* `outbound`/`messageLimitBytes` on, via `applyStatus`).                 */
/*                                                                        */
/* What this file deliberately does NOT do: it never creates the modal's  */
/* DOM. For the session page the modal is session.html's existing static  */
/* markup (unprefixed ids, untouched); for the Master bar it rides the    */
/* SAME `root.innerHTML = tcMasterControlBarMarkup(p)` assignment that    */
/* already paints the base control, via `tcMedusaLoopsControlMarkup` +    */
/* `tcMedusaLoopModalMarkup` appended to that one string. `mount()` here  */
/* only binds listeners to elements it assumes already exist — exactly    */
/* the assumption `tcCreateMedusaControl.mount()` already makes.          */
/*                                                                        */
/* Loaded as a plain script, right after `api-helper.js` and before any   */
/* page script that calls `tcCreateMedusaLoops`/`tcCreateMasterControlBar`. */
/* Tests lift this file the same way `test/_api-helper-globals.js` lifts   */
/* api-helper.js and run it against the mini DOM (#928 R-1 discipline).   */

(function (global) {
  const esc = typeof global.tcEscapeHtml === 'function'
    ? global.tcEscapeHtml
    : (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** @type {string[]} Loop states the Bridge still treats as live (not ended). */
  const MEDUSA_LIVE_LOOP_STATES = ['initiated', 'responded', 'continue'];

  /**
   * Per-mode wall-clock guard presets (MED-6V3R). Shared by every host this
   * component mounts on. #1083's own issue names "decide Master-specific
   * guard presets... before shipping autonomous mode from the Master" as an
   * open product decision — deliberately NOT resolved here (that would be
   * inventing a requirement no Ruling asked for); `deps.guardPresets` is the
   * override seam a future car can use once that decision is made. Keep in
   * sync with `DEFAULT_WALL_SECONDS` in `lib/medusa.js`, which serves API
   * callers that omit the guard; this modal always sends an explicit value.
   * @type {{supervised: {minutes: number, hint: string}, autonomous: {minutes: number, hint: string}}}
   */
  const MEDUSA_LOOP_GUARD_PRESETS = {
    supervised: {
      minutes: 480,
      hint: 'Supervised: rounds only advance when you send, so this drops the loop if you never respond — it is not runaway protection. Max rounds is.'
    },
    autonomous: {
      minutes: 10,
      hint: 'Autonomous: agents drive every round unattended, so this bounds their work. The clock starts on first delivery and never pauses.'
    }
  };

  /**
   * The loop UI's element ids for one host, built on `tcMedusaIds` (the base
   * control's own id set — `control`/`loop`/`loopsChip`/`loopsPanel`/`live`)
   * plus the modal's internal form fields, which `tcMedusaIds` never carried.
   *
   * Prefix `''` reproduces the session page's historical static ids exactly,
   * so its existing markup keeps working untouched. Any other prefix gets
   * `${prefix}MedusaLoop*`, matching the convention `tcMedusaIds` already
   * uses for its own prefixed fields.
   * @param {string} [prefix] - Host prefix; empty/omitted = the session banner.
   * @returns {object} The combined id set.
   */
  function tcMedusaLoopIds(prefix) {
    const base = typeof global.tcMedusaIds === 'function' ? global.tcMedusaIds(prefix) : {};
    if (!prefix) {
      return Object.assign({}, base, {
        modal: 'medusaLoopModal', target: 'medusaLoopTarget', rosterStatus: 'medusaLoopRosterStatus',
        task: 'medusaLoopTask', done: 'medusaLoopDone', size: 'medusaLoopSize',
        mode: 'medusaLoopMode', maxRounds: 'medusaLoopMaxRounds', maxMinutes: 'medusaLoopMaxMinutes',
        guardHint: 'medusaLoopGuardHint', error: 'medusaLoopError',
        cancelBtn: 'medusaLoopCancelBtn', launchBtn: 'medusaLoopLaunchBtn'
      });
    }
    return Object.assign({}, base, {
      modal: `${prefix}MedusaLoopModal`, target: `${prefix}MedusaLoopTarget`, rosterStatus: `${prefix}MedusaLoopRosterStatus`,
      task: `${prefix}MedusaLoopTask`, done: `${prefix}MedusaLoopDone`, size: `${prefix}MedusaLoopSize`,
      mode: `${prefix}MedusaLoopMode`, maxRounds: `${prefix}MedusaLoopMaxRounds`, maxMinutes: `${prefix}MedusaLoopMaxMinutes`,
      guardHint: `${prefix}MedusaLoopGuardHint`, error: `${prefix}MedusaLoopError`,
      cancelBtn: `${prefix}MedusaLoopCancelBtn`, launchBtn: `${prefix}MedusaLoopLaunchBtn`
    });
  }

  /**
   * The ➤ button + ⟳ chip + loops panel shell — the inline markup a host
   * splices beside its base control's own `tcMedusaControlMarkup` output.
   * The session page keeps this as static HTML (unchanged); the Master bar's
   * `tcMasterControlBarMarkup` calls this directly.
   * @param {ReturnType<typeof tcMedusaLoopIds>} ids - The host's id set.
   * @param {string} [subject] - 'this session' (default) or 'the Master'.
   * @returns {string} HTML.
   */
  function tcMedusaLoopsControlMarkup(ids, subject) {
    const who = subject || 'this session';
    return `<button class="medusa-compose" id="${ids.loop}" type="button" hidden`
      + ` aria-label="Set up a loop for ${esc(who)}" aria-haspopup="dialog" aria-expanded="false">&#x27A4;</button>`
      + `<button class="medusa-loops-chip" id="${ids.loopsChip}" type="button" hidden`
      + ` aria-label="Open ${esc(who)}'s loops" aria-haspopup="dialog" aria-expanded="false"></button>`
      + `<div class="medusa-panel medusa-loops-panel group-popover" id="${ids.loopsPanel}" role="dialog"`
      + ` aria-label="${esc(who)}'s loops" hidden></div>`;
  }

  /**
   * The loop setup modal's markup — the compose form (target, task, done
   * criteria, judge mode, guards) a host appends once. The session page keeps
   * this as static HTML (unchanged, `session.html`); the Master bar's
   * `tcMasterControlBarMarkup` calls this directly, so it rides the same
   * `root.innerHTML` assignment that already paints the base control — this
   * component never creates DOM nodes itself.
   * @param {ReturnType<typeof tcMedusaLoopIds>} ids - The host's id set.
   * @param {string} [subject] - 'a session loop' (default) or 'a Master loop'.
   * @returns {string} HTML.
   */
  function tcMedusaLoopModalMarkup(ids, subject) {
    const title = subject || 'a session loop';
    return `<div class="modal-backdrop" id="${ids.modal}">`
      + `<div class="modal-content" role="dialog" aria-label="Set up ${esc(title)}" aria-modal="true">`
      + `<h3 class="modal-title">${esc(title.replace(/^a /, '').replace(/^(.)/, (c) => c.toUpperCase()))}</h3>`
      + '<div class="form-group">'
      + `<label class="form-label" for="${ids.target}">Work with</label>`
      + `<select class="form-select" id="${ids.target}" disabled></select>`
      + `<div class="form-hint" id="${ids.rosterStatus}">Loading sessions&hellip;</div>`
      + '</div>'
      + '<div class="form-group">'
      + `<label class="form-label" for="${ids.task}">Task</label>`
      + `<textarea class="form-textarea" id="${ids.task}" rows="3" placeholder="What should the other session do?"></textarea>`
      + '</div>'
      + '<div class="form-group">'
      + `<label class="form-label" for="${ids.done}">Done criteria</label>`
      + `<textarea class="form-textarea" id="${ids.done}" rows="2" placeholder="How will you judge it complete?"></textarea>`
      + `<div class="form-hint medusa-size-count" id="${ids.size}" aria-live="polite"></div>`
      + '</div>'
      + '<div class="form-group">'
      + `<label class="form-label" for="${ids.mode}">Judge mode</label>`
      + `<select class="form-select" id="${ids.mode}">`
      + '<option value="supervised" selected>Supervised — you judge each round</option>'
      + '<option value="autonomous">Autonomous — this session\'s agent judges</option>'
      + '</select>'
      + '<div class="form-hint">Only the initiator ends the loop. Max rounds bounds it either way.</div>'
      + '</div>'
      + '<div class="medusa-loop-guards">'
      + '<div class="form-group">'
      + `<label class="form-label" for="${ids.maxRounds}">Max rounds</label>`
      + `<input type="number" class="form-input" id="${ids.maxRounds}" value="10" min="1" step="1" inputmode="numeric">`
      + '</div>'
      + '<div class="form-group">'
      + `<label class="form-label" for="${ids.maxMinutes}">Max minutes</label>`
      + `<input type="number" class="form-input" id="${ids.maxMinutes}" value="480" min="1" step="1" inputmode="numeric" aria-describedby="${ids.guardHint}">`
      + '</div>'
      + '</div>'
      + `<div class="form-hint" id="${ids.guardHint}">${esc(MEDUSA_LOOP_GUARD_PRESETS.supervised.hint)}</div>`
      + `<div id="${ids.error}" class="form-error hidden" role="alert"></div>`
      + '<div class="modal-actions">'
      + `<button class="btn" id="${ids.cancelBtn}">Cancel</button>`
      + `<button class="btn btn-primary" id="${ids.launchBtn}">Launch loop</button>`
      + '</div></div></div>';
  }

  /**
   * Create a Medusa loop UI bound to one host (a session, or the Master).
   *
   * Mirrors `tcCreateMedusaControl`'s own shape deliberately: the same
   * `deps.ids`/`deps.state`/`deps.hooks` seam, so a host wires both
   * components the same way. Reads `state.loops`/`state.loopsError`/
   * `state.outbound`/`state.messageLimitBytes` — the SAME object the host's
   * own `tcCreateMedusaControl` instance keeps current via `applyStatus`
   * (pass that instance's own `.state`, never a copy).
   *
   * @param {object} deps
   * @param {string} deps.apiBase - `/api/sessions/<project>/medusa` or `/api/master/medusa`.
   * @param {(url: string, opts?: object) => Promise<object|null>} deps.api - The page's `api()`.
   * @param {(url: string, method: string, body?: object) => Promise<object|null>} deps.apiMutate - The page's `apiMutate()`.
   * @param {object} [deps.doc] - Document (tests); defaults to `global.document`.
   * @param {ReturnType<typeof tcMedusaLoopIds>} [deps.ids] - Id set; defaults to the session banner's.
   * @param {(s: *) => string} [deps.esc] - HTML escaper; defaults to `tcEscapeHtml`.
   * @param {object} [deps.state] - The shared state object (`loops`, `loopsError`,
   *   `outbound`, `messageLimitBytes` live here) — pass the host's `tcCreateMedusaControl`
   *   instance's own `.state` (or, for the session, `sessionState.medusa`, which IS that
   *   same object) so both components read one source of truth.
   * @param {() => void} deps.renderControl - Called after a loop mutation that should
   *   refresh the base control (mirrors the session's historical `renderMedusaControl()`).
   * @param {(msg: string, isError: boolean) => void} deps.toast - Surfaces an outcome
   *   (the session's `showBannerActionToast`).
   * @param {(label: string, status: string) => void} [deps.flowOutbound] - Flashes the
   *   outbound head on a successful launch (the session's `flowMedusaOutbound`).
   * @param {(msg: string) => boolean} [deps.confirm] - Confirmation prompt for the two
   *   destructive loop actions; defaults to `global.confirm`.
   * @param {{supervised: object, autonomous: object}} [deps.guardPresets] - Override
   *   seam for Master-specific presets (unresolved product decision per #1083; defaults
   *   to the session's existing presets for every host today).
   * @param {object} [deps.hooks]
   * @param {() => void} [deps.hooks.onOpenModal] - Before the setup modal opens (the
   *   host closes its OTHER popovers — inbox, peers).
   * @param {() => void} [deps.hooks.onOpenPanel] - Before the loops panel opens (the
   *   host closes its other popovers, including the modal if relevant to it).
   * @returns {{state: object, mount: () => boolean, onControlRender: (m: object) => void,
   *   renderChip: (m: object) => void, closeModal: () => void, closePanel: () => void}}
   */
  function tcCreateMedusaLoops(deps) {
    const doc = deps.doc || global.document;
    const ids = deps.ids || tcMedusaLoopIds('');
    const escFn = deps.esc || esc;
    const apiBase = deps.apiBase;
    const api = deps.api;
    const apiMutate = deps.apiMutate;
    const renderControl = deps.renderControl || (() => {});
    const toast = deps.toast || (() => {});
    const flowOutbound = deps.flowOutbound || (() => {});
    const confirmFn = deps.confirm || ((msg) => global.confirm(msg));
    const guardPresets = deps.guardPresets || MEDUSA_LOOP_GUARD_PRESETS;
    const hooks = deps.hooks || {};
    const m = deps.state || {};
    if (m.loops === undefined) m.loops = [];
    if (m.loopsError === undefined) m.loopsError = null;
    if (m.outbound === undefined) m.outbound = { allowed: true, reason: null };

    let bound = false;
    let minutesDirty = false;
    const expandedTranscripts = new Set();
    const expandedFeedback = new Set();
    const feedbackDrafts = new Map();

    const el = (key) => (ids[key] ? doc.getElementById(ids[key]) : null);

    /**
     * Whether the loop launch affordance should be offered right now: the
     * listener must be on (a truthful initiator) and this participant's
     * access level must allow sending (#1083 — a read-only Master may not).
     * @param {object} st - State.
     * @returns {boolean}
     */
    function canLaunch(st) {
      return st.state !== 'off' && !(st.outbound && st.outbound.allowed === false);
    }

    /**
     * Sync the wall-clock guard control to the selected judge mode (MED-6V3R).
     * @returns {void}
     */
    function syncGuardMode() {
      const mode = el('mode');
      const minutes = el('maxMinutes');
      const hint = el('guardHint');
      const preset = guardPresets[mode && mode.value] || guardPresets.supervised;
      if (hint) hint.textContent = preset.hint;
      if (minutes && !minutesDirty) minutes.value = String(preset.minutes);
    }

    /**
     * The body the loop modal's Launch would POST, read from the form as it stands.
     * @returns {{target: string, task: string, doneCriteria: string, mode: string,
     *   guards: {maxRounds: number, maxWallTimeSeconds: number}}}
     */
    function payload() {
      const val = (key) => {
        const e = el(key);
        return e ? e.value : '';
      };
      return {
        target: val('target'),
        task: val('task').trim(),
        doneCriteria: val('done').trim(),
        mode: val('mode') || 'supervised',
        guards: {
          maxRounds: parseInt(val('maxRounds'), 10),
          maxWallTimeSeconds: parseInt(val('maxMinutes'), 10) * 60
        }
      };
    }

    /**
     * Paint a compose box's live size line (#1514).
     * @param {object|null} sizeEl - The size line element.
     * @param {object} body - The body the send would POST.
     * @returns {{bytes: number, limitBytes: (number|null), level: string, text: string}}
     */
    function renderSizeLine(sizeEl, body) {
      const size = global.tcMessageSize(body, m.messageLimitBytes);
      if (sizeEl) {
        sizeEl.textContent = size.text;
        sizeEl.classList.toggle('is-warn', size.level === 'warn');
        sizeEl.classList.toggle('is-over', size.level === 'over');
      }
      return size;
    }

    /**
     * Populate the loop target picker from the roster.
     * @param {Array<{id: string, name?: string, connected?: boolean, listener?: {active?: boolean}}>} workspaces
     * @returns {void}
     */
    function renderTargets(workspaces) {
      const select = el('target');
      const status = el('rosterStatus');
      if (!select) return;
      if (!workspaces.length) {
        select.innerHTML = '';
        select.disabled = true;
        if (status) status.textContent = 'No other Medusa sessions are online to loop with.';
        return;
      }
      select.innerHTML = workspaces.map((w) => {
        const online = w.connected || (w.listener && w.listener.active);
        const label = escFn(w.name || w.id) + (online ? '' : ' (offline)');
        return `<option value="${escFn(w.id)}">${label}</option>`;
      }).join('');
      select.disabled = false;
      if (status) status.textContent = 'Offline targets get the task when they reconnect.';
      select.focus();
    }

    /**
     * Open the loop setup modal (the ➤ button). Toggles closed if already open.
     * @returns {Promise<void>}
     */
    async function openModal() {
      const modal = el('modal');
      const loopBtn = el('loop');
      if (!modal) return;
      if (modal.classList.contains('open')) { closeModal(); return; }

      if (typeof hooks.onOpenModal === 'function') hooks.onOpenModal();

      const select = el('target');
      const status = el('rosterStatus');
      const error = el('error');
      if (error) { error.hidden = true; error.textContent = ''; }
      if (select) { select.innerHTML = ''; select.disabled = true; }
      if (status) status.textContent = 'Loading sessions…';
      syncGuardMode();
      renderSizeLine(el('size'), payload());

      modal.classList.add('open');
      if (loopBtn) loopBtn.setAttribute('aria-expanded', 'true');

      const data = await api(`${apiBase}/roster`);
      if (data === null) {
        if (status) status.textContent = `Couldn't load sessions: ${api.lastError || 'the message bridge is unreachable'} Reopen to retry.`;
        return;
      }
      renderTargets(data.workspaces || []);
    }

    /**
     * Close the loop setup modal. Safe when already closed.
     * @returns {void}
     */
    function closeModal() {
      const modal = el('modal');
      const loopBtn = el('loop');
      if (modal) modal.classList.remove('open');
      if (loopBtn) loopBtn.setAttribute('aria-expanded', 'false');
    }

    /**
     * Launch the loop (the Launch button).
     * @returns {Promise<void>}
     */
    async function launch() {
      const select = el('target');
      const task = el('task');
      const done = el('done');
      const rounds = el('maxRounds');
      const minutes = el('maxMinutes');
      const btn = el('launchBtn');
      const error = el('error');
      if (!select || !task || !done) return;

      const fail = (msg) => { if (error) { error.textContent = msg; error.hidden = false; } };
      if (error) { error.hidden = true; error.textContent = ''; }

      const target = select.value;
      const label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].text.replace(/ \(offline\)$/, '') : target;
      if (!target) { fail('Pick a session to loop with.'); return; }
      if (!task.value.trim()) { fail('Describe the task.'); task.focus(); return; }
      if (!done.value.trim()) { fail('State the done criteria you will judge against.'); done.focus(); return; }
      const maxRounds = parseInt(rounds && rounds.value, 10);
      const maxMinutes = parseInt(minutes && minutes.value, 10);
      if (!Number.isInteger(maxRounds) || maxRounds < 1) { fail('Max rounds must be a positive whole number.'); return; }
      if (!Number.isInteger(maxMinutes) || maxMinutes < 1) { fail('Max minutes must be a positive whole number.'); return; }

      const body = { ...payload(), guards: { maxRounds, maxWallTimeSeconds: maxMinutes * 60 } };
      const size = renderSizeLine(el('size'), body);
      if (size.level === 'over') { fail(global.tcTooLongText(size.bytes, size.limitBytes)); return; }

      if (btn) { btn.disabled = true; btn.textContent = 'Launching…'; }
      const result = await apiMutate(`${apiBase}/loop`, 'POST', body);
      if (btn) { btn.disabled = false; btn.textContent = 'Launch loop'; }

      if (result && result.loop) {
        toast(`Loop opened with ${label} — the Bridge delivers the invite (live, or on their reconnect).`, false);
        flowOutbound(label, 'invited');
        closeModal();
      } else {
        fail(`Couldn't open loop: ${global.tcApiFailureText(api, 'launch failed')}`);
      }
    }

    /**
     * Repaint the loops chip (and the base control's `has-live-loop` class)
     * from the current state. Closes the panel too when there is nothing left
     * to show it for.
     * @param {object} st - State.
     * @returns {void}
     */
    function renderChip(st) {
      const chip = el('loopsChip');
      const control = el('control');
      if (!chip || !control) return;
      const loops = st.loops || [];
      const live = loops.filter((l) => MEDUSA_LIVE_LOOP_STATES.includes(l.state));

      control.classList.toggle('has-live-loop', live.length > 0);

      if (!loops.length && !st.loopsError) {
        chip.hidden = true;
        const panel = el('loopsPanel');
        if (panel && !panel.hidden) closePanel();
        return;
      }
      chip.hidden = false;
      if (st.loopsError) {
        chip.textContent = '⟳ ?';
        chip.setAttribute('aria-label', `Loops unavailable: ${st.loopsError}`);
      } else if (live.length === 1) {
        const l = live[0];
        const max = l.guards && l.guards.maxRounds ? `/${l.guards.maxRounds}` : '';
        chip.textContent = `⟳ R${l.round}${max}`;
        chip.setAttribute('aria-label', `Open loops (1 live loop, round ${l.round}${max ? ` of ${l.guards.maxRounds}` : ''})`);
      } else if (live.length > 1) {
        chip.textContent = `⟳ ${live.length}`;
        chip.setAttribute('aria-label', `Open loops (${live.length} live loops)`);
      } else {
        chip.textContent = `⟳ ${loops.length} ended`;
        chip.setAttribute('aria-label', `Open loops (${loops.length} ended)`);
      }

      const panel = el('loopsPanel');
      if (panel && !panel.hidden) renderPanel();
    }

    /**
     * The control's own `hooks.onRender(m)` — toggles the launch button per
     * `canLaunch` and repaints the chip. Wire this as the base control's
     * `hooks.onRender` (mirrors the session's historical inline hook).
     * @param {object} st - State.
     * @returns {void}
     */
    function onControlRender(st) {
      const loopBtn = el('loop');
      if (loopBtn) {
        const can = canLaunch(st);
        loopBtn.hidden = !can;
        if (!can) closeModal();
      }
      renderChip(st);
    }

    /**
     * Human-readable outcome label for a loop.
     * @param {{state: string, closeSignal?: (object|null)}} loop
     * @returns {string}
     */
    function stateLabel(loop) {
      if (loop.state === 'halted') return 'halted by guard';
      if (loop.state === 'complete') {
        const reason = loop.closeSignal && loop.closeSignal.reason;
        if (reason === 'force-done') return 'ended by force-done';
        if (reason === 'satisfied') return 'ended — marked done';
        return 'complete';
      }
      return loop.state;
    }

    /**
     * Open the loops panel (the ⟳ chip click). Toggles closed if already open.
     * @returns {Promise<void>}
     */
    async function openPanel() {
      const panel = el('loopsPanel');
      if (!panel) return;
      if (!panel.hidden) { closePanel(); return; }
      if (typeof hooks.onOpenPanel === 'function') hooks.onOpenPanel();
      closeModal();
      panel.hidden = false;
      const chip = el('loopsChip');
      if (chip) chip.setAttribute('aria-expanded', 'true');
      await renderPanel();
    }

    /**
     * Close the loops panel. Safe when already closed.
     * @returns {void}
     */
    function closePanel() {
      const panel = el('loopsPanel');
      if (panel) panel.hidden = true;
      const chip = el('loopsChip');
      if (chip) chip.setAttribute('aria-expanded', 'false');
    }

    /**
     * Render the loops panel: one row per known loop.
     * @returns {Promise<void>}
     */
    async function renderPanel() {
      const panel = el('loopsPanel');
      if (!panel) return;
      const active = doc.activeElement;
      if (active && active.closest && active.closest('.medusa-loop-feedback-input') && panel.contains(active)) {
        return;
      }
      const loops = m.loops || [];

      const head = '<div class="group-popover-title medusa-panel-head"><span>Loops</span>'
        + '<button type="button" class="medusa-panel-close" aria-label="Close loops">✕</button></div>';

      if (m.loopsError) {
        panel.innerHTML = `${head}<div class="medusa-msg-empty">Loops unavailable: ${escFn(m.loopsError)}</div>`;
        return;
      }
      if (!loops.length) {
        panel.innerHTML = `${head}<div class="medusa-msg-empty">No loops yet.</div>`;
        return;
      }

      let inbox = null;
      if (expandedTranscripts.size > 0) {
        const data = await api(`${apiBase}/messages`);
        inbox = (data && data.messages) || [];
      }

      const rows = loops.map((loop) => {
        const live = MEDUSA_LIVE_LOOP_STATES.includes(loop.state);
        const other = loop.role === 'initiator' ? loop.target : loop.initiator;
        const maxRounds = loop.guards && loop.guards.maxRounds;
        const round = `round ${loop.round}${maxRounds ? `/${maxRounds}` : ''}`;
        const label = stateLabel(loop);
        const expanded = expandedTranscripts.has(loop.id);

        const canJudge = loop.role === 'initiator' && loop.state === 'responded';
        const feedbackOpen = expandedFeedback.has(loop.id);
        let actions = '';
        if (live && loop.role === 'initiator') {
          if (canJudge) {
            actions += `<button type="button" class="medusa-loop-continue" data-loop-id="${escFn(loop.id)}" aria-expanded="${feedbackOpen ? 'true' : 'false'}">Send feedback</button>`;
            actions += `<button type="button" class="medusa-loop-closeout" data-loop-id="${escFn(loop.id)}">Mark done</button>`;
          }
          actions += `<button type="button" class="medusa-force-done" data-loop-id="${escFn(loop.id)}">Force-done</button>`;
        } else if (loop.state === 'halted') {
          actions += '<span class="medusa-loop-note">guard-halted — cannot be closed</span>';
        }
        actions += `<button type="button" class="medusa-loop-transcript-toggle" data-loop-id="${escFn(loop.id)}" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? 'Hide' : 'Transcript'}</button>`;

        let feedback = '';
        if (canJudge && feedbackOpen) {
          const fid = `medusaFeedback-${escFn(loop.id)}`;
          const draft = feedbackDrafts.get(loop.id) || '';
          const size = global.tcMessageSize({ message: draft.trim() }, m.messageLimitBytes);
          const sizeClass = size.level === 'warn' ? ' is-warn' : (size.level === 'over' ? ' is-over' : '');
          feedback = '<div class="medusa-loop-feedback">'
            + `<label class="medusa-loop-feedback-label" for="${fid}">Feedback to continue this loop</label>`
            + `<textarea id="${fid}" class="medusa-loop-feedback-input" data-loop-id="${escFn(loop.id)}" rows="2" placeholder="What should ${escFn(other)} do next?">${escFn(draft)}</textarea>`
            + `<button type="button" class="medusa-loop-feedback-send" data-loop-id="${escFn(loop.id)}">Send</button>`
            + `<div class="medusa-size-count${sizeClass}" data-size-for="${escFn(loop.id)}" aria-live="polite">${escFn(size.text)}</div>`
            + '</div>';
        }

        let transcript = '';
        if (expanded) {
          const observed = (inbox || []).filter((msg) => msg.loopId === loop.id);
          const entries = [
            `<div class="medusa-msg"><div class="medusa-msg-from">task → ${escFn(loop.target)}</div><div class="medusa-msg-body">${escFn(loop.task || '')}</div></div>`
          ].concat(observed.map((msg) => `<div class="medusa-msg"><div class="medusa-msg-from">${escFn(msg.from || 'unknown')}</div><div class="medusa-msg-body">${escFn(msg.message || '')}</div></div>`));
          transcript = '<div class="medusa-loop-transcript">'
            + `<div class="medusa-loop-transcript-note">As observed here (the Bridge keeps no full history)${observed.length ? '' : ' — no rounds observed here yet'}</div>`
            + entries.join('')
            + '</div>';
        }

        return `<div class="medusa-loop-row is-${escFn(loop.state)}">`
          + `<div class="medusa-loop-who">${loop.role === 'initiator' ? '→' : '←'} ${escFn(other)}</div>`
          + `<div class="medusa-loop-meta">${escFn(loop.mode || 'supervised')} · ${escFn(label)} · ${escFn(round)}</div>`
          + `<div class="medusa-loop-actions">${actions}</div>`
          + feedback
          + transcript
          + '</div>';
      }).join('');

      panel.innerHTML = `${head}${rows}`;
    }

    /**
     * Force-done a loop (the kill-switch).
     * @param {string} loopId
     * @returns {Promise<void>}
     */
    async function forceDone(loopId) {
      const yes = confirmFn('End this loop now? The other session gets a close notice; this cannot be undone.');
      if (!yes) return;
      const result = await apiMutate(`${apiBase}/loops/${encodeURIComponent(loopId)}/force-done`, 'POST', {});
      if (result && result.loopState) {
        const loop = (m.loops || []).find((l) => l.id === loopId);
        if (loop) {
          loop.state = result.loopState;
          loop.closeSignal = result.closeSignal || loop.closeSignal;
        }
        toast('Loop ended (force-done).', false);
        const live = el('live');
        if (live) live.textContent = 'Loop ended by force-done';
        renderControl();
      } else {
        toast(`Couldn't end loop: ${api.lastError || 'the bridge rejected it'}`, true);
      }
    }

    /**
     * Send an initiator FEEDBACK round to continue a supervised loop (TC#561).
     * @param {string} loopId
     * @param {string} message
     * @returns {Promise<void>}
     */
    async function continueLoop(loopId, message) {
      const text = (message || '').trim();
      if (!text) { toast('Enter feedback before sending.', true); return; }
      const size = global.tcMessageSize({ message: text }, m.messageLimitBytes);
      if (size.level === 'over') {
        toast(`Couldn't send feedback: ${global.tcTooLongText(size.bytes, size.limitBytes)}`, true);
        return;
      }
      const result = await apiMutate(`${apiBase}/loops/${encodeURIComponent(loopId)}/continue`, 'POST', { message: text });
      if (result && result.loopState) {
        const loop = (m.loops || []).find((l) => l.id === loopId);
        if (loop) {
          loop.state = result.loopState;
          if (typeof result.round === 'number') loop.round = result.round;
        }
        expandedFeedback.delete(loopId);
        feedbackDrafts.delete(loopId);
        if (result.loopState === 'halted') {
          toast('Feedback sent — loop hit its round cap and halted.', false);
        } else {
          toast(result.delivered ? 'Feedback sent — loop continued.' : 'Feedback queued — loop continued.', false);
        }
        renderControl();
      } else {
        toast(`Couldn't send feedback: ${global.tcApiFailureText(api, 'the bridge rejected it')}`, true);
      }
    }

    /**
     * Satisfied closeout (TC#561) — end a loop as *done*.
     * @param {string} loopId
     * @returns {Promise<void>}
     */
    async function closeout(loopId) {
      const yes = confirmFn('Mark this loop done? The other session gets a close notice; this cannot be undone.');
      if (!yes) return;
      const result = await apiMutate(`${apiBase}/loops/${encodeURIComponent(loopId)}/closeout`, 'POST', {});
      if (result && result.loopState) {
        const loop = (m.loops || []).find((l) => l.id === loopId);
        if (loop) {
          loop.state = result.loopState;
          loop.closeSignal = result.closeSignal || loop.closeSignal;
        }
        expandedFeedback.delete(loopId);
        feedbackDrafts.delete(loopId);
        toast('Loop ended — marked done.', false);
        const live = el('live');
        if (live) live.textContent = 'Loop ended — marked done';
        renderControl();
      } else {
        toast(`Couldn't close loop: ${api.lastError || 'the bridge rejected it'}`, true);
      }
    }

    /**
     * Delegated click handler for the loops panel's row controls.
     * @param {object} e - Click event.
     * @returns {void}
     */
    function onPanelClick(e) {
      if (e.target.closest('.medusa-panel-close')) { closePanel(); return; }
      const forceBtn = e.target.closest('.medusa-force-done');
      if (forceBtn) { forceDone(forceBtn.dataset.loopId); return; }
      const closeoutBtn = e.target.closest('.medusa-loop-closeout');
      if (closeoutBtn) { closeout(closeoutBtn.dataset.loopId); return; }
      const continueBtn = e.target.closest('.medusa-loop-continue');
      if (continueBtn) {
        const id = continueBtn.dataset.loopId;
        if (expandedFeedback.has(id)) {
          expandedFeedback.delete(id);
          feedbackDrafts.delete(id);
        } else {
          expandedFeedback.add(id);
        }
        renderPanel();
        return;
      }
      const sendBtn = e.target.closest('.medusa-loop-feedback-send');
      if (sendBtn) {
        const id = sendBtn.dataset.loopId;
        const ta = doc.getElementById(`medusaFeedback-${id}`);
        continueLoop(id, ta ? ta.value : '');
        return;
      }
      const toggleBtn = e.target.closest('.medusa-loop-transcript-toggle');
      if (toggleBtn) {
        const id = toggleBtn.dataset.loopId;
        if (expandedTranscripts.has(id)) expandedTranscripts.delete(id);
        else expandedTranscripts.add(id);
        renderPanel();
      }
    }

    /**
     * Delegated input handler for the loops panel's feedback composers (TC#561).
     * @param {object} e - Input event.
     * @returns {void}
     */
    function onPanelInput(e) {
      const ta = e.target.closest('.medusa-loop-feedback-input');
      if (ta && ta.dataset.loopId) {
        feedbackDrafts.set(ta.dataset.loopId, ta.value);
        const panel = el('loopsPanel');
        const line = panel ? Array.from(panel.querySelectorAll('.medusa-size-count'))
          .find((e2) => e2.dataset.sizeFor === ta.dataset.loopId) : null;
        renderSizeLine(line || null, { message: ta.value.trim() });
      }
    }

    /**
     * Bind once. Assumes the markup already exists — static (session) or
     * already injected by the host's own `root.innerHTML` assignment (Master).
     * @returns {boolean}
     */
    function mount() {
      if (bound) return true;
      bound = true;
      const loopBtn = el('loop');
      if (loopBtn) loopBtn.addEventListener('click', openModal);
      const launchBtn = el('launchBtn');
      if (launchBtn) launchBtn.addEventListener('click', launch);
      const cancelBtn = el('cancelBtn');
      if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
      const modeSel = el('mode');
      if (modeSel) modeSel.addEventListener('change', syncGuardMode);
      for (const key of ['task', 'done']) {
        const field = el(key);
        if (field) field.addEventListener('input', () => renderSizeLine(el('size'), payload()));
      }
      const maxMinutes = el('maxMinutes');
      if (maxMinutes) maxMinutes.addEventListener('input', () => { minutesDirty = true; });
      const chip = el('loopsChip');
      if (chip) chip.addEventListener('click', openPanel);
      const panel = el('loopsPanel');
      if (panel) {
        panel.addEventListener('click', onPanelClick);
        panel.addEventListener('input', onPanelInput);
      }
      return true;
    }

    // `launch`/`continueLoop`/`payload`/`renderSizeLine` are exposed for the
    // same reason `tcCreateMedusaControl` exposes `stateLabel`/`helpText`/
    // `renderMessages`: a test exercising the #1514 size-refusal/toast wording
    // calls them directly rather than driving a full DOM click chain through a
    // rendered panel row (`test/message-size-ui.test.js`).
    return {
      state: m, mount, onControlRender, renderChip, closeModal, closePanel,
      launch, continueLoop, payload, renderSizeLine
    };
  }

  global.tcMedusaLoopIds = tcMedusaLoopIds;
  global.tcMedusaLoopsControlMarkup = tcMedusaLoopsControlMarkup;
  global.tcMedusaLoopModalMarkup = tcMedusaLoopModalMarkup;
  global.tcCreateMedusaLoops = tcCreateMedusaLoops;
  global.tcMedusaLoopGuardPresets = MEDUSA_LOOP_GUARD_PRESETS;
})(typeof window !== 'undefined' ? window : globalThis);
