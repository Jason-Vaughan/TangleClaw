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

  grid.innerHTML = filtered.map(renderCard).join('');
}

function renderCard(project) {
  const hasSession = project.session && project.session.active;
  const sessionClass = hasSession ? ' has-session' : '';

  const gitBadge = project.git
    ? `<span class="git-badge">${esc(project.git.branch)}${project.git.dirty ? '<span class="git-dirty" title="Uncommitted changes"></span>' : ''}</span>`
    : '';

  const engineId = project.engine ? project.engine.id : '';
  const engineName = project.engine ? project.engine.name : '';
  const methName = project.methodology ? project.methodology.name : '';

  const statusBadge = project.status
    ? `<span class="status-pill status-${esc(project.status.color || 'green')}">${esc(project.status.badge || '')}</span>`
    : '';

  const tagsHtml = (project.tags || []).map(t =>
    `<span class="card-tag">${esc(t)}</span>`
  ).join('');

  const wrapBtn = hasSession
    ? `<button class="btn btn-small" onclick="event.stopPropagation(); wrapProject('${esc(project.name)}')">Wrap</button>`
    : '';

  return `<article class="project-card${sessionClass}" tabindex="0" role="link"
    onclick="navigateToSession('${esc(project.name)}')"
    onkeydown="if(event.key==='Enter')navigateToSession('${esc(project.name)}')">
    <div class="card-header">
      <span class="card-name" title="${esc(project.name)}">${esc(project.name)}</span>
      ${gitBadge}
    </div>
    <div class="card-pills">
      ${engineName ? `<span class="engine-pill" data-engine="${esc(engineId)}">${esc(engineName)}</span>` : ''}
      ${methName ? `<span class="methodology-pill">${esc(methName)}</span>` : ''}
      ${statusBadge}
    </div>
    ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
    <div class="card-actions">
      <button class="btn btn-primary btn-small" onclick="event.stopPropagation(); launchProject('${esc(project.name)}')">${hasSession ? 'Open' : 'Launch'}</button>
      ${wrapBtn}
      <button class="btn btn-small btn-icon" onclick="event.stopPropagation(); openSettings('${esc(project.name)}')" aria-label="Settings">&#9881;</button>
      <button class="btn btn-small btn-icon btn-danger" onclick="event.stopPropagation(); openDelete('${esc(project.name)}')" aria-label="Delete">&#128465;</button>
    </div>
  </article>`;
}

function renderSessionCount() {
  const active = state.projects.filter(p => p.session && p.session.active).length;
  document.getElementById('sessionCount').textContent = `${active} active`;
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

  let html = '';
  for (const [project, leases] of Object.entries(grouped)) {
    html += `<div class="port-group">`;
    html += `<div class="port-group-name">${esc(project)}</div>`;
    for (const lease of leases) {
      const typeClass = lease.permanent ? 'port-type-permanent' : 'port-type-ttl';
      const typeLabel = lease.permanent ? 'permanent' : 'TTL';
      html += `<div class="port-lease">
        <span class="port-number">${lease.port}</span>
        <span class="port-service">${esc(lease.service)}</span>
        <span class="port-type ${typeClass}">${typeLabel}</span>
      </div>`;
    }
    html += '</div>';
  }

  grid.innerHTML = html;
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
    `Are you sure you want to delete <strong>${esc(name)}</strong>? This will unregister it from TangleClaw.`;
  document.getElementById('deleteError').classList.add('hidden');
  document.getElementById('deletePassword').value = '';

  const pwGroup = document.getElementById('deletePasswordGroup');
  if (state.config && state.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  modal.classList.add('open');
}

function closeDelete() {
  document.getElementById('deleteModal').classList.remove('open');
  deleteTarget = null;
}

async function confirmDelete() {
  if (!deleteTarget) return;
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

  const methOpts = state.methodologies.map(m =>
    `<option value="${esc(m.id)}" ${m.id === (project.methodology ? project.methodology.id : '') ? 'selected' : ''}>${esc(m.name)}</option>`
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
  const body = {
    engine: document.getElementById('settingsEngine').value,
    methodology: document.getElementById('settingsMethodology').value,
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
    methodology: state.config ? state.config.defaultMethodology || '' : '',
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
    const methOpts = state.methodologies.map(m =>
      `<option value="${esc(m.id)}" ${m.id === createData.methodology ? 'selected' : ''}>${esc(m.name)} — ${esc(m.description || '')}</option>`
    ).join('');
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="createEngine">Engine</label>
        <select class="form-select" id="createEngine">${engineOpts}</select>
      </div>
      <div class="form-group">
        <label class="form-label" for="createMethodology">Methodology</label>
        <select class="form-select" id="createMethodology">${methOpts}</select>
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
          <div style="color:var(--text-muted);margin-top:4px">Engine: ${esc(createData.engine)} &middot; Methodology: ${esc(createData.methodology)}</div>
        </div>
      </div>
      <div id="createError" class="form-error hidden" role="alert"></div>
      <div style="display:flex;gap:8px">
        <button class="btn" style="flex:1" onclick="createBack()">Back</button>
        <button class="btn btn-primary" style="flex:1" id="createSubmitBtn" onclick="submitCreate()">Create</button>
      </div>`;
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
    createData.methodology = document.getElementById('createMethodology').value;
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
    methodology: createData.methodology,
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

  closeCreateDrawer();
  await loadProjects();
  navigateToSession(createData.name);
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
$('filterBtn').addEventListener('click', toggleFilter);
$('newBtn').addEventListener('click', openCreateDrawer);
$('createClose').addEventListener('click', closeCreateDrawer);
$('createBackdrop').addEventListener('click', closeCreateDrawer);
$('deleteCancelBtn').addEventListener('click', closeDelete);
$('deleteConfirmBtn').addEventListener('click', confirmDelete);
$('wrapCancelBtn').addEventListener('click', closeWrapModal);
$('wrapConfirmBtn').addEventListener('click', confirmWrap);
$('settingsCancelBtn').addEventListener('click', closeSettings);
$('settingsSaveBtn').addEventListener('click', saveSettings);
$('deleteModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDelete(); });
$('wrapModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeWrapModal(); });
$('settingsModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSettings(); });

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
