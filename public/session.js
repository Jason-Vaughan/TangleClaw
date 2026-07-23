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
  masterOpen: false,
  masterEnsuring: false,
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
  // #579 — whether mouseOn is a session-level override (vs inherited from
  // the global). Select-mode exit restores inherited state by UNSETTING.
  mouseExplicit: false,
  launchGraceRemaining: 0,
  wrapCompleting: false,
  wrapDrawerOpen: false,
  // MED-2K9P Chunk 02 — Medusa session-comms control state. `unread` mirrors the
  // server badge; `prevUnread` lets a poll detect a fresh inbound (unread rose)
  // to fire the transient inbound-head flow + aria-live announcement. `shown`
  // gates first-render so the control appears once the session is known.
  // v2 T4: `loops` carries the session's known loops with live Bridge state
  // (from the status poll); `loopsError` is the honest reason when the loop
  // fetch failed (never a silently-empty list).
  medusa: { state: 'off', unread: 0, prevUnread: 0, workspaceId: null, lastError: null, shown: false, loops: [], loopsError: null }
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
// Bound from the shared factory in /api-helper.js (loaded before this file).
// `setConnected` is a function declaration below and is hoisted, so the
// factory captures the live reference. See PR for #82 for rationale.

const api = window.tcCreateApi({ setConnected });
const apiMutate = window.tcCreateApiMutate(api);

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
 * Build <option> HTML for an engine dropdown.
 * OpenClaw entries no longer appear here (#459) — connection-backed harnesses
 * are reached via the top-bar OpenClaw panel, not assigned as a project's LLM.
 * A project bound to an engine the server no longer lists (hidden or retired)
 * still renders its current selection so the settings modal never shows a
 * silently-wrong choice.
 * @param {object[]} engineList - Engines from sessionState.engines
 * @param {string} selectedId - Currently selected engine ID
 * @returns {string} HTML string
 */
function buildEngineOptions(engineList, selectedId) {
  let html = engineList.map(e =>
    `<option value="${esc(e.id)}" ${e.id === selectedId ? 'selected' : ''}>${esc(e.name)}${e.available === false ? ' (not installed)' : ''}</option>`
  ).join('');

  if (selectedId && !engineList.some(e => e.id === selectedId)) {
    html += `<option value="${esc(selectedId)}" selected>${esc(selectedId)} (unavailable)</option>`;
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

  document.title = `TangleClaw \u2014 ${data.name}`;

  // Render group pills in banner
  renderBannerGroups(data.groups || []);

  // #139 Chunk 11b \u2014 project action buttons (e.g. "Run Critic"). The
  // server sends only the actions this project's governance state supports,
  // so an empty list renders nothing.
  renderProjectActions(data.actions || []);
}

/**
 * Render the project's action buttons in the banner.
 * The server gates availability on the project's governance state and
 * re-checks it on POST, so we can safely POST whatever the user clicks.
 * @param {Array<{label: string, command: string, confirm: boolean}>} actions
 */
function renderProjectActions(actions) {
  const container = document.getElementById('projectActions');
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(actions) || actions.length === 0) return;

  for (const action of actions) {
    if (!action || typeof action.label !== 'string' || typeof action.command !== 'string') continue;
    const btn = document.createElement('button');
    btn.className = 'banner-btn project-action-btn';
    btn.textContent = action.label;
    btn.setAttribute('data-command', action.command);
    btn.setAttribute('aria-label', `${action.label} (project action)`);
    btn.addEventListener('click', () => invokeProjectAction(action));
    container.appendChild(btn);
  }
}

/**
 * Invoke a project action via the server. Shows a brief feedback
 * toast in the banner status area on success/failure.
 *
 * Per-action wording overrides (#230): an action declaration may
 * supply `confirmMessage` and `successToast` strings. When present
 * they replace the generic
 * `Run "<label>" for this project?` / `<label>: recorded` defaults.
 * The Critic-style "this button records, doesn't run" contract is
 * misread by operators when the generic wording stands alone, so an
 * action declares wording that clarifies the contract at the surface.
 *
 * @param {{label: string, command: string, confirm: boolean, confirmMessage?: string, successToast?: string}} action
 */
async function invokeProjectAction(action) {
  if (action.confirm) {
    const confirmMessage = (typeof action.confirmMessage === 'string' && action.confirmMessage.length > 0)
      ? action.confirmMessage
      : `Run "${action.label}" for this project?`;
    const yes = window.confirm(confirmMessage);
    if (!yes) return;
  }
  // `CSS.escape` defends against command strings containing
  // selector-syntax characters. Every registered action uses `[a-z-]+`
  // only, so this is belt-and-suspenders.
  const selectorCommand = (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS.escape(action.command)
    : action.command.replace(/["\\]/g, '\\$&');
  const btn = document.querySelector(`.project-action-btn[data-command="${selectorCommand}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = `${action.label}\u2026`;
  }
  // #267 (Critic finding on PR #269): action POSTs can be
  // long-running on the server side — invoke-critic's real-invocation
  // path can run up to 5 minutes while the Critic skill executes. The
  // shared `apiMutate` helper doesn't expose `signal`, so for this
  // single call we use raw `fetch` with an AbortController bounded to
  // ACTION_TIMEOUT_MS (matches the server-side MAX_WAIT_MS). On VPN /
  // flaky-connection scenarios, this prevents an indefinitely hung
  // POST from wedging the UI; the operator sees a clear "timed out"
  // error instead of a spinner-of-doom. Other callers continue to use
  // `apiMutate` for its uniform `api.lastError` plumbing.
  const ACTION_TIMEOUT_MS = 5 * 60 * 1000 + 30 * 1000; // server cap + 30s buffer
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), ACTION_TIMEOUT_MS);
  try {
    let result;
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectName)}/actions/${encodeURIComponent(action.command)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          signal: abortController.signal
        }
      );
      result = await response.json();
    } catch (err) {
      // `AbortError` is the AbortController firing; surface a clear
      // timeout message rather than the generic "fetch failed."
      if (err && err.name === 'AbortError') {
        showBannerActionToast(`${action.label}: timed out after ${Math.round(ACTION_TIMEOUT_MS / 1000)}s`, true);
        return;
      }
      showBannerActionToast(`${action.label}: ${err && err.message ? err.message : 'request failed'}`, true);
      return;
    } finally {
      clearTimeout(timeoutId);
    }
    if (result && result.ok) {
      let successToast = (typeof action.successToast === 'string' && action.successToast.length > 0)
        ? action.successToast
        : `${action.label}: recorded`;
      // #230 — `{branchName}` placeholder support. The invoke-critic
      // handler returns `output.entry.branchName` (see
      // `lib/actions/invoke-critic.js`); future actions following
      // the same shape can reuse the substitution. Fallback "this
      // branch" preserves the toast when no branch resolved (detached
      // HEAD, non-git project, handler didn't supply one).
      if (successToast.includes('{branchName}')) {
        const branchName = (result.output && result.output.entry && result.output.entry.branchName) || 'this branch';
        successToast = successToast.replace(/\{branchName\}/g, branchName);
      }
      // #267 — `{findingCount}` placeholder support for actions that
      // return structured findings (e.g. invoke-critic in real-
      // invocation mode). Falls back to "0" when no count was
      // returned, which makes the toast read sensibly in ack-only
      // fallback mode too.
      if (successToast.includes('{findingCount}')) {
        const findingCount = (result.output && typeof result.output.findingCount === 'number')
          ? result.output.findingCount
          : 0;
        successToast = successToast.replace(/\{findingCount\}/g, String(findingCount));
      }
      // #267 — when the handler returned findings (real-invocation
      // mode), surface them in the session UI alongside the toast.
      // Minimal V1 renders a structured list panel; richer per-
      // finding interaction (dismiss/resolve/jump-to-file) is
      // deliberately deferred so this PR stays scoped to "button
      // actually does what it says."
      if (result.output && Array.isArray(result.output.findings) && result.output.findings.length > 0) {
        showBannerActionToast(successToast);
        renderActionFindings(action.label, result.output);
      } else if (result.output && result.output.fallbackReason) {
        // Real invocation attempted but fell back to ack-only — show
        // the reason so the operator understands why no findings
        // appeared (degraded engine, no active session, idle timeout,
        // missing findings file, etc.).
        //
        // Critic finding on PR #269: previously we showed the success
        // toast *and* the fallback panel, which read contradictorily
        // ("Critic completed for X — 0 finding(s)" on top of "ack-only
        // fallback"). On fallback, suppress the success toast — the
        // fallback panel is the authoritative status surface. The
        // toast was authored for the happy path.
        renderActionFallback(action.label, result.output.fallbackReason);
      } else {
        // Neither findings nor fallback — show the toast as the only
        // signal (ack-mode wrap-pipeline-driven dispatch lands here).
        showBannerActionToast(successToast);
      }
    } else {
      // `api.lastError` is a string set by `apiMutate` on !res.ok (see
      // public/api-helper.js). Earlier draft accessed `.message` which
      // is undefined on a string and silently hid the real server error.
      const msg = (result && result.error) || api.lastError || 'failed';
      showBannerActionToast(`${action.label}: ${msg}`, true);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = action.label;
    }
  }
}

/**
 * Brief banner-anchored toast for action feedback. Hides
 * after 3.5s. Uses inline DOM rather than a global toast system to keep
 * the surface area of this chunk small.
 * @param {string} message
 * @param {boolean} [isError]
 */
function showBannerActionToast(message, isError) {
  let toast = document.getElementById('bannerActionToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'bannerActionToast';
    toast.className = 'banner-action-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.toggle('banner-action-toast--error', !!isError);
  toast.classList.add('banner-action-toast--visible');
  clearTimeout(showBannerActionToast._timer);
  showBannerActionToast._timer = setTimeout(() => {
    toast.classList.remove('banner-action-toast--visible');
  }, 3500);
}

/**
 * Render structured findings from a project action (e.g.
 * invoke-critic's real-invocation result) into a panel anchored at
 * the bottom of the viewport. Stays visible until explicitly
 * dismissed — unlike toasts, finding-content must remain readable
 * (per TC #268). Uses inline DOM to keep this PR's surface area small;
 * a richer per-finding interaction layer (dismiss/resolve/jump-to-file)
 * is deferred work.
 *
 * @param {string} actionLabel - e.g. "Run Critic"
 * @param {object} actionOutput - The handler's `output` block; must
 *   include `findings: Array<object>`, may include `mode`, `entry`,
 *   and `criticSummary` (the parsed `.critic-findings.json`).
 */
function renderActionFindings(actionLabel, actionOutput) {
  const existing = document.getElementById('actionFindingsPanel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'actionFindingsPanel';
  panel.className = 'action-findings-panel';

  const header = document.createElement('div');
  header.className = 'action-findings-panel__header';

  const title = document.createElement('strong');
  const findingCount = actionOutput.findings.length;
  const mode = actionOutput.mode || 'actual';
  const inferredMode = actionOutput.criticSummary && actionOutput.criticSummary.mode;
  title.textContent = `${actionLabel} — ${findingCount} finding${findingCount === 1 ? '' : 's'}` +
    (inferredMode ? ` (${inferredMode})` : '') +
    (mode === 'ack' ? ' [ack-only]' : '');
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'action-findings-panel__close';
  closeBtn.setAttribute('aria-label', 'Close findings panel');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => panel.remove());
  header.appendChild(closeBtn);

  panel.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'action-findings-panel__list';
  for (const finding of actionOutput.findings) {
    const li = document.createElement('li');
    li.className = 'action-findings-panel__item';
    const severity = (finding && finding.severity) ? String(finding.severity) : 'note';
    li.setAttribute('data-severity', severity);

    const badge = document.createElement('span');
    badge.className = `action-findings-panel__severity action-findings-panel__severity--${severity.toLowerCase()}`;
    badge.textContent = severity.toUpperCase();
    li.appendChild(badge);

    const msg = document.createElement('span');
    msg.className = 'action-findings-panel__message';
    msg.textContent = (finding && (finding.message || finding.summary || JSON.stringify(finding))) || '(no message)';
    li.appendChild(msg);

    if (finding && finding.recommendation) {
      const rec = document.createElement('div');
      rec.className = 'action-findings-panel__recommendation';
      rec.textContent = `Recommendation: ${finding.recommendation}`;
      li.appendChild(rec);
    }

    if (finding && (finding.file || finding.location)) {
      const loc = document.createElement('div');
      loc.className = 'action-findings-panel__location';
      loc.textContent = `Location: ${finding.file || finding.location}${finding.line ? `:${finding.line}` : ''}`;
      li.appendChild(loc);
    }

    list.appendChild(li);
  }
  panel.appendChild(list);

  document.body.appendChild(panel);
}

/**
 * Render a fallback explanation when a real-invocation action couldn't
 * run end-to-end and fell back to ack-only mode (e.g. degraded engine,
 * idle timeout, missing findings file). Surfaces the reason verbatim
 * to the operator so they understand why no findings appeared without
 * mistaking it for a successful real Critic run.
 *
 * @param {string} actionLabel
 * @param {string} reason - e.g. "degradedEngine:antigravity", "idleTimeout"
 */
function renderActionFallback(actionLabel, reason) {
  const existing = document.getElementById('actionFindingsPanel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'actionFindingsPanel';
  panel.className = 'action-findings-panel action-findings-panel--fallback';

  const header = document.createElement('div');
  header.className = 'action-findings-panel__header';
  const title = document.createElement('strong');
  title.textContent = `${actionLabel} — ack-only fallback`;
  header.appendChild(title);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'action-findings-panel__close';
  closeBtn.setAttribute('aria-label', 'Close fallback panel');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => panel.remove());
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'action-findings-panel__fallback-body';
  const reasonExplain = {
    'degradedEngine': 'The active engine doesn’t support real Critic invocation yet. The button recorded an ack for the wrap pipeline.',
    'noActiveSession': 'No active tmux session was found for this project. Launch a session first, then click again.',
    'tmuxSendFailed': 'Failed to send the /critic command to the tmux session. The session may have died.',
    'idleDetectFailed': 'Idle detection failed during the Critic run. The session may have died or output may have stalled.',
    'idleTimeout': 'The Critic did not finish within the 5-minute timeout. The session may be stuck.',
    'noFindingsFile': '.prawduct/.critic-findings.json did not appear after the Critic finished. The skill may have errored without writing.'
  };
  const shortKey = (reason || '').split(':')[0];
  body.textContent = reasonExplain[shortKey] || `Fallback reason: ${reason || 'unknown'}`;
  panel.appendChild(body);

  document.body.appendChild(panel);
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
 * The install path comes from the server (`repoRoot` on /api/update-status,
 * #183) — never hardcoded, so a renamed/relocated checkout stays correct.
 * @param {object} data - Update status data
 * @returns {string}
 */
function buildUpdatePrompt(data) {
  const repoRoot = data.repoRoot || 'the TangleClaw install directory (ask the operator for the path)';
  return [
    `TangleClaw update available: v${data.currentVersion} → v${data.latestVersion}.`,
    'Please update TangleClaw by running these steps:',
    `1. cd ${repoRoot}`,
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
 * Push a colour theme into the xterm.js instances inside the ttyd iframes —
 * the session terminal and, once attached, the Master drawer. The palette
 * itself lives in the shared api-helper.js (TC_XTERM_THEMES, UI-4C7R).
 * Safe to call at any time — silently no-ops for frames that are not ready.
 * @param {string} theme - Theme key ('dark', 'light', 'high-contrast')
 */
function applyTerminalTheme(theme) {
  for (const id of ['terminalFrame', 'masterDrawerFrame']) {
    const frame = document.getElementById(id);
    if (!frame) continue;
    try {
      const win = frame.contentWindow;
      const term = win && (win.term || win.terminal);
      window.tcApplyTerminalTheme(term, theme);
    } catch (_) { /* cross-origin or not loaded yet — ignore */ }
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
  }
});

// ── Session Status Polling ──

let pollTimer = null;

/**
 * Poll session status and update UI.
 */
// ── Medusa Session-Comms Control (MED-2K9P Chunk 02) ──

/**
 * Sync the banner Medusa control to the current listener status held in
 * sessionState.medusa: status color (via a state class), the unread badge, the
 * error glyph, and the accessible label. Reveals the control on first render.
 * When unread rose since the last poll (a fresh inbound), fires the transient
 * inbound-head flow + an aria-live announcement — the non-color/-motion cue.
 * @returns {void}
 */
function renderMedusaControl() {
  const control = document.getElementById('medusaControl');
  if (!control) return;
  const m = sessionState.medusa;

  if (control.hidden) control.hidden = false;

  // First render seeds prevUnread from the current count so a listener that was
  // already running (or auto-started) with a pre-existing backlog does NOT flash
  // the inbound head + announce "new message" for messages that predate this page
  // view. Only unread that rises *after* the first paint is a fresh arrival.
  if (!m.shown) {
    m.shown = true;
    m.prevUnread = m.unread;
  }

  const STATE_CLASSES = ['is-off', 'is-connecting', 'is-listening', 'is-error'];
  STATE_CLASSES.forEach((c) => control.classList.remove(c));
  control.classList.add(STATE_CLASSES.includes(`is-${m.state}`) ? `is-${m.state}` : 'is-off');

  const heads = document.getElementById('medusaHeads');
  const label = medusaStateLabel(m);
  heads.setAttribute('aria-pressed', m.state !== 'off' ? 'true' : 'false');
  heads.setAttribute('aria-label', label);
  heads.title = medusaHelpText(m);

  const badge = document.getElementById('medusaBadge');
  if (m.unread > 0) {
    badge.textContent = String(m.unread);
    badge.hidden = false;
    badge.setAttribute('aria-label', `Open Medusa inbox (${m.unread} unread)`);
  } else {
    badge.hidden = true;
  }

  // Loop launch (outbound) is only meaningful while the listener is on — you
  // must be registered to be a truthful initiator. Hide it (and any open setup
  // modal) when off so an off session never offers a launch that would fail.
  const loopBtn = document.getElementById('medusaLoop');
  if (loopBtn) {
    const canSend = m.state !== 'off';
    loopBtn.hidden = !canSend;
    if (!canSend) closeMedusaLoopModal();
  }

  renderMedusaLoopsChip(m);

  if (m.unread > m.prevUnread) flowMedusaInbound(m.unread - m.prevUnread);
  m.prevUnread = m.unread;
}

/** @type {string[]} Loop states in which the Bridge still accepts messages/close (mirrors lib/medusa). */
const MEDUSA_LIVE_LOOP_STATES = ['initiated', 'responded', 'continue'];

/**
 * Sync the loop-view chip + the live-loop glow to the session's known loops
 * (MED-2K9P v2 T4). The chip is the ALWAYS-TEXT status cue (round count for a
 * single live loop, a count otherwise) so state is never color-only; the glow
 * on the mark is the ambient counterpart. Hidden when no loops are known. If
 * the loops panel is open, its content re-renders on the same poll so the
 * round count / state it shows is live.
 * @param {{state: string, loops: Array<object>, loopsError: (string|null)}} m - Medusa state.
 * @returns {void}
 */
function renderMedusaLoopsChip(m) {
  const chip = document.getElementById('medusaLoopsChip');
  const control = document.getElementById('medusaControl');
  if (!chip || !control) return;
  const loops = m.loops || [];
  const live = loops.filter((l) => MEDUSA_LIVE_LOOP_STATES.includes(l.state));

  control.classList.toggle('has-live-loop', live.length > 0);

  if (!loops.length && !m.loopsError) {
    chip.hidden = true;
    const panel = document.getElementById('medusaLoopsPanel');
    if (panel && !panel.hidden) closeMedusaLoopsPanel();
    return;
  }
  chip.hidden = false;
  if (m.loopsError) {
    chip.textContent = '⟳ ?';
    chip.setAttribute('aria-label', `Session loops unavailable: ${m.loopsError}`);
  } else if (live.length === 1) {
    const l = live[0];
    const max = l.guards && l.guards.maxRounds ? `/${l.guards.maxRounds}` : '';
    chip.textContent = `⟳ R${l.round}${max}`;
    chip.setAttribute('aria-label', `Open session loops (1 live loop, round ${l.round}${max ? ` of ${l.guards.maxRounds}` : ''})`);
  } else if (live.length > 1) {
    chip.textContent = `⟳ ${live.length}`;
    chip.setAttribute('aria-label', `Open session loops (${live.length} live loops)`);
  } else {
    chip.textContent = `⟳ ${loops.length} ended`;
    chip.setAttribute('aria-label', `Open session loops (${loops.length} ended)`);
  }

  const panel = document.getElementById('medusaLoopsPanel');
  if (panel && !panel.hidden) renderMedusaLoopsPanel();
}

/**
 * Human-readable status text for the control's accessible label + tooltip. This
 * is the never-color-only source of truth for the listener state.
 * @param {{state: string, unread: number, lastError: (string|null)}} m - Medusa state.
 * @returns {string}
 */
function medusaStateLabel(m) {
  const unread = m.unread > 0 ? `, ${m.unread} unread` : '';
  switch (m.state) {
    case 'listening': return `Medusa session comms: on, listening${unread}. Click to disable.`;
    case 'connecting': return `Medusa session comms: connecting${unread}. Click to disable.`;
    // The listener auto-reconnects with backoff while enabled, so "retry" is
    // automatic; a click here DISABLES it (toggle → off). Label the real action.
    case 'error': return `Medusa session comms: error — ${m.lastError || 'cannot reach the bridge'}${unread}. Click to disable.`;
    default: return `Medusa session comms: off${unread}. Click to enable.`;
  }
}

/**
 * Richer hover-tooltip help (the `title`), distinct from the concise aria-label:
 * explains what Medusa *is* and what this session is *doing* in the current
 * state. Desktop-hover affordance; touch / assistive-tech users still get the
 * state from the aria-label (medusaStateLabel).
 * @param {{state: string, unread: number, lastError: (string|null)}} m - Medusa state.
 * @returns {string}
 */
function medusaHelpText(m) {
  const doing = {
    listening: 'On — listening for messages from your other TangleClaw sessions'
      + (m.unread > 0 ? ` (${m.unread} unread — click the badge to read)` : ''),
    connecting: 'Connecting to the message bridge…',
    error: `Enabled but can't reach the bridge — ${m.lastError || 'auto-retrying'}`,
  }[m.state] || 'Off — this session can\'t send or receive session messages';
  const action = m.state === 'off' ? 'connect this session' : 'disconnect';
  return `Medusa: session-to-session comms (the switchboard) — message your other `
    + `TangleClaw sessions from the banner. ${doing}. Click the heads to ${action}.`;
}

/**
 * Fire the transient inbound-head flow animation and announce arrival on the
 * aria-live region, so a received message is perceivable without relying on
 * color or motion (the animation is auto-suppressed under reduced-motion).
 * @param {number} n - Count of new messages this poll.
 * @returns {void}
 */
function flowMedusaInbound(n) {
  const control = document.getElementById('medusaControl');
  if (control) {
    control.classList.remove('flow-in');
    void control.offsetWidth; // reflow so re-adding restarts the animation
    control.classList.add('flow-in');
  }
  const live = document.getElementById('medusaLive');
  if (live) live.textContent = n === 1 ? 'New Medusa message received' : `${n} new Medusa messages received`;
}

/**
 * Fire the transient outbound-head flow animation on a successful send, mirroring
 * flowMedusaInbound: the outbound (right) head lights and the arrival is announced
 * on the aria-live region so the send is perceivable without relying on color or
 * motion (the animation self-suppresses under prefers-reduced-motion).
 * @param {string} label - Human label for the target (name or id).
 * @param {string} status - The honest send status ('received' | 'queued'), or
 *   'invited' for a loop open (TC#552: the Bridge delivers the invite itself
 *   and does not report live-vs-queued, so the announcement claims neither).
 * @returns {void}
 */
function flowMedusaOutbound(label, status) {
  const control = document.getElementById('medusaControl');
  if (control) {
    control.classList.remove('flow-out');
    void control.offsetWidth; // reflow so re-adding restarts the animation
    control.classList.add('flow-out');
  }
  const live = document.getElementById('medusaLive');
  if (live) {
    live.textContent = status === 'queued'
      ? `Message queued for ${label} (offline)`
      : status === 'invited'
        ? `Loop invite sent to ${label}`
        : `Message delivered to ${label}`;
  }
}

/**
 * Poll the Medusa listener status on the existing session-poll cadence (no new
 * timer, per the no-UI-timers rule). Updates sessionState.medusa and re-renders.
 * @returns {Promise<void>}
 */
async function pollMedusa() {
  const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/medusa/status`);
  if (!data) return;
  const m = sessionState.medusa;
  m.state = data.state;
  m.unread = data.unread || 0;
  m.workspaceId = data.workspaceId || null;
  m.lastError = data.lastError || null;
  m.loops = data.loops || [];
  m.loopsError = data.loopsError || null;
  renderMedusaControl();
}

/**
 * Toggle this session's Medusa listener on/off (the heads click). Reflects the
 * returned status immediately; the next poll reconciles.
 * @returns {Promise<void>}
 */
async function toggleMedusa() {
  const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/medusa/toggle`, { method: 'POST' });
  if (!data) return;
  const m = sessionState.medusa;
  m.state = data.state;
  m.unread = data.unread || 0;
  m.workspaceId = data.workspaceId || null;
  m.lastError = data.lastError || null;
  renderMedusaControl();
}

/**
 * Open the inbox read panel (the badge click): fetch received messages, render
 * them, and mark the inbox read (clearing the unread badge). Closes the panel if
 * it is already open (toggle).
 * @returns {Promise<void>}
 */
async function openMedusaInbox() {
  const panel = document.getElementById('medusaPanel');
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }
  hideMedusaPeers();
  closeMedusaLoopModal();

  const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/medusa/messages`);
  const messages = (data && data.messages) || [];
  panel.innerHTML = renderMedusaMessages(messages);
  panel.hidden = false;

  const status = await api(`/api/sessions/${encodeURIComponent(projectName)}/medusa/read`, { method: 'POST' });
  if (status) {
    sessionState.medusa.unread = status.unread || 0;
    renderMedusaControl();
  }
}

/**
 * Build the read-panel markup from the inbox (newest first). All message content
 * is escaped — inbound text is untrusted cross-session data.
 * @param {Array<{from?: string, message?: string}>} messages - Inbox, oldest first.
 * @returns {string} HTML.
 */
function renderMedusaMessages(messages) {
  // Header carries an explicit ✕ close: the badge that opens the panel self-hides
  // on read (unread → 0), so it can't be the only dismiss control (mobile trap).
  const head = '<div class="group-popover-title medusa-panel-head"><span>Medusa inbox</span>'
    + '<button type="button" class="medusa-panel-close" aria-label="Close inbox">✕</button></div>';
  if (!messages.length) {
    return `${head}<div class="medusa-msg-empty">No messages yet.</div>`;
  }
  const rows = messages.slice().reverse().map((msg) => {
    const from = esc(msg.from || 'unknown');
    const body = esc(msg.message || '');
    return `<div class="medusa-msg"><div class="medusa-msg-from">${from}</div><div class="medusa-msg-body">${body}</div></div>`;
  }).join('');
  return `${head}${rows}`;
}

/**
 * Close the inbox read panel (the ✕ button and Escape). Safe to call when already
 * closed. Separate from openMedusaInbox's toggle so the badge — which self-hides on
 * read — is never the only path to dismiss the panel.
 * @returns {void}
 */
function closeMedusaInbox() {
  const panel = document.getElementById('medusaPanel');
  if (panel) panel.hidden = true;
}

/**
 * Show the recent-inbound-peers popover on hover (desktop affordance) listing
 * the distinct senders in the inbox. No-op when empty or the read panel is open.
 * @returns {Promise<void>}
 */
async function showMedusaPeers() {
  const peers = document.getElementById('medusaPeers');
  const panel = document.getElementById('medusaPanel');
  if (!peers || (panel && !panel.hidden)) return;
  const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/medusa/messages`);
  const froms = [...new Set(((data && data.messages) || []).map((msg) => msg.from || 'unknown'))];
  if (!froms.length) return;
  peers.innerHTML = '<div class="group-popover-title">Recent inbound</div>' +
    froms.map((f) => `<div class="group-popover-member">${esc(f)}</div>`).join('');
  peers.hidden = false;
}

/**
 * Hide the peers hover popover.
 * @returns {void}
 */
function hideMedusaPeers() {
  const peers = document.getElementById('medusaPeers');
  if (peers) peers.hidden = true;
}

/**
 * Per-mode wall-clock guard presets for the loop modal (MED-6V3R). The Bridge
 * halts a loop on total elapsed since first delivery — the clock never pauses
 * and never resets per round — so the same knob bounds a different thing in
 * each mode, and one shared preset cannot be honest for both. Kept in sync with
 * `DEFAULT_WALL_SECONDS` in `lib/medusa.js`, which serves API callers that omit
 * the guard; this modal always sends an explicit value.
 * @type {{supervised: {minutes: number, hint: string}, autonomous: {minutes: number, hint: string}}}
 */
const MEDUSA_LOOP_GUARD_PRESETS = {
  supervised: {
    minutes: 480,
    hint: 'Supervised: rounds only advance when you send, so this drops the loop if you never respond — it is not runaway protection. Max rounds is.'
  },
  autonomous: {
    minutes: 10,
    hint: 'Autonomous: agents drive every round unattended, so this bounds their work. The clock starts on first delivery and never pauses.'
  }
};

/**
 * @type {boolean} True once the operator edits Max minutes. A mode switch then
 * leaves their number alone: silently discarding a deliberate value is the same
 * defect the feedback composer was faulted for (VRF-561).
 */
let medusaLoopMinutesDirty = false;

/**
 * Sync the wall-clock guard control to the selected judge mode (MED-6V3R) —
 * the preset and the hint both follow the mode, since the guard is runaway
 * protection when autonomous and an abandonment bound when supervised. An
 * operator-edited value is preserved across the switch.
 * @returns {void}
 */
function syncMedusaLoopGuardMode() {
  const mode = document.getElementById('medusaLoopMode');
  const minutes = document.getElementById('medusaLoopMaxMinutes');
  const hint = document.getElementById('medusaLoopGuardHint');
  const preset = MEDUSA_LOOP_GUARD_PRESETS[mode && mode.value] || MEDUSA_LOOP_GUARD_PRESETS.supervised;
  if (hint) hint.textContent = preset.hint;
  if (minutes && !medusaLoopMinutesDirty) minutes.value = String(preset.minutes);
}

/**
 * Open the loop setup modal (the ➤ button) — MED-2K9P v2 T3, replacing the
 * deprecated manual compose box. Fetches the live roster into the target
 * picker, resets transient state, and focuses the first field. Toggles closed
 * if already open. Closes the read panel / peers popovers first.
 * @returns {Promise<void>}
 */
async function openMedusaLoopModal() {
  const modal = document.getElementById('medusaLoopModal');
  const loopBtn = document.getElementById('medusaLoop');
  if (!modal) return;
  if (modal.classList.contains('open')) { closeMedusaLoopModal(); return; }

  closeMedusaInbox();
  hideMedusaPeers();

  const select = document.getElementById('medusaLoopTarget');
  const status = document.getElementById('medusaLoopRosterStatus');
  const error = document.getElementById('medusaLoopError');
  if (error) { error.hidden = true; error.textContent = ''; }
  if (select) { select.innerHTML = ''; select.disabled = true; }
  if (status) status.textContent = 'Loading sessions…'; // honest loading state, no fake list
  syncMedusaLoopGuardMode(); // the hint must match the mode the modal actually opens on

  modal.classList.add('open');
  if (loopBtn) loopBtn.setAttribute('aria-expanded', 'true');

  const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/medusa/roster`);
  // Honesty: a FAILED roster fetch (api() → null, e.g. Bridge unreachable) is NOT
  // the same as an empty roster. Surface the real error rather than falsely
  // claiming "no other sessions are online" — the honest-status constraint runs
  // both directions (carried over from the compose box this modal replaces).
  if (data === null) {
    if (status) status.textContent = `Couldn't load sessions: ${api.lastError || 'the message bridge is unreachable'} Reopen to retry.`;
    return;
  }
  renderMedusaLoopTargets(data.workspaces || []);
}

/**
 * Populate the loop target picker from the roster. All roster-supplied text
 * (names/ids) is escaped — workspace names are cross-session data. An empty
 * roster renders an honest "no other sessions" state with the picker disabled.
 * @param {Array<{id: string, name?: string, connected?: boolean, listener?: {active?: boolean}}>} workspaces - Roster entries.
 * @returns {void}
 */
function renderMedusaLoopTargets(workspaces) {
  const select = document.getElementById('medusaLoopTarget');
  const status = document.getElementById('medusaLoopRosterStatus');
  if (!select) return;
  if (!workspaces.length) {
    select.innerHTML = '';
    select.disabled = true;
    if (status) status.textContent = 'No other Medusa sessions are online to loop with.';
    return;
  }
  select.innerHTML = workspaces.map((w) => {
    const online = w.connected || (w.listener && w.listener.active);
    const label = esc(w.name || w.id) + (online ? '' : ' (offline)');
    return `<option value="${esc(w.id)}">${label}</option>`;
  }).join('');
  select.disabled = false;
  if (status) status.textContent = 'Offline targets get the task when they reconnect.';
  select.focus();
}

/**
 * Launch the loop (the Launch button): validate the form client-side, POST to
 * the loop endpoint, and surface the HONEST result — the loop id plus whether
 * the task notice was delivered live or queued (offline target) — never a
 * blanket "launched". Failure keeps the modal open with the real error so the
 * operator's form input is not lost.
 * @returns {Promise<void>}
 */
async function launchMedusaLoop() {
  const select = document.getElementById('medusaLoopTarget');
  const task = document.getElementById('medusaLoopTask');
  const done = document.getElementById('medusaLoopDone');
  const mode = document.getElementById('medusaLoopMode');
  const rounds = document.getElementById('medusaLoopMaxRounds');
  const minutes = document.getElementById('medusaLoopMaxMinutes');
  const btn = document.getElementById('medusaLoopLaunchBtn');
  const error = document.getElementById('medusaLoopError');
  if (!select || !task || !done) return;

  /**
   * Show an inline validation/launch error (keeps the modal + input intact).
   * @param {string} msg - Human-readable reason.
   * @returns {void}
   */
  const fail = (msg) => {
    if (error) { error.textContent = msg; error.hidden = false; }
  };
  if (error) { error.hidden = true; error.textContent = ''; }

  const target = select.value;
  const label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].text.replace(/ \(offline\)$/, '') : target;
  if (!target) { fail('Pick a session to loop with.'); return; }
  if (!task.value.trim()) { fail('Describe the task.'); task.focus(); return; }
  if (!done.value.trim()) { fail('State the done criteria you will judge against.'); done.focus(); return; }
  const maxRounds = parseInt(rounds && rounds.value, 10);
  const maxMinutes = parseInt(minutes && minutes.value, 10);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) { fail('Max rounds must be a positive whole number.'); return; }
  if (!Number.isInteger(maxMinutes) || maxMinutes < 1) { fail('Max minutes must be a positive whole number.'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Launching…'; }
  const result = await apiMutate(`/api/sessions/${encodeURIComponent(projectName)}/medusa/loop`, 'POST', {
    target,
    task: task.value.trim(),
    doneCriteria: done.value.trim(),
    mode: mode ? mode.value : 'supervised',
    guards: { maxRounds, maxWallTimeSeconds: maxMinutes * 60 }
  });
  if (btn) { btn.disabled = false; btn.textContent = 'Launch loop'; }

  if (result && result.loop) {
    // Honest outcome (TC#552): the Bridge itself delivers the loopInvite —
    // durably queued, pushed live when the target is online — and its open
    // response does not report live-vs-queued, so neither do we. The toast
    // states exactly what the contract guarantees, no invented "delivered".
    showBannerActionToast(`Loop opened with ${label} — the Bridge delivers the invite (live, or on their reconnect).`, false);
    flowMedusaOutbound(label, 'invited');
    closeMedusaLoopModal();
  } else {
    // api() surfaces the server's error message on api.lastError; never claim launched.
    fail(`Couldn't open loop: ${api.lastError || 'launch failed'}`);
  }
}

/**
 * Close the loop setup modal (Cancel, Escape, launch success, or going off).
 * Safe when already closed. Field values persist until the next open resets
 * the roster; the task/criteria text survives an accidental close.
 * @returns {void}
 */
function closeMedusaLoopModal() {
  const modal = document.getElementById('medusaLoopModal');
  const loopBtn = document.getElementById('medusaLoop');
  if (modal) modal.classList.remove('open');
  if (loopBtn) loopBtn.setAttribute('aria-expanded', 'false');
}

// ── Medusa Loop View (MED-2K9P v2 T4) ──

/** @type {Set<string>} Loop ids whose transcript is expanded in the loops panel. */
const medusaExpandedTranscripts = new Set();

/** @type {Set<string>} Loop ids whose initiator feedback composer is open (TC#561). */
const medusaExpandedFeedback = new Set();

/** @type {Map<string, string>} Loop id → in-progress feedback draft, preserved
 * across poll re-renders so typed text is never lost (TC#561). Cleared on send
 * or when the composer is closed. The Map is the source of truth for draft
 * text; the DOM textarea is seeded from it. */
const medusaFeedbackDrafts = new Map();

/**
 * Open the loops panel (the ⟳ chip click) — the banner's live view of every
 * loop this session knows about. Toggles closed if already open. Content
 * renders from the state the status poll already carries (no extra fetch;
 * each poll re-renders it live while open).
 * @returns {Promise<void>}
 */
async function openMedusaLoopsPanel() {
  const panel = document.getElementById('medusaLoopsPanel');
  if (!panel) return;
  if (!panel.hidden) { closeMedusaLoopsPanel(); return; }
  closeMedusaInbox();
  hideMedusaPeers();
  closeMedusaLoopModal();
  panel.hidden = false;
  const chip = document.getElementById('medusaLoopsChip');
  if (chip) chip.setAttribute('aria-expanded', 'true');
  await renderMedusaLoopsPanel();
}

/**
 * Close the loops panel (✕, Escape, outside click, or the chip vanishing).
 * Safe when already closed. Transcript expansion state is kept so reopening
 * restores the operator's view.
 * @returns {void}
 */
function closeMedusaLoopsPanel() {
  const panel = document.getElementById('medusaLoopsPanel');
  if (panel) panel.hidden = true;
  const chip = document.getElementById('medusaLoopsChip');
  if (chip) chip.setAttribute('aria-expanded', 'false');
}

/**
 * Human-readable outcome label for a loop, honest to the Bridge's semantics:
 * `halted` is ONLY ever the server's runaway guards (round/wall-clock);
 * force-done lands as `complete` with `closeSignal.reason: 'force-done'` (the
 * Bridge has no external halt transition), so the label comes from the
 * structured closeSignal, never from guesswork.
 * @param {{state: string, closeSignal?: (object|null)}} loop - Bridge loop object.
 * @returns {string}
 */
function medusaLoopStateLabel(loop) {
  if (loop.state === 'halted') return 'halted by guard';
  if (loop.state === 'complete') {
    const reason = loop.closeSignal && loop.closeSignal.reason;
    if (reason === 'force-done') return 'ended by force-done';
    if (reason === 'satisfied') return 'ended — marked done';
    return 'complete';
  }
  return loop.state; // initiated | responded | continue — live protocol states.
}

/**
 * Render the loops panel: one row per known loop — who with, mode, role, the
 * live state + round count, force-done (initiator side, live states only),
 * and an expandable transcript. The transcript is labeled for what it honestly
 * is: the rounds THIS session observed (its inbound loop messages plus the
 * opening task) — the Bridge retains no full round history to fetch. All
 * Bridge-supplied text (tasks, ids, reasons, message bodies) is escaped:
 * cross-session data is untrusted.
 * @returns {Promise<void>}
 */
async function renderMedusaLoopsPanel() {
  const panel = document.getElementById('medusaLoopsPanel');
  if (!panel) return;
  // Don't let the status-poll re-render fight the operator's typing (TC#561):
  // while a feedback textarea is FOCUSED, keep the current DOM this tick (a
  // re-render would move the caret / drop focus). Key on `document.activeElement`
  // (the composer actually focused — multi-composer safe, not a first-match
  // query) scoped to this panel. Draft text itself is never lost regardless of
  // focus — it lives in `medusaFeedbackDrafts` and re-seeds the textarea on
  // every render — so a blurred composer re-renders freely and a successful
  // send (which clears the draft + focus) always refreshes. The guard keys on
  // focus, NOT residual DOM value, so it can never deadlock.
  const active = document.activeElement;
  if (active && active.closest && active.closest('.medusa-loop-feedback-input') && panel.contains(active)) {
    return;
  }
  const m = sessionState.medusa;
  const loops = m.loops || [];

  const head = '<div class="group-popover-title medusa-panel-head"><span>Session loops</span>'
    + '<button type="button" class="medusa-panel-close" aria-label="Close session loops">✕</button></div>';

  if (m.loopsError) {
    panel.innerHTML = `${head}<div class="medusa-msg-empty">Loops unavailable: ${esc(m.loopsError)}</div>`;
    return;
  }
  if (!loops.length) {
    panel.innerHTML = `${head}<div class="medusa-msg-empty">No loops yet.</div>`;
    return;
  }

  // One inbox fetch serves every expanded transcript (local in-memory read).
  let inbox = null;
  if (medusaExpandedTranscripts.size > 0) {
    const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/medusa/messages`);
    inbox = (data && data.messages) || [];
  }

  const rows = loops.map((loop) => {
    const live = MEDUSA_LIVE_LOOP_STATES.includes(loop.state);
    const other = loop.role === 'initiator' ? loop.target : loop.initiator;
    const maxRounds = loop.guards && loop.guards.maxRounds;
    const round = `round ${loop.round}${maxRounds ? `/${maxRounds}` : ''}`;
    const stateLabel = medusaLoopStateLabel(loop);
    const expanded = medusaExpandedTranscripts.has(loop.id);

    // The initiator judges only when the target has responded (design §1). The
    // Bridge accepts a feedback round / posts only in `responded` state, so the
    // FEEDBACK + satisfied-CLOSEOUT affordances gate on it (TC#561); force-done
    // (the kill-switch) stays available for any live loop this session owns.
    const canJudge = loop.role === 'initiator' && loop.state === 'responded';
    const feedbackOpen = medusaExpandedFeedback.has(loop.id);
    let actions = '';
    if (live && loop.role === 'initiator') {
      if (canJudge) {
        actions += `<button type="button" class="medusa-loop-continue" data-loop-id="${esc(loop.id)}" aria-expanded="${feedbackOpen ? 'true' : 'false'}">Send feedback</button>`;
        actions += `<button type="button" class="medusa-loop-closeout" data-loop-id="${esc(loop.id)}">Mark done</button>`;
      }
      actions += `<button type="button" class="medusa-force-done" data-loop-id="${esc(loop.id)}">Force-done</button>`;
    } else if (loop.state === 'halted') {
      // Guard semantics surfaced: a halted loop cannot be closed (Bridge 400).
      actions += '<span class="medusa-loop-note">guard-halted — cannot be closed</span>';
    }
    actions += `<button type="button" class="medusa-loop-transcript-toggle" data-loop-id="${esc(loop.id)}" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? 'Hide' : 'Transcript'}</button>`;

    // Inline feedback composer (the FEEDBACK half of the control spine). Labeled
    // textarea + Send; the message is sent over HTTP as data, never a keystroke.
    let feedback = '';
    if (canJudge && feedbackOpen) {
      const fid = `medusaFeedback-${esc(loop.id)}`;
      const draft = medusaFeedbackDrafts.get(loop.id) || '';
      feedback = '<div class="medusa-loop-feedback">'
        + `<label class="medusa-loop-feedback-label" for="${fid}">Feedback to continue this loop</label>`
        + `<textarea id="${fid}" class="medusa-loop-feedback-input" data-loop-id="${esc(loop.id)}" rows="2" placeholder="What should ${esc(other)} do next?">${esc(draft)}</textarea>`
        + `<button type="button" class="medusa-loop-feedback-send" data-loop-id="${esc(loop.id)}">Send</button>`
        + '</div>';
    }

    let transcript = '';
    if (expanded) {
      const observed = (inbox || []).filter((msg) => msg.loopId === loop.id);
      const entries = [
        `<div class="medusa-msg"><div class="medusa-msg-from">task → ${esc(loop.target)}</div><div class="medusa-msg-body">${esc(loop.task || '')}</div></div>`
      ].concat(observed.map((msg) => `<div class="medusa-msg"><div class="medusa-msg-from">${esc(msg.from || 'unknown')}</div><div class="medusa-msg-body">${esc(msg.message || '')}</div></div>`));
      transcript = `<div class="medusa-loop-transcript">`
        + `<div class="medusa-loop-transcript-note">As observed by this session (the Bridge keeps no full history)${observed.length ? '' : ' — no rounds observed here yet'}</div>`
        + entries.join('')
        + '</div>';
    }

    return `<div class="medusa-loop-row is-${esc(loop.state)}">`
      + `<div class="medusa-loop-who">${loop.role === 'initiator' ? '→' : '←'} ${esc(other)}</div>`
      + `<div class="medusa-loop-meta">${esc(loop.mode || 'supervised')} · ${esc(stateLabel)} · ${esc(round)}</div>`
      + `<div class="medusa-loop-actions">${actions}</div>`
      + feedback
      + transcript
      + '</div>';
  }).join('');

  panel.innerHTML = `${head}${rows}`;
}

/**
 * Force-done a loop (the kill-switch): confirm, POST, and surface the HONEST
 * outcome — the Bridge records `complete` with a structured force-done
 * closeSignal (only its own guards produce `halted`). A rejection (guard-halted
 * loop, Bridge down) surfaces verbatim — the loop view never pretends a loop
 * ended. State refresh rides the next poll; the local copy updates immediately
 * so the panel doesn't lag the action.
 * @param {string} loopId - The loop to end.
 * @returns {Promise<void>}
 */
async function forceDoneMedusaLoop(loopId) {
  const yes = window.confirm('End this loop now? The other session gets a close notice; this cannot be undone.');
  if (!yes) return;
  const result = await apiMutate(
    `/api/sessions/${encodeURIComponent(projectName)}/medusa/loops/${encodeURIComponent(loopId)}/force-done`,
    'POST',
    {}
  );
  if (result && result.loopState) {
    const loop = (sessionState.medusa.loops || []).find((l) => l.id === loopId);
    if (loop) {
      loop.state = result.loopState;
      loop.closeSignal = result.closeSignal || loop.closeSignal;
    }
    showBannerActionToast('Loop ended (force-done).', false);
    const live = document.getElementById('medusaLive');
    if (live) live.textContent = 'Loop ended by force-done';
    renderMedusaControl();
  } else {
    showBannerActionToast(`Couldn't end loop: ${api.lastError || 'the bridge rejected it'}`, true);
  }
}

/**
 * Send an initiator FEEDBACK round to continue a supervised loop (TC#561, the
 * FEEDBACK half of the control spine). Validates non-empty text client-side,
 * POSTs the round, and on success closes the composer and optimistically
 * advances the local loop (`responded → continue`, round from the Bridge) so
 * the panel doesn't lag the poll. A rejection surfaces verbatim — never a false
 * "sent".
 * @param {string} loopId - The loop to continue.
 * @param {string} message - The initiator's feedback text for this round.
 * @returns {Promise<void>}
 */
async function continueMedusaLoop(loopId, message) {
  const text = (message || '').trim();
  if (!text) { showBannerActionToast('Enter feedback before sending.', true); return; }
  const result = await apiMutate(
    `/api/sessions/${encodeURIComponent(projectName)}/medusa/loops/${encodeURIComponent(loopId)}/continue`,
    'POST',
    { message: text }
  );
  if (result && result.loopState) {
    const loop = (sessionState.medusa.loops || []).find((l) => l.id === loopId);
    if (loop) {
      loop.state = result.loopState;
      if (typeof result.round === 'number') loop.round = result.round;
    }
    medusaExpandedFeedback.delete(loopId);
    medusaFeedbackDrafts.delete(loopId);
    if (result.loopState === 'halted') {
      // The feedback landed but pushed the round to maxRounds — the Bridge
      // auto-halted the loop. Say so honestly; it did NOT continue.
      showBannerActionToast('Feedback sent — loop hit its round cap and halted.', false);
    } else {
      showBannerActionToast(result.delivered ? 'Feedback sent — loop continued.' : 'Feedback queued — loop continued.', false);
    }
    renderMedusaControl();
  } else {
    showBannerActionToast(`Couldn't send feedback: ${api.lastError || 'the bridge rejected it'}`, true);
  }
}

/**
 * Satisfied closeout (TC#561, the CLOSEOUT half of the control spine) — end a
 * loop as *done*, distinct from the force-done kill-switch. Confirms, POSTs the
 * satisfied close, and labels the outcome "marked done" (not "force-done") so
 * the operator's judgment is never mislabeled.
 * @param {string} loopId - The loop to close as satisfied.
 * @returns {Promise<void>}
 */
async function closeoutMedusaLoop(loopId) {
  const yes = window.confirm('Mark this loop done? The other session gets a close notice; this cannot be undone.');
  if (!yes) return;
  const result = await apiMutate(
    `/api/sessions/${encodeURIComponent(projectName)}/medusa/loops/${encodeURIComponent(loopId)}/closeout`,
    'POST',
    {}
  );
  if (result && result.loopState) {
    const loop = (sessionState.medusa.loops || []).find((l) => l.id === loopId);
    if (loop) {
      loop.state = result.loopState;
      loop.closeSignal = result.closeSignal || loop.closeSignal;
    }
    medusaExpandedFeedback.delete(loopId);
    medusaFeedbackDrafts.delete(loopId);
    showBannerActionToast('Loop ended — marked done.', false);
    const live = document.getElementById('medusaLive');
    if (live) live.textContent = 'Loop ended — marked done';
    renderMedusaControl();
  } else {
    showBannerActionToast(`Couldn't close loop: ${api.lastError || 'the bridge rejected it'}`, true);
  }
}

async function pollStatus() {
  const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/status`);
  if (!data) return;

  sessionState.session = data;

  // CC-7 Slice C — typed-wrap trigger parity. The server's wrap-sentinel monitor
  // saw the AI emit `TANGLECLAW_WRAP` (the user typed "wrap"), so open the same
  // wrap drawer the Wrap button opens. Ack the server flag first so a slow open
  // or a dropped poll can't reopen it, and latch client-side so we open at most
  // once per page load even if the ack races the next poll. No auto-kill — the
  // drawer is the operator's review/confirm surface.
  if (data.wrapRequested && !sessionState.wrapSentinelHandled
      && !sessionState.wrapDrawerOpen && !sessionState.wrapping && !sessionState.ended) {
    sessionState.wrapSentinelHandled = true;
    api(`/api/sessions/${encodeURIComponent(projectName)}/wrap-sentinel/ack`, { method: 'POST' });
    openWrapModal();
  }

  // Handle wrapping state
  if (data.wrapping && !sessionState.wrapping) {
    showWrappingState();
  }

  // Handle wrap completed (tmux died during wrapping)
  if (data.wrapCompleted && !sessionState.ended) {
    handleWrapCompleted(data);
    return;
  }

  // Handle wrap finished but tmux still alive (idle during wrapping).
  // Show the wrap-idle modal — does NOT auto-finalize. User must click
  // "Return to Projects" (kills tmux), "Resume working", or click the
  // backdrop (both dismiss). The modal is sticky once shown — it does NOT
  // auto-hide on subsequent idle flip-flops, because incidental ttyd redraw
  // events (mouse hover into iframe, laptop reattach) can cause data.idle
  // to briefly flip to false. See #98.
  if (data.wrapping && data.idle && !sessionState.ended) {
    sessionState.wrapIdleCount = (sessionState.wrapIdleCount || 0) + 1;
    // 8 polls (~16s at 2s interval) — survives brief git push / Critic pauses
    if (sessionState.wrapIdleCount >= 8 && !sessionState.wrapIdleModalShown) {
      showWrapIdleModal();
    }
  } else if (data.wrapping) {
    // AI active again: only reset the pre-modal counter. Once the modal is
    // shown, it stays put until the user explicitly chooses an action.
    if (!sessionState.wrapIdleModalShown) {
      sessionState.wrapIdleCount = 0;
    }
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

  // MED-2K9P Chunk 02 — refresh the Medusa control on the same cadence (no new
  // timer). Skipped once the session has ended.
  if (!sessionState.ended) await pollMedusa();
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

  // Defensively hide wrap-idle modal — if tmux died while it was showing,
  // the wrap-completed code path normally handles this, but cover the case
  // where we land here directly.
  document.getElementById('sessionWrapIdle').classList.remove('open');
  sessionState.wrapIdleModalShown = false;

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

  // Countdown redirect — suppressed while the wrap drawer is open, so a
  // blocked-wrap report the operator is still reading is never navigated
  // away by the auto-redirect (#268). The operator dismisses the drawer
  // themselves; the ended bar then carries the manual "Back to Projects".
  const countdownEl = document.getElementById('countdown');
  const H = window.tcWrapDrawerHelpers;
  const allowCountdown = !H || H.shouldStartEndedCountdown({ wrapDrawerOpen: sessionState.wrapDrawerOpen });
  if (!allowCountdown) {
    countdownEl.textContent = '';
    return;
  }
  let remaining = 10;
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

// ── Project Master Drawer (chunk G slice 3, #331) ──
// The global read-only assistant, reachable without leaving the session.
// Same ensure-then-attach contract as the landing pane (ui.js): opening the
// drawer POSTs /api/master/ensure (idempotent) and only attaches the ttyd
// iframe once ensure succeeds, because ttyd attaches to EXISTING sessions
// only. No polling (no-UI-timers rule) — status repaints on open/ensure.

/**
 * Paint the Master drawer status dot and text.
 * @param {string} status - 'live' | 'pending' | 'down' | '' (unknown/neutral)
 * @param {string} [text] - Status line shown in the drawer's status row
 * @param {boolean} [showRetry] - Reveal the drawer's Retry button
 */
function setMasterDrawerStatus(status, text, showRetry) {
  const dot = document.getElementById('masterDrawerDot');
  dot.classList.remove('live', 'pending', 'down');
  if (status) dot.classList.add(status);
  if (text !== undefined) document.getElementById('masterDrawerStatusText').textContent = text;
  document.getElementById('masterDrawerRetryBtn').classList.toggle('hidden', !showRetry);
}

/**
 * Open the Master drawer and run the ensure-then-attach flow.
 */
function openMasterDrawer() {
  sessionState.masterOpen = true;
  document.getElementById('masterBackdrop').classList.add('open');
  document.getElementById('masterDrawer').classList.add('open');
  document.getElementById('masterBtn').setAttribute('aria-expanded', 'true');
  ensureMasterDrawerAttached();
}

/**
 * Close the Master drawer. The master session persists (launch on first
 * open, then persist) — closing only hides the surface.
 */
function closeMasterDrawer() {
  sessionState.masterOpen = false;
  document.getElementById('masterBackdrop').classList.remove('open');
  document.getElementById('masterDrawer').classList.remove('open');
  document.getElementById('masterBtn').setAttribute('aria-expanded', 'false');
}

/**
 * Ensure the master session exists, then attach the terminal iframe.
 * Re-entrant-guarded; safe to re-run on every drawer open — ensure is an
 * idempotent server-side no-op when the session is already live (it still
 * refreshes the master's CLAUDE.md identity), and the iframe attaches once.
 */
async function ensureMasterDrawerAttached() {
  if (sessionState.masterEnsuring) return;
  sessionState.masterEnsuring = true;
  setMasterDrawerStatus('pending', 'Starting master session…');
  const result = await api('/api/master/ensure', { method: 'POST' });
  sessionState.masterEnsuring = false;
  if (!result) {
    setMasterDrawerStatus('down', api.lastError || 'Failed to start the master session', true);
    return;
  }
  setMasterDrawerStatus('live', result.created ? 'Master session started' : 'Master session live');
  attachMasterDrawerFrame();
}

/**
 * Point the drawer iframe at the ttyd attach URL (once per page load). The
 * shared readiness-retry pipeline (api-helper.js tcWireTerminalFrame) pushes
 * the operator theme + the ⌥+drag local-selection override (#431) + the
 * mobile touch-scroll shim (#443) + plain-drag/long-press copy (#445) into
 * its xterm instance — the same enhancements every terminal surface gets.
 */
function attachMasterDrawerFrame() {
  const frame = document.getElementById('masterDrawerFrame');
  if (frame.dataset.attached === 'true') return;
  frame.dataset.attached = 'true';
  window.tcWireTerminalFrame(window, frame,
    () => (sessionState.config && sessionState.config.theme) || 'dark');
  frame.src = '/terminal/?arg=tangleclaw-master';
}

// ── Terminal Setup ──

/**
 * Set up the terminal iframe. For webui sessions uses iframeUrl (OpenClaw UI),
 * otherwise loads the ttyd terminal proxy.
 * @param {string} [iframeUrl] - OpenClaw iframe URL for webui sessions
 */
function setupTerminal(iframeUrl) {
  const frame = document.getElementById('terminalFrame');
  // Shared readiness-retry pipeline (api-helper.js): theme + the #431 ⌥+drag
  // local-selection override + the #443 touch-scroll shim + #445 drag-copy.
  window.tcWireTerminalFrame(window, frame,
    () => (sessionState.config && sessionState.config.theme) || 'dark');
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

// ── Command Bar ──
// (The old touch-only "mouse guard" — a 3s poll forcing tmux mouse OFF —
// was removed in #574. It existed to hold mouse off for the pre-#445 native
// mobile selection, which long-press select superseded, and with mouse OFF
// the #443 touch-scroll shim cannot work: the guard and the shim were
// mutually exclusive designs.)

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

  // Apply mouse toggle — an operator's deliberate Settings choice IS a
  // session-explicit override (#579), unlike select mode's transient flips.
  const newMouse = document.getElementById('mouseToggle').checked;
  if (newMouse !== sessionState.mouseOn) {
    sessionState.mouseOn = newMouse;
    sessionState.mouseExplicit = true;
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

let selectModeActive = false;

/**
 * localStorage key for this project's select-mode intent marker (UI-8W3D).
 * @returns {string}
 */
function selectMarkerKey() {
  return `tcSelectPending:${projectName}`;
}

/**
 * Persist the pre-select mouse state BEFORE flipping tmux (UI-8W3D). If the
 * page dies mid-select (reload, close, crash) the exit restore never runs;
 * this marker is how the next visit knows a restore is owed and what to
 * restore. Written before the enter POST on purpose: a crash between write
 * and POST leaves only a harmless idempotent repair, while the opposite
 * order leaves a strand with no marker.
 * @param {{on: boolean, explicit: boolean}} state - The pre-select state
 */
function writeSelectMarker(state) {
  try {
    localStorage.setItem(selectMarkerKey(),
      JSON.stringify({ on: state.on, explicit: state.explicit }));
  } catch (_) { /* storage unavailable — abandonment repair degrades, select still works */ }
}

/** Remove the select-mode intent marker (clean exit, or repair done). */
function clearSelectMarker() {
  try {
    localStorage.removeItem(selectMarkerKey());
  } catch (_) { /* storage unavailable */ }
}

/**
 * Repair a mouse override stranded by an interrupted Select (UI-8W3D).
 * A marker present at page load means the previous visit entered select
 * mode and never exited — replay the exit restore from the marker's
 * recorded pre-select state (unset when it was inherited, per #579) and
 * clear the marker. Localstorage is the source of truth, cleared on the
 * mutation (the #566/TC#561 SoT rule); no timers. Known accepted edge:
 * a second tab reloading while the first is legitimately mid-select
 * repairs under it — rare, and strictly better than stranding forever.
 * @returns {Promise<boolean>} true when a repair POST was issued
 */
async function repairAbandonedSelect() {
  let marker = null;
  try {
    marker = tcParseSelectMarker(localStorage.getItem(selectMarkerKey()));
  } catch (_) {
    return false; // storage unavailable — nothing recorded, nothing owed
  }
  if (!marker) return false;
  const isMobile = 'ontouchstart' in window;
  const data = await apiMutate('/api/tmux/mouse', 'POST', {
    session: projectName,
    ...tcSelectModeMouse({
      entering: false,
      isMobile,
      mouseOn: marker.on,
      mouseExplicit: marker.explicit
    })
  });
  // Only clear on a successful restore — a failed POST (server down) keeps
  // the marker so the NEXT load can still repair.
  if (data && typeof data.mouse === 'boolean') {
    clearSelectMarker();
    sessionState.mouseOn = data.mouse;
    sessionState.mouseExplicit = !!data.explicit;
    console.debug('Restored tmux mouse state stranded by an interrupted Select (UI-8W3D)');
    return true;
  }
  return false;
}

/**
 * Toggle text selection mode by flipping tmux mouse.
 * On mobile: mouse ON = select mode (allows native text selection).
 * On desktop: mouse OFF = select mode (allows native text selection).
 *
 * Explicit toggle only — no auto-revert timer (#574: the old 30s rug-pull
 * violated the no-UI-timers rule, #98/#268). Leaving select mode restores
 * the pre-select mouse CONFIGURATION via tcSelectModeMouse (#574 + #579):
 * an explicit session-level value is set back; an inherited one is
 * restored by UNSETTING, so no session-level override is stranded (#579 —
 * the benign-valued sibling of the #574 stranded-`off` bug). The
 * pre-select state is snapshotted fresh on entry, not trusted from page
 * load — another tab or the operator may have changed it since.
 */
async function toggleSelect() {
  const isMobile = 'ontouchstart' in window;
  const btn = document.getElementById('selectBtn');

  if (selectModeActive) {
    // Leaving select mode — restore the pre-select mouse configuration
    selectModeActive = false;
    btn.textContent = 'Select';
    btn.classList.remove('select-active');
    const restore = tcSelectModeMouse({
      entering: false,
      isMobile,
      mouseOn: sessionState.mouseOn,
      mouseExplicit: sessionState.mouseExplicit
    });
    const data = await apiMutate('/api/tmux/mouse', 'POST', {
      session: projectName,
      ...restore
    });
    // Track the post-restore effective state the server reports.
    if (data && typeof data.mouse === 'boolean') {
      sessionState.mouseOn = data.mouse;
      sessionState.mouseExplicit = !!data.explicit;
      // Clean exit — the restore ran, so no repair is owed (UI-8W3D).
      clearSelectMarker();
    }
    return;
  }

  // Enter select mode — snapshot the CURRENT state first so exit restores
  // reality, not a stale page-load value.
  const fresh = await api(`/api/tmux/mouse/${encodeURIComponent(projectName)}`);
  if (fresh && typeof fresh.mouse === 'boolean') {
    sessionState.mouseOn = fresh.mouse;
    sessionState.mouseExplicit = !!fresh.explicit;
  }
  // Record the restore intent BEFORE flipping tmux (UI-8W3D): if this page
  // dies mid-select, the next load replays the exit from this marker.
  writeSelectMarker({ on: sessionState.mouseOn, explicit: sessionState.mouseExplicit });
  selectModeActive = true;
  btn.textContent = 'Done';
  btn.classList.add('select-active');
  await apiMutate('/api/tmux/mouse', 'POST', {
    session: projectName,
    ...tcSelectModeMouse({
      entering: true,
      isMobile,
      mouseOn: sessionState.mouseOn,
      mouseExplicit: sessionState.mouseExplicit
    })
  });
}

// ── Paste (#402) ──

/**
 * Resolve the xterm.js Terminal instance inside the session terminal
 * iframe. Same accessor family as applyTerminalTheme — ttyd exposes the
 * instance on its window as `term` (older builds: `terminal`).
 * @returns {object|null} the terminal, or null when the frame isn't ready
 */
function _sessionTerm() {
  const frame = document.getElementById('terminalFrame');
  try {
    const win = frame && frame.contentWindow;
    return (win && (win.term || win.terminal)) || null;
  } catch (_) {
    return null; // cross-origin or not loaded yet
  }
}

/**
 * Feed text into the terminal as a PASTE — through xterm's paste(), which
 * applies bracketed-paste framing when the app enabled it, exactly like a
 * desktop Cmd-V. Never write clipboard text raw: bypassing bracketed
 * paste is how multi-line input corrupts (#192 — inherited here, not
 * worsened).
 * @param {string} text - The text to paste
 * @returns {boolean} true when text was delivered to the terminal
 */
function insertPasteText(text) {
  if (!text) return false;
  const term = _sessionTerm();
  if (!term || typeof term.paste !== 'function') return false;
  try {
    term.paste(text);
    if (typeof term.focus === 'function') term.focus();
  } catch (_) {
    return false; // terminal disposed mid-call — caller toasts the honest reason
  }
  return true;
}

/**
 * Open the paste-catcher modal (#402 fallback path) with a cleared box.
 */
function openPasteCatcher() {
  const ta = document.getElementById('pasteCatcherText');
  ta.value = '';
  document.getElementById('pasteCatcher').classList.add('open');
  ta.focus();
}

/**
 * Close the paste-catcher modal.
 */
function closePasteCatcher() {
  document.getElementById('pasteCatcher').classList.remove('open');
}

/**
 * The Paste button (#402): iOS Safari offers no native paste path into
 * xterm (no Cmd-V; the long-press Paste callout can't target xterm's
 * hidden textarea). Secure contexts read the clipboard inside this tap's
 * gesture (iOS shows its native permission bubble); plain-HTTP (no
 * Clipboard API), rejected reads, and empty reads fall to the catcher — a
 * real textarea the native Paste callout CAN service — rather than
 * silently doing nothing.
 */
async function pasteToTerminal() {
  const nav = window.navigator;
  const path = tcPastePath({
    hasClipboardRead: !!(nav.clipboard && typeof nav.clipboard.readText === 'function'),
    secure: window.isSecureContext === true
  });
  if (path === 'clipboard') {
    try {
      const text = await nav.clipboard.readText();
      if (text) {
        if (!insertPasteText(text)) {
          showBannerActionToast("Couldn't paste: the terminal isn't ready yet.", true);
        }
        return;
      }
      // Empty read — iOS also returns '' on some denials; offer the catcher.
    } catch (_) {
      // Permission denied / API rejection — the catcher still works.
    }
  }
  openPasteCatcher();
}

/**
 * Insert the catcher textarea's content into the terminal and close the
 * modal. Honest refusals: an empty box or an unready terminal toasts the
 * real reason and keeps the modal open.
 */
function insertFromPasteCatcher() {
  const text = document.getElementById('pasteCatcherText').value;
  if (!text) {
    showBannerActionToast('Nothing to insert — paste into the box first.', true);
    return;
  }
  if (!insertPasteText(text)) {
    showBannerActionToast("Couldn't paste: the terminal isn't ready yet.", true);
    return;
  }
  closePasteCatcher();
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
      data.uploads.slice(0, 5).map(u => {
        // Flag-only secret indicator (#343, CC-4): the file is never scrubbed —
        // the badge says "a credential pattern was detected, review it."
        const secretBadge = u.secretsFlagged
          ? `<span class="badge badge-secret" title="&#9888; possible secret detected (${esc((u.secretTypes || []).join(', '))}) — flag only, file not modified">&#9888; secret?</span>`
          : '';
        return `<div class="upload-history-item" role="button" tabindex="0" data-path="${esc(u.path)}" title="Click to copy path: ${esc(u.path)}"><code>${esc(u.name)}</code>${secretBadge}<span class="upload-history-size">${formatSize(u.size)}</span></div>`;
      }).join('');
    // Click / Enter / Space on a history item copies its local path — the same
    // "Tell your AI assistant" affordance the post-upload result offers (#338).
    // `.on*` assignment (not addEventListener) is idempotent across re-opens.
    const copyFromTarget = (target) => {
      const item = target && target.closest ? target.closest('.upload-history-item') : null;
      if (item && item.dataset.path) copyUploadPath(item.dataset.path);
    };
    historyEl.onclick = (e) => copyFromTarget(e.target);
    historyEl.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyFromTarget(e.target); }
    };
  } else {
    historyEl.innerHTML = '';
    historyEl.onclick = null;
    historyEl.onkeydown = null;
  }
}

/**
 * Copy an upload's local path to the clipboard with toast feedback (#338).
 * Mirrors the post-upload "Tell your AI assistant" affordance so a file from
 * the Recent uploads history can be re-grabbed without re-uploading.
 * @param {string} pathStr - The upload's absolute local path.
 * @returns {Promise<void>}
 */
async function copyUploadPath(pathStr) {
  const toast = document.getElementById('toast');
  const flash = (msg, cls) => {
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `toast ${cls} visible`;
    setTimeout(() => { toast.classList.remove('visible'); }, 3000);
  };
  const ok = await tcCopyToClipboard(pathStr);
  flash(
    ok ? 'Upload path copied to clipboard' : 'Could not copy — select the path manually',
    ok ? 'toast-ok' : 'toast-warn'
  );
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
  // #540 — reset the bump choice to Auto on every open. Without this a "Major"
  // picked and then cancelled silently re-arms on a later wrap in the same
  // page session, bumping a major nobody asked for this time.
  const bumpEl = document.getElementById('wrapBumpLevel');
  if (bumpEl) bumpEl.value = '';
  const pwGroup = document.getElementById('wrapPasswordGroup');
  if (sessionState.config && sessionState.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  document.getElementById('wrapModal').classList.add('open');
}

/**
 * True while a wrap POST is in flight. Guards against re-triggering the wrap
 * (double-click → concurrent wraps / double commit) and against dismissing
 * the modal mid-wrap. Reset in confirmWrap's `finally`.
 * @type {boolean}
 */
let wrapInFlight = false;

/**
 * Close the wrap modal. User-initiated closes (Cancel button and backdrop
 * click — neither passes an explicit `true`; the Cancel handler even passes
 * the click event, hence the strict `!== true`) are blocked while a wrap is
 * in flight. `confirmWrap` passes `force:true` to close on completion.
 * @param {boolean} [force]
 */
function closeWrapModal(force) {
  if (wrapInFlight && force !== true) return;
  document.getElementById('wrapModal').classList.remove('open');
}

/**
 * Confirm and execute wrap.
 *
 * The wrap POST returns `pipelineResult` carrying the runner's per-step
 * results — the multi-step drawer takes over (#139 Chunk 10). The
 * no-`pipelineResult` branch below is defensive only (e.g. an error
 * response): the modal closes and the polling loop waits for the
 * session to settle.
 */
async function confirmWrap() {
  // Re-entrancy guard: ignore a second confirm while the first wrap POST is
  // still in flight, so a double-click can't fire two concurrent wraps.
  if (wrapInFlight) return;

  // Fresh wrap — drop any ai-content skips accumulated by a prior wrap's
  // retries (#328) so they don't leak into this run.
  wrapSkippedAiSteps = {};
  const pw = document.getElementById('wrapPassword').value;
  // #540 ask-mode — capture the operator's bump-level choice up front, before
  // version-bump runs. Empty string keeps the CHANGELOG heuristic. Threaded as
  // `options.bumpLevel`, which version-bump honors (or skips-loudly on invalid).
  const bumpEl = document.getElementById('wrapBumpLevel');
  wrapBumpLevel = bumpEl ? bumpEl.value : '';
  const body = {};
  if (pw) body.password = pw;
  // Assembled through the SAME pure helper the retry path uses, so the initial
  // wrap and every retry can't drift on how an option is shaped (notably: Auto
  // must send no bumpLevel at all — version-bump treats an out-of-set value as
  // a reason to skip rather than falling back to the heuristic).
  const initialOptions = window.tcWrapDrawerHelpers.collectOptionsFromAccessors({
    bumpLevel: () => wrapBumpLevel
  });
  if (Object.keys(initialOptions).length > 0) body.options = initialOptions;

  // Lock the modal into a "Wrapping…" state: disable both buttons + flip the
  // confirm label, and set the in-flight flag (which also blocks every close
  // path via closeWrapModal). Restored in `finally` so a failed/hung wrap
  // never leaves the modal permanently stuck. No timers — the state tracks
  // the request lifecycle (feedback: no timer-driven UI lifecycle).
  const confirmBtn = document.getElementById('wrapConfirmBtn');
  const cancelBtn = document.getElementById('wrapCancelBtn');
  const priorLabel = confirmBtn.textContent;
  wrapInFlight = true;
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  confirmBtn.textContent = 'Wrapping…';
  document.getElementById('wrapError').classList.add('hidden');

  // #583: freshness gate for the reattach path — a finished run older
  // than this instant is some previous wrap's outcome, not this one's.
  const postStartedAt = Date.now();

  try {
    const data = await apiMutate(
      `/api/sessions/${encodeURIComponent(projectName)}/wrap`,
      'POST',
      body
    );

    if (!data) {
      // #583: a failed POST does NOT mean no wrap is running. The pipeline
      // outlives its connection (409 WRAP_IN_PROGRESS, a proxy 502, a
      // dropped fetch) — probe /wrap/status and reattach before claiming
      // failure. Re-POSTing here is exactly what re-fired the content
      // steps in the 2026-07-16 incident.
      const handled = await watchWrapRun(postStartedAt, pw);
      if (!handled) {
        // Genuine failure (bad password, no session) — surface inline and
        // let `finally` re-enable so the operator can fix and retry.
        document.getElementById('wrapError').textContent = api.lastError || 'Wrap failed. Check password.';
        document.getElementById('wrapError').classList.remove('hidden');
      }
      return;
    }

    closeWrapModal(true); // force-close past the in-flight guard on success

    if (data.pipelineResult) {
      // V2 path — pipeline ran server-side; render the drawer with the
      // per-step result. The drawer drives any retry-with-options round
      // trips itself; the legacy wrapping bar + polling don't apply.
      // Hand the password down so retries can re-authenticate without
      // re-prompting (M1 — the wrap endpoint enforces deleteProtected on
      // every call, V1 and V2 alike).
      openWrapDrawer(data.pipelineResult, pw);
      return;
    }

    // V1 legacy path — pipeline still in flight inside the AI session.
    sessionState.wrapping = true;
    showWrappingState();
    // Increase poll frequency during wrapping
    sessionState.pollInterval = 2000;
    startPolling();
  } finally {
    wrapInFlight = false;
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    confirmBtn.textContent = priorLabel;
  }
}

// ── Wrap Pipeline Drawer (#139 Chunk 10) ──

/**
 * Cached wrap password from the original `confirmWrap`. The wrap
 * endpoint enforces `deleteProtected` on every call (server.js
 * `checkDeletePassword`), so retries must include the same password
 * the initial POST authenticated with. Cleared on drawer close.
 * @type {string}
 */
let currentWrapPassword = '';

/**
 * Last pipeline result rendered into the drawer. Retained so the "Copy
 * report" button can serialize the full report on demand (#268). Cleared
 * on drawer close.
 * @type {object|null}
 */
let currentWrapPipelineResult = null;

/**
 * Accumulated ai-content "Skip & note" overrides across retries (#328),
 * keyed by step id. The drawer only shows the currently-blocked step, but
 * the pipeline re-runs from step 0 on every retry — so an earlier content
 * step's skip must persist or it would re-block on the next attempt. Each
 * retry merges its checkbox state into this map and threads the whole map.
 * Reset when a fresh wrap starts (`confirmWrap`).
 * @type {Object<string, true>}
 */
let wrapSkippedAiSteps = {};

/**
 * #540 ask-mode — the operator's chosen version-bump level (`patch`/`minor`/
 * `major`, or `''` for the CHANGELOG heuristic), captured from the wrap modal
 * at `confirmWrap`. Replayed on every retry because the pipeline re-runs from
 * step 0, so version-bump must see the same choice each attempt. Reset when a
 * fresh wrap starts.
 * @type {string}
 */
let wrapBumpLevel = '';

/**
 * The pipeline's own status banner for the currently-rendered wrap (#638).
 * Retained so a release-state recheck composes against the pipeline's verdict
 * — a warning or error the pipeline reported must survive a green release
 * rather than being repainted as "shipped". Cleared on drawer close.
 * @type {{label: string, tone: string, detail: string|null}|null}
 */
let currentWrapBaseStatus = null;

/**
 * The status banner currently PAINTED in the drawer — the pipeline's own verdict
 * until the #638 release resolution (or a "Recheck release") repaints it to the
 * merged/pending/blocked outcome. Held so the copied report reflects what the
 * operator is looking at: without it, `buildReportText` re-derives the header from
 * the frozen pipeline result and reports "release pending" even after the PR merged
 * on screen, forcing the operator to share both the screenshot and the text.
 * @type {{label: string, tone: string, detail: string|null}|null}
 */
let currentWrapDisplayedStatus = null;

/**
 * Open the wrap drawer with a rendered pipeline result and wire its
 * action buttons for the current state (retry / done / close).
 *
 * @param {object} pipelineResult - From `POST /wrap` response body.
 * @param {string} [password] - Password collected by the initial wrap
 *   modal, replayed on every retry. Empty string on
 *   non-delete-protected installs.
 */
function openWrapDrawer(pipelineResult, password) {
  if (typeof password === 'string') currentWrapPassword = password;
  currentWrapPipelineResult = pipelineResult;
  // Flag the open drawer so a concurrent session-ended poll doesn't start
  // the auto-redirect countdown and navigate the blocked report away (#268).
  sessionState.wrapDrawerOpen = true;
  // #583: on the reattach path the drawer can open AFTER handleSessionEnded
  // already started its countdown (the watch loop polls every few seconds,
  // the ended poll can win the race) — the #268 rule is drawer-open ⇒ no
  // auto-redirect, so a countdown already ticking is cancelled here.
  cancelEndedCountdown();
  renderWrapDrawer(pipelineResult);
  document.getElementById('wrapDrawerBackdrop').classList.add('open');
  document.getElementById('wrapDrawer').classList.add('open');
}

/**
 * Hide the drawer and clear retained state.
 */
function closeWrapDrawer() {
  document.getElementById('wrapDrawerBackdrop').classList.remove('open');
  document.getElementById('wrapDrawer').classList.remove('open');
  const skipRoll = document.getElementById('wrapDrawerSkipRoll');
  if (skipRoll) { skipRoll.innerHTML = ''; skipRoll.classList.add('hidden'); }
  currentWrapPassword = '';
  currentWrapPipelineResult = null;
  currentWrapBaseStatus = null;
  currentWrapDisplayedStatus = null;
  sessionState.wrapDrawerOpen = false;
}

/**
 * Copy the full wrap report (status + every step's output) to the
 * clipboard so the operator can paste it into an issue or share it. The
 * blocked report is the operator's primary source of truth for why a wrap
 * halted, so it must be capturable, not just readable (#268).
 */
async function copyWrapReport() {
  if (!currentWrapPipelineResult || !window.tcWrapDrawerHelpers) return;
  // Pass the currently-painted banner so the report header reflects the resolved
  // release outcome (PR merged / pending / blocked), not the frozen pipeline verdict.
  const text = window.tcWrapDrawerHelpers.buildReportText(
    currentWrapPipelineResult, currentWrapDisplayedStatus
  );
  const toast = document.getElementById('toast');
  const flash = (msg, cls) => {
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `toast ${cls} visible`;
    setTimeout(() => { toast.classList.remove('visible'); }, 3000);
  };
  const ok = await tcCopyToClipboard(text);
  flash(
    ok ? 'Wrap report copied to clipboard' : 'Could not copy — select the report text manually',
    ok ? 'toast-ok' : 'toast-warn'
  );
}

/**
 * Paint the wrap-drawer status banner from a `{label, tone, detail}` view-model
 * — factored out so the #638 release-state resolution can repaint it in place.
 * When a wrap PR is passed, a "Recheck release" button is appended so the
 * operator can re-probe the merge outcome on demand (explicit action, no timer).
 *
 * @param {{label: string, tone: string, detail: string|null}} status - The banner to paint.
 * @param {{prUrl: string|null}|null} [prForRecheck] - Wrap PR to offer a recheck for.
 * @param {{label: string, tone: string, detail: string|null}|null} [baseStatus] - The
 *   PIPELINE's own verdict, carried through to the recheck handler so every
 *   re-probe composes against it rather than against the currently-painted
 *   banner. Without it, repeated rechecks would compound release banners and a
 *   pipeline warning could be lost behind a green release.
 */
function paintWrapStatus(status, prForRecheck, baseStatus) {
  // Mirror the painted banner so the copied report matches what's on screen. This
  // is the primary paint path (initial verdict, the #638 release resolution, a
  // manual "Recheck release"); the error and notice paths below paint the same
  // element directly and update this mirror themselves, so the report never lags
  // any state the banner can show.
  currentWrapDisplayedStatus = status;
  const statusEl = document.getElementById('wrapDrawerStatus');
  statusEl.className = `wrap-drawer-status wrap-drawer-status--${status.tone}`;
  statusEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = status.label;
  statusEl.appendChild(label);
  if (prForRecheck && prForRecheck.prUrl) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wrap-drawer-recheck';
    btn.textContent = 'Recheck release';
    btn.title = 'Re-query GitHub for this wrap PR’s merge outcome.';
    // Pass the ORIGINAL pipeline status, not the currently-painted one, so
    // repeated rechecks compose against the pipeline's own verdict rather than
    // compounding a previous release banner.
    btn.addEventListener('click', () => resolveWrapPrStatus(prForRecheck, btn, baseStatus));
    statusEl.appendChild(btn);
  }
  if (status.detail) {
    const detail = document.createElement('span');
    detail.className = 'wrap-drawer-status-detail';
    detail.textContent = status.detail;
    statusEl.appendChild(detail);
  }
}

/**
 * #638 — resolve the wrap PR's live merge outcome and repaint the banner so a
 * blocked release (a red required check) never lingers as "success". Read-only;
 * on a network/api error the provisional banner is left untouched (honest
 * "not confirmed" beats a wrong claim). The recheck button stays available
 * unless the release is confirmed merged.
 *
 * @param {{prUrl: string|null}} pr - Wrap PR handle from `wrapPrInfo`.
 * @param {HTMLButtonElement|null} btn - The recheck button, disabled while in flight.
 * @param {{label: string, tone: string, detail: string|null}|null} [baseStatus] - The
 *   pipeline's own verdict to compose the release outcome against, so a warning
 *   or error the pipeline reported survives a green release. Falls back to
 *   `currentWrapBaseStatus` (the rendered wrap's verdict) when omitted.
 */
async function resolveWrapPrStatus(pr, btn, baseStatus) {
  if (!pr || !pr.prUrl || !window.tcWrapDrawerHelpers) return;
  if (btn) btn.disabled = true;
  const data = await api(
    `/api/sessions/${encodeURIComponent(projectName)}/wrap/pr-status?url=${encodeURIComponent(pr.prUrl)}`
  );
  if (btn) btn.disabled = false;
  if (!data || typeof data.outcome !== 'string') return; // leave provisional as-is
  // Compose rather than replace: a pipeline-level warning/error must survive a
  // green release, or the probe would repaint a problem wrap as "shipped".
  const banner = window.tcWrapDrawerHelpers.composeReleaseBanner(
    baseStatus || currentWrapBaseStatus,
    data
  );
  paintWrapStatus(banner, data.outcome === 'merged' ? null : pr, baseStatus || currentWrapBaseStatus);
}

/**
 * #571 item 4 — render the honest skip rollup under the status banner. Hidden
 * when nothing was skipped; otherwise "Skipped N of M steps" with each skip's
 * reason, so a silently-inert wrap reads as inert rather than green.
 *
 * @param {object} pipelineResult
 */
function renderSkipRoll(pipelineResult) {
  const el = document.getElementById('wrapDrawerSkipRoll');
  if (!el) return;
  const H = window.tcWrapDrawerHelpers;
  const roll = H.summarizeSkips(pipelineResult);
  el.innerHTML = '';
  if (roll.skipped === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const head = document.createElement('div');
  head.className = 'wrap-drawer-skiproll-head';
  head.textContent = `Skipped ${roll.skipped} of ${roll.total} steps:`;
  el.appendChild(head);
  const ul = document.createElement('ul');
  ul.className = 'wrap-drawer-skiproll-list';
  for (const s of roll.skips) {
    const li = document.createElement('li');
    li.textContent = `${H.KIND_LABELS[s.kind] || s.kind} (${s.id}) — ${s.reason}`;
    ul.appendChild(li);
  }
  el.appendChild(ul);
}

/**
 * Render the drawer body from a pipeline result. Pure DOM mutation;
 * all shape-to-view-model decisions live in `tcWrapDrawerHelpers`.
 *
 * @param {object} pipelineResult
 */
function renderWrapDrawer(pipelineResult) {
  const H = window.tcWrapDrawerHelpers;
  const status = H.summarizePipelineStatus(pipelineResult);
  currentWrapBaseStatus = status;

  // Status banner (repaintable — the #638 release resolution repaints it).
  paintWrapStatus(status, status.pr, status);

  // #571 item 4 — honest skip rollup under the banner.
  renderSkipRoll(pipelineResult);

  // #638 — one automatic release-state resolution when the commit opened a wrap
  // PR. The pipeline returns before GitHub merges, so `summarizePipelineStatus`
  // paints "release pending"; this resolves it to merged/pending/blocked. A
  // single event-triggered fetch (not a repeating timer), with an explicit
  // "Recheck release" button for re-polling — honoring the no-timer-driven-UI
  // rule (#98/#268).
  if (status.pr && status.pr.prUrl) resolveWrapPrStatus(status.pr, null, status);

  // Build all view-model rows once; both the step list and the
  // decision-widget loop consume the same array (N6 — avoid double-
  // computing per render and keep the helper a single source of truth).
  const results = Array.isArray(pipelineResult.results) ? pipelineResult.results : [];
  const rows = results.map((r) => ({
    row: H.buildStepRow(r, { blockedAt: pipelineResult.blockedAt }),
    raw: r
  }));

  // Step list
  const listEl = document.getElementById('wrapStepList');
  listEl.innerHTML = '';
  for (const { row } of rows) {
    listEl.appendChild(renderStepRow(row));
  }

  // Decision widget — for the blocked step OR for any ok:true step
  // that surfaced a non-blocking warning (`output.warning`) OR a
  // pr-check with unresolved session-scoped PRs.
  const decisionEl = document.getElementById('wrapDrawerDecision');
  decisionEl.innerHTML = '';
  let widgetRendered = false;
  let warningOnly = false;
  for (const { row, raw } of rows) {
    if (row.isBlocker) {
      const widget = H.decisionWidgetForBlockedStep(row);
      if (widget) {
        decisionEl.appendChild(renderDecisionWidget(widget));
        widgetRendered = true;
      }
      // A blocked pr-check IS the unresolved-PR gate — its recovery
      // affordance is the per-PR resolution list, not the single-input
      // widget above, so it has to render here too. Without this the
      // gate would block with no way to answer it.
      if (row.kind === 'pr-check') {
        const prWidget = H.prCheckResolutionWidget(row, raw.output);
        if (prWidget) {
          decisionEl.appendChild(renderPrResolutionWidget(prWidget));
          widgetRendered = true;
        }
      }
      // Blocker takes precedence over anything later — the user must
      // address it before anything else matters.
      break;
    }
    if (row.kind === 'pr-check') {
      // An unblocked pr-check can still carry unresolved PRs (e.g. only
      // non-session-scoped ones, or a degraded probe) — offer resolution
      // without forcing it.
      const prWidget = H.prCheckResolutionWidget(row, raw.output);
      if (prWidget) {
        decisionEl.appendChild(renderPrResolutionWidget(prWidget));
        widgetRendered = true;
        warningOnly = true;
      }
    }
    if (row.kind === 'priming-roll') {
      // #428: a blocked priming-roll carrying candidate plans (multi
      // in-progress, can't auto-pick) gets an inline plan-picker. Its
      // "Set active plan" button persists `activePlan` on its own — so,
      // unlike pr-check, this does NOT set `warningOnly`: no whole-pipeline
      // Retry (which would double-commit a non-fatal block), just the
      // picker + Done. The pick sticks for the next wrap.
      const planWidget = H.planPickerWidget(row, raw.output);
      if (planWidget) {
        decisionEl.appendChild(renderPlanPickerWidget(planWidget));
        widgetRendered = true;
      }
    }
    if (row.kind === 'rule-proposal') {
      // #569: the wrap proposed rules from recurring learnings. Like the
      // plan-picker this widget performs per-rule API writes (approve/reject),
      // not a pipeline retry — so it does NOT set `warningOnly`: the step is
      // done, the decisions are independent of the wrap, and Done just closes.
      const rpWidget = H.ruleProposalWidget(row, raw.output);
      if (rpWidget) {
        decisionEl.appendChild(renderRuleProposalWidget(rpWidget));
        widgetRendered = true;
      }
    }
  }
  decisionEl.classList.toggle('hidden', !widgetRendered);

  // Action buttons:
  // - Retry: visible whenever there's something actionable (blocker OR
  //   an unresolved widget). A retry on a warning-only state re-runs
  //   the whole pipeline, which produces a SECOND commit on top of the
  //   one that already landed — surfaced inline in the decision widget
  //   so the user can choose Done instead (M4).
  // - Done: visible on clean ok:true AND on warning-only state — the
  //   latter lets the user accept the warnings as-is without producing
  //   a second commit.
  // - Cancel/Close: always available.
  const retryBtn = document.getElementById('wrapDrawerRetryBtn');
  const doneBtn = document.getElementById('wrapDrawerDoneBtn');
  const cancelBtn = document.getElementById('wrapDrawerCancelBtn');
  const blocked = Boolean(pipelineResult.blockedAt);
  if (blocked) {
    retryBtn.classList.remove('hidden');
    doneBtn.classList.add('hidden');
    cancelBtn.textContent = 'Cancel';
  } else if (widgetRendered && warningOnly) {
    // ok:true + warnings: Retry re-runs (double commit if commit step
    // already landed); Done accepts current state as-is.
    retryBtn.classList.remove('hidden');
    doneBtn.classList.remove('hidden');
    cancelBtn.textContent = 'Close';
  } else {
    retryBtn.classList.add('hidden');
    doneBtn.classList.remove('hidden');
    cancelBtn.textContent = 'Close';
  }

  // #696: name the action honestly. When a "skip this step" box is ticked, Retry
  // re-runs the pipeline PAST the skipped step (skip-and-continue), so the button
  // must not keep reading "Retry" — which reads as re-attempting the step. Called
  // on every render so a fresh (unticked) drawer resets to "Retry".
  syncRetryLabel();
}

/**
 * Set the wrap drawer's action button to "Skip & continue" when a blocked-step
 * "skip this step" box is ticked, else "Retry" (#696). Retry-with-skip re-runs the
 * pipeline past the skipped step (`retryWrap` threads the skip through), so the
 * label has to say so. Covers the ai-content "Skip & note" box and the test-skip
 * box — both mean skip-and-proceed. No behavior change; label only.
 */
function syncRetryLabel() {
  const retryBtn = document.getElementById('wrapDrawerRetryBtn');
  if (!retryBtn) return;
  const decisionEl = document.getElementById('wrapDrawerDecision');
  const skipChecked = decisionEl && decisionEl.querySelector(
    'input[data-options-key="skipAiContent"]:checked, input[data-options-key="skipTests"]:checked'
  );
  retryBtn.textContent = skipChecked ? 'Skip & continue' : 'Retry';
}

/**
 * Build a `<li>` for one pipeline step view-model.
 *
 * @param {object} row - From `tcWrapDrawerHelpers.buildStepRow`.
 * @returns {HTMLLIElement}
 */
function renderStepRow(row) {
  const li = document.createElement('li');
  li.className = 'wrap-step-row';
  if (row.isBlocker) li.classList.add('wrap-step-row--blocker');
  else if (row.warning) li.classList.add('wrap-step-row--warning');
  li.dataset.stepId = row.id;
  li.dataset.kind = row.kind;

  const main = document.createElement('div');
  main.className = 'wrap-step-main';

  const labelLine = document.createElement('span');
  labelLine.className = 'wrap-step-label';
  labelLine.textContent = `${row.kindLabel} — ${row.id}`;
  main.appendChild(labelLine);
  // Per-step help: a tap/click-toggle ⓘ that reveals an inline description.
  // MUST work on touch — iPhone Safari is the primary platform, where native
  // `title=`/`:hover` never fire — so the affordance toggles inline text on
  // click; `title` is kept only as a desktop hover bonus.
  if (row.kindTooltip) {
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'wrap-step-help';
    help.textContent = 'ⓘ';
    help.title = row.kindTooltip;
    help.setAttribute('aria-label', `What “${row.kindLabel}” does`);
    help.setAttribute('aria-expanded', 'false');

    const helpText = document.createElement('p');
    helpText.className = 'wrap-step-help-text';
    helpText.textContent = row.kindTooltip;
    helpText.hidden = true;

    help.addEventListener('click', () => {
      const show = helpText.hidden;
      helpText.hidden = !show;
      help.setAttribute('aria-expanded', String(show));
    });

    labelLine.appendChild(document.createTextNode(' '));
    labelLine.appendChild(help);
    main.appendChild(helpText);
  }

  if (row.detail) {
    const detailLine = document.createElement('span');
    detailLine.className = 'wrap-step-detail';
    detailLine.textContent = row.detail;
    main.appendChild(detailLine);
  }

  if (row.blockers && row.blockers.length > 0) {
    const blockersLine = document.createElement('span');
    blockersLine.className = 'wrap-step-blockers';
    blockersLine.textContent = row.blockers.join('; ');
    main.appendChild(blockersLine);
  }

  // "How to fix this" — handler-supplied remediation for a blocked step
  // (#223). Collapsible <details> so it doesn't crowd the row but is one
  // click from the operator. Absent remediation → nothing rendered, the
  // raw blocker line above stays the only signal (back-compat).
  if (row.remediation) {
    const fix = document.createElement('details');
    fix.className = 'wrap-step-remediation';
    const summary = document.createElement('summary');
    summary.textContent = 'How to fix this';
    fix.appendChild(summary);
    const body = document.createElement('p');
    body.className = 'wrap-step-remediation-body';
    body.textContent = row.remediation;
    fix.appendChild(body);
    main.appendChild(fix);
  }

  const status = document.createElement('span');
  status.className = `wrap-step-status wrap-step-status--${row.statusTone}`;
  status.textContent = row.statusLabel;
  // Plain `title` tooltip explaining what the status means (#222) — no JS,
  // no dependency, accessible. Text comes from STATUS_META in wrap-drawer.js.
  if (row.statusTooltip) status.title = row.statusTooltip;

  li.appendChild(main);
  li.appendChild(status);
  return li;
}

/**
 * Build the inline decision widget (checkbox OR textarea) for a single
 * blocked-step kind. PR-list widgets are handled separately by
 * `renderPrResolutionWidget` because they need iteration.
 *
 * @param {object} widget - From `decisionWidgetForBlockedStep` or
 *   `decisionWidgetForBlockedStep`.
 * @returns {HTMLDivElement}
 */
function renderDecisionWidget(widget) {
  const wrap = document.createElement('div');
  wrap.className = 'wrap-decision';
  wrap.dataset.optionsKey = widget.optionsKey;
  wrap.dataset.kind = widget.kind;

  if (widget.inputType === 'checkbox') {
    const row = document.createElement('label');
    row.className = 'wrap-decision-checkbox-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `wrapDecisionInput_${widget.optionsKey}`;
    input.dataset.optionsKey = widget.optionsKey;
    // #328: step-scoped overrides (ai-content Skip & note) carry the blocked
    // step id so retryWrap can thread `{[stepId]: true}` to the server.
    if (widget.stepId) input.dataset.stepId = widget.stepId;
    // #696: ticking a "skip this step" box makes Retry skip-and-continue, so keep
    // the action button's label honest as the box toggles.
    input.addEventListener('change', syncRetryLabel);
    row.appendChild(input);
    const text = document.createElement('span');
    text.textContent = widget.label;
    row.appendChild(text);
    wrap.appendChild(row);
    return wrap;
  }

  if (widget.inputType === 'textarea') {
    const label = document.createElement('label');
    label.className = 'wrap-decision-label';
    label.textContent = widget.label;
    label.setAttribute('for', `wrapDecisionInput_${widget.optionsKey}`);
    const ta = document.createElement('textarea');
    ta.className = 'wrap-decision-textarea';
    ta.id = `wrapDecisionInput_${widget.optionsKey}`;
    ta.dataset.optionsKey = widget.optionsKey;
    wrap.appendChild(label);
    wrap.appendChild(ta);
    return wrap;
  }

  // Unknown input type — surface as plain label, don't break the render.
  const fallback = document.createElement('p');
  fallback.textContent = widget.label;
  wrap.appendChild(fallback);
  return wrap;
}

/**
 * Build the PR-resolution widget — one row per unresolved
 * session-scoped PR with a per-PR dropdown. PR title doubles as the
 * anchor to the PR page (T3) so users can review before resolving.
 *
 * @param {object} widget - From `prCheckResolutionWidget`.
 * @returns {HTMLDivElement}
 */
function renderPrResolutionWidget(widget) {
  const wrap = document.createElement('div');
  wrap.className = 'wrap-decision wrap-decision--prlist';
  wrap.dataset.optionsKey = 'prHandling';
  wrap.dataset.kind = 'pr-check';

  // a11y (UI-7H4K): the caption spans N per-PR selects, so it's a group
  // caption (not a single-control <label>). Mark the list a labelled group
  // and give each select its own accessible name from the PR title below.
  const groupLabelId = 'wrapPrResolveGroupLabel';
  const label = document.createElement('div');
  label.className = 'wrap-decision-label';
  label.id = groupLabelId;
  label.textContent = `Resolve ${widget.prs.length} open PR${widget.prs.length === 1 ? '' : 's'} on this branch:`;
  wrap.appendChild(label);

  const list = document.createElement('div');
  list.className = 'wrap-decision-prlist';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-labelledby', groupLabelId);
  for (const pr of widget.prs) {
    const row = document.createElement('div');
    row.className = 'wrap-decision-prrow';
    row.dataset.prNumber = String(pr.number);

    // Title is an anchor when we have a URL (T3) — opens in a new tab
    // with safe rel attribute. Falls back to span when URL absent so
    // pr-check output without `url` still renders.
    let titleEl;
    if (pr.url) {
      titleEl = document.createElement('a');
      titleEl.href = pr.url;
      titleEl.target = '_blank';
      titleEl.rel = 'noopener noreferrer';
    } else {
      titleEl = document.createElement('span');
    }
    titleEl.className = 'wrap-decision-prtitle';
    titleEl.id = `wrapPrTitle-${pr.number}`;
    titleEl.textContent = `#${pr.number} ${pr.title}`;
    titleEl.title = pr.url || '';

    const sel = document.createElement('select');
    sel.className = 'wrap-decision-prselect';
    sel.dataset.prNumber = String(pr.number);
    // a11y (UI-7H4K): name this resolution select by its PR title.
    sel.setAttribute('aria-labelledby', titleEl.id);
    for (const opt of [
      { v: '', label: '— pick —' },
      { v: 'merge', label: 'Merge before wrap' },
      { v: 'defer', label: 'Defer (note in commit)' },
      { v: 'ignore', label: 'Ignore' }
    ]) {
      const o = document.createElement('option');
      o.value = opt.v;
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    row.appendChild(titleEl);
    row.appendChild(sel);
    list.appendChild(row);
  }
  wrap.appendChild(list);

  // Inline note: re-running pr-check after a commit step already landed
  // produces a second commit. Surfaces the trade-off so the user can
  // choose Done instead of Retry when appropriate (M4 — paired with
  // the warning-state Done-button visibility in `renderWrapDrawer`).
  const note = document.createElement('p');
  note.className = 'wrap-decision-note';
  note.textContent = 'Retry re-runs the whole pipeline — if a commit already landed, a second commit will be created. Click Done to accept the current state as-is.';
  wrap.appendChild(note);
  return wrap;
}

/**
 * Build the inline plan-picker for a blocked priming-roll step (#428).
 * A dropdown of the candidate plan filenames + a "Set active plan" button
 * that persists the operator's pick to `activePlan` (via PATCH). Unlike the
 * pr-check widget this performs a config write — no whole-pipeline retry —
 * so the pick "sticks" for the next wrap without a double-commit.
 *
 * @param {object} widget - From `planPickerWidget` ({kind, candidates}).
 * @returns {HTMLDivElement}
 */
function renderPlanPickerWidget(widget) {
  const wrap = document.createElement('div');
  wrap.className = 'wrap-decision wrap-decision--planpick';
  wrap.dataset.kind = 'priming-roll';

  const selId = 'wrapPlanPickSelect';
  const label = document.createElement('label');
  label.className = 'wrap-decision-label';
  label.htmlFor = selId; // a11y (UI-7H4K): tie the label to its single control
  label.textContent = `Multiple in-progress plans (${widget.candidates.length}) — pick which one this session was working from:`;
  wrap.appendChild(label);

  // WHY this appeared — a plain-language explainer so the operator isn't
  // guessing at an unfamiliar affordance.
  const why = document.createElement('p');
  why.className = 'wrap-decision-help';
  why.textContent = 'Why: TangleClaw found more than one in-progress build plan in this project’s plans directory and can’t tell which to roll forward, so it didn’t auto-pick (this step is non-fatal — the wrap still finished).';
  wrap.appendChild(why);

  const sel = document.createElement('select');
  sel.className = 'wrap-decision-planselect';
  sel.id = selId;
  sel.title = 'Pick the build plan this session was working from — it will be saved as this project’s active plan.';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— pick a plan —';
  sel.appendChild(placeholder);
  for (const file of widget.candidates) {
    const o = document.createElement('option');
    o.value = file;
    o.textContent = file;
    sel.appendChild(o);
  }
  wrap.appendChild(sel);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wrap-decision-setplan';
  btn.textContent = 'Set active plan';
  btn.title = 'Save the selected plan as this project’s active plan (writes activePlan to .tangleclaw/project.json).';
  wrap.appendChild(btn);

  // WHAT/HOW happens next.
  const note = document.createElement('p');
  note.className = 'wrap-decision-note';
  note.textContent = 'What happens: your pick is saved to this project (activePlan), so this and future wraps roll that plan’s chunk pointer automatically. No re-run needed — click Done to close.';
  wrap.appendChild(note);

  btn.addEventListener('click', () => setActivePlan(sel, btn, note));
  return wrap;
}

/**
 * Persist the operator's plan pick to `activePlan` via PATCH (#428).
 * Reflects success/failure inline; no drawer re-open, no wrap re-trigger.
 *
 * @param {HTMLSelectElement} sel - The plan dropdown.
 * @param {HTMLButtonElement} btn - The "Set active plan" button.
 * @param {HTMLElement} noteEl - The inline note element to update.
 */
async function setActivePlan(sel, btn, noteEl) {
  const filename = sel.value;
  if (!filename) {
    noteEl.textContent = 'Pick a plan first.';
    return;
  }
  btn.disabled = true;
  sel.disabled = true;
  const data = await apiMutate(
    `/api/projects/${encodeURIComponent(projectName)}`,
    'PATCH',
    { activePlan: filename }
  );
  if (!data) {
    // Validation failure / auth / server error → apiMutate returned null,
    // api.lastError carries the reason (the 400 the PATCH route returns).
    btn.disabled = false;
    sel.disabled = false;
    noteEl.textContent = (typeof api !== 'undefined' && api.lastError)
      || 'Could not set the active plan. Try again.';
    return;
  }
  if (Array.isArray(data.warnings) && data.warnings.length > 0) {
    btn.disabled = false;
    sel.disabled = false;
    noteEl.textContent = data.warnings.join('; ');
    return;
  }
  noteEl.textContent = `Active plan set to ${filename} ✓ — the next wrap will roll its pointer. Click Done to close.`;
  btn.textContent = 'Saved';
}

/**
 * Build the rule-proposal review widget (#569) — one row per proposed rule
 * with editable text and Approve / Reject buttons. Each decision is an
 * independent API write (no pipeline retry, no double-commit risk): approve
 * saves any text edit first, then flips the rule to `active`; reject flips it
 * to `rejected`, which is recorded so the same learning is never re-proposed.
 *
 * Approval is a protected operation server-side (the same operator gate as
 * the wrap itself), so the widget replays the wrap modal's cached password
 * and only surfaces a password input if the server actually refuses (403) —
 * e.g. after a page reload dropped the cache.
 *
 * @param {object} widget - From `ruleProposalWidget` ({kind, proposals}).
 * @returns {HTMLDivElement}
 */
function renderRuleProposalWidget(widget) {
  const wrap = document.createElement('div');
  wrap.className = 'wrap-decision wrap-decision--proposals';
  wrap.dataset.kind = 'rule-proposal';

  const groupLabelId = 'wrapRuleProposalGroupLabel';
  const label = document.createElement('div');
  label.className = 'wrap-decision-label';
  label.id = groupLabelId;
  const n = widget.proposals.length;
  label.textContent = `The wrap proposed ${n} rule${n === 1 ? '' : 's'} from recurring learnings:`;
  wrap.appendChild(label);

  const why = document.createElement('p');
  why.className = 'wrap-decision-help';
  why.textContent = 'Why: a learning that kept recurring across sessions is a candidate rule for future sessions. Nothing governs anything until you approve it — edit the text first if it needs sharpening. Rejections are remembered, so a rejected rule won’t be proposed again.';
  wrap.appendChild(why);

  // Hidden until the server refuses an approval (403) — normally the wrap
  // modal's cached password covers it and this never appears. Created before
  // the rows because each row's buttons capture it.
  const pwGroup = document.createElement('div');
  pwGroup.className = 'wrap-proposal-password hidden';
  const pwLabel = document.createElement('label');
  pwLabel.className = 'wrap-decision-label';
  pwLabel.htmlFor = 'wrapProposalPassword';
  pwLabel.textContent = 'Approving a rule needs the delete password:';
  const pwInput = document.createElement('input');
  pwInput.type = 'password';
  pwInput.id = 'wrapProposalPassword';
  pwInput.className = 'wrap-proposal-password-input';
  pwInput.autocomplete = 'current-password';
  pwGroup.appendChild(pwLabel);
  pwGroup.appendChild(pwInput);

  const list = document.createElement('div');
  list.className = 'wrap-proposal-list';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-labelledby', groupLabelId);
  for (const p of widget.proposals) {
    const row = document.createElement('div');
    row.className = 'wrap-proposal-row';
    row.dataset.ruleId = String(p.ruleId);

    const ta = document.createElement('textarea');
    ta.className = 'wrap-proposal-text';
    ta.value = p.content;
    ta.rows = 3;
    ta.spellcheck = false;
    ta.setAttribute('aria-label', `Proposed rule ${p.ruleId} — edit before approving if needed`);
    row.appendChild(ta);

    const actions = document.createElement('div');
    actions.className = 'wrap-proposal-actions';
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'btn btn-small btn-primary wrap-proposal-approve';
    approveBtn.textContent = 'Approve';
    approveBtn.title = 'Make this a governing rule for future sessions (saves your edits first).';
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'btn btn-small wrap-proposal-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.title = 'Decline — recorded so this learning is not proposed again.';
    actions.appendChild(approveBtn);
    actions.appendChild(rejectBtn);
    row.appendChild(actions);

    const note = document.createElement('p');
    note.className = 'wrap-proposal-note';
    note.setAttribute('role', 'status');
    row.appendChild(note);

    approveBtn.addEventListener('click', () =>
      resolveRuleProposal(p, 'active', { row, ta, approveBtn, rejectBtn, note, passwordGroup: pwGroup, passwordInput: pwInput }));
    rejectBtn.addEventListener('click', () =>
      resolveRuleProposal(p, 'rejected', { row, ta, approveBtn, rejectBtn, note, passwordGroup: pwGroup, passwordInput: pwInput }));
    list.appendChild(row);
  }
  wrap.appendChild(list);
  wrap.appendChild(pwGroup);

  return wrap;
}

/**
 * Resolve one proposed rule — approve into a governing rule or reject (#569).
 * Approve saves a text edit first (PUT content), then flips status; the two
 * writes are sequential so an edit can never be approved un-saved. Reflects
 * the outcome inline and disables the row once decided; on a 403 (password
 * gate) reveals the widget's password input instead of failing opaquely.
 *
 * @param {{ruleId: number, content: string}} proposal - The proposal as rendered.
 * @param {'active'|'rejected'} decision - The operator's answer.
 * @param {object} els - Row elements: {row, ta, approveBtn, rejectBtn, note, passwordGroup, passwordInput}.
 */
async function resolveRuleProposal(proposal, decision, els) {
  const { ta, approveBtn, rejectBtn, note, passwordGroup, passwordInput } = els;
  approveBtn.disabled = true;
  rejectBtn.disabled = true;
  ta.disabled = true;

  const finishEnabled = () => {
    approveBtn.disabled = false;
    rejectBtn.disabled = false;
    ta.disabled = false;
  };

  if (decision === 'active') {
    const edited = ta.value.trim();
    if (!edited) {
      note.textContent = 'Rule text can’t be empty — edit it or Reject instead.';
      finishEnabled();
      return;
    }
    if (edited !== proposal.content.trim()) {
      const saved = await apiMutate(`/api/session-rules/${proposal.ruleId}`, 'PUT', { content: edited });
      if (!saved) {
        note.textContent = `Couldn’t save your edit: ${api.lastError || 'unknown error'}. Nothing was approved.`;
        finishEnabled();
        return;
      }
      proposal.content = edited;
    }
    const body = { status: 'active' };
    const pw = (passwordInput && passwordInput.value) || currentWrapPassword;
    if (pw) body.password = pw;
    const data = await apiMutate(`/api/session-rules/${proposal.ruleId}/status`, 'PUT', body);
    if (!data) {
      if (api.lastErrorCode === 'FORBIDDEN' && passwordGroup) {
        passwordGroup.classList.remove('hidden');
        note.textContent = 'The server needs the delete password to approve — enter it below and tap Approve again.';
        if (passwordInput) passwordInput.focus();
      } else {
        note.textContent = `Approve failed: ${api.lastError || 'unknown error'}.`;
      }
      finishEnabled();
      return;
    }
    note.textContent = 'Approved ✓ — this rule now governs future sessions.';
  } else {
    const data = await apiMutate(`/api/session-rules/${proposal.ruleId}/status`, 'PUT', { status: 'rejected' });
    if (!data) {
      note.textContent = `Reject failed: ${api.lastError || 'unknown error'}.`;
      finishEnabled();
      return;
    }
    note.textContent = 'Rejected — recorded, so this won’t be proposed again.';
  }
  // Decided: the row stays visible as a record but takes no further input.
  els.row.classList.add('wrap-proposal-row--decided');
}

/**
 * Surface a retry-time error inline in the drawer status banner.
 * Used when `apiMutate` returns `null` on retry (auth, server error,
 * dropped session) so the user gets a real explanation instead of a
 * frozen drawer (M3).
 *
 * @param {string} message - Human-readable error message.
 */
function renderWrapDrawerError(message) {
  // A retry can fail with the pipeline result still set, so Copy report is live in
  // this state — mirror the "Retry failed" banner so the report doesn't carry the
  // pre-failure header (the same divergence the release-resolution mirror closes).
  currentWrapDisplayedStatus = { label: 'Retry failed', tone: 'error', detail: message };
  const statusEl = document.getElementById('wrapDrawerStatus');
  statusEl.className = 'wrap-drawer-status wrap-drawer-status--error';
  statusEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = 'Retry failed';
  statusEl.appendChild(label);
  const detail = document.createElement('span');
  detail.className = 'wrap-drawer-status-detail';
  detail.textContent = message;
  statusEl.appendChild(detail);
}

/**
 * Collect decision-widget DOM into an options object and POST a retry.
 */
async function retryWrap() {
  const H = window.tcWrapDrawerHelpers;
  const decisionEl = document.getElementById('wrapDrawerDecision');
  const accessors = {
    skipTests: () => {
      const el = decisionEl.querySelector('input[data-options-key="skipTests"]');
      return el ? el.checked === true : false;
    },
    prHandling: () => {
      const selects = decisionEl.querySelectorAll('select.wrap-decision-prselect');
      if (selects.length === 0) return null;
      const out = {};
      for (const sel of selects) {
        if (sel.value) out[sel.dataset.prNumber] = sel.value;
      }
      return out;
    },
    skipAiContent: () => {
      // Returns the blocked step's id when its "Skip & note" box is ticked,
      // else null. #328 — collectOptionsFromAccessors wraps it into a map.
      const el = decisionEl.querySelector('input[data-options-key="skipAiContent"]');
      if (!el || el.checked !== true) return null;
      return el.dataset.stepId || null;
    },
    // #540 ask-mode — replay the modal's bump choice on each retry.
    bumpLevel: () => wrapBumpLevel
  };

  const options = H.collectOptionsFromAccessors(accessors);

  // #328: accumulate ai-content skips across retries. The pipeline re-runs
  // from step 0 each retry, so an earlier content step's skip must persist or
  // it would re-block. The merge lives in a pure drawer helper so it's unit-
  // testable; `wrapSkippedAiSteps` is the session-level accumulator.
  H.accumulateAiContentSkips(wrapSkippedAiSteps, options);

  // M1: replay the password collected at the initial wrap modal so a
  // delete-protected install can retry without re-prompting.
  const body = { options };
  if (currentWrapPassword) body.password = currentWrapPassword;

  const retryBtn = document.getElementById('wrapDrawerRetryBtn');
  retryBtn.disabled = true;
  // #583: freshness gate + password captured BEFORE any reattach path can
  // close the drawer (closeWrapDrawer clears currentWrapPassword).
  const retryStartedAt = Date.now();
  const retryPassword = currentWrapPassword;
  try {
    const data = await apiMutate(
      `/api/sessions/${encodeURIComponent(projectName)}/wrap`,
      'POST',
      body
    );
    if (data && data.pipelineResult) {
      // Re-render in place; password stays cached via openWrapDrawer's
      // typeof-string guard so undefined here won't clobber it.
      openWrapDrawer(data.pipelineResult);
    } else if (data) {
      // Server returned a V1-shaped response on retry — shouldn't happen
      // for the same project mid-wrap, but surface gracefully.
      closeWrapDrawer();
      sessionState.wrapping = true;
      showWrappingState();
      sessionState.pollInterval = 2000;
      startPolling();
    } else {
      // #583: the retry POST failing may mean the pipeline is still
      // running (this retry raced another trigger to a 409, or the
      // connection died mid-retry) — probe and reattach before rendering
      // a dead-end error.
      const lastErr = (typeof api !== 'undefined' && api.lastError) || 'Retry failed — see browser console.';
      const handled = await watchWrapRun(retryStartedAt, retryPassword);
      if (!handled) {
        // M3: genuine failure — surface api.lastError inline so the user
        // sees what went wrong (401/403/404/500/network). apiMutate is a
        // thin wrapper; the side-channel error lives on the underlying
        // api() function (api-helper.js:33-49).
        renderWrapDrawerError(lastErr);
      }
    }
  } finally {
    retryBtn.disabled = false;
  }
}

// ── Terminal Touch Scroll ──
// The shim lives in the shared api-helper.js (tcWireTerminalTouchScroll) and
// is wired from setupTerminal's readiness retry — the old load-time,
// .xterm-viewport-targeted, passive-listener version here was dead on iOS
// (touches land on .xterm-screen; native pan stole the gesture — #443).

// ── Wrapping State ──

/**
 * Show wrapping state UI — amber dot, disable action buttons, show wrapping bar.
 * Terminal stays visible so user can watch the wrap.
 */
function showWrappingState() {
  sessionState.wrapping = true;
  sessionState.wrapIdleModalShown = false;
  sessionState.wrapIdleCount = 0;

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
  document.getElementById('sessionWrapIdle').classList.remove('open');
}

/**
 * Undo `showWrappingState` for a wrap that finished BLOCKED (#583) — the
 * session is still alive, so the operator gets their action buttons back
 * and the wrapping bar goes away. No-op once the session has ended
 * (`handleSessionEnded`/`handleWrapCompleted` own that state and must not
 * have buttons re-enabled under them).
 */
function clearWrappingState() {
  if (sessionState.ended) return;
  sessionState.wrapping = false;

  const dot = document.getElementById('statusDot');
  dot.classList.remove('wrapping');
  dot.title = 'Active';

  document.getElementById('wrapBtn').disabled = false;
  document.getElementById('killBtn').disabled = false;
  document.getElementById('cmdBtn').disabled = false;
  document.getElementById('commandSend').disabled = false;

  document.getElementById('sessionWrapping').classList.add('hidden');
}

/**
 * True while a #583 wrap-run watch loop is polling. One loop at a time —
 * a second caller (e.g. init probe racing a confirm-time reattach) treats
 * the run as already handled instead of starting a duplicate poller.
 * @type {boolean}
 */
let wrapWatchInFlight = false;

/**
 * #583 — Reattach to a server-side wrap run this page can't see through
 * its own POST. The pipeline deliberately outlives its triggering
 * connection (a phone locking mid-wrap is normal operation), so a failed
 * wrap POST does NOT mean no wrap is running: it may have gotten 409
 * WRAP_IN_PROGRESS, or the connection died while the run carried on.
 *
 * Probes `GET /wrap/status` and follows `wrapWatchDecision`:
 *   - running → show the wrapping bar (the terminal stays visible — that
 *     IS the wrap happening) and poll until the run finishes, then render
 *     the drawer with its result exactly as the original POST would have.
 *   - finished fresh → straight to the drawer.
 *   - nothing to reattach to → return false; the caller shows its own error.
 *
 * A run that vanishes mid-watch without a fresh result means a server
 * restart killed it (the registry is process-local) — surfaced honestly
 * via the drawer error banner; a fresh wrap is safe at that point.
 *
 * @param {number} postStartedAtMs - Epoch ms when the caller's wrap POST
 *   went out; gates result freshness so a PREVIOUS wrap's retained
 *   outcome never renders as this one's.
 * @param {string} [password] - Password replayed on drawer retries (M1).
 * @returns {Promise<boolean>} true when the run was handled here.
 */
async function watchWrapRun(postStartedAtMs, password) {
  const H = window.tcWrapDrawerHelpers;
  if (wrapWatchInFlight) return true;
  // Claim synchronously, BEFORE the first await — two near-simultaneous
  // callers (init probe racing a confirm-time reattach) must not both pass
  // the guard during the probe (Critic note, chunk 583).
  wrapWatchInFlight = true;

  const statusUrl = `/api/sessions/${encodeURIComponent(projectName)}/wrap/status`;
  try {
    let status = await api(statusUrl);
    let decision = H.wrapWatchDecision(status, postStartedAtMs);
    if (decision === 'error') return false;

    // Whatever surface triggered this (modal or drawer retry), the watch
    // owns the screen now; both closes are idempotent.
    closeWrapModal(true);
    closeWrapDrawer();

    if (decision === 'watch') {
      showWrappingState();
      while (decision === 'watch') {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const next = await api(statusUrl);
        // A failed poll is a connection blip — the run outlives it; keep
        // watching. State stays server-driven, never wall-clock-bounded.
        if (!next) continue;
        status = next;
        decision = H.wrapWatchDecision(status, postStartedAtMs);
      }
      clearWrappingState();
    }

    if (decision === 'render' && status.result && status.result.pipelineResult) {
      openWrapDrawer(status.result.pipelineResult, typeof password === 'string' ? password : '');
    } else if (decision === 'render' && status.result) {
      // A fresh result WITHOUT a pipelineResult: the pipeline itself threw
      // before producing per-step results. Show the run's real error — not
      // the restart notice, which would misdiagnose it (Critic warning,
      // chunk 583). Nothing was committed (the commit step is last).
      openWrapDrawerNotice(
        'Wrap failed',
        status.result.error
          || 'The wrap failed before its pipeline produced a result. Nothing was committed; it is safe to start a new wrap.'
      );
    } else {
      // Ran, then vanished without a fresh result: a server restart killed
      // the pipeline mid-flight. Nothing was committed by it (the commit
      // step is last) — say so and leave the operator free to re-wrap.
      openWrapDrawerNotice(
        'Wrap did not survive a server restart',
        'The wrap pipeline was killed mid-run (most likely a server restart). Its commit step never ran, so nothing was committed. It is safe to start a new wrap.'
      );
    }
    return true;
  } finally {
    wrapWatchInFlight = false;
  }
}

/**
 * Cancel a ticking session-ended auto-redirect countdown (#583). The #268
 * rule is drawer-open ⇒ no auto-redirect; when the drawer opens after the
 * countdown already started (reattach race), the countdown must die rather
 * than navigate the report away mid-read. Idempotent.
 */
function cancelEndedCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  const countdownEl = document.getElementById('countdown');
  if (countdownEl) countdownEl.textContent = '';
}

/**
 * Open the wrap drawer as a plain notice (#583) — status banner + message,
 * no step list — for outcomes that have no pipeline result to render
 * (e.g. the watched run was killed by a server restart).
 *
 * @param {string} label - Banner headline.
 * @param {string} detail - Explanation the operator acts on.
 */
function openWrapDrawerNotice(label, detail) {
  sessionState.wrapDrawerOpen = true;
  cancelEndedCountdown();
  document.getElementById('wrapStepList').innerHTML = '';
  document.getElementById('wrapDrawerDecision').innerHTML = '';
  document.getElementById('wrapDrawerDecision').classList.add('hidden');
  document.getElementById('wrapDrawerRetryBtn').classList.add('hidden');
  document.getElementById('wrapDrawerDoneBtn').classList.remove('hidden');
  document.getElementById('wrapDrawerCancelBtn').textContent = 'Close';
  renderWrapDrawerError(detail);
  const statusEl = document.getElementById('wrapDrawerStatus');
  if (statusEl.firstChild) statusEl.firstChild.textContent = label;
  // renderWrapDrawerError mirrored a "Retry failed" label; this notice overrode it,
  // so keep the report mirror in step with the displayed label.
  currentWrapDisplayedStatus = { label, tone: 'error', detail };
  document.getElementById('wrapDrawerBackdrop').classList.add('open');
  document.getElementById('wrapDrawer').classList.add('open');
}

/**
 * Show the wrap-idle modal. Tmux stays alive — user must explicitly choose
 * to finalize ("Return to Projects"), dismiss ("Resume working"), or click
 * the backdrop. Sticky once shown — see #98.
 */
function showWrapIdleModal() {
  sessionState.wrapIdleModalShown = true;
  document.getElementById('sessionWrapIdle').classList.add('open');
  document.getElementById('wrapReturnBtn').disabled = false;
  document.getElementById('wrapResumeBtn').disabled = false;
}

/**
 * Dismiss the wrap-idle modal without finalizing. Resets the idle counter so
 * the modal can re-appear if the AI goes idle again for another threshold window.
 */
function resumeFromWrapIdle() {
  sessionState.wrapIdleModalShown = false;
  sessionState.wrapIdleCount = 0;
  document.getElementById('sessionWrapIdle').classList.remove('open');
}

/**
 * "Return to Projects" handler from the wrap-idle modal. Finalizes the wrap
 * (POST /wrap/complete kills tmux on the server), then transitions to the
 * ended state and navigates back to projects. Guarded against re-entry.
 * If the POST fails (network/server error), tmux is still alive — re-enable
 * the modal buttons so the user can retry instead of getting silently bounced.
 */
async function confirmReturnFromWrapIdle() {
  if (sessionState.wrapCompleting) return;
  sessionState.wrapCompleting = true;
  document.getElementById('wrapReturnBtn').disabled = true;
  document.getElementById('wrapResumeBtn').disabled = true;

  const data = await apiMutate(
    `/api/sessions/${encodeURIComponent(projectName)}/wrap/complete`,
    'POST',
    {}
  );

  if (!data) {
    // POST failed — tmux still alive, let the user retry or resume.
    sessionState.wrapCompleting = false;
    document.getElementById('wrapReturnBtn').disabled = false;
    document.getElementById('wrapResumeBtn').disabled = false;
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = api.lastError || 'Could not finalize wrap. Try again or click Resume working.';
      toast.className = 'toast toast-warn visible';
      setTimeout(() => { toast.classList.remove('visible'); }, 5000);
    }
    return;
  }

  handleWrapCompleted(data);
  // After finalizing, the user explicitly asked to return — navigate now.
  window.location.href = '/';
}

/**
 * Handle wrap completion — tmux is gone. Show ended bar with no auto-redirect;
 * user must click "Back to Projects" or "Stay" themselves.
 * @param {object} data - Status data with wrapCompleted flag
 */
function handleWrapCompleted(data) {
  sessionState.ended = true;
  sessionState.wrapping = false;
  sessionState.wrapCompleting = false;
  sessionState.wrapIdleModalShown = false;
  stopPolling();

  // Hide wrap-related bars
  document.getElementById('sessionWrapping').classList.add('hidden');
  document.getElementById('sessionWrapIdle').classList.remove('open');

  const dot = document.getElementById('statusDot');
  dot.classList.remove('wrapping');
  dot.classList.add('ended');
  dot.title = 'Session wrapped';

  // Disable action buttons
  document.getElementById('wrapBtn').disabled = true;
  document.getElementById('killBtn').disabled = true;
  document.getElementById('cmdBtn').disabled = true;
  document.getElementById('commandSend').disabled = true;

  // Show ended bar — no countdown for the wrap-completed path. The countdown
  // span is reused by handleSessionEnded (unexpected tmux death) only.
  const endedBar = document.getElementById('sessionEnded');
  endedBar.classList.remove('hidden');
  document.getElementById('countdown').textContent = '';
}

// ── Event Bindings ──

/**
 * Did a click originate inside an element matching `selector`?
 *
 * Reads the event's propagation path, which the DOM fixes at DISPATCH time —
 * deliberately NOT a live `e.target.closest(selector)` query, which is evaluated
 * when the handler runs and lies once an inner handler has re-rendered.
 *
 * #566: the loops panel's delegated handlers replace `panel.innerHTML`, which
 * orphans the clicked button before this document-level dismiss listener sees
 * the event. `closest()` on an orphan walks no ancestors and returns null, so
 * every in-panel click read as "outside" and the panel dismissed itself. Only
 * controls that happened to `await` an HTTP call first were safe (the await let
 * the event finish bubbling before the re-render) — the synchronous ones
 * (Send feedback, Transcript-collapse) broke. Reading the dispatch-time path
 * makes the verdict independent of what handlers do to the DOM afterwards.
 *
 * @param {Event} event - The click event.
 * @param {string} selector - CSS selector for the container to test against.
 * @returns {boolean} True when the click originated inside a matching element.
 */
function clickHitsSelector(event, selector) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
  if (path && path.length) {
    return path.some((node) => node && typeof node.matches === 'function' && node.matches(selector));
  }
  // Fallback for environments without composedPath: the live query, which is
  // correct whenever the target is still attached.
  const target = event.target;
  return !!(target && typeof target.closest === 'function' && target.closest(selector));
}

function bindEvents() {
  const $ = (id) => document.getElementById(id);

  // Close group popovers on outside click. Both predicates read the
  // dispatch-time path (#566) — a re-rendering inner handler must never be able
  // to make its own click look like an outside one.
  document.addEventListener('click', (e) => {
    if (!clickHitsSelector(e, '.group-pill')) {
      document.querySelectorAll('.group-popover.open').forEach(el => el.classList.remove('open'));
    }
    // MED-2K9P Chunk 02 — close the Medusa inbox/peers popovers on outside click.
    if (!clickHitsSelector(e, '.medusa-control')) {
      const panel = $('medusaPanel');
      if (panel) panel.hidden = true;
      hideMedusaPeers();
      closeMedusaLoopsPanel(); // v2 T4 — the loops panel dismisses the same way.
    }
  });

  // Medusa session-comms control (MED-2K9P Chunk 02): heads = toggle listener,
  // hover = recent-peers popover (desktop), badge = open inbox.
  const medusaHeads = $('medusaHeads');
  if (medusaHeads) {
    medusaHeads.addEventListener('click', toggleMedusa);
    medusaHeads.addEventListener('mouseenter', showMedusaPeers);
    medusaHeads.addEventListener('mouseleave', hideMedusaPeers);
  }
  const medusaBadge = $('medusaBadge');
  if (medusaBadge) medusaBadge.addEventListener('click', openMedusaInbox);
  // The inbox panel needs its own dismiss paths: the ✕ (delegated — the panel's
  // innerHTML is re-rendered on each open) and Escape. The badge self-hides on read,
  // so it cannot be relied on to close the panel it just opened.
  const medusaPanel = $('medusaPanel');
  if (medusaPanel) {
    medusaPanel.addEventListener('click', (e) => {
      if (e.target.closest('.medusa-panel-close')) closeMedusaInbox();
    });
  }
  // Loop launch (MED-2K9P v2 T3): the ➤ opens the setup modal (static markup —
  // direct wiring, no delegation needed); Launch/Cancel + Escape close paths.
  const medusaLoop = $('medusaLoop');
  if (medusaLoop) medusaLoop.addEventListener('click', openMedusaLoopModal);
  const medusaLoopLaunchBtn = $('medusaLoopLaunchBtn');
  if (medusaLoopLaunchBtn) medusaLoopLaunchBtn.addEventListener('click', launchMedusaLoop);
  const medusaLoopCancelBtn = $('medusaLoopCancelBtn');
  if (medusaLoopCancelBtn) medusaLoopCancelBtn.addEventListener('click', closeMedusaLoopModal);
  // MED-6V3R: the wall-clock guard means something different per mode, so the
  // preset + hint track the mode — unless the operator has typed their own value.
  const medusaLoopMode = $('medusaLoopMode');
  if (medusaLoopMode) medusaLoopMode.addEventListener('change', syncMedusaLoopGuardMode);
  const medusaLoopMaxMinutes = $('medusaLoopMaxMinutes');
  if (medusaLoopMaxMinutes) medusaLoopMaxMinutes.addEventListener('input', () => { medusaLoopMinutesDirty = true; });
  // Loop view (MED-2K9P v2 T4): the ⟳ chip opens the loops panel; its content
  // re-renders every poll, so all row controls are delegated.
  const medusaLoopsChip = $('medusaLoopsChip');
  if (medusaLoopsChip) medusaLoopsChip.addEventListener('click', openMedusaLoopsPanel);
  const medusaLoopsPanel = $('medusaLoopsPanel');
  if (medusaLoopsPanel) {
    medusaLoopsPanel.addEventListener('click', (e) => {
      if (e.target.closest('.medusa-panel-close')) { closeMedusaLoopsPanel(); return; }
      const forceBtn = e.target.closest('.medusa-force-done');
      if (forceBtn) { forceDoneMedusaLoop(forceBtn.dataset.loopId); return; }
      const closeoutBtn = e.target.closest('.medusa-loop-closeout');
      if (closeoutBtn) { closeoutMedusaLoop(closeoutBtn.dataset.loopId); return; }
      const continueBtn = e.target.closest('.medusa-loop-continue');
      if (continueBtn) {
        const id = continueBtn.dataset.loopId;
        if (medusaExpandedFeedback.has(id)) {
          medusaExpandedFeedback.delete(id);
          medusaFeedbackDrafts.delete(id); // closing the composer discards the draft
        } else {
          medusaExpandedFeedback.add(id);
        }
        renderMedusaLoopsPanel();
        return;
      }
      const sendBtn = e.target.closest('.medusa-loop-feedback-send');
      if (sendBtn) {
        const id = sendBtn.dataset.loopId;
        const ta = document.getElementById(`medusaFeedback-${id}`);
        continueMedusaLoop(id, ta ? ta.value : '');
        return;
      }
      const toggleBtn = e.target.closest('.medusa-loop-transcript-toggle');
      if (toggleBtn) {
        const id = toggleBtn.dataset.loopId;
        if (medusaExpandedTranscripts.has(id)) medusaExpandedTranscripts.delete(id);
        else medusaExpandedTranscripts.add(id);
        renderMedusaLoopsPanel();
      }
    });
    // Persist feedback drafts as they're typed (TC#561) so a poll re-render
    // re-seeds the textarea from the Map rather than losing in-progress text.
    medusaLoopsPanel.addEventListener('input', (e) => {
      const ta = e.target.closest('.medusa-loop-feedback-input');
      if (ta && ta.dataset.loopId) medusaFeedbackDrafts.set(ta.dataset.loopId, ta.value);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const panel = $('medusaPanel');
    if (panel && !panel.hidden) { closeMedusaInbox(); hideMedusaPeers(); }
    const loopModal = $('medusaLoopModal');
    if (loopModal && loopModal.classList.contains('open')) closeMedusaLoopModal();
    const loopsPanel = $('medusaLoopsPanel');
    if (loopsPanel && !loopsPanel.hidden) closeMedusaLoopsPanel();
    const catcher = $('pasteCatcher');
    if (catcher && catcher.classList.contains('open')) closePasteCatcher();
  });

  // Banner buttons
  $('selectBtn').addEventListener('click', toggleSelect);
  $('pasteBtn').addEventListener('click', pasteToTerminal);
  $('pasteCatcherInsert').addEventListener('click', insertFromPasteCatcher);
  $('pasteCatcherCancel').addEventListener('click', closePasteCatcher);
  $('pasteCatcher').addEventListener('click', (e) => {
    // Backdrop tap closes; e.currentTarget comparison is dispatch-time-safe
    // (no re-render races — the #566 composedPath hazard doesn't apply).
    if (e.target === e.currentTarget) closePasteCatcher();
  });
  $('uploadBtn').addEventListener('click', openUploadModal);
  $('cmdBtn').addEventListener('click', toggleCommandBar);
  $('peekBtn').addEventListener('click', openPeek);
  $('masterBtn').addEventListener('click', openMasterDrawer);
  $('masterCloseBtn').addEventListener('click', closeMasterDrawer);
  $('masterBackdrop').addEventListener('click', closeMasterDrawer);
  $('masterDrawerRetryBtn').addEventListener('click', ensureMasterDrawerAttached);
  $('settingsBtn').addEventListener('click', openSettings);
  $('wrapBtn').addEventListener('click', openWrapModal);
  $('killBtn').addEventListener('click', openKillModal);

  // Stay button — cancel the auto-redirect countdown set by handleSessionEnded
  // (unexpected tmux death). The wrap-completed path doesn't start a countdown
  // anymore, so clicking Stay there is a no-op except for disabling the button.
  $('stayBtn').addEventListener('click', () => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    $('countdown').textContent = 'Staying';
    $('stayBtn').disabled = true;
  });

  // Wrap-idle modal buttons + backdrop click
  $('wrapReturnBtn').addEventListener('click', confirmReturnFromWrapIdle);
  $('wrapResumeBtn').addEventListener('click', resumeFromWrapIdle);
  $('sessionWrapIdle').addEventListener('click', (e) => {
    // Don't dismiss while a Return-to-Projects POST is in flight (Critic NIT).
    // Either the POST will succeed (modal hidden via handleWrapCompleted) or
    // fail (toast surfaced via confirmReturnFromWrapIdle's error path), and
    // the modal stays put either way until that resolves.
    if (sessionState.wrapCompleting) return;
    if (e.target === e.currentTarget) resumeFromWrapIdle();
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

  // Wrap pipeline drawer (#139 Chunk 10)
  $('wrapDrawerCloseBtn').addEventListener('click', closeWrapDrawer);
  $('wrapDrawerCopyBtn').addEventListener('click', copyWrapReport);
  $('wrapDrawerCancelBtn').addEventListener('click', closeWrapDrawer);
  $('wrapDrawerDoneBtn').addEventListener('click', closeWrapDrawer);
  $('wrapDrawerRetryBtn').addEventListener('click', retryWrap);
  $('wrapDrawerBackdrop').addEventListener('click', closeWrapDrawer);

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
  }

  // Load shared docs for settings
  loadSharedDocs();

  // Render command pills (skip for webui — no command injection)
  if (!isWebui) {
    renderCommandPills();
  }

  // #402: touch devices get the explicit Paste affordance (tmux sessions
  // only — webui sessions have no xterm instance to paste into). Desktop
  // keeps Cmd-V and a clean banner.
  if (!isWebui && 'ontouchstart' in window) {
    document.getElementById('pasteBtn').hidden = false;
  }

  // Update chime indicator
  updateChimeIndicator();

  // Start polling if session is active
  if (!sessionState.ended) {
    startPolling();
  }

  // #583: a wrap pipeline may be running server-side from a previous page
  // load (its POST died with that page). Reattach so the run is visible
  // and its result lands in the drawer, instead of the operator re-wrapping
  // blind. Only a RUNNING run reattaches on load — a finished one belongs
  // to whichever page triggered it. Deliberately not awaited: init must
  // not block on a multi-minute wrap.
  if (!sessionState.ended) {
    api(`/api/sessions/${encodeURIComponent(projectName)}/wrap/status`).then((wrapStatus) => {
      if (wrapStatus && wrapStatus.running === true) {
        watchWrapRun(Date.now(), '');
      }
    });
  }

  // Poll model status every 2 minutes (setTimeout chain to avoid burst storms)
  (function modelStatusLoop() {
    setTimeout(() => {
      loadModelStatus();
      modelStatusLoop();
    }, 120000);
  })();

  // Initial mouse state — tmux only. First repair any override a previous
  // visit stranded by dying mid-select (UI-8W3D); the repair's POST response
  // already carries the fresh state, so the plain GET only runs otherwise.
  if (!isWebui) {
    const repaired = await repairAbandonedSelect();
    if (!repaired) {
      const mouseData = await api(`/api/tmux/mouse/${encodeURIComponent(projectName)}`);
      if (mouseData) {
        sessionState.mouseOn = mouseData.mouse;
        sessionState.mouseExplicit = !!mouseData.explicit;
      }
    }
  }
}

initSession();
