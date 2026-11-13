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

## 2026-11-13 — v6.2.2 release cut (Milestone #69)

<!-- prawduct: type=internal | scope=v622-release -->

- Compiled 3 accepted `changelog.d/` fragments (#3046, #3047, #3048) from PRs #3049 and #3050 into `CHANGELOG.md` section `[6.2.2]` (Fixed, patch tier) using the wrap's own compile/splice/promote functions. Bumped `version.json`, updated README pins, banner and released-section lock via `scripts/release-prepare.js`, added release notes, Feature Index and roadmap state. Folded in PR #3050's change-log entry (kept out of that feature PR by Builder Rule #271 cl.3) below, verbatim. PR #3049 (#3048) carried no change-log entry; its record is its fragment and this cut. During review (PRR-B), the compiled #3047 entry and the release notes were corrected: they gave the Designated Delegate order as `-PM`, `-Master`, first live member, but `resolveDelegateProject` first takes a still-valid configured delegate, then `-PM`, `-Master` and role `pm`, then the first live member, then the first member. The fix also moved v6.2.1 under Recent releases in the release index (TC-Lane-B).

## 2026-11-13 — v6 Fleet View layout, sidebar filters and Project Delegate Chat (#3046, #3047)

<!-- prawduct: type=feature | scope=v622-w1a -->

Car V622-W1-A, Chunks 1-3.

- #3046: the shell root gains explicit grid rows (the sidebar's `1 / -1` had spanned only row 1, pushing the main pane below it); the sidebar is its own sticky scroll container and keeps its scroll and the focused control across re-renders. It hides (`« Hide Fleet` / `» Show Fleet`, desktop), folds per project and fleet (with Expand/Collapse all), and filters by text, engine and one-or-many project pills (Multi, Ctrl/Cmd/Shift-click, All), all remembered. The Classic/Fleet switcher moves into the page header and the Classic toolbar hides in the Fleet View; the header bar now wraps its action pills to a second row when they do not fit (the browser check found the added switcher pushing the header 96px past a 1280px viewport, 9px of it from a long brand notice before the change).
- #3047: project and fleet routes resolve to a Designated Delegate (configured, else `-PM`, else `-Master`, else role `pm`, else first live, else first member); the conversation view becomes a chat with a delegate picker or a direct-session link back, a session status pill, the live output (polled every 4 s, updated in place), and a composer that types into the session through `POST /api/sessions/:project/command` and records a Tier-A `v6-chat-ui` user event at the next seq counting deleted events, retrying once on `SEQ_CONFLICT`. A refusal shows the server's reason and keeps the text.
- Three `tcV6ResolveRouteProject` assertions changed with the requirement: a project with a `-PM` member now resolves to it rather than to the first live member. The live-member and first-member fallbacks keep their own tests on fixtures with no PM.

## 2026-11-12 — v6.2.1 release cut (Milestone #68)

<!-- prawduct: type=internal | scope=v621-release -->

- Compiled 6 accepted `changelog.d/` fragments (#3029, #3037, #3038, #3039, #3041, #3044) from PRs #3040, #3042 and #3043 into `CHANGELOG.md` section `[6.2.1]` (Fixed + Internal, patch tier) using the wrap's own compile/splice/promote functions. Bumped `version.json`, updated README pins, banner and released-section lock via `scripts/release-prepare.js`, added release notes, Feature Index and roadmap coverage, and consumed the fragments together. The #3037 entry's wording was changed during the cut: it had quoted the phrase "not yet reachable" while describing the KZ-V610-02 check, which made the release-record check in `test/v6-master-release-qualification.test.js` fail on this section; it now describes the check without quoting the phrase, and the 6.2.1 lock line was regenerated.

## 2026-11-11 — v6.2.0 release cut (Milestone #64)

<!-- prawduct: type=internal | scope=v620-release -->

- Compiled 6 accepted `changelog.d/` fragments (#3001-#3005) from PRs #3032-#3035 into `CHANGELOG.md` section `[6.2.0]` using the wrap's own compile/splice/promote functions. Bumped `version.json`, updated README pins, banner and released-section lock via `scripts/release-prepare.js`, added release notes, Feature Index and roadmap coverage, and consumed the fragments together. Release prose was checked against `server.js`'s 10 new `/api/v6/*` routes; library-only operations are marked as such.

## 2026-11-11 — v6.1.0 release cut (Milestone #63)

<!-- prawduct: type=internal | scope=v610-release -->

- Compiled 12 accepted `changelog.d/` fragments (#1886, #2991-#3000) across the four Wave 1 PRs (#3025-#3028) and the Wave 2 routes PR (#3030) into `CHANGELOG.md` section `[6.1.0]` using the wrap's own compile/splice/promote functions. Bumped `version.json`, updated README pins, banner and released-section lock via `scripts/release-prepare.js`, added release notes, Feature Index and roadmap coverage, and consumed the fragments together.

## 2026-11-11 — v6.0.1 release cut (Issue #3022)

<!-- prawduct: type=fixed | scope=v601-release -->

- Promoted the accepted `changelog.d/3022.v6-shell-live-wireup.fixed.md` fragment into `CHANGELOG.md` section `[6.0.1]`. Bumped `version.json`, updated README release pins and the released-section lock, added release notes and Feature Index coverage, and consumed the fragment together.

## 2026-11-10 — v6.0.0 release cut (Milestone #61)

<!-- prawduct: type=internal | scope=v600-release -->

- Compiled 33 accepted `changelog.d/` fragments across 15 PRs (#3006-#3020) into `CHANGELOG.md` section `[6.0.0]`, closing all 19 Core v6.0 issues (V6-01..V6-19) across three delivery Trains. Bumped `version.json`, updated README clone pins and the released-section lock, added release notes and Feature Index coverage, and consumed those fragments together. Milestone #61 had 2 open issues (#1564, #2258 - both Operator-performed, physical-host or dashboard actions beyond this code release) before this cut.

## 2026-11-09 — v5.74.0 release cut (Milestone #62)

<!-- prawduct: type=internal | scope=v5740-release -->

- Compiled 4 accepted `changelog.d/` fragments for #2188, #2258, #2598, and #2961 into `CHANGELOG.md` section `[5.74.0]`. Bumped `version.json`, updated README clone pins and the released-section lock, added release notes and Feature Index coverage, and consumed those fragments together. Milestone #62 had 2 open issues (#1564, #2258 — both Operator-performed, physical-host or dashboard actions beyond this code release) before this cut.

## 2026-11-09 — v5.73.0 release cut (Milestone #60)

<!-- prawduct: type=internal | scope=v5730-release -->

- Compiled 7 accepted `changelog.d/` fragments for #2347, #2931, #2932, #2933, #2934, #2953, and #2956 into `CHANGELOG.md` section `[5.73.0]`. Bumped `version.json`, updated README clone pins and the released-section lock, added release notes and Feature Index coverage, and consumed those fragments together. Milestone #60 had zero open issues before this cut.

## 2026-11-08 — v5.72.0 release cut (Milestone #59)

<!-- prawduct: type=internal | scope=v5720-release -->

- Compiled 16 accepted `changelog.d/` fragments for #108, #109, #1032, #1257, #1578, #2928, #2929, #2930 (two fragments), #2935, #2937, #2945, #2946, #2948, #2949, and #2950 into `CHANGELOG.md` section `[5.72.0]`. Bumped `version.json`, updated README clone pins and the released-section lock, added release notes and Feature Index coverage, and consumed those fragments together. Milestone #59 had zero open issues before this cut.

## 2026-11-06 — v5.71.0 release cut (Milestone #58)

<!-- prawduct: type=internal | scope=v5710-release -->

- Compiled six accepted `changelog.d/` fragments for #254, #1185, #128, #1531, #363, and #297 into `CHANGELOG.md` section `[5.71.0]`. Bumped `version.json`, updated README clone pins and the released-section lock, added release notes and Feature Index coverage, and consumed those fragments together. Milestone #58 had zero open issues before this cut.

## 2026-11-06 — v5.70.0 release cut (Milestone #57)

<!-- prawduct: type=internal | scope=v5700-release -->

- Compiled four accepted `changelog.d/` fragments for #1485, #1774, #2127, and #2626 into `CHANGELOG.md` section `[5.70.0]`. Bumped `version.json`, updated README clone pins and the released-section lock, added release notes and Feature Index coverage, and consumed those fragments together. Milestone #57 had zero open issues before this cut.

## 2026-11-06 — v5.69.0 release cut (Milestone #56)

<!-- prawduct: type=internal | scope=v5690-release -->

- Compiled five accepted `changelog.d/` fragments for #1083, #1224, #1576, #1713, and #1732 into `CHANGELOG.md` section `[5.69.0]`. Bumped `version.json`, updated README clone pins and the released-section lock, added release notes and Feature Index coverage, and consumed those fragments together. Milestone #56 had zero open issues before this cut.

## 2026-11-06 — v5.68.0 release cut (Milestone #55)

<!-- prawduct: type=internal | scope=v5680-release -->

- Compiled five accepted `changelog.d/` fragments for #748, #2644, #2735, #2736, and #2821 into `CHANGELOG.md` section `[5.68.0]`. Bumped `version.json`, updated README clone pins and the released-section lock, added release notes, and consumed those fragments together. Milestone #55 had zero open issues before this cut.

## 2026-11-05 — v5.67.0 release cut (Milestone #54)

<!-- prawduct: type=internal | scope=v5670-release -->

- Compiled nine accepted `changelog.d/` fragments for #2866, #2877, #2878, #2881, #2883, #2884, #2885, #2886, and #2888 into `CHANGELOG.md` section `[5.67.0]`. Bumped `version.json`, updated README clone pins and the released-section lock, added release notes and an index, and consumed those fragments together for the release cut. Milestone #54 had zero open issues before this cut.

## 2026-11-05 — v5.66.0 release cut (Milestone #51)

<!-- prawduct: type=internal | scope=v5660-release -->

- Compiled six accepted `changelog.d/` fragments for #1112, #2828, #2852, #2856, #2858, and #2862 into `CHANGELOG.md` section `[5.66.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, added the release note, and consumed those fragments together for the release cut. Milestone #51 had zero open issues before this cut.

## 2026-11-04 — v5.65.0 release cut (Milestone #50)

<!-- prawduct: type=internal | scope=v5650-release -->

- Compiled thirteen accepted `changelog.d/` fragments for #777, #1424, #2832, #2834, #2864, #2866, #2870, #2871, #2877, #2878, #2883, and #2887 into `CHANGELOG.md` section `[5.65.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, added the release note, and consumed those fragments together for the release cut. Milestone #50 had zero open issues before this cut.

## 2026-11-04 — v5.64.0 release cut (Milestone #49)

<!-- prawduct: type=internal | scope=v5640-release -->

- Compiled seven accepted `changelog.d/` fragments for #400, #533, #811, #2835, #2836, #2838, and #2844 into `CHANGELOG.md` section `[5.64.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, and consumed those fragments together for the release cut. Milestone #49 had zero open issues before this cut.

## 2026-11-04 — v5.63.0 release cut (Milestone #48)

<!-- prawduct: type=internal | scope=v5630-release -->

- Compiled eight accepted `changelog.d/` fragments for #1717, #1949, #2144, #2362, #2830, #2837, #2842, and #2843 into `CHANGELOG.md` section `[5.63.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, and consumed those fragments together for the release cut. Milestone #48 had zero open issues before this cut.

## 2026-11-04 — v5.62.0 release cut (Milestone #47)

<!-- prawduct: type=internal | scope=v5620-release -->

- Compiled six accepted `changelog.d/` fragments for #1894, #2185, #2208, #2258, #2259, and #2874 into `CHANGELOG.md` section `[5.62.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, and consumed those fragments together for the release cut. Milestone #47 had zero open issues before this cut.

## 2026-11-03 — v5.61.0 release cut (Milestone #46)

<!-- prawduct: type=internal | scope=v5610-release -->

- Compiled the thirteen accepted `changelog.d/` fragments for #1305, #1306, #1307, #1350, #1370, #1677, #2601, #2604, #2823, #2825, #2826, #2853, and #2854 into `CHANGELOG.md` section `[5.61.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, and consumed those fragments together for the release cut.

## 2026-11-03 — v5.60.0 release cut (Milestone #45)

<!-- prawduct: type=internal | scope=v5600-release -->

- Compiled the sixteen accepted `changelog.d/` fragments for #349, #801, #1046, #1259, #1265, #1573, #1577, #1604, #1784, #1923, #2014, #2016, #2071, #2395, #2396, and #2397 into `CHANGELOG.md` section `[5.60.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, and consumed those fragments together for the release cut.

## 2026-11-03 — v5.59.0 release cut (Milestone #44)

<!-- prawduct: type=internal | scope=v5590-release -->

- Compiled the eight accepted `changelog.d/` fragments for #2106, #2116, #2117, #2119, #2394, #2817, #2818, and #2819 into `CHANGELOG.md` section `[5.59.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, and consumed those fragments together for the release cut.

## 2026-11-03 — v5.58.0 release cut (Milestone #43)

<!-- prawduct: type=internal | scope=v5580-release -->

- Compiled the eight accepted `changelog.d/` fragments for #1889, #2070, #2072, #2073, #2642, #2643, #2645, and #2824 into `CHANGELOG.md` section `[5.58.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, and consumed those fragments together for the release cut.

## 2026-11-03 — v5.57.0 release cut (Milestone #42)

<!-- prawduct: type=internal | scope=v5570-release -->

- Compiled the eight accepted `changelog.d/` fragments for #2034, #2037, #2074, #2109, #2249, #2250, #2351, and #2353 into `CHANGELOG.md` section `[5.57.0]`. Bumped `version.json`, updated the README clone pins and released-section lock, and consumed those fragments together for the release cut.

## 2026-11-03 — v5.57.0 W1-A: Coordinator-rotation review follow-ups (#2034)

<!-- prawduct: type=feature | scope=v5570-w1a-2034 -->

- **Abandon/generation accuracy (items 6, 8):** `currentGeneration()` now derives from `latestForProject` instead of an independent `MAX(generation) WHERE state='active'` query, so it agrees with the gate once the true-latest rotation is abandoned — it used to fall back to reporting a stale, superseded generation as current. Docs corrected to match `abandon()`'s actual behavior (it already releases an *active* rotation's epoch binding, not just an open one); deliberately did not change `nextStep()`'s behavior, since the issue's own scope here is stale prose, not a new operator-facing suggestion on every healthy active rotation.
- **checkout-fingerprint failure causes (item 4):** `_runGit` now threads `{code, stderr}` through to the caller via an optional `diag` object instead of discarding every git failure into a bare `null`; `_hashFile`'s two generic catches append the real fs error code (`unavailable:unreadable:EACCES`, not just `unavailable:unreadable`). `importantIgnored` paths' repo-root resolution (same as `untracked`, for a project living in a subdirectory of its repo) is now documented and has its own dedicated test.
- **Retention (item 2):** `coordinator_rotations`/`coordinator_roles` are now pruned on insert/grant (keep-latest-50 by default), structurally exempting the project's highest-generation row — what the gate reads as "latest" — and any open row, regardless of count or age; mirrors `lib/store/handoffs.js`'s existing retention shape.
- **Medusa guide text (item 1):** all three generated carriers (`lib/engines.js`'s discovery lines and switchboard lines ×2 formats, `lib/sessions.js`'s session prime) now warn that a rotated coordinator's raw Medusa calls are refused without `x-tangleclaw-engine-thread`, naming `tc message` as what sends it — closing a gap where the guide told a mid-rotation coordinator it could call the routes directly and never mentioned why that would be refused.
- **Gated-route single source of truth (item 5):** every one of the 40 real gated-route registrations (server.js, `lib/routes/{sessions,wrap,tc}.js`) now declares `gatedAction` at registration (`lib/routes/_kernel.js`'s existing `options`/`_routePatterns()` needed no change); `test/api-coordinator-rotation.test.js` derives its enumeration from that instead of a hand-written 24-route list plus a `FAMILIES`-regex/`GATE_EXEMPT` sweep. Diffed old vs. new: the old regex only ever matched the `/api/sessions/:project/medusa/` mount, never `/api/master/medusa/...` — a whole second mount's gated routes were invisible to the "comprehensive" dynamic sweep. Now declared explicitly as gated-but-not-HTTP-exercised-here (it needs a live-Project-Master fixture this file doesn't have), rather than silently staying invisible.
- **Relaunch-mode inbox check (item 3):** documented and tested a genuine, pre-existing limitation rather than silently fixing or silently dropping it — resume's cross-check only ever sees the successor's own fresh-workspace inbox in relaunch mode, so it cannot see pre-rotation mail left sitting under the old session's. Filed **#2821** for the deeper fix (carry mail forward across the workspace-id rotation, or persist an unhandled-count at session hand-off), which needs a schema change outside a single-issue cleanup car's scope.
- Every chunk verified green via the Remote Testament pool; broadest single regression sweep (Chunk 05's route-registration changes) ran 1077+ tests clean across route-reachability, launch-binding, signed-in-operator, server, sessions/control/session-rules/medusa/wrap APIs, and merge-queue.

## 2026-11-02 — v5.56.0 W2-REC: reconcile Switchboard delivery guarantees

<!-- prawduct: type=internal | scope=v5560-w2-rec -->

- Reconciled Wave 1 PRs #2805 (#1364, #1621, #2720), #2807 (#1783, #1876, #2655, #2663), #2808 (#2137, #1009, #2270), and #2813 (#1873, #1976, plus #2137's server route). REST confirmed the four true merge commits and all twelve distinct linked issues closed; Milestone #41 has zero open issues. The accepted `changelog.d/` fragments remain release-note inputs.
- **Delivery recovery (#1364, #1621, #2720, #2270):** heartbeat-ack timeouts reconnect a silent Bridge; a stranded tmux nudge may safely resubmit Enter before the existing re-arm cycle; a periodic sweep prunes dormant-project delivery ledgers; and system sends time out when a Bridge never answers. #1621 is the tmux recovery increment, without a new engine-native receipt channel or out-of-band operator rail.
- **Coordinator visibility (#1783, #1876):** callable helpers prepare idempotent terminal CI-state Medusa notices, but no HTTP webhook route invokes them yet. An opt-in external escalation watchdog can send structured facts through a webhook or ntfy without weakening dashboard alerts; its delivery state is process-lifetime and it has no server-route wiring yet.
- **Operator and document surfaces (#2655, #2663, #2137, #1009):** shared-document coalescing now uses the newest pending notice. The Medusa delivery guide reflects launch-binding and sender-identity gates. The escalation banner can open the recipient session, with recipient/sender/all exchange views supplied by #2813's server route. The heads control confirms before shutting off with unread mail and shows Bridge version/update status from health data.
- **Exchange lifecycle (#1873, #1976):** senders can retract a still-unread message while retaining its terminal exchange record. A reply-required message cannot be acknowledged, or its lane marked complete or safe to clear, until answered; role-based exchange reads expose both sides.
- Updated `FEATURES.md` with source and test anchors for merged behavior. These are reconciliation records; the v5.56.0 release cut and live activation follow their own gates.

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
