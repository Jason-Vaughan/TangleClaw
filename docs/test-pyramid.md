# The test pyramid: tiers, the ledger and the guards

*Built for #2498. This page covers the three tiers a test file can be in, the ledger that
declares them, the guards that enforce them, how to classify a new test, the stage runner that
runs a tier or the whole suite as one command, how a run's count is read, the touched-graph
selector that is Stage 2 and the reasons it refuses, the audits a consolidation wave reads, and
`.testament.toml`, the manifest that lets a pool of machines run the tiers.*

## Why tiers

The suite is one `node --test 'test/*.test.js'` of about 700 files that takes about 19 minutes
on a laptop. Most of that time is a minority of files: the ones that start subprocesses, drive
real tmux servers, clone git repositories and wait on timers. A test that is pure in-process
JavaScript runs in milliseconds, but nothing told it apart from one that spawns, so nothing
could run only the fast ones with any confidence that "fast" meant anything.

A tier is a promise about what a test file **does** at run time. It is not about what the
file loads: a product module may `require('child_process')` at its top, as `lib/exec.js` does,
and a test that never asks it to spawn keeps its promise.

| Tier | The promise | Google size | What it buys |
|---|---|---|---|
| `small` | starts no subprocess, opens no `node:sqlite` database, listens on no socket | Small | runs anywhere in seconds; the Builder's inner loop |
| `medium` | starts no subprocess | Medium | portable across runners; no tmux, no CLI, no timing flake from a child |
| `large` | anything | Large | the system tests; the slow, host-bound slice |

## The ledger: `test/tiers.json`

The declaration is one tracked file, `test/tiers.json`, with three sorted arrays of test file
paths. It is reviewed like code, because it is a contract: every `test/*.test.js` is in it
exactly once, so the three tiers together are the suite, nothing more and nothing less.

`node scripts/test-tiers.js --check` refuses a ledger that breaks the contract, naming every
failure:

| Failure | Means |
|---|---|
| `not in the ledger: <file>` | a test file exists that no tier declares; add it (`--propose` says where) |
| `listed twice: <file>` | a file is in two tiers |
| `in the ledger but not in the suite: <file>` | a declared file was renamed or removed |
| `declared <tier> but its text allows no faster than <tier>: <file>` | the file's own text (or a helper it loads) calls something its declared tier forbids |
| `"<tier>" is not sorted` | the array is out of order; `--write` sorts |

Declaring a file **slower** than its text requires is always allowed. That is how a file is
demoted when the guarded run shows that product code it calls starts a process or opens a
database, which no text scan of the test can see.

## The guards: `test/helpers/preload-small.js`, `test/helpers/preload-medium.js`

A tier's promise is enforced at run time, not described, and it is **action-based**: a guard
refuses a spawn, a database open or a listen at the call, never at the require of the module
that could make one. Each guard is a preload for `node --test --require`, which the runner
carries into the child process it starts per file:

```bash
node --test --require ./test/helpers/preload-small.js  $(node scripts/test-tiers.js --list small)
node --test --require ./test/helpers/preload-medium.js $(node scripts/test-tiers.js --list medium)
node --test                                            $(node scripts/test-tiers.js --list large)
```

The Small guard replaces every `child_process` spawner (`spawn`, `exec`, `execFile`, `fork`
and their sync forms) with a function that refuses, replaces `node:sqlite`'s `DatabaseSync`
with a constructor that refuses, and makes `net.Server.prototype.listen` refuse, which covers
every server kind. The Medium guard does the first of those only. A refusal throws, naming the
act, the calling line and the test file.

**A refusal fails the file even when the throw is swallowed.** Product code often catches a
failed spawn and degrades: a `git remote` that fails reads as "no origin", a `ps` that fails
reads as "not running". A test of that path passes under the guard for the wrong reason, so the
guard also counts refusals and exits the file's process non-zero, which the runner reports as
the file failing, with one line naming the file and the count:

```text
[tier-guard] small tier: child_process.execFileSync is forbidden here (called from lib/git-probe.js:41 in test/x.test.js); declare the file medium or large in test/tiers.json
[tier-guard] 1 refusal(s) in test/x.test.js: the file is not small; declare it medium or large in test/tiers.json
```

The guards refuse at the seam, never by reading text: a product module that spawns three
requires down is caught the same as a test that spawns directly.

**Run a guarded tier with `--test-timeout`.** A refused spawn is a thrown error, and product
code that was waiting for the process it never got can wait forever (one integration test
awaits a readiness that a refused `tmux` probe would have produced). Without a timeout the
runner's child process sits, and the tier never reports. A timeout turns that into a
cancelled test that names the file, which is the demotion signal. The value is per file and
must clear the slowest honest file *under load*: `test/check-watch-monitor.test.js` runs in
10 s alone and past 120 s when the Medium tier's files share the host, so a guarded tier is run
with `--test-timeout=300000`, which `scripts/test-stage.js` carries for stages 3 and 4; re-measure
before lowering it.

**Where the refusals come from.** When the ledger was first written, the files the Medium
guard demoted were almost all server-booting tests: the refused calls were `lib/tmux.js`'s
`execSync` probes, `lib/engines.js`'s engine-CLI probes and `lib/dir-scanner.js`'s `fork`.
A test that boots the server is Large today not because it tests a subprocess but because the
boot path spawns one; making those probes injectable is what would move such tests back to
Medium, and that is product work, not a ledger edit.

## Classifying a test

- **A new test file:** `node scripts/test-tiers.js --propose test/new.test.js` prints the
  fastest tier its text allows. Add it to that tier in `test/tiers.json` (sorted), then run
  the tier under its guard. If the guard refuses, move the file down one tier and say why in the
  commit. Then `node scripts/test-tiers.js --testament` to carry the change into
  `.testament.toml`. `--check` fails CI until the file is declared and the manifest regenerated.
- **The scan:** `scripts/test-tiers.js` reads the file's text with comments removed and
  follows its requires of other files under `test/` (helpers, fixtures), so a helper that
  spawns makes every test that loads it Large. It does not follow into `lib/`: that is the
  guard's job, and a text scan of the product would be a second require graph nobody
  maintains. A call to a spawner marks Large; opening a database, listening, serving,
  fetching, or loading the store facade or the server marks Medium. A bare
  `require('child_process')` marks nothing, because the guard refuses the call, not the load.
- **Regenerating:** `node scripts/test-tiers.js --write` rebuilds the ledger from the scan and
  keeps every existing declaration that is slower than the scan allows (the demotions the
  guarded runs earned); `--testament` then rewrites the manifest from it.

## The stages: `scripts/test-stage.js`

One entry point runs a stage, or the whole suite, and prints its wall time:

| Stage | Command | What it runs | Who runs it |
|---|---|---|---|
| 1 | `node scripts/test-stage.js 1` | static: every tracked `.js` parses (in-process, `vm.Script`), no conflict markers, no bare `node:assert`, the CLAUDE.md block in sync, the tier ledger total and `.testament.toml` generated from it, no `lib/` export dead past the baseline, the three static-ring tests | everyone, before every push; about two seconds |
| 2 | `node scripts/test-stage.js 2 [--base <ref>]` | the tests the diff against `origin/main` (or `--base`) reaches, each tier under its guard; fails closed into Stage 3 (below) | the Builder, between Stage 1 and the draft PR; seconds to a minute, by what the diff reaches |
| 3 | `node scripts/test-stage.js 3` | the `small` tier under its guard, with `--test-timeout=300000` | the Builder's inner loop; seconds |
| 4 | `node scripts/test-stage.js 4` | the `medium` tier under its guard, with `--test-timeout=300000` | before a draft pull request; minutes |
| 5 | `node scripts/test-stage.js 5` | the `large` tier, no guard | the slow slice; usually as part of `all` |
| all | `node scripts/test-stage.js all` | the whole suite as `test_command` runs it: one `node --test --test-reporter=junit --test-reporter-destination=<junit> test/*.test.js`, the same arguments in the same order | the suite gate (`SUITE_SLOT`); CI's shape |

Options: `--junit <path>` says where the junit report goes (default: a file under the OS temp
directory, named at the end; Stage 2 writes one per tier beside it, `<path>.<tier>.xml`);
`--spec <path|stdout>` adds the spec reporter. Stages 3 to 5 default to `--spec stdout` so a person
sees the failing test; `all` defaults to no spec reporter, which is what keeps its arguments
identical to `test_command`.

Stages 3, 4 and 5 together are exactly `test/*.test.js` (pinned by `test/test-stage.test.js`), so
`all` and the three tiers run the same files and differ only in guard and grouping. An empty tier
runs nothing and says so, because `node --test` with no files discovers its own, which would be
the whole suite.

## A documentation-only pull request: Stage 1 and CI, no suite slot

A pull request that changes only documentation does not take `SUITE_SLOT` or run `all` locally.
The lane runs Stage 1 (`node scripts/test-stage.js 1`) and relies on GitHub `Tests` CI on the
exact head. The full suite exists to catch a change in behaviour, and a documentation-only diff has
none to catch; Stage 1 still catches what a `.md` edit can break here, such as the CLAUDE.md block
falling out of sync.

What decides it is measured, not judged: `prawduct-hook check-pr-doc-only`, run on the branch
after its last commit. It reads the committed diff `merge-base...HEAD` against the base branch, so
an uncommitted edit is not in it. It exits 0, and prints that the diff is doc-only, only when the
diff is non-empty and every file in it is non-judgeable: a `.md` file outside the methodology's
protected paths, or Prawduct's own session metadata. Any other file (code, a test, a workflow, a
JSON or YAML file) makes it exit 1, and so does an empty diff or a base it cannot resolve: it fails
closed. Exit 1 means the pull request takes the suite gate its rules name.

Record the command's output in the pull request body. A later commit that adds a judgeable file
ends the exemption for that head; run the check again on every new head.

## Stage 2: the tests a diff reaches, or an honest refusal

`node scripts/test-touched.js [--base <ref>] [--run] [--explain] [--junit <path>]` is the
selector; `node scripts/test-stage.js 2` is `--run` through the runner. The changed files are
`git diff --name-only <merge-base of base and HEAD> HEAD` plus whatever the working tree holds
uncommitted or untracked. A test file is selected when its **require graph**, or a **product
path its text names**, reaches a changed file; a changed test file selects itself; the three
static-ring tests are always in. The selection is then run as Stages 3, 4 and 5 would run it:
grouped by the ledger's tier, each tier under its guard, each run reconciled.

**The walker** (`scripts/_require-graph.js`, one text reader shared with the audit below) reads
each file's code with strings, comments and regex bodies masked out first, so a shell snippet
inside a template string is not a `require`. It resolves `require('./x')` as node does (`x`,
`x.js`, `x/index.js`, `x.json`), and `require(path.join(ROOT, 'lib', 'x'))` where `ROOT` is a
constant the file defines from `__dirname` with literal segments, which is how this repository's
scripts load `lib/`. A product path the text **names** is a dependency whether or not it is
required: `path.join(__dirname, '..', 'lib', 'x.js')` in a test that reads the source,
`path.join(REPO, 'scripts', 'x.js')` in one that spawns it, a bare `'scripts/x.js'` literal that
exists on disk; and a `.js` file named that way is walked in turn, because a script a test spawns
is run by that test and what the script requires is part of what the test depends on. A join
whose last segments are built at run time names the directory its literal
segments reach, and the test then depends on everything under it, which over-selects and never
misses. `--explain` lists the selected tests per changed file and, for the selected graphs, the
dynamic requires and the count of **opaque reads**: a `readFileSync` whose path carries nothing
literal is outside the walker's sight, and the number is printed so nobody mistakes the selection
for more than text can see.

**It fails closed.** When the selection cannot be trusted the selector exits 1, prints one line
per reason, then `ESCALATE: run stage 3`; `--run` and the runner's Stage 2 then run Stage 3 whole
instead and say so. There is no flag that accepts a partial selection. The reasons:

| Reason | A changed file… | Why text cannot answer |
|---|---|---|
| `dynamic-require` | lies where a dynamic `require` on some test's graph could reach: under the literal prefix of a template require (``require(`../lib/wrap-steps/${kind}`)`` names `lib/wrap-steps/`), or anywhere, for a require with no literal at all | the graph has an edge whose target it cannot name |
| `not-javascript` | is not `.js`: `test/tiers.json`, a YAML or JSON a test may read, a document, `.prawduct/` state | nothing in the graph says who reads it |
| `shared-helper` | is a shared test helper or fixture (`test/_*.js`, `test/helpers/*`, `test/fixtures/*`) | its readers are every test that loads it, which the ledger's scan follows but the selection does not enumerate from text |
| `unreached` | is reached by no test at all (a deleted file is one of these) | a change nothing covers is not "nothing to run"; it is a gap, and Stage 3 is the honest answer |

Every reason is pinned by `test/test-touched.test.js` on an in-memory tree, with the exit code
and the `ESCALATE` line. This chunk's own diff is the documented example: it touches this page,
so `node scripts/test-stage.js 2` on it prints the `not-javascript` escalation and runs Stage 3.

**Measured when Stage 2 was built** (2026-10-22, this repository at `68c4ff0e`, the laptop):
the graph is 1,086 files and builds in about 1.1 s; the selection step is about 1.1 s. A one-file
change to `lib/test-results.js` selects 18 test files plus the ring (7 Small, 1 Medium, 13 Large)
and the whole of Stage 2 runs in 41.4 s: Small 0.3 s, the one Medium file 10.5 s
(`test/check-watch-monitor.test.js`, 10 s alone by design), the 13 Large files 29.5 s. What a diff
reaches decides the time, and a change under `server.js`'s graph (`lib/rule-label.js` reaches
479 tests) selects most of the suite. Against the under-30 s Builder-ring target of #2371's
checkpoint 4, Stage 1 + Stage 2's selection + Stage 3 is about 8 s before the selected files run;
the selected files are the variable, and the ring the activation packet named (Stages 1+2+3) is
what shipped when #2371 closed (2026-10-26).

## The dead-export audit, and the ratchet Stage 1 runs

`node scripts/audit-dead-exports.js` walks the same graph from every entry point of the
repository, `server.js`, the three `bin/` commands (`tc`, `tc-bridge-helper`, `tc-bridge-receive`;
`hooks/*` are shell and load no module), every `scripts/*.js` and every `test/*.test.js`, and
every module under `lib/` as well, so a module no entry point reaches is audited rather than
silently absent. For each name a `lib/` module exports it finds the readers: the files that require
the module and use that name, read from the shape of the require (`const { a } = require(…)`
reads `a`; `const m = require(…)` followed by `m.a` reads `a`, and `m` used any other way, passed
whole or indexed, reads everything; `require(…).a` reads `a`; a bare `require(…)` reads
everything). A member use counts inside a template's `${…}` (`${m.a}` reads `a`, nested templates
included) and through a spread of one member (`[...m.a]` reads `a`). The report lists:

- **dead**: no reader at all, tests included;
- **test-only**: read by tests and by nothing in the product, with the readers;
- **orphan candidates**: each test that is the sole reader of a test-only export, with what it
  alone reads;
- what it could not audit: an **opaque** module (exports by `...spread` or a computed key, so its
  names come from elsewhere), modules **shadowed** by a dynamic require bounded to their directory
  (anything under it could be read, so nothing there can be called dead), and any dynamic require
  with no literal prefix at all.

It is a report (PM ruling D4: no deletion in Wave 4). **`--check` is the Stage 1 step**, and it is
a ratchet against the tracked `test/dead-exports-baseline.json`: red on a dead export the baseline
does not list (new dead code), on a baseline entry that is no longer dead or no longer exists (the
list must shrink with the code), on a baseline that is missing, malformed, duplicated or unsorted,
and on graph uncertainty (an opaque module, an unbounded dynamic require), each named. Green
prints the baseline count and `0 new`. Retiring a batch (its own issue, Architect acceptance each
time) shrinks the baseline with `--write-baseline`; nothing adds to it by hand.

**Measured when the baseline was written** (`main` at `68c4ff0e`, the audit run on a clean
`git archive` of that commit): 294 `lib/` modules, 3,251 exported names audited, 0 opaque, 30
modules under `lib/wrap-steps/` shadowed by the one bounded dynamic require in
`test/wrap-pipeline.test.js`, 0 unbounded; **234 dead** (the baseline then), 844 test-only, 163 orphan
candidates. The audit pass is about 90 ms on top of the graph; the Stage 1 step is about 1.2 s.
The first removal batch is #2544. Before it removed anything, it fixed the walker's reads in
template interpolations and member spreads. That fix took 13 entries off the dead list, because code
reads them, and added 4 in `lib/ttyd-runtime.js` that a misread nested template had hidden. The
batch then retired the 33 dead exports under `lib/soak/`, by export entry alone, since each is still
used inside its own module. After that batch, on 2026-10-24, the baseline is **192 dead**
(234 − 13 + 4 − 33). The 234 above is the snapshot from when the baseline was first written, and
`--check` prints the count at any later commit.

## The coverage redundancy matrix and the source-reader triage

Two more reports for a consolidation wave to read. Like the dead-export audit, they list
candidates and delete nothing (PM ruling D4): retiring or merging a test is a contract change, and
each batch has its own issue and Architect acceptance.

**`node scripts/audit-test-redundancy.js --tier small`** runs each file of a tier alone, under its
tier's guard and timeout exactly as its stage runs it, with node's own coverage
(`--experimental-test-coverage --test-reporter=lcov`; no `c8`). From each run it keeps the product
lines executed: lines of `server.js`, `lib/`, `public/`, `bin/` and `scripts/` with a hit count
above zero. The test's own lines and its helpers' do not count, since every file covers itself.
The report gives, for every file, how many product lines it executes and how many of those no other
file of the run executes (what it adds), and three lists:

- **exact-subset candidates**: files that add nothing;
- **removable together**: one set of candidates, chosen greedily from the smallest up, that loses
  no line when all are retired at once (two files executing the same lines are each a candidate,
  and only one of them can go);
- **no product line executed**: files that prove what they prove by reading text or by testing a
  helper, about which line coverage says nothing. The source-reader triage below covers the ones
  that read source as text; neither audit covers a file that only tests a helper.

Line coverage cannot see what a file asserts. Loading a module executes its top-level lines, so a
file that only requires a large module "covers" thousands of lines. Two files that execute the same
line may assert different things about it, and branches are not compared. A run that fails or
writes no report is named and left out, which can only make other files look less redundant, and
runs that all succeed with no product line among them are refused by name (an lcov report whose
paths are not repo-relative would otherwise read as a tier that proves nothing). It is
slow by nature, one process per file, so it runs on request and never in a stage. `--jobs N` sets
how many files run at once (half the host's cores by default), and a list of test files in place
of `--tier` runs just those, each under its own tier.

**`node scripts/audit-source-readers.js`** finds the test files that read product source as text:
a `readFileSync` or `readFile` on the file system (a destructured name, any name the test binds to
`fs` or `fs/promises`, or an inline `require('node:fs')`) whose path the walker above resolves
under `server.js`, `lib/`, `public/`, `bin/` or `scripts/`, including an inline
`require('node:path').join` and a `require.resolve('./…')`. A read call on any other receiver is
opaque. A helper that reads a directory by a file name (`pub('app.js')`)
reads the files the test names there, and one that names none sweeps the directory. A read from
the repository root that names no source file is not a source read. Each reader is in one class:

| Class | What it reads | Verdict |
|---|---|---|
| `guard` | only non-code files (markup, styles), or a sweep of a directory | kept: it asserts a property of the text that no runtime test can |
| `lift` | it uses `test/helpers/lift.js` | kept: it is how `public/` code runs in node |
| `regex-of-behaviour` | a named product code file (`.js`, or a `bin/` command) | a candidate, split by runtime proof |

Runtime proof is read from the require graph of every test, plus the `bin/` and `scripts/` entry
points a test names without reading, which it spawns. It is `self` when the test itself loads every
file it reads, `other` when some other test loads each of them, and `none` when no test loads one
of them. `self` and `other` may duplicate a runtime test (#2549). `none` needs a runtime test, and
nearly all of it is `public/`, which #1037 owns: node runs browser code only through the lift
helper, whose file argument the audit does not resolve, so a `public/` file never counts as loaded.
A read whose path the walker cannot resolve (a variable, a call) is opaque. Opaque reads are counted
per file and never classified; most are temporary files and fixtures.

**Measured when the audits were built** (the laptop; the matrix on `main` at `f0882cae`, the triage on
`442303b4`, the commit that added the audits, whose only new test files read no source):

| Audit | Time | Result |
|---|---|---|
| redundancy matrix, Small tier (249 files, 5 at a time) | 14.1 s | 28 exact-subset candidates, 27 removable together, 90 files executing no product line; 107,170 product lines executed in all |
| source-reader triage, every test file | 1.3 s | 233 readers: 12 guard, 81 lift, 140 regex-of-behaviour (47 self, 22 other, 71 none); 827 opaque reads in 168 files |

The first batches are #2548 (the matrix's candidates) and #2549 (the `self` and `other` readers).
The issue's 2026-10-18 snapshot counted 207 reading files and the Wave 4 plan's baseline counted 37, each
by a rule neither recorded; the 233 above is by the rule stated here.

## What a run certified: the runner's summary and the junit report

Every stage that runs tests ends by reconciling the junit report with the runner's own summary,
through `lib/test-results.js`, and prints both:

```text
runner summary: tests 22120, pass 22119, fail 0, cancelled 0, skipped 1, todo 0, suites 4111
junit report:   testcases 22114, testsuites 4117, failure elements 0, skipped elements 4
nodes: 22114 + 4117 = 26231 in the report, 22120 + 4111 = 26231 in the summary (the same run)
canonical count 22120 (the runner's tests); 22114 testcase leaves in the report; green
```

**The canonical count is the runner's `tests`.** The junit report counts the same run in another
shape, and reading it carelessly gives a number nothing agrees with: summing its nested `tests=""`
attributes overcounts (a parent's attribute already holds its children; 24,119 for the run above),
and counting `<testcase>` leaves is a few short (22,114 above), because a `test()` with subtests is
a test to the runner and a `<testsuite>` to the reporter. What the two sides share, measured on
Node 22 for every shape the reporter produces, is one identity:

> testcases + testsuites in the report == tests + suites in the summary

Every node of the run is rendered once and counted once; only the label moves. A `test()` with
subtests, a `describe` whose body threw before its tests ran, and a skipped `describe` each move
both sides by one. A report that breaks the identity is not the report of the run the summary
describes (truncated, or another run's), and the stage refuses it.

**A failure the summary does not count is red.** A `describe` whose body throws is rendered as a
`<testcase>` with a `<failure>` but counted by the runner as a suite: the summary says `fail 0`,
and the process exits 0. The reconciliation reads the report's failure elements against the
summary's `fail + cancelled` and exits 1 for the uncounted one, whatever node's exit code was.

The summary is read from the spec log when `--spec <path>` was given, otherwise from the comments
the junit reporter writes at the end of its own report (`<!-- tests N -->`), which are the same
lines; `summaryOf` reads the spec, TAP and junit spellings alike. `scripts/test-skip-audit.js`
reads the same report through the same walker (`parseJunit`, moved to `lib/test-results.js`), so
the skip audit and the count come from one parser.

## Running the tiers on a pool: `.testament.toml`

[Testament](https://github.com/brookstalley/testament) (private) runs a project's tests on a pool
of machines and returns one report with every test it was asked to run. `.testament.toml` at the
repository root is its manifest for this repository. It is generated, never written by hand:
`node scripts/test-tiers.js --testament` writes it from `test/tiers.json`, and `--check` (Stage 1)
refuses a manifest that differs by one byte from what that command would write.

| Key | Value | Why |
|---|---|---|
| `manifest_version` | `3` | the version with `[suites.<name>]` tables, one per tier |
| `executor` | `container` (#2733) | runners need nothing but Docker; the image gives every tier tmux, git and the other CLIs the `large` tier drives |
| `env_inputs` | `.devcontainer/Dockerfile`, `.node-version` | the files whose change means a different environment: the image's own definition, and node's version |
| `[image] dockerfile` | `.devcontainer/Dockerfile` | `FROM node:22-bookworm-slim`, installs `ca-certificates git python3 sqlite3 tar tmux`, ends `USER node` (Testament refuses a root image) |
| `batch_timeout_s` | `1800` | a killed batch reports none of its files, so the bound is six times a guarded tier's per-test timeout and above the whole suite's wall time |
| `[setup] steps` | none | the suite has no dependencies to install |
| `[suites.small]`, `.medium`, `.large` | `adapter = "files"`, `cwd = "."`, `files` = the tier's paths from the ledger | a literal path is a glob that matches only itself, so the three suites together are exactly `test/*.test.js` |
| each suite's `command` | the stage runner's own command line for the tier (`tierArgv`), plus `--test-concurrency=1`, with `{files}` and `{junit}` where the files and the report go | a batch runs a tier exactly as its stage does, guard and timeout included; the pool is the parallelism |
| `one_file_per_process` | `true` | `node --test` before Node 24 does not say in its junit report which file a test was in |

**What has been checked, and what has not.** The manifest was read by Testament's own parser
(`manifest.py` and the `files` adapter, at the v0.9.0 tag this work was planned against and at
v0.12.1, the newest tag on 2026-10-23), with no error. Testament's own collector, run over the
tracked tree, put each test file in exactly one suite. The batch command it renders for one file of
each tier ran under node on this host and wrote its junit report. **No live pool run has happened
yet:** the project is not yet allowed on the coordinator with the `container` executor (device
enrolment for this machine is submitted and awaiting Operator approval in Discord — `LANE_QUEUE.md`
"Carry-Forward"). Until it is, `testament run --probe --json` answers `machine_not_set_up`, and
`scripts/test-stage.js`'s Stages 3-5 (below) fall straight through to the existing local run.
Nothing reads a Testament report as suite evidence — that's a separate question from #2371
(CI-as-suite-evidence, shipped 2026-10-26): #2371 lets a gate trust CI's own report, never a
Testament pool report, which still isn't wired to anything here.

**Stages 3-5 try the pool first, then fall back locally (#2733).** `scripts/test-stage.js`'s
`offloadTier` probes `testament run --probe --json` before each guarded or large tier; on a clean
probe it runs `testament run --no-fallback --suite <tier> --json=summary` and returns that verdict
directly (no junit report — a pool run is a quick pass/fail, not something the evidence recorder
ingests). It falls straight through to the local run already described above whenever offload is
bypassed (`TANGLECLAW_NO_TESTAMENT=1`, `CI`/`GITHUB_ACTIONS`, or a synthetic fixture root under
test with no `io.testament` seam) or the pool answers it can't take the run right now (no
coordinator, the project not yet allowed, no runner, the process's own exit code disagreeing with
the envelope's self-reported `exit_code` — the same value by construction per Testament's own
`client.py`, so a mismatch means something corrupted the pipe between them — a pass with no
`report.counts` object, a fail with an empty or non-array `report.items`, or any other non-clean
exit: trusted to say WHETHER it passed, never trusted to carry no evidence of it). Each of the two
blocking calls (the probe, then the run itself) writes a progress line to `stderr` before it
starts, since `--no-fallback --suite <tier>` can run for a while and silence there looks identical
to a hang — per the sprint plan's own spec ("Log to `stderr`") and matching Testament's own CLI
philosophy (progress on `stderr`, the parseable envelope alone on `stdout`). The actual pass/fail
verdict stays on `stdout`, alongside everything else this file prints. A CI gate is always a local
run: CI sets its own bypass, deliberately, so a gate's suite evidence never depends on an external
pool being up.

**The pool is the Operator's to set up.** Testament's own guide is the authority
(`testament guide pool`, `testament guide machine`), and it marks the steps only the owner can
take. In outline, from the Operator's machine, which reaches each host over SSH:

1. Install the CLI: `uv tool install git+ssh://git@github.com/brookstalley/testament@<tag>`.
   Testament is private and not on PyPI.
2. Give every host an SSH alias in `~/.ssh/config` that logs in without a prompt. Testament runs
   `ssh -o BatchMode=yes <alias>`, so check each one with `ssh -o BatchMode=yes <alias> true`.
   Use an unrestricted admin alias, because Testament sends scripts over the login. Each host needs
   Linux (systemd) or macOS, `curl` and an outbound connection. No root is needed.
3. Put the pool on a private network (Tailscale here). The protocol is plain TCP and a key travels
   in a machine's first message.
4. `testament coordinator install <host> --listen <tailnet-addr>:7621 --operator <name>`, on an
   always-on host.
5. `testament runner add <host> --via <coordinator-host> --coordinator <addr>:7621 --slots <n>`
   for each runner. A container-executor runner needs only Docker (#2733: the image itself carries
   Node 22, `git` and `tmux`, so nothing need be pre-installed on the runner's own PATH).
6. `testament projects allow tangleclaw --executor container --via <coordinator-host>`. A container
   project needs no owner secret (that is a host project's requirement); the runner builds
   `.devcontainer/Dockerfile` itself from the worktree it is given.
7. For each machine that submits runs: `testament invite <person> --machine <name> --project
   tangleclaw --via <coordinator-host>`, then on that machine
   `printf '%s' '<token>' | testament join`.
8. Check it: `testament status` lists the runners; in this repository,
   `testament onboard -- test/areas-map.test.js` makes one real run.

There is no `testament init` command. The guide's onboarding step also suggests adding its
agent-instructions block to `CLAUDE.md`. That is not done here: the block would tell every session to
run its tests through Testament, and the lane rules, not this repository, decide how a gate's
suite is run.

**Things a runner changes.** Every project, container or host, sees a narrowed environment on a
runner (PATH, HOME, locale, temp directory, proxies, certificates and a few prefixes), so a test
that needs another variable from the machine needs the runner's operator to pass it (`[runner]
pass_env`). Every slot shares the runner's network, so a test that binds a fixed port can collide
with another batch; bind `127.0.0.1` on port 0 and read the port back. Testament's open issue #67
(per-test OS routing and slot weights) is not needed here. The tier is the unit, and
`test/skip-ledger.json` already says which tests need a macOS host or an engine CLI and skip
without one.

## Measured when the ledger was first written (2026-10-22, this repository at `598ab72e`, a laptop)

| Tier | Files | Tests | Wall time, guarded | Notes |
|---|---|---|---|---|
| `small` | 244 | 5,356 | 4.8 s | 0 refusals; of the 274 files the scan proposed, the guard demoted 30 (26 to `large`, 4 to `medium`): product code they call spawns, opens a database or listens |
| `medium` | 146 | 5,369 | 4 min 48 s (`--test-timeout=300000`) | 0 refusals; of the 270 files the scan proposed, the guard demoted 124 to `large`, nearly all server-booting tests whose boot path spawns (see above), one by hanging past the timeout. SQLite and filesystem bound: system time above user time |
| `large` | 301 | | | not run as a tier here; it is the slow slice of the full suite |

## Measured under full Stage 5 contention, for `LARGE_TIMEOUT_MS` (#2706, this repository at this
chunk's own head, a laptop)

| Tier | Files | Tests | Wall time | Notes |
|---|---|---|---|---|
| `large` | 312 | 12,286 | 10 min 36 s (635,777 ms), green (`--test-timeout=3600000`, the prior unmeasured bound) | `test/soak-guest.test.js`, the known slowest file, summed ~486.9 s across its eight top-level describes (sequential, no declared `concurrency`) — a ~1.8x slowdown from its ~270 s measured alone, far gentler than Medium's own ~12x alone-to-shared swing (I/O/subprocess-bound, not CPU-bound against 300+ sibling processes) |

`LARGE_TIMEOUT_MS` moved from the unmeasured 60-minute placeholder to 1,500,000 ms (25 min):
~3.1x headroom over the 486.9 s measurement, using the same ratio `GUARDED_TIMEOUT_MS` applies
over its own measured-shared number (120 s → 300 s is ~2.5x). Re-measure if a new slowest file
emerges or this one changes materially.

Numbers something relies on are re-measured, never copied: the ledger's counts are
`node scripts/test-tiers.js --check`'s output, and a tier's time is the guarded run's.

## What this does not do yet

- Stage 2 is as good as text: a read whose path is built from nothing literal is counted and
  reported, not followed, and a dynamic require with no literal prefix escalates every change.
- The three audits are reports. No test or export has been retired on their word; each removal
  batch is its own issue (#2544, #2548, #2549) with Architect acceptance. The redundancy matrix
  has been measured on the Small tier only.
- `test_command`, CI and every gate are unchanged: `all` is that command, argument for argument,
  with the reconciliation printed after it, and nothing here reads a *stage* as suite evidence.
  (#2371, shipped 2026-10-26, is the separate question of a gate trusting CI's own report; it
  doesn't touch a Testament report, which still isn't wired to anything.)
- `.testament.toml` has not had a live pool run. The pool is Operator infrastructure, its setup
  is outlined above, and this machine's own device enrolment is still awaiting Operator approval
  (`LANE_QUEUE.md` "Carry-Forward"). `scripts/test-stage.js`'s offload code (#2733) is written and
  falls back cleanly today; it has nothing to reach until the project is allowed with the
  `container` executor.
- The ledger says nothing about *where* a test may run (macOS, a non-UTC clock, an engine CLI).
  That stays with `test/skip-ledger.json` and [docs/lane-ci-evidence.md](lane-ci-evidence.md).
