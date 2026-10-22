# The test pyramid: tiers, the ledger and the guards

*Built for #2498. This page covers the three tiers a test file can be in, the ledger that
declares them, the guards that enforce them, how to classify a new test, the stage runner that
runs a tier or the whole suite as one command, and how a run's count is read. The touched-graph
selector (Stage 2) is a later chunk of the same issue and is not described until it exists.*

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
| 1 | `node scripts/test-stage.js 1` | static: every tracked `.js` parses (in-process, `vm.Script`), no conflict markers, no bare `node:assert`, the CLAUDE.md block in sync, the tier ledger total, the three static-ring tests | everyone, before every push; about a second |
| 2 | `node scripts/test-stage.js 2` | the tests a diff reaches: **not built yet**; it says so and exits non-zero rather than read green | nobody yet |
| 3 | `node scripts/test-stage.js 3` | the `small` tier under its guard, with `--test-timeout=300000` | the Builder's inner loop; seconds |
| 4 | `node scripts/test-stage.js 4` | the `medium` tier under its guard, with `--test-timeout=300000` | before a draft pull request; minutes |
| 5 | `node scripts/test-stage.js 5` | the `large` tier, no guard | the slow slice; usually as part of `all` |
| all | `node scripts/test-stage.js all` | the whole suite as `test_command` runs it: one `node --test --test-reporter=junit --test-reporter-destination=<junit> test/*.test.js`, the same arguments in the same order | the suite gate (`SUITE_SLOT`); CI's shape |

Options: `--junit <path>` says where the junit report goes (default: a file under the OS temp
directory, named at the end); `--spec <path|stdout>` adds the spec reporter. Stages 3 to 5 default
to `--spec stdout` so a person sees the failing test; `all` defaults to no spec reporter, which is
what keeps its arguments identical to `test_command`.

Stages 3, 4 and 5 together are exactly `test/*.test.js` (pinned by `test/test-stage.test.js`), so
`all` and the three tiers run the same files and differ only in guard and grouping. An empty tier
runs nothing and says so, because `node --test` with no files discovers its own, which would be
the whole suite.

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

- Stage 2, the tests a diff reaches, is not built (W4-04); `node scripts/test-stage.js 2` says so.
- `test_command`, CI and every gate are unchanged: `all` is that command, argument for argument,
  with the reconciliation printed after it, and nothing yet reads a stage as suite evidence (that
  is #2371, proposed and Operator-held).
- The ledger says nothing about *where* a test may run (macOS, a non-UTC clock, an engine CLI).
  That stays with `test/skip-ledger.json` and [docs/lane-ci-evidence.md](lane-ci-evidence.md).
