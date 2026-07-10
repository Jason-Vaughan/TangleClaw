'use strict';
/* ── TangleClaw v3 — Landing Page: Core & Data ── */
/* State management, API helpers, data loading, project actions. */
/* Loaded before ui.js which handles rendering and interactions. */

// ── State ──

const state = {
  projects: [],
  engines: [],
  methodologies: [],
  config: null,
  filterText: '',
  activeTag: null,
  showUnregistered: false,
  allTags: [],
  connected: true,
  statsOpen: true,
  ports: [],
  portsOpen: false,
  portGroupsOpen: {},
  rulesOpen: false,
  globalRulesContent: '',
  sessionRulesOpen: false,
  sessionRules: [],
  modelStatus: {},
  groups: [],
  groupsOpen: false,
  groupItemsOpen: {},
  openclawConnections: [],
  openclawOpen: false,
  openclawItemsOpen: {},
  openclawTunnelStatus: {},
  auditOpen: false,
  auditSummaries: {},
  auditLoaded: false,
  orphanHooks: null,
  orphanHooksRepairInFlight: false,
  // #235 — cached restart-mechanism token from /api/server-info. `null`
  // means no mechanism available on this host (button hidden);
  // `'launchctl'` enables the macOS path. Read by both the stale-server
  // banner and the global settings modal Diagnostics section.
  restartMechanism: null,
  restartInFlight: false
};

// ── API Helpers ──
// Bound from the shared factory in /api-helper.js (loaded before this file).
// `setConnected` is a function declaration below and is hoisted, so the
// factory captures the live reference. See PR for #82 for rationale.

const api = window.tcCreateApi({ setConnected });
const apiMutate = window.tcCreateApiMutate(api);

// ── Connection State ──

let reconnectTimer = null;

function setConnected(connected) {
  if (state.connected === connected) return;
  state.connected = connected;
  const toast = document.getElementById('toast');
  if (!connected) {
    toast.textContent = 'Connection lost. Retrying\u2026';
    toast.className = 'toast toast-warn visible';
    if (!reconnectTimer) {
      reconnectTimer = true; // sentinel
      (function reconnectLoop() {
        if (!reconnectTimer) return;
        reconnectTimer = setTimeout(async () => {
          if (!reconnectTimer) return;
          await loadProjects();
          reconnectLoop();
        }, 5000);
      })();
    }
  } else {
    toast.textContent = 'Reconnected';
    toast.className = 'toast toast-ok visible';
    if (reconnectTimer) {
      if (reconnectTimer !== true) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setTimeout(() => { toast.classList.remove('visible'); }, 3000);
  }
}

// ── Data Loading ──

async function loadVersion() {
  const data = await api('/api/version');
  if (data) {
    document.getElementById('version').textContent = `v${data.version}`;
  }
}

/**
 * Fetch server-info, cache the restart mechanism (#235), and render the
 * stale-server banner (#199) when the running process's startup SHA
 * differs from the current on-disk HEAD. No-op on the no-git fallback
 * (`startupSha === null`) or when the endpoint isn't available (older
 * server without the route).
 *
 * `restartMechanism` is cached on `state` even when the banner doesn't
 * fire — the global settings modal Diagnostics section reads it
 * independently. Older servers without #235 return undefined here,
 * which falls through to `null` and hides the button cleanly.
 */
async function loadServerInfo() {
  const data = await api('/api/server-info');
  if (!data) return;
  state.restartMechanism = (typeof data.restartMechanism === 'string' && data.restartMechanism.length > 0)
    ? data.restartMechanism
    : null;
  // AUTH-3: show "Logged in as <user>" when behind the Caddy login gate.
  // `currentUser` is null unless the gate is live (the server-side trust gate
  // never honors a direct-mode header), so this is hidden in direct mode.
  renderAuthUser(data.currentUser);
  // AUTH-2K9D: warn when auth is configured but not actually enforcing.
  renderAuthStatus(data.authStatus);
  if (!data.isStale) return;
  renderStaleServerBanner(data);
}

/**
 * Human-readable warning for an auth config-vs-live mismatch (AUTH-2K9D), or null
 * for the healthy/expected states (`off`, `live`, or an older server that omits
 * `authStatus`). Text carries the meaning so the chip is not color-only (a11y).
 * @param {string|null|undefined} authStatus
 * @returns {string|null}
 */
function _authStatusWarning(authStatus) {
  if (authStatus === 'configured-inert') {
    return '⚠ Auth enabled but direct mode is not enforcing it — run the Caddy cutover to activate the login gate.';
  }
  if (authStatus === 'configured-no-identity') {
    return '⚠ Auth gate is up but no identity is arriving — the live Caddyfile may be missing "header_up X-Auth-User".';
  }
  return null;
}

/**
 * Show or hide the auth config-vs-live mismatch warning chip (AUTH-2K9D). Purely
 * state-driven: it mirrors the latest `/api/server-info` poll and self-clears when
 * the mismatch resolves (cutover runs / header fixed). No dismiss control and no
 * timer — removing the cause removes the chip on the next poll.
 * @param {string|null|undefined} authStatus
 */
function renderAuthStatus(authStatus) {
  const el = document.getElementById('authStatusWarning');
  if (!el) return;
  const msg = _authStatusWarning(authStatus);
  if (msg) {
    el.textContent = msg;
    el.title = msg;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

/**
 * Show or hide the "Logged in as <user>" chip in the dashboard bar (AUTH-3).
 * Hidden whenever there is no authenticated user (direct mode / gate off).
 * The username is escaped before it reaches innerHTML.
 * @param {string|null|undefined} user
 */
function renderAuthUser(user) {
  const el = document.getElementById('authUser');
  if (!el) return;
  if (typeof user === 'string' && user.length > 0) {
    el.innerHTML = `&#128100; ${esc(user)}`;  // 👤 logged-in user
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

/**
 * Format a non-negative integer of seconds as a compact "Xh Ym" /
 * "Xm Ys" / "Xs" string. Used by the stale-server banner so the
 * operator sees at a glance how long the running process has been
 * out of date.
 * @param {number} totalSec
 * @returns {string}
 */
function formatUptime(totalSec) {
  const s = Math.max(0, Number(totalSec) | 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/**
 * Populate + reveal the stale-server banner. Defensive-by-default:
 * every value that ends up in `innerHTML` is either passed through
 * `esc()` (strings) or cast to a clamped integer (numerics). The
 * server-side source already produces sane shapes, but the boundary
 * cast here matches the broader rest-of-file convention so a future
 * server bug that leaks a non-numeric `commitsAhead` cannot inject
 * markup.
 *
 * @param {{startupSha: string|null, currentDiskSha: string|null, commitsAhead: number, uptimeSeconds: number|null}} info
 */
function renderStaleServerBanner(info) {
  const banner = document.getElementById('staleServerBanner');
  const textEl = document.getElementById('staleServerBannerText');
  if (!banner || !textEl) return;

  const commitsAhead = Math.max(0, Number(info.commitsAhead) | 0);
  const aheadStr = commitsAhead > 0
    ? `${commitsAhead} new commit${commitsAhead === 1 ? '' : 's'} on disk`
    : 'newer code on disk';
  const shortStartup = info.startupSha ? esc(info.startupSha.slice(0, 7)) : '?';
  const shortDisk = info.currentDiskSha ? esc(info.currentDiskSha.slice(0, 7)) : '?';
  const uptimeStr = (typeof info.uptimeSeconds === 'number' && info.uptimeSeconds >= 0)
    ? ` Running for ${esc(formatUptime(info.uptimeSeconds))}.`
    : '';

  textEl.innerHTML =
    '⚠ <strong>TC server is out of date.</strong> ' +
    `Running <code>${shortStartup}</code>; <code>${shortDisk}</code> on disk ` +
    `(${aheadStr}).${uptimeStr} Restart TC to load the latest code.`;
  banner.classList.remove('hidden');

  // #235 — toggle the restart button visibility based on the
  // restart-mechanism token captured in loadServerInfo. The button is
  // hidden when no mechanism is available (e.g. Linux today,
  // bare-node), so operators on those hosts see text-only guidance
  // rather than an action that would 501.
  const restartBtn = document.getElementById('staleServerRestartBtn');
  if (restartBtn) {
    const mech = (typeof info.restartMechanism === 'string' && info.restartMechanism.length > 0)
      ? info.restartMechanism
      : null;
    if (mech) {
      restartBtn.classList.remove('hidden');
    } else {
      restartBtn.classList.add('hidden');
    }
  }
}

/**
 * Trigger a TC server restart (#235) and poll /api/server-info until
 * the new process is up. On success, full-page reload so the browser
 * picks up any fresh static assets. On failure, restore the button
 * and surface an alert.
 *
 * Idempotent — guarded by `state.restartInFlight` so double-clicks
 * (banner + modal + accidental retry) coalesce to one POST.
 *
 * @returns {Promise<void>}
 */
async function triggerServerRestart() {
  if (state.restartInFlight) return;
  state.restartInFlight = true;

  // Re-query inside setBtnState rather than capturing references at
  // function entry — if the user opens the global settings modal
  // *after* clicking the banner restart, the modal button (`gsRestartBtn`)
  // won't exist at capture time but DOES exist later. Re-querying
  // every call keeps both surfaces in sync. Critic-caught on #235 PR.
  const setBtnState = (label, disabled) => {
    for (const id of ['staleServerRestartBtn', 'gsRestartBtn']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.textContent = label;
      btn.disabled = disabled;
    }
  };

  setBtnState('Restarting…', true);

  // Confirm dialog so an accidental click doesn't kill the operator's
  // browser session mid-task.
  const proceed = window.confirm(
    'Restart TangleClaw?\n\n' +
    'Active tmux sessions will survive the restart; the browser will reconnect when the server returns (~3 seconds).'
  );
  if (!proceed) {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
    return;
  }

  // Capture the startup SHA we expect to be replaced. After restart
  // the new process will have a fresh `startedAt`, which is what
  // signals "we're back" — comparing startedAt is more reliable than
  // comparing SHA (the SHA might happen to match if the operator
  // restarted without pulling new code).
  //
  // Bail out if the pre-fetch fails. Without a baseline `startedAt`,
  // the poll comparison `info.startedAt !== null` would be trivially
  // true on the first successful response, causing a false-positive
  // page reload that hides whatever connectivity problem prevented
  // the pre-fetch. Critic-caught on #235 PR.
  let oldStartedAt = null;
  try {
    const pre = await api('/api/server-info');
    if (pre && pre.startedAt) oldStartedAt = pre.startedAt;
  } catch { /* fall through to the null-baseline check below */ }
  if (!oldStartedAt) {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
    window.alert('Could not read server state before restart. Aborting — check that TC is reachable, then try again.');
    return;
  }

  let postResp;
  try {
    postResp = await apiMutate('/api/server/restart', 'POST', {});
  } catch (err) {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
    window.alert(`Restart failed: ${err && err.message ? err.message : 'request did not complete'}`);
    return;
  }
  if (!postResp || !postResp.ok) {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
    const msg = (postResp && postResp.error) || api.lastError || 'unknown error';
    window.alert(`Restart not started: ${msg}`);
    return;
  }

  pollServerBackAndReload(oldStartedAt, () => {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
  });
}

/**
 * Poll `/api/server-info` until the process reports a `startedAt` different from
 * `oldStartedAt` (the new process is up), then full-reload so the browser picks
 * up any fresh static assets. Shared by `triggerServerRestart` (#235) and
 * `applyUpdateAndRestart` (UB, #228/#229).
 *
 * **No timer-driven blind reload** (no-UI-timers rule, #98/#268): without a
 * baseline `startedAt` we can't detect when the new process is actually up, so
 * we abort honestly (let the operator refresh) rather than reload onto a
 * possibly-dead server. `restore` clears the in-flight flag and restores the
 * caller's button on any give-up path.
 *
 * 30 polls at 500ms = 15s of patience; the restart itself typically takes ~3s.
 * Each poll tolerates a failed fetch (the in-between window when the old process
 * is dead but the new one hasn't bound the port yet).
 *
 * @param {string|null} oldStartedAt - Pre-restart `startedAt` baseline
 * @param {() => void} restore - Clears `restartInFlight` + restores the caller's button
 */
function pollServerBackAndReload(oldStartedAt, restore) {
  if (!oldStartedAt) {
    restore();
    window.alert('Could not read server state to confirm the restart. The server may still be coming back — refresh the page in a moment to check.');
    return;
  }
  const POLL_INTERVAL_MS = 500;
  const POLL_MAX_ATTEMPTS = 30;
  let attempt = 0;
  const poll = setInterval(async () => {
    attempt++;
    try {
      const info = await api('/api/server-info');
      if (info && info.startedAt && info.startedAt !== oldStartedAt) {
        clearInterval(poll);
        window.location.reload();
        return;
      }
    } catch { /* expected during the dead window */ }
    if (attempt >= POLL_MAX_ATTEMPTS) {
      clearInterval(poll);
      restore();
      window.alert('Restart did not complete within 15 seconds. The server may still be coming back — refresh in a moment.');
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Fetch update status and show notification pill if an update is available.
 * Dismissed state is persisted in localStorage keyed by version. The version
 * text is wrapped in an anchor to the GitHub release page (#149) when the
 * backend supplies a `releaseUrl` — falls back to plain text otherwise so
 * pre-#149 servers or non-GitHub remotes still surface the notification.
 */
async function loadUpdateStatus() {
  const data = await api('/api/update-status');
  if (!data || !data.updateAvailable || !data.latestVersion) return;

  const dismissKey = `tc_updateDismissed_${data.latestVersion}`;
  if (localStorage.getItem(dismissKey)) return;

  const pill = document.getElementById('updatePill');
  if (!pill) return;

  const versionLabel = `v${esc(data.latestVersion)}`;
  const versionHtml = data.releaseUrl
    ? `<a class="update-pill-link" href="${esc(data.releaseUrl)}" target="_blank" rel="noopener noreferrer" title="View release notes">${versionLabel}</a>`
    : versionLabel;

  pill.innerHTML = `${versionHtml} available `
    + `<button class="update-pill-apply" id="updateApplyBtn">Update &amp; restart</button> `
    + `<button class="update-pill-dismiss" aria-label="Dismiss">&times;</button>`;
  pill.classList.remove('hidden');

  // UB (#228/#229): the actionable self-update. The git fetch+checkout is the
  // server-side action this button adds; the restart half reuses the proven
  // #235 path. The data closure carries the target version for the confirm.
  const applyBtn = pill.querySelector('#updateApplyBtn');
  if (applyBtn) {
    applyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyUpdateAndRestart(data);
    });
  }

  pill.querySelector('.update-pill-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    pill.classList.add('hidden');
    localStorage.setItem(dismissKey, '1');
  });
}

/**
 * UB (#228/#229): apply the latest release, then restart onto it — one operator
 * gesture. `POST /api/update/apply` (fetch + checkout the tag) → on success
 * `POST /api/server/restart` (the existing #235 path) → poll `/api/server-info`
 * until the new process is up → full reload onto the fresh assets. A refused
 * safety guard (409: dirty tree / no update / wrong ref / no git) surfaces its
 * reason and restores the button; the working tree is never touched on a refusal.
 *
 * Idempotent via `state.restartInFlight` (shared with the #235 stale-server
 * restart, so the two paths can't fire concurrently).
 *
 * @param {object} data - The /api/update-status payload (carries latestVersion)
 * @returns {Promise<void>}
 */
async function applyUpdateAndRestart(data) {
  if (state.restartInFlight) return;

  const setBtn = (label, disabled) => {
    const btn = document.getElementById('updateApplyBtn');
    if (btn) { btn.textContent = label; btn.disabled = disabled; }
  };

  const proceed = window.confirm(
    `Update TangleClaw to v${data.latestVersion} and restart?\n\n` +
    'TC fetches the release, switches the checkout to it, and restarts. Active tmux ' +
    'sessions survive; the browser reconnects when the server returns (~3 seconds).'
  );
  if (!proceed) return;

  state.restartInFlight = true;
  setBtn('Updating…', true);

  // 1. Apply — fetch + checkout the latest tag (no restart yet).
  let applyResp;
  try {
    applyResp = await apiMutate('/api/update/apply', 'POST', {});
  } catch (err) {
    state.restartInFlight = false;
    setBtn('Update & restart', false);
    window.alert(`Update failed: ${err && err.message ? err.message : 'request did not complete'}`);
    return;
  }
  if (!applyResp || !applyResp.ok) {
    state.restartInFlight = false;
    setBtn('Update & restart', false);
    const msg = (applyResp && applyResp.error) || api.lastError || 'unknown error';
    window.alert(`Update not applied: ${msg}`);
    return;
  }

  // 2. Capture the baseline startedAt, then restart onto the new code.
  setBtn('Restarting…', true);
  const appliedLabel = applyResp.toRef || `v${data.latestVersion}`;
  let oldStartedAt = null;
  try {
    const pre = await api('/api/server-info');
    if (pre && pre.startedAt) oldStartedAt = pre.startedAt;
  } catch { /* fall through to the manual-restart message below */ }

  let restartResp;
  try {
    restartResp = await apiMutate('/api/server/restart', 'POST', {});
  } catch (err) {
    restartResp = null;
    api.lastError = err && err.message;
  }
  if (!restartResp || !restartResp.ok) {
    // The code IS updated on disk; only the auto-restart didn't fire (e.g. no
    // restart mechanism on this host). Degrade honestly to the #199 stale path.
    state.restartInFlight = false;
    setBtn('Update & restart', false);
    const msg = (restartResp && restartResp.error) || api.lastError || 'no restart mechanism';
    window.alert(`Updated to ${appliedLabel} on disk, but auto-restart didn't run (${msg}). Restart TangleClaw to finish.`);
    return;
  }

  // 3. Poll until the new process reports a fresh startedAt, then reload —
  // via the shared helper (no timer-driven blind reload; #98/#268).
  pollServerBackAndReload(oldStartedAt, () => {
    state.restartInFlight = false;
    setBtn('Update & restart', false);
  });
}

async function loadStats() {
  const data = await api('/api/system');
  if (!data) return;

  const cpuPct = typeof data.cpu.usage === 'number' ? data.cpu.usage : 0;
  const memPct = typeof data.memory.percent === 'number' ? data.memory.percent : 0;
  const diskPct = typeof data.disk.percent === 'number' ? data.disk.percent : 0;

  setStatValue('statCpu', `${Math.round(cpuPct)}%`, cpuPct, 'statCpuBar');
  setStatValue('statMem', `${Math.round(memPct)}%`, memPct, 'statMemBar');
  setStatValue('statDisk', `${Math.round(diskPct)}%`, diskPct, 'statDiskBar');
  document.getElementById('statUptime').textContent = data.uptimeFormatted || formatUptime(data.uptime);
}

function setStatValue(valueId, text, pct, barId) {
  const el = document.getElementById(valueId);
  const bar = document.getElementById(barId);
  const colorClass = pct > 85 ? 'stat-red' : pct > 65 ? 'stat-amber' : 'stat-green';
  const fillClass = pct > 85 ? 'fill-red' : pct > 65 ? 'fill-amber' : 'fill-green';
  el.textContent = text;
  el.className = `stat-value ${colorClass}`;
  if (bar) {
    bar.style.width = `${Math.min(pct, 100)}%`;
    bar.className = `stat-bar-fill ${fillClass}`;
  }
}

function formatUptime(seconds) {
  if (typeof seconds !== 'number') return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function loadPorts() {
  const data = await api('/api/ports');
  if (!data) return;
  state.ports = data.leases || [];
  document.getElementById('portsCount').textContent = state.ports.length;
  renderPorts();
}

/**
 * Load global rules content from the API.
 */
async function loadGlobalRules() {
  const data = await api('/api/rules/global');
  if (data) {
    state.globalRulesContent = data.content || '';
    const editor = document.getElementById('rulesEditor');
    if (editor) editor.value = state.globalRulesContent;
  }
}

/**
 * Save global rules to the API.
 */
async function saveGlobalRules() {
  const editor = document.getElementById('rulesEditor');
  const content = editor.value;
  const data = await apiMutate('/api/rules/global', 'PUT', { content });
  const status = document.getElementById('rulesStatus');
  if (data) {
    state.globalRulesContent = content;
    status.textContent = 'Saved';
    status.className = 'rules-status rules-status-ok';
  } else {
    status.textContent = 'Save failed';
    status.className = 'rules-status rules-status-err';
  }
  status.classList.remove('hidden');
  setTimeout(() => { status.classList.add('hidden'); }, 3000);
}

/**
 * Reset global rules to defaults via the API.
 */
async function resetGlobalRules() {
  const data = await apiMutate('/api/rules/global/reset', 'POST', {});
  const status = document.getElementById('rulesStatus');
  if (data) {
    state.globalRulesContent = data.content || '';
    document.getElementById('rulesEditor').value = state.globalRulesContent;
    status.textContent = 'Reset to defaults';
    status.className = 'rules-status rules-status-ok';
  } else {
    status.textContent = 'Reset failed';
    status.className = 'rules-status rules-status-err';
  }
  status.classList.remove('hidden');
  setTimeout(() => { status.classList.add('hidden'); }, 3000);
}

// ── Session Rules (#347/D1a) ──

/**
 * Load global session rules from the API and render the list.
 */
async function loadSessionRules() {
  const data = await api('/api/session-rules?scope=global');
  if (!data) return;
  state.sessionRules = data.rules || [];
  const countEl = document.getElementById('sessionRulesCount');
  if (countEl) countEl.textContent = state.sessionRules.filter((r) => r.enabled).length;
  renderSessionRules();
}

/**
 * Render the session rules list into #sessionRulesList.
 */
function renderSessionRules() {
  const list = document.getElementById('sessionRulesList');
  if (!list) return;
  if (state.sessionRules.length === 0) {
    list.innerHTML = '<p class="session-rules-empty">No session rules yet. Add one below.</p>';
    return;
  }
  list.innerHTML = state.sessionRules.map((rule) => `
    <div class="session-rule-item${rule.enabled ? '' : ' session-rule-disabled'}" data-rule-id="${rule.id}">
      <label class="session-rule-toggle">
        <input type="checkbox" data-action="toggle" data-rule-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
      </label>
      <span class="session-rule-content">${rule.createdBy === 'ai' ? '<span class="session-rule-badge" title="AI-authored (D1b)">AI</span> ' : ''}${esc(rule.content)}</span>
      <button class="btn btn-small session-rule-history" data-action="history" data-rule-id="${rule.id}" aria-label="Version history">History</button>
      <button class="btn btn-small btn-danger session-rule-delete" data-action="delete" data-rule-id="${rule.id}" aria-label="Delete rule">&times;</button>
    </div>
    <div class="session-rule-versions hidden" id="sessionRuleVersions-${rule.id}" data-rule-id="${rule.id}"></div>
  `).join('');
}

/**
 * Toggle + load the version history for a rule (D1b).
 * @param {number} id - Rule id
 */
async function toggleSessionRuleVersions(id) {
  const container = document.getElementById(`sessionRuleVersions-${id}`);
  if (!container) return;
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    return;
  }
  const data = await api(`/api/session-rules/${id}/versions`);
  renderSessionRuleVersions(id, data ? data.versions || [] : []);
  container.classList.remove('hidden');
}

/**
 * Presentation for a version's Critic-gate attestation (SR-7K2P). Records, never
 * enforces — the server can't summon a Critic, so this is the AI's apply-time
 * attestation surfaced for the operator to audit.
 * @param {string} criticGate - 'passed' | 'not-required' | 'unknown'
 * @returns {{label: string, cls: string, title: string}}
 */
function _criticGateBadge(criticGate) {
  switch (criticGate) {
    case 'passed':
      return { label: '✓ Critic-reviewed', cls: 'gate-passed', title: 'AI edit attested as passing the Critic gate' };
    case 'not-required':
      return { label: '— not required', cls: 'gate-not-required', title: 'Operator/trivial edit that legitimately skips the Critic gate' };
    default:
      return { label: '? unknown', cls: 'gate-unknown', title: 'Legacy edit, or an AI edit applied with no Critic attestation' };
  }
}

/**
 * Render a rule's version list with restore buttons (D1b) and Critic-gate
 * provenance badges (SR-7K2P).
 * @param {number} id - Rule id
 * @param {object[]} versions - Version rows (newest first)
 */
function renderSessionRuleVersions(id, versions) {
  const container = document.getElementById(`sessionRuleVersions-${id}`);
  if (!container) return;
  if (versions.length === 0) {
    container.innerHTML = '<p class="session-rules-empty">No version history.</p>';
    return;
  }
  container.innerHTML = versions.map((v) => {
    const gate = _criticGateBadge(v.criticGate);
    return `
    <div class="session-rule-version">
      <span class="session-rule-version-meta">v${v.versionNo} · ${esc(v.op)} · ${esc(v.changedBy)}</span>
      <span class="session-rule-critic-gate ${gate.cls}" title="${esc(gate.title)}">${esc(gate.label)}</span>
      <span class="session-rule-version-content">${esc(v.content)}</span>
      <button class="btn btn-small" data-action="restore" data-rule-id="${id}" data-version-no="${v.versionNo}">Restore</button>
    </div>
  `;
  }).join('');
}

/**
 * Restore a rule to a prior version (D1b).
 * @param {number} id - Rule id
 * @param {number} versionNo - Target version
 */
async function restoreSessionRule(id, versionNo) {
  const data = await apiMutate(`/api/session-rules/${id}/restore`, 'POST', { versionNo });
  if (data) {
    _setSessionRulesStatus(`Restored to v${versionNo}`, true);
    await loadSessionRules();
  } else {
    _setSessionRulesStatus('Restore failed', false);
  }
}

/**
 * Create a new global session rule from the add-form textarea.
 */
async function createSessionRule() {
  const input = document.getElementById('sessionRuleInput');
  const content = input.value.trim();
  if (!content) return;
  const data = await apiMutate('/api/session-rules', 'POST', { content });
  if (data) {
    input.value = '';
    _setSessionRulesStatus('Added', true);
    await loadSessionRules();
  } else {
    _setSessionRulesStatus('Add failed', false);
  }
}

/**
 * Toggle a session rule's enabled state.
 * @param {number} id - Rule id
 * @param {boolean} enabled - New enabled state
 */
async function toggleSessionRule(id, enabled) {
  const data = await apiMutate(`/api/session-rules/${id}`, 'PUT', { enabled });
  if (data) {
    await loadSessionRules();
  } else {
    _setSessionRulesStatus('Update failed', false);
  }
}

/**
 * Delete a session rule.
 * @param {number} id - Rule id
 */
async function deleteSessionRule(id) {
  const data = await apiMutate(`/api/session-rules/${id}`, 'DELETE', {});
  if (data) {
    _setSessionRulesStatus('Deleted', true);
    await loadSessionRules();
  } else {
    _setSessionRulesStatus('Delete failed', false);
  }
}

/**
 * Show a transient status message in the session-rules panel.
 * @param {string} text - Message
 * @param {boolean} ok - Success styling when true
 */
function _setSessionRulesStatus(text, ok) {
  const status = document.getElementById('sessionRulesStatus');
  if (!status) return;
  status.textContent = text;
  status.className = `rules-status ${ok ? 'rules-status-ok' : 'rules-status-err'}`;
  status.classList.remove('hidden');
  setTimeout(() => { status.classList.add('hidden'); }, 3000);
}

/**
 * Load project groups from the API.
 */
async function loadGroups() {
  const data = await api('/api/groups');
  if (!data) return;
  state.groups = data.groups || [];
  document.getElementById('groupsCount').textContent = state.groups.length;
  renderGroups();
}

/**
 * Load OpenClaw connections from the API and fetch tunnel status for each.
 */
async function loadOpenclawConnections() {
  const data = await api('/api/openclaw/connections');
  if (!data) return;
  state.openclawConnections = data.connections || [];
  const countEl = document.getElementById('openclawCount');
  if (countEl) countEl.textContent = state.openclawConnections.length;

  // Fetch tunnel status for each connection in parallel
  const statusPromises = state.openclawConnections.map(async (conn) => {
    const status = await api(`/api/openclaw/connections/${conn.id}/tunnel`);
    if (status) state.openclawTunnelStatus[conn.id] = status;
  });
  await Promise.all(statusPromises);

  renderOpenclawConnections();
}

/**
 * Load upstream model status for all engines.
 */
async function loadModelStatus() {
  const data = await api('/api/models/status');
  if (data && data.status) {
    state.modelStatus = data.status;
    renderProjects();
  }
}

async function loadEngines() {
  const data = await api('/api/engines');
  if (data) state.engines = data.engines || [];
}

async function loadMethodologies() {
  const data = await api('/api/methodologies');
  if (data) state.methodologies = data.methodologies || [];
}

async function loadConfig() {
  const data = await api('/api/config');
  if (data) state.config = data;
}

async function loadProjects() {
  const data = await api('/api/projects?archived=true');
  if (!data) return;
  state.projects = (data.projects || []).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  collectTags();
  renderProjects();
  renderSessionCount();
  updateUnregisteredToggle();

  // Update audit incident count badge
  const totalIncidents = state.projects.reduce((sum, p) =>
    sum + ((p.evalAudit && p.evalAudit.openIncidents) || 0), 0);
  const countEl = document.getElementById('auditIncidentCount');
  if (countEl) countEl.textContent = totalIncidents;

  // Refresh the orphan-hooks banner (#145, chunk 2). Skip while a repair is
  // in flight so the polling tick can't briefly flash pre-repair state back
  // (Critic N3). Console-log on failure rather than silently swallow so a
  // permanent failure is visible without breaking the dashboard.
  if (!state.orphanHooksRepairInFlight) {
    loadOrphanHooksInventory().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('orphan-hooks scan failed', err);
    });
  }
}

// ── Orphan Hooks Banner (#145, chunk 2) ──
// The Stop-hook infinite-loop incident that prompted chunk 2 lives in
// projects whose .claude/settings.json points at a methodology runtime that
// was never installed. The banner gives users a one-click escape hatch
// without waiting for each project's next session-launch sync to self-heal.

async function loadOrphanHooksInventory() {
  const data = await api('/api/projects/orphan-hooks-scan');
  state.orphanHooks = data || { projectsWithOrphans: [] };
  renderOrphanHooksBanner();
}

function renderOrphanHooksBanner() {
  const banner = document.getElementById('orphanHooksBanner');
  const textEl = document.getElementById('orphanHooksBannerText');
  if (!banner || !textEl) return;
  const list = (state.orphanHooks && state.orphanHooks.projectsWithOrphans) || [];
  if (list.length === 0) {
    banner.classList.add('hidden');
    return;
  }
  const noun = list.length === 1 ? 'project has' : 'projects have';
  textEl.textContent = `${list.length} ${noun} orphan Stop/SessionStart hooks (likely cause of infinite-loop session errors).`;
  banner.classList.remove('hidden');
}

async function repairAllOrphanHooks() {
  const list = (state.orphanHooks && state.orphanHooks.projectsWithOrphans) || [];
  if (list.length === 0) return;
  const names = list.map((p) => p.name).join(', ');
  if (!window.confirm(`Strip orphan hook entries from ${list.length} project(s)?\n\n${names}\n\nNon-orphan hooks and all other settings keys are preserved.`)) return;
  const toast = document.getElementById('toast');
  // Gate the polling-driven scan refresh so it can't race the in-flight repair
  // POST and briefly flash the pre-repair banner state back (Critic N3).
  state.orphanHooksRepairInFlight = true;
  try {
    const data = await apiMutate('/api/projects/repair-orphan-hooks', 'POST', {});
    if (!data) {
      if (toast) {
        toast.textContent = 'Repair failed (no response)';
        toast.className = 'toast toast-warn visible';
        setTimeout(() => { toast.className = 'toast'; }, 4000);
      }
      return;
    }
    const repairedN = Array.isArray(data.repaired) ? data.repaired.length : 0;
    const errorN = Array.isArray(data.errors) ? data.errors.length : 0;
    if (toast) {
      if (errorN > 0) {
        toast.textContent = `Repaired ${repairedN}, ${errorN} error${errorN > 1 ? 's' : ''}`;
        toast.className = 'toast toast-warn visible';
      } else {
        toast.textContent = `Repaired ${repairedN} project(s)`;
        toast.className = 'toast toast-ok visible';
      }
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }
    await loadProjects();
  } finally {
    state.orphanHooksRepairInFlight = false;
  }
}

function showOrphanHooksDetails() {
  const list = (state.orphanHooks && state.orphanHooks.projectsWithOrphans) || [];
  if (list.length === 0) return;
  const lines = list.map((p) => {
    const orphans = p.orphans.map((o) => `  • ${o.event}${o.matcher ? ` (matcher: "${o.matcher}")` : ''} → missing: ${o.missing.join(', ')}`).join('\n');
    return `${p.name}\n${orphans}`;
  });
  window.alert(`Orphan hooks detected:\n\n${lines.join('\n\n')}`);
}

function wireOrphanHooksBanner() {
  const repairBtn = document.getElementById('orphanHooksRepairBtn');
  const detailsBtn = document.getElementById('orphanHooksDetailsBtn');
  if (repairBtn) {
    repairBtn.addEventListener('click', () => {
      repairAllOrphanHooks().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('orphan-hooks repair failed', err);
        const toast = document.getElementById('toast');
        if (toast) {
          toast.textContent = `Repair failed: ${err && err.message ? err.message : 'unknown error'}`;
          toast.className = 'toast toast-warn visible';
          setTimeout(() => { toast.className = 'toast'; }, 4000);
        }
      });
    });
  }
  if (detailsBtn) detailsBtn.addEventListener('click', showOrphanHooksDetails);
}

/**
 * Wire the stale-server banner's restart button (#235). Idempotent —
 * called once at page init. The button visibility is managed
 * separately in `renderStaleServerBanner()` based on the server's
 * `restartMechanism` capability.
 */
function wireStaleServerBanner() {
  const btn = document.getElementById('staleServerRestartBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      triggerServerRestart().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('server restart failed', err);
      });
    });
  }
}

function collectTags() {
  const tags = new Set();
  for (const p of state.projects) {
    if (Array.isArray(p.tags)) p.tags.forEach(t => tags.add(t));
  }
  state.allTags = Array.from(tags).sort();
  renderTagRow();
}

// ── Filtering ──

/**
 * Filter projects based on text, tag, and registered state.
 * @returns {object[]}
 */
function filterProjects() {
  let list = state.projects.filter(p => !p.archived);
  if (!state.showUnregistered) {
    list = list.filter(p => p.registered !== false);
  }
  const text = state.filterText.toLowerCase();
  if (text) {
    list = list.filter(p => {
      const haystack = [
        p.name,
        p.engine ? p.engine.name : '',
        p.methodology ? p.methodology.name : '',
        ...(p.tags || [])
      ].join(' ').toLowerCase();
      return haystack.includes(text);
    });
  }
  if (state.activeTag) {
    list = list.filter(p => (p.tags || []).includes(state.activeTag));
  }
  return list;
}

function toggleTag(tag) {
  state.activeTag = tag;
  renderTagRow();
  renderProjects();
}

/**
 * Toggle visibility of unregistered projects and persist preference.
 */
function toggleUnregistered() {
  state.showUnregistered = !state.showUnregistered;
  try { localStorage.setItem('tc_showUnregistered', JSON.stringify(state.showUnregistered)); } catch (e) { /* ignore */ }
  updateUnregisteredToggle();
  renderProjects();
}

/**
 * Update the unregistered toggle button state by re-rendering the tag row.
 */
function updateUnregisteredToggle() {
  renderTagRow();
}

// ── Project Actions ──

function navigateToSession(name, opts) {
  const suffix = opts && opts.launched ? '?launched=1' : '';
  window.location.href = `/session/${encodeURIComponent(name)}${suffix}`;
}

async function launchProject(name) {
  const project = state.projects.find(p => p.name === name);
  if (project && project.session && project.session.active) {
    return navigateToSession(name);
  }

  // Check if engine has launch modes — show picker if so. Disabled modes
  // (Phase 1 of #210 ships openclaw's launchModes block scaffolded but with
  // every mode marked `disabled: true` until Phase 2 wires the propagation
  // to ClawBridge through the SSH tunnel) don't count toward the picker
  // gate; an engine whose modes are ALL disabled launches with no mode.
  // #459: openclaw engines are pickerHidden and absent from state.engines,
  // so a legacy openclaw-bound project skips the mode picker here and
  // launches with default mode — acceptable degradation for a deprecated
  // binding pattern (zero such projects existed at cutover).
  const engineId = project ? (project.engineId || (state.config && state.config.defaultEngine) || 'claude') : 'claude';
  const engine = (state.engines || []).find(e => e.id === engineId);
  if (engine && engine.launchModes) {
    const enabledModes = Object.values(engine.launchModes).filter(m => !m.disabled);
    if (enabledModes.length > 1) {
      openLaunchModeModal(name, engine);
      return;
    }
  }

  await doLaunchProject(name, null);
}

/**
 * Execute the actual session launch with optional launch mode.
 * @param {string} name - Project name
 * @param {string|null} launchMode - Launch mode key or null for default
 */
async function doLaunchProject(name, launchMode) {
  // Immediate visual feedback — swap button text to "Launching…" and disable
  const btn = document.querySelector(`button[onclick*="launchProject('${name}')"]`);
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = 'Launching\u2026';
    btn.disabled = true;
  }

  const toast = document.getElementById('toast');
  const body = {};
  if (launchMode) body.launchMode = launchMode;

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!res.ok) {
      if (btn) { btn.textContent = originalText; btn.disabled = false; }
      toast.textContent = `Launch failed: ${data.error || `HTTP ${res.status}`}`;
      toast.className = 'toast toast-warn visible';
      setTimeout(() => { toast.classList.remove('visible'); }, 6000);
      return;
    }

    setConnected(true);
    navigateToSession(name, { launched: true });
  } catch (err) {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
    if (err.name === 'TypeError' || err.message === 'Failed to fetch') {
      setConnected(false);
    }
    toast.textContent = `Launch failed: ${err.message}`;
    toast.className = 'toast toast-warn visible';
    setTimeout(() => { toast.classList.remove('visible'); }, 6000);
  }
}

// ── Launch Mode Modal ──

let launchModeTarget = null;
let selectedLaunchMode = null;

/**
 * Open the launch mode picker modal.
 * @param {string} name - Project name
 * @param {object} engine - Engine object with launchModes
 */
function openLaunchModeModal(name, engine) {
  launchModeTarget = name;
  selectedLaunchMode = engine.defaultLaunchMode || Object.keys(engine.launchModes)[0];

  document.getElementById('launchModeText').innerHTML =
    `Choose a launch mode for <strong>${esc(name)}</strong>:`;

  const list = document.getElementById('launchModeList');
  let html = '';
  for (const [key, mode] of Object.entries(engine.launchModes)) {
    const checked = key === selectedLaunchMode ? 'checked' : '';
    const warning = mode.warning ? `<span class="launch-mode-warning">${esc(mode.warning)}</span>` : '';
    html += `
      <label class="launch-mode-option">
        <input type="radio" name="launchMode" value="${esc(key)}" ${checked}
               onchange="selectedLaunchMode='${esc(key)}'; updateLaunchModeWarning()">
        <div class="launch-mode-info">
          <span class="launch-mode-label">${esc(mode.label)}</span>
          <span class="launch-mode-desc">${esc(mode.description || '')}</span>
          ${warning}
        </div>
      </label>`;
  }
  list.innerHTML = html;
  updateLaunchModeWarning();
  document.getElementById('launchModeModal').classList.add('open');
}

/**
 * Update the warning display based on selected launch mode.
 */
function updateLaunchModeWarning() {
  // Warning is shown inline per-option, no separate warning needed
  document.getElementById('launchModeWarning').classList.add('hidden');
}

/**
 * Close the launch mode modal.
 */
function closeLaunchModeModal() {
  document.getElementById('launchModeModal').classList.remove('open');
  launchModeTarget = null;
  selectedLaunchMode = null;
}

/**
 * Confirm launch mode selection and launch.
 */
async function confirmLaunchMode() {
  if (!launchModeTarget) return;
  const name = launchModeTarget;
  const mode = selectedLaunchMode;
  closeLaunchModeModal();
  await doLaunchProject(name, mode);
}

function wrapProject(name) {
  openWrapModal(name);
}

// ── Wrap Modal ──

let wrapTarget = null;

/**
 * True while a wrap `POST` is in flight, so a second confirm can't fire a
 * concurrent wrap and no close path can dismiss the modal mid-wrap. Reset in
 * `confirmWrap`'s `finally`. Mirrors the session-page fix (#519 / UI-3B8N).
 */
let wrapInFlight = false;

function openWrapModal(name) {
  wrapTarget = name;
  document.getElementById('wrapText').innerHTML =
    `Wrap the session for <strong>${esc(name)}</strong>? This sends the wrap command and ends the session.`;
  document.getElementById('wrapError').classList.add('hidden');
  document.getElementById('wrapPassword').value = '';
  const pwGroup = document.getElementById('wrapPasswordGroup');
  if (state.config && state.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  document.getElementById('wrapModal').classList.add('open');
}

/**
 * Close the wrap modal. Blocked while a wrap is in flight unless forced:
 * the Cancel handler passes the click Event (not `true`) and the backdrop
 * handler passes nothing, so a strict `force !== true` check stops both from
 * dismissing the modal mid-wrap; `confirmWrap` passes `force:true` on success.
 * @param {boolean} [force] `true` to close past the in-flight guard.
 */
function closeWrapModal(force) {
  if (wrapInFlight && force !== true) return;
  document.getElementById('wrapModal').classList.remove('open');
  wrapTarget = null;
}

/**
 * Confirm and execute a wrap for the targeted project (dashboard trigger).
 * Single-flight: the first click sets an in-flight flag, disables both
 * buttons, and flips the confirm label to "Wrapping…", so a second click
 * (or Cancel / backdrop) is a no-op until the request resolves — preventing
 * a double-click from firing two concurrent wraps. All state is restored in
 * `finally` so a failed or hung wrap re-enables cleanly. No timers — the
 * state tracks the request lifecycle (no timer-driven UI lifecycle).
 */
async function confirmWrap() {
  if (!wrapTarget) return;
  // Re-entrancy guard: ignore a second confirm while the first wrap POST is
  // still in flight, so a double-click can't fire two concurrent wraps.
  if (wrapInFlight) return;

  const pw = document.getElementById('wrapPassword').value;
  const body = {};
  if (pw) body.password = pw;

  const confirmBtn = document.getElementById('wrapConfirmBtn');
  const cancelBtn = document.getElementById('wrapCancelBtn');
  const priorLabel = confirmBtn.textContent;
  wrapInFlight = true;
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  confirmBtn.textContent = 'Wrapping…';

  try {
    const data = await apiMutate(`/api/sessions/${encodeURIComponent(wrapTarget)}/wrap`, 'POST', body);
    if (!data) {
      // Failure — surface inline and let `finally` re-enable so the operator
      // can fix (e.g. wrong password) and retry without reopening.
      document.getElementById('wrapError').textContent = 'Wrap failed. Check password.';
      document.getElementById('wrapError').classList.remove('hidden');
      return;
    }
    closeWrapModal(true); // force-close past the in-flight guard on success
    await loadProjects();
  } finally {
    wrapInFlight = false;
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    confirmBtn.textContent = priorLabel;
  }
}

// ── Theme ──

/**
 * Apply the current theme to the document.
 * Sets data-theme attribute on <html> for CSS variable overrides.
 */
function applyTheme() {
  const theme = (state.config && state.config.theme) || 'dark';
  if (theme === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

// ── Utilities ──

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Initialization ──

/**
 * Canonical form for project-name identity comparisons (#221). TC
 * preserves the operator's chosen capitalization for display
 * everywhere; the canonical form is only ever used for set membership
 * and equality checks. Lowercase is chosen because case-insensitive
 * filesystems (macOS HFS+, Windows) collapse to it, and programmatic
 * PortHub registrations conventionally slug-style lowercase.
 *
 * Defensive against non-string input — coerces to '' so map/filter
 * pipelines don't throw on a malformed lease record.
 *
 * @param {string} name
 * @returns {string}
 */
function _canonicalProjectName(name) {
  return String(name == null ? '' : name).toLowerCase();
}

/**
 * Check if any port leases reference projects not registered in TangleClaw.
 * If found, render an import notification banner with details.
 */
function checkPortImports() {
  if (!state.ports.length || !state.projects.length) return;

  // Identity is case-insensitive (#221) — TC's storage layer preserves
  // the operator's chosen capitalization for display, but two names
  // that differ only in case refer to the SAME project. Normalize both
  // sides before comparison so a lease registered as "monad-1" against
  // a TC project named "Monad-1" doesn't falsely advertise an import.
  const registeredNames = new Set(state.projects.map(p => _canonicalProjectName(p.name)));
  const ignored = new Set([...getIgnoredLeaseProjects()].map(_canonicalProjectName));

  // OpenClaw direct-connect tunnels register under oc-direct-<connId> — not orphan projects
  const ocConnIds = new Set((state.openclawConnections || []).map(c => `oc-direct-${c.id}`));

  // Group ports by unregistered project name. Bucket by the lease's
  // ORIGINAL casing so the banner shows what's actually on the wire,
  // not a normalized form.
  const unregistered = {};
  for (const lease of state.ports) {
    const key = _canonicalProjectName(lease.project);
    if (!registeredNames.has(key) && !ignored.has(key) && !ocConnIds.has(lease.project)) {
      if (!unregistered[lease.project]) unregistered[lease.project] = [];
      unregistered[lease.project].push(lease);
    }
  }

  const importable = Object.entries(unregistered).map(([name, leases]) => ({
    name,
    ports: leases.map(l => ({ port: l.port, service: l.service })),
    // Conflict detection also runs case-insensitively — a registered
    // project Foo holding port 3200 conflicts with a lease foo:3200.
    conflicts: leases.filter(l =>
      state.ports.some(p => p.port === l.port && registeredNames.has(_canonicalProjectName(p.project)))
    ).map(l => l.port)
  }));

  if (importable.length > 0) {
    renderImportBanner(importable);
  }
}

/**
 * Get the set of lease project names permanently ignored by the user.
 * @returns {Set<string>}
 */
function getIgnoredLeaseProjects() {
  try {
    const raw = localStorage.getItem('tc_ignoredLeaseProjects');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (e) { return new Set(); }
}

/**
 * Add a lease project name to the permanent ignore list.
 * @param {string} name - Project name to ignore
 */
function ignoreLeaseProject(name) {
  const ignored = getIgnoredLeaseProjects();
  ignored.add(name);
  localStorage.setItem('tc_ignoredLeaseProjects', JSON.stringify([...ignored]));
  // Remove banner and re-check
  const el = document.getElementById('importBanner');
  if (el) el.remove();
  checkPortImports();
}

async function init() {
  // Restore persisted preferences
  try {
    const saved = localStorage.getItem('tc_showUnregistered');
    if (saved !== null) state.showUnregistered = JSON.parse(saved);
  } catch (e) { /* ignore */ }

  await Promise.all([loadVersion(), loadConfig(), loadEngines(), loadMethodologies()]);
  applyTheme();

  // Check for first-run setup wizard
  if (typeof checkSetupWizard === 'function' && checkSetupWizard()) {
    // Wizard is showing — don't load projects or start polling yet.
    // Wizard dismissal will trigger loadProjects().
    return;
  }

  wireOrphanHooksBanner();
  wireStaleServerBanner();
  await loadProjects();
  await Promise.all([loadStats(), loadPorts(), loadGlobalRules(), loadSessionRules(), loadModelStatus(), loadGroups(), loadOpenclawConnections(), loadUpdateStatus(), loadServerInfo()]);
  checkPortImports();
  maybeShowFilter();
  updateUnregisteredToggle();
  startPolling();
}

/**
 * Start all landing page polling loops using setTimeout chains.
 * Prevents callback burst storms when browser tabs are backgrounded
 * and then refocused (setInterval queues callbacks during throttling).
 */
function startPolling() {
  function loop(fn, ms) {
    function tick() {
      setTimeout(async () => {
        await fn();
        tick();
      }, ms);
    }
    tick();
  }
  loop(loadStats, 30000);
  loop(loadPorts, 30000);
  loop(loadProjects, 10000);
  loop(loadModelStatus, 120000);
  loop(loadGroups, 30000);
  loop(loadOpenclawConnections, 30000);
  // Stale-server detection (#199) — polls so the banner surfaces mid-session
  // when the operator merges/pulls while a tab is open. Slower cadence than
  // the others because it shells out to git on the server every tick.
  loop(loadServerInfo, 60000);
}

// Service worker registration + update propagation lives in /sw-register.js
// (loaded before this script in index.html). It was extracted from an inline
// block here so the iOS update-propagation logic (#380) is unit-testable;
// it self-registers on load.

init();
