---
title: "Train A Car A3: wrap intent, artifact admission, and honest cancellation"
status: PLANNING — Chunk 01 plan written 2026-09-23; Architect rulings on C1–C2 and D1–D5 pending
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-23 (messages ecdbe884, 39998da1)
issues: [1708, 1707, 1738, 1724, 1507, 1675]
governed_by:
  - Architect roadmap, "Car A3 — wrap intent, artifact admission, and honest cancellation" (TangleClaw-Architect/.tangleclaw/plans/v5-v6-backlog-census-and-bridge-roadmap.md)
  - "#1738 Architectural ruling (2026-09-21): engine portability; wrap gates classified, never a bypass that reads as passed"
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION
  - project rule: Train chunks of at most 3–4 issues, one chunk per session
scope: train-a-car-a3
branch: fix/a3-chunk1-wrap-intent
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

### Implementation calls (not architectural; noted per the priming)

- Dismissing a `stalled` or `lost` run re-checks `GET /wrap/status` before returning the button to
  idle. If the server still reports the run, the controller re-follows it instead of offering a
  fresh "Wrap" that would take over a live slot.
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

## Chunks 02–04 (planned at their own session's start; decisions go to the Architect then)

- **02 (#1738).** Preflight consults the engine: `governanceState()` already says `not-applicable`
  off Claude, but preflight never calls it. Add gate outcomes that are not "passed"
  (NOT_APPLICABLE, CAPABILITY_UNAVAILABLE) with engine/capability evidence, and stop
  `handoff-stage` counting an unmeasured skip as evidence produced. On an engine without the
  methodology capability, no step writes Prawduct-owned state (the preflight hook and
  `version-bump`'s `.prawduct/change-log.md` rewrite). A state-only checkpoint wrap still finishes.
- **03 (#1724, #1507).** An untracked file first created this session becomes a foreign path
  (reason such as `untracked-new`) and uses the existing Include/Leave decision UI instead of
  being staged silently. The wrap PR body lists every non-routine file it proposes. Remove the
  still-tracked `tag_issues.sh` and `tag_issues_2.sh`. Injection captures the composer using each
  engine's prompt glyph and cursor (the method the wake nudge already uses). When it cannot locate
  the composer, it logs "draft not captured" and does not clear a possibly non-empty draft. It
  never logs footer text as a draft.
- **04 (#1675).** The launch's Resume block reads the mutable continuity index, not the
  publication, and the wrap result carries no publication id. Bind the wrap's success to the
  published id and digest, surface a publish refusal in the result instead of only logging it,
  render Resume from the selected publication, and label any fallback (older publication, or a
  session summary) with its provenance before the proposal.

## Status

- [ ] Chunk 01: Wrap intent is explicit and cancellation is honest (#1708, #1707)
- [ ] Chunk 02: Wrap gates are engine-aware and never read as passed (#1738)
- [ ] Chunk 03: Admission is a positive decision; drafts fail visibly (#1724, #1507)
- [ ] Chunk 04: A successful wrap binds to the publication the next launch reads (#1675)
- [ ] P1: startupControl planning note (no build)
