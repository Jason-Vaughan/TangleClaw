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
  const displayVersion = projectVersion || TC_VERSION;
  const versionLabel = projectVersion ? `v${projectVersion}` : `tc v${TC_VERSION}`;
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

    .banner-logo {
      width: 28px;
      height: 28px;
      object-fit: contain;
      flex-shrink: 0;
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
  </style>
</head>
<body>
  <div class="banner">
    <div class="banner-left">
      <a href="/" class="banner-home" title="Back to projects">&#9664;</a>
      <img src="/logo-icon.png" alt="" class="banner-logo">
      <span class="banner-sep">|</span>
      <span class="banner-project">${displayName}</span>
      <span style="font-size:9px;color:#555;margin-left:8px;">${versionLabel}</span>
    </div>
    <div class="banner-right">
      <div class="status-dot" id="status-dot" title="Session status"></div>
      <button class="banner-btn" id="btn-select" onclick="toggleSelect()" title="Enable text selection for copy">Select</button>
      <button class="banner-btn" id="btn-upload" onclick="openUpload()" title="Upload file to this project">Upload</button>
      <button class="banner-btn" id="btn-peek" onclick="peekSession()" title="Peek at terminal output">Peek</button>
      <button class="banner-btn danger" id="btn-kill" onclick="confirmKillSession()" title="Kill this session">Kill</button>
    </div>
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
