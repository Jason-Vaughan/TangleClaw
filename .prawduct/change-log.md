# Change Log — TangleClaw

<!-- Append new entries at the top.

Tag-line conventions (ART-4K9M, ratified 2026-07-17):
- scope=  : ONE scope per unit of work. Work done under an ACTIVE build plan uses that
  plan's frontmatter scope (its ## Status roster derives checkbox flips from these tags).
  Post-plan work — backlog items, GH-issue fixes, chores landing after the plan is
  archived — gets its OWN scope (kebab-case of the backlog id or issue, e.g. ui-2p7t,
  wrap-583), NEVER a borrowed scope from an archived plan: an archived roster can't track
  new chunk ids, so borrowed tags rot (the ART-4K9M failure). A scope with no build-plan
  file is fine — regen-views flags it only while status=merged, and deliberately not once
  status=shipped (retired/planless scopes are expected history).
- status= : (none) on branch → `shipped` stamped at merge (AMENDED 2026-07-17, ratified
  under ART-7W2J/PRW-9K4C: upstream trunk semantics — TC restarts the server onto main
  right after merge, so merged work IS live; the wrap's version number is bookkeeping.
  The prior intermediate `merged` state created a merge→wrap window where prawduct
  3.0.5's fail-closed regen-views flagged every planless small-fix scope fatally).
  The WRP-9F2K release flip stays as a safety net (flips any `merged` stragglers at
  the next wrap promote); a STATUSLESS tag line remains the missed-stamp diagnostic.
  TC skips `release=` tokens — CHANGELOG.md is TC's release-notes surface, not
  prawduct's release-notes.md. regen-views derives build-plan Status checkboxes from
  status=shipped ONLY — the old convention left released work stuck at `merged`, which
  un-ticked genuinely shipped chunks (2026-07-17 back-stamp: 29 entries across
  v4.5.0–v4.19.0).
-->


## 2026-07-20: Chunk 05b — the operator review surface for wrap-proposed rules (#569)

<!-- prawduct: type=feat | chunks=05b | scope=wrap-v2 | status=shipped -->

**Why:** 05a made the loop safe and auditable but API-only — a proposal could only be
approved or rejected by hand-crafting a `curl`, and the operator is almost always remote,
on a phone. The review surface is what makes the human gate usable rather than
theoretical.

**What:** the wrap drawer renders the `rule-proposal` step's output as a decision widget
following the established descriptor→renderer pattern (`ruleProposalWidget` in
`public/wrap-drawer.js`; `renderRuleProposalWidget` / `resolveRuleProposal` in
`public/session.js`): per proposal, editable text + Approve / Reject. Approve saves any
edit BEFORE flipping status (never activate text the operator didn't see), replays the
wrap modal's cached password against the `PUT /api/session-rules/:id/status` gate, and a
403 reveals an inline password input instead of failing opaquely. Reject is ungated and
recorded. Decisions are per-rule API writes, not pipeline retries — no double-commit
path. The step now also reports the provisional-learnings backlog on every exit path
(`lib/wrap-steps/rule-proposal.js` counts `tier:'provisional'`; the drawer's detail line
and skip reasons carry "N provisional learnings building recurrence" — #569 proposal 3).
Pending proposals also surface in the Settings modal's Project Rules list with an amber
`Proposed` badge and an inert enabled-toggle (`fetchProjectRules` now fetches unfiltered
and drops only rejections client-side). Per the cumulative Critic's two warnings (one
root), the modal is the **durable** decision surface: the drawer renders only the wrap
that just ran, so proposed rows carry their own Approve / Reject buttons IN PLACE of
Delete (`resolveProjectRuleProposal`) — deleting a proposed row would erase the recorded
decision and re-arm re-proposal; approve is the same gated status route, with a hidden
password field revealed on 403. `public/sw.js` CACHE_NAME bumped (ui.js/style.css
are precached).

**Tests:** `test/wrap-rule-proposal-widget.test.js` (new — source-level pins on the
widget: edit-save ordering, 403 recovery, no-retry, a11y, 44px targets);
`test/wrap-drawer.test.js` (+8: `ruleProposalWidget` edge cases, backlog detail);
`test/self-improvement-loop.test.js` (+4: backlog counts on every step exit path);
`test/project-rules-modal.test.js` (+6: badge, unfiltered fetch, inert toggle,
Approve/Reject-instead-of-Delete, status-route wiring with 403 password reveal). Full
suite 4745 pass / 0 fail / 1 skipped.

**Operator verification:** queued as VRF-569-proposal-review (visual, iPhone). Closes
#569 with 05a.

## 2026-07-20: Chunk 05a — the self-improvement loop stops being a loop on paper (#569)

<!-- prawduct: type=feat | chunks=05a | scope=wrap-v2 | status=shipped -->

**Why:** both halves of #569's loop were drawn but disconnected. Every captured learning
was written `provisional` and nothing ever advanced one, so the `## Active Learnings`
block injected at session start was empty on every project, permanently. And nothing
turned a learning into a rule: `promoteFromLearning` had exactly one caller, an HTTP
route no UI invoked.

**Discovery correction:** the advancer looked nearly free — `learnings-db-write` already
dedups and `confirm()` already auto-promotes — but the dedup compares full content
INCLUDING the entry's own `## YYYY-MM-DD` heading, so it is a same-day retry guard that
can never see a recurrence. A date-independent normalized key was the actual missing
piece.

**Promotion bar is two sightings, owned by the step.** `confirm()`'s own threshold is 2
confirmations (three sightings), which for exactly-matching normalized text almost never
happens; deferring to it would have left the tier gate shut and reproduced the dead-end
in softer form. `confirm()`'s general contract is untouched.

**Proposals got `session_rules.status`** (`proposed|active|rejected`, v26→v27) rather
than reusing `enabled`, which means "the operator switched this off" — storing proposals
there would make a REJECTED rule indistinguishable from an unreviewed one and the wrap
would re-propose declined rules forever. Rejection is a recorded state for that reason.

**The Critic's blocking findings were one root, and it was mine.** I put the authority
decision at the HTTP boundary and assumed reaching a route meant a human pressed a
button. The API is on localhost and this project instructs in-session agents to call it,
so an agent could curl a learning straight to a governing rule. Authority now comes from
the operator-password gate, and the docs state the true ceiling instead of claiming an
unconditional human gate. Also missed `findConflictCandidates` in the status-reader
audit.

**Deferred to 05b:** the approve/reject UI. `session_rule_versions` has no `status`
column, so a decision is recorded as free-text `change_reason`.

**Classification:** build

## 2026-07-19: Chunk 04c — a project can turn off a wrap step without forking its methodology

<!-- prawduct: type=feat | chunks=04c | scope=wrap-v2 | status=shipped -->

**Why:** `wrap_pipeline.steps` is framework-owned and shared by every project on a
methodology, and the boot-time reconcile clone-replaces that whole subtree on a
`schemaRevision` bump. So the only supported way to turn one step off was forking the
entire pipeline into a new methodology, which then stopped receiving framework updates —
and editing the template in place looked like it worked until the next boot silently undid
it. Overrides now live in the project's own `.tangleclaw/project.json`, which no
template-sync path writes; the split mirrors `rules.core` (framework-owned, force-reset)
vs `rules.extensions` (project-owned, preserved).

**Scope correction found in discovery:** the plan's premise that `versionBumpEnabled`,
`featureIndexEnabled`, `projectMapEnabled`, `wrapSections`, and `silentPrime` still needed
to "become the real configuration surface" was stale — all five already existed with live
runtime gates. The only genuinely-new work was the step-override mechanism.

**Ratified boundary (operator, 2026-07-19):** disable/reconfigure only. Order and
membership stay framework-owned, because step order encodes correctness contracts between
steps (changelog before version-bump before commit) that are guaranteed by one fingerprint
check against the bundled list; per-project ordering would convert one checked global
property into an unchecked per-project one — the same defect shape 04b existed to close.

**Two exclusions are load-bearing, both Critic-sharpened:** `verifyChanged` is not
overridable (emptying it would leave a verification reporting success while checking
nothing), and a `commit`-kind step cannot be disabled (it is the sole staged-write flush
point, so disabling it would leave every other step reporting work that never lands — the
Critic caught this one; the first cut allowed it). `blocker` IS overridable, and the
distinction is honesty rather than strength: a non-blocking step still runs, still
verifies, and still reports failure in the drawer.

**Also fixed from the Critic pass:** the CHANGELOG and plan both documented
`blocker: "errors-only"` as the way to stop a step halting the wrap — it is the opposite,
a stricter form of `true` that halts. Corrected to `false` in both.

**Classification:** build

## 2026-07-19: Chunk 04b — the wrap stops reporting success it never verified (#571, #638, #540)

<!-- prawduct: type=feat | chunks=04b | scope=wrap-v2 | status=shipped -->

**Why:** four holes of one shape — the drawer reported outcomes it had not confirmed.
(1) **Agent file-edit steps were verified by nothing.** `changelog-update` and
`learnings-capture` exist to edit `CHANGELOG.md` / `learnings.md` but carry no
`captureFields`, so `ai-content`'s only success gate was a ≥20-char reply; an AI
answering "done" without touching the file passed, with the prompt asking it to
self-verify on the honor system. New `verifyChanged: string[]` step field: the handler
snapshots the named paths before the AI runs and blocks unless one actually differs
(created / deleted / edited). Unreadable both before and after also blocks — an edit
that can't be confirmed is not one that happened. (2) **A blocked wrap PR rendered as
success (#638).** The commit step arms auto-merge and returns, but the release only
lands when the PR merges; on #636 a red required check left it blocked, `main` never
moved, every step read Done. The release outcome is now formally NOT a step result
(ADR 0002 amendment): an armed-but-unmerged PR paints `provisional`, and new
`lib/wrap-pr-status.js` + `GET /wrap/pr-status` resolve merged/pending/blocked/unknown
via `gh pr view`. Blocked paints as failure; unknown stays indeterminate. A pipeline
warning/error survives a green release (`composeReleaseBanner`) so the probe can't
repaint a problem wrap as shipped. (3) **Skips were silent (#571 item 4)** — the drawer
now reports "Skipped N of M steps" with each reason. (4) **#540 ask-mode** — a
bump-level selector in the wrap modal threading `options.bumpLevel`, replayed across
retries and reset to Auto on every open.
**The Critic caught the one that mattered:** `version-bump` ran BEFORE
`changelog-update` while staging the whole promoted `CHANGELOG.md`, and the commit
flush writes staged content back verbatim — so the AI's changelog entry was silently
discarded on every wrap that bumped, and the bump level was derived from a CHANGELOG
missing the session's own entry. D6 made it acute by certifying the change moments
before it was thrown away. Fixed by the reorder this chunk was chartered to do
(agent writes, then mechanical promote), pinned by a general invariant test: any
`ai-content` step declaring `verifyChanged` on `CHANGELOG.md` must precede
`version-bump`. **And the reorder alone was not the fix:** the Critic's
verify-resolutions pass caught that `wrap_pipeline.steps` is a
`FRAMEWORK_OWNED_PATH` merged additively by id, so a REORDER only reaches a
materialized live template through `_reconcileFrameworkSubtrees`, gated on
`bundledRev > liveRev`. Bundled and live both sat at `schemaRevision: 5`, so the
gate never opened — verified against this machine's live template, which still
carried the clobbering order while all three new ordering tests passed green
against the bundled JSON. `schemaRevision` 5→6, plus two guards that close the
class: a step-order fingerprint keyed by revision (reorder without a bump now
FAILS, verified by reverting), and a propagation test driving a stale live
template through the real `_mergeBundledTemplate`. Full suite green. Plan:
`/Users/jasonvaughan/Documents/Projects/TangleClaw/.prawduct/artifacts/wrap-v2-build-plan.md`.

## 2026-07-19: Chunk 04a — version-bump fails closed instead of bumping the wrong thing (#540, #571)

<!-- prawduct: type=fix | chunks=04a | scope=wrap-v2 | status=shipped -->

**Why:** three paths in `version-bump` where the step silently did something other
than what was asked — the same defect class, found by #540's re-verification from a
TiLT v2 session. The step only probed lowercase `version.json` before falling back to
`package.json`, so on a case-sensitive filesystem a `VERSION.json` project resolved
nothing, fell through, and bumped an unrelated version — writing a bogus release
heading above the real one. The drift guard that existed to catch exactly that was
`if (topReleased && …)`, and its parser returns null for any non-3-octet changelog, so
on the 4-octet scheme that triggers the bug the guard skipped *itself*. And an
out-of-set `bumpLevel` override fell through to the heuristic, turning a typo into a
different bump with no signal.

**What:** `versionFilePath` project setting (API-validated, UI text field, rejected if
absolute or `..`-escaping at both the API and the write site, since the commit step
flushes whatever it resolves to); a configured path resolves or skips, never falls
back. New `_classifyTopRelease` replaces the `if (topReleased && …)` guard with an
exhaustive classification of the newest release heading — `none` (first release,
bumps), `released` (comparable, drift-checked), `unbumpable` (semver with a
prerelease/build suffix, ambiguous ordering, stops), `foreign` (another scheme,
stops). Invalid `bumpLevel` skips naming the bad value.

**Containment is symlink-aware** (SEC-3H8W, closed here). `resolveWithinProject`
was resolve-lexical, so `linkdir/VERSION.json` — where `linkdir` symlinks out of
the project — passed both the API validator and the write-site guard, and the
commit step wrote through it. It now realpaths the deepest existing ancestor and
re-tests, so a target that doesn't exist yet still resolves while an escape does
not. Verified against real symlinks, not just unit stubs.

**A fourth change, found by review rather than planned:** the section scanner keyed
on `## [`, so a changelog in Keep a Changelog's plain style (`## 1.4.2 - date`) had
no terminator — `_parseUnreleased` ran to EOF and would have swept the whole release
history into the promoted body, and `_classifyTopRelease` read the file as having no
releases at all and bumped past the drift guard. `NEXT_HEADING_RE` is now `/^## /`,
and promotion matches whichever heading style the file already uses rather than
imposing the bracketed one.

**One function because two predicates kept disagreeing** — worth recording, since
this cost two Critic rounds. The guard needs to answer "can I compare against this
heading?" and "is this a scheme I recognize?", and every two-regex version drifted:
first the strict parser alone (self-skipped on any other format — the original
fail-open), then a looser companion check (hard-skipped undated headings and blamed
their "versioning scheme"), then a widened companion (accepted `## [2.0.0-beta.1]`
as recognized while the parser still couldn't read it, so the wrap fell through the
first-release branch and skipped the guard — reopening the fail-open one door down,
which would have written `## [1.0.1]` above it). A single classification can't
disagree with itself.

**Chunk 04 was split** into 04a/04b/04c; the plan carries the reasoning. 04b (spine +
fail-closed agent verification) and 04c (per-project wrap config) turned out larger
than the plan assumed — 04b redefines what `pipelineResult.ok` means, 04c needs a
per-project step-override mechanism that survives `FRAMEWORK_OWNED_PATHS` template
syncs. #540's `ask` mode is explicitly descoped to 04b, which owns the drawer.

**Classification:** build

## 2026-07-18: Phase A Chunk 08 — tc-cleanroom first-run acceptance gate (#618)

<!-- prawduct: type=feature | chunks=08 | scope=prawduct-v2-sunset | status=shipped -->

**Why:** back-filled 2026-07-19. This chunk shipped in PR #618 (merged as `db0a282`)
but never received a change-log entry, so `regen-views` — which derives the plan's
Status roster from these tags — un-ticked a genuinely complete chunk when next run.
The `[x]` was correct; the bookkeeping was missing. Recorded from the merged commit
rather than re-ticking the box by hand, so the roster stays derived rather than
asserted.

**What:** zero-egress Docker clean-room on the habitat host for exercising the
first-time-install experience as a stranger would — `deploy/cleanroom/`
(`compose.yaml`, `provision.sh`, `bake.sh`, `README.md`) plus lockdown-contract
tests. Internal-only network, no published ports, pre-baked image with
`pull_policy: never`, every compose invocation pinned to `-p tc-cleanroom` so the
co-resident production stacks are protected; the repo ships as a git bundle so the
container clones without network. The first gate run filed #614, #615, #616, #617.

**Classification:** build

## 2026-07-19: Chunk 03 — step-inventory cleanup, and open-pr-check becomes a real gate (#570)

<!-- prawduct: type=feature | scope=wrap-v2 | chunks=03 | status=shipped -->

**Why:** the dispatch table carried three step handlers no bundled template referenced —
~970 lines of dead-but-maintained code. Its visible symptom was #570: the prawduct "Run
Critic" action promised "the wrap step's critic-check will pass once findings are
recorded" for a step that stopped running when #353 moved governance to the plugin. A
promise with no mechanism behind it is worse than a missing feature, because it reads as
working.

`critic-check` is deleted (with its option, its drawer widget, and its commit-body
lines); `lint`/`test` stay as opt-in primitives. Dead `promptTemplates` and the inert
`wrap_contract` layer are gone. `open-pr-check` now acts on the resolutions it validated
and never applied: an unresolved session-scoped PR blocks, and `merge` enqueues GitHub
auto-merge so branch protection and checks still decide when it lands.

**What the Critic caught, twice, and it was right both times:** the template edits (`blocker: true`, the
corrected action text) would have been inert on every existing install — `store.js` only
propagates `FRAMEWORK_OWNED_PATHS` on a `schemaRevision` bump, which the diff omitted.
Worse than a no-op: the handler would still block and still enqueue merges while the
runner sailed past, because the halt check reads the *live* template's `blocker`. Bumped
to 5. The same review surfaced an ordering hazard — the gate ran first, so `--auto
--squash --delete-branch` could land and delete the session's branch mid-wrap, and would
have merged a PR missing the wrap commit. Moving the step last fixed that and broke two
other things (round 2): `commit` is the only reader of the gate's staged resolutions and
now ran first, so the PR audit trail in the commit body went unreachable; and a blocking
step after `commit` strands the wrap, because `_completeV2Wrap` is skipped whenever the
pipeline reports failure. The step was therefore SPLIT — `open-pr-check` gates first and
stays read-only, a new `pr-merge` kind applies the resolutions last and never blocks. One
step could not be both first and last, which is the thing neither round-1 position could
have fixed. Round 3 then caught the split's own rationale being false: "runs after `commit`"
does not mean the PR contains the wrap commit, because `commit` pushes only on the
auto-branch path and a session-scoped PR is always on a feature branch — the one path where
the commit stays local. `pr-merge` now pushes before enqueueing, and enqueues nothing if it
can't. An ordering rationale is a claim about state; "runs later" is not the same as "the
state it needs holds."

**Classification:** build

## 2026-07-19: Chunk 02 — engine-agnostic wrap sweep (#612 widened)

<!-- prawduct: type=bugfix | scope=wrap-v2 | chunks=02 | status=shipped -->

**Why:** the wrap had two shapes of engine coupling. The severe one was runtime path
resolution: `priming-roll` resolved plans and priming files inside `.claude/`, so a
project on any other engine found no plan and the step reported "nothing to roll" — a
failure indistinguishable from success. The milder one was prose: the `changelog-update`
prompt told every engine to read `CLAUDE.md`, and the capture-file rationale attributed
markdown rendering to a named product.

**Operator steer (standing, beyond this chunk):** *"we will eventually need to support
multiple LLMs and prime and wrap properly."* Recorded in the build plan — it constrains
chunks 04-06 as much as this one.

**What:** plans/priming default to `.tangleclaw/plans/` and `.tangleclaw/priming/`, with
the legacy `.claude/` locations still READ where they exist (`_resolvePlansDir`,
`_resolvePrimingPath`). TC-owned rather than engine-derived, so a project that switches
engines keeps its plans — an engine-derived directory would relocate them on an engine
change. A new `{engineConfigFile}` interpolation token resolves the filename from the
project's own engine profile; `SUPPORTED_PROMPT_TOKENS` is exported so the drift guard
checks tokens against the implementation. Operator-facing remediation strings no longer
name a specific engine's directory. `data/global-rules.md` + TC's hand-maintained
`CLAUDE.md` updated. `lib/transcript.js` deliberately unchanged — verified it already
has a per-engine adapter registry with honest `null` skips, which is the correct shape
for reading an engine's OWN files.

**Verification:** 4512/0. Mutation-checked — reverting the path default fails 5 tests,
reverting either prompt fix fails the guards. Against the live store, the real bundled
prompt renders per engine (`CLAUDE.md` / `.codex.yaml` / `.aider.conf.yml` /
`.antigravity.md` / generic); against the live fleet, all 13 projects with plans resolve
through the legacy fallback — nothing moved, nothing broke.

**Notable:** the pre-existing "no `{...}` tokens" drift guard fired. Its stated intent
was preventing tokens that pass through VERBATIM, not banning tokens — so it was
strengthened to assert membership in `SUPPORTED_PROMPT_TOKENS` rather than deleted. A
vacuity guard in the new suite caught its own bug: the template's steps live at
`wrap_pipeline` (snake_case), so the prompt scan was initially checking zero prompts.

**Classification:** build

## 2026-07-19: Chunk 01 — startup session-rule delivery + delivery ledger (#595)

<!-- prawduct: type=bugfix | scope=wrap-v2 | chunks=01 | status=shipped -->

**Why:** Phase B discovery found the channel the whole Wrap v2 design depends on was
severed. `kind='startup'` rules were assembled only inside `engines._getRulesContent`,
which runs during config-file generation — and `writeEngineConfig` returns early for
plugin-governed projects, so the tier delivered nothing on all 13 of them while still
accepting writes and rendering rows in the UI. Nothing recorded the miss, so a severed
channel was indistinguishable from "no rules configured". This is the hard prerequisite
for chunks 02-06.

**What:** delivery moved to the session prime — `sessions.buildStartupRulesSection`
renders a `## Project Rules` block that `generatePrimePrompt` includes, which runs
per-engine at launch and is not gated on config-file ownership. A **move, not an add**:
the `## Session Rules` block is removed from all four config generators and the engine
tests are inverted to fail if injection returns, so one tier keeps exactly one delivery
path. No coverage lost — every engine declaring `configFormat.filename` also declares
`supportsPrimePrompt`, and the only engine with neither (openclaw) got nothing before.
New `session_rule_deliveries` table (schema v26) records each attempt with engine,
channel, rule ids, a sha256 digest identifying the rule *set*, and a skip reason;
`GET /api/session-rules/deliveries` serves it per session, per project, or fleet-wide.

**Verification:** unit + integration tests including mutation checks (removing the
injection or the paste recording fails specific tests); and against a copy of the live
store — TangleClaw is plugin-governed, its config write still skips for exactly that
reason, and rule id 5 now reaches its prime.

**Critic:** 0 blocking, 10 warnings, 8 notes across 3 reviewers. Resolved: outcome
modelled as a three-state `outcome` enum (SoT) after two reviewers showed a `delivered`
boolean conflated "no rules" with "rules arrived" — the very conflation the ledger
exists to end; web-UI launch path now records its own row (found independently by all
three reviewers — the gap was silently reproduced in a second launch path); migration
no longer swallows a genuine CREATE failure; retention cap added; fleet-wide
`projectsWithUndeliveredRules` accessor added; launch-branch test coverage added;
`api-contracts.md` index entry added. Self-found before review and independently
confirmed by two reviewers: `listActiveForProject` ordered by a second-resolution
`created_at` with no `id` tiebreaker, leaving the digest order-unstable.

**Classification:** build

## 2026-07-18: Fix — Create Project centered modal (#623)

<!-- prawduct: type=bugfix | scope=ui-623 | status=shipped -->

**Why:** Operator report from their primary device: *"it puts all the menus at the
bottom of the screen at full width. I'd prefer a modal that pops up center, all options
showing or scrollable (maybe on a phone)."* Create Project was the landing page's last
bottom sheet — `.drawer`, pinned bottom, full-bleed, `max-height: 70vh`. Every other
dialog already used a centered `.modal-backdrop`/`.modal-content` capped at 90vh with
internal scroll, and that CSS even carries a comment recording that this exact
off-screen problem was diagnosed and fixed once for modals. So the fix was adoption,
not design.

**What:** markup moved to `.modal-backdrop > .modal-content.create-modal`
(`public/index.html`); new CSS block mirrors the `.settings-modal` flex pattern —
header + step dots `flex-shrink: 0`, `#createBody` scrolls (`flex: 1 1 auto`,
`min-height: 0`, `overflow-y: auto`); `openCreateModal`/`closeCreateModal` (renamed from `…Drawer` — see the Critic
paragraph below) toggle
`.open` on the backdrop only (the content's scale-in comes from
`.modal-backdrop.open .modal-content`); backdrop click guarded with
`e.target === e.currentTarget`. `.drawer`, `.drawer.open`, `.drawer-backdrop`, `.drawer-backdrop.open` and
`.drawer-handle` are DELETED from `style.css`.

**Two defects found while building, neither visible from the report:**
1. `.drawer-header` and `.steps-row` carry `padding: 0 16px` from the bottom-sheet era,
   where the drawer had no horizontal padding of its own. Inside a modal that owns
   20px, the header would have sat 16px inside the body's left edge. Neutralized.
2. Nesting the dialog inside the backdrop — which is what centers it — makes an
   unguarded backdrop click handler dismiss the modal on **every click inside the
   form**. Guarded, matching `killModal`/`deleteModal`.

**Self-caught error:** the first version of the CSS comment claimed the two-class
selector was needed because the base `.modal-content` rule "sits LATER in this file."
That rationale is true for `.settings-modal` (line 1066 vs base at 1790) and FALSE at
this block's insertion point (~1806, after the base) — copied without re-verifying
against position. The test asserting it failed, which is how it surfaced. Comment and
test both rewritten to state the real reason: order-independence, so the rule keeps
winning if the block is ever moved. Same phantom-citation class the
verify-citations-against-diff preference exists to catch.

**Critic (cumulative, 3-reviewer roster — 1 blocking / 3 warning / 4 notes):** BLOCKING was
`verify-chunk-refs` exiting 1 on an unrelated citation in the new Phase B plan — the hook
parses a backticked `file.js:310` as a literal path; reformatted to `` `file.js` (line 310) ``.
W-1 the reviewers DISAGREED on whether `style.css`'s `.drawer*` rules were dead: correctness
said yes, design said they were still shared with session.html. Resolved by checking —
`session.html` loads ONLY `session.css`, which carries its own `.drawer-backdrop`/`.drawer-handle`,
so correctness was right and MY change-log claim ("still used by session.html's drawers") was a
phantom citation. Five rules deleted. The two findings then collapsed into one better outcome:
`.drawer-header`/`.drawer-title`/`.drawer-body` had exactly ONE consumer left, so renaming them
to `.create-modal-*` DELETED the padding-neutralization override rather than documenting it, and
`openCreateDrawer`/`closeCreateDrawer`/`#createDrawer` became `…Modal`. W-2 the safe-area
`padding-bottom: max(20px, env(...))` was inert (a vertically-centered 90vh-capped modal cannot
reach the home indicator) and its comment cited landscape notches, which are left/right insets —
removed. W-3 `interaction-design.md` §2.5 still specified the bottom sheet while its own §5.2 rule
("focused input = modal") already predicted the new behavior — corrected. NOTE: one test was
tautological (derived its index from the string it then asserted) — rewritten to assert the real
property, that no bare `.create-modal {` selector exists. NOTE carried to backlog: the cache test
is monotone (`>= 54`) so it pins this bump but cannot catch the NEXT missed one — the failure that
has now recurred at #246, #271, #427 and here. Accessibility gaps (no Escape/focus-trap, closed
modals still tabbable) are app-wide `.modal-backdrop` properties, not introduced here.

**Cache:** `sw.js` CACHE_NAME bumped `tangleclaw-v3-53` → `v3-54`. Without it the
operator — the only person who reported the bug — keeps being served the old UI and the
fix is invisible. A test pins the floor at `>= 54`.

**Tests:** `test/create-project-modal.test.js` +15 source probes (markup nesting,
dialog semantics, viewport cap, flex-scroll split, padding neutralization, backdrop
guard, `.open` on backdrop only, no surviving grab handle, cache floor). Zero-dep
source-probe pattern per `paste-affordance.test.js` — the documented limit of having no
browser harness. Full suite exit 0, 2295 top-level / 0 fail (JUnit recorded as
evidence); 4455/0 counting subtests.

**Verification:** server restarted and serving the new markup + `v3-54`. Browser
rendering is deliberately NOT claimed — the operator is remote on iOS and
curl-on-localhost proves the server, never the view. Enqueued in
`operator-verification.md` with a 6-point check, weighted to the phone where the drawer
actually failed.


## 2026-07-18: Discovery — #595 rule delivery is severed, not merely unverified (wrap-v2)

<!-- prawduct: type=discovery | scope=wrap-v2 -->

**Why:** The operator ratified a standing design rule ("TangleClaw can't require what
won't work on all models — Claude-native means HINT only") and asked for it to be written
into session rules as self-learning. Writing it was easy; **verifying it arrived was
not** — and that verification is what produced this finding.

**What:** `kind='startup'` session rules are **structurally undeliverable on every
plugin-governed project**. Trace: `listActiveForProject` has exactly ONE consumer
(`lib/engines.js:310`, inside `generateConfig`); `generateConfig` has two call sites,
`validateParity()` (`:1009`, a helper) and `writeEngineConfig` (`:1322`); and
`writeEngineConfig` returns early at `:1312` for plugin-governed projects, before ever
reaching the injection. The early return is correct on its own terms (#330 — otherwise
launch/boot/PATCH would clobber the plugin's CLAUDE.md), but rule injection lives
downstream of it, so deferring config generation silently defers rule DELIVERY, which the
plugin neither knows about nor performs.

**Blast radius: 13 of 13 `governed-plugin` projects** — Monad-1, Notse, PV-AI-Guidebook,
RentalClaw-Project, ScrapeGoat, TangleBrain, TangleClaw, TangleWeb, TiLT Claw, TiLT v2,
UCI, Volta, WhitePapers. Live fleet inventory: 4 rules — 3 `kind='master'` (delivered via
`lib/master.js`, a separate path that works) and 1 `kind='startup'` (the rule created
here, undelivered). The project-rules tier has **zero working instances fleet-wide** and
failed on first real use.

**Why it matters:** the ratified Wrap v2 direction makes `session_rules` the
self-improvement channel ("wraps propose rule updates, applied at next launch"). That
channel is severed for exactly the 13 projects the campaign targets — so #595 is promoted
from "first-class requirement" to **hard prerequisite** and becomes Chunk 01 of the Phase
B plan. It also corrects a stale fact in the direction artifact: the 2026-07-17 read-path
audit recorded "`startup` rules inject correctly," which is false for governed projects
(the audit presumably checked a non-governed one). Corrected in place.

**Asymmetry made visible:** Chunk 06 wired `kind='wrap'` rules via
`ai-content._appendWrapRules`, which reads the DB at wrap time and DOES work. So `wrap`
is live while `startup` is dead — Chunk 01 unifies both on one mechanism with one
verification story.

**Also produced:** the Phase B build plan (`artifacts/wrap-v2-build-plan.md`, 6 chunks,
hosted mirror minted) and three operator ratifications — `open-pr-check` becomes a real
gate rather than the inert probe it is today; the engine-agnostic standing rule (session
rule id 5); and #595 gets discovery before planning. `active_build_plan` repointed from
the completed Phase A plan to the new one; Phase A stays in place as reference by
operator decision, deliberately not archived. Verified the repoint end-to-end by running
the priming-roll step: it now resolves `wrap-v2-build-plan.md` and reports Chunk 01 — the
fix shipped earlier today proving itself on the exact handoff it exists to protect.

⚠ **The standing rule is itself currently undelivered** — it is a `startup` rule on a
governed project, i.e. the very defect above. It is honored in-session by authorship
only, and will not reach the next session until Chunk 01 ships.


## 2026-07-18: Discovery — Phase B step inventory (wrap-v2)

<!-- prawduct: type=discovery | scope=wrap-v2 -->

**Why:** Phase A complete, so Phase B opens with the task its direction artifact
explicitly blocked on: "fate of each current wrap step — needs the real 12-step
inventory." Code-grounded read of all 12 handlers plus both bundled templates.

**What (findings; full detail in the untracked `.prawduct/artifacts/`
direction artifact, mirrored at the hosted review link):**

1. **The lean sort was wrong on 3 of 12 steps.** `changelog-update` is AI-CONTENT that
   BLOCKS the wrap, not a mechanical spine primitive — the mechanical changelog work
   (`[Unreleased]`→dated promotion, `status=merged`→`shipped` ledger stamps) actually
   lives inside `version-bump` (`version-bump.js:273-297`, `:315-330`).
   `next-session-prime` is mechanical, not AI-content. `open-pr-check` is an inert
   read-only probe that validates `options.prHandling` resolutions it never applies
   (`pr-check.js:210-253`). Corrected spine/checklist sort recorded.
2. **Three orphan handlers, ~970 lines:** `lint.js`, `test.js`, `critic-check.js` are
   wired into `STEP_DISPATCH` (`wrap-pipeline.js:40-54`) with bespoke runner support
   (`lint`'s `blocker:"errors-only"`, `options.skipTests`) but referenced by NO
   template. The shipped "Run Critic" action promises a `critic-check` step that never
   runs — root cause of #570's stale promise.
3. **`promptTemplates` confirmed dead** — #612's claim verified rather than assumed: no
   reader in `lib/`/`server.js`/`public/`; `wrap-pipeline.js:156-162` consumes only
   `.steps`; not in `store.js`'s `FRAMEWORK_OWNED_PATHS`.
4. **The `wrap_contract` layer has never fired** — `continuity-write.js:390-397` falls
   back to `template.wrap_contract.sections`, which neither template defines.
5. **`minimal` is effectively commit-only** — both its ai-content steps ship
   `prompt: ""` and self-skip; its `memory-update` declares `captureFields` with no
   `captureFile` (latent validation bug masked by the empty-prompt guard).
6. **Engine coupling is wider than #612 as filed:** `priming-roll.js:73-74` hardcodes
   `.claude/plans` and `.claude/priming/build-session.md` as RUNTIME path defaults, so a
   non-Claude project silently resolves no plan — a worse failure than the
   visibly-wrong prompt text #612 covers. Ranked 6-item remediation surface recorded.

**Confirmed (no change):** the verify-after-agent split already exists in code — spine
steps stage into `context.staged[]`, `commit.js:103-121` is the sole flush point, and
ai-content steps let the agent write directly and ride `git add -A`. Wrap v2 formalizes
an existing seam. The "equalizer" lean also holds: every mechanical handler runs
server-side with no engine branch.

**Open for the operator:** `open-pr-check`'s fate (real gate vs delete); the three
orphan handlers (revive opt-in vs delete — `critic-check.js` at 598 lines is the real
call); whether to widen #612 to cover the priming-roll path coupling or file a sibling;
and #595 (verified rule delivery) still has no design — it is named a first-class Phase
B requirement and needs its own discovery slice before the self-improvement loop can be
planned.

**Note:** `.prawduct/artifacts/` is gitignored fail-closed (`.gitignore:10`, only
`change-log.md` tracked), so this entry is the git-visible record; the artifact itself
lives locally + at the hosted link.


## 2026-07-18: Fix — priming-roll resolved the wrong plan and misread done-state (#620)

<!-- prawduct: type=bugfix | scope=wrap-620 | status=shipped -->

**Why:** The `next-session-prime` wrap step reported **Done** while priming the next
session onto unrelated, stale work. Found by auditing the 2026-07-18 wrap (PR #619,
`10a355e`), which closed Phase A Chunk 08 of the prawduct-v2-sunset plan and then wrote
`**Active:** Chunk 01 — — One-way auto-inject` pointing at
`.claude/plans/switchboard-v2-autoinject-loop.md`. Three defects, one family — TC's
plan machinery encodes conventions that plugin-governed plans do not use:

1. **Wrong plan.** `_resolvePlanPath` knew only `.claude/plans/`. A governed project
   keeps its plan under `.prawduct/artifacts/` and names it via column-0
   `active_build_plan:` in `.prawduct/project-state.yaml`. With one unrelated `.md`
   in `.claude/plans/`, the "only file in the dir" rule matched and the step declared
   success. Reproduces on every plugin-governed project — now the fleet default.
2. **Wrong chunk.** Done-state was read only from `✅` on `### Chunk NN:` headings.
   Governed plans declare their `## Status` checkbox roster the cross-session tracker
   (this plan says so in its own header comment) and leave the heading anchors — which
   exist for `verify-chunk-refs` — un-ticked. So a plan with all 8 chunks `[x]` parsed
   as zero-done and pointed at chunk 01.
3. **Doubled separator.** The title strip handled `:` but not the em-dash form the
   plan uses, rendering `Chunk 01 — — Title`.

**What:** `_readGovernedPlan` reads the column-0 pointer (line regex, not a YAML dep;
indented keys deliberately ignored to match the framework's own reader) and slots into
the precedence ladder BELOW `step.planPath` and the operator's `activePlan` pick, so
neither is overridden — the multi-plan picker (#428) persists to `activePlan` and must
keep winning. A declared-but-missing pointer SKIPS with a reason rather than falling
through to the heuristic, since falling through is precisely what manufactured the
confidently-wrong pointer. `_parseRoster` reads the `## Status` section (scoped
heading → next `##`, so stray prose checkboxes can't mark chunks done); done-state is
the UNION of roster tick and heading `✅` — both are affirmative markers, and letting
an un-ticked source veto a ticked one would resurrect shipped chunks. A roster-only
plan (the compact format this plan shipped with before anchors were added) supplies
the chunk list itself. `TITLE_SEPARATOR_RE` covers em/en dash and hyphen.

**Tests:** `test/wrap-step-priming-roll.test.js` +34 (48→82 in-file): #620 repro,
precedence-preservation for both operator hatches, dangling-pointer skip, traversal
block, column-0 contract, roster union/scoping/roster-only, separator forms, and the
Critic-caught edges below. Revert-verified — 13 fail against the pre-fix module, 0
after. Also fixed a pre-existing harness leak: the handler suite installed a throwing
`readFileSync` stub on the shared `_internal` singleton and never restored it, so any
suite declared after it captured the poisoned fn as its "originals" (it silently
corrupted the new governed suite on its first run). Full suite exit 0 — 2291 top-level
cases / 0 fail per the JUnit report ingested as test evidence; 4440 / 0 counting
subtests.

**Critic (cumulative `rev-20260719T022842Z-ea9618af`, 1 blocking / 3 warning / 2 note):**
BLOCKING — asserted suite results with no recorded evidence at this tree (verbatim
recurrence of learning WRP-9F2K); resolved by ingesting a JUnit report rather than
hand-typed counts. W-1 future-dated entry (UTC had rolled, local had not) — corrected.
W-2 the roster↔heading join keyed on the raw id string, so a plan writing `- [x] Chunk 1`
against `### Chunk 01:` would miss the lookup and park the pointer on chunk 01 — the very
failure this fix exists to kill; `_chunkIdKey` now normalizes leading zeros per dotted
segment, with the raw id preserved for display. W-3 doc drift at 3 sites still calling
`### Chunk N:` headings the only chunk source, including an operator-facing skip reason
that misdirected roster-only authors — all reworded. N-1 a `.prawduct/`-prefixed pointer
value double-prefixed and silently skipped — both spellings now honoured.

**Verified:** ran the step against this repo — resolves
`.prawduct/artifacts/prawduct-v2-sunset-build-plan.md`, `allDone: true`, renders
"All chunks … are marked done." Matches reality (Phase A complete). The stale priming
block left by the bad wrap was corrected in the same commit.


## 2026-07-18: Feature — Master settings surface v1 (Chunk 07)

<!-- prawduct: type=feature | chunks=07 | scope=prawduct-v2-sunset | status=shipped -->

**Why:** Phase A Chunk 07 (spec ratified in-session 2026-07-18, both assumptions accepted) —
the Project Master had a hardcoded prose-only read-only boundary, no settings surface, and
no continuity; the D1b version-history machinery lost its only UI when Chunk 06 deleted the
global panel.
**What:** (1) `master` settings object in global config (accessLevel/engine/scope/autoStart)
via `PATCH /api/config` merge-then-validate; suggest/write tiers rejected until each ships
real enforcement. (2) Hard rules → `kind='master'` `session_rules` rows (projectId
forbidden — singleton exception), seeded from `MASTER_BASELINE_RULES`, fail-safe baseline
render at zero enabled rules, `POST /api/master/rules/restore-defaults`, eyes-open
`CONFIRM_REQUIRED` gate on weakening system rows (PUT/DELETE/restore — restore gate added
after Critic R-2 caught the asymmetry). (3) Structural enforcement on claude: per-ensure
`.claude/settings.json` (allow writes only under `memory/`) + default-deny PreToolUse
guard hook, behaviorally tested. (4) Master memory scaffold `~/.tangleclaw/master/memory/`
(TC-refreshed FLEET/HOWTO; master-owned MEMORY/CHANGELOG/NOTES). (5) Gear → Master
Settings modal with rules editor + per-rule version history/restore. Boot auto-start
try/catch-wrapped. Suite 2266/0 top-level (+~50 tests incl. guard-script execution).
Critic cumulative 0/6/7 → fixes → verify-resolutions 5/6 resolved (R-5 residue = backlog
SR-6D3W; cosmetic gate ordering = SR-4N6C). PR reviewer next per create flow.

## 2026-07-18: Feature — settings/rules cleanup + wrap-rules bridge + launch-mode default (Chunk 06)

<!-- prawduct: type=feature | chunks=06 | scope=prawduct-v2-sunset | status=shipped -->

**Why:** Phase A Chunk 06 (ratified 2026-07-17, retask amended same day) — the read-path
audit found `mode` rules had no runtime, the global session-rules tier had zero rows and a
hidden UI, and `wrap` rules were stored with no consumer; the Mode-rules slot was retasked
into structured per-project launch-mode settings.
**What:** (1) `mode` kind deleted (`SESSION_RULE_KINDS=['startup','wrap']`) and the global
tier retired — `sessionRules.create` requires `projectId`, `?scope=global` removed,
injection/conflict queries drop the `project_id IS NULL` arm, `promoteFromLearning`
defaults to the learning's project, landing-page global panel + its version-history UI
deleted (store/API versions machinery retained for Chunk 07's master-scoped rules),
migration v25 defensively purges both retired tiers (zero rows expected; history kept).
(2) Launch-mode settings: `defaultLaunchMode` (engine mode key, default `'default'`) +
`showLaunchModePicker` (default true) in `DEFAULT_PROJECT_CONFIG`, PATCH-validated against
the intended engine's `launchModes`, enriched to the frontend, resolved server-side in
`launchSession` (explicit choice wins; stale keys ignored); eyes-open guard — hidden
picker + warning-carrying default requires `confirmBypassHidden: true`, enforced in
`updateProject` and fronted by a confirm modal; landing Launch skips the picker when
hidden. Guard keys on the mode's `warning` flag, not a hardcoded name, so it covers
codex `fullAuto` / aider `yesAlways` too. (3) Wrap-rules bridge:
`ai-content._appendWrapRules` appends enabled `kind='wrap'` rules to every non-empty
ai-content prompt (tmux + gateway paths); store failure degrades to the bare prompt.
(4) Copy pass: dash-bar tier reads "Global Rules"; Project Rules modal down to two kind
boxes with the wrap hint reflecting real injection.
**Deliberate residue:** rule version-history UI is temporarily unreachable (its only
surface was the deleted global panel; rows in the tier were zero, so nothing observable
is lost) — the Master settings surface (Chunk 07) owns the successor UI. Launch Mode
modal untouched (facelift + preselect-from-default = GH #596). `session_rules.project_id`
stays nullable in the schema pending Chunk 07's master-scoped rows.
**Verification:** full suite green (was 4339, now 4353 — 4352 pass / 1 skip / 0 fail —
after retirement-pin consolidation + new coverage incl. the Critic-fix round); live
product verification on the restarted server (branch tree 5c5e847, `isStale:false`):
enrichment exposes both fields, engine-key validation 400s, the eyes-open guard 400s
with its remediation message and persists nothing, `POST /api/session-rules` without
projectId 400s with the retirement message, served index.html/ui.js carry the confirm
modal + renderer, sw.js serves cache gen v3-52. Frontend visuals (settings-modal launch
section, confirm modal, hidden-picker launch) await operator eyeballs — server-side
behavior verified via API. New real-old-schema v24→v25 purge
migration test; new
`test/launch-mode-settings.test.js` (16 tests: validation, guard combinations incl.
single-field-completes-the-combo and stored-combo-never-re-blocks, launch resolution
via mocked tmux, frontend pins); wrap-rules bridge tests in
`test/wrap-step-ai-content.test.js` (tmux send carries the block; empty prompt still
skips). sw.js cache generation bumped (v3-52).

## 2026-07-18: Chore — legacy V1 NL-prompt wrap path stripped (Chunk 05)

<!-- prawduct: type=chore | chunks=05 | scope=prawduct-v2-sunset | status=shipped -->

**Why:** Phase A Chunk 05 / backlog WRP-2Q6H — the legacy NL-prompt-via-tmux wrap survived
many release cycles past the #196 default-flip's documented one-cycle grace window.
**What:** `triggerWrap` reduced to project/session checks + the pipeline runner (gate, NL-prompt
branch, and webui dead-end error deleted); `DEFAULT_PROJECT_CONFIG.wrapV2` removed (stale
on-disk keys ignored; litellm-smoketest's live `false` opt-out removed as a data op — its
`minimal` methodology has a full `wrap_pipeline`, so nothing needed the legacy path);
wrap-pipeline error message no longer advises the deleted opt-out; stale comments updated
(`_triggerWrapV2` header, `public/session.js` confirmWrap, api-wrap-status test); ADR 0002
status line records the excision. **Scoping correction:** the backlog item's
"strip the `lib/skills.js` shim" sub-goal was based on a stale premise (and a phantom
`synthesizeLegacyWrap` name) — `getWrapSkill`/`wrapShapeFromTemplate` are still live consumers'
dependencies (pipeline response shaping, `autoCompleteWrap`, `loadSkills`, `eval-audit`), and
the bundled templates still carry legacy `wrap` blocks; their retirement belongs to the
methodology-layer removal (Phase B), not here. **Test consolidation (named per the
tests-never-weaken rule):** the legacy-behavior pins asserted a deleted code path — byte-equal
NL prompt (×2 incl. the minimal-methodology variant), wrapping-status transition,
#101 prompt-hygiene pins, and the webui-legacy error test are replaced by retirement pins
(explicit false / absent / fresh-project / webui-stale-false all route to the pipeline;
DEFAULT_PROJECT_CONFIG must not re-seed the key; #101 version-cache write re-pinned on the
pipeline path); inert `wrapV2` fixture writes swept from sessions/api-sessions/store suites.
Suite 4338/0/1 (net −9 tests from the consolidation), JUnit evidence recorded.
**Deliberate residue:** `store.sessions.setWrapping` lost its last production caller (the
legacy branch was it), but the surrounding wrapping-status machinery (`completeWrap`,
`autoCompleteWrap`, `POST /wrap/complete`, the #91 wrap-state persistence) stays LIVE — the
frontend's manual-complete flow posts to it and `completeWrap` also serves active sessions.
Not stripped here: the wrap-flow redesign (Wrap v2, Phase B) replaces this layer wholesale.

## 2026-07-18: Chore — fleet remnant sweep: vendored V1 product-hook eradicated (Chunk 04)

<!-- prawduct: type=chore | chunks=04 | scope=prawduct-v2-sunset | status=shipped -->

**Why:** Phase A Chunk 04 — the 2026-07-14 plugin rollup left the V1 file-sync install's
vendored artifacts behind across the fleet. **Pre-build verification corrected the spec:**
`tools/product-hook` is a single ~178KB bundled executable (not a tree; 4 repos also carried
the vendored `tools/lib/` python hook lib); the real inventory was 12 live carriers + TiLT v2's
stranded outer dir (not "9 repos"); the codextest settings claim was STALE (already clean —
only the TC prime hook remains); and **CLITS** (unregistered repo) was a missed live carrier
with active product-hook SessionStart/Stop wiring. **Decisions (operator):** write-mode =
TC-direct sweep + scoped per-repo commits + push where clean; prawduct-test = full retirement.
**What:** (1) Hook artifacts deleted in all 13 carriers — 9 scoped carrier commits (WhitePapers,
Medusa+lib, TangleWeb+lib, JasonVaughanComPortfolio, Notse, RentalClaw-Project+lib, UCI, CLITS,
TangleClaw-migrate-sandbox+lib) plus Kobold's separate orphan-CLAUDE.md commit (item 3) = 10
commits total; 3 untracked-only carriers needed no commit (ScrapeGoat,
ClawCode-x, codextest); pushed where the branch had no unrelated commits ahead (Medusa,
TangleWeb, JasonVaughanComPortfolio); settings de-wired in the same commit as the hook delete
(CLITS + sandbox settings.json were 100% V1-generated → removed whole; sandbox's also pointed
its prime hook at the dead `TangleClaw-v3` path). (2) TiLT v2 stranded outer dir: `.claude/`
(V1 skills tree + settings pair) and `tools/` deleted (non-git). (3) Orphan engine configs from
the Chunk 03 boundary: `Kobold/CLAUDE.md` (git rm + commit), `codextest/CLAUDE.md` (untracked rm).
(4) prawduct-test RETIRED: no git remote, so archived by move to
`~/Backups/prawduct-test-archive-2026-07-18` + deregistered via `DELETE /api/projects` (rows
gone, files kept). (5) Two backups deliberately untouched (`TangleClaw-v3-backup-pre-bfg`,
`~/Backups/TangleClaw-v3-2026-03-16`). **Verified:** `find` over Projects shows product-hook
only in the untouched backup; fleet-wide settings grep clean; TC's own
`GET /api/projects/stranded-configs-scan` (the Chunk 02 guard) returns `stranded: []` — the
TiLT v2 straggler it found is resolved. **TC repo diff is bookkeeping only** (plan, change-log,
CHANGELOG) — no product code changed; the chunk's substance lives in the foreign-repo commits
listed above.

## 2026-07-18: Feat — TiLT template retired + fleet downgrades to minimal (Chunk 03)

<!-- prawduct: type=feat | chunks=03 | scope=prawduct-v2-sunset | status=shipped -->

**Why:** Phase A Chunk 03 — operator-ratified 2026-07-17: tilt carries no distinct value over `minimal`, and non-Claude governance = minimal + session rules. **What:** (1) **Fleet data ops** — 6 projects flipped to `minimal` via live `PATCH /api/projects/:name` (tilt: Kobold, OnDeck-V2; non-Claude prawduct: JasonVaughanComPortfolio, Medusa, ClawCode-x, codextest), each archiving its old state dir (`.tilt.archived` / `.prawduct.archived`); configs regenerated at restart and verified clean per-file. (2) **Template retirement** — bundled `data/templates/tilt/` deleted PLUS a `RETIRED_TEMPLATE_IDS` tombstone pass in `lib/store.js#_copyBundledTemplates` (mirrors `RETIRED_ENGINE_IDS` #457/#458): deleting only the seed would have left every existing install serving tilt from its synced runtime copy forever. Live-verified: boot removed `~/.tangleclaw/templates/tilt/`, API lists 2 templates + 404s on tilt. (3) **Retirement pins** replace the tilt-assumes-bundled tests (API exclusion + 404, `.tilt` no longer detects, migration scan no longer reads `.tilt` as a project marker, boot tombstone removes a pre-existing runtime copy); tilt-as-fixture tests consolidated onto prawduct/minimal — the exercised behavior (init/switch/no-overwrite) is template-generic. (4) **Live-verify catch → engine-resolution fix**: codextest's operative `.codex.yaml` never regenerated — boot-sync resolved engine via `projConfig.engine || project.engine || 'claude'` where `project.engine` is a dead field (rows expose `engineId`); fixed DB-first (the #320 methodology precedent; matches sessions.js). The Critic's cumulative pass then caught the same fallback in `engines.js#syncEngineHooks` — completed via new `store.projects.getByPath` + `engineIdOverride` for the two fresher-than-DB callers (engine PATCH pre-batched-write, create pre-row). All three fixes revert-verified. **Docs:** CHANGELOG (`### Changed` + `### Fixed`), FEATURES.md tombstone entry, eval-audit TiLT section removed. **Deferred:** `identitySentry` rule-vocabulary removal → Chunk 06; Kobold/codextest orphan `CLAUDE.md`s → Chunk 04 (recorded in plan). **Critic:** cumulative (1 blocking — plan ref to the deleted path, mechanical; 3 warnings — stale CHANGELOG claim ×2, syncEngineHooks invariant gap) → fixes → verify-resolutions **0/0/0**, 4 resolution facts. Notes stood: tombstone-helper extraction deferred until a third retirement class exists; tilt DB-remnant remap unneeded (fleet flipped via data ops). **Tests:** suite 4348/0/1 (JUnit evidence at HEAD).

## 2026-07-17: Feat — stranded-config guard: detect governance files in unregistered ancestor dirs (#592, Chunk 02)

<!-- prawduct: type=feat | chunks=02 | scope=prawduct-v2-sunset | status=shipped -->

**Why:** Phase A Chunk 02. Root cause (revised from the issue's "likely cause"): the parent-dir CLAUDE.md wasn't from a path *edit* — `updateProject` never accepts `path`. The fossil record (`TiLT v2/.tangleclaw/project.json.archived`: engine=claude, methodology=minimal) shows the parent WAS its own registered project, later archived/deleted, with a new project created at the nested repo; `archiveProject` flips a DB flag and `deleteProject` without `deleteFiles` keeps everything, so the old root's generated configs survived unowned, and Claude Code's ancestor-CLAUDE.md walk re-injected the V1 playbook (#536 hazard). The orphan CLAUDE.md was already deleted locally (per #592's Ask) before this chunk ran; ad-hoc fleet sweep of 52 projects found no other ancestor CLAUDE.md. Guard built: `_findStrandedAncestorConfigs` (pure walk, projects-root-bounded, registered-roots-exempt incl. archived) + `scanForStrandedConfigs()` (read-only, deduped) + boot WARN after startup sync + `GET /api/projects/stranded-configs-scan`. NO auto-repair by design — stranded files can hold hand-written content (detection-not-destruction, the #595 drift-detection bar). Live-fleet validation caught the real remaining straggler the CLAUDE.md-only sweep missed: `TiLT v2/.claude/settings.json` (V1 product-hook hooks + skills tree) — disposition queued for Chunk 04's remnant sweep. Also this branch: re-homed the #584 CHANGELOG entry that #598's squash 3-way misfiled under the concurrently-cut `[4.20.1]` heading (released without the fix). Tests: 15 new (helper matrix, incident-topology regression, dedup, config-failure error branch, API read-only + route-shadowing pins). Suite green via JUnit evidence (2234/0).

**Classification:** build

## 2026-07-17: Fix — recordVersion silent failure under server load order (#584, Chunk 01)

<!-- prawduct: type=fix | chunks=01 | scope=prawduct-v2-sunset | status=shipped -->

**Why:** Phase A Chunk 01 — the campaign's active-silent-corruption item. `lib/project-version.js` top-level-required `./projects` from inside the `projects → sessions → project-version → projects` require cycle; entered via `projects.js` (the server's load order), it captured projects' *partial* exports, so `detectVersion` threw `projects._readChangelogVersion is not a function` into `recordVersion`'s warn-and-bail catch — every session launch and wrap, fleet-wide, since the feature landed (#101/#117 shipped both cycle edges in one commit — born broken; unit tests loaded `project-version` first, the order that always worked). Fix: lazy require at call time inside `detectVersion` (the `lib/wrap-steps/index-describe.js`/`project-map.js` pattern). Sibling audit: that was the LAST top-level capture of `./projects` inside the cycle. Regression: `test/project-version-require-cycle.test.js` loads `projects.js` first in its own process and pins `detectVersion` + the cache write — revert-verified (2 fail on old code). Full suite 4330/4329 pass, 0 fail. Critic (verify-resolutions over cumulative → HEAD): 0 blocking / 1 warning (this missing change-log entry — resolved by this entry) / 2 notes. Same session: root-caused + fixed the briefing blindness that hid this campaign (nested `active_build_plan` pointer vs the plugin's column-0 YAML reader; V1-legacy `build_plan:` block stripped from project-state.yaml — local state, no commit).

**Classification:** bugfix

## 2026-07-17: Fix — auth chip false-positive on direct-loopback loads: proxy-evidence split (AUTH-5N2J)

<!-- prawduct: type=fix | chunks=01 | scope=auth-5n2j | status=shipped -->

**Why:** Janitor-filed AUTH-5N2J (surfaced during the AUTH-2K9D VRF): in caddy mode, any direct-loopback dashboard load (`localhost:3102` bypassing caddy) ambered the `configured-no-identity` chip against a healthy gate — the AUTH-2K9D design assumed all browser traffic traverses Caddy, which holds remotely but not locally (the 127.0.0.1 bind accepts direct connections). **Discovery (stage was `idea`):** root cause is that Caddy proxies from loopback too, so remote address can't discriminate; the decided contract is proxy evidence — Caddy's `reverse_proxy` sets `X-Forwarded-For` unconditionally (verified against the live hand-edited Caddyfile: every block proxies), a direct client sends none. Decision recorded as an amendment in `docs/auth-status-surfacing.md`. **What:** `resolveAuthStatus` (`lib/auth-identity.js`) splits the no-identity branch: `x-forwarded-for` present → `configured-no-identity` (real AUTH-3 warning preserved); absent → new `configured-bypassed` status, which the chip deliberately renders as nothing (`_authStatusWarning` unchanged — unknown states already map to null; JSDoc documents the silence as intentional). `PROXY_EVIDENCE_HEADER` exported; enum extended. **Spoof wall:** the header classifies the diagnostic only — `resolveRequestUser`'s config-gated trust is untouched; spoofed XFF at worst shows the spoofer an amber chip (pinned by test). **Tests:** unit bypass regression (incl. empty/whitespace/array XFF edges), live-socket API regression (the exact former false-positive request shape now reports `configured-bypassed`), proxied-no-identity coverage, spoof-direction pins, and a frontend structural pin that exactly two states warn.

## 2026-07-17: Chore — FEATURES.md symbol-anchor convention + stub fold-in + citation contract test (DOC-3K7Q)

<!-- prawduct: type=chore | chunks=01 | scope=doc-3k7q | status=shipped -->

**Why:** FEATURES.md `:line` pointers were stale by hundreds of lines (janitor DOC-3K7Q: `GET /api/projects` cited `server.js:855`, actually ~`:1333`; discovery confirmed worse — `enrichProject` `:559` → `:848`) and ~50 TBD auto-stubs across 13 TODO sections (5 duplicate same-day headings) buried the curated index; the file also listed only 1 of 3 shipped methodology templates. **Discovery correction:** the janitor blamed the features-toc wrap step for refreshing-but-not-verifying line numbers — reading `lib/wrap-steps/features-toc.js` disproved that (the step only appends path stubs, no line refs); the rot source was the format convention prescribed by the file header and `FEATURE_INDEX_TEMPLATE`. **What:** FEATURES.md fully rewritten to `file.js#symbolName` / route-string anchors (all curated prose preserved; every anchor mechanically verified before writing); TODO stubs folded — real features promoted into curated sections, test stubs consolidated into a `## Tests` map; minimal + tilt template entries added; `FEATURE_INDEX_TEMPLATE` format comment in `lib/projects.js` now prescribes the anchor convention with an explicit "NO :line pointers" rule. **Enforcement:** new `test/features-index.test.js` — 5 contract pins (no `:line` pointers; every cited committed-repo path exists; every `path#symbol` anchor greps in its file; auto-stub sections fold within 14 days — fresh wrap stubs pass so the required CI check stays green on normal wrap commits; template prescribes the convention). Scoped to committed roots (`lib`,`public`,`test`,`data`,`deploy`,`scripts`,`docs`,`.github`) so gitignored local paths (`.prawduct/`, `.tangleclaw/`) can't fail CI's fresh checkout. Revert-verified: probe entry with fake path + `:42` pointer fails exactly 3 pins. The contract test caught 3 of the rewrite's own citations before commit (2 illustrative fake paths, 1 extension-less path) — working as intended. **Walls:** features-toc step logic untouched (its stub format was already line-free); PROJECT-MAP.md untouched. **Critic reconciliation (same PR):** the review caught that an outright no-stub-sections pin would conflict with the wrap step's legitimate append (11 files were one wrap away from stubbing, including the contract test itself) — the pin now tolerates fresh stub sections and fails only those older than 14 days, the header documents the fold-promptly workflow, and the 11 drifted files were indexed so the next wrap stubs nothing.

## 2026-07-17: Feat — GitHub Actions CI runs the full test suite on PRs and push-to-main (CI-9F3T)

<!-- prawduct: type=feat | chunks=01 | scope=ci-9f3t | status=shipped -->

**Why:** The repo had no CI — `.github/` held only issue templates, so nothing ran the ~4300-test suite on push or PR and "tests pass" rested entirely on session discipline (the exact gap the 2026-07-16 Critic warning surfaced: stale test evidence at HEAD, invisible until review). Public repo, so the absence was also a visible hygiene gap. **What:** `.github/workflows/test.yml` — `Tests` workflow: checkout@v4, setup-node@v4 pinned to Node 22 (`node:sqlite` floor; matches the production launchd runtime), running the README-canonical `node --test 'test/*.test.js'` verbatim on ubuntu-latest; triggers `pull_request` (gating) + `push: branches: [main]` (badge truth). README gains the live status badge. Headless-safety verified before enabling, not assumed: all platform-coupled tests (launchctl/tmux/darwin) mock via argv-plans or injected platform, the single real `tmux kill-session` is a try/catch'd cleanup, and git-using tests init temp repos with their own `user.email`/`user.name` (runners ship no global identity). **Deliberate walls:** required-check branch protection is a follow-up after the first green main run (it changes `gh pr merge --auto` semantics — operator-visible); DEP-8H7W's `--disable-warning=ExperimentalWarning` stays that item's scope (CI uses the canonical invocation verbatim so command drift is impossible by construction). **Tests:** `test/ci-workflow.test.js` source pins — canonical command cross-checked against README (both must move together), PR + push-to-main triggers, Node 22 pin, badge presence. Revert-verified: mutating triggers/Node fails exactly the 2 relevant pins. Full suite green at HEAD (4320 tests / 0 fail — node:test spec totals including subtests; canonical evidence records the 2209 top-level tests). **First-run findings (fixed in the same PR):** the runner immediately caught two fresh-clone bugs the dev box masked — `data/templates/tilt/template.json` was gitignored as "unreleased" while the tests, `GET /api/methodologies`, and the chooser all treat tilt as bundled (template committed, content verified generic, operator-approved), and a `test/git.test.js` fixture ran `git commit` with no local identity (fails wherever git has no global user). Checkout/setup-node actions bumped v4→v7 after the first green run logged GitHub's Node-20 deprecation warning.

## 2026-07-17: Feat — version-bump wrap step stamps prawduct change-log entries shipped at release-promote (WRP-9F2K)

<!-- prawduct: type=feat | chunks=WRP-9F2K | scope=wrp-9f2k | status=shipped -->

**Why:** The merged→shipped flip in this file was a manual release-checklist convention; forgetting it let 29 entries rot at `status=merged` across ~15 releases (found + back-stamped under ART-4K9M, 2026-07-17). `regen-views` derives build-plan `## Status` checkboxes from `status=shipped` only, so the rot silently un-ticked genuinely shipped chunks and spammed phantom release-pending warnings. The CHANGELOG `[Unreleased]` promote and this file's status flip change state at the same moment for the same reason — so the version-bump wrap step should do both. **What:** `lib/wrap-steps/version-bump.js` — new pure `_flipMergedTagLines(text)` (flips `status=merged` → `status=shipped` on prawduct comment tag lines ONLY — written out here without the literal comment syntax because this very parser would read an inline sample as a second tag line; body prose mentioning the token is untouched; statusless tag lines counted, never flipped — a missing `status=` is prawduct's missed-merge-stamp diagnostic and inventing a status would bury it) + `_stagePrawductChangeLogStamp(projectPath, staged)` (reads `<project>/.prawduct/change-log.md`, stages `staged['version-bump:prawduct-change-log']` when flips exist — single-transaction discipline preserved: the handler never writes, the commit step's `_flushStagedWrites` duck-types the third entry and flushes all three together). Wired after the drift guard so the stamp runs ONLY when a promote is actually staged (no release → no stamp; empty-[Unreleased] skip path can't stamp). Output: `changeLog: {flipped, statusless}` + a `detail` suffix ("stamped N change-log entries shipped"); a read/flip failure degrades to `changeLogWarning` + `log.warn` (broad catch carries a `prawduct:allow prawduct/broad-except` waiver — the step's ADR-0002 never-blocks contract) and never fails the step. Deliberately does NOT run prawduct's `regen-views` (prawduct's tool, not TC's; next regen picks the flips up). `lib/wrap-steps/commit.js` `_buildBodyLines` gains a `changeLogFlipped` branch ("Stamped N prawduct change-log entries status=shipped") — the marker field carries no version keys so it can't collide with the Bumped-line dedup, and the docstring's staged-shapes table documents the third entry. **Convention note:** scope is `wrp-9f2k` (own scope, per the post-plan-fix rule ratified in this file's header under ART-4K9M). **Tests:** `test/wrap-pipeline.test.js` new WRP-9F2K describe (10 tests): pure flip matrix (merged flips / shipped + prose untouched / statusless preserved / no-tag byte-identity), handler staging with counts + detail, no-`.prawduct` no-op, all-shipped no-stage (no no-op write), the no-promote gate (merged entries present but empty `[Unreleased]` → nothing stamped), read-failure degradation (`changeLogWarning`, step still `done`), flush round-trip (3 files land on disk, stamp included), commit-body line + Bumped-dedup non-collision. **Revert-verified:** neutering `_stagePrawductChangeLogStamp` fails exactly the 4 feature-dependent pins and nothing else. Full suite green at HEAD.

## 2026-07-16: Fix — wrap re-fire root-caused: server-side single-flight + reattachable wrap runs + restart guard (#583)

<!-- prawduct: type=fix | chunks=583 | scope=wrap-583 | status=shipped -->

**Why:** The 2026-07-16 incident behind the `wrapDisabled` kill switch. The issue shipped with hypotheses and an explicit diagnose-before-patching warning; log forensics (server log + caddy access log) **disproved all of them** — no auto-retry loop exists. Real chain: wrap POST #1 (05:52 UTC) ran its content steps once each until the operator's own `POST /api/server/restart` (05:55:39, from a second surface) killed the server mid-`memory-update` — caddy 502'd the wrap POST, and the AI finished writing `.wrap-summary.md` into a dead pipeline (why it was never consumed). The operator, told "Wrap failed", re-POSTed (06:00:24) — attempt 2 re-fired `changelog-update` from step 0 (the observed "fresh cycle"), then its OWN connection aborted 11s in (caddy status 0) and the pipeline kept running as a **zombie** until the hot-fix deploy restart killed it. Root defects: (1) no server-side single-flight — client guards (#519) can't span tabs/devices/reloads; (2) the wrap lived and died with one HTTP connection — invisible after any connection loss, which *invites* the re-POST; (3) restarts fire blind through a mid-flight wrap. **What:** `lib/wrap-run-registry.js` (new; process-local BY DESIGN — post-restart emptiness is the truth) gates one running pipeline per project with 30-min stale takeover; `_triggerWrapV2` claims/finishes it and threads a new `runWrapPipeline` `options.onStepStart` hook (throw-isolated — progress can never alter pipeline outcome) into `updateStep`; `POST /wrap` answers **409 `WRAP_IN_PROGRESS`** on a concurrent trigger; new `GET /api/sessions/:project/wrap/status` exposes `{running, currentStepId, finishedAt, result}` with `result` built by the same `_wrapResultPayload` the POST uses (can't drift); `POST /api/server/restart` refuses **409 `WRAP_RESTART_BLOCKED`** (guard precedes mechanism detection) unless `{force:true}`. Frontend: pure `wrapWatchDecision` (`public/wrap-drawer.js`) gates reattach on **result freshness** (`finishedAt >= postStartedAt` — a previous wrap's retained outcome must never render as this one's); `session.js` `watchWrapRun` probes on ANY failed wrap POST (uniform for 409/502/abort — no error-string matching), watches a running run under the existing wrapping bar (terminal visible = the wrap itself), renders the drawer from the retained result, reattaches on page load to running runs only, and reports a vanished run honestly ("killed by a server restart — nothing committed; safe to re-wrap"); `landing.js` routes BOTH restart flows (#235, #229) through `postServerRestart()` — confirm-then-`force:true`. CACHE_NAME v3-50→v3-51. **Deliberately out of scope:** resumable pipelines (retry still runs from step 0 — safe once only an explicit human can trigger it), cancelling on client abort (phone-first operator: a locked phone mid-wrap is normal, the pipeline finishing headless + reattach is the intended model), #185 SSE. **Incidental finding filed separately:** `projects._readChangelogVersion is not a function` on every wrap/launch — require-cycle casualty (`projects → sessions → project-version → projects` partial exports); `recordVersion` has been silently failing. **Tests:** registry matrix (lifecycle, concurrent-begin rejection, stale takeover at threshold, per-project isolation, zombie-finish no-op); THE incident pin — two concurrent `triggerWrap`s, exactly one pipeline, result retrievable after (`test/sessions.test.js`, + thrown-pipeline-frees-slot); HTTP 409/status/restart-guard (guard-precedes-exec proven via stubbed-null mechanism → 501) (`test/api-wrap-status.test.js`); `onStepStart` order + never-fires-for-pending + throwing-hook isolation (`test/wrap-pipeline.test.js`); `wrapWatchDecision` matrix incl. the stale-result pin (`test/wrap-drawer.test.js`); wiring pins for both session.js paths + init + landing helper (`test/wrap-run-reattach.test.js`). **Post-merge:** restart onto main, `PATCH /api/config {"wrapDisabled": false}`, live-VRF a wrap + a mid-wrap restart refusal.

## 2026-07-16: Fix — operator kill switch for session wrap (`wrapDisabled`) — incident hot-fix

<!-- prawduct: type=fix | chunks=wrap-kill-switch | scope=ops | status=shipped -->

**Why:** Live incident during this evening's wrap: the wrap pipeline's AI-content steps re-fired repeatedly into the session (the `changelog-update` prompt arrived at least twice for one wrap; operator observed "several wrap attempts just retry over and over") and the operator directed an immediate disable while other work proceeds. Root cause NOT diagnosed yet — the follow-up bug issue carries what's known. **What:** `POST /api/sessions/:project/wrap` now checks `store.config.load().wrapDisabled === true` FIRST (before even the password gate — disabled means disabled regardless of caller) and refuses with 503 `WRAP_DISABLED`, the message naming the flag and the re-enable call (`PATCH /api/config {"wrapDisabled": false}`). `wrapDisabled` added to the PATCH allowlist. No UI — the Wrap button surfaces the honest 503 error toast; this is a temporary operational switch, not a feature. Shipped **direct to main** under the incident-hot-fix branch exception; flag set live on cursatory + server restarted + 503 verified. **Tests:** refuses-while-set + names-the-flag, cleared-flag-restores-normal-handling (`test/api-system.test.js`, isolated temp store).

## 2026-07-16: Fix — interrupted Select can no longer permanently strand the tmux mouse override (UI-8W3D)

<!-- prawduct: type=fix | chunks=UI-8W3D | scope=ui-8w3d | status=shipped -->

**Why:** The abandonment window the #574 Critic flagged and #580 explicitly did not close: unset-on-exit runs only on a Done tap, so a reload/close mid-select fires no exit and the enter-set override strands — `mouse off` on desktop (killing touch-scroll for every later phone visit: the #574 failure mode, and very likely how RentalClaw-Project acquired its original stranded `off`), `mouse on` on mobile. Picked directly off the backlog (`stage: ready`, S effort) as the continuation of the #574→#579→#580 arc, at operator direction ("continue where we left off"). **What:** entering Select records the pre-select state (value + source) in a localStorage intent marker BEFORE flipping tmux — write-before-flip so a crash between the two leaves a harmless idempotent repair, never an unmarked strand; a clean Done exit clears it; a marker found at session-page init means a restore is owed → `repairAbandonedSelect` replays the exit through the SAME `tcSelectModeMouse` decision (unset when inherited — the #579/#580 `getMouseState.explicit` building block, exactly as the backlog item prescribed) and clears the marker only on a successful POST (server-down keeps it for the next load; init's plain GET is skipped when the repair's POST response already carried fresh state). Raw storage validated by pure `tcParseSelectMarker` — malformed/wrong-shaped/extraneous data returns null and never drives a tmux write. Timer-free; marker = SoT cleared on the mutation (the #566/TC#561 rule). **Accepted edge (documented in code + CHANGELOG):** two tabs on one session, one reloading while the other is mid-select → the reload repairs under the live tab; rare, strictly better than stranding forever, and detecting a live peer would need heartbeats (timers). CACHE_NAME v3-49→v3-50; the #402 SW pin loosened to a version FLOOR (≥49) in the same pass — exact-version pins break on every legitimate later bump, the brittleness TST-6L2P catalogs. **Tests** (`test/select-mode-mouse.test.js`): `tcParseSelectMarker` matrix (valid both directions; null/empty/non-JSON/string/array/wrong-types/missing-field rejection; extraneous-field stripping), write-BEFORE-flip ordering pin, clean-exit-clears pin, repair-through-tested-decision + parser + no-timers pins. **Honest limit:** the repair itself is browser-runtime behavior source-probed only (TST-6L2P scope limit); live check folded into VRF-2p7t as a new leg (enter Select → reload → verify the override is gone on the reloaded page).

## 2026-07-16: Feat — iPhone paste affordance + inherited-mouse restore (#402 + #579; UI-2P7T)

<!-- prawduct: type=feature | chunks=402 | scope=ui-2p7t | status=shipped -->

**Why:** Both halves came out of the same hour of VRF-574 on-device verification (2026-07-16, operator on iPhone). **#402 (paste):** with #574's keyboard/scroll fixes verified, the operator immediately hit the next wall — no way to paste INTO the terminal on iPhone (iOS has no Cmd-V; the native long-press Paste callout can't target xterm's hidden textarea). Filed 2026-06-25, but unbuildable until #574's tap-to-focus proved the gesture plumbing; operator-confirmed as next work. **#579 (residue):** VRF-574's leg-4 sweep caught a Select→Done round-trip stranding a session-level `mouse on` on TangleClaw — the benign-valued sibling of #574 RC2. The restore path always POSTs a value because the effective boolean loses the SOURCE: inherited `on` and explicit `on` are one value but two configurations, and restoring an inherited state by setting pins the session against future global changes, re-accumulating on every round-trip. **What (#402):** touch-gated **Paste** banner button (ships hidden; `'ontouchstart'` reveals; webui excluded — no xterm). Pure `tcPastePath` decides: secure context → `navigator.clipboard.readText()` inside the button's own gesture → `term.paste()` in the iframe (parent already reaches ttyd's xterm — the applyTerminalTheme accessor family); plain-HTTP / rejected / empty read → paste-catcher modal with a REAL textarea (the one element iOS's Paste callout can service, the #435 lesson's sibling) whose Insert funnels through the same `term.paste()`. Never a raw write: bracketed-paste framing matches desktop Cmd-V, so #192 (multi-line pipe corruption) is inherited unchanged, not worsened. State-driven open/close only (#98/#268). CACHE_NAME v3-48→v3-49. **What (#579):** `lib/tmux.js` pure `_resolveMouseState` → `{on, explicit}` (`_resolveMouseValue` delegates, boolean contract intact), `getMouseState`, `unsetMouse` (`set-option -u`); GET route reports `explicit`, POST accepts `unset: true` (mutually exclusive with `on`, answers post-op effective state); `tcSelectModeMouse` returns `{on}`|`{unset:true}` (contract extended, every #574 case restated unweakened); `toggleSelect` snapshots pre-select state FRESH on entry (page-load snapshot went stale — latent bug fixed in the same motion); Settings mouse toggle marks explicit (a deliberate operator choice IS an override). UI-8W3D (mid-select abandonment) not closed here but the unset mechanism is its fix shape. **Tests:** `tcPastePath` matrix + paste source pins (term.paste-never-write, isSecureContext gate, no-timers, touch reveal, real textarea, SW bump) in new `test/paste-affordance.test.js`; the inherited-restore-UNSETS regression, explicit-both-directions, `_resolveMouseState` matrix, fresh-snapshot + both-fields pins (`test/select-mode-mouse.test.js`; the #574 getMouse pin re-pointed to getMouseState — guard follows the code); `unset` route validation (`test/api-system.test.js`). **Honest limit:** iOS-reason-to-exist code, suite-verified only — on-device VRF owed (VRF-2p7t: HTTPS readText path, catcher path, multi-line paste vs #192 observation, Select→Done residue re-sweep). [ASSUMPTION A1: ttyd's xterm `paste()` applies bracketed framing when tmux enables 2004 — fallback is explicit CSI 200~/201~ framing. A2: readText inside a parent-document tap satisfies iOS gesture rules on the :8443 path.]

## 2026-07-16: Fix — iPhone terminal was select-only: keyboard focus + touch-scroll repaired (#574, absorbs #439; UI-6M4V)

<!-- prawduct: type=fix | chunks=574 | scope=ui-6m4v | status=shipped -->

**Why:** Operator-reported live from a phone (2026-07-16, the dentist's-waiting-room session): the web terminal on iPhone Safari could display and select text but nothing else — no soft keyboard ever appeared, touch-scroll was dead. The phone is this project's first-class client, and both owed VRF legs (VRF-561 leg 6, VRF-6V3R leg 4) were BLOCKED on it. The issue shipped with a hypothesis (toggleSelect's tmux branching) and an explicit diagnose-before-patching warning; the hypothesis proved a SUBSET of the truth — four defects, two independent failure chains. **Scroll chain (RC1-3):** the #443 shim translates one-finger drags into synthetic wheel events and REQUIRES tmux mouse ON — but (RC1) `getMouse` (`lib/tmux.js`) read only the session-level option, which is EMPTY with no override, so every global-`mouse on` session was misreported off, poisoning `sessionState.mouseOn` at page load; (RC2) `toggleSelect`'s mobile exit hardcoded mouse OFF (desktop exit restored the RC1-poisoned false) — one Select round-trip permanently stranded a session-level `mouse off` override, and its 30s auto-revert violated the no-UI-timers rule (#98/#268); (RC3) the touch-only "mouse guard" (a 3s poll forcing mouse OFF, a v3.0.0 relic protecting pre-#445 native mobile selection) was mutually exclusive with the shim by design. **The regression was STATE, not code** — the shim was on-device-verified 2026-07-02 and never changed; a stranded tmux option is invisible to git history. Live evidence at diagnosis: `RentalClaw-Project` carried `session=off` while 11 sessions inherited global `on` (one `tmux show-options` sweep — the highest-value diagnostic act of the session). **Keyboard chain (RC4):** the #445 ghost-mouse suppression swallows every mouse event within 1s of touch activity; on a touch-only device ALL mouse events are Safari-synthesized and always arrive within ms of a touch, so the synthesized mousedown that used to focus xterm's textarea was swallowed too — invisible on hybrid devices, which is why desktop verification never caught it. **What:** `getMouse` resolves the EFFECTIVE state (session override, else global) via pure `_resolveMouseValue`; `toggleSelect` routes both transitions through pure `tcSelectModeMouse` (`public/api-helper.js`) — exit always restores, timer REMOVED not lengthened, select mode is an explicit Select/Done toggle; the mouse guard is removed outright; a clean tap (pure `tcIsFocusTap`: single-finger, not the Copy pill, no long-press select, within 12px slop) now calls `term.focus()` inside the touchend gesture window; the ghost suppression itself is untouched (the copy path needs it). Stranded overrides elsewhere: check `tmux show-options -t <s> -v mouse`, clear `tmux set -u -t <s> mouse` — deliberately NOT auto-repaired; clearing RentalClaw's live override IS falsifiable prediction P2 in the VRF. CACHE_NAME v3-47→v3-48; `docs/user-guide.md` Select section rewritten (Critic WARNING — it still documented the 30s revert). **Tests** (`test/select-mode-mouse.test.js` + updated pins): RC1 fallback matrix, RC2 exit-restores-on-both-platforms (the exact hardcode), RC4 clean-tap predicate with each disqualifier, plus source pins — no setTimeout in toggleSelect, both transitions through the pure decision, guard stays removed, touchend-focuses-through-predicate, touchcancel never focuses. The #445 touchend source-pin updated to the new wrapper (intent preserved: passive, endSelect first, no clipboard write in touchend). Full suite 4251/0/1. **Honest limit:** code-reading-diagnosed and suite-verified, NOT device-verified — P3 (Safari honors `focus()` from touchend) is an open assumption with a named fallback (focus from the synthesized `click`, which the rewriter doesn't capture); VRF-574-iphone-terminal-input is the confirmation instrument and deliberately runs post-merge (the server serves `public/` from disk). **Critic:** cumulative (1 warning + 8 notes; warning fixed, two notes taken, one satisfied-but-invisible — the VRF entry lives in gitignored `.prawduct/`) → verify-resolutions chain 0/0/0 at HEAD. Filed UI-8W3D (reload mid-select still strands an override — the pre-existing abandonment hole the review surfaced).

## 2026-07-15: Fix — the supervised wall clock stopped expiring on the human it waits for (MED-6V3R)

<!-- prawduct: type=fix | chunks=MED-6V3R | scope=med-2k9p-v2 | status=shipped -->

**Why:** Incidental finding from the **VRF-561 operator verification** — the second real bug that VRF has paid for (after #566). The banner modal defaulted the wall clock to **10 minutes in both judge modes**, which halted live supervised fixtures three times purely because the operator stepped away; the loop was doing exactly what "supervised" means. Picked off the backlog at the operator's direction. **Root cause — a value bug on the surface, a category error underneath.** The Bridge enforces the guard as *total elapsed since first delivery*: `checkWallTimeGuardForLoop` (Medusa `medusa-server.js:261`) halts when `now - startedAt > maxWallTimeSeconds`, a clock **never paused and never reset per round**. Medusa#54 moved the origin off loop *creation* — fixing loops that died before the target ever woke — but it did not stop the clock running while a loop merely waits, so it does not rescue this case (worth stating: the operator's recollection was that #54 had already covered it). The two modes therefore bound different things through one knob: **autonomous** agents drive every round unattended, so the clock measures AGENT WORK and the guard is genuine runaway protection; **supervised** rounds advance only on an initiator send, so the loop *cannot run away by construction* (`maxRounds` already bounds it) and the clock measures HUMAN DELIBERATION — an abandonment bound wearing a runaway bound's number. One default cannot be honest for both. **What:** `lib/medusa.js` replaces `DEFAULT_MAX_WALL_SECONDS = 600` with per-mode `DEFAULT_WALL_SECONDS` (`supervised: 28800` / 8h — outlives real thinking time while still reaping loops left open overnight; `autonomous: 600` unchanged), resolved against the already-validated `chosenMode`; an explicit guard still wins in both modes and `maxRounds` is untouched. **The server default alone would have fixed nothing** — the modal is the path operators actually take and always sends an *explicit* value, so it never reaches that default: `public/session.html` prefills 480 min and `public/session.js` re-syncs the preset **and a mode-specific hint** on every mode change (`syncMedusaLoopGuardMode`), so the control states which of the two things it bounds instead of one label true in only one mode. A typed value survives a mode switch (module-level `medusaLoopMinutesDirty`, not residual DOM state — the SoT rule from TC#561's deadlock): silently discarding deliberate input is the defect the feedback composer was already faulted for in the same VRF. CACHE_NAME v3-46→v3-47. **Scope — deliberately not fixed here:** the clock still runs while a supervised loop waits. That semantic fix belongs to the Bridge, which owns enforcement; per the cross-session write boundary this session doesn't commit into Medusa's repo, so it goes upstream as an issue. This change makes the default humane; it does not make the guard measure the right thing. **Tests:** per-mode defaults, the supervised > autonomous *invariant* (survives a value retune), explicit-override-wins in both modes, `maxRounds` non-interference (`test/api-medusa.test.js`); modal prefill-is-not-the-autonomous-bound, the client-preset ↔ server-default sync (two independent copies of one number — the modal never reads the server default, so the drift is pinned by parsing both), distinct per-mode presets + hints, `aria-describedby` tie, dirty-flag no-overwrite, unknown-mode fallback, and a pin that no rendered hint claims the wall clock stops a runaway in BOTH modes — asserted against comment-stripped markup, since the source comment deliberately quotes the retired wording to explain why it went (`test/medusa-control.test.js`). The 4 regression pins were **revert-verified**: reverting all three halves to the old shared 600 fails exactly those 4 and no others. **Live probe** against the real `openLoop` + a fake Bridge: mode-omitted → 28800, supervised → 28800, autonomous → 600, explicit → 42 on the wire. Confirmed Medusa stores `guards` verbatim with no clamp or upper bound (`medusa-server.js:1047`), so an 8h budget is accepted and honored. Full suite **4237/0/1** (+12 from the 4225 baseline). **On the evidence-count discrepancy** — run down to root cause this time, because a prior Critic spent a finding on it and hedged that it "may partly be a junit-vs-default reporter difference". **It is not a reporter difference:** both reporters agree on 4237, and the junit XML itself contains all 4237 `<testcase>` leaves (0 wrappers). It is a prawduct parsing bug. `prawduct-hook test-evidence` sums the `tests=` attribute of the 351 **top-level** `<testsuite>` elements → 2144 (= 2143 passed + 1 skipped). But node:test's junit reporter sets `tests=` to a suite's **direct child element count**, and for a suite holding nested `describe`s those children are the *sub-suites*, not the tests within them — e.g. `antigravity engine (#456)` declares `tests="5"` for its 5 child describes while actually containing 14 tests. So the undercount scales with nesting depth (~2× here). Verified, not inferred: my first hypothesis ("counts direct child *testcases*") predicted 0 for that suite and was falsified before it reached this entry. The recorded `failed: 0` is accurate — which is what the gate reads, so nothing mis-gates — but `passed` and the implied total are not. Filed as `PRW-5N8T` (area `prawduct-upstream`) rather than worked around here; TC's own citations use the default reporter, as prior entries do.

## 2026-07-15: Fix — loops panel dismissed itself on any synchronous control click (#566)

<!-- prawduct: type=fix | chunks=566 | scope=med-2k9p-v2 | status=shipped -->

**Why:** Found by the **VRF-561 operator verification** — the VRF paid for itself. Clicking **Send feedback** highlighted the button then closed the whole loops panel without sending, so the inline composer was unreachable and the FEEDBACK half of the TC#561 control spine was unusable in the shipped UI — despite its routes, guards, and tests all passing green. **Root cause:** the document-level outside-click dismiss decided insideness with a **live** `e.target.closest('.medusa-control')`; the panel's delegated handler runs first and calls `renderMedusaLoopsPanel()`, which replaces `panel.innerHTML` and **orphans the clicked button** — `closest()` on an orphan walks no ancestors, returns `null`, and `!null` fires the dismiss. `renderMedusaLoopsPanel` is `async`, but its only `await` is behind `if (medusaExpandedTranscripts.size > 0)`, so with no transcript open nothing awaits and the `innerHTML` swap happens synchronously *inside* the click handler. That gated await explains why only SOME controls broke: Force-done / Mark done / the composer's **Send** all `await apiMutate(...)` first, letting the event finish bubbling while its target was still attached — **accidentally** safe; the synchronous **Send feedback** toggle and **Transcript-collapse** were not. **Diagnosis method worth keeping:** the mechanism predicted a falsifiable asymmetry — Transcript-*expand* (await path) survives, Send feedback (sync path) dismisses — and the operator's live click confirmed exactly that, isolating the variable to "does an await run before the re-render". **What:** new pure `clickHitsSelector(event, selector)` reads the **dispatch-time** propagation path (`composedPath()`), which no later DOM mutation can invalidate; both dismiss predicates (`.medusa-control` + `.group-pill`) use it, kept symmetric so the latent twin can't drift (`feedback_symmetric_capability_gates`); `closest()` remains only as a no-`composedPath` fallback. CACHE_NAME v3-45→v3-46. **Tests:** `session.js` touches `window` at load so it can't be required, and the frontend suite is source-probes with no DOM harness — structurally blind to a DOM-detachment bug (**TST-6L2P**), which is precisely why this shipped past both the unit tests and T4's VRF (T4 exercised Force-done + Transcript-expand, both on the accidentally-safe async path). Since the predicate is pure, the new tests **lift it out of the browser file via `new Function` and execute it** against synthetic events — genuine behavioral coverage at zero deps: orphaned-target regression, genuine-outside-click still dismisses, attached-inside, non-element path entries, `composedPath`-absent fallback, and a call-site pin. Revert-verified: 4 fail against the shipped predicate, 0 after. Full suite 4225/0/1.

## 2026-07-14: Fix — switchboard wake nudges the session it judged, not a re-resolved one (MED-7Q4C)

<!-- prawduct: type=fix | chunks=MED-7Q4C | scope=med-2k9p-v2 | status=shipped -->

**Why:** Critic NOTE on MED-2K9P v2 Slice 1 chunk T2 (2026-07-11), picked off the backlog as the only `stage: ready` item. `lib/medusa-wake.js` judged idleness on its own `session.tmuxSession` handle (gate + `capturePane`) but injected via `injectCommand(project.name, …)`, which re-resolved the target independently with `store.sessions.getActive(project.id)` — two lookups for one decision. Latent, but genuinely reachable in the data model rather than merely hypothetical: `store.sessions.start` enforces no single-active-session constraint and `getActive` takes `ORDER BY started_at DESC LIMIT 1`, so a project holding two live sessions would send the nudge to whichever started last — a pane this scan never assessed, possibly mid-turn or mid-typing. **What:** `injectCommand` (`lib/sessions.js`) accepts `options.sessionId` to address one session explicitly; medusa-wake passes the id it judged, collapsing judgment and delivery onto a single resolution with no check-then-act window (the alternative fix shape — asserting `getActive` matches before sending — was rejected: it keeps two lookups and leaves a TOCTOU gap). The handle **selects which session, never whether it may be injected into**: an explicitly-addressed session must belong to the named project (`store.sessions.get` is any-project/any-status, so the scope check keeps `sessionId` from reaching another project's pane — the cross-project-contamination threat in `security-model.md` §1) and must be `active` (never a wrapped/killed session's stale tmux name); the existing webui + `hasSession` guards now validate that same resolved session rather than a re-looked-up one. Default project-name path unchanged; the HTTP route `POST /api/sessions/:project/command` builds its options literal explicitly, so no caller-supplied id is reachable from the API. `security-model.md` validation table documents the new handle. **Tests:** addressed-session-wins-over-`getActive`'s-pick (target derived from the *actual* pick, so no dependence on the `started_at` tie-break), foreign-project refusal, non-active refusal, unknown-id refusal, unchanged `getActive` default (`test/sessions.test.js`); wake-passes-the-judged-id + per-session addressing under two live sessions (`test/medusa-wake.test.js`); unconditional `afterEach` cleanup so a failing assertion can't leak an active session into later suites. Both halves verified to FAIL when reverted (wake drops the handle → 2 fail; `injectCommand` ignores it → 4 fail); full suite 0-fail. **Critic:** verify-resolutions chain — 0 blocking, 1 warning (this missing change-log entry, now added), 1 note (backlog status, closed on branch).

## 2026-07-14: Feat — supervised loop continue/feedback + satisfied closeout (TC#561, completes MED-2K9P v2 Slice 1 control spine)

<!-- prawduct: type=feat | chunks=561 | scope=med-2k9p-v2 | status=shipped -->

**Why:** The Slice-1 loops panel exposed only Force-done + Transcript, and the server had only open + force-done routes — so an initiator could observe and kill a supervised loop but never **continue it with feedback** or **close it as satisfied**. The FEEDBACK and CLOSEOUT halves of the design §1 control spine ("initiator judges → CLOSEOUT (satisfied, ends) or FEEDBACK (loops)") were undelivered on the TC side; round-2 feedback had to be POSTed to the Bridge by hand (found live during the T4 VRF, filed as TC#561). **What:** server — `medusa.continueLoop` (route `POST .../medusa/loops/:id/continue {message}`) posts an initiator FEEDBACK round over the Bridge `POST /loops/:id/message` (from=initiator), advancing `responded → continue` (round++); `medusa.closeoutLoop` (route `.../closeout`) closes with `closeSignal.reason:'satisfied'` — distinct from the force-done kill-switch — with `forceDoneLoop` refactored onto a shared `_closeLoop` helper. Client — when a loop this session initiated is in `responded`, the panel shows **Send feedback** (inline labelled composer) + **Mark done**; the affordances gate on `responded` because the Bridge accepts an initiator round only after the target replies (a stale-state click passes the Bridge's 400 "target response first" through verbatim, never a false "sent"). Feedback travels as HTTP data (never a keystroke); every Bridge field `esc()`d. **Critic-driven hardening (cumulative found a BLOCKING deadlock in the first guard):** the poll-re-render guard now keys on textarea *focus* (not residual DOM value — the value-keyed version froze the panel forever after a send), draft text lives in a Map that re-seeds the textarea each render (survives re-renders, multi-composer safe), the satisfied label survives a refresh via `medusaLoopStateLabel` (durable row "ended — marked done", not just the toast), and a round that hits `maxRounds` toasts honestly ("hit its round cap and halted"). CACHE_NAME v3-44→v3-45. **Tests:** continue happy/empty-400/wrong-state-400-passthrough/maxRounds-auto-halt + closeout satisfied/already-closed-400/no-session-409 against the fake Bridge's new stateful `/loops/:id/message` handler (`test/api-medusa.test.js`); source-probes for the responded-only gate, labelled composer + XSS esc, focus-only guard (no deadlock), draft-Map preservation, satisfied label survival, honest halt toast, delegated wiring (`test/medusa-control.test.js`); full suite 0-fail. **Critic:** cumulative (escalate coordinator) found 2 BLOCKING (one deadlock root cause, caught by two reviewers) + warnings; all fixed, verify-resolutions chain to follow. **VRF queued:** VRF-561-loop-continue-feedback (fixture loop `330f7468`).
## 2026-07-14: Feat — engine-aware wake nudge (TC#560, first chunk of Switchboard v2 Slice 2)

<!-- prawduct: type=feat | chunks=560 | scope=med-2k9p-v2 | status=shipped -->

**Why:** The idle-gated switchboard wake (`lib/medusa-wake.js`) hard-skipped `engineId !== 'claude'` and used Claude-only TUI markers, so a `medusaWake:true` non-Claude target (antigravity/Gemini-CLI) received inbox mail but was never nudged — supervised/autonomous loops against it were structurally dead without a manual `tmux send-keys` nudge (observed live 2026-07-14, loop `80b935a2` sat at round 0 until its wall-time guard halted it). **What:** replaced the Claude-only gate + module-level markers with a per-engine `ENGINE_WAKE_PROFILES` registry (`{busyMarker, promptRe, idleMarker}`) keyed by `engineId`; `_assessPane` takes a profile. Claude's path is byte-for-byte unchanged (`esc to interrupt` + bare `❯`, no idle marker). The antigravity profile (`esc to cancel` + bare `>` + a required `? for shortcuts` at-rest marker) was derived from a LIVE pane capture (Medusa builder pane, 2026-07-14) — which surfaced the load-bearing finding that Gemini-CLI keeps its bare `>` prompt rendered mid-turn, so the busy-marker gate can't be the sole guard and a positive at-rest marker is required. That positive marker also makes the (unforceable, auto-approve builder) permission-dialog case fail-safe by construction (a dialog drops `? for shortcuts` → reads non-idle). webui and unprofiled engines (codex, aider — no live signature captured) stay skipped-and-logged, never woken against a guessed idle signature. **Tests:** antigravity idle/busy/dialog/typing `_assessPane` matrix, cross-profile non-match (Claude pane not idle under the antigravity profile and vice-versa), full idle→nudge tick for an antigravity session, unprofiled-engine/webui skip gate; all Claude pins preserved (`test/medusa-wake.test.js`); full suite 0-fail. **Critic:** verify-resolutions chain (0 blocking/warning, 1 note) — the note (real-dialog capture unforceable on the auto-approve builder) anticipated and enqueued. **VRF queued:** VRF-560-engine-aware-wake.

## 2026-07-14: Fix — prime truncation dropped the Resume wait-guard + wrap sentinel on medusaEnabled launches (#557)

<!-- prawduct: type=fix | chunks=557 | scope=med-2k9p-v2 | status=shipped -->

**Why:** Operator-reported live regression during the T4 VRF sweep: a freshly-relaunched bypass-mode Gemini session "went to town" at boot (unprompted switchboard/continuity exploration — "thought I was hacked"), while interactive mode sat inert. Root cause reproduced offline against the live store: T1's consumer-contract embed (~14K chars) blows the methodology template's prime cap (`prime.maxTokens * 4`; prawduct 16000, minimal 8000), and `generatePrimePrompt`'s blind tail-truncation silently cut every section after the contract — the Resume block's wait-for-confirmation guard, Active Learnings, and the wrap-sentinel instruction (typed "wrap" dead too). The session booted with a mission-shaped prime and no wait directive; permission mode was the only thing separating quiet from chaos. **What:** bulk reference yields to directives (`lib/sessions.js`) — `_medusaPrimeSection` now carries identity + role only; new `_medusaContractSection` appends the contract LAST, budgeted to the space the cap leaves (full / trimmed with an honest `[contract truncated to fit the prime size budget — full doc at <path>]` note / omitted-with-pointer below a 400-char floor); the blind slice survives only as a safety net the medusa path can no longer trip. Plus an explicit "**context, not a task**" line — participation is event-driven, never a boot mission, truncated or not. Live re-render: portfolio prime 15,996/16,000 chars, every directive present. **Tests:** #557 regression pin (oversized contract + continuity index + cap → all directives survive, honest trim note, blind slice must NOT fire; verified failing pre-fix), budget-floor omission, infinite-budget full embed, guard-line presence (`test/sessions.test.js`); full suite 4186/0/1. **Critic:** verify-resolutions chain (0 blocking, 1 warning — stale test evidence, refreshed) extending cumulative `ce1d1359` to HEAD `62f625c`.

## 2026-07-14: Feat — banner loop view + force-done + boot listener re-sync (MED-2K9P v2 Slice 1, chunk T4 — TC side complete; Round-3 e2e RAN LIVE)

<!-- prawduct: type=feat | chunks=T4 | scope=med-2k9p-v2 | status=shipped -->

**Why:** Switchboard v2 chunk T4 (`.prawduct/artifacts/build-plan.md`) — the last TC chunk of Slice 1: loop observability + the human kill-switch, plus the Round-3 e2e (the go/no-go proof of the agent-as-client thesis). Fold-ins TC#552 and TC#550 per the plan. **What:** a **⟳ loops chip** + **loops panel** in the banner Medusa control — live state, round count (`R{n}/{max}` chip text; NEVER color-only), ambient live-loop glow (reduced-motion-suppressed), per-loop rows with an initiator-only **force-done** and an expandable transcript labeled for what it honestly is ("as observed by this session"). Design pinned against Bridge SOURCE before coding: no `GET /loops` list (TC tracks ids — `openLoop` records, inbound `loopId` tags re-learn, 404 untracks self-healingly), no round-history retention (full transcripts impossible TC-side → Medusa#49), and close NEVER lands `halted` (guards only) — so force-done rides the contract's initiator-only close with structured `closeSignal.reason:'force-done'`, rendered "ended by force-done" from the closeSignal, no fake halted label (semantics filed as Medusa#50); a guard-halted loop surfaces "cannot be closed" with the Bridge's 400 verbatim. Loops ride the existing status poll (no new timer); a mid-poll Bridge failure degrades to `loops:[] + loopsError`, never silently empty. **TC#552:** the out-of-band task notice is GONE — Medusa#47's fix (PR #48 `loopInvite`) made every TC launch double-notify; response loses `taskDelivery`, the toast claims only what the contract guarantees. **TC#550:** server boot runs `sessions.resyncMedusaListeners()` — same predicate as launch, persisted ids reused; **the restart that deployed this chunk WAS the live test: 4 listeners re-synced, identity stable (`tangleclaw-a7e22166` reused), roster 3→7, zero manual healing.** CACHE_NAME v3-43→v3-44. **Round-3 e2e (autonomous leg) RAN LIVE:** loop `9883d869` — open → Bridge loopInvite → target (Medusa/Gemini session) tmux-nudged awake (the documented wake gap) → round-1 reply landed in the initiator inbox loopId-tagged → judge closeout (round 2) → close `reason:done`; loop `67069a05` force-done mid-`initiated` via the new route (`complete` + force-done closeSignal). First full initiator→target→judge→closeout loop cycle over the banner plumbing on real infrastructure. Supervised leg = the queued T4 VRF (the banner IS the human-judge surface). Artifact hygiene: stale VRF-03 (compose UI removed in T3) marked superseded. **Tests:** `getLoops` discovery/re-learn/404-untrack/sort + `forceDoneLoop` honest-close/guard-halted/initiator-only/unknown matrix + status-with-loops + force-done routes against the fake Bridge's new stateful loop store + TC#550 predicate/id-stability/idempotency/broken-project/boot-wiring (`test/api-medusa.test.js`); loop-view source probes — XSS on every Bridge field, honest state labels, reduced-motion, no-new-timer, delegation (`test/medusa-control.test.js`); full suite 4182/0/1. **Critic:** verify-resolutions chain (0 findings) extending cumulative `ce1d1359` to HEAD `7e438bc`. **VRF queued:** VRF-med-2k9p-t4-loop-view.

## 2026-07-13: Feat — loop setup modal + live-toggle listener sync + ACK-on-read (MED-2K9P v2 Slice 1, chunk T3)

<!-- prawduct: type=feat | chunks=T3 | scope=med-2k9p-v2 | status=shipped -->

**Why:** Switchboard v2 chunk T3 (`.prawduct/artifacts/build-plan.md`) — the loop launch surface against M2's real loop object, with two folded listener-lifecycle fixes that gate a trustworthy Round-3 e2e: TC#547 (stale-redelivery wake nudges after TC restarts) and TC#549 (the operator-reported "toggled Medusa on but the session never appears in the roster"). **What:** the banner ➤ now opens a **Session Loop modal** replacing the deprecated compose popover (T3 acceptance: compose gone; its send *plumbing* retained as the loop transport): roster target picker (honest loading/error/empty states), task + done criteria, judge mode (supervised default / autonomous — both selectable per ratified §8), and the two **server-enforced** guards (max rounds, max minutes → `maxWallTimeSeconds`); no token knob on purpose — the Bridge doesn't enforce one, and an unenforced control is a dishonest control. New `POST /api/sessions/:project/medusa/loop` → `medusa.openLoop`: creates the loop (`POST /loops`, initiator = the session's registered id) AND delivers the task notice to the target as a direct message naming the loop id + how to respond — **verify-api live probe found M2 never notifies the target on open and bars the initiator from posting round 1 (deadlock-by-design; the M2 acceptance probes masked it by driving both sides manually) → filed Medusa#47 and dispatched it to the Medusa session OVER THE SWITCHBOARD (first real work dispatch on the channel, delivered live)**; the notice is the documented workaround until #47 lands. TC#547: the listener ACKs **on read** (never receipt) — `markRead` sends one WS `ack` frame, ids await `ack_response` confirmation, unconfirmed ACKs re-flush on re-`registered` while the `messageId` de-dup keeps redelivered copies off the badge; unread mail intentionally stays queued Hub-side (at-least-once). TC#549: `updateProject` syncs a `medusaEnabled` flip to the LIVE session via `_syncLiveMedusaListener` (lazy-required; non-throwing — the pref persists even if the Bridge is down). Also filed TC#550 (a TC restart drops every live listener; boot re-sync — T4 fold-in candidate). CACHE_NAME v3-42→v3-43; the openclaw-bridge-port-row exact pin converted to the ≥-generation pattern (exact pins snap on every legitimate bump). **Tests:** `openLoop` validation/defaults/honest-failure matrix + `/loops` fake-Bridge route wiring + TC#549 ON/OFF/no-session (`test/api-medusa.test.js`), 7 ACK-on-read edge pins (`test/medusa-listener.test.js`), loop-modal source-probes carrying every compose-era security/honesty pin (`test/medusa-control.test.js`); full suite 4149/0/1. **Critic:** verify-resolutions chain (0 findings) extending cumulative `ce1d1359` to HEAD. **Live smoke (real Bridge, post-restart on the branch build):** loop object created with truthful initiator+guards and the task notice queued to an offline target; ACK-on-read drained the Hub queue 1→0 after `POST /read`; the TC#549 PATCH-sync registered the two previously-invisible running sessions (Monad-1, TiLT Claw) with no relaunch — healing the operator's reported bug live. **VRF queued:** modal + live-toggle walk-through in `.prawduct/operator-verification.md`.

## 2026-07-12: Feat — Medusa contract injection at launch (MED-2K9P v2 Slice 1, chunk T1 — Round 1 complete)

<!-- prawduct: type=feat | chunks=T1 | scope=med-2k9p-v2 | status=shipped -->

**Why:** Switchboard v2 chunk T1 (`.prawduct/artifacts/build-plan.md`), the last Round-1 chunk — design §3's "the agent is the client" thesis needs every opted-in session to boot already knowing how to participate: the contract, its identity, its role. M1 shipped the real contract upstream (Medusa `docs/CONSUMER-CONTRACT.md`, #34), so no stub phase. **What:** the prime prompt of a `medusaEnabled` project gains a "Medusa Switchboard" section carrying (1) the consumer contract embedded in full — resolved `MEDUSA_CONTRACT_PATH` env → registered Medusa project checkout (`lib/medusa.js#readContract`); unresolvable → an honest UNAVAILABLE note naming every path tried, never a silent omission; (2) the session's workspace identity, made truthful by **pre-minting**: `launchSession` mints the id (unpersisted) before prime generation and threads it through `_maybeAutoStartMedusa` → `startSession({workspaceId})` → `ensureWorkspaceId(..., preferredId)`, which adopts it and supersedes stale registry debris under a recycled session id — the prime and the listener can never diverge; (3) the participant role (act + reply until the initiator closes; initiator-only termination) plus the division-of-labor guard: TC runs the WS listener, so the agent uses TC's `/medusa/*` API and never opens a second registration (two consumers on one id fight over the destructive-pop queue). Prime, not engine config, on purpose: the id is session-dynamic (minted per launch, forgotten at teardown), and the config route can't reach TC's own plugin-governed CLAUDE.md — which would silently exclude the primary dogfood session. Toggle/reconnect/webui paths pass no preferred id and are unchanged. **Tests:** registry mint/adopt/supersede/stability + threading seam + register-frame identity (`test/api-medusa.test.js`), contract resolution precedence + empty-file honesty, prime section content + both off-gates (`test/sessions.test.js`); full suite 4119/0/1. **Critic:** verify-resolutions chain (0 findings) extending cumulative `ce1d1359` to HEAD. **Live probe:** the real TangleClaw prime generated with the section — full contract embedded, id + role + WS-guard present. **VRF queued:** one-relaunch check in `.prawduct/operator-verification.md` (fresh session names its id + inbox endpoint unprompted; id matches `/medusa/status`).

## 2026-07-11: Feat — idle-gated wake nudge, the switchboard's turn-wake primitive (MED-2K9P v2 Slice 1, chunk T2)

<!-- prawduct: type=feat | chunks=T2 | scope=med-2k9p-v2 | status=shipped -->

**Why:** Switchboard v2 chunk T2 (`.prawduct/artifacts/build-plan.md`) — an idle LLM session is free but not self-triggering (design §4): something must wake the receiver's next turn when mail arrives. T2 supplies that one mechanical primitive AND doubled as the Round-1 go/no-go spike on idle-detection reliability. **Spike verdict: GO, with a design flip** — the plan assumed the existing output-age heuristic; the live probe (4 real sessions) showed Claude Code's status line carries a deterministic in-flight marker (`esc to interrupt`), and output-age alone false-idles on long quiet tool calls — the exact interrupt-a-busy-turn failure the plan feared. **What:** `lib/medusa-wake.js` boot-time monitor (wrap-sentinel lifecycle): for an opted-in project's listening session with fresh mail, types a FIXED one-line nudge at the next provably-idle moment — busy-marker absent AND a bare `❯` prompt line (refuses permission dialogs, where typed bytes could ANSWER the dialog, and half-typed operator input) + 2-tick debounce. Zero message bytes injected (cross-session text arrives over HTTP as data, never keystrokes); one nudge per fresh-mail edge (watermark; burst drains FIFO on a single wake); reconnect windows HOLD a pending wake (Critic cumulative WARNING, fixed in-branch). New `medusaWake` project pref (default OFF — a wake spends a turn, v1's badge didn't) mirrored end-to-end (`lib/projects.js`, `server.js` PATCH echo, Settings toggle in `public/ui.js`; CACHE_NAME v3-41→v3-42). Slice-1 gates: Claude/tmux sessions only; webui/other engines skip with a once-per-session log; wrapping sessions skip silently by design. **Tests:** `test/medusa-wake.test.js` (pane policy pinned byte-for-byte against the spike captures; debounce/watermark/burst/retry/reconnect-hold/wrapping-skip; every gate blocking alone), `medusaWake` round-trip (`test/projects.test.js`); full suite 4100/0/1. **Critic:** chunk (0/0/2 notes, both handled) → cumulative (0 blocking, 1 warning → fixed) → verify-resolutions chain (0 findings, covers HEAD). Backlog: MED-7Q4C filed (latent multi-session divergence). **VRF:** operator live dogfood ON THIS SESSION — busy pane untouched during 2 sends, single nudge on next-idle drained both, receiver fetched/acted/read via API, switchboard reply delivered `received`. M1 note: the Medusa consumer contract shipped upstream same day (`docs/CONSUMER-CONTRACT.md`, Medusa PR #41, #34 closed) — T1 injects the real contract, no stub.

## 2026-07-11: Feat — Medusa switchboard outbound send + roster picker + resilience/lifecycle (MED-2K9P Chunks 03–04)

<!-- prawduct: type=feat | chunks=03,04 | scope=med-2k9p | status=shipped -->

**Why:** MED-2K9P Chunks 03 (send half) + 04 (resilience & lifecycle — final chunk), completing switchboard v1 (`.prawduct/artifacts/build-plan.md`). Chunk 03 puts the outbound half live; Chunk 04 hardens it against the id-model realities found at verify-api. **What (Chunk 03):** `lib/medusa.sendMessage`/`getRoster` + `POST /medusa/send` + `GET /medusa/roster` (thin Bridge pass-throughs; the browser never touches the Bridge). A ➤ compose panel with a roster **target picker** (self-excluded) and an honest delivered/queued/failed toast; the outbound head lights on send. Non-empty message enforced client- AND server-side (verify-api proved the Bridge does NOT validate the body — a missing body still queues). Truthful `from` set server-side (the browser can't spoof it). Critic (chunk) caught a false "nobody home" on a failed roster fetch → fixed with a distinct error/retry state + regression pin (honest-status on the read path). **What (Chunk 04):** id-model-independent resilience — socket-identity guard (late events from a superseded socket can't perturb live state), inbox `messageId` de-dup, honest Bridge-down → auto-reconnect → listening, and `forgetSession`/`_teardownMedusa` (stop WS + forget registry id) wired into **every** session-end path (kill, `completeWrap`, `autoCompleteWrap`, stale-wrapping recovery, tunnel-kill) — no ghost roster peer. verify-api found the carried-forward "HTTP-register so offline sends queue" DOESN'T work (register mints its own id; a WS-only id 404s offline, never queues) → **offline store-and-forward descoped** (Option A: keep local ids, honest-404 on a down-window); a Medusa register-id issue is owed for the durable fix. **Tests:** `test/api-medusa.test.js` (send/roster routes; teardown source-probed on all six end paths), `test/medusa-control.test.js` (compose panel + error/retry state), `test/medusa-listener.test.js` (socket-identity, de-dup, reconnect); Medusa suite 47/47, full suite 4074/0/1 at the cumulative. **Critic:** chunk (03) → chunk (04) → cumulative (03+04 bundle: 0 blocking, 6 warnings, 6 notes; all six warnings + two load-bearing notes fixed) → verify-resolutions chain (0 blocking, covers HEAD). Cross-cutting theme: "honest status, never a false state" bit on the read path (roster fetch), the write path (offline descope), and lifecycle (ghost peer) — audit every edge, not just the happy path. **VRF:** operator two-session e2e — S1 (delivered send + self-exclusion) PASS, S2 (Bridge-down honest error + auto-reconnect) PASS, S3 (session-end cleanup / no ghost peer) verified via the source-probe suite. **Direction (operator, 2026-07-11):** the manual compose UI is **deprecated** — Switchboard v2 replaces it with the cross-platform autonomous inject-and-loop (design: `.prawduct/artifacts/switchboard-v2-design.md`); the send *plumbing* (lib + endpoints) is retained as v2's transport. Medusa-side stale-workspace reaping filed + fixed (Medusa #37, closed).

## 2026-07-10: Fix — V1 prawduct playbook gated by engine + rule; V1 methodology deprecated (#536)

<!-- prawduct: type=fix | chunks=v1-remnant-bugfix | scope=prawduct-v1-remnant-bugfix | status=shipped -->

**Why:** TC never fully migrated off its V1-internal `prawduct` methodology — the full "Session Playbook: Prawduct" (incl. the Independent Critic protocol) was injected into every non-plugin-governed project's generated config: 19 CLAUDE.md files fleet-wide, including non-Claude engines where the governance cannot apply, and regardless of `independentCritic: false` (the render mismatch the TiLT v2 session hit, running V1 prose + a hand-rolled Critic instead of the plugin's `critic-reviewer`). Operator decision: **bugfix now, migrate later** — don't strip governance from the 12 unmigrated drift/vendored projects. **What:** template-declared, generator-enforced gates (template.json reconciles additively into live installs on boot #136; playbook.md is user-owned after first copy, so stripping is heading-based at render time): `playbookEngines: ["claude"]` + `playbookRuleSections: {independentCritic: "### Independent Critic Review"}` (strips on **explicit false** only), via a single `_renderPlaybook` replacing the four per-engine `getPlaybook` sites (`lib/engines.js`). V1 template marked `deprecated` + `deprecationNote` (surfaced by `listTemplates`, badged in both pickers; `CACHE_NAME` v3-40). Critic findings fixed in-branch: `attachProject` now applies detected-methodology `defaultRules` like create/switch (asymmetric-gate class), and `_renderPlaybook` warns on heading-miss / strips-to-empty. **Verified live:** boot merged the new template keys; ClawCode-x/.codex.yaml + both .antigravity.md lost the playbook; TiLT v2 (inner, explicit false) lost only the Critic section; UCI/Notse/WhitePapers (true) kept it; plugin-governed untouched. **Tests:** `test/prawduct-playbook-gating.test.js` (12), attach default-rules pin (`test/projects.test.js`), CACHE_NAME pin update; suite 4036/0-fail. **Critic:** cumulative (0 blocking, 3 warnings) → fixes → verify-resolutions chain (0/0/0).

## 2026-07-10: Chore — session-banner logo size-matched to the Medusa crest (29px, de-padded)

<!-- prawduct: type=chore | chunks=banner-logo-size | scope=logo-rebrand | status=shipped -->

**Why:** operator note — the banner serpent read smaller than the Medusa heads beside it (22px vs 29px) and carried visible transparent margin. **What:** (1) added `public/logo-banner.png` — the green-serpent emblem **tight-cropped to its opaque bbox** (the shared 1024² source has ~5–8% transparent margin; cropped to a centered square so the serpent fills the frame), 128² for retina. (2) `.banner-logo` CSS bumped **22px → 29px** to match the Medusa crest heads; still clears the 32px back-button row so banner height is unchanged. (3) Pointed both banner `<img class="banner-logo">` (session.html + openclaw-view.html) at the new tight asset (was the padded shared `icons/icon-192.png`). The shared PWA/favicon/apple-touch icons are left untouched — they *want* the safe margin (maskable/rounded OS treatment). No `CACHE_NAME` bump needed (session.css + navigations are network-first). **Tests:** n/a (CSS + asset); previewed at 29px next to the Medusa crest for size-match. **VRF:** operator eyeball (banner) after hard refresh.

## 2026-07-10: Chore — new TangleClaw logo (green serpent) across all in-app icons

<!-- prawduct: type=chore | chunks=logo-rebrand | scope=logo-rebrand | status=shipped -->

**Why:** operator branding refresh — new green-serpent emblem, wanted everywhere (in-app + GitHub). **What:** replaced all in-app icon assets **in place** (no reference/HTML/manifest changes): `public/logo-icon.png` (favicon + landing dash-logo), `public/logo.png` (onerror fallback), `public/icons/icon-192.png` (session-banner mini + PWA), `public/icons/icon-512.png` (PWA), `public/icons/apple-touch-icon.png` — all resized (Pillow LANCZOS) from the operator-supplied **transparent** 1024² PNG. Favicon **2.5 MB → 256 KB**. Kept the `logo-text.png` text wordmark (new art is icon-only). The GitHub README emblem (separate `project-assets` repo, previously a flattened black-bg variant) is refreshed to the same transparent version in the same pass. **Design note:** the new art is a self-contained transparent emblem (corners alpha-0, soft green glow halo), so it drops onto any background — unlike the first (black-bg) candidate whose snake coiled around opaque black and couldn't be keyed transparent. **Tests:** n/a (binary asset swap; no code/manifest change); previewed on dark + light at banner/landing/96px sizes. **VRF:** operator eyeball owed (favicon/banner after hard refresh).

## 2026-07-10: Fix — Medusa banner real art + un-dismissable inbox modal fix (MED-2K9P Chunk 02 follow-up)

<!-- prawduct: type=fix | chunks=02-followup | scope=med-2k9p | status=shipped -->

**Why:** operator smoke of the shipped Chunk-02 banner surfaced (a) a hard bug — the inbox read panel could not be dismissed once opened — and (b) that the placeholder head art wasn't good enough; the operator supplied production Medusa artwork. **What:** (1) **Inbox-modal fix** (`public/session.{js,css}`) — opening the inbox marks it read → `unread` drops to 0 → the toggle **badge self-hides**, leaving no close control and no Escape handler (a hard trap on touch, where the only remaining path — an outside tap — is undiscoverable once the badge vanishes). Root-cause fix: an explicit **✕ close** button in the panel header (delegated handler, since the panel `innerHTML` re-renders on each open), **Escape-to-close** (scoped to when the panel is open), and a dedicated `closeMedusaInbox()`. (2) **Art upgrade** (`public/session.{html,css}`, approach B, operator-ratified over live headless previews) — replaced the hand-vectored placeholder SVG with production gold WebP art: **two facing heads flanking the MEDUSA emblem** as per-head `<img>` pieces (`public/medusa-head-left.webp`, `medusa-head-right.webp`, `medusa-wordmark.webp`), downscaled ~475 KB PNG → ~17 KB alpha-preserving WebP; head size + gap tuned live to the operator's eye. Status is carried by **state, not a flat recolor**: gold at rest (`listening`), **dim + desaturate** when off, amber glow on error (with the "!"), inbound head still glows green on receive (the "traffic" cue; Chunk-03 outbound glows the right head — no colored asset variants needed) — the gold brand survives while status stays honest and distinct per state; separate head images preserve the per-head status Chunk 03's outbound needs. Dropped the placeholder's central "bridge" element (emblem is the centerpiece) and removed the now-dead `--medusa-color` CSS var. `CACHE_NAME` `-38→-39`. **Deferred to backlog:** MED-4T7K (accept-&-insert), MED-6P2N (auto-toggle), MED-9X3B (autonomous relay — flagged: command-injection trust surface, needs a threat model). Plus a **hover-help tooltip** (`medusaHelpText`, the heads `title`) explaining what Medusa is and what this session is doing in the current state, kept distinct from the concise aria-label. **Critic:** `chunk` → `cumulative` → `verify-resolutions` (chain), 0 blocking; the cumulative WARNINGs (dead `--medusa-color`, stale interaction-design doc, emblem-height overridden by CSS specificity) all resolved. **Tests:** `test/medusa-control.test.js` (+ close-button in empty+populated panel, ✕/Escape wiring, per-head art present, emblem centered between heads, no bridge, placeholder-gone, assets ship, hover-help text + title wiring), cache pin `test/openclaw-bridge-port-row.test.js` `-38→-39`. Full suite 1989/0/1 (see `.prawduct/.test-evidence.json` for the HEAD sha). **VRF:** DONE — operator verified the crest + inbox close on iPhone Safari (2026-07-10).

## 2026-07-10: Feat — Medusa banner control + receive badge + per-project auto-enable (MED-2K9P Chunk 02)

<!-- prawduct: type=feat | chunks=02 | scope=med-2k9p | status=shipped -->

**Why:** MED-2K9P Chunk 02 (build plan `.prawduct/artifacts/build-plan.md`) — the early-feedback UI slice of the switchboard: put the receive half live in the banner so an operator can toggle Medusa on and watch a message sent to that session light a badge, then open it. **What:** (1) **Banner control** (`public/session.{html,css,js}`) — a two-head Medusa mark (heads inlined from `medusa-logo.svg`, recolored per-head via CSS) carrying honest listener status: RED off / GREEN on / GREEN-pulsing connecting / AMBER + "!" error (error kept distinct from off). Heads click = toggle listener; an unread badge counts inbound and the **inbound head flows** transiently on each `new_message`; badge click opens a read panel (marks read); hover shows a recent-peers popover. Fed by `GET /medusa/status` over the **existing** session-status poll — no new timer (`pollMedusa` called from `pollStatus`). Non-color a11y: state in the aria-label, count in the badge, an aria-live arrival announcement, the "!" glyph, and motion that self-suppresses under `prefers-reduced-motion`. (2) **Per-project auto-enable** — a `medusaEnabled` boolean (engine-agnostic, **default OFF**) validated/persisted/enriched in `lib/projects.js` (mirrors `versionBumpEnabled`), a Settings-modal pill in `public/ui.js`, and a shared `_maybeAutoStartMedusa` helper wired into **both** launch paths (tmux + Web UI) in `lib/sessions.js` so an opted-in project auto-starts its listener at session launch; the banner control stays the per-session override. (3) **Endpoints** (thin pass-throughs; browser never touches the Bridge): `POST /medusa/toggle` (`{enabled}` optional — idempotent, else flips; 409 when no active session), `GET /medusa/messages` (pure read), `POST /medusa/read` (marks read). **Design deviation from DECISION A (flagged for VRF):** the plan's `medusa_text.png` wordmark is 1536×1024 / 487 KB RGB (no alpha) — unshippable in a mobile-first banner and theme-clashing; used an accessible CSS text wordmark instead, and inlined the logo SVG rather than shipping a static asset (per-head recolor needs inline SVG anyway) — so no new `public/` asset and no `sw.js` STATIC_ASSETS add, but `CACHE_NAME` bumped to `-38` for the edited `session.*`/`ui.js`. **Tests:** `test/api-medusa.test.js` (+ toggle/messages/read routes, `_maybeAutoStartMedusa` on/off/never-throws), `test/projects.test.js` (+ `medusaEnabled` default/round-trip/reject-non-boolean), `test/medusa-control.test.js` (new — source-probes locking the `esc()` XSS guard on untrusted cross-session text + no-new-timer + first-render-seed invariants). Full suite 1986/0/1. **VRF:** visual change — operator eyeball (desktop + iPhone Safari) queued in `operator-verification.md`.

## 2026-07-10: Feat — Medusa listener core, the session switchboard's server-side spine (MED-2K9P Chunk 01)

<!-- prawduct: type=feat | chunks=01 | scope=med-2k9p | status=shipped -->

**Why:** MED-2K9P Chunk 01 (build plan `.prawduct/artifacts/build-plan.md`) — the keystone of in-banner session-to-session comms ("the switchboard"), realizing the vision of replacing the tmux `send-keys` hack after a live Medusa v1.0.0-rc dogfood confirmed delivery works. Merged as PR #525 (main `49f8049`). **What:** a per-session **in-TC-server WebSocket client** (`lib/medusa-listener.js`) that registers a workspace against the Medusa Bridge, receives inbound messages (post-`registered` offline-queue drain + live pushes, both `new_message` envelopes), keeps presence fresh via `listener_heartbeat`, and exposes an observable state machine (`off`/`connecting`/`listening`/`error`) over a **bounded** in-memory inbox (most-recent 500) with capped-exponential-backoff reconnect; a `wsFactory` seam for tests. Plus `lib/medusa-registry.js` (mints/persists/reuses a stable `<slug>-<hex>` workspace id at `<project>/.tangleclaw/medusa/registry.json`, corrupt→empty) and `lib/medusa.js` (per-session lifecycle + status/inbox pass-throughs). Surfaced read-only via `GET /api/sessions/:project/medusa/status`. **No UI (Chunk 02).** Zero new deps (Node 22 built-in `WebSocket`). **verify-api findings (locked in `api-notes-medusa.md`):** the Bridge WS is on the HTTP port **+1** (`:3010`); WS-register + `POST /messages/direct` are **unauthenticated** (no `A2A_SECRET` on TC's path — dropped a planned deliverable); WS-only registration is not addressable offline (store-and-forward needs an HTTP register → Chunk 04). **Critic:** `final` → `verify-resolutions` → `cumulative` → `verify-resolutions` (chain), 0 blocking; the cumulative WARNING (unbounded inbox) resolved by the 500-cap. Independent PR review: 0 blocking/0 warning/3 notes. Trust model: trusted-local loopback. **Tests:** `test/medusa-listener.test.js` + `test/api-medusa.test.js` (+30); full suite 1970/0/1 @ b62ec1c.

## 2026-07-09: Chore — prune the injected config surface (global-rules + guides + TC's CLAUDE.md)

<!-- prawduct: type=chore | chunks=prune-injected-config | scope=config-injection-prune | status=shipped -->

**Why:** `/prawduct:janitor` finding + operator ask ("prune CLAUDE.md to something sensible"). The governance/API text TC injects into every project's config had accreted verbosity; TC's own CLAUDE.md was 423 lines. **What (operator-ratified: conservative concision, keep every rule; + drop plugin-duplicated methodology from TC's file):** concised the 4 git-tracked injection sources — `data/global-rules.md` 190→118 and `data/{porthub,shared-docs,session-memory}-guide.md` 154→100 (total 344→218) — **keeping every rule, rationale, and API endpoint**; also fixed em-dash mojibake (`_` → `—`) in global-rules. Verified nothing dropped: diff of `## `/`### ` headings + `**Rule:**` lines shows only prose-fold reformatting, the version-bump table is byte-identical, and all guide endpoints preserved. This trims the config injected into every non-plugin-governed project by ~126 lines. **TC's own CLAUDE.md is plugin-governed (`isPluginGoverned:true`) so TC never regenerates it** — hand-trimmed 423→248: Global Rules + guides mirrored to the concised sources, and ~73 lines of vendored Prawduct methodology (Methodology/Session-Playbook/Governance) that the plugin injects at session start collapsed to a one-line pointer. **Test-contract respected:** kept the `### Authentication` heading + `### Port Ranges Convention` heading in the guides (an engines.test.js guard that the service-token auth stays documented — the concision had folded auth into prose; restored the heading rather than change the test). Updated one obsolete `#212` precondition (`bundled global-rules.md > 10 KB` — now just under the old cap; the round-trip contract + the 256 KB upper-bound test are untouched). **Tests:** full suite 3939/0/1 (recorded post-commit); no rule/API/behavior lost.

## 2026-07-09: Chore — janitor quick-wins (dead code, reqUrl dedup + Host-header fix, Node guard, dead-scaffold delete)

<!-- prawduct: type=chore | chunks=janitor-quick-wins | scope=maintenance-sweep | status=shipped -->

**Why:** `/prawduct:janitor` survey (operator-approved scope: quick wins + CLAUDE.md prune). **What:** (1) **Fix** — `GET /api/ports` built its URL with `` `http://${req.headers.host}` `` — the lone call site of 16 that dropped the `|| 'localhost'` fallback the others carry, so a `Host`-less request threw `TypeError: Invalid URL` and crashed the handler. Consolidated all 16 `new URL(req.url, …)` sites into one `reqUrl(req)` helper (`server.js`, exported) that always applies the fallback, so it can't drift again; regression test in `test/server.test.js` (no-Host + Host-present). (2) Removed dead public export `git.isDirty` (`lib/git.js`; uncalled repo-wide — internal `_isDirty` retained). (3) Corrected stale `lib/wrap-pipeline.js` doc-comment (`wrapV2` has defaulted `true` since #196, not `false`). (4) Added a Node-22 startup guard in `server.js` (clear abort before the `node:sqlite` load). (5) Deleted tracked dead `tests/conftest.py` (Python/pytest scaffold in a zero-Python project — the entire `test/` vs `tests/` split). Also removed a local gitignored `docs/methodology-extractions/ondeck-v2.md` (not a repo change; noted for honesty). **Deferred to backlog** (out of janitor scope): FEATURES.md symbol-based pointers + stub cleanup (HIGH), `updateProject` refactor, session-status state model, legacy V1 wrap-path strip, CI, linter, test-depth, node:sqlite warning suppression, AUTH-2K9D loopback false-positive. **Tests:** full suite 1921/0/1; +2 `reqUrl` regression tests.

## 2026-07-08: Feat — prune session-rule version history to newest 200 per rule (SR-5T1J)

<!-- prawduct: type=feat | chunks=SR-5T1J | scope=session-rule-version-pruning | status=shipped -->

**Why:** backlog SR-5T1J (D1b cumulative Critic NOTE, deferred from tc-4.0). `session_rule_versions` appended a full snapshot on every mutation (`_snapshotSessionRule`) and never removed one, so the table grew without bound. Harmless for a single operator, but the self-improvement loop's autonomous edits (`createdBy:'ai'`, incl. the CC-6 wrap-rule self-critique sink) are exactly the high-edit-volume trigger the Critic named — a single frequently-edited rule could accrue arbitrarily many versions. **What:** keep the newest `N` versions per `rule_id`, pruned on write. `_snapshotSessionRule` now calls a new `_pruneSessionRuleVersions(ruleId, keep)` after each insert; `keep` defaults to a new module constant `SESSION_RULE_VERSION_RETENTION = 200` (a `_setSessionRuleVersionRetention` seam mirrors `_setBasePath`/`_setBundledGlobalRulesPath` for tests/embedders; both exported). The prune is a single indexed `DELETE ... WHERE rule_id=? AND version_no < (MIN of the newest N version_nos)` — amortized, no cron/wrap step. **Design (operator-ratified 2026-07-08):** keep-last-N over age-based because it bounds row count directly regardless of edit velocity (an age window leaves a fast-churning rule unbounded inside it); N=200 a fixed constant (no config-UI — proportional to a watch-item); `N<=0` disables pruning (full-audit opt-out). **Invariants preserved:** only versions older than the N-th newest (by `version_no`) are dropped, so every restore target in the window, the rule's current state, and a deleted rule's tombstone (`op='delete'`, its latest version) survive; `version_no` stays monotonic (`MAX+1`), and `restore` resolves by exact `version_no`, so pruning's gaps are invisible. **Accepted trade-off:** restoring past the window returns the same `NOT_FOUND` as any absent version (git/CHANGELOG/activity log remain the durable record beyond it). No schema change — pure write-path behavior. **Tests:** +7 in `test/session-rules.test.js` (default-200, exact-newest-N at N=3, monotonicity-after-prune, kept-vs-pruned restore incl. NOT_FOUND, tombstone preservation, per-rule isolation, N≤0 opt-out). Full suite 1920/0/1 @ 52193ce. Requirement doc `docs/session-rules-self-improvement.md` (new SR-5T1J section, out-of-scope line flipped to "now shipped").

## 2026-07-08: Refactor — dedup path-token matcher shared by continuity Map + features-toc (CON-8H3Z)

<!-- prawduct: type=refactor | chunks=CON-8H3Z | scope=shared-path-token-matcher | status=shipped -->

**Why:** backlog CON-8H3Z (CC-3 Critic NOTE): `lib/continuity.js` (`MAP_PATH_TOKEN_RE`) and `lib/wrap-steps/features-toc.js` (`PATH_TOKEN_RE`) carried a character-identical path-token regex whose extension allowlists had to stay in sync by hand — a type recognized by one but not the other would silently drift the continuity Map's file coverage from FEATURES.md's. **What:** extracted the pattern to `lib/path-tokens.js` — `makePathTokenRegex()` factory + a named `PATH_TOKEN_EXTENSIONS` allowlist. Both consumers now build their own module-scope instance from the shared source, so each keeps isolated `.lastIndex` iteration state (no shared-mutable-regex cross-talk — the reason a factory beats a single shared instance) while the allowlist lives in one place. **Behavior-preserving:** no existing assertion changed; the two thin extraction wrappers (continuity returns an array, features-toc a Set with a type guard) are untouched — only the pattern was centralized. **Tests:** new `test/path-tokens.test.js` — a byte-identical regression pin against the pre-dedup literal, fresh-instance/isolated-lastIndex, capture-group (`:42` line-ref excluded), loose-anchor extraction, and allowlist-membership (incl. `.py` correctly rejected). Suite 1919/0/1 @ 7b47831.

## 2026-07-08: Feat — dashboard warning for auth config-vs-live mismatch (AUTH-2K9D)

<!-- prawduct: type=feat | chunks=AUTH-2K9D | scope=auth-status-surfacing | status=shipped -->

**Why:** backlog AUTH-2K9D (Critic NOTE on AUTH-2 slice 2b, AUTH-3 folded in 2026-06-28): an operator can persist `authEnabled=true` and believe TC is access-controlled while the runtime enforces nothing, and the mismatch is silent. Two shapes — `authEnabled` in `direct` mode is settable-but-inert (only the Caddy cutover reads it; direct has no in-process gate — AUTH-2); `authEnabled` in `caddy` mode with `currentUser` null (e.g. a hand-edited live Caddyfile missing `header_up X-Auth-User`) is indistinguishable from a healthy gate (AUTH-3). On a Tailscale-reachable box that's a real exposure-vs-perception gap. **What:** new pure `authIdentity.resolveAuthStatus(headers, config)` → enum `off | live | configured-inert | configured-no-identity`, derived from `{authEnabled, ingressMode}` + the same trust-gated `resolveRequestUser` that yields `currentUser` (single source of truth; spoof-defense unchanged). `GET /api/server-info` returns it as an additive `authStatus` field (route now loads config once for both `currentUser` and `authStatus`). `public/landing.js` `loadServerInfo` renders an amber warning chip (`#authStatusWarning`, `role="status"`) next to the login chip on the two mismatch states, each naming the concrete remediation (run the cutover / fix `header_up`). **Surfacing only — never enforces** (direct mode is deliberately trusted-LAN, the gate is Caddy's job — ADR 0003/0004); state-driven + self-clearing (no dismiss, no timer, per the no-UI-timers rule); amber + text for a11y (not color-only). **Design fork resolved by operator:** dashboard indicator (not a Settings-modal line — runner-up, deferrable). **Tests:** `resolveAuthStatus` unit coverage incl. all four states + non-caddy defensiveness + null-tolerance + enum-closure (`test/auth-identity.test.js`), API wiring for all four states (`test/api-auth-identity.test.js`), frontend structural surface incl. a no-`setTimeout`/`setInterval` assertion on the render body (`test/auth-status-warning.test.js`). Requirement doc `docs/auth-status-surfacing.md`. **VRF:** dashboard chip is a visual change — queue an operator-verification pass on a caddy-mode box (or a direct-mode box with `authEnabled` forced) to eyeball the chip.

## 2026-07-08: Feat — Critic-gate provenance on session-rule version history (SR-7K2P)

<!-- prawduct: type=feat | chunks=SR-7K2P | scope=session-rules-critic-gate-provenance | status=shipped -->

**Why:** backlog SR-7K2P (discovery #505, 2026-07-08): the self-improvement loop's central safeguard — the in-session Critic gate on AI/autonomous session-rule edits — was only *inferable* (cross-reference `changed_by='ai'` on the version snapshot against the activity log and trust the procedure was followed). No explicit, durable proof lived on the edit itself, making the gate unauditable without detective work. The server can neither summon nor verify a Critic (it's an in-session AI capability), so the fix necessarily **records** the AI's apply-time attestation rather than enforcing it. **What:** new `critic_gate` column on `session_rule_versions` — a per-mutation enum `('passed'|'not-required'|'unknown')` (three distinct states a bare boolean can't separate: attested-pass / legitimately-skipped / honestly-unknown). Schema v23→v24: fresh-DB DDL carries the CHECK; a table-rebuild migration (SQLite can't `ALTER TABLE ADD CHECK`) mirrors the shipped SR-3MW8 (#504) rebuild — explicit `BEGIN/COMMIT`, `ROLLBACK` on failure, `sqlite_master` DDL postcondition that refuses to advance `schema_version` on a botched rebuild — backfilling every existing row to `unknown` (never a presumed `passed`). Writer (`_snapshotSessionRule`) derives honestly from THIS change's author when unattested (operator→`not-required`, AI→`unknown`), keyed off `changed_by` not the rule's origin; `_validateCriticGate` rejects an out-of-enum value before any mutation (so a bad value never orphans a rule without its snapshot). The four apply-path APIs (`POST /api/session-rules`, `PUT /api/session-rules/:id`, `POST /api/session-rules/promote`, `POST /api/session-rules/:id/restore`) accept optional `criticGate` (400 on bad value); `GET /api/session-rules/:id/versions` returns it; the version-history UI shows a per-version badge (`✓ Critic-reviewed` / `— not required` / `? unknown`, text+color for a11y). **Verified:** full suite green (3907/0/1) AND migration + API round-trip against a **copy of the live production DB** — real 2 existing rows backfilled to `unknown`, 23→24, per-change derivation correct, bad-value 400. **Tests:** store derivation + per-change author keying + promote defaults + validation-writes-nothing + fresh-DB CHECK (`test/session-rules.test.js`), v23→v24 migration with row-preservation + backfill + enforcement (same file), all four API paths + enum 400s (`test/api-session-rules-selfimprove.test.js`), UI badge + CSS (`test/session-rules-panel.test.js`); schema-version assertions across seven test files bumped to 24. Docs section in `docs/session-rules-self-improvement.md` flipped requirement→built.

## 2026-07-07: Fix — install ttyd attach script outside TCC-protected ~/Documents (#500)

<!-- prawduct: type=fix | chunks=500 | scope=ttyd-attach-non-tcc-path | status=shipped -->

**Why:** incident 2026-07-06 (Cursatory) — the v4.5.0 update restarted ttyd and every session pane black-screened (new + reopened). macOS TCC blocked ttyd (denied FDA) from reading its per-connection attach script `deploy/ttyd-attach.sh` under `~/Documents`; the attach child froze in `open()`, WS upgraded 101 but zero output frames flowed. Server/Caddy/tmux all healthy; restarts didn't help. The plist comment had reasoned the script was TCC-safe "because it is a ttyd arg, not the launchd program" — but ttyd's per-connection `open()` is a separate TCC path the exit-126 bash-inline hardening never covered. Operator hand-fixed live (copied script to `~/.tangleclaw/deploy/`, re-pointed the plist). **What:** new `lib/ttyd-attach.js` — `attachScriptPath(home)` (canonical `~/.tangleclaw/deploy/ttyd-attach.sh`) + `syncAttachScript({repoDir,home})` (idempotent copy, refresh-on-sha-diff, asserts 0755, non-throwing). Plist template `__REPO_DIR__/deploy/ttyd-attach.sh` → `__TTYD_ATTACH__` (+ corrected the wrong-reasoning comment). `install.sh` copies the script to the non-TCC dir and fills `__TTYD_ATTACH__`; `ingress-cutover.js` fills both ttyd sites with `attachScriptPath(home)` and syncs before reloading ttyd (apply path only, not dry-run); `server.js` boot syncs unconditionally (so an update's restart refreshes the copy — the "don't drift" ask). Mirrors #463 Caddyfile boot-adoption: repo now generates exactly the operator's hand-fix. **Verified:** unit + generated-plist + install.sh-structural tests, `bash -n` clean, AND live — the boot sync run against real repo+home returns `up-to-date` and leaves the operator's copy (sha 55bec25a, 755) untouched, proving convergence-not-clobber. **Deferred:** a full live `install.sh` run → **VRF-500-ttyd-attach-install** (running install.sh on Cursatory now would regenerate the plist and re-break sessions — see auto-memory `project_ttyd_tcc_attach_script`, self-deleting once this ships + installs). **Tests:** new `test/ttyd-attach-sync.test.js` (+8, incl. an ENOTDIR error-branch fault injection) + updated pins in `test/ttyd-plist.test.js` (the `__TTYD_ATTACH__` contract + install.sh copy/substitution asserts) and `test/ingress-cutover.test.js` (non-TCC path asserted, repo-path regression-guarded both ingress modes). Suite 1889/0/1.

## 2026-07-07: Fix — wizard Admin Login live rule hint (#498, AUTH-7P3M)

<!-- prawduct: type=fix | chunks=498 | scope=auth-7p3m-admin-live-hint | status=shipped -->

**Why:** backlog AUTH-7P3M (operator-hit during the 2026-06-26 elkaholic AUTH-2 HITL smoke): the Admin Login step's Next button disables correctly on an invalid password but gives zero feedback — `setupAdminError` only populates in `wizardAdminNext()`, unreachable while disabled; the operator sat stuck on an 11-char password. **What:** rules extracted to pure `_adminRuleHint(user, password, confirm)` returning the FIRST unmet rule's message in gate order (username → 12-char min → mismatch → contains-username) or null; `_adminCanAdvance` delegates (`hint === null`), a new `#setupAdminLiveHint` div (role=status, `.form-error` styling, distinct from the role=alert server-error div) updates in `sync()` on every input plus once on render (back-navigation repopulates fields without input events), pristine-suppressed until any field has content; `wizardAdminNext`'s error path drops its two hardcoded messages for the same source. One rule set, three surfaces — the gate and its explanations structurally can't drift (symmetric-gates pattern, third application today). No CACHE_NAME bump (`setup.js` is network-first, not precached — verified against `STATIC_ASSETS`). **Tests:** `test/auth2-wizard-admin.test.js` +6 via the existing vm-sandbox harness (exact messages, first-unmet precedence incl. the 11-char repro, property-style gate⇔hint equivalence over 5 cases, pristine suppression + show/clear transitions, error-path parity, structural sync-wiring pin). **VRF:** VRF-auth-7p3m-admin-hint queued (visual change; wizard only reachable on a fresh/reset install, so live pass rides the next elkaholic wizard run).

## 2026-07-07: Chore — reconcile Chunk R box: repo rename shipped via #183 (retroactive)

<!-- prawduct: type=chore | chunks=R | scope=tc-4.0 | status=shipped -->

**Why:** Chunk R (repo rename TangleClaw-v3 → TangleClaw, #183) is the tc-4.0 plan's last unchecked box, but the issue CLOSED and the rename shipped around 2026-07-03 (this repo IS TangleClaw; the #485 entry already referenced the "stale pre-#183 repo name") — before `.prawduct/change-log.md` was git-tracked and before the work carried view tags, so the derived Status view could never flip it. Every session briefing since has offered closed work as "Resume: Chunk R" — the exact stale-plan failure mode the 2026-05-23 lesson warns about. **What:** this retroactive tagged entry lets `regen-views` flip the box; no code change. The known remnant (the `TangleClaw-v3 → TangleClaw` compat symlink plus old processes still referencing the `-v3` path) stays a deliberately-deferred cleanup thread in auto-memory — removing it while live processes hold the old path would break them, and it is not part of #183's shipped scope.

## 2026-07-06: Fix — injected API base URL scheme matches what the server serves (#496, ENG-5R2W)

<!-- prawduct: type=fix | chunks=496 | scope=eng-5r2w-base-url-scheme | status=shipped -->

**Why:** backlog ENG-5R2W (builder-filed same day, off a live failure: the CAD-7X4V restart POST silently no-oped against the injected `https://localhost:3102` while the stale server kept running — cursatory serves plain HTTP behind caddy). `lib/engines.js:_getRulesContent` and `lib/master.js:buildMasterClaudeMd` derived the scheme from `httpsEnabled` alone; boot's predicate is `caddyMode ? http : attempt-https-with-cert-fallback`, and `httpsEnabled` defaults TRUE — so caddy-mode AND no-cert installs both advertised an https URL nothing served. **What:** new shared pure predicate `effectiveServerProtocol(config)` in `lib/https-setup.js` (caddy override + the `willServeHttps` conjunction from server.js:992; JSDoc documents why boot keeps its own attempt-then-fallback + warn semantics and that an unreadable-cert file remains a runtime-only fallback invisible to a static predicate); both generators consume it. Static `data/porthub-guide.md` prose de-staled (was "HTTPS is the default"; now "use the injected URL as-is"). Same asymmetric-gate class as the symmetric-capability-gates learning — fix = one predicate, not two patched copies (the pattern CAD-7X4V shipped hours earlier). **Contract revision, declared:** `test/master.test.js`'s https fixture pinned the buggy flag-only derivation; re-pinned to the served-protocol contract (fixture gains cert paths, + caddy and no-cert cases) — strengthened, not weakened. **Tests:** +5 across `https-setup`/`master`/`engines` suites (pure-predicate unit coverage; injected-line assertions, not whole-content greps — the static guide prose legitimately mentions https URLs as documentation). **Not changed (flagged):** server.js:992's `willServeHttps` restart-decision predicate ignores ingressMode — in caddy mode an httpsEnabled toggle schedules a harmless-but-unnecessary rebind restart; separate concern, left for AUTH-2K9D-adjacent work.

## 2026-07-06: Refactor — shared adoption-computation core for caddy real + dry-run paths (#494, CAD-7X4V)

<!-- prawduct: type=refactor | chunks=494 | scope=caddy-adoption-helper | status=shipped -->

**Why:** backlog CAD-7X4V (PR-reviewer-filed on #476): `applyDryRunAdoptionPreview` (`scripts/ingress-cutover.js`) hand-mirrored the 3 adoption concerns of `adoptCredentialIntoConfig` (`lib/caddy.js`) — the dry-run/real divergence this invites was itself the Critic-caught bug on #476, and each future adoption shape adds another mirror obligation. **What:** pure `caddy.computeCaddyfileAdoption(config, content)` extracted as the single core (in-memory mutation, full `{adopted, changed, user, remoteHttp, tailnetHost, reason}` return incl. the pre-#434 `remoteHttp`-reflects-the-file contract); `adoptCredentialIntoConfig` keeps mode gate + file read + persist/log; `applyDryRunAdoptionPreview` keeps its exported signature (null-text guard + boolean return) but delegates. Behavior-preserving: zero existing assertions touched. **Tests:** `test/auth-credential-durability.test.js` +5 — direct helper coverage (result shape, never-overwrite + no-op reasons, idempotence, publicDomain exclusion) + an anti-drift structural pin (cutover script must reference `computeCaddyfileAdoption` and must NOT reference the three concern extractors — the #476 bug class cannot silently return).

## 2026-07-06: Feat — Bridge Port row on the OpenClaw connection card (#491, OUI-4T9M)

<!-- prawduct: type=feat | chunks=491 | scope=openclaw-ui-bridge-card-row | status=shipped -->

**Why:** backlog OUI-4T9M (operator-surfaced during the VRF-489-bridge-auto smoke test): the card's detail grid omits the bridge port entirely, so a #490 auto-allocated port was Edit-modal-only — the operator couldn't confirm allocation from the card. **What:** conditional **Bridge Port** row in `renderOpenclawConnections` (between Local Port and Version, tooltip → Edit affordance), gated on `conn.bridgePort` so bridge-less connections (#160 null default) render no row. `CACHE_NAME` v3-36→v3-37 (ui.js precached); exact-pin ownership → new test, `bridge-port-input.test.js` converts to floor per convention. **Tests:** new `test/openclaw-bridge-port-row.test.js` (+4 structural: gating, placement, tooltip, bump).

## 2026-07-04: Feat — Bridge Port `auto` UI affordance on the connection form (#489, OUI-2F8K)

<!-- prawduct: type=feat | chunks=489 | scope=openclaw-ui-bridge-auto | status=shipped -->

**Why:** backlog OUI-2F8K (Critic-filed on the #352 pass): the API accepts `bridgePort:"auto"` (#352 create, #483 idempotent PUT) but the form field was `type="number"` blank=null-only — no UI path to auto-allocation. **What:** field → text input (`inputmode="numeric"`) accepting blank / port number / `auto` (case-insensitive, normalized to the server's exact `=== 'auto'` literal), plus an **Auto** fill-in button (Detect-row layout, rule generalized `#ocDetectBtn`→`.btn`). Parsing extracted to pure `tcParseBridgePort` in `api-helper.js` (UI-9J3F pattern): typos/out-of-range **reject with a form error pre-request** instead of coercing to null — silent null on edit would clear the stored port + release its lease (#483). Inert `value="3201"` removed (#160 comment/HTML contradiction); `docs/openclaw-setup.md` documents `auto`. `CACHE_NAME` v3-35→v3-36; the drawer test's exact pin converts to the floor pattern (convention: newest bump owns the exact pin). **Tests:** new `test/bridge-port-input.test.js` (+21: behavioral parser + structural form/wiring/propagation).

## 2026-07-04: Fix — PUT /api/openclaw/connections/:id reconciles PortHub leases on port change (#483)

<!-- prawduct: type=fix | chunks=483 | scope=porthub-483-put-lease | status=shipped -->

**Why:** backlog PH-4B7N (Critic-filed on the #352 pass): the create path leases `local_port`/`bridge_port` under `oc-direct-<id>` and DELETE releases them, but a port change via PUT left the old lease held forever and the new port unleased — reopening the #352 allocate→bind race for edited connections. **What:** PUT now mirrors the create/delete lease lifecycle — early 404 on unknown id, conflict-check for a *changed* `bridgePort` (parity with POST; previously unchecked), idempotent `bridgePort:"auto"` support (keeps an existing bridge port, allocates from `[3201,3300)` only when bridge-less; previously the literal string `"auto"` hit the DB), and on any actual port change: `tunnel.killTunnel('oc-direct-<id>')` (the standalone tunnel was still bound to the old port while the record + HTTP/WS proxy pointed at the new one), release stale lease(s), re-lease current ports. Non-port edits touch nothing. **Tests:** `test/api-openclaw.test.js` +8 (6 fail without the fix; 2 pin pre-existing contracts). Suite 3836/0/1. **Governance:** Critic verify-resolutions chain-extend 0B/0W/0N on the CRT-4J8W anchor.

## 2026-07-04: Chunk 2 — adopt the tailnet HTTPS host into config so cutover preserves remote access (#434)

<!-- prawduct: type=feat | chunks=434-2 | scope=caddy-434-tailnet-https | status=shipped -->

**Why:** completes #434 — Chunk 1 (PR #474, shipped in 4.2.1; change-log entry missed last session, noted here) made the generator *capable* of the tailnet HTTPS site + http→https redirect, but nothing carried the host into config, so a cutover would still have dropped the 2026-07-04 hand-edit and remote OpenClaw access with it. **What:** new config default `caddyTailnetHost: null` (`lib/store.js`); new extractor `caddy.extractTailnetHost(content)` — top-level bare-FQDN site block carrying a `tls` directive (distinguishes the tailnet site from the ACME public-domain block, which has none); null on absent/ambiguous (never guess, mirroring `extractBasicAuthCredential`); `adoptCredentialIntoConfig` adopts the host at boot/cutover and `scripts/ingress-cutover.js` passes `tailnetHost` to the generator. **Design deviation (build-plan Decision 7 amendment):** shape adoption DECOUPLED from credential adoption — an exact `caddyRemoteHttp` mirror hides behind the `config-already-has-credential` early return, and live cursatory already adopted its credential (#463), so the host would have been orphaned forever. Shapes adopt independently, never overwrite set fields, skip a host equal to `publicDomain`; new `changed` return field (any adoption persisted) alongside the unchanged `adopted`; cutover refreshes config off `changed`; dry-run preview mirrors the decoupling (one preview test re-pinned + strengthened). **Verified:** extractors run read-only against the REAL live cursatory Caddyfile — host, catch-all, credential all extracted correctly. **Tests:** `test/auth-credential-durability.test.js` net +14; suite 3773/0/1. **Governance:** Critic chunk 0B/0W/0N + cumulative 0B/0W/0N. Live file stays hand-edited/load-bearing — cutover on cursatory remains a separately-VRF'd operator step (elkaholic first).

## 2026-07-03: UI-9J3F — terminal-gesture math → pure functions + behavioral unit tests

<!-- prawduct: type=refactor | chunks=G | scope=tc-4.0 | status=shipped -->

**Why:** backlog UI-9J3F (Critic-filed on #443/#445): the touch-scroll quantization and selection math had only regex-on-source coverage — catches deletion, not an off-by-one; the operator's on-device smoke (2026-07-03, post-G-slice-3) verified behavior the suite couldn't prove. **What:** three pure functions in `public/api-helper.js`, wiring delegates (behavior-preserving): `tcQuantizeScrollDelta` (line quantization + remainder carry), `tcCellFromPoint` (clamp + viewportY buffer-row mapping), `tcSelectionSpan` (anchor swap + endpoint-inclusive length). New `test/terminal-math.test.js` (18 behavioral incl. multi-hop remainder round-trip). **Caught in the act:** `Math.trunc` → `-0` on sub-line upward totals — behaviorally inert inline, normalized (`|| 0`) at the API boundary; exactly the class of wart regex coverage can't see. Structural pins re-pointed (`term.select(span…)`, swap/length at the pure home) + delegation pins added, never weakened. No CACHE_NAME bump (api-helper is network-first; precached ui.js untouched). **Governance:** refactor type → behavior preservation; Critic (cumulative) gates the PR.

## 2026-07-03: Chunk G slice 3 (final) — in-session Master drawer + shared terminal-frame pipeline (#331, UI-4C7R)

<!-- prawduct: type=feat | chunks=G | scope=tc-4.0 | status=shipped -->

**Why:** completes chunk G — D7's "reach it without leaving a session" had no surface (the master was landing-page-only), and the terminal wiring was about to triplicate (the per-page copies are what let #443's dead shim ship twice). **What:** (1) **drawer** — session-banner **🧠** button opens a bottom drawer (peek pattern: backdrop, handle, 60vh iframe) with the identical ensure-then-attach contract as the pane (POST `/api/master/ensure` → status dot pending→live/down → src only on success; `api.lastError` + Retry; re-entrancy + attach-once guards; close persists; **no polling**); (2) **UI-4C7R in full** — `TC_XTERM_THEMES` + `tcApplyTerminalTheme` + `tcEnableLocalSelectionOverride` (#431, moved verbatim) + **`tcWireTerminalFrame(win, frame, getTheme)`** in `public/api-helper.js`: ONE readiness-retry pipeline (theme + #431 + #443 + #445) for all three terminal surfaces; session.js/ui.js palettes + retry loops deleted; live theme switch repaints the drawer too. `CACHE_NAME` v3-34→v3-35. **Docs:** ADR 0008 (master session model + instructional read-only boundary, enforcement→G2); `operational-spec.md` master singleton; `data-model.md` design decision #7 (no DB footprint). **Tests:** new `test/master-drawer-frontend.test.js` (structural) + `test/terminal-frame-wiring.test.js` (behavioral — api-helper binds to globalThis under Node: palette fallback, retry cadence + bounded budget, cross-origin survival, mouseup-copy gating); #431/#443/#445 suites re-pinned at the new home (guards moved, never weakened). Suite **1797/0/1**. **Governance:** Critic (cumulative — cumulative-final) 0B/0W/1N (note verified already-resolved: UI-4C7R was archived `status=shipped` pre-review). VRFs consolidated → `VRF-g-master` (pane + drawer + copy/scroll parity + post-refactor session-terminal regression). Backlog UI-4C7R shipped/archived; UI-9J3F remains the follow-up. Also landed en route: PR #447 merged the previous session's dangling wrap branch (v3.31.0 promote) so this slice's CHANGELOG entry nests in a fresh `[Unreleased]`. The G Status box flips `[x]` at the next release-promote. Spec: `.prawduct/artifacts/g-project-master.md`.

## 2026-07-02: Plain-drag terminal copy → client clipboard + long-press mobile selection (#445)

<!-- prawduct: type=feat | chunks=G | scope=tc-4.0 | status=shipped -->

**Why:** operator requirement post-#432 VRF — Option+drag verified working remotely but "a non standard way to do things"; touch devices had NO selection path; "most tc users will be remotely connecting… i just want it to work like it used to." **What:** shared `tcWireTerminalDragCopy(win, term, doc)` in `public/api-helper.js`, wired on both surfaces. Desktop: capture-phase rewriter funnels plain drags into the verified #432 force-selection pipeline (both modifiers set — xterm's own platform check picks; `altClickMovesCursor` off; `buttons===0` disarm; 1s ghost-mouse window post-touch). Touch: long-press → finger→cell math → `term.select()` direct, release → native-style Copy pill whose CLICK does the write (`tcCopyToClipboard` gained `targetDoc` — Safari scopes gesture permission per-frame). **Design pivot recorded:** issue #445's `/api/host-clipboard` bridge NOT built — pure client-side, no new API surface, no host-clipboard exposure. **7 on-device iterations** (iPhone Safari + elkaholic Chrome, operator-verified end-to-end): alt-only modifiers dead on iOS (xterm classifies iOS non-Mac) → synthetic-mouse touch path dead → execCommand needs focused textarea → parent-doc writes refused (frame-scoped gestures) → ghost mice clobbered the copy → pill click wins. **Trade-off (deliberate):** plain clicks/drags no longer reach the TUI while it tracks the mouse — selection wins. `CACHE_NAME` v3-33→v3-34. **Tests:** new `test/terminal-drag-copy.test.js` (21 structural). Critic (chunk, mid-flight) 0B/3W→all fixed (evidence re-run, phantom-selection guard, CHANGELOG)/2N (both captured in CHANGELOG design note).

## 2026-07-02: Fix — terminal touch-scroll dead on iOS, both surfaces (#443)

<!-- prawduct: type=fix | chunks=G | scope=tc-4.0 | status=shipped -->

**Why:** `VRF-g2-master-pane` check 6 failed on-device — one-finger drag scrolled the browser page, never the terminal; the operator's control test showed the SESSION page fails identically, so slice 2 had faithfully duplicated a pre-existing dead shim (no "pre-existing" exception → root-caused + fixed). **Root causes:** (1) listeners on `.xterm-viewport` while touches land on `.xterm-screen` (paints above it); (2) `{ passive: true }` listeners can't stop iOS's native pan claiming the gesture. **What:** shared `tcWireTerminalTouchScroll(win, term, doc)` in `public/api-helper.js` — `.xterm-screen` target chain, non-passive `touchmove` + `preventDefault()`, `touch-action: none` injection, drag → **synthetic wheel events** in line-sized batches (the desktop pipeline: tmux `mouse on` routes the wheel to server-side copy-mode scrollback; iteration 1's `term.scrollLines` local-buffer poke moved nothing on-device), pinch-zoom untouched (single-touch guard precedes preventDefault), idempotent per iframe doc. Both call sites delegate (session.js wires from the readiness retry — the old shim also raced xterm init at load; ui.js drops `wireMasterTouchScroll`). Partially delivers UI-4C7R (touch-scroll now shared; theme+copy-override extraction stays slice-3). `CACHE_NAME` v3-32→v3-33. **Tests:** new `test/terminal-touch-scroll.test.js` (11) + re-pointed master-pane guards. **Verification:** on-device iPhone Safari (operator, 2026-07-02) — scrolling confirmed; the mid-iteration "page won't load" was the phone's SW wedged across two same-day cache bumps (cleared via Safari Website Data), not code. **Ops note for same-day double bumps:** iOS Safari can wedge mid-SW-upgrade; remedy = private-tab discriminator, then clear site data.

## 2026-07-02: Chunk G slice 2 — landing-page Master pane (#331)

<!-- prawduct: type=feat | chunks=G | scope=tc-4.0 | status=shipped -->

**Why:** slice 1's master session had no UI surface — the operator had to `curl` + `tmux attach` by hand. **What:** landing-header **🧠 Master** button + collapsible `#masterPanel` embedding the verified ttyd terminal stack as an iframe onto the reserved `tangleclaw-master` session — the Claude Code TUI IS the chat UI (no new chat transport). **Ensure-then-attach:** open → `POST /api/master/ensure` (idempotent; refreshes the master's CLAUDE.md identity) → iframe src set ONLY on success (ttyd is attach-only); failure surfaces the real `api.lastError` + Retry. Status dot (live/pending/down) on button + panel; one-shot `GET /api/master/status` probe at load — **no polling** (no-UI-timers #98/#268; a no-`setInterval` test guards it). Terminal parity with the session page: theme injection + the #431 ⌥+drag local-selection override + the mobile touch-scroll shim (cumulative-Critic WARNING — the shim was initially dropped; iPhone Safari is the primary platform), duplicated thin per the spec (slice 3's drawer reuses session.js's originals natively; extraction of a shared helper is backlogged per Critic NOTE). `sw.js` CACHE_NAME v3-31→v3-32; no new script file (logic in precached `ui.js`). **Tests:** new `test/master-pane-frontend.test.js` (15 structural, upload-modal-frontend pattern: src-less iframe, ensure-before-attach ordering, re-entrancy guard, #431 override, touch-scroll shim, SW bump). Suite **3611/0/1**. **Governance:** Critic (chunk) 0B/0W/0N. **Visual change: yes** → `VRF-g2-master-pane` enqueued (incl. remote-device ⌥+drag copy — the recurring blind spot). The G Status box flips `[x]` only once slice 3 lands + the next release-promote. Spec: `.prawduct/artifacts/g-project-master.md`.

## 2026-07-01: Chunk G slice 1 — Project Master singleton + ensure/status API (#331)

<!-- prawduct: type=feat | chunks=G | scope=tc-4.0 | status=shipped -->

**Why:** opens chunk G (#331) — ONE persistent global read-only AI assistant above all projects. **What:** new `lib/master.js` (idempotent `ensureMasterSession` — home `~/.tangleclaw/master/`, CLAUDE.md-as-identity regenerated per ensure, reserved tmux `tangleclaw-master`, full refusal matrix incl. the no-bare-shell guard; `getMasterStatus` tmux-truth; NOT a sessions row — structural test) + `POST /api/master/ensure` / `GET /api/master/status` (outside the M2M-gated set). Operator decisions: dedicated home (never a repo clone), launch-on-first-open. v1 read-only boundary instructional (enforcement = G2). **Tests:** new `test/master.test.js` (13). Suite **3596/0/1**. Critic (chunk) 0B/1W/1N → both fixed in-branch. Live-verified (real ensure → Claude Code booted in the master home; survived a server restart). **Merged via PR #440 → `896e1f9`.** The G Status box flips `[x]` only once ALL slices (2: landing pane, 3: drawer+ADR) land + the next release-promote. Spec: `.prawduct/artifacts/g-project-master.md`.

## 2026-06-30: Project Map — shared-dir / doc-group membership (PIDX slice 2)

<!-- prawduct: type=feat | chunks=PIDX | scope=tc-4.0 | status=shipped -->

**Why:** delivers the #356 half of PIDX — the agent should not filesystem-hunt for which shared directories / doc groups a project belongs to (TC already holds this). Slice 1 seeded a placeholder; slice 2 populates it from real data. **What:** (1) new pure `_buildSharedDirsSection(groups)` in `lib/projects.js` renders the membership markdown — each group `- **<name>** → \`<absolute sharedDir>\`` with registered docs nested beneath, and honest fallbacks ("not a member of any shared-doc group" / "_(no shared directory)_" / "_(no docs registered)_"); (2) `_collectProjectGroups(projectId, deps={})` reads `store.projectGroups.getByProject` + `store.sharedDocs.getByGroup` into that shape (store injectable for testing; non-throwing → `[]`); (3) `_buildProjectMapContent(projectPath, groups=[])` + `_seedProjectMapFile(projectPath, groups=[])` gained an **optional** `groups` param — deliberately additive so the slice-1 structure-only callers + tests keep working unchanged (no signature break); (4) `updateProject` seed-on-toggle now collects + passes the membership. The membership is a **point-in-time snapshot** at toggle-on; keeping it current as membership changes is the slice-3 freshness wrap-step. **#356 secondary (on-launch sync) — VERIFIED, not fixed:** the Explore + a new regression test confirm the pre-existing launch-time `syncFromDirectory` re-scan (`lib/sessions.js:215-225`) already registers newly-added `.md` files — so the reported "TANGLEBRAIN.md didn't register" symptom does not reproduce in current code (its original cause was likely a pre-wiring state or an unset `sharedDir`). The regression pins it: register doc A → add doc B to the same dir → re-sync registers B and skips A. **Out of scope:** the freshness wrap-step (slice 3); two-levels-deep curation. **Tests:** `+7` `test/project-map.test.js` + `+1` `test/store-shareddocs.test.js` (#356 incremental re-scan). Suite **3534 pass / 0 fail / 1 skip**. **Governance:** Critic (chunk). On merge `status=merged`; PIDX Status box flips `[x]` only once slice 3 lands + the next release-promote. Spec: `.prawduct/artifacts/pidx-project-map.md`.

## 2026-06-29: Project Map index — "where things live" (PIDX slice 1)

<!-- prawduct: type=feat | chunks=PIDX | scope=tc-4.0 | status=shipped -->

**Why:** opens the PIDX "project index" work (#360, #356) — the agent currently HUNTS for where things live (Explore fan-out, `find`, grep). A structural "go here first" map cuts that. **Architecture (operator-chosen 2026-06-29):** a NEW additive `PROJECT-MAP.md` mirroring the shipped FEATURES.md (#207) machinery — own toggle, seed-on-toggle, prime hook; FEATURES.md + its `features-toc` wrap step left UNTOUCHED. Unifying the three index-ish artifacts (FEATURES.md=features→paths, this=structure, #356=shared-dir membership) is deferred + documented, not done (would rework shipped #207 for cohesion gain not worth the mid-4.0 risk). **What (slice 1 = thin vertical slice — toggle + seed + prime pointer):** (1) `projectMapEnabled` default-false toggle in `DEFAULT_PROJECT_CONFIG` (`lib/store.js`), engine-agnostic; (2) `lib/projects.js` — `_seedProjectMapFile` seeds `PROJECT-MAP.md` at the project root with an auto-generated top-level-directory skeleton (`_listTopLevelDirs` filters `node_modules`/`dist`/`build`/`coverage`/`.git`/leading-dot dirs; `_buildProjectMapContent` renders each dir a `- \`dir/\` — <!-- describe -->` stub + a placeholder Shared-directories section), idempotent (never overwrites curated content), branched in `updateProject` on `projectMapEnabled===true` + type-validated + surfaced on `enrichProject`; (3) `lib/sessions.js` — the SessionStart prime emits a **REFERENCE pointer** (a `## Project Map` section pointing at `PROJECT-MAP.md`, "Consult it FIRST …") NOT the inlined map body, gated by the same symmetric gate as the Feature Index (`projectMapEnabled && silentPrime && supportsSilentPrime`) and only when the file exists + non-empty; (4) `public/ui.js` `renderProjectMapToggle` + `settingsProjectMap` read-into-PATCH; `sw.js` `CACHE_NAME` v3-25→v3-26. **Key decision (Reasoned):** reference-not-inline differs from FEATURES.md (which inlines) — the map grows with the project, so echoing it every session wastes prime budget; its value is being the place you go look, so a pointer suffices (#360 point 3). **Out of scope (later slices):** shared-dir/doc-group membership population + the #356 on-launch-sync regression test (slice 2); the freshness wrap-step `lib/wrap-steps/project-map.js` (slice 3); FEATURES.md unification (deferred). **Tests:** `+15` `test/project-map.test.js` + `+4` `test/sessions.test.js` (prime pointer gate + reference-not-inline). Suite **3526 pass / 0 fail / 1 skip**. **Governance:** Critic (chunk). Visual change → `VRF-pidx-slice1-project-map` enqueued (operator live-test, not a blocker). On merge `status=merged`; the **PIDX Status box flips `[x]` only at the next release-promote** (and only once all slices land). Spec: `.prawduct/artifacts/pidx-project-map.md`.

## 2026-06-29: OpenAI-compat assertion — pin the guarantee (TB-4)

<!-- prawduct: type=feat | chunks=TB-4 | scope=tc-4.0 | status=shipped -->

**Why:** closes the TB orchestration-contract concern (#359) — makes "every orchestration-profile endpoint is OpenAI-compat" a **checked guarantee**, not a coincidence, so a future LangGraph endpoint (semantic-route, Monad #35) drops into the same profile mechanism unchanged and swapping a profile's `base_url` between two OpenAI-compat endpoints requires **no** harness change. **Contract pinned:** TC treats every profile endpoint as `POST {baseUrl}/chat/completions` and injects ONLY the three generic OpenAI knobs (`OPENAI_API_BASE`, `OPENAI_API_KEY` env + `--model` arg) — nothing engine-specific. TC never builds the chat-completions URL (the harness appends `/chat/completions` to `OPENAI_API_BASE`), so the invariant TC can enforce at resolve time is that the endpoint is a well-formed base URL. **What:** new pure `assertOpenAICompatEndpoint(baseUrl)` in `lib/orchestration.js` → `{ok:true}` | `{ok:false, reason}`, validating non-empty string + parseable absolute URL + `http(s)` scheme + host present. Wired into `resolveLaunchProfile` as a NEW refusal case (after the existing null-baseUrl "endpoint not yet landed" check, before the model check): a bound-but-non-compat endpoint **refuses to inject** (honest degradation, no silent fallback — identical pattern to every other TB-1 refusal), so every endpoint TC actually injects is OpenAI-compat by construction. Distinct from the null case (deliberately-not-landed/provisional) — this catches a misconfigured/non-compat endpoint. Added to `module.exports`. **Two deliberate decisions:** (1) the `/v1` suffix is the near-universal OpenAI-compat convention (LiteLLM, vLLM, OpenRouter) but is **NOT** hard-required — refusing on a missing `/v1` would false-reject a valid compat server mounted at a different base path; the validator enforces scheme + host (unambiguous brokenness) and treats the path leniently. (2) No new URL construction in TC — the "nothing engine-specific leaks" half of the guarantee is pinned by the engine-agnostic overlay (tested), so a `chatCompletionsUrl()` helper would be dead code (TC never POSTs the endpoint). **Out of scope:** the actual LangGraph semantic-route endpoint (Monad #35); runtime liveness probing of an endpoint's compat (`GET /v1/models`) — TC validates shape at resolve time, not liveness. **Tests:** `+9` `test/orchestration.test.js` — `assertOpenAICompatEndpoint` accept/refuse matrix (http/https/non-`/v1` base accepted; empty/whitespace/null/non-string/unparseable/non-http-scheme refused), the new resolve-time OpenAI-compat refusal distinct from the null-baseUrl refusal, and the acceptance (swapping `base_url` between two compat endpoints changes ONLY `OPENAI_API_BASE`; only the three generic knobs injected; no profile/engine-specific leak). Suite **3509 pass / 0 fail / 1 skip**. **Governance:** Critic (chunk) + cumulative PR gate. On merge `status=merged`; the **TB-4 Status box flips `[x]` only at the next release-promote**. Spec: `.prawduct/artifacts/tb-4-openai-compat-assertion.md`.

## 2026-06-29: escalation-signal recognizer stub (TB-3)

<!-- prawduct: type=feat | chunks=TB-3 | scope=tc-4.0 | status=shipped -->

**Why:** opens the TangleBrain escalation seam (#358) — how a local OpenAI-compatible endpoint says "this needs frontier" and how the harness/TC **recognizes** it. Wiring the recognizer now makes signal-up additive later, not a rewrite. Honors TangleBrain invariant #3: TC/Monad never broker the cloud call; the top orchestrator handles the cloud hop on its own OAuth. **Marker contract (agreed with Monad 2026-06-16):** a **namespaced top-level field** `tanglebrain` on the chat-completion response — deliberately **NOT** `finish_reason` (SDKs enum-validate that against `stop|length|tool_calls|content_filter|function_call`; a custom value breaks strict parsers). `finish_reason` stays valid; the marker (`{ escalate: true, reason, detail, suggested_tier }`) rides alongside, and standard OpenAI clients drop the unknown top-level key (parser-safe). Streaming: the same object on the terminal chunk before `data: [DONE]`. **What:** new pure `lib/escalation.js` — `recognizeEscalation(response)` (parsed response OR SSE chunk → normalized `{escalate:true, reason, detail, suggestedTier}` or `null`; **strict** `escalate === true`, snake_case `suggested_tier`→camelCase, **never throws** on malformed input — a recognizer that crashed the harness would be worse than one that declines); `recognizeEscalationFromSSELine(line)` (one raw `data: {…}` line → recognizer result; skips `[DONE]`, comments, non-`data:` lines, JSON parse errors → `null`; covers the "last chunk" path); `surfaceEscalation(escalation, context, deps)` the **hook** (logs the signal structured + non-blocking via injected `log`, returns `{surfaced, routed:false}`; `null` escalation is a no-op). `MARKER_KEY` exported so producer/consumer share one constant. **Three deliberate decisions:** (1) **recognizer stub only — no routing, no cloud call** (`routed` always `false`; signal-up replaces the no-op body later, seam + callers unchanged; a test asserts the module imports no HTTP client); (2) **no live call site by design** — nothing emits the marker today (LiteLLM proxies; emitter is the Layer-3 LangGraph classifier, Monad #35) and TC isn't in the chat-completion path, so wiring a call into a path that never carries the marker would be dead/misleading code — the exported recognizer IS the seam; (3) **pinned field name `tanglebrain`** (TC's choice; Monad #35 must match). **Future wiring point:** a LiteLLM callback or a TC-side response proxy composes `surfaceEscalation(recognizeEscalation(response), context)` with no change to this module. **Out of scope:** the emitter (Monad #35), the actual signal-up routing, TB-4 (#359). **Tests:** `+23` `test/escalation.test.js` (valid/declined markers, strict-true, snake_case normalization, never-throw totality on null/non-object/array, single-SSE-line recognition incl. no-space `data:`, the hook's log+no-route contract + null no-op, the object + SSE acceptance paths, structural no-HTTP-client guard). Suite **3500 pass / 0 fail / 1 skip**. **Governance:** Critic (chunk) + cumulative PR gate. On merge `status=merged`; the **TB-3 Status box flips `[x]` only at the next release-promote**. Spec: `.prawduct/artifacts/tb-3-escalation-recognizer.md`.

## 2026-06-29: key-ref hygiene — retire the master-key footgun (TB-2)

<!-- prawduct: type=feat | chunks=TB-2 | scope=tc-4.0 | status=shipped -->

**Why:** closes the TB key-hygiene concern (#189). The sanctioned way to give a harness a LiteLLM secret is an orchestration-profile `keyRef` (TB-1 laid `resolveKeyRef`) — TC stores a *reference*, resolves at launch, never writes the secret into a config. The footgun: a LiteLLM key (originally the unrestricted **master** key) pasted into an engine config's static `launch.env`, inherited by every session that launches that engine. **Discovery finding (reframed the chunk):** the one-time *swap* #189 describes was already effectively done on the live host (its `aider.json` `launch.env` is `{}`, and the bundled `direct` profile already references the scoped key minted Monad-side 2026-06-16). So TB-2 builds the durable guard against **recurrence**, not the swap. **What:** new pure `detectHardcodedKeys(engineProfile)` in `lib/orchestration.js` scans a **static, pre-overlay** engine config's `launch.env` and flags an entry when its value matches a LiteLLM key shape (`^sk-[A-Za-z0-9_-]{16,}$`) **or** its name is `LITELLM_MASTER_KEY` (non-empty) — returning **redacted** findings (`sk-ab…(redacted, N chars)`), never throwing, never blocking. Wired at the `lib/sessions.js#launchSession` seam (right after the base engine resolves, before the TB-1 overlay): each finding emits a redacted `log.warn` naming engine/envVar/remediation; the launch proceeds. **Three deliberate decisions (ADR 0006):** (1) detect *literals*, not "the master key value" — TC never holds the master key and doesn't need to, since any `sk-…` literal in a config is wrong when the sanctioned path is a keyRef; (2) scan **pre-overlay** so the legitimately-resolved scoped key (which `applyLaunchOverlay` injects into the launch env) is never flagged; (3) **warn, not refuse** — the operator owns their engine configs and a hard-block could brick a deliberate setup; the detector is exported so a future refuse mode / load-time call site reuses it. **Out of scope:** editing the operator-owned runtime `aider.json` or ssh-fetching the secret (operator action → `VRF-tb-2-scoped-key`); TC-side key minting (TC can't self-mint — Monad-gated); generalizing scoped keys to other engines. **Tests:** `+8` `test/orchestration.test.js` (master-shaped literal flagged + redacted with the raw secret absent from the finding; `LITELLM_MASTER_KEY` by name; empty/non-key/keyRef-style values clean; null/no-launch no-throw; sanctioned-path-silent-while-footgun-warns spanning all 3 acceptance criteria). Suite **3477 pass / 0 fail / 1 skip**. **Governance:** Critic + cumulative PR gate. On merge `status=shipped`; the **TB-2 Status box flips `[x]` only at the next release-promote**. `VRF-tb-2-scoped-key` enqueued (operator live-test, not a blocker). Spec: `.prawduct/artifacts/tb-2-key-ref-hygiene.md`; ADR 0006.

## 2026-06-29: launch-binder — per-project orchestration profiles (TB-1)

<!-- prawduct: type=feat | chunks=TB-1 | scope=tc-4.0 | status=shipped -->

**Why:** opens the TangleBrain orchestration seams (TB track). Today an engine's model + endpoint are hardcoded in the engine config (global to the engine); TB-1 makes them resolvable **per project** at launch so a project can point at a different OpenAI-compatible endpoint (LiteLLM `direct`, future `smart-fallback`/`semantic-route`) with no engine-config edit. **What:** (1) operator-owned flat config `~/.tangleclaw/orchestration-profiles.json` (seeded once from bundled `data/orchestration-profiles.json` via `_seedOrchestrationProfiles` — seed-if-missing, NOT canonical-overwrite, because operators edit endpoints + key refs) mapping each profile → `(baseUrl, model, keyRef)`; loader `store.orchestrationProfiles.load` (read-per-call like `engines.get`, so an operator edit is picked up at the next launch with no restart; degrades to empty on missing/malformed). (2) nullable `orchestration_profile` column on `projects` (schema **v21→v22**) = the per-project binding; `NULL` = unbound = zero injection (byte-identical to pre-TB-1). (3) new pure `lib/orchestration.js`: `resolveKeyRef` (`file:`/`env:` ref → secret at launch; TC stores only a reference — master-key retirement is TB-2/#189), `resolveLaunchProfile` (full triple or typed **refusal** for unknown/null-baseUrl/no-model/unresolvable-key — honest degradation, never a silent fallback), `applyLaunchOverlay` (clones the engine profile, appends `--model`, merges `OPENAI_API_BASE`/`OPENAI_API_KEY`; never mutates the shared cache). (4) one wiring seam in `lib/sessions.js#launchSession` — both the launch command and tmux env read the overlay; the secret rides in env, never the command line. Optional per-(project,profile) override `projConfig.orchestrationKeyRef`. **Out of scope:** TB-2 (scoped keys), TB-3 (escalation recognizer), TB-4 (OpenAI-compat pin); `smart-fallback`/`semantic-route` ship stored-but-provisional. **Tests:** `+24` `test/orchestration.test.js` + `+8` `test/orchestration-profiles-store.test.js`; updated 7 schema-version-pin fixtures v21→v22. Suite **3468 pass / 0 fail / 1 skip**. **Governance:** Critic + cumulative PR gate. On merge `status=shipped`; the **TB-1 Status box flips `[x]` only at the next release-promote**. `VRF-tb-1-launch-binder` enqueued (operator live-test, not a blocker). Spec: `.prawduct/artifacts/tb-1-launch-binder.md`.

## 2026-06-29: service-token docs + governance (AUTH-4 slice 4c — cumulative-final)

<!-- prawduct: type=docs | chunks=AUTH-4 | scope=tc-4.0 | status=shipped -->

**Why:** 4a built the gate and 4b made it usable; 4c is the doc/governance close-out that lands the design rationale in durable artifacts and enqueues the live acceptance — closing the AUTH track. **What (doc-only):** (1) **ADR 0005** (`docs/adr/0005-service-tokens.md`) — the six decision properties (single fleet token; default-off reversible; auto-generate + reveal/rotate, no wizard step; raw-at-rest + redacted; pathname-prefix predicate; management endpoints outside the gated set), consequences (enable ⇒ fleet re-acquires at next launch; fail-closed; honest single-tenant limit), and five alternatives considered. (2) **`SECURITY.md`** — a "Service Tokens — M2M API gate (AUTH-4)" subsection. (3) **`security-model.md`** — §2 "M2M Service Token" subsection + a §4 sensitive-data row (raw-at-rest rationale, redaction) + §1 threat-model line updated (per-user enforcement / token scopes now AUTH-5+, since AUTH-4 shipped the M2M token rather than per-user enforcement). (4) **`operational-spec.md`** — §2 M2M-gate paragraph + §3 config-field documentation. (5) **`data-model.md`** §2 — added `serviceTokenEnabled`/`serviceToken` to the config schema + field reference, and **closed a pre-existing drift**: the canonical config schema was missing the entire AUTH-1/2/3 ingress+auth field family (`ingressMode`, `caddyHttps/HttpPort`, `publicDomain`, `authEnabled`, `basicAuthUser`, `basicAuthHash`) — added concise rows pointing to operational-spec §3 / ADRs 0003–0004. (6) **`VRF-auth-4-service-token`** enqueued — consolidates the former `VRF-auth-4b-service-token-ui` (same live flow, promoted to chunk-level acceptance). **Governance:** `/prawduct:critic cumulative` is the PR gate (the AUTH-4 cumulative-final review). On merge, all three AUTH-4 slices are `status=shipped`; the **AUTH-4 Status box flips `[x]` only at the next release-promote** (4a/4b/4c → `shipped`). No code or test change → suite unchanged at **3436 pass / 0 fail / 1 skip**. Spec: `.prawduct/artifacts/auth-4-service-tokens.md`.

## 2026-06-29: service-token management + fleet reach (AUTH-4 slice 4b)

<!-- prawduct: type=feat | chunks=AUTH-4 | scope=tc-4.0 | status=shipped -->

**Why:** AUTH-4a shipped the gate but no way to see/rotate the fleet token and — critically — no way for the fleet to *present* it: with the gate on, every existing local caller would get `401` because nothing injects the token. 4b closes that loop so the gate is actually usable. **What:** (1) **Management endpoints** (`server.js`, operator-auth'd, deliberately OUTSIDE the M2M-gated path set so a service caller can't reveal/rotate its own credential): `GET /api/service-token` reveals the raw token (`404 NO_SERVICE_TOKEN` when the gate is off/unset — the redacted config API never carries it), `POST /api/service-token/rotate` issues+persists a new token and returns it (`409 SERVICE_TOKEN_DISABLED` when off). (2) **Fleet injection** (`lib/engines.js`): when the gate is on, every project's generated config (CLAUDE.md, Gemini, Codex YAML, aider) gets an Authentication block carrying the live `Authorization: Bearer <token>` header right after the API base URL — new `_serviceTokenAuthLines(rules, format)` helper (markdown + `#`-comment forms); when off it injects nothing, so the config is byte-for-byte what it was pre-AUTH-4 (the reversibility contract). `_getRulesContent` now surfaces `serviceTokenEnabled`/`serviceToken`. (3) **Settings UI** (`public/ui.js` + `style.css`): a "Service Token (M2M API)" panel in Global Settings — enable toggle (saved with the rest), and (when the saved gate is active) Reveal + Rotate buttons rendering the token into a monospace selectable field; rotate confirms first. `CACHE_NAME` `v3-24` → `v3-25`. (4) **Static guides** (`data/porthub-guide.md`, `data/shared-docs-guide.md`): an Authentication section documenting the bearer requirement and that TC injects the header per-session. (5) **Invariant centralization** (carried 4a Critic NOTE): the "enabled ⇒ token present" rule now lives once in `service-token.ensureTokenWhenEnabled(config)`, shared by the PATCH enable path and the rotate writer instead of being re-derived. **Visual change: yes** → `VRF` operator-verification entry enqueued. **Out of scope (4c):** ADR 0005 + SECURITY/security-model/operational-spec/data-model updates + `VRF-auth-4-service-token`; the `AUTH-4` Status box stays `[ ]` until 4c. **Tests:** `+5` `test/service-token.test.js` (`ensureTokenWhenEnabled` matrix), `+6` `test/api-service-token.test.js` (reveal/rotate over real HTTP incl. old-token-invalidated-after-rotate), `+5` `test/engines.test.js` (token surfaced only when enabled, all four configs carry the header, none when off, guide content). Full suite **3436 pass / 0 fail / 1 skip**. Spec: `.prawduct/artifacts/auth-4-service-tokens.md`.

## 2026-06-29: M2M service-token gate on PortHub + shared-docs (AUTH-4 slice 4a)

<!-- prawduct: type=feat | chunks=AUTH-4 | scope=tc-4.0 | status=shipped -->

**Why:** PortHub (`/api/ports*`) and shared-docs (`/api/shared-docs*` + a group's `/sync`) were reachable unauthenticated on the direct localhost listener — AUTH-2's Caddy `basic_auth` only gates REMOTE callers, and local fleet callers hit `localhost` directly, bypassing Caddy. AUTH-4a is the keystone slice: a TC-level bearer-token gate on exactly those surfaces, the part `basic_auth` structurally can't cover. **What:** new pure `lib/service-token.js` — `generateToken()` (`tcsk_` + 32 bytes base64url, zero-dep node `crypto`), `requiresServiceToken(pathname)` (a pathname-prefix predicate gating `/api/ports*`, `/api/shared-docs*`, `/api/groups/*/sync` — fail-safe for any future sub-route, chosen over a per-route flag to avoid editing 14 fragile registrations), and `validateRequest(headers, config)` (constant-time `crypto.timingSafeEqual`, fail-closed: gate-off allows, enabled-but-no-token → 500 `SERVICE_TOKEN_MISCONFIGURED`, missing/wrong → 401). Two `DEFAULT_CONFIG` fields — `serviceTokenEnabled` (master switch, **default off** so existing local callers keep working; opt-in + reversible) and `serviceToken` (raw fleet token, **redacted** from the config API as `serviceTokenConfigured`, **auto-generated on first enable**, not patchable). The gate runs once in the `handleRequest` dispatch (no-op until enabled → surfaces stay byte-for-byte open) and logs denials (method/path/code, never the token). **Out of scope (later slices):** reveal/rotate endpoints + Settings UI + per-session token injection (4b); ADR + security docs + VRF (4c). The `AUTH-4` Status box stays `[ ]` until 4c. **Tests:** new `test/service-token.test.js` (16) + `test/api-service-token.test.js` (10, real HTTP). Full suite **3421 pass / 0 fail / 1 skip**. Critic cumulative 0 BLOCKING / 0 WARNING / 3 NOTE (all deferred-by-design: 3rd-writer invariant centralization in 4b, forward-ref comments, gate-active observability); prior `final` 0B/2W(CHANGELOG + gate-denial logging → both fixed)/5N → verify-resolutions CLEAN. Spec: `.prawduct/artifacts/auth-4-service-tokens.md`.

## 2026-06-28: TC consumes the proxy-authenticated identity (AUTH-3)

<!-- prawduct: type=feat | chunks=AUTH-3 | scope=tc-4.0 | status=shipped -->

**Why:** AUTH-2 makes Caddy authenticate the operator, but TC never learned *who* logged in — no attribution, no identity surfaced. AUTH-3 closes the loop. **What:** the gated Caddyfile now forwards the authenticated username to TC — `lib/caddy.js` emits `header_up X-Auth-User {http.auth.user.id}` inside each gated `reverse_proxy` block (`{http.auth.user.id}` is set by `basic_auth` after a successful challenge; `header_up` uses **set** semantics so it overwrites any client-supplied value — a forged header can't reach the app through the proxy). A new pure **`lib/auth-identity.js` `resolveRequestUser(headers, config)`** is the trust gate: it honors `X-Auth-User` **only** when `ingressMode === 'caddy' && authEnabled` — in direct mode (no authenticating proxy) the header is ignored, so it can't be spoofed against TC's localhost listener; an ambiguous/duplicate or empty header fails closed. Two consumers route through that one gate: `GET /api/server-info` returns `currentUser` and the dashboard shows a **"👤 ⟨user⟩"** chip (hidden in direct mode, refreshed on the existing 60 s poll, username `esc()`-escaped); and the session-launch endpoint stamps the user into a new nullable **`sessions.owner`** column (schema **v20→v21**; NULL for every pre-AUTH-3 and direct-mode session — no backfill), threaded through both the tmux and webui launch paths and surfaced on the #347 `_toOwnership` object. **Attribution, not enforcement** — single operator, no per-user restriction (AUTH-4+). On a hand-edited live Caddyfile that TC doesn't regenerate, the operator adds the one `header_up` line by hand; until then `currentUser` is null (honest degradation, never a fabricated identity). Realizes the original AUTH-track "identity flow" decision (planned as an Authelia `Remote-User` header) on the shipped Path-A `basic_auth` gate. **Tests:** new `test/auth-identity.test.js` (9 — trust gate across live/direct/gate-off, missing/empty/whitespace, array fail-closed, null-safety), `test/api-auth-identity.test.js` (3 — `currentUser` over a real HTTP request), `+3` `test/caddy.test.js` (`header_up` gated local + both sites, none ungated), `+1` `test/session-ownership.test.js` (owner surfaced/null), `+1` `test/store.test.js` (v20→v21 `owner` migration on a real old-schema DB), and 6 schema-version pins moved 20→21. `header_up` syntax verified against **real caddy 2.11.4** (`Valid configuration`). Full suite **3395 pass / 0 fail / 1 skip**. Critic cumulative 0 BLOCKING / 1 WARNING (stale `data-model.md` sessions schema — fixed, synced all four drifted columns) / 3 NOTE (NOTE 3 folded into backlog AUTH-2K9D; 1–2 reflection-captured). **Out of scope:** per-user enforcement, OIDC/forward-auth, retroactive `owner` (AUTH-4+). Docs: ADR 0004 follow-on note, `SECURITY.md`, `security-model.md`, `operational-spec.md`, `data-model.md`; `VRF-auth-3-identity` enqueued. Spec: `.prawduct/artifacts/auth-3-proxy-identity.md`.

## 2026-06-27: Break-glass admin credential reset (AUTH-2 slice 3)

<!-- prawduct: type=feat | chunks=AUTH-2 | scope=tc-4.0 | status=shipped -->

**Why:** Slice 2b forces an admin credential at first run, which creates the lockout it must also cure — an operator who forgets the basic_auth password would have no recovery path. Slice 3 is the **no-permanent-lockout guarantee**: because the gate lives in Caddy on the operator's own Mac, recovery proves *physical control* (a terminal on the host), never a second remote door. **What:** new **`scripts/reset-admin.js`** resolves the admin user from the live Caddyfile (`--user <name>` disambiguates when more than one is present), prompts a new password (hidden, entered twice — or `--password-stdin` for scripting), validates it with the **same** slice-2b rules (`caddy.validateAdminPassword`: ≥12, weak-password denylist, no-username-match, no control chars), hashes via `caddy hash-password`, and **patches the credential line(s) in place** — it does **not** regenerate the Caddyfile, so a hand-edited live file (its remote block, snippet form, comments) is preserved, not clobbered. **Fail-closed:** the patched file is `caddy validate`d before the reload and a **timestamped `.bak`** is restored if the patch is invalid (extracted into `writeValidatedCaddyfile`, validation injected so the restore branch is unit-tested), so a recovery run can never itself break the ingress; on success it reloads Caddy (`launchctl kickstart`) and syncs the persisted `authEnabled`/`basicAuthUser`/`basicAuthHash` so a later cutover stays consistent. `--dry-run` previews the user + steps without touching anything. Two new pure `lib/caddy.js` primitives back it: **`replaceBasicAuthCredential`** (matches the credential *line* by its bcrypt-hash shape, so it patches both the generated inline gate and a hand-edited snippet alike; re-stamps the integrity header **only** when the input was already a generated file, so a hand-edited file is never silently converted into a cutover-clobberable one) and **`listBasicAuthUsers`**; the header format was factored into a shared `_makeHeaderLine` helper. **Docs:** machine-local `~/.tangleclaw/EMERGENCY-RECOVERY.md` gains a "§4.G — forgot/lost the admin password" section (script primary + manual fallback), and `deploy/INGRESS.md` documents the path for fresh clones. **Decision:** recovery is terminal-on-host only (the launchctl reload domain is per-uid, machine-local) — it never opens a network recovery path, the correct break-glass posture. **Out of scope (slice 4):** ADR 0004, `SECURITY.md`/`operational-spec.md`, the `VRF-auth-2-login` live verification, final Critic. **Tests:** `+9` `test/caddy.test.js` (generated single/dual-site re-stamp, hand-edited snippet patch with header untouched, multi-user `--user` disambiguation, absent-user / no-credential / bad-hash throws, `listBasicAuthUsers`) + a new `test/reset-admin.test.js` (`+12`: arg parsing, user resolution, reload argv, and the fail-closed write→validate→restore guard); isolated end-to-end smoke (temp `HOME` + caddy stub) verified dry-run + real patch + backup + header-untouched. Full suite **3378 pass / 0 fail / 1 skip**. Critic cumulative 0 BLOCKING / 2 WARNING / 1 NOTE → all fixed (evidence re-anchored to HEAD; the fail-closed restore branch extracted + regression-tested; counts reconciled) → verify-resolutions CLEAN. Learning captured: a launchd reload smoke test runs the real `launchctl` (per-uid domain, not `$HOME`-scoped) — stub it. Spec: `.prawduct/artifacts/auth-2-authelia-gate.md` (Build progress / slice 3).

## 2026-06-25: Forced first-run admin wizard step (AUTH-2 slice 2b)

<!-- prawduct: type=feat | chunks=AUTH-2 | scope=tc-4.0 | status=shipped -->

**Why:** Slices 1 + 2a built and wired the `basic_auth` gate; slice 2b is the operator-facing half — the forced first-run admin so a caddy-fronted install can't reach a usable state with no login (no default credential). **What:** in caddy ingress mode the first-run wizard (`public/setup.js`) grows a mandatory **Admin Login** step (username + password + confirm) and **hides Skip**; the step list is now dynamic (`wizardStepKeys()` appends `admin` before `confirm` only when `state.config.ingressMode === 'caddy'` — direct mode is the unchanged 7-step flow, step-dots rendered dynamically). `lib/caddy.js` gains **`validateAdminPassword(pw, user)`** (min-12 + bundled weak-password denylist + no-username-match + no control chars, zero-dep) and **`hashPassword(pw)`** (shells `caddy hash-password --algorithm bcrypt`, plaintext on **stdin** so it never hits argv/`ps`; throws on non-bcrypt output). `server.js` `/api/setup/complete` validates → hashes → persists into slice-2a's `authEnabled`/`basicAuthUser`/`basicAuthHash`, and **rejects** completion in caddy mode without an admin (`ADMIN_REQUIRED`). The Skip bypass is closed symmetrically: `PATCH /api/config { setupComplete: true }` carries the same gate. The admin-credential path is logged (ERROR on hash failure, INFO on set — never the secret); `BCRYPT_HASH_RE` is exported from `lib/caddy.js` and consumed by the PATCH validator (no duplicated literal). Carried Critic notes resolved: header label dropped its `AUTH-1` tag; **WS-over-basic_auth** — no extra Caddyfile config, the gate is site-level (`basic_auth @protected`) so it covers the three WS routes except `/api/health`, and `reverse_proxy` proxies the Upgrade transparently with the browser replaying the `Authorization` header (live confirmation is `VRF-auth-2-login`, slice 4). **Decision (the spec's "+ reload" sub-clause, deliberately deferred):** the wizard does **not** regenerate+reload the live Caddyfile — that stays in the tested, fail-closed `ingress-cutover.js` primitive (run at a terminal where `--rollback` exists), avoiding a headless-launchd reload that would flip the live gate before slice-3 break-glass exists (the lockout / WS-401 window). `/api/setup/complete` instead persists the credential and returns a warning steering the operator to re-cutover. **Out of scope (held):** break-glass recovery (`scripts/reset-admin.js` + runbook) is slice 3; ADR 0004 + `VRF-auth-2-login` are slice 4. **Tests:** `+15` `test/caddy.test.js` (password-rule + bcrypt-hash helpers), `+10` `test/auth2-setup-admin.test.js` (endpoint gate both paths + direct-mode pass-through), `+9` `test/auth2-wizard-admin.test.js` (caddy-only step insertion, client gate, completion payload). Full suite **3357 pass / 0 fail / 1 skip**. Critic cumulative 0 BLOCKING / 3 WARNING → all fixed (regex dedup, security-model.md freshness, admin-path logging) → verify-resolutions CLEAN. Also declared `test_command`/`tests_dirs` in `project-state.yaml` so evidence records the node suite (the pytest fallback was broken). Spec: `.prawduct/artifacts/auth-2-authelia-gate.md` (Build progress / slice 2b).

## 2026-06-25: basic_auth config + cutover wiring (AUTH-2 slice 2a)

<!-- prawduct: type=feat | chunks=AUTH-2 | scope=tc-4.0 | status=shipped -->

**Why:** Slice 1 built the generator capability; this slice makes it **operator-reachable** — config fields + cutover wiring so an ingress can actually be password-gated (formalizing the live hand-edited-Caddyfile setup on cursatory). **What:** three new config fields in `store.js` DEFAULT_CONFIG — `authEnabled` (default `false`), `basicAuthUser`, `basicAuthHash` — plumbed through `PATCH /api/config` (`server.js`) with **fail-closed** validation: enabling auth requires *both* a user and a hash (cross-field check, symmetric with `buildCaddyfileContent`'s both-or-neither guard, so the config can never hold `authEnabled=true` with a missing credential); `basicAuthHash` must be a real **bcrypt** string (`/^\$2[aby]\$\d{2}\$.{53}$/`) — a plaintext password is rejected, not silently stored as a "hash"; the hash is persisted **as-is** (already hashed — unlike `deletePassword`, never re-hashed) and **redacted** from `GET`/`PATCH /api/config` (a `basicAuthConfigured` boolean is returned instead — credential hashes never leave the server, via a shared `redactConfigSecrets` helper that now also covers `deletePassword`); empty strings normalize to null. `scripts/ingress-cutover.js` passes `basicAuthUser`/`basicAuthHash` to the generator **only when `authEnabled`** — the generator's guard backstops a hand-edited `config.json` (throws rather than emitting an ungated ingress). Default-OFF ⇒ existing ingress byte-identical until opt-in. **Decision:** `authEnabled` is decoupled from `ingressMode` — it may be set in direct mode (inert until a caddy cutover), so no cross-coupling at the config layer; the gate materializes only when the cutover regenerates the Caddyfile in caddy mode. **Scope:** this slice splits the spec's "slice 2" — the forced first-run **wizard** (UI + `caddy hash-password` shell-out + password rules min-12/denylist/no-username-match + `/api/setup/complete` blocking) is **slice 2b**, its own session. Still carried for 2b: verify browser WS clients can present basic_auth on the Upgrade; drop the `AUTH-1` header slice-tag. **Tests:** `+8` `test/api-config.test.js` (defaults, hash-stored-as-is, enable-with-creds, fail-closed no-credential + half-set, bcrypt-shape guard rejects plaintext, non-boolean reject, empty→null) + `+3` `test/ingress-cutover.test.js` (flag-off-stays-ungated-despite-creds, gated-when-enabled, throws-on-half-set). Full suite **3327 pass / 0 fail / 1 skip**. Spec: `.prawduct/artifacts/auth-2-authelia-gate.md` (Build progress / slice 2a).

## 2026-06-25: Caddyfile basic_auth gate generation (AUTH-2 slice 1)

<!-- prawduct: type=feat | chunks=AUTH-2 | scope=tc-4.0 | status=shipped -->

**Why:** First slice of AUTH-2 (Path A — Caddy `basic_auth` + forced first-run admin wizard), unblocked once #397/#398 landed (`d0d2886`). The gate has to be *generated* before the wizard can set it, and AUTH-1's #397 fix explicitly deferred "the generator owning the `basic_auth` block" to AUTH-2. **What:** `lib/caddy.js` `buildCaddyfileContent` gains `basicAuthUser` + `basicAuthHash` (a bcrypt hash — never plaintext). When both are set it injects a `basic_auth @protected` block — matcher `@protected not path /api/health`, placed before `reverse_proxy` — into **every** site block (the local mkcert site and the public ACME site), so the cutover health probe and any launchd/liveness check reach TC unauthenticated. A `_pushSiteBlock` helper factors the (previously inline) local + public emission so the auth logic isn't duplicated. The credential is **both-or-neither**: a half-set pair throws rather than silently emitting an UNGATED ingress (fail closed on a reachable box). With no credentials the output is **byte-identical** to AUTH-1, so the integrity hash and every existing generated Caddyfile are unchanged; a generated *gated* file still passes `isGeneratedCaddyfile`, so a future cutover **reproduces** the operator's auth block instead of only refusing to clobber it (closes #397 item 3's design intent). **Not operator-visible yet** — nothing wires config or the cutover to pass the credential (CHANGELOG `### Internal`); that's slice 2 (config fields + the forced first-run admin wizard hashing via `caddy hash-password`). **Decision:** the generator gates on *presence of user+hash*, not a separate `authEnabled` flag — `authEnabled` stays a config-level concept for slice 2. **Out of scope (held for slice 2+):** config/cutover wiring, the wizard, password rules, break-glass recovery, and verifying browser WS clients carry basic_auth on the Upgrade (a cumulative-Critic note — a 401 on a WS Upgrade isn't interactively answerable). **Tests:** +7 in `test/caddy.test.js` (gate over local + public sites, `basic_auth` precedes `reverse_proxy`, `/api/health` bypass, ungated-by-default, both-or-neither fail-closed ×2, gated file still integrity-stamped) plus a real `caddy validate` (v2.11.4) confirming the `basic_auth @protected` syntax adapts. Full suite **3316 pass / 0 fail / 1 skip**. Critic chunk 0/0/0; cumulative 0 BLOCKING / 0 WARNING / 2 NOTE (header-label slice-tag + WS-over-basic_auth — both deferred to slice 2, recorded in the spec). Spec: `.prawduct/artifacts/auth-2-authelia-gate.md` (Path A build step 1 / Build progress).

## 2026-06-24: Production-durable ingress cutover (#397)

<!-- prawduct: type=fix | chunks=397 | scope=tc-4.0 | status=shipped -->

**Why:** The live `VRF-auth-1-cutover` (the gate on #395) surfaced three ways AUTH-1's cutover failed as shipped — the ingress *mechanism* was sound (end-to-end 200 + WS), but it wasn't durable. **What:** all three fixed in `lib/caddy.js` + `scripts/ingress-cutover.js` + the ttyd launch path. **(1) Cert under a TCC-protected dir.** The launchd Caddy binary has no Full Disk Access, so a cert under `~/Documents` (the operator's configured mkcert cert, or `getCertsDir()`) silently stalled after "started background certificate maintenance" and never bound `:8443`/`:8080` (foreground `caddy run` inherits the shell's TCC grant, which is why unit tests never caught it). New `caddy.stageCert()`/`getStagedCertsDir()` copy the resolved cert+key into the non-TCC store dir (`~/.tangleclaw/certs/`, key `0600`, cert `0644`, overwritten each cutover so rotation propagates, self-copy-safe via realpath compare); the cutover references the staged paths (dry-run previews them). **(2) ttyd stale Unix socket on restart.** The cutover unlinked the socket, but KeepAlive/reboot restarts did not → a stale inode made every terminal come up dead until a manual `rm`. New **`deploy/ttyd-launch.sh`** wrapper unlinks the socket (when `TTYD_SOCKET` is set — caddy mode; direct-mode TCP bind is a no-op) before `exec`'ing ttyd; the plist runs the wrapper before the binary, `install.sh` fills `TTYD_SOCKET` empty, the cutover fills it with the socket path. **(3) Cutover clobbered a hand-edited Caddyfile.** Regeneration was unconditional and would wipe an operator's `basic_auth` block + password (remote lockout). Generated Caddyfiles now carry a **sha256 of their body** stamped in the header; `caddy.isGeneratedCaddyfile()` integrity-verifies it (a marker-only prefix check is insufficient — operators keep the header and edit the body, the exact live failure), and the cutover backs the file up + **refuses** to overwrite a tampered file without `--force`. **Out of scope (held for AUTH-2):** the generator *owning* the `basic_auth`/remote block so a cutover *reproduces* the operator's config — this fix only guards it. **Tests:** +23 — `test/caddy.test.js` (integrity check incl. header-kept-body-edited + legacy-no-stamp; staging perms/rotation/self-copy), `test/ttyd-launch.test.js` (unlink-on-set, no-op-empty, arg pass-through), `test/ttyd-plist.test.js` (wrapper precedes ttyd, `TTYD_SOCKET` templated, install.sh empty-fill), `test/ingress-cutover.test.js` (`--force` parse + per-mode `TTYD_SOCKET`). Full suite **3300 pass / 0 fail / 1 skip**. Critic verify-resolutions CLEAN (0 BLOCKING / 0 WARNING / 1 cosmetic NOTE, fixed). Verified live via dry-run against the running hand-edited Caddyfile (correctly refuses). **`VRF-auth-1-cutover` re-verify owed** (the three fixes on the host; the live file stays load-bearing — do NOT `--force` it). #397 gates closing #395.

## 2026-06-23: Reversible Caddy reverse-proxy ingress (AUTH-1, #395)

<!-- prawduct: type=feat | chunks=AUTH-1 | scope=tc-4.0 | status=shipped -->

**Why:** First chunk of the AUTH track (#1). The AUTH-2 forward-auth gate needs a single ingress chokepoint in front of every human surface (HTTP API, the three WebSocket routes, ttyd, the proxied OpenClaw gateway) plus a path to real public TLS — neither of which exists while TC terminates its own HTTPS and ttyd listens directly on `:3100`. AUTH-1 lands that shape with **no authentication yet**, behind a reversible flag so it merges inert and the operator drives the live cutover. **What:** new `ingressMode` config (`'direct'` default = byte-identical to today / `'caddy'`). In caddy mode TC binds `127.0.0.1` plain-HTTP behind **Caddy**, which terminates TLS (reuses the existing mkcert cert for `localhost` — local HTTPS unchanged; emits an ACME/Let's-Encrypt site block when `publicDomain` is set) and is the only ingress; **ttyd rebinds to a Unix domain socket** so it is unreachable except via the proxy chain. New **`lib/caddy.js`** detects the Caddy binary, builds + `caddy validate`s the Caddyfile (non-privileged global `https_port`/`http_port` so Caddy runs as a no-sudo user LaunchAgent; `admin off`; `0600`; `reverse_proxy` carries WS upgrades transparently), and resolves the per-mode ttyd connect target (`ttydConnectTarget` → `{socketPath}` vs `{host,port}`); `server.js` consumes it at the three ttyd-coupled sites (`/api/health` probe, `proxyToTtyd` HTTP, `/terminal` WS upgrade) and forces plain-HTTP + localhost binding in caddy mode. `ttyd-watcher` needed **zero change** — it recycles via `launchctl`/process-inspection, not a port probe (boundary investigation confirmed the only port-coupled sites were the three in `server.js`). The reversible flip is **`scripts/ingress-cutover.js`** (`--to caddy|direct` / `--rollback` / `--dry-run`): pure `planCutover` + side-effecting executor that regenerates the Caddyfile + the ttyd plist (TCP↔Unix-socket via a templated bind arg) + a `com.tangleclaw.caddy` user LaunchAgent, **`caddy validate`s before any launchd reload (fail-closed)**, unlinks a stale socket before rebind, flips `ingressMode`, reloads the jobs, restarts the server so its listener re-binds, and health-checks — printing the one-command rollback. `install.sh` keeps its direct path unchanged and points at the cutover. Configurable `caddyHttpsPort`/`caddyHttpPort` (default `8443`/`8080`, no-sudo; 443/80 + root-LaunchDaemon is the documented public-domain path). **Out of scope (held):** authentication itself (AUTH-2), live Let's-Encrypt verification (needs a public domain → deferred sub-VRF), the Linux/systemd implementation (seam only). **Decision:** Caddy fronts TC (not ttyd/gateway directly) so TC keeps its proxies and AUTH-2 injects ttyd's header from behind the gate; ttyd-socket is mode-conditional so direct rollback is byte-identical; mkcert reused (vs `tls internal`) so no CA re-trust. ADR `docs/adr/0003-ingress-model.md`. `lib/https-setup.js` retained as the direct-mode/rollback TLS path (marked, not deleted). **Tests:** +35 — `test/caddy.test.js` (detect/build/write/validate + per-mode `ttydConnectTarget`), `test/ingress-cutover.test.js` (plan/args/template/upstream-port; launchctl orchestration is the VRF), `test/ttyd-plist.test.js` (templated bind contract), `ingressMode`/`publicDomain`/port validation in `test/api-config.test.js`. Full suite **3277 pass / 0 fail / 1 skip**. Critic cumulative→verify-resolutions CLEAN (0 BLOCKING / 5 WARNING → all fixed / 3 NOTE). Spec: `.prawduct/artifacts/auth-1-caddy-ingress.md`. **`VRF-auth-1-cutover` owed** (live cutover + rollback on the host — launchd/socket binding is unverifiable in unit tests by design). Default-OFF, so the merge is inert until cutover.

## 2026-06-22: Typed-wrap trigger parity — the wrap sentinel (CC-7 Slice C)

<!-- prawduct: type=feat | chunks=CC-7 | scope=tc-4.0 | status=shipped -->

**Why:** Closes CC-7 (A+B0+B1+C). "Trigger parity" = typing "wrap" in a live session opens the SAME wrap drawer the Wrap button opens, cross-model + cross-transport, no Claude-only skill lock-in. **What:** the AI absorbs NL variation (instructed via the prime prompt) and, on recognizing wrap intent, emits a fixed render-safe marker — the bare token `TANGLECLAW_WRAP` on its own line (the plain-token form the B1 spike proved survives Claude Code's TUI render on both transports). New boot-time monitor **`lib/wrap-sentinel.js`** (`start`/`stop` + `setInterval`, wired in `server.js` beside `ttyd-watcher`/`tunnel-monitor`) polls `store.sessions.listLiveAll()`, reads each session's output delta (tmux `capturePane` tail · gateway `clawbridge.getOutput` cursor), ANSI-strips, and on a **fresh** standalone-token emission raises a per-project flag. `GET /api/sessions/:project/status` now carries `wrapRequested`; `public/session.js pollStatus` opens the existing `openWrapModal()` once on the flag and acks it via new `POST /api/sessions/:project/wrap-sentinel/ack`. **No auto-commit/kill** — the drawer is the operator's review surface (operator decision 2026-06-22: flag→drawer, not a server-side auto-`triggerWrap`). **Two false-positive guards** keep a mere *mention* (the prime names the token) from tripping a wrap: standalone-word match (`SENTINEL_RE` — the prime phrases it backticked/period-terminated so it never matches) + per-session baseline that skips the backlog/prime echo and flags only a later absent→present transition, at most once per session. State is in-memory/ephemeral (restart re-baselines). **Out of scope:** session-rules injection (prime suffices v1); dashboard-side open (session view is where the typed wrap happens). **Tests:** +14 — `test/wrap-sentinel.test.js` (detection + both guards isolated, tmux baseline→fresh-emission / prime-echo-never-flags / once-per-session+ack / vanished-pane / end-prune, gateway cursor-baseline+fresh-output / transient-error / no-sidecar, lifecycle) + `test/sessions.test.js` (prime carries the instruction AND does not self-trip the monitor) + `test/api-sessions.test.js` (status flag + ack round-trip). Full suite **3222 pass / 0 fail / 1 skip**. Spec: `.prawduct/artifacts/cc-7-degraded-wrap.md` Slice C. **VRF owed:** live typed-wrap on a real session. **CC-7 now COMPLETE.**

## 2026-06-22: WebUI/gateway ai-content capture over ClawBridge (CC-7 Slice B1)

<!-- prawduct: type=feat | chunks=CC-7 | scope=tc-4.0 | status=shipped -->

**Why:** WebUI/OpenClaw wrap sessions silently skipped `ai-content` structured capture (the #334 honest-skip), so a webui wrap could never reach tier-1/2 (judgment sections always flagged-empty → `mechanical-only`). The 2026-06-20 spike + ClawBridge #18 (`GET /v2/session/file`, shipped v1.9.1, validated end-to-end on habitat) opened the capture-back path. **What:** **`lib/clawbridge.js` `getFile({localPort, token, project, path, consume})`** consumes #18 — raw bytes round-trip byte-identical (`##` + newlines preserved, which the PTY paint stream does not), `consume` sent only as the literal `"true"`, empty body preserved as `""`, 400/404/unreachable distinguished from success. **`lib/wrap-steps/ai-content.js` `_runGatewayCapture`** replaces #334's blanket webui skip: for a step with both `captureFields` and a `captureFile` it `clawbridge.send`s the wrap prompt → polls `clawbridge.getStatus` until `inputReady` (bounded by the existing `MAX_WAIT_MS`; `waiting_for_permission` → honest blocked step, never a hang) → reads + consume-once the captureFile via `getFile` → parses with the **same** `_parseFields` the tmux path uses → stages the identical `{capturedText, parsedFields}` shape so `continuity-write` sees `hadCapture:true` (Slice A then renders tier `full`/`no-plugin`). A step with no `captureFile`, a session with no ClawBridge sidecar (`bridgePort`, resolved via new `_internal.getBridgeContext`), or a non-openclaw engine returns an honest `skipped` with a reason (never a fabricated capture). Bridge deps injected via `_internal` (`getBridgeContext`/`bridgeSend`/`bridgeGetStatus`/`bridgeGetFile`) for testability. **Scope decision:** dropped the spec's planned `sessionTransport()` helper — the single `sessionMode==='webui'` fork is the only call site (Scope Discipline). **Out of scope (held):** memory-update remote-FS write (AI writes the remote tree, `commit` reconciles the local one — pre-existing webui reality); unstructured no-`captureFile` capture (B1 spike proved the gateway PTY stream loses line structure); Slice C sentinel monitor. **Also:** `scripts/cc7-capture-spike.js` (the diagnostic that produced the line-structure finding) tracked for greppability + re-runs (reads bridge token from the store at runtime; raw dumps go to `os.tmpdir()`, not the tree). No schema change, no new store/endpoint/UI. **Tests:** +16 — `test/clawbridge.test.js` (`getFile` raw round-trip, consume literal `"true"`, empty-body preservation, 400/404/unreachable) + `test/wrap-step-ai-content.test.js` (gateway happy path, no-sidecar skip, no-captureFile skip, missing-field block, unreadable-file block, permission block, timeout, send failure, non-openclaw engine). Full suite **3206 pass / 0 fail / 1 skip**. Critic (verify-resolutions, inferred): 0 BLOCKING / 0 WARNING / 1 NOTE (no-captureFile skip labels "no AI channel" via `_deriveUncapturedReason` — loose but not misleading; watch-item). Docs: `docs/adr/0002-wrap-pipeline-contract.md` `ai-content` row now transport-aware. Spec: `.prawduct/artifacts/cc-7-degraded-wrap.md` Slice B1. **CC-7 box stays `[ ]`: A + B0 + B1 done; only Slice C remains.**

## 2026-06-19: Dedup continuity sort comparator + unindexed-meta builder (CON-1R6D)

<!-- prawduct: type=refactor | chunks=CON-1R6D | scope=tc-4.0 | status=shipped -->

**Why:** Backlog CON-1R6D (builder-filed during CC-5 review). `lib/continuity.js` had the session-result sort callback (recency-desc → match-count-desc → sid) copy-pasted into three functions (`listSessions`, `searchSessions`, `searchProjectTranscripts`) and the forward-only `unindexed: {type, file}` meta block built inline at two sites. Triplicated logic is a silent-drift hazard — a future ranking tweak could land in two of three. **What:** extracted two shared private helpers — `_byRecencyMatchSid(a, b)` and `_unindexedMeta(sessions)` — placed beside `_sidCompare`. The unified comparator is behavior-identical at all three sites: `listSessions` records have no `matchCount`, so that tier is a no-op (`undefined !== undefined` is false) and it collapses to the prior recency→sid. **Pure behavior-preserving refactor** — no API/schema/output change, module exports unchanged (helpers stay private, consistent with the module's convention of not exporting `_`-helpers). **Tests:** the existing continuity + api-continuity suites (87) pass unchanged — the refactor contract; added one characterization test (`test/continuity.test.js`) pinning the match-count tiebreaker (same date, lower sid with more matches sorts first), the one comparator sub-behavior the recency-only tests didn't assert and which the three-into-one extraction now makes a single point of failure. Full continuity suite 80 pass. Related: CON-8H3Z (path-token regex dedup) still open.

## 2026-06-19: ttyd PTY-leak watchdog — orphan-child gate (#380, primary root cause)

<!-- prawduct: type=fix | chunks=380 | scope=tc-4.0 | status=shipped -->

**Why:** #380's *primary* root cause (the SW layer-2 fix shipped separately). The ttyd watcher (`lib/ttyd-watcher.js`, #94/#144) already recycles ttyd via `launchctl kickstart` on PTY-pool exhaustion — but it gated **only** on pool ratio (`used/kern.tty.ptmx_max ≥ 0.85`). Live investigation of the recurrence found ttyd holding **90 `tmux attach` children wedged in the kernel `E` (exiting) state** — each holding a `/dev/ttys*` slot, unreapable except by ttyd dying — at a pool ratio of only **0.45** (230/511). The watcher stayed silent while session-open failed: it was measuring the wrong signal. **What:** a **second, independent gate** — `_countTtydOrphans(pid)` counts ttyd children in `E`/`Z` state (a healthy attached client is `S`/`R`, so the count sits near zero), and `_check` kickstarts when it reaches `DEFAULT_ORPHAN_THRESHOLD` (20, configurable via `start({orphanThreshold})`), regardless of pool ratio. Gates are independent — a broken pool measurement (`cap===0` fail-safe) no longer suppresses an orphan-driven kickstart (`cap===0 && !orphanGate` short-circuit). Refactored the shared `ps -A -o ppid=,stat=` parse into `_ttydChildStats` (reused by the existing `_countTtydZombies`, behavior preserved). **Design decision (recorded):** surgical per-process reaping was rejected — an `E`-state process stuck for hours is wedged in the kernel and `SIGKILL` can't free it; only the parent (ttyd) dying reaps it, which is exactly what kickstart does. The kickstart is non-destructive: the tmux **server** sessions survive and clients auto-reconnect; only leaked children are reaped. **Tests:** `test/ttyd-watcher.test.js` +9 — `_countTtydOrphans` (E/Z counted, S/R ignored, cross-parent excluded, ps-error fail-safe, malformed rows) and `_check` orphan gate (the #380 regression: kickstart at ratio 0.45 with 25 orphans; below-threshold no-op; orphan gate fires despite a failed pool reading; custom + default threshold). Full watcher suite 42 pass. ttyd version on host: 1.7.7. #380 stays OPEN until operator confirms the gate holds over multi-day uptime.

## 2026-06-19: SW update-propagation hardening — iOS no longer stranded on a stale worker (#380, layer 2)

<!-- prawduct: type=fix | chunks=380 | scope=tc-4.0 | status=shipped -->

**Why:** An operator hit `FetchEvent.respondWith received an error: Returned response is null` opening a session on iPhone, while desktop worked. Root cause: iOS Safari kept an OLD service worker active (the pre-#380-fix `sw.js` that returned `caches.match()`→`undefined` on the uncacheable session-open POST). The server already served the fixed `sw.js`, but iOS never installed it — `updateViaCache:'none'` (#258) + `skipWaiting` + `clients.claim` were all present, yet **nothing ever called `registration.update()` after the initial load**, and iOS only auto-checks `/sw.js` on a full navigation (~24h cap), so a long-lived tab / home-screen PWA stays on the stale worker until a manual Website-Data clear. **What:** extracted SW registration out of `landing.js`'s inline block into a new testable `public/sw-register.js` that (1) polls `reg.update()` on load **and on every `visibilitychange→visible`** (the fix — forces the update check on a long-lived iOS tab) and (2) reloads on `controllerchange`, **guarded** so it fires only when an *existing* controller is replaced (never first-install) and **at most once** (no reload loop). `index.html` loads `/sw-register.js` before `landing.js`; `sw-register.js` is dual-listed in `sw.js` (precached for `'/'` offline coherence + network-first as cache-bust-critical, mirroring `landing.js`); `CACHE_NAME` bumped `v3-22→v3-23` so the new `index.html` reaches active workers. Behaviour is unchanged on desktop except it now also auto-picks-up SW updates (a strict improvement). **Scope boundary:** #380's *primary* root cause — the ttyd PTY-pool leak that makes session-open *fail* after multi-day uptime — is a separate, still-open chunk; this fix only makes that failure legible (a 503) and stops the stale-worker stranding. #380 stays OPEN. **Tests:** new `test/sw-register.test.js` (register args, update-on-load, update-on-visibility, reload-on-controller-replace, no-reload-on-first-install, reload-at-most-once, graceful no-op when SW unavailable / registration rejects); relocated the #258 source-guard in `test/openclaw-cache.test.js` to `sw-register.js` (contract preserved, not weakened). Full suite **3181 pass / 0 fail / 1 pre-existing skip**. Critic cumulative (opus): 0 BLOCKING / 1 WARNING (stale test-evidence) → resolved (re-ran suite on this branch + fresh evidence).

## 2026-06-19: One-click self-update — Update & restart action (UB, #228/#229)

<!-- prawduct: type=feat | chunks=UB | scope=tc-4.0 | status=shipped -->

**Why:** Closes the last manual step of the update flow. Detect/notify already shipped (24h release-tag poll → `/api/update-status` → update pill) and the *restart* already shipped (#199/#235: `POST /api/server/restart` → launchd `KeepAlive` relaunch → poll `/api/server-info`); the GAP (#228/#229) was the git step — the badge only *injected an AI prompt* telling the agent to `git pull` on the box. **What:** the update pill gains an **Update & restart** button → confirm → `POST /api/update/apply` fetches + checks out the **latest release tag** (Decision A, operator-ratified — consistent with the tag the pill advertised) → chains the existing restart → reload onto the new assets. **New `lib/update-applier.js`** does the git half with fail-closed guards: refuses on a **dirty tree** (never clobbers local changes), **no-update** (no silent no-op), **wrong-ref** (HEAD not on `main` or a release tag — never moves a dev's feature branch; detached-at-a-tag allowed for a prior self-update), **no-git**, **no-tag**; a git failure mid-flow returns the pre-update `fromSha` so recovery is a one-line `git checkout <fromSha>`. Git runs **argv-form** (`execFileSync`) so a tag ref can't shell-inject. **New route `POST /api/update/apply`** (200 with `fromSha`/`toRef`/`toSha`; **409**+stable `code` on a refused guard; **500** on git-error) — does NOT restart itself, so the proven flush-202-then-kill path stays in one place. **Deliberate refinement (recorded in the spec, vs the original "hide the button" plan):** the button is always shown; on a host with no restart mechanism the apply still lands on disk and the alert says to restart manually (degrades into the #199 stale-server banner) — the git apply has standalone value. **No auto-rollback v1** (documented; `fromSha` logged). Sidesteps the `project_install_tcc_hazard` (uses `kickstart -k`, not `install.sh`'s load/unload reload). **Tests:** new `test/update-applier.test.js` (every guard + happy path from main + detached-release-tag + `_headState`) + `test/api-update-apply.test.js` (route 200/409/500). Full suite **3154 pass / 0 fail / 1 skip**. Closes #228, #229. Spec: `.prawduct/artifacts/ub-self-update-action.md`. `VRF-ub-self-update` queued for operator live-test (deferred per operator).

## 2026-06-19: Per-methodology wrap contract — depth presets (CC-8, #386)

<!-- prawduct: type=feat | chunks=CC-8 | scope=tc-4.0 | status=shipped -->

**Why:** Completes the wrap-section precedence chain CC-6 began. CC-6 gave operators a per-project `project.wrapSections` override; CC-8 adds the layer beneath it so a *methodology* declares its default depth — a lightweight (grant-writing) methodology shouldn't default to the same 8-section software wrap as Prawduct. **What:** a new optional `template.json` `wrap_contract.sections` field (a subset of the fixed `continuity.WRAP_SECTIONS`), validated in `lib/methodologies.js` `validateTemplate` against the **same** vocabulary the per-project gate uses ([[feedback_symmetric_capability_gates]]); resolution in `lib/wrap-steps/continuity-write.js` falls back per-project `wrapSections` (CC-6) → methodology `wrap_contract.sections` (CC-8) → all 8 (deep fallback), best-effort (an unresolvable template never halts a wrap), with the methodology lookup injected via `_internal.getMethodologyTemplate` for testability. `effectiveWrapSections` always forces `Next action` in regardless of layer. **Prawduct deliberately omits `wrap_contract` ⇒ stays deep (all 8), so no existing project regresses** — no schema change, no migration, no new store/endpoint/UI; "deep"/"light" are doc labels, not a named-preset enum (the simpler design). **Tests:** +8 — `test/methodologies.test.js` (valid subset / omitted / non-object / non-array / unknown-section-name) + `test/wrap-step-continuity-write.test.js` (methodology default used when no per-project override; per-project override wins; deep fallback when the methodology declares no `wrap_contract`). Full suite **3147 pass / 0 fail / 1 skip**. Critic cumulative (opus/escalate): 0 BLOCKING / 2 WARNING → resolved (added this change-log tag; refreshed test-evidence to HEAD). Spec: `.prawduct/artifacts/cc-8-methodology-wrap-contract.md`.

## 2026-06-18: Accurate remote (ClawBridge) session liveness — async probe (#364)

<!-- prawduct: type=chore | chunks=347 | scope=tc-4.0 | status=shipped -->

**Why:** Closes the capability gap in #347 Slice 2b / #364 — remote `openclaw` sessions carried db-only liveness (a db-`active` row whose bridge session was gone read as live). B0 shipped `clawbridge.getStatus`; this consumes it. **What (`lib/session-ownership.js`):** `probeLiveness(session)` — for an `openclaw` session resolves the connection → `clawbridge.getStatus`, returning `{live: status.active, source:'bridge'}` when reachable (bridge `200 + active:false` = confirmed dead, the #364 win) and falling back to the db signal (`source:'db'`) when the bridge is unreachable / unconfigured (never a fabricated dead); delegates to the sync `_liveness` for tmux/local. `listLiveProbed()` — async sibling of `listLive` that re-probes remote entries **concurrently** and returns only confirmed-live tabs (drops a stale local pane-gone row AND a bridge-dead remote row). **Design deviation (documented):** #364's literal step 3 said "replace the db-only branch in `_liveness`", but `getStatus` is a network round-trip and `_liveness` feeds the **synchronous** prime-gen scope guard + migration live-check — putting a per-sibling HTTP call there would let one hung bridge stall every session launch. So accuracy lives on a **separate async path** (`probeLiveness`/`listLiveProbed`) for await-capable enumeration consumers (Project Master #331, Switchboard #333), and the sync hot paths keep the fast, honestly-labeled db signal. **No consumer wired yet** → `### Internal`/`type=chore` (zero user-visible change); the capability is the deliverable. `_internal.bridgeStatus` injected for tests. **Unblocked by:** ClawBridge v1.7.1 `GET /v2/session/status` (the #364 "no status endpoint" premise was stale). **Tests:** +8 in `test/session-ownership.test.js` (probe bridge-live / bridge-dead / unreachable-db-fallback / no-bridge-port-no-call / local-delegates-no-call / throws-db-fallback; `listLiveProbed` drops-dead-keeps-live + retains-unreachable-via-db). Full suite 3139 pass / 0 fail / 1 skip.

## 2026-06-18: ClawBridge client foundation — send/getOutput/getStatus (CC-7 Slice B, B0)

<!-- prawduct: type=chore | chunks=CC-7 | scope=tc-4.0 | status=shipped -->

**Why:** B0 of CC-7 Slice B (operator-chosen). A mid-build spike found Slice B's spec framing incomplete: the **send** half of a gateway wrap channel is trivial, but **capture-back** is blocked — Claude Code's PTY renders `##` away (so `/v2/session/output` can't be field-parsed, same as the #287 tmux-pane problem) AND the remote OpenClaw AI writes its `captureFile` to a *different filesystem* than TC's local `project.path`. Resolving that needs a render-surviving sentinel capture contract (B1) confirmed by a live OpenClaw spike the operator must run. So B0 ships only the verified, unit-tested client methods — real progress that also unblocks #364 — and pauses the `ai-content` wiring. **What (`lib/clawbridge.js`):** previously only `startSession`; adds `send` (`POST /v2/session/send`, gateway analog of `tmux.sendKeys`), `getOutput` (`GET /v2/session/output?cursor=N`, cursor-based, auto-extends HTTP timeout past `waitMs` for long-poll — analog of `capturePane`), `getStatus` (`GET /v2/session/status` — accurate remote liveness; bridge returns 200+`active:false` for "no live session", the signal **#364** needs to replace its db-only fallback). Shared `_requestJson` helper preserves the resolve-never-reject posture (bridge failure degrades the caller, never crashes); `_queryString` preserves a falsy `cursor=0`. `startSession` left untouched (bespoke attach-response shaping; refactoring it is out of B0 scope). **No consumer yet** → `### Internal` / `type=chore`: net-new client surface, zero user-visible behavior change. **Deferred:** B1 (render-surviving sentinel capture + live spike) → webui rises to tier 1/2; Slice C (`<<TANGLECLAW_WRAP>>` sentinel). **Tests:** +11 in `test/clawbridge.test.js` (send happy/404/409/network; getOutput events/cursor-0-preserved/pendingPermission/error; getStatus active/no-session-liveness/unreachable; `_queryString` falsy-0 + skip-null). Full suite 3131 pass / 0 fail / 1 skip. Spec: `.prawduct/artifacts/cc-7-degraded-wrap.md` (Slice B spike + B0).

## 2026-06-18: Degraded-wrap tiers — honest labeling (CC-7 Slice A)

<!-- prawduct: type=feat | chunks=CC-7 | scope=tc-4.0 | status=shipped -->

**Why:** First slice of CC-7 (`.prawduct/artifacts/cc-7-degraded-wrap.md` · `.claude/plans/continuity-contract.md` §"Degraded wrap"). The wrap always delivered the mechanical floor, but a webui/headless wrap (where `ai-content` honest-skips, #334) just dropped the judgment sections with no signal — the next session couldn't tell an honest gap from a fabricated-complete wrap. Slice A makes the degradation **labeled**: every wrap records *which tier ran* and *why* judgment is missing. **Tier (`lib/wrap-steps/continuity-write.js`, new `_deriveTier`):** `full` (AI judgment captured + `engines.isPluginGoverned` → reflection fold eligible), `no-plugin` (captured, not governed), `mechanical-only` (no capture). Computed up front from the existing `hadCapture` signal × a best-effort plugin-governance read (try/catch → non-governed), and stamped into BOTH the hot index and the per-session wrap-summary freshness. **Honest reason (`_deriveUncapturedReason`):** on a `mechanical-only` wrap the empty judgment sections render WITH the cause (`_⚠ not captured (no AI channel)_`) instead of the bare marker — derived by duck-typing the prior `ai-content` skip output (`{webui}`→"no AI channel", `{override}`→"AI content skipped by operator", else generic), the same shape-over-id philosophy as `_resolveCapturedFields`. **Render (`lib/continuity.js`):** `renderWrapSummary` gains a `tier` frontmatter key + an `uncapturedReason` flag (reason-bearing flags still match `_unflag`'s `/^_⚠.*_$/`, so the parse round-trip is preserved); `renderIndex`/`parseIndex` round-trip a `- tier:` freshness bullet (`unknown` sentinel → '' like sha/branch). **Resume (`lib/sessions.js`):** `generatePrimePrompt` surfaces a non-`full` tier (`Wrap tier: no-plugin (judgment may be thin — verify)`) to ground the freshness check; a `mechanical-only` wrap makes `readIndex` return null (no judgment), so it surfaces via the legacy summary path. **No schema change, no new store, server-side only** — webui/headless sessions stop silently dropping judgment, and webui's interim tier-3 is now honestly labeled (the contract's sanctioned interim until Slice B's gateway AI channel lands). **Deferred (in the spec):** Slice B (transport-aware gateway AI channel via un-staled `lib/clawbridge.js` → webui rises to tier 1/2) + Slice C (`<<TANGLECLAW_WRAP>>` trigger-parity sentinel). **Scoping finding:** ClawBridge shipped v1.7.1 with the full PTY-broker API (`send`/`output`/`status`/`transcript`), so Slice B is buildable TC-side and #364's "blocked" premise is stale (noted on #364). **Tests:** +14 — tier derivation (3 tiers) + reason derivation (webui/override/generic/empty) + end-to-end tier stamping across all three tiers + resume surfacing (non-full shown, full omitted) + round-trip preservation, incl. a GUARD test that fails if the reason-flag regresses to the bare marker. Full suite **3120 pass / 0 fail / 1 skip**. Critic verify-resolutions (chain-extending) **0 BLOCKING / 0 WARNING / 0 NOTE** (1 stale-evidence WARNING resolved). Spec: `.prawduct/artifacts/cc-7-degraded-wrap.md`.

## 2026-06-18: Self-improvement loop + Project Rules modal (CC-6, #381)

<!-- prawduct: type=feat | chunks=CC-6 | scope=tc-4.0 | status=shipped -->

**Why:** Closes the Continuity Contract's configuration + self-improvement surface (`continuity-contract.md` §"Project Rules"). The keystone was **reconciliation**: CC-6's design (2026-06-15) predated D1a/D1b, which already shipped the self-improvement *engine* — so rather than build a parallel store, CC-6 **reuses `session_rules`** (the contract's "Project-rules store → NOT a new store"). **`kind` discriminator (`lib/store.js`):** new `session_rules.kind` (`startup`|`wrap`|`mode`, schema **v19→v20**) lets the per-project Project Rules modal host three rule boxes; the launch-injection query `listActiveForProject` now filters to `kind='startup'`, and the v19→v20 ALTER backfills existing rows to `startup` (proven by a real-v19-DB migration test) → **no injection regression**. `create`/`list`/`promoteFromLearning`/`findConflictCandidates` accept `kind` (invalid → BAD_REQUEST); `kind` is immutable post-create (version-history table unchanged). **Wrap-section toggles:** `DEFAULT_PROJECT_CONFIG.wrapSections` (null = deep default, all 8) persisted to `project.json`; `lib/continuity.js` `renderWrapSummary` gains an `enabledSections` gate via the new exported `effectiveWrapSections` helper (`Next action` always forced — the keystone); the `continuity-write` wrap step reads the project's selection. `lib/projects.js` `updateProject` validates (array of valid section names, or null) + persists, and `enrichProject` exposes `wrapSections`. **API (`server.js`):** `GET /api/session-rules?kind=`, `POST /api/session-rules {kind}`, `/promote {kind}`, `/conflicts {kind}`; project PATCH accepts `wrapSections`. **UI (`public/ui.js`+`style.css`):** a Project Rules section in the Settings modal — three rule-kind boxes (startup/wrap/mode) with add/toggle/delete scoped by `projectId`+`kind` (reusing the D1a/D1b list pattern, `esc()`-guarded), plus the 8 wrap-section checkboxes (`Next action` checked+disabled); selection collected into the PATCH body (null when all 8 checked). **Self-critique → wrap-rules:** reuses D1b's engine — an AI-proposed `kind='wrap'` rule flows through the existing Critic gate and lands user-gated in the Wrap rules box (documented in `docs/session-rules-self-improvement.md`). **Deferred (documented):** per-methodology depth presets → CC-8; mode-rule runtime enforcement → A3 (#209). **Tests:** +33 across store (kind filter/validation/injection-filter/immutable-restore/promote-wrap/conflict-scope + real-v19→v20 migration backfill), continuity (`effectiveWrapSections` + render gating), wrap-step (project-configured selection), projects (wrapSections validate/persist/enrich/clear), server routes (kind passthrough/default/reject), and a new `project-rules-modal` source-level suite incl. a cross-file vocabulary **drift guard** (Critic NOTE 2). Full suite **3106 pass / 0 fail / 1 skip**. Critic cumulative (opus/escalate) **0 BLOCKING / 0 WARNING / 4 NOTE** → verify-resolutions chain CLEAN (NOTE 2 fixed; NOTEs 1/4 → backlog SR-9QX4/SR-5T1J; NOTE 3 migration bare-catch left to match convention). Spec: `.prawduct/artifacts/cc-6-project-rules-modal.md`.

## 2026-06-17: Operator-facing cross-session search — the continuity drawer (CC-5, #344)

<!-- prawduct: type=feat | chunks=CC-5 | scope=tc-4.0 | status=shipped -->

**Why:** The operator-facing read surface over the continuity warm tier (CC-2) + cold tier (CC-4b) — the self-served version of the Tilt regression-retrieval workflow: type "auth redirect bug" and jump to the session that fixed it, instead of relying on the AI to recall it (#344, unblocked the moment CC-4b shipped). **Two-stage funnel:** (1) **warm global search** (`searchSessions()` in `lib/continuity.js`) across the changelog + all wrap summaries — the default, so you never name a session first — with **five filters** (date range / `tags` / `type` / file-touched / `refs`), ranked **recency-primary / match-count-secondary** and grouped by session; empty query + filters ⇒ browse mode. (2) **cold drill-down** (`searchTranscript()`) — streams one session's `transcript.jsonl` line-by-line, extracting assistant text/thinking/tool_use + user string-or-blocks + system content, returning role+timestamp excerpts (bounded cap + `truncated` flag), surfacing the CC-4b `secretsFlagged` warning before content. `listSessions()` merges wrap frontmatter + changelog entry + transcript meta per session (transcript-only sessions surface too); `search()` left **intact** (CC-2 contract preserved). **Two persisted-schema additions** feed the new filters: a `type:` wrap-frontmatter key + `[type]` changelog token from the session **branch prefix** (`feat`/`fix`/`chore`/`docs`/`refactor`; `feature`→`feat`), and a `files:` key/line **reusing the wrap step's already-computed touched-files list** (`continuity-write.js` `_mapDelta().touched` — no new git call). Both **forward-only**: sessions wrapped before CC-5 stay un-indexed for those two filters, and the drawer **labels the gap** (`meta.unindexed`) rather than returning a silent empty. **Four read-only routes** (`server.js`): `GET /api/continuity/:project/{search,sessions,sessions/:sid,sessions/:sid/transcript/search}`; the `:sid` param is validated against `[A-Za-z0-9_-]` (path-traversal guard) and the drill-down meta strips the absolute `~/.claude` `source` path. **Frontend:** new `public/history-drawer.js` + `#historyModal` (search box, filters disclosure, ranked results, drill panel) + `&#128269;` History button on each project card + `.history-*` styles. **Tests:** +30 (continuity schema round-trip / listSessions / searchSessions filters+ranking+browse / searchTranscript extraction+secret-flag+stub+cap; wrap-step `_branchType` + type/files flow; `api-continuity` routes incl. encoded-traversal→400 + per-session-uploads). Full suite **3065 pass / 0 fail / 1 skip**. Critic cumulative→verify-resolutions chain (opus/escalate) CLEAN after resolving **1 BLOCKING** (sid path traversal) + **4 WARNINGs** (uploads `u.session` predicate, transcript read-error reason, CC-5 logging, `safeSid` JS-string sink). **Operator-driven fold-ins during verification:** result-UX polish (match highlighting / summary / selected-row / location tags), SW registration of `history-drawer.js` (+cache bumps), and **project-wide direct transcript search** (`searchProjectTranscripts()` + `?scope=transcripts` + Summaries/Full-transcripts toggle) — the operator's primary intent (search transcripts directly), which the #344 summary-first funnel had under-served. Spec: `.prawduct/artifacts/cc-5-operator-search.md`.

## 2026-06-17: Transcript snapshot into the consolidated store — continuity cold tier (CC-4b, #376)

<!-- prawduct: type=feat | chunks=CC-4b | scope=tc-4.0 | status=shipped -->

**Why:** Captures each session's raw transcript into the CC-4 store (`sessions/<sid>/transcript.jsonl` + `transcript.meta.json`) at wrap, scanned for secrets — the cold tier CC-5's drill-down deep-searches. Built before CC-5 (operator-ratified spine reorder) so CC-5 ships whole. **Wrap-time resolution, NO hook (`lib/transcript.js`, new):** a real-surface probe confirmed Claude transcripts live at `~/.claude/projects/<cwd-with-/-and-.-as-->/<uuid>.jsonl` and that lines carry `cwd`=project path, so TC resolves the transcript itself at wrap by content-match (newest `.jsonl` whose `cwd` matches) — avoiding a SessionStart hook handshake (the #94/#145 live-hook hazard) and any new endpoint/schema. **Forward-compat seam (operator ask):** `ADAPTERS` registry keyed by `engineId` — `claude` implemented, `gemini`/`codex`/`aider`/`openclaw` documented stubs returning null; adding a harness later = one `resolve()`. **Snapshot:** copies the raw `.jsonl` into the store, streams it line-by-line through CC-4's `lib/secret-scan.js` (bounded memory, no whole-file cap), writes the envelope sidecar (`harness`/`claudeSessionId`/`cwd`/`capturedAt`/`bytes`/`lineCount`/`secretsFlagged`/`secretTypes`/`source`) — **types only, never the value**. **Wiring:** folded into the `continuity-write` wrap step (no `template.json` step add → no schemaRevision re-propagation) in its OWN isolated try/catch — a transcript failure never affects warm-tier writes and never halts a wrap; result surfaced in step output. Injectable `_internal.claudeHome`/`_internal.now` seams keep it fully unit-testable. **Out of scope:** cross-model transcript parsers (stubs only), remote/webui OpenClaw transcripts (honest local skip), persistent history-list badge (→ CC-5). **No hook, no endpoint, no schema migration** (supersedes #376's hook-handshake framing). **Tests:** new `test/transcript.test.js` (resolve newest-wins/cwd-mismatch/fallback-scan/non-Claude-null; snapshot copy+meta; secret flag value-never-stored; honest captured:false) + extended `test/wrap-step-continuity-write.test.js` (snapshot wired+reported; throw swallowed, warm tier still written, wrap not halted). Full suite 3035 pass / 0 fail / 1 skip. Closes #376. Spec: `.prawduct/artifacts/cc-4b-transcript-snapshot.md`. Plan: `.claude/plans/cc-4b-transcript-snapshot.md`.

## 2026-06-17: Consolidated per-project continuity store — session-linked uploads + secret badge (CC-4, #343)

<!-- prawduct: type=feat | chunks=CC-4 | scope=tc-4.0 | status=shipped -->

**Why:** Realizes the Continuity Contract's "one home per project for all sessions and their data" storage model (`continuity-contract.md` §"Storage model & lifecycle"). The continuity hot/warm tiers already lived under `.tangleclaw/continuity/` (CC-1/2/3), but **uploads sat in a flat `<project>/.uploads/` dir** with no session attribution. CC-4 establishes the per-session sub-tree and relocates uploads into it, so a session's cold-tier data is co-located and the project is the single delete unit. **Store layout (`lib/continuity.js`):** new `sessionsRoot(projectPath)` + `sessionDir(projectPath, sid)` + `sessionUploadsDir(projectPath, sid)` under `sessions/<sid>/`, keyed by the same integer `session.id` used as the `session:<sid>` pointer (uniform retrieval; chunk R re-keys one root, not four). **Uploads (`lib/uploads.js` + `server.js`):** `saveUpload` gains an optional `sid` and writes under the session uploads dir; `POST /api/upload` resolves the active session via `store.sessions.getActive`. No active session → legacy flat `<project>/.uploads/` fallback. `listUploads` merges **both** (legacy reported `session: null`) newest-first — pre-CC-4 uploads keep appearing (back-compat by construction). **Secret badge (#343, new `lib/secret-scan.js`):** flag-only `scanText` over high-confidence patterns (AWS/Slack/GitHub/Google keys, PEM private keys, generic long-value secret assignments) on text uploads within a 1 MB cap; a hit is recorded in a per-dir `_scan.json` sidecar (**pattern types only, never the value** — asserted by a value-never-leaked test) and surfaced as an amber `.badge-secret` (`public/session.js`/`.css`). **Never scrubs or blocks** — operator remediates manually (§Secrets). **Cascade-delete (`lib/projects.js`):** the store lives under `project.path`, so `deleteProject({deleteFiles:true})` wipes the whole store by construction; `deleteFiles:false` deliberately preserves it (documented + regression-tested both ways). **Decisions (operator-ratified via AskUserQuestion):** transcript snapshot deferred → **CC-4b (#376)** (TC lacks Claude's `transcript_path`/`session_id` — needs a hook handshake + session-row schema migration; slots into the same `sessions/<sid>/` layout and reuses this scanner); uploads back-compat read (no risky file move); cascade inherits `project.path`. **Tests:** new `test/secret-scan.test.js` (each pattern + clean-prose negative + value-never-leaked invariant) + continuity path-helper, uploads (sid routing, legacy+session merge, flag manifest, binary-skip, sort) and projects (delete cascade both ways). Full suite 3022 pass / 0 fail / 1 skip. Critic cumulative→verify-resolutions chain (opus/escalate) CLEAN after resolving 2 WARNINGs (stale `FEATURES.md` uploads entry; sentinel-sid `sessionsRoot` reconstruction → real exported accessor). Spec: `.prawduct/artifacts/cc-4-consolidated-store.md`. Plan: `.claude/plans/cc-4-consolidated-store.md`.

## 2026-06-17: Continuity Map — self-maintained feature/component index (CC-3)

<!-- prawduct: type=feat | chunks=CC-3 | scope=tc-4.0 | status=shipped -->

**Why:** Adds the `## Map` section to the continuity hot index (`continuity-contract.md` §3 + "the Map"), generalizing the `features-toc` pattern. At wrap the Map **stubs** `- **TBD** — \`<path>\` <!-- describe -->` for touched source files not already referenced and **prunes** entries whose every referenced path was deleted (multi-file curated entries survive if any file remains; pure-prose entries never pruned); the AI fills/groups descriptions in-session. **Schema (`lib/continuity.js`):** `renderIndex`/`parseIndex` gain `## Map` (between `Next action` and `Freshness`); the Map is the one index section **preserved verbatim across wraps** (curated/accreted) while the rest is regenerated. New `updateMap(existingMapText, {touched, deleted})` pure stub+prune merge, and `readIndexRaw` (full parsed index incl. Map, returns even for a degraded no-judgment index `readIndex` would null). **Wiring (`lib/wrap-steps/continuity-write.js`):** before the rewrite, reads the prior Map, computes touched/deleted via `git diff --name-status <base>...HEAD` (A/M→touched, D→deleted, R→old deleted+new touched) filtered through reused `features-toc._isIndexableCandidate`, runs `updateMap`, writes the merged Map back; `blocker:false`, any failure (no base/git error) leaves the prior Map intact, never halts a wrap. **Scope:** continuity Map = internal hot-tier, **baseline** (no `featureIndexEnabled` toggle), **coexists** with the unchanged public-facing `FEATURES.md`; the index's `Active threads`/`Canonical artifacts` sections are deferred (not CC-3). **Tests:** +17 across `test/continuity.test.js` (Map round-trip + empty placeholder; `updateMap` stub/idempotent/prune-deleted-only/keep-multi-file/never-prune-prose/combined/no-op; `readIndexRaw` degraded+absent) and `test/wrap-step-continuity-write.test.js` (stub-touched, prune-deleted+preserve-curated across rewrite, no-base no-op, allowlist filter, `_mapDelta` A/M/D/R). Full suite 2999 pass / 0 fail / 1 skip. Spec: `.prawduct/artifacts/cc-3-continuity-map.md`.

## 2026-06-17: Continuity warm tier — per-session changelog + 8-section wrap summary + grep retrieval (CC-2)

<!-- prawduct: type=feat | chunks=CC-2 | scope=tc-4.0 | status=shipped -->

**Why:** Adds the **warm tier** of the Continuity Contract (`.claude/plans/continuity-contract.md`) on top of CC-1's hot index, in the same gitignored per-project store (`.tangleclaw/continuity/`). The contract's v1 retrieval is "grep over structured markdown" — reliability comes from write discipline (fixed format + stable `session:<sid>` pointers), not search tech. **Schemas (extend `lib/continuity.js`, pure render/parse mirroring CC-1):** `renderChangelogEntry`/`appendChangelogEntry` → per-session **append-only** `changelog.md` (`- <date> (session:<sid>) <line>` + optional `tags:`/`refs:`, omitted when empty); `renderWrapSummary`/`parseWrapSummary` (+`writeWrapSummary`/`readWrapSummary`) → one `wraps/<sid>.md` per session with YAML frontmatter (session/date/project/methodology/harness/branch/sha/tags, emitted only when present) + the 8 fixed `## sections`, honest-flagging uncaptured ones `_⚠ not captured_` (reuses `_unflag`). **Grep retrieval:** `search(projectPath, query, {section})` scans changelog + all wrap summaries (case-insensitive, optional section scope), returns structured matches carrying the `session:<sid>` pointer (the "this broke again" → drill-into-the-fix-session payoff). Pure JS scan — model-agnostic, zero-infra; SQLite FTS reserved as the scale option, `rg` is only a shell alias here. **Wiring:** `continuity-write` additionally appends the changelog + writes the wrap summary from `session.id`, `project.methodology`, `session.engineId`, git facts, and captured `summary`/`nextSteps`/`learnings` (→ Where we are / Next action / Landmines); still `blocker:false`, per-tier partial-failure flags, never halts a wrap. **Decisions:** session pointer = integer `session.id` (TC ids are autoincrement integers; the contract's `s_DATE_TIME` was aspirational — `date:` gives chronology); 4 uncaptured sections (Delta/Open threads/Decisions/Pointers) honest-flagged — extending the wrap prompt to emit all 8 overlaps CC-8, deferred → backlog. Store layout stays under `.tangleclaw/continuity/` (`changelog.md`, `wraps/<sid>.md`); the consolidated `sessions/<sid>/…` relocation is CC-4. **Tests:** +16 across `test/continuity.test.js` (changelog format/append-only/omit-empty/honest-flag; wrap-summary render + round-trip + frontmatter-omit; `search` changelog/section-scoped/pointer/case-insensitive/absent-store/empty-query) + `test/wrap-step-continuity-write.test.js` (warm-tier write, search-finds-just-written, session-absent skip, non-blocking partial failure). Full suite 2981 pass / 0 fail / 1 skip. Spec: `.prawduct/artifacts/cc-2-continuity-schemas.md`.

## 2026-06-17: PortHub auto-allocates non-colliding local_port/bridge_port for OpenClaw connections (#352)

<!-- prawduct: type=feat | chunks=352 | scope=tc-4.0 | status=shipped -->

**Why:** Every OpenClaw connection defaulted its tunnel `local_port` to `18789`; a second instance collided on the local bind — **detected** only at tunnel time (`tunnel.js` parses SSH "Address already in use") but never **prevented** at add-time. This is the surviving PortHub kernel of the descoped #332. **Helper:** `porthub.nextFreePort({ range: [start, end), host })` returns the first port in a half-open range that is neither held by a live lease (`store.portLeases.checkConflict`) nor OS-bound (`portScanner.isPortInUseBySystem`, localhost only); throws on a malformed or exhausted range. Delegates entirely to the existing `checkPort` — no new conflict logic. **Allocation hooks at the route layer** (`server.js` `POST /api/openclaw/connections`), not the store, because `porthub` already requires `store` (an allocator in `store` would invert the dep) and the route already conflict-checks an explicit `localPort` + releases on `DELETE`. Omitted `localPort` → `nextFreePort([18789, 18999))`; explicit → existing conflict check. **Lease-at-create** (operator-ratified over pick-only): the resolved port is leased under `oc-direct-<id>` the moment the row is created, closing the allocate→bind race so a second add reserves a different port even before the first tunnel binds; `DELETE` now releases the bridge port too. **`bridge_port` stays NULL-by-default** — load-bearing for #160 (a non-null bridge port emits a `-L <bp>:127.0.0.1:<bp>` SSH forward that kills non-ClawBridge tunnels); naive auto-allocation would reintroduce #160, so bridge auto-allocation is **opt-in** via the `bridgePort:"auto"` sentinel (`nextFreePort([3201, 3300))`), an explicit number is conflict-checked for parity, omitted/null/empty → null. **UI** (`public/index.html` + `public/ui.js`): Local Port field blank-with-`auto`-placeholder for new connections; `saveConnection` omits the key when blank (→ server auto-allocates on create; leaves the stored port unchanged on edit), sends a typed value verbatim — without this the form would hard-send 18789 and the feature would be dead-on-arrival. **Tests:** `nextFreePort` unit coverage (first-free, lease-skip, multi-skip, OS-bound-skip via monkeypatched scanner, host-scoping, exhaustion-throws, malformed-range-throws) in `test/porthub.test.js`; route-level collision-avoidance on consecutive adds, explicit-port-verbatim, lease-at-create, `bridgePort:"auto"` allocate+release, explicit-bridge-conflict rejection in `test/api-openclaw.test.js`. Two pre-existing #160 fixtures moved off the shared `3201` literal (incidental value; clearing/preservation contracts unchanged); one `ui-openclaw` test updated from the retired fixed-18789 default to range-membership. Full suite 2965 pass / 0 fail / 1 skip. Critic (chunk, opus): 0 blocking / 1 warning (stale prior-chunk test-evidence, resolved) / 0 note. **Out of scope (declared in spec):** PUT/update does not reconcile leases on port change; bridge auto-allocation has no UI affordance (API-only). Spec: `.prawduct/artifacts/chunk-352-porthub-nextfree.md`.

## 2026-06-17: Session-rules self-improvement loop — versioning, promotion, conflict gate (#347, D1b)

<!-- prawduct: type=feat | chunks=D1,D1b | scope=tc-4.0 | status=shipped -->

**Why:** Completes the ratified D1 on top of D1a (the `chunks=D1` tag here flips the `Chunk D1` Status box; D1 = D1a + D1b, both now shipped). **Versioning + rollback (schema v18→v19):** new `session_rule_versions` table snapshots a rule's full state after every mutation (`create`/`update`/`delete`/`restore`; `version_no` monotonic per rule; `rule_id` is a logical ref with no FK cascade so history **survives a delete** for audit). `store.sessionRules` gains `listVersions`/`restore`; `create`/`update`/`delete` take optional `changedBy`/`changeReason` so the trail distinguishes operator vs AI authorship. **Learnings→rule promotion:** `promoteFromLearning(learningId, overrides)` creates a `created_by:'ai'` rule with provenance in a new nullable `source_learning_id` column (FK to `learnings`, `ON DELETE SET NULL`); operator-confirmed, never auto-runs. **Conflict-candidate signal:** `findConflictCandidates` returns active in-scope rules sharing ≥2 significant tokens with a proposed edit — explicitly NON-authoritative (the ratified design forbids semantic auto-resolution). **API:** `POST /promote`, `POST /conflicts`, `GET /:id/versions`, `POST /:id/restore`. **UI:** per-rule History disclosure (version list + Restore) + an AI badge. **Critic gate (in-session agent capability, not server code):** per CONSTRAINT 1 (TC's server can't summon a Critic), the gate for conflicting/autonomous edits is a documented in-session procedure — stage the proposed edit as a git-tracked scratch file (`.prawduct/` is gitignored → invisible to the Critic), snapshot/restore `.critic-findings.json` around the pass, invoke `/prawduct:critic`, capture findings; non-Claude harness falls back to discussion + operator decision. Canonical doc: `docs/session-rules-self-improvement.md` (proven empirically during D1b planning). **Tests:** new `test/session-rules-selfimprove.test.js` + `test/api-session-rules-selfimprove.test.js`, extended `test/session-rules-panel.test.js`, schema-version assertions bumped to v19. Full suite 2953 pass / 0 fail / 1 skip. Critic (cumulative, opus/escalate): 0 blocking / 0 warning / 5 note (all deliberate documented decisions → backlog). Independent PR review (opus): 0/0/2-informational, Critic record audited. **Merged to `main` via PR #371 (`51aafb2`) 2026-06-17.** Upstream Critic-contract questions filed at brookstalley/prawduct#95; session-continuity idea at #96 (TC fallback: Jason-Vaughan/TangleClaw#372). Plan: `.claude/plans/d1b-self-improvement.md`.

## 2026-06-16: Session rules — durable cross-model behavioral directives store + UI (#347, D1a)

<!-- prawduct: type=feat | chunks=D1a | scope=tc-4.0 | status=shipped -->

**Why:** D1a is the standalone-valuable slice of the ratified D1 (session_rules layer) — the store + cross-model launch injection + CRUD + a basic operator UI. It fills the gap between AI-accumulated `learnings` and the structured core/extension toggles: durable operator-authored directives that ride the same cross-model injection path as global-rules. New `session_rules` table (schema v17→**v18**): nullable `project_id` (NULL = global / applies to every project; set = that project, schema-ready for D1b + the CC-6 Project Rules modal), `enabled`, `created_by` (`operator` default / `ai` for D1b), nullable `owner` auth-seam, timestamps; v17→v18 migration is fail-safe (`CREATE IF NOT EXISTS` in both `_createTables` and the guarded step). `store.sessionRules` API: `listActiveForProject` (the injection query — global + project's own active rules, ordered), `list({enabled,projectId,scope})`, `get`/`create`/`update`/`delete` with `session_rule.*` activity logging + content trim/non-empty validation + cascade-on-project-delete. Cross-model injection: `engines._getRulesContent` loads `sessionRulesLines` (guarded, fails soft); all four generators (`_generateClaudeMd`/`_generateGeminiMd`/`_generateCodexYaml`/`_generateAiderConf`) render a `## Session Rules` section adjacent to the global-rules block, each exactly the way it already renders `globalRules` (codex content lands inside the `instructions: |` block scalar), rendering **nothing when empty**. Picked up on a project's next session launch / sync (no new regen trigger). REST: `GET` (optional `?scope=global`/`?projectId=`), `POST`, `PUT /:id`, `DELETE /:id` under `/api/session-rules` (256 KB body cap + non-empty validation). UI: a dash-bar **Session Rules** panel (list + per-rule enable toggle + delete + add form) managing **global** rules; per-project authoring UI deferred to CC-6. Scope = D1a only — AI autonomy, version/rollback, and learnings→rule promotion are **D1b** (its own next chunk; prototype-first unknown = programmatically trigger `/prawduct:critic` + capture findings). Tests: new `test/session-rules.test.js` (store CRUD, injection incl. disabled/other-project exclusion, `created_by` default, cascade, logging), `session rules injection (#347/D1a)` block in `test/engines.test.js` (all-4 generators + render-nothing + global+per-project), `test/api-session-rules.test.js` (route lifecycle + 400/404), `test/session-rules-panel.test.js` (frontend structural); schema-version assertions bumped 17→18 across 5 files. Full suite 2926 pass / 0 fail / 1 skip. Critic (verify-resolutions chain over cumulative `00e5245` → `cf0cee8`): 0 blocking / 0 warning / 0 note. **Merged to `main` via PR #370 (`6581b99`) 2026-06-16.** Status is `merged` (not `shipped`) — matching the #347 precedent: the chunk's parent `Chunk D1` box stays UNCHECKED because the sibling slice (D1b) remains. This `chunks=D1a` tag does NOT flip the `Chunk D1` Status box (D1 = D1a + D1b; the box flips when D1b ships, tagging that entry `chunks=D1`). `.prawduct/` is gitignored on TC → the tracked changelog is root `CHANGELOG.md`. Plan: `.claude/plans/d1a-session-rules.md`.

## 2026-06-16: Retire the V1 platform template + visible governance-drift indicator (#353, C2)

<!-- prawduct: type=feat | chunks=C2 | scope=tc-4.0 | status=shipped -->

**Why:** Two coupled cleanups that make governance honest and visible. **(1) Template strip** — `data/templates/prawduct/template.json` no longer ships V1 L3/L4 governance to non-TC projects: `hooks.claude` emptied (dropped the `product-hook` SessionStart/Stop hooks, already inert since #336 deleted the binary — the `requires` gate fails closed), L3 `critic-check` wrap step removed, `schemaRevision 2→3` so the framework-subtree reconcile propagates the step change. The cross-model native base stays (L0 rules, L1 prime [emitted separately by engines.js], L2 wrap [now 9 steps], evalDimensions, actions). Effect: a newly-created project can no longer inherit V1 governance; opted-in Claude projects get L3/L4 from the V2 plugin (migration shipped in C1). **(2) Drift indicator** — `engines.governanceState(projectPath, {engineId, methodology})` → `governed-plugin | governed-vendored | drift-no-governance | not-applicable` (reuses `isPluginGoverned` + the `tools/product-hook` requires-predicate; engine/methodology from the canonical DB row, not stale `project.json`; fails closed to drift on malformed settings). Surfaced on the enriched project object (rides `GET /api/projects[/:name]`, no server change) and rendered as an amber `⚠ governance drift` badge (`public/ui.js`/`.badge-drift`), shown ONLY for `drift-no-governance` (Cohort B: labeled prawduct + Claude but on neither plugin nor vendored hook → Stop-gate/Critic silently off, #353); self-clears on next list fetch post-migration. No session advisory (would cross the #336 plugin/runtime boundary). Scope ratified with operator = strip + drift; **birth-config (auto-write V2 ref for NEW Claude projects) deferred → #368** (the strip alone already makes "new projects never get V1" structural). ~12 strip-contract tests re-pinned to the post-C2 shape (positive "absent" assertions, not weakened); methodology-flip suite re-homed onto a synthetic hooked methodology (no shipped methodology declares hooks post-strip); new `governanceState` + drift-badge tests. Full suite 2885 pass / 0 fail / 1 skip. Critic (verify-resolutions chain over cumulative `00e5245` → HEAD): 0 blocking / 1 warning (stale node-test evidence, resolved) / 0 note. Plan: `.claude/plans/c2-retire-v1-template.md`.

## 2026-06-16: Per-project migration to the V2 plugin — hybrid onboarder (#262, C1)

<!-- prawduct: type=feat | chunks=C1 | scope=tc-4.0 | status=shipped -->

**Why:** First operational consumer of chunk B's deferral — a cohort-aware, session-safe action that migrates a Claude project from vendored/drift governance to the V2 plugin. `engines.migrateToPlugin` writes the plugin ref into `.claude/settings.json` (sourced from TC's OWN settings → uses the current pin, no hardcoded version), non-destructively + idempotently, refusing to clobber a malformed file; then re-syncs hooks so `isPluginGoverned`→true suppresses the vendored `product-hook` governance hook (neutralize-by-reference-drop, no file delete) while keeping L1 prime. `projects.migrateProjectToPlugin` (`POST /api/projects/:name/migrate-to-plugin`) adds the gates: Cohort C (non-Claude) → `not-applicable` no-mutation; live session → defer (never auto-close, via #347); activation honesty → `migrated` only if installed at machine scope, else `pending-activation`. New persisted `migration_status` column (schema v17), surfaced on the enriched project for the C2 drift indicator. Planning reconciled C1 against shipped B: B already built the detect contract (`isPluginGoverned`) + a better mechanism than the design-doc's "repoint template hook," so C1 = the migration action only (risk MEDIUM, not HIGH). Template-strip + drift indicator (#353) → C2. +19 tests (`test/c1-plugin-migration.test.js`); schema-version assertions bumped to v17 across store/webui tests; full suite 2866 pass / 0 fail / 1 skip. #262 rewritten from its obsolete V1-sync-sweep body. Spec: `.prawduct/artifacts/c1-hybrid-onboarder.md`.

## 2026-06-16: Per-session scope guard — flag wrong-tab requests before acting (#340)

<!-- prawduct: type=feat | chunks=340 | scope=tc-4.0 | status=shipped -->

**Why:** First consumer of the #347 ownership primitive. Every session's prime now carries a `## Scope Guard` directive on top of Slice 3's identity-only `## Session Ownership` block: flag a request that clearly belongs to a different project before acting (edit/commit in another repo's territory), name the likely tab when known, and wait for the operator — **surface, never refuse** ("do it here" always overrides). Generalizes the cross-session write-boundary rule and mechanizes the operator's standing `feedback_flag_wrong_session_work` preference. New `sessionOwnership.scopeGuardSection(project)` (`lib/session-ownership.js`), injected in `generatePrimePrompt` (`lib/sessions.js`) right after the identity block — kept a separate function so Slice 3's identity-only contract holds. "Other tabs" list = `listLive()` minus the owned project, **filtered to confirmed-live only** (`o.live` — real `tmux.hasSession` probe for local; db-only for remote until #347 Slice 2b), so a stale `active`/`wrapping` row with a dead pane isn't named as a phantom tab. Launch-time snapshot, uncapped (capping could hide the very tab a request belongs to); always-on, no toggle. +7 tests; full suite 2848 pass / 0 fail / 1 skip. Critic verify-resolutions chain over cumulative `00e5245` → HEAD: 0 blocking / 0 warning / 0 note (also cleared the prior session's stale-evidence warning). Decisions: `.prawduct/artifacts/session-ownership-primitive.md` → "Chunk #340".

## 2026-06-16: Session-ownership primitive — core (Slices 1 + 2a + 3) (#347)

<!-- prawduct: type=feat | chunks=347 | scope=tc-4.0 | status=shipped -->

**Why:** A first-class, queryable `session ⇒ owned project` object, built once and shared so its three 4.0 consumers — #340 (scope guard), #333 (Switchboard), #331 (Project Master) — read one object instead of each growing a subtly-incompatible one. New `lib/session-ownership.js`: `resolveBySessionId`/`resolveByProject`/`listLive` returning a structured host-qualified address (`host/project#sessionId`) **derived, not persisted** — reuses `sessions.id` as the N-ready handle key, no migration. **Slice 1** = read object + store reads (`sessions.get(id)`, `listLiveAll()`); **2a** = `_localHost()` resolves the real Tailscale Magic DNS name (`tailscale status --json`→`.Self.DNSName`, fallback hostname→localhost, memoized); **3** = `primeSection()` injects owned-project identity into `generatePrimePrompt` (identity only — flagging is #340's). Local tmux liveness confirmed against the session's own `tmuxSession`; openclaw (remote) + paneless `webui` fall back to db liveness; `resolveByProject` resolves active OR wrapping. **Slice 2b** (accurate remote ClawBridge liveness) deferred — blocked on a ClawBridge status contract (separate repo), tracked in #364. 32 new tests; full suite 2841 pass / 0 fail / 1 skip. Discovery + decisions: `.prawduct/artifacts/session-ownership-primitive.md`. Reviews: 3 chunk-mode Critic passes + cumulative (0 blocking; 2 warnings fixed) + verify-resolutions.

## 2026-06-16: Session-resume single source of truth + shipped-chunk backfill (#355)

<!-- prawduct: chunks=0,B,CC-1,355 | status=shipped | scope=tc-4.0 -->

**Why:** Ended the recurring stale-resume bug — four stores each claimed a different "next" and none reconciled. Canonical "what's next" now lives ONLY in `.prawduct/artifacts/build-plan.md` `## Status` (first unchecked = next chunk); `project-state.yaml work_in_progress` names no chunk (anti-stale pointer), and the `.claude/plans/` design doc + auto-memory carry "non-authoritative, see canon" banners. This entry also backfills `chunks=|status=shipped|scope=tc-4.0` tags so `regen-views` derives the Status checkboxes correctly under `views_enabled` instead of resetting them. Merge state: **chunk 0 (#334, via PR #361), B (#335), and CC-1 (#351) are all merged on `main`** (PR #361 merged this same session, closing #334). Verified: plugin briefing reads `Work: TangleClaw 4.0…` / `Resume: <first unchecked>` and the handoff `Task:` is the anti-stale pointer, with no staleness warnings.

## 2026-06-15: CC-1 — visible "we left off at X" continuity resume loop

<!-- prawduct: type=feat | chunks=CC-1 | scope=tc-4.0 | status=shipped -->

**Why:** Thin first slice of the 4.0 Continuity Contract. New `lib/continuity.js` (hot-index store under gitignored `.tangleclaw/continuity/`) + `lib/wrap-steps/continuity-write.js` (writes the index after `commit`; honest-empty degrade; never blocks a wrap) + `generatePrimePrompt` READ-half upgrade (passive "Last Session Summary" → actionable visible-`## Resume` directive: freshness-check-first, banner re-emit, confirm-before-fire). Fixes the stale-handoff + invisible-banner pains the Contract was written to kill. Critic clean (0/0/0); full suite 2806 pass / 0 fail / 1 pre-existing skip.

## 2026-03-12: Seeded project state from intake brief

**Why:** Pre-discovery context from v2 development, methodology analysis, and confirmed architectural decisions

**Classification:** directional

## 2026-03-12: V1 scope confirmed — 10 categories, with user corrections promoting skills, PortHub, phase-aware context, enforcement rules, and learning capture

**Why:** User review caught dependency gaps (skills required for lifecycle) and contractual requirements (PortHub)

**Classification:** directional

## 2026-03-12: OpenClaw governance removed from v1 — Mission Control is a separate project

**Why:** Workshop vs mission control separation. TangleClaw manages sessions; persistent agent governance needs its own purpose-built tool. Genesis becomes just an engine profile.

**Classification:** directional

## 2026-03-14: Discovery Critic warnings addressed — node:sqlite fallback documented, project-preferences populated, core_flows derived

**Why:** Critic found 3 warnings blocking planning: undocumented experimental risk, empty preference/flow fields

**Classification:** directional

## 2026-03-14: Planning complete — 13 artifacts generated, 8-chunk build plan defined

**Why:** All planning artifacts (product brief, data model, NFRs, security, test specs, operational, observability, dependencies, API contracts, interaction design, boundary patterns, preferences, build plan) created in dependency order

**Classification:** directional

## 2026-03-14: Chunk 1 complete — Foundation (Store, Server, Logger) built with 70 tests

**Why:** lib/logger.js, lib/store.js, server.js, 4 engine profiles, 1 methodology template, 4 API endpoints (health, version, config GET/PATCH). Critic: 0 blocking, 4 warnings (password hashing deferred to Chunk 4, activity logging deferred to Chunk 5, health handler async logging fixed, permissions check added).

**Classification:** build

## 2026-03-14: Chunk 2 complete — Core Backend (tmux, git, system, engines) built with 70 tests (140 total)

**Why:** lib/tmux.js, lib/git.js, lib/system.js, lib/engines.js, 5 API endpoints (system, engines list/detail, tmux mouse set/get). Critic: 0 blocking, 2 warnings (env var ordering bug fixed, api-contracts.md disk info note corrected), 1 note (inline require moved to top-level).

**Classification:** build

## 2026-03-14: Chunk 3 complete — Methodology Engine built with 87 tests (227 total)

**Why:** lib/methodologies.js (validation, detection, init, switching, status contract, phases), store.projectConfig API, prawduct+tilt templates, 2 API endpoints (methodologies list/detail). Critic: 0 blocking, 2 warnings (description added to required validation, YAML parser indentation behavior documented), 2 notes (boundary-patterns filename fixed, shell execution documented).

**Classification:** build

## 2026-03-14: Chunk 4 complete — Project Management + PortHub built with 108 tests (335 total)

**Why:** lib/projects.js (create, enrich, update, delete, auto-detect, password hashing), lib/porthub.js (register/release/check ports, graceful degradation), store.projects.* CRUD, store.activity.* logging, store.sessions.* read-only, 5 API endpoints (projects list/detail/create/delete/update). Password hashing via scrypt with auto-upgrade from plaintext. Critic: 0 blocking, 3 warnings (boundary-patterns references fixed, scaffold field deferred in contract, mocked PortHub happy-path tests added), 2 notes.

**Classification:** build

## 2026-03-14: Chunk 6 complete — Landing Page UI built with 25 tests (458 total)

**Why:** public/index.html (semantic HTML, PWA meta, modals, drawers), style.css (691 lines, mobile-first, v2 palette), landing.js (276 lines, state/API/data), ui.js (399 lines, rendering/interactions), manifest.json (PWA), sw.js (cache-first static, network-first API+HTML with offline fallback), test/api-integration.test.js (25 tests covering all landing page API response shapes). Critic: 0 blocking, 5 warnings addressed (manifest theme_color fixed, touch targets bumped to 44px, wrap modal replaced prompt(), duplicate class attr fixed), 3 notes (CSS 400-line exception documented, font size spec conflict noted, SW API cache now stores responses).

**Classification:** build

## 2026-03-14: Chunk 7 complete — Session Wrapper UI built with 56 tests (514 total)

**Why:** public/session.html (session wrapper page with banner, command bar, terminal iframe, peek drawer, settings/kill/wrap modals), session.css (mobile-first styles, v2 palette, 44px touch targets, safe areas, breathing status dot, engine badges), session.js (API polling, chime system with Web Audio, command bar with engine pills and history via createElement, peek drawer, settings persistence via localStorage, mouse guard, session-ended countdown), server.js (session page route for GET /session/:name, terminal reverse proxy with HTTP + WebSocket forwarding). Critic: 0 blocking, 4 warnings addressed (mobile button min-width kept at 44px, interaction-design.md updated for server-side idle detection, boundary-patterns.md file paths corrected, innerHTML replaced with createElement for XSS safety), 3 notes addressed (console.warn added to catch blocks, test file naming and architecture divergence from build plan documented).

**Classification:** build

## 2026-03-14: Chunk 8 complete — Integration, Polish, Launch Readiness with 31 tests (545 total)

**Why:** test/migration.test.js (8 tests — detectExistingProjects thorough coverage), test/contracts.test.js (15 tests — all API response shapes validated against api-contracts.md), test/e2e-smoke.test.js (5 tests — happy-path lifecycle through API). deploy/ (launchd plists + install.sh), hooks/ (pre-commit, commit-msg, post-commit), README.md, CHANGELOG.md.

**Classification:** build

## 2026-03-14: Chunk 10 complete — PortHub Deep Integration with 18 new tests (563 total)

**Why:** Embedded port lease management in SQLite (port_leases table, schema v2). lib/porthub.js rewritten from shell-out to store-backed. 4 new API endpoints (GET /api/ports, POST /api/ports/lease|release|heartbeat). Landing page ports panel. AI assistant guide (data/porthub-guide.md) injected into CLAUDE.md. Server bootstrap/shutdown for infra ports. One-time migration from old PortHub daemon. Install script updated.

**Classification:** build

## 2026-03-14: Chunk 9 complete — User Documentation and Distribution Readiness

**Why:** docs/user-guide.md (~230 lines), docs/methodology-guide.md (~170 lines), docs/engine-guide.md (~120 lines), docs/configuration-reference.md (~150 lines). README updated with docs links. CHANGELOG updated with docs entry. All four acceptance criteria met: new user can follow install-to-wrap, create custom methodology, add engine, and find all config fields documented.

**Classification:** build

## 2026-03-14: Chunk 11 complete — First-Run Setup Wizard with 17 tests (580 total)

**Why:** setupComplete config field with existing-install migration. POST /api/setup/scan scans any directory for projects. POST /api/setup/complete batch-updates config + attaches projects. Six-step wizard overlay UI (welcome, projects dir, detect, engines, preferences, confirm) with skip button. CSS styles following existing patterns. Docs updated (user guide, config reference, CHANGELOG, api-contracts).

**Classification:** build

## 2026-03-15: Phase 2 Chunks 6+7 complete — Port Scanner + Parity Tracking (689 total tests)

**Why:** P2-6: lib/port-scanner.js (lsof-based TCP scan, periodic scanning, cache). P2-7: validateParity() in lib/engines.js, 8 cross-feature integration tests (Gemini full config, global rules propagation, port scanner conflict detection, parity equivalence), parity checklist in docs/engine-guide.md. Critic: 0 blocking, 1 warning fixed (project-state.yaml updated), 2 notes.

**Classification:** build

## 2026-03-14: Chunk 5 complete — Session Lifecycle built with 98 tests (433 total)

**Why:** lib/sessions.js (launch, prime prompt generation, idle detection, wrap orchestration, peek, command injection, kill, history), lib/skills.js (skill loading, wrap skill), store.sessions.start/wrap/kill/markCrashed/count, store.learnings.* full CRUD with auto-promotion, 8 API endpoints (sessions launch/kill/status/command/wrap/peek/history, activity). Critic: 2 blocking fixed (command length validation added per security-model.md, COUNT(*) replaced inefficient session list for totals), 5 warnings addressed (busy-wait replaced with spawnSync sleep, dead code removed, idle cache leak acknowledged, LIMIT string interpolation noted).

**Classification:** build
