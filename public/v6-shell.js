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

  /**
   * The collapsible Logical Project -> Fleet -> Member sidebar (#2981
   * deliverable 2). Plain nested lists with real `<a href="#...">` links —
   * deliberately NOT `role="tree"`/`role="treeitem"` (WAI-ARIA's tree
   * pattern demands roving-tabindex arrow-key management; using the role
   * without that behavior is a worse accessibility bug than not using it),
   * so keyboard reachability comes from the browser's own native tab
   * order rather than a half-built custom interaction model.
   * @param {ReturnType<typeof buildHierarchyTree>} tree
   * @param {{activeProjectId?: string, activeFleetId?: string, activeResourceId?: string}} [opts]
   * @returns {string} HTML.
   */
  function sidebarMarkup(tree, opts) {
    const options = opts || {};
    const activeProjectId = options.activeProjectId != null ? String(options.activeProjectId) : null;
    const activeFleetId = options.activeFleetId != null ? String(options.activeFleetId) : null;
    const activeResourceId = options.activeResourceId != null ? String(options.activeResourceId) : null;
    const list = Array.isArray(tree) ? tree : [];
    const items = list.map((project) => {
      const projectActive = activeProjectId === String(project.id);
      const projectHash = routeHash({ view: 'project', projectId: project.id });
      const fleetItems = project.fleets.map((fleet) => {
        const fleetActive = projectActive && activeFleetId === String(fleet.id);
        const fleetHash = routeHash({ view: 'fleet', projectId: project.id, fleetId: fleet.id });
        // #3022: a member with a seat id is a real resource — link it to its
        // B2 Conversation View; one without stays plain text.
        const memberItems = fleet.members.map((m) => {
          const label = `${escapeHtml(m.role)} (${escapeHtml(m.seatId)})`;
          if (!m.seatId) return `<li class="v6-shell-member">${label}</li>`;
          const memberActive = activeResourceId === String(m.seatId);
          const memberHash = routeHash({ view: 'conversation', resourceId: m.seatId });
          return `<li class="v6-shell-member"><a class="v6-shell-member-link${memberActive ? ' is-active' : ''}"
            aria-current="${memberActive ? 'page' : 'false'}"
            href="${escapeHtml(memberHash)}" data-route="${escapeHtml(memberHash)}">${label}</a></li>`;
        }).join('');
        return `<li>
          <a class="v6-shell-fleet${fleetActive ? ' is-active' : ''}"
             aria-current="${fleetActive ? 'page' : 'false'}"
             href="${escapeHtml(fleetHash)}" data-route="${escapeHtml(fleetHash)}">${escapeHtml(fleet.displayName)}</a>
          ${memberItems ? `<ul class="v6-shell-members">${memberItems}</ul>` : ''}
        </li>`;
      }).join('');
      return `<li>
        <a class="v6-shell-project${projectActive ? ' is-active' : ''}"
           aria-current="${projectActive ? 'page' : 'false'}"
           href="${escapeHtml(projectHash)}" data-route="${escapeHtml(projectHash)}">${escapeHtml(project.displayName)}</a>
        ${fleetItems ? `<ul class="v6-shell-fleets">${fleetItems}</ul>` : ''}
      </li>`;
    }).join('');
    return `<ul class="v6-shell-tree">${items}</ul>`;
  }

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
    return `<section class="v6-conversation" aria-label="Conversation — ${escapeHtml(name)}">
      <h2 class="v6-detail-title">${escapeHtml(name)}</h2>
      <a class="btn btn-secondary v6-open-hood" href="${escapeHtml(hoodHref)}">Open Hood (Live Terminal)</a>
      ${stream}
    </section>`;
  }

  /**
   * Render whichever detail the current view carries.
   * @param {{kind: 'plan', plan: object}|{kind: 'conversation', view: object}|{kind: 'loading'}|null} detail
   * @returns {string} HTML.
   */
  function detailMarkup(detail) {
    if (!detail) return '';
    if (detail.kind === 'plan') return fleetPlanMarkup(detail.plan);
    if (detail.kind === 'conversation') return conversationViewMarkup(detail.view);
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
  function createLiveController(deps) {
    const getShell = deps.getShell;
    const api = deps.api;
    const apiMutate = deps.apiMutate;
    let projects = null;
    let templatesLoaded = false;
    let lastRouteKey = null;
    let seq = 0;

    async function loadProjects() {
      const data = await api('/api/projects');
      if (data && Array.isArray(data.projects)) projects = data.projects;
      return projects;
    }

    function findProject(id) {
      if (id == null || !Array.isArray(projects)) return null;
      return projects.find((p) => p && String(p.id) === String(id)) || null;
    }

    async function loadConversation(project, mine) {
      const shell = getShell();
      const status = await api(`/api/sessions/${encodeURIComponent(project.name)}/status`);
      if (mine !== seq) return;
      const sessionId = status && status.active && status.sessionId != null ? status.sessionId : null;
      if (sessionId == null) {
        shell.setAttestation(pickAttestation(null, project));
        shell.setDetail({ kind: 'conversation', view: { project, sessionId: null } });
        return;
      }
      const base = `/api/v6/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(sessionId)}`;
      const [events, attestations] = await Promise.all([
        api(`${base}/conversation/events`),
        api(`${base}/attestations`)
      ]);
      if (mine !== seq) return;
      shell.setAttestation(pickAttestation(attestations && attestations.attestations, project));
      shell.setDetail({
        kind: 'conversation',
        view: events
          ? { project, sessionId, events: events.events }
          : { project, sessionId, error: 'Could not load this session’s conversation events.' }
      });
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
      if (!key) return;
      if (entering || !projects) {
        await loadProjects();
        if (mine !== seq) return;
        if (projects) shell.setTree(synthesizeTreeFromProjects(projects));
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
      const resourceId = route.view === 'conversation' ? route.resourceId
        : (route.view === 'project' ? route.projectId : null);
      const project = findProject(resourceId);
      if (!project) {
        shell.setAttestation(null);
        shell.setDetail(route.view === 'conversation'
          ? { kind: 'conversation', view: { project: null } }
          : null);
        return;
      }
      shell.setDetail({ kind: 'loading' });
      await loadConversation(project, mine);
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

    return { handleRoute, launchTemplate, enterHash, getProjects() { return projects; } };
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
   *   onLaunchTemplate?: (templateId: string) => void}} opts
   * @returns {{getRoute: () => object, navigate: (hash: string) => void,
   *   toggleDrawer: (force?: boolean) => void, isDrawerOpen: () => boolean,
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
      if (typeof options.onLaunchTemplate === 'function') {
        templates.forEach((t) => {
          const templateId = t && t.id;
          const button = templateId != null ? doc.getElementById(`v6ShellWizardLaunch-${templateId}`) : null;
          if (button) button.addEventListener('click', () => options.onLaunchTemplate(templateId));
        });
      }
    }

    function render() {
      currentRoute = parseRoute(readHash());
      if (!root) return;
      const title = routeTitle(currentRoute);
      root.innerHTML = `
        <a id="v6ShellSkipLink" class="v6-shell-skip-link" href="#v6ShellMain">Skip to main content</a>
        <button type="button" id="v6ShellDrawerToggle" class="v6-shell-drawer-toggle"
          aria-expanded="${drawerOpen ? 'true' : 'false'}" aria-controls="v6ShellSidebar">☰ Menu</button>
        <nav id="v6ShellSidebar" class="v6-shell-sidebar${drawerOpen ? ' is-open' : ''}" aria-label="Fleet navigation">
          ${sidebarMarkup(tree, {
            activeProjectId: currentRoute.projectId,
            activeFleetId: currentRoute.fleetId,
            activeResourceId: currentRoute.resourceId
          })}
        </nav>
        ${telemetryHeaderMarkup(telemetry)}
        <main id="v6ShellMain" class="v6-shell-view" tabindex="-1" aria-label="${escapeHtml(title)}">
          <div class="v6-shell-header">
            <a id="v6ShellClassicLink" class="btn btn-secondary v6-shell-classic-link" href="#/">← Classic View</a>
            <h1 class="v6-shell-title">${escapeHtml(title)}</h1>
          </div>
          <div id="v6ShellDetail">${detailMarkup(detail)}</div>
          <div id="v6ShellWizard">${fleetWizardMarkup(templates)}</div>
          <div id="v6ShellAttestation">${modelAttestationMarkup(attestation)}</div>
        </main>
        ${watermarkFooterMarkup(showWatermark)}
      `;
      wireControls();
      if (typeof options.onRender === 'function') options.onRender(currentRoute);
    }

    function toggleDrawer(force) {
      drawerOpen = typeof force === 'boolean' ? force : !drawerOpen;
      render();
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
      setTree(nextTree) { tree = buildHierarchyTree(nextTree || []); render(); },
      setTelemetry(bar) { telemetry = bar || null; render(); },
      setTemplates(nextTemplates) { templates = Array.isArray(nextTemplates) ? nextTemplates : []; render(); },
      setAttestation(nextAttestation) { attestation = nextAttestation || null; render(); },
      setDetail(nextDetail) { detail = nextDetail || null; render(); },
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
  global.tcV6TelemetryHeaderMarkup = telemetryHeaderMarkup;
  global.tcV6FleetWizardMarkup = fleetWizardMarkup;
  global.tcV6ModelAttestationMarkup = modelAttestationMarkup;
  global.tcV6WatermarkFooterMarkup = watermarkFooterMarkup;
  global.tcV6SynthesizeTreeFromProjects = synthesizeTreeFromProjects;
  global.tcV6FleetPlanMarkup = fleetPlanMarkup;
  global.tcV6ConversationViewMarkup = conversationViewMarkup;
  global.tcV6ViewToggleLabel = viewToggleLabel;
  global.tcV6PickAttestation = pickAttestation;
  global.tcV6CreateLiveController = createLiveController;
  global.tcCreateV6Shell = tcCreateV6Shell;
})(typeof window !== 'undefined' ? window : globalThis);
