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

## 2026-10-27 — v5.40.0 W2-B: session candidate-status read, and the #2133 duplicate closed

<!-- prawduct: type=added | scope=w2b-2133-2214 -->

- **#2214:** A session can now read what became of a candidate it submitted to the Project
  Master — `tc candidate status [<candidate-id>]` and `GET /api/bridge/session/candidates[/:candidateId]`
  — separating waiting, approved (ready/blocked), posted (with the Discord message id and
  parts), and discarded (rejected, withdrawn, expired, or merged with the survivor's own
  outcome). New `lib/bridge-candidates.js`, mounted in `server.js` right after the
  `bridgeApi.ROUTES` loop; reads `bridge_candidates`/`bridge_outbound`/`bridge_outbound_parts`/`bridge_audit`
  directly, with zero changes to `lib/bridge-api.js` or `lib/bridge-store.js` (A475-W2-PACK).
- **#2133:** Closed as a duplicate, not rebuilt — the wake-Master-on-submission behavior it
  asked for already shipped under #2547 (commit `8343e1c5`, `_tellMasterOfCandidates()` in
  `lib/bridge-gateway.js`'s tick pass). Verified end to end alongside #2214 in
  `test/bridge-candidates.test.js` (Architect Ruling A475-W2B-R2: no second, parallel notify
  mechanism was built, so the one source of truth can never double-notify or race).

## 2026-10-27 — v5.40.0 W1-A: operator-needed alert context and Gateway resume docs

<!-- prawduct: type=changed | scope=v540-w1a-2141-2334 -->

- **#2141:** `operator-needed` Discord alerts now name the sender, priority, age and exchange id instead of a bare recipient-only sentence, and are suppressed for an opted-out recipient or one whose `coordinatorProject` has a live session — the same opt-out and coordinator-first suppression `work-blocked` already had (#2620). A `work-unblocked` recovery notice is now raised once its block notice is actually `delivered` to Discord — never while that notice is still queued, set aside, or was let go uncollected or withdrawn, and never when a newer block has already superseded the clearing (Architect Ruling A475-W1A-R1: it rides under `work-blocked`'s own admitted `notify_type` and retention in `bridge_outbound`, so no schema migration was needed).
- **#2334:** Documented the Discord helper's periodic Gateway resume (`gateway-connecting` to `gateway-resumed` in about a quarter second, no `gateway-closed` line, no event lost) as Discord's own documented op 7 Reconnect, not an outage or a defect.

## 2026-10-27 — v5.40.0 W1-D: Master Medusa reply deadlocks

<!-- prawduct: type=fixed | scope=w1d-1988-2176 -->

- **#1988:** `exchangeCaller()` had no branch for a verified Master launch, so
  every Master caller fell through to `unbound` on the send route and a
  reply carrying `inReplyTo` was refused before `REPLY_TARGET_UNKNOWN` was
  even reached. The Master's verified launch now binds a reply, narrowly
  (not folded into `boundSender`, so it gains no `blocking`/`critical`
  priority).
- **#2176:** The wake nudge told a read-only Project Master to POST a reply
  its own access level refuses (403 `ACCESS_LEVEL`). It now reads the
  Master's current access level per nudge and, when read-only, tells it to
  describe the needed reply for the operator instead — per Charter A475
  line 41's ruling not to widen the Master's outbound authority as a side
  effect of the wording fix.

## 2026-10-27 — v5.40.0 W1-B: update rebase-onto-tag and Medusa Bridge fail-closed

<!-- prawduct: type=feature | scope=v540-w1b-2399-2354 -->

- **#2399:** The in-app update now rebases a checkout's local commits onto the latest release tag instead of refusing outright, when the branch's fork point from `main` is reachable from that tag. A rebase conflict aborts cleanly and refuses with the conflicted files named; every other branch shape keeps the existing `wrong-ref` refusal.
- **#2354:** An explicit `MEDUSA_BRIDGE_WS_URL` that the resolver refuses (unparseable, wrong scheme, a fragment, a non-loopback host) now fails closed — no session listener starts, and its status names the refused value and reason — instead of silently falling back to the default Bridge. A derived or unset WS URL is unaffected.

Dispatch (mx_4d00fbbd / PM) named `lib/updater.js`, `routes/update.js`, `test/updater.test.js`, `test/medusa.test.js`; none exist in this repo. Corrected scope confirmed by PM (mx_0M9uk1K0QYRtpeWD): `lib/update-applier.js`, `lib/medusa.js`, `test/update-applier.test.js`, `test/api-medusa.test.js`. Critic also required touching `lib/medusa-listener.js` (new `WS_URL_REFUSED` code), `public/api-helper.js` and `public/update-beacon.js` (surfacing the new codes to the operator), `public/session.js` and two docs (`docs/configuration-reference.md`, `docs/adr/0010-one-update-mechanism.md`) to keep existing contract tests and documentation accurate.

## 2026-10-27 — v5.40.0 W1-C: Master shared-doc notices and stale-coalescing fix

<!-- prawduct: type=feature | scope=v540-w1c-2350-1084 -->

- **#1084:** The Project Master now receives shared-doc change notices when it is listening and its configured scope covers the doc's group — best-effort, coalesced the same way a project session's notice is.
- **#2350:** Coalescing an un-handled notice no longer hides a reader going silent forever: past a 10-minute staleness bound the next write sends anyway instead of coalescing, and a warning names the doc and session so the gap is visible before it reaches hours.

## 2026-10-26 — v5.39.0 W1-B: CI evidence and mandatory fragments

<!-- prawduct: type=internal | scope=v539-w1b-2371-1220 -->

- **#2371:** The lane host now declares the suite-evidence wrapper as its test command. The Tests workflow uses a short Records Gate for docs, records, and release-metadata-only PRs, while code diffs still run the full suite. The directory-scanner fixture's child process now exits on IPC disconnect.
- **#1220:** Code PRs must add a `changelog.d/` fragment or state `Changelog: none <reason>`; CI enforces the rule after the pre-boundary PRs, including #2523, closed.

PR #2619 merged at exact reviewed head `02eefa96` as `8091fce1`.

## 2026-10-26 — v5.39.0 W1-C: dead exports and status counts

<!-- prawduct: type=internal | scope=v539-w1c-2607-747 -->

- **#2607:** Removed 51 unused public exports, leaving three documented audit exceptions in `test/dead-exports-baseline.json`.
- **#747:** `refreshStatusBars` now counts its skip reasons at their outcome sites and returns the breakdown; two source-shape tests now run the lifted functions.

PR #2618 merged at exact reviewed head `6030e503` as `c237ede6`.

## 2026-10-26 — v5.39.0 W1-INT: live wrap verification

<!-- prawduct: type=internal | scope=v539-w1int-2588 -->

- **#2588:** An isolated scratch-server and headless Chromium run exercised the real session wrap UI: the review checkbox produced a `needs-operator` pause before commit, Keep local and Retry sent `pathDecisions[path] = 'leave'`, and the second run completed without another pause or commit. The file remained local and the issue closed after the live receipt.

## 2026-10-26 — v5.39.0 W2-B: Master controls, paste evidence, and coordinator alerts

<!-- prawduct: type=fix | scope=v539-w2b-2035-192-2620 -->

- **#2035:** Full screen and Pop out are available for Project Master in both the dashboard panel and session drawer through one shared control bar.
- **#192:** Raw-mode tmux PTY and browser-side `term.paste()` regression tests pin multi-line Master paste framing and byte-for-byte payload delivery; no production paste change was required.
- **#2620:** Direct Discord work-blocked alerts are suppressed for an opted-out project or a sub-lane with a live coordinator, leaving escalation to that coordinator.

PR #2621 merged at exact reviewed head `46f88c626b0a57bf40256710bceb2063fbdbe324` as `7158607180c4c442adb569c568ddb14db8e365af`. Exact-head Tests run `40400670019` succeeded; the CI-mode recorder reported 23,452 JUnit leaves and 0 failures. PRR-A and Architect A474-W2B accepted the exact head.

## 2026-10-26 — v5.39.0 W2-C: session controls and terminal recovery

<!-- prawduct: type=fix | scope=v539-w2c-1317-960-1237-1638-2011 -->

- **#1317:** The wrapping status dot now uses the dashboard's spinning pinwheel.
- **#960:** Removed the session banner Select button, its mouse-mode flip, and abandoned-mode recovery; ordinary selection and the touch long-press Copy pill remain.
- **#1237:** A rejected mouse-mode Settings save restores the prior state and surfaces its failure.
- **#1638:** Touch terminals have an Esc, Ctrl, Tab, and arrow keybar; sticky Ctrl applies to the next keystroke without replacing ttyd's xterm handler.
- **#2011:** The terminal reattaches after a session restart and recovers from a positively detected ttyd disconnect with bounded retries. An unreadable frame alone does not trigger a retry.

PR #2622 merged at exact reviewed head `89dab7661d7a0c521420f5ed921ee930e4e48cb2` (tree `4702ce2a12009942ae8d71c4d54e4089e9e25ea1`) as `29ec322d7599eeeb0b5789492e8b2e8971ad40f5`. Exact-head Tests run `40416661372` succeeded; the CI-mode recorder reported 23,493 runner tests / 23,488 JUnit leaves, 0 failures, and matching Prawduct evidence tree. PRR-B Rule #286/#81 and Architect A474-W2C-ACCEPT-R3 accepted the exact head. All five linked issues closed on merge.

## 2026-10-25 — v5.38.0 W3-A: create setup, shared lease-ignore, and project path health

<!-- prawduct: type=fix | scope=w3a-1304-1382-2401 -->

- **#1304:** Creating a project opens Settings before the first session launches. Save & Launch starts with the chosen settings; Save and Cancel keep the project without launching.
- **#1382:** Port-import Ignore choices persist in server config instead of per-browser localStorage, so they carry across devices.
- **#2401:** Unarchive refuses a missing or empty seeded project path until the operator confirms a fresh start. Launch carries an advisory path-health warning to the session view so it remains visible after navigation; launch itself is not refused.

PR #2615 merged as `d3eee9b749eb5f0dc2d4964ed0dd8af2d1e8eebc` from exact head `57acccba3c305a55de3f37a924874ef1bd726a01` (tree `f20ecc5614255e7e40a402e6736e40e409c73a35`) after PRR-A final ACCEPT. Exact-head Tests run `40272409168` and latest-main Tests run `40258598329` succeeded. The CI-mode recorder accepted that head and tree with 23,400 runner tests, 0 failures, and valid Prawduct evidence; A473-A8 co-signed the final 22-file scope, including the session-view warning handoff.

## 2026-10-25 — v5.38.0 W3-B: needs-operator wrap verification

<!-- prawduct: type=internal | scope=w3b-2588-wrap-needs-operator -->

- **#2588:** Added `test/wrap-needs-operator-live.test.js` against an isolated server and real wrap pipeline. It verifies the pre-commit `needs-operator` pause, the owned file on `manifest.commit`, and a Keep-local Retry that moves the file to `manifest.keepLocal` without a second pause or commit. A VM-mounted test runs the real drawer-row renderer and `retryWrap` accessor/POST with a lightweight DOM. The required manual live-session browser click and visual check remain open under #2588.

PR #2613 merged at exact head `cce1034d6484fc40dd63d40723fdc52b96f1b1da` (tree `b40eb9c2388abed0118861585cd8731f308194d0`) after PRR-B final ACCEPT and Tests run `40257249671` SUCCESS. The CI-mode recorder reported 23,367 tests, 0 failures, and tree-valid Prawduct evidence; A473-A6 co-signed the five-file scope. `test/_mini-dom.js` gained the checkbox, selector, and text-node support used by the new UI test.

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
