# What a green CI run does and does not say

*Being built (#2321). Today this page covers what CI leaves out, how the list of it is kept, and
the command that runs that list on your own machine. No rule lets a CI run stand in for the full
local suite: a lane still runs the suite as its rules say.*

## What CI runs

One job, `test`, in `.github/workflows/test.yml`: the whole suite (`node --test 'test/*.test.js'`)
on a Linux runner with no engine CLI, no Caddy and a UTC clock. After the suite,
`scripts/test-skip-audit.js` reads the run's junit report and fails the job on any skipped test
the ledger does not name.

So a green `test` check means: every test that could run on that runner passed, and every test
that did not run there is one the repository has agreed may not.

## What CI does not run

The list is `test/skip-ledger.json`, and only that file. It is not repeated here, because a second
copy would drift from the one CI enforces. Each entry there names a tier of tests by a pattern over
the test's full path, and says:

| Field | What it holds | Read by |
|---|---|---|
| `id` | a short name for the tier | people and the audit's report |
| `match` | an anchored pattern over `suite > suite > test` | the audit, to decide whether a skip is allowed |
| `why` | why the tier cannot run on the runner | people |
| `runsWhere` | where it does run, in words | people |
| `requires` | what a host must have for the tier to run there | programs |

To see the tiers and how many tests of each a given run skipped, run the audit on that run's
report; it prints one line per tier:

```bash
node --test --test-reporter=junit --test-reporter-destination=test-results.xml 'test/*.test.js'
node scripts/test-skip-audit.js test-results.xml
```

A green badge never claims the tests the ledger names. They are only ever run on a machine that has
what they need.

## The `requires` field

`runsWhere` tells a person where a tier runs. `requires` says the same thing in a form a program
can check against a host: a non-empty list of values, **all** of which must hold on a host for the
entry's tests to be expected to run there. There is no "not" and no "or". A tier that needs an
alternative gets a new value, added to the list below and reviewed.

The values are a closed list, `LEDGER_REQUIREMENTS` in `scripts/test-skip-audit.js`. `path:` and
`command:` are not open families: only the spellings below are accepted.

| Value | Holds on a host when |
|---|---|
| `platform:darwin` | the host is macOS |
| `timezone:non-utc` | the host's local time is offset from UTC |
| `filesystem:case-sensitive` | a file name that differs only in case is a different file |
| `user:mode-bits-enforced` | a folder set to mode 000 refuses the user running the suite (root, and some mounts, are not refused) |
| `command:caddy` | Caddy is installed and runs |
| `command:expect` | `expect` is on the `PATH` |
| `path:/bin/zsh` | the file `/bin/zsh` exists |
| `caddyfile:live` | the host has a live Caddyfile, where TangleClaw looks for one |
| `prawduct:marketplace-checkout` | the Prawduct plugin's marketplace checkout is under the user's home (`~/.claude/plugins/marketplaces/prawduct`) |
| `engine-cli:any` | at least one engine whose profile declares launch flags is installed |
| `engine-cli:each` | the engine a test is about is installed |

`engine-cli:each` is the one value read per test and not per entry. The launch-flags tier has one
test for each engine and launch mode, and the engine is named in the test's path. A host with some
engines installed rightly runs some of those tests and skips the others.

### What the audit does with it

The audit **validates** the field and does nothing else with it. An entry with no `requires`, an
empty one, a value that is not a string, a repeated value, or a value off the list is an invalid
ledger: `compileLedger` throws, the command exits 1, and CI's `test` job fails. The message names
the entry and the value.

The audit measures no host. Which skips it accepts is decided by `match` alone, exactly as before
the field existed, so a run that passed without the field passes with it.

Not built: the audit measuring the CI runner and failing on a skip whose requirements hold there.

### Adding an environment-gated test

Add a ledger entry with all five fields. Choose `requires` from the list above. If no value says
what the test needs, add one to `LEDGER_REQUIREMENTS` and to the table here in the same change, so
it is reviewed. Any edit to the ledger, the audit or this list calls for the full local suite, not
CI alone.
Write the test so it passes when run alone (below): the complement selects it by name.

## Running what CI does not: the local complement

```bash
node scripts/ci-complement.js --list     # what each entry requires and what this machine measures
node scripts/ci-complement.js            # run the ledger's tests here and judge them
node scripts/ci-complement.js --junit complement.xml
```

The command runs the tests the ledger names, on the machine you run it on, and exits 0 only when
every entry this machine is expected to run did run and did pass.

Nothing you type decides what it runs or what it expects. The tests come from each entry's
`match`. Whether an entry is expected here comes from its `requires`, each value measured on this
machine. There is no option to leave an entry out or to read another ledger. `--junit` only says
where the run's junit report is written, a relative path being taken from the folder you run the
command in; without it the report goes to a new temporary folder. Either way the path is printed.

It is a wide run: every test file is loaded, and only the tests the ledger names execute. In a
lane, do not start it while a full suite is running on the same host.

### How it selects and judges

It hands every `test/*.test.js` file to `node --test` with one `--test-name-pattern` for each
entry, built from the last ` > ` segment of the entry's `match`, because the runner filters by a
test's own name. It then reads the report and checks each case against the **whole** `match`. A
case belongs to an entry when the pattern matches the case's own path, or the path of a suite that
encloses it: some tiers are skipped on the runner as one whole suite, and where that suite runs
the report holds its tests underneath it.

A name pattern can select a test the ledger does not name. That is harmless unless the test fails,
and a failed test in this run always fails it.

### Reading its lines

First the junit report's path, then one line for each entry in the ledger's order, then one
summary line, which is always the last.

| Line starts | Means | Fails the run |
|---|---|---|
| `ran and passed: <id> (<n> tests)` | every requirement holds here; the entry's tests ran and passed | no |
| `ran and FAILED: <id> (<paths>)` | a test of the entry failed, whether or not it was expected here | yes |
| `expected here and SKIPPED: <id> (<path> (<the test's own reason>))` | every requirement holds here, and a test skipped anyway | yes |
| `MATCHED NOTHING: <id> (...)` | no test in the run matches the entry: its tests were renamed or removed, and the entry is stale | yes |
| `not expected here: <id> (<value> is false)` | a requirement does not hold on this machine, so its tests are not owed here | no |
| `UNMEASURABLE: <id> (<value>)` | a requirement could not be measured, so nothing can say whether the entry is owed here | yes |
| `ran and FAILED, on no ledger entry: <path>` | a test the patterns selected, which no entry names, failed | yes |

The last line is `COMPLEMENT GREEN` or `COMPLEMENT RED`, then how many entries ran here, then each
that did not with why:

```text
COMPLEMENT GREEN: 13 of 14 ledger entries ran here; did not: case-insensitive-fs (not expected here: filesystem:case-sensitive is false)
```

"Ran here" means at least one of the entry's tests ran and none failed or was wrongly skipped. An
entry that is not expected here is named on that line and does not make the run red.

It also fails, before judging anything, on a ledger it cannot read or that has no entries, on a
run that could not start or was killed (it says which), and on a run that wrote no report or a
report with no test case. A report left at the same path by an
earlier run is removed first, so it is never read as this run's.

### How each value is measured

| Value | Measured by | Unmeasurable when |
|---|---|---|
| `platform:darwin` | `process.platform` | never |
| `timezone:non-utc` | the clock's offset from UTC now, the tests' own condition | never |
| `filesystem:case-sensitive` | a file `a` made in a new temporary folder, then a look for `A` | the folder or file cannot be made |
| `user:mode-bits-enforced` | a new temporary folder set to mode 000, then read: `EACCES` is yes, a read that works is no | the folder cannot be made, or the read fails some other way |
| `command:caddy` | `lib/caddy.js#detectCaddy`, what the Caddy tiers themselves ask | it throws |
| `command:expect` | `sh -c 'command -v expect'`, the runbook test's own check | `sh` cannot be run |
| `path:/bin/zsh` | whether the file exists | never |
| `caddyfile:live` | whether the file at `lib/caddy.js#getCaddyfilePath` exists | it throws |
| `prawduct:marketplace-checkout` | whether `~/.claude/plugins/marketplaces/prawduct` exists | the home folder is unknown |
| `engine-cli:any` | the shipped engine profiles: one that declares launch flags and whose detection target `which` finds | the profiles cannot be read |
| `engine-cli:each` | per test: the engine named in the test's path, by the same rule | the profiles cannot be read, or the path names no known engine |

Every value on `LEDGER_REQUIREMENTS` is measured from that list. A value that is on the list and
has no measurement in the complement is unmeasurable, never true, so adding a value to the audit
without teaching the complement to measure it fails the complement instead of waving the entry
through. A test pins that the two agree.

Under `engine-cli:each` a skipped test is accepted only when its own engine is measured absent. A
skip on an engine that is installed, for example because its probe timed out, fails the run. If
none of the engines the tier's tests name is installed, the entry is not expected here.

### A ledger test must pass when it is run alone

The complement runs a tier's tests without the other tests in their files. A test that only passes
because an earlier test in the same file left something behind fails here, though it passes in the
full suite. That failure is the complement working: fix the test so it sets up what it needs.
