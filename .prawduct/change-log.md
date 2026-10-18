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

## 2026-10-18 — #2489, #2184, #2046: a member's shared-doc lock is taken in its verified name with a bounded ttl, the bridge-gateway tests stop racing their clock and sockets, and the finalize docs say what shipped

<!-- prawduct: type=bugfix | scope=w17b1-lock-caller-binding-gateway-determinism-finalize-docs -->

v5.34.0 Wave 17 chunk W17-B1, chunk 1 of 1. Branch `fix/w17b1-lock-caller-binding-gateway-determinism-finalize-docs` from `origin/main` `6ae92519`. Closes #2489, #2184, #2046. Plan: `.tangleclaw/plans/build-plan-w17b1-lock-caller-binding-gateway-determinism-finalize-docs.md` (rev2 sha256 `4796821b…61a1`, Architect A302/A304, INT `006884ff`); Charter v2.45 (sha256 `d37c50a6…c65a`), 12-file lock, 10 changed.

**#2489.** `POST /api/shared-docs/:id/lock` used to record whatever `sessionId` and `projectName` its body named. It now treats them as a member's claim and checks it against the launch binding: a mismatch is `403 LOCK_CALLER_MISMATCH` and nothing is written; a match records the verified session and project. The operator still names any session. `ttlMinutes` must be a whole number from 1 to 120 for every HTTP caller (`400 BAD_REQUEST`), and defaults to 30 when omitted. `documentLocks.acquire` is unchanged and still takes any ttl, which a new store test pins. The attest-route test that planted a foreign lock over HTTP now seeds it in the store; its assertions are unchanged. The `attestLockRefusal` JSDoc and the DELETE route comment no longer say every lock records the body's session.

**#2184.** The expiry test's "one millisecond inside" check anchored its clock to the newest question in the database, which a question an earlier test asked under a moved clock can become on a slow host. That would push the anchor past this question's real deadline. The test now anchors its three clock moves to its own route's question (`questionLater`). The fetch helpers in `test/api-bridge-gateway.test.js` and `test/api-bridge.test.js` send `connection: close`, so a pooled keep-alive socket the server is closing cannot be reused and read as ECONNRESET. Two named mechanisms are removed; the cause of every recorded failure is not proven. No assertion changed.

**#2046.** `docs/session-finalize.md` now says finalize makes no git *write*: its strict check fetches and prunes. The v5.30 status row for #2027 gives its exact head, `2074e241` (PR #2043). FEATURES.md and the CHANGELOG `[Unreleased]` correction ride W17-REC.

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
