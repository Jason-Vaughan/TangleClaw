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
    // #3154: the generic, non-session-specific landing screen.
    if (segments[0] === 'overview') return { view: 'overview' };
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
      case 'overview': return '#/overview';
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
      case 'overview': return 'Fleet & Workspace Overview';
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

  /** The sidebar rename key for a member row (#3136), by its own seat id. */
  function memberNodeKey(m) { return `m:${m.seatId}`; }

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
   * One sidebar row's inline rename control (#3136): a ✎ button that
   * turns the row into a compact Save/Cancel form (Enter submits as a
   * form always does; Escape cancels, wired alongside the input), or —
   * while open for this exact row — the form itself.
   * @param {string} nodeKey - `projectNodeKey`/`fleetNodeKey`/`m:<seatId>`, matched against `rename.key`.
   * @param {string} name - Current display name.
   * @param {string} idSuffix - The row's own positional suffix (`p0`, `m0-0-1`, …), for stable element ids.
   * @param {{key?: string|null, draft?: string|null, warning?: string|null}} [rename] - The sidebar's one open form, if any.
   * @returns {string} HTML.
   */
  function sidebarRenameControlMarkup(nodeKey, name, idSuffix, rename) {
    const r = rename || {};
    const n = escapeHtml(name);
    if (r.key === nodeKey) {
      const value = escapeHtml(r.draft != null ? r.draft : name);
      const warn = r.warning
        ? `<p id="v6TreeRenameWarning-${idSuffix}" class="v6-sidebar-rename-warning" role="alert">${escapeHtml(r.warning)}</p>
          <button type="button" id="v6TreeRenameConfirm-${idSuffix}" class="btn btn-primary btn-small v6-sidebar-rename-confirm"
            data-rename-node="${escapeHtml(nodeKey)}" title="Rename even though the old folder's engine state stays behind">Rename anyway</button>`
        : '';
      return `<form id="v6TreeRenameForm-${idSuffix}" class="v6-sidebar-rename-form" data-action="sidebar-rename-form"
          data-rename-node="${escapeHtml(nodeKey)}" aria-label="Rename ${n}">
          <label class="sr-only" for="v6TreeRenameInput-${idSuffix}">New name for ${n}</label>
          <input id="v6TreeRenameInput-${idSuffix}" class="filter-input v6-sidebar-rename-input" name="name" value="${value}"
            maxlength="64" autocomplete="off" spellcheck="false" title="Letters, digits, spaces, dashes and underscores">
          <button type="submit" id="v6TreeRenameSave-${idSuffix}" class="btn btn-primary btn-small v6-sidebar-rename-save">Save</button>
          <button type="button" id="v6TreeRenameCancel-${idSuffix}" class="btn btn-secondary btn-small v6-sidebar-rename-cancel"
            data-rename-node="${escapeHtml(nodeKey)}">Cancel</button>
          ${warn}
        </form>`;
    }
    return `<button type="button" id="v6TreeRename-${idSuffix}" class="v6-sidebar-rename-btn" data-rename-node="${escapeHtml(nodeKey)}"
        title="Rename ${n}" aria-label="Rename ${n}"><span aria-hidden="true">✎</span></button>`;
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
   *   collapsed?: Array<string>|Set<string>, memberInfo?: (seatId: string) => object|null,
   *   rename?: {key?: string|null, draft?: string|null, warning?: string|null}}} [opts] -
   *   `memberInfo` gives a member's status indicators (#3053), or null to draw it plain. `rename`
   *   is the sidebar's own open inline-rename form (#3136), at most one at a time.
   * @returns {string} HTML.
   */
  function sidebarMarkup(tree, opts) {
    const options = opts || {};
    const activeProjectId = options.activeProjectId != null ? String(options.activeProjectId) : null;
    const activeFleetId = options.activeFleetId != null ? String(options.activeFleetId) : null;
    const activeResourceId = options.activeResourceId != null ? String(options.activeResourceId) : null;
    const collapsed = new Set(options.collapsed || []);
    const rename = options.rename || {};
    const list = Array.isArray(tree) ? tree : [];
    const items = list.map((project, pi) => {
      const projectActive = activeProjectId === String(project.id);
      const projectHash = routeHash({ view: 'project', projectId: project.id });
      const projectFolded = collapsed.has(projectNodeKey(project));
      // #3117: a single fleet whose name repeats the project's own
      // ("Workspace Projects" -> "Workspace Projects") wastes a whole
      // nesting level and its indentation on Galaxy Fold widths — skip
      // that fleet's own row/toggle and show its members directly under
      // the project, exactly as if there were no intermediate fleet at all.
      const flattenFleet = project.fleets.length === 1 && project.fleets[0].displayName === project.displayName;
      // #3022: a member with a seat id is a real resource — link it to its
      // B2 Conversation View; one without stays plain text.
      const memberItemsFor = (fleet, fi) => fleet.members.map((m, mi) => {
        const label = `${escapeHtml(m.role)} (${escapeHtml(m.seatId)})`;
        if (!m.seatId) return `<li class="v6-shell-member">${label}</li>`;
        const memberActive = activeResourceId === String(m.seatId);
        const memberHash = routeHash({ view: 'conversation', resourceId: m.seatId });
        // #3053 item 4: the member's status, when its project row is known.
        const info = typeof options.memberInfo === 'function' ? options.memberInfo(m.seatId) : null;
        const stateClass = info ? ` is-${info.state}` : '';
        const title = info ? ` title="${escapeHtml(info.title)}"` : '';
        const glyph = info ? `<span class="v6-member-glyph" aria-hidden="true">${info.glyph}</span>` : '';
        // #3136: Fleet Member and Solo Work rename the same way — both are
        // just a member row here, grouped under a real fleet or under the
        // flattened catch-all "Workspace Projects" one.
        const memberIdSuffix = `m${pi}-${fi}-${mi}`;
        const memberKey = memberNodeKey(m);
        if (rename.key === memberKey) return `<li class="v6-shell-member">${sidebarRenameControlMarkup(memberKey, m.role, memberIdSuffix, rename)}</li>`;
        return `<li class="v6-shell-member"><a class="v6-shell-member-link${stateClass}${memberActive ? ' is-active' : ''}"
          aria-current="${memberActive ? 'page' : 'false'}" id="v6TreeLink-m${pi}-${fi}-${mi}" data-rename-dblclick="${escapeHtml(memberKey)}"${title}
          href="${escapeHtml(memberHash)}" data-route="${escapeHtml(memberHash)}">${glyph}${label}</a>${info ? memberIndicatorsMarkup(info) : ''}
          ${sidebarRenameControlMarkup(memberKey, m.role, memberIdSuffix, rename)}</li>`;
      }).join('');
      const fleetItems = projectFolded ? '' : (flattenFleet
        ? memberItemsFor(project.fleets[0], 0)
        : project.fleets.map((fleet, fi) => {
          const fleetActive = projectActive && activeFleetId === String(fleet.id);
          const fleetHash = routeHash({ view: 'fleet', projectId: project.id, fleetId: fleet.id });
          const fleetFolded = collapsed.has(fleetNodeKey(project, fleet));
          const memberItems = fleetFolded ? '' : memberItemsFor(fleet, fi);
          const fleetToggle = fleet.members.length
            ? treeToggleMarkup(`v6TreeToggle-f${pi}-${fi}`, fleetNodeKey(project, fleet), fleet.displayName, fleetFolded)
            : '';
          return `<li>
            <div class="v6-tree-row">${fleetToggle}<a class="v6-shell-fleet${fleetActive ? ' is-active' : ''}" id="v6TreeLink-f${pi}-${fi}"
               aria-current="${fleetActive ? 'page' : 'false'}"
               href="${escapeHtml(fleetHash)}" data-route="${escapeHtml(fleetHash)}">${escapeHtml(fleet.displayName)}</a></div>
            ${memberItems ? `<ul class="v6-shell-members">${memberItems}</ul>` : ''}
          </li>`;
        }).join(''));
      const projectToggle = project.fleets.length
        ? treeToggleMarkup(`v6TreeToggle-p${pi}`, projectNodeKey(project), project.displayName, projectFolded)
        : '';
      // #3136: a Fleet renames by its logical-project row — never the
      // catch-all "Workspace Projects" bucket, which is not a fleet the
      // operator made. Renaming it means giving every current member a
      // new shared prefix (`renameFleetMembers`); there is no separate,
      // independently-stored fleet name to rewrite instead (#3022: this
      // whole tree is synthesized from project name prefixes).
      const projectKey = projectNodeKey(project);
      const isFleet = project.id !== WORKSPACE_PROJECT_ID;
      const projectRow = rename.key === projectKey
        ? sidebarRenameControlMarkup(projectKey, project.displayName, `p${pi}`, rename)
        : `${projectToggle}<a class="v6-shell-project${projectActive ? ' is-active' : ''}" id="v6TreeLink-p${pi}" data-rename-dblclick="${isFleet ? escapeHtml(projectKey) : ''}"
           aria-current="${projectActive ? 'page' : 'false'}"
           href="${escapeHtml(projectHash)}" data-route="${escapeHtml(projectHash)}">${escapeHtml(project.displayName)}</a>${isFleet ? sidebarRenameControlMarkup(projectKey, project.displayName, `p${pi}`, rename) : ''}`;
      return `<li>
        <div class="v6-tree-row">${projectRow}</div>
        ${fleetItems ? `<ul class="${flattenFleet ? 'v6-shell-members' : 'v6-shell-fleets'}">${fleetItems}</ul>` : ''}
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
   * The page's own `sessionStorage` (#3204), or null where reading it
   * throws (the same `SecurityError` a blocked store raises for
   * `localStorage`) or it is unavailable. Unlike `localStorage`, this is
   * scoped to ONE browser tab — exactly what navigation filter state that
   * must never cross-contaminate multiple tabs on different fleets needs.
   * @param {object|null} win
   * @returns {object|null}
   */
  function defaultSessionStorage(win) {
    try {
      return (win && win.sessionStorage) || null;
    } catch { // prawduct:allow prawduct/broad-except -- reading window.sessionStorage throws SecurityError when storage is blocked
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
   * only the detail; the template wizard and attestation show exclusively
   * inside the dedicated Wizard tab (#3165 — before that tab existed, Chat
   * also showed them below an idle #/overview screen, which duplicated the
   * Wizard tab's own content once #3086 added it); the other modes show
   * their panel. Nothing is removed, only hidden, so a chat's draft and
   * scroll survive a trip to another mode.
   * @param {string} mode
   * @param {boolean} inChat - Whether the detail is a conversation.
   * @returns {{detail: boolean, wizard: boolean, attestation: boolean, panel: boolean}}
   */
  function workspaceVisibility(mode, inChat) {
    if (mode === 'wizard') return { detail: false, wizard: true, attestation: true, panel: false };
    if (mode === 'chat' || !isWorkspaceMode(mode)) return { detail: true, wizard: false, attestation: false, panel: false };
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
   * A data mode's panel (#3086): its title, then the content the panel
   * loader produced (already escaped there), or a loading line until it has.
   * @param {string} mode
   * @param {string|null|undefined} [content] - HTML from {@link workspacePanelContent}.
   * @param {string} [extra] - HTML the shell adds after it (the train launch controls).
   * @returns {string} HTML.
   */
  function workspacePanelMarkup(mode, content, extra) {
    const m = WORKSPACE_MODES.find((x) => x.key === mode);
    if (!m || mode === 'chat' || mode === 'wizard') return '';
    return `<h2 class="v6-workspace-panel-title">${escapeHtml(m.label)}</h2>
      ${typeof content === 'string' && content ? content : '<p class="v6-workspace-empty" role="status">Loading…</p>'}${typeof extra === 'string' ? extra : ''}`;
  }

  /** What a train launch status line can be (each is a CSS modifier). */
  const TRAIN_STATUS_KINDS = Object.freeze(['pending', 'ok', 'error']);

  /**
   * The outcome under the train launch buttons (#3088): a status line and the
   * escaped result of the last action.
   * @param {{status: ({kind: string, message: string}|null), result: string}} train
   * @returns {string} HTML.
   */
  function trainOutcomeMarkup(train) {
    const t = train || {};
    const st = t.status && TRAIN_STATUS_KINDS.includes(t.status.kind) ? t.status : null;
    return `<p id="v6TrainStatus" class="v6-train-status${st ? ` is-${st.kind}` : ''}" role="status">${st ? escapeHtml(st.message) : ''}</p>`
      + `<div id="v6TrainResult" class="v6-train-result">${typeof t.result === 'string' ? t.result : ''}</div>`;
  }

  /**
   * The train launch controls under the Charter & Roadmap panel (#3088): a
   * cars list, a fleet id, and Compute waves, Check disjointness and Start
   * wave run, disabled while one is on its way.
   * @param {{cars: string, fleet: string, pending: boolean, status: object|null, result: string}} train
   * @returns {string} HTML.
   */
  function trainControlsMarkup(train) {
    const t = train || {};
    const off = t.pending ? ' disabled' : '';
    const button = (id, label) => `<button type="button" id="${id}" class="btn btn-secondary btn-small"${off}>${label}</button>`;
    return `<section class="v6-train-launch" aria-label="Train launch">
      <h3 class="v6-workspace-panel-subtitle">Train launch</h3>
      <label for="v6TrainCars">Cars (JSON: id, dependsOn, files)</label>
      <textarea id="v6TrainCars" class="v6-train-cars" rows="6" spellcheck="false">${escapeHtml(t.cars || '')}</textarea>
      <label for="v6TrainFleet">Fleet id</label>
      <input type="text" id="v6TrainFleet" class="v6-train-fleet" value="${escapeHtml(t.fleet || '')}" autocomplete="off">
      <div class="v6-train-actions">${button('v6TrainComputeWaves', 'Compute waves')}${button('v6TrainValidate', 'Check disjointness')}${button('v6TrainStartRun', 'Start wave run')}</div>
      <div id="v6TrainOutcome">${trainOutcomeMarkup(t)}</div>
    </section>`;
  }

  /**
   * The Charter & Roadmap panel (#3088): the open project's charter, drawn by
   * the sprint UI's charter builder from `{charter, activeVersion}` when it is
   * loaded (else a built-in summary), with its versions and their Activate
   * buttons; then the planned waves. Every value is escaped.
   * @param {{ok: boolean, data?: object, notFound?: boolean, error?: string}|null} charter -
   *   `GET /api/v6/projects/:id/charter`, or null with no project open.
   * @param {{ok: boolean, data?: object, notFound?: boolean, error?: string}} waves - `GET /api/sprint-waves`.
   * @param {object|null} ui - `window.TangleClawSprintWaveUi`, if loaded.
   * @param {{startupSummary?: object|null, approvedRoles?: string[]}} [extra] - The active charter's
   *   startup summary (`GET .../charter/startup-summary`, which carries its title, mission and version) and
   *   its approved roles (`GET .../charter/export`); the charter row itself carries neither.
   * @returns {string} HTML.
   */
  function charterPanelContent(charter, waves, ui, extra) {
    const more = extra && typeof extra === 'object' ? extra : {};
    const startupSummary = more.startupSummary && typeof more.startupSummary === 'object' ? more.startupSummary : null;
    const approvals = (Array.isArray(more.approvedRoles) ? more.approvedRoles : []).filter((r) => typeof r === 'string' && r)
      .map((role) => ({ approver_role: role }));
    let top;
    if (!charter) top = '<p class="v6-workspace-empty">Open a project\'s chat to see its charter.</p>';
    else if (!charter.ok) {
      top = charter.notFound ? '<p class="v6-workspace-empty">This project has no charter yet.</p>'
        : `<p class="v6-workspace-empty is-error">Could not load the charter: ${escapeHtml(charter.error || 'the server did not answer')}.</p>`;
    } else {
      const d = charter.data && typeof charter.data === 'object' ? charter.data : {};
      const c = d.charter && typeof d.charter === 'object' ? d.charter : {};
      const versions = Array.isArray(d.versions) ? d.versions : [];
      const activeVersion = versions.find((v) => v && c.active_version_id != null && String(v.id) === String(c.active_version_id)) || null;
      let drawn = null;
      if (ui && typeof ui.renderCharterReadinessPanel === 'function') {
        try {
          // #3112 (PRR-A R1 NOTE): sprint-wave-ui.js's own doc comment names
          // this exact passthrough as the one piece missing to compose the
          // Release-First Roadmap into this panel. getSprintData() has no
          // `snapshot` field yet (that's the real #3112 gap, out of this
          // car's scope), so this is a forward-compatible no-op today —
          // null until something upstream starts sending one.
          const roadmapSnapshot = waves && waves.ok && waves.data && waves.data.snapshot && typeof waves.data.snapshot === 'object'
            ? waves.data.snapshot : null;
          const html = ui.renderCharterReadinessPanel({ charter: c, activeVersion, startupSummary, approvals, roadmapSnapshot });
          if (typeof html === 'string') drawn = html;
        } catch (err) { // prawduct:allow prawduct/broad-except -- a builder from another car that throws must not blank the panel; the built-in summary stands in
          drawn = null;
        }
      }
      if (drawn == null) {
        const title = startupSummary && startupSummary.title ? startupSummary.title : 'No active charter';
        const number = startupSummary && startupSummary.versionNumber != null ? startupSummary.versionNumber : null;
        drawn = `<p class="v6-workspace-item-stage">${escapeHtml(title)}${c.status ? ` · ${escapeHtml(c.status)}` : ''}${number != null ? ` · version ${escapeHtml(number)}` : ''}</p>`;
      }
      top = `${drawn}${charterVersionsMarkup(d)}`;
    }
    return `<section class="v6-charter-section" aria-label="Charter">${top}</section>`
      + `<section class="v6-charter-section" aria-label="Planned waves"><h3 class="v6-workspace-panel-subtitle">Planned waves</h3>${workspacePanelContent('charter', waves, null)}</section>`;
  }

  /**
   * Read the train launch's cars list (#3088): a JSON array of cars, each with
   * a string `id` and optional `dependsOn` and `files` string lists.
   * @param {string} text
   * @returns {{ok: true, cars: Array<{id: string, dependsOn: string[], files: string[]}>}|{ok: false, error: string}}
   */
  function parseTrainCars(text) {
    let parsed;
    try {
      parsed = JSON.parse(String(text || '').trim() || 'null');
    } catch (err) { // prawduct:allow prawduct/broad-except -- JSON.parse only throws SyntaxError; its message becomes the operator's error line
      return { ok: false, error: `the cars list is not valid JSON (${err.message})` };
    }
    if (!Array.isArray(parsed) || !parsed.length) return { ok: false, error: 'list at least one car, as [{"id": "...", "dependsOn": [], "files": []}]' };
    const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
    const cars = [];
    for (const car of parsed) {
      if (!car || typeof car !== 'object' || typeof car.id !== 'string' || !car.id.trim()) return { ok: false, error: 'every car needs a text "id"' };
      cars.push({ id: car.id.trim(), dependsOn: strings(car.dependsOn), files: strings(car.files) });
    }
    return { ok: true, cars };
  }

  /**
   * A train launch result, escaped (#3088): computed waves, a disjointness
   * check, or a started wave run.
   * @param {('waves'|'disjointness'|'run')} kind
   * @param {object} data - The route's answer.
   * @returns {string} HTML.
   */
  function trainResultMarkup(kind, data) {
    const d = data && typeof data === 'object' ? data : {};
    const code = (v) => `<code>${escapeHtml(v)}</code>`;
    if (kind === 'waves') {
      const waves = Array.isArray(d.waves) ? d.waves.filter(Array.isArray) : [];
      if (!waves.length) return '<p class="v6-workspace-empty">No waves.</p>';
      return `<ol class="v6-train-waves">${waves.map((w) => `<li>${w.map(code).join(', ')}</li>`).join('')}</ol>`;
    }
    if (kind === 'disjointness') {
      const r = d.result && typeof d.result === 'object' ? d.result : d;
      const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
      const collisions = list(r.collisions);
      const oversized = list(r.oversizedCars);
      const drift = list(r.scopeDrift);
      if (!collisions.length && !oversized.length && !drift.length) return '<p class="v6-train-ok">Disjoint: no shared files, no oversized cars, no scope drift.</p>';
      const files = (v) => (Array.isArray(v) ? v.map(code).join(', ') : '');
      return `<ul class="v6-workspace-list">${[
        ...collisions.map((c) => `<li class="v6-workspace-item is-error">${code(c.carA)} and ${code(c.carB)} share ${files(c.files)}</li>`),
        ...oversized.map((c) => `<li class="v6-workspace-item is-error">${code(c.carId)} bundles ${escapeHtml(c.issueCount)} issues</li>`),
        ...drift.map((c) => `<li class="v6-workspace-item is-error">${code(c.carId)} drifts: declared only ${files(c.declaredOnly) || 'none'}; touched only ${files(c.actualOnly) || 'none'}</li>`)
      ].join('')}</ul>`;
    }
    if (kind === 'run') {
      const waves = Array.isArray(d.waves) ? d.waves.length : 0;
      return `<p class="v6-train-ok">Started wave run ${code(d.id || '?')} with ${waves} wave${waves === 1 ? '' : 's'}.</p>`;
    }
    return '';
  }

  /**
   * A project's charter versions with an Activate button on each version that
   * is not the active one (#3088), escaped.
   * @param {{charter?: object, versions?: Array<object>}} data - `GET /api/v6/projects/:id/charter`.
   * @returns {string} HTML.
   */
  function charterVersionsMarkup(data) {
    const d = data && typeof data === 'object' ? data : {};
    const charter = d.charter && typeof d.charter === 'object' ? d.charter : {};
    const activeId = charter.active_version_id != null ? String(charter.active_version_id) : null;
    const versions = Array.isArray(d.versions) ? d.versions.filter((v) => v && typeof v === 'object' && Number.isInteger(Number(v.id))) : [];
    if (!versions.length) return '<p class="v6-workspace-empty">This charter has no versions yet.</p>';
    return `<ul class="v6-workspace-list v6-charter-versions">${versions.map((v) => {
      const id = String(Number(v.id));
      const active = activeId === id;
      const number = v.version_number != null ? String(v.version_number) : id;
      const label = `Version ${number}`;
      return `<li class="v6-workspace-item"><span class="v6-workspace-item-id">${escapeHtml(label)}</span>`
        + (v.created_at ? ` <span class="v6-workspace-item-stage">${escapeHtml(v.created_at)}</span>` : '')
        + (active ? ' <span class="v6-workspace-item-lane">active</span>'
          : ` <button type="button" id="v6CharterActivate-${id}" class="btn btn-secondary btn-small v6-charter-activate" data-version-id="${id}" data-version-number="${escapeHtml(number)}"`
            + ` aria-label="Activate ${escapeHtml(label)}">Activate</button>`)
        + '</li>';
    }).join('')}</ul>`;
  }

  /**
   * What each dispatch stage is called when the sprint UI has not loaded
   * (the stages `lib/native-sprint-tracker.js#syncWaveDispatchState` assigns,
   * named as `public/sprint-wave-ui.js` names them).
   */
  const WORKSPACE_STAGE_LABELS = Object.freeze({
    unassigned: 'Unassigned', claimed: 'Claimed', 'in-progress': 'In Progress', 'in-review': 'In Review',
    blocked: 'Blocked', closed: 'Closed'
  });

  /** The sprint report's hero figures, in the order the built-in Kaizen & Reports panel lists them. */
  const WORKSPACE_KPI_LABELS = Object.freeze([
    ['issuesClosed', 'Issues closed'], ['builderPRs', 'Builder PRs'], ['waves', 'Waves'],
    ['fileCollisions', 'File collisions'], ['reviewRounds', 'Review rounds'], ['cycleTimeHours', 'Cycle time (h)'],
    ['netLOC', 'Net LOC'], ['releaseCommit', 'Release commit']
  ]);

  /**
   * A data mode's panel content (#3086, Rulings A760, A761, A774). A failed
   * read says so: a missing route is "not available on this server yet" (a
   * missing report, "no report for the current sprint on this server yet"),
   * anything else names the reason. Otherwise the sprint UI's
   * own builder draws it when loaded — `renderSprintWaveBoard(container,
   * data)` container-first as on main, the two new builders data-first — and
   * an escaped built-in drawing stands in when it is not, or when it throws.
   * @param {string} mode - `sprint`, `charter` or `kaizen`.
   * @param {{ok: boolean, data?: object, notFound?: boolean, error?: string}} result - The read.
   * @param {object|null} ui - `window.TangleClawSprintWaveUi`, if loaded.
   * @returns {string} HTML.
   */
  function workspacePanelContent(mode, result, ui) {
    const r = result || { ok: false };
    if (!r.ok) {
      // A sprint report's 404 is also its answer for a sprint with no data, so it says only what is true of both.
      if (r.notFound && mode === 'kaizen') return '<p class="v6-workspace-empty">No report for the current sprint on this server yet.</p>';
      return r.notFound
        ? '<p class="v6-workspace-empty">Not available on this server yet.</p>'
        : `<p class="v6-workspace-empty is-error">Could not load this: ${escapeHtml(r.error || 'the server did not answer')}.</p>`;
    }
    const data = r.data && typeof r.data === 'object' ? r.data : {};
    // The charter builder draws a charter, not this payload's waves (#3088), so
    // the waves here are always the built-in list; see charterPanelContent.
    const builder = mode === 'sprint' ? 'renderSprintWaveBoard' : mode === 'kaizen' ? 'renderKaizenLedgerPanel' : null;
    if (builder && ui && typeof ui[builder] === 'function') {
      try {
        const html = mode === 'sprint' ? ui[builder](null, data) : ui[builder](data.report || data);
        if (typeof html === 'string') return html;
      } catch (err) { // prawduct:allow prawduct/broad-except -- a builder from another car that throws must not blank the panel; the built-in drawing stands in
        // Fall through to the built-in drawing.
      }
    }
    if (mode === 'sprint') {
      const dispatch = data.dispatch && typeof data.dispatch === 'object' ? data.dispatch : {};
      const ids = Object.keys(dispatch);
      if (!ids.length) return '<p class="v6-workspace-empty">No cars are on the board yet.</p>';
      return `<ul class="v6-workspace-list">${ids.map((id) => {
        const row = dispatch[id] || {};
        const stage = String(row.stage || '');
        const label = Object.prototype.hasOwnProperty.call(WORKSPACE_STAGE_LABELS, stage) ? WORKSPACE_STAGE_LABELS[stage] : stage;
        return `<li class="v6-workspace-item"><span class="v6-workspace-item-id">${escapeHtml(id)}</span>`
          + (label ? ` <span class="v6-workspace-item-stage">${escapeHtml(label)}</span>` : '')
          + (row.laneName ? ` <span class="v6-workspace-item-lane">${escapeHtml(row.laneName)}</span>` : '')
          + (row.openPrNumber != null ? ` <span class="v6-workspace-item-pr">#${escapeHtml(row.openPrNumber)}</span>` : '')
          + '</li>';
      }).join('')}</ul>`;
    }
    if (mode === 'charter') {
      const waves = Array.isArray(data.waves) ? data.waves.filter((w) => w && typeof w === 'object') : [];
      if (!waves.length) return '<p class="v6-workspace-empty">No waves are planned yet.</p>';
      return `<ul class="v6-workspace-list">${waves.map((w) => {
        const cars = Array.isArray(w.cars) ? w.cars.length : 0;
        return `<li class="v6-workspace-item"><span class="v6-workspace-item-id">Wave ${escapeHtml(w.id == null ? '?' : w.id)}</span>`
          + ` <span class="v6-workspace-item-stage">${cars} car${cars === 1 ? '' : 's'}</span></li>`;
      }).join('')}</ul>`;
    }
    if (mode === 'kaizen') {
      const report = data.report && typeof data.report === 'object' ? data.report : null;
      if (!report) return '<p class="v6-workspace-empty">No report for the current sprint yet.</p>';
      const kpis = report.heroKpis && typeof report.heroKpis === 'object' ? report.heroKpis : {};
      const triggered = (Array.isArray(report.guardrailLedger) ? report.guardrailLedger : []).filter((g) => g && g.triggered);
      return `<p class="v6-workspace-item-stage">Version ${escapeHtml(report.version || 'unknown')}</p>
        <dl class="v6-workspace-kpis">${WORKSPACE_KPI_LABELS.map(([key, label]) => {
          const v = kpis[key];
          return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(v === null || v === undefined ? '—' : v)}</dd></div>`;
        }).join('')}</dl>
        ${triggered.length ? `<ul class="v6-workspace-list">${triggered.map((g) => `<li class="v6-workspace-item">Guardrail ${escapeHtml(g.guardrail)}: ${escapeHtml(g.count)}</li>`).join('')}</ul>` : ''}`;
    }
    return '';
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
  const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

  /** The Fleet sidebar's drag-resizable width (#3133): CSS default, and the drag's own clamp. */
  const V6_SIDEBAR_DEFAULT_WIDTH = 260;
  const V6_SIDEBAR_MIN_WIDTH = 180;
  const V6_SIDEBAR_MAX_WIDTH = 480;

  /** @param {*} width @returns {number} A sidebar width clamped to its drag range; the default when unreadable. */
  function clampSidebarWidth(width) {
    const n = Number(width);
    if (!Number.isFinite(n)) return V6_SIDEBAR_DEFAULT_WIDTH;
    return Math.max(V6_SIDEBAR_MIN_WIDTH, Math.min(V6_SIDEBAR_MAX_WIDTH, n));
  }

  /** The composer input's drag/restore range (#3173): never below a usable minimum, never above a viewport-relative ceiling. */
  const V6_CHAT_INPUT_MIN_HEIGHT = 64;
  const V6_CHAT_INPUT_MAX_HEIGHT = 260;
  const V6_CHAT_INPUT_MAX_VIEWPORT_PCT = 0.30;

  /** The Under the Hood pane's drag/restore range (#3173), same rationale as the composer input's. */
  const V6_CHAT_UTH_MIN_HEIGHT = 80;
  const V6_CHAT_UTH_MAX_HEIGHT = 360;
  const V6_CHAT_UTH_MAX_VIEWPORT_PCT = 0.40;

  /** `#v6ChatStream`'s own floor (#3186), matching `.v6-chat-stream { min-height: 120px; }` in style.css. */
  const V6_CHAT_STREAM_MIN_HEIGHT = 120;

  /**
   * One composer pane height, clamped to `[min, min(maxCap, floor(viewportH * viewportPct))]`
   * (#3173) — `null` for an unreadable `value` (mirrors {@link isFiniteNumber}'s own
   * `null`-on-missing rather than coercing it to 0), so a caller that never had a saved or
   * measured height keeps doing nothing, same as before this clamp existed. `viewportH` of 0 or
   * non-finite (no real `window`, e.g. this file's own unit-test sandbox) falls back to `maxCap`.
   * @param {*} value
   * @param {number} min
   * @param {number} maxCap
   * @param {number} viewportPct
   * @param {number} viewportH
   * @returns {number|null}
   */
  function clampChatPaneHeight(value, min, maxCap, viewportPct, viewportH) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const vh = Number(viewportH);
    const max = Number.isFinite(vh) && vh > 0 ? Math.min(maxCap, Math.floor(vh * viewportPct)) : maxCap;
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Both composer pane heights, clamped together (#3173): an oversized saved or drag-resized
   * `tc_v6_chat_input_height`/`tc_v6_chat_uth_height` must never push `#v6ChatStream` or
   * `#v6ChatForm`/`#v6ChatInput` off-screen or lock scrolling. `viewportH` is taken as a plain
   * argument rather than read from `window` so this stays a pure helper, testable without a real
   * layout — exported as `global.tcV6ClampChatPaneHeights`.
   *
   * #3186: individual caps alone still let both panes grow large enough, together, to starve
   * `#v6ChatStream` and push its own `<summary>` off-screen even though neither pane alone
   * exceeds its own max — so when both are present and the viewport is known, their COMBINED
   * height is also capped to `maxCombined`, trimmed proportionally to each pane's own room above
   * its floor so neither is pushed below it. `maxCombined` itself leaves room for the header,
   * footer, summary bar and `V6_CHAT_STREAM_MIN_HEIGHT`, never shrinking below the sum of both
   * floors even on a tiny viewport.
   * @param {{input?: *, hood?: *}} heights
   * @param {number} viewportH
   * @returns {{input: number|null, hood: number|null}}
   */
  function clampChatPaneHeights(heights, viewportH) {
    const h = heights || {};
    let input = clampChatPaneHeight(h.input, V6_CHAT_INPUT_MIN_HEIGHT, V6_CHAT_INPUT_MAX_HEIGHT, V6_CHAT_INPUT_MAX_VIEWPORT_PCT, viewportH);
    let hood = clampChatPaneHeight(h.hood, V6_CHAT_UTH_MIN_HEIGHT, V6_CHAT_UTH_MAX_HEIGHT, V6_CHAT_UTH_MAX_VIEWPORT_PCT, viewportH);
    const vh = Number(viewportH);
    if (input !== null && hood !== null && Number.isFinite(vh) && vh > 0) {
      const maxCombined = Math.max(V6_CHAT_INPUT_MIN_HEIGHT + V6_CHAT_UTH_MIN_HEIGHT, Math.floor(vh * 0.62));
      const over = input + hood - maxCombined;
      if (over > 0) {
        const inputRoom = input - V6_CHAT_INPUT_MIN_HEIGHT;
        const hoodRoom = hood - V6_CHAT_UTH_MIN_HEIGHT;
        const totalRoom = inputRoom + hoodRoom;
        if (totalRoom > 0) {
          const hoodCut = Math.min(hoodRoom, Math.round(over * (hoodRoom / totalRoom)));
          const inputCut = Math.min(inputRoom, over - hoodCut);
          hood -= hoodCut;
          input -= inputCut;
        }
      }
    }
    return { input, hood };
  }

  /**
   * "Gobble & Fill" (#3186): a drag at one of the 4 pane-boundary resizers
   * trades height 1:1, zero-sum, with whichever neighbor is actually open —
   * never the chat window's overall height, only how the SAME total space
   * splits between `#v6ChatStream`, Under the Hood and the composer. Pure
   * and DOM-free (state is passed in, not measured) so it is testable
   * without a real layout — exported as `global.tcV6TradeChatPaneHeights`.
   * @param {{stream?: number, hood?: number, input?: number, hoodOpen?: boolean}} state
   *   - `stream`/`hood`/`input` are the panes' CURRENT measured heights;
   *   missing/non-finite ones fall back to their own floor, since that is
   *   the same "nothing more to gobble from it" state as already being there.
   * @param {'stream-bottom'|'hood-top'|'hood-bottom'|'composer-top'} boundary
   * @param {number} deltaY - Positive = dragged down, negative = dragged up.
   * @param {number} viewportH
   * @returns {{input: number|null, hood: number|null, stream: number}}
   */
  function tradeChatPaneHeights(state, boundary, deltaY, viewportH) {
    const s = state || {};
    const hoodOpen = Boolean(s.hoodOpen);
    const dy = Number(deltaY) || 0;
    let stream = Number.isFinite(s.stream) ? s.stream : V6_CHAT_STREAM_MIN_HEIGHT;
    let input = Number.isFinite(s.input) ? s.input : V6_CHAT_INPUT_MIN_HEIGHT;
    let hood = Number.isFinite(s.hood) ? s.hood : V6_CHAT_UTH_MIN_HEIGHT;
    // Shrinks `value` by at most `amount`, never below `min`.
    const shrink = (value, min, amount) => Math.max(min, value - Math.max(0, amount));

    if (boundary === 'stream-bottom' || boundary === 'hood-top') {
      if (dy > 0) {
        // Main Chat grows downward by gobbling its open neighbor(s) below,
        // in order: Under the Hood first (if open), then the composer.
        let remaining = dy;
        if (hoodOpen) {
          const next = shrink(hood, V6_CHAT_UTH_MIN_HEIGHT, remaining);
          remaining -= hood - next;
          hood = next;
        }
        if (remaining > 0) {
          const next = shrink(input, V6_CHAT_INPUT_MIN_HEIGHT, remaining);
          remaining -= input - next;
          input = next;
        }
        stream += dy - remaining;
      } else if (dy < 0) {
        // The immediate open neighbor below (Under the Hood if open, else
        // the composer) grows upward by gobbling Main Chat.
        const next = shrink(stream, V6_CHAT_STREAM_MIN_HEIGHT, -dy);
        const gobbled = stream - next;
        stream = next;
        if (hoodOpen) hood += gobbled; else input += gobbled;
      }
    } else if (boundary === 'hood-bottom' || boundary === 'composer-top') {
      if (hoodOpen) {
        if (dy > 0) {
          // The composer shrinks by exactly what it gives up; Under the
          // Hood grows downward by that same amount — zero dead space.
          const next = shrink(input, V6_CHAT_INPUT_MIN_HEIGHT, dy);
          hood += input - next;
          input = next;
        } else if (dy < 0) {
          // The composer grows upward, gobbling Under the Hood first, then
          // Main Chat once Under the Hood hits its own floor.
          let remaining = -dy;
          const nextHood = shrink(hood, V6_CHAT_UTH_MIN_HEIGHT, remaining);
          remaining -= hood - nextHood;
          hood = nextHood;
          if (remaining > 0) {
            const nextStream = shrink(stream, V6_CHAT_STREAM_MIN_HEIGHT, remaining);
            remaining -= stream - nextStream;
            stream = nextStream;
          }
          input += -dy - remaining;
        }
      } else if (dy > 0) {
        // Under the Hood is closed — this boundary is really Main Chat <->
        // Composer directly, same as stream-bottom's own !hoodOpen branch.
        const next = shrink(input, V6_CHAT_INPUT_MIN_HEIGHT, dy);
        stream += input - next;
        input = next;
      } else if (dy < 0) {
        const next = shrink(stream, V6_CHAT_STREAM_MIN_HEIGHT, -dy);
        input += stream - next;
        stream = next;
      }
    }

    const clamped = clampChatPaneHeights({ input, hood }, viewportH);
    return { input: clamped.input, hood: clamped.hood, stream: Math.max(V6_CHAT_STREAM_MIN_HEIGHT, stream) };
  }

  /**
   * This chat frame's single scroll-position coordinator (#3200), unifying
   * `#v6ChatStream` and the Under the Hood group's
   * (`#v6ChatPeek`/`#v6ChatSwitchboard`/`#v6ChatTucked`/`#v6ChatUnderHood`)
   * own follow-bottom wiring with two behaviors neither one covered on its
   * own:
   *  - Toggling `#v6ChatUnderHood` open or closed resizes `#v6ChatStream`'s
   *    own available height (#3173's grid-track stretch), which the
   *    drawer's own `toggle` listener otherwise only ever re-arms the Under
   *    the Hood GROUP's pin for — left alone, `#v6ChatStream` either jumped
   *    or hid its newest message depending on which way the drawer moved.
   *    Enforced here instead: re-pinned to the bottom (synchronously and,
   *    since a thumbnail/unfurl can still be settling, once more next
   *    frame) while pinned, or held at its own last scroll position while
   *    not — never itself flipping the pinned flag, which only the
   *    'scroll' listener `wireStreamPin` wires does.
   *  - A `ResizeObserver` on `#v6ChatStream` catches every OTHER way its
   *    available height can change — a Gobble & Fill pane resizer drag
   *    (#3186), a window resize, or the docked header's own height
   *    changing — none of which fire the drawer's own `toggle` event.
   *
   * A pure, dependency-injected factory — not a closure over any ONE
   * mounted shell's own private state — so it is independently testable
   * and reusable; `tcCreateV6Shell` calls it once per render (since
   * `render` fully replaces the DOM, a fresh call disconnects whatever
   * `ResizeObserver` the previous render's now-detached `#v6ChatStream`
   * node held) handing it ITS OWN `streamPinned`/`pinStream`/
   * `wireStreamPin`/`wirePeekPin`.
   * @param {object} opts
   * @param {Document} opts.doc
   * @param {{ResizeObserver?: Function}|null} [opts.win]
   * @param {Function|null} [opts.raf] - `requestAnimationFrame`, or null to skip the next-frame re-pin.
   * @param {() => boolean} opts.isStreamPinned
   * @param {(el: *) => void} opts.pinStream - Pins `#v6ChatStream` AND records its own last scroll position (closure-owned by the caller).
   * @param {() => number} opts.lastStreamScrollTop
   * @param {() => void} opts.wireStreamPin - Attaches `#v6ChatStream`'s own 'scroll'/jump-to-latest-pill listeners.
   * @param {() => void} opts.wirePeekPin - Attaches `#v6ChatPeek`'s own 'scroll' listener and the drawer's `rearmPeekPin` on 'toggle'.
   * @returns {{disconnect: function(): void}}
   */
  function createChatScrollCoordinator(opts) {
    const doc = opts.doc;
    const win = opts.win;
    const raf = opts.raf;
    opts.wireStreamPin();
    opts.wirePeekPin();
    const enforceStreamOnResize = () => {
      const el = doc.getElementById('v6ChatStream');
      if (!el) return;
      if (opts.isStreamPinned()) {
        opts.pinStream(el);
        if (raf) raf(() => { if (opts.isStreamPinned()) opts.pinStream(doc.getElementById('v6ChatStream')); });
      } else {
        el.scrollTop = opts.lastStreamScrollTop();
      }
    };
    const hood = doc.getElementById('v6ChatUnderHood');
    if (hood) hood.addEventListener('toggle', enforceStreamOnResize);
    let resizeObserver = null;
    const ResizeObserverCtor = (win && typeof win.ResizeObserver === 'function') ? win.ResizeObserver
      : (typeof ResizeObserver === 'function' ? ResizeObserver : null);
    const streamEl = doc.getElementById('v6ChatStream');
    if (ResizeObserverCtor && streamEl) {
      resizeObserver = new ResizeObserverCtor(() => {
        if (opts.isStreamPinned()) opts.pinStream(doc.getElementById('v6ChatStream'));
      });
      resizeObserver.observe(streamEl);
    }
    return { disconnect() { if (resizeObserver) resizeObserver.disconnect(); } };
  }

  /**
   * Drop a persisted chat draft once it is implausibly large to still be a
   * genuine in-progress message (#3133): a composer draft over 2KB is
   * either a stale leftover (an old session's abandoned paste) or an
   * accidental giant one, and resurrecting it on every future load only
   * grows the stored blob further. Applied both when a draft is about to
   * be written to storage and when one is read back, so an oversized entry
   * already on disk from before this existed is dropped on the next read
   * too, not just frozen in place. Pure.
   * @param {Object<string, string>} drafts
   * @param {number} [maxChars] - UTF-16 code units (what `localStorage`
   *   charges a JS string); defaults to 2048 (2KB).
   * @returns {Object<string, string>}
   */
  function pruneStaleChatDrafts(drafts, maxChars = 2048) {
    const out = {};
    Object.keys(drafts || {}).forEach((key) => {
      const value = drafts[key];
      if (typeof value === 'string' && value.length <= maxChars) out[key] = value;
    });
    return out;
  }

  /** How often an open chat re-reads its session's live output (#3047). */
  const CHAT_POLL_MS = 4000;

  /**
   * Under the Hood's scrollback depth (#3135, reverted by #3166): a closed
   * drawer used to read only `PEEK_LINES_SHALLOW` (80 lines) on every poll,
   * reasoning that the collapsed view never showed more anyway — but
   * `extractLiveTurns` parses chat TURNS from this same `lines` read, not
   * just what Under the Hood's own raw panel shows, so a closed drawer was
   * silently truncating `#v6ChatStream` itself: a reply longer than 80
   * terminal lines vanished from the chat the moment the drawer closed.
   * #3166 decouples the two: the deep depth is now unconditional, whether
   * or not Under the Hood is open — the bandwidth saving `PEEK_LINES_SHALLOW`
   * existed for is no longer worth truncating a reply to get.
   */
  const PEEK_LINES_DEEP = 2000;

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

  /**
   * Chat reads between consolidated Fleet Sidebar refreshes (#3201): every
   * 3rd read at {@link CHAT_POLL_MS}, ~12 seconds. `loadProjects()` +
   * `loadEngineHealth()` were previously only re-read on initial route
   * entry, so a sibling session starting or stopping elsewhere left the
   * sidebar's indicator for it stale (still green/red) until the operator
   * navigated away and back.
   */
  const SIDEBAR_EVERY_POLLS = 3;

  /**
   * How often the Fleet Sidebar refreshes on its own, standalone timer
   * (#3201) when no chat poll is already running to piggyback on — Overview,
   * Settings, and "no project resolved". {@link SIDEBAR_EVERY_POLLS} *
   * {@link CHAT_POLL_MS}, so both paths land on the same ~12s cadence.
   */
  const SIDEBAR_POLL_MS = CHAT_POLL_MS * SIDEBAR_EVERY_POLLS;

  /** Reads of a just-sent chat that may show no engine activity before it stops reading as Working (#3057). */
  const AWAIT_REPLY_POLLS = 3;
  const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  /** A plain object whose every value is a string array (#3133 PRR-B R1 BLOCKING 1b: `tc_v6_waiting_on_collapsed`'s own shape). */
  const isStringArrayMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => isStringArray(v[k]));

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

  /** The AI engines every Wizard workflow offers (#3114); also the inline
   * engine picker's own options (#3153) — one list, not two to drift. */
  const WIZARD_ENGINES = Object.freeze(['claude', 'codex', 'antigravity', 'aider']);

  /**
   * The inline, direct engine picker (#3153): a `<select>` an operator can
   * change right from the chat control bar, a sidebar row, or an overview
   * card, without opening the full Settings modal. `id` lets the same
   * markup be reused across those three places without colliding.
   * @param {string} id
   * @param {{engine?: {id?: string}|null}|null} project
   * @param {string} label
   * @returns {string} HTML.
   */
  function engineSelectMarkup(id, project, label) {
    const current = (project && project.engine && project.engine.id) || 'claude';
    const name = (project && project.name) || '';
    const options = WIZARD_ENGINES.map((e) => `<option value="${e}"${current === e ? ' selected' : ''}>${e}</option>`).join('');
    return `<select id="${escapeHtml(id)}" class="btn btn-secondary btn-small v6-engine-select" data-action="change-chat-engine" data-project="${escapeHtml(name)}"
      aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${options}</select>`;
  }

  /** Workflow B's fixed additional-role picker (#3114) — PM is the source project's own role, not a new seat. */
  const WIZARD_FLEET_ROLES = Object.freeze(['Architect', 'Builder', 'PRR', 'Integrator', 'Observer']);

  /**
   * Workflow A's form (#3114): a standalone single-session workspace
   * project, created fresh or attached from an existing path.
   * @param {{name?: string, engine?: string, path?: string}} [form]
   * @returns {string} HTML.
   */
  function wizardStandaloneMarkup(form) {
    const f = form || {};
    const engineOptions = WIZARD_ENGINES.map((e) => `<option value="${e}"${(f.engine || 'claude') === e ? ' selected' : ''}>${e}</option>`).join('');
    return `<form id="v6WizardStandaloneForm" class="v6-wizard-form" aria-label="Create a standalone workspace project">
      <label class="v6-wizard-field">Project name<input type="text" id="v6WizardStandaloneName" class="filter-input" value="${escapeHtml(f.name || '')}" maxlength="64" required></label>
      <label class="v6-wizard-field">AI Engine<select id="v6WizardStandaloneEngine" class="filter-input">${engineOptions}</select></label>
      <label class="v6-wizard-field">Workspace path <span class="v6-wizard-hint">(optional — attaches an existing directory instead of creating one)</span><input type="text" id="v6WizardStandalonePath" class="filter-input" value="${escapeHtml(f.path || '')}" placeholder="/path/to/existing/repo"></label>
      <button type="submit" id="v6WizardStandaloneSubmit" class="btn btn-primary btn-small">Create Workspace Project</button>
    </form>`;
  }

  /**
   * Workflow B's form (#3114): upgrade an existing standalone project into
   * a fleet by giving it a role alongside newly provisioned role seats,
   * all sharing one dash-prefixed name so {@link synthesizeTreeFromProjects}
   * groups them together.
   * @param {{sourceId?: string, roleForSource?: string, fleetName?: string,
   *   engine?: string, roles?: Record<string, number>}} [form]
   * @param {Array<{seatId: string, role: string}>} standaloneProjects - the
   *   "Workspace Projects" catch-all fleet's own members (#3117).
   * @returns {string} HTML.
   */
  function wizardConvertMarkup(form, standaloneProjects) {
    const f = form || {};
    const list = Array.isArray(standaloneProjects) ? standaloneProjects : [];
    const sourceOptions = list.map((p) => (
      `<option value="${escapeHtml(p.seatId)}"${String(f.sourceId || '') === String(p.seatId) ? ' selected' : ''}>${escapeHtml(p.role)}</option>`
    )).join('');
    const engineOptions = WIZARD_ENGINES.map((e) => `<option value="${e}"${(f.engine || 'claude') === e ? ' selected' : ''}>${e}</option>`).join('');
    const roles = f.roles && typeof f.roles === 'object' ? f.roles : {};
    const roleRows = WIZARD_FLEET_ROLES.map((role) => (
      `<label class="v6-wizard-role">${escapeHtml(role)}<input type="number" min="0" max="9" step="1" id="v6WizardConvertRole-${escapeHtml(role)}" class="filter-input v6-wizard-role-count" data-role="${escapeHtml(role)}" value="${Number(roles[role]) || 0}"></label>`
    )).join('');
    if (!list.length) {
      return '<p class="v6-workspace-empty">No standalone workspace projects to convert yet — create one first.</p>';
    }
    return `<form id="v6WizardConvertForm" class="v6-wizard-form" aria-label="Convert a standalone workspace project to a fleet">
      <label class="v6-wizard-field">Source workspace<select id="v6WizardConvertSource" class="filter-input" required>
        <option value="">Choose a project…</option>${sourceOptions}</select></label>
      <label class="v6-wizard-field">Its role in the new fleet<input type="text" id="v6WizardConvertSourceRole" class="filter-input" value="${escapeHtml(f.roleForSource || 'PM')}" maxlength="32"></label>
      <label class="v6-wizard-field">Fleet name<input type="text" id="v6WizardConvertFleetName" class="filter-input" value="${escapeHtml(f.fleetName || '')}" maxlength="48" required></label>
      <label class="v6-wizard-field">Default engine for new seats<select id="v6WizardConvertEngine" class="filter-input">${engineOptions}</select></label>
      <fieldset class="v6-wizard-roles"><legend>Additional role seats</legend>${roleRows}</fieldset>
      <p class="v6-wizard-hint">Live plan preview: the source project becomes <strong>&lt;Fleet name&gt;-&lt;its role&gt;</strong>; each additional seat becomes <strong>&lt;Fleet name&gt;-&lt;role&gt;</strong> (lettered when there is more than one of a role).</p>
      <button type="submit" id="v6WizardConvertSubmit" class="btn btn-primary btn-small">Convert to Fleet</button>
    </form>`;
  }

  /**
   * Workflow C's view (#3114): the existing starter-template list, plus —
   * once a template is picked — its live plan preview and a Provision
   * Fleet action. Clicking a template only sets the Wizard's OWN state
   * (`shell.setWizardPlan`/`setWizardTemplate`); it never touches `detail`.
   * @param {Array<object>} templates
   * @param {string|null} templateId - The selected template, if any.
   * @param {object|null} plan - `POST /api/v6/fleet-templates/:id/plan`'s result.
   * @param {{fleetName?: string, engine?: string}} [form]
   * @returns {string} HTML.
   */
  function wizardTemplatesMarkup(templates, templateId, plan, form) {
    const f = form || {};
    const list = fleetWizardMarkup(templates);
    if (!templateId) return list;
    const engineOptions = WIZARD_ENGINES.map((e) => `<option value="${e}"${(f.engine || 'claude') === e ? ' selected' : ''}>${e}</option>`).join('');
    const planHtml = plan ? fleetPlanMarkup(plan) : '<p class="v6-workspace-empty">Loading plan…</p>';
    return `${list}
      <form id="v6WizardProvisionForm" class="v6-wizard-form" aria-label="Provision this fleet">
        <label class="v6-wizard-field">Fleet name<input type="text" id="v6WizardFleetName" class="filter-input" value="${escapeHtml(f.fleetName || '')}" maxlength="48" required></label>
        <label class="v6-wizard-field">Default engine<select id="v6WizardFleetEngine" class="filter-input">${engineOptions}</select></label>
        <button type="submit" id="v6WizardProvisionBtn" class="btn btn-primary btn-small"${plan ? '' : ' disabled'}>Provision Fleet</button>
      </form>
      ${planHtml}`;
  }

  /**
   * The Import/Export `.fleet.json` tab (#3115): browse the 2 bundled
   * reference specs and the `tangleclaw.com` marketplace, paste/edit a
   * spec and validate it before anything is created, then provision it —
   * or export an existing standalone workspace as a portable spec.
   * @param {object|null} form - `wizardForm.fleetSpec`: `{json, fleetName, exportProjectId}`.
   * @param {Record<string, object>|null} bundled - `BUNDLED_FLEET_SPECS`, lazy-loaded.
   * @param {{marketplaceUrl: string, description: string}|null} ecosystem
   * @param {{ok: boolean, preview?: object, errors?: Array<{path:string,message:string}>}|null} preview - A validated import, or its errors.
   * @param {{ok: boolean, spec?: object}|null} exported - A completed export.
   * @param {Array<{id: string, label: string, memberSeatIds: string[]}>} exportableFleets -
   *   `exportableFleetsNow()`'s result (#3115, PRR-A R1 C2) — every real
   *   multi-seat fleet AND every standalone workspace, never standalone-only.
   * @returns {string} HTML.
   */
  function wizardFleetSpecMarkup(form, bundled, ecosystem, preview, exported, exportableFleets) {
    const f = form || {};
    const bundledCards = bundled ? Object.keys(bundled).map((id) => {
      const spec = bundled[id];
      return `<div class="v6-wizard-bundled-spec">
        <p class="v6-wizard-bundled-spec-title">${escapeHtml(spec.metadata.name)}</p>
        <p class="v6-wizard-bundled-spec-desc">${escapeHtml(spec.metadata.description)}</p>
        <button type="button" id="v6WizardUseBundled-${escapeHtml(id)}" class="btn btn-secondary btn-small" data-bundled-id="${escapeHtml(id)}">Use this template</button>
      </div>`;
    }).join('') : '<p class="v6-workspace-empty">Loading bundled templates…</p>';
    const banner = ecosystem
      ? `<p class="v6-wizard-marketplace-banner"><span aria-hidden="true">🌐</span> <a href="${escapeHtml(ecosystem.marketplaceUrl)}" target="_blank" rel="noopener noreferrer">Browse Community Fleet Templates on TangleClaw.com</a></p>`
      : '';
    const previewHtml = preview
      ? (preview.ok
        ? `<div class="v6-wizard-fleetspec-preview"><p>${preview.preview.seatCount} seat(s) — ${escapeHtml(preview.preview.metadata.name)}</p>
            <p>${preview.preview.immediateSeatCount} immediate, ${preview.preview.onDemandSeatCount} on-demand; ${preview.preview.rulesCount} rule(s)</p></div>`
        : `<ul class="v6-wizard-fleetspec-errors">${preview.errors.map((e) => `<li>${escapeHtml(e.path)}: ${escapeHtml(e.message)}</li>`).join('')}</ul>`)
      : '';
    // #3115 (PRR-A R1 C2): every real multi-seat fleet, not only standalone
    // workspaces — exportableFleetsNow() walks the whole tree, not just the
    // "workspace" catch-all wizardConvertMarkup's own source dropdown uses.
    const exportOptions = (exportableFleets || []).map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.label)}</option>`).join('');
    const exportedHtml = exported
      ? (exported.ok
        ? `<textarea id="v6WizardFleetSpecExported" class="v6-wizard-fleetspec-json" readonly rows="10">${escapeHtml(JSON.stringify(exported.spec, null, 2))}</textarea>`
        : '<p class="v6-workspace-empty is-error">Export failed.</p>')
      : '';
    return `<div class="v6-wizard-fleetspec">
      ${banner}
      <div class="v6-wizard-bundled-specs">${bundledCards}</div>
      <form id="v6WizardFleetSpecImportForm" class="v6-wizard-form" aria-label="Import a .fleet.json spec">
        <label class="v6-wizard-field">Paste or edit a .fleet.json spec<textarea id="v6WizardFleetSpecJson" class="v6-wizard-fleetspec-json" rows="10">${escapeHtml(f.json || '')}</textarea></label>
        <label class="v6-wizard-field">Fleet name<input type="text" id="v6WizardFleetSpecFleetName" class="filter-input" value="${escapeHtml(f.fleetName || '')}" maxlength="48"></label>
        <button type="submit" id="v6WizardFleetSpecValidateBtn" class="btn btn-secondary btn-small">Validate</button>
        <button type="button" id="v6WizardFleetSpecApplyBtn" class="btn btn-primary btn-small"${preview && preview.ok ? '' : ' disabled'}>Import &amp; Provision</button>
      </form>
      ${previewHtml}
      <form id="v6WizardFleetSpecExportForm" class="v6-wizard-form" aria-label="Export an existing workspace as a .fleet.json spec">
        <label class="v6-wizard-field">Export existing workspace<select id="v6WizardFleetSpecExportProject" class="filter-input"><option value="">Choose…</option>${exportOptions}</select></label>
        <button type="submit" id="v6WizardFleetSpecExportBtn" class="btn btn-secondary btn-small">Export as .fleet.json</button>
      </form>
      ${exportedHtml}
    </div>`;
  }

  /**
   * The interactive Wizard panel inside `#v6ShellWizard` (#3114): 3 tabs —
   * Template (the default, so the starter-fleet list the existing
   * `#v6ShellWizardLaunch-*` tests expect is always visible on first
   * open), New Workspace, and Convert to Fleet. None of them touch
   * `detail` — the Wizard keeps entirely its own state, so switching back
   * to 💬 Chat finds the active conversation exactly as it was.
   * @param {Array<object>} templates - `/api/v6/fleet-templates`'s list.
   * @param {Array<{seatId: string, role: string}>} standaloneProjects
   * @param {{tab?: string, form?: object, templateId?: string|null,
   *   plan?: object|null, status?: {kind: string, message: string}|null}} [wizard]
   * @returns {string} HTML.
   */
  function wizardMarkup(templates, standaloneProjects, wizard) {
    const w = wizard || {};
    const tab = ['templates', 'standalone', 'convert', 'fleetSpec'].includes(w.tab) ? w.tab : 'templates';
    const status = w.status
      ? `<p class="v6-wizard-status is-${escapeHtml(w.status.kind)}" role="status">${escapeHtml(w.status.message)}</p>` : '';
    const tabBtn = (id, label) => (
      `<button type="button" id="v6WizardTab-${id}" class="btn btn-secondary btn-small v6-wizard-tab${tab === id ? ' is-active' : ''}"
        aria-pressed="${tab === id ? 'true' : 'false'}" data-wizard-tab="${id}">${escapeHtml(label)}</button>`
    );
    const tabs = `<div class="v6-wizard-tabs" role="tablist" aria-label="New Project / Fleet Wizard workflow">
      ${tabBtn('templates', '📁 Template')}${tabBtn('standalone', '🆕 New Workspace')}${tabBtn('convert', '🔀 Convert to Fleet')}${tabBtn('fleetSpec', '📦 Fleet Spec')}</div>`;
    const form = w.form || {};
    let body;
    if (tab === 'standalone') body = wizardStandaloneMarkup(form.standalone);
    else if (tab === 'convert') body = wizardConvertMarkup(form.convert, standaloneProjects);
    else if (tab === 'fleetSpec') {
      body = wizardFleetSpecMarkup(form.fleetSpec, w.bundledFleetSpecs, w.ecosystemDirectory, w.fleetSpecPreview, w.fleetSpecExport, w.exportableFleets);
    } else body = wizardTemplatesMarkup(templates, w.templateId, w.plan, form.templates);
    return `<div class="v6-wizard">${tabs}${status}${body}</div>`;
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
    // #3117 (PRR-A/Observer-facing: Galaxy Fold header void): the v6 shell's
    // own render always passes a `bar` argument (`null` before telemetry
    // loads, the reading after), so #v6ShellStatusBar — the only place
    // #dashStats can move into — exists from the shell's very first render,
    // not only once metrics arrive. A caller that omits `bar` entirely
    // (bar === undefined) keeps the old "no status concept" behavior.
    // #3132: a "|" divider between footer telemetry items — purely visual
    // (aria-hidden), since each chip is already its own announced <span>.
    const chips = bar && bar.metrics
      ? TELEMETRY_FOOTER_KEYS.map((key) => telemetryChipMarkup(bar, key)).join('<span class="v6-telemetry-divider" aria-hidden="true">|</span>')
      : '';
    const status = bar !== undefined
      ? `<div id="v6ShellStatusBar" class="v6-shell-status-bar" role="status" aria-label="Server status">${chips}</div>`
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
   * healthy (unknown when nothing reports a percentage). #3132 Req 2 (PRR-B
   * R1 BLOCKING 2a): the #3113 fallback that substituted a chat session's
   * own `contextRemainingPct` for the engine's account-level `% left` is
   * removed — a context window's fullness is not the same quantity as an
   * account's weekly/5h usage allowance, and showing one as the other
   * (`"77% (context)"`) read as a real account reading. `#3132`'s own
   * automated CLI probe (`usageProbeRowMarkup`, below) is the real
   * account-level reading now, with no context substitute needed.
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
      const source = seen.length ? (mixed ? 'live and calibrated' : 'live') : (calibrated.length ? 'calibrated' : 'none');
      const state = remainingPct === null ? 'unknown' : remainingPct <= 5 ? 'critical' : remainingPct <= 25 ? 'warning' : 'healthy';
      return {
        key, label, name, remainingPct, state, source,
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

  /** @param {*} iso @returns {number|null} Hours from now until `iso`, or `null` if it isn't a parseable timestamp. */
  function hoursUntilReset(iso) {
    if (typeof iso !== 'string' || !iso) return null;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return (ms - Date.now()) / 3600000;
  }

  /**
   * One usage window's next-reset badge (#3174): `"Resets in 4h 48m ·
   * 2026-11-22 00:55 UTC"`, so clicking the engine usage indicator shows
   * when each engine's 5-hour and weekly quota actually resets, not just
   * the weekly summary the popover header already carries. `''` when `iso`
   * isn't a valid timestamp — callers skip rendering the badge entirely
   * rather than show a broken one.
   * @param {*} iso
   * @returns {string}
   */
  function formatResetBadge(iso) {
    const hours = hoursUntilReset(iso);
    if (hours === null) return '';
    const countdown = formatReset(hours) || 'Resets now';
    const stamp = new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
    return `${countdown} · ${stamp} UTC`;
  }

  /** The state classes a meter pill carries (#3085, A753-1). */
  const USAGE_STATE_CLASSES = Object.freeze({
    healthy: 'is-healthy is-green', unknown: 'is-healthy is-green is-unknown', warning: 'is-warning is-amber', critical: 'is-critical is-red'
  });

  /**
   * The usage meter (#3085, A753-1): one pill per engine, coloured by what
   * it has left, opening a breakdown with one-click calibration.
   *
   * #3174: when `ui.probe` carries a per-engine `weeklyResetAt`/
   * `fiveHourResetAt` (the automated CLI probe's own reading — see
   * {@link usageProbeRowMarkup}), each pill's tooltip and the breakdown
   * table both also show that engine's next-reset badge, not just the
   * popover header's one weekly-reset summary.
   * @param {ReturnType<typeof usageMeterModel>} model
   * @param {{open?: boolean, status?: {kind: string, message: string}|null, probe?: object|null}} [ui]
   * @returns {string} HTML.
   */
  function usageMeterMarkup(model, ui) {
    const open = Boolean(ui && ui.open);
    const status = ui && ui.status ? ui.status : null;
    const reset = formatReset(model.resetHours);
    const probeFor = (key) => (ui && ui.probe && ui.probe[key]) || null;
    const probeResetBadges = (key) => {
      const probeResult = probeFor(key);
      if (!probeResult) return [];
      return [formatResetBadge(probeResult.weeklyResetAt), formatResetBadge(probeResult.fiveHourResetAt)].filter(Boolean);
    };
    const pill = (e) => {
      const left = e.remainingPct === null ? null : Math.round(e.remainingPct);
      const reading = left === null ? `${formatTokens(e.tokens.weekly)} this week` : `${left}% left`;
      const engineReset = probeResetBadges(e.key).join(', ');
      const tip = `${e.name}: ${left === null ? 'no % left reported' : `${left}% left (${e.source})`} · ${formatTokens(e.tokens.fiveHour)} tokens in 5h, ${formatTokens(e.tokens.weekly)} this week${reset ? ` · ${reset}` : ''}${engineReset ? ` · ${engineReset}` : ''}`;
      return `<span class="v6-usage-pill ${USAGE_STATE_CLASSES[e.state]}" data-engine="${e.key}" title="${escapeHtml(tip)}">`
        + `<span class="v6-usage-label">${e.label}</span>`
        + `<span class="v6-usage-bar" aria-hidden="true"><span class="v6-usage-fill" style="width: ${left === null ? 0 : left}%"></span></span>`
        + `<span class="v6-usage-value">${escapeHtml(reading)}</span></span>`;
    };
    const summary = model.engines.map((e) => `${e.name} ${e.remainingPct === null ? 'no reading' : `${Math.round(e.remainingPct)}% left`}`).join(', ');
    const row = (e) => {
      const engineReset = probeResetBadges(e.key).join(' · ');
      return `<tr data-engine="${e.key}"><th scope="row">${e.name}</th>`
        + `<td>${formatTokens(e.tokens.fiveHour)}</td><td>${formatTokens(e.tokens.weekly)}</td><td>${formatTokens(e.tokens.sprint)}</td><td>${e.sessions}</td>`
        + `<td>${e.remainingPct === null ? '—' : `${Math.round(e.remainingPct)}%`}${engineReset ? `<br><span class="v6-usage-probe-reset">${escapeHtml(engineReset)}</span>` : ''}</td>`
        + `<td><span class="v6-usage-calibrate"><label><span class="sr-only">${e.name} weekly % left</span><input type="number" min="0" max="100" step="1" id="v6UsageWeekly-${e.key}" class="filter-input v6-usage-input" placeholder="wk %"></label>`
        + `<label><span class="sr-only">${e.name} 5-hour % left</span><input type="number" min="0" max="100" step="1" id="v6UsageFiveHour-${e.key}" class="filter-input v6-usage-input" placeholder="5h %"></label>`
        + `<button type="button" id="v6UsageSave-${e.key}" class="btn btn-secondary btn-small" data-engine="${e.key}">Set</button></span></td></tr>`;
    };
    return `<button type="button" id="v6EngineUsageMeter" class="v6-usage-meter" aria-expanded="${open ? 'true' : 'false'}" aria-controls="v6EngineUsagePopover"
        aria-label="${escapeHtml(`Engine usage: ${summary}. Open the breakdown.`)}">${model.engines.map(pill).join('<span class="v6-telemetry-divider" aria-hidden="true">|</span>')}</button>`
      + `<div id="v6EngineUsagePopover" class="v6-usage-popover" role="dialog" aria-label="Engine usage"${open ? '' : ' hidden'}>`
      + `<p class="v6-usage-reset">${escapeHtml(reset || 'Weekly reset time unknown')}</p>`
      + `<table class="v6-usage-table"><thead><tr><th scope="col">Engine</th><th scope="col">5h</th><th scope="col">Week</th><th scope="col">Sprint</th><th scope="col">Sessions</th><th scope="col">Left</th><th scope="col">Set % left</th></tr></thead>`
      + `<tbody>${model.engines.map(row).join('')}</tbody></table>`
      + usageProbeMarkup(ui && ui.probe, ui && ui.probeInterval)
      + `<p id="v6EngineUsageStatus" class="v6-usage-status${status ? ` is-${escapeHtml(status.kind)}` : ''}" role="status">${status ? escapeHtml(status.message) : ''}</p></div>`;
  }

  /** Each engine's real account/usage page (#3132) — an external link, never fetched by this page. */
  const USAGE_ACCOUNT_LINKS = Object.freeze({
    claude: 'https://claude.ai/settings/usage',
    codex: 'https://chatgpt.com/codex/settings/usage',
    antigravity: 'https://antigravity.google/'
  });

  /** The automated probe's refresh cadences (#3132), mirroring `lib/usage-windows.js#USAGE_PROBE_INTERVALS`'s own keys. */
  const USAGE_PROBE_INTERVAL_OPTIONS = Object.freeze([
    { value: '15m', label: '15m' }, { value: '30m', label: '30m' }, { value: '1h', label: '1h' }, { value: 'manual', label: 'Manual' }
  ]);

  /** A probe status that found nothing usable, worded for the operator (#3132) — `lib/usage-windows.js#USAGE_PROBE_STATUSES`'s other two values. */
  const USAGE_PROBE_STATUS_LABELS = Object.freeze({ 'not-present': 'Not present', 'not-configured': 'Not configured' });

  /**
   * One engine's row in the automated CLI usage probe section (#3132): a
   * rich progress bar for weekly/5h remaining% once the probe is
   * `'configured'`, or an honest badge — `'Not present'` (the CLI itself
   * isn't on PATH) / `'Not configured'` (it ran but reported nothing
   * usable) — rather than a silent blank, plus the engine's real external
   * account-usage page either way.
   * @param {{key: string, label: string, name: string}} engine
   * @param {object|null} result - `GET /api/usage/probe`'s per-provider shape, or `null` (never probed).
   *   `weeklyResetAt`/`fiveHourResetAt` (#3174), when present, are rendered as a next-reset badge
   *   on that window's own bar — `lib/usage-windows.js` already reports both.
   * @returns {string} HTML.
   */
  function usageProbeRowMarkup(engine, result) {
    const link = `<a class="v6-usage-account-link" href="${escapeHtml(USAGE_ACCOUNT_LINKS[engine.key])}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">↗ Account Usage</a>`;
    if (!result) {
      return `<li class="v6-usage-probe-row" data-engine="${engine.key}"><span class="v6-usage-probe-name">${escapeHtml(engine.name)}</span>`
        + `<span class="v6-usage-probe-badge is-unknown">Not probed yet</span>${link}</li>`;
    }
    if (result.status !== 'configured') {
      const label = USAGE_PROBE_STATUS_LABELS[result.status] || result.status;
      return `<li class="v6-usage-probe-row" data-engine="${engine.key}"><span class="v6-usage-probe-name">${escapeHtml(engine.name)}</span>`
        + `<span class="v6-usage-probe-badge is-${escapeHtml(result.status)}">${escapeHtml(label)}</span>${link}</li>`;
    }
    // #3174: each bar's own next-reset countdown + timestamp, when the probe
    // reported one for that window — clicking the usage indicator should
    // show when each engine's 5-hour and weekly quota actually resets.
    const bar = (pct, label, resetIso) => {
      const value = pctOrNull(pct);
      const resetBadge = formatResetBadge(resetIso);
      return `<span class="v6-usage-probe-bar-wrap"><span class="v6-usage-probe-bar-label">${label}</span>`
        + `<span class="v6-usage-bar" aria-hidden="true"><span class="v6-usage-fill" style="width: ${value === null ? 0 : value}%"></span></span>`
        + `<span class="v6-usage-probe-bar-value">${value === null ? '—' : `${Math.round(value)}% left`}</span>`
        + (resetBadge ? `<span class="v6-usage-probe-reset">${escapeHtml(resetBadge)}</span>` : '')
        + `</span>`;
    };
    // PRR-B R1 BLOCKING 2c: `result.subTiers` (Claude's Fable, Antigravity's
    // non-native model families) carries its own weekly/5h remaining% —
    // the CLI renderer (`lib/tc-verbs.js#renderUsageProbe`) already prints
    // these; this drew only the engine's own top-level bars, silently
    // dropping a sub-tier the probe did observe.
    const subTierRows = Object.keys(result.subTiers || {}).map((tier) => {
      const sub = result.subTiers[tier] || {};
      return `<li class="v6-usage-probe-subtier-row" data-engine="${engine.key}" data-subtier="${escapeHtml(tier)}">`
        + `<span class="v6-usage-probe-name v6-usage-probe-subtier-name">${escapeHtml(tier)}</span>`
        + `<span class="v6-usage-probe-bars">${bar(sub.weeklyRemainingPct, 'Week', sub.weeklyResetAt)}${bar(sub.fiveHourRemainingPct, '5h', sub.fiveHourResetAt)}</span></li>`;
    }).join('');
    return `<li class="v6-usage-probe-row" data-engine="${engine.key}"><span class="v6-usage-probe-name">${escapeHtml(engine.name)}</span>`
      + `<span class="v6-usage-probe-bars">${bar(result.weeklyRemainingPct, 'Week', result.weeklyResetAt)}${bar(result.fiveHourRemainingPct, '5h', result.fiveHourResetAt)}</span>${link}</li>${subTierRows}`;
  }

  /**
   * The automated CLI usage probe's own section of the popover (#3132): the
   * refresh-cadence selector ("15m/30m/1h/Manual", `POST
   * /api/usage/probe/interval`) and one {@link usageProbeRowMarkup} row per
   * engine, below the existing manual-calibration table — this never
   * replaces that table, since a probe result is a best-effort automated
   * reading and the operator's own manual "% left" stays available as a
   * fallback for whichever engine the probe cannot read.
   * @param {{claude: (object|null), codex: (object|null), antigravity: (object|null)}|null} probe
   * @param {string} [interval] - One of {@link USAGE_PROBE_INTERVAL_OPTIONS}'s own values; defaults to `'30m'`.
   * @returns {string} HTML.
   */
  function usageProbeMarkup(probe, interval) {
    const p = probe || {};
    const current = interval || '30m';
    const options = USAGE_PROBE_INTERVAL_OPTIONS.map(({ value, label }) => `<option value="${value}"${current === value ? ' selected' : ''}>${label}</option>`).join('');
    return `<div class="v6-usage-probe" aria-label="Automated CLI usage probe">
      <div class="v6-usage-probe-controls">
        <label class="v6-usage-probe-interval">Auto-refresh<select id="v6UsageProbeInterval" class="filter-input">${options}</select></label>
        <button type="button" id="v6UsageProbeRefresh" class="btn btn-secondary btn-small">↻ Refresh now</button>
      </div>
      <ul class="v6-usage-probe-list">${USAGE_ENGINES.map((e) => usageProbeRowMarkup(e, p[e.key])).join('')}</ul>
    </div>`;
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
   * An accessible horizontal resizer bar at a chat pane boundary (#3186):
   * drag, `ArrowUp`/`ArrowDown`, or double-click to reset (wired in
   * {@link wireComposerResize}). The 3 grip spans are decorative only —
   * the bar itself is the draggable, focusable `role="separator"`.
   * @param {string} id
   * @param {'stream-bottom'|'hood-top'|'hood-bottom'|'composer-top'} boundary
   * @param {'top'|'bottom'} edge
   * @param {string} label
   * @returns {string} HTML.
   */
  function chatPaneResizerMarkup(id, boundary, edge, label) {
    const safeLabel = escapeHtml(label);
    return `<div id="${id}" class="v6-chat-pane-resizer v6-chat-pane-resizer--${edge}" role="separator" aria-orientation="horizontal" tabindex="0" data-chat-resizer="${boundary}" title="${safeLabel} (drag or Up/Down arrows to resize; double-click to reset pane sizes)" aria-label="${safeLabel}"><span class="v6-chat-pane-resizer-grip v6-chat-pane-resizer-grip--left" aria-hidden="true"></span><span class="v6-chat-pane-resizer-grip v6-chat-pane-resizer-grip--center" aria-hidden="true"></span><span class="v6-chat-pane-resizer-grip v6-chat-pane-resizer-grip--right" aria-hidden="true"></span></div>`;
  }

  /**
   * The centered offline startup hero (#3203): what a selected chat shows
   * in place of the stream and composer while its session is offline and
   * the operator has not switched to "View Previous Conversation". Three
   * sub-states, keyed by `chat.launchState` (set by `startSession`):
   * resting (no launch in flight), `'starting'` (an animated ellipsis, via
   * CSS on `.v6-chat-offline-hero-pill.is-starting`), and `'failed'`
   * (diagnostics + Retry/Edit in place of the normal action row).
   * @param {string} name - The project's own name.
   * @param {object} chat - `conversationViewMarkup`'s own `chat`.
   * @returns {string} HTML.
   */
  function offlineHeroMarkup(name, chat) {
    const launch = chat.launchState || null;
    const starting = Boolean(launch && launch.status === 'starting');
    const failed = Boolean(launch && launch.status === 'failed');
    const pillLabel = failed ? 'Launch Failed' : (starting ? 'Starting…' : 'Offline');
    const pillClass = failed ? 'is-failed' : (starting ? 'is-starting' : 'is-offline');
    const editButton = `<button type="button" id="v6ChatEditPropertiesHero" class="btn btn-secondary v6-chat-offline-hero-edit"
      data-action="open-chat-settings">⚙ Edit Session Properties</button>`;
    // #3203 R2: #3202's structured diagnostic (when the server sent one on
    // this failure) names its own title/remediation; otherwise fall back
    // to the plain message startSession already derived from api.lastError.
    const diagnostic = launch && launch.diagnostic;
    const diagnosticMarkup = failed ? `<div class="v6-chat-offline-hero-diagnostic"${diagnostic && diagnostic.code ? ` data-diagnostic-code="${escapeHtml(diagnostic.code)}"` : ''}>
          <h3 class="v6-chat-offline-hero-diagnostic-title">${escapeHtml((diagnostic && diagnostic.title) || 'Launch Failed')}</h3>
          <p class="v6-chat-offline-hero-diagnostic-message">${escapeHtml((diagnostic && diagnostic.message) || launch.message || 'The server refused to start this session.')}</p>
          ${diagnostic && Array.isArray(diagnostic.remediation) && diagnostic.remediation.length
    ? `<ul class="v6-chat-offline-hero-diagnostic-remediation">${diagnostic.remediation.map((step) => `<li>${escapeHtml(String(step))}</li>`).join('')}</ul>`
    : ''}
        </div>` : '';
    const actions = failed
      ? `<div class="v6-chat-offline-hero-failure" role="alert">
          ${diagnosticMarkup}
          <div class="v6-chat-offline-hero-actions">
            <button type="button" id="v6ChatRetryLaunchHero" class="btn btn-primary v6-chat-offline-hero-retry"
              data-action="start-chat-session">↻ Retry Launch</button>
            ${editButton}
          </div>
        </div>`
      : `<div class="v6-chat-offline-hero-actions">
          <button type="button" id="v6ChatStartHero" class="btn btn-primary v6-chat-offline-hero-start"
            data-action="start-chat-session"${starting ? ' disabled' : ''}>▶ Start Session</button>
          <button type="button" id="v6ChatViewHistoryHero" class="btn btn-secondary v6-chat-offline-hero-history"
            data-action="view-offline-history">🕓 View Previous Conversation</button>
          ${editButton}
        </div>`;
    // #3203 R4: aligned with sibling Car V659-W1-C's CSS (PR #3226,
    // public/style.css) -- `.v6-chat-offline-hero` is the outer centering
    // flex container, `is-starting` on IT (not only the pill) is what its
    // `.is-starting .v6-chat-offline-hero-title::after` spinner selector
    // targets, and `.v6-chat-offline-hero-card` is the column card that
    // CSS centers inside it.
    return `<div class="v6-chat-offline-hero${starting ? ' is-starting' : ''}" role="status" aria-label="${escapeHtml(name)} is offline">
      <div class="v6-chat-offline-hero-card">
        <h2 class="v6-chat-offline-hero-heading v6-chat-offline-hero-title">${escapeHtml(name)} is offline
          <span class="v6-chat-offline-hero-pill ${pillClass}">${escapeHtml(pillLabel)}</span>
        </h2>
        <p class="v6-chat-offline-hero-subtitle">This session is not running. Start it to resume your workspace, or inspect its previous conversation and settings.</p>
        ${actions}
      </div>
    </div>`;
  }

  /**
   * One compact Start/Edit bar for {@link offlineHistoryMarkup} (#3203),
   * drawn both above and below the history body — `idSuffix` keeps each
   * copy's element ids unique, since both exist in the DOM at once.
   * @param {string} idSuffix - `'Top'` or `'Bottom'`.
   * @returns {string} HTML.
   */
  function offlineHistoryBarMarkup(idSuffix) {
    return `<div class="v6-chat-offline-history-bar">
      <button type="button" id="v6ChatOfflineHistoryStart${idSuffix}" class="btn btn-primary btn-small v6-chat-offline-hero-start"
        data-action="start-chat-session">▶ Start Session</button>
      <button type="button" id="v6ChatOfflineHistoryReturn${idSuffix}" class="btn btn-secondary btn-small v6-chat-offline-hero-return"
        data-action="return-to-start-card">↩ Return to Start Card</button>
      <button type="button" id="v6ChatOfflineHistoryEdit${idSuffix}" class="btn btn-secondary btn-small v6-chat-offline-hero-edit"
        data-action="open-chat-settings">⚙ Edit Session Properties</button>
    </div>`;
  }

  /**
   * The offline chat's "View Previous Conversation" mode (#3203): the most
   * recent persisted session's own summary sections (what
   * {@link module:lib/continuity} already records; the same source the
   * sidebar's history panel reads), with the compact Start/Edit bar above
   * and below it. Loading, empty and error each read as their own short
   * line, never an empty stream that looks like "no messages yet".
   * @param {object} chat - `conversationViewMarkup`'s own `chat`; reads `chat.offlineHistory`.
   * @returns {string} HTML.
   */
  function offlineHistoryMarkup(chat) {
    const h = chat.offlineHistory || { status: 'loading', snapshot: null, error: null };
    const sections = h.snapshot && Array.isArray(h.snapshot.sections) ? h.snapshot.sections : [];
    const name = String((chat.project && chat.project.name) || '');
    let body;
    if (h.status === 'loading') {
      body = '<p class="v6-chat-offline-history-empty">Loading previous conversation…</p>';
    } else if (h.status === 'error') {
      body = `<p class="v6-chat-offline-history-empty">${escapeHtml(h.error || 'Could not load the previous conversation.')}</p>`;
    } else if (h.status === 'ready' && h.kind === 'events' && Array.isArray(h.events) && h.events.length) {
      // #3203 R3: the project's own persisted B2 conversation events, via
      // the same bubble formatter a live chat's recorded events use — no
      // live attachment blobs or link unfurls are fetched for a closed
      // session, so thumbs/unfurls are passed empty (messageMarkup already
      // renders attachment references without one).
      body = `<ul class="v6-conversation-events v6-chat-offline-history-events">${recordedEventsMarkup(h.events, name, {}, {})}</ul>`;
    } else if (h.status === 'ready' && sections.length) {
      body = `<ol class="v6-chat-offline-history-sections">${sections.map((s) => (
        `<li class="v6-chat-offline-history-section"><h4>${escapeHtml(s.name)}</h4><p>${escapeHtml(s.body)}</p></li>`
      )).join('')}</ol>`;
    } else {
      body = '<p class="v6-chat-offline-history-empty">No previous conversation recorded for this workspace yet.</p>';
    }
    const bar = offlineHistoryBarMarkup('Top');
    return `<div class="v6-chat-offline-history" aria-label="Previous conversation">
      ${bar}
      <div class="v6-chat-offline-history-body">${body}</div>
      ${offlineHistoryBarMarkup('Bottom')}
    </div>`;
  }

  /**
   * Render the B2 Conversation View for one legacy project (#3022
   * deliverable e): its replayed conversation events and an ADR 0026
   * "Open Hood" link to the live terminal page. With no live session it
   * shows the offline startup hero (#3203) — or, once the operator clicks
   * "View Previous Conversation", that session's persisted history —
   * instead of an empty stream that reads as "no messages yet".
   * @param {{project: {id?: *, name?: string}|null, sessionId?: number|null,
   *   events?: Array<{seq?: number, role?: string, content?: string, redacted?: number}>|null,
   *   error?: string|null, chat?: object}} view - `chat.sidebarCollapsed` adds a Show Fleet
   *   button and `chat.activityElapsed` is the busy line's time (#3057); `chat.telemetry`, when
   *   given (null included), is the telemetry bar drawn inside the header row (#3063); `chat.launchState`,
   *   `chat.viewingOfflineHistory` and `chat.offlineHistory` drive the offline hero (#3203).
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
        ? `<ol class="v6-conversation-stream" id="v6ChatRecorded">${recordedEventsMarkup(parts.head, name, chat.thumbs, chat.unfurls)}</ol>`
        : (liveTurns.length || parts.tail.length ? '<ol class="v6-conversation-stream" id="v6ChatRecorded"></ol>'
          : '<p class="v6-conversation-empty">No conversation events recorded for this session yet.</p>');
      tail = recordedEventsMarkup(parts.tail, name, chat.thumbs, chat.unfurls);
    }
    // #3052: the replies the session's live output shows, after what is
    // recorded; its own list so a poll can replace it without a re-render.
    stream = `<div id="v6ChatStream" class="v6-chat-stream" tabindex="0">${stream}
      <ol id="v6ChatLive" class="v6-conversation-stream v6-chat-live-turns" aria-label="Live replies">${liveTurnsMarkup(liveTurns, name, chat.verbosity, chat.thumbs, chat.unfurls)}</ol>
      <ol id="v6ChatRecordedTail" class="v6-conversation-stream v6-chat-recorded-tail">${tail}</ol>
      <ol id="v6ChatPending" class="v6-conversation-stream v6-chat-pending">${pendingMarkup(chat.pending, chat.lastSent, chat.thumbs, chat.unfurls)}</ol>
      <button type="button" id="v6ChatJumpLatest" class="v6-chat-jump-latest"${chat.streamPinned === false ? '' : ' hidden'}
        style="position:sticky;bottom:8px;left:100%;transform:translateX(-100%);z-index:5;white-space:nowrap;"
        aria-label="Jump to newest messages">↓ Newest</button>
    </div>${chatPaneResizerMarkup('v6ChatStreamResizeBottom', 'stream-bottom', 'bottom', 'Resize Main Chat')}`;
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
    // #3203: the offline hero (or, once clicked, its history view) replaces
    // the stream, Under the Hood/old offline banner, waiting-on line,
    // activity line and composer entirely while offline -- none of them
    // mean anything with no session to show or send to. The header above
    // (identity pill, its own small Start button, Settings, etc.) is
    // unchanged for either case.
    const offlineBody = !liveSession
      ? (chat.viewingOfflineHistory ? offlineHistoryMarkup(chat) : offlineHeroMarkup(name, chat))
      : null;
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
          <button type="button" id="v6ChatAutoPreview" class="btn btn-secondary btn-small v6-chat-icon-btn"
            aria-pressed="${chat.autoPreview ? 'true' : 'false'}"
            title="${chat.autoPreview ? 'Show preview by default: on — links auto-unfurl' : 'Show preview by default: off — click 👁 Preview to unfurl a link'}"
            aria-label="Toggle Show preview by default for chat links"><span aria-hidden="true">👁${chat.autoPreview ? '●' : ''}</span></button>
          ${engineSelectMarkup('v6ChatEngineSelect', v.project, `Switch engine for ${name}`)}
          <button type="button" id="v6ChatSettings" class="btn btn-secondary btn-small v6-chat-settings-btn"
            title="Project Settings" aria-label="Project Settings"><span aria-hidden="true">⚙ Edit Session</span></button>
        </div>
      </header>
      ${offlineBody || `${stream}
      <details id="v6ChatUnderHood" class="v6-chat-under-hood${chat.hideHoodTraffic !== false ? ' is-traffic-hidden' : ''}"${chat.hoodOpen ? ' open' : ''}${
        // #3135: a dark-palette modal overlay, in lieu of a style.css rule
        // (reserved for Wave 2's own Car) — inline, so it costs nothing when not active.
        chat.hoodFullScreen ? ' style="position:fixed;inset:0;z-index:9000;width:100%;height:100%;max-width:none;max-height:none;'
          + 'margin:0;background:#0b0f0c;color:#e8f0e2;overflow:auto;padding:16px;box-sizing:border-box;"' : ''
      }>
        <summary>🔧 Under the Hood (Raw CLI &amp; Tool Activity) <span id="v6ChatTuckedCount" class="v6-chat-tucked-count"${chat.hideHoodTraffic !== false ? ' hidden' : ''}>${tuckedCountText(tuckedTurns(liveTurns, chat.verbosity).length)}</span>
          <span id="v6UthStatus" class="v6-uth-status${chatBusyLabel(chat) ? ' v6-uth-status--busy' : ''}" aria-hidden="true">${chatBusyLabel(chat) ? 'Working' : ''}</span>
          <button type="button" id="v6ChatHoodFullScreen" class="btn btn-secondary btn-small v6-chat-hood-fullscreen"
            title="${chat.hoodFullScreen ? 'Exit Full Screen' : 'Full Screen'}" aria-label="${chat.hoodFullScreen ? 'Exit Full Screen' : 'Full Screen'}">
            <span aria-hidden="true">${chat.hoodFullScreen ? '⤡ Exit Full Screen' : '⤢ Full Screen'}</span></button>
          <button type="button" id="v6ChatHoodInteractive" class="btn btn-secondary btn-small v6-chat-hood-interactive"
            aria-pressed="${chat.hoodInteractive ? 'true' : 'false'}"
            title="Interactive CLI: type directly into THIS drawer's own live pane below — not the chat composer, and not &gt;_ Open Hood's separate Classic View page"
            aria-label="Interactive CLI: type directly into this drawer's own live pane">
            <span aria-hidden="true">⌨ Interactive</span></button>
        </summary>
        ${chatPaneResizerMarkup('v6ChatHoodResizeTop', 'hood-top', 'top', 'Resize Under the Hood (top)')}
        ${verbosityMarkup(chat.verbosity, chat.hideHoodTraffic)}
        <section class="v6-chat-tucked" aria-label="Replies tucked away"${chat.hideHoodTraffic !== false ? ' hidden' : ''}>
          <h3 class="v6-chat-switchboard-title">Tucked away</h3>
          <ol id="v6ChatTucked" class="v6-chat-tucked-list">${tuckedMarkup(tuckedTurns(liveTurns, chat.verbosity), chat.thumbs, chat.unfurls)}</ol>
        </section>
        <section class="v6-chat-switchboard" aria-label="Switchboard and Medusa traffic"${chat.hideHoodTraffic !== false ? ' hidden' : ''}>
          <h3 class="v6-chat-switchboard-title">Switchboard &amp; Medusa traffic</h3>
          <ol id="v6ChatSwitchboard" class="v6-chat-switchboard-list" tabindex="-1">${switchboardMarkup(switchboardItems(v.events, live))}</ol>
        </section>
        <pre id="v6ChatPeek" class="v6-chat-peek" tabindex="0"${chat.hoodInteractive ? ' style="border:2px solid #9CF732;"' : ''}>${
          chat.hoodInteractive ? '<span id="v6ChatHoodLiveIndicator" style="color:#9CF732;display:block;">LIVE CLI — Type directly into pane</span>' : ''
        }${chatPeekMarkup(chat.peek, { hideTraffic: chat.hideHoodTraffic !== false })}</pre>
        ${chatPaneResizerMarkup('v6ChatHoodResizeBottom', 'hood-bottom', 'bottom', 'Resize Under the Hood (bottom)')}
      </details>
      ${waitingOnMarkup(waitingOnModel(live, chat, v.events, liveTurns, chat.knownProjects), chat.collapsedWaitingOn)}
      ${chatActivityMarkup(chatBusyLabel(chat), chat.activityElapsed)}
      ${chatPaneResizerMarkup('v6ChatComposerResizeTop', 'composer-top', 'top', 'Resize Composer')}
      <form id="v6ChatForm" class="v6-chat-composer" data-action="send-chat-form" aria-label="Message ${escapeHtml(name)}">
        <div id="v6ChatAttachments" class="v6-chat-attachments" aria-live="polite">${attachmentChipsMarkup(chat.attachments)}</div>
        <div id="v6ChatInputWrap" class="v6-chat-input-wrap">
          <textarea id="v6ChatInput" class="v6-chat-input" name="message" rows="3" aria-label="Message to ${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}"${boxDisabled}>${escapeHtml(chat.draft || '')}</textarea>
          <button type="button" id="v6ChatAttachBtn" class="v6-chat-attach-btn" aria-label="Attach files (or drop or paste them into the message)" title="Attach files (or drop or paste them into the message)"><span aria-hidden="true">📎</span></button>
        </div>
        <div class="v6-chat-composer-actions">
          <input type="file" id="v6ChatFileInput" class="v6-chat-file-input" multiple hidden>
          <button type="button" id="v6ChatForceSend" class="btn btn-secondary v6-chat-force-send"${boxDisabled}
            title="Send now, even while a reply or another send is in flight (Ctrl/Cmd+Shift+Enter)"
            aria-label="Force send: send now, even while a reply or another send is in flight"><span aria-hidden="true">⚡</span> Force</button>
          <button type="submit" id="v6ChatSend" class="btn btn-primary v6-chat-send-btn"${disabled}>Send</button>
        </div>
      </form>`}
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
    /^(⏎|⌃|ctrl\+)/i,
    // #3105: the recap line, its disable hint, the bypass-permissions
    // banner, and a status bar's trailing "| Model | NN% left".
    /^※\s*recap:/i,
    /\(disable recaps in \/config\)\s*$/i,
    /^[⏵⏸]+\s*bypass permissions/i,
    /\|\s*(?:Opus|Sonnet|Haiku|Claude|GPT|Gemini)\b[^|]*\|\s*\d+%\s*left\s*$/i,
    // #3167: a collapsed background-task footer, naming how many more lines
    // are hidden — chrome about the TUI's own display, not the reply.
    /^↓\s*\d+\s+more\b/i,
    // #3181: Antigravity's queued-message hint, its new-task/clear-to-save
    // hint, and an interactive confirmation menu's own navigation line —
    // chrome about the TUI, never the reply.
    /^Press up to edit queued messages\b/i,
    /\bnew task\?\s*\/clear to save\b/i,
    /↑\/↓\s*Navigate\b/i,
    // #3199: a queued-prompt preview row in the TUI footer (what the
    // operator just typed while the engine is still busy, shown back at
    // them so they know it is queued) starts with the same `▸` glyph as
    // Codex's/Antigravity's own "Thought for …" recap (`LIVE_ENGINE_NOISE`
    // above) — excluded here so that one line keeps reading as chrome
    // through its own per-engine rule, while every OTHER `▸`-prefixed line
    // (the queued-prompt preview itself) is dropped before it can be
    // mistaken for an assistant reply. The "send immediately" footer hint
    // that accompanies it is dropped the same way.
    /^▸\s+(?!Thought\b)/,
    /\(alt\+m to send immediately\)/i
  ]);

  /**
   * Lines that start a tool block: what is indented under them is the
   * tool's output. #3191: dropped the trailing `\s*…?$` anchor — Antigravity's
   * own collapsed-actions line names what it collapsed afterward ("… 2 more
   * actions (1 read, 1 command) …"), which the anchor never matched, so it
   * leaked into the reply as ordinary prose instead of being read as chrome.
   */
  const LIVE_TOOL = Object.freeze([/^…\s*\d+\s+more actions?\b/i, /^[⎿└]/]);

  /** Per-engine thinking/tool lines; an unknown engine gets all of them. */
  const LIVE_ENGINE_NOISE = Object.freeze({
    // A tool call (`⏺ Bash(…)`) or a tool status line (`⏺ Ran npm test`):
    // a status verb and no closing punctuation, which keeps a reply sentence
    // that merely starts with one of those verbs.
    claude: [/^⏺\s+[A-Za-z][\w.-]*\(/, /^⏺\s+(Ran|Explored|Edited|Read|Searched|Wrote|Updated|Listed|Called|Fetched|Created|Deleted|Added)\b.*[^.!?:]$/, /^[✶✻✽✢]/],
    codex: [/^•\s+(Ran|Explored|Edited|Read|Searched|Updated|Added|Deleted|Called|Running|Listed)\b/, /^▸\s*Thought\b/],
    // #3191: "▸ Thought for 11s, 144 tokens" — Antigravity's own thinking
    // recap, the same shape Codex's already listed above.
    antigravity: [/^[○●]/, /^▸\s*Thought\b/],
    aider: [/^Tokens:/, /^Applied edit to /, /^Commit [0-9a-f]{7,}\b/, /^(Repo-map|Main model|Weak model|Git repo|Aider v)\b/, /^Added .+ to the chat\b/]
  });

  /**
   * A tail line meaning the engine is busy right now, across all 4 engines
   * (#3167): a spinner glyph, the interrupt/cancel hint (Claude Code's own
   * "esc to interrupt", Antigravity's "esc to cancel" — in standalone-line
   * or trailing-parenthesis form, same as `LIVE_NOISE` recognizes them, so
   * this is checked, and returns, before `LIVE_NOISE` ever sees the line —
   * see the per-line loop below), a Codex-style "● [HH:MM:SS] ... running"
   * status line, or a bare "Running…"/"Thinking…" status word on its own
   * line. Anchored to the WHOLE line for the bare status words: a reply
   * that merely contains "thinking" or "running" in a sentence is not
   * enough — a reply can say them.
   */
  const LIVE_BUSY = /^esc to (cancel|interrupt)\b|\(esc to (cancel|interrupt)\)\s*$|^[\u2736\u273B\u273D\u2722]|^[\u2800-\u28FF]|^\u25CF\s*\[\d{1,2}:\d{2}:\d{2}\].*\brunning\b|^(Running|Thinking)\u2026?\s*$/i;

  /**
   * #3181: a Claude Code completed-turn timing recap (`\u273B Baked for 2m 23s
   * \u00B7 done 12:57 AM`, `\u273B Churned for 14s \u00B7 done 12:58 AM`) matches
   * `LIVE_BUSY`'s own leading-glyph test above right above the bare `\u276F`
   * prompt, and \u2014 unlike a genuinely busy spinner line \u2014 never gets
   * superseded by a later line that clears it, so it stuck as
   * `live.activity` forever after the turn actually ended. Checked, and
   * returned on, before `LIVE_BUSY` ever sees the line.
   */
  const LIVE_DONE_RE = /^(?:[\u2736\u273B\u273D\u2722]\s+)?\S+\s+for\s+\d+[hms0-9\s]*(?:\u00B7\s*done\b|$)|\b\u00B7\s*done\s+\d{1,2}:\d{2}/i;

  /**
   * #3181: a footer that means the engine is at rest, not working \u2014 the
   * Claude Code / Codex idle markers already named elsewhere, Antigravity's
   * "Press up to edit queued messages" and its "new task?/clear to save"
   * hint, an interactive menu's own `\u2191/\u2193 Navigate` line, and a status bar's
   * trailing "| Model | NN% left". A background `/tasks` daemon tray row
   * (`\u25CF [HH:MM:SS] ... running`) rendered just above one of these never
   * gets the chance to clear `activity` on its own, since nothing after it
   * says the session went idle \u2014 this line does that instead.
   */
  const LIVE_AT_REST_FOOTER_RE = /\?\s*for shortcuts\b|^Press up to edit queued messages\b|\bnew task\?\s*\/clear to save\b|\u2191\/\u2193\s*Navigate\b|\|\s*(?:Opus|Sonnet|Haiku|Claude|GPT|Gemini)\b[^|]*\|\s*\d+%\s*left\s*$/i;

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
   * Whether a line is the operator's own words echoed or quoted back
   * (#3131), never an open question: a markdown blockquote (`> \u2026`), or
   * text that matches \u2014 whole, or as a fragment either direction \u2014 a
   * message the operator themself already sent.
   * @param {string} line
   * @param {Set<string>} knownLines - Exact lines of recorded operator messages.
   * @param {string[]} sentTexts - Recorded operator messages, squashed to one line each.
   * @returns {boolean}
   */
  function isOperatorEcho(line, knownLines, sentTexts) {
    const trimmed = String(line).trim();
    if (!trimmed) return false;
    if (/^>/.test(trimmed)) return true;
    const squashed = trimmed.replace(/\s+/g, ' ').trim();
    if (knownLines.has(trimmed)) return true;
    const texts = Array.isArray(sentTexts) ? sentTexts : [];
    if (squashed.length >= 8 && texts.some((m) => m === squashed || m.startsWith(squashed) || squashed.startsWith(m))) return true;
    // #3131 (PRR-B R1 blocking 3b): a long operator message can wrap across
    // several pane lines, so the assistant's own echo of it can be a
    // MIDDLE or TRAILING fragment, never a prefix of either side.
    return squashed.length >= 12 && texts.some((m) => m.length >= 12 && (m.includes(squashed) || squashed.includes(m)));
  }

  /**
   * The target a pane's `tc message send [--priority <p>] [--in-reply-to
   * <id>] <to> "\u2026"` line names (#3131): its first non-flag argument, the
   * way `tc`'s own flags are declared \u2014 so a Fleet Member drill-down can
   * group outbound Medusa traffic by who it actually went to, from the
   * pane alone, no model call.
   * @param {string} line
   * @returns {string|null}
   */
  function medusaSendTarget(line) {
    const m = /\btc\s+message\s+send\b(.*)$/.exec(String(line));
    if (!m) return null;
    const FLAGS_WITH_VALUE = new Set(['--priority', '--in-reply-to']);
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (FLAGS_WITH_VALUE.has(tok)) { i++; continue; }
      if (tok.startsWith('--')) continue;
      return tok.replace(/^['"]|['"]$/g, '') || null;
    }
    return null;
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
    // #3131 (PRR-B R1 blocking 3a): a prompt the pane shows live but that
    // was never recorded as a B2 event (typed straight into the terminal,
    // not through this chat) is still the operator's own words — filled in
    // as each one is seen below, so a LATER line in this SAME read that
    // echoes an EARLIER, unrecorded one is still caught, not just a
    // recorded message's own echo. Kept apart from `knownLines`/`sent`
    // above, which `recordedAs` also reads to decide what to mark
    // `recorded: true` — that decision must stay about the real record.
    const liveKnownLines = new Set();
    const liveSent = [];
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
    // Where the reply's own TRAILING paragraph starts within `reply`
    // (#3131): a blank line mid-reply marks the next paragraph's start,
    // without going INTO `reply` itself — `reply.join('\n')` still joins
    // every paragraph with one plain newline, same as always, so a turn's
    // own stored text is unaffected; only {@link lastReplyTrailingBlock}
    // (read once this reply flushes) narrows to the last one.
    let replyBlockStart = 0;
    // The most recently flushed assistant turn's own trailing paragraph
    // alone (#3131) — reassigned at every flush, so once the loop ends it
    // holds the LAST turn's, which is what an open-question scan actually
    // wants: an earlier turn (before a wake) is still read in full, since
    // #3082 needs that question to keep waiting, but the current reply's
    // own earlier, superseded prose never is.
    let lastReplyTrailingBlock = '';
    let activity = null;
    const switchboard = [];
    // Whether the operator has spoken since the newest reply (#3079): their
    // answer clears the questions, recorded or not.
    let answered = false;
    // An indented line belongs to whatever started the block above it: a tool
    // line's output is noise, an assistant line's continuation is reply.
    let block = null;
    // #3181: whether an interactive confirmation menu (`↑/↓ Navigate`) is on
    // screen — while it is, the status bar's own `esc to cancel` cancels the
    // MENU, not a turn in flight, so it must not read as busy. Reset on a
    // new prompt or reply line, same as `activity`.
    let menuActive = false;
    // Whether a wake, not the operator, set the session going (#3082): its
    // replies until the operator next speaks are switchboard-triggered.
    let woken = false;
    // #3199: the turn `block === 'prompt'` is currently tracking continuation
    // lines for — the just-pushed `{role: 'user', ...}` object itself, so a
    // multi-line or terminal-soft-wrapped prompt's later lines append to the
    // SAME turn's text instead of falling through to `block = 'reply'` and
    // being misread as the assistant's own words. `null` once nothing is
    // being continued (every other marker below that returns while
    // `block === 'prompt'` is still true leaves this stale but harmless,
    // since nothing reads it unless `block === 'prompt'` too).
    let promptTurn = null;
    const flush = () => {
      if (reply.length) {
        lastReplyTrailingBlock = reply.slice(replyBlockStart).join('\n');
        turns.push(woken ? { role: 'assistant', text: reply.join('\n'), trigger: 'switchboard' } : { role: 'assistant', text: reply.join('\n') });
        answered = false;
      }
      reply = [];
      replyBlockStart = 0;
      replyLineLen = 0;
      inFence = false;
    };
    // #3167: a reply line soft-wrapped by the terminal's own column width
    // (not a genuine newline in the engine's own text) is unwrapped into the
    // same flowing line as what it continues — joined with a single space —
    // instead of staying a forced `\n` break that clips #v6ChatStream's
    // prose to the terminal's column width rather than the browser pane's.
    // There is no marker in captured tmux text saying "this line only ended
    // because the pane ran out of columns"; the signal used instead is the
    // PREVIOUS line's own length — only a line at least `WRAP_WIDTH_THRESHOLD`
    // long could plausibly have been cut off (a real 4-line wrapped question,
    // Ruling A864: its first line, bulleted, already runs 60-66 chars once
    // the bullet itself is stripped, well under the #3167 tmux geometry's 200
    // columns — an engine's own markdown/word-wrap rarely fills the pane to
    // the literal column edge), so a short line is never merged into. A blank
    // line, a heading, a list item, or a fenced code block's own lines are
    // never merged — true paragraph breaks, list items and code must survive
    // exactly as the engine wrote them, verbatim inside a fence.
    const WRAP_WIDTH_THRESHOLD = 55;
    const NEW_REPLY_BLOCK = /^#{1,6}\s/;
    const FENCE_DELIM = /^(?:```|~~~)/;
    let replyLineLen = 0;
    let inFence = false;
    // `hasBullet` (Ruling A864): the bullet-stripping call site below strips
    // `⏺ `/`• ` from `txt` BEFORE this runs, so `QUESTION_PREFIX` alone can no
    // longer see it there — passed in so a bulleted line still starts its own
    // block (never gets merged into whatever reply content came before it)
    // even though the text it is classifying on has already lost the bullet.
    const appendReplyLine = (txt, hasBullet = false) => {
      const isFenceDelim = FENCE_DELIM.test(txt);
      const startsNewBlock = !inFence && (hasBullet || isFenceDelim || NEW_REPLY_BLOCK.test(txt) || QUESTION_PREFIX.test(txt));
      const mergeIntoLast = !inFence && !startsNewBlock && reply.length > 0 && replyLineLen >= WRAP_WIDTH_THRESHOLD;
      if (mergeIntoLast) reply[reply.length - 1] += ` ${txt}`;
      else reply.push(txt);
      replyLineLen = txt.length;
      if (isFenceDelim) inFence = !inFence;
    };
    (Array.isArray(lines) ? lines : []).forEach((raw) => {
      if (typeof raw !== 'string') return;
      // eslint-disable-next-line no-control-regex
      const line = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+$/, '');
      const text = line.trim();
      // A blank line decides nothing: tool output can hold blank lines, and
      // the next line's indent says whether it is still output (#3057).
      if (!text) {
        // A blank line ends a wrapped notice, and marks a paragraph break
        // within an ongoing reply (#3131) — never reached from inside tool
        // output, which is dropped before this point regardless.
        if (block === 'wake') block = null;
        if (block === 'reply') { replyBlockStart = reply.length; replyLineLen = 0; }
        // #3199: a blank line ends a multi-line prompt's continuation too —
        // genuine multi-PARAGRAPH operator echoes are still caught by the
        // `echo`/`isOperatorEcho` machinery below, which neither reads nor
        // sets `block`.
        if (block === 'prompt') block = null;
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
          menuActive = false;
          answered = true;
          woken = false;
          echo = recordedAs(said);
          echoCut = Boolean(echo) && /\[Full prompt \(\d+ chars\) saved to: /.test(original(echo));
          // #3079 item 6: a recorded prompt keeps its place among the
          // replies, marked so the recorded copy is not drawn again.
          const turn = echo ? { role: 'user', text: original(echo), recorded: true } : { role: 'user', text: said };
          turns.push(turn);
          // #3199 (R-Gate R1 BLOCKING 1): a RECORDED prompt's own
          // continuation is already handled, correctly, by the `echo &&
          // (...)` check immediately below this block (unchanged by this
          // car) — matched against the actual recorded text, never
          // swallowing unrelated prose. `block = 'prompt'` tracking below
          // is for the UNRECORDED case only: a plain assistant reply line
          // is ordinary across every engine, so there is no way to tell
          // "the terminal is still echoing a typed prompt it hasn't
          // recorded yet" apart from "the assistant has started replying"
          // by content alone. A SHORT prompt could not have been cut off
          // by the terminal's own column width in the first place — same
          // signal `appendReplyLine`'s `WRAP_WIDTH_THRESHOLD` already uses
          // for the identical problem on the REPLY side (#3167) — so only
          // a prompt at least this long, and still unrecorded, enables
          // continuation tracking at all; later lines keep appending to
          // THIS turn until something that is not a continuation is seen
          // — see the `block === 'prompt'` check further down, which ALSO
          // requires the line to be indented (never plain unindented
          // prose, bulleted or not), so a long prompt followed directly by
          // ordinary unbulleted assistant text always starts its own
          // `assistant` turn instead of being merged into the user's.
          if (!echo && said.length >= WRAP_WIDTH_THRESHOLD) {
            block = 'prompt';
            promptTurn = turn;
          }
          // #3131 (PRR-B R1 blocking 3a): an unrecorded prompt is still the
          // operator's own words, from here on in this same read.
          if (!echo) {
            const squashedSaid = squash(said);
            if (squashedSaid) {
              liveSent.push(squashedSaid);
              said.split('\n').forEach((l) => { const t = l.trim(); if (t) liveKnownLines.add(t); });
            }
          }
        }
        return;
      }
      // The rest of a recorded message the pane is still echoing.
      // A prompt recorded only in part goes on, indented, past what the
      // record holds; those lines are still the prompt, not a reply.
      if (echo && (knownLines.has(text) || echo.includes(squash(text)) || LONG_PROMPT_NOTE.test(text) || (echoCut && indented))) return;
      echo = null;
      // #3181: a completed-turn timing recap ("✻ Baked for 2m 23s · done
      // 12:57 AM") matches LIVE_BUSY's own leading-glyph test below — check
      // and return on it first so it clears any prior spinner activity
      // instead of sticking as busy forever after the turn actually ended.
      if (LIVE_DONE_RE.test(text) || /^[✶✻✽✢]\s+Thought for\b/i.test(text)) {
        activity = null;
        block = null;
        return;
      }
      // #3181: an interactive confirmation menu is on screen — its own
      // `esc to cancel` (handled below) cancels the MENU, not a turn.
      if (/↑\/↓\s*Navigate\b/i.test(text)) {
        menuActive = true;
        activity = null;
        block = null;
        return;
      }
      // #3181: an at-rest footer (idle markers, the queued-message hint)
      // means the session went idle since whatever last set `activity` —
      // a background `/tasks` daemon tray row rendered just above one of
      // these never gets another chance to clear it on its own.
      if (LIVE_AT_REST_FOOTER_RE.test(text)) activity = null;
      if (LIVE_BUSY.test(text) && !/Thought for/i.test(text)) {
        if (/^esc to (cancel|interrupt)\b/i.test(text)) {
          // #3181: a menu's own cancel hint never reads as busy; otherwise
          // never strip "esc to cancel" to read its own right-hand
          // model/task chrome ("auto · Gemini 4 Argon · medium · 4
          // task(s) · /tasks") as the activity label — keep whatever
          // genuine spinner label was already set, or fall back to a
          // generic one.
          if (menuActive) { activity = null; return; }
          activity = activity || 'Working…';
          return;
        }
        activity = text.replace(/^[✶✻✽✢⠀-⣿\s]+/, '')
          .replace(/\s*\(?esc to (cancel|interrupt)\)?/i, '')
          .replace(/^●\s*\[\d{1,2}:\d{2}:\d{2}\]\s*/, '').replace(/\s*running\s*$/i, '')
          .trim() || 'Working…';
        return;
      }
      // Under a tool line, only its output marker or a deeper indent is
      // output; Antigravity indents its reply prose by two spaces (#3057).
      if (indented && block === 'tool' && (/^[⎿└]/.test(text) || /^\s{4,}/.test(line))) return;
      if (tools.some((re) => re.test(text))) {
        if (MEDUSA_SEND.test(text)) switchboard.push({ dir: 'out', text, to: medusaSendTarget(text) });
        block = 'tool';
        return;
      }
      // Chrome and boilerplate are dropped, but do not swallow what follows.
      if (LIVE_NOISE.some((re) => re.test(text))) {
        if (MEDUSA_SEND.test(text)) switchboard.push({ dir: 'out', text, to: medusaSendTarget(text) });
        block = null;
        return;
      }
      if (indented && block === 'reply') {
        appendReplyLine(text);
        return;
      }
      // #3199 (R-Gate R1 BLOCKING 1): a line that reached here while still
      // tracking an UNRECORDED prompt's continuation (`promptTurn` is only
      // ever set for the unrecorded case — see where `block = 'prompt'` is
      // set above) matched none of the markers above, but plain unindented
      // prose is ordinary for an assistant's OWN reply across every engine
      // (Claude, Codex, Antigravity, Aider all reply in plain text most of
      // the time — only tool calls and thinking recaps use a leading
      // glyph), so bullet-presence alone cannot tell "the terminal is
      // still echoing what was typed" apart from "the assistant has
      // started replying." `indented` is the one signal this parser
      // already trusts elsewhere for "this line belongs to whatever
      // started the block above it" (the tool-output and reply-contination
      // checks above both gate on it) — reused here: only an INDENTED line
      // extends the prompt; a plain, column-0 line — bulleted or not —
      // never does, and falls through to start its own `assistant` turn
      // instead of ever being merged into the user's. #3057/R-Gate R2
      // BLOCKING 1: NEVER on Antigravity, whose own normal reply prose is
      // ITSELF indented by two spaces (the one engine this signal cannot
      // tell apart from a genuine continuation) — excluded outright rather
      // than risked.
      if (block === 'prompt' && promptTurn && indented && engine !== 'antigravity') {
        promptTurn.text += `\n${text}`;
        const squashedLine = squash(text);
        if (squashedLine) {
          liveSent.push(squashedLine);
          liveKnownLines.add(text.trim());
        }
        return;
      }
      block = 'reply';
      activity = null;
      menuActive = false;
      appendReplyLine(text.replace(LIVE_BULLET, ''), LIVE_BULLET.test(text));
    });
    flush();
    const last = turns[turns.length - 1];
    // Everything the session has said since the operator last spoke: a wake
    // can split it into several turns, and a question asked before the wake
    // is still waiting (#3082).
    let since = turns.length;
    while (since > 0 && turns[since - 1].role === 'assistant') since--;
    // #3131: every turn since the operator last spoke is still read in
    // full (#3082: a question asked before a wake keeps waiting through
    // it) EXCEPT the current/last one, which contributes only its own
    // trailing paragraph — so a rhetorical '?' in an earlier paragraph of
    // the SAME reply, now superseded by the one that follows it, is never
    // misread as still open.
    const openPrior = last && last.role === 'assistant' && !answered ? turns.slice(since, -1).map((t) => t.text) : [];
    const trailingBlock = last && last.role === 'assistant' && !answered ? lastReplyTrailingBlock.split('\n') : [];
    const tail = last && last.role === 'assistant' && !answered ? last.text.split('\n').pop() : '';
    // Any line that is the operator's own words, echoed or quoted back
    // (#3131), is never read as the assistant asking a question — recorded
    // or not (#3131 PRR-B R1 blocking 3a: `liveKnownLines`/`liveSent` are
    // filled in by now, every unrecorded prompt this same read has shown).
    const allKnownLines = new Set([...knownLines, ...liveKnownLines]);
    const allSent = sent.concat(liveSent);
    const questions = openPrior.flatMap((t) => t.split('\n')).concat(trailingBlock)
      .filter((l) => !isOperatorEcho(l, allKnownLines, allSent))
      .map((l) => l.trim().replace(QUESTION_PREFIX, '').trim())
      .filter(asksQuestion);
    const question = !isOperatorEcho(tail, allKnownLines, allSent) && asksQuestion(tail) ? tail : null;
    return { turns, question, questions, activity, switchboard };
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
   * `github.com/<owner>/<repo>/(pull|issues|releases/tag)/<id>` (#3107). A
   * client-side copy of `lib/v6/b2-conversation-layer.js#GITHUB_ENTITY_URL` —
   * pure regex, no `node:net`/`node:path`, so it has no server dependency to
   * share; kept byte-identical so a URL this page recognizes and the server's
   * own classifier agree.
   */
  const GITHUB_ENTITY_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})\/(pull|issues|releases\/tag)\/([^/?#\s]+)/i;

  /**
   * Parse a GitHub PR, Issue, or Release URL (#3107) — a client-side copy of
   * `lib/v6/b2-conversation-layer.js#parseGitHubEntityUrl`, kept in sync with
   * it deliberately (see {@link GITHUB_ENTITY_URL}'s own note).
   * @param {string} url
   * @returns {({owner: string, repo: string, entityKind: 'pull', number: number}|
   *   {owner: string, repo: string, entityKind: 'issue', number: number}|
   *   {owner: string, repo: string, entityKind: 'release', tag: string}|null)}
   */
  function parseGithubEntityUrl(url) {
    if (typeof url !== 'string') return null;
    const m = GITHUB_ENTITY_URL.exec(url.trim());
    if (!m) return null;
    const [, owner, repo, kindRaw, idRaw] = m;
    const kind = kindRaw.toLowerCase();
    if (kind === 'pull' || kind === 'issues') {
      const number = Number(idRaw);
      if (!Number.isInteger(number) || number < 1) return null;
      return { owner, repo, entityKind: kind === 'pull' ? 'pull' : 'issue', number };
    }
    try {
      return { owner, repo, entityKind: 'release', tag: decodeURIComponent(idRaw) };
    } catch {
      return null;
    }
  }

  /**
   * One GitHub card (#3107): a PR/Issue number, or a Release tag — no fetch,
   * built straight from the URL (the live title/state the real GET
   * /api/v6/unfurl route could also return for this case is a documented
   * scope reduction for this car, not yet wired here).
   * @param {string} href
   * @param {{owner: string, repo: string, entityKind: string, number?: number, tag?: string}} gh
   * @returns {string} HTML.
   */
  function githubCardMarkup(href, gh) {
    const safe = escapeHtml(href);
    const label = gh.entityKind === 'release' ? `Release ${gh.tag}` : `#${gh.number}`;
    const icon = gh.entityKind === 'pull' ? '🔀' : gh.entityKind === 'issue' ? '🐛' : '🏷';
    return `<a class="v6-chat-link-preview v6-chat-github-card" href="${safe}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="Opens in a new tab">`
      + `<span class="v6-chat-link-preview-icon" aria-hidden="true">${icon}</span>`
      + `<span class="v6-chat-github-repo">${escapeHtml(gh.owner)}/${escapeHtml(gh.repo)}</span>`
      + `<span class="v6-chat-github-label">${escapeHtml(label)}</span></a>`;
  }

  /**
   * One external link's unfurl state (#3107): never fetched until the
   * viewer clicks "Preview" (Ruling A752 — an external host is never
   * dereferenced just because the chat drew the message). `unfurls` is
   * `detail.view.chat.unfurls`, read fresh on every redraw so a click's
   * result (set via the shell's `setUnfurl`) shows without a full re-render.
   * @param {string} href
   * @param {Object<string, {state: ('loading'|'done'|'error'), preview?: object}>} [unfurls]
   * @returns {string} HTML: a "👁 Preview" button, a spinner, the fetched
   *   card, or a quiet failure note — one `v6-chat-unfurl` wrapper either way,
   *   so {@link wireUnfurlLinks} can find it after a redraw.
   */
  function unfurlMarkup(href, label, unfurls) {
    const safe = escapeHtml(href);
    const entry = unfurls && Object.prototype.hasOwnProperty.call(unfurls, href) ? unfurls[href] : null;
    const plainLink = `<a class="v6-chat-link" href="${safe}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escapeHtml(label || href)}</a>`;
    if (!entry) {
      return `<span class="v6-chat-unfurl" data-unfurl-url="${safe}">${plainLink} `
        + `<button type="button" class="btn btn-compact v6-chat-unfurl-btn" data-unfurl-url="${safe}">👁 Preview</button></span>`;
    }
    if (entry.state === 'loading') return `<span class="v6-chat-unfurl" data-unfurl-url="${safe}">${plainLink} <span class="v6-chat-unfurl-loading">Loading preview…</span></span>`;
    if (entry.state === 'error' || !entry.preview) return `<span class="v6-chat-unfurl" data-unfurl-url="${safe}">${plainLink} <span class="v6-chat-unfurl-error">Preview unavailable.</span></span>`;
    const p = entry.preview;
    // #3139: a `GET /api/v6/unfurl` fetch the viewer themselves just asked
    // for (a click, or the "Show preview by default" setting below) that
    // resolved to an actual video response — distinct from the plain
    // `p.video` OG flag below, which only NAMES a video elsewhere and stays
    // a labeled link per Ruling A752. Here the video IS the resource at
    // this exact URL, already fetched and SSRF-checked server-side
    // (`lib/v6/b2-conversation-layer.js#safeUnfurlFetch`), so playing it
    // inline asks the browser for nothing this viewer didn't already ask
    // the server to confirm.
    if (p.kind === 'video') {
      const src = escapeHtml(p.finalUrl || p.url || href);
      return `<span class="v6-chat-unfurl v6-chat-unfurl-video" data-unfurl-url="${safe}">`
        + `<video class="v6-chat-video-preview" controls preload="metadata" src="${src}">${plainLink}</video></span>`;
    }
    const title = p.title ? escapeHtml(p.title) : safe;
    const desc = p.description ? `<span class="v6-chat-unfurl-desc">${escapeHtml(p.description)}</span>` : '';
    // og:image/og:video name an EXTERNAL host's media (Ruling A752) — shown
    // as a labeled link, same as the existing external-image chip above,
    // never an auto-fetched <img>/<video> even after the viewer already
    // opted into fetching THIS page's metadata.
    const media = p.image ? `<span class="v6-chat-unfurl-media-note"><span aria-hidden="true">🖼</span> image available at source</span>`
      : p.video ? `<span class="v6-chat-unfurl-media-note"><span aria-hidden="true">🎬</span> video available at source</span>` : '';
    return `<a class="v6-chat-link-preview v6-chat-unfurl-card" data-unfurl-url="${safe}" href="${safe}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="Opens in a new tab">`
      + `<span class="v6-chat-unfurl-title">${title}</span>${desc}${media}</a>`;
  }

  /** Extensions `classifyLocalReference` renders as an image card (#3107) — client copy of `lib/v6/b2-conversation-layer.js#IMAGE_EXTENSIONS`. */
  const LOCAL_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
  /** Extensions rendered as a video card (#3107) — client copy of `lib/v6/b2-conversation-layer.js#VIDEO_MIME_TYPES`'s keys. */
  const LOCAL_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);
  /** Extensions rendered as an artifact card even with no line range (#3107) — client copy of `lib/v6/b2-conversation-layer.js#ARTIFACT_EXTENSIONS`. */
  const LOCAL_ARTIFACT_EXTENSIONS = new Set(['md', 'html']);
  /** A reference rooted at the workspace (#3107) — client copy of `lib/v6/b2-conversation-layer.js#WORKSPACE_PATH`. */
  const LOCAL_WORKSPACE_PATH = /^(?:\.{1,2}\/|\/|~\/)\S+$/;
  /** A `#L<start>` or `#L<start>-L<end>` code line-range suffix (#3107) — client copy of `lib/v6/b2-conversation-layer.js#LINE_RANGE_SUFFIX`. */
  const LOCAL_LINE_RANGE_SUFFIX = /#L(\d+)(?:-L(\d+))?$/;
  /** Hostnames whose links always preview (#3139 PRR-B R1 BLOCKING 3b) — client copy of `lib/v6/b2-conversation-layer.js#UNFURL_ALLOWLISTED_HOSTS`. */
  const UNFURL_ALLOWLISTED_HOSTS = Object.freeze(['ts.net', 'github.io', 'tangleclaw.com']);
  /** Ports treated as this server's own self-published preview surface on localhost (#3139 PRR-B R1 BLOCKING 3b) — client copy of `lib/v6/b2-conversation-layer.js#SELF_PUBLISHED_PREVIEW_PORTS`. */
  const SELF_PUBLISHED_PREVIEW_PORTS = Object.freeze(new Set(['3410', '3425', '3426', '3430', '5080', '8443']));

  /**
   * Whether `hostname` is one of {@link UNFURL_ALLOWLISTED_HOSTS} or a
   * subdomain of one — client copy of `lib/v6/b2-conversation-layer.js#isAllowlistedUnfurlHost`.
   * @param {string} hostname
   * @returns {boolean}
   */
  function isAllowlistedUnfurlHost(hostname) {
    if (typeof hostname !== 'string' || !hostname) return false;
    const h = hostname.toLowerCase().replace(/\.+$/, '');
    return UNFURL_ALLOWLISTED_HOSTS.some((base) => h === base || h.endsWith(`.${base}`));
  }

  /**
   * `http(s)://host[:port]` — just enough to pull the hostname and port
   * back out of an `href`. Regex, not the `URL` global: this file's own
   * {@link parseGithubEntityUrl} already avoids `URL` client-side the same
   * way, and this module's test harness (`vm.runInContext`) sandboxes a
   * context with no `URL` global at all — the real browser has one, but
   * nothing here needs it enough to make that the only way to test this.
   */
  const HREF_HOST_PORT = /^https?:\/\/([^/:?#]+)(?::(\d+))?/i;

  /**
   * Whether a chat link's own host is a self-published surface #3139 always
   * allows & previews — a Tailscale/GitHub Pages/`tangleclaw.com` hostname,
   * or `localhost` itself on one of this server's own preview ports — so it
   * auto-unfurls even while the global "Show preview by default" setting is
   * off (PRR-B R1 BLOCKING 3b). Never widens which links are safe to FETCH
   * at all; that is still `b2.evaluateUnfurlTargetSafety`'s own call,
   * enforced server-side regardless of what this says.
   * @param {string} href
   * @returns {boolean}
   */
  function isAlwaysPreviewLink(href) {
    if (typeof href !== 'string') return false;
    const m = HREF_HOST_PORT.exec(href);
    if (!m) return false;
    if (isAllowlistedUnfurlHost(m[1])) return true;
    const host = m[1].toLowerCase();
    return (host === 'localhost' || host === '127.0.0.1') && SELF_PUBLISHED_PREVIEW_PORTS.has(m[2] || '');
  }

  /**
   * Split a trailing `#L<n>-L<n>` code line-range off a reference (#3107) —
   * client copy of `lib/v6/b2-conversation-layer.js#_splitLineRange`.
   * @param {string} ref
   * @returns {{base: string, lineRange: ({start: number, end: number}|null)}}
   */
  function _splitLocalLineRange(ref) {
    const m = LOCAL_LINE_RANGE_SUFFIX.exec(ref);
    if (!m) return { base: ref, lineRange: null };
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : start;
    if (start < 1 || end < start) return { base: ref, lineRange: null };
    return { base: ref.slice(0, m.index), lineRange: { start, end } };
  }

  /**
   * A `file://` URL's filesystem path, or `null` (#3107) — a `new URL`-free
   * client copy of `lib/v6/b2-conversation-layer.js#_fileUrlToPath` (the
   * WHATWG `URL` class is a real browser global, but not one every lift-
   * and-run `vm.createContext` test sandbox in this repo provides, so this
   * file never relies on it anywhere else either). Only the common empty-
   * authority form (`file:///abs/path`) is recognized — a rare `file://
   * host/path` form is read the same way, host discarded, which is a
   * documented simplification, not a parser.
   * @param {string} url
   * @returns {string|null}
   */
  function _fileUrlToLocalPath(url) {
    const m = /^file:\/\/[^/]*(\/.*)$/i.exec(url);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  }

  /**
   * The lowercased extension (no dot) of a path's final segment, or `null`
   * (#3107) — a `path.posix.extname`-free client copy of
   * `lib/v6/b2-conversation-layer.js#_extensionOf` (`path` is a Node builtin,
   * unusable in the browser).
   * @param {string} filePath
   * @returns {string|null}
   */
  function _localExtensionOf(filePath) {
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
  }

  /**
   * Classify a whole line of message text as a LOCAL media/artifact
   * reference (#3107, Rulings A809/A811: a `file://` URL or a workspace-
   * rooted path, optionally with a `#L<n>-L<n>` code line range) — never a
   * secrets-store reference, which {@link ATTACHED_LINE}/{@link attachmentMarkup}
   * already own. A client copy of
   * `lib/v6/b2-conversation-layer.js#classifyMediaOrArtifactLink`'s
   * file-url/workspace branch; the secrets branch is deliberately omitted
   * here since {@link messageMarkup} already tries {@link ATTACHED_LINE} first.
   *
   * Zero byte-fetching: by design (the security boundary PM/Architect ruled
   * on for this car), this never resolves to a URL the browser can load —
   * only a `{kind, path, source, fileExtension, lineRange}` model for
   * {@link localReferenceCardMarkup} to describe, never display the bytes of.
   * @param {string} ref - One whole, already-trimmed line.
   * @returns {({kind: ('image'|'video'), path: string, source: ('file-url'|'workspace'), fileExtension: (string|null), lineRange: null}|
   *   {kind: 'artifact', path: string, source: ('file-url'|'workspace'), fileExtension: (string|null), title: string, lineRange: ({start:number,end:number}|null)}|
   *   null)}
   */
  function classifyLocalReference(ref) {
    if (typeof ref !== 'string') return null;
    const trimmed = ref.trim();
    if (!trimmed) return null;
    const { base, lineRange } = _splitLocalLineRange(trimmed);
    let source;
    let filePath;
    if (/^file:\/\//i.test(base)) {
      filePath = _fileUrlToLocalPath(base);
      if (filePath == null) return null;
      source = 'file-url';
    } else if (LOCAL_WORKSPACE_PATH.test(base)) {
      source = 'workspace';
      filePath = base;
    } else {
      return null;
    }
    const ext = _localExtensionOf(filePath);
    if (ext && LOCAL_IMAGE_EXTENSIONS.has(ext)) {
      if (lineRange) return null;
      return { kind: 'image', path: filePath, source, fileExtension: ext, lineRange: null };
    }
    if (ext && LOCAL_VIDEO_EXTENSIONS.has(ext)) {
      if (lineRange) return null;
      return { kind: 'video', path: filePath, source, fileExtension: ext, lineRange: null };
    }
    if ((ext && LOCAL_ARTIFACT_EXTENSIONS.has(ext)) || lineRange) {
      const title = filePath.slice(filePath.lastIndexOf('/') + 1);
      return { kind: 'artifact', path: filePath, source, fileExtension: ext, title: title || filePath, lineRange };
    }
    return null;
  }

  /**
   * A local media/artifact reference's card (#3107, Rulings A809/A811): a
   * metadata card — title, full path, extension badge, source badge, an
   * optional line-range pill, and a copy-path affordance — never the
   * referenced file's actual bytes. No new local-file-serving HTTP endpoint
   * exists for this, by deliberate security design: an arbitrary workspace
   * path or `file://` URL in chat text is never dereferenced by this page.
   * @param {{kind: string, path: string, source: string, fileExtension: (string|null), title?: string, lineRange: ({start:number,end:number}|null)}} ref
   * @returns {string} HTML.
   */
  function localReferenceCardMarkup(ref) {
    const icon = ref.kind === 'image' ? '🖼' : ref.kind === 'video' ? '🎬' : '📄';
    const title = ref.kind === 'artifact' ? ref.title : (ref.path.slice(ref.path.lastIndexOf('/') + 1) || ref.path);
    const safePath = escapeHtml(ref.path);
    const extBadge = ref.fileExtension ? `<span class="v6-chat-local-ref-ext">.${escapeHtml(ref.fileExtension)}</span>` : '';
    const rangeNote = ref.lineRange
      ? `<span class="v6-chat-local-ref-range">L${ref.lineRange.start}${ref.lineRange.end !== ref.lineRange.start ? `-L${ref.lineRange.end}` : ''}</span>` : '';
    const sourceLabel = ref.source === 'file-url' ? 'file://' : 'workspace';
    return `<span class="v6-chat-local-ref" data-copy-path="${safePath}">`
      + `<span class="v6-chat-local-ref-icon" aria-hidden="true">${icon}</span>`
      + `<span class="v6-chat-local-ref-title">${escapeHtml(title)}</span>${extBadge}${rangeNote}`
      + `<span class="v6-chat-local-ref-source">${sourceLabel}</span>`
      + `<span class="v6-chat-local-ref-path" title="${safePath}">${safePath}</span>`
      + `<button type="button" class="btn btn-compact v6-chat-local-ref-copy" data-copy-path="${safePath}" aria-label="Copy path">📋 Copy path</button></span>`;
  }

  /**
   * Message text as HTML (#3082): every character escaped, with links opening
   * in a new tab (`rel="noopener noreferrer"`). An external URL naming an
   * image is a link card — its host and path, escaped — and never an `<img>`:
   * agent text is untrusted, and an image would be fetched the moment the chat
   * drew it, carrying whatever the URL holds to that host (Ruling A752).
   * @param {*} text
   * @param {Object<string, string>} [thumbs] - Attached image name → `blob:` URL, from the thumbnail cache.
   * @param {Object<string, object>} [unfurls] - Unfurl state by URL (#3107); see {@link unfurlMarkup}.
   * @returns {string} HTML.
   */
  function messageMarkup(text, thumbs, unfurls) {
    return String(text == null ? '' : text).split('\n').map((line) => {
      const attached = ATTACHED_LINE.exec(line);
      if (attached) return attachmentMarkup(attached[1], thumbs);
      // #3107: a whole line that is itself a file:// URL or workspace path
      // (Attached:-prefixed secrets lines are already handled above) — the
      // same "whole line is the reference" convention ATTACHED_LINE uses.
      const localRef = classifyLocalReference(line);
      if (localRef) return localReferenceCardMarkup(localRef);
      return lineMarkup(line, unfurls);
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
   * @param {Object<string, object>} [unfurls] - Unfurl state by URL (#3107).
   * @returns {string} HTML.
   */
  function lineMarkup(raw, unfurls) {
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
      out += linkMarkup(href, label, unfurls);
      last = m.index + match.length;
      MESSAGE_LINK.lastIndex = last;
    }
    return out + escapeHtml(raw.slice(last));
  }

  /**
   * One link (#3082): a new-tab anchor, an external-image link card, a
   * GitHub PR/Issue/Release card (#3107), or — for any other external link —
   * a click-to-reveal Open Graph preview (#3107, {@link unfurlMarkup}).
   * @param {string} href - An `http(s)://` URL or a same-origin path, unescaped.
   * @param {string} [label] - A Markdown label.
   * @param {Object<string, object>} [unfurls] - Unfurl state by URL (#3107).
   * @returns {string} HTML.
   */
  function linkMarkup(href, label, unfurls) {
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
    if (external) {
      const gh = parseGithubEntityUrl(href);
      if (gh) return githubCardMarkup(href, gh);
      return unfurlMarkup(href, label, unfurls);
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
   * @param {Object<string, object>} [unfurls] - Unfurl state by URL (#3107).
   * @returns {string} The recorded events as conversation bubbles.
   */
  function recordedEventsMarkup(events, name, thumbs, unfurls) {
    return events.map((e) => (
      `<li class="v6-conversation-event is-${escapeHtml(e && e.role)}">
            ${chatRoleMarkup(e && e.role, name)}
            <span class="v6-conversation-content">${messageMarkup(e && e.content, thumbs, unfurls)}</span>
          </li>`
    )).join('');
  }

  /**
   * The message being sent, at the bottom of the chat until it settles
   * (#3079 item 6), unless the chat already shows it as recorded.
   * @param {{id: *, text: string}|null|undefined} pending
   * @param {{id: *}|null|undefined} lastSent
   * @param {Object<string, string>} [thumbs] - Attached image name → `blob:` URL.
   * @param {Object<string, object>} [unfurls] - Unfurl state by URL (#3107).
   * @returns {string} HTML list item, or ''.
   */
  function pendingMarkup(pending, lastSent, thumbs, unfurls) {
    // One bubble per send on its way (#3082: a forced send can overlap another).
    const list = (Array.isArray(pending) ? pending : [pending])
      .filter((p) => p && typeof p.text === 'string' && !(lastSent && lastSent.id === p.id));
    return list.map((p) => `<li class="v6-conversation-event is-user is-pending">${chatRoleMarkup('user', '')}<span class="v6-conversation-content">${messageMarkup(p.text, thumbs, unfurls)}</span><span class="v6-chat-pending-note"> Sending…</span></li>`).join('');
  }

  /**
   * The live replies (#3052) as conversation bubbles, marked `is-live` because
   * they come from the pane, not the record.
   * @param {Array<{role: string, text: string}>} turns
   * @param {string} name
   * @param {{blockers: boolean, milestones: boolean, chatter: boolean}} [verbosity] - Which switchboard replies show (#3082).
   * @param {Object<string, string>} [thumbs] - Attached image name → `blob:` URL.
   * @param {Object<string, object>} [unfurls] - Unfurl state by URL (#3107).
   * @returns {string} HTML list items.
   */
  function liveTurnsMarkup(turns, name, verbosity, thumbs, unfurls) {
    return (Array.isArray(turns) ? turns : []).filter((t) => shownInChat(t, verbosity)).map((t) => (
      `<li class="v6-conversation-event is-${escapeHtml(t && t.role)} is-live">${chatRoleMarkup(t && t.role, name)}<span class="v6-conversation-content">${messageMarkup(t && t.text, thumbs, unfurls)}</span></li>`
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
   * @param {Object<string, object>} [unfurls] - Unfurl state by URL (#3107).
   * @returns {string} HTML list items, or the empty note.
   */
  function tuckedMarkup(tucked, thumbs, unfurls) {
    if (!tucked.length) return '<li class="v6-chat-tucked-empty">Nothing tucked away.</li>';
    return tucked.map((t) => `<li class="v6-chat-tucked-item is-${turnKind(t)}"><span class="v6-chat-tucked-kind">${TURN_KIND_LABELS[turnKind(t)]}</span> <span class="v6-conversation-content">${messageMarkup(t.text, thumbs, unfurls)}</span></li>`).join('');
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
  function verbosityMarkup(verbosity, hideHoodTraffic) {
    const v = isVerbosity(verbosity) ? verbosity : VERBOSITY_DEFAULT;
    // #3191: checked by default — anything other than an explicit `false`
    // (never seen, never saved) keeps the drawer's Medusa/fleet chatter
    // tucked away until the operator opts in.
    const hideTraffic = hideHoodTraffic !== false;
    const box = (id, key, label) => `<label class="v6-chat-verbosity-option"><input type="checkbox" id="${id}" data-verbosity="${key}"${v[key] ? ' checked' : ''}> ${label}</label>`;
    return `<fieldset class="v6-chat-verbosity">
          <legend>Switchboard replies shown in the chat</legend>
          <span class="v6-chat-verbosity-fixed">Direct chat &amp; questions: always</span>
          ${box('v6ChatShowBlockers', 'blockers', 'Blockers')}
          ${box('v6ChatShowMilestones', 'milestones', 'Milestones')}
          ${box('v6ChatShowChatter', 'chatter', 'Fleet chatter')}
          <label class="v6-chat-verbosity-option v6-chat-verbosity-option--traffic"><input type="checkbox" id="v6ChatHideHoodTraffic"${hideTraffic ? ' checked' : ''}> Hide Medusa &amp; fleet chatter</label>
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
   * The latest reply's own text (#3105): every assistant turn after the
   * operator's last message, joined — a reply can be split across several
   * turns when a wake lands mid-reply.
   * @param {{turns?: Array<{role: string, text: string}>}|null} live
   * @returns {string}
   */
  function latestReplyText(live) {
    const turns = live && Array.isArray(live.turns) ? live.turns : [];
    let i = turns.length - 1;
    while (i >= 0 && !(turns[i] && turns[i].role === 'user')) i--;
    return turns.slice(i + 1).filter((t) => t && t.role === 'assistant').map((t) => String(t.text || '')).join('\n');
  }

  /** A CLI folder-trust prompt (#3105). */
  const CLI_GATE_TRUST = /trust the files in this folder|trust this folder|trust this directory/i;
  /** A CLI tool/bash permission prompt (#3105). */
  const CLI_GATE_PERMISSION = /Do you want to (?:proceed|make this edit|run this command|allow)|Allow (?:once|always|this)|Run command\?|Apply changes\?|\((?:y\/n|Y\/n|y\/N|yes\/no)\)\s*$/i;
  /** A numbered CLI selector menu, its first option (#3105). */
  const CLI_GATE_SELECTOR = /[❯›>●]\s*1\.\s+(?:Yes|Allow|Proceed)/;

  /**
   * A CLI-level gate waiting on the operator (#3105): folder-trust, a
   * tool/bash permission prompt, or a numbered CLI selector menu, detected
   * in the pane's most recent raw lines (nearest first).
   * @param {string[]|null} lines - Recent raw pane lines, noise included.
   * @returns {{kind: 'trust'|'permission'|'selector', text: string, options: Array<{key: string, label: string}>}|null}
   */
  function extractCliGates(lines) {
    const list = Array.isArray(lines) ? lines : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const line = String(list[i] || '').trim();
      if (!line) continue;
      if (CLI_GATE_TRUST.test(line)) {
        return { kind: 'trust', text: line, options: [{ key: 'y', label: 'y' }, { key: 'n', label: 'n' }] };
      }
      if (CLI_GATE_PERMISSION.test(line)) {
        return {
          kind: 'permission', text: line,
          options: [{ key: '1', label: '1 / Allow' }, { key: '2', label: '2 / Always Allow' }, { key: '3', label: '3 / No' }]
        };
      }
      if (CLI_GATE_SELECTOR.test(line)) {
        return {
          kind: 'selector', text: line,
          options: [{ key: '1', label: '1 / Allow' }, { key: '2', label: '2 / Always Allow' }, { key: '3', label: '3 / No' }]
        };
      }
    }
    return null;
  }

  /** A numbered choice line: `1. Do X`, `2) Do Y`, `3: Do Z` (#3105). */
  const MULTI_CHOICE_LINE = /^\s*([1-4])[.):]\s+(.+?)\s*$/;

  /**
   * A multiple-choice question in the latest reply (#3105): 1-4 labelled
   * choices in sequence, plus an implicit "5" write-in/other.
   * @param {string} text - {@link latestReplyText}'s result.
   * @returns {{question: string, choices: string[]}|null}
   */
  function extractMultiChoice(text) {
    const lines = String(text || '').split(/\r?\n/);
    const choices = [];
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(MULTI_CHOICE_LINE);
      if (m && Number(m[1]) === choices.length + 1) {
        if (start === -1) start = i;
        choices.push(m[2].trim());
      } else if (start !== -1) {
        break;
      }
    }
    if (choices.length < 2) return null;
    const question = lines.slice(0, start).map((l) => l.trim()).filter(Boolean).pop() || '';
    // #3105 (PRR-A R1 C3): a numbered Your ToDo list reads identically to
    // a multi-choice prompt syntactically — only the preceding header
    // tells them apart, so a ToDo list never also renders as a question.
    if (TODO_HEADER.test(question)) return null;
    // #3167: a declarative numbered list ("• What the code is doing right
    // now: / 1. ... / 2. ...") is syntactically identical to a real
    // multi-choice prompt too — sequential 1-4 numbering alone (already
    // required above) is not enough. The preceding line must actually ASK
    // something, or explicitly invite a choice in words, or this was never
    // a question in the first place.
    if (!asksQuestion(question) && !MULTI_CHOICE_PROMPT.test(question)) return null;
    return { question, choices };
  }

  /** An explicit invitation to pick one of several options (#3167), for a preceding
   *  line that does not itself end in a `?` (`asksQuestion` already covers that case). */
  const MULTI_CHOICE_PROMPT = /\b(choose|select|pick|which option|reply with)\b/i;

  /**
   * Headers that open a "Your ToDo" block (#3105), capturing anything
   * written inline after the colon on the SAME line (`YOUR TURN: 1. Merge
   * #171... 2. Read the testament plan...`) in group 1.
   */
  const TODO_HEADER = /^(?:YOUR TURN|Next steps?|Your ToDo|Action required|Operator action):\s*(.*)$/i;
  /** The two purely structural markers that close a "Your ToDo" block (#3105). */
  const TODO_STOP = /^(?:STATE:|---|※\s*recap:)/i;
  // The closing standing-block marker this repo spells with the word
  // "clear" is checked by EXACT line equality, never a regex/.test()/
  // .match()/.includes() construct (ADR 0020 §8, test/workload-compose.
  // test.js "transcript parsing is banned as a source of clearance"):
  // recognizing one fixed line as this list's own boundary computes no
  // clearance decision and derives nothing from parsing a transcript, but
  // the repo's static scanner bans the phrase+parsing-construct combination
  // outright, so this stays a plain string compare on purpose.
  const TODO_STOP_PREFIX = 'SAFE TO CLEAR:';
  /**
   * One imperative, numbered or bulleted ToDo line (#3105). No trailing-
   * punctuation requirement — PRR-A R1 C3: the issue's own real-world
   * examples end in `#171`, a backtick, `)`, `?`, or nothing at all.
   */
  const TODO_ITEM = /^(?:[-*•]|\d+[.)])\s*(.+)$/;

  /**
   * Split a header's inline continuation into its own numbered items
   * (#3105): `1. Merge #171... 2. Read the plan...` → each segment's text,
   * number stripped. A header with no numbering of its own (`Next step:
   * ask your friend to review`) is kept whole, as the one item it is.
   * @param {string} inline
   * @returns {string[]}
   */
  function splitInlineTodoItems(inline) {
    const text = String(inline || '').trim();
    if (!text) return [];
    if (!/^\d+[.)]\s/.test(text)) return [text];
    return text.split(/(?=\d+[.)]\s)/).map((s) => s.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
  }

  /**
   * The operator's own handoff list in the latest reply (#3105): items
   * under `YOUR TURN:`/`Next step(s):`/`Your ToDo:`/`Action required:`/
   * `Operator action:` (inline continuation on the header line included),
   * stopping before the standing block's own closing markers (`STATE:`,
   * `---`, a recap line, or the one spelled with "clear" above), or a
   * blank line followed by prose that isn't another list item.
   * @param {string} text - {@link latestReplyText}'s result.
   * @returns {string[]}
   */
  function extractOperatorTodo(text) {
    const lines = String(text || '').split(/\r?\n/);
    const items = [];
    let collecting = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const header = line.match(TODO_HEADER);
      if (header) {
        collecting = true;
        items.push(...splitInlineTodoItems(header[1]));
        continue;
      }
      if (!collecting) continue;
      if (TODO_STOP.test(line) || line.slice(0, TODO_STOP_PREFIX.length) === TODO_STOP_PREFIX) break;
      const m = line.match(TODO_ITEM);
      if (m) {
        items.push(m[1].trim());
        continue;
      }
      if (line === '') {
        const next = (lines[i + 1] || '').trim();
        if (next && !TODO_ITEM.test(next) && !TODO_HEADER.test(next)) break;
      }
    }
    return items;
  }

  /**
   * The AI queue's open items (#3105): prompts the operator queued to fire
   * once the chat is free, less any whose text has already reached the
   * stream some other way (smart auto-clear) — as an in-flight send, a
   * recorded user event, or a user turn the live pane now shows.
   * @param {Array<{id?: *, text?: string}>|null} queued - `chat.queuedPrompts`.
   * @param {Array<{text?: string}>|null} pending - `chat.pending`/in-flight sends.
   * @param {Array<{role?: string, content?: string}>|null} [events] - Recorded conversation events.
   * @param {Array<{role?: string, text?: string}>|null} [liveTurns] - `live.turns`.
   * @returns {Array<{id: *, text: string}>}
   */
  function openQueuedPrompts(queued, pending, events, liveTurns) {
    const list = (Array.isArray(queued) ? queued : [])
      .filter((p) => p && typeof p.text === 'string' && p.text.trim())
      .map((p, i) => ({ id: p.id != null ? p.id : i, text: p.text }));
    const sent = new Set((Array.isArray(pending) ? pending : [])
      .filter((p) => p && typeof p.text === 'string').map((p) => p.text.trim()));
    (Array.isArray(events) ? events : []).forEach((e) => {
      if (e && e.role === 'user' && typeof e.content === 'string') sent.add(e.content.trim());
    });
    (Array.isArray(liveTurns) ? liveTurns : []).forEach((t) => {
      if (t && t.role === 'user' && typeof t.text === 'string') sent.add(t.text.trim());
    });
    return list.filter((p) => !sent.has(p.text.trim()));
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
   * An item's `1- `, `2- ` numbering prefix (#3131): deterministic text,
   * not a parenthetical badge, and only once its list holds more than one.
   * @param {number} i - Zero-based position.
   * @param {number} total
   * @returns {string} HTML, or '' for a single-item list.
   */
  function itemNumberMarkup(i, total) {
    return total > 1 ? `<span class="v6-chat-question-badge" aria-hidden="true">${i + 1}-</span> ` : '';
  }

  /**
   * The question slot's contents (#3079): each question numbered `1- `,
   * `2- ` (#3131) when there are several, each with a ✕ that dismisses it.
   * @param {string[]|string|null} questions
   * @returns {string} HTML for inside the question slot.
   */
  function chatQuestionInner(questions) {
    const list = questionList(questions);
    if (!list.length) return '';
    // #3131 (PRR-B R1 warning 1): the outer YOU (x) section already labels
    // this; a second "Waiting on you:" inside it was left over from before
    // that header existed.
    return `<ol class="v6-chat-question-list">${list.map((q, i) => (
        `<li class="v6-chat-question-item">${itemNumberMarkup(i, list.length)}<span class="v6-chat-question-text">${escapeHtml(q)}</span>
          <button type="button" class="v6-chat-question-dismiss" id="v6ChatQuestionDismiss${i}" data-index="${i}" title="Dismiss this question" aria-label="Dismiss question ${i + 1}"><span aria-hidden="true">✕</span></button></li>`
      )).join('')}</ol>`;
  }

  /**
   * A CLI gate's card (#3105): its prompt line, a quick-send button per
   * option, and a jump to Under the Hood (the raw pane the gate came from).
   * @param {ReturnType<typeof extractCliGates>} gate
   * @returns {string} HTML, or '' when there is none.
   */
  function cliGateMarkup(gate) {
    if (!gate) return '';
    const chips = (gate.options || []).map((o) => (
      `<button type="button" class="v6-chat-gate-action" data-gate-key="${escapeHtml(o.key)}">${escapeHtml(o.label)}</button>`
    )).join('');
    return `<p class="v6-chat-gate-card"><span class="v6-chat-question-text">${escapeHtml(gate.text)}</span>
      <span class="v6-chat-gate-actions">${chips}<button type="button" class="v6-chat-gate-hood">🔧 Under the Hood</button></span></p>`;
  }

  /**
   * A multiple-choice question's card (#3105): a clickable chip per choice,
   * plus an implicit "5 / Other" that focuses the message box for a write-in.
   * @param {ReturnType<typeof extractMultiChoice>} choice
   * @returns {string} HTML, or '' when there is none.
   */
  function multiChoiceMarkup(choice) {
    if (!choice) return '';
    const chips = choice.choices.map((c, i) => (
      `<button type="button" class="v6-chat-choice-option" data-choice-key="${i + 1}" title="${escapeHtml(c)}">${i + 1}</button>`
    )).join('') + `<button type="button" class="v6-chat-choice-option v6-chat-choice-other" data-choice-key="other">5 / Other</button>`;
    return `<p class="v6-chat-choice-card">${choice.question ? `<span class="v6-chat-question-text">${escapeHtml(choice.question)}</span>` : ''}
      <span class="v6-chat-gate-actions">${chips}</span></p>`;
  }

  /**
   * A fleet member's display name (#3131): a target workspace/session id
   * resolved against the known projects list by the minted-id convention
   * (`<project name, lowercased>-<hex>`), falling back to the raw id when
   * no project matches — never a model call, just the same data the
   * sidebar already loads.
   * @param {string|null} target
   * @param {Array<{name?: string}>|null} knownProjects
   * @returns {string|null}
   */
  function medusaTargetDisplayName(target, knownProjects) {
    if (!target) return target;
    const slug = String(target).toLowerCase();
    const hit = (Array.isArray(knownProjects) ? knownProjects : [])
      .find((p) => p && typeof p.name === 'string' && slug.startsWith(`${p.name.toLowerCase()}-`));
    return hit ? hit.name : target;
  }

  /**
   * Live outbound Medusa requests still awaiting a peer's reply (#3131):
   * every `tc message send <to> …` the pane shows, grouped by target and
   * kept only until ANY inbound switchboard traffic follows it — the same
   * pane-derived signal {@link switchboardItems} already keeps, never a
   * model call. Only the latest outstanding send per target is kept: a
   * later send to the same peer supersedes waiting on an earlier one.
   * @param {Array<{dir: 'in'|'out', text: string, to?: string|null}>|null} switchboard
   * @param {string[]} [dismissedKeys] - `target::text` keys already dismissed.
   * @returns {Array<{target: string, text: string, key: string}>}
   */
  function fleetWaitingList(switchboard, dismissedKeys) {
    const list = Array.isArray(switchboard) ? switchboard : [];
    const dismissed = new Set(Array.isArray(dismissedKeys) ? dismissedKeys : []);
    const byTarget = new Map();
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || item.dir !== 'out' || !item.to) continue;
      if (list.slice(i + 1).some((x) => x && x.dir === 'in')) continue;
      const text = String(item.text || '').replace(/\s+/g, ' ').trim();
      const key = `${item.to}::${text}`;
      if (dismissed.has(key)) continue;
      byTarget.set(item.to, { target: item.to, text: item.text, key });
    }
    return [...byTarget.values()];
  }

  /**
   * The unified Waiting-on panel's model (#3131): what each actor group —
   * YOU (CLI gates, multi-choice, direct questions and the operator's
   * ToDo), AI, and every Fleet Member currently awaited — has to show.
   * @param {object|null} live - A conversation view's `chat.live`.
   * @param {object|null} chat - A conversation view's `chat`.
   * @param {Array<object>|null} [events] - The view's recorded events (AI auto-clear).
   * @param {Array<object>|null} [liveTurns] - `live.turns` (AI auto-clear).
   * @param {Array<{name?: string}>|null} [knownProjects] - For Fleet Member display names.
   * @returns {{direct: string[], gate: ReturnType<typeof extractCliGates>,
   *   choice: ReturnType<typeof extractMultiChoice>, todo: string[],
   *   ai: Array<{id: *, text: string}>,
   *   fleet: Array<{target: string, name: string, text: string, key: string}>}}
   */
  function waitingOnModel(live, chat, events, liveTurns, knownProjects) {
    const c = chat || {};
    const reply = latestReplyText(live);
    const rawTodo = extractOperatorTodo(reply);
    // #3105 (PRR-A R1 C3): dismissed by TEXT, not by a whole-list snapshot
    // — a per-item ✕ removes just that one item, while Clear dismisses
    // every item currently shown in one call. The same still-latest reply
    // keeps whatever of its items were dismissed until it genuinely changes.
    const dismissedTodo = new Set(Array.isArray(c.dismissedTodoItems) ? c.dismissedTodoItems : []);
    const todo = rawTodo.filter((t) => !dismissedTodo.has(t));
    // #3105 (PRR-A R1 C1): `live.rawLines` wins when the pane just answered;
    // `chat.peek.lines` (Under the Hood's own raw tail) is the fallback the
    // gate still needs between polls or before a live read has landed.
    const rawLines = live && Array.isArray(live.rawLines) ? live.rawLines
      : (c.peek && Array.isArray(c.peek.lines) ? c.peek.lines : []);
    const fleet = fleetWaitingList(live && live.switchboard, Array.isArray(c.dismissedFleetTargets) ? c.dismissedFleetTargets : [])
      .map((f) => Object.assign({}, f, { name: medusaTargetDisplayName(f.target, knownProjects) }));
    return {
      direct: openQuestions(live, Array.isArray(c.dismissedQuestions) ? c.dismissedQuestions : []),
      gate: extractCliGates(rawLines),
      choice: extractMultiChoice(reply),
      todo,
      ai: openQueuedPrompts(c.queuedPrompts, c.pending, events, liveTurns),
      fleet
    };
  }

  /**
   * The "Your ToDo" `<li>`s alone (#3105) — shared between the full
   * render and the poll-time repaint so the two never drift apart.
   * @param {string[]} todo
   * @returns {string} HTML for inside `#v6ChatTodo`.
   */
  function todoListMarkup(todo) {
    return todo.map((t, i) => (
      `<li>${itemNumberMarkup(i, todo.length)}<span class="v6-chat-question-text">${escapeHtml(t)}</span>
        <button type="button" class="v6-waiting-on-todo-dismiss" data-text="${escapeHtml(t)}" title="Dismiss this item" aria-label="Dismiss this ToDo item"><span aria-hidden="true">✕</span></button></li>`
    )).join('');
  }

  /**
   * The AI queue's `<li>`s alone (#3105) — shared the same way.
   * @param {Array<{id: *, text: string}>} ai
   * @returns {string} HTML for inside `#v6ChatAi`.
   */
  function aiListMarkup(ai) {
    return ai.map((p, i) => (
      `<li>${itemNumberMarkup(i, ai.length)}<span class="v6-chat-question-text">${escapeHtml(p.text)}</span>
        <button type="button" class="v6-waiting-on-ai-force" data-id="${escapeHtml(String(p.id))}" title="Force send now" aria-label="Force send now"><span aria-hidden="true">⚡</span></button>
        <button type="button" class="v6-waiting-on-ai-dismiss" data-id="${escapeHtml(String(p.id))}" title="Remove from queue" aria-label="Remove from queue"><span aria-hidden="true">✕</span></button></li>`
    )).join('');
  }

  /**
   * The YOU group's Clear button alone (#3131 PRR-B R1 blocking 1b),
   * wrapped so a poll can replace it in one piece as `model.direct.length`
   * crosses the 0/1-vs->1 boundary — kept OUT of `#v6ChatQuestion` itself,
   * which has its own separate, focus-preserving poll-time update (#3079).
   * @param {number} directCount
   * @returns {string} HTML for inside `#v6WaitingOnYouClearWrap`.
   */
  function youClearMarkup(directCount) {
    return directCount > 1 ? '<button type="button" id="v6WaitingOnYouClear" class="v6-waiting-on-clear">Clear</button>' : '';
  }

  /**
   * The "Your ToDo" sub-block — subhead, list and Clear — as one piece
   * (#3131 PRR-B R1 blocking 1b): shared between the full render and the
   * poll-time repaint so a poll that crosses the 0/1-vs->1 boundary never
   * leaves the subhead or the Clear button stale.
   * @param {string[]} todo
   * @returns {string} HTML for inside `#v6ChatTodoWrap`.
   */
  function todoWrapMarkup(todo) {
    return `${todo.length ? '<span class="v6-waiting-on-subhead">Your ToDo</span>' : ''}
        <ol id="v6ChatTodo" class="v6-waiting-on-todo-list">${todoListMarkup(todo)}</ol>
        ${todo.length > 1 ? '<button type="button" id="v6WaitingOnTodoClear" class="v6-waiting-on-clear">Clear</button>' : ''}`;
  }

  /**
   * The AI queue's list and Clear, as one piece (#3131 PRR-B R1 blocking
   * 1b) — the same reason {@link todoWrapMarkup} is one piece.
   * @param {Array<{id: *, text: string}>} ai
   * @returns {string} HTML for inside `#v6ChatAiWrap`.
   */
  function aiWrapMarkup(ai) {
    return `<ol id="v6ChatAi" class="v6-waiting-on-ai-list">${aiListMarkup(ai)}</ol>
        ${ai.length > 1 ? '<button type="button" id="v6WaitingOnAiClear" class="v6-waiting-on-clear">Clear</button>' : ''}`;
  }

  /**
   * One Fleet Member's outstanding-send `<li>`s alone (#3131) — shared the
   * same way as {@link todoListMarkup}/{@link aiListMarkup}.
   * @param {Array<{text: string, key: string}>} items
   * @returns {string} HTML for inside a Fleet Member section's `<ol>`.
   */
  function fleetListMarkup(items) {
    return items.map((f, i) => (
      `<li>${itemNumberMarkup(i, items.length)}<span class="v6-chat-question-text">${escapeHtml(f.text)}</span>
        <button type="button" class="v6-waiting-on-fleet-dismiss" data-key="${escapeHtml(f.key)}" title="Dismiss this item" aria-label="Dismiss this item"><span aria-hidden="true">✕</span></button></li>`
    )).join('');
  }

  /**
   * @param {ReturnType<typeof waitingOnModel>} model
   * @returns {number} The YOU group's combined count (#3131): CLI gates,
   *   multi-choice, direct questions and the operator's ToDo, as one.
   */
  function waitingOnYouCount(model) {
    return model.direct.length + model.todo.length + (model.gate ? 1 : 0) + (model.choice ? 1 : 0);
  }

  /**
   * A collapsible Waiting-on actor section's chrome (#3131): a caret and
   * count in its header button (toggling `data-waiting-section`'s fold
   * state), the body hidden while folded.
   * @param {string} sectionKey - `'you'`, `'ai'`, or `fleet:<target>`.
   * @param {string} labelHtml - Already-safe HTML for the header label (a count span, say).
   * @param {boolean} collapsed
   * @param {string} bodyHtml
   * @param {string} cssKey - The section's class suffix (`'you'`, `'ai'`, `'fleet'`).
   * @param {boolean} hasItems
   * @param {string} ariaLabel - Plain text; this escapes it.
   * @returns {string} HTML.
   */
  function waitingOnSectionMarkup(sectionKey, labelHtml, collapsed, bodyHtml, cssKey, hasItems, ariaLabel) {
    const toggleId = `v6WaitingOnToggle-${sectionKey.replace(/[^a-zA-Z0-9]/g, '-')}`;
    return `<section class="v6-waiting-on-section v6-waiting-on-${escapeHtml(cssKey)}${hasItems ? ' has-items' : ''}${collapsed ? ' is-collapsed' : ''}" aria-label="Waiting on ${escapeHtml(ariaLabel || '')}">
        <button type="button" id="${escapeHtml(toggleId)}" class="v6-waiting-on-title" data-waiting-section="${escapeHtml(sectionKey)}" aria-expanded="${collapsed ? 'false' : 'true'}">
          <span class="v6-waiting-on-caret" aria-hidden="true">${collapsed ? '▸' : '▾'}</span> ${labelHtml}
        </button>
        <div class="v6-waiting-on-body"${collapsed ? ' hidden' : ''}>${bodyHtml}</div>
      </section>`;
  }

  /**
   * The unified Waiting-on panel (#3131): one outer `Waiting on:` header
   * over collapsible per-actor sections — YOU (CLI gates, multi-choice,
   * direct questions and the operator's ToDo, merged under one count),
   * AI, and one section per Fleet Member this chat is still awaiting a
   * reply from — each with `1- `, `2- ` numbering, per-item dismiss and a
   * group Clear once it holds more than one item.
   * @param {ReturnType<typeof waitingOnModel>} model
   * @param {Set<string>|string[]} [collapsed] - Which sections are folded.
   * @returns {string} HTML.
   */
  function waitingOnMarkup(model, collapsed) {
    // Each section — and #v6ChatQuestion/#v6ChatGateChoice/#v6ChatTodo
    // inside YOU — is ALWAYS present (never conditionally omitted): #3079's
    // callers look #v6ChatQuestion up directly and expect it there even
    // with nothing to ask, and the poll-time repaint functions below need a
    // stable target. `has-items` is what actually hides an empty section;
    // `.v6-waiting-on-panel:empty` only ever catches the all-empty case.
    // Duck-typed, not `instanceof Set`: a caller across a VM realm (a test
    // sandbox) hands over a real Set whose own constructor is not THIS
    // realm's `Set`, and `instanceof` would wrongly say no.
    const folded = collapsed && typeof collapsed.has === 'function' ? collapsed : new Set(Array.isArray(collapsed) ? collapsed : []);
    const youCount = waitingOnYouCount(model);
    const youBody = `<div id="v6ChatGateChoice" class="v6-chat-gate-choice">${cliGateMarkup(model.gate)}${multiChoiceMarkup(model.choice)}</div>
        ${chatQuestionMarkup(model.direct)}
        <span id="v6WaitingOnYouClearWrap">${youClearMarkup(model.direct.length)}</span>
        <div id="v6ChatTodoWrap" class="v6-waiting-on-todo">${todoWrapMarkup(model.todo)}</div>`;
    const you = waitingOnSectionMarkup('you', `YOU (<span id="v6ChatWaitingOnYouCount">${youCount}</span>)`,
      folded.has('you'), youBody, 'you', youCount > 0, 'you');
    const aiBody = `<div id="v6ChatAiWrap">${aiWrapMarkup(model.ai)}</div>`;
    const ai = waitingOnSectionMarkup('ai', `AI (${model.ai.length})`, folded.has('ai'), aiBody,
      'ai', model.ai.length > 0, 'AI');
    const fleetSections = fleetSectionsMarkup(model.fleet, folded);
    const anyItems = youCount > 0 || model.ai.length > 0 || (model.fleet || []).length > 0;
    return `<div id="v6ChatWaitingOn" class="v6-waiting-on-panel${anyItems ? ' has-items' : ''}">
        <h3 class="v6-waiting-on-heading">Waiting on:</h3>
        ${you}${ai}<div id="v6ChatWaitingOnFleet" class="v6-waiting-on-fleet-wrap">${fleetSections}</div>
      </div>`;
  }

  /**
   * The Fleet Member sections alone (#3131) — shared between the full
   * render and the poll-time repaint so the two never drift apart.
   * @param {Array<{target: string, name: string, text: string, key: string}>} fleet
   * @param {Set<string>} folded
   * @returns {string} HTML for inside `#v6ChatWaitingOnFleet`.
   */
  function fleetSectionsMarkup(fleet, folded) {
    return (Array.isArray(fleet) ? fleet : []).map((f) => {
      const sectionKey = `fleet:${f.target}`;
      const body = `<ol class="v6-waiting-on-fleet-list">${fleetListMarkup([f])}</ol>`;
      return waitingOnSectionMarkup(sectionKey, `${escapeHtml(f.name)} (1)`, folded.has(sectionKey), body, 'fleet', true, f.name);
    }).join('');
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
   * The `idleReason` values `GET /api/sessions/:name/status` reports that
   * mean an engine is GENUINELY working (#3167, Ruling A864, narrowed by
   * #3181): a positive `busyMarker` (`turn-in-flight`) or an active
   * subagent block (`agents-running`) — `_assessActivity` setting either
   * one really does mean mid-turn. `idle === false` ALONE is not enough —
   * the same route also reports `idle: false` with `idleReason: null` for a
   * row with no reachable pane probe at all (nothing is known, not "it is
   * busy"), `idleReason: 'settling'` for a session that IS at rest but has
   * not held still long enough yet to clear
   * `lib/sessions.js#detectAtPrompt`'s wall-clock floor, and (#3181)
   * `idleReason: 'not-at-rest'` for a session that is also at rest in fact
   * but merely lacked the OPTIONAL `idleMarker` (`? for shortcuts` / `·
   * Ready ·`) in its 15-line tail — Antigravity's `Press up to edit queued
   * messages` footer and Codex's own status bar both omit it while
   * genuinely idle. All three would have been misread as busy without this.
   */
  const STATUS_BUSY_REASONS = new Set(['turn-in-flight', 'agents-running']);

  /** @param {{idle?: boolean, idleReason?: string|null}|null} s @returns {boolean} */
  function isSessionStatusBusy(s) {
    return Boolean(s && s.idle === false && STATUS_BUSY_REASONS.has(s.idleReason));
  }

  /**
   * What the chat is busy with (#3057, extended by #3167): what the engine
   * reports from the live pane text, else — across all 4 engines, since
   * this reads the server's own `GET /api/sessions/:name/status` signal
   * rather than the pane — `Working` while that status names one of the
   * genuinely-working reasons above, else `Working` while a send is on its
   * way.
   * @param {object} chat - A conversation view's `chat`; `chat.statusBusy`
   *   is `isSessionStatusBusy(status)` from the session status poll (#3167).
   * @returns {string|null}
   */
  function chatBusyLabel(chat) {
    const live = chat && chat.live;
    if (live && live.activity) return live.activity;
    if (chat && chat.statusBusy) {
      // #3181: the status poll's own `turn-in-flight`/`agents-running`
      // signal can still be true while a CLI gate (a permission prompt, a
      // trust prompt, a numbered selector) or an interactive confirmation
      // menu is actually what is on screen waiting on the operator — that
      // is not a turn in flight, whatever the poll says.
      const rawLines = live && Array.isArray(live.rawLines) ? live.rawLines : null;
      const waitingOnOperator = rawLines
        && (extractCliGates(rawLines) || rawLines.some((l) => /↑\/↓\s*Navigate\b/i.test(l)));
      if (!waitingOnOperator) return 'Working';
    }
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
   * A `tc message` command the operator typed or the pane echoed (#3191):
   * read, send, ack or owed — the ones the switchboard protocol asks a
   * session to run on every wake, which read as noise once the operator
   * has already turned on "Hide Medusa & fleet chatter".
   */
  const TC_MESSAGE_COMMAND_RE = /^\$?\s*tc message (read|send|ack|owed)\b/i;

  /**
   * A Medusa switchboard receipt line (#3191): what `tc message send`/`read`/
   * `ack` themselves print back, as opposed to the wake notice a project
   * receives (that is {@link SWITCHBOARD_TEXT}, filtered separately).
   */
  const MEDUSA_RECEIPT_RE = /^Message to .+: received\. Exchange mx_|^Reported \d+ message id\(s\) handled|^Your switchboard inbox is empty|^\d+ message\(s\) in your inbox:|^Reading does NOT mark these handled\b/i;

  /**
   * Drop Medusa/fleet traffic from Under the Hood's raw output (#3191),
   * for "Hide Medusa & fleet chatter": a switchboard wake notice and
   * whatever of its own wrapped continuation lines still {@link fitsNotice}
   * (the same incremental check `extractLiveTurns` uses for the identical
   * wrapping, so a notice recognized as one place is recognized in the
   * other), a `tc message` command, and a Medusa receipt line. Pure —
   * exposed as `global.tcV6FilterPeekTrafficLines`, called from
   * {@link chatPeekMarkup} wherever it renders.
   * @param {string[]|null} lines
   * @param {boolean} hideTraffic
   * @returns {string[]}
   */
  function filterPeekTrafficLines(lines, hideTraffic) {
    const list = Array.isArray(lines) ? lines : [];
    if (!hideTraffic) return list;
    const out = [];
    let wakeSoFar = null;
    list.forEach((raw) => {
      const text = String(raw);
      const trimmed = text.trim();
      const indented = /^\s/.test(text);
      if (wakeSoFar !== null) {
        if (indented) {
          const joined = `${wakeSoFar} ${trimmed}`;
          if (fitsNotice(joined)) { wakeSoFar = joined; return; }
        }
        wakeSoFar = null;
      }
      if (SWITCHBOARD_TEXT.test(trimmed)) { wakeSoFar = trimmed; return; }
      if (TC_MESSAGE_COMMAND_RE.test(trimmed) || MEDUSA_RECEIPT_RE.test(trimmed)) return;
      out.push(raw);
    });
    return out;
  }

  /**
   * The live output panel's text: the session's last lines, escaped, or what
   * stands in for them. #3191: `hideTraffic` runs the lines through
   * {@link filterPeekTrafficLines} first, for "Hide Medusa & fleet chatter".
   * @param {{lines?: string[], error?: string}|null} peek
   * @param {{hideTraffic?: boolean}} [opts]
   * @returns {string} HTML-escaped text for a `<pre>`.
   */
  function chatPeekMarkup(peek, opts) {
    if (!peek) return 'Waiting for output…';
    if (peek.error) return `Could not read live output: ${escapeHtml(peek.error)}`;
    const lines = filterPeekTrafficLines(Array.isArray(peek.lines) ? peek.lines : [], Boolean(opts && opts.hideTraffic));
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
   * The exact raw tmux key names Under the Hood's Interactive CLI Mode
   * sends straight to the pane (#3135) — the backend's own
   * `POST .../command` route (`{ rawKey }`, Car V651-W1-B) accepts only
   * these, each delegated to `tmux.sendRawKey`.
   */
  const HOOD_NAV_RAW_KEYS = Object.freeze({
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Tab: 'Tab', Escape: 'Escape'
  });

  /**
   * What one keystroke does in Under the Hood's Interactive CLI Mode
   * (#3135): a navigation or control key sends a raw tmux key straight to
   * the pane; a plain printable character is held until Enter sends it,
   * AS LITERAL TEXT, with Enter — the one-paste shape the chat composer's
   * own send already uses, since the backend's text route pastes a whole
   * buffer at once, never one keystroke at a time.
   * @param {{key?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean}|null} evt
   * @param {string} buffered - What Interactive Mode has typed but not sent yet.
   * @returns {{type: 'rawKey', value: string}|{type: 'send', text: string}|
   *   {type: 'buffer', text: string}|null} `null` for a key this mode leaves alone
   *   (so the browser's own default — e.g. a real modifier chord it does not name — still runs).
   */
  function hoodKeyAction(evt, buffered) {
    if (!evt || typeof evt.key !== 'string') return null;
    const held = typeof buffered === 'string' ? buffered : '';
    if ((evt.ctrlKey || evt.metaKey) && evt.key.length === 1 && evt.key.toLowerCase() === 'c') return { type: 'rawKey', value: 'C-c' };
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return null;
    if (evt.key === 'Backspace') return held ? { type: 'buffer', text: held.slice(0, -1) } : { type: 'rawKey', value: 'BSpace' };
    if (evt.key === 'Enter') return held ? { type: 'send', text: held } : { type: 'rawKey', value: 'Enter' };
    if (Object.prototype.hasOwnProperty.call(HOOD_NAV_RAW_KEYS, evt.key)) return { type: 'rawKey', value: HOOD_NAV_RAW_KEYS[evt.key] };
    if (evt.key.length === 1) return { type: 'buffer', text: `${held}${evt.key}` };
    return null;
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
   * One member row on the Overview screen (#3154): its live/offline state,
   * a direct "▶ Start" when offline, the same inline engine picker the
   * chat header carries, a direct "⚙ Edit Session", and "Open Chat".
   * @param {{seatId: string, role: string}} member - A tree member.
   * @param {object|null} row - Its matching flat `GET /api/projects` row, if found.
   * @returns {string} HTML.
   */
  function overviewMemberMarkup(member, row) {
    const name = (row && row.name) || member.role || '';
    const live = Boolean(row && row.session && row.session.active === true);
    const hash = routeHash({ view: 'conversation', resourceId: member.seatId });
    const idSuffix = escapeHtml(String(member.seatId));
    return `<li class="v6-overview-member${live ? ' is-live' : ' is-offline'}">
      <a id="v6OverviewMemberLink-${idSuffix}" class="v6-overview-member-link" href="${escapeHtml(hash)}" data-route="${escapeHtml(hash)}">${escapeHtml(name)}</a>
      <span class="v6-overview-member-status">${live ? 'Online' : 'Offline'}</span>
      ${live ? '' : `<button type="button" id="v6OverviewStart-${idSuffix}" class="btn btn-secondary btn-small" data-action="overview-start" data-project="${escapeHtml(name)}">▶ Start</button>`}
      ${engineSelectMarkup(`v6OverviewEngine-${idSuffix}`, row, `Switch engine for ${name}`)}
      <button type="button" id="v6OverviewSettings-${idSuffix}" class="btn btn-secondary btn-small" data-action="overview-settings" data-project="${escapeHtml(name)}"><span aria-hidden="true">⚙ Edit Session</span></button>
      <a id="v6OverviewOpenChat-${idSuffix}" class="btn btn-secondary btn-small" href="${escapeHtml(hash)}" data-route="${escapeHtml(hash)}">Open Chat</a>
    </li>`;
  }

  /**
   * The generic, non-session-specific V6 landing screen (#3154): every
   * fleet and workspace project, grouped the same way the sidebar tree is,
   * each a card an operator can act on directly — start it, switch its
   * engine, edit it, or open its chat — with no session needing to be
   * open first. Shown whenever `route.view === 'overview'` resolves no
   * project (every time: Overview never has one).
   * @param {Array<{id: string, displayName: string, fleets: Array<{members: Array<object>}>}>} tree -
   *   `synthesizeTreeFromProjects`'s own shape.
   * @param {Array<object>|null} projects - `GET /api/projects`'s flat rows, looked up by each
   *   member's `seatId` for its live session/engine state.
   * @returns {string} HTML.
   */
  function overviewMarkup(tree, projects) {
    const rows = Array.isArray(projects) ? projects : [];
    const byId = (id) => rows.find((p) => p && String(p.id) === String(id)) || null;
    const groups = Array.isArray(tree) ? tree : [];
    const cards = groups.map((lp) => {
      const members = (lp.fleets || []).flatMap((f) => f.members || []);
      const memberItems = members.map((m) => overviewMemberMarkup(m, byId(m.seatId))).join('');
      const fleetHash = routeHash({ view: 'project', projectId: lp.id });
      const fleetIdSuffix = escapeHtml(String(lp.id));
      return `<section class="v6-overview-card" aria-label="${escapeHtml(lp.displayName)}">
        <h3><a id="v6OverviewFleetLink-${fleetIdSuffix}" href="${escapeHtml(fleetHash)}" data-route="${escapeHtml(fleetHash)}">${escapeHtml(lp.displayName)}</a></h3>
        <ul class="v6-overview-members">${memberItems}</ul>
      </section>`;
    }).join('');
    return `<section class="v6-overview" aria-label="Fleet and Workspace Overview">
      <h2 class="v6-detail-title">Fleet &amp; Workspace Overview</h2>
      ${cards || '<p class="v6-detail-empty">No projects yet — use + New Project / Fleet Wizard in the sidebar.</p>'}
    </section>`;
  }

  /**
   * Render whichever detail the current view carries.
   * @param {{kind: 'plan', plan: object}|{kind: 'conversation', view: object}|{kind: 'settings', view: object}|
   *   {kind: 'recovery', view: object}|{kind: 'knowledge', help: object}|{kind: 'overview', view: object}|{kind: 'loading'}|null} detail
   * @returns {string} HTML.
   */
  function detailMarkup(detail, extras) {
    if (!detail) return '';
    if (detail.kind === 'overview') return overviewMarkup(detail.view.tree, detail.view.projects);
    if (detail.kind === 'plan') return fleetPlanMarkup(detail.plan);
    if (detail.kind === 'conversation') {
      // The composer's unsent text lives in the shell, not the controller's
      // view, so a re-render that is not a send keeps it (#3047); the shell
      // passes only the draft for this chat's own project.
      const draft = (extras && extras.draft) || '';
      const hoodOpen = Boolean(extras && extras.hoodOpen);
      const hoodFullScreen = Boolean(extras && extras.hoodFullScreen);
      const hoodInteractive = Boolean(extras && extras.hoodInteractive);
      // #3135: defaults pinned (true) until the operator's own scroll
      // turns it off; `=== false` on the FAR side (the markup check
      // above) is what distinguishes "explicitly off" from "unset".
      const streamPinned = !(extras && extras.streamPinned === false);
      const fleetArmed = Boolean(extras && extras.fleetArmed);
      const rename = (extras && extras.rename) || null;
      const sidebarCollapsed = Boolean(extras && extras.sidebarCollapsed);
      const activityElapsed = (extras && extras.activityElapsed) || '';
      const dismissedQuestions = (extras && extras.dismissedQuestions) || [];
      const dismissedTodoItems = (extras && extras.dismissedTodoItems) || [];
      const dismissedFleetTargets = (extras && extras.dismissedFleetTargets) || [];
      const collapsedWaitingOn = (extras && extras.collapsedWaitingOn) || [];
      const knownProjects = (extras && extras.knownProjects) || [];
      const queuedPrompts = (extras && extras.queuedPrompts) || [];
      const pending = (extras && extras.pending) || null;
      const verbosity = (extras && extras.verbosity) || VERBOSITY_DEFAULT;
      // #3191: checked by default — `extras` omitting it entirely (an
      // older caller, or a test fixture) must still default to hidden.
      const hideHoodTraffic = !(extras && extras.hideHoodTraffic === false);
      // #3139: "Show preview by default" — global, off unless the operator turned it on.
      const autoPreview = Boolean(extras && extras.autoPreview);
      const v = detail.view || {};
      // #3063: in a chat the telemetry bar shares the chat's header row.
      const telemetry = extras && 'telemetry' in extras ? extras.telemetry : undefined;
      return conversationViewMarkup(Object.assign({}, v, {
        chat: Object.assign({}, v.chat, {
          draft, hoodOpen, hoodFullScreen, hoodInteractive, streamPinned, fleetArmed, sidebarCollapsed, activityElapsed, telemetry, rename,
          dismissedQuestions, dismissedTodoItems, dismissedFleetTargets, collapsedWaitingOn, knownProjects,
          queuedPrompts, pending, verbosity, autoPreview, hideHoodTraffic
        })
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
   * The Classic dashboard's admin controls (#3079). #3153 retired the "⋯
   * More" menu these used to tuck into: `.dash-bar`/`.dash-actions` has
   * ample room, so every one of these now stays directly visible inline
   * on the top bar in V6 view, same as Classic View, Master and Advisor
   * always did. Kept as a named list (rather than inlined where it's read)
   * for `test/v6-b1-ui-shell.test.js` and anything else that still needs
   * to name "the admin controls" as a group.
   */
  const ADMIN_TUCK_IDS = Object.freeze([
    'portsToggle', 'usageToggle', 'groupsToggle', 'openclawToggle',
    'auditToggle', 'fleetRecoveryToggle', 'rulesToggle', 'signOutBtn'
  ]);

  /**
   * Slim the top bar while the v6 shell shows (#3079): mark the body
   * `v6-shell-active`. #3153: no longer moves the admin controls
   * (`ADMIN_TUCK_IDS`) anywhere — they stay inline in `.dash-actions`
   * exactly where Classic View put them, so this function (and this
   * doc comment) is left named for the OTHER docking it still does: the
   * chat header and drawer toggle into `.dash-bar`, and the dashboard's
   * own stats into the shell's footer. Safe to call on every render.
   * @param {Document} doc
   * @param {boolean} active - Whether the v6 shell is showing.
   * @returns {void}
   */
  function tuckAdminControls(doc, active) {
    if (!doc || typeof doc.getElementById !== 'function') return;
    if (doc.body && doc.body.classList) doc.body.classList.toggle('v6-shell-active', Boolean(active));
    // Ruling A764: one top bar. The chat's header joins the dashboard bar,
    // and the dashboard's own stats go to the shell's footer (A765). The
    // stats move first, so the place they return to is before the bar's
    // actions, which never move, not before a header that comes and goes.
    moveDashStats(doc, active);
    dockChatHeader(doc, active);
    dockDrawerToggle(doc, active);
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
   * Dock the mobile `☰` drawer toggle at the leading edge of `.dash-bar`,
   * next to `.dash-brand` (#3117) — same move-not-copy pattern as
   * {@link dockChatHeader}, so the button keeps its own listeners and
   * focus. CSS (`@media (max-width: 760px)`) decides when it is actually
   * visible; this only decides WHERE it lives in the DOM, every width.
   * @param {Document} doc
   * @param {boolean} active
   */
  function dockDrawerToggle(doc, active) {
    if (typeof doc.querySelector !== 'function') return;
    const bar = doc.querySelector('.dash-bar');
    if (!bar) return;
    const docked = typeof bar.querySelector === 'function' ? bar.querySelector('.v6-shell-drawer-toggle') : null;
    const drawn = active ? doc.getElementById('v6ShellDrawerToggle') : null;
    if (docked && docked !== drawn && (drawn || !active)) docked.remove();
    if (!drawn || typeof bar.prepend !== 'function') return;
    if (bar.firstElementChild !== drawn) bar.prepend(drawn);
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
    // #3203: the offline startup hero's own per-project state -- separate
    // from `send` (showSend/chat.send, the composer's own status line),
    // since there is no composer to render under while offline. Keyed by
    // project NAME, matching startSession's own existing key (it can be
    // called for a project other than the one on screen, e.g. from the
    // sidebar or Overview).
    const launchState = new Map();
    // #3203: whether the offline hero has been switched to "View Previous
    // Conversation" mode, and that mode's own loaded snapshot -- both keyed
    // by project id, reset each time a fresh (still-offline) load of that
    // chat begins, so returning to an offline chat always starts at the
    // hero again.
    const viewingOfflineHistory = new Set();
    const offlineHistoryCache = new Map();
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
    // #3201: chat reads since the Fleet Sidebar last refreshed.
    let sidebarPolls = 0;
    // #3201: the standalone ~12s sidebar-only timer, for a route with no
    // chat poll of its own to piggyback on (Overview, Settings, no project
    // resolved) — independent of `pollId`, since the two can never both be
    // active for the same route generation but each needs its own id to
    // stop.
    let sidebarPollId = null;
    let usageActionsGiven = false;
    // #3132: the automated probe's own actions are handed to the shell once, separately.
    let usageProbeActionsGiven = false;

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
     * Load the automated CLI usage probe's last-persisted snapshot (#3132,
     * `GET /api/usage/probe` — never forces a fresh probe; that's what the
     * popover's own "↻ Refresh now" button and `refreshUsageProbeAction` are
     * for) and hand it, and once its actions, to the shell.
     * @returns {Promise<void>}
     */
    async function loadUsageProbe() {
      const data = await api('/api/usage/probe');
      const sh = getShell();
      if (!sh || typeof sh.setUsageProbe !== 'function' || !data) return;
      if (!usageProbeActionsGiven && typeof sh.setUsageProbeActions === 'function') {
        sh.setUsageProbeActions({ refresh: refreshUsageProbeAction, setInterval: setUsageProbeIntervalAction });
        usageProbeActionsGiven = true;
      }
      sh.setUsageProbe(data);
    }

    /**
     * What the popover's "↻ Refresh now" button calls (#3132): run every
     * provider's probe now (`POST /api/usage/refresh`), rather than waiting
     * for the next scheduled or polled read. Needs no operator proof —
     * same reasoning as the route itself: the probe only ever shells out to
     * the three fixed CLI binaries `lib/usage-windows.js` names, nothing
     * caller-supplied.
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async function refreshUsageProbeAction() {
      const res = await api('/api/usage/refresh', { method: 'POST', body: JSON.stringify({}) });
      if (!res) return { ok: false, error: api.lastError || 'the server refused it' };
      const sh = getShell();
      if (sh && typeof sh.setUsageProbe === 'function') sh.setUsageProbe(res);
      // PRR-B R1 BLOCKING 2c: `POST /api/usage/refresh` also feeds a
      // successful reading into the server's OWN calibration store
      // (`lib/usage-windows.js#_refreshUsageProbeUncached`) — reloading the
      // manual meter's own data here is what makes the footer pills (fed by
      // `GET /api/usage/windows`) reflect it at once, instead of waiting for
      // the next scheduled poll or route change.
      await loadUsage();
      return { ok: true };
    }

    /**
     * What the popover's auto-refresh interval selector calls (#3132:
     * "15m/30m/1h/Manual", `POST /api/usage/probe/interval`).
     * @param {string} interval
     * @returns {Promise<{ok: boolean, interval?: string, error?: string}>}
     */
    async function setUsageProbeIntervalAction(interval) {
      const res = await api('/api/usage/probe/interval', { method: 'POST', body: JSON.stringify({ interval }) });
      if (!res) return { ok: false, error: api.lastError || 'the server refused it' };
      await loadUsageProbe();
      return { ok: true, interval: res.interval };
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

    /** Stop the standalone sidebar-only refresh timer (#3201), independent of {@link stopPolling}. */
    function stopSidebarPolling() {
      if (sidebarPollId != null && stopTimer) stopTimer(sidebarPollId);
      sidebarPollId = null;
    }

    /**
     * Start the standalone ~12s sidebar-only refresh timer (#3201), for a
     * route with no chat poll of its own to piggyback on. A no-op when one
     * is already running for this route generation (`pollId` -- the chat
     * poll already covers it) or `sidebarPollId` is already set.
     * @param {number} mine - The route generation this timer belongs to.
     */
    function startSidebarPolling(mine) {
      if (pollId != null || sidebarPollId != null || !startTimer) return;
      sidebarPollId = startTimer(async () => {
        if (mine !== seq) { stopSidebarPolling(); return; }
        const shell = getShell();
        if (!shell) return;
        await refreshSidebarStatus(shell, mine);
      }, SIDEBAR_POLL_MS);
    }

    /**
     * The consolidated Fleet Sidebar refresh (#3201): reloads the project
     * rows and engine health, and hands both to the shell. Each setter
     * (`setProjects`/`setTree`/`setEngineHealth`) re-renders through the
     * shell's own `render()`, which already wraps every redraw in
     * `captureViewState()`/`restoreViewState()` — so this never resets the
     * chat composer draft, focus/caret, open dropdowns, or scroll
     * positions; nothing further is needed here to preserve them.
     * @param {object} shell
     * @param {number} mine - The route generation this refresh belongs to.
     * @returns {Promise<void>}
     */
    async function refreshSidebarStatus(shell, mine) {
      await loadProjects();
      if (mine !== seq) return;
      showProjects(shell);
      await loadEngineHealth(shell);
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
        // #3199: an optimistic send still in flight (drawn at the bottom of
        // the chat until it settles — the shell's own `pendingSends`,
        // read through `getShell()` since this controller does not hold
        // that state itself) and the most recently recorded send this chat
        // is still waiting to see echoed (`sent.full`) are both already
        // the operator's own words; a peek poll landing before the B2
        // `POST .../conversation/events` call settles must not read either
        // one's own pane echo as a fresh assistant turn.
        const sh = getShell();
        if (sh && typeof sh.getPendingSends === 'function') {
          said.push(...sh.getPendingSends().filter((p) => p && p.key === key).map((p) => p.text));
        }
        if (sent && sent.full) said.push(sent.full);
        live = extractLiveTurns(res.lines, engine, said);
        // #3105: the raw pane tail, for extractCliGates — the CLI gate text
        // itself is chrome extractLiveTurns throws away, so it needs the
        // lines as the pane actually sent them.
        live.rawLines = res.lines;
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
        // #3167: the universal, engine-agnostic busy signal, read alongside
        // LIVE_BUSY's own pane-text detection in chatBusyLabel.
        statusBusy: isSessionStatusBusy(status),
        send: sendOutcome || null,
        inFlight: (sendsInFlight.get(String(project.id)) || 0) > 0
      });
      current = { project, sessionId, launchId: (status && status.launchId) || null, ctx, mine, view: null };
      if (sessionId == null) {
        // #3203: a fresh (re-)entry into an offline chat always starts at
        // the hero, never wherever a PREVIOUS visit left it -- the
        // operator clicks "View Previous Conversation" again if they want
        // it. launchState is keyed by name, not id, since startSession can
        // set it for a project other than the one on screen; clearing it
        // here only matters for THIS project's own key.
        const offlineKey = String(project.id);
        viewingOfflineHistory.delete(offlineKey);
        offlineHistoryCache.delete(offlineKey);
        launchState.delete(String(project.name || ''));
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
              // #3201: piggyback the consolidated Fleet Sidebar refresh
              // every 3rd tick, same cadence as the live-chat poll below —
              // an offline chat's own session is already covered by the
              // status check right after, but a SIBLING session starting
              // or stopping elsewhere needs this too.
              sidebarPolls = (sidebarPolls + 1) % SIDEBAR_EVERY_POLLS;
              if (sidebarPolls === 0) {
                const sidebarShell = getShell();
                if (sidebarShell) await refreshSidebarStatus(sidebarShell, mine);
                if (mine !== seq) return;
              }
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
      // #3166: always the deep depth, whether or not Under the Hood is open
      // — a closed drawer used to read only the shallow depth (#3135), which
      // silently truncated #v6ChatStream itself since extractLiveTurns parses
      // chat turns from this same read, not just what the drawer's own raw
      // panel shows.
      const peekUrl = () => `/api/sessions/${name}/peek?lines=${PEEK_LINES_DEEP}`;
      // #3076: the listener's state and unread count. Unlike opening the
      // inbox, this read marks nothing read and leaves the unread count
      // alone; while listening, the route also asks the Bridge for loops.
      const medusaUrl = `/api/sessions/${name}/medusa/status`;
      const [events, attestations, peek, medusaStatus] = await Promise.all([
        api(`${base}/conversation/events`),
        api(`${base}/attestations`),
        api(peekUrl()),
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
          // #3085/#3132: the usage meter and its automated probe snapshot
          // both refresh every USAGE_EVERY_POLLS reads — the probe route
          // itself never forces a fresh CLI run on this cadence, only
          // reads back whatever its own (much longer) background
          // scheduler or an explicit "↻ Refresh now" last recorded.
          usagePolls = (usagePolls + 1) % USAGE_EVERY_POLLS;
          if (usagePolls === 0) { loadUsage(); loadUsageProbe(); }
          // #3201: piggyback the consolidated Fleet Sidebar refresh every
          // 3rd tick — this chat's OWN status already rides the
          // session-status read below, but a SIBLING session starting or
          // stopping elsewhere would otherwise stay stale until the
          // operator navigates away and back.
          sidebarPolls = (sidebarPolls + 1) % SIDEBAR_EVERY_POLLS;
          if (sidebarPolls === 0) {
            const sidebarShell = getShell();
            if (sidebarShell) await refreshSidebarStatus(sidebarShell, mine);
            if (mine !== seq) return;
          }
          // #3167: the session status poll runs alongside peek/medusa so the
          // universal busy signal (chatBusyLabel's chat.statusBusy) stays
          // live too, not just the pane-text one — set once at load, it
          // would otherwise never clear or re-arm after the initial read.
          const [res, nextMedusaStatus, nextSessionStatus] = await Promise.all([
            api(peekUrl()), api(medusaUrl), api(`/api/sessions/${name}/status`)
          ]);
          if (mine !== seq || !current || !current.view) return;
          const next = peekView(res);
          const nextLive = liveView(res, current.project, current.view.events);
          const nextMedusa = medusaView(nextMedusaStatus, nextLive, current.view.chat && current.view.chat.medusa);
          const lastSent = lastSentFor(current.project);
          const thumbs = thumbsFor(current.project, current.view.events, nextLive);
          const statusBusy = isSessionStatusBusy(nextSessionStatus);
          current.view = Object.assign({}, current.view, { chat: Object.assign({}, current.view.chat, { peek: next, live: nextLive, medusa: nextMedusa, lastSent, thumbs, statusBusy }) });
          const sh = getShell();
          if (sh && typeof sh.setLive === 'function') sh.setLive({ peek: next, live: nextLive, medusa: nextMedusa, lastSent, thumbs, statusBusy });
          else if (sh && typeof sh.setPeek === 'function') sh.setPeek(next);
        }, CHAT_POLL_MS);
      }
    }

    /**
     * Hand the chat on screen to the shell, with its attachment chips and
     * #3203's own offline-hero state: all three belong to the target
     * project, not to the view a load built, so each is re-read fresh here
     * every time rather than threaded through every call site that changes
     * one of them.
     * @param {object} shell
     */
    function showChat(shell) {
      if (!current || !current.view || !shell) return;
      const key = String(current.project.id);
      const name = String(current.project.name || '');
      current.view = Object.assign({}, current.view, {
        chat: Object.assign({}, current.view.chat, {
          attachments: (attachments.get(key) || []).slice(),
          launchState: launchState.get(name) || null,
          viewingOfflineHistory: viewingOfflineHistory.has(key),
          offlineHistory: offlineHistoryCache.get(key) || null
        })
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
        // #3105 (PRR-A R1 C2): surface it in Waiting on: AI too, not only
        // the warning line — the operator can Force or dismiss it from there.
        if (typed && typeof shell.queuePrompt === 'function') shell.queuePrompt(chat.project.id, typed);
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

    // The sprint UI script (Rulings A760, A761): public/index.html does not
    // load it, so it is added once, on first use, and never twice.
    const SPRINT_UI_SRC = '/sprint-wave-ui.js';
    const SPRINT_UI_ID = 'tcSprintWaveUiScript';
    const pageWindow = deps.window || global;
    const pageDocument = deps.document || (pageWindow && pageWindow.document) || null;
    const later = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    let sprintUiLoad = null;
    // Set once the script has failed or timed out; the built-in drawing serves until a reload.
    let sprintUiGaveUp = false;

    /**
     * `window.TangleClawSprintWaveUi`, loading `/sprint-wave-ui.js` at most
     * once (#3086, A760/A761): a script already in the page, by its id, its
     * `data-tc-sprint-wave-ui="1"` mark or its src, is waited on rather than
     * added again; the one added carries all three. Resolves null when the script
     * fails or has not defined it within 10 seconds, and from then on resolves
     * null at once until the page reloads: a script element fires load or error
     * only once, so waiting on it again would only wait out the timer.
     * @returns {Promise<object|null>}
     */
    function sprintWaveUi() {
      const present = pageWindow && pageWindow.TangleClawSprintWaveUi;
      if (present) return Promise.resolve(present);
      if (sprintUiLoad) return sprintUiLoad;
      if (sprintUiGaveUp) return Promise.resolve(null);
      if (!pageDocument || typeof pageDocument.createElement !== 'function') return Promise.resolve(null);
      sprintUiLoad = new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve((pageWindow && pageWindow.TangleClawSprintWaveUi) || null);
        };
        const query = (sel) => (typeof pageDocument.querySelector === 'function' ? pageDocument.querySelector(sel) : null);
        let script = (typeof pageDocument.getElementById === 'function' && pageDocument.getElementById(SPRINT_UI_ID))
          || query('script[data-tc-sprint-wave-ui="1"]') || query(`script[src="${SPRINT_UI_SRC}"]`);
        if (!script) {
          script = pageDocument.createElement('script');
          script.id = SPRINT_UI_ID;
          script.src = SPRINT_UI_SRC;
          if (typeof script.setAttribute === 'function') script.setAttribute('data-tc-sprint-wave-ui', '1');
          (pageDocument.head || pageDocument.body).appendChild(script);
        }
        script.addEventListener('load', done);
        script.addEventListener('error', done);
        later(done, 10000);
      });
      sprintUiLoad.then((ui) => {
        if (ui) return;
        sprintUiLoad = null;
        sprintUiGaveUp = true;
      });
      return sprintUiLoad;
    }

    /**
     * Load a data mode's panel (#3086): read its route, draw it through the
     * sprint UI when that loads (else the shell's escaped built-in drawing),
     * and hand it to the shell. Kaizen & Reports reads the sprint in
     * progress, `GET /api/sprint-reports/current` (V630-W1-B's route).
     * @param {string} mode - `sprint`, `charter` or `kaizen`.
     * @returns {Promise<void>}
     */
    async function loadWorkspacePanel(mode) {
      // #3114 (PRR-A R1 C2a): the Wizard has no /api/v6/fleet-templates read
      // of its own anywhere else except handleRoute's startup waterfall —
      // this is the one other place that's allowed to retry it, when the
      // shell asks on Wizard entry because `templates` is still empty.
      if (mode === 'wizard') {
        const res = await api('/api/v6/fleet-templates');
        if (res && Array.isArray(res.templates)) {
          templatesLoaded = true;
          const sh = getShell();
          if (sh && typeof sh.setTemplates === 'function') sh.setTemplates(res.templates);
        }
        return;
      }
      const read = async (url) => {
        const data = await api(url);
        return data ? { ok: true, data } : { ok: false, notFound: api.lastErrorCode === 'NOT_FOUND', error: api.lastError };
      };
      const result = await read(mode === 'kaizen' ? '/api/sprint-reports/current' : '/api/sprint-waves');
      // Charter & Roadmap also reads the open project's charter (#3088).
      const project = mode === 'charter' && current && current.project ? current.project : null;
      const base = project ? `/api/v6/projects/${encodeURIComponent(project.id)}/charter` : null;
      const charter = base ? await read(base) : null;
      // The charter row has no title or approvals: an active charter's startup summary carries its title,
      // mission and version, and the export its approved roles.
      const extra = {};
      if (charter && charter.ok) {
        const c = charter.data && charter.data.charter ? charter.data.charter : {};
        if (c.active_version_id != null) {
          const summary = await read(`${base}/startup-summary`);
          extra.startupSummary = summary.ok ? summary.data : null;
        }
        const exported = await read(`${base}/export`);
        extra.approvedRoles = exported.ok && Array.isArray(exported.data.approvedRoles) ? exported.data.approvedRoles : [];
      }
      const ui = result.ok || (charter && charter.ok) ? await sprintWaveUi() : null;
      // A charter read for a project the operator has since left is dropped: its Activate buttons would act on
      // the project now open (cumulative review).
      if (project && !(current && current.project && String(current.project.id) === String(project.id))) return;
      const sh = getShell();
      if (!sh || typeof sh.setWorkspacePanel !== 'function') return;
      sh.setWorkspacePanel(mode, mode === 'charter' ? charterPanelContent(charter, result, ui, extra) : workspacePanelContent(mode, result, ui));
    }

    /**
     * POST to a train launch route with the operator's proof (#3088).
     * @param {string} url
     * @param {object} body
     * @returns {Promise<{data: object}|{error: string}>}
     */
    async function trainPost(url, body) {
      let res;
      try {
        const headers = await operatorHeaders();
        res = await api(url, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (err) { // prawduct:allow prawduct/broad-except -- a refused operator proof becomes the train launch's error line
        return { error: (err && err.message) || 'the operator proof could not be made' };
      }
      return res ? { data: res } : { error: api.lastError || 'the server refused it' };
    }

    /** @returns {object|null} The project whose chat is open, which a wave run and a charter belong to. */
    function trainProject() {
      return current && current.project ? current.project : null;
    }

    // The train launch's actions (#3088, Rulings A782 and PM a79f9e44): each
    // resolves {ok, message, html?} for the shell to show, escaped.
    const workspaceActions = {
      async computeWaves(cars) {
        const r = await trainPost('/api/v6/wave-scheduler/topological-waves', { cars: cars.map((c) => ({ id: c.id, dependsOn: c.dependsOn })) });
        if (r.error) return { ok: false, message: `Not computed: ${r.error}` };
        const n = Array.isArray(r.data.waves) ? r.data.waves.length : 0;
        return { ok: true, message: `${n} wave${n === 1 ? '' : 's'}.`, html: trainResultMarkup('waves', r.data) };
      },
      async checkDisjointness(cars) {
        const r = await trainPost('/api/sprint-waves/validate-disjointness', { cars: cars.map((c) => ({ id: c.id, files: c.files })) });
        if (r.error) return { ok: false, message: `Not checked: ${r.error}` };
        const result = r.data && r.data.result && typeof r.data.result === 'object' ? r.data.result : {};
        return { ok: result.ok === true, message: result.ok === true ? 'Disjoint.' : 'Not disjoint.', html: trainResultMarkup('disjointness', r.data) };
      },
      async startRun(cars, fleetId) {
        const project = trainProject();
        if (!project) return { ok: false, message: 'Not started: open a project\'s chat first.' };
        const r = await trainPost(`/api/v6/projects/${encodeURIComponent(project.id)}/wave-runs`, {
          fleetId, cars: cars.map((c) => ({ id: c.id, dependsOn: c.dependsOn, fileScope: c.files }))
        });
        if (r.error) return { ok: false, message: `Not started: ${r.error}` };
        loadWorkspacePanel('charter');
        loadWorkspacePanel('sprint');
        return { ok: true, message: 'Wave run started.', html: trainResultMarkup('run', r.data) };
      },
      async activateVersion(versionId, versionNumber) {
        const project = trainProject();
        if (!project) return { ok: false, message: 'Not activated: open a project\'s chat first.' };
        const r = await trainPost(`/api/v6/projects/${encodeURIComponent(project.id)}/charter/versions/${encodeURIComponent(versionId)}/activate`, {});
        if (r.error) return { ok: false, message: `Not activated: ${r.error}` };
        loadWorkspacePanel('charter');
        return { ok: true, message: `Version ${versionNumber != null ? versionNumber : versionId} is active.` };
      }
    };
    let workspaceLoaderGiven = false;

    async function handleRoute(route) {
      // The shell's first render runs inside tcCreateV6Shell itself, before
      // the caller holds the returned handle; leave the route unrecorded so
      // the next call (the caller's own kick-off) still loads it.
      const shell = getShell();
      if (!shell) return;
      if (!workspaceLoaderGiven && typeof shell.setWorkspaceLoader === 'function') {
        workspaceLoaderGiven = true;
        shell.setWorkspaceLoader((mode) => { loadWorkspacePanel(mode); });
        if (typeof shell.setWorkspaceActions === 'function') shell.setWorkspaceActions(workspaceActions);
      }
      const key = route && route.view ? JSON.stringify(route) : null;
      if (key === lastRouteKey) return;
      if (key !== null) { loadUsage(); loadUsageProbe(); }
      const entering = lastRouteKey === null;
      lastRouteKey = key;
      const mine = ++seq;
      stopPolling();
      stopSidebarPolling();
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
        // #3201: Settings never resolves a chat, so it has no poll of its
        // own to piggyback the sidebar refresh on.
        startSidebarPolling(mine);
        return;
      }
      await loadRouteDetail(route, mine);
      // #3201: a route whose detail load did not end up starting a chat
      // poll (Overview, or "no project resolved") gets the standalone
      // timer instead; one that DID (loadConversation's own pollId) is
      // already covered by that poll's own every-3rd-tick piggyback.
      if (mine === seq) startSidebarPolling(mine);
    }

    /**
     * The detail pane for a project, fleet or conversation route.
     * @param {object} route
     * @param {number} mine
     * @returns {Promise<void>}
     */
    async function loadRouteDetail(route, mine) {
      const shell = getShell();
      // #3154: the Overview never resolves a project — it IS the "nothing
      // selected" screen — so it's handled before resolveRouteProject's
      // own null case would otherwise just show nothing at all.
      if (route.view === 'overview') {
        shell.setAttestation(null);
        shell.setDetail({ kind: 'overview', view: { tree: synthesizeTreeFromProjects(projects), projects } });
        return;
      }
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
      stopSidebarPolling();
      await loadProjects();
      if (mine !== seq) return;
      showProjects(shell);
      await loadEngineHealth(shell);
      if (mine !== seq) return;
      await loadRouteDetail(route, mine);
      // #3201: see handleRoute's own identical comment.
      if (mine === seq) startSidebarPolling(mine);
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
     * Start a project's offline session (#3053, extended #3154 to take any
     * project by name — not only the chat on screen, since the sidebar and
     * the Overview screen's own "▶ Start" buttons name theirs directly)
     * and reload in place. A refusal (stranded wraps to acknowledge, an
     * engine that cannot start) shows the server's reason on the chat
     * that started it; one started from the sidebar or Overview has no
     * banner of its own to show it on, so it only refreshes — the row's
     * own status (still offline) still tells the truth. The server's
     * stranded-wraps gate itself (`lib/stranded-wraps.js`) has no
     * single-flag override; resolving it (acknowledge, or open a PR for
     * the branch) stays Classic View's own flow for now (#3154 PR body).
     *
     * #3203: also drives the offline startup hero's own `launchState`
     * (`starting` while this call is in flight, `failed` with the server's
     * reason if it is refused, cleared on success) — the same call this
     * chat's own `[▶ Start Session]`/`[↻ Retry Launch]` hero buttons use.
     * #3203 R2: a failure's structured `diagnostic` (#3202's own
     * `{code, category, title, message, remediation, retryable,
     * canEditProperties}` shape, when the server sends one) is read from
     * `api.lastBody` — `apiMutate`/`api()`'s own documented side channel
     * for "the whole refusal body" (`public/api-helper.js`, #711), set
     * alongside `api.lastError` on every failure and cleared on every
     * success; never a new contract this file invents. A server not yet
     * sending `diagnostic` (or sending a non-object one) simply reads as
     * `null` here, falling back to the plain `api.lastError` string.
     * @param {string} [projectName] - Defaults to the chat on screen.
     * @returns {Promise<void>}
     */
    async function startSession(projectName) {
      const shell = getShell();
      if (!shell) return;
      const chat = current;
      const name = String(projectName || (chat && chat.project && chat.project.name) || '');
      if (!name) return;
      const onThisChat = Boolean(chat) && String(chat.project.name || '') === name;
      if (onThisChat) showSend({ kind: 'pending', message: `Starting ${name}…` });
      launchState.set(name, { status: 'starting', message: null, diagnostic: null });
      if (onThisChat) showChat(shell);
      const ok = await apiMutate(`/api/sessions/${encodeURIComponent(name)}`, 'POST', {});
      if (onThisChat && chat !== current) return;
      if (!ok) {
        const message = `Not started: ${api.lastError || 'the server refused it'}`;
        const diagnostic = api.lastBody && typeof api.lastBody === 'object' && api.lastBody.diagnostic
          && typeof api.lastBody.diagnostic === 'object' ? api.lastBody.diagnostic : null;
        if (onThisChat) showSend({ kind: 'error', message });
        launchState.set(name, { status: 'failed', message, diagnostic });
        if (onThisChat) showChat(shell);
        return;
      }
      launchState.delete(name);
      await refresh();
    }

    /**
     * Switch the offline startup hero to its "View Previous Conversation"
     * mode (#3203): loads the chat's most recently persisted session and
     * shows it in place of the hero.
     *
     * #3203 R3: tries the project's persisted B2 conversation events first
     * — `GET /api/sessions/:name/history?limit=1` (`lib/routes/sessions.js`)
     * names the most recent session row regardless of status, and
     * `GET /api/v6/projects/:id/sessions/:sessionId/conversation/events`
     * (the same route an open chat already reads above) serves that
     * session's own events whether or not it is still live —
     * `_v6RequireProjectSession` (server.js) only checks the row exists for
     * this project, never that it is active. Rendered through
     * {@link recordedEventsMarkup}, the same USER/ASSISTANT bubble
     * formatter a live chat's own recorded events use, so message
     * rendering (and redaction, attachments, Medusa bubbles) is identical
     * whether the session is live or closed.
     *
     * Falls back to the continuity wrap-summary source
     * {@link loadHistory}/{@link openHistorySession} already read only when
     * no session row exists, or its own events come back empty — e.g. a
     * session old enough to predate B2, or one that recorded nothing. A
     * project with no persisted history by EITHER route reads `'empty'`,
     * never `'error'`.
     * @param {string} [projectName] - Must name the chat on screen; a
     *   mismatch (stale click after the chat changed) is a no-op.
     * @returns {Promise<void>}
     */
    async function viewOfflineHistory(projectName) {
      const shell = getShell();
      const chat = current;
      if (!chat || !shell) return;
      const name = String(projectName || chat.project.name || '');
      if (!name || String(chat.project.name || '') !== name) return;
      const key = String(chat.project.id);
      viewingOfflineHistory.add(key);
      offlineHistoryCache.set(key, { status: 'loading', snapshot: null, error: null });
      showChat(shell);
      const historyRes = await api(`/api/sessions/${encodeURIComponent(name)}/history?limit=1`);
      if (chat !== current) return;
      const latestId = historyRes && Array.isArray(historyRes.sessions) && historyRes.sessions[0]
        && historyRes.sessions[0].id != null ? historyRes.sessions[0].id : null;
      if (latestId != null) {
        const eventsRes = await api(`/api/v6/projects/${encodeURIComponent(chat.project.id)}/sessions/${encodeURIComponent(latestId)}/conversation/events`);
        if (chat !== current) return;
        const events = eventsRes && Array.isArray(eventsRes.events) ? eventsRes.events : null;
        if (events && events.length) {
          offlineHistoryCache.set(key, { status: 'ready', kind: 'events', events, snapshot: null, error: null });
          showChat(shell);
          return;
        }
      }
      const listRes = await api(`/api/continuity/${encodeURIComponent(name)}/sessions`);
      if (chat !== current) return;
      const sessions = listRes && Array.isArray(listRes.sessions) ? listRes.sessions : null;
      if (sessions === null) {
        offlineHistoryCache.set(key, { status: 'error', snapshot: null, error: api.lastError || 'Could not read this session’s history.' });
        showChat(shell);
        return;
      }
      if (!sessions.length) {
        offlineHistoryCache.set(key, { status: 'empty', snapshot: null, error: null });
        showChat(shell);
        return;
      }
      const newest = [...sessions].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
      const detailRes = await api(`/api/continuity/${encodeURIComponent(name)}/sessions/${encodeURIComponent(newest.sid)}`);
      if (chat !== current) return;
      if (!detailRes) {
        offlineHistoryCache.set(key, { status: 'error', snapshot: null, error: api.lastError || 'Could not open this session.' });
        showChat(shell);
        return;
      }
      const summary = detailRes.summary && detailRes.summary.sections ? detailRes.summary.sections : {};
      offlineHistoryCache.set(key, {
        status: 'ready',
        snapshot: {
          sid: String(newest.sid),
          date: (detailRes.session && detailRes.session.date) || '',
          sections: Object.entries(summary).filter(([, body]) => body).map(([secName, body]) => ({ name: secName, body: String(body) }))
        },
        error: null
      });
      showChat(shell);
    }

    /**
     * Return the offline chat from "View Previous Conversation" mode back
     * to the centered startup hero (#3203 R2's "Return to Start Card"),
     * in place — no route change, no reload, matching how
     * {@link viewOfflineHistory} entered it in the first place.
     * @param {string} [projectName] - Must name the chat on screen; a
     *   mismatch (stale click after the chat changed) is a no-op.
     */
    function returnToStartCard(projectName) {
      const shell = getShell();
      const chat = current;
      if (!chat || !shell) return;
      const name = String(projectName || chat.project.name || '');
      if (!name || String(chat.project.name || '') !== name) return;
      viewingOfflineHistory.delete(String(chat.project.id));
      showChat(shell);
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
     * Switch a project's engine (#3153) straight from the inline picker —
     * the same `PATCH /api/projects/:name` the full Settings modal's own
     * save already sends, without opening it. Works for ANY project named,
     * not only the chat currently on screen, since the picker also shows
     * on sidebar and overview rows.
     * @param {string} projectName
     * @param {string} engine
     * @returns {Promise<void>}
     */
    async function changeEngine(projectName, engine) {
      const name = String(projectName || '');
      const next = String(engine || '');
      if (!name || !next) return;
      const chat = current;
      const onThisChat = Boolean(chat) && String(chat.project.name || '') === name;
      if (onThisChat) showSend({ kind: 'pending', message: `Switching ${name} to ${next}…` });
      const res = await apiMutate(`/api/projects/${encodeURIComponent(name)}`, 'PATCH', { engine: next });
      if (onThisChat && chat !== current) return;
      if (!res) {
        const reason = api.lastError || 'the server refused it';
        if (onThisChat) showSend({ kind: 'error', message: `Not switched: ${reason}` });
        return;
      }
      await refresh();
      if (onThisChat) showSend({ kind: 'ok', message: `${name} switched to ${next}.` });
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

    /**
     * Fetch a template's live plan preview (#3114). Lands in the Wizard's
     * OWN state (`shell.setWizardPlan`/`setWizardStatus`), never `detail`
     * — the #3114 bug this replaces clobbered the active chat by routing
     * the plan through `shell.setDetail({kind: 'plan', ...})` instead.
     * @param {string} templateId
     */
    async function launchTemplate(templateId) {
      const mine = ++seq;
      const shell = getShell();
      if (!shell) return;
      const plan = await apiMutate(`/api/v6/fleet-templates/${encodeURIComponent(templateId)}/plan`, 'POST', {});
      if (mine !== seq) return;
      if (plan) shell.setWizardPlan(plan);
      else if (typeof shell.setWizardStatus === 'function') shell.setWizardStatus({ kind: 'error', message: `Could not plan template “${templateId}”.` });
    }

    /** `a`, `b`, ..., `z` — the suffix a multi-seat role's Nth seat gets (#3114). */
    function wizardLetterSuffix(index) {
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      return letters[index] || String(index + 1);
    }

    /**
     * After any Wizard workflow provisions/converts a project (#3114):
     * refresh the sidebar tree, land back in Chat, reset the Wizard's own
     * state, and navigate to the project/seat the operator should now see.
     * @param {object} shell
     * @param {string|null} firstName - The newly-created/renamed project's
     *   name to navigate to, once `loadProjects` has it, or null to skip.
     */
    async function afterWizardAction(shell, firstName) {
      await loadProjects();
      showProjects(shell);
      if (typeof shell.resetWizard === 'function') shell.resetWizard();
      if (typeof shell.setWorkspaceMode === 'function') shell.setWorkspaceMode('chat');
      const found = firstName ? (projects || []).find((p) => p.name === firstName) : null;
      if (found) shell.navigate(routeHash({ view: 'conversation', resourceId: found.id }));
    }

    /**
     * Workflow A (#3114): a standalone single-session workspace project,
     * created fresh (`POST /api/projects`) or attached from an existing
     * path (`POST /api/projects/attach`).
     * @param {{name: string, engine: string, path: string}} form
     */
    async function createWorkspaceProject(form) {
      const shell = getShell();
      if (!shell) return;
      const name = String((form && form.name) || '').trim();
      const path = String((form && form.path) || '').trim();
      const engine = (form && form.engine) || 'claude';
      const res = path
        ? await apiMutate('/api/projects/attach', 'POST', { name, path })
        : await apiMutate('/api/projects', 'POST', { name, engine });
      if (!res) {
        if (typeof shell.setWizardStatus === 'function') {
          shell.setWizardStatus({ kind: 'error', message: `Not created: ${api.lastError || 'the server refused it'}` });
        }
        return;
      }
      await afterWizardAction(shell, name);
    }

    /**
     * Workflow B (#3114): rename the existing standalone project to
     * `<FleetName>-<its role>` and provision one new project per
     * additional role seat, named `<FleetName>-<Role>` (lettered when more
     * than one of a role), so every seat shares one dash-prefix and
     * {@link synthesizeTreeFromProjects} groups them as a fleet.
     * @param {{sourceId: string, roleForSource: string, fleetName: string,
     *   engine: string, roles: Record<string, number>}} form
     */
    async function convertToFleet(form) {
      const shell = getShell();
      if (!shell) return;
      const fleetName = String(form.fleetName || '').trim();
      const sourceProject = (projects || []).find((p) => String(p.id) === String(form.sourceId));
      if (!sourceProject) {
        if (typeof shell.setWizardStatus === 'function') {
          shell.setWizardStatus({ kind: 'error', message: 'Not converted: that source workspace is no longer on the list.' });
        }
        return;
      }
      const sourceRole = String(form.roleForSource || 'PM').trim() || 'PM';
      const sourceNewName = `${fleetName}-${sourceRole}`;
      const renamed = await apiMutate(`/api/projects/${encodeURIComponent(sourceProject.name)}`, 'PATCH', { name: sourceNewName });
      if (!renamed) {
        if (typeof shell.setWizardStatus === 'function') {
          shell.setWizardStatus({ kind: 'error', message: `Not converted: ${api.lastError || 'the rename was refused'}` });
        }
        return;
      }
      const engine = form.engine || 'claude';
      const roles = form.roles && typeof form.roles === 'object' ? form.roles : {};
      const warnings = [];
      for (const role of Object.keys(roles)) {
        const count = Number(roles[role]) || 0;
        for (let i = 0; i < count; i++) {
          const seatName = count > 1 ? `${fleetName}-${role}-${wizardLetterSuffix(i)}` : `${fleetName}-${role}`;
          // Sequential on purpose: a batch of sibling POSTs would race the
          // same projects-dir scaffold and each other's directory creation.
          const created = await apiMutate('/api/projects', 'POST', { name: seatName, engine }); // eslint-disable-line no-await-in-loop
          if (!created) warnings.push(`${seatName}: ${api.lastError || 'the server refused it'}`);
        }
      }
      if (warnings.length && typeof shell.setWizardStatus === 'function') {
        shell.setWizardStatus({ kind: 'warning', message: `Converted, but some seats failed: ${warnings.join('; ')}` });
      }
      await afterWizardAction(shell, sourceNewName);
    }

    /**
     * Workflow C (#3114): create one real project per seat in the
     * already-fetched plan — both immediate and deferred, since a seat's
     * project row exists from the start regardless of when its session
     * first starts — named `<FleetName>-<Role>` (lettered when more than
     * one of a role shares the fleet).
     * @param {{templateId: string, plan: {immediateSeats: Array<object>,
     *   deferredSeats: Array<object>}, fleetName: string, engine: string}} args
     */
    async function provisionFleet(args) {
      const shell = getShell();
      if (!shell) return;
      const a = args || {};
      const fleetName = String(a.fleetName || '').trim();
      const engine = a.engine || 'claude';
      const seats = [].concat((a.plan && a.plan.immediateSeats) || [], (a.plan && a.plan.deferredSeats) || []);
      const byRole = new Map();
      seats.forEach((s) => { const r = s && s.role; byRole.set(r, (byRole.get(r) || 0) + 1); });
      const seenCount = new Map();
      const warnings = [];
      let firstName = null;
      for (const seat of seats) {
        const role = seat && seat.role;
        const total = byRole.get(role) || 1;
        const i = seenCount.get(role) || 0;
        seenCount.set(role, i + 1);
        const seatName = total > 1 ? `${fleetName}-${role}-${wizardLetterSuffix(i)}` : `${fleetName}-${role}`;
        if (!firstName) firstName = seatName;
        const created = await apiMutate('/api/projects', 'POST', { name: seatName, engine }); // eslint-disable-line no-await-in-loop
        if (!created) warnings.push(`${seatName}: ${api.lastError || 'the server refused it'}`);
      }
      if (warnings.length && typeof shell.setWizardStatus === 'function') {
        shell.setWizardStatus({ kind: 'warning', message: `Provisioned, but some seats failed: ${warnings.join('; ')}` });
      }
      await afterWizardAction(shell, firstName);
    }

    /**
     * Where entering the v6 shell fresh lands (#3154): the generic Fleet &
     * Workspace Overview, never a specific project — `#/projects/ariadne`
     * used to win every time simply because "Ariadne" sorted first. The
     * Overview screen itself handles an empty workspace gracefully (its
     * own "No projects yet"), so there is no separate settings fallback
     * to keep. `ui.js`'s own click handler checks the sidebar's currently
     * selected fleet FIRST and prefers that over this when one is set.
     * @returns {Promise<string>}
     */
    async function enterHash() {
      if (!projects) await loadProjects();
      return routeHash({ view: 'overview' });
    }

    /**
     * Ask `GET /api/v6/unfurl` for one link's rich preview (#3107). Never
     * triggered automatically — only from the shell's own Preview-button
     * click handler ({@link wireRichPreviews}), per Ruling A752 (an
     * external host is never dereferenced just because the chat drew the
     * message). The shell already shows "Loading…" the moment the click
     * happened; this only ever needs to report `'done'` or `'error'`.
     * @param {string} url
     * @returns {Promise<void>}
     */
    async function requestUnfurl(url) {
      const shell = getShell();
      if (!shell || typeof url !== 'string' || !url || typeof shell.setUnfurl !== 'function') return;
      const res = await api(`/api/v6/unfurl?url=${encodeURIComponent(url)}`);
      if (res && res.ok && res.preview) shell.setUnfurl(url, { state: 'done', preview: res.preview });
      else shell.setUnfurl(url, { state: 'error' });
    }

    /**
     * Ask `GET /api/v6/fleet-templates/bundled-specs` for the 2 bundled
     * reference `.fleet.json` specs and the ecosystem directory link
     * (#3115), on the Fleet Spec tab's own lazy-load entry.
     * @returns {Promise<void>}
     */
    async function loadBundledFleetSpecs() {
      const shell = getShell();
      if (!shell || typeof shell.setBundledFleetSpecs !== 'function') return;
      const res = await api('/api/v6/fleet-templates/bundled-specs');
      if (res && res.specs) shell.setBundledFleetSpecs({ specs: res.specs, ecosystemDirectory: res.ecosystemDirectory });
    }

    /**
     * Ask `POST /api/v6/fleet-templates/validate-spec` for a dry-run
     * preview of a pasted/edited `.fleet.json` spec (#3115), before
     * anything is created.
     * @param {*} spec
     * @returns {Promise<void>}
     */
    async function requestValidateFleetSpec(spec) {
      const shell = getShell();
      if (!shell || typeof shell.setWizardFleetSpecPreview !== 'function') return;
      const res = await apiMutate('/api/v6/fleet-templates/validate-spec', 'POST', { spec });
      shell.setWizardFleetSpecPreview(res || { ok: false, errors: [{ path: '', message: api.lastError || 'the server refused it' }] });
    }

    /**
     * Ask `POST /api/v6/fleet-templates/apply-spec` to actually provision
     * the fleet a validated `.fleet.json` spec describes (#3115), then
     * navigate to its first created seat the same way Workflow C's
     * {@link provisionFleet} does.
     * @param {{spec: object, fleetName: string}} args
     * @returns {Promise<void>}
     */
    async function applyFleetSpec(args) {
      const shell = getShell();
      if (!shell) return;
      const res = await apiMutate('/api/v6/fleet-templates/apply-spec', 'POST', { spec: args.spec, fleetName: args.fleetName });
      if (!res || !res.ok) {
        if (typeof shell.setWizardStatus === 'function') {
          shell.setWizardStatus({ kind: 'error', message: `Not provisioned: ${api.lastError || 'the server refused it'}` });
        }
        return;
      }
      if (res.failed && res.failed.length && typeof shell.setWizardStatus === 'function') {
        shell.setWizardStatus({ kind: 'warning', message: `Provisioned, but some seats failed: ${res.failed.map((f) => f.name).join(', ')}` });
      }
      await afterWizardAction(shell, res.created && res.created[0] && res.created[0].name);
    }

    /**
     * Ask `GET /api/v6/projects/:id/fleet-spec` to export an existing
     * standalone workspace as a portable `.fleet.json` (#3115).
     * @param {{projectId: string}} args - `projectId` is the export
     *   dropdown's own value — the project's numeric id (`seatId`), the
     *   same convention `convertToFleet`'s source dropdown already uses.
     * @returns {Promise<void>}
     */
    /**
     * @param {{projectId: string, members?: string[]}} args - `projectId` and
     *   each of `members` are the export picker's own values — numeric
     *   seat ids (#3115, PRR-A R1 C2: `exportableFleetsNow`'s
     *   `memberSeatIds`), not names; the route's own `?members=` wants
     *   names, resolved here from `projects`.
     */
    async function exportFleetSpec(args) {
      const shell = getShell();
      if (!shell || typeof shell.setWizardFleetSpecExport !== 'function') return;
      const row = (projects || []).find((p) => String(p.id) === String(args.projectId));
      if (!row) return shell.setWizardFleetSpecExport({ ok: false });
      const memberIds = Array.isArray(args.members) && args.members.length ? args.members : [args.projectId];
      const memberNames = memberIds.map((id) => {
        const m = (projects || []).find((p) => String(p.id) === String(id));
        return m ? m.name : null;
      }).filter(Boolean);
      const qs = memberNames.length ? `?members=${encodeURIComponent(memberNames.join(','))}` : '';
      const res = await api(`/api/v6/projects/${encodeURIComponent(row.id)}/fleet-spec${qs}`);
      shell.setWizardFleetSpecExport(res || { ok: false });
    }

    return {
      handleRoute, launchTemplate, enterHash, sendChat, changeDelegate, refresh, attachFiles, removeAttachment,
      startSession, startFleet, treeLinkClicked, renameProject, changeEngine, loadHistory, openHistorySession,
      viewOfflineHistory, returnToStartCard,
      createWorkspaceProject, convertToFleet, provisionFleet, requestUnfurl,
      loadBundledFleetSpecs, requestValidateFleetSpec, applyFleetSpec, exportFleetSpec,
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
   *   sessionStorage?: {getItem: Function, setItem: Function}|null,
   *   onSendChat?: (text: string) => void, onChangeDelegate?: (nodeId: string, projectId: string) => void,
   *   onRefreshChat?: () => void, onOpenProjectSettings?: (projectName: string) => void,
   *   onChangeEngine?: (projectName: string, engine: string) => void,
   *   onAttachFiles?: (files: Array<object>) => void, onRemoveAttachment?: (index: number) => void,
   *   onStartSession?: (projectName?: string) => void, onStartFleet?: () => void, onTreeLinkClick?: (hash: string) => void,
   *   onRenameProject?: (oldName: string, newName: string, opts?: {confirmOrphanRisk: boolean}) => void,
   *   onHistoryLoad?: (form: {scope: string, kind: string, q: string}) => void,
   *   onHistoryOpenSession?: (pick: {member: string, sid: string, q: string, kind: string}) => void,
   *   onViewOfflineHistory?: (projectName: string) => void,
   *   onReturnToStartCard?: (projectName: string) => void,
   *   onHoodCommand?: (name: string, body: {command: string, enter: true}|{rawKey: string}) => void,
   *   now?: () => number, setInterval?: (fn: Function, ms: number) => *, clearInterval?: (id: *) => void,
   *   requestAnimationFrame?: (fn: Function) => *, fetch?: Function}} opts - `onHoodCommand` is
   *   Under the Hood's Interactive CLI Mode (#3135): literal typed text (with Enter) or one of the
   *   named raw tmux keys, POSTed to `/api/sessions/:project/command` the same shape either way —
   *   the page wires it directly, same as `onRenameProject` above, not through `onSendChat` (which
   *   records a conversation message; typing into the live pane is not that). Until the page wires
   *   it (planned for Wave 2), its fallback reuses `onSendChat` for literal text and a direct
   *   `fetch` (this option, or the page's own) for a raw key — see `sendHoodCommand`. `storage`
   *   remembers the sidebar layout (#3046); defaults to the page's `localStorage`,
   *   and `null` keeps it for this page only. `sessionStorage` is the #3204 tab-scoped
   *   equivalent, for the fleet filter specifically; defaults to the page's own
   *   `window.sessionStorage`. The `on*Chat`/delegate/settings
   *   callbacks are the chat view's controls (#3047). `now` and the interval pair
   *   drive the busy line's elapsed time (#3057); they default to the page's.
   *   `onViewOfflineHistory` is the offline startup hero's own "View Previous
   *   Conversation" button (#3203), and `onReturnToStartCard` its history view's
   *   own "Return to Start Card" button (#3203 R2) — until the page wires
   *   each, that one button has no effect (every other hero/history-bar
   *   action reuses the already-wired `onStartSession`/`onOpenProjectSettings`,
   *   so they work unchanged).
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
    // #3114: the Wizard's own state, entirely separate from `detail` — the
    // active chat survives switching to 🧙 Wizard and back, since nothing
    // here ever calls setDetail.
    let wizardTab = 'templates';
    let wizardForm = { standalone: {}, convert: {}, templates: {}, fleetSpec: {} };
    let wizardTemplateId = null;
    let wizardPlan = null;
    let wizardStatus = null;
    // #3115: the Import/Export .fleet.json tab's own state — the bundled
    // reference specs (lazy-loaded the same way Wizard templates are),
    // a validated import preview, and an export result. All separate
    // from wizardPlan/wizardTemplateId, which are Workflow C's own.
    let bundledFleetSpecs = options.bundledFleetSpecs || null;
    let wizardFleetSpecPreview = null;
    let wizardFleetSpecExport = null;
    let attestation = options.attestation || null;
    let detail = options.detail || null;
    const showWatermark = options.showWatermark !== false;
    let currentRoute = { view: null };
    let drawerOpen = false;
    const prefs = makePrefs(options.storage !== undefined ? options.storage : defaultStorage(win));
    // #3204: tab-scoped navigation filter state (the fleet picker) --
    // `sessionStorage`, not `localStorage`, so two browser tabs open on
    // different fleets never read back each other's last-written filter.
    // Separate makePrefs instance, same injectable-storage shape as `prefs`
    // (`options.sessionStorage` for tests).
    const tabPrefs = makePrefs(options.sessionStorage !== undefined ? options.sessionStorage : defaultSessionStorage(win));
    let sidebarCollapsed = prefs.get('tc_v6_sidebar_collapsed', false, isBoolean);
    // #3133: drag-resizable width, independent of collapse (which still wins
    // when both apply — see applySidebarWidthStyle).
    let sidebarWidth = clampSidebarWidth(prefs.get('tc_v6_sidebar_width', V6_SIDEBAR_DEFAULT_WIDTH, isFiniteNumber));
    let collapsedNodes = new Set(prefs.get('tc_v6_collapsed_nodes', [], isStringArray));
    let projectRows = new Map();
    // Engine id -> {status}, from /api/models/status, for the sidebar badges (#3053).
    let engineHealth = {};
    let filterText = '';
    let filterEngine = '';
    let selectedGroups = new Set(tabPrefs.get('tc_v6_selected_groups', [], isStringArray));
    // #3068: whether the search and engine filters show. They can only be
    // set while it is open, and closing clears them, so a filter in force is
    // never out of sight.
    let searchToggled = false;
    // The tree as last rendered, filters applied: the fold toggles' positional
    // ids were generated from it, so they are wired from it too.
    let shownTree = [];
    // Unsent composer text per target project, so text meant for one agent
    // never appears in, and is never sent from, another one's chat. #3133:
    // seeded from storage (so a reload doesn't drop an in-progress draft),
    // pruned of any oversized leftover on the way in — see persistChatDrafts.
    const chatDrafts = new Map(Object.entries(pruneStaleChatDrafts(prefs.get('tc_v6_chat_drafts', {}, isStringMap))));
    // #3052: whether the raw-output drawer is open, kept across re-renders,
    // polls and visits; and which chat was last scrolled to its bottom, so a
    // chat opens at its newest line once and is then left where the operator puts it.
    let chatHoodOpen = prefs.get('tc_v6_chat_under_hood_open', false, isBoolean);
    // #3135: Under the Hood's own Full-Screen toggle and Interactive CLI
    // Mode — view-only state, never persisted, so a reload always starts
    // with neither; what the operator typed into Interactive Mode but has
    // not yet sent (Enter flushes it, as literal text, same shape as the
    // composer's own send).
    let hoodFullScreen = false;
    let hoodInteractive = false;
    let hoodBuffer = '';
    // #3082: which switchboard-triggered replies the chat shows, kept across visits.
    let verbosity = Object.assign({}, prefs.get('tc_v6_chat_verbosity', VERBOSITY_DEFAULT, isVerbosity));
    // #3191: Medusa/fleet chatter tucked away by default, kept across visits.
    let hideHoodTraffic = prefs.get('tc_v6_chat_hide_hood_traffic', true, (x) => typeof x === 'boolean');
    // #3139: global — off by default (Ruling A752's click-to-reveal stays
    // the floor) — whether a chat link auto-unfurls instead of waiting for
    // its own "👁 Preview" click.
    let autoPreview = prefs.get('tc_v6_auto_preview_links', false, isBoolean);
    // The workspace mode (#3086): Chat on each route, until the operator picks another.
    let workspaceMode = 'chat';
    // The route the mode was last reset on; a different one resets it to Chat.
    let lastModeRouteKey;
    // Each data mode's panel content, and the controller's loader for it (#3086).
    const workspacePanels = new Map();
    let workspaceLoader = null;
    // The train launch's drafts, outcome and the controller's actions (#3088).
    const train = { cars: '', fleet: '', pending: false, status: null, result: '' };
    let trainActions = null;

    /** @param {string} mode @returns {string} A data mode's whole panel, train controls included. */
    function panelMarkupNow(mode) {
      return workspacePanelMarkup(mode, workspacePanels.get(mode), mode === 'charter' ? trainControlsMarkup(train) : '');
    }

    /** Repaint only the train launch's outcome, so the cars box keeps its text and focus. */
    function paintTrainOutcome() {
      const outcome = doc.getElementById('v6TrainOutcome');
      if (outcome) outcome.innerHTML = trainOutcomeMarkup(train);
      ['v6TrainComputeWaves', 'v6TrainValidate', 'v6TrainStartRun'].forEach((id) => {
        const btn = doc.getElementById(id);
        if (btn) btn.disabled = train.pending;
      });
    }

    /**
     * Run one train launch action (#3088): read the cars list, show what is
     * happening, and show the escaped outcome. A list that does not read, a
     * missing fleet id, or an action already on its way stops it here.
     * @param {('computeWaves'|'checkDisjointness'|'startRun')} name
     * @returns {Promise<void>}
     */
    async function runTrain(name) {
      if (train.pending || !trainActions || typeof trainActions[name] !== 'function') return;
      const parsed = parseTrainCars(train.cars);
      if (!parsed.ok) {
        train.status = { kind: 'error', message: `Not sent: ${parsed.error}.` };
        paintTrainOutcome();
        return;
      }
      if (name === 'startRun' && !train.fleet.trim()) {
        train.status = { kind: 'error', message: 'Not sent: a wave run needs a fleet id.' };
        paintTrainOutcome();
        return;
      }
      await runTrainAction(() => trainActions[name](parsed.cars, train.fleet.trim()), 'Working…', 'Done.');
    }

    /**
     * Run one train launch or charter action (#3088): show it on its way with
     * the buttons disabled, then its escaped outcome; one that throws ends as
     * the error line.
     * @param {function(): Promise<{ok: boolean, message?: string, html?: string}>} act
     * @param {string} pendingMessage
     * @param {string} doneMessage - Shown when a successful action names nothing.
     * @returns {Promise<void>}
     */
    async function runTrainAction(act, pendingMessage, doneMessage) {
      train.pending = true;
      train.status = { kind: 'pending', message: pendingMessage };
      paintTrainOutcome();
      let out;
      try {
        out = await act();
      } catch (err) { // prawduct:allow prawduct/broad-except -- an action that throws must end as the operator's error line, not leave the buttons disabled
        out = { ok: false, message: (err && err.message) || 'it failed' };
      }
      const o = out || {};
      train.pending = false;
      train.status = { kind: o.ok ? 'ok' : 'error', message: String(o.message || (o.ok ? doneMessage : 'It failed.')) };
      train.result = typeof o.html === 'string' ? o.html : '';
      paintTrainOutcome();
    }

    /**
     * Wire the data panel's controls after it is painted (#3088): the train
     * launch box and buttons, and each charter version's Activate button.
     * @param {string} mode
     */
    function wireWorkspacePanel(mode) {
      if (mode !== 'charter') return;
      const cars = doc.getElementById('v6TrainCars');
      if (cars) cars.addEventListener('input', () => { train.cars = String(cars.value || ''); });
      const fleet = doc.getElementById('v6TrainFleet');
      if (fleet) fleet.addEventListener('input', () => { train.fleet = String(fleet.value || ''); });
      [['v6TrainComputeWaves', 'computeWaves'], ['v6TrainValidate', 'checkDisjointness'], ['v6TrainStartRun', 'startRun']].forEach(([id, name]) => {
        const btn = doc.getElementById(id);
        if (btn) btn.addEventListener('click', () => { runTrain(name); });
      });
      // Each listed version's Activate button, found by its id in the panel content (#3088).
      const content = workspacePanels.get('charter') || '';
      for (const m of content.matchAll(/id="v6CharterActivate-(\d+)"[^>]*data-version-number="([^"]*)"/g)) {
        const btn = doc.getElementById(`v6CharterActivate-${m[1]}`);
        if (!btn) continue;
        btn.addEventListener('click', () => {
          if (train.pending || !trainActions || typeof trainActions.activateVersion !== 'function') return;
          runTrainAction(() => trainActions.activateVersion(Number(m[1]), m[2]), 'Activating…', 'Activated.');
        });
      }
    }

    /** Ask the controller's loader for a data mode's panel (#3086); callers pass only data modes. */
    function loadWorkspacePanel(mode) {
      if (typeof workspaceLoader === 'function') workspaceLoader(mode);
    }

    /**
     * Hide the chat's header docked in the top bar (A764) while the mode
     * hides the chat, so its Start, delegate and rename buttons never act on
     * a chat the operator cannot see (#3086); show it again on Chat.
     */
    function syncDockedHeader() {
      if (typeof doc.querySelector !== 'function') return;
      const bar = doc.querySelector('.dash-bar');
      const header = bar && typeof bar.querySelector === 'function' ? bar.querySelector('.v6-chat-header') : null;
      if (header) header.hidden = !workspaceVisibility(workspaceMode, Boolean(detail && detail.kind === 'conversation')).detail;
    }

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
        panel.innerHTML = panelMarkupNow(mode);
        panel.setAttribute('aria-labelledby', `v6WorkspaceMode-${mode}`);
        wireWorkspacePanel(mode);
        loadWorkspacePanel(mode);
      }
      // #3114 (PRR-A R1 C2a): the Wizard has no #v6WorkspacePanel of its own
      // (shown.panel is false for it), so the generic load-above never runs
      // for it — but its template list still depends on the same one-time
      // /api/v6/fleet-templates fetch handleRoute's startup waterfall makes.
      // If that fetch never landed (an aborted overlapping navigation, or a
      // transient failure before the operator ever opened the Wizard tab),
      // ask the loader again on entry rather than leaving templates empty.
      if (mode === 'wizard' && !templates.length) loadWorkspacePanel('wizard');
      syncDockedHeader();
      pinIfPinned();
      const target = opts && opts.focus ? doc.getElementById(opts.focus) : null;
      if (target && typeof target.focus === 'function') target.focus();
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
    // #3105 (PRR-A R1 C3): each chat's "Your ToDo" dismissals, by item
    // text — a per-item ✕ removes one, Clear dismisses every item shown
    // at once; the same still-latest reply keeps whichever stay dismissed.
    const dismissedTodoItems = new Map();
    // #3131: each chat's Fleet-Member dismissals, by the outstanding send's
    // `target::text` key — a new send to the same target clears it, same
    // shape as {@link dismissedTodoItems}.
    const dismissedFleetTargets = new Map();
    // #3131: each chat's folded/unfolded Waiting-on sections ('you', 'ai',
    // `fleet:<target>`). #3133 PRR-B R1 BLOCKING 1b: persisted, unlike the
    // dismissal maps above (which stay in-memory on purpose) — a fold is a
    // durable layout preference the operator sets once per chat, not a
    // one-shot dismissal of a specific send.
    const waitingOnCollapsed = new Map(Object.entries(prefs.get('tc_v6_waiting_on_collapsed', {}, isStringArrayMap)));
    // #3105: each chat's AI queue — prompts submitted while busy, surfaced
    // in Waiting on: AI to be Forced or dismissed by hand. Never fired
    // automatically (PRR-A R1 C2): that would bypass the Force-Send gate
    // the moment the chat goes idle, defeating the point of showing it.
    const chatQueues = new Map();
    let queueSeq = 0;
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
    // #3132: the automated CLI usage probe's own last snapshot and
    // configured refresh cadence — separate from the manual calibration
    // table above, which `usage`/`usageStatus`/`usageActions` still own.
    let usageProbe = null;
    let usageProbeInterval = '30m';
    let usageProbeActions = null;
    // The chat whose Start fleet button has been clicked once (#3053).
    let fleetArmedKey = null;
    // The chat whose rename form is open (#3071), the name typed into it
    // (kept across a refusal), and the server's orphan-risk warning if it
    // asked for confirmation.
    let renameOpenKey = null;
    let renameDraft = null;
    let renameWarning = null;
    // #3136: the sidebar's OWN inline rename — a different form than the
    // chat header's above, open against a tree node key (a member's `m:
    // <seatId>` or a fleet's `p:<projectId>`) rather than the open chat, so
    // any row can be renamed without opening its chat first.
    let sidebarRenameKey = null;
    let sidebarRenameDraft = null;
    let sidebarRenameWarning = null;
    // #3136: `options.onRenameProject`'s result always lands on
    // `renameResult` below, whoever asked — this says which state it
    // belongs to right now: the chat header's own form, the sidebar's
    // single-row form, or one leg of a fleet's bulk rename (settled via
    // `fleetRenameWait`, never rendered).
    let renameResultFor = 'header';
    let fleetRenameWait = null;
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
    // #3135: whether #v6ChatStream follows new lines (the default, reset
    // the instant a DIFFERENT chat opens — restoreViewState's own
    // `first`) or stays where the operator scrolled it; only their own
    // upward scroll (the 'scroll' listener wireStreamPin wires) ever
    // turns this off, never a poll or a redraw.
    let streamPinned = true;
    // #3191: the Under the Hood group's own follow-bottom state —
    // #v6ChatPeek, #v6ChatSwitchboard, #v6ChatTucked and #v6ChatUnderHood
    // itself all pin or unpin together, off the SAME upward-scroll-only
    // tracking `wireStreamPin`'s own listener uses for `streamPinned`,
    // replacing the old one-shot `isAtBottom(peekEl)` check (which read
    // false whenever the drawer was closed or had just been resized, even
    // though the operator never scrolled it).
    let peekPinned = true;
    let lastStreamScrollTop = 0;
    let lastPeekScrollTop = 0;
    // #3200: this render's own `createChatScrollCoordinator()` handle —
    // disconnected and replaced every time `wireChatScrollCoordinator` runs
    // again (every render, via `wireControls`), since the `ResizeObserver`
    // it may hold watches the CURRENT #v6ChatStream node, a brand new DOM
    // node each time (`render` is a full `root.innerHTML = …` replace).
    let chatScrollCoordinator = null;
    const raf = typeof options.requestAnimationFrame === 'function' ? options.requestAnimationFrame
      : (win && typeof win.requestAnimationFrame === 'function' ? (fn) => win.requestAnimationFrame(fn) : null);
    // #3106/#3152: persist the composer's and Under the Hood's own
    // drag-resized heights (the chat stream no longer has one of its own —
    // see `.v6-chat-stream`'s doc comment in `style.css`, #3156 — it fills
    // whatever either of these leaves through ordinary flex layout, no JS
    // needed for that direction). Reattached to the fresh elements each render.
    let composerInputResizeObserver = null;
    let composerHoodResizeObserver = null;
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
      if (workspaceVisibility(workspaceMode, Boolean(detail && detail.kind === 'conversation')).panel) wireWorkspacePanel(workspaceMode);
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
      if (toggle) toggle.addEventListener('click', () => { toggleDrawer(); focusById('v6ShellDrawerClose'); });
      const sidebar = doc.getElementById('v6ShellSidebar');
      if (sidebar) {
        sidebar.addEventListener('keydown', (evt) => {
          if (evt && (evt.key === 'Escape' || evt.key === 'Esc')) { toggleDrawer(false); focusById('v6ShellDrawerToggle'); }
        });
      }
      // #3117: the mobile slide-over drawer's own close button and backdrop.
      const drawerClose = doc.getElementById('v6ShellDrawerClose');
      if (drawerClose) drawerClose.addEventListener('click', () => { toggleDrawer(false); focusById('v6ShellDrawerToggle'); });
      const backdrop = doc.getElementById('v6ShellDrawerBackdrop');
      if (backdrop) backdrop.addEventListener('click', () => { toggleDrawer(false); focusById('v6ShellDrawerToggle'); });
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
          // #3154: the main view follows the picker — All Fleets goes to
          // the generic Overview, a specific fleet navigates straight to
          // it, so the main pane never stays stuck on whatever it showed
          // before (Ariadne, or anything else).
          navigate(value ? routeHash({ view: 'project', projectId: value }) : routeHash({ view: 'overview' }));
        });
      }
      wireChat();
      wireUsage();
      wireStart();
      wireRename();
      wireSidebarRename();
      wireChatScrollCoordinator();
      wireTreeLinks();
      wireOverview();
      wireRichPreviews();
      wireSidebarResize();
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
      templates.forEach((t) => {
        const templateId = t && t.id;
        const button = templateId != null ? doc.getElementById(`v6ShellWizardLaunch-${templateId}`) : null;
        if (!button) return;
        button.addEventListener('click', () => {
          // #3114: picking a template only moves the Wizard's OWN state —
          // never `shell.setDetail`, which would clobber the active chat.
          wizardTemplateId = templateId;
          wizardPlan = null;
          wizardStatus = null;
          render();
          if (typeof options.onLaunchTemplate === 'function') options.onLaunchTemplate(templateId);
        });
      });
      wireWizard();
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
      // #3203: the offline hero's own Start button, its Retry Launch button
      // (same action — a retry is just starting again), and the compact
      // top/bottom bar's Start button once "View Previous Conversation" is
      // showing — all the same `options.onStartSession()` the header's own
      // small Start button already calls.
      [
        'v6ChatStart', 'v6ChatStartHero', 'v6ChatRetryLaunchHero',
        'v6ChatOfflineHistoryStartTop', 'v6ChatOfflineHistoryStartBottom'
      ].forEach((id) => {
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
          persistChatDrafts();
          render();
          focusById('v6ChatInput');
        });
      }
    }

    /**
     * Open the sidebar's one inline rename form (#3136) against a node key,
     * replacing any other sidebar row's open form.
     * @param {string} key - `projectNodeKey`/`m:<seatId>`.
     * @param {string} idSuffix - The row's own positional suffix, to focus its input.
     */
    function openSidebarRename(key, idSuffix) {
      sidebarRenameKey = key;
      sidebarRenameDraft = null;
      sidebarRenameWarning = null;
      render();
      focusById(`v6TreeRenameInput-${idSuffix}`);
    }

    /** Close the sidebar's rename form (#3136), whichever row it was open against. */
    function closeSidebarRename() {
      sidebarRenameKey = null;
      sidebarRenameDraft = null;
      sidebarRenameWarning = null;
      render();
    }

    /**
     * Rename every member of a fleet by giving each the SAME new shared
     * prefix in place of its old one (#3136) — there is no independently
     * stored fleet name to rewrite instead (#3022: the whole sidebar tree
     * is synthesized from project name prefixes), so this is what renaming
     * "the fleet" actually does. Sequential, one HTTP rename at a time
     * (same shape as {@link startFleet} on the live controller), through
     * the SAME `options.onRenameProject` a single member's own row already
     * uses — `renameResultFor`/`fleetRenameWait` turn its fire-and-forget,
     * single-result shape into something this can await leg by leg, with
     * no separate wiring into the page's bootstrap.
     *
     * Stops at the first member it cannot rename (orphan-risk or any other
     * server refusal) rather than guessing whether to force it: what
     * already succeeded stays renamed (there is no undo across several
     * independent project folders), and the one that needs a decision is
     * named so the operator can confirm it individually from its own row.
     * @param {Array<{name: string}>} members
     * @param {string} oldPrefix
     * @param {string} newPrefix
     * @returns {Promise<void>}
     */
    async function renameFleetMembers(members, oldPrefix, newPrefix) {
      if (typeof options.onRenameProject !== 'function') return;
      let renamedCount = 0;
      for (const m of members) {
        const newName = `${newPrefix}${m.name.slice(oldPrefix.length)}`;
        if (newName === m.name) { renamedCount += 1; continue; }
        // eslint-disable-next-line no-await-in-loop -- sequential by design, same as startFleet() above
        const result = await new Promise((resolve) => {
          renameResultFor = 'fleet';
          fleetRenameWait = resolve;
          options.onRenameProject(m.name, newName, undefined);
        });
        if (!result || !result.ok) {
          sidebarRenameWarning = `Renamed ${renamedCount} of ${members.length}. ${m.name} was not: `
            + `${(result && result.warning) || 'the server refused it'} — rename it from its own row.`;
          render();
          return;
        }
        renamedCount += 1;
      }
      closeSidebarRename();
    }

    /**
     * Wire one sidebar row's rename control (#3136) — the ✎/Escape/Cancel
     * chrome every row shares; what Save actually does is the caller's.
     * @param {string} idSuffix - The row's own positional suffix.
     * @param {string} key - Its node key, matched against `sidebarRenameKey`.
     * @param {string} currentName
     * @param {(draft: string, confirmOrphanRisk: boolean) => void} onSubmit
     */
    function wireOneSidebarRenameRow(idSuffix, key, currentName, onSubmit) {
      const btn = doc.getElementById(`v6TreeRename-${idSuffix}`);
      if (btn) btn.addEventListener('click', () => openSidebarRename(key, idSuffix));
      const input = doc.getElementById(`v6TreeRenameInput-${idSuffix}`);
      if (input) {
        input.addEventListener('keydown', (evt) => {
          if (evt && (evt.key === 'Escape' || evt.key === 'Esc')) closeSidebarRename();
        });
        input.addEventListener('input', (evt) => {
          sidebarRenameDraft = String((evt && evt.target && evt.target.value) || '');
          sidebarRenameWarning = null;
        });
      }
      const cancel = doc.getElementById(`v6TreeRenameCancel-${idSuffix}`);
      if (cancel) cancel.addEventListener('click', closeSidebarRename);
      const submit = (confirmOrphanRisk) => {
        const draft = String((sidebarRenameDraft != null ? sidebarRenameDraft : (input && input.value)) || '').trim();
        if (!draft || (!confirmOrphanRisk && draft === currentName)) { closeSidebarRename(); return; }
        sidebarRenameDraft = draft;
        onSubmit(draft, Boolean(confirmOrphanRisk));
      };
      const form = doc.getElementById(`v6TreeRenameForm-${idSuffix}`);
      if (form) {
        form.addEventListener('submit', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          submit(false);
        });
      }
      const confirm = doc.getElementById(`v6TreeRenameConfirm-${idSuffix}`);
      if (confirm) confirm.addEventListener('click', () => submit(true));
    }

    /**
     * Every sidebar row's rename control (#3136): a Fleet (a logical
     * project's own row, never the catch-all "Workspace Projects" one)
     * bulk-renames its members via {@link renameFleetMembers}; a Fleet
     * Member or Solo Work row (the same member row either way) renames
     * through the single-project route a chat header rename already uses.
     */
    function wireSidebarRename() {
      shownTree.forEach((project, pi) => {
        const isFleet = project.id !== WORKSPACE_PROJECT_ID;
        if (isFleet) {
          const pIdSuffix = `p${pi}`;
          const projectKey = projectNodeKey(project);
          wireOneSidebarRenameRow(pIdSuffix, projectKey, project.displayName, (draft) => {
            const members = project.fleets[0].members.map((m) => ({ name: m.role }));
            renameFleetMembers(members, project.displayName, draft);
          });
          const link = doc.getElementById(`v6TreeLink-p${pi}`);
          if (link) {
            link.addEventListener('dblclick', (evt) => {
              if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
              openSidebarRename(projectKey, pIdSuffix);
            });
          }
        }
        project.fleets.forEach((fleet, fi) => {
          fleet.members.forEach((m, mi) => {
            if (!m.seatId) return;
            const idSuffix = `m${pi}-${fi}-${mi}`;
            const memberKey = memberNodeKey(m);
            wireOneSidebarRenameRow(idSuffix, memberKey, m.role, (draft, confirmOrphanRisk) => {
              if (typeof options.onRenameProject !== 'function') return;
              renameResultFor = 'sidebar';
              options.onRenameProject(m.role, draft, confirmOrphanRisk ? { confirmOrphanRisk: true } : undefined);
            });
            const link = doc.getElementById(`v6TreeLink-m${pi}-${fi}-${mi}`);
            if (link) {
              link.addEventListener('dblclick', (evt) => {
                if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
                openSidebarRename(memberKey, idSuffix);
              });
            }
          });
        });
      });
    }

    /**
     * Show the "↓ Newest" pill (#3135) exactly while `streamPinned` is
     * false — a direct DOM toggle, not a render, since this runs off a
     * 'scroll' listener that can fire many times a second.
     */
    function paintStreamPinIndicator() {
      const pill = doc.getElementById('v6ChatJumpLatest');
      if (pill) pill.hidden = streamPinned;
    }

    /**
     * The chat stream's own follow-bottom state (#3135, refined #3191):
     * scrolling up turns `streamPinned` off, and scrolling back down near
     * the bottom (by hand, or via the pill below) turns it back on — never
     * a poll or a redraw either way. The pill itself jumps straight to the
     * newest line and re-pins.
     *
     * #3191: unpinning additionally requires `scrollTop` to have genuinely
     * DECREASED by more than a few pixels since the last 'scroll' event —
     * not just that the gap from the bottom is now large. A poll or an
     * async thumbnail/unfurl growing `scrollHeight` underneath a pane whose
     * `scrollTop` the operator never touched widens that gap on its own,
     * and the old distance-only check misread that as the operator having
     * scrolled away.
     */
    function wireStreamPin() {
      const streamEl = doc.getElementById('v6ChatStream');
      if (streamEl) {
        lastStreamScrollTop = streamEl.scrollTop;
        streamEl.addEventListener('scroll', () => {
          const distanceFromBottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight;
          if (distanceFromBottom <= 24) streamPinned = true;
          else if (streamEl.scrollTop < lastStreamScrollTop - 4) streamPinned = false;
          lastStreamScrollTop = streamEl.scrollTop;
          paintStreamPinIndicator();
        });
      }
      const pill = doc.getElementById('v6ChatJumpLatest');
      if (pill) {
        pill.addEventListener('click', () => {
          streamPinned = true;
          pinStream(streamEl);
          paintStreamPinIndicator();
        });
      }
    }

    /**
     * `pinToBottom(el)`, plus keeping `lastStreamScrollTop`/
     * `lastPeekScrollTop` in step with the jump it just made (#3191) — a
     * programmatic pin never fires the 'scroll' listener that otherwise
     * keeps either tracker current, so every OTHER caller that jumps one
     * of these two panes to its bottom must go through here, or the next
     * genuine scroll event compares against a stale baseline and reads a
     * real upward scroll as having gone nowhere (or the reverse).
     * @param {HTMLElement|null} el
     * @param {boolean} isPeek
     */
    function pinTracked(el, track) {
      pinToBottom(el);
      if (!el) return;
      if (track === 'peek') lastPeekScrollTop = el.scrollTop;
      else if (track === 'stream') lastStreamScrollTop = el.scrollTop;
    }

    /** `pinTracked` for `#v6ChatStream` specifically — the common case, named for readability at call sites. */
    function pinStream(el) { pinTracked(el, 'stream'); }

    /**
     * Pin `#v6ChatPeek`, `#v6ChatSwitchboard`, `#v6ChatTucked` and
     * `#v6ChatUnderHood` itself to their own bottom (#3191) — synchronously
     * and, since an unfurl card or a thumbnail can still be expanding one
     * of them after paint, once more on the next frame. Called only while
     * `peekPinned` is true; callers check that themselves so a caller that
     * also needs to know whether it ran doesn't have to re-check it here.
     * Only `#v6ChatPeek` is actually tracked for the upward-scroll-only
     * unpin check (it is the group's representative pane) — the other 3
     * get `pinToBottom` with no tracking at all, same as a plain
     * `pinToBottom` call would, since nothing reads a "last scroll" for them.
     */
    function pinPeekGroup() {
      const ids = ['v6ChatPeek', 'v6ChatSwitchboard', 'v6ChatTucked', 'v6ChatUnderHood'];
      ids.forEach((id) => pinTracked(doc.getElementById(id), id === 'v6ChatPeek' ? 'peek' : null));
      if (raf) {
        raf(() => {
          if (!peekPinned) return;
          ids.forEach((id) => pinTracked(doc.getElementById(id), id === 'v6ChatPeek' ? 'peek' : null));
        });
      }
    }

    /**
     * Re-pin whichever of `#v6ChatStream` and the Under the Hood group the
     * operator hasn't scrolled away from by hand (#3191) — called after
     * every targeted redraw that can grow one of them (never a poll or a
     * scroll event itself, which only ever change the two pinned flags).
     */
    function pinIfPinned() {
      if (streamPinned) {
        const stream = doc.getElementById('v6ChatStream');
        pinStream(stream);
        if (raf) raf(() => { if (streamPinned) pinStream(stream); });
      }
      if (peekPinned) pinPeekGroup();
    }

    /**
     * Re-arm `peekPinned` and jump the whole Under the Hood group back to
     * the bottom (#3191): wired to the drawer's own `toggle` (opening it
     * should always start at the newest line, never wherever it happened
     * to be scrolled before it closed) and to `#v6ChatHideHoodTraffic`
     * changing (revealing or hiding the fleet-chatter sections changes
     * each pane's content height outright).
     */
    function rearmPeekPin() {
      peekPinned = true;
      pinPeekGroup();
    }

    /**
     * The Under the Hood group's own follow-bottom state (#3191): the same
     * upward-scroll-only unpin {@link wireStreamPin} uses, tracked off
     * `#v6ChatPeek`'s own scroll as the group's representative pane, plus
     * the drawer's `toggle` event re-arming the whole group.
     */
    function wirePeekPin() {
      const peekEl = doc.getElementById('v6ChatPeek');
      if (peekEl) {
        lastPeekScrollTop = peekEl.scrollTop;
        peekEl.addEventListener('scroll', () => {
          const distanceFromBottom = peekEl.scrollHeight - peekEl.scrollTop - peekEl.clientHeight;
          if (distanceFromBottom <= 24) peekPinned = true;
          else if (peekEl.scrollTop < lastPeekScrollTop - 4) peekPinned = false;
          lastPeekScrollTop = peekEl.scrollTop;
        });
      }
      const hood = doc.getElementById('v6ChatUnderHood');
      if (hood) hood.addEventListener('toggle', rearmPeekPin);
    }

    /**
     * Wires this mounted shell's own scroll-position coordinator (#3200):
     * {@link createChatScrollCoordinator} (a pure, dependency-injected
     * factory — not a closure over any ONE shell's state, so it is
     * independently testable and exported as
     * `global.tcV6CreateChatScrollCoordinator`) handed THIS shell's own
     * `streamPinned`/`pinStream`/`wireStreamPin`/`wirePeekPin`. Called once
     * per render (via `wireControls`, since `render` fully replaces the
     * DOM — see `chatScrollCoordinator`'s own doc comment), so the
     * PREVIOUS render's coordinator (and the `ResizeObserver` it may have
     * attached to a now-detached `#v6ChatStream` node) is disconnected
     * first — a detached node's own observer would otherwise never fire
     * again, but would still leak.
     */
    function wireChatScrollCoordinator() {
      if (chatScrollCoordinator) { chatScrollCoordinator.disconnect(); chatScrollCoordinator = null; }
      chatScrollCoordinator = createChatScrollCoordinator({
        doc, win, raf,
        isStreamPinned: () => streamPinned,
        pinStream,
        lastStreamScrollTop: () => lastStreamScrollTop,
        wireStreamPin,
        wirePeekPin
      });
    }

    /**
     * Dispatch Under the Hood's Interactive CLI Mode (#3135): the page's
     * own `options.onHoodCommand`, when it wires one, is the one true
     * path. Until Wave 2 adds that 1-line callback to `public/ui.js` (PM
     * ruling on #3135 req 4), this falls back to what is already wired —
     * `options.onSendChat` for literal text (the same send the composer
     * uses, since `sendChat` always POSTs `{ command, enter: true }`
     * itself) — and, for a raw key, a direct `fetch` straight to the same
     * route, the one case nothing existing already reaches. Never thrown
     * on a failed fallback fetch: the pane just stays as it was, same as
     * any other send that did not land.
     * @param {string} name - The chat target's project name.
     * @param {{command: string, enter: true}|{rawKey: string}} body
     */
    function sendHoodCommand(name, body) {
      if (typeof options.onHoodCommand === 'function') { options.onHoodCommand(name, body); return; }
      if (body && typeof body.command === 'string') {
        if (typeof options.onSendChat === 'function') options.onSendChat(body.command);
        return;
      }
      const fetchImpl = typeof options.fetch === 'function' ? options.fetch
        : (typeof fetch === 'function' ? fetch : null);
      if (!fetchImpl || !body || typeof body.rawKey !== 'string') return;
      fetchImpl(`/api/sessions/${encodeURIComponent(name)}/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }).catch(() => {
        // prawduct:allow prawduct/broad-except -- a fallback raw-key send that fails leaves the live pane exactly as it was; nothing downstream depends on this outcome
      });
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
        renameResultFor = 'header';
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
      shownTree.forEach((project, pi) => {
        const report = (id, hash) => {
          const link = doc.getElementById(id);
          if (!link) return;
          link.addEventListener('click', () => {
            if (typeof options.onTreeLinkClick === 'function') options.onTreeLinkClick(hash);
            // #3117: picking anything in the mobile slide-over drawer
            // closes it so the selected conversation is visible right away.
            if (drawerOpen) toggleDrawer(false);
          });
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

    /**
     * The Overview screen's own per-row actions (#3154), wired by id the
     * same way {@link wireTreeLinks} wires the sidebar — not by
     * `querySelectorAll`, which this file's own `test/_mini-dom.js`
     * cannot walk past a flat id-only parse of `innerHTML`. Each row's id
     * is unique by seat id, so no render-order index is needed the way
     * the sidebar's `p${pi}-f${fi}-m${mi}` ones are.
     */
    function wireOverview() {
      if (!detail || detail.kind !== 'overview') return;
      const rows = Array.isArray(detail.view && detail.view.projects) ? detail.view.projects : [];
      const byId = (id) => rows.find((p) => p && String(p.id) === String(id)) || null;
      const tree = Array.isArray(detail.view && detail.view.tree) ? detail.view.tree : [];
      tree.forEach((lp) => {
        const fleetHash = routeHash({ view: 'project', projectId: lp.id });
        const fleetLink = doc.getElementById(`v6OverviewFleetLink-${lp.id}`);
        if (fleetLink) fleetLink.addEventListener('click', () => {
          if (typeof options.onTreeLinkClick === 'function') options.onTreeLinkClick(fleetHash);
        });
        (lp.fleets || []).flatMap((f) => f.members || []).forEach((m) => {
          const seatId = m.seatId;
          const row = byId(seatId);
          const name = (row && row.name) || m.role || '';
          const idSuffix = seatId;
          const memberHash = routeHash({ view: 'conversation', resourceId: seatId });
          ['v6OverviewMemberLink', 'v6OverviewOpenChat'].forEach((prefix) => {
            const link = doc.getElementById(`${prefix}-${idSuffix}`);
            if (link) link.addEventListener('click', () => {
              if (typeof options.onTreeLinkClick === 'function') options.onTreeLinkClick(memberHash);
            });
          });
          const start = doc.getElementById(`v6OverviewStart-${idSuffix}`);
          if (start && typeof options.onStartSession === 'function') {
            start.addEventListener('click', () => options.onStartSession(name));
          }
          const settings = doc.getElementById(`v6OverviewSettings-${idSuffix}`);
          if (settings && typeof options.onOpenProjectSettings === 'function') {
            settings.addEventListener('click', () => options.onOpenProjectSettings(name));
          }
          const engine = doc.getElementById(`v6OverviewEngine-${idSuffix}`);
          if (engine && typeof options.onChangeEngine === 'function') {
            engine.addEventListener('change', (evt) => {
              options.onChangeEngine(name, String((evt && evt.target && evt.target.value) || ''));
            });
          }
        });
      });
    }

    /**
     * The rich preview affordances a message can draw (#3107): a "Preview"
     * button asks for an external link's Open Graph card (never auto-
     * fetched, per Ruling A752), and a local-reference card's copy-path
     * button copies its path. Re-wired every render, the same as every
     * other per-element listener here, since `root.innerHTML` is reset
     * each time.
     */
    function wireRichPreviews() {
      if (typeof doc.querySelectorAll !== 'function') return;
      doc.querySelectorAll('.v6-chat-local-ref-copy').forEach((btn) => {
        btn.addEventListener('click', () => {
          const path = btn.getAttribute('data-copy-path');
          const clipboard = win && win.navigator && win.navigator.clipboard;
          if (!path || !clipboard || typeof clipboard.writeText !== 'function') return;
          clipboard.writeText(path).catch(() => {
            // prawduct:allow prawduct/broad-except -- a copy that fails leaves the path visible to copy by hand; it must never break the chat
          });
        });
      });
      doc.querySelectorAll('.v6-chat-unfurl-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const url = btn.getAttribute('data-unfurl-url');
          if (!url) return;
          setUnfurl(url, { state: 'loading' });
          if (typeof options.onUnfurlLink === 'function') options.onUnfurlLink(url);
        });
      });
      // #3139: "Show preview by default" fetches every link still showing
      // its own Preview button, instead of waiting for a click — and a
      // self-published link (PRR-B R1 BLOCKING 3b) always does, even with
      // that setting off, the same way `alwaysPreview` already exempts
      // these hosts server-side (`lib/v6/b2-conversation-layer.js#_pushReferenceCard`).
      // Each `setUnfurl` below re-enters this function (see its own body,
      // which calls `wireRichPreviews()` as part of its redraw), so this
      // needs no loop guard of its own: the next pass simply finds one
      // fewer still-unfetched link, until none remain.
      doc.querySelectorAll('.v6-chat-unfurl-btn').forEach((btn) => {
        const url = btn.getAttribute('data-unfurl-url');
        if (!url || !(autoPreview || isAlwaysPreviewLink(url))) return;
        const unfurls = unfurlsNow();
        if (unfurls && Object.prototype.hasOwnProperty.call(unfurls, url)) return;
        setUnfurl(url, { state: 'loading' });
        if (typeof options.onUnfurlLink === 'function') options.onUnfurlLink(url);
      });
    }

    /**
     * The Wizard panel's own controls (#3114): tab switching, live form
     * field tracking (so a re-render — a tab switch, a plan arriving —
     * never drops what the operator already typed), and the 3 workflow
     * submit actions. None of this ever calls `shell.setDetail`.
     */
    function wireWizard() {
      ['templates', 'standalone', 'convert', 'fleetSpec'].forEach((id) => {
        const btn = doc.getElementById(`v6WizardTab-${id}`);
        if (btn) {
          btn.addEventListener('click', () => {
            wizardTab = id; wizardStatus = null;
            // #3115: lazy-load the bundled specs on entry, the same pattern
            // #3114's Template tab already uses for its own templates list.
            if (id === 'fleetSpec' && !bundledFleetSpecs && typeof options.onLoadBundledFleetSpecs === 'function') {
              options.onLoadBundledFleetSpecs();
            }
            render();
          });
        }
      });
      const track = (fieldId, group, key) => {
        const el = doc.getElementById(fieldId);
        if (!el) return;
        const update = () => { wizardForm[group] = Object.assign({}, wizardForm[group], { [key]: el.value }); };
        // Both, not a tagName-based choice of one: a <select>/number input
        // fires 'change' (never a bare 'input' in every environment this
        // runs in), a text input fires 'input'; listening for both is a
        // harmless no-op for whichever one a given field never actually fires.
        el.addEventListener('input', update);
        el.addEventListener('change', update);
      };
      track('v6WizardStandaloneName', 'standalone', 'name');
      track('v6WizardStandaloneEngine', 'standalone', 'engine');
      track('v6WizardStandalonePath', 'standalone', 'path');
      track('v6WizardConvertSource', 'convert', 'sourceId');
      track('v6WizardConvertSourceRole', 'convert', 'roleForSource');
      track('v6WizardConvertFleetName', 'convert', 'fleetName');
      track('v6WizardConvertEngine', 'convert', 'engine');
      track('v6WizardFleetName', 'templates', 'fleetName');
      track('v6WizardFleetEngine', 'templates', 'engine');
      track('v6WizardFleetSpecJson', 'fleetSpec', 'json');
      track('v6WizardFleetSpecFleetName', 'fleetSpec', 'fleetName');
      track('v6WizardFleetSpecExportProject', 'fleetSpec', 'exportProjectId');
      WIZARD_FLEET_ROLES.forEach((role) => {
        const el = doc.getElementById(`v6WizardConvertRole-${role}`);
        if (!el) return;
        el.addEventListener('change', () => {
          const roles = Object.assign({}, wizardForm.convert.roles, { [role]: Number(el.value) || 0 });
          wizardForm.convert = Object.assign({}, wizardForm.convert, { roles });
        });
      });
      const standaloneForm = doc.getElementById('v6WizardStandaloneForm');
      if (standaloneForm) {
        standaloneForm.addEventListener('submit', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          const f = wizardForm.standalone || {};
          const name = String(f.name || '').trim();
          if (!name || !PROJECT_NAME_CHARS.test(name)) {
            wizardStatus = { kind: 'error', message: 'Project name is required and may only use letters, digits, spaces, dashes and underscores.' };
            render();
            return;
          }
          wizardStatus = { kind: 'pending', message: `Creating ${name}…` };
          render();
          if (typeof options.onCreateWorkspaceProject === 'function') {
            options.onCreateWorkspaceProject({ name, engine: f.engine || 'claude', path: String(f.path || '').trim() });
          }
        });
      }
      const convertForm = doc.getElementById('v6WizardConvertForm');
      if (convertForm) {
        convertForm.addEventListener('submit', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          const f = wizardForm.convert || {};
          const fleetName = String(f.fleetName || '').trim();
          if (!f.sourceId || !fleetName || !PROJECT_NAME_CHARS.test(fleetName)) {
            wizardStatus = { kind: 'error', message: 'Choose a source workspace and give the fleet a valid name.' };
            render();
            return;
          }
          // #3114 AC #3 (PRR-A R1 C2b): synthesizeTreeFromProjects needs 2+
          // members sharing a dash prefix to group as a fleet — 0 additional
          // seats would just rename the source and leave it standalone,
          // satisfying the letter of "convert" while missing the point.
          const seatTotal = Object.values(f.roles || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
          if (seatTotal < 1) {
            wizardStatus = { kind: 'error', message: 'Add at least one more seat — a fleet needs 2 or more members.' };
            render();
            return;
          }
          wizardStatus = { kind: 'pending', message: `Converting to ${fleetName}…` };
          render();
          if (typeof options.onConvertToFleet === 'function') {
            options.onConvertToFleet({
              sourceId: f.sourceId, roleForSource: String(f.roleForSource || 'PM').trim() || 'PM',
              fleetName, engine: f.engine || 'claude', roles: f.roles || {}
            });
          }
        });
      }
      const provisionForm = doc.getElementById('v6WizardProvisionForm');
      if (provisionForm) {
        provisionForm.addEventListener('submit', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          const f = wizardForm.templates || {};
          const fleetName = String(f.fleetName || '').trim();
          if (!fleetName || !PROJECT_NAME_CHARS.test(fleetName) || !wizardPlan) {
            wizardStatus = { kind: 'error', message: 'Give the fleet a valid name and wait for the plan to load.' };
            render();
            return;
          }
          wizardStatus = { kind: 'pending', message: `Provisioning ${fleetName}…` };
          render();
          if (typeof options.onProvisionFleet === 'function') {
            options.onProvisionFleet({ templateId: wizardTemplateId, plan: wizardPlan, fleetName, engine: f.engine || 'claude' });
          }
        });
      }
      // #3115: each bundled reference spec's "Use this template" button
      // pre-fills the import textarea — client-side, no fetch, since
      // bundledFleetSpecs is already loaded by this point.
      if (bundledFleetSpecs && bundledFleetSpecs.specs) {
        Object.keys(bundledFleetSpecs.specs).forEach((id) => {
          const btn = doc.getElementById(`v6WizardUseBundled-${id}`);
          if (!btn) return;
          btn.addEventListener('click', () => {
            wizardForm.fleetSpec = Object.assign({}, wizardForm.fleetSpec, {
              json: JSON.stringify(bundledFleetSpecs.specs[id], null, 2),
              fleetName: bundledFleetSpecs.specs[id].metadata.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim()
            });
            wizardFleetSpecPreview = null;
            render();
          });
        });
      }
      const fleetSpecImportForm = doc.getElementById('v6WizardFleetSpecImportForm');
      if (fleetSpecImportForm) {
        fleetSpecImportForm.addEventListener('submit', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          let parsed;
          try {
            parsed = JSON.parse(String((wizardForm.fleetSpec && wizardForm.fleetSpec.json) || ''));
          } catch {
            wizardFleetSpecPreview = { ok: false, errors: [{ path: '', message: 'Not valid JSON.' }] };
            render();
            return;
          }
          if (typeof options.onValidateFleetSpec === 'function') options.onValidateFleetSpec(parsed);
        });
      }
      const fleetSpecApplyBtn = doc.getElementById('v6WizardFleetSpecApplyBtn');
      if (fleetSpecApplyBtn) {
        fleetSpecApplyBtn.addEventListener('click', () => {
          const f = wizardForm.fleetSpec || {};
          const fleetName = String(f.fleetName || '').trim();
          if (!fleetName || !PROJECT_NAME_CHARS.test(fleetName) || !wizardFleetSpecPreview || !wizardFleetSpecPreview.ok) return;
          let parsed;
          try {
            parsed = JSON.parse(String(f.json || ''));
          } catch {
            return; // the Validate step already would have caught this; Apply is disabled until preview.ok anyway
          }
          wizardStatus = { kind: 'pending', message: `Provisioning ${fleetName}…` };
          render();
          if (typeof options.onApplyFleetSpec === 'function') options.onApplyFleetSpec({ spec: parsed, fleetName });
        });
      }
      const fleetSpecExportForm = doc.getElementById('v6WizardFleetSpecExportForm');
      if (fleetSpecExportForm) {
        fleetSpecExportForm.addEventListener('submit', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          const projectId = wizardForm.fleetSpec && wizardForm.fleetSpec.exportProjectId;
          if (!projectId) {
            wizardStatus = { kind: 'error', message: 'Choose a workspace or fleet to export.' };
            render();
            return;
          }
          // #3115 (PRR-A R1 C2): a multi-seat fleet's OTHER members never
          // reach the export route without this — exportableFleetsNow()
          // re-derived fresh at submit time, matched by the id the picker
          // actually offered as this option's value.
          const picked = exportableFleetsNow().find((fl) => String(fl.id) === String(projectId));
          const members = picked ? picked.memberSeatIds : [projectId];
          if (typeof options.onExportFleetSpec === 'function') options.onExportFleetSpec({ projectId, members });
        });
      }
    }

    /** The chat view's own controls (#3047), when the detail pane shows one. */
    function wireChat() {
      const input = doc.getElementById('v6ChatInput');
      if (input) {
        input.addEventListener('input', (evt) => {
          const key = chatTargetKey();
          if (key == null) return;
          chatDrafts.set(key, String((evt && evt.target && evt.target.value) || ''));
          persistChatDrafts();
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
      const autoPreviewBtn = doc.getElementById('v6ChatAutoPreview');
      if (autoPreviewBtn) {
        autoPreviewBtn.addEventListener('click', () => {
          autoPreview = !autoPreview;
          prefs.set('tc_v6_auto_preview_links', autoPreview);
          render();
        });
      }
      const form = doc.getElementById('v6ChatForm');
      if (form) {
        form.addEventListener('submit', (evt) => {
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          submitChat();
        });
      }
      wireAttachments();
      wireComposerResize();
      const hood = doc.getElementById('v6ChatUnderHood');
      if (hood) {
        hood.addEventListener('toggle', (evt) => {
          chatHoodOpen = Boolean(evt && evt.target && evt.target.open);
          prefs.set('tc_v6_chat_under_hood_open', chatHoodOpen);
        });
        // #3135: Escape closes Full Screen — UNLESS Interactive Mode just
        // consumed it as a raw key instead (that handler, below, stops the
        // event reaching here), since the live pane's own Escape takes
        // priority over the view while it is the thing with focus.
        hood.addEventListener('keydown', (evt) => {
          if (hoodFullScreen && evt && (evt.key === 'Escape' || evt.key === 'Esc')) {
            hoodFullScreen = false;
            render();
          }
        });
      }
      const hoodFullScreenBtn = doc.getElementById('v6ChatHoodFullScreen');
      if (hoodFullScreenBtn) {
        hoodFullScreenBtn.addEventListener('click', (evt) => {
          // Inside <summary>: stop a plain click from also toggling <details> open/closed.
          if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          hoodFullScreen = !hoodFullScreen;
          render();
        });
      }
      const hoodInteractiveBtn = doc.getElementById('v6ChatHoodInteractive');
      if (hoodInteractiveBtn) {
        hoodInteractiveBtn.addEventListener('click', (evt) => {
          if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          hoodInteractive = !hoodInteractive;
          hoodBuffer = '';
          render();
          if (hoodInteractive) focusById('v6ChatPeek');
        });
      }
      const peek = doc.getElementById('v6ChatPeek');
      if (peek) {
        // #3135: double-click activates it (the ✎-style "click to edit" a
        // button also offers); a SECOND double-click does nothing new —
        // there is no reason to leave it from the same gesture that enters it.
        peek.addEventListener('dblclick', () => {
          if (hoodInteractive) return;
          hoodInteractive = true;
          hoodBuffer = '';
          render();
          focusById('v6ChatPeek');
        });
        peek.addEventListener('keydown', (evt) => {
          if (!hoodInteractive) return;
          const project = detail && detail.kind === 'conversation' && detail.view ? detail.view.project : null;
          const name = project ? String(project.name || '') : '';
          const action = hoodKeyAction(evt, hoodBuffer);
          if (!action) return;
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
          if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
          if (action.type === 'buffer') { hoodBuffer = action.text; return; }
          if (!name) return;
          if (action.type === 'send') {
            hoodBuffer = '';
            sendHoodCommand(name, { command: action.text, enter: true });
            return;
          }
          sendHoodCommand(name, { rawKey: action.value });
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
      wireWaitingOn();
      wireMedusa();
      wireVerbosity();
      const refresh = doc.getElementById('v6ChatRefresh');
      if (refresh && typeof options.onRefreshChat === 'function') {
        refresh.addEventListener('click', () => {
          // #3113: a manual refresh means "take me to the latest," whether
          // or not the operator had scrolled up to read something older.
          scrolledChatKey = null;
          pinToBottom(doc.getElementById('v6ChatStream'));
          pinToBottom(doc.getElementById('v6ChatPeek'));
          options.onRefreshChat();
        });
      }
      const project = detail && detail.view ? detail.view.project : null;
      // #3203: the offline hero's own Edit Session Properties button, its
      // failure-panel copy, and the compact history bar's copy (top and
      // bottom) — all the same `options.onOpenProjectSettings(name)` the
      // header's own Settings button already calls.
      [
        'v6ChatSettings', 'v6ChatEditPropertiesHero',
        'v6ChatOfflineHistoryEditTop', 'v6ChatOfflineHistoryEditBottom'
      ].forEach((id) => {
        const settings = doc.getElementById(id);
        if (settings && project && typeof options.onOpenProjectSettings === 'function') {
          settings.addEventListener('click', () => options.onOpenProjectSettings(String(project.name || '')));
        }
      });
      // #3203: "View Previous Conversation" -- a fresh fetch each click
      // (never cached across chats), so no id array to dedupe against.
      const viewHistory = doc.getElementById('v6ChatViewHistoryHero');
      if (viewHistory && project && typeof options.onViewOfflineHistory === 'function') {
        viewHistory.addEventListener('click', () => options.onViewOfflineHistory(String(project.name || '')));
      }
      // #3203 R2: "Return to Start Card" -- top and bottom copies of the
      // compact history bar, same callback either way.
      ['v6ChatOfflineHistoryReturnTop', 'v6ChatOfflineHistoryReturnBottom'].forEach((id) => {
        const returnBtn = doc.getElementById(id);
        if (returnBtn && project && typeof options.onReturnToStartCard === 'function') {
          returnBtn.addEventListener('click', () => options.onReturnToStartCard(String(project.name || '')));
        }
      });
      // #3153: the inline engine picker — direct, no Settings modal needed.
      const engineSelect = doc.getElementById('v6ChatEngineSelect');
      if (engineSelect && project && typeof options.onChangeEngine === 'function') {
        engineSelect.addEventListener('change', (evt) => {
          options.onChangeEngine(String(project.name || ''), String((evt && evt.target && evt.target.value) || ''));
        });
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
     * @param {string|null} key - A chat target.
     * @returns {string[]} The "Your ToDo" item texts dismissed in that chat (#3105).
     */
    function dismissedTodoFor(key) {
      return key != null && dismissedTodoItems.has(key) ? dismissedTodoItems.get(key).slice() : [];
    }

    /**
     * Dismiss one or more "Your ToDo" items in the chat on screen by text
     * (#3105, PRR-A R1 C3) and redraw.
     * @param {string[]} texts
     */
    function dismissTodoItems(texts) {
      const key = chatTargetKey();
      if (key == null || !texts.length) return;
      const set = dismissedTodoItems.get(key) || [];
      texts.forEach((t) => { if (!set.includes(t)) set.push(t); });
      dismissedTodoItems.set(key, set);
      render();
    }

    /**
     * @param {string|null} key - A chat target.
     * @returns {string[]} The Fleet-Member send keys dismissed in that chat (#3131).
     */
    function dismissedFleetFor(key) {
      return key != null && dismissedFleetTargets.has(key) ? dismissedFleetTargets.get(key).slice() : [];
    }

    /**
     * Dismiss one or more outstanding Fleet-Member sends in the chat on
     * screen, by their `target::text` key (#3131), and redraw.
     * @param {string[]} keys
     */
    function dismissFleetTargets(keys) {
      const key = chatTargetKey();
      if (key == null || !keys.length) return;
      const set = dismissedFleetTargets.get(key) || [];
      keys.forEach((k) => { if (!set.includes(k)) set.push(k); });
      dismissedFleetTargets.set(key, set);
      render();
    }

    /**
     * @param {string|null} key - A chat target.
     * @returns {string[]} The Waiting-on section keys folded in that chat (#3131).
     */
    function collapsedWaitingOnFor(key) {
      return key != null && waitingOnCollapsed.has(key) ? waitingOnCollapsed.get(key).slice() : [];
    }

    /**
     * Fold or unfold one Waiting-on section ('you', 'ai', `fleet:<target>`)
     * in the chat on screen (#3131), remembered until the chat changes it
     * again — no full redraw, since this only toggles a disclosure.
     * @param {string} sectionKey
     */
    function toggleWaitingOnSection(sectionKey) {
      const key = chatTargetKey();
      if (key == null) return;
      const set = new Set(collapsedWaitingOnFor(key));
      if (set.has(sectionKey)) set.delete(sectionKey); else set.add(sectionKey);
      waitingOnCollapsed.set(key, [...set]);
      prefs.set('tc_v6_waiting_on_collapsed', Object.fromEntries(waitingOnCollapsed));
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
     * The "Your ToDo" items the chat on screen still shows (#3105), less
     * what's been dismissed from this exact still-latest reply.
     * @returns {string[]}
     */
    function todoNow() {
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      const key = chatTargetKey();
      const dismissed = new Set(dismissedTodoFor(key));
      return extractOperatorTodo(latestReplyText(chat && chat.live)).filter((t) => !dismissed.has(t));
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
     * Keep the CLI-gate/multi-choice card, the Your ToDo list, the AI
     * queue, and the YOU category's own count fresh on every poll (#3105)
     * — a CLI gate is the single most time-sensitive thing this panel
     * shows, so it cannot wait for the operator to trigger a full render.
     */
    function paintWaitingOnExtras() {
      const view = detail && detail.kind === 'conversation' ? detail.view : null;
      const chat = view ? view.chat : null;
      if (!chat) return;
      const key = chatTargetKey();
      const liveTurns = chat.live && Array.isArray(chat.live.turns) ? chat.live.turns : [];
      const model = waitingOnModel(chat.live, Object.assign({}, chat, {
        dismissedQuestions: dismissedFor(key),
        dismissedTodoItems: dismissedTodoFor(key),
        dismissedFleetTargets: dismissedFleetFor(key),
        queuedPrompts: chatQueues.get(key) || [],
        pending: pendingSends.filter((p) => p.key === key)
      }), view && view.events, liveTurns, [...projectRows.values()]);
      const folded = new Set(collapsedWaitingOnFor(key));
      // #3131: each actor section's outer <section> carries its own
      // has-items/is-collapsed classes now (the YOU body holds several
      // nested lists, not one), so this sets the SECTION, not whichever
      // list element's innerHTML is being refreshed below.
      const setSectionClass = (sectionKey, has) => {
        const section = doc.body && typeof doc.body.querySelector === 'function'
          ? doc.body.querySelector(`.v6-waiting-on-${sectionKey}`) : null;
        if (section) section.className = `v6-waiting-on-section v6-waiting-on-${sectionKey}${has ? ' has-items' : ''}${folded.has(sectionKey) ? ' is-collapsed' : ''}`;
      };
      const gc = doc.getElementById('v6ChatGateChoice');
      if (gc) gc.innerHTML = cliGateMarkup(model.gate) + multiChoiceMarkup(model.choice);
      const countEl = doc.getElementById('v6ChatWaitingOnYouCount');
      if (countEl) countEl.innerHTML = String(waitingOnYouCount(model));
      // #3131 (PRR-B R1 blocking 1b): each of these three replaces its
      // WHOLE wrap — the Clear button and (for Todo) the subhead included
      // — so a poll that crosses the 0/1-vs->1 boundary never leaves
      // either stale; before this they lived outside the list element
      // this function used to update alone.
      const youClearWrap = doc.getElementById('v6WaitingOnYouClearWrap');
      if (youClearWrap) youClearWrap.innerHTML = youClearMarkup(model.direct.length);
      setSectionClass('you', waitingOnYouCount(model) > 0);
      const todoWrap = doc.getElementById('v6ChatTodoWrap');
      if (todoWrap) todoWrap.innerHTML = todoWrapMarkup(model.todo);
      const aiWrap = doc.getElementById('v6ChatAiWrap');
      if (aiWrap) aiWrap.innerHTML = aiWrapMarkup(model.ai);
      setSectionClass('ai', model.ai.length > 0);
      const fleetWrap = doc.getElementById('v6ChatWaitingOnFleet');
      if (fleetWrap) fleetWrap.innerHTML = fleetSectionsMarkup(model.fleet, folded);
      const panel = doc.getElementById('v6ChatWaitingOn');
      if (panel) {
        const anyItems = waitingOnYouCount(model) > 0 || model.ai.length > 0 || model.fleet.length > 0;
        panel.className = `v6-waiting-on-panel${anyItems ? ' has-items' : ''}`;
      }
      wireWaitingOn();
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

    /**
     * The rest of the Waiting-on panel's own controls (#3105): a CLI-gate
     * or multi-choice chip sends its key as the reply, the hood jump opens
     * Under the Hood, a category's Clear empties it, and an AI item's
     * Force sends it now while its ✕ drops it from the queue.
     */
    function wireWaitingOn() {
      const openHood = () => {
        const hood = doc.getElementById('v6ChatUnderHood');
        if (hood) {
          hood.open = true;
          if (typeof hood.setAttribute === 'function') hood.setAttribute('open', '');
        }
        chatHoodOpen = true;
        prefs.set('tc_v6_chat_under_hood_open', true);
      };
      const each = (sel, fn) => {
        (typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll(sel) : []).forEach(fn);
      };
      each('.v6-chat-gate-action', (btn) => {
        btn.addEventListener('click', () => {
          const key = btn.getAttribute('data-gate-key');
          if (key && typeof options.onSendChat === 'function') options.onSendChat(key);
        });
      });
      each('.v6-chat-gate-hood', (btn) => btn.addEventListener('click', openHood));
      each('.v6-chat-choice-option', (btn) => {
        btn.addEventListener('click', () => {
          const key = btn.getAttribute('data-choice-key');
          if (key === 'other') { focusById('v6ChatInput'); return; }
          if (key && typeof options.onSendChat === 'function') options.onSendChat(key);
        });
      });
      each('.v6-waiting-on-ai-force', (btn) => {
        btn.addEventListener('click', () => forceQueuedPrompt(btn.getAttribute('data-id')));
      });
      each('.v6-waiting-on-ai-dismiss', (btn) => {
        btn.addEventListener('click', () => dismissQueuedPrompt(btn.getAttribute('data-id')));
      });
      const clearYou = doc.getElementById('v6WaitingOnYouClear');
      if (clearYou) clearYou.addEventListener('click', () => dismissQuestions(questionsNow()));
      each('.v6-waiting-on-todo-dismiss', (btn) => {
        btn.addEventListener('click', () => dismissTodoItems([btn.getAttribute('data-text')]));
      });
      const clearTodo = doc.getElementById('v6WaitingOnTodoClear');
      if (clearTodo) clearTodo.addEventListener('click', () => dismissTodoItems(todoNow()));
      const clearAi = doc.getElementById('v6WaitingOnAiClear');
      if (clearAi) {
        clearAi.addEventListener('click', () => {
          const key = chatTargetKey();
          if (key != null) chatQueues.set(key, []);
          render();
        });
      }
      // #3131: each actor section's header folds/unfolds it, remembered per
      // chat; a plain re-render is fine here — unlike the gate card above,
      // folding is not something that must survive a poll mid-keystroke.
      // #3131 (PRR-B R1 blocking 1a): this button is NEVER recreated by
      // paintWaitingOnExtras (it is the section's own header, a sibling of
      // the body that function updates) — unlike the Clear buttons above,
      // which now live inside a wrap that function fully replaces, a fresh
      // element on every poll is not available here, so a once-per-element
      // dataset marker (wireUsage()'s own pattern) is what stops a 4s
      // setLive() -> paintWaitingOnExtras() -> wireWaitingOn() poll from
      // doubling this listener — two clicks per press toggled the fold
      // state straight back off. Both wiring paths below share the SAME
      // marker, so whichever runs first wins and the other is a no-op.
      // `sectionKey` is taken as a PARAMETER, never re-read from the
      // button's own `data-waiting-section` attribute inside the handler:
      // a test's minimal DOM parses only `id=` out of a markup string, not
      // arbitrary attributes, so a round trip through `getAttribute` here
      // would make this exact fix untestable, not just inconvenient.
      const wireFoldToggle = (btn, sectionKey) => {
        if (!btn || (btn.dataset && btn.dataset.waitingSectionWired)) return;
        if (btn.dataset) btn.dataset.waitingSectionWired = '1';
        btn.addEventListener('click', () => { toggleWaitingOnSection(sectionKey); render(); });
      };
      each('[data-waiting-section]', (btn) => wireFoldToggle(btn, btn.getAttribute('data-waiting-section')));
      // The two always-present toggles, by their own stable id and known
      // key — `each` above already covers them (and every Fleet Member
      // one, dynamic by nature) through `doc.querySelectorAll`, which a
      // test's minimal DOM does not implement; this id-based lookup is
      // what makes THIS exact fix provable in test/v6-b1-ui-shell.test.js.
      wireFoldToggle(doc.getElementById('v6WaitingOnToggle-you'), 'you');
      wireFoldToggle(doc.getElementById('v6WaitingOnToggle-ai'), 'ai');
      each('.v6-waiting-on-fleet-dismiss', (btn) => {
        btn.addEventListener('click', () => dismissFleetTargets([btn.getAttribute('data-key')]));
      });
    }

    /** @returns {string} The usage meter as it stands (#3085), or '' before the routes answer. */
    function usageMarkupNow() {
      return usage ? usageMeterMarkup(usageMeterModel(usage.windows, usage.sessions), {
        open: usageOpen, status: usageStatus, probe: usageProbe, probeInterval: usageProbeInterval
      }) : '';
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
      // #3132: the automated probe's own refresh-cadence selector and
      // on-demand refresh button.
      const intervalSelect = doc.getElementById('v6UsageProbeInterval');
      if (fresh(intervalSelect)) {
        intervalSelect.addEventListener('change', (evt) => {
          const value = String((evt && evt.target && evt.target.value) || '');
          if (!value || !usageProbeActions || typeof usageProbeActions.setInterval !== 'function') return;
          usageStatus = { kind: 'pending', message: `Setting auto-refresh to ${value}…` };
          paintUsage();
          Promise.resolve(usageProbeActions.setInterval(value)).then((result) => {
            usageStatus = result && result.ok
              ? { kind: 'ok', message: `Auto-refresh set to ${result.interval || value}.` }
              : { kind: 'error', message: `Auto-refresh not set: ${(result && result.error) || 'the server refused it'}` };
            paintUsage();
          });
        });
      }
      const probeRefresh = doc.getElementById('v6UsageProbeRefresh');
      if (fresh(probeRefresh)) {
        probeRefresh.addEventListener('click', () => {
          if (!usageProbeActions || typeof usageProbeActions.refresh !== 'function') return;
          usageStatus = { kind: 'pending', message: 'Refreshing usage probe…' };
          paintUsage();
          Promise.resolve(usageProbeActions.refresh()).then((result) => {
            usageStatus = result && result.ok
              ? { kind: 'ok', message: 'Usage probe refreshed.' }
              : { kind: 'error', message: `Usage probe not refreshed: ${(result && result.error) || 'the server refused it'}` };
            paintUsage();
          });
        });
      }
    }

    /** @returns {Object<string, string>} The chat on screen's thumbnails: file name → `blob:` URL (#3082). */
    function thumbsNow() {
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      return (chat && chat.thumbs) || {};
    }

    /** The chat on screen's unfurl state by URL, right now (#3107). */
    function unfurlsNow() {
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      return (chat && chat.unfurls) || {};
    }

    /**
     * One link's unfurl state changed (#3107): redraws the message lists in
     * place, the same as `setThumbs` — never a full `render()`, so the
     * chat's scroll position, draft and focus are untouched. A plain
     * function (not only a shell method) so {@link wireRichPreviews}' click
     * handler can call it directly, the same split {@link setWorkspaceMode}
     * already uses.
     * @param {string} url
     * @param {{state: ('loading'|'done'|'error'), preview?: object}} entry
     */
    function setUnfurl(url, entry) {
      if (!detail || detail.kind !== 'conversation' || !detail.view || typeof url !== 'string') return;
      const unfurls = Object.assign({}, detail.view.chat.unfurls, { [url]: entry });
      detail = Object.assign({}, detail, { view: Object.assign({}, detail.view, { chat: Object.assign({}, detail.view.chat, { unfurls }) }) });
      const view = detail.view;
      const liveEl = doc.getElementById('v6ChatLive');
      if (liveEl) liveEl.innerHTML = liveTurnsMarkup(view.chat.live ? view.chat.live.turns : [], String((view.project && view.project.name) || ''), verbosity, thumbsNow(), unfurlsNow());
      wireRichPreviews(); // #3107 (PRR-A R1 C1/C2): paintTucked/paintRecorded below also re-wire (global, not scoped), but this covers #v6ChatLive explicitly even if that ever changes.
      paintTucked(view.chat.live);
      paintRecorded();
    }

    /**
     * Redraw the replies the verbosity filter tucked away, and their count
     * on the Under the Hood summary (#3082).
     * @param {object|null} live
     */
    function paintTucked(live) {
      const tucked = tuckedTurns(live && Array.isArray(live.turns) ? live.turns : [], verbosity);
      const list = doc.getElementById('v6ChatTucked');
      if (list) list.innerHTML = tuckedMarkup(tucked, thumbsNow(), unfurlsNow());
      const count = doc.getElementById('v6ChatTuckedCount');
      if (count) count.innerHTML = escapeHtml(tuckedCountText(tucked.length));
      // #3107 (PRR-A R1 C1/C2): this innerHTML assignment destroys whatever
      // listeners wireControls()'s last full render attached to any
      // .v6-chat-unfurl-btn/.v6-chat-local-ref-copy inside #v6ChatTucked —
      // every targeted (non-render()) redraw of a rich-preview region must
      // re-wire them itself, the same way wireControls() always does after
      // a full render.
      wireRichPreviews();
      // #3191: the tucked list growing is content inside the Under the
      // Hood group — re-pin it (and the stream, harmlessly, if it also
      // stayed pinned) the same way every other targeted redraw does.
      pinIfPinned();
    }

    /**
     * Apply a new `hideHoodTraffic` value in place (#3191): the drawer's
     * own class, the two fleet-chatter sections' `hidden` (and the tucked
     * count badge's), the raw peek re-filtered, and the whole Under the
     * Hood group re-armed to the bottom — revealing or hiding a section
     * changes every pane's own content height, the same as the drawer's
     * own open/close does.
     * @param {boolean} next
     */
    function applyHideHoodTraffic(next) {
      hideHoodTraffic = Boolean(next);
      prefs.set('tc_v6_chat_hide_hood_traffic', hideHoodTraffic);
      const hood = doc.getElementById('v6ChatUnderHood');
      if (hood && hood.classList) hood.classList.toggle('is-traffic-hidden', hideHoodTraffic);
      const tuckedSection = typeof doc.querySelector === 'function' ? doc.querySelector('.v6-chat-tucked') : null;
      if (tuckedSection) tuckedSection.hidden = hideHoodTraffic;
      const switchboardSection = typeof doc.querySelector === 'function' ? doc.querySelector('.v6-chat-switchboard') : null;
      if (switchboardSection) switchboardSection.hidden = hideHoodTraffic;
      const count = doc.getElementById('v6ChatTuckedCount');
      if (count) count.hidden = hideHoodTraffic;
      const peekEl = doc.getElementById('v6ChatPeek');
      const view = detail && detail.kind === 'conversation' ? detail.view : null;
      if (peekEl && view) {
        peekEl.innerHTML = (hoodInteractive
          ? '<span id="v6ChatHoodLiveIndicator" style="color:#9CF732;display:block;">LIVE CLI — Type directly into pane</span>'
          : '') + chatPeekMarkup(view.chat ? view.chat.peek : null, { hideTraffic: hideHoodTraffic });
      }
      rearmPeekPin();
    }

    /**
     * Each verbosity checkbox (#3082) shows or tucks its kind of reply, in
     * place, and is remembered. `#v6ChatHideHoodTraffic` (#3191) is the odd
     * one out — it doesn't filter `#v6ChatLive`/tucked turns at all, so it
     * goes through {@link applyHideHoodTraffic} instead of the shared
     * verbosity-key branch below.
     */
    function wireVerbosity() {
      const traffic = doc.getElementById('v6ChatHideHoodTraffic');
      if (traffic) traffic.addEventListener('change', (evt) => applyHideHoodTraffic(Boolean(evt && evt.target ? evt.target.checked : traffic.checked)));
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
          if (liveEl) liveEl.innerHTML = liveTurnsMarkup(live ? live.turns : [], String((view && view.project && view.project.name) || ''), verbosity, thumbsNow(), unfurlsNow());
          wireRichPreviews(); // #3107 (PRR-A R1 C1/C2): #v6ChatLive's own listeners, same reason as paintTucked's.
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
      if (head) head.innerHTML = recordedEventsMarkup(parts.head, name, chat.thumbs, chat.unfurls);
      const tailEl = doc.getElementById('v6ChatRecordedTail');
      if (tailEl) tailEl.innerHTML = recordedEventsMarkup(parts.tail, name, chat.thumbs, chat.unfurls);
      const pendingEl = doc.getElementById('v6ChatPending');
      if (pendingEl) pendingEl.innerHTML = pendingMarkup(pendingSends.filter((p) => p.key === chatTargetKey()), chat.lastSent, chat.thumbs, chat.unfurls);
      wireRichPreviews(); // #3107 (PRR-A R1 C1/C2): same reason as paintTucked's own call.
      // #3191: recorded/pending content grows #v6ChatStream — re-pin it
      // (and the peek group, harmlessly, if it also stayed pinned).
      pinIfPinned();
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
        // #3191: the operator clicked THIS to see the traffic — reveal it,
        // even if "Hide Medusa & fleet chatter" was (as it is by default) on.
        if (hideHoodTraffic) applyHideHoodTraffic(false);
        else rearmPeekPin(); // opening the drawer re-arms the pin either way
        const checkbox = doc.getElementById('v6ChatHideHoodTraffic');
        if (checkbox) checkbox.checked = false;
        const list = doc.getElementById('v6ChatSwitchboard');
        if (list && typeof list.focus === 'function') list.focus();
      });
    }

    /** @returns {string|null} The project the chat on screen talks to, as a draft key. */
    function chatTargetKey() {
      const project = detail && detail.kind === 'conversation' && detail.view ? detail.view.project : null;
      return project && project.id != null ? String(project.id) : null;
    }

    /**
     * The logical project (a `tree[i].id`) the active conversation or the
     * active project/fleet route belongs to (#3191) — a conversation route
     * only ever names the single seat it talks to, never its owning group,
     * so finding `P` means walking `tree` the same way {@link chatContext}
     * does for a direct (non-group) route: the node whose fleets hold that
     * seat as a member. A project/fleet route's own `projectId` is tried as
     * a logical id FIRST, since {@link parseRoute} gives the exact same
     * string whether the operator reached it via its group or directly —
     * only when that fails to name a `tree` node at all does it fall back
     * to the same membership walk.
     * @returns {string|null}
     */
    function activeLogicalProjectId() {
      let seatOrGroupId = null;
      if (detail && detail.kind === 'conversation' && detail.view && detail.view.project && detail.view.project.id != null) {
        seatOrGroupId = detail.view.project.id;
      } else if (currentRoute && (currentRoute.view === 'project' || currentRoute.view === 'fleet') && currentRoute.projectId != null) {
        seatOrGroupId = currentRoute.projectId;
      }
      if (seatOrGroupId == null) return null;
      if (tree.some((n) => n && String(n.id) === String(seatOrGroupId))) return String(seatOrGroupId);
      const node = tree.find((n) => n && Array.isArray(n.fleets)
        && n.fleets.some((f) => f && Array.isArray(f.members) && f.members.some((m) => m && String(m.seatId) === String(seatOrGroupId))));
      return node ? String(node.id) : null;
    }

    /**
     * Workflow B's source picker (#3114): the "Workspace Projects" catch-all
     * logical project's own members — the standalone single-session
     * projects {@link synthesizeTreeFromProjects} found no dash-prefix
     * sibling for.
     * @returns {Array<{seatId: string, role: string}>}
     */
    function standaloneProjectsNow() {
      const workspace = tree.find((p) => p && p.id === 'workspace');
      const fleet = workspace && Array.isArray(workspace.fleets) ? workspace.fleets[0] : null;
      return fleet && Array.isArray(fleet.members) ? fleet.members : [];
    }

    /**
     * Every exportable fleet or standalone workspace in `tree` (#3115,
     * PRR-A R1 C1/C2): unlike {@link standaloneProjectsNow}, this walks
     * every logical project's fleets, not only the "workspace" catch-all —
     * #3115's own Deliverable 2 names exporting "any existing logical
     * project/fleet", and a real multi-seat fleet (`TC-Lane-*`, `Monad-*`)
     * was unreachable from the Export dropdown without this. `id` is the
     * fleet's first member (the `GET /api/v6/projects/:id/fleet-spec`
     * route's own `:id`); `memberSeatIds` is the full roster, passed as
     * that route's `?members=` so a multi-seat fleet exports every seat,
     * not just the one named in the URL.
     * @returns {Array<{id: string, label: string, memberSeatIds: string[]}>}
     */
    function exportableFleetsNow() {
      const out = [];
      tree.forEach((p) => {
        (p && Array.isArray(p.fleets) ? p.fleets : []).forEach((f) => {
          const members = Array.isArray(f.members) ? f.members : [];
          if (!members.length || !members[0].seatId) return;
          // A single-member fleet is a standalone project, not a real named
          // fleet — its own member's role (the project's actual name) is
          // the readable label; the "Workspace Projects" catch-all's own
          // displayName would otherwise show on EVERY standalone project
          // identically, indistinguishable from one another in the picker.
          const label = members.length > 1 ? (f.displayName || p.displayName) : members[0].role;
          out.push({ id: members[0].seatId, label, memberSeatIds: members.map((m) => m.seatId) });
        });
      });
      return out;
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
     * Persists the composer's and Under the Hood's own drag-resized
     * heights (#3106, #3133, extended #3152) across reloads, restoring
     * whichever height the operator last dragged to before anything else
     * reads `offsetHeight` — a full re-render replaces both elements and
     * loses any native resize the operator had made otherwise.
     *
     * The chat stream (`.v6-chat-stream`) has no resize handle of its own
     * to persist: #3152/#3156 finished #3151's deferred criterion 3 by
     * giving it `flex: 1 1 0%; max-height: none` in `style.css`, so it
     * fills 100% of whatever `.v6-chat` has left once the header, Under
     * the Hood and the composer have taken their own share — zero dead
     * space at the bottom by construction, and resizing either of the
     * other two panes reshares the stream's space automatically through
     * ordinary flex layout, with no JS measurement needed for that
     * direction (a `resize: vertical` handle on a `flex-basis: 0%` item
     * would be inert anyway — dragging it sets an inline `height` the
     * flex layout never reads over the explicit `0%` basis).
     *
     * No-ops where `ResizeObserver` is unavailable (the unit-test
     * sandbox) — the persistence itself is a live-browser behavior,
     * verified by this car's required browser check, not by node:test.
     *
     * #3173: every restored or newly measured height is run through
     * {@link clampChatPaneHeights} first, so an oversized saved height (set
     * on a taller window, or before the viewport shrank) never comes back
     * large enough to push `#v6ChatStream` or `#v6ChatForm`/`#v6ChatInput`
     * off-screen or lock scrolling.
     */
    function wireComposerResize() {
      const input = doc.getElementById('v6ChatInput');
      const stream = doc.getElementById('v6ChatStream');
      if (!input || !stream) return;
      const hood = doc.getElementById('v6ChatPeek');
      const viewportH = () => (win && typeof win.innerHeight === 'number' ? win.innerHeight : 0);
      const savedInputHeight = prefs.get('tc_v6_chat_input_height', null, isFiniteNumber);
      const savedHoodHeight = prefs.get('tc_v6_chat_uth_height', null, isFiniteNumber);
      // #3173: clamp the restored heights too — a height saved before the
      // viewport last shrank (a smaller window, a narrower device) must not
      // come back oversized and push the stream or the input off-screen.
      const restored = clampChatPaneHeights({ input: savedInputHeight, hood: savedHoodHeight }, viewportH());
      if (input.style && restored.input !== null) input.style.height = `${restored.input}px`;
      if (hood && hood.style && restored.hood !== null) hood.style.height = `${restored.hood}px`;
      const applyToInput = () => {
        // PRR-B R1 BLOCKING 1a: `input.offsetHeight` reads 0/undefined for a
        // hidden tab or this file's own unit-test DOM (neither computes real
        // layout) — persisting THAT would silently erase a genuinely saved
        // height. The inline style height (set by the drag itself, or by the
        // restore step above) is the more trustworthy reading either way, so
        // it is tried first; a measurement of 0 skips the write entirely
        // rather than ever persisting null over a real saved value.
        const measuredInput = (input.style && parseFloat(input.style.height)) || input.offsetHeight;
        if (!measuredInput) return;
        const clamped = clampChatPaneHeights({ input: measuredInput }, viewportH()).input;
        if (clamped === null) return;
        prefs.set('tc_v6_chat_input_height', clamped);
        if (input.style && clamped !== measuredInput) input.style.height = `${clamped}px`;
      };
      const applyToHood = () => {
        if (!hood) return;
        const measuredHood = (hood.style && parseFloat(hood.style.height)) || hood.offsetHeight;
        if (!measuredHood) return;
        const clamped = clampChatPaneHeights({ hood: measuredHood }, viewportH()).hood;
        if (clamped === null) return;
        prefs.set('tc_v6_chat_uth_height', clamped);
        if (hood.style && clamped !== measuredHood) hood.style.height = `${clamped}px`;
      };
      // #3186: the 4 "Gobble & Fill" pane-boundary resizers — drag,
      // Up/Down arrow keys, and double-click reset, all driven by the pure
      // {@link tradeChatPaneHeights} helper. Wired unconditionally (every
      // mount gets fresh `<div data-chat-resizer>` elements from the same
      // full re-render that gives `input`/`stream`/`hood` their own fresh
      // nodes above, so there is nothing stale to double-wire) rather than
      // gated on `ResizeObserver` like the measure-and-persist loop below
      // it, which is a separate mechanism.
      const underHood = doc.getElementById('v6ChatUnderHood');
      const currentHeights = () => ({
        stream: stream.offsetHeight || V6_CHAT_STREAM_MIN_HEIGHT,
        input: (input.style && parseFloat(input.style.height)) || input.offsetHeight || V6_CHAT_INPUT_MIN_HEIGHT,
        hood: hood ? ((hood.style && parseFloat(hood.style.height)) || hood.offsetHeight || V6_CHAT_UTH_MIN_HEIGHT) : V6_CHAT_UTH_MIN_HEIGHT,
        hoodOpen: Boolean(underHood && underHood.open)
      });
      const applyTrade = (baseline, boundary, deltaY) => {
        const result = tradeChatPaneHeights(baseline, boundary, deltaY, viewportH());
        if (input.style && result.input !== null) input.style.height = `${result.input}px`;
        if (hood && hood.style && result.hood !== null) hood.style.height = `${result.hood}px`;
        // The drawer itself (not just its own `#v6ChatPeek` pane) can carry
        // a stale inline height from an older resize scheme — clear it so
        // <summary> is never trapped below the fold by it.
        if (underHood && underHood.style && typeof underHood.style.removeProperty === 'function') underHood.style.removeProperty('height');
        if (result.input !== null) prefs.set('tc_v6_chat_input_height', result.input);
        if (result.hood !== null) prefs.set('tc_v6_chat_uth_height', result.hood);
      };
      const resetPaneSizes = () => {
        // `null` reads back as unreadable (same as never set) through
        // `isFiniteNumber`'s own accept check — makePrefs has no delete.
        prefs.set('tc_v6_chat_input_height', null);
        prefs.set('tc_v6_chat_uth_height', null);
        if (input.style) input.style.height = '';
        if (hood && hood.style) hood.style.height = '';
        if (underHood && underHood.style) underHood.style.height = '';
      };
      ['stream-bottom', 'hood-top', 'hood-bottom', 'composer-top'].forEach((boundary) => {
        const idByBoundary = {
          'stream-bottom': 'v6ChatStreamResizeBottom', 'hood-top': 'v6ChatHoodResizeTop',
          'hood-bottom': 'v6ChatHoodResizeBottom', 'composer-top': 'v6ChatComposerResizeTop'
        };
        const el = doc.getElementById(idByBoundary[boundary]);
        if (!el) return;
        let dragBaseline = null;
        let dragStartY = 0;
        const onMove = (evt) => {
          if (!dragBaseline) return;
          const y = evt && typeof evt.clientY === 'number' ? evt.clientY : dragStartY;
          applyTrade(dragBaseline, boundary, y - dragStartY);
        };
        const onUp = () => {
          dragBaseline = null;
          if (win && typeof win.removeEventListener === 'function') {
            win.removeEventListener('pointermove', onMove);
            win.removeEventListener('pointerup', onUp);
          }
        };
        el.addEventListener('pointerdown', (evt) => {
          dragStartY = evt && typeof evt.clientY === 'number' ? evt.clientY : 0;
          dragBaseline = currentHeights();
          if (win && typeof win.addEventListener === 'function') {
            win.addEventListener('pointermove', onMove);
            win.addEventListener('pointerup', onUp);
          }
          if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
        });
        el.addEventListener('keydown', (evt) => {
          if (!evt) return;
          if (evt.key === 'ArrowDown') { applyTrade(currentHeights(), boundary, 16); evt.preventDefault(); }
          else if (evt.key === 'ArrowUp') { applyTrade(currentHeights(), boundary, -16); evt.preventDefault(); }
        });
        el.addEventListener('dblclick', resetPaneSizes);
      });
      if (composerInputResizeObserver && typeof composerInputResizeObserver.disconnect === 'function') composerInputResizeObserver.disconnect();
      if (composerHoodResizeObserver && typeof composerHoodResizeObserver.disconnect === 'function') composerHoodResizeObserver.disconnect();
      if (typeof global.ResizeObserver !== 'function') return;
      composerInputResizeObserver = new global.ResizeObserver(applyToInput);
      composerInputResizeObserver.observe(input);
      if (hood) {
        composerHoodResizeObserver = new global.ResizeObserver(applyToHood);
        composerHoodResizeObserver.observe(hood);
      }
    }

    /**
     * The Fleet sidebar's drag-resizable width (#3133): dragging
     * `#v6SidebarResizeHandle` sets `#v6ShellRoot`'s `grid-template-columns`
     * via {@link applySidebarWidthStyle} and persists the result, so a
     * reload keeps the operator's chosen width. Arrow keys on the handle
     * nudge it by 10px, for keyboard operability (`role="separator"`
     * already names it one).
     */
    function wireSidebarResize() {
      const handle = doc.getElementById('v6SidebarResizeHandle');
      if (!handle || (handle.dataset && handle.dataset.resizeWired)) return;
      if (handle.dataset) handle.dataset.resizeWired = '1';
      const setWidth = (width) => {
        sidebarWidth = clampSidebarWidth(width);
        prefs.set('tc_v6_sidebar_width', sidebarWidth);
        applySidebarWidthStyle();
        handle.setAttribute('aria-valuenow', String(sidebarWidth));
      };
      let dragStartX = 0;
      let dragStartWidth = sidebarWidth;
      const onMove = (evt) => {
        const x = evt && typeof evt.clientX === 'number' ? evt.clientX : dragStartX;
        setWidth(dragStartWidth + (x - dragStartX));
      };
      const onUp = () => {
        if (win && typeof win.removeEventListener === 'function') {
          win.removeEventListener('pointermove', onMove);
          win.removeEventListener('pointerup', onUp);
        }
      };
      handle.addEventListener('pointerdown', (evt) => {
        dragStartX = evt && typeof evt.clientX === 'number' ? evt.clientX : 0;
        dragStartWidth = sidebarWidth;
        if (win && typeof win.addEventListener === 'function') {
          win.addEventListener('pointermove', onMove);
          win.addEventListener('pointerup', onUp);
        }
        if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
      });
      handle.addEventListener('keydown', (evt) => {
        if (!evt) return;
        if (evt.key === 'ArrowLeft') { setWidth(sidebarWidth - 10); evt.preventDefault(); }
        else if (evt.key === 'ArrowRight') { setWidth(sidebarWidth + 10); evt.preventDefault(); }
      });
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
     * Force one queued prompt out now (#3105), bypassing the busy gate the
     * same way the composer's own ⚡ Force does.
     * @param {string} id
     */
    function forceQueuedPrompt(id) {
      const key = chatTargetKey();
      if (key == null || typeof options.onSendChat !== 'function') return;
      const list = chatQueues.get(key) || [];
      const item = list.find((p) => String(p.id) === String(id));
      if (!item) return;
      chatQueues.set(key, list.filter((p) => p !== item));
      sendFlags = { priority: true, startupIntervention: true };
      try {
        options.onSendChat(item.text, sendFlags);
      } finally {
        sendFlags = null;
      }
      render();
    }

    /**
     * Drop one queued prompt without sending it (#3105).
     * @param {string} id
     */
    function dismissQueuedPrompt(id) {
      const key = chatTargetKey();
      if (key == null) return;
      const list = chatQueues.get(key) || [];
      chatQueues.set(key, list.filter((p) => String(p.id) !== String(id)));
      render();
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
      const streamEl = doc.getElementById('v6ChatStream');
      const peekEl = doc.getElementById('v6ChatPeek');
      return {
        scrollTop: (sidebar && sidebar.scrollTop) || 0, focusId, selection,
        // #3191: the exact position, not just an at-bottom boolean — a
        // pane the operator genuinely scrolled away from returns to where
        // they left it across a full render, instead of only ever
        // snapping to the bottom or staying wherever the fresh DOM happens
        // to start.
        streamScrollTop: !streamPinned && streamEl ? streamEl.scrollTop : null,
        peekScrollTop: !peekPinned && peekEl ? peekEl.scrollTop : null
      };
    }

    /** @param {ReturnType<typeof captureViewState>} saved */
    function restoreViewState(saved) {
      const sidebar = doc.getElementById('v6ShellSidebar');
      if (sidebar && saved.scrollTop) sidebar.scrollTop = saved.scrollTop;
      // A chat opens at its newest line (#3052); after that it follows new
      // lines only while the operator is reading the bottom. #3113: latch
      // scrolledChatKey only once the stream exists AND has something
      // loaded — latching it earlier (a key assigned before any turn or
      // peek line has arrived) would mark a still-empty chat as "already
      // scrolled," so it never gets its one pin-to-bottom once the slow
      // conversation fetch actually lands.
      const key = chatTargetKey();
      const streamEl = doc.getElementById('v6ChatStream');
      const peekEl = doc.getElementById('v6ChatPeek');
      const view = detail && detail.kind === 'conversation' ? detail.view : null;
      const loaded = Boolean(streamEl) && Boolean(view)
        && ((Array.isArray(view.events) && view.events.length > 0) || Boolean(view.chat && view.chat.peek));
      const first = key != null && key !== scrolledChatKey;
      if (key != null && loaded) scrolledChatKey = key;
      // #3135/#3191: a reload or a switch to a different chat always
      // starts pinned — the OLD one-shot `saved.streamAtBottom`/
      // `peekAtBottom` checks never reapplied once the header docked out
      // from under them or an async thumbnail grew a pane after this
      // point; `streamPinned`/`peekPinned` are live state the 'scroll'
      // listeners keep current, and render() (this function's caller)
      // re-applies them again after `syncDockedHeader()` and once more
      // next frame, which this single call here cannot.
      if (first) { streamPinned = true; peekPinned = true; }
      if (streamPinned) {
        pinStream(streamEl);
      } else if (saved.streamScrollTop != null && streamEl) {
        streamEl.scrollTop = saved.streamScrollTop;
        lastStreamScrollTop = streamEl.scrollTop;
      }
      if (peekPinned) {
        pinPeekGroup();
      } else if (saved.peekScrollTop != null && peekEl) {
        peekEl.scrollTop = saved.peekScrollTop;
        lastPeekScrollTop = peekEl.scrollTop;
      }
      paintStreamPinIndicator();
      if (!saved.focusId) return;
      const el = doc.getElementById(saved.focusId);
      if (!el || doc.activeElement === el || typeof el.focus !== 'function') return;
      el.focus();
      if (saved.selection && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(saved.selection[0], saved.selection[1]);
      }
    }

    function render() {
      const previousRoute = currentRoute;
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
      // #3117 (PRR-A R1 C1): the drawer toggle is docked into .dash-bar the
      // same way the chat header is — it needs the same "take it out before
      // the redraw" step, or the fresh one `root.innerHTML` is about to draw
      // becomes a SECOND #v6ShellDrawerToggle, and getElementById keeps
      // returning the stale docked one (first in document order) forever.
      const oldDrawerToggle = bar && typeof bar.querySelector === 'function' ? bar.querySelector('.v6-shell-drawer-toggle') : null;
      if (oldDrawerToggle) oldDrawerToggle.remove();
      const title = routeTitle(currentRoute);
      // #3204: entering Overview (not merely re-rendering while already
      // there) defaults the fleet filter to All Fleets, so the Global
      // Overview never stays locked to whatever fleet a previous
      // conversation/project route last narrowed it to. Checked BEFORE the
      // #3191 sync right below, which is a no-op for 'overview' anyway
      // (activeLogicalProjectId only ever resolves for a conversation/
      // project/fleet route) — ordering only matters for clarity here.
      const enteringOverview = currentRoute && currentRoute.view === 'overview'
        && (!previousRoute || previousRoute.view !== 'overview');
      if (enteringOverview && selectedGroups.size > 0) {
        selectedGroups = new Set();
        tabPrefs.set('tc_v6_selected_groups', []);
      }
      // #3191: a direct navigation (a link, a reload landing mid-route) can
      // leave the filter narrowed to a fleet other than the one actually on
      // screen. Reconcile before the narrowed set ever reaches filterTree
      // below. #3204 moved this key to sessionStorage (tab-scoped), so the
      // cross-tab case this originally targeted cannot happen anymore —
      // this now only ever fires on a same-tab inconsistency.
      const activeLP = activeLogicalProjectId();
      if (activeLP != null && selectedGroups.size > 0 && !selectedGroups.has(activeLP)) {
        selectedGroups = new Set([activeLP]);
        tabPrefs.set('tc_v6_selected_groups', [...selectedGroups]);
      }
      shownTree = filterTree(tree, { text: filterText, engine: filterEngine, groups: selectedGroups }, projectRows);
      // #3053: the template wizard and attestation pills are not chat
      // content; they stay in the page (and wired) but out of sight.
      const inChat = Boolean(detail && detail.kind === 'conversation');
      // Going somewhere shows it (#3086): a member click, or the first drawing
      // after a reload, opens in Chat, so a chat is never hidden behind a mode
      // chosen elsewhere. A redraw on the same route (a poll, or the chat
      // arriving after the operator picked a tab) keeps the chosen mode.
      const modeRouteKey = JSON.stringify(currentRoute);
      if (modeRouteKey !== lastModeRouteKey) {
        lastModeRouteKey = modeRouteKey;
        workspaceMode = 'chat';
        // The charter panel belongs to the project that was open: never show it for another (#3088).
        workspacePanels.delete('charter');
      }
      const shown = workspaceVisibility(workspaceMode, inChat);
      const activityElapsed = syncBusy();
      if (root.classList) {
        root.classList.toggle('v6-shell-root--sidebar-collapsed', sidebarCollapsed);
        // #3059: the chat's own toolbar names what it shows, so the route and
        // group headings are hidden from sight (not from screen readers).
        root.classList.toggle('v6-shell-root--chat', inChat);
      }
      applySidebarWidthStyle();
      root.innerHTML = `
        <a id="v6ShellSkipLink" class="v6-shell-skip-link" href="#v6ShellMain">Skip to main content</a>
        <button type="button" id="v6ShellDrawerToggle" class="btn btn-secondary btn-small v6-shell-drawer-toggle"
          aria-expanded="${drawerOpen ? 'true' : 'false'}" aria-controls="v6ShellSidebar" aria-label="Open fleet navigation menu" title="Menu"><span aria-hidden="true">☰</span></button>
        ${drawerOpen ? '<div id="v6ShellDrawerBackdrop" class="v6-shell-drawer-backdrop"></div>' : ''}
        <nav id="v6ShellSidebar" class="v6-shell-sidebar${drawerOpen ? ' is-open' : ''}" aria-label="Fleet navigation">
          <button type="button" id="v6ShellDrawerClose" class="btn btn-secondary btn-small v6-shell-drawer-close" aria-label="Close menu" title="Close"><span aria-hidden="true">✕</span></button>
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
            rename: { key: sidebarRenameKey, draft: sidebarRenameDraft, warning: sidebarRenameWarning },
            memberInfo: (seatId) => {
              const row = projectRows.get(String(seatId));
              return row ? memberIndicators(row, engineHealth) : null;
            }
          }) : '<p class="v6-sidebar-empty">No projects match these filters.</p>'}
          ${sidebarCollapsed ? '' : '<div id="v6SidebarResizeHandle" class="v6-sidebar-resize-handle" role="separator" aria-orientation="vertical" '
            + 'aria-label="Resize Fleet sidebar" aria-valuenow="' + sidebarWidth + '" aria-valuemin="' + V6_SIDEBAR_MIN_WIDTH + '" aria-valuemax="' + V6_SIDEBAR_MAX_WIDTH + '" '
            + 'tabindex="0" title="Drag, or use arrow keys, to resize" '
            + 'style="position:absolute;top:0;right:-6px;bottom:0;width:12px;cursor:col-resize;z-index:5;touch-action:none;"></div>'}
        </nav>
        ${inChat ? '' : telemetryHeaderMarkup(telemetry)}
        <main id="v6ShellMain" class="v6-shell-view" tabindex="-1" aria-label="${escapeHtml(title)}">
          ${workspaceModeBarMarkup(workspaceMode)}
          <div class="v6-shell-header">
            ${sidebarCollapsed ? `<button type="button" id="v6SidebarExpand" class="btn btn-secondary v6-sidebar-expand"
              data-action="toggle-sidebar-drawer" aria-controls="v6ShellSidebar" aria-expanded="false">» Show Fleet</button>` : ''}
            <h1 class="v6-shell-title">${escapeHtml(title)}</h1>
          </div>
          <div id="v6ShellDetail" role="tabpanel" aria-labelledby="v6WorkspaceMode-chat"${shown.detail ? '' : ' hidden'}>${detailMarkup(detail, {
            draft: chatDrafts.get(chatTargetKey()) || '', hoodOpen: chatHoodOpen, hoodFullScreen, hoodInteractive, streamPinned,
            fleetArmed: fleetArmedKey != null && fleetArmedKey === chatTargetKey(),
            rename: renameOpenKey != null && renameOpenKey === chatTargetKey()
              ? { open: true, draft: renameDraft, warning: renameWarning } : null,
            sidebarCollapsed, activityElapsed, telemetry, dismissedQuestions: dismissedFor(chatTargetKey()),
            dismissedTodoItems: dismissedTodoFor(chatTargetKey()),
            dismissedFleetTargets: dismissedFleetFor(chatTargetKey()),
            collapsedWaitingOn: collapsedWaitingOnFor(chatTargetKey()),
            knownProjects: [...projectRows.values()],
            queuedPrompts: chatQueues.get(chatTargetKey()) || [],
            pending: pendingSends.filter((p) => p.key === chatTargetKey()),
            verbosity, autoPreview, hideHoodTraffic
          })}</div>
          <div id="v6ShellWizard" role="tabpanel" aria-labelledby="v6WorkspaceMode-wizard"${shown.wizard ? '' : ' hidden'}>${wizardMarkup(templates, standaloneProjectsNow(), {
            tab: wizardTab, form: wizardForm, templateId: wizardTemplateId, plan: wizardPlan, status: wizardStatus,
            bundledFleetSpecs: bundledFleetSpecs && bundledFleetSpecs.specs, ecosystemDirectory: bundledFleetSpecs && bundledFleetSpecs.ecosystemDirectory,
            fleetSpecPreview: wizardFleetSpecPreview, fleetSpecExport: wizardFleetSpecExport, exportableFleets: exportableFleetsNow()
          })}</div>
          <div id="v6ShellAttestation"${shown.attestation ? '' : ' hidden'}>${modelAttestationMarkup(attestation)}</div>
          <section id="v6WorkspacePanel" class="v6-workspace-panel" role="tabpanel"
            aria-labelledby="v6WorkspaceMode-${shown.panel ? workspaceMode : 'sprint'}"${shown.panel ? '' : ' hidden'}>${shown.panel ? panelMarkupNow(workspaceMode) : ''}</section>
        </main>
        ${watermarkFooterMarkup(showWatermark, telemetry, usageMarkupNow())}
      `;
      const shownChat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      paintedQuestions = chatQuestionInner(questionsNow());
      paintedMedusa = medusaIndicatorMarkup(shownChat && shownChat.medusa);
      wireControls();
      restoreViewState(saved);
      if (typeof options.onRender === 'function') options.onRender(currentRoute);
      syncDockedHeader();
      // #3135/#3191: re-applied again here, AFTER the header is docked out
      // of the stream's own flow (moving it can change the stream's and
      // the Under the Hood group's own scrollHeight) — restoreViewState's
      // own pin ran before this and so cannot see that change — and once
      // more on the next frame, by when a thumbnail or unfurl card still
      // expanding one of them has usually settled.
      pinIfPinned();
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
      applySidebarWidthStyle();
      render();
    }

    /**
     * Apply the sidebar's current width as an inline override of
     * `.v6-shell-root`'s own `grid-template-columns` (#3133) — an inline
     * style always wins over the stylesheet's class rule, which is exactly
     * why this clears it to `''` while collapsed instead of also setting
     * `0 1fr` itself: clearing lets the existing `.v6-shell-root--sidebar-
     * collapsed` rule (that inline style would otherwise always shadow)
     * keep doing the collapsing.
     */
    function applySidebarWidthStyle() {
      if (root && root.style) root.style.setProperty('grid-template-columns', sidebarCollapsed ? '' : `${sidebarWidth}px 1fr`);
    }

    /**
     * Persist the operator's chat drafts (#3133), pruned of anything
     * implausibly large first (see {@link pruneStaleChatDrafts}) so a
     * giant accidental paste is never the thing written to storage.
     */
    function persistChatDrafts() {
      prefs.set('tc_v6_chat_drafts', pruneStaleChatDrafts(Object.fromEntries(chatDrafts)));
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
      // #3204: sessionStorage (tab-scoped), not the shared `prefs`.
      tabPrefs.set('tc_v6_selected_groups', [...selectedGroups]);
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
      /**
       * The optimistic sends still in flight (#3200), drawn at the bottom
       * of their own chat until each one settles — read-only, for
       * {@link createLiveController}'s own `liveView` to fold into the
       * texts a peek poll must never misread as a fresh assistant turn.
       * @returns {Array<{key: string, text: string, id: *}>}
       */
      getPendingSends() { return pendingSends; },
      navigate,
      toggleDrawer,
      isDrawerOpen() { return drawerOpen; },
      toggleSidebar,
      isSidebarCollapsed() { return sidebarCollapsed; },
      selectGroup,
      /**
       * The one fleet `#v6FilterFleet` currently narrows to, or `null` when
       * none/several are selected or it names one gone from the tree
       * (#3154) — the same "exactly one known fleet" reading
       * `filterControlsMarkup` already shows the picker as selected on.
       * @returns {string|null}
       */
      getSelectedFleetId() {
        const known = [...selectedGroups].filter((id) => tree.some((p) => String(p.id) === id));
        return known.length === 1 ? known[0] : null;
      },
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
      /**
       * The live controller's answer to `POST /api/v6/fleet-templates/:id/plan`
       * (#3114), landing in the Wizard's own state — never `detail`. Also
       * sets `wizardTemplateId` from the plan's own field, so a caller
       * that calls this directly (skipping the launch-button click that
       * otherwise sets it first) still gets the plan preview shown.
       * @param {object|null} plan
       */
      setWizardPlan(plan) {
        wizardPlan = plan || null;
        if (plan && plan.templateId != null) wizardTemplateId = String(plan.templateId);
        render();
      },
      /**
       * Feedback for the Wizard's active action (#3114): pending while a
       * create/convert/provision call is in flight, then its outcome.
       * @param {{kind: string, message: string}|null} status
       */
      setWizardStatus(status) { wizardStatus = status && typeof status === 'object' ? status : null; render(); },
      /**
       * The live controller's answer to `GET /api/v6/fleet-templates/bundled-specs`
       * (#3115) — `{specs, ecosystemDirectory}`, landing in the Fleet Spec
       * tab's own state.
       * @param {{specs: object, ecosystemDirectory: object}|null} data
       */
      setBundledFleetSpecs(data) { bundledFleetSpecs = data && typeof data === 'object' ? data : null; render(); },
      /**
       * The live controller's answer to `POST /api/v6/fleet-templates/validate-spec`
       * (#3115): a dry-run preview, or the validator's own errors.
       * @param {{ok: boolean, preview?: object, errors?: Array<object>}|null} preview
       */
      setWizardFleetSpecPreview(preview) { wizardFleetSpecPreview = preview && typeof preview === 'object' ? preview : null; render(); },
      /**
       * The live controller's answer to `GET /api/v6/projects/:id/fleet-spec`
       * (#3115): the exported, sanitized spec.
       * @param {{ok: boolean, spec?: object}|null} result
       */
      setWizardFleetSpecExport(result) { wizardFleetSpecExport = result && typeof result === 'object' ? result : null; render(); },
      /**
       * Reset the Wizard back to its landing tab once a workflow finishes
       * (#3114) — called after a successful create/convert/provision, right
       * before navigating away to the new project/fleet.
       */
      resetWizard() {
        wizardTab = 'templates'; wizardForm = { standalone: {}, convert: {}, templates: {}, fleetSpec: {} };
        wizardTemplateId = null; wizardPlan = null; wizardStatus = null;
        wizardFleetSpecPreview = null; wizardFleetSpecExport = null;
      },
      setAttestation(nextAttestation) { attestation = nextAttestation || null; render(); },
      setDetail(nextDetail) {
        // #3107 (PRR-A R1 C1/C2): the controller's own current.view (what
        // showChat/showSend/sendChat pass here) never carries unfurls — that
        // state lives only in this shell's detail, set via setUnfurl. A
        // bare replacement would silently revert every already-unfurled
        // card back to its unclicked Preview button on the NEXT send or
        // attachment change in the SAME chat. Carry it forward when both
        // the old and new detail name the same project's conversation.
        const oldProjectId = detail && detail.kind === 'conversation' && detail.view && detail.view.project ? detail.view.project.id : null;
        const newProjectId = nextDetail && nextDetail.kind === 'conversation' && nextDetail.view && nextDetail.view.project ? nextDetail.view.project.id : null;
        if (nextDetail && nextDetail.kind === 'conversation' && nextDetail.view && oldProjectId != null && String(oldProjectId) === String(newProjectId)
          && !nextDetail.view.chat.unfurls && detail.view.chat.unfurls) {
          nextDetail = Object.assign({}, nextDetail, { view: Object.assign({}, nextDetail.view, { chat: Object.assign({}, nextDetail.view.chat, { unfurls: detail.view.chat.unfurls }) }) });
        }
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
       *   medusa?: object|null, statusBusy?: boolean}} update - `statusBusy` (#3167) is the
       *   session status poll's own idle===false signal, read by chatBusyLabel alongside
       *   live.activity; omitted (not merely falsy) keeps whatever is already on screen.
       */
      setLive(update) {
        if (!detail || detail.kind !== 'conversation' || !detail.view) return;
        const peek = update ? update.peek : null;
        const live = update && update.live ? update.live : null;
        const name = String((detail.view.project && detail.view.project.name) || '');
        const medusa = update && 'medusa' in update ? update.medusa : detail.view.chat && detail.view.chat.medusa;
        const thumbs = update && update.thumbs ? update.thumbs : (detail.view.chat && detail.view.chat.thumbs);
        const statusBusy = update && 'statusBusy' in update ? update.statusBusy : (detail.view.chat && detail.view.chat.statusBusy);
        detail = Object.assign({}, detail, {
          view: Object.assign({}, detail.view, { chat: Object.assign({}, detail.view.chat, { peek, live, medusa, thumbs, statusBusy }) })
        });
        const traffic = doc.getElementById('v6ChatSwitchboard');
        if (traffic) traffic.innerHTML = switchboardMarkup(switchboardItems(detail.view.events, live));
        paintMedusa(medusa);
        const peekEl = doc.getElementById('v6ChatPeek');
        if (peekEl) {
          // #3135 (PRR-B R1 blocking 2a): a plain innerHTML replace here
          // dropped the live-CLI indicator every 4s poll while Interactive
          // Mode was on — it is not part of `chatPeekMarkup`'s own markup,
          // the same way the full render draws it, so it is restored here too.
          peekEl.innerHTML = (hoodInteractive
            ? '<span id="v6ChatHoodLiveIndicator" style="color:#9CF732;display:block;">LIVE CLI — Type directly into pane</span>'
            : '') + chatPeekMarkup(peek, { hideTraffic: hideHoodTraffic });
        }
        const liveEl = doc.getElementById('v6ChatLive');
        if (liveEl) liveEl.innerHTML = liveTurnsMarkup(live ? live.turns : [], name, verbosity, thumbsNow(), unfurlsNow());
        wireRichPreviews(); // #3107 (PRR-A R1 C1/C2): setLive runs on every live poll — the bug this finding is actually about.
        paintTucked(live);
        paintRecorded();
        paintQuestions();
        paintWaitingOnExtras();
        const a = doc.getElementById('v6ChatActivity');
        const elapsed = syncBusy();
        const label = busyLabelNow();
        if (a) {
          a.innerHTML = chatActivityInner(label, elapsed);
          a.className = `v6-chat-activity${label ? ' is-busy' : ''}`;
        }
        // #3167: the Under the Hood header badge mirrors #v6ChatActivity's
        // own busy state, so it is visible even while the drawer is open
        // and the activity line's own pill (above the composer) is off
        // screen below the raw pane.
        const uth = doc.getElementById('v6UthStatus');
        if (uth) {
          uth.className = `v6-uth-status${label ? ' v6-uth-status--busy' : ''}`;
          uth.textContent = label ? 'Working' : '';
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
       * server's warning with a Rename anyway button. `options.onRenameProject`
       * always reports here whoever asked, so `renameResultFor` (#3136) says
       * which of the three in-flight shapes this particular result is for —
       * the chat header's own form, the sidebar's single-row form, or one
       * leg of a fleet's bulk rename, settled through `fleetRenameWait`
       * instead of touched here at all.
       * @param {{ok: boolean, warning?: string|null}} result
       */
      renameResult(result) {
        if (renameResultFor === 'fleet') {
          const resolve = fleetRenameWait;
          fleetRenameWait = null;
          if (typeof resolve === 'function') resolve(result);
          return;
        }
        if (renameResultFor === 'sidebar') {
          if (result && result.ok) {
            sidebarRenameKey = null;
            sidebarRenameDraft = null;
            sidebarRenameWarning = null;
          } else {
            sidebarRenameWarning = (result && result.warning) || null;
          }
          render();
          return;
        }
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
      clearChatDraft(projectId) {
        chatDrafts.delete(projectId != null ? String(projectId) : chatTargetKey());
        persistChatDrafts();
      },
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
        persistChatDrafts();
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
          persistChatDrafts();
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
        if (liveEl) liveEl.innerHTML = liveTurnsMarkup(view.chat.live ? view.chat.live.turns : [], String((view.project && view.project.name) || ''), verbosity, thumbsNow(), unfurlsNow());
        wireRichPreviews(); // #3107 (PRR-A R1 C1/C2): same targeted-redraw gap as setLive's.
        paintTucked(view.chat.live);
        paintRecorded();
      },
      /**
       * One link's unfurl state changed (#3107): `'loading'` the moment the
       * viewer clicks Preview, then `'done'`/`'error'` once the fetch
       * resolves. Called both externally (the live controller, once the
       * fetch resolves) and internally ({@link wireRichPreviews}' own click
       * handler, to show "Loading…" immediately) — see {@link setUnfurl}
       * (the plain internal function this delegates to; same split
       * {@link setWorkspaceMode} already uses for the same reason).
       * @param {string} url
       * @param {{state: ('loading'|'done'|'error'), preview?: object}} entry
       */
      setUnfurl(url, entry) { setUnfurl(url, entry); },
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
       * Queue a prompt for `Waiting on: AI` (#3105): called by the page's
       * own `sendChat` when a plain (non-forced) submit lands while that
       * project's chat is already busy — the operator can then ⚡ Force it
       * or ✕ dismiss it from the panel rather than only seeing the
       * "Not sent yet" warning line.
       * @param {*} projectId
       * @param {string} text
       */
      queuePrompt(projectId, text) {
        const key = projectId != null ? String(projectId) : null;
        const trimmed = String(text || '').trim();
        if (key == null || !trimmed) return;
        const list = chatQueues.get(key) || [];
        list.push({ id: `${key}-${now()}-${++queueSeq}`, text: trimmed });
        chatQueues.set(key, list);
        if (chatTargetKey() === key) render();
      },
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
      /**
       * The automated CLI usage probe's latest snapshot and configured
       * refresh cadence (#3132, `GET /api/usage/probe`'s own shape):
       * redraws the meter, same as {@link setUsage}.
       * @param {{usage: {claude, codex, antigravity}, interval: string}|null} data
       */
      setUsageProbe(data) {
        usageProbe = data && data.usage ? data.usage : null;
        usageProbeInterval = (data && data.interval) || usageProbeInterval;
        paintUsage();
      },
      /**
       * What the probe's Refresh-now button and interval selector call
       * (#3132): `refresh()` resolving to `{ok, error?}`, `setInterval(value)`
       * resolving to `{ok, interval?, error?}`. Handed over the same way
       * {@link setUsageActions} is.
       * @param {{refresh: Function, setInterval: Function}} actions
       */
      setUsageProbeActions(actions) { usageProbeActions = actions || null; },
      /** @returns {string} The workspace mode shown (#3086). */
      getWorkspaceMode() { return workspaceMode; },
      /** @param {string} mode - Switch the workspace mode in place (#3086). */
      setWorkspaceMode(mode) { setWorkspaceMode(mode); },
      /**
       * Register the controller's panel loader (#3086), called with a data
       * mode whenever that mode is shown; asked at once when the shell
       * already shows one.
       * @param {function(string): void} loader
       */
      setWorkspaceLoader(loader) {
        workspaceLoader = typeof loader === 'function' ? loader : null;
        if (workspaceVisibility(workspaceMode, Boolean(detail && detail.kind === 'conversation')).panel) loadWorkspacePanel(workspaceMode);
      },
      /**
       * Register the controller's train launch actions (#3088). Each takes the
       * read cars list (and the fleet id) and resolves `{ok, message, html?}`.
       * @param {{computeWaves?: Function, checkDisjointness?: Function, startRun?: Function, activateVersion?: Function}} actions
       */
      setWorkspaceActions(actions) { trainActions = actions && typeof actions === 'object' ? actions : null; },
      /**
       * Keep a data mode's panel content (#3086), and paint it when that mode
       * is the one shown; a mode the operator has left keeps it for next time.
       * @param {string} mode
       * @param {string} html - From {@link workspacePanelContent}.
       */
      setWorkspacePanel(mode, html) {
        if (!isWorkspaceMode(mode) || typeof html !== 'string') return;
        workspacePanels.set(mode, html);
        const panel = doc.getElementById('v6WorkspacePanel');
        const shownNow = workspaceVisibility(workspaceMode, Boolean(detail && detail.kind === 'conversation')).panel;
        if (panel && shownNow && workspaceMode === mode) {
          panel.innerHTML = panelMarkupNow(mode);
          wireWorkspacePanel(mode);
        }
      },
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
  global.tcV6WizardMarkup = wizardMarkup;
  global.tcV6WizardStandaloneMarkup = wizardStandaloneMarkup;
  global.tcV6WizardConvertMarkup = wizardConvertMarkup;
  global.tcV6WizardTemplatesMarkup = wizardTemplatesMarkup;
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
  global.tcV6HoodKeyAction = hoodKeyAction;
  global.tcV6FormatElapsed = formatElapsed;
  global.tcV6ExtractLiveTurns = extractLiveTurns;
  global.tcV6IsOperatorEcho = isOperatorEcho;
  global.tcV6CreateChatScrollCoordinator = createChatScrollCoordinator;
  global.tcV6IsSessionStatusBusy = isSessionStatusBusy;
  global.tcV6ChatBusyLabel = chatBusyLabel;
  global.tcV6MessageMarkup = messageMarkup;
  global.tcV6UsageMeterModel = usageMeterModel;
  global.tcV6UsageMeterMarkup = usageMeterMarkup;
  global.tcV6LongPromptCommand = longPromptCommand;
  global.tcV6RecordedText = recordedText;
  global.tcV6ArrangeRecorded = arrangeRecorded;
  global.tcV6EventBodyBytes = eventBodyBytes;
  global.tcV6MedusaIndicatorMarkup = medusaIndicatorMarkup;
  global.tcV6SanitizeUploadName = sanitizeUploadName;
  global.tcV6FilesFromEvent = filesFromEvent;
  global.tcV6MemberIndicators = memberIndicators;
  global.tcV6MemberIndicatorsMarkup = memberIndicatorsMarkup;
  global.tcV6WorkspaceVisibility = workspaceVisibility;
  global.tcV6WorkspaceModeBarMarkup = workspaceModeBarMarkup;
  global.tcV6WorkspacePanelContent = workspacePanelContent;
  global.tcV6CharterPanelContent = charterPanelContent;
  global.tcV6ParseTrainCars = parseTrainCars;
  global.tcV6TrainResultMarkup = trainResultMarkup;
  global.tcV6CharterVersionsMarkup = charterVersionsMarkup;
  global.tcV6TrainControlsMarkup = trainControlsMarkup;
  global.tcV6CreateLiveController = createLiveController;
  global.tcV6ClampSidebarWidth = clampSidebarWidth;
  global.tcV6ClampChatPaneHeights = clampChatPaneHeights;
  global.tcV6TradeChatPaneHeights = tradeChatPaneHeights;
  global.tcV6ChatPaneResizerMarkup = chatPaneResizerMarkup;
  global.tcV6PruneStaleChatDrafts = pruneStaleChatDrafts;
  global.tcV6IsAlwaysPreviewLink = isAlwaysPreviewLink;
  global.tcV6UsageProbeRowMarkup = usageProbeRowMarkup;
  global.tcV6UsageProbeMarkup = usageProbeMarkup;
  global.tcV6ExtractCliGates = extractCliGates;
  global.tcV6FilterPeekTrafficLines = filterPeekTrafficLines;
  global.tcV6ExtractMultiChoice = extractMultiChoice;
  global.tcV6ExtractOperatorTodo = extractOperatorTodo;
  global.tcV6OpenQueuedPrompts = openQueuedPrompts;
  global.tcV6LatestReplyText = latestReplyText;
  global.tcV6WaitingOnModel = waitingOnModel;
  global.tcV6WaitingOnMarkup = waitingOnMarkup;
  global.tcCreateV6Shell = tcCreateV6Shell;
})(typeof window !== 'undefined' ? window : globalThis);
