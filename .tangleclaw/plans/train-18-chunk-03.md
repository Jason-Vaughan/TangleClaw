# Train 18 — Chunk 03: step completion marker & learnings content verification

**Issues:** #1450 (the step-injection race; its `HEAD~10` half shipped in Chunk 02), #843, #1405
(the same learnings-capture defect filed from TangleBrain; closes with #843)
**Branch:** `fix/train-18-chunk-3-step-sentinel`
**Worktree:** `TC-a02` (touches `lib/`; does not run in the live install)
**Critic mode:** cumulative
**Size:** medium (one step handler's completion loop, one new satisfaction predicate, the default
pipeline spec, docs)
**Train blueprint:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Coordinator/.tangleclaw/plans/train-18-blueprint.md`
(Coordinator-owned) §2, §5
**Authorized:** operator "GO" in the Builder pane, 2026-09-14. Completion-fallback ruling: operator chose
"Marker first, fallback" in the Builder pane, 2026-09-14 (D2).

---

## Confidence check

**Problem.**
1. *Race (#1450).* An `ai-content` step over tmux treats the step as finished when `detectIdle` sees the
   last 3 pane lines unchanged for 10s. Those lines can hold still while the AI is still working. A
   TUI keeps its input box and footer at the bottom of the pane, and a model can think silently. The
   runner then sends the next step's prompt into a session that has not finished this one. On the
   Video Engineer wrap, step 2's prompt arrived before step 1 had replied or edited anything.
   *Hypothesis, not measured:* the static-footer mechanism. The symptom is the report's.
2. *Learnings gate (#843, #1405).* `learnings-capture` passes only when `learnings.md` changes during
   the step. An entry the session wrote before the wrap, or one written after a blocked attempt, sits on
   disk but reads as "reported done, edited nothing", and the documented remediation admits that Retry
   blocks again. The only way through is to write more, which the step's own prompt forbids.

**Success.**
1. Every tmux `ai-content` prompt ends with a completion instruction carrying a fresh nonce. The step
   finishes the moment the pane shows `TCWRAP-DONE <nonce>`. A marker from an earlier attempt, and the
   prompt's own text, can never match.
2. With no marker, a watched output file that changed and settled still finishes the step (#672). Pane
   quiet finishes it only after 60s during which the recent pane (not its last 3 lines) did not change.
   The step records how it finished (`completedVia`), and a quiet finish says on the step row that no
   marker was seen.
3. `learnings-capture` passes without a mutation when `learnings.md` was modified at or after the
   session started AND carries an entry (`## YYYY-MM-DD` heading or the no-op line) dated within the
   session. An old file untouched since before launch still blocks. A session whose start time is
   unknown keeps today's mutation-only gate.
4. A Retry after that block clears on an entry already on disk, and the remediation says so.

**Out of scope.** The drawer's "taking long" warning, elapsed time and delegated-remediation Retry
(Chunk 4, which consumes `completedVia`). The gateway path: ClawBridge's `inputReady` is the bridge's
own turn-end signal, not the pane-idle heuristic that races, so it is unchanged. `detectIdle` itself,
which other consumers (session status, Medusa wake, chime) rely on. It is only no longer the wrap's
completion signal.

**Requirements confidence: HIGH** for 1 and 3 (blueprint §2, #843's own fix shape). **HIGH** for 2's
direction (operator ruling), **MEDIUM** for the 60s figure (D2, vetoable). **MEDIUM** for 3's session
window (D4 names the limit).

---

## Decisions

**D1 — the marker.** A fresh 8-hex nonce per prompt send (`crypto.randomBytes`, behind
`_internal.newNonce`). The prompt's last paragraph is: *"When this step is finished, print one final
line containing TCWRAP-DONE, then a single space, then `<nonce>`."* The matcher is
`/TCWRAP-DONE[\s`*'"]*<nonce>/`. That tolerates a rich TUI restyling backticks or bold, and a model
quoting the token. It never matches the prompt text, because the prompt separates the two parts with
", then a single space, then". The pane is read each poll as the last 80 lines, joined with nothing,
so a soft-wrapped marker still matches. A new nonce per send means an earlier attempt's marker in the
scrollback cannot finish a Retry. The token is plain text because a TUI that renders markdown strips
`##` (#287). The existing `## Result` instruction stays as the content convention; it is not the
completion signal.

**D2 — completion order and the honest fallback (operator ruling).** Each poll, first match wins:
1. `marker`: the nonce line is present.
2. `files`: the #672 file-settle signal, unchanged.
3. `quiet`: the 80-line pane read has been byte-identical for `QUIET_FALLBACK_MS` (60s).

`detectIdle` is no longer consulted by this handler. Its 3-line window is the race. A pane whose
spinner or stream is moving is not quiet under the 80-line read, so a working TUI does not trip the
fallback, and an engine that never prints the marker still completes after a real minute of silence
rather than stalling to `MAX_WAIT_MS`. This is wrap Direction commitment 2 applied: the marker is a
hint that makes capable engines exact, and its absence degrades visibly instead of blocking.

The result's `output.completedVia` is `marker|files|quiet`. A `quiet` finish carries
`output.completionNote`, "no completion marker seen — finished after 60s of an unchanged pane", so
the row says it. A pane read that throws blocks as the idle probe's failure did, naming the pane read.
The timeout copy stops saying "no idle detected" and names what was waited for.

**D3 — `learnings-entry` satisfaction predicate.** `lib/wrap-steps/learnings-coverage.js#evaluate(projectPath, paths, scope)`.
It returns the verdicts `changelog-coverage` uses (`covered | uncovered | unavailable`), and
`_satisfactionPredicateGate` dispatches on the name through a small table rather than a second
if-branch.
- `unavailable` when `scope.startedAtMs` is null (a legacy row). The gate falls back to the
  mutation blocker, as today.
- `covered` when the file's mtime ≥ `startedAtMs` AND it carries a `## YYYY-MM-DD` heading or a
  `- YYYY-MM-DD: no novel learnings` line whose date is ≥ the local date of `startedAtMs` and ≤ today
  (local, `_date.todayIsoLocal`, matching the prompt's and `learnings-db-write`'s convention).
- `uncovered` otherwise: a blocker naming the missing dated entry, with a remediation promising that
  an entry already on disk counts on Retry, and that Skip & note remains for a deliberate no-entry.

The pipeline spec gives `learnings-capture` `verifySatisfiedBy: 'learnings-entry'`. The prompt's
"How this step is verified" sentence says an entry written earlier in the session counts.

**D4 — the session window, and its known limit.** mtime alone would credit any write since launch,
and a dated heading alone would credit a previous session's entry from earlier today. Requiring both
closes each hole. Remaining limit, written into the docs: when a session edits `learnings.md` after
launch without adding an entry, while a previous session's same-day entry is still in the file, the
step passes. No content snapshot of a gitignored file exists at launch to tell them apart, and the
cost of a false pass is a missing learning, not lost work.

**D5 — the Direction record.** The gate stays hard. Content evidence is route 2 of the same gate, the
way `changelog-coverage` is, not a waiver, so no departure is taken. `wrap-direction.md` gets an
Instances entry for #1450 (marker as a hint with an honest fallback, commitment 2) and #843 (hard
gate, content route, commitment 3). ADR 0002's `ai-content` row replaces the `detectIdle` completion
description and names the `learnings-entry` predicate. The #826 no-op sentinel line is unchanged, so
`learnings-db-write.js` and its test stay as they are.

---

## Build steps

- **03a** — Marker + completion loop (D1, D2) in `ai-content.js`: nonce seam, prompt suffix, 80-line
  poll read with a quiet tracker, `completedVia` / `completionNote`, timeout copy. Tests:
  - A marker finishes the step on the first poll after it appears.
  - The prompt text alone never matches, including soft-wrapped and backtick-restyled.
  - A Retry's new nonce ignores the old marker.
  - A moving pane never quiet-finishes before `MAX_WAIT_MS`.
  - A static pane quiet-finishes at 60s, not at 10s (the #1450 regression: static footer while
    working).
  - File-settle still wins over quiet.
  - A throwing pane read blocks.
  Existing tests that stubbed `detectIdle` move to a marker or quiet stub. Each moved test keeps its
  assertion.
- **03b** — `learnings-coverage.js` (D3, D4), predicate dispatch table, pipeline spec + prompt sentence.
  Tests on real temp files:
  - An entry written before the wrap passes on the first attempt (GURULifeline's scenario).
  - An entry written between a blocked attempt and Retry passes.
  - The no-op line passes.
  - An old file untouched since launch blocks.
  - A same-day heading in a file not modified since launch blocks.
  - A null `startedAtMs` falls back to the mutation gate.
  - A guard: deleting `verifySatisfiedBy` from the spec turns the landed-entry test red.
- **03c** — Docs: ADR 0002 row, `wrap-direction.md` Instances, `FEATURES.md` content-step line,
  `api-contract.md` if it lists step output fields, CHANGELOG `[Unreleased]` `### Fixed` crediting
  @GURULifeline for #843's regression scenarios and #1450's report, `.prawduct/change-log.md`.
  Bookkeeping: archive `train-18-chunk-02.md`.
- **03d** — Live check on a scratch server (tailnet IP, own `TANGLECLAW_HOME`): a Claude session wraps
  with the content steps enabled.
  - (1) Each step's row finishes `completedVia: marker`, and no prompt lands before the previous
    marker.
  - (2) A `learnings.md` entry written before the wrap passes learnings-capture with no new edit.

## Done when

Suite green; the 03d check observed; `/prawduct:critic cumulative` with no unresolved blocking findings;
PR opened (`Fixes #1450`, `Fixes #843`, `Fixes #1405`); the Coordinator pinged with the PR link.

## Status

- [ ] 03a completion marker + honest fallback
- [ ] 03b learnings-entry predicate
- [ ] 03c docs
- [ ] 03d live check
