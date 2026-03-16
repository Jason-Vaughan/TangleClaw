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
        <button class="btn btn-compact btn-icon-tiny btn-danger-subtle" onclick="event.stopPropagation(); openDelete('${n}')" title="Delete">&times;</button>
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
  if (state.allTags.length === 0) {
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

// ── Delete Project Modal ──

let deleteTarget = null;

function openDelete(name) {
  deleteTarget = name;
  const modal = document.getElementById('deleteModal');
  document.getElementById('deleteText').innerHTML =
    `Permanently delete <strong style="color:var(--danger)">${esc(name)}</strong>?`;
  document.getElementById('deleteError').classList.add('hidden');
  document.getElementById('deletePassword').value = '';
  document.getElementById('deleteConfirmInput').value = '';
  document.getElementById('deleteConfirmInput').placeholder = name;
  document.getElementById('deleteConfirmBtn').disabled = true;

  const pwGroup = document.getElementById('deletePasswordGroup');
  if (state.config && state.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  modal.classList.add('open');
  setTimeout(() => document.getElementById('deleteConfirmInput').focus(), 100);
}

function onDeleteConfirmInput() {
  const val = document.getElementById('deleteConfirmInput').value.trim();
  document.getElementById('deleteConfirmBtn').disabled = val !== deleteTarget;
}

function closeDelete() {
  document.getElementById('deleteModal').classList.remove('open');
  deleteTarget = null;
}

async function confirmDelete() {
  if (!deleteTarget) return;
  const confirmVal = document.getElementById('deleteConfirmInput').value.trim();
  if (confirmVal !== deleteTarget) return;

  const pw = document.getElementById('deletePassword').value;
  const body = { deleteFiles: false };
  if (pw) body.password = pw;

  const data = await apiMutate(`/api/projects/${encodeURIComponent(deleteTarget)}`, 'DELETE', body);
  if (!data) {
    document.getElementById('deleteError').textContent = 'Delete failed. Check password.';
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
               autocapitalize="off" spellcheck="false" pattern="[a-zA-Z0-9_-]+">
        <div class="form-hint">Letters, numbers, hyphens, underscores only</div>
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
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      const errEl = document.getElementById('createNameError');
      errEl.textContent = 'Invalid name. Use letters, numbers, hyphens, or underscores.';
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

function renderImportBanner(importable) {
  if (sessionStorage.getItem('importBannerDismissed')) return;
  // Don't render duplicate banners
  if (document.getElementById('importBanner')) return;

  const banner = document.createElement('div');
  banner.id = 'importBanner';
  banner.className = 'import-banner';
  banner.innerHTML = `<span>${importable.length} project${importable.length > 1 ? 's' : ''} found in port leases not registered in TangleClaw.</span>
    <button class="btn btn-primary btn-small" onclick="importLeaseProjects(${esc(JSON.stringify(JSON.stringify(importable)))})">Import All</button>
    <button class="btn btn-small" onclick="dismissImportBanner()">&times;</button>`;

  const toolbar = document.querySelector('.toolbar');
  if (toolbar) {
    toolbar.parentNode.insertBefore(banner, toolbar);
  }
}

function dismissImportBanner() {
  sessionStorage.setItem('importBannerDismissed', 'true');
  const el = document.getElementById('importBanner');
  if (el) el.remove();
}

async function importLeaseProjects(namesJson) {
  const names = JSON.parse(namesJson);
  const result = await apiMutate('/api/projects/import', 'POST', { names });
  if (result && result.warnings && result.warnings.length) {
    console.warn('Import warnings:', result.warnings);
  }
  sessionStorage.setItem('importBannerDismissed', 'true');
  dismissImportBanner();
  await loadProjects();
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
