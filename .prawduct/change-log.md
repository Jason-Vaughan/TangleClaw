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

## 2026-10-06 — #1937: a held launch is not asked for what the gate refuses; the operator chooses the recovery mode

<!-- prawduct: type=bugfix | scope=1937-recovery-gate-salvage -->

Chunk 01 of the #1937 plan: the three pieces salvaged from PR #1986, which is to be closed in favour of this work.

- **What.** `lib/launch-sequence.js#taskStepWithheld` is the recovery gate's own answer, carried on the status block as `taskWithheld`. The unready nudge (`lib/launch-unready.js#nudgeLine`) and `tc start status` (`lib/tc-verbs.js#renderStartStatus`) read it. `GET /api/launch-sequences` adds `projectRecoveryMode`. `PATCH /api/projects/:name` is operator-only when the body names `launchSequence.recoveryMode`.
- **Not carried from #1986.** Its `ADVISORY_RECOVERY_HINT`, which told readers how to opt in to advisory mode, and every test assertion on that wording. The default recovery mode is about to change (operator ruling 2026-10-06), so the hint would have described an opt-in that is going away. Two tests now assert the opposite: the withheld nudge and status page do not mention advisory mode.
- **Unchanged.** The default mode, the gate's ordering, and what advisory mode does.
- **Tests.** Ported with the code: the gate's answer across operator, cleared and advisory launches; the nudge unit and end-to-end through the monitor; the status page with and without the field (an older server sends none); the GET before and after a setting change; the PATCH refusal for a session at a new value, at the current value, and beside another key, with the file unchanged each time.
- **Mutations.** Six, one per guard or call-site argument, each turned a test red: the PATCH branch disabled; the presence check weakened to a change-of-value check; `projectRecoveryMode` hard-coded; the monitor's `taskWithheld` argument forced false; the status page's condition removed; `taskStepWithheld` widened to advisory.

## 2026-10-04 — #1949: soak certification judge, successor to #2056

<!-- prawduct: type=feature | scope=1949-soak-judge -->

PM dispatch (Medusa 93e011e0), Architect ruling (011fef17) and corrections (6c0b466f). Supersedes #2056, whose code never landed.

**Why.** The v5.30.0 soak's evidence was evaluated by hand, and `rc-cert host-finalize` certified without reading the bundle. #2056's judge would have closed that gap but failed the soak that shipped: it treated every failed event as fatal, with no path for an Operator to review one.

**What.**
- `lib/soak/judge.js`: verdicts `pass`, `awaiting-review`, `fail`. Terminal reasons are never waived, and any fault event that is not `ok` is terminal. A failed or skipped load event and the driver's ownership-unverified state are reviewable. A disposition proposal (`tc.soak-disposition/v1`) is validated and bound by digest, and never changes the verdict.
- `lib/release-certification/state-machine.js#accept`, `scorecard.js`: the operator's acceptance binds the proposal's sha256 with the candidate and run, and the scorecard publishes it.
- `lib/release-certification/host-checks.js`, `host-publish.js`: the finalization is `ok` for a pass or for covered findings; `certifiedFrom` certifies covered findings only when the acceptance names that exact digest.
- `scripts/rc-cert.js`: `host-finalize --soak-bundle [--soak-disposition]`, `accept --soak-disposition-sha256`.
- `lib/soak/bundle.js`, `lib/soak/driver.js`, `scripts/soak.js`: carried over from #2056. The bundle records its candidate SHA, and a run writes `end` at its horizon.
- Docs: `deploy/soak/README.md` ("Judging the bundle"), ADR 0021 point 14, the bundle runbook.

**Not done, by ruling.** v5.30.0 is not re-judged. RM09's monitoring layer stays outside the repo (#2079).

## 2026-10-04 — Panel fold toggles keep keyboard focus (#1946)

<!-- prawduct: type=bugfix | scope=panel-toggle-focus-1946 -->

The PM dispatched this over Medusa after the v5.30.0 release (post-release PR cleanup, Lane D), and the Architect's overnight drain directive carried it to completion. It re-lands PR #1972 on a fresh branch off main, taken after #1902 merged because both touch `public/landing.js` and `test/inline-handler-args.test.js`. The old diff applied cleanly on top of #1902, and its three toggles already pass their keys through `jsArg`. It follows up #1906/#1915.

**Problem.** `togglePortGroup`, `toggleGroupItem` and `toggleOpenclawItem` flipped state and re-rendered the whole panel. `innerHTML` replaced the pressed button, so keyboard focus fell to `<body>`. The same happened every 30 s when the polling loaders (`loadPorts`, `loadGroups`, `loadOpenclawConnections`) re-rendered.

**The change** (`public/ui.js`, `public/landing.js`):
- `foldToggleInPlace(button, open)` flips `aria-expanded`, the arrow and the row's content (`.toggle-row` then its next sibling) with no re-render. Each toggle takes the pressed button (`onclick="…(key, this)"`) and falls back to the old re-render when there's no button or row. Opening a group in place still calls `loadGroupDetail`.
- `renderKeepingFoldFocus(container, render)` wraps the three polling renders: if focus was on a toggle inside the panel, it is returned to the new toggle with the same `data-fold-key` (added to each toggle). Focus elsewhere is never moved. The restore passes `preventScroll`, which #1972 did not: without it, an operator who focused a toggle and scrolled away would be pulled back on every poll. The Critic raised this as an observation and it was fixed before the first commit.
- The render functions themselves are unchanged apart from the new attribute and handler argument.

**Tests.** `test/panel-toggle-rows.test.js` runs the shipped functions against small fakes:
- each toggle folds in place and never re-renders;
- each still falls back to a re-render without a button;
- a group opened in place loads its details, and closing loads nothing;
- the rendered toggles carry `data-fold-key` and pass `this`;
- focus is restored after a re-render without scrolling the page, left alone when it wasn't on a toggle, and not stolen when the toggle is gone;
- all three loaders call the wrapper;
- each panel's real rendered HTML puts the content element immediately after the toggle row, which is the adjacency in-place folding relies on.

Against main's `ui.js` and `landing.js`, 15 of the file's 28 tests fail. Harness updates: `port-owner-kind-panel` lifts the new wrapper, because it runs `loadPorts`. `inline-handler-args` still asserts the exact name as the first argument and now also expects the button.

## 2026-10-04 — Release notes are measured before anything is tagged (#2080)

<!-- prawduct: type=bugfix | scope=2080-release-notes-gate -->

PM dispatch (Medusa 637106be) per an Architect ruling of 2026-10-04. Split out of #1951, which carried this gate together with the mkcert trust-anchor fix for governed hooks (#1947). The two halves share no code, and the trust-anchor change needs its own security review, so the gate lands alone and #1951 keeps the hooks work.

**Why.** v5.30.0's publish step failed with GitHub's `body is too long (maximum is 125000 characters)`: the promoted section was about 191,000 characters. `release.yml` pushes the tag before `gh release create`, so the tag existed with no Release until it was recovered by hand.

**What.**
- `scripts/release-notes-gate.js` and a `notes-gate` step between extraction and tagging, taken from #1951 unchanged apart from the issue it cites. It refuses empty notes and notes over 120,000 UTF-8 bytes, and never truncates (the Architect's earlier ruling on #1947). The tag step requires `steps.notes-gate.outcome == 'success'`.
- `test/changelog-unreleased-size.test.js` (new): the early warning from the closed #1959, rebuilt to promote `[Unreleased]` in a scratch copy and read it through `lib/changelog-notes.js`, so it is fence-aware and measures what the release would publish. It reads the ceiling from the gate and warns at 110,000 bytes.
- `docs/release-process.md`, `FEATURES.md`, `CHANGELOG.md`.

**After review of PR #2085 (the Architect and Pilot-B1, independently).**
- The size test counted the extractor's return value, one byte short of the file the workflow publishes, because the extractor command appends a newline. It now runs that command and counts the file it writes; 110,000 passes and 110,001 fails. The same file is also run through the gate CLI at the 120,000 boundary.
- The recovery steps named a regeneration command from a test message that does not fire in this state, and that command rebuilds the whole lock. They now say to delete the one version's lock line and run `scripts/release-prepare.js`, which re-adds only that line and refuses other drift. Tried in a scratch copy on the real 5.30.0 section. A tag already on origin with oversized notes is called out as an Operator escalation.

**Tests.** `test/release-notes-gate.test.js` (boundary-1, boundary, boundary+1, multibyte, empty, CLI exits), `test/release-workflow.test.js` (step order, the tag step's condition, nothing overrides a refusal) and the new size test. Mutation-checked: main's `release.yml` fails 3 of the new workflow pins, and a padded `[Unreleased]` fails the size test. The gate run on the real v5.30.0 notes refuses them at 191,040 bytes.

## 2026-10-04 — The Codex receipt test follows its read-back, not 20/80 ms timers (#1964)

<!-- prawduct: type=bugfix | scope=codex-receipt-test-1964 -->

The PM dispatched this over Medusa after the v5.30.0 release (post-release PR cleanup, Lane C). It re-lands the fix from PR #1969 on a fresh branch off current main, because that branch had fallen dozens of merges behind; the test file had since changed under #1955 and #1978, so the fix was re-applied by hand rather than cherry-picked.

**Problem.** `test/startup-control-codex.test.js`, *accepted on the echoed clientId + bytes notification…*: the fake app-server sent `turn/started` and `item/completed` on a 20 ms timer, and the completion on an 80 ms one. On a slow runner both fired before the adapter's post-subscribe read-back, the fire settled, and the read-back was skipped, so `one read-back` saw 0.

**The change.** Test-only. The notifications are sent from the fake server's `request` event, which fires after the answer is written, on the first `thread/turns/list` after `turn/start`. That read answers with the turn still in progress and nothing echoed, so the read-back always runs first and acceptance can only come from the notification. Socket order carries `item/completed` ahead of `turn/completed`. Every assertion is unchanged. Unlike #1969, it sequences only on a read-back after `turn/start`, so a list call made before the turn exists cannot fire the notifications with no turn to report.

**Evidence.** With the old timers set to 0 and 1 ms, the test failed 6 runs in 10 on `one read-back` (0 !== 1), matching CI. The new shape passed 30 of 30 under 8 CPU-bound loads. File: 54 of 54.

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
