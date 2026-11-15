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

  /** Reads of a just-sent chat that may show no engine activity before it stops reading as Working (#3057). */
  const AWAIT_REPLY_POLLS = 3;
  const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

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
  function watermarkFooterMarkup(showWatermark, bar) {
    const status = bar && bar.metrics
      ? `<div id="v6ShellStatusBar" class="v6-shell-status-bar" role="status" aria-label="Server status">${TELEMETRY_FOOTER_KEYS.map((key) => telemetryChipMarkup(bar, key)).join('')}</div>`
      : '';
    if (!status) return showWatermark ? '<footer class="v6-shell-watermark" aria-hidden="true">TangleClaw</footer>' : '';
    return `<footer class="v6-shell-watermark has-status">${status}${showWatermark ? '<span class="v6-shell-watermark-mark" aria-hidden="true">TangleClaw</span>' : ''}</footer>`;
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
    if (v.error) {
      stream = `<p class="v6-conversation-empty">${escapeHtml(v.error)}</p>`;
    } else if (v.sessionId == null) {
      stream = '<p class="v6-conversation-empty">No live session — nothing to replay.</p>';
    } else {
      // #3076: a recorded switchboard wake is not the operator speaking; it
      // is shown Under the Hood with the rest of the switchboard's traffic.
      const events = (Array.isArray(v.events) ? v.events : []).filter((e) => !isRecordedWake(e));
      stream = events.length
        ? `<ol class="v6-conversation-stream">${events.map((e) => (
          `<li class="v6-conversation-event is-${escapeHtml(e && e.role)}">
            ${chatRoleMarkup(e && e.role, name)}
            <span class="v6-conversation-content">${escapeHtml(e && e.content)}</span>
          </li>`
        )).join('')}</ol>`
        : (liveTurns.length ? '' : '<p class="v6-conversation-empty">No conversation events recorded for this session yet.</p>');
    }
    // #3052: the replies the session's live output shows, after what is
    // recorded; its own list so a poll can replace it without a re-render.
    stream = `<div id="v6ChatStream" class="v6-chat-stream" tabindex="0">${stream}
      <ol id="v6ChatLive" class="v6-conversation-stream v6-chat-live-turns" aria-label="Live replies">${liveTurnsMarkup(liveTurns, name)}</ol>
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
    // Disabled while a send is in flight too, so a second Enter cannot type
    // the same message into the session twice.
    const disabled = liveSession && !(send && send.kind === 'pending') ? '' : ' disabled';
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
        <summary>🔧 Under the Hood (Raw CLI &amp; Tool Activity)</summary>
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
        <textarea id="v6ChatInput" class="v6-chat-input" name="message" rows="3" aria-label="Message to ${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}"${disabled}>${escapeHtml(chat.draft || '')}</textarea>
        <div class="v6-chat-composer-actions">
          <button type="button" id="v6ChatAttachBtn" class="btn btn-secondary btn-small v6-chat-attach-btn" aria-label="Attach files (or drop or paste them into the message)">📎 Attach</button>
          <input type="file" id="v6ChatFileInput" class="v6-chat-file-input" multiple hidden>
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

  /** A pane line that sends a Medusa message: outbound traffic (#3076). */
  const MEDUSA_SEND = /\btc\s+message\s+send\b/;

  /** A markdown list marker in front of a question (#3079): `1.`, `2)`, `-`, `*`, `•`. */
  const QUESTION_PREFIX = /^(?:\d+[.)]|[-*•])\s+/;

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
   * questions are every line of the newest assistant turn that ends in `?`,
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
    const sent = (Array.isArray(knownUserTexts) ? knownUserTexts : []).map(squash).filter(Boolean);
    const knownLines = new Set((Array.isArray(knownUserTexts) ? knownUserTexts : [])
      .flatMap((t) => String(t).split('\n')).map((t) => t.trim()).filter(Boolean));
    const recordedAs = (said) => {
      const one = squash(said);
      if (knownLines.has(said)) return sent.find((m) => m.includes(one)) || one;
      return one.length >= 20 ? sent.find((m) => m.startsWith(one)) || null : null;
    };
    let echo = null;
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
    const flush = () => {
      if (reply.length) {
        turns.push({ role: 'assistant', text: reply.join('\n') });
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
      if (!text) return;
      const indented = /^\s/.test(line);
      // The rest of a wrapped wake: indented under it (#3076).
      if (indented && block === 'wake') {
        const last = switchboard[switchboard.length - 1];
        last.text = `${last.text} ${text}`;
        return;
      }
      const prompt = LIVE_PROMPT.exec(text);
      const promptText = prompt && !indented ? prompt[1].trim() : '';
      if (SWITCHBOARD_TEXT.test(promptText) || SWITCHBOARD_TEXT.test(text)) {
        // A wake is the switchboard speaking, not the operator: it neither
        // answers a question nor ends the reply it interrupts.
        switchboard.push({ dir: 'in', text: promptText || text });
        // Only a typed wake wraps like a prompt; what is indented under a
        // bare notice line is still the reply's (cumulative review, #3052).
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
          echo = recordedAs(said);
          if (!echo) turns.push({ role: 'user', text: said });
        }
        return;
      }
      // The rest of a recorded message the pane is still echoing.
      if (echo && (knownLines.has(text) || echo.includes(squash(text)))) return;
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
    const open = last && last.role === 'assistant' && !answered ? last.text : '';
    const tail = open ? open.split('\n').pop() : '';
    const questions = open.split('\n').map((l) => l.trim().replace(QUESTION_PREFIX, '').trim())
      .filter((l) => /\?\s*$/.test(l));
    return { turns, question: /\?\s*$/.test(tail) ? tail : null, questions, activity, switchboard };
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
   * The live replies (#3052) as conversation bubbles, marked `is-live` because
   * they come from the pane, not the record.
   * @param {Array<{role: string, text: string}>} turns
   * @param {string} name
   * @returns {string} HTML list items.
   */
  function liveTurnsMarkup(turns, name) {
    return (Array.isArray(turns) ? turns : []).map((t) => (
      `<li class="v6-conversation-event is-${escapeHtml(t && t.role)} is-live">${chatRoleMarkup(t && t.role, name)}<span class="v6-conversation-content">${escapeHtml(t && t.text)}</span></li>`
    )).join('');
  }

  /**
   * How a dismissed question is remembered (#3079): with the reply that
   * asked it, so the same words asked again in a later reply still show.
   * @param {{turns?: Array<{role: string, text: string}>}|null} live
   * @param {string} question
   * @returns {string}
   */
  function questionKey(live, question) {
    const turns = live && Array.isArray(live.turns) ? live.turns : [];
    const last = turns[turns.length - 1];
    return `${last && last.role === 'assistant' ? last.text : ''}\u0001${question}`;
  }

  /**
   * The questions still waiting on the operator (#3079): the live view's
   * queue (or its one question, from a caller that predates the queue),
   * less any the operator dismissed.
   * @param {{question?: string|null, questions?: string[], turns?: Array}|null} live
   * @param {string[]} [dismissed] - {@link questionKey}s dismissed in this chat.
   * @returns {string[]}
   */
  function openQuestions(live, dismissed) {
    if (!live) return [];
    const all = Array.isArray(live.questions) ? live.questions : (live.question ? [live.question] : []);
    const gone = new Set(Array.isArray(dismissed) ? dismissed : []);
    return all.filter((q) => typeof q === 'string' && q && !gone.has(questionKey(live, q)));
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
    const state = MEDUSA_STATE_LABELS[medusa.state] ? medusa.state : 'off';
    const unread = Math.max(0, Number(medusa.unread) || 0);
    const inbound = Math.max(0, Number(medusa.inbound) || 0);
    const outbound = Math.max(0, Number(medusa.outbound) || 0);
    const tip = `Medusa: ${MEDUSA_STATE_LABELS[state]}${state === 'error' && medusa.lastError ? ` (${medusa.lastError})` : ''}`
      + ` · ${unread} unread · on screen: ${inbound} in, ${outbound} out — open Under the Hood for the traffic`;
    const flow = (medusa.flowIn ? ' is-flow-in' : '') + (medusa.flowOut ? ' is-flow-out' : '');
    return `<button type="button" id="v6ChatMedusa" class="v6-chat-medusa is-${state}${flow}" aria-controls="v6ChatUnderHood"
        title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
        <img class="v6-medusa-head v6-medusa-head--in" src="/medusa-head-left.webp" alt="" width="16" height="19">
        <span id="v6ChatMedusaBadge" class="v6-chat-medusa-badge${unread ? ' has-unread' : ''}" aria-hidden="true">${unread ? escapeHtml(String(unread)) : '@'}</span>
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
   *   engine: {code: string, name: string, health: string}|null}}
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
    let engine = null;
    if (r.engine && r.engine.id) {
      const id = String(r.engine.id);
      const status = health && health[id] && ENGINE_HEALTH.includes(health[id].status) ? health[id].status : 'unknown';
      engine = { code: ENGINE_CODES[id] || id.slice(0, 2).toUpperCase(), name: String(r.engine.name || id), health: status };
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
      ? `<span class="v6-member-ai-status is-${info.engine.health}" title="${escapeHtml(info.engine.name)}: ${info.engine.health === 'unknown' ? 'status unknown' : info.engine.health}">${escapeHtml(info.engine.code)}</span>`
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
    return evt && evt.key === 'Enter' && !evt.shiftKey && !evt.isComposing ? 'send' : null;
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
      const v = detail.view || {};
      // #3063: in a chat the telemetry bar shares the chat's header row.
      const telemetry = extras && 'telemetry' in extras ? extras.telemetry : undefined;
      return conversationViewMarkup(Object.assign({}, v, {
        chat: Object.assign({}, v.chat, { draft, hoodOpen, fleetArmed, sidebarCollapsed, activityElapsed, telemetry, rename, dismissedQuestions })
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
      if (res && Array.isArray(res.lines)) {
        const engine = project && project.engine && project.engine.id ? String(project.engine.id) : '';
        const said = (Array.isArray(events) ? events : []).filter((e) => e && e.role === 'user').map((e) => e.content);
        live = extractLiveTurns(res.lines, engine, said);
      }
      return awaitReply(live, project);
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
        send: sendOutcome || null
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
      // #3076: the listener's state and unread count. This read records
      // nothing and clears nothing, unlike opening the inbox.
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
      chat.medusa = medusaView(medusaStatus, chat.live, null);
      current.view = events
        ? { project, sessionId, events: events.events, chat }
        : { project, sessionId, error: 'Could not load this session’s conversation events.', chat };
      shell.setAttestation(pickAttestation(attestations && attestations.attestations, project));
      showChat(shell);
      if (startTimer) {
        pollId = startTimer(async () => {
          if (mine !== seq) { stopPolling(); return; }
          const [res, nextStatus] = await Promise.all([api(peekUrl), api(medusaUrl)]);
          if (mine !== seq || !current || !current.view) return;
          const next = peekView(res);
          const nextLive = liveView(res, current.project, current.view.events);
          const nextMedusa = medusaView(nextStatus, nextLive, current.view.chat && current.view.chat.medusa);
          current.view = Object.assign({}, current.view, { chat: Object.assign({}, current.view.chat, { peek: next, live: nextLive, medusa: nextMedusa }) });
          const sh = getShell();
          if (sh && typeof sh.setLive === 'function') sh.setLive({ peek: next, live: nextLive, medusa: nextMedusa });
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
    async function sendChat(text) {
      const typed = String(text || '').trim();
      const chat = current;
      if (!chat || chat.sending || !getShell()) return;
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
      chat.sending = true;
      try {
        await deliverChat(chat, message, name);
      } finally {
        chat.sending = false;
      }
    }

    /**
     * The send itself, once {@link sendChat} has claimed it.
     * @param {object} chat - `current` at send time.
     * @param {string} message
     * @param {string} name - The target project's name.
     * @returns {Promise<void>}
     */
    async function deliverChat(chat, message, name) {
      showSend({ kind: 'pending', message: `Sending to ${name}…` });
      const before = chat.view && chat.view.chat ? lastReply(chat.view.chat.live) : null;
      const sent = await apiMutate(`/api/sessions/${encodeURIComponent(name)}/command`, 'POST', { command: message, enter: true });
      if (sent) awaitingReply = { projectId: String(chat.project.id), reply: before, reads: 0 };
      // Once it is in the session the draft is spent, even if the operator
      // has moved to another chat meanwhile: left saved, it would come back
      // pre-filled and one Enter would send it twice.
      const shellNow = getShell();
      if (sent && shellNow && typeof shellNow.clearChatDraft === 'function') shellNow.clearChatDraft(chat.project.id);
      if (sent) attachments.delete(String(chat.project.id));
      if (!sent) {
        if (chat === current) showSend({ kind: 'error', message: `Not sent: ${api.lastError || 'the server refused it'}` });
        return;
      }
      // A delivered message is recorded against the chat it was sent from,
      // even if the operator has moved on: the conversation must not lose
      // what the session received. Only the on-screen update waits on the
      // operator still being here.
      const recorded = await recordUserEvent(chat, message);
      if (chat !== current) return;
      await loadConversation(chat.project, chat.mine, chat.ctx, recorded === true
        ? { kind: 'ok', message: `Sent to ${name}.` }
        : { kind: 'warning', message: `Sent to ${name}, but it could not be recorded in the conversation: ${recorded}` });
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
    // #3079: the questions dismissed in each chat, keyed with the reply
    // that asked them, so a poll that reads the same reply again does not
    // bring them back.
    const dismissedQuestions = new Map();
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
          if (chatKeyAction(evt) !== 'send') return;
          if (typeof evt.preventDefault === 'function') evt.preventDefault();
          submitChat();
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
      return key != null && dismissedQuestions.has(key) ? [...dismissedQuestions.get(key)] : [];
    }

    /** @returns {string[]} The questions the chat on screen still shows (#3079). */
    function questionsNow() {
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      return openQuestions(chat && chat.live, dismissedFor(chatTargetKey()));
    }

    /**
     * Put away questions in the chat on screen (#3079) and redraw the slot.
     * @param {string[]} texts
     */
    function dismissQuestions(texts) {
      const key = chatTargetKey();
      if (key == null || !texts.length) return;
      const chat = detail && detail.view ? detail.view.chat : null;
      const set = dismissedQuestions.get(key) || new Set();
      texts.forEach((t) => set.add(questionKey(chat && chat.live, t)));
      dismissedQuestions.set(key, set);
      paintQuestions();
    }

    /** Redraw the question slot in place and wire its ✕ buttons. */
    function paintQuestions() {
      const q = doc.getElementById('v6ChatQuestion');
      if (!q) return;
      const list = questionsNow();
      q.innerHTML = chatQuestionInner(list);
      q.className = `v6-chat-question${list.length ? ' is-asking' : ''}`;
      wireQuestions();
    }

    /** Each question's ✕ dismisses that question (#3079). */
    function wireQuestions() {
      const list = questionsNow();
      list.forEach((text, i) => {
        const btn = doc.getElementById(`v6ChatQuestionDismiss${i}`);
        if (btn) btn.addEventListener('click', () => dismissQuestions([text]));
      });
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
    function submitChat() {
      const input = doc.getElementById('v6ChatInput');
      const text = String((input && typeof input.value === 'string' ? input.value : chatDrafts.get(chatTargetKey())) || '').trim();
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      const hasFiles = Boolean(chat && Array.isArray(chat.attachments) && chat.attachments.some((a) => a && a.status !== 'error'));
      if ((!text && !hasFiles) || typeof options.onSendChat !== 'function') return;
      // #3079: sending is the operator answering; the queue clears.
      dismissQuestions(questionsNow());
      options.onSendChat(text);
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
      const title = routeTitle(currentRoute);
      shownTree = filterTree(tree, { text: filterText, engine: filterEngine, groups: selectedGroups }, projectRows);
      // #3053: the template wizard and attestation pills are not chat
      // content; they stay in the page (and wired) but out of sight.
      const inChat = Boolean(detail && detail.kind === 'conversation');
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
          <div class="v6-shell-header">
            ${sidebarCollapsed ? `<button type="button" id="v6SidebarExpand" class="btn btn-secondary v6-sidebar-expand"
              data-action="toggle-sidebar-drawer" aria-controls="v6ShellSidebar" aria-expanded="false">» Show Fleet</button>` : ''}
            <h1 class="v6-shell-title">${escapeHtml(title)}</h1>
          </div>
          <div id="v6ShellDetail">${detailMarkup(detail, {
            draft: chatDrafts.get(chatTargetKey()) || '', hoodOpen: chatHoodOpen,
            fleetArmed: fleetArmedKey != null && fleetArmedKey === chatTargetKey(),
            rename: renameOpenKey != null && renameOpenKey === chatTargetKey()
              ? { open: true, draft: renameDraft, warning: renameWarning } : null,
            sidebarCollapsed, activityElapsed, telemetry, dismissedQuestions: dismissedFor(chatTargetKey())
          })}</div>
          <div id="v6ShellWizard"${inChat ? ' hidden' : ''}>${fleetWizardMarkup(templates)}</div>
          <div id="v6ShellAttestation"${inChat ? ' hidden' : ''}>${modelAttestationMarkup(attestation)}</div>
        </main>
        ${watermarkFooterMarkup(showWatermark, telemetry)}
      `;
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
        detail = Object.assign({}, detail, {
          view: Object.assign({}, detail.view, { chat: Object.assign({}, detail.view.chat, { peek, live, medusa }) })
        });
        const traffic = doc.getElementById('v6ChatSwitchboard');
        if (traffic) traffic.innerHTML = switchboardMarkup(switchboardItems(detail.view.events, live));
        const slot = doc.getElementById('v6ChatMedusaSlot');
        if (slot) {
          slot.innerHTML = medusaIndicatorMarkup(medusa);
          wireMedusa();
        }
        const peekEl = doc.getElementById('v6ChatPeek');
        if (peekEl) {
          const atBottom = isAtBottom(peekEl);
          peekEl.innerHTML = chatPeekMarkup(peek);
          if (atBottom) pinToBottom(peekEl);
        }
        const stream = doc.getElementById('v6ChatStream');
        const streamAtBottom = isAtBottom(stream);
        const liveEl = doc.getElementById('v6ChatLive');
        if (liveEl) liveEl.innerHTML = liveTurnsMarkup(live ? live.turns : [], name);
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
      destroy() {
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
  global.tcV6MedusaIndicatorMarkup = medusaIndicatorMarkup;
  global.tcV6SanitizeUploadName = sanitizeUploadName;
  global.tcV6FilesFromEvent = filesFromEvent;
  global.tcV6MemberIndicators = memberIndicators;
  global.tcV6CreateLiveController = createLiveController;
  global.tcCreateV6Shell = tcCreateV6Shell;
})(typeof window !== 'undefined' ? window : globalThis);
