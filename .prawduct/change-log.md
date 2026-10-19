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

## 2026-10-18 — W20-B1: the launch-binding dispatcher test holds every port it leases

<!-- prawduct: type=bugfix | scope=w20b1-launch-binding-port-fixture -->

v5.34.0 Wave 20 chunk W20-B1, chunk 1 of 1, Charter v2.52, Architect A334. Closes #2504. Plan: `.tangleclaw/plans/build-plan-w20b1-launch-binding-port-fixture.md` (rev1 sha256 `fe8c5f59…feb38`, INT `26faad2b`).

**What changed.** `test/launch-binding-dispatch.test.js` leased fixed ports counted up from 39401. In CI run 39170225170, another worker's listener on 39409 made the lease route refuse the "superseded" case's current-launch request as `409 PORT_IN_USE` before the binding verdict was reached. Now each lease binds a loopback port the OS chooses and holds it until `after()`, which closes every reservation even when a test fails. The request says the listener is its own with `adoptListener: true`, which the route reads only after the binding floor admits the caller. A failed bind throws a named fixture error. A new self-test asserts that two leases get distinct ports and that each is still bound (`EADDRINUSE`). No existing assertion changed, and no product file changed. With a stranger on 39409, and with strangers on 39401-39414, the file passes. Dropping `adoptListener` turns all five granted-lease cases red. Restoring only the fixed counter fails the self-test alone, because `adoptListener` would adopt a stranger's listener too. That makes the self-test the guard against losing the hold. Restoring the old fixture in full fails the self-test and, with a stranger on that case's port, the superseded case.

## 2026-10-18 — W19-REC: combined records for the Wave 19 source merges

<!-- prawduct: type=chore | scope=w19-rec-records -->

v5.34.0 records chunk W19-REC, Charter v2.51, from merged main `fe4b1ca2`. W19-B1 PR #2501 merged as `c9b9e61c` (closes #2496, refs #2200); W19-A1 PR #2502 merged as `fe4b1ca2` (refs #1903 Chunk 09). #1903 stays open with 15 private lifters. The two source entries below remain intact.

**What changed.** `CHANGELOG.md` adds two Internal `[Unreleased]` entries for the test-only changes. `FEATURES.md` extends the #1903 lift-helper inventory through Chunk 09, from 26 to 15. `prawduct-hook archive-change-log` dry run moves zero entries: the live log is 33 KB, below its 40 KB threshold, so the October archive is unchanged. `[Unreleased]` is 18,635 UTF-8 bytes, below the 90,000-byte alert. These records do not bump a version, release, tag or deploy.

## 2026-10-18 — #1903 Chunk 09: eleven more lift copies use the shared helper

<!-- prawduct: type=refactor | scope=w19-a1-lift-chunk09 -->

v5.34.0 Wave 19 chunk W19-A1, chunk 1 of 1. Branch `fix/1903-w19-a1` from `origin/main` `408ace25`. Refs #1903 (Chunk 09). Plan: `.tangleclaw/plans/w19-a1-lift-chunk09-1903.md` (rev1 sha256 `7cdbc871…fd53`, INT `90023082`, Architect A325); charter v2.51 (sha256 `029f079b…3dc5`), 12-file lock.

**What changed.** `settings-index-toggle-render`, `settings-launch-mode-render`, `settings-silent-prime-render`, `setup-wizard-git-unknown`, `startup-prompt-editor`, `stranded-wraps-ui` and `tcc-folders` drop identical private `liftFunction` copies for `liftDeclaration`. `settings-modal-silentprime`'s inline brace walk becomes `liftBody`; only the guard on the old loop's brace index goes. `update-prompt-guards`' `functionBody` becomes one `liftDeclaration` call, and the reason it reads the prompt rather than the file moves to a comment there. `version-visibility`'s `lift` and `extract` become `liftDeclaration` calls; `extract` matched `(async )?function name(`, so its two async functions are lifted with an `async function` literal. A `node --require` capture logged the same 619 lifts, byte for byte, on base and branch, and every file's test count is unchanged. `INITIAL_INVENTORY` goes from 26 to 15, all of them `wrap-*` files.

## 2026-10-18 — W19-B1: the twenty-wedged-reads case proves the loop turns while every read is in flight

<!-- prawduct: type=bugfix | scope=w19b1-twenty-wedged-reads-proof -->

v5.34.0 Wave 19 chunk W19-B1, chunk 1 of 1, Charter v2.51, Architect A326. Closes #2496. Refs #2200. Plan: `.tangleclaw/plans/build-plan-w19b1-twenty-wedged-reads-proof.md` (rev1 sha256 `cd7a65e1…2d19`, INT `2b730b48`).

**What changed.** `test/tmux-read-pane-async.test.js`'s "twenty wedged reads leave the event loop turning while they are waited on" case counted 10 ms timer turns while twenty reads ran out a 600 ms timeout, so slow timer delivery alone could fail it. Now the read timeout is 60 s, the stand-in's `hang` sleeps 120 s, and the test releases the reads by killing the children `countSpawns` recorded. It asserts that all 20 children exist and are alive, with no read settled, when the calls return. After at least 10 turns under a 60 s failure guard it asserts the same again, then that every released read rejects as `tcTimedOut`, each stopped at its probe, and every child is gone. The settled flags ride one `Promise.allSettled` that is subscribed at once, so a read that ends early fails a named assertion and never becomes an unhandled rejection. Load can now only make it slower. A blocking-read mutant fails "a read ended before the test released it"; a starved-interval mutant fails on 0 turns. `lib/tmux.js` is unchanged (no product defect). Node's own `execFile` timeout stays proven by the file's other `hang` cases, which use 300 ms timeouts.

## 2026-10-18 — W18-REC: combined records for the Wave 18 source merges

<!-- prawduct: type=chore | scope=w18-rec-records -->

v5.34.0 records chunk W18-REC, Charter v2.50, from merged main `a76868ac`. W18-B1 PR #2497 merged as `92858112` (closes #2200, refs #2313); W18-A1 PR #2499 merged as `a76868ac` (closes #2412, refs #1903 Chunk 08). #2313 stays open for its signed-in panel check after the next deploy, owned by TC-Lane-B; #1903 stays open with 26 private lifters. The two source entries below remain intact.

**What changed.** `CHANGELOG.md` adds three Internal `[Unreleased]` entries for the test-only changes. `FEATURES.md` extends the #1903 lift-helper inventory through Chunk 08, from 36 to 26. The archive dry run moves zero entries because the live change log stays below 40,000 bytes, so the October archive is unchanged. These records do not bump a version, release, tag or deploy.

## 2026-10-18 — #1903 Chunk 08, #2412: ten more lift copies use the shared helper, and the early-timer deadline case no longer depends on host speed

<!-- prawduct: type=refactor | scope=w18-a1-lift-chunk08-fingerprint-timer -->

v5.34.0 Wave 18 chunk W18-A1, chunk 1 of 1. Branch `fix/1903-2412-w18-a1` from `origin/main` `494a4897`. Refs #1903 (Chunk 08); closes #2412. Plan: `.tangleclaw/plans/w18-a1-lift-chunk08-fingerprint-timer-1903-2412.md` (rev1 sha256 `f7caed7d…769e`, INT `fe051034`, Architect A315); charter v2.49 (sha256 `3d948ca1…e1e2`), 9-file lock. `lib/checkout-fingerprint.js` is untouched: its guard tells a timeout by the symbol that won the race, not by the clock, and a clock-re-reading mutant of it fails the rewritten case.

**#2412.** `test/checkout-fingerprint.test.js` "reports a timeout as the deadline even when the timer fires before the clock reaches it" sent every unstalled call to real git under a 300 ms deadline. With git slowed by 0.1 s per spawn, five of the six stalls were never reached, and the deadline ended a real git process instead. The case now records real git's answers once, before the shifted-timer window. Inside the window it replays them (an unrecorded call throws) and freezes `Date.now`. It also asserts that each stalled call was ended exactly once. Logging at the seam and at the binary shows no git spawned inside the window. The case passed 200 runs unloaded and 50 beside ten CPU-bound processes. The 2026-10-14 failure itself was never reproduced (its assertion text was lost), so this removes the host-speed path rather than proving that path was the cause.

**#1903 Chunk 08.** `session-update-poll`, `session-wrap-finalize`, `session-wrapper` (five inline loops and a nested `functionBody`), `sessions` and `setting-disposition` drop their private brace-matching copies for `test/helpers/lift.js`. Three `session-wrapper` guards that only checked the old inline loop go with it. A `node --require` capture logged the same 126 lifts, byte for byte, on base and branch, and every file's test count is unchanged. `INITIAL_INVENTORY` goes from 36 to 26.

## 2026-10-18 — W18-B1: the thirty-wedged-reads case proves the loop turns while every read is in flight

<!-- prawduct: type=bugfix | scope=w18b1-wedged-reads-proof-and-bridge-times -->

v5.34.0 Wave 18 chunk W18-B1, Charter v2.50, Architect A316. Closes #2200. Refs #2313.

**What changed.** `test/medusa-wake-async.test.js`'s "thirty wedged reads answering together leave the event loop turning, with real child processes" case counted 10 ms timer turns inside a ~500 ms read timeout, so host load alone could fail it: 2 turns, measured under background QoS with 120 CPU hogs, while every read was still judged. Now each stand-in child records its PID and sleeps past a 60 s guard, the read timeout is 60 s, and the test releases the reads by killing the children. It asserts that no reader has a verdict when the tick returns; that the loop turned at least 10 times with all 31 children started, still alive and unjudged; and, after release, that all 31 (30 sessions and the Master) are judged `pane-capture-failed`, nothing was typed, no blocking tmux call ran on the answer path and every child is gone. Load can now only make it slower. `lib/` is unchanged (no product defect). Node's own `execFile` timeout firing is no longer exercised in this case and stays proven by `test/tmux-read-pane-async.test.js` ("rejects as timed out…", "the timeout bounds the whole read"). The sibling case in that file has the same wall-clock shape and is filed as #2496.

**#2313** shipped in PR #2432 (`fb7f79fa`). No code here. Its signed-in after-deploy panel check stays owed (owner TC-Lane-B).

**Verified.** Case alone 5/5; 5/5 under 30 foreground CPU hogs; file all green; a scratch synchronous `readPaneAsync` (never committed) fails with "a wedged child ended before the test released it"; `sync-claude-md-block.js` compare exit 0.

## 2026-10-18 — W17-REC: combined records for the Wave 17 source merges

<!-- prawduct: type=chore | scope=w17-rec-records -->

v5.34.0 records chunk W17-REC, Charter v2.47, from merged main `c71ea903`. W17-A1 PR #2493 merged as `165d8925` (closes #1399, refs #1903 Chunk 07); W17-B1 PR #2494 merged as `c71ea903` (closes #2489, #2184, #2046). #1903 remains open with 36 private lifters. Both source entries below remain intact, including B's guide and generated `CLAUDE.md` block sync under the amended 15-file lock.

**What changed.** `CHANGELOG.md` adds one Security, one folded Fixed and three Internal `[Unreleased]` entries, each below 400 UTF-8 bytes; it also removes the stale #2489-open clause from the older #2290 entry. `FEATURES.md` records verified shared-doc lock caller binding, corrects the earlier lock-release and finalize claims, updates the lift inventory from 46 to 36, and names the single POSIX shell-word owner and its guard. The October archive is unchanged because the live change log remains below its 40,000-byte threshold. These records do not bump a version, release, tag or deploy.

## 2026-10-18 — #2489, #2184, #2046: a member's shared-doc lock is taken in its verified name with a bounded ttl, the bridge-gateway tests stop racing their clock and sockets, and the finalize docs say what shipped

<!-- prawduct: type=bugfix | scope=w17b1-lock-caller-binding-gateway-determinism-finalize-docs -->

v5.34.0 Wave 17 chunk W17-B1, chunk 1 of 1. Branch `fix/w17b1-lock-caller-binding-gateway-determinism-finalize-docs` from `origin/main` `6ae92519`. Closes #2489, #2184, #2046. Plan: `.tangleclaw/plans/build-plan-w17b1-lock-caller-binding-gateway-determinism-finalize-docs.md` (rev2 sha256 `4796821b…61a1`, Architect A302/A304, INT `006884ff`); Charter v2.47 (sha256 `db13f4aaa53cc418318d39a2fc8d3c04301728b4e412127e77430bb0f95f6d04`), 15-file lock, 13 changed.

**#2489.** `POST /api/shared-docs/:id/lock` used to record whatever `sessionId` and `projectName` its body named. It now treats them as a member's claim and checks it against the launch binding: a mismatch is `403 LOCK_CALLER_MISMATCH` and nothing is written; a match records the verified session and project. The operator still names any session. `ttlMinutes` must be a whole number from 1 to 120 for every HTTP caller (`400 BAD_REQUEST`), and defaults to 30 when omitted. `documentLocks.acquire` is unchanged and still takes any ttl, which a new store test pins. The attest-route test that planted a foreign lock over HTTP now seeds it in the store; its assertions are unchanged. The `attestLockRefusal` JSDoc and the DELETE route comment no longer say every lock records the body's session.

**#2184.** The expiry test's "one millisecond inside" check anchored its clock to the newest question in the database, which a question an earlier test asked under a moved clock can become on a slow host. That would push the anchor past this question's real deadline. The test now anchors its three clock moves to its own route's question (`questionLater`). The fetch helpers in `test/api-bridge-gateway.test.js` and `test/api-bridge.test.js` send `connection: close`, so a pooled keep-alive socket the server is closing cannot be reused and read as ECONNRESET. Two named mechanisms are removed; the cause of every recorded failure is not proven. No assertion changed.

**#2046.** `docs/session-finalize.md` now says finalize makes no git *write*: its strict check fetches and prunes. The v5.30 status row for #2027 gives its exact head, `2074e241` (PR #2043). FEATURES.md and the CHANGELOG `[Unreleased]` correction ride W17-REC.

**Guides.** Under Charter v2.46 and v2.47, `data/shared-docs-guide.md` and `docs/user-guide.md` now say a lock's `sessionId` and `projectName` must be the caller's own verified values and give the `ttlMinutes` range, and the tracked `CLAUDE.md` block is regenerated from the guide by `node scripts/sync-claude-md-block.js --write` (inside the markers only), so the guide note that round 1's R-3 routed to PM triage was done in this chunk instead.

**Critic.** Cumulative review, 0 blocking.

**rev-20261018T130705Z-79e55f32** — 2026-10-18T13:08:24Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | Stale suite evidence: the full suite runs once on the final head in the Integrator's suite slot (rule 264.4) and is recorded then; no slot was granted at review time. (Re-recorded: an earlier record put the change-log reason on this finding by an array-index slip.) |
| R-2 | warning | accepted | Missing change-log entry: the Integrator serializes .prawduct/change-log.md prepends; the slot was granted 13:12Z and the entry is prepended in this chunk's final head. (Re-recorded: an earlier record put the guide-text reason on this finding by an array-index slip.) |
| R-3 | note | accepted | Both files sit outside the chartered 12-file lock (the CLAUDE.md block is generated from data/shared-docs-guide.md; docs/user-guide.md is unlocked). Routed to PM triage as plan open item R-1, widened to name docs/user-guide.md and the tc whoami Session id pointer. |

**3 findings** (2 warning, 1 note) — accepted: 3.

## 2026-10-18 — #1903 Chunk 07, #1399: ten more lift copies use the shared helper, and POSIX single-quote escaping has one owner

<!-- prawduct: type=refactor | scope=w17-a1-lift-chunk07-shell-word-owner -->

v5.34.0 Wave 17 chunk W17-A1, chunk 1 of 1. Branch `fix/1399-1903-w17-a1` from `origin/main` `6ae92519`. Refs #1903 (Chunk 07); closes #1399. Plan: `.tangleclaw/plans/w17-a1-lift-chunk07-shell-word-owner-1903-1399.md` (rev2 sha256 `332d7ed0…2643`, INT `ba039eef`, Architect A301/A304); charter v2.45 (sha256 `d37c50a6…c65a`), 25-file lock.

**#1399.** `lib/shell-word.js` `shellWord` is the only implementation of the `'` → `'\''` escape under `lib/`. `tmux._escapeArg`, `openclaw-approve`'s `shellQuote`, the lint wrap step's `_shellQuote` and `bridge-handoff`'s private `_shellQuote` are aliases of it (`const x = shellWord;`), keeping every identifier, call site and export; `control-hooks` writes the generated hook's `node -e` argument with `shellWord(check)`. `lib/git.js` had no copy left. A scratch capture of every quoter and both generated dispatcher scripts over an 18-value corpus printed the same bytes on base and branch, except that the lint quoter now quotes a non-string where it threw (its only caller passes file names). A guard in `test/engines-hook-shell-safety.test.js` fails, naming the file, if the escape construct appears in any other `lib/` file, and identity cases pin each exported alias to `shellWord`, which catches a re-implementation the source guard cannot see.

**#1903 Chunk 07.** Ten test files drop their private brace-matching lift copies for `test/helpers/lift.js`; `session-header-cleanup` spells out its two `async function` declarations so the lifted text keeps its `async`. A `node --require` capture logged the same 452 lifts, byte for byte, on base and branch, and every file's test count is unchanged. `INITIAL_INVENTORY` goes from 46 to 36.

## 2026-10-18 — W16-REC: combined records for the Wave 16 source merges

<!-- prawduct: type=chore | scope=w16-rec-records -->

v5.34.0 records chunk W16-REC, Charter v2.43, from merged main `96bdccfa`. W16-B1 PR #2491 merged as `faa7557b` (closes #2290, #2484, #2485); W16-A1 PR #2490 merged as `96bdccfa` (closes #1351, refs #1903 Chunk 06 and #2145 item 3). #1903 remains open with 46 private lifters; #2145 and #2489 remain open. The source entries below are preserved verbatim, including B's point-in-time pre-suite sentence; B's full suite subsequently passed 21,746/21,747, and A's same-head retry passed 21,754/21,755 after an unrelated bridge-gateway reset tracked in #2184.

**What changed.** `CHANGELOG.md` adds two Fixed and three Internal entries, each below 400 UTF-8 bytes, and removes the now-stale #2484- and #2485-open claims from earlier entries. `FEATURES.md` updates the directory scanner, shared-doc lock, launch response, Bridge test and lift-helper descriptions with stable source pointers. `prawduct-hook archive-change-log --apply` moved 11 older shipped entries verbatim into the October archive, leaving five recent entries and one pinned historical entry live; a repeat dry run moves zero. `[Unreleased]` is 16,425 bytes, below 90,000. These records do not bump a version, release, tag or deploy.

## 2026-10-18 — #1903 Chunk 06, #1351: ten more lift copies use the shared helper, and the Full Disk Access remedy has one owner

<!-- prawduct: type=refactor | scope=w16-a1-lift-chunk06-fda-remedy -->

v5.34.0 Wave 16 chunk W16-A1, chunk 1 of 1. Branch `fix/1351-1903-w16-a1` from `origin/main` `0d33fab9`. Refs #1903 (Chunk 06); closes #1351. Plan: `.tangleclaw/plans/w16-a1-lift-chunk06-fda-remedy-1903-1351.md` (rev1 sha256 `7e45a67d…2005`, INT `43d8ca76`, Architect A289); charter v2.43 (sha256 `21ebf9cc…f42340e`, Architect A292), 20-file lock.

**#1351.** `lib/dir-scanner.js` owns `fullDiskAccessHint(err, instead)` beside `failureCode`: only `tcTimedOut` earns the sentence, and the caller supplies only its action phrase ("choose a projects directory" in `lib/projects.js`, "move the project" in `lib/project-facts.js` and `lib/uploads.js`). `uploads.js#_hintFor` is gone; `_scanFailureHint` stays as a one-line delegate that keeps returning `undefined` on a miss. A scratch run of the three callers over eight error shapes printed the same hint before and after for every shape except `tcCached` alone through `project-facts`, which no longer earns it; the scanner never sets `tcCached` without `tcTimedOut`. The setup wizard's fixture is built from `_scanFailureHint` instead of a hand-kept copy, same bytes.

**#1903 Chunk 06.** Ten test files drop their private brace matcher for `liftDeclaration` or `liftBody` from `test/helpers/lift.js`, and their ten `INITIAL_INVENTORY` entries go with them (56 → 46). A runtime capture logged the same lifted text for every call before and after, and the same closing-brace index in `openclaw-cache`, which now also asserts that index lands on the brace (an off-by-one either way was green before). Apart from that one added assertion, no assertion, test name or test count changed in the ten files; four copies that previously searched from index 0, sliced to `-1` or returned `''` on a miss now fail with the helper's message, which only an already-broken test sees.

## 2026-10-18 — #2290, #2484, #2485: only the holder or the operator releases a shared-doc lock, both launch 201s carry the same keys, and a Bridge-absent toggle test that no network can flip

<!-- prawduct: type=bugfix | scope=w16b1-doc-lock-holder-webui-201-bridge-seam -->

v5.34.0 Wave 16 chunk W16-B1, chunk 1 of 1. Branch `fix/w16b1-doc-lock-holder-webui-201-bridge-seam` from `origin/main` `0d33fab9`. Closes #2290, #2484, #2485. Plan: `.tangleclaw/plans/build-plan-w16b1-doc-lock-holder-webui-201-bridge-seam.md` (rev1 sha256 `b5583901…c739`, INT `ae55b3a1`, Architect A290); charter v2.43 (sha256 `21ebf9cc…340e`), 10-file lock, of which `docs/engine-guide.md` and `test/master-launch-mode.test.js` are unchanged.

**#2290.** `DELETE /api/shared-docs/:id/lock` let any member session in the group drop any lock. A member session now releases only a lock it holds, judged by the session its launch binding verified, because the lock route records a body-supplied session id. New `documentLocks.releaseHeld` does the holder-or-expired check and the delete in one statement. Another member gets `409 NOT_LOCK_HOLDER`, the code the attest route already uses, with `holder: {sessionId, project, lockedAt, expiresAt}`, and the lock stays. The operator still releases any lock; an expired or absent lock answers `200`; a session's locks are still all released when it ends. The body-trusted `sessionId` on the lock route is #2489.

**#2484.** The web UI launch `201` now carries `launchMode`, the mode its session row records (the requested one only when the ClawBridge pre-create succeeded), and `isolationOverride: null`, because no engine starts on this host. A key-parity case gives the web UI `201` exactly the tmux `201`'s keys, so a key added to one branch alone fails. `docs/configuration-reference.md` documents both keys and the release rule.

**#2485.** The Bridge-absent toggle test pointed the probe at a port pair it had released, which a parallel run could reuse, and a probe deadline missed under load reads `BRIDGE_UNKNOWN`. The probe now runs the real classifier through transports that refuse at once; a second case with transports that answer healthy gets `BRIDGE_OK`, so the verdict comes from the supplied probe. The five original assertions are unchanged. The port pair now only gives the started listener somewhere other than a real Bridge to dial. The recorded failure's own cause stays unknown; its junit was not kept.

**Evidence.** Each new #2290 and #2484 case was red on base `server.js` and green after. Narrow runs: store, route and neighbouring shared-doc suites 104/104; launch `201` and neighbours 129/129; `api-medusa` 207/207; suites that read the configuration reference 136/136. The absent case passed 3 of 3 with ten CPU burners on ten cores. Critic `rev-20261018T101931Z-fff508ba`: 0 blocking. Full suite owed in INT's slot.

## 2026-10-18 — W15-REC: combined records for the Wave 15 source merges

<!-- prawduct: type=chore | scope=w15-rec-records -->

v5.34.0 records chunk W15-REC, Charter v2.40, from merged main `9539ba52`. PR #2486 merged `cec4a9e8` (Refs #1903 Chunk 05, Closes #1219); PR #2487 merged `9539ba52` (Closes #2481, #2171, #1777). #1903 remains open with 56 private lifters; #2484 and #2485 remain open.

**What changed.** `CHANGELOG.md` adds two Fixed and three Internal bullets, each under 400 UTF-8 bytes. `FEATURES.md` updates existing references for the launch `201`, fleet runbook, pane test and executed wrap tests. Both source change-log entries remain intact and appear once. `[Unreleased]` totals 15,507 bytes, below 90,000. The archive-hook result and focused records tests are recorded in this PR. No version bump, release, tag or deploy.

## 2026-10-18 — #2481, #2171, #1777: a pane-identity test that reads a slow stub, privateTempRoot on every launch 201, and a release-owner check a pane can pass

<!-- prawduct: type=bugfix | scope=w15b1-pane-stub-temp-root-release-owner -->

v5.34.0 Wave 15 chunk W15-B1, chunk 1 of 1. Branch `fix/w15b1-pane-stub-temp-root-release-owner` from `origin/main` `5a359d2c`. Closes #2481, #2171, #1777. Plan: `.tangleclaw/plans/build-plan-w15b1-pane-stub-temp-root-release-owner.md` (rev3 sha256 `ec71421f…a412`, frozen; INT and Architect A279c); charter v2.40 (sha256 `75f1f861…c601`), 8-file lock, of which `lib/tc-verbs.js` is unchanged.

**What changed.** `test/tc-pane-identity.test.js` preloads a shim into each spawned `bin/tc` that gives `tmux` a finite 30 s instead of the product's 1 s, so a stub slowed by a loaded runner is read rather than given up on; a new case with a 1.5 s stub still refuses with `PANE_IDENTITY_MISMATCH`. The product's 1 s give-up and every existing assertion are unchanged. `server.js` adds `privateTempRoot: null` to the web UI launch `201`, which starts no engine on this host; `docs/engine-guide.md` and `docs/configuration-reference.md` say the key is on every launch `201`. New `test/private-temp-root.test.js` checks both `201`s on a real socket with operator headers. `isolationOverride` and `launchMode` parity on that `201` are left to #2484. Step 10a of `docs/runbooks/stand-up-a-new-agent-fleet.md` now checks each member's own `releaseMode` from its own pane (`SELF_OK owner|off`, `SELF_WRONG`), names the rows it cannot read, and rolls the group up from every member's line; an optional one-step check runs only from a verified Project Master pane and stops with `MASTER_NOT_VERIFIED` on any restricted row. The known-defect note is gone.

**Evidence.** Each fix was red first (exit 0 where 2 was expected; the web UI key absent). After: `tc-pane-identity` 115/115 and 3/3 runs under CPU load, `private-temp-root` 2/2, `api-stranded-wraps` 41/41, `sessions-webui` 31/31. The runbook script printed `SELF TC-Lane-B: off` and `SELF_OK off` live from this pane and gave the documented line on eight fixtures. Not covered: a live roll-up across other members' panes or a Master pane.

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
