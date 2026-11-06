'use strict';
/* ── TangleClaw — Bridge reach/notification/channel settings UI (#2843 Slice 2, Car 63-C) ── */
/*
 * A standalone module, same status as `bridge-step-up.js` beside it: not
 * mounted into any page yet (Architect Scope Ruling A500-W1C-R1 defers
 * that, and any server.js/lib/tc-verbs.js singleton wiring, to #2884),
 * lift-and-run tested the same way `api-helper.js` already is.
 *
 * Four pieces, one factory, each independently loadable/saveable so a
 * future host page can mount only the sections it needs:
 *
 * 1. Batch reach opt-out + the one-time group-narrowing prompt
 *    (`lib/bridge-reach.js`).
 * 2. Global + per-project notification policy (`lib/bridge-awareness.js`,
 *    via the routes Car 63-C wired -- there is no enumerated event-kind
 *    list, so the caller names the kinds it cares about via
 *    `deps.eventKinds`, same reasoning `resolveNotificationPolicy` itself
 *    documents).
 * 3. Multi-channel watch inventory (`lib/bridge-channels.js`).
 * 4. One channel's watched messages, read-only.
 *
 * Dynamically-rendered list markup is exported as its own pure function
 * (`tcBridgeChannelItemMarkup`), the same answer `bridge-step-up.js` gives
 * to the mini-dom harness's id-extraction wall for its own dynamic list.
 */

(function (global) {
  /**
   * Markup for the settings panel's static shell: one status line and one
   * list/editor host per section, all filled by the factory's own loaders.
   * @param {string} p - Id prefix.
   * @returns {string}
   */
  function tcBridgeSettingsUiMarkup(p, projects, esc) {
    const projectOptions = (projects || []).map((proj) => `<option value="${proj.id}">${esc(proj.name)}</option>`).join('');
    return `
      <section class="bridge-settings-section" aria-label="Reach">
        <div class="bridge-settings-status" id="${p}ReachStatus" role="status"></div>
        <div class="bridge-settings-narrowing-prompt hidden" id="${p}NarrowingPrompt">
          <span id="${p}NarrowingPromptText"></span>
          <button type="button" class="btn btn-small" id="${p}NarrowingPromptDismiss">Dismiss</button>
        </div>
        <ul class="bridge-settings-project-list" id="${p}ProjectList"></ul>
        <button type="button" class="btn btn-small" id="${p}ReachOptOutBtn">Take checked projects out of reach</button>
        <button type="button" class="btn btn-small" id="${p}ReachOptInBtn">Bring checked projects back into reach</button>
      </section>
      <section class="bridge-settings-section" aria-label="Notification policy">
        <div class="bridge-settings-status" id="${p}PolicyStatus" role="status"></div>
        <label class="bridge-settings-policy-scope-label">
          Scope:
          <select id="${p}PolicyScope"><option value="">Global default</option>${projectOptions}</select>
        </label>
        <ul class="bridge-settings-policy-list" id="${p}PolicyList"></ul>
      </section>
      <section class="bridge-settings-section" aria-label="Watched channels">
        <div class="bridge-settings-status" id="${p}ChannelsStatus" role="status"></div>
        <ul class="bridge-settings-channel-list" id="${p}ChannelList"></ul>
        <input type="text" id="${p}NewChannelId" placeholder="Channel id">
        <input type="text" id="${p}NewChannelName" placeholder="Name">
        <select id="${p}NewChannelMode"><option value="watch-only">watch-only</option><option value="two-way">two-way</option></select>
        <button type="button" class="btn btn-small" id="${p}RegisterChannelBtn">Register channel</button>
      </section>`;
  }

  /**
   * Markup for one project row in the batch opt-out list -- exported for
   * the same mini-dom reason `bridge-step-up.js`'s own item markup is.
   * @param {string} p - Id prefix.
   * @param {{id: number, name: string}} project
   * @param {boolean} outOfReach - Whether this project is currently opted out.
   * @param {Function} esc - HTML-escaping function.
   * @returns {string}
   */
  function tcBridgeReachProjectMarkup(p, project, outOfReach, esc) {
    return `
      <li class="bridge-settings-project-row">
        <label>
          <input type="checkbox" id="${p}ProjectCheck_${project.id}">
          ${esc(project.name)} ${outOfReach ? '<em>(out of reach)</em>' : ''}
        </label>
      </li>`;
  }

  /**
   * Markup for one notification-policy row -- exported for the same
   * mini-dom reason {@link tcBridgeChannelItemMarkup} is: the list host's
   * own innerHTML is replaced wholesale every `loadNotificationPolicy()`.
   * One toggle button, labelled by the OPPOSITE of the current state
   * (`answer.enabled`); a "Clear override" button appears only when the
   * current scope is a project AND that kind's resolution actually came
   * from a project-level override (`answer.source === 'project'`) -- there
   * is nothing to clear from the global layer, and clearing a GLOBAL kind
   * no project has overridden would silently do nothing.
   * @param {string} p - Id prefix.
   * @param {string} kind - Event kind.
   * @param {{enabled: boolean, source: string}|null} answer - A `resolveNotificationPolicy` result, or null if unread.
   * @param {boolean} scoped - Whether the current scope is a project (not global).
   * @param {Function} esc - HTML-escaping function.
   * @returns {string}
   */
  function tcBridgeNotificationPolicyItemMarkup(p, kind, answer, scoped, esc) {
    const stateText = answer ? `${answer.enabled ? 'on' : 'off'} (${esc(answer.source)})` : 'unknown (unread)';
    const toggleLabel = answer && answer.enabled ? 'Turn off' : 'Turn on';
    const clearBtn = scoped && answer && answer.source === 'project'
      ? ` <button type="button" class="btn btn-small" id="${p}PolicyClear_${kind}">Clear override</button>`
      : '';
    return `
      <li class="bridge-settings-policy-row">
        ${esc(kind)}: ${stateText}
        <button type="button" class="btn btn-small" id="${p}PolicyToggle_${kind}">${toggleLabel}</button>${clearBtn}
      </li>`;
  }

  /**
   * Markup for one watched channel row -- exported for the same reason.
   * @param {string} p - Id prefix.
   * @param {object} channel - `lib/bridge-channels.js#getChannel`'s own shape.
   * @param {Function} esc - HTML-escaping function.
   * @returns {string}
   */
  function tcBridgeChannelItemMarkup(p, channel, esc) {
    return `
      <li class="bridge-settings-channel-row" id="${p}Channel_${channel.channelId}">
        <strong>${esc(channel.name)}</strong> (${esc(channel.mode)}${channel.sendAllowed ? ', send-allowed' : ''})
        <button type="button" class="btn btn-small" id="${p}ToggleSend_${channel.channelId}">
          ${channel.sendAllowed ? 'Revoke send' : 'Allow send'}
        </button>
      </li>`;
  }

  /**
   * Create a bridge settings panel bound to one surface.
   * @param {object} deps
   * @param {Document} [deps.doc] - Owning document (defaults to global).
   * @param {string} deps.rootId - Id of the element to render into.
   * @param {string} deps.prefix - Id prefix for this surface's controls.
   * @param {Function} deps.api - GET helper returning parsed JSON or null.
   * @param {Function} [deps.apiMutate] - Mutating helper; without it every write is inert.
   * @param {Function} [deps.esc] - HTML-escaping function; defaults to the identity.
   * @param {{id: number, name: string}[]} [deps.projects] - The project list to show in the reach section (a host page's own `/api/projects` read -- out of this car's envelope to fetch itself).
   * @param {string[]} [deps.eventKinds] - The notification event kinds this host page cares about; there is no enumerated list to discover them from.
   * @returns {object} Every load/save function, by section.
   */
  function tcCreateBridgeSettingsUi(deps) {
    const doc = deps.doc || global.document;
    const p = deps.prefix;
    const esc = deps.esc || ((s) => String(s));
    const el = (suffix) => doc.getElementById(p + suffix);
    const projects = Array.isArray(deps.projects) ? deps.projects : [];
    const eventKinds = Array.isArray(deps.eventKinds) ? deps.eventKinds : [];
    let channels = [];

    /**
     * Render the static shell into the root. Idempotent.
     * @returns {boolean} True when the panel is present after this call.
     */
    function mount() {
      const root = doc.getElementById(deps.rootId);
      if (!root) return false;
      if (!el('ReachStatus')) {
        root.innerHTML = tcBridgeSettingsUiMarkup(p, projects, esc);
        // The scope <select> is part of the STATIC shell, built once per
        // mount -- unlike the per-kind toggle/clear buttons below, which are
        // rebound every `loadNotificationPolicy()` because the dynamic list
        // host's innerHTML (and everything inside it) is replaced wholesale
        // each time.
        const scopeEl = el('PolicyScope');
        if (scopeEl) scopeEl.addEventListener('change', () => loadNotificationPolicy());
      }
      return true;
    }

    // ── Reach: batch opt-out + narrowing prompt ──

    /**
     * Load the narrowing prompt's current answer and the project list
     * (checked against each project's current opt-out state).
     * @returns {Promise<void>}
     */
    async function loadReach() {
      if (!deps.api) return;
      const [prompt, status] = await Promise.all([
        deps.api('/api/bridge/operator/reach/narrowing-prompt'),
        deps.api('/api/bridge/operator/status')
      ]);
      const promptEl = el('NarrowingPrompt');
      if (promptEl) promptEl.classList.toggle('hidden', !(prompt && prompt.shouldPrompt));
      const promptText = el('NarrowingPromptText');
      if (promptText && prompt && prompt.shouldPrompt) {
        promptText.textContent = prompt.suggested && prompt.suggested.type === 'group'
          ? `Narrow bridge activation to "${prompt.suggested.groupName}"?` : 'Narrow bridge activation to one project group?';
      }
      const outOfReachIds = new Set((status && status.reach && status.reach.optouts || []).map((o) => o.projectId));
      const list = el('ProjectList');
      if (list) list.innerHTML = projects.map((proj) => tcBridgeReachProjectMarkup(p, proj, outOfReachIds.has(proj.id), esc)).join('');
    }

    /** @returns {Promise<void>} */
    async function dismissNarrowingPrompt() {
      if (!deps.apiMutate) return;
      await deps.apiMutate('/api/bridge/operator/reach/narrowing-prompt/dismiss', 'POST', {});
      await loadReach();
    }

    /**
     * Take every CHECKED project in and out of reach.
     * @param {boolean} outOfReach
     * @returns {Promise<boolean>} True on success.
     */
    async function setReachBatch(outOfReach) {
      if (!deps.apiMutate) return false;
      const projectIds = projects.filter((proj) => {
        const checkbox = el(`ProjectCheck_${proj.id}`);
        return checkbox && checkbox.checked;
      }).map((proj) => proj.id);
      if (projectIds.length === 0) return false;
      const result = await deps.apiMutate('/api/bridge/operator/reach/batch', 'POST', { projectIds, outOfReach });
      if (!result) return false;
      await loadReach();
      return true;
    }

    // ── Notification policy ──

    /**
     * Load the policy for every named `deps.eventKinds` kind, at whatever
     * scope the `${p}PolicyScope` select currently names -- global (the
     * default, no selector yet mounted) or one project.
     * @returns {Promise<void>}
     */
    async function loadNotificationPolicy() {
      if (!deps.api) return;
      const scopeEl = el('PolicyScope');
      const scopeProjectId = scopeEl && scopeEl.value ? scopeEl.value : '';
      const qs = scopeProjectId ? `?projectId=${encodeURIComponent(scopeProjectId)}` : '';
      const answers = await Promise.all(
        eventKinds.map((kind) => deps.api(`/api/bridge/operator/notification-policy/${encodeURIComponent(kind)}${qs}`))
      );
      const list = el('PolicyList');
      if (list) {
        list.innerHTML = eventKinds.map((kind, i) => tcBridgeNotificationPolicyItemMarkup(p, kind, answers[i], !!scopeProjectId, esc)).join('');
      }
      _bindPolicyRows(answers, scopeProjectId);
    }

    /**
     * Bind each rendered policy row's toggle/clear buttons directly, by the
     * unique id {@link tcBridgeNotificationPolicyItemMarkup} gave them --
     * fresh every `loadNotificationPolicy()`, the same reason
     * {@link _bindChannelRows} rebinds its own list each render.
     * @param {Array<{enabled: boolean, source: string}|null>} answers - This load's own answers, same order as `eventKinds`.
     * @param {string} scopeProjectId - The scope select's current value ('' for global).
     * @returns {void}
     */
    function _bindPolicyRows(answers, scopeProjectId) {
      eventKinds.forEach((kind, i) => {
        const answer = answers[i];
        const toggleBtn = el(`PolicyToggle_${kind}`);
        if (toggleBtn) {
          toggleBtn.addEventListener('click', () => {
            const nextEnabled = !(answer && answer.enabled);
            if (scopeProjectId) setProjectNotificationOverride(Number(scopeProjectId), kind, nextEnabled);
            else setGlobalNotificationPolicy(kind, nextEnabled);
          });
        }
        const clearBtn = el(`PolicyClear_${kind}`);
        if (clearBtn) clearBtn.addEventListener('click', () => setProjectNotificationOverride(Number(scopeProjectId), kind, null));
      });
    }

    /**
     * Set the fleet-wide global default for one event kind.
     * @param {string} eventKind
     * @param {boolean} enabled
     * @returns {Promise<boolean>} True on success.
     */
    async function setGlobalNotificationPolicy(eventKind, enabled) {
      if (!deps.apiMutate) return false;
      const result = await deps.apiMutate('/api/bridge/operator/notification-policy/global', 'POST', { eventKind, enabled });
      if (!result) return false;
      await loadNotificationPolicy();
      return true;
    }

    /**
     * Set, or clear, one project's override for one event kind.
     * @param {number} projectId
     * @param {string} eventKind
     * @param {boolean|null} enabled - `null` clears the override.
     * @returns {Promise<boolean>} True on success.
     */
    async function setProjectNotificationOverride(projectId, eventKind, enabled) {
      if (!deps.apiMutate) return false;
      const result = await deps.apiMutate(`/api/bridge/operator/notification-policy/project/${encodeURIComponent(projectId)}`, 'POST', { eventKind, enabled });
      return Boolean(result);
    }

    // ── Watched channels ──

    /**
     * Bind each rendered channel row's toggle-send button directly, by
     * the unique id {@link tcBridgeChannelItemMarkup} gave it -- fresh
     * every `loadChannels()`, the same reason `bridge-step-up.js` rebinds
     * its own list each render.
     * @returns {void}
     */
    function _bindChannelRows() {
      for (const channel of channels) {
        const btn = el(`ToggleSend_${channel.channelId}`);
        if (btn) btn.addEventListener('click', () => updateChannel(channel.channelId, { sendAllowed: !channel.sendAllowed }));
      }
    }

    /** @returns {Promise<void>} */
    async function loadChannels() {
      if (!deps.api) return;
      const result = await deps.api('/api/bridge/operator/channels');
      const status = el('ChannelsStatus');
      if (!result) {
        if (status) status.textContent = deps.api.lastError || 'Could not load watched channels.';
        return;
      }
      channels = result.channels || [];
      if (status) status.textContent = channels.length ? `${channels.length} watched channel(s)` : 'No watched channels';
      const list = el('ChannelList');
      if (list) list.innerHTML = channels.map((ch) => tcBridgeChannelItemMarkup(p, ch, esc)).join('');
      _bindChannelRows();
    }

    /**
     * Register a new watched channel from the form fields.
     * @returns {Promise<boolean>} True on success.
     */
    async function registerChannelFromForm() {
      if (!deps.apiMutate) return false;
      const channelId = el('NewChannelId');
      const name = el('NewChannelName');
      const mode = el('NewChannelMode');
      if (!channelId || !channelId.value) return false;
      const result = await deps.apiMutate('/api/bridge/operator/channels', 'POST', {
        channelId: channelId.value.trim(), guildId: deps.guildId || '', name: (name && name.value.trim()) || channelId.value.trim(),
        mode: (mode && mode.value) || 'watch-only'
      });
      if (!result) return false;
      await loadChannels();
      return true;
    }

    /**
     * Update one channel's fields (e.g. toggling `sendAllowed`).
     * @param {string} channelId
     * @param {object} patch
     * @returns {Promise<boolean>} True on success.
     */
    async function updateChannel(channelId, patch) {
      if (!deps.apiMutate) return false;
      const result = await deps.apiMutate(`/api/bridge/operator/channels/${encodeURIComponent(channelId)}`, 'PATCH', patch);
      if (!result) return false;
      await loadChannels();
      return true;
    }

    /**
     * The messages watched in one channel, read-only.
     * @param {string} channelId
     * @returns {Promise<object[]>}
     */
    async function loadWatchedMessages(channelId) {
      if (!deps.api) return [];
      const result = await deps.api(`/api/bridge/operator/channels/${encodeURIComponent(channelId)}/watched-messages`);
      return (result && result.messages) || [];
    }

    return {
      mount, loadReach, dismissNarrowingPrompt, setReachBatch,
      loadNotificationPolicy, setGlobalNotificationPolicy, setProjectNotificationOverride,
      loadChannels, registerChannelFromForm, updateChannel, loadWatchedMessages
    };
  }

  global.tcBridgeSettingsUiMarkup = tcBridgeSettingsUiMarkup;
  global.tcBridgeReachProjectMarkup = tcBridgeReachProjectMarkup;
  global.tcBridgeNotificationPolicyItemMarkup = tcBridgeNotificationPolicyItemMarkup;
  global.tcBridgeChannelItemMarkup = tcBridgeChannelItemMarkup;
  global.tcCreateBridgeSettingsUi = tcCreateBridgeSettingsUi;
})(typeof window !== 'undefined' ? window : globalThis);
