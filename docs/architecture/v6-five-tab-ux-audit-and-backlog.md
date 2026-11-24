# V6 Workspace Five-Tab Functional & UX Architecture Audit, and Design Backlog

**SSOT Master Document Registry**: `V6_FIVE_TAB_UX_AUDIT_AND_BACKLOG`, document id
`12a47503-e6bd-4058-9ba3-4bcc23978152`, group `TangleClaw-shared`
(`a5c992b7-0565-4421-bca4-1c991d8712a5`) — verified against the live registry
(`GET /api/shared-docs?groupId=...`) before citing it here, not copied from the dispatch
unverified. Mirror path: `/Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/v6-five-tab-ux-audit-and-backlog.md`.

Car V6511-W1-A, Sprint v6.5.11 Wave 1. Implements Issue #3210 Deliverables 1 and 3 (Milestone
#105 — v6.5.11). Deliverable 2, the `Sprint & Cars` Kanban/6-Gate layout consolidation this
audit's Section 3 specifies, lands in sibling Cars V6511-W1-B and V6511-W1-C.

Every function name, DOM id, route and CSS class cited below was read directly from
`public/v6-shell.js`, `public/ui.js`, `public/sprint-wave-ui.js`, `public/style.css` and
`lib/v6/fleet-template-spec.js` on this car's base commit (`caf2e452`), with every line number
re-verified against that exact commit after rebasing onto it (several sibling cars' merges shifted
`public/v6-shell.js` since this doc's R2, including a genuinely new function, `startFleetMembers`,
#3215's own sidebar/Overview per-fleet Start work) — nothing here is restated
from the issue or a prior dispatch without independently checking it against the live source
first. Section 2d's `FleetPack v1alpha1` comparison is grounded in BOTH GitHub Issue #3194's own
text (fetched directly) AND the `FLEET_PACKS_PROPOSAL` SSOT document it sources from (read
directly from its mirror path) — the two number their own `PG-1..PG-4` guardrails differently, a
real inconsistency between TangleClaw's own source documents that Section 2d reconciles rather
than silently picks one side of. Both carry the same status: `FLEET_PACKS_PROPOSAL` itself is
**"Concept / Proposed — Not Yet Implemented"** and Issue #3194 is **"Proposed — Not authorized for
immediate implementation"** (Milestone #94, v6.6.0), with most of the issue's own acceptance
criteria still unchecked; the comparison below is accordingly "current shipped code vs. two
not-yet-authorized proposed designs," never a system that already coexists with today's.
Rule #285 / Rule #402 in Section 2c name a governance artifact that exists in TangleClaw's own
rules system, not in this repository's git history or its public GitHub issues; checked both and
found nothing, so that section still states what the real code does and flags the rule reference
as an open point for the Operator or the Architect, rather than inventing its content.

## Section 1 — Executive Summary & Reference Experience Benchmark (`Chat`)

The V6 workspace is five tabs over one shell (`WORKSPACE_MODES`, `public/v6-shell.js:563-569`):
`chat` 💬, `sprint` 📋 ("Sprint & Cars"), `charter` 🧭 ("Charter & Roadmap"), `kaizen` 📈
("Kaizen & Reports"), `wizard` 🧙. `Chat` is the only one of the five that renders a project's own
conversation rather than a fleet-wide panel, and it is also, by a wide margin, the most finished
of the five — which is exactly why it is the right reference experience to hold the other four
against, not an incidental convenience.

**Why `Chat` is the reference experience.** Three properties, each grounded in real code:

- **Information density without a second screen.** `conversationViewMarkup`
  (`public/v6-shell.js:2263`) composes the header, the B2 recorded/live stream (`#v6ChatStream`,
  `conversationViewMarkup` ~2300), a collapsible `<details id="v6ChatUnderHood">` for
  switchboard/tool traffic the operator does not need by default, and the composer
  (`<form id="v6ChatForm" class="v6-chat-composer">`, `public/v6-shell.js:2430`) — all in one
  view, with no modal or second page required for the operator's actual day-to-day loop (read,
  reply, glance at what else happened).
- **Immediate actionability.** Every state the project can be in has a DIRECT action attached to
  it in the same view: offline shows Start/View History/Edit Properties
  (`offlineHeroMarkup`, `public/v6-shell.js:2137`); a launch in flight shows "starting" with the
  action disabled rather than silently absent; a launch failure shows the server's own refusal
  reason plus Retry (`.v6-chat-offline-hero-diagnostic`, same function) — never a dead end that
  sends the operator hunting for what to do next.
- **Visual cohesion via one real resize system.** The "Gobble & Fill" pane-boundary resizers
  (#3186, `public/v6-shell.js:1190`, `chatPaneResizerMarkup` at `public/v6-shell.js:2120`) let the
  operator trade space between the stream, Under the Hood and the composer by dragging, arrow
  keys, or double-click-to-reset — one coherent, accessible (`role="separator"`,
  `aria-orientation`) resize model for the whole pane stack, not per-panel ad hoc sizing.

The other four tabs do not all dispatch the same way. `workspaceVisibility(mode, inChat)`
(`public/v6-shell.js:588`) returns `panel: true` for `sprint`/`charter`/`kaizen` — routed to the
shared `v6WorkspacePanel` region (`workspaceRegionId`, `public/v6-shell.js:595`) — but `wizard:
true` for `Wizard` alone, routed to its own `v6ShellWizard` region; Wizard is not a fourth
"fleet-wide panel" sharing that plumbing, it is a genuinely different region. The three that DO
share it render through one function, `workspacePanelContent(mode, result, ui)`
(`public/v6-shell.js:849`) — which is also where their biggest functional gap from `Chat` becomes
visible: `workspacePanelContent` has a
PLAIN BUILT-IN rendering for `sprint`/`charter`/`kaizen` (a bare `<ul class="v6-workspace-list">`,
lines 870-905) that is used ONLY as a fallback when a richer, separately-loaded renderer
(`window.TangleClawSprintWaveUi`, lazily loaded from `/sprint-wave-ui.js` at
`public/v6-shell.js:6560-6583`) is absent or throws. `Chat` has no such two-tier
"real experience vs. degraded fallback" split — what it renders is what there is.

## Section 2 — Five-Tab Functional & UX Architecture Evaluation

### `Chat` 💬

| | |
|---|---|
| **Responsibility** | A single project/fleet-member's own conversation — the shell's `detail` region, not a fleet-wide panel (`workspaceVisibility`, `public/v6-shell.js:588`: `mode === 'chat'` returns `{detail: true, panel: false}`). |
| **Interaction model** | Full-height view inside the workspace, reached by route (`#/resources/:id/conversation`) or by selecting a sidebar/tree member — not a drawer or modal. |
| **What works today** | `conversationViewMarkup` end to end: offline hero + starting/failed transitions (`offlineHeroMarkup`), View Previous Conversation / Return to Start Card for a closed session (`offlineHistoryMarkup`, `public/v6-shell.js:2217`, backed by `viewOfflineHistory`/`returnToStartCard`, `public/v6-shell.js:7096`/`7162`), the B2 live+recorded stream with scroll-pin (`#v6ChatJumpLatest`), the inline engine picker (`#v6ChatEngineSelect`), attachments, and the Gobble & Fill resizers. This is a genuinely complete, single-screen workflow — confirmed by this sprint's own mounted E2E (Car V659-W2-C, PR #3232) actually driving a live launch refusal and a real persisted-history load through the mounted V6Shell offline hero, and (PR #3232 R2) by parsing the real `#masterPanel` markup from `public/index.html` itself for the sibling dropzone verification, not by inspection alone. |
| **Falls back to Classic View for** | Nothing found in `conversationViewMarkup` itself that routes back to Classic View — the fallbacks in this tab are internal (hero → history → hero), not cross-view. |
| **Self-service vs. governance** | Start/Retry/attach/send are direct operator actions with no confirmation step in the UI. The one real governance interlock visible from this tab is server-side: `_stoppedLaunchRefusal` (`lib/sessions.js:154`) blocks a launch into a STOPPED assignment via `controlGate.checkMutation`, and that refusal surfaces through the SAME failed-hero diagnostic path an ordinary engine-not-found failure does — the operator sees one consistent "it was refused, here's why" UI regardless of whether the refusal came from a broken config or a governance HOLD/STOP. |

### `Sprint & Cars` 📋

| | |
|---|---|
| **Responsibility** | Fleet-wide view of the active sprint's cars and their gate status — a panel, not a project detail (`workspaceVisibility`, `public/v6-shell.js:588`: `{panel: true, detail: false}` for non-chat/wizard modes). |
| **Interaction model** | Full workspace panel (`workspacePanelMarkup`, `public/v6-shell.js:632`), loaded on demand (`loadWorkspacePanel`, reads `/api/sprint-waves`, `public/v6-shell.js:6631`). |
| **What works today** | The rich renderer (`renderSprintWaveBoard`, `public/sprint-wave-ui.js:93`) draws a 6-column Kanban (`.sprint-wave-board`, `grid-template-columns: repeat(6, ...)`, `public/style.css:6425`) of `.sprint-wave-card`s by stage, followed by a 6-gate receipt table (`_gateMatrix`, `public/sprint-wave-ui.js:258`; `.sprint-gate-matrix`, `public/style.css:6368`). The REAL 6 gates (`GATES`, `public/sprint-wave-ui.js:130-137`) are **`G0` (charter & disjointness), `A-Gate`, `O-Gate`, `PRR-Gate`, `CI`, `I-Gate`** — note for Section 3/4 authors: this sprint's own Medusa dispatches have informally called the PRR reviewer gate "R-Gate" throughout v6.5.9/v6.5.11; the code's own label is `PRR-Gate` (`label: 'PRR'`), not `R-Gate`, and the first gate is `G0`, not `G1`. |
| **Incomplete / falls back** | When `/sprint-wave-ui.js` has not loaded or its renderer throws, `workspacePanelContent`'s own built-in fallback (`public/v6-shell.js:870-883`) draws a bare `<ul>` of car id/stage/lane/PR — no Kanban columns, no gate matrix at all. This is the single biggest "what currently works vs. degrades to something much plainer" gap of the five tabs, and it is silent: nothing in the UI tells the operator which rendering they are looking at. |
| **Self-service vs. governance** | Read-only today — this panel reports gate state, it does not let the operator act on a car from here (no retry/approve button rendered by either renderer). Everything that changes a gate's state happens elsewhere (PR review, `/prawduct:critic`, the dispatch flow) and is reflected back here on the next load. |

### `Charter & Roadmap` 🧭

| | |
|---|---|
| **Responsibility** | The open project's charter and sprint-wave plan, plus train launch controls (#3088, `trainControlsMarkup`, `public/v6-shell.js:656-676`). |
| **Interaction model** | Full workspace panel, but with an EXTRA per-project input (`charterPanelContent(charter, waves, ui, extra)`, `public/v6-shell.js:691`, fed by the open project's own charter — comment at `public/v6-shell.js:6632`: "Charter & Roadmap also reads the open project's charter") that `sprint`/`kaizen` do not have — this panel needs a project selected to show charter content, not just the sprint's own global state. |
| **What works today** | `charterVersionsMarkup` (`public/v6-shell.js:799`) and the train launch controls (`.v6-train-launch`/`.v6-train-cars`/`.v6-train-actions`, `public/style.css:6511-6530`, Car V659-W2-C's sibling cars' own area). `workspacePanelContent`'s `charter` branch (lines 885-893) draws the built-in wave list (`Wave N — k cars`) when no richer builder exists — unlike `sprint`/`kaizen`, there is no separately-loaded rich renderer for `charter` at all (`workspacePanelContent`'s comment at line 859-860 is explicit: "the charter builder draws a charter, not this payload's waves"), so this tab's "fallback" IS its only built-in rendering, not a degradation from something richer. |
| **Incomplete / falls back** | No cross-reference between a wave's listed car count and the Sprint & Cars Kanban's own per-car detail — an operator reading "Wave 3 — 4 cars" here has to switch tabs to see which 4 or their gate status. |
| **Self-service vs. governance** | Train/charter "activate" controls exist (`.v6-charter-activate`, `public/style.css:6507`) but this audit did not trace their own handler for a governance check equivalent to `_stoppedLaunchRefusal` — flagged as an open question for Section 4, not asserted either way. |

### `Kaizen & Reports` 📈

| | |
|---|---|
| **Responsibility** | The current sprint's own retrospective report — hero KPIs and triggered guardrails. |
| **Interaction model** | Full workspace panel, reads `/api/sprint-reports/current` (`public/v6-shell.js:6631`). |
| **What works today** | The rich renderer (`renderKaizenLedgerPanel`, `public/sprint-wave-ui.js:452`) composes `.sprint-kpi-row`/`.sprint-kpi-card` hero figures (`public/sprint-wave-ui.js:68-70`) with a fuller ledger. The built-in fallback (`workspacePanelContent`'s `kaizen` branch, lines 894-904) draws a flatter `<dl class="v6-workspace-kpis">` of the same `WORKSPACE_KPI_LABELS` plus a bare `<ul>` of triggered guardrails — same two-tier gap as `Sprint & Cars`, same silence about which tier rendered. A sprint with no report at all reads `'No report for the current sprint on this server yet.'` whether that is because nothing has shipped yet or the report generator has not run — the UI cannot tell those two apart, and this audit could not either from the code alone. |
| **Self-service vs. governance** | Read-only reporting; no action surface in this tab. |

### `Wizard` 🧙

| | |
|---|---|
| **Responsibility** | Three provisioning workflows: standalone workspace project, convert-to-fleet, and template/fleet-spec provisioning (#3114) — the ONLY tab whose `workspaceVisibility` shows `wizard: true` instead of `panel: true` (`public/v6-shell.js:588`), a genuinely different shape from the other three fleet-panel tabs. |
| **Interaction model** | Dedicated full tab (moved here at #3165 specifically to stop duplicating itself under Chat's idle `#/overview` screen, per the comment at `public/v6-shell.js:579-580`). |
| **What works today** | `wizardMarkup` (`public/v6-shell.js:1712`) composes `wizardStandaloneMarkup`/`wizardConvertMarkup`/`wizardTemplatesMarkup`/`wizardFleetSpecMarkup`/`fleetWizardMarkup`, wired to real controller methods: `createWorkspaceProject` (`public/v6-shell.js:7464`, `POST /api/projects` or `/api/projects/attach`), `convertToFleet` (`7491`), `provisionFleet` (`7539`), and `launchTemplate`'s own live-preview fetch (`7425`, `POST /api/v6/fleet-templates/:id/plan`). `afterWizardAction` (`7449`) is the one real cross-tab seam: every successful workflow returns the operator to `Chat` on the newly created project/seat, not to an idle Wizard screen. |
| **Self-service vs. governance** | `startFleet(memberNames)` (`public/v6-shell.js:7377`) is the one real example of a lightweight self-service confirmation in this tab's neighborhood — re-verified against the current code, not the version this doc's R2 described: #3215 (sidebar/Overview per-fleet Start buttons) landed since then, and `startFleet` now ALSO serves those via a pending-stash mechanism (`_consumePendingStartFleetMembers`), reusing a sibling helper `startFleetMembers` (`7047`) for the sequential per-member launch. The chat header's own zero-arg path is unchanged: Start Fleet arms on the first click and only fires on a second click within ten seconds (`wireStart`, `public/v6-shell.js:8266-8294`) — a debounce against an accidental bulk-start, not a governance approval; no HOLD/STOP-style server check was found gating any Wizard workflow specifically (only the ordinary per-session launch refusal every `POST /api/sessions/:name` call already goes through). |
| **`FleetPack v1alpha1` compatibility — current `fleet-spec v1.0` vs. TWO DIFFERENT real `PG-1..PG-4` numberings, both read directly and reconciled below** | GitHub Issue #3194 and the SSOT proposal it sources from (`FLEET_PACKS_PROPOSAL`, read directly at `/Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/proposals/tangleclaw-fleet-packs-proposal/tangleclaw-fleet-packs-proposal.md`, §4) number their own `PG-1..PG-4` guardrails DIFFERENTLY — this is a real inconsistency between TangleClaw's own two source documents, not a mistake in this audit, and it is reconciled here rather than silently picked one way: <br><br>**Issue #3194's own numbering** (its §3 "Portability Guardrails"): `PG-1` symbolic `seatId` addressing · `PG-2` logical path variables (`${FLEET_SHARED_DIR}`/`${SEAT_WORKSPACE_DIR}`) · `PG-3` explicit `authorityClass` declarations · `PG-4` Plane A (`fleet-pack.json` blueprint) / Plane B (`migration-snapshot.sqlite`) separation.<br>**`FLEET_PACKS_PROPOSAL`'s own numbering** (its §4 "4 Phase 0 Architectural Guardrails"): `PG-1` symbolic seat AND path tokens together (one item, not split) · `PG-2` single canonical spec authority (`lib/v6/fleet-template-spec.js` as the only validator, no parallel ad-hoc schemas) · `PG-3` populate `v6_fleets` parent records linking member seats · `PG-4` a continuous round-trip contract test (`validateFleetSpec(exportFleetSpec(fleet)) === {ok: true}`).<br><br>Both sources are real (fetched/read directly, not assumed) and both carry the same status: `FLEET_PACKS_PROPOSAL` itself is headed **"Concept / Proposed — Not Yet Implemented"** and Issue #3194 is **"Proposed — Not authorized for immediate implementation"** (Milestone #94, v6.6.0) — neither numbering describes a second system that already coexists with today's shipped `fleet-spec v1.0`. The Wizard's real wiring (`createWorkspaceProject`/`convertToFleet`/`provisionFleet`, `public/v6-shell.js:7464/7491/7539`; `wizardFleetSpecMarkup`, `public/v6-shell.js:1653`) talks to the REAL routes — `GET /api/v6/fleet-templates/bundled-specs`, `POST /api/v6/fleet-templates/validate-spec`, `POST /api/v6/fleet-templates/apply-spec`, `GET /api/v6/projects/:id/fleet-spec` (`loadBundledFleetSpecs`/`requestValidateFleetSpec`/`applyFleetSpec`/`exportFleetSpec`, `public/v6-shell.js:7606/7620/7635/7666`), confirmed directly against `server.js` — not the `/api/v6/fleet-spec/*` paths an earlier review round for this car described. **Current reality against the UNION of both lists:** symbolic `seatId`s (both sources' own PG-1) are substantially ALREADY TRUE today — every bundled template seat (`lib/v6/fleet-template-spec.js:497-506`) already uses `pm`/`architect`/`builder-a`..`builder-d`/`prr-a`/`prr-b`/`integrator`/`observer`, validated as required and unique (`_validateSeat`, `lib/v6/fleet-template-spec.js:103-117`), never a raw SQLite `project.id`. `fleet-template-spec.js` (`FLEET_PACKS_PROPOSAL`'s PG-2, "single canonical spec authority") is NOT yet the ONLY validator, correcting this audit's own prior round: `lib/team-templates.js` (`#2395`) still defines a genuinely separate schema and validator (`validateTeamTemplate`, `lib/team-templates.js:90`), and `projects.orchestration_profile` is a third representation — Issue #3194's own §1 names converging these onto `fleet-template-spec.js` as exactly the work PG-2 requires, confirming it is open, not done. Logical path TOKENS (Issue #3194's PG-2) are only PARTIALLY there: export redacts absolute host paths outright (`_PATH_RE`, `lib/v6/fleet-template-spec.js:301`) rather than substituting a reusable `${FLEET_SHARED_DIR}`-style token, so a redacted spec cannot re-resolve to a new host's own paths on import. `v6_fleets` parent records (`FLEET_PACKS_PROPOSAL`'s PG-3) are ALSO not simply absent, correcting this audit's own prior round again: the table itself is real (`CREATE TABLE IF NOT EXISTS v6_fleets`, `lib/store/_schema.js:4993-5006`), `createFleet(db, {logicalProjectId, displayName, templateId, templateVersion, ...})` is a real, callable function (`lib/v6/c1-logical-projects.js:118`), and `POST /api/v6/fleets` (`server.js:9574`) already wires it up end to end — the real, narrower gap Issue #3194's own Problem #3 names is that the EXISTING legacy fleet seats (`v6_logical_projects` where `origin = 'legacy'` — Issue #3194's own prose says `source`, but the real shipped DDL column is `origin`, `lib/store/_schema.js:4984-4990`) and the FleetPack/template provisioning path have not yet been migrated/converged into live `v6_fleets` parent rows (0 live rows populated today). The actual migration target is narrower than every `origin = 'legacy'` row: it is the 18 fleet-seat rows the two live production fleets this audit's own examples cite (10 `TC-Lane-*` + 8 `TV-*`) that map through `v6_legacy_project_map` (`lib/store/_schema.js:5043`), not all 127 `origin = 'legacy'` logical-project rows — most of those are standalone legacy projects with no fleet membership to converge in the first place. `authorityClass` declarations (Issue #3194's PG-3), the Plane A/B split (Issue #3194's PG-4), a continuous round-trip test (`FLEET_PACKS_PROPOSAL`'s PG-4), and an `apiVersion`/`kind` envelope or dual-schema discriminator of any kind are, as far as this audit could verify, genuinely NOT present anywhere in this repository (checked `lib/`, `public/`, `server.js` directly for every one of these). **Bottom line for the Operator/Architect:** symbolic seats are closer to done than either document's own framing suggests; the single-canonical-validator convergence, `v6_fleets` population, and the per-engine pieces (authority classes, path-token substitution, a round-trip test, the Plane A/B split) are each real, narrower-than-"from scratch" open gaps with the specific mechanisms already named above — and since neither source document is authorized, closing any of these now would be scope the current v6.5.11 milestone was not asked to take on. |

## Section 3 — `Sprint & Cars` Cohesive Layout Specification (for Cars V6511-W1-B & V6511-W1-C)

Grounded in the real render order and the real CSS already in `public/style.css`:

`panel.innerHTML = panelMarkupNow(mode)` (`public/v6-shell.js:7968`) fills the real
`<section id="v6WorkspacePanel" class="v6-workspace-panel" role="tabpanel">`
(`public/v6-shell.js:10545`) — `workspacePanelMarkup(mode, content, extra)`
(`public/v6-shell.js:632`) renders its own `<h2 class="v6-workspace-panel-title">` followed
directly by `content` (`workspacePanelContent`'s output). For `sprint`, that content is
`renderSprintWaveBoard`'s own two blocks, back to back with no wrapper of their own
(`public/sprint-wave-ui.js:124`):

```html
<div class="sprint-wave-board">...6 grid columns of .sprint-wave-card...</div>
<table class="sprint-gate-matrix">...one row per car...</table>
```

So `#v6WorkspacePanel`'s REAL direct children, in order, for the `sprint` mode are:
`.v6-workspace-panel-title` (h2) → `.sprint-wave-board` (div) → `.sprint-gate-matrix` (table) — no
dedicated wrapper around the board/matrix pair exists today. `.sprint-wave-board` is `display:
grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 12px 0;`
(`public/style.css:6425-6430`) — a CSS grid whose 6 columns can have very different numbers of
cards, so the grid's own height is set by its TALLEST column, and every shorter column leaves dead
space below its last card down to that height. `.sprint-gate-matrix` then starts a flat
`margin-top: 12px` below the WHOLE grid (`public/style.css:6371`), regardless of how much of that
grid's height was actually dead space in shorter columns.

**Correction (R-Gate R1 BLOCKING 2):** the prior revision of this section proposed
`align-self: start` on `.sprint-wave-column` to "reclaim" the dead space below a short column.
That is wrong and is withdrawn here, not softened: `align-self` on a grid ITEM changes whether
that item stretches to fill its own cell, but it does **not** change the grid's own row-track
height — the row is still sized by the TALLEST column's content either way, `.sprint-gate-matrix`
still starts exactly where it did, and the empty space below a short column just becomes visually
obvious instead of stretched-and-hidden. It reclaims nothing; it only redecorates the same
whitespace.

**One concrete, executable, low-risk design (recommended) — CSS-only, no new markup, no
sibling-car JS dependency:**

```css
@media (min-width: 1200px) {
  #v6WorkspacePanel:has(> .sprint-wave-board) {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr);
    column-gap: 16px;
    align-items: start;
  }
  #v6WorkspacePanel:has(> .sprint-wave-board) > .v6-workspace-panel-title {
    grid-column: 1 / -1;
  }
}
```

`:has()` is already a precedent in this stylesheet (`.launch-mode-option:has(input[type="radio"]:checked)`,
`public/style.css:2906`), so this is not a new browser-support assumption for the codebase.
`:has(> .sprint-wave-board)` scopes the rule to exactly the `sprint` mode's own render of
`#v6WorkspacePanel` — `charter`/`kaizen` never have a `.sprint-wave-board` direct child, so neither
tab's panel is touched. With no explicit `grid-template-areas`, CSS Grid auto-placement alone puts
the title (forced to `grid-column: 1 / -1`) on its own full-width row, then flows
`.sprint-wave-board` into column 1 and `.sprint-gate-matrix` into column 2 of the row below it —
side by side, matrix no longer stranded below the tallest Kanban column. **Verified non-conflict
with the EXISTING responsive rule** (`public/style.css:6493`, `@media (max-width: 900px) {
.sprint-wave-board { grid-template-columns: none; grid-auto-flow: column; ...; overflow-x: auto;
} }`): that rule is `max-width: 900px` and targets `.sprint-wave-board` itself; this new rule is
`min-width: 1200px` and targets the PARENT `#v6WorkspacePanel` — non-overlapping viewport ranges,
different elements, so both apply exactly as written with no interaction. Below `1200px` (900px
included), `#v6WorkspacePanel` keeps its current default (non-grid) layout and the board/matrix
stack exactly as they do today — nothing regresses on a narrow viewport.

A larger, genuinely more cohesive alternative exists (collapsing empty/zero-car lifecycle columns
to a compact summary header and embedding each car's own 6-gate pills — `GATES`,
`public/sprint-wave-ui.js:130-137` — directly into that car's own `.sprint-wave-card`,
`public/sprint-wave-ui.js:99`, rather than a second table at all) but it requires new per-card
markup in `renderSprintWaveBoard` itself, a column-collapse interaction/empty-state decision, and
touches the same test-locked gate-matrix contract this file's own comment
(`public/sprint-wave-ui.js:119-121`) warns is a SEPARATE contract from the Kanban cards — correctly
scoped as a later slice's own work, not this low-risk car's. The design above is the one this
audit recommends shipping now.

**Telemetry placement.** `.sprint-kpi-row`/`.sprint-kpi-card` (Kaizen's own hero figures,
   `public/sprint-wave-ui.js:68-70`) are a DIFFERENT renderer (`renderKaizenLedgerPanel`) than the
   Sprint board's — if "active milestone telemetry" in this car's own panel is a new requirement,
   it needs its own markup from `renderSprintWaveBoard`/`_gateMatrix`, not a reuse of the Kaizen
   KPI classes verbatim; flagged here for V6511-W1-B/C to scope explicitly rather than assumed to
   already exist.

## Section 4 — Prioritized V6 Workspace Tabs UX Design Backlog (for Operator Review)

**P0 — blocks an operator from trusting what they're looking at**

| Item | Scope | Risk | Operator decision point |
|---|---|---|---|
| Surface which renderer drew a `sprint`/`kaizen` panel (rich vs. built-in fallback) | `public/v6-shell.js`'s `workspacePanelContent`/the panel wrapper; one small UI marker, no behavior change | Low — additive, read-only indicator | Approve the exact wording/placement (a small badge vs. a one-line caption) |
| Section 3's recommended side-by-side Kanban/6-gate-matrix split (option 1) | `public/style.css` only, scoped to the container `.sprint-wave-board`/`.sprint-gate-matrix` already share, plus a responsive breakpoint | Low — CSS-only, no markup or route change | Approve option 1 (recommended) vs. option 2's larger per-card consolidation (Section 3) before V6511-W1-B/C implement it |

**P1 — real functional gaps an operator will eventually hit**

| Item | Scope | Risk | Operator decision point |
|---|---|---|---|
| Distinguish "no report generated yet" from "nothing to report" in `Kaizen & Reports`'s empty state | `lib/` report generator + `workspacePanelContent`'s `kaizen` branch | Medium — needs a real signal from the report generator, not just UI wording | Decide whether this is worth a new field now or deferred past v6.5.11 |
| Cross-link a Charter wave's car count to the matching Sprint & Cars Kanban cars | `public/v6-shell.js` (charter panel markup) + routing | Medium — new interactive affordance between two tabs | Approve scope: a plain link vs. an inline expand |
| Confirm (or correct) whether any Wizard workflow needs a governance check beyond the ordinary per-session launch refusal | Server-side, `lib/sessions.js`/`lib/stranded-wraps.js` area | Unknown until scoped — this audit found none, but did not exhaustively trace every code path | Operator/Architect confirms the finding or names the gap |

**P2 — polish, confirmed low-urgency from the code read**

| Item | Scope | Risk | Operator decision point |
|---|---|---|---|
| Reconcile this sprint's informal "R-Gate" shorthand with the code's own `PRR-Gate` label (Section 2, `Sprint & Cars`) | Communication/terminology only — `public/sprint-wave-ui.js`'s `GATES` array is already internally consistent | None — no code change implied unless the Operator wants the DISPLAY label changed | Keep `PRR-Gate` as shown, or rename the displayed label |
| Close the real open gaps Section 2d identified against EITHER real `PG-1..PG-4` numbering: converge `lib/team-templates.js`'s separate `validateTeamTemplate` and `projects.orchestration_profile` onto `lib/v6/fleet-template-spec.js` as the single canonical validator (`FLEET_PACKS_PROPOSAL`'s PG-2); migrate the 18 fleet-seat rows (10 `TC-Lane-*` + 8 `TV-*`, via `v6_legacy_project_map`) among `v6_logical_projects`' `origin = 'legacy'` rows (`lib/store/_schema.js:4984-4990` — the real DDL column is `origin`, not the `source` Issue #3194's own prose uses) into the already-real `v6_fleets` table (`FLEET_PACKS_PROPOSAL`'s PG-3 — the table/`createFleet`/route already exist, only the migration is missing); plus `authorityClass` declarations and the Plane A/B split (Issue #3194's own PG-3/PG-4), a continuous round-trip test (`FLEET_PACKS_PROPOSAL`'s PG-4), and logical path-token substitution (both documents' path concern) — once either source document is actually authorized | `lib/v6/fleet-template-spec.js`, `lib/team-templates.js`, `lib/v6/c1-logical-projects.js`, `public/v6-shell.js`'s Wizard wiring, `server.js`'s `/api/v6/fleet-templates/*` and `/api/v6/fleets` routes | Medium-to-high — a real schema convergence and data migration (`1.0` → `1.1`), not CSS/doc work | Neither source is authorized yet — `FLEET_PACKS_PROPOSAL` is "Concept / Proposed — Not Yet Implemented" and Issue #3194 is "Proposed — Not authorized" (Milestone #94, v6.6.0) — this stays P2/deferred until the Operator/Architect authorizes that milestone's work, and reconciles the two documents' own differing `PG-1..PG-4` numbering when they do; nothing in v6.5.11 depends on it |
