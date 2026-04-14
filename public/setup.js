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
  defaultMethodology: '',
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
  httpsRemoteTrustConfirmed: false
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
    case 5: renderHttpsSetup(body); break;
    case 6: renderConfirm(body); break;
  }
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
      const methLabel = p.methodology ? p.methodology : 'No methodology';
      const gitLabel = p.git ? `${p.git.branch}${p.git.dirty ? ' (dirty)' : ''}` : '';

      html += `
        <label class="setup-project-item">
          <input type="checkbox" ${checked}
                 onchange="wizardToggleProject('${esc(p.name)}', this.checked)">
          <div class="setup-project-info">
            <span class="setup-project-name">${esc(p.name)}</span>
            <span class="setup-project-meta">${esc(methLabel)}${gitLabel ? ' &middot; ' + esc(gitLabel) : ''}</span>
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
    if (err) { err.textContent = 'Certificate generation failed. Check server logs.'; err.classList.remove('hidden'); }
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
          <span class="setup-summary-label">HTTPS</span>
          <span class="setup-summary-value">${esc(_httpsSummaryLabel())}</span>
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

  Object.assign(setupBody, _buildHttpsPayload());

  const result = await apiMutate('/api/setup/complete', 'POST', setupBody);
  if (!result) {
    const err = document.getElementById('setupCompleteError');
    err.textContent = 'Setup failed. Check server logs.';
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Complete Setup';
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
