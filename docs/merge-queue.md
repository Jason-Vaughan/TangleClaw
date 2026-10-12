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
| `createCandidate` | `POST /repos/{repo}/git/refs`, `POST /repos/{repo}/merges`, `GET /repos/{repo}/git/commits/{sha}`, `POST /repos/{repo}/git/refs`, `DELETE /repos/{repo}/git/refs/heads/{branch}` | creates one branch under `tc-queue-stage/`, puts one merge commit on it, creates one branch under `tc-queue/` at that commit, and deletes the first branch |
| `discardCandidate` | `DELETE /repos/{repo}/git/refs/heads/{branch}`, twice | deletes one branch under `tc-queue/` and the branch of the same name under `tc-queue-stage/` |
| `deleteRef` | `DELETE /repos/{repo}/git/refs/heads/{branch}` | deletes one branch under `tc-queue/` or `tc-queue-stage/` |
| `mergePull` | `PUT /repos/{repo}/pulls/{number}/merge` | merges one pull request into its base branch |

A commit's check runs are read by `lib/github-checks.js` (`GET /repos/{repo}/commits/{sha}/check-runs`),
which changes nothing.

### The limits each write is held to

- **The queue writes branches under two prefixes and no other.** A candidate branch is one name
  directly under `tc-queue/`; the branch its merge is made on has the same name under
  `tc-queue-stage/`. `createCandidate`, `discardCandidate` and `deleteRef` refuse any other branch
  before `gh` runs: `main`, a release branch, a pull request's own branch and a nested name such as
  `tc-queue/a/b` cannot be created, written to or deleted by the queue.
- **The two prefixes do two jobs.** CI runs on a push to `tc-queue/` and on no push to
  `tc-queue-stage/`. The merge is made on the stage branch, which starts at the base commit, and
  the candidate branch is created once, at the finished merge. So the only push CI sees is the
  candidate arriving. The stage name is built from the candidate name in one place
  (`stageRefFor`) and is never passed in, so the two cannot be paired wrongly.
- **A candidate is a merge of exactly two commits.** The answer is accepted only if the merge
  commit's parents are those two, base first, and a second read of the commit gives the same tree
  and parents.
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
  `conflict`, `nothing-to-merge` (the base already holds the head), `ref-exists` (a branch was
  already there under one of the two names and was not touched; `existing` says whether it is the
  `stage` or the `candidate`) or `unavailable`. `created` means all of it: the merge was read back,
  the candidate branch is at it, and the stage branch is gone. After a `conflict` or a
  `nothing-to-merge` there is no candidate branch and the stage branch is gone.
- Every `createCandidate` answer says what is known of each branch, whatever the status:
  `refCreated`, whether the candidate branch exists because of this call, and `stageLeft`, whether
  the stage branch still exists as far as the call knows. Each is true, false, or null when it is
  not known. **A stage branch that could not be deleted makes the answer `unavailable`**, even
  when the candidate was made, so no caller reads a result over a branch left behind.
- `discardCandidate` answers `discarded` when each of the two branches was deleted or was already
  gone, and `unavailable` otherwise. Both deletions are always attempted, and each answer says what
  happened to each: `candidate` and `stage` are `deleted`, `not-found`, `refused` (GitHub changed
  nothing) or `unknown`. Calling it again is harmless.
- `deleteRef` answers `deleted`, `not-found` (already gone) or `unavailable`.
- `mergePull` answers `merged` (with the merge commit), `head-moved`, `not-mergeable` or
  `unavailable`.

**`unavailable` never means "no".** It means the answer was not read: `gh` is missing or not signed
in, the call ran out of time, GitHub answered with an error, or the answer was not what the call
expects. `deleteRef` and `mergePull`, which each make one write, also say what is known of its
effect: `applied: false` when GitHub answered with a refusal and changed nothing, `applied: null`
when the outcome is not known. `createCandidate` makes several writes to two branches and answers `refCreated` and `stageLeft`
instead. A merge of a pull request that timed out may have happened, so its caller reads the pull
request before it decides anything.

**A file list is `unavailable` unless it is known to be whole.** GitHub lists at most 3000 files for
a pull request and 300 for a comparison. `readPullFiles` reads every page and requires as many rows
as the pull request counts, and fewer than 3000. `readCompareFiles` has no count to check against,
so a comparison that lists 300 files is treated as cut short. It also requires the second commit to
descend from the first, so the list is exactly what merging it would change. A renamed file gives
both its old path and its new one.

## What was checked against GitHub itself

On 2026-10-12 the functions were run against `Jason-Vaughan/TangleClaw`, as they then were: a
candidate was still merged on its own `tc-queue/` branch. One throwaway branch,
`tc-queue/probe-<time>`, was created at `main` as it stood before pull request #2331, that pull
request's head was merged into it, and the branch was deleted and read back as gone. Nothing was
merged into `main`. The merge commit GitHub made on the branch had the same tree as `main`'s own
merge of that pull request: the two ways of merging the same two commits gave the same files, which
is what the queue relies on when it tests a candidate and then merges the pull request. The recorded
exchanges are the test fixtures (`test/fixtures/merge-queue-github/`).

On the same day, after the workflow had its `tc-queue/**` trigger, two more things were tried, each
on throwaway branches that were deleted and read back as gone, with nothing merged into `main`:

- **A branch created at the tip of `main` under `tc-queue/` started a second `test` run on `main`'s
  own commit.** The commit went from one check run named `test` to two. A branch created at the
  same commit under `tc-queue-stage/` started nothing. This is why the merge is made on a stage
  branch.
- **The sequence the queue now uses started exactly one run.** `createCandidate` made a stage
  branch at `main` as it stood before pull request #2335, merged that pull request's head into it,
  created the candidate branch at the merge commit and deleted the stage branch. One `Tests` run
  started, a push run for the candidate branch on the candidate commit. No run started on the base
  commit, on the pull request's head or for the stage branch, read for 70 seconds. The run was
  still in progress after the stage branch was deleted. The candidate's tree was the tree of
  `main`'s own merge of that pull request. `discardCandidate` then removed the candidate branch.
- **Other GitHub apps do see a stage branch.** The candidate commit carried check suites from other
  apps installed on the repository, each recorded against the stage branch, where the commit first
  appeared. None of them is a check named `test`, and the queue reads only that one.

Not checked:

- **Merging a pull request.** It cannot be tried without merging one into `main`. `mergePull` is
  written and tested against GitHub's documented answers; the first real one comes with the queue's
  first landing.
- **A candidate run through to its end.** The run on the probe's candidate was cancelled once it had
  been read as started, so a candidate's `test` check concluding has not been seen.

## How a candidate is tested

A candidate is the commit the queue makes by merging a pull request's head into the tip of `main`.
It is tested by the same workflow that tests `main`: `.github/workflows/test.yml` runs on a push to
any `tc-queue/**` branch, so creating the candidate branch at that commit starts a `test` run on
it. That check, read for that exact commit, is what the queue waits for before it lands the pull
request. No pull request is opened for a candidate, so the push trigger is the only thing that
tests one.

- **Making a candidate starts one run, on the candidate.** The merge is made on a branch under
  `tc-queue-stage/`, which the workflow does not run on, and the `tc-queue/` branch is created only
  once the merge commit exists. The tip of `main` gets no run from the queue.
- **The workflow and the queue name the prefixes once.** The queue writes under the constants
  `CANDIDATE_PREFIX` and `STAGE_PREFIX` in `lib/merge-queue-github.js`.
  `test/workflow-queue-trigger.test.js` reads both and fails if the workflow's push list does not
  carry the first, or matches any name under the second.
- **Removing `tc-queue/**` from the workflow stops every landing.** A candidate would then wait for
  a check that never starts. Nothing lands on a check that was not read, so the queue stalls; it
  does not land untested work.
- **Adding `tc-queue-stage/**` to the workflow would start a second run on `main`'s tip** each time
  a candidate is made, and a reader that takes the newest `test` run on that commit would see
  `main` running again.
- **A candidate run is a push run.** The step that guards the service-worker cache compares a pull
  request with its base and runs only on pull requests, so it does not run on a candidate. It has
  already run on the pull request itself, which must be green before it is submitted.
- **The run holds no more than a pull request's run does.** The workflow's token is read-only
  (`contents: read`) on every trigger.
