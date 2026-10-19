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

## 2026-10-19 — W21-REC: combined records for the Wave 21 source merges

<!-- prawduct: type=chore | scope=w21-rec-records -->

v5.34.0 records chunk W21-REC, Charter v2.55, from merged main `fb352f9b`. W21-B1 PR #2508 merged as `c72f5c31` (closes #2088); W21-A1 PR #2509 merged as `fb352f9b` (refs #2240 Chunk 01, which remains open). The two source entries below remain intact.

**What changed.** `CHANGELOG.md` adds a Fixed entry for #2088's scratch-repository cleanup, tmux test wait and loopback binding, and a Changed entry for #2240 Chunk 01's soak Operator login and authenticated writes. `FEATURES.md` adds the Operator-login description under the soak schedule, including the switchboard-binding limit. The LOGIN_SHOWN README/change-log clause approved by Architect A353 remains owed to #2240 Chunk 02, along with A344 D8's Tart VM guest dry run (A owner). This records PR changes no product code, version, release, tag or deployment.

## 2026-10-19 — #2240 Chunk 01: the soak signs in as an Operator account, with CSRF and a bounded 401 policy

<!-- prawduct: type=feature | scope=w21-a1-soak-operator-auth -->

v5.34.0 Wave 21 chunk W21-A1, chunk 1 of 2 of #2240 (items 2, 3 and 4; item 1 is Chunk 02, which closes it). Refs #2240. Branch `fix/2240-w21-a1-soak-operator-auth` from `origin/main` `7641eb92`. Plan: `.tangleclaw/plans/w21-a1-2240-chunk01-soak-operator-auth.md` (rev1 sha256 `b1695551…ea9c`, Architect A344 D1-D8, A345). Charter v2.55 (sha256 `a93ea15c…7c86`, 18-file lock, A348). Rulings during the build: A346 (secrets only in files, never on stdout or a command line) and A351 (the three-step first run below, after the cumulative Critic found that setup with an account starts the Caddy cutover on a guest that has Caddy).

**What changed.** The #2233 launch-binding floor refuses the soak's launches, kills, commands, wraps, restarts and leases from anyone but the Operator, a Master or a live session, and the service token stands for nobody outside the port routes. So the soak now signs in as an account.
- `guest-setup.sh` step 5 creates a `soak-operator` login as the workload user, a `0600` file the new `soak.js operator-login` writes. A first run then finishes setup with no login, turns the login on (`add-login`) and creates the account (`set-password`), so no Caddy cutover starts; the dashboard header goes only on the two calls made while the gate is open. A re-run reads the gate and does only what is missing: it finishes an interrupted first run, signs in to an armed guest with the file, or refuses with "recreate the guest". Every later write, step 6's hub leases included, goes with the session and CSRF. Secret-bearing calls run as the workload user, with each secret only in its own `mktemp` files.
- `executors.call(..., { as: 'operator' })` carries the session on a closed list of writes, to the target's own origin only. Reads and `medusa/send`/`read` carry none: those stay failing closed until Chunk 02 carries each session's binding.
- `soak.js run --operator-login` signs in by gate state before any load (`OPERATOR_LOGIN_UNAVAILABLE` / `OPERATOR_LOGIN_FAILED` otherwise). A 401 is never retried (`UNAUTHENTICATED`). The next Operator event signs in once; a failure is `REAUTH_FAILED`, and three in a row stop the run cleanly (`REAUTH_EXHAUSTED`).
- Browser events add the session as WebDriver cookies after opening `/login`, and a render on the sign-in page is `LOGIN_SHOWN`.
- README states the bearer token's scope. The two soak runbooks match the new flow.

**Evidence.** A principal-table test runs every executor kind against one fake target and fails on any mutating call with no entry. Two mutations were checked by hand: a missing entry, and a switchboard call sent as the Operator. Both were caught. Secrecy tests search every outcome, log, header and `resume` record, stdout, stderr and the guest's call log for the password and both tokens. On host scratch servers (temp `TANGLECLAW_HOME`, PortHub ports 4310 and 4313, Caddy off PATH): a cookie plus CSRF leased 201, with no CSRF 403, with no cookie 403 `LAUNCH_BINDING_REQUIRED`, and a logged-out cookie got 401 (A4); the file-based curl sequence answered 200/201/200/200, then 401 after logout; setup with no login, then `add-login`, then `set-password` took the gate open, account-required, armed, with provisioning off, and a signed-in lease got 201. The password appears in either server log 0 times. The Caddy-present cutover was found by reading the code and was never run. Owed to the next guest dry run (A344 D8, owner TC-Lane-A): the engine, fault and Safari cycles in a real guest, including A3 (Add Cookie with `httpOnly`), and steps 5 and 6 end to end.

## 2026-10-19 — #2088: remove the mechanisms behind three intermittent full-suite failures

<!-- prawduct: type=fix | scope=w21b1-2088-intermittent-hardening -->

v5.34.0 Wave 21 chunk W21-B1, chunk 1 of 1. Branch `fix/w21b1-2088-intermittent-hardening` from `origin/main` `7641eb92`. Closes #2088 (item 3 was closed by #1993). Plan: `.tangleclaw/plans/build-plan-w21b1-2088-intermittent-hardening.md` (rev1 sha256 `bd60e07a…a3c0`, Architect A343, INT); charter v2.54 five-file lock.

**What changed.** `verifyRecord` (`lib/release-certification/host-publish.js`) passes `-c gc.auto=0 -c maintenance.auto=false` on every git call against its scratch repository, because a `fetch` there spawns `git maintenance run --auto`, which can still be writing while the removal walks the directory (`ENOTEMPTY`). The removal retries (`maxRetries: 5`, `retryDelay: 50`) and still throws if it keeps failing; it goes through a new `opts.rm` seam. `relay()` and its persistent `_relay/<key>.git` are unchanged (A343 D2). The four `sendKeys - behavioral` tests that slept 0.4 s and then looked for text the typed command line already holds now wait for that text as the output line just above a fresh prompt. The four `api-medusa` test servers that listened on every address bind `127.0.0.1`.

**Evidence.** Not reproduced as the original failing tests; each mechanism was shown and removed. E1: with a server on `listen(0)`, a second process bound `127.0.0.1` on its port and answered its requests; on `listen(0, '127.0.0.1')` that bind fails `EADDRINUSE`. E2, through `verifyRecord`'s own wrapper with `GIT_TRACE=1`: no maintenance spawn; with the flags stripped, one. Mutations: dropping the flags, the retries, or the removal on the unreadable-remote return each fails the new #2088 tests. A command typed but never run passes the old `includes` check and fails the new wait. Under 20 CPU hogs, the restored 0.4 s sleep did not fail in 5 runs, so the load race itself is reasoned, not shown. Each changed test file passed 5 of 5 runs alone. Cumulative Critic `rev-20261019T014803Z-b89aa925`: 0 blocking, 1 warning and 3 notes, all accepted. The first full suite failed one test, `auto-merge-callers`, because a new comment quoted git's maintenance command with its auto flag; the comment was reworded, and `verify-resolutions` `rev-20261019T021409Z-9ffce600` found nothing.

## 2026-10-18 — W20-REC: combined records for the Wave 20 source merges

<!-- prawduct: type=chore | scope=w20-rec-records -->

v5.34.0 records chunk W20-REC, Charter v2.52, from merged main `704a41a2`. W20-B1 PR #2505 merged as `50cdb95e` (closes #2504); W20-A1 PR #2506 merged as `704a41a2` (closes #1903, final Chunk 10). The two source entries below remain intact.

**What changed.** `CHANGELOG.md` adds two Internal `[Unreleased]` entries for the test-only changes. `FEATURES.md` completes the #1903 lift-helper line: Chunk 10 removes the last 15 private copies, the inventory is empty, and the scan still names three non-lifter exceptions. The W20-A1 source entry's refreshed cumulative Critic `rev-20261018T234230Z-abbc0b38` had zero blocking findings; the source PR body also records it. `archive-change-log` dry run moves zero entries: the live log is 37 KB, below its 40 KB threshold, so the October archive is unchanged. `[Unreleased]` is about 19 KB, below the 90 KB alert. These records do not bump a version, release, tag or deploy.

## 2026-10-18 — #1903 Chunk 10: the last fifteen lift copies use the shared helper, and the inventory is empty

<!-- prawduct: type=refactor | scope=w20-a1-lift-chunk10 -->

v5.34.0 Wave 20 chunk W20-A1, chunk 1 of 1, the final chunk of #1903. Branch `fix/1903-w20-a1` from `origin/main` `414f3eca`. Closes #1903. Plan: `.tangleclaw/plans/w20-a1-lift-chunk10-1903.md` (rev1 sha256 `65d65237…d434`, INT `83dcfdc5`, Architect A335); charter v2.52 (sha256 `1daeecf8…e98f`, A333), 14-file lock.

**What changed.** Six `functionBody` copies (`wrap-bump-level-askmode`, `wrap-drawer-select-a11y`, `wrap-indicator-card`, `wrap-rule-proposal-widget`, `wrap-run-reattach`, `wrap-skip-continue-label`) become `liftBody`; three `liftFunction` copies (`wrap-ends-session`, `wrap-release-decision`, `wrap-untrack-offer-ui`) become `liftDeclaration`. `wrap-indicator-card`'s `body` arrow and its inline `renderStatusDot` walk become `liftBody` calls; the walk's `start` guard stays. `wrap-intent-cancel`'s `lift` and the walk inside its `save` harness become `liftDeclaration` calls; the harness stays. The two `functionSource` copies (`wrap-confirm-calls-defined`, `wrap-run-session-wiring`) found a declaration by a column-0 `(async )?function name(` regex, so `WRAP_PATH` and `WIRING` become lists of declaration literals, `async ` included on the four and five async ones. `wrap-confirm-calls-defined` now fails a missing function when its describe collects, not in its locatable test, which stays. `INITIAL_INVENTORY` goes from 15 to 0: the scan finds only its three named non-lifter exceptions and refuses any new copy.

**Evidence.** A `node --require` capture logged the same 1066 runtime lifts, byte for byte, on base and branch, across all twelve files. Every file's test count is unchanged. Miss messages change only on an already broken source. Put back, a private brace loop fails `lift-helper.test.js` as a new copy, and a stale inventory line fails it as a copy gone. `test/helpers/lift.js` and production files are untouched. Cumulative Critic `rev-20261018T230330Z-3aca7a16`: 0 blocking, 2 warnings and 4 notes, all accepted; the inventory constant keeps its name and message by plan decision D7.

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
