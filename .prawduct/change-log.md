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

## 2026-10-21 — #2248 S01: the HTTP kernel and the audit routes out of server.js, the area map and the reachability test

<!-- prawduct: type=chore | scope=2248-area-extraction -->

#2248 S01. v5.35.0 Wave 3 chunk W3-A1, plan r2 (sha256 `fa294c62`, accepted by INT with Architect A404 and PM ruling `2854e406`); Part of #2248, which stays open for Part 2. Built on `feat/2248-s01-kernel-audit` from `origin/main` `b1bf495c` under dispatch token `W3-S01-2248-B1BF495C-FA294C62`.

**What moved, unchanged.** `lib/routes/_kernel.js` holds the route table and matcher (`routes`, `route`, `matchRoute`, `_routePatterns`), the responders (`jsonResponse`, `errorResponse`), the body parser and its 413 (`parseBody`, `bodyTooLarge`), the URL and query helpers (`reqUrl`, `parseQuery`) and the two body-size constants, cut from `server.js` by section marker; `server.js` destructures them back from the kernel and keeps its export object byte for byte. `lib/routes/audit.js` holds the `// ── Eval Audit Mode ──` block (seventeen `/api/audit/*` and `/api/sidecar/*` routes with the debounced incident generator) inside a `register()` the entry point calls at the position the block held, so registration order is unchanged; the family closes over no server helper, so `register` takes nothing. The logger keeps the name `server` so log lines read as before.

**Narrower than the plan, said here.** `htmlResponse` stays in `server.js`: it reads `PLAN_PAGE_CSP`, which is the plan-docs page's own policy, not a kernel concern. `CSRF_UNSAFE_METHODS` stays too: only the dispatcher reads it. Both are named in the plan's kernel list and were left where they are on purpose.

**Critic R-1.** The `wrapDefaultPipeline` require in `server.js` had its only caller (the wrap-quality handler) move with the family and is removed; the import now lives beside its one reader. R-2: the plan's `branch:` is set to this branch in both gitignored copies.

**Mechanisms added.** `docs/areas.json` maps every file under `server.js`, `lib/`, `public/` and `scripts/` to one named area with its issue label, with `shared` naming the two files still holding several areas; `test/areas-map.test.js` holds it total and unambiguous (a file matched by two areas is a failure, in any order), and `test/route-reachability.test.js` asserts every registered route answers a request shaped like its own pattern. `CONTRIBUTING.md` gains the `lib/routes/` line; the two `FEATURES.md` anchors naming moved symbols (`bodyTooLarge`, `MESSAGE_BODY_LIMIT_BYTES`) now point at the kernel, under the PM's bounded-anchor ruling.

## 2026-10-21 — v5.35.0 Wave 2 records: changelog fragments (#1220)

<!-- prawduct: type=docs | scope=1220-changelog-fragments -->

W2-REC follows the four merged #1220 chunks: C01 PR #2518 (`81891ab3`), C02 PR #2520 (`c774d21d`), C03 PR #2522 (`bdd8b15f`), and C04 PR #2526 (`076474d0`, Architect A401). The live pilot added distinct fragments in PRs #2524 and #2525; the C04 packet records their merge SHAs, a refused exact-path collision, and a scratch release cut that compiled all four then-pending fragments. C04 also closed #2519. This records the current behavior in `FEATURES.md` and adds C01's contract entry as its own fragment. The C02–C04 and pilot changelog entries are already present as fragments. `CHANGELOG.md` remains the release output; this PR does not cut a version, publish, or deploy. #1220 stays open for the Operator's C05 PR-obligation ruling, and #2523 tracks removal of the pre-boundary direct-edit exception after #2385 and #2217 close.

The C02 first CI head failed its prompt phrase test, and a Prawduct recorder receipt undercounted or falsely reported its run; #2521 tracks that tool defect. Exact-head CI and retained full-suite JUnit/spec evidence replaced that receipt for the accepted heads. C04's first `SUITE_SLOT` claim edit was made without the intended shared-document lock because a zsh header variable did not split; Builder recorded the near miss in PR #2526, then attested the later release edit under the lock. The live queue is attested at revision 74.

## 2026-10-21 — #1220 C04: the repository checks its own fragments, the PR gate is recorded as a proposal, and features-toc never stubs a fragment (#2519)

<!-- prawduct: type=feature | scope=1220-changelog-fragments -->

#1220 C04. v5.35.0 Wave 2 chunk W2-A1, plan r5 (C01 merged as `81891ab3`, C02 as `c774d21d`, C03 as `bdd8b15f`; Architect A391.3 ruled the PR gate an Operator-gated proposal; the PM's scope ruling relayed by the Integrator adds `lib/wrap-steps/_source-paths.js` and `test/wrap-step-features-toc.test.js` so this chunk closes #2519), restart token `W2-1220-C04-BDD8B15F-20261021-7D3C`. Branch `feat/1220-c04-changelog-fragments` from `origin/main` `bdd8b15f`.

**Step 0, as the plan asks.** C04's release read from `LANE_QUEUE` rev 67 (Batch State `WAVE_2_C04_RELEASED`). The open pull-request list taken with `gh pr list --state open --json number,createdAt`: #2385 (created 2026-10-13T17:07:57Z) and #2217 (created 2026-10-08T00:43:51Z), both before the Q4 boundary (`c774d21d`, 2026-10-21T18:39:01Z). So the transition wording in the three docs, the `changelog-update` prompt's pre-boundary step and the direct-edit coverage route all stay this chunk, as the plan's "Done when" says; their removal is #2523, filed from this chunk, and the pull request body says so. `lib/wrap-default-pipeline.js`, `lib/wrap-steps/changelog-coverage.js` and `test/wrap-changelog-coverage.test.js` are therefore not edited.

**What changed.** New `test/changelog-fragments-repo.test.js`: `readFragments(REPO_ROOT)` on every test run, failing on any refusal with the file and its code, passing on an empty or missing directory; fixture cases pin both passing states and that a stray `README.md` and a heading-bodied fragment are each named, so the check is not vacuous. CI runs `test/*.test.js`, so this is the fail-closed schema check with no change to `.github/workflows/test.yml`. `docs/release-process.md` gains "Proposed: PR fragment gate (NOT IN FORCE)" carrying the gate C05 would add word for word: which pull requests (a diff under `lib/`, `server.js`, `public/` or `scripts/`), what satisfies it (a name `parseFragmentName` accepts), the `Changelog: none <reason>` escape, fail-closed on unreadable inputs, exit codes 0/1/4, the one `pull_request`-only workflow step, the three things that must happen before it is in force, and that the transition exception ends separately when #2385 and #2217 close. `docs/changelog-fragments.md` and `CONTRIBUTING.md` carry the same heading as a pointer to that one text, so the proposal has one carrier. `lib/wrap-steps/_source-paths.js`: `isSourceFile` refuses the fragment directory by its own constant, `FRAGMENT_DIR_PREFIX`, with the reason inline (a fragment is the log, not work to log or index; coverage names a stray there by its own rule, so nothing weakens). It is deliberately not in `EXCLUDED_PREFIXES`: `features-toc` reads that list to skip tokens when it reports dangling `FEATURES.md` citations, and a cited fragment is exactly the citation that dangles once the release deletes the file, which that report exists to say (the Critic's second warning on the first head, which had put it in the prefix list). `test/wrap-step-source-paths.test.js` pins the constant, that it is not a prefix exclusion, that only the root directory is excluded, and the no-drift list; `test/wrap-step-features-toc.test.js` pins `_isIndexableCandidate` on a fragment, at the handler that a session whose only touched file is a fragment is skipped with `FEATURES.md` untouched, and that a dangling fragment citation is still reported; the first two fail with the exclusion removed and pass with it, run both ways. Two fragments, one per issue as `CONTRIBUTING.md` asks: `changelog.d/1220.c04-fragment-obligation.changed.md` and `changelog.d/2519.features-toc-never-stubs-fragments.fixed.md`. `CHANGELOG.md` and `FEATURES.md` are untouched; their entries are in the pull request body for the Integrator's records PR.

**Decisions the plan text did not settle.** The #2519 fix is a classifier exclusion rather than a filter in `features-toc`'s `_isIndexableCandidate`, because the classifier is the one place both callers read; it is a check of its own inside `isSourceFile` rather than a prefix-list entry, because the prefix list has a second reader in `features-toc` (the dangling-citation report) that must keep seeing the directory. A second fragment for #2519 rather than one fragment naming both issues, because the contributor contract says work on several issues gets one fragment each. The pilot branches (`1220.pilot-a.added.md`, `1220.pilot-b.fixed.md`, the colliding throwaway) are asked of the Integrator in the ready report, as the plan says, and the evidence lands in the pull request body when they merge.

## 2026-10-21 — #1220 C03: a release cut compiles the fragments and stays recoverable until it lands

<!-- prawduct: type=feature | scope=1220-changelog-fragments -->

#1220 C03. v5.35.0 Wave 2 chunk W2-A1, plan r5 (C01 merged as `81891ab3`, C02 as `c774d21d`; Architect A391-R4 approved the C03 design with Safeguards 1, 2 and 3(a)–(e), A394 ruled stray files fail closed), restart token `W2-1220-C03-C774D21D-20261021-4E7A`. Branch `feat/1220-c03-changelog-fragments` from `origin/main` `c774d21d`.

**What changed.** `lib/wrap-steps/version-bump.js`: before `[Unreleased]` is parsed, every fragment under `changelog.d/` is read and spliced into the block in memory, so the bump level, the readiness gate and the promotion read one text; each compiled fragment is staged for deletion (`{primingPath, newContent:null, delete:true, fragment:true}`) beside the promoted `CHANGELOG.md`, and `output.fragments` records what was compiled. Two new halts with `needs-operator` and their own remediation, neither carrying `wouldBump` so the drawer offers no Cut/Hold: a file the fragment contract refuses (named with its code; a skip would promote the block without it), and a leftover `.tangleclaw/release-recovery/<run id>/manifest.json` under the config root (checked before any version or CHANGELOG file is read). `lib/wrap-steps/commit.js`: the flush and the snapshot accept the delete shape, and a target already gone is an error (Safeguard 1); `_realpathOr` resolves a missing path through its real parent so a deleted fragment still matches the realpath toplevel and lands in the commit (Safeguard 2); every release cut, with or without a `releasePrepareCommand`, snapshots its targets' prior bytes and the `git ls-files -s` entries of exactly those targets before the flush, writes both to the recovery record (one file per target plus `manifest.json`, in a directory that ignores itself), and every halt between the flush and a landed commit restores the work tree, and the index entries once `git add` ran, through one builder that says what was put back and what was not; a commit stopped by its timeout restores nothing and names the record; the record is removed after a landed commit or a complete restore and retained otherwise (Safeguard 3(a)–(e)). A release cut commits all of its files or none: a release file the operator left out of the commit, whether every one or only `CHANGELOG.md` beside an included bump and fragment deletion, refuses the commit before anything is branched or staged, puts the cut back and asks for every release file or a Hold (the Critic's R-2: a half cut would consume fragments never published, with nothing refusing the next cut). A path this wrap is authorized to commit that was added to the index this session and then deleted by the flush (porcelain `AD` intersected with the stageable selection: a fragment the session had `git add`-ed before the wrap; never an operator's own left-out or foreign `AD` file, whose real-index entry the untrack route's sync must not touch, the Integrator's finding on the first amendment) stays in the `git add` selection, which removes its index entry, and leaves the commit pathspec, which would otherwise fail on a path known to neither HEAD, the index nor the work tree before any hook ran (Architect A397); the untrack route leaves it out of its temporary-index add and brings the real index level after the commit; a wrap whose only selected paths are such entries skips with nothing to commit, and a release cut in that state (unreachable: its CHANGELOG is always selected) is put back. The commit body gains `- Compiled N changelog fragment(s)` beside the `Bumped` line. `lib/release-readiness.js`: pending fragments pass `unreleased-entries`, a refused set is `unknown`. `lib/wrap-steps/_release-recommendation.js`: the decision is open on pending fragments under an `[Unreleased]` heading, closed without the heading (version-bump would skip) and closed on a refused set. `scripts/release-prepare.js`: refuses while `changelog.d/` still holds a valid fragment. Tests: new `test/version-bump-fragments.test.js` (compile equals hand-written, coexistence, second-run no-op, staged deletions, hold stages nothing, the leftover record, the one spelling of the directory); the refused-fragment halt in `test/version-bump-fail-closed.test.js`; twenty-one real-repository cases in `test/wrap-changelog-transaction.test.js` (the one-commit cut, the release-prepare failure, a failing `git add`, a rejected and a timed-out `git commit`, an untracked fragment whose restore fails, an unrelated edit surviving, pre-existing partial staging put back byte for byte under a failing `git add` and a failing pre-commit hook (the hook's own refusal asserted, A397), a pre-staged new fragment consumed by a successful cut with its bullet under the release heading and the file absent from HEAD, index and work tree, an added-then-deleted-only wrap skipping, the untrack route beside an added-then-deleted path, an unselected foreign `AD` path keeping its real-index entry byte-identical through an approved un-track, a failed index restore, a failing pre-add index read, the all-or-nothing rule with every release file left out and with only `CHANGELOG.md` left out, the symlinked tmpdir); the readiness, recommendation, release-prepare and unreleased-size cases. Docs: `docs/changelog-fragments.md` loses its "not yet wired" note and gains "When compilation happens" in full; `docs/release-process.md` names compilation in the chain, the C02 merge SHA and time on the transition boundary, and the recovery case under "If a release did not go out"; `docs/configuration-reference.md` names the record. New `changelog.d/1220.c03-release-compiles-fragments.changed.md`. `CHANGELOG.md` and `FEATURES.md` are untouched; their entries are in the pull request body for the Integrator's records PR.

**Decisions the plan text did not settle, each narrower than the plan or inside it.** The record directory ignores itself with a `.gitignore` holding `*`, because `_tc-owned-paths.js` names TangleClaw state file by file and is outside this chunk's files; without it a project that tracks `.tangleclaw/` would be asked about the record at every cut. An unmerged index entry (stage other than 0) on a release target refuses the cut before the flush, since `--cacheinfo` can only put stage 0 back. `lib/wrap-steps/preflight.js` was read and not edited: it has no summary of its own to name the record in, and `version-bump`'s refusal is the surface an operator meets first. `_release-recommendation.js` closes the decision on a refused set rather than reading it as open, because `version-bump` stops on that set before any recommendation could matter.

## 2026-10-21 — #1220 C02: the wrap asks for a changelog fragment and accepts one

<!-- prawduct: type=feature | scope=1220-changelog-fragments -->

#1220 C02. v5.35.0 Wave 2 chunk W2-A1, plan r5 (C01 merged as `81891ab3`; Architect A394 settled the C01 contract C02 builds on), restart token `W2-1220-C02-81891AB3-20261021-9C4E`. Branch `feat/1220-c02-changelog-fragments` from `origin/main` `81891ab3`.

**What changed.** `lib/wrap-default-pipeline.js`: the `changelog-update` step declares `changelog.d/` as a second produced path beside `CHANGELOG.md`, and its prompt asks the session's AI for one fragment per issue, `changelog.d/<issue>.<slug>.<type>.md`, with the name grammar, the seven types and the bump each implies, the one-list-entry body rule, and `CHANGELOG.md` named as accepted only for a branch whose pull request predates the project's move to fragments; `version-bump`'s order note now covers the fragments too. `lib/wrap-steps/changelog-coverage.js`: a path directly under `changelog.d/` whose name `parseFragmentName` accepts counts as the changelog being maintained, by the dirty route and the committed-history route alike; a misnamed, nested or stray file there (`README.md` included, which the shared source classifier would call bookkeeping) counts for nothing and is named as unlogged work by the gate's own rule, so it fails closed on it. No `coveragePaths` glob is declared for the directory, because a glob would accept the misnamed file (step 0's finding: the step spec is read for `coveragePaths`, but the glob is the wrong tool). `lib/wrap-steps/ai-content.js`: the default verify reader digests a declared directory (sorted direct entries with kind, size and mtime) instead of reading it as `null`, so a fragment the AI creates is a change to the mutation check and to the file-settle completion signal, which read through the same function; for `changelog.d/` only entries the fragment contract names are listed, so a misnamed file written during the step reads as no change and the predicate names it (the Critic's one substantive finding: the mutation route runs first and would otherwise have passed it); a plain file still reads as its content. Tests: thirteen coverage cases for fragments and the `_isFragmentPath` contract pin, five pipeline-spec cases for the declaration and the prompt, seven reader cases on a real temporary tree including two `run()` end to end with the real reader and real git. Docs: `docs/changelog-fragments.md` gains "How a wrap produces one" and says what the wrap now calls; `docs/release-process.md` "What is still manual" gains the fragment paragraph and the transition boundary; `CONTRIBUTING.md` step 4 becomes "add a fragment", with the subsection table re-keyed by type and the pre-boundary exception. New `changelog.d/1220.c02-wrap-produces-fragments.changed.md`, the first fragment in the repo, written under the contract it enables. `CHANGELOG.md` and `FEATURES.md` are untouched; their entries are in the pull request body for the Integrator's records PR.

**Outside this chunk, filed as #2519.** `features-toc` would stub a fragment as a source file on a project with the feature index on. The fix is a `changelog.d/` exclusion in `lib/wrap-steps/_source-paths.js` or in `features-toc`'s own candidate filter; neither file is in C02's list, and the plan reserved the classifier, so it is filed rather than done.

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
