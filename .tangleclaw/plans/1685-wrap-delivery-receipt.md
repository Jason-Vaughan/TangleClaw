---
title: "#1685 — Wrap prompt delivery receipt"
status: IN PROGRESS
issue: 1685
branch: fix/1685-wrap-delivery-receipt
authorized_by: TangleClaw-ProjectManager dispatch, 2026-09-20 (Chunk 06 final piece; Architect ruled #1685 before the Train 21 close-out)
parent_plan: /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder1/.tangleclaw/plans/train-21-phased-launch.md
type: bugfix
size: medium
---

# #1685 — Wrap prompt delivery receipt

## Problem

`lib/wrap-steps/ai-content.js` calls `_internal.sendKeys(...)` and, when it does not throw,
immediately logs `ai-content prompt sent`. `lib/tmux.js::sendKeys` returns after: clear composer →
`load-buffer` → `paste-buffer -p -t <target> -d` → 500 ms sleep → `send-keys Enter`.

Every one of those succeeds at the tmux level whether or not the engine turned the bytes into a
task. tmux reports that a pty accepted characters; it knows nothing about whether a TUI submitted
them. So an unsubmitted prompt is indistinguishable from a slow model, and the wrap waits
`MAX_WAIT_MS` (300 s) before reporting a generic model non-completion.

Observed in wrap run `61e435294f079a2e8550729eb2c51e79` (#1685): the first content step completed
with a correct marker, the second was logged as sent, and no corresponding user message ever
appeared in the engine's transcript.

## Requirements confidence: HIGH on mechanism, MEDIUM on the incident

The mechanism above is read directly from the code and is not in doubt. **This plan does not
assert it as the root cause of the 07:00 incident** — #1685 explicitly forbids that, and forbids
asserting a still-running-turn race, user interference, lost Enter, or engine corruption. The fix
is justified on its own terms: the boundary reports success it cannot know.

## Requirements

- R1 — After submission, produce a **delivery outcome distinct from "the model received the task
  but has not finished."**
- R2 — **Bounded.** Receipt resolution must not add materially to wrap latency, and must never
  extend the existing 300 s wait.
- R3 — **Never blindly re-paste or re-send Enter** over operator drafts, busy tasks, or
  already-accepted input. Duplicate submission must be prevented.
- R4 — **Engine-agnostic.** Engines without the vocabulary get an honest declared skip, never a
  silent pass (project rule: no feature may require one engine; adapters must explain skips).
- R5 — Drawer identifies the exact waiting/failing stage, and distinguishes content-step
  completion from lifecycle/publication.
- R6 — Regression tests for consecutive content steps: first marker/turn completes, second prompt
  is dropped / rejected / unsubmitted. Across supported engines and delivery paths.
- R7 — Preserve nonce checks, write verification, task boundaries, truthful no-plugin skips.

## Design

TangleClaw already owns the vocabulary. `data/engines/*.json` declare `capabilities.wake`:

| engine | busyMarker | idleMarker | promptPattern | promptGlyph |
|---|---|---|---|---|
| claude | ✓ | — | ✓ | ✓ |
| codex | ✓ | ✓ | ✓ | ✓ |
| antigravity | ✓ | ✓ | ✓ | ✓ |
| aider | — | — | — | — |
| openclaw | — | — | — | — |

`ai-content.js` uses none of it (`grep busyMarker|idleMarker|promptPattern|capabilities.wake`
against that file returns zero hits). The receipt is a **wiring** job, not an invention.

**After submit, poll the pane briefly for evidence the prompt became a task:**

- **accepted** — the pane left its at-rest state: busy marker present, or the composer no longer
  shows the at-rest prompt pattern.
- **not-accepted** — the pane is still at rest AND the composer still matches the at-rest prompt
  after the bounded window. The prompt did not become a task.
- **unknown** — the engine declares no vocabulary, or the pane could not be read.

### The one defect class to design against

Train 21's car 21.10 shipped this exact failure three times (parent plan, Chunk 04): **a value made
honest at one level and flattened at the next.** Here that would be collapsing `unknown` into
either `accepted` (silent pass — the bug we are fixing, restored one layer up) or `not-accepted`
(false alarms on aider/openclaw, which would be worse than today).

**`unknown` is a third value end to end** — in the return, the log, the step result, and the
drawer. It never degrades to either neighbour.

### Explicitly NOT doing

- **No automatic re-send.** R3 forbids blind re-paste, and a re-send on a misread `not-accepted`
  double-submits a task. The receipt **reports**; remediation stays a separate decision.
- No change to `MAX_WAIT_MS`, the marker protocol, the nonce, or the capture-file contract.
- No root-cause claim for run `61e435294f079a2e8550729eb2c51e79`.

## Chunks

- [ ] **C1 — Receipt primitive.** Engine-aware `verifySubmission` reading `capabilities.wake`;
      returns `accepted | not-accepted | unknown` with a reason. Unit tests per engine, including
      both no-vocabulary engines.
- [ ] **C2 — Wire into `ai-content.js`.** Replace the unconditional `prompt sent` log with the
      receipt outcome; a `not-accepted` fails the step fast with a delivery blocker rather than
      waiting 300 s. `unknown` proceeds to the existing wait and says so.
- [ ] **C3 — Drawer + step result.** Surface the stage and the delivery outcome; keep content-step
      completion distinct from lifecycle/publication.
- [ ] **C4 — Regression suite.** Consecutive-step scenarios per R6.
- [ ] **C5 — Record + VRF.** CHANGELOG, plan Status, and enqueue the live VRF.

## Done when

R1–R7 met, suite green, `/prawduct:critic` run and blocking findings resolved, PR open, parent
plan's `#1685` box ticked, and the live VRF **enqueued** in `.prawduct/operator-verification.md`.

## Acceptance is NOT self-certifiable

#1685 requires "a real consecutive-step wrap without manual operator nudges" and states that
fixture success alone is not end-to-end delivery evidence. A verification whose premise is that no
operator nudged it cannot be signed by the agent that ran it. C5 stages it with exact steps; the
operator signs.
