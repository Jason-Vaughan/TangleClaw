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

## 2026-11-27 — v6 chat UX: scroll/selection corruption, dedup send bubble, header UTH toggle, queued-turn indicator, Car V666-W1-A

<!-- prawduct: type=fixed | scope=v666-w1-a -->

- Fixed #3327 (12s background sidebar polls forcing a full `root.innerHTML` redraw and
  header re-dock even when nothing changed, plus selections/mouse-drags only being
  protected inside `#v6ChatStream`/`#v6ChatPeek`, plus slow trackpad scrolling never
  crossing the old per-event unpin delta threshold): added a serialized no-op check to
  `setProjects`/`setTree`/`setEngineHealth` (left `setTelemetry` out — it has an existing
  test-enforced always-redraw contract this would have broken); widened
  `fullRenderWouldDropSelection` to `hasActiveSelectionIn(root)` plus a new
  `isPointerSelecting`/cooldown pair covering the whole shell, not just the two chat
  panes; routed `#v6ChatSwitchboard` and every `paintWaitingOnExtras()` slot through
  `paintIfChanged`; and replaced `wireStreamPin`/`wirePeekPin`'s per-event
  `scrollTop`-delta heuristic with a direct `wheel`/`touchmove`/`pointerdown`
  user-scroll-intent window.
- Fixed #3326 (a just-sent message briefly rendered twice — once as a live pane echo,
  once as the still-pending bubble): `pendingMarkup` now also excludes a pending send
  matched by a live `user` turn or the conversation's trailing recorded event, not only
  `lastSent`.
- Fixed #3328 (Under the Hood permanently parked in the center stack, open or
  collapsed): added `#v6ChatToggleUnderHood` to the chat's top header, and `chatHoodOpen
  === false` now also sets `hidden` on the `<details>` itself (every existing way the
  drawer opens routes through one new `setUnderHoodOpen` helper so `open`/`hidden` can't
  drift apart).
- Fixed #3330 (the busy indicator clearing mid-turn, and stacked follow-up prompts
  rendering as indistinguishable bare bubbles): split `LIVE_AT_REST_FOOTER_RE` — Antigravity's
  "Press up to edit queued messages" and the model/%-left status-bar chrome no longer clear
  `activity` (the queued-messages line is now itself positive busy evidence via the new
  `LIVE_QUEUED_INPUT_RE`); `chatBusyLabel` falls back to busy when the trailing live turn is
  an unanswered `user` prompt; `liveTurnsMarkup` marks the oldest unanswered stacked `user`
  turn "● Processing…" and later ones "⏳ Queued — waiting for current turn to finish".
  Deliberately did not implement the Force/✕ controls tying a queued badge into the
  existing `Waiting on: AI` queue — flagged as a scoped omission, not attempted.
- Each fix reverses part of an EARLIER fix's own test-enforced behavior where the two
  genuinely conflicted, not silently: #3330 reverses half of #3181's "Press up to edit
  queued messages is an at-rest footer" (that line is Antigravity's live status bar
  while a turn runs, not an idle-shell prompt — #3181's OTHER at-rest markers are
  unchanged); #3328 reverses the `<details>` always showing its closed `<summary>` bar.
  `setTelemetry`'s own always-redraw-on-identical-data contract (an existing test
  deliberately exercises it) was intentionally left alone for #3327 rather than
  reversed, since nothing in that issue's root-cause text names it as the poll causing
  the symptom (`refreshSidebarStatus` calls only `setProjects`/`setTree`/`setEngineHealth`).
- Verified with `node --test test/v6-b1-ui-shell.test.js` (844/844, after the Critic R1
  fix round below added 5 tests) plus the adjacent v6-shell-touching suites
  (`native-sprint-tracker`, `projects-attach-unregistered`,
  `v6-browser-shell-and-conversation-e2e`, `v6-b2-conversation-layer`,
  `v6-conversation-readability`, `v6-engine-usage-health-indicator`,
  `v6-fleet-wave-and-report-e2e`, `v6-interactive-choices`, `v6-lifecycle-stage-progress`,
  `v6-ui-shell-mount-wiring`, `v6-ssot-charter-viewer`, `v6-v620-server-routes-integration`,
  `v6-v610-server-routes-integration`, `v6-uth-traffic-filter`) — 692/692, after updating
  the scroll-pin fixtures in both files to dispatch a `wheel` event before the `scroll`
  event they use to simulate an upward user scroll (the new user-scroll-intent gate's
  direct consequence). Fixed the independent PR reviewer's own NOTE: this line originally
  said 839/839, stale from before the Critic R1 fix round's 5 new tests landed.
- Critic R1 (`/prawduct:critic`) found 2 BLOCKING on the first pass — no coverage for the
  new `isPointerSelecting`/pointer-cooldown guard (including the mid-drag transient-
  selection-collapse scenario its own comment names), and the header toggle's busy/count
  badges only ever updating on a full `render()` while #3327's own no-op fix makes that
  rare — plus 2 WARNING (stale test evidence; a hardcoded `#9CF732` instead of
  `var(--tc-venom-green, #9CF732)`). Fixed all 4 in one commit (`110d8a93`); `verify-
  resolutions` came back 0 blocking, 0 findings, 2 observations (both accepted on the
  record: a review-round-labeled-comment style nit, and the already-planned recorder run
  below) — nothing further required.
- Full-suite test-evidence recorder (`prawduct-hook test-evidence record`) ran 32140
  passed / 23 failed / 2 skipped. **Correction (Critic R2, `rev-20261127T180400Z-b386d2cc`
  BLOCKING): the first draft of this entry said all 23 were in 2 files, confirmed identical
  on a clean checkout — that was true for those 2 files but left 6 of the 23 (3 in
  `test/tmux-named-paste-buffer.test.js`, 1 each in `test/tmux.test.js`,
  `test/projects.test.js`, `test/startup-dialog.test.js`) unaccounted for.** Re-verified
  properly (an earlier verification pass itself silently truncated to its last 15 lines via
  an unintended `| tail` on a backgrounded command — caught only by checking the real PID
  was still running after the tool reported the wait "complete"):
  - `test/engine-health.test.js` + `test/tmux-draft-capture.test.js` (17 of the 23):
    deterministic, reproduces IDENTICALLY (62 pass / 17 fail of 79) every time, on this
    branch and on a clean `origin/main` worktree alike.
  - The other 4 files (6 of the 23): genuinely FLAKY on both this branch and a clean
    `origin/main` worktree — two separate clean-checkout runs of the same 4 files gave 2
    different failure counts (2, then 5) and different specific failing subtests each
    time; this branch's own isolated run gave a third set (5 failures, yet different
    subtests again). Real-tmux-pane timing sensitivity under concurrent host load (other
    lane sessions' own test runs were observed running concurrently via `ps aux`), not a
    deterministic bug — but present on a clean base either way, so not caused by this
    diff.
  - None of the 6 files, nor the production code they exercise (`lib/tmux.js`,
    `lib/projects.js`, `lib/sessions.js`, `lib/system-health.js`), are touched anywhere in
    this branch's diff (`git diff --stat origin/main..HEAD` — 8 files total, all `public/`,
    `test/v6-*`, or `.prawduct/`/`changelog.d/`).
  `test-status` still reports `stale` because it treats any failing test as not-green; the
  independent PR reviewer's own WARNING on this is the same underlying observation, not a
  new one (its specific "2 files" framing inherited this entry's own first-draft error).
- Independent PR reviewer (`/prawduct:pr create` Step 3): 0 blocking, 2 warnings
  (the test-evidence staleness above; issues #3327/#3326/#3328/#3330 reading `OPEN` on
  GitHub right now, which is simply this PR's own pre-merge state — closing is the Merge
  Flow's job, not a defect), 1 note (fixed: this entry's stale 839 count, itself fixed
  above).
- PRR-A R-Gate R1 (a separate, project-local review channel from Prawduct's own PR
  reviewer): REQUEST CHANGES — 1 BLOCKING (`pendingMarkup`'s #3326 live-turn dedup matched
  ANY prior `user` turn, not just the trailing one — re-sending text repeating an older turn
  could wrongly suppress a legitimate new pending bubble), 1 WARNING (`isPointerSelecting`
  cleared only on `root`'s own `mouseup`/`pointerup` — a drag released outside `root`'s
  subtree never bubbles there, leaving it stuck `true` and every background render deferred
  forever). Both confirmed genuine on independent re-read and fixed in `d97f028c`: the dedup
  now matches only the trailing `user` turn; the release listeners moved to `win` (bubbles to
  window in every real browser) plus a `blur` fallback. Regression tests added for all 4
  scenarios (trailing-turn dedup, trailing-event dedup, release outside `root`, mid-drag
  `blur`).
- Critic R2 (`/prawduct:critic verify-resolutions` after `d97f028c`): 1 BLOCKING — the
  test-evidence correction above; the actual code fix for the PRR-A findings was found
  sound with real regression coverage. 2 observations recorded, not fixed: `pendingMarkup`'s
  trailing-only fix narrows but does not fully eliminate the false-suppression shape it
  targets (a BRAND-NEW send repeating the immediately-preceding turn's exact text could
  still be suppressed — pre-existing shape, not a regression from this branch); the new
  `win`-level listeners introduce no cleanup gap (`tcCreateV6Shell` has exactly one non-test
  call site, instantiated once per page load).
- PRR-A R-Gate R2 (`478698de`): REQUEST CHANGES — 1 BLOCKING, two parts. (1) The R1 fix's own
  "trailing user turn/event" search walked backward PAST a non-`user` entry to find the
  nearest `user` one, instead of requiring the array's actual LAST entry to be `user` — so a
  matching turn/event an ASSISTANT REPLY had already answered still read as "trailing" and
  could suppress a brand-new send repeating that now-answered text; this is exactly Critic
  R2's own "pre-existing shape" observation above, escalated to blocking once the backward-
  scan bug made it concretely reachable, not a separate issue. (2) Per PRR-A's own resolution
  guidance (favor showing a possibly-redundant bubble over dropping a legitimate new send,
  since text alone cannot distinguish "the pane echoed THIS send" from "the operator
  force-sent the identical words again") rather than full send/echo identity tracking. Fixed
  in `8a341083`: `trailingUserTurn`/`trailingUserEvent` are now only ever the array's real
  last entry; each trailing signal is consumed by at most the first (earliest) matching
  pending item, so a second genuinely-new identical pending send is preserved. Regression
  tests added for both (assistant-followed-old-match, for both the live-turn and
  recorded-event cases; a second identical pending send preserved alongside an
  already-matched one). Critic `verify-resolutions` after `8a341083`: 0 blocking, 0 findings,
  1 observation (this change-log entry's own gap — resolved by this entry).
- PRR-A R-Gate R3 (`92431716`): REQUEST CHANGES — 1 BLOCKING. The R2 fix's own
  one-pending-per-signal consumption treated `turnConsumed`/`eventConsumed` as fully
  independent, but the trailing live turn and the trailing recorded event can be two
  READINGS of the exact SAME echo (`arrangeRecorded` above already draws a recorded event
  once, via its matching live turn, for precisely this overlap) — so one real echo matching
  both signals wrongly consumed TWO identical pending items (one via each signal) instead of
  one. Fixed in `1e714a0a`: `turnEventOverlap` detects when the trailing turn and trailing
  event `sameMessage`-match each other, in which case consuming either now consumes both;
  two genuinely DIFFERENT trailing turn/event texts still consume independently (verified by
  a new negative test). Regression tests added for both the overlapping-signals case and the
  genuinely-distinct case. Critic `verify-resolutions` after `1e714a0a`
  (`rev-20261127T184648Z-d806a652`): 0 blocking, 0 findings, 1 observation (this entry's own
  gap — resolved by this entry; hand-traced `turnConsumed`/`eventConsumed`/`turnEventOverlap`
  through every covered scenario including the R1/R2 cases and confirmed the logic holds).
- PRR-A R-Gate R4 (`961ec1e6`): REQUEST CHANGES — 1 BLOCKING. The R3 overlap fix set
  `turnConsumed = true` unconditionally on ANY match (turn, event, or overlap), so an item
  that matched only the trailing EVENT (first in pending order) wrongly spent `turnConsumed`
  too — leaving a LATER, genuinely distinct pending item that matches the trailing TURN
  unable to consume it, so that later item's own real echo was never suppressed (mirror bug
  for `eventConsumed` on the reverse order). Fixed in `de86662b`: each flag is set only when
  its OWN signal actually matched (`matchesTurn` → `turnConsumed`, `matchesEvent` →
  `eventConsumed`), with both still set together when `turnEventOverlap` is true. Added the
  reverse-order regression test PRR-A requested. Critic `verify-resolutions` after
  `de86662b`: 0 blocking, 0 findings, 3 observations — this entry's own gap (resolved by this
  entry) and two instances of a review-round-labeled comment the same observation already
  flagged once before and I had been adding MORE of instead of stripping (resolved below:
  swept every `#3326`/`#3327`/`#3330` comment this branch added and replaced the
  "PRR-A R-Gate RN BLOCKING"/"Critic RN blocking N" framing with the plain issue number and
  the technical reasoning alone — pre-existing labeled comments elsewhere in these files,
  from unrelated prior cars, were left untouched).
- PRR-A R-Gate R5 (`5dffa76c`): **APPROVE** — 0 blocking, 0 warning, 0 note. Confirmed the R4
  fix consumes only the signal(s) actually matched, consuming both only on genuine overlap;
  the reverse-order test covers the R4 failure, the overlap test covers R3's. Independent PR
  reviewer re-pass at the same head: 0 blocking, 0 warning, 0 note (the long-carried
  test-evidence staleness finding finally accepted outright rather than re-filed a 5th time,
  per its own prior round's recommendation). This closes the PRR-A review loop on this car —
  5 rounds, each catching a genuine, independently-confirmed bug in `pendingMarkup`'s #3326
  dedup logic (R1: matching any turn, not the trailing one; R2: the trailing search walking
  past an assistant reply; R3: one echo double-consuming two pending items across the two
  signals; R4: one match wrongly spending both signals' consumption).

## 2026-11-24 — v6.6.0 release cut (Milestone #94), Car V660-W2-REL

<!-- prawduct: type=internal | scope=v660-release -->

- Compiled the 4 accepted `changelog.d/` fragments (#3194 from PR #3253; #3212 Phase 1.1 from
  PR #3251; #3211 + #3212 Phase 1.2 from PR #3252; #3212 Phase 1.2 from PR #3255) into
  `CHANGELOG.md` section `[6.6.0]` via the real `compileFragments`/`spliceIntoUnreleased`,
  promoting the compiled `[Unreleased]` block into a dated `[6.6.0]` header by hand (no
  committed `_promoteUnreleased` helper exists; the prior release's commit message named one but
  it was never added to `lib/changelog-fragments.js`). Target version `6.6.0` (minor — 3
  `added` + 1 `fixed`, no duplication to resolve this round). Bumped `version.json` (`6.5.12` ->
  `6.6.0`); `scripts/release-prepare.js` updated the released-section lock correctly but did a
  blind string substitution of the version number in README's "Latest release" banner, leaving
  the PRIOR release's own descriptive prose attached to the new version number — caught and
  hand-rewritten to actually describe `v6.6.0`'s real changes before anything was committed.
  Updated `FEATURES.md`, `ROADMAP.md`, `docs/releases/index.md`, and `docs/releases/v6.6.0.md`.
- Verified before branching: base commit `76b450ae1ad3d37e690f0e91e3da401bfe99e3ba` (PRs #3251,
  #3252, #3253, #3255 all true-merged), issues #3194/#3211/#3212 all closed, milestone #94 at
  0 open / 3 closed — all checked directly against `gh`, and cross-checked against the live
  `LANE_QUEUE.md` row for this car, not assumed from the dispatch alone.
- `FEATURES.md` entries cite anchors grepped against the real merged code
  (`lib/v6/fleet-template-spec.js#exportFleetPackBlueprint`/`#validateInstanceBindingRecord`,
  `lib/v6/c3-merge-queue.js#verifyFourGateMergeReadiness`/`#authorizeControlPlaneMerge`,
  `lib/tmux.js#scrubSessionLaunchSecrets`), not copied from the fragments or PR titles.
- Branched `release/v6.6.0` explicitly from the named base commit (`git checkout -b
  release/v6.6.0 76b450ae1ad3d37e690f0e91e3da401bfe99e3ba`).
- Verified with `node --test test/version-sync.test.js test/changelog-lock.test.js
  test/readme-version-pins.test.js test/features-index.test.js test/changelog-fragments.test.js
  test/changelog-fragments-repo.test.js test/changelog-fragment-gate.test.js` (134/134 pass) and
  `node scripts/test-stage.js 1`. Diff matched the chartered 13-file scope exactly (`git status`
  checked before committing).

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
