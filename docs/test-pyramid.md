# The test pyramid: tiers, the ledger and the guards

*Built for #2498. This page covers the three tiers a test file can be in, the ledger that
declares them, the guards that enforce them, and how to classify a new test. The stage runner
that runs a tier as one command, and the touched-graph selector, are later chunks of the same
issue and are not described here until they exist.*

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
10 s alone and past 120 s when 98 Medium files share the host, so the Medium tier is run with
`--test-timeout=300000` until the stage runner measures a better number.

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

## Measured when the ledger was first written (2026-10-22, this repository at `598ab72e`, a laptop)

| Tier | Files | Tests | Wall time, guarded | Notes |
|---|---|---|---|---|
| `small` | 224 | 4,970 | 5.4 s | 0 refusals; of the 251 files the scan proposed, the guard demoted 27 (23 to `large`, 4 to `medium`): product code they call spawns, opens a database or listens |
| `medium` | 98 | 3,313 | 2 min 00 s (`--test-timeout=300000`) | 0 refusals; of the 210 files the scan proposed, the guard demoted 112 to `large`, nearly all server-booting tests whose boot path spawns (see above). SQLite and filesystem bound: system time above user time |
| `large` | 369 | | | not run as a tier here; it is the slow slice of the full suite |

Numbers something relies on are re-measured, never copied: the ledger's counts are
`node scripts/test-tiers.js --check`'s output, and a tier's time is the guarded run's.

## What this does not do yet

- Nothing runs a tier for you as one command; the stage runner is the next chunk.
- The full suite, `test_command`, CI and every gate are unchanged: the tiers are a declaration
  and two guards, and the suite is still the union of the three tiers run the way it always was.
- The ledger says nothing about *where* a test may run (macOS, a non-UTC clock, an engine CLI).
  That stays with `test/skip-ledger.json` and [docs/lane-ci-evidence.md](lane-ci-evidence.md).
