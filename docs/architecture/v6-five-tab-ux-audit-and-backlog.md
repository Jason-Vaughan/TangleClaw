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
`lib/v6/fleet-template-spec.js` on this car's base commit (`676f5ff5`) — nothing here is restated
from the issue or a prior dispatch without independently checking it against the live source
first. Section 2d's `FleetPack v1alpha1` comparison is grounded in GitHub Issue #3194's own text
(fetched directly, not assumed) — its status there is **"Proposed — Not authorized for immediate
implementation,"** assigned to the future **Milestone #94 (v6.6.0)**, with most of its own
acceptance criteria still unchecked; the comparison below is accordingly "current shipped code vs.
that issue's own proposed, not-yet-authorized design," never two systems that already coexist.
Rule #285 / Rule #402 in Section 2c name a governance artifact that exists in TangleClaw's own
rules system, not in this repository's git history or its public GitHub issues; checked both and
found nothing, so that section still states what the real code does and flags the rule reference
as an open point for the Operator or the Architect, rather than inventing its content.

## Section 1 — Executive Summary & Reference Experience Benchmark (`Chat`)

The V6 workspace is five tabs over one shell (`WORKSPACE_MODES`, `public/v6-shell.js:522-528`):
`chat` 💬, `sprint` 📋 ("Sprint & Cars"), `charter` 🧭 ("Charter & Roadmap"), `kaizen` 📈
("Kaizen & Reports"), `wizard` 🧙. `Chat` is the only one of the five that renders a project's own
conversation rather than a fleet-wide panel, and it is also, by a wide margin, the most finished
of the five — which is exactly why it is the right reference experience to hold the other four
against, not an incidental convenience.

**Why `Chat` is the reference experience.** Three properties, each grounded in real code:

- **Information density without a second screen.** `conversationViewMarkup`
  (`public/v6-shell.js:2222`) composes the header, the B2 recorded/live stream (`#v6ChatStream`,
  `conversationViewMarkup` ~2259), a collapsible `<details id="v6ChatUnderHood">` for
  switchboard/tool traffic the operator does not need by default, and the composer
  (`<form id="v6ChatForm" class="v6-chat-composer">`, `public/v6-shell.js:2389`) — all in one
  view, with no modal or second page required for the operator's actual day-to-day loop (read,
  reply, glance at what else happened).
- **Immediate actionability.** Every state the project can be in has a DIRECT action attached to
  it in the same view: offline shows Start/View History/Edit Properties
  (`offlineHeroMarkup`, `public/v6-shell.js:2096`); a launch in flight shows "starting" with the
  action disabled rather than silently absent; a launch failure shows the server's own refusal
  reason plus Retry (`.v6-chat-offline-hero-diagnostic`, same function) — never a dead end that
  sends the operator hunting for what to do next.
- **Visual cohesion via one real resize system.** The "Gobble & Fill" pane-boundary resizers
  (#3186, `public/v6-shell.js:1149`, `chatPaneResizerMarkup` at `public/v6-shell.js:2079`) let the
  operator trade space between the stream, Under the Hood and the composer by dragging, arrow
  keys, or double-click-to-reset — one coherent, accessible (`role="separator"`,
  `aria-orientation`) resize model for the whole pane stack, not per-panel ad hoc sizing.

The other four tabs do not all dispatch the same way. `workspaceVisibility(mode, inChat)`
(`public/v6-shell.js:547`) returns `panel: true` for `sprint`/`charter`/`kaizen` — routed to the
shared `v6WorkspacePanel` region (`workspaceRegionId`, `public/v6-shell.js:554`) — but `wizard:
true` for `Wizard` alone, routed to its own `v6ShellWizard` region; Wizard is not a fourth
"fleet-wide panel" sharing that plumbing, it is a genuinely different region. The three that DO
share it render through one function, `workspacePanelContent(mode, result, ui)`
(`public/v6-shell.js:808`) — which is also where their biggest functional gap from `Chat` becomes
visible: `workspacePanelContent` has a
PLAIN BUILT-IN rendering for `sprint`/`charter`/`kaizen` (a bare `<ul class="v6-workspace-list">`,
lines 829-864) that is used ONLY as a fallback when a richer, separately-loaded renderer
(`window.TangleClawSprintWaveUi`, lazily loaded from `/sprint-wave-ui.js` at
`public/v6-shell.js:6442-6462`) is absent or throws. `Chat` has no such two-tier
"real experience vs. degraded fallback" split — what it renders is what there is.

## Section 2 — Five-Tab Functional & UX Architecture Evaluation

### `Chat` 💬

| | |
|---|---|
| **Responsibility** | A single project/fleet-member's own conversation — the shell's `detail` region, not a fleet-wide panel (`workspaceVisibility`, `public/v6-shell.js:547`: `mode === 'chat'` returns `{detail: true, panel: false}`). |
| **Interaction model** | Full-height view inside the workspace, reached by route (`#/resources/:id/conversation`) or by selecting a sidebar/tree member — not a drawer or modal. |
| **What works today** | `conversationViewMarkup` end to end: offline hero + starting/failed transitions (`offlineHeroMarkup`), View Previous Conversation / Return to Start Card for a closed session (`offlineHistoryMarkup`, `public/v6-shell.js:2176`, backed by `viewOfflineHistory`/`returnToStartCard`, `public/v6-shell.js:6926`/`6992`), the B2 live+recorded stream with scroll-pin (`#v6ChatJumpLatest`), the inline engine picker (`#v6ChatEngineSelect`), attachments, and the Gobble & Fill resizers. This is a genuinely complete, single-screen workflow — confirmed by this sprint's own mounted E2E (Car V659-W2-C, PR #3232) actually driving a live launch refusal and a real persisted-history load through the mounted V6Shell offline hero, and (PR #3232 R2) by parsing the real `#masterPanel` markup from `public/index.html` itself for the sibling dropzone verification, not by inspection alone. |
| **Falls back to Classic View for** | Nothing found in `conversationViewMarkup` itself that routes back to Classic View — the fallbacks in this tab are internal (hero → history → hero), not cross-view. |
| **Self-service vs. governance** | Start/Retry/attach/send are direct operator actions with no confirmation step in the UI. The one real governance interlock visible from this tab is server-side: `_stoppedLaunchRefusal` (`lib/sessions.js:154`) blocks a launch into a STOPPED assignment via `controlGate.checkMutation`, and that refusal surfaces through the SAME failed-hero diagnostic path an ordinary engine-not-found failure does — the operator sees one consistent "it was refused, here's why" UI regardless of whether the refusal came from a broken config or a governance HOLD/STOP. |

### `Sprint & Cars` 📋

| | |
|---|---|
| **Responsibility** | Fleet-wide view of the active sprint's cars and their gate status — a panel, not a project detail (`workspaceVisibility`, `public/v6-shell.js:549`: `{panel: true, detail: false}` for non-chat/wizard modes). |
| **Interaction model** | Full workspace panel (`workspacePanelMarkup`, `public/v6-shell.js:7634`), loaded on demand (`loadWorkspacePanel`, reads `/api/sprint-waves`, `public/v6-shell.js:6512`). |
| **What works today** | The rich renderer (`renderSprintWaveBoard`, `public/sprint-wave-ui.js:93`) draws a 6-column Kanban (`.sprint-wave-board`, `grid-template-columns: repeat(6, ...)`, `public/style.css:6414`) of `.sprint-wave-card`s by stage, followed by a 6-gate receipt table (`_gateMatrix`, `public/sprint-wave-ui.js:258`; `.sprint-gate-matrix`, `public/style.css:6357`). The REAL 6 gates (`GATES`, `public/sprint-wave-ui.js:130-137`) are **`G0` (charter & disjointness), `A-Gate`, `O-Gate`, `PRR-Gate`, `CI`, `I-Gate`** — note for Section 3/4 authors: this sprint's own Medusa dispatches have informally called the PRR reviewer gate "R-Gate" throughout v6.5.9/v6.5.11; the code's own label is `PRR-Gate` (`label: 'PRR'`), not `R-Gate`, and the first gate is `G0`, not `G1`. |
| **Incomplete / falls back** | When `/sprint-wave-ui.js` has not loaded or its renderer throws, `workspacePanelContent`'s own built-in fallback (`public/v6-shell.js:829-842`) draws a bare `<ul>` of car id/stage/lane/PR — no Kanban columns, no gate matrix at all. This is the single biggest "what currently works vs. degrades to something much plainer" gap of the five tabs, and it is silent: nothing in the UI tells the operator which rendering they are looking at. |
| **Self-service vs. governance** | Read-only today — this panel reports gate state, it does not let the operator act on a car from here (no retry/approve button rendered by either renderer). Everything that changes a gate's state happens elsewhere (PR review, `/prawduct:critic`, the dispatch flow) and is reflected back here on the next load. |

### `Charter & Roadmap` 🧭

| | |
|---|---|
| **Responsibility** | The open project's charter and sprint-wave plan, plus train launch controls (#3088, `public/v6-shell.js:615-637`). |
| **Interaction model** | Full workspace panel, but with an EXTRA per-project input (`charterPanelContent(charter, waves, ui, extra)`, `public/v6-shell.js:650`, fed by the open project's own charter — comment at `public/v6-shell.js:6513`: "Charter & Roadmap also reads the open project's charter") that `sprint`/`kaizen` do not have — this panel needs a project selected to show charter content, not just the sprint's own global state. |
| **What works today** | `charterVersionsMarkup` (`public/v6-shell.js:758`) and the train launch controls (`.v6-train-launch`/`.v6-train-cars`/`.v6-train-actions`, `public/style.css:6498-6517`, Car V659-W2-C's sibling cars' own area). `workspacePanelContent`'s `charter` branch (lines 844-852) draws the built-in wave list (`Wave N — k cars`) when no richer builder exists — unlike `sprint`/`kaizen`, there is no separately-loaded rich renderer for `charter` at all (`workspacePanelContent`'s comment at line 818-819 is explicit: "the charter builder draws a charter, not this payload's waves"), so this tab's "fallback" IS its only built-in rendering, not a degradation from something richer. |
| **Incomplete / falls back** | No cross-reference between a wave's listed car count and the Sprint & Cars Kanban's own per-car detail — an operator reading "Wave 3 — 4 cars" here has to switch tabs to see which 4 or their gate status. |
| **Self-service vs. governance** | Train/charter "activate" controls exist (`.v6-charter-activate`, `public/style.css:6494`) but this audit did not trace their own handler for a governance check equivalent to `_stoppedLaunchRefusal` — flagged as an open question for Section 4, not asserted either way. |

### `Kaizen & Reports` 📈

| | |
|---|---|
| **Responsibility** | The current sprint's own retrospective report — hero KPIs and triggered guardrails. |
| **Interaction model** | Full workspace panel, reads `/api/sprint-reports/current` (`public/v6-shell.js:6512`). |
| **What works today** | The rich renderer (`renderKaizenLedgerPanel`, `public/sprint-wave-ui.js:452`) composes `.sprint-kpi-row`/`.sprint-kpi-card` hero figures (`public/sprint-wave-ui.js:68-70`) with a fuller ledger. The built-in fallback (`workspacePanelContent`'s `kaizen` branch, lines 853-863) draws a flatter `<dl class="v6-workspace-kpis">` of the same `WORKSPACE_KPI_LABELS` plus a bare `<ul>` of triggered guardrails — same two-tier gap as `Sprint & Cars`, same silence about which tier rendered. A sprint with no report at all reads `'No report for the current sprint on this server yet.'` whether that is because nothing has shipped yet or the report generator has not run — the UI cannot tell those two apart, and this audit could not either from the code alone. |
| **Self-service vs. governance** | Read-only reporting; no action surface in this tab. |

### `Wizard` 🧙

| | |
|---|---|
| **Responsibility** | Three provisioning workflows: standalone workspace project, convert-to-fleet, and template/fleet-spec provisioning (#3114) — the ONLY tab whose `workspaceVisibility` shows `wizard: true` instead of `panel: true` (`public/v6-shell.js:547`), a genuinely different shape from the other three fleet-panel tabs. |
| **Interaction model** | Dedicated full tab (moved here at #3165 specifically to stop duplicating itself under Chat's idle `#/overview` screen, per the comment at `public/v6-shell.js:536-540`). |
| **What works today** | `wizardMarkup` (`public/v6-shell.js:1671`) composes `wizardStandaloneMarkup`/`wizardConvertMarkup`/`wizardTemplatesMarkup`/`wizardFleetSpecMarkup`/`fleetWizardMarkup`, wired to real controller methods: `createWorkspaceProject` (`public/v6-shell.js:7262`, `POST /api/projects` or `/api/projects/attach`), `convertToFleet` (`7289`), `provisionFleet` (`7337`), and `launchTemplate`'s own live-preview fetch (`7223`, `POST /api/v6/fleet-templates/:id/plan`). `afterWizardAction` (`7247`) is the one real cross-tab seam: every successful workflow returns the operator to `Chat` on the newly created project/seat, not to an idle Wizard screen. |
| **Self-service vs. governance** | `startFleet` (`public/v6-shell.js:7183`) is the one real example of a lightweight self-service confirmation in this tab's neighborhood: the header's Start Fleet button arms on the first click and only fires on a second click within ten seconds (`wireStart`, `public/v6-shell.js:8066-8080`) — a debounce against an accidental bulk-start, not a governance approval; no HOLD/STOP-style server check was found gating any Wizard workflow specifically (only the ordinary per-session launch refusal every `POST /api/sessions/:name` call already goes through). |
| **`FleetPack v1alpha1` compatibility — current `fleet-spec v1.0` vs. Issue #3194's own proposed `PG-1..PG-4` guardrails (verified against both the live code and the issue's real text)** | GitHub Issue #3194 is real (fetched directly, not assumed) and names `lib/v6/fleet-template-spec.js` (`#3115`, `SCHEMA_VERSION = '1.0'`, line 35) as the exact module it proposes evolving to `schemaVersion: "1.1"` / `"FleetPack v1alpha1"` — it is NOT a separate, already-existing competing format, and the issue's own status is **"Proposed — Not authorized for immediate implementation"** (Milestone #94, v6.6.0), so every `PG-*` item below is a comparison against a not-yet-authorized design, not a second shipped system. The Wizard's real wiring (`onCreateWorkspaceProject`/`onConvertToFleet`/`onProvisionFleet`, `public/v6-shell.js:7262/7289/7337`; `wizardFleetSpecMarkup`, `public/v6-shell.js:1612`) talks to the REAL routes — `GET /api/v6/fleet-templates/bundled-specs`, `POST /api/v6/fleet-templates/validate-spec`, `POST /api/v6/fleet-templates/apply-spec`, and `GET /api/v6/projects/:id/fleet-spec` for export (`loadBundledFleetSpecs`/`requestValidateFleetSpec`/`applyFleetSpec`/`exportFleetSpec`, `public/v6-shell.js:7404/7418/7433/7464`) — not the `/api/v6/fleet-spec/*` paths an earlier review round for this car described; grepped `server.js`/`lib/routes/*.js` directly and those paths do not exist. **`PG-1` (portable spec vs. local binding):** NOT separated today — `fleet-template-spec.js` has no `basePath`/`groupId`-style local-binding fields of its own, but it also has no `FleetBinding`-style split; the issue proposes introducing one, it is not bypassing an existing one. **`PG-2` (symbolic seat addressing):** substantially ALREADY TRUE, which the issue's own "converging onto the canonical schema" framing implies but is worth stating plainly: every bundled template seat (`public/v6-shell.js` / `lib/v6/fleet-template-spec.js:497-506`) already uses symbolic `seatId`s — `pm`, `architect`, `builder-a`..`builder-d`, `prr-a`, `prr-b`, `integrator`, `observer` — validated as required and unique (`_validateSeat`, `lib/v6/fleet-template-spec.js:103-117`), never a raw SQLite `project.id`. **`PG-3` (logical paths, no host-specific leakage):** PARTIALLY true today — export already redacts absolute host paths (`_PATH_RE`, `lib/v6/fleet-template-spec.js:301`, replacing `/Users/...`/`/home/...` with `<path-redacted>`) and strips secret-shaped fields (`_SECRET_KEY_RE`), but redaction is not the same as the issue's proposed logical substitution tokens (`${FLEET_SHARED_DIR}`, `${SEAT_WORKSPACE_DIR}`) that would let an exported spec re-resolve to a NEW host's own paths on import — today a redacted path is simply gone, not replaced with something reusable. **`PG-4` (dual-schema / `v1.0` back-compat):** NOT present — `validateFleetSpec` rejects any `schemaVersion` other than the exact literal `'1.0'` (`lib/v6/fleet-template-spec.js:257-258`); there is no `apiVersion`/`kind` envelope, no dual-schema discriminator, and no code path that recognizes `"tangleclaw.io/v1alpha1"` anywhere in this repository (checked `lib/`, `public/`, `server.js` directly) — Issue #3194's own acceptance criteria list this as future work, not a gap in otherwise-complete support. **Bottom line for the Operator/Architect:** the current Wizard is closer to PG-2 than a first read of the issue suggests, and meaningfully short of PG-1/PG-3/PG-4 — but since Issue #3194 is explicitly not yet authorized, closing that gap now would be scope the current v6.5.11 milestone was not asked to take on; this is a finding for prioritization, not a defect in the current code. |

## Section 3 — `Sprint & Cars` Cohesive Layout Specification (for Cars V6511-W1-B & V6511-W1-C)

Grounded in the real render order and the real CSS already in `public/style.css`:

`workspacePanelMarkup(mode, panel, extra)` renders `renderSprintWaveBoard`'s output as two
stacked blocks with no shared layout context between them:

```html
<div class="sprint-wave-board">...6 grid columns of .sprint-wave-card...</div>
<table class="sprint-gate-matrix">...one row per car...</table>
```

`.sprint-wave-board` is `display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap:
10px; margin: 12px 0;` (`public/style.css:6414-6419`) — a CSS grid whose 6 columns can have very
different numbers of cards, so the grid's own height is set by its TALLEST column, and every
shorter column leaves dead space below its last card down to that height. `.sprint-gate-matrix`
then starts a flat `margin-top: 12px` below the WHOLE grid (`public/style.css:6360`), regardless
of how much of that grid's height was actually dead space in shorter columns.

**Correction (R-Gate R1 BLOCKING 2):** the prior revision of this section proposed
`align-self: start` on `.sprint-wave-column` to "reclaim" the dead space below a short column.
That is wrong and is withdrawn here, not softened: `align-self` on a grid ITEM changes whether
that item stretches to fill its own cell, but it does **not** change the grid's own row-track
height — the row is still sized by the TALLEST column's content either way, `.sprint-gate-matrix`
still starts exactly where it did, and the empty space below a short column just becomes visually
obvious instead of stretched-and-hidden. It reclaims nothing; it only redecorates the same
whitespace. Two real structural options instead, both grounded in what `renderSprintWaveBoard`/
`_gateMatrix` (`public/sprint-wave-ui.js:93`/`258`) currently emit:

1. **(Recommended — lower risk, CSS/layout-only, no markup change) Put the board and the matrix
   side by side, not stacked.** `workspacePanelMarkup` already emits them back to back
   (`<div class="sprint-wave-board">...</div><table class="sprint-gate-matrix">...</table>`) with
   no wrapping element between them — wrap that same pair in a 2-column split
   (`display: grid; grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); gap: 16px;` on
   whichever container `workspacePanelMarkup` already wraps them in, or a new one if it wraps them
   in none) on a desktop-width viewport, falling back to the current stacked order below a
   reasonable breakpoint (e.g. `768px`) since `.sprint-gate-matrix` already has `overflow-x: auto`
   (`public/style.css:6361`) for a narrow matrix on its own line. This directly removes the
   "stranded below the tallest column" problem, because the matrix is no longer below the board at
   all on a desktop-width screen — no column-height trick needed, and no new per-card markup.
2. **(A larger, genuinely more cohesive alternative — not low-risk, a separate future car's scope)
   Collapse empty/zero-car lifecycle columns to a compact summary header and embed each car's own
   6-gate pills (`G0`/`A-Gate`/`O-Gate`/`PRR-Gate`/`CI`/`I-Gate`, `GATES`,
   `public/sprint-wave-ui.js:130-137`) directly into that car's own `.sprint-wave-card`
   (`public/sprint-wave-ui.js:99`), rather than a second table at all. This is the design that
   actually reads as "one board," but it requires new per-card markup in `renderSprintWaveBoard`
   itself (not just `public/style.css`), a column-collapse interaction/empty-state decision, and
   touches the same test-locked gate-matrix contract this file's own comment (`public/sprint-wave-ui.js:119-121`)
   warns is a SEPARATE contract from the Kanban cards — correctly scoped as a later slice's work,
   not this low-risk car's.
3. **Telemetry placement.** `.sprint-kpi-row`/`.sprint-kpi-card` (Kaizen's own hero figures,
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
| Close the `PG-1`/`PG-3`/`PG-4` gaps Section 2d identified (local-binding separation, logical path tokens, dual-schema `apiVersion`/`kind` support), once Issue #3194 is actually authorized | `lib/v6/fleet-template-spec.js`, `public/v6-shell.js`'s Wizard wiring, `server.js`'s `/api/v6/fleet-templates/*` routes | Medium-to-high — a real schema migration (`1.0` → `1.1`), not CSS/doc work | Issue #3194 itself is "Proposed — Not authorized" (Milestone #94, v6.6.0) — this stays P2/deferred until the Operator/Architect actually authorizes that milestone's work; nothing in v6.5.11 depends on it |
