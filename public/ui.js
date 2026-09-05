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
  return tcBuildEngineOptions(engineList, selectedId, esc);
}

/**
 * Pick the engine a picker should open on.
 *
 * Mirrors `engines.resolveDefaultEngine` (`lib/engines.js`) for the cases a
 * picker can encounter: the configured engine when it is installed, otherwise
 * the first installed one, otherwise `''`. It exists because seeding a picker
 * straight from `config.defaultEngine` and POSTing that value short-circuits the
 * server's resolver entirely — the client hands over an explicit engine, so
 * `data.engine || resolveDefaultEngine(config)` never reaches its fallback and
 * a machine without that engine gets a project bound to it anyway.
 *
 * The unknown-id passthrough is deliberately NOT mirrored: that branch exists so
 * a server-side caller can report a typo by name, and a picker has no way to
 * render an engine it knows nothing about.
 *
 * @param {object[]} engineList - Engines from state.engines (carry `available`)
 * @param {string} configured - `config.defaultEngine`
 * @returns {string} Engine id, or '' when nothing is installed
 */
function resolvePickerEngine(engineList, configured) {
  return tcResolvePickerEngine(engineList, configured);
}

// ── Project Card Rendering ──

/**
 * Name of the project whose detail panel is open, or `null` for none.
 *
 * This is the source of truth, deliberately NOT the DOM. `renderProjects`
 * assigns `grid.innerHTML`, and the dashboard re-renders on a 10s poll, so a
 * panel appended to a card was destroyed within ten seconds of being opened —
 * a timer-driven dismissal in a project whose own render code states it does
 * not use them. Keying on state instead makes re-rendering idempotent: the
 * poll redraws the open panel rather than closing it.
 *
 * One at a time, matching the previous behaviour.
 *
 * @type {string|null}
 */
let openCardDetail = null;

/**
 * Name of the project whose "Next action" is expanded inside its open panel,
 * or `null`. Same reasoning as `openCardDetail`; a separate value because the
 * two disclosures nest and the inner one must be able to close on its own.
 *
 * @type {string|null}
 */
let openNextAction = null;

function renderProjects() {
  const grid = document.getElementById('cardsGrid');
  const filtered = filterProjects();

  // The ROOT panel carries the "this list may be short" notice, so it is
  // rendered on EVERY path — including the empty ones. An empty list is the
  // worst case of #885, not an exemption from it: a projects directory that
  // could not be read, on a machine with nothing registered yet, produced
  // "No projects yet. Create your first project" — a definite and actionable
  // claim, and the wrong one.
  const rootHtml = renderRootPanel();

  if (state.projects.length === 0) {
    // Only the emptiness is in doubt, and only when the scan came up short.
    // With a complete scan this is still a genuinely empty machine and the
    // original invitation is exactly right.
    const listIsShort = tcScanNotice(state.projectsScan) !== null;
    grid.innerHTML = rootHtml + (listIsShort
      ? `<div class="empty-state">
      <h2>No projects could be listed</h2>
      <p>Nothing is registered yet, and the projects directory could not be read — so this
      may not be the whole picture. The reason is above.</p>
      <button class="btn btn-primary" onclick="openCreateModal()">+ Create Project</button>
    </div>`
      : `<div class="empty-state">
      <h2>No projects yet</h2>
      <p>Create your first project to get started with AI-assisted development.</p>
      <button class="btn btn-primary" onclick="openCreateModal()">+ Create Project</button>
    </div>`);
    return;
  }

  if (filtered.length === 0) {
    grid.innerHTML = rootHtml + `<div class="empty-state">
      <p>No projects match your filter.</p>
    </div>`;
    return;
  }

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

/**
 * Render the ROOT directory panel, including the notice row that appears when
 * the projects list is short.
 *
 * The count says "total" only when the scan actually completed. A directory
 * that could not be read produces a shorter list, and calling that shorter
 * number the total asserts a completeness the server explicitly did not claim —
 * the silent half of #885.
 *
 * The notice is always present while the condition holds and carries no
 * dismissal: it describes the CURRENT poll, so it must clear itself when the
 * read recovers rather than be dismissed into a lie. That also keeps it free of
 * any timer-driven lifecycle, which this project does not use.
 *
 * @returns {string} HTML for the panel, or '' when no projects directory is set.
 */
function renderRootPanel() {
  if (!state.config || !state.config.projectsDir) return '';
  const nonArchived = state.projects.filter(p => !p.archived);
  const totalCount = nonArchived.length;
  const registered = nonArchived.filter(p => p.registered !== false).length;

  const notice = tcScanNotice(state.projectsScan);
  const countLabel = notice
    ? `${registered} registered / ${totalCount} listed`
    : `${registered} registered / ${totalCount} total`;

  let noticeHtml = '';
  if (notice) {
    // The glyph is paired with text, never carrying the meaning alone — the
    // accessibility floor this project holds is that an error is never
    // communicated by colour (or by a coloured glyph) on its own.
    const glyph = notice.kind === 'info' ? '&#8505;' : '&#9888;';
    const remedyHtml = notice.remedy
      ? `<span class="root-notice-remedy">${esc(notice.remedy)}</span>`
      : '';
    // How far the walk got, when it reported that. Only a cut-off knows this,
    // and it turns "the list is short" into something the operator can size.
    const listedHtml = notice.listed !== null
      ? `<span class="root-notice-listed">${notice.listed} unregistered folder${notice.listed === 1 ? '' : 's'} were checked before the cut-off.</span>`
      : '';
    // Deliberately NOT an aria-live region. The dashboard rebuilds this whole
    // grid every ten seconds, so `role="status"` would re-announce the same
    // sentence to a screen reader on every poll for as long as the condition
    // lasts. It is persistent page content in document order, right under the
    // ROOT line it qualifies, and the glyph is decorative because the text
    // beside it carries the entire meaning.
    noticeHtml = `<div class="root-notice root-notice-${notice.kind}">
      <span class="root-notice-glyph" aria-hidden="true">${glyph}</span>
      <span class="root-notice-body">
        <span class="root-notice-text">${esc(notice.why)}</span>
        ${listedHtml}
        ${remedyHtml}
      </span>
    </div>`;
  }

  // The amber border means "something needs looking at". A truncated walk does
  // not, so it gets the notice row without recolouring the whole panel.
  const degradedClass = notice && notice.kind === 'warn' ? ' root-panel-degraded' : '';

  return `<div class="root-panel${degradedClass}">
    <div class="root-panel-line">
      <span class="root-label">ROOT</span>
      <span class="root-path">${esc(state.config.projectsDir)}</span>
      <span class="root-count">${countLabel}</span>
    </div>
    ${noticeHtml}
  </div>`;
}

/**
 * The tooltip text for a degraded-read record: the reason, then the remedy.
 *
 * One helper because every surface that can show one wants the same joined
 * sentence, and four hand-written copies of the same `filter(Boolean).join(' ')`
 * is how they drift.
 *
 * @param {{why: string|null, remedy: string|null}} record - A degraded-read record.
 * @returns {string} Escaped text for a `title` attribute.
 */
function degradedTooltip(record) {
  return esc([record.why, record.remedy].filter(Boolean).join(' '));
}

/**
 * Render the "this folder could not be read" badge, or '' when it was.
 *
 * Shared by the registered and unregistered cards for the same reason
 * `renderGitBadge` below is: a badge duplicated across both renderers is one a
 * later fix updates in only one place.
 *
 * @param {object} project - Project data carrying the `unreadable` trio.
 * @returns {string} HTML for the badge, or '' when the folder was readable.
 */
function renderUnreadableBadge(project) {
  const unreadable = tcUnreadableNotice(project);
  if (!unreadable) return '';
  return `<span class="badge badge-unreadable" title="${degradedTooltip(unreadable)}">&#9888; unreadable</span>`;
}

/**
 * Render the engine API error badge for a project card (#261).
 *
 * The engine's provider answered a 4xx/5xx and the engine printed it into its
 * pane and carried on; the card otherwise looks healthy. The server records
 * the error while a matching line is in the pane's captured tail, so this
 * renders only from a LIVE session's `lastEngineError` — a session the server
 * could not confirm has no reading to draw.
 *
 * @param {object} project - Project data carrying an optional `session`.
 * @returns {string} HTML for the badge, or '' when there is no recorded error.
 */
function renderEngineErrorBadge(project) {
  const session = project && project.session;
  const err = session && session.active === true ? session.lastEngineError : null;
  if (!err) return '';
  const status = Number.isFinite(Number(err.status)) ? `HTTP ${Number(err.status)}` : 'error';
  const detail = [err.type, err.message].filter(Boolean).join(': ');
  const tooltip = `Engine API error — ${status}${detail ? `. ${detail}` : ''}`;
  return `<span class="badge badge-engine-error" title="${esc(tooltip)}">&#9888; ${esc(status)}</span>`;
}

/**
 * Render the git branch badge for a project card.
 *
 * Shared by the registered and unregistered cards. They each had their own copy
 * of this markup, which is how a fix to one silently left the other reporting a
 * repository it could not read as clean.
 *
 * A working tree whose state could not be established renders `?` rather than
 * the dirty marker's absence. Absence of the marker means clean, and drawing an
 * unestablished read that way is the defect #891 removed from the payload.
 *
 * @param {object} project - Project data carrying an optional `git`.
 * @returns {string} HTML for the badge, or '' when not a repository.
 */
function renderGitBadge(project) {
  const dirtyState = tcGitDirtyState(project.git);
  if (dirtyState === null) return '';
  const read = tcGitRead(project.git);
  let marker = '';
  if (dirtyState === 'dirty') {
    marker = '<span class="git-dirty"></span>';
  } else if (dirtyState === 'unknown') {
    marker = '<span class="git-unknown" aria-hidden="true">?</span>';
  }
  // The tooltip is the only place the cause fits on a compact card; the `?`
  // glyph is what makes the state visible without it, so meaning never rests on
  // hover alone.
  const title = read.known ? '' : ` title="${degradedTooltip(read)}"`;
  const cls = dirtyState === 'unknown' ? 'badge badge-git badge-git-unknown' : 'badge badge-git';
  return `<span class="${cls}"${title}>${esc(project.git.branch)}${marker}</span>`;
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

  // `hasSession` still drives every ACTION on this card, and still treats an
  // unknown as not-live. That is deliberate: launching, peeking and killing all
  // need a tmux server that answers, and the one that did not answer is the
  // reason this state exists. Chunk 01 made `launchSession` refuse honestly in
  // that case, so the button leads somewhere truthful. Only the DISPLAY below
  // learns the third state.
  const hasSession = project.session && project.session.active;
  const liveness = tcSessionLiveness(project);
  const sessionClass = hasSession ? ' has-session' : '';
  const n = esc(project.name);

  const versionBadge = project.git && project.git.latestTag
    ? `<span class="badge badge-version">${esc(project.git.latestTag)}</span>`
    : '';

  const gitBadge = renderGitBadge(project);

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

  const engineErrorBadge = renderEngineErrorBadge(project);

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

  // Legacy-governance badge (#353) — only the one actionable state renders, to
  // avoid badge noise. A vendored hook still works but predates the V2 plugin,
  // so the project is a migration candidate. Self-clears once it migrates.
  // `ungoverned` is deliberately silent: a project with no Prawduct governance
  // is an ordinary project, not a fault.
  const driftBadge = project.governanceState === 'governed-vendored'
    ? `<span class="badge badge-drift" title="Legacy governance: this project runs a vendored Prawduct hook rather than the V2 plugin. Open Info to migrate it.">&#9888; legacy governance</span>`
    : '';

  const awarenessBadge = renderAwarenessBadge(project);

  // Three outcomes where there used to be two. The unknown carries a `?` glyph
  // rather than only a colour, because an operator who cannot distinguish the
  // dot's hue must still be able to tell a dead session from an unreadable one.
  const sessionRead = tcSessionRead(project);
  let statusDot;
  if (liveness === 'live') {
    statusDot = `<span class="status-dot active" title="Session active"></span>`;
  } else if (liveness === 'unknown') {
    statusDot = `<span class="status-dot unknown" title="${degradedTooltip(sessionRead)}">`
      + `<span class="status-dot-glyph" aria-hidden="true">?</span></span>`;
  } else {
    statusDot = `<span class="status-dot" title="No active session"></span>`;
  }

  // A project whose own folder did not answer is listed WITHOUT its git, engine
  // and version detail — so the card's other badges are absent for a reason the
  // card would otherwise not give. This is that reason.
  const unreadableBadge = renderUnreadableBadge(project);

  // The card is the control that opens the panel, but it never said so: there
  // is no hover rule on it, and the one visibly "info"-shaped button in the row
  // (`i`) opens the Settings MODAL instead. On a touch device, where there is
  // no hover to discover, that left no affordance at all. The chevron is the
  // marker, and it sits after the buttons so it is not read as another one.
  const isOpen = openCardDetail === project.name;
  const openClass = isOpen ? ' is-open' : '';

  return `<article class="project-card compact${sessionClass}${openClass}" tabindex="0"
    aria-expanded="${isOpen}"
    onclick="toggleCardDetail('${n}')" onkeydown="if(event.key==='Enter')toggleCardDetail('${n}')">
    <div class="card-row">
      ${statusDot}
      <span class="card-name" title="${n}">${n}</span>
      ${unreadableBadge}
      ${versionBadge}
      ${gitBadge}
      ${engineBadge}
      ${engineErrorBadge}
      ${groupBadges}
      ${auditBadge}
      ${driftBadge}
      ${awarenessBadge}
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
      <span class="card-chev" aria-hidden="true">&#9662;</span>
    </div>
    ${isOpen ? renderCardDetail(project) : ''}
  </article>`;
}

function renderUnregisteredCard(project) {
  const n = esc(project.name);
  const gitBadge = renderGitBadge(project);
  const unreadableBadge = renderUnreadableBadge(project);

  return `<article class="project-card compact unregistered" tabindex="0">
    <div class="card-row">
      <span class="status-dot unregistered"></span>
      <span class="card-name card-name-muted" title="${n}">${n}</span>
      ${unreadableBadge}
      ${gitBadge}
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

/**
 * The Session row's value in the card detail.
 *
 * Pure, and separate from `toggleCardDetail`, because that function reaches for
 * the DOM and this is the part with three outcomes worth testing directly.
 *
 * @param {object} project - Project data.
 * @returns {string} HTML for the detail value.
 */
function renderSessionDetail(project) {
  const liveness = tcSessionLiveness(project);
  if (liveness === 'live') {
    return `Active since ${esc(project.session.startedAt || '')}`;
  }
  if (liveness === 'none') return 'No active session';
  // The detail row is the one surface with room to say WHY, so it names the
  // cause rather than only marking it.
  const read = tcSessionRead(project);
  return `<span class="detail-unknown">Unknown</span> — ${esc(read.why)}`
    + (read.remedy ? ` <span class="detail-remedy">${esc(read.remedy)}</span>` : '');
}

/**
 * The Git row's value in the card detail.
 *
 * A working tree that could not be read is named as unknown rather than left to
 * the reader's assumption — the bare branch name with no "(dirty)" is how a
 * clean repository has always been drawn.
 *
 * @param {object} project - Project data.
 * @returns {string} HTML for the detail value.
 */
function renderGitDetail(project) {
  const dirtyState = tcGitDirtyState(project.git);
  if (dirtyState === null) return 'Not a git repo';
  const suffix = dirtyState === 'dirty'
    ? ' (dirty)'
    : (dirtyState === 'unknown' ? ' (working tree unknown)' : '');
  let info = `${esc(project.git.branch)}${suffix}`;
  const read = tcGitRead(project.git);
  if (!read.known) {
    info += ` — <span class="detail-unknown">${esc(read.why)}</span>`
      + (read.remedy ? ` <span class="detail-remedy">${esc(read.remedy)}</span>` : '');
  }
  return info;
}

/**
 * The card-row awareness badge (ambient-awareness Chunk 05). Only the red
 * state renders, matching the badge-noise rule the other badges follow: a
 * project whose LATEST session shows no evidence of awareness — no delivery
 * observed, no tc invocation — is the state that hid for 12 days in August
 * 2026, and it must be visible without opening anything. The glyph pairs with
 * text, never colour alone.
 * @param {object} project - Project data.
 * @returns {string} HTML for the badge, or ''.
 */
function renderAwarenessBadge(project) {
  const aw = state.awareness && state.awareness[project.id];
  const latest = aw && aw.sessions && aw.sessions[0];
  if (!latest || latest.state !== 'unaware') return '';
  return `<span class="badge badge-unaware" title="${esc(latest.basis)}">&#9888; unaware</span>`;
}

/**
 * The Awareness row of a card's detail panel: the latest session's composed
 * state (confirmed / sent / unverified / no-rules / unaware) with the basis said in
 * words. Empty when the project has never launched a session — nothing
 * launched means nothing to be aware.
 * @param {object} project - Project data.
 * @returns {string} HTML for the detail value, or ''.
 */
function renderAwarenessDetail(project) {
  const aw = state.awareness && state.awareness[project.id];
  const latest = aw && aw.sessions && aw.sessions[0];
  if (!latest) return '';
  const cls = latest.state === 'confirmed' ? 'rules-status-ok'
    : (latest.state === 'unaware' ? 'rules-status-err' : 'rules-status-warn');
  return `<span class="${cls}">${esc(latest.state)}</span> — ${esc(latest.basis)}`;
}

/**
 * Render a card's detail panel.
 *
 * Pure — builds a string and touches no DOM — so `renderCard` can emit it
 * inline on every render, and so it can be tested by running it rather than by
 * pinning its source (a source guard over markup passes happily against a dead
 * branch).
 *
 * @param {object} project - Project data.
 * @returns {string} HTML for the panel.
 */
function renderCardDetail(project) {
  const n = esc(project.name);
  const engineInfo = project.engine ? `${esc(project.engine.name)}` : 'No engine';
  const sessionInfo = renderSessionDetail(project);
  const awarenessInfo = renderAwarenessDetail(project);
  const tagsInfo = (project.tags || []).length > 0 ? project.tags.map(t => esc(t)).join(', ') : 'None';
  const gitInfo = renderGitDetail(project);

  const unreadable = tcUnreadableNotice(project);
  const unreadableRow = unreadable
    ? `<div class="detail-row detail-row-warn"><span class="detail-label">Folder</span>`
      + `<span class="detail-value"><span class="detail-unknown">${esc(unreadable.why)}</span>`
      + (unreadable.remedy ? ` <span class="detail-remedy">${esc(unreadable.remedy)}</span>` : '')
      + `</span></div>`
    : '';
  const groupsInfo = (project.groups || []).length > 0
    ? project.groups.map(g => `${esc(g.name)} (${g.docCount || 0} docs)`).join(', ')
    : 'None';

  return `<div class="card-detail">
      ${unreadableRow}
      <div class="detail-row"><span class="detail-label">Engine</span><span class="detail-value">${engineInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Session</span><span class="detail-value">${sessionInfo}</span></div>
      ${awarenessInfo ? `<div class="detail-row"><span class="detail-label">Awareness</span><span class="detail-value">${awarenessInfo}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Git</span><span class="detail-value">${gitInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Tags</span><span class="detail-value">${tagsInfo}</span></div>
      <div class="detail-row"><span class="detail-label">Groups</span><span class="detail-value">${groupsInfo}</span></div>
      ${renderNextActionRow(project)}
      <div class="detail-actions">
        <button class="btn btn-compact" onclick="event.stopPropagation(); openSettings('${n}')">Settings</button>
        ${project.session && project.session.active ? `<button class="btn btn-compact btn-kill-card" onclick="event.stopPropagation(); openKill('${n}')">Kill Session</button>` : ''}
        <button class="btn btn-compact btn-danger-subtle" onclick="event.stopPropagation(); openDelete('${n}')">Delete</button>
      </div>
    </div>`;
}

/**
 * Render the "Next action" disclosure inside a card's detail panel.
 *
 * The action is a session's own multi-line note about its unfinished work; it
 * is longer and less uniform than every other row in the panel, so it sits
 * behind its own toggle rather than inline — collapsed, the panel keeps the
 * even rhythm of its label/value rows.
 *
 * The row states that it opens. A chevron alone was not findable: at the size
 * and weight the other panel glyphs use it sits near 3:1 against the panel's
 * ground, and reads as absent rather than as subtle.
 *
 * @param {object} project - Project data.
 * @returns {string} HTML for the row, or `''` when there is no next action.
 */
function renderNextActionRow(project) {
  const next = project.continuityIndex && project.continuityIndex.nextAction;
  if (!next || !String(next).trim()) return '';

  const n = esc(project.name);
  const open = openNextAction === project.name;
  const bodyId = `next-${cssId(project.name)}`;

  return `<button class="next-toggle" type="button"
      aria-expanded="${open}" aria-controls="${bodyId}"
      onclick="event.stopPropagation(); toggleNextAction('${n}')">
      <span class="detail-label">Next</span>
      ${open ? '<span class="next-spacer"></span>' : '<span class="next-hint">(click to reveal)</span>'}
      <span class="next-chev" aria-hidden="true">&#9662;</span>
    </button>
    <div class="next-block" id="${bodyId}"${open ? '' : ' hidden'}>${renderNextMarkdown(next)}</div>`;
}

/**
 * Open or close a card's "Next action".
 *
 * @param {string} name - Project name.
 * @returns {void}
 */
function toggleNextAction(name) {
  openNextAction = openNextAction === name ? null : name;
  renderProjects();
  focusNextToggle(name);
}

/**
 * Move focus back to a card's Next toggle after a re-render replaced it.
 *
 * @param {string} name - Project name.
 * @returns {void}
 */
function focusNextToggle(name) {
  for (const card of document.querySelectorAll('.project-card')) {
    const nameEl = card.querySelector('.card-name');
    if (nameEl && nameEl.textContent === name) {
      const toggle = card.querySelector('.next-toggle');
      if (toggle) toggle.focus();
      return;
    }
  }
}

/**
 * Reduce a project name to characters safe in an `id` attribute.
 *
 * Project names are user-chosen and may contain spaces or punctuation, which
 * `aria-controls` cannot reference. Non-alphanumerics collapse to `-`; a
 * collision between two names is harmless here because only one panel is open
 * at a time, so only one such id is ever in the document.
 *
 * @param {string} name - Project name.
 * @returns {string} An id-safe token.
 */
function cssId(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Open or close a card's detail panel.
 *
 * Flips state and re-renders rather than appending to or removing from the
 * card, so the 10s project poll redraws the panel instead of destroying it.
 * Focus is restored afterwards because `renderProjects` replaces the whole
 * grid: without this a keyboard user who pressed Enter on a card would be
 * left with focus on `<body>`.
 *
 * @param {string} name - Project name.
 * @returns {void}
 */
function toggleCardDetail(name) {
  if (!state.projects.some(p => p.name === name)) return;

  openCardDetail = openCardDetail === name ? null : name;
  // The Next disclosure lives inside the panel, so it cannot outlive it.
  openNextAction = null;
  renderProjects();
  focusCard(name);
}

/**
 * Move focus back to a project card after a re-render replaced it.
 *
 * @param {string} name - Project name.
 * @returns {void}
 */
function focusCard(name) {
  for (const card of document.querySelectorAll('.project-card')) {
    const nameEl = card.querySelector('.card-name');
    if (nameEl && nameEl.textContent === name) {
      card.focus();
      return;
    }
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

/**
 * Render the header's session count.
 *
 * Counts the three liveness outcomes separately. Counting an unknown as
 * not-active makes the header state "0 active sessions" during exactly the tmux
 * wedge the cards below are drawing `?` for — a definite number the server does
 * not have, on the most prominent surface on the page, contradicting the cards
 * it summarises. Unlike the launch and kill buttons, this is pure display of
 * the fleet, so it takes the third state rather than the conservative answer.
 *
 * The unknowns clause appears only when there are any, so a healthy dashboard
 * reads exactly as it always did.
 *
 * @returns {void}
 */
function renderSessionCount() {
  let active = 0;
  let unknown = 0;
  for (const project of state.projects) {
    const liveness = tcSessionLiveness(project);
    if (liveness === 'live') active++;
    else if (liveness === 'unknown') unknown++;
  }
  const el = document.getElementById('sessionCount');
  const unknownPart = unknown > 0
    ? ` &middot; <span class="count-unknown" title="Whether these sessions are still running could not be established — the tmux server did not answer.">${unknown} unknown</span>`
    : '';
  el.innerHTML = `<span class="count-num">${active}</span> active session${active !== 1 ? 's' : ''}${unknownPart}`;
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
    document.getElementById('deleteError').textContent = api.lastError || `${action} failed.`;
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

  const hasSession = project.session && project.session.active;

  // Silent prime toggle (#103) — rendered into a stable container so we can
  // re-render its contents when the user changes the engine dropdown without
  // touching the rest of the modal. The container is always in the DOM; it just
  // becomes empty for engines that don't advertise supportsSilentPrime.
  const initialSilentChecked = !!project.silentPrime;
  // Feature Index toggle (#207, chunk 1) — always rendered; what varies by
  // engine is how much of it takes effect, which the disposition says.
  const initialFeatureIndexChecked = !!project.featureIndexEnabled;
  // `enrichProject` reports `evalAudit` for every project now, enabled or not —
  // a modal cannot render a toggle whose current value it cannot read.
  // `storedEnabled`, not `enabled`: the modal is the surface that repairs a
  // project stored on where the setting cannot apply, so it is the one place
  // that must see the raw value rather than the effective one.
  const initialEvalAuditChecked = !!(project.evalAudit && project.evalAudit.storedEnabled);
  // Project Map toggle (PIDX #360, #356) — always rendered, same as above.
  const initialProjectMapChecked = !!project.projectMapEnabled;
  // Auto version-bump opt-out (#318) — engine-agnostic; default on (only an
  // explicit false disables it).
  const initialVersionBumpChecked = project.versionBumpEnabled !== false;
  // Medusa session-comms auto-enable (MED-2K9P Chunk 02) — engine-agnostic;
  // default OFF (only an explicit true opts in).
  const initialMedusaChecked = !!project.medusaEnabled;
  // Medusa idle-gated wake nudge (MED-2K9P v2 T2) — engine-gated server-side
  // (Claude/tmux only in Slice 1); default OFF (a wake spends a real turn).
  const initialMedusaWakeChecked = !!project.medusaWake;
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
      <label class="form-label" for="settingsTags">Tags (comma-separated)</label>
      <input type="text" class="form-input" id="settingsTags" value="${esc((project.tags || []).join(', '))}"
             autocomplete="off" autocorrect="off" autocapitalize="off">
    </div>
    <div id="settingsLaunchModeContainer"></div>
    <div class="settings-toggles-grid">
      <div id="settingsSilentPrimeContainer"></div>
      <div id="settingsFeatureIndexContainer"></div>
      <div id="settingsProjectMapContainer"></div>
      <div id="settingsEvalAuditContainer"></div>
      <div class="form-group">
        <label class="gs-toggle-label">
          <span>Auto version bump</span>
          <input type="checkbox" id="settingsVersionBump" ${initialVersionBumpChecked ? 'checked' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <div class="form-hint">On wrap, promote CHANGELOG <code>[Unreleased]</code> and bump the project's semver — from the Version file path setting if set, otherwise <code>version.json</code> then <code>package.json</code>. Turn off for projects that manage their own versioning (e.g. a non-semver scheme via their own tooling).</div>
      </div>
      <div class="form-group">
        <label class="form-label" for="settingsVersionFilePath">Version file path</label>
        <input type="text" class="form-input" id="settingsVersionFilePath" placeholder="version.json" value="${esc(project.versionFilePath || '')}">
        <div class="form-hint">Leave blank to probe <code>version.json</code>, then <code>package.json</code>. Set this when the file has a different name or case (e.g. <code>VERSION.json</code>) — the probe only tests the lowercase name, so on a case-sensitive filesystem it would otherwise miss and bump <code>package.json</code> instead. Must be a relative path inside the project.</div>
      </div>
      <div class="form-group">
        <label class="gs-toggle-label">
          <span>Enable Medusa session comms</span>
          <input type="checkbox" id="settingsMedusa" ${initialMedusaChecked ? 'checked' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <div class="form-hint">Auto-start this project's sessions on the Medusa switchboard so inbound messages badge in the banner without a manual toggle. Off by default; the banner control is always available as a per-session override.</div>
      </div>
      <div class="form-group">
        <label class="gs-toggle-label">
          <span>Auto-wake on inbound messages</span>
          <input type="checkbox" id="settingsMedusaWake" ${initialMedusaWakeChecked ? 'checked' : ''}>
          <span class="toggle-switch"></span>
        </label>
        <div class="form-hint">When a Medusa message arrives and this project's session is idle, nudge the session to read its inbox — spending a turn. Never interrupts a busy turn; waits for the next idle moment. Claude sessions only for now. Off by default.</div>
      </div>
    </div>
    ${renderProjectRulesSection(project)}`;

  /**
   * Re-render both index toggles for an engine and a silent-prime state,
   * carrying over whatever each checkbox currently shows.
   *
   * Both, always: their caveat comes from the same two inputs, so re-rendering
   * one without the other leaves the modal telling the operator that half of
   * one setting is dead while the identical loss on its neighbour goes unsaid.
   *
   * @param {string} engineId - The engine dropdown's current value.
   * @param {boolean} silentChecked - The silent-prime state now on screen.
   * @returns {void}
   */
  const renderIndexToggles = (engineId, silentChecked) => {
    const featureEl = document.getElementById('settingsFeatureIndex');
    const mapEl = document.getElementById('settingsProjectMap');
    renderFeatureIndexToggle(engineId,
      featureEl ? featureEl.checked : initialFeatureIndexChecked,
      project.engine || null, silentChecked);
    renderProjectMapToggle(engineId,
      mapEl ? mapEl.checked : initialProjectMapChecked,
      project.engine || null, silentChecked);
  };

  // Initial render — based on the project's current engine
  renderSilentPrimeToggle(project.engine ? project.engine.id : '', initialSilentChecked,
    project.engine || null);
  renderEvalAuditToggle(project.engine ? project.engine.id : '', initialEvalAuditChecked,
    project.engine || null, project.evalAudit || null);
  renderIndexToggles(project.engine ? project.engine.id : '', initialSilentChecked);
  renderLaunchModeSettings(
    project.engine ? project.engine.id : '',
    project.defaultLaunchMode || 'default',
    project.showLaunchModePicker !== false
  );
  // CC-6 (#381): populate the per-project rule lists (async) once the
  // modal markup is in the DOM. project.id is the DB id the API scopes on.
  loadProjectRules(project.id);

  // Re-render on engine dropdown change (chunk 3 polish — Critic Mn5). Without
  // this, switching the dropdown to an engine that lacks supportsSilentPrime
  // leaves a stale checkbox visible; the backend rejects gracefully but the user
  // shouldn't be able to send a doomed request in the first place. Launch-mode
  // settings re-render for the same reason: mode keys are engine-specific, so a
  // stale selection would be rejected by the PATCH validation.
  document.getElementById('settingsEngine').addEventListener('change', (e) => {
    const checkbox = document.getElementById('settingsSilentPrime');
    const checkedNow = checkbox ? checkbox.checked : initialSilentChecked;
    renderSilentPrimeToggle(e.target.value, checkedNow, project.engine || null);
    // The index toggles stay live on every engine, but what they say does not:
    // an engine that delivers no hidden prime maintains the file and tells no
    // session it is there. Re-rendered here so the operator reads that before
    // saving, not after a launch that quietly does half the job.
    renderIndexToggles(e.target.value, checkedNow);
    const auditEl = document.getElementById('settingsEvalAudit');
    renderEvalAuditToggle(e.target.value,
      auditEl ? auditEl.checked : initialEvalAuditChecked,
      project.engine || null, project.evalAudit || null);
    const modeEl = document.getElementById('settingsDefaultLaunchMode');
    const showEl = document.getElementById('settingsShowLaunchPicker');
    renderLaunchModeSettings(
      e.target.value,
      modeEl ? modeEl.value : (project.defaultLaunchMode || 'default'),
      showEl ? showEl.checked : (project.showLaunchModePicker !== false)
    );
  });

  // Turning silent prime off costs the operator the index pointers too — the
  // gate is a triple, and this is the one leg they control. Delegated to the
  // container, which survives every re-render, rather than bound to the
  // checkbox, which `renderSilentPrimeToggle` replaces on each engine change.
  const silentPrimeHost = document.getElementById('settingsSilentPrimeContainer');
  if (silentPrimeHost) {
    silentPrimeHost.addEventListener('change', (e) => {
      if (!e.target || e.target.id !== 'settingsSilentPrime') return;
      renderIndexToggles(document.getElementById('settingsEngine').value, e.target.checked);
    });
  }

  modal.classList.add('open');
}

/**
 * Render the silent-prime toggle inside #settingsSilentPrimeContainer for the
 * engine selected in the dropdown — live where the engine honors the setting,
 * inert with the reason where it does not. The engine comes from
 * `state.engines`, the same source the dropdown is built from; whether the
 * setting applies, and what the operator reads when it does not, come from
 * `tcSettingDisposition`.
 *
 * Preserves the checkbox's `checked` value across engine switches: if the user
 * toggles silent prime on, then clicks a different engine and back, their
 * intent is remembered. The inert branch carries no `#settingsSilentPrime`
 * element, so `doSaveSettings` attaches no value and cannot pick up a stale
 * checkbox.
 *
 * @param {string} engineId - Engine id from the dropdown's current value
 * @param {boolean} preserveChecked - The checkbox state to carry over (or initial)
 * @param {object|null} [projectEngine] - The project's own enriched engine, used
 *   only while the dropdown still names it — `state.engines` omits
 *   connection-backed ids, and this is where their capabilities come from.
 */
function renderSilentPrimeToggle(engineId, preserveChecked, projectEngine) {
  const container = document.getElementById('settingsSilentPrimeContainer');
  if (!container) return;
  // One owner for "which profile is this dropdown value" — the input that
  // decides whether the row prints "no profile for this engine".
  const profile = tcResolveEngineProfile(state.engines, engineId, projectEngine);
  // One owner for "does this setting apply here, and what do we say when it
  // does not" (ADR 0013) — `tcSettingDisposition`, the browser half of the
  // server's `engines.settingDisposition`. The reason is rendered rather than
  // written here, so the modal cannot tell the operator something the launch
  // path does not believe. A profile that genuinely cannot be found stays
  // missing: synthesising `{ id }` made the hint state a capability fact about
  // an engine nothing was read for.
  const disposition = tcSettingDisposition('silentPrime', { silentPrime: preserveChecked },
    profile);
  if (!disposition.applies) {
    // Said in words rather than hidden (#741): a toggle that vanishes reads
    // as "this engine has no such setting", and the operator who set it on
    // another engine is never told it means nothing here. No
    // `#settingsSilentPrime` element, so the save path attaches no value —
    // the stored key stays whatever it was and is not applicable.
    container.innerHTML = `
    <div class="form-group">
      <label class="gs-toggle-label gs-toggle-label--disabled">
        <span>Silent prime (hidden context)</span>
        <input type="checkbox" id="settingsSilentPrimeNotApplicable" disabled>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">${esc(disposition.reason)}</div>
    </div>`;
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
 * Render the Eval Audit toggle (#1236) — live where scored exchanges can
 * actually reach this project, inert with the reason where they cannot.
 *
 * Eval Audit had no write path at all before this: the only way to switch it on
 * was hand-editing `project.json`, so the dashboard panel was empty on every
 * install and the feature read as dead — #1227 was filed to delete it.
 *
 * The hint names the cost before the switch, not after. Enabling starts
 * LLM-judge passes that spend real money, and #1236 asks for that to be visible
 * rather than a free-looking checkbox; the numbers come from the project's own
 * stored config, so an operator who has edited them reads their values and not
 * a hardcoded pair.
 *
 * @param {string} engineId - Engine id from the dropdown's current value
 * @param {boolean} preserveChecked - The checkbox state to carry over (or initial)
 * @param {object|null} [projectEngine] - The project's own enriched engine —
 *   `state.engines` omits connection-backed ids, which are the only ids this
 *   setting applies to, so without it the control is inert on every project
 *   that can use it.
 * @param {object|null} [audit] - The project's enriched `evalAudit`, whose
 *   `judgeModel` and `costCapPerSession` carry this project's real numbers.
 */
function renderEvalAuditToggle(engineId, preserveChecked, projectEngine, audit) {
  const container = document.getElementById('settingsEvalAuditContainer');
  if (!container) return;
  const profile = tcResolveEngineProfile(state.engines, engineId, projectEngine);
  const disposition = tcSettingDisposition('evalAuditMode', { evalAuditMode: { enabled: preserveChecked } }, profile);
  if (!disposition.applies) {
    // Inert, but repairable. A project can hold a stored `true` from a
    // hand-edit made before this gate existed; rendering a permanently disabled
    // checkbox would leave the only surface that can clear it unable to. So a
    // STRANDED project gets a live control that can only go one way — the
    // server refuses enabling here and allows disabling, and this matches it.
    const stranded = !!(audit && audit.storedEnabled);
    container.innerHTML = stranded
      ? `
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Eval Audit</span>
        <input type="checkbox" id="settingsEvalAudit" ${preserveChecked ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint"><strong>Stored on, doing nothing.</strong> ${esc(disposition.reason)} Switch it off to clear it.</div>
    </div>`
      : `
    <div class="form-group">
      <label class="gs-toggle-label gs-toggle-label--disabled">
        <span>Eval Audit</span>
        <input type="checkbox" id="settingsEvalAuditNotApplicable" disabled>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">${esc(disposition.reason)}</div>
    </div>`;
    return;
  }
  const cfg = audit || {};
  const judge = cfg.judgeModel || 'the configured judge model';
  const cap = typeof cfg.costCapPerSession === 'number' ? `$${cfg.costCapPerSession.toFixed(2)}` : 'the configured cap';
  container.innerHTML = `
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Eval Audit</span>
        <input type="checkbox" id="settingsEvalAudit" ${preserveChecked ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint"><strong>Costs money while on.</strong> Scores this project's session exchanges for quality and raises an incident when it drops. The structural pass is free; the deeper passes send exchanges to an LLM judge (${esc(judge)}), capped at ${esc(cap)} per session. Scoring tunables are edited in <code>project.json</code>.</div>
    </div>`;
}

/**
 * Render the Feature Index toggle (#207, chunk 1). Always a live control: the
 * wrap half — seeding and maintaining FEATURES.md — runs on every engine.
 *
 * What does NOT run everywhere is the other half. The SessionStart pointer that
 * tells the agent the file exists rides the hidden prime, so on an engine that
 * delivers none, this toggle maintains a file no session is told to read. That
 * is the caveat the disposition returns, and it is rendered here rather than
 * composed here — the same rule the inert controls follow (#1252, ADR 0013).
 *
 * @param {string} engineId - Engine id from the dropdown's current value
 * @param {boolean} preserveChecked - The checkbox state to carry over (or initial)
 * @param {object|null} [projectEngine] - The project's own enriched engine, for
 *   the connection-backed ids `state.engines` omits.
 * @param {boolean} [silentPrimeChecked] - The silent-prime state the modal
 *   currently shows; the pointer's gate is a triple, and the operator who turns
 *   silent prime off loses the pointer on an engine that could deliver it.
 */
function renderFeatureIndexToggle(engineId, preserveChecked, projectEngine, silentPrimeChecked) {
  renderIndexToggle({
    containerId: 'settingsFeatureIndexContainer',
    setting: 'featureIndexEnabled',
    inputId: 'settingsFeatureIndex',
    label: 'Feature Index',
    hint: 'Maintain a FEATURES.md at the project root mapping feature names to file paths. Enabling creates a template stub at &lt;project-root&gt;/FEATURES.md (existing files are preserved). Edit the file directly to add entries.',
    engineId, preserveChecked, projectEngine, silentPrimeChecked
  });
}

/**
 * The shared body of the two index toggles — one live checkbox plus whatever
 * the disposition says about the half of it that may not run here.
 *
 * One function because the two toggles differ only in their labels: written
 * twice, the caveat would be rendered in one and forgotten in the other, which
 * is the shape of the defect that made them both audit findings.
 *
 * @param {object} opts - `containerId`, `setting`, `inputId`, `label`, `hint`,
 *   `engineId`, `preserveChecked`, `projectEngine`, `silentPrimeChecked`.
 */
function renderIndexToggle(opts) {
  const container = document.getElementById(opts.containerId);
  if (!container) return;
  const profile = tcResolveEngineProfile(state.engines, opts.engineId, opts.projectEngine);
  const disposition = tcSettingDisposition(opts.setting,
    { [opts.setting]: opts.preserveChecked, silentPrime: opts.silentPrimeChecked === true },
    profile);
  const caveat = disposition.caveat
    ? `<div class="form-hint form-hint--caveat">${esc(disposition.caveat)}</div>`
    : '';
  container.innerHTML = `
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>${esc(opts.label)}</span>
        <input type="checkbox" id="${opts.inputId}" ${opts.preserveChecked ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">${opts.hint /* a literal from this file, already carrying its own entities */}</div>
      ${caveat}
    </div>`;
}

/**
 * Render the Project Map toggle (PIDX #360, #356) into its stable container.
 * Always a live control — the wrap maintains PROJECT-MAP.md on every engine —
 * and it carries the same caveat as the Feature Index when the pointer that
 * names the file to a session cannot be delivered here (#1252).
 *
 * @param {string} engineId - Engine id from the dropdown's current value
 * @param {boolean} preserveChecked - The checkbox state to carry over (or initial)
 * @param {object|null} [projectEngine] - The project's own enriched engine, for
 *   the connection-backed ids `state.engines` omits.
 * @param {boolean} [silentPrimeChecked] - The silent-prime state the modal shows.
 */
function renderProjectMapToggle(engineId, preserveChecked, projectEngine, silentPrimeChecked) {
  renderIndexToggle({
    containerId: 'settingsProjectMapContainer',
    setting: 'projectMapEnabled',
    inputId: 'settingsProjectMap',
    label: 'Project Map',
    hint: 'Maintain a PROJECT-MAP.md at the project root — a "where things live" structural map the agent consults first. Enabling creates it with an auto-generated top-level-directory skeleton (existing files are preserved); fill in the descriptions. Distinct from the Feature Index (which maps features to paths).',
    engineId, preserveChecked, projectEngine, silentPrimeChecked
  });
}

/**
 * Render the per-project launch-mode settings (default mode + picker
 * visibility) into their stable container. Mode keys are engine-specific, so
 * this re-renders on engine change like the silent-prime toggle; engines with
 * no launch modes (or absent from state.engines) render nothing, and the save
 * path then skips both fields.
 *
 * @param {string} engineId - Engine id from the dropdown's current value
 * @param {string} preserveMode - The mode selection to carry over (or initial)
 * @param {boolean} preserveShow - The picker-visibility state to carry over
 */
function renderLaunchModeSettings(engineId, preserveMode, preserveShow) {
  const container = document.getElementById('settingsLaunchModeContainer');
  if (!container) return;
  const profile = (state.engines || []).find(e => e.id === engineId);
  const enabledEntries = tcHonoredLaunchModes(profile);
  if (enabledEntries.length === 0) {
    container.innerHTML = '';
    return;
  }
  // A carried-over key that the new engine doesn't define falls back to
  // 'default' (every bundled engine defines it) so no invalid value is sent.
  // Membership is tested against the rendered options, not the profile's whole
  // `launchModes`: selecting a key the engine declares but has DISABLED would
  // name an <option> that is not in the list, and the browser would silently
  // show the first one instead — reporting a stored mode the operator never set.
  const selected = enabledEntries.some(([key]) => key === preserveMode) ? preserveMode : 'default';
  const opts = enabledEntries.map(([key, m]) =>
    `<option value="${esc(key)}" ${key === selected ? 'selected' : ''}>${esc(m.label || key)}${m.warning ? ' ⚠' : ''}</option>`
  ).join('');
  container.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="settingsDefaultLaunchMode">Default launch mode</label>
      <select class="form-select" id="settingsDefaultLaunchMode">${opts}</select>
      <div class="form-hint">The mode this project launches in when no mode is chosen at launch — API launches, and direct launches with the picker hidden.</div>
    </div>
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Show launch mode picker</span>
        <input type="checkbox" id="settingsShowLaunchPicker" ${preserveShow ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">When off, Launch skips the mode picker and starts the session directly in the default mode.</div>
    </div>`;
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
  settingsTarget = null;
  projectRulesTargetId = null;
}

// ── Project Rules (CC-6, #381) ──
// A per-project extension of the Settings modal: two rule-kind boxes
// (startup/wrap) backed by the session_rules store + the 8 wrap-summary
// section checkboxes. (The former mode-rules box was retired — harness
// posture is now the structured Launch settings above the rules grid.)
// Scoped to this project's id + a kind. The DB project id of the open modal.
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
  { kind: 'wrap', label: 'Wrap rules', hint: 'Injected into the wrap prompt at session wrap — also the sink where approved self-improvement suggestions land.' }
];

/**
 * Build the Project Rules section markup for the Settings modal. The per-kind rule
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
      <div class="form-group">
        <div class="form-label">Rule deliveries</div>
        <div class="form-hint">The last five launches: whether the startup-rule block reached the engine, on which channel, and why not when it did not.</div>
        <div class="session-rules-list" id="projRuleDeliveriesList" aria-live="polite"></div>
      </div>
      <div id="projRulesPwGroup" class="form-group hidden">
        <label class="form-label" for="projRulesPw">Delete password (required to approve a proposed rule)</label>
        <input type="password" class="form-input" id="projRulesPw" autocomplete="current-password">
      </div>
      <div id="projectRulesStatus" class="rules-status hidden" role="status"></div>
    </div>`;
}

/**
 * Fetch one kind's rules for a project, ready to render: active rules plus
 * pending proposals (#569 — a proposed rule is visible with a "Proposed"
 * badge so the queue isn't silent), minus rejections (a rejected row is the
 * record of a decision, not a rule — rendering it forever would read as
 * clutter, and its whole point is that the wrap won't re-raise it).
 *
 * `null` when the read did not happen (#1054): a failed read is not an empty
 * ruleset, and flattening it to `[]` renders an API outage as a project with
 * no rules — a fact stated about rules nobody fetched.
 * @param {number} projectId - DB project id
 * @param {string} kind - Rule kind
 * @returns {Promise<object[]|null>} The rules, or null when the read failed.
 */
async function fetchProjectRules(projectId, kind) {
  const data = await api(`/api/session-rules?projectId=${encodeURIComponent(projectId)}&kind=${kind}`);
  if (!data) return null;
  return (data.rules || []).filter((r) => r.status !== 'rejected');
}

/**
 * Fetch one kind's rules and render the answer — the list, the true empty
 * state, or the unknown. Every caller that re-reads after a mutation goes
 * through here, so the three-state rendering cannot be bypassed by one of
 * them re-flattening a failed read (#1054).
 * @param {number} projectId - DB project id
 * @param {string} kind - Rule kind
 * @returns {Promise<boolean|null>} `true` when the list rendered from a real
 *   read, `false` when the read failed and the unknown state rendered, `null`
 *   when the modal moved to another project meanwhile and nothing rendered —
 *   three answers, because a retargeted modal is not an outage.
 */
async function refreshProjectRulesList(projectId, kind) {
  const rules = await fetchProjectRules(projectId, kind);
  // The modal may have been closed/reopened on another project while awaiting.
  if (projectRulesTargetId !== projectId) return null;
  if (rules === null) {
    renderProjectRulesUnknown(kind, api.lastError);
    return false;
  }
  renderProjectRulesList(kind, rules);
  return true;
}

/**
 * After a mutation succeeded, re-read its kind's list and, when THAT read
 * fails, say so on the status line — the handler's own "Added"/"Deleted"
 * confirmation is true, but the list under it is now an unknown, and a green
 * status over a list saying "Rules unknown" would read as a contradiction.
 * @param {string} verb - What succeeded, e.g. 'Added'.
 * @param {string} kind - Rule kind
 */
async function refreshAfterProjectRuleMutation(verb, kind) {
  if ((await refreshProjectRulesList(projectRulesTargetId, kind)) === false) {
    _setProjectRulesStatus(`${verb}, but the rules list could not be re-read — close and reopen Settings`, false);
  }
}

/**
 * Render one kind's list as UNKNOWN through the shared helper the Master
 * settings component uses (#948) — one authoring site for the sentence, the
 * alert role and the class pair, so the two copies of this widget cannot drift.
 * @param {string} kind - 'startup' | 'wrap'
 * @param {string|null} why - `api.lastError`, when the transport left one
 */
function renderProjectRulesUnknown(kind, why) {
  const list = document.getElementById(`projRulesList-${kind}`);
  if (!list) return;
  list.innerHTML = window.tcRulesUnknownHtml('Rules',
    window.tcDegradedRead(false, why, 'Close and reopen Settings to retry.'));
}

/**
 * Fetch this project's rules for each kind and render its list, then the
 * rule-delivery ledger (#1164).
 * @param {number} projectId - DB project id
 */
async function loadProjectRules(projectId) {
  projectRulesTargetId = projectId;
  for (const { kind } of PROJECT_RULE_KINDS) {
    if ((await refreshProjectRulesList(projectId, kind)) === null) return;
  }

  await refreshProjectRuleDeliveries(projectId);
}

/**
 * Fetch this project's rule-delivery ledger and render the answer — the rows,
 * the true empty state, or the unknown (#1164). The same three-state shape as
 * `refreshProjectRulesList` (#1054): a `null` from `api()` is a read that did
 * not happen, and a payload without a `deliveries` array is not a ledger —
 * neither is a project that has never launched, so neither renders as one.
 * @param {number} projectId - DB project id
 * @returns {Promise<boolean|null>} `true` when the ledger rendered from a real
 *   read, `false` when the read failed and the unknown state rendered, `null`
 *   when the modal moved to another project meanwhile and nothing rendered.
 */
async function refreshProjectRuleDeliveries(projectId) {
  const data = await api(`/api/session-rules/deliveries?projectId=${encodeURIComponent(projectId)}`);
  // The modal may have been closed/reopened on another project while awaiting.
  if (projectRulesTargetId !== projectId) return null;
  if (!data || !Array.isArray(data.deliveries)) {
    renderProjectRuleDeliveriesUnknown(data ? 'the server answered without a ledger' : api.lastError);
    return false;
  }
  renderProjectRuleDeliveries(data.deliveries);
  return true;
}

/**
 * Render the ledger as UNKNOWN through the same helper the rules lists use
 * (#948), so the alert role, the class pair and the sentence shape match the
 * lists above it.
 * @param {string|null} why - `api.lastError`, or the shape defect, when there is one
 */
function renderProjectRuleDeliveriesUnknown(why) {
  const list = document.getElementById('projRuleDeliveriesList');
  if (!list) return;
  list.innerHTML = window.tcRulesUnknownHtml('Deliveries',
    window.tcDegradedRead(false, why, 'Close and reopen Settings to retry.'));
}

/**
 * Render the ledger's most recent rows, or the empty state when the read
 * succeeded and found nothing — stated as a fact about the ledger, not a
 * claim about the project's launch history, which zero rows cannot prove.
 * @param {object[]} deliveries - Ledger rows, newest first, as the API returns them
 */
function renderProjectRuleDeliveries(deliveries) {
  const list = document.getElementById('projRuleDeliveriesList');
  if (!list) return;
  if (deliveries.length === 0) {
    // Neutral on purpose: zero rows is not proof the project never launched —
    // `_recordRuleDelivery` swallows write failures and non-real launches pass
    // `deliveryBase=null` — so the sentence states what was found, not why.
    list.innerHTML = '<p class="session-rules-empty">No delivery records — no delivery attempt has been recorded for this project.</p>';
    return;
  }
  list.innerHTML = deliveries.slice(0, 5).map((d) => {
    // One owner for the outcome→class map (`tcDeliveryOutcomeClass` in
    // api-helper.js), so a test can drive it over the ledger's whole
    // vocabulary. 'unverified' and 'written' (#1063) are deliberately
    // neither ok nor err: something was put on the channel and nothing
    // confirmed the far side.
    const outcomeClass = tcDeliveryOutcomeClass(d.outcome);
    return `<div class="session-rule-item">
      <div class="session-rule-content">
        <strong>${esc(d.sessionId)}</strong>: <span class="${outcomeClass}">${esc(d.outcome)}</span>
        ${d.skipReason ? `<br><small class="session-rule-meta">Reason: ${esc(d.skipReason)}</small>` : ''}
        <br><small class="session-rule-meta">Channel: ${esc(d.channel)} | Digest: <code>${esc(d.digest ? d.digest.slice(0, 8) : 'none')}</code> | Rules: ${d.ruleIds ? d.ruleIds.length : 0}</small>
      </div>
    </div>`;
  }).join('');
}

/**
 * Render one kind's rule list into its container.
 * @param {string} kind - 'startup' | 'wrap'
 * @param {object[]} rules - Rules of this kind for the project
 */
function renderProjectRulesList(kind, rules) {
  const list = document.getElementById(`projRulesList-${kind}`);
  if (!list) return;
  if (rules.length === 0) {
    list.innerHTML = '<p class="session-rules-empty">No rules yet.</p>';
    return;
  }
  list.innerHTML = rules.map((rule) => {
    // #569: a proposed rule is in the review queue — it governs nothing yet,
    // so its enabled-toggle is inert and disabled (checking it would read as
    // "this is live"). The decision affordances here are Approve/Reject, NOT
    // Delete: the drawer widget only renders the wrap that just ran, so this
    // list is the durable decision surface — and deleting a proposed row
    // would erase the recorded decision and re-arm re-proposal at the next
    // wrap (the exact zombie the recorded `rejected` state exists to prevent).
    const isProposed = rule.status === 'proposed';
    const badges = [
      rule.createdBy === 'ai' ? '<span class="session-rule-badge" title="AI-authored">AI</span> ' : '',
      isProposed ? '<span class="session-rule-badge session-rule-badge--proposed" title="Proposed by the wrap from a recurring learning — not governing sessions yet. Approve or reject it here, or in the wrap drawer right after the wrap that proposed it.">Proposed</span> ' : ''
    ].join('');
    const actions = isProposed
      ? `<span class="session-rule-decide">
           <button class="btn btn-small btn-primary" data-action="approve-rule" data-rule-id="${rule.id}">Approve</button>
           <button class="btn btn-small" data-action="reject-rule" data-rule-id="${rule.id}">Reject</button>
         </span>`
      : `<button class="btn btn-small btn-danger session-rule-delete" data-action="delete-rule" data-rule-id="${rule.id}" aria-label="Delete rule">&times;</button>`;
    return `
    <div class="session-rule-item${rule.enabled ? '' : ' session-rule-disabled'}${isProposed ? ' session-rule-item--proposed' : ''}" data-rule-id="${rule.id}">
      <label class="session-rule-toggle">
        <input type="checkbox" data-action="toggle-rule" data-rule-id="${rule.id}" ${rule.enabled && !isProposed ? 'checked' : ''} ${isProposed ? 'disabled' : ''}>
      </label>
      <span class="session-rule-content">${badges}${esc(rule.content)}</span>
      ${actions}
    </div>`;
  }).join('');
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
    await refreshAfterProjectRuleMutation('Added', kind);
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
  await refreshAfterProjectRuleMutation('Updated', kind);
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
  await refreshAfterProjectRuleMutation('Deleted', kind);
}

/**
 * Resolve a proposed rule from the Project Rules list (#569): approve it into
 * a governing rule or reject it. This is the durable decision surface — the
 * wrap drawer's widget only renders the wrap that just ran, so a proposal
 * whose drawer was dismissed is decided here. Approve is password-gated
 * server-side; the hidden password field is revealed on a 403 rather than
 * asked for up-front (with no delete password configured it never appears).
 * A rejected rule leaves the list on re-render — the record lives on in the
 * DB, which is what stops the wrap re-proposing the same learning.
 * @param {number} id - Rule id
 * @param {'active'|'rejected'} status - The operator's decision
 * @param {string} kind - Rule kind (for the targeted re-render)
 */
async function resolveProjectRuleProposal(id, status, kind) {
  const body = { status };
  const pwInput = document.getElementById('projRulesPw');
  if (status === 'active' && pwInput && pwInput.value) body.password = pwInput.value;
  const data = await apiMutate(`/api/session-rules/${id}/status`, 'PUT', body);
  if (!data) {
    const pwGroup = document.getElementById('projRulesPwGroup');
    if (api.lastErrorCode === 'FORBIDDEN' && pwGroup) {
      pwGroup.classList.remove('hidden');
      _setProjectRulesStatus('Approving needs the delete password — enter it above and tap Approve again', false);
      if (pwInput) pwInput.focus();
    } else {
      _setProjectRulesStatus(`${status === 'active' ? 'Approve' : 'Reject'} failed`, false);
    }
    return;
  }
  _setProjectRulesStatus(status === 'active'
    ? 'Approved — this rule now governs future sessions'
    : 'Rejected — recorded, so it won’t be proposed again', true);
  await refreshAfterProjectRuleMutation(status === 'active' ? 'Approved' : 'Rejected', kind);
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
  } else if (action === 'approve-rule' && e.type === 'click') {
    resolveProjectRuleProposal(Number(target.getAttribute('data-rule-id')), 'active', kind);
  } else if (action === 'reject-rule' && e.type === 'click') {
    resolveProjectRuleProposal(Number(target.getAttribute('data-rule-id')), 'rejected', kind);
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
 * Transient status message in a rules section (shared by the Project Rules
 * and Master settings surfaces).
 * @param {string} elementId - The status element's id
 * @param {string} text
 * @param {boolean} ok
 */
function _setRulesStatus(elementId, text, ok) {
  // One implementation, in api-helper.js: the Master settings modal moved into
  // a component both pages mount, and it needs this same transient line. A
  // second copy here would be two behaviours for one visual affordance.
  window.tcSetRulesStatus(document, elementId, text, ok);
}

/**
 * Transient status message in the Project Rules section.
 * @param {string} text
 * @param {boolean} ok
 */
function _setProjectRulesStatus(text, ok) {
  _setRulesStatus('projectRulesStatus', text, ok);
}

async function saveSettings() {
  if (!settingsTarget) return;
  await doSaveSettings();
}

/** Execute the settings save. */
async function doSaveSettings() {
  if (!settingsTarget) return;
  const newName = document.getElementById('settingsName').value.trim();
  const body = {
    engine: document.getElementById('settingsEngine').value,
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
  // Only `enabled` is sent, and it is sent as a one-key object the server
  // MERGES: `evalAuditMode` holds the scoring tunables too, and posting the
  // whole object back would let a stale modal overwrite a hand-edited cost cap.
  const evalAuditEl = document.getElementById('settingsEvalAudit');
  if (evalAuditEl) {
    body.evalAuditMode = { enabled: evalAuditEl.checked };
  }

  const featureIndexEl = document.getElementById('settingsFeatureIndex');
  if (featureIndexEl) {
    body.featureIndexEnabled = featureIndexEl.checked;
  }
  // Project Map (PIDX #360, #356) — always present
  const projectMapEl = document.getElementById('settingsProjectMap');
  if (projectMapEl) {
    body.projectMapEnabled = projectMapEl.checked;
  }
  // Auto version-bump opt-out (#318) — always present (engine-agnostic)
  const versionBumpEl = document.getElementById('settingsVersionBump');
  if (versionBumpEl) {
    body.versionBumpEnabled = versionBumpEl.checked;
  }
  // Explicit version-file path (#540) — always present (engine-agnostic).
  // Blank clears it back to the built-in probe order.
  const versionFilePathEl = document.getElementById('settingsVersionFilePath');
  if (versionFilePathEl) {
    body.versionFilePath = versionFilePathEl.value.trim();
  }
  // Medusa session-comms auto-enable (MED-2K9P Chunk 02) — always present (engine-agnostic)
  const medusaEl = document.getElementById('settingsMedusa');
  if (medusaEl) {
    body.medusaEnabled = medusaEl.checked;
  }
  // Medusa idle-gated wake opt-in (MED-2K9P v2 T2) — always present (server gates engine)
  const medusaWakeEl = document.getElementById('settingsMedusaWake');
  if (medusaWakeEl) {
    body.medusaWake = medusaWakeEl.checked;
  }
  // CC-6 (#381): wrap-summary section selection. undefined → not rendered (skip);
  // null → all 8 (clear override); array → the chosen subset.
  const wrapSel = collectWrapSectionsSelection();
  if (wrapSel !== undefined) {
    body.wrapSections = wrapSel;
  }
  // Launch-mode posture — only sent when CHANGED from the project's stored
  // values, so an already-confirmed bypass+hidden combination never re-trips
  // the server's eyes-open guard on unrelated saves (tags, toggles, …).
  const project2 = state.projects.find(p => p.name === settingsTarget);
  const launchModeEl = document.getElementById('settingsDefaultLaunchMode');
  const showPickerEl = document.getElementById('settingsShowLaunchPicker');
  if (launchModeEl && project2 && launchModeEl.value !== (project2.defaultLaunchMode || 'default')) {
    body.defaultLaunchMode = launchModeEl.value;
  }
  if (showPickerEl && project2 && showPickerEl.checked !== (project2.showLaunchModePicker !== false)) {
    body.showLaunchModePicker = showPickerEl.checked;
  }
  // Eyes-open guard (client half — the server enforces the same rule): hiding
  // the picker while the effective default mode carries a warning removes the
  // red warning from the launch flow, so route through an explicit confirm.
  if (body.defaultLaunchMode !== undefined || body.showLaunchModePicker !== undefined) {
    const effMode = body.defaultLaunchMode !== undefined
      ? body.defaultLaunchMode
      : ((project2 && project2.defaultLaunchMode) || 'default');
    const effShow = body.showLaunchModePicker !== undefined
      ? body.showLaunchModePicker
      : (project2 ? project2.showLaunchModePicker !== false : true);
    const guardProfile = (state.engines || []).find(e => e.id === body.engine);
    const modeConfig = guardProfile && guardProfile.launchModes && guardProfile.launchModes[effMode];
    if (!effShow && modeConfig && modeConfig.warning) {
      openBypassHiddenModal(body, effMode, modeConfig, settingsTarget, _submitSettings);
      return;
    }
  }

  await _submitSettings(body);
}

/**
 * Send the settings PATCH and close the modal — the shared tail of
 * doSaveSettings and the bypass-hidden confirm path. A server rejection
 * (validation, or the eyes-open guard tripping on stale two-tab state) keeps
 * the modal OPEN and surfaces the error, instead of silently closing as if
 * the save succeeded.
 * @param {object} body - PATCH body for /api/projects/:name
 */
async function _submitSettings(body) {
  if (!settingsTarget) return;
  const res = await apiMutate(`/api/projects/${encodeURIComponent(settingsTarget)}`, 'PATCH', body);
  if (!res) {
    const status = document.getElementById('projectRulesStatus');
    if (status) {
      status.textContent = `Save failed: ${api.lastError || 'server rejected the update'}`;
      status.className = 'rules-status rules-status-err';
      status.classList.remove('hidden');
    }
    return;
  }
  closeSettings();
  renderSettingsWarnings(res.warnings);
  await loadProjects();
}

/**
 * This page's name over the shared renderer. The implementation moved to
 * `tcRenderSettingsWarnings` in api-helper.js when the session page needed the
 * same banner (#758); the rationale for the surface — every warning names
 * something the operator must go and do, so it stays until dismissed rather
 * than riding a timer — lives with it there.
 * @param {string[]|undefined} warnings - `warnings` from PATCH /api/projects/:name
 */
function renderSettingsWarnings(warnings) {
  window.tcRenderSettingsWarnings(document, warnings);
}

// ── Bypass-default + hidden-picker confirm (eyes-open guard) ──

/** The settings PATCH body parked while the confirm modal is open. */
let pendingBypassHiddenBody = null;
// What the confirm resends to. Editing a project sends a PATCH; creating one
// sends the create POST. One modal, because the question and the warning the
// operator must read are identical — two would drift.
let pendingBypassHiddenSubmit = null;

/**
 * Open the eyes-open confirm for a hidden picker over a warning-carrying
 * default launch mode.
 * @param {object} body - The body to resend on confirm
 * @param {string} modeKey - The effective default mode key
 * @param {object} modeConfig - The engine's launchModes entry for that key
 * @param {string} subject - The project the posture applies to
 * @param {Function} [onConfirm] - Async sender; defaults to the settings PATCH
 */
function openBypassHiddenModal(body, modeKey, modeConfig, subject, onConfirm) {
  pendingBypassHiddenBody = body;
  pendingBypassHiddenSubmit = onConfirm || _submitSettings;
  document.getElementById('bypassHiddenText').innerHTML =
    `<p>Every launch of <strong>${esc(subject === undefined ? settingsTarget : subject)}</strong> will start directly in <strong>${esc(modeConfig.label || modeKey)}</strong> mode — no picker, and no warning shown at launch.</p>`
    + (modeConfig.warning ? `<p class="launch-mode-warning">${esc(modeConfig.warning)}</p>` : '');
  document.getElementById('bypassHiddenModal').classList.add('open');
}

/** Close the confirm modal without saving. */
function closeBypassHiddenModal() {
  pendingBypassHiddenBody = null;
  pendingBypassHiddenSubmit = null;
  document.getElementById('bypassHiddenModal').classList.remove('open');
}

/** Confirm — resend the parked body with the server guard's confirm flag. */
async function confirmBypassHidden() {
  const body = pendingBypassHiddenBody;
  const submit = pendingBypassHiddenSubmit || _submitSettings;
  if (!body) return;
  pendingBypassHiddenBody = null;
  pendingBypassHiddenSubmit = null;
  document.getElementById('bypassHiddenModal').classList.remove('open');
  body.confirmBypassHidden = true;
  await submit(body);
}

// ── Global Settings Modal ──

/**
 * Render the Login section from the server's own answer about this install.
 *
 * The form is drawn only when `GET /api/auth/credential` says a change is
 * possible, and the refusal text comes from the same predicate the POST uses — so
 * the surface can never offer a change that submitting would then refuse. That
 * disagreement, between what a client decided and what the server decided about
 * one machine, is a defect this work has already had to fix once elsewhere.
 * @returns {Promise<void>}
 */
async function _loadCredentialSection() {
  const box = document.getElementById('gsCredentialSection');
  if (!box) return;
  const info = await api('/api/auth/credential');
  if (!info) {
    box.innerHTML = `<div class="form-hint">Could not check the login setting: ${esc(api.lastError || 'unknown error')}</div>`;
    return;
  }
  if (!info.changeable) {
    // Not an error state — most of these are simply "there is nothing here to
    // change", and each carries the command that does apply.
    box.innerHTML = `
      <div class="form-hint">
        ${esc(info.reason || 'The login cannot be changed from here.')}
        ${info.remedy ? `<br><br>${esc(info.remedy)}` : ''}
      </div>`;
    return;
  }
  box.innerHTML = `
    <label class="form-label" for="gsCredUser">Username</label>
    <input type="text" class="form-input" id="gsCredUser" autocomplete="username"
           value="${esc(info.user || '')}" readonly aria-readonly="true"
           spellcheck="false" autocapitalize="none">
    <div class="form-hint">
      Shown so you know which login you are changing. The username cannot be changed
      here — it selects which credential to re-hash rather than setting one, so a
      rename would leave the gate on the old name. Use
      <code>node scripts/reset-admin.js</code> at a terminal to change it.
    </div>
    <label class="form-label" for="gsCredPassword">New password</label>
    <input type="password" class="form-input" id="gsCredPassword" autocomplete="new-password">
    <label class="form-label" for="gsCredConfirm">Confirm new password</label>
    <input type="password" class="form-input" id="gsCredConfirm" autocomplete="new-password">
    <div class="form-hint" id="gsCredHint">
      <strong>Changing this signs you out.</strong> The login is enforced by Caddy, and a browser
      cannot be handed new credentials — so the next page you load will ask for the new password.
      Have it to hand before you save. If you lose it, run
      <code>node scripts/reset-admin.js</code> at a terminal on this machine.
    </div>
    <button type="button" class="btn" id="gsCredSaveBtn">Change login</button>`;

  const saveBtn = document.getElementById('gsCredSaveBtn');
  saveBtn.addEventListener('click', async () => {
    const hint = document.getElementById('gsCredHint');
    const password = document.getElementById('gsCredPassword').value;
    const confirm = document.getElementById('gsCredConfirm').value;

    // Confirm is checked HERE and only here. It is NOT the "current password"
    // field a change form usually carries — the server cannot verify one of
    // those, so asking would be theatre. This one catches a typo, which matters
    // more than usual: a mistyped password locks the operator out of their own
    // dashboard, and the only way back is a terminal on the box.
    if (password !== confirm) {
      hint.innerHTML = '<strong>Those two passwords do not match.</strong> Nothing was changed.';
      return;
    }

    saveBtn.disabled = true;
    // No `user` in the body. The field is read-only and the server resolves the
    // target from the live gate — sending it back would be a value the client had
    // no authority over, and a stale one if config and the file have drifted.
    const res = await apiMutate('/api/auth/credential', 'POST', { password });
    saveBtn.disabled = false;

    if (!res) {
      // The lead sentence is NOT hard-coded, and the list below is the whole
      // family rather than the first member of it. Most refusals here really are
      // "your login was not changed and nothing else happened". Two are not:
      // GATE_BROKEN means the Caddy config could not be written or put back, and
      // DIVERGED means the login DID change and config disagrees — so leading
      // with a bold "The login was not changed" is a reassurance above a warning
      // in the first case and simply false in the second, directly above a body
      // saying the new password is the one in force. A scanning operator reads
      // the bold line and nothing else, so on both the server's own sentence has
      // to BE the bold line.
      const SERVER_LEADS = ['GATE_BROKEN', 'DIVERGED'];
      hint.innerHTML = SERVER_LEADS.includes(api.lastErrorCode)
        ? `<strong>${esc(api.lastError || 'The change did not complete cleanly.')}</strong>`
        : `<strong>The login was not changed.</strong> ${esc(api.lastError || 'Unknown error')}`;
      return;
    }
    // Terminal state, and it waits. No redirect, no auto-dismiss: the operator is
    // about to be asked for a password, and a screen that moves on its own takes
    // away the moment they need to read which one.
    // The reload's outcome is deliberately NOT reported here, because the server
    // cannot report it: Caddy restarts as this response leaves, and every request
    // after that needs the new password, so there is no reply left to carry the
    // answer. What the operator gets instead is the symptom to watch for and the
    // command that fixes it — which is the whole of what they can act on.
    box.innerHTML = `
      <div class="form-hint">
        <strong>Your login is changed${res.user ? ` for ${esc(res.user)}` : ''}.</strong>
        The next page you load will ask for the new password.
        ${res.reloadCommand
          ? `<br><br>If you are never asked, and the old password still works, Caddy did not
             restart. Run <code>${esc(res.reloadCommand)}</code> at a terminal on this machine
             to apply it.`
          : ''}
      </div>`;
  });
}

/**
 * Open the global settings modal, loading current config values.
 */
function openGlobalSettings() {
  const c = state.config || {};
  const body = document.getElementById('globalSettingsBody');

  const engineOpts = buildEngineOptions(state.engines, c.defaultEngine || '');

  const scannerIntervalSec = Math.round((c.portScannerIntervalMs || 60000) / 1000);

  // #710 — rendered from the SERVER's resolved bind state (`bindState` on
  // /api/config), never re-derived here. The rules belong to the server: caddy
  // mode overrides an opt-in, and an install that has never chosen is held wide
  // on purpose. Every previous attempt to restate those rules in the frontend
  // drifted, and the drift was always a control that misdescribed the socket —
  // a switch reading "closed" over an open port, or the reverse.
  const bindState = c.bindState || {};
  const bindLockedByCaddy = !!bindState.lockedByCaddy;
  // `wide` is the binding CONFIG resolves to — what the socket will be after the
  // next restart, and what it already is unless the setting changed since boot
  // (hence requiresRestart). `choice` is what the operator has RECORDED. They
  // differ in the grace state, which is why the switch reads ON there and why an
  // untouched Save must not write anything.
  const bindShowsOn = !!bindState.wide;
  const bindUnchosen = bindState.choice === 'unchosen';

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

    <div class="gs-section-label">Network Exposure</div>
    <div class="form-group">
      <label class="gs-toggle-label${bindLockedByCaddy ? ' gs-toggle-locked' : ''}"
             ${bindLockedByCaddy ? 'aria-disabled="true" title="Locked while the Caddy ingress is in use"' : ''}>
        <span>Accept connections from the network</span>
        <input type="checkbox" id="gsBindAllInterfaces"
               data-rendered="${bindShowsOn ? '1' : '0'}"
               ${bindShowsOn ? 'checked' : ''} ${bindLockedByCaddy ? 'disabled' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">
        ${bindLockedByCaddy
          ? 'Locked while the Caddy ingress is in use. Caddy fronts the server and holds the login '
            + 'gate, so TangleClaw stays on <code>127.0.0.1</code> behind it — binding the network '
            + 'directly would open an ungated door beside the gated one. Reach TangleClaw through '
            + 'Caddy, or switch to direct mode first.'
          : 'Off (default): TangleClaw listens on <code>127.0.0.1</code> only, so it is reachable from '
            + 'this machine alone. On: it accepts connections from every network interface — anyone who '
            + 'can reach this machine gets the dashboard, and the dashboard launches AI sessions with '
            + 'shell access. Turn this on only on a network you trust, and prefer setting up the login '
            + 'gate instead, which keeps remote access without leaving the door open. Requires a restart.'}
      </div>
    </div>
    ${bindUnchosen && !bindLockedByCaddy ? `
    <div class="form-group">
      <div class="form-hint">
        <strong>You have not chosen yet.</strong> This install predates the setting, so TangleClaw
        left your binding alone rather than cutting off access you might be using. Turning the switch
        off above and saving closes it. If you deliberately want to keep it open, confirm below —
        that records the choice and stops the warning, without a moment where the door is shut on you.
      </div>
      <button type="button" class="btn" id="gsBindKeepOpen">Keep network access, and stop warning me</button>
    </div>` : ''}

    <div class="gs-section-label">Login</div>
    <div class="form-group" id="gsCredentialSection">
      <div class="form-hint">Checking what this install can change…</div>
    </div>

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
  // #710 — the ONLY route from the grace state to a recorded "keep it open".
  // The switch cannot serve that purpose: a grace install renders it already ON
  // (truthfully — it IS bound wide), so it is never "moved" and the save omits
  // the field. Reaching `true` by toggling off, saving, then back on would pass
  // through a state that narrows at the next restart, which strands precisely
  // the remote operator this whole grace mechanism exists to protect. One
  // deliberate click, one write, no intermediate state.
  const bindKeepOpenBtn = document.getElementById('gsBindKeepOpen');
  if (bindKeepOpenBtn) {
    bindKeepOpenBtn.addEventListener('click', async () => {
      bindKeepOpenBtn.disabled = true;
      const data = await apiMutate('/api/config', 'PATCH', { bindAllInterfaces: true });
      if (data && data.config) {
        state.config = data.config;
        closeGlobalSettings();
      } else {
        // The operator this exists for is remote and has no console — a button
        // that just re-enables itself reads as "nothing happened", and they are
        // left believing the exposure warning is unresolvable.
        bindKeepOpenBtn.disabled = false;
        bindKeepOpenBtn.textContent =
          `Could not save: ${api.lastError || 'server rejected the change'} — tap to retry`;
      }
    });
  }

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
  _loadCredentialSection();

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
    projectsDir: document.getElementById('gsProjectsDir').value.trim(),
    portScannerEnabled: document.getElementById('gsPortScannerEnabled').checked,
    portScannerIntervalMs: intervalMs,
    stripAiCoauthors: document.getElementById('gsStripAiCoauthors').checked,
    serviceTokenEnabled: document.getElementById('gsServiceTokenEnabled').checked
  };

  // Send this ONLY when the operator actually moved the switch.
  //
  // Two reasons, and the second is a security bug rather than tidiness. The
  // control is locked in caddy mode, so a locked control must never write. And
  // an install still in the grace state renders this switch ON — truthfully,
  // because it really is bound wide — so unconditionally posting `.checked`
  // would record `bindAllInterfaces: true` the first time the operator saved
  // ANY unrelated setting. That converts "never chosen, and being told about it
  // loudly" into "deliberately opted in", which silences the warning forever and
  // makes a bounded exposure window unbounded, without anyone choosing it.
  //
  // Comparing against the state it was RENDERED in is what distinguishes "the
  // operator flipped this" from "the operator changed their theme".
  const bindToggle = document.getElementById('gsBindAllInterfaces');
  if (bindToggle && !bindToggle.disabled) {
    const renderedOn = bindToggle.dataset.rendered === '1';
    if (bindToggle.checked !== renderedOn) patch.bindAllInterfaces = bindToggle.checked;
  }

  const data = await apiMutate('/api/config', 'PATCH', patch);
  if (data && data.config) {
    state.config = data.config;
    applyTheme();
  }
  closeGlobalSettings();
}

// ── Create Project Drawer ──

let createStep = 0;
let createData = { name: '', engine: '', defaultLaunchMode: 'default', showLaunchModePicker: true, silentPrime: true, tags: '' };

function openCreateModal() {
  createStep = 0;
  createData = {
    name: '',
    // Resolved against what is installed, not read straight from config. The
    // drawer POSTs this value, so seeding it from `config.defaultEngine`
    // short-circuited the server's resolver and created projects bound to an
    // engine the machine does not have (#707).
    engine: resolvePickerEngine(state.engines, state.config ? state.config.defaultEngine : ''),
    defaultLaunchMode: 'default',
    // #626: the pair of `defaultLaunchMode`. Shipped default, so a wizard the
    // operator clicks straight through creates exactly what it did before.
    showLaunchModePicker: true,
    silentPrime: true,
    tags: ''
  };
  renderCreateStep();
  // Only the backdrop carries `.open` — the content's scale-in transition is
  // driven by `.modal-backdrop.open .modal-content` (#623).
  document.getElementById('createBackdrop').classList.add('open');
}

function closeCreateModal() {
  document.getElementById('createBackdrop').classList.remove('open');
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
    document.getElementById('createTitle').textContent = 'Engine';
    const engineOpts = buildEngineOptions(state.engines, createData.engine);
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="createEngine">Engine</label>
        <select class="form-select" id="createEngine">${engineOpts}</select>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" style="flex:1" onclick="createBack()">Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="createNext()">Next</button>
      </div>`;
  } else if (createStep === 2) {
    document.getElementById('createTitle').textContent = 'First-Session Settings';
    const profile = (state.engines || []).find(e => e.id === createData.engine);
    
    let launchModeHtml = '';
    const enabledEntries = tcHonoredLaunchModes(profile);
    if (enabledEntries.length > 0) {
      const opts = enabledEntries.map(([key, m]) =>
        `<option value="${esc(key)}" ${key === createData.defaultLaunchMode ? 'selected' : ''}>${esc(m.label || key)}${m.warning ? ' ⚠' : ''}</option>`
      ).join('');
      launchModeHtml = `
        <div class="form-group">
          <label class="form-label" for="createLaunchMode">Launch Posture</label>
          <select class="form-select" id="createLaunchMode">${opts}</select>
          <div class="form-hint">The default mode this project launches in.</div>
        </div>
        <div class="form-group">
          <label class="gs-toggle-label">
            <span>Show launch mode picker</span>
            <input type="checkbox" id="createShowLaunchPicker" ${createData.showLaunchModePicker ? 'checked' : ''}>
            <span class="toggle-switch"></span>
          </label>
          <div class="form-hint">When off, Launch skips the mode picker and starts the session directly in the default mode.</div>
        </div>`;
    }

    // Same owner as the settings modal's toggle (ADR 0013): the wizard used to
    // drop the control on an engine that cannot honor it, which reads as "this
    // engine has no such setting" to an operator who set it on another project.
    // The inert branch carries no `#createSilentPrime`, so `createNext` reads
    // nothing there — but `createData` keeps whatever was toggled on a PREVIOUS
    // engine, which is why `submitCreate` re-asks the disposition before it
    // posts rather than trusting the absence of an element.
    const silentPrimeFit = tcSettingDisposition('silentPrime', { silentPrime: createData.silentPrime },
      profile || null);
    const silentPrimeHtml = silentPrimeFit.applies
      ? `
        <div class="form-group">
          <label class="gs-toggle-label">
            <span>Silent Prime</span>
            <input type="checkbox" id="createSilentPrime" ${createData.silentPrime ? 'checked' : ''}>
            <span class="toggle-switch"></span>
          </label>
          <div class="form-hint">Skip the initial context prime prompt.</div>
        </div>`
      : `
        <div class="form-group">
          <label class="gs-toggle-label gs-toggle-label--disabled">
            <span>Silent Prime</span>
            <input type="checkbox" id="createSilentPrimeNotApplicable" disabled>
            <span class="toggle-switch"></span>
          </label>
          <div class="form-hint">${esc(silentPrimeFit.reason)}</div>
        </div>`;

    body.innerHTML = `
      ${launchModeHtml}
      ${silentPrimeHtml}
      ${!launchModeHtml ? '<div class="form-hint">This engine offers no launch postures to choose from.</div><br>' : ''}
      <div style="display:flex;gap:8px">
        <button class="btn" style="flex:1" onclick="createBack()">Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="createNext()">Next</button>
      </div>`;

  } else if (createStep === 3) {
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
          <div style="color:var(--text-muted);margin-top:4px">Engine: ${esc(createData.engine)}</div>
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
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
      const errEl = document.getElementById('createNameError');
      errEl.textContent = 'Invalid name. Use letters, numbers, spaces, hyphens, or underscores.';
      errEl.classList.remove('hidden');
      return;
    }
    createData.name = name;
  } else if (createStep === 1) {
    createData.engine = document.getElementById('createEngine').value;
  } else if (createStep === 2) {
    const modeEl = document.getElementById('createLaunchMode');
    if (modeEl) createData.defaultLaunchMode = modeEl.value;
    const showEl = document.getElementById('createShowLaunchPicker');
    if (showEl) createData.showLaunchModePicker = showEl.checked;
    const silentEl = document.getElementById('createSilentPrime');
    if (silentEl) createData.silentPrime = silentEl.checked;
  }
  createStep++;
  renderCreateStep();
}

function createBack() {
  if (createStep === 3) createData.tags = document.getElementById('createTags').value;
  createStep--;
  renderCreateStep();
}

async function submitCreate() {
  createData.tags = document.getElementById('createTags').value;
  // Eyes-open guard, client half (#626). The server refuses the combination
  // outright; asking here is what lets the operator SEE the warning they are
  // switching off, which is the entire point of the guard. Creation is where
  // the posture is established, so it is the last place it should be implicit.
  if (createData.showLaunchModePicker === false) {
    const profile = (state.engines || []).find(e => e.id === createData.engine);
    const mode = createData.defaultLaunchMode || 'default';
    const modeConfig = profile && profile.launchModes && profile.launchModes[mode];
    // Keyed to what was actually confirmed, not a sticky boolean. A failed
    // create leaves the drawer open with the flag latched, so Back → pick a
    // DIFFERENT warned mode → Create would resend a confirmation for a warning
    // the operator never saw. They did see a warning; just not this one, which
    // is the whole content of the guard.
    const confirmedFor = `${createData.engine}:${mode}`;
    if (modeConfig && modeConfig.warning && createData.confirmBypassHiddenFor !== confirmedFor) {
      // The parked body is unused on this path: the create resends through its
      // own closure over `createData`, not by mutating a PATCH body.
      openBypassHiddenModal({}, mode, modeConfig, createData.name || 'this project', async () => {
        createData.confirmBypassHiddenFor = confirmedFor;
        await submitCreate();
      });
      return;
    }
  }
  const btn = document.getElementById('createSubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  // Built by `tcCreateProjectBody` (api-helper.js) so the three conditionals in
  // it — which settings are sent, whether the confirmation rides along, how
  // tags split — can be run by a test rather than matched as source text.
  const result = await apiMutate('/api/projects', 'POST',
    tcCreateProjectBody(createData, state.engines));

  if (!result) {
    const errEl = document.getElementById('createError');
    errEl.textContent = api.lastError || 'Failed to create project.';
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Create';
    return;
  }

  // Show warnings from partial failures (scaffolding, git init, hooks)
  if (result.warnings && result.warnings.length > 0) {
    const toast = document.getElementById('toast');
    toast.textContent = `Warning: ${result.warnings.join('; ')}`;
    toast.className = 'toast toast-warn visible';
    setTimeout(() => { toast.classList.remove('visible'); }, 8000);
  }

  closeCreateModal();
  await loadProjects();

  // One launch path, one gate (#401). This used to auto-launch with a raw
  // POST, which silently bypassed launchProject's mode-picker gate — and on a
  // fresh install, creating a project is the FIRST launch anyone performs, so
  // the picker never appeared at all and the session started with no chosen
  // mode. Routing through launchProject gives the create flow exactly what
  // the card's Open button gives: the picker when the engine offers a choice,
  // the project's own opt-out when configured, and navigation into the live
  // terminal on success. On a failed launch the operator keeps the dashboard
  // and its error toast instead of landing on a dead session page.
  await launchProject(createData.name);
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
      // Was console-only, which meant a skipped import was invisible to anyone
      // not holding devtools open. The toast is the surface the operator has.
      const t = document.getElementById('toast');
      if (t) {
        t.textContent = `Import warning: ${otherWarnings.join('; ')}`;
        t.className = 'toast toast-warn visible';
        setTimeout(() => { t.classList.remove('visible'); }, 6000);
      }
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
    document.getElementById('groupError').textContent = api.lastError || 'Save failed.';
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
    statusEl.textContent = api.lastError || 'Sync failed.';
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
    // CONFLICT, BAD_REQUEST, etc. Falls back to a plain "Save failed." only
    // when no error payload was returned (#83).
    const code = api.lastErrorCode ? ` (${api.lastErrorCode})` : '';
    document.getElementById('ocError').textContent = api.lastError
      ? `Save failed: ${api.lastError}${code}`
      : 'Save failed.';
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
    resultEl.textContent = `Test failed: ${api.lastError || 'unknown error'}`;
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
    document.getElementById('docError').textContent = api.lastError || 'Save failed.';
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
    // "No projects have Eval Audit enabled" was true and actionable by nobody:
    // it named a state without naming the feature, where to switch it on, or
    // why most projects cannot. #1227 read this panel, concluded the button was
    // a dead placeholder, and filed to delete a complete working feature.
    panel.innerHTML = '<div class="audit-empty">'
      + '<strong>Eval Audit scores your sessions.</strong> It grades each exchange for quality and '
      + 'raises an incident when it drops \u2014 a free structural pass, then optional LLM-judge passes '
      + 'that spend real money.'
      + '<br><br>Turn it on per project in <strong>Settings \u2192 Eval Audit</strong>. It is available on '
      + 'projects running through an OpenClaw connection, which is how scored exchanges reach '
      + 'TangleClaw; on any other engine the setting says so rather than sitting there doing nothing.'
      + '</div>';
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
// The global assistant above all projects, bounded by the operator-set access
// level on its control bar rather than by a fixed read-only rule (#755). The panel embeds the
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
// Declared here, ABOVE its first reader, and assigned further down where its
// dependencies exist. A `const` at the assignment site would put every reader
// between the two in a temporal dead zone: `setMasterStatus` reads it, and a
// future top-level call added anywhere above the assignment would throw at
// parse time rather than fail visibly. `let` plus the guard in each reader
// makes the ordering a non-issue instead of a rule someone has to remember.
let masterBar = null;

function setMasterStatus(status, text, showRetry) {
  // The header BUTTON's dot stays here — it sits outside the panel and has no
  // counterpart on the session page, so it is genuinely dashboard-only.
  const dot = document.getElementById('masterDot');
  if (dot) {
    dot.classList.remove('live', 'pending', 'down');
    if (status) dot.classList.add(status);
  }
  // Everything inside the panel row belongs to the shared bar. Painting it by
  // id from here would be the second implementation #768 exists to remove, and
  // it is the copy that would quietly stop matching the session's.
  if (masterBar) masterBar.setStatus(status, text, showRetry);
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
    // A refusal because tmux never answered is an UNKNOWN, not a down master —
    // the ensure did not fail, it declined to run rather than start a second
    // master over one it could not see. Painting it red would state exactly the
    // fact the server said it could not establish, which is the defect this
    // whole change removes, re-entered by the panel's own error path.
    const unknown = api.lastErrorCode === 'MASTER_LIVENESS_UNKNOWN';
    setMasterStatus(unknown ? '' : 'down',
      api.lastError || 'Failed to start the master session', true);
    return;
  }
  setMasterStatus('live', result.created ? 'Master session started' : 'Master session live');
  // Repaint the access controls from a full status read rather than from
  // `result`: the ensure response carries the level and the enforcement tier but
  // not the guard readback, and the guard readback is the half that says whether
  // the level is actually in force.
  if (masterBar) masterBar.loadAccess();
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
 * master session is already live before the panel is ever opened.
 *
 * No polling — and NOT because the no-UI-timers norm forbids one. This comment
 * used to cite it as the reason, which is a mis-citation the next reader would
 * inherit: #98/#268 governs timer-driven LIFECYCLE (auto-dismiss, revert,
 * redirect, blind reload), and `reconnect-policy.js` records a poll explicitly
 * as inside the norm. The real reason is that this page has nothing to poll FOR:
 * it repaints on open and on ensure, which covers every moment the panel is
 * visible, so a clock would buy a cosmetic refresh of a closed panel.
 *
 * The residual, accepted deliberately: a panel left open while another surface
 * flips the access level shows a stale segment until something touches it. It
 * cannot ACT on that stale value — the bar re-fetches before every flip — and
 * that is the half that matters.
 */
async function refreshMasterDot() {
  const status = await api('/api/master/status');
  if (!status) return;
  // The access controls paint from THIS fetch rather than issuing their own.
  // Two calls answering the same question is how the dashboard and the session
  // came to disagree about everything else the bar had to reunify.
  if (masterBar) masterBar.setAccess(status.settings || null);
  // The Medusa control paints from the same fetch (#996) — `medusa` is a
  // top-level field of the status, beside `settings`.
  if (masterBar) masterBar.setMedusa(status.medusa || null);
  // The model pill is painted from the Master's OWN engine, whatever the
  // status says about liveness — an unreachable master still has a configured
  // engine, and hiding the pill would lose that.
  // `settings.resolvedEngine`, NOT `status.engine` — there is no top-level
  // engine on this payload, so the first version of this passed `undefined` and
  // the pill stayed hidden on exactly the surface the finding was raised
  // against. `resolvedEngine` is what will actually run (`settings.engine` is
  // the stored preference and is null when unpinned), which is the same value
  // the ensure response carries as `engine`, so both pages paint from one fact.
  if (masterBar) masterBar.loadModel((status.settings && status.settings.resolvedEngine) || null);
  if (status.exists) {
    setMasterStatus('live');
    return;
  }
  // `exists: null` is tmux declining to answer, not the master being down, and
  // the two used to be the same silence: the dot stayed neutral and the row
  // still read "Checking…", so a wedged tmux was indistinguishable from a master
  // nobody had started. Opening the panel then fired an ensure that failed on
  // the same unresponsive server and reported "Failed to start" — blaming the
  // start for a condition that predates it.
  //
  // Said in words rather than as a fourth dot colour: the dot is a two-pixel
  // affordance already carrying three meanings, and "we could not look" is not
  // a degree of down.
  //
  // Rendered through the shared degraded-read vocabulary rather than a sentence
  // written here, because a project card on this same page already names the
  // cause AND the remedy for this exact wedge — a master row that named neither,
  // two elements away, would be the same condition explained two ways. That
  // module exists so a new source joins in one place instead of growing another
  // render path.
  if (status.exists === null) {
    const read = window.tcMasterRead(status);
    setMasterStatus('', [read.why, read.remedy].filter(Boolean).join(' '), true);
  }
}

// ── Master settings modal ──
// The modal, its Hard-rules editor and its save handler moved into
// `public/api-helper.js` as `tcCreateMasterSettings`, because the Master's
// settings must also be reachable from inside a session — the operator had to
// leave the session and return to the dashboard to change what the Master is
// allowed to do. Both surfaces mount the same component; the dashboard passes
// its own status-dot painter so a failed open still reports where the gear is.
const masterSettings = window.tcCreateMasterSettings({
  api,
  apiMutate,
  esc,
  buildEngineOptions,
  state,
  onOpenError: (message) => { setMasterStatus('down', message, true); if (masterBar) masterBar.setError(message); },
  // The gear and the bar are two controls for one setting, and on this
  // surface the gear sits INSIDE the bar. A save here must move the toggle,
  // or the operator watches it keep saying the old level.
  onSaved: () => { if (masterBar) masterBar.loadAccess(); }
});

// The settings-warnings banner (#1148, #758), from the same builder the session
// page uses, so the two surfaces cannot drift.
{
  const warnHost = document.getElementById('settingsWarningsHost');
  if (warnHost) warnHost.innerHTML = window.tcSettingsWarningsMarkup();
}

// The Master control bar. Same component the session drawer mounts, so the two
// surfaces render from one implementation; only ids and label differ.
masterBar = window.tcCreateMasterControlBar({
  doc: document,
  rootId: 'masterPanelBar',
  prefix: 'masterPanel',
  title: 'Project Master',
  api,
  apiMutate,
  esc,
  onRetry: ensureMasterAttached,
  onOpenSettings: () => { masterBar.setError(''); masterSettings.open(); }
});
masterBar.mount();

// ── Event Bindings ──

const $ = (id) => document.getElementById(id);
$('masterToggle').addEventListener('click', toggleMaster);
// The component owns the modal end to end: this injects the markup (index.html
// no longer carries it) and binds Close, Save and the Hard-rules delegation.
// Only the gear above stays the dashboard's, because the affordance is.
masterSettings.mount();
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
// filterBtn removed — filter input is always visible inline
$('newBtn').addEventListener('click', openCreateModal);
$('createClose').addEventListener('click', closeCreateModal);
// The dialog nests INSIDE the backdrop, so an unguarded handler would close on
// every click inside the form. Same target guard the other modals use.
$('createBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeCreateModal(); });
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
$('bypassHiddenCancelBtn').addEventListener('click', closeBypassHiddenModal);
$('bypassHiddenConfirmBtn').addEventListener('click', confirmBypassHidden);
$('bypassHiddenModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeBypassHiddenModal(); });
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


const engineFilterEl = document.getElementById('engineFilter');
if (engineFilterEl) {
  engineFilterEl.addEventListener('change', (e) => {
    state.activeEngine = e.target.value;
    renderProjects();
  });
}

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
