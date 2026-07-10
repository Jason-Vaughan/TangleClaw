'use strict';
/* ── TangleClaw v3 — Landing Page: UI & Interactions ── */
/* Rendering, modals, drawers, event bindings. Depends on landing.js. */

// ── Engine Dropdown Helper ──

/**
 * Build <option> HTML for an engine dropdown.
 * OpenClaw entries no longer appear here (#459) — connection-backed harnesses
 * are reached via the top-bar OpenClaw panel, not assigned as a project's LLM.
 * A project bound to an engine the server no longer lists (hidden or retired)
 * still renders its current selection so the settings modal never shows a
 * silently-wrong choice.
 * @param {object[]} engineList - Engines from state.engines
 * @param {string} selectedId - Currently selected engine ID
 * @returns {string} HTML string of <option> elements
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

  // Archived projects section (collapsed by default)
  const archived = state.projects.filter(p => p.archived);
  let archivedHtml = '';
  if (archived.length > 0) {
    archivedHtml = `<details class="archived-section">
      <summary class="archived-section-header">${archived.length} archived project${archived.length !== 1 ? 's' : ''}</summary>
      <div class="archived-section-list">${archived.map(renderCard).join('')}</div>
    </details>`;
  }

  grid.innerHTML = rootHtml + filtered.map(renderCard).join('') + archivedHtml;
}

function renderRootPanel() {
  if (!state.config || !state.config.projectsDir) return '';
  const nonArchived = state.projects.filter(p => !p.archived);
  const totalCount = nonArchived.length;
  const registered = nonArchived.filter(p => p.registered !== false).length;
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

  // Archived project — show muted style with Unarchive button
  if (project.archived) {
    return renderArchivedCard(project);
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
    ? (() => {
        const es = state.modelStatus[project.engine.id];
        const dot = es ? `<span class="engine-status-dot engine-status-${es.status}"></span>` : '';
        const pillClass = es && es.status !== 'operational' ? `engine-pill-${es.status}` : '';
        const tt = es
          ? (es.error ? `Status unknown: ${esc(es.error)}` : esc((es.message || es.status).replace(/_/g, ' ')))
          : '';
        return `<span class="badge badge-engine ${pillClass}" title="${tt}">${dot}${esc(project.engine.name)}</span>`;
      })()
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

  // Group badges
  const groupBadges = (project.groups || []).map(g =>
    `<span class="badge badge-group" title="${esc(g.name)}: ${g.docCount || 0} shared doc${(g.docCount || 0) !== 1 ? 's' : ''}">${esc(g.name)}</span>`
  ).join('');

  // Eval audit badge
  const auditBadge = project.evalAudit && project.evalAudit.enabled
    ? (() => {
        const incidents = project.evalAudit.openIncidents || 0;
        const incidentPill = incidents > 0
          ? `<span class="badge-anomaly" title="${incidents} open incident${incidents !== 1 ? 's' : ''}">${incidents}</span>`
          : '';
        return `<span class="badge badge-audit" title="Eval Audit active${incidents ? ` — ${incidents} open incident${incidents !== 1 ? 's' : ''}` : ''}"><span class="audit-dot"></span>Audit${incidentPill}</span>`;
      })()
    : '';

  // Governance-drift badge (#353) — only the alarming state renders, to avoid
  // badge noise. "drift-no-governance" = labeled prawduct + Claude but neither
  // on the V2 plugin nor carrying a vendored hook, so the Stop-gate/Critic layer
  // is silently off. Self-clears once the project migrates.
  const driftBadge = project.governanceState === 'drift-no-governance'
    ? `<span class="badge badge-drift" title="Governance drift: this project presents as Prawduct-governed but its Stop-gate/Critic layer is silently OFF (not on the V2 plugin, no vendored hook). Open Info to migrate it.">&#9888; governance drift</span>`
    : '';

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
      ${groupBadges}
      ${auditBadge}
      ${driftBadge}
      <span class="card-row-actions">
        <button class="btn btn-compact btn-launch" onclick="event.stopPropagation(); launchProject('${n}')">${hasSession ? 'Open' : 'Launch'}</button>
        ${hasSession ? `<button class="btn btn-compact btn-icon-tiny" onclick="event.stopPropagation(); openPeekFromCard('${n}')" title="Peek">&#128065;</button>` : ''}
        ${hasSession ? `<button class="btn btn-compact btn-icon-tiny btn-kill-card" onclick="event.stopPropagation(); openKill('${n}')" title="Kill session">&#9632;</button>` : ''}
        <button class="btn btn-compact btn-icon-tiny" onclick="event.stopPropagation(); openHistory('${n}')" title="Session history &amp; search">&#128269;</button>
        <button class="btn btn-compact btn-icon-tiny" onclick="event.stopPropagation(); openSettings('${n}')" title="Info">i</button>
        ${!hasSession ? `<button class="btn btn-compact btn-icon-tiny btn-detach-subtle" onclick="event.stopPropagation(); archiveProjectUI('${n}')" title="Archive project">&#128451;</button>` : ''}
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

/**
 * Render an archived project card with muted styling and Unarchive button.
 * @param {object} project - Project data
 * @returns {string} HTML
 */
function renderArchivedCard(project) {
  const n = esc(project.name);
  return `<article class="project-card compact archived" tabindex="0">
    <div class="card-row">
      <span class="status-dot archived"></span>
      <span class="card-name card-name-muted" title="${n}">${n}</span>
      <span class="badge badge-archived">archived</span>
      <span class="card-row-actions">
        <button class="btn btn-compact" onclick="event.stopPropagation(); unarchiveProject('${n}')">Unarchive</button>
        <button class="btn btn-compact btn-icon-tiny btn-danger-subtle" onclick="event.stopPropagation(); openDelete('${n}')" title="Delete project">&times;</button>
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
    const groupsInfo = (project.groups || []).length > 0
      ? project.groups.map(g => `${esc(g.name)} (${g.docCount || 0} docs)`).join(', ')
      : 'None';

    detail.innerHTML = `
      <div class="detail-row"><span class="detail-label">Engine</span><span class="detail-value">${engineInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Methodology</span><span class="detail-value">${methInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Session</span><span class="detail-value">${sessionInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Git</span><span class="detail-value">${gitInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Tags</span><span class="detail-value">${tagsInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Groups</span><span class="detail-value">${groupsInfo}</span></div>
      <div class="detail-actions">
        <button class="btn btn-compact" onclick="event.stopPropagation(); openSettings('${esc(name)}')">Settings</button>
        ${project.session && project.session.active ? `<button class="btn btn-compact btn-kill-card" onclick="event.stopPropagation(); openKill('${esc(name)}')">Kill Session</button>` : ''}
        <button class="btn btn-compact btn-danger-subtle" onclick="event.stopPropagation(); openDelete('${esc(name)}')">Delete</button>
      </div>`;

    card.appendChild(detail);
    return;
  }
}

/** @type {string|null} */
let attachConfirmTarget = null;

/**
 * Show confirmation modal before attaching a project.
 * @param {string} name - Project directory name
 */
function attachProject(name) {
  attachConfirmTarget = name;
  document.getElementById('attachConfirmText').innerHTML =
    `<p>Register <strong>${esc(name)}</strong> as a TangleClaw project?</p>` +
    `<p style="margin-top:8px;font-size:13px;color:var(--text-muted)">This will scaffold project config, generate engine files (CLAUDE.md), and sync on every server boot.</p>`;
  document.getElementById('attachConfirmModal').classList.add('open');
}

/**
 * Close the attach confirmation modal without attaching.
 */
function closeAttachConfirm() {
  document.getElementById('attachConfirmModal').classList.remove('open');
  attachConfirmTarget = null;
}

/**
 * Confirm attach and register the project.
 */
async function confirmAttach() {
  const name = attachConfirmTarget;
  closeAttachConfirm();
  if (!name) return;
  const data = await apiMutate('/api/projects/attach', 'POST', { name });
  if (data) {
    await loadProjects();
  }
}

/**
 * Archive a project (deactivate — stops sync and blocks session launch).
 * @param {string} name - Project name
 */
async function archiveProjectUI(name) {
  if (!confirm(`Archive "${name}"? It will be hidden from the main list and won't sync on boot. You can unarchive it later.`)) return;
  const data = await apiMutate(`/api/projects/${encodeURIComponent(name)}/archive`, 'POST', {});
  if (data) {
    await loadProjects();
  }
}

/**
 * Unarchive (restore) an archived project.
 * @param {string} name - Project name
 */
async function unarchiveProject(name) {
  const data = await apiMutate(`/api/projects/${encodeURIComponent(name)}/unarchive`, 'POST', {});
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

// ── Ports Toggle ──

/**
 * Toggle the ports panel open/closed from the dashboard bar.
 */
function togglePorts() {
  state.portsOpen = !state.portsOpen;
  const grid = document.getElementById('portsGrid');
  const toggle = document.getElementById('portsToggle');
  grid.classList.toggle('open', state.portsOpen);
  toggle.classList.toggle('active', state.portsOpen);
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
 * Toggle the global rules panel open/closed from the dashboard bar.
 */
function toggleRules() {
  state.rulesOpen = !state.rulesOpen;
  const panel = document.getElementById('rulesPanel');
  const toggle = document.getElementById('rulesToggle');
  panel.classList.toggle('open', state.rulesOpen);
  toggle.classList.toggle('active', state.rulesOpen);
  toggle.setAttribute('aria-expanded', state.rulesOpen);
}

/**
 * Toggle the session rules panel open/closed from the dashboard bar (#347/D1a).
 */
function toggleSessionRules() {
  state.sessionRulesOpen = !state.sessionRulesOpen;
  const panel = document.getElementById('sessionRulesPanel');
  const toggle = document.getElementById('sessionRulesToggle');
  panel.classList.toggle('open', state.sessionRulesOpen);
  toggle.classList.toggle('active', state.sessionRulesOpen);
  toggle.setAttribute('aria-expanded', state.sessionRulesOpen);
}

/**
 * Handle clicks/changes within the session-rules list (event delegation).
 * @param {Event} e - The DOM event
 */
function handleSessionRulesListEvent(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const id = Number(target.getAttribute('data-rule-id'));
  const action = target.getAttribute('data-action');
  if (action === 'toggle') {
    toggleSessionRule(id, target.checked);
  } else if (action === 'delete') {
    deleteSessionRule(id);
  } else if (action === 'history') {
    toggleSessionRuleVersions(id);
  } else if (action === 'restore') {
    restoreSessionRule(id, Number(target.getAttribute('data-version-no')));
  }
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

// ── Filter Toggle (inline — always visible, no toggle needed) ──

function toggleFilter() {
  document.getElementById('filterInput').focus();
}

function maybeShowFilter() {
  // Filter input is always visible inline; no-op for backwards compat
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
  const proj = state.projects.find(p => p.name === name);
  const isWebui = proj && proj.session && proj.session.sessionMode === 'webui';
  const modeText = isWebui ? 'tears down the SSH tunnel' : 'terminates the tmux session';
  document.getElementById('killText').innerHTML =
    `Kill the active session for <strong>${esc(name)}</strong>? This ${modeText} immediately.`;
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
  document.getElementById('settingsTitle').textContent = 'Project Settings';

  const engineOpts = buildEngineOptions(state.engines, project.engine ? project.engine.id : '');

  // Every project has a methodology (#151) — `minimal` is the no-workflow option,
  // not a separate "None" sentinel. Pre-#151 the dropdown offered a None choice
  // that POSTed `methodology: null` and crashed the backend; retired.
  const currentMeth = project.methodology ? project.methodology.id : 'minimal';
  const methOpts = state.methodologies.map(m =>
    `<option value="${esc(m.id)}" ${m.id === currentMeth ? 'selected' : ''}>${esc(m.name)}</option>`
  ).join('');

  const hasSession = project.session && project.session.active;

  // Silent prime toggle (#103) — rendered into a stable container so we can
  // re-render its contents when the user changes the engine dropdown without
  // touching the rest of the modal. The container is always in the DOM; it just
  // becomes empty for engines that don't advertise supportsSilentPrime.
  const initialSilentChecked = !!project.silentPrime;
  // Feature Index toggle (#207, chunk 1) — engine-agnostic, so always rendered.
  const initialFeatureIndexChecked = !!project.featureIndexEnabled;
  // Project Map toggle (PIDX #360, #356) — engine-agnostic, so always rendered.
  const initialProjectMapChecked = !!project.projectMapEnabled;
  // Auto version-bump opt-out (#318) — engine-agnostic; default on (only an
  // explicit false disables it).
  const initialVersionBumpChecked = project.versionBumpEnabled !== false;
  // Medusa session-comms auto-enable (MED-2K9P Chunk 02) — engine-agnostic;
  // default OFF (only an explicit true opts in).
  const initialMedusaChecked = !!project.medusaEnabled;
  document.getElementById('settingsBody').innerHTML = `
    <div class="form-group">
      <label class="form-label" for="settingsName">Name</label>
      <input type="text" class="form-input" id="settingsName" value="${esc(name)}"
             autocomplete="off" autocorrect="off" autocapitalize="off"
             ${hasSession ? 'disabled' : ''}>
      ${hasSession ? '<div class="form-hint" style="color:var(--danger)">Cannot rename while a session is active</div>' : ''}
    </div>
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
    </div>
    <div class="settings-toggles-grid">
      <div id="settingsSilentPrimeContainer"></div>
      <div id="settingsFeatureIndexContainer"></div>
      <div id="settingsProjectMapContainer"></div>
      <div class="form-group">
        <label class="gs-toggle-label">
          <span>Auto version bump</span>
          <input type="checkbox" id="settingsVersionBump" ${initialVersionBumpChecked ? 'checked' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <div class="form-hint">On wrap, promote CHANGELOG <code>[Unreleased]</code> and bump <code>version.json</code>/<code>package.json</code> semver. Turn off for projects that manage their own versioning (e.g. a non-semver scheme via their own tooling).</div>
      </div>
      <div class="form-group">
        <label class="gs-toggle-label">
          <span>Enable Medusa session comms</span>
          <input type="checkbox" id="settingsMedusa" ${initialMedusaChecked ? 'checked' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <div class="form-hint">Auto-start this project's sessions on the Medusa switchboard so inbound messages badge in the banner without a manual toggle. Off by default; the banner control is always available as a per-session override.</div>
      </div>
    </div>
    ${renderProjectRulesSection(project)}`;

  // Initial render — based on the project's current engine
  renderSilentPrimeToggle(project.engine ? project.engine.id : '', initialSilentChecked);
  renderFeatureIndexToggle(initialFeatureIndexChecked);
  renderProjectMapToggle(initialProjectMapChecked);
  // CC-6 (#381): populate the three per-project rule lists (async) once the
  // modal markup is in the DOM. project.id is the DB id the API scopes on.
  loadProjectRules(project.id);

  // Re-render on engine dropdown change (chunk 3 polish — Critic Mn5). Without
  // this, switching the dropdown to an engine that lacks supportsSilentPrime
  // leaves a stale checkbox visible; the backend rejects gracefully but the user
  // shouldn't be able to send a doomed request in the first place.
  document.getElementById('settingsEngine').addEventListener('change', (e) => {
    const checkbox = document.getElementById('settingsSilentPrime');
    const checkedNow = checkbox ? checkbox.checked : initialSilentChecked;
    renderSilentPrimeToggle(e.target.value, checkedNow);
  });

  modal.classList.add('open');
}

/**
 * Render (or clear) the silent-prime toggle inside #settingsSilentPrimeContainer
 * based on the engine selected in the dropdown. Capability is read from the
 * engine profile in `state.engines` (same source the dropdown is built from).
 *
 * Preserves the checkbox's `checked` value across engine switches: if the user
 * toggles silent prime on, then clicks a different engine and back, their
 * intent is remembered. When the new engine doesn't support the capability the
 * markup is wiped (so doSaveSettings can't pick up a stale checkbox).
 *
 * @param {string} engineId - Engine id from the dropdown's current value
 * @param {boolean} preserveChecked - The checkbox state to carry over (or initial)
 */
function renderSilentPrimeToggle(engineId, preserveChecked) {
  const container = document.getElementById('settingsSilentPrimeContainer');
  if (!container) return;
  const profile = (state.engines || []).find(e => e.id === engineId);
  const supportsSilent = !!(profile && profile.capabilities && profile.capabilities.supportsSilentPrime);
  if (!supportsSilent) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Silent prime (hidden context)</span>
        <input type="checkbox" id="settingsSilentPrime" ${preserveChecked ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">Deliver the session prime via Claude Code's SessionStart hook instead of typing it into the terminal — clean scrollback, prime stays in model context. Takes effect on next session launch.</div>
    </div>`;
}

/**
 * Render the Feature Index toggle (#207, chunk 1). Engine-agnostic — always
 * rendered because the FEATURES.md file and (future) wrap-step parity work
 * regardless of which engine the project uses. SessionStart injection
 * (chunk 2) layers its own engine-capability gate on top at the injection
 * site.
 *
 * @param {boolean} preserveChecked - The checkbox state to carry over (or initial)
 */
function renderFeatureIndexToggle(preserveChecked) {
  const container = document.getElementById('settingsFeatureIndexContainer');
  if (!container) return;
  container.innerHTML = `
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Feature Index</span>
        <input type="checkbox" id="settingsFeatureIndex" ${preserveChecked ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">Maintain a FEATURES.md at the project root mapping feature names to file paths. Enabling creates a template stub at &lt;project-root&gt;/FEATURES.md (existing files are preserved). Edit the file directly to add entries.</div>
    </div>`;
}

/**
 * Render the Project Map toggle (PIDX #360, #356) into its stable container.
 * Engine-agnostic and always rendered; the SessionStart prime POINTS the agent
 * at PROJECT-MAP.md (reference, not inline) gated by silentPrime + the engine's
 * supportsSilentPrime capability at the injection site.
 *
 * @param {boolean} preserveChecked - The checkbox state to carry over (or initial)
 */
function renderProjectMapToggle(preserveChecked) {
  const container = document.getElementById('settingsProjectMapContainer');
  if (!container) return;
  container.innerHTML = `
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Project Map</span>
        <input type="checkbox" id="settingsProjectMap" ${preserveChecked ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">Maintain a PROJECT-MAP.md at the project root — a "where things live" structural map the agent consults first. Enabling creates it with an auto-generated top-level-directory skeleton (existing files are preserved); fill in the descriptions. Distinct from the Feature Index (which maps features to paths).</div>
    </div>`;
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
  settingsTarget = null;
  projectRulesTargetId = null;
}

// ── Project Rules (CC-6, #381) ──
// A per-project extension of the Settings modal: three rule-kind boxes
// (startup/wrap/mode) backed by the session_rules store + the 8 wrap-summary
// section checkboxes. Reuses the D1a/D1b session-rules list pattern, scoped to
// this project's id + a kind. The DB project id of the open modal.
let projectRulesTargetId = null;

// The fixed wrap-summary section vocabulary (mirrors lib/continuity.js
// WRAP_SECTIONS). `Next action` is the mandatory keystone — always rendered, so
// its checkbox is checked + disabled.
const WRAP_SECTION_NAMES = [
  'Where we are', 'Next action', 'Delta', 'Open threads',
  'Decisions', 'Landmines', 'Pointers', 'Freshness'
];

const PROJECT_RULE_KINDS = [
  { kind: 'startup', label: 'Startup rules', hint: 'Injected into the session config at launch (custom priming for this project).' },
  { kind: 'wrap', label: 'Wrap rules', hint: 'Custom wrap behavior + the sink where approved self-improvement suggestions land.' },
  { kind: 'mode', label: 'Mode rules', hint: 'Harness/model posture to keep this project in (runtime enforcement is forthcoming).' }
];

/**
 * Build the Project Rules section markup for the Settings modal. The three rule
 * lists are populated asynchronously by loadProjectRules() after the modal opens.
 * @param {object} project - Enriched project (carries id + wrapSections)
 * @returns {string} HTML
 */
function renderProjectRulesSection(project) {
  const enabled = Array.isArray(project.wrapSections) ? project.wrapSections : null;
  const sectionChecks = WRAP_SECTION_NAMES.map((name) => {
    const isNextAction = name === 'Next action';
    const checked = isNextAction || enabled === null || enabled.includes(name);
    return `
      <label class="gs-toggle-label wrap-section-toggle">
        <span>${esc(name)}${isNextAction ? ' <em>(required)</em>' : ''}</span>
        <input type="checkbox" class="wrap-section-check" data-section="${esc(name)}"
               ${checked ? 'checked' : ''} ${isNextAction ? 'disabled' : ''}>
        <span class="toggle-switch"></span>
      </label>`;
  }).join('');

  const ruleBlocks = PROJECT_RULE_KINDS.map((k) => `
    <div class="project-rules-block" data-kind="${k.kind}">
      <div class="form-label">${esc(k.label)}</div>
      <div class="form-hint">${esc(k.hint)}</div>
      <div class="session-rules-list" id="projRulesList-${k.kind}" aria-live="polite"></div>
      <div class="session-rules-add">
        <textarea class="rules-editor" id="projRuleInput-${k.kind}" rows="2"
                  placeholder="Add a ${k.kind} rule…" spellcheck="false"></textarea>
        <button class="btn btn-small btn-primary" data-action="add-rule" data-kind="${k.kind}">Add</button>
      </div>
    </div>`).join('');

  return `
    <div class="project-rules-section">
      <div class="gs-section-label">Project Rules</div>
      <div class="form-group">
        <div class="form-label">Wrap summary sections</div>
        <div class="form-hint">Which of the 8 wrap-summary sections this project records. <code>Next action</code> is always kept.</div>
        <div class="wrap-section-grid">${sectionChecks}</div>
      </div>
      <div class="project-rules-grid">${ruleBlocks}</div>
      <div id="projectRulesStatus" class="rules-status hidden" role="status"></div>
    </div>`;
}

/**
 * Fetch this project's rules for all three kinds and render each list.
 * @param {number} projectId - DB project id
 */
async function loadProjectRules(projectId) {
  projectRulesTargetId = projectId;
  for (const { kind } of PROJECT_RULE_KINDS) {
    const data = await api(`/api/session-rules?projectId=${encodeURIComponent(projectId)}&kind=${kind}`);
    // The modal may have been closed/reopened on another project while awaiting.
    if (projectRulesTargetId !== projectId) return;
    renderProjectRulesList(kind, data ? data.rules || [] : []);
  }
}

/**
 * Render one kind's rule list into its container.
 * @param {string} kind - 'startup' | 'wrap' | 'mode'
 * @param {object[]} rules - Rules of this kind for the project
 */
function renderProjectRulesList(kind, rules) {
  const list = document.getElementById(`projRulesList-${kind}`);
  if (!list) return;
  if (rules.length === 0) {
    list.innerHTML = '<p class="session-rules-empty">No rules yet.</p>';
    return;
  }
  list.innerHTML = rules.map((rule) => `
    <div class="session-rule-item${rule.enabled ? '' : ' session-rule-disabled'}" data-rule-id="${rule.id}">
      <label class="session-rule-toggle">
        <input type="checkbox" data-action="toggle-rule" data-rule-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
      </label>
      <span class="session-rule-content">${rule.createdBy === 'ai' ? '<span class="session-rule-badge" title="AI-authored">AI</span> ' : ''}${esc(rule.content)}</span>
      <button class="btn btn-small btn-danger session-rule-delete" data-action="delete-rule" data-rule-id="${rule.id}" aria-label="Delete rule">&times;</button>
    </div>
  `).join('');
}

/**
 * Add a rule of the given kind for the open project from its textarea.
 * @param {string} kind - Rule kind
 */
async function addProjectRule(kind) {
  if (projectRulesTargetId == null) return;
  const input = document.getElementById(`projRuleInput-${kind}`);
  const content = input ? input.value.trim() : '';
  if (!content) return;
  const data = await apiMutate('/api/session-rules', 'POST', {
    content, projectId: projectRulesTargetId, kind
  });
  if (data) {
    if (input) input.value = '';
    _setProjectRulesStatus('Added', true);
    const list = await api(`/api/session-rules?projectId=${encodeURIComponent(projectRulesTargetId)}&kind=${kind}`);
    renderProjectRulesList(kind, list ? list.rules || [] : []);
  } else {
    _setProjectRulesStatus('Add failed', false);
  }
}

/**
 * Toggle a project rule's enabled state and re-render its kind list.
 * @param {number} id - Rule id
 * @param {boolean} enabled - New state
 * @param {string} kind - Rule kind (for the targeted re-render)
 */
async function toggleProjectRule(id, enabled, kind) {
  const data = await apiMutate(`/api/session-rules/${id}`, 'PUT', { enabled });
  if (!data) { _setProjectRulesStatus('Update failed', false); return; }
  const list = await api(`/api/session-rules?projectId=${encodeURIComponent(projectRulesTargetId)}&kind=${kind}`);
  renderProjectRulesList(kind, list ? list.rules || [] : []);
}

/**
 * Delete a project rule and re-render its kind list.
 * @param {number} id - Rule id
 * @param {string} kind - Rule kind
 */
async function deleteProjectRule(id, kind) {
  const data = await apiMutate(`/api/session-rules/${id}`, 'DELETE', {});
  if (!data) { _setProjectRulesStatus('Delete failed', false); return; }
  _setProjectRulesStatus('Deleted', true);
  const list = await api(`/api/session-rules?projectId=${encodeURIComponent(projectRulesTargetId)}&kind=${kind}`);
  renderProjectRulesList(kind, list ? list.rules || [] : []);
}

/**
 * Delegated handler for clicks/changes inside the Project Rules section.
 * Attached once to #settingsBody (stable element; innerHTML is swapped per open).
 * @param {Event} e
 */
function handleProjectRulesEvent(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.getAttribute('data-action');
  const block = target.closest('.project-rules-block');
  const kind = block ? block.getAttribute('data-kind') : null;
  if (action === 'add-rule' && e.type === 'click') {
    addProjectRule(target.getAttribute('data-kind'));
  } else if (action === 'toggle-rule' && e.type === 'change') {
    toggleProjectRule(Number(target.getAttribute('data-rule-id')), target.checked, kind);
  } else if (action === 'delete-rule' && e.type === 'click') {
    deleteProjectRule(Number(target.getAttribute('data-rule-id')), kind);
  }
}

/**
 * Read the wrap-section checkboxes into a wrapSections value for the PATCH body.
 * Returns null when all 8 are checked (the deep default — no override stored),
 * otherwise the array of checked section names (always includes Next action).
 * @returns {string[]|null}
 */
function collectWrapSectionsSelection() {
  const boxes = document.querySelectorAll('.wrap-section-check');
  if (boxes.length === 0) return undefined; // section not rendered → don't touch
  const checked = [];
  for (const box of boxes) {
    if (box.checked) checked.push(box.getAttribute('data-section'));
  }
  return checked.length === WRAP_SECTION_NAMES.length ? null : checked;
}

/**
 * Transient status message in the Project Rules section.
 * @param {string} text
 * @param {boolean} ok
 */
function _setProjectRulesStatus(text, ok) {
  const status = document.getElementById('projectRulesStatus');
  if (!status) return;
  status.textContent = text;
  status.className = `rules-status ${ok ? 'rules-status-ok' : 'rules-status-err'}`;
  status.classList.remove('hidden');
  setTimeout(() => { status.classList.add('hidden'); }, 3000);
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
  // Pre-#151 the modal handled a "None" pseudo-methodology for the (broken)
  // removal path. Every project now has a methodology — fromMeth/toMeth are
  // always real ids — so the null-fallback copy paths are gone.
  const fromName = (state.methodologies.find(m => m.id === fromMeth) || {}).name || fromMeth;
  const toName = (state.methodologies.find(m => m.id === toMeth) || {}).name || toMeth;

  let html = `<p style="font-size:15px;margin-bottom:12px"><strong>${esc(fromName)}</strong> &rarr; <strong>${esc(toName)}</strong></p>`;
  html += `<p>The current <strong>${esc(fromName)}</strong> state will be archived (not deleted). Learnings, reflections, and other artifacts remain accessible.</p>`;
  html += `<p style="margin-top:8px">The new <strong>${esc(toName)}</strong> methodology will be initialized and session hooks updated.</p>`;
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
  const newName = document.getElementById('settingsName').value.trim();
  const body = {
    engine: document.getElementById('settingsEngine').value,
    // Every project has a methodology (#151); methVal is always a real template id
    methodology: methVal,
    tags: document.getElementById('settingsTags').value.split(',').map(t => t.trim()).filter(Boolean)
  };
  if (newName && newName !== settingsTarget) {
    body.name = newName;
  }
  // Silent prime (#103) — only present when the toggle was rendered (capability-gated)
  const silentPrimeEl = document.getElementById('settingsSilentPrime');
  if (silentPrimeEl) {
    body.silentPrime = silentPrimeEl.checked;
  }
  // Feature Index (#207, chunk 1) — always present (engine-agnostic)
  const featureIndexEl = document.getElementById('settingsFeatureIndex');
  if (featureIndexEl) {
    body.featureIndexEnabled = featureIndexEl.checked;
  }
  // Project Map (PIDX #360, #356) — always present (engine-agnostic)
  const projectMapEl = document.getElementById('settingsProjectMap');
  if (projectMapEl) {
    body.projectMapEnabled = projectMapEl.checked;
  }
  // Auto version-bump opt-out (#318) — always present (engine-agnostic)
  const versionBumpEl = document.getElementById('settingsVersionBump');
  if (versionBumpEl) {
    body.versionBumpEnabled = versionBumpEl.checked;
  }
  // Medusa session-comms auto-enable (MED-2K9P Chunk 02) — always present (engine-agnostic)
  const medusaEl = document.getElementById('settingsMedusa');
  if (medusaEl) {
    body.medusaEnabled = medusaEl.checked;
  }
  // CC-6 (#381): wrap-summary section selection. undefined → not rendered (skip);
  // null → all 8 (clear override); array → the chosen subset.
  const wrapSel = collectWrapSectionsSelection();
  if (wrapSel !== undefined) {
    body.wrapSections = wrapSel;
  }

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

  const engineOpts = buildEngineOptions(state.engines, c.defaultEngine || '');

  const methOpts = state.methodologies.map(m =>
    `<option value="${esc(m.id)}" ${m.id === (c.defaultMethodology || '') ? 'selected' : ''}>${esc(m.name)}</option>`
  ).join('');

  const scannerIntervalSec = Math.round((c.portScannerIntervalMs || 60000) / 1000);

  // AUTH-4b — reveal/rotate only make sense against the SAVED gate state (the
  // token is auto-generated server-side on enable + Save, not on the live
  // checkbox). serviceTokenConfigured/serviceTokenEnabled come redacted from
  // /api/config — never the raw token.
  const tokenGateActive = !!c.serviceTokenEnabled && !!c.serviceTokenConfigured;
  const tokenManageMarkup = tokenGateActive ? `
    <div class="form-group">
      <button type="button" class="btn btn-compact" id="gsRevealTokenBtn">Reveal token</button>
      <button type="button" class="btn btn-compact" id="gsRotateTokenBtn">Rotate</button>
      <div class="form-hint gs-token-display" id="gsTokenDisplay" style="display:none"></div>
      <div class="form-hint">Rotating issues a new token; sessions holding the old one lose API access until they relaunch.</div>
    </div>` : '';

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

    <div class="gs-section-label">Commit hygiene</div>
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Strip AI co-author trailers from commits</span>
        <input type="checkbox" id="gsStripAiCoauthors" ${c.stripAiCoauthors !== false ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">
        Installs a <code>commit-msg</code> git hook in every TC-managed project that strips
        <code>Co-Authored-By:</code> trailers naming an AI coding assistant (Claude, GPT, Gemini,
        Copilot, Aider, Cursor) before the commit lands. Forward-only — never touches history.
        Human co-authors (including humans at AI vendor email domains) pass through. Foreign
        commit-msg hooks (commitlint, etc.) are left alone.
      </div>
    </div>

    <div class="gs-section-label">Service Token (M2M API)</div>
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Require token on PortHub + shared-docs API</span>
        <input type="checkbox" id="gsServiceTokenEnabled" ${c.serviceTokenEnabled ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">
        When on, local calls to <code>/api/ports*</code> and <code>/api/shared-docs*</code> require an
        <code>Authorization: Bearer</code> token. TangleClaw auto-generates the token and injects it into
        every project's config guide at session launch, so sessions authenticate automatically. Default
        off (open, as today). Save to apply, then reopen to reveal the token.
      </div>
    </div>
    ${tokenManageMarkup}

    <div class="gs-section-label">Diagnostics</div>
    <div class="form-group">
      <button type="button" class="btn" id="gsRestartBtn"
              ${state.restartMechanism ? '' : 'disabled'}
              title="${state.restartMechanism ? 'Restart the TC server process' : 'Restart mechanism not available on this host'}">
        Restart TangleClaw
      </button>
      <div class="form-hint">
        ${state.restartMechanism
          ? 'Restarts the TC server process via the platform process manager. Active tmux sessions survive; the browser reconnects when the server returns (~3s).'
          : 'Disabled: no restart mechanism detected on this host (macOS launchd plist not present; Linux support is a follow-up — see GitHub issue #235).'}
      </div>
    </div>
  `;

  // #235 — wire the restart button. Inline (rather than at page init)
  // because the button only exists once the modal opens. No-op when
  // disabled (no mechanism); state.restartInFlight guards double-click
  // coalescing across the banner + modal surfaces.
  const restartBtn = document.getElementById('gsRestartBtn');
  if (restartBtn && state.restartMechanism && typeof triggerServerRestart === 'function') {
    restartBtn.addEventListener('click', () => {
      triggerServerRestart().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('server restart failed', err);
      });
    });
  }

  // AUTH-4b — reveal/rotate wiring. Buttons only exist when the gate is active
  // (tokenManageMarkup). Both render the raw token into #gsTokenDisplay via
  // textContent (XSS-safe, selectable for copy); rotate confirms first.
  const revealTokenBtn = document.getElementById('gsRevealTokenBtn');
  if (revealTokenBtn) {
    revealTokenBtn.addEventListener('click', async () => {
      const display = document.getElementById('gsTokenDisplay');
      const data = await api('/api/service-token');
      display.textContent = (data && data.token) ? data.token : (api.lastError || 'Could not reveal token');
      display.style.display = '';
    });
  }
  const rotateTokenBtn = document.getElementById('gsRotateTokenBtn');
  if (rotateTokenBtn) {
    rotateTokenBtn.addEventListener('click', async () => {
      if (!confirm('Rotate the service token? Sessions holding the current token will lose API access until they relaunch.')) return;
      const display = document.getElementById('gsTokenDisplay');
      const data = await apiMutate('/api/service-token/rotate', 'POST', {});
      if (data && data.token) {
        state.config.serviceTokenConfigured = true;
        display.textContent = data.token;
      } else {
        display.textContent = api.lastError || 'Rotate failed';
      }
      display.style.display = '';
    });
  }

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
    portScannerIntervalMs: intervalMs,
    stripAiCoauthors: document.getElementById('gsStripAiCoauthors').checked,
    serviceTokenEnabled: document.getElementById('gsServiceTokenEnabled').checked
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
    methodology: state.config ? state.config.defaultMethodology || 'minimal' : 'minimal',
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
    const engineOpts = buildEngineOptions(state.engines, createData.engine);
    const methPills = state.methodologies.map(m => {
      const sel = m.id === createData.methodology ? ' selected' : '';
      return `<div class="meth-pill${sel}" data-id="${esc(m.id)}" onclick="selectMethodology('${esc(m.id)}')">${esc(m.name)}</div>`;
    }).join('');
    // Every project has a methodology (#151) — `minimal` is the no-workflow
    // choice in the methodology picker, no separate "None" pseudo-option.
    const selMeth = createData.methodology
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
        <label class="form-label">Methodology</label>
        <div class="meth-picker">${methPills}</div>
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
    methodology: createData.methodology,
    tags
  });

  if (!result) {
    const errEl = document.getElementById('createError');
    errEl.textContent = api.lastError || 'Failed to create project.';
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

  // Auto-launch session so the user lands in an active terminal
  try {
    const launchRes = await fetch(`/api/sessions/${encodeURIComponent(createData.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (launchRes.ok) {
      navigateToSession(createData.name, { launched: true });
      return;
    }
  } catch (e) {
    // Fall through — navigate without launch
  }
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

// ── Groups Panel ──

/**
 * Toggle the groups panel open/closed from the dashboard bar.
 */
function toggleGroups() {
  state.groupsOpen = !state.groupsOpen;
  const panel = document.getElementById('groupsPanel');
  const toggle = document.getElementById('groupsToggle');
  panel.classList.toggle('open', state.groupsOpen);
  toggle.classList.toggle('active', state.groupsOpen);
  toggle.setAttribute('aria-expanded', state.groupsOpen);
}

/**
 * Render the groups panel content.
 */
function renderGroups() {
  const panel = document.getElementById('groupsPanel');
  if (state.groups.length === 0) {
    panel.innerHTML = `<div class="groups-empty">
      No project groups yet
      <button class="btn btn-small btn-primary" onclick="openGroupModal()" style="margin-left:8px">+ New Group</button>
    </div>`;
    return;
  }

  // Default all groups to open if not yet set
  for (const group of state.groups) {
    if (!(group.id in state.groupItemsOpen)) {
      state.groupItemsOpen[group.id] = false;
    }
  }

  let html = `<div class="groups-header-actions">
    <button class="btn btn-small btn-primary" onclick="openGroupModal()">+ New Group</button>
  </div>`;

  for (const group of state.groups) {
    const isOpen = state.groupItemsOpen[group.id] === true;
    const arrowClass = isOpen ? 'arrow open' : 'arrow';
    const contentClass = isOpen ? 'group-item-content open' : 'group-item-content';

    html += `<div class="group-item">`;
    html += `<div class="group-item-toggle" role="button" tabindex="0"
      aria-expanded="${isOpen}" onclick="toggleGroupItem('${esc(group.id)}')"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleGroupItem('${esc(group.id)}');}">
      <span class="${arrowClass}">&#9660;</span>
      <span class="group-item-name">${esc(group.name)}</span>
      <span class="group-item-meta">${group.memberCount || 0} project${(group.memberCount || 0) !== 1 ? 's' : ''}, ${group.docCount || 0} doc${(group.docCount || 0) !== 1 ? 's' : ''}</span>
      <button class="btn btn-compact btn-icon-tiny" onclick="event.stopPropagation(); openGroupModal('${esc(group.id)}')" title="Edit group">&#9998;</button>
    </div>`;
    html += `<div class="${contentClass}">`;
    if (group.description) {
      html += `<div class="group-item-desc">${esc(group.description)}</div>`;
    }
    html += `<div class="group-item-loading">Loading details...</div>`;
    html += '</div></div>';
  }

  panel.innerHTML = html;

  // Load details for open groups
  for (const group of state.groups) {
    if (state.groupItemsOpen[group.id]) {
      loadGroupDetail(group.id);
    }
  }
}

/**
 * Toggle a group item open/closed and load its details.
 * @param {string} groupId
 */
function toggleGroupItem(groupId) {
  state.groupItemsOpen[groupId] = !state.groupItemsOpen[groupId];
  renderGroups();
}

/**
 * Load group details (members + docs) and render inline.
 * @param {string} groupId
 */
async function loadGroupDetail(groupId) {
  const data = await api(`/api/groups/${groupId}`);
  if (!data) return;

  // Find the content div for this group
  const items = document.querySelectorAll('.group-item');
  for (const item of items) {
    const toggle = item.querySelector('.group-item-toggle');
    if (!toggle) continue;
    const nameEl = toggle.querySelector('.group-item-name');
    // Match by group name since IDs aren't on DOM elements
    const group = state.groups.find(g => g.id === groupId);
    if (!group || !nameEl || nameEl.textContent !== group.name) continue;

    const content = item.querySelector('.group-item-content');
    if (!content) break;

    let html = '';
    if (data.description) {
      html += `<div class="group-item-desc">${esc(data.description)}</div>`;
    }
    if (data.sharedDir) {
      html += `<div class="group-item-desc" style="font-family:monospace;font-size:0.85em;opacity:0.7">${esc(data.sharedDir)}</div>`;
    }

    // Members
    html += `<div class="group-detail-label">Members</div>`;
    if (data.members && data.members.length > 0) {
      html += `<div class="group-members-inline">`;
      for (const m of data.members) {
        html += `<div class="group-member-row">
          <span class="group-member-name">${esc(m.name)}</span>
          <button class="btn btn-compact btn-icon-tiny btn-danger-subtle" onclick="event.stopPropagation(); removeGroupMember('${esc(groupId)}', ${m.id})" title="Remove from group">&times;</button>
        </div>`;
      }
      html += `</div>`;
    } else {
      html += `<div class="group-empty-hint">No members</div>`;
    }

    // Docs
    html += `<div class="group-detail-label" style="margin-top:8px">Shared Documents</div>`;
    if (data.docs && data.docs.length > 0) {
      html += `<div class="group-docs-inline">`;
      for (const doc of data.docs) {
        const lockHtml = doc.lock
          ? `<span class="doc-lock-indicator locked" title="Locked by ${esc(doc.lock.lockedByProject)}">&#128274;</span>`
          : `<span class="doc-lock-indicator" title="Unlocked">&#128275;</span>`;
        html += `<div class="group-doc-row">
          ${lockHtml}
          <span class="group-doc-name">${esc(doc.name)}</span>
          <span class="group-doc-mode badge">${esc(doc.injectMode)}</span>
          ${doc.injectIntoConfig ? '<span class="group-doc-inject badge badge-engine">inject</span>' : ''}
          <button class="btn btn-compact btn-icon-tiny btn-danger-subtle" onclick="event.stopPropagation(); removeSharedDoc('${esc(doc.id)}')" title="Remove document">&times;</button>
        </div>`;
      }
      html += `</div>`;
    } else {
      html += `<div class="group-empty-hint">No shared documents</div>`;
    }

    content.innerHTML = html;
    break;
  }
}

/**
 * Remove a member from a group.
 * @param {string} groupId
 * @param {number} projectId
 */
async function removeGroupMember(groupId, projectId) {
  await apiMutate(`/api/groups/${groupId}/members/${projectId}`, 'DELETE', {});
  await loadGroups();
  await loadProjects();
}

/**
 * Remove a shared document registration.
 * @param {string} docId
 */
async function removeSharedDoc(docId) {
  await apiMutate(`/api/shared-docs/${docId}`, 'DELETE', {});
  await loadGroups();
}

// ── Group Modal ──

let groupEditId = null;

/**
 * Open the group modal for create or edit.
 * @param {string} [groupId] - If provided, opens in edit mode
 */
async function openGroupModal(groupId) {
  groupEditId = groupId || null;
  const isEdit = !!groupId;

  document.getElementById('groupModalTitle').textContent = isEdit ? 'Edit Group' : 'New Group';
  document.getElementById('groupSaveBtn').textContent = isEdit ? 'Save' : 'Create';
  document.getElementById('groupError').classList.add('hidden');

  // Always show members section — checkboxes of all registered projects
  const membersSection = document.getElementById('groupMembersSection');
  membersSection.classList.remove('hidden');

  // Reset shared dir fields
  document.getElementById('groupSyncStatus').classList.add('hidden');

  if (isEdit) {
    const data = await api(`/api/groups/${groupId}`);
    if (!data) return;
    document.getElementById('groupName').value = data.name || '';
    document.getElementById('groupDesc').value = data.description || '';
    document.getElementById('groupSharedDir').value = data.sharedDir || '';
    document.getElementById('groupDeleteBtn').classList.remove('hidden');

    renderGroupMembers(data.members || [], groupId);

    // Show docs section (edit only — need a group to attach docs to)
    const docsSection = document.getElementById('groupDocsSection');
    docsSection.classList.remove('hidden');
    renderGroupDocs(data.docs || []);
  } else {
    document.getElementById('groupName').value = '';
    document.getElementById('groupDesc').value = '';
    document.getElementById('groupSharedDir').value = '';
    document.getElementById('groupDeleteBtn').classList.add('hidden');
    document.getElementById('groupDocsSection').classList.add('hidden');

    // Show all projects unchecked for new group
    renderGroupMembers([], null);
  }

  document.getElementById('groupModal').classList.add('open');
  setTimeout(() => document.getElementById('groupName').focus(), 100);
}

/**
 * Render member checkboxes for group edit.
 * @param {object[]} currentMembers - Current group members
 * @param {string} groupId
 */
function renderGroupMembers(currentMembers, groupId) {
  const list = document.getElementById('groupMembersList');
  const memberIds = new Set(currentMembers.map(m => m.id));

  const registeredProjects = state.projects.filter(p => p.registered !== false);
  if (registeredProjects.length === 0) {
    list.innerHTML = '<div class="group-empty-hint">No projects available</div>';
    return;
  }

  list.innerHTML = registeredProjects.map(p => {
    const checked = memberIds.has(p.id) ? 'checked' : '';
    if (groupId) {
      // Edit mode — toggle membership immediately via API
      return `<label class="group-member-check">
        <input type="checkbox" ${checked} onchange="toggleGroupMembership('${esc(groupId)}', ${p.id}, this.checked)">
        <span>${esc(p.name)}</span>
      </label>`;
    } else {
      // Create mode — just checkboxes, saved on group create
      return `<label class="group-member-check">
        <input type="checkbox" ${checked} data-project-id="${p.id}">
        <span>${esc(p.name)}</span>
      </label>`;
    }
  }).join('');
}

/**
 * Render shared docs list in group edit modal.
 * @param {object[]} docs
 */
function renderGroupDocs(docs) {
  const list = document.getElementById('groupDocsList');
  if (docs.length === 0) {
    list.innerHTML = '<div class="group-empty-hint">No shared documents registered</div>';
    return;
  }
  list.innerHTML = docs.map(doc => {
    const lockIcon = doc.lock ? '&#128274;' : '&#128275;';
    return `<div class="group-doc-edit-row">
      <span>${lockIcon}</span>
      <span class="group-doc-name">${esc(doc.name)}</span>
      <span class="badge">${esc(doc.injectMode)}</span>
      <button class="btn btn-compact btn-icon-tiny btn-danger-subtle" onclick="deleteDocFromModal('${esc(doc.id)}')" title="Remove">&times;</button>
    </div>`;
  }).join('');
}

/**
 * Toggle a project's membership in a group.
 * @param {string} groupId
 * @param {number} projectId
 * @param {boolean} add
 */
async function toggleGroupMembership(groupId, projectId, add) {
  if (add) {
    await apiMutate(`/api/groups/${groupId}/members`, 'POST', { projectId });
  } else {
    await apiMutate(`/api/groups/${groupId}/members/${projectId}`, 'DELETE', {});
  }
}

/**
 * Delete a shared doc from within the group edit modal, then refresh.
 * @param {string} docId
 */
async function deleteDocFromModal(docId) {
  await apiMutate(`/api/shared-docs/${docId}`, 'DELETE', {});
  if (groupEditId) {
    const data = await api(`/api/groups/${groupEditId}`);
    if (data) renderGroupDocs(data.docs || []);
  }
}

/**
 * Close the group modal.
 */
function closeGroupModal() {
  document.getElementById('groupModal').classList.remove('open');
  groupEditId = null;
}

/**
 * Save (create or update) a group.
 */
async function saveGroup() {
  let name = document.getElementById('groupName').value.trim();
  const description = document.getElementById('groupDesc').value.trim();

  // Auto-generate name from selected members if blank
  if (!name) {
    const checked = document.querySelectorAll('#groupMembersList input[type="checkbox"]:checked');
    const names = [];
    checked.forEach(cb => {
      const label = cb.closest('label');
      if (label) {
        const span = label.querySelector('span');
        if (span) names.push(span.textContent.trim());
      }
    });
    if (names.length === 0) {
      document.getElementById('groupError').textContent = 'Select at least one member or enter a name';
      document.getElementById('groupError').classList.remove('hidden');
      return;
    }
    name = names.length <= 3
      ? names.join(' + ')
      : names.slice(0, 2).join(' + ') + ` +${names.length - 2} more`;
  }

  const sharedDir = document.getElementById('groupSharedDir').value.trim();
  const body = { name, description: description || null, sharedDir: sharedDir || null };
  let result;

  if (groupEditId) {
    result = await apiMutate(`/api/groups/${groupEditId}`, 'PUT', body);
  } else {
    result = await apiMutate('/api/groups', 'POST', body);
  }

  if (!result) {
    document.getElementById('groupError').textContent = 'Save failed. Name may already exist.';
    document.getElementById('groupError').classList.remove('hidden');
    return;
  }

  // On create, add checked members
  if (!groupEditId && result.id) {
    const checkboxes = document.querySelectorAll('#groupMembersList input[data-project-id]:checked');
    for (const cb of checkboxes) {
      const projectId = parseInt(cb.dataset.projectId, 10);
      await apiMutate(`/api/groups/${result.id}/members`, 'POST', { projectId });
    }
  }

  closeGroupModal();
  await loadGroups();
  await loadProjects();
}

/**
 * Open the delete group confirmation modal.
 */
function openGroupDeleteConfirm() {
  if (!groupEditId) return;
  const group = state.groups.find(g => g.id === groupEditId);
  document.getElementById('groupDeleteText').textContent =
    `Delete group "${group ? group.name : ''}"? This removes all member associations and shared document registrations. Project files are not affected.`;
  document.getElementById('groupDeleteModal').classList.add('open');
}

/**
 * Close the delete group confirmation modal.
 */
function closeGroupDeleteConfirm() {
  document.getElementById('groupDeleteModal').classList.remove('open');
}

/**
 * Confirm group deletion.
 */
async function confirmGroupDelete() {
  if (!groupEditId) return;
  await apiMutate(`/api/groups/${groupEditId}`, 'DELETE', {});
  closeGroupDeleteConfirm();
  closeGroupModal();
  await loadGroups();
  await loadProjects();
}

/**
 * Sync shared docs from the group's shared directory.
 */
async function syncGroupDir() {
  if (!groupEditId) {
    const statusEl = document.getElementById('groupSyncStatus');
    statusEl.textContent = 'Save the group first, then sync.';
    statusEl.classList.remove('hidden');
    return;
  }
  const statusEl = document.getElementById('groupSyncStatus');
  statusEl.textContent = 'Syncing...';
  statusEl.classList.remove('hidden');

  // Save sharedDir first if changed
  const sharedDir = document.getElementById('groupSharedDir').value.trim();
  if (sharedDir) {
    await apiMutate(`/api/groups/${groupEditId}`, 'PUT', { sharedDir });
  }

  const result = await apiMutate(`/api/groups/${groupEditId}/sync`, 'POST', {});
  if (!result) {
    statusEl.textContent = 'Sync failed — check the directory path.';
    return;
  }
  const parts = [];
  if (result.added && result.added.length > 0) parts.push(`${result.added.length} added`);
  if (result.skipped && result.skipped.length > 0) parts.push(`${result.skipped.length} existing`);
  if (result.errors && result.errors.length > 0) parts.push(`${result.errors.length} error(s)`);
  statusEl.textContent = parts.length > 0 ? parts.join(', ') : 'No .md files found';

  // Refresh docs list
  const data = await api(`/api/groups/${groupEditId}`);
  if (data) renderGroupDocs(data.docs || []);
}

// ── OpenClaw Connections ──

/**
 * Toggle the OpenClaw connections panel open/closed.
 */
function toggleOpenclaw() {
  state.openclawOpen = !state.openclawOpen;
  const panel = document.getElementById('openclawPanel');
  const toggle = document.getElementById('openclawToggle');
  panel.classList.toggle('open', state.openclawOpen);
  toggle.classList.toggle('active', state.openclawOpen);
  toggle.setAttribute('aria-expanded', state.openclawOpen);
}

/**
 * Render the OpenClaw connections panel content.
 */
function renderOpenclawConnections() {
  const panel = document.getElementById('openclawPanel');
  if (state.openclawConnections.length === 0) {
    panel.innerHTML = `<div class="openclaw-empty">
      No OpenClaw connections
      <button class="btn btn-small btn-primary" onclick="openConnectionModal()" style="margin-left:8px">+ Add Connection</button>
      <button class="btn btn-small" onclick="openOpenclawSetupModal()" style="margin-left:4px" title="What the + Add Connection button does, the fields it asks for, and an AI-agent setup prompt">Read Me</button>
    </div>`;
    return;
  }

  let html = `<div class="openclaw-header-actions">
    <button class="btn btn-small btn-primary" onclick="openConnectionModal()">+ Add Connection</button>
    <button class="btn btn-small" onclick="openOpenclawSetupModal()" title="What the + Add Connection button does, the fields it asks for, and an AI-agent setup prompt">Read Me</button>
  </div>`;

  for (const conn of state.openclawConnections) {
    const isOpen = state.openclawItemsOpen[conn.id] === true;
    const arrowClass = isOpen ? 'arrow open' : 'arrow';
    const contentClass = isOpen ? 'oc-item-content open' : 'oc-item-content';
    // #459: the "engine" badge is gone — connections are no longer offered
    // as project engines; the top-bar OpenClaw panel is the access surface.
    const engineBadge = '';

    html += `<div class="oc-item">`;
    html += `<div class="oc-item-toggle" role="button" tabindex="0"
      aria-expanded="${isOpen}" onclick="toggleOpenclawItem('${esc(conn.id)}')"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleOpenclawItem('${esc(conn.id)}');}">
      <span class="${arrowClass}">&#9660;</span>
      <span class="oc-item-name">${esc(conn.name)}</span>
      ${engineBadge}
      <span class="oc-item-meta">${esc(conn.host)}:${conn.port}</span>
      <button class="btn btn-compact btn-icon-tiny" onclick="event.stopPropagation(); openConnectionModal('${esc(conn.id)}')" title="Edit connection">&#9998;</button>
    </div>`;
    html += `<div class="${contentClass}">`;
    html += `<div class="oc-detail-grid">
      <span class="oc-detail-label">Host</span><span class="oc-detail-value">${esc(conn.host)}</span>
      <span class="oc-detail-label">Port</span><span class="oc-detail-value">${conn.port}</span>
      <span class="oc-detail-label">SSH User</span><span class="oc-detail-value">${esc(conn.sshUser)}</span>
      <span class="oc-detail-label">SSH Key</span><span class="oc-detail-value" style="font-family:monospace;font-size:0.85em">${esc(conn.sshKeyPath)}</span>
      <span class="oc-detail-label">CLI Command</span><span class="oc-detail-value" style="font-family:monospace;font-size:0.85em">${esc(conn.cliCommand || 'openclaw-cli')}</span>
      <span class="oc-detail-label">Local Port</span><span class="oc-detail-value">${conn.localPort}</span>
      ${conn.bridgePort
        ? `<span class="oc-detail-label">Bridge Port</span><span class="oc-detail-value" title="ClawBridge port (auto-allocatable — see Edit → Bridge Port)">${conn.bridgePort}</span>`
        : ''}
      <span class="oc-detail-label">Version</span>${conn.instanceDir
        ? `<span class="oc-detail-value" id="ocVer-${esc(conn.id)}" title="OpenClaw instance image tag (${esc(conn.instanceDir)}/.env)">checking…</span>`
        : `<span class="oc-detail-value oc-detail-muted" title="Set this connection's Instance Dir (Edit → Instance Dir) to read its OpenClaw image tag over SSH">Set Instance Dir to enable</span>`}
    </div>`;
    // Tunnel status + kill button
    const ts = state.openclawTunnelStatus[conn.id];
    if (ts && ts.active) {
      html += `<div class="oc-tunnel-status">
        <span class="badge badge-tunnel-active">tunnel active</span>
        <span class="oc-tunnel-detail">port ${ts.localPort}${ts.pid ? `, PID ${ts.pid}` : ''}</span>
        <button class="btn btn-small btn-danger-subtle" onclick="event.stopPropagation(); killOpenclawTunnel('${esc(conn.id)}')" title="Kill SSH tunnel and release port">Kill Tunnel</button>
      </div>`;
    }

    html += `<div class="oc-actions">
      <button class="btn btn-small btn-primary" onclick="event.stopPropagation(); launchOpenclawWebUI('${esc(conn.id)}')" title="Open Web UI via tunnel">Web UI</button>
      <button class="btn btn-small" onclick="event.stopPropagation(); copyOpenclawSSH('${esc(conn.id)}')" title="Copy SSH command to clipboard">SSH</button>
    </div>`;
    html += '</div></div>';
  }

  panel.innerHTML = html;

  // #296: populate each connection's OpenClaw version asynchronously (the
  // endpoint reads the instance .env over SSH; server-side cached, so repeated
  // renders are cheap). Every connection renders a Version row (#306), but only
  // those with an instanceDir have a fetchable `ocVer-<id>` value to populate —
  // the rest already show a static "Set Instance Dir to enable" hint.
  for (const conn of state.openclawConnections) {
    if (!conn.instanceDir) continue;
    const el = document.getElementById(`ocVer-${conn.id}`);
    if (!el) continue;
    api(`/api/openclaw/connections/${encodeURIComponent(conn.id)}/version`).then((r) => {
      if (r && r.version) {
        el.textContent = r.version;
      } else {
        el.textContent = 'unknown';
        if (r && r.error) el.title = r.error;
      }
    }).catch(() => { el.textContent = 'unknown'; });
  }
}

/**
 * Toggle an OpenClaw connection item open/closed.
 * @param {string} connId
 */
function toggleOpenclawItem(connId) {
  state.openclawItemsOpen[connId] = !state.openclawItemsOpen[connId];
  renderOpenclawConnections();
}

/**
 * Launch OpenClaw Web UI in the viewer page.
 * @param {string} connId - Connection ID
 */
function launchOpenclawWebUI(connId) {
  window.open(`/openclaw-view/${encodeURIComponent(connId)}`, '_blank');
}

/**
 * Copy SSH command for an OpenClaw connection to clipboard.
 * @param {string} connId - Connection ID
 */
async function copyOpenclawSSH(connId) {
  const conn = state.openclawConnections.find(c => c.id === connId);
  if (!conn) return;

  const sshCmd = `ssh -i ${conn.sshKeyPath} ${conn.sshUser}@${conn.host}`;
  const toast = document.getElementById('toast');

  const ok = await tcCopyToClipboard(sshCmd);
  // On failure show the command itself so it can be hand-selected.
  toast.textContent = ok ? `Copied: ${sshCmd}` : sshCmd;
  toast.className = 'toast toast-ok visible';
  setTimeout(() => toast.classList.remove('visible'), 5000);
}

/**
 * Open the OpenClaw "Read Me" setup-guide modal — explains the + Add
 * Connection flow + the fields it asks for, and holds a copy-paste prompt
 * for an AI agent setting up an OpenClaw instance. Closed only by explicit
 * user action (Close / backdrop), never on a timer.
 */
function openOpenclawSetupModal() {
  document.getElementById('openclawSetupModal').classList.add('open');
}

/**
 * Close the OpenClaw setup-guide modal.
 */
function closeOpenclawSetupModal() {
  document.getElementById('openclawSetupModal').classList.remove('open');
}

/**
 * Copy the AI-agent setup prompt (verbatim from the modal's <pre>) to the
 * clipboard, with a toast confirmation. Single source of truth: the prompt
 * text lives in the modal markup, not duplicated here.
 */
async function copyOpenclawSetupPrompt() {
  const prompt = (document.getElementById('ocSetupPrompt')?.textContent || '').trim();
  const toast = document.getElementById('toast');
  const ok = await tcCopyToClipboard(prompt);
  toast.textContent = ok ? 'Setup prompt copied to clipboard' : 'Copy failed — select the prompt text manually';
  toast.className = ok ? 'toast toast-ok visible' : 'toast toast-warn visible';
  setTimeout(() => toast.classList.remove('visible'), 5000);
}

/**
 * Auto-detect the connection's Instance Dir over SSH (#306-followup) using the
 * Host / SSH User / SSH Key Path already entered in the form. Fills the
 * Instance Dir input with the first candidate; surfaces a toast for the result.
 */
async function detectOcInstanceDir() {
  const host = document.getElementById('ocHost').value.trim();
  const sshUser = document.getElementById('ocSshUser').value.trim();
  const sshKeyPath = document.getElementById('ocSshKeyPath').value.trim();
  const btn = document.getElementById('ocDetectBtn');
  const input = document.getElementById('ocInstanceDir');
  const toast = document.getElementById('toast');
  const flash = (msg, kind) => {
    toast.textContent = msg;
    toast.className = `toast toast-${kind} visible`;
    setTimeout(() => toast.classList.remove('visible'), 5000);
  };

  if (!host || !sshUser || !sshKeyPath) {
    flash('Fill Host, SSH User, and SSH Key Path first, then Detect', 'warn');
    return;
  }

  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = 'Detecting…';
  try {
    const r = await apiMutate('/api/openclaw/detect-instance-dir', 'POST', { host, sshUser, sshKeyPath });
    if (r && Array.isArray(r.dirs) && r.dirs.length) {
      input.value = r.dirs[0];
      flash(r.dirs.length > 1
        ? `Found ${r.dirs.length} candidates — using ${r.dirs[0]}`
        : `Detected ${r.dirs[0]}`, 'ok');
    } else {
      flash((r && r.error) ? r.error : 'No OpenClaw stack found on the host', 'warn');
    }
  } catch (err) {
    flash(`Detect failed: ${err && err.message ? err.message : 'request error'}`, 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

/**
 * Kill an OpenClaw SSH tunnel with confirmation.
 * @param {string} connId - Connection ID
 */
async function killOpenclawTunnel(connId) {
  const conn = state.openclawConnections.find(c => c.id === connId);
  if (!conn) return;

  const ts = state.openclawTunnelStatus[connId];
  const detail = ts ? `Port ${ts.localPort}${ts.pid ? `, PID ${ts.pid}` : ''}` : `Port ${conn.localPort}`;

  if (!confirm(`Kill SSH tunnel for "${conn.name}"?\n\n${detail}\n\nThis will terminate the SSH process and release the port. Any active Web UI sessions using this tunnel will be ended.`)) {
    return;
  }

  const res = await fetch(`/api/openclaw/connections/${encodeURIComponent(connId)}/tunnel`, {
    method: 'DELETE'
  });

  const toast = document.getElementById('toast');
  if (res.ok) {
    const data = await res.json();
    toast.textContent = `Tunnel killed${data.killedPid ? ` (PID ${data.killedPid})` : ''} — port ${data.localPort} released`;
    toast.className = 'toast toast-ok visible';
    delete state.openclawTunnelStatus[connId];
    renderOpenclawConnections();
  } else {
    const data = await res.json().catch(() => ({}));
    toast.textContent = data.error || 'Failed to kill tunnel';
    toast.className = 'toast toast-err visible';
  }
  setTimeout(() => toast.classList.remove('visible'), 5000);
}

// ── OpenClaw Connection Modal ──

let ocEditId = null;

/**
 * Open the connection modal for create or edit.
 * @param {string} [connId] - If provided, opens in edit mode
 */
async function openConnectionModal(connId) {
  ocEditId = connId || null;
  const isEdit = !!connId;

  document.getElementById('openclawModalTitle').textContent = isEdit ? 'Edit Connection' : 'New Connection';
  document.getElementById('ocSaveBtn').textContent = isEdit ? 'Save' : 'Create';
  document.getElementById('ocError').classList.add('hidden');
  document.getElementById('ocTestResult').classList.add('hidden');

  if (isEdit) {
    const data = await api(`/api/openclaw/connections/${connId}`);
    if (!data) return;
    document.getElementById('ocName').value = data.name || '';
    document.getElementById('ocHost').value = data.host || '';
    document.getElementById('ocSshUser').value = data.sshUser || '';
    document.getElementById('ocPort').value = data.port || 18789;
    document.getElementById('ocSshKeyPath').value = data.sshKeyPath || '';
    document.getElementById('ocGatewayToken').value = data.gatewayToken || '';
    document.getElementById('ocCliCommand').value = data.cliCommand || 'openclaw-cli';
    document.getElementById('ocLocalPort').value = data.localPort || 18789;
    // Leave blank when bridgePort is null/0 (most non-ClawBridge connections)
    // so re-saving without touching the field doesn't re-introduce the stray
    // 3201 placeholder default (#160).
    document.getElementById('ocBridgePort').value = data.bridgePort != null && data.bridgePort !== 0 ? data.bridgePort : '';
    document.getElementById('ocBridgeToken').value = data.bridgeToken || '';
    document.getElementById('ocInstanceDir').value = data.instanceDir || '';
    document.getElementById('ocDeleteBtn').classList.remove('hidden');
  } else {
    document.getElementById('ocName').value = '';
    document.getElementById('ocHost').value = '';
    document.getElementById('ocSshUser').value = '';
    document.getElementById('ocPort').value = '18789';
    document.getElementById('ocSshKeyPath').value = '';
    document.getElementById('ocGatewayToken').value = '';
    document.getElementById('ocCliCommand').value = 'openclaw-cli';
    // Leave blank by default: an omitted localPort makes PortHub auto-allocate
    // the first free port (#352), so a second connection can't collide on the
    // legacy 18789 default. The placeholder communicates the auto behavior.
    document.getElementById('ocLocalPort').value = '';
    // Leave blank by default: blank = no bridge port (#160). The operator
    // can type a port or the literal "auto" / press the Auto button for
    // server-side allocation (#489).
    document.getElementById('ocBridgePort').value = '';
    document.getElementById('ocBridgeToken').value = '';
    document.getElementById('ocInstanceDir').value = '';
    document.getElementById('ocDeleteBtn').classList.add('hidden');
  }

  document.getElementById('openclawModal').classList.add('open');
  setTimeout(() => document.getElementById('ocName').focus(), 100);
}

/**
 * Close the connection modal.
 */
function closeConnectionModal() {
  document.getElementById('openclawModal').classList.remove('open');
  ocEditId = null;
}

/**
 * Fill the Bridge Port field with the literal "auto" (#489, OUI-2F8K) so
 * the next save asks the server to allocate a free bridge port from the
 * ClawBridge range (#352 create; idempotent on update, #483).
 */
function fillBridgePortAuto() {
  const input = document.getElementById('ocBridgePort');
  input.value = 'auto';
  input.focus();
}

/**
 * Save (create or update) an OpenClaw connection.
 */
async function saveConnection() {
  const name = document.getElementById('ocName').value.trim();
  const host = document.getElementById('ocHost').value.trim();
  const sshUser = document.getElementById('ocSshUser').value.trim();
  const sshKeyPath = document.getElementById('ocSshKeyPath').value.trim();

  if (!name || !host || !sshUser || !sshKeyPath) {
    document.getElementById('ocError').textContent = 'Name, host, SSH user, and SSH key path are required';
    document.getElementById('ocError').classList.remove('hidden');
    return;
  }

  // Bridge Port accepts blank (no bridge port, #160), a number, or the
  // literal "auto" (server-side free-port allocation — #352 create, #483
  // idempotent update; #489). Reject anything else BEFORE building the
  // body: coercing a typo to null would silently clear the stored bridge
  // port on edit and release its lease.
  const bridgeParse = tcParseBridgePort(document.getElementById('ocBridgePort').value);
  if (!bridgeParse.ok) {
    document.getElementById('ocError').textContent = bridgeParse.error;
    document.getElementById('ocError').classList.remove('hidden');
    return;
  }

  const body = {
    name,
    host,
    port: parseInt(document.getElementById('ocPort').value, 10) || 18789,
    sshUser,
    sshKeyPath,
    gatewayToken: document.getElementById('ocGatewayToken').value.trim() || null,
    cliCommand: document.getElementById('ocCliCommand').value.trim() || 'openclaw-cli',
    localPort: (() => {
      // Blank field → omit the key entirely so the server auto-allocates a free
      // port on create (#352); on edit, omitting it leaves the stored port
      // unchanged. A typed value is sent verbatim. (JSON.stringify drops
      // undefined-valued keys, so returning undefined omits localPort.)
      const raw = document.getElementById('ocLocalPort').value.trim();
      if (raw === '') return undefined;
      const parsed = parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    })(),
    bridgePort: bridgeParse.value,
    bridgeToken: document.getElementById('ocBridgeToken').value.trim() || null,
    instanceDir: document.getElementById('ocInstanceDir').value.trim() || null
    // availableAsEngine intentionally omitted (#459): connections are no
    // longer offered as project engines. The DB column persists untouched.
  };

  let result;
  if (ocEditId) {
    result = await apiMutate(`/api/openclaw/connections/${ocEditId}`, 'PUT', body);
  } else {
    result = await apiMutate('/api/openclaw/connections', 'POST', body);
  }

  if (!result) {
    // Surface the actual server error if api.lastError captured it from the
    // JSON response (api-helper.js, PR #84 / issue #80) — covers PORT_CONFLICT,
    // CONFLICT, BAD_REQUEST, etc. Falls back to the previous generic message
    // only when no error payload was returned (e.g. network failure mid-save).
    const code = api.lastErrorCode ? ` (${api.lastErrorCode})` : '';
    document.getElementById('ocError').textContent = api.lastError
      ? `Save failed: ${api.lastError}${code}`
      : 'Save failed. Name may already exist.';
    document.getElementById('ocError').classList.remove('hidden');
    return;
  }

  closeConnectionModal();
  await loadOpenclawConnections();
}

/**
 * Test an OpenClaw connection's SSH and gateway connectivity.
 */
async function testConnection() {
  const host = document.getElementById('ocHost').value.trim();
  const sshUser = document.getElementById('ocSshUser').value.trim();
  const sshKeyPath = document.getElementById('ocSshKeyPath').value.trim();

  if (!host || !sshUser || !sshKeyPath) {
    document.getElementById('ocError').textContent = 'Host, SSH user, and SSH key path are required to test';
    document.getElementById('ocError').classList.remove('hidden');
    return;
  }

  const resultEl = document.getElementById('ocTestResult');
  resultEl.textContent = 'Testing...';
  resultEl.className = 'oc-test-result oc-test-pending';

  const body = {
    host,
    sshUser,
    sshKeyPath,
    port: parseInt(document.getElementById('ocPort').value, 10) || 18789,
    localPort: parseInt(document.getElementById('ocLocalPort').value, 10) || 18789
  };

  const data = await apiMutate('/api/openclaw/test', 'POST', body);
  if (!data) {
    resultEl.textContent = 'Test failed — could not reach server';
    resultEl.className = 'oc-test-result oc-test-fail';
    return;
  }

  const parts = [];
  parts.push(data.ssh ? 'SSH: OK' : 'SSH: FAIL');
  parts.push(data.gateway ? 'Gateway: OK' : 'Gateway: FAIL');
  if (data.errors && data.errors.length > 0) {
    parts.push(data.errors.join('; '));
  }

  const allOk = data.ssh && data.gateway;
  resultEl.textContent = parts.join(' — ');
  resultEl.className = `oc-test-result ${allOk ? 'oc-test-ok' : 'oc-test-fail'}`;
}

/**
 * Open the delete connection confirmation modal.
 */
function openConnectionDeleteConfirm() {
  if (!ocEditId) return;
  const conn = state.openclawConnections.find(c => c.id === ocEditId);
  document.getElementById('ocDeleteText').textContent =
    `Delete connection "${conn ? conn.name : ''}"? Any projects using it as an engine will need reconfiguration.`;
  document.getElementById('openclawDeleteModal').classList.add('open');
}

/**
 * Close the delete connection confirmation modal.
 */
function closeConnectionDeleteConfirm() {
  document.getElementById('openclawDeleteModal').classList.remove('open');
}

/**
 * Confirm connection deletion.
 */
async function confirmConnectionDelete() {
  if (!ocEditId) return;
  await apiMutate(`/api/openclaw/connections/${ocEditId}`, 'DELETE', {});
  closeConnectionDeleteConfirm();
  closeConnectionModal();
  await loadOpenclawConnections();
}

// ── Shared Doc Modal ──

let docEditGroupId = null;
let docEditId = null;

/**
 * Open the add/edit shared document modal.
 * @param {string} [groupId] - Group to add the doc to (required for new)
 * @param {string} [docId] - If editing an existing doc
 */
async function openDocModal(groupId, docId) {
  docEditGroupId = groupId || groupEditId;
  docEditId = docId || null;

  const isEdit = !!docId;
  document.getElementById('docModalTitle').textContent = isEdit ? 'Edit Document' : 'Add Shared Document';
  document.getElementById('docSaveBtn').textContent = isEdit ? 'Save' : 'Add';
  document.getElementById('docError').classList.add('hidden');

  if (isEdit) {
    const data = await api(`/api/shared-docs/${docId}`);
    if (!data) return;
    document.getElementById('docName').value = data.name || '';
    document.getElementById('docFilePath').value = data.filePath || '';
    document.getElementById('docDescription').value = data.description || '';
    document.getElementById('docInjectMode').value = data.injectMode || 'reference';
    document.getElementById('docInjectToggle').checked = data.injectIntoConfig !== false;
  } else {
    document.getElementById('docName').value = '';
    document.getElementById('docFilePath').value = '';
    document.getElementById('docDescription').value = '';
    document.getElementById('docInjectMode').value = 'reference';
    document.getElementById('docInjectToggle').checked = true;
  }

  document.getElementById('docModal').classList.add('open');
  setTimeout(() => document.getElementById('docName').focus(), 100);
}

/**
 * Close the doc modal.
 */
function closeDocModal() {
  document.getElementById('docModal').classList.remove('open');
  docEditGroupId = null;
  docEditId = null;
}

/**
 * Save (create or update) a shared document.
 */
async function saveDoc() {
  const name = document.getElementById('docName').value.trim();
  const filePath = document.getElementById('docFilePath').value.trim();

  if (!name || !filePath) {
    document.getElementById('docError').textContent = 'Name and file path are required';
    document.getElementById('docError').classList.remove('hidden');
    return;
  }

  const body = {
    name,
    filePath,
    description: document.getElementById('docDescription').value.trim() || null,
    injectMode: document.getElementById('docInjectMode').value,
    injectIntoConfig: document.getElementById('docInjectToggle').checked
  };

  let result;
  if (docEditId) {
    result = await apiMutate(`/api/shared-docs/${docEditId}`, 'PUT', body);
  } else {
    body.groupId = docEditGroupId;
    result = await apiMutate('/api/shared-docs', 'POST', body);
  }

  if (!result) {
    document.getElementById('docError').textContent = 'Save failed. File path may already exist in this group.';
    document.getElementById('docError').classList.remove('hidden');
    return;
  }

  closeDocModal();

  // Refresh group edit modal if open
  if (groupEditId) {
    const data = await api(`/api/groups/${groupEditId}`);
    if (data) renderGroupDocs(data.docs || []);
  }
  await loadGroups();
}

// ── Eval Audit Panel ──

/**
 * Toggle the Eval Audit panel open/closed.
 */
function toggleAudit() {
  state.auditOpen = !state.auditOpen;
  const panel = document.getElementById('auditPanel');
  const toggle = document.getElementById('auditToggle');
  panel.classList.toggle('open', state.auditOpen);
  toggle.classList.toggle('active', state.auditOpen);
  toggle.setAttribute('aria-expanded', state.auditOpen);
  if (state.auditOpen && !state.auditLoaded) {
    loadAuditSummaries();
  }
}

/**
 * Load audit summaries for all projects that have audit enabled.
 */
async function loadAuditSummaries() {
  state.auditLoaded = true;
  const auditProjects = state.projects.filter(p => p.evalAudit && p.evalAudit.enabled);
  if (auditProjects.length === 0) {
    renderAuditPanel();
    return;
  }

  state.auditSummaries = {};
  const summaries = await Promise.all(
    auditProjects.map(async (p) => {
      const data = await api(`/api/audit/${encodeURIComponent(p.name)}/summary`);
      return { project: p.name, summary: data, incidents: p.evalAudit.openIncidents || 0 };
    })
  );
  for (const s of summaries) {
    state.auditSummaries[s.project] = s;
  }
  renderAuditPanel();
}

/**
 * Render the Eval Audit dashboard panel.
 */
function renderAuditPanel() {
  const panel = document.getElementById('auditPanel');
  const auditProjects = state.projects.filter(p => p.evalAudit && p.evalAudit.enabled);

  if (auditProjects.length === 0) {
    panel.innerHTML = '<div class="audit-empty">No projects have Eval Audit enabled.</div>';
    return;
  }

  let html = '<table class="audit-summary-table"><thead><tr><th>Project</th><th>Exchanges</th><th>Scored</th><th>Anomalies</th><th>Incidents</th></tr></thead><tbody>';
  for (const p of auditProjects) {
    const s = state.auditSummaries[p.name];
    const summary = s && s.summary ? s.summary : {};
    const incidents = p.evalAudit.openIncidents || 0;
    const incidentClass = incidents > 0 ? ' style="color:#d32f2f;font-weight:600"' : '';
    html += `<tr>
      <td>${esc(p.name)}</td>
      <td>${summary.totalExchanges || 0}</td>
      <td>${summary.scoredExchanges || 0}</td>
      <td>${summary.anomalyCount || 0}</td>
      <td${incidentClass}>${incidents}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  panel.innerHTML = html;
}

// ── Project Master (chunk G, #331) ──
// The global read-only assistant above all projects. The panel embeds the
// verified ttyd terminal stack as an iframe onto the reserved tmux session
// (lib/master.js) — the Claude Code TUI is the chat UI; there is no custom
// chat transport. Lifecycle is launch-on-first-open: opening the panel POSTs
// /api/master/ensure (idempotent — it also regenerates the master's CLAUDE.md
// identity so guide/token changes propagate) and only attaches the iframe
// once ensure succeeds, because ttyd attaches to EXISTING sessions only.

/**
 * Paint the master status dots (header button + panel row) and status text.
 * @param {string} status - 'live' | 'pending' | 'down' | '' (unknown/neutral)
 * @param {string} [text] - Status line shown in the panel row
 * @param {boolean} [showRetry] - Reveal the panel's Retry button
 */
function setMasterStatus(status, text, showRetry) {
  for (const id of ['masterDot', 'masterPanelDot']) {
    const dot = document.getElementById(id);
    dot.classList.remove('live', 'pending', 'down');
    if (status) dot.classList.add(status);
  }
  if (text !== undefined) document.getElementById('masterStatusText').textContent = text;
  document.getElementById('masterRetryBtn').classList.toggle('hidden', !showRetry);
}

/**
 * Toggle the Project Master panel open/closed. Opening triggers the
 * ensure-then-attach flow (launch on first open, then persist).
 */
function toggleMaster() {
  state.masterOpen = !state.masterOpen;
  const panel = document.getElementById('masterPanel');
  const toggle = document.getElementById('masterToggle');
  panel.classList.toggle('open', state.masterOpen);
  toggle.classList.toggle('active', state.masterOpen);
  toggle.setAttribute('aria-expanded', state.masterOpen);
  if (state.masterOpen) ensureMasterAttached();
}

/**
 * Ensure the master session exists, then attach the terminal iframe.
 * Re-entrant-guarded; safe to re-run on every panel open — ensure is an
 * idempotent server-side no-op when the session is already live (it still
 * refreshes the master's CLAUDE.md identity), and the iframe attaches once.
 */
async function ensureMasterAttached() {
  if (state.masterEnsuring) return;
  state.masterEnsuring = true;
  setMasterStatus('pending', 'Starting master session…');
  const result = await api('/api/master/ensure', { method: 'POST' });
  state.masterEnsuring = false;
  if (!result) {
    setMasterStatus('down', api.lastError || 'Failed to start the master session', true);
    return;
  }
  setMasterStatus('live', result.created ? 'Master session started' : 'Master session live');
  attachMasterFrame();
}

/**
 * Point the master iframe at the ttyd attach URL (once per page load). The
 * shared readiness-retry pipeline (api-helper.js tcWireTerminalFrame) pushes
 * the operator theme + the ⌥+drag local-selection override (#431) + the
 * mobile touch-scroll shim (#443) + plain-drag/long-press copy (#445) into
 * its xterm instance — the same enhancements every terminal surface gets.
 */
function attachMasterFrame() {
  const frame = document.getElementById('masterFrame');
  if (frame.dataset.attached === 'true') return;
  frame.dataset.attached = 'true';
  window.tcWireTerminalFrame(window, frame,
    () => (state.config && state.config.theme) || 'dark');
  frame.src = '/terminal/?arg=tangleclaw-master';
}

/**
 * One-shot status probe at page load so the header dot reflects whether the
 * master session is already live before the panel is ever opened. No polling
 * (no-UI-timers rule) — the dot refreshes again on open/ensure.
 */
async function refreshMasterDot() {
  const status = await api('/api/master/status');
  if (status && status.exists) setMasterStatus('live');
}

// ── Event Bindings ──

const $ = (id) => document.getElementById(id);
$('masterToggle').addEventListener('click', toggleMaster);
$('masterRetryBtn').addEventListener('click', ensureMasterAttached);
refreshMasterDot();
$('portsToggle').addEventListener('click', togglePorts);
$('openclawToggle').addEventListener('click', toggleOpenclaw);
$('auditToggle').addEventListener('click', toggleAudit);
$('ocCancelBtn').addEventListener('click', closeConnectionModal);
$('ocSaveBtn').addEventListener('click', saveConnection);
$('ocTestBtn').addEventListener('click', testConnection);
$('ocDetectBtn').addEventListener('click', detectOcInstanceDir);
$('ocBridgeAutoBtn').addEventListener('click', fillBridgePortAuto);
$('ocDeleteBtn').addEventListener('click', openConnectionDeleteConfirm);
$('openclawModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeConnectionModal(); });
$('ocSetupCloseBtn').addEventListener('click', closeOpenclawSetupModal);
$('ocSetupCopyBtn').addEventListener('click', copyOpenclawSetupPrompt);
$('openclawSetupModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeOpenclawSetupModal(); });
$('ocDeleteCancelBtn').addEventListener('click', closeConnectionDeleteConfirm);
$('ocDeleteConfirmBtn').addEventListener('click', confirmConnectionDelete);
$('openclawDeleteModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeConnectionDeleteConfirm(); });
$('groupsToggle').addEventListener('click', toggleGroups);
$('rulesToggle').addEventListener('click', toggleRules);
$('rulesSaveBtn').addEventListener('click', saveGlobalRules);
$('sessionRulesToggle').addEventListener('click', toggleSessionRules);
$('sessionRuleAddBtn').addEventListener('click', createSessionRule);
$('sessionRulesList').addEventListener('click', handleSessionRulesListEvent);
$('sessionRulesList').addEventListener('change', handleSessionRulesListEvent);
$('rulesResetBtn').addEventListener('click', openRulesResetModal);
$('rulesResetCancelBtn').addEventListener('click', closeRulesResetModal);
$('rulesResetConfirmBtn').addEventListener('click', confirmRulesReset);
$('rulesResetModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeRulesResetModal(); });
// filterBtn removed — filter input is always visible inline
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
// CC-6 (#381): delegated Project Rules add/toggle/delete. Attached once to the
// stable #settingsBody (its innerHTML is swapped per open, so child listeners
// would be lost; a parent delegate survives).
$('settingsBody').addEventListener('click', handleProjectRulesEvent);
$('settingsBody').addEventListener('change', handleProjectRulesEvent);
$('attachConfirmCancelBtn').addEventListener('click', closeAttachConfirm);
$('attachConfirmBtn').addEventListener('click', confirmAttach);
$('attachConfirmModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeAttachConfirm(); });
$('methSwitchCancelBtn').addEventListener('click', closeMethSwitchModal);
$('methSwitchConfirmBtn').addEventListener('click', confirmMethSwitch);
$('methSwitchModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeMethSwitchModal(); });
$('gearBtn').addEventListener('click', openGlobalSettings);
$('globalSettingsCancelBtn').addEventListener('click', closeGlobalSettings);
$('globalSettingsSaveBtn').addEventListener('click', saveGlobalSettings);
$('globalSettingsModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeGlobalSettings(); });
$('groupCancelBtn').addEventListener('click', closeGroupModal);
$('groupSaveBtn').addEventListener('click', saveGroup);
$('groupDeleteBtn').addEventListener('click', openGroupDeleteConfirm);
$('groupModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeGroupModal(); });
$('groupAddDocBtn').addEventListener('click', () => openDocModal());
$('groupDeleteCancelBtn').addEventListener('click', closeGroupDeleteConfirm);
$('groupDeleteConfirmBtn').addEventListener('click', confirmGroupDelete);
$('groupDeleteModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeGroupDeleteConfirm(); });
$('docCancelBtn').addEventListener('click', closeDocModal);
$('docSaveBtn').addEventListener('click', saveDoc);
$('docModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDocModal(); });

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
