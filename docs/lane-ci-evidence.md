# What a green CI run does and does not say

*Built for #2321. This page covers what CI leaves out, how the list of it is kept, the command that
runs that list on your own machine, and the command that writes down what CI and that run together
covered for one commit. No rule lets a CI run stand in for the full local suite: a lane still runs
the suite as its rules say. Putting one in force is #2371, and the rule at the end of this page is
its proposal.*

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

## Writing down what was covered: the evidence command

```bash
node scripts/ci-evidence.js                 # for the commit checked out here
node scripts/ci-evidence.js --base <branch> # when the commit is headed for a branch other than the default
```

For the commit checked out here, the command reads CI's result from GitHub, runs the complement
itself, and writes one file saying what each covered. If any fact does not hold it prints
`REFUSED:` with that fact, then `no evidence was written`, and exits 1.

**The file changes nothing a gate accepts.** `prawduct-hook test-status` does not read it, no lane
rule names it, and the command never touches `.prawduct/.test-evidence.json`. Today it is a record
a person can read.

That is true of every Prawduct gate, not only `test-status`. In Prawduct 3.6.1 each reader of suite
evidence (`test-status`, the PR reviewer's payload, release readiness, the Critic's `test-status`
probe, and the base-advance transfer behind the Stop gate and `check-cumulative-critic`) reads
only `.prawduct/.test-evidence.json` and the evidence store's `test-run` facts, and only
`prawduct-hook test-evidence record` writes those. None of them asks where a report came from:
`--from-junit` stamps the local working tree as the tree the run covered. So passing CI's report
to it would record a run the gate never saw against a tree it never checked. Nobody does that.

It runs the complement, so it is a wide run: in a lane, do not start it while a full suite is
running on the same host.

### What it checks, in order

| # | The fact | Refuses when |
|---|---|---|
| 1 | the working tree is clean and HEAD is a commit | `git status --porcelain --untracked-files=all` prints anything |
| 2 | HEAD is on the remote | HEAD is on no branch, the branch tracks no remote, the fetch fails, or the branch's upstream after the fetch is not exactly HEAD |
| 3 | the repository is the remote's | the remote's URL cannot be read or names no GitHub repository |
| 4 | the `test` check on HEAD concluded with success | it cannot be read, does not exist, has not finished, or concluded any other way |
| 5 | the check run is a GitHub Actions job of HEAD | another app made it; its link names no workflow run as its own job; or GitHub's record of the job (`actions/jobs/<check run id>`) cannot be read, is of another commit, or belongs to another workflow run than the link names |
| 6 | the workflow run tested HEAD against the base branch | the run (`actions/runs/<workflow run id>`) cannot be read or is of another commit; it was started by anything but a push or a pull request; or it is a pull request's run that names no pull request of HEAD into the base branch |
| 7 | the base branch's tip, read from GitHub, is inside HEAD | the tip cannot be read, or is not an ancestor of HEAD |
| 8 | the ledger compiles | `test/skip-ledger.json` is missing or invalid |
| 9 | the complement, run by this command, is green | it is red (its lines are printed) or did not run to a verdict |
| 10 | nothing moved while it ran | the tree is no longer clean, HEAD is another commit, or the ledger's bytes changed |

Steps 6 and 7 together are how "CI ran against the current base" is checked without comparing
times. Neither replaces the other.

On a pull request CI tests the head merged into the pull request's own base branch, as that branch
was when the run started. Step 6 shows which branch that was: the run must name a pull request of
HEAD into the base the file binds. A pull request aimed at another branch gets a green check for a
different merge, and is refused. A push run merged nothing and tested the commit's own tree.

Step 7 then shows the merge had HEAD's own tree. When the base's tip is already inside the head,
merging the head into the base gives the head's tree, whatever the base was when the run started.
A base that has moved since is not inside the head, so it is refused: bring the base in, push, and
let CI run on the result.

**Run it before the merge.** GitHub stops naming a pull request on its run once the pull request is
merged, so step 6 refuses afterwards. It also refuses a pull request from a fork, whose run names
no pull request either.

### Nothing you type supplies a fact

The commit is HEAD. The repository comes from the remote's URL. The check is `test`. The ledger is
the tracked one. The complement's verdict is taken as a value from the run the command makes, never
from a report or a file, so there is nothing a person could place for it to read. An argument that
names any of these is refused.

`--base` is the one input, because the branch a commit is headed for is not always something the
command can derive; it defaults to the remote's default branch. A wrong base can only make the
command refuse at step 6 or 7, or bind the file to a base its reader can see in it.

### The file

`.prawduct/lane-evidence/ci-<full sha of HEAD>.json`. Git ignores that folder, so the file is never
committed. A file already at that path is replaced only by a successful run and is never read.

| Field | What it holds | Read from |
|---|---|---|
| `repository` | `owner/name` | the remote's URL |
| `check.name` | `test` | fixed: the check branch protection requires |
| `check.runId`, `check.app`, `check.conclusion`, `check.completedAt` | the newest run of that name on HEAD | GitHub's check runs for the commit |
| `check.workflowRunId` | the workflow run the check run belongs to | the check run's link, then confirmed against the job |
| `check.workflowName` | the workflow the job belongs to | GitHub's record of the job |
| `check.event` | what started the workflow run: `push` or `pull_request` | GitHub's record of the workflow run |
| `head`, `tree` | the full ids of HEAD and of its tree | git |
| `base.branch`, `base.tip` | the base branch, which a pull request's run was shown to be into, and the tip of it that is inside HEAD | `--base` or the remote's default; GitHub |
| `ledger.path`, `ledger.sha256` | the ledger, and the digest of its bytes | the file |
| `complement.ok`, `complement.entriesRan`, `complement.entriesTotal` | the complement's verdict and how many entries ran here | the run this command made |
| `complement.entries[]` | for each ledger entry its `id`, `verdict`, `detail`, and under `requires` what this machine measured for each value it requires | the same run |
| `readAt` | when the file was written | the clock |

Every field is one the run read. None has a default, and a reading that lacks one refuses.

### What the file does not prove

- **That the `test` job ran the suite.** The file shows that a GitHub Actions job named `test`, in
  the workflow it names, concluded with success on the commit. It does not read the workflow's
  definition, so it does not show that the job's steps were the suite and the skip audit and not
  something else given the same name. That rests on `.github/workflows/test.yml` as it was at the
  commit, which a reviewer can read.
- **That the complement covered a machine other than this one.** It records what this machine
  measured and ran. An entry not expected here is named as such, with the measurement.
- **Anything about a later commit.** It is for one commit and one tree.

## The suite command a gate could be pointed at: `scripts/suite-evidence.js`

```bash
node scripts/suite-evidence.js --junit <path>                                   # today's suite, argument for argument
TANGLECLAW_SUITE_EVIDENCE=ci node scripts/suite-evidence.js --junit <path>      # CI's run on the exact head is the suite
node scripts/suite-evidence.js --explain                                        # which mode would run, and why; runs nothing
```

This is the command the gate could be pointed at, written so that pointing the gate at it changes
nothing until the environment says otherwise. **It is declared nowhere today.** `test_command` in
`.prawduct/project-state.yaml` still names `node --test …`, `test/suite-evidence.test.js` pins that
it does, and CI runs `node --test` itself and uploads `test-results.xml` as the `test-results`
artifact (pinned `actions/upload-artifact` step added at W2-CUT, #2371), which the same test pins.
Those pins are what make the cutover visible: it cannot ride in without changing them.

**Local mode**, the default with `TANGLECLAW_SUITE_EVIDENCE` unset, hands node the declared
`test_command` with `{junit_xml}` filled in, argument for argument (`scripts/test-stage.js` owns
that argument list; the two are pinned equal), and exits with the suite's code. A gate that ran
this would record exactly what it records today.

**CI mode**, with `TANGLECLAW_SUITE_EVIDENCE=ci`, treats the green CI run on the exact head commit
as the suite, and this command is what establishes it. It reads every one of the ten facts the
evidence command above reads, through that command's own step functions, in the same order:

| # | The fact | Read by |
|---|---|---|
| 1 to 8 | the tree, the remote, the repository, the `test` check, its job, its run, the base, the ledger | `scripts/ci-evidence.js`, steps 1 to 8 of its table above |
| artifact | CI's junit report exists as the run's `test-results` artifact, of this run and this commit, not expired, not empty; it is downloaded through `gh run download`, and it is the whole green report of one run (it carries the runner's summary, the summary adds up, the report obeys the identity `lib/test-results.js` pins, and nothing in it is red) | this command |
| 9 | the complement, run by this command, is green | `scripts/ci-evidence.js`, step 9, the complement writing its own junit report |
| 10 | nothing moved while it ran | `scripts/ci-evidence.js`, step 10 |

The artifact is read before the complement runs: the complement is a wide run, and there is no
point starting it for a report that cannot exist. Any other value of the variable refuses rather
than picking a mode.

**It fails closed, and there is no synthetic report in any path.** The first fact that does not
hold, and an artifact that does not exist, is a named `REFUSED:` line; nothing is written at
`<path>`, and a gate that ran this reads red. A report whose structure is invented is
not evidence, so nothing stands in for CI's own.

`--explain` reads facts 1 to 8 and lists the artifact, printing each as it holds or refuses, says
that 9 and 10 need the run, and ends with the verdict the run would reach. It downloads nothing
and runs nothing; its exit code is 0 because its answer is its text.

### The merged report

When every fact holds, `<path>` receives one junit document: every `<testsuite>` of CI's report,
verbatim, then every one of the complement's, then one more suite, `suite-evidence: binding`,
whose `<property>` elements carry the facts that bind the two to the commit:

| Property | Value |
|---|---|
| `repository`, `head`, `tree` | the remote's repository, HEAD and its tree |
| `check_name`, `check_run_id`, `check_app`, `check_completed_at` | the `test` check as read |
| `workflow_name`, `workflow_run_id`, `workflow_event` | the job's workflow, its run, `push` or `pull_request` |
| `base_branch`, `base_tip` | the base bound, and the tip of it that is inside HEAD |
| `ledger_path`, `ledger_sha256` | the skip ledger and the digest of its bytes |
| `artifact_id`, `artifact_name` | the artifact downloaded |
| `complement_entries_ran`, `complement_entries_total` | how many ledger entries ran here |
| `read_at` | when the report was written |

The two reports' own trailing summary comments are dropped and one trailer is written for the
whole: each counter is the sum of the two runs', and `suites` is one more for the binding suite,
which is a node of the document and counted as one. So the merged document obeys the same identity
each part does (testcases + testsuites == tests + suites), `lib/test-results.js` reads it as one
green run, and the skip audit's walker reads its cases. The runner's `tests` of the whole is the
canonical count, as everywhere else; the leaf count is printed beside it. The file is written whole
or not at all.

### What it does not prove

The same three things the evidence file does not: that the `test` job ran the suite (a reviewer
reads the workflow at the exact commit, and from the cutover on, that it uploads the report); that
the complement covered a machine other than this one; anything about a later commit. One more: it
does not read the artifact's provenance beyond GitHub's own record that it belongs to that run of
that commit. The workflow step that uploads it is what makes the artifact CI's own report, which
is why that step is part of the cutover and not of this command.

## PROPOSED, NOT IN FORCE: it needs the Operator's approval and a Prawduct that accepts this evidence

Nothing in this section binds anyone. A lane rule is the Operator's to change; `.github/workflows/test.yml`
and `.prawduct/project-state.yaml` are outside every lane row and are edited by nobody in a lane;
and until the Operator lands the cutover below, `scripts/suite-evidence.js` is declared nowhere and
refuses on every run. A lane runs the full local suite as its rules say today, and nobody records
CI's result as suite evidence by hand.

What changed since this section was first written: Prawduct no longer has to change first. Its
gate runs the declared `test_command` and reads the report that command writes at `{junit_xml}`,
and `scripts/suite-evidence.js` is such a command. The draft report in `docs/prawduct-feedback.md`
still asks Prawduct for a first-class `ci_evidence_command:`, which would let the gate run the
evidence command without it being the suite command; that is worth asking for, and the Operator
sends it, but nothing below waits on the answer.

### What has to happen, in this order

Every line of it is Operator-held. The exact texts are in the activation packet
(`.tangleclaw/plans/2371-activation-packet.md`, local to the lane that wrote it and served at its
plans URL; its digest is in the W4-03 pull request).

1. **DONE — W2-CUT (#2371).** `.github/workflows/test.yml` now carries a pinned
   `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2` step,
   `if: always()`, that uploads `test-results.xml` as the artifact `test-results`, after the skip
   audit. Every CI run from this merge on carries its own report; no gate reads it until step 3.
2. **The rule texts are accepted, then activated.** The Architect accepts the exact replacement
   texts for the Builder overlay (clause 4) and the Integrator overlay (clauses 1 and 2(d)) and
   this page at the digest of the revision accepted with them; the Operator activates them
   through `POST /api/session-rules … replacesRuleId`; each lane reads them back. A later edit
   here changes nothing the rule allows until the rule is accepted again.
3. **The Operator declares the command.** `test_command` in `.prawduct/project-state.yaml` becomes
   `node scripts/suite-evidence.js --junit {junit_xml}` on the lane hosts, and the pins in
   `test/suite-evidence.test.js` that hold today's declaration are changed in the same change,
   which is how the cutover cannot ride in unnoticed. With no environment set, the declared
   command is still today's suite, so the declaration alone changes nothing a gate sees.
4. **The complement is verified** on the host the lanes use, before any chunk relies on it.
5. **One bounded pilot.** Exactly one chunk, named in the lane queue when its plan is approved
   (before any result exists), runs `prawduct-hook test-evidence record` with
   `TANGLECLAW_SUITE_EVIDENCE=ci` and stands on what the command writes. The batch charter's
   pre-suite order holds every chunk to the full local suite, so the pilot needs that order
   amended by name to allow this one chunk; the packet carries the request. The pilot measures the
   slot wait avoided, the command's wall time, any refusal and which fact, and that the gate
   records the merged report.
6. **Broader use is decided separately**, from the pilot's measurement: its time and its safety
   failures (a defect the pilot let through, a complement entry that did not run, an evidence
   refusal) alike. Until then, every other chunk runs the full local suite.

### The Builder ring the rule names

Decided at #2498's checkpoint 4 from measurement on the lane host, not from the issue's estimate:
the ring a chunk runs on the host before pushing for CI is **Stages 1, 2 and 3** of
`scripts/test-stage.js`, and never the Medium tier. At W4-02 Stage 1 measured about one second and
Stage 3 about five; the Medium tier measured more than three and a half minutes under its guard,
which is more than seven times the 30-second target on its own. No CI tier timing is claimed: CI's
run does not isolate stages. Stage 2 is not built until W4-04, so the ring's under-30-second target
remains to be measured with Stage 2 in it before any cutover.

### The rule text proposed

> **CI as the suite, for one pilot chunk.** The chunk named in the lane queue as the CI-as-suite
> pilot, at its plan approval, stands on the required CI check instead of the full local suite,
> and `node scripts/suite-evidence.js` in ci mode (`TANGLECLAW_SUITE_EVIDENCE=ci`), run by
> `prawduct-hook test-evidence record` as the declared `test_command`, is what establishes it: the
> `test` check concluded successfully on the exact head commit; GitHub Actions made it, as a job
> of that commit; the command itself read it; its run was a push of that commit or a pull request
> of it into the base branch; the base branch's tip is inside the head; the skip ledger compiles;
> CI's own junit report was downloaded as that run's `test-results` artifact and is the whole
> green report of one run; the complement was green on the same tree in the same run; nothing
> moved while it ran; the Builder ring (Stages 1, 2 and 3 of `scripts/test-stage.js`, never the
> Medium tier) passed on the host; and the reviewer has read the workflow at the exact commit and
> confirmed that its `test` job runs the full suite and the skip audit and uploads the report,
> because a successful job of that name proves none of those. The evidence is the merged report
> the command writes at `{junit_xml}`, which the gate records as it records any run. Nobody writes
> or edits one by hand, and nobody records CI's result as suite evidence by hand; a refusal leaves
> the gate red, and the full local suite is run.
>
> **The full local suite is still required** for: any edit to `test/skip-ledger.json` (add, remove
> or change); any change to the test runner, the audit or evidence machinery or its configuration
> (the stage runner, the tier ledger and its guards included); schema; `lib/store.js`; `server.js`;
> shared test helpers; the last chunk of an issue; once before a deploy; and whenever current-base
> exact-head evidence cannot be established. In that last case the local suite is run and nothing
> is hand-stamped.
>
> **A green badge never claims the ledger's tests.** They are covered only by the complement, on a
> machine that has what they need.
>
> **The conditions are this page's at the revision accepted with the rule**, named by its digest.

Every other gate stays as it is: the Critic, `check-cumulative-critic`, CI itself, the exact-head
and current-base checks, the browser check, and a ready report made void when `main` moves.

### Where it would change the lane rules

One clause of the Builder overlay and two of the Integrator overlay; nothing else in either, and
nothing in the common core. The activation packet carries each rule's full text with only these
sentences changed, ready for `POST /api/session-rules … replacesRuleId`, because a replacement
replaces the whole rule.

- **Builder overlay, clause 4 (Suite & Ready):** the Builder ring named above runs on every chunk
  before the push for CI; the named pilot, when every condition and no exception holds, takes no
  suite slot and stands on the merged report; the exceptions are written into the clause itself,
  and the clause names this page by digest; the ready report names the report the gate recorded;
  when `main` moves the pilot reruns CI and the command instead of the suite.
- **Integrator overlay, clause 1:** the pilot takes no slot, and "once `#2371` is active" is
  spelled out as the three Operator-held steps above having landed.
- **Integrator overlay, clause 2(d):** for the pilot, test-status passes on the merged report for
  the exact head, naming the fetched `origin/main` tip as its base, and the Integrator reads the
  workflow at the exact head to confirm the `test` job runs the full suite and the skip audit and
  uploads the report.

### A local suite does not cover everything CI does

The ledger lists what CI skips. The other way round is not listed anywhere, and is real: a test
can skip on a lane host and run on the runner. On a host whose `/tmp` is world-writable without
the sticky bit, the real-filesystem cases in `test/engine-temp-root.test.js` skip, while the
runner's `/tmp` is sticky and runs them. So the skip audit, given a lane host's report instead of
CI's, can fail on skips the ledger never needed to name: its contract is CI's report.
