# Build Plan: Antigravity-window review fixes (v5.8.0..v5.10.0)

**Type:** Bugfix / cleanup (mixed) · **Size:** Medium (10 files, no new dependency, no new API surface)
**Scope:** `antigravity-window-990`
**Critic mode:** cumulative (single PR, reviewed as one changeset at the end)

## Context

A multi-agent forensic review (5 dimensions, adversarially verified) audited the commit range
`v5.8.0..v5.10.0` — a window where a different AI engine (Antigravity) committed directly to
`main` with no Prawduct governance active. 17 raw findings collapsed to ~10 distinct root issues;
one (the `startWrapSse` ReferenceError) was already fixed post-v5.10.0 by #1005 and needs no
action here. This plan covers the rest, confirmed still live on `main` as of 2026-08-20.

**Requirements Confidence: High** for chunks 1, 4, 5, 6, 7, 8 (each independently verified against
current file contents, not just commit messages). **Medium** for chunk 2 (dead-code removal —
re-verified the SSE plumbing has zero remaining consumers via repo-wide grep, but removing a whole
subsystem carries more risk than a local fix). **Medium** for chunk 3 (scope refined during
planning: the original finding said "unreachable Codex dead code"; investigation found the actual
defect is worse — `codex.json` advertises `capabilities.supportsSilentPrime: true`, which
`public/ui.js`/`lib/projects.js` read generically to enable a UI toggle, so an operator can enable
"Silent Prime" for a Codex project and it silently does nothing. Fix is to stop advertising the
capability, not just delete unreachable code).

## Chunks

### Chunk 1 — Shared-doc watcher: retarget on filePath change, cleanup on delete [BLOCKING]
**Files:** `server.js`, new/extended test file for shared-doc watchers.
**Problem:** `refreshSharedDocWatchers()` only creates a watcher when `!sharedDocWatchers.has(doc.id)` —
editing a doc's `filePath` never re-targets its watcher (stale watcher, no notifications on the new
path). `DELETE /api/shared-docs/:id` never calls into watcher cleanup — every deleted doc leaks its
`fs.watch` handle and any pending debounce timer for the life of the server process.
**Fix:** `refreshSharedDocWatchers()` for a given doc closes and re-creates its watcher when the
doc's live `filePath` differs from what its current watcher is watching. `DELETE /api/shared-docs/:id`
closes the doc's watcher (if any) and clears its debounce timer before deleting the doc.
**Tests:** watcher retargets on filePath update (fires on new path, not old); watcher + timer are
gone after delete (no leaked handle); regression test reproducing both original bugs.
**Done when:** both bugs fixed, tests pass, `node --test test/*.test.js` green.

### Chunk 2 — Remove dead live-wrap-progress SSE subsystem [dead code]
**Files:** `server.js` (SSE route), `lib/wrap-run-registry.js` (`events`, `stepDone`), `lib/wrap-pipeline.js`
(`onStepDone` hook call), `lib/sessions.js` (hook wiring).
**Problem:** The whole subsystem (EventEmitter, SSE route, per-step event payloads) was built for
#185 but its only client consumer (`startWrapSse()` in `public/session.js`) was already removed by
#1005 as part of fixing the ReferenceError crash. Repo-wide grep (not just `public/`/`test/`)
confirms zero remaining references to `wrap/stream`, `wrapRunRegistry.events`, or `EventSource`
anywhere outside the dead code itself.
**Fix:** Remove the SSE route, the `events` EventEmitter and `stepDone()` export from
`wrap-run-registry.js`, the `onStepDone` hook call from `wrap-pipeline.js`, and the wiring from
`sessions.js`. Keep `updateStep`/`finish`/`get`/`anyRunning` — those are live.
**Tests:** update/remove tests that reference the removed exports; full suite stays green; confirm
no test regresses (this is subtraction, not addition — the removed code had zero test coverage
per the review, consistent with it never being exercised).
**Done when:** dead code removed, suite green, no dangling references.

### Chunk 3 — Stop `codex.json` from advertising unreachable Silent Prime support [bug, was misclassified as dead code]
**Files:** `data/engines/codex.json`, `data/hooks/sessionstart-prime-codex.sh` (delete),
`data/hooks/sessionstart-rules-codex.sh` (delete).
**Problem:** `syncEngineHooks()` early-returns (clearing hooks) for any engine that isn't `'claude'`
before ever calling `_buildBaselineHooks()` — so `_buildBaselineHooks()` is only ever invoked with
`store.engines.get('claude')`'s own profile (confirmed by reading the call site). `codex.json`
declaring `capabilities.supportsSilentPrime: true` is therefore not just unreachable — `public/ui.js`
and `lib/projects.js` read that capability flag generically (not claude-specific) to decide whether
to show/enable the "Silent Prime" UI toggle for whichever engine is selected. An operator can
enable it for a Codex project; nothing happens; no honest skip reason is shown. Direct violation of
this repo's own engine-neutrality rule ("an adapter must report an honest skip reason, never
silently do nothing").
**Fix:** Remove `capabilities.supportsSilentPrime`, `silentPrimeScript`, `silentRulesScript` from
`codex.json`. Delete the two now-fully-unreachable script files. File a backlog item: real Codex
hook support, if still wanted, needs redesigning against Codex's actual config format (YAML, not
TOML) and a real `syncEngineHooks()` path for non-claude engines — out of scope for this fix.
**Tests:** existing `test/engines.test.js` coverage for `supportsSilentPrime === false` behavior
already covers the "capability absent" path; add/adjust a test asserting `codex.json` no longer
advertises the capability, and that the UI-facing capability check for codex returns false.
**Done when:** capability no longer advertised, dead script files removed, backlog item filed,
suite green.

### Chunk 4 — Multi-file upload: FileReader error handling [BLOCKING-ish, silent hang]
**Files:** `public/session.js`, test coverage.
**Problem:** `handleFileSelect`'s multi-file rewrite has `reader.onload` but no `reader.onerror` —
a failed file read leaves the completion counter short forever, submit button stays disabled, no
error shown, no recovery except reload.
**Fix:** Add `reader.onerror` that surfaces a visible error for the failed file (naming it) and
either lets the batch continue (excluding the failed file) or cleanly resets the modal state —
whichever matches the existing single-file error-handling convention in this file most closely.
**Tests:** simulate a FileReader error mid-batch; assert an error is shown and the modal recovers
(submit button doesn't stay permanently disabled).
**Done when:** error path has coverage, tested behavior matches the fix, suite green.

### Chunk 5 — Dedupe shared-doc notify logic [WARNING, quick win]
**Files:** `server.js`.
**Problem:** `broadcastSharedDocUpdate()` and the inline body of `POST /api/shared-docs/:id/notify`
re-implement the same lookup/filter/broadcast sequence near-verbatim, already diverging (different
404 handling for a missing doc).
**Fix:** Route handler calls `broadcastSharedDocUpdate()` and shapes its HTTP response from the
return value, instead of re-implementing the sequence.
**Tests:** existing tests for both paths still pass; confirm no behavior change (same response
shape) beyond the dedup itself.
**Done when:** one implementation, both call sites use it, suite green.

### Chunk 6 — Quick wins: FEATURES.md, vestigial assertion [NOTE/WARNING]
**Files:** `FEATURES.md`, `test/sessions.test.js`.
**Fix:** Add a FEATURES.md entry for the continuity/Next-Action-preview/Continue-Fresh feature
(#342/#372, shipped by d0499c3, never documented). Remove the vestigial always-true assertion at
`test/sessions.test.js:2981` (`assert.ok(true, ...)` left over from splitting the #583 hook check) —
confirm the real assertion it was split from still covers the behavior before removing.
**Done when:** FEATURES.md entry present, vestigial assertion removed, suite green.

### Chunk 7 — CHANGELOG correction entry for the fabricated v5.9.0 "Master Session Recovery" fix
**Files:** `CHANGELOG.md` (`## [Unreleased]` section only — the v5.9.0 section is released history
and stays untouched, per this repo's own immutability principle).
**Problem:** v5.9.0's `### Fixed` section contains "Master Session Recovery (#342, #372, #348):
Hardened the Master session update loop against orphaned tmux states and lingering cache files" —
verified fabricated: no commit anywhere in this repo's history touches Master-session tmux
recovery or cache handling; #342/#372/#348 are actually about session continuity (d0499c3), not
Master recovery.
**Fix:** Add a dated correction note to `## [Unreleased]` (`### Fixed` or a clearly-labeled
retraction) stating the v5.9.0 entry was inaccurate/fabricated and what #342/#372/#348 actually
shipped (the continuity feature), without editing the locked v5.9.0 section itself.
**Done when:** correction entry present, `node --test test/changelog-*.test.js` still green (the
immutability guard must not fire on this — we're adding, not touching v5.9.0).

## Status

- [x] Chunk 1 — Shared-doc watcher fixes
- [x] Chunk 2 — Remove dead SSE subsystem
- [x] Chunk 3 — Stop codex.json advertising unreachable Silent Prime (backlog ENG-8V3N filed)
- [x] Chunk 4 — Multi-file upload FileReader error handling
- [x] Chunk 5 — Dedupe shared-doc notify logic
- [x] Chunk 6 — FEATURES.md + vestigial assertion (also caught: commit's "Next Action preview" claim doesn't match shipped code — noted in FEATURES.md and CHANGELOG, not separately fixed)
- [x] Chunk 7 — CHANGELOG correction entry

All chunks complete. Full suite: 6508 pass / 0 fail / 1 skipped (baseline was 6501/0/1).

## Critic review (cumulative, commit bfae801)

`rev-20260820T181429Z-411d7e43` — 0 blocking, 2 warning, 2 note. All 4 dispositioned:

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | fixed — JSDoc added to closeSharedDocWatcher |
| R-2 | note | accepted | fixed — removed the dead `failed \|\|` clause, added a comment explaining why it was safe to drop |
| R-3 | warning | accepted | fixed — comment now says the server-side SSE plumbing was also removed, not just awaiting a client |
| R-4 | note | accepted | DOC-2Q7X is already flagged as an approximate floor (updated earlier today by the norm health sweep); one resolved citation among ~16 known sites doesn't warrant another backlog round-trip |

Next: commit the 3 fixes as one commit, `verify-resolutions`, then PR.

## Context (cross-session handoff)

Branch: `fix/antigravity-window-review-990`. Baseline: `node --test test/*.test.js` — 6501 pass, 0
fail, 1 skipped, clean before this plan started. GitHub issue #990 is the umbrella governance
finding this review responds to. After all chunks: run `/prawduct:critic` (cumulative), resolve
findings, then PR per user's earlier request (correction entry + close 5 stale-open issues
#185/#771/#790/#770/#769 handled outside this plan, directly via `gh issue close`).
