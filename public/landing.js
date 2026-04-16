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
  auditLoaded: false
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
 * Fetch update status and show notification pill if an update is available.
 * Dismissed state is persisted in localStorage keyed by version.
 */
async function loadUpdateStatus() {
  const data = await api('/api/update-status');
  if (!data || !data.updateAvailable || !data.latestVersion) return;

  const dismissKey = `tc_updateDismissed_${data.latestVersion}`;
  if (localStorage.getItem(dismissKey)) return;

  const pill = document.getElementById('updatePill');
  if (!pill) return;

  pill.innerHTML = `v${esc(data.latestVersion)} available <button class="update-pill-dismiss" aria-label="Dismiss">&times;</button>`;
  pill.classList.remove('hidden');

  pill.querySelector('.update-pill-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    pill.classList.add('hidden');
    localStorage.setItem(dismissKey, '1');
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

  // Check if engine has launch modes — show picker if so
  const engineId = project ? (project.engineId || (state.config && state.config.defaultEngine) || 'claude') : 'claude';
  const engine = (state.engines || []).find(e => e.id === engineId);
  if (engine && engine.launchModes && Object.keys(engine.launchModes).length > 1) {
    openLaunchModeModal(name, engine);
    return;
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

function closeWrapModal() {
  document.getElementById('wrapModal').classList.remove('open');
  wrapTarget = null;
}

async function confirmWrap() {
  if (!wrapTarget) return;
  const pw = document.getElementById('wrapPassword').value;
  const body = {};
  if (pw) body.password = pw;
  const data = await apiMutate(`/api/sessions/${encodeURIComponent(wrapTarget)}/wrap`, 'POST', body);
  if (!data) {
    document.getElementById('wrapError').textContent = 'Wrap failed. Check password.';
    document.getElementById('wrapError').classList.remove('hidden');
    return;
  }
  closeWrapModal();
  await loadProjects();
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
 * Check if any port leases reference projects not registered in TangleClaw.
 * If found, render an import notification banner with details.
 */
function checkPortImports() {
  if (!state.ports.length || !state.projects.length) return;

  const registeredNames = new Set(state.projects.map(p => p.name));
  const ignored = getIgnoredLeaseProjects();

  // OpenClaw direct-connect tunnels register under oc-direct-<connId> — not orphan projects
  const ocConnIds = new Set((state.openclawConnections || []).map(c => `oc-direct-${c.id}`));

  // Group ports by unregistered project name
  const unregistered = {};
  for (const lease of state.ports) {
    if (!registeredNames.has(lease.project) && !ignored.has(lease.project) && !ocConnIds.has(lease.project)) {
      if (!unregistered[lease.project]) unregistered[lease.project] = [];
      unregistered[lease.project].push(lease);
    }
  }

  const importable = Object.entries(unregistered).map(([name, leases]) => ({
    name,
    ports: leases.map(l => ({ port: l.port, service: l.service })),
    // Check for conflicts with registered projects' ports
    conflicts: leases.filter(l =>
      state.ports.some(p => p.port === l.port && registeredNames.has(p.project))
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

  await loadProjects();
  await Promise.all([loadStats(), loadPorts(), loadGlobalRules(), loadModelStatus(), loadGroups(), loadOpenclawConnections(), loadUpdateStatus()]);
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
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
