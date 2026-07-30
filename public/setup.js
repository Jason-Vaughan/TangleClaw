'use strict';
/* ── TangleClaw v3 — First-Run Setup Wizard ── */
/* Full-screen overlay that guides new users through initial configuration. */
/* Loaded after landing.js and ui.js. Only activates when setupComplete === false. */

// ── Wizard State ──

const wizard = {
  step: 0,
  totalSteps: 7,
  projectsDir: '',
  scannedProjects: [],
  selectedProjects: new Set(),
  engines: [],
  defaultEngine: '',
  deletePassword: '',
  chimeEnabled: true,
  httpsCheckLoaded: false,
  httpsMode: null,
  mkcertAvailable: null,
  mkcertCaroot: '',
  mkcertCaInstalled: false,
  httpsGenerated: null,
  httpsCertPath: '',
  httpsKeyPath: '',
  httpsRemoteTrustConfirmed: false,
  // The admin-login step. Shown whenever this machine can actually have a login
  // put in front of it — which is the default, not a special mode.
  adminUser: '',
  adminPassword: '',
  adminPasswordConfirm: '',
  // Server's answer to "what may we do about a login here" (GET
  // /api/setup/ingress-state → `plan`). Null until the probe returns; the wizard
  // never derives this itself, because a second copy of the decision could drift
  // from the server's and collect a credential nothing will enforce.
  ingressPlan: null,
  ingressPlanError: null,
  // Outcome of provisioning, once setup has been submitted.
  provision: null,
  // Which screen owns the wizard body: the step flow, or one of the terminal
  // screens setup ends on. Modelled explicitly because three things re-render
  // asynchronously (the ingress probe, the provisioning poll, and step
  // navigation) and without it the last one to resolve wins — a probe that
  // returned late could repaint a live "no login is in force" screen with a
  // wizard step while the poll kept writing into a body it no longer owned.
  view: 'steps'
};

/**
 * Whether the wizard must collect an admin credential on this machine — true
 * exactly when the server said it can provision a login gate.
 *
 * Null plan (probe not back, or failed) deliberately reads as "no" rather than
 * "yes": collecting a password before knowing anything can enforce it is the one
 * outcome worse than not collecting one. If the server then refuses completion,
 * `wizardComplete` re-probes and routes back here rather than dead-ending.
 * @returns {boolean}
 */
function _adminStepRequired() {
  return !!(wizard.ingressPlan && wizard.ingressPlan.action === 'provision');
}

/**
 * The ordered list of active wizard step keys. The admin-login step is present
 * when this machine can run a login gate — TangleClaw asks for one by default
 * and only skips the step when it would be collecting a credential it cannot
 * put into force (an existing hand-rolled login it will adopt instead, a config
 * it must not overwrite, or no Caddy to run one).
 * @returns {string[]}
 */
function wizardStepKeys() {
  const keys = ['welcome', 'projectsDir', 'detect', 'engines', 'preferences', 'https'];
  if (_adminStepRequired()) keys.push('admin');
  keys.push('confirm');
  return keys;
}

/**
 * Ask the server what may be done about a login on this machine, and re-render
 * so the step list reflects the answer. Fire-and-forget from `showWizard`: the
 * admin step sits late in the flow, so the answer lands well before it is
 * reached. Failure is recorded rather than guessed at.
 * @returns {Promise<void>}
 */
async function loadIngressPlan() {
  try {
    const res = await fetch('/api/setup/ingress-state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    wizard.ingressPlan = (data && data.plan) || null;
    wizard.ingressPlanError = null;
  } catch (err) {
    wizard.ingressPlan = null;
    wizard.ingressPlanError = (err && err.message) || 'probe failed';
  }
  _syncSkipButton();
  renderWizardStep();
}

/**
 * Show Skip only once the server has said a credential is NOT mandatory here.
 *
 * Fail closed on an unknown plan, which is not the same as "not required": the
 * probe is unawaited, so there is a window at startup where nothing is known yet,
 * and a failed probe leaves it unknown forever. Offering Skip in that window
 * offers a way past the login gate on exactly the machines where the answer has
 * not arrived. Both server routes that can finish setup refuse it anyway, so a
 * visible Skip there could only produce an error the operator cannot act on.
 */
function _syncSkipButton() {
  const skipBtn = document.getElementById('setupSkipBtn');
  if (!skipBtn) return;
  const known = !!wizard.ingressPlan;
  skipBtn.style.display = (known && !_adminStepRequired()) ? '' : 'none';
}

// ── Wizard Lifecycle ──

/**
 * Check if wizard should be shown and initialize it.
 * Called from landing.js init() after config is loaded.
 */
function checkSetupWizard() {
  if (!state.config || state.config.setupComplete !== false) return false;
  showWizard();
  return true;
}

/**
 * Show the wizard overlay.
 */
function showWizard() {
  wizard.projectsDir = state.config ? state.config.projectsDir || '~/Documents/Projects' : '~/Documents/Projects';
  wizard.engines = state.engines || [];
  // Seed from config, but never carry in a default this machine can't run — the
  // shipped config default is 'claude', which on a Codex-only machine had the
  // wizard pre-selecting an engine its own availability list showed as missing.
  // renderEngines re-checks on every render; this keeps the confirm summary and
  // an early Skip honest too.
  const seededEngine = state.config ? state.config.defaultEngine : null;
  const seedList = state.engines && state.engines.length > 0 ? state.engines : wizard.engines;
  wizard.defaultEngine = (seedList || []).some((e) => e && e.available && e.id === seededEngine)
    ? seededEngine
    : _firstAvailableEngineId(seedList);
  wizard.chimeEnabled = state.config ? state.config.chimeEnabled !== false : true;
  wizard.step = 0;
  wizard.provision = null;
  wizard.view = 'steps';

  _syncSkipButton();
  // Ask what this machine can do about a login. Deliberately not awaited: the
  // welcome step must render immediately, and the answer is needed several steps
  // later.
  loadIngressPlan();

  const overlay = document.getElementById('setupOverlay');
  overlay.classList.add('open');
  document.body.classList.add('setup-active');
  renderWizardStep();
}

/**
 * Dismiss the wizard overlay and initialize the landing page.
 */
function dismissWizard() {
  const overlay = document.getElementById('setupOverlay');
  overlay.classList.remove('open');
  document.body.classList.remove('setup-active');

  // Start the normal landing page lifecycle
  loadProjects().then(() => {
    Promise.all([loadStats(), loadPorts()]);
    maybeShowFilter();
    if (typeof startPolling === 'function') startPolling();
  });
}

// ── Step Navigation ──

function wizardNext() {
  if (wizard.step === 1) {
    // Save projectsDir before moving on
    const input = document.getElementById('setupProjectsDir');
    if (input) wizard.projectsDir = input.value.trim();
  }
  if (wizard.step === 3) {
    // Save engine selection
    const sel = document.getElementById('setupDefaultEngine');
    if (sel) wizard.defaultEngine = sel.value;
  }
  if (wizard.step === 4) {
    // Save preferences
    const pwInput = document.getElementById('setupDeletePassword');
    if (pwInput) wizard.deletePassword = pwInput.value;
    const chimeCheck = document.getElementById('setupChimeEnabled');
    if (chimeCheck) wizard.chimeEnabled = chimeCheck.checked;
  }

  wizard.step++;
  const maxStep = wizardStepKeys().length - 1;
  if (wizard.step > maxStep) {
    wizard.step = maxStep;
  }
  renderWizardStep();
}

function wizardBack() {
  if (wizard.step > 0) {
    wizard.step--;
    renderWizardStep();
  }
}

async function wizardSkip() {
  // Set setupComplete without changing other config
  await apiMutate('/api/config', 'PATCH', { setupComplete: true });
  if (state.config) state.config.setupComplete = true;
  dismissWizard();
}

// ── Step Rendering ──

function renderWizardStep() {
  // The step flow is only one of the things that can own the body. Once setup has
  // been submitted, a terminal screen owns it and must not be painted over — the
  // probe and the outcome poll both re-render asynchronously, and whichever
  // resolved last would otherwise win.
  if (wizard.view !== 'steps') return;

  const body = document.getElementById('setupBody');
  const keys = wizardStepKeys();
  wizard.totalSteps = keys.length;

  // The step list changes length at runtime (the admin step appears once the
  // server's plan arrives, and would disappear again if a re-probe failed), so an
  // integer index into it can be left pointing past the end. Clamp before use:
  // an out-of-range index used to match no case in the switch below and leave the
  // previous screen in place, which read as a Confirm step that re-submitted into
  // the same refusal forever.
  if (wizard.step > keys.length - 1) wizard.step = keys.length - 1;
  if (wizard.step < 0) wizard.step = 0;
  _renderStepDots(keys.length);

  switch (keys[wizard.step]) {
    case 'welcome': renderWelcome(body); break;
    case 'projectsDir': renderProjectsDir(body); break;
    case 'detect': renderDetectProjects(body); break;
    case 'engines': renderEngines(body); break;
    case 'preferences': renderPreferences(body); break;
    case 'https': renderHttpsSetup(body); break;
    case 'admin': renderAdminSetup(body); break;
    case 'confirm': renderConfirm(body); break;
    default:
      // Unreachable after the clamp above. Rendering the first step is the safe
      // answer if it ever is reached — a blank body with working dots is the one
      // outcome the operator cannot act on.
      wizard.step = 0;
      renderWelcome(body);
      break;
  }
}

/**
 * Rebuild the step-dot row for the active step count and mark active/done. The
 * count varies (the admin step adds an 8th dot in caddy mode), so the dots are
 * generated rather than toggled over a fixed set.
 * @param {number} count - Number of active steps.
 */
function _renderStepDots(count) {
  const row = document.getElementById('setupSteps');
  if (!row) return;
  let html = '';
  for (let i = 0; i < count; i++) {
    const cls = 'step-dot' + (i === wizard.step ? ' active' : i < wizard.step ? ' done' : '');
    html += `<div class="${cls}"></div>`;
  }
  row.innerHTML = html;
}

function renderWelcome(body) {
  body.innerHTML = `
    <div class="setup-step">
      <div class="setup-icon">
        <svg viewBox="0 0 96 96" width="80" height="80" aria-hidden="true">
          <circle cx="48" cy="48" r="44" fill="none" stroke="#8BC34A" stroke-width="2"/>
          <path d="M30 60 Q38 28 48 36 Q58 44 52 56 Q46 68 58 62 Q70 56 66 44 Q62 32 48 28"
                fill="none" stroke="#8BC34A" stroke-width="3" stroke-linecap="round"/>
          <circle cx="42" cy="34" r="2.5" fill="#8BC34A"/>
        </svg>
      </div>
      <h2 class="setup-heading">Welcome to TangleClaw</h2>
      <p class="setup-text">AI Development Orchestration Platform</p>
      <p class="setup-text-muted">This wizard will help you configure your projects directory, detect existing projects, select your default AI engine, and set your preferences.</p>
      <p class="setup-text-muted">It only takes a minute. You can skip at any time.</p>
      <button class="btn btn-primary setup-btn" onclick="wizardNext()">Get Started</button>
    </div>`;
}

function renderProjectsDir(body) {
  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">Projects Directory</h2>
      <p class="setup-text-muted">Where do your projects live? TangleClaw will scan this directory for existing projects and create new ones here.</p>
      <div class="form-group">
        <label class="form-label" for="setupProjectsDir">Projects Root</label>
        <input type="text" class="form-input" id="setupProjectsDir"
               value="${esc(wizard.projectsDir)}"
               placeholder="~/Documents/Projects"
               autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        <div class="form-hint">Full path or ~ for home directory</div>
        <div id="setupDirError" class="form-error hidden" role="alert"></div>
      </div>
      <div class="setup-nav">
        <button class="btn" onclick="wizardBack()">Back</button>
        <button class="btn btn-primary" onclick="wizardValidateDir()">Next</button>
      </div>
    </div>`;
  setTimeout(() => {
    const el = document.getElementById('setupProjectsDir');
    if (el) el.focus();
  }, 100);
}

/**
 * Validate the projects directory by asking the server to scan it.
 */
async function wizardValidateDir() {
  const input = document.getElementById('setupProjectsDir');
  const dir = input.value.trim();
  if (!dir) {
    const err = document.getElementById('setupDirError');
    err.textContent = 'Please enter a directory path.';
    err.classList.remove('hidden');
    return;
  }

  wizard.projectsDir = dir;

  // Validate by scanning (also prepares project list for next step)
  const data = await apiMutate('/api/setup/scan', 'POST', { directory: dir });
  if (!data) {
    const err = document.getElementById('setupDirError');
    err.textContent = 'Directory not found or not accessible.';
    err.classList.remove('hidden');
    return;
  }

  wizard.scannedProjects = data.projects || [];
  wizard.selectedProjects = new Set(wizard.scannedProjects.filter(p => p.detected).map(p => p.name));
  wizardNext();
}

function renderDetectProjects(body) {
  const allDirs = wizard.scannedProjects;
  const detected = allDirs.filter(p => p.detected);
  const other = allDirs.filter(p => !p.detected);

  if (allDirs.length === 0) {
    body.innerHTML = `
      <div class="setup-step">
        <h2 class="setup-heading">Detect Projects</h2>
        <p class="setup-text-muted">No directories found in <strong>${esc(wizard.projectsDir)}</strong>.</p>
        <p class="setup-text-muted">That's fine — you can create projects after setup.</p>
        <div class="setup-nav">
          <button class="btn" onclick="wizardBack()">Back</button>
          <button class="btn btn-primary" onclick="wizardNext()">Next</button>
        </div>
      </div>`;
    return;
  }

  /**
   * Build a checkbox list HTML for an array of scanned projects.
   * @param {object[]} items - Scanned project entries
   * @returns {string} HTML string
   */
  function buildProjectList(items) {
    let html = '';
    for (const p of items) {
      const checked = wizard.selectedProjects.has(p.name) ? 'checked' : '';
      const gitLabel = p.git ? `${p.git.branch}${p.git.dirty ? ' (dirty)' : ''}` : '';

      html += `
        <label class="setup-project-item">
          <input type="checkbox" ${checked}
                 onchange="wizardToggleProject('${esc(p.name)}', this.checked)">
          <div class="setup-project-info">
            <span class="setup-project-name">${esc(p.name)}</span>
            <span class="setup-project-meta">${esc(gitLabel)}</span>
          </div>
        </label>`;
    }
    return html;
  }

  let listHtml = '';

  if (detected.length > 0) {
    listHtml += `<div class="setup-project-list">${buildProjectList(detected)}</div>`;
  }

  if (other.length > 0) {
    const detectedNote = detected.length > 0
      ? 'These directories don\'t have recognized project markers but can still be attached:'
      : 'No projects with recognized markers were found, but you can attach any directory:';
    listHtml += `
      <details class="setup-other-dirs">
        <summary class="setup-other-dirs-summary">Other directories (${other.length})</summary>
        <p class="setup-text-muted" style="margin:4px 0 8px">${detectedNote}</p>
        <div class="setup-project-list">${buildProjectList(other)}</div>
      </details>`;
  }

  const detectedCount = detected.length;
  const totalCount = allDirs.length;
  const summary = detectedCount > 0
    ? `Found ${detectedCount} project${detectedCount !== 1 ? 's' : ''} in <strong>${esc(wizard.projectsDir)}</strong>. Select which to attach:`
    : `Found ${totalCount} director${totalCount !== 1 ? 'ies' : 'y'} in <strong>${esc(wizard.projectsDir)}</strong>:`;

  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">Detect Projects</h2>
      <p class="setup-text-muted">${summary}</p>
      ${listHtml}
      <div class="setup-nav">
        <button class="btn" onclick="wizardBack()">Back</button>
        <button class="btn btn-primary" onclick="wizardNext()">Next</button>
      </div>
    </div>`;
}

function wizardToggleProject(name, checked) {
  if (checked) {
    wizard.selectedProjects.add(name);
  } else {
    wizard.selectedProjects.delete(name);
  }
}

/**
 * First installed engine id from a wizard engine list, or null when none is.
 * The dropdown must never pre-select an engine this machine doesn't have — the
 * availability list directly above it would be contradicting itself, and the
 * choice surfaces much later as a launch failure.
 * @param {object[]} list - Engines with `id` and `available`.
 * @returns {string|null}
 */
function _firstAvailableEngineId(list) {
  const found = (list || []).find((e) => e && e.available);
  return found ? found.id : null;
}

function renderEngines(body) {
  const enginesList = state.engines.length > 0 ? state.engines : wizard.engines;
  const firstAvailable = _firstAvailableEngineId(enginesList);

  // A default carried in from config (or the shipped 'claude') is only honored
  // when it is actually installed; otherwise fall to the first installed engine,
  // and to nothing at all when the machine has none.
  const selectable = enginesList.filter((e) => e && e.available);
  const currentIsAvailable = selectable.some((e) => e.id === wizard.defaultEngine);
  if (!currentIsAvailable) wizard.defaultEngine = firstAvailable;

  let optionsHtml = '';
  let listHtml = '';
  for (const e of enginesList) {
    // Unavailable engines stay listed — an operator who installs one later
    // shouldn't have to hunt for it — but labelled, and disabled so the value
    // cannot be chosen. `disabled` is the browser-native refusal; the resolver
    // server-side is the backstop.
    const selected = e.id === wizard.defaultEngine ? ' selected' : '';
    const disabled = e.available ? '' : ' disabled';
    // `name` is not validated when an engine profile is saved (only `id` is),
    // and `esc` returns '' for a non-string — so a hand-added profile without a
    // usable name would render a blank, unidentifiable option.
    const engineName = typeof e.name === 'string' && e.name ? e.name : e.id;
    const label = e.available ? esc(engineName) : `${esc(engineName)} (not installed)`;
    optionsHtml += `<option value="${esc(e.id)}"${selected}${disabled}>${label}</option>`;

    const availClass = e.available ? 'setup-engine-available' : 'setup-engine-unavailable';
    const availIcon = e.available ? '&#10003;' : '&#10007;';
    listHtml += `
      <div class="setup-engine-item">
        <span class="${availClass}">${availIcon}</span>
        <span class="setup-engine-name">${esc(engineName)}</span>
        <span class="setup-engine-status">${e.available ? 'Detected' : 'Not found'}</span>
      </div>`;
  }

  // Nothing installed: say so plainly instead of offering a picker whose every
  // option is refused. TangleClaw is still usable — projects can be attached
  // once an engine exists — so this warns rather than blocks.
  const noneAvailable = selectable.length === 0;
  const pickerHtml = noneAvailable
    ? `<div class="setup-https-panel setup-https-warning">
        <div class="setup-https-warn-icon" aria-hidden="true">!</div>
        <div>
          <div class="setup-https-warn-title">No AI engine detected on this machine.</div>
          <p class="setup-text-muted">TangleClaw drives an engine's CLI, so sessions can't launch until one is installed. Install Claude Code, Codex, Antigravity, or Aider, then pick a default from Settings — the rest of setup still applies.</p>
        </div>
      </div>`
    : `<div class="form-group">
        <label class="form-label" for="setupDefaultEngine">Default Engine</label>
        <select class="form-select" id="setupDefaultEngine">${optionsHtml}</select>
        <div class="form-hint">Used for new projects unless overridden. Only installed engines can be selected.</div>
      </div>`;

  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">AI Engines</h2>
      <p class="setup-text-muted">TangleClaw supports multiple AI coding engines. Here's what's available on your system:</p>
      <div class="setup-engine-list">${listHtml}</div>
      ${pickerHtml}
      <div class="setup-nav">
        <button class="btn" onclick="wizardBack()">Back</button>
        <button class="btn btn-primary" onclick="wizardNext()">Next</button>
      </div>
    </div>`;
}

function renderPreferences(body) {
  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">Preferences</h2>
      <div class="form-group">
        <label class="form-label" for="setupDeletePassword">Delete Protection Password</label>
        <input type="password" class="form-input" id="setupDeletePassword"
               value="${esc(wizard.deletePassword)}"
               placeholder="Optional" autocomplete="new-password">
        <div class="form-hint">Required before deleting projects or killing sessions. Leave empty for no protection.</div>
      </div>
      <div class="form-group">
        <label class="setup-toggle-label">
          <span>Idle chime notifications</span>
          <input type="checkbox" id="setupChimeEnabled" ${wizard.chimeEnabled ? 'checked' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <div class="form-hint">Play a sound when an AI engine finishes thinking</div>
      </div>
      <div class="setup-nav">
        <button class="btn" onclick="wizardBack()">Back</button>
        <button class="btn btn-primary" onclick="wizardNext()">Next</button>
      </div>
    </div>`;
}

async function renderHttpsSetup(body) {
  if (!wizard.httpsCheckLoaded) {
    body.innerHTML = `
      <div class="setup-step">
        <h2 class="setup-heading">Secure Access</h2>
        <p class="setup-text-muted">Checking your system for certificate tools…</p>
        <div class="setup-https-loading"><span class="spinner"></span></div>
      </div>`;
    const data = await apiMutate('/api/setup/https-check', 'GET');
    if (data && data.mkcert) {
      wizard.mkcertAvailable = !!data.mkcert.available;
      wizard.mkcertCaroot = data.mkcert.carootPath || '';
      wizard.mkcertCaInstalled = !!data.mkcert.caInstalled;
    } else {
      wizard.mkcertAvailable = false;
    }
    if (!wizard.httpsMode) {
      wizard.httpsMode = wizard.mkcertAvailable ? 'mkcert' : 'manual';
    }
    wizard.httpsCheckLoaded = true;
    renderHttpsSetup(body);
    return;
  }

  const available = !!wizard.mkcertAvailable;
  const mode = wizard.httpsMode;
  const statusBadge = available
    ? '<span class="setup-https-badge setup-https-badge-ok">mkcert detected</span>'
    : '<span class="setup-https-badge setup-https-badge-warn">mkcert not installed</span>';

  const mkcertDisabledAttr = available ? '' : 'disabled';
  const modeTabs = `
    <div class="setup-https-modes">
      <label class="setup-https-mode ${mode === 'mkcert' ? 'selected' : ''} ${available ? '' : 'disabled'}">
        <input type="radio" name="httpsMode" value="mkcert" ${mode === 'mkcert' ? 'checked' : ''} ${mkcertDisabledAttr}
               onchange="wizardSelectHttpsMode('mkcert')">
        <div class="setup-https-mode-text">
          <span class="setup-https-mode-title">Automatic (recommended)</span>
          <span class="setup-https-mode-sub">Generate trusted certs with mkcert</span>
        </div>
      </label>
      <label class="setup-https-mode ${mode === 'manual' ? 'selected' : ''}">
        <input type="radio" name="httpsMode" value="manual" ${mode === 'manual' ? 'checked' : ''}
               onchange="wizardSelectHttpsMode('manual')">
        <div class="setup-https-mode-text">
          <span class="setup-https-mode-title">Manual</span>
          <span class="setup-https-mode-sub">Provide existing cert + key paths</span>
        </div>
      </label>
      <label class="setup-https-mode ${mode === 'skip' ? 'selected' : ''}">
        <input type="radio" name="httpsMode" value="skip" ${mode === 'skip' ? 'checked' : ''}
               onchange="wizardSelectHttpsMode('skip')">
        <div class="setup-https-mode-text">
          <span class="setup-https-mode-title">Skip for now</span>
          <span class="setup-https-mode-sub">Continue without HTTPS</span>
        </div>
      </label>
    </div>`;

  let modeBody = '';
  if (mode === 'mkcert') modeBody = _renderHttpsMkcertBody();
  else if (mode === 'manual') modeBody = _renderHttpsManualBody();
  else if (mode === 'skip') modeBody = _renderHttpsSkipBody();

  const canAdvance = _httpsCanAdvance();

  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">Secure Access</h2>
      <p class="setup-text-muted">TangleClaw can serve over HTTPS so session traffic, API keys, and OpenClaw connections stay encrypted.</p>
      <div class="setup-https-status">${statusBadge}</div>
      ${modeTabs}
      <div class="setup-https-body">${modeBody}</div>
      <div id="setupHttpsError" class="form-error hidden" role="alert"></div>
      <div class="setup-nav">
        <button class="btn" onclick="wizardBack()">Back</button>
        <button class="btn btn-primary" id="setupHttpsNextBtn" ${canAdvance ? '' : 'disabled'} onclick="wizardHttpsNext()">Next</button>
      </div>
    </div>`;

  if (mode === 'manual') {
    const cert = document.getElementById('setupHttpsCertPath');
    const key = document.getElementById('setupHttpsKeyPath');
    const sync = () => {
      wizard.httpsCertPath = (cert && cert.value.trim()) || '';
      wizard.httpsKeyPath = (key && key.value.trim()) || '';
      const nextBtn = document.getElementById('setupHttpsNextBtn');
      if (nextBtn) nextBtn.disabled = !_httpsCanAdvance();
    };
    if (cert) cert.addEventListener('input', sync);
    if (key) key.addEventListener('input', sync);
  }
}

function _renderHttpsMkcertBody() {
  if (!wizard.httpsGenerated) {
    const caNote = wizard.mkcertCaInstalled
      ? ''
      : '<p class="setup-text-muted">mkcert will install a local trust CA on this machine the first time you generate a cert.</p>';
    return `
      <div class="setup-https-panel">
        <p class="setup-text-muted">Click below to generate a TLS certificate for <code>localhost</code>, <code>127.0.0.1</code>, and <code>::1</code> using mkcert.</p>
        ${caNote}
        <button class="btn btn-primary" id="setupGenerateCertBtn" onclick="wizardGenerateCerts()">Generate Certificates</button>
      </div>`;
  }
  const gen = wizard.httpsGenerated;
  const steps = (gen.remoteTrust && gen.remoteTrust.steps) || [];
  let stepsHtml = '';
  for (const step of steps) {
    stepsHtml += `
      <div class="setup-https-trust-step">
        <div class="setup-https-trust-label"><strong>${esc(step.platform)}</strong> — ${esc(step.label)}</div>
        <pre class="setup-https-code"><code>${esc(step.command)}</code></pre>
      </div>`;
  }
  const noteHtml = gen.remoteTrust && gen.remoteTrust.note
    ? `<p class="setup-text-muted">${esc(gen.remoteTrust.note)}</p>`
    : '';
  const trustedRow = wizard.httpsRemoteTrustConfirmed
    ? '<div class="setup-https-confirmed-row">✓ Remote trust confirmed</div>'
    : `
      <div class="setup-https-trust-buttons">
        <button class="btn btn-primary" onclick="wizardConfirmRemoteTrust()">I've done this on remote machines</button>
        <button class="btn" onclick="wizardConfirmRemoteTrust()">I only access locally</button>
      </div>`;
  const expiryRow = gen.expiry ? `<div><span>Expires:</span> ${esc(gen.expiry)}</div>` : '';
  return `
    <div class="setup-https-panel">
      <div class="setup-https-success">✓ Certificate generated</div>
      <div class="setup-https-kv">
        <div><span>Cert:</span> <code>${esc(gen.certPath)}</code></div>
        <div><span>Key:</span> <code>${esc(gen.keyPath)}</code></div>
        ${expiryRow}
      </div>
      <h3 class="setup-https-subheading">Remote browser trust</h3>
      <p class="setup-text-muted">If you'll access TangleClaw from another machine, copy <code>rootCA.pem</code> from <code>${esc(gen.remoteTrust ? gen.remoteTrust.caRootPath : wizard.mkcertCaroot)}</code> and run the matching command on that machine.</p>
      ${noteHtml}
      ${stepsHtml}
      ${trustedRow}
    </div>`;
}

function _renderHttpsManualBody() {
  return `
    <div class="setup-https-panel">
      <p class="setup-text-muted">Have an existing certificate? Enter the full paths below. They'll be validated when you finish setup.</p>
      <div class="form-group">
        <label class="form-label" for="setupHttpsCertPath">Certificate file (PEM)</label>
        <input type="text" class="form-input" id="setupHttpsCertPath"
               value="${esc(wizard.httpsCertPath)}"
               placeholder="/etc/ssl/mysite.pem"
               autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      </div>
      <div class="form-group">
        <label class="form-label" for="setupHttpsKeyPath">Private key file (PEM)</label>
        <input type="text" class="form-input" id="setupHttpsKeyPath"
               value="${esc(wizard.httpsKeyPath)}"
               placeholder="/etc/ssl/mysite-key.pem"
               autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      </div>
    </div>`;
}

function _renderHttpsSkipBody() {
  return `
    <div class="setup-https-panel setup-https-warning">
      <div class="setup-https-warn-icon" aria-hidden="true">!</div>
      <div>
        <div class="setup-https-warn-title">You'll run TangleClaw over HTTP.</div>
        <p class="setup-text-muted">OpenClaw connections over HTTP expose session tokens and API keys on your LAN. You can enable HTTPS later from Settings.</p>
      </div>
    </div>`;
}

function _httpsCanAdvance() {
  if (wizard.httpsMode === 'skip') return true;
  if (wizard.httpsMode === 'mkcert') {
    return !!(wizard.httpsGenerated && wizard.httpsCertPath && wizard.httpsKeyPath && wizard.httpsRemoteTrustConfirmed);
  }
  if (wizard.httpsMode === 'manual') {
    return !!(wizard.httpsCertPath && wizard.httpsKeyPath);
  }
  return false;
}

function wizardSelectHttpsMode(mode) {
  if (wizard.httpsMode !== mode) {
    // Clear per-mode state so generated mkcert paths don't pre-fill the
    // manual inputs and a prior remote-trust confirmation doesn't unlock
    // Next for a freshly-selected mode.
    wizard.httpsGenerated = null;
    wizard.httpsCertPath = '';
    wizard.httpsKeyPath = '';
    wizard.httpsRemoteTrustConfirmed = false;
  }
  wizard.httpsMode = mode;
  renderHttpsSetup(document.getElementById('setupBody'));
}

function wizardHttpsNext() {
  if (!_httpsCanAdvance()) return;
  wizardNext();
}

async function wizardGenerateCerts() {
  const btn = document.getElementById('setupGenerateCertBtn');
  const err = document.getElementById('setupHttpsError');
  if (err) { err.classList.add('hidden'); err.textContent = ''; }
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating…'; }

  const data = await apiMutate('/api/setup/generate-cert', 'POST', {});
  if (!data) {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate Certificates'; }
    if (err) { err.textContent = api.lastError || 'Certificate generation failed.'; err.classList.remove('hidden'); }
    return;
  }

  wizard.httpsGenerated = data;
  wizard.httpsCertPath = data.certPath || '';
  wizard.httpsKeyPath = data.keyPath || '';
  renderHttpsSetup(document.getElementById('setupBody'));
}

function wizardConfirmRemoteTrust() {
  wizard.httpsRemoteTrustConfirmed = true;
  renderHttpsSetup(document.getElementById('setupBody'));
}

// ── Admin Login Step (AUTH-2, caddy ingress only) ──

/**
 * First unmet admin-credential rule as an operator-facing message, or null
 * when every client-side rule passes — the single rule source behind the
 * Next-button gate (`_adminCanAdvance`), the live hint under the fields, and
 * the `wizardAdminNext` error path (AUTH-7P3M: one rule set, three surfaces,
 * so the gate and its explanations can't drift). Messages name the FIRST
 * failing rule in gate order, so the operator always sees the next thing to
 * fix. The server re-validates (incl. the weak-password denylist) and is
 * authoritative — this only drives the client-side gate and its feedback.
 * @param {string} user - Username field value (trimmed here).
 * @param {string} password - Password field value.
 * @param {string} confirm - Confirmation field value.
 * @returns {string|null} First unmet rule's message, or null when valid.
 */
function _adminRuleHint(user, password, confirm) {
  const u = (user || '').trim();
  const p = password || '';
  const c = confirm || '';
  if (!u) return 'Enter a username.';
  if (p.length < 12) return 'Password must be at least 12 characters.';
  if (p !== c) return 'Passwords do not match.';
  if (p.toLowerCase().includes(u.toLowerCase())) return 'Password must not contain the username.';
  return null;
}

/**
 * Whether the admin step's inputs satisfy the client-side rules — true exactly
 * when `_adminRuleHint` has no rule left to report. Gates the Next button.
 * @returns {boolean}
 */
function _adminCanAdvance() {
  return _adminRuleHint(wizard.adminUser, wizard.adminPassword, wizard.adminPasswordConfirm) === null;
}

function renderAdminSetup(body) {
  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">Admin Login</h2>
      <p class="setup-text-muted">TangleClaw will put this login in front of every page, so nothing reaches your sessions or terminals without it. Create the credential you'll use to sign in — there is no default login, and TangleClaw never invents one.</p>
      <div class="form-group">
        <label class="form-label" for="setupAdminUser">Username</label>
        <input type="text" class="form-input" id="setupAdminUser"
               value="${esc(wizard.adminUser)}" placeholder="admin"
               autocomplete="username" autocorrect="off" autocapitalize="off" spellcheck="false">
      </div>
      <div class="form-group">
        <label class="form-label" for="setupAdminPassword">Password</label>
        <input type="password" class="form-input" id="setupAdminPassword"
               value="${esc(wizard.adminPassword)}" placeholder="At least 12 characters"
               autocomplete="new-password">
      </div>
      <div class="form-group">
        <label class="form-label" for="setupAdminPasswordConfirm">Confirm password</label>
        <input type="password" class="form-input" id="setupAdminPasswordConfirm"
               value="${esc(wizard.adminPasswordConfirm)}" placeholder="Re-enter password"
               autocomplete="new-password">
      </div>
      <div class="form-hint">At least 12 characters. Avoid common passwords and don't include your username.</div>
      <div id="setupAdminLiveHint" class="form-error hidden" role="status"></div>
      <div id="setupAdminError" class="form-error hidden" role="alert"></div>
      <div class="setup-nav">
        <button class="btn" onclick="wizardBack()">Back</button>
        <button class="btn btn-primary" id="setupAdminNextBtn" ${_adminCanAdvance() ? '' : 'disabled'} onclick="wizardAdminNext()">Next</button>
      </div>
    </div>`;

  const u = document.getElementById('setupAdminUser');
  const p = document.getElementById('setupAdminPassword');
  const c = document.getElementById('setupAdminPasswordConfirm');
  const sync = () => {
    wizard.adminUser = (u && u.value) || '';
    wizard.adminPassword = (p && p.value) || '';
    wizard.adminPasswordConfirm = (c && c.value) || '';
    const btn = document.getElementById('setupAdminNextBtn');
    if (btn) btn.disabled = !_adminCanAdvance();
    _updateAdminLiveHint();
  };
  if (u) u.addEventListener('input', sync);
  if (p) p.addEventListener('input', sync);
  if (c) c.addEventListener('input', sync);
  // Back-navigation re-render: fields repopulate from wizard state without an
  // input event, so reflect the current rule state once up front.
  _updateAdminLiveHint();
}

/**
 * Show the first unmet admin-credential rule under the fields, or hide the
 * hint when the rules pass — suppressed while all three fields are still
 * empty so a pristine step doesn't scold before the operator types
 * (AUTH-7P3M). Uses the same rule source as the Next-button gate.
 */
function _updateAdminLiveHint() {
  const hint = document.getElementById('setupAdminLiveHint');
  if (!hint) return;
  const pristine = !wizard.adminUser && !wizard.adminPassword && !wizard.adminPasswordConfirm;
  const msg = pristine
    ? null
    : _adminRuleHint(wizard.adminUser, wizard.adminPassword, wizard.adminPasswordConfirm);
  if (msg) {
    hint.textContent = msg;
    hint.classList.remove('hidden');
  } else {
    hint.textContent = '';
    hint.classList.add('hidden');
  }
}

function wizardAdminNext() {
  // Pull the latest values in case input events didn't fire (some mobile browsers).
  const u = document.getElementById('setupAdminUser');
  const p = document.getElementById('setupAdminPassword');
  const c = document.getElementById('setupAdminPasswordConfirm');
  if (u) wizard.adminUser = u.value;
  if (p) wizard.adminPassword = p.value;
  if (c) wizard.adminPasswordConfirm = c.value;

  const err = document.getElementById('setupAdminError');
  if (!_adminCanAdvance()) {
    if (err) {
      // Same rule source as the gate and the live hint — non-null exactly
      // when the gate refuses (AUTH-7P3M).
      err.textContent = _adminRuleHint(wizard.adminUser, wizard.adminPassword, wizard.adminPasswordConfirm);
      err.classList.remove('hidden');
    }
    return;
  }
  if (err) { err.classList.add('hidden'); err.textContent = ''; }
  wizardNext();
}

/**
 * The Login row of the confirm summary. Says what will actually be true when
 * setup finishes — including "None" — rather than only reporting the credential
 * the operator typed. A summary that stayed silent when no gate can be put up
 * would leave them believing setup protected them.
 * @returns {string}
 */
function _loginSummaryLabel() {
  const plan = wizard.ingressPlan;
  if (plan && plan.action === 'provision') {
    return wizard.adminUser ? `Will be created for ${wizard.adminUser}` : 'Not set';
  }
  if (plan && plan.action === 'adopt') return 'Existing login kept';
  if (plan && plan.action === 'refuse') return 'None — not protected';
  return 'Unknown — could not check';
}

function renderConfirm(body) {
  const selectedCount = wizard.selectedProjects.size;
  // `wizard.defaultEngine` is null when no engine is installed — say that
  // rather than rendering "null" in the summary the operator confirms.
  const engineName = wizard.defaultEngine
    ? ((state.engines.find(e => e.id === wizard.defaultEngine) || {}).name || wizard.defaultEngine)
    : 'None installed';

  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">Ready to Go</h2>
      <div class="setup-summary">
        <div class="setup-summary-row">
          <span class="setup-summary-label">Projects Directory</span>
          <span class="setup-summary-value">${esc(wizard.projectsDir)}</span>
        </div>
        <div class="setup-summary-row">
          <span class="setup-summary-label">Projects to Attach</span>
          <span class="setup-summary-value">${selectedCount} project${selectedCount !== 1 ? 's' : ''}</span>
        </div>
        <div class="setup-summary-row">
          <span class="setup-summary-label">Default Engine</span>
          <span class="setup-summary-value">${esc(engineName)}</span>
        </div>
        <div class="setup-summary-row">
          <span class="setup-summary-label">HTTPS</span>
          <span class="setup-summary-value">${esc(_httpsSummaryLabel())}</span>
        </div>
        <div class="setup-summary-row">
          <span class="setup-summary-label">Login</span>
          <span class="setup-summary-value">${esc(_loginSummaryLabel())}</span>
        </div>
        <div class="setup-summary-row">
          <span class="setup-summary-label">Delete Protection</span>
          <span class="setup-summary-value">${wizard.deletePassword ? 'Enabled' : 'None'}</span>
        </div>
        <div class="setup-summary-row">
          <span class="setup-summary-label">Idle Chime</span>
          <span class="setup-summary-value">${wizard.chimeEnabled ? 'On' : 'Off'}</span>
        </div>
      </div>
      <div id="setupCompleteError" class="form-error hidden" role="alert"></div>
      <button class="btn btn-primary setup-btn" id="setupCompleteBtn" onclick="wizardComplete()">Complete Setup</button>
      <div class="setup-nav" style="margin-top:8px">
        <button class="btn" onclick="wizardBack()">Back</button>
      </div>
    </div>`;
}

// ── Completion ──

async function wizardComplete() {
  const btn = document.getElementById('setupCompleteBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  // Build project list from selected scanned projects
  const projectsToAttach = wizard.scannedProjects
    .filter(p => wizard.selectedProjects.has(p.name))
    .map(p => ({ name: p.name, path: p.path }));

  const setupBody = {
    projectsDir: wizard.projectsDir,
    defaultEngine: wizard.defaultEngine,
    chimeEnabled: wizard.chimeEnabled,
    projects: projectsToAttach
  };

  if (wizard.deletePassword) {
    setupBody.deletePassword = wizard.deletePassword;
  }

  // Send the credential exactly when the step that collects it was shown — the
  // same predicate, so the wizard can't collect one and then decline to send it.
  // The server validates + hashes it, and re-checks that it was required.
  if (_adminStepRequired() && wizard.adminUser) {
    setupBody.adminUser = wizard.adminUser;
    setupBody.adminPassword = wizard.adminPassword;
  }

  Object.assign(setupBody, _buildHttpsPayload());

  const result = await apiMutate('/api/setup/complete', 'POST', setupBody);
  if (!result) {
    const err = document.getElementById('setupCompleteError');
    err.textContent = api.lastError || 'Setup failed.';
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Complete Setup';
    // The server refuses to finish without a credential on a machine that can
    // run a gate. Reaching that means the wizard's own plan was stale or missing
    // (a failed probe reads as "no admin step"), so re-ask and route back to the
    // step rather than leaving the operator on an error they cannot act on.
    // The stable code, not the message: the server sends ADMIN_REQUIRED on both
    // refusals, and matching prose both breaks on any rewording and over-matches
    // (a bad adminUser and a hashing failure also say "admin").
    if (api.lastErrorCode === 'ADMIN_REQUIRED') await _recoverToAdminStep();
    return;
  }

  // Surface anything the server skipped. `warnings` has always been on this
  // response and nothing here read it, so a project that failed to attach —
  // a path that vanished, a name collision — left the wizard reporting success
  // and the operator believing every directory they ticked was registered.
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    const err = document.getElementById('setupCompleteError');
    if (err) {
      err.textContent = `Setup finished, but ${result.warnings.length} item(s) were skipped: `
        + result.warnings.join('; ');
      err.classList.remove('hidden');
    }
  }

  // What happened to the login, before anything else — it is the one outcome the
  // operator must not be left guessing about.
  const ingress = result.ingress || null;
  // The warnings were rendered into #setupCompleteError above, which lives inside
  // the confirm step's body — and every terminal screen below replaces that body.
  // Carry them onto the screen instead of letting the render that reports them
  // also be the render that discards them.
  const carried = Array.isArray(result.warnings) ? result.warnings : [];
  if (ingress && ingress.provisioning) {
    _showProvisioningScreen(ingress, carried);
    return;
  }
  if (ingress && (ingress.protection === 'none' || ingress.protection === 'unchanged'
      || ingress.protection === 'existing-unverified')) {
    // 'unchanged' and 'existing-unverified' both mean a credential exists and
    // TangleClaw cannot say it is in force. Dismissing into a dashboard that looks
    // identical to a protected one is the failure this screen exists to prevent,
    // so they route here rather than falling through.
    _showUnprotectedScreen(ingress, carried);
    return;
  }

  if (result.restart) {
    // Backend always supplies redirectUrl with restart today, but fall back
    // to the current origin so the overlay still shows while the server
    // cycles — otherwise the normal dismiss flow would run fetches against
    // a process that's exiting.
    _showRestartOverlay(result.redirectUrl || (window.location && window.location.origin) || '/');
    return;
  }

  // Refresh state and dismiss — dismissWizard() handles loadProjects()
  await loadConfig();
  dismissWizard();
}

/**
 * Re-ask the server for the login plan and, if it now says a credential is
 * required, jump to the admin step. Recovery path for a completion the server
 * refused because the wizard's plan was missing or stale.
 * @returns {Promise<void>}
 */
async function _recoverToAdminStep() {
  await loadIngressPlan();
  if (!_adminStepRequired()) return;
  const keys = wizardStepKeys();
  const idx = keys.indexOf('admin');
  if (idx >= 0) {
    wizard.step = idx;
    renderWizardStep();
  }
}

// ── Provisioning the login gate ──
//
// The cutover restarts the server as its last step, so the wizard cannot be told
// the outcome in the response that starts it. It polls instead — and must handle
// its OWN origin disappearing, because the restart re-binds plain HTTP on the
// loopback interface. An operator who reached setup over direct HTTPS, or over a
// LAN or tailnet address, loses this page's origin at that moment and the new
// perimeter address is a different port (cross-origin: a probe cannot read the
// status, and probing a basic_auth URL from a page pops the browser's own
// credential prompt). So "cannot confirm" is a real answer here, not a timeout to
// paper over — reporting success without evidence is the exact failure this whole
// path exists to prevent.
//
// The interval below drives polling only. Nothing dismisses, redirects or closes
// on a timer (#98/#268): each terminal state waits for a click.

const PROVISION_POLL_MS = 1500;
const PROVISION_DEADLINE_MS = 90000;

/**
 * Render the server's warnings as a block, or nothing when there are none.
 *
 * The confirm step reported these into an element the terminal screens replace,
 * so each terminal screen re-states them. A skipped project or an unadoptable
 * credential must not vanish because the screen that would have shown it was
 * swapped out.
 * @param {string[]} warnings
 * @returns {string} HTML, or '' when there is nothing to say.
 */
function _warningsBlock(warnings) {
  const list = Array.isArray(warnings) ? warnings.filter((w) => typeof w === 'string' && w) : [];
  if (list.length === 0) return '';
  return `<div class="form-error" role="status"><strong>Also worth knowing:</strong><ul>`
    + list.map((w) => `<li>${esc(w)}</li>`).join('')
    + `</ul></div>`;
}

/**
 * How exposed an ungated TangleClaw actually is, in one sentence.
 *
 * Read from the server's own bind classification rather than assumed. An install
 * whose config predates the loopback default is deliberately held on a wide
 * binding until its operator chooses, so "reachable from this machine only" is
 * false for exactly the person who most needs the truth — ungated AND reachable.
 *
 * Scoped to the DASHBOARD deliberately. `describeBindState` answers for
 * TangleClaw's own listener, and that is the only thing this sentence may speak
 * for: the terminal backend is a separate job with its own binding, and a claim
 * that the machine is not exposed would be broader than the fact it rests on.
 * @param {boolean} exposed - Whether the server binds beyond loopback.
 * @returns {string}
 */
function _exposureSentence(exposed) {
  return exposed
    ? 'The TangleClaw dashboard is currently reachable from your network with no login in front of it '
      + '— anyone who can reach this address can run commands as you. Close it from Settings, or put '
      + 'the login in place.'
    : 'The TangleClaw dashboard is reachable from this machine only, so it is not exposed to your network.';
}

/**
 * Show the provisioning screen and start polling for the cutover's outcome.
 * @param {object} ingress - `ingress` block from POST /api/setup/complete.
 */
function _showProvisioningScreen(ingress, warnings) {
  wizard.view = 'provisioning';
  wizard.provision = {
    phase: 'working',
    url: ingress.url || null,
    user: ingress.user || null,
    code: null,
    hasError: false,
    logLocation: null,
    reachable: true,
    networkExposed: ingress.networkExposed === true,
    warnings: Array.isArray(warnings) ? warnings : []
  };
  _renderProvisionScreen();
  _pollProvisionOutcome();
}

/**
 * Poll GET /api/setup/provision-status until it answers or the deadline passes.
 *
 * A failed fetch is "still restarting", never "failed" — the server being polled
 * is the one the cutover is kicking. Whether the last attempt reached anything is
 * remembered, because at the deadline it is the difference between "this page
 * cannot see the answer" and "the cutover has not reported yet".
 * @returns {Promise<void>}
 */
async function _pollProvisionOutcome() {
  const deadline = Date.now() + PROVISION_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PROVISION_POLL_MS));
    let data = null;
    try {
      const res = await fetch('/api/setup/provision-status', { cache: 'no-store' });
      if (res.ok) data = await res.json();
      wizard.provision.reachable = true;
    } catch {
      // Origin is gone or the server is mid-restart. Both mean "keep waiting".
      wizard.provision.reachable = false;
    }
    if (data && data.state === 'done') {
      wizard.provision.phase = data.ok ? 'gated' : 'failed';
      wizard.provision.code = data.code || null;
      wizard.provision.hasError = data.hasError === true;
      wizard.provision.logLocation = data.logLocation || null;
      _renderProvisionScreen();
      return;
    }
    if (data && data.state === 'unparseable-result') {
      wizard.provision.phase = 'failed';
      wizard.provision.code = null;
      wizard.provision.hasError = true;
      wizard.provision.logLocation = data.logLocation || null;
      _renderProvisionScreen();
      return;
    }
    _renderProvisionScreen();
  }
  wizard.provision.phase = 'unconfirmed';
  _renderProvisionScreen();
}

/** Render the current provisioning phase into the wizard body. */
function _renderProvisionScreen() {
  const body = document.getElementById('setupBody');
  if (!body) return;
  const p = wizard.provision || {};
  const url = p.url || '';
  const signIn = url
    ? `<button class="btn btn-primary setup-btn" onclick="window.location.href='${esc(url)}'">Open ${esc(url)}</button>`
    : '';

  if (p.phase === 'working') {
    body.innerHTML = `
      <div class="setup-step" role="status" aria-live="polite" aria-busy="true">
        <h2 class="setup-heading">Putting your login in place…</h2>
        <div class="setup-https-restart-panel">
          <div class="spinner"></div>
          <p class="setup-text">TangleClaw is configuring the login gate and restarting.</p>
          <p class="setup-text-muted">${p.reachable
            ? 'Waiting for it to report back.'
            : 'The server is restarting, so this page cannot reach it for a moment.'}</p>
        </div>
        ${_warningsBlock(p.warnings)}
      </div>`;
    return;
  }

  if (p.phase === 'gated') {
    body.innerHTML = `
      <div class="setup-step" role="status" aria-live="polite">
        <h2 class="setup-heading">Your login is in force</h2>
        <p class="setup-text">TangleClaw is now behind a login${p.user ? ` for <strong>${esc(p.user)}</strong>` : ''}. Every page will ask for it.</p>
        ${url ? `<p class="setup-text-muted">TangleClaw has moved to <code>${esc(url)}</code>. This address will not work any more.</p>` : ''}
        ${_warningsBlock(p.warnings)}
        ${signIn}
      </div>`;
    return;
  }

  if (p.phase === 'failed') {
    body.innerHTML = `
      <div class="setup-step" role="alert">
        <h2 class="setup-heading">No login is in force</h2>
        <p class="setup-text">Setup finished, but putting a login in front of TangleClaw did not work${p.code ? ` (<code>${esc(p.code)}</code>)` : ''}. <strong>Nothing is asking for a password right now.</strong></p>
        ${p.hasError && p.logLocation ? `<p class="setup-text-muted">It reported a reason, which is in <code>${esc(p.logLocation)}</code> and in TangleClaw's log.</p>` : ''}
        <p class="setup-text-muted">${_exposureSentence(p.networkExposed)} To put the login in place, run
          <code>node scripts/ingress-cutover.js --to caddy</code> at a terminal.</p>
        ${_warningsBlock(p.warnings)}
        <button class="btn btn-primary setup-btn" onclick="_finishAfterProvisioning()">Continue unprotected</button>
      </div>`;
    return;
  }

  // 'unconfirmed' — the deadline passed. Which of the two things happened is the
  // whole content of this screen, and `reachable` is the only evidence for it.
  // Claiming the origin closed when it never did would send an operator whose
  // cutover merely stalled to --rollback for no reason.
  const openedCheck = url
    ? `<p class="setup-text">Open <code>${esc(url)}</code>. <strong>If it asks for a username and password, your login is in force.</strong> If it loads without asking, it is not.</p>`
    : '';
  const rollback = '<p class="setup-text-muted">If nothing loads at all, run <code>node scripts/ingress-cutover.js --rollback</code> at a terminal to put TangleClaw back the way it was.</p>';

  body.innerHTML = p.reachable
    ? `
    <div class="setup-step" role="alert">
      <h2 class="setup-heading">Started — but it hasn't reported back</h2>
      <p class="setup-text">TangleClaw is still reachable at this address and the login setup has not said how it ended. <strong>It may or may not have finished</strong> — this page cannot tell you which, so it will not guess.</p>
      ${openedCheck}
      ${p.logLocation ? `<p class="setup-text-muted">What it was doing is in <code>${esc(p.logLocation)}</code>.</p>` : ''}
      ${rollback}
      ${_warningsBlock(p.warnings)}
      ${signIn}
      <button class="btn setup-btn" onclick="_finishAfterProvisioning()">Stay on this page</button>
    </div>`
    : `
    <div class="setup-step" role="alert">
      <h2 class="setup-heading">Started — but this page can't see the result</h2>
      <p class="setup-text">The login setup was started and TangleClaw restarted. This page was served from an address the restart closes, so it cannot read the outcome.</p>
      ${openedCheck}
      ${rollback}
      ${_warningsBlock(p.warnings)}
      ${signIn}
      <button class="btn setup-btn" onclick="_finishAfterProvisioning()">Stay on this page</button>
    </div>`;
}

/**
 * Leave the provisioning screen for the normal landing page. Only ever called
 * from a button — never from the poll — so nothing decides for the operator.
 * @returns {Promise<void>}
 */
async function _finishAfterProvisioning() {
  wizard.view = 'steps';
  await loadConfig();
  dismissWizard();
}

/**
 * Terminal screen for a setup that finished with no login in force and never
 * attempted one (nothing to run a gate, or a Caddy config TangleClaw must not
 * touch). Says so plainly instead of dismissing into a dashboard that looks
 * identical to a protected one.
 * @param {object} ingress - `ingress` block from POST /api/setup/complete.
 */
function _showUnprotectedScreen(ingress, warnings) {
  wizard.view = 'unprotected';
  const body = document.getElementById('setupBody');
  if (!body) return;

  // Three states land here and they are not the same claim. 'none' means there is
  // no login at all. 'unchanged' and 'existing-unverified' mean a credential is
  // stored while TangleClaw cannot say it is being enforced — asserting "nothing
  // is asking for a password" there would be a guess in the other direction.
  const stored = ingress.protection === 'unchanged' || ingress.protection === 'existing-unverified';
  const heading = stored ? 'Your login is saved, but not confirmed' : 'TangleClaw has no login';
  const lead = stored
    ? `<p class="setup-text">A login is saved, but TangleClaw <strong>cannot confirm anything is enforcing it</strong>, and it did not change the Caddy config to find out.</p>`
    : `<p class="setup-text"><strong>Nothing is asking for a password.</strong> ${esc(ingress.reason || 'TangleClaw could not put a login in front of itself on this machine.')}</p>`;

  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">${esc(heading)}</h2>
      ${lead}
      ${stored && ingress.reason ? `<p class="setup-text-muted">${esc(ingress.reason)}</p>` : ''}
      ${ingress.remedy ? `<p class="setup-text-muted">${esc(ingress.remedy)}</p>` : ''}
      <p class="setup-text-muted">${_exposureSentence(ingress.networkExposed === true)}</p>
      ${_warningsBlock(warnings)}
      <button class="btn btn-primary setup-btn" onclick="_finishAfterProvisioning()">Continue</button>
    </div>`;
}

/**
 * Build the HTTPS-related fields of the setup-complete payload.
 * @returns {object} Subset of payload containing httpsEnabled/httpsCertPath/httpsKeyPath
 */
function _buildHttpsPayload() {
  if (wizard.httpsMode === 'mkcert' || wizard.httpsMode === 'manual') {
    return {
      httpsEnabled: true,
      httpsCertPath: wizard.httpsCertPath || null,
      httpsKeyPath: wizard.httpsKeyPath || null
    };
  }
  return {
    httpsEnabled: false,
    httpsCertPath: null,
    httpsKeyPath: null
  };
}

function _httpsSummaryLabel() {
  if (wizard.httpsMode === 'mkcert') return 'Enabled (mkcert)';
  if (wizard.httpsMode === 'manual') return 'Enabled (manual)';
  if (wizard.httpsMode === 'skip') return 'Disabled';
  return 'Not configured';
}

function _showRestartOverlay(redirectUrl) {
  // Claims the view for the same reason the provisioning screens do: the ingress
  // probe re-renders asynchronously and would otherwise repaint this one.
  wizard.view = 'restarting';
  const body = document.getElementById('setupBody');
  if (!body) return;
  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">Restarting TangleClaw…</h2>
      <div class="setup-https-restart-panel">
        <div class="spinner"></div>
        <p class="setup-text">The server is restarting with your new HTTPS configuration.</p>
        <p class="setup-text-muted">You'll be redirected to <code>${esc(redirectUrl)}</code> automatically.</p>
        <button class="btn btn-primary setup-btn" onclick="window.location.href='${esc(redirectUrl)}'">Go now</button>
      </div>
    </div>`;
  _pollRestartAndRedirect(redirectUrl);
}

async function _pollRestartAndRedirect(redirectUrl) {
  const deadline = Date.now() + 20000;
  // Give the server time to actually exit before we start probing.
  await new Promise((r) => setTimeout(r, 1200));
  while (Date.now() < deadline) {
    try {
      await fetch(redirectUrl, { mode: 'no-cors', cache: 'no-store' });
      window.location.href = redirectUrl;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  // Timeout fallback — redirect anyway so the user isn't stuck on the overlay.
  window.location.href = redirectUrl;
}
