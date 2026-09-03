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

// Bound from the shared factory in /api-helper.js (loaded before this file).
// No `setConnected` hook — this page has no connection banner. The unified
// helper sets `api.lastError = 'Connection lost.'` on network failure where
// the prior local copy passed `err.message` through; openclaw-view doesn't
// read api.lastError today, so this is a console-only string normalization.
// See PR for #82.

const api = window.tcCreateApi();

/**
 * Set the iframe's src after clearing any stale cross-connection localStorage
 * cache (#162). Every site that mutates `terminalFrame.src` must go through
 * this helper so the cache-bust is symmetric — Critic MINOR-1/MINOR-2 caught
 * the original wiring where only the initial `init()` site cleared, leaving
 * the post-pairing reload at line 114 without the same protection. The
 * `typeof === 'function'` guard means a missing helper script doesn't crash
 * the iframe load (the cache-bust is best-effort defence-in-depth).
 * @param {HTMLIFrameElement} frame - The terminal iframe.
 * @param {string} url - The full URL to navigate to (including any token fragment).
 */
function setFrameSrc(frame, url) {
  if (typeof tcClearStaleOpenclawCache === 'function') {
    tcClearStaleOpenclawCache(connId);
  }
  frame.src = url;
}

/**
 * The connection indicator: every measurement is recorded through it, and
 * recording re-renders. The reduction itself lives in openclaw-tunnel-state.js
 * so it can be exercised directly by tests rather than only pattern-matched.
 *
 * @type {{record: Function, state: Function, evidence: object}}
 */
const connectionIndicator = tcTunnelState.createConnectionIndicator(
  () => document.getElementById('statusDot')
);

/**
 * Render the terminal "this tunnel is not usable" state: a persistent warning
 * carrying the reason, and a dead status dot.
 *
 * Persistent (duration 0) is deliberate — this project bans timer-driven UI
 * lifecycle (#98, #268), and a failure the operator has not read yet must not
 * dismiss itself.
 *
 * @param {string} message - Operator-facing reason, from `describeTunnelFailure`.
 * @returns {void}
 */
function failTunnel(message) {
  showToast(message, 'warn', 0);
  // Routed through the indicator, which CLEARS the other level classes first.
  // Adding `dead` on top of the element's existing class left the previous
  // colour showing, which is the reported bug.
  connectionIndicator.fail(message);
}



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
  connectionIndicator.record('connName', conn.name);

  // Start tunnel. #1012: bounded, and verified before the frame is pointed at
  // it — see public/openclaw-tunnel-state.js for why each half is load-bearing.
  showToast('Starting tunnel\u2026', 'ok', 0);

  // Still routed through api() — it owns the service-worker (#709) and ingress
  // (#924) checks — with only an abort signal added, so a start that never
  // answers ends instead of hanging under a persistent spinner.
  const started = await tcTunnelState.callWithTimeout(
    (signal) => api(`/api/openclaw/connections/${encodeURIComponent(connId)}/tunnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal
    }),
    tcTunnelState.TUNNEL_START_TIMEOUT_MS
  );

  const tunnel = started.value;
  if (started.timedOut || !tunnel || !tunnel.ok) {
    // api() returns null for every refusal and parks the reason on lastError.
    const kind = started.timedOut ? 'timeout' : 'refused';
    const detail = started.timedOut ? null : ((tunnel && tunnel.error) || api.lastError || null);
    failTunnel(tcTunnelState.describeTunnelFailure(kind, conn.name, detail));
    return;
  }

  // The 200 says the tunnel was established, not that it is still up: the
  // reported failure dropped it between this answer and the bundle request,
  // and the frame then rendered OpenClaw's "a browser extension may be
  // blocking module execution" card over our own healthy-looking banner.
  // One real request to the path the frame is about to load settles it.
  const probe = await tcTunnelState.probeProxy(connId);
  connectionIndicator.record('probe', probe);
  if (!probe.reachable) {
    failTunnel(tcTunnelState.describeTunnelFailure('probe', conn.name, probe.reason));
    return;
  }

  showToast(tunnel.alreadyUp ? 'Tunnel already up' : 'Tunnel established', 'ok');

  // Load the proxy URL in the iframe
  const frame = document.getElementById('terminalFrame');
  const tokenParam = conn.gatewayToken ? `#token=${encodeURIComponent(conn.gatewayToken)}` : '';
  setFrameSrc(frame, `/openclaw-direct/${encodeURIComponent(connId)}/chat?session=main${tokenParam}`);

  // Reaching here means the proxy served bytes — NOT that the gateway behind
  // it can do anything. Asking the gateway's own health endpoint is the one
  // step past HTTP reachability it exposes, and until it answers the indicator
  // must not claim a working connection. Deliberately NOT awaited before the
  // frame is pointed: the answer gates the INDICATOR, not the page, and
  // holding the frame back for it bought up to a full probe budget of blank
  // iframe on every healthy load.
  tcTunnelState.probeGateway(connId).then((health) => connectionIndicator.record('health', health));

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
  let lastOutcome = null;

  function next() {
    if (stopped) return;
    attempts++;
    if (attempts > maxAttempts) {
      // #1076: this used to `return` with nothing said. The API tells us WHY it
      // could not approve, and throwing that away left the operator staring at
      // OpenClaw's pairing card with no sign TangleClaw had tried at all.
      reportAutoApproveGaveUp(lastOutcome);
      return;
    }

    setTimeout(async () => {
      if (stopped) return;
      const result = await api(`/api/openclaw/connections/${connId}/approve-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (result) {
        lastOutcome = result;
        // #1076 gave this answer a machine-readable code; until now it reached
        // the toasts and nothing else. `count > 0` proves devices are waiting,
        // and a terminal code proves we could not find out — both are reasons
        // the indicator must not read as a working connection.
        connectionIndicator.record('approve', result);
      }

      if (result && result.approved) {
        showToast('Device paired successfully', 'ok');
        stopped = true;
        // Reload iframe after brief delay to pick up the approved pairing.
        // Route through setFrameSrc so the cache-bust runs again — symmetric
        // with the initial init() load (Critic MINOR-1).
        setTimeout(() => {
          const frame = document.getElementById('terminalFrame');
          setFrameSrc(frame, frame.src);
        }, 1000);
        return;
      }

      // A host-side fault will not fix itself on the next poll — stop early and
      // say so, instead of spending nine more identical round-trips first.
      if (result && TERMINAL_APPROVE_CODES.indexOf(result.code) !== -1) {
        stopped = true;
        reportAutoApproveGaveUp(result);
        return;
      }
      next();
    }, 3000);
  }
  next();
}

/**
 * Outcomes that cannot change by retrying: the gateway host is missing docker,
 * has no container on that port, or the approve command itself failed. Polling
 * ten more times learns nothing a human would not already know.
 * @type {string[]}
 */
const TERMINAL_APPROVE_CODES = ['SSH_FAILED', 'DOCKER_NOT_FOUND', 'NO_CONTAINER', 'APPROVE_FAILED'];

/**
 * Tell the operator that auto-approval stopped, and why — with the manual step.
 *
 * Persistent (duration 0): this project bans timer-driven UI lifecycle
 * (#98, #268), and an explanation the operator has not read must not dismiss
 * itself. `NO_PENDING` is silent on purpose — nothing pending is the normal,
 * healthy state on an already-paired connection, not a failure to report.
 *
 * @param {{code?: string, reason?: string}|null} outcome - Last API result, if any.
 * @returns {void}
 */
function reportAutoApproveGaveUp(outcome) {
  if (outcome && outcome.code === 'NO_PENDING') return;
  const why = (outcome && outcome.reason) ? ` — ${outcome.reason}` : '';
  showToast(
    `Could not auto-approve device pairing for this connection${why}. ` +
    'Approve it manually on the gateway host: run `openclaw devices approve <requestId>` ' +
    'using the request id shown in the pairing panel.',
    'warn', 0
  );
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
