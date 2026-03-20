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
  groupItemsOpen: {}
};

// ── API Helpers ──

/**
 * Fetch JSON from the API. Returns parsed data or null on error.
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
async function api(url, opts) {
  try {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setConnected(true);
    return data;
  } catch (err) {
    if (err.name === 'TypeError' || err.message === 'Failed to fetch') {
      setConnected(false);
    }
    console.error(`API ${url}:`, err.message);
    return null;
  }
}

/**
 * POST/PATCH/DELETE with JSON body.
 * @param {string} url
 * @param {string} method
 * @param {object} body
 * @returns {Promise<object|null>}
 */
async function apiMutate(url, method, body) {
  return api(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

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
      reconnectTimer = setInterval(() => loadProjects(), 5000);
    }
  } else {
    toast.textContent = 'Reconnected';
    toast.className = 'toast toast-ok visible';
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
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
  const data = await api('/api/projects');
  if (!data) return;
  state.projects = (data.projects || []).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  collectTags();
  renderProjects();
  renderSessionCount();
  updateUnregisteredToggle();
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
  let list = state.projects;
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

  // Show loading state
  const toast = document.getElementById('toast');

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();

    if (!res.ok) {
      toast.textContent = `Launch failed: ${data.error || `HTTP ${res.status}`}`;
      toast.className = 'toast toast-warn visible';
      setTimeout(() => { toast.classList.remove('visible'); }, 6000);
      return;
    }

    setConnected(true);
    navigateToSession(name, { launched: true });
  } catch (err) {
    if (err.name === 'TypeError' || err.message === 'Failed to fetch') {
      setConnected(false);
    }
    toast.textContent = `Launch failed: ${err.message}`;
    toast.className = 'toast toast-warn visible';
    setTimeout(() => { toast.classList.remove('visible'); }, 6000);
  }
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

  // Group ports by unregistered project name
  const unregistered = {};
  for (const lease of state.ports) {
    if (!registeredNames.has(lease.project) && !ignored.has(lease.project)) {
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
  await Promise.all([loadStats(), loadPorts(), loadGlobalRules(), loadModelStatus(), loadGroups()]);
  checkPortImports();
  maybeShowFilter();
  updateUnregisteredToggle();
  startPolling();
}

function startPolling() {
  setInterval(loadStats, 30000);
  setInterval(loadPorts, 30000);
  setInterval(loadProjects, 10000);
  setInterval(loadModelStatus, 120000);
  setInterval(loadGroups, 30000);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
