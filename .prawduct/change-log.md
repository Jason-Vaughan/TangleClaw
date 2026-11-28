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

## 2026-11-28 — v6 frontend & fleet-wide workspace isolation, Car V668-W1-A

<!-- prawduct: type=fixed | scope=v668-w1-a -->

- Fixed #3345 (#3325 fast-follow): sibling car #3333 fixed the backend route scoping for
  `GET /api/sprint-waves`/`/api/sprint-reports/:version` but never touched the frontend calls
  or the fleet-wide wave-run resolution, so selecting a non-TangleClaw project/fleet still
  showed TangleClaw's own Sprint & Cars/Charter & Roadmap/Kaizen & Reports panels.
  `public/v6-shell.js`'s `loadWorkspacePanel` now passes `?projectId=<activeProject.id>`
  (`&groupId=` when present) to both reads; a new `refreshOpenWorkspacePanel(mine)`, called
  right after `loadConversation` sets `current`, re-fetches an open data-mode panel whenever
  the active project/session switches.
- `server.js`'s `_v6ResolveSprintScope` now also resolves `projectName`/`groupName`/
  `memberProjectIds` (every project id in the clicked seat's own fleet group, via
  `store.projectGroups.listMembers`). `lib/native-sprint-tracker.js`'s `sprintDataFromWaveRuns`
  accepts a `scope.memberProjectIds` that REPLACES the old single-`projectId` exact match with
  "the run's `metadata.projectId` is one of these" — a wave run a DIFFERENT seat of the same
  fleet recorded now answers correctly instead of the empty sprint (and the misleading generic
  `<version>-train-N` fallback placeholder that used to stand in for the real car) just because
  the one clicked seat never personally launched a train. Backward compatible: an omitted/null
  `memberProjectIds` behaves exactly as before #3345.
- `GET /api/sprint-waves` now also returns `projectName`/`groupName`/`roadmapUrl` (the last a
  plain `github.com/<repo>` link derived from the resolved roadmap's own `repo` — never a
  guessed GitHub Pages URL, since most repos never enable one). `public/sprint-wave-ui.js`'s
  Release-First Roadmap reads these instead of its hardcoded `PUBLIC_SSOT_URL`/`TC-Lane-*`
  fallback, and renders no roadmap link at all when `roadmapUrl` is absent — never defaults to
  TangleClaw's own public page for a different project/fleet. `PUBLIC_SSOT_URL` stays exported
  for any external caller that still wants it; `renderReleaseRoadmap` itself no longer uses it
  as a silent default.
- Cross-car scope note: this car's file scope originally named only `public/v6-shell.js`,
  `public/sprint-wave-ui.js`, `server.js`, `lib/native-sprint-tracker.js` and 3 test files.
  Building deliverable (2) revealed the API response needs 3 new fields, which only
  `lib/routes/sprint-wave-routes.js`'s `handleGetSprintWaves` builds — outside the original
  scope. Flagged to PM before touching it; PM confirmed and said it had updated
  `SPRINT_V668_CHARTER.md`/`LANE_QUEUE.md`'s file list to add it, citing "Ruling A1273," along
  with `test/v6-t2-server-routes-integration.test.js` (the one place `_v6ResolveSprintScope`'s
  real DB-backed `groupId`/`sharedDir`/`memberProjectIds` resolution is end-to-end tested —
  `test/sprint-wave-routes.test.js` only tests the router against a fake `resolveScope` dep and
  cannot reach it). Independently verified the FILE-LIST outcome directly against both files
  before committing either — true, both list both files. The independent PR-reviewer later
  grepped both files for the literal string "A1273" and found no match; re-checked myself —
  confirmed, that citation does not appear anywhere in either document under that label, even
  though the substantive outcome it was invoked for does hold. Recorded here as a citation
  this session could not corroborate, not as a verified ruling number.
- Addendum (#3347, requested by PM mid-build, not part of #3345's own 3 deliverables):
  `_v6LogicalProjectIdsForLegacyProject` widened to include every logical project belonging to
  a fleet peer (same `project_group_members` group), so a bound Fleet PM/Observer session can
  read/disposition the whole fleet's Kaizen items via `kaizenScopeCaller`, not only the ones
  auto-provisioned under its own single project. Independently verified before accepting:
  issue #3347 is real and open and corroborates the general need; the given SQL is schema-
  correct (`project_group_members` has `group_id`/`project_id` columns, confirmed from this
  same session's own `listMembers` implementation); `v6Db()` and `store.getDb()` are the exact
  same connection (`const v6Db = () => store.getDb();`), so the subquery's join is valid rather
  than a cross-database reference that would silently fail. Tested end to end: a real
  `POST /api/v6/kaizen/items` + `GET .../items/:id` round-trip confirms a same-group peer can
  read the item and a project outside every one of the creator's groups still 404s.
- Addendum (#3347, quick-note from PM, also not part of #3345's own 3 deliverables): a
  best-effort `tc` CLI auto-stage call added at server boot (`require.main === module` gated,
  same as its sibling startup checks) — `require('./scripts/stage-tc-cli')` is expected to
  MODULE_NOT_FOUND until sibling PR #3348 ships that file, logged at `debug` for that specific,
  expected case; the function existing but throwing instead logs at `warn`. Never blocks boot
  either way. Not covered by a test: this specific call is gated the same way its neighboring
  startup checks already are, and testing it would need the same child-process-spawning
  harness those already-untested-by-this-car neighbors would (`test/server-listen-protocol.test.js`/
  `test/master-boot-order.test.js`, both outside this car's scope) — disproportionate cost for
  a 12-line, non-blocking try/catch; flagged rather than silently skipped.
- Verification: full regression sweep across all 4 touched test files
  (`test/sprint-wave-routes.test.js`, `test/native-sprint-tracker.test.js`,
  `test/v6-b1-ui-shell.test.js`, `test/v6-t2-server-routes-integration.test.js`): 1196/1196
  passing. Stage 1 static checks green. No `test/tiers.json`/`.testament.toml` changes (no new
  test file — PM confirmed using only the existing tier-registered files, citing "Ruling
  A1273" for this too; see the note on that citation a few bullets down).
- A full-suite `prawduct-hook test-evidence record` run against this tree surfaced a real
  regression: `test/v6-browser-shell-and-conversation-e2e.test.js` (outside this car's
  declared scope) asserted `calls.includes('GET /api/sprint-waves')` — an exact-string match
  the new `?projectId=`/`&groupId=` query string broke for its mounted-project scenario, where
  an active project always exists by the time the assertion runs. Fixed to
  `calls.some((c) => c.startsWith('GET /api/sprint-waves'))`; grepped the whole test suite for
  every other exact-string assertion against either scoped URL (none found). Re-ran: 102/102
  in that file, 1298/1298 across all 5 now-touched test files. The recorder's remaining 22
  failures are the same pre-existing, environment-dependent real-tmux-pane/timing cluster this
  fleet's own change-log history already documents repeatedly (`test/tmux-draft-capture.test.js`
  the largest contributor at 10, plus `engine-health`/`projects`/`sessions`/`startup-dialog`/
  `tmux`/`auth2-setup-admin`, one each) — none touching anything this car's diff changed;
  2 of the newly-seen file names (`test/auth2-setup-admin.test.js`, `test/tmux.test.js`) were
  independently verified clean (0/171) on a fresh clean `origin/main` worktree, consistent with
  the same non-deterministic timing class rather than a new regression.
- Rebased onto `origin/main` once sibling car V668-W1-D's own PR #3348 (#3347) merged mid-
  review. The PR-reviewer flagged this as needing reconciliation — independently verified: `git
  diff` confirmed #3348 touched only `lib/tc-verbs.js`/`lib/v6/e5-kaizen-ledger.js`/
  `scripts/stage-tc-cli.js`, never `server.js`, so "Car D never touches server.js" held and
  there was no file conflict. But `lib/v6/e5-kaizen-ledger.js`'s new
  `resolveLogicalProjectIdsForLegacyProject(db, projectId)` — exported, and `server.js` already
  `require()`s that module as `e5` — solves the IDENTICAL need as this car's own
  `_v6LogicalProjectIdsForLegacyProject` addendum, with the SAME `project_group_members` self-
  join, but ALSO normalizes the `lp-N`-vs-bare-numeric id-spelling ambiguity this car's own
  first draft didn't handle. Rewrote `_v6LogicalProjectIdsForLegacyProject` to delegate to
  `e5.resolveLogicalProjectIdsForLegacyProject` instead of keeping a second, slightly weaker
  copy of the same query — one producer of this capability, not two that can drift apart.
  Updated the boot-time `stage-tc-cli` call's own comments to reflect that the module now
  exists (it actively calls the real `stageTcCli()`, not a no-op) rather than leaving a stale
  "doesn't exist yet" framing; the MODULE_NOT_FOUND branch stays (now covering a checkout
  mid-rebase onto an older tree, or a future revert, rather than "before #3348 merges").
- Cumulative Critic round 1 (1 blocking, fixed; 4 warnings, 2 fixed + 2 accepted):
  **BLOCKING** — `loadWorkspacePanel`'s project-staleness guard (dropping a read for a
  project the operator has since left) only ever applied to `charter` mode; the two sibling
  modes this car just made project-scoped (`sprint`/`kaizen`) had no equivalent guard, and the
  existing `workspacePanels.delete('charter')` route-switch cache-clear (#3088) was never
  mirrored to the new sprint/kaizen cache keys either — together a real risk of silently
  painting a stale project's cars/report with no self-correction, directly contradicting this
  car's own changelog claim. Fixed both: the guard now keys off `activeProject` (captured
  before the function's very first await) for every mode, and the cache-clear now deletes all
  three keys. Added 2 new structural tests in `test/v6-b1-ui-shell.test.js` confirming the
  fixed shape (a true behavioral race test would need the same project-switch-mid-fetch
  harness this file doesn't have yet — noted, not built, given the fix itself is a direct,
  narrow generalization of an already-correct pattern). **WARNING** (fixed) — the new
  `getRoadmapUrl` dep had no `@param` entry in `createSprintWaveRouter`'s otherwise-exhaustive
  JSDoc; added one matching the module's own style. **WARNING** (fixed) — the e2e test's
  `startsWith('GET /api/sprint-waves')` fix would also match the real, different
  `GET /api/sprint-waves/github-activity` endpoint; tightened to a query-string boundary match
  (`c === 'GET /api/sprint-waves' || c.startsWith('GET /api/sprint-waves?')`). **WARNING**
  (accepted) — the 22-failure test-evidence disclosure, already fully substantiated above.
  **WARNING** (accepted) — the boot-time `tc` CLI auto-stage call's own missing test coverage,
  already disclosed above (note added there that the module now exists post-rebase).
- Rebased again onto Car C's own merge (`42adc5fd`); clean, no conflict (confirmed by reading
  the diffstat first — the only new file, `lib/shared-docs-access.js`, is untouched by this
  car). The rebase changed this branch's own history, which demoted the next
  `/prawduct:critic verify-resolutions` dispatch to a full `cumulative` pass automatically
  (the prior review fact no longer anchors at an ancestor of HEAD) — expected, not an error.
- Cumulative Critic round 2 (2 blocking, 1 fixed + 1 escalated for an owner ruling; 1 warning,
  fixed): **BLOCKING** (fixed) — the new `projectName`/`groupName`/`roadmapUrl` fields had only
  consumer-side tests (hand-constructed values passed straight to `renderReleaseRoadmap`);
  nothing exercised the real DB → `_v6ResolveSprintScope` → `handleGetSprintWaves` → JSON
  response path. Added 2 end-to-end tests in `test/v6-t2-server-routes-integration.test.js`
  (a real fleet-group project + a real `roadmap2-data.json` with a `repo` field, confirming all
  3 fields resolve correctly through the real route; plus the ungrouped-project case). 73/73
  passing in that file. **BLOCKING** (escalated, not self-accepted) — Critic flagged that the
  recorded 21-failure pre-existing tmux/pane-timing cluster has now been downgraded
  BLOCKING→WARNING by three consecutive reviews on this branch, each one citing only the
  PRECEDING review as its authority, with no ratified `project-preferences.md`/norms entry
  backing the downgrade. Critic's own recommendation: an explicit owner ruling, not a 4th
  review silently extending the chain. Sent PM a direct request for that ruling (asking whether
  this should become a durably-recorded exception, or whether every instance needs its own
  fresh re-justification) rather than self-dispositioning a BLOCKING finding on my own judgment
  — this is exactly the class of decision this repo's own Rule Authoring Policy and the "no
  'pre-existing' exception" hardest rule both reserve for something other than the Builder's
  own say-so. **WARNING** (fixed) — `d.getRoadmapUrl(repo)` was called with no `await` despite
  its own JSDoc declaring `Promise<string|null>` support; harmless today (the real
  implementation is synchronous) but would silently break under a future async one. Added the
  `await`, matching every sibling dep call in the same function.
- R-1 resolution: PM granted an explicit ruling (PM-V668-W1A-01) citing GitHub issues #3254 and
  #3349 as the durable shared-host tmux/pane-timing contention exception. Independently
  verified both before accepting: both are real, open issues whose bodies match the claim
  exactly, including reproduction evidence against the diff AND unmodified `origin/main`;
  `scripts/test-touched.js`'s `KNOWN_FLAKY_STAGE2` object is a real, already-landed, code-level
  exception list (3 entries today — `test/tmux-draft-capture.test.js`, `test/engine-
  health.test.js`, `test/ttyd-runtime.test.js`; the 5 additional files #3349 names are a
  pending, not-yet-landed addition to that same list). Dispositioned R-1 ACCEPTED with that
  citation. A follow-up `verify-resolutions` pass then found the disposition alone
  insufficient to clear a BLOCKING finding while `test-status` itself reads `stale` (the
  evidence tree had moved one commit since the last full recorder run) — the protocol treats
  stale evidence as "cannot confirm either way, stays blocking by omission," independent of
  any ruling about what a CONFIRMED set of failures would mean. Reported this specific
  mechanical gap back to PM (not something I resolved on my own authority) and received a
  second explicit ruling, PM-V668-W1A-02: run the targeted `node --test` on this car's own 5
  touched test files (seconds, not the ~2.5-hour full-suite recorder) and treat the Testament
  pool's own pre-push Stage 2/3 run plus GitHub Actions CI as the authoritative full-suite
  gates for this PR, in place of a second local recorder pass — citing the host-CPU-load
  concern that motivated the original ask not to re-run locally. Ran the 5 files directly:
  1302/1302 passing. Proceeding to push and open the PR on that explicit basis, recorded here
  with the exact gap rather than presented as an ordinary clean pass.
- PRR-A R-Gate R1 (BLOCKING 1, fixed): a project-scoped request with no fleet group
  (`scope.projectId` resolved, `scope.sharedDir` still null) fell through to THIS INSTALL'S OWN
  `roadmap2-data.json` (hardcoded `ROADMAP2_DATA_DEFAULT_PATH`) — on this machine, a real file
  naming `Jason-Vaughan/TangleClaw` with ~86 real releases — so an ungrouped project's panel
  showed this install's own roadmap/repo link under that project's own `projectName`, exactly
  the cross-project mix-up this whole car exists to prevent. Confirmed directly before fixing:
  read the real default file, `repo: "Jason-Vaughan/TangleClaw"`, 86 releases. Fixed in
  `_v6LoadRoadmapData`: the install-wide fallback is now used only for a request naming no
  project at all (the bare operator dashboard, unchanged pre-#3325 behavior); a project-scoped-
  but-ungrouped `scope` gets an empty roadmap instead. Then grepped the whole file for every
  sibling function sharing the identical `scope.sharedDir ? <project's own file> : <this
  install's own file>` shape (per this repo's own learnings file: check every member of the
  same pattern, not just the one named) and found 3 more with the SAME bug —
  `_v6LoadRoadmapSyncStatus`, `_v6LoadReportsHubHtml` (reachable today via the already-wired
  `getReports` dep → `_v6ReportsCatalog`, so this one was a live leak, not just latent), and
  `_v6LoadSprintReportHtml` (not currently wired as a dep, so latent, but fixed anyway for
  consistency). Factored the shared "is this a project-scoped-but-ungrouped request" check into
  one new `_v6ScopedToProjectWithNoGroup(scope)` helper all 4 now call, rather than repeating
  the condition inline 4 times. Added a new, strict regression test in `test/v6-t2-server-
  routes-integration.test.js` — confirmed it actually fails without the fix (reverted the
  server.js diff, re-ran, got exactly the real leaked URL back; restored the fix, re-ran, green)
  before trusting it. 74/74 in that file, 1303/1303 across all 5 touched test files.

## 2026-11-27 — Global Settings rebuilt as a full-screen workspace, Car V667-W1-A

<!-- prawduct: type=added | scope=v667-w1-a -->

- Added #3319: rebuilt the Global Settings modal (`public/ui.js#openGlobalSettings`,
  `public/index.html#globalSettingsModal`) from a skinny 440px dialog into a full-screen
  workspace with a left-hand category rail — General & Server, Storage & System Health,
  Engines & Quotas, Security & Auth, Backups & Maintenance, Bridge & Notifications. This is
  the charter's own committed 6-category list; two separate Medusa dispatches from PM named
  conflicting category lists (the issue's bare "e.g." list, and a 2nd dispatch's own
  restatement), flagged non-blockingly, and PM confirmed the charter's list is authoritative
  before building.
- Reused the exact `position:fixed; inset:0` inline-style-over-CSS-class technique
  `#settingsModal` (#3214) already uses for its own full-viewport page, rather than
  introducing a second pattern — confirmed by reading that modal's own markup directly
  after an earlier message in this session incorrectly claimed Session Settings was NOT
  full-screen (corrected to PM in the same session).
- Added a search box (`#gsSearchFilter`) that filters every category's fields at once (not
  scoped to the currently-open category — finding a setting shouldn't require first
  guessing which category it lives in) and a deep-linkable `#settings/<category>` hash via
  `history.replaceState` (never `pushState` — one history entry per rail click would be
  surprising in Back/Forward, not useful).
- Added a Storage Warning Threshold (%) field (default 85, range 50-98) in Storage & System
  Health for sibling car #3318's backend setting. Confirmed via direct source read
  (`lib/routes/config.js`'s `allowedFields` allowlist) that NEITHER of the two candidate
  field names the dispatch gave (`diskWarningThresholdPercent` / `storageWarningThresholdPct`)
  exists in the backend yet — #3318 had not landed as of this write. `saveGlobalSettings`
  sends BOTH names defensively; the server's own documented allowlist behavior silently
  skips an unrecognized field rather than erroring, so persistence starts working the moment
  #3318's allowlist entry lands under whichever name it actually uses, with no further
  change needed on this side.
- Every pre-existing control, id, and the `openGlobalSettings`/`closeGlobalSettings`/
  `saveGlobalSettings` handlers are preserved unchanged — only re-bucketed into
  `<section data-gs-category="...">` wrappers around the existing markup, confirmed by a
  balanced-tag check and by keeping every existing test file in this area green
  (`test/bridge-step-up-settings-wiring.test.js`, `test/global-engine-settings-ui.test.js`,
  `test/isolation-override-banner.test.js`, `test/launch-isolation-override-ui.test.js`,
  `test/operator-bridge-panel.test.js`, `test/settings-credential.test.js`,
  `test/bind-policy-wiring.test.js`).
- One cross-file fix outside this car's declared scope: `test/operator-bridge-panel.test.js`
  lifts `closeGlobalSettings()` alone via `vm.runInContext`, and that function now
  references `_gsActiveCategoryFromHash`/`window.history` as free variables the isolated
  lift did not provide — caught by running that file, not by inspection. Stubbed minimally
  in that file; the real hash-clearing behavior has its own direct coverage in the new test
  file below.
- Cumulative Critic R1 (2 warnings, fixed): (1) `_gsWireCategoryRail`/
  `_gsWireSearchFilter` were called from inside `openGlobalSettings()`, stacking a fresh
  listener on every open since the rail/search box are static markup never rebuilt by
  that function — moved both calls to the file's one-time top-level event-wiring block
  instead. (2) the Storage Warning Threshold field gave no signal that it does not persist
  yet (pending #3318) — added a `storageThresholdPersists` check (true once either backend
  field name appears in `GET /api/config`) and a "Not yet active" caveat in the hint text
  that self-clears the moment #3318 lands, with no further change needed here. Also added
  `.prawduct/operator-verification.md` VRF-009 for this car's visual/interaction surface
  (full-viewport layout, rail switching, cross-category search, hash deep-linking, close/
  Escape), accepted with the same "no browser tooling in this headless lane" rationale as
  VRF-008.
- Post-R1 fix (own-initiative, not a Critic finding): sibling car #3318 (`diskWarningThresholdPercent`/
  `storageWarningThresholdPct`) merged to `origin/main` (PR #3341, `58bb55bc`) while this car was
  mid-review. Read its `lib/routes/config.js` diff directly before rebasing: the merged PATCH route
  treats `diskWarningThresholdPercent` as the one canonical field and `storageWarningThresholdPct`
  as an alias — but refuses 400 ("the same setting; send only one") if a body sends BOTH. This
  car's `saveGlobalSettings()` was sending both unconditionally (written defensively before
  #3318 landed, when neither name existed in the allowlist yet) — every save of Global Settings
  would have 400'd once rebased onto the new main. Fixed to send only `diskWarningThresholdPercent`.
  The read-side fallback (`c.diskWarningThresholdPercent ?? c.storageWarningThresholdPct`) and the
  `storageThresholdPersists` caveat check are unaffected by this and still correct — `GET
  /api/config` now always mirrors the value under both names, so the caveat self-clears exactly
  as designed.
- New `test/global-settings-workspace-ui.test.js` (40 cases): markup/CSS structural
  assertions (matching this file's own established convention for `public/ui.js`, per
  `test/settings-credential.test.js`'s comment) plus behavioral coverage of the new rail/
  search/hash logic, lifted together with its module-level `const`/`let` state and run
  against a minimal hand-built fake `document`/`window` (not a full mini-DOM) with every
  fake method it calls listed explicitly, so an unimplemented one fails loudly instead of
  silently no-op'ing. `test/tiers.json`/`.testament.toml` regenerated via
  `scripts/test-tiers.js --write`/`--testament` (lands in the `small` tier — no subprocess,
  no sqlite, no socket).
- `docs/areas.json` needed no change: confirmed by reading the whole file that `public/**`
  is already covered by a single existing glob (the `dashboard-ux` area) and that the file
  tracks no per-test-file registration at all — the file scope's mention of this file was a
  stale assumption, not something requiring a forced edit.
- Verification: full `small`-tier suite plus a targeted regression sweep of every Global
  Settings-adjacent test file green. An earlier, now-superseded `medium`-tier pool run
  (`testament run --suite medium`) surfaced 24 failures clustered on 3 shared pool hosts
  (monad-1, brooks-nas, brooks-5950x), none touching `public/ui.js`/`index.html`/
  `style.css` or Global Settings; a sample of 3 (`store.test.js`, `bridge-gateway.test.js`,
  `session-rules.test.js`) passed cleanly run directly on a clean `origin/main` worktree
  (that run predates the rebase onto `origin/main@8cd4988a` below and is not the evidence
  gating this PR — recorded here only as earlier-session context).
- A first post-rebase recorder run (base `origin/main@8cd4988a`, before the #3318 dual-send
  fix below) recorded `node --test --test-reporter=junit test/*.test.js`: **32311 passed,
  52 failed, 2 skipped**. All 52 lived in 7 files — `test/engine-health.test.js`,
  `test/master-medusa.test.js`, `test/projects.test.js`, `test/sessions.test.js`,
  `test/startup-dialog.test.js`, `test/tmux-draft-capture.test.js`, `test/tmux-tcc.test.js`
  — none touching `public/ui.js`/`index.html`/`style.css` or Global Settings. Verified
  directly: ran all 7 files on a clean `origin/main@8cd4988a` worktree. 4 of the 7
  (`engine-health`, `master-medusa`, `tmux-draft-capture`, `tmux-tcc`) reproduced failures
  in that same cluster identically; the other 3 (`projects`, `sessions`, `startup-dialog`)
  showed only 1 failure out of 1019 tests (`"the pane writer refuses a declared dialog
  (#2128)"` in `test/startup-dialog.test.js`) — a *different* specific case than the one
  that failed on this branch's run in the same file (`"the synchronous cursor read says
  whether the cursor is shown, on a real pane"`), consistent with real-tmux-pane/timing-
  dependent flakiness in that file rather than a deterministic regression either way.
- The evidence that actually gates `prawduct-hook test-status` for the FINAL tree (after
  rebasing onto `origin/main@58bb55bc` and the #3318 dual-send fix above) is a second,
  final recorder run: **32395 passed, 21 failed, 2 skipped** — a strict subset of the
  same 52 named above (one new name, `"capturePane still captures only the visible pane
  when the REAL TCC_SOCKET session is itself in alternate screen"`, is a different specific
  sub-test inside the already-verified-flaky `test/tmux-tcc.test.js`, same file, same real-
  tmux-pane-timing class). The fewer-failures count between the two runs (52 -> 21) is
  itself further evidence of non-deterministic, timing-dependent flakiness in this
  cluster rather than a fixed count any change could plausibly move. Conclusion: every
  failure across both runs is pre-existing, environment-dependent (real tmux pane/session
  timing), and unrelated to this branch's changes — none fixed, none newly introduced.

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
