# The test pyramid: tiers, the ledger and the guards

*Built for #2498. This page covers the three tiers a test file can be in, the ledger that
declares them, the guards that enforce them, how to classify a new test, the stage runner that
runs a tier or the whole suite as one command, how a run's count is read, the touched-graph
selector that is Stage 2 and the reasons it refuses, and the dead-export audit with the ratchet
Stage 1 runs against it.*

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
  commit. `--check` fails CI until the file is declared.
- **The scan:** `scripts/test-tiers.js` reads the file's text with comments removed and
  follows its requires of other files under `test/` (helpers, fixtures), so a helper that
  spawns makes every test that loads it Large. It does not follow into `lib/`: that is the
  guard's job, and a text scan of the product would be a second require graph nobody
  maintains. A call to a spawner marks Large; opening a database, listening, serving,
  fetching, or loading the store facade or the server marks Medium. A bare
  `require('child_process')` marks nothing, because the guard refuses the call, not the load.
- **Regenerating:** `node scripts/test-tiers.js --write` rebuilds the ledger from the scan and
  keeps every existing declaration that is slower than the scan allows (the demotions the
  guarded runs earned).

## The stages: `scripts/test-stage.js`

One entry point runs a stage, or the whole suite, and prints its wall time:

| Stage | Command | What it runs | Who runs it |
|---|---|---|---|
| 1 | `node scripts/test-stage.js 1` | static: every tracked `.js` parses (in-process, `vm.Script`), no conflict markers, no bare `node:assert`, the CLAUDE.md block in sync, the tier ledger total, no `lib/` export dead past the baseline, the three static-ring tests | everyone, before every push; about two seconds |
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
the selected files are the variable, and the ring the activation packet names (Stages 1+2+3)
stays a proposal until the Operator's cutover.

## The dead-export audit, and the ratchet Stage 1 runs

`node scripts/audit-dead-exports.js` walks the same graph from every entry point of the
repository, `server.js`, the three `bin/` commands (`tc`, `tc-bridge-helper`, `tc-bridge-receive`;
`hooks/*` are shell and load no module), every `scripts/*.js` and every `test/*.test.js`, and
every module under `lib/` as well, so a module no entry point reaches is audited rather than
silently absent. For each name a `lib/` module exports it finds the readers: the files that require
the module and use that name, read from the shape of the require (`const { a } = require(…)`
reads `a`; `const m = require(…)` followed by `m.a` reads `a`, and `m` used any other way, passed
whole or indexed, reads everything; `require(…).a` reads `a`; a bare `require(…)` reads
everything). The report lists:

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
`test/wrap-pipeline.test.js`, 0 unbounded; **234 dead** (the baseline), 844 test-only, 163 orphan
candidates. The audit pass is about 90 ms on top of the graph; the Stage 1 step is about 1.2 s.
The first removal batch is #2544.

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
  helper, about which line coverage says nothing. The source-reader triage covers them.

Line coverage cannot see what a file asserts. Loading a module executes its top-level lines, so a
file that only requires a large module "covers" thousands of lines. Two files that execute the same
line may assert different things about it, and branches are not compared. A run that fails or
writes no report is named and left out, which can only make other files look less redundant. It is
slow by nature, one process per file, so it runs on request and never in a stage. `--jobs N` sets
how many files run at once (half the host's cores by default), and a list of test files in place
of `--tier` runs just those, each under its own tier.

**`node scripts/audit-source-readers.js`** finds every test file that reads product source as text:
a `readFileSync` or `readFile` whose path the walker above resolves under `server.js`, `lib/`,
`public/`, `bin/` or `scripts/`. A helper that reads a directory by a file name (`pub('app.js')`)
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

**Measured when the audits were built** (`main` at `f0882cae`, the laptop):

| Audit | Time | Result |
|---|---|---|
| redundancy matrix, Small tier (249 files, 5 at a time) | 14.1 s | 28 exact-subset candidates, 27 removable together, 90 files executing no product line; 107,170 product lines executed in all |
| source-reader triage, every test file | 1.3 s | 224 readers: 11 guard, 81 lift, 132 regex-of-behaviour (40 self, 21 other, 71 none); 823 opaque reads in 167 files |

The first batches are #2548 (the matrix's candidates) and #2549 (the `self` and `other` readers).
The issue's 2026-10-18 snapshot counted 207 reading files and the Wave 4 plan's baseline counted 37, each
by a rule neither recorded; the 224 above is by the rule stated here.

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

## Measured when the ledger was first written (2026-10-22, this repository at `598ab72e`, a laptop)

| Tier | Files | Tests | Wall time, guarded | Notes |
|---|---|---|---|---|
| `small` | 244 | 5,356 | 4.8 s | 0 refusals; of the 274 files the scan proposed, the guard demoted 30 (26 to `large`, 4 to `medium`): product code they call spawns, opens a database or listens |
| `medium` | 146 | 5,369 | 4 min 48 s (`--test-timeout=300000`) | 0 refusals; of the 270 files the scan proposed, the guard demoted 124 to `large`, nearly all server-booting tests whose boot path spawns (see above), one by hanging past the timeout. SQLite and filesystem bound: system time above user time |
| `large` | 301 | | | not run as a tier here; it is the slow slice of the full suite |

Numbers something relies on are re-measured, never copied: the ledger's counts are
`node scripts/test-tiers.js --check`'s output, and a tier's time is the guarded run's.

## What this does not do yet

- Stage 2 is as good as text: a read whose path is built from nothing literal is counted and
  reported, not followed, and a dynamic require with no literal prefix escalates every change.
- The three audits are reports. No test or export has been retired on their word; each removal
  batch is its own issue (#2544, #2548, #2549) with Architect acceptance. The redundancy matrix
  has been measured on the Small tier only.
- `test_command`, CI and every gate are unchanged: `all` is that command, argument for argument,
  with the reconciliation printed after it, and nothing yet reads a stage as suite evidence (that
  is #2371, proposed and Operator-held).
- The ledger says nothing about *where* a test may run (macOS, a non-UTC clock, an engine CLI).
  That stays with `test/skip-ledger.json` and [docs/lane-ci-evidence.md](lane-ci-evidence.md).
