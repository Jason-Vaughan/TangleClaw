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

## 2026-10-23 — W5-REL: prepare v5.35.0

<!-- prawduct: type=chore | scope=w5-rel-release-5.35.0 -->

v5.35.0 release chunk W5-REL, under the batch charter (sha256 `b87fd37a…f98b97`) and the corrected sprint plan (sha256 `edb64f45…3d87ab`), released by the Integrator at queue rev 249. Branch `chore/release-5.35.0` from `origin/main` `1e608f28`. Prepared as a DRAFT pull request: marking it ready, merging, tagging and deploying are held until the Operator authorizes the release cut, relayed by the PM.

**What changed.** `version.json` goes from 5.34.0 to 5.35.0, a minor bump because the compiled section holds Added and Changed entries and no `BREAKING` marker. `CHANGELOG.md`: the 24 fragments under `changelog.d/` were compiled into `[Unreleased]` with `lib/changelog-fragments.js` (`readFragments`, `compileFragments`, `spliceIntoUnreleased`), and that body promoted to `## [5.35.0]` with `version-bump`'s own `_promoteUnreleased`, leaving `[Unreleased]` empty, as a wrap's release cut does; the 24 fragment files are deleted. The heading was first stamped 2026-10-22, `version-bump`'s local-date convention read on this host in PDT, and restamped `2026-10-23` on the PM's authorization once the local date had turned; the lock hashes only the body below the heading, so its `5.35.0` line is unchanged. `node scripts/release-prepare.js` exited 0 and only added: the two `README.md` clone pins now name `v5.35.0`, and `test/fixtures/changelog-released-sections.lock.json` gains the `5.35.0` line. The extracted release notes are 13,588 of the gate's 120,000 bytes (`node lib/changelog-notes.js 5.35.0`, `node scripts/release-notes-gate.js`). `docs/releases/v5.35-status.md` is new, marked pre-publication: the delta range `v5.34.0` `da4b3afe` to `1e608f28` with each count's command, the three finish lines as true at this head (prepared, not yet released; not yet deployed; activation pending the deploy), Waves 1 to 4, schema 68 unchanged with the same migration chain, and every open or Operator-held item as it stands.

**Upgrade rehearsal.** The Integrator asked for one because Wave 3 moved the store's code into modules. A `sqlite3 .backup` copy of the live store was opened by `c3546e63`'s own `lib/store.js` in a private scratch directory with `TANGLECLAW_HOME` pointed there, never by `server.js`. Schema 68 to 68 with no migration run, integrity ok, no foreign-key violations, no bridge schema problems, no table added or lost, and no row count changed. A second open changed nothing. The scratch directory was deleted and confirmed gone; only counts and verdicts were recorded.

**Not touched.** No code, workflow, rule or issue. `docs/tc-cli-reference.md` still reads "Applies to: TangleClaw 5.34.0", and `release-prepare.js` does not move that line; it is outside this chunk's lock and is left for a follow-up.

Merging this pull request publishes v5.35.0 through `release.yml`, which tags the merged commit; nobody tags by hand. This chunk makes no deploy or restart.

## 2026-10-23 — #2498 Wave 4 records

<!-- prawduct: type=chore | scope=2498-test-pyramid -->

Wave 4 (v5.35.0) shipped six chunks of #2498, each with Architect exact-target acceptance and the Integrator's Merge Gate: W4-01 #2541 (head `0aa96a83`, merge `f5c6ceb9`, A417), W4-02 #2542 (`9f0a749f`, `1fb99f52`, A419), W4-03 #2543 (`2ddbce3b`, `68c4ff0e`, A420), W4-04 #2545 (`729eba52`, `f0882cae`, A421), W4-05 #2550 (`442303b4`, `49a5f096`, A422) and W4-06 #2551 (`1879857a`, `780ad331`, A423). #2498 closed on W4-06. #2371 stays OPEN: `scripts/suite-evidence.js` is built but declared nowhere, and its cutover (the workflow step, the gate declaration and the rule texts in the activation packet) is Operator-held. #2362 is untouched and OPEN. The consolidation work the audits found is #2544, #2548 and #2549.

`FEATURES.md` gains one "Test pyramid" entry under CLI / Tooling, with the ledger and guards, the stages, Stage 2, the audits, the Testament manifest and the proposed CI evidence path; the chunk PRs' FEATURES copy is folded into it. `CHANGELOG.md` and the six `changelog.d/2498.*.internal.md` fragments are left for release preparation, and no records fragment is added, because one would repeat them. Three earlier entries are corrected in place, as their chunks carried forward: W4-02's sentence on how `test/test-stage.test.js` pins the declared `test_command` (fixed in `9f0a749f` after CI's clone had no `.prawduct/project-state.yaml`), W4-05's finding labels (R-1/R-2, not W1/W2), and W4-06's record now says `PRODUCT_DIRS` was removed. The live log was past prawduct's archive threshold, so `prawduct-hook archive-change-log --apply` moved every entry but the newest two and one pinned entry, W4-01 to W4-05 among them, verbatim into `.prawduct/change-log-archive/2026-10.md`.

## 2026-10-23 — #2498 W4-06: `.testament.toml` generated from the tier ledger, and the test-pyramid docs finished

<!-- prawduct: type=feature | scope=2498-test-pyramid -->

#2498 W4-06, the last chunk of v5.35.0 Wave 4, plan r2 (W4-01 to W4-05 ticked at dispatch); Fixes #2498, Refs #2371 (open, proposed, Operator-held); #2362 untouched. Built on `feat/2498-w4-06-testament-manifest` from `origin/main` `49a5f096` under the Integrator's W4-06 release (queue rev 239, readback token `W4-06-READBACK-20261023T043335Z-49A5F096`), with two PM rulings relayed in the dispatch: `scripts/_require-graph.js` may only lose its unused `PRODUCT_DIRS` constant and export, with no graph behaviour change; and the PR may say `Fixes #2498` citing the existing #2544/#2548/#2549 and the Operator's pool setup, with no new Stryker or Testament-pool issue (this supersedes the plan's W4-06 completion mapping, which filed three).

**The manifest.** `node scripts/test-tiers.js --testament` writes `.testament.toml` (`manifest_version = 3`, `executor = "host"`, `env_inputs = [".node-version"]`, `batch_timeout_s = 1800`, `[setup] steps = []`) with one `files` suite per tier, its `files` the tier's paths from the ledger, and its `command` the stage runner's own `tierArgv` for the tier (guard and `--test-timeout` for small and medium) with `--test-concurrency=1` and Testament's `{files}`/`{junit}` placeholders, `one_file_per_process = true`. Taking the command from `scripts/test-stage.js` means a pool batch runs a tier exactly as its stage does; the generator loads the stage runner lazily because the stage runner loads this module at its top. An empty tier is refused by name rather than written, since Testament refuses a `files` suite with no files. `--check`, which Stage 1 runs, fails when the manifest is missing or differs from the generated text by one byte.

**What was verified and what was not.** The tracked manifest was read without error by Testament's own `manifest.py` and `files` adapter at v0.9.0, the tag the plan was written against, and at v0.12.1, the newest tag today. Testament's collector, run over `git ls-files`, put each test file in exactly one suite, and the three suites together equal `test/*.test.js`. The batch command it renders for the first file of each tier ran under node here (exit 0, junit written). No Testament run happened: `testament` is not installed on this host and no pool exists (D5). `test/test-tiers.test.js` pins the generator with a reader for exactly the TOML subset it writes, which throws on anything else: the tracked manifest's suites are the ledger, their union is the suite, each command equals the stage-derived one, the env input exists, and `--check` refuses a missing or hand-edited manifest that `--testament` then restores. The same file gains the Architect's A417 note: the helper-scan block's temp directory is removed in `after()` (24 `tc-tier-*` directories in the temp dir before a run and after).

**Docs.** `docs/test-pyramid.md` gains the manifest section: each key and why, what was checked, and the Operator's pool setup in Testament's own commands (CLI install, prompt-free SSH aliases checked with `ssh -o BatchMode=yes`, the tailnet, `coordinator install`, `runner add` with Node 22/git/tmux on the runner, the macOS Local Network approval, `projects allow tangleclaw --executor host` plus the owner secret, `invite`/`join`, then `testament onboard`). The queue's wording names `testament init`, but neither tag has such a command, so the page says so and documents the real sequence. Testament's agent-instructions block is deliberately not added to `CLAUDE.md`: it would send every session's tests through Testament, which is the lane rules' decision. The Stage 1 row and the classify/regenerate steps now name the manifest, and the audits' paragraph says `442303b4` instead of "this chunk's tree" (W4-05 PR review note). `CONTRIBUTING.md`'s stage list gains Stage 2 and the dead-export step and loses the stale "Stage 2 is not built yet" line, replaced by how to declare a new test file and regenerate the manifest. `FEATURES.md` has no script index to anchor, `data/*-guide.md` and `CLAUDE.md` need no pointer, and `test/tiers.json` is unchanged (no new test file).

**Records.** Fragment `changelog.d/2498.w4-06-testament-manifest.internal.md`; CHANGELOG and FEATURES entries in the PR body for the records PR. `scripts/_require-graph.js` lost the unused `PRODUCT_DIRS` constant and its export, which nothing read; `BARE_PATH` and the graph's behaviour are unchanged. Not touched: `.github/workflows/test.yml`, `.prawduct/project-state.yaml`, every gate and rule, every existing test's assertions.

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
