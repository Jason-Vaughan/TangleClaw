'use strict';
/* ── TangleClaw v3 — Landing Page: UI & Interactions ── */
/* Rendering, modals, drawers, event bindings. Depends on landing.js. */

// ── Project Card Rendering ──

function renderProjects() {
  const grid = document.getElementById('cardsGrid');
  const filtered = filterProjects();

  if (state.projects.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <h2>No projects yet</h2>
      <p>Create your first project to get started with AI-assisted development.</p>
      <button class="btn btn-primary" onclick="openCreateDrawer()">+ Create Project</button>
    </div>`;
    return;
  }

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <p>No projects match your filter.</p>
    </div>`;
    return;
  }

  // Root directory panel
  const rootHtml = renderRootPanel();
  grid.innerHTML = rootHtml + filtered.map(renderCard).join('');
}

function renderRootPanel() {
  if (!state.config || !state.config.projectsDir) return '';
  const totalCount = state.projects.length;
  const registered = state.projects.filter(p => p.registered !== false).length;
  return `<div class="root-panel">
    <span class="root-label">ROOT</span>
    <span class="root-path">${esc(state.config.projectsDir)}</span>
    <span class="root-count">${registered} registered / ${totalCount} total</span>
  </div>`;
}

function renderCard(project) {
  // Unregistered project — show muted style with Attach button
  if (project.registered === false) {
    return renderUnregisteredCard(project);
  }

  const hasSession = project.session && project.session.active;
  const sessionClass = hasSession ? ' has-session' : '';
  const n = esc(project.name);

  const versionBadge = project.git && project.git.latestTag
    ? `<span class="badge badge-version">${esc(project.git.latestTag)}</span>`
    : '';

  const gitBadge = project.git
    ? `<span class="badge badge-git">${esc(project.git.branch)}${project.git.dirty ? '<span class="git-dirty"></span>' : ''}</span>`
    : '';

  const engineBadge = project.engine
    ? `<span class="badge badge-engine">${esc(project.engine.name)}</span>`
    : '';

  const methBadge = project.methodology
    ? `<span class="badge badge-meth">${esc(project.methodology.name)}</span>`
    : '';

  let phaseBadge = '';
  if (project.methodology) {
    if (project.methodology.phase) {
      phaseBadge = `<span class="badge badge-phase">${esc(project.methodology.phase)}</span>`;
    } else {
      const inferredState = hasSession ? 'in session'
        : (project.git && project.git.dirty) ? 'active'
        : 'idle';
      phaseBadge = `<span class="badge badge-phase-unknown">${inferredState}</span>`;
    }
  }

  const statusDot = hasSession
    ? `<span class="status-dot active" title="Session active"></span>`
    : `<span class="status-dot" title="No active session"></span>`;

  return `<article class="project-card compact${sessionClass}" tabindex="0"
    onclick="toggleCardDetail('${n}')" onkeydown="if(event.key==='Enter')toggleCardDetail('${n}')">
    <div class="card-row">
      ${statusDot}
      <span class="card-name" title="${n}">${n}</span>
      ${versionBadge}
      ${gitBadge}
      ${engineBadge}
      ${methBadge}
      ${phaseBadge}
      <span class="card-row-actions">
        <button class="btn btn-compact btn-launch" onclick="event.stopPropagation(); launchProject('${n}')">${hasSession ? 'Open' : 'Launch'}</button>
        ${hasSession ? `<button class="btn btn-compact btn-icon-tiny" onclick="event.stopPropagation(); openPeekFromCard('${n}')" title="Peek">&#128065;</button>` : ''}
        ${hasSession ? `<button class="btn btn-compact btn-icon-tiny btn-kill-card" onclick="event.stopPropagation(); openKill('${n}')" title="Kill session">&#9632;</button>` : ''}
        <button class="btn btn-compact btn-icon-tiny" onclick="event.stopPropagation(); openSettings('${n}')" title="Info">i</button>
        <button class="btn btn-compact btn-icon-tiny btn-detach-subtle" onclick="event.stopPropagation(); openDetach('${n}')" title="Detach from TangleClaw">&#8856;</button>
        <button class="btn btn-compact btn-icon-tiny btn-danger-subtle" onclick="event.stopPropagation(); openDelete('${n}')" title="Delete project">&times;</button>
      </span>
    </div>
  </article>`;
}

function renderUnregisteredCard(project) {
  const n = esc(project.name);
  const gitBadge = project.git
    ? `<span class="badge badge-git">${esc(project.git.branch)}${project.git.dirty ? '<span class="git-dirty"></span>' : ''}</span>`
    : '';

  const methBadge = project.methodology
    ? `<span class="badge badge-meth">${esc(project.methodology.name)}</span>`
    : '';

  return `<article class="project-card compact unregistered" tabindex="0">
    <div class="card-row">
      <span class="status-dot unregistered"></span>
      <span class="card-name card-name-muted" title="${n}">${n}</span>
      ${gitBadge}
      ${methBadge}
      <span class="card-row-actions">
        <button class="btn btn-compact btn-attach" onclick="event.stopPropagation(); attachProject('${n}')">Attach</button>
      </span>
    </div>
  </article>`;
}

function toggleCardDetail(name) {
  const cards = document.querySelectorAll('.project-card');
  for (const card of cards) {
    const nameEl = card.querySelector('.card-name');
    if (!nameEl || nameEl.textContent !== name) continue;

    const existing = card.querySelector('.card-detail');
    if (existing) {
      existing.remove();
      return;
    }

    // Close other open details
    document.querySelectorAll('.card-detail').forEach(el => el.remove());

    const project = state.projects.find(p => p.name === name);
    if (!project) return;

    const detail = document.createElement('div');
    detail.className = 'card-detail';

    const engineInfo = project.engine ? `${esc(project.engine.name)}` : 'No engine';
    const methInfo = project.methodology ? `${esc(project.methodology.name)}${project.methodology.phase ? ' — ' + esc(project.methodology.phase) : ''}` : 'No methodology';
    const sessionInfo = project.session && project.session.active
      ? `Active since ${esc(project.session.startedAt || '')}`
      : 'No active session';
    const tagsInfo = (project.tags || []).length > 0 ? project.tags.map(t => esc(t)).join(', ') : 'None';
    const gitInfo = project.git ? `${esc(project.git.branch)}${project.git.dirty ? ' (dirty)' : ''}` : 'Not a git repo';

    detail.innerHTML = `
      <div class="detail-row"><span class="detail-label">Engine</span><span class="detail-value">${engineInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Methodology</span><span class="detail-value">${methInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Session</span><span class="detail-value">${sessionInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Git</span><span class="detail-value">${gitInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Tags</span><span class="detail-value">${tagsInfo}</span></div>
      <div class="detail-actions">
        <button class="btn btn-compact" onclick="event.stopPropagation(); openSettings('${esc(name)}')">Settings</button>
        ${project.session && project.session.active ? `<button class="btn btn-compact btn-kill-card" onclick="event.stopPropagation(); openKill('${esc(name)}')">Kill Session</button>` : ''}
        <button class="btn btn-compact btn-danger-subtle" onclick="event.stopPropagation(); openDelete('${esc(name)}')">Delete</button>
      </div>`;

    card.appendChild(detail);
    return;
  }
}

async function attachProject(name) {
  const data = await apiMutate('/api/projects/attach', 'POST', { name });
  if (data) {
    await loadProjects();
  }
}

async function openPeekFromCard(name) {
  const project = state.projects.find(p => p.name === name);
  if (!project || !project.session || !project.session.active) return;

  // Toggle existing peek panel
  const existingPeek = document.querySelector(`.card-peek[data-project="${CSS.escape(name)}"]`);
  if (existingPeek) {
    existingPeek.remove();
    return;
  }

  // Close any other open peeks
  document.querySelectorAll('.card-peek').forEach(el => el.remove());

  // Find the card and insert peek panel after the actions
  const cards = document.querySelectorAll('.project-card');
  let targetCard = null;
  for (const card of cards) {
    if (card.querySelector('.card-name') && card.querySelector('.card-name').textContent === name) {
      targetCard = card;
      break;
    }
  }
  if (!targetCard) return;

  const peekEl = document.createElement('div');
  peekEl.className = 'card-peek';
  peekEl.setAttribute('data-project', name);
  peekEl.innerHTML = '<pre class="card-peek-content">Loading\u2026</pre>';
  targetCard.appendChild(peekEl);

  const data = await api(`/api/sessions/${encodeURIComponent(name)}/peek?lines=15`);
  const contentEl = peekEl.querySelector('.card-peek-content');
  if (data && data.lines) {
    contentEl.textContent = data.lines.join('\n');
    contentEl.scrollTop = contentEl.scrollHeight;
  } else {
    contentEl.textContent = 'No output available';
  }
}

function renderSessionCount() {
  const active = state.projects.filter(p => p.session && p.session.active).length;
  const el = document.getElementById('sessionCount');
  el.innerHTML = `<span class="count-num">${active}</span> active session${active !== 1 ? 's' : ''}`;
}

function renderTagRow() {
  const row = document.getElementById('tagRow');
  const unregCount = state.projects.filter(p => p.registered === false).length;
  if (state.allTags.length === 0 && unregCount === 0) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  const pills = ['All', ...state.allTags].map(tag => {
    const isAll = tag === 'All';
    const active = isAll ? !state.activeTag : state.activeTag === tag;
    return `<button class="tag-pill${active ? ' active' : ''}"
      onclick="toggleTag(${isAll ? 'null' : `'${esc(tag)}'`})">${esc(tag)}</button>`;
  });

  // Unattached toggle pill
  if (unregCount > 0) {
    const active = state.showUnregistered;
    pills.push(`<button class="tag-pill tag-pill-unreg${active ? ' active' : ''}" id="unregisteredToggle"
      onclick="toggleUnregistered()">${unregCount} unattached</button>`);
  }

  row.innerHTML = pills.join('');
}

// ── Stats Toggle ──

function toggleStats() {
  state.statsOpen = !state.statsOpen;
  const grid = document.getElementById('statsGrid');
  const arrow = document.querySelector('#statsToggle .arrow');
  const toggle = document.getElementById('statsToggle');
  grid.classList.toggle('open', state.statsOpen);
  arrow.classList.toggle('open', state.statsOpen);
  toggle.setAttribute('aria-expanded', state.statsOpen);
}

// ── Ports Toggle ──

function togglePorts() {
  state.portsOpen = !state.portsOpen;
  const grid = document.getElementById('portsGrid');
  const arrow = document.querySelector('#portsToggle .arrow');
  const toggle = document.getElementById('portsToggle');
  grid.classList.toggle('open', state.portsOpen);
  arrow.classList.toggle('open', state.portsOpen);
  toggle.setAttribute('aria-expanded', state.portsOpen);
}

function renderPorts() {
  const grid = document.getElementById('portsGrid');
  if (state.ports.length === 0) {
    grid.innerHTML = '<div class="ports-empty">No port leases</div>';
    return;
  }

  // Group by project
  const grouped = {};
  for (const lease of state.ports) {
    if (!grouped[lease.project]) grouped[lease.project] = [];
    grouped[lease.project].push(lease);
  }

  // Default all groups to open if not yet set
  for (const project of Object.keys(grouped)) {
    if (!(project in state.portGroupsOpen)) {
      state.portGroupsOpen[project] = true;
    }
  }

  let html = '';
  for (const [project, leases] of Object.entries(grouped)) {
    const isOpen = state.portGroupsOpen[project] !== false;
    const arrowClass = isOpen ? 'arrow open' : 'arrow';
    const contentClass = isOpen ? 'port-group-content open' : 'port-group-content';

    html += `<div class="port-group">`;
    html += `<div class="port-group-toggle" role="button" tabindex="0"
      aria-expanded="${isOpen}" onclick="togglePortGroup('${esc(project)}')"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();togglePortGroup('${esc(project)}');}">
      <span class="${arrowClass}">&#9660;</span>
      <span class="port-group-name">${esc(project)}</span>
      <span style="color:var(--text-muted);font-size:10px">(${leases.length})</span>
    </div>`;
    html += `<div class="${contentClass}">`;
    for (const lease of leases) {
      const typeClass = lease.permanent ? 'port-type-permanent' : 'port-type-ttl';
      const typeLabel = lease.permanent ? 'permanent' : 'TTL';
      html += `<div class="port-lease">
        <span class="port-number">${lease.port}</span>
        <span class="port-project">${esc(project)}</span>
        <span class="port-service">${esc(lease.service)}</span>
        <span class="port-type ${typeClass}">${typeLabel}</span>
      </div>`;
    }
    html += '</div></div>';
  }

  grid.innerHTML = html;
}

function togglePortGroup(project) {
  state.portGroupsOpen[project] = !state.portGroupsOpen[project];
  renderPorts();
}

// ── Rules Toggle ──

/**
 * Toggle the global rules panel open/closed.
 */
function toggleRules() {
  state.rulesOpen = !state.rulesOpen;
  const panel = document.getElementById('rulesPanel');
  const arrow = document.querySelector('#rulesToggle .arrow');
  const toggle = document.getElementById('rulesToggle');
  panel.classList.toggle('open', state.rulesOpen);
  arrow.classList.toggle('open', state.rulesOpen);
  toggle.setAttribute('aria-expanded', state.rulesOpen);
}

/**
 * Open the reset confirmation modal.
 */
function openRulesResetModal() {
  document.getElementById('rulesResetModal').classList.add('open');
}

/**
 * Close the reset confirmation modal.
 */
function closeRulesResetModal() {
  document.getElementById('rulesResetModal').classList.remove('open');
}

/**
 * Confirm reset: call API then close modal.
 */
async function confirmRulesReset() {
  await resetGlobalRules();
  closeRulesResetModal();
}

// ── Filter Toggle ──

function toggleFilter() {
  const section = document.getElementById('filterSection');
  const btn = document.getElementById('filterBtn');
  const isHidden = section.classList.contains('hidden');
  section.classList.toggle('hidden', !isHidden);
  btn.setAttribute('aria-expanded', isHidden);
  if (isHidden) {
    document.getElementById('filterInput').focus();
  }
}

function maybeShowFilter() {
  if (state.projects.length > 10) {
    document.getElementById('filterSection').classList.remove('hidden');
    document.getElementById('filterBtn').setAttribute('aria-expanded', 'true');
  }
}

// ── Delete / Detach Project Modal ──

let deleteTarget = null;
let deleteMode = 'delete'; // 'delete' = remove + delete files, 'detach' = remove from TC only

/**
 * Open the modal in detach mode (non-destructive).
 * @param {string} name
 */
function openDetach(name) {
  deleteTarget = name;
  deleteMode = 'detach';
  const modal = document.getElementById('deleteModal');

  document.getElementById('deleteModalTitle').textContent = 'Detach Project';
  document.getElementById('deleteModalTitle').style.color = 'var(--text-muted)';
  document.getElementById('deleteText').innerHTML =
    `Detach <strong>${esc(name)}</strong> from TangleClaw?`;
  document.getElementById('deleteSubtext').innerHTML =
    'The project will be removed from TangleClaw but <strong>files stay on disk</strong>. It can be re-attached later.';
  document.getElementById('deleteError').classList.add('hidden');
  document.getElementById('deletePassword').value = '';

  // No type-to-confirm for detach — it's non-destructive
  document.getElementById('deleteConfirmGroup').classList.add('hidden');
  document.getElementById('deleteConfirmBtn').disabled = false;
  document.getElementById('deleteConfirmBtn').textContent = 'Detach';
  document.getElementById('deleteConfirmBtn').className = 'btn btn-detach';

  const pwGroup = document.getElementById('deletePasswordGroup');
  if (state.config && state.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  modal.classList.add('open');
}

/**
 * Open the modal in delete mode (destructive — removes files from disk).
 * @param {string} name
 */
function openDelete(name) {
  deleteTarget = name;
  deleteMode = 'delete';
  const modal = document.getElementById('deleteModal');

  document.getElementById('deleteModalTitle').textContent = 'Delete Project';
  document.getElementById('deleteModalTitle').style.color = 'var(--danger)';
  document.getElementById('deleteText').innerHTML =
    `Permanently delete <strong style="color:var(--danger)">${esc(name)}</strong>?`;
  document.getElementById('deleteSubtext').innerHTML =
    'This will remove the project from TangleClaw, kill any active session, and <strong style="color:var(--danger)">delete all project files from disk</strong>. This cannot be undone.';
  document.getElementById('deleteError').classList.add('hidden');
  document.getElementById('deletePassword').value = '';

  // Type-to-confirm for destructive delete
  const confirmGroup = document.getElementById('deleteConfirmGroup');
  confirmGroup.classList.remove('hidden');
  document.getElementById('deleteConfirmInput').value = '';
  document.getElementById('deleteConfirmInput').placeholder = name;
  document.getElementById('deleteConfirmBtn').disabled = true;
  document.getElementById('deleteConfirmBtn').textContent = 'Delete Project';
  document.getElementById('deleteConfirmBtn').className = 'btn btn-danger';

  const pwGroup = document.getElementById('deletePasswordGroup');
  if (state.config && state.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  modal.classList.add('open');
  setTimeout(() => document.getElementById('deleteConfirmInput').focus(), 100);
}

/**
 * Handle typing in the confirm input (only active for delete mode).
 */
function onDeleteConfirmInput() {
  if (deleteMode !== 'delete') return;
  const val = document.getElementById('deleteConfirmInput').value.trim();
  document.getElementById('deleteConfirmBtn').disabled = val !== deleteTarget;
}

/**
 * Close the delete/detach modal and reset state.
 */
function closeDelete() {
  document.getElementById('deleteModal').classList.remove('open');
  deleteTarget = null;
  deleteMode = 'delete';
}

/**
 * Execute the delete or detach action.
 */
async function confirmDelete() {
  if (!deleteTarget) return;

  // For delete mode, require type-to-confirm
  if (deleteMode === 'delete') {
    const confirmVal = document.getElementById('deleteConfirmInput').value.trim();
    if (confirmVal !== deleteTarget) return;
  }

  const pw = document.getElementById('deletePassword').value;
  const body = { deleteFiles: deleteMode === 'delete' };
  if (pw) body.password = pw;

  const data = await apiMutate(`/api/projects/${encodeURIComponent(deleteTarget)}`, 'DELETE', body);
  if (!data) {
    const action = deleteMode === 'detach' ? 'Detach' : 'Delete';
    document.getElementById('deleteError').textContent = `${action} failed. Check password.`;
    document.getElementById('deleteError').classList.remove('hidden');
    return;
  }
  closeDelete();
  await loadProjects();
}

// ── Kill Session Modal ──

let killTarget = null;

function openKill(name) {
  killTarget = name;
  const modal = document.getElementById('killModal');
  document.getElementById('killText').innerHTML =
    `Kill the active session for <strong>${esc(name)}</strong>? This terminates the tmux session immediately.`;
  document.getElementById('killError').classList.add('hidden');
  document.getElementById('killPassword').value = '';

  const pwGroup = document.getElementById('killPasswordGroup');
  if (state.config && state.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  modal.classList.add('open');
}

function closeKill() {
  document.getElementById('killModal').classList.remove('open');
  killTarget = null;
}

async function confirmKill() {
  if (!killTarget) return;

  const pw = document.getElementById('killPassword').value;
  const body = { reason: 'Killed from landing page' };
  if (pw) body.password = pw;

  const res = await fetch(`/api/sessions/${encodeURIComponent(killTarget)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    document.getElementById('killError').textContent = data.error || 'Kill failed.';
    document.getElementById('killError').classList.remove('hidden');
    return;
  }

  closeKill();
  await loadProjects();
}

// ── Settings Modal ──

let settingsTarget = null;

function openSettings(name) {
  settingsTarget = name;
  const project = state.projects.find(p => p.name === name);
  if (!project) return;
  const modal = document.getElementById('settingsModal');
  document.getElementById('settingsTitle').textContent = `Settings: ${name}`;

  const engineOpts = state.engines.map(e =>
    `<option value="${esc(e.id)}" ${e.id === (project.engine ? project.engine.id : '') ? 'selected' : ''}>${esc(e.name)}${e.available === false ? ' (not installed)' : ''}</option>`
  ).join('');

  const currentMeth = project.methodology ? project.methodology.id : 'none';
  const methOpts = `<option value="none" ${currentMeth === 'none' ? 'selected' : ''}>None</option>` +
    state.methodologies.map(m =>
      `<option value="${esc(m.id)}" ${m.id === currentMeth ? 'selected' : ''}>${esc(m.name)}</option>`
    ).join('');

  document.getElementById('settingsBody').innerHTML = `
    <div class="form-group">
      <label class="form-label" for="settingsEngine">Engine</label>
      <select class="form-select" id="settingsEngine">${engineOpts}</select>
      <div class="form-hint">Takes effect on next session launch</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="settingsMethodology">Methodology</label>
      <select class="form-select" id="settingsMethodology">${methOpts}</select>
      <div class="form-hint">Changing archives the current methodology state</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="settingsTags">Tags (comma-separated)</label>
      <input type="text" class="form-input" id="settingsTags" value="${esc((project.tags || []).join(', '))}"
             autocomplete="off" autocorrect="off" autocapitalize="off">
    </div>`;

  modal.classList.add('open');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
  settingsTarget = null;
}

async function saveSettings() {
  if (!settingsTarget) return;
  const methVal = document.getElementById('settingsMethodology').value;
  const newMeth = methVal === 'none' ? null : methVal;

  // Check if methodology is changing — show confirmation modal if so
  const project = state.projects.find(p => p.name === settingsTarget);
  const currentMeth = project && project.methodology ? project.methodology.id : null;
  if (newMeth !== currentMeth) {
    openMethSwitchModal(settingsTarget, currentMeth, newMeth);
    return;
  }

  await doSaveSettings();
}

/**
 * Show the methodology switch confirmation modal.
 * @param {string} projectName - Project being updated
 * @param {string|null} fromMeth - Current methodology id
 * @param {string|null} toMeth - New methodology id
 */
function openMethSwitchModal(projectName, fromMeth, toMeth) {
  const fromName = fromMeth ? (state.methodologies.find(m => m.id === fromMeth) || {}).name || fromMeth : 'None';
  const toName = toMeth ? (state.methodologies.find(m => m.id === toMeth) || {}).name || toMeth : 'None';

  let html = `<p style="font-size:15px;margin-bottom:12px"><strong>${esc(fromName)}</strong> &rarr; <strong>${esc(toName)}</strong></p>`;

  if (fromMeth) {
    html += `<p>The current <strong>${esc(fromName)}</strong> state will be archived (not deleted). Learnings, reflections, and other artifacts remain accessible.</p>`;
  }
  if (toMeth) {
    html += `<p style="margin-top:8px">The new <strong>${esc(toName)}</strong> methodology will be initialized and session hooks updated.</p>`;
  } else {
    html += `<p style="margin-top:8px">Session governance hooks will be removed.</p>`;
  }
  html += `<p style="margin-top:12px;font-size:12px;color:var(--text-muted)">Archived methodology state stays in the project directory and is referenced in generated configs so AI assistants can review prior context.</p>`;

  document.getElementById('methSwitchText').innerHTML = html;
  document.getElementById('methSwitchModal').classList.add('open');
}

/** Close the methodology switch modal without saving. */
function closeMethSwitchModal() {
  document.getElementById('methSwitchModal').classList.remove('open');
}

/** Confirm methodology switch and proceed with settings save. */
async function confirmMethSwitch() {
  closeMethSwitchModal();
  await doSaveSettings();
}

/** Execute the settings save (called directly or after methodology confirmation). */
async function doSaveSettings() {
  if (!settingsTarget) return;
  const methVal = document.getElementById('settingsMethodology').value;
  const body = {
    engine: document.getElementById('settingsEngine').value,
    methodology: methVal === 'none' ? null : methVal,
    tags: document.getElementById('settingsTags').value.split(',').map(t => t.trim()).filter(Boolean)
  };

  await apiMutate(`/api/projects/${encodeURIComponent(settingsTarget)}`, 'PATCH', body);
  closeSettings();
  await loadProjects();
}

// ── Global Settings Modal ──

/**
 * Open the global settings modal, loading current config values.
 */
function openGlobalSettings() {
  const c = state.config || {};
  const body = document.getElementById('globalSettingsBody');

  const engineOpts = state.engines.map(e =>
    `<option value="${esc(e.id)}" ${e.id === (c.defaultEngine || '') ? 'selected' : ''}>${esc(e.name)}${e.available === false ? ' (not installed)' : ''}</option>`
  ).join('');

  const methOpts = state.methodologies.map(m =>
    `<option value="${esc(m.id)}" ${m.id === (c.defaultMethodology || '') ? 'selected' : ''}>${esc(m.name)}</option>`
  ).join('');

  const scannerIntervalSec = Math.round((c.portScannerIntervalMs || 60000) / 1000);

  body.innerHTML = `
    <div class="gs-section-label">Appearance</div>
    <div class="form-group">
      <label class="form-label" for="gsTheme">Theme</label>
      <select class="form-select" id="gsTheme">
        <option value="dark" ${c.theme === 'dark' ? 'selected' : ''}>Dark</option>
        <option value="light" ${c.theme === 'light' ? 'selected' : ''}>Light</option>
        <option value="high-contrast" ${c.theme === 'high-contrast' ? 'selected' : ''}>High Contrast</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="gsPeekMode">Peek mode</label>
      <select class="form-select" id="gsPeekMode">
        <option value="drawer" ${c.peekMode === 'drawer' ? 'selected' : ''}>Drawer</option>
        <option value="modal" ${c.peekMode === 'modal' ? 'selected' : ''}>Modal</option>
        <option value="alert" ${c.peekMode === 'alert' ? 'selected' : ''}>Alert</option>
      </select>
    </div>
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Global chime mute</span>
        <input type="checkbox" id="gsChimeMuted" ${c.chimeMuted ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">When on, silences chime notifications in all sessions</div>
    </div>

    <div class="gs-section-label">Project Defaults</div>
    <div class="form-group">
      <label class="form-label" for="gsDefaultEngine">Default engine</label>
      <select class="form-select" id="gsDefaultEngine">${engineOpts}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="gsDefaultMethodology">Default methodology</label>
      <select class="form-select" id="gsDefaultMethodology">${methOpts}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="gsProjectsDir">Projects directory</label>
      <input type="text" class="form-input" id="gsProjectsDir" value="${esc(c.projectsDir || '~/Documents/Projects')}"
             autocomplete="off" autocorrect="off" spellcheck="false">
    </div>

    <div class="gs-section-label">Port Scanner</div>
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Port scanner enabled</span>
        <input type="checkbox" id="gsPortScannerEnabled" ${c.portScannerEnabled !== false ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">Periodically scans for listening ports via lsof</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="gsPortScannerInterval">Scan interval (seconds)</label>
      <input type="number" class="form-input" id="gsPortScannerInterval" value="${scannerIntervalSec}" min="10" max="600">
      <div class="form-hint">Min 10s, max 600s (10 min)</div>
    </div>
  `;

  document.getElementById('globalSettingsModal').classList.add('open');
}

/**
 * Close the global settings modal without saving.
 */
function closeGlobalSettings() {
  document.getElementById('globalSettingsModal').classList.remove('open');
}

/**
 * Save global settings from the modal form.
 */
async function saveGlobalSettings() {
  const intervalSec = parseInt(document.getElementById('gsPortScannerInterval').value, 10);
  const intervalMs = (isNaN(intervalSec) ? 60 : Math.min(600, Math.max(10, intervalSec))) * 1000;

  const patch = {
    theme: document.getElementById('gsTheme').value,
    peekMode: document.getElementById('gsPeekMode').value,
    chimeMuted: document.getElementById('gsChimeMuted').checked,
    defaultEngine: document.getElementById('gsDefaultEngine').value,
    defaultMethodology: document.getElementById('gsDefaultMethodology').value,
    projectsDir: document.getElementById('gsProjectsDir').value.trim(),
    portScannerEnabled: document.getElementById('gsPortScannerEnabled').checked,
    portScannerIntervalMs: intervalMs
  };

  const data = await apiMutate('/api/config', 'PATCH', patch);
  if (data && data.config) {
    state.config = data.config;
    applyTheme();
  }
  closeGlobalSettings();
}

// ── Create Project Drawer ──

let createStep = 0;
let createData = { name: '', engine: '', methodology: '', tags: '' };

function openCreateDrawer() {
  createStep = 0;
  createData = {
    name: '',
    engine: state.config ? state.config.defaultEngine || '' : '',
    methodology: state.config ? state.config.defaultMethodology || 'none' : 'none',
    tags: ''
  };
  renderCreateStep();
  document.getElementById('createBackdrop').classList.add('open');
  document.getElementById('createDrawer').classList.add('open');
}

function closeCreateDrawer() {
  document.getElementById('createBackdrop').classList.remove('open');
  document.getElementById('createDrawer').classList.remove('open');
}

function renderCreateStep() {
  const body = document.getElementById('createBody');
  const dots = document.querySelectorAll('#createSteps .step-dot');
  dots.forEach((d, i) => {
    d.className = 'step-dot' + (i === createStep ? ' active' : i < createStep ? ' done' : '');
  });

  if (createStep === 0) {
    document.getElementById('createTitle').textContent = 'Project Name';
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="createName">Name</label>
        <input type="text" class="form-input" id="createName" value="${esc(createData.name)}"
               placeholder="my-project" autocomplete="off" autocorrect="off"
               autocapitalize="off" spellcheck="false" pattern="[a-zA-Z0-9 _-]+">
        <div class="form-hint">Letters, numbers, spaces, hyphens, underscores</div>
        <div id="createNameError" class="form-error hidden" role="alert"></div>
      </div>
      <button class="btn btn-primary" style="width:100%" onclick="createNext()">Next</button>`;
    setTimeout(() => { const el = document.getElementById('createName'); if (el) el.focus(); }, 100);
  } else if (createStep === 1) {
    document.getElementById('createTitle').textContent = 'Engine & Methodology';
    const engineOpts = state.engines.map(e =>
      `<option value="${esc(e.id)}" ${e.id === createData.engine ? 'selected' : ''}>${esc(e.name)}${e.available === false ? ' (not installed)' : ''}</option>`
    ).join('');
    const methPills = state.methodologies.map(m => {
      const sel = m.id === createData.methodology ? ' selected' : '';
      return `<div class="meth-pill${sel}" data-id="${esc(m.id)}" onclick="selectMethodology('${esc(m.id)}')">${esc(m.name)}</div>`;
    }).join('');
    const selMeth = createData.methodology && createData.methodology !== 'none'
      ? state.methodologies.find(m => m.id === createData.methodology) : null;
    const detailHtml = selMeth
      ? `<div class="meth-detail">
           <div class="meth-detail-name">${esc(selMeth.name)}</div>
           <div class="meth-detail-desc">${esc(selMeth.description || '')}</div>
           ${selMeth.phases && selMeth.phases.length ? `<div class="meth-detail-phases">Phases: ${selMeth.phases.map(p => esc(typeof p === 'string' ? p : p.id || p.name)).join(' → ')}</div>` : ''}
         </div>` : '';
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="createEngine">Engine</label>
        <select class="form-select" id="createEngine">${engineOpts}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Methodology <span style="color:var(--text-muted);font-weight:normal">(optional)</span></label>
        <div class="meth-picker">
          <div class="meth-pill${!createData.methodology || createData.methodology === 'none' ? ' selected' : ''}" data-id="none" onclick="selectMethodology('none')">None</div>
          ${methPills}
        </div>
        <div id="methDetail">${detailHtml}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" style="flex:1" onclick="createBack()">Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="createNext()">Next</button>
      </div>`;
  } else if (createStep === 2) {
    document.getElementById('createTitle').textContent = 'Tags & Create';
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="createTags">Tags (optional, comma-separated)</label>
        <input type="text" class="form-input" id="createTags" value="${esc(createData.tags)}"
               placeholder="node, active" autocomplete="off">
      </div>
      <div class="form-group">
        <div style="padding:12px;background:var(--elevated-bg);border-radius:6px;font-size:13px">
          <div><strong>${esc(createData.name)}</strong></div>
          <div style="color:var(--text-muted);margin-top:4px">Engine: ${esc(createData.engine)}${createData.methodology && createData.methodology !== 'none' ? ` &middot; Methodology: ${esc(createData.methodology)}` : ''}</div>
        </div>
      </div>
      <div id="createError" class="form-error hidden" role="alert"></div>
      <div style="display:flex;gap:8px">
        <button class="btn" style="flex:1" onclick="createBack()">Back</button>
        <button class="btn btn-primary" style="flex:1" id="createSubmitBtn" onclick="submitCreate()">Create</button>
      </div>`;
  }
}

function selectMethodology(id) {
  createData.methodology = id;
  // Re-render just the picker state without full step re-render
  document.querySelectorAll('.meth-pill').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  const detailEl = document.getElementById('methDetail');
  if (id && id !== 'none') {
    const m = state.methodologies.find(x => x.id === id);
    if (m) {
      detailEl.innerHTML = `<div class="meth-detail">
        <div class="meth-detail-name">${esc(m.name)}</div>
        <div class="meth-detail-desc">${esc(m.description || '')}</div>
        ${m.phases && m.phases.length ? `<div class="meth-detail-phases">Phases: ${m.phases.map(p => esc(typeof p === 'string' ? p : p.id || p.name)).join(' → ')}</div>` : ''}
      </div>`;
    }
  } else {
    detailEl.innerHTML = '';
  }
}

function createNext() {
  if (createStep === 0) {
    const name = document.getElementById('createName').value.trim();
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
      const errEl = document.getElementById('createNameError');
      errEl.textContent = 'Invalid name. Use letters, numbers, spaces, hyphens, or underscores.';
      errEl.classList.remove('hidden');
      return;
    }
    createData.name = name;
  } else if (createStep === 1) {
    createData.engine = document.getElementById('createEngine').value;
    // methodology already set via selectMethodology()
  }
  createStep++;
  renderCreateStep();
}

function createBack() {
  if (createStep === 2) createData.tags = document.getElementById('createTags').value;
  createStep--;
  renderCreateStep();
}

async function submitCreate() {
  createData.tags = document.getElementById('createTags').value;
  const btn = document.getElementById('createSubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  const tags = createData.tags.split(',').map(t => t.trim()).filter(Boolean);
  const result = await apiMutate('/api/projects', 'POST', {
    name: createData.name,
    engine: createData.engine,
    methodology: createData.methodology === 'none' ? null : createData.methodology,
    tags
  });

  if (!result) {
    const errEl = document.getElementById('createError');
    errEl.textContent = 'Failed to create project. Check server logs.';
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Create';
    return;
  }

  // Show warnings from methodology init or other partial failures
  if (result.warnings && result.warnings.length > 0) {
    const toast = document.getElementById('toast');
    toast.textContent = `Warning: ${result.warnings.join('; ')}`;
    toast.className = 'toast toast-warn visible';
    setTimeout(() => { toast.classList.remove('visible'); }, 8000);
  }

  closeCreateDrawer();
  await loadProjects();
  navigateToSession(createData.name, { launched: false });
}

// ── Import Banner ──

/**
 * Render an import banner showing unregistered lease projects with details.
 * @param {object[]} importable - Array of { name, ports: [{port, service}], conflicts: [port] }
 */
function renderImportBanner(importable) {
  // Don't render duplicate banners
  if (document.getElementById('importBanner')) return;

  const banner = document.createElement('div');
  banner.id = 'importBanner';
  banner.className = 'import-banner';

  const details = importable.map(p => {
    const portList = p.ports.map(pt => `${pt.port} (${pt.service})`).join(', ');
    const conflictNote = p.conflicts.length > 0
      ? ` <span style="color:var(--error)">⚠ conflict on port${p.conflicts.length > 1 ? 's' : ''} ${p.conflicts.join(', ')}</span>`
      : '';
    const escapedName = esc(JSON.stringify(JSON.stringify(p.name)));
    return `<div class="import-banner-item">
      <strong>${esc(p.name)}</strong> — ports: ${portList}${conflictNote}
      <button class="btn btn-primary btn-small" onclick="importLeaseProjects(${esc(JSON.stringify(JSON.stringify([p.name])))})">Import</button>
      <button class="btn btn-small" onclick="ignoreLeaseProject(${escapedName})">Ignore</button>
    </div>`;
  }).join('');

  const allNames = importable.map(p => p.name);
  banner.innerHTML = `<div class="import-banner-header">
      <span>${importable.length} project${importable.length > 1 ? 's' : ''} found in port leases not registered in TangleClaw:</span>
      <div class="import-banner-actions">
        <button class="btn btn-primary btn-small" onclick="importLeaseProjects(${esc(JSON.stringify(JSON.stringify(allNames)))})">Import All</button>
        <button class="btn btn-small" onclick="dismissImportBanner()">Dismiss</button>
      </div>
    </div>
    ${details}`;

  const toolbar = document.querySelector('.toolbar');
  if (toolbar) {
    toolbar.parentNode.insertBefore(banner, toolbar);
  }
}

/**
 * Dismiss the import banner for this session.
 */
function dismissImportBanner() {
  const el = document.getElementById('importBanner');
  if (el) el.remove();
}

/**
 * Import lease projects by name, then refresh state.
 * @param {string} namesJson - JSON-encoded array of project names
 */
async function importLeaseProjects(namesJson) {
  const names = JSON.parse(namesJson);
  const result = await apiMutate('/api/projects/import', 'POST', { names });
  if (result && result.warnings && result.warnings.length) {
    // Auto-ignore projects that couldn't be imported (no directory, etc.)
    const failedNames = [];
    for (const w of result.warnings) {
      const match = w.match(/^"(.+?)" directory not found/);
      if (match) failedNames.push(match[1]);
    }
    if (failedNames.length) {
      for (const n of failedNames) ignoreLeaseProject(n);
    }
    // Show any other warnings
    const otherWarnings = result.warnings.filter(w => !w.match(/directory not found/));
    if (otherWarnings.length) {
      console.warn('Import warnings:', otherWarnings);
    }
  }
  dismissImportBanner();
  await loadProjects();
  // Re-check in case some remain
  checkPortImports();
}

// ── Event Bindings ──

const $ = (id) => document.getElementById(id);
$('statsToggle').addEventListener('click', toggleStats);
$('statsToggle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleStats(); }
});
$('portsToggle').addEventListener('click', togglePorts);
$('portsToggle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePorts(); }
});
$('rulesToggle').addEventListener('click', toggleRules);
$('rulesToggle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRules(); }
});
$('rulesSaveBtn').addEventListener('click', saveGlobalRules);
$('rulesResetBtn').addEventListener('click', openRulesResetModal);
$('rulesResetCancelBtn').addEventListener('click', closeRulesResetModal);
$('rulesResetConfirmBtn').addEventListener('click', confirmRulesReset);
$('rulesResetModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeRulesResetModal(); });
$('filterBtn').addEventListener('click', toggleFilter);
$('newBtn').addEventListener('click', openCreateDrawer);
$('createClose').addEventListener('click', closeCreateDrawer);
$('createBackdrop').addEventListener('click', closeCreateDrawer);
$('deleteCancelBtn').addEventListener('click', closeDelete);
$('deleteConfirmInput').addEventListener('input', onDeleteConfirmInput);
$('deleteConfirmBtn').addEventListener('click', confirmDelete);
$('killCancelBtn').addEventListener('click', closeKill);
$('killConfirmBtn').addEventListener('click', confirmKill);
$('killModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeKill(); });
$('wrapCancelBtn').addEventListener('click', closeWrapModal);
$('wrapConfirmBtn').addEventListener('click', confirmWrap);
$('settingsCancelBtn').addEventListener('click', closeSettings);
$('settingsSaveBtn').addEventListener('click', saveSettings);
$('deleteModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDelete(); });
$('wrapModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeWrapModal(); });
$('settingsModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSettings(); });
$('methSwitchCancelBtn').addEventListener('click', closeMethSwitchModal);
$('methSwitchConfirmBtn').addEventListener('click', confirmMethSwitch);
$('methSwitchModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeMethSwitchModal(); });
$('gearBtn').addEventListener('click', openGlobalSettings);
$('globalSettingsCancelBtn').addEventListener('click', closeGlobalSettings);
$('globalSettingsSaveBtn').addEventListener('click', saveGlobalSettings);
$('globalSettingsModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeGlobalSettings(); });

let filterTimer = null;
$('filterInput').addEventListener('input', (e) => {
  clearTimeout(filterTimer);
  const val = e.target.value;
  $('filterClear').classList.toggle('hidden', !val);
  filterTimer = setTimeout(() => { state.filterText = val; renderProjects(); }, 200);
});
$('filterClear').addEventListener('click', () => {
  $('filterInput').value = '';
  $('filterClear').classList.add('hidden');
  state.filterText = '';
  renderProjects();
});
