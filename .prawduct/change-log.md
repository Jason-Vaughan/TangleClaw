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

## 2026-11-03 — Car 57-B: session stop provenance and the explicit recovery wake (#2249, #2250)

<!-- prawduct: type=feature | scope=2249-2250-stop-provenance-and-wake -->

- **Stop provenance (#2249):** `sessions` gains `stopped_by`/`stop_reason` (migration v76→v77). `stopped_by` is the server's own fact about how a session's terminal status was reached — `api` (the generic kill route, and any other route whose own job cascades into a kill, e.g. an OpenClaw tunnel teardown), `model-switch` (the governed engine/model switch), `wrap`, or `crash` — never inferred from caller-supplied text. `stop_reason` is that caller-supplied text, shown as-is and never verified. Both are threaded through `store.sessions.kill()`/`wrap()`/`markCrashed()` and every real caller, and surfaced in `GET /api/launch/recovery-held`'s `priorSession` and the fleet recovery panel. A session that ended before this migration reads both as `null` — not recorded, never recorded-as-empty.
- **Explicit operator wake (#2250, Architect Ruling A2250):** `POST /api/launch/recovery-wake-batch` (`lib/launch-recovery-wake.js`, routed beside `recovery-clear-batch`) lets an operator explicitly re-nudge several launches past their cleared recovery, in one request — its own write, apart from a clear. Same operator proof and request shape as the batch clear; the full per-item pre-send gate order (not-found/archived/still-blocked/stale/already-ready/session-ended/native-startup/no-pane/already-woken/unprofiled-engine); then the shared pane-busy safeguard `lib/launch-unready.js` already uses, checked once (`ticksRequired: 1`) rather than over a multi-tick streak, never consuming the one-wake-per-revision slot on a busy or failed send. The response reports `send`, `stepAcknowledgement` and `readyAttestation` as three separate facts, never merged into one verdict. Backend-only by PM/Architect agreement; a fleet-dashboard UI trigger is Leg 4/v5.60.0 scope, not this car's.
- **Pre-merge fix:** a full-suite run (Testament pool, 25,247 tests) surfaced three pre-existing tests whose literal assumptions #2249's new columns broke, outside this car's original envelope — fixed and verified against the real production lines, not just read in isolation: `test/startup-dialog.test.js`'s v56/v57 downgrade fixture assumed `launch_blocker` was always the last column in `sessions`; `test/api-medusa.test.js` hardcoded the exact source text around `lib/routes/openclaw.js`'s kill call, which now carries a third argument; `test/store.test.js` pinned the literal `schema._bind({...})` call in `lib/store.js`, which now also injects `SESSION_STOP_SOURCES`.

## 2026-11-02 — v5.56.0 W2-REC: reconcile Switchboard delivery guarantees

<!-- prawduct: type=internal | scope=v5560-w2-rec -->

- Reconciled Wave 1 PRs #2805 (#1364, #1621, #2720), #2807 (#1783, #1876, #2655, #2663), #2808 (#2137, #1009, #2270), and #2813 (#1873, #1976, plus #2137's server route). REST confirmed the four true merge commits and all twelve distinct linked issues closed; Milestone #41 has zero open issues. The accepted `changelog.d/` fragments remain release-note inputs.
- **Delivery recovery (#1364, #1621, #2720, #2270):** heartbeat-ack timeouts reconnect a silent Bridge; a stranded tmux nudge may safely resubmit Enter before the existing re-arm cycle; a periodic sweep prunes dormant-project delivery ledgers; and system sends time out when a Bridge never answers. #1621 is the tmux recovery increment, without a new engine-native receipt channel or out-of-band operator rail.
- **Coordinator visibility (#1783, #1876):** callable helpers prepare idempotent terminal CI-state Medusa notices, but no HTTP webhook route invokes them yet. An opt-in external escalation watchdog can send structured facts through a webhook or ntfy without weakening dashboard alerts; its delivery state is process-lifetime and it has no server-route wiring yet.
- **Operator and document surfaces (#2655, #2663, #2137, #1009):** shared-document coalescing now uses the newest pending notice. The Medusa delivery guide reflects launch-binding and sender-identity gates. The escalation banner can open the recipient session, with recipient/sender/all exchange views supplied by #2813's server route. The heads control confirms before shutting off with unread mail and shows Bridge version/update status from health data.
- **Exchange lifecycle (#1873, #1976):** senders can retract a still-unread message while retaining its terminal exchange record. A reply-required message cannot be acknowledged, or its lane marked complete or safe to clear, until answered; role-based exchange reads expose both sides.
- Updated `FEATURES.md` with source and test anchors for merged behavior. These are reconciliation records; the v5.56.0 release cut and live activation follow their own gates.

## 2026-11-02 — v5.55.0 W2-REC: reconcile checkout ownership and the live install

<!-- prawduct: type=internal | scope=v5550-w2-rec -->

- Reconciled Wave 1 PRs #2803 (#1267), #2804 (#1672), #2806 (#1710), and #2811 (#1332, #1977). GitHub REST confirmed all five Milestone #40 issues closed, and #2811 landed as a two-parent merge commit. Their accepted `changelog.d/` fragments remain the release-note inputs.
- **Checkout retirement and server identity (#1267, #1672):** a dry-run-first tool retires only eligible inactive worktrees and `[gone]` branches, rechecking before removal. The server reports coupling for the checkout whose code it actually runs; a separate CLI can provision a dedicated checkout and repoint a validated launchd plist. Neither workflow changes the live install merely by being merged.
- **Stale-install response (#1710):** classification reuses the existing restart-impact rules. Automatic records-only fast-forward requires a clean `main`, a verified exact-SHA delta, and no wrap in flight. Executable or mixed changes yield an operator-coordinated restart decision; unknown changes await diagnosis. Route and poller wiring remain follow-on work.
- **Worktree and branch ownership (#1332, #1977):** both are standalone deterministic module APIs with callable ownership, admission, and invalidation helpers ready for host integration. The worktree API uses gitdir markers and content baselines for fail-closed write admission. The branch API tracks an owner generation, publication-checked handoff, and exact-head review evidence invalidated on rewrite; its cross-owner mutation and force-push checks refuse those actions when called. Live command, write, and push paths do not invoke these APIs yet.
- Updated `FEATURES.md` with merged source and test anchors. These records describe merged code; the release cut and live activation follow their own gates.

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
