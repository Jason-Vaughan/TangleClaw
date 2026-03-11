'use strict';

const fs = require('fs');
const path = require('path');

const TC_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')
).version;

const PROJECTS_DIR = path.join(process.env.HOME, 'Documents', 'Projects');

function getProjectVersion(projectName) {
  if (!projectName || projectName === '__root__') return null;
  const projectPath = path.join(PROJECTS_DIR, projectName);
  for (const file of ['version.json', 'package.json']) {
    const filePath = path.join(projectPath, file);
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.version) return data.version;
      }
    } catch {}
  }
  return null;
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPage(projectName, ttydPort) {
  const safe = escHtml(projectName);
  const isRoot = projectName === '__root__';
  const displayName = isRoot ? 'Projects Directory' : safe;
  const tabTitle = isRoot ? 'TangleClaw - Projects' : `${safe} - TangleClaw`;
  const projectVersion = getProjectVersion(projectName);
  const ttydUrl = `http://" + window.location.hostname + ":${ttydPort}?arg=${encodeURIComponent(projectName)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#8BC34A">
  <title>${tabTitle}</title>
  <style>
    :root {
      --primary: #8BC34A;
      --primary-bright: #9CCC65;
      --primary-dark: #558B2F;
      --bg: #000000;
      --card-bg: #0D0D0D;
      --elevated-bg: #1A1A1A;
      --danger: #EF5350;
      --danger-dark: #C62828;
      --text: #E8E8E8;
      --text-muted: #777;
      --banner-height: 44px;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Persistent Banner ── */
    .banner {
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: var(--banner-height);
      padding: 0 12px;
      background: var(--elevated-bg);
      border-bottom: 1px solid #333;
      flex-shrink: 0;
    }

    .banner-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .banner-brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex-shrink: 0;
      gap: 0;
    }

    .banner-logo {
      width: 28px;
      height: 28px;
      object-fit: contain;
      flex-shrink: 0;
    }

    .banner-tc-version {
      font-size: 7px;
      color: #444;
      line-height: 1;
      margin-top: -2px;
    }

    .banner-proj-version {
      font-size: 11px;
      color: #555;
      margin-left: 6px;
      font-weight: 400;
    }

    .banner-sep {
      color: #333;
      font-size: 18px;
      font-weight: 200;
      flex-shrink: 0;
    }

    .banner-project {
      font-size: 16px;
      font-weight: 700;
      color: var(--primary);
      letter-spacing: 0.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .banner-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .banner-btn {
      background: none;
      border: 1px solid #444;
      color: var(--text-muted);
      padding: 4px 10px;
      border-radius: 5px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
      -webkit-user-select: none;
      user-select: none;
    }

    .banner-btn:hover {
      border-color: var(--text-muted);
      color: var(--text);
    }

    .banner-btn:active {
      background: var(--primary-dark);
      border-color: var(--primary);
      color: var(--text);
    }

    .banner-btn.danger:hover {
      border-color: var(--danger);
      color: var(--danger);
    }

    .banner-btn.danger:active {
      background: var(--danger-dark);
      border-color: var(--danger);
      color: #fff;
    }

    .banner-btn.danger.confirm {
      background: var(--danger-dark);
      border-color: var(--danger);
      color: #fff;
    }

    .banner-home {
      text-decoration: none;
      color: var(--text-muted);
      font-size: 16px;
      padding: 4px;
      display: flex;
      align-items: center;
    }

    .banner-home:hover { color: var(--primary); }

    /* ── Terminal iframe ── */
    .terminal-frame {
      flex: 1;
      border: none;
      width: 100%;
      background: var(--bg);
    }

    /* ── Status indicator ── */
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--primary);
      flex-shrink: 0;
      animation: breathe 2s ease-in-out infinite;
    }

    @keyframes breathe {
      0%, 100% { background: var(--primary-bright); box-shadow: 0 0 10px var(--primary-bright); }
      50% { background: var(--primary-dark); box-shadow: 0 0 2px var(--primary-dark); }
    }

    .status-dot.disconnected {
      background: var(--danger);
      animation: none;
      box-shadow: 0 0 6px var(--danger);
    }

    /* ── Kill Confirm Modal ── */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 200;
      display: none;
      align-items: center;
      justify-content: center;
    }

    .modal-overlay.open { display: flex; }

    .kill-confirm-modal {
      background: var(--card-bg);
      border: 1px solid var(--elevated-bg);
      border-radius: 12px;
      padding: 24px;
      max-width: 340px;
      text-align: center;
    }

    .kill-confirm-modal h3 {
      font-size: 17px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 10px;
    }

    .kill-confirm-modal p {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 20px;
    }

    .kill-confirm-modal strong { color: var(--text); }

    .kill-confirm-buttons {
      display: flex;
      gap: 10px;
      justify-content: center;
    }

    .btn-cancel-sm {
      background: var(--elevated-bg);
      color: var(--text-muted);
      border: 1px solid #333;
      padding: 8px 18px;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
    }

    .btn-cancel-sm:hover { background: #222; }

    .btn-kill {
      background: var(--danger);
      color: #fff;
      border: none;
      padding: 8px 18px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .btn-kill:hover { background: var(--danger-dark); }

    /* ── Upload Modal ── */
    .upload-modal {
      background: var(--card-bg);
      border: 1px solid var(--elevated-bg);
      border-radius: 12px;
      padding: 24px;
      max-width: 400px;
      width: 90%;
    }
    .upload-modal h3 {
      font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 14px;
    }
    .upload-modal input[type="file"] {
      color: var(--text); font-size: 14px; margin-bottom: 12px; width: 100%;
    }
    .upload-preview {
      display: none; margin: 10px 0; text-align: center;
    }
    .upload-preview img {
      max-width: 100%; max-height: 160px; border-radius: 6px; border: 1px solid #333;
    }
    .upload-result {
      display: none; margin: 10px 0; padding: 10px; background: var(--bg);
      border: 1px solid #333; border-radius: 6px;
    }
    .upload-result-label {
      color: var(--primary); font-size: 13px; font-weight: 600; margin-bottom: 4px;
    }
    .upload-result-path {
      font-family: monospace; font-size: 11px; color: var(--text-muted); word-break: break-all;
    }
    .upload-result-hint {
      font-size: 11px; color: var(--text-muted); margin-top: 6px; font-style: italic;
    }
    .upload-history {
      display: none; margin: 10px 0; max-height: 100px; overflow-y: auto;
    }
    .upload-history-label {
      color: var(--text-muted); font-size: 11px; margin-bottom: 4px;
    }
    .upload-history-item {
      font-family: monospace; font-size: 10px; color: var(--text-muted);
      padding: 2px 0; border-bottom: 1px solid #1a1a1a; word-break: break-all;
    }
    .upload-buttons {
      display: flex; gap: 10px; justify-content: center; margin-top: 16px;
    }
    .btn-upload {
      background: var(--primary-dark); color: #fff; border: none;
      padding: 8px 18px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .btn-upload:hover { background: var(--primary); }
    .btn-upload:disabled { opacity: 0.5; cursor: default; }

    /* ── Command Bar ── */
    .cmd-bar {
      display: none;
      flex-direction: column;
      background: var(--card-bg);
      border-bottom: 1px solid #333;
      flex-shrink: 0;
      overflow: hidden;
    }

    .cmd-bar.open { display: flex; }

    .cmd-input-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
    }

    .cmd-input {
      flex: 1;
      background: var(--bg);
      border: 1px solid #333;
      border-radius: 6px;
      color: var(--text);
      font-family: monospace;
      font-size: 14px;
      padding: 8px 10px;
      outline: none;
      min-width: 0;
    }

    .cmd-input:focus { border-color: var(--primary-dark); }

    .cmd-input::placeholder { color: #555; }

    .cmd-send {
      background: var(--primary-dark);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 8px 14px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
      min-height: 38px;
    }

    .cmd-send:hover { background: var(--primary); }
    .cmd-send:active { background: var(--primary-bright); }

    .cmd-pills {
      display: flex;
      gap: 6px;
      padding: 0 10px 6px;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }

    .cmd-pills::-webkit-scrollbar { display: none; }

    .cmd-pill {
      background: var(--elevated-bg);
      border: 1px solid #333;
      border-radius: 14px;
      color: var(--text-muted);
      font-size: 11px;
      font-family: monospace;
      padding: 4px 10px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      -webkit-user-select: none;
      user-select: none;
    }

    .cmd-pill:active {
      background: var(--primary-dark);
      border-color: var(--primary);
      color: #fff;
    }

    .cmd-pill.history-pill {
      border-style: dashed;
    }

    .banner-btn.active {
      border-color: var(--primary);
      color: var(--primary);
    }

    /* ── Settings Modal ── */
    .settings-modal {
      background: var(--card-bg);
      border: 1px solid var(--elevated-bg);
      border-radius: 12px;
      padding: 24px;
      max-width: 360px;
      width: 90%;
    }

    .settings-modal h3 {
      font-size: 17px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 16px;
    }

    .settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #1a1a1a;
    }

    .settings-row:last-child { border-bottom: none; }

    .settings-label {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .settings-label-text {
      font-size: 14px;
      color: var(--text);
    }

    .settings-label-hint {
      font-size: 11px;
      color: var(--text-muted);
    }

    .toggle-switch {
      position: relative;
      width: 44px;
      height: 26px;
      flex-shrink: 0;
    }

    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-slider {
      position: absolute;
      inset: 0;
      background: #333;
      border-radius: 13px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .toggle-slider::before {
      content: '';
      position: absolute;
      width: 20px;
      height: 20px;
      left: 3px;
      bottom: 3px;
      background: #888;
      border-radius: 50%;
      transition: transform 0.2s, background 0.2s;
    }

    .toggle-switch input:checked + .toggle-slider {
      background: var(--primary-dark);
    }

    .toggle-switch input:checked + .toggle-slider::before {
      transform: translateX(18px);
      background: var(--primary);
    }

    .settings-select {
      background: #000;
      color: var(--text);
      border: 1px solid #333;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 14px;
      flex-shrink: 0;
      min-width: 64px;
      -webkit-appearance: none;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23777' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      padding-right: 28px;
    }

    .settings-close {
      display: block;
      width: 100%;
      margin-top: 16px;
      background: var(--elevated-bg);
      color: var(--text-muted);
      border: 1px solid #333;
      padding: 10px;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      text-align: center;
    }

    .settings-close:hover { background: #222; }

    .banner-btn.settings-btn {
      font-size: 14px;
      padding: 4px 8px;
    }

    /* ── Chime indicator ── */
    .chime-active {
      color: var(--primary) !important;
      border-color: var(--primary) !important;
    }

    /* ── Wrap settings ── */
    .settings-row.column {
      flex-direction: column;
      align-items: stretch;
    }

    .settings-input {
      background: #000;
      color: var(--text);
      border: 1px solid #333;
      border-radius: 6px;
      font-family: monospace;
      font-size: 13px;
      padding: 8px 10px;
      width: 100%;
      margin-top: 6px;
      outline: none;
      box-sizing: border-box;
    }
    .settings-input:focus { border-color: var(--primary-dark); }
    .settings-input::placeholder { color: #555; }

    .settings-textarea {
      background: #000;
      color: var(--text);
      border: 1px solid #333;
      border-radius: 6px;
      font-family: monospace;
      font-size: 12px;
      padding: 8px 10px;
      width: 100%;
      margin-top: 6px;
      outline: none;
      resize: vertical;
      min-height: 80px;
      box-sizing: border-box;
    }
    .settings-textarea:focus { border-color: var(--primary-dark); }

    .settings-label-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .settings-clear-btn {
      background: none;
      border: 1px solid #333;
      color: var(--text-muted);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
    }
    .settings-clear-btn:hover { border-color: var(--danger); color: var(--danger); }

    .banner-btn.wrapping {
      border-color: var(--primary);
      color: var(--primary);
      animation: pulse 1s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  </style>
</head>
<body>
  <div class="banner">
    <div class="banner-left">
      <a href="/" class="banner-home" title="Back to projects">&#9664;</a>
      <div class="banner-brand">
        <img src="/logo-icon.png" alt="" class="banner-logo">
        <span class="banner-tc-version">v${TC_VERSION}</span>
      </div>
      <span class="banner-sep">|</span>
      <span class="banner-project">${displayName}</span>${projectVersion ? `<span class="banner-proj-version">v${projectVersion}</span>` : ''}
    </div>
    <div class="banner-right">
      <div class="status-dot" id="status-dot" title="Session status"></div>
      <button class="banner-btn" id="btn-select" onclick="toggleSelect()" title="Enable text selection for copy">Select</button>
      <button class="banner-btn" id="btn-upload" onclick="openUpload()" title="Upload file to this project">Upload</button>
      <button class="banner-btn" id="btn-peek" onclick="peekSession()" title="Peek at terminal output">Peek</button>
      <button class="banner-btn" id="btn-cmd" onclick="toggleCmdBar()" title="Send command to session">Cmd</button>
      <button class="banner-btn settings-btn" id="btn-settings" onclick="openSettings()" title="Settings">&#9881;</button>
      <button class="banner-btn" id="btn-wrap" onclick="confirmWrap()" title="Wrap session: save context and end">Wrap</button>
      <button class="banner-btn danger" id="btn-kill" onclick="confirmKillSession()" title="Kill this session">Kill</button>
    </div>
  </div>

  <div class="cmd-bar" id="cmd-bar">
    <div class="cmd-input-row">
      <input class="cmd-input" id="cmd-input" type="text" placeholder="Type or dictate a command..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <button class="cmd-send" id="cmd-send" onclick="sendCmd()">Send</button>
    </div>
    <div class="cmd-pills" id="cmd-pills"></div>
  </div>

  <iframe id="terminal" class="terminal-frame"></iframe>

  <!-- Kill Confirm Modal -->
  <div class="modal-overlay" id="kill-modal">
    <div class="kill-confirm-modal">
      <h3>Kill Session</h3>
      <p>End <strong>${displayName}</strong>?<br>This will terminate all processes in the session.</p>
      <div class="kill-confirm-buttons">
        <button class="btn-cancel-sm" onclick="closeKillModal()">Cancel</button>
        <button class="btn-kill" onclick="executeKill()">Kill Session</button>
      </div>
    </div>
  </div>

  <!-- Upload Modal -->
  <div class="modal-overlay" id="upload-modal">
    <div class="upload-modal">
      <h3>Upload to ${displayName}</h3>
      <input type="file" id="upload-file" accept="image/*,.pdf,.md,.txt,.json,.yaml,.yml">
      <div class="upload-preview" id="upload-preview">
        <img id="upload-preview-img">
      </div>
      <div class="upload-result" id="upload-result">
        <div class="upload-result-label">Uploaded!</div>
        <div class="upload-result-path" id="upload-result-path"></div>
        <div class="upload-result-hint">Tell your AI assistant this path to reference the file.</div>
      </div>
      <div class="upload-history" id="upload-history">
        <div class="upload-history-label">Recent uploads:</div>
        <div id="upload-history-list"></div>
      </div>
      <div class="upload-buttons">
        <button class="btn-cancel-sm" onclick="closeUpload()">Close</button>
        <button class="btn-upload" id="upload-submit" onclick="doUpload()">Upload</button>
      </div>
    </div>
  </div>

  <!-- Settings Modal -->
  <div class="modal-overlay" id="settings-modal">
    <div class="settings-modal">
      <h3>Settings</h3>
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Prompt chime</span>
          <span class="settings-label-hint">Play a sound when the terminal is waiting for input</span>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="setting-chime" onchange="toggleChime(this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <div class="settings-label">
          <span class="settings-label-text">Poll interval</span>
          <span class="settings-label-hint">How often to check terminal state (seconds)</span>
        </div>
        <select class="settings-select" id="setting-interval" onchange="changeInterval(this.value)">
          <option value="2000">2s</option>
          <option value="3000">3s</option>
          <option value="5000" selected>5s</option>
          <option value="10000">10s</option>
          <option value="15000">15s</option>
          <option value="30000">30s</option>
        </select>
      </div>
      <div class="settings-row column">
        <div class="settings-label">
          <span class="settings-label-text">Wrap command</span>
          <span class="settings-label-hint">Command sent to AI before ending session</span>
        </div>
        <input class="settings-input" id="setting-wrap-cmd" type="text"
          placeholder="/session-wrap" autocomplete="off" autocorrect="off"
          spellcheck="false" onchange="saveWrapSettings()">
      </div>
      <div class="settings-row column">
        <div class="settings-label-row">
          <div class="settings-label">
            <span class="settings-label-text">Prime prompt</span>
            <span class="settings-label-hint">Injected into next session on launch</span>
          </div>
          <button class="settings-clear-btn" onclick="clearPrimePrompt()">Clear</button>
        </div>
        <textarea class="settings-textarea" id="setting-prime-prompt" rows="4"
          placeholder="Auto-populated after wrap, or type manually..."
          onchange="saveWrapSettings()"></textarea>
      </div>
      <button class="settings-close" onclick="closeSettings()">Done</button>
    </div>
  </div>

  <!-- Wrap Confirm Modal -->
  <div class="modal-overlay" id="wrap-modal">
    <div class="kill-confirm-modal">
      <h3>Wrap Session</h3>
      <p>Send wrap command to <strong>${displayName}</strong>, capture output, then end the session.</p>
      <div class="kill-confirm-buttons">
        <button class="btn-cancel-sm" onclick="closeWrapModal()">Cancel</button>
        <button class="btn-kill" style="background:var(--primary-dark)" onclick="executeWrap()">Wrap &amp; Kill</button>
      </div>
    </div>
  </div>

  <script>
    const projectName = ${JSON.stringify(projectName)};

    // Build ttyd URL via same-origin reverse proxy
    const ttydUrl = '/terminal/?arg=' + encodeURIComponent(projectName);
    document.getElementById('terminal').src = ttydUrl;

    // Poll session status
    async function checkStatus() {
      try {
        const res = await fetch('/api/projects');
        const projects = await res.json();
        const sessionName = projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
        const p = projects.find(p => p.sessionName === sessionName || (projectName === '__root__' && p.isRoot));
        const dot = document.getElementById('status-dot');
        if (p && p.hasSession) {
          dot.className = 'status-dot';
        } else {
          dot.className = 'status-dot disconnected';
        }
      } catch {}
    }
    checkStatus();
    setInterval(checkStatus, 10000);

    // ── Select Mode: toggle tmux mouse off so browser handles selection ──
    var _selectMode = false;
    var _selectTimer = null;

    async function toggleSelect() {
      const btn = document.getElementById('btn-select');
      _selectMode = !_selectMode;

      try {
        await fetch('/api/tmux/mouse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ on: !_selectMode }),
        });
      } catch {}

      if (_selectMode) {
        btn.textContent = 'Done';
        btn.style.borderColor = 'var(--primary)';
        btn.style.color = 'var(--primary)';
        // Auto-disable after 30s
        _selectTimer = setTimeout(() => { if (_selectMode) toggleSelect(); }, 30000);
      } else {
        btn.textContent = 'Select';
        btn.style.borderColor = '';
        btn.style.color = '';
        if (_selectTimer) { clearTimeout(_selectTimer); _selectTimer = null; }
      }
    }

    // Peek
    async function peekSession() {
      const sessionName = projectName === '__root__' ? 'Projects' : projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
      try {
        const res = await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/peek');
        const data = await res.json();
        alert(data.lines || 'No output captured');
      } catch {
        alert('Failed to peek session');
      }
    }

    // Kill session with confirmation modal
    function confirmKillSession() {
      document.getElementById('kill-modal').classList.add('open');
    }

    function closeKillModal() {
      document.getElementById('kill-modal').classList.remove('open');
    }

    async function executeKill() {
      closeKillModal();
      const sessionName = projectName === '__root__' ? 'Projects' : projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
      try {
        await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/kill', { method: 'POST' });
        window.location.href = '/';
      } catch {
        alert('Failed to kill session');
      }
    }

    // ── Upload ──
    function openUpload() {
      document.getElementById('upload-modal').classList.add('open');
      document.getElementById('upload-file').value = '';
      document.getElementById('upload-preview').style.display = 'none';
      document.getElementById('upload-result').style.display = 'none';
      const btn = document.getElementById('upload-submit');
      btn.disabled = false;
      btn.textContent = 'Upload';
      btn.onclick = doUpload;
      loadUploadHistory();
    }

    function closeUpload() {
      document.getElementById('upload-modal').classList.remove('open');
    }

    document.getElementById('upload-file').addEventListener('change', function() {
      const file = this.files[0];
      const preview = document.getElementById('upload-preview');
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          document.getElementById('upload-preview-img').src = e.target.result;
          preview.style.display = 'block';
        };
        reader.readAsDataURL(file);
      } else {
        preview.style.display = 'none';
      }
    });

    async function doUpload() {
      const file = document.getElementById('upload-file').files[0];
      if (!file) return;
      const btn = document.getElementById('upload-submit');
      btn.disabled = true;
      btn.textContent = 'Uploading...';

      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, data: base64, project: projectName }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Upload failed');
          btn.disabled = false;
          btn.textContent = 'Upload';
          return;
        }

        document.getElementById('upload-result-path').textContent = data.path;
        document.getElementById('upload-result').style.display = 'block';
        btn.textContent = 'Done';
        btn.disabled = false;
        btn.onclick = closeUpload;
        loadUploadHistory();
      } catch {
        alert('Upload failed');
        btn.disabled = false;
        btn.textContent = 'Upload';
      }
    }

    // ── Command Bar ──
    var _cmdOpen = false;
    var _cmdHistory = JSON.parse(sessionStorage.getItem('tc_cmd_history_' + projectName) || '[]');
    var _quickCommands = [];

    function toggleCmdBar() {
      _cmdOpen = !_cmdOpen;
      var bar = document.getElementById('cmd-bar');
      var btn = document.getElementById('btn-cmd');
      if (_cmdOpen) {
        bar.classList.add('open');
        btn.classList.add('active');
        document.getElementById('cmd-input').focus();
        renderPills();
      } else {
        bar.classList.remove('open');
        btn.classList.remove('active');
      }
    }

    function renderPills() {
      var container = document.getElementById('cmd-pills');
      var html = '';
      _quickCommands.forEach(function(qc) {
        html += '<span class="cmd-pill" onclick="runQuickCmd(this)" data-cmd="' + escAttr(qc.command) + '">' + esc(qc.label) + '</span>';
      });
      _cmdHistory.slice().reverse().forEach(function(cmd) {
        if (!_quickCommands.some(function(qc) { return qc.command === cmd; })) {
          html += '<span class="cmd-pill history-pill" onclick="runQuickCmd(this)" data-cmd="' + escAttr(cmd) + '">' + esc(cmd) + '</span>';
        }
      });
      container.innerHTML = html;
    }

    function esc(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function escAttr(s) {
      return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function runQuickCmd(el) {
      var cmd = el.getAttribute('data-cmd');
      document.getElementById('cmd-input').value = cmd;
      sendCmd();
    }

    async function sendCmd() {
      var input = document.getElementById('cmd-input');
      var cmd = input.value.trim();
      if (!cmd) return;

      var sessionName = projectName === '__root__' ? 'Projects' : projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
      var btn = document.getElementById('cmd-send');
      btn.textContent = '...';
      btn.disabled = true;

      try {
        var res = await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd }),
        });
        if (res.ok) {
          addToHistory(cmd);
          input.value = '';
          renderPills();
        }
      } catch {}

      btn.textContent = 'Send';
      btn.disabled = false;
      input.focus();
    }

    function addToHistory(cmd) {
      _cmdHistory = _cmdHistory.filter(function(c) { return c !== cmd; });
      _cmdHistory.push(cmd);
      if (_cmdHistory.length > 10) _cmdHistory.shift();
      sessionStorage.setItem('tc_cmd_history_' + projectName, JSON.stringify(_cmdHistory));
    }

    document.getElementById('cmd-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendCmd();
      }
    });

    fetch('/api/config').then(function(r) { return r.json(); }).then(function(cfg) {
      if (cfg.quickCommands && cfg.quickCommands.length) {
        _quickCommands = cfg.quickCommands;
        if (_cmdOpen) renderPills();
      }
    }).catch(function() {});

    // ── Settings ──
    function openSettings() {
      document.getElementById('settings-modal').classList.add('open');
    }

    function closeSettings() {
      document.getElementById('settings-modal').classList.remove('open');
    }

    // ── Prompt Chime (client-side polling) ──
    var _chimeEnabled = false;
    var _chimeAudioCtx = null;
    var _chimePollTimer = null;
    var _chimeSettingsKey = 'tc_chime_' + projectName;
    var _chimeSessionName = projectName === '__root__' ? 'Projects' : projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
    var _chimeInterval = 5000;
    var _chimeLastPeek = null;
    var _chimeChangeCount = 0;
    var _chimeStableCount = 0;
    var _chimeWasBusy = false;
    var BUSY_THRESHOLD = 3;
    var STABLE_THRESHOLD = 2;

    function playChime() {
      if (!_chimeAudioCtx) return;
      try {
        if (_chimeAudioCtx.state === 'suspended') {
          _chimeAudioCtx.resume();
        }
        var now = _chimeAudioCtx.currentTime;
        var osc1 = _chimeAudioCtx.createOscillator();
        var gain1 = _chimeAudioCtx.createGain();
        osc1.type = 'sine';
        osc1.frequency.value = 880;
        gain1.gain.setValueAtTime(0.3, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc1.connect(gain1);
        gain1.connect(_chimeAudioCtx.destination);
        osc1.start(now);
        osc1.stop(now + 0.3);

        var osc2 = _chimeAudioCtx.createOscillator();
        var gain2 = _chimeAudioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.value = 659;
        gain2.gain.setValueAtTime(0.3, now + 0.15);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
        osc2.connect(gain2);
        gain2.connect(_chimeAudioCtx.destination);
        osc2.start(now + 0.15);
        osc2.stop(now + 0.5);
      } catch {}
    }

    function chimePoll() {
      fetch('/api/sessions/' + encodeURIComponent(_chimeSessionName) + '/peek')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var text = data.lines || '';

          if (_chimeLastPeek === null) {
            _chimeLastPeek = text;
            return;
          }

          if (text !== _chimeLastPeek) {
            _chimeChangeCount++;
            _chimeStableCount = 0;
            if (_chimeChangeCount >= BUSY_THRESHOLD) {
              _chimeWasBusy = true;
            }
          } else {
            _chimeStableCount++;
            _chimeChangeCount = 0;
            if (_chimeWasBusy && _chimeStableCount >= STABLE_THRESHOLD) {
              playChime();
              _chimeWasBusy = false;
            }
          }
          _chimeLastPeek = text;
        })
        .catch(function() {});
    }

    function startChimePoll() {
      stopChimePoll();
      _chimeLastPeek = null;
      _chimeChangeCount = 0;
      _chimeStableCount = 0;
      _chimeWasBusy = false;
      _chimePollTimer = setInterval(chimePoll, _chimeInterval);
      chimePoll();
    }

    function stopChimePoll() {
      if (_chimePollTimer) {
        clearInterval(_chimePollTimer);
        _chimePollTimer = null;
      }
    }

    // Pause polling when page is hidden, resume when visible
    document.addEventListener('visibilitychange', function() {
      if (!_chimeEnabled) return;
      if (document.visibilityState === 'visible') {
        if (!_chimePollTimer) startChimePoll();
      } else {
        stopChimePoll();
      }
    });

    async function toggleChime(enabled) {
      _chimeEnabled = enabled;
      if (enabled) {
        if (!_chimeAudioCtx) {
          _chimeAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (_chimeAudioCtx.state === 'suspended') {
          await _chimeAudioCtx.resume();
        }
        playChime();
        startChimePoll();
        document.getElementById('btn-settings').classList.add('chime-active');
      } else {
        stopChimePoll();
        document.getElementById('btn-settings').classList.remove('chime-active');
      }
      localStorage.setItem(_chimeSettingsKey, JSON.stringify({ enabled: enabled, interval: _chimeInterval }));
    }

    function changeInterval(val) {
      _chimeInterval = parseInt(val, 10);
      if (_chimeEnabled) startChimePoll();
      localStorage.setItem(_chimeSettingsKey, JSON.stringify({ enabled: _chimeEnabled, interval: _chimeInterval }));
    }

    // Restore saved settings
    (function() {
      try {
        var saved = JSON.parse(localStorage.getItem(_chimeSettingsKey));
        if (saved) {
          if (saved.interval) {
            _chimeInterval = saved.interval;
            document.getElementById('setting-interval').value = String(saved.interval);
          }

          if (saved.enabled) {
            document.getElementById('setting-chime').checked = true;
            document.getElementById('btn-settings').classList.add('chime-active');
            _chimeEnabled = true;
            var _chimeResumeHandler = function() {
              if (!_chimeAudioCtx) {
                _chimeAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
              }
              if (_chimeAudioCtx.state === 'suspended') _chimeAudioCtx.resume();
              if (_chimeEnabled && !_chimePollTimer) startChimePoll();
              document.removeEventListener('touchstart', _chimeResumeHandler);
              document.removeEventListener('click', _chimeResumeHandler);
            };
            document.addEventListener('touchstart', _chimeResumeHandler, { once: true });
            document.addEventListener('click', _chimeResumeHandler, { once: true });
          }
        }
      } catch {}
    })();

    // ── Session Wrap ──
    var _wrapKey = 'tc_wrap_' + projectName;

    function loadWrapSettings() {
      try { return JSON.parse(localStorage.getItem(_wrapKey)) || {}; }
      catch { return {}; }
    }

    function saveWrapSettings() {
      var settings = loadWrapSettings();
      settings.wrapCommand = document.getElementById('setting-wrap-cmd').value.trim();
      settings.primePrompt = document.getElementById('setting-prime-prompt').value;
      localStorage.setItem(_wrapKey, JSON.stringify(settings));
    }

    function clearPrimePrompt() {
      document.getElementById('setting-prime-prompt').value = '';
      var settings = loadWrapSettings();
      settings.primePrompt = '';
      settings.capturedAt = null;
      localStorage.setItem(_wrapKey, JSON.stringify(settings));
    }

    // Restore wrap settings
    (function() {
      var settings = loadWrapSettings();
      if (settings.wrapCommand) {
        document.getElementById('setting-wrap-cmd').value = settings.wrapCommand;
      }
      if (settings.primePrompt) {
        document.getElementById('setting-prime-prompt').value = settings.primePrompt;
      }
    })();

    function confirmWrap() {
      var settings = loadWrapSettings();
      var cmd = settings.wrapCommand || document.getElementById('setting-wrap-cmd').value.trim();
      if (!cmd) {
        openSettings();
        document.getElementById('setting-wrap-cmd').focus();
        return;
      }
      document.getElementById('wrap-modal').classList.add('open');
    }

    function closeWrapModal() {
      document.getElementById('wrap-modal').classList.remove('open');
    }

    async function executeWrap() {
      closeWrapModal();
      var settings = loadWrapSettings();
      var wrapCmd = settings.wrapCommand || '/session-wrap';
      var sessionName = _chimeSessionName;
      var btn = document.getElementById('btn-wrap');
      btn.classList.add('wrapping');
      btn.textContent = 'Wrapping\u2026';
      btn.disabled = true;

      // Send the wrap command
      try {
        var res = await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: wrapCmd }),
        });
        if (!res.ok) throw new Error('Send failed');
      } catch {
        btn.classList.remove('wrapping');
        btn.textContent = 'Wrap';
        btn.disabled = false;
        alert('Failed to send wrap command');
        return;
      }

      // Poll peek for busy→stable transition
      var lastPeek = null;
      var changeCount = 0;
      var stableCount = 0;
      var wasBusy = false;
      var pollCount = 0;
      var maxPolls = 120;

      var wrapPoll = setInterval(async function() {
        pollCount++;
        if (pollCount > maxPolls) {
          clearInterval(wrapPoll);
          btn.classList.remove('wrapping');
          btn.textContent = 'Wrap';
          btn.disabled = false;
          alert('Wrap timed out. Check the session manually.');
          return;
        }

        try {
          var peekRes = await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/peek?lines=50');
          var peekData = await peekRes.json();
          var text = peekData.lines || '';

          if (lastPeek === null) {
            lastPeek = text;
            return;
          }

          if (text !== lastPeek) {
            changeCount++;
            stableCount = 0;
            if (changeCount >= 3) wasBusy = true;
          } else {
            stableCount++;
            changeCount = 0;
            if (wasBusy && stableCount >= 2) {
              clearInterval(wrapPoll);

              // Capture final peek as prime prompt
              var finalRes = await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/peek?lines=50');
              var finalData = await finalRes.json();
              var capturedPrompt = (finalData.lines || '').slice(-3500);

              settings.primePrompt = capturedPrompt;
              settings.capturedAt = Date.now();
              localStorage.setItem(_wrapKey, JSON.stringify(settings));
              document.getElementById('setting-prime-prompt').value = capturedPrompt;

              // Kill the session
              try {
                await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/kill', { method: 'POST' });
              } catch {}
              window.location.href = '/';
            }
          }
          lastPeek = text;
        } catch {}
      }, 5000);
    }

    // Prime prompt injection on launch
    (function() {
      var settings = loadWrapSettings();
      if (!settings.primePrompt) return;

      var injectedKey = 'tc_wrap_injected_' + projectName;
      if (sessionStorage.getItem(injectedKey)) return;

      setTimeout(async function() {
        var sessionName = projectName === '__root__' ? 'Projects' : projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
        try {
          await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: settings.primePrompt }),
          });
          sessionStorage.setItem(injectedKey, '1');
        } catch {}
      }, 5000);
    })();

    async function loadUploadHistory() {
      try {
        const res = await fetch('/api/uploads?project=' + encodeURIComponent(projectName));
        if (!res.ok) return;
        const files = await res.json();
        const container = document.getElementById('upload-history');
        const list = document.getElementById('upload-history-list');
        if (files.length === 0) { container.style.display = 'none'; return; }
        list.innerHTML = files.slice(0, 8).map(f =>
          '<div class="upload-history-item">' + f.path + '</div>'
        ).join('');
        container.style.display = 'block';
      } catch {}
    }
  </script>
</body>
</html>`;
}

module.exports = { renderPage };
