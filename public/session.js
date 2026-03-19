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
  commandHistory: [],
  ended: false,
  wrapping: false,
  mouseOn: false,
  launchGraceRemaining: 0
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
      reconnectTimer = setInterval(() => pollStatus(), 5000);
    }
  } else {
    toast.textContent = 'Reconnected';
    toast.className = 'toast toast-ok visible';
    dot.classList.remove('disconnected');
    dot.title = 'Connected';
    document.getElementById('commandSend').disabled = false;
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
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
}

/**
 * Load version and display in banner.
 */
async function loadVersion() {
  const data = await api('/api/version');
  if (data) {
    document.getElementById('bannerVersion').textContent = `v${data.version}`;
  }
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
 * Apply the current theme to the document.
 */
function applyTheme() {
  const theme = (sessionState.config && sessionState.config.theme) || 'dark';
  if (theme === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

/**
 * Load engine list for settings dropdown.
 */
async function loadEngines() {
  const data = await api('/api/engines');
  if (data) sessionState.engines = data.engines || [];
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

  // Idle detection for chime
  if (data.active && data.idle) {
    sessionState.idleCount++;
    if (sessionState.idleCount >= 2 && sessionState.chimeEnabled) {
      playChime();
      sessionState.idleCount = 0;
    }
  } else {
    sessionState.idleCount = 0;
  }
}

/**
 * Start polling at the configured interval.
 */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollStatus, sessionState.pollInterval);
}

/**
 * Stop status polling.
 */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
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
 * Set up the terminal iframe with the ttyd URL.
 * Delays loading until layout is stable to avoid resize-triggered redraws.
 */
function setupTerminal() {
  const frame = document.getElementById('terminalFrame');
  requestAnimationFrame(() => {
    frame.src = `/terminal/?arg=${encodeURIComponent(projectName)}`;
  });
}

// ── Mouse Guard ──

let mouseGuardTimer = null;

/**
 * Periodically check tmux mouse mode and turn it off if it drifted on.
 * Only active on touch devices.
 */
function startMouseGuard() {
  if (!('ontouchstart' in window)) return;
  mouseGuardTimer = setInterval(async () => {
    const data = await api(`/api/tmux/mouse/${encodeURIComponent(projectName)}`);
    if (data && data.mouse && !sessionState.mouseOn) {
      await apiMutate('/api/tmux/mouse', 'POST', {
        session: projectName,
        on: false
      });
    }
  }, 3000);
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
async function openPeek() {
  sessionState.peekOpen = true;
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
}

/**
 * Fetch and display terminal output in the peek drawer.
 */
async function refreshPeek() {
  const content = document.getElementById('peekContent');
  content.textContent = 'Loading\u2026';

  const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/peek?lines=50`);
  if (data && data.lines) {
    content.textContent = data.lines.join('\n');
    // Auto-scroll to bottom
    content.scrollTop = content.scrollHeight;
  } else {
    content.textContent = 'No output available';
  }
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
  engineSelect.innerHTML = sessionState.engines.map(e =>
    `<option value="${esc(e.id)}" ${e.id === currentEngine ? 'selected' : ''}>${esc(e.name)}${e.available === false ? ' (not installed)' : ''}</option>`
  ).join('');

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

  // Mouse toggle
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
  document.getElementById('killText').innerHTML =
    `Kill the session for <strong>${esc(projectName)}</strong>? This terminates the tmux session immediately.`;
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

  const data = await apiMutate(
    `/api/sessions/${encodeURIComponent(projectName)}`,
    'DELETE',
    body
  );

  if (!data) {
    document.getElementById('killError').textContent = 'Kill failed. Check password.';
    document.getElementById('killError').classList.remove('hidden');
    return;
  }

  closeKillModal();
  window.location.href = '/';
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
}

/**
 * Complete wrap when session went idle (tmux still alive).
 * Calls the server to finalize the wrap, then transitions to completed UI.
 */
async function completeWrapFromIdle() {
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
  stopPolling();

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

  // Parallel data loading
  await Promise.all([loadProject(), loadVersion(), loadConfig(), loadEngines()]);

  if (!sessionState.project) {
    // Project not found
    document.getElementById('bannerName').textContent = 'Not Found';
    return;
  }

  // Set up terminal iframe
  setupTerminal();
  setupTerminalTouchScroll();

  // Render command pills
  renderCommandPills();

  // Update chime indicator
  updateChimeIndicator();

  // Check initial session status
  await pollStatus();

  // Start polling if session is active
  if (!sessionState.ended) {
    startPolling();
  }

  // Poll model status every 2 minutes
  setInterval(() => loadModelStatus(), 120000);

  // Start mouse guard on touch devices
  startMouseGuard();

  // Load initial mouse state
  const mouseData = await api(`/api/tmux/mouse/${encodeURIComponent(projectName)}`);
  if (mouseData) {
    sessionState.mouseOn = mouseData.mouse;
  }
}

initSession();
