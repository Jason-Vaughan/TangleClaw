# Change Log — TangleClaw

<!-- Append new entries at the top.

Merge conflicts: a conflict at the top of this file is expected, because every branch
prepends here. Keep both entries, newest first. In a lane, rebuild the file as origin/main's
copy plus your own entry. `.gitattributes` deliberately does not union this file (#2042):
union kept both sides' lines without a conflict and silently corrupted entries.


Tag-line conventions (ART-4K9M, ratified 2026-07-17):
- scope=  : ONE scope per unit of work. Work done under an ACTIVE build plan uses that
  plan's frontmatter scope (its ## Status roster derives checkbox flips from these tags).
  Post-plan work — backlog items, GH-issue fixes, chores landing after the plan is
  archived — gets its OWN scope (kebab-case of the backlog id or issue, e.g. ui-2p7t,
  wrap-583), NEVER a borrowed scope from an archived plan: an archived roster can't track
  new chunk ids, so borrowed tags rot (the ART-4K9M failure). A scope with no build-plan
  file is fine — regen-views flags it only while status=merged, and deliberately not once
  status=shipped (retired/planless scopes are expected history).
- chunks= and status= : **RETIRED upstream (prawduct 3.4.0, `lib/change_log.py`), along with
  the derived views that were their only reader.** Which chunks an entry shipped now belongs in
  the entry BODY, where readers actually look — the 2026-09-06 entries write `Train 13 Chunk NN.`
  as their first line. Historical entries carrying either key still parse (the parser preserves
  unknown keys), so nothing below needs rewriting; the two bullets that follow are kept as the
  record of why they existed and are no longer instructions. Noted 2026-09-06 because this header
  still read as live guidance and produced a `chunks=05` tag line on the Chunk 05 entry before a
  Critic pass caught it.
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

<!-- Older entries live in .prawduct/change-log-archive/YYYY-MM.md, moved there verbatim by `prawduct-hook archive-change-log`. -->

## 2026-10-18 — #2285, #2146, #1563: one session-active rule in `server.js`, no reconciliation owed after READY, and a restart command built from the unit constant

<!-- prawduct: type=bugfix | scope=w13b1-session-active-ready-status-systemd-unit -->

v5.34.0 Wave 13 chunk W13-B1, chunk 1 of 1. Branch `fix/w13b1-session-active-ready-status-systemd-unit` from `origin/main` `5ccc310e`. Closes #2285, #2146 and #1563. Plan: `.tangleclaw/plans/build-plan-w13b1-session-active-ready-status-systemd-unit.md` (rev1 sha256 `44993ed6…477d`, INT and Architect A258); charter v2.37 (sha256 `189678a9…8734`).

**#2285.** `server.js`'s Fire `fireable` judgement and `_deliveryFacts` call `launchRecoveryClear.sessionIsActive` instead of spelling the same test inline; behaviour is unchanged (identical truth tables). A test pins that `fireable` and `sessionActive` agree as a session ends. The `_startupControlForLaunch` JSDoc loses its standalone ` (R-13)`: no standalone `(R-N)` review id remains outside the change logs. Three qualified or prose hits stay, outside this chunk's files (`lib/master.js`, `test/release-certification-runner.test.js`, `docs/prawduct-feedback.md`).

**#2146.** `status()` answers `readiness.reconciliationRequired: null` once `readyAt` is set: the trigger outlives READY, and the attestation already answered it, so `tc start status` no longer says the attestation "will need" one. The READY gate is untouched (it calls `_reconciliationRequired` directly). `renderStartStatus` also checks `readyAt`, so a newer CLI talking to an older server prints no false obligation.

**#1563.** `buildRestartCommand('systemctl')` builds the command from `SYSTEMD_USER_UNIT`; the exact-string test keeps its literal. The `restart button disabled` log goes through `_internal.log`, and four tests pin it: logged once, not repeated, logged on change, and logged again after an ok answer or a missing unit resets the remembered reason.

## 2026-10-18 — #1903 Chunk 03, #1437, #2234: eight more lift copies use the shared helper, and two doc claims match their ADRs

<!-- prawduct: type=refactor | scope=w13-a1-lift-chunk03-contributing-runbook -->

v5.34.0 Wave 13 chunk W13-A1, chunk 1 of 1. Branch `feat/w13a1-lift-chunk3-and-docs` from `origin/main` `5ccc310e`. Refs #1903 (Chunk 03); closes #1437 and #2234. Plan: `.tangleclaw/plans/w13-a1-lift-chunk03-contributing-runbook-1903-1437-2234.md` (rev3 sha256 `229b201e…63af`, INT `fc515f30`, Architect A259-rev3); charter v2.37 (sha256 `189678a9…8734`).

**#1903 Chunk 03.** `caddy-drift-surfacing`, `card-detail-disclosure`, `card-session-contract`, `create-flow-mode-picker`, `dashboard-boot-beacon`, `degraded-reads-frontend`, `engine-error-ui` and `engine-picker-gating` lift through `test/helpers/lift.js`, importing its own names (`liftDeclaration` / `liftBody`, D1); `INITIAL_INVENTORY` loses exactly those eight entries. The two name-based copies (`extract`, `sliceFunction`) become `liftDeclaration(src, 'function <name>(')`. `card-detail-disclosure` keeps its own `jsArg` construction bound to its local `esc` (D7). Failure messages are now the helper's (D2). No assertion, test name or test count changed.

**#1437.** `CONTRIBUTING.md` §7 cited ADR 0012 for "strictly zero-dependency", the claim that ADR records as false. It now says zero npm dependencies, names the external tools the product runs on, and keeps the rejection of any PR adding a `package.json`, lockfile or `node_modules` reference (A259). The Code Style bullet makes the same correction (D4).

**#2234.** The fleet runbook's merge-authority check asked `mergedBy` to show the merging session, which it cannot when every session acts through one GitHub account (ADR 0014, Amendment 2026-10-07). It now asks for the merging session's own logged report, and says when `mergedBy` can tell sessions apart.

**Tests.** A scratch preload outside the repository logged `file | decl | sha256` for every lift call while the eight files ran: 219 calls on a `git archive` of `5ccc310e` and on the branch, sorted logs identical (D3). Mutations: one `liftDeclaration` switched to `liftBody` changed the log and turned its file red; a private brace loop put back, and one entry left in the inventory, each turned the inventory test red.

**Review.** Cumulative Critic `rev-20261018T031044Z-c36fbf2b` on `599abe4c`: 0 blocking, 3 warnings (2 accepted, 1 fixed by this entry).

**rev-20261018T031044Z-c36fbf2b** — 2026-10-18T03:11:51Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | The declared suite runs once, detached, on the final tree in the Integrator's sole suite slot after the Architect's pre-suite read (charter order), and is recorded as test evidence before the ready report. Narrow ring on 599abe4c: the 8 migrated files (runtime counts unchanged vs 5ccc310e) plus lift-helper, 5 test-dir meta tests and dependabot-config passed 216/0. |
| R-2 | warning | accepted | README.md is outside the charter v2.37 12-file lock. The plan records it as residual R1, sent to the PM for triage (INT 1f0ae78f / b4dbcf26: not filed by this lane), with the proposed issue title '[docs] README "Zero dependencies" overstates ADR 0012's zero-npm claim'. |
| R-3 | warning | fixed-unreviewed | fixed in `.prawduct/change-log.md` |

**3 findings** (3 warning) — accepted: 2, fixed-unreviewed: 1.

## 2026-10-18 — W12-REC: the v5.34.0 Wave 12 combined records

<!-- prawduct: type=chore | scope=w12-rec-records -->

v5.34.0 records chunk W12-REC (charter v2.36). Branch `docs/w12-records` from `origin/main` `57572e56`, after W12-A1 PR #2474 (`bd1c1555`, closes #2470 and refs #1903 Chunk 02) and W12-B1 PR #2475 (`57572e56`, closes #2469 and #2253) merged. The Integrator authors this four-file records PR under A172.1.

**What changed.** `CHANGELOG.md` `[Unreleased]` receives two `### Fixed` and two `### Internal` entries, each below 400 UTF-8 bytes. `FEATURES.md` updates the existing changelog gate, shared lift and kickoff descriptions with stable source pointers. The W12-B1 change-log wall-time sentence no longer points to a gitignored host file; its measured values remain. `prawduct-hook archive-change-log --apply` moves older shipped entries verbatim into the October archive, keeping the newest entries live.

**Limits.** #1903 remains open for later inventory chunks; `server.js:4690` still has an `(R-13)` review id outside W12-B1's file lock. These records do not release, tag, bump a version or deploy.

## 2026-10-18 — #2469, #2253: the last review id leaves `lib/master.js`, and recovery test files exit when their last test ends

<!-- prawduct: type=bugfix | scope=w12b1-review-id-and-recovery-exit -->

v5.34.0 Wave 12 chunk W12-B1, chunk 1 of 1. Branch `fix/w12b1-review-id-and-recovery-exit` from `origin/main` `bdc1a8bb`, with `origin/main` `bd1c1555` (W12-A1, PR #2474) merged in. Closes #2469 and #2253. Plan: `.tangleclaw/plans/build-plan-w12b1-review-id-and-recovery-exit.md` (rev2 sha256 `f32d6af1…77e0`, INT and Architect A250); charter v2.36 (sha256 `c64b776f…c0`).

**#2469.** `lib/master.js`'s guard-posture comment loses ` (R-15)`, the only `(R-n)` left in the file; the sentence is otherwise unchanged. `server.js:4690` still carries `(R-13)`; it is outside this chunk's files and reported to INT (D5).

**#2253: cause.** `launchStubbed` stubs tmux and engine detection only for the launch call, but the launch defers a boot watch, a kickoff and a bootstrap past it. The kickoff then polls a pane that never existed every 750 ms until `IDLE_TIMEOUT_MS` (90 s), on a referenced timer, so each file using the fixture waited ~90 s after its last test.

**#2253: fix.** `lib/launch-kickoff.js`'s idle-poll sleep is unref'd: a pending kickoff never holds a process open by itself, and in the server the listener keeps the loop alive, so production behaviour is unchanged. `test/_recovery-fixture.js` holds no-pane stand-ins while a temp store is open: the kickoff answers `not-silent`, the bootstrap `fired`, and the boot watch reads the pane as gone; `restore()` puts all four back.

**Walls** (each file alone, `node --test`, no forced exit, all 8 run in parallel on this host; before measured on the unfixed branch): clear-batch 141 → 40 s, held 112 → 19 s, batch-read 100 → 9 s, clearance-audit 99 → 8 s, project-recovery-mode-control 95 → 4 s, fleet-recovery-panel 93 → 2 s, clear-one 4 → 3 s, clear-ended 2 → 2 s. After the fix, each file's wall equals its own `duration_ms` to within a second. With the kickoff unref alone (the fixture reverted) every file also exits when its last test ends, but its tests run longer (held 28.7 s, clear-batch 54.0 s), because the real kickoff and bootstrap still run.

**Tests.** `test/launch-recovery-held.test.js` gains three cases: the 20 s exit bound stays below `IDLE_TIMEOUT_MS`; a child `node` that launches through the fixture, waits until the deferred kickoff and bootstrap have both started, then restores, exits by itself within the bound (measured 0.4 s); and a child that only awaits `_internal.sleep(IDLE_TIMEOUT_MS)` exits within the bound (0.06 s). Red first on the unfixed tree: both child cases were killed at 20 s. With the fixture fixed and the unref reverted, the sleep pin fails and the launch pin passes. With the unref kept and the fixture reverted, both pass. So either change alone lets the launch child exit, the sleep pin alone tells them apart, and the fixture's stand-ins are measured by the walls above, not by a pin.

**Plan premise corrected (D2).** The plan expected a host with no tmux to leave the boot watch polling its 45 s window, which would have made the fixture's boot-watch stand-in load-bearing for the exit pin. Measured with `tmux` removed from the child's `PATH`: the unfixed fixture's boot watch still ended at `pane-gone` in 6 ms, because `tmux.probeSession` treats any non-timeout failure, including the shell's "command not found", as an answer that the session is gone. The stand-in is kept as approved, because the fixture's premise is that no pane exists.

**Narrow runs** on `15b2e89c`, all passing: the 8 fixture users, `launch-kickoff`, `launch-bootstrap-wiring`, `startup-dialog`, `startup-control-launch`, `master`, `master-control-bar`, `master-guard-source`.

**Review.** Cumulative Critic `rev-20261018T005619Z-ca64bac5` on `75fed2c5`: 0 blocking. An earlier inferred verify-resolutions round (`rev-20261018T005508Z-daaab597`) anchored to a W11 review and covered no span from `origin/main`, so the cumulative was run explicitly.

**rev-20261018T005619Z-ca64bac5** — 2026-10-18T00:57:38Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | The declared suite runs once on the frozen head in the Integrator's exact-head suite slot (charter order, after the Architect's pre-suite read) and is recorded as test evidence before the ready report. Narrow runs on 15b2e89c passed: the 8 fixture users plus launch-kickoff, launch-bootstrap-wiring, startup-dialog, startup-control-launch and the three master files. |
| R-2 | note | accepted | Known and recorded in the plan and change-log: the stand-ins' effect is speed, not exit, so a pin would have to time test runs. Their value is shown by measured walls (kickoff-only vs full fix: held 28.7 s vs 19.2 s, clear-batch 54.0 s vs 40.1 s); their loss costs longer runs, never a wrong result. |
| R-3 | note | accepted | Three copies is within tolerance and the other two are out of this chunk's six-file lock; extract to a shared helper if a fourth appears. |
| R-4 | note | accepted | #2469 and #2253 are GitHub issues closed by the PR's Closes lines; no local backlog item exists for them. |

**4 findings** (1 warning, 3 note) — accepted: 4.


## 2026-10-18 — #2470, #1903 Chunk 02: the changelog gate judges the commit a dormant methodology allows, and five lift copies use the shared helper

<!-- prawduct: type=bugfix | scope=w12-a1-coverage-withheld-prefixes-and-lift-migration -->

v5.34.0 Wave 12 chunk W12-A1, chunk 1 of 1. Branch `fix/2470-1903-w12-a1` from `origin/main` `bdc1a8bb`. Closes #2470; refs #1903 (Chunk 02). Plan: `.tangleclaw/plans/w12-a1-coverage-withheld-prefixes-and-lift-migration-2470-1903.md` (rev1 sha256 `c2ddeb14…e1d1`, INT `67f2f1f8`, Architect A249, PM §1.3(f) `d9c983f3`); charter v2.36 (sha256 `c64b776f…9dc0`).

**#2470.** On an engine that cannot run Prawduct, the commit step and `session-files` withhold `.prawduct/`, but `_sortForCommit` classified with no withheld prefixes, so a withheld edit to a changelog declared under `.prawduct/` could satisfy coverage for source work the commit ships. `evaluate` now takes `options.methodology`, and `_sortForCommit` classifies with `governance.withheldPrefixesFor(extra.methodology || null)`, the commit step's own derivation. `ai-content.js` passes `context.methodology || null` from both `_verifyChangedGate` call sites through `_satisfactionPredicateGate` and `_changelogCoveragePredicate` (one trailing optional parameter each, D2). It is read from the run's context and never from `options`, which a request body supplies. With no methodology nothing is withheld, as before.

**#1903 Chunk 02.** `_page-globals.js` (`liftDeclaration`, still exported as the shared one, D5), `account-self-service-ui`, `awareness-observability`, `behind-origin` and `bind-notice-render` lift through `test/helpers/lift.js`; `INITIAL_INVENTORY` loses exactly those five entries. `account-self-service-ui` keeps the slice's line head and `behind-origin` its optional `async ` through short adapters with no brace counting. A scratch script hashed all 25 lifted strings on `bdc1a8bb` and on the new tree: identical (D6). Failure messages are now the helper's (D7).

**Plan delta.** The plan's parity case put the project below the repo root and the withheld path at the root's `.prawduct/`, which the project-relative offset drops whatever is withheld, so it could not go red. The case now checks parity for a project at the repo root (red before the fix) and below it.

**Tests.** `test/wrap-changelog-coverage.test.js`: a withheld changelog edit leaves `app.js` uncovered; a runnable or absent methodology stays covered; `excluded` equals the commit step's `notCommitted` at both depths. `test/wrap-step-ai-content.test.js`: on both run paths the predicate receives `context.methodology` itself, and `null` when only `options` carries one. Red first on `main`; mutations (no `withheldPrefixes`, a hard-coded dormant capability, reading `context.options`, one call site only, an adapter without the line head) each went red.

**Review.** Cumulative Critic `rev-20261018T005447Z-c75651a2` on `1123eff0`: 0 blocking, 1 warning, 2 notes, all accepted.

**rev-20261018T005447Z-c75651a2** — 2026-10-18T00:56:27Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | The declared suite runs once, detached, on the final tree in the Integrator's suite slot after the Architect's pre-suite read (charter order), and is recorded as test evidence before the ready report. Narrow ring on head 1123eff0 (50 files: the locked tests, out-of-lock fixtures, every test naming changelog-coverage, ai-content, _page-globals or helpers/lift) passed 1950/0. |
| R-2 | note | accepted | The approved plan keeps _excludedFromCommit unchanged: a test-facing wrapper with no production caller, whose callers (wrap-file-ownership, wrap-file-safety) pass no methodology, so 'every path the wrap will not commit' holds for every call it receives. A doc edit now would buy a full review round for no behaviour change. |
| R-3 | note | accepted | Informational: the work is tracked by GitHub issues #2470 (closed by the PR) and #1903 (referenced, Chunk 02). |

**3 findings** (1 warning, 2 note) — accepted: 3.

## 2026-10-17 — W11-REC: the v5.34.0 Wave 11 combined records

<!-- prawduct: type=chore | scope=w11-rec-records -->

v5.34.0 records chunk W11-REC (charter v2.34). Branch `docs/w11-rec-records` from `origin/main` `86c2c505`, after W11-B1 PR #2471 (`e295e494`, closes #2164, #2036, #1640 and #1998) and W11-A1 PR #2472 (`86c2c505`, closes #2160 and #2465) merged. The Integrator authors this records-only PR under A172.1.

**What changed.** `CHANGELOG.md` `[Unreleased]` receives three `### Internal` entries for the two wrap changes and the store/test hygiene chunk, each below 400 UTF-8 bytes. `FEATURES.md` records the derived file lists, the one wrap-subject rule, the savepoint helper and test hygiene with stable source pointers. The archive hook's dry run moved zero entries: the live log is below its 40,000-byte threshold, so the October archive stays unchanged.

**Limits.** #2469 remains open for the stale source-comment review ID; #2470 remains open for the coverage gate's missing `withheldPrefixes`. The records do not release, tag, bump a version or deploy.

## 2026-08-20 — #990: forensic review of the ungoverned Antigravity window fixes 8 confirmed bugs

<!-- prawduct: type=bugfix | scope=antigravity-window-990 | chunks=01,02,03,04,05,06,07 -->

A 5-dimension multi-agent adversarially-verified review of commit range `v5.8.0..v5.10.0` — a
window where a different AI engine (Antigravity) committed directly to `main` with no Prawduct
governance active — surfaced 17 raw findings collapsing to ~10 distinct root issues. One
(`startWrapSse` ReferenceError) was already fixed post-v5.10.0 by #1005. This work fixes the rest,
confirmed still live on `main`:

- Shared-doc `fs.watch` handles never re-targeted on a `filePath` edit and leaked on delete — the
  most severe finding, independently corroborated by 4 of 5 review dimensions.
- `codex.json` advertised `capabilities.supportsSilentPrime: true`, but `syncEngineHooks()` clears
  hooks for any non-`claude` engine instead of writing them — not dead code, a live UI lie: an
  operator could enable "Silent Prime" for a Codex project and nothing would happen. Turned off;
  real support filed as backlog ENG-8V3N.
- Multi-file upload had no `FileReader.onerror` — a failed read hung the modal forever.
- CHANGELOG's `## [5.9.0]` "Master Session Recovery" `### Fixed` entry was fabricated (no such fix
  exists anywhere in history) — corrected via an `[Unreleased]` note, without touching the locked
  released section.
- Removed the dead live-wrap-progress SSE subsystem (zero consumers since #1005 removed its only
  client) and deduped shared-doc notify logic between two drifting implementations.

Cumulative Critic review (`rev-20260820T181429Z-411d7e43`): 0 blocking, 2 warning + 2 note, all
fixed and re-verified clean. Full suite: 6508 pass / 0 fail / 1 skipped.

One thing worth naming for the next reader of this repo's history: two of the fixes above exist
*because* re-checking a claim rather than trusting it surfaced something worse than reported — the
Codex "dead code" finding turned out to be a live capability lie, and a shipped commit's own
message ("Added Next Action preview") didn't match what the diff actually built (documented
honestly in `FEATURES.md` rather than propagated).

<!-- prawduct: type=bugfix | scope=master-level-takes-effect-968 | chunks=01,02 -->

The first real use of #755 found it: the toggle moved, the guard permitted the write, and the Master
refused anyway. It was refusing itself — the change path refreshed the guard and not the identity, so
the Master read `read-only` from month-old instructions and never attempted the write the guard was
waiting to allow.

Three things generalise:

- **"One call site is not the family" applies to ARTIFACTS, not just code sites.** #755 chunk 1 made
  the guard immediate and chunk 2 put the level into the identity; the change path refreshed one of
  the two, and every test in the suite read one of the artifacts that WAS being written. The fix was
  to delete the partial refresher rather than add a third write to it.
- **A detector that fires on the healthy path is worse than no detector.** The first shape of the
  staleness check compared the identity's mtime to the session start — and the identity was rewritten
  unconditionally on every ensure, which both surfaces fire on drawer open. It would have shown
  "restart to apply" permanently, which is the exact permanent nag the ruling behind it rejected.
  Caught by review, not by me. Write-if-changed; the mtime is load-bearing, so not touching it is
  part of the contract.
- **Verify a mechanism before offering it as an option.** The tmux session-start comparison was
  probed before it was put to the operator as a choice, and the probe found more than the bug: the
  live Master had been running a month against instructions rewritten the day before, so *nothing*
  regenerated in that month had reached it.

Also learned: `tmux display-message` does not fail on an absent session — it answers for the attached
client — so an exact-match target cannot protect it and the caller must check existence separately.
The codebase already documented this at one call site; the new one repeated the mistake. It cannot be
held behaviourally in a headless run (no attached client to fall back to), so a source-level guard
holds it, and the guard had to strip comments first because both callers explain the hazard in prose
directly above the check.

**Chunk 2 — Master Kill (also #768 chunk 3).** `POST /api/master/kill` plus the bar's Kill button,
which shipped dim from #768 waiting for this route. It is the remedy chunk 1 makes load-bearing: the
guard binds a level change at once, the running Master does not, so restarting it is what makes it
act. Killing an absent Master is SUCCESS — the operator's intent is "not running" and it already
holds — while a tmux that will not answer refuses, because a kill that could not be confirmed is not
a kill, and `hasSession` would have flattened that wedge into "already stopped" during exactly the
condition where the Master is most likely still running. `kill` leaving `tcMasterPendingReasons` is
the assertion that the pending treatment came off WITH the backend rather than beside it — the same
pattern `access` set in #755.

**Classification:** bugfix
