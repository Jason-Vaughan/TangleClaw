---
title: "Train A Car A3: wrap intent, artifact admission, and honest cancellation"
status: IN PROGRESS — Chunks 01 (PR #1807) and 02 (PR #1811) shipped; Chunk 03 dispatched by the PM 2026-09-23 (message 7845b64b), building on fix/a3-chunk3-admission-drafts, Architect ruled F1–F5 APPROVE (message 5b0eaa0d); Chunk 04 and P1 remain; Architect ruled C1–C2, D1–D5 (message 417454d7) and E1–E6 (message 9a774624); PM approved plan and order (message 8219ab12)
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-23 (messages ecdbe884, 39998da1)
issues: [1708, 1707, 1738, 1724, 1507, 1675]
governed_by:
  - Architect roadmap, "Car A3 — wrap intent, artifact admission, and honest cancellation" (TangleClaw-Architect/.tangleclaw/plans/v5-v6-backlog-census-and-bridge-roadmap.md)
  - "#1738 Architectural ruling (2026-09-21): engine portability; wrap gates classified, never a bypass that reads as passed"
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION
  - project rule: Train chunks of at most 3–4 issues, one chunk per session
scope: train-a-car-a3
branch: fix/a3-chunk3-admission-drafts
partition: serial. Chunks 01, 02 and 04 all change the wrap run's result shape and the drawer that renders it; running them in parallel would fight over lib/sessions.js, lib/wrap-pipeline.js and public/wrap-drawer.js
critic_mode: chunk per chunk, cumulative at the last chunk
---

# Train A Car A3: wrap intent, artifact admission, and honest cancellation

## Acceptance gate (PM dispatch, 2026-09-23, from the train manifest)

Intent is explicit. Unsupported cancellation is represented honestly. Tracked-file admission is a
positive decision. Unavailable draft preservation fails visibly instead of fabricating recovery
evidence. A successful wrap binds to the exact final publication the next launch consumes, and
stale or fallback provenance is exposed before any action is proposed. Engine portability is
required throughout: moving a Prawduct-onboarded project to Gemini/Codex preserves its onboarding
and data unmutated, and returning to Claude revalidates with `/prawduct:doctor`, never a fresh
onboard.

## Chunks (car-level, ordered)

Six issues exceed the 3–4-per-chunk rule, so the car splits. Each chunk is one session and one PR.

| # | Chunk | Issues | Acceptance clause it owns |
|---|---|---|---|
| 01 | Wrap intent is explicit and cancellation is honest | #1708, #1707 | intent explicit; unsupported cancellation honest |
| 02 | Wrap gates are engine-aware and never read as passed | #1738 | engine portability; no false green |
| 03 | Admission is a positive decision; drafts fail visibly | #1724, #1507 | tracked-file admission; draft preservation |
| 04 | A successful wrap binds to the publication the next launch reads | #1675 | exact final publication; stale/fallback provenance |
| P1 | startupControl (planning only) | none yet | not an A3 acceptance clause; admitted by the PM for planning only |

**Order rationale.** 01 comes first because it changes the wrap run's request and result
contract (a resolved intent, a cancel outcome), and 02 and 04 extend that same result. Settling it
first means later chunks add fields instead of reshaping them. 04 comes last because it binds the
*final* result to a publication, so it should be built on the shape the others leave.
**Rejected:** #1738 first because it is labelled V5-FIX P0. It is the chunk with the most open
design (new gate outcomes, a new engine capability), and building it on a result shape that 01
then changes would mean doing that work twice. If the PM wants P0 first, 01 and 02 swap and
nothing else moves.

**P1 — startupControl.** The Architect authorized planning a native, capability-negotiated
`startupControl` for engine startup (wraps 1097/1101). The PM admitted it to this car *for
planning*. No schema or per-engine adapter is built in A3 until the Architect rules on the
schema. The planning note (native channel, readiness, semantic receipt, operator-blocked cases)
is written as its own section after Chunk 04 is planned, not inside any build chunk.

## Chunk 01: Wrap intent is explicit and cancellation is honest (#1708, #1707)

### Confidence check

1. **Problem.** Any wrap not started from the modal ends the session, whatever the operator said,
   because `keepSessionRunning` is only ever supplied by the modal checkbox and absence means kill
   (`lib/sessions.js` `keepRequested`). The PM wrapping a peer, or a scripted `POST`, cannot carry
   the operator's standing instruction (#1708). Separately, the drawer offers a control that
   reads as stopping a live wrap, but no abort exists anywhere. The run commits, opens a PR, arms
   auto-merge and kills the session after the operator believes it stopped (#1707).
2. **Success.** A project can record "keep the session running after a wrap". Every wrap entry
   point inherits it when the request omits the flag. Every run announces, before it acts, whether
   it will end the session and where that answer came from. While a run is live, the drawer's
   hide control says it hides and that the run continues. A real **Cancel wrap** stops the run at
   the next step boundary *before the first repository mutation*, leaves the session running, and
   reports which steps had already run. Once the commit step has started, Cancel is refused with a
   reason, not faked.
3. **Out of scope.** Rolling back a commit, a pushed branch or a PR (a post-commit cancel is
   refused, not reverted). Interrupting a step mid-flight. The stranded Medusa inbox noted in
   #1708 (a separate issue if not already filed). Engine gates (02), file admission (03) and
   publication binding (04).

### Facts established while planning (verified against code, 2026-09-23 at e4f0749)

- There is exactly one wrap entry route: `POST /api/sessions/:project/wrap` (`server.js`), which
  passes `body.options` to `sessions.startWrap`. The PM/Master is barred from every POST
  (`lib/master.js`), `tc` has no wrap verb, and a peer or PM wrap uses this same route. So
  "every entry point" is one server function plus its three UI callers: the session modal, the
  drawer's Retry, and the landing-page modal.
- `keepSessionRunning` is read in **two** places: the kill decision after the pipeline
  (`_runClaimedWrap`), and `lib/wrap-steps/handoff-stage.js`, which picks a `checkpoint` vs `final`
  handoff *mid-run*. A default resolved only at the kill site would stage a `final` handoff for a
  session that is then kept. The default must therefore be resolved **once, before the claim**, and
  written into the options every reader sees (project learning 2026-09-22: a decision read at
  several sites needs inputs that cannot change between them).
- Per-project wrap preferences already live in `.tangleclaw/project.json` (`releaseMode`,
  `wrapAutoPrEnabled`, `wrapStepOverrides`), resolved by `lib/project-config.js` with a reported
  `source` (`resolveReleaseMode`) and validated in the PATCH handler in `lib/projects.js`. There is
  no per-session preference store.
- The pipeline loop (`lib/wrap-pipeline.js`) has no abort signal, but it already has a stop shape:
  once `blockedAt` is set, every later step is recorded `pending` and skipped. The registry entry
  (`lib/wrap-run-registry.js`) holds live run state and is the natural home for an abort request.
  The options object is copied at `begin`, so it cannot carry a live flag.
- Steps before `commit` write nothing to the repository. They stage content for `commit`. But
  `learnings-db-write` and `rule-proposal` write the TangleClaw DB, and `changelog-update` sends a
  prompt into the session, before `commit`. So a pre-commit cancel leaves the **repository** as it
  found it, but not necessarily the DB. The cancel report must name the steps that ran rather than
  claim a clean undo.
- The live-run dismiss control is labelled **"Close"** (`public/session.js`, `session.html`).
  "Cancel" appears only on a finished or blocked report. The issue's "Cancel" was that report's
  button or the modal's. Either way, nothing on the page stops a run.
- The idle "Wrap" label while a server run continues comes from the `stalled`, `lost` and
  `refused`-without-result phases (`public/wrap-drawer.js` `wrapButtonView`), not from dismissing a
  live run. Dismissing a `stalled` run resets the controller to idle, and a new POST can then take
  over the stale slot while the old pipeline is still running.

### Architectural decisions (proposed; sent to the Architect at plan-written)

- **D1: The default comes from a per-project setting, resolved once before the claim.**
  `.tangleclaw/project.json` gains `wrapKeepSessionRunning` (boolean; absent means `false`, today's
  behaviour). `startWrap` resolves the effective value in this order: the request's boolean, then
  the project setting, then `false`. It records `{ keepSessionRunning, keepSource: 'request' |
  'project' | 'default' }` into the options *before* `wrapRunRegistry.begin`, so the registry,
  `handoff-stage` and the kill decision read one value. The modal checkbox opens pre-ticked from
  the setting instead of always unticked. The setting is editable through the existing project
  PATCH, validated as a boolean.
  *Rejected:* a per-session preference (no store exists, and a session is the thing being ended).
  *Rejected:* flipping the global default to "keep", which silently changes #1558's
  wrap-ends-the-session contract for every caller. *Rejected:* making the flag mandatory on the
  route, which breaks every existing caller.
- **D2: Every run announces its planned session outcome before acting.** Additive fields
  `sessionOutcomePlanned: 'end' | 'keep'` and `keepSource` go on the 202 response, on
  `GET /wrap/status`, and on the `run-start` stream event (added to the event vocabulary). The
  drawer shows it in words ("This wrap will end the session: project setting") from the first
  frame. *Rejected:* leaving clients to derive it from the echoed `options`, which puts the
  resolution rule in every client.
- **D3: A real cancel, bounded to before the first repository mutation.** New route
  `POST /api/sessions/:project/wrap/cancel` with body `{ runId }`. It is gated like `POST /wrap`
  (same password gate; the Master is barred as for all POSTs). The `runId` is required, so a
  cancel can never land on a different run than the one the caller is watching. Results:
  - `202 { cancelRequested: true, willStopBefore: <next step id> }` while the run has not reached
    `commit`. The registry records `abortRequested`, and the loop checks it at each step boundary.
    The run then finishes with `ok: false`, `cancelledAt: <step id>`, later steps `pending`, the
    session left **active** (like a stopped run), any staged handoff abandoned, and a list of the
    steps that ran.
  - `409 WRAP_NOT_CANCELLABLE` naming the current step once `commit` (or any later step) has
    started, because the run may already have branched, committed, pushed or opened a PR.
  - `404 WRAP_RUN_NOT_FOUND` when `runId` is not the live run.

  The step running when cancel arrives finishes. It is not interrupted.
  *Rejected:* interrupting the running step (unsafe mid-`git` or mid-prompt). *Rejected:* allowing
  cancel after commit and reverting (destructive: the PR and auto-merge may already be armed).
  *Rejected:* the issue's option 2 alone (relabel only). It removes the false signal but leaves no
  way to stop a wrap that would end a session the operator wanted kept.
- **D4: A cancelled run is a new, distinct outcome, not "blocked".** The result carries
  `cancelledAt`, the stream's `run-done` carries `outcome: 'cancelled'`, and the drawer renders
  "Wrap cancelled before <step>. These steps had already run: …". *Rejected:* reusing `blockedAt`,
  which would offer Retry/Skip as if a gate had stopped the run and would read as a failure the
  operator must resolve.
- **D5: The live-run dismiss control is labelled "Hide" and says the run continues.** A separate
  **Cancel wrap** button appears only while the run is cancellable. After `commit` starts it is
  replaced by the plain text "Past the point of cancelling: the wrap is committing." This is the
  operator-facing procedure part of #1707.

### Architect rulings (2026-09-23, message 417454d7) — binding

The PM approved the plan and the chunk order (message 8219ab12). Architectural approval does
not certify implementation, tests, Critic or merge readiness.

- **C1: ACCEPT** as the technical dependency order. The PM keeps scheduling authority.
- **C2: ACCEPT**, planning only. A3 contains no startupControl schema, adapter or boot
  execution unless there is a separate plan-written schema ruling and a canonical issue. #1774
  owns the direction for the uppercase TC command contract. An adapter build still needs scope
  that has been explicitly admitted.
- **D1: MODIFY.** The precedence and the project setting stand. Three fail-closed rules are
  added:
  1. Only a boolean request field that is explicitly present overrides. Never coerce it, and never
     trust a caller-supplied `keepSource` or `sessionOutcomePlanned`.
  2. A config that is absent, or a key that is absent, means `false` with source `default`. A
     config that is unreadable, malformed or invalid **refuses before the claim** rather than
     silently choosing either outcome. This supersedes the plan's "invalid reads as keep".
  3. A Retry keeps the original server-resolved value and source from the trusted run record,
     unless the new request explicitly changes the boolean.

  Resolve once, before `begin`, and use that immutable value everywhere.
- **D2: MODIFY.** The additive fields stand, derived on the server for the 202, the status and
  `run-start`. Operator copy is **conditional**: "If this wrap completes, it will end/keep the
  session (source)". Blocked, failed and cancelled runs leave the session active, so the plan is
  never phrased as a guaranteed terminal outcome.
- **D3: MODIFY.** The route, the gate, the mandatory `runId`, no mid-step interrupt and the hard
  cutoff before `commit` all stand. Changes:
  - Cancel admission and the step-start transition are **one atomic registry decision**, so a
    202 can never race `commit` starting.
  - A repeated cancel is idempotent.
  - `willStopBefore` is the first step that has not started, and the response shows that the
    current step is still finishing.
  - If an accepted cancel arrives during a step that then reports a blocker, **cancel wins** as
    the terminal outcome and that step's result stays visible.
  - **Corrected side-effect boundary:** the guarantee is no commit, branch, push, PR, auto-merge
    or later durable Git action. It is *not* "repo untouched". Pre-commit ai-content steps can
    edit the working tree, and preflight and other steps can write local methodology or DB state.
    Report every completed step and warn that uncommitted or local side effects may remain. Never
    roll them back or call the result a clean undo. Tests assert no durable Git or remote action,
    not a byte-identical worktree.
- **D4: ACCEPT**, with this shape: `ok:false`, `blockedAt:null`, `error:null`,
  `cancelledAt:<first not-started step>`, later steps `pending`, and a terminal
  `outcome:'cancelled'` in the stored result, the status and `run-done`. The session stays active
  whatever `sessionOutcomePlanned` says. A cancelled run offers neither Retry nor Skip.
- **D5: MODIFY.** Hide and Cancel are separate controls, and Hide keeps following the same run.
  Past the cutoff the copy is "Past the point of cancellation; wrap continues" plus the actual
  current step, not a permanent "committing". Once a cancel is accepted the control is disabled
  and the copy says the current step is finishing.

The "Facts" bullet above that says a pre-commit cancel "leaves the repository as it found it" is
superseded by the corrected boundary in D3.

### Implementation calls (not architectural; noted per the priming)

- **Descoped at Critic review (R-1):** the planned "re-follow a stalled/lost run on dismiss" could
  never fire, because the page only reaches `stalled`/`lost` after the server has said the run is
  not running or is another run. The real defect, a stale-slot takeover that leaves the old
  pipeline running, needs a server-side design and is filed as #1805.
- **Descoped (R-4):** the landing-page modal gets the pre-tick from the project setting, but no
  planned-outcome line. The dashboard dialog has no live drawer, and its pre-ticked checkbox
  already states the same fact at the moment of choosing. The operator guide's wrap section is
  updated (`docs/user-guide.md`, "Keeping the session running" and "Hiding versus cancelling").
- An accepted cancel is appended to the run's own event log (`cancel-requested`, once per run),
  so every watcher sees it, including a replay after a reload. The page's local cancel state only
  covers the moment before that event arrives (Critic R-3/R-8/R-13).
- The planned outcome has one derivation, `projectConfig.plannedSessionOutcome(options)`, shared
  by the 202, `run-start` and `/wrap/status` (Critic R-9). The settings modal sends the keep
  toggle only when it changed, so "never set" survives unrelated saves (Critic R-2/R-7).
- #1806 is filed for the stranded Medusa inbox noted in #1708, which this chunk does not fix.
- **ADR 0002 amended (Critic R-12; Architect ruling MODIFY, message e9731465):** a dated
  2026-09-23 section records D1–D5 in the Architect's normative wording, and a supersession pointer
  sits beside the 2026-09-16 keep-running paragraph. It records no new decision.
- `wrapKeepSessionRunning` defaults to `null` (never set), not `false`. The loader merges
  defaults into every config, so a literal `false` would make "the project chose false"
  indistinguishable from "never chose", and `keepSource` would report `project` for both.
- The dialogs now send `keepSessionRunning` as an explicit boolean either way. Before, they sent
  it only when true. An untick has to be able to override a project set to keep. The page holds
  `null` when it never chose (it is following a run started elsewhere), so a Retry from it sends
  nothing, and the server keeps the retried run's answer (D1 rule 3).
- The run-start `sessionOutcomePlanned` is derived from the resolved `keepSessionRunning`. It is
  never read from the options.
- The stale test contracts that pinned "sent only when true" and the exact status/option key sets
  were updated to the new contract with equal-strength assertions. None was removed.
- The landing-page modal gets the same default pre-tick and planned-outcome line. It has no live
  drawer, so no Cancel there.
- Docs: `docs/configuration-reference.md` (new setting), the API contract doc (new route and
  fields), and the wrap section of the operator guide.

### Tests (written alongside)

- `startWrap` resolution: request wins; absent request uses the project setting; absent both is
  `false`; `keepSource` for each. A multi-hop test proves `handoff-stage` stages a `checkpoint` when
  only the project setting asks to keep (it fails if the default is resolved at the kill site
  only).
- A POST with no options on a keep-configured project leaves the session running (the #1708 repro).
- Cancel before commit: the run ends `cancelledAt` at the next boundary, the session stays active,
  no wrap branch or commit exists in a real temp repo, and the steps that ran are listed. Cancel
  after commit starts: 409 with the step name. Wrong `runId`: 404.
- Registry: `abortRequested` survives only for its run, and is cleared by a new `begin`.
- Controller and drawer: the "Hide" label while live, Cancel visibility by phase, the cancelled
  report, and a stalled dismiss re-following a still-live run.
- Stream-event vocabulary test updated for the `run-start` fields and the `cancelled` outcome.

### Done when

The #1708 repro (a POST without the flag on a keep-configured project) keeps the session, and the
drawer said so before the first step. A live cancel before `commit` stops the run with the repo
untouched and the session running. A cancel after `commit` is refused with its reason. The suite is
green, the Critic is clean, and the Architect has ruled D1–D5.

## Chunk 02: Wrap gates are engine-aware and never read as passed (#1738)

Dispatched by the PM 2026-09-23 (message 4bb03f64). Branch `fix/a3-chunk2-engine-aware-gates`,
worktree `.claude/worktrees/a3-chunk2`.

### Confidence check

1. **Problem.** A wrap of a Prawduct-onboarded project from a Gemini/Codex/Aider session runs
   `prawduct-hook stop` anyway. The hook's reflection and learnings gates are Claude-session
   concepts, so they report "blocked" for reasons the session cannot act on. The probe also appends
   to Prawduct's evidence store, and `version-bump` rewrites `.prawduct/change-log.md`, so a
   non-Claude engine mutates Prawduct-owned state. Separately, a preflight that never measured
   anything (hook missing, timeout, operator override) records `skipped`, and `handoff-stage`
   counts `skipped` as evidence produced, so the handoff can say `complete` over gates nobody
   checked. That is a false green.
2. **Success.** On a non-Claude session of an onboarded project, preflight records
   `capability-unavailable` naming the engine and the missing capability, and never spawns the hook.
   No wrap step writes Prawduct-owned state. The wrap still finishes as a state-only checkpoint: it
   commits, pushes, opens the PR and publishes a neutral handoff. It withholds merge and release
   authority, and the drawer and the handoff say so. An ungoverned project's preflight reads
   `not-applicable`, not `skipped`. An unmeasured preflight on a supported engine makes the handoff
   `degraded`, never `complete`. The next Claude launch after a dormant attempt is told to run
   `/prawduct:doctor`, never `/prawduct:onboard`, before any methodology work.
3. **Out of scope.** Capability-matched admission of work to engines. Rotation (quiesce, lease
   and epoch revoke, attested replacement). Moving canonical instructions into `AGENTS.md`. The
   per-engine prompt-glyph work (Chunk 03). Resume rendering from the publication (Chunk 04). This
   chunk records the disposition that Chunk 04's Resume will display. It does not re-plumb which
   publication a launch selects. If no issue already covers admission and rotation, file one.

### Facts established while planning (verified against code at 6d2e7d2)

- The wrap has exactly one Prawduct-provider gate, `preflight`, the first step
  (`lib/wrap-default-pipeline.js`). It runs `prawduct-hook stop` whenever `.prawduct/` exists,
  whatever the engine. The step context carries `project`, `session`, `scope` and `options`, and no
  engine field. The session row has `engineId` (the attempt's engine), and the handoff document
  already records `engineId` (`lib/handoff-publication.js`).
- `governanceState()` (`lib/governance-state.js`) returns `not-applicable` for **every**
  non-Claude engine before it looks at the disk. It therefore cannot tell "onboarded, but this
  engine cannot host Prawduct" from "never onboarded", and that is exactly the distinction the
  ruling needs. It also reads the project row's engine, not the session's. A session launched with
  an engine override would be misclassified.
- Prawduct-owned writes during a wrap: the preflight probe (evidence-store transfer grant, and
  possibly consolidation, per its docstring) and `version-bump`'s merged→shipped stamp on
  `.prawduct/change-log.md` (staged into the commit). No other step writes under `.prawduct/`. A
  model in the session could still edit `.prawduct/` files itself, and `commit` would stage them.
- Merge and release authority in a wrap: `commit` arms `gh pr merge --auto` on the auto-branch
  path; `pr-merge` (`apply-pr-resolutions`) enqueues auto-merge for resolved PRs; `version-bump`
  cuts the version, and `release.yml` tags it once it reaches `main`.
- `handoff-stage`'s `EVIDENCE_PRODUCED = ['done', 'skipped']` does not look at
  `output.measured`, so a preflight that measured nothing counts as evidence produced.
- Nothing at launch reads `missingEvidence` today. The launch reads the publication through
  `lib/launch-preflight.js` for its verdict only.
- No launch-time code runs Prawduct onboarding. The only Prawduct action (`invoke-critic`) requires
  `governed-plugin`, which a non-Claude engine never reads as. So "unsupported engine interprets
  missing hooks as de-onboarding" has no current trigger in TangleClaw. The chunk keeps it that way
  and adds a test that pins it.

### Architectural decisions (proposed; for the Architect at plan-written)

- **E1: One capability resolver, keyed to the session's engine, resolved once per run.**
  `lib/governance-state.js` gains `methodologyCapability(projectPath, { engineId })` →
  `{ onboarded, available, disposition: 'available' | 'not-applicable' | 'capability-unavailable',
  engineId, capability: 'prawduct-methodology', reason }`. `onboarded` is engine-independent: a
  `.prawduct/` directory or the committed plugin reference. `available` is `engineId === 'claude'`.
  The wrap resolves it once before the first step, from `session.engineId` (fallback: the project
  row), and passes it in the step context. Every step reads that one value (project learning
  2026-09-22). *Rejected:* reusing `governanceState()` as-is, because it cannot tell onboarded from
  ungoverned off Claude. *Rejected:* a new engine-profile capability flag. Profiles are
  operator-editable, so an operator could grant a capability the plugin does not have; the flag is
  deferred until a second engine can actually host Prawduct.
- **E2: Two new first-class step statuses, `not-applicable` and `capability-unavailable`.** Each
  carries `output: { engineId, capability, reason }`. Neither halts the pipeline. The drawer
  renders each in its own words, and the stream vocabulary and the wrap result carry them.
  *Rejected:* `status: 'skipped'` plus a `disposition` field. Any consumer that does not know the
  new field would read the row as passed, which is the defect itself. Unknown statuses fail
  closed in every consumer.
- **E3: Gate classification.** `preflight` is the only provider-specific *required* methodology
  gate: onboarded and unavailable → `capability-unavailable` (the hook is never spawned);
  not onboarded → `not-applicable`. Every other step is portable (safety and continuity) and runs
  unchanged on every engine. `version-bump`'s `.prawduct/change-log.md` stamp is a
  provider-specific *sub-action*, reported in the step output. A preflight that did not measure on
  a supported engine (hook missing, timeout, contract breach, operator override) stays `skipped`
  but counts as **missing evidence** in the handoff (`degraded`, named). An operator's "Wrap anyway"
  override therefore now degrades the handoff. That is honest, but it is a visible change.
- **E4: A dormant methodology withholds merge and release authority; the checkpoint still
  completes.** When preflight is `capability-unavailable`:
  - `version-bump` holds: no cut, no stamp. `[Unreleased]` carries to the next governed wrap.
  - `commit` commits, pushes and opens the PR, but does not arm auto-merge.
  - `apply-pr-resolutions` enqueues nothing and records `capability-unavailable`.
  - `commit` leaves every `.prawduct/` path unstaged and names them in its output (fail visible).
  - The run result carries `methodologyAuthority: { state: 'withheld', engineId, reason }`, and the
    drawer shows it.
  - The handoff is `degraded`, with `preflight: capability-unavailable` in `missingEvidence`.

  *Rejected:* bump but withhold the merge. The bump would ride any later manual merge into a
  tagged release that never had its methodology gates run. *Rejected:* refusing the wrap, which is
  the forced-kill outcome #1738 exists to end.
  **Rule conflict to rule on:** the project rule says "version math, changelog promotion, ledger
  stamps and commits must produce identical results across engines". E4 makes version math and
  ledger stamps differ by engine *for onboarded projects*. My reading is that the rule governs the
  engine-neutral pipeline (ungoverned projects are identical across engines), and the 2026-09-21
  ruling governs the Prawduct-required capability, which is newer and more specific. That reading
  needs the Architect's ruling, not mine.
- **E5: The handoff records the methodology disposition.** The handoff document schema (version 1) gains an optional,
  additive `methodology: { disposition: 'measured' | 'unmeasured' | 'not-applicable' |
  'capability-unavailable', engineId }`. It is omitted by producers that predate it, so absence
  stays readable as "unknown". *Rejected:* making launch parse `missingEvidence` strings.
- **E6: The return path is a launch directive, not an enforcement.** A launch on an engine where
  the capability is available, whose selected publication records
  `methodology.disposition: 'capability-unavailable'`, adds one block to the state step: Prawduct
  state was dormant during a `<engine>` attempt; run `/prawduct:doctor` (never `/prawduct:onboard`)
  before any methodology work; methodology authority is withheld until it passes. TangleClaw
  cannot observe Doctor passing, so the block is instructional, and it says so. *Rejected:*
  TangleClaw running Doctor itself. Doctor's repairs are previewed and owner-confirmed, so it is
  interactive by design. *Rejected:* gating the launch until Doctor passes, which would block the
  session that has to run it.

### Architect rulings (2026-09-23, message 9a774624) — binding

- **E1: ACCEPT.** One immutable per-run resolution keyed to the session engine; an unknown engine
  fails to `capability-unavailable`. Any `.prawduct/` directory is a conservative dormant-state
  signal, not proof of healthy onboarding.
- **E2: ACCEPT.** Every consumer must fail closed on unknown statuses.
- **E3: MODIFY.** Any REQUIRED supported-engine preflight that produced no measurement is
  unmeasured and degrades the handoff: missing hook, timeout, contract breach, a "Wrap anyway"
  after a failure, or a configured step override. An Operator override may permit the state-only
  checkpoint, but it cannot turn absent evidence into complete. `not-applicable` is reserved for a
  project with no onboarding signal.
- **E4: MODIFY.** The technical behaviour is correct. Checkpoint and neutral publication may
  finish. Bump and stamp, auto-merge, PR-resolution merge and all `.prawduct/` writes are
  withheld, and the result and handoff are degraded. But active project rule 5 (engine-identical
  version math, changelog promotion, ledger stamps and commits) cannot be narrowed silently. The
  Builder authors a proposed amendment separating engine-neutral wrap mechanics from
  provider-owned methodology effects, and the **Operator approves it before the PR opens**.
- **E5: ACCEPT.** Omission means unknown, and invalid enum values fail validation. Launch never
  parses `missingEvidence` prose.
- **E6: MODIFY.** The directive is advisory. It must not claim Doctor passed or authority was
  restored. The historical handoff disposition stays immutable. Prawduct restores its own
  authority through the owner-confirmed Doctor flow, and a later measured preflight on a
  compatible engine may establish a new publication result. Do not gate launch, and never onboard
  again.
- ADR 0002 is amended only after the E4 rule conflict is Operator-resolved. The repo-owning
  Builder writes the Architect-owned decision.

### Amendment to project rule #5 (E4): APPROVED by the Operator 2026-09-23, relayed by the PM (message 8af0c8ec), and applied verbatim to rule #5

Current sentence: "Version math, changelog promotion, ledger stamps and commits must produce identical
results across engines; narrative quality may vary."

Proposed replacement (the rest of rule #5 is unchanged):

> Engine-neutral wrap mechanics — commits, the handoff, and the version math and changelog
> promotion a wrap computes — must produce identical results across engines for the same project
> state; narrative quality may vary. Effects owned by a provider's methodology run only on an engine
> that has that capability. For a Prawduct-onboarded project, those effects are its gates, writes to
> `.prawduct/`, the ledger stamp, and the merge and release authority the methodology grants
> (cutting a release, arming auto-merge, merging PRs). On an engine without the capability they are
> withheld, never faked or bypassed: the wrap still checkpoints, the step reads
> `capability-unavailable`, and the handoff is recorded as degraded (#1738).

### Implementation calls (not architectural)

- The resolver is pure fs, like the rest of `governance-state.js` (the scanner child imports it).
- `methodologyAuthority` is derived once by the pipeline from the resolved capability
  (`methodologyAuthorityOf`), not re-derived per step. Every step reads `context.methodology`.
- The `.prawduct/` hold-back is a `withheldPrefixes` option on the file classifier, passed by
  both `session-files` and `commit` from the same capability. That way the files row never asks
  about a path the commit would refuse. The paths go to a new `methodologyWithheld` bucket, which
  is never staged and never offered as a decision. `reclassify` carries it through.
- (Superseded by the Architect's E3 MODIFY below.) A preflight disabled through
  `wrapStepOverrides` was first left as an ordinary `skipped` that did not degrade. Now, on an
  engine that can run the methodology, any skipped preflight counts as unmeasured and degrades the
  handoff (`handoff-stage` `_unmeasuredSkip`).
- An engine that cannot be identified reads as unable to run the plugin (fail closed). The
  preflight test fixture now names its engine (`claude`) rather than relying on the old
  engine-blind behaviour.
- TangleClaw ships no `gemini` engine profile. The shipped non-Claude engines are Codex, Aider,
  Antigravity and OpenClaw, and the tests use those or a bare `gemini` session id.
- Fixed in passing (no "pre-existing" exception): `handoff-stage` read `project.engine`, a field
  project rows do not carry (`engineId`), so the handoff's `engineId` fell to `unknown` whenever the
  session had none.
- Critic rev-20260923T042921Z corrections, in the tree before any ruling:
  - "Onboarded" has ONE definition, the resolver's. Preflight no longer re-checks `.prawduct/`,
    so a fresh clone carrying only the plugin reference is measured on Claude.
  - The session-over-project engine rule is one helper (`governance.sessionEngineId`), used by
    the pipeline, preflight and handoff-stage.
  - The withheld-authority banner no longer outranks a failed or stranded wrap PR. Those keep
    their banner and carry the authority in the detail. The authority reason no longer claims
    the wrap "opens its PR", which is false for a feature-branch or no-commit wrap.
  - Withheld auto-merge and withheld PR merges log a line.
  - The follow-up for admission and rotation is filed as #1809.
- ADR 0002 carries a dated 2026-09-23 section recording E1–E6 in the Architect's wording. It was
  written after the rule #5 amendment was Operator-approved, as the Architect directed.

### Tests (written alongside)

- Resolver: Claude + onboarded → available. Gemini + onboarded → capability-unavailable. Gemini +
  ungoverned → not-applicable. The session engine wins over the project row.
- Preflight: capability-unavailable never spawns the hook (the exec seam is not called), and the
  evidence store is not touched.
- A multi-hop pipeline run on a Gemini session of an onboarded repo (real temp git repo):
  - `.prawduct/change-log.md` is byte-identical after the run;
  - a `.prawduct/` edit made in the session is left unstaged and named;
  - no version cut;
  - no auto-merge arm call;
  - the handoff is `degraded` with `methodology.disposition: 'capability-unavailable'`;
  - the result is `methodologyAuthority.state: 'withheld'`.
- Handoff: an unmeasured `skipped` preflight → degraded; `not-applicable` → still complete.
- Launch: a Claude launch after a capability-unavailable publication renders the Doctor
  directive, and a Claude launch after a measured one does not.
- Drawer and stream vocabulary: the two new statuses and the withheld-authority banner.

### Done when

The #1738 repro (a wrap from a non-Claude session of an onboarded project) finishes as a
state-only checkpoint. The drawer and handoff say the methodology was unavailable. Prawduct's
files and evidence are untouched, and nothing merges or releases. A return to Claude is told to
run Doctor. The suite is green, the Critic is clean, and the Architect has ruled E1–E6.

## Chunk 03: Admission is a positive decision; drafts fail visibly (#1724, #1507)

Dispatched by the PM 2026-09-23 (message 7845b64b). Branch `fix/a3-chunk3-admission-drafts`,
worktree `.claude/worktrees/a3-chunk3`.

### Confidence check

1. **Problem.** (#1724) A file a session creates and never commits is staged by the wrap without
   anyone deciding: `_file-ownership.classify` calls any path changed after launch `owned`, and
   an untracked file created after launch is always changed after launch. That is how PR #1721
   merged ten scratch scripts and query dumps into `main`, and how `tag_issues.sh` and
   `tag_issues_2.sh` arrived in PR #1320. The wrap PR body never lists the session's files, so
   nobody reviewing it could see them. (#1507) Before an injection clears the prompt with `C-u`,
   `tmux._clearPromptLine` logs "the draft", but it takes the last non-empty line of the bottom
   five rows, which is the engine's status footer. A real draft is destroyed and the log shows
   footer text on every injection, draft or not.
2. **Success.** A file that is new to the repository and first appeared this session is asked
   about in the existing Include/Leave list, with its own reason, and is never committed without
   an Include. The wrap PR body and commit body name every session file they propose to merge, and
   mark the ones the operator included. The two stray scripts are gone. An injection into an
   engine whose composer can be located logs the draft's actual text, and logs nothing when the
   composer was empty. Where the composer cannot be located, the log says "draft not captured"
   with the reason, never footer text.
3. **Out of scope.** Restoring a cleared draft (#812's decision stands). Refusing or deferring a
   command-bar, wrap or Critic injection because a draft is present. New wake profiles for Aider
   or OpenClaw. Changing how tracked-file edits are classified. Chunk 04's publication binding.

### Facts established while planning (verified against code at 315d519)

- The seven artifacts still named in #1724's first comment are already gone from `main`. Only
  `tag_issues.sh` and `tag_issues_2.sh` remain tracked, and `FEATURES.md` has two entries that
  describe them.
- `classify` has no notion of "new to the repository". `parseStatus` drops porcelain's `??`
  marker. With a launch snapshot, a path absent from the snapshot is `owned`. Without one, a path
  is `owned` when its mtime is at or after the session start. Both admit a scratch file.
- Both `session-files` (which shows the Include/Leave list) and `commit` call `classify`, so a new
  reason reaches the drawer and the commit through one function. The drawer renders the reason's
  `why` text generically; no client code switches on reason codes.
- The auto-PR body (`commit._buildAutoPrBody`) and the commit body (`_buildBodyLines`) list wrap
  artifacts, TangleClaw maintenance and release files, but never the session's own files.
- `_clearPromptLine` runs for every `tmux.sendKeys` caller. Callers: the command API
  (`sessions.injectCommand`, which the wake nudge also uses), the three prime sends, the wrap's
  `ai-content` prompt, `invoke-critic` and the Master injector. Only the wake nudge refuses a
  non-empty composer first (`composer-has-input`). The rest clear whatever is there.
- The composer can already be located: `medusa-wake._composerEmpty(cursor, profile)` answers
  empty / has input / undecidable from the cursor, and `wrap-delivery-receipt._splitAtComposer`
  returns the composer's rows or "not located". Claude, Codex and Antigravity declare a wake
  profile. Aider and OpenClaw declare none, so their composer can never be located. No Gemini
  profile ships.
- `tmux.js` receives only a tmux session name, not an engine id.

### Architectural decisions (proposed; for the Architect at plan-written)

- **F1: A file new to the repository that first appeared this session is foreign, reason
  `untracked-new`.** New means porcelain `??`, or index status `A` (not in `HEAD`). It applies when
  the path is not in the launch snapshot (or, with no snapshot, its mtime is at or after the
  start) and the wrap did not write it. Like every foreign path, it blocks the commit until the
  operator answers Include or Leave. The `why` text: "new to the repository and never committed:
  this session created it, but nothing says it belongs in the project". TangleClaw's own paths and
  withheld `.prawduct/` paths are judged first, as now.
  *Visible change:* a wrap, including an unattended PM-initiated one, now stops at session-files
  when a session leaves any new file uncommitted.
  *Rejected:* default to Leave without blocking. The file would drop out of the commit silently,
  the same silence in the other direction, and the issue asks for an explicit decision.
  *Rejected:* an allowlist of product directories. That is a guess, and scratch files land in
  `lib/` too. *Rejected:* treating a staged new file (`A`) as admitted. An agent's `git add -A`
  is not a decision.
- **F2: The wrap PR body and commit body enumerate every non-routine file.** A new body line lists
  the session's files (`owned`, minus paths a wrap step wrote), and another lists the paths the
  operator chose to include, each named "included by the operator". Wrap artifacts, TangleClaw
  maintenance and release files keep their existing lines. Both bodies read the same staged entry,
  so they cannot disagree. *Rejected:* the PR body only, which would leave the commit history
  disagreeing with its PR. *Rejected:* a count, which cannot be reviewed.
- **F3: Draft capture locates the composer per engine, from the session's engine id.**
  `tmux.sendKeys` gains an `engineId` option, and every caller passes the session's engine
  (`governance.sessionEngineId` where a project row is in hand). `_clearPromptLine` asks the wake
  profile for that engine, reads the pane and cursor, and then:
  - empty composer (`_composerEmpty` true): clear, log nothing;
  - composer holds input (false): take the composer rows with the shared locator, strip the glyph
    and pad, log the text as `draftBeforeClear`, then clear;
  - cannot tell (no profile, no engine id, cursor unreadable, cursor off the composer, rows not
    located): clear, and log "draft not captured: composer not located" with the reason and engine.
  The locator moves from `wrap-delivery-receipt` to `medusa-wake` beside `_composerEmpty`, so
  there is one definition of where the composer is. *Rejected:* keeping a line-position heuristic
  for unprofiled engines. It is the defect.
- **F4: When the composer cannot be located, the prompt is still cleared.** This departs from the
  roadmap's one-line summary ("does not clear a possibly non-empty draft"), so it needs a ruling.
  Not clearing reopens #812: `paste-buffer` appends, and the Enter submits the operator's
  half-typed text joined to ours as one instruction, which executes something nobody wrote.
  Losing a draft is recoverable by retyping. An unintended instruction is not. The log then says
  plainly that a draft may have been discarded and could not be captured.
  *Rejected:* skip the clear. *Rejected:* refuse the injection. Aider and OpenClaw have no
  profile, so every command-bar send, prime and wrap prompt to them would fail. That is a much
  larger behaviour change than this issue.
- **F5: The log records a draft only when one was observed.** `promptBeforeClear` is retired.
  `draftBeforeClear` carries real composer text. The not-captured line is a separate message with
  `{ engineId, reason }`. Nothing reads the old key programmatically (verified by grep), but it is
  a log contract that operators search, so it is listed here.

### Architect rulings (2026-09-23, message 5b0eaa0d) — binding

The PM approved the plan (message 892e8d70). The architectural gate is cleared for the presented
scope only; implementation, tests, Critic, review, CI and merge readiness are not certified.

- **F1: APPROVE.** A file new to the repository is not admitted by recency or by `git add`.
  It needs an explicit Include or Leave, including one with index status `A`.
- **F2: APPROVE.** One staged source names the session files and the operator-included files, in
  both the commit body and the PR body.
- **F3: APPROVE.** Pass `engineId`, use one profile-based composer locator, and report an
  unavailable or unreadable capture honestly. An engine without a profile may take the
  not-captured path, but must never claim draft evidence.
- **F4: APPROVE, superseding the roadmap's one-line summary for this chunk.** Clear the prompt
  even when capture is unavailable, because preserving a draft cannot take precedence over
  preventing concatenated operator and injected text from executing. Log the non-capture
  explicitly. *Consequence:* on Aider and OpenClaw, and on any pane whose composer cannot be
  located, a draft typed at the moment of an injection is destroyed with only a "not captured"
  record.
- **F5: APPROVE.** `draftBeforeClear` is used only for observed draft content. Non-capture is
  recorded separately, with the engine and the reason.

### Implementation calls (not architectural)

- Delete `tag_issues.sh` and `tag_issues_2.sh` and their two `FEATURES.md` entries.
- A draft that wraps onto a second row leaves the cursor on a row without the prompt glyph,
  which `_composerEmpty` cannot judge. It is captured only when the composer is boxed: the glyph
  row sits directly under a divider, and no divider falls between it and the cursor. A dialog or
  transcript row has no such box, so it is reported as not captured, never as a draft. An engine
  whose composer has no divider directly above it records a wrapped draft as not captured.
- `draftBeforeClear` is JSON-encoded, so a multi-row draft stays one log entry.
- Fixed in passing: `test/update-applier-authored-content.test.js` rebuilt the path its file
  seam read relative to the checkout, which escaped the temp repository whenever the checkout sat
  fewer directory levels deep than the temp directory. It failed on this Mac on a clean `main`
  and passed on CI. The seam now reads the path it is given and asserts that it lies inside the
  test repository.
- The wrap-ownership tests' fixture repository now tracks the files its sessions write
  (`mine.js`, `feature.js`, `work.js`), so "the session's work" stays an edit the wrap commits
  unasked. New files have their own tests. No assertion was removed. Two expectations changed
  shape with the fixture: a rename-parse row gains `untracked`, and one commit lists `M mine.js`
  where it listed `A mine.js`.
- `parseStatus` adds an `untracked` flag to each entry (`??`, or `A` in the index column).
  `reclassify` needs nothing new, because the reason lives on the foreign entry.
- The captured draft is the composer region's plain text. The cursor row keeps its SGR, but rows
  above it do not, so a multi-row draft's faint suggestion cells cannot be removed there. A
  suggestion only renders on an empty composer, so it cannot appear beside a real draft.
- Test fixtures reuse the real Claude, Codex and Antigravity pane captures in
  `test/_wake-fixtures.js`. No new live capture is taken from another session's pane.

### Tests (written alongside)

- Classifier: a new untracked file created after launch is `untracked-new`, with a snapshot and
  without one. A staged new file is too. A new file the wrap wrote is `owned`. An edited tracked
  file is still `owned`. Include commits it and Leave leaves it. A multi-hop test runs
  `session-files` then `commit` on a real temp repo with scratch `find_rows.py` and
  `new_prs.json` and asserts neither is committed without an Include.
- PR and commit body: session files and included files are both listed, and the two bodies agree.
- Draft capture, per engine fixture: an empty composer logs nothing. A draft logs its exact text,
  never footer text (Claude's `⏵⏵ bypass permissions…`, Codex's footer). A multi-row draft logs
  every row. An engine with no profile logs "not captured" with a reason and still sends `C-u`.
  An unreadable cursor does the same.
- Every `sendKeys` caller passes an engine id (a source-level test pins the call sites).
- Regression: the four footer strings from #1507's evidence table are never logged as a draft.

### Done when

A wrap with a new scratch file stops for Include/Leave and commits nothing it was not told to. The
PR body names every session file. The two stray scripts are gone. An injection logs a real draft
or an honest "not captured", and never footer text. The suite is green, the Critic is clean, and
the Architect has ruled F1–F5.

## Chunk 04 (planned at its own session's start; decisions go to the Architect then)

- **04 (#1675).** The launch's Resume block reads the mutable continuity index, not the
  publication, and the wrap result carries no publication id. Bind the wrap's success to the
  published id and digest, surface a publish refusal in the result instead of only logging it,
  render Resume from the selected publication, and label any fallback (older publication, or a
  session summary) with its provenance before the proposal.

## Status

- [x] Chunk 01: Wrap intent is explicit and cancellation is honest (#1708, #1707): Critic rev-20260923T023239Z resolved by rev-20260923T025704Z, 0 blocking
- [x] Chunk 02: Wrap gates are engine-aware and never read as passed (#1738): Critic rev-20260923T042921Z resolved by rev-20260923T044924Z, 0 blocking; Architect E1–E6 ruled; rule #5 amendment Operator-approved
- [ ] Chunk 03: Admission is a positive decision; drafts fail visibly (#1724, #1507): plan written; Architect ruled F1–F5 APPROVE; built, Critic pending
- [ ] Chunk 04: A successful wrap binds to the publication the next launch reads (#1675)
- [ ] P1: startupControl planning note (no build)
