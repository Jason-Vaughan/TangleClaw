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
  // Set when the SERVER refused to finish setup without a credential on a machine
  // whose probe said none was needed. Kept separate from `ingressPlan` so the
  // server's answer is never overwritten by a client inference — the summary and
  // the payload both read that answer.
  adminStepForcedByServer: false,
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
  if (wizard.adminStepForcedByServer) return true;
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
 * not arrived. A refusal now routes the operator to the step that resolves it, so
 * the button is not a dead end — but offering a way past the gate before knowing
 * whether there is a gate is the wrong default, and on a machine that CAN raise one
 * the PATCH refuses. (It does not always refuse: with no Caddy present the same
 * PATCH legitimately succeeds, which is why this hides on unknown rather than
 * relying on the server to say no.)
 */
/**
 * Clear the overlay's persistent error banner.
 *
 * It sits ABOVE `#setupBody`, so unlike a message inside a step it is not removed
 * by the next render — a failed Skip's "Could not finish setup." would otherwise
 * still be on screen under a later "Your login is in force". Called from the
 * navigation and terminal paths deliberately, and NOT from `renderWizardStep`:
 * `loadIngressPlan` calls that unawaited, so a probe resolving late would wipe a
 * message the operator has not read yet.
 */
function _clearOverlayError() {
  const err = document.getElementById('setupOverlayError');
  if (!err) return;
  err.textContent = '';
  err.classList.add('hidden');
}

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
  wizard.adminStepForcedByServer = false;
  _clearOverlayError();

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
  _clearOverlayError();
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
  _clearOverlayError();
  if (wizard.step > 0) {
    wizard.step--;
    renderWizardStep();
  }
}

async function wizardSkip() {
  // `apiMutate` returns null on a non-2xx rather than throwing, and this path can
  // now be REFUSED: finishing setup requires a credential wherever a gate can be
  // enforced, and the button is reachable in cases where the plan does not demand
  // one but the server still does (an install already in caddy mode whose
  // credential would have come from adopting its Caddyfile — adoption happens on
  // the complete route, not this one). Ignoring the null set `setupComplete` in
  // local state and dismissed, landing the operator on a dashboard as though setup
  // had finished while the server still says it had not.
  const ok = await apiMutate('/api/config', 'PATCH', { setupComplete: true });
  if (!ok) {
    // Refused. Do NOT render an unprotected screen from an invented ingress block:
    // Skip is only visible when the plan does not demand a credential, so the only
    // refusals that reach here come from an install already in caddy mode — where a
    // gate may well be live (adopt, ambiguous) and where an ungated Caddyfile is
    // network-reachable. A hardcoded `protection: 'none'` would tell the first group
    // that nothing is asking for a password, and an absent `networkExposed` would
    // tell the second it is not exposed — the false reassurance this whole slice
    // exists to prevent, produced by the screen meant to prevent it.
    //
    // The honest response to "a credential is required" is the step that collects
    // one, not a verdict about a state we did not measure.
    if (api.lastErrorCode === 'ADMIN_REQUIRED') {
      await _recoverToAdminStep();
      return;
    }
    // #setupOverlayError, not #setupCompleteError: Skip is in the overlay header
    // and reachable from every step, while that element is rendered only by the
    // confirm step — so on welcome…https the message would have gone nowhere and
    // the operator would have seen a click do nothing at all.
    const err = document.getElementById('setupOverlayError');
    if (err) {
      err.textContent = api.lastError || 'Could not finish setup.';
      err.classList.remove('hidden');
    }
    return;
  }
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
      <p class="setup-text-muted">It only takes a minute.</p>
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
        <div id="setupDirProtected" class="form-error hidden" role="status"></div>
        <div id="setupDirError" class="form-error hidden" role="alert"></div>
        <div id="setupDirCreate" class="hidden"></div>
      </div>
      <div class="setup-nav">
        <button class="btn" onclick="wizardBack()">Back</button>
        <button class="btn btn-primary" onclick="wizardValidateDir()">Next</button>
      </div>
    </div>`;
  wizardUpdateDirAdvice();
  setTimeout(() => {
    const el = document.getElementById('setupProjectsDir');
    if (el) {
      el.addEventListener('input', wizardUpdateDirAdvice);
      el.focus();
    }
  }, 100);
}

/**
 * Is `dir` inside a directory this machine's OS keeps TangleClaw out of?
 *
 * The roots come from the server (`config.protectedRoots`) because they are a
 * fact about the machine TangleClaw runs on, not about the browser looking at
 * it. An empty list means there is nothing to warn about here — every non-macOS
 * host — so this stays silent rather than inventing a rule for it.
 *
 * @param {string} dir - The path as typed, `~` form or absolute.
 * @returns {string|null} The matching protected root, or null.
 */
function wizardProtectedRootFor(dir) {
  const roots = (state.config && state.config.protectedRoots) || [];
  const p = String(dir || '').trim().replace(/\/+$/, '');
  if (!p) return null;
  // Case-insensitively, because the only platform that sends roots is macOS and
  // its filesystem is case-insensitive by default: `~/documents/Projects` is the
  // SAME protected directory as `~/Documents/Projects`, and an operator who
  // types it that way would otherwise be the one person the caution skips.
  // Compared against the root's real casing so the message still names the
  // folder the way the system does.
  const lower = p.toLowerCase();
  return roots.find((root) => {
    const r = String(root).toLowerCase();
    return lower === r || lower.startsWith(r + '/');
  }) || null;
}

/**
 * Show or hide the protected-directory caution for whatever is in the box now.
 *
 * BEFORE the scan, deliberately. The scan is the only thing that can prove
 * whether this install can read the directory, and until #859 it proved it by
 * killing the server; it now answers in five seconds with the remedy. But the
 * cheapest fix by far is available only at this moment — the operator is looking
 * at the field and can simply type somewhere else. Saying it only after the
 * attempt fails is help arriving after the choice.
 *
 * A caution, not an error: plenty of installs have granted Full Disk Access, and
 * for them this directory works fine. Nothing is blocked, and Next still scans.
 */
function wizardUpdateDirAdvice() {
  // Typing a new path invalidates whatever the last attempt concluded about the
  // old one. Leaving them up offers to create a folder the operator is no
  // longer asking about, under an error that is no longer true.
  const staleError = document.getElementById('setupDirError');
  if (staleError && !staleError.classList.contains('hidden')) {
    staleError.classList.add('hidden');
    staleError.textContent = '';
    _showCreateDirOffer('', false);
  }
  const el = document.getElementById('setupDirProtected');
  if (!el) return;
  const input = document.getElementById('setupProjectsDir');
  const root = wizardProtectedRootFor(input ? input.value : wizard.projectsDir);
  if (!root) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.innerHTML = `<strong>macOS protects ${esc(root)}.</strong> TangleClaw runs in the `
    + 'background, so it cannot ask you for permission — it may not be able to read your '
    + 'projects here, and it will not find out until it tries. Either choose a folder outside '
    + 'Documents, Desktop and Downloads, or grant Full Disk Access to node in System Settings '
    + '&rarr; Privacy &amp; Security.';
  el.classList.remove('hidden');
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
    // Show what the server actually said. The generic line below is right for a
    // wrong path and WRONG for the failure that strands people: on macOS a
    // directory under ~/Documents exists, is readable by the operator, and
    // still cannot be read by a launchd-spawned node without Full Disk Access.
    // "Not found or not accessible" sends that operator to fix a path that has
    // nothing wrong with it; the server's message names the real remedy.
    err.textContent = api.lastError || 'Directory not found or not accessible.';
    err.classList.remove('hidden');
    // A folder that is merely ABSENT is the one failure the operator can fix
    // from here, in one click — and it is the one a stock Mac hits first, since
    // the pre-filled ~/Documents/Projects does not exist until someone makes
    // it. Telling them it is missing and stopping is accurate and useless.
    _showCreateDirOffer(dir, api.lastErrorCode === 'DIR_MISSING');
    return;
  }

  wizard.scannedProjects = data.projects || [];
  wizard.selectedProjects = new Set(wizard.scannedProjects.filter(p => p.detected).map(p => p.name));
  wizardNext();
}

/**
 * Show or hide the "Create it" offer beneath the directory error.
 * @param {string} dir - The path the operator typed.
 * @param {boolean} missing - Whether the failure was specifically "not there".
 * @returns {void}
 */
function _showCreateDirOffer(dir, missing) {
  const offer = document.getElementById('setupDirCreate');
  if (!offer) return;
  if (!missing) {
    offer.classList.add('hidden');
    offer.innerHTML = '';
    return;
  }
  offer.innerHTML = `<button class="btn btn-small" type="button" id="setupDirCreateBtn"
      onclick="wizardCreateDir()">Create ${esc(dir)}</button>`;
  offer.classList.remove('hidden');
}

/**
 * Create the missing projects directory, then carry straight on with the scan
 * the operator was already trying to do.
 * @returns {Promise<void>}
 */
async function wizardCreateDir() {
  const input = document.getElementById('setupProjectsDir');
  const dir = input ? input.value.trim() : wizard.projectsDir;
  const btn = document.getElementById('setupDirCreateBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  const made = await apiMutate('/api/setup/create-dir', 'POST', { directory: dir });
  if (btn) { btn.disabled = false; btn.textContent = `Create ${dir}`; }
  if (!made) {
    const err = document.getElementById('setupDirError');
    if (err) {
      err.textContent = api.lastError || 'Could not create that folder.';
      err.classList.remove('hidden');
    }
    return;
  }

  // Made it — so finish the click they originally made rather than making them
  // press Next again to find out whether it worked.
  const err = document.getElementById('setupDirError');
  if (err) { err.classList.add('hidden'); err.textContent = ''; }
  _showCreateDirOffer(dir, false);
  await wizardValidateDir();
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

  // Nothing installed: setup STOPS here. TangleClaw's whole job is launching an
  // engine's CLI, so finishing without one hands the operator a
  // finished-looking dashboard that can launch nothing, and they find out at
  // the first Launch button with nothing on screen explaining it. The server
  // refuses the same thing on both routes that can complete setup — this screen
  // is the explanation, not the enforcement.
  //
  // Parked, not failed: the operator installs one in a terminal (they are at
  // this machine on a first run) and presses Check again. TangleClaw cannot run
  // the install for them — it is a launchd service with no terminal to answer a
  // password prompt, which is why every privileged step lives in the human-run
  // installer.
  const noneAvailable = selectable.length === 0;
  const pickerHtml = noneAvailable
    ? `<div class="setup-https-panel setup-https-warning">
        <div class="setup-https-warn-icon" aria-hidden="true">!</div>
        <div>
          <div class="setup-https-warn-title">No AI engine is installed yet.</div>
          <p class="setup-text-muted">TangleClaw runs an AI coding CLI for you — without one there is nothing for it to launch, so setup pauses here. Install any one of these in a terminal on this Mac, then press <strong>Check again</strong>.</p>
          ${_engineInstallOptionsHtml(enginesList)}
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
        ${noneAvailable
          ? '<button class="btn btn-primary" id="setupEngineRecheck" onclick="wizardRecheckEngines()">Check again</button>'
          : '<button class="btn btn-primary" onclick="wizardNext()">Next</button>'}
      </div>
    </div>`;
}

/**
 * The install options offered when nothing is detected: per engine, the exact
 * command and a link to the vendor's own instructions.
 *
 * Both, deliberately. A command is what an operator at a terminal actually
 * wants, and a pinned command is the thing most likely to go stale — the docs
 * page is the vendor's to keep current, so it is the half that cannot rot.
 * An engine profile carrying neither says so rather than inventing one; an
 * operator-added engine is not required to tell us how it is installed.
 *
 * @param {object[]} list - Engines as returned by `/api/engines`.
 * @returns {string} HTML.
 */
function _engineInstallOptionsHtml(list) {
  const rows = (list || []).map((e) => {
    const name = typeof e.name === 'string' && e.name ? e.name : e.id;
    const install = e.install || {};
    const command = typeof install.command === 'string' ? install.command : '';
    // http(s) only. Engine profiles are operator-authored through the API and
    // this value goes straight into an href — `javascript:` there is a script
    // the page runs on click. An unusable link is dropped rather than rendered.
    const rawDocs = typeof install.docsUrl === 'string' ? install.docsUrl : '';
    const docsUrl = /^https?:\/\//i.test(rawDocs) ? rawDocs : '';
    if (!command && !docsUrl) {
      return `<div class="setup-engine-install">
        <div class="setup-engine-name">${esc(name)}</div>
        <p class="setup-text-muted">No install command on file — see this engine's own documentation.</p>
      </div>`;
    }
    const cmdHtml = command
      ? `<div class="setup-engine-install-cmd">
          <code>${esc(command)}</code>
          <button class="btn btn-small" type="button"
                  onclick="wizardCopyInstall(${esc(JSON.stringify(command))})">Copy</button>
        </div>`
      : '';
    // rel="noopener" because target=_blank otherwise hands the opened page a
    // handle back to this one.
    const docsHtml = docsUrl
      ? `<a class="setup-engine-install-docs" href="${esc(docsUrl)}"
            target="_blank" rel="noopener noreferrer">Install instructions &rarr;</a>`
      : '';
    return `<div class="setup-engine-install">
      <div class="setup-engine-name">${esc(name)}</div>
      ${cmdHtml}
      ${docsHtml}
    </div>`;
  });
  return `<div class="setup-engine-installs">${rows.join('')}</div>
    <div id="setupEngineCopyNote" class="form-hint hidden" role="status"></div>`;
}

/**
 * Copy an install command, and say so — a Copy button that gives no feedback
 * reads as a broken button.
 * @param {string} command - The command to copy.
 * @returns {Promise<void>}
 */
async function wizardCopyInstall(command) {
  const ok = await window.tcCopyToClipboard(command);
  const note = document.getElementById('setupEngineCopyNote');
  if (note) {
    note.textContent = ok ? 'Copied.' : 'Could not copy — select the command and copy it manually.';
    note.classList.remove('hidden');
  }
}

/**
 * Re-probe for engines after the operator has installed one.
 *
 * Asks the server to re-read the login PATH rather than reuse what it resolved
 * at boot: an installer that edits the shell profile changes the PATH itself,
 * not only what sits on it, and this button exists precisely for the moment
 * after an install.
 * @returns {Promise<void>}
 */
async function wizardRecheckEngines() {
  const btn = document.getElementById('setupEngineRecheck');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  const data = await api('/api/engines?refresh=1');
  if (btn) { btn.disabled = false; btn.textContent = 'Check again'; }
  if (!data) {
    const note = document.getElementById('setupEngineCopyNote');
    if (note) {
      note.textContent = api.lastError || 'Could not check — is the server still running?';
      note.classList.remove('hidden');
    }
    return;
  }
  const found = (data.engines || []).filter((e) => e && e.available);
  state.engines = data.engines || [];
  wizard.engines = data.engines || [];
  if (found.length === 0) {
    // Re-rendering the identical screen reads as a dead button. Say that the
    // check ran and what it found, or the operator cannot tell "still nothing"
    // from "nothing happened".
    const note = document.getElementById('setupEngineCopyNote');
    if (note) {
      note.textContent = 'Checked again — still nothing found. If you just installed one, '
        + 'make sure it runs by name in a new terminal window.';
      note.classList.remove('hidden');
    }
    return;
  }
  if (found.length > 0) {
    // Found one: seed the default so the picker that replaces this screen opens
    // on something real, then re-render into it.
    wizard.defaultEngine = found[0].id;
  }
  renderWizardStep();
}


/**
 * What to do when mkcert is missing — or when we could not tell.
 *
 * NON-BLOCKING, unlike the engine gate. TangleClaw works over plain HTTP on
 * localhost and the login gate is a separate mechanism, so a missing mkcert
 * costs you trusted certificates, not a working install. It warns and offers the
 * fix; Skip for now stays available.
 *
 * TangleClaw does NOT run the install. It is a launchd service with no terminal,
 * `brew install` can prompt, and `mkcert -install` needs sudo to touch the trust
 * store — the reason every privileged step lives in the human-run installer
 * rather than the daemon.
 *
 * @param {boolean} probeFailed - True when the check itself did not answer, as
 *   opposed to answering "not installed". Telling someone who HAS mkcert that
 *   they do not is the defect this separation exists to prevent.
 * @returns {string} HTML.
 */
function _mkcertHelpHtml(probeFailed) {
  const lead = probeFailed
    ? 'TangleClaw could not check whether mkcert is installed, so it cannot offer to generate '
      + 'certificates for you. If you know it is installed, press Check again; otherwise you can '
      + 'continue without HTTPS and set it up later.'
    : 'mkcert generates certificates your browser already trusts. Install it in a terminal on '
      + 'this Mac, then press Check again — or continue without HTTPS and set it up later.';
  const command = 'brew install mkcert && mkcert -install';
  return `<div class="setup-engine-install">
    <p class="setup-text-muted">${lead}</p>
    ${probeFailed ? '' : `<div class="setup-engine-install-cmd">
      <code>${esc(command)}</code>
      <button class="btn btn-small" type="button"
              onclick="wizardCopyInstall(${esc(JSON.stringify(command))})">Copy</button>
    </div>
    <a class="setup-engine-install-docs" href="https://github.com/FiloSottile/mkcert"
       target="_blank" rel="noopener noreferrer">Install instructions &rarr;</a>`}
    <div>
      <button class="btn btn-small" type="button" id="setupMkcertRecheck"
              onclick="wizardRecheckMkcert()">Check again</button>
    </div>
    <div id="setupEngineCopyNote" class="form-hint hidden" role="status"></div>
  </div>`;
}

/**
 * Re-run the mkcert probe after the operator has installed it.
 * @returns {Promise<void>}
 */
async function wizardRecheckMkcert() {
  const btn = document.getElementById('setupMkcertRecheck');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  // Force the probe to run again rather than render the answer it already had.
  wizard.httpsCheckLoaded = false;
  await renderHttpsSetup(document.getElementById('setupBody'));
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
      // The probe FAILED — the server did not answer, or answered without an
      // mkcert block. That is not the same as "mkcert is not installed", and
      // recording it as `false` told an operator who has mkcert, flatly, that
      // they do not. Same shape as #861: an unknown state falling through to a
      // definite one. `null` stays null; the screen says it could not check.
      wizard.mkcertAvailable = null;
    }
    if (!wizard.httpsMode) {
      // `=== true` because unknown is now `null`, and only a CONFIRMED mkcert
      // should preselect the mode that depends on it — the radio is disabled in
      // every other state, and preselecting a disabled option leaves the step
      // looking chosen and unadvanceable.
      wizard.httpsMode = wizard.mkcertAvailable === true ? 'mkcert' : 'manual';
    }
    wizard.httpsCheckLoaded = true;
    renderHttpsSetup(body);
    return;
  }

  const available = wizard.mkcertAvailable === true;
  // Distinguished from `false` on purpose: unknown is not absent.
  const probeFailed = wizard.mkcertAvailable === null;
  const mode = wizard.httpsMode;
  const statusBadge = available
    ? '<span class="setup-https-badge setup-https-badge-ok">mkcert detected</span>'
    : probeFailed
      ? '<span class="setup-https-badge setup-https-badge-warn">could not check for mkcert</span>'
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
      ${available ? '' : _mkcertHelpHtml(probeFailed)}
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
  if (wizard.adminStepForcedByServer && !(plan && plan.action === 'provision')) {
    // The server insists on a credential while the probe says a gate cannot be
    // provisioned here. Both are true: it will be stored, and TangleClaw cannot say
    // it will be enforced. Claiming "will be created" would be the more comforting
    // and less accurate of the two.
    return wizard.adminUser
      ? `Will be saved for ${wizard.adminUser} — not confirmed as enforced`
      : 'Required, not set';
  }
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
  // The server decides whether protection is CONFIRMED and ships the answer; this
  // used to re-derive it by comparing `ingress.protection` against a literal list,
  // which made the browser a second source of truth for a security decision (#861).
  // Read as "anything not positively confirmed lands here", so a protection state
  // this build has never heard of shows the warning instead of dismissing past it.
  // Dismissing into a dashboard that looks identical to a protected one is the exact
  // failure this screen exists to prevent.
  if (ingress && !ingress.confirmedProtection) {
    _showUnprotectedScreen(ingress, carried);
    return;
  }

  if (result.restart) {
    // Backend always supplies redirectUrl with restart today, but fall back
    // to the current origin so the overlay still shows while the server
    // cycles — otherwise the normal dismiss flow would run fetches against
    // a process that's exiting.
    _showRestartOverlay(result.redirectUrl || (window.location && window.location.origin) || '/',
      carried, result.redirectVia);
    return;
  }

  // Successful adopt, or nothing to report. Warnings still must not be dropped by
  // the dismiss that follows the render which showed them — an adopted install can
  // carry a skipped-project warning like any other.
  if (carried.length > 0) {
    _showAdoptedScreen(ingress, carried);
    return;
  }

  // Refresh state and dismiss — dismissWizard() handles loadProjects()
  await loadConfig();
  dismissWizard();
}

/**
 * Terminal screen for a setup that finished without needing to provision anything
 * and DID have something to report — today that is the successful-adopt path.
 * Keyed on there being warnings, not on the protection state: its reason for
 * existing is that the render which surfaces warnings must not also be the render
 * that closes the overlay carrying them. With nothing to report the caller
 * dismisses instead, so this never adds a click for an uneventful setup.
 * @param {object|null} ingress - `ingress` block from POST /api/setup/complete.
 * @param {string[]} warnings - Server warnings to restate here.
 */
function _showAdoptedScreen(ingress, warnings) {
  _clearOverlayError();
  wizard.view = 'adopted';
  const body = document.getElementById('setupBody');
  if (!body) return;
  const user = ingress && ingress.user ? ingress.user : null;
  body.innerHTML = `
    <div class="setup-step" role="status" aria-live="polite">
      <h2 class="setup-heading">Setup finished</h2>
      <p class="setup-text">Your existing login${user ? ` for <strong>${esc(user)}</strong>` : ''} is in place — TangleClaw did not change it.</p>
      ${_warningsBlock(warnings)}
      <button class="btn btn-primary setup-btn" onclick="_finishAfterProvisioning()">Continue</button>
    </div>`;
}

/**
 * Re-ask the server for the login plan and, if it now says a credential is
 * required, jump to the admin step. Recovery path for a completion the server
 * refused because the wizard's plan was missing or stale.
 * @returns {Promise<void>}
 */
async function _recoverToAdminStep() {
  await loadIngressPlan();
  if (!_adminStepRequired()) {
    // The server demanded a credential and the probe disagrees — an install already
    // behind Caddy whose credential would have come from adopting its Caddyfile is
    // the reachable case. The server is authoritative about what it will accept, so
    // show the step rather than leaving the operator with no way forward.
    //
    // Carried as its OWN signal, never by overwriting `ingressPlan`: that field is
    // the server's answer and the one thing this file documents as never
    // client-derived. Synthesizing `action: 'provision'` into it made the confirm
    // summary read "Login: Will be created for <user>" on a machine where the
    // server will instead store the credential and report the ingress unchanged.
    wizard.adminStepForcedByServer = true;
  }
  _syncSkipButton();
  const keys = wizardStepKeys();
  const idx = keys.indexOf('admin');
  if (idx >= 0) {
    wizard.view = 'steps';
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
 *
 * `alreadyShown` is prose THIS screen has already printed above the block. The
 * server puts the ingress `reason` in both `reason` and `warnings` on purpose —
 * `warnings` is the complete list for clients that read nothing else — so a screen
 * that prints the reason itself would otherwise show the identical sentence twice.
 * Pass it only from a screen that actually renders the text: passing it from one
 * that does not would delete the warning instead of de-duplicating it.
 * @param {string[]} warnings
 * @param {string} [alreadyShown] - Text this screen already rendered; dropped from the list.
 * @returns {string} HTML, or '' when there is nothing to say.
 */
function _warningsBlock(warnings, alreadyShown) {
  const seen = typeof alreadyShown === 'string' ? alreadyShown.trim() : '';
  const list = Array.isArray(warnings)
    ? warnings.filter((w) => typeof w === 'string' && w && !(seen && w.trim() === seen))
    : [];
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
  _clearOverlayError();
  wizard.view = 'provisioning';
  wizard.provision = {
    phase: 'working',
    url: ingress.url || null,
    user: ingress.user || null,
    code: null,
    hasError: false,
    // Seeded from the COMPLETION response, then refreshed by any poll that
    // answers. Never a literal here: that would be a second copy of a server
    // constant. Seeding matters because the poll may never answer at all — the
    // cutover closes the address this page was served from, which for a remote
    // operator is the common case — and the screen that results is the one with
    // the least information and the most need to say where the rest was written.
    logLocation: ingress.logLocation || null,
    // Whether the cutover's own health probe came back green. `null` until a poll
    // answers. Distinct from `ok`, which says only that the plan was applied: an
    // applied plan whose gate never answered must not claim a login is in force.
    healthOk: null,
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
    // Every answer carries it, `pending` included — see logLocation's note above.
    if (data && data.logLocation) wizard.provision.logLocation = data.logLocation;
    if (data && data.state === 'done') {
      wizard.provision.healthOk = typeof data.healthOk === 'boolean' ? data.healthOk : null;
      // `ok` says the plan was applied. `healthOk` says the gate actually answered.
      // Only both together justify "your login is in force" — the chunk's rule is
      // that no screen claims protection it did not observe, and a cutover whose
      // health probe never came back green is precisely an unobserved gate. It is
      // not a failure either: the plan IS applied, so `failed` would be its own
      // false report. That is what 'unconfirmed' is for.
      if (data.ok && wizard.provision.healthOk === false) {
        wizard.provision.phase = 'unconfirmed';
        wizard.provision.code = data.code || null;
        wizard.provision.hasError = data.hasError === true;
        _renderProvisionScreen();
        return;
      }
      wizard.provision.phase = data.ok ? 'gated' : 'failed';
      wizard.provision.code = data.code || null;
      wizard.provision.hasError = data.hasError === true;
      _renderProvisionScreen();
      return;
    }
    if (data && data.state === 'unparseable-result') {
      wizard.provision.phase = 'failed';
      wizard.provision.code = null;
      wizard.provision.hasError = true;
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

  // 'unconfirmed' — three ways in, and which one it was IS the content of this
  // screen. Two are deadline expiries, told apart by `reachable`, the only
  // evidence available: claiming the origin closed when it never did would send an
  // operator whose cutover merely stalled to --rollback for no reason. The third
  // is different in kind — the cutover DID report, saying it applied the plan and
  // could not then confirm the gate answers (`healthOk === false`). That one is
  // not waiting on anything, so it gets its own heading rather than being
  // described as not having reported back.
  const openedCheck = url
    ? `<p class="setup-text">Open <code>${esc(url)}</code>. <strong>If it asks for a username and password, your login is in force.</strong> If it loads without asking, it is not.</p>`
    : '';
  const rollback = '<p class="setup-text-muted">If nothing loads at all, run <code>node scripts/ingress-cutover.js --rollback</code> at a terminal to put TangleClaw back the way it was.</p>';

  body.innerHTML = p.reachable
    ? `
    <div class="setup-step" role="alert">
      <h2 class="setup-heading">${p.healthOk === false
        ? 'Applied — but the login could not be confirmed'
        : 'Started — but it hasn\'t reported back'}</h2>
      ${p.healthOk === false
        ? '<p class="setup-text">The login was applied, but TangleClaw could not reach the gated address afterwards to check that it answers. <strong>It may or may not be asking for a password</strong> — this page did not observe it, so it will not claim it.</p>'
        : '<p class="setup-text">TangleClaw is still reachable at this address and the login setup has not said how it ended. <strong>It may or may not have finished</strong> — this page cannot tell you which, so it will not guess.</p>'}
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
      ${p.logLocation ? `<p class="setup-text-muted">What it was doing is in <code>${esc(p.logLocation)}</code>.</p>` : ''}
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
  _clearOverlayError();
  wizard.view = 'unprotected';
  const body = document.getElementById('setupBody');
  if (!body) return;

  // Several states land here and they are not the same claim: a credential may be
  // stored while TangleClaw cannot say it is being enforced, or there may be no login
  // at all. Asserting "nothing is asking for a password" in the first case would be a
  // guess in the other direction. Which of the two applies is the server's call and
  // arrives as `credentialStored` (#861) — the enum is deliberately not read here.
  const stored = ingress.credentialStored === true;
  const heading = stored ? 'Your login is saved, but not confirmed' : 'TangleClaw has no login';
  const lead = stored
    ? `<p class="setup-text">A login is saved, but TangleClaw <strong>cannot confirm anything is enforcing it</strong> — it did not change the Caddy config, which is maintained by hand.</p>`
    : `<p class="setup-text"><strong>Nothing is asking for a password.</strong> ${esc(ingress.reason || 'TangleClaw could not put a login in front of itself on this machine.')}</p>`;

  body.innerHTML = `
    <div class="setup-step" role="alert">
      <h2 class="setup-heading">${esc(heading)}</h2>
      ${lead}
      ${stored && ingress.reason ? `<p class="setup-text-muted">${esc(ingress.reason)}</p>` : ''}
      ${ingress.remedy ? `<p class="setup-text-muted">${esc(ingress.remedy)}</p>` : ''}
      <p class="setup-text-muted">${_exposureSentence(ingress.networkExposed === true)}</p>
      ${_warningsBlock(warnings, ingress.reason)}
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

/**
 * Terminal screen shown while the server restarts to apply a new HTTPS config.
 * @param {string} redirectUrl - Where the operator will be able to reach TangleClaw.
 * @param {string[]} [warnings] - Server warnings to restate here, since this screen
 *   replaces the body that reported them.
 */
function _showRestartOverlay(redirectUrl, warnings, via) {
  _clearOverlayError();
  // Every terminal screen owes the same three things, and this one was outside all
  // of them: claim the view (the ingress probe re-renders asynchronously and would
  // repaint it), announce itself (it appears without the operator acting), and
  // carry the server's warnings (the element that reported them is inside the body
  // this replaces).
  wizard.view = 'restarting';
  const body = document.getElementById('setupBody');
  if (!body) return;
  _renderRestartOverlay(redirectUrl, warnings, 'waiting', via);
  // Only probe when a response from that address would MEAN anything. Behind
  // Caddy it does not: the proxy stays up across TangleClaw's restart and answers
  // straight away — with a 502, which an opaque `no-cors` probe cannot tell from
  // success. Probing there would paint "TangleClaw is back up" over a server that
  // is still down, and send the operator into an error page. Not observing is the
  // honest state, and this screen already has words for it.
  if (via === 'proxy') {
    _renderRestartOverlay(redirectUrl, warnings, 'behind-proxy', via);
    return;
  }
  _pollRestartReady(redirectUrl, warnings);
}

/**
 * Paint the restart overlay for one readiness state.
 *
 * Navigation is ALWAYS the button, never this function — see `_pollRestartReady`.
 * @param {string} redirectUrl - Where TangleClaw will be reachable.
 * @param {string[]} [warnings] - Server warnings to restate.
 * @param {'waiting'|'ready'|'unconfirmed'|'behind-proxy'} state - What the probe
 *   has observed, or `behind-proxy` where no probe can observe anything.
 * @param {string} [via] - `'proxy'` when the address is fronted by Caddy.
 */
function _renderRestartOverlay(redirectUrl, warnings, state, via) {
  const body = document.getElementById('setupBody');
  if (!body) return;
  const go = `<button class="btn btn-primary setup-btn" onclick="window.location.href='${esc(redirectUrl)}'">Open ${esc(redirectUrl)}</button>`;
  const panel = {
    waiting: `
        <div class="spinner"></div>
        <p class="setup-text">The server is restarting with your new HTTPS configuration.</p>
        <p class="setup-text-muted">When it is back, open <code>${esc(redirectUrl)}</code>.</p>`,
    ready: `
        <p class="setup-text">TangleClaw is back up at <code>${esc(redirectUrl)}</code>.</p>
        <p class="setup-text-muted">This address will not work any more.</p>`,
    unconfirmed: `
        <p class="setup-text">The server was restarting, and this page has not seen it come back at <code>${esc(redirectUrl)}</code>.</p>
        <p class="setup-text-muted">That may just mean this page cannot reach the new address — try opening it. If nothing loads, check <code>~/.tangleclaw/logs/</code>.</p>`,
    // Deliberately claims nothing about readiness. Caddy answers at this address
    // whether or not TangleClaw is back, so there is nothing this page could
    // check that would mean anything — and saying "it is back up" on the strength
    // of the proxy replying is a report of something never observed.
    'behind-proxy': `
        <p class="setup-text">TangleClaw is restarting behind your login at <code>${esc(redirectUrl)}</code>.</p>
        <p class="setup-text-muted">Give it a moment, then open it. <strong>If it asks for your username and password, it is back.</strong> If you get an error page, it is still starting — wait and reload.</p>`
  }[state];
  // The heading names the operation and stays put across all three states; the
  // panel below carries what has been observed. A heading that changes underneath
  // the operator reads as a different screen appearing on its own.
  body.innerHTML = `
    <div class="setup-step" role="status" aria-live="polite"${state === 'waiting' ? ' aria-busy="true"' : ''}>
      <h2 class="setup-heading">Restarting TangleClaw…</h2>
      <div class="setup-https-restart-panel">${panel}
        ${go}
      </div>
      ${_warningsBlock(warnings)}
    </div>`;
}

/**
 * Probe the post-restart address and report what it finds. It never navigates.
 *
 * The probe used to redirect on success and then redirect ANYWAY at a 20s
 * deadline, with no evidence the server had come back. Both are timer-driven UI
 * lifecycle, which this project does not do (#98, #268): a page that moves on its
 * own takes the decision away at exactly the moment the operator needs to read
 * what happened, and the deadline branch actively asserted something it had not
 * observed. The polling stays — knowing the server is back is genuinely useful —
 * but it only ever changes the words on screen. Leaving is the button.
 * @param {string} redirectUrl - Address to probe.
 * @param {string[]} [warnings] - Warnings to keep on screen across re-renders.
 * @returns {Promise<void>}
 */
async function _pollRestartReady(redirectUrl, warnings) {
  const deadline = Date.now() + 20000;
  // Give the server time to actually exit before we start probing.
  await new Promise((r) => setTimeout(r, 1200));
  while (Date.now() < deadline) {
    try {
      await fetch(redirectUrl, { mode: 'no-cors', cache: 'no-store' });
      if (wizard.view === 'restarting') _renderRestartOverlay(redirectUrl, warnings, 'ready');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  if (wizard.view === 'restarting') _renderRestartOverlay(redirectUrl, warnings, 'unconfirmed');
}
