'use strict';
/* ── TangleClaw — v6 Fleet-First route-based application shell (#2981, V6-08 / B1) ── */
/*
 * Car V60-T2-W2-UI (Charter A555). Adds client-side, hash-based routing
 * (`#/projects/:id`, `#/projects/:id/fleets/:fleetId`,
 * `#/resources/:id/conversation`, `#/settings/*`) plus a collapsible
 * Logical Project -> Fleet -> Member sidebar, a mobile drawer, and render
 * hooks for the B4 telemetry header, the C2 fleet-template wizard, the D1
 * model-attestation indicator, and the H1 watermark/attribution footer.
 *
 * COEXISTENCE (BRIDGE-5, #2188): loaded as an ADDITIVE script alongside the
 * existing flat-dashboard `public/ui.js` — nothing in this file edits the
 * existing #2188 engine/model picker code (public/ui.js lines ~2250-2490,
 * ~5045) or any other existing control. The hash-route shell mounts into
 * its own root (`#v6ShellRoot`) and is shown/hidden by whether the current
 * location hash matches one of ITS routes; with no v6 hash route, the
 * existing flat dashboard renders exactly as it always has. A full
 * replace-in-place of the 8,000+ line existing dashboard is explicitly NOT
 * attempted by this car — that is a larger, separate migration than one
 * car's envelope should risk.
 *
 * `server.js` route admission for the live `/api/v6/...` data this shell
 * will eventually render (fleet hierarchy, telemetry, templates,
 * attestation) is `BRIDGE-2`/`Car V60-T2-W2-ROUTES`, a separate car — this
 * file accepts that data through its own `opts` (tree/telemetry/templates/
 * attestation/watermark), decoupled from any specific fetch call, the same
 * pattern this wave's backend cars used for their own real collectors.
 *
 * Zero-dependency, no jsdom (this repo's own convention,
 * `test/_mini-dom.js`): every dynamic value is run through {@link escapeHtml}
 * before it reaches a template string — never raw interpolation — so the
 * sidebar, telemetry header, and the two render hooks are safe against a
 * project/fleet/member name, a model id, or an engine id carrying
 * attacker-controlled HTML.
 */

(function (global) {
  /**
   * Escape a value for safe interpolation into an HTML template string.
   * `null`/`undefined` become `''`, never the literal text "null"/"undefined".
   * @param {*} value
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Parse a location hash into a route. Recognizes exactly the four shapes
   * #2981 names; anything else (including an empty hash) is `{view: null}`
   * — the existing flat dashboard's own territory.
   * @param {string} hash - e.g. `location.hash`, with or without the leading `#`.
   * @returns {{view: null}|{view: 'project', projectId: string}|
   *   {view: 'fleet', projectId: string, fleetId: string}|
   *   {view: 'conversation', resourceId: string}|
   *   {view: 'settings', settingsPath: string}}
   */
  function parseRoute(hash) {
    const raw = typeof hash === 'string' ? hash : '';
    const path = raw.replace(/^#\/?/, '');
    if (!path) return { view: null };
    let segments;
    try {
      // PRR-B R1 HOLD (Ruling A579-PR3015-R1-HOLD-RECONCILED): a malformed
      // percent-encoded segment (an incomplete escape, invalid UTF-8 bytes)
      // throws URIError — fail closed to {view: null} rather than letting
      // a crafted/corrupted hash crash the shell's hashchange handler.
      segments = path.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return { view: null };
    }
    if (segments[0] === 'projects' && segments[1]) {
      if (segments[2] === 'fleets' && segments[3]) {
        return { view: 'fleet', projectId: segments[1], fleetId: segments[3] };
      }
      return { view: 'project', projectId: segments[1] };
    }
    if (segments[0] === 'resources' && segments[1] && segments[2] === 'conversation') {
      return { view: 'conversation', resourceId: segments[1] };
    }
    if (segments[0] === 'settings') {
      return { view: 'settings', settingsPath: segments.slice(1).join('/') };
    }
    return { view: null };
  }

  /**
   * Build the hash this shell would navigate to for a route object (the
   * inverse of {@link parseRoute}, for callers that construct a route by
   * hand rather than reading one back from a hash).
   * @param {{view: string, projectId?: string, fleetId?: string, resourceId?: string, settingsPath?: string}} route
   * @returns {string}
   */
  function routeHash(route) {
    if (!route || !route.view) return '#/';
    const enc = encodeURIComponent;
    switch (route.view) {
      case 'project': return `#/projects/${enc(route.projectId)}`;
      case 'fleet': return `#/projects/${enc(route.projectId)}/fleets/${enc(route.fleetId)}`;
      case 'conversation': return `#/resources/${enc(route.resourceId)}/conversation`;
      case 'settings': return `#/settings/${route.settingsPath ? enc(route.settingsPath) : ''}`;
      default: return '#/';
    }
  }

  /**
   * A human page title for a route, for the shell's own heading and the
   * document title.
   * @param {{view: string|null, projectId?: string, fleetId?: string, resourceId?: string, settingsPath?: string}} route
   * @returns {string}
   */
  function routeTitle(route) {
    if (!route) return 'Projects';
    switch (route.view) {
      case 'project': return `Project ${route.projectId}`;
      case 'fleet': return `Fleet ${route.fleetId}`;
      case 'conversation': return `Conversation — Resource ${route.resourceId}`;
      case 'settings': return route.settingsPath ? `Settings — ${route.settingsPath}` : 'Settings';
      default: return 'Projects';
    }
  }

  /**
   * Normalize a caller-supplied project/fleet/member list into a defensive
   * copy with every expected field present as at least an empty
   * string/array — so a render function never has to guess whether a
   * field was omitted or genuinely empty.
   * @param {Array<{id: *, displayName?: string, fleets?: Array<{id: *,
   *   displayName?: string, members?: Array<{seatId?: string, role?: string}>}>}>} projects
   * @returns {Array<{id: *, displayName: string, fleets: Array<{id: *,
   *   displayName: string, members: Array<{seatId: string, role: string}>}>}>}
   */
  function buildHierarchyTree(projects) {
    const list = Array.isArray(projects) ? projects : [];
    return list.map((p) => ({
      id: p && p.id,
      displayName: (p && p.displayName) || '',
      fleets: (Array.isArray(p && p.fleets) ? p.fleets : []).map((f) => ({
        id: f && f.id,
        displayName: (f && f.displayName) || '',
        members: (Array.isArray(f && f.members) ? f.members : []).map((m) => ({
          seatId: (m && m.seatId) || '',
          role: (m && m.role) || ''
        }))
      }))
    }));
  }

  /** Logical project id of the catch-all group every ungrouped project lands in. */
  const WORKSPACE_PROJECT_ID = 'workspace';

  /**
   * The dash-separated prefix shared by every name in `names` — whole
   * segments only, so `TC-Lane-A` and `TC-Lane-PM` share `TC-Lane`, never a
   * partial segment like `TC-Lane-P`.
   * @param {string[]} names
   * @returns {string}
   */
  function commonDashPrefix(names) {
    const split = names.map((n) => n.split('-'));
    const shared = [];
    for (let i = 0; i < split[0].length - 1; i++) {
      const segment = split[0][i];
      if (!split.every((parts) => parts.length > i + 1 && parts[i] === segment)) break;
      shared.push(segment);
    }
    return shared.join('-');
  }

  /**
   * Synthesize a Logical Project -> Fleet -> Member tree from the live
   * `GET /api/projects` rows (#3022 deliverable b), so every existing
   * project is navigable from the sidebar before any native v6 fleet data
   * exists. Projects whose names share a first dash segment with at least
   * one other project (`TC-Lane-A`, `TC-Lane-PM`, … or `Medusa-PM`,
   * `Medusa-INT`, …) become one Logical Project named for their longest
   * common dash prefix, holding one Fleet of those projects as members;
   * every other project becomes a member of a single "Workspace Projects"
   * fleet. Each member's `seatId` is the project's own id, which the
   * sidebar links to `#/resources/<id>/conversation`.
   *
   * Pure: groups and members are sorted by name, so the same rows always
   * yield the same tree.
   * @param {Array<{id: *, name?: string}>} projects - `GET /api/projects`'s `projects`.
   * @returns {Array<{id: string, displayName: string, fleets: Array<{id: string,
   *   displayName: string, members: Array<{seatId: string, role: string}>}>}>}
   */
  function synthesizeTreeFromProjects(projects) {
    const rows = (Array.isArray(projects) ? projects : [])
      .filter((p) => p && p.id != null && typeof p.name === 'string' && p.name)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const byHead = new Map();
    for (const p of rows) {
      const head = p.name.includes('-') ? p.name.split('-')[0] : null;
      if (!head) continue;
      if (!byHead.has(head)) byHead.set(head, []);
      byHead.get(head).push(p);
    }
    const grouped = new Set();
    const usedIds = new Set([WORKSPACE_PROJECT_ID]);
    const logical = [];
    for (const members of byHead.values()) {
      if (members.length < 2) continue;
      members.forEach((p) => grouped.add(p));
      const prefix = commonDashPrefix(members.map((p) => p.name));
      const slug = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      // Never collide with the catch-all group or a real project's numeric
      // id (the project route resolves numeric ids to legacy projects), and
      // never route to an empty id (a prefix with no ASCII letters or
      // digits slugs to '').
      let id = !slug || /^\d+$/.test(slug) ? `group-${slug || logical.length + 1}`
        : (slug === WORKSPACE_PROJECT_ID ? `${slug}-fleet` : slug);
      // Two heads differing only in case or punctuation slug alike.
      for (let n = 2; usedIds.has(id); n++) id = `${slug || 'group'}-${n}`;
      usedIds.add(id);
      logical.push({
        id,
        displayName: prefix,
        fleets: [{
          id,
          displayName: `${prefix} Fleet`,
          members: members.map((p) => ({ seatId: String(p.id), role: p.name }))
        }]
      });
    }
    logical.sort((a, b) => a.displayName.localeCompare(b.displayName));
    const standalone = rows.filter((p) => !grouped.has(p));
    if (standalone.length) {
      logical.push({
        id: WORKSPACE_PROJECT_ID,
        displayName: 'Workspace Projects',
        fleets: [{
          id: WORKSPACE_PROJECT_ID,
          displayName: 'Workspace Projects',
          members: standalone.map((p) => ({ seatId: String(p.id), role: p.name }))
        }]
      });
    }
    return logical;
  }

  /** The persisted key for a project node in the sidebar's fold state. */
  function projectNodeKey(project) { return `p:${project.id}`; }

  /** The persisted key for a fleet node, scoped by its project (fleet ids repeat across projects). */
  function fleetNodeKey(project, fleet) { return `f:${project.id}/${fleet.id}`; }

  /**
   * One fold toggle (`▾` open / `▸` folded) for a project or fleet node.
   * @param {string} id - The button's element id.
   * @param {string} nodeKey
   * @param {string} name - What it folds, for the accessible label.
   * @param {boolean} folded
   * @returns {string} HTML.
   */
  function treeToggleMarkup(id, nodeKey, name, folded) {
    return `<button type="button" id="${escapeHtml(id)}" class="v6-tree-toggle" data-action="toggle-tree-node"
      data-node-id="${escapeHtml(nodeKey)}" aria-expanded="${folded ? 'false' : 'true'}"
      aria-label="${folded ? 'Expand' : 'Collapse'} ${escapeHtml(name)}">${folded ? '▸' : '▾'}</button>`;
  }

  /**
   * The collapsible Logical Project -> Fleet -> Member sidebar (#2981
   * deliverable 2). Plain nested lists with real `<a href="#...">` links —
   * deliberately NOT `role="tree"`/`role="treeitem"` (WAI-ARIA's tree
   * pattern demands roving-tabindex arrow-key management; using the role
   * without that behavior is a worse accessibility bug than not using it),
   * so keyboard reachability comes from the browser's own native tab
   * order rather than a half-built custom interaction model.
   *
   * Every project and fleet with something under it carries a fold toggle
   * (#3046); a folded node's children are not rendered. Toggle ids are
   * positional (`v6TreeToggle-p<i>`, `v6TreeToggle-f<i>-<j>`) because node
   * ids are free text and an element id must not be; the real node key rides
   * on `data-node-id`.
   * @param {ReturnType<typeof buildHierarchyTree>} tree
   * @param {{activeProjectId?: string, activeFleetId?: string, activeResourceId?: string,
   *   collapsed?: Array<string>|Set<string>, memberInfo?: (seatId: string) => object|null}} [opts] -
   *   `memberInfo` gives a member's status indicators (#3053), or null to draw it plain.
   * @returns {string} HTML.
   */
  function sidebarMarkup(tree, opts) {
    const options = opts || {};
    const activeProjectId = options.activeProjectId != null ? String(options.activeProjectId) : null;
    const activeFleetId = options.activeFleetId != null ? String(options.activeFleetId) : null;
    const activeResourceId = options.activeResourceId != null ? String(options.activeResourceId) : null;
    const collapsed = new Set(options.collapsed || []);
    const list = Array.isArray(tree) ? tree : [];
    const items = list.map((project, pi) => {
      const projectActive = activeProjectId === String(project.id);
      const projectHash = routeHash({ view: 'project', projectId: project.id });
      const projectFolded = collapsed.has(projectNodeKey(project));
      const fleetItems = projectFolded ? '' : project.fleets.map((fleet, fi) => {
        const fleetActive = projectActive && activeFleetId === String(fleet.id);
        const fleetHash = routeHash({ view: 'fleet', projectId: project.id, fleetId: fleet.id });
        const fleetFolded = collapsed.has(fleetNodeKey(project, fleet));
        // #3022: a member with a seat id is a real resource — link it to its
        // B2 Conversation View; one without stays plain text.
        const memberItems = fleetFolded ? '' : fleet.members.map((m, mi) => {
          const label = `${escapeHtml(m.role)} (${escapeHtml(m.seatId)})`;
          if (!m.seatId) return `<li class="v6-shell-member">${label}</li>`;
          const memberActive = activeResourceId === String(m.seatId);
          const memberHash = routeHash({ view: 'conversation', resourceId: m.seatId });
          // #3053 item 4: the member's status, when its project row is known.
          const info = typeof options.memberInfo === 'function' ? options.memberInfo(m.seatId) : null;
          const stateClass = info ? ` is-${info.state}` : '';
          const title = info ? ` title="${escapeHtml(info.title)}"` : '';
          const glyph = info ? `<span class="v6-member-glyph" aria-hidden="true">${info.glyph}</span>` : '';
          return `<li class="v6-shell-member"><a class="v6-shell-member-link${stateClass}${memberActive ? ' is-active' : ''}"
            aria-current="${memberActive ? 'page' : 'false'}" id="v6TreeLink-m${pi}-${fi}-${mi}"${title}
            href="${escapeHtml(memberHash)}" data-route="${escapeHtml(memberHash)}">${glyph}${label}</a>${info ? memberIndicatorsMarkup(info) : ''}</li>`;
        }).join('');
        const fleetToggle = fleet.members.length
          ? treeToggleMarkup(`v6TreeToggle-f${pi}-${fi}`, fleetNodeKey(project, fleet), fleet.displayName, fleetFolded)
          : '';
        return `<li>
          <div class="v6-tree-row">${fleetToggle}<a class="v6-shell-fleet${fleetActive ? ' is-active' : ''}" id="v6TreeLink-f${pi}-${fi}"
             aria-current="${fleetActive ? 'page' : 'false'}"
             href="${escapeHtml(fleetHash)}" data-route="${escapeHtml(fleetHash)}">${escapeHtml(fleet.displayName)}</a></div>
          ${memberItems ? `<ul class="v6-shell-members">${memberItems}</ul>` : ''}
        </li>`;
      }).join('');
      const projectToggle = project.fleets.length
        ? treeToggleMarkup(`v6TreeToggle-p${pi}`, projectNodeKey(project), project.displayName, projectFolded)
        : '';
      return `<li>
        <div class="v6-tree-row">${projectToggle}<a class="v6-shell-project${projectActive ? ' is-active' : ''}" id="v6TreeLink-p${pi}"
           aria-current="${projectActive ? 'page' : 'false'}"
           href="${escapeHtml(projectHash)}" data-route="${escapeHtml(projectHash)}">${escapeHtml(project.displayName)}</a></div>
        ${fleetItems ? `<ul class="v6-shell-fleets">${fleetItems}</ul>` : ''}
      </li>`;
    }).join('');
    return `<ul class="v6-shell-tree">${items}</ul>`;
  }


  /**
   * A JSON view of a `localStorage`-like store that never throws: a store
   * that is missing, blocked or full, or a value that is not valid JSON of
   * the expected kind, reads as the fallback, and a write it cannot keep
   * still holds for this page. The shell's remembered layout is a
   * convenience; losing it must never break the page.
   * @param {{getItem: Function, setItem: Function}|null} storage
   * @returns {{get: (key: string, fallback: *, accept: (value: *) => boolean) => *, set: (key: string, value: *) => void}}
   */
  function makePrefs(storage) {
    // This page's own writes, so a setting still holds for the visit when
    // the store cannot keep it.
    const memory = new Map();
    return {
      get(key, fallback, accept) {
        if (memory.has(key)) return memory.get(key);
        let value;
        try {
          const raw = storage ? storage.getItem(key) : null;
          if (raw == null) return fallback;
          value = JSON.parse(raw);
        } catch { // prawduct:allow prawduct/broad-except -- a blocked store (SecurityError) or corrupt JSON (SyntaxError) both mean "nothing remembered"
          return fallback;
        }
        return accept(value) ? value : fallback;
      },
      set(key, value) {
        memory.set(key, value);
        try {
          if (storage) storage.setItem(key, JSON.stringify(value));
        } catch { // prawduct:allow prawduct/broad-except -- a blocked or full store (SecurityError, QuotaExceededError): the setting lasts this page only
          /* not persisted */
        }
      }
    };
  }

  /**
   * The page's own `localStorage`, or null where reading it throws (some
   * browsers do, with storage blocked).
   * @param {object|null} win
   * @returns {object|null}
   */
  function defaultStorage(win) {
    try {
      return (win && win.localStorage) || null;
    } catch { // prawduct:allow prawduct/broad-except -- reading window.localStorage throws SecurityError when storage is blocked
      return null;
    }
  }

  /**
   * The sidebar tree as the operator's filters leave it (#3046). Text
   * matching a project or fleet name keeps all of its members; otherwise it
   * keeps the members whose name matches. An engine keeps the members whose
   * project row runs it (a member with no row cannot be shown to run it). A
   * non-empty group set keeps only those logical projects. A fleet or
   * project left with no members is dropped. Pure.
   * @param {ReturnType<typeof buildHierarchyTree>} tree
   * @param {{text?: string, engine?: string, groups?: Iterable<string>}} filters
   * @param {Map<string, {engine?: {id?: string}|null}>} projectsById - Project rows keyed by id.
   * @returns {ReturnType<typeof buildHierarchyTree>}
   */
  function filterTree(tree, filters, projectsById) {
    const f = filters || {};
    const text = typeof f.text === 'string' ? f.text.trim().toLowerCase() : '';
    const engine = typeof f.engine === 'string' ? f.engine : '';
    const groups = new Set(f.groups || []);
    const rows = projectsById && typeof projectsById.get === 'function' ? projectsById : new Map();
    const has = (value) => String(value || '').toLowerCase().includes(text);
    const runsEngine = (m) => {
      const row = rows.get(String(m.seatId));
      return Boolean(row && row.engine && row.engine.id === engine);
    };
    return (Array.isArray(tree) ? tree : [])
      .filter((project) => !groups.size || groups.has(String(project.id)))
      .map((project) => {
        const projectHit = !text || has(project.displayName);
        const fleets = project.fleets.map((fleet) => {
          const fleetHit = projectHit || has(fleet.displayName);
          const members = fleet.members.filter((m) => (fleetHit || has(m.role)) && (!engine || runsEngine(m)));
          return Object.assign({}, fleet, { members });
        }).filter((fleet) => fleet.members.length);
        return Object.assign({}, project, { fleets });
      })
      .filter((project) => project.fleets.length);
  }

  /** The workspace modes (#3086): the main view's tabs, in order. */
  const WORKSPACE_MODES = Object.freeze([
    Object.freeze({ key: 'chat', glyph: '💬', label: 'Chat' }),
    Object.freeze({ key: 'sprint', glyph: '📋', label: 'Sprint & Cars' }),
    Object.freeze({ key: 'charter', glyph: '🧭', label: 'Charter & Roadmap' }),
    Object.freeze({ key: 'kaizen', glyph: '📈', label: 'Kaizen & Reports' }),
    Object.freeze({ key: 'wizard', glyph: '🧙', label: 'Wizard' })
  ]);

  /** @param {*} v @returns {boolean} Whether `v` names a workspace mode. */
  function isWorkspaceMode(v) {
    return typeof v === 'string' && WORKSPACE_MODES.some((m) => m.key === v);
  }

  /**
   * Which parts of the main view a workspace mode shows (#3086). Chat shows
   * the detail, with the template wizard and attestation below it outside a
   * conversation (#3053); Wizard shows those two even in a conversation; the
   * other modes show their panel. Nothing is removed, only hidden, so a chat's
   * draft and scroll survive a trip to another mode.
   * @param {string} mode
   * @param {boolean} inChat - Whether the detail is a conversation.
   * @returns {{detail: boolean, wizard: boolean, attestation: boolean, panel: boolean}}
   */
  function workspaceVisibility(mode, inChat) {
    if (mode === 'wizard') return { detail: false, wizard: true, attestation: true, panel: false };
    if (mode === 'chat' || !isWorkspaceMode(mode)) return { detail: true, wizard: !inChat, attestation: !inChat, panel: false };
    return { detail: false, wizard: false, attestation: false, panel: true };
  }

  /** @param {string} mode @returns {string} The id of the region a mode's tab controls. */
  function workspaceRegionId(mode) {
    if (mode === 'wizard') return 'v6ShellWizard';
    if (mode === 'chat' || !isWorkspaceMode(mode)) return 'v6ShellDetail';
    return 'v6WorkspacePanel';
  }

  /**
   * The workspace mode bar at the top of the main view (#3086): one tab per
   * mode, the chosen one selected and the only one in the tab order (arrow
   * keys move between them), and the always-visible wizard launcher.
   * @param {string} mode
   * @returns {string} HTML.
   */
  function workspaceModeBarMarkup(mode) {
    const chosen = isWorkspaceMode(mode) ? mode : 'chat';
    const tabs = WORKSPACE_MODES.map((m) => {
      const on = m.key === chosen;
      return `<button type="button" role="tab" id="v6WorkspaceMode-${m.key}" class="v6-workspace-mode${on ? ' is-active' : ''}"
        data-workspace-mode="${m.key}" aria-selected="${on ? 'true' : 'false'}" aria-controls="${workspaceRegionId(m.key)}"
        tabindex="${on ? '0' : '-1'}"><span aria-hidden="true">${m.glyph}</span> ${escapeHtml(m.label)}</button>`;
    }).join('');
    return `<div class="v6-workspace-bar">
      <div id="v6WorkspaceModeBar" class="v6-workspace-mode-bar" role="tablist" aria-label="Workspace">${tabs}</div>
      <button type="button" id="v6ShellWizardOpenTop" class="btn btn-secondary btn-small v6-wizard-open v6-wizard-open--top"
        data-workspace-mode="wizard" title="New project or fleet: open the wizard"
        aria-label="New project or fleet: open the wizard"><span aria-hidden="true">＋</span> New</button>
    </div>`;
  }

  /**
   * A data mode's panel (#3086). Its content is filled by the panel loader;
   * until then it names the mode and says nothing is loaded.
   * @param {string} mode
   * @returns {string} HTML.
   */
  function workspacePanelMarkup(mode) {
    const m = WORKSPACE_MODES.find((x) => x.key === mode);
    if (!m || mode === 'chat' || mode === 'wizard') return '';
    return `<h2 class="v6-workspace-panel-title">${escapeHtml(m.label)}</h2>
      <p class="v6-workspace-empty">Nothing loaded yet.</p>`;
  }

  /**
   * The sidebar's four-icon toolbar (#3068): hide the sidebar, the fleet view
   * (the only mode today, so always pressed), the search toggle, and chat
   * history and recents (#3066). Symbols only: each is named by its title
   * and aria-label.
   * @param {boolean} searchOpen - Whether the search and engine filters show.
   * @param {boolean} [historyOpen] - Whether the history panel shows (#3066).
   * @returns {string} HTML.
   */
  function sidebarIconBarMarkup(searchOpen, historyOpen) {
    historyOpen = Boolean(historyOpen);
    const icon = (id, label, glyph, extra) => `<button type="button" id="${id}" class="btn btn-secondary btn-small v6-sidebar-icon${extra.cls || ''}"${extra.attrs || ''}
      title="${label}" aria-label="${label}"><span aria-hidden="true">${glyph}</span></button>`;
    return `<div class="v6-sidebar-header v6-sidebar-iconbar" role="toolbar" aria-label="Fleet sidebar tools">
      ${icon('v6SidebarCollapse', 'Hide Fleet sidebar', '«', { cls: ' v6-sidebar-collapse', attrs: ' data-action="toggle-sidebar-drawer" aria-controls="v6ShellSidebar" aria-expanded="true"' })}
      ${icon('v6SidebarModeFleet', 'Fleet view', '❖', { attrs: ' aria-pressed="true"' })}
      ${icon('v6SidebarSearchToggle', searchOpen ? 'Hide search and engine filter' : 'Search projects and filter by engine', '🔍',
        { attrs: ` aria-controls="v6SidebarSearch" aria-expanded="${searchOpen}" aria-pressed="${searchOpen}"` })}
      ${icon('v6SidebarFutureSlot', historyOpen ? 'Hide chat history and recents' : 'Chat history and recents', '🕓',
        { attrs: ` aria-controls="v6HistoryPanel" aria-expanded="${historyOpen}" aria-pressed="${historyOpen}"` })}
    </div>`;
  }

  /**
   * The sidebar's chat history and recents panel (#3066). Searches this
   * chat's member or its whole fleet (one search per member, merged), lists
   * recent sessions when no query is set, and shows one past session read-only
   * with a button that puts a reference to it in the chat's message. Every
   * value from the server is escaped.
   * @param {{form: {scope: string, kind: string, q: string}, chatOpen: boolean, data: object|null}} view
   * @returns {string} HTML.
   */
  function historyPanelMarkup(view) {
    const form = view.form;
    const data = view.data || {};
    if (!view.chatOpen) {
      return `<section id="v6HistoryPanel" class="v6-history" aria-label="Chat history and recents">
        <p class="v6-history-status" role="status">Open a chat to see its history.</p>
      </section>`;
    }
    const member = String(data.member || '');
    const fleet = data.fleet || { name: '', count: 1 };
    const option = (value, label, on) => `<option value="${value}"${on ? ' selected' : ''}>${label}</option>`;
    const status = data.status === 'loading' ? 'Loading…'
      : data.status === 'error' ? `Could not load history: ${escapeHtml(data.error || 'the server refused it')}`
        : data.status === 'ready' ? historyCountLine(data) : '';
    const items = Array.isArray(data.items) ? data.items : [];
    const list = items.map((it, i) => {
      const hits = (Array.isArray(it.hits) ? it.hits : []).slice(0, 2).map((h) => (
        `<span class="v6-history-hit"><span class="v6-history-hit-loc">${escapeHtml(h.loc)}</span> ${escapeHtml(h.line)}</span>`
      )).join('');
      const count = it.matchCount ? ` · ${escapeHtml(it.matchCount)} hit${it.matchCount === 1 ? '' : 's'}` : '';
      const secret = it.secretsFlagged ? ' <span class="v6-history-secret" title="Transcript flagged for possible secrets">⚠ secrets</span>' : '';
      return `<li class="v6-history-row"><button type="button" id="v6HistoryItem-${i}" class="v6-history-item">
          <span class="v6-history-who">${escapeHtml(it.member)}</span> session #${escapeHtml(it.sid)}
          <span class="v6-history-date">${escapeHtml(it.date || 'undated')}${count}${secret}</span></button>${hits}</li>`;
    }).join('');
    const notes = (Array.isArray(data.notes) ? data.notes : []).map((n) => `<p class="v6-history-note">${escapeHtml(n)}</p>`).join('');
    return `<section id="v6HistoryPanel" class="v6-history" aria-label="Chat history and recents">
      <form id="v6HistoryForm" class="v6-history-form" role="search" aria-label="Search chat history">
        <label class="sr-only" for="v6HistoryScope">Search in</label>
        <select id="v6HistoryScope" class="filter-input">${option('member', escapeHtml(member || 'This member'), form.scope !== 'fleet')}${
          option('fleet', `Whole fleet${fleet.name ? ` (${escapeHtml(fleet.name)})` : ''} · ${escapeHtml(fleet.count)}`, form.scope === 'fleet')}</select>
        <label class="sr-only" for="v6HistoryKind">Search</label>
        <select id="v6HistoryKind" class="filter-input">${option('summaries', 'Summaries', form.kind !== 'transcripts')}${option('transcripts', 'Transcripts', form.kind === 'transcripts')}</select>
        <input type="search" id="v6HistorySearch" class="filter-input" placeholder="Search history…" aria-label="Search chat history"
          autocomplete="off" spellcheck="false" value="${escapeHtml(form.q)}">
        <button type="submit" id="v6HistorySearchBtn" class="btn btn-secondary btn-small">Search</button>
      </form>
      <p class="v6-history-status" role="status">${status}</p>${notes}
      ${items.length ? `<ol id="v6HistoryResults" class="v6-history-results">${list}</ol>` : ''}
      ${data.snapshot ? historySnapshotMarkup(data.snapshot) : ''}
    </section>`;
  }

  /**
   * @param {{mode: string, items: Array<object>, q?: string, scopeLabel?: string}} data
   * @returns {string} HTML-safe text: how many recent sessions or matches are shown.
   */
  function historyCountLine(data) {
    const n = Array.isArray(data.items) ? data.items.length : 0;
    if (data.mode === 'search') {
      return n ? `${n} session${n === 1 ? '' : 's'} match “${escapeHtml(data.q || '')}”` : `No sessions match “${escapeHtml(data.q || '')}”.`;
    }
    return n ? `${n} recent session${n === 1 ? '' : 's'}, newest first` : 'No saved sessions yet.';
  }

  /**
   * One past session, read-only (#3066): its wrap summary, any transcript
   * excerpts for the query, and the reference button.
   * @param {{member: string, sid: string, date?: string, sections: Array<{name: string, body: string}>,
   *   excerpts: Array<{loc: string, snippet: string}>, note?: string, error?: string}} snap
   * @returns {string} HTML.
   */
  function historySnapshotMarkup(snap) {
    const sections = (Array.isArray(snap.sections) ? snap.sections : []).map((sec) => (
      `<div class="v6-history-section"><strong>${escapeHtml(sec.name)}</strong><div>${escapeHtml(sec.body)}</div></div>`
    )).join('') || '<p class="v6-history-note">No wrap summary for this session.</p>';
    const excerpts = (Array.isArray(snap.excerpts) ? snap.excerpts : []).map((e) => (
      `<div class="v6-history-hit"><span class="v6-history-hit-loc">${escapeHtml(e.loc)}</span> ${escapeHtml(e.snippet)}</div>`
    )).join('');
    return `<div id="v6HistorySnapshot" class="v6-history-snapshot" role="region" aria-label="${escapeHtml(`${snap.member} session ${snap.sid}`)}">
      <div class="v6-history-snapshot-head"><strong>${escapeHtml(snap.member)} · session #${escapeHtml(snap.sid)}</strong>
        <span class="v6-history-date">${escapeHtml(snap.date || '')}</span></div>
      ${snap.error ? `<p class="v6-history-note">${escapeHtml(snap.error)}</p>` : sections}
      ${snap.secretsFlagged ? `<p class="v6-history-secret" role="note">⚠ This transcript was flagged for possible secrets (${escapeHtml((snap.secretTypes || []).join(', ') || 'pattern types only')}). Its lines are shown here but are never copied into a chat.</p>` : ''}
      ${excerpts ? `<div class="v6-history-excerpts">${excerpts}</div>` : ''}${snap.note ? `<p class="v6-history-note">${escapeHtml(snap.note)}</p>` : ''}
      <div class="v6-history-actions">
        <button type="button" id="v6HistoryReference" class="btn btn-primary btn-small"
          title="Put a reference to this session in the message" aria-label="Reference ${escapeHtml(snap.member)} session ${escapeHtml(snap.sid)} in chat">Reference in chat</button>
        <button type="button" id="v6HistorySnapshotClose" class="btn btn-secondary btn-small">Close</button>
      </div>
    </div>`;
  }

  /**
   * The text Reference in chat adds to a message (#3066): which member and
   * session, and a short piece of what it said (from the wrap summary when
   * the transcript was flagged for possible secrets).
   * @param {object} snap - A snapshot as {@link historySnapshotMarkup} takes.
   * @returns {string}
   */
  function historyReferenceText(snap) {
    // A transcript flagged for possible secrets is never quoted into a chat:
    // its reference falls back to the wrap summary.
    const first = (!snap.secretsFlagged && Array.isArray(snap.excerpts) && snap.excerpts[0] && snap.excerpts[0].snippet)
      || ((Array.isArray(snap.sections) ? snap.sections : []).map((sec) => String(sec.body || '').split('\n').find((l) => l.trim())).find(Boolean))
      || '';
    const snippet = String(first).replace(/\s+/g, ' ').trim();
    const head = `[${snap.member} session #${snap.sid}${snap.date ? ` · ${snap.date}` : ''}]`;
    return snippet ? `${head} ${snippet.length > 200 ? `${snippet.slice(0, 199)}…` : snippet}` : head;
  }

  /**
   * The sidebar's filters (#3068, replacing #3046's pills and Multi toggle):
   * a fleet picker, always shown in the fleet view, and the search box and
   * engine select, shown only while the search toggle is open. A selection
   * of several fleets (the old Multi mode, or the additive API) shows as
   * such rather than as "All Fleets", and so does one that names a fleet no
   * longer there.
   * @param {{tree: ReturnType<typeof buildHierarchyTree>, engines: string[], text: string,
   *   engine: string, groups: Set<string>, searchOpen: boolean}} view
   * @returns {string} HTML.
   */
  function filterControlsMarkup(view) {
    const engineOptions = ['<option value="">All Engines</option>'].concat(view.engines.map((id) => (
      `<option value="${escapeHtml(id)}"${id === view.engine ? ' selected' : ''}>${escapeHtml(id)}</option>`
    ))).join('');
    // Only fleets still in the tree count: a remembered fleet that is gone
    // (or not loaded yet) must not leave "All Fleets" looking selected over
    // an empty tree, where choosing it would change nothing.
    const known = [...view.groups].filter((id) => view.tree.some((p) => String(p.id) === id));
    const one = known.length === 1 ? known[0] : null;
    let placeholder = '';
    if (view.groups.size && !one) {
      placeholder = known.length > 1 ? `Several fleets (${known.length})`
        : (view.tree.length ? 'Fleet not found' : 'Loading fleets…');
    }
    const fleetOptions = [`<option value=""${view.groups.size ? '' : ' selected'}>All Fleets</option>`]
      .concat(placeholder ? [`<option value="" disabled selected>${placeholder}</option>`] : [])
      .concat(view.tree.map((project) => (
        `<option value="${escapeHtml(project.id)}"${String(project.id) === one ? ' selected' : ''}>${escapeHtml(project.displayName)}</option>`
      ))).join('');
    return `<label class="v6-fleet-picker"><span class="sr-only">Fleet</span>
        <select id="v6FilterFleet" class="filter-input v6-filter-fleet" aria-label="Show fleet" title="Show one fleet, or all of them">${fleetOptions}</select>
      </label>
      <div id="v6SidebarSearch" class="v6-sidebar-filters" role="search" aria-label="Filter the fleet tree"${view.searchOpen ? '' : ' hidden'}>
        <input type="search" id="v6FilterSearch" class="filter-input v6-filter-search" placeholder="Filter…"
          aria-label="Filter projects by name" autocomplete="off" spellcheck="false" value="${escapeHtml(view.text)}">
        <select id="v6FilterEngine" class="filter-input v6-filter-engine" aria-label="Filter by engine">${engineOptions}</select>
      </div>`;
  }

  /**
   * Whether a scroll container is showing its last line (within a few
   * pixels). A container that cannot report its geometry is not.
   * @param {object|null} el
   * @returns {boolean}
   */
  function isAtBottom(el) {
    return Boolean(el) && typeof el.scrollHeight === 'number'
      && el.scrollHeight - (el.scrollTop || 0) - (el.clientHeight || 0) < 8;
  }

  /** @param {object|null} el - Scroll it to its last line. */
  function pinToBottom(el) {
    if (el && typeof el.scrollHeight === 'number') el.scrollTop = el.scrollHeight;
  }

  const isBoolean = (v) => typeof v === 'boolean';
  const isStringMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).every((k) => typeof v[k] === 'string');

  /** How often an open chat re-reads its session's live output (#3047). */
  const CHAT_POLL_MS = 4000;

  /**
   * The start of the server's refusal for a rename that would orphan engine
   * state (`lib/workspace-rename-check.js#renameWarningFor`, #2864); it
   * carries no code of its own, and the text is pinned by that module's tests.
   */
  const ORPHAN_RISK_WARNING = /^WARNING: renaming ".*" to ".*" will orphan /;

  /** The most sessions the history panel lists at once (#3066). */
  const HISTORY_ITEM_CAP = 30;

  /** The characters a project name may use, as `lib/projects.js#PROJECT_NAME_REGEX` allows (#3071). */
  const PROJECT_NAME_CHARS = /^[a-zA-Z0-9 _-]+$/;

  /** Chat reads between refreshes of the usage meter (#3085): about a minute at the chat's read rate. */
  const USAGE_EVERY_POLLS = 15;

  /** Reads of a just-sent chat that may show no engine activity before it stops reading as Working (#3057). */
  const AWAIT_REPLY_POLLS = 3;
  const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

  /**
   * Which switchboard-triggered replies the chat shows (#3082), by kind; the
   * rest are tucked Under the Hood. Direct chat and questions always show.
   */
  const VERBOSITY_DEFAULT = Object.freeze({ blockers: true, milestones: true, chatter: false });
  const isVerbosity = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && ['blockers', 'milestones', 'chatter'].every((k) => typeof v[k] === 'boolean');

  /** Every metric a B4 telemetry bar carries, in its own listed display order, mirroring `lib/v6/b4-telemetry-header.js#METRIC_KEYS`. */
  const TELEMETRY_METRIC_LABELS = Object.freeze({
    tokens: 'Tokens',
    quotaWindow: 'Quota window',
    contextUtilization: 'Context',
    activeSessions: 'Active sessions',
    health: 'Health',
    pendingMedusaMessages: 'Medusa',
    versionDrift: 'Version'
  });

  /**
   * What each telemetry metric means, for its chip's hover tip (#3063) — the
   * meaning only: whether there is a reading is said from the metric itself,
   * so a metric that gains a collector (today the server supplies only active
   * sessions, health and version, `server.js#_v6LiveTelemetryMetrics`) never
   * reads as uncollected beside its own value.
   */
  const TELEMETRY_METRIC_HELP = Object.freeze({
    tokens: 'model tokens used',
    quotaWindow: 'engine usage-quota window',
    contextUtilization: 'how full a session\'s context window is',
    activeSessions: 'live sessions on this TangleClaw server',
    health: 'server health',
    pendingMedusaMessages: 'Medusa messages waiting to be read',
    versionDrift: 'the TangleClaw version this server runs'
  });

  /**
   * The server-wide readings shown in the footer status bar, not the header
   * (#3079): they say nothing about the chat on screen.
   */
  const TELEMETRY_FOOTER_KEYS = Object.freeze(['activeSessions', 'health', 'versionDrift']);

  /**
   * One telemetry chip, the same markup wherever it is drawn, header or
   * footer (#3079).
   * @param {{metrics: Record<string, {value: *, confidence: string}>}} bar
   * @param {string} key - A {@link TELEMETRY_METRIC_LABELS} key.
   * @returns {string} HTML.
   */
  function telemetryChipMarkup(bar, key) {
    const metric = bar.metrics[key] || { value: null, confidence: 'unavailable' };
    const label = TELEMETRY_METRIC_LABELS[key];
    const valueText = metric.value == null ? '—' : escapeHtml(String(metric.value));
    // #3063: the tip says what the metric is and how sure the reading is.
    const tip = `${label}: ${metric.value == null ? 'no reading yet' : String(metric.value)} — ${TELEMETRY_METRIC_HELP[key]} (${metric.confidence})`;
    return `<span class="v6-telemetry-chip is-${escapeHtml(metric.confidence)}" title="${escapeHtml(tip)}">
        <span class="v6-telemetry-label">${escapeHtml(label)}</span>
        <span class="v6-telemetry-value">${valueText}</span>
      </span>`;
  }

  /**
   * Render a B4 telemetry bar snapshot (#2981 B4 render hook) — the exact
   * shape `lib/v6/b4-telemetry-header.js#assembleTelemetryBar` returns, so
   * a future BRIDGE-2b route can feed this directly with no reshaping.
   * The server-wide chips ({@link TELEMETRY_FOOTER_KEYS}) are drawn by the
   * footer instead (#3079), so between them every metric is still on the page.
   * @param {{scope?: string, metrics?: Record<string, {value: *, confidence: string}>}|null} bar
   * @returns {string} HTML.
   */
  function telemetryHeaderMarkup(bar) {
    if (!bar || !bar.metrics) {
      return '<div class="v6-telemetry-header is-unavailable" role="status" aria-label="Telemetry unavailable"></div>';
    }
    const chips = Object.keys(TELEMETRY_METRIC_LABELS).filter((key) => !TELEMETRY_FOOTER_KEYS.includes(key))
      .map((key) => telemetryChipMarkup(bar, key)).join('');
    return `<div class="v6-telemetry-header" role="status" aria-label="Telemetry — ${escapeHtml(bar.scope || '')}">${chips}</div>`;
  }

  /**
   * Render the C2 starter-fleet-template wizard's launcher list (#2981 C2
   * render hook) — the exact shape
   * `lib/v6/c2-fleet-templates.js#listFleetTemplates` returns. Each launch
   * button carries both a real `id` (`v6ShellWizardLaunch-<templateId>`,
   * what {@link tcCreateV6Shell} wires a per-button listener to) and a
   * `data-template-id` (for CSS/other callers); clicking one is wired by
   * {@link tcCreateV6Shell}'s caller via `opts.onLaunchTemplate` — this
   * function only renders.
   * @param {Array<{id: string, name: string, seats?: Array<*>, configurable?: boolean}>} templates
   * @returns {string} HTML.
   */
  function fleetWizardMarkup(templates) {
    const list = Array.isArray(templates) ? templates : [];
    const items = list.map((t) => {
      const seatCount = Array.isArray(t && t.seats) ? String(t.seats.length) : 'configurable';
      const id = escapeHtml(t && t.id);
      return `<li class="v6-wizard-template">
        <button type="button" id="v6ShellWizardLaunch-${id}" class="v6-wizard-launch" data-template-id="${id}">
          ${escapeHtml(t && t.name)} <span class="v6-wizard-seats">(${escapeHtml(seatCount)} seats)</span>
        </button>
      </li>`;
    }).join('');
    return `<ul class="v6-wizard-list" aria-label="Starter fleet templates">${items}</ul>`;
  }

  /**
   * Render a D1 model-attestation indicator (#2981 D1 render hook) — the
   * exact row shape `lib/v6/d1-model-attestation.js`'s table carries
   * (`requested_model`/`observed_model`/`confidence`), snake_case as read
   * from SQLite.
   * @param {{requested_model?: string|null, observed_model?: string|null, confidence?: string}|null} attestation
   * @returns {string} HTML.
   */
  function modelAttestationMarkup(attestation) {
    if (!attestation) {
      return '<span class="v6-model-attestation is-unavailable">No attestation</span>';
    }
    const confidence = attestation.confidence || 'unavailable';
    const requested = attestation.requested_model || null;
    const observed = attestation.observed_model || null;
    const label = observed || requested || 'Unknown model';
    return `<span class="v6-model-attestation is-${escapeHtml(confidence)}"
      title="requested: ${escapeHtml(requested || '—')}, observed: ${escapeHtml(observed || '—')}">${escapeHtml(label)}</span>`;
  }

  /**
   * Render the H1 watermark/attribution footer (#2981 H1 render hook) — a
   * pure function of the effective `branding.uiWatermark` boolean
   * (`lib/v6/h1-branding-policy.js#effectiveUiWatermark`'s output), never
   * reading or deciding the policy itself.
   *
   * Given a telemetry bar, the footer is also the shell's status bar
   * (#3079): Active sessions, Health and Version sit here, announced, while
   * the watermark word stays hidden from assistive tech. The status bar
   * shows whatever the branding policy says about the word.
   * @param {boolean} showWatermark
   * @param {{metrics?: object}|null} [bar] - The telemetry bar, if loaded.
   * @returns {string} HTML, or `''` with neither a watermark nor readings.
   */
  function watermarkFooterMarkup(showWatermark, bar, usage) {
    const status = bar && bar.metrics
      ? `<div id="v6ShellStatusBar" class="v6-shell-status-bar" role="status" aria-label="Server status">${TELEMETRY_FOOTER_KEYS.map((key) => telemetryChipMarkup(bar, key)).join('')}</div>`
      : '';
    // #3085: the 3-engine usage meter, in its own slot so a refresh can
    // redraw it alone.
    const meter = typeof usage === 'string' && usage ? `<div id="v6EngineUsageSlot" class="v6-usage-slot">${usage}</div>` : '';
    if (!status && !meter) return showWatermark ? '<footer class="v6-shell-watermark" aria-hidden="true">TangleClaw</footer>' : '';
    return `<footer class="v6-shell-watermark has-status">${status}${meter}${showWatermark ? '<span class="v6-shell-watermark-mark" aria-hidden="true">TangleClaw</span>' : ''}</footer>`;
  }

  /**
   * The engines the usage meter always shows (#3085, Contract A753-1), in
   * order: the key the usage routes use, the meter's short label, the name.
   */
  const USAGE_ENGINES = Object.freeze([
    { key: 'claude', label: 'Claude', name: 'Claude' },
    { key: 'codex', label: 'Codex', name: 'Codex' },
    { key: 'antigravity', label: 'AGY', name: 'Antigravity' }
  ]);

  /** @param {*} v @returns {number|null} A remaining percentage, 0–100, or null. */
  function pctOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  }

  /**
   * What the meter shows for each engine (#3085, A753-1): token totals for
   * the 5-hour, weekly and sprint windows summed across models (a missing
   * engine counts as none), its live sessions, and how much it has left —
   * the lowest a live session reports (a Codex footer's "weekly 0% left"),
   * else the operator's calibration; both are percentages REMAINING. A
   * session reading whose `source` is `provider-window` (or `none`) is the
   * calibration reported back, so it is not a live reading; one that is
   * `combined` mixes the pane with calibration and is labelled so. The
   * state follows: critical at 5% or less, warning at 25% or less, else
   * healthy (unknown when nothing reports a percentage).
   * @param {object|null} windows - `GET /api/usage/windows`.
   * @param {object|null} sessions - `GET /api/usage/sessions`.
   * @returns {{engines: Array<object>, resetHours: number|null, resetAt: string|null}}
   */
  function usageMeterModel(windows, sessions) {
    const w = windows && typeof windows === 'object' ? windows : {};
    const live = sessions && Array.isArray(sessions.sessions) ? sessions.sessions : [];
    const sum = (models, win) => Object.values(models || {}).reduce((n, m) => n + (Number(m && m[win] && m[win].totalTokens) || 0), 0);
    const engines = USAGE_ENGINES.map(({ key, label, name }) => {
      const models = w.byProviderModel && w.byProviderModel[key];
      const mine = live.filter((x) => x && (x.engine === key || x.provider === key));
      const fromPane = mine.filter((x) => x.source !== 'provider-window' && x.source !== 'none');
      const readings = (list) => list.flatMap((x) => [pctOrNull(x.weeklyRemainingPct), pctOrNull(x.fiveHourRemainingPct)]).filter((v) => v !== null);
      const seen = readings(fromPane);
      const mixed = readings(fromPane.filter((x) => x.source === 'combined')).length > 0;
      const cal = w.calibration && w.calibration[key];
      const calibrated = cal ? [pctOrNull(cal.weeklyPct), pctOrNull(cal.fiveHourPct)].filter((v) => v !== null) : [];
      const remainingPct = seen.length ? Math.min(...seen) : (calibrated.length ? Math.min(...calibrated) : null);
      const state = remainingPct === null ? 'unknown' : remainingPct <= 5 ? 'critical' : remainingPct <= 25 ? 'warning' : 'healthy';
      return {
        key, label, name, remainingPct, state,
        source: seen.length ? (mixed ? 'live and calibrated' : 'live') : (calibrated.length ? 'calibrated' : 'none'),
        sessions: mine.length,
        tokens: { fiveHour: sum(models, 'fiveHour'), weekly: sum(models, 'weekly'), sprint: sum(models, 'sprint') }
      };
    });
    const reset = w.resetSchedule || {};
    return {
      engines,
      resetHours: typeof reset.hoursUntilWeeklyReset === 'number' && Number.isFinite(reset.hoursUntilWeeklyReset) ? reset.hoursUntilWeeklyReset : null,
      resetAt: typeof reset.nextWeeklyResetAt === 'string' ? reset.nextWeeklyResetAt : null
    };
  }

  /** @param {number} n @returns {string} A token count, short: `942M`, `12.4k`, `830`. */
  function formatTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
    return String(Math.round(v));
  }

  /** @param {number|null} hours @returns {string} `Resets in 4d 11h`, or ''. */
  function formatReset(hours) {
    if (hours === null || hours < 0) return '';
    const h = Math.floor(hours);
    return h >= 24 ? `Resets in ${Math.floor(h / 24)}d ${h % 24}h` : `Resets in ${h}h ${Math.floor((hours - h) * 60)}m`;
  }

  /** The state classes a meter pill carries (#3085, A753-1). */
  const USAGE_STATE_CLASSES = Object.freeze({
    healthy: 'is-healthy is-green', unknown: 'is-healthy is-green is-unknown', warning: 'is-warning is-amber', critical: 'is-critical is-red'
  });

  /**
   * The usage meter (#3085, A753-1): one pill per engine, coloured by what
   * it has left, opening a breakdown with one-click calibration.
   * @param {ReturnType<typeof usageMeterModel>} model
   * @param {{open?: boolean, status?: {kind: string, message: string}|null}} [ui]
   * @returns {string} HTML.
   */
  function usageMeterMarkup(model, ui) {
    const open = Boolean(ui && ui.open);
    const status = ui && ui.status ? ui.status : null;
    const reset = formatReset(model.resetHours);
    const pill = (e) => {
      const left = e.remainingPct === null ? null : Math.round(e.remainingPct);
      const reading = left === null ? `${formatTokens(e.tokens.weekly)} this week` : `${left}% left`;
      const tip = `${e.name}: ${left === null ? 'no % left reported' : `${left}% left (${e.source})`} · ${formatTokens(e.tokens.fiveHour)} tokens in 5h, ${formatTokens(e.tokens.weekly)} this week${reset ? ` · ${reset}` : ''}`;
      return `<span class="v6-usage-pill ${USAGE_STATE_CLASSES[e.state]}" data-engine="${e.key}" title="${escapeHtml(tip)}">`
        + `<span class="v6-usage-label">${e.label}</span>`
        + `<span class="v6-usage-bar" aria-hidden="true"><span class="v6-usage-fill" style="width: ${left === null ? 0 : left}%"></span></span>`
        + `<span class="v6-usage-value">${escapeHtml(reading)}</span></span>`;
    };
    const summary = model.engines.map((e) => `${e.name} ${e.remainingPct === null ? 'no reading' : `${Math.round(e.remainingPct)}% left`}`).join(', ');
    const row = (e) => `<tr data-engine="${e.key}"><th scope="row">${e.name}</th>`
      + `<td>${formatTokens(e.tokens.fiveHour)}</td><td>${formatTokens(e.tokens.weekly)}</td><td>${formatTokens(e.tokens.sprint)}</td><td>${e.sessions}</td>`
      + `<td>${e.remainingPct === null ? '—' : `${Math.round(e.remainingPct)}%`}</td>`
      + `<td><span class="v6-usage-calibrate"><label><span class="sr-only">${e.name} weekly % left</span><input type="number" min="0" max="100" step="1" id="v6UsageWeekly-${e.key}" class="filter-input v6-usage-input" placeholder="wk %"></label>`
      + `<label><span class="sr-only">${e.name} 5-hour % left</span><input type="number" min="0" max="100" step="1" id="v6UsageFiveHour-${e.key}" class="filter-input v6-usage-input" placeholder="5h %"></label>`
      + `<button type="button" id="v6UsageSave-${e.key}" class="btn btn-secondary btn-small" data-engine="${e.key}">Set</button></span></td></tr>`;
    return `<button type="button" id="v6EngineUsageMeter" class="v6-usage-meter" aria-expanded="${open ? 'true' : 'false'}" aria-controls="v6EngineUsagePopover"
        aria-label="${escapeHtml(`Engine usage: ${summary}. Open the breakdown.`)}">${model.engines.map(pill).join('')}</button>`
      + `<div id="v6EngineUsagePopover" class="v6-usage-popover" role="dialog" aria-label="Engine usage"${open ? '' : ' hidden'}>`
      + `<p class="v6-usage-reset">${escapeHtml(reset || 'Weekly reset time unknown')}</p>`
      + `<table class="v6-usage-table"><thead><tr><th scope="col">Engine</th><th scope="col">5h</th><th scope="col">Week</th><th scope="col">Sprint</th><th scope="col">Sessions</th><th scope="col">Left</th><th scope="col">Set % left</th></tr></thead>`
      + `<tbody>${model.engines.map(row).join('')}</tbody></table>`
      + `<p id="v6EngineUsageStatus" class="v6-usage-status${status ? ` is-${escapeHtml(status.kind)}` : ''}" role="status">${status ? escapeHtml(status.message) : ''}</p></div>`;
  }

  /**
   * Render a C2 fleet plan summary (#3022 deliverable d) — the shape
   * `POST /api/v6/fleet-templates/:templateId/plan` returns: which seats a
   * launch would start now and which it would leave deferred.
   * @param {{templateId?: string, immediateSeats?: Array<{role?: string, seatId?: string}>,
   *   deferredSeats?: Array<{role?: string, seatId?: string}>}|null} plan
   * @returns {string} HTML.
   */
  function fleetPlanMarkup(plan) {
    if (!plan) return '';
    const seatList = (seats) => {
      const list = Array.isArray(seats) ? seats : [];
      if (!list.length) return '<p class="v6-plan-empty">None</p>';
      return `<ul class="v6-plan-seats">${list.map((s) => (
        `<li>${escapeHtml(s && s.role)} <span class="v6-plan-seat-id">(${escapeHtml(s && s.seatId)})</span></li>`
      )).join('')}</ul>`;
    };
    const immediate = Array.isArray(plan.immediateSeats) ? plan.immediateSeats.length : 0;
    const deferred = Array.isArray(plan.deferredSeats) ? plan.deferredSeats.length : 0;
    return `<section class="v6-plan" aria-label="Fleet plan preview">
      <h2 class="v6-detail-title">Plan preview — ${escapeHtml(plan.templateId)}</h2>
      <p class="v6-plan-summary">${immediate} seat(s) start immediately, ${deferred} deferred until needed.</p>
      <h3>Immediate</h3>${seatList(plan.immediateSeats)}
      <h3>Deferred</h3>${seatList(plan.deferredSeats)}
    </section>`;
  }

  /**
   * The chat target's rename control (#3071): a pencil that opens an inline
   * form. A project with a live session cannot be renamed (the server refuses,
   * and a rename moves its directory), so the pencil is disabled and says why.
   * @param {string} name - The project's current name.
   * @param {boolean} liveSession - Whether it has a session (active or idle).
   * @param {{open?: boolean, draft?: string|null, warning?: string|null}} [rename] - The form's state:
   *   open, the text typed so far (kept across a refusal), and the server's
   *   orphan-risk warning when it asked for confirmation.
   * @returns {string} HTML.
   */
  function chatRenameMarkup(name, liveSession, rename) {
    const n = escapeHtml(name);
    const r = rename || {};
    if (r.open && !liveSession) {
      const value = escapeHtml(r.draft != null ? r.draft : name);
      const confirm = r.warning
        ? `<p id="v6ChatRenameWarning" class="v6-chat-rename-warning" role="alert">${escapeHtml(r.warning)}</p>
          <button type="button" id="v6ChatRenameConfirm" class="btn btn-primary btn-small"
            title="Rename even though the old folder's engine state stays behind">Rename anyway</button>`
        : '';
      return `<form id="v6ChatRenameForm" class="v6-chat-rename" data-action="rename-project-form" aria-label="Rename ${n}">
          <label class="sr-only" for="v6ChatRenameInput">New name for ${n}</label>
          <input id="v6ChatRenameInput" class="filter-input v6-chat-rename-input" name="name" value="${value}"
            maxlength="64" autocomplete="off" spellcheck="false" title="Letters, digits, spaces, dashes and underscores">
          <button type="submit" id="v6ChatRenameSave" class="btn btn-primary btn-small">Save</button>
          <button type="button" id="v6ChatRenameCancel" class="btn btn-secondary btn-small">Cancel</button>
          ${confirm}
        </form>`;
    }
    const label = liveSession ? `Stop ${name}'s session to rename it` : `Rename ${name}`;
    return `<button type="button" id="v6ChatRename" class="btn btn-secondary btn-small v6-chat-icon-btn"
        title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${liveSession ? ' disabled' : ''}><span aria-hidden="true">✎</span></button>`;
  }

  /**
   * Render the B2 Conversation View for one legacy project (#3022
   * deliverable e): its replayed conversation events and an ADR 0026
   * "Open Hood" link to the live terminal page. With no live session it
   * says so instead of rendering an empty stream that reads as "no
   * messages yet".
   * @param {{project: {id?: *, name?: string}|null, sessionId?: number|null,
   *   events?: Array<{seq?: number, role?: string, content?: string, redacted?: number}>|null,
   *   error?: string|null, chat?: object}} view - `chat.sidebarCollapsed` adds a Show Fleet
   *   button and `chat.activityElapsed` is the busy line's time (#3057); `chat.telemetry`, when
   *   given (null included), is the telemetry bar drawn inside the header row (#3063).
   * @returns {string} HTML.
   */
  function conversationViewMarkup(view) {
    const v = view || {};
    if (!v.project) {
      return `<section class="v6-conversation" aria-label="Conversation">
        <p class="v6-conversation-empty">${escapeHtml(v.error || 'No project matches this resource.')}</p>
      </section>`;
    }
    const name = String(v.project.name || '');
    // #3073: the server serves the terminal page at /session/<name>; the
    // ?project= form resolved to the name "session.html" and never loaded.
    const hoodHref = `/session/${encodeURIComponent(name)}`;
    const chat = v.chat || {};
    const status = CHAT_STATUS_LABELS[chat.status] ? chat.status : (v.sessionId == null ? 'offline' : 'active');
    const liveSession = status !== 'offline';
    const live = chat.live || null;
    const liveTurns = live && Array.isArray(live.turns) ? live.turns : [];
    let stream;
    let tail = '';
    if (v.error) {
      stream = `<p class="v6-conversation-empty">${escapeHtml(v.error)}</p>`;
    } else if (v.sessionId == null) {
      stream = '<p class="v6-conversation-empty">No live session — nothing to replay.</p>';
    } else {
      // #3076: a recorded switchboard wake is not the operator speaking; it
      // is shown Under the Hood with the rest of the switchboard's traffic.
      // #3079 item 6: what the pane shows is drawn once, in its place
      // among the replies; what was recorded before it comes above, and
      // what was recorded after it (sent, not yet on screen) below.
      const parts = arrangeRecorded(v.events, liveTurns, chat.lastSent);
      stream = parts.head.length
        ? `<ol class="v6-conversation-stream" id="v6ChatRecorded">${recordedEventsMarkup(parts.head, name, chat.thumbs)}</ol>`
        : (liveTurns.length || parts.tail.length ? '<ol class="v6-conversation-stream" id="v6ChatRecorded"></ol>'
          : '<p class="v6-conversation-empty">No conversation events recorded for this session yet.</p>');
      tail = recordedEventsMarkup(parts.tail, name, chat.thumbs);
    }
    // #3052: the replies the session's live output shows, after what is
    // recorded; its own list so a poll can replace it without a re-render.
    stream = `<div id="v6ChatStream" class="v6-chat-stream" tabindex="0">${stream}
      <ol id="v6ChatLive" class="v6-conversation-stream v6-chat-live-turns" aria-label="Live replies">${liveTurnsMarkup(liveTurns, name, chat.verbosity, chat.thumbs)}</ol>
      <ol id="v6ChatRecordedTail" class="v6-conversation-stream v6-chat-recorded-tail">${tail}</ol>
      <ol id="v6ChatPending" class="v6-conversation-stream v6-chat-pending">${pendingMarkup(chat.pending, chat.lastSent, chat.thumbs)}</ol>
    </div>`;
    // A member reached directly is still the project's delegate when it is
    // the one the delegate resolution picks (#3053).
    const delegateMode = chat.mode === 'delegate'
      || Boolean(chat.delegate && String(chat.delegate.id) === String(v.project.id));
    const title = delegateMode && chat.nodeName ? chat.nodeName : name;
    const session = v.sessionId != null ? ` (#${escapeHtml(v.sessionId)})` : '';
    const members = Array.isArray(chat.members) ? chat.members : [];
    // #3079: the Fleet sidebar already switches members, so the picker is
    // hidden; it stays in the page for whatever reads it.
    const delegatePicker = delegateMode && members.length
      ? `<label class="v6-chat-delegate-label" hidden><span class="sr-only">Delegate</span>
          <select id="v6ChatDelegate" class="filter-input v6-chat-delegate" data-action="change-project-delegate"
            aria-label="Choose who this project's chat talks to" title="Choose who this project's chat talks to — Switch Designated Project Delegate">${members.map((m) => (
              `<option value="${escapeHtml(m.id)}"${String(m.id) === String(v.project.id) ? ' selected' : ''}>${escapeHtml(m.name)}</option>`
            )).join('')}</select>
        </label>`
      : '';
    const toDelegate = !delegateMode && chat.delegate && chat.nodeId != null && String(chat.delegate.id) !== String(v.project.id)
      ? `<a id="v6ChatToDelegate" class="btn btn-secondary btn-small v6-chat-to-delegate"
          href="${escapeHtml(routeHash({ view: 'project', projectId: chat.nodeId }))}"
          title="Switch to Delegate: ${escapeHtml(chat.delegate.name)}" aria-label="Switch to Delegate: ${escapeHtml(chat.delegate.name)}"><span aria-hidden="true">⇄</span> ${escapeHtml(chat.delegate.name)}</a>`
      : '';
    const send = chat.send && CHAT_SEND_KINDS.includes(chat.send.kind) ? chat.send : null;
    // Send is disabled while a send is in flight, so a second Enter cannot
    // type the same message in twice; the box itself stays open, since the
    // composer empties on Enter and Force Send (#3082, Ruling A757) exists to
    // push an urgent message in meanwhile.
    const disabled = liveSession && !(send && send.kind === 'pending') && !chat.inFlight ? '' : ' disabled';
    const boxDisabled = liveSession ? '' : ' disabled';
    // #3053: start an offline target, or every offline member of a group,
    // from the chat itself. Starting several agents asks a second time.
    const startButton = liveSession ? '' : `<button type="button" id="v6ChatStart" class="btn btn-primary btn-small v6-chat-start" data-action="start-chat-session">▶ Start ${escapeHtml(name)}</button>`;
    const offlineMembers = chat.mode === 'delegate' ? members.filter((m) => m && m.live === false).length : 0;
    const fleetLabel = chat.fleetArmed
      ? `Click again to start ${offlineMembers} session${offlineMembers === 1 ? '' : 's'}`
      : `▶ Start ${escapeHtml(chat.nodeName || name)} (${offlineMembers} offline)`;
    const startFleetButton = offlineMembers
      ? `<button type="button" id="v6ChatStartFleet" class="btn btn-secondary btn-small v6-chat-start-fleet" data-action="start-chat-fleet">${fleetLabel}</button>`
      : '';
    // #3057: with the sidebar hidden, the chat itself offers to bring it back.
    const showFleetButton = chat.sidebarCollapsed
      ? `<button type="button" id="v6ChatShowFleet" class="btn btn-secondary btn-small v6-chat-show-fleet"
          data-action="toggle-sidebar-drawer" aria-controls="v6ShellSidebar" aria-expanded="false"
          aria-label="Show Fleet sidebar" title="Restore the Fleet sidebar">» Show Fleet</button>`
      : '';
    const placeholder = `Message ${name}… (Enter to send, Shift+Enter for newline)`;
    // #3059: one compact row. The identity strip says in full, as a tooltip
    // and to a screen reader, what its short chips show; the controls are
    // icons, each named by its title and aria-label.
    const modeText = delegateMode ? 'Designated Project Delegate' : 'Direct Session';
    const identityTip = `Talking to ${name}${v.sessionId != null ? ` (#${v.sessionId})` : ''} · ${modeText} · ${CHAT_STATUS_LABELS[status]}`;
    const iconButton = (id, label, glyph) => `<button type="button" id="${id}" class="btn btn-secondary btn-small v6-chat-icon-btn" title="${label}" aria-label="${label}"><span aria-hidden="true">${glyph}</span></button>`;
    return `<section class="v6-conversation v6-chat" aria-label="Conversation — ${escapeHtml(name)}">
      <header class="v6-chat-header">
        <h2 class="v6-detail-title">${escapeHtml(title)}</h2>
        <div class="v6-chat-identity">${showFleetButton}
          <p class="v6-chat-talking-to" title="${escapeHtml(identityTip)}"><span class="sr-only">Talking to: </span><strong>${escapeHtml(name)}</strong>${session}<span class="sr-only"> · ${modeText}</span>
            <span class="v6-chat-mode" aria-hidden="true">${delegateMode ? 'Delegate' : 'Direct'}</span>
            <span class="v6-chat-pill is-${status}">${CHAT_STATUS_LABELS[status]}</span>${chatRepoBadgesMarkup(v.project)}</p>
          ${chatRenameMarkup(name, liveSession, chat.rename)}
        </div>
        ${chat.telemetry !== undefined ? telemetryHeaderMarkup(chat.telemetry) : ''}
        <div class="v6-chat-actions">
          ${liveSession ? `<span id="v6ChatMedusaSlot" class="v6-chat-medusa-slot">${medusaIndicatorMarkup(chat.medusa)}</span>` : ''}
          ${startButton}${startFleetButton}${delegatePicker}${toDelegate}
          <a class="btn btn-secondary btn-small v6-chat-icon-btn v6-open-hood" href="${escapeHtml(hoodHref)}" title="Open Hood (Live Terminal)" aria-label="Open Hood (Live Terminal)"><span aria-hidden="true">&gt;_</span></a>
          ${iconButton('v6ChatHistory', escapeHtml(`History and recents for ${name}`), '🕓')}
          ${iconButton('v6ChatRefresh', 'Refresh conversation', '↻')}
          ${iconButton('v6ChatSettings', 'Project Settings', '⚙')}
        </div>
      </header>
      ${stream}
      ${liveSession ? `<details id="v6ChatUnderHood" class="v6-chat-under-hood"${chat.hoodOpen ? ' open' : ''}>
        <summary>🔧 Under the Hood (Raw CLI &amp; Tool Activity) <span id="v6ChatTuckedCount" class="v6-chat-tucked-count">${tuckedCountText(tuckedTurns(liveTurns, chat.verbosity).length)}</span></summary>
        ${verbosityMarkup(chat.verbosity)}
        <section class="v6-chat-tucked" aria-label="Replies tucked away">
          <h3 class="v6-chat-switchboard-title">Tucked away</h3>
          <ol id="v6ChatTucked" class="v6-chat-tucked-list">${tuckedMarkup(tuckedTurns(liveTurns, chat.verbosity), chat.thumbs)}</ol>
        </section>
        <section class="v6-chat-switchboard" aria-label="Switchboard and Medusa traffic">
          <h3 class="v6-chat-switchboard-title">Switchboard &amp; Medusa traffic</h3>
          <ol id="v6ChatSwitchboard" class="v6-chat-switchboard-list" tabindex="-1">${switchboardMarkup(switchboardItems(v.events, live))}</ol>
        </section>
        <pre id="v6ChatPeek" class="v6-chat-peek" tabindex="0">${chatPeekMarkup(chat.peek)}</pre>
      </details>` : `<p class="v6-chat-offline">${escapeHtml(name)} has no live session.
        <button type="button" id="v6ChatStartBanner" class="btn btn-primary btn-small" data-action="start-chat-session">▶ Start ${escapeHtml(name)}</button>
        <a class="v6-chat-classic-launch" href="#/">Open Classic View to launch ${escapeHtml(name)}</a></p>`}
      ${chatQuestionMarkup(openQuestions(live, chat.dismissedQuestions))}
      ${chatActivityMarkup(chatBusyLabel(chat), chat.activityElapsed)}
      <form id="v6ChatForm" class="v6-chat-composer" data-action="send-chat-form" aria-label="Message ${escapeHtml(name)}">
        <div id="v6ChatAttachments" class="v6-chat-attachments" aria-live="polite">${attachmentChipsMarkup(chat.attachments)}</div>
        <textarea id="v6ChatInput" class="v6-chat-input" name="message" rows="3" aria-label="Message to ${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}"${boxDisabled}>${escapeHtml(chat.draft || '')}</textarea>
        <div class="v6-chat-composer-actions">
          <button type="button" id="v6ChatAttachBtn" class="btn btn-secondary btn-small v6-chat-attach-btn" aria-label="Attach files (or drop or paste them into the message)">📎 Attach</button>
          <input type="file" id="v6ChatFileInput" class="v6-chat-file-input" multiple hidden>
          <button type="button" id="v6ChatForceSend" class="btn btn-secondary v6-chat-force-send"${boxDisabled}
            title="Send now, even while a reply or another send is in flight (Ctrl/Cmd+Shift+Enter)"
            aria-label="Force send: send now, even while a reply or another send is in flight"><span aria-hidden="true">⚡</span> Force</button>
          <button type="submit" id="v6ChatSend" class="btn btn-primary v6-chat-send-btn"${disabled}>Send</button>
        </div>
      </form>
      <p id="v6ChatStatus" class="v6-chat-send-status${send ? ` is-${send.kind}` : ''}" role="status" aria-live="polite">${send ? escapeHtml(send.message) : ''}</p>
    </section>`;
  }

  /**
   * Markers for what a session's pane shows besides the conversation itself
   * (#3052): launch boilerplate, switchboard wakes, `tc` tool blocks, prompt
   * and status chrome, and each engine's thinking and tool lines. Matched
   * against a line with its colour codes stripped. Anything not matched is
   * kept: an unrecognised line is shown, never silently dropped.
   */
  const LIVE_NOISE = Object.freeze([
    /^When the user wants to wrap up/i,
    /^#{1,6}\s*Medusa consumer contract/i,
    /TangleClaw'd into existence/i,
    /^Reading launch context via tc start next/i,
    /^\[TangleClaw( Switchboard)?\]/,
    /^\$?\s*tc\s+(message|start|workload|control|rules|whoami|branch|docs|sessions|capabilities)\b/,
    /^[╭╮╰╯│─━┌┐└┘├┤═║╔╗╚╝\s]+$/,
    /^[─━═]{3,}/,
    // The hint as the UI draws it — a line of its own, or a trailing
    // parenthesis — not a reply that tells the operator to press it.
    /^esc to (cancel|interrupt)\b|\(esc to (cancel|interrupt)\)\s*$/i,
    /\?\s*for shortcuts/i,
    /How'?s the CLI experience/i,
    // Status bars start with the number: "12.3k tokens", "41% context left".
    /^[\d.,]+k?\s+tokens?\b/i,
    /^\d+%\s+(of\s+)?context\b/i,
    /^(⏎|⌃|ctrl\+)/i
  ]);

  /** Lines that start a tool block: what is indented under them is the tool's output. */
  const LIVE_TOOL = Object.freeze([/^…\s*\d+\s+more actions?\s*…?$/i, /^[⎿└]/]);

  /** Per-engine thinking/tool lines; an unknown engine gets all of them. */
  const LIVE_ENGINE_NOISE = Object.freeze({
    // A tool call (`⏺ Bash(…)`) or a tool status line (`⏺ Ran npm test`):
    // a status verb and no closing punctuation, which keeps a reply sentence
    // that merely starts with one of those verbs.
    claude: [/^⏺\s+[A-Za-z][\w.-]*\(/, /^⏺\s+(Ran|Explored|Edited|Read|Searched|Wrote|Updated|Listed|Called|Fetched|Created|Deleted|Added)\b.*[^.!?:]$/, /^[✶✻✽✢]/],
    codex: [/^•\s+(Ran|Explored|Edited|Read|Searched|Updated|Added|Deleted|Called|Running|Listed)\b/, /^▸\s*Thought\b/],
    antigravity: [/^[○●]/],
    aider: [/^Tokens:/, /^Applied edit to /, /^Commit [0-9a-f]{7,}\b/, /^(Repo-map|Main model|Weak model|Git repo|Aider v)\b/, /^Added .+ to the chat\b/]
  });

  /**
   * A tail line meaning the engine is busy right now: a spinner glyph or the
   * interrupt hint. Words like "thinking" alone are not enough — a reply can
   * say them.
   */
  const LIVE_BUSY = /\(esc to interrupt\)\s*$|^[\u2736\u273B\u273D\u2722]|^[\u2800-\u28FF]/i;

  /** A prompt line: `> text`, `❯ text` or `› text`, possibly inside a box border. */
  const LIVE_PROMPT = /^(?:│\s*)?(?:>|❯|›)\s?(.*?)\s*│?$/;

  /** Assistant bullets an engine prefixes its own message lines with. */
  const LIVE_BULLET = /^(?:⏺|•)\s+/;

  /**
   * A switchboard wake or TangleClaw notice (#3076). It reaches the pane as
   * a typed prompt, so without this it read as the operator speaking; it
   * belongs Under the Hood, never in the conversation.
   */
  const SWITCHBOARD_TEXT = /^\[TangleClaw( Switchboard)?\]/;

  /**
   * The notices TangleClaw types into a pane (#3076), each slot it fills in
   * marked by the kind of text it takes: `#` a count, `@` an address (an
   * origin, a switchboard path), `%` a wake-ref id, `~` a project's own reply
   * guidance (`replyGuidance`, #2402), which replaces the default reply step.
   * The switchboard wake in its project and Master forms
   * (`lib/medusa-wake.js#_nudgeText`) and the workload reminder
   * (`lib/workload-nudge.js`), each optionally ending in the wake ref the
   * transport adds (`lib/wake-transports.js`). Compared with all whitespace
   * removed, as `lib/medusa-wake.js#isOwnNudge` compares, because the pane
   * wraps wherever its width falls, words included.
   */
  const NOTICE_TEMPLATES = Object.freeze([
    '[TangleClaw Switchboard] You have # unread Medusa message(s): tc message read. Reply where an answer is needed, BEFORE marking it handled: ~. The initiator closes the exchange, so no answer leaves them blocked; tc message owed lists what you owe. Never use /clear as an acknowledgement. Without tc: API at @ GET /messages; POST /send (inReplyTo) and /read need launch headers.',
    '[TangleClaw Switchboard] You have # unread Medusa message(s). Fetch them from the TangleClaw API at @ GET @ — act on them as appropriate. Reply to each one that needs an answer BEFORE marking it handled: POST @ {"to":"<sender-workspace-id>","message":"<reply>","inReplyTo":"<message-id>"}; then mark it handled: POST @ {"ids":[...]}. Both POSTs need the headers x-tangleclaw-role: master and x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID. The initiator closes the exchange, so a message you do not answer leaves them blocked. Never use /clear as an acknowledgement.',
    '[TangleClaw Switchboard] You have # unread Medusa message(s). Fetch them from the TangleClaw API at @ GET @ — act on them as appropriate. Sending is disabled at your current access level: for one that needs an answer, describe the exact reply for the operator to send, rather than attempting to send it yourself. Mark it handled once dealt with: POST @ {"ids":[...]}, which needs the headers x-tangleclaw-role: master and x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID. Never use /clear as an acknowledgement.',
    '[TangleClaw] Your workload report has expired, so coordinators now read this lane as UNKNOWN. Report what you are doing with `tc workload set <working|waiting-external|blocked|complete> --clearance <safe-to-clear|do-not-clear|unknown> --summary "<one line>"`. This is a reminder, sent once for this report; it changes nothing about your task.'
  ].flatMap((t) => [`${t} (wake ref %)`, t]).map(compileNotice));

  /**
   * What each slot kind in {@link NOTICE_TEMPLATES} takes, and how much of it
   * at most, whitespace removed — each as the producer can emit it: a count
   * (`\d+` in `lib/medusa-wake.js#_ownNudgePattern`); an address, any text
   * (that pattern takes `[^/\s]+` for an encoded project name, which may
   * keep `'()!*`) as long as an origin plus a switchboard path; a 12-hex
   * wake ref (`lib/wake-transports.js`); and reply guidance up to
   * `lib/project-config.js` REPLY_GUIDANCE_TEXT_MAX (2000 characters).
   */
  const NOTICE_SLOTS = Object.freeze({
    '#': { re: /[0-9]/, max: 12 },
    '@': { re: /./, max: 1000 },
    '%': { re: /[0-9a-f]/, max: 32 },
    '~': { re: /./, max: 2000 }
  });

  /**
   * A notice template as alternating literal parts and slot kinds, whitespace removed.
   * @param {string} template
   * @returns {{parts: string[], slots: string[]}}
   */
  function compileNotice(template) {
    const flat = template.replace(/\s+/g, '');
    const parts = flat.split(/[#@%~]/);
    const slots = (flat.match(/[#@%~]/g) || []);
    return { parts, slots };
  }

  /**
   * Whether some text is the start of one of {@link NOTICE_TEMPLATES}, all
   * whitespace removed, each slot taking only its own kind of text. A small
   * automaton walks the text: a state is a position in a literal part, or a
   * count of characters taken by the slot after it.
   * @param {string} text
   * @returns {boolean}
   */
  function fitsNotice(text) {
    const flat = String(text).replace(/\s+/g, '');
    return NOTICE_TEMPLATES.some(({ parts, slots }) => {
      // [part, offset in it, characters taken by the slot after it]
      let states = [[0, 0, 0]];
      for (const ch of flat) {
        const next = new Map();
        const add = (st) => next.set(st.join(','), st);
        for (const [part, off, taken] of states) {
          const lit = parts[part];
          if (off < lit.length) {
            if (lit[off] === ch) add([part, off + 1, 0]);
            continue;
          }
          if (part === parts.length - 1) continue; // the notice is over
          const slot = NOTICE_SLOTS[slots[part]];
          if (taken < slot.max && slot.re.test(ch)) add([part, off, taken + 1]);
          if (parts[part + 1][0] === ch) add([part + 1, 1, 0]);
        }
        states = [...next.values()];
        if (!states.length) return false;
        // Once the text is well into what follows a slot, the slot is over:
        // a free slot must not swallow the rest of the notice, and what
        // comes after it, by also matching it as slot text.
        const settled = states.reduce((most, [part, off]) => Math.max(most, off >= 10 || off === parts[part].length ? part : part - 1), -1);
        states = states.filter(([part, off]) => !(off === parts[part].length && part < settled));
      }
      return true;
    });
  }

  /** A pane line that sends a Medusa message: outbound traffic (#3076). */
  const MEDUSA_SEND = /\btc\s+message\s+send\b/;

  /** A markdown list marker in front of a question (#3079): `1.`, `2)`, `-`, `*`, `•`. */
  const QUESTION_PREFIX = /^(?:\d+[.)]|[-*•])\s+/;

  /**
   * Whether a line asks something (#3082): a `?` that ends a sentence, so
   * one followed by a space, closing punctuation or markdown, or the end of
   * the line — `Proceed? (y/n)`, `**Ship it?**`, `merge #12? Reply yes/no.`.
   * A `?` inside a URL or inline code is not a question.
   * @param {string} line
   * @returns {boolean}
   */
  function asksQuestion(line) {
    const prose = String(line).replace(/`[^`]*`/g, ' ').replace(/\bhttps?:\/\/\S+/gi, ' ');
    return /\?(?=$|[\s)\]}"'*_~.,;:!\u2019\u201d])/.test(prose);
  }

  /**
   * The conversation a session's live output shows (#3052): its assistant
   * replies, any operator prompt not already recorded, the question the
   * assistant is waiting on, and what it is busy doing. Display only — the
   * pane is not a record, so nothing here is written to the B2 conversation.
   * @param {Array<string>|null} lines - The pane's lines (`GET .../peek`).
   * @param {string} engine - `claude`, `codex`, `antigravity` or `aider`; anything else uses every engine's markers.
   * @param {Array<string>} knownUserTexts - User messages already recorded, not to repeat.
   * The switchboard's own traffic is kept apart (#3076): its wakes and every
   * `tc message send` the pane shows, in order, for Under the Hood. The
   * questions are every line the session has said since the operator last
   * spoke that ends in `?` (a wake can split that into several turns),
   * list markers stripped, and none once the operator has answered (#3079).
   * @returns {{turns: Array<{role: 'user'|'assistant', text: string}>, question: string|null,
   *   questions: string[], activity: string|null, switchboard: Array<{dir: 'in'|'out', text: string}>}}
   */
  function extractLiveTurns(lines, engine, knownUserTexts) {
    const engineRules = LIVE_ENGINE_NOISE[engine]
      || Object.keys(LIVE_ENGINE_NOISE).reduce((all, k) => all.concat(LIVE_ENGINE_NOISE[k]), []);
    const tools = LIVE_TOOL.concat(engineRules);
    const squash = (t) => String(t).replace(/\s+/g, ' ').trim();
    // A recorded message can span lines (text, then its Attached lines) and
    // a long prompt wraps in the pane, so an echo is matched by line, by
    // prefix, or as a fragment of the message it continues.
    const known = (Array.isArray(knownUserTexts) ? knownUserTexts : []).filter((t) => typeof t === 'string' && squash(t));
    const sent = known.map(squash);
    // The recorded text as it was written, newlines kept, for the turn (#3079 item 6).
    const original = (m) => known[sent.indexOf(m)] || m;
    const knownLines = new Set((Array.isArray(knownUserTexts) ? knownUserTexts : [])
      .flatMap((t) => String(t).split('\n')).map((t) => t.trim()).filter(Boolean));
    // The longest known text that fits, so a long message's whole text wins
    // over its record cut short (#3079).
    const longest = (list) => list.reduce((best, m) => (best && best.length >= m.length ? best : m), null);
    const recordedAs = (said) => {
      const one = squash(said);
      // A line of a recorded message: the longest message holding it as a
      // whole line — never one that merely contains the words ("ok" in "look").
      if (knownLines.has(said)) return longest(sent.filter((m, i) => String(known[i]).split('\n').some((l) => l.trim() === said))) || one;
      return one.length >= 20 ? longest(sent.filter((m) => m.startsWith(one))) : null;
    };
    let echo = null;
    // Whether the echoed prompt was recorded only in part (#3079): the pane
    // then shows more of it than the record holds.
    let echoCut = false;
    const turns = [];
    let reply = [];
    let activity = null;
    const switchboard = [];
    // Whether the operator has spoken since the newest reply (#3079): their
    // answer clears the questions, recorded or not.
    let answered = false;
    // An indented line belongs to whatever started the block above it: a tool
    // line's output is noise, an assistant line's continuation is reply.
    let block = null;
    // Whether a wake, not the operator, set the session going (#3082): its
    // replies until the operator next speaks are switchboard-triggered.
    let woken = false;
    const flush = () => {
      if (reply.length) {
        turns.push(woken ? { role: 'assistant', text: reply.join('\n'), trigger: 'switchboard' } : { role: 'assistant', text: reply.join('\n') });
        answered = false;
      }
      reply = [];
    };
    (Array.isArray(lines) ? lines : []).forEach((raw) => {
      if (typeof raw !== 'string') return;
      // eslint-disable-next-line no-control-regex
      const line = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+$/, '');
      const text = line.trim();
      // A blank line decides nothing: tool output can hold blank lines, and
      // the next line's indent says whether it is still output (#3057).
      if (!text) {
        // A blank line ends a wrapped notice.
        if (block === 'wake') block = null;
        return;
      }
      const indented = /^\s/.test(line);
      // The rest of a wrapped wake: indented under it (#3076).
      // An indented line carries on a typed notice only while the words so
      // far still read as one of TangleClaw's own notices; anything else —
      // Antigravity's indented reply prose, say — is the session's.
      if (indented && block === 'wake') {
        const last = switchboard[switchboard.length - 1];
        const joined = `${last.text} ${text}`;
        if (fitsNotice(joined)) {
          last.text = joined;
          return;
        }
        block = null;
      }
      const prompt = LIVE_PROMPT.exec(text);
      const promptText = prompt && !indented ? prompt[1].trim() : '';
      if (SWITCHBOARD_TEXT.test(promptText) || SWITCHBOARD_TEXT.test(text)) {
        // A wake is the switchboard speaking, not the operator: it does not
        // answer a question.
        switchboard.push({ dir: 'in', text: promptText || text });
        // What the session had already said before the wake answered the
        // operator, so it stays their turn; only what follows is the wake's.
        flush();
        woken = true;
        // Only a typed wake wraps like a prompt; what is indented under a
        // bare notice line is still the reply's (#3052).
        block = promptText ? 'wake' : null;
        return;
      }
      if (prompt && !indented) {
        flush();
        block = null;
        const said = prompt[1].trim();
        // An empty prompt is the input box the engine always draws, not the
        // operator speaking: it neither ends nor starts anything.
        if (said) {
          activity = null;
          answered = true;
          woken = false;
          echo = recordedAs(said);
          echoCut = Boolean(echo) && /\[Full prompt \(\d+ chars\) saved to: /.test(original(echo));
          // #3079 item 6: a recorded prompt keeps its place among the
          // replies, marked so the recorded copy is not drawn again.
          turns.push(echo ? { role: 'user', text: original(echo), recorded: true } : { role: 'user', text: said });
        }
        return;
      }
      // The rest of a recorded message the pane is still echoing.
      // A prompt recorded only in part goes on, indented, past what the
      // record holds; those lines are still the prompt, not a reply.
      if (echo && (knownLines.has(text) || echo.includes(squash(text)) || LONG_PROMPT_NOTE.test(text) || (echoCut && indented))) return;
      echo = null;
      if (LIVE_BUSY.test(text) && !/Thought for/i.test(text)) {
        activity = text.replace(/^[✶✻✽✢⠀-⣿\s]+/, '').replace(/\s*\(?esc to interrupt\)?/i, '').trim() || 'Working…';
        return;
      }
      // Under a tool line, only its output marker or a deeper indent is
      // output; Antigravity indents its reply prose by two spaces (#3057).
      if (indented && block === 'tool' && (/^[⎿└]/.test(text) || /^\s{4,}/.test(line))) return;
      if (tools.some((re) => re.test(text))) {
        if (MEDUSA_SEND.test(text)) switchboard.push({ dir: 'out', text });
        block = 'tool';
        return;
      }
      // Chrome and boilerplate are dropped, but do not swallow what follows.
      if (LIVE_NOISE.some((re) => re.test(text))) {
        if (MEDUSA_SEND.test(text)) switchboard.push({ dir: 'out', text });
        block = null;
        return;
      }
      if (indented && block === 'reply') {
        reply.push(text);
        return;
      }
      block = 'reply';
      activity = null;
      reply.push(text.replace(LIVE_BULLET, ''));
    });
    flush();
    const last = turns[turns.length - 1];
    // Everything the session has said since the operator last spoke: a wake
    // can split it into several turns, and a question asked before the wake
    // is still waiting (#3082).
    let since = turns.length;
    while (since > 0 && turns[since - 1].role === 'assistant') since--;
    const open = last && last.role === 'assistant' && !answered ? turns.slice(since).map((t) => t.text).join('\n') : '';
    const tail = last && last.role === 'assistant' && !answered ? last.text.split('\n').pop() : '';
    const questions = open.split('\n').map((l) => l.trim().replace(QUESTION_PREFIX, '').trim())
      .filter(asksQuestion);
    return { turns, question: asksQuestion(tail) ? tail : null, questions, activity, switchboard };
  }

  /**
   * A conversation bubble's role label; an assistant is named for the
   * project it speaks for, kept out of the label's uppercase styling.
   * @param {string} role
   * @param {string} name - The project's name.
   * @returns {string} HTML.
   */
  function chatRoleMarkup(role, name) {
    const who = role === 'assistant' ? ` <span class="v6-conversation-who">(${escapeHtml(name)})</span>` : '';
    return `<span class="v6-conversation-role">${escapeHtml(role)}${who}</span>`;
  }

  /**
   * A link in message text (#3082): a Markdown `[label](url)` or a bare
   * `http(s)://` URL. A Markdown target may also be a same-origin path
   * (`/plans/…`); nothing else — `javascript:`, `data:`, `file:` — is ever a
   * link — nor is a path a browser would read as another host (`//host`,
   * `/\host`). A bare URL stops at whitespace, a quote or an angle bracket, and
   * drops trailing sentence punctuation, keeping a `)` it opened itself.
   */
  const MESSAGE_LINK = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)<>"']+|\/(?![\/\\])[^\s)<>"'\\]*)\)|https?:\/\/[^\s<>"'`]+/g;

  /** An image a URL names by its extension (#3082). */
  const IMAGE_URL = /\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i;

  /**
   * Message text as HTML (#3082): every character escaped, with links opening
   * in a new tab (`rel="noopener noreferrer"`). An external URL naming an
   * image is a link card — its host and path, escaped — and never an `<img>`:
   * agent text is untrusted, and an image would be fetched the moment the chat
   * drew it, carrying whatever the URL holds to that host (Ruling A752).
   * @param {*} text
   * @param {Object<string, string>} [thumbs] - Attached image name → `blob:` URL, from the thumbnail cache.
   * @returns {string} HTML.
   */
  function messageMarkup(text, thumbs) {
    return String(text == null ? '' : text).split('\n').map((line) => {
      const attached = ATTACHED_LINE.exec(line);
      return attached ? attachmentMarkup(attached[1], thumbs) : lineMarkup(line);
    }).join('\n');
  }

  /**
   * An `Attached:` line naming a file in the project's secrets store
   * (#3082), as `sendChat` writes one. The file name group takes only what
   * `sanitizeUploadName` produces.
   */
  const ATTACHED_LINE = /^Attached: (?:\.tangleclaw\/)?secrets\/([A-Za-z0-9._-]{1,128})\s*$/;

  /** An image file name, by extension (#3082). */
  const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif)$/i;

  /**
   * An attachment in a message (#3082): an image the page has fetched as a
   * thumbnail — a `blob:` URL from the per-(project, file) cache, opening in
   * a new tab — or else the file's name as a chip.
   * @param {string} filename
   * @param {Object<string, string>} [thumbs] - File name → `blob:` URL.
   * @returns {string} HTML.
   */
  function attachmentMarkup(filename, thumbs) {
    const url = thumbs && Object.prototype.hasOwnProperty.call(thumbs, filename) ? thumbs[filename] : null;
    if (IMAGE_NAME.test(filename) && typeof url === 'string' && /^blob:/.test(url)) {
      const href = escapeHtml(url);
      return `<a class="v6-chat-link-preview v6-chat-thumb-link" href="${href}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(filename)} (opens in a new tab)">`
        + `<img class="v6-chat-thumb" src="${href}" alt="${escapeHtml(filename)}"><span class="v6-chat-thumb-name">${escapeHtml(filename)}</span></a>`;
    }
    return `<span class="v6-chat-attachment"><span aria-hidden="true">📎</span> ${escapeHtml(filename)}</span>`;
  }

  /**
   * One line of message text (#3082): escaped, with its links.
   * @param {string} raw
   * @returns {string} HTML.
   */
  function lineMarkup(raw) {
    let out = '';
    let last = 0;
    MESSAGE_LINK.lastIndex = 0;
    for (let m = MESSAGE_LINK.exec(raw); m; m = MESSAGE_LINK.exec(raw)) {
      let match = m[0];
      let href = m[2] || match;
      const label = m[1];
      if (!label) {
        // Sentence punctuation after a bare URL is not part of it.
        while (/[.,;:!?)\]]$/.test(href) && !(href.endsWith(')') && (href.match(/\(/g) || []).length >= (href.match(/\)/g) || []).length)) {
          href = href.slice(0, -1);
        }
        match = href;
      }
      // Nothing left once its punctuation went: not a link, and the scan moves on.
      if (!match) {
        MESSAGE_LINK.lastIndex = m.index + m[0].length;
        continue;
      }
      out += escapeHtml(raw.slice(last, m.index));
      out += linkMarkup(href, label);
      last = m.index + match.length;
      MESSAGE_LINK.lastIndex = last;
    }
    return out + escapeHtml(raw.slice(last));
  }

  /**
   * One link (#3082): a new-tab anchor, or for an external image a link card.
   * @param {string} href - An `http(s)://` URL or a same-origin path, unescaped.
   * @param {string} [label] - A Markdown label.
   * @returns {string} HTML.
   */
  function linkMarkup(href, label) {
    const safe = escapeHtml(href);
    const external = /^https?:\/\//i.test(href);
    if (external && IMAGE_URL.test(href)) {
      const at = href.indexOf('/', href.indexOf('//') + 2);
      const host = at === -1 ? href.slice(href.indexOf('//') + 2) : href.slice(href.indexOf('//') + 2, at);
      const path = at === -1 ? '' : href.slice(at);
      return `<a class="v6-chat-link-preview" href="${safe}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="Opens in a new tab; not loaded here">`
        + `<span class="v6-chat-link-preview-icon" aria-hidden="true">🖼</span>`
        + `<span class="v6-chat-link-preview-host">${escapeHtml(host)}</span><span class="v6-chat-link-preview-path">${escapeHtml(label || path)}</span></a>`;
    }
    return `<a class="v6-chat-link" href="${safe}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escapeHtml(label || href)}</a>`;
  }

  /**
   * Whether a recorded user message is the one a turn shows (#3079): the
   * same words, or — for a long message recorded only in part — the turn
   * starts with what was recorded before the saved-path line.
   * @param {string} content - The recorded event's text.
   * @param {string} text - The turn's text.
   * @returns {boolean}
   */
  function sameMessage(content, text) {
    const squash = (t) => String(t).replace(/\s+/g, ' ').trim();
    const recorded = squash(content);
    const shown = squash(text);
    if (recorded === shown) return true;
    const cut = recorded.indexOf('[Full prompt (');
    const head = cut > 0 ? recorded.slice(0, cut).trim() : '';
    return head.length >= 20 && (shown.startsWith(head) || head.startsWith(shown));
  }

  /**
   * Place the recorded events around the live turns (#3079 item 6). Each
   * recorded user message the pane also shows is drawn once, as its live
   * turn. Recorded events up to the last such one come before the live
   * turns; those after it were sent but are not on screen yet, so they
   * come after. When the pane shows none of them, only the message just
   * sent from this chat counts as after.
   * @param {Array<object>|null} events - The recorded conversation events.
   * @param {Array<{role: string, text: string, recorded?: boolean}>} liveTurns
   * @param {{text: string}|null} [lastSent] - What this chat last recorded, until the pane shows it.
   * @returns {{head: Array<object>, tail: Array<object>}}
   */
  function arrangeRecorded(events, liveTurns, lastSent) {
    const list = (Array.isArray(events) ? events : []).filter((e) => !isRecordedWake(e));
    const matched = new Set();
    // Newest first, each pairing with the latest event before the one the
    // turn after it took, so the pairs keep the order the pane shows.
    let below = list.length;
    (Array.isArray(liveTurns) ? liveTurns : []).filter((t) => t && t.role === 'user' && t.recorded).reverse().forEach((t) => {
      for (let i = below - 1; i >= 0; i--) {
        const e = list[i];
        if (e && e.role === 'user' && sameMessage(e.content, t.text)) { matched.add(i); below = i; return; }
      }
    });
    const last = matched.size ? Math.max(...matched) : -1;
    if (last < 0) {
      const end = list.length - 1;
      const sentLast = end >= 0 && lastSent && list[end] && list[end].role === 'user' && sameMessage(list[end].content, lastSent.text);
      return sentLast ? { head: list.slice(0, end), tail: [list[end]] } : { head: list, tail: [] };
    }
    return {
      head: list.filter((e, i) => i <= last && !matched.has(i)),
      tail: list.filter((e, i) => i > last && !matched.has(i))
    };
  }

  /**
   * @param {Array<object>} events
   * @param {string} name - The project's name.
   * @param {Object<string, string>} [thumbs] - Attached image name → `blob:` URL.
   * @returns {string} The recorded events as conversation bubbles.
   */
  function recordedEventsMarkup(events, name, thumbs) {
    return events.map((e) => (
      `<li class="v6-conversation-event is-${escapeHtml(e && e.role)}">
            ${chatRoleMarkup(e && e.role, name)}
            <span class="v6-conversation-content">${messageMarkup(e && e.content, thumbs)}</span>
          </li>`
    )).join('');
  }

  /**
   * The message being sent, at the bottom of the chat until it settles
   * (#3079 item 6), unless the chat already shows it as recorded.
   * @param {{id: *, text: string}|null|undefined} pending
   * @param {{id: *}|null|undefined} lastSent
   * @param {Object<string, string>} [thumbs] - Attached image name → `blob:` URL.
   * @returns {string} HTML list item, or ''.
   */
  function pendingMarkup(pending, lastSent, thumbs) {
    // One bubble per send on its way (#3082: a forced send can overlap another).
    const list = (Array.isArray(pending) ? pending : [pending])
      .filter((p) => p && typeof p.text === 'string' && !(lastSent && lastSent.id === p.id));
    return list.map((p) => `<li class="v6-conversation-event is-user is-pending">${chatRoleMarkup('user', '')}<span class="v6-conversation-content">${messageMarkup(p.text, thumbs)}</span><span class="v6-chat-pending-note"> Sending…</span></li>`).join('');
  }

  /**
   * The live replies (#3052) as conversation bubbles, marked `is-live` because
   * they come from the pane, not the record.
   * @param {Array<{role: string, text: string}>} turns
   * @param {string} name
   * @param {{blockers: boolean, milestones: boolean, chatter: boolean}} [verbosity] - Which switchboard replies show (#3082).
   * @param {Object<string, string>} [thumbs] - Attached image name → `blob:` URL.
   * @returns {string} HTML list items.
   */
  function liveTurnsMarkup(turns, name, verbosity, thumbs) {
    return (Array.isArray(turns) ? turns : []).filter((t) => shownInChat(t, verbosity)).map((t) => (
      `<li class="v6-conversation-event is-${escapeHtml(t && t.role)} is-live">${chatRoleMarkup(t && t.role, name)}<span class="v6-conversation-content">${messageMarkup(t && t.text, thumbs)}</span></li>`
    )).join('');
  }

  /** A reply reporting a hold, a failure, an error or a refusal (#3082). */
  const BLOCKER_TEXT = /\b(?:HOLD|held|blocked|blocker|blocking|fail(?:ed|s|ing|ure)?|error|refus(?:ed|al|es)|cannot|can't|broken|red\b|timed out|timeout)/i;

  /** A reply reporting a PR opened or merged, a release cut, or a sprint exit (#3082). */
  const MILESTONE_TEXT = /\b(?:PR\s*#?\d+\s*(?:open|opened|merged)|merged|true-merged|released|release (?:cut|published)|cut v?\d+\.\d+|tagged|sprint exit|v\d+\.\d+\.\d+ (?:is )?(?:out|live|published))/i;

  /**
   * What kind of turn this is, for the verbosity filter (#3082): a turn the
   * operator's own message set going is `direct`; a switchboard-triggered
   * reply is a `question` if it asks one, else a `blocker`, a `milestone`, or
   * routine `chatter`.
   * @param {{role?: string, text?: string, trigger?: string}|null} turn
   * @returns {'direct'|'question'|'blocker'|'milestone'|'chatter'}
   */
  function turnKind(turn) {
    if (!turn || turn.role !== 'assistant' || turn.trigger !== 'switchboard') return 'direct';
    const text = String(turn.text || '');
    if (text.split('\n').some(asksQuestion)) return 'question';
    if (BLOCKER_TEXT.test(text)) return 'blocker';
    if (MILESTONE_TEXT.test(text)) return 'milestone';
    return 'chatter';
  }

  /**
   * Whether the chat shows a turn, or tucks it Under the Hood (#3082).
   * @param {object} turn
   * @param {{blockers: boolean, milestones: boolean, chatter: boolean}} [verbosity]
   * @returns {boolean}
   */
  function shownInChat(turn, verbosity) {
    const v = isVerbosity(verbosity) ? verbosity : VERBOSITY_DEFAULT;
    const kind = turnKind(turn);
    if (kind === 'blocker') return v.blockers;
    if (kind === 'milestone') return v.milestones;
    if (kind === 'chatter') return v.chatter;
    return true;
  }

  /** What each tucked kind is called (#3082). */
  const TURN_KIND_LABELS = Object.freeze({ blocker: 'Blocker', milestone: 'Milestone', chatter: 'Fleet chatter' });

  /**
   * The switchboard-triggered replies the filter tucked away (#3082), for
   * Under the Hood, each tagged with its kind.
   * @param {Array<object>} turns
   * @param {object} [verbosity]
   * @returns {Array<object>}
   */
  function tuckedTurns(turns, verbosity) {
    return (Array.isArray(turns) ? turns : []).filter((t) => !shownInChat(t, verbosity));
  }

  /**
   * @param {Array<object>} tucked
   * @param {Object<string, string>} [thumbs] - Attached image name → `blob:` URL.
   * @returns {string} HTML list items, or the empty note.
   */
  function tuckedMarkup(tucked, thumbs) {
    if (!tucked.length) return '<li class="v6-chat-tucked-empty">Nothing tucked away.</li>';
    return tucked.map((t) => `<li class="v6-chat-tucked-item is-${turnKind(t)}"><span class="v6-chat-tucked-kind">${TURN_KIND_LABELS[turnKind(t)]}</span> <span class="v6-conversation-content">${messageMarkup(t.text, thumbs)}</span></li>`).join('');
  }

  /** @param {number} n @returns {string} The summary's count of tucked replies, or ''. */
  function tuckedCountText(n) {
    return n ? `${n} tucked` : '';
  }

  /**
   * The verbosity filter (#3082): one checkbox per switchboard-reply kind.
   * @param {object} [verbosity]
   * @returns {string} HTML.
   */
  function verbosityMarkup(verbosity) {
    const v = isVerbosity(verbosity) ? verbosity : VERBOSITY_DEFAULT;
    const box = (id, key, label) => `<label class="v6-chat-verbosity-option"><input type="checkbox" id="${id}" data-verbosity="${key}"${v[key] ? ' checked' : ''}> ${label}</label>`;
    return `<fieldset class="v6-chat-verbosity">
          <legend>Switchboard replies shown in the chat</legend>
          <span class="v6-chat-verbosity-fixed">Direct chat &amp; questions: always</span>
          ${box('v6ChatShowBlockers', 'blockers', 'Blockers')}
          ${box('v6ChatShowMilestones', 'milestones', 'Milestones')}
          ${box('v6ChatShowChatter', 'chatter', 'Fleet chatter')}
        </fieldset>`;
  }

  /**
   * The turns up to and including the operator's last message (#3079),
   * each as `role:text`: what identifies the reply that asks the questions
   * among the session's, however many turns a wake splits it into.
   * @param {{turns?: Array<{role: string, text: string}>}|null} live
   * @returns {string[]}
   */
  function askingPrefix(live) {
    const turns = live && Array.isArray(live.turns) ? live.turns : [];
    // Up to the operator's last message: the session's reply after it may be
    // split by a wake into several turns, and they all answer that message.
    let i = turns.length - 1;
    while (i >= 0 && !(turns[i] && turns[i].role === 'user')) i--;
    return turns.slice(0, i + 1).map((t) => `${t && t.role}:${String(t && t.text).replace(/\s+/g, ' ').trim()}`);
  }

  /**
   * How a dismissed question is remembered (#3079): its words and the turns
   * before the reply that asked it. A dismissal holds for that same reply as
   * it grows (more text, a wake) or as older turns scroll off the top of the
   * pane; a later exchange has more turns before its reply, so the same
   * words asked again show — even after the very same answer.
   * @param {{turns?: Array}|null} live
   * @param {string} question
   * @returns {{q: string, prefix: string[]}}
   */
  function questionKey(live, question) {
    return { q: question, prefix: askingPrefix(live) };
  }

  /**
   * The questions still waiting on the operator (#3079): the live view's
   * queue (or its one question, from a caller that predates the queue),
   * less any the operator dismissed.
   * @param {{question?: string|null, questions?: string[], turns?: Array}|null} live
   * @param {Array<{q: string, prefix: string[]}>} [dismissed] - {@link questionKey}s dismissed in this chat.
   * @returns {string[]}
   */
  function openQuestions(live, dismissed) {
    const gone = Array.isArray(dismissed) ? dismissed : [];
    const now = askingPrefix(live);
    // The same reply: the turns before it unchanged, or with older ones gone off the top.
    const sameReply = (saved) => now.length <= saved.length
      && now.every((t, i) => t === saved[saved.length - now.length + i]);
    return askedQuestions(live).filter((q) => !gone.some((d) => d && d.q === q && Array.isArray(d.prefix) && sameReply(d.prefix)));
  }

  /**
   * @param {{question?: string|null, questions?: string[]}|null} live
   * @returns {string[]} Every question the live view asks, dismissed or not.
   */
  function askedQuestions(live) {
    if (!live) return [];
    const all = Array.isArray(live.questions) ? live.questions : (live.question ? [live.question] : []);
    return all.filter((q) => typeof q === 'string' && q);
  }

  /**
   * @param {string[]|string|null} questions - What the assistant is waiting on.
   * @returns {string} HTML.
   */
  function chatQuestionMarkup(questions) {
    const list = questionList(questions);
    return `<div id="v6ChatQuestion" class="v6-chat-question${list.length ? ' is-asking' : ''}" role="status" aria-live="polite">${chatQuestionInner(list)}</div>`;
  }

  /** @param {string[]|string|null} questions @returns {string[]} */
  function questionList(questions) {
    if (Array.isArray(questions)) return questions.filter((q) => typeof q === 'string' && q);
    return questions ? [String(questions)] : [];
  }

  /**
   * The question slot's contents (#3079): each question numbered `(1)`,
   * `(2)` when there are several, each with a ✕ that dismisses it.
   * @param {string[]|string|null} questions
   * @returns {string} HTML for inside the question slot.
   */
  function chatQuestionInner(questions) {
    const list = questionList(questions);
    if (!list.length) return '';
    const many = list.length > 1;
    return `<span class="v6-chat-question-label">Waiting on you:</span>
      <ol class="v6-chat-question-list">${list.map((q, i) => (
        `<li class="v6-chat-question-item">${many ? `<span class="v6-chat-question-badge" aria-hidden="true">(${i + 1})</span> ` : ''}<span class="v6-chat-question-text">${escapeHtml(q)}</span>
          <button type="button" class="v6-chat-question-dismiss" id="v6ChatQuestionDismiss${i}" data-index="${i}" title="Dismiss this question" aria-label="Dismiss question ${i + 1}"><span aria-hidden="true">✕</span></button></li>`
      )).join('')}</ol>`;
  }

  /**
   * @param {{role?: string, content?: string}|null} e - A recorded conversation event.
   * @returns {boolean} Whether it is a switchboard wake the session recorded as a user turn (#3076).
   */
  function isRecordedWake(e) {
    return Boolean(e && e.role === 'user' && SWITCHBOARD_TEXT.test(String(e.content || '').trim()));
  }

  /**
   * The switchboard's traffic for Under the Hood (#3076): wakes the session
   * recorded, then what the pane shows — wakes in, `tc message send` out —
   * leaving out a pane wake that only repeats a recorded one.
   * @param {Array<object>|null} events - The recorded conversation events.
   * @param {{switchboard?: Array<{dir: string, text: string}>}|null} live
   * @returns {Array<{dir: 'in'|'out', text: string}>}
   */
  function switchboardItems(events, live) {
    const squash = (t) => String(t).replace(/\s+/g, ' ').trim();
    const recorded = (Array.isArray(events) ? events : []).filter(isRecordedWake)
      .map((e) => ({ dir: 'in', text: squash(e.content) }));
    const seen = new Set(recorded.map((r) => r.text));
    const shown = (live && Array.isArray(live.switchboard) ? live.switchboard : [])
      .filter((x) => x && typeof x.text === 'string')
      .map((x) => ({ dir: x.dir === 'out' ? 'out' : 'in', text: squash(x.text) }))
      .filter((x) => !(x.dir === 'in' && seen.has(x.text)));
    return recorded.concat(shown);
  }

  /**
   * @param {Array<{dir: string, text: string}>} items
   * @returns {string} HTML list items, or the empty note.
   */
  function switchboardMarkup(items) {
    if (!items.length) return '<li class="v6-chat-switchboard-empty">No switchboard traffic on screen.</li>';
    return items.map((x) => (
      `<li class="v6-chat-switchboard-item is-${x.dir}"><span class="v6-chat-switchboard-dir">${x.dir === 'out' ? '→ out' : '← in'}</span> <span class="v6-chat-switchboard-text">${escapeHtml(x.text)}</span></li>`
    )).join('');
  }

  /** What each Medusa listener state reads as in the indicator's tip (#3076). */
  const MEDUSA_STATE_LABELS = Object.freeze({
    off: 'off', connecting: 'connecting', listening: 'listening', error: 'error'
  });

  /**
   * What the Medusa indicator says (#3076), as plain text and class names
   * — the markup escapes them, and an in-place update sets them as
   * properties.
   * @param {object} medusa
   * @returns {{className: string, tip: string, badge: string, badgeClass: string}}
   */
  function medusaIndicatorParts(medusa) {
    const state = MEDUSA_STATE_LABELS[medusa.state] ? medusa.state : 'off';
    const unread = Math.max(0, Number(medusa.unread) || 0);
    const inbound = Math.max(0, Number(medusa.inbound) || 0);
    const outbound = Math.max(0, Number(medusa.outbound) || 0);
    const tip = `Medusa: ${MEDUSA_STATE_LABELS[state]}${state === 'error' && medusa.lastError ? ` (${medusa.lastError})` : ''}`
      + ` · ${unread} unread · on screen: ${inbound} in, ${outbound} out — open Under the Hood for the traffic`;
    const flow = (medusa.flowIn ? ' is-flow-in' : '') + (medusa.flowOut ? ' is-flow-out' : '');
    return {
      className: `v6-chat-medusa is-${state}${flow}`,
      tip,
      badge: unread ? String(unread) : '@',
      badgeClass: `v6-chat-medusa-badge${unread ? ' has-unread' : ''}`
    };
  }

  /**
   * The chat's Medusa traffic indicator (#3076): the inbound (left) and
   * outbound (right) heads, which blink when traffic moves, around an `@`
   * badge that becomes the unread count. Nothing until the status answers,
   * and nothing when the project has not turned Medusa on (`enabled ===
   * false`, the #820 rule the session banner follows).
   * @param {{state?: string, unread?: number, enabled?: boolean, inbound?: number, outbound?: number,
   *   flowIn?: boolean, flowOut?: boolean, lastError?: string|null}|null|undefined} medusa
   * @returns {string} HTML.
   */
  function medusaIndicatorMarkup(medusa) {
    if (!medusa || medusa.enabled === false) return '';
    const parts = medusaIndicatorParts(medusa);
    return `<button type="button" id="v6ChatMedusa" class="${parts.className}" aria-controls="v6ChatUnderHood"
        title="${escapeHtml(parts.tip)}" aria-label="${escapeHtml(parts.tip)}">
        <img class="v6-medusa-head v6-medusa-head--in" src="/medusa-head-left.webp" alt="" width="16" height="19">
        <span id="v6ChatMedusaBadge" class="${parts.badgeClass}" aria-hidden="true">${escapeHtml(parts.badge)}</span>
        <img class="v6-medusa-head v6-medusa-head--out" src="/medusa-head-right.webp" alt="" width="16" height="19">
      </button>`;
  }

  /**
   * The chat target's own repo version and git branch (#3057), which can
   * differ from the server version in the top bar. A branch with
   * uncommitted changes is starred; `dirty: null` means unknown and is not.
   * @param {object|null} project - A `/api/projects` row.
   * @returns {string} HTML; empty when the row carries neither.
   */
  function chatRepoBadgesMarkup(project) {
    const git = project && project.git && typeof project.git === 'object' ? project.git : {};
    const version = (project && project.version) || git.latestTag || '';
    const branch = git.branch || '';
    const dirty = git.dirty === true;
    return (version ? ` <span class="v6-chat-version-badge" title="This project's version">${escapeHtml(version)}</span>` : '')
      + (branch ? ` <span class="v6-chat-git-badge${dirty ? ' is-dirty' : ''}" title="${dirty ? 'Git branch, with uncommitted changes' : 'Git branch'}">⎇ ${escapeHtml(branch)}${dirty ? '*' : ''}</span>` : '');
  }

  /**
   * What the chat is busy with (#3057): what the engine reports, else
   * `Working` while a send is on its way.
   * @param {object} chat - A conversation view's `chat`.
   * @returns {string|null}
   */
  function chatBusyLabel(chat) {
    const live = chat && chat.live;
    if (live && live.activity) return live.activity;
    return chat && chat.send && chat.send.kind === 'pending' ? 'Working' : null;
  }

  /** Trailing dots a busy label ends with; the animated ones replace them (#3057). */
  const TRAILING_ELLIPSIS = /\s*(?:\.{1,3}|…)\s*$/;

  /**
   * Elapsed time for the busy indicator (#3057): `0s`, `59s`, `1m 12s`, `1h 2m`.
   * @param {number} ms
   * @returns {string}
   */
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}h ${m}m`;
    return m ? `${m}m ${s}s` : `${s}s`;
  }

  /**
   * @param {string|null} activity - What the engine is busy doing.
   * @param {string} [elapsed] - How long it has been busy, as {@link formatElapsed} writes it.
   * @returns {string} HTML.
   */
  function chatActivityMarkup(activity, elapsed) {
    return `<p id="v6ChatActivity" class="v6-chat-activity${activity ? ' is-busy' : ''}" aria-live="polite">${chatActivityInner(activity, elapsed)}</p>`;
  }

  /**
   * The busy line's contents (#3057): the label without its static dots,
   * animated dots, and the elapsed time. Only the label is announced; the
   * dots and the ticking time are hidden from assistive tech.
   * @param {string|null} activity
   * @param {string} [elapsed]
   * @returns {string} HTML.
   */
  function chatActivityInner(activity, elapsed) {
    if (!activity) return '';
    const label = String(activity).replace(TRAILING_ELLIPSIS, '') || 'Working';
    return `<span class="v6-chat-activity-label">${escapeHtml(label)}</span><span class="v6-chat-activity-dots" aria-hidden="true"></span>`
      + ` <span id="v6ChatActivityTimer" class="v6-chat-activity-timer" aria-hidden="true">${escapeHtml(elapsed || '0s')}</span>`;
  }

  /** The secure-clipboard route's limit on one decoded file (`lib/secure-clipboard.js` MAX_FILE_BYTES). */
  const MAX_ATTACH_BYTES = 5 * 1024 * 1024;

  /** The session command route's limit on one command, in characters (`lib/routes/sessions.js`). */
  const MAX_COMMAND_CHARS = 4096;

  /**
   * Text as base64 of its UTF-8 bytes, what the secure-clipboard route's
   * `encoding: 'base64'` decodes (#3079).
   * @param {string} text
   * @returns {string}
   */
  function defaultTextToBase64(text) {
    const bytes = new global.TextEncoder().encode(String(text));
    let binary = '';
    // In slices, so a long message never overflows the argument list.
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return global.btoa(binary);
  }

  /**
   * The command that stands in for a message too long for the command route
   * (#3079): as much of its start as fits, then where the whole of it was
   * saved. Never longer than {@link MAX_COMMAND_CHARS}, and never cut
   * between the two halves of a surrogate pair.
   * @param {string} message - The whole message.
   * @param {string} relPath - Where it was saved, relative to the project.
   * @returns {string}
   */
  function longPromptCommand(message, relPath) {
    const note = longPromptNote(message, relPath);
    let head = message.slice(0, Math.max(0, MAX_COMMAND_CHARS - note.length));
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    return `${head}${note}`;
  }

  /**
   * The line that says where a long message was saved (#3079). The command
   * and the recorded event end with the same words, so the chat can tell
   * the line apart from a reply when the pane echoes it.
   * @param {string} message
   * @param {string} relPath
   * @returns {string}
   */
  function longPromptNote(message, relPath) {
    return `\n\n[Full prompt (${message.length} chars) saved to: ${relPath} — read that file in full]`;
  }

  /** The {@link longPromptNote} line, as the pane shows it. */
  const LONG_PROMPT_NOTE = /^\[Full prompt \(\d+ chars\) saved to: .+ — read that file in full\]$/;

  /**
   * The most a recorded user event's JSON body may weigh, in UTF-8 bytes
   * (#3079, Rulings A739/A740): the events route takes the default 10 KB
   * (`lib/routes/_kernel.js` MAX_BODY_SIZE), and this leaves room to spare.
   */
  const MAX_EVENT_BODY_BYTES = 8000;

  /**
   * @param {string} text
   * @returns {number} Its length in UTF-8 bytes (what `TextEncoder` would give).
   */
  function utf8Length(text) {
    let n = 0;
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    return n;
  }

  /**
   * What a recorded user event's request body weighs (#3079): the body
   * `recordUserEvent` sends, JSON-encoded, in UTF-8 bytes — quotes,
   * backslashes and control characters grow when encoded, so the raw
   * message's length is not the measure. The sequence number is taken at
   * its largest.
   * @param {string} content
   * @param {string} launchId
   * @returns {number}
   */
  function eventBodyBytes(content, launchId) {
    return utf8Length(JSON.stringify({
      launchId, seq: Number.MAX_SAFE_INTEGER, tier: 'A', adapter: 'v6-chat-ui', role: 'user', content
    }));
  }

  /**
   * The text to record for a sent message (#3079): the whole message when
   * its event body fits {@link MAX_EVENT_BODY_BYTES}; otherwise as much of
   * its start as fits, cut between characters, followed by where the whole
   * of it was saved.
   * @param {string} message
   * @param {string|null} relPath - Where it was saved, when it was.
   * @param {string} launchId
   * @returns {string}
   */
  function recordedText(message, relPath, launchId) {
    if (eventBodyBytes(message, launchId) <= MAX_EVENT_BODY_BYTES || !relPath) return message;
    const chars = Array.from(message);
    const note = longPromptNote(message, relPath);
    const fits = (k) => eventBodyBytes(chars.slice(0, k).join('') + note, launchId) <= MAX_EVENT_BODY_BYTES;
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    return chars.slice(0, lo).join('') + note;
  }

  /**
   * A file name the secure-clipboard route accepts (#3053):
   * `[A-Za-z0-9._-]{1,128}`, never `.` or `..`. Spaces and path separators
   * become `-`, anything else outside that set is dropped, a leading run of
   * dots or dashes goes (so `../x` cannot climb and `.env` cannot hide), the
   * extension survives truncation, and a name already in `taken` gets `-2`,
   * `-3`… before its extension.
   * @param {string} name - The browser's file name.
   * @param {Set<string>} taken - Names already used in this chat.
   * @returns {string}
   */
  function sanitizeUploadName(name, taken) {
    const used = taken || new Set();
    let clean = String(name == null ? '' : name)
      .replace(/[\s/\\]+/g, '-')
      .replace(/[^A-Za-z0-9._-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^[.-]+/, '')
      .replace(/-+$/, '');
    if (!clean) clean = 'attachment';
    const extMatch = /(\.[A-Za-z0-9]{1,16})$/.exec(clean);
    const ext = extMatch && extMatch.index > 0 ? extMatch[1] : '';
    const stem = ext ? clean.slice(0, -ext.length) : clean;
    const fit = (suffix) => `${stem.slice(0, 128 - ext.length - suffix.length)}${suffix}${ext}`;
    let candidate = fit('');
    for (let n = 2; used.has(candidate); n++) candidate = fit(`-${n}`);
    return candidate;
  }

  /**
   * The files an event carries (#3053): a drop's, a paste's (as files or as
   * file items, which is how a pasted screenshot arrives), or a file
   * input's. Anything else carries none.
   * @param {object|null} evt
   * @returns {Array<object>}
   */
  function filesFromEvent(evt) {
    const list = (x) => (x && typeof x.length === 'number' ? Array.prototype.slice.call(x) : []);
    if (!evt) return [];
    if (evt.dataTransfer && list(evt.dataTransfer.files).length) return list(evt.dataTransfer.files);
    if (evt.clipboardData) {
      const files = list(evt.clipboardData.files);
      if (files.length) return files;
      return list(evt.clipboardData.items)
        .filter((item) => item && item.kind === 'file' && typeof item.getAsFile === 'function')
        .map((item) => item.getAsFile()).filter(Boolean);
    }
    return evt.target ? list(evt.target.files) : [];
  }

  /**
   * Read a browser File as base64 (no `data:` prefix), the encoding the
   * secure-clipboard route takes.
   * @param {Blob} file
   * @returns {Promise<string>}
   */
  function defaultReadFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new global.FileReader();
      reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
      reader.onerror = () => reject(reader.error || new Error('the file could not be read'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Where a saved attachment is, relative to the project's root — the
   * agent's working directory. The route reports `relPath` relative to the
   * project's `.tangleclaw/` directory (`secrets/<file>`), so used as-is it
   * would send the agent to `<project>/secrets/<file>`, which does not exist.
   * @param {string|undefined} relPath - The route's `relPath`.
   * @param {string} filename - The name the file was saved under.
   * @returns {string}
   */
  function projectRelative(relPath, filename) {
    const rel = typeof relPath === 'string' && relPath ? relPath.replace(/^\/+/, '') : `secrets/${filename}`;
    return rel.startsWith('.tangleclaw/') ? rel : `.tangleclaw/${rel}`;
  }

  /** The states an attachment chip can show (each is a CSS modifier). */
  const ATTACH_STATES = Object.freeze(['uploading', 'ready', 'error']);

  /**
   * The composer's attachment chips, each removable.
   * @param {Array<{name: string, status: string, relPath?: string, error?: string}>} items
   * @returns {string} HTML.
   */
  function attachmentChipsMarkup(items) {
    return (Array.isArray(items) ? items : []).map((a, i) => {
      const status = ATTACH_STATES.includes(a && a.status) ? a.status : 'uploading';
      const tip = status === 'error' ? (a.error || 'Could not attach this file.') : (status === 'ready' ? a.relPath : 'Uploading…');
      return `<span class="v6-chat-chip is-${status}" title="${escapeHtml(tip)}">${escapeHtml(a && a.name)}${status === 'uploading' ? ' …' : ''}
        <button type="button" id="v6ChatAttachRemove-${i}" class="v6-chat-chip-remove" aria-label="Remove ${escapeHtml(a && a.name)}">×</button></span>`;
    }).join('');
  }

  /** Short engine codes for the sidebar badge (#3053); other engines use their first two letters. */
  const ENGINE_CODES = Object.freeze({ antigravity: 'AG', claude: 'CC', codex: 'CX', aider: 'AI' });

  /** Engine health values the badge colours; anything else is unknown. */
  const ENGINE_HEALTH = Object.freeze(['operational', 'degraded', 'outage']);

  /** Each member state's glyph and plain title. */
  const MEMBER_STATES = Object.freeze({
    live: { glyph: '●', title: 'Live session' },
    attention: { glyph: '⚠', title: 'Needs attention' },
    starting: { glyph: '◐', title: 'Starting' },
    wrapping: { glyph: '◐', title: 'Wrapping' },
    offline: { glyph: '○', title: 'No live session' }
  });

  /** @param {*} v - A reason the server gave as text or as `{message}`. @returns {string} */
  function reasonText(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    return String(v.message || v.reason || v.code || '');
  }

  /**
   * A sidebar member's status (#3053 item 4, Option A), from its project row
   * (`GET /api/projects`, as the operator sees it) and the engines' health
   * (`GET /api/models/status`): its session state, Medusa link and engine.
   * A live session's launch blocker, held wake or engine error, or a last
   * session that crashed or left work behind, is "attention".
   * @param {object|null} row
   * @param {Object<string, {status?: string}>} health - Engine id -> status.
   * @returns {{state: string, glyph: string, title: string, medusa: string,
   *   engine: {code: string, name: string, health: string, model?: string}|null}}
   */
  function memberIndicators(row, health) {
    const r = row || {};
    const s = r.session || null;
    const live = Boolean(s && s.active === true);
    const sh = r.sessionHealth || null;
    // The session's status column only ever says 'active' while it is live;
    // starting and wrapping are their own fields (lib/projects.js
    // _liveSession: startupReadiness from enrichProject, wrapping from the
    // project's wrap state).
    const readiness = live && s.startupReadiness ? s.startupReadiness : null;
    const wrap = live && s.wrapping && typeof s.wrapping === 'object' ? s.wrapping : null;
    const reason = (live && (reasonText(s.launchBlocker) || reasonText(s.heldWakeReason) || reasonText(s.lastEngineError)))
      || (readiness && readiness.state === 'needs-attention'
        ? `startup needs attention${readiness.blocker ? ` (${readiness.blocker})` : ''}` : '')
      || (wrap && wrap.stale ? `the wrap looks stuck${wrap.step ? ` at ${wrap.step}` : ''}` : '')
      || (sh && sh.status === 'crashed' ? 'the last session crashed' : '')
      || (sh && sh.state === 'left-work' ? 'the last session left work behind' : '');
    let state = 'offline';
    if (reason) state = 'attention';
    else if (wrap) state = 'wrapping';
    else if (readiness && readiness.state === 'starting') state = 'starting';
    else if (live) state = 'live';
    const medusa = r.medusaEnabled === true ? (r.medusaWake === true ? 'on' : 'wake-off') : 'off';
    // The engine the member is really on (#3094, Rulings A767/A768): its live
    // session's, else its last session's, else the one configured for it.
    const idOf = (v) => (typeof v === 'string' && v ? v : null);
    const configured = idOf(r.engine && r.engine.id) || idOf(r.engine);
    const engineId = (s && (idOf(s.engineId) || idOf(s.engine && s.engine.id) || idOf(s.engine)))
      || idOf(r.lastSessionEngineId) || idOf(sh && sh.engineId) || configured;
    let engine = null;
    if (engineId) {
      const id = engineId;
      const known = health && Object.prototype.hasOwnProperty.call(health, id) ? health[id] : null;
      const status = known && ENGINE_HEALTH.includes(known.status) ? known.status : 'unknown';
      const name = id === configured && r.engine && typeof r.engine === 'object' && r.engine.name ? String(r.engine.name) : id;
      const code = Object.prototype.hasOwnProperty.call(ENGINE_CODES, id) ? ENGINE_CODES[id] : id.slice(0, 2).toUpperCase();
      engine = { code, name, health: status };
      const model = (s && (idOf(s.launchedModel) || idOf(s.model))) || idOf(r.model);
      if (model) engine.model = model;
    }
    let title = MEMBER_STATES[state].title;
    if (state === 'attention') title = `Needs attention: ${reason}`;
    else if (state === 'wrapping' && wrap.step) title = `Wrapping (${wrap.step})`;
    return { state, glyph: MEMBER_STATES[state].glyph, title, medusa, engine };
  }

  /** The Medusa link symbol's title, by state. */
  const MEDUSA_TITLES = Object.freeze({ on: 'Medusa link and wake on', 'wake-off': 'Medusa link on, wake off', off: 'Medusa link off' });

  /**
   * The right-hand symbols beside a sidebar member (#3053 item 4).
   * @param {ReturnType<typeof memberIndicators>} info
   * @returns {string} HTML.
   */
  function memberIndicatorsMarkup(info) {
    const link = `<span class="v6-member-link-status is-${info.medusa}" title="${escapeHtml(MEDUSA_TITLES[info.medusa])}">🔗</span>`;
    const ai = info.engine
      ? `<span class="v6-member-ai-status is-${info.engine.health}" title="${escapeHtml(info.engine.name)}${info.engine.model ? ` (${escapeHtml(info.engine.model)})` : ''}: ${info.engine.health === 'unknown' ? 'status unknown' : info.engine.health}">${escapeHtml(info.engine.code)}</span>`
      : '';
    return `<span class="v6-member-indicators">${link}${ai}</span>`;
  }

  /** The chat header's session pill text, by session state. */
  const CHAT_STATUS_LABELS = Object.freeze({ active: 'Active', idle: 'Idle', offline: 'Offline' });

  /** The kinds a send outcome line can carry (each is a CSS modifier). */
  const CHAT_SEND_KINDS = Object.freeze(['pending', 'ok', 'warning', 'error']);

  /**
   * The live output panel's text: the session's last lines, escaped, or what
   * stands in for them.
   * @param {{lines?: string[], error?: string}|null} peek
   * @returns {string} HTML-escaped text for a `<pre>`.
   */
  function chatPeekMarkup(peek) {
    if (!peek) return 'Waiting for output…';
    if (peek.error) return `Could not read live output: ${escapeHtml(peek.error)}`;
    const lines = Array.isArray(peek.lines) ? peek.lines : [];
    return lines.length ? lines.map((l) => escapeHtml(l)).join('\n') : 'No output yet.';
  }

  /**
   * What a key press in the chat composer means: Enter sends; Shift+Enter
   * is a newline, and a key pressed mid IME composition belongs to the IME.
   * @param {{key?: string, shiftKey?: boolean, isComposing?: boolean}|null} evt
   * @returns {'send'|null}
   */
  function chatKeyAction(evt) {
    if (!evt || evt.key !== 'Enter' || evt.isComposing) return null;
    // #3082: Ctrl/Cmd+Shift+Enter is Force Send; Shift+Enter alone stays a newline.
    if (evt.shiftKey) return evt.ctrlKey || evt.metaKey ? 'force' : null;
    return 'send';
  }

  /**
   * The Settings & Profiles view (v6.1.0, Car V61-W2-ROUTES): the three
   * operating profiles with their shared safety floor (#2992), the
   * settings catalog (#2995), the walkthroughs (#3000), and links into the
   * contextual-help and per-project recovery-console sub-views.
   * @param {{profiles?: object|null, catalog?: object|null, walkthroughs?: object|null,
   *   projects?: Array<{id: *, name?: string}>}} view
   * @returns {string} HTML.
   */
  function settingsViewMarkup(view) {
    const v = view || {};
    const prof = v.profiles;
    const profilesHtml = prof && Array.isArray(prof.resolved)
      ? `<ul class="v6-profile-list">${prof.resolved.filter((r) => r && r.ok).map((r) =>
        `<li class="v6-profile"><strong>${escapeHtml(r.name)}</strong>
          <span class="v6-profile-services">${escapeHtml(r.services.length)} services</span>
          <span class="v6-profile-cadence">telemetry every ${escapeHtml(Math.round(r.telemetryCadenceMs / 1000))}s</span></li>`).join('')}</ul>
        <p class="v6-safety-floor">Always on, in every profile: ${escapeHtml((prof.safetyFloor || []).join(', '))}</p>`
      : '<p class="v6-detail-error" role="alert">Could not load the operating profiles.</p>';
    const catalog = v.catalog && v.catalog.catalog && typeof v.catalog.catalog === 'object' ? v.catalog.catalog : null;
    const catalogHtml = catalog
      ? `<dl class="v6-settings-catalog">${Object.keys(catalog).map((key) =>
        `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(catalog[key] && catalog[key].description)}</dd>`).join('')}</dl>`
      : '<p class="v6-detail-error" role="alert">Could not load the settings catalog.</p>';
    const projects = Array.isArray(v.projects) ? v.projects : [];
    const recoveryHtml = projects.length
      ? `<ul class="v6-recovery-links">${projects.map((pr) => {
        const hash = routeHash({ view: 'settings', settingsPath: `recovery/${pr.id}` });
        return `<li><a href="${escapeHtml(hash)}" data-route="${escapeHtml(hash)}">${escapeHtml(pr.name || pr.id)}</a></li>`;
      }).join('')}</ul>`
      : '<p class="v6-detail-empty">No projects yet.</p>';
    const helpHash = routeHash({ view: 'settings', settingsPath: 'help' });
    const platformHash = routeHash({ view: 'settings', settingsPath: 'platform' });
    return `<section class="v6-settings" aria-label="Settings and profiles">
      <h2 class="v6-detail-title">Operating profiles</h2>
      ${profilesHtml}
      <h2 class="v6-detail-title">Settings</h2>
      ${catalogHtml}
      <h2 class="v6-detail-title">Walkthroughs</h2>
      ${walkthroughsMarkup(v.walkthroughs)}
      <h2 class="v6-detail-title">Recovery consoles</h2>
      ${recoveryHtml}
      <p><a class="btn btn-secondary" href="${escapeHtml(helpHash)}" data-route="${escapeHtml(helpHash)}">Help for this screen</a>
        <a class="btn btn-secondary" href="${escapeHtml(platformHash)}" data-route="${escapeHtml(platformHash)}">Platform (v6.2)</a></p>
    </section>`;
  }

  /**
   * The walkthrough list (#3000), each with its verification status.
   * @param {{walkthroughs?: Array<{id: string, title?: string, summary?: string, stepCount?: number,
   *   verification?: string}>}|null} data
   * @returns {string} HTML.
   */
  function walkthroughsMarkup(data) {
    const list = data && Array.isArray(data.walkthroughs) ? data.walkthroughs : null;
    if (!list) return '<p class="v6-detail-error" role="alert">Could not load the walkthroughs.</p>';
    if (!list.length) return '<p class="v6-detail-empty">No walkthroughs.</p>';
    return `<ul class="v6-walkthroughs">${list.map((w) =>
      `<li class="v6-walkthrough"><strong>${escapeHtml(w && w.title)}</strong>
        <span class="v6-walkthrough-steps">${escapeHtml(w && w.stepCount)} steps</span>
        <span class="v6-walkthrough-status is-${escapeHtml(w && w.verification)}">${escapeHtml(w && w.verification)}</span>
        <p class="v6-walkthrough-summary">${escapeHtml(w && w.summary)}</p></li>`).join('')}</ul>`;
  }

  /**
   * One project's Recovery Console (#2991): the four-state circuit, open
   * incidents and recent repair attempts.
   * @param {{projectId: *, console?: {circuit: object, openIncidents: Array<object>, recentAttempts: Array<object>}|null}} view
   * @returns {string} HTML.
   */
  function recoveryConsoleMarkup(view) {
    const v = view || {};
    const c = v.console;
    if (!c || !c.circuit) {
      return `<p class="v6-detail-error" role="alert">Could not load the recovery console for project ${escapeHtml(v.projectId)}.</p>`;
    }
    const latch = c.circuit.latch
      ? `<p class="v6-recovery-latch" role="alert">Latched (${escapeHtml(c.circuit.latch.reason)}). An operator must clear it.</p>` : '';
    const incidents = (c.openIncidents || []).map((i) =>
      `<li>${escapeHtml(i && i.fingerprint)} <span class="v6-recovery-when">${escapeHtml(i && i.createdAt)}</span></li>`).join('');
    const attempts = (c.recentAttempts || []).map((a) =>
      `<li class="is-${escapeHtml(a && a.outcome)}">${escapeHtml(a && a.action)}: ${escapeHtml(a && a.outcome)}
        <span class="v6-recovery-when">${escapeHtml(a && a.attemptedAt)}</span></li>`).join('');
    return `<section class="v6-recovery" aria-label="Recovery console, project ${escapeHtml(v.projectId)}">
      <h2 class="v6-detail-title">Recovery console: project ${escapeHtml(v.projectId)}</h2>
      <p class="v6-recovery-state is-${escapeHtml(c.circuit.state)}">Circuit: <strong>${escapeHtml(c.circuit.state)}</strong>
        (${escapeHtml(c.circuit.failures)} consecutive failures)</p>
      ${latch}
      <h3>Open incidents</h3>
      ${incidents ? `<ul class="v6-recovery-incidents">${incidents}</ul>` : '<p class="v6-detail-empty">None.</p>'}
      <h3>Recent repair attempts</h3>
      ${attempts ? `<ul class="v6-recovery-attempts">${attempts}</ul>` : '<p class="v6-detail-empty">None.</p>'}
    </section>`;
  }

  /**
   * Contextual help from the built-in knowledge base (#2997): cited
   * sections from the shipped manual, never generated text.
   * @param {{results?: Array<{citation?: string, heading?: string, text?: string, pageTitle?: string}>,
   *   error?: string}|null} help
   * @returns {string} HTML.
   */
  function knowledgeBaseMarkup(help) {
    const h = help || {};
    if (!Array.isArray(h.results)) {
      return `<p class="v6-detail-error" role="alert">${escapeHtml(h.error || 'Could not load help for this screen.')}</p>`;
    }
    if (!h.results.length) return '<p class="v6-detail-empty">No help documents this screen yet.</p>';
    return `<section class="v6-kb" aria-label="Help">
      <h2 class="v6-detail-title">Help</h2>
      ${h.results.map((r) => `<article class="v6-kb-result">
        <h3>${escapeHtml(r && (r.heading || r.pageTitle))}</h3>
        <p>${escapeHtml(r && r.text)}</p>
        <p class="v6-kb-citation">${escapeHtml(r && r.citation)}</p>
      </article>`).join('')}
    </section>`;
  }

  /**
   * The v6.2 Platform view (Car V62-W2-ROUTES): provider adapters and their
   * contract check (#3002), Medusa v2 status (#3004), host sandboxing
   * (#3005), and a link that runs a sample what-if simulation (#3001).
   * @param {{providers?: object|null, medusa?: object|null, sandboxing?: object|null}} view
   * @returns {string} HTML.
   */
  function platformViewMarkup(view) {
    const v = view || {};
    const p = v.providers;
    const providersHtml = p && Array.isArray(p.providers)
      ? `<p class="v6-contract is-${p.contract && p.contract.ok ? 'ok' : 'failed'}">Provider contract: ${p.contract && p.contract.ok ? 'every adapter conforms' : 'an adapter does not conform'}</p>
        <ul class="v6-provider-list">${p.providers.map((x) => `<li class="v6-provider"><strong>${escapeHtml(x && x.name)}</strong>
          <span class="v6-provider-actions">${escapeHtml(Object.keys((x && x.actions) || {}).join(', ') || 'no actions')}</span>
          ${x && Array.isArray(x.unsupported) && x.unsupported.length ? `<span class="v6-provider-unsupported">unsupported: ${escapeHtml(x.unsupported.join(', '))}</span>` : ''}</li>`).join('')}</ul>`
      : '<p class="v6-detail-error" role="alert">Could not load the provider adapters.</p>';
    const m = v.medusa;
    const medusaHtml = m && typeof m === 'object' && m.capability !== undefined
      ? `<dl class="v6-medusa-status"><dt>Wire</dt><dd>${escapeHtml(m.capability)}</dd>
          <dt>Stored messages</dt><dd>${escapeHtml(m.storedMessages)}</dd>
          <dt>Pending wakes</dt><dd>${escapeHtml(m.pendingWakes)}</dd>
          <dt>Latest snapshot</dt><dd>${escapeHtml(m.latestSnapshotRoot || 'none')}</dd></dl>`
      : '<p class="v6-detail-error" role="alert">Could not load Medusa v2 status.</p>';
    const s = v.sandboxing;
    const sandboxHtml = s && s.host
      ? `<dl class="v6-sandbox-status"><dt>Modes</dt><dd>${escapeHtml((s.modes || []).join(', '))}</dd>
          <dt>Container runtime available</dt><dd>${escapeHtml(Object.values(s.host.runtimes || {}).some(Boolean) ? 'yes' : 'no')}</dd>
          <dt>Can switch uid</dt><dd>${escapeHtml(s.host.canSwitchUid ? 'yes' : 'no')}</dd>
          <dt>Default plan</dt><dd>${escapeHtml(s.defaultPlan && s.defaultPlan.ok ? s.defaultPlan.mode : (s.defaultPlan && s.defaultPlan.code) || 'unknown')}</dd></dl>`
      : '<p class="v6-detail-error" role="alert">Could not load host sandboxing status.</p>';
    const whatIfHash = routeHash({ view: 'settings', settingsPath: 'whatif' });
    return `<section class="v6-platform" aria-label="Platform">
      <h2 class="v6-detail-title">Provider adapters</h2>
      ${providersHtml}
      <h2 class="v6-detail-title">Medusa v2</h2>
      ${medusaHtml}
      <h2 class="v6-detail-title">Host sandboxing</h2>
      ${sandboxHtml}
      <p><a class="btn btn-secondary" href="${escapeHtml(whatIfHash)}" data-route="${escapeHtml(whatIfHash)}">Run a sample what-if simulation</a></p>
    </section>`;
  }

  /**
   * A what-if simulation result (#3001): makespan, whether every car could
   * be scheduled, the critical path, bottlenecks and unschedulable cars.
   * @param {{result?: object|null, error?: string}} view
   * @returns {string} HTML.
   */
  function whatIfMarkup(view) {
    const r = view && view.result;
    if (!r || typeof r.makespan !== 'number') {
      return `<p class="v6-detail-error" role="alert">${escapeHtml((view && view.error) || 'Could not run the simulation.')}</p>`;
    }
    const bottlenecks = Object.entries(r.bottlenecks || {}).map(([role, w]) =>
      `<li>${escapeHtml(role)}: lane ${escapeHtml(w.laneWait)}, file ${escapeHtml(w.fileWait)}, quota ${escapeHtml(w.quotaWait)}</li>`).join('');
    const unschedulable = (r.unschedulable || []).map((u) => `<li>${escapeHtml(u.carId)}: ${escapeHtml(u.reason)}</li>`).join('');
    return `<section class="v6-whatif" aria-label="What-if simulation">
      <h2 class="v6-detail-title">What-if simulation</h2>
      <p class="v6-whatif-makespan">Makespan: <strong>${escapeHtml(r.makespan)}</strong>${r.complete ? '' : ' (incomplete: some cars could not be scheduled)'}</p>
      <p class="v6-whatif-critical">Critical path: ${escapeHtml((r.criticalPath && r.criticalPath.carIds || []).join(' → ') || 'none')}</p>
      <h3>Bottlenecks</h3>
      ${bottlenecks ? `<ul class="v6-whatif-bottlenecks">${bottlenecks}</ul>` : '<p class="v6-detail-empty">None.</p>'}
      <h3>Unschedulable</h3>
      ${unschedulable ? `<ul class="v6-whatif-unschedulable">${unschedulable}</ul>` : '<p class="v6-detail-empty">None.</p>'}
    </section>`;
  }

  /**
   * Render whichever detail the current view carries.
   * @param {{kind: 'plan', plan: object}|{kind: 'conversation', view: object}|{kind: 'settings', view: object}|
   *   {kind: 'recovery', view: object}|{kind: 'knowledge', help: object}|{kind: 'loading'}|null} detail
   * @returns {string} HTML.
   */
  function detailMarkup(detail, extras) {
    if (!detail) return '';
    if (detail.kind === 'plan') return fleetPlanMarkup(detail.plan);
    if (detail.kind === 'conversation') {
      // The composer's unsent text lives in the shell, not the controller's
      // view, so a re-render that is not a send keeps it (#3047); the shell
      // passes only the draft for this chat's own project.
      const draft = (extras && extras.draft) || '';
      const hoodOpen = Boolean(extras && extras.hoodOpen);
      const fleetArmed = Boolean(extras && extras.fleetArmed);
      const rename = (extras && extras.rename) || null;
      const sidebarCollapsed = Boolean(extras && extras.sidebarCollapsed);
      const activityElapsed = (extras && extras.activityElapsed) || '';
      const dismissedQuestions = (extras && extras.dismissedQuestions) || [];
      const pending = (extras && extras.pending) || null;
      const verbosity = (extras && extras.verbosity) || VERBOSITY_DEFAULT;
      const v = detail.view || {};
      // #3063: in a chat the telemetry bar shares the chat's header row.
      const telemetry = extras && 'telemetry' in extras ? extras.telemetry : undefined;
      return conversationViewMarkup(Object.assign({}, v, {
        chat: Object.assign({}, v.chat, { draft, hoodOpen, fleetArmed, sidebarCollapsed, activityElapsed, telemetry, rename, dismissedQuestions, pending, verbosity })
      }));
    }
    if (detail.kind === 'settings') return settingsViewMarkup(detail.view);
    if (detail.kind === 'recovery') return recoveryConsoleMarkup(detail.view);
    if (detail.kind === 'knowledge') return knowledgeBaseMarkup(detail.help);
    if (detail.kind === 'platform') return platformViewMarkup(detail.view);
    if (detail.kind === 'whatif') return whatIfMarkup(detail.view);
    if (detail.kind === 'loading') return '<p class="v6-detail-loading" role="status">Loading…</p>';
    if (detail.kind === 'error') return `<p class="v6-detail-error" role="alert">${escapeHtml(detail.message)}</p>`;
    return '';
  }

  /**
   * The Classic dashboard's admin controls that the v6 shell tucks into one
   * menu (#3079). Classic View, Master and Advisor stay in the bar.
   */
  const ADMIN_TUCK_IDS = Object.freeze([
    'portsToggle', 'usageToggle', 'groupsToggle', 'openclawToggle',
    'auditToggle', 'fleetRecoveryToggle', 'rulesToggle', 'signOutBtn'
  ]);

  /** Where each tucked control came from — its parent and the node after it — so it goes back exactly there. */
  const adminHomes = new Map();

  /**
   * Slim the top bar while the v6 shell shows (#3079): mark the body
   * `v6-shell-active`, and move the admin controls into an expandable
   * "More" menu at the end of `.dash-actions`. The controls are moved, not
   * copied, so each keeps its own listeners, badge and state; leaving the
   * shell puts each back where it was and removes the menu. Safe to call on
   * every render.
   * @param {Document} doc
   * @param {boolean} active - Whether the v6 shell is showing.
   * @returns {void}
   */
  function tuckAdminControls(doc, active) {
    if (!doc || typeof doc.getElementById !== 'function') return;
    if (doc.body && doc.body.classList) doc.body.classList.toggle('v6-shell-active', Boolean(active));
    let menu = doc.getElementById('v6AdminMenu');
    // Ruling A764: one top bar. The chat's header joins the dashboard bar,
    // and the dashboard's own stats go to the shell's footer (A765). The
    // stats move first, so the place they return to is before the bar's
    // actions, which never move, not before a header that comes and goes.
    moveDashStats(doc, active);
    dockChatHeader(doc, active);
    if (!active) {
      // Last first: each control's recorded next node is then back in place.
      ADMIN_TUCK_IDS.slice().reverse().forEach((id) => {
        const el = doc.getElementById(id);
        const home = adminHomes.get(id);
        if (!el || !home || !home.parent) return;
        if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(el, home.next);
        else home.parent.appendChild(el);
        adminHomes.delete(id);
      });
      if (menu && typeof menu.remove === 'function') menu.remove();
      return;
    }
    const actions = typeof doc.querySelector === 'function' ? doc.querySelector('.dash-actions') : null;
    if (!actions) return;
    if (!menu) {
      menu = doc.createElement('details');
      menu.id = 'v6AdminMenu';
      menu.className = 'v6-admin-menu';
      const summary = doc.createElement('summary');
      summary.className = 'dash-action v6-admin-menu-toggle';
      summary.textContent = '⋯ More';
      summary.title = 'Ports, Usage, Groups, OpenClaw, Audit, Recovery, Global Rules and Sign out';
      summary.setAttribute('aria-label', 'More dashboard controls');
      const panel = doc.createElement('div');
      panel.id = 'v6AdminMenuPanel';
      panel.className = 'v6-admin-menu-panel';
      // Choosing a control closes the menu; the control itself does the rest.
      panel.addEventListener('click', () => { menu.open = false; });
      menu.appendChild(summary);
      menu.appendChild(panel);
      actions.appendChild(menu);
      if (typeof doc._register === 'function') { doc._register(menu); doc._register(panel); }
    }
    const panel = doc.getElementById('v6AdminMenuPanel');
    if (!panel) return;
    ADMIN_TUCK_IDS.forEach((id) => {
      const el = doc.getElementById(id);
      if (!el || el.parentNode === panel) return;
      adminHomes.set(id, { parent: el.parentNode, next: el.nextSibling || null });
      panel.appendChild(el);
    });
  }

  /** Where `#dashStats` lives in the dashboard bar, so it goes back exactly there (A765). */
  let dashStatsHome = null;

  /**
   * Put the chat's header into the dashboard's top bar, before its actions
   * (Ruling A764), so the v6 chat has one bar, not two. A header docked
   * earlier gives way to the one the shell just drew; leaving the shell, or
   * a view with no chat, takes it out. Focus inside the header stays put.
   * @param {Document} doc
   * @param {boolean} active
   */
  function dockChatHeader(doc, active) {
    if (typeof doc.querySelector !== 'function') return;
    const bar = doc.querySelector('.dash-bar');
    if (!bar) return;
    const docked = typeof bar.querySelector === 'function' ? bar.querySelector('.v6-chat-header') : null;
    const main = doc.getElementById('v6ShellMain');
    const drawn = active && main && typeof main.querySelector === 'function' ? main.querySelector('.v6-chat-header') : null;
    if (docked && docked !== drawn && (drawn || !active)) docked.remove();
    if (!drawn) return;
    const actions = bar.querySelector('.dash-actions');
    const focus = doc.activeElement;
    if (actions && actions.parentNode === bar) bar.insertBefore(drawn, actions);
    else bar.appendChild(drawn);
    if (focus && focus.id && typeof drawn.contains === 'function' && drawn.contains(focus) && typeof focus.focus === 'function') focus.focus();
  }

  /**
   * Move the dashboard's CPU/MEM/DISK/UP stats into the shell's footer status
   * bar while the shell shows, and back to their exact place in the bar when
   * it does not (Ruling A765): moved, not copied, so the live readings keep
   * updating; never hidden, so they never leave the page.
   * @param {Document} doc
   * @param {boolean} active
   */
  function moveDashStats(doc, active) {
    const stats = doc.getElementById('dashStats');
    if (!stats) return;
    if (!active) {
      returnDashStats(doc);
      return;
    }
    const footer = doc.getElementById('v6ShellStatusBar');
    if (!footer || stats.parentNode === footer) return;
    // Where it is now is its home unless it is still in a status bar (one a
    // redraw orphaned): never an old home, which may belong to another page.
    const from = stats.parentNode;
    if (!(from && from.id === 'v6ShellStatusBar')) {
      const live = typeof stats.getAttribute === 'function' ? stats.getAttribute('aria-live') : null;
      dashStatsHome = { parent: from, next: stats.nextSibling || null, live };
    }
    // The status region announces its changes; the stats refresh every 30 s
    // and must not be read out each time.
    if (typeof stats.setAttribute === 'function') stats.setAttribute('aria-live', 'off');
    footer.appendChild(stats);
  }

  /**
   * Put `#dashStats` back in the dashboard bar (A765) — before the shell
   * redraws, since a redraw replaces the footer and would take the live
   * stats with it.
   * @param {Document} doc
   */
  function returnDashStats(doc) {
    const stats = doc.getElementById('dashStats');
    const home = dashStatsHome;
    if (!stats || !home || !home.parent) return;
    if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(stats, home.next);
    else home.parent.appendChild(stats);
    if (home.live !== null && home.live !== undefined) stats.setAttribute('aria-live', home.live);
    else if (typeof stats.removeAttribute === 'function') stats.removeAttribute('aria-live');
    dashStatsHome = null;
  }

  /**
   * The label the top-bar view switcher should carry for a route (#3022
   * deliverable a): it names where a click goes, not where you are.
   * @param {{view: string|null}|null} route
   * @returns {string}
   */
  function viewToggleLabel(route) {
    return route && route.view ? 'Classic View' : 'Fleet Shell (v6)';
  }

  /**
   * The D1 attestation to show for a project: the latest recorded
   * generation when one exists, otherwise a fallback read from the
   * project's own configured model and engine, marked `estimated` because
   * nothing observed it (#3022 deliverable e).
   * @param {Array<object>|null} history - `GET .../attestations`' `attestations`, oldest generation first.
   * @param {{model?: string|null, engine?: {id?: string, name?: string}|null}|null} project
   * @returns {object|null}
   */
  function pickAttestation(history, project) {
    const rows = Array.isArray(history) ? history : [];
    if (rows.length) return rows[rows.length - 1];
    if (!project) return null;
    const engine = project.engine || null;
    const requested = project.model || (engine && engine.id) || null;
    const observed = (engine && engine.name) || null;
    if (!requested && !observed) return null;
    return { requested_model: requested, observed_model: observed, confidence: 'estimated' };
  }

  /**
   * A project or fleet's Designated Delegate (#3047): who its chat talks to.
   * In order: the operator's configured delegate for this logical project,
   * while it is still one of its members; else its PM — a member named
   * `*-PM`, else one named `*-Master`, else one whose role is `pm`; else the first member with
   * a live session; else the first member.
   * @param {{id: *, fleets?: Array<{id: *, members?: Array<{seatId?: string, role?: string}>}>}|null} node -
   *   A logical project from {@link synthesizeTreeFromProjects} (or a native fleet tree).
   * @param {{projects?: Array<{id: *, name?: string, session?: {active?: *}|null}>,
   *   delegates?: Object<string, string>, fleetId?: *}} state - `fleetId` limits the choice to one fleet.
   * @returns {object|null} The delegate's project row.
   */
  function resolveDelegateProject(node, state) {
    if (!node) return null;
    const st = state || {};
    const rows = Array.isArray(st.projects) ? st.projects : [];
    const fleets = (Array.isArray(node.fleets) ? node.fleets : [])
      .filter((f) => st.fleetId == null || String(f.id) === String(st.fleetId));
    const members = [];
    fleets.forEach((f) => (Array.isArray(f.members) ? f.members : []).forEach((m) => {
      const row = rows.find((p) => p && String(p.id) === String(m && m.seatId));
      if (row && !members.some((x) => x.row === row)) members.push({ row, role: (m && m.role) || '' });
    }));
    if (!members.length) return null;
    const configured = st.delegates && st.delegates[node.id];
    const chosen = configured != null && members.find((m) => String(m.row.id) === String(configured));
    if (chosen) return chosen.row;
    // The operator's usual delegate is the PM, so a -PM member outranks a
    // -Master one rather than whichever sorts first.
    const named = (re) => members.find((m) => re.test(String(m.row.name || '')));
    const pm = named(/-PM$/i) || named(/-Master$/i)
      || members.find((m) => String(m.role).toLowerCase() === 'pm');
    if (pm) return pm.row;
    return (members.find((m) => m.row.session && m.row.session.active === true) || members[0]).row;
  }

  /**
   * The legacy project a route's detail pane should show (#3022 deliverable
   * e). A conversation route, or a project route naming a real project id,
   * resolves to that project directly. A synthesized Logical Project route
   * (`#/projects/tc-lane`, where the toolbar toggle lands) or a fleet route
   * (`#/projects/tc-lane/fleets/tc-lane`) resolves to that project's (or
   * fleet's) Designated Delegate (#3047) — so every route the sidebar or the
   * toggle produces has a project behind it.
   * @param {{view: string|null, projectId?: string, fleetId?: string, resourceId?: string}|null} route
   * @param {Array<{id: *, name?: string, session?: {active?: *}|null}>|null} projects - `GET /api/projects`' `projects`.
   * @param {Object<string, string>} [delegates] - Configured delegates, logical project id -> project id.
   * @returns {object|null} The project row, or null when the route names none.
   */
  function resolveRouteProject(route, projects, delegates) {
    const rows = Array.isArray(projects) ? projects : [];
    const byId = (id) => (id == null ? null : rows.find((p) => p && String(p.id) === String(id)) || null);
    if (!route) return null;
    if (route.view === 'conversation') return byId(route.resourceId);
    if (route.view !== 'project' && route.view !== 'fleet') return null;
    if (route.view === 'project') {
      const direct = byId(route.projectId);
      if (direct) return direct;
    }
    const node = synthesizeTreeFromProjects(rows).find((lp) => String(lp.id) === String(route.projectId));
    if (!node) return null;
    return resolveDelegateProject(node, {
      projects: rows, delegates, fleetId: route.view === 'fleet' ? route.fleetId : null
    });
  }

  /**
   * Wire a mounted shell to the live server (#3022 deliverables b–e): the
   * synthesized hierarchy tree, the B4 telemetry bar, the C2 template list
   * and plan preview, and per-route B2 conversation / D1 attestation
   * detail. Kept here rather than in `public/ui.js` so it runs under test
   * with injected fetchers; `ui.js` only supplies the page's own `api`.
   *
   * `handleRoute` is meant to be called from the shell's `onRender`, which
   * fires on EVERY re-render — including the ones this controller's own
   * `setTree`/`setTelemetry`/… calls cause — so it acts only when the route
   * itself changed. Every load is stamped with a sequence number and its
   * results are dropped if the route moved on while it was in flight, so a
   * slow response for an old route never overwrites the current one.
   *
   * @param {{getShell: () => object|null, api: (url: string) => Promise<object|null>,
   *   apiMutate: (url: string, method: string, body: object) => Promise<object|null>}} deps -
   *   `api`/`apiMutate` resolve to `null` on any failure (the page's own
   *   `tcCreateApi` contract).
   * @returns {{handleRoute: (route: object) => Promise<void>, launchTemplate: (templateId: string) => Promise<void>,
   *   enterHash: () => Promise<string>, getProjects: () => Array<object>|null}}
   */
  /**
   * The built-in what-if scenario the Platform view's action runs: two
   * trains on a two-lane Builder pool and one Reviewer, with a cross-train
   * dependency chain, so its result shows a critical path that spans both
   * trains (schema → api → view → review).
   */
  const SAMPLE_WHATIF_SCENARIO = Object.freeze({
    trains: [
      { id: 'core', cars: [{ id: 'schema', effort: 3, files: ['lib/store.js'] }, { id: 'api', effort: 2, files: ['server.js'], dependsOn: ['schema'] }] },
      { id: 'ui', cars: [{ id: 'view', effort: 2, files: ['public/app.js'], dependsOn: ['api'] }, { id: 'hotfix', effort: 1, files: ['server.js'] },
        { id: 'review', effort: 1, role: 'Reviewer', dependsOn: ['view'] }] }
    ],
    rolePools: { Builder: 2, Reviewer: 1 }
  });

  function createLiveController(deps) {
    const getShell = deps.getShell;
    const api = deps.api;
    const apiMutate = deps.apiMutate;
    const prefs = makePrefs(deps.storage !== undefined ? deps.storage
      : defaultStorage(typeof window !== 'undefined' ? window : null));
    const startTimer = deps.setInterval || (typeof setInterval === 'function' ? setInterval : null);
    const stopTimer = deps.clearInterval || (typeof clearInterval === 'function' ? clearInterval : null);
    let projects = null;
    let templatesLoaded = false;
    let lastRouteKey = null;
    let seq = 0;
    // The chat on screen (#3047): its project, session, route context and
    // the view last handed to the shell — what a send or a poll acts on.
    let current = null;
    let pollId = null;
    // #3057: a message the session received whose reply has not shown yet:
    // the chat reads as Working until the engine reports its own activity,
    // a new reply appears, or a few polls pass with neither.
    let awaitingReply = null;
    // #3066: what the history panel last showed, so a snapshot keeps the list beside it.
    let historyState = null;
    // Each history request's generation: an answer that arrives after a
    // newer request was made is dropped, so a slow search never overwrites a
    // newer one and a late list never closes a snapshot just opened (#3066).
    let historyGen = 0;
    // Set when a sidebar click leads to a different route (#3053), so that
    // route reloads the project rows before it shows anything.
    let freshNext = false;
    // #3053: files attached in each chat, by target project id, and the
    // means to read and upload them (injectable for tests).
    const attachments = new Map();
    // Names already uploaded per target this visit: the route overwrites a
    // file of the same name, so a name is never reused (#3053).
    const uploadedNames = new Map();
    let attachSeq = 0;
    const readFileAsBase64 = deps.readFileAsBase64 || defaultReadFileAsBase64;
    const textToBase64 = deps.textToBase64 || defaultTextToBase64;
    // #3079 item 6: per project, the message this chat last sent and
    // recorded (its send id, recorded text and whole text), until the pane
    // shows it, so it is drawn after the replies it followed.
    const lastSentByProject = new Map();
    // #3082: thumbnails of image attachments, one blob: URL (and one fetch in
    // flight) per (project, file), kept across polls so a poll neither
    // refetches the image nor revokes a URL a new tab is about to open;
    // released when the chat moves to another project, or on teardown (A752).
    const thumbCache = new Map();
    const createObjectURL = deps.createObjectURL
      || ((blob) => (global.URL && typeof global.URL.createObjectURL === 'function' ? global.URL.createObjectURL(blob) : null));
    const revokeObjectURL = deps.revokeObjectURL
      || ((url) => { if (global.URL && typeof global.URL.revokeObjectURL === 'function') global.URL.revokeObjectURL(url); });
    const fetchBytes = deps.fetch || ((url, init) => global.fetch(url, init));
    let thumbsReleaseHooked = false;
    // And the whole text of each long message this visit sent, per project
    // (the last few), so the pane's echo of one is known in full even after
    // its record, cut short, is all the events hold (#3079).
    const sentWhole = new Map();
    const SENT_WHOLE_KEPT = 10;
    let sendSeq = 0;
    // #3085: chat reads since the usage meter last refreshed.
    let usagePolls = 0;
    let usageActionsGiven = false;

    /**
     * Load the 3-engine usage meter's data (#3085, A753-1) and hand it, and
     * once its calibrate action, to the shell.
     * @returns {Promise<void>}
     */
    async function loadUsage() {
      const [windows, sessions] = await Promise.all([api('/api/usage/windows'), api('/api/usage/sessions')]);
      const sh = getShell();
      if (!sh || typeof sh.setUsage !== 'function' || !windows) return;
      if (!usageActionsGiven && typeof sh.setUsageActions === 'function') {
        sh.setUsageActions({ calibrate: calibrateUsage });
        usageActionsGiven = true;
      }
      sh.setUsage({ windows, sessions });
    }

    /**
     * Record the operator's "% left" for an engine (#3085, A753-1): the
     * Operator-only calibration route, with the operator proof
     * (`operatorHeaders`), as the secure-clipboard writes carry it — the
     * page's apiMutate adds it to one config call only, and an install with
     * its login off refuses this route without it.
     * @param {string} provider - `claude`, `codex` or `antigravity`.
     * @param {number} [weeklyPct]
     * @param {number} [fiveHourPct]
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async function calibrateUsage(provider, weeklyPct, fiveHourPct) {
      const body = { provider };
      if (weeklyPct !== undefined) body.weeklyPct = weeklyPct;
      if (fiveHourPct !== undefined) body.fiveHourPct = fiveHourPct;
      let res;
      try {
        const headers = await operatorHeaders();
        res = await api('/api/usage/calibrate', { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (err) { // prawduct:allow prawduct/broad-except -- a refused operator proof becomes the meter's error line, never an unhandled rejection
        return { ok: false, error: (err && err.message) || 'the operator proof could not be made' };
      }
      if (!res) return { ok: false, error: api.lastError || 'the server refused it' };
      await loadUsage();
      return { ok: true };
    }
    // Sends on their way, per project (#3082): a plain send waits while any is.
    const sendsInFlight = new Map();

    /**
     * Whether a send's chat is the one on screen (#3082): the same project,
     * whichever reload made the `current` showing it.
     * @param {{project: {id: *}}} chat
     * @returns {boolean}
     */
    function onScreen(chat) {
      return Boolean(current && chat && String(current.project.id) === String(chat.project.id));
    }

    /** @param {{project: {id: *}}} chat @returns {boolean} Whether a send to its project is on its way. */
    function inFlight(chat) {
      return (sendsInFlight.get(String(chat.project.id)) || 0) > 0;
    }
    const clock = typeof deps.now === 'function' ? deps.now : () => Date.now();
    // The secure-clipboard routes gate even their GET listing with operator
    // proof, and api()'s own CSRF header only rides on writes, so the token
    // is added here too, as public/secure-clipboard-ui.js does.
    const operatorHeaders = deps.operatorHeaders || (async () => {
      const headers = typeof global.tcOperatorProofHeaders === 'function'
        ? await global.tcOperatorProofHeaders(api)
        : { 'Content-Type': 'application/json' };
      const csrf = typeof global.tcCsrfToken === 'function' ? global.tcCsrfToken() : null;
      if (csrf) headers['X-CSRF-Token'] = csrf;
      return headers;
    });

    /** @returns {Object<string, string>} Configured delegates, logical project id -> project id. */
    function delegates() {
      return prefs.get('tc_v6_project_delegates', {}, isStringMap);
    }

    function stopPolling() {
      if (pollId != null && stopTimer) stopTimer(pollId);
      pollId = null;
    }

    /**
     * The live output panel for a peek response (`null` = it failed).
     * @param {{lines?: string[]}|null} res
     * @returns {{lines: string[]}|{error: string}}
     */
    function peekView(res) {
      return res && Array.isArray(res.lines) ? { lines: res.lines } : { error: 'the session did not answer' };
    }

    /**
     * The replies, question and activity a peek shows (#3052), read with the
     * project's own engine, leaving out prompts already recorded.
     * @param {{lines?: string[]}|null} res
     * @param {object} project
     * @param {Array<{role?: string, content?: string}>|null} events
     * @returns {object|null}
     */
    function liveView(res, project, events) {
      let live = null;
      const key = project ? String(project.id) : null;
      const sent = key != null ? lastSentByProject.get(key) : null;
      if (res && Array.isArray(res.lines)) {
        const engine = project && project.engine && project.engine.id ? String(project.engine.id) : '';
        const said = (Array.isArray(events) ? events : []).filter((e) => e && e.role === 'user').map((e) => e.content);
        // The whole of each long message sent, so its pane echo is known in full.
        said.push(...(sentWhole.get(key) || []));
        live = extractLiveTurns(res.lines, engine, said);
        // Once the pane shows it, it is placed by the pane.
        if (sent && live.turns.some((t) => t.role === 'user' && t.recorded && (sameMessage(sent.text, t.text) || sameMessage(sent.full, t.text)))) {
          lastSentByProject.delete(key);
        }
      }
      return awaitReply(live, project);
    }

    /**
     * The image files a chat's messages attach (#3082).
     * @param {Array<object>|null} events - Recorded events.
     * @param {{turns?: Array<{text: string}>}|null} live
     * @returns {string[]}
     */
    function attachedImages(events, live) {
      const texts = (Array.isArray(events) ? events : []).map((e) => e && e.content)
        .concat(live && Array.isArray(live.turns) ? live.turns.map((t) => t && t.text) : []);
      const names = new Set();
      texts.forEach((text) => String(text || '').split('\n').forEach((line) => {
        const m = ATTACHED_LINE.exec(line);
        if (m && IMAGE_NAME.test(m[1])) names.add(m[1]);
      }));
      return [...names];
    }

    /**
     * The thumbnails a chat can show now (#3082): file name → `blob:` URL for
     * each attached image already fetched; any not yet asked for is fetched,
     * and the chat redrawn when it arrives.
     * @param {object} project
     * @param {Array<object>|null} events
     * @param {object|null} live
     * @returns {Object<string, string>}
     */
    function thumbsFor(project, events, live) {
      const thumbs = {};
      hookThumbRelease();
      attachedImages(events, live).forEach((filename) => {
        const entry = thumbCache.get(thumbKey(project, filename));
        if (entry && entry.url) thumbs[filename] = entry.url;
        else if (!entry) fetchThumb(project, filename);
      });
      return thumbs;
    }

    /**
     * @param {{id: *}} project
     * @param {string} filename
     * @returns {string} The thumbnail cache key for one project's file (#3082).
     */
    function thumbKey(project, filename) {
      return `${String(project.id)}\u0001${filename}`;
    }

    /**
     * Fetch one attached image with the operator proof (it is in the
     * project's secrets store) and keep it as a `blob:` URL (#3082). A
     * refused or failed fetch is remembered too, so a poll does not retry it;
     * the line stays a file-name chip.
     * @param {object} project
     * @param {string} filename
     * @returns {Promise<void>}
     */
    async function fetchThumb(project, filename) {
      const key = thumbKey(project, filename);
      const entry = { projectId: String(project.id), url: null };
      thumbCache.set(key, entry);
      try {
        const headers = await operatorHeaders();
        const res = await fetchBytes(`/api/sessions/${encodeURIComponent(project.name)}/secure-clipboard/${encodeURIComponent(filename)}`,
          { method: 'GET', headers, credentials: 'same-origin' });
        if (!res || !res.ok || typeof res.blob !== 'function') return;
        const blob = await res.blob();
        if (thumbCache.get(key) !== entry) return;
        entry.url = createObjectURL(blob) || null;
      } catch (_err) { // prawduct:allow prawduct/broad-except -- a thumbnail that cannot be fetched stays a file-name chip; it must never break the chat
        return;
      }
      if (entry.url && current && String(current.project.id) === entry.projectId) showThumbs();
    }

    /** Hand the chat on screen its current thumbnails (#3082). */
    function showThumbs() {
      if (!current || !current.view) return;
      const thumbs = thumbsFor(current.project, current.view.events, current.view.chat && current.view.chat.live);
      current.view = Object.assign({}, current.view, { chat: Object.assign({}, current.view.chat, { thumbs }) });
      const sh = getShell();
      if (sh && typeof sh.setThumbs === 'function') sh.setThumbs(thumbs);
    }

    /**
     * Release every thumbnail not of `keepProjectId` (#3082): the chat moved
     * to another project, or (with none kept) the page is going.
     * @param {string|null} keepProjectId
     */
    function releaseThumbs(keepProjectId) {
      for (const [key, entry] of thumbCache) {
        if (keepProjectId != null && entry.projectId === keepProjectId) continue;
        if (entry.url) revokeObjectURL(entry.url);
        thumbCache.delete(key);
      }
    }

    /** Release them all when the shell is torn down (#3082), registered once. */
    function hookThumbRelease() {
      if (thumbsReleaseHooked) return;
      const sh = getShell();
      if (sh && typeof sh.onDestroy === 'function') {
        sh.onDestroy(() => releaseThumbs(null));
        thumbsReleaseHooked = true;
      }
    }

    /**
     * Seed the cache from a file the operator attached in this browser
     * (#3082): its own bytes, no fetch.
     * @param {object} project
     * @param {string} filename - The name it was saved under.
     * @param {Blob} file
     */
    function seedThumb(project, filename, file) {
      const key = thumbKey(project, filename);
      const known = thumbCache.get(key);
      // A fetched image is kept; a fetch still out, or one refused, gives way.
      if (!IMAGE_NAME.test(filename) || (known && known.url) || !file) return;
      const url = createObjectURL(file);
      if (url) thumbCache.set(key, { projectId: String(project.id), url });
    }

    /**
     * @param {object|null} project
     * @returns {{id: *, text: string}|null} What the chat last sent and recorded, until the pane shows it (#3079).
     */
    function lastSentFor(project) {
      const sent = project ? lastSentByProject.get(String(project.id)) : null;
      return sent ? { id: sent.id, text: sent.text } : null;
    }

    /**
     * The Medusa indicator's reading (#3076): the listener's status, and the
     * traffic the pane shows. Traffic blinks a head only against the reading
     * before it — more unread or more wakes in, more sends out — so the
     * first reading of a chat, and mail that predates it, never blink.
     * @param {{state?: string, unread?: number, enabled?: boolean, lastError?: string|null}|null} status
     * @param {{switchboard?: Array<{dir: string}>}|null} live
     * @param {object|null} prev - The reading before this one.
     * @returns {object|null} `null` until a status answers; a failed read keeps the last one, still.
     */
    function medusaView(status, live, prev) {
      if (!status || typeof status !== 'object') return prev ? Object.assign({}, prev, { flowIn: false, flowOut: false }) : null;
      const traffic = live && Array.isArray(live.switchboard) ? live.switchboard : [];
      const inbound = traffic.filter((x) => x && x.dir === 'in').length;
      const outbound = traffic.filter((x) => x && x.dir === 'out').length;
      const unread = Math.max(0, Number(status.unread) || 0);
      return {
        state: typeof status.state === 'string' ? status.state : 'off',
        unread,
        enabled: status.enabled,
        lastError: status.lastError || null,
        inbound,
        outbound,
        flowIn: Boolean(prev) && (unread > prev.unread || inbound > prev.inbound),
        flowOut: Boolean(prev) && outbound > prev.outbound
      };
    }

    /**
     * @param {{turns?: Array<{role: string, text: string}>}|null} live
     * @returns {string|null} The newest assistant reply the pane shows.
     */
    function lastReply(live) {
      const turns = live && Array.isArray(live.turns) ? live.turns : [];
      for (let i = turns.length - 1; i >= 0; i--) if (turns[i] && turns[i].role === 'assistant') return turns[i].text;
      return null;
    }

    /**
     * Keep a just-sent chat busy (#3057) until its engine takes over: the
     * engine's own activity or a new reply ends the wait, and so do
     * {@link AWAIT_REPLY_POLLS} reads with neither, so it never sticks.
     * @param {object|null} live - What the pane shows.
     * @param {object} project - The chat's target.
     * @returns {object|null} `live`, reading `Working` while the wait lasts.
     */
    function awaitReply(live, project) {
      const wait = awaitingReply;
      if (!wait || !project || String(project.id) !== wait.projectId) return live;
      if ((live && live.activity) || lastReply(live) !== wait.reply || wait.reads >= AWAIT_REPLY_POLLS) {
        awaitingReply = null;
        return live;
      }
      wait.reads += 1;
      return Object.assign({ turns: [], question: null }, live, { activity: 'Working' });
    }

    /**
     * Who a route's chat is with, and how it was reached: a project or
     * fleet route talks to that group's delegate, anything else directly to
     * the member it names (#3047).
     * @param {object} route
     * @param {object} project - The row {@link resolveRouteProject} chose.
     * @returns {{mode: string, nodeId: *, nodeName: string, fleetId: *, members: Array<{id: string, name: string}>,
     *   delegate: {id: string, name: string}|null}}
     */
    function chatContext(route, project) {
      const rows = projects || [];
      const tree = synthesizeTreeFromProjects(rows);
      const viaGroup = (route.view === 'project' || route.view === 'fleet')
        && !rows.some((p) => p && String(p.id) === String(route.projectId));
      const node = viaGroup
        ? tree.find((n) => String(n.id) === String(route.projectId))
        : tree.find((n) => n.fleets.some((f) => f.members.some((m) => String(m.seatId) === String(project.id))));
      const fleetId = viaGroup && route.view === 'fleet' ? route.fleetId : null;
      const memberRows = node
        ? node.fleets.filter((f) => fleetId == null || String(f.id) === String(fleetId))
          .flatMap((f) => f.members.map((m) => rows.find((p) => p && String(p.id) === String(m.seatId))).filter(Boolean))
        : [];
      const delegate = node ? resolveDelegateProject(node, { projects: rows, delegates: delegates(), fleetId }) : null;
      return {
        mode: viaGroup ? 'delegate' : 'direct',
        nodeId: node ? node.id : null,
        nodeName: node ? node.displayName : '',
        fleetId,
        members: memberRows.map((p) => ({
          id: String(p.id), name: String(p.name || ''), live: Boolean(p.session && p.session.active === true)
        })),
        delegate: delegate ? { id: String(delegate.id), name: String(delegate.name || '') } : null
      };
    }

    async function loadProjects() {
      const data = await api('/api/projects');
      if (data && Array.isArray(data.projects)) projects = data.projects;
      return projects;
    }

    /**
     * Load one project's chat (#3047): its session status, and for a live
     * session its B2 events, attestations and live output, then poll the
     * live output while it stays on screen.
     * @param {object} project
     * @param {number} mine - The route generation this load belongs to.
     * @param {ReturnType<typeof chatContext>} ctx
     * @param {{kind: string, message: string}|null} [sendOutcome] - A send result to show.
     * @returns {Promise<void>}
     */
    async function loadConversation(project, mine, ctx, sendOutcome) {
      stopPolling();
      const shell = getShell();
      const name = encodeURIComponent(project.name);
      const status = await api(`/api/sessions/${name}/status`);
      if (mine !== seq) return;
      const sessionId = status && status.active && status.sessionId != null ? status.sessionId : null;
      const chat = Object.assign({}, ctx, {
        status: sessionId == null ? 'offline' : (status.idle ? 'idle' : 'active'),
        send: sendOutcome || null,
        inFlight: (sendsInFlight.get(String(project.id)) || 0) > 0
      });
      current = { project, sessionId, launchId: (status && status.launchId) || null, ctx, mine, view: null };
      if (sessionId == null) {
        current.view = { project, sessionId: null, chat };
        shell.setAttestation(pickAttestation(null, project));
        showChat(shell);
        // #3053: an offline chat watches its status, so a session started
        // anywhere turns it Active without a click.
        if (startTimer) {
          // One check at a time: a slow status read must not overlap the next
          // tick, or two loads could each start a poll and leave one stray.
          let checking = false;
          pollId = startTimer(async () => {
            if (mine !== seq) { stopPolling(); return; }
            if (checking) return;
            checking = true;
            try {
              const now = await api(`/api/sessions/${name}/status`);
              if (mine !== seq || !(now && now.active && now.sessionId != null)) return;
              stopPolling();
              await loadConversation(project, mine, ctx);
            } finally {
              checking = false;
            }
          }, CHAT_POLL_MS);
        }
        return;
      }
      const base = `/api/v6/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(sessionId)}`;
      const peekUrl = `/api/sessions/${name}/peek?lines=80`;
      // #3076: the listener's state and unread count. Unlike opening the
      // inbox, this read marks nothing read and leaves the unread count
      // alone; while listening, the route also asks the Bridge for loops.
      const medusaUrl = `/api/sessions/${name}/medusa/status`;
      const [events, attestations, peek, medusaStatus] = await Promise.all([
        api(`${base}/conversation/events`),
        api(`${base}/attestations`),
        api(peekUrl),
        api(medusaUrl)
      ]);
      if (mine !== seq) return;
      chat.peek = peekView(peek);
      chat.live = liveView(peek, project, events && events.events);
      chat.lastSent = lastSentFor(project);
      releaseThumbs(String(project.id));
      chat.thumbs = thumbsFor(project, events && events.events, chat.live);
      chat.medusa = medusaView(medusaStatus, chat.live, null);
      current.view = events
        ? { project, sessionId, events: events.events, chat }
        : { project, sessionId, error: 'Could not load this session’s conversation events.', chat };
      shell.setAttestation(pickAttestation(attestations && attestations.attestations, project));
      showChat(shell);
      if (startTimer) {
        pollId = startTimer(async () => {
          if (mine !== seq) { stopPolling(); return; }
          // #3085: the usage meter refreshes every USAGE_EVERY_POLLS reads.
          usagePolls = (usagePolls + 1) % USAGE_EVERY_POLLS;
          if (usagePolls === 0) loadUsage();
          const [res, nextStatus] = await Promise.all([api(peekUrl), api(medusaUrl)]);
          if (mine !== seq || !current || !current.view) return;
          const next = peekView(res);
          const nextLive = liveView(res, current.project, current.view.events);
          const nextMedusa = medusaView(nextStatus, nextLive, current.view.chat && current.view.chat.medusa);
          const lastSent = lastSentFor(current.project);
          const thumbs = thumbsFor(current.project, current.view.events, nextLive);
          current.view = Object.assign({}, current.view, { chat: Object.assign({}, current.view.chat, { peek: next, live: nextLive, medusa: nextMedusa, lastSent, thumbs }) });
          const sh = getShell();
          if (sh && typeof sh.setLive === 'function') sh.setLive({ peek: next, live: nextLive, medusa: nextMedusa, lastSent, thumbs });
          else if (sh && typeof sh.setPeek === 'function') sh.setPeek(next);
        }, CHAT_POLL_MS);
      }
    }

    /**
     * Hand the chat on screen to the shell, with its attachment chips: they
     * belong to the target project, not to the view a load built.
     * @param {object} shell
     */
    function showChat(shell) {
      if (!current || !current.view || !shell) return;
      current.view = Object.assign({}, current.view, {
        chat: Object.assign({}, current.view.chat, { attachments: (attachments.get(String(current.project.id)) || []).slice() })
      });
      shell.setDetail({ kind: 'conversation', view: current.view });
    }

    /** Re-render the chat on screen with a send outcome line. */
    function showSend(outcome) {
      const shell = getShell();
      if (!current || !current.view || !shell) return;
      current.view = Object.assign({}, current.view, { chat: Object.assign({}, current.view.chat, { send: outcome }) });
      showChat(shell);
    }

    /**
     * Record a sent message as a B2 user event (Tier A, `v6-chat-ui`), at
     * the next seq after every event the session holds — soft-deleted ones
     * too, since their seq stays taken — retrying once if another writer
     * took that seq first.
     * @param {object} chat - `current` at send time.
     * @param {string} message
     * @returns {Promise<true|string>} true, or why it could not be recorded.
     */
    async function recordUserEvent(chat, message) {
      const base = `/api/v6/projects/${encodeURIComponent(chat.project.id)}/sessions/${encodeURIComponent(chat.sessionId)}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const all = await api(`${base}/conversation/events?includeDeleted=1`);
        const seqs = (all && Array.isArray(all.events) ? all.events : [])
          .map((e) => Number(e && e.seq)).filter((n) => Number.isSafeInteger(n));
        const next = (seqs.length ? Math.max(...seqs) : 0) + 1;
        const ok = await apiMutate(`${base}/conversation/events`, 'POST', {
          launchId: chat.launchId || 'v6-chat-ui', seq: next, tier: 'A', adapter: 'v6-chat-ui', role: 'user', content: message
        });
        if (ok) return true;
        if (api.lastErrorCode !== 'SEQ_CONFLICT') return api.lastError || 'the server refused it';
      }
      return api.lastError || 'another writer kept taking the next sequence number';
    }

    /**
     * Send the operator's message to the chat's session (#3047): type it in
     * through the session command route, then record it in the B2
     * conversation, then reload. A refusal (a held lane, a startup gate, no
     * pane) is shown with the server's own reason and the text is kept.
     * @param {string} text
     * @returns {Promise<void>}
     */
    async function sendChat(text, flags) {
      const typed = String(text || '').trim();
      const chat = current;
      // #3082 (Ruling A757): a Force Send carries its flags, as the second
      // argument or from the shell when the page passes the text alone, and
      // does not wait for a send already in flight.
      const shell = getShell();
      const given = flags || (shell && typeof shell.takeSendFlags === 'function' ? shell.takeSendFlags() : null);
      const forced = Boolean(given && given.priority === true);
      if (!chat || !shell) return;
      if (inFlight(chat) && !forced) {
        showSend({ kind: 'warning', message: `Not sent yet: the last message to ${chat.project.name} is still on its way. Use ⚡ Force to send this one now.` });
        return;
      }
      const files = attachments.get(String(chat.project.id)) || [];
      const ready = files.filter((a) => a.status === 'ready');
      const uploading = files.filter((a) => a.status === 'uploading').length;
      if (!typed && !ready.length && !uploading) return;
      const name = String(chat.project.name || '');
      if (chat.sessionId == null) {
        showSend({ kind: 'error', message: `Not sent: ${name} has no live session.` });
        return;
      }
      if (uploading) {
        showSend({ kind: 'error', message: `Not sent: wait for ${uploading} upload${uploading === 1 ? '' : 's'} to finish.` });
        return;
      }
      // Each attachment is referenced by the path the server saved it at, so
      // the agent can open it; the text and the list are separated by a blank line.
      const refs = ready.map((a) => `Attached: ${a.relPath}`).join('\n');
      const message = typed && refs ? `${typed}\n\n${refs}` : (typed || refs);
      // Counted per project, not on `current`: a forced send that finishes
      // reloads the chat (a new `current`) while the first may still be on
      // its way, and neither that reload nor the forced send's own end may
      // let a plain send through meanwhile.
      const key = String(chat.project.id);
      sendsInFlight.set(key, (sendsInFlight.get(key) || 0) + 1);
      try {
        await deliverChat(chat, message, name, String(text || ''), forced);
      } finally {
        const left = (sendsInFlight.get(key) || 1) - 1;
        if (left > 0) sendsInFlight.set(key, left); else sendsInFlight.delete(key);
        // The last one landed: Send is free again on the chat showing it.
        if (!left && onScreen(chat) && current.view) {
          current.view = Object.assign({}, current.view, { chat: Object.assign({}, current.view.chat, { inFlight: false }) });
          showChat(getShell());
        }
      }
    }

    /**
     * The send itself, once {@link sendChat} has claimed it.
     * @param {object} chat - `current` at send time.
     * @param {string} message
     * @param {string} name - The target project's name.
     * @param {string} draft - The composer's text, put back if the send fails.
     * @param {boolean} [forced] - A Force Send (#3082): the command carries
     *   `priority` and `startupIntervention`; the server still refuses at an
     *   engine startup dialog, a running wrap, or a HOLD/STOP (Ruling A757).
     * @returns {Promise<void>}
     */
    async function deliverChat(chat, message, name, draft, forced) {
      // #3079 item 6: the composer empties as Enter is pressed, and the
      // message waits at the bottom of the chat until the send settles.
      const sendId = ++sendSeq;
      const pid = chat.project.id;
      const begun = getShell();
      if (begun && typeof begun.beginSend === 'function') begun.beginSend(pid, message, sendId);
      const settle = (restore) => {
        const sh = getShell();
        if (sh && typeof sh.endSend === 'function') sh.endSend(pid, restore, sendId);
      };
      showSend({ kind: 'pending', message: `Sending to ${name}…` });
      const before = chat.view && chat.view.chat ? lastReply(chat.view.chat.live) : null;
      // #3079: the command route takes at most MAX_COMMAND_CHARS; a longer
      // message is saved to a file first and the session is pointed at it.
      // So is a message whose recorded event would be too heavy for the
      // events route (A739): the record then keeps its start and the path.
      let command = message;
      let toRecord = message;
      const launchId = chat.launchId || 'v6-chat-ui';
      if (message.length > MAX_COMMAND_CHARS || eventBodyBytes(message, launchId) > MAX_EVENT_BODY_BYTES) {
        const saved = await saveLongPrompt(chat, message);
        if (!saved.ok) {
          settle(draft);
          if (onScreen(chat)) showSend({ kind: 'error', message: `Not sent: ${saved.error}` });
          return;
        }
        if (message.length > MAX_COMMAND_CHARS) command = longPromptCommand(message, saved.relPath);
        toRecord = recordedText(message, saved.relPath, launchId);
      }
      const body = forced ? { command, enter: true, priority: true, startupIntervention: true } : { command, enter: true };
      const commandUrl = `/api/sessions/${encodeURIComponent(name)}/command`;
      // A priority command needs the operator's full write proof (the route
      // refuses an install with the login off without its open token), which
      // apiMutate does not carry; a plain command asks for none.
      let sent;
      let proofError = null;
      if (forced) {
        try {
          const headers = await operatorHeaders();
          sent = await api(commandUrl, { method: 'POST', headers, body: JSON.stringify(body) });
        } catch (err) { // prawduct:allow prawduct/broad-except -- a refused operator proof becomes the chat's "Not sent" line, never an unhandled rejection
          sent = null;
          proofError = (err && err.message) || 'the operator proof could not be made';
        }
      } else {
        sent = await apiMutate(commandUrl, 'POST', body);
      }
      if (sent) awaitingReply = { projectId: String(chat.project.id), reply: before, reads: 0 };
      // Once it is in the session the draft is spent, even if the operator
      // has moved to another chat meanwhile: left saved, it would come back
      // pre-filled and one Enter would send it twice.
      const shellNow = getShell();
      if (sent && shellNow && typeof shellNow.clearChatDraft === 'function') shellNow.clearChatDraft(chat.project.id);
      if (sent) attachments.delete(String(chat.project.id));
      if (!sent) {
        settle(draft);
        if (onScreen(chat)) showSend({ kind: 'error', message: `Not sent: ${proofError || api.lastError || 'the server refused it'}` });
        return;
      }
      // A delivered message is recorded against the chat it was sent from,
      // even if the operator has moved on: the conversation must not lose
      // what the session received. Only the on-screen update waits on the
      // operator still being here.
      const recorded = await recordUserEvent(chat, toRecord);
      if (recorded === true) lastSentByProject.set(String(pid), { id: sendId, text: toRecord, full: message });
      if (toRecord !== message) {
        const whole = (sentWhole.get(String(pid)) || []).concat(message).slice(-SENT_WHOLE_KEPT);
        sentWhole.set(String(pid), whole);
      }
      if (!onScreen(chat)) { settle(); return; }
      await loadConversation(chat.project, chat.mine, chat.ctx, recorded === true
        ? { kind: 'ok', message: `Sent to ${name}.` }
        : { kind: 'warning', message: `Sent to ${name}, but it could not be recorded in the conversation: ${recorded}` });
      settle();
    }

    /**
     * Save a message too long for the command route as a file in the target
     * project's secrets store (#3079), through the same secure-clipboard
     * route and operator proof attachments use.
     * @param {object} chat - `current` at send time.
     * @param {string} message
     * @returns {Promise<{ok: true, relPath: string}|{ok: false, error: string}>}
     */
    async function saveLongPrompt(chat, message) {
      let text;
      try {
        text = textToBase64(message);
      } catch (err) { // prawduct:allow prawduct/broad-except -- a browser that cannot encode the text refuses the send with its reason, never an unhandled rejection
        return { ok: false, error: `the long message could not be prepared (${(err && err.message) || 'unknown error'}).` };
      }
      // The file is the message's UTF-8 bytes (not the base64
      // length, whose padding over-counts by up to two bytes).
      if (utf8Length(message) > MAX_ATTACH_BYTES) {
        return { ok: false, error: `the message is over the 5 MB limit for a saved prompt.` };
      }
      // The route overwrites a file of the same name, so the name is chosen
      // against what the project already holds, and an unreadable listing
      // saves nothing (#3055), as for attachments.
      const base = `/api/sessions/${encodeURIComponent(chat.project.name)}/secure-clipboard`;
      const key = String(chat.project.id);
      let res;
      let filename;
      try {
        const headers = await operatorHeaders();
        const listing = await api(base, { method: 'GET', headers });
        const stored = listing && Array.isArray(listing.files) ? listing.files.map((f) => f && f.filename).filter(Boolean) : null;
        if (stored === null) {
          return { ok: false, error: `the long message was not saved: the project's saved files could not be checked (${api.lastError || 'the server did not answer'}), so a file of the same name could be overwritten.` };
        }
        const used = uploadedNames.get(key) || new Set();
        uploadedNames.set(key, used);
        const taken = new Set([...used, ...stored, ...(attachments.get(key) || []).map((a) => a.name)]);
        filename = sanitizeUploadName(`prompt-${clock()}.md`, taken);
        used.add(filename);
        res = await api(base, {
          method: 'POST', headers, body: JSON.stringify({ text, mode: 'file', filename, encoding: 'base64' })
        });
      } catch (err) { // prawduct:allow prawduct/broad-except -- a refused operator proof or a failed request refuses the send with its reason, never an unhandled rejection
        return { ok: false, error: `the long message could not be saved for the session: ${(err && err.message) || 'unknown error'}` };
      }
      if (!res) return { ok: false, error: `the long message could not be saved for the session: ${api.lastError || 'the server refused it'}` };
      return { ok: true, relPath: projectRelative(res.relPath, filename) };
    }

    /**
     * Load and render a `#/settings/...` route (v6.1.0): `help` is
     * contextual help for this shell, `recovery/<projectId>` one project's
     * Recovery Console, and anything else the Settings & Profiles view.
     * @param {{settingsPath: string}} route
     * @param {number} mine - The route generation this load belongs to.
     * @returns {Promise<void>}
     */
    async function loadSettings(route, mine) {
      const shell = getShell();
      const sub = route.settingsPath || '';
      if (sub === 'help') {
        const help = await api('/api/v6/kb/contextual-help?surface=' + encodeURIComponent('public/v6-shell.js'));
        if (mine !== seq) return;
        shell.setDetail({ kind: 'knowledge', help: help || { error: 'Could not load help for this screen.' } });
        return;
      }
      if (sub === 'platform') {
        const [providers, medusa, sandboxing] = await Promise.all([
          api('/api/v6/providers/g2b'), api('/api/v6/medusa-v2/status'), api('/api/v6/sandboxing/status')
        ]);
        if (mine !== seq) return;
        shell.setDetail({ kind: 'platform', view: { providers, medusa, sandboxing } });
        return;
      }
      if (sub === 'whatif') {
        const result = await apiMutate('/api/v6/whatif/simulate', 'POST', { scenario: SAMPLE_WHATIF_SCENARIO });
        if (mine !== seq) return;
        shell.setDetail({ kind: 'whatif', view: result ? { result } : { error: 'Could not run the simulation.' } });
        return;
      }
      const recovery = /^recovery\/(\d+)$/.exec(sub);
      if (recovery) {
        const consoleData = await api(`/api/v6/projects/${encodeURIComponent(recovery[1])}/recovery-console`);
        if (mine !== seq) return;
        shell.setDetail({ kind: 'recovery', view: { projectId: recovery[1], console: consoleData } });
        return;
      }
      const [profiles, catalog, walkthroughs] = await Promise.all([
        api('/api/v6/operating-profiles'),
        api('/api/v6/settings/catalog'),
        api('/api/v6/walkthroughs?includeUnverified=1')
      ]);
      if (mine !== seq) return;
      shell.setDetail({ kind: 'settings', view: { profiles, catalog, walkthroughs, projects: projects || [] } });
    }

    async function handleRoute(route) {
      // The shell's first render runs inside tcCreateV6Shell itself, before
      // the caller holds the returned handle; leave the route unrecorded so
      // the next call (the caller's own kick-off) still loads it.
      const shell = getShell();
      if (!shell) return;
      const key = route && route.view ? JSON.stringify(route) : null;
      if (key === lastRouteKey) return;
      if (key !== null) loadUsage();
      const entering = lastRouteKey === null;
      lastRouteKey = key;
      const mine = ++seq;
      stopPolling();
      current = null;
      if (!key) return;
      if (entering || !projects || freshNext) {
        freshNext = false;
        await loadProjects();
        if (mine !== seq) return;
        showProjects(shell);
        await loadEngineHealth(shell);
        if (mine !== seq) return;
      }
      if (entering) {
        const scopeId = encodeURIComponent(route.projectId || route.resourceId || 'global');
        const bar = await api(`/api/v6/projects/${scopeId}/telemetry?scope=global`);
        if (mine !== seq) return;
        shell.setTelemetry(bar);
      }
      if (!templatesLoaded) {
        const res = await api('/api/v6/fleet-templates');
        if (mine !== seq) return;
        if (res && Array.isArray(res.templates)) {
          templatesLoaded = true;
          shell.setTemplates(res.templates);
        }
      }
      if (route.view === 'settings') {
        shell.setAttestation(null);
        shell.setDetail({ kind: 'loading' });
        await loadSettings(route, mine);
        return;
      }
      await loadRouteDetail(route, mine);
    }

    /**
     * The detail pane for a project, fleet or conversation route.
     * @param {object} route
     * @param {number} mine
     * @returns {Promise<void>}
     */
    async function loadRouteDetail(route, mine) {
      const shell = getShell();
      const project = resolveRouteProject(route, projects, delegates());
      if (!project) {
        shell.setAttestation(null);
        shell.setDetail(route.view === 'conversation'
          ? { kind: 'conversation', view: { project: null } }
          : null);
        return;
      }
      shell.setDetail({ kind: 'loading' });
      await loadConversation(project, mine, chatContext(route, project));
    }

    /**
     * Attach files to the chat on screen (#3053): each is named for the
     * secure-clipboard route, refused on its chip when over 5 MB, and
     * otherwise uploaded into the target project's secrets store
     * (`POST /api/sessions/:project/secure-clipboard`, with the page's
     * operator proof), its chip turning ready with the saved path or showing
     * the server's reason.
     * @param {Array<{name?: string, size?: number}>} files
     * @returns {Promise<void>}
     */
    async function attachFiles(files) {
      const chat = current;
      const shell = getShell();
      if (!chat || !shell) return;
      const key = String(chat.project.id);
      const list = attachments.get(key) || [];
      attachments.set(key, list);
      const used = uploadedNames.get(key) || new Set();
      uploadedNames.set(key, used);
      // The project's secrets store may hold files from earlier visits too.
      // If it cannot be listed, no name is known to be free and the route
      // overwrites a file of the same name, so nothing is uploaded.
      let stored = null;
      let listError = null;
      try {
        const headers = await operatorHeaders();
        const res = await api(`/api/sessions/${encodeURIComponent(chat.project.name)}/secure-clipboard`, { method: 'GET', headers });
        stored = res && Array.isArray(res.files) ? res.files.map((f) => f && f.filename).filter(Boolean) : null;
        if (stored === null) listError = api.lastError || 'the server did not answer';
      } catch (err) { // prawduct:allow prawduct/broad-except -- an unreadable listing fails every attachment closed below, with its reason
        stored = null;
        listError = (err && err.message) || 'the listing could not be read';
      }
      const unverified = stored === null;
      if (unverified) stored = [];
      const taken = new Set(list.map((a) => a.name).concat([...used], stored));
      const uploads = [];
      (Array.isArray(files) ? files : []).forEach((file) => {
        const item = { id: ++attachSeq, name: sanitizeUploadName(file && file.name, taken), status: 'uploading' };
        taken.add(item.name);
        used.add(item.name);
        list.push(item);
        if (!(Number(file && file.size) <= MAX_ATTACH_BYTES)) {
          item.status = 'error';
          item.error = 'Over the 5 MB limit for an attachment.';
          return;
        }
        if (unverified) {
          item.status = 'error';
          item.error = `Not uploaded: the project's existing attachments could not be checked (${listError}), so a file with this name could be overwritten.`;
          return;
        }
        uploads.push(uploadAttachment(chat.project, key, item, file));
      });
      if (chat === current) showChat(shell);
      await Promise.all(uploads);
    }

    /**
     * Upload one attachment and settle its chip, unless the operator has
     * removed it meanwhile (then the result is dropped).
     * @returns {Promise<void>}
     */
    async function uploadAttachment(project, key, item, file) {
      let outcome;
      try {
        const text = await readFileAsBase64(file);
        const headers = await operatorHeaders();
        const res = await api(`/api/sessions/${encodeURIComponent(project.name)}/secure-clipboard`, {
          method: 'POST', headers, body: JSON.stringify({ text, mode: 'file', filename: item.name, encoding: 'base64' })
        });
        outcome = res
          ? { status: 'ready', relPath: projectRelative(res.relPath, item.name) }
          : { status: 'error', error: api.lastError || 'The server refused this file.' };
        if (res) seedThumb(project, item.name, file);
      } catch (err) { // prawduct:allow prawduct/broad-except -- a file the browser cannot read (permissions, a vanished file) becomes the chip's error, not an unhandled rejection
        outcome = { status: 'error', error: `Could not read this file: ${err && err.message ? err.message : 'unknown error'}` };
      }
      const list = attachments.get(key) || [];
      const live = list.find((a) => a.id === item.id);
      if (!live) return;
      Object.assign(live, outcome);
      if (current && String(current.project.id) === key) showChat(getShell());
    }

    /**
     * Remove the chat on screen's attachment at `index`.
     * @param {number} index
     */
    function removeAttachment(index) {
      if (!current) return;
      const list = attachments.get(String(current.project.id)) || [];
      if (index >= 0 && index < list.length) list.splice(index, 1);
      showChat(getShell());
    }

    /**
     * Reload the route on screen with fresh project rows — the chat's
     * Refresh, and what a delegate change needs to take effect.
     * @returns {Promise<void>}
     */
    async function refresh() {
      const shell = getShell();
      if (!shell) return;
      const route = shell.getRoute();
      if (!route || !route.view || route.view === 'settings') return;
      const mine = ++seq;
      stopPolling();
      await loadProjects();
      if (mine !== seq) return;
      showProjects(shell);
      await loadEngineHealth(shell);
      if (mine !== seq) return;
      await loadRouteDetail(route, mine);
    }

    /**
     * Hand the shell the engines' health for its sidebar badges (#3053); a
     * failed read leaves the badges' health unknown.
     * @param {object} shell
     * @returns {Promise<void>}
     */
    async function loadEngineHealth(shell) {
      if (typeof shell.setEngineHealth !== 'function') return;
      const res = await api('/api/models/status');
      if (res && res.status && typeof res.status === 'object') shell.setEngineHealth(res.status);
    }

    /**
     * Hand the loaded project rows to the shell: its sidebar tree, and the
     * rows its filters read (setProjects arrived with those filters, #3046;
     * an older shell handle without it just gets no engine filter data).
     * @param {object} shell
     */
    function showProjects(shell) {
      if (!projects) return;
      if (typeof shell.setProjects === 'function') shell.setProjects(projects);
      shell.setTree(synthesizeTreeFromProjects(projects));
    }

    /**
     * A sidebar link was clicked (#3053): the same route refreshes now; any
     * other reloads the project rows when its hashchange arrives.
     * @param {string} hash
     * @returns {Promise<void>}
     */
    async function treeLinkClicked(hash) {
      const shell = getShell();
      if (!shell) return;
      if (String(hash) === routeHash(shell.getRoute())) {
        await refresh();
        return;
      }
      freshNext = true;
    }

    /**
     * Start the chat's offline target (#3053) and reload it in place. A
     * refusal (stranded wraps to acknowledge, an engine that cannot start)
     * shows the server's reason, and the banner links to Classic View for the
     * cases that need its launch dialogs.
     * @returns {Promise<void>}
     */
    async function startSession() {
      const chat = current;
      if (!chat || !getShell()) return;
      showSend({ kind: 'pending', message: `Starting ${chat.project.name}…` });
      const ok = await apiMutate(`/api/sessions/${encodeURIComponent(chat.project.name)}`, 'POST', {});
      if (chat !== current) return;
      if (!ok) {
        showSend({ kind: 'error', message: `Not started: ${api.lastError || 'the server refused it'}` });
        return;
      }
      await refresh();
    }

    /**
     * Who the history panel searches (#3066): the chat's member, or every
     * member of its group (a project in no group is a fleet of one).
     * @param {string} scope - 'member' or 'fleet'.
     * @returns {Array<string>} Project names.
     */
    function historyTargets(scope) {
      const name = String(current.project.name || '');
      const members = current.ctx && Array.isArray(current.ctx.members) ? current.ctx.members.map((m) => m.name).filter(Boolean) : [];
      return scope === 'fleet' && members.length ? members : [name];
    }

    /**
     * Load the history panel (#3066): with no query, the targets' recent
     * sessions, newest first; with one, each target's search, merged with
     * the best matches first. A target that fails is named in a note rather
     * than failing the rest.
     * @param {{scope: string, kind: string, q: string}} form
     * @returns {Promise<void>}
     */
    async function loadHistory(form) {
      const chat = current;
      const shell = getShell();
      if (!chat || !shell || typeof shell.setHistory !== 'function') return;
      const gen = ++historyGen;
      const f = form || {};
      const q = String(f.q || '').trim();
      const targets = historyTargets(f.scope);
      const fleet = { name: (chat.ctx && chat.ctx.nodeName) || '', count: historyTargets('fleet').length };
      const notes = [];
      const lists = await Promise.all(targets.map(async (member) => {
        const base = `/api/continuity/${encodeURIComponent(member)}`;
        const url = q ? `${base}/search?q=${encodeURIComponent(q)}${f.kind === 'transcripts' ? '&scope=transcripts' : ''}` : `${base}/sessions`;
        const res = await api(url);
        if (!res || !Array.isArray(res.sessions)) {
          notes.push(`Could not read ${member}'s history: ${api.lastError || 'no answer'}`);
          return [];
        }
        return res.sessions.map((s) => ({
          member, sid: String(s.sid), date: s.date || '', matchCount: Number(s.matchCount) || 0, secretsFlagged: Boolean(s.secretsFlagged),
          hits: (Array.isArray(s.hits) ? s.hits : []).map((h) => ({ loc: String(h.section || h.source || ''), line: String(h.line || '') }))
        }));
      }));
      if (chat !== current || gen !== historyGen) return;
      const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
      let items = [].concat(...lists);
      items = q ? items.sort((a, b) => (b.matchCount - a.matchCount) || byDate(a, b)) : items.sort(byDate);
      historyState = {
        status: notes.length && !items.length ? 'error' : 'ready',
        error: notes.length && !items.length ? notes.join(' ') : null,
        notes: notes.length && items.length ? notes : [],
        mode: q ? 'search' : 'recents', q, member: String(chat.project.name || ''), fleet,
        items: items.slice(0, HISTORY_ITEM_CAP), snapshot: null
      };
      shell.setHistory(historyState);
    }

    /**
     * Open one past session read-only in the history panel (#3066): its wrap
     * summary and, for a query, the transcript lines that match it.
     * @param {{member: string, sid: string, q?: string}} pick
     * @returns {Promise<void>}
     */
    async function openHistorySession(pick) {
      const chat = current;
      const shell = getShell();
      if (!chat || !shell || typeof shell.setHistory !== 'function' || !pick) return;
      const gen = ++historyGen;
      const base = `/api/continuity/${encodeURIComponent(pick.member)}/sessions/${encodeURIComponent(pick.sid)}`;
      const q = String(pick.q || '').trim();
      const [detailRes, transcriptRes] = await Promise.all([
        api(base),
        q ? api(`${base}/transcript/search?q=${encodeURIComponent(q)}`) : Promise.resolve(null)
      ]);
      if (chat !== current || gen !== historyGen) return;
      const summary = detailRes && detailRes.summary && detailRes.summary.sections ? detailRes.summary.sections : {};
      const snapshot = {
        member: pick.member, sid: String(pick.sid),
        date: (detailRes && detailRes.session && detailRes.session.date) || '',
        sections: Object.entries(summary).filter(([, body]) => body).map(([name, body]) => ({ name, body: String(body) })),
        excerpts: transcriptRes && transcriptRes.available && Array.isArray(transcriptRes.excerpts)
          ? transcriptRes.excerpts.slice(0, 5).map((e) => ({ loc: [e.role, e.timestamp].filter(Boolean).join(' · '), snippet: String(e.snippet || '') }))
          : [],
        note: transcriptRes && !transcriptRes.available ? (transcriptRes.reason || 'No transcript captured for this session.') : '',
        secretsFlagged: Boolean((detailRes && detailRes.transcript && detailRes.transcript.secretsFlagged)
          || (detailRes && detailRes.session && detailRes.session.secretsFlagged)
          || (transcriptRes && transcriptRes.secretsFlagged)),
        secretTypes: [].concat((detailRes && detailRes.transcript && detailRes.transcript.secretTypes) || [],
          (transcriptRes && transcriptRes.secretTypes) || []).filter((t, i, all) => all.indexOf(t) === i),
        error: detailRes ? '' : `Could not open this session: ${api.lastError || 'no answer'}`
      };
      historyState = Object.assign({}, historyState, { snapshot });
      shell.setHistory(historyState);
    }

    /**
     * Rename the chat's target (#3071) through the operator-only project
     * route, then reload the rows, tree, delegate picker and chat in place, so
     * the new name shows everywhere at once. The checks here mirror the
     * server's own so an obvious mistake is caught without a round trip; the
     * server's reason is shown for anything it refuses (a live session, a name
     * already taken).
     * @param {string} oldName
     * @param {string} newName
     * @param {{confirmOrphanRisk?: boolean}} [opts] - The operator's yes to the server's orphan-risk warning.
     * @returns {Promise<void>}
     */
    async function renameProject(oldName, newName, opts) {
      const chat = current;
      const shell = getShell();
      if (!chat || !shell) return;
      const done = (result) => { if (typeof shell.renameResult === 'function') shell.renameResult(result); };
      const from = String(oldName || '');
      const to = String(newName || '').trim();
      if (!to || to === from) {
        showSend({ kind: 'error', message: `Not renamed: give ${from} a different name.` });
        done({ ok: false });
        return;
      }
      if (!PROJECT_NAME_CHARS.test(to)) {
        showSend({ kind: 'error', message: 'Not renamed: use only letters, digits, spaces, dashes and underscores.' });
        done({ ok: false });
        return;
      }
      const confirmed = Boolean(opts && opts.confirmOrphanRisk);
      showSend({ kind: 'pending', message: `Renaming ${from} to ${to}…` });
      const body = confirmed ? { name: to, confirmOrphanRisk: true } : { name: to };
      const res = await apiMutate(`/api/projects/${encodeURIComponent(from)}`, 'PATCH', body);
      if (chat !== current) return;
      if (!res) {
        const reason = api.lastError || 'the server refused it';
        // The old folder holds engine state a rename would leave behind: the
        // server wants an explicit yes, so ask for one rather than dead-end.
        if (!confirmed && ORPHAN_RISK_WARNING.test(reason)) {
          showSend({ kind: 'warning', message: `${from} has engine state its rename would leave behind; read the warning, then choose Rename anyway or Cancel.` });
          done({ ok: false, warning: reason });
          return;
        }
        showSend({ kind: 'error', message: `Not renamed: ${reason}` });
        done({ ok: false });
        return;
      }
      done({ ok: true });
      await refresh();
      const warnings = Array.isArray(res.warnings) ? res.warnings.filter(Boolean) : [];
      showSend({ kind: warnings.length ? 'warning' : 'ok', message: `Renamed ${from} to ${to}.${warnings.map((w) => ` ${w}`).join('')}` });
    }

    /**
     * Start every offline member of the group on screen, one at a time, then
     * reload and report how many started and why any did not.
     * @returns {Promise<void>}
     */
    async function startFleet() {
      const chat = current;
      if (!chat || !getShell()) return;
      const offline = (chat.ctx && Array.isArray(chat.ctx.members) ? chat.ctx.members : []).filter((m) => m.live === false);
      if (!offline.length) return;
      showSend({ kind: 'pending', message: `Starting ${offline.length} session${offline.length === 1 ? '' : 's'}…` });
      const failures = [];
      for (const m of offline) {
        const ok = await apiMutate(`/api/sessions/${encodeURIComponent(m.name)}`, 'POST', {});
        if (!ok) failures.push(`${m.name}: ${api.lastError || 'the server refused it'}`);
      }
      await refresh();
      const started = offline.length - failures.length;
      showSend({
        kind: failures.length ? 'warning' : 'ok',
        message: `Started ${started} of ${offline.length}.${failures.map((f) => ` ${f}`).join('')}`
      });
    }

    /**
     * Make `projectId` the Designated Delegate of logical project `nodeId`,
     * remembered across visits, and reload the chat with it.
     * @param {string} nodeId
     * @param {string} projectId
     * @returns {Promise<void>}
     */
    async function changeDelegate(nodeId, projectId) {
      const next = Object.assign({}, delegates());
      next[String(nodeId)] = String(projectId);
      prefs.set('tc_v6_project_delegates', next);
      await refresh();
    }

    async function launchTemplate(templateId) {
      const mine = ++seq;
      const shell = getShell();
      if (!shell) return;
      shell.setDetail({ kind: 'loading' });
      const plan = await apiMutate(`/api/v6/fleet-templates/${encodeURIComponent(templateId)}/plan`, 'POST', {});
      if (mine !== seq) return;
      shell.setDetail(plan
        ? { kind: 'plan', plan }
        : { kind: 'error', message: `Could not plan template “${templateId}”.` });
    }

    async function enterHash() {
      if (!projects) await loadProjects();
      const tree = synthesizeTreeFromProjects(projects);
      return tree.length ? routeHash({ view: 'project', projectId: tree[0].id }) : '#/settings/';
    }

    return {
      handleRoute, launchTemplate, enterHash, sendChat, changeDelegate, refresh, attachFiles, removeAttachment,
      startSession, startFleet, treeLinkClicked, renameProject, loadHistory, openHistorySession,
      getProjects() { return projects; }
    };
  }

  /**
   * Mount the shell into `root` and keep it in sync with the location
   * hash. Re-renders fully on every route change and on every
   * `setTree`/`setTelemetry`/`setTemplates`/`setAttestation`/`setDetail` call — this
   * shell has no partial-update path, which keeps it simple and correct
   * at the data volumes a sidebar/header/wizard list actually reaches.
   * @param {object} doc - `document`, or `test/_mini-dom.js`'s stand-in.
   * @param {{root: object|string, window?: object, tree?: Array<*>,
   *   telemetry?: object|null, templates?: Array<*>, attestation?: object|null,
   *   detail?: object|null, showWatermark?: boolean, onRender?: (route: object) => void,
   *   onLaunchTemplate?: (templateId: string) => void,
   *   storage?: {getItem: Function, setItem: Function}|null,
   *   onSendChat?: (text: string) => void, onChangeDelegate?: (nodeId: string, projectId: string) => void,
   *   onRefreshChat?: () => void, onOpenProjectSettings?: (projectName: string) => void,
   *   onAttachFiles?: (files: Array<object>) => void, onRemoveAttachment?: (index: number) => void,
   *   onStartSession?: () => void, onStartFleet?: () => void, onTreeLinkClick?: (hash: string) => void,
   *   onRenameProject?: (oldName: string, newName: string, opts?: {confirmOrphanRisk: boolean}) => void,
   *   onHistoryLoad?: (form: {scope: string, kind: string, q: string}) => void,
   *   onHistoryOpenSession?: (pick: {member: string, sid: string, q: string, kind: string}) => void,
   *   now?: () => number, setInterval?: (fn: Function, ms: number) => *, clearInterval?: (id: *) => void}} opts - `storage`
   *   remembers the sidebar layout (#3046); defaults to the page's `localStorage`,
   *   and `null` keeps it for this page only. The `on*Chat`/delegate/settings
   *   callbacks are the chat view's controls (#3047). `now` and the interval pair
   *   drive the busy line's elapsed time (#3057); they default to the page's.
   * @returns {{getRoute: () => object, navigate: (hash: string) => void,
   *   toggleDrawer: (force?: boolean) => void, isDrawerOpen: () => boolean,
   *   toggleSidebar: (force?: boolean) => void, isSidebarCollapsed: () => boolean,
   *   selectGroup: (id: string, additive?: boolean) => void, setProjects: (rows: Array<object>) => void,
   *   setEngineHealth: (health: object|null) => void,
   *   setPeek: (peek: object|null) => void, setLive: (update: object) => void, clearChatDraft: (projectId?: *) => void,
   *   setTree: (tree: Array<*>) => void, setTelemetry: (bar: object|null) => void,
   *   setTemplates: (templates: Array<*>) => void,
   *   setAttestation: (attestation: object|null) => void,
   *   setDetail: (detail: object|null) => void, destroy: () => void}}
   */
  function tcCreateV6Shell(doc, opts) {
    const options = opts || {};
    const root = typeof options.root === 'string' ? doc.getElementById(options.root) : options.root;
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    let tree = buildHierarchyTree(options.tree || []);
    let telemetry = options.telemetry || null;
    let templates = Array.isArray(options.templates) ? options.templates : [];
    let attestation = options.attestation || null;
    let detail = options.detail || null;
    const showWatermark = options.showWatermark !== false;
    let currentRoute = { view: null };
    let drawerOpen = false;
    const prefs = makePrefs(options.storage !== undefined ? options.storage : defaultStorage(win));
    let sidebarCollapsed = prefs.get('tc_v6_sidebar_collapsed', false, isBoolean);
    let collapsedNodes = new Set(prefs.get('tc_v6_collapsed_nodes', [], isStringArray));
    let projectRows = new Map();
    // Engine id -> {status}, from /api/models/status, for the sidebar badges (#3053).
    let engineHealth = {};
    let filterText = '';
    let filterEngine = '';
    let selectedGroups = new Set(prefs.get('tc_v6_selected_groups', [], isStringArray));
    // #3068: whether the search and engine filters show. They can only be
    // set while it is open, and closing clears them, so a filter in force is
    // never out of sight.
    let searchToggled = false;
    // The tree as last rendered, filters applied: the fold toggles' positional
    // ids were generated from it, so they are wired from it too.
    let shownTree = [];
    // Unsent composer text per target project, so text meant for one agent
    // never appears in, and is never sent from, another one's chat.
    const chatDrafts = new Map();
    // #3052: whether the raw-output drawer is open, kept across re-renders,
    // polls and visits; and which chat was last scrolled to its bottom, so a
    // chat opens at its newest line once and is then left where the operator puts it.
    let chatHoodOpen = prefs.get('tc_v6_chat_under_hood_open', false, isBoolean);
    // #3082: which switchboard-triggered replies the chat shows, kept across visits.
    let verbosity = Object.assign({}, prefs.get('tc_v6_chat_verbosity', VERBOSITY_DEFAULT, isVerbosity));
    // The workspace mode (#3086), remembered per viewer.
    let workspaceMode = prefs.get('tc_v6_workspace_mode', 'chat', isWorkspaceMode);

    /**
     * Switch the workspace mode in place (#3086): show and hide the regions,
     * move the tab selection, and fill a data mode's panel. Nothing is
     * redrawn, so an open chat keeps its draft, scroll and focus state.
     * @param {string} mode
     * @param {{focus?: string}} [opts] - The id of an element to focus after.
     */
    function setWorkspaceMode(mode, opts) {
      if (!isWorkspaceMode(mode)) return;
      workspaceMode = mode;
      prefs.set('tc_v6_workspace_mode', mode);
      const shown = workspaceVisibility(mode, Boolean(detail && detail.kind === 'conversation'));
      [['v6ShellDetail', shown.detail], ['v6ShellWizard', shown.wizard], ['v6ShellAttestation', shown.attestation],
        ['v6WorkspacePanel', shown.panel]].forEach(([id, show]) => {
        const el = doc.getElementById(id);
        if (el) el.hidden = !show;
      });
      WORKSPACE_MODES.forEach((m) => {
        const tab = doc.getElementById(`v6WorkspaceMode-${m.key}`);
        if (!tab) return;
        const on = m.key === mode;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.setAttribute('tabindex', on ? '0' : '-1');
        if (tab.classList) tab.classList.toggle('is-active', on);
      });
      const panel = doc.getElementById('v6WorkspacePanel');
      if (panel && shown.panel) {
        panel.innerHTML = workspacePanelMarkup(mode);
        panel.setAttribute('aria-labelledby', `v6WorkspaceMode-${mode}`);
      }
      const target = opts && opts.focus ? doc.getElementById(opts.focus) : null;
      if (target && typeof target.focus === 'function') target.focus();
      if (typeof options.onWorkspaceMode === 'function') options.onWorkspaceMode(mode);
    }

    /**
     * Wire the mode bar's tabs (click, and arrow/Home/End keys that move and
     * choose) and both wizard launchers (#3086).
     */
    function wireWorkspaceModes() {
      const keys = WORKSPACE_MODES.map((m) => m.key);
      keys.forEach((key, index) => {
        const tab = doc.getElementById(`v6WorkspaceMode-${key}`);
        if (!tab) return;
        tab.addEventListener('click', () => setWorkspaceMode(key));
        tab.addEventListener('keydown', (evt) => {
          const k = evt && evt.key;
          let next = null;
          if (k === 'ArrowRight') next = keys[(index + 1) % keys.length];
          else if (k === 'ArrowLeft') next = keys[(index - 1 + keys.length) % keys.length];
          else if (k === 'Home') next = keys[0];
          else if (k === 'End') next = keys[keys.length - 1];
          if (next == null) return;
          if (typeof evt.preventDefault === 'function') evt.preventDefault();
          setWorkspaceMode(next, { focus: `v6WorkspaceMode-${next}` });
        });
      });
      ['v6ShellWizardOpenBtn', 'v6ShellWizardOpenTop'].forEach((id) => {
        const btn = doc.getElementById(id);
        if (btn) btn.addEventListener('click', () => setWorkspaceMode('wizard', { focus: 'v6WorkspaceMode-wizard' }));
      });
    }
    // #3079: the questions dismissed in each chat, by {@link questionKey},
    // until the pane shows no question at all — the operator has answered —
    // so a poll that reads the same reply again, or the same reply grown by a
    // wake or more text, does not bring them back, and a later reply's do show.
    const dismissedQuestions = new Map();
    // What the question slot and the Medusa slot were last drawn with, so
    // a poll redraws them only when that changes.
    let paintedQuestions = null;
    let paintedMedusa = null;
    // #3079 item 6: the message being sent — its chat, text and send id —
    // drawn at the bottom of that chat until the send settles.
    // Several when a forced send overlaps another (#3082).
    let pendingSends = [];
    // What to run when the shell is torn down (#3082).
    const destroyHooks = [];
    // The flags of the send being handed to the page right now (#3082).
    let sendFlags = null;
    // #3085: the usage routes' last answers, whether the breakdown is open,
    // the last calibration's outcome, and the page's calibrate action.
    let usage = null;
    let usageOpen = false;
    let usageStatus = null;
    let usageActions = null;
    // The chat whose Start fleet button has been clicked once (#3053).
    let fleetArmedKey = null;
    // The chat whose rename form is open (#3071), the name typed into it
    // (kept across a refusal), and the server's orphan-risk warning if it
    // asked for confirmation.
    let renameOpenKey = null;
    let renameDraft = null;
    let renameWarning = null;
    // #3066: the history panel — open or not, its search form, and the last
    // results or snapshot the page handed back.
    let historyOpen = false;
    let historyForm = { scope: 'member', kind: 'summaries', q: '' };
    let historyData = null;
    // Whose history the panel last asked for (project id and name): a
    // refresh of the same chat keeps the panel; another member, or this one
    // renamed, reloads it.
    let historyFor = null;
    let scrolledChatKey = null;
    // #3057: when the chat on screen became busy, and the 1 s ticker that
    // advances its elapsed time while it stays busy.
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const startTicker = typeof options.setInterval === 'function' ? options.setInterval
      : (win && typeof win.setInterval === 'function' ? (fn, ms) => win.setInterval(fn, ms) : null);
    const stopTicker = typeof options.clearInterval === 'function' ? options.clearInterval
      : (win && typeof win.clearInterval === 'function' ? (id) => win.clearInterval(id) : () => {});
    let busy = null;
    let tickerId = null;

    function readHash() {
      if (typeof options.getHash === 'function') return options.getHash();
      return win && win.location ? win.location.hash : '';
    }

    function wireControls() {
      wireWorkspaceModes();
      const skipLink = doc.getElementById('v6ShellSkipLink');
      if (skipLink) {
        // PRR-B R1 HOLD (Ruling A579-PR3015-R1-HOLD-RECONCILED): a plain
        // href="#v6ShellMain" click would overwrite location.hash,
        // triggering hashchange -> parseRoute("#v6ShellMain") ->
        // {view: null} -> this very shell hiding itself. Move focus
        // directly instead, leaving the active route's hash untouched.
        skipLink.addEventListener('click', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          const main = doc.getElementById('v6ShellMain');
          if (main && typeof main.focus === 'function') main.focus();
        });
      }
      const toggle = doc.getElementById('v6ShellDrawerToggle');
      if (toggle) toggle.addEventListener('click', () => toggleDrawer());
      const sidebar = doc.getElementById('v6ShellSidebar');
      if (sidebar) {
        sidebar.addEventListener('keydown', (evt) => {
          if (evt && (evt.key === 'Escape' || evt.key === 'Esc')) toggleDrawer(false);
        });
      }
      // Each moves focus to the control that undoes it: the one clicked is
      // hidden or gone after the re-render, which would drop focus to the page.
      const collapseBtn = doc.getElementById('v6SidebarCollapse');
      if (collapseBtn) collapseBtn.addEventListener('click', () => { toggleSidebar(true); focusById('v6SidebarExpand'); });
      const expandBtn = doc.getElementById('v6SidebarExpand');
      if (expandBtn) expandBtn.addEventListener('click', () => { toggleSidebar(false); focusById('v6SidebarCollapse'); });
      const chatShowFleet = doc.getElementById('v6ChatShowFleet');
      if (chatShowFleet) chatShowFleet.addEventListener('click', () => { toggleSidebar(false); focusById('v6SidebarCollapse'); });
      wireHistory();
      const searchToggle = doc.getElementById('v6SidebarSearchToggle');
      if (searchToggle) searchToggle.addEventListener('click', () => { toggleSearch(); focusById('v6SidebarSearchToggle'); });
      const fleetPicker = doc.getElementById('v6FilterFleet');
      if (fleetPicker) {
        fleetPicker.addEventListener('change', (evt) => {
          const value = String((evt && evt.target && evt.target.value) || '');
          setSelectedGroups(value ? [value] : []);
        });
      }
      wireChat();
      wireUsage();
      wireStart();
      wireRename();
      wireTreeLinks();
      const search = doc.getElementById('v6FilterSearch');
      if (search) {
        search.addEventListener('input', (evt) => {
          filterText = String((evt && evt.target && evt.target.value) || '');
          render();
        });
      }
      const engineSelect = doc.getElementById('v6FilterEngine');
      if (engineSelect) {
        engineSelect.addEventListener('change', (evt) => {
          filterEngine = String((evt && evt.target && evt.target.value) || '');
          render();
        });
      }
      // Wired by position over the same tree the sidebar rendered, so a
      // toggle's id and the node it folds always agree.
      shownTree.forEach((project, pi) => {
        const pToggle = doc.getElementById(`v6TreeToggle-p${pi}`);
        if (pToggle) pToggle.addEventListener('click', () => toggleNode(projectNodeKey(project)));
        project.fleets.forEach((fleet, fi) => {
          const fToggle = doc.getElementById(`v6TreeToggle-f${pi}-${fi}`);
          if (fToggle) fToggle.addEventListener('click', () => toggleNode(fleetNodeKey(project, fleet)));
        });
      });
      if (typeof options.onLaunchTemplate === 'function') {
        templates.forEach((t) => {
          const templateId = t && t.id;
          const button = templateId != null ? doc.getElementById(`v6ShellWizardLaunch-${templateId}`) : null;
          if (button) button.addEventListener('click', () => options.onLaunchTemplate(templateId));
        });
      }
    }

    /** @param {string} id */
    function focusById(id) {
      const el = doc.getElementById(id);
      if (el && typeof el.focus === 'function') el.focus();
    }

    /**
     * The chat's start controls (#3053). Start fleet arms on the first
     * click and starts on the second, within ten seconds: it launches
     * several agents at once.
     */
    function wireStart() {
      ['v6ChatStart', 'v6ChatStartBanner'].forEach((id) => {
        const button = doc.getElementById(id);
        if (button && typeof options.onStartSession === 'function') button.addEventListener('click', () => options.onStartSession());
      });
      const fleet = doc.getElementById('v6ChatStartFleet');
      if (!fleet || typeof options.onStartFleet !== 'function') return;
      fleet.addEventListener('click', () => {
        const key = chatTargetKey();
        if (fleetArmedKey !== key) {
          fleetArmedKey = key;
          render();
          if (typeof global.setTimeout === 'function') {
            global.setTimeout(() => { if (fleetArmedKey === key) { fleetArmedKey = null; render(); } }, 10000);
          }
          return;
        }
        fleetArmedKey = null;
        render();
        options.onStartFleet();
      });
    }

    /** @returns {string|null} The chat target's id and name, as the history panel tracks it (#3066). */
    function historyWho() {
      const project = detail && detail.kind === 'conversation' && detail.view ? detail.view.project : null;
      return project && project.id != null ? `${project.id}|${project.name || ''}` : null;
    }

    /** Ask the page for history with the panel's current form (#3066). */
    function requestHistory() {
      if (chatTargetKey() == null || typeof options.onHistoryLoad !== 'function') return;
      historyFor = historyWho();
      historyData = Object.assign({}, historyData, { status: 'loading', snapshot: null, items: [] });
      render();
      options.onHistoryLoad(Object.assign({}, historyForm));
    }

    /**
     * The history panel (#3066): the clock opens and closes it (loading the
     * chat's recents as it opens), the form searches, a result opens its
     * snapshot, and Reference in chat adds the snapshot's reference to this
     * chat's message.
     */
    function wireHistory() {
      // The chat's own clock (#3066): open this member's history in the
      // sidebar, revealing a hidden sidebar or a shut phone drawer first so
      // the panel never opens out of sight.
      const fromChat = doc.getElementById('v6ChatHistory');
      if (fromChat) {
        fromChat.addEventListener('click', () => {
          if (sidebarCollapsed) {
            sidebarCollapsed = false;
            prefs.set('tc_v6_sidebar_collapsed', false);
          }
          drawerOpen = true;
          historyOpen = true;
          historyForm = Object.assign({}, historyForm, { scope: 'member' });
          requestHistory();
          focusById('v6SidebarFutureSlot');
        });
      }
      const toggle = doc.getElementById('v6SidebarFutureSlot');
      if (toggle) {
        toggle.addEventListener('click', () => {
          historyOpen = !historyOpen;
          // With no chat open there is nothing to load; the panel says so.
          if (historyOpen && chatTargetKey() != null) requestHistory(); else render();
          focusById('v6SidebarFutureSlot');
        });
      }
      const form = doc.getElementById('v6HistoryForm');
      if (form) {
        form.addEventListener('submit', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          const value = (id) => { const el = doc.getElementById(id); return el && typeof el.value === 'string' ? el.value : ''; };
          historyForm = {
            scope: value('v6HistoryScope') === 'fleet' ? 'fleet' : 'member',
            kind: value('v6HistoryKind') === 'transcripts' ? 'transcripts' : 'summaries',
            q: value('v6HistorySearch').trim()
          };
          requestHistory();
        });
      }
      const items = historyData && Array.isArray(historyData.items) ? historyData.items : [];
      items.forEach((it, i) => {
        const button = doc.getElementById(`v6HistoryItem-${i}`);
        if (!button || typeof options.onHistoryOpenSession !== 'function') return;
        button.addEventListener('click', () => options.onHistoryOpenSession({ member: it.member, sid: it.sid, q: historyForm.q, kind: historyForm.kind }));
      });
      const close = doc.getElementById('v6HistorySnapshotClose');
      if (close) close.addEventListener('click', () => { historyData = Object.assign({}, historyData, { snapshot: null }); render(); });
      const reference = doc.getElementById('v6HistoryReference');
      if (reference) {
        reference.addEventListener('click', () => {
          const key = chatTargetKey();
          const snap = historyData && historyData.snapshot;
          if (key == null || !snap) return;
          const text = historyReferenceText(snap);
          const draft = chatDrafts.get(key) || '';
          chatDrafts.set(key, draft ? `${draft.replace(/\s+$/, '')}\n${text}` : text);
          render();
          focusById('v6ChatInput');
        });
      }
    }

    /**
     * The chat target's rename control (#3071): the pencil opens the form,
     * Cancel or Escape closes it, and Save hands the new name to the page.
     */
    function wireRename() {
      const open = doc.getElementById('v6ChatRename');
      if (open) {
        open.addEventListener('click', () => {
          renameOpenKey = chatTargetKey();
          renameDraft = null;
          renameWarning = null;
          render();
          focusById('v6ChatRenameInput');
        });
      }
      const form = doc.getElementById('v6ChatRenameForm');
      if (!form) return;
      const close = () => { renameOpenKey = null; renameDraft = null; renameWarning = null; render(); focusById('v6ChatRename'); };
      const cancel = doc.getElementById('v6ChatRenameCancel');
      if (cancel) cancel.addEventListener('click', close);
      const input = doc.getElementById('v6ChatRenameInput');
      if (input) {
        input.addEventListener('keydown', (evt) => {
          if (evt && (evt.key === 'Escape' || evt.key === 'Esc')) close();
        });
        input.addEventListener('input', (evt) => {
          renameDraft = String((evt && evt.target && evt.target.value) || '');
          renameWarning = null;
        });
      }
      // The form stays open, with what was typed, until the page reports
      // the rename done: a refusal must not throw the operator's text away.
      // Rename anyway sends the kept draft (typing updates it). The orphan
      // risk belongs to the OLD folder, so the warning holds for any new
      // name the operator settles on.
      const send = (confirmOrphanRisk) => {
        const project = detail && detail.view ? detail.view.project : null;
        if (!project || typeof options.onRenameProject !== 'function') return;
        if (!confirmOrphanRisk || renameDraft == null) renameDraft = String((input && input.value) || '');
        options.onRenameProject(String(project.name || ''), renameDraft.trim(), confirmOrphanRisk ? { confirmOrphanRisk: true } : undefined);
      };
      form.addEventListener('submit', (evt) => {
        if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
        send(false);
      });
      const confirm = doc.getElementById('v6ChatRenameConfirm');
      if (confirm) confirm.addEventListener('click', () => send(true));
    }

    /** Report every sidebar link click, with its hash, so the page can refresh (#3053). */
    function wireTreeLinks() {
      if (typeof options.onTreeLinkClick !== 'function') return;
      shownTree.forEach((project, pi) => {
        const report = (id, hash) => {
          const link = doc.getElementById(id);
          if (link) link.addEventListener('click', () => options.onTreeLinkClick(hash));
        };
        report(`v6TreeLink-p${pi}`, routeHash({ view: 'project', projectId: project.id }));
        project.fleets.forEach((fleet, fi) => {
          report(`v6TreeLink-f${pi}-${fi}`, routeHash({ view: 'fleet', projectId: project.id, fleetId: fleet.id }));
          fleet.members.forEach((m, mi) => {
            if (m.seatId) report(`v6TreeLink-m${pi}-${fi}-${mi}`, routeHash({ view: 'conversation', resourceId: m.seatId }));
          });
        });
      });
    }

    /** The chat view's own controls (#3047), when the detail pane shows one. */
    function wireChat() {
      const input = doc.getElementById('v6ChatInput');
      if (input) {
        input.addEventListener('input', (evt) => {
          const key = chatTargetKey();
          if (key != null) chatDrafts.set(key, String((evt && evt.target && evt.target.value) || ''));
        });
        input.addEventListener('keydown', (evt) => {
          const action = chatKeyAction(evt);
          if (!action) return;
          if (typeof evt.preventDefault === 'function') evt.preventDefault();
          submitChat(action === 'force');
        });
      }
      const force = doc.getElementById('v6ChatForceSend');
      if (force) force.addEventListener('click', () => submitChat(true));
      const form = doc.getElementById('v6ChatForm');
      if (form) {
        form.addEventListener('submit', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          submitChat();
        });
      }
      wireAttachments();
      const hood = doc.getElementById('v6ChatUnderHood');
      if (hood) {
        hood.addEventListener('toggle', (evt) => {
          chatHoodOpen = Boolean(evt && evt.target && evt.target.open);
          prefs.set('tc_v6_chat_under_hood_open', chatHoodOpen);
        });
      }
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      const picker = doc.getElementById('v6ChatDelegate');
      if (picker && chat && chat.nodeId != null && typeof options.onChangeDelegate === 'function') {
        picker.addEventListener('change', (evt) => {
          options.onChangeDelegate(String(chat.nodeId), String((evt && evt.target && evt.target.value) || ''));
        });
      }
      wireQuestions();
      wireMedusa();
      wireVerbosity();
      const refresh = doc.getElementById('v6ChatRefresh');
      if (refresh && typeof options.onRefreshChat === 'function') refresh.addEventListener('click', () => options.onRefreshChat());
      const settings = doc.getElementById('v6ChatSettings');
      const project = detail && detail.view ? detail.view.project : null;
      if (settings && project && typeof options.onOpenProjectSettings === 'function') {
        settings.addEventListener('click', () => options.onOpenProjectSettings(String(project.name || '')));
      }
    }

    /**
     * @param {string|null} key - A chat target.
     * @returns {string[]} The questions dismissed in that chat (#3079).
     */
    function dismissedFor(key) {
      return key != null && dismissedQuestions.has(key) ? dismissedQuestions.get(key).slice() : [];
    }

    /**
     * The questions the chat on screen still shows (#3079). Once the live
     * view asks nothing, the chat's dismissals are spent and forgotten.
     * @returns {string[]}
     */
    function questionsNow() {
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      const key = chatTargetKey();
      const live = chat && chat.live;
      // Only a read of the pane that asks nothing spends them; a failed
      // read says nothing about the question.
      if (key != null && live && Array.isArray(live.questions) && !live.questions.length) dismissedQuestions.delete(key);
      return openQuestions(chat && chat.live, dismissedFor(key));
    }

    /**
     * Put away questions in the chat on screen (#3079) and redraw the slot.
     * @param {string[]} texts
     */
    function dismissQuestions(texts) {
      const key = chatTargetKey();
      if (key == null || !texts.length) return;
      const chat = detail && detail.view ? detail.view.chat : null;
      const set = dismissedQuestions.get(key) || [];
      texts.forEach((t) => set.push(questionKey(chat && chat.live, t)));
      dismissedQuestions.set(key, set);
      paintQuestions();
    }

    /**
     * Redraw the question slot and wire its ✕ buttons — only when what it
     * shows changed, so a poll never takes keyboard focus off a ✕. The
     * slot as last drawn is {@link paintedQuestions}.
     * @returns {boolean} Whether it was redrawn.
     */
    function paintQuestions() {
      const q = doc.getElementById('v6ChatQuestion');
      if (!q) return false;
      const list = questionsNow();
      const html = chatQuestionInner(list);
      if (html === paintedQuestions) return false;
      paintedQuestions = html;
      q.innerHTML = html;
      q.className = `v6-chat-question${list.length ? ' is-asking' : ''}`;
      wireQuestions();
      return true;
    }

    /**
     * Each question's ✕ dismisses that question (#3079), and focus moves to
     * the ✕ now in its place, else to the message box.
     */
    function wireQuestions() {
      const list = questionsNow();
      list.forEach((text, i) => {
        const btn = doc.getElementById(`v6ChatQuestionDismiss${i}`);
        if (!btn) return;
        btn.addEventListener('click', () => {
          dismissQuestions([text]);
          const left = questionsNow().length;
          const next = doc.getElementById(left ? `v6ChatQuestionDismiss${Math.min(i, left - 1)}` : 'v6ChatInput');
          if (next && typeof next.focus === 'function') next.focus();
        });
      });
    }

    /** @returns {string} The usage meter as it stands (#3085), or '' before the routes answer. */
    function usageMarkupNow() {
      return usage ? usageMeterMarkup(usageMeterModel(usage.windows, usage.sessions), { open: usageOpen, status: usageStatus }) : '';
    }

    /**
     * Redraw the meter alone (#3085), or the shell if its footer has no slot
     * yet. A refresh keeps what the operator has typed in the breakdown and
     * where their focus was.
     */
    function paintUsage() {
      const slot = doc.getElementById('v6EngineUsageSlot');
      if (!slot) { render(); return; }
      const typed = {};
      USAGE_ENGINES.forEach(({ key }) => [`v6UsageWeekly-${key}`, `v6UsageFiveHour-${key}`].forEach((id) => {
        const el = doc.getElementById(id);
        if (el && typeof el.value === 'string' && el.value !== '') typed[id] = el.value;
      }));
      const active = doc.activeElement;
      const focusId = active && typeof active.id === 'string' && /^v6(Usage|EngineUsage)/.test(active.id) ? active.id : null;
      slot.innerHTML = usageMarkupNow();
      Object.keys(typed).forEach((id) => {
        const el = doc.getElementById(id);
        if (el) el.value = typed[id];
      });
      const back = focusId ? doc.getElementById(focusId) : null;
      if (back && typeof back.focus === 'function') back.focus();
      wireUsage();
    }

    /**
     * The meter opens and closes its breakdown; each engine's Set button
     * records the operator's "% left" for it (#3085, A753-1).
     */
    function wireUsage() {
      // Once per element: a redraw makes new ones, a repeat call must not double up.
      const fresh = (el) => {
        if (!el || (el.dataset && el.dataset.usageWired)) return false;
        if (el.dataset) el.dataset.usageWired = '1';
        return true;
      };
      // Escape closes the breakdown and hands focus back to the meter.
      const popover = doc.getElementById('v6EngineUsagePopover');
      if (fresh(popover)) {
        popover.addEventListener('keydown', (evt) => {
          if (!evt || (evt.key !== 'Escape' && evt.key !== 'Esc') || !usageOpen) return;
          usageOpen = false;
          paintUsage();
          const m = doc.getElementById('v6EngineUsageMeter');
          if (m && typeof m.focus === 'function') m.focus();
        });
      }
      const meter = doc.getElementById('v6EngineUsageMeter');
      if (fresh(meter)) {
        meter.addEventListener('click', () => {
          usageOpen = !usageOpen;
          paintUsage();
          const again = doc.getElementById('v6EngineUsageMeter');
          if (again && typeof again.focus === 'function') again.focus();
        });
      }
      USAGE_ENGINES.forEach(({ key, name }) => {
        const btn = doc.getElementById(`v6UsageSave-${key}`);
        if (!fresh(btn)) return;
        btn.addEventListener('click', () => {
          const read = (id) => {
            const el = doc.getElementById(id);
            const raw = el && typeof el.value === 'string' ? el.value.trim() : '';
            return raw === '' ? undefined : Number(raw);
          };
          const weekly = read(`v6UsageWeekly-${key}`);
          const fiveHour = read(`v6UsageFiveHour-${key}`);
          const bad = [weekly, fiveHour].some((v) => v !== undefined && !(Number.isFinite(v) && v >= 0 && v <= 100));
          if (bad || (weekly === undefined && fiveHour === undefined)) {
            usageStatus = { kind: 'error', message: `${name}: enter a weekly or 5-hour % left between 0 and 100.` };
            paintUsage();
            return;
          }
          if (!usageActions || typeof usageActions.calibrate !== 'function') return;
          usageStatus = { kind: 'pending', message: `Setting ${name}…` };
          paintUsage();
          Promise.resolve(usageActions.calibrate(key, weekly, fiveHour)).then((result) => {
            usageStatus = result && result.ok
              ? { kind: 'ok', message: `${name} set.` }
              : { kind: 'error', message: `${name} not set: ${(result && result.error) || 'the server refused it'}` };
            paintUsage();
          });
        });
      });
    }

    /** @returns {Object<string, string>} The chat on screen's thumbnails: file name → `blob:` URL (#3082). */
    function thumbsNow() {
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      return (chat && chat.thumbs) || {};
    }

    /**
     * Redraw the replies the verbosity filter tucked away, and their count
     * on the Under the Hood summary (#3082).
     * @param {object|null} live
     */
    function paintTucked(live) {
      const tucked = tuckedTurns(live && Array.isArray(live.turns) ? live.turns : [], verbosity);
      const list = doc.getElementById('v6ChatTucked');
      if (list) list.innerHTML = tuckedMarkup(tucked, thumbsNow());
      const count = doc.getElementById('v6ChatTuckedCount');
      if (count) count.innerHTML = escapeHtml(tuckedCountText(tucked.length));
    }

    /**
     * Each verbosity checkbox (#3082) shows or tucks its kind of reply, in
     * place, and is remembered.
     */
    function wireVerbosity() {
      ['v6ChatShowBlockers', 'v6ChatShowMilestones', 'v6ChatShowChatter'].forEach((id) => {
        const box = doc.getElementById(id);
        if (!box) return;
        box.addEventListener('change', (evt) => {
          const target = evt && evt.target ? evt.target : box;
          const key = target.getAttribute ? target.getAttribute('data-verbosity') : null;
          const which = key || { v6ChatShowBlockers: 'blockers', v6ChatShowMilestones: 'milestones', v6ChatShowChatter: 'chatter' }[id];
          verbosity = Object.assign({}, verbosity, { [which]: Boolean(target.checked) });
          prefs.set('tc_v6_chat_verbosity', verbosity);
          const view = detail && detail.kind === 'conversation' ? detail.view : null;
          const live = view && view.chat ? view.chat.live : null;
          const liveEl = doc.getElementById('v6ChatLive');
          if (liveEl) liveEl.innerHTML = liveTurnsMarkup(live ? live.turns : [], String((view && view.project && view.project.name) || ''), verbosity, thumbsNow());
          paintTucked(live);
        });
      });
    }

    /**
     * Redraw the recorded events around the live turns, and the pending
     * bubble (#3079 item 6), as a poll moves what the pane shows.
     */
    function paintRecorded() {
      const view = detail && detail.kind === 'conversation' ? detail.view : null;
      if (!view) return;
      const chat = view.chat || {};
      const name = String((view.project && view.project.name) || '');
      const parts = arrangeRecorded(view.events, chat.live && Array.isArray(chat.live.turns) ? chat.live.turns : [], chat.lastSent);
      const head = doc.getElementById('v6ChatRecorded');
      if (head) head.innerHTML = recordedEventsMarkup(parts.head, name, chat.thumbs);
      const tailEl = doc.getElementById('v6ChatRecordedTail');
      if (tailEl) tailEl.innerHTML = recordedEventsMarkup(parts.tail, name, chat.thumbs);
      const pendingEl = doc.getElementById('v6ChatPending');
      if (pendingEl) pendingEl.innerHTML = pendingMarkup(pendingSends.filter((p) => p.key === chatTargetKey()), chat.lastSent, chat.thumbs);
    }

    /**
     * Bring the Medusa indicator up to date (#3076). While it stays on
     * screen its button is updated in place, never replaced, so a poll
     * cannot take focus off it or swallow a click; it is drawn
     * or removed only when it appears or goes.
     * @param {object|null|undefined} medusa
     */
    function paintMedusa(medusa) {
      const slot = doc.getElementById('v6ChatMedusaSlot');
      if (!slot) return;
      const html = medusaIndicatorMarkup(medusa);
      if (html === paintedMedusa) return;
      const btn = paintedMedusa ? doc.getElementById('v6ChatMedusa') : null;
      const badge = paintedMedusa ? doc.getElementById('v6ChatMedusaBadge') : null;
      paintedMedusa = html;
      if (html && btn && badge) {
        const parts = medusaIndicatorParts(medusa);
        btn.className = parts.className;
        btn.title = parts.tip;
        btn.setAttribute('title', parts.tip);
        btn.setAttribute('aria-label', parts.tip);
        badge.className = parts.badgeClass;
        badge.textContent = parts.badge;
        return;
      }
      slot.innerHTML = html;
      wireMedusa();
    }

    /**
     * The Medusa indicator opens Under the Hood at the switchboard's traffic (#3076).
     */
    function wireMedusa() {
      const btn = doc.getElementById('v6ChatMedusa');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const hood = doc.getElementById('v6ChatUnderHood');
        if (hood) {
          hood.open = true;
          if (typeof hood.setAttribute === 'function') hood.setAttribute('open', '');
        }
        chatHoodOpen = true;
        prefs.set('tc_v6_chat_under_hood_open', true);
        const list = doc.getElementById('v6ChatSwitchboard');
        if (list && typeof list.focus === 'function') list.focus();
      });
    }

    /** @returns {string|null} The project the chat on screen talks to, as a draft key. */
    function chatTargetKey() {
      const project = detail && detail.kind === 'conversation' && detail.view ? detail.view.project : null;
      return project && project.id != null ? String(project.id) : null;
    }

    /** @returns {string|null} What the chat on screen is busy with, if anything (#3057). */
    function busyLabelNow() {
      return detail && detail.kind === 'conversation' && detail.view ? chatBusyLabel(detail.view.chat) : null;
    }

    /**
     * Start, keep or stop the busy clock (#3057). It keeps its start while
     * the same chat stays busy, whatever the label says, and stops — with
     * its ticker — once that chat is idle or off screen.
     * @returns {string} The elapsed time to show, or '' when idle.
     */
    function syncBusy() {
      const key = chatTargetKey();
      if (!busyLabelNow() || key == null) {
        busy = null;
        if (tickerId != null) { stopTicker(tickerId); tickerId = null; }
        return '';
      }
      if (!busy || busy.key !== key) busy = { key, since: now() };
      if (tickerId == null && startTicker) tickerId = startTicker(tickBusy, 1000);
      return formatElapsed(now() - busy.since);
    }

    /** Advance the busy line's elapsed time in place, once a second. */
    function tickBusy() {
      const elapsed = syncBusy();
      const timer = doc.getElementById('v6ChatActivityTimer');
      if (timer && elapsed) timer.innerHTML = escapeHtml(elapsed);
    }

    /**
     * The composer's ways in for files (#3053): the Attach button and its
     * hidden input, a drop anywhere on the composer, and a paste of files or
     * a screenshot into the message; plus each chip's remove button.
     */
    function wireAttachments() {
      if (typeof options.onAttachFiles !== 'function') return;
      const attach = (evt) => {
        const files = filesFromEvent(evt);
        if (!files.length) return false;
        options.onAttachFiles(files);
        return true;
      };
      const input = doc.getElementById('v6ChatFileInput');
      const button = doc.getElementById('v6ChatAttachBtn');
      if (button && input) button.addEventListener('click', () => { if (typeof input.click === 'function') input.click(); });
      if (input) {
        input.addEventListener('change', (evt) => {
          attach(evt);
          if (evt && evt.target) evt.target.value = '';
        });
      }
      const form = doc.getElementById('v6ChatForm');
      if (form) {
        form.addEventListener('dragover', (evt) => { if (evt && typeof evt.preventDefault === 'function') evt.preventDefault(); });
        form.addEventListener('drop', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          attach(evt);
        });
      }
      const text = doc.getElementById('v6ChatInput');
      if (text) {
        // Only a paste that carries files is taken over; pasting text is left alone.
        text.addEventListener('paste', (evt) => {
          if (attach(evt) && typeof evt.preventDefault === 'function') evt.preventDefault();
        });
      }
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      const items = chat && Array.isArray(chat.attachments) ? chat.attachments : [];
      if (typeof options.onRemoveAttachment === 'function') {
        items.forEach((_, i) => {
          const remove = doc.getElementById(`v6ChatAttachRemove-${i}`);
          if (remove) remove.addEventListener('click', () => options.onRemoveAttachment(i));
        });
      }
    }

    /**
     * Hand the composer's text to the page, unless there is nothing to send:
     * no text and no attachment.
     */
    /**
     * Hand the composer's text to the page to send (#3047). A forced send
     * (#3082, Ruling A757) carries `{priority, startupIntervention}`: as the
     * second argument, and — since a page may pass the text alone — for the
     * controller to take from {@link takeSendFlags} while this call runs.
     * @param {boolean} [force]
     */
    function submitChat(force) {
      const input = doc.getElementById('v6ChatInput');
      const text = String((input && typeof input.value === 'string' ? input.value : chatDrafts.get(chatTargetKey())) || '').trim();
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      const hasFiles = Boolean(chat && Array.isArray(chat.attachments) && chat.attachments.some((a) => a && a.status !== 'error'));
      if ((!text && !hasFiles) || typeof options.onSendChat !== 'function') return;
      const flags = force ? { priority: true, startupIntervention: true } : null;
      sendFlags = flags;
      try {
        if (flags) options.onSendChat(text, flags);
        else options.onSendChat(text);
      } finally {
        // Only the send this call started may take them.
        sendFlags = null;
      }
    }

    /**
     * What a full re-render would otherwise lose: the sidebar's scroll
     * position, and which shell control had focus (with its caret), since
     * replacing `innerHTML` replaces every element.
     * @returns {{scrollTop: number, focusId: string|null, selection: Array<number>|null}}
     */
    function captureViewState() {
      const sidebar = doc.getElementById('v6ShellSidebar');
      const active = doc.activeElement;
      const focusId = active && typeof active.id === 'string' && active.id.startsWith('v6') ? active.id : null;
      const selection = focusId && typeof active.selectionStart === 'number'
        ? [active.selectionStart, active.selectionEnd] : null;
      return {
        scrollTop: (sidebar && sidebar.scrollTop) || 0, focusId, selection,
        streamAtBottom: isAtBottom(doc.getElementById('v6ChatStream')),
        peekAtBottom: isAtBottom(doc.getElementById('v6ChatPeek'))
      };
    }

    /** @param {ReturnType<typeof captureViewState>} saved */
    function restoreViewState(saved) {
      const sidebar = doc.getElementById('v6ShellSidebar');
      if (sidebar && saved.scrollTop) sidebar.scrollTop = saved.scrollTop;
      // A chat opens at its newest line (#3052); after that it follows new
      // lines only while the operator is reading the bottom.
      const key = chatTargetKey();
      const first = key != null && key !== scrolledChatKey;
      if (key != null) scrolledChatKey = key;
      if (first || saved.streamAtBottom) pinToBottom(doc.getElementById('v6ChatStream'));
      if (first || saved.peekAtBottom) pinToBottom(doc.getElementById('v6ChatPeek'));
      if (!saved.focusId) return;
      const el = doc.getElementById(saved.focusId);
      if (!el || doc.activeElement === el || typeof el.focus !== 'function') return;
      el.focus();
      if (saved.selection && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(saved.selection[0], saved.selection[1]);
      }
    }

    function render() {
      currentRoute = parseRoute(readHash());
      if (!root) return;
      const saved = captureViewState();
      // A764/A765: the header docked in the dashboard bar and the stats moved
      // into the footer belong to the drawing about to be replaced; take the
      // header out and send the stats home first, so the redraw loses
      // neither, and onRender docks and moves the new ones.
      returnDashStats(doc);
      const bar = typeof doc.querySelector === 'function' ? doc.querySelector('.dash-bar') : null;
      const oldHeader = bar && typeof bar.querySelector === 'function' ? bar.querySelector('.v6-chat-header') : null;
      if (oldHeader) oldHeader.remove();
      const title = routeTitle(currentRoute);
      shownTree = filterTree(tree, { text: filterText, engine: filterEngine, groups: selectedGroups }, projectRows);
      // #3053: the template wizard and attestation pills are not chat
      // content; they stay in the page (and wired) but out of sight.
      const inChat = Boolean(detail && detail.kind === 'conversation');
      const shown = workspaceVisibility(workspaceMode, inChat);
      const activityElapsed = syncBusy();
      if (root.classList) {
        root.classList.toggle('v6-shell-root--sidebar-collapsed', sidebarCollapsed);
        // #3059: the chat's own toolbar names what it shows, so the route and
        // group headings are hidden from sight (not from screen readers).
        root.classList.toggle('v6-shell-root--chat', inChat);
      }
      root.innerHTML = `
        <a id="v6ShellSkipLink" class="v6-shell-skip-link" href="#v6ShellMain">Skip to main content</a>
        <button type="button" id="v6ShellDrawerToggle" class="v6-shell-drawer-toggle"
          aria-expanded="${drawerOpen ? 'true' : 'false'}" aria-controls="v6ShellSidebar">☰ Menu</button>
        <nav id="v6ShellSidebar" class="v6-shell-sidebar${drawerOpen ? ' is-open' : ''}" aria-label="Fleet navigation">
          ${sidebarIconBarMarkup(searchOpen(), historyOpen)}
          <button type="button" id="v6ShellWizardOpenBtn" class="btn btn-secondary v6-wizard-open" data-workspace-mode="wizard"><span aria-hidden="true">＋</span> New Project / Fleet Wizard</button>
          ${historyOpen ? historyPanelMarkup({ form: historyForm, chatOpen: chatTargetKey() != null, data: historyData }) : ''}
          ${filterControlsMarkup({
            tree, engines: engineIds(), text: filterText, engine: filterEngine, groups: selectedGroups, searchOpen: searchOpen()
          })}
          ${shownTree.length ? sidebarMarkup(shownTree, {
            activeProjectId: currentRoute.projectId,
            activeFleetId: currentRoute.fleetId,
            // #3059: on a project or fleet route the chat talks to its
            // delegate, and that lane is the one marked in the sidebar.
            activeResourceId: currentRoute.resourceId || chatTargetKey(),
            collapsed: collapsedNodes,
            memberInfo: (seatId) => {
              const row = projectRows.get(String(seatId));
              return row ? memberIndicators(row, engineHealth) : null;
            }
          }) : '<p class="v6-sidebar-empty">No projects match these filters.</p>'}
        </nav>
        ${inChat ? '' : telemetryHeaderMarkup(telemetry)}
        <main id="v6ShellMain" class="v6-shell-view" tabindex="-1" aria-label="${escapeHtml(title)}">
          ${workspaceModeBarMarkup(workspaceMode)}
          <div class="v6-shell-header">
            ${sidebarCollapsed ? `<button type="button" id="v6SidebarExpand" class="btn btn-secondary v6-sidebar-expand"
              data-action="toggle-sidebar-drawer" aria-controls="v6ShellSidebar" aria-expanded="false">» Show Fleet</button>` : ''}
            <h1 class="v6-shell-title">${escapeHtml(title)}</h1>
          </div>
          <div id="v6ShellDetail"${shown.detail ? '' : ' hidden'}>${detailMarkup(detail, {
            draft: chatDrafts.get(chatTargetKey()) || '', hoodOpen: chatHoodOpen,
            fleetArmed: fleetArmedKey != null && fleetArmedKey === chatTargetKey(),
            rename: renameOpenKey != null && renameOpenKey === chatTargetKey()
              ? { open: true, draft: renameDraft, warning: renameWarning } : null,
            sidebarCollapsed, activityElapsed, telemetry, dismissedQuestions: dismissedFor(chatTargetKey()),
            pending: pendingSends.filter((p) => p.key === chatTargetKey()),
            verbosity
          })}</div>
          <div id="v6ShellWizard"${shown.wizard ? '' : ' hidden'}>${fleetWizardMarkup(templates)}</div>
          <div id="v6ShellAttestation"${shown.attestation ? '' : ' hidden'}>${modelAttestationMarkup(attestation)}</div>
          <section id="v6WorkspacePanel" class="v6-workspace-panel" role="tabpanel"
            aria-labelledby="v6WorkspaceMode-${shown.panel ? workspaceMode : 'sprint'}"${shown.panel ? '' : ' hidden'}>${shown.panel ? workspacePanelMarkup(workspaceMode) : ''}</section>
        </main>
        ${watermarkFooterMarkup(showWatermark, telemetry, usageMarkupNow())}
      `;
      const shownChat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      paintedQuestions = chatQuestionInner(questionsNow());
      paintedMedusa = medusaIndicatorMarkup(shownChat && shownChat.medusa);
      wireControls();
      restoreViewState(saved);
      if (typeof options.onRender === 'function') options.onRender(currentRoute);
    }

    function toggleDrawer(force) {
      drawerOpen = typeof force === 'boolean' ? force : !drawerOpen;
      render();
    }

    /**
     * Hide or show the desktop sidebar column (#3046), remembered across
     * visits. The mobile `☰ Menu` drawer is separate and unaffected.
     * @param {boolean} [force] - Collapse when true, expand when false; flip when omitted.
     */
    function toggleSidebar(force) {
      sidebarCollapsed = typeof force === 'boolean' ? force : !sidebarCollapsed;
      prefs.set('tc_v6_sidebar_collapsed', sidebarCollapsed);
      render();
    }

    /** @param {Iterable<string>} keys - The full set of folded node keys. */
    function setCollapsedNodes(keys) {
      collapsedNodes = new Set(keys);
      prefs.set('tc_v6_collapsed_nodes', [...collapsedNodes]);
      render();
    }

    /** @returns {string[]} Every engine id a known project runs, sorted, for the engine select. */
    function engineIds() {
      const ids = new Set();
      projectRows.forEach((row) => { if (row && row.engine && row.engine.id) ids.add(String(row.engine.id)); });
      return [...ids].sort();
    }

    /** @param {Iterable<string>} ids - The logical project ids to show; empty shows all. */
    function setSelectedGroups(ids) {
      selectedGroups = new Set(ids);
      prefs.set('tc_v6_selected_groups', [...selectedGroups]);
      render();
    }

    /** @returns {boolean} Whether the search and engine filters show (#3068). */
    function searchOpen() {
      return searchToggled;
    }

    /**
     * Open or close the search and engine filters (#3068). Closing clears
     * both, so a filter the operator can no longer see never narrows the tree.
     */
    function toggleSearch() {
      if (searchToggled) {
        searchToggled = false;
        filterText = '';
        filterEngine = '';
      } else {
        searchToggled = true;
      }
      render();
    }

    /**
     * Select a logical project (API; the sidebar's own picker sets the
     * selection directly, #3068). Additive toggles it in the selection;
     * otherwise it becomes the only selection, or clears it when it already was.
     * @param {string} id
     * @param {boolean} [additive]
     */
    function selectGroup(id, additive) {
      const key = String(id);
      if (additive) {
        const next = new Set(selectedGroups);
        if (next.has(key)) next.delete(key); else next.add(key);
        setSelectedGroups(next);
        return;
      }
      setSelectedGroups(selectedGroups.size === 1 && selectedGroups.has(key) ? [] : [key]);
    }

    /** @param {string} key - A project or fleet fold key. */
    function toggleNode(key) {
      const next = new Set(collapsedNodes);
      if (next.has(key)) next.delete(key); else next.add(key);
      setCollapsedNodes(next);
    }

    function navigate(hash) {
      if (win && win.location) {
        win.location.hash = hash;
      } else {
        // No real location to drive a hashchange event (e.g. a sandbox
        // with no window) — re-render directly from the requested hash.
        options.getHash = () => hash;
        render();
      }
    }

    function handleHashChange() { render(); }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('hashchange', handleHashChange);
    }

    render();

    return {
      getRoute() { return currentRoute; },
      navigate,
      toggleDrawer,
      isDrawerOpen() { return drawerOpen; },
      toggleSidebar,
      isSidebarCollapsed() { return sidebarCollapsed; },
      selectGroup,
      /** @param {Object<string, {status?: string}>|null} health - Engine id -> status (#3053). */
      setEngineHealth(health) {
        engineHealth = health && typeof health === 'object' ? health : {};
        render();
      },
      setProjects(rows) {
        projectRows = new Map((Array.isArray(rows) ? rows : [])
          .filter((r) => r && r.id != null).map((r) => [String(r.id), r]));
        render();
      },
      setTree(nextTree) { tree = buildHierarchyTree(nextTree || []); render(); },
      setTelemetry(bar) { telemetry = bar || null; render(); },
      setTemplates(nextTemplates) { templates = Array.isArray(nextTemplates) ? nextTemplates : []; render(); },
      setAttestation(nextAttestation) { attestation = nextAttestation || null; render(); },
      setDetail(nextDetail) {
        detail = nextDetail || null;
        // #3066: an open history panel follows the chat to another member (or
        // this one renamed); a reload of the same chat, which passes through a
        // loading view, keeps the list and any snapshot open.
        if (historyOpen && chatTargetKey() != null && historyWho() !== historyFor) {
          historyData = null;
          requestHistory();
          return;
        }
        render();
      },
      /**
       * Replace only the chat's live output panel (#3047): a poll every few
       * seconds must not rebuild the page under an operator mid-message.
       * @param {{lines?: string[], error?: string}|null} peek
       */
      setPeek(peek) {
        this.setLive({ peek, live: detail && detail.view && detail.view.chat ? detail.view.chat.live : null });
      },
      /**
       * Replace the chat's live parts only (#3052): its raw output, the
       * replies extracted from it, the pinned question and the activity
       * line — never the composer, so a poll every few seconds cannot rebuild
       * the page under an operator mid-message.
       * The switchboard's traffic and the Medusa indicator (#3076) are
       * replaced too; `medusa`, when the update carries it, is the latest
       * status.
       * @param {{peek: object|null, live: {turns: Array, question: string|null, activity: string|null}|null,
       *   medusa?: object|null}} update
       */
      setLive(update) {
        if (!detail || detail.kind !== 'conversation' || !detail.view) return;
        const peek = update ? update.peek : null;
        const live = update && update.live ? update.live : null;
        const name = String((detail.view.project && detail.view.project.name) || '');
        const medusa = update && 'medusa' in update ? update.medusa : detail.view.chat && detail.view.chat.medusa;
        const thumbs = update && update.thumbs ? update.thumbs : (detail.view.chat && detail.view.chat.thumbs);
        detail = Object.assign({}, detail, {
          view: Object.assign({}, detail.view, { chat: Object.assign({}, detail.view.chat, { peek, live, medusa, thumbs }) })
        });
        const traffic = doc.getElementById('v6ChatSwitchboard');
        if (traffic) traffic.innerHTML = switchboardMarkup(switchboardItems(detail.view.events, live));
        paintMedusa(medusa);
        const peekEl = doc.getElementById('v6ChatPeek');
        if (peekEl) {
          const atBottom = isAtBottom(peekEl);
          peekEl.innerHTML = chatPeekMarkup(peek);
          if (atBottom) pinToBottom(peekEl);
        }
        const stream = doc.getElementById('v6ChatStream');
        const streamAtBottom = isAtBottom(stream);
        const liveEl = doc.getElementById('v6ChatLive');
        if (liveEl) liveEl.innerHTML = liveTurnsMarkup(live ? live.turns : [], name, verbosity, thumbsNow());
        paintTucked(live);
        paintRecorded();
        if (streamAtBottom) pinToBottom(stream);
        paintQuestions();
        const a = doc.getElementById('v6ChatActivity');
        const elapsed = syncBusy();
        if (a) {
          const label = busyLabelNow();
          a.innerHTML = chatActivityInner(label, elapsed);
          a.className = `v6-chat-activity${label ? ' is-busy' : ''}`;
        }
      },
      /**
       * The history panel's results or snapshot, from the page (#3066).
       * @param {object|null} data
       */
      setHistory(data) { historyData = data || null; render(); },
      /**
       * The outcome of a rename (#3071): done closes the form; a refusal keeps
       * it open with the typed name, and an orphan-risk refusal shows the
       * server's warning with a Rename anyway button.
       * @param {{ok: boolean, warning?: string|null}} result
       */
      renameResult(result) {
        if (result && result.ok) {
          renameOpenKey = null;
          renameDraft = null;
          renameWarning = null;
        } else {
          renameWarning = (result && result.warning) || null;
        }
        render();
      },
      isHistoryOpen() { return historyOpen; },
      /**
       * Forget a chat's composer text once it has been sent.
       * @param {*} [projectId] - The project it was sent to; the chat on screen when omitted.
       */
      clearChatDraft(projectId) { chatDrafts.delete(projectId != null ? String(projectId) : chatTargetKey()); },
      /**
       * A send has begun (#3079 item 6): the composer empties at once and
       * the message shows at the bottom of its chat until the send settles.
       * @param {*} projectId - The chat it was sent from.
       * @param {string} text - What was sent.
       * @param {*} id - The send's id, which the recorded copy carries.
       */
      beginSend(projectId, text, id) {
        const key = String(projectId);
        chatDrafts.delete(key);
        pendingSends = pendingSends.filter((p) => p.id !== id).concat({ key, text: String(text || ''), id });
        if (key !== chatTargetKey()) return;
        // #3079: a send going out is the operator answering, so the queue
        // clears — here, once it really goes, not when Send was pressed.
        dismissQuestions(questionsNow());
        const input = doc.getElementById('v6ChatInput');
        if (input) input.value = '';
        paintRecorded();
      },
      /**
       * A send has settled (#3079 item 6): the pending message goes. Given
       * the text back, the send failed, and the text returns to the
       * composer unless something new has been typed there since.
       * @param {*} projectId
       * @param {string} [restore]
       * @param {*} [id] - The send that settled; its bubble alone goes.
       */
      endSend(projectId, restore, id) {
        const key = String(projectId);
        // That send's bubble only; without an id, every one of the project's.
        pendingSends = pendingSends.filter((p) => !(p.key === key && (id === undefined || p.id === id)));
        if (typeof restore === 'string' && restore && !chatDrafts.get(key)) {
          chatDrafts.set(key, restore);
          const input = key === chatTargetKey() ? doc.getElementById('v6ChatInput') : null;
          if (input && !input.value) input.value = restore;
        }
        if (key === chatTargetKey()) paintRecorded();
      },
      /**
       * The chat's thumbnails changed (#3082): file name → `blob:` URL.
       * Redraws the message lists in place, never the composer.
       * @param {Object<string, string>} thumbs
       */
      setThumbs(thumbs) {
        if (!detail || detail.kind !== 'conversation' || !detail.view) return;
        detail = Object.assign({}, detail, { view: Object.assign({}, detail.view, { chat: Object.assign({}, detail.view.chat, { thumbs: thumbs || {} }) }) });
        const view = detail.view;
        const liveEl = doc.getElementById('v6ChatLive');
        if (liveEl) liveEl.innerHTML = liveTurnsMarkup(view.chat.live ? view.chat.live.turns : [], String((view.project && view.project.name) || ''), verbosity, thumbsNow());
        paintTucked(view.chat.live);
        paintRecorded();
      },
      /**
       * Run `fn` when the shell is torn down (#3082: the chat's blob URLs
       * are released then).
       * @param {Function} fn
       */
      onDestroy(fn) { if (typeof fn === 'function') destroyHooks.push(fn); },
      /**
       * The flags of the send the composer is handing over right now (#3082):
       * `{priority, startupIntervention}` for a Force Send, else null.
       * @returns {{priority: boolean, startupIntervention: boolean}|null}
       */
      takeSendFlags() { const f = sendFlags; sendFlags = null; return f; },
      /**
       * The usage routes' latest answers (#3085): redraws the meter.
       * @param {{windows: object|null, sessions: object|null}|null} data
       */
      setUsage(data) {
        usage = data && data.windows ? data : null;
        paintUsage();
      },
      /**
       * What the meter's Set buttons call (#3085): `calibrate(provider,
       * weeklyPct, fiveHourPct)` resolving to `{ok, error?}`. Handed over by
       * the page's controller, since the page wires no option for it.
       * @param {{calibrate: Function}} actions
       */
      setUsageActions(actions) { usageActions = actions || null; },
      /** @returns {string} The workspace mode shown (#3086). */
      getWorkspaceMode() { return workspaceMode; },
      /** @param {string} mode - Switch the workspace mode in place (#3086). */
      setWorkspaceMode(mode) { setWorkspaceMode(mode); },
      destroy() {
        destroyHooks.splice(0).forEach((fn) => fn());
        if (tickerId != null) { stopTicker(tickerId); tickerId = null; }
        busy = null;
        if (win && typeof win.removeEventListener === 'function') win.removeEventListener('hashchange', handleHashChange);
      }
    };
  }

  global.tcV6ParseRoute = parseRoute;
  global.tcV6RouteHash = routeHash;
  global.tcV6RouteTitle = routeTitle;
  global.tcV6BuildHierarchyTree = buildHierarchyTree;
  global.tcV6SidebarMarkup = sidebarMarkup;
  global.tcV6FilterTree = filterTree;
  global.tcV6TelemetryHeaderMarkup = telemetryHeaderMarkup;
  global.tcV6FleetWizardMarkup = fleetWizardMarkup;
  global.tcV6ModelAttestationMarkup = modelAttestationMarkup;
  global.tcV6WatermarkFooterMarkup = watermarkFooterMarkup;
  global.tcV6SynthesizeTreeFromProjects = synthesizeTreeFromProjects;
  global.tcV6FleetPlanMarkup = fleetPlanMarkup;
  global.tcV6ConversationViewMarkup = conversationViewMarkup;
  global.tcV6SettingsViewMarkup = settingsViewMarkup;
  global.tcV6WalkthroughsMarkup = walkthroughsMarkup;
  global.tcV6RecoveryConsoleMarkup = recoveryConsoleMarkup;
  global.tcV6KnowledgeBaseMarkup = knowledgeBaseMarkup;
  global.tcV6PlatformViewMarkup = platformViewMarkup;
  global.tcV6WhatIfMarkup = whatIfMarkup;
  global.tcV6ViewToggleLabel = viewToggleLabel;
  global.tcV6TuckAdminControls = tuckAdminControls;
  global.tcV6PickAttestation = pickAttestation;
  global.tcV6ResolveRouteProject = resolveRouteProject;
  global.tcV6ResolveDelegateProject = resolveDelegateProject;
  global.tcV6ChatKeyAction = chatKeyAction;
  global.tcV6FormatElapsed = formatElapsed;
  global.tcV6ExtractLiveTurns = extractLiveTurns;
  global.tcV6MessageMarkup = messageMarkup;
  global.tcV6UsageMeterModel = usageMeterModel;
  global.tcV6UsageMeterMarkup = usageMeterMarkup;
  global.tcV6LongPromptCommand = longPromptCommand;
  global.tcV6RecordedText = recordedText;
  global.tcV6EventBodyBytes = eventBodyBytes;
  global.tcV6MedusaIndicatorMarkup = medusaIndicatorMarkup;
  global.tcV6SanitizeUploadName = sanitizeUploadName;
  global.tcV6FilesFromEvent = filesFromEvent;
  global.tcV6MemberIndicators = memberIndicators;
  global.tcV6MemberIndicatorsMarkup = memberIndicatorsMarkup;
  global.tcV6WorkspaceVisibility = workspaceVisibility;
  global.tcV6WorkspaceModeBarMarkup = workspaceModeBarMarkup;
  global.tcV6CreateLiveController = createLiveController;
  global.tcCreateV6Shell = tcCreateV6Shell;
})(typeof window !== 'undefined' ? window : globalThis);
