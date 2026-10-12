# The merge queue

*Being built (#2322). Nothing here can be reached yet: there is no route, no `tc` verb and no
screen. This page grows with each part as it lands; today it covers what the queue may do on
GitHub and how a candidate is tested.*

## What the queue does on GitHub

Every GitHub read and write the queue makes is in one file, `lib/merge-queue-github.js`, and goes
through `gh api` on the machine TangleClaw runs on, with that machine's `gh` login. Nothing else in
the queue talks to GitHub, so this table is the whole of what the queue can change there.

| Function | The call | What it can change |
|---|---|---|
| `readPull` | `GET /repos/{repo}/pulls/{number}` | nothing |
| `readPullFiles` | the same, then `GET /repos/{repo}/pulls/{number}/files`, every page | nothing |
| `readRefTip` | `GET /repos/{repo}/git/ref/heads/{branch}` | nothing |
| `readCommit` | `GET /repos/{repo}/git/commits/{sha}` | nothing |
| `readCompareFiles` | `GET /repos/{repo}/compare/{base}...{head}` | nothing |
| `createCandidate` | `POST /repos/{repo}/git/refs`, then `POST /repos/{repo}/merges` | creates one branch under `tc-queue/` and puts one merge commit on it |
| `deleteRef` | `DELETE /repos/{repo}/git/refs/heads/{branch}` | deletes one branch under `tc-queue/` |
| `mergePull` | `PUT /repos/{repo}/pulls/{number}/merge` | merges one pull request into its base branch |

A commit's check runs are read by `lib/github-checks.js` (`GET /repos/{repo}/commits/{sha}/check-runs`),
which changes nothing.

### The limits each write is held to

- **A candidate branch is one name directly under `tc-queue/`.** `createCandidate` and `deleteRef`
  refuse any other branch before `gh` runs: `main`, a release branch, a pull request's own branch
  and a nested name such as `tc-queue/a/b` cannot be created, written to or deleted by the queue.
- **A candidate is a merge of exactly two commits.** The branch is created at the base commit and
  the head commit is merged into it. The answer is accepted only if the merge commit's parents are
  those two, base first.
- **A pull request is merged with a merge commit, at one exact head.** `mergePull` always sends
  `merge_method=merge` and the full 40-character head commit; GitHub refuses the merge if the pull
  request's head has moved. Squash and rebase cannot be asked for, and a call without a full head
  commit is refused before `gh` runs.
- **The queue never approves a pull request, never pushes a commit and never edits a pull request's
  branch.** No function here can.

### What an answer means

Every function answers with a `status` and never throws.

- A read answers `read`, or `unavailable` with the reason. `readRefTip` also answers `not-found`
  for a branch that does not exist, which is how a deleted candidate is confirmed gone.
- `createCandidate` answers `created` (with the merge commit, its tree and its parents),
  `conflict`, `nothing-to-merge` (the base already holds the head), `ref-exists` (a branch of that
  name was already there and was not touched) or `unavailable`. Every answer carries `refCreated`:
  whether a branch now exists because of this call. That is what says there is a branch to delete,
  whatever the status: a merge GitHub refused leaves the branch it was to go into.
- `deleteRef` answers `deleted`, `not-found` (already gone) or `unavailable`.
- `mergePull` answers `merged` (with the merge commit), `head-moved`, `not-mergeable` or
  `unavailable`.

**`unavailable` never means "no".** It means the answer was not read: `gh` is missing or not signed
in, the call ran out of time, GitHub answered with an error, or the answer was not what the call
expects. `deleteRef` and `mergePull`, which each make one write, also say what is known of its
effect: `applied: false` when GitHub answered with a refusal and changed nothing, `applied: null`
when the outcome is not known. `createCandidate` makes two writes and answers `refCreated` instead. A merge that timed out may have happened, so its caller reads the pull request before it
decides anything.

**A file list is `unavailable` unless it is known to be whole.** GitHub lists at most 3000 files for
a pull request and 300 for a comparison. `readPullFiles` reads every page and requires as many rows
as the pull request counts, and fewer than 3000. `readCompareFiles` has no count to check against,
so a comparison that lists 300 files is treated as cut short. It also requires the second commit to
descend from the first, so the list is exactly what merging it would change. A renamed file gives
both its old path and its new one.

## How a candidate is tested

A candidate is the commit the queue makes by merging a pull request's head into the tip of `main`,
on a branch of its own under `tc-queue/`. It is tested by the same workflow that tests `main`:
`.github/workflows/test.yml` runs on a push to any `tc-queue/**` branch, so creating the candidate
starts a `test` run on its commit. That check, read for that exact commit, is what the queue waits
for before it lands the pull request. No pull request is opened for a candidate, so the push
trigger is the only thing that tests one.

- **The workflow and the queue name the prefix once.** The queue writes candidates under the
  constant `CANDIDATE_PREFIX` in `lib/merge-queue-github.js`. `test/workflow-queue-trigger.test.js`
  reads that constant and fails if the workflow's push list does not carry it, so neither can be
  renamed alone.
- **Removing `tc-queue/**` from the workflow stops every landing.** A candidate would then wait for
  a check that never starts. Nothing lands on a check that was not read, so the queue stalls; it
  does not land untested work.
- **A candidate run is a push run.** The step that guards the service-worker cache compares a pull
  request with its base and runs only on pull requests, so it does not run on a candidate. It has
  already run on the pull request itself, which must be green before it is submitted.
- **Making a candidate may also start a run on the tip of `main`. Not yet seen, and not yet
  decided.** The candidate's branch is created at the tip of `main` and the pull request's head is
  then merged into it. Those are two pushes to a `tc-queue/` branch, and the first puts the branch
  on a commit that is `main`'s own. If GitHub starts a run for that push too, the tip of `main`
  gets a second `test` run each time a candidate is made, and a reader that takes the newest
  `test` run on that commit would see it running again. This is checked on the same throwaway
  branch as the trigger itself, and what the queue does about it is settled before the part that
  lands a pull request is built.
- **The run holds no more than a pull request's run does.** The workflow's token is read-only
  (`contents: read`) on every trigger.

### What was checked against GitHub itself

On 2026-10-12 the functions were run against `Jason-Vaughan/TangleClaw`. One throwaway branch,
`tc-queue/probe-<time>`, was created at `main` as it stood before pull request #2331, that pull
request's head was merged into it, and the branch was deleted and read back as gone. Nothing was
merged into `main`. The merge commit GitHub made on the branch had the same tree as `main`'s own
merge of that pull request: the two ways of merging the same two commits gave the same files, which
is what the queue relies on when it tests a candidate and then merges the pull request. The recorded
exchanges are the test fixtures (`test/fixtures/merge-queue-github/`).

Not checked there:

- **Merging a pull request.** It cannot be tried without merging one into `main`. `mergePull` is
  written and tested against GitHub's documented answers; the first real one comes with the queue's
  first landing.
- **Whether a `test` run starts on a candidate branch.** On that day it did not: the workflow had no
  trigger for `tc-queue/**` and the probe's merge commit had no `test` run. The trigger is in the
  workflow now. That a branch made through the API with this machine's `gh` login starts the run
  has not been seen yet; it is checked once on a throwaway branch after the trigger reaches `main`.
