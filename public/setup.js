'use strict';
/* ── TangleClaw v3 — First-Run Setup Wizard ── */
/* Full-screen overlay that guides new users through initial configuration. */
/* Loaded after landing.js and ui.js. Only activates when setupComplete === false. */

// ── Wizard State ──

const wizard = {
  step: 0,
  totalSteps: 6,
  projectsDir: '',
  scannedProjects: [],
  selectedProjects: new Set(),
  engines: [],
  defaultEngine: '',
  defaultMethodology: '',
  deletePassword: '',
  chimeEnabled: true
};

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
  wizard.defaultEngine = state.config ? state.config.defaultEngine || 'claude' : 'claude';
  wizard.defaultMethodology = state.config ? state.config.defaultMethodology || 'minimal' : 'minimal';
  wizard.chimeEnabled = state.config ? state.config.chimeEnabled !== false : true;
  wizard.engines = state.engines || [];
  wizard.step = 0;

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
    const methSel = document.getElementById('setupDefaultMethodology');
    if (methSel) wizard.defaultMethodology = methSel.value;
    const pwInput = document.getElementById('setupDeletePassword');
    if (pwInput) wizard.deletePassword = pwInput.value;
    const chimeCheck = document.getElementById('setupChimeEnabled');
    if (chimeCheck) wizard.chimeEnabled = chimeCheck.checked;
  }

  wizard.step++;
  if (wizard.step >= wizard.totalSteps) {
    wizard.step = wizard.totalSteps - 1;
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
  const body = document.getElementById('setupBody');
  const dots = document.querySelectorAll('#setupSteps .step-dot');
  dots.forEach((d, i) => {
    d.className = 'step-dot' + (i === wizard.step ? ' active' : i < wizard.step ? ' done' : '');
  });

  switch (wizard.step) {
    case 0: renderWelcome(body); break;
    case 1: renderProjectsDir(body); break;
    case 2: renderDetectProjects(body); break;
    case 3: renderEngines(body); break;
    case 4: renderPreferences(body); break;
    case 5: renderConfirm(body); break;
  }
}

function renderWelcome(body) {
  body.innerHTML = `
    <div class="setup-step">
      <div class="setup-icon">
        <svg viewBox="0 0 96 96" width="80" height="80" aria-hidden="true">
          <circle cx="48" cy="48" r="44" fill="none" stroke="var(--primary)" stroke-width="2"/>
          <path d="M30 60 Q38 28 48 36 Q58 44 52 56 Q46 68 58 62 Q70 56 66 44 Q62 32 48 28"
                fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round"/>
          <circle cx="42" cy="34" r="2.5" fill="var(--primary)"/>
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
  wizard.selectedProjects = new Set(wizard.scannedProjects.map(p => p.name));
  wizardNext();
}

function renderDetectProjects(body) {
  const projects = wizard.scannedProjects;

  if (projects.length === 0) {
    body.innerHTML = `
      <div class="setup-step">
        <h2 class="setup-heading">Detect Projects</h2>
        <p class="setup-text-muted">No existing projects found in <strong>${esc(wizard.projectsDir)}</strong>.</p>
        <p class="setup-text-muted">That's fine — you can create projects after setup.</p>
        <div class="setup-nav">
          <button class="btn" onclick="wizardBack()">Back</button>
          <button class="btn btn-primary" onclick="wizardNext()">Next</button>
        </div>
      </div>`;
    return;
  }

  let listHtml = '';
  for (const p of projects) {
    const checked = wizard.selectedProjects.has(p.name) ? 'checked' : '';
    const methLabel = p.methodology ? p.methodology : 'No methodology';
    const gitLabel = p.git ? `${p.git.branch}${p.git.dirty ? ' (dirty)' : ''}` : '';

    listHtml += `
      <label class="setup-project-item">
        <input type="checkbox" ${checked}
               onchange="wizardToggleProject('${esc(p.name)}', this.checked)">
        <div class="setup-project-info">
          <span class="setup-project-name">${esc(p.name)}</span>
          <span class="setup-project-meta">${esc(methLabel)}${gitLabel ? ' &middot; ' + esc(gitLabel) : ''}</span>
        </div>
      </label>`;
  }

  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">Detect Projects</h2>
      <p class="setup-text-muted">Found ${projects.length} project${projects.length !== 1 ? 's' : ''} in <strong>${esc(wizard.projectsDir)}</strong>. Select which to attach:</p>
      <div class="setup-project-list">${listHtml}</div>
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

function renderEngines(body) {
  const enginesList = state.engines.length > 0 ? state.engines : wizard.engines;

  let optionsHtml = '';
  let listHtml = '';
  for (const e of enginesList) {
    const selected = e.id === wizard.defaultEngine ? 'selected' : '';
    optionsHtml += `<option value="${esc(e.id)}" ${selected}>${esc(e.name)}</option>`;

    const availClass = e.available ? 'setup-engine-available' : 'setup-engine-unavailable';
    const availIcon = e.available ? '&#10003;' : '&#10007;';
    listHtml += `
      <div class="setup-engine-item">
        <span class="${availClass}">${availIcon}</span>
        <span class="setup-engine-name">${esc(e.name)}</span>
        <span class="setup-engine-status">${e.available ? 'Detected' : 'Not found'}</span>
      </div>`;
  }

  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">AI Engines</h2>
      <p class="setup-text-muted">TangleClaw supports multiple AI coding engines. Here's what's available on your system:</p>
      <div class="setup-engine-list">${listHtml}</div>
      <div class="form-group">
        <label class="form-label" for="setupDefaultEngine">Default Engine</label>
        <select class="form-select" id="setupDefaultEngine">${optionsHtml}</select>
        <div class="form-hint">Used for new projects unless overridden</div>
      </div>
      <div class="setup-nav">
        <button class="btn" onclick="wizardBack()">Back</button>
        <button class="btn btn-primary" onclick="wizardNext()">Next</button>
      </div>
    </div>`;
}

function renderPreferences(body) {
  const methodologies = state.methodologies || [];
  let methOpts = '';
  for (const m of methodologies) {
    const selected = m.id === wizard.defaultMethodology ? 'selected' : '';
    methOpts += `<option value="${esc(m.id)}" ${selected}>${esc(m.name)} — ${esc(m.description || '')}</option>`;
  }

  body.innerHTML = `
    <div class="setup-step">
      <h2 class="setup-heading">Preferences</h2>
      <div class="form-group">
        <label class="form-label" for="setupDefaultMethodology">Default Methodology</label>
        <select class="form-select" id="setupDefaultMethodology">${methOpts}</select>
        <div class="form-hint">Applied to new projects by default</div>
      </div>
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

function renderConfirm(body) {
  const selectedCount = wizard.selectedProjects.size;
  const engineName = (state.engines.find(e => e.id === wizard.defaultEngine) || {}).name || wizard.defaultEngine;
  const methName = (state.methodologies.find(m => m.id === wizard.defaultMethodology) || {}).name || wizard.defaultMethodology;

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
          <span class="setup-summary-label">Default Methodology</span>
          <span class="setup-summary-value">${esc(methName)}</span>
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
    .map(p => ({ name: p.name, path: p.path, methodology: p.methodology }));

  const setupBody = {
    projectsDir: wizard.projectsDir,
    defaultEngine: wizard.defaultEngine,
    defaultMethodology: wizard.defaultMethodology,
    chimeEnabled: wizard.chimeEnabled,
    projects: projectsToAttach
  };

  if (wizard.deletePassword) {
    setupBody.deletePassword = wizard.deletePassword;
  }

  const result = await apiMutate('/api/setup/complete', 'POST', setupBody);
  if (!result) {
    const err = document.getElementById('setupCompleteError');
    err.textContent = 'Setup failed. Check server logs.';
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Complete Setup';
    return;
  }

  // Refresh state and dismiss — dismissWizard() handles loadProjects()
  await loadConfig();
  dismissWizard();
}
