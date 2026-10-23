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

## 2026-10-23 — #2498 W4-05: the per-file coverage redundancy matrix and the source-reader triage

<!-- prawduct: type=feature | scope=2498-test-pyramid -->

#2498 W4-05. v5.35.0 Wave 4 chunk, plan r2 (W4-01 to W4-04 ticked at dispatch); Refs #2498 and #2371, both open, #2362 untouched. Built on `feat/2498-w4-05-redundancy-audits` from `origin/main` `f0882cae` under the Integrator's W4-05 release (queue rev 228, readback token `W4-05-READBACK-20261023T031435Z-F0882CAE`), on Opus 5.5 after the Operator's model switch. The two audits #2498 Phase 2 asks for, as reports (D4: no test deleted or changed).

**The redundancy matrix.** `scripts/audit-test-redundancy.js` runs each file of a tier (`--tier`) or a named list alone, under its tier's guard and timeout from `scripts/test-stage.js`, with `--experimental-test-coverage --test-reporter=lcov` (zero dependencies, so no `c8`), and keeps each file's product lines: `server.js`, `lib/`, `public/`, `bin/`, `scripts/` lines with a hit count above zero, never the test's own or its helpers'. It reports what each file adds, the exact-subset candidates (add nothing), one greedy set of them retirable together without losing a line (twins are each a candidate, only one goes), and the files that execute no product line. A failed, silent or unparseable run is named, left out (which can only make others look less redundant) and exits 1; runs that all succeed with no product line among them are refused by name (Critic W2: lcov paths in a form the filter does not match would otherwise read as a tier proving nothing, exit 0). The lcov parse is pinned on a report shaped as node 22 writes it, with every malformed or misplaced record refused by line. Measured on the Small tier at `f0882cae`: 249 files in 14.1 s, 5 at a time; 28 candidates, 27 removable together, 90 executing no product line, 107,170 product lines in all. Many candidates execute tens of thousands of lines only by loading a large module, which is the stated limit of line coverage and why the list is candidates, not deletions.

**The source-reader triage.** `scripts/audit-source-readers.js` reuses the W4-04 walker's masking and path resolution to find every `readFileSync`/`readFile` of product source on the file system: bare (destructured), on any name the test binds to `fs`/`fs/promises` (`.promises` included), or on an inline `require('node:fs')`, with the path a literal, a root-constant join (an inline `require('node:path').join` too), a `require.resolve('./…')` or a constant; a helper reading a directory by a literal file name reads that file, a sweep when it names none; a read on any other receiver, or of a path it cannot resolve, is opaque (counted per file, never classified). Classes: guard (non-code files or a sweep; kept), lift (`test/helpers/lift.js` users; kept), regex-of-behaviour (a named `.js` file or `bin/` command), split by runtime proof from the require graph plus spawned entry points: self, other, none; `public/` never counts as loaded. Measured on this chunk's tree in 1.3 s: 233 readers, 12 guard, 81 lift, 140 regex-of-behaviour (47 self, 22 other, 71 none, nearly all `public/`), 827 opaque reads in 168 files. Three rule corrections came from reading the real tree before the tests were written: a helper like `pub('app.js')` had read as a sweep (filed as a kept guard), a root read naming only a document had read as a sweep, and `bin/` commands have no `.js` extension and had read as non-code. The Critic found a fourth (W1 below): reads on a renamed `fs` binding (`fsMod`, `fsNode`, `fsx`) and on an inline `require('node:fs')` were dropped, neither read nor opaque, and the count was 224 before the fix.

**Not the plan's 37.** The plan's W4-05 line names "the 37 measured readers"; neither the plan nor #2498 (207 on its 2026-10-18 snapshot) recorded the rule behind its number. The triage states its rule in the script and on `docs/test-pyramid.md`, and its 233 is by that rule. No requirement moves: the deliverable is the classification, and every reader is classified.

**Follow-ups and records.** Filed after searching open issues: #2548 (the matrix's first consolidation batch) and #2549 (the 69 `self` and `other` readers of `lib/`, `server.js`, `bin/`); the `none` group is `public/` and #1037's territory, cited rather than duplicated. `test/tiers.json` gains the two new test files under `small` (PM ruling via INT: the sole file-list delta, also named in the plan header's standing list). Fragment `changelog.d/2498.w4-05-redundancy-audits.internal.md`; CHANGELOG and FEATURES entries in the PR body for the records PR. Not touched: `.github/workflows/test.yml`, `.prawduct/project-state.yaml`, every gate and rule, every existing test; `PRODUCT_DIRS` in `scripts/_require-graph.js` stays for W4-06.

**Critic dispositions (W4-05: cumulative on e9943e8d, 0 blocking, 3 warnings and 1 note; verify-resolutions on fa09bae4, 0 findings):**

**rev-20261023T033144Z-80bab34f** — scope `2498-test-pyramid`, 2026-10-23T03:33:36Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | fixed | Source-reader triage silently misses reads through an aliased fs binding, so 'every reader is classified' does not hold |
| R-2 | warning | fixed | Fail-closed half fixed in fa09bae4: runs that all succeed with no product line are refused by name (exit 1), pinned by a test with absolute SF paths. A real-spawn test is not added: it would start a process, which the Small guard refuses, and the PM ruling allows only Small rows in test/tiers.json for W4-05. The real run path is exercised by the measured Small-tier run recorded in the PR body. |
| R-3 | warning | accepted | Owed, not skipped: the chunk's full local suite runs under SUITE_SLOT on the exact pushed head next (Rule #271 cl.4) and is recorded with test-evidence record --from-junit before the ready report. |
| R-4 | note | fixed-unreviewed | fixed in `docs/test-pyramid.md` |

**rev-20261023T033710Z-1a0f4d6d** — scope `2498-test-pyramid`, 2026-10-23T03:37:44Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | accepted | Owed by the next step: the full local suite under SUITE_SLOT on the exact pushed head, recorded with test-evidence record --from-junit before the ready report. |
| O-2 | accepted | The inferred chunk is the one this branch builds (W4.05); the record check found nothing. |

## 2026-10-22 — #2498 W4-04: Stage 2, the touched-graph selector that fails closed, and the dead-export audit with its ratchet

<!-- prawduct: type=feature | scope=2498-test-pyramid -->

#2498 W4-04. v5.35.0 Wave 4 chunk, plan r2 (W4-01 to W4-03 ticked at dispatch); Refs #2498 and #2371, both open, #2362 untouched. Built on `feat/2498-w4-04-touched-graph` from `origin/main` `68c4ff0e` under the Integrator's W4-04 dispatch (queue rev 214, restart token `W4-04-20261022T2105Z-68C4FF0E-D22B5E`), the fourth chunk of the five-stage test pyramid: the two require-graph tools on one walker, which tests to run for a diff, and which `lib/` exports nothing reads.

**The walker.** `scripts/_require-graph.js` (a tooling script under `scripts/**`, A416 R1) reads a file's code with strings, comments and regex bodies masked first, resolves `require('./x')` as node does and `require(path.join(ROOT, 'lib', 'x'))` through the file's own root constant (every script here loads `lib/` that way; 55 such requires on `main` resolve as literals), reports a dynamic require with the directory its literal prefix names or with no bound, takes a product path the text names (a source read, a spawned script, a bare literal on disk) as a dependency and walks a named `.js` in turn (a spawned script's requires are the test's), a run-time last segment as a dependency on the directory, and counts a read with nothing literal as opaque. Exports are read from `module.exports = {…}`, `module.exports = value` and `exports.x =`; a reader's use of a module from the shape of its require. Every function takes an io seam, and `test/require-graph.test.js` proves it on an in-memory tree.

**Stage 2.** `scripts/test-touched.js` selects the tests whose graph or named paths reach a changed file (diff against the merge-base with `origin/main` or `--base`, plus the working tree), adds changed tests and the static ring, and with `--run`, or as `node scripts/test-stage.js 2`, runs each tier under its guard with one junit per tier. It fails closed (A416 R4): `dynamic-require`, `not-javascript`, `shared-helper` and `unreached` each exit 1 with the reason named and `ESCALATE: run stage 3`, and the runner then runs Stage 3 whole and says so; no flag accepts a partial selection. `test/test-touched.test.js` pins each reason, the one-file selection, the parser; `test/test-stage.test.js` pins the wiring on a fixture repository (one tier run under its guard, the escalation into Stage 3, a red selection a red stage). Measured here: graph 1,086 files in about 1.1 s; a one-file `lib/test-results.js` change selects 18 tests plus the ring and runs in 41.4 s (Small 0.3 s, Medium 10.5 s, Large 29.5 s); this chunk's own diff escalates on its non-JavaScript files and Stage 3 runs whole in 4.9 s. The Critic's one observation on the first commit (a script a test spawns by path but never requires was not walked, so its `lib/` requires were invisible to the selection) is fixed in the second, which also caught a latent walk bug the new case exposed (a file reached through a named path was marked seen before it was popped, so its own requires were never followed), and narrows the walker's and the audit's file-system catches to the absence codes they mean.

**The audit and the ratchet.** `scripts/audit-dead-exports.js` walks from `server.js`, `bin/tc`, `bin/tc-bridge-helper`, `bin/tc-bridge-receive`, `scripts/*.js`, `test/*.test.js` and every `lib/` module, and reports dead exports, test-only exports with their readers, orphan candidates, and what it cannot audit (opaque modules, modules shadowed by a bounded dynamic require, unbounded dynamic requires). On a clean `git archive` of `68c4ff0e`: 294 modules, 3,251 names, 234 dead, 844 test-only, 163 orphan candidates, 30 `lib/wrap-steps/` modules shadowed by `test/wrap-pipeline.test.js:923`, 0 opaque, 0 unbounded. **Ruled delta (INT ruling, PM concurrence, 2026-10-22, routed under Rule #271 clause 2):** the plan's `--check` "exits 1 on an export with no reader at all" is red on `main` today (234), and D4 forbids deleting in this wave, so `--check` is a ratchet against the tracked `test/dead-exports-baseline.json` (the 234, sorted, unique): red on a new dead export, a stale entry, a missing, malformed, duplicated or unsorted baseline, and graph uncertainty, each named; Stage 1 gains it as its `dead exports` step and reads green with `234 in the baseline, 0 new`. `test/audit-dead-exports.test.js` pins the classification and every red of the comparator. **Second ruled delta:** the plan named `bin/tc.js`, which does not exist; the roots are the three `bin/` commands, and `hooks/*` are shell and load no module. Stage 1 measured 2.2 s with the step (1.2 s of it the audit). Follow-up filed after a search of open issues: #2544, the first dead-export removal batch, citing the baseline; the test-only and orphan batches wait on W4-05's coverage matrix.

**Carried, and what was not touched.** From W4-02: the "under ten seconds" figures in `scripts/test-stage.js` and `test/test-stage.test.js` are gone (the time is printed, the PR carries it), and Stage 1's refusal compares `path.resolve(root)`. Not touched: `scripts/ci-evidence.js`, `scripts/suite-evidence.js` and their `ghRead` copies (the shared helper the W4-03 Critic noted is taken only if this surface is touched; it was not), `scripts/ci-complement.js`'s `decodeXml` citation (next touch), `test/test-tiers.test.js`'s helper-scan cleanup (W4-06). `.github/workflows/test.yml`, `.prawduct/project-state.yaml`, every gate and every rule are unchanged; #2371's activation stays Operator-held. Fragment `changelog.d/2498.w4-04-touched-graph.internal.md`; CHANGELOG and FEATURES entries in the PR body for the records PR; `test/tiers.json` lists the three new test files under `small`.

**Critic dispositions (W4-04: verify-resolutions on 70071404, ce2fcdb5 and 8f21c20f; 0 findings in each, observations answered on the record):**

**rev-20261022T213647Z-aa0581d6** — scope `2498-test-pyramid`, chunk W4.04, 2026-10-22T21:41:08Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | noted | Stage 2 does not walk the require closure of a script a test spawns without requiring it, so a lib change under such a script selects the other readers and silently omits that test |
| O-2 | accepted | The three chunk-ref-missing hits are prose: /index.js is node's resolution suffix, and bin/tc.js is the plan's own recorded delta (2), which names the real bin/ commands the code and test use |
| O-3 | accepted | The three figures are audit and selection counts (test-only exports, tests one module reaches), not suite totals; nothing reads them as a total |
| O-4 | accepted | Designed state: the full local suite runs under SUITE_SLOT on the exact head before the ready report, as every Wave 4 chunk does (plan D3), and its junit is recorded with test-evidence record --from-junit; no record can exist before the Integrator grants the slot |
| O-5 | accepted | --explain is read-only, documented on the page and pinned by test/test-touched.test.js; it is how the opaque-read count the plan asks the walker to report reaches a person |

**No findings** — a clean pass.
**5 observations demoted** — 4 answered. An observation gates nothing; answering one is optional.

**rev-20261022T214625Z-3c2d1ddf** — scope `2498-test-pyramid`, chunk W4.04, 2026-10-22T21:48:37Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | noted | The narrowed catches' propagate branches are unasserted, and one test title claims the assertion it does not make |
| O-2 | accepted | Prose hits: /index.js is node's resolution suffix, and bin/tc.js is replaced by the plan's recorded delta (2); code and tests use the real bin/ commands |
| O-3 | accepted | 479 is the size of one Stage 2 selection (what lib/rule-label.js reaches), not a suite total; nothing reads it as one |
| O-4 | accepted | Designed state: the full local suite runs under SUITE_SLOT on the exact head before the ready report (plan D3) and is recorded with test-evidence record --from-junit; the baseline digest is unchanged across both commits |

**No findings** — a clean pass.
**4 observations demoted** — 3 answered. An observation gates nothing; answering one is optional.

**rev-20261022T215014Z-dc3551a8** — scope `2498-test-pyramid`, chunk W4.04, 2026-10-22T21:51:48Z

_No findings._

_Observations — read, not owed. Answering one is optional._

| Observation | State | Detail |
|---|---|---|
| O-1 | accepted | Prose hits: /index.js is node's resolution suffix, and bin/tc.js is replaced by the plan's recorded delta (2); code and tests use the real bin/ commands |
| O-2 | accepted | Designed state: the full local suite runs under SUITE_SLOT on the exact head before the ready report (plan D3) and is recorded with test-evidence record --from-junit |

**No findings** — a clean pass.
**2 observations demoted** — 2 answered. An observation gates nothing; answering one is optional.


## 2026-10-22 — #2498 W4-03: the #2371 packet, `scripts/suite-evidence.js` undeclared and fail-closed

<!-- prawduct: type=feature | scope=2498-test-pyramid -->

#2498 W4-03. v5.35.0 Wave 4 chunk, plan r2 (W4-01 and W4-02 ticked at dispatch; checkpoint 4 decided); Refs #2498 and #2371, both open, #2362 untouched. Built on `feat/2498-w4-03-suite-evidence` from `origin/main` `1fb99f52` under the Integrator's W4-03 dispatch (queue rev 209, restart token `W4-03-20261022T1958Z-1FB99F52-A141A6`), the third chunk of the five-stage test pyramid and the one that carries #2371: the mechanism by which a green CI run on the exact head could be the suite evidence, written as a command the gate could be pointed at, and the written proposal of the exact cutover. Nothing in it changes what any gate accepts, what any gate runs, what CI does, or what any rule says.

**The command.** `node scripts/suite-evidence.js [--junit <path>] [--base <branch>] [--explain]`, declared nowhere. Its mode comes from the environment and from nothing typed: with `TANGLECLAW_SUITE_EVIDENCE` unset it hands node the declared `test_command` argument for argument (the list `scripts/test-stage.js` owns) and exits with the suite's code; with it set to `ci` it reads the ten facts of `scripts/ci-evidence.js` through that command's own exported step functions, in that command's order, then requires CI's own junit report as the run's `test-results` artifact (of this run and this commit, not expired, not empty, downloaded through `gh run download`, and the whole green report of one run by the identity `lib/test-results.js` pins), runs the complement with its own junit report, reads the tree and the ledger again, and writes the two reports merged into `<path>`: every suite of each verbatim, one more suite carrying the binding facts as `<property>` elements, one trailer summing the two runs plus that suite so the merged document obeys the same identity and reads as one green run. It fails closed: the first fact that does not hold, and an artifact that does not exist, which is the state of every run until the workflow step lands, is a named refusal, nothing is written, and the gate reads red; there is no synthetic report in any path. The artifact is listed before the complement runs, so today's refusal costs no wide run. Any other value of the variable refuses rather than picking a mode. `--explain` reads facts 1 to 8 and lists the artifact, says 9 and 10 need the run, prints the verdict, and runs nothing.

**What is pinned, and what is not touched.** `test/suite-evidence.test.js` (Small, every seam faked) pins the mode selection, local mode's argv byte-equal to the pinned `test_command` text and to this checkout's declaration where one exists, that the declaration still names `node --test` and the workflow still runs it and uploads no artifact (so the cutover cannot ride in unnoticed), each of the ten facts refusing alone and writing nothing, every way the artifact can be missing, the merge on fixtures of the shapes node 22's reporter produces (the `<undefined name="root">` wrapper included), `--explain` in both modes, and that `ci-evidence.js` is reused by import and keeps its own command (`test/ci-evidence.test.js` unchanged and green). `scripts/ci-evidence.js` itself is unchanged: its step functions were already exported. `.github/workflows/test.yml` and `.prawduct/project-state.yaml` are untouched; no rule was proposed through the API.

**The records.** `docs/lane-ci-evidence.md` gains the command's section (modes, the facts table, the merged report's properties, what it does not prove) and its PROPOSED, NOT IN FORCE section is rewritten against the mechanism: the order of the Operator-held steps (workflow step, rule texts at this page's digest, `test_command` line with its test pins, complement verified, one named pilot under a charter amendment, broader use decided from measurement), the Builder ring checkpoint 4 named (Stages 1+2+3, never Medium; no CI tier timing claimed; under-30 s to be measured with Stage 2), and the rule text naming `scripts/suite-evidence.js`, the stage runner and every full-suite exception the earlier text kept. Prawduct no longer has to change first, because the command reaches the gate as `test_command`; the draft report stays the Operator's to send and the page says the draft predates the mechanism. The activation packet, `.tangleclaw/plans/2371-activation-packet.md` (gitignored, hosted by the plans route, digest in the PR body), carries the exact cutover: the unified diff for `test.yml` (one `actions/upload-artifact` step pinned to the commit of `v7.0.2`, `if: always()`, `test-results.xml` as `test-results`, `git apply --check` green against `1fb99f52`), the `test_command` line, Rule #271 and Rule #282 as full replacement texts with only clause 4 and clauses 1/2(d) changed, the charter amendment request, the Operator's two asks, what the pilot would measure, and checkpoint 4 as decided. Fragment `changelog.d/2498.w4-03-suite-evidence.internal.md`; CHANGELOG and FEATURES entries in the PR body for the records PR; `test/tiers.json` lists the new test file under `small`.

**Critic dispositions (cumulative, bedde51c):**

**rev-20261022T201938Z-a55cfc53** — scope `2498-test-pyramid`, chunk W4-03, 2026-10-22T20:23:31Z

| Finding | Severity | State | Detail |
|---|---|---|---|
| R-1 | warning | accepted | The warning is the designed state at this point of the chunk: the full local suite runs under SUITE_SLOT on this exact head (bedde51c) before the ready report, as every Wave 4 chunk does (plan D3, no pilot), and its junit is recorded with test-evidence record --from-junit; no record can exist before the Integrator grants the slot |
| R-2 | note | accepted | The heading is still true: the mechanism reaches the gate as test_command, which is Prawduct accepting the evidence without a change of its own, and the body under it says exactly that. The heading's full text is pinned by test/ci-evidence.test.js ('the proposed rule's heading says it is not in force'), so changing it changes a test contract and the page digest the packet already cites; the Architect's exact-target review can ask for that change if the wording reads as a precondition |
| R-3 | note | accepted | The copy is the cost of a separate gh seam with a per-call timeout (10 s API reads, 120 s artifact download). Exporting ghRead/ID_SHAPE from ci-evidence.js would change that module in a chunk whose contract is that ci-evidence.js is unchanged (its tests prove the command itself unchanged); the two readers are 12 lines and one regex, and a shared helper is W4-04's to take if the require-graph work touches the scripts' shared surface |

**3 findings** (1 warning, 2 note) — accepted: 3.

## 2026-10-22 — #2498 W4-02: the stage runner, Stage 1, and the canonical suite summary

<!-- prawduct: type=feature | scope=2498-test-pyramid -->

#2498 W4-02. v5.35.0 Wave 4 chunk, plan r2 (W4-01 ticked at dispatch); Refs #2498 and #2371, both open. Built on `feat/2498-w4-02-stage-runner` from `origin/main` `f5c6ceb9` under the Integrator's W4-02 authorization (fresh-context token `W4-02-20261022T1759Z-F5C6CEB9`), the second chunk of the five-stage test pyramid: one entry point for the stages and the suite, and the one reader of what a run reported.

**The runner.** `node scripts/test-stage.js <1|2|3|4|5|all> [--junit <path>] [--spec <path|stdout>]`. Stage 1 is static and in-process where a check is a function: every tracked `.js` compiled by `vm.Script` in one process (a `node --check` per file would be a thousand spawns), `conflict-marker-scan`, `assert-strict-guard`, `sync-claude-md-block` in compare mode, `test-tiers --check`, and the three static-ring tests as one child; about a second on this host, each step timed and named. Stage 2 is not built (W4-04) and says so with a non-zero exit, because "ran nothing" must never read as green. Stages 3 and 4 run the tier's files from the ledger under its guard with `--test-timeout=300000`, the value measured at W4-01 and kept until re-measured; stage 5 runs the Large tier bare. `all` hands node the declared `test_command` argument for argument (`test/test-stage.test.js` reads the declaration from `.prawduct/project-state.yaml` and pins the equality), so what the runner runs and what the gate records are one command; `--spec` appends the spec reporter only when asked, and stages 3 to 5 default it to stdout so a person sees the failing test. An empty tier runs nothing and says so: `node --test` with no files discovers its own, which would be the whole suite. Stages 3 + 4 + 5 are pinned equal to `test/*.test.js`.

**The reader, and the one plan delta.** The plan had `lib/test-results.js` refuse a report whose leaf count and summary "disagree by more than the file-level failures node reports as testcases", the exact rule to be pinned by a fixture. Measuring every shape node 22's junit reporter produces pinned an identity, not a tolerance: testcases + testsuites in the report equal tests + suites in the runner's summary. A `test()` with subtests is a test to the runner and a `<testsuite>` to the reporter; a `describe` whose body threw and a skipped `describe` are suites to the runner and `<testcase>`s to the reporter; each moves both sides by one, and the last full suite run obeys it (22,114 + 4,117 = 22,120 + 4,111). So `reconcile` refuses a report that breaks the identity, a report with no summary, and a summary whose outcomes do not sum to its `tests`; it reads red from the summary's `fail + cancelled`, and from a `<failure>` element the summary does not count, which is what a `describe` body that threw looks like: node reports `fail 0` and exits 0 for it, and the stage exits 1. The number the plan called `canonicalCount` is the reconciliation's `canonical`, the runner's `tests`: the canonical count is the summary's and never the leaf tally's, which is printed beside it. The junit reporter writes the summary as trailing comments (measured), so `summaryOf` reads a spec log, a TAP log or the report itself, and a run with `--spec <path>` is read from the spec log and pinned equal to the trailer.

**The move.** `parseJunit`, `decodeXml` and `attr` moved whole from `scripts/test-skip-audit.js` to `lib/test-results.js`; the audit re-exports `parseJunit`, so its readers are unchanged (`ci-complement.js` and `ci-evidence.js` import only the ledger functions, and `ci-complement.js` keeps its own narrower walker as before). `docs/areas.json` lists the new module under `tooling`, keeping the map total. `test/test-results.test.js` (Small) pins the tally, the three summary spellings, every measured shape and each refusal on fixtures; `test/test-stage.test.js` (Large) pins the argv contracts, Stage 1 green on this repository with every step named (its wall time is the pull request's measurement, not a contract a Large file can hold under `all`), and a real run on a fixture repository, through the real reporter, where stage 3 is green with a test with subtests and a describe skipped by option, and stage 5 and `all` are red on a describe that threw although node exited 0. Stage 1 is bound to this repository and says so: the `root` seam serves the test-running stages only, because the syntax step reads what git tracks here and the ledger check measures this repository's `test/` whatever ledger it is handed. `docs/test-pyramid.md` gains the stages and the reconciliation; `CONTRIBUTING.md` the stage commands; fragment `changelog.d/2498.w4-02-stage-runner.internal.md`; CHANGELOG and FEATURES entries in the PR body for the records PR. `test_command`, CI and every gate are unchanged; the tier timings are in the PR body, from the runs.

## 2026-10-22 — #2498 W4-01: the test tier ledger, its classifier and the Small/Medium guards

<!-- prawduct: type=feature | scope=2498-test-pyramid -->

#2498 W4-01. v5.35.0 Wave 4 chunk, plan r2 (sha256 `d2bd7814` at dispatch, no chunk ticked); Refs #2498 and #2371, both open. Built on `feat/2498-w4-01-tier-ledger` from `origin/main` `598ab72e` under the Integrator's W4-01 authorization (queue revision 181), the first chunk of the five-stage test pyramid: the declaration of which tier each test file is in, the tool that proposes and checks it, and the guards that make the tiers true at run time.

**What a tier is, and the one plan delta.** `test/tiers.json` lists every `test/*.test.js` exactly once under `small` (starts no subprocess, opens no `node:sqlite` database, listens on no socket), `medium` (starts no subprocess) or `large` (anything). The plan wrote the guards as refusing the *require*; they refuse the *act*. The first guarded run showed why: a hundred-odd files that never spawn load a product module (`lib/exec.js`, `lib/caddy.js`, `lib/store/_db.js`) that requires `child_process` or `node:sqlite` at its top, and refusing the load would have made them Large for nothing they do. So `test/helpers/preload-small.js` hands back `child_process` with every spawner replaced by a refusal and `node:sqlite` with a refusing `DatabaseSync`, and makes `net.Server.prototype.listen` refuse; `test/helpers/preload-medium.js` does the first of those only. A refusal names the act, the calling line and the test file, is announced on stderr as well as thrown, and fails the file even when product code catches the throw and degrades (a failed `git remote` read as "no origin" would otherwise let a test pass for the wrong reason): the guard counts refusals and exits the file's process non-zero, which the runner reports as the file failing. Routed to the Integrator as an unplanned choice before the suite, with both measurements.

**What the guarded runs found.** Under the Medium guard most server-booting tests made a refused spawn, nearly all from `lib/tmux.js`'s `execSync` probes, `lib/engines.js`'s engine-CLI probes and `lib/dir-scanner.js`'s `fork`: a test that boots the server is Large today because the boot path spawns, not because it tests a subprocess, and the ledger records that rather than hiding it; making those probes injectable is product work for a later chunk. One such file waited forever after the refusal instead of failing, so a guarded tier is run with `--test-timeout`, which the page says and the stage runner (next chunk) will carry.

**The classifier and the contract.** `scripts/test-tiers.js --propose` names the fastest tier a file's text allows, following its requires of other files under `test/` (a helper that spawns makes its callers Large) and never into `lib/`; a spawner call counts only in a file that also binds `child_process`, because the first rule read `re.exec(` and SQLite's `db.exec(` as spawns and over-pinned 82 files as Large until the Critic's review named it, after which the ledger was regenerated and every demotion re-earned by the guarded runs; `--write` regenerates the ledger from the scan and keeps every declaration slower than the scan allows, which is how a file the guard refused stays demoted; `--check` refuses a ledger that is not total (a file missing, listed twice or gone) or that declares a file faster than its text allows, naming each failure; `--list <tier>` prints a tier's files for the runner. The ledger's first contents are the scan corrected by the guarded runs; the counts are `--check`'s output, and a tier's time is its guarded run's, both in the pull request rather than here. `test/test-tiers.test.js` pins the scan on fixtures, the ledger's totality and honesty, the tracked ledger itself, and each guard's refusals in a real `node --test` child, the swallowed one included. `docs/test-pyramid.md` is the page; fragment `changelog.d/2498.w4-01-tier-ledger.internal.md`; CHANGELOG and FEATURES entries in the PR body for the records PR; the stage runner, `test_command`, CI and every gate are unchanged.

## 2026-10-22 — #2248 Wave 3 Part 1 records

<!-- prawduct: type=chore | scope=2248-area-extraction -->

Wave 3 Part 1 shipped eleven extraction chunks: S01 #2528 (`f480a783`), T01 #2529 (`938ca75b`), T02 #2530 (`179ae6c8`), T03 #2532 (`832860a2`), T04 #2533 (`b9161364`), S02 #2534 (`2aaa0b68`), S03 #2535 (`81f7bdd2`), S04 #2536 (`b5b15507`), S05 #2537 (`6887a658`), S06 #2538 (`7204ba38`) and S07 #2539 (`ca2852f7`). Each chunk has its own fragment and PR evidence; this records step adds no duplicate fragment. The final S07 merge passed exact-head CI, static and route/export checks, independent review and a local suite with JUnit evidence ingested. The S07 scratch rehearsal caught a missing `workloadSentence` import before tracked edits, and the merge review corrected the PR body's nested JUnit count to distinguish it from the runner total.

`FEATURES.md` now describes the route kernel, area map and remaining facade accurately and re-points prose that still placed moved setup, config and launch-recovery routes in `server.js`. `CHANGELOG.md` remains the released/unreleased compiler output; the eleven existing `changelog.d/2248.*.internal.md` fragments carry these changes into the next release. Checkpoint 3 reads `docs/areas.json` against `server.js` and `lib/store.js`: both files remain shared, with sixteen held areas (sessions, launch, openclaw, setup, projects, control, shared-docs, auth, session-rules, medusa, ports, system, engines, update, checkouts and bridge). #2248 stays open for Part 2 under a separate plan and PM roadmap ruling.

## 2026-10-22 — #2248 S07: the tc route family out of server.js

<!-- prawduct: type=chore | scope=2248-area-extraction -->

#2248 S07. v5.35.0 Wave 3 chunk W3-A1, plan r2 (sha256 `9b715715` at dispatch, S01, T01, T02, T03, T04, S02, S03, S04, S05 and S06 ticked); Part of #2248, which stays open for Part 2. Built on `feat/2248-s07-tc-routes` from `origin/main` `7204ba38` under dispatch token `W3-S07-2248-7204BA38-9B715715`, with the seam accepted by the Integrator before the move (seven step-0 rulings, Option A for the check watches) and the move rehearsed on a scratch copy of the tree first.

**What moved, unchanged.** `lib/routes/tc.js` holds the family's twenty-four routes inside a `register(deps)` called where the family's first route stood — the launch sequence (`POST start/next`, `POST start/ready`, `GET start/status`, `GET start/review`) and the rules-delivery receipt (`POST rule-receipt`); the lane's own workload (`POST`/`GET workload`) and the operator's narrowing (`POST workload/narrowing`); the governed coordinator rotation (`rotation/prepare`, `GET rotation`, `advance`, `resume`, `relaunch`, `abandon`) with the operator's reads that share its helpers (`GET /api/rotations`, `GET`/`POST /api/coordinator-roles`, `POST /api/coordinator-roles/revoke`); `GET whoami` and `GET sessions`; and the four check watches (`POST`/`GET check-watches`, `GET check-watches/:id`, `POST check-watches/:id/cancel`, #2323, which postdate the plan and were ruled in by the Integrator as a scope delta so that no tc route remains in the entry point) — and at module level in the order they held: `_launchIdentity`, `_rotationAccess`, the capability rows (`_provenanceCapability`, `_startupControlCapability`), the binding verdict and awareness receipt (`_admittedAs`, `_whoamiBinding`, `awarenessVerbLabel`, `resolveClaimedProject`, `writeAwarenessReceipt`, `recordTcAwareness`), the lane composition (`_composedLane`, `_laneRotation`) and the check-watch wrapper (`checkWatchRoute`). The family sat in three regions of `server.js` around the operator bridge's HTTP surface and the merge-queue routes, which stay; the single register call puts the rotation routes ahead of the bridge's and the check watches at the family's end, a route-order change across non-overlapping families that the reachability test accepts, with the route set and every registration option identical. The coordinator epoch gate (`coordinatorGateRefused`) and `_engineThread`, which it asks, moved whole to `lib/routes/_callers.js` beside the caller proofs, because the session-rule, Medusa, control, wrap and session-command mutations all apply the one gate; `server.js` takes it from the callers module on its existing destructure, so its fifteen call sites and the two `deps` injections into the wrap and session families are unchanged lines. The callers module now requires `control-auth` and `coordinator-rotation` eagerly, which brings the store into a module that so far held only the gate and access readers; it changes no load, since the entry point loaded all of it before. `register(deps)` receives the one server-local value the family reads, the activity observer, held in the module for the lane composition, which the entry point reads back for the bridge's lane reader beside the dispatcher's admission fields and awareness receipt. Four requires whose only readers moved left `server.js` (`./lib/workload`, `./lib/workload-fleet`, `./lib/ecosystem-primer`'s `workloadSentence`, `./lib/check-watch-api`).

**What stayed, and the map.** `_startupControlForLaunch`, which the plan listed with this family, stays in `server.js` with its only reader, `GET /api/launch-sequences` (the Integrator recorded the plan correction). The dispatcher's awareness interception, which skips `whoami` by name and records every other tc verb through the imported `recordTcAwareness`, is dispatcher plumbing and stays. `tc` leaves `docs/areas.json`'s `shared.holds` and the `tc` area owns the new file beside `lib/tc-verbs.js`.

**Text readers and records.** No test pins moved text: the plan's two named readers (`test/tracked-carrier-identity.test.js`, `test/api-medusa.test.js`) grep `server.js` for shared-docs routes and boot order, both outside the regions, and the step-0 literal scan of the three regions against all 46 `server.js` text readers ran before the first narrow run. The scratch rehearsal caught one missed name — `workloadSentence`, read inside a template literal the code-only scan had stripped — before any tracked edit. Fragment `changelog.d/2248.s07-tc-routes.internal.md`; three FEATURES anchors moved (`_provenanceCapability`, `_whoamiBinding`, `_admittedAs`); CHANGELOG and FEATURES entries in the PR body for the records PR.

## 2026-10-22 — #2248 S06: the config route family out of server.js

<!-- prawduct: type=chore | scope=2248-area-extraction -->

#2248 S06. v5.35.0 Wave 3 chunk W3-A1, plan r2 (sha256 `8fb0ec79` at dispatch, S01, T01, T02, T03, T04, S02, S03, S04 and S05 ticked); Part of #2248, which stays open for Part 2. Built on `feat/2248-s06-config-routes` from `origin/main` `6887a658` under dispatch token `W3-S06-2248-6887A658-8FB0EC79`, with the seam accepted by the Integrator before the move and the Architect's exact-head seam review required before merge (plan checkpoint 1, A404).

**What moved, unchanged.** `lib/routes/config.js` holds the two `/api/config` routes (`GET`, `PATCH`) inside a `register(deps)` called where the family stood, together with the one helper that reads a handed-over name (`_withBindState`, which asks the ingress door for the bind state), and at module level in the order they held: the secret redaction (`redactConfigSecrets`), the install's prior-use answer fixed once at boot with its test seam (`_bindPriorUse`, `_installPriorUse`, `_setInstallPriorUse`), the protected roots (`_protectedRoots`) and the Master-settings validation (`_masterTightenedBlindError`, `validateMasterPatch`). The prior-use binding moved whole with both its readers because nothing outside the family touches it directly: boot reads the answer through `_installPriorUse`, imported from the module, and `server.js` re-exports `_setInstallPriorUse` as the same function, so its export surface is unchanged and the two tests that reset the seam are untouched. One line inside the moved validation changed on purpose: the lazy `require` of the startup-dialog identity check is module-relative, so its path moved with the file. `register(deps)` receives the two helpers other families still share: `_decideSetupCredential` (also the setup finish) and `_gateIngress`. Three requires whose only readers moved left `server.js` (`./lib/git-hooks`, `./lib/git-template`, `./lib/tcc-folders`).

**What stayed, and the map.** The setup credential decision and the auth gate's Host-allowlist carve-out, which names `/api/config` as the wizard's Skip terminator, are dispatcher-side and stay in `server.js`, so `setup` stays in `docs/areas.json`'s `shared.holds` (Integrator ruling); `config` leaves it, because every route and helper of the family moved, and the `config` area owns the new file.

**Text readers and records.** One test pins moved text by reading source and now reads the module: `test/bind-policy-wiring.test.js` (the Integrator recorded this re-point as an authorized S06 scope delta beyond the plan's four named readers, none of which needed one) — the PATCH grace-state and allowed-fields pins, the GET bind-state pin and the prior-use count read `lib/routes/config.js`, and the every-gate-state-read sweep now reads `server.js` and every module under `lib/routes/` with its premise and assertions unchanged. The step-0 literal scan of the region against all 46 `server.js` text readers ran before the first narrow run. Fragment `changelog.d/2248.s06-config-routes.internal.md`; one FEATURES anchor moved (`validateMasterPatch`); CHANGELOG and FEATURES entries, and the FEATURES prose that still places the protected-roots builder in `server.js`, in the PR body for the records PR.

## 2026-10-22 — #2248 S05: the setup route family out of server.js

<!-- prawduct: type=chore | scope=2248-area-extraction -->

#2248 S05. v5.35.0 Wave 3 chunk W3-A1, plan r2 (sha256 `9f006f13` at dispatch, S01, T01, T02, T03, T04, S02, S03 and S04 ticked); Part of #2248, which stays open for Part 2. Built on `feat/2248-s05-setup-routes` from `origin/main` `b5b15507` under dispatch token `W3-S05-2248-B5B15507-9F006F13`, with the seam accepted by the Integrator before the move and the Architect's exact-head seam review required before merge (plan checkpoint 1, A404).

**What moved, unchanged.** `lib/routes/setup.js` holds the seven `/api/setup/*` routes (`GET https-check`, `GET ingress-state`, `GET provision-status`, `POST generate-cert`, `POST scan`, `POST create-dir`, `POST complete`) inside a `register(deps)` called where the family stood, and at module level in the order they held: the two test seams the family alone reads — `_scheduleRestart` with `_setRestartScheduler`, `_spawnCutover` with `_setCutoverSpawner` — and the host-list validation `HOST_RE` and `_certHostListArg`. The seams moved whole, live bindings and setters together, because a `deps` destructure would capture the load-time default and the tests that swap the scheduler do so after load; `server.js` re-exports both setters from the module as the same functions, so its export surface is unchanged and the five tests that call them are untouched. `register(deps)` receives the three helpers other families still share: `_decideSetupCredential` (also the config route's Skip path), `_gateIngress` and `_signIn`. One require whose only readers moved left `server.js` (`./lib/ingress-provision`).

**What stayed, by the plan.** The setup credential decision, the Host-allowlist carve-out for setup routes while setup is open, and the setup-transition guard inside `PATCH /api/config` are shared with the config and auth families and stay in `server.js`; `setup` therefore stays in `docs/areas.json`'s `shared.holds` (Integrator ruling), while the `setup` area owns the new file.

**Text readers and records.** Two tests pin moved text by reading source and now read the module: `test/api-auth-session.test.js` finds the setup finish among the four signing-in routes in the file that holds it (the Integrator recorded this re-point as an authorized S05 scope delta beyond the plan's one named reader), and `test/setup-provisioning.test.js` matches the cutover-failure log redaction in the module. The step-0 literal scan of both regions against all 47 `server.js` text readers ran before the first narrow run. Fragment `changelog.d/2248.s05-setup-routes.internal.md`; CHANGELOG and FEATURES entries in the PR body for the records PR; no FEATURES anchor moved.

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
