# What a green CI run does and does not say

*Being built (#2321). Today this page covers what CI leaves out and how the list of it is kept.
No rule lets a CI run stand in for the full local suite: a lane still runs the suite as its rules
say.*

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
