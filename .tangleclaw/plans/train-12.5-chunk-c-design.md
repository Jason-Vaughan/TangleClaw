---
name: train-12.5-chunk-c-design
governed_by:
  - .prawduct/artifacts/architecture.md
  - .prawduct/artifacts/prime-delivery-direction.md
  - .prawduct/artifacts/nonfunctional-requirements.md
  - .prawduct/artifacts/project-preferences.md
  - .prawduct/artifacts/interaction-design.md
---

# Train 12.5 chunk C1 — the per-engine settings axis

**Cars:** #764, #626, #1236 · **Base:** `607f98f` · **Type:** doc-only (C1 writes no product code)
**Produced by:** four read-only discovery sweeps, each claim re-verified against source before use.

---

## 1. The finding that reframes #764

**#764 asks for one surface. The evidence says there are two, and only one of them is
multi-engine.**

A **project settings modal is scoped to one project, and a project has exactly one engine.** It
never needs to display Codex's settings beside Claude's — it needs to display *this project's*
engine's settings, correctly. That is not a tab problem. It is the problem the codebase already
solves inline, twice, in `renderSilentPrimeToggle` (`public/ui.js#renderSilentPrimeToggle`) and
`renderLaunchModeSettings` (`public/ui.js#renderLaunchModeSettings`) — a capability-gated control that re-renders when
the engine dropdown changes.

The genuinely multi-engine surface is a different one: **per-engine defaults and per-engine
inventory**, which are global, not per-project. #764's own motivating example gives it away —
*"enable Prawduct by default on every new Claude project"* is a statement about an engine across
all projects, and there is nowhere in a single project's settings for it to live.

So the design splits #764 in two:

| Surface | Scope | Engine axis | Shape |
|---|---|---|---|
| **Project settings** (existing modal) | one project | one engine — the project's own | No switcher. Generalize the existing capability-gated inline rendering. |
| **Engine settings** (in global settings) | all projects | many engines, unbounded | One engine selector, then that engine's panels. |

**Three problems dissolve at once.** The mobile constraint (§3) applies only where a tab bar would
have been, and neither surface has one. The unbounded roster (§2) is a `<select>`'s natural case.
And #581's shell question (§7) resolves cleanly, because TangleTweaker's tunables are per-engine
global settings, which is exactly the second surface.

---

## 2. Why "tabs" specifically cannot be built

One constraint is decisive; a second consideration reinforces it.

**The roster grows without a UI change — which is the point of #764, and the problem for tabs.**
The picker roster is **exactly four**, not unbounded: `listWithAvailability`'s own docblock (`lib/engines.js#listWithAvailability`) records that
per-connection virtual engines "were removed for the same reason" as `pickerHidden` — only
`getWithAvailability('openclaw:<id>')` still resolves them, for launch paths. So there is no
runtime multiplication.

What remains true is #764's own requirement: *"Tabs are generated from the engine roster, so adding
an engine to TangleClaw adds its tab without a UI change."* A tab bar sized for four that silently
breaks at six is not generated-from-the-roster; it is hardcoded-for-today wearing a loop. The
constraint below is what decides it.

**The mobile norm forbids it.** `nonfunctional-requirements.md` § Direction (ratified 2026-08-01)
binds: *"If it doesn't work on mobile, it doesn't ship"*, iPhone Safari 320–375px is the primary
client, interactive elements ≥44×44px. `interaction-design.md` §5.1 specs the settings modal at
`max-width: 340-400px; width: 90%` — 288–337px usable. Six tabs is 48px each with no room for a
label, and §4.3 forbids the usual escape hatch: *"No horizontal swipe gestures on the main
screens"*, deliberately, because they fight Safari's back gesture.

**[DECISION: the tabbed metaphor in #764 is not implemented | it fails a ratified mobile norm and
cannot express an unbounded roster; the two-surface split in §1 delivers what #764 actually wants
without it | user can veto]**

---

## 3. Norm reconciliation

| Governing artifact | Norm | Disposition |
|---|---|---|
| `nonfunctional-requirements.md` § Direction | Mobile-first, ≥44px, primary client 320–375px | **conforms** — no tab bar; one selector control and stacked panels, both of which hold at 288px |
| `nonfunctional-requirements.md` § Direction | Accessibility floors are requirements | **conforms** — a disabled control carries its reason as text, never color alone; the reason is the label's sibling, so it reaches a screen reader |
| `prime-delivery-direction.md` § Direction §1 corollary | *"a channel's limit is a declared property of the engine"* — per-engine facts are declared in the profile, never hardcoded | **conforms, and extends** — panels are generated from the roster; §4's rule makes the same demand of settings that this makes of channels |
| `architecture.md` § Direction | *"a read that could not be established reports `null` and names itself, never a plausible default"* | **inapplicable because** it governs failed *reads*; a setting an engine cannot honor is a successful read of a real value with no effect. Adjacent, not covering — which is why §4 is a new norm rather than an application of this one. |
| `project-preferences.md` § Enforcement | Norm registry | **amendment proposed** — §4 needs a new row |
| `project-preferences.md` § Workflow | Squash merge; branches single-use | **conforms** — C2 branch is single-use |

---

## 4. The rule for the hard class — proposed norm

The audit's central result: **"universal but unevenly supported" is not the hard middle case of
three. It is nearly the whole population.** Nothing in the capability matrix is a clean universal —
`supportsPrimePrompt` and `supportsConfigFile` are true everywhere except OpenClaw;
`supportsSlashCommands` is declared by all five profiles and true for only two. So the rule for
this class carries essentially the entire feature, and the three-way taxonomy #764 asked for
collapses into one rule plus two thin edges.

> **Proposed norm — A setting TangleClaw offers must take effect, or say why it does not.**
>
> Where TangleClaw presents a setting for a project, that setting either takes effect on that
> project's engine, or the surface that offers it states — at the moment it is offered, in words —
> that it does not apply here and why. Hiding the control is not compliance, and neither is a log
> line the operator will never read.
>
> **Why:** a control that stores a value and does nothing is indistinguishable from a broken
> product, and it is the most expensive kind of defect this project has: #741, #758, #1227 and
> #1236 are four filings of one bug. #1227 was filed as "delete this dead button" — a working
> feature came within one session of being removed because nothing said why it looked dead.
>
> **Retroactivity: migrate.** Known live instances are named in §5; each is a defect under this
> norm from the moment it is ratified, not a grandfathered exception.

**Mechanism, reusing the shipped pattern rather than inventing one.** #741's fix is *not* generic.
`lib/engines.js` carries **two** capability predicates — `honorsLaunchMode` and `silentPrimeDisposition` — with separate
implementations. `reconcileLaunchMode` is a *caller*, not a third instance: it delegates to
`honorsLaunchMode`. And `silentPrimeDisposition`'s docblock ("One definition on purpose, like
`honorsLaunchMode` above") asserts single ownership of each question, not deliberate duplication.

**Two is not the rework signal.** What justifies generalizing is §4's migrate retroactivity: five
instances (#1251–#1255) each need a disposition and a rendered reason, and hand-building five more
is how a shape stops being a shape.

One asymmetry the generalization must preserve, because it is deliberate and easy to flatten:
`defaultLaunchMode` logs at **warn** when dropped (`lib/sessions.js#launchSession`); `silentPrime` logs at
**info** (`lib/sessions.js#launchSession`). The comment there explains why — `silentPrime` defaults to `true`
for every engine, so a stored `true` is indistinguishable from "operator never touched this," and
warn would fire on every non-Claude launch about a preference nobody set. **The log level is a
function of whether the stored value was a real choice, not of the setting's importance.**

---

## 5. The classification, and what it exposes

The full per-setting inventory was produced by the discovery pass in-session and is **not** on
disk anywhere; what follows is its durable form — the classification and the defects it surfaced.
Anything the classification does not name was not audited, and should be re-derived from
`lib/project-config.js#DEFAULT_PROJECT_CONFIG` and `lib/projects.js#updateProject` rather than
assumed covered.

**Genuinely universal** (identical on every engine): `versionBumpEnabled`, `versionFilePath`,
`wrapSections`, `wrapStepOverrides`, `testCommand`, `lintCommand`, `wrapAutoPrEnabled`, `tags`,
`medusaEnabled` (the listener is TC-server-side — `lib/projects.js#_syncLiveMedusaListener`), `evalAuditMode`
(ingestion is server-side).

**Engine-specific with an honest guard today** — the shape to generalize: `defaultLaunchMode`
(validated against the intended engine, reconciled to `'default'` on an engine switch —
`lib/projects.js#updateProject`, `2593`), `silentPrime` (rejected at write for a non-supporting engine
`lib/projects.js#updateProject`, disposition at launch, disabled-with-reason in the modal).

That list is **two settings, not three**. `medusaWake` was classified here in an earlier pass and
has been moved down: its guard is a log line, and §4 says in terms that a log line the operator
never reads is not compliance. Classifying it as the shape to generalize would have made the norm
exempt the most plausible wrong answer to itself.

**Silently inert — defects under §4.** Each was verified against source:

1. **`rules.core.*` and `rules.extensions.*` have zero effect on `openclaw`, deliberately and
   silently.** `writeEngineConfig` returns `{skipped: true}` when the profile has no
   `configFormat.filename` (`lib/engines.js#writeEngineConfig`), and the comment says the silence is intentional
   — *"Per #240 PR Critic — silently skip so callers don't surface a spurious … error/warning."*
   The reasoning was sound for its own scope (don't shout on every launch) and produced the exact
   failure #764 exists to prevent: a project with `independentCritic: true` on OpenClaw gets
   nothing, and nothing anywhere says so. **This is the loudest instance in the codebase.**
2. **`featureIndexEnabled` / `projectMapEnabled` are half-inert off Claude.** The wrap-side seeding
   runs on every engine, but the *prime pointer* that tells the agent to read the file is gated on
   `supportsSilentPrime === true` (`lib/sessions.js#generatePrimePrompt`, `1374`) — Claude only. So on every other
   engine the toggle builds a file no session is ever told to open. `lib/project-config.js#DEFAULT_PROJECT_CONFIG`
   states the toggle is "engine-agnostic so the toggle is not engine-gated" — true of the wrap
   half, false of the prime half, and nothing tells the operator.
3. **`rules.extensions.loggingLevel` is inert on three of five generators.** Its default is the
   string `'info'`, and `_getRulesContent` filters `v === true` (`lib/engines.js#_getRulesContent`), so it never
   renders as prose. Only `codex-yaml` and `aider-conf` consume it directly.
4. **Five declared capabilities are never read by any app code** — `supportsSlashCommands`,
   `supportsCoAuthor`, `supportsRemote`, `supportsModes`, `awareness` appear only in tests. Any
   panel rendering "this engine's capabilities" would present dead flags as meaningful.
5. **Per-engine data living outside the profiles.** `ENGINE_WAKE_PROFILES`
   (`lib/medusa-wake.js#ENGINE_WAKE_PROFILES`) hardcodes `claude` and `antigravity` only. This is the shape
   `prime-delivery-direction.md` § Direction §1 already forbids for channel limits, one layer over.
6. **`medusaWake` tells the log, not the operator.** An engine with no wake profile is skipped and
   logged "once per session, never silent" (`lib/medusa-wake.js module docblock`) — genuinely better
   than instances 1-3, and still not compliant: the operator is remote and does not read the log.
   The settings modal compounds it by claiming the feature is "Claude sessions only for now"
   (`public/ui.js#openSettings`) when antigravity has been supported since #560, so the one
   operator-facing string is both the wrong channel and out of date. Tracked on #1255.

**Settings with no write path at all** (hand-edit only): `evalAuditMode` (#1236),
`orchestrationKeyRef` / `orchestration_profile`. **Raw-PATCH only, no UI:** `wrapDisabled`,
`wrapAutoPrEnabled`, `wrapStepOverrides`, `testCommand`, `lintCommand`, `rules.extensions.*`.
**Dead:** per-project `quickCommands` (written `lib/projects.js#updateProject`, read by nothing — the
session page reads the *global* list at `public/session.js#renderCommandPills`), per-project `ports`
(`lib/project-config.js#DEFAULT_PROJECT_CONFIG`, read by nothing; the real port data is the DB column).

**Taxonomy trap.** The settings modal's "Project Rules" section (`renderProjectRulesSection`,
`public/ui.js#renderProjectRulesSection`) is a *different feature* from `project.json`'s `rules.core` / `rules.extensions`
— free-text `session_rules` DB rows versus a config object, separate storage, separate consumer,
shared word. They are two rows in any taxonomy, never one.

---

## 6. #1236 — Eval Audit's home

**Resolved by §1: it is a per-project setting, so it belongs in the project settings modal, and it
does not wait for anything.** #1236 deferred its home to #764 on the reasoning that the modal was
about to be restructured into per-engine tabs and Eval Audit is OpenClaw-fed. Neither half survives:
the modal is not getting tabs, and audit ingestion is server-side (`POST /api/audit/ingest`,
`server.js, the POST /api/audit/ingest route`) — it is not an engine capability at all, so it is universal by §5.

Three things C2 must get right, all from #1236's own text:
- The empty state must name what Eval Audit does and how to enable it. Today it reads *"No projects
  have Eval Audit enabled."* (`public/ui.js#renderAuditPanel`) — true, and actionable by nobody.
- Enabling it starts LLM-judge calls at Tier 2/3. The control makes that cost visible; it must not
  read as a free checkbox.
- `updateProject` has no `evalAuditMode` branch at all (verified — zero hits in the validation
  block), and `enrichProject` returns only a derived `{enabled, openIncidents}` summary
  (`lib/projects.js#enrichProject`). Both the write path and the read shape are new work.

---

## 6b. Where a per-engine default is applied, and what happens to existing projects

The answer is **forced by a ratified norm rather than chosen**.

**How defaults reach a project today.** There is no per-engine setting default anywhere in the
product. Two mechanisms exist, both at creation and both one-shot:
- The **global** `config.defaultEngine` seeds the engine, resolved against what is actually
  installed (`engines.resolveDefaultEngine`, guarded since #707 so a project cannot be bound to an
  engine this machine lacks).
- `DEFAULT_PROJECT_CONFIG` is **cloned** into the new project's own `project.json`
  (`lib/projects.js#createProject`), which then owns every value.

**So a default is a seed, not a live reference — and it must stay one.** `data-model.md`
§ Direction binds: *"A project's configuration travels with the project. `<project>/.tangleclaw/project.json`
is the source of truth… a project must survive being moved, cloned, rsynced, or handed to another
machine with its configuration intact."* A per-engine default that kept applying after creation
would be config living in TangleClaw's install rather than in the project, which is precisely what
that norm refuses. A cloned project would change behavior on arrival at a machine whose per-engine
defaults differ.

**The answers:**
1. **Applied at creation only**, as the seed for the new project's own config. Never re-read at
   launch, never consulted for an existing project.
2. **Changing a per-engine default does nothing to projects that already exist.** Not "we chose not
   to migrate" — retroactive application would violate the config-travels norm.
3. **The consequence must be visible where the default is set**, or the operator will reasonably
   expect it to propagate. The per-engine defaults panel says, in words, that it affects new
   projects only. Under §4's norm a control whose scope is misread is the same defect as one that
   does nothing.
4. **The creation wizard is where the seed becomes honest.** #626's step 2 already shows the
   operator the launch posture and silent prime a new project will get; a per-engine default
   changes what those fields are *pre-filled with*, not whether the operator can see or change
   them.

**[ASSUMPTION: no operator has asked for a default that retroactively applies | MED impact | user
can correct]** — if that is wanted, it is a different feature (a bulk edit across existing
projects, with its own confirmation), not a default, and it needs its own issue.

## 7. The shell contract, and #581

The second surface — engine settings in global settings — is built once and hosts two tenants.

- **Roster source — and it is not simply `listWithAvailability`.** That function filters
  `pickerHidden`, which is correct for "assign an engine to a project" and **wrong here**: it would
  drop OpenClaw from a per-engine settings surface, and OpenClaw is the engine feeding Eval Audit.
  The deferred surface needs a roster that includes connection-backed harnesses even though they are
  never a local project's engine. Whether that is a second exported view or a parameter is the
  building chunk's call; that it cannot reuse the picker's filter unexamined is this design's.
  Separately, it is *not* `tcBuildEngineOptions` (`public/api-helper.js#tcBuildEngineOptions`),
  which is a renderer over an availability-enriched array — #738's convergence target for option
  lists, not for a panel roster.
- **Selector:** one control, honoring the existing availability semantics (unavailable engines
  listed but disabled). #581's own v0 spec already assumes exactly this — an engine selector with
  Codex/Antigravity greyed out as *"(in development)"* — so the tenant's requirement is already
  written and the shell can be validated against it now.
- **Panels declare themselves**; an engine with no content for a panel renders an honest empty
  state naming the engine and the reason, never a blank.
- **#581 docks as a panel** (read-only tunables in v0, with per-row provenance chips). Nothing of
  #581's content is built in C2.

**A hard caveat the design records rather than fixes.** `_syncBundledEngines` runs once, from
`store.init()` (`lib/store.js#init`). A brand-new engine profile never reaches
`~/.tangleclaw/engines/`, which is the directory every read actually uses — so **a newly added
engine will not appear in any roster until the server restarts.** That is #737, it is open, and C2
must not invent its own re-sync to paper over it.

**An API gap the deferred surface must close — explicitly NOT C2's** (ruling R1 scoped C2 to the
project half, and the project modal reads what it already reads). `GET /api/engines` returns a
deliberate subset (`id`, `name`,
`interactionModel`, `available`, `command`, `install`, `capabilities`, `commands`, `launchModes`,
`defaultLaunchMode` — `lib/engines.js#listWithAvailability`). It omits `configFormat`, `statusPage`, `errorPatterns`.
A panel showing "this engine's config file" cannot get it from the list route.

---

## 8. #626 — substantially shipped

Verified against source: the wizard is **four steps** (0–3: Name, Engine, *First-Session Settings*,
Tags) collecting **five fields** — `createData` at `public/ui.js#createData` carries `defaultLaunchMode`
and `silentPrime`, both posted at `submitCreate`. That is #626's own "defensible split" (launch posture +
silent prime at creation), already built. The issue's cited line numbers no longer correspond to
the wizard, and it lists `methodology` as one of its four fields — **methodology was deleted from
the codebase**, not deferred (migration v27→v28, `lib/store.js#_migrateDropMethodology`, which throws if the column
survives). Its "Sequencing note" defers the rest to Wrap v2 Chunk 04; that chunk shipped and Phase
B is closed.

Measured against the issue's *own* bar — first-session-load-bearing — exactly one candidate
remains: **`showLaunchModePicker`**. It is the pair of a field already on step 2, and it carries the
`confirmBypassHidden` guard (`lib/projects.js#updateProject`, the `effectiveShow === false` branch)
that stops the picker being hidden while the resolved default carries a warning. Everything else it lists (`featureIndexEnabled`,
`projectMapEnabled`, `versionBumpEnabled`, `wrapSections`, rules) the issue itself classes as
"first effect at wrap time or later."

**Recommendation: add `showLaunchModePicker` to step 2, then close #626 with a re-scope comment.**

---

## 9. Open rulings — for the operator, not to be assumed

- **R1 — Does the engine-settings surface (§1, second row) get built in C2, or only the project
  half?** The project half discharges #1236 and the §4 norm; the engine half is where #764's
  inventory and #581 eventually live. Building only the project half is a complete, shippable unit.
- **R2 — Ratify the §4 norm?** It is retroactive-migrate, which makes §5's five instances defects
  on ratification rather than known-ugly. That is the point, and it is also a commitment.
- **R3 — The §5 defects: file now, or fold into C2?** They are pre-existing and out of #764's
  scope, but "there is no pre-existing exception" cuts against leaving them silent.
- **R4 — #764's motivating example is dead** (see below). Confirm the design does not resurrect it.

## 10. What the design must not re-solve

**#763 was closed NOT_PLANNED on 2026-07-29** — declined, not built. #764 calls it *"the mechanism
for 'Prawduct on by default'"* and calls itself *"the control surface that turns it on."* There is
no mechanism to control. The decline reason was the engine-agnostic rule itself: auto-onboarding is
a `.claude/settings.json` plugin key and would be a real no-op on codex/gemini/aider/openclaw.

So **#764's one concrete motivating case cannot be built as a setting** without reopening a refused
decision. The honest surface is the existing read-only `isPluginGoverned` detection
(`lib/governance-state.js#isPluginGoverned`) shown as *status*, never a toggle.

Also not to be re-solved: #737's staleness (§7), #738's `available` predicate (use the existing
strict reading), and #741's disposition *pattern* (reuse the shape, generalize the code).

## Status

- [x] Chunk C1 — four read-only sweeps, every load-bearing claim re-verified against source
- [x] Chunk C1 — governing norms read and reconciled (§3)
- [x] Chunk C1 — the split settled (§1), the hard-class rule drafted (§4), classification done (§5)
- [x] Chunk C1 — #1236's home (§6), shell contract (§7), #626 re-scope (§8)
- [x] Chunk C1 — operator rulings R1–R4 answered 2026-09-04 (see below)
- [x] Chunk C1 — C2 build plan written (`train-12.5-chunk-c.md` § Chunk C2)

## Rulings as answered (operator, 2026-09-04)

- **R1 — C2 scope: the project half only.** The engine-settings surface (§1, second row) is a later
  chunk. Its *shape* is settled here (§6b, §7); what is **not** settled and belongs to that chunk:
  the roster view that includes connection-backed harnesses, the `GET /api/engines` shape gap, and
  #581's tunables content. Read §7 before building it — do not treat "designed" as "specified".
- **R2 — the §4 norm is RATIFIED, retroactivity migrate.** Recorded in `architecture.md`
  § Direction and registered in `project-preferences.md` § Enforcement. §5's instances are defects
  from ratification, not grandfathered.
- **R3 — the §5 defects are filed, fixed separately:** #1251 (OpenClaw rules drop), #1252
  (featureIndex/projectMap half-inert), #1253 (`loggingLevel` unrenderable), #1254 (five unread
  capabilities), #1255 (wake data outside the profiles). None are C2 scope; C2a is what makes each
  cheap to fix.
- **R4 — confirmed:** the design does not resurrect #764's dead motivating example. `isPluginGoverned`
  is surfaced as read-only status, never as a toggle.
