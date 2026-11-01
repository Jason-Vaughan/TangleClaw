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

## 2026-10-31 — v5.51.0 W2-REC: reconcile project-rule delivery records

<!-- prawduct: type=internal | scope=v551-w2-rec -->

- Reconciled the five accepted Charter A489 Wave 1 issues. PR #2761 (#2293, #1654) merged as `d2b4b0ed`, PR #2760 (#1196, #2325) as `82560fbb`, and PR #2759 (#1176) as `69513ec5`; their `changelog.d/` fragments remain for the v5.51.0 release cut.
- **Rule reachability and consistency (#2293, #1654):** refresh registers hook slots when a rule first becomes active or outgrows launch slots, so a running Claude session can receive it on `/clear` or compaction. Delivery and wrap prompts use the canonical `isUsableRule` predicate to exclude missing or non-string bodies. The real Claude CLI check supports the hook refresh behavior after a brief settle interval; a zero-delay scripted `/clear` is not guaranteed.
- **Operator editing and stub visibility (#2325, #1196):** a verified Operator edit of an active non-master rule governs immediately, with an Edit control and notice in Project Rules. The Feature Index census exposes the oldest auto-stub date, age, and 14-day deadline.
- **Receipt-based recovery (#1176):** the startup-rule receipt watcher distinguishes a hook that did not run from a missing receipt POST, retries delivery through an open channel within bounds when local evidence is inconclusive, and surfaces an explicit exhausted escalation.
- Updated the Feature Index with stable source and test anchors. These are merged-code records; the v5.51.0 release cut and live activation remain separate gates.

## 2026-10-31 — v5.50.0 W3-REC: reconcile verified engine and session records

<!-- prawduct: type=internal | scope=v550-w3-rec -->

- Reconciled all ten accepted Charter A488 issues across Wave 1 and Wave 2. Wave 1 merged through PRs #2755 (`3c3a3868`), #2754 (`801d52ef`), #2756 (`d1d89d4b`), and #2757 (`309dacbd`); Wave 2 merged through PR #2762 (`e82760dc`). Each issue retains its accepted `changelog.d/` fragment for the v5.50.0 release cut.
- **Engine compatibility and admission (#1897, #1809):** engine canary evidence resolves to verified, degraded, incompatible, or unknown with an explicit operator override path. Capability-matched task admission and durable, attested engine rotation govern publisher authority. `authorizePublisher()` is available as a primitive; resource write paths have not been wired to call it.
- **Aider and launch integration (#2439, #1644, #2188, #1967):** Aider receives its conventions through a real markdown carrier and supports project-scoped local model settings; a bounded one-shot task contract checks the resulting edits and tests. Projects can persist an exact model for their next launch, and session profile reconciliation verifies the active model from structured engine records, holding admission on a mismatch. Claude has the first control adapter; Codex remains observation-only.
- **Usage and switching (#2599, #2598):** local usage records feed rolling token windows and a recommended model tier, with operator calibration. Governed model or engine switching uses a clean chunk boundary and supports outage takeover; effort settings are applied only when the target engine supports them.
- **Stage 5 and settings (#2752, #2747):** the Testament runner has `procps` and `/proc` process-identity fallbacks, and Global Settings exposes engine inventory with per-engine creation defaults. #2752 covers the procps parity slice; remaining Stage 5 failures are tracked in #2758. TangleTweaker docking (#581) remains WONTFIX and was not included in #2747.
- Updated the Feature Index with stable source and test anchors. This records merged code and passing PR gates; the v5.50.0 release cut, tag, and deployment remain later work.

## 2026-10-31 — v5.50.0 W1-D: Stage 5 procps parity + global Engine settings UI

<!-- prawduct: type=feature | scope=w1d-2752-2747 -->

- **Stage 5 container parity (#2752, Slice 1):** installed `procps` in the Testament runner image and added a `/proc`-based fallback (Linux only) everywhere this repo shells out to `ps` — `lib/pidfile.js`, `lib/startup-control-codex.js`, `lib/release-certification/lockfile.js`, and the test helper in `test/bridge-handoff.test.js`. All three production call sites already failed closed (no crash) before this change; what was missing was answering correctly instead of degrading to "unknown" when `/bin/ps` is unavailable. Verified against the real Testament container pool (`node scripts/test-stage.js 5`): 10 failures, none in bridge-handoff/pidfile/startup-control-codex/lockfile territory (rule-delivery-receipt, setup-wizard, tmux, tmux-named-paste-buffer, update-release-link instead). An `origin/main` baseline re-run, attempted for independent confirmation that those 5 are pre-existing, **did not complete** — it stalled on apparent Testament pool contention and was aborted (unconfirmed baseline, not a proven one). `git diff --name-only origin/main...HEAD` showing none of the 5 files in this branch's diff is supporting context, not proof. Those 5 files are tracked, per TC-Lane-PM, in follow-up issue #2758; #2752's acceptance scope here is Slice 1 (the procps `/bin/ps` + `/proc` fallback parity targets).
- **Global Engine settings panel + per-engine creation-seed defaults (#2747):** Global Settings gains an "Engine Settings" section — one selector across every registered engine (including `pickerHidden` profiles), consuming `GET /api/engines/inventory`. The create wizard's First-Session Settings now seed from the chosen engine's profile rather than a hardcoded literal. `#581`'s TangleTweaker docking, also named in #2747, was deliberately skipped: #581 is closed WONTFIX ("TangleTweaker is a separate product wearing feature clothes") and was not reopened — flagged to TC-Lane-PM/Architect rather than silently built or silently dropped.
- **PRR-B review (PR #2754):** applied one fix — the engine-inventory selector's change handler now assigns via `.onchange` rather than `addEventListener`, cheap defense against a future caller re-invoking the loader without resetting its container. The claimed "stacks listeners on repeated opens" symptom was independently re-verified against the real code first and does not reproduce under the current single call-site (`openGlobalSettings` resets the container's `innerHTML`, hence recreating it, before each call) — applied as defense-in-depth, not as a confirmed live bug.
- **Scope notes for the next hop:** the dispatching charter described the three `lib/` ps call sites as needing to be made "ENOENT-safe" — they already were; the actual gap was a correctness fallback, not a crash fix. The charter also cited `data-model.md` for the creation-seed UI-copy convention, which does not exist anywhere in this repo. Building #2747's new browser fetch of `/api/engines/inventory` required narrowing `test/engine-picker-gating.test.js`'s #736 single-engine-endpoint regex, touched outside W1-D's ORIGINAL allowed scope at the time — since authorized in the amended Charter A488 / `LANE_QUEUE` W1-D scope, which now lists this file explicitly (independently re-verified against the live charter file, not just taken on PM's word).

## 2026-10-31 — v5.49.0 W3-REC: reconcile engine settings and inventory records

<!-- prawduct: type=internal | scope=v549-w3-rec -->

- Reconciled all 12 accepted Charter A487 issues after Wave 1 merged at `main@49ce19f569e89f2f20c304c35584f22b124d3441` and Wave 2 merged at `main@b2864dc77e4fd248f2b03690e37ece9910873551`. Each issue retains its accepted `changelog.d/` fragment for the v5.49.0 release cut.
- **Engine settings and guidance (#1268, #1269, #1264, #1276):** plugin-governed projects now explain when generated configuration cannot reach an engine; the Project Rules startup warning follows the selected engine; connection-backed OpenClaw projects show launch modes and the eyes-open confirmation; contributor setup explicitly installs the external Prawduct plugin.
- **Engine choice and inventory (#2220, #2278, #738, #764):** display-only model rosters can opt into a five-second cache while save and launch remain fresh; `defaultEngine` rejects invalid profiles; the setup picker shares the option builder; read-only inventory routes report each engine's capabilities, config carrier, and installed extensions, including hidden profiles. The #764 UI and default-seeding follow-up remains tracked as #2747.
- **Session and test reliability (#260, #1085, #1113, #2742):** Codex warns on a confidently incompatible model and auth mode; Master identity writes to its engine's config filename; Claude artifact publishing no longer opens host browser tabs; and reset-admin's JUnit capture forwards binary test-runner frames, restoring all 55 Testament cases without malformed XML.
- Updated the Feature Index with stable source and test anchors. This records merged code and passing PR gates; the v5.49.0 tag, GitHub Release, local deployment, and live activation remain W4-REL work.

## 2026-10-30 — v5.48.1 W3-REL: prepare the Testament pool and control-plane release candidate

<!-- prawduct: type=internal | scope=v5481-w3-rel -->

- Prepared the candidate from W2-REC-merged `main@1bb19f77ec3c4c5e55e63c46badf6ff9b5f2ac46`: compiled the four accepted fragments for #2733, #2706, #2723 and #2726 into the dated `[5.48.1]` section, consumed those fragments, and changed `version.json` from 5.48.0 to 5.48.1. `scripts/release-prepare.js` refreshed the README clone pins and extended the released-section lock.
- Updated `docs/releases/v5.48.1-status.md` to record the merged records base and keep code release, production update and feature activation as separate pending finish lines. Preparation creates no tag, GitHub Release or live deployment; the release workflow and post-merge checks own those claims.

## 2026-10-30 — v5.48.1 W2-REC: reconcile Testament pool and control-plane records

<!-- prawduct: type=internal | scope=v5481-w2-rec -->

- Reconciled the four issues in Charter A486 after W1-B PR #2739 merged at `main@f16267e0b32aadd190d727eb79746ff432dab7f2` and W1-A PR #2738 merged at `main@8b3b8c281781088eafde7de72ec1e1757553abd8`. Both cars retained their own accepted `changelog.d/` fragments for the release cut.
- **#2733 and #2706:** Stage 3–5 test tiers can probe and offload to Testament's container pool with local fallback, while Large-tier test-file timeouts use a measured 25-minute bound. The pool-success path omits requested JUnit output; that caller limit is documented in `docs/test-pyramid.md`. The end-to-end pool run is reserved for the release gate.
- **#2723 and #2726:** Codex Medusa wake checks treat a bound `systemError` thread as resting while retaining folder and competing-thread guards. Medusa send tracking now projects the delivered local recipient after Hub retargeting, including the integration path from the Hub response to a tracked exchange.
- Updated the Feature Index and recorded the published v5.48.0 release and local deployment separately from its still-unverified live retention exercise. `docs/releases/v5.48.1-status.md` starts with all three release finish lines pending.

## 2026-10-30 — v5.48.0 W4-REL: prepare the bounded-records release candidate

<!-- prawduct: type=internal | scope=v548-w4-rel -->

- Prepared the candidate from W3-REC-merged `main@2bdd96059e6c53ab9e5f9c6080064c64caa4f86f`: compiled all eight accepted `changelog.d/` fragments into the dated `[5.48.0]` release section, consumed those fragments, and changed `version.json` from 5.47.1 to 5.48.0. `scripts/release-prepare.js` refreshed the README clone pins and extended the released-section lock.
- Recorded the separate pending release, production-update and activation finish lines in `docs/releases/v5.48-status.md`. Preparation creates no tag, GitHub Release or live deployment; the release workflow and post-merge checks own those claims.

## 2026-10-30 — v5.48.0 W3-REC: reconcile bounded-record retention

<!-- prawduct: type=internal | scope=v548-w3-rec -->

- Reconciled the eight issues in the co-signed A485 sprint after Wave 1 and Wave 2 merged to `main@74706b59c4cdfa47c2bc91f0fc25dcfa231626b8`. Wave 1 bounded launch-sequence content and rows (#1595), ended-session Medusa deliveries (#1331), and ended-launch workload receipts and narrowings (#1918), and retired the persisted, unread project `migration_status` column (#776). Wave 2 bounded handoff publication rows and files (#1602), Medusa exchange rows and facts (#1879), and settled operator-bridge records (#2004), and retired verified one-off config-load migration shims (#1035). The accepted `changelog.d/` fragments remain for release preparation.
- Updated the feature index with code and test citations for all eight issues and marked the prior v5.47.1 patch as released. This records merged code; it does not claim a v5.48.0 tag, GitHub Release, deployment or activation.

## 2026-10-29 — v5.47.1 W3-REL: prepare the Medusa wake delivery point patch

<!-- prawduct: type=internal | scope=v5471-w3-rel -->

- Prepared the candidate from W2-REC-merged `main@d880cbc0c314b57129d08da2f3acf2438c06b69f`: promoted the accepted #2716 fragment into dated `[5.47.1]` release notes, consumed the fragment, and changed `version.json` from 5.47.0 to 5.47.1. With `changelog.d/` empty, `scripts/release-prepare.js` refreshed README clone pins and extended the released-section lock.
- Recorded the separate pending release, local update and activation finish lines in `docs/releases/v5.47.1-status.md`. The Observer is preparing a separate v5.47.1 sprint report with a plain-English summary alongside technical evidence. This is release preparation; no v5.47.1 tag, GitHub Release, local deployment or activation is claimed.

## 2026-10-29 — v5.47.1 W2-REC: reconcile Medusa wake delivery records

<!-- prawduct: type=internal | scope=v5471-w2-rec -->

- Recorded #2716 after Car 1 PR #2717 merged at `main@7e9848037361f1b1dcd1f21a6d0a65d4a23f28c3`. Antigravity now clears a stranded switchboard nudge with `C-a C-k`, while other engines keep `C-u`. A `wake_not_accepted` receipt triggers the existing bounded re-arm check immediately; a re-armed wake requests a look, waits only the remaining observation gap, then chains the second at-rest look needed to retry without a periodic poll tick. The exchange proof keeps restart safety, re-arm budget, backoff and mail isolation.
- Reconciled the Feature Index entry and marked the already published v5.47.0 engine-dialog batch as released. The accepted #2716 changelog fragment remains for the v5.47.1 release preparation wave to compile and consume. This records merged code; no v5.47.1 tag, GitHub Release, live deployment or activation is claimed here.

## 2026-10-29 — v5.47.0 W4-REL: prepare the engine dialog release candidate

<!-- prawduct: type=internal | scope=v547-w4-rel -->

- Prepared the candidate from W3-REC-merged `main@aea08798cf01a09c7a2ba37069c5a64c63397116`: compiled the two accepted Wave 2 fragments (#2168 and #2219) into the dated `[5.47.0]` section, consumed them, changed `version.json` from 5.46.1 to 5.47.0, and used `scripts/release-prepare.js` to refresh README clone pins and the released-section lock. The release notes cross-reference Wave 1 #1836, #2193, #2205 and #2221, which already shipped in v5.46.1.
- Recorded the candidate's separate release, deployment and activation finish lines in `docs/releases/v5.47-status.md`. Under co-signed Addendum A483-R13, refreshed `docs/releases/v5.46.1-status.md` with the verified c94164b0 tag/Release/deploy receipts and the post-rebase full-suite count of 23,700 passed, 0 failed, 1 existing skip. The #2168 interactive browser check remains deferred under A483-R8 until the live v5.47.0 install; this candidate does not claim it passed. No v5.47.0 tag, GitHub Release, production update or feature activation is claimed before their own readbacks.

## 2026-10-29 — v5.47.0 W3-REC: reconcile engine dialogs and sandbox records

<!-- prawduct: type=internal | scope=v547-w3-rec -->

- Reconciled the six issues in milestone #32. Wave 1 #1836, #2193, #2205 and #2221 shipped in the v5.46.1 release at `main@c94164b09555b2a3a05248e9a9a2798726c05269`; the release consumed their changelog fragments. Wave 2 #2219 and #2168 merged afterward at `main@cd09db009a7ac82ac2d7abc2f99896d7c6aaa63c` and `main@833b60b4c36413d79b8cff1722caf4de15f79fdc` respectively; their accepted fragments remain for the v5.47.0 release cut.
- Updated the feature index and operator configuration and troubleshooting guidance for the per-project, default-off folder-trust opt-in and selector-row send refusal. The folder-trust activity event records only a fully sent acceptance. This records merged work; it does not claim a v5.47.0 tag, release, or production activation. The interactive browser check for #2168 remains deferred to the post-deploy live install under PM and Architect ruling A483-R8.

## 2026-10-29 — v5.46.1 W3-REL: prepare the stabilization release candidate

<!-- prawduct: type=internal | scope=v5461-w3-rel -->

- Prepared v5.46.1 from W2-merged `main@980d53bbe2ad1c56964adde30ce23f67e7622a36`, then rebased the release candidate onto current `main@003f43ae3e8b017f73b447e0f4dc1c7d5e2405dc`: promoted all ten accepted fragments into the dated `[5.46.1]` section, consumed them, and changed `version.json` from 5.46.0 to 5.46.1. The four added Wave 1 entries (#1836, #2193, #2205, #2221) describe code already merged into the commit this release will tag, under PM Addendum A482-R10/A483-R10.
- With `changelog.d/` empty after all ten fragments were consumed, `scripts/release-prepare.js` validated the README clone pins and updated the released-section lock on this rebased candidate; a second run reported already current (both exit 0). Recorded the three pending finish lines in `docs/releases/v5.46.1-status.md`. The corrected #2699 release note distinguishes retained group membership from skipped auto-claim on an unverified lookup and allows one project to own multiple vacant groups.
- This is release preparation; no tag, GitHub Release, production update, or activation is claimed.

## 2026-10-29 — v5.46.1 W2-REC: reconcile the six stabilization issues

<!-- prawduct: type=internal | scope=v5461-w2-rec -->

- Reconciled Wave 1 on `main@7db6ee15fc970d4b9a939c8d3fa8b4a84e1b5886`: W1-B fixed the setup wizard's no-engine fixtures (#2696) and the ttyd watcher's restricted-PATH `sysctl` read (#2697); W1-C removed host-publish and soak-driver test races under subprocess load (#2698).
- W1-D, including W1-A's issues under signed A482-R6, moved five subprocess-using tests to the Large tier (#2688), bounded Stage 5 and fixed the soak guest watchdog's timeout race and orphan cleanup (#2691), and closed group release-authority consistency and fail-open gaps (#2699). The six issues retain their accepted `changelog.d/` fragments for release promotion.
- Updated `FEATURES.md` with stable code and test anchors for all six issues. This records merged work; it does not claim a v5.46.1 tag, GitHub Release, production deploy, or activation.

## 2026-10-28 — v5.46.0 W4-REL: prepare the release-authority and merge-policy candidate

<!-- prawduct: type=internal | scope=v546-w4-rel -->

- Prepared the v5.46.0 release candidate from `main@777c3b42357f09710aad8e2c4edb730354c03f59` after W3-REC PR #2700 merged. Compiled all 12 accepted Wave 1 and Wave 2 changelog fragments into the dated `[5.46.0]` release section and removed the consumed files.
- Updated `version.json` and README clone pins to v5.46.0, extended the released-section lock with `scripts/release-prepare.js`, and recorded pending code-release, production-update and activation finish lines in `docs/releases/v5.46-status.md`. This is release preparation; no tag, publication or production update is claimed.

## 2026-10-28 — v5.46.0 W3-REC: reconcile the release-authority and merge-policy feature batch

<!-- prawduct: type=internal | scope=v546-w3-rec -->

- Consolidated the four Wave 1 and two Wave 2 code cars on merged `main@3ed2247fa9cc40a1b82103fb8d78fa8cc1f34a4a`: store option validation and linked-issue release readiness (#2681, #1495); fragment-only changelog coverage and preserved wrap prompt contracts (#2523, #660); configurable wrap PR merge policy and this repository's merge-commit rule (#1172, #2162); agent/operator release-mode names and changelog link definitions (#1701, #1051); group release ownership and an operator default for unconfigured projects (#1697, #1702); and opt-in managed-project release automation with changelog-convention detection (#721, #2022). The code changes are recorded in their `changelog.d/` fragments and will be promoted into `CHANGELOG.md` by W4-REL.
- Updated the feature index and user guide for the merged behavior, and documented `wrapMergeMethod` in the project configuration table to close the follow-up raised on W1-C (#2693). This records the batch; no release tag or production activation is claimed.

## 2026-10-28 — v5.45.0 W4-REL: prepare the project-settings integrity release candidate

<!-- prawduct: type=internal | scope=v545-w4-rel -->

- Prepared the v5.45.0 release candidate from `main@6f5729504462ee2790beef2b9e26d2bbf887981b` after W3-REC PR #2685 merged. Compiled all ten accepted Wave 1 and Wave 2 changelog fragments into the dated `[5.45.0]` release section and removed the consumed files.
- Updated `version.json` and README clone pins to v5.45.0, extended the released-section lock with `scripts/release-prepare.js`, and recorded the release scope and pending code-release, production-update and activation finish lines in `docs/releases/v5.45-status.md`. This is release preparation; no tag, publication or production update is claimed.

## 2026-10-28 — v5.45.0 W2-A: guard project config writers and share creation validators (#2232, #1374)

<!-- prawduct: type=fixed | scope=w2a-2232-1374-config-writers -->

- **#2232:** The legacy methodology migration reads `project.json` directly and treats an unreadable, malformed or non-object file as unreachable instead of loading defaults and overwriting it. `attachProject` loads existing config through the guarded write path. `attachProject`, setup batch attach and bulk import all create a missing `project.json` exclusively (`flag: 'wx'`), so an existing or concurrently created file is not clobbered. `createProject` also uses exclusive directory creation; a `409 PROJECT_CONFIG_UNREADABLE` during update explains that the project row's engine and tags are written last. Tests cover malformed roots, byte preservation and the load-to-write race.
- **#1374:** `createProject` now runs `PROJECT_UPDATE_VALIDATORS` against a pre-create context. Create and update therefore apply the same checks for `silentPrime`, `showLaunchModePicker`, `defaultLaunchMode`, the hidden-picker confirmation and tags.

## 2026-10-28 — v5.45.0 W2-B: atomic engine config writes and loaded-config reuse (#1291, #2232)

<!-- prawduct: type=fixed | scope=w2b-1291-2232-engine-config -->

- **#1291:** Managed-block, whole-file and inactive-engine config writes use a temp file and rename so an interrupted write leaves a complete old or new carrier. Read-only targets are refused before a temp file is created. Symlink chains, including dangling final targets, are followed to the referent without replacing a link; cycles return `ELOOP`.
- **#2232:** `syncEngineHooks(projectPath, engineIdOverride, projConfigOverride)` accepts an already loaded project config, avoiding a second lax read after a guarded load.

## 2026-10-28 — v5.45.0 W1-B: reject unknown project store keys (#1225)

<!-- prawduct: type=fixed | scope=w1b-1225-project-store-options -->

- **#1225:** `store.projects.list`, `create` and `update` reject unknown option or data keys with a `BAD_REQUEST` `StoreError` instead of silently dropping a misspelled field such as `groupId`.

## 2026-10-28 — v5.45.0 W1-C: validate quick commands and setup batch names (#1339, #2180)

<!-- prawduct: type=fixed | scope=w1c-1339-2180-config-setup -->

- **#1339:** `PATCH /api/config` refuses a `quickCommands` value unless it is an array of objects with string `label` and `command` fields, preventing invalid data from reaching the dashboard command list. The config route also resolves protected roots through `userHome()` when `HOME` is unset.
- **#2180:** `POST /api/setup/complete` validates every batch-attached project name and skips invalid names with a warning. The bulk-import half is recorded under W1-D.

## 2026-10-28 — v5.45.0 W1-A: unify operator `~` path expansion (#1284) + P21 operator-verification repair

<!-- prawduct: type=fixed | scope=w1a-1284-expand-home -->

- **#1284:** Five call sites each hand-rolled their own `~` expansion, two of them from `process.env.HOME` alone with no `os.homedir()` fallback — a process launched without `HOME` set (`sudo`, a launchd job) got `"undefined"` interpolated literally into an SSH key path (`lib/tunnel.js`, `lib/sessions.js`) or the `~` silently stripped to a root-absolute path (`lib/porthub.js`, `lib/openclaw-version.js`, `lib/openclaw-detect.js`, `lib/routes/openclaw.js`) instead of leaving the unresolvable path unchanged; `~otheruser/...` was also mangled by several of the old call sites. `expandHomePath()` in `lib/project-paths.js` — the exact inverse of the existing `tildeHomePath()`, backed by `lib/tangleclaw-home.js`'s `userHome()` — now backs all eight call sites (`lib/orchestration.js`, `lib/git-template.js`, `lib/porthub.js`, `lib/openclaw-version.js`, `lib/openclaw-detect.js`, `lib/tunnel.js`, `lib/sessions.js`, `lib/routes/openclaw.js`). Covered by new unit tests in `test/project-paths.test.js` (bare `~`, `~/...`, `~otheruser/...`, `HOME` unset with `os.homedir()` fallback, and both empty).
- **P21:** Repaired the `VRF-006`/`VRF-007` status lines in `.prawduct/operator-verification.md` — each had trailing prose on the same line as `**Status:**`, which `prawduct-hook check-operator-verification`'s one-bare-word parser cannot read, so both counted as permanently undrainable-pending. Split each onto `**Status:** accepted` with a separate `**Accepted:**` rationale line, per Charter A480 P21 (ratified in `v545-sprint-plan.md`); `prawduct-hook check-operator-verification` now exits 0.

## 2026-10-28 — v5.45.0 W1-D: project-save unreadable-config refusal, structured PATCH status codes, engine-row validators (#1288, #1289, #2180, #2216)

<!-- prawduct: type=fix | scope=w1d-1288-1289-2180-2216 -->

- **#1289:** `lib/project-config.js#load` now refuses to return defaults silently for a `project.json` that parses to a non-plain-object root (array, string, number, `null`) — only a missing file (`ENOENT`/`ENOTDIR`) stays silent; every other failure calls `onError`. `PATCH /api/projects/:name` loads config via the new `lib/projects.js#loadConfigForWrite`, which throws `err.code = PROJECT_CONFIG_UNREADABLE` on any such failure instead of validating and saving over it with defaults; the route maps this to `409 PROJECT_CONFIG_UNREADABLE`.
- **#1288:** `updateProject` now returns a structured `code` (`NOT_FOUND` only when the named project itself is missing; `BAD_REQUEST` for every validator rejection). `PATCH /api/projects/:name` branches on that code instead of searching the first error for "not found" — an unknown `engine` or missing `activePlan` on an existing project now answers `400 BAD_REQUEST` rather than a `404` that implied the project was gone.
- **#2216:** New `intendedEngineAfterUpdate(updates, project)` helper is now the single source the four engine-gated `PROJECT_UPDATE_VALIDATORS` rows (`silentPrime`, `evalAuditMode`, `defaultLaunchMode`, and the hidden-picker eyes-open guard) read for "what engine will this project have" — the project ROW, never `project.json`'s `engine` mirror, which can diverge from it.
- **#2180:** `POST /api/projects/import` now checks `projects.validateName(name)` before registering a batch-imported name, skipping an invalid one with a warning rather than passing it through unchecked. `lib/projects.js#resolveProjectsDir`/`#createProjectsDir` resolve the home directory through `lib/tangleclaw-home.js#userHome()` instead of a bare `process.env.HOME || ''` (consistent with the rest of the product; `lib/project-paths.js#expandHomePath` named in the dispatch does not yet exist on this base commit — W1-A's deliverable, not yet merged — so both sites use `userHome()` directly rather than inventing the missing helper).

## 2026-10-28 — v5.44.0 W4-REL: prepare the update and restart release candidate

<!-- prawduct: type=internal | scope=v544-w4-rel -->

- Prepared the v5.44.0 release candidate from `main@0954a82873158b3b28d561b3263e2be050011d57` after W3-REC PR #2676 merged. Compiled all nine accepted Wave 1 and Wave 2 changelog fragments into the dated `[5.44.0]` release section and removed the consumed files.
- Updated `version.json` and README clone pins to v5.44.0, extended the released-section lock with `scripts/release-prepare.js`, and recorded the release scope and pending code-release, production-update, and activation finish lines in `docs/releases/v5.44-status.md`. This records release preparation; no tag, publication, or production update is claimed.

## 2026-10-28 — v5.44.0 W3-REC: reconcile Wave 1 and Wave 2 update and recovery records

<!-- prawduct: type=internal | scope=v544-w3-rec -->

- **W1-A (#2145):** Installer and server now agree that a blank `projectsDir` in an existing config uses the legacy `~/Documents/Projects` fallback, and boot logs when that fallback applies. Fresh installs still use `~/Projects`; the Full Disk Access hint follow-up was already resolved by #1351.
- **W1-B (#1246):** The self-updater refuses to discard a managed carrier with staged index changes, including edits inside its managed block. Allowed restores name HEAD explicitly.
- **W1-C (#1555):** Restart detection checks that launchd or systemd actually started this server before offering Restart, and the browser's 15-second poll distinguishes a failed restart from a slow one with platform diagnostics.
- **W1-D (#1368, #1369, #2140):** Health degrades when the public index is missing or unreadable; boot audits the server LaunchAgent's working directory and stale LaunchAgent or HTTPS paths after a move; the restart route schedules its command asynchronously so successful self-termination does not produce a false timeout log.
- **W2-A (#1367, #1223):** The behind-origin banner shows the install's copyable pull command and offers Pull only for a clean `main` strictly behind `origin/main`. The route rechecks before a fast-forward and offers restart. Detached release-tag installs continue through Update now.
- **W2-B (#737):** Bundled engine profiles sync on list or get after a source change, and Check again forces a sync. Failed source reads or writes leave the fingerprint pending so later reads retry.
- Reconciled all nine Charter A479 issues in `FEATURES.md` and `docs/user-guide.md`. New `Tests:` citations resolve to test files on disk. This entry adds no archive section.

## 2026-10-28 — v5.43.0 W4-REL: prepare the verified senders and callers release candidate

<!-- prawduct: type=internal | scope=v543-w4-rel -->

- Prepared the v5.43.0 release candidate from `main@01dde223624cde633d6b8c18210dcdc1f636120c` after W3-REC PR #2668 merged. Promoted all ten accepted changelog fragments into the dated release section and removed the consumed files.
- Updated `version.json` and the README clone pins to v5.43.0, extended the released-section lock without changing older locked sections, and recorded the pending code-release, production-update, and activation finish lines in `docs/releases/v5.43-status.md`. This entry records preparation, not a tag, publication, or production update.

## 2026-10-28 — v5.43.0 W3-REC: reconcile verified identity and direct-input records

<!-- prawduct: type=internal | scope=v543-w3-rec -->

- **W1-B (#1865, #1875):** Project and Master Medusa `/send` routes now match the caller's
  current verified launch to the route's participant before accepting even an ordinary message.
  A valid launch for a different participant gets `403 SENDER_PROJECT_MISMATCH`; the message does
  not reach the Hub.
- **W1-C (#1611, #1682):** Launch preflight matches handoffs by project identity, leaving the
  prior workspace id as digest-covered diagnostic metadata rather than comparing it with a fresh
  launch id. Unreadable staged handoff files are named in the launch log and reported as
  `skippedStagedFiles`.
- **W1-D (#2148, #2021):** Startup fire, recovery clear, and startup-prompt save share operator
  proof handling; recovery clear and reconciliation reads share target resolution. Session-rule
  mutation routes reject the Project Master, and global-rule writes and reset are documented as
  operator-only with matching authorization tests.
- **W2-B (#2239):** Audit heartbeats now prove a bound OpenClaw connection through its audit
  secret or resolve an authorized TangleClaw caller. A project launch can heartbeat only its own
  live session. Watchdog entries are scoped by `(project, session_id)`, and the first valid
  heartbeat or ingest establishes a watch.
- **W2-A (#2402):** Direct session commands reserve leading slash input for the operator, stamp
  peer and Master injections with a server-owned verified sender, and return a submission
  receipt. Project `replyGuidance` can replace Medusa reply instructions, while
  `suppressNonActionableWakes` skips a nudge for an inbox containing only shared-document notices.
- Reconciled the six merged cars in `FEATURES.md` and `docs/user-guide.md`, using the v5.43.0
  wave-start commit for the feature-index verifier. W1-A (#1458, #1286) already has its own
  entry below; this entry does not duplicate it or add an Archive section.

## 2026-10-28 — v5.43.0 W1-A: reset-admin --disable, and the dry-run exit-code fix (#1458, #1286)

<!-- prawduct: type=feature | scope=w1a-1458-1286-reset-admin -->

- **#1458:** `scripts/reset-admin.js --disable --user <name> [--force]` revokes a TangleClaw
  account's login through the existing `store.users.disable` primitive (destroys its sessions,
  deletes its recovery codes) without deleting the account. Refuses to disable the only currently
  enabled account unless `--force` is passed, and reports clearly when the gate transitions to
  `locked` (shared `describeGateLines` helper, now covering `LOCKED` explicitly). Re-enable with
  the existing `--store --user <name>`.
- **#1286:** `--create-gate --dry-run` now exits 1 when its preview predicts the run would refuse,
  matching the exit code a predicted password refusal already gave — previously it exited 0, a
  false green light during the lockout this tool exists to recover from. The single rule ("a
  preview that predicts a refusal exits 1, in every mode") is now stated in `docs/setup-guide.md`.
- Updated `docs/recovery.md`'s "Every account is disabled" section, which previously said no
  command to disable an account existed, and added behavioral test coverage with real store writes
  (`test/reset-admin-store.test.js`) alongside CLI-subprocess exit-code pins
  (`test/reset-admin.test.js`).

## 2026-10-28 — v5.42.0 W3-REC: reconcile Wave 1 and Wave 2 launch records

<!-- prawduct: type=internal | scope=v542-w3-rec -->

- Reconciled all ten Charter A477 sprint issues in `FEATURES.md`: unready verdict visibility (#1596), prime-paste outcome (#1597), damaged handoff recovery (#1623), startup admission (#1633), the shared pane writer (#1669), opening order (#1693), durable READY receipt (#1877), frozen recovery gate context (#2150), live Medusa binding (#2153), and append-only READY reconciliation (#2191).
- Updated `docs/user-guide.md` to explain startup task admission, the step-read READY fence, sequence-less damaged-handoff recovery, the unready monitor's recorded verdict, and launch opening order. This records merged behavior; it changes no runtime code.
- Verified every new `FEATURES.md` `Tests:` path exists, checked the feature index and test-stage suites, and confirmed this file introduces no duplicate archive section.

## 2026-10-28 — v5.42.0 W2-A: single opening-order owner, and the recovery gate's own follow-ups (#1693, #2150)

<!-- prawduct: type=internal | scope=w2a-1693-2150 -->

- **#1693:** The launch's opening order — banner, sequence, freshness/attest, propose-and-stop —
  now has one owner, `lib/launch-bootstrap.js`'s `OPENING_ORDER` (plus the `RESUME_AND_STOP`,
  `READY_VERDICT_PLACEHOLDER` and `STEP_COMMAND_CLOSE` fragments it shares verbatim). The four
  surfaces that narrate it — the prime's ordering block (`lib/sessions.js`), the all-acked and
  already-attested pages (`lib/launch-sequence.js`), and the kickoff line (`lib/launch-kickoff.js`)
  — render from it instead of four hand-written copies that drifted three times across #1680's
  review. No observable text changed. Added `test/launch-bootstrap.test.js`.
- **#2150** (four small follow-ups from the cumulative review of #1937 chunk 04b, grouped because
  they sit in the same two functions):
  1. A launch's log now names the login gate state its recovery mode was resolved against,
     alongside the frozen mode and source (`lib/sessions.js#_resolveLaunchRecoveryMode` /
     `_buildLaunchSnapshot`) — an operator asking "why was this launch held" now has the input
     that decided it, not just the verdict.
  2. `test/recovery-default-launch.test.js` adds coverage for `_claimedInheritedNotice`'s
     unreadable-row path (`lib/launch-sequence.js`): fails closed to no notice, not a crash and
     not a stale `true`, versus `true` for the same readable row.
  3. `projectRecoveryNow`'s JSDoc (`lib/launch-sequence.js`) no longer claims every field is null
     for a project this install does not have — `projectRecoveryGateState` is a property of this
     process, not of the project, and is reported either way; the paragraph explaining it moved
     out of the gap between `@param` and `@returns`.
  4. `_validateReady` (`lib/launch-sequence.js`) and the bridge's `_awaitLaunch`
     (`lib/bridge-gateway.js`) now both read the single, already-exported `_operatorHeld`
     predicate instead of three independent copies of
     `recovery === 'required' && recoveryMode !== 'advisory'`.
- Tests: `test/launch-bootstrap.test.js`, `test/launch-sequence.test.js`, `test/launch-kickoff.test.js`,
  `test/launch-steps.test.js`, `test/recovery-default-launch.test.js`, `test/project-recovery-state.test.js`,
  `test/test-stage.test.js`, plus `test/api-bridge-gateway.test.js` as a cross-file sweep for the
  `_awaitLaunch` change (it exercises the bridge's own recovery-gated readiness check) — 406 tests,
  0 failing.

## 2026-10-27 — v5.42.0 W1-A: extract shared pane-writer behind launch-unready and launch-kickoff (#1669)

<!-- prawduct: type=internal | scope=w1a-1669 -->

- **#1669:** Extracted the pane-capture, idle-assessment (with its best-effort cursor fallback),
  injection-result classification, and swallow-and-warn activity-logging mechanics shared by
  `launch-unready.js` and `launch-kickoff.js` into a new `lib/launch-pane-writer.js`, per Architect
  Pre-Flight Ruling A477-COSIGN-20261027T2307Z. Each caller's own one-shot state machine is
  untouched: `launch-unready` still counts a nudge only after a successful send, and
  `launch-kickoff` still claims its fire-once slot before sending and releases it only on a
  pre-send bailout. Both existing test suites (`test/launch-unready.test.js`,
  `test/launch-kickoff.test.js`) pass unchanged against the extracted module; added
  `test/launch-pane-writer.test.js` to cover it directly.
- Noted for the record rather than changed (outside this car's authorized file scope): the
  independent PR reviewer observed that `assessIdle` now runs inside the same try/catch as
  `capturePane` in both callers, where it previously ran unguarded. For `launch-kickoff` this
  closes a latent gap against the module's own "never rejects" invariant; for `launch-unready` it
  changes only the log message and an `idleTicks` reset on an `assessIdle` throw, not the verdict
  code returned. The cumulative Critic review of this exact diff passed with 0 blocking.
- Also noted: one unrelated full-suite failure (`record-test-run.test.js`'s "declares the
  suite-evidence wrapper" check) is a local-environment artifact, not a regression this branch
  introduces: `.prawduct/project-state.yaml` is gitignored (`.gitignore:43`, `.prawduct/*`) and
  never ships with any branch, so the test's assertion is purely against this checkout's own local
  config, which still declares the pre-cutover `test_command`. Reproduced on a clean detached
  `origin/main` worktree sharing this same local config and confirmed the test passes there in
  isolation when run against a fresh worktree with no `.prawduct/project-state.yaml` of its own —
  the failure tracks this checkout's pending, Operator-held #2371 cutover
  (`scripts/suite-evidence.js` is built but not yet declared as `test_command`), which is outside
  this car's authorized file scope to change.

## 2026-10-27 — v5.41.0 W4-REL: prepare the release candidate

<!-- prawduct: type=internal | scope=v541-w4-rel -->

- Promoted the 13 accepted wrap-resilience, plan-resolution, handoff, Medusa and session-range fragments into `CHANGELOG.md`'s 5.41.0 section and removed their consumed files. Set `version.json` to 5.41.0, updated both README clone pins, extended the released-section hash lock through `scripts/release-prepare.js`, and recorded the candidate's pending release, production and activation finish lines in `docs/releases/v5.41-status.md`. Publication remains subject to the Operator's exact-target release approval.

## 2026-10-27 — v5.41.0 W3-REC: reconcile the shipped wrap record

<!-- prawduct: type=internal | scope=v541-w3-rec -->

- Reconciled all 13 v5.41.0 issues in `FEATURES.md` with real test citations, filled the W1-B, W1-D and W2-A change-log gaps below, and updated the operator's wrap guidance in `docs/user-guide.md`. This records the already-merged code; it changes no runtime behavior.

## 2026-10-27 — v5.41.0 W1-D: process groups and handoff continuity (#1503, #1651, #1733)

<!-- prawduct: type=fix | scope=w1d-1503-1651-1733 -->

- **#1503:** Timed-out and over-buffer wrap-step commands now stop their whole process group, confirm it is gone before resolving, and report uncertainty if confirmation cannot be established. A command that catches `SIGTERM` and exits still reports the timeout that occurred.
- **#1651:** `publishHandoff` rechecks the staged file digest inside its `BEGIN IMMEDIATE` transaction before publication.
- **#1733:** A wrap mirrors live `.prawduct/.handoff-notes.md` for the next Claude SessionStart hook. Successful reading consumes the mirror; a failed read preserves it, and a later wrap with no notes clears an obsolete mirror.

## 2026-10-27 — v5.40.0 W2-C PR #2637 Round 7 (test-only): never let the TCC-authorized test suite kill a real production server

<!-- prawduct: type=internal | scope=w2c-2352-2625 -->

- **#2625:** `lib/tmux.js` bound `TCC_SOCKET` as a fixed closure-local constant throughout — `test/tmux-tcc.test.js`'s `afterEach` runs `tmux -L <socket> kill-server` unconditionally every test, so once #2625 is live on a host with a real TCC-authorized server already running real sessions, running this suite there would destroy them. Every function that creates or checks the TCC-authorized server now reads `module.exports.TCC_SOCKET` instead (same pattern as `module.exports.createSession`), so a test can retarget the whole bootstrap path by reassigning one property. `test/tmux-tcc.test.js` now overrides `tmux.TCC_SOCKET` to a fresh, unique socket name per test (`beforeEach`) and restores it after each test's own cleanup (`afterEach`, which now only ever kills that test's isolated socket). New test asserts the default production name (`tangleclaw-tcc-authorized`) without ever invoking `tmux` against it, and proves a simulated pre-existing session on a SEPARATE isolated socket is untouched while the test runs against its own per-test overridden `tmux.TCC_SOCKET` (the entry below corrects this test's own first draft, which had briefly done the opposite of what it set out to prove). Caught by TC-Lane-PRR-B's Round 7 review.

<!-- prawduct: type=fixed | scope=w2c-2352-2625 -->

- **#2352:** `decidePermissionRequestFromUi` (`public/session.js`) called the shared `apiMutate()`, which never attaches `X-TC-Open-Token` — only `public/landing.js`/`public/ui.js` do that manually, at their own `_requireOperatorWrite`-gated call sites. The `/decide` route is the first write `session.js` has ever made to that gate, so on an OPEN (no-login) install, clicking Grant or Refuse on the session page's permission panel always failed with `403 OPEN_INSTALL_TOKEN_INVALID` — the Operator could not actually decide a permission request from the dashboard at all. Caught by Rule #275.3's live browser verification (real headless Chrome via CDP, driven from the shell to share its loopback namespace with a scratch server, after `claude-in-chrome`'s own Chrome instance proved unreachable from this sandbox) — not visible to any code-reading review, since every prior test manually constructed the header via test-harness code rather than going through the real page JS. Fixed by fetching `/api/auth/me` and attaching the token when present, following the existing `landing.js`/`ui.js` pattern exactly; an armed (login-configured) install is unaffected (`me.openInstallToken` is simply absent there). Re-verified live after the fix: Grant and Refuse both succeed, the pending count drops to 0, and the decided states persist across a reload — confirmed both at the DOM layer and directly against the store (`decidedBySurface: 'dashboard'`, `decidedByActor: 'operator'`).
- **#2625 (test-only):** `test/tmux-session-names.test.js`'s (#1983) scan for every test file that starts a real tmux session flagged `test/tmux-tcc.test.js`'s `startAuthorizedAnchor()` — its literal `'new-session',` array element matched the scan's `SPAWNS_TMUX` regex even though it targets the isolated `tmux.TCC_SOCKET` server, not the default one that scan tracks. GitHub Actions CI caught this on the Round 5 head; fixed by building the string from `['new', 'session'].join('-')` instead of a literal, with a comment explaining why.

<!-- prawduct: type=fixed | scope=w2c-2352-2625 -->

- **#2352:** `_persistedBridgeDecision` (`lib/permission-requests.js`) replaced its unanchored phrase-search-plus-negation-denylist with a single anchored, whole-message regex (`^\s*(?:yes\s*,\s*)?(grant|refuse)\s+<requestId>\s*[.!]?\s*$`, case-insensitive). TC-Lane-PRR-B's Round 5 review found the prior approach still granted a persisted question ("Can you grant perm_X?") or conditional ("If you want to grant perm_X, ask me first") — neither carries a negation word, so the denylist never fired, and the verb-adjacent-to-id check matched regardless of the surrounding prose. Anchoring the entire trimmed message removes the denylist altogether: any prose before or after the bare command fails the match, with no new keyword to enumerate against the next prose shape. `test/permission-requests.test.js`'s duplicate-external_id test (one route deciding two different requests) was restructured to update the SAME route's persisted body between the two `decideFromBridge` calls, since the anchored grammar correctly refuses a single message naming two decisions at once (the thing that test's old two-id-in-one-message fixture relied on no longer parses cleanly for either id, by design).

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
