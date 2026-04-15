'use strict';
/* ── TangleClaw v3 — Session Wrapper ── */
/* Handles command bar, peek drawer, chime system, settings, and polling. */

// ── Extract Project Name from URL ──

const projectName = decodeURIComponent(
  window.location.pathname.replace(/^\/session\//, '').replace(/\/$/, '')
);

// ── State ──

const sessionState = {
  project: null,
  config: null,
  engines: [],
  session: null,
  connected: true,
  peekOpen: false,
  commandBarOpen: false,
  chimeEnabled: false,
  pollInterval: 5000,
  lastPeekOutput: null,
  idleCount: 0,
  chimePlayedForIdle: false,
  commandHistory: [],
  ended: false,
  wrapping: false,
  mouseOn: false,
  launchGraceRemaining: 0,
  wrapCompleting: false
};

// ── Storage Helpers ──

/**
 * Load a per-project setting from localStorage.
 * @param {string} key
 * @param {*} fallback
 * @returns {*}
 */
function loadSetting(key, fallback) {
  try {
    const val = localStorage.getItem(`tc_${projectName}_${key}`);
    return val !== null ? JSON.parse(val) : fallback;
  } catch (e) { console.warn('loadSetting failed:', key, e.message); return fallback; }
}

/**
 * Save a per-project setting to localStorage.
 * @param {string} key
 * @param {*} value
 */
function saveSetting(key, value) {
  try {
    localStorage.setItem(`tc_${projectName}_${key}`, JSON.stringify(value));
  } catch (e) { console.warn('saveSetting failed:', key, e.message); }
}

// ── API Helpers ──

/**
 * Fetch JSON from the API.
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
    setConnected(true);
    return data;
  } catch (err) {
    if (err.name === 'TypeError' || err.message === 'Failed to fetch') {
      setConnected(false);
      api.lastError = 'Connection lost.';
    } else {
      api.lastError = err.message || 'Unknown error';
    }
    api.lastErrorCode = null;
    console.error(`API ${url}:`, err.message);
    return null;
  }
}
api.lastError = null;
api.lastErrorCode = null;

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

// ── HTML Escaping ──

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Build <option> (and <optgroup>) HTML for an engine dropdown.
 * Groups OpenClaw virtual engines under an "OpenClaw" optgroup.
 * @param {object[]} engineList - Engines from sessionState.engines
 * @param {string} selectedId - Currently selected engine ID
 * @returns {string} HTML string
 */
function buildEngineOptions(engineList, selectedId) {
  const standard = engineList.filter(e => !e.category);
  const openclaw = engineList.filter(e => e.category === 'OpenClaw');

  let html = standard.map(e =>
    `<option value="${esc(e.id)}" ${e.id === selectedId ? 'selected' : ''}>${esc(e.name)}${e.available === false ? ' (not installed)' : ''}</option>`
  ).join('');

  if (openclaw.length > 0) {
    html += `<optgroup label="OpenClaw">`;
    html += openclaw.map(e =>
      `<option value="${esc(e.id)}" ${e.id === selectedId ? 'selected' : ''}>${esc(e.name)}</option>`
    ).join('');
    html += `</optgroup>`;
  }

  return html;
}

// ── Connection State ──

let reconnectTimer = null;

/**
 * Update connection state and show/hide toast.
 * @param {boolean} connected
 */
function setConnected(connected) {
  if (sessionState.connected === connected) return;
  sessionState.connected = connected;
  const toast = document.getElementById('toast');
  const dot = document.getElementById('statusDot');

  if (!connected) {
    toast.textContent = 'Connection lost. Retrying\u2026';
    toast.className = 'toast toast-warn visible';
    dot.classList.add('disconnected');
    dot.title = 'Disconnected';
    document.getElementById('commandSend').disabled = true;
    if (!reconnectTimer) {
      // Use setTimeout chain instead of setInterval to prevent burst storms
      function reconnectLoop() {
        if (!reconnectTimer) return;
        reconnectTimer = setTimeout(async () => {
          if (!reconnectTimer) return;
          await pollStatus();
          reconnectLoop();
        }, 5000);
      }
      reconnectTimer = true; // sentinel
      reconnectLoop();
    }
  } else {
    toast.textContent = 'Reconnected';
    toast.className = 'toast toast-ok visible';
    dot.classList.remove('disconnected');
    dot.title = 'Connected';
    document.getElementById('commandSend').disabled = false;
    if (reconnectTimer) {
      if (reconnectTimer !== true) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setTimeout(() => { toast.classList.remove('visible'); }, 3000);
  }
}

// ── Data Loading ──

/**
 * Load project data and populate the banner.
 */
async function loadProject() {
  const data = await api(`/api/projects/${encodeURIComponent(projectName)}`);
  if (!data) return;
  sessionState.project = data;

  document.getElementById('bannerName').textContent = data.name;
  document.getElementById('bannerName').title = data.name;

  const engineEl = document.getElementById('bannerEngine');
  if (data.engine) {
    engineEl.textContent = data.engine.name;
    engineEl.setAttribute('data-engine', data.engine.id);
    // Fetch model status for this engine
    loadModelStatus(data.engine.id);
  }

  const methEl = document.getElementById('bannerMethodology');
  if (data.methodology) {
    methEl.textContent = data.methodology.name;
    methEl.style.display = '';
  } else {
    methEl.style.display = 'none';
  }

  const phaseEl = document.getElementById('bannerPhase');
  if (data.methodology && data.methodology.phase) {
    phaseEl.textContent = data.methodology.phase;
    phaseEl.className = 'banner-phase';
    phaseEl.style.display = '';
  } else if (data.methodology) {
    phaseEl.textContent = 'in session';
    phaseEl.className = 'banner-phase-unknown';
    phaseEl.style.display = '';
  } else {
    phaseEl.style.display = 'none';
  }

  document.title = `TangleClaw \u2014 ${data.name}`;

  // Render group pills in banner
  renderBannerGroups(data.groups || []);
}

/**
 * Render group pills in the banner row. Clicking shows a popover with member projects.
 * @param {object[]} groups - Array of { id, name, sharedDocCount }
 */
function renderBannerGroups(groups) {
  const container = document.getElementById('bannerGroups');
  if (!groups.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = groups.map(g =>
    `<span class="group-pill" data-group-id="${g.id}" onclick="toggleGroupPopover(this, '${g.id}')">${esc(g.name)}` +
    `<span class="group-popover" id="groupPop-${g.id}"></span></span>`
  ).join('');
}

/**
 * Toggle the group popover showing member projects.
 * @param {HTMLElement} pill - The pill element
 * @param {string} groupId
 */
async function toggleGroupPopover(pill, groupId) {
  const pop = document.getElementById(`groupPop-${groupId}`);
  if (!pop) return;

  // Close all other popovers
  document.querySelectorAll('.group-popover.open').forEach(el => {
    if (el !== pop) el.classList.remove('open');
  });

  if (pop.classList.contains('open')) {
    pop.classList.remove('open');
    return;
  }

  // Fetch group details
  const data = await api(`/api/groups/${groupId}`);
  if (!data) return;

  const members = data.members || [];
  const docsCount = (data.docs || []).length;

  pop.innerHTML = `<div class="group-popover-title">${esc(data.name)}</div>` +
    (data.description ? `<div style="color:var(--text-muted);font-size:11px;margin-bottom:6px">${esc(data.description)}</div>` : '') +
    members.map(m =>
      `<div class="group-popover-member${m.name === projectName ? ' current' : ''}">${esc(m.name || 'unknown')}</div>`
    ).join('') +
    (docsCount > 0 ? `<div style="margin-top:6px;font-size:10px;color:var(--text-muted)">${docsCount} shared doc${docsCount !== 1 ? 's' : ''}</div>` : '');

  pop.classList.add('open');
}

/**
 * Display project version in banner from already-loaded project data.
 */
function loadVersion() {
  const ver = sessionState.project && sessionState.project.version;
  const el = document.getElementById('bannerVersion');
  if (ver) {
    el.textContent = `v${ver}`;
  } else {
    el.textContent = '';
  }
}

/**
 * Load update status and show/hide the update badge.
 */
async function loadUpdateStatus() {
  const data = await api('/api/update-status');
  if (!data) return;
  const badge = document.getElementById('updateBadge');
  if (!badge) return;
  if (data.updateAvailable && data.latestVersion) {
    badge.textContent = `v${data.latestVersion}`;
    badge.title = `Update available: v${data.currentVersion} → v${data.latestVersion}. Tap to send update instructions to the AI agent.`;
    badge.classList.remove('hidden');
    badge.onclick = () => injectUpdatePrompt(data);
  } else {
    badge.classList.add('hidden');
  }
}

/**
 * Build the update instruction prompt for the AI agent.
 * @param {object} data - Update status data
 * @returns {string}
 */
function buildUpdatePrompt(data) {
  return [
    `TangleClaw update available: v${data.currentVersion} → v${data.latestVersion}.`,
    'Please update TangleClaw by running these steps:',
    '1. cd ~/Documents/Projects/TangleClaw-v3',
    '2. git fetch --tags origin',
    '3. git pull origin main',
    '4. Review CHANGELOG.md for breaking changes',
    '5. Run the test suite: node --test test/*.test.js',
    '6. If tests pass, restart TangleClaw: launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server',
    'If there are merge conflicts or test failures, report them before restarting.'
  ].join('\n');
}

/**
 * Inject update instructions into the active session via command injection.
 * @param {object} data - Update status data
 */
async function injectUpdatePrompt(data) {
  const prompt = buildUpdatePrompt(data);
  const result = await apiMutate(
    `/api/sessions/${encodeURIComponent(projectName)}/command`,
    'POST',
    { command: prompt }
  );
  const toast = document.getElementById('toast');
  if (result && result.ok) {
    toast.textContent = 'Update instructions sent to AI agent';
    toast.className = 'toast toast-ok visible';
  } else {
    toast.textContent = 'Could not inject prompt — no active session?';
    toast.className = 'toast toast-warn visible';
  }
  setTimeout(() => { toast.classList.remove('visible'); }, 5000);
}

/**
 * Load global config.
 */
async function loadConfig() {
  const data = await api('/api/config');
  if (data) {
    sessionState.config = data;
    applyTheme();
  }
}

/**
 * xterm.js theme palettes keyed by TangleClaw theme name.
 * @type {Object<string, Object>}
 */
const XTERM_THEMES = {
  dark: {
    background: '#000000',
    foreground: '#E8E8E8',
    cursor: '#E8E8E8',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(139,195,74,0.3)'
  },
  light: {
    background: '#F5F5F5',
    foreground: '#1A1A1A',
    cursor: '#1A1A1A',
    cursorAccent: '#F5F5F5',
    selectionBackground: 'rgba(139,195,74,0.3)'
  },
  'high-contrast': {
    background: '#000000',
    foreground: '#FFFFFF',
    cursor: '#FFFFFF',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(164,214,94,0.4)'
  }
};

/**
 * Apply the current theme to the document and the terminal iframe.
 */
function applyTheme() {
  const theme = (sessionState.config && sessionState.config.theme) || 'dark';
  if (theme === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  applyTerminalTheme(theme);
}

/**
 * Push a colour theme into the xterm.js instance inside the ttyd iframe.
 * Safe to call at any time — silently no-ops if the iframe or terminal
 * instance is not ready.
 * @param {string} theme - Theme key ('dark', 'light', 'high-contrast')
 */
function applyTerminalTheme(theme) {
  const frame = document.getElementById('terminalFrame');
  if (!frame) return;
  try {
    const win = frame.contentWindow;
    const term = win && (win.term || win.terminal);
    if (term && term.options) {
      term.options.theme = XTERM_THEMES[theme] || XTERM_THEMES.dark;
    }
  } catch (_) { /* cross-origin or not loaded yet — ignore */ }
}

/**
 * Load engine list for settings dropdown.
 */
async function loadEngines() {
  const data = await api('/api/engines');
  if (data) sessionState.engines = data.engines || [];
}

/**
 * Load shared documents available to this project and render in settings.
 */
async function loadSharedDocs() {
  const project = sessionState.project;
  if (!project || !project.groups || project.groups.length === 0) {
    const el = document.getElementById('sharedDocsList');
    el.innerHTML = '<div class="settings-info">No groups</div>';
    document.getElementById('sharedDocsGroup').style.display = 'none';
    return;
  }

  document.getElementById('sharedDocsGroup').style.display = '';

  // Fetch docs for each group
  const allDocs = [];
  const seenPaths = new Set();
  for (const g of project.groups) {
    const data = await api(`/api/shared-docs?groupId=${g.id}`);
    if (data && data.docs) {
      for (const doc of data.docs) {
        if (!seenPaths.has(doc.filePath)) {
          seenPaths.add(doc.filePath);
          doc._groupName = g.name;
          allDocs.push(doc);
        }
      }
    }
  }

  renderSharedDocs(allDocs);
}

/**
 * Render shared documents list in session settings.
 * @param {object[]} docs
 */
function renderSharedDocs(docs) {
  const el = document.getElementById('sharedDocsList');
  if (docs.length === 0) {
    el.innerHTML = '<div class="settings-info">No shared documents</div>';
    return;
  }

  el.innerHTML = docs.map(doc => {
    const lockHtml = doc.lock
      ? `<span class="shared-doc-lock locked" title="Locked by ${esc(doc.lock.lockedByProject)}">&#128274; ${esc(doc.lock.lockedByProject)}</span>`
      : `<span class="shared-doc-lock">&#128275; unlocked</span>`;
    const injectBadge = doc.injectIntoConfig
      ? `<span class="shared-doc-badge inject">${esc(doc.injectMode)}</span>`
      : `<span class="shared-doc-badge">disabled</span>`;
    return `<div class="shared-doc-item">
      <div class="shared-doc-header">
        <span class="shared-doc-name">${esc(doc.name)}</span>
        ${injectBadge}
      </div>
      <div class="shared-doc-meta">
        <span class="shared-doc-group">${esc(doc._groupName || '')}</span>
        ${lockHtml}
      </div>
      <div class="shared-doc-path">${esc(doc.filePath)}</div>
    </div>`;
  }).join('');
}

/**
 * Fetch model status and update the engine badge in the banner.
 * @param {string} [engineId] - Engine ID to look up status for
 */
async function loadModelStatus(engineId) {
  const id = engineId || (sessionState.project && sessionState.project.engine && sessionState.project.engine.id);
  if (!id) return;

  const data = await api('/api/models/status');
  if (!data || !data.status) return;

  const status = data.status[id];
  if (!status) return;

  const engineEl = document.getElementById('bannerEngine');

  // Remove existing status dot if present
  const existingDot = engineEl.querySelector('.engine-status-dot');
  if (existingDot) existingDot.remove();

  // Remove existing pill status classes
  engineEl.className = engineEl.className.replace(/\bengine-pill-\S+/g, '').trim();

  // Create status dot
  const dot = document.createElement('span');
  dot.className = `engine-status-dot engine-status-${status.status}`;
  engineEl.prepend(dot);

  // Apply pill-level styling for non-operational states
  if (status.status !== 'operational') {
    engineEl.classList.add(`engine-pill-${status.status}`);
  }

  // Set tooltip on the whole badge
  if (status.error) {
    engineEl.title = `Status unknown: ${status.error}`;
  } else if (status.message) {
    engineEl.title = status.message.replace(/_/g, ' ');
  } else {
    engineEl.title = (status.status || 'unknown').replace(/_/g, ' ');
  }
}

// ── Visibility-Aware Polling ──
// Uses setTimeout chains instead of setInterval to prevent callback stacking
// when browser tabs are backgrounded and then refocused (which causes a burst
// of queued setInterval callbacks to fire simultaneously).

let _pageVisible = !document.hidden;

document.addEventListener('visibilitychange', () => {
  const wasVisible = _pageVisible;
  _pageVisible = !document.hidden;
  if (_pageVisible && !wasVisible) {
    // Tab regained focus — restart polling fresh (no queued bursts)
    if (pollTimer) startPolling();
    if (mouseGuardTimer) startMouseGuard();
  }
});

// ── Session Status Polling ──

let pollTimer = null;

/**
 * Poll session status and update UI.
 */
async function pollStatus() {
  const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/status`);
  if (!data) return;

  sessionState.session = data;

  // Handle wrapping state
  if (data.wrapping && !sessionState.wrapping) {
    showWrappingState();
  }

  // Handle wrap completed (tmux died during wrapping)
  if (data.wrapCompleted && !sessionState.ended) {
    handleWrapCompleted(data);
    return;
  }

  // Handle wrap finished but tmux still alive (idle during wrapping)
  if (data.wrapping && data.idle && !sessionState.ended) {
    sessionState.wrapIdleCount = (sessionState.wrapIdleCount || 0) + 1;
    // Require 3 consecutive idle polls (~6s at 2s interval) to confirm wrap is done
    if (sessionState.wrapIdleCount >= 3) {
      completeWrapFromIdle();
      return;
    }
  } else if (data.wrapping) {
    sessionState.wrapIdleCount = 0;
  }

  if (!data.active && !data.wrapping && !sessionState.ended) {
    // Grace period after fresh launch — tmux may not be queryable yet
    if (sessionState.launchGraceRemaining > 0) {
      sessionState.launchGraceRemaining--;
      return; // Skip this poll, try again next cycle
    }
    handleSessionEnded(data);
  } else if (data.active && sessionState.launchGraceRemaining > 0) {
    // Session came up — clear remaining grace
    sessionState.launchGraceRemaining = 0;
  }

  // Idle detection for chime — ding once per idle transition
  if (data.active && data.idle) {
    sessionState.idleCount++;
    if (sessionState.idleCount >= 2 && sessionState.chimeEnabled && !sessionState.chimePlayedForIdle) {
      playChime();
      sessionState.chimePlayedForIdle = true;
    }
  } else {
    sessionState.idleCount = 0;
    sessionState.chimePlayedForIdle = false;
  }
}

/**
 * Start polling at the configured interval using setTimeout chains.
 * Unlike setInterval, setTimeout chains don't queue callbacks when the
 * tab is backgrounded, preventing burst storms on tab refocus.
 */
function startPolling() {
  stopPolling();
  pollTimer = true; // sentinel — actual timeout ID set below
  function scheduleNext() {
    if (!pollTimer) return;
    pollTimer = setTimeout(async () => {
      if (!pollTimer) return;
      if (!_pageVisible) return; // skip while hidden, visibilitychange will restart
      await pollStatus();
      scheduleNext();
    }, sessionState.pollInterval);
  }
  scheduleNext();
}

/**
 * Stop status polling.
 */
function stopPolling() {
  if (pollTimer && pollTimer !== true) {
    clearTimeout(pollTimer);
  }
  pollTimer = null;
}

// ── Session Ended ──

let countdownTimer = null;

/**
 * Handle session ended state.
 * @param {object} statusData
 */
function handleSessionEnded(statusData) {
  sessionState.ended = true;
  stopPolling();
  clearWrapTimeout();

  const dot = document.getElementById('statusDot');
  dot.classList.add('ended');
  dot.classList.remove('disconnected');
  dot.title = 'Session ended';

  // Disable action buttons
  document.getElementById('wrapBtn').disabled = true;
  document.getElementById('killBtn').disabled = true;
  document.getElementById('cmdBtn').disabled = true;
  document.getElementById('commandSend').disabled = true;

  // Show ended bar
  const endedBar = document.getElementById('sessionEnded');
  endedBar.classList.remove('hidden');

  // Countdown redirect
  let remaining = 10;
  const countdownEl = document.getElementById('countdown');
  countdownEl.textContent = `Returning in ${remaining}s`;
  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      window.location.href = '/';
    } else {
      countdownEl.textContent = `Returning in ${remaining}s`;
    }
  }, 1000);
}

// ── Terminal Setup ──

/**
 * Set up the terminal iframe. For webui sessions uses iframeUrl (OpenClaw UI),
 * otherwise loads the ttyd terminal proxy.
 * @param {string} [iframeUrl] - OpenClaw iframe URL for webui sessions
 */
function setupTerminal(iframeUrl) {
  const frame = document.getElementById('terminalFrame');
  frame.addEventListener('load', () => {
    const theme = (sessionState.config && sessionState.config.theme) || 'dark';
    // ttyd/xterm may initialize asynchronously after iframe load — retry briefly
    let attempts = 0;
    const tryApply = () => {
      try {
        const win = frame.contentWindow;
        const term = win && (win.term || win.terminal);
        if (term && term.options) {
          term.options.theme = XTERM_THEMES[theme] || XTERM_THEMES.dark;
          return;
        }
      } catch (_) { /* not ready */ }
      if (++attempts < 20) setTimeout(tryApply, 250);
    };
    tryApply();
  }, { once: true });
  requestAnimationFrame(() => {
    if (iframeUrl) {
      frame.src = iframeUrl;
    } else {
      frame.src = `/terminal/?arg=${encodeURIComponent(projectName)}`;
    }
  });
}

/**
 * Apply Web UI mode restrictions — disable tmux-dependent buttons.
 * Called when the session is an OpenClaw Web UI session (no tmux).
 */
function applyWebuiMode() {
  const disable = (id, title) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = true;
      el.title = title;
    }
  };
  disable('peekBtn', 'Peek not available for Web UI sessions');
  disable('cmdBtn', 'Command bar not available for Web UI sessions');
  disable('selectBtn', 'Select not available for Web UI sessions');
  disable('uploadBtn', 'Upload not available for Web UI sessions');

  // Hide command bar if open
  document.getElementById('commandBar').classList.add('hidden');
}

// ── Mouse Guard ──

let mouseGuardTimer = null;

/**
 * Periodically check tmux mouse mode and turn it off if it drifted on.
 * Only active on touch devices. Uses setTimeout chain to prevent burst storms.
 */
function startMouseGuard() {
  if (!('ontouchstart' in window)) return;
  stopMouseGuard();
  mouseGuardTimer = true; // sentinel
  function scheduleNext() {
    if (!mouseGuardTimer) return;
    mouseGuardTimer = setTimeout(async () => {
      if (!mouseGuardTimer) return;
      if (!_pageVisible) return; // skip while hidden
      const data = await api(`/api/tmux/mouse/${encodeURIComponent(projectName)}`);
      if (data && data.mouse && !sessionState.mouseOn) {
        await apiMutate('/api/tmux/mouse', 'POST', {
          session: projectName,
          on: false
        });
      }
      scheduleNext();
    }, 3000);
  }
  scheduleNext();
}

/**
 * Stop mouse guard polling.
 */
function stopMouseGuard() {
  if (mouseGuardTimer && mouseGuardTimer !== true) {
    clearTimeout(mouseGuardTimer);
  }
  mouseGuardTimer = null;
}

// ── Command Bar ──

/**
 * Toggle the command bar visibility.
 */
function toggleCommandBar() {
  sessionState.commandBarOpen = !sessionState.commandBarOpen;
  const bar = document.getElementById('commandBar');
  const btn = document.getElementById('cmdBtn');
  bar.classList.toggle('hidden', !sessionState.commandBarOpen);
  btn.classList.toggle('active', sessionState.commandBarOpen);
  btn.setAttribute('aria-expanded', sessionState.commandBarOpen);
  if (sessionState.commandBarOpen) {
    document.getElementById('commandInput').focus();
  }
}

/**
 * Send a command to the active session.
 * @param {string} command
 */
async function sendCommand(command) {
  if (!command || sessionState.ended) return;
  const result = await apiMutate(
    `/api/sessions/${encodeURIComponent(projectName)}/command`,
    'POST',
    { command, enter: true }
  );
  if (result && result.ok) {
    addToHistory(command);
    document.getElementById('commandInput').value = '';
  }
}

/**
 * Add a command to the history pills.
 * @param {string} command
 */
function addToHistory(command) {
  // Avoid duplicates at the front
  sessionState.commandHistory = sessionState.commandHistory.filter(c => c !== command);
  sessionState.commandHistory.unshift(command);
  if (sessionState.commandHistory.length > 10) sessionState.commandHistory.pop();
  saveSetting('cmdHistory', sessionState.commandHistory);
  renderCommandPills();
}

/**
 * Create a command pill button element.
 * @param {string} label - Display label
 * @param {string} command - Command to send on click
 * @param {string} [title] - Tooltip text
 * @param {string} [extraClass] - Additional CSS class
 * @returns {HTMLButtonElement}
 */
function createPill(label, command, title, extraClass) {
  const btn = document.createElement('button');
  btn.className = 'command-pill' + (extraClass ? ' ' + extraClass : '');
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener('click', () => sendCommand(command));
  return btn;
}

/**
 * Render command pills: engine commands + history.
 */
function renderCommandPills() {
  const container = document.getElementById('commandPills');
  container.innerHTML = '';

  // Engine commands
  if (sessionState.project && sessionState.project.engine) {
    const engineId = sessionState.project.engine.id;
    const engine = sessionState.engines.find(e => e.id === engineId);
    if (engine && engine.commands) {
      for (const cmd of engine.commands) {
        container.appendChild(createPill(cmd.label, cmd.input, cmd.description || ''));
      }
    }
  }

  // Quick commands from config
  if (sessionState.config && sessionState.config.quickCommands) {
    for (const cmd of sessionState.config.quickCommands) {
      container.appendChild(createPill(cmd.label, cmd.command, cmd.command));
    }
  }

  // History
  for (const cmd of sessionState.commandHistory) {
    container.appendChild(createPill(cmd, cmd, 'Recent: ' + cmd, 'history'));
  }
}

// ── Peek Drawer ──

/**
 * Open the peek drawer and fetch terminal output.
 */
/**
 * Strip ANSI escape codes from a string.
 * @param {string} str - Raw string with potential ANSI codes
 * @returns {string} Clean string
 */
function stripAnsi(str) {
  // Matches: CSI sequences, OSC sequences, and other common escape codes
  return str.replace(/\x1B(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|\[[0-9;]*m)/g, '');
}

/** Whether the peek content is pinned to the bottom (sticky scroll). */
let peekStickyScroll = true;

/** Raw peek text (ANSI-stripped), used for search highlighting. */
let peekRawText = '';

/** Current peek search state. */
const peekSearch = {
  query: '',
  matches: [],       // Array of { start, end } indices into peekRawText
  currentIndex: -1,  // Which match is active
};

/**
 * Open the peek drawer and fetch content.
 */
async function openPeek() {
  sessionState.peekOpen = true;
  peekStickyScroll = true;
  document.getElementById('peekBackdrop').classList.add('open');
  document.getElementById('peekDrawer').classList.add('open');
  document.getElementById('peekTitle').textContent = `Peek: ${projectName}`;
  await refreshPeek();
}

/**
 * Close the peek drawer.
 */
function closePeek() {
  sessionState.peekOpen = false;
  document.getElementById('peekBackdrop').classList.remove('open');
  document.getElementById('peekDrawer').classList.remove('open');
  closePeekSearch();
}

/**
 * Fetch and display full terminal scrollback in the peek drawer.
 * Strips ANSI escape codes and supports sticky scroll.
 */
async function refreshPeek() {
  const content = document.getElementById('peekContent');
  content.textContent = 'Loading\u2026';

  // Remove previous alternate-screen notice if any
  const oldNotice = document.getElementById('peekAltScreenNotice');
  if (oldNotice) oldNotice.remove();

  const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/peek?full=true`);
  if (data && data.lines) {
    peekRawText = stripAnsi(data.lines.join('\n'));
    if (peekSearch.query) {
      renderPeekWithHighlights();
    } else {
      content.textContent = peekRawText;
    }
    if (peekStickyScroll) {
      content.scrollTop = content.scrollHeight;
    }
    // Show notice for alternate screen (TUI engines with no scrollback)
    if (data.alternateScreen) {
      const notice = document.createElement('div');
      notice.id = 'peekAltScreenNotice';
      notice.style.cssText = 'padding:6px 12px;background:#2a2a1a;color:#b8a830;font-size:12px;border-bottom:1px solid #444;';
      notice.textContent = 'Showing visible screen only \u2014 this engine uses a fullscreen TUI (no scrollback history)';
      content.parentNode.insertBefore(notice, content);
    }
  } else {
    peekRawText = '';
    content.textContent = 'No output available';
  }
}

/**
 * Open the peek search bar and focus the input.
 */
function openPeekSearch() {
  const bar = document.getElementById('peekSearchBar');
  bar.style.display = '';
  const input = document.getElementById('peekSearchInput');
  input.focus();
  input.select();
}

/**
 * Close the peek search bar and clear highlights.
 */
function closePeekSearch() {
  document.getElementById('peekSearchBar').style.display = 'none';
  document.getElementById('peekSearchInput').value = '';
  document.getElementById('peekSearchCount').textContent = '';
  peekSearch.query = '';
  peekSearch.matches = [];
  peekSearch.currentIndex = -1;
  // Restore plain text (no highlights)
  const content = document.getElementById('peekContent');
  if (peekRawText) {
    content.textContent = peekRawText;
  }
}

/**
 * Escape special HTML characters for safe insertion.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Execute peek search: find all matches and render highlights.
 * @param {string} query - Search string (case-insensitive literal match)
 */
function executePeekSearch(query) {
  peekSearch.query = query;
  peekSearch.matches = [];
  peekSearch.currentIndex = -1;

  if (!query || !peekRawText) {
    document.getElementById('peekSearchCount').textContent = '';
    const content = document.getElementById('peekContent');
    if (peekRawText) content.textContent = peekRawText;
    return;
  }

  // Find all case-insensitive matches
  const lowerText = peekRawText.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let pos = 0;
  while (pos < lowerText.length) {
    const idx = lowerText.indexOf(lowerQuery, pos);
    if (idx === -1) break;
    peekSearch.matches.push({ start: idx, end: idx + query.length });
    pos = idx + 1;
  }

  if (peekSearch.matches.length > 0) {
    peekSearch.currentIndex = 0;
  }

  renderPeekWithHighlights();
  updatePeekSearchCount();
  scrollToCurrentMatch();
}

/** Maximum number of matches to highlight in DOM (performance guard). */
const PEEK_MAX_HIGHLIGHTS = 1000;

/**
 * Render peek content with search match highlights.
 * Uses innerHTML with escaped text and <mark> spans.
 * When there are more than PEEK_MAX_HIGHLIGHTS matches, only highlights
 * a window around the current match to keep DOM rendering fast.
 */
function renderPeekWithHighlights() {
  const content = document.getElementById('peekContent');
  const matches = peekSearch.matches;

  if (matches.length === 0) {
    content.textContent = peekRawText;
    return;
  }

  // For large match sets, only highlight a window around the active match
  let visibleMatches = matches;
  let indexOffset = 0;
  if (matches.length > PEEK_MAX_HIGHLIGHTS) {
    const half = Math.floor(PEEK_MAX_HIGHLIGHTS / 2);
    const start = Math.max(0, peekSearch.currentIndex - half);
    const end = Math.min(matches.length, start + PEEK_MAX_HIGHLIGHTS);
    visibleMatches = matches.slice(start, end);
    indexOffset = start;
  }

  let html = '';
  let lastEnd = 0;
  for (let i = 0; i < visibleMatches.length; i++) {
    const m = visibleMatches[i];
    const globalIndex = i + indexOffset;
    // Text before this match
    html += escapeHtml(peekRawText.slice(lastEnd, m.start));
    // The match itself
    const cls = globalIndex === peekSearch.currentIndex ? 'peek-search-match peek-search-match-active' : 'peek-search-match';
    html += `<mark class="${cls}" data-match-index="${globalIndex}">${escapeHtml(peekRawText.slice(m.start, m.end))}</mark>`;
    lastEnd = m.end;
  }
  // Remaining text after last match
  html += escapeHtml(peekRawText.slice(lastEnd));

  content.innerHTML = html;
}

/**
 * Update the match count display (e.g. "3 of 42").
 */
function updatePeekSearchCount() {
  const countEl = document.getElementById('peekSearchCount');
  const total = peekSearch.matches.length;
  if (total === 0) {
    countEl.textContent = peekSearch.query ? 'No matches' : '';
  } else {
    countEl.textContent = `${peekSearch.currentIndex + 1} of ${total}`;
  }
}

/**
 * Scroll the peek content to bring the current active match into view.
 */
function scrollToCurrentMatch() {
  if (peekSearch.currentIndex < 0) return;
  const content = document.getElementById('peekContent');
  const mark = content.querySelector('.peek-search-match-active');
  if (mark) {
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    peekStickyScroll = false;
  }
}

/**
 * Navigate to the next search match.
 */
function peekSearchNext() {
  if (peekSearch.matches.length === 0) return;
  peekSearch.currentIndex = (peekSearch.currentIndex + 1) % peekSearch.matches.length;
  renderPeekWithHighlights();
  updatePeekSearchCount();
  scrollToCurrentMatch();
}

/**
 * Navigate to the previous search match.
 */
function peekSearchPrev() {
  if (peekSearch.matches.length === 0) return;
  peekSearch.currentIndex = (peekSearch.currentIndex - 1 + peekSearch.matches.length) % peekSearch.matches.length;
  renderPeekWithHighlights();
  updatePeekSearchCount();
  scrollToCurrentMatch();
}

// ── Chime System ──

let audioCtx = null;

/**
 * Initialize Web Audio context on first user gesture (required for mobile).
 */
function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  } catch (e) { console.warn('Web Audio init failed:', e.message); }
}

/**
 * Play a synthesized chime tone. Respects global chimeMuted config.
 */
function playChime() {
  if (!audioCtx) return;
  if (sessionState.config && sessionState.config.chimeMuted) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.setValueAtTime(1047, audioCtx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.4);
  } catch (e) { console.warn('Chime playback failed:', e.message); }
}

// ── Settings ──

/**
 * Open the settings modal and populate current values.
 */
function openSettings() {
  // Engine dropdown
  const engineSelect = document.getElementById('settingsEngine');
  const currentEngine = sessionState.project ? (sessionState.project.engine ? sessionState.project.engine.id : '') : '';
  engineSelect.innerHTML = buildEngineOptions(sessionState.engines, currentEngine);

  // Methodology info
  const methEl = document.getElementById('settingsMethodology');
  if (sessionState.project && sessionState.project.methodology) {
    const meth = sessionState.project.methodology;
    methEl.textContent = `${meth.name}${meth.phase ? ' \u2014 ' + meth.phase : ''}`;
  } else {
    methEl.textContent = 'None';
  }

  // Chime toggle
  document.getElementById('chimeToggle').checked = sessionState.chimeEnabled;

  // Poll interval
  document.getElementById('pollInterval').value = String(sessionState.pollInterval);

  // Mouse toggle — hide for webui sessions (no tmux)
  const isWebui = sessionState.session && sessionState.session.sessionMode === 'webui';
  const mouseGroup = document.getElementById('mouseGroup');
  if (mouseGroup) {
    mouseGroup.style.display = isWebui ? 'none' : '';
  }
  document.getElementById('mouseToggle').checked = sessionState.mouseOn;

  document.getElementById('settingsModal').classList.add('open');
}

/**
 * Close the settings modal and apply changes.
 */
async function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');

  // Apply chime
  const newChime = document.getElementById('chimeToggle').checked;
  if (newChime !== sessionState.chimeEnabled) {
    sessionState.chimeEnabled = newChime;
    saveSetting('chime', newChime);
    updateChimeIndicator();
  }

  // Apply poll interval
  const newInterval = parseInt(document.getElementById('pollInterval').value, 10);
  if (newInterval !== sessionState.pollInterval) {
    sessionState.pollInterval = newInterval;
    saveSetting('pollInterval', newInterval);
    if (!sessionState.ended) startPolling();
  }

  // Apply engine change
  const newEngine = document.getElementById('settingsEngine').value;
  if (sessionState.project && sessionState.project.engine &&
      newEngine !== sessionState.project.engine.id) {
    await apiMutate(`/api/projects/${encodeURIComponent(projectName)}`, 'PATCH', {
      engine: newEngine
    });
  }

  // Apply mouse toggle
  const newMouse = document.getElementById('mouseToggle').checked;
  if (newMouse !== sessionState.mouseOn) {
    sessionState.mouseOn = newMouse;
    await apiMutate('/api/tmux/mouse', 'POST', {
      session: projectName,
      on: newMouse
    });
  }
}

/**
 * Update the chime indicator on the Cmd button.
 */
function updateChimeIndicator() {
  const btn = document.getElementById('cmdBtn');
  if (sessionState.chimeEnabled) {
    btn.classList.add('active');
  }
}

// ── Select Mode ──

let selectTimer = null;

/**
 * Toggle text selection mode by flipping tmux mouse.
 * On mobile: mouse ON = select mode (allows native text selection).
 * On desktop: mouse OFF = select mode (allows native text selection).
 */
async function toggleSelect() {
  const isMobile = 'ontouchstart' in window;
  const btn = document.getElementById('selectBtn');

  if (selectTimer) {
    // Already in select mode — revert
    clearTimeout(selectTimer);
    selectTimer = null;
    btn.textContent = 'Select';
    btn.classList.remove('select-active');
    // Restore original mouse state
    await apiMutate('/api/tmux/mouse', 'POST', {
      session: projectName,
      on: isMobile ? false : sessionState.mouseOn
    });
    return;
  }

  // Enter select mode
  btn.textContent = 'Done';
  btn.classList.add('select-active');
  await apiMutate('/api/tmux/mouse', 'POST', {
    session: projectName,
    on: isMobile ? true : false
  });

  // Auto-revert after 30 seconds
  selectTimer = setTimeout(async () => {
    selectTimer = null;
    btn.textContent = 'Select';
    btn.classList.remove('select-active');
    await apiMutate('/api/tmux/mouse', 'POST', {
      session: projectName,
      on: isMobile ? false : sessionState.mouseOn
    });
  }, 30000);
}

// ── Upload Modal ──

let uploadFileData = null;
let uploadFileName = null;

/**
 * Open the upload modal and load recent uploads.
 */
async function openUploadModal() {
  uploadFileData = null;
  uploadFileName = null;
  document.getElementById('uploadFile').value = '';
  document.getElementById('uploadPreview').classList.add('hidden');
  document.getElementById('uploadResult').classList.add('hidden');
  document.getElementById('uploadError').classList.add('hidden');
  document.getElementById('uploadSubmitBtn').disabled = true;
  document.getElementById('uploadModal').classList.add('open');

  // Load recent uploads
  const data = await api(`/api/uploads?project=${encodeURIComponent(projectName)}`);
  const historyEl = document.getElementById('uploadHistory');
  if (data && data.uploads && data.uploads.length > 0) {
    historyEl.innerHTML = '<div class="upload-history-title">Recent uploads</div>' +
      data.uploads.slice(0, 5).map(u =>
        `<div class="upload-history-item"><code>${esc(u.name)}</code><span class="upload-history-size">${formatSize(u.size)}</span></div>`
      ).join('');
  } else {
    historyEl.innerHTML = '';
  }
}

function closeUploadModal() {
  document.getElementById('uploadModal').classList.remove('open');
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  uploadFileName = file.name;
  const reader = new FileReader();
  reader.onload = (ev) => {
    // Extract base64 from data URL
    const dataUrl = ev.target.result;
    uploadFileData = dataUrl.split(',')[1];

    // Show preview for images
    const previewEl = document.getElementById('uploadPreview');
    const imgEl = document.getElementById('uploadPreviewImg');
    if (file.type.startsWith('image/')) {
      imgEl.src = dataUrl;
      previewEl.classList.remove('hidden');
    } else {
      previewEl.classList.add('hidden');
    }

    document.getElementById('uploadSubmitBtn').disabled = false;
    document.getElementById('uploadResult').classList.add('hidden');
    document.getElementById('uploadError').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

async function submitUpload() {
  if (!uploadFileData || !uploadFileName) return;

  const btn = document.getElementById('uploadSubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  const result = await apiMutate('/api/upload', 'POST', {
    project: projectName,
    filename: uploadFileName,
    data: uploadFileData
  });

  btn.textContent = 'Upload';

  if (!result) {
    document.getElementById('uploadError').textContent = 'Upload failed.';
    document.getElementById('uploadError').classList.remove('hidden');
    btn.disabled = false;
    return;
  }

  // Show result path
  const resultEl = document.getElementById('uploadResult');
  document.getElementById('uploadResultPath').textContent = result.path;
  resultEl.classList.remove('hidden');

  // Reset for next upload
  uploadFileData = null;
  uploadFileName = null;
  document.getElementById('uploadFile').value = '';
  document.getElementById('uploadPreview').classList.add('hidden');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Kill Modal ──

/**
 * Open the kill confirmation modal.
 */
function openKillModal() {
  const isWebui = sessionState.session && sessionState.session.sessionMode === 'webui';
  document.getElementById('killText').innerHTML =
    `Kill the session for <strong>${esc(projectName)}</strong>? This ${isWebui ? 'tears down the SSH tunnel' : 'terminates the tmux session'} immediately.`;
  document.getElementById('killError').classList.add('hidden');
  document.getElementById('killPassword').value = '';
  const pwGroup = document.getElementById('killPasswordGroup');
  if (sessionState.config && sessionState.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  document.getElementById('killModal').classList.add('open');
}

/**
 * Close the kill modal.
 */
function closeKillModal() {
  document.getElementById('killModal').classList.remove('open');
}

/**
 * Confirm and execute kill.
 */
async function confirmKill() {
  const pw = document.getElementById('killPassword').value;
  const body = { reason: 'Manual kill from UI' };
  if (pw) body.password = pw;

  const res = await fetch(`/api/sessions/${encodeURIComponent(projectName)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    document.getElementById('killError').textContent = errData.error || 'Kill failed.';
    document.getElementById('killError').classList.remove('hidden');
    return;
  }

  closeKillModal();
  window.location.href = '/';
}

// ── Capability Gating ──

/**
 * Hide or disable UI elements based on engine capabilities.
 * Engines without supportsPrimePrompt (like OpenClaw) cannot wrap.
 */
function applyCapabilityGates() {
  const project = sessionState.project;
  if (!project || !project.engine || !project.engine.capabilities) return;

  const caps = project.engine.capabilities;

  // Hide wrap button if engine doesn't support prime prompt (no wrap protocol)
  if (caps.supportsPrimePrompt === false) {
    const wrapBtn = document.getElementById('wrapBtn');
    if (wrapBtn) wrapBtn.style.display = 'none';
  }
}

// ── Wrap Modal ──

/**
 * Open the wrap confirmation modal.
 */
function openWrapModal() {
  document.getElementById('wrapText').innerHTML =
    `Wrap the session for <strong>${esc(projectName)}</strong>? This sends the wrap command and ends the session.`;
  document.getElementById('wrapError').classList.add('hidden');
  document.getElementById('wrapPassword').value = '';
  const pwGroup = document.getElementById('wrapPasswordGroup');
  if (sessionState.config && sessionState.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  document.getElementById('wrapModal').classList.add('open');
}

/**
 * Close the wrap modal.
 */
function closeWrapModal() {
  document.getElementById('wrapModal').classList.remove('open');
}

/**
 * Confirm and execute wrap.
 */
async function confirmWrap() {
  const pw = document.getElementById('wrapPassword').value;
  const body = {};
  if (pw) body.password = pw;

  const data = await apiMutate(
    `/api/sessions/${encodeURIComponent(projectName)}/wrap`,
    'POST',
    body
  );

  if (!data) {
    document.getElementById('wrapError').textContent = 'Wrap failed. Check password.';
    document.getElementById('wrapError').classList.remove('hidden');
    return;
  }

  closeWrapModal();
  // Immediately show wrapping state
  sessionState.wrapping = true;
  showWrappingState();
  // Increase poll frequency during wrapping
  sessionState.pollInterval = 2000;
  startPolling();
}

// ── Terminal Touch Scroll Shim ──
// xterm.js virtual scroll doesn't handle mobile touch well.
// We intercept touch events on the iframe and manually scroll the xterm instance.

/**
 * Set up touch-based scrolling for the terminal iframe.
 * Waits for the iframe to load, then attaches touch listeners to xterm's viewport.
 */
function setupTerminalTouchScroll() {
  if (!('ontouchstart' in window)) return; // desktop doesn't need this

  const frame = document.getElementById('terminalFrame');
  frame.addEventListener('load', () => {
    try {
      const iframeDoc = frame.contentDocument || frame.contentWindow.document;
      const viewport = iframeDoc.querySelector('.xterm-viewport');
      if (!viewport) return;

      let touchStartY = 0;
      let lastTouchY = 0;
      let scrollAccum = 0;
      const LINE_HEIGHT = 18; // approximate xterm line height in px

      viewport.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        touchStartY = e.touches[0].clientY;
        lastTouchY = touchStartY;
        scrollAccum = 0;
      }, { passive: true });

      viewport.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        const currentY = e.touches[0].clientY;
        const deltaY = lastTouchY - currentY; // positive = scroll down
        lastTouchY = currentY;
        scrollAccum += deltaY;

        // Scroll in line-sized increments
        const linesToScroll = Math.trunc(scrollAccum / LINE_HEIGHT);
        if (linesToScroll !== 0) {
          scrollAccum -= linesToScroll * LINE_HEIGHT;
          // Access xterm's Terminal instance via ttyd's global
          const iframeWin = frame.contentWindow;
          const term = iframeWin && (iframeWin.term || iframeWin.terminal);
          if (term && typeof term.scrollLines === 'function') {
            term.scrollLines(linesToScroll);
          } else {
            // Fallback: scroll the viewport element directly
            viewport.scrollTop += linesToScroll * LINE_HEIGHT;
          }
        }
      }, { passive: true });
    } catch (err) {
      console.warn('Touch scroll shim failed:', err.message);
    }
  });
}

// ── Wrapping State ──

let wrapTimeoutTimer = null;

/**
 * Show wrapping state UI — amber dot, disable action buttons, show wrapping bar.
 * Terminal stays visible so user can watch the wrap.
 */
function showWrappingState() {
  sessionState.wrapping = true;

  const dot = document.getElementById('statusDot');
  dot.classList.add('wrapping');
  dot.title = 'Wrapping...';

  // Disable wrap/cmd buttons but keep kill enabled as escape hatch
  document.getElementById('wrapBtn').disabled = true;
  document.getElementById('killBtn').disabled = false;
  document.getElementById('cmdBtn').disabled = true;
  document.getElementById('commandSend').disabled = true;

  // Show wrapping bar
  document.getElementById('sessionWrapping').classList.remove('hidden');

  // Fallback timeout — force-complete if idle detection never triggers
  clearWrapTimeout();
  wrapTimeoutTimer = setTimeout(() => {
    if (sessionState.wrapping && !sessionState.ended) {
      console.warn('Wrap timeout reached (120s), force-completing');
      completeWrapFromIdle();
    }
  }, 120_000);
}

/**
 * Clear the wrap fallback timeout.
 */
function clearWrapTimeout() {
  if (wrapTimeoutTimer) {
    clearTimeout(wrapTimeoutTimer);
    wrapTimeoutTimer = null;
  }
}

/**
 * Complete wrap when session went idle (tmux still alive).
 * Calls the server to finalize the wrap, then transitions to completed UI.
 * Guarded against re-entry — only runs once.
 */
async function completeWrapFromIdle() {
  if (sessionState.wrapCompleting) return;
  sessionState.wrapCompleting = true;
  clearWrapTimeout();

  const data = await apiMutate(
    `/api/sessions/${encodeURIComponent(projectName)}/wrap/complete`,
    'POST',
    {}
  );
  // Transition to completed state regardless of API result
  handleWrapCompleted(data || {});
}

/**
 * Handle wrap completion — show ended bar with 20s countdown + Stay button.
 * @param {object} data - Status data with wrapCompleted flag
 */
function handleWrapCompleted(data) {
  sessionState.ended = true;
  sessionState.wrapping = false;
  sessionState.wrapCompleting = false;
  stopPolling();
  clearWrapTimeout();

  // Hide wrapping bar
  document.getElementById('sessionWrapping').classList.add('hidden');

  const dot = document.getElementById('statusDot');
  dot.classList.remove('wrapping');
  dot.classList.add('ended');
  dot.title = 'Session wrapped';

  // Disable action buttons
  document.getElementById('wrapBtn').disabled = true;
  document.getElementById('killBtn').disabled = true;
  document.getElementById('cmdBtn').disabled = true;
  document.getElementById('commandSend').disabled = true;

  // Show ended bar with longer countdown
  const endedBar = document.getElementById('sessionEnded');
  endedBar.classList.remove('hidden');

  let remaining = 20;
  const countdownEl = document.getElementById('countdown');
  countdownEl.textContent = `Returning in ${remaining}s`;
  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      window.location.href = '/';
    } else {
      countdownEl.textContent = `Returning in ${remaining}s`;
    }
  }, 1000);
}

// ── Event Bindings ──

function bindEvents() {
  const $ = (id) => document.getElementById(id);

  // Close group popovers on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.group-pill')) {
      document.querySelectorAll('.group-popover.open').forEach(el => el.classList.remove('open'));
    }
  });

  // Banner buttons
  $('selectBtn').addEventListener('click', toggleSelect);
  $('uploadBtn').addEventListener('click', openUploadModal);
  $('cmdBtn').addEventListener('click', toggleCommandBar);
  $('peekBtn').addEventListener('click', openPeek);
  $('settingsBtn').addEventListener('click', openSettings);
  $('wrapBtn').addEventListener('click', openWrapModal);
  $('killBtn').addEventListener('click', openKillModal);

  // Stay button — cancel countdown
  $('stayBtn').addEventListener('click', () => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    $('countdown').textContent = 'Staying';
    $('stayBtn').disabled = true;
  });

  // Upload modal
  $('uploadFile').addEventListener('change', handleFileSelect);
  $('uploadCancelBtn').addEventListener('click', closeUploadModal);
  $('uploadSubmitBtn').addEventListener('click', submitUpload);
  $('uploadModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeUploadModal();
  });

  // Command bar
  $('commandSend').addEventListener('click', () => {
    sendCommand($('commandInput').value.trim());
  });
  $('commandInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCommand($('commandInput').value.trim());
    }
  });

  // Peek drawer
  $('peekClose').addEventListener('click', closePeek);
  $('peekRefresh').addEventListener('click', refreshPeek);
  $('peekBackdrop').addEventListener('click', closePeek);

  // Peek search
  $('peekSearchBtn').addEventListener('click', openPeekSearch);
  $('peekSearchClose').addEventListener('click', closePeekSearch);
  $('peekSearchNext').addEventListener('click', peekSearchNext);
  $('peekSearchPrev').addEventListener('click', peekSearchPrev);

  // Search input: debounced live search + keyboard navigation
  let peekSearchTimer = null;
  $('peekSearchInput').addEventListener('input', (e) => {
    clearTimeout(peekSearchTimer);
    peekSearchTimer = setTimeout(() => executePeekSearch(e.target.value), 150);
  });
  $('peekSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) { peekSearchPrev(); } else { peekSearchNext(); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePeekSearch();
    }
  });

  // Cmd/Ctrl+F when peek is open opens search instead of browser find
  document.addEventListener('keydown', (e) => {
    if (sessionState.peekOpen && (e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      openPeekSearch();
    }
  });

  // Jump buttons
  $('peekJumpTop').addEventListener('click', () => {
    const content = $('peekContent');
    content.scrollTop = 0;
    peekStickyScroll = false;
  });
  $('peekJumpBottom').addEventListener('click', () => {
    const content = $('peekContent');
    content.scrollTop = content.scrollHeight;
    peekStickyScroll = true;
  });

  // Sticky scroll: unlock when user scrolls up, re-lock when at bottom
  $('peekContent').addEventListener('scroll', () => {
    const el = $('peekContent');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    peekStickyScroll = atBottom;
  });

  // Settings modal
  $('settingsCloseBtn').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  // Kill modal
  $('killCancelBtn').addEventListener('click', closeKillModal);
  $('killConfirmBtn').addEventListener('click', confirmKill);
  $('killModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeKillModal();
  });

  // Wrap modal
  $('wrapCancelBtn').addEventListener('click', closeWrapModal);
  $('wrapConfirmBtn').addEventListener('click', confirmWrap);
  $('wrapModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeWrapModal();
  });

  // Audio context initialization on first interaction (mobile requirement)
  document.addEventListener('touchstart', initAudio, { once: true });
  document.addEventListener('click', initAudio, { once: true });
}

// ── Initialization ──

async function initSession() {
  if (!projectName) {
    window.location.href = '/';
    return;
  }

  // Load persisted settings
  sessionState.chimeEnabled = loadSetting('chime', false);
  sessionState.pollInterval = loadSetting('pollInterval', 5000);
  sessionState.commandHistory = loadSetting('cmdHistory', []);

  // Set grace period if just launched (avoids false "session ended" on race)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('launched') === '1') {
    sessionState.launchGraceRemaining = 3;
  }

  bindEvents();

  // Parallel data loading (loadVersion runs after loadProject since it reads project data)
  await Promise.all([loadProject(), loadConfig(), loadEngines(), loadUpdateStatus()]);
  loadVersion();

  if (!sessionState.project) {
    // Project not found
    document.getElementById('bannerName').textContent = 'Not Found';
    return;
  }

  // Capability-gate UI elements based on engine
  applyCapabilityGates();

  // Check initial session status before setting up terminal (need to know session mode)
  await pollStatus();

  const isWebui = sessionState.session && sessionState.session.sessionMode === 'webui';

  // Set up terminal iframe based on session mode
  if (isWebui) {
    setupTerminal(sessionState.session.iframeUrl);
    applyWebuiMode();
  } else {
    setupTerminal();
    setupTerminalTouchScroll();
  }

  // Load shared docs for settings
  loadSharedDocs();

  // Render command pills (skip for webui — no command injection)
  if (!isWebui) {
    renderCommandPills();
  }

  // Update chime indicator
  updateChimeIndicator();

  // Start polling if session is active
  if (!sessionState.ended) {
    startPolling();
  }

  // Poll model status every 2 minutes (setTimeout chain to avoid burst storms)
  (function modelStatusLoop() {
    setTimeout(() => {
      loadModelStatus();
      modelStatusLoop();
    }, 120000);
  })();

  // Mouse guard and initial mouse state — tmux only
  if (!isWebui) {
    startMouseGuard();
    const mouseData = await api(`/api/tmux/mouse/${encodeURIComponent(projectName)}`);
    if (mouseData) {
      sessionState.mouseOn = mouseData.mouse;
    }
  }
}

initSession();
