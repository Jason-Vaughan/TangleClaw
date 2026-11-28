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

## 2026-11-28 — v6 Fleet Shell chat/workspace fixes + staggered fleet launch, Car V669-W1-A

<!-- prawduct: type=fixed | scope=v669-w1-a -->

- Fixed #3355/#3352, five operator-reported v6 Fleet Shell regressions in `public/v6-shell.js`:
  1. **`loadWorkspacePanel` unscoped race:** `activeProject` now falls back to
     `resolveRouteProject(sh.getRoute(), projects, delegates())` when `current.project` has not
     resolved yet (a workspace-tab click reaching `handleRoute`'s own cold-start
     `loadProjects()` while still in flight — `setWorkspaceLoader` is wired on the VERY FIRST
     `handleRoute` call, well before that). A project/fleet/conversation route with no resolved
     project returns early instead of firing an unscoped `/api/sprint-waves`/
     `/api/sprint-reports/current`. A `workspacePanelGenByMode` map (NOT the single shared
     counter the original issue asked for — see deviation note below) drops a stale response
     superseded by a newer call for the SAME mode.
  2. **Coalesced multi-prompt chat ordering:** `extractLiveTurns`'s echo check no longer tests
     `knownLines.has(text)` across every recorded message; an indented line that does not belong
     to the CURRENT echo and matches a DIFFERENT recorded message now starts its own user turn
     (`recordedAs(text)`), instead of being swallowed into the first message's echo.
  3. **`Waiting on: YOU` false positives:** `asksQuestion` strips a non-backticked JS ternary
     (`\?\s+[^?:\n]+\s*:`) before testing for a sentence-ending `?`, fixing a real false positive
     (verified: a declarative line describing a ternary, ending in `.`, no longer reads as a
     question). The URL-query-param-token strip (`\?[A-Za-z0-9_.-]+=`) is also added per the
     issue, but empirically never changes this function's output against any realistic input —
     the lookahead this regex feeds never matches a letter/digit directly after `?` either way,
     so it is harmless but not a verified fix; recorded here rather than silently claimed as one.
     Separately, `openPrior` now reads each turn's own trailing paragraph (a new
     `trailingBlockByTurnIndex` map keyed by position in `turns`, not a field added to the turn
     objects — see deviation note) instead of its full text, so an EARLIER reply's own superseded
     rhetorical `?` (from before that reply's own later paragraph) never resurfaces across a
     second Medusa wake.
  4. **Wrapped-line URL boundary gluing:** `appendReplyLine` only glues a wrapped URL with no
     space when `prev` does not already end a sentence/clause, `txt` does not open with
     punctuation, and this is not a complete GitHub PR/Issue URL followed by non-path/fragment/
     query prose. `MESSAGE_LINK`'s bare-URL branch excludes `{`/`}`; `lineMarkup` truncates a
     trailing UNMATCHED `(` out of a bare URL match before the existing trailing-punctuation
     strip runs.
  5. **Staggered Fleet Launch (#3352):** `startFleetMembers` and `startFleet`'s own
     offline-member loop pause `fleetStartDelayMs` between consecutive launches (never after the
     last one). `public/ui.js`'s production wiring passes the real `STAGGER_FLEET_START_MS`
     (2500ms, exported as `global.tcV6StaggerFleetStartMs`) explicitly.
- **Two deliberate deviations from the issue's literal spec, both verified necessary by running
  the existing suite, not guessed:**
  - **Deliverable 1's generation counter is keyed by MODE (`workspacePanelGenByMode`), not the
    single shared `workspacePanelGen` the issue asked for.** A single shared counter made ANY
    newer call (any mode) supersede an older one — breaking a real, pre-existing test
    (`'adds the sprint UI script once, draws with it when it loads, and never adds it twice'`)
    that relies on a `sprint` load and a `charter` load both completing independently, since they
    write to separate panels and never actually race each other.
  - **Deliverable 5's `fleetStartDelayMs` default is explicit opt-in only (0 unless given), never
    environment-detected** (`typeof window !== 'undefined' && global === window`, as the issue
    specified). This file's own `vm.runInContext` test harness (`test/v6-b1-ui-shell.test.js`)
    sets `sandbox.window = sandbox` for every test, making a test sandbox's globals
    indistinguishable from a real browser's BY DESIGN — confirmed by running the existing fleet-
    start tests with the literal spec, which crashed on `setTimeout is not defined` because the
    check resolved the REAL 2500ms delay in the test sandbox too. `public/ui.js`'s production
    wiring now requests the real delay explicitly instead (`fleetStartDelayMs:
    window.tcV6StaggerFleetStartMs`), and the "page wiring" describe block's own structural test
    was updated to match the new call shape.
- Deliverable 3's `trailingBlock` is tracked in a side `Map` keyed by turn index, not as a field
  added to each flushed turn object — avoids changing `extractLiveTurns`' public output shape at
  all, so none of the ~10 pre-existing exact-`deepEqual` assertions against `turns` needed
  updating (confirmed: the first draft, which DID add the field, broke 10 of them).
- New tests: 3 for deliverable 2 (coalesced second message; no duplicate on repeated echo; a
  genuine same-message continuation unaffected), 3 for deliverable 3 (an earlier reply's
  superseded paragraph; ternary false-positive fixed; a ternary does not mask a real question), 5
  for deliverable 4 (unchanged baseline glue; GitHub PR URL + prose now spaced; the exact
  `pull/3354(-` bug shape fixed; a real path continuation still glues; sentence-punctuation-ending
  URL always spaced) plus 3 for `lineMarkup`'s unmatched-paren truncation and `{}` exclusion, 1
  end-to-end test for deliverable 1's cold-start race (a stub shell driving `handleRoute`/
  `setWorkspaceLoader` directly, confirmed to fail without the fix before being trusted), and 4
  for deliverable 5's stagger (explicit delay + no-sleep-after-last; no delay without opt-in; no
  sleep for a single-member batch; the open-chat `startFleet` direct loop also staggers).
  876+ tests in `test/v6-b1-ui-shell.test.js` pass; cross-file sweep
  (`test/v6-*.test.js test/sprint-wave-routes.test.js test/native-sprint-tracker.test.js
  test/api-*.test.js`): 5079/5079. Stage 1 static green.
- Critic cumulative R1 (BLOCKING 1, fixed): the deliverable-3 ternary-strip regex
  (`/\?\s+[^?:\n]+\s*:/g`) matched ANY "`<real question>? <prose with a colon>`" on one physical
  line, not just an actual ternary — verified directly, `asksQuestion("Should we ship this?
  Checklist: tests, docs, changelog.")` returned `false`, silently hiding a genuine open question
  from the "Waiting on: YOU" indicator. Exactly the shape this repo's own learnings file already
  names ("a fix that changes a failure MODE needs re-checking against the actual requirement") —
  traded a known false positive for an unexamined false negative. Fixed by requiring the matched
  branch (between `?` and `:`) to start with a LOWERCASE letter/`_`/`$`
  (`/\?\s+[a-z_$][\w.$[\]()'"-]*\s*:/g`): a real ternary's branch is a lowercase JS
  identifier/property-access/call (`current.project`, `bar()`); a genuine clarifying clause after
  a real question almost always starts capitalized (`Checklist:`, `Status:`, `Options:`).
  Verified against both shapes (and the original ternary case, and a ternary-plus-later-real-
  question case) before trusting it, not just re-running the two existing tests. Added 2 new
  tests covering the exact regressed shape plus 2 more capitalized-clause variants. 883/883 in
  the car's own file; cross-file sweep (`test/v6-*.test.js`): 2773/2773; Stage 1 green.
  R-2 (WARNING, stale test evidence — accepted: predates this PR's files, targeted run is fresh)
  and R-3 (NOTE, 0 backlog items affect changed paths — accepted) dispositioned, no code change.
- verify-resolutions: 0 blocking, R-1 confirmed fixed (hand-traced the new regex against the
  regressed shape, the original ternary shape, and a mixed ternary+real-question line; grepped
  for other sites of the old vulnerable pattern — single-site fix, not a partial patch). 2
  non-gating observations: O-1 (stale evidence, same as R-2 — accepted) and O-2 — the fix's own
  new comment re-added a "Critic cumulative BLOCKING:" review-round label, directly breaking this
  file's own prior carry-forward commitment (`rev-20261115T020853Z/R-1`: strip these labels on
  the next commit touching the file, keep the sentences and issue numbers). Fixed immediately
  rather than deferred again — reworded to drop the label, keeping the technical explanation and
  #3355. 883/883 unaffected.
- Final verify-resolutions (after the O-2 comment fix): 0 findings, 3 non-gating observations,
  all accepted. O-1 (stale evidence, same unrelated class) and O-2 (confirmed resolved) carried
  forward from the prior round; O-3 names ~25+ OTHER pre-existing review-round-labeled comments
  elsewhere in `public/v6-shell.js` as the same already-accepted class (`rev-20261115T020853Z/R-1`)
  — not introduced or materially touched by this car, out of scope here, left for a future
  dedicated sweep rather than per-touch fixes. Critic governance closed clean for this branch;
  tree clean at head `1e0207fd`.
- PRR-A R-Gate R2 REVISE (1 surgical fix, relayed by PM): the lowercase-start check alone still
  let a lowercase-starting clarifying clause with NO space before its own colon slip through
  (`"Should we ship this? maybe: test first."` — `"maybe:"` has no space before `:`). A real JS
  ternary's `:` always has whitespace on BOTH sides (`cond ? a : b`); a colon glued directly to
  the preceding word is prose, never code. Fixed by requiring `\s+` (not `\s*`) before the colon
  too, combined with the existing lowercase-start check rather than replacing it — both signals
  independently point at "this is code," which is stricter than either alone and still matches
  every legitimate ternary shape. Verified against the exact PRR-A-reported case plus every
  previously-verified case (the original `Checklist:`/`Status:`/`Options:` false positives, both
  ternary shapes) before trusting it. One new regression test added for the exact reported shape.
  884/884 in the car's own file; cross-file sweep (`test/v6-*.test.js`): 2774/2774; Stage 1 green.
  verify-resolutions: 0 findings, 1 non-gating observation (same stale-evidence class as every
  prior round — accepted). Tree clean at head `f4b2bf4c`.
- PRR-A R-Gate R4 REVISE (1 surgical fix, relayed by PM): the R2 fix's whitespace-before-colon
  requirement swung too far — a real JS ternary can ALSO be written with no space before its OWN
  colon (`current ? current.project: null`, as opposed to `current ? current.project : null`),
  which that requirement then wrongly left unstripped, reintroducing a false-positive open
  question for an otherwise-ordinary declarative line. Fixed per PM's exact verified regex: key
  off what precedes the `?` instead of (only) what precedes the `:` — a real ternary's `?` always
  follows a complete expression (preceded by whitespace or a closing `)`/`]`), while an English
  `?` is glued directly to the word it ends with no space at all. The whitespace-before-`?`
  alternative relaxes the colon-spacing requirement (since the `?`-position signal alone now does
  the disambiguation); the original R2 pattern remains as a fallback for the rare case nothing
  precedes `?`. Verified independently against all 8 known cases (both ternary colon-spacing
  shapes, the `maybe:`/`Checklist:`/`Status:`/`Options:` false positives, a bare query-param
  token, and two further adversarial cases — a ternary with a function-call/array-access
  condition, and an English question followed by a multi-word lowercase clause) before trusting
  it, not just the one PRR-A reported. One new regression test for the exact PRR-A-reported
  shape. 885/885 in the car's own file (per PRR-A's explicit instruction: targeted file only this
  round, not the cross-file sweep — the live TangleClaw server shares this host's resources).
  Stage 1 static green.
- Critic verify-resolutions BLOCKING (1, fixed): the R4 fix's new backward-look alternative (`[\s)\]]\?\s+...`)
  widened the branch's allowed first character to uppercase too (`[a-zA-Z_$]`, copied verbatim
  from PM's own given regex) when ONLY the colon-spacing needed relaxing — PM's exact regex
  itself carried this flaw, and my own verification against 13 cases (including the 2 extra
  adversarial ones I added beyond what either PRR-A or PM reported) still missed this specific
  combination (a `?` preceded by whitespace/`)`/`]` AND followed by a capitalized clause with no
  space before its own colon — `"Should we ship (final build)? Status: pending."` lost its own
  `?`). Caught by `verify-resolutions`, not by me. Fixed by restricting the new alternative's
  branch back to lowercase-only, matching the fallback alternative — relaxes ONLY what R4 needed
  relaxed (colon spacing), nothing else. Re-verified against all 13 previously-known cases plus
  this one (14 total) before trusting it. One new regression test for the exact reported shape.
  886/886 in the car's own file (targeted-file-only per PRR-A's standing instruction). Stage 1
  static green. Also caught, before committing, my own in-progress comment reintroducing a
  review-round label ("Critic verify-resolutions, Car V669-W1-A") while explaining this exact
  fix — reworded before it ever reached a commit, per this session's own new learnings entry on
  this exact recurring mistake.
- Final verify-resolutions (R6): 0 findings, prior BLOCKING confirmed fixed (hand-traced against
  the exact adversarial string, confirmed the vulnerable pattern exists at exactly one site, new
  test matches). 1 non-gating observation (same stale-evidence class as every prior round —
  accepted). Review is over for this tree; branch covered at 8 commits since `origin/main`, no
  blocking outstanding. Tree clean at head `7c797948`.
- **Structural revision (R7), after PRR-A's further R5/R6 findings reopened the SAME shape twice
  more ("Do we need the fallback (for beta)? maybe: keep it." -- `)` before `?`, lowercase clause,
  no space before colon):** rather than patch a fourth time, stepped back and proposed dropping
  the colon-spacing relaxation entirely to PM and PRR-A, with full reasoning and verification.
  PRR-A explicitly agreed ("preserving a genuine natural-language question is preferable;
  allowing an occasional no-space-before-colon ternary false positive is the safer tradeoff").
  PM countered with a more elaborate 3-way regex (code-punctuation-in-branch OR JS-literal-false-
  branch detection) claiming no tradeoff was needed; independently verified it BEFORE applying —
  found 2 new concrete false negatives ("Do we deploy now ? maybe: 0 downtime needed." and
  "...maybe: true is fine." both silently stripped, since "0"/"true" are ordinary English words,
  not just JS literals). Reported that counter-example back and proceeded with the simpler,
  PRR-A-endorsed design: requires whitespace on BOTH sides of the ternary colon, no backward-look
  at what precedes `?` at all. PM then approved this exact approach. Accepts exactly 2 known,
  cosmetic false-positive shapes (a no-space-before-colon ternary read as an open question —
  self-correcting on the next reply, never silent) in exchange for zero known false negatives
  across every real-question case found in R2 through R6. Also added, independently verified, and
  unrelated to the ambiguity: a metalanguage strip (`a JS ternary ?` referenced by name is never a
  question) and a quoted-example strip (a question quoted inside an otherwise-declarative
  sentence, matching the Operator's own reported line, is the quoted text's own question, not the
  line's). Rewrote the now-obsolete R4/R5/R6 test narrating "still correctly recognized as code"
  (the opposite of the new design) to document the accepted tradeoff explicitly; added tests for
  the metalanguage case, the quoted-example case, and both Operator-reported screenshot lines.
  889/889 in the car's own file (targeted-file-only per PRR-A's standing instruction). Stage 1
  static green. Built and pushed from a fresh /tmp clone of this branch, not the primary
  checkout: a host-level filesystem EPERM (unrelated to this work, confirmed via `touch`
  succeeding but `rm`/overwrite and some file reads failing even for ordinary git operations)
  blocked the primary checkout partway through this round.
- Critic verify-resolutions (R8): 0 blocking, 0 warning, 3 observations. O-1 (NOTE, fixed
  immediately rather than accepted a 4th time): the R7 comment itself reintroduced review-round
  vocabulary ("PRR-A R-Gate R3 through R6", "for R-Gate R3") that a standing disposition AND this
  session's own new learnings entry — written in the SAME diff Critic was reviewing — both commit
  to stripping from this exact file. Reworded both comments to keep the technical explanation and
  #3355 only; confirmed via grep that no `Critic|cumulative|R[0-9]|BLOCKING|PRR-[AB]` vocabulary
  remains in the function. O-2 (fixed): added a direct test for the quoted-example strip's
  non-parenthesis-preceded alternative, previously verified only by hand-trace. O-3 (same
  stale-evidence class as every prior round — accepted). 890/890 in the car's own file. Stage 1
  static green.
- Final verify-resolutions (R8): 0 blocking, 0 warning, 0 new findings. O-1/O-2 confirmed
  resolved; a separate, pre-existing, out-of-scope citation-tag class elsewhere in the file was
  correctly scoped out, not flagged as a new defect. Review is over for this tree; branch covered
  at 11 commits since `origin/main`, no blocking outstanding. Tree clean at head `ec5cf523`.
  Awaiting PRR-A/Arc human review.

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
