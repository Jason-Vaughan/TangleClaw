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
   *   collapsed?: Array<string>|Set<string>}} [opts]
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
        const memberItems = fleetFolded ? '' : fleet.members.map((m) => {
          const label = `${escapeHtml(m.role)} (${escapeHtml(m.seatId)})`;
          if (!m.seatId) return `<li class="v6-shell-member">${label}</li>`;
          const memberActive = activeResourceId === String(m.seatId);
          const memberHash = routeHash({ view: 'conversation', resourceId: m.seatId });
          return `<li class="v6-shell-member"><a class="v6-shell-member-link${memberActive ? ' is-active' : ''}"
            aria-current="${memberActive ? 'page' : 'false'}"
            href="${escapeHtml(memberHash)}" data-route="${escapeHtml(memberHash)}">${label}</a></li>`;
        }).join('');
        const fleetToggle = fleet.members.length
          ? treeToggleMarkup(`v6TreeToggle-f${pi}-${fi}`, fleetNodeKey(project, fleet), fleet.displayName, fleetFolded)
          : '';
        return `<li>
          <div class="v6-tree-row">${fleetToggle}<a class="v6-shell-fleet${fleetActive ? ' is-active' : ''}"
             aria-current="${fleetActive ? 'page' : 'false'}"
             href="${escapeHtml(fleetHash)}" data-route="${escapeHtml(fleetHash)}">${escapeHtml(fleet.displayName)}</a></div>
          ${memberItems ? `<ul class="v6-shell-members">${memberItems}</ul>` : ''}
        </li>`;
      }).join('');
      const projectToggle = project.fleets.length
        ? treeToggleMarkup(`v6TreeToggle-p${pi}`, projectNodeKey(project), project.displayName, projectFolded)
        : '';
      return `<li>
        <div class="v6-tree-row">${projectToggle}<a class="v6-shell-project${projectActive ? ' is-active' : ''}"
           aria-current="${projectActive ? 'page' : 'false'}"
           href="${escapeHtml(projectHash)}" data-route="${escapeHtml(projectHash)}">${escapeHtml(project.displayName)}</a></div>
        ${fleetItems ? `<ul class="v6-shell-fleets">${fleetItems}</ul>` : ''}
      </li>`;
    }).join('');
    return `<ul class="v6-shell-tree">${items}</ul>`;
  }

  /**
   * Every fold key in `tree`: one per project and one per fleet that has
   * something to fold — what "Collapse all" folds.
   * @param {ReturnType<typeof buildHierarchyTree>} tree
   * @returns {string[]}
   */
  function allNodeKeys(tree) {
    const keys = [];
    (Array.isArray(tree) ? tree : []).forEach((project) => {
      if (project.fleets.length) keys.push(projectNodeKey(project));
      project.fleets.forEach((fleet) => { if (fleet.members.length) keys.push(fleetNodeKey(project, fleet)); });
    });
    return keys;
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
   * The sidebar's filter controls (#3046): text search, an engine select
   * (one option per engine a project runs), a pill per logical project, a
   * Multi toggle and All. Ids are positional for the same reason the fold
   * toggles' are.
   * @param {{tree: ReturnType<typeof buildHierarchyTree>, engines: string[], text: string,
   *   engine: string, groups: Set<string>, multi: boolean}} view
   * @returns {string} HTML.
   */
  function filterControlsMarkup(view) {
    const engineOptions = ['<option value="">All Engines</option>'].concat(view.engines.map((id) => (
      `<option value="${escapeHtml(id)}"${id === view.engine ? ' selected' : ''}>${escapeHtml(id)}</option>`
    ))).join('');
    const pills = view.tree.map((project, i) => {
      const on = view.groups.has(String(project.id));
      return `<button type="button" id="v6GroupPill-${i}" class="v6-filter-pill${on ? ' is-active' : ''}"
        data-group-id="${escapeHtml(project.id)}" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(project.displayName)}</button>`;
    }).join('');
    return `<div class="v6-sidebar-filters" role="search" aria-label="Filter the fleet tree">
      <input type="search" id="v6FilterSearch" class="filter-input v6-filter-search" placeholder="Filter…"
        aria-label="Filter projects by name" autocomplete="off" spellcheck="false" value="${escapeHtml(view.text)}">
      <select id="v6FilterEngine" class="filter-input v6-filter-engine" aria-label="Filter by engine">${engineOptions}</select>
      <div class="v6-filter-pills" role="group" aria-label="Show projects">
        <button type="button" id="v6FilterAll" class="v6-filter-pill${view.groups.size ? '' : ' is-active'}"
          aria-pressed="${view.groups.size ? 'false' : 'true'}">All</button>
        ${pills}
        <button type="button" id="v6FilterMulti" class="v6-filter-pill v6-filter-multi${view.multi ? ' is-active' : ''}"
          data-action="toggle-multi-filter" aria-pressed="${view.multi ? 'true' : 'false'}"
          title="Select several projects at once (or Ctrl/Cmd/Shift-click a pill)">Multi</button>
      </div>
    </div>`;
  }

  const isBoolean = (v) => typeof v === 'boolean';
  const isStringMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).every((k) => typeof v[k] === 'string');

  /** How often an open chat re-reads its session's live output (#3047). */
  const CHAT_POLL_MS = 4000;
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
   * Render a B4 telemetry bar snapshot (#2981 B4 render hook) — the exact
   * shape `lib/v6/b4-telemetry-header.js#assembleTelemetryBar` returns, so
   * a future BRIDGE-2b route can feed this directly with no reshaping.
   * @param {{scope?: string, metrics?: Record<string, {value: *, confidence: string}>}|null} bar
   * @returns {string} HTML.
   */
  function telemetryHeaderMarkup(bar) {
    if (!bar || !bar.metrics) {
      return '<div class="v6-telemetry-header is-unavailable" role="status" aria-label="Telemetry unavailable"></div>';
    }
    const chips = Object.keys(TELEMETRY_METRIC_LABELS).map((key) => {
      const metric = bar.metrics[key] || { value: null, confidence: 'unavailable' };
      const label = TELEMETRY_METRIC_LABELS[key];
      const valueText = metric.value == null ? '—' : escapeHtml(String(metric.value));
      return `<span class="v6-telemetry-chip is-${escapeHtml(metric.confidence)}" title="${escapeHtml(label)}">
        <span class="v6-telemetry-label">${escapeHtml(label)}</span>
        <span class="v6-telemetry-value">${valueText}</span>
      </span>`;
    }).join('');
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
   * @param {boolean} showWatermark
   * @returns {string} HTML, or `''` when the watermark is off.
   */
  function watermarkFooterMarkup(showWatermark) {
    if (!showWatermark) return '';
    return '<footer class="v6-shell-watermark" aria-hidden="true">TangleClaw</footer>';
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
   * Render the B2 Conversation View for one legacy project (#3022
   * deliverable e): its replayed conversation events and an ADR 0026
   * "Open Hood" link to the live terminal page. With no live session it
   * says so instead of rendering an empty stream that reads as "no
   * messages yet".
   * @param {{project: {id?: *, name?: string}|null, sessionId?: number|null,
   *   events?: Array<{seq?: number, role?: string, content?: string, redacted?: number}>|null,
   *   error?: string|null}} view
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
    const hoodHref = `/session.html?project=${encodeURIComponent(name)}`;
    const chat = v.chat || {};
    const status = CHAT_STATUS_LABELS[chat.status] ? chat.status : (v.sessionId == null ? 'offline' : 'active');
    const live = status !== 'offline';
    let stream;
    if (v.error) {
      stream = `<p class="v6-conversation-empty">${escapeHtml(v.error)}</p>`;
    } else if (v.sessionId == null) {
      stream = '<p class="v6-conversation-empty">No live session — nothing to replay.</p>';
    } else {
      const events = Array.isArray(v.events) ? v.events : [];
      stream = events.length
        ? `<ol class="v6-conversation-stream">${events.map((e) => (
          `<li class="v6-conversation-event is-${escapeHtml(e && e.role)}">
            <span class="v6-conversation-role">${escapeHtml(e && e.role)}</span>
            <span class="v6-conversation-content">${escapeHtml(e && e.content)}</span>
          </li>`
        )).join('')}</ol>`
        : '<p class="v6-conversation-empty">No conversation events recorded for this session yet.</p>';
    }
    const delegateMode = chat.mode === 'delegate';
    const title = delegateMode && chat.nodeName ? chat.nodeName : name;
    const session = v.sessionId != null ? ` (#${escapeHtml(v.sessionId)})` : '';
    const members = Array.isArray(chat.members) ? chat.members : [];
    const delegatePicker = delegateMode && members.length
      ? `<label class="v6-chat-delegate-label">Delegate
          <select id="v6ChatDelegate" class="filter-input v6-chat-delegate" data-action="change-project-delegate"
            aria-label="Choose who this project's chat talks to">${members.map((m) => (
              `<option value="${escapeHtml(m.id)}"${String(m.id) === String(v.project.id) ? ' selected' : ''}>${escapeHtml(m.name)}</option>`
            )).join('')}</select>
        </label>`
      : '';
    const toDelegate = !delegateMode && chat.delegate && chat.nodeId != null && String(chat.delegate.id) !== String(v.project.id)
      ? `<a id="v6ChatToDelegate" class="btn btn-secondary btn-small"
          href="${escapeHtml(routeHash({ view: 'project', projectId: chat.nodeId }))}">Switch to Delegate: ${escapeHtml(chat.delegate.name)}</a>`
      : '';
    const send = chat.send && CHAT_SEND_KINDS.includes(chat.send.kind) ? chat.send : null;
    // Disabled while a send is in flight too, so a second Enter cannot type
    // the same message into the session twice.
    const disabled = live && !(send && send.kind === 'pending') ? '' : ' disabled';
    const placeholder = `Message ${name}… (Enter to send, Shift+Enter for newline)`;
    return `<section class="v6-conversation v6-chat" aria-label="Conversation — ${escapeHtml(name)}">
      <header class="v6-chat-header">
        <h2 class="v6-detail-title">${escapeHtml(title)}</h2>
        <p class="v6-chat-talking-to">Talking to: <strong>${escapeHtml(name)}</strong>${session} · ${delegateMode ? 'Designated Project Delegate' : 'Direct Session'}
          <span class="v6-chat-pill is-${status}">${CHAT_STATUS_LABELS[status]}</span></p>
        <div class="v6-chat-actions">
          ${delegatePicker}${toDelegate}
          <a class="btn btn-secondary v6-open-hood" href="${escapeHtml(hoodHref)}">Open Hood (Live Terminal)</a>
          <button type="button" id="v6ChatRefresh" class="btn btn-secondary btn-small">Refresh</button>
          <button type="button" id="v6ChatSettings" class="btn btn-secondary btn-small">Project Settings</button>
        </div>
      </header>
      ${stream}
      ${live ? `<section class="v6-chat-live" aria-label="Live output">
        <h3 class="v6-chat-subtitle">Live output</h3>
        <pre id="v6ChatPeek" class="v6-chat-peek" tabindex="0">${chatPeekMarkup(chat.peek)}</pre>
      </section>` : `<p class="v6-chat-offline">${escapeHtml(name)} has no live session — open the Hood to start one.</p>`}
      <form id="v6ChatForm" class="v6-chat-composer" data-action="send-chat-form" aria-label="Message ${escapeHtml(name)}">
        <textarea id="v6ChatInput" class="v6-chat-input" name="message" rows="3" aria-label="Message to ${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}"${disabled}>${escapeHtml(chat.draft || '')}</textarea>
        <button type="submit" id="v6ChatSend" class="btn btn-primary v6-chat-send-btn"${disabled}>Send</button>
      </form>
      <p id="v6ChatStatus" class="v6-chat-send-status${send ? ` is-${send.kind}` : ''}" role="status" aria-live="polite">${send ? escapeHtml(send.message) : ''}</p>
    </section>`;
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
      const v = detail.view || {};
      return conversationViewMarkup(Object.assign({}, v, { chat: Object.assign({}, v.chat, { draft }) }));
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
        members: memberRows.map((p) => ({ id: String(p.id), name: String(p.name || '') })),
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
        shell.setDetail({ kind: 'conversation', view: current.view });
        return;
      }
      const base = `/api/v6/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(sessionId)}`;
      const peekUrl = `/api/sessions/${name}/peek?lines=80`;
      const [events, attestations, peek] = await Promise.all([
        api(`${base}/conversation/events`),
        api(`${base}/attestations`),
        api(peekUrl)
      ]);
      if (mine !== seq) return;
      chat.peek = peekView(peek);
      current.view = events
        ? { project, sessionId, events: events.events, chat }
        : { project, sessionId, error: 'Could not load this session’s conversation events.', chat };
      shell.setAttestation(pickAttestation(attestations && attestations.attestations, project));
      shell.setDetail({ kind: 'conversation', view: current.view });
      if (startTimer) {
        pollId = startTimer(async () => {
          if (mine !== seq) { stopPolling(); return; }
          const res = await api(peekUrl);
          if (mine !== seq || !current || !current.view) return;
          const next = peekView(res);
          current.view = Object.assign({}, current.view, { chat: Object.assign({}, current.view.chat, { peek: next }) });
          const sh = getShell();
          if (sh && typeof sh.setPeek === 'function') sh.setPeek(next);
        }, CHAT_POLL_MS);
      }
    }

    /** Re-render the chat on screen with a send outcome line. */
    function showSend(outcome) {
      const shell = getShell();
      if (!current || !current.view || !shell) return;
      current.view = Object.assign({}, current.view, { chat: Object.assign({}, current.view.chat, { send: outcome }) });
      shell.setDetail({ kind: 'conversation', view: current.view });
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
      const message = String(text || '').trim();
      const chat = current;
      if (!message || !chat || chat.sending || !getShell()) return;
      const name = String(chat.project.name || '');
      if (chat.sessionId == null) {
        showSend({ kind: 'error', message: `Not sent: ${name} has no live session.` });
        return;
      }
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
      const sent = await apiMutate(`/api/sessions/${encodeURIComponent(name)}/command`, 'POST', { command: message, enter: true });
      // Once it is in the session the draft is spent, even if the operator
      // has moved to another chat meanwhile: left saved, it would come back
      // pre-filled and one Enter would send it twice.
      const shellNow = getShell();
      if (sent && shellNow && typeof shellNow.clearChatDraft === 'function') shellNow.clearChatDraft(chat.project.id);
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
      if (entering || !projects) {
        await loadProjects();
        if (mine !== seq) return;
        showProjects(shell);
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
      await loadRouteDetail(route, mine);
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

    return { handleRoute, launchTemplate, enterHash, sendChat, changeDelegate, refresh, getProjects() { return projects; } };
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
   *   onRefreshChat?: () => void, onOpenProjectSettings?: (projectName: string) => void}} opts - `storage`
   *   remembers the sidebar layout (#3046); defaults to the page's `localStorage`,
   *   and `null` keeps it for this page only. The `on*Chat`/delegate/settings
   *   callbacks are the chat view's controls (#3047).
   * @returns {{getRoute: () => object, navigate: (hash: string) => void,
   *   toggleDrawer: (force?: boolean) => void, isDrawerOpen: () => boolean,
   *   toggleSidebar: (force?: boolean) => void, isSidebarCollapsed: () => boolean,
   *   selectGroup: (id: string, additive?: boolean) => void, setProjects: (rows: Array<object>) => void,
   *   setPeek: (peek: object|null) => void, clearChatDraft: (projectId?: *) => void,
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
    let filterText = '';
    let filterEngine = '';
    let selectedGroups = new Set(prefs.get('tc_v6_selected_groups', [], isStringArray));
    let multiMode = prefs.get('tc_v6_filter_multi_mode', false, isBoolean);
    // The tree as last rendered, filters applied: the fold toggles' positional
    // ids were generated from it, so they are wired from it too.
    let shownTree = [];
    // Unsent composer text per target project, so text meant for one agent
    // never appears in, and is never sent from, another one's chat.
    const chatDrafts = new Map();

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
      const collapseAll = doc.getElementById('v6TreeCollapseAll');
      if (collapseAll) collapseAll.addEventListener('click', () => setCollapsedNodes(allNodeKeys(tree)));
      const expandAll = doc.getElementById('v6TreeExpandAll');
      if (expandAll) expandAll.addEventListener('click', () => setCollapsedNodes([]));
      wireChat();
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
      const allPill = doc.getElementById('v6FilterAll');
      if (allPill) allPill.addEventListener('click', () => setSelectedGroups([]));
      const multiPill = doc.getElementById('v6FilterMulti');
      if (multiPill) {
        multiPill.addEventListener('click', () => {
          multiMode = !multiMode;
          prefs.set('tc_v6_filter_multi_mode', multiMode);
          render();
        });
      }
      tree.forEach((project, i) => {
        const pill = doc.getElementById(`v6GroupPill-${i}`);
        if (pill) {
          pill.addEventListener('click', (evt) => {
            selectGroup(String(project.id), Boolean(evt && (evt.ctrlKey || evt.metaKey || evt.shiftKey)));
          });
        }
      });
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
      const chat = detail && detail.kind === 'conversation' && detail.view ? detail.view.chat : null;
      const picker = doc.getElementById('v6ChatDelegate');
      if (picker && chat && chat.nodeId != null && typeof options.onChangeDelegate === 'function') {
        picker.addEventListener('change', (evt) => {
          options.onChangeDelegate(String(chat.nodeId), String((evt && evt.target && evt.target.value) || ''));
        });
      }
      const refresh = doc.getElementById('v6ChatRefresh');
      if (refresh && typeof options.onRefreshChat === 'function') refresh.addEventListener('click', () => options.onRefreshChat());
      const settings = doc.getElementById('v6ChatSettings');
      const project = detail && detail.view ? detail.view.project : null;
      if (settings && project && typeof options.onOpenProjectSettings === 'function') {
        settings.addEventListener('click', () => options.onOpenProjectSettings(String(project.name || '')));
      }
    }

    /** @returns {string|null} The project the chat on screen talks to, as a draft key. */
    function chatTargetKey() {
      const project = detail && detail.kind === 'conversation' && detail.view ? detail.view.project : null;
      return project && project.id != null ? String(project.id) : null;
    }

    /** Hand the composer's text to the page, unless there is none. */
    function submitChat() {
      const input = doc.getElementById('v6ChatInput');
      const text = String((input && typeof input.value === 'string' ? input.value : chatDrafts.get(chatTargetKey())) || '').trim();
      if (!text || typeof options.onSendChat !== 'function') return;
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
      return { scrollTop: (sidebar && sidebar.scrollTop) || 0, focusId, selection };
    }

    /** @param {ReturnType<typeof captureViewState>} saved */
    function restoreViewState(saved) {
      const sidebar = doc.getElementById('v6ShellSidebar');
      if (sidebar && saved.scrollTop) sidebar.scrollTop = saved.scrollTop;
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
      if (root.classList) root.classList.toggle('v6-shell-root--sidebar-collapsed', sidebarCollapsed);
      root.innerHTML = `
        <a id="v6ShellSkipLink" class="v6-shell-skip-link" href="#v6ShellMain">Skip to main content</a>
        <button type="button" id="v6ShellDrawerToggle" class="v6-shell-drawer-toggle"
          aria-expanded="${drawerOpen ? 'true' : 'false'}" aria-controls="v6ShellSidebar">☰ Menu</button>
        <nav id="v6ShellSidebar" class="v6-shell-sidebar${drawerOpen ? ' is-open' : ''}" aria-label="Fleet navigation">
          <div class="v6-sidebar-header">
            <button type="button" id="v6SidebarCollapse" class="btn btn-secondary btn-small v6-sidebar-collapse"
              data-action="toggle-sidebar-drawer" aria-controls="v6ShellSidebar" aria-expanded="true">« Hide Fleet</button>
            <button type="button" id="v6TreeExpandAll" class="btn btn-secondary btn-small">Expand all</button>
            <button type="button" id="v6TreeCollapseAll" class="btn btn-secondary btn-small">Collapse all</button>
          </div>
          ${filterControlsMarkup({
            tree, engines: engineIds(), text: filterText, engine: filterEngine, groups: selectedGroups, multi: multiMode
          })}
          ${shownTree.length ? sidebarMarkup(shownTree, {
            activeProjectId: currentRoute.projectId,
            activeFleetId: currentRoute.fleetId,
            activeResourceId: currentRoute.resourceId,
            collapsed: collapsedNodes
          }) : '<p class="v6-sidebar-empty">No projects match these filters.</p>'}
        </nav>
        ${telemetryHeaderMarkup(telemetry)}
        <main id="v6ShellMain" class="v6-shell-view" tabindex="-1" aria-label="${escapeHtml(title)}">
          <div class="v6-shell-header">
            ${sidebarCollapsed ? `<button type="button" id="v6SidebarExpand" class="btn btn-secondary v6-sidebar-expand"
              data-action="toggle-sidebar-drawer" aria-controls="v6ShellSidebar" aria-expanded="false">» Show Fleet</button>` : ''}
            <a id="v6ShellClassicLink" class="btn btn-secondary v6-shell-classic-link" href="#/">← Classic View</a>
            <h1 class="v6-shell-title">${escapeHtml(title)}</h1>
          </div>
          <div id="v6ShellDetail">${detailMarkup(detail, { draft: chatDrafts.get(chatTargetKey()) || '' })}</div>
          <div id="v6ShellWizard">${fleetWizardMarkup(templates)}</div>
          <div id="v6ShellAttestation">${modelAttestationMarkup(attestation)}</div>
        </main>
        ${watermarkFooterMarkup(showWatermark)}
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

    /**
     * Pick a logical project pill. Additive (Multi mode, or a
     * Ctrl/Cmd/Shift-click) toggles it in the selection; otherwise it
     * becomes the only selection, or clears it when it already was.
     * @param {string} id
     * @param {boolean} [additive]
     */
    function selectGroup(id, additive) {
      const key = String(id);
      if (additive || multiMode) {
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
      setProjects(rows) {
        projectRows = new Map((Array.isArray(rows) ? rows : [])
          .filter((r) => r && r.id != null).map((r) => [String(r.id), r]));
        render();
      },
      setTree(nextTree) { tree = buildHierarchyTree(nextTree || []); render(); },
      setTelemetry(bar) { telemetry = bar || null; render(); },
      setTemplates(nextTemplates) { templates = Array.isArray(nextTemplates) ? nextTemplates : []; render(); },
      setAttestation(nextAttestation) { attestation = nextAttestation || null; render(); },
      setDetail(nextDetail) { detail = nextDetail || null; render(); },
      /**
       * Replace only the chat's live output panel (#3047): a poll every few
       * seconds must not rebuild the page under an operator mid-message.
       * @param {{lines?: string[], error?: string}|null} peek
       */
      setPeek(peek) {
        if (!detail || detail.kind !== 'conversation' || !detail.view) return;
        detail = Object.assign({}, detail, {
          view: Object.assign({}, detail.view, { chat: Object.assign({}, detail.view.chat, { peek }) })
        });
        const el = doc.getElementById('v6ChatPeek');
        if (!el) return;
        const atBottom = typeof el.scrollHeight === 'number'
          && el.scrollHeight - (el.scrollTop || 0) - (el.clientHeight || 0) < 8;
        el.innerHTML = chatPeekMarkup(peek);
        if (atBottom) el.scrollTop = el.scrollHeight;
      },
      /**
       * Forget a chat's composer text once it has been sent.
       * @param {*} [projectId] - The project it was sent to; the chat on screen when omitted.
       */
      clearChatDraft(projectId) { chatDrafts.delete(projectId != null ? String(projectId) : chatTargetKey()); },
      destroy() {
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
  global.tcV6PickAttestation = pickAttestation;
  global.tcV6ResolveRouteProject = resolveRouteProject;
  global.tcV6ResolveDelegateProject = resolveDelegateProject;
  global.tcV6ChatKeyAction = chatKeyAction;
  global.tcV6CreateLiveController = createLiveController;
  global.tcCreateV6Shell = tcCreateV6Shell;
})(typeof window !== 'undefined' ? window : globalThis);
