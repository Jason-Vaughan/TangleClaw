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
  allTags: [],
  connected: true,
  statsOpen: false
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
  document.getElementById('statUptime').textContent = formatUptime(data.uptime);
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
  state.projects = data.projects || [];
  collectTags();
  renderProjects();
  renderSessionCount();
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

function filterProjects() {
  let list = state.projects;
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

// ── Project Actions ──

function navigateToSession(name) {
  window.location.href = `/session/${encodeURIComponent(name)}`;
}

async function launchProject(name) {
  const project = state.projects.find(p => p.name === name);
  if (project && project.session && project.session.active) {
    return navigateToSession(name);
  }
  const data = await apiMutate(`/api/sessions/${encodeURIComponent(name)}`, 'POST', {});
  if (data) navigateToSession(name);
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

async function init() {
  await Promise.all([loadVersion(), loadConfig(), loadEngines(), loadMethodologies()]);
  await loadProjects();
  await loadStats();
  maybeShowFilter();
  setInterval(loadStats, 30000);
  setInterval(loadProjects, 10000);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
