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
  launchGraceRemaining: 0,
  wrapCompleting: false,
  wrapDrawerOpen: false
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

  // #139 Chunk 11b \u2014 methodology-declared action buttons (e.g. prawduct's
  // "Run Critic"). Hidden when the methodology has no actions[].
  renderMethodologyActions(data.methodology ? data.methodology.actions || [] : []);
}

/**
 * Render methodology-declared action buttons in the banner.
 * Server validates the command against the methodology's `actions[]`,
 * so we can safely POST whatever the user clicks.
 * @param {Array<{label: string, command: string, confirm: boolean}>} actions
 */
function renderMethodologyActions(actions) {
  const container = document.getElementById('methodologyActions');
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(actions) || actions.length === 0) return;

  for (const action of actions) {
    if (!action || typeof action.label !== 'string' || typeof action.command !== 'string') continue;
    const btn = document.createElement('button');
    btn.className = 'banner-btn methodology-action-btn';
    btn.textContent = action.label;
    btn.setAttribute('data-command', action.command);
    btn.setAttribute('aria-label', `${action.label} (methodology action)`);
    btn.addEventListener('click', () => invokeMethodologyAction(action));
    container.appendChild(btn);
  }
}

/**
 * Invoke a methodology action via the server. Shows a brief feedback
 * toast in the banner status area on success/failure.
 *
 * Per-action wording overrides (#230): the methodology template may
 * supply `confirmMessage` and `successToast` strings on an action
 * declaration. When present they replace the generic
 * `Run "<label>" for this project?` / `<label>: recorded` defaults.
 * The Critic-style "this button records, doesn't run" contract is
 * misread by operators when the generic wording stands alone, so
 * template authors can clarify the contract at the surface.
 *
 * @param {{label: string, command: string, confirm: boolean, confirmMessage?: string, successToast?: string}} action
 */
async function invokeMethodologyAction(action) {
  if (action.confirm) {
    const confirmMessage = (typeof action.confirmMessage === 'string' && action.confirmMessage.length > 0)
      ? action.confirmMessage
      : `Run "${action.label}" for this project?`;
    const yes = window.confirm(confirmMessage);
    if (!yes) return;
  }
  // `CSS.escape` defends against methodology-template-supplied command
  // strings that contain selector-syntax characters. Today every
  // shipped template uses `[a-z-]+` only, so this is belt-and-suspenders.
  const selectorCommand = (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS.escape(action.command)
    : action.command.replace(/["\\]/g, '\\$&');
  const btn = document.querySelector(`.methodology-action-btn[data-command="${selectorCommand}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = `${action.label}\u2026`;
  }
  // #267 (Critic finding on PR #269): methodology-action POSTs can be
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
        showMethodologyActionToast(`${action.label}: timed out after ${Math.round(ACTION_TIMEOUT_MS / 1000)}s`, true);
        return;
      }
      showMethodologyActionToast(`${action.label}: ${err && err.message ? err.message : 'request failed'}`, true);
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
        showMethodologyActionToast(successToast);
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
        showMethodologyActionToast(successToast);
      }
    } else {
      // `api.lastError` is a string set by `apiMutate` on !res.ok (see
      // public/api-helper.js). Earlier draft accessed `.message` which
      // is undefined on a string and silently hid the real server error.
      const msg = (result && result.error) || api.lastError || 'failed';
      showMethodologyActionToast(`${action.label}: ${msg}`, true);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = action.label;
    }
  }
}

/**
 * Brief banner-anchored toast for methodology-action feedback. Hides
 * after 3.5s. Uses inline DOM rather than a global toast system to keep
 * the surface area of this chunk small.
 * @param {string} message
 * @param {boolean} [isError]
 */
function showMethodologyActionToast(message, isError) {
  let toast = document.getElementById('methodologyActionToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'methodologyActionToast';
    toast.className = 'methodology-action-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.toggle('methodology-action-toast--error', !!isError);
  toast.classList.add('methodology-action-toast--visible');
  clearTimeout(showMethodologyActionToast._timer);
  showMethodologyActionToast._timer = setTimeout(() => {
    toast.classList.remove('methodology-action-toast--visible');
  }, 3500);
}

/**
 * Render structured findings from a methodology action (e.g.
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
 *
 * V1 path (legacy NL-prompt-via-tmux wrap, `wrapV2:false`) returns no
 * `pipelineResult`; the modal closes and the existing polling loop
 * waits for tmux to settle. V2 path returns `pipelineResult` carrying
 * the runner's per-step results — the multi-step drawer takes over
 * (#139 Chunk 10).
 */
async function confirmWrap() {
  // Fresh wrap — drop any ai-content skips accumulated by a prior wrap's
  // retries (#328) so they don't leak into this run.
  wrapSkippedAiSteps = {};
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
  currentWrapPassword = '';
  currentWrapPipelineResult = null;
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
  const text = window.tcWrapDrawerHelpers.buildReportText(currentWrapPipelineResult);
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
 * Render the drawer body from a pipeline result. Pure DOM mutation;
 * all shape-to-view-model decisions live in `tcWrapDrawerHelpers`.
 *
 * @param {object} pipelineResult
 */
function renderWrapDrawer(pipelineResult) {
  const H = window.tcWrapDrawerHelpers;
  const status = H.summarizePipelineStatus(pipelineResult);

  // Status banner
  const statusEl = document.getElementById('wrapDrawerStatus');
  statusEl.className = `wrap-drawer-status wrap-drawer-status--${status.tone}`;
  statusEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = status.label;
  statusEl.appendChild(label);
  if (status.detail) {
    const detail = document.createElement('span');
    detail.className = 'wrap-drawer-status-detail';
    detail.textContent = status.detail;
    statusEl.appendChild(detail);
  }

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
  // that surfaced a non-blocking warning (e.g. critic-check) OR a
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
      // Blocker takes precedence over any later warning widgets — the
      // user must address it before anything else matters.
      break;
    }
    if (row.warning) {
      const widget = H.warningWidgetForStep(row);
      if (widget) {
        decisionEl.appendChild(renderDecisionWidget(widget));
        widgetRendered = true;
        warningOnly = true;
      }
    }
    if (row.kind === 'pr-check') {
      // pr-check produces a resolution widget when there are
      // unresolved session-scoped PRs regardless of warning state —
      // ok:true with sessionScoped > 0 still wants resolution.
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
 *   `warningWidgetForStep`.
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

  const label = document.createElement('label');
  label.className = 'wrap-decision-label';
  label.textContent = `Resolve ${widget.prs.length} open PR${widget.prs.length === 1 ? '' : 's'} on this branch:`;
  wrap.appendChild(label);

  const list = document.createElement('div');
  list.className = 'wrap-decision-prlist';
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
    titleEl.textContent = `#${pr.number} ${pr.title}`;
    titleEl.title = pr.url || '';

    const sel = document.createElement('select');
    sel.className = 'wrap-decision-prselect';
    sel.dataset.prNumber = String(pr.number);
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

  const label = document.createElement('label');
  label.className = 'wrap-decision-label';
  label.textContent = `Multiple in-progress plans — pick the active one to roll (${widget.candidates.length}):`;
  wrap.appendChild(label);

  const sel = document.createElement('select');
  sel.className = 'wrap-decision-planselect';
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
  wrap.appendChild(btn);

  const note = document.createElement('p');
  note.className = 'wrap-decision-note';
  note.textContent = 'Persists this project’s active plan; the next wrap rolls its pointer. No re-run — click Done to close.';
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
 * Surface a retry-time error inline in the drawer status banner.
 * Used when `apiMutate` returns `null` on retry (auth, server error,
 * dropped session) so the user gets a real explanation instead of a
 * frozen drawer (M3).
 *
 * @param {string} message - Human-readable error message.
 */
function renderWrapDrawerError(message) {
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
    criticSkipRationale: () => {
      const el = decisionEl.querySelector('textarea[data-options-key="criticSkipRationale"]');
      return el ? el.value : '';
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
    }
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
      // M3: apiMutate returned null — surface api.lastError inline so
      // the user sees what went wrong (401/403/404/500/network).
      // apiMutate is a thin wrapper; the side-channel error lives on
      // the underlying api() function (api-helper.js:33-49).
      const lastErr = (typeof api !== 'undefined' && api.lastError) || 'Retry failed — see browser console.';
      renderWrapDrawerError(lastErr);
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
