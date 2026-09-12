# #1404 — A wrap Retry re-prompts content steps that already captured

**Issue:** #1404 (open). **Branch:** `fix/1404-wrap-replay`. **Worktree:** `.claude/worktrees/1404-wrap-replay`.
**Critic mode:** chunk. **Size:** medium (runner + one step handler + registry).
**Prior art to read, not repeat:** closed PR #1428 (reworded the error; review found it asserted a
cause nothing checks, broke two tests, and did not fix the bug).

## What discovery found — the issue's mechanism is incomplete

The issue says the captureFile is deleted on read, so a replay finds nothing. True, but deleting
later (the issue's option 1) fixes nothing, for two reasons read from the code:

1. **A Retry is a brand-new pipeline run.** `lib/sessions.js#_triggerWrapPipeline` →
   `lib/wrap-pipeline.js#runWrapPipeline` builds a fresh `runState = { results: [], staged: {} }` and
   runs every step from step 1. The first pass's parsed fields lived only in that discarded
   `staged`, so nothing of the earlier capture survives either way.
2. **Every content step arms before prompting** (`ai-content.js#_runTmuxCapture`, #840): it deletes
   any existing captureFile *before* the prompt, so a leftover can never pose as this run's output.
   A kept file would be deleted by the arm anyway.

So on a Retry, `memory-update` re-prompts the AI to write a summary it already wrote. If the AI
reasons "already done" and writes nothing, the step blocks with ENOENT — and the message blames the
prompt. The waste (re-prompting every done content step, padded records) and the misleading message
are two faces of one defect: **Retry replays completed content steps instead of resuming.**

GURULifeline's second report (a near-empty `continuity/wraps/` for weeks) is consistent with this but
not proven by it — killed-before-wrap sessions also leave no record. Out of scope to diagnose here;
noted on the issue.

## Options

- **A. Resume content steps on Retry (recommended).** When a wrap is retried for the same project
  AND same session, and the previous run ended BLOCKED (never committed) and is recent, an
  `ai-content` step that finished `done` in that previous run reuses its recorded result + staged
  fields instead of re-prompting. Everything else re-runs as today (tests, lint, git steps are cheap
  and must see current state). Carried in the process-local `wrapRunRegistry`, which already keeps
  the last run's result per project; a server restart forgets it, which is the honest scope.
  Keyed on session id so another session's capture can never be reused — the #840 hazard.
- **B. Honest message only.** Distinguish "the AI did not write the file on this pass" from "the read
  failed" (non-ENOENT, bridge error), and when the previous run captured this step, say so from the
  record. Cheap; does not stop the re-prompting or the waste.
- **C. Option 1 from the issue (defer the delete).** Rejected: the #840 arm deletes it anyway, and
  removing the arm reopens "another session's summary becomes this commit's subject".

**Recommendation: A + B.** A removes the cause; B keeps the message honest for the cases A does not
cover (first pass, a different session, after a restart).

## Out of scope

- #1405 (learnings-capture against an already-written file) — fires less often after A, stands alone.
- The empty-wraps-directory report — separate diagnosis.
- Gateway (webui) resume parity: B applies to both paths; A's resume is runner-level, so it covers
  both by construction — verify, don't assume.

## Status

- [ ] a — Registry keeps the blocked run's reusable content-step results (session-scoped).
- [ ] b — Runner reuses them on a same-session Retry; results say `resumed` so the drawer is honest.
- [ ] c — Honest ENOENT / read-failure wording on tmux and gateway paths; update the two tests that
      pin the old wording as a deliberate contract change.
- [ ] d — Tests (resume, cross-session no-reuse, restart no-reuse, committed-run no-reuse), CHANGELOG `### Fixed`, FEATURES.
