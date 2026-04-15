'use strict';

/**
 * OpenClaw standalone viewer — starts tunnel, auto-approves pairing, loads Control UI in iframe.
 */

const connId = window.location.pathname.split('/')[2];

/**
 * Show a toast notification.
 * @param {string} text - Message text
 * @param {'ok'|'warn'} type - Toast type
 * @param {number} [duration=3000] - Auto-hide duration (0 = sticky)
 */
function showToast(text, type, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.className = `toast toast-${type} visible`;
  if (duration > 0) {
    setTimeout(() => toast.classList.remove('visible'), duration);
  }
}

/**
 * Fetch JSON from an API endpoint.
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
async function api(url, opts) {
  try {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) {
      api.lastError = data.error || `HTTP ${res.status}`;
      api.lastErrorCode = data.code || null;
      console.error(`API ${url}: ${api.lastError}${api.lastErrorCode ? ` (${api.lastErrorCode})` : ''}`);
      return null;
    }
    api.lastError = null;
    api.lastErrorCode = null;
    return data;
  } catch (err) {
    api.lastError = err.message || 'Unknown error';
    api.lastErrorCode = null;
    console.error(`API ${url}:`, err.message);
    return null;
  }
}
api.lastError = null;
api.lastErrorCode = null;

/**
 * Initialize the OpenClaw viewer: start tunnel, load iframe, auto-approve pairing.
 */
async function init() {
  if (!connId) {
    showToast('No connection ID in URL', 'warn', 0);
    return;
  }

  // Fetch connection details for the banner
  const conn = await api(`/api/openclaw/connections/${connId}`);
  if (!conn) {
    showToast('Connection not found', 'warn', 0);
    return;
  }

  document.getElementById('bannerName').textContent = conn.name;
  document.getElementById('bannerHost').textContent = `${conn.host}:${conn.port}`;
  document.title = `TangleClaw — ${conn.name}`;

  // Start tunnel
  showToast('Starting tunnel\u2026', 'ok', 0);
  const tunnel = await api(`/api/openclaw/connections/${connId}/tunnel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });

  if (!tunnel || !tunnel.ok) {
    showToast('Tunnel failed — check SSH connectivity', 'warn', 0);
    document.getElementById('statusDot').title = 'Disconnected';
    document.getElementById('statusDot').classList.add('dead');
    return;
  }

  showToast(tunnel.alreadyUp ? 'Tunnel already up' : 'Tunnel established', 'ok');
  document.getElementById('statusDot').title = 'Connected';
  document.getElementById('statusDot').classList.add('live');

  // Load the proxy URL in the iframe
  const frame = document.getElementById('terminalFrame');
  const tokenParam = conn.gatewayToken ? `#token=${encodeURIComponent(conn.gatewayToken)}` : '';
  frame.src = `/openclaw-direct/${encodeURIComponent(connId)}/chat?session=main${tokenParam}`;

  // Start sidecar polling + wire event listeners
  initSidecar();
  startSidecarPolling();

  // Auto-approve: poll for pending pairing requests and approve them
  startAutoApprove();
}

/**
 * Poll for pending device pairing requests and auto-approve them.
 * Runs for 30 seconds after page load to catch the initial pairing flow.
 * Uses setTimeout chain to prevent burst storms on tab refocus.
 */
function startAutoApprove() {
  let attempts = 0;
  const maxAttempts = 10;
  let stopped = false;

  function next() {
    if (stopped) return;
    attempts++;
    if (attempts > maxAttempts) return;

    setTimeout(async () => {
      if (stopped) return;
      const result = await api(`/api/openclaw/connections/${connId}/approve-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });

      if (result && result.approved) {
        showToast('Device paired successfully', 'ok');
        stopped = true;
        // Reload iframe after brief delay to pick up the approved pairing
        setTimeout(() => {
          const frame = document.getElementById('terminalFrame');
          frame.src = frame.src;
        }, 1000);
        return;
      }
      next();
    }, 3000);
  }
  next();
}

// ── Sidecar: process visibility ──

let _sidecarProcesses = [];
let _sidecarStale = false;
let _sidecarPollTimer = null;
let _selectedProcessId = null;

const SIDECAR_POLL_MS = 10000;

/**
 * Map process status to pill CSS modifier class.
 * @param {{ status: string }} proc
 * @returns {string}
 */
function sidecarStatusClass(proc) {
  switch (proc.status) {
    case 'running': return 'sidecar-pill--running';
    case 'quiet':   return 'sidecar-pill--quiet';
    case 'completed': return 'sidecar-pill--completed';
    case 'failed':
    case 'terminated': return 'sidecar-pill--failed';
    default: return '';
  }
}

/**
 * Format elapsed time from start to end (or now).
 * @param {string} startedAt - ISO timestamp
 * @param {string|null} completedAt - ISO timestamp or null
 * @returns {string}
 */
function formatElapsed(startedAt, completedAt) {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

/**
 * Format an ISO timestamp for display.
 * @param {string} iso - ISO timestamp
 * @returns {string}
 */
function formatTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Build a detail field row HTML string.
 * @param {string} label
 * @param {string} valueHtml
 * @returns {string}
 */
function sidecarField(label, valueHtml) {
  return `<div class="sidecar-field"><span class="sidecar-field-label">${label}</span><span class="sidecar-field-value">${valueHtml}</span></div>`;
}

/**
 * Render sidecar pills into the banner container.
 * @param {object[]} processes - Combined active + recent processes
 * @param {boolean} stale - Whether the data is stale
 */
function renderSidecarPills(processes, stale) {
  const container = document.getElementById('sidecarPills');
  if (!container) return;

  if (!processes || processes.length === 0) {
    container.innerHTML = '';
    return;
  }

  const attentionCount = processes.filter(p => p.needsAttention).length;

  let html = '';
  if (attentionCount > 0) {
    html += `<span class="sidecar-attention-badge" title="${attentionCount} need attention">${attentionCount}</span>`;
  }
  if (stale) {
    html += '<span class="sidecar-stale-badge" title="Data may be outdated">stale</span>';
  }

  for (const proc of processes) {
    const cls = sidecarStatusClass(proc);
    const attn = proc.needsAttention ? ' sidecar-pill--attention' : '';
    const elapsed = formatElapsed(proc.startedAt, proc.completedAt);
    html += `<span class="sidecar-pill ${cls}${attn}" data-process-id="${proc.id}" title="${proc.label || proc.type}">` +
      `<span class="sidecar-pill-dot"></span>` +
      `<span class="sidecar-pill-label">${proc.label || proc.type}</span>` +
      (elapsed ? `<span class="sidecar-pill-time">${elapsed}</span>` : '') +
      `</span>`;
  }

  container.innerHTML = html;
}

/**
 * Auto-select a process for the detail panel.
 * Priority: first attention-needing → first active → first process.
 * @param {object[]} processes
 * @returns {string|null} - Selected process ID
 */
function autoSelectProcess(processes) {
  if (!processes || processes.length === 0) return null;
  const attention = processes.find(p => p.needsAttention);
  if (attention) return attention.id;
  const active = processes.find(p => p.status === 'running' || p.status === 'quiet');
  if (active) return active.id;
  return processes[0].id;
}

/**
 * Render the sidecar detail panel for the selected process.
 */
function renderSidecarDetail() {
  const detail = document.getElementById('sidecarDetail');
  const nav = document.getElementById('sidecarNav');
  if (!detail) return;

  const processes = _sidecarProcesses;
  if (!processes || processes.length === 0) {
    detail.innerHTML = '<div class="sidecar-detail-empty">No processes</div>';
    if (nav) nav.innerHTML = '';
    return;
  }

  // Render nav buttons if multiple processes
  if (nav && processes.length > 1) {
    nav.innerHTML = processes.map(p => {
      const dotCls = sidecarStatusClass(p).replace('sidecar-pill--', 'sidecar-nav-dot--');
      const activeCls = p.id === _selectedProcessId ? ' active' : '';
      return `<button class="sidecar-nav-btn${activeCls}" data-nav-id="${p.id}" title="${p.label || p.type}">` +
        `<span class="sidecar-nav-dot ${dotCls}"></span>${p.label || p.type}</button>`;
    }).join('');
  } else if (nav) {
    nav.innerHTML = '';
  }

  const proc = processes.find(p => p.id === _selectedProcessId);
  if (!proc) {
    detail.innerHTML = '<div class="sidecar-detail-empty">Process not found</div>';
    return;
  }

  // Status badge
  const statusBadge = `<span class="sidecar-status-badge sidecar-status-badge--${proc.status}">${proc.status}</span>`;

  // Attention flags
  let flags = '';
  if (proc.waitingForInput) flags += '<span class="sidecar-flag">Waiting for Input</span>';
  if (proc.suspectedStalled) flags += '<span class="sidecar-flag sidecar-flag--danger">Suspected Stalled</span>';
  if (proc.needsAttention && !proc.waitingForInput && !proc.suspectedStalled) {
    flags += '<span class="sidecar-flag sidecar-flag--danger">Needs Attention</span>';
  }
  const flagsHtml = flags ? `<div class="sidecar-flags">${flags}</div>` : '';

  // Fields
  let html = flagsHtml;
  html += sidecarField('Status', statusBadge);
  html += sidecarField('Type', proc.type || '—');
  if (proc.project) html += sidecarField('Project', proc.project);
  if (proc.workDir) html += sidecarField('Work Dir', proc.workDir);
  html += sidecarField('Started', formatTimestamp(proc.startedAt));
  html += sidecarField('Duration', formatElapsed(proc.startedAt, proc.completedAt));
  if (proc.completedAt) html += sidecarField('Completed', formatTimestamp(proc.completedAt));
  if (proc.exitCode != null) html += sidecarField('Exit Code', String(proc.exitCode));
  if (proc.signal) html += sidecarField('Signal', proc.signal);

  // Output snippet
  if (proc.lastOutputSnippet) {
    html += '<div class="sidecar-output">' +
      '<span class="sidecar-output-label">Last Output</span>' +
      `<pre class="sidecar-output-content">${escapeHtml(proc.lastOutputSnippet)}</pre></div>`;
  }

  detail.innerHTML = html;
}

/**
 * Escape HTML entities.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Open the sidecar detail panel.
 * @param {string} [processId] - Process ID to select, or auto-select
 */
function openSidecarPanel(processId) {
  _selectedProcessId = processId || autoSelectProcess(_sidecarProcesses);
  const panel = document.getElementById('sidecarPanel');
  const backdrop = document.getElementById('sidecarBackdrop');
  if (panel) panel.classList.add('open');
  if (backdrop) backdrop.hidden = false;
  renderSidecarDetail();
}

/**
 * Close the sidecar detail panel.
 */
function closeSidecarPanel() {
  const panel = document.getElementById('sidecarPanel');
  const backdrop = document.getElementById('sidecarBackdrop');
  if (panel) panel.classList.remove('open');
  if (backdrop) backdrop.hidden = true;
}

/**
 * Poll the sidecar connection API and update pills + panel.
 */
async function pollSidecarProcesses() {
  const data = await api(`/api/sidecar/connection/${connId}/processes`);
  if (!data) return;

  const combined = [...(data.active || []), ...(data.recent || [])];
  _sidecarProcesses = combined;
  _sidecarStale = data.stale || false;

  renderSidecarPills(combined, _sidecarStale);

  // Auto-update detail panel if open
  const panel = document.getElementById('sidecarPanel');
  if (panel && panel.classList.contains('open')) {
    renderSidecarDetail();
  }
}

/**
 * Start sidecar polling for this connection.
 * Uses setTimeout chain to prevent burst storms on tab refocus.
 */
function startSidecarPolling() {
  if (_sidecarPollTimer) return;
  pollSidecarProcesses();
  _sidecarPollTimer = true; // sentinel
  function scheduleNext() {
    if (!_sidecarPollTimer) return;
    _sidecarPollTimer = setTimeout(async () => {
      if (!_sidecarPollTimer) return;
      await pollSidecarProcesses();
      scheduleNext();
    }, SIDECAR_POLL_MS);
  }
  scheduleNext();
}

/**
 * Stop sidecar polling.
 */
function stopSidecarPolling() {
  if (_sidecarPollTimer && _sidecarPollTimer !== true) {
    clearTimeout(_sidecarPollTimer);
  }
  _sidecarPollTimer = null;
}

/**
 * Wire up sidecar event listeners.
 */
function initSidecar() {
  // Close button
  const closeBtn = document.getElementById('sidecarClose');
  if (closeBtn) closeBtn.addEventListener('click', closeSidecarPanel);

  // Backdrop click
  const backdrop = document.getElementById('sidecarBackdrop');
  if (backdrop) backdrop.addEventListener('click', closeSidecarPanel);

  // Refresh button
  const refreshBtn = document.getElementById('sidecarRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => pollSidecarProcesses());

  // Pill click → open panel
  const pillsContainer = document.getElementById('sidecarPills');
  if (pillsContainer) {
    pillsContainer.addEventListener('click', (e) => {
      const pill = e.target.closest('.sidecar-pill[data-process-id]');
      if (pill) openSidecarPanel(pill.dataset.processId);
    });
  }

  // Nav button click → switch process
  const navContainer = document.getElementById('sidecarNav');
  if (navContainer) {
    navContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.sidecar-nav-btn[data-nav-id]');
      if (btn) {
        _selectedProcessId = btn.dataset.navId;
        renderSidecarDetail();
      }
    });
  }
}

init();
