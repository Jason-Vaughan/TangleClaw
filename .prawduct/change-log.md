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

## 2026-10-27 — v5.40.0 W2-C Chunks 02-04: permission-request routes/UI, Discord-bridge decisions, TCC tmux bootstrap

<!-- prawduct: type=feature | scope=w2c-2352-2625 -->

- **#2352:** The permission-request record now has an HTTP surface and a session-page UI (`lib/routes/sessions.js`, `public/session.{js,html,css}`): a verified project launch can ask for a scoped permission, the Operator sees pending requests on the session page and can grant or refuse them (CSRF-checked write proof), and a verified Master relay carrying a Discord-bridge reply can decide one too — `decideFromBridge` refuses a reply that does not literally name the exact request id (zero free-form inference), refuses an author who is not the pinned operator, and enforces that one bridge reply decides at most one request. Every real decision fires a best-effort, one-time Medusa receipt notice to the requesting session's live workspace; a session with no live listener gets the same receipt on its next read instead.
- **#2625:** Added the mechanism for a TCC-protected launch to bootstrap its real tmux session onto a separate, already-authorized tmux server instead of hanging (`lib/tmux.js#createSessionWithTccBootstrap`, fully tested) — **not yet wired into the live launch path** (`lib/sessions.js:872` is outside this car's authorized file scope; tracked as a one-line follow-up, not a silent gap).

## 2026-10-27 — v5.40.0 W2-C Chunk 01: permission-request schema foundation

<!-- prawduct: type=internal | scope=w2c-2352-2625 -->

- **#2352:** Added the durable permission-request record and its fail-closed state machine (`lib/permission-requests.js`): additive `permission_requests`/`permission_request_events` tables (`ensurePermissionSchema`, idempotent, no edit to `lib/store.js`/`lib/store/_schema.js`), lazy expiry (`PERMISSION_REQUEST_EXPIRED`) and launch-supersession (`PERMISSION_LAUNCH_SUPERSEDED`) transitions, and the shared `decidePermissionRequest` grant/refuse primitive (idempotent replay, `PERMISSION_DECISION_CONFLICT` on a conflicting decision) that the dashboard and Discord-bridge trust boundaries call once each has proven who is deciding. No route or UI surface yet — this chunk is the storage foundation only; `test/permission-requests.test.js` covers it.

## 2026-10-27 — v5.40.0 W2-D: records-only Tests: anchor verifier (P1)

<!-- prawduct: type=internal | scope=v540-w2d-p1-features-index -->

- **#2632:** `scripts/verify-features-index.js` no longer refuses a `Tests:` anchor newly added to `FEATURES.md` solely because the cited test file lands outside a records-only diff. When the whole diff classifies as docs/records-only (`scripts/docs-records-only-diff.js`'s roster), the citation is proven instead by checking the file exists on disk at `HEAD` and contains a real test registration (`it(`/`test(`) — a lightweight on-disk check, not a test run. Any diff that also touches an executable or test file keeps the original strict "must be touched by this diff" requirement, byte-for-byte unchanged. `.github/workflows/test.yml`'s Records Gate already calls this script on every docs-only PR, so the fallback is live immediately, not dormant code (Critic caught an earlier draft of this entry claiming otherwise — corrected). Filed #2632 to give this LANE_QUEUE-dispatched chunk a citable issue — the PM dispatch's suggested fragment name (`p1-features-index-records-gate`) wasn't a valid issue number for `changelog.d/`'s grammar.

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

## 2026-10-25 — v5.38.0 W2-A: persistent Peek and panel focus

<!-- prawduct: type=fix | scope=w2a-2121-2092-2091 -->

- **#2121:** The dashboard Peek panel survives the 10-second project poll until explicitly toggled. A generation guard rejects an older response after the same project is closed and reopened.
- **#2092:** Edit group, Kill Tunnel, Web UI, SSH, Remove member/document, and +New Group controls preserve keyboard focus across the 30-second panel poll. Group details restore a displaced focus key only while the operator has not moved focus and that render is still current.
- **#2091:** The possible VoiceOver/NVDA re-announcement on each focus restore is documented and remains open for live screen-reader verification (VRF-007). No audio behavior was inferred from automated tests.

Exact-head PR #2611 (`868400f83d7cb87d6cb8c104d131a7356c503e62`, tree `40acc5d8b4fdb2b5f28655d5801ea451c9705e7f`) passed Tests run `40253602950`. CI-mode `scripts/record-test-run.js --base main` recorded 23,364 tests / 23,344 pass / 0 fail / 20 skipped, with Prawduct evidence current on the same tree. PRR-B issued final exact-head ACCEPT. The scoped three-file UI test command passed 128 / 0 / 0.

## 2026-10-25 — v5.38.0 W2-B: managed pre-push and isolated browser fixtures

<!-- prawduct: type=internal | scope=w2b-2596-2595-2600 -->

- **#2595:** Managed `pre-push` hooks now call the standalone Stage 1 + Stage 2 gate and block a failing push.
- **#2596 / #2604:** `scripts/with-scratch-server.js` starts a disposable server with both its database home and `projectsDir` isolated before config loads, then removes both temporary roots after the check.
- **#2600:** The remote-output callers test mocks `backupSqlite`, so its git-error path is stable in the full Small tier.

**A473-A3 scratch receipt on `main@95e141364cd56985625971a0ae0752f5ee823754` (exit 0):** With the merged `withScratchServer` helper, a temporary `a473-f10-fixture` project was created under the server-reported isolated `projectsDir`; dashboard `/` and `/session/a473-f10-fixture` returned HTTP 200 with the expected cards grid, engine picker, terminal frame and session script. The served UI scripts included launch-intent mint/consume and the shared Windows paste and Master Paste wiring. Both temporary roots were absent after the callback. This was an HTTP/DOM/wiring check: native right-click/new-tab behavior (W1-A F10) and Windows Ctrl+V/dictation and Master Paste interaction (W1-D VRF-006) were not exercised on this macOS host. Those live input checks remain owed at W4-REL/operator verification; see `.prawduct/operator-verification.md`.

## 2026-10-25 — v5.38.0 W2-C: dead exports Batch 3b

<!-- prawduct: type=internal | scope=w2c-2590-dead-exports-batch3b -->

- **#2590:** Retired 24 more unused public export keys across eight library modules while keeping internal declarations. The dead-export baseline shrank from 78 to 54. Batch 4 is tracked as #2607 for v5.39.0.

## 2026-10-25 — v5.38.0 W1-A: dashboard filters and Launch links

<!-- prawduct: type=fix | scope=w1a-2122-2123-2124 -->

- **#2122:** Tag and engine filters persist across reload; selections absent from the current projects are discarded.
- **#2123:** The toolbar displays the engine filter and tag picker inline and left aligned.
- **#2124:** Open and Launch controls are links with native new-tab actions. A new-tab Launch consumes a dashboard-minted, project-bound, five-minute, single-use intent token from the URL fragment; missing, mismatched, expired, or replayed intent does not launch. Plain-HTTP direct ingress uses `crypto.getRandomValues` when `crypto.randomUUID` is unavailable. The live F10 browser check remains owed in Wave 2 and W4-REL under A473-A3.

## 2026-10-25 — v5.38.0 W1-B: pre-push command and wave-diff test anchors

<!-- prawduct: type=internal | scope=w1b-2595-2597 -->

- **#2597:** CI-backed suite evidence support and `scripts/verify-features-index.js` check newly added `FEATURES.md` test citations against files touched since the wave's starting commit. The Integrator runs this check on each records PR.
- **#2595:** Standalone `scripts/pre-push-gate.js` chains Stage 1 and Stage 2. W2-B owns hook registration; the command does not yet block a push by itself. The cross-engine merge guard is tracked separately as #2601.

## 2026-10-25 — v5.38.0 W1-C: dead exports Batch 3a

<!-- prawduct: type=internal | scope=w1c-2590-dead-exports-batch3a -->

- **#2590:** Retired 61 unused `module.exports` keys across 14 library modules, retaining their declarations for internal callers. The dead-export baseline shrank from 139 to 78; Batch 3b remains assigned to W2-C.

## 2026-10-25 — v5.38.0 W1-D: Windows terminal paste and Master Paste

<!-- prawduct: type=fix | scope=w1d-2458-terminal-paste -->

- **#2458:** Windows Ctrl+V and dictation paste now reach xterm through the shared terminal frame wiring. The Master bar has a Paste button using the browser clipboard or a prompt fallback. Live browser verification VRF-006 remains owed in Wave 2 and W4-REL under A473-A3.
- **#2313:** Already implemented on the Wave 1 baseline; no new code change in W1-D.

## 2026-10-25 — W5-REL: prepare the v5.37.0 release

<!-- prawduct: type=chore | scope=w5-rel-v5.37.0-release-prep -->

v5.37.0 release cut, under `GRANT-V537-OVERNIGHT-CLOSEOUT-20261024`.

**Merging this pull request is the release.** `.github/workflows/release.yml` runs on the `version.json` change on `main`, tests the merge commit, tags `v5.37.0` on it and publishes the GitHub Release. Nobody tags by hand (`docs/release-process.md`; CLAUDE.md exception).

**What changed.**
- All 15 fragments under `changelog.d/` (3 added, 7 fixed, 2 security, 3 internal) compiled into `[Unreleased]` by `lib/changelog-fragments.js`, promoted to `## [5.37.0] - 2026-10-25`, and deleted in the same commit.
- `version.json` 5.36.0 → 5.37.0.
- `node scripts/release-prepare.js` moved the README clone pins and added the `[5.37.0]` line to the released-sections lock, additions only.

**Verification.** 26 tests pass across the five required test files: `readme-version-pins`, `changelog-released-immutable`, `changelog-fragments-repo`, `changelog-unreleased-size`, `features-index`. (`scripts/verify-records.js` referenced in dispatch does not exist in this revision — treated as absent.)

**Changelog:** none of its own; this pull request consumes the fragments.

## 2026-10-25 — v5.37.0 W4-A: unattended wrap auto-Leave + releaseMode:off override

<!-- prawduct: type=added | scope=w4a-2076-1497 -->

W4-A sprint, under `GRANT-V537-BATCH1-20261024` / PM A4. Architect guardrails A466-G1/G2/G3.

- **`#2076`** (added): `session-files` now auto-leaves dirty-at-launch foreign paths (no secret flag, no explicit decision) in unattended wraps (`keepSessionRunning:true` or `foreignPathDefault:'leave'`), writing decisions back to `context.options.pathDecisions` so `commit.js` stays consistent; `reviewSessionFiles:true` is an unconditional veto; secret-flagged and non-`dirty-at-launch` paths are unaffected.
- **`#1497`** (fixed): `version-bump` no longer silently ignores `bumpLevel` when `releaseMode` is off — bare `bumpLevel` skips with an explanatory note naming the ignored level; passing `release: "cut"` overrides the off state and cuts a release, with `releaseModeOverride: 'operator-supplied-release-cut'` in the output; `syncWrapReleaseControls` UI note updated to mention the API override path and handles legacy `versionBumpEnabled:false` projects.

## 2026-10-25 — v5.37.0 W4-B: dead exports Batch 2 (lib/bridge-* and lib/release-certification/*)

<!-- prawduct: type=internal | scope=w4b-2573-dead-exports-batch2 -->

W4-B sprint, under `GRANT-V537-BATCH1-20261024` / PM A4. Pre-approved Charter A446 (combined A-Gate + D4).

- **`#2573`** (internal): Retire 53 zero-consumer `module.exports` entries from 21 files across `lib/bridge-*` (30 exports, 10 files) and `lib/release-certification/*` (23 exports, 11 files), confirmed by the `#2498` D4 audit. Declarations remain in-file; only the export keys are removed. Dead-export baseline shrinks 192 → 139 (`test/dead-exports-baseline.json`). Batch 3+ tracked under `#2590`; `#1050` re-milestoned to `v5.38.0` per Architect A464.

## 2026-10-25 — v5.37.0 W3-B: tmux test reliability fixes (env-dump polling + server-exit retry)

<!-- prawduct: type=fix | scope=w3b-2565-2569 -->

W3-B sprint, under `GRANT-V537-BATCH1-20261024` / PM A4.

- **`#2565`** (fix): Replace fixed `sleep 0.5` with bounded polling (`waitForEnvDump`, 3 s deadline, 20 ms interval) in `createSession - launch env injection` tests so env-dump assertions are reliable on loaded CI runners.
- **`#2569`** (fix): Harden `createSession` against the exit-empty tmux server teardown race: per-test unique session names in `createSession - status bar`, and a one-retry settle (20 ms) in `lib/tmux.js` for "server exited unexpectedly" with dual `hasSession` guards (pre-sleep, post-sleep) preserving the idempotent return-false contract. Five PATH-shimmed tests cover retry-success, partial-create, post-sleep guard, retry-itself-fails, and nonmatching-error-rethrows paths.

## 2026-10-24 — v5.37.0 W2-B: held-wake badge + require-graph outer-span fix + CI upload-artifact pin

<!-- prawduct: type=feature | scope=w2b-2578-2566 -->

W2-B sprint, under `GRANT-V537-BATCH1-20261024` / PM A4.

- **`#2578`** (feature): Dashboard session cards now show an amber "⚠ input pending" or "⚠ pane not at rest" badge when Medusa wakeups are held because the pane has unsent prompt input (`pane-composer-has-input`) or the engine is busy/showing a dialog (`pane-not-at-rest`). `lib/projects.js` `_liveSession()` exposes `heldWakeReason` via `medusaWake.verdictFor()`; `public/landing.js` defines `renderHeldWakeBadge(project)` and wraps `renderCard` in `init()` after the first `await` so `public/ui.js` receives zero edits (A454 guardrail). `.badge-wake-hold` amber rule in `public/style.css`. `public/sw.js` cache bumped to `v3-63`.
- **`#2566`** (fix): `mask()` in `scripts/_require-graph.js` no longer adds false `require()` edges from text inside nested template literals. `skipTemplate()` unified via `code(true)` for both `keep=true` and `keep=false`; `blank(keep ? from : start, …)` ensures the full outer template body is blanked in default mode.
- **`#2371`** (internal/W2-CUT): `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9` (`v7.0.2`) pinned in `.github/workflows/test.yml` (`if: always()`, artifact `test-results`), completing the W2-CUT upload-step prerequisite for CI-as-suite-evidence.

## 2026-10-24 — v5.37.0 W2-A: SQLite backup before self-update + credential projection

<!-- prawduct: type=feature | scope=w2a-2577-2571 -->

- **`#2577`** (feature): `lib/update-applier.js` creates a verified `VACUUM INTO` SQLite backup (`~/.tangleclaw/backups/tangleclaw-pre-update-<version>-<timestamp>.db`) at step 4.5 before executing the git update. `PRAGMA integrity_check` is run on the backup; failure returns `reconcile-required` with `reason: backup-failed` (uses the existing reconcile path — `public/session.js` unchanged). Backup file mode set to `0o600`. Five new `_internal` seams (`getDbPath`, `vacuumDb`, `integrityCheck`, `readBackupFile`, `chmodBackupFile`) enable full test isolation. `dbBackup: { path, sha256 }` added to the success result payload.
- **`#2571`** (security): `lib/routes/openclaw.js` strips `gatewayToken`/`bridgeToken`/`auditSecret` from all CRUD responses and exposes `hasGatewayToken`/`hasBridgeToken`/`hasAuditSecret` booleans. `PUT` write-only normalization lives in the route (not the store): blank/omitted preserves, `null`/`clearX:true` clears. `POST .../tunnel` builds `webuiUrl` server-side and short-circuits localhost connections with `status:'local'`. `public/openclaw-view.js` uses `tunnel.webuiUrl`. `public/ui.js` edit modal shows placeholder instead of echoing the token; `saveConnection` omits blank tokens from `PUT` body. `lib/store.js` untouched. `test/openclaw-routes.test.js` registered in `test/tiers.json` and `.testament.toml` (commit `4d463818`, SUITE_SLOT granted to A — A-first merge order).

## 2026-10-24 — v5.37.0 W1-A: TCC probe + CI-as-suite-evidence operationalization

<!-- prawduct: type=feature | scope=w1a-2576-2371 -->

- **`#2576`** (bug fix): `lib/launch-kickoff.js` now probes the tmux server's macOS TCC read access before spawning panes on `~/Documents` projects. Runs `head -c 1` (or `ls`) via `tmux run-shell` before claiming the fire-once slot; returns `tcc-probe-blocked` early with a structured remediation log rather than spawning a silent broken lane. `lib/tcc-folders.js` gains `projectPathIsProtected` (path-segment-bounded check). Project path resolved from `projectId` via `_internal.getProject` seam — no change to `lib/sessions.js`.
- **`#2371`** (partial): `scripts/ci-evidence.js` output updated — "no rule in force" replaced with accurate A439-R5/v5.37.0 P1.1 description. Remaining items (workflow upload step, docs update, pilot chunk) recorded with owners; issue stays open.

## 2026-10-24 — W1-B: website security dep bumps and #1220 C05 inspection

<!-- prawduct: type=security | scope=w1b-2579-1220 -->

Security bump for `website/` (`next 16.4.3`, `sharp 0.35.5`, `dompurify 3.4.17`, `source-map-js 1.2.2`, `zod 4.6.7`) — resolves all 5 Dependabot vulnerability alerts. `actions/setup-node` bumped to `7.1.0` across all four CI workflows, superseding Dependabot PR `#2385`. `npm audit --prefix website` reports 0 vulnerabilities. Confirmed `#1220` C01–C04 fragment infrastructure complete with full test coverage; C05 (transition-exception removal) deferred to `#2523` pending `#2217` closing.

## 2026-10-24 — W5-REL follow-up: record v5.36.0 as live, with no pre-update backup

<!-- prawduct: type=docs | scope=w5-rel-v5.36-status-live -->

A records correction to `docs/releases/v5.36-status.md` on the Integrator's dispatch, under PM authorization, after the live install was updated. Docs only: the status page and this entry. TC-Lane-A changed nothing live.

- **Production updated: live, but no pre-update backup was kept.** The server log records `POST /api/update/apply` at 04:25:19.656 UTC, marked `via=operator`, applying `415eb03 → v5.36.0`. TC-Lane-A read the following at 04:36 to 04:38 UTC, read-only:
  - The live checkout is at `fcef8dfe`, detached, exactly the `v5.36.0` tag, with only `data/global-rules.md` changed.
  - `server-info` reads `startupSha` = `currentDiskSha` = `fcef8dfe`. `/api/health` answers `ok` 5.36.0, and `/api/system/health` reads all conditions clear.
  - The live store is at schema 68 and `quick_check` reads `ok`.
- **The backup.** The only v5.36.0 backup is the PM's post-update snapshot, `tangleclaw-v5.36.0-20261024T0435Z.db`, written 04:35:07 UTC. Its size, SHA-256, schema and `quick_check` were all re-measured. The page names it as post-update and says no pre-update backup exists; the newest older backup is v5.35.0's.
- **Feature activated: not proven, deferred to passive watch.** By PM ruling, the three owed live scenarios (#2547 candidate wake; #2555 residue release and wrapped-nudge clearing) are read at their next natural occurrence, never forced. TC-Lane-B's telemetry, relayed by the Integrator, saw no triggering event since the update. The page claims no live pass.
- **Rollback** says no pre-update restore point exists, and that rollback compatibility of the current live store was not tested. Schema 68 matching does not show v5.35.0's code reads what v5.36.0 wrote; the only rehearsal ran forward, so the Operator must assess before any rollback. Narrowed on the Integrator's finding.
- **Status, "Checks on the live install" and "What is left"** no longer say the release is undeployed. The page does not judge whether the update followed the deploy procedure.

## 2026-10-24 — W5-REL follow-up: #2544 closed in v5.36.0, #2573 carries the rest

<!-- prawduct: type=docs | scope=w5-rel-v5.36-status-2544-closed -->

A records correction to `docs/releases/v5.36-status.md`, under PM charter A17 (`657d89d3`) and Architect A442-R1, on the Integrator's dispatch. Docs only: the status page and this entry.

- PM A17 closed #2544 as completed in the v5.36.0 milestone, because its first removal batch (#2568) shipped in this release. The remaining exports moved to the new #2573, open in v5.37.0. The page had said the milestone held 25 closed issues and that #2544 stayed open in v5.37.0.
- "What it contains" now reads 26 issues, all closed. "Known issues that ship" lists #2573 in place of #2544.
- TC-Lane-A re-read every fact at 04:05 UTC before writing it, not from the dispatch: #2544 is CLOSED (completed, `release:v5.36`, milestone v5.36.0), #2573 is OPEN (`release:v5.37`, milestone v5.37.0), and milestone 21 reads 0 open and 26 closed.
- A first dispatch of this correction at 04:02 was held, because #2544 had been reopened at 04:01:20 by a conflicting ruling (Architect A442). The correction was built only after A442-R1 aligned with A17 and the live state matched.
- The finish lines are unchanged: code released Yes, production updated No, activation not proven.

## 2026-10-24 — W5-REL follow-up: record v5.36.0 as released

<!-- prawduct: type=docs | scope=w5-rel-v5.36-status-post-release -->

The post-publication status correction W5-REL's plan amendment 1 owed, on the Integrator's dispatch after `release.yml` published. Docs only: `docs/releases/v5.36-status.md` and this entry.

- **Code released: Yes.** #2570 merged as `fcef8dfe` at 03:24:50 UTC; `release.yml` run 40058196591 and `Tests` run 40058196531 concluded `success` on it; the annotated tag `v5.36.0` on origin peels to `fcef8dfe`; the GitHub Release is published, not a draft or pre-release, at 03:37:52 UTC. Each fact was read again by TC-Lane-A at 03:40 UTC, not copied from the dispatch.
- **Production updated: No.** No deploy is authorized; read-only, the live checkout is at `415eb036` (`v5.35.0`) and `/api/health` answers version `5.35.0`.
- **Feature activated: not proven**, since nothing of v5.36.0 is live.
- "What is left" now names only the Operator-authorized deploy and its reading.

## 2026-10-24 — W5-REL: prepare the v5.36.0 release

<!-- prawduct: type=chore | scope=w5-rel-v5.36.0-release-prep -->

v5.36.0 Wave 5 chunk W5-REL, under charter A13 `GRANT-V536-W5REL-20261023` as corrected by A14 (charter `4fa6925c`); plan rev 1 (`dfe7e337`) and amendment 1 (`9d46cb99`), approved by the Integrator.

**Merging this pull request is the release.** `.github/workflows/release.yml` runs on the `version.json` change on `main`, tests the merge commit, tags `v5.36.0` on it and publishes the GitHub Release. Nobody tags by hand (this repository's CLAUDE.md exception; `docs/release-process.md`).

**What changed.**
- The 9 fragments under `changelog.d/` (1 added, 5 fixed, 3 internal) were compiled into `[Unreleased]` by `lib/changelog-fragments.js`, promoted to `## [5.36.0] - 2026-10-23` by `version-bump`'s own promote function, and deleted in the same commit, the path v5.35.0's release took. The charter's first text named 8 fragments; `main` held 9, and A14 corrected it.
- `version.json` 5.35.0 → 5.36.0. There is no `package.json` in this repository.
- `node scripts/release-prepare.js` moved the README clone pins and added the `[5.36.0]` line to the released-sections lock, additions only.
- `docs/releases/v5.36-status.md`: the release's status before the merge, every finish line "No" with what each owes. A read-only upgrade rehearsal on a scratch copy of the live store (schema 68 before and after, 77 tables, row counts unchanged, `quick_check` ok, 0 foreign-key violations; scratch deleted).
- Release notes: 4,682 of 120,000 bytes (`scripts/release-notes-gate.js`).

**Parity.** `docs/tc-cli-reference.md` was already current and is unchanged. `FEATURES.md` lacked three shipped behaviours; the Integrator widened the lock for one clause each in the existing entries: `tc docs lock`/`unlock` in the shared-doc revision record, finalize's coordinator caller (#2556), and `scripts/record-test-run.js` in the CI-as-suite-evidence entry (#2521). #2547 fixes existing behaviour and needs no entry.

**Changelog:** none of its own; this pull request consumes the fragments.

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
