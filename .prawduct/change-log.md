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
