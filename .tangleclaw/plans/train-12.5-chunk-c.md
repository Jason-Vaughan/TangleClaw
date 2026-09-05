---
name: train-12.5-chunk-c
branch: feat/1236-capability-disposition
governed_by:
  - .prawduct/artifacts/architecture.md
  - .prawduct/artifacts/prime-delivery-direction.md
  - .prawduct/artifacts/nonfunctional-requirements.md
  - .prawduct/artifacts/project-preferences.md
  - .prawduct/artifacts/interaction-design.md
---

# Train 12.5 — Chunk C: the per-engine settings axis

**Train:** 12.5 "Settings & Modals Cleanup" (roster in TangleClaw-Roadmap `master-roadmap.md`)
**Chunk:** C · **Cars:** #764, #626, #1236 · **Branch:** `feat/1236-capability-disposition` (C2 only — C1 writes no code)
**Base:** `607f98f`
**Critic mode:** cumulative per sub-chunk

## Why this chunk is two sessions, not one

#764's own Status line refuses to be built: *"Scoping only — filed to capture the idea, not yet
specified. Needs the universal-vs-engine-specific split settled and the #581 shell question
answered before it becomes a build plan."* #626 says *"The design question this needs (do not
guess it)"*. #1236 defers *"where the toggle lives"* to #764.

Three issues that each defer to the same unanswered question are one design problem with three
dependents, not three build items. So:

- **Chunk C1 — design.** Produces a design document and a build plan. Writes no product code.
- **Chunk C2 — build.** Executes the build plan C1 produced.

Collapsing them would mean designing while building, which is the failure #764 anticipated.

## The two scoping decisions, and why

Both were put to the operator; both were delegated with the standing instruction *"whatever is the
BEST way to do it properly — I don't like shoddy or crappy work, and bandaids."* One principle
answers both: **design wide, build narrow.**

**1. The extension inventory is designed in C1, built after C2.** #764 contains two features that
share only a container: (a) the settings split plus the tabbed shell, and (b) an inventory of what
plugins/skills/MCP servers each engine actually has installed. They share no data model, no server
route, and no invariant — (a) is a decision about TangleClaw's own settings; (b) is read-only
reporting about other tools' on-disk state, and needs a discovery mechanism per engine that does
not exist yet.

This is a split, not a deferral of half a feature. The bandaid outcome would be shipping the
inventory *partially* — Claude enumerated, silent blanks elsewhere — which is precisely the failure
mode #764 exists to prevent. Deferring it whole, with its place in the information architecture
already designed, leaves no seam to undo.

**2. The shell is designed to host #581 (TangleTweaker) from the start; #581's content is not
built.** #764 states the constraint itself: *"Two separate per-engine settings surfaces would be a
mistake."* #581 is OPEN and is the same axis with different content (numeric tunables vs. settings
and extensions). Designing the shell around one tenant and retrofitting the second is how the
mistake happens. So the shell's contract — how a tab declares its panels, how an engine with no
content for a panel renders — is designed against both tenants and built once. #581 adopts it later
without a shell change.

Both decisions have the same shape and the same justification: the expensive, hard-to-reverse
artifact is the **design**, and it is cheap to make it complete. The build is narrow because a
narrow build is reversible and a wide one is not.

## The issue is not the issue — #626 is substantially shipped

#626 asks that creation collect the first-session-load-bearing settings, and proposes as its
"defensible split": *name, engine, launch posture, silent prime.*

**That shipped.** `public/ui.js#createData` — `createData` carries `defaultLaunchMode` and `silentPrime`;
`the "First-Session Settings" step` renders a step titled literally **"First-Session Settings"** with a Launch Posture select
and a Silent Prime toggle; `createNext` collects both; `submitCreate` POSTs both. #626's own title counts
*fields*, and the wizard now collects five of them.

Its sequencing note also defers the full form to *"Wrap v2 Chunk 04, which replaces methodology
selection with per-project wrap configuration."* The methodology axis was **deleted** 2026-07-20
(v4.30.0), so that dependency no longer exists and the reason to wait is gone.

What actually remains of #626 is a design question, not a build: **is the four-field split right, or
do `featureIndexEnabled` / `projectMapEnabled` / `versionBumpEnabled` / `wrapSections` / project
rules belong at creation too?** That is #764's universal-vs-engine-specific question applied to the
creation surface, which is why it is in this chunk. C1 answers it; the answer is a re-scope comment
on #626 and possibly a small build item in C2.

This is the **third** consecutive Train 12.5 car whose written body had already shipped (#1227
premise disproven, #596 facelift shipped in #1003, now #626). Verify before scoping, every car.

## Stale premises in #764 to re-read before designing

#764 was filed 2026-07-29 and argues from two issues that have since closed:

- **#741 CLOSED** — `silentPrime` silently ignored on unsupported engines. This is #764's motivating
  example of the trap ("a checkbox that silently does nothing"). It is fixed. The design must argue
  from what shipped as the fix, not from the bug, or it will re-solve a solved problem.
- **#763 CLOSED** — auto-onboard new projects into Prawduct. #764 calls this "the *mechanism* for
  'Prawduct on by default'" and itself "the *control surface* that turns it on." The mechanism now
  exists; the design must read it to know what a control surface would actually set.

Live constraints, all OPEN: **#581** (shell tenant), **#738** (engine picker should converge on the
shared option builder — likely the same roster the tabs read), **#737** (engine-profile changes are
inert until the server restarts — a caveat for anything profile-driven).

## Requirements Confidence

**Low, deliberately — and that is what C1 is for.** No requirement here is settled: #764 says so in
its own Status, #626's split needs re-deciding against shipped code, and #1236's location depends on
both. Nothing in C1 may be built on an inferred requirement; every design answer is recorded as a
decision with its reasoning, and the ones the operator must rule on are surfaced as questions, not
assumptions.

## Chunk C1 — Settle the per-engine settings axis

**Deliverable:** a design document at `.tangleclaw/plans/train-12.5-chunk-c-design.md`, mirrored to
a hosted link for the operator, plus a build plan for C2. **No product code.**

**Must answer, each with reasoning recorded:**

1. **The three-way split.** Every existing per-project and global setting classified as *universal*,
   *engine-specific*, or *universal-but-unevenly-supported*. The third class is the hard one and the
   reason the design exists — resolve it as a rule ("an unsupported setting renders disabled with
   the engine's own reason"), not as a per-setting judgement call.
2. **The shell contract.** How a tab is generated from the engine roster; how a panel declares
   itself; what an engine with no content for a panel renders. Validated against two tenants:
   #764's settings and #581's tunables.
3. **Where a per-engine default is applied** — at project creation, at session launch, or both — and
   what happens to projects that already exist when a default changes. #764 names this as an open
   question and #626 depends on the answer.
4. **#1236's toggle home.** Universal panel or an engine/connection surface — Eval Audit is fed by
   OpenClaw. Plus what the empty state says: what the feature does, how to enable it, and that
   Tier 2/3 spends real LLM calls (#1236 asks for the cost to be visible, not a free-looking
   checkbox).
5. **#626's creation split**, re-decided against the shipped five-step wizard.
6. **The inventory's place** in the information architecture, designed but not built.

**Done when**
- Every question above has a recorded answer, or is explicitly surfaced to the operator as a ruling
  they must make (with options and a recommendation — never left as a silent assumption).
- The classification covers every setting found by the audit, with no "TBD" rows.
- The design cites shipped code for each premise it inherits from #764, #626 and #1236, and states
  plainly where the issue text is now wrong.
- A C2 build plan exists, chunked to fit one session.
- ENGINE-AGNOSTIC BY CONSTRUCTION is satisfied by the design, not by a later fix: tabs generated
  from profiles, honest empty states, unsupported settings visibly disabled with a reason.

## Chunk C2 — Generalize the capability gate and reach the settings it hides

**Scope set by C1 (operator ruling R1, 2026-09-04): the project half only.** The engine-settings
surface — the second surface in the design's §1 split, where #764's inventory and #581's tunables
eventually live — is a later chunk with its design already settled. This chunk is complete and
shippable without it.

**Governed by** `architecture.md` § Direction, whose "a setting TangleClaw offers must take effect,
or say why it does not" entry was ratified 2026-09-04 as part of C1. C2 is the first work to build
against it.

**Visual change:** yes — every item below changes the settings modal or the create wizard.

### Chunk C2a — One disposition mechanism, not a fourth hand-built instance

`lib/engines.js` carries **two** capability predicates with separate implementations —
`honorsLaunchMode` and `silentPrimeDisposition`. `reconcileLaunchMode` is a *caller*, not a third
instance: it delegates to `honorsLaunchMode`. The docblock's "One definition on purpose" asserts single
ownership per question, not deliberate duplication.

**Two is not the rework signal, so the justification is not "three strikes."** It is the norm's
migrate retroactivity: #1251–#1255 each need a disposition and a rendered reason, and hand-building
five more is how the shape stops being a shape.

Build the generic disposition: given a setting and a project's engine, answer whether it applies,
and when it does not, carry the reason as text the UI can render. The existing three become callers
or stay as named wrappers over it — a rename is not the goal, one definition is.

**Done when**
- One predicate answers "does this setting apply on this engine, if not why, and was the stored
  value a real operator choice" — the third part needs the setting's shipped default as an input,
  or the warn/info level below stays hand-picked per call site and the rule survives only as long
  as each author remembers it.
- The two existing predicates (`honorsLaunchMode`, `silentPrimeDisposition`) route through it or
  are expressed in terms of it, and `reconcileLaunchMode` — already a caller, not an
  implementation — keeps delegating rather than growing one. No new parallel implementation
  exists at the end of the chunk.
- The warn/info asymmetry survives, and it belongs to the VALUE rather than the setting: a
  dropped value the operator actually chose warns; one indistinguishable from what the product
  ships records at info. So a stored `defaultLaunchMode` of `'plan'` warns and a stored
  `silentPrime` of `true` records — but a stored `silentPrime` of `false` warns too, same setting,
  other value. A test pins both directions, because collapsing them is the obvious "cleanup" and
  naming a setting as "the info one" is how the per-setting rule creeps back.
- The browser predicate stays in parity with the server's — `public/` cannot `require()` `lib/`,
  so the existing restated-copy-plus-parity-test arrangement continues rather than being invented
  differently. **The reason *text* is part of that surface**, not just the boolean: a reason that
  drifts tells the operator something the server does not believe.

### Chunk C2b — Eval Audit becomes reachable (#1236)

**Design correction, found while building (2026-09-04). C1 §5/§6 classified `evalAuditMode` as
genuinely universal on the grounds that "ingestion is server-side". The route is server-side; the
*feed* is not.** `POST /api/audit/ingest` authenticates a bearer token against
`openclaw_connections.auditSecret` and resolves the project as the one whose
`engineId === 'openclaw:<conn.id>'`. It is the only write path into `evalExchanges` — verified by
grep across `lib/` and `server.js` — and every score, anomaly and incident is downstream of an
exchange. So on a project not bound to an OpenClaw connection, enabling Eval Audit stores a value
that can never produce a row.

That is the same shape as the design's own §5 defects, and building the universal toggle C1
specified would ship the exact defect #1236 was filed for. **The classification changes to
engine-conditional and the control goes through C2a's mechanism** — which is what the plan predicted
when it said C2a is what makes each of these cheap. The design pass reasoned from "the route is
server-side" without asking who can authenticate to it; that is the same *diagnosis-is-a-hypothesis*
failure the chunk header warns about, one layer up, and it is the fourth Train 12.5 car whose
written premise did not survive being checked.

Its home is still the project settings modal (nothing about the two-surface split changes).

Three separate gaps, all verified absent:
- `updateProject` has **no `evalAuditMode` branch at all** — the whole write path is new.
- `enrichProject` returns only a derived `{enabled, openIncidents}` summary
  (`lib/projects.js#enrichProject`), so the modal cannot read back what it needs to render a control.
- The dashboard empty state reads "No projects have Eval Audit enabled." (`public/ui.js#renderAuditPanel`) —
  true, and actionable by nobody.

**Done when**
- Eval Audit can be enabled and disabled from the project settings modal, and the value round-trips
  through `PATCH /api/projects/:name` with validation.
- The control is live on a project bound to an OpenClaw connection and **inert with a rendered
  reason everywhere else**, through `ENGINE_CONDITIONAL_SETTINGS` rather than a fourth hand-built
  gate. A `PATCH` enabling it on a project that cannot feed it is refused with the same sentence.
- The merge is a merge: `evalAuditMode` holds fifteen hand-edit-only tunables beside `enabled`, so
  a PATCH that replaced the object would silently discard a configured `costCapPerSession` or
  `judgeModel`. Unknown keys are refused rather than ignored — silently accepting input that does
  nothing is the norm's own failure.
- The control makes the cost visible before it is switched on. Enabling starts LLM-judge calls at
  Tier 2/3; #1236 asks for this explicitly, and a checkbox that reads free is the wrong answer.
- The empty state names what Eval Audit does and how to switch it on, replacing the dead-end string.
- Enabling it on a project and opening the Audit panel shows that project — the end-to-end path
  #1227 could not find, which is why that issue was filed as "delete this dead button".

### Chunk C2c — `showLaunchModePicker` at creation, then close #626 (#626)

C1 verified #626 against source: the wizard is four steps collecting five fields, and launch
posture plus silent prime — the issue's own "defensible split" — already ship. Measured against the
issue's own first-session-load-bearing bar, one field remains.

`showLaunchModePicker` is the pair of `defaultLaunchMode`, which is already on step 2, and it
carries a real guard: hiding the picker while the resolved default carries a warning
(`bypassPermissions` / `fullAuto` / `yesAlways`) requires `confirmBypassHidden`
(`lib/projects.js#updateProject`, the `effectiveShow === false` branch; client mirror
`public/ui.js#confirmBypassHidden`).

**Done when**
- Step 2 collects `showLaunchModePicker`, and `createProject` persists it.
- The `confirmBypassHidden` guard applies at creation, not only on later edit — creating a project
  that launches straight into a warned mode with no picker is exactly what that guard exists to
  stop, and the create path is the one place it has never run.
- #626 is closed by the PR with a re-scope comment recording what had already shipped.

### Not in C2, deliberately

- The engine-settings surface, #764's extension inventory, #581's tunables content.
- The five defects filed from the C1 audit (#1251–#1255). They are defects under the new norm and
  they are not this chunk's scope; C2a is what makes each of them cheap to fix.
- #737's profile staleness and #738's picker convergence — both open, both named in the design as
  constraints to respect rather than work to absorb.

### Standing constraints

- **Branch in a worktree.** `public/ui.js` is served live off this working tree; the primary
  checkout stays on `main`.
- **`Fixes #1236` and `Fixes #626`** on the PR. PR #1235 omitted the keyword and #758/#1181 sat
  open after merging.
- **`#764` stays OPEN deliberately, and the PR says so.** C2 builds only the project half of the
  two-surface split; the per-engine global surface (defaults, installed-extension inventory, and
  #581's tunables) is still owed. Post a re-scope comment on #764 recording that split and pointing
  at `docs/adr/0013-settings-take-effect-or-say-why-not.md`, which is the tracked carrier — this
  plan is archived when the chunk ships, and an archived plan is not where the next reader looks.
  Do **not** let a `Fixes` keyword near #764 into the PR body.
- **Squash merge, branch single-use** (`project-preferences.md` § Workflow overrides Prawduct's
  merge-commit default).
- Every new test gets a named mutation verified red. A fixture that cannot reach its subject passes
  forever — that happened twice in chunk B.
- Append to `.prawduct/operator-verification.md` at chunk close: the settings modal and create
  wizard are both operator-visible and no test can see a rendered control.

## Status

- [x] Chunk C1 — design: the split, the hard-class norm, #1236's home, #626's re-scope
- [x] Chunk C1 — operator rulings surfaced and answered (R1 project-half, R2 ratify-migrate, R3 file)
- [x] Chunk C1 — C2 build plan written
- [x] Chunk C2a — one disposition mechanism
- [x] Chunk C2b — Eval Audit reachable (#1236)
- [x] Chunk C2c — showLaunchModePicker at creation, close #626
- [x] Chunk C2 — tests written, every new test mutation-verified red
- [x] Chunk C2 — suite green, evidence from `prawduct-hook test-status`
- [x] Chunk C2 — CHANGELOG entry
- [x] Chunk C2 — cumulative Critic + verify-resolutions, final round clean
- [ ] Chunk C2 — PR with `Fixes` for each car it closes

## Open for the operator

- **#626's fate.** If C1 decides the shipped four-field split is right, #626 closes as done with a
  re-scope comment rather than shipping anything. That is a legitimate outcome and needs saying out
  loud, not quietly.
- **Archiving.** Chunk A and B plans are archived; this one joins them when C2 merges.
