---
artifact: build-plan
version: 2
scope: wrap-section-capture
depends_on:
  - artifact: wrap-direction
  - artifact: project-preferences
governed_by:
  - artifact: wrap-direction
    dispositions:
      - "Commitment 2, engine-agnostic by construction → ENGAGED, and it is the authority for this chunk. It reads: a step 'never silently does nothing and never hard-fails the wrap for lacking a single engine's feature.' `5739071c` made four judgment sections hard-fail the wrap when any model omits one of seven prompt blocks — a direct departure from a ratified commitment, and the weaker the engine the more often it fires. This chunk restores conformance; it is not a new decision."
      - "Commitment 3, gates advisory by default → ENGAGED. Its bright-line test lets a gate block only where failure is 'silent or destructive regardless of any project's or model's preference.' A missing `Decisions` section is neither: it renders a visible `_⚠ not captured_`, and nothing is lost. The three hard gates the Direction enumerates (dangling FEATURES.md citation, work with no changelog entry, `verifyChanged` false-success) share the property that failure is invisible; this one does not, so it is advisory."
      - "Commitment 1, the mechanical spine → conforms and bounds the fix. The spine (version math, changelog promotion, ledger stamps, priming roll, memory update, single commit) is unchanged; only the judgment ceiling's blocking posture moves."
      - "Commitment 4, no hardcoded model branches → conforms; nothing here tests an engine id. The four sections are asked of every engine identically and flagged identically when absent."
  - artifact: project-preferences
    dispositions:
      - "No npm dependencies → conforms; this chunk adds none."
      - "CommonJS, 'use strict', no build step → conforms; every file touched is already CommonJS."
      - "Tests are `node:test` + `node:assert/strict` → conforms."
      - "JSDoc on every function → ENGAGED. `_resolveCapturedFields`'s `@returns` currently declares three keys while `5739071c` made it return seven; C2 corrects it."
last_validated: 2026-09-10
---

## Problem

Every per-session wrap summary renders `_⚠ not captured_` for four of its eight sections —
`Delta`, `Open threads`, `Decisions`, `Pointers` — on every wrap, every engine (#1379, reported by
GURULifeline). Verified on this machine: `.tangleclaw/continuity/wraps/953.md`, `harness: claude`,
`tier: full`, all four flagged.

The cause is unfinished wiring, not a design error. The renderer (`lib/continuity.js`
`renderWrapSummary`), the honest-flag, and the per-project section selection (CC-6, #381) were all
built. The wrap prompt was never updated to ask the AI for the four, and `_resolveCapturedFields`
was never taught to read them.

`5739071c` (PR #1389) closed the gap by adding all four to the `memory-update` step's
`captureFields`. That list is the **blocking** list: `lib/wrap-steps/ai-content.js:874` and `:1158`
fail the step for any missing-or-empty member, and the step is `blocker: true`. So the wrap went
from "prints a placeholder" to "dies" whenever a model omits any one of seven blocks. This chunk
keeps that fix and removes the blocking.

### Why the four are AI-authored and not derived

`.claude/plans/archive/continuity-contract.md:226-231` fixes their content:

```
## Delta               # decisions + why · shipped/merged · deferred
## Open threads        # in-flight, blockers, unresolved questions
## Decisions (settled) # locked — don't relitigate
## Pointers            # canonical artifacts, issues, files
```

All four are judgment. `Delta` in particular is **not** a file list — the git-derived file set is
the `files:` frontmatter stamp and the continuity index's `## Map`, a different artifact. A
mechanical `Delta` was considered and rejected on that basis.

### Why non-blocking is the contract, not a concession

This is settled by a **ratified binding norm**, not by judgment. `wrap-direction.md` § Direction
(operator, 2026-07-21), commitment 2:

> No step may *require* a capability that only one model has. Where a model is weaker, the step
> **degrades honestly with a visible reason**; it never silently does nothing and **never
> hard-fails the wrap** for lacking a single engine's feature.

Commitment 3 sets the bright line for a blocking gate:

> A gate may block only when its failure is **silent or destructive regardless of any project's or
> model's preference** — i.e. the wrap would otherwise report success while shipping something
> broken or losing work.

A missing `Decisions` section is neither silent (it renders `_⚠ not captured_`) nor destructive.
So blocking on it is a departure from a ratified commitment, and restoring advisory posture is
conformance rather than a new decision.

Two independent readings agree. CC-7's tier model
(`.prawduct/artifacts/cc-7-degraded-wrap.md`): *"missing judgment is flagged-empty with a reason,
never fabricated"* — and its `mechanical-only` tier, which has no AI channel at all, still renders
all eight sections. If a judgment section could block, that tier could never complete. So the
contract's "deep = all sections required" means *rendered and expected*, not *gating*.

## Requirements Confidence

**Level:** High.

Every claim above was verified against this repo's code rather than taken from the issue text or
from PR #1389 ([[feedback_issue_diagnosis_is_a_hypothesis]]): the reproduction was read off a real
local wrap file, both validation sites were read, the section definitions came from the contract,
and `defaultPipeline.steps()` was confirmed unconditional so no template layer participates.

One correction this produced: an earlier draft of this fix proposed deriving `Delta` from
`_sessionDelta`. Reading the contract disproved it.

## Success

1. A wrap whose AI writes all seven blocks fills all eight sections.
2. A wrap whose AI writes only `Summary` / `NextSteps` / `Learnings` **completes**, with the four
   judgment sections honest-flagged — the pre-`5739071c` behavior for those sections, without the
   permanent-placeholder bug.
3. A missing **core** field still blocks (regression pin — this is the guard that must not soften).
4. Both transports behave identically: tmux and the ClawBridge gateway.

## Out of scope

- Deriving any section mechanically (settled above).
- The CC-8 `wrap_contract` methodology-depth layer — specified in the contract, absent from `lib/`
  and `data/`; filing it is a follow-up, not this chunk.
- Gating the *prompt* on the resolved section set. Once the four are non-blocking, asking for a
  section a project has disabled costs some prompt words and renders nothing — no failure. The
  CC-6 conflict `5739071c` introduced is dissolved by the optional change rather than needing its
  own mechanism.
- Any change to the other 14 pipeline steps.
- Replying to / crediting GURULifeline on #1379 — operator's call, drafted separately.

## Design

**`optionalCaptureFields: string[]`** — a new, additive key on an `ai-content` step spec.

- `_parseFields` is handed `captureFields ∪ optionalCaptureFields`, so an optional heading is
  parsed and staged when the AI writes it. (Without this the naive "just shorten `captureFields`"
  fix silently does nothing: the parser only recognises headings it was given.)
- Validation still filters on `captureFields` alone, so only the core three can block.
- Unset ⇒ byte-identical behavior to today. No consumer changes required.

Chosen over making `captureFields` entries objects (`{name, required}`), which would break the
array's shape for `wrapShapeFromTemplate` and every existing reader.

`wrapShape().captureFields` reports the **union**. It is a descriptive legacy HTTP-contract field
("what this wrap captures"), `origin/main` already publishes seven, and narrowing it back to three
would be a second contract wobble for no gain.

The four prompt bullets are rewritten to the contract's definitions above. `5739071c` described
`Delta` as "strict list of what was actually changed", which contradicts the contract.

## Chunks

- [x] **C1 — `optionalCaptureFields` in the step handler.** `lib/wrap-steps/ai-content.js`: parse
  the union, validate the core, at **both** sites (tmux `:874`, gateway `:1158`). Module docstring
  updated. Tests: optional-absent completes; optional-present captured; core-absent still blocks;
  each asserted on both transports.
- [x] **C2 — Pipeline + continuity wiring.** `lib/wrap-default-pipeline.js`: move the four to
  `optionalCaptureFields`, rewrite their prompt bullets to the contract definitions.
  `lib/wrap-steps/continuity-write.js`: `_resolveCapturedFields` reads the four and its JSDoc
  matches what it returns; the `sections{}` map passes them through. Tests: a `parsedFields`
  carrying only the core three renders four honest-flagged sections; one carrying all seven renders
  eight filled.

  **The producer must run into the consumer.** `ai-content` and `continuity-write` meet at literal
  key names (`delta`, `openThreads`, …), and a fixture built from the consumer's assumption tests
  the consumer against itself (Train 13 chunk 03 learning; [[feedback_measure_against_the_real_shape]]).
  At least one case drives real `ai-content` output — parsed from a real `.wrap-summary.md` body —
  into real `continuity-write`, so a spelling drift between the two fails rather than passes.
- [x] **C3 — Records.** `CHANGELOG.md` under `### Fixed` with a `Reported-by` credit; ADR 0002
  amended for the new step key.

## Boundary investigation

`optionalCaptureFields` adds a key to the `ai-content` step spec — a contract surface. Every
consumer was enumerated and checked rather than reasoned about:

- **`wrapShape().captureFields`** (`lib/wrap-default-pipeline.js`) — the only path by which capture
  field names leave the pipeline. Its consumers are `lib/sessions.js:2359` (the wrap HTTP payload
  and `autoCompleteWrap`) and `server.js:4860`, which forwards it. Now reports the union, so the
  payload publishes the same seven names `origin/main` already does — no consumer sees a change.
- **`lib/wrap-pipeline.js:_planAiContentPrompts`** — the webui prompt roster. **This one was
  missed on the first pass, and all three Critic reviewers found it independently.** It asked
  "does this step capture?" as `captureFields.length > 0`, which became half the contract the
  moment a step could declare only optional fields: the handler would prompt such a step while
  the roster left it out of the operator's `step N of M` denominator. Closed by construction —
  `_hasCaptureContract` is exported from the handler and the roster calls it, so one definition
  serves both. Two pipeline guards had the same shape and were converted with it
  (`test/wrap-default-pipeline.test.js`'s captureFile pin, which would have SKIPPED an
  optional-only step, and `test/wrap-pipeline-prompts.test.js`'s parseable-protocol check).
- **`lib/wrap-step-overrides.js`** — `resolveStep` spreads the base step, so the new key survives
  resolution; the allow-list is closed, so a project override cannot reach it. Both confirmed by
  invoking `resolveStep` directly, with and without an override.
- **`lib/wrap-steps/index-describe.js`** — the other caller of `aiContent.run`. It delegates with
  no capture fields at all, so `_resolveCaptureContract` returns two empty lists and it stays on
  the ≥20-char response path, unchanged.
- **`lib/skills.js`** — the `wrapShapeFromTemplate` shim ADR 0002 describes no longer exists
  (deleted with the methodology layer, #538), so the template-side union it documents has no
  live code. The ADR text is historical, not a surface to update.

One consumer required a change (`_planAiContentPrompts`), and the first version of this section
claimed none did. The claim was the defect: I enumerated the consumers of `wrapShape()` — the
descriptive path — and never grepped `\.captureFields` for sites deciding a *capability*. The
grep is now the check, and `_hasCaptureContract` is what those sites call, so the next one is a
compile-time question rather than a memory test.

## Done when

Suite green, `/prawduct:critic` run with blocking findings resolved, all three Status boxes ticked.
